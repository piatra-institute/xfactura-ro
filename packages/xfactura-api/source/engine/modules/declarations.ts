import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { hashOf } from 'xfactura-core/hash';
import type { DataClass, JsonValue, ReadSetEntry } from 'xfactura-core/kernel';
import type { Transaction } from '../db/database';
import {
  artifactEvents,
  artifacts,
  evidence,
  taxPeriodEvents,
  type artifactStates,
} from '../db/schema';
import type { DeclarationValidator } from '../adapters/declaration-validator';
import { pdfAttachments, pdfHasSignature } from '../adapters/pdf-attachments';
import { sha256, type ObjectStore } from '../adapters/object-store';
import type { ActionHandler } from '../kernel/actions';
import { appendAudit, type Actor, type Commands } from '../kernel/commands';
import { maskCnpText } from '../kernel/personal';

type State = (typeof artifactStates)[number];
export type DeclarationProblem = { code: string; message: string };

/** The returns whose files carry individuals' identifying data: the CNPs they open from their
 * seals (D112's insured, D204's members, D205's beneficiaries, D212's taxpayer, D394's and
 * D406's individuals) or a non-resident's identification (D207); D112 also each insured's pay and
 * the diagnosis codes of their medical certificates. */
const personalReturns: Record<string, DataClass[]> = {
  D112: ['payroll', 'personal'],
  D204: ['personal'],
  D205: ['personal'],
  D207: ['personal'],
  D212: ['personal'],
  D394: ['personal'],
  D406: ['personal'],
};

/** The data classes of a return's files beyond `evidence`: its XML, ANAF's PDF of it, the signed
 * copy and ANAF's answers are `tax`, and some `personal` and `payroll` too (`personalReturns`).
 * `evidence.read`, `.list` and `.get` give them only to a caller who may read every one. */
export const declarationClasses = (kind: string): DataClass[] => [
  'tax',
  ...(personalReturns[kind] ?? []),
];

/**
 * One kind of return the books produce. `prepare` reads what the return is computed from and
 * writes its XML in ANAF's format for the period; the read-set hash is what makes a prepared
 * return stale when the books change.
 */
export interface DeclarationKind {
  kind: string;
  description: string;
  /** The tax ledger an authorized return locks for its period; null for informative returns. */
  tax: string | null;
  period: z.ZodType<string>;
  /** ANAF's format for the reporting period, or null when none is pinned (a FORMAT_GAP). */
  format(period: string): string | null;
  prepare(
    tx: Transaction,
    companyId: string,
    period: string,
    options: Record<string, unknown>,
  ): Promise<{
    xml: string;
    inputs: ReadSetEntry[];
    problems: DeclarationProblem[];
    summary: JsonValue;
  }>;
  /** Reads the same inputs again, for staleness. */
  inputs(tx: Transaction, companyId: string, period: string): Promise<ReadSetEntry[]>;
  options?: z.ZodType<Record<string, unknown>>;
  /** False when ANAF publishes no validator for the period's format (D212 for the income of
   * 2025, filed only through ANAF's web form): its returns are checked by the module's own
   * controls, never reach `validated_official`, and so cannot be authorized. */
  officialValidation?(period: string): boolean;
  /**
   * What authorizing the return needs beyond ANAF's validation, each a blocking finding: the
   * annual statements' signature roles (Legea 82/1991 art. 28 alin. (10)–(13)) and the
   * accompanying documents a person must supply. `summary` is the one `prepare` returned.
   */
  authorization?(
    tx: Transaction,
    companyId: string,
    artifact: { period: string; summary: JsonValue },
  ): Promise<DeclarationProblem[]>;
}

