import type { Issue } from '../../kernel';
import { divRound, formatMoney, parseScaled } from '../../money';
import { natureOf, type LimitKey, type NatureCode } from './natures';
import type { CasRule, CassRule, LossRule, PitLimits } from './parameters';

/**
 * The Registrul de evidență fiscală (OMFP nr. 3.254/2017) and the annual tax and contributions of
 * an individual with independent income (Codul fiscal art. 68, 69, 118, 148, 170, 174), as pure
 * calculations over amounts in bani. The engine feeds them the cash-basis natures of the
 * Registrul-jurnal and the non-cash items; the parameters come from the rule register.
 */

export type Rounding = 'leu_half_down';
const sum = (values: readonly bigint[]) => values.reduce((total, value) => total + value, 0n);
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const lei = (bani: bigint) => formatMoney(bani, 'RON');
const block = (code: string, message: string): Issue => ({ code, severity: 'block', message });
const info = (code: string, message: string): Issue => ({ code, severity: 'info', message });

/** Bani rounded to whole lei (art. 66): up to 50 bani inclusive are dropped, more go to the leu. */
export function toLeu(bani: bigint, _rounding: Rounding = 'leu_half_down'): bigint {
  const sign = bani < 0n ? -1n : 1n;
  const value = bani * sign;
  const whole = value / 100n;
  return sign * (value % 100n > 50n ? whole + 1n : whole) * 100n;
}

/** `amount × percent / 100`, half away from zero to the ban. */
export const percentOf = (amount: bigint, percent: string) =>
  divRound(amount * parseScaled(percent, 4), 1_000_000n, 'halfAwayFromZero');

/** A euro amount in bani at a rate in lei per euro. */
export const euroToBani = (euro: string, rate: string) =>
  divRound(BigInt(euro) * parseScaled(rate, 4) * 100n, 10_000n, 'halfAwayFromZero');

export interface SourceAmounts {
  /** Cash-basis nature parts of the source's receipts and payments, money in positive. */
  parts: readonly { nature: NatureCode; flow: bigint }[];
  /** Items with no receipt or payment in the year (fiscal depreciation, expense reports against
   * an advance, in-kind income): income positive, expense negative. */
  nonCash: readonly { nature: NatureCode; flow: bigint; label: string }[];
}

export interface RegisterLine {
  nature: NatureCode;
  label: string;
  bani: bigint;
}

export interface ExpenseLine extends RegisterLine {
  /** What art. 68 lets deduct of it. */
  deductible: bigint;
  limit: LimitKey | null;
}

export interface RealSource {
  income: RegisterLine[];
  expenses: ExpenseLine[];
  /** Not income and not deductible: kept out of the register (OMFP nr. 3.254/2017 art. 4–5). */
  excluded: RegisterLine[];
  gross: bigint;
  /** Art. 68 alin. (6): gross income less deductible expenses other than scholarships and
   * protocol. */
  base: bigint;
  deductible: bigint;
  /** The register's totals in whole lei: gross, deductible, and net income or loss. */
  totals: { gross: bigint; deductible: bigint; net: bigint; loss: bigint };
  issues: Issue[];
}

export interface RealParams {
  limits: PitLimits;
  rounding: Rounding;
  /** BNR's average EUR rate of the year (norme pct. 7 alin. (6)); null when not given. */
  eurRate: string | null;
  /** The people a per-person limit counts (the owner of a PFA or II). */
  persons: number;
}

const eurLimits: Partial<Record<LimitKey, keyof PitLimits>> = {
  association: 'associationEur',
  pension: 'pensionEur',
  occupationalPension: 'occupationalPensionEur',
  pepp: 'peppEur',
  health: 'healthEur',
  sport: 'sportEur',
  etf: 'etfEur',
};
/** The association fee limit is the payer's, not per person (lit. p)). */
const perPerson = (key: LimitKey) => key !== 'association';

