import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { canonical, derivedId, hashOf } from 'xfactura-core/hash';
import type { JsonValue } from 'xfactura-core/kernel';
import { formatMoney } from 'xfactura-core/money';
import { normalizePlate, questionKinds } from 'xfactura-core/questions/kinds';
import { vehicleDeduction } from 'xfactura-core/ro/vehicles';
import {
  applyTemplate,
  conforms,
  effectAmount,
  effectFingerprint,
  mappedVehicles,
  outcomeOf,
  outcomesByMonth,
  parseMapping,
  subjectKindOf,
  templateScope,
  type MovementSubject,
  type Outcome,
  type Posted,
  type TemplateDefinition,
  type TemplateSubject,
} from 'xfactura-core/templates';
import type { Database, Transaction } from '../db/database';
import {
  bankMovements,
  documents,
  parties,
  questionAnswers,
  questions,
  templatePredictions,
  templateRevocations,
  templates,
} from '../db/schema';
import type { ActionHandler } from '../kernel/actions';
import { pausedScopes } from '../kernel/automation';
import type { Actor, Commands } from '../kernel/commands';
import { auditHead } from '../kernel/events';
import { entryStands } from '../kernel/ledger';
import type { Projector } from '../kernel/projectors';
import { basisOf, type Proposals, type TemplateRef } from '../kernel/proposals';
import { rootOf } from '../kernel/sources';
import type { StoredEffect } from '../kernel/views';
import { standing } from './questions';

/*
 * Booking templates in the books: requested as reviewed actions whose preview backtests the
 * template against what the company posted, kept append-only and versioned (`acc_templates`),
 * and measured. The worker records what each template would book for every document or movement
 * in its scope before anything is posted for it (`acc_template_predictions`); what is posted
 * decides each prediction's outcome. The pure parts are in `xfactura-core/templates`.
 */

export const templateRequestInput = z
  .object({
    /** A new version of this template; omitted, a new template. */
    templateId: z.uuid().optional(),
    name: z.string().trim().min(3).max(200),
    scope: templateScope,
    /** The part of the treatment's input the template fixes (see `xfactura-core/templates`). */
    mapping: z.record(z.string(), z.unknown()),
  })
  .strict();
export type TemplateRequest = z.infer<typeof templateRequestInput>;

export const templateView = z.object({
  id: z.string(),
  version: z.number(),
  name: z.string(),
  treatment: z.string(),
  scope: z.record(z.string(), z.unknown()),
  mapping: z.unknown(),
  requestId: z.string(),
  approvedBy: z.string(),
  createdAt: z.string(),
  revoked: z.boolean(),
  paused: z.boolean(),
});
export type TemplateView = z.infer<typeof templateView>;

const outcomeView = z.object({
  subject: z.string(),
  proposalId: z.string().nullable(),
  outcome: z.enum(['correct', 'corrected', 'rejected', 'pending']),
  reason: z.enum(['changed', 'reversed']).nullable(),
  month: z.string().nullable(),
  amount: z.string().nullable(),
});
const monthCounts = z.object({
  month: z.string().nullable(),
  correct: z.number(),
  corrected: z.number(),
  rejected: z.number(),
  pending: z.number(),
});
export const performanceView = z.object({
  template: templateView,
  versions: z.array(
    z.object({
      version: z.number(),
      months: z.array(monthCounts),
      /** Predictions the treatment refused (a missing rate, a closed month): not counted. */
      blocked: z.number(),
    }),
  ),
  /** Corrections of the latest version, newest first: what was predicted and what was posted. */
  corrections: z.array(outcomeView.extend({ predicted: z.unknown(), posted: z.unknown() })),
  outcomes: z.array(outcomeView),
});
export const agentPerformanceView = z.object({
  items: z.array(
    z.object({
      agentId: z.string(),
      months: z.array(monthCounts),
      corrections: z.array(
        z.object({
          proposalId: z.string(),
          subject: z.string(),
          reason: z.enum(['changed', 'reversed']).nullable(),
          month: z.string().nullable(),
          first: z.unknown(),
          posted: z.unknown(),
        }),
      ),
    }),
  ),
  next: z.string().nullable(),
});

type TemplateRow = typeof templates.$inferSelect;
const definitionOf = (row: TemplateRow): TemplateDefinition => ({
  scope: templateScope.parse(JSON.parse(row.scope)),
  mapping: JSON.parse(row.mapping),
});
const sign = `case l.side when 'D' then 1 else -1 end`;

/** A prediction's outcome, with the records it was read from. */
export type TrackedOutcome = Outcome & {
  subject: string;
  proposalId: string | null;
  entrySeq: number | null;
  predicted: unknown;
  posted: unknown;
  /** The answers the posting relied on. */
  answers: AnswerFact[];
  templateVersion: number;
};

export class Templates {
  constructor(
    private readonly commands: Commands,
    private readonly proposals: Proposals,
  ) {}

  // Reading templates

  /** Every version of a template, oldest first. */
  private async versions(tx: Pick<Transaction, 'select'>, companyId: string, id: string) {
    return tx
      .select()
      .from(templates)
      .where(and(eq(templates.companyId, companyId), eq(templates.id, id)))
      .orderBy(asc(templates.version));
  }

