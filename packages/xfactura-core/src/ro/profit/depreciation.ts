import type { AssetFiscalBasis, AssetState, Issue } from '../../kernel';
import { divRound, formatMoney, parseMoney, parseScaled } from '../../money';
import type { RuleContext } from '../../rules';
import type { LocalDate } from '../../time';
import type { DepreciationRules, SuperAccelerated } from './parameters';

/*
 * Fiscal depreciation (Codul fiscal art. 28), kept apart from the book depreciation the ledger
 * holds: each fixed asset's fiscal basis (method, fiscal value, normal life, whether it is a
 * capped M1 passenger car), recorded on the register with its evidence, gives what the profit tax
 * deducts in a period. Depreciation starts the month after commissioning (alin. (12) lit. a));
 * at disposal the fiscal value left is deducted (alin. (17)). Amounts are in bani, each month's
 * part rounded so the parts add up to the fiscal value.
 */

export const fiscalMethods = [
  /** Equal yearly parts over the normal life (alin. (6)); constructions always. */
  'linear',
  /** The linear rate times 1.5, 2.0 or 2.5 on the value left, then linear once that is no less
   * (alin. (7), norme pct. 25). */
  'degressive',
  /** At most 50% in the first year, then the rest linearly over the life left (alin. (8)). */
  'accelerated',
  /** At most 65% in the first year, for new assets of subgroups 2.1 and 2.4 put into use in 2026
   * (alin. (8^1)). */
  'superaccelerated',
  /** Deducted in full when put into use: assets for preventing work accidents and occupational
   * diseases (alin. (20)), D101 rd. 11.1. */
  'full_safety',
  /** Assets for setting up and running medical offices (alin. (20)), rd. 11.2. */
  'full_medical',
  /** An item below the value of alin. (2) lit. b) the company chose to deduct in full when put
   * into use (alin. (21), norme pct. 31), rd. 11.3. */
  'full_low_value',
  /** Not depreciable fiscally (alin. (4)): nothing is deducted. */
  'none',
] as const;
export type FiscalMethod = (typeof fiscalMethods)[number];

/** A fixed asset's fiscal basis as the register records it (`AssetState.fiscal`), its method
 * one of `fiscalMethods`; amounts in bani. */
export type FiscalBasis = AssetFiscalBasis & { method: FiscalMethod };

/** Whether a recorded basis names a method this module computes. */
export const isFiscalBasis = (basis: AssetFiscalBasis): basis is FiscalBasis =>
  (fiscalMethods as readonly string[]).includes(basis.method);

/** What one asset deducts in a period. */
export interface AssetDeduction {
  assetId: string;
  number: string;
  method: FiscalMethod;
  /** Depreciation of the months in the period, after the M1 cap. */
  depreciation: bigint;
  /** The fiscal value left when the asset left use in the period, after the M1 cap. */
  disposal: bigint;
  /** The full deduction when put into use in the period (the `full_*` methods). */
  full: bigint;
  /** What the M1 cap kept out of the deduction. */
  capped: bigint;
}

const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
const block = (code: string, message: string, details?: Issue['details']): Issue => ({
  code,
  severity: 'block',
  message,
  ...(details === undefined ? {} : { details }),
});

/** The catalogue subgroup of an asset's classification code (`2.1.16.1` is `2.1`). */
export const subgroupOf = (catalogCode: string) => catalogCode.split('.').slice(0, 2).join('.');

/** The degressive coefficient for a normal life in years, or null when the law gives none. */
function coefficient(rules: DepreciationRules, years: number): bigint | null {
  if (years < rules.degressiveMinYears) return null;
  const row = rules.degressive.find((item) => item.maxYears === null || years <= item.maxYears);
  return row ? parseScaled(row.factor, 4) : null;
}

/**
 * The fiscal depreciation of an asset by the end of its m-th month of use (m = 0 the month it
 * was put into use), before any cap: each year's part spread equally over its months, each
 * month rounded so the months add up to the year and the years to the value.
 */
export function fiscalThrough(
  basis: FiscalBasis,
  months: number,
  rules: DepreciationRules,
  firstYearCap: string,
): bigint {
  if (months <= 0 || basis.method === 'none') return 0n;
  const life = basis.lifeMonths;
  const value = basis.value;
  if (basis.method.startsWith('full_')) return value;
  if (months >= life) return value;
  if (basis.method === 'linear')
    return divRound(value * BigInt(months), BigInt(life), 'halfAwayFromZero');
  // The yearly parts of the degressive and accelerated methods, then month by month.
  const years = life / 12;
  const parts: bigint[] = [];
  let remaining = value;
  if (basis.method === 'degressive') {
    const factor = coefficient(rules, years)!;
    let linear: bigint | null = null;
    for (let year = 1; year <= years; year++) {
      const left = BigInt(years - year + 1);
      if (year === years) {
        parts.push(remaining);
        break;
      }
      const degressive = divRound(remaining * factor, 10_000n * BigInt(years), 'halfAwayFromZero');
      const straight = divRound(remaining, left, 'halfAwayFromZero');
      if (linear === null && degressive <= straight) linear = straight;
      const part = linear ?? degressive;
      parts.push(part);
      remaining -= part;
    }
  } else {
    const share = basis.firstYearPercent ?? firstYearCap;
    const first = divRound(value * parseScaled(share, 4), 1_000_000n, 'halfAwayFromZero');
    parts.push(first);
    remaining -= first;
    for (let year = 2; year <= years; year++) {
      const part =
        year === years ? remaining : divRound(value - first, BigInt(years - 1), 'halfAwayFromZero');
      parts.push(part);
      remaining -= part;
    }
  }
  const year = Math.floor((months - 1) / 12);
  const before = parts.slice(0, year).reduce((sum, part) => sum + part, 0n);
  const within = BigInt(months - year * 12);
  return before + divRound(parts[year]! * within, 12n, 'halfAwayFromZero');
}