/**
 * A source's net income in the real system (art. 68): gross income from receipts and in-kind
 * items; expenses paid, in full or within their limits, in the order the article sets them: first
 * vehicles, the percentages of gross income and of salary costs, and the euro amounts; then the
 * base of alin. (6), from which protocol and scholarships are limited.
 */
export function realSourceIncome(amounts: SourceAmounts, params: RealParams): RealSource {
  const issues: Issue[] = [];
  const byNature = new Map<NatureCode, bigint>();
  for (const part of [...amounts.parts, ...amounts.nonCash])
    byNature.set(part.nature, (byNature.get(part.nature) ?? 0n) + part.flow);
  const income: RegisterLine[] = [];
  const claimed: { nature: NatureCode; bani: bigint }[] = [];
  const excluded: RegisterLine[] = [];
  for (const [nature, flow] of byNature) {
    if (flow === 0n) continue;
    const known = natureOf(nature);
    if (!known) {
      issues.push(
        block(
          'PIT_NATURE_MISSING',
          `Încasări și plăți de ${lei(flow < 0n ? -flow : flow)} lei nu au o natură (${nature}): clasificați-le înainte de a stabili venitul net.`,
        ),
      );
      continue;
    }
    if (known.kind === 'income') income.push({ nature, label: known.label, bani: flow });
    else if (known.kind === 'expense' || known.kind === 'limited')
      claimed.push({ nature, bani: -flow });
    else if (known.kind === 'excluded' || known.kind === 'asset')
      excluded.push({ nature, label: known.label, bani: flow < 0n ? -flow : flow });
  }
  const gross = sum(income.map((line) => line.bani));
  const limits = params.limits;
  const salaries = sum(
    claimed.filter((line) => line.nature === 'expense.salary').map((line) => line.bani),
  );
  const expenses: ExpenseLine[] = claimed.map(({ nature, bani }) => {
    const known = natureOf(nature)!;
    return { nature, label: known.label, bani, deductible: bani, limit: known.limit ?? null };
  });
  const cap = (line: ExpenseLine, limit: bigint) => {
    line.deductible = max(0n, min(line.bani, limit));
  };
  for (const line of expenses) {
    if (!line.limit) continue;
    if (line.limit === 'vehicle')
      line.deductible = line.bani - percentOf(line.bani, limits.vehiclePercent);
    else if (line.limit === 'professional')
      cap(line, percentOf(max(gross, 0n), limits.professionalPercent));
    else if (line.limit === 'social') cap(line, percentOf(salaries, limits.socialPercent));
    else if (line.limit === 'employer')
      issues.push(
        info(
          'PIT_EMPLOYER_LIMIT',
          'Contribuțiile datorate ca angajator sunt la art. 68 alin. (5) lit. k) fără o limită numerică: deduse integral până la răspunsul expertului contabil.',
        ),
      );
    else if (eurLimits[line.limit]) {
      if (!params.eurRate) {
        cap(line, 0n);
        issues.push(
          block(
            'PIT_EUR_RATE',
            `${line.label}: limita în euro se transformă la cursul mediu BNR al anului plății (norme pct. 7 alin. (6)); indicați cursul.`,
          ),
        );
      } else
        cap(
          line,
          euroToBani(limits[eurLimits[line.limit]!], params.eurRate) *
            BigInt(perPerson(line.limit) ? params.persons : 1),
        );
    }
  }
  const late = (line: ExpenseLine) => line.limit === 'protocol' || line.limit === 'scholarship';
  const base = gross - sum(expenses.filter((line) => !late(line)).map((line) => line.deductible));
  for (const line of expenses)
    if (line.limit === 'protocol') cap(line, percentOf(max(base, 0n), limits.protocolPercent));
    else if (line.limit === 'scholarship')
      cap(line, percentOf(max(base, 0n), limits.scholarshipPercent));
  const deductible = sum(expenses.map((line) => line.deductible));
  const grossLei = toLeu(gross, params.rounding);
  const deductibleLei = toLeu(deductible, params.rounding);
  const net = grossLei - deductibleLei;
  return {
    income,
    expenses,
    excluded,
    gross,
    base,
    deductible,
    totals: {
      gross: grossLei,
      deductible: deductibleLei,
      net: max(net, 0n),
      loss: max(-net, 0n),
    },
    issues,
  };
}

