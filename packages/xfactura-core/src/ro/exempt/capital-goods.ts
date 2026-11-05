import { divRound, formatMoney, parseScaled } from '../../money';
import type { LocalDate } from '../../time';
import type { CapitalGoodsRule } from '../nonpayers/parameters';

/*
 * The adjustment of a capital good's deductible VAT in the general case (Codul fiscal art. 305
 * alin. (4)–(5), (7); norme pct. 79): its adjustment period, the yearly fifth (twentieth) adjusted
 * for each year its use for operations with the right of deduction differs from the initial
 * deduction (lit. a) and c)), the once-for-all adjustment for the period left when it is supplied
 * or ceases to exist (lit. a)–d)), and what art. 306 leaves for the assets bought before 2016. And
 * the adjustment of stock, services not used and advances on a change of regime (art. 304; norme
 * pct. 78, pct. 83 alin. (7), (11)). Pure: the treatment reads the books and books the results.
 */

const lei = (bani: bigint) => formatMoney(bani, 'RON');

/** A capital good as its acquisition entries show it. */
export interface CapitalGoodBasis {
  assetId: string;
  number: string;
  name: string;
  /** A building or land, or their acquisition (20 years); otherwise movable (5 years). */
  immovable: boolean;
  /** The acquisition's tax point: the period starts on 1 January of its year (alin. (3)). */
  acquiredOn: LocalDate;
  /** The VAT of its acquisition (taxa deductibilă) and what was deducted of it. */
  vatBani: bigint;
  deductedBani: bigint;
}

/** A share of use for operations with the right of deduction, in basis points (10000 = 100%). */
export type Share = number;
export const FULL_SHARE: Share = 10_000;

/** A share stated in percent with up to two decimals ("70", "62.5") in basis points. */
export function shareOf(percent: string): Share | null {
  if (!/^(0|[1-9]\d?|100)(\.\d{1,2})?$/.test(percent)) return null;
  const value = Number(parseScaled(percent, 2));
  return value > FULL_SHARE ? null : value;
}
export const percentOf = (share: Share) =>
  `${Math.floor(share / 100)}${share % 100 ? `,${String(share % 100).padStart(2, '0')}` : ''}%`;

/** The share the initial deduction corresponds to: what was deducted of the VAT. */
export function initialShare(good: Pick<CapitalGoodBasis, 'vatBani' | 'deductedBani'>): Share {
  if (good.vatBani === 0n) return FULL_SHARE;
  return Number(divRound(good.deductedBani * 10_000n, good.vatBani, 'halfAwayFromZero'));
}

export interface AdjustmentPeriod {
  years: number;
  /** The first and last calendar year of the period. */
  first: number;
  last: number;
}

export function periodOf(good: CapitalGoodBasis, rule: CapitalGoodsRule): AdjustmentPeriod {
  const years = good.immovable ? rule.immovable : rule.movable;
  const first = Number(good.acquiredOn.slice(0, 4));
  return { years, first, last: first + years - 1 };
}

/**
 * The adjustment of one year of the period at a share: a fifth (a twentieth) of the VAT at the
 * share, less a fifth (a twentieth) of what was deducted initially; positive in favour of the
 * company (norme pct. 79 alin. (1), (15) exemplele 2–5). Half up to the ban.
 */
export function yearAdjustment(good: CapitalGoodBasis, years: number, share: Share): bigint {
  return divRound(
    good.vatBani * BigInt(share) - good.deductedBani * 10_000n,
    BigInt(years) * 10_000n,
    'halfAwayFromZero',
  );
}

/** How art. 305 and 306 treat a good on a date of its history. */
export type Transitional =
  | { kind: 'art305' }
  /** The period is over: nothing more is adjusted (alin. (2)–(3); norme pct. 79 alin. (1)). */
  | { kind: 'expired' }
  /** Bought before 2016 and not wholly depreciated: art. 306 adjusts in proportion to the value
   * not depreciated, which the engine does not compute. */
  | { kind: 'ART306' }
  /** A building bought before the accession (2007): art. 332's transitional rules. */
  | { kind: 'ART332' };

/**
 * Art. 305 for a good acquired from 2016 or a building acquired after the accession; for a movable
 * good acquired before 2016 (art. 306, norme pct. 80): nothing once its five-year period has run
 * out, if it was a capital good, or once it is wholly depreciated, if it was not (a fiscal life
 * under five years); otherwise the proportion art. 306 computes is not covered.
 */
export function transitionalOf(
  good: CapitalGoodBasis,
  asset: { value: bigint; depreciated: bigint; fiscalLifeMonths: number | null },
  year: number,
  rule: CapitalGoodsRule,
): Transitional {
  if (good.acquiredOn >= '2016-01-01') return { kind: 'art305' };
  if (good.immovable)
    return good.acquiredOn >= '2007-01-01' ? { kind: 'art305' } : { kind: 'ART332' };
  if (asset.depreciated >= asset.value) return { kind: 'expired' };
  if (asset.fiscalLifeMonths !== null && asset.fiscalLifeMonths >= 60)
    return year > periodOf(good, rule).last ? { kind: 'expired' } : { kind: 'art305' };
  return { kind: 'ART306' };
}

