import { divRound, formatMoney } from '../../money';

/*
 * The pro-rata of a taxable person with mixed operations (Codul fiscal art. 300): the definitive
 * pro-rata of a year from its supplies, the VAT a purchase for both kinds of operations deducts
 * under a pro-rata, and the year-end adjustment of what the provisional pro-rata deducted
 * (alin. (11)–(14)), with the yearly adjustment of capital goods deducted under it (alin. (15)).
 * Pure: the treatment reads the books and books the result.
 */

const lei = (bani: bigint) => formatMoney(bani, 'RON');

/** A recorded provisional pro-rata: a whole percent, or a case the engine does not compute. */
export type ProrataFact =
  { kind: 'percent'; percent: number } | { kind: 'special' } | { kind: 'opted_out' };

/** The values the `vat.prorata` profile axis takes: the provisional pro-rata in whole percent
 * (the definitive is rounded up to the unit, alin. (8); an estimate is recorded the same way), a
 * special pro-rata approved or imposed by the Ministry (alin. (16)–(17)), or the option not to
 * deduct the VAT of purchases for both kinds of operations (alin. (20)). */
export const prorataValues: readonly string[] = [
  ...Array.from({ length: 101 }, (_, value) => String(value)),
  'special',
  'opted_out',
];

export function prorataFact(value: string | null): ProrataFact | null {
  if (value === null) return null;
  if (value === 'special' || value === 'opted_out') return { kind: value };
  if (!/^(0|[1-9]\d?|100)$/.test(value)) return null;
  return { kind: 'percent', percent: Number(value) };
}

/** The VAT a purchase for both kinds of operations deducts under a pro-rata (alin. (11)): the
 * share, half up to the ban. */
export const prorataShare = (vatBani: bigint, percent: number) =>
  divRound(vatBani * BigInt(percent), 100n, 'halfAwayFromZero');

export interface ProrataSupplies {
  /** Supplies with the right of deduction, without VAT, the subsidies linked to their price
   * included (alin. (6) lit. a)): taxable, exempt with deduction, abroad with deduction. */
  withDeduction: bigint;
  /** Supplies without the right of deduction (alin. (6) lit. b)). */
  withoutDeduction: bigint;
  /** Sums from the state or local budgets financing exempt or out-of-scope operations, in the
   * denominator (alin. (6) lit. b), last sentence). */
  subsidies: bigint;
  /** What alin. (7) leaves out (accessory financial and real-estate operations, capital goods
   * supplied, self-supplies), already taken out of the two sums; shown. */
  excluded: bigint;
}

export interface Definitive {
  /** The definitive pro-rata, in whole percent. */
  percent: number;
  /** The ratio before rounding, to four decimals. */
  exact: string;
  numerator: bigint;
  denominator: bigint;
  lines: string[];
}

/**
 * The definitive pro-rata of a year (alin. (6)–(8)): the supplies with the right of deduction over
 * all supplies and the budget sums of alin. (6) lit. b), in percent, rounded up to the next unit
 * ("se rotunjește până la cifra unităților imediat următoare"): a whole percent is kept. Null when
 * the year has no supplies, which alin. (10) lit. d) and (13) treat apart.
 */
