import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { DomainError, requireCondition } from 'xfactura-core/errors';
import { canonical } from 'xfactura-core/hash';
import { invoiceKinds } from 'xfactura-core/ro/treatments/invoices';
import { addDays, bucharestDate, monthEnd, type LocalDate, type Month } from 'xfactura-core/time';
import { parseInvoiceXml, type InvoiceDocument } from 'xfactura-core/ubl/invoice-document';
import type { Transaction } from '../db/database';
import {
  companies,
  documents,
  evidence,
  spvMessages,
  spvSyncWindows,
  submissionEvents,
  submissions,
  type submissionStates,
} from '../db/schema';
import { parseInvoiceArchive, type ParsedArchiveMember } from '../adapters/archive';
import { EFacturaUnavailable, type EFacturaPort, type SpvMessage } from '../adapters/efactura';
import { sha256, type ObjectStore } from '../adapters/object-store';
import { appendAudit, type Actor, type Commands } from '../kernel/commands';
import type { CloseCheck } from '../kernel/periods';
import { maskCnpText } from '../kernel/personal';
import { recordInvoice } from './invoices';

type State = (typeof submissionStates)[number];
type Step = { state: State; uploadId?: string; downloadId?: string; detail?: string };

/** A `submitting` step with no outcome after this long belongs to an attempt that died. */
export const STALE_SUBMITTING_MS = 10 * 60_000;
/**
 * How long after an upload its message must appear before a fully synced inbox shows it was
 * never received. TO-SOURCE: ANAF's processing horizon; three days is a deliberate margin.
 */
export const ABSENCE_HORIZON_MS = 3 * 86_400_000;
const MAX_WINDOW_MS = 60 * 86_400_000;

export const submitInput = z.object({ documentId: z.uuid() }).strict();
export const submissionInput = z.object({ submissionId: z.uuid() }).strict();
export const archiveInput = z.object({ evidenceId: z.uuid() }).strict();
export const archiveView = z.object({
  messageId: z.string(),
  kind: z.string(),
  outcome: z.string(),
  documentId: z.string().nullable(),
  detail: z.string().nullable(),
});
export const syncInput = z
  .object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) })
  .strict()
  .refine((input) => Date.parse(input.from) < Date.parse(input.to), {
    message: 'Intervalul se termină înainte să înceapă.',
  })
  .refine((input) => Date.parse(input.to) - Date.parse(input.from) <= MAX_WINDOW_MS, {
    message: 'Sincronizați cel mult 60 de zile odată.',
  });
export const submissionView = z.object({
  id: z.string(),
  documentId: z.string(),
  number: z.string().nullable(),
  state: z.string(),
  uploadId: z.string().nullable(),
  downloadId: z.string().nullable(),
  detail: z.string().nullable(),
  steps: z.array(z.object({ state: z.string(), at: z.string() })),
});
export const syncView = z.object({
  listed: z.number(),
  recorded: z.number(),
  outcomes: z.record(z.string(), z.number()),
  submissions: z.record(z.string(), z.string()),
});

const issuedKinds = [invoiceKinds.sale, invoiceKinds.saleCredit];

/** The instant a Bucharest calendar day starts. */
export function bucharestMidnight(date: LocalDate): number {
  const utc = Date.parse(`${date}T00:00:00Z`);
  for (const hours of [3, 2]) {
    const instant = utc - hours * 3_600_000;
    if (bucharestDate(instant) === date && bucharestDate(instant - 1) !== date) return instant;
  }
  throw new RangeError(`No Bucharest midnight for ${date}.`);
}

/** Whether the union of the windows covers [from, to). */
export function covered(windows: { from: number; to: number }[], from: number, to: number) {
  let reached = from;
  for (const window of [...windows].sort((a, b) => a.from - b.from)) {
    if (window.from > reached) break;
    reached = Math.max(reached, window.to);
    if (reached >= to) return true;
  }
  return reached >= to;
}

async function latestStep(tx: Transaction, companyId: string, submissionId: string) {
  const [row] = await tx
    .select()
    .from(submissionEvents)
    .where(
      and(
        eq(submissionEvents.companyId, companyId),
        eq(submissionEvents.submissionId, submissionId),
      ),
    )
    .orderBy(desc(submissionEvents.seq))
    .limit(1);
  return row;
}

