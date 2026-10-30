import Decimal from 'decimal.js';
import { z } from 'zod';
import type { Issue, OpenItemState, ScheduleRow } from '../kernel';
import { divRound, parseScaled } from '../money';
import type { ParameterDefinition, ParameterVersion } from '../rules';
import { addMonthsToDate, daysBetween, isLocalDate, parseLocalDate, type LocalDate } from '../time';

/**
 * Loans and finance leases (OMFP nr. 1.802/2014, the functions of accounts 162, 166, 167, 168,
 * 455, 519 and 666): a loan is an open item of its lender on the account its kind and term give,
 * whose schedule holds the contract's plan. Its rows on the loan's own account are the principal
 * repayments, adding up to the amount borrowed; its rows on another account are each period's
 * interest, keyed by the period, on the account the interest is booked to: accrued month by month
 * on 168x, 5198 or 4558, or, for a finance lease, booked from the lessor's invoice on 666.
 * Amounts are in the loan's currency, in minor units.
 */

/** The accounts a loan is held on, with the account its interest accrues on and the term the
 * account is for: 162 long-term and 519 short-term bank credits, 166 debts to affiliated and
 * associated entities (interest on 1685, 1686), 167 other loans and a finance lease's liability
 * (1687), 4551 an associate's money (4558). */
export const loanAccounts: Readonly<
  Record<string, { interest: string; term: 'long' | 'short' | null; name: string }>
> = {
  '1621': { interest: '1682', term: 'long', name: 'Credite bancare pe termen lung' },
  '5191': { interest: '5198', term: 'short', name: 'Credite bancare pe termen scurt' },
  '1661': { interest: '1685', term: null, name: 'Datorii față de entitățile afiliate' },
  '1663': {
    interest: '1686',
    term: null,
    name: 'Datorii față de entitățile asociate și entitățile controlate în comun',
  },
  '167': { interest: '1687', term: null, name: 'Alte împrumuturi și datorii asimilate' },
  '4551': { interest: '4558', term: null, name: 'Acționari/asociați - conturi curente' },
};
export const loanAccountCodes = Object.keys(loanAccounts);
export const interestAccountCodes = Object.values(loanAccounts).map((item) => item.interest);
/** Where a finance lease's interest is booked: on the lessor's invoice, against 404 (OMFP
 * 1802/2014, the functions of accounts 404 and 666). */
export const LEASE_INTEREST_ACCOUNT = '666';

/** The OMFP clauses the treatments cite. */
export const financingClauses = {
  loans: 'OMFP1802/2014:conturi.16',
  shortTerm: 'OMFP1802/2014:conturi.519',
  associates: 'OMFP1802/2014:conturi.455',
  interest: 'OMFP1802/2014:conturi.666',
  lease: 'OMFP1802/2014:pct.212-215',
  leaseCurrency: 'OMFP1802/2014:pct.321',
  current: 'OMFP1802/2014:pct.360',
  withholding: 'ANAF/Cod-fiscal-consolidat:art.97(2)',
} as const;

/** The schedule's method: the contract's own rows, or rows computed from its terms. */
export type ScheduleMethod = 'contract' | 'annuity' | 'linear';
/** A finance lease's schedule: its instalments as the contract gives them, their interest booked
 * from the lessor's invoices. */
export const LEASE_METHOD = 'lease';
/** A finance lease whose instalments are invoiced and paid in lei at the rate of a currency: its
 * exchange differences are other financial items (668, 768), not exchange differences (665,
 * 765), by the functions of account 167. */
export const INDEXED_LEASE_METHOD = 'lease.indexed';
export const isLeaseMethod = (method: string | undefined) =>
  method === LEASE_METHOD || method === INDEXED_LEASE_METHOD;

const principalPrefix = 'principal:';
const interestPrefix = 'interest:';
/** A principal row's key: its due date. */
export const principalKey = (due: LocalDate) => `${principalPrefix}${due}`;
/** An interest row's key: the period it is for, from (exclusive) to (inclusive, its due date). */
export const interestKey = (from: LocalDate, to: LocalDate) => `${interestPrefix}${from}/${to}`;

/** The period of an interest row, from its key. */
export function interestPeriod(row: ScheduleRow): { from: LocalDate; to: LocalDate } | null {
  if (!row.key.startsWith(interestPrefix)) return null;
  const [from, to] = row.key.slice(interestPrefix.length).split('/');
  return from && to && isLocalDate(from) && isLocalDate(to) ? { from, to } : null;
}

