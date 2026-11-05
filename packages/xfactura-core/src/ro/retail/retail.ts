import { z } from 'zod';
import {
  financialYearOf,
  profileAt,
  turnoverKey,
  vatPeriodOf,
  type Effect,
  type Issue,
  type LineSpec,
  type Loaded,
  type ReadPlan,
  type TaxEntrySpec,
  type Treatment,
  type TurnoverQuery,
  type WarehouseRecord,
} from '../../kernel';
import { divRound, formatMoney, LEDGER_CURRENCY, parseMoney } from '../../money';
import { questionIssue } from '../../questions/kinds';
import { RuleGapError, type RuleContext } from '../../rules';
import { addDays, type LocalDate } from '../../time';
import { adjustmentCodes } from '../exempt/codes';
import { retailMethodAt, warehouseRetailAxis } from '../stock/valuation';
import {
  rateSegment,
  retailAccountsOf,
  retailGoodsRate,
  retailSynthetics,
  retailTag,
  retailWarehouse,
} from './accounts';
import { includedVat } from './documents';
import type { CoefficientRule } from './parameters';

/*
 * The retail price method (OMFP nr. 1.802/2014 pct. 286 alin. (8), allowed in retail trade for
 * numerous, fast-moving articles of similar margins): a warehouse's goods at their sale price
 * with VAT, on its analytics of 371 by VAT rate, with the markup they include on 378 and the VAT
 * their price includes on 4428, kept apart from VAT on collection (./accounts.ts). The value is
 * kept globally, without quantities (metoda global-valorică), on the perpetual inventory (pct. 291
 * alin. (5)). What moves it:
 * - the reception at sale price (the NIR): `invoices.recognize` with `retail`, the cost on the
 *   goods' account, then the markup (Cr 378) and the VAT included (Cr 4428) on top;
 * - the takeover of a warehouse's existing goods (`retail.opening`) and a change of sale prices
 *   (`retail.reprice`, the markup recalculated with it, pct. 286 alin. (8));
 * - the exits at sale price: the Z reports' goods (Dr 607 / Cr 371) and the count's shortages;
 * - the month's discharge of the exits' markup and VAT (`retail.discharge`), by the coefficient
 *   of pct. 286 alin. (4) (the cumulated markup over the goods' value without the VAT included,
 *   note *2)): Dr 378 / Cr 607, Dr 4428 / Cr 607, so that 607 holds the cost of the goods sold;
 * - the count at sale price (`retail.count`), its shortage's deducted VAT adjusted (art. 304).
 * Exits are the credits of the goods' accounts; entries are their debits, a lower price a red
 * storno of the debit, so the month's exits are the credit turnover of its goods' accounts. A
 * reversal counts on the side of what it reverses (`TurnoverQuery.sides`), a black storno as its
 * red one: a reception reversed is a negative entry, never an exit.
 * The method is a warehouse's (`retailMethodAt`): a shop's warehouse at retail price, a depot at
 * cost in the stock register, as the policies record them.
 */

const OMFPA = 'OMFP1802/2014-A';
const CODE = 'ANAF/Cod-fiscal-consolidat';
export const RETAIL_CLAUSES = [
  `${OMFPA}:pct.286(4)-(8)`,
  'OMFP1802/2014:conturi.371-378',
  'OMFP1802/2014:conturi.4428',
];

const block = (
  code: string,
  message: string,
  path?: string,
  details?: Issue['details'],
): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
  ...(details === undefined ? {} : { details }),
});
const ack = (code: string, message: string, details?: Issue['details']): Issue => ({
  code,
  severity: 'ack',
  message,
  ...(details === undefined ? {} : { details }),
});
const ron = (value: string) => parseMoney(value, LEDGER_CURRENCY);
const lei = (bani: bigint) => formatMoney(bani, LEDGER_CURRENCY);
const signed = (value: string) => (value.startsWith('-') ? -ron(value.slice(1)) : ron(value));
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/) as unknown as z.ZodType<LocalDate>;
const money = z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/);
const signedMoney = z.string().regex(/^-?(0|[1-9]\d{0,15})(\.\d{1,2})?$/);
const rate = z.string().regex(/^\d{1,2}$/);
const always = '1900-01-01' as LocalDate;

/** The warehouse's retail policy and the perpetual inventory it needs, or the issues asking for
 * them. */
function retailPolicyIssues(loaded: Loaded, date: LocalDate, warehouseId: string): Issue[] {
  const retail = retailMethodAt(loaded, warehouseId, date);
  const inventory = profileAt(loaded, 'policy.stock.inventory', date);
  const issues: Issue[] = [];
  if (retail !== 'retail')
    issues.push(
      retail
        ? block(
            'RETAIL_POLICY',
            `Politicile contabile țin mărfurile gestiunii ${loaded.warehouses.get(warehouseId)?.code ?? warehouseId} la cost (${warehouseRetailAxis(warehouseId)} sau policy.stock.retail cost): metoda prețului cu amănuntul nu se aplică.`,
          )
        : questionIssue(
            'POLICY_MISSING',
            'Înregistrați dacă mărfurile se țin la cost sau la preț cu amănuntul (policy.stock.retail).',
            {
              kind: 'profile.fact',
              subject: { kind: 'profile', id: 'policy.stock.retail' },
              params: { axis: 'policy.stock.retail', from: date },
            },
          ),
    );
  if (!inventory)
    issues.push(
      questionIssue(
        'POLICY_MISSING',
        'Înregistrați metoda de evidență a stocurilor (policy.stock.inventory).',
        {
          kind: 'profile.fact',
          subject: { kind: 'profile', id: 'policy.stock.inventory' },
          params: { axis: 'policy.stock.inventory', from: date },
        },
      ),
    );
  else if (inventory !== 'permanent')
    issues.push(
      block(
        'RETAIL_INTERMITTENT',
        'Metoda prețului cu amănuntul (global-valorică) nu se aplică cu inventarul intermitent (OMFP 1802/2014 pct. 291 alin. (5)).',
      ),
    );
  return issues;
}