async function appendStep(
  tx: Transaction,
  actor: Actor,
  submissionId: string,
  step: Step,
  at: number,
) {
  const last = await latestStep(tx, actor.companyId, submissionId);
  await tx.insert(submissionEvents).values({
    companyId: actor.companyId,
    submissionId,
    seq: (last?.seq ?? 0) + 1,
    state: step.state,
    uploadId: step.uploadId ?? null,
    downloadId: step.downloadId ?? null,
    detail: step.detail ?? null,
    createdBy: actor.actorId,
    createdAt: new Date(at).toISOString(),
  });
  await appendAudit(tx, {
    companyId: actor.companyId,
    actorId: actor.actorId,
    ...(actor.agentId ? { agentId: actor.agentId } : {}),
    action: `spv.submission.${step.state}`,
    body: { submissionId, ...step },
  });
}

/** The error messages of an ANAF error report (`header/Error/@errorMessage`). */
function errorMessages(members: ParsedArchiveMember[]) {
  const text = members
    .filter((member) => member.kind === 'supporting_xml')
    .map((member) => member.bytes.toString('utf8'))
    .join('\n');
  return [...text.matchAll(/errorMessage="([^"]*)"/g)].map((match) => match[1]!).join(' | ');
}

/**
 * e-Factura through the SPV: uploads of issued documents, authorized by a person and never
 * repeated on their own; the inbox, read in windows whose union is the coverage; and the
 * archives it delivers, which import purchases and confirm or contradict the company's sales.
 */
export class Spv {
  constructor(
    private readonly commands: Commands,
    private readonly objects: ObjectStore,
    private readonly port?: EFacturaPort,
    /** The time, injectable so tests can reach ANAF's horizons without waiting for them. */
    private readonly clock: () => number = Date.now,
  ) {}

  private connection() {
    requireCondition(this.port, 'SPV_UNAVAILABLE', 'Conexiunea cu SPV nu este configurată.', 503);
    return this.port;
  }

  /** Authorizes the upload of an issued document's kept XML, then sends it once. */
  async submit(actor: Actor, key: string, input: z.infer<typeof submitInput>) {
    this.connection();
    const { submissionId } = await this.commands.run(
      actor,
      key,
      'spv.submit',
      input,
      'write',
      async (tx) => {
        const [document] = await tx
          .select()
          .from(documents)
          .where(and(eq(documents.companyId, actor.companyId), eq(documents.id, input.documentId)));
        requireCondition(
          document && (issuedKinds as string[]).includes(document.kind) && document.evidenceId,
          'NOT_SUBMITTABLE',
          'Se transmit numai facturile și notele de credit emise, cu XML-ul lor.',
        );
        const [source] = await tx
          .select()
          .from(evidence)
          .where(
            and(eq(evidence.companyId, actor.companyId), eq(evidence.id, document.evidenceId)),
          );
        requireCondition(
          source?.mediaType === 'application/xml',
          'NOT_SUBMITTABLE',
          'Documentul nu are un XML e-Factura păstrat.',
        );
        for (const earlier of await tx
          .select({ id: submissions.id })
          .from(submissions)
          .where(
            and(
              eq(submissions.companyId, actor.companyId),
              eq(submissions.documentId, document.id),
            ),
          )) {
          const step = await latestStep(tx, actor.companyId, earlier.id);
          requireCondition(
            step?.state === 'rejected' || step?.state === 'absent',
            'SUBMISSION_OPEN',
            'Documentul a fost deja transmis; o transmitere incertă se clarifică din SPV, nu se repetă.',
            409,
            { submissionId: earlier.id },
          );
        }
        const id = this.commands.ids();
        await tx.insert(submissions).values({
          id,
          companyId: actor.companyId,
          documentId: document.id,
          evidenceId: source.id,
          xmlHash: source.hash,
          createdBy: actor.actorId,
        });
        await appendStep(tx, actor, id, { state: 'authorized' }, this.clock());
        return { submissionId: id };
      },
    );
    await this.send(actor, submissionId);
    return this.view(actor, submissionId);
  }

