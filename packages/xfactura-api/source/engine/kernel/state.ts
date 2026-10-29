import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { hashOf } from 'xfactura-core/hash';
import type {
  AccountInfo,
  ControlKind,
  DocumentRecord,
  EvidenceRecord,
  MovementRecord,
  FiscalYear,
  LineSpec,
  Loaded,
  OpenItemKind,
  OpenItemState,
  PartyRecord,
  PostedEntry,
  ProfileFact,
  ReadPlan,
  ReadSetEntry,
  TaxEntrySpec,
} from 'xfactura-core/kernel';
import type { LocalDate } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import {
  documents,
  entries,
  bankMovements,
  evidence,
  fiscalYears,
  ledgerAccounts,
  lines,
  openItems,
  parties,
  profileFacts,
  taxEntries,
  treasuryAccounts,
} from '../db/schema';

const date = (value: string) => value as LocalDate;
/** +1 for a debit line, −1 for a credit line. */
const sign = sql`case ${lines.side} when 'D' then 1 else -1 end`;

/** Lines of posted entries as the effect that recorded them (null columns omitted). */
export function lineSpec(row: typeof lines.$inferSelect): LineSpec {
  return {
    account: row.account,
    side: row.side,
    bani: row.bani,
    ...(row.currency
      ? {
          currency: {
            code: row.currency,
            minor: row.currencyMinor ?? 0n,
            rateId: row.fxRateId ?? '',
            rate: row.fxRate ?? '',
          },
        }
      : {}),
    ...(row.partyId ? { partyId: row.partyId } : {}),
    ...(row.openItemId ? { openItem: row.openItemId } : {}),
    ...(row.taxSettlementTax
      ? { taxSettlement: { tax: row.taxSettlementTax, period: row.taxSettlementPeriod ?? '' } }
      : {}),
    ...(row.costCenter || row.project || row.item
      ? {
          analytics: {
            ...(row.costCenter ? { costCenter: row.costCenter } : {}),
            ...(row.project ? { project: row.project } : {}),
            ...(row.item ? { item: row.item } : {}),
          },
        }
      : {}),
    ...(row.memo ? { memo: row.memo } : {}),
  };
}

function taxEntrySpec(row: typeof taxEntries.$inferSelect): TaxEntrySpec {
  return {
    key: row.key,
    tax: row.tax,
    code: row.code,
    direction: row.direction,
    baseBani: row.baseBani,
    taxBani: row.taxBani,
    deductibleBani: row.deductibleBani,
    taxPoint: date(row.taxPoint),
    exigibility: row.exigibility ? date(row.exigibility) : null,
    taxPeriod: row.taxPeriod,
    ...(row.lineNo === null ? {} : { line: row.lineNo - 1 }),
    ledgerBani: row.ledgerBani,
    ...(row.partyId ? { partyId: row.partyId } : {}),
    ...(row.documentId ? { documentId: row.documentId } : {}),
    ...(row.originTaxEntry ? { originTaxEntry: row.originTaxEntry } : {}),
    ...(row.currency
      ? {
          currency: {
            code: row.currency,
            baseMinor: row.baseMinor ?? 0n,
            taxMinor: row.taxMinor ?? 0n,
            rateId: row.fxRateId ?? '',
            rate: row.fxRate ?? '',
          },
        }
      : {}),
    attributes: JSON.parse(row.attributes) as Record<string, string>,
  };
}