/** The prefixes a warehouse's retail accounts are read under. */
const prefixesOf = (synthetics: { goods: string; markup: string; vat: string }, code: string) => [
  `${synthetics.goods}.${code}-`,
  `${synthetics.markup}.${code}`,
  `${synthetics.vat}.${code}-`,
];
/** The synthetics before the rules are read: `ro.stock.accounts` retail is 378 and 4428 (the
 * treatment checks the rules agree). */
const defaultSynthetics = { goods: '371', markup: '378', vat: '4428' };

/** A warehouse's retail accounts as turnover rows give them, per rate. */
interface RetailBalances {
  goods: Map<string, { debit: bigint; credit: bigint }>;
  markup: { debit: bigint; credit: bigint };
  vat: Map<string, { debit: bigint; credit: bigint }>;
}

function balancesOf(
  loaded: Loaded,
  query: TurnoverQuery,
  synthetics: { goods: string; markup: string; vat: string },
  code: string,
): RetailBalances {
  const rows = loaded.turnover.get(turnoverKey(query)) ?? [];
  const result: RetailBalances = {
    goods: new Map(),
    markup: { debit: 0n, credit: 0n },
    vat: new Map(),
  };
  for (const row of rows) {
    const goods = retailGoodsRate(synthetics.goods, code, row.account);
    const vat = retailGoodsRate(synthetics.vat, code, row.account);
    if (goods !== null) result.goods.set(goods, { debit: row.debit, credit: row.credit });
    else if (vat !== null) result.vat.set(vat, { debit: row.debit, credit: row.credit });
    else if (row.account === `${synthetics.markup}.${code}`)
      result.markup = { debit: row.debit, credit: row.credit };
  }
  return result;
}

const sum = (rows: Map<string, { debit: bigint; credit: bigint }>, side: 'debit' | 'credit') =>
  [...rows.values()].reduce((total, row) => total + row[side], 0n);

/** The queries of a warehouse's coefficient for a period ending on `end`: the balances before
 * the financial year and before the period, the entries of the year to the end and of the
 * period. */
function coefficientQueries(
  loaded: Loaded,
  code: string,
  periodStart: LocalDate,
  end: LocalDate,
): {
  beforeYear: TurnoverQuery;
  year: TurnoverQuery;
  beforePeriod: TurnoverQuery;
  period: TurnoverQuery;
} | null {
  const year = financialYearOf(loaded, end);
  if (!year) return null;
  const prefixes = prefixesOf(defaultSynthetics, code);
  // What entered and what left, a reversal on the side of what it reverses.
  const sides = 'original' as const;
  return {
    beforeYear: { prefixes, from: always, to: addDays(year.from, -1), sides },
    year: { prefixes, from: year.from, to: end, sides },
    beforePeriod: { prefixes, from: always, to: addDays(periodStart, -1), sides },
    period: { prefixes, from: periodStart, to: end, sides },
  };
}

/**
 * The coefficient of pct. 286 alin. (4) for the markup (the reading of `ro.stock.retail.coefficient`):
 * the markup's opening balance plus the markups entered, over the goods' opening balance plus
 * the goods entered at sale price, both without the VAT included (note *2)), as a fraction.
 */
function coefficient(
  loaded: Loaded,
  queries: NonNullable<ReturnType<typeof coefficientQueries>>,
  code: string,
  basis: CoefficientRule['basis'],
): { numerator: bigint; denominator: bigint } {
  const before = balancesOf(
    loaded,
    basis === 'year' ? queries.beforeYear : queries.beforePeriod,
    defaultSynthetics,
    code,
  );
  const entered = balancesOf(
    loaded,
    basis === 'year' ? queries.year : queries.period,
    defaultSynthetics,
    code,
  );
  const opening = {
    goods: sum(before.goods, 'debit') - sum(before.goods, 'credit'),
    markup: before.markup.credit - before.markup.debit,
    vat: sum(before.vat, 'credit') - sum(before.vat, 'debit'),
  };
  return {
    numerator: opening.markup + entered.markup.credit,
    denominator:
      opening.goods + sum(entered.goods, 'debit') - opening.vat - sum(entered.vat, 'credit'),
  };
}

const percent = (fraction: { numerator: bigint; denominator: bigint }) =>
  fraction.denominator === 0n
    ? '—'
    : `${(Number((fraction.numerator * 1_000_000n) / fraction.denominator) / 10_000).toFixed(4)}%`;

function param<T>(rules: RuleContext, key: string, date: LocalDate, issues: Issue[]): T | null {
  try {
    return rules.param<T>(key, 'accounting_transaction_date', date);
  } catch (error) {
    if (!(error instanceof RuleGapError)) throw error;
    issues.push(block('RULE_GAP', error.message));
    return null;
  }
}

function warehouseFor(
  loaded: Loaded,
  id: string,
  path: string,
  issues: Issue[],
): WarehouseRecord | null {
  const found = retailWarehouse(loaded.warehouses, id, path);
  if ('severity' in found) {
    issues.push(found);
    return null;
  }
  return found;
}