  /**
   * Sends an authorized submission. Moving to `submitting` is the single claim on the upload:
   * a retry, or a second process, finds it taken and sends nothing.
   */
  private async send(actor: Actor, submissionId: string) {
    const claimed = await this.commands.db.write(async (tx) => {
      await this.commands.authorize(tx, actor, 'write', 'spv.submit');
      const step = await latestStep(tx, actor.companyId, submissionId);
      if (step?.state !== 'authorized') return null;
      await appendStep(tx, actor, submissionId, { state: 'submitting' }, this.clock());
      const [company] = await tx.select().from(companies).where(eq(companies.id, actor.companyId));
      const [row] = await tx
        .select({ hash: submissions.xmlHash })
        .from(submissions)
        .where(and(eq(submissions.companyId, actor.companyId), eq(submissions.id, submissionId)));
      return { cif: company!.cui, hash: row!.hash };
    });
    if (!claimed) return;
    let step: Step;
    try {
      const xml = await this.objects.get(actor.companyId, claimed.hash);
      const { uploadId } = await this.connection().upload({ cif: claimed.cif, xml });
      step = { state: 'submitted', uploadId };
    } catch (error) {
      step = {
        state: 'uncertain',
        detail:
          error instanceof EFacturaUnavailable
            ? `Răspunsul SPV nu a sosit (${error.message}); rezultatul se află la sincronizare.`
            : `Transmiterea a eșuat: ${(error as Error).message}`,
      };
    }
    await this.commands.db.write(async (tx) => {
      await this.commands.authorize(tx, actor, 'write', 'spv.submit');
      await appendStep(tx, actor, submissionId, step, this.clock());
    });
  }

  /** Asks ANAF how a submitted upload was processed. */
  async refresh(actor: Actor, input: z.infer<typeof submissionInput>) {
    const port = this.connection();
    const current = await this.view(actor, input.submissionId);
    const cif = await this.commands.db.read(async (tx) => {
      const [company] = await tx.select().from(companies).where(eq(companies.id, actor.companyId));
      return company!.cui;
    });
    let next: Step | null = null;
    if (
      current.state === 'submitting' &&
      this.clock() - Date.parse(current.steps.at(-1)!.at) > STALE_SUBMITTING_MS
    )
      next = {
        state: 'uncertain',
        detail: 'Încercarea de transmitere s-a întrerupt; rezultatul se află la sincronizare.',
      };
    if (current.state === 'submitted') {
      const status = await port.status({ cif, uploadId: current.uploadId! });
      if (status.state === 'ok') next = { state: 'accepted', downloadId: status.messageId };
      if (status.state === 'nok') {
        const archive = await port.download({ cif, messageId: status.messageId });
        next = {
          state: 'rejected',
          downloadId: status.messageId,
          detail: errorMessages(await parseInvoiceArchive(archive)).slice(0, 2000),
        };
      }
    }
    if (next) {
      const step = next;
      await this.commands.db.write(async (tx) => {
        await this.commands.authorize(tx, actor, 'write', 'spv.refresh');
        // Only from the state this answer is about; a concurrent sync may have moved on.
        const latest = await latestStep(tx, actor.companyId, input.submissionId);
        if (latest?.state === current.state)
          await appendStep(tx, actor, input.submissionId, step, this.clock());
      });
    }
    return this.view(actor, input.submissionId);
  }

