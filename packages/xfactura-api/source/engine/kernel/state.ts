import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  like,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { hashOf } from 'xfactura-core/hash';
import type {
  AccountBalance,
  AccountInfo,
  ControlKind,
  DocumentRecord,
  EvidenceRecord,
  MovementRecord,
  FiscalYear,
  FxRate,
  LineSpec,
  Loaded,
  OpenItemKind,
  OpenItemState,
  PartyRecord,
  PayrollRunState,
  PostedEntry,
  AccountTurnover,
  AssetState,
  ProfileFact,
  ReadPlan,
  ReadSetEntry,
  TaxEntrySpec,
  TaxPeriodLedger,
} from 'xfactura-core/kernel';
import { turnoverKey } from 'xfactura-core/kernel';
import type { LocalDate } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import {
  assetEvents,
  assets,
  documents,
  entries,
  bankMovements,
  evidence,
  fiscalYears,
  fxRates,
  ledgerAccounts,
  lines,
  openItems,
  parties,
  payrollLines,
  payrollRunEvents,
  payrollRuns,
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
    if (query.foreign) where.push(ne(openItems.currency, 'RON'));
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

  const rateMap = new Map<string, FxRate[]>();
  for (const query of plan.fx ?? []) {
    const rows = await tx
      .select()
      .from(fxRates)
      .where(
        and(
          eq(fxRates.source, 'BNR'),
          eq(fxRates.currency, query.currency),
          lte(fxRates.rateDate, query.until),
        ),
      )
      .orderBy(desc(fxRates.rateDate), desc(fxRates.revision))
      .limit(20);
    const latest: FxRate[] = [];
    for (const row of rows)
      if (latest.at(-1)?.date !== row.rateDate)
        latest.push({
          id: `${row.source}/${row.currency}/${row.rateDate}/${row.revision}`,
          source: row.source,
          currency: row.currency,
          date: date(row.rateDate),
          rate: row.rate,
          multiplier: row.multiplier,
        });
    const known = rateMap.get(query.currency) ?? [];
    for (const rate of latest) if (!known.some((item) => item.id === rate.id)) known.push(rate);
    rateMap.set(
      query.currency,
      known.sort((a, b) => (a.date < b.date ? 1 : -1)),
    );
  }
  for (const rates of rateMap.values())
    for (const rate of rates) readSet.push({ kind: 'fx', id: rate.id, version: rate.rate });

  const balances: AccountBalance[] = [];
  if (plan.foreignBalances) {
    const rows = await tx
      .select({
        account: lines.account,
        currency: lines.currency,
        bani: sql<bigint>`sum(${sign} * ${lines.bani})`.mapWith(BigInt),
        minor: sql<bigint>`sum(${sign} * ${lines.currencyMinor})`.mapWith(BigInt),
      })
      .from(lines)
      .innerJoin(
        entries,
        and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId)),
      )
      .innerJoin(
        treasuryAccounts,
        and(
          eq(treasuryAccounts.companyId, lines.companyId),
          eq(treasuryAccounts.ledgerAccount, lines.account),
        ),
      )
      .where(
        and(
          eq(lines.companyId, companyId),
          isNotNull(lines.currency),
          lte(entries.date, plan.foreignBalances.at),
        ),
      )
      .groupBy(lines.account, lines.currency)
      .orderBy(asc(lines.account), asc(lines.currency));
    for (const row of rows) {
      if (row.bani === 0n && row.minor === 0n) continue;
      const balance = {
        account: row.account,
        currency: row.currency!,
        bani: row.bani,
        minor: row.minor,
      };
      balances.push(balance);
      readSet.push({
        kind: 'balance',
        id: `${row.account}/${row.currency}`,
        version: `${row.bani}/${row.minor}`,
      });
    }
  }

  const taxLedger = new Map<string, TaxPeriodLedger>();
  for (const query of plan.taxPeriods ?? []) {
    const key = `${query.tax}|${query.period}`;
    if (taxLedger.has(key)) continue;
    const posted = and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId));
    const taxRows = await tx
      .select({ tax: taxEntries, seq: entries.seq })
      .from(taxEntries)
      .innerJoin(
        entries,
        and(eq(entries.companyId, taxEntries.companyId), eq(entries.id, taxEntries.entryId)),
      )
      .where(
        and(
          eq(taxEntries.companyId, companyId),
          eq(taxEntries.tax, query.tax),
          eq(taxEntries.taxPeriod, query.period),
        ),
      )
      .orderBy(asc(entries.seq), asc(taxEntries.taxNo));
    const settlementRows = await tx
      .select({ line: lines, seq: entries.seq })
      .from(lines)
      .innerJoin(entries, posted)
      .where(
        and(
          eq(lines.companyId, companyId),
          eq(lines.taxSettlementTax, query.tax),
          eq(lines.taxSettlementPeriod, query.period),
        ),
      )
      .orderBy(asc(entries.seq), asc(lines.lineNo));
    taxLedger.set(key, {
      tax: query.tax,
      period: query.period,
      entries: taxRows.map(({ tax, seq }) => ({
        entryId: tax.entryId,
        seq: Number(seq),
        taxNo: Number(tax.taxNo),
        direction: tax.direction,
        code: tax.code,
        baseBani: tax.baseBani,
        taxBani: tax.taxBani,
        deductibleBani: tax.deductibleBani,
        ledgerBani: tax.ledgerBani,
        taxPoint: date(tax.taxPoint),
        documentId: tax.documentId,
        partyId: tax.partyId,
      })),
      settlements: settlementRows.map(({ line }) => ({
        entryId: line.entryId,
        account: line.account,
        side: line.side,
        bani: line.bani,
      })),
    });
    // The period as a whole: any entry landing in it changes the count or the last sequence.
    const last = Math.max(
      0,
      ...taxRows.map((row) => Number(row.seq)),
      ...settlementRows.map((row) => Number(row.seq)),
    );
    readSet.push({
      kind: 'taxPeriod',
      id: key,
      version: `${taxRows.length}/${settlementRows.length}/${last}`,
    });
  }

  const payrollRunMap = new Map<string, PayrollRunState>();
  for (const id of new Set(plan.payrollRuns ?? [])) {
    const [run] = await tx
      .select()
      .from(payrollRuns)
      .where(and(eq(payrollRuns.companyId, companyId), eq(payrollRuns.id, id)));
    if (!run) continue;
    const [last] = await tx
      .select({ state: payrollRunEvents.state })
      .from(payrollRunEvents)
      .where(and(eq(payrollRunEvents.companyId, companyId), eq(payrollRunEvents.runId, id)))
      .orderBy(desc(payrollRunEvents.seq))
      .limit(1);
    const rows = await tx
      .select()
      .from(payrollLines)
      .where(and(eq(payrollLines.companyId, companyId), eq(payrollLines.runId, id)))
      .orderBy(asc(payrollLines.contractId));
    payrollRunMap.set(id, {
      id,
      month: run.month,
      round: run.round,
      state: last!.state,
      issues: run.issues,
      lines: rows.map((row) => ({
        contractId: row.contractId,
        employeeId: row.employeeId,
        partyId: row.partyId,
        cash: row.cash,
        vouchers: row.vouchers,
        cas: row.cas,
        cass: row.cass,
        casEmployer: row.casEmployer,
        cassEmployer: row.cassEmployer,
        tax: row.tax,
        unionDues: row.unionDues,
        net: row.net,
        cam: row.cam,
        ...((steps) => ({
          camBase: BigInt(steps.find((step) => step.code === 'cam.base')?.amount ?? '0'),
          sickFund: BigInt(steps.find((step) => step.code === 'sick.fund')?.amount ?? '0'),
        }))((JSON.parse(row.result) as { steps?: { code: string; amount: string }[] }).steps ?? []),
      })),
    });
    readSet.push({ kind: 'payrollRun', id, version: `${run.resultHash}/${last!.state}` });
  }

  const turnover = new Map<string, AccountTurnover[]>();
  for (const query of plan.turnover ?? []) {
    const key = turnoverKey(query);
    if (turnover.has(key)) continue;
    const prefixes = or(...query.prefixes.map((prefix) => like(lines.account, `${prefix}%`)));
    const range = and(
      eq(lines.companyId, companyId),
      gte(entries.date, query.from),
      lte(entries.date, query.to),
      prefixes,
    );
    const join = and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId));
    const rows = await tx
      .select({
        account: lines.account,
        debit:
          sql<bigint>`sum(CASE WHEN ${lines.side} = 'D' THEN ${lines.bani} ELSE 0 END)`.mapWith(
            BigInt,
          ),
        credit:
          sql<bigint>`sum(CASE WHEN ${lines.side} = 'C' THEN ${lines.bani} ELSE 0 END)`.mapWith(
            BigInt,
          ),
      })
      .from(lines)
      .innerJoin(entries, join)
      .where(range)
      .groupBy(lines.account)
      .orderBy(asc(lines.account));
    const [mark] = await tx
      .select({
        count: sql<number>`count(*)`.mapWith(Number),
        last: sql<number>`COALESCE(max(${entries.seq}), 0)`.mapWith(Number),
      })
      .from(lines)
      .innerJoin(entries, join)
      .where(range);
    turnover.set(key, rows);
    // Any line posted in the range changes the count or the last sequence.
    readSet.push({ kind: 'turnover', id: key, version: `${mark!.count}/${mark!.last}` });
  }

  const assetMap = new Map<string, AssetState>();
  if (plan.assets) {
    const cards = await tx
      .select()
      .from(assets)
      .where(eq(assets.companyId, companyId))
      .orderBy(asc(assets.number));
    const disposals = new Map(
      (
        await tx
          .select({ assetId: assetEvents.assetId, date: assetEvents.date })
          .from(assetEvents)
          .where(and(eq(assetEvents.companyId, companyId), eq(assetEvents.kind, 'disposed')))
      ).map((row) => [row.assetId, row.date]),
    );
    const booked = await tx
      .select({
        item: lines.item,
        account: lines.account,
        bani: sql<bigint>`sum(CASE WHEN ${lines.side} = 'C' THEN ${lines.bani} ELSE -${lines.bani} END)`.mapWith(
          BigInt,
        ),
        count: sql<number>`count(*)`.mapWith(Number),
        last: sql<number>`max(${entries.seq})`.mapWith(Number),
      })
      .from(lines)
      .innerJoin(
        entries,
        and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId)),
      )
      .where(and(eq(lines.companyId, companyId), isNotNull(lines.item), like(lines.account, '28%')))
      .groupBy(lines.item, lines.account);
    let marks = 0;
    let last = 0;
    for (const card of cards) {
      const row = booked.find(
        (item) => item.item === card.id && item.account === card.depreciationAccount,
      );
      marks += row?.count ?? 0;
      last = Math.max(last, row?.last ?? 0);
      assetMap.set(card.id, {
        id: card.id,
        number: card.number,
        name: card.name,
        account: card.account,
        depreciationAccount: card.depreciationAccount,
        expenseAccount: card.expenseAccount,
        value: card.valueBani,
        lifeMonths: card.lifeMonths,
        commissionedOn: card.commissionedOn as LocalDate,
        disposedOn: (disposals.get(card.id) as LocalDate | undefined) ?? null,
        depreciated: row?.bani ?? 0n,
      });
    }
    // The register and the depreciation booked for it: a new asset, a disposal or a posted
    // depreciation line changes the version.
    readSet.push({
      kind: 'assets',
      id: 'register',
      version: `${cards.length}/${disposals.size}/${marks}/${last}`,
    });
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
    fxRates: rateMap,
    balances,
    taxLedger,
    payrollRuns: payrollRunMap,
    turnover,
    assets: assetMap,
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