export interface NormInput {
  /** The norm the DGRFP published for the activity and place, in bani. */
  norm: bigint;
  /** The highest increasing and reducing correction coefficients that apply (norme pct. 8 alin.
   * (7): only the highest of each counts). */
  increasePercent: string | null;
  reductionPercent: string | null;
  /** Days of activity in the year, when less than all of it (art. 69 alin. (5)). */
  activeDays: number | null;
  /** 12 minimum wages on 1 January (art. 69 alin. (3)); null when the year's text sets none. */
  floor: bigint | null;
}

/**
 * The adjusted norm (art. 69 alin. (5), (10); norme pct. 8 alin. (6)–(10), (14)): increased by the
 * highest increasing coefficient, the result reduced by the highest reducing one, then reduced
 * pro rata to the days of activity out of 365, rounded to the leu.
 */
export function adjustedNorm(input: NormInput, rounding: Rounding) {
  const issues: Issue[] = [];
  if (input.floor !== null && input.norm < input.floor)
    issues.push(
      block(
        'PIT_NORM_FLOOR',
        `Norma de venit (${lei(input.norm)} lei) este sub 12 salarii minime brute pe țară (${lei(input.floor)} lei, art. 69 alin. (3)).`,
      ),
    );
  const increase = input.increasePercent ? percentOf(input.norm, input.increasePercent) : 0n;
  const reduction = input.reductionPercent
    ? percentOf(input.norm + increase, input.reductionPercent)
    : 0n;
  const year = input.norm + increase - reduction;
  const prorated =
    input.activeDays === null
      ? year
      : divRound(year * BigInt(input.activeDays), 365n, 'halfAwayFromZero');
  return { increase, reduction, adjusted: toLeu(prorated, rounding), issues };
}

export interface LossVintage {
  year: number;
  /** What is left to offset, in bani. */
  bani: bigint;
}

/**
 * Losses carried forward against a source's net income (art. 118 alin. (4)–(5)): the oldest
 * first, together at most the rule's share of the net income, each within its window; a loss
 * still unused when its window closes is definitive. Losses of years before `legacyBefore` keep
 * the older window (D212 instructions, cap. I sec. 1 rd. 6).
 */
export function offsetLosses(
  year: number,
  net: bigint,
  vintages: readonly LossVintage[],
  rule: LossRule,
  rounding: Rounding,
) {
  const window = (vintage: LossVintage) =>
    vintage.year < rule.legacyBefore ? rule.legacyYears : rule.years;
  const open = [...vintages]
    .filter((vintage) => vintage.year < year && year - vintage.year <= window(vintage))
    .sort((a, b) => a.year - b.year);
  const available = sum(open.map((vintage) => vintage.bani));
  const cap = net > 0n ? toLeu(percentOf(net, rule.sharePercent), rounding) : 0n;
  const offset = min(available, cap);
  let left = offset;
  const remaining: LossVintage[] = [];
  const expired: LossVintage[] = [];
  for (const vintage of open) {
    const used = min(left, vintage.bani);
    left -= used;
    const rest = { year: vintage.year, bani: vintage.bani - used };
    if (rest.bani === 0n) continue;
    if (year - vintage.year >= window(vintage)) expired.push(rest);
    else remaining.push(rest);
  }
  return { available, cap, offset, recalculated: net - offset, remaining, expired };
}

export type CasStatus = 'liable' | 'pensioner' | 'own_system';

export interface CasInput {
  /** Net incomes and norms of the year cumulated (art. 148 alin. (3)), in whole lei. */
  cumulated: bigint;
  status: CasStatus;
  /** Opted to pay below the threshold (art. 148 alin. (4)). */
  option: boolean;
  /** The income chosen as base (art. 148 alin. (2)); null for the least the law allows. */
  chosen: bigint | null;
}