  private async revoked(tx: Pick<Transaction, 'select'>, companyId: string, id: string) {
    const [row] = await tx
      .select({ id: templateRevocations.templateId })
      .from(templateRevocations)
      .where(
        and(eq(templateRevocations.companyId, companyId), eq(templateRevocations.templateId, id)),
      );
    return !!row;
  }

  /** The template's latest version while it is not revoked. */
  async latest(tx: Pick<Transaction, 'select'>, companyId: string, id: string) {
    const rows = await this.versions(tx, companyId, id);
    if (!rows.length || (await this.revoked(tx, companyId, id))) return null;
    return rows.at(-1)!;
  }

  /** The latest version of every template that is not revoked. */
  async active(tx: Pick<Transaction, 'select'>, companyId: string) {
    const rows = await tx
      .select()
      .from(templates)
      .where(
        and(
          eq(templates.companyId, companyId),
          sql.raw(`not exists (select 1 from acc_templates t2 where t2.company_id = "acc_templates"."company_id"
            and t2.id = "acc_templates"."id" and t2.version > "acc_templates"."version")`),
          sql.raw(`not exists (select 1 from acc_template_revocations r
            where r.company_id = "acc_templates"."company_id" and r.template_id = "acc_templates"."id")`),
        ),
      )
      .orderBy(asc(templates.createdAt), asc(templates.id));
    return rows;
  }

  /** What the proposals and policies read: the current version, and conformance. */
  source() {
    return {
      current: async (
        tx: Transaction,
        companyId: string,
        id: string,
      ): Promise<TemplateRef | null> => {
        const row = await this.latest(tx, companyId, id);
        return row ? { id: row.id, version: row.version } : null;
      },
      conforms: (
        tx: Transaction,
        companyId: string,
        ref: TemplateRef,
        treatmentId: string,
        input: unknown,
      ) => this.conformsTo(tx, companyId, ref, treatmentId, input),
      answers: (tx: Transaction, companyId: string, ref: TemplateRef) =>
        this.answersOf(tx, companyId, ref),
      factsOf: async (
        tx: Transaction,
        companyId: string,
        evaluated: { readSet: { kind: string; id: string; version: string }[] },
      ) => {
        const ids = evaluated.readSet
          .filter((entry) => entry.kind === 'answer' && entry.version)
          .map((entry) => entry.version);
        return basisKey([...(await answerFacts(tx, companyId, ids)).values()]);
      },
    };
  }

  /**
   * The questions whose answers that still hold a template version relies on: for each vehicle
   * its mapping names, the answered `vehicle.use` question an agent would reuse (`questions.ask`
   * returns it). A proposal citing the template cites them too, so the person approving sees the
   * answer and a later answer makes the proposal stale.
   */
  async answersOf(tx: Transaction, companyId: string, ref: TemplateRef) {
    const row = (await this.versions(tx, companyId, ref.id)).find(
      (item) => item.version === ref.version,
    );
    if (!row) return [];
    const definition = definitionOf(row);
    const held = await this.vehicleAnswers(
      tx,
      companyId,
      mappedVehicles(definition.scope.treatment, definition.mapping),
    );
    return [...held.values()].map((item) => item.questionId);
  }

  /**
   * For each vehicle (in its one spelling), the answer about its use that still holds: the
   * question an agent would reuse, its latest answer, and the deduction that answer allows.
   */
  async vehicleAnswers(tx: Transaction, companyId: string, plates: string[]) {
    const held = new Map<string, { questionId: string; deduction: 'full' | 'limited' }>();
    const kind = questionKinds['vehicle.use'];
    for (const plate of plates) {
      const found = await standing(tx, companyId, {
        kind: kind.id,
        subject: { kind: 'vehicle', id: plate },
        params: {},
      });
      const value = found.answered?.answer
        ? kind.answer({}).safeParse(JSON.parse(found.answered.answer.value))
        : null;
      if (value?.success)
        held.set(plate, {
          questionId: found.answered!.row.id,
          deduction: vehicleDeduction(value.data),
        });
    }
    return held;
  }

  /** The deductions the answers with these ids allow, by the vehicle each is about (in its one
   * spelling): what a posted version read. */
  private async citedVehicles(tx: Transaction, companyId: string, answerIds: string[]) {
    const cited: Record<string, 'full' | 'limited'> = {};
    if (!answerIds.length) return cited;
    const kind = questionKinds['vehicle.use'];
    for (const row of await tx
      .select({ value: questionAnswers.value, subject: questions.subjectId })
      .from(questionAnswers)
      .innerJoin(
        questions,
        and(
          eq(questions.companyId, questionAnswers.companyId),
          eq(questions.id, questionAnswers.questionId),
        ),
      )
      .where(
        and(
          eq(questionAnswers.companyId, companyId),
          inArray(questionAnswers.id, answerIds),
          eq(questions.kind, kind.id),
        ),
      )) {
      const value = kind.answer({}).safeParse(JSON.parse(row.value));
      if (value.success) cited[normalizePlate(row.subject)] = vehicleDeduction(value.data);
    }
    return cited;
  }

  /**
   * Whether an input is exactly what the template version makes of the document or movement it
   * names: the version must be the template's current one, not revoked, of the same treatment.
   */
  async conformsTo(
    tx: Transaction,
    companyId: string,
    ref: TemplateRef,
    treatmentId: string,
    input: unknown,
  ) {
    const row = await this.latest(tx, companyId, ref.id);
    if (!row || row.version !== ref.version || row.treatmentId !== treatmentId) return false;
    const definition = definitionOf(row);
    const subject = await this.subjectOfInput(tx, companyId, definition, input);
    return !!subject && conforms(definition, input, subject);
  }