/** Combines a follow-up read with the first one; entries already loaded keep their first value. */
export function mergeStates(
  first: Awaited<ReturnType<typeof loadState>>,
  second: Awaited<ReturnType<typeof loadState>>,
) {
  const merge = <V>(a: ReadonlyMap<string, V>, b: ReadonlyMap<string, V>) => new Map([...b, ...a]);
  const loaded: Loaded = {
    years: first.loaded.years,
    evidence: merge(first.loaded.evidence, second.loaded.evidence),
    documents: merge(first.loaded.documents, second.loaded.documents),
    entries: merge(first.loaded.entries, second.loaded.entries),
    openItems: merge(first.loaded.openItems, second.loaded.openItems),
    movements: merge(first.loaded.movements, second.loaded.movements),
    parties: merge(first.loaded.parties, second.loaded.parties),
    profile: first.loaded.profile.length ? first.loaded.profile : second.loaded.profile,
    fxRates: merge(first.loaded.fxRates, second.loaded.fxRates),
    balances: first.loaded.balances.length ? first.loaded.balances : second.loaded.balances,
    taxLedger: merge(first.loaded.taxLedger, second.loaded.taxLedger),
    payrollRuns: merge(first.loaded.payrollRuns, second.loaded.payrollRuns),
    turnover: merge(first.loaded.turnover, second.loaded.turnover),
    assets: merge(first.loaded.assets, second.loaded.assets),
  };
  const seen = new Set<string>();
  const readSet = [...first.readSet, ...second.readSet]
    .filter((entry) => {
      const id = `${entry.kind}/${entry.id}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => (a.kind === b.kind ? (a.id < b.id ? -1 : 1) : a.kind < b.kind ? -1 : 1));
  return { loaded, readSet };
}