  /**
   * Lists the inbox for a window, downloads every message not yet recorded and records what
   * its archive became. The window then counts as covered.
   */
  async sync(actor: Actor, key: string, input: z.infer<typeof syncInput>) {
    const port = this.connection();
    const from = Date.parse(input.from);
    const to = Date.parse(input.to);
    // A window reaching into the future would count messages not yet created as read.
    requireCondition(
      to <= this.clock(),
      'SPV_WINDOW',
      'Intervalul sincronizat nu poate depăși momentul actual.',
    );
    const cif = await this.commands.db.read(async (tx) => {
      await this.commands.authorize(tx, actor, 'write', 'spv.sync');
      const [company] = await tx.select().from(companies).where(eq(companies.id, actor.companyId));
      return company!.cui;
    });
    const listed = new Map<string, SpvMessage>();
    for (let page = 1, pages = 1; page <= pages; page += 1) {
      const result = await port.messages({ cif, from, to, page });
      pages = result.pages;
      // Listings can repeat a message across pages and windows; its id identifies it.
      for (const message of result.messages) listed.set(message.id, message);
    }
    const known = new Set(
      await this.commands.db.read(async (tx) =>
        (
          await tx
            .select({ id: spvMessages.id })
            .from(spvMessages)
            .where(
              and(
                eq(spvMessages.companyId, actor.companyId),
                inArray(spvMessages.id, [...listed.keys(), '']),
              ),
            )
        ).map((row) => row.id),
      ),
    );
    const fresh = [...listed.values()]
      .filter((message) => !known.has(message.id))
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    const archives = new Map<string, Uint8Array>();
    for (const message of fresh)
      archives.set(message.id, await port.download({ cif, messageId: message.id }));

    return this.commands.run(
      actor,
      key,
      'spv.sync',
      { ...input, messages: fresh.map((message) => message.id) },
      'write',
      async (tx) => {
        const outcomes: Record<string, number> = {};
        const reconciled: Record<string, string> = {};
        for (const message of fresh) {
          const outcome = await this.record(tx, actor, message, archives.get(message.id)!);
          outcomes[outcome.outcome] = (outcomes[outcome.outcome] ?? 0) + 1;
          if (outcome.submission) reconciled[outcome.submission] = outcome.state!;
        }
        const [last] = await tx
          .select({ seq: spvSyncWindows.seq })
          .from(spvSyncWindows)
          .where(eq(spvSyncWindows.companyId, actor.companyId))
          .orderBy(desc(spvSyncWindows.seq))
          .limit(1);
        await tx.insert(spvSyncWindows).values({
          companyId: actor.companyId,
          seq: (last?.seq ?? 0) + 1,
          from,
          to,
          messages: listed.size,
          createdBy: actor.actorId,
        });
        Object.assign(reconciled, await this.confirmAbsences(tx, actor));
        return { listed: listed.size, recorded: fresh.length, outcomes, submissions: reconciled };
      },
    );
  }

