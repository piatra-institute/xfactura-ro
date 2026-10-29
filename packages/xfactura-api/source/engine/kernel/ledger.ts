import { and, eq, max, sql } from 'drizzle-orm';
import { canonical } from 'xfactura-core/hash';
import type { Effect } from 'xfactura-core/kernel';
import type { Transaction } from '../db/database';
import { entries, lines, openItems, scheduleRows, taxEntries } from '../db/schema';

// Bounded multi-row inserts keep each statement well under SQLite's host-parameter limit.
const CHUNK = 400;

async function insertChunked<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>) {
  for (let index = 0; index < rows.length; index += CHUNK)
    await insert(rows.slice(index, index + CHUNK));
}

export interface EntryHeader {
  companyId: string;
  id: string;
  fiscalYearId: string;
  proposalId: string;
  version: number;
  approvalId?: string;
  policyId?: string;
  postedBy: string;
  agentId?: string;
}

/** The text stored as `effect_json`; the entry invariant reads the approved effect from it. */
export function serializeEffect(effect: Effect) {
  return canonical(effect);
}

/**
 * Writes an approved, id-resolved effect. Rows are inserted first under deferred foreign keys and
 * the header last: the header's invariant verifies every row against the approved effect, and
 * once it exists no further row can join the entry. Must run inside the posting transaction.
 */
export async function writeEntry(tx: Transaction, header: EntryHeader, effect: Effect) {
  const { companyId, id: entryId } = header;
  await tx.run(sql`PRAGMA defer_foreign_keys = ON`);
  await insertChunked(effect.openItems, (chunk) =>
    tx.insert(openItems).values(
      chunk.map((item) => ({
        id: item.ref,
        companyId,
        kind: item.kind,
        controlAccount: item.controlAccount,
        partyId: item.partyId,
        currency: item.currency,
        normalSide: item.normalSide,
        mayReverse: item.mayReverse,
        dueDate: item.dueDate ?? null,
        documentId: item.documentId ?? null,
        originEntryId: entryId,
      })),
    ),
  );
  await insertChunked(
    effect.lines.map((line, index) => ({ line, lineNo: index + 1 })),
    (chunk) =>
      tx.insert(lines).values(
        chunk.map(({ line, lineNo }) => ({
          companyId,
          entryId,
          lineNo,
          account: line.account,
          side: line.side,
          bani: line.bani,
          currency: line.currency?.code ?? null,
          currencyMinor: line.currency?.minor ?? null,
          fxRateId: line.currency?.rateId ?? null,
          fxRate: line.currency?.rate ?? null,
          partyId: line.partyId ?? null,
          openItemId: line.openItem ?? null,
          taxSettlementTax: line.taxSettlement?.tax ?? null,
          taxSettlementPeriod: line.taxSettlement?.period ?? null,
          costCenter: line.analytics?.costCenter ?? null,
          project: line.analytics?.project ?? null,
          item: line.analytics?.item ?? null,
          memo: line.memo ?? null,
        })),
      ),
  );
  await insertChunked(
    effect.taxEntries.map((entry, index) => ({ entry, taxNo: index + 1 })),
    (chunk) =>
      tx.insert(taxEntries).values(
        chunk.map(({ entry, taxNo }) => ({
          companyId,
          entryId,
          taxNo,
          key: entry.key,
          lineNo: entry.line === undefined ? null : entry.line + 1,
          tax: entry.tax,
          code: entry.code,
          direction: entry.direction,
          baseBani: entry.baseBani,
          taxBani: entry.taxBani,
          deductibleBani: entry.deductibleBani,
          ledgerBani: entry.ledgerBani,
          taxPoint: entry.taxPoint,
          exigibility: entry.exigibility,
          taxPeriod: entry.taxPeriod,
          partyId: entry.partyId ?? null,
          documentId: entry.documentId ?? null,
          originTaxEntry: entry.originTaxEntry ?? null,
          currency: entry.currency?.code ?? null,
          baseMinor: entry.currency?.baseMinor ?? null,
          taxMinor: entry.currency?.taxMinor ?? null,
          fxRateId: entry.currency?.rateId ?? null,
          fxRate: entry.currency?.rate ?? null,
          attributes: canonical(entry.attributes),
        })),
      ),
  );
  await insertChunked(
    effect.schedules.flatMap((schedule) =>
      schedule.rows.map((row) => ({
        companyId,
        scheduleId: schedule.ref,
        version: schedule.version,
        rowKey: row.key,
        entryId,
        openItemId: schedule.openItem,
        method: schedule.method,
        dueDate: row.due,
        bani: row.bani,
        counterAccount: row.counterAccount,
      })),
    ),
    (chunk) => tx.insert(scheduleRows).values(chunk),
  );
  const [numbering] = await tx
    .select({ number: max(entries.number) })
    .from(entries)
    .where(
      and(
        eq(entries.companyId, companyId),
        eq(entries.fiscalYearId, header.fiscalYearId),
        eq(entries.journalClass, effect.journalClass),
      ),
    );
  const [sequence] = await tx
    .select({ seq: max(entries.seq) })
    .from(entries)
    .where(eq(entries.companyId, companyId));
  const number = (numbering?.number ?? 0) + 1;
  const seq = (sequence?.seq ?? 0) + 1;
  await tx.insert(entries).values({
    id: entryId,
    companyId,
    fiscalYearId: header.fiscalYearId,
    journalClass: effect.journalClass,
    journalCode: effect.journalCode,
    number,
    seq,
    date: effect.date,
    period: effect.date.slice(0, 7),
    description: effect.description,
    proposalId: header.proposalId,
    version: header.version,
    approvalId: header.approvalId ?? null,
    policyId: header.policyId ?? null,
    postedBy: header.postedBy,
    agentId: header.agentId ?? null,
  });
  return { id: entryId, number, seq };
}