/** The synthetics the rules give, checked against the read's (they key the turnover). */
function syntheticsFor(rules: RuleContext, date: LocalDate, issues: Issue[]) {
  try {
    const synthetics = retailSynthetics(rules, date);
    if (synthetics.markup !== defaultSynthetics.markup || synthetics.vat !== defaultSynthetics.vat)
      issues.push(
        block(
          'RETAIL_ACCOUNTS',
          'Conturile metodei prețului cu amănuntul din ro.stock.accounts nu sunt 378 și 4428.',
        ),
      );
    return synthetics;
  } catch (error) {
    if (!(error instanceof RuleGapError)) throw error;
    issues.push(block('RULE_GAP', error.message));
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The reception at sale price (invoices.recognize with `retail`)

export const retailReceiptInput = z
  .object({
    /** The warehouse kept at retail price the goods enter. */
    warehouseId: z.uuid(),
    /** The reception note at sale price (NIR), with each line's sale price. */
    evidenceId: z.uuid(),
    /** Per goods account of the warehouse (`371.<code>-<rate>`) the purchase is allocated to:
     * the goods' value at sale price, VAT included. */
    prices: z
      .array(z.object({ account: z.string().min(5).max(60), sale: money }).strict())
      .min(1)
      .max(20),
  })
  .strict();
export type RetailReceipt = z.infer<typeof retailReceiptInput>;

/** What a purchase with `retail` reads beyond the invoice: the warehouse and the NIR. */
export const retailReceiptQuery = (retail: RetailReceipt): ReadPlan => ({
  stock: { warehouses: [retail.warehouseId] },
  evidence: [retail.evidenceId],
});

/** Whether an account can be a retail purchase's: a goods account at retail price. */
export const isRetailGoodsAccount = (account: string) =>
  /^371\.[A-Z0-9_]{1,20}-\d{1,2}$/.test(account);

/**
 * The reception at sale price of a purchase invoice's goods (`invoices.recognize` with `retail`):
 * each goods account's cost is what the invoice booked on it (its non-deductible VAT included);
 * on top of it, the VAT the sale price includes (Cr 4428) and the markup (Cr 378), so that the
 * account holds the goods at their sale price. Lines are appended to `lines`.
 */
export function receiveRetail(args: {
  retail: RetailReceipt;
  loaded: Loaded;
  rules: RuleContext;
  date: LocalDate;
  lines: LineSpec[];
}): { issues: Issue[]; details: Issue['details'] } {
  const { retail, loaded, rules, date, lines } = args;
  const issues: Issue[] = [...retailPolicyIssues(loaded, date, retail.warehouseId)];
  if (!loaded.evidence.has(retail.evidenceId))
    issues.push(
      block(
        'EVIDENCE',
        'Nota de recepție la preț de vânzare nu este disponibilă.',
        'retail.evidenceId',
      ),
    );
  const warehouse = warehouseFor(loaded, retail.warehouseId, 'retail.warehouseId', issues);
  const synthetics = syntheticsFor(rules, date, issues);
  if (!warehouse || !synthetics) return { issues, details: null };
  const tag = retailTag(warehouse.id);
  const costs = new Map<string, bigint>();
  for (const line of lines) {
    if (!line.account.startsWith(`${synthetics.goods}.`)) continue;
    const rate = retailGoodsRate(synthetics.goods, warehouse.code, line.account);
    if (rate === null) {
      issues.push(
        block(
          'RETAIL_ACCOUNT',
          `Contul ${line.account} nu este un cont al gestiunii ${warehouse.code} la preț cu amănuntul (${synthetics.goods}.${warehouse.code}-<cota>).`,
        ),
      );
      continue;
    }
    costs.set(
      line.account,
      (costs.get(line.account) ?? 0n) + (line.side === 'D' ? line.bani : -line.bani),
    );
    line.analytics = { ...line.analytics, item: tag };
  }
  const details: { account: string; cost: string; sale: string; vat: string; markup: string }[] =
    [];
  retail.prices.forEach((price, index) => {
    const path = `retail.prices.${index}`;
    const cost = costs.get(price.account);
    const rate = retailGoodsRate(synthetics.goods, warehouse.code, price.account);
    if (cost === undefined || rate === null)
      return void issues.push(
        block('RETAIL_PRICE', `Factura nu înregistrează mărfuri în ${price.account}.`, path),
      );
    costs.delete(price.account);
    const sale = ron(price.sale);
    const vat =
      profileAt(loaded, 'vat.status', date) === 'normal_vat' ? includedVat(sale, rate) : 0n;
    const markup = sale - vat - cost;
    if (markup < 0n)
      issues.push(
        ack(
          'RETAIL_MARKUP_NEGATIVE',
          `La ${price.account}, prețul de vânzare fără TVA (${lei(sale - vat)}) este sub costul de achiziție (${lei(cost)}): confirmați vânzarea în pierdere.`,
        ),
      );
    const accounts = retailAccountsOf(synthetics, warehouse.code, rate);
    if (vat !== 0n) {
      lines.push({
        account: accounts.goods,
        side: 'D',
        bani: vat,
        analytics: { item: tag },
        memo: 'TVA neexigibilă inclusă în prețul de vânzare',
      });
      lines.push({
        account: accounts.vat,
        side: 'C',
        bani: vat,
        analytics: { item: tag },
        memo: 'TVA neexigibilă inclusă în prețul de vânzare',
      });
    }
    if (markup !== 0n) {
      lines.push({
        account: accounts.goods,
        side: 'D',
        bani: markup,
        analytics: { item: tag },
        memo: 'Adaos comercial',
      });
      lines.push({
        account: accounts.markup,
        side: 'C',
        bani: markup,
        analytics: { item: tag },
        memo: 'Adaos comercial',
      });
    }
    details.push({
      account: price.account,
      cost: lei(cost),
      sale: price.sale,
      vat: lei(vat),
      markup: lei(markup),
    });
  });
  for (const account of costs.keys())
    issues.push(
      block(
        'RETAIL_PRICE',
        `Indicați prețul de vânzare al mărfurilor din ${account} (retail.prices).`,
        'retail.prices',
      ),
    );
  return {
    issues,
    details: { warehouseId: warehouse.id, prices: details, clauses: RETAIL_CLAUSES },
  };
}

// ---------------------------------------------------------------------------------------------
// The takeover, the change of prices, the month's discharge, the count

/** The turnover a warehouse treatment reads: its accounts up to the date, and for the takeover
 * the account the goods come from. */
const balanceQuery = (code: string, date: LocalDate): TurnoverQuery => ({
  prefixes: prefixesOf(defaultSynthetics, code),
  from: always,
  to: date,
});

export const retailOpeningInput = z
  .object({
    date: localDate,
    warehouseId: z.uuid(),
    /** The inventory list at sale price the takeover is valued from. */
    evidenceId: z.uuid(),
    /** The account the goods' cost is held on now (371, an analytic of it outside retail). */
    from: z.string().regex(/^371(\.[A-Z0-9_]{1,24})?$/),
    rows: z
      .array(z.object({ rate, sale: money, markup: money }).strict())
      .min(1)
      .max(10),
  })
  .strict();
export type RetailOpeningInput = z.infer<typeof retailOpeningInput>;

/** A warehouse's goods taken in at sale price: their cost leaves the account it is held on. */
export const retailOpening: Treatment<RetailOpeningInput> = {
  id: 'retail.opening',
  version: 1,
  description:
    'Preluarea mărfurilor unei gestiuni la preț cu amănuntul: costul din contul în care sunt ținute, adaosul (378) și TVA neexigibilă (4428).',
  input: retailOpeningInput,
  agent: true,
  summary:
    "A warehouse's goods taken in at retail price: their cost moved off the account holding it, with their markup (378) and the VAT their price includes (4428).",
  toolset: 'books',
  subject: (input) => `retail.opening:${input.warehouseId}`,
  plan: (input) => ({
    stock: { warehouses: [input.warehouseId] },
    evidence: [input.evidenceId],
    profile: true,
    turnover: [{ prefixes: [input.from], from: always, to: input.date }],
  }),
  evaluate(input, loaded, rules) {
    const issues: Issue[] = [...retailPolicyIssues(loaded, input.date, input.warehouseId)];
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(block('EVIDENCE', 'Lista de inventariere nu este disponibilă.', 'evidenceId'));
    const warehouse = warehouseFor(loaded, input.warehouseId, 'warehouseId', issues);
    const synthetics = syntheticsFor(rules, input.date, issues);
    if (isRetailGoodsAccount(input.from))
      issues.push(
        block('RETAIL_ACCOUNT', 'Mărfurile se preiau dintr-un cont ținut la cost.', 'from'),
      );
    if (!warehouse || !synthetics || issues.some((issue) => issue.severity === 'block'))
      return { effect: null, issues };
    const payer = profileAt(loaded, 'vat.status', input.date) === 'normal_vat';
    const tag = retailTag(warehouse.id);
    const lines: LineSpec[] = [];
    let cost = 0n;
    input.rows.forEach((row, index) => {
      const accounts = retailAccountsOf(synthetics, warehouse.code, row.rate);
      const sale = ron(row.sale);
      const vat = payer ? includedVat(sale, row.rate) : 0n;
      const markup = ron(row.markup);
      const rowCost = sale - vat - markup;
      if (rowCost < 0n)
        issues.push(
          block('RETAIL_OPENING', 'Adaosul și TVA depășesc prețul de vânzare.', `rows.${index}`),
        );
      cost += rowCost;
      lines.push({
        account: accounts.goods,
        side: 'D',
        bani: sale,
        analytics: { item: tag },
        memo: 'Preluare la preț cu amănuntul',
      });
      if (vat)
        lines.push({
          account: accounts.vat,
          side: 'C',
          bani: vat,
          analytics: { item: tag },
          memo: 'TVA neexigibilă',
        });
      if (markup)
        lines.push({
          account: accounts.markup,
          side: 'C',
          bani: markup,
          analytics: { item: tag },
          memo: 'Adaos comercial',
        });
    });
    const held = (
      loaded.turnover.get(turnoverKey({ prefixes: [input.from], from: always, to: input.date })) ??
      []
    )
      .filter((row) => row.account === input.from)
      .reduce((total, row) => total + row.debit - row.credit, 0n);
    if (cost > held)
      issues.push(
        block(
          'RETAIL_OPENING_EXCEEDS',
          `Costul mărfurilor preluate (${lei(cost)}) depășește soldul contului ${input.from} (${lei(held)}).`,
          'from',
        ),
      );
    if (cost > 0n)
      lines.push({
        account: input.from,
        side: 'C',
        bani: cost,
        memo: 'Mărfuri trecute la preț cu amănuntul',
      });
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };
    return {
      effect: {
        schema: 'effect@1',
        date: input.date,
        journalClass: 'general',
        journalCode: 'DIVERSE',
        description: `Preluarea gestiunii ${warehouse.code} la preț cu amănuntul`,
        lines,
        openItems: [],
        taxEntries: [],
        schedules: [],
        explanation: {
          summary: `Gestiunea ${warehouse.code} preluată la preț cu amănuntul: cost ${lei(cost)} lei din ${input.from}.`,
          details: { warehouseId: warehouse.id, rows: input.rows, clauses: RETAIL_CLAUSES },
        },
      },
      issues,
    };
  },
};

export const retailRepriceInput = z
  .object({
    date: localDate,
    warehouseId: z.uuid(),
    /** The record of the new prices (procesul-verbal de modificare a prețurilor). */
    evidenceId: z.uuid(),
    /** Per rate, the change of the goods' value at sale price, VAT included: positive for higher
     * prices, negative for lower. */
    changes: z
      .array(z.object({ rate, amount: signedMoney }).strict())
      .min(1)
      .max(10),
  })
  .strict();
export type RetailRepriceInput = z.infer<typeof retailRepriceInput>;

/** A change of sale prices: the goods' value, the VAT it includes and the markup recalculated
 * (pct. 286 alin. (8)); a lower price is a red storno of the goods' debit. */
export const retailReprice: Treatment<RetailRepriceInput> = {
  id: 'retail.reprice',
  version: 1,
  description:
    'Modificarea prețurilor de vânzare într-o gestiune la preț cu amănuntul: valoarea mărfurilor, TVA neexigibilă și adaosul recalculat.',
  input: retailRepriceInput,
  agent: true,
  summary:
    'A change of sale prices in a warehouse at retail price: the goods’ value, the VAT it includes and the markup recalculated (pct. 286 (8)).',
  toolset: 'books',
  subject: (input) => `retail.reprice:${input.evidenceId}`,
  plan: (input) => ({
    stock: { warehouses: [input.warehouseId] },
    evidence: [input.evidenceId],
    profile: true,
  }),
  followUp(input, loaded) {
    const warehouse = loaded.warehouses.get(input.warehouseId);
    return warehouse ? { turnover: [balanceQuery(warehouse.code, input.date)] } : null;
  },
  evaluate(input, loaded, rules) {
    const issues: Issue[] = [...retailPolicyIssues(loaded, input.date, input.warehouseId)];
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(
        block(
          'EVIDENCE',
          'Procesul-verbal de modificare a prețurilor nu este disponibil.',
          'evidenceId',
        ),
      );
    const warehouse = warehouseFor(loaded, input.warehouseId, 'warehouseId', issues);
    const synthetics = syntheticsFor(rules, input.date, issues);
    if (!warehouse || !synthetics || issues.some((issue) => issue.severity === 'block'))
      return { effect: null, issues };
    const payer = profileAt(loaded, 'vat.status', input.date) === 'normal_vat';
    const tag = retailTag(warehouse.id);
    const held = balancesOf(
      loaded,
      balanceQuery(warehouse.code, input.date),
      synthetics,
      warehouse.code,
    );
    const lines: LineSpec[] = [];
    let markupChange = 0n;
    input.changes.forEach((change, index) => {
      const amount = signed(change.amount);
      if (amount === 0n) return;
      const accounts = retailAccountsOf(synthetics, warehouse.code, change.rate);
      const magnitude = amount < 0n ? -amount : amount;
      const vat = (payer ? includedVat(magnitude, change.rate) : 0n) * (amount < 0n ? -1n : 1n);
      const markup = amount - vat;
      const goods = held.goods.get(change.rate);
      if (amount < 0n && (!goods || goods.debit - goods.credit < magnitude))
        issues.push(
          block(
            'RETAIL_REPRICE',
            `Gestiunea nu are mărfuri la cota ${change.rate}% în valoarea reducerii.`,
            `changes.${index}`,
          ),
        );
      markupChange += markup;
      lines.push({
        account: accounts.goods,
        side: 'D',
        bani: amount,
        analytics: { item: tag },
        memo: 'Modificare de preț',
      });
      if (vat)
        lines.push({
          account: accounts.vat,
          side: 'C',
          bani: vat,
          analytics: { item: tag },
          memo: 'TVA neexigibilă recalculată',
        });
      if (markup)
        lines.push({
          account: accounts.markup,
          side: 'C',
          bani: markup,
          analytics: { item: tag },
          memo: 'Adaos recalculat',
        });
    });
    if (held.markup.credit - held.markup.debit + markupChange < 0n)
      issues.push(
        ack(
          'RETAIL_MARKUP_NEGATIVE',
          'După reducere, adaosul gestiunii devine negativ: mărfurile se vând sub cost. Confirmați.',
        ),
      );
    if (lines.length < 2) issues.push(block('RETAIL_REPRICE', 'Nicio modificare de preț.'));
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };
    return {
      effect: {
        schema: 'effect@1',
        date: input.date,
        journalClass: 'general',
        journalCode: 'DIVERSE',
        description: `Modificare de prețuri, gestiunea ${warehouse.code}`,
        lines,
        openItems: [],
        taxEntries: [],
        schedules: [],
        explanation: {
          summary: `Prețurile de vânzare ale gestiunii ${warehouse.code} modificate cu ${input.changes.map((change) => `${change.amount} lei la ${change.rate}%`).join(', ')}; adaosul se modifică cu ${lei(markupChange)} lei.`,
          details: { warehouseId: warehouse.id, changes: input.changes, clauses: RETAIL_CLAUSES },
        },
      },
      issues,
    };
  },
};