  private async subjectOfInput(
    tx: Transaction,
    companyId: string,
    definition: TemplateDefinition,
    input: unknown,
  ) {
    const named = (field: string) =>
      typeof input === 'object' && input !== null && field in input
        ? (input as Record<string, unknown>)[field]
        : undefined;
    if (subjectKindOf(definition.scope.treatment) === 'document') {
      const id = named('documentId');
      return typeof id === 'string' ? this.documentSubject(tx, companyId, id, definition) : null;
    }
    const id = named('movementId');
    return typeof id === 'string' ? this.movementSubject(tx, companyId, definition, id) : null;
  }

  // Subjects

  /**
   * A document as a template reads it. For a mapping that names vehicles, with the deduction the
   * answer that holds about each allows (`vehicles`), unless `cited` gives the answers a posted
   * version read (a backtest).
   */
  async documentSubject(
    tx: Transaction,
    companyId: string,
    id: string,
    definition?: TemplateDefinition,
    cited?: Record<string, 'full' | 'limited'>,
  ): Promise<TemplateSubject | null> {
    const [row] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.companyId, companyId), eq(documents.id, id)));
    if (!row) return null;
    const plates = definition ? mappedVehicles(definition.scope.treatment, definition.mapping) : [];
    const vehicles = cited
      ? cited
      : Object.fromEntries(
          [...(await this.vehicleAnswers(tx, companyId, plates))].map(([plate, held]) => [
            plate,
            held.deduction,
          ]),
        );
    return {
      kind: 'document',
      document: {
        id: row.id,
        kind: row.kind,
        partyId: row.partyId,
        evidenceId: row.evidenceId,
        body: JSON.parse(row.body),
      },
      ...(plates.length ? { vehicles } : {}),
    };
  }

  /**
   * A movement with the open items it might settle: of the kind its direction settles, in its
   * currency, with something outstanding, the scope's partner's only when it names one. With
   * `before`, as the items stood before the entry of that sequence (a backtest).
   */
  async movementSubject(
    tx: Transaction,
    companyId: string,
    definition: TemplateDefinition,
    id: string,
    before?: number,
  ): Promise<MovementSubject | null> {
    const [movement] = await tx
      .select()
      .from(bankMovements)
      .where(and(eq(bankMovements.companyId, companyId), eq(bankMovements.id, id)));
    if (!movement) return null;
    const kind = movement.amountMinor < 0n ? 'payable' : 'receivable';
    const party = definition.scope.partyId;
    const rows = await tx.all<{
      id: string;
      kind: string;
      party_id: string;
      currency: string;
      normal_side: string;
      number: string | null;
      minor: number | bigint;
    }>(sql`
      select o.id, o.kind, o.party_id, o.currency, o.normal_side, d.number,
        coalesce(sum(case when l.entry_id is null then 0 else ${sql.raw(sign)} * coalesce(l.currency_minor, l.bani) end), 0) as minor
      from acc_open_items o
      join acc_entries oe on oe.company_id = o.company_id and oe.id = o.origin_entry_id
      left join acc_documents d on d.company_id = o.company_id and d.id = o.document_id
      left join acc_lines l on l.company_id = o.company_id and l.open_item_id = o.id
        ${before === undefined ? sql`` : sql`and l.entry_id in (select e.id from acc_entries e where e.company_id = o.company_id and e.seq < ${before})`}
      where o.company_id = ${companyId} and o.kind = ${kind} and o.currency = ${movement.currency}
        ${party ? sql`and o.party_id = ${party}` : sql``}
        ${before === undefined ? sql`` : sql`and oe.seq < ${before}`}
      group by o.id`);
    return {
      kind: 'movement',
      movement: {
        id: movement.id,
        amountMinor: movement.amountMinor,
        currency: movement.currency,
        text: [movement.reference, movement.counterparty ?? ''].join(' '),
      },
      openItems: rows
        .map((row) => {
          const minor = BigInt(row.minor);
          return {
            id: row.id,
            kind: row.kind,
            partyId: row.party_id,
            currency: row.currency,
            outstandingMinor: row.normal_side === 'D' ? minor : -minor,
            documentNumber: row.number,
          };
        })
        .filter((item) => item.outstandingMinor > 0n),
    };
  }

  // Requests and their backtest

  /**
   * What the template would have made of the company's posted bookings of its treatment and
   * scope that stand (reversed ones aside), the latest 200: the same input as posted
   * (`matching`), another (`differing`, with examples), or none (`notApplicable`: no single open
   * item, a document it cannot read).
   */
  async backtest(tx: Transaction, companyId: string, definition: TemplateDefinition) {
    const { scope } = definition;
    const movement = subjectKindOf(scope.treatment) === 'movement';
    const rows = await tx.all<{
      proposal_id: string;
      subject_key: string;
      document_id: string | null;
      seq: number | bigint;
      date: string;
      input_json: string;
      read_set_json: string;
    }>(sql`
      select q.id as proposal_id, q.subject_key, q.document_id, e.seq, e.date, v.input_json,
        v.read_set_json
      from acc_proposals q
      join acc_entries e on e.company_id = q.company_id and e.proposal_id = q.id
      join acc_proposal_versions v on v.company_id = q.company_id and v.proposal_id = q.id and v.version = e.version
      ${movement ? sql`` : sql`join acc_documents d on d.company_id = q.company_id and d.id = q.document_id`}
      where q.company_id = ${companyId} and q.treatment_id = ${scope.treatment} and ${entryStands('e')}
        ${movement ? sql`` : sql`and d.kind = ${scope.documentKind}`}
        ${!movement && scope.partyId ? sql`and d.party_id = ${scope.partyId}` : sql``}
      order by e.seq desc limit 200`);
    let matching = 0;
    let differing = 0;
    let notApplicable = 0;
    const examples: JsonValue[] = [];
    for (const row of rows) {
      const subject = movement
        ? await this.movementSubject(
            tx,
            companyId,
            definition,
            row.subject_key.slice('movement:'.length),
            Number(row.seq),
          )
        : row.document_id
          ? await this.documentSubject(
              tx,
              companyId,
              row.document_id,
              definition,
              // The answers the posting read, as it read them.
              await this.citedVehicles(tx, companyId, answerVersions(row.read_set_json)),
            )
          : null;
      if (!subject) continue;
      const applied = applyTemplate(definition, subject);
      if (!applied.ok) {
        // Outside the scope (another direction, other words) is not the template's to judge.
        if (applied.reason !== 'scope') notApplicable++;
        continue;
      }
      if (canonical(applied.input) === row.input_json) matching++;
      else {
        differing++;
        if (examples.length < 10)
          examples.push({
            proposalId: row.proposal_id,
            subject: row.subject_key,
            date: row.date,
            posted: JSON.parse(row.input_json) as JsonValue,
            template: applied.input as JsonValue,
          });
      }
    }
    return {
      posted: matching + differing + notApplicable,
      matching,
      differing,
      notApplicable,
      examples,
    };
  }

  /** The reviewed request of a template or a new version of one. */
  requestHandler(): ActionHandler<TemplateRequest> {
    return {
      // Its kind is the operation that requests it.
      operation: 'templates.request',
      request: 'templates.request',
      permission: 'write',
      input: templateRequestInput,
      preview: async (tx, companyId, input) => {
        const mapping = parseMapping(input.scope.treatment, input.mapping);
        const scope = templateScope.parse(input.scope);
        if (scope.partyId) {
          const [party] = await tx
            .select({ id: parties.id })
            .from(parties)
            .where(and(eq(parties.companyId, companyId), eq(parties.id, scope.partyId)));
          requireCondition(party, 'NOT_FOUND', 'Partenerul nu este disponibil.', 404);
        }
        let id = derivedId('template', companyId, hashOf({ name: input.name, scope, mapping }));
        if (input.templateId) {
          const current = await this.latest(tx, companyId, input.templateId);
          requireCondition(current, 'TEMPLATE_NOT_FOUND', 'Șablonul nu este disponibil.', 404);
          requireCondition(
            current.treatmentId === scope.treatment,
            'TEMPLATE_TREATMENT',
            'O versiune nouă păstrează tratamentul șablonului.',
            422,
          );
          id = input.templateId;
        }
        const known = await this.versions(tx, companyId, id);
        const definition = { scope, mapping };
        const backtest = await this.backtest(tx, companyId, definition);
        const findings = [
          ...(backtest.differing
            ? [
                {
                  code: 'BACKTEST_DIFFERS',
                  severity: 'warn',
                  message: `Șablonul ar fi înregistrat altfel ${backtest.differing} din ${backtest.posted} documente contabilizate: verificați exemplele.`,
                },
              ]
            : []),
          ...(!backtest.matching
            ? [
                {
                  code: 'BACKTEST_EMPTY',
                  severity: 'warn',
                  message: 'Nicio înregistrare contabilizată nu confirmă șablonul.',
                },
              ]
            : []),
        ];
        const preview = {
          template: {
            id,
            version: (known.at(-1)?.version ?? 0) + 1,
            name: input.name,
            treatment: scope.treatment,
            scope,
            mapping,
          },
          backtest,
          findings,
        };
        return { blocking: false, preview: JSON.parse(canonical(preview)) as JsonValue };
      },
      execute: async (tx, actor, _input, requestId, preview, { decision }) => {
        const { template } = preview as {
          template: {
            id: string;
            version: number;
            name: string;
            treatment: string;
            scope: { partyId?: string; documentKind: string };
            mapping: unknown;
          };
        };
        await tx.insert(templates).values({
          id: template.id,
          companyId: actor.companyId,
          version: template.version,
          name: template.name,
          treatmentId: template.treatment,
          partyId: template.scope.partyId ?? null,
          documentKind: template.scope.documentKind,
          scope: canonical(template.scope),
          mapping: canonical(template.mapping),
          requestId,
          approvedBy: decision.decidedBy,
          approverEpoch: decision.decidedEpoch,
          createdBy: actor.actorId,
          agentId: actor.agentId ?? null,
        });
        return { templateId: template.id, version: template.version };
      },
    };
  }

  /** A person ends a template, in every version; policies bound to it stop posting. */
  revoke(actor: Actor, key: string, input: { templateId: string; reason: string }) {
    requireCondition(!actor.agentId, 'AGENT_SCOPE', 'Revocarea aparține unei persoane.', 403);
    return this.commands.run(actor, key, 'templates.revoke', input, 'review', async (tx) => {
      const rows = await this.versions(tx, actor.companyId, input.templateId);
      requireCondition(rows.length, 'TEMPLATE_NOT_FOUND', 'Șablonul nu este disponibil.', 404);
      if (!(await this.revoked(tx, actor.companyId, input.templateId)))
        await tx.insert(templateRevocations).values({
          companyId: actor.companyId,
          templateId: input.templateId,
          reason: input.reason,
          createdBy: actor.actorId,
        });
      return { templateId: input.templateId, revoked: true as const };
    });
  }

  private async views(tx: Pick<Transaction, 'select'>, companyId: string, rows: TemplateRow[]) {
    const paused = await pausedScopes(tx, companyId);
    const revoked = new Set(
      (
        await tx
          .select({ id: templateRevocations.templateId })
          .from(templateRevocations)
          .where(eq(templateRevocations.companyId, companyId))
      ).map((row) => row.id),
    );
    return rows.map((row): TemplateView => ({
      id: row.id,
      version: row.version,
      name: row.name,
      treatment: row.treatmentId,
      scope: JSON.parse(row.scope) as Record<string, unknown>,
      mapping: JSON.parse(row.mapping) as unknown,
      requestId: row.requestId,
      approvedBy: row.approvedBy,
      createdAt: row.createdAt,
      revoked: revoked.has(row.id),
      paused: paused.company || paused.templates.has(row.id),
    }));
  }

  /** Every template at its latest version, revoked ones included. */
  list(actor: Actor) {
    return this.commands.read(actor, 'templates.list', async (tx) => {
      const rows = await tx
        .select()
        .from(templates)
        .where(
          and(
            eq(templates.companyId, actor.companyId),
            sql.raw(`not exists (select 1 from acc_templates t2 where t2.company_id = "acc_templates"."company_id"
              and t2.id = "acc_templates"."id" and t2.version > "acc_templates"."version")`),
          ),
        )
        .orderBy(asc(templates.createdAt), asc(templates.id));
      return { items: await this.views(tx, actor.companyId, rows), next: null };
    });
  }

  // Predictions

  /**
   * Records what each active template would book for the documents or movements in its scope
   * that have no prediction of its current version and nothing posted yet, at most `budget` per
   * template; returns whether none is left.
   */
  async predict(db: Database, companyId: string, budget = 100) {
    const active = await db.read((tx) => this.active(tx, companyId));
    let done = true;
    for (const row of active) {
      const definition = definitionOf(row);
      const sources = await db.read((tx) => this.unpredicted(tx, companyId, row, budget + 1));
      if (sources.length > budget) done = false;
      for (const source of sources.slice(0, budget)) {
        const prediction = await db.read((tx) =>
          this.prediction(tx, companyId, row, definition, source),
        );
        await db.write((tx) =>
          tx
            .insert(templatePredictions)
            .values({
              companyId,
              templateId: row.id,
              templateVersion: row.version,
              sourceKey: source,
              ...prediction,
            })
            .onConflictDoNothing(),
        );
      }
    }
    return done;
  }

  /** The documents or movements of a template's scope it has not predicted, nothing posted for
   * them: `document:<id>` (a group's root, not superseded) or `movement:<id>`. */
  private async unpredicted(tx: Transaction, companyId: string, row: TemplateRow, limit: number) {
    const scope = templateScope.parse(JSON.parse(row.scope));
    const noPrediction = (
      source: string,
    ) => sql`not exists (select 1 from acc_template_predictions p
      where p.company_id = ${companyId} and p.template_id = ${row.id} and p.template_version = ${row.version}
        and p.source_key = ${sql.raw(source)})`;
    const notPosted = (subject: string) => sql`not exists (select 1 from acc_proposals q
      join acc_entries e on e.company_id = q.company_id and e.proposal_id = q.id
      where q.company_id = ${companyId} and q.subject_key = ${sql.raw(subject)})`;
    if (subjectKindOf(scope.treatment) === 'movement') {
      const rows = await tx.all<{ id: string }>(sql`
        select m.id from acc_bank_movements m
        where m.company_id = ${companyId}
          and ${sql.raw(scope.documentKind === 'movement.paid' ? 'm.amount_minor < 0' : 'm.amount_minor > 0')}
          and ${noPrediction(`'movement:' || m.id`)} and ${notPosted(`'movement:' || m.id`)}
        order by m.id limit ${limit}`);
      return rows.map((item) => `movement:${item.id}`);
    }
    const rows = await tx.all<{ id: string }>(sql`
      select d.id from acc_documents d
      where d.company_id = ${companyId} and d.kind = ${scope.documentKind}
        ${scope.partyId ? sql`and d.party_id = ${scope.partyId}` : sql``}
        and not exists (select 1 from acc_document_links l where l.company_id = d.company_id
          and l.from_id = d.id and l.kind in ('same_as', 'same_as_confirmed'))
        and not exists (select 1 from acc_document_links l where l.company_id = d.company_id
          and l.to_id = d.id and l.kind = 'supersedes')
        and ${noPrediction(`'document:' || d.id`)}
        ${scope.treatment === 'invoices.recognize' ? sql`and ${notPosted(`'document:' || d.id`)}` : sql``}
      order by d.created_at, d.id limit ${limit}`);
    return rows.map((item) => `document:${item.id}`);
  }

  /** What the template makes of one document or movement, evaluated as a proposal would be. */
  private async prediction(
    tx: Transaction,
    companyId: string,
    row: TemplateRow,
    definition: TemplateDefinition,
    source: string,
  ) {
    const asOfSeq = await auditHead(tx, companyId);
    const [kind, id] = source.split(':') as ['document' | 'movement', string];
    const subject =
      kind === 'document'
        ? await this.documentSubject(tx, companyId, id, definition)
        : await this.movementSubject(tx, companyId, definition, id);
    const applied = subject ? applyTemplate(definition, subject) : null;
    if (!applied?.ok)
      return {
        status: 'not_applicable' as const,
        subjectKey: null,
        input: null,
        fingerprint: null,
        asOfSeq,
      };
    const treatment = this.proposals.treatment(row.treatmentId);
    const declared = treatment.subject(applied.input);
    const subjectKey = declared.startsWith('document:')
      ? `document:${await rootOf(tx, companyId, declared.slice('document:'.length))}`
      : declared;
    // A prediction is made before anything is posted for its subject, or not at all.
    if ((await postedFor(tx, companyId, [subjectKey])).has(subjectKey))
      return {
        status: 'not_applicable' as const,
        subjectKey: null,
        input: null,
        fingerprint: null,
        asOfSeq,
      };
    // Evaluated as a proposal citing the template would be: on the answers that hold about the
    // vehicles its mapping names, which such a proposal cites.
    const evaluated = await this.proposals.evaluate(
      tx,
      companyId,
      derivedId('prediction', row.id, String(row.version), source),
      treatment,
      applied.input,
      basisOf({ answers: await this.answersOf(tx, companyId, row) }),
    );
    return {
      status:
        evaluated.effect && !evaluated.blocking ? ('predicted' as const) : ('blocked' as const),
      subjectKey,
      input: canonical(applied.input),
      fingerprint:
        evaluated.effect && !evaluated.blocking ? effectFingerprint(evaluated.effect) : null,
      asOfSeq,
    };
  }

  // Outcomes

  /**
   * The outcome of each prediction of a template (or of one version), in posting order, pending
   * and rejected ones last: what was posted for its subject decides, and a reversal posted
   * since makes it a correction.
   */
  async outcomes(
    tx: Transaction,
    companyId: string,
    templateId: string,
    version?: number,
  ): Promise<{ outcomes: TrackedOutcome[]; blocked: Map<number, number> }> {
    const predictions = await tx
      .select()
      .from(templatePredictions)
      .where(
        and(
          eq(templatePredictions.companyId, companyId),
          eq(templatePredictions.templateId, templateId),
          version === undefined ? undefined : eq(templatePredictions.templateVersion, version),
        ),
      )
      .orderBy(asc(templatePredictions.createdAt), asc(templatePredictions.sourceKey));
    const blocked = new Map<number, number>();
    for (const row of predictions)
      if (row.status === 'blocked')
        blocked.set(row.templateVersion, (blocked.get(row.templateVersion) ?? 0) + 1);
    const predicted = predictions.filter((row) => row.status === 'predicted');
    const subjects = [...new Set(predicted.map((row) => row.subjectKey!))];
    const posted = await postedFor(tx, companyId, subjects);
    const withdrawn = await withdrawnOnly(tx, companyId, subjects);
    const outcomes = predicted.map((row): TrackedOutcome => {
      const found = posted.get(row.subjectKey!);
      return {
        ...outcomeOf(row.fingerprint, found?.posted ?? null, withdrawn.has(row.subjectKey!)),
        subject: row.subjectKey!,
        proposalId: found?.proposalId ?? withdrawn.get(row.subjectKey!) ?? null,
        entrySeq: found?.seq ?? null,
        predicted: row.input ? (JSON.parse(row.input) as unknown) : null,
        posted: found?.input ?? null,
        answers: found?.answers ?? [],
        templateVersion: row.templateVersion,
      };
    });
    outcomes.sort((a, b) =>
      a.entrySeq === b.entrySeq
        ? 0
        : a.entrySeq === null
          ? 1
          : b.entrySeq === null
            ? -1
            : a.entrySeq - b.entrySeq,
    );
    return { outcomes, blocked };
  }

  /** The templates whose predictions for these subjects came out corrected by what these
   * proposals posted (each prediction is decided by its subject's first posting). */
  async correctedBy(tx: Transaction, companyId: string, subjects: string[], proposalIds: string[]) {
    if (!subjects.length) return [];
    const rows = await tx
      .select()
      .from(templatePredictions)
      .where(
        and(
          eq(templatePredictions.companyId, companyId),
          inArray(templatePredictions.subjectKey, subjects),
          eq(templatePredictions.status, 'predicted'),
        ),
      );
    const posted = await postedFor(tx, companyId, subjects);
    return rows.flatMap((row) => {
      const found = posted.get(row.subjectKey!);
      if (!found || !proposalIds.includes(found.proposalId)) return [];
      const outcome = outcomeOf(row.fingerprint, found.posted, false);
      return outcome.outcome === 'corrected'
        ? [
            {
              templateId: row.templateId,
              subject: row.subjectKey!,
              reason: outcome.reason,
              proposalId: found.proposalId,
            },
          ]
        : [];
    });
  }

  /** A template's track record per version and month, with the corrections of its latest. */
  performance(actor: Actor, input: { templateId: string }) {
    return this.commands.read(actor, 'templates.performance', async (tx) => {
      const rows = await this.versions(tx, actor.companyId, input.templateId);
      requireCondition(rows.length, 'TEMPLATE_NOT_FOUND', 'Șablonul nu este disponibil.', 404);
      const [view] = await this.views(tx, actor.companyId, [rows.at(-1)!]);
      const { outcomes, blocked } = await this.outcomes(tx, actor.companyId, input.templateId);
      const shown = (item: TrackedOutcome) => ({
        subject: item.subject,
        proposalId: item.proposalId,
        outcome: item.outcome,
        reason: item.reason,
        month: item.month,
        amount: item.amount === null ? null : formatMoney(item.amount, 'RON'),
      });
      return {
        template: view!,
        versions: rows.map((row) => ({
          version: row.version,
          months: outcomesByMonth(outcomes.filter((item) => item.templateVersion === row.version)),
          blocked: blocked.get(row.version) ?? 0,
        })),
        corrections: outcomes
          .filter(
            (item) => item.outcome === 'corrected' && item.templateVersion === rows.at(-1)!.version,
          )
          .reverse()
          .slice(0, 20)
          .map((item) => ({ ...shown(item), predicted: item.predicted, posted: item.posted })),
        outcomes: outcomes.map(shown),
      };
    });
  }

  /**
   * Agents measured as templates are: each proposal an agent created, its first version compared
   * with what was posted for it (`correct` when it books the same and stands), per grant and
   * month, with the corrections.
   */
  agentPerformance(actor: Actor, input: { agentId?: string | undefined }) {
    return this.commands.read(actor, 'agents.performance', async (tx) => {
      const rows = await tx.all<{
        agent_id: string;
        proposal_id: string;
        subject_key: string;
        first: string | null;
        first_input: string;
        withdrawn: number | bigint;
      }>(sql`
        select v.agent_id, v.proposal_id, q.subject_key, v.fingerprint as first, v.input_json as first_input,
          exists (select 1 from acc_withdrawals w where w.company_id = q.company_id and w.proposal_id = q.id) as withdrawn
        from acc_proposal_versions v
        join acc_proposals q on q.company_id = v.company_id and q.id = v.proposal_id
        where v.company_id = ${actor.companyId} and v.version = 1 and v.agent_id is not null
          and v.fingerprint is not null
          ${input.agentId ? sql`and v.agent_id = ${input.agentId}` : sql``}
        order by v.created_at, v.proposal_id`);
      // By proposal: a subject booked again after a reversal has a posting per proposal.
      const posted = new Map(
        (
          await postingsOf(
            tx,
            actor.companyId,
            [...new Set(rows.map((row) => row.subject_key))],
            rows.map((row) => row.proposal_id),
          )
        ).map((posting) => [posting.proposalId, posting]),
      );
      const byAgent = new Map<
        string,
        { outcome: Outcome; row: (typeof rows)[number]; postedInput: unknown }[]
      >();
      for (const row of rows) {
        const found = posted.get(row.proposal_id);
        const outcome = outcomeOf(row.first, found?.posted ?? null, Number(row.withdrawn) > 0);
        byAgent.set(row.agent_id, [
          ...(byAgent.get(row.agent_id) ?? []),
          { outcome, row, postedInput: found?.input ?? null },
        ]);
      }
      return {
        items: [...byAgent.entries()].map(([agentId, items]) => ({
          agentId,
          months: outcomesByMonth(items.map((item) => item.outcome)),
          corrections: items
            .filter((item) => item.outcome.outcome === 'corrected')
            .slice(-20)
            .reverse()
            .map((item) => ({
              proposalId: item.row.proposal_id,
              subject: item.row.subject_key,
              reason: item.outcome.reason,
              month: item.outcome.month,
              first: JSON.parse(item.row.first_input) as unknown,
              posted: item.postedInput,
            })),
        })),
        next: null,
      };
    });
  }
}