export interface GoodAdjustment {
  assetId: string;
  number: string;
  year: number;
  /** The years adjusted: 1 for a year's change of use, those left for a once-for-all. */
  years: number;
  share: Share;
  bani: bigint;
  line: string;
}

/**
 * A year's adjustment for a change of use (alin. (4) lit. a), c); alin. (5) lit. a), c) first
 * sentences): the year's fifth (twentieth) at the share now in force, less what the year has
 * already been adjusted for this good (an earlier event of the same year). The year's last
 * return repeats it each year while the use holds (norme pct. 79 alin. (1)).
 */
export function useAdjustment(
  good: CapitalGoodBasis,
  year: number,
  share: Share,
  already: bigint,
  rule: CapitalGoodsRule,
): GoodAdjustment {
  const period = periodOf(good, rule);
  const within = year >= period.first && year <= period.last;
  const bani = within ? yearAdjustment(good, period.years, share) - already : 0n;
  return {
    assetId: good.assetId,
    number: good.number,
    year,
    years: within ? 1 : 0,
    share,
    bani,
    line: within
      ? `${good.number} ${good.name}: TVA ${lei(good.vatBani)} lei, dedusă inițial ${lei(good.deductedBani)} lei (${percentOf(initialShare(good))}); în ${year} folosit ${percentOf(share)} pentru operațiuni cu drept de deducere: ${lei(good.vatBani)} × ${percentOf(share)} / ${period.years} − ${lei(good.deductedBani)} / ${period.years}${already ? `, din care ${lei(already)} lei ajustați deja în ${year}` : ''} = ${lei(bani)} lei.`
      : `${good.number} ${good.name}: perioada de ajustare ${period.first}–${period.last} nu cuprinde ${year}: nu se ajustează.`,
  };
}

/**
 * The once-for-all adjustment for the period left, the year of the event included: an exempt
 * supply (alin. (5) lit. a), last sentence: the share becomes 0), a taxable supply of a good whose
 * deduction was limited (lit. c), last sentence: 100%, at most the VAT collected on the supply,
 * alin. (4) lit. c)) and a good that ceases to exist (lit. d): 0). Less what the year has already
 * been adjusted for this good.
 */
export function remainingAdjustment(
  good: CapitalGoodBasis,
  year: number,
  share: Share,
  already: bigint,
  rule: CapitalGoodsRule,
  cap?: bigint,
): GoodAdjustment {
  const period = periodOf(good, rule);
  const left = Math.max(0, period.last - Math.max(year, period.first) + 1);
  let bani =
    left === 0
      ? 0n
      : divRound(
          (good.vatBani * BigInt(share) - good.deductedBani * 10_000n) * BigInt(left),
          BigInt(period.years) * 10_000n,
          'halfAwayFromZero',
        ) - already;
  const capped = cap !== undefined && bani > cap;
  if (capped) bani = cap;
  return {
    assetId: good.assetId,
    number: good.number,
    year,
    years: left,
    share,
    bani,
    line:
      left === 0
        ? `${good.number} ${good.name}: perioada de ajustare ${period.first}–${period.last} s-a încheiat: nu se ajustează.`
        : `${good.number} ${good.name}: TVA ${lei(good.vatBani)} lei, dedusă inițial ${lei(good.deductedBani)} lei; ${left} ani rămași din ${period.years} (${year}–${period.last}) la ${percentOf(share)}${already ? `, mai puțin ${lei(already)} lei ajustați deja în ${year}` : ''}: ${lei(bani)} lei${capped ? ', limitat la TVA colectată la livrare (art. 305 alin. (4) lit. c))' : ''}.`,
  };
}

/** A line of the inventory at a change of regime (norme pct. 83 alin. (7) lit. a), (11) lit. a)):
 * stock or assets in progress, at its value and the VAT rate of its acquisition (norme pct. 78
 * alin. (13)). */
export interface StockLine {
  account: string;
  valueBani: bigint;
  /** The rate in force when it was bought, in percent; 0 for what carried no deductible VAT. */
  rate: string;
}

/** The VAT of an inventory line: its value at its acquisition's rate, half up to the ban. */
export const stockVat = (line: StockLine) =>
  divRound(line.valueBani * parseScaled(line.rate, 4), 1_000_000n, 'halfAwayFromZero');

/** The VAT of what is left of an intangible asset, a service not used (norme pct. 78 alin. (2)):
 * its acquisition's VAT in proportion to the value not yet depreciated. */
export function unusedServiceVat(
  vatBani: bigint,
  asset: { value: bigint; depreciated: bigint },
): bigint {
  if (asset.value <= 0n) return 0n;
  const left = asset.value - asset.depreciated;
  if (left <= 0n) return 0n;
  return divRound(vatBani * left, asset.value, 'halfAwayFromZero');
}

/** The VAT deducted on an advance still open at the change (norme pct. 83 alin. (7) lit. d)):
 * the advance invoice's deducted VAT in proportion to what is left of it. */
export function advanceVat(deductedBani: bigint, grossBani: bigint, openBani: bigint): bigint {
  if (grossBani <= 0n || openBani <= 0n) return 0n;
  return divRound(deductedBani * openBani, grossBani, 'halfAwayFromZero');
}