  /**
   * An archive downloaded from the SPV website, kept as evidence: read like a synced message.
   * It has no ANAF message metadata, so its direction comes from the invoice (the company as
   * supplier: sent) and it adds nothing to the synced coverage.
   */
  importArchive(actor: Actor, key: string, input: z.infer<typeof archiveInput>) {
    return this.commands.run(actor, key, 'spv.importArchive', input, 'write', async (tx) => {
      const [source] = await tx
        .select()
        .from(evidence)
        .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, input.evidenceId)));
      requireCondition(source, 'EVIDENCE', 'Documentul justificativ nu este disponibil.', 404);
      const id = `archive:${source.hash.slice(0, 40)}`;
      const [known] = await tx
        .select()
        .from(spvMessages)
        .where(and(eq(spvMessages.companyId, actor.companyId), eq(spvMessages.id, id)));
      if (known)
        return {
          messageId: id,
          kind: known.kind,
          outcome: known.outcome,
          documentId: known.documentId,
          detail: known.detail,
        };
      const bytes = await this.objects.get(actor.companyId, source.hash);
      const members = await parseInvoiceArchive(bytes);
      const invoice = members.find((member) => member.kind === 'invoice');
      const [company] = await tx.select().from(companies).where(eq(companies.id, actor.companyId));
      const supplier = invoice && parseInvoiceXml(invoice.bytes).supplier;
      const message: SpvMessage = {
        id,
        // ANAF names the invoice member after the upload index.
        uploadId: (invoice ?? members[0])?.filename.replace(/\.xml$/i, '') ?? '',
        kind: !invoice
          ? 'error'
          : supplier!.country === 'RO' && supplier!.taxId.replace(/^RO/i, '') === company!.cui
            ? 'sent'
            : 'received',
        createdAt: this.clock(),
        details: `Arhivă încărcată: ${source.filename}`.slice(0, 500),
      };
      const result = await this.record(tx, actor, message, bytes);
      return {
        messageId: id,
        kind: message.kind,
        outcome: result.outcome,
        documentId: result.documentId ?? null,
        detail: result.detail ?? null,
      };
    });
  }

  /** What one message's archive becomes: a purchase, a confirmed sale or a submission's end. */
  private async record(tx: Transaction, actor: Actor, message: SpvMessage, archive: Uint8Array) {
    const keep = async (bytes: Uint8Array, filename: string, mediaType: string) => {
      const hash = sha256(bytes);
      const [stored] = await tx
        .select({ id: evidence.id })
        .from(evidence)
        .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.hash, hash)));
      if (stored) return { id: stored.id, hash };
      await this.objects.put(actor.companyId, bytes, 64 * 1024 * 1024);
      const id = this.commands.ids();
      await tx.insert(evidence).values({
        id,
        companyId: actor.companyId,
        hash,
        filename,
        mediaType,
        size: bytes.length,
        createdBy: actor.actorId,
        engineAt: this.commands.clock(),
      });
      return { id, hash };
    };
    const archiveEvidence = await keep(archive, `spv-${message.id}.zip`, 'application/zip');
    let result: {
      outcome: (typeof spvMessages.$inferInsert)['outcome'];
      documentId?: string;
      detail?: string;
      submission?: string;
      state?: State;
    };
    try {
      result = await this.interpret(tx, actor, message, await parseInvoiceArchive(archive), keep);
    } catch (error) {
      result = {
        outcome: 'error',
        detail: `${(error as DomainError).code ?? 'ERROR'}: ${(error as Error).message}`.slice(
          0,
          2000,
        ),
      };
    }
    await tx.insert(spvMessages).values({
      companyId: actor.companyId,
      id: message.id,
      uploadId: message.uploadId,
      kind: message.kind,
      createdAtAnaf: message.createdAt,
      details: message.details.slice(0, 2000),
      evidenceId: archiveEvidence.id,
      documentId: result.documentId ?? null,
      outcome: result.outcome,
      detail: result.detail ?? null,
      createdBy: actor.actorId,
    });
    return result;
  }

  private async interpret(
    tx: Transaction,
    actor: Actor,
    message: SpvMessage,
    members: ParsedArchiveMember[],
    keep: (
      bytes: Uint8Array,
      filename: string,
      mediaType: string,
    ) => Promise<{ id: string; hash: string }>,
  ) {
    const pending = await this.pendingSubmissions(tx, actor.companyId);
    if (message.kind === 'error') {
      const submission = pending.find((item) => item.uploadId === message.uploadId);
      if (!submission) return { outcome: 'recorded' as const, detail: errorMessages(members) };
      await appendStep(
        tx,
        actor,
        submission.id,
        {
          state: 'rejected',
          downloadId: message.id,
          detail: errorMessages(members).slice(0, 2000),
        },
        this.clock(),
      );
      return {
        outcome: 'reconciled' as const,
        documentId: submission.documentId,
        submission: submission.id,
        state: 'rejected' as const,
      };
    }
    if (message.kind === 'buyer_message') return { outcome: 'recorded' as const };
    const member = members.find((item) => item.kind === 'invoice');
    if (!member) throw new DomainError('ARCHIVE_INVOICE', 'Arhiva nu conține factura.');
    const kept = await keep(member.bytes, member.filename, 'application/xml');
    if (message.kind === 'received') {
      const recorded = await recordInvoice(
        tx,
        actor,
        kept.id,
        member.bytes,
        'spv',
        this.commands.ids,
        this.commands.identities,
      );
      return {
        outcome: recorded.created ? ('created' as const) : ('matched' as const),
        documentId: recorded.row.id,
      };
    }

    // A sent invoice: the end of one of our submissions, or confirmation of a known sale.
    const submission = pending.find(
      (item) => item.xmlHash === kept.hash || item.uploadId === message.uploadId,
    );
    if (submission) {
      await appendStep(
        tx,
        actor,
        submission.id,
        {
          state: 'accepted',
          uploadId: message.uploadId,
          downloadId: message.id,
          detail: 'Confirmată din SPV.',
        },
        this.clock(),
      );
      return {
        outcome: 'reconciled' as const,
        documentId: submission.documentId,
        submission: submission.id,
        state: 'accepted' as const,
      };
    }
    const body = parseInvoiceXml(member.bytes);
    const [known] = await tx
      .select({ id: documents.id, body: documents.body, evidenceId: documents.evidenceId })
      .from(documents)
      .where(
        and(
          eq(documents.companyId, actor.companyId),
          eq(documents.number, body.number),
          eq(documents.docDate, body.issueDate),
          inArray(documents.kind, issuedKinds),
        ),
      );
    if (!known) {
      const recorded = await recordInvoice(
        tx,
        actor,
        kept.id,
        member.bytes,
        'spv',
        this.commands.ids,
        this.commands.identities,
      );
      return { outcome: 'created' as const, documentId: recorded.row.id };
    }
    const differences = compareSale(JSON.parse(known.body) as InvoiceDocument, body);
    return differences.length
      ? { outcome: 'differs' as const, documentId: known.id, detail: differences.join('; ') }
      : { outcome: 'matched' as const, documentId: known.id };
  }

  /** Submissions still waiting for ANAF's answer. */
  private async pendingSubmissions(tx: Transaction, companyId: string) {
    const rows = await tx.select().from(submissions).where(eq(submissions.companyId, companyId));
    const pending = [];
    for (const row of rows) {
      const step = await latestStep(tx, companyId, row.id);
      if (step?.state !== 'submitted' && step?.state !== 'uncertain') continue;
      const [upload] = await tx
        .select({ uploadId: submissionEvents.uploadId })
        .from(submissionEvents)
        .where(
          and(
            eq(submissionEvents.companyId, companyId),
            eq(submissionEvents.submissionId, row.id),
            eq(submissionEvents.state, 'submitted'),
          ),
        );
      pending.push({ ...row, uploadId: upload?.uploadId ?? null });
    }
    return pending;
  }

  /** An uncertain upload whose whole horizon is synced, without its message, never arrived. */
  private async confirmAbsences(tx: Transaction, actor: Actor) {
    const windows = await tx
      .select({ from: spvSyncWindows.from, to: spvSyncWindows.to })
      .from(spvSyncWindows)
      .where(eq(spvSyncWindows.companyId, actor.companyId));
    const confirmed: Record<string, string> = {};
    for (const submission of await this.pendingSubmissions(tx, actor.companyId)) {
      const steps = await tx
        .select()
        .from(submissionEvents)
        .where(
          and(
            eq(submissionEvents.companyId, actor.companyId),
            eq(submissionEvents.submissionId, submission.id),
          ),
        )
        .orderBy(asc(submissionEvents.seq));
      if (steps.at(-1)?.state !== 'uncertain') continue;
      const sent = Date.parse(steps.find((step) => step.state === 'submitting')!.createdAt);
      if (!covered(windows, sent - 60_000, sent + ABSENCE_HORIZON_MS)) continue;
      await appendStep(
        tx,
        actor,
        submission.id,
        {
          state: 'absent',
          detail:
            'SPV nu conține încărcarea în intervalul sincronizat; poate fi autorizată din nou.',
        },
        this.clock(),
      );
      confirmed[submission.id] = 'absent';
    }
    return confirmed;
  }

  view(actor: Actor, submissionId: string) {
    return this.commands.read(actor, 'spv.submissions', async (tx, access) => {
      const [row] = await tx
        .select({ submission: submissions, number: documents.number })
        .from(submissions)
        .innerJoin(
          documents,
          and(
            eq(documents.companyId, submissions.companyId),
            eq(documents.id, submissions.documentId),
          ),
        )
        .where(and(eq(submissions.companyId, actor.companyId), eq(submissions.id, submissionId)));
      requireCondition(row, 'NOT_FOUND', 'Transmiterea nu există.', 404);
      const cnps = (await this.commands.disclosable(tx, actor, access.role))(['personal']);
      return this.describe(tx, actor.companyId, row.submission, row.number, !cnps);
    });
  }

  list(actor: Actor) {
    return this.commands.read(actor, 'spv.submissions', async (tx, access) => {
      const cnps = (await this.commands.disclosable(tx, actor, access.role))(['personal']);
      const rows = await tx
        .select({ submission: submissions, number: documents.number })
        .from(submissions)
        .innerJoin(
          documents,
          and(
            eq(documents.companyId, submissions.companyId),
            eq(documents.id, submissions.documentId),
          ),
        )
        .where(eq(submissions.companyId, actor.companyId))
        .orderBy(asc(submissions.createdAt), asc(submissions.id));
      return Promise.all(
        rows.map((row) => this.describe(tx, actor.companyId, row.submission, row.number, !cnps)),
      );
    });
  }

  /** ANAF's messages; a caller who may not read personal data in clear reads their details
   * without CNPs (a B2C buyer's, quoted by the comparison of a sale or by ANAF). */
  messages(actor: Actor) {
    return this.commands.read(actor, 'spv.messages', async (tx, access) => {
      const cnps = (await this.commands.disclosable(tx, actor, access.role))(['personal']);
      const rows = await tx
        .select({
          id: spvMessages.id,
          uploadId: spvMessages.uploadId,
          kind: spvMessages.kind,
          createdAt: spvMessages.createdAtAnaf,
          documentId: spvMessages.documentId,
          outcome: spvMessages.outcome,
          detail: spvMessages.detail,
        })
        .from(spvMessages)
        .where(eq(spvMessages.companyId, actor.companyId))
        .orderBy(asc(spvMessages.createdAtAnaf), asc(spvMessages.id));
      return cnps
        ? rows
        : rows.map((row) => ({
            ...row,
            detail: row.detail === null ? null : maskCnpText(row.detail, true),
          }));
    });
  }

  /** A submission with its steps; `mask`: ANAF's messages without CNPs, for a caller who may
   * not read personal data in clear. */
  private async describe(
    tx: Transaction,
    companyId: string,
    submission: typeof submissions.$inferSelect,
    number: string | null,
    mask = false,
  ) {
    const steps = await tx
      .select()
      .from(submissionEvents)
      .where(
        and(
          eq(submissionEvents.companyId, companyId),
          eq(submissionEvents.submissionId, submission.id),
        ),
      )
      .orderBy(asc(submissionEvents.seq));
    const last = steps.at(-1)!;
    return {
      id: submission.id,
      documentId: submission.documentId,
      number,
      state: last.state,
      uploadId: steps.findLast((step) => step.uploadId)?.uploadId ?? null,
      downloadId: steps.findLast((step) => step.downloadId)?.downloadId ?? null,
      detail: mask && last.detail ? maskCnpText(last.detail, true) : last.detail,
      steps: steps.map((step) => ({ state: step.state, at: step.createdAt })),
    };
  }
}