/** A posting of a subject as the track record reads it. */
export type Posting = {
  proposalId: string;
  subject: string;
  seq: number;
  input: unknown;
  /** What people stated that it relied on (its basis's answers). */
  answers: AnswerFact[];
  posted: Posted;
};

/**
 * What was first posted for each subject: the proposal, its posted version's fingerprint, rules
 * and input, the entry's month, sequence and amount, and whether a reversal of it was posted. A
 * subject posted, reversed and posted again keeps its first posting here: a prediction is made
 * only before anything is posted for its subject (`inv:prediction_posted`), so the first posting
 * is the one it predicted. With `only`, just those proposals.
 */
export async function postedFor(
  tx: Transaction,
  companyId: string,
  subjects: string[],
  only?: string[],
) {
  const found = new Map<string, Posting>();
  for (const posting of await postingsOf(tx, companyId, subjects, only))
    if ((found.get(posting.subject)?.seq ?? Infinity) > posting.seq)
      found.set(posting.subject, posting);
  return found;
}

/** Every posting of these subjects (with `only`, of these proposals), in no order. */
async function postingsOf(tx: Transaction, companyId: string, subjects: string[], only?: string[]) {
  const found: Posting[] = [];
  const list = (values: string[]) =>
    sql.join(
      values.map((value) => sql`${value}`),
      sql`, `,
    );
  for (let start = 0; start < subjects.length; start += 400) {
    const chunk = subjects.slice(start, start + 400);
    const rows = await tx.all<{
      proposal_id: string;
      subject_key: string;
      seq: number | bigint;
      period: string;
      fingerprint: string | null;
      rules_hash: string;
      input_json: string;
      effect_json: string | null;
      read_set_json: string;
      reversed: number | bigint;
    }>(sql`
      select q.id as proposal_id, q.subject_key, e.seq, e.period, v.fingerprint, v.rules_hash,
        v.input_json, v.effect_json, v.read_set_json,
        exists (select 1 from acc_proposals r join acc_entries re
          on re.company_id = r.company_id and re.proposal_id = r.id
          where r.company_id = e.company_id and r.subject_key = 'reverse:' || e.id) as reversed
      from acc_proposals q
      join acc_entries e on e.company_id = q.company_id and e.proposal_id = q.id
      join acc_proposal_versions v on v.company_id = q.company_id and v.proposal_id = q.id
        and v.version = e.version
      where q.company_id = ${companyId} and q.subject_key in (${list(chunk)})
        ${only?.length ? sql`and q.id in (${list(only)})` : sql``}`);
    const answers = await answerFacts(
      tx,
      companyId,
      rows.flatMap((row) => answerVersions(row.read_set_json)),
    );
    for (const row of rows) {
      const cited = answerVersions(row.read_set_json).flatMap((id) => {
        const fact = answers.get(id);
        return fact ? [fact] : [];
      });
      found.push({
        proposalId: row.proposal_id,
        subject: row.subject_key,
        seq: Number(row.seq),
        input: JSON.parse(row.input_json) as unknown,
        answers: cited,
        posted: {
          fingerprint: row.fingerprint,
          reversed: Number(row.reversed) > 0,
          month: row.period,
          rulesHash: row.rules_hash,
          basis: basisKey(cited),
          amount: row.effect_json ? effectAmount(JSON.parse(row.effect_json) as StoredEffect) : 0n,
        },
      });
    }
  }
  return found;
}