/** Open items with their balances, as of everything posted so far. */
export async function loadOpenItems(tx: Transaction, companyId: string, where: SQL[]) {
  const rows = await tx
    .select({
      item: openItems,
      bani: sql<bigint>`coalesce(sum(${sign} * ${lines.bani}), 0)`.mapWith(BigInt),
      minor:
        sql<bigint>`coalesce(sum(${sign} * coalesce(${lines.currencyMinor}, ${lines.bani})), 0)`.mapWith(
          BigInt,
        ),
      movements: sql<number>`count(${lines.lineNo})`.mapWith(Number),
    })
    .from(openItems)
    .leftJoin(
      lines,
      and(eq(lines.companyId, openItems.companyId), eq(lines.openItemId, openItems.id)),
    )
    .where(and(eq(openItems.companyId, companyId), ...where))
    .groupBy(openItems.id)
    .orderBy(asc(openItems.id));
  return rows.map(({ item, bani, minor, movements }): OpenItemState => ({
    id: item.id,
    kind: item.kind as OpenItemKind,
    controlAccount: item.controlAccount,
    partyId: item.partyId,
    currency: item.currency,
    normalSide: item.normalSide,
    mayReverse: item.mayReverse,
    balanceBani: bani,
    balanceMinor: minor,
    documentId: item.documentId,
    dueDate: item.dueDate ? date(item.dueDate) : null,
    movements,
  }));
}