/** Where an SPV copy of a sale differs from the document in the books. */
function compareSale(books: InvoiceDocument, spv: InvoiceDocument) {
  const differences: string[] = [];
  const same = (label: string, a: unknown, b: unknown, shown = (value: string) => value) => {
    if (canonical(a) !== canonical(b))
      differences.push(
        `${label}: ${shown(canonical(a))} în registre, ${shown(canonical(b))} în SPV`,
      );
  };
  same('tip', books.documentType, spv.documentType);
  same('monedă', books.currency, spv.currency);
  // A B2C buyer's CNP is compared, never written into the message (`maskCnpText`).
  same(
    'client',
    books.customer.taxId.replace(/^RO/i, ''),
    spv.customer.taxId.replace(/^RO/i, ''),
    (value) => maskCnpText(value),
  );
  same('totaluri', books.totals, spv.totals);
  same('TVA', books.taxes, spv.taxes);
  return differences;
}

/**
 * Once the company reads its inbox through the SPV, a month closes only when every instant of
 * it was synced; uploads still without an answer are reported.
 */
export const spvChecks: CloseCheck[] = [
  {
    id: 'spv.coverage',
    async run(tx, companyId, month) {
      const windows = await tx
        .select({ from: spvSyncWindows.from, to: spvSyncWindows.to })
        .from(spvSyncWindows)
        .where(eq(spvSyncWindows.companyId, companyId));
      if (!windows.length) return [];
      const start = bucharestMidnight(`${month}-01` as LocalDate);
      const end = bucharestMidnight(addDays(monthEnd(month as Month), 1));
      return covered(windows, start, end)
        ? []
        : [
            {
              code: 'SPV_COVERAGE_GAP',
              severity: 'block' as const,
              message: 'Mesajele SPV din această lună nu au fost sincronizate complet.',
            },
          ];
    },
  },
  {
    id: 'spv.pending',
    async run(tx, companyId, month) {
      const rows = await tx
        .select({ id: submissions.id, date: documents.docDate })
        .from(submissions)
        .innerJoin(
          documents,
          and(
            eq(documents.companyId, submissions.companyId),
            eq(documents.id, submissions.documentId),
          ),
        )
        .where(eq(submissions.companyId, companyId));
      const pending: string[] = [];
      for (const row of rows.filter((item) => item.date.startsWith(month))) {
        const step = await latestStep(tx, companyId, row.id);
        if (step && !['accepted', 'rejected', 'absent'].includes(step.state)) pending.push(row.id);
      }
      return pending.length
        ? [
            {
              code: 'SPV_PENDING',
              severity: 'warn' as const,
              message: 'Există facturi din această lună transmise fără răspuns definitiv din SPV.',
              count: pending.length,
              items: pending.slice(0, 20),
            },
          ]
        : [];
    },
  },
];
