import { keepsRegister, stockAccounts, stockPositions } from './stock';
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import type { JsonValue, Loaded } from 'xfactura-core/kernel';
import { convertMinor, formatMoney, LEDGER_CURRENCY, parseMoney } from 'xfactura-core/money';
import { booksSystemOf } from 'xfactura-core/ro/entity';
import { selectRate } from 'xfactura-core/ro/fx';
import { invoiceKinds } from 'xfactura-core/ro/treatments/invoices';
import { monetaryKinds } from 'xfactura-core/ro/treatments/revaluation';
import {
  canonicalSnapshot,
  compareInventory,
  collectibilityAnswer,
  depreciationAt,
  differenceView,
  impairmentPolicies,
  inventoryDocumentKind,
  policyDays,
  inventoryListSchema,
  provisionReviewAnswer,
  provisionTag,
  snapshotDifferences,
  snapshotHash,
  untakenLeaveAnswer,
  type BookCash,
  type BookPartner,
  type ClosingSnapshot,
  type InventoryComparison,
  type InventoryList,
  type ProfitNote,
} from 'xfactura-core/ro/yearend';
import { RuleGapError, type RuleContext } from 'xfactura-core/rules';
import { addDays, daysBetween, type LocalDate } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import {
  actionExecutions,
  actionRequests,
  artifactEvents,
  artifacts,
  bankMovements,
  dispositions,
  documentLinks,
  documents,
  employmentTerms,
  entries,
  fiscalYears,
  ledgerAccounts,
  lines,
  openItems,
  parties,
  periodEvents,
  proposals,
  proposalVersions,
  treasuryAccounts,
  stockItems,
  warehouses,
} from '../db/schema';
import type { ActionHandler } from '../kernel/actions';
import type { Actor, Commands } from '../kernel/commands';
import { entryStands, holdsSubject, linesUnder } from '../kernel/ledger';
import type { CloseCheck, Finding } from '../kernel/periods';
import { loadState } from '../kernel/state';
import type { WorkStep, YearEndWorkItem } from '../kernel/work';
import { standing } from './questions';

/*
 * The year-end in full (Y1, core ro/yearend): the annual inventory compared with the books, the
 * review of what the year's last day must hold before the year closes (the inventory and its
 * differences, the impairments, the provisions, the cut-off, the result and its tax), the
 * reviewed year close that records the itemized closing snapshot and locks the year, and the
 * next year's opening checked against it. Each review item is a worklist item with the step that
 * moves it on; the month close of the year's last month shows them as warnings, and the year
 * close refuses until none blocks.
 */

type Year = { id: string; from: string; to: string };
const sign = sql`case ${lines.side} when 'D' then 1 else -1 end`;
const posted = and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId));
const lei = (bani: bigint) => formatMoney(bani, LEDGER_CURRENCY);
const money = (minor: bigint, currency: string) => {
  try {
    return formatMoney(minor, currency as never);
  } catch {
    return formatMoney(minor, LEDGER_CURRENCY);
  }
};
const agent = (operation: string, inputHint: WorkStep['inputHint'] = {}): WorkStep => ({
  operation,
  by: 'agent',
  inputHint,
});
const human = (operation: string, inputHint: WorkStep['inputHint'] = {}): WorkStep => ({
  operation,
  by: 'human',
  inputHint,
});
const propose = (treatment: string, input: WorkStep['inputHint'] = {}) =>
  agent('proposals.propose', { treatment, input });
const ask = (kind: string, subject: { kind: string; id: string }, params: JsonValue) =>
  agent('questions.ask', { kind, subject, params });

export const yearInput = z.object({ financialYearId: z.string().min(1).max(100) }).strict();
export const reopenYearInput = yearInput
  .extend({ reason: z.string().trim().min(10).max(1000) })
  .strict();
export const compareInput = z
  .object({ date: z.iso.date().transform((value) => value as LocalDate) })
  .strict();
export const openingInput = z
  .object({
    /** The financial year whose opening is checked: its previous year's close is the basis. */
    financialYearId: z.string().min(1).max(100),
  })
  .strict();

async function yearsOf(tx: Transaction, companyId: string): Promise<Year[]> {
  return (
    await tx
      .select({ id: fiscalYears.id, from: fiscalYears.from, to: fiscalYears.to })
      .from(fiscalYears)
      .where(and(eq(fiscalYears.companyId, companyId), eq(fiscalYears.kind, 'financial')))
      .orderBy(asc(fiscalYears.from))
  ).map((row) => ({ id: row.id, from: row.from, to: row.to }));
}

async function yearById(tx: Transaction, companyId: string, id: string) {
  const year = (await yearsOf(tx, companyId)).find((item) => item.id === id);
  requireCondition(year, 'NOT_FOUND', 'Exercițiul financiar nu există.', 404);
  return year;
}

// ---------------------------------------------------------------------------------------------
// The books at a date

/**
 * Each account's balance per currency, debit less credit, from every line dated by `to`, with its
 * movement in lei from `from` on (`moved`). The entries dated by then are read first and each
 * one's lines together (CROSS JOIN keeps the entries outermost), not every line along an index.
 */
async function ledgerAt(tx: Transaction, companyId: string, to: string, from: string) {
  const currency = sql<string>`coalesce(${lines.currency}, 'RON')`;
  return tx
    .select({
      account: lines.account,
      currency,
      bani: sql<bigint>`sum(${sign} * ${lines.bani})`.mapWith(BigInt),
      minor: sql<bigint>`sum(${sign} * coalesce(${lines.currencyMinor}, ${lines.bani}))`.mapWith(
        BigInt,
      ),
      moved:
        sql<bigint>`sum(CASE WHEN ${entries.date} >= ${from} THEN ${sign} * ${lines.bani} ELSE 0 END)`.mapWith(
          BigInt,
        ),
    })
    .from(entries)
    .crossJoin(lines)
    .where(and(eq(entries.companyId, companyId), lte(entries.date, to), posted))
    .groupBy(lines.account, currency)
    .orderBy(asc(lines.account), asc(currency));
}

/** The balances of `ledgerAt`'s rows: those not nil, without their movement. */
const balancesOf = (rows: Awaited<ReturnType<typeof ledgerAt>>) =>
  rows
    .filter((row) => row.bani !== 0n || row.minor !== 0n)
    .map(({ account, currency, bani, minor }) => ({ account, currency, bani, minor }));

/** Each account's balance per currency, debit less credit, from every line dated by `to`. */
async function accountBalances(tx: Transaction, companyId: string, to: string) {
  return balancesOf(await ledgerAt(tx, companyId, to, to));
}

type ItemBalance = {
  id: string;
  kind: string;
  account: string;
  partyId: string;
  currency: string;
  /** The due date, or the day the item was opened when it has none. */
  dueDate: string | null;
  originDate: string;
  bani: bigint;
  minor: bigint;
};
/** Each open item's balance from its lines dated by `to`; items nothing was booked on by then
 * are left out. */
async function itemBalances(
  tx: Transaction,
  companyId: string,
  to: string,
): Promise<ItemBalance[]> {
  return (
    (
      await tx
        .select({
          id: openItems.id,
          kind: openItems.kind,
          account: openItems.controlAccount,
          partyId: openItems.partyId,
          currency: openItems.currency,
          dueDate: openItems.dueDate,
          originDate: sql<string>`(select o.date from acc_entries o
          where o.company_id = ${openItems.companyId} and o.id = ${openItems.originEntryId})`,
          bani: sql<bigint>`sum(${sign} * ${lines.bani})`.mapWith(BigInt),
          minor:
            sql<bigint>`sum(${sign} * coalesce(${lines.currencyMinor}, ${lines.bani}))`.mapWith(
              BigInt,
            ),
        })
        .from(lines)
        .innerJoin(entries, posted)
        .innerJoin(
          openItems,
          and(eq(openItems.companyId, lines.companyId), eq(openItems.id, lines.openItemId)),
        )
        // Only the lines naming an item, along their index (`line_open_item`).
        .where(
          and(eq(lines.companyId, companyId), isNotNull(lines.openItemId), lte(entries.date, to)),
        )
        .groupBy(openItems.id)
        .orderBy(asc(openItems.id))
    ).map((row) => ({
      ...row,
      // A currency item's lines all carry its currency; one in lei counts in bani.
      minor: row.currency === LEDGER_CURRENCY ? row.bani : row.minor,
    }))
  );
}