/** Executes a read plan in the caller's transaction and records what was read. */
export async function loadState(tx: Transaction, companyId: string, plan: ReadPlan) {
  const readSet: ReadSetEntry[] = [];
  const years: FiscalYear[] = (
    await tx
      .select()
      .from(fiscalYears)
      .where(eq(fiscalYears.companyId, companyId))
      .orderBy(asc(fiscalYears.from), asc(fiscalYears.kind))
  ).map((row) => ({ id: row.id, kind: row.kind, from: date(row.from), to: date(row.to) }));

  const evidenceMap = new Map<string, EvidenceRecord>();
  if (plan.evidence?.length)
    for (const row of await tx
      .select()
      .from(evidence)
      .where(and(eq(evidence.companyId, companyId), inArray(evidence.id, plan.evidence)))
      .orderBy(asc(evidence.id))) {
      evidenceMap.set(row.id, {
        id: row.id,
        hash: row.hash,
        filename: row.filename,
        mediaType: row.mediaType,
      });
      readSet.push({ kind: 'evidence', id: row.id, version: row.hash });
    }

  const documentMap = new Map<string, DocumentRecord>();
  if (plan.documents?.length)
    for (const row of await tx
      .select()
      .from(documents)
      .where(and(eq(documents.companyId, companyId), inArray(documents.id, plan.documents)))
      .orderBy(asc(documents.id))) {
      documentMap.set(row.id, {
        id: row.id,
        kind: row.kind,
        schema: row.schema,
        body: JSON.parse(row.body),
        bodyHash: row.bodyHash,
        docDate: date(row.docDate),
        partyId: row.partyId,
        currency: row.currency,
        number: row.number,
        evidenceId: row.evidenceId,
      });
      readSet.push({ kind: 'document', id: row.id, version: row.bodyHash });
    }

  const entryMap = new Map<string, PostedEntry>();
  if (plan.entries?.length) {
    const ids = plan.entries;
    const headers = await tx
      .select()
      .from(entries)
      .where(and(eq(entries.companyId, companyId), inArray(entries.id, ids)))
      .orderBy(asc(entries.seq));
    const lineRows = await tx
      .select()
      .from(lines)
      .where(and(eq(lines.companyId, companyId), inArray(lines.entryId, ids)))
      .orderBy(asc(lines.entryId), asc(lines.lineNo));
    const taxRows = await tx
      .select()
      .from(taxEntries)
      .where(and(eq(taxEntries.companyId, companyId), inArray(taxEntries.entryId, ids)))
      .orderBy(asc(taxEntries.entryId), asc(taxEntries.taxNo));
    for (const header of headers) {
      entryMap.set(header.id, {
        id: header.id,
        number: header.number,
        date: date(header.date),
        journalCode: header.journalCode,
        description: header.description,
        lines: lineRows.filter((row) => row.entryId === header.id).map(lineSpec),
        taxEntries: taxRows.filter((row) => row.entryId === header.id).map(taxEntrySpec),
      });
      readSet.push({ kind: 'entry', id: header.id, version: String(header.seq) });
    }
  }

  const itemMap = new Map<string, OpenItemState>();
  for (const query of plan.openItems ?? []) {
    const where: SQL[] = [];
    if (query.ids) where.push(query.ids.length ? inArray(openItems.id, query.ids) : sql`0`);
    if (query.touchedBy)
      where.push(
        inArray(
          openItems.id,
          tx
            .select({ id: lines.openItemId })
            .from(lines)
            .where(and(eq(lines.companyId, companyId), eq(lines.entryId, query.touchedBy))),
        ),
      );
    if (query.documentId) where.push(eq(openItems.documentId, query.documentId));
    if (query.partyId) where.push(eq(openItems.partyId, query.partyId));
    if (query.kind) where.push(eq(openItems.kind, query.kind));
    for (const item of await loadOpenItems(tx, companyId, where))
      if (!query.openOnly || item.balanceBani !== 0n || item.balanceMinor !== 0n)
        itemMap.set(item.id, item);
  }
  for (const item of [...itemMap.values()].sort((a, b) => (a.id < b.id ? -1 : 1)))
    readSet.push({ kind: 'openItem', id: item.id, version: String(item.movements) });

  const movementMap = new Map<string, MovementRecord>();
  if (plan.movements?.length)
    for (const { movement, account } of await tx
      .select({ movement: bankMovements, account: treasuryAccounts })
      .from(bankMovements)
      .innerJoin(
        treasuryAccounts,
        and(
          eq(treasuryAccounts.companyId, bankMovements.companyId),
          eq(treasuryAccounts.id, bankMovements.treasuryAccountId),
        ),
      )
      .where(and(eq(bankMovements.companyId, companyId), inArray(bankMovements.id, plan.movements)))
      .orderBy(asc(bankMovements.id))) {
      movementMap.set(movement.id, {
        id: movement.id,
        treasuryAccountId: movement.treasuryAccountId,
        ledgerAccount: account.ledgerAccount,
        currency: movement.currency,
        bookingDate: date(movement.bookingDate),
        valueDate: movement.valueDate ? date(movement.valueDate) : null,
        amountMinor: movement.amountMinor,
        reference: movement.reference,
        counterparty: movement.counterparty,
      });
      readSet.push({ kind: 'movement', id: movement.id, version: movement.sourceId });
    }

  const partyMap = new Map<string, PartyRecord>();
  if (plan.parties?.length)
    for (const row of await tx
      .select()
      .from(parties)
      .where(and(eq(parties.companyId, companyId), inArray(parties.id, plan.parties)))
      .orderBy(asc(parties.id))) {
      const record = {
        id: row.id,
        kind: row.kind,
        country: row.country,
        taxId: row.taxId,
        name: row.name,
      };
      partyMap.set(row.id, record);
      readSet.push({ kind: 'party', id: row.id, version: hashOf(record) });
    }

  let profile: ProfileFact[] = [];
  if (plan.profile) {
    const rows = await tx
      .select()
      .from(profileFacts)
      .where(eq(profileFacts.companyId, companyId))
      .orderBy(asc(profileFacts.effectiveFrom), asc(profileFacts.createdAt), asc(profileFacts.id));
    const superseded = new Set(rows.map((row) => row.supersedesId).filter(Boolean));
    profile = rows
      .filter((row) => !superseded.has(row.id))
      .map((row) => ({ axis: row.axis, value: row.value, effectiveFrom: date(row.effectiveFrom) }));
    readSet.push({ kind: 'profile', id: 'company', version: hashOf(profile) });
  }

  const loaded: Loaded = {
    years,
    evidence: evidenceMap,
    documents: documentMap,
    entries: entryMap,
    openItems: itemMap,
    movements: movementMap,
    parties: partyMap,
    profile,
  };
  return { loaded, readSet };
}

export async function loadAccounts(tx: Transaction, companyId: string, codes: string[]) {
  const map = new Map<string, AccountInfo>();
  if (codes.length === 0) return map;
  for (const row of await tx
    .select()
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.companyId, companyId), inArray(ledgerAccounts.code, codes))))
    map.set(row.code, {
      code: row.code,
      postable: row.postable,
      controlKind: row.controlKind as ControlKind | null,
      validFrom: date(row.validFrom),
      validTo: row.validTo ? date(row.validTo) : null,
    });
  return map;
}