/** A fact a person stated that a posting relied on: a question and the value of the answer its
 * basis cited (`valueHash`, a hash of that value), what a graduation's policy binds to. */
export type AnswerFact = {
  questionId: string;
  kind: string;
  subject: { kind: string; id: string };
  value: unknown;
  valueHash: string;
};

/** The answer ids (read-set versions) a version's basis cited. */
export const answerVersions = (readSet: string) =>
  (JSON.parse(readSet) as { kind: string; version: string }[])
    .filter((entry) => entry.kind === 'answer' && entry.version)
    .map((entry) => entry.version);

/** The facts the answers with these ids state. */
async function answerFacts(tx: Transaction, companyId: string, answerIds: string[]) {
  const found = new Map<string, AnswerFact>();
  const ids = [...new Set(answerIds)];
  for (let start = 0; start < ids.length; start += 400)
    for (const row of await tx
      .select({
        id: questionAnswers.id,
        questionId: questionAnswers.questionId,
        value: questionAnswers.value,
        kind: questions.kind,
        subjectKind: questions.subjectKind,
        subjectId: questions.subjectId,
      })
      .from(questionAnswers)
      .innerJoin(
        questions,
        and(
          eq(questions.companyId, questionAnswers.companyId),
          eq(questions.id, questionAnswers.questionId),
        ),
      )
      .where(
        and(
          eq(questionAnswers.companyId, companyId),
          inArray(questionAnswers.id, ids.slice(start, start + 400)),
        ),
      )) {
      const value = JSON.parse(row.value) as unknown;
      found.set(row.id, {
        questionId: row.questionId,
        kind: row.kind,
        subject: { kind: row.subjectKind, id: row.subjectId },
        value,
        valueHash: hashOf(value),
      });
    }
  return found;
}

