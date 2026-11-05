import { divRound, parseScaled } from '../../money';
import type { RuleContext } from '../../rules';
import type { LocalDate } from '../../time';
import type { LossCarryforward } from './parameters';

/*
 * Tax loss vintages (Codul fiscal art. 31): each year's loss, recovered from later taxable
 * profits in the order the losses arose, at each payment of the tax, within 70% of the profit
 * (both the losses from 2024 and those of 2016–2023 left at 31.12.2023 count towards it,
 * alin. (8)) and within the years their version allows: 5 for losses from 2024, what remains of
 * 7 for the older ones. Amounts are in whole lei, as the returns declare them.
 */

export interface LossVintage {
  /** The year the loss arose in. */
  year: number;
  /** The loss the year's return declared. */
  amount: bigint;
  /** What is left to recover. */
  remaining: bigint;
}

export interface Recovery {
  /** The losses still within their years at the start of `year` (D101 rd. 39). */
  available: bigint;
  /** What the year's profit recovers (rd. 39^1). */
  recovered: bigint;
  /** The cap: the share of the profit (in whole lei, never above it). */
  cap: bigint;
  /** Each vintage used, in the order the losses arose. */
  used: { year: number; amount: bigint }[];
  /** The vintages after the recovery, those past their years dropped. */
  after: LossVintage[];
  /** Vintages whose years ended before `year`, with what was left of them. */
  expired: LossVintage[];
  /** The parameter versions read, by vintage year. */
  rules: Record<number, LossCarryforward>;
}

const yearStart = (year: number) => `${year}-01-01` as LocalDate;

/**
 * Recovers the vintages from a year's taxable profit before the recovery (`profit`, whole lei):
 * a vintage is usable in the `years` calendar years after its own. `profitYears`, when given,
 * counts only those years towards a vintage's limit (the reading in which the years spent as a
 * micro-enterprise do not count, art. 31 alin. (5)); the engine counts calendar years.
 */
export function recoverLosses(
  vintages: readonly LossVintage[],
  year: number,
  profit: bigint,
  rules: RuleContext,
  options: { profitYears?: readonly number[] } = {},
): Recovery {
  const ordered = [...vintages]
    .filter((item) => item.remaining > 0n)
    .sort((a, b) => a.year - b.year);
  const read: Record<number, LossCarryforward> = {};
  const usable: LossVintage[] = [];
  const expired: LossVintage[] = [];
  for (const vintage of ordered) {
    const rule = (read[vintage.year] ??= rules.param<LossCarryforward>(
      'ro.profit.loss_carryforward',
      'fiscal_year_start',
      yearStart(vintage.year),
    ));
    const elapsed = options.profitYears
      ? options.profitYears.filter((item) => item > vintage.year && item <= year).length
      : year - vintage.year;
    if (vintage.year < year && elapsed <= rule.years) usable.push(vintage);
    else if (vintage.year < year) expired.push(vintage);
  }
  const available = usable.reduce((sum, item) => sum + item.remaining, 0n);
  // The share of the profit, cumulated over every vintage (alin. (8)): the lowest share read, and
  // the cap rounded down, so the recovery never exceeds it.
  const share = usable.length
    ? usable
        .map((item) => parseScaled(read[item.year]!.share, 4))
        .reduce((low, item) => (item < low ? item : low))
    : 0n;
  const cap = profit > 0n ? divRound(profit * share, 1_000_000n, 'floor') : 0n;
  let left = available < cap ? available : cap;
  const recovered = left;
  const used: Recovery['used'] = [];
  const after: LossVintage[] = [];
  for (const vintage of usable) {
    const take = left < vintage.remaining ? left : vintage.remaining;
    if (take > 0n) used.push({ year: vintage.year, amount: take });
    left -= take;
    if (vintage.remaining - take > 0n)
      after.push({ ...vintage, remaining: vintage.remaining - take });
  }
  for (const vintage of vintages.filter((item) => item.year >= year)) after.push({ ...vintage });
  return { available, recovered, cap, used, after, expired, rules: read };
}