const monthEnd = (month: string) =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0))
    .toISOString()
    .slice(0, 10) as LocalDate;

export const retailDischargeInput = z
  .object({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    warehouseId: z.uuid(),
  })
  .strict();
export type RetailDischargeInput = z.infer<typeof retailDischargeInput>;

/**
 * What a month's discharge computes: the exits at sale price by rate, the VAT they include, the
 * coefficient and the markup. Cumulated from the year's start (`year`), the coefficient applies
 * to the year's exits to the month's end, less the markup the year's earlier months discharged
 * (pct. 286 alin. (4), (7): the markup is spread over the goods sold and those held alike, so
 * 378 keeps K × the stock without VAT), as `production.differences` applies it; the month's own
 * coefficient applies to the month's exits.
 */
export function retailDischargeFigures(
  loaded: Loaded,
  code: string,
  month: string,
  basis: CoefficientRule['basis'],
) {
  const end = monthEnd(month);
  const queries = coefficientQueries(loaded, code, `${month}-01` as LocalDate, end);
  if (!queries) return null;
  const period = balancesOf(loaded, queries.period, defaultSynthetics, code);
  const exits = [...period.goods].map(([rate, row]) => ({ rate, gross: row.credit }));
  const payer = profileAt(loaded, 'vat.status', end) === 'normal_vat';
  const included = (gross: bigint, rate: string) => (payer ? includedVat(gross, rate) : 0n);
  const vat = exits.map((row) => ({ rate: row.rate, vat: included(row.gross, row.rate) }));
  const net = exits.reduce((total, row, index) => total + row.gross - vat[index]!.vat, 0n);
  const fraction = coefficient(loaded, queries, code, basis);
  const year = basis === 'year' ? balancesOf(loaded, queries.year, defaultSynthetics, code) : null;
  /** The exits without VAT the coefficient applies to, and the markup already discharged. */
  const cumulated = year
    ? [...year.goods].reduce(
        (total, [rate, row]) => total + row.credit - included(row.credit, rate),
        0n,
      )
    : net;
  const taken = year ? year.markup.debit - period.markup.debit : 0n;
  // Without exits to apply it to (a reception reversed, nothing sold), the coefficient is not
  // needed: what earlier months discharged is given back, if anything.
  const markup =
    fraction.denominator > 0n
      ? divRound(cumulated * fraction.numerator, fraction.denominator, 'halfAwayFromZero') - taken
      : cumulated === 0n
        ? -taken
        : null;
  return { end, exits, vat, net, cumulated, taken, fraction, markup, period, queries };
}

