import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import type { DataClass } from 'xfactura-core/kernel';
import { LEDGER_CURRENCY, parseMoney } from 'xfactura-core/money';
import {
  approvals,
  bankMovements,
  bankStatements,
  documents,
  entries,
  evidence,
  ledgerAccounts,
  lines,
  parties,
  proposals,
  proposalVersions,
} from '../db/schema';
import type { Actor, Commands } from '../kernel/commands';
import { healthClasses, payClasses, salaryPayment } from '../kernel/personal';
import { justifyingDocuments, linesAsShown } from '../kernel/reports';
import { evidenceClasses } from './evidence';

/*
 * One posted entry as the registers open it (`ledger.entry`): its header, its lines with their
 * accounts' and partners' names, what justifies it, who approved and posted it, and the entries
 * linked to it by a reversal. It shows what the journal shows this reader, no more.
 */

const minor = z.string().regex(/^-?\d+$/);
export const entryInput = z.object({ entryId: z.uuid() }).strict();
const linked = z.object({ entryId: z.string(), number: z.number(), date: z.string() });
export const entryView = z.object({
  id: z.string(),
  number: z.number(),
  seq: z.number(),
  date: z.string(),
  journalClass: z.string(),
  journalCode: z.string(),
  description: z.string(),
  /** The treatment that booked it, and a general entry's purpose (opening, general, adjustment). */
  treatment: z.string(),
  purpose: z.string().nullable(),
  /** The justifying document as the registers name it: its type, number and date. */
  document: z
    .object({ type: z.string(), number: z.string().nullable(), date: z.string() })
    .nullable(),
  /** The document the entry recognized, when it recognized one. */
  documentId: z.string().nullable(),
  lines: z.array(
    z.object({
      account: z.string(),
      accountName: z.string().nullable(),
      side: z.enum(['D', 'C']),
      /** In bani; null on a payment of one person's pay to a reader who may not read pay. */
      amount: z.object({ minor, currency: z.string() }).nullable(),
      /** A foreign currency's amount in its minor units, with the rate booked. */
      foreign: z.object({ minor, currency: z.string(), rate: z.string() }).nullable(),
      partyId: z.string().nullable(),
      partyName: z.string().nullable(),
      openItem: z.string().nullable(),
      memo: z.string().nullable(),
      /** Accounts folded into this line for a reader who may not read them (4382 into 641). */
      includes: z.array(z.string()).optional(),
    }),
  ),
  /** The files the entry rests on: those its version's input names, the recognized document's,
   * the bank statement of the movement it settles. A file the reader may not read keeps its
   * place without a name. */
  evidence: z.array(
    z.object({
      id: z.string(),
      filename: z.string().nullable(),
      mediaType: z.string(),
      redacted: z.literal(true).optional(),
    }),
  ),
  proposalId: z.string(),
  version: z.number(),
  /** The approval of the version posted; null when a posting policy bound it. */
  approval: z
    .object({
      id: z.string(),
      approverId: z.string(),
      at: z.string(),
      batchId: z.string().nullable(),
    })
    .nullable(),
  policyId: z.string().nullable(),
  postedBy: z.string(),
  agentId: z.string().nullable(),
  postedAt: z.string(),
  /** The entry this one reverses, and the posted entries that reverse this one. */
  reverses: linked.nullable(),
  reversedBy: z.array(linked),
  /** A payment of pay to a reader who may not read pay: its description and pay amounts withheld. */
  redacted: z.literal(true).optional(),
});

/** Every file the input names, at any depth of its objects and arrays: `evidenceId` and the
 * `…EvidenceId` fields, and the `evidenceIds` and `…EvidenceIds` lists. */
function evidenceIdsOf(input: unknown): string[] {
  if (Array.isArray(input)) return input.flatMap(evidenceIdsOf);
  if (!input || typeof input !== 'object') return [];
  return Object.entries(input).flatMap(([key, value]) => {
    if ((key === 'evidenceId' || key.endsWith('EvidenceId')) && typeof value === 'string')
      return [value];
    if (
      (key === 'evidenceIds' || key.endsWith('EvidenceIds')) &&
      Array.isArray(value) &&
      value.every((item) => typeof item === 'string')
    )
      return value as string[];
    return evidenceIdsOf(value);
  });
}

