import { and, eq, gte, like, lt, max, or, sql, type SQL } from 'drizzle-orm';
import { canonical } from 'xfactura-core/hash';
import type { Effect } from 'xfactura-core/kernel';
import type { Transaction } from '../db/database';
import {
  entries,
  lines,
  openItems,
  scheduleRows,
  stockLayers,
  stockMoves,
  taxEntries,
} from '../db/schema';

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
  /** The engine's time of posting: a policy must be unexpired then (`inv:binding`). */
  engineAt: number;
}

/**
 * Whether the posted entry `entry` (a table alias or the quoted name of `acc_entries`) still
 * stands: no reversal of it was posted (`ledger.reverse`, whose subject is `reverse:<entry>`).
 * A correction is a reversal and a new proposal, so what is booked for a subject is its standing
 * entry, and the subject of a reversed entry is free again. A reversal is never reversed in turn
 * (`REVERSAL_OF_REVERSAL`), so one level decides.
 */
const standsText = (entry: string) => `not exists (select 1 from acc_proposals stv
    join acc_entries ste on ste.company_id = stv.company_id and ste.proposal_id = stv.id
    where stv.company_id = ${entry}.company_id and stv.subject_key = 'reverse:' || ${entry}.id)`;
export const entryStands = (entry: string) => sql.raw(standsText(entry));

/**
 * Whether the proposal `proposal` (a table alias or the quoted name of `acc_proposals`) holds its
 * subject: it is not withdrawn, and not posted by an entry reversed since. A company has at most
 * one such proposal per subject (`inv:subject_taken`).
 */
export const holdsSubject = (proposal: string) =>
  sql.raw(`(not exists (select 1 from acc_withdrawals hsw
      where hsw.company_id = ${proposal}.company_id and hsw.proposal_id = ${proposal}.id)
    and not exists (select 1 from acc_entries hse
      where hse.company_id = ${proposal}.company_id and hse.proposal_id = ${proposal}.id
        and not ${standsText('hse')}))`);

/**
 * A company's lines on accounts under any of `prefixes`, as `account LIKE 'prefix%'` reads them,
 * in place of the condition on the lines' company. A prefix of digits and dots (an account
 * code's synthetic part) is the range of codes that start with it, which the account index
 * (`line_account`) serves; SQLite's case-insensitive LIKE would read every line. Each range
 * carries the company, so that several are read one by one (a multi-index OR) rather than along a
 * company-wide index. Without prefixes, every line of the company.
 */
export function linesUnder(companyId: string, prefixes: readonly string[]): SQL {
  const company = eq(lines.companyId, companyId);
  if (!prefixes.length) return company;
  if (!prefixes.every((prefix) => /^[0-9.]+$/.test(prefix)))
    return and(company, or(...prefixes.map((prefix) => like(lines.account, `${prefix}%`))))!;
  const ranges = prefixes.map((prefix) => {
    const after =
      prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
    return and(company, gte(lines.account, prefix), lt(lines.account, after))!;
  });
  return ranges.length === 1 ? ranges[0]! : or(...ranges)!;
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
  // The stock register's layers and moves (effect@2), sealed by the header like the lines.
  await insertChunked(effect.stockLayers ?? [], (chunk) =>
    tx.insert(stockLayers).values(
      chunk.map((layer) => ({
        id: layer.ref,
        companyId,
        itemId: layer.item,
        warehouseId: layer.warehouse,
        account: layer.account,
        method: layer.method,
        date: layer.date,
        mayGoNegative: layer.mayGoNegative,
        originEntryId: entryId,
      })),
    ),
  );
  await insertChunked(
    (effect.stockMoves ?? []).map((move, index) => ({ move, moveNo: index + 1 })),
    (chunk) =>
      tx.insert(stockMoves).values(
        chunk.map(({ move, moveNo }) => ({
          companyId,
          entryId,
          moveNo,
          itemId: move.item,
          warehouseId: move.warehouse,
          account: move.account,
          layerId: move.layer,
          quantity: move.quantity,
          bani: move.bani,
          lineNo: move.line === undefined ? null : move.line + 1,
        })),
      ),
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
    engineAt: header.engineAt,
  });
  return { id: entryId, number, seq };
}