/** One instalment as a contract states it, amounts in minor units of the loan's currency. */
export interface Instalment {
  due: LocalDate;
  principal: bigint;
  interest: bigint;
  /** The start of the period its interest is for; the previous instalment's due date, or the
   * loan's start for the first. */
  from?: LocalDate;
}

/** A loan's terms, when its contract gives them rather than rows: an annual rate in percent,
 * monthly instalments from `firstDue`, the interest of each month a twelfth of the yearly rate on
 * the balance (30/360), rounded half up to the minor unit. */
export interface LoanTerms {
  method: 'annuity' | 'linear';
  /** Annual rate in percent, e.g. "7.5". */
  rate: string;
  months: number;
  firstDue: LocalDate;
}

const monthlyInterest = (balance: bigint, rate: bigint) =>
  // rate is in percent with 6 decimals: balance × rate / 100 / 12.
  divRound(balance * rate, 1_200_000_000n, 'halfAwayFromZero');

/**
 * Instalments computed from a loan's terms: equal instalments (annuity), their principal the
 * instalment less the month's interest and the last one closing the balance; or equal principal
 * parts (linear), the remainder on the first, with the month's interest on top.
 */
export function instalmentsFrom(principal: bigint, terms: LoanTerms): Instalment[] {
  const rate = parseScaled(terms.rate, 6);
  const dues = Array.from({ length: terms.months }, (_, index) =>
    addMonthsToDate(terms.firstDue, index),
  );
  const rows: Instalment[] = [];
  let balance = principal;
  if (terms.method === 'linear') {
    const base = principal / BigInt(terms.months);
    const remainder = principal - base * BigInt(terms.months);
    dues.forEach((due, index) => {
      const part = base + (index === 0 ? remainder : 0n);
      rows.push({ due, principal: part, interest: monthlyInterest(balance, rate) });
      balance -= part;
    });
    return rows;
  }
  // P × r / (1 − (1 + r)^−n), with r the monthly rate; at a zero rate, equal parts.
  const monthly = new Decimal(terms.rate).div(1200);
  const payment = monthly.isZero()
    ? new Decimal(principal.toString()).div(terms.months)
    : new Decimal(principal.toString())
        .mul(monthly)
        .div(new Decimal(1).minus(monthly.plus(1).pow(-terms.months)));
  const instalment = BigInt(payment.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0));
  dues.forEach((due, index) => {
    const interest = monthlyInterest(balance, rate);
    const last = index === dues.length - 1;
    const part = last ? balance : instalment - interest < balance ? instalment - interest : balance;
    rows.push({ due, principal: part, interest });
    balance -= part;
  });
  return rows;
}

/**
 * A loan's schedule from its instalments: an interest row on `interestAccount` for each
 * instalment that pays some, keyed by its period, and a principal row on the loan account for
 * each that repays some. The first period starts on `start`, each next one on the previous due date.
 */
export function loanSchedule(
  instalments: readonly Instalment[],
  start: LocalDate,
  loanAccount: string,
  interestAccount: string,
): { rows: ScheduleRow[]; issues: Issue[] } {
  const issues: Issue[] = [];
  const rows: ScheduleRow[] = [];
  let from = start;
  const block = (message: string, index: number) =>
    issues.push({ code: 'SCHEDULE', severity: 'block', message, path: `instalments.${index}` });
  instalments.forEach((instalment, index) => {
    const periodStart = instalment.from ?? from;
    if (instalment.due < from || (index > 0 && instalment.due <= from))
      block('Ratele se succed în ordinea scadențelor, după începutul împrumutului.', index);
    if (instalment.interest > 0n && (periodStart >= instalment.due || periodStart < start))
      block('Perioada dobânzii se încheie la scadență și începe după acordare.', index);
    if (instalment.principal < 0n || instalment.interest < 0n)
      block('Rata și dobânda nu pot fi negative.', index);
    if (instalment.principal === 0n && instalment.interest === 0n)
      block('Rata nu are nici principal, nici dobândă.', index);
    // In the order the ledger keeps a schedule's rows: by due date, then key.
    if (instalment.interest > 0n)
      rows.push({
        key: interestKey(periodStart, instalment.due),
        due: instalment.due,
        bani: instalment.interest,
        counterAccount: interestAccount,
      });
    if (instalment.principal > 0n)
      rows.push({
        key: principalKey(instalment.due),
        due: instalment.due,
        bani: instalment.principal,
        counterAccount: loanAccount,
      });
    from = instalment.due;
  });
  return { rows, issues };
}

/** The principal rows of a loan's schedule: those on its own account. */
export const principalRows = (rows: readonly ScheduleRow[], loanAccount: string) =>
  rows.filter((row) => row.counterAccount === loanAccount);