export const prepareInput = z
  .object({
    kind: z.string().min(1).max(20),
    period: z.string().min(4).max(10),
    /** The return this one rectifies. */
    supersedesId: z.uuid().optional(),
    options: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export const artifactInput = z.object({ artifactId: z.uuid() }).strict();
export const signedInput = z.object({ artifactId: z.uuid(), evidenceId: z.uuid() }).strict();
export const submissionInput = z
  .object({
    artifactId: z.uuid(),
    /** ANAF's registration number from the receipt (recipisă). */
    registrationNumber: z.string().trim().min(1).max(60),
    submittedOn: z.iso.date(),
    receiptEvidenceId: z.uuid().optional(),
  })
  .strict();
export const outcomeInput = z
  .object({
    artifactId: z.uuid(),
    outcome: z.enum(['accepted', 'rejected']),
    /** ANAF's confirmation or error message, kept as evidence. */
    evidenceId: z.uuid(),
    detail: z.string().trim().max(4000).optional(),
  })
  .strict();
export const reopenInput = z
  .object({ artifactId: z.uuid(), reason: z.string().trim().min(10).max(1000) })
  .strict();
export const artifactView = z.object({
  id: z.string(),
  kind: z.string(),
  period: z.string(),
  format: z.string(),
  state: z.string(),
  evidenceId: z.string(),
  xmlHash: z.string(),
  supersedesId: z.string().nullable(),
  steps: z.array(
    z.object({
      state: z.string(),
      actor: z.string().nullable(),
      detail: z.string().nullable(),
      evidenceId: z.string().nullable(),
      at: z.string(),
    }),
  ),
});

async function latestStep(tx: Transaction, companyId: string, artifactId: string) {
  const [row] = await tx
    .select()
    .from(artifactEvents)
    .where(and(eq(artifactEvents.companyId, companyId), eq(artifactEvents.artifactId, artifactId)))
    .orderBy(desc(artifactEvents.seq))
    .limit(1);
  return row;
}

async function appendStep(
  tx: Transaction,
  actor: Actor,
  artifactId: string,
  step: { state: State; actor?: string; detail?: string; evidenceId?: string },
) {
  const last = await latestStep(tx, actor.companyId, artifactId);
  await tx.insert(artifactEvents).values({
    companyId: actor.companyId,
    artifactId,
    seq: (last?.seq ?? 0) + 1,
    state: step.state,
    actor: step.actor ?? null,
    detail: step.detail ?? null,
    evidenceId: step.evidenceId ?? null,
    createdBy: actor.actorId,
  });
  await appendAudit(tx, {
    companyId: actor.companyId,
    actorId: actor.actorId,
    ...(actor.agentId ? { agentId: actor.agentId } : {}),
    action: `declarations.${step.state}`,
    body: { artifactId, ...step },
  });
}

/**
 * Tax returns from the books. Each is prepared in ANAF's format for its period, checked by
 * ANAF's own validator, authorized by a person on its exact XML (which locks the tax period),
 * and exported as the PDF the company signs and files.
 */
export class Declarations {
  private readonly kinds = new Map<string, DeclarationKind>();

  constructor(
    private readonly commands: Commands,
    private readonly objects: ObjectStore,
    private readonly validator?: DeclarationValidator,
  ) {}

  add(...kinds: DeclarationKind[]) {
    for (const kind of kinds) this.kinds.set(kind.kind, kind);
  }

  private kind(kind: string) {
    const found = this.kinds.get(kind);
    requireCondition(found, 'DECLARATION_KIND', `Declarația ${kind} nu este disponibilă.`, 404);
    return found;
  }

  /** The validator that runs a kind: with ANAF's two kits, the SAF-T kit for D406 and the
   * general kit for the others. */
  private validatorFor(kind: string) {
    return this.validator?.for ? this.validator.for(kind) : this.validator;
  }

  private installedValidator(kind: string) {
    const validator = this.validatorFor(kind);
    requireCondition(
      validator,
      'VALIDATOR_UNAVAILABLE',
      `Validatorul ANAF pentru ${kind} nu este instalat.`,
      503,
    );
    return validator;
  }

  /** Prepares a return; when ANAF's validator is installed, validates it at once. */
  async prepare(actor: Actor, key: string, input: z.infer<typeof prepareInput>) {
    const kind = this.kind(input.kind);
    const period = kind.period.parse(input.period);
    const options = kind.options ? kind.options.parse(input.options) : {};
    const prepared = await this.commands.run(
      actor,
      key,
      'declarations.prepare',
      input,
      'write',
      async (tx) => {
        const format = kind.format(period);
        requireCondition(
          format,
          'FORMAT_GAP',
          `Formatul ANAF al declarației ${kind.kind} pentru ${period} nu este disponibil.`,
        );
        if (input.supersedesId) {
          const [original] = await tx
            .select()
            .from(artifacts)
            .where(
              and(eq(artifacts.companyId, actor.companyId), eq(artifacts.id, input.supersedesId)),
            );
          requireCondition(
            original?.kind === kind.kind && original.period === period,
            'RECTIFICATION',
            'O declarație rectificativă înlocuiește o declarație de același tip și pentru aceeași perioadă.',
          );
          const state = (await latestStep(tx, actor.companyId, original.id))?.state;
          requireCondition(
            [
              'prepared',
              'validation_failed',
              'validated_official',
              'authorized',
              'exported_for_signing',
              'signed_imported',
              'accepted',
              'rejected',
            ].includes(state ?? ''),
            'RECTIFICATION',
            'Declarația inițială a fost depusă și așteaptă răspunsul ANAF; înregistrați-l întâi.',
          );
        }
        const result = await kind.prepare(tx, actor.companyId, period, options);
        requireCondition(
          !result.problems.length,
          result.problems[0]?.code ?? 'DECLARATION',
          result.problems[0]?.message ?? '',
          422,
          {
            problems: result.problems,
          },
        );
        const bytes = Buffer.from(result.xml, 'utf8');
        const hash = sha256(bytes);
        const [stored] = await tx
          .select({ id: evidence.id })
          .from(evidence)
          .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.hash, hash)));
        const evidenceId = stored?.id ?? this.commands.ids();
        if (!stored) {
          await this.objects.put(actor.companyId, bytes, 64 * 1024 * 1024);
          await tx.insert(evidence).values({
            id: evidenceId,
            companyId: actor.companyId,
            hash,
            filename: `${kind.kind}-${period}.xml`,
            mediaType: 'application/xml',
            size: bytes.length,
            createdBy: actor.actorId,
            engineAt: this.commands.clock(),
          });
        }
        const id = this.commands.ids();
        await tx.insert(artifacts).values({
          id,
          companyId: actor.companyId,
          kind: kind.kind,
          period,
          tax: kind.tax,
          format,
          inputHash: hashOf(result.inputs),
          evidenceId,
          xmlHash: hash,
          supersedesId: input.supersedesId ?? null,
          createdBy: actor.actorId,
        });
        await appendStep(tx, actor, id, {
          state: 'prepared',
          detail: JSON.stringify(result.summary),
        });
        if (input.supersedesId)
          await appendStep(tx, actor, input.supersedesId, {
            state: 'superseded',
            detail: `Înlocuită de ${id}.`,
          });
        return { artifactId: id };
      },
    );
    if (this.validatorFor(kind.kind) && kind.officialValidation?.(period) !== false)
      await this.validate(actor, { artifactId: prepared.artifactId });
    return this.view(actor, prepared.artifactId);
  }

  /** Runs ANAF's validator on a prepared return's exact XML. */
  async validate(actor: Actor, input: z.infer<typeof artifactInput>) {
    const target = await this.commands.db.read(async (tx) => {
      await this.commands.authorize(tx, actor, 'write', 'declarations.validate');
      const [row] = await tx
        .select()
        .from(artifacts)
        .where(and(eq(artifacts.companyId, actor.companyId), eq(artifacts.id, input.artifactId)));
      requireCondition(row, 'NOT_FOUND', 'Declarația nu există.', 404);
      return row;
    });
    requireCondition(
      this.kind(target.kind).officialValidation?.(target.period) !== false,
      'NO_OFFICIAL_VALIDATOR',
      `ANAF nu publică un validator pentru declarația ${target.kind} pe ${target.period}: ea se depune prin formularul ANAF, după controalele structurii.`,
      422,
    );
    requireCondition(
      this.validator,
      'VALIDATOR_UNAVAILABLE',
      'Validatorul ANAF nu este instalat.',
      503,
    );
    const validator = this.installedValidator(target.kind);
    const result = await validator.validate(
      target.kind,
      await this.objects.get(actor.companyId, target.xmlHash),
    );
    await this.commands.db.write(async (tx) => {
      await this.commands.authorize(tx, actor, 'write', 'declarations.validate');
      if ((await latestStep(tx, actor.companyId, target.id))?.state !== 'prepared') return;
      await appendStep(tx, actor, target.id, {
        state: result.ok ? 'validated_official' : 'validation_failed',
        actor: validator.id,
        ...(result.ok ? {} : { detail: result.messages.join('\n').slice(0, 8000) }),
      });
    });
    return this.view(actor, target.id);
  }

  /** The PDF ANAF's tool produces from the authorized XML, to be signed and filed. */
  async exportPdf(actor: Actor, input: z.infer<typeof artifactInput>) {
    requireCondition(
      this.validator,
      'VALIDATOR_UNAVAILABLE',
      'Validatorul ANAF nu este instalat.',
      503,
    );
    const target = await this.commands.db.read(async (tx) => {
      await this.commands.authorize(tx, actor, 'write', 'declarations.pdf');
      const [row] = await tx
        .select()
        .from(artifacts)
        .where(and(eq(artifacts.companyId, actor.companyId), eq(artifacts.id, input.artifactId)));
      requireCondition(row, 'NOT_FOUND', 'Declarația nu există.', 404);
      const step = await latestStep(tx, actor.companyId, row.id);
      requireCondition(
        step?.state === 'authorized' || step?.state === 'exported_for_signing',
        'NOT_AUTHORIZED',
        'Se exportă pentru semnare numai o declarație autorizată.',
      );
      return row;
    });
    const validator = this.installedValidator(target.kind);
    const result = await validator.pdf(
      target.kind,
      await this.objects.get(actor.companyId, target.xmlHash),
    );
    requireCondition(
      result.ok && result.pdf,
      'PDF',
      // An error may be logged: ANAF's tool may quote a record, CNP included.
      maskCnpText(result.messages.join('\n'), true) || 'PDF-ul nu a putut fi produs.',
    );
    const bytes = result.pdf;
    await this.commands.db.write(async (tx) => {
      await this.commands.authorize(tx, actor, 'write', 'declarations.pdf');
      const hash = sha256(bytes);
      const [stored] = await tx
        .select({ id: evidence.id })
        .from(evidence)
        .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.hash, hash)));
      const evidenceId = stored?.id ?? this.commands.ids();
      if (!stored) {
        await this.objects.put(actor.companyId, bytes, 64 * 1024 * 1024);
        await tx.insert(evidence).values({
          id: evidenceId,
          companyId: actor.companyId,
          hash,
          filename: `${target.kind}-${target.period}.pdf`,
          mediaType: 'application/pdf',
          size: bytes.length,
          createdBy: actor.actorId,
          engineAt: this.commands.clock(),
        });
      }
      if ((await latestStep(tx, actor.companyId, target.id))?.state === 'authorized')
        await appendStep(tx, actor, target.id, {
          state: 'exported_for_signing',
          actor: validator.id,
          evidenceId,
        });
    });
    return this.view(actor, target.id);
  }

  /**
   * Authorizing a return is a reviewed action on its exact XML and on a fresh hash of what it
   * was computed from: if the books changed since preparation, the preview shows it stale and
   * execution refuses. Execution locks the return's tax period.
   */
  authorizeHandler(): ActionHandler<z.infer<typeof artifactInput>> {
    return {
      operation: 'declarations.authorize',
      permission: 'review',
      input: artifactInput,
      preview: async (tx, companyId, { artifactId }) => {
        const [row] = await tx
          .select()
          .from(artifacts)
          .where(and(eq(artifacts.companyId, companyId), eq(artifacts.id, artifactId)));
        requireCondition(row, 'NOT_FOUND', 'Declarația nu există.', 404);
        const step = await latestStep(tx, companyId, row.id);
        const kind = this.kind(row.kind);
        const current = hashOf(await kind.inputs(tx, companyId, row.period));
        const [prepared] = await tx
          .select({ detail: artifactEvents.detail })
          .from(artifactEvents)
          .where(
            and(
              eq(artifactEvents.companyId, companyId),
              eq(artifactEvents.artifactId, row.id),
              eq(artifactEvents.state, 'prepared'),
            ),
          )
          .limit(1);
        const required = kind.authorization
          ? await kind.authorization(tx, companyId, {
              period: row.period,
              summary: prepared?.detail ? (JSON.parse(prepared.detail) as JsonValue) : null,
            })
          : [];
        const findings = [
          ...(step?.state === 'validated_official'
            ? []
            : [{ code: 'NOT_VALIDATED', message: 'Declarația nu a trecut validarea ANAF.' }]),
          ...(current === row.inputHash
            ? []
            : [
                {
                  code: 'STALE',
                  message:
                    'Registrele s-au schimbat de la pregătire; pregătiți declarația din nou.',
                },
              ]),
          ...required,
        ];
        return {
          blocking: findings.length > 0,
          preview: {
            artifactId,
            kind: row.kind,
            period: row.period,
            xmlHash: row.xmlHash,
            inputHash: current,
            findings,
          },
        };
      },
      execute: async (tx, actor, { artifactId }) => {
        const [row] = await tx
          .select()
          .from(artifacts)
          .where(and(eq(artifacts.companyId, actor.companyId), eq(artifacts.id, artifactId)));
        await appendStep(tx, actor, artifactId, { state: 'authorized' });
        if (row!.tax) {
          const [last] = await tx
            .select({ seq: taxPeriodEvents.seq })
            .from(taxPeriodEvents)
            .where(
              and(
                eq(taxPeriodEvents.companyId, actor.companyId),
                eq(taxPeriodEvents.tax, row!.tax),
                eq(taxPeriodEvents.period, row!.period),
              ),
            )
            .orderBy(desc(taxPeriodEvents.seq))
            .limit(1);
          await tx.insert(taxPeriodEvents).values({
            companyId: actor.companyId,
            tax: row!.tax,
            period: row!.period,
            seq: (last?.seq ?? 0) + 1,
            kind: 'lock',
            reference: artifactId,
            createdBy: actor.actorId,
          });
        }
        return { artifactId, locked: row!.tax ? `${row!.tax} ${row!.period}` : null };
      },
    };
  }

  /**
   * The PDF the company signed: it must carry, as an attachment, exactly the XML that was
   * authorized, and a signature. The signature itself is verified by ANAF on filing.
   */
  importSigned(actor: Actor, key: string, input: z.infer<typeof signedInput>) {
    return this.commands.run(
      actor,
      key,
      'declarations.importSigned',
      input,
      'write',
      async (tx) => {
        const row = await this.artifact(tx, actor.companyId, input.artifactId);
        requireCondition(
          (await latestStep(tx, actor.companyId, row.id))?.state === 'exported_for_signing',
          'NOT_EXPORTED',
          'Se importă semnat doar PDF-ul exportat pentru semnare.',
        );
        const [file] = await tx
          .select()
          .from(evidence)
          .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, input.evidenceId)));
        requireCondition(file, 'EVIDENCE', 'Documentul justificativ nu este disponibil.', 404);
        const bytes = await this.objects.get(actor.companyId, file.hash);
        requireCondition(
          pdfAttachments(bytes).some((attachment) => sha256(attachment.bytes) === row.xmlHash),
          'SIGNED_MISMATCH',
          'PDF-ul semnat nu conține exact XML-ul autorizat al declarației.',
        );
        requireCondition(pdfHasSignature(bytes), 'NOT_SIGNED', 'PDF-ul nu poartă o semnătură.');
        await appendStep(tx, actor, row.id, {
          state: 'signed_imported',
          evidenceId: file.id,
          detail: 'XML-ul autorizat este atașat; semnătura se verifică de ANAF la depunere.',
        });
        return { artifactId: row.id };
      },
    );
  }

  /** The filing, recorded from ANAF's receipt (recipisă). */
  recordSubmission(actor: Actor, key: string, input: z.infer<typeof submissionInput>) {
    return this.commands.run(
      actor,
      key,
      'declarations.recordSubmission',
      input,
      'write',
      async (tx) => {
        const row = await this.artifact(tx, actor.companyId, input.artifactId);
        requireCondition(
          (await latestStep(tx, actor.companyId, row.id))?.state === 'signed_imported',
          'NOT_SIGNED',
          'Se depune doar declarația semnată și importată.',
        );
        await appendStep(tx, actor, row.id, {
          state: 'submitted',
          actor: input.registrationNumber,
          detail: `Depusă la ${input.submittedOn}.`,
          ...(input.receiptEvidenceId ? { evidenceId: input.receiptEvidenceId } : {}),
        });
        return { artifactId: row.id };
      },
    );
  }

  /** ANAF's answer to a filed return. */
  recordOutcome(actor: Actor, key: string, input: z.infer<typeof outcomeInput>) {
    return this.commands.run(
      actor,
      key,
      'declarations.recordOutcome',
      input,
      'write',
      async (tx) => {
        const row = await this.artifact(tx, actor.companyId, input.artifactId);
        requireCondition(
          (await latestStep(tx, actor.companyId, row.id))?.state === 'submitted',
          'NOT_SUBMITTED',
          'Răspunsul ANAF se înregistrează pentru o declarație depusă.',
        );
        await appendStep(tx, actor, row.id, {
          state: input.outcome,
          evidenceId: input.evidenceId,
          ...(input.detail ? { detail: input.detail } : {}),
        });
        return { artifactId: row.id };
      },
    );
  }

  /**
   * Reopening a filed tax period for correction is a reviewed action in the name of the return
   * that locked it; its rectification is then prepared with `supersedesId`, authorized and filed.
   */
  reopenHandler(): ActionHandler<z.infer<typeof reopenInput>> {
    const latestLock = async (tx: Transaction, companyId: string, tax: string, period: string) => {
      const [event] = await tx
        .select()
        .from(taxPeriodEvents)
        .where(
          and(
            eq(taxPeriodEvents.companyId, companyId),
            eq(taxPeriodEvents.tax, tax),
            eq(taxPeriodEvents.period, period),
          ),
        )
        .orderBy(desc(taxPeriodEvents.seq))
        .limit(1);
      return event;
    };
    return {
      operation: 'declarations.reopen',
      permission: 'review',
      input: reopenInput,
      preview: async (tx, companyId, { artifactId, reason }) => {
        const row = await this.artifact(tx, companyId, artifactId);
        const lock = row.tax ? await latestLock(tx, companyId, row.tax, row.period) : undefined;
        const findings =
          lock?.kind === 'lock'
            ? []
            : [{ code: 'NOT_LOCKED', message: 'Perioada fiscală a declarației nu este blocată.' }];
        return {
          blocking: findings.length > 0,
          preview: { artifactId, tax: row.tax, period: row.period, reason, findings },
        };
      },
      execute: async (tx, actor, { artifactId }) => {
        const row = await this.artifact(tx, actor.companyId, artifactId);
        const lock = await latestLock(tx, actor.companyId, row.tax!, row.period);
        await tx.insert(taxPeriodEvents).values({
          companyId: actor.companyId,
          tax: row.tax!,
          period: row.period,
          seq: (lock?.seq ?? 0) + 1,
          kind: 'unlock',
          reference: artifactId,
          createdBy: actor.actorId,
        });
        return { artifactId, unlocked: `${row.tax} ${row.period}` };
      },
    };
  }

  private async artifact(tx: Transaction, companyId: string, artifactId: string) {
    const [row] = await tx
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.companyId, companyId), eq(artifacts.id, artifactId)));
    requireCondition(row, 'NOT_FOUND', 'Declarația nu există.', 404);
    return row;
  }

  view(actor: Actor, artifactId: string) {
    return this.commands.read(actor, 'declarations.list', async (tx, access) => {
      const [row] = await tx
        .select()
        .from(artifacts)
        .where(and(eq(artifacts.companyId, actor.companyId), eq(artifacts.id, artifactId)));
      requireCondition(row, 'NOT_FOUND', 'Declarația nu există.', 404);
      const disclosable = await this.commands.disclosable(tx, actor, access.role);
      return this.describe(tx, row, !disclosable(declarationClasses(row.kind)));
    });
  }

  list(actor: Actor) {
    return this.commands.read(actor, 'declarations.list', async (tx, access) => {
      const rows = await tx
        .select()
        .from(artifacts)
        .where(eq(artifacts.companyId, actor.companyId))
        .orderBy(asc(artifacts.kind), asc(artifacts.period), asc(artifacts.createdAt));
      const disclosable = await this.commands.disclosable(tx, actor, access.role);
      return Promise.all(
        rows.map((row) => this.describe(tx, row, !disclosable(declarationClasses(row.kind)))),
      );
    });
  }

  /** A return with its steps. `mask`: for a caller who may not read the return's classes, the
   * steps' details carry no CNP (ANAF's validator may quote the records it refuses). */
  private async describe(tx: Transaction, row: typeof artifacts.$inferSelect, mask = false) {
    const steps = await tx
      .select()
      .from(artifactEvents)
      .where(
        and(eq(artifactEvents.companyId, row.companyId), eq(artifactEvents.artifactId, row.id)),
      )
      .orderBy(asc(artifactEvents.seq));
    return {
      id: row.id,
      kind: row.kind,
      period: row.period,
      format: row.format,
      state: steps.at(-1)!.state,
      evidenceId: row.evidenceId,
      xmlHash: row.xmlHash,
      supersedesId: row.supersedesId,
      steps: steps.map((step) => ({
        state: step.state,
        actor: step.actor,
        detail: mask && step.detail ? maskCnpText(step.detail, true) : step.detail,
        evidenceId: step.evidenceId,
        at: step.createdAt,
      })),
    };
  }
}