/** The key of the facts a posting relied on: each question with its answer's value, `''` for
 * none. Two postings on the same answers (or a repeated answer of the same value) share it. */
export const basisKey = (facts: readonly Pick<AnswerFact, 'questionId' | 'valueHash'>[]) =>
  facts.length
    ? canonical(
        facts
          .map((fact) => ({ questionId: fact.questionId, valueHash: fact.valueHash }))
          .sort((a, b) => (a.questionId < b.questionId ? -1 : 1)),
      )
    : '';

/** Subjects whose proposals were all withdrawn and nothing posted: the last withdrawn one. */
async function withdrawnOnly(tx: Transaction, companyId: string, subjects: string[]) {
  const found = new Map<string, string>();
  for (let start = 0; start < subjects.length; start += 400) {
    const chunk = subjects.slice(start, start + 400);
    const rows = await tx.all<{ id: string; subject_key: string }>(sql`
      select q.id, q.subject_key from acc_proposals q
      where q.company_id = ${companyId} and q.subject_key in (${sql.join(
        chunk.map((subject) => sql`${subject}`),
        sql`, `,
      )})
        and exists (select 1 from acc_withdrawals w where w.company_id = q.company_id and w.proposal_id = q.id)
        and not exists (select 1 from acc_proposals o where o.company_id = q.company_id
          and o.subject_key = q.subject_key
          and not exists (select 1 from acc_withdrawals w where w.company_id = o.company_id and w.proposal_id = o.id))
      order by q.created_at`);
    for (const row of rows) found.set(row.subject_key, row.id);
  }
  return found;
}

/** The worker's projector that records templates' predictions as documents and movements
 * arrive (and when a template or a new version of one is created). */
export function predictionProjector(db: Database, source: Templates, budget = 100): Projector {
  return {
    name: 'templates.predictions',
    project: (companyId) => source.predict(db, companyId, budget),
  };
}