/** The lines tagged with an analytics item on accounts under a prefix, dated by `to`: credit
 * less debit, per item and account. */
async function taggedBalances(tx: Transaction, companyId: string, prefixes: string[], to: string) {
  return (
    await tx
      .select({
        item: lines.item,
        account: lines.account,
        bani: sql<bigint>`sum(CASE WHEN ${lines.side} = 'C' THEN ${lines.bani} ELSE -${lines.bani} END)`.mapWith(
          BigInt,
        ),
      })
      .from(lines)
      .innerJoin(entries, posted)
      .where(and(linesUnder(companyId, prefixes), isNotNull(lines.item), lte(entries.date, to)))
      .groupBy(lines.item, lines.account)
  ).map((row) => ({ item: row.item!, account: row.account, bani: row.bani }));
}

/** The register's assets at `to`: value, depreciation and impairment booked by then, and the
 * latest fiscal basis. */
async function assetsAt(tx: Transaction, companyId: string, to: string) {
  const state = await loadState(tx, companyId, { assets: true });
  const tagged = await taggedBalances(tx, companyId, ['28', '29'], to);
  const of = (item: string, account?: string) =>
    tagged
      .filter((row) => row.item === item && (account === undefined || row.account === account))
      .reduce((sum, row) => sum + row.bani, 0n);
  return [...state.loaded.assets.values()]
    .filter((asset) => asset.commissionedOn <= to)
    .map((asset) => ({
      asset,
      depreciated: of(asset.id, asset.depreciationAccount),
      impaired: tagged
        .filter((row) => row.item === `impairment:${asset.id}` && row.account.startsWith('29'))
        .reduce((sum, row) => sum + row.bani, 0n),
      inUse: !(asset.disposedOn && asset.disposedOn <= to),
    }));
}

type Posting = {
  entryId: string;
  date: string;
  treatmentId: string;
  subject: string;
  input: Record<string, JsonValue>;
  effect: { lines?: unknown[]; explanation?: { details?: Record<string, JsonValue> } };
};
/** The postings that stand of some treatments, dated in a range. */
async function postingsOf(
  tx: Transaction,
  companyId: string,
  treatmentIds: string[],
  from: string,
  to: string,
): Promise<Posting[]> {
  const rows = await tx
    .select({
      entryId: entries.id,
      date: entries.date,
      treatmentId: proposals.treatmentId,
      subject: proposals.subjectKey,
      input: proposalVersions.input,
      effect: proposalVersions.effect,
    })
    .from(entries)
    .innerJoin(
      proposals,
      and(eq(proposals.companyId, entries.companyId), eq(proposals.id, entries.proposalId)),
    )
    .innerJoin(
      proposalVersions,
      and(
        eq(proposalVersions.companyId, entries.companyId),
        eq(proposalVersions.proposalId, entries.proposalId),
        eq(proposalVersions.version, entries.version),
      ),
    )
    .where(
      and(
        eq(entries.companyId, companyId),
        inArray(proposals.treatmentId, treatmentIds),
        gte(entries.date, from),
        lte(entries.date, to),
        entryStands('"acc_entries"'),
      ),
    )
    .orderBy(asc(entries.seq));
  return rows.map((row) => ({
    entryId: row.entryId,
    date: row.date,
    treatmentId: row.treatmentId,
    subject: row.subject,
    input: JSON.parse(row.input) as Record<string, JsonValue>,
    effect: JSON.parse(row.effect ?? '{}') as Posting['effect'],
  }));
}

// ---------------------------------------------------------------------------------------------
// The annual inventory against the books

/** The inventory lists of a date: one per group of copies, the corrected extraction standing for
 * the one it superseded. */
async function listsOf(tx: Transaction, companyId: string, date: string) {
  const rows = await tx
    .select({ id: documents.id, body: documents.body })
    .from(documents)
    .where(
      and(
        eq(documents.companyId, companyId),
        eq(documents.kind, inventoryDocumentKind),
        eq(documents.docDate, date),
        sql`not exists (select 1 from ${documentLinks} g where g.company_id = ${documents.companyId}
          and g.from_id = ${documents.id} and g.kind in ('same_as', 'same_as_confirmed'))`,
        sql`not exists (select 1 from ${documentLinks} s where s.company_id = ${documents.companyId}
          and s.to_id = ${documents.id} and s.kind = 'supersedes')`,
      ),
    )
    .orderBy(asc(documents.id));
  return rows.flatMap((row) => {
    const parsed = inventoryListSchema.safeParse(JSON.parse(row.body));
    return parsed.success ? [{ id: row.id, body: parsed.data as InventoryList }] : [];
  });
}

/** The books as the inventory compares them, at `date`. */
type BooksAt = {
  balances: Awaited<ReturnType<typeof accountBalances>>;
  items: ItemBalance[];
};
async function inventoryBooks(
  tx: Transaction,
  companyId: string,
  date: LocalDate,
  from: string,
  at?: BooksAt,
) {
  const balances = at?.balances ?? (await accountBalances(tx, companyId, date));
  const retail = new Set(
    (
      await tx
        .select({ code: ledgerAccounts.code })
        .from(ledgerAccounts)
        .where(
          and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.controlKind, 'retail')),
        )
    ).map((row) => row.code),
  );
  // The cash desks and banks used in the year, with their balance (zero ones too).
  const used = await tx
    .selectDistinct({
      account: lines.account,
      currency: sql<string>`coalesce(${lines.currency}, 'RON')`,
    })
    .from(lines)
    .innerJoin(entries, posted)
    .where(
      and(linesUnder(companyId, ['531', '512']), gte(entries.date, from), lte(entries.date, date)),
    );
  const desk = (prefix: string): BookCash[] => {
    const keys = new Set([
      ...used
        .filter((row) => row.account.startsWith(prefix))
        .map((row) => `${row.account}/${row.currency}`),
      ...balances
        .filter((row) => row.account.startsWith(prefix))
        .map((row) => `${row.account}/${row.currency}`),
    ]);
    return [...keys].sort().map((key) => {
      const [account, currency] = key.split('/') as [string, string];
      const row = balances.find((item) => item.account === account && item.currency === currency);
      return { account, currency, bani: row?.bani ?? 0n, minor: row?.minor ?? 0n };
    });
  };
  const partyRows = await tx
    .select({ id: parties.id, taxId: parties.taxId, name: parties.name })
    .from(parties)
    .where(eq(parties.companyId, companyId));
  const party = new Map(partyRows.map((row) => [row.id, row]));
  const partners = new Map<string, BookPartner>();
  for (const item of at?.items ?? (await itemBalances(tx, companyId, date))) {
    if (item.bani === 0n && item.minor === 0n) continue;
    const key = `${item.partyId}/${item.account}/${item.currency}`;
    const known = partners.get(key);
    if (known) known.minor += item.minor;
    else
      partners.set(key, {
        partyId: item.partyId,
        taxId: party.get(item.partyId)?.taxId ?? null,
        name: party.get(item.partyId)?.name ?? item.partyId,
        account: item.account,
        currency: item.currency,
        minor: item.minor,
      });
  }
  const register = await assetsAt(tx, companyId, date);
  return {
    date,
    assets: register
      .filter(({ asset }) => !(asset.disposedOn && asset.disposedOn < date))
      .map(({ asset, impaired }) => ({
        id: asset.id,
        number: asset.number,
        name: asset.name,
        net: asset.value - depreciationAt(asset, date) - impaired,
      })),
    cash: desk('531'),
    bank: desk('512'),
    partners: [...partners.values()],
    stock: balances
      // Goods at retail price (G2) are counted at sale price by `retail.count`, not by these lists.
      .filter(
        (row) =>
          row.account.startsWith('3') &&
          row.currency === LEDGER_CURRENCY &&
          !retail.has(row.account),
      )
      .map((row) => ({ account: row.account, bani: row.bani })),
    ...(await stockRegisterAt(tx, companyId, date)),
  };
}

/** The stock register on a date, when it explains every stock account (G1): the count's stock is
 * then compared with it, and its differences are `inventory.stock`'s. */