/** The month's discharge of the markup and the VAT included of a warehouse's exits. */
export const retailDischarge: Treatment<RetailDischargeInput> = {
  id: 'retail.discharge',
  version: 1,
  description:
    'Descărcarea lunară a adaosului comercial (378) și a TVA neexigibile (4428) aferente mărfurilor ieșite dintr-o gestiune la preț cu amănuntul, după coeficientul de repartizare.',
  input: retailDischargeInput,
  agent: true,
  summary:
    "The month's discharge of the markup (378, by the coefficient of pct. 286) and the VAT included (4428) of a retail-price warehouse's exits, so 607 holds the goods' cost.",
  toolset: 'books',
  subject: (input) => `retail.discharge:${input.warehouseId}:${input.month}`,
  plan: (input) => ({ stock: { warehouses: [input.warehouseId] }, profile: true }),
  followUp(input, loaded) {
    const warehouse = loaded.warehouses.get(input.warehouseId);
    if (!warehouse) return null;
    const queries = coefficientQueries(
      loaded,
      warehouse.code,
      `${input.month}-01` as LocalDate,
      monthEnd(input.month),
    );
    return queries ? { turnover: Object.values(queries) } : null;
  },
  evaluate(input, loaded, rules) {
    const end = monthEnd(input.month);
    const issues: Issue[] = [...retailPolicyIssues(loaded, end, input.warehouseId)];
    const warehouse = warehouseFor(loaded, input.warehouseId, 'warehouseId', issues);
    const synthetics = syntheticsFor(rules, end, issues);
    const rule = param<CoefficientRule>(rules, 'ro.stock.retail.coefficient', end, issues);
    if (!warehouse || !synthetics || !rule || issues.some((issue) => issue.severity === 'block'))
      return { effect: null, issues };
    const figures = retailDischargeFigures(loaded, warehouse.code, input.month, rule.basis);
    if (!figures)
      return {
        effect: null,
        issues: [
          block('FINANCIAL_YEAR', `Luna ${input.month} nu este într-un exercițiu financiar.`),
        ],
      };
    if (figures.markup === null)
      return {
        effect: null,
        issues: [
          block(
            'RETAIL_COEFFICIENT',
            'Gestiunea nu are mărfuri la preț de vânzare fără TVA: coeficientul nu se poate calcula.',
          ),
        ],
      };
    const tag = retailTag(warehouse.id);
    const lines: LineSpec[] = [];
    if (figures.markup !== 0n) {
      lines.push({
        account: retailAccountsOf(synthetics, warehouse.code, '0').markup,
        side: 'D',
        bani: figures.markup,
        analytics: { item: tag },
        memo: 'Adaos aferent mărfurilor ieșite',
      });
      lines.push({
        account: '607',
        side: 'C',
        bani: figures.markup,
        memo: 'Adaos aferent mărfurilor ieșite',
      });
    }
    for (const row of figures.vat) {
      if (row.vat === 0n) continue;
      lines.push({
        account: retailAccountsOf(synthetics, warehouse.code, row.rate).vat,
        side: 'D',
        bani: row.vat,
        analytics: { item: tag },
        memo: `TVA neexigibilă ${row.rate}% a mărfurilor ieșite`,
      });
      lines.push({
        account: '607',
        side: 'C',
        bani: row.vat,
        memo: `TVA neexigibilă ${row.rate}% a mărfurilor ieșite`,
      });
    }
    if (!lines.length)
      return {
        effect: null,
        issues: [
          block('RETAIL_NO_EXITS', `Gestiunea ${warehouse.code} nu are ieșiri în ${input.month}.`),
        ],
      };
    const markupAfter = figures.period.markup.credit - figures.period.markup.debit - figures.markup;
    const before = balancesOf(
      loaded,
      figures.queries.beforePeriod,
      defaultSynthetics,
      warehouse.code,
    );
    if (before.markup.credit - before.markup.debit + markupAfter < 0n)
      issues.push(
        ack(
          'RETAIL_MARKUP_NEGATIVE',
          'După descărcare, adaosul rămas al gestiunii este negativ: verificați prețurile și coeficientul.',
        ),
      );
    return {
      effect: {
        schema: 'effect@1',
        date: end,
        journalClass: 'general',
        journalCode: 'DIVERSE',
        description: `Descărcarea adaosului și a TVA neexigibile, gestiunea ${warehouse.code}, ${input.month}`,
        lines,
        openItems: [],
        taxEntries: [],
        schedules: [],
        explanation: {
          summary: `Ieșiri la preț de vânzare ${lei(figures.exits.reduce((total, row) => total + row.gross, 0n))} lei, fără TVA ${lei(figures.net)} lei; coeficient ${percent(figures.fraction)} (${rule.basis === 'year' ? `de la începutul exercițiului, aplicat ieșirilor cumulate fără TVA ${lei(figures.cumulated)} lei, minus adaosul descărcat în lunile anterioare ${lei(figures.taken)} lei` : 'al lunii'}): adaos ${lei(figures.markup)} lei, TVA ${lei(figures.vat.reduce((total, row) => total + row.vat, 0n))} lei.`,
          details: {
            warehouseId: warehouse.id,
            month: input.month,
            basis: rule.basis,
            cumulated: lei(figures.cumulated),
            taken: lei(figures.taken),
            coefficient: {
              numerator: lei(figures.fraction.numerator),
              denominator: lei(figures.fraction.denominator),
              percent: percent(figures.fraction),
            },
            exits: figures.exits.map((row, index) => ({
              rate: row.rate,
              gross: lei(row.gross),
              vat: lei(figures.vat[index]!.vat),
            })),
            clauses: RETAIL_CLAUSES,
          },
        },
      },
      issues,
    };
  },
};

