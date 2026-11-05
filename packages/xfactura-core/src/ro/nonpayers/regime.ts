import { divRound, formatMoney, parseScaled } from '../../money';
import type { LocalDate } from '../../time';
import type { CapitalGoodsRule } from './parameters';

/*
 * The computations of a change of VAT regime (Codul fiscal art. 305, 310, 316): the VAT owed for
 * registering late, from what the books hold for the period in which the normal regime should
 * have applied, and the capital goods' adjustment when a company enters or leaves the normal
 * regime. Pure: the engine reads the books, the treatments book the results.
 */

const lei = (bani: bigint) => formatMoney(bani, 'RON');

/** Whether the customers paid the VAT on top of the agreed price (`added`, norme pct. 36 lit. a))
 * or the price is taken to include it (`inclusive`, lit. b) pct. 4). */
export type Consideration = 'inclusive' | 'added';

export interface LatePurchase {
  documentId: string;
  number: string;
  taxPoint: LocalDate;
  /** The purchase's base and the VAT its invoice charged, booked without deduction. */
  baseBani: bigint;
  vatBani: bigint;
  /** What a person decided may be deducted (art. 297–298); null while nobody did. */
  deduction: 'full' | 'limited' | 'none' | null;
}

export interface ExposureInput {
  /** The first day of the normal regime: the day the threshold was exceeded (art. 310 alin. (6),
   * art. 316 alin. (1^1) lit. b)). */
  from: LocalDate;
  /** The last day the books kept the company outside VAT. */
  until: LocalDate;
  /** Revenue on 70x in the range, net of 709. */
  revenueBani: bigint;
  /** The supplies with their place abroad in the range (bases of the EXP-… entries). */
  abroadBani: bigint;
  /** The supplies of the first day booked before the one that exceeded the threshold, which the
   * company may leave under the exemption (art. 310 alin. (6), last sentence). */
  excludedBani: bigint;
  /** The standard rate in force over the range, in percent. */
  rate: string;
  purchases: readonly LatePurchase[];
  /** The share of a limited deduction (art. 298), in percent. */
  limitedShare: string;
}

export interface Exposure {
  from: LocalDate;
  until: LocalDate;
  /** The supplies the normal regime applied to: revenue less abroad and excluded. */
  considerationBani: bigint;
  /** The VAT that should have been collected and its base, under each reading of the price. */
  collected: Record<Consideration, { baseBani: bigint; vatBani: bigint }>;
  /** The VAT that could have been deducted, for the purchases a person decided on. */
  deductibleBaseBani: bigint;
  deductibleBani: bigint;
  /** Purchases with VAT nobody decided on: the net is not known until they are. */
  undecided: number;
  /** collected − deductible; negative when the deduction exceeds what is owed (lit. c)). */
  net: Record<Consideration, bigint> | null;
  lines: string[];
}

/** VAT of an amount at a rate in percent (four decimals), half away from zero. */
const percentOf = (bani: bigint, rate: string) =>
  divRound(bani * parseScaled(rate, 4), 1_000_000n, 'halfAwayFromZero');

/**
 * The VAT owed for registering late (art. 310 alin. (6^1) lit. b)–c), (6^2) lit. b)–c)): what
 * should have been collected on the supplies from the day the threshold was exceeded until the
 * company charged VAT, less what it would have had the right to deduct on its purchases of the
 * same period. The price either included the VAT (100 × rate / (100 + rate) of it is VAT, norme
 * pct. 36 lit. b) pct. 4) or the customers pay it on top; both are shown.
 */