/** The interest rows booked on an account, with their periods. */
export function interestRows(rows: readonly ScheduleRow[], account?: string) {
  return rows.flatMap((row) => {
    const period = interestPeriod(row);
    return period && (account === undefined || row.counterAccount === account)
      ? [{ ...row, ...period }]
      : [];
  });
}

/**
 * The interest a schedule has accrued through a day, on its interest account: each period's
 * interest in full once it has ended, and for the period running, its share by the days elapsed,
 * rounded half up. Through a period's end it reaches the period's interest exactly, so a monthly
 * accrual of the difference is cumulative and never books twice.
 */
export function interestAccrued(rows: readonly ScheduleRow[], through: LocalDate): bigint {
  let total = 0n;
  for (const row of interestRows(rows)) {
    if (row.to <= through) total += row.bani;
    else if (row.from < through)
      total += divRound(
        row.bani * BigInt(daysBetween(row.from, through)),
        BigInt(daysBetween(row.from, row.to)),
        'halfAwayFromZero',
      );
  }
  return total;
}

/** The principal a schedule has due through a day, in the loan's currency. */
export const principalDue = (
  rows: readonly ScheduleRow[],
  loanAccount: string,
  through: LocalDate,
) =>
  principalRows(rows, loanAccount)
    .filter((row) => row.due <= through)
    .reduce((sum, row) => sum + row.bani, 0n);

/** What a loan still owes in its currency (positive), from its signed balance. */
export const owed = (item: Pick<OpenItemState, 'currency' | 'balanceBani' | 'balanceMinor'>) => {
  const amount = item.currency === 'RON' ? item.balanceBani : item.balanceMinor;
  return -amount;
};

/**
 * The part of a loan due within twelve months after a day (OMFP 1802/2014 pct. 360: a current
 * liability is one due within 12 months of the balance sheet date): its schedule's principal due
 * by then, overdue included, less what was already repaid, within what it still owes.
 */
export function currentPortion(
  rows: readonly ScheduleRow[],
  loanAccount: string,
  stillOwed: bigint,
  at: LocalDate,
): bigint {
  const principal = principalRows(rows, loanAccount);
  const total = principal.reduce((sum, row) => sum + row.bani, 0n);
  const repaid = total - stillOwed;
  const horizon = addMonthsToDate(at, 12);
  const due = principal
    .filter((row) => row.due <= horizon)
    .reduce((sum, row) => sum + row.bani, 0n);
  const current = due - repaid;
  return current <= 0n ? 0n : current > stillOwed ? stillOwed : current;
}

/** The carrying amount in lei a settlement of `minor` currency units releases from an item held
 * in a currency: all of it when the whole balance is settled, else its share, half up. */
export function carryingRelease(balanceBani: bigint, balanceMinor: bigint, minor: bigint): bigint {
  const bani = balanceBani < 0n ? -balanceBani : balanceBani;
  const units = balanceMinor < 0n ? -balanceMinor : balanceMinor;
  if (minor === units) return bani;
  if (units === 0n) return 0n;
  return divRound(bani * minor, units, 'halfAwayFromZero');
}

/** Whether a loan account's term fits the contract: long-term bank credits run over a year from
 * the drawdown, short-term ones within it. */
export function termMismatch(account: string, start: LocalDate, lastDue: LocalDate) {
  const term = loanAccounts[account]?.term;
  if (!term) return false;
  const longer = lastDue > addMonthsToDate(start, 12);
  return term === 'long' ? !longer : longer;
}

export const interestDefinitions: ParameterDefinition[] = [
  {
    key: 'ro.interest.tax_rate',
    axis: 'payment_date',
    continuity: 'block',
    scope: ['beneficiary'],
    value: z.string().regex(/^(0|[1-9]\d{0,2})(\.\d{1,4})?$/),
    description:
      'Cota impozitului pe veniturile din dobânzi ale persoanelor fizice din contracte civile, reținut de plătitor la plata dobânzii.',
  },
];

// Read in ANAF's consolidated Fiscal Code (updated through Legea nr. 204/2026): interest from
// civil contracts is taxed at 10%, a final tax computed and withheld when the interest is paid.
// Only the text in force in 2026 was read; earlier payments are a gap.
export const interestVersions: ParameterVersion[] = [
  {
    id: 'ro.interest.tax_rate/individual/2026-01-01',
    key: 'ro.interest.tax_rate',
    scope: { beneficiary: 'individual' },
    value: '10',
    from: parseLocalDate('2026-01-01'),
    to: null,
    reviewedThrough: parseLocalDate('2026-12-31'),
    knowledgeDate: null,
    status: 'extracted',
    clauses: [financingClauses.withholding],
  },
];