export async function ledgerEntry(
  commands: Commands,
  actor: Actor,
  input: z.infer<typeof entryInput>,
): Promise<z.infer<typeof entryView>> {
  return commands.read(actor, 'ledger.entry', async (tx, access) => {
    const [entry] = await tx
      .select()
      .from(entries)
      .where(and(eq(entries.companyId, actor.companyId), eq(entries.id, input.entryId)));
    requireCondition(entry, 'NOT_FOUND', 'Nota contabilă nu este disponibilă.', 404);
    const [booked] = await tx
      .select({
        treatment: proposals.treatmentId,
        subject: proposals.subjectKey,
        documentId: proposals.documentId,
        input: proposalVersions.input,
      })
      .from(proposals)
      .innerJoin(
        proposalVersions,
        and(
          eq(proposalVersions.companyId, proposals.companyId),
          eq(proposalVersions.proposalId, proposals.id),
          eq(proposalVersions.version, entry.version),
        ),
      )
      .where(and(eq(proposals.companyId, actor.companyId), eq(proposals.id, entry.proposalId)));
    const posted = JSON.parse(booked!.input) as Record<string, unknown>;
    const disclosable = await commands.disclosable(tx, actor, access.role);
    const rows = await tx
      .select()
      .from(lines)
      .where(and(eq(lines.companyId, actor.companyId), eq(lines.entryId, entry.id)))
      .orderBy(lines.lineNo);
    const shown = linesAsShown(rows, {
      pay: disclosable(payClasses),
      health: disclosable(healthClasses),
    });
    const document = (await justifyingDocuments(tx, actor.companyId, [entry])).get(entry.id);
    const documentId =
      (typeof posted.documentId === 'string' ? posted.documentId : null) ?? booked!.documentId;

    const codes = [...new Set(shown.lines.map((line) => line.account))];
    const accountNames = new Map(
      (
        await tx
          .select({ code: ledgerAccounts.code, name: ledgerAccounts.name })
          .from(ledgerAccounts)
          .where(
            and(eq(ledgerAccounts.companyId, actor.companyId), inArray(ledgerAccounts.code, codes)),
          )
      ).map((row) => [row.code, row.name]),
    );
    const partyIds = [
      ...new Set(shown.lines.flatMap((line) => (line.partyId ? [line.partyId] : []))),
    ];
    const partyNames = new Map(
      partyIds.length
        ? (
            await tx
              .select({ id: parties.id, name: parties.name })
              .from(parties)
              .where(and(eq(parties.companyId, actor.companyId), inArray(parties.id, partyIds)))
          ).map((row) => [row.id, row.name])
        : [],
    );

    // The files it rests on.
    const files = new Set(evidenceIdsOf(posted));
    if (documentId) {
      const [recognized] = await tx
        .select({ evidenceId: documents.evidenceId })
        .from(documents)
        .where(and(eq(documents.companyId, actor.companyId), eq(documents.id, documentId)));
      if (recognized?.evidenceId) files.add(recognized.evidenceId);
    }
    if (typeof posted.movementId === 'string') {
      const [statement] = await tx
        .select({ evidenceId: bankStatements.evidenceId })
        .from(bankMovements)
        .innerJoin(
          bankStatements,
          and(
            eq(bankStatements.companyId, bankMovements.companyId),
            eq(bankStatements.id, bankMovements.statementId),
          ),
        )
        .where(
          and(
            eq(bankMovements.companyId, actor.companyId),
            eq(bankMovements.id, posted.movementId),
          ),
        );
      if (statement) files.add(statement.evidenceId);
    }
    const kept = files.size
      ? await tx
          .select({ id: evidence.id, filename: evidence.filename, mediaType: evidence.mediaType })
          .from(evidence)
          .where(and(eq(evidence.companyId, actor.companyId), inArray(evidence.id, [...files])))
      : [];
    const classes = await evidenceClasses(
      tx,
      actor.companyId,
      kept.map((row) => row.id),
    );
    type FileShown = z.infer<typeof entryView>['evidence'][number];
    const evidenceShown = [...files].flatMap((id): FileShown[] => {
      const row = kept.find((item) => item.id === id);
      if (!row) return [];
      const held: DataClass[] = ['evidence', ...(classes.get(id) ?? [])];
      return disclosable(held)
        ? [row]
        : [{ id: row.id, filename: null, mediaType: row.mediaType, redacted: true }];
    });

    const [approval] = entry.approvalId
      ? await tx
          .select()
          .from(approvals)
          .where(and(eq(approvals.companyId, actor.companyId), eq(approvals.id, entry.approvalId)))
      : [];
    // A reversal's subject is `reverse:<entry>`: the entry it reverses, and the posted
    // reversals of this one.
    const reversedId = booked!.subject.startsWith('reverse:')
      ? booked!.subject.slice('reverse:'.length)
      : null;
    const [reverses] = reversedId
      ? await tx
          .select({ entryId: entries.id, number: entries.number, date: entries.date })
          .from(entries)
          .where(and(eq(entries.companyId, actor.companyId), eq(entries.id, reversedId)))
      : [];
    const reversedBy = await tx
      .select({ entryId: entries.id, number: entries.number, date: entries.date })
      .from(entries)
      .innerJoin(
        proposals,
        and(eq(proposals.companyId, entries.companyId), eq(proposals.id, entries.proposalId)),
      )
      .where(
        and(
          eq(entries.companyId, actor.companyId),
          eq(proposals.subjectKey, sql`${'reverse:'} || ${entry.id}`),
        ),
      )
      .orderBy(entries.seq);

    return {
      id: entry.id,
      number: entry.number,
      seq: entry.seq,
      date: entry.date,
      journalClass: entry.journalClass,
      journalCode: entry.journalCode,
      description: shown.salary ? salaryPayment : entry.description,
      treatment: booked!.treatment,
      purpose:
        booked!.treatment === 'ledger.general' && typeof posted.purpose === 'string'
          ? posted.purpose
          : null,
      document: document ? { ...document, number: shown.salary ? null : document.number } : null,
      documentId: documentId ?? null,
      lines: shown.lines.map((line) => {
        const currency = 'currency' in line ? line.currency : undefined;
        return {
          account: line.account,
          accountName: accountNames.get(line.account) ?? null,
          side: line.side,
          amount:
            line.amount === null
              ? null
              : {
                  minor: parseMoney(line.amount, LEDGER_CURRENCY).toString(),
                  currency: LEDGER_CURRENCY,
                },
          foreign: currency
            ? {
                minor: parseMoney(currency.amount, currency.code).toString(),
                currency: currency.code,
                rate: currency.rate,
              }
            : null,
          partyId: line.partyId ?? null,
          partyName: line.partyId ? (partyNames.get(line.partyId) ?? null) : null,
          openItem: line.openItem ?? null,
          memo: 'memo' in line && typeof line.memo === 'string' ? line.memo : null,
          ...('includes' in line && Array.isArray(line.includes)
            ? { includes: line.includes.map(String) }
            : {}),
        };
      }),
      evidence: evidenceShown,
      proposalId: entry.proposalId,
      version: entry.version,
      approval: approval
        ? {
            id: approval.id,
            approverId: approval.approverId,
            at: approval.createdAt,
            batchId: approval.batchRequestId,
          }
        : null,
      policyId: entry.policyId,
      postedBy: entry.postedBy,
      agentId: entry.agentId,
      postedAt: entry.postedAt,
      reverses: reverses ?? null,
      reversedBy,
      ...(shown.salary ? { redacted: true as const } : {}),
    };
  });
}