export function definitiveProrata(supplies: ProrataSupplies): Definitive | null {
  const numerator = supplies.withDeduction;
  const denominator = supplies.withDeduction + supplies.withoutDeduction + supplies.subsidies;
  if (denominator <= 0n) return null;
  const bounded = numerator < 0n ? 0n : numerator > denominator ? denominator : numerator;
  const scaled = (bounded * 1_000_000n) / denominator;
  const remainder = (bounded * 1_000_000n) % denominator;
  // Percent with four decimals, truncated; rounded up to the unit from the exact ratio.
  const exact = `${scaled / 10_000n}.${String(scaled % 10_000n).padStart(4, '0')}`;
  const hundred = bounded * 100n;
  const percent = Number(hundred / denominator + (hundred % denominator === 0n ? 0n : 1n));
  const lines = [
    `Operațiuni cu drept de deducere (numărător, art. 300 alin. (6) lit. a)): ${lei(numerator)} lei.`,
    `Operațiuni fără drept de deducere: ${lei(supplies.withoutDeduction)} lei; sume de la buget pentru operațiuni scutite fără drept de deducere sau în afara sferei: ${lei(supplies.subsidies)} lei.`,
    `Numitor (lit. b)): ${lei(denominator)} lei; excluse din calcul (alin. (7)): ${lei(supplies.excluded)} lei.`,
    `Raport: ${exact}%${remainder === 0n ? '' : ' (trunchiat)'}; pro rata definitivă, rotunjită la unitatea imediat următoare (alin. (8)): ${percent}%.`,
  ];
  return { percent, exact, numerator, denominator, lines };
}

/** The VAT of purchases for both kinds of operations in a year, by VAT code, and what the
 * provisional pro-rata deducted of it. */
export interface MixedPurchases {
  code: string;
  vatBani: bigint;
  deductedBani: bigint;
}

export interface ProrataAdjustment {
  code: string;
  /** What the definitive pro-rata deducts of the year's VAT (alin. (12)). */
  definitiveBani: bigint;
  deductedBani: bigint;
  /** definitive − deducted: positive in favour of the company (alin. (14) lit. a)–b)). */
  bani: bigint;
  line: string;
}

/** The year-end adjustment (alin. (14)), per VAT code: the year's VAT of purchases for both
 * kinds of operations at the definitive pro-rata, less what the provisional deducted. */
export function prorataAdjustments(
  purchases: readonly MixedPurchases[],
  definitive: number,
): ProrataAdjustment[] {
  return purchases.map((group) => {
    const definitiveBani = prorataShare(group.vatBani, definitive);
    const bani = definitiveBani - group.deductedBani;
    return {
      code: group.code,
      definitiveBani,
      deductedBani: group.deductedBani,
      bani,
      line: `${group.code}: TVA ${lei(group.vatBani)} lei × ${definitive}% = ${lei(definitiveBani)} lei de dedus definitiv; dedusă cu pro rata provizorie ${lei(group.deductedBani)} lei; ajustare ${lei(bani)} lei.`,
    };
  });
}

/** A capital good deducted under a pro-rata in an earlier year of its adjustment period. */
export interface ProrataCapitalGood {
  assetId: string;
  number: string;
  /** The VAT of its acquisition (taxa deductibilă inițială) and what the definitive pro-rata of
   * its first year deducted of it (taxa dedusă inițial). */
  vatBani: bigint;
  deductedBani: bigint;
  /** 5 or 20 (art. 305 alin. (2)). */
  years: number;
}

/**
 * The yearly adjustment of a capital good deducted under the definitive pro-rata of an earlier
 * year (alin. (15)): a fifth (a twentieth) of its VAT at this year's definitive pro-rata, against a
 * fifth (a twentieth) of what was deducted, in the year's last return.
 */
export function prorataCapitalGoodAdjustment(good: ProrataCapitalGood, definitive: number) {
  const allowed = divRound(
    good.vatBani * BigInt(definitive),
    BigInt(100 * good.years),
    'halfAwayFromZero',
  );
  const deducted = divRound(good.deductedBani, BigInt(good.years), 'halfAwayFromZero');
  const bani = allowed - deducted;
  return {
    assetId: good.assetId,
    number: good.number,
    bani,
    line: `${good.number}: ${lei(good.vatBani)} lei / ${good.years} × ${definitive}% = ${lei(allowed)} lei, față de ${lei(good.deductedBani)} lei / ${good.years} = ${lei(deducted)} lei dedusă inițial: ajustare ${lei(bani)} lei (art. 300 alin. (15)).`,
  };
}