async function stockRegisterAt(tx: Transaction, companyId: string, date: LocalDate) {
  if (!(await keepsRegister(tx, companyId))) return {};
  const accounts = await stockAccounts(tx, companyId, date);
  if (accounts.some((row) => row.outside !== 0n)) return {};
  const items = await tx.select().from(stockItems).where(eq(stockItems.companyId, companyId));
  const stores = await tx.select().from(warehouses).where(eq(warehouses.companyId, companyId));
  const itemOf = new Map(items.map((row) => [row.id, row]));
  const storeOf = new Map(stores.map((row) => [row.id, row]));
  const positions = (await stockPositions(tx, companyId, { date }))
    .filter((held) => held.quantity !== 0n || held.bani !== 0n)
    .map((held) => ({
      item: held.item,
      code: itemOf.get(held.item)!.code,
      name: itemOf.get(held.item)!.name,
      unit: itemOf.get(held.item)!.unit,
      account: held.account,
      warehouse: held.warehouse,
      warehouseCode: storeOf.get(held.warehouse)?.code ?? '',
      quantity: held.quantity,
      bani: held.bani,
    }));
  return {
    register: {
      positions,
      items: new Map(items.map((row) => [row.code, row])),
      warehouses: new Map(stores.map((row) => [row.code, row.id])),
    },
  };
}