/** The checks a basis must pass against the rules for its method; empty when it may be used. */
export function basisIssues(
  asset: Pick<AssetState, 'number' | 'commissionedOn' | 'catalogCode'>,
  basis: FiscalBasis,
  rules: DepreciationRules,
  read: {
    superAccelerated: () => SuperAccelerated;
    threshold: () => string;
  },
): Issue[] {
  const issues: Issue[] = [];
  const at = `${asset.number}: `;
  if (['degressive', 'accelerated', 'superaccelerated'].includes(basis.method)) {
    if (basis.lifeMonths % 12 !== 0)
      issues.push(
        block(
          'FISCAL_LIFE',
          `${at}regimul ${basis.method} se aplică pe ani întregi de durată normală (${basis.lifeMonths} luni).`,
        ),
      );
    if (basis.method === 'degressive' && coefficient(rules, basis.lifeMonths / 12) === null)
      issues.push(
        block(
          'FISCAL_METHOD',
          `${at}amortizarea degresivă nu are coeficient pentru o durată de ${basis.lifeMonths / 12} ani (art. 28 alin. (7)).`,
        ),
      );
  }
  if (basis.method === 'accelerated' || basis.method === 'superaccelerated') {
    const cap =
      basis.method === 'accelerated'
        ? rules.acceleratedFirstYear
        : read.superAccelerated().firstYear;
    if (
      basis.firstYearPercent !== null &&
      parseScaled(basis.firstYearPercent, 4) > parseScaled(cap, 4)
    )
      issues.push(
        block(
          'FISCAL_FIRST_YEAR',
          `${at}în primul an se deduce cel mult ${cap}% din valoarea fiscală (art. 28 alin. (8)${basis.method === 'superaccelerated' ? ', (8^1)' : ''}).`,
        ),
      );
  }
  if (basis.method === 'superaccelerated') {
    const allowed = read.superAccelerated();
    if (!basis.newAsset || !allowed.subgroups.includes(subgroupOf(asset.catalogCode)))
      issues.push(
        block(
          'FISCAL_METHOD',
          `${at}amortizarea superaccelerată se aplică doar activelor noi din subgrupele ${allowed.subgroups.join(', ')} puse în funcțiune în 2026 (art. 28 alin. (8^1)).`,
        ),
      );
  }
  if (basis.method === 'full_low_value' && basis.value >= parseMoney(read.threshold(), 'RON'))
    issues.push(
      block(
        'FISCAL_METHOD',
        `${at}valoarea fiscală (${formatMoney(basis.value, 'RON')} lei) atinge limita de ${read.threshold()} lei: nu se deduce integral (art. 28 alin. (2) lit. b), (21)).`,
      ),
    );
  return issues;
}

/**
 * What an asset deducts from `from` to `to`: the depreciation of the months of use in the range
 * (from the month after commissioning to the month before it left use), the fiscal value left
 * when it left use in the range, or its whole value when a `full_*` method deducts it at
 * commissioning; an M1 car's months capped at the monthly amount, and its value left at the cap
 * times the months of life left (norme pct. 27).
 */
export function assetDeduction(
  asset: AssetState,
  basis: FiscalBasis,
  period: { from: LocalDate; to: LocalDate },
  rules: DepreciationRules,
  firstYearCap: string,
): AssetDeduction {
  const result: AssetDeduction = {
    assetId: asset.id,
    number: asset.number,
    method: basis.method,
    depreciation: 0n,
    disposal: 0n,
    full: 0n,
    capped: 0n,
  };
  const start = monthIndex(asset.commissionedOn);
  const first = monthIndex(period.from);
  const last = monthIndex(period.to);
  const disposed = asset.disposedOn ? monthIndex(asset.disposedOn) : null;
  if (basis.method.startsWith('full_')) {
    if (asset.commissionedOn >= period.from && asset.commissionedOn <= period.to)
      result.full = basis.value;
    return result;
  }
  if (basis.method === 'none') return result;
  const cap = basis.m1 ? parseMoney(rules.m1MonthlyCap, 'RON') : null;
  const through = (months: number) => fiscalThrough(basis, months, rules, firstYearCap);
  const end = disposed === null ? last : Math.min(last, disposed - 1);
  for (let month = Math.max(first, start + 1); month <= end; month++) {
    const part = through(month - start) - through(month - start - 1);
    const allowed = cap !== null && part > cap ? cap : part;
    result.depreciation += allowed;
    result.capped += part - allowed;
  }
  if (disposed !== null && disposed >= first && disposed <= last) {
    const used = Math.max(0, disposed - start - 1);
    const left = basis.value - through(used);
    const monthsLeft = BigInt(Math.max(0, basis.lifeMonths - used));
    const allowed = cap !== null && left > cap * monthsLeft ? cap * monthsLeft : left;
    result.disposal = allowed;
    result.capped += left - allowed;
  }
  return result;
}

/** The parameters fiscal depreciation reads for the year a deduction is computed in. */
export function depreciationRulesOf(rules: RuleContext, yearStart: LocalDate) {
  return rules.param<DepreciationRules>('ro.profit.depreciation', 'fiscal_year_start', yearStart);
}