/** CAS of the self-employed (art. 148, 150, 151): the base is the chosen income, at least 12 or
 * 24 minimum wages by the cumulated income; nothing below 12 wages unless opted for. */
export function casDue(
  input: CasInput,
  params: { minimumWage: bigint; rate: string; rule: CasRule; rounding: Rounding },
) {
  const issues: Issue[] = [];
  const threshold = params.minimumWage * BigInt(params.rule.thresholdWages);
  const upper = params.minimumWage * BigInt(params.rule.upperBaseWages);
  const lower = params.minimumWage * BigInt(params.rule.lowerBaseWages);
  if (input.status !== 'liable')
    return { threshold, minimumBase: 0n, base: 0n, due: 0n, exempt: true, issues };
  const liable = input.cumulated >= threshold || input.option;
  if (!liable) return { threshold, minimumBase: 0n, base: 0n, due: 0n, exempt: false, issues };
  const minimumBase = input.cumulated >= upper ? upper : lower;
  if (input.chosen !== null && input.chosen < minimumBase)
    issues.push(
      block(
        'CAS_BASE',
        `Venitul ales pentru CAS (${lei(input.chosen)} lei) este sub baza minimă de ${lei(minimumBase)} lei (art. 148 alin. (2)).`,
      ),
    );
  const base = max(input.chosen ?? minimumBase, minimumBase);
  return {
    threshold,
    minimumBase,
    base,
    due: toLeu(percentOf(base, params.rate), params.rounding),
    exempt: false,
    issues,
  };
}

/**
 * CASS on independent income (art. 170 alin. (1), art. 174): the cumulated net incomes and norms,
 * losses not counted, capped; nothing on a loss or zero income; below the minimum, CASS on the
 * minimum unless one of art. 174 alin. (7)–(8)'s exceptions applies. The difference up to the
 * minimum is not deductible (art. 118 alin. (2) lit. b)).
 */
export function cassDue(
  input: { cumulated: bigint; exception: boolean },
  params: { minimumWage: bigint; rate: string; rule: CassRule; rounding: Rounding },
) {
  const cap = params.minimumWage * BigInt(params.rule.maximumWages);
  const minimum = params.minimumWage * BigInt(params.rule.minimumWages);
  const capped = min(max(input.cumulated, 0n), cap);
  if (capped === 0n) return { cap, minimum, base: 0n, due: 0n, minimumDifference: 0n };
  const own = toLeu(percentOf(capped, params.rate), params.rounding);
  if (capped >= minimum || input.exception)
    return { cap, minimum, base: capped, due: own, minimumDifference: 0n };
  const due = toLeu(percentOf(minimum, params.rate), params.rounding);
  return { cap, minimum, base: minimum, due, minimumDifference: due - own };
}

/**
 * The contributions deducted from the recalculated net income (art. 118 alin. (2^2)–(2^4)): each
 * in proportion to the real-system net income within its cumulated total, the CASS without the
 * minimum's difference, together at most the recalculated net income.
 */
export function deductibleContributions(
  input: {
    realNet: bigint;
    recalculated: bigint;
    cas: { due: bigint; cumulated: bigint };
    cass: { due: bigint; minimumDifference: bigint; cumulated: bigint };
  },
  rounding: Rounding,
) {
  const share = (amount: bigint, total: bigint) =>
    total > 0n && amount > 0n
      ? toLeu(divRound(amount * min(input.realNet, total), total, 'halfAwayFromZero'), rounding)
      : 0n;
  const cas = min(share(input.cas.due, input.cas.cumulated), max(input.recalculated, 0n));
  const cass = min(
    share(input.cass.due - input.cass.minimumDifference, input.cass.cumulated),
    max(input.recalculated - cas, 0n),
  );
  return { cas, cass };
}

/** The tax on a taxable income at a rate, rounded to the leu (art. 64, 66, 123). */
export const incomeTax = (taxable: bigint, rate: string, rounding: Rounding) =>
  toLeu(percentOf(max(taxable, 0n), rate), rounding);