/** The year's lists compared with the books on their date. */
export async function inventoryComparison(
  tx: Transaction,
  companyId: string,
  date: LocalDate,
  at?: BooksAt,
): Promise<{ lists: string[]; comparison: InventoryComparison }> {
  const year = (await yearsOf(tx, companyId)).find((item) => item.from <= date && date <= item.to);
  const lists = await listsOf(tx, companyId, date);
  const books = await inventoryBooks(tx, companyId, date, year?.from ?? date, at);
  return {
    lists: lists.map((list) => list.id),
    comparison: compareInventory(
      lists.map((list) => list.body),
      books,
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// The itemized closing snapshot

/** The closing of a year as its books stand: per account, open item and asset at its last day,
 * with what the next year carries. */
export async function closingSnapshot(
  tx: Transaction,
  companyId: string,
  year: Year,
): Promise<ClosingSnapshot> {
  const accounts = await accountBalances(tx, companyId, year.to);
  const items = await itemBalances(tx, companyId, year.to);
  const register = await assetsAt(tx, companyId, year.to);
  const profit = await loadState(tx, companyId, { profitPostings: true });
  const position = profit.loaded.profitPostings
    .map((posting) => posting.position as { kind?: string; year?: number; losses?: JsonValue })
    .filter(
      (item) =>
        item &&
        (item.kind === 'year' || item.kind === 'rectification') &&
        item.year === Number(year.to.slice(0, 4)),
    )
    .at(-1);
  const prorata = (await postingsOf(tx, companyId, ['vat.proRata'], year.from, year.to)).at(-1)
    ?.effect.explanation?.details?.definitive;
  const snapshot: ClosingSnapshot = {
    yearEnd: year.to,
    accounts: accounts.map((row) => ({
      account: row.account,
      currency: row.currency,
      bani: row.bani.toString(),
      minor: row.minor.toString(),
    })),
    items: items
      .filter((item) => item.bani !== 0n || item.minor !== 0n)
      .map((item) => ({
        id: item.id,
        account: item.account,
        partyId: item.partyId,
        currency: item.currency,
        bani: item.bani.toString(),
        minor: item.minor.toString(),
      })),
    assets: register
      .filter((row) => row.inUse)
      .map(({ asset, depreciated, impaired }) => ({
        id: asset.id,
        number: asset.number,
        account: asset.account,
        value: asset.value.toString(),
        depreciated: depreciated.toString(),
        impaired: impaired.toString(),
        fiscal: asset.fiscal?.version ?? null,
      })),
    carried: {
      losses: (position?.losses as JsonValue | undefined) ?? null,
      prorata: (prorata as JsonValue | undefined) ?? null,
    },
  };
  return canonicalSnapshot(snapshot);
}

/** Whether a year is locked: closed by a reviewed year close not followed by a reopening. The
 * close's request, with the snapshot its preview recorded. */
export async function yearLock(tx: Transaction, companyId: string, yearId: string) {
  const rows = await tx
    .select({
      operation: actionRequests.operation,
      input: actionRequests.input,
      preview: actionRequests.preview,
      requestId: actionRequests.id,
      at: sql<number>`${actionExecutions}.rowid`.mapWith(Number),
    })
    .from(actionRequests)
    .innerJoin(
      actionExecutions,
      and(
        eq(actionExecutions.companyId, actionRequests.companyId),
        eq(actionExecutions.requestId, actionRequests.id),
      ),
    )
    .where(
      and(
        eq(actionRequests.companyId, companyId),
        inArray(actionRequests.operation, ['years.close', 'years.reopen']),
        sql`json_extract(${actionRequests.input}, '$.financialYearId') = ${yearId}`,
      ),
    )
    .orderBy(asc(sql`${actionExecutions}.rowid`));
  const last = rows.at(-1);
  if (!last || last.operation !== 'years.close') return null;
  const preview = JSON.parse(last.preview) as { closing?: ClosingSnapshot };
  return { requestId: last.requestId, closing: preview.closing ?? null };
}

/**
 * A locked financial year that ends on or after `date`: a fixed asset commissioned or disposed
 * of then belongs to that year's register and to the snapshot its close recorded, so it is not
 * registered any more (`assets.register`, `assets.dispose`; the database refuses it too,
 * `inv:asset_locked_year`). Null when no locked year does.
 */
export async function lockedThrough(tx: Transaction, companyId: string, date: string) {
  for (const year of await yearsOf(tx, companyId))
    if (date <= year.to && (await yearLock(tx, companyId, year.id))) return year;
  return null;
}

// ---------------------------------------------------------------------------------------------
// The review of the year's last day

export interface ReviewItem {
  /** Stable within the year: the check and what it is about. */
  id: string;
  check: string;
  severity: 'block' | 'warn';
  message: string;
  details: { [key: string]: JsonValue };
  next: WorkStep[];
}

const employmentIn = async (tx: Transaction, companyId: string, year: Year) => {
  const [row] = await tx
    .select({ id: employmentTerms.contractId })
    .from(employmentTerms)
    .where(
      and(
        eq(employmentTerms.companyId, companyId),
        lte(employmentTerms.startDate, year.to),
        or(sql`${employmentTerms.endDate} is null`, gte(employmentTerms.endDate, year.from)),
      ),
    )
    .limit(1);
  return !!row;
};

async function answerOf<T>(
  tx: Transaction,
  companyId: string,
  request: {
    kind: string;
    subject: { kind: string; id: string };
    params: Record<string, JsonValue>;
  },
  schema: z.ZodType<T>,
) {
  const found = await standing(tx, companyId, request);
  if (!found.answered?.answer)
    return { value: null, open: found.open?.row.id ?? null, questionId: null };
  const parsed = schema.safeParse(JSON.parse(found.answered.answer.value));
  return {
    value: parsed.success ? parsed.data : null,
    open: null,
    questionId: found.answered.row.id,
  };
}

/** Everything the year's last day must hold before the year closes. */
export async function yearEndReview(
  tx: Transaction,
  companyId: string,
  year: Year,
  rules: RuleContext,
): Promise<ReviewItem[]> {
  const items: ReviewItem[] = [];
  const end = year.to as LocalDate;
  const facts = (await loadState(tx, companyId, { profile: true })).loaded.profile;
  const single = booksSystemOf(facts, end) === 'single';
  const push = (item: Omit<ReviewItem, 'id'> & { about: string }) => {
    const { about, ...rest } = item;
    items.push({ id: `${item.check}|${about}`, ...rest });
  };

  // The books at the year's last day, read once, with each account's movement in the year.
  const ledger = await ledgerAt(tx, companyId, end, year.from);
  const balances = balancesOf(ledger);
  const all = await itemBalances(tx, companyId, end);
  // The annual inventory (OMF nr. 2.861/2009 pct. 2, 4): its lists, what they leave out, and
  // the differences they found.
  const { lists, comparison } = await inventoryComparison(tx, companyId, end, {
    balances,
    items: all,
  });
  if (!lists.length)
    push({
      check: 'inventory.lists',
      about: 'lists',
      severity: 'block',
      message: `Inventarierea anuală la ${end} nu este înregistrată: transcrieți listele de inventariere semnate (documents.record, tipul inventory.list).`,
      details: { date: end },
      next: [agent('documents.record', { kind: inventoryDocumentKind })],
    });
  else
    for (const gap of comparison.gaps)
      push({
        check: 'inventory.lists',
        about: gap.message,
        severity: 'block',
        message: gap.message,
        details: { date: end, code: gap.code },
        next: [
          agent('documents.record', { kind: inventoryDocumentKind }),
          agent('inventory.compare', { date: end }),
        ],
      });
  for (const problem of comparison.unsupported)
    push({
      check: 'inventory.stock',
      about: problem.code,
      severity: 'block',
      message: `UNSUPPORTED: ${problem.message}`,
      details: { date: end, code: problem.code },
      next: [],
    });
  const bookable = comparison.differences.filter(
    (item) =>
      item.kind === 'cash' || item.kind === 'asset.missing' || item.kind === 'asset.surplus',
  );
  if (bookable.length) {
    if (single)
      push({
        check: 'inventory.differences',
        about: 'single',
        severity: 'block',
        message: `UNSUPPORTED: inventarierea a constatat diferențe (${bookable.length}), a căror înregistrare în partidă simplă nu este încă acoperită; se înregistrează în afara aplicației.`,
        details: { date: end, differences: bookable.map(differenceView) },
        next: [],
      });
    else if (!(await postingsOf(tx, companyId, ['inventory.differences'], end, end)).length)
      push({
        check: 'inventory.differences',
        about: 'unbooked',
        severity: 'block',
        message: `Inventarierea de la ${end} a constatat ${bookable.length} diferențe neînregistrate (${bookable
          .slice(0, 3)
          .map((item) => ('number' in item ? item.number : `${item.account} ${item.currency}`))
          .join(', ')}): propuneți inventory.differences cu decizia administratorului.`,
        details: { date: end, differences: bookable.map(differenceView) },
        next: [propose('inventory.differences', { date: end, documentIds: lists })],
      });
  }
  // The stock register's differences (G1): booked by `inventory.stock` on the count's date.
  const counted = comparison.differences.filter((item) => item.kind === 'stock');
  if (
    counted.length &&
    !single &&
    !(await postingsOf(tx, companyId, ['inventory.stock'], end, end)).length
  )
    push({
      check: 'inventory.differences',
      about: 'stock',
      severity: 'block',
      message: `Inventarierea de la ${end} a constatat ${counted.length} diferențe de stoc neînregistrate: propuneți inventory.stock cu decizia administratorului și cauza fiecărei lipse.`,
      details: { date: end, differences: counted.map(differenceView) },
      next: [propose('inventory.stock', { date: end, documentIds: lists })],
    });
  const impaired = comparison.differences.filter((item) => item.kind === 'asset.impaired');
  if (impaired.length && !single) {
    const booked = new Set(
      (await postingsOf(tx, companyId, ['impairment.assets'], end, end)).flatMap((posting) =>
        ((posting.effect.explanation?.details?.assets ?? []) as { asset?: string }[]).map(
          (row) => row.asset,
        ),
      ),
    );
    const missing = impaired.filter((item) => !booked.has(item.number));
    if (missing.length)
      push({
        check: 'inventory.differences',
        about: 'impaired',
        severity: 'block',
        message: `Listele de inventariere evaluează ${missing.map((item) => item.number).join(', ')} sub valoarea contabilă: înregistrați ajustarea (impairment.assets).`,
        details: { date: end, differences: missing.map(differenceView) },
        next: [
          propose('impairment.assets', {
            date: end,
            assets: missing.flatMap((item) =>
              item.kind === 'asset.impaired'
                ? [{ assetId: item.assetId, value: lei(item.value) }]
                : [],
            ),
          }),
        ],
      });
  }
  for (const item of comparison.differences)
    if (item.kind === 'bank')
      push({
        check: 'inventory.differences',
        about: `bank:${item.account}/${item.currency}`,
        severity: 'block',
        message: `Soldul contului ${item.account} (${money(item.book, item.currency)} ${item.currency}) diferă de extrasul de la ${end} (${money(item.confirmed, item.currency)}): registrele urmează extrasele; găsiți mișcarea lipsă.`,
        details: differenceView(item) as { [key: string]: JsonValue },
        next: [agent('bank.import'), agent('bank.recordStatement')],
      });
    else if (item.kind === 'partner')
      push({
        check: 'inventory.partners',
        about: `${item.partyId ?? item.name}/${item.account}/${item.currency}`,
        severity: 'warn',
        message:
          item.status === 'no_reply'
            ? `${item.name} nu a confirmat soldul de ${money(item.book, item.currency)} ${item.currency} din ${item.account} (pct. 28): cereți din nou confirmarea.`
            : `${item.name} confirmă ${item.confirmed === null ? '—' : money(item.confirmed, item.currency)} ${item.currency} în ${item.account}, registrele arată ${money(item.book, item.currency)}${item.status === 'disputed' ? ' (contestat)' : ''}: diferența se lămurește cu documentele, nu se înregistrează din listă.`,
        details: differenceView(item) as { [key: string]: JsonValue },
        next: [agent('inventory.compare', { date: end })],
      });

  if (single) return items;

  // Impairment of receivables (pct. 89, 332, 353), under the company's policy.
  const receivables = all.filter(
    (item) => item.kind === 'receivable' && item.account.startsWith('411') && item.bani > 0n,
  );
  const overdue = receivables.filter((item) => (item.dueDate ?? item.originDate) < end);
  const policy = facts
    .filter((fact) => fact.axis === 'policy.impairment.receivables' && fact.effectiveFrom <= end)
    .at(-1)?.value;
  const tagged491 = (await taggedBalances(tx, companyId, ['491'], end)).filter(
    (row) => row.bani !== 0n,
  );
  if (overdue.length && !policy)
    push({
      check: 'impairment.receivables',
      about: 'policy',
      severity: 'block',
      message: `${overdue.length} creanțe sunt restante la ${end}, iar politica de testare a creanțelor pentru depreciere nu este înregistrată (policy.impairment.receivables).`,
      details: { yearEnd: end, overdue: overdue.length },
      next: [
        ask(
          'profile.fact',
          { kind: 'profile', id: 'policy.impairment.receivables' },
          {
            axis: 'policy.impairment.receivables',
          },
        ),
      ],
    });
  else if (policy && (impairmentPolicies as readonly string[]).includes(policy)) {
    const days = policyDays(policy as (typeof impairmentPolicies)[number]);
    const parties = [...new Set(receivables.map((item) => item.partyId))].sort();
    let needed = tagged491.length > 0;
    let pending = false;
    for (const partyId of parties) {
      const tested = receivables.some(
        (item) =>
          item.partyId === partyId &&
          daysBetween((item.dueDate ?? item.originDate) as LocalDate, end) > days,
      );
      const request = {
        kind: 'receivable.collectibility',
        subject: { kind: 'party', id: partyId },
        params: { yearEnd: end },
      };
      const answer = await answerOf(tx, companyId, request, collectibilityAnswer);
      if (answer.value && answer.value.status !== 'collectible') needed = true;
      if (tested && !answer.value) {
        pending = true;
        push({
          check: 'impairment.receivables',
          about: `party:${partyId}`,
          severity: 'block',
          message: `Creanțele partenerului ${partyId} sunt restante de peste ${days} de zile la ${end}: întrebați cât de încasabile sunt (receivable.collectibility).`,
          details: { yearEnd: end, partyId, policy },
          next: [ask(request.kind, request.subject, request.params), human('questions.answer')],
        });
      }
    }
    if (
      needed &&
      !pending &&
      !(await postingsOf(tx, companyId, ['impairment.receivables'], end, end)).length
    )
      push({
        check: 'impairment.receivables',
        about: 'unbooked',
        severity: 'block',
        message: `Răspunsurile despre creanțe cer ajustări pentru depreciere la ${end} pe care nicio înregistrare nu le cuprinde: propuneți impairment.receivables, citând răspunsurile.`,
        details: { yearEnd: end },
        next: [propose('impairment.receivables', { yearEnd: end })],
      });
  }

  // Provisions (pct. 335, 338, 369–388): the untaken leave of an employer, and the review of
  // the obligations at the year's end.
  const yearNumber = Number(end.slice(0, 4));
  const provisions = (await taggedBalances(tx, companyId, ['151', '428'], end)).filter((row) =>
    row.item.startsWith('provision:'),
  );
  const held = (tag: string) =>
    provisions.filter((row) => row.item === tag).reduce((sum, row) => sum + row.bani, 0n);
  if (await employmentIn(tx, companyId, year)) {
    const request = {
      kind: 'leave.untaken',
      subject: { kind: 'company', id: 'company' },
      params: { year: yearNumber },
    };
    const answer = await answerOf(tx, companyId, request, untakenLeaveAnswer);
    const tag = provisionTag('leave', `concedii-${yearNumber}`);
    if (!answer.value)
      push({
        check: 'provisions',
        about: 'leave',
        severity: 'block',
        message: `Concediile de odihnă neefectuate la ${end} nu sunt stabilite: întrebați (leave.untaken).`,
        details: { year: yearNumber },
        next: [ask(request.kind, request.subject, request.params), human('questions.answer')],
      });
    else {
      const target =
        parseMoney(answer.value.amount, LEDGER_CURRENCY) +
        parseMoney(answer.value.contributions, LEDGER_CURRENCY);
      if (held(tag) !== target)
        push({
          check: 'provisions',
          about: 'leave.unbooked',
          severity: 'block',
          message: `Concediile neefectuate la ${end} sunt ${lei(target)} lei; registrele țin ${lei(held(tag))} lei: propuneți provisions.record (leave), citând răspunsul.`,
          details: { year: yearNumber, target: lei(target), held: lei(held(tag)) },
          next: [
            propose('provisions.record', {
              date: end,
              kind: 'leave',
              reference: `concedii-${yearNumber}`,
              amount: lei(target),
            }),
          ],
        });
    }
    for (const row of provisions)
      if (row.item.startsWith('provision:leave:') && row.item !== tag && row.bani !== 0n)
        push({
          check: 'provisions',
          about: `stale:${row.item}`,
          severity: 'block',
          message: `${row.item.slice('provision:leave:'.length)} are încă ${lei(row.bani)} lei la ${end}: concediile unui an anterior se reiau pe măsura efectuării lor (provisions.record cu suma 0).`,
          details: { item: row.item, held: lei(row.bani) },
          next: [
            propose('provisions.record', {
              date: end,
              kind: 'leave',
              reference: row.item.slice('provision:leave:'.length),
              amount: '0.00',
            }),
          ],
        });
  }
  {
    const request = {
      kind: 'provisions.review',
      subject: { kind: 'company', id: 'company' },
      params: { year: yearNumber },
    };
    const answer = await answerOf(tx, companyId, request, provisionReviewAnswer);
    if (!answer.value)
      push({
        check: 'provisions',
        about: 'review',
        severity: 'block',
        message: `Obligațiile de la ${end} pentru care se constituie provizioane (procese, garanții, prime, altele) nu sunt analizate: întrebați (provisions.review).`,
        details: { year: yearNumber },
        next: [ask(request.kind, request.subject, request.params), human('questions.answer')],
      });
    else {
      const listed = 'obligations' in answer.value ? answer.value.obligations : [];
      for (const obligation of listed) {
        const tag = provisionTag(obligation.kind, obligation.reference);
        const target = parseMoney(obligation.amount, LEDGER_CURRENCY);
        if (held(tag) !== target)
          push({
            check: 'provisions',
            about: `unbooked:${tag}`,
            severity: 'block',
            message: `${obligation.kind} ${obligation.reference}: estimarea de la ${end} este ${lei(target)} lei, provizionul ține ${lei(held(tag))} lei: propuneți provisions.record.`,
            details: { tag, target: lei(target), held: lei(held(tag)) },
            next: [
              propose('provisions.record', {
                date: end,
                kind: obligation.kind,
                reference: obligation.reference,
                amount: lei(target),
                evidenceId: obligation.evidenceId,
              }),
            ],
          });
      }
      for (const row of provisions) {
        if (row.item.startsWith('provision:leave:') || row.bani === 0n) continue;
        const [, kind, reference] = row.item.split(':') as [string, string, string];
        if (!listed.some((item) => item.kind === kind && item.reference === reference))
          push({
            check: 'provisions',
            about: `unlisted:${row.item}`,
            severity: 'block',
            message: `Provizionul ${kind} ${reference} (${lei(row.bani)} lei) nu mai apare în analiza obligațiilor de la ${end}: anulați-l (provisions.record cu suma 0) sau revizuiți analiza.`,
            details: { tag: row.item, held: lei(row.bani) },
            next: [propose('provisions.record', { date: end, kind, reference, amount: '0.00' })],
          });
      }
    }
  }

  // The cut-off of the year's last day.
  const accruals = all.filter(
    (item) =>
      (item.kind === 'accrual.payable' || item.kind === 'accrual.receivable') && item.bani !== 0n,
  );
  if (accruals.length)
    push({
      check: 'cutoff',
      about: 'accruals',
      severity: 'warn',
      message: `${accruals.length} servicii înregistrate pe 408 sau 418 rămân deschise la ${end}: verificați că facturile lor nu au sosit sau nu au fost emise în exercițiu.`,
      details: {
        items: accruals.map((item) => ({
          id: item.id,
          account: item.account,
          partyId: item.partyId,
          balance: lei(item.bani),
        })),
      },
      next: [propose('accruals.settle')],
    });
  const deferrals = all.filter(
    (item) =>
      (item.kind === 'deferral.expense' || item.kind === 'deferral.revenue') && item.bani !== 0n,
  );
  if (deferrals.length) {
    const state = await loadState(tx, companyId, {
      openItems: [{ ids: deferrals.map((item) => item.id), schedules: true }],
    });
    const off = deferrals.flatMap((item) => {
      const schedule = state.loaded.openItems.get(item.id)?.schedule;
      const later = (schedule?.rows ?? [])
        .filter((row) => row.due > end)
        .reduce((sum, row) => sum + row.bani, 0n);
      const balance = item.minor < 0n ? -item.minor : item.minor;
      return balance !== later
        ? [{ id: item.id, account: item.account, balance: lei(balance), later: lei(later) }]
        : [];
    });
    if (off.length)
      push({
        check: 'cutoff',
        about: 'deferrals',
        severity: 'block',
        message: `${off.length} sume în avans (471, 472) nu sunt la partea exercițiilor următoare la ${end}: reluați ce privește exercițiul (deferrals.release).`,
        details: { items: off },
        next: [propose('deferrals.release', { month: end.slice(0, 7) })],
      });
  }
  // Every foreign-currency monetary item and treasury balance at the closing rate (pct. 94,
  // 325); a currency balance fx.revalue does not reach is named.
  const treasury = new Set(
    (
      await tx
        .select({ account: treasuryAccounts.ledgerAccount })
        .from(treasuryAccounts)
        .where(eq(treasuryAccounts.companyId, companyId))
    ).map((row) => row.account),
  );
  const foreignItems = all.filter(
    (item) => item.currency !== LEDGER_CURRENCY && monetaryKinds.has(item.kind as never),
  );
  const currencies = [
    ...new Set([
      ...foreignItems.map((item) => item.currency),
      ...balances.filter((row) => row.currency !== LEDGER_CURRENCY).map((row) => row.currency),
    ]),
  ].sort();
  if (currencies.length) {
    const rates = await loadState(tx, companyId, {
      fx: currencies.map((currency) => ({ currency, until: end })),
      profile: true,
    });
    const off: JsonValue[] = [];
    const rateOf = (currency: string) => {
      try {
        const rate = selectRate(rates.loaded as Loaded, rules, currency, end, 'accounting');
        return 'code' in rate ? null : rate;
      } catch (error) {
        if (error instanceof RuleGapError) return null;
        throw error;
      }
    };
    const check = (what: string, currency: string, bani: bigint, minor: bigint) => {
      const rate = rateOf(currency);
      if (!rate) {
        off.push({ what, currency, problem: 'rate' });
        return;
      }
      const expected = convertMinor(minor, currency as never, {
        rate: rate.rate,
        multiplier: rate.multiplier,
      });
      if (expected !== bani) off.push({ what, currency, books: lei(bani), closing: lei(expected) });
    };
    for (const item of foreignItems)
      check(`${item.account}:${item.id}`, item.currency, item.bani, item.minor);
    const uncovered: string[] = [];
    // Monetary balances without partners: treasury accounts, and the other cash equivalents
    // and deposits (5x, 267: pct. 326 lit. b)); non-monetary ones (assets, revenue) stay at their
    // historical rate (pct. 94 lit. c)).
    for (const row of balances.filter((item) => item.currency !== LEDGER_CURRENCY)) {
      if (treasury.has(row.account)) check(row.account, row.currency, row.bani, row.minor);
      else if (
        /^(5|267)/.test(row.account) &&
        !all.some((item) => item.account === row.account && item.currency === row.currency)
      )
        uncovered.push(`${row.account} (${row.currency})`);
    }
    if (off.length)
      push({
        check: 'cutoff',
        about: 'fx',
        severity: 'block',
        message: `${off.length} poziții monetare în valută nu sunt la cursul BNR de la ${end} (OMFP nr. 1.802/2014 pct. 94): reevaluați la sfârșitul exercițiului (fx.revalue), după ultima înregistrare a anului.`,
        details: { items: off },
        next: [propose('fx.revalue', { date: end })],
      });
    if (uncovered.length)
      push({
        check: 'cutoff',
        about: 'fx.uncovered',
        severity: 'block',
        message: `UNSUPPORTED: soldurile în valută din ${uncovered.join(', ')} nu sunt nici pe parteneri, nici conturi de trezorerie, iar fx.revalue nu le reevaluează (depozite, sume în curs de decontare); se reevaluează în afara aplicației.`,
        details: { accounts: uncovered },
        next: [],
      });
  }
  // e-Factura invoices dated in the year and not booked.
  const unbooked = await tx
    .select({ id: documents.id, number: documents.number, date: documents.docDate })
    .from(documents)
    .where(
      and(
        eq(documents.companyId, companyId),
        eq(documents.authority, 'efactura'),
        inArray(documents.kind, Object.values(invoiceKinds)),
        gte(documents.docDate, year.from),
        lte(documents.docDate, year.to),
        sql`not exists (select 1 from ${proposals} p join ${entries} e
          on e.company_id = p.company_id and e.proposal_id = p.id
          where p.company_id = ${documents.companyId}
            and p.subject_key = 'document:' || coalesce((select g.to_id from ${documentLinks} g
              where g.company_id = ${documents.companyId} and g.from_id = ${documents.id}
                and g.kind in ('same_as', 'same_as_confirmed') limit 1), ${documents.id})
            and ${entryStands('e')})`,
        sql`not exists (select 1 from ${dispositions} d where d.company_id = ${documents.companyId}
          and d.subject_kind = 'document' and d.subject_id = ${documents.id}
          and d.disposition = 'no_booking')`,
      ),
    )
    .orderBy(asc(documents.docDate), asc(documents.id))
    .limit(51);
  if (unbooked.length)
    push({
      check: 'cutoff',
      about: 'spv',
      severity: 'block',
      message: `${unbooked.length > 50 ? 'Peste 50' : unbooked.length} facturi din SPV datate în ${yearNumber} nu sunt înregistrate: înregistrați-le în exercițiu (sau, pentru un serviciu al exercițiului facturat ulterior, pe 408/418).`,
      details: { documents: unbooked.slice(0, 50).map((row) => row.id) },
      next: [propose('invoices.recognize')],
    });
  const [movements] = await tx
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(bankMovements)
    .where(
      and(
        eq(bankMovements.companyId, companyId),
        gte(bankMovements.bookingDate, year.from),
        lte(bankMovements.bookingDate, year.to),
        sql`not exists (select 1 from ${proposals} p where p.company_id = ${bankMovements.companyId}
          and p.subject_key = 'movement:' || ${bankMovements.id} and ${holdsSubject('p')})`,
      ),
    );
  if (movements && movements.count > 0)
    push({
      check: 'cutoff',
      about: 'bank',
      severity: 'block',
      message: `${movements.count} mișcări bancare din ${yearNumber} nu sunt explicate.`,
      details: { count: movements.count },
      next: [propose('bank.settle')],
    });

  // The result and its tax: the year's profit tax, then the closing journal.
  if (
    facts.filter((fact) => fact.axis === 'income_tax' && fact.effectiveFrom <= end).at(-1)
      ?.value === 'profit'
  ) {
    const annual = await postingsOf(tx, companyId, ['tax.profit'], end, end);
    if (!annual.some((posting) => String(posting.input.period) === String(yearNumber)))
      push({
        check: 'result',
        about: 'profit',
        severity: 'block',
        message: `Impozitul pe profit al anului ${yearNumber} nu este calculat (tax.profit, perioada ${yearNumber}), înaintea închiderii conturilor de rezultat; ajustările și provizioanele se stabilesc înaintea lui (OMFP nr. 1.802/2014 pct. 388 alin. (3)).`,
        details: { year: yearNumber },
        next: [
          propose('tax.profit', { period: String(yearNumber), date: end }),
          agent('yearend.profitDeterminations', { year: yearNumber }),
        ],
      });
  }
  // The year's own revenue and expenses, as the closing journal closes them: their movement in
  // the year, from the books read above.
  const moved = new Map<string, bigint>();
  for (const row of ledger)
    if (row.account.startsWith('6') || row.account.startsWith('7'))
      moved.set(row.account, (moved.get(row.account) ?? 0n) + row.moved);
  const result = [...moved]
    .filter(([, bani]) => bani !== 0n)
    .map(([account, bani]) => ({ account, bani }));
  if (result.length)
    push({
      check: 'result',
      about: 'close',
      severity: 'block',
      message: `Conturile de venituri și cheltuieli au sold la ${end} (${result.length}): închideți-le în contul 121 (year.closeResult).`,
      details: { accounts: result.map((row) => row.account) },
      next: [propose('year.closeResult', { yearEnd: end })],
    });
  return items;
}

// ---------------------------------------------------------------------------------------------
// The reviewed year close and reopening

async function monthsOpen(tx: Transaction, companyId: string, year: Year) {
  const months = await tx
    .selectDistinct({ period: entries.period })
    .from(entries)
    .where(
      and(
        eq(entries.companyId, companyId),
        gte(entries.period, year.from.slice(0, 7)),
        lte(entries.period, year.to.slice(0, 7)),
      ),
    );
  const open: string[] = [];
  for (const { period } of months.sort((a, b) => (a.period < b.period ? -1 : 1))) {
    const [event] = await tx
      .select({ kind: periodEvents.kind })
      .from(periodEvents)
      .where(and(eq(periodEvents.companyId, companyId), eq(periodEvents.month, period)))
      .orderBy(desc(periodEvents.seq))
      .limit(1);
    if (event?.kind !== 'close') open.push(period);
  }
  // The year's last month itself, entries or not, closes before the year.
  const last = year.to.slice(0, 7);
  if (!months.some((row) => row.period === last)) {
    const [event] = await tx
      .select({ kind: periodEvents.kind })
      .from(periodEvents)
      .where(and(eq(periodEvents.companyId, companyId), eq(periodEvents.month, last)))
      .orderBy(desc(periodEvents.seq))
      .limit(1);
    if (event?.kind !== 'close') open.push(last);
  }
  return open;
}

/**
 * The year close: a reviewed action whose preview is the year-end review (each item blocks or
 * warns as the review says),
 * the months left open and the itemized closing snapshot. Executing it locks the year: the
 * database refuses any entry dated in it and the reopening of its months (`inv:closed_year`),
 * until a reviewed reopening. The next year's opening is checked against the snapshot.
 */
export function yearCloseHandler(
  rules: (tx: Transaction, companyId: string) => Promise<RuleContext>,
): ActionHandler<z.infer<typeof yearInput>> {
  return {
    operation: 'years.close',
    permission: 'review',
    input: yearInput,
    async preview(tx, companyId, input) {
      const year = await yearById(tx, companyId, input.financialYearId);
      const findings: Finding[] = [];
      if (await yearLock(tx, companyId, year.id))
        findings.push({
          code: 'YEAR_CLOSED',
          severity: 'block',
          message: 'Exercițiul este deja închis.',
        });
      const before = (await yearsOf(tx, companyId)).filter((item) => item.to < year.from);
      for (const earlier of before)
        if (
          !(await yearLock(tx, companyId, earlier.id)) &&
          (
            await tx
              .select({ id: entries.id })
              .from(entries)
              .where(
                and(
                  eq(entries.companyId, companyId),
                  gte(entries.date, earlier.from),
                  lte(entries.date, earlier.to),
                ),
              )
              .limit(1)
          ).length
        )
          findings.push({
            code: 'EARLIER_YEAR_OPEN',
            severity: 'block',
            message: `Închideți întâi exercițiul ${earlier.from} – ${earlier.to}.`,
          });
      const open = await monthsOpen(tx, companyId, year);
      if (open.length)
        findings.push({
          code: 'MONTHS_OPEN',
          severity: 'block',
          message: 'Lunile exercițiului se închid înaintea exercițiului.',
          count: open.length,
          items: open,
        });
      // The review's items, each as it stands: what blocks blocks the close; a partner that did
      // not confirm its balance is a warning the approver sees.
      for (const item of await yearEndReview(tx, companyId, year, await rules(tx, companyId)))
        findings.push({
          code: `YEAR_END_${item.check.replace(/\W+/g, '_').toUpperCase()}`,
          severity: item.severity,
          message: item.message,
        });
      const closing = await closingSnapshot(tx, companyId, year);
      return {
        blocking: findings.some((finding) => finding.severity === 'block'),
        preview: {
          year: { id: year.id, from: year.from, to: year.to },
          findings: findings as unknown as JsonValue,
          snapshot: {
            hash: snapshotHash(closing),
            accounts: closing.accounts.length,
            items: closing.items.length,
            assets: closing.assets.length,
          },
          closing: closing as unknown as JsonValue,
        },
      };
    },
    async execute(_tx, _actor, input, _requestId, preview) {
      const shown = preview as { year: Year; snapshot: { hash: string } };
      return {
        financialYearId: input.financialYearId,
        yearEnd: shown.year.to,
        snapshotHash: shown.snapshot.hash,
      };
    },
  };
}

/** Reopening a closed year: a reviewed action with its reason, before the year's annual
 * statements are filed; after that a correction is a prior-year correction (1174). */
export const yearReopenHandler: ActionHandler<z.infer<typeof reopenYearInput>> = {
  operation: 'years.reopen',
  permission: 'review',
  input: reopenYearInput,
  async preview(tx, companyId, input) {
    const year = await yearById(tx, companyId, input.financialYearId);
    const findings: Finding[] = [];
    if (!(await yearLock(tx, companyId, year.id)))
      findings.push({
        code: 'YEAR_OPEN',
        severity: 'block',
        message: 'Exercițiul nu este închis.',
      });
    for (const later of (await yearsOf(tx, companyId)).filter((item) => item.from > year.to))
      if (await yearLock(tx, companyId, later.id))
        findings.push({
          code: 'LATER_YEAR_CLOSED',
          severity: 'block',
          message: `Redeschideți întâi exercițiul ${later.from} – ${later.to}.`,
        });
    const filed = await tx
      .select({ id: artifacts.id })
      .from(artifacts)
      .innerJoin(
        artifactEvents,
        and(
          eq(artifactEvents.companyId, artifacts.companyId),
          eq(artifactEvents.artifactId, artifacts.id),
        ),
      )
      .where(
        and(
          eq(artifacts.companyId, companyId),
          inArray(artifacts.kind, ['S1005', 'S1003', 'S1046']),
          eq(artifacts.period, year.to.slice(0, 4)),
          inArray(artifactEvents.state, ['submitted', 'accepted']),
        ),
      )
      .limit(1);
    if (filed.length)
      findings.push({
        code: 'STATEMENTS_FILED',
        severity: 'block',
        message:
          'Situațiile financiare ale exercițiului sunt depuse: o eroare se corectează în exercițiul curent, pe rezultatul reportat (correction.priorYear).',
      });
    return {
      blocking: findings.length > 0,
      preview: {
        year: { id: year.id, from: year.from, to: year.to },
        reason: input.reason,
        findings: findings as unknown as JsonValue,
      },
    };
  },
  async execute(_tx, _actor, input) {
    return { financialYearId: input.financialYearId, reopened: true };
  },
};

// ---------------------------------------------------------------------------------------------
// The opening of the next year

/** The opening of a year checked against its previous year's close: null when the previous year
 * is not kept or not closed. */
export async function openingCheck(tx: Transaction, companyId: string, year: Year) {
  const previous = (await yearsOf(tx, companyId)).filter((item) => item.to < year.from).at(-1);
  if (!previous || addDays(previous.to as LocalDate, 1) !== year.from) return null;
  const lock = await yearLock(tx, companyId, previous.id);
  if (!lock?.closing) return { previous, closed: false as const };
  const now = await closingSnapshot(tx, companyId, previous);
  const differences = snapshotDifferences(lock.closing, now);
  // An opening entry (DESCHIDERE) at the year's start, when the books keep the previous year,
  // would count the balances twice.
  const openings = await tx
    .select({ id: entries.id })
    .from(entries)
    .where(
      and(
        eq(entries.companyId, companyId),
        eq(entries.journalCode, 'DESCHIDERE'),
        gte(entries.date, year.from),
        lte(entries.date, year.to),
        entryStands('"acc_entries"'),
        // A storno of one keeps its journal; it is not an opening.
        sql`not exists (select 1 from ${proposals} p where p.company_id = ${entries.companyId}
          and p.id = ${entries.proposalId} and p.subject_key like 'reverse:%')`,
      ),
    );
  return {
    previous,
    closed: true as const,
    snapshotHash: snapshotHash(lock.closing),
    differences,
    openings: openings.map((row) => row.id),
  };
}

// ---------------------------------------------------------------------------------------------
// Reads, close checks and the worklist

export const profitDeterminationsInput = z
  .object({ year: z.number().int().min(2000).max(2100) })
  .strict();

export class YearEnd {
  constructor(
    private readonly commands: Commands,
    private readonly rules: (tx: Transaction, companyId: string) => Promise<RuleContext>,
  ) {}

  /** The year's inventory lists against the books on their date. */
  compare(actor: Actor, input: z.infer<typeof compareInput>) {
    return this.commands.read(actor, 'inventory.compare', async (tx) => {
      const { lists, comparison } = await inventoryComparison(tx, actor.companyId, input.date);
      return {
        date: input.date,
        lists,
        sections: comparison.sections,
        differences: comparison.differences.map(differenceView),
        gaps: comparison.gaps,
        unsupported: comparison.unsupported.map(({ code, message }) => ({ code, message })),
      };
    });
  }

  /** What the year-end still waits on, for a financial year. */
  review(actor: Actor, input: z.infer<typeof yearInput>) {
    return this.commands.read(actor, 'yearend.review', async (tx) => {
      const year = await yearById(tx, actor.companyId, input.financialYearId);
      const items = await yearEndReview(
        tx,
        actor.companyId,
        year,
        await this.rules(tx, actor.companyId),
      );
      return {
        year,
        closed: !!(await yearLock(tx, actor.companyId, year.id)),
        items: items.map(({ next: _, ...item }) => item),
        next: null,
      };
    });
  }

  /** The opening of a year against its previous year's close. */
  opening(actor: Actor, input: z.infer<typeof openingInput>) {
    return this.commands.read(actor, 'years.opening', async (tx) => {
      const year = await yearById(tx, actor.companyId, input.financialYearId);
      const check = await openingCheck(tx, actor.companyId, year);
      if (!check)
        return {
          year,
          previous: null,
          closed: false,
          matches: null,
          differences: [],
          openings: [],
        };
      if (!check.closed)
        return {
          year,
          previous: check.previous,
          closed: false,
          matches: null,
          differences: [],
          openings: [],
        };
      return {
        year,
        previous: check.previous,
        closed: true,
        snapshotHash: check.snapshotHash,
        matches: check.differences.length === 0 && check.openings.length === 0,
        differences: check.differences as unknown as JsonValue[],
        openings: check.openings,
      };
    });
  }

  /**
   * What the year's impairments and provisions tell the profit tax (art. 26): the deductible parts
   * their postings computed, and the reversals of parts not deducted (art. 23 lit. d)), as
   * `tax.profit`'s `determinations`.
   */
  profitDeterminations(actor: Actor, input: z.infer<typeof profitDeterminationsInput>) {
    return this.commands.read(actor, 'yearend.profitDeterminations', async (tx) => {
      const from = `${input.year}-01-01`;
      const to = `${input.year}-12-31`;
      const kinds = ['impairment.receivables', 'impairment.assets', 'provisions.record'];
      const all = await postingsOf(tx, actor.companyId, kinds, '1900-01-01', to);
      // What each item's earlier postings deducted, to tell a reversal's taxable part.
      const deducted = new Map<string, bigint>();
      const constituted = new Map<string, bigint>();
      const items: JsonValue[] = [];
      const bani = (text: string) => BigInt(Math.round(Number(text) * 100));
      for (const posting of all) {
        const notes = (posting.effect.explanation?.details?.profit ??
          []) as unknown as ProfitNote[];
        const inYear = posting.date >= from;
        for (const note of notes) {
          deducted.set(note.item, (deducted.get(note.item) ?? 0n) + bani(note.amount));
          if (inYear)
            items.push({
              account: note.account,
              rule: note.rule,
              amount: note.amount,
              clause: note.clause,
              evidenceId: String(posting.input.evidenceId ?? ''),
              entryId: posting.entryId,
            });
        }
        // The reversals of the year: the share of each item's allowance never deducted is not
        // taxable (art. 23 lit. d)).
        const lineRows = (posting.effect.lines ?? []) as {
          account: string;
          side: 'D' | 'C';
          bani: string | number;
          analytics?: { item?: string };
        }[];
        for (const line of lineRows) {
          const tag = line.analytics?.item;
          if (!tag || !/^(491|29|151|428)/.test(line.account)) continue;
          const amount = BigInt(String(line.bani));
          const up = line.side === 'C';
          const key = tag.startsWith('impairment:') ? tag.slice('impairment:'.length) : tag;
          if (up) constituted.set(key, (constituted.get(key) ?? 0n) + amount);
          else {
            const held = constituted.get(key) ?? 0n;
            const fromDeducted = deducted.get(key) ?? 0n;
            const nondeducted = held > fromDeducted ? held - fromDeducted : 0n;
            const exempt = amount < nondeducted ? amount : nondeducted;
            constituted.set(key, held - amount);
            if (inYear && exempt > 0n && !/^428/.test(line.account))
              items.push({
                account:
                  posting.treatmentId === 'impairment.receivables'
                    ? '7814'
                    : posting.treatmentId === 'impairment.assets'
                      ? '7813'
                      : '7812',
                rule: 'nontaxable',
                amount: lei(exempt),
                clause: 'art.23(d)',
                evidenceId: String(posting.input.evidenceId ?? ''),
                entryId: posting.entryId,
              });
          }
        }
      }
      return { year: input.year, items, next: null };
    });
  }
}

/** The close checks of the year-end: the review shown at the year's last month (warnings: the
 * year close is the gate), and the opening checked against the previous year's close. */
export function yearEndChecks(
  rules: (tx: Transaction, companyId: string) => Promise<RuleContext>,
): CloseCheck[] {
  return [
    {
      id: 'yearend.review',
      async run(tx, companyId, month) {
        const year = (await yearsOf(tx, companyId)).find((item) => item.to.slice(0, 7) === month);
        if (!year) return [];
        const items = await yearEndReview(tx, companyId, year, await rules(tx, companyId));
        const blocking = items.filter((item) => item.severity === 'block');
        return blocking.length
          ? [
              {
                code: 'YEAR_END_REVIEW',
                severity: 'warn' as const,
                message: `Sfârșitul exercițiului așteaptă ${blocking.length} elemente (yearend.review): închiderea exercițiului le cere pe toate.`,
                count: blocking.length,
                items: blocking.slice(0, 20).map((item) => item.id),
              },
            ]
          : [];
      },
    },
    {
      id: 'yearend.opening',
      async run(tx, companyId, month) {
        const year = (await yearsOf(tx, companyId)).find(
          (item) => item.from.slice(0, 7) <= month && month <= item.to.slice(0, 7),
        );
        if (!year) return [];
        const check = await openingCheck(tx, companyId, year);
        if (!check?.closed) return [];
        const findings: Finding[] = [];
        if (check.differences.length)
          findings.push({
            code: 'YEAR_OPENING_DIFFERS',
            severity: 'block',
            message: `Deschiderea exercițiului diferă de închiderea exercițiului ${check.previous.from} – ${check.previous.to} la ${check.differences.length} poziții.`,
            count: check.differences.length,
            items: check.differences.slice(0, 20).map((item) => `${item.section}:${item.id}`),
          });
        if (check.openings.length)
          findings.push({
            code: 'YEAR_OPENING_DUPLICATE',
            severity: 'block',
            message:
              'O notă de deschidere (DESCHIDERE) dublează soldurile preluate din exercițiul precedent ținut în registre: stornați-o.',
            count: check.openings.length,
            items: check.openings,
          });
        return findings;
      },
    },
  ];
}

/** The worklist's year-end items: from the year's last month until the year is closed. */
export async function yearEndWork(
  tx: Transaction,
  companyId: string,
  today: LocalDate,
  rules: RuleContext,
): Promise<YearEndWorkItem[]> {
  const work: YearEndWorkItem[] = [];
  for (const year of await yearsOf(tx, companyId)) {
    if (today.slice(0, 7) < year.to.slice(0, 7)) continue;
    if (await yearLock(tx, companyId, year.id)) {
      const next = (await yearsOf(tx, companyId)).find((item) => item.from > year.to);
      if (next) {
        const check = await openingCheck(tx, companyId, next);
        if (check?.closed && (check.differences.length || check.openings.length))
          work.push({
            subject: { kind: 'yearend', id: `opening|${next.id}` },
            severity: 'block',
            period: next.from.slice(0, 4),
            message: `Deschiderea exercițiului ${next.from} – ${next.to} nu este închiderea exercițiului precedent (${check.differences.length} poziții, ${check.openings.length} note de deschidere).`,
            details: {
              check: 'year.opening',
              differences: check.differences.length,
              openings: check.openings,
            },
            next: [agent('years.opening', { financialYearId: next.id })],
          });
      }
      continue;
    }
    // A year that ended long ago and never had entries asks nothing.
    const [any] = await tx
      .select({ id: entries.id })
      .from(entries)
      .where(
        and(
          eq(entries.companyId, companyId),
          gte(entries.date, year.from),
          lte(entries.date, year.to),
        ),
      )
      .limit(1);
    if (!any) continue;
    let items: ReviewItem[];
    try {
      items = await yearEndReview(tx, companyId, year, rules);
    } catch (error) {
      if (error instanceof RuleGapError) continue;
      throw error;
    }
    // Within the year's last month nothing of its end can be done yet (the inventory at its last
    // day, the year's profit tax, the result closed after the last entry): a warning until the
    // year has ended, as the pro-rata's and the capital goods' adjustments are.
    const ended = today > year.to;
    for (const item of items)
      work.push({
        subject: { kind: 'yearend', id: `${year.to.slice(0, 4)}|${item.id}` },
        severity: item.severity === 'block' && !ended ? 'warn' : item.severity,
        period: year.to.slice(0, 4),
        message: item.message,
        details: { check: item.check, ...item.details },
        next: item.next,
      });
    if (
      !items.some((item) => item.severity === 'block') &&
      !(await monthsOpen(tx, companyId, year)).length
    )
      work.push({
        subject: { kind: 'yearend', id: `${year.to.slice(0, 4)}|year.close` },
        severity: 'warn',
        period: year.to.slice(0, 4),
        message: `Lunile exercițiului ${year.from} – ${year.to} sunt închise: cereți închiderea exercițiului (years.close), care înregistrează închiderea pe conturi, parteneri și imobilizări și blochează exercițiul.`,
        details: { check: 'year.close', financialYearId: year.id },
        next: [agent('years.close.request', { financialYearId: year.id })],
      });
  }
  return work;
}