export function lateRegistrationExposure(input: ExposureInput): Exposure {
  const consideration = input.revenueBani - input.abroadBani - input.excludedBani;
  const rate = parseScaled(input.rate, 4);
  const inclusiveVat = divRound(consideration * rate, 1_000_000n + rate, 'halfAwayFromZero');
  const collected = {
    inclusive: { baseBani: consideration - inclusiveVat, vatBani: inclusiveVat },
    added: { baseBani: consideration, vatBani: percentOf(consideration, input.rate) },
  };
  let deductibleBase = 0n;
  let deductible = 0n;
  let undecided = 0;
  const lines = [
    `Regimul normal se aplică de la ${input.from} (art. 310 alin. (6)); registrele țin firma în afara TVA până la ${input.until}.`,
    `Venituri 70x în interval: ${lei(input.revenueBani)} lei; cu locul în străinătate: ${lei(input.abroadBani)} lei; din prima zi, înaintea tranzacției care depășește plafonul, lăsate scutite: ${lei(input.excludedBani)} lei.`,
    `Livrări taxabile: ${lei(consideration)} lei. Cu prețul incluzând TVA (${input.rate} × 100 / ${100 + Number(input.rate)}): bază ${lei(collected.inclusive.baseBani)}, TVA ${lei(inclusiveVat)} lei; cu TVA adăugată prețului: TVA ${lei(collected.added.vatBani)} lei.`,
  ];
  for (const purchase of input.purchases) {
    if (purchase.deduction === null) {
      undecided += 1;
      lines.push(
        `Achiziția ${purchase.number} din ${purchase.taxPoint}: TVA ${lei(purchase.vatBani)} lei, deducerea nu e hotărâtă (art. 297–298).`,
      );
      continue;
    }
    const amount =
      purchase.deduction === 'full'
        ? purchase.vatBani
        : purchase.deduction === 'limited'
          ? percentOf(purchase.vatBani, input.limitedShare)
          : 0n;
    if (amount === 0n) continue;
    deductible += amount;
    deductibleBase += purchase.baseBani;
    lines.push(
      `Achiziția ${purchase.number} din ${purchase.taxPoint}: TVA deductibilă ${lei(amount)} lei (${purchase.deduction}).`,
    );
  }
  const net = undecided
    ? null
    : {
        inclusive: collected.inclusive.vatBani - deductible,
        added: collected.added.vatBani - deductible,
      };
  lines.push(
    net
      ? `De plată: ${lei(net.inclusive)} lei (preț cu TVA inclusă) sau ${lei(net.added)} lei (TVA adăugată); o diferență negativă este suma negativă a taxei (lit. c)).`
      : `${undecided} achiziții cu TVA așteaptă hotărârea privind deducerea: diferența de plată nu se poate calcula încă.`,
  );
  return {
    from: input.from,
    until: input.until,
    considerationBani: consideration,
    collected,
    deductibleBaseBani: deductibleBase,
    deductibleBani: deductible,
    undecided,
    net,
    lines,
  };
}

/** A fixed asset the books hold, as a capital good of art. 305 alin. (1) lit. a). */
export interface CapitalGood {
  assetId: string;
  number: string;
  name: string;
  /** A building or its acquisition (20 years); otherwise movable (5 years). */
  immovable: boolean;
  /** The acquisition's tax point: the adjustment period starts on 1 January of its year. */
  acquiredOn: LocalDate;
  /** The VAT charged on the acquisition and what was deducted of it. */
  vatBani: bigint;
  deductedBani: bigint;
}

export interface CapitalGoodAdjustment {
  assetId: string;
  number: string;
  years: number;
  /** The years left of the period, the year of the change included. */
  remaining: number;
  /** Signed as the deduction moves: negative in favour of the state (leaving), positive in favour
   * of the company (entering). */
  bani: bigint;
  line: string;
}

/**
 * The once-for-all adjustment of a capital good when the company leaves the normal regime for the
 * small-enterprise exemption (art. 305 alin. (5) lit. a), the VAT deducted) or enters it from the
 * exemption (lit. c), the VAT not deducted): a fifth, or a twentieth, of it for each year left of
 * the adjustment period, the year of the change included.
 */
export function capitalGoodAdjustment(
  good: CapitalGood,
  event: 'registration' | 'deregistration',
  date: LocalDate,
  rule: CapitalGoodsRule,
): CapitalGoodAdjustment {
  const years = good.immovable ? rule.immovable : rule.movable;
  const start = Number(good.acquiredOn.slice(0, 4));
  const remaining = Math.max(0, start + years - Number(date.slice(0, 4)));
  const basis = event === 'deregistration' ? good.deductedBani : good.vatBani - good.deductedBani;
  const share = divRound(basis * BigInt(remaining), BigInt(years), 'halfAwayFromZero');
  const bani = event === 'deregistration' ? -share : share;
  return {
    assetId: good.assetId,
    number: good.number,
    years,
    remaining,
    bani,
    line: `${good.number} ${good.name}: TVA ${event === 'deregistration' ? 'dedusă' : 'nededusă'} ${lei(basis)} lei, perioada de ajustare ${years} ani din ${start}, ${remaining} ani rămași (inclusiv ${date.slice(0, 4)}): ${lei(share)} lei ${event === 'deregistration' ? 'în favoarea bugetului' : 'în favoarea firmei'}.`,
  };
}

/** Whether a fixed asset is immovable property for art. 305 alin. (2) lit. b): a building of the
 * catalogue's group 1 (HG nr. 2.139/2004, "Construcții"), or held on 212. */
export const immovableAsset = (asset: { catalogCode: string; account: string }) =>
  asset.catalogCode.startsWith('1.') || asset.account.startsWith('212');

/** Whether an account holds tangible fixed assets (21x), the capital goods of art. 305 alin. (1)
 * lit. a) (art. 266 alin. (1) pct. 3); intangible ones (20x) are not. */
export const tangibleAsset = (account: string) => account.startsWith('21');