/** The causes of a shortage at a count at sale price: unimputable (its deducted VAT adjusted), or
 * a cause whose VAT is not adjusted, with its proof (Codul fiscal art. 304, norme pct. 78 alin.
 * (10)). An imputation is not covered. */
export const retailShortageCauses = [
  'unimputable',
  'perishable',
  'calamity',
  'theft',
  'degraded',
] as const;

export const retailCountInput = z
  .object({
    date: localDate,
    warehouseId: z.uuid(),
    /** The inventory list at sale price and the administrator's decision on it. */
    evidenceId: z.uuid(),
    /** The goods counted, per VAT rate, at their sale price with VAT. */
    rows: z
      .array(z.object({ rate, counted: money }).strict())
      .min(1)
      .max(10),
    cause: z.enum(retailShortageCauses).optional(),
    /** The proof of a cause whose VAT is not adjusted. */
    causeEvidenceId: z.uuid().optional(),
  })
  .strict();
export type RetailCountInput = z.infer<typeof retailCountInput>;

/** The count of a warehouse at sale price: its differences against the books, per rate. */
export const retailCount: Treatment<RetailCountInput> = {
  id: 'retail.count',
  version: 1,
  description:
    'Inventarierea unei gestiuni la preț cu amănuntul: lipsurile ies la preț de vânzare (cu ajustarea TVA deduse), plusurile intră cu adaosul și TVA neexigibilă.',
  input: retailCountInput,
  agent: true,
  summary:
    "A retail-price warehouse's count at sale price: shortages leave at sale price with their deducted VAT adjusted (art. 304), surpluses enter with their markup and VAT included.",
  toolset: 'books',
  dataClasses: ['books', 'tax'],
  subject: (input) => `retail.count:${input.warehouseId}:${input.date}`,
  plan: (input) => ({
    stock: { warehouses: [input.warehouseId] },
    evidence: [input.evidenceId, ...(input.causeEvidenceId ? [input.causeEvidenceId] : [])],
    profile: true,
  }),
  followUp(input, loaded) {
    const warehouse = loaded.warehouses.get(input.warehouseId);
    if (!warehouse) return null;
    const queries = coefficientQueries(
      loaded,
      warehouse.code,
      `${input.date.slice(0, 7)}-01` as LocalDate,
      input.date,
    );
    return {
      turnover: [
        balanceQuery(warehouse.code, input.date),
        ...(queries ? Object.values(queries) : []),
      ],
    };
  },
  evaluate(input, loaded, rules) {
    const issues: Issue[] = [...retailPolicyIssues(loaded, input.date, input.warehouseId)];
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(block('EVIDENCE', 'Lista de inventariere nu este disponibilă.', 'evidenceId'));
    const warehouse = warehouseFor(loaded, input.warehouseId, 'warehouseId', issues);
    const synthetics = syntheticsFor(rules, input.date, issues);
    const rule = param<CoefficientRule>(rules, 'ro.stock.retail.coefficient', input.date, issues);
    if (!warehouse || !synthetics || !rule || issues.some((issue) => issue.severity === 'block'))
      return { effect: null, issues };
    const payer = profileAt(loaded, 'vat.status', input.date) === 'normal_vat';
    const taxPeriod = vatPeriodOf(loaded, input.date);
    const tag = retailTag(warehouse.id);
    const held = balancesOf(
      loaded,
      balanceQuery(warehouse.code, input.date),
      synthetics,
      warehouse.code,
    );
    const queries = coefficientQueries(
      loaded,
      warehouse.code,
      `${input.date.slice(0, 7)}-01` as LocalDate,
      input.date,
    );
    const fraction = queries
      ? coefficient(loaded, queries, warehouse.code, rule.basis)
      : { numerator: 0n, denominator: 0n };
    const markupOf = (net: bigint) =>
      fraction.denominator > 0n
        ? divRound(net * fraction.numerator, fraction.denominator, 'halfAwayFromZero')
        : 0n;
    const lines: LineSpec[] = [];
    const taxEntries: TaxEntrySpec[] = [];
    const rates = new Set([...held.goods.keys(), ...input.rows.map((row) => row.rate)]);
    const differences: { rate: string; book: string; counted: string; difference: string }[] = [];
    let shortage = 0n;
    let adjustmentExpense: string | null = null;
    for (const rate of [...rates].sort()) {
      if (rateSegment(rate) === null) continue;
      const goods = held.goods.get(rate);
      const book = goods ? goods.debit - goods.credit : 0n;
      const counted = ron(input.rows.find((row) => row.rate === rate)?.counted ?? '0');
      const difference = counted - book;
      differences.push({
        rate,
        book: lei(book),
        counted: lei(counted),
        difference: lei(difference),
      });
      if (difference === 0n) continue;
      const accounts = retailAccountsOf(synthetics, warehouse.code, rate);
      if (difference < 0n) {
        const value = -difference;
        shortage += value;
        lines.push({
          account: accounts.goods,
          side: 'C',
          bani: value,
          analytics: { item: tag },
          memo: 'Lipsă la inventar, la preț de vânzare',
        });
        lines.push({
          account: '607',
          side: 'D',
          bani: value,
          memo: 'Lipsă la inventar, la preț de vânzare',
        });
        // Its deducted VAT, on its cost (the sale price less the VAT included and the markup).
        if (payer && input.cause !== undefined && input.cause === 'unimputable') {
          const vatIncluded = includedVat(value, rate);
          const cost = value - vatIncluded - markupOf(value - vatIncluded);
          const vat = (cost * BigInt(rate) * 2n + 100n) / 200n;
          if (vat > 0n) {
            adjustmentExpense ??= (() => {
              try {
                return rules.param<{ expense: string }>(
                  'ro.vat.stock_adjustment',
                  'vat_chargeability_date',
                  input.date,
                ).expense;
              } catch (error) {
                if (!(error instanceof RuleGapError)) throw error;
                issues.push(block('RULE_GAP', error.message));
                return null;
              }
            })();
            if (adjustmentExpense) {
              lines.push({
                account: adjustmentExpense,
                side: 'D',
                bani: vat,
                memo: `TVA ajustată, lipsă la cota ${rate}%`,
              });
              lines.push({
                account: '4426',
                side: 'C',
                bani: vat,
                memo: `TVA ajustată, lipsă la cota ${rate}%`,
              });
              taxEntries.push({
                key: `vat:retail:${rate}`,
                tax: 'VAT',
                code: adjustmentCodes.stock,
                direction: 'input',
                baseBani: 0n,
                taxBani: -vat,
                deductibleBani: -vat,
                ledgerBani: -vat,
                line: lines.length - 1,
                taxPoint: input.date,
                exigibility: input.date,
                taxPeriod,
                attributes: {
                  cause: 'unimputable',
                  warehouse: warehouse.code,
                  rate,
                  event: 'shortage',
                },
              });
            }
          }
        }
      } else {
        const vat = payer ? includedVat(difference, rate) : 0n;
        const markup = markupOf(difference - vat);
        const cost = difference - vat - markup;
        lines.push({
          account: accounts.goods,
          side: 'D',
          bani: difference,
          analytics: { item: tag },
          memo: 'Plus la inventar, la preț de vânzare',
        });
        if (vat)
          lines.push({
            account: accounts.vat,
            side: 'C',
            bani: vat,
            analytics: { item: tag },
            memo: 'TVA neexigibilă a plusului',
          });
        if (markup)
          lines.push({
            account: accounts.markup,
            side: 'C',
            bani: markup,
            analytics: { item: tag },
            memo: 'Adaosul plusului',
          });
        if (cost) lines.push({ account: '607', side: 'C', bani: cost, memo: 'Plus la inventar' });
      }
    }
    if (shortage) {
      if (input.cause === undefined)
        issues.push(
          block(
            'RETAIL_CAUSE',
            'Indicați cauza lipsei din decizia administratorului (cause): de ea depinde ajustarea TVA deduse (art. 304 din Codul fiscal).',
            'cause',
          ),
        );
      else if (input.cause === 'unimputable')
        issues.push(
          ack(
            'PROFIT_SHORTAGE',
            `Lipsurile neimputabile (${lei(shortage)} lei la preț de vânzare) și TVA lor nu sunt deductibile la impozitul pe profit (art. 25 alin. (4) lit. c) din Codul fiscal).`,
          ),
        );
      else {
        if (!input.causeEvidenceId || !loaded.evidence.has(input.causeEvidenceId))
          issues.push(
            block(
              'STOCK_CAUSE_PROOF',
              `Cauza lipsei (${input.cause}) se dovedește cu documentul ei (norme pct. 78 alin. (10), (12)).`,
              'causeEvidenceId',
            ),
          );
        if (input.cause === 'perishable')
          issues.push(
            ack(
              'STOCK_LOSS_LIMITS',
              'Lipsa este declarată perisabilitate în limitele legale: aplicația nu cunoaște limitele; peste ele, TVA se ajustează și cheltuiala nu se deduce. Confirmați încadrarea.',
            ),
          );
      }
    }
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };
    const effect: Effect = {
      schema: 'effect@1',
      date: input.date,
      journalClass: lines.length ? 'general' : 'memo',
      journalCode: 'DIVERSE',
      description: `Inventarierea gestiunii ${warehouse.code} la preț cu amănuntul, ${input.date}`,
      lines,
      openItems: [],
      taxEntries,
      schedules: [],
      explanation: {
        summary: lines.length
          ? `Inventarul gestiunii ${warehouse.code} la ${input.date}: ${differences
              .filter((row) => row.difference !== '0.00')
              .map((row) => `${row.difference} lei la ${row.rate}%`)
              .join(', ')} față de evidență.`
          : `Inventarul gestiunii ${warehouse.code} la ${input.date} corespunde evidenței.`,
        details: {
          warehouseId: warehouse.id,
          differences,
          coefficient: percent(fraction),
          ...(input.cause ? { cause: input.cause } : {}),
          clauses: [...RETAIL_CLAUSES, `${CODE}:art.304`, 'OMFP1802/2014:pct.289-292'],
        },
      },
    };
    return { effect, issues };
  },
};

/** Every treatment of the retail price method. */
export const retailMethodTreatments = [
  retailOpening,
  retailReprice,
  retailDischarge,
  retailCount,
] as const;
