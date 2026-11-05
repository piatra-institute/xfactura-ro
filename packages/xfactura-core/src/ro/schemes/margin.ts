import type { Issue } from '../../kernel';
import { divRound, formatMoney, LEDGER_CURRENCY, parseMoney, parseScaled } from '../../money';
import { RuleGapError, type RuleContext } from '../../rules';
import type { LocalDate } from '../../time';
import type { InvoiceDocument } from '../../ubl/invoice-document';
import type { MarginRule } from './parameters';

/*
 * What the margin schemes (Codul fiscal art. 311 and 312) and the agricultural flat rate (art.
 * 315^1) share: the tax codes their entries carry, which the returns read, the invoice mentions
 * of art. 319 alin. (20) lit. n) and o), and the VAT a margin includes, computed by the
 * hundred-plus method ("procedeul sutei mărite", norme pct. 85 alin. (4) lit. d), pct. 86 alin.
 * (4) lit. c)).
 */

const CODE = 'ANAF/Cod-fiscal-consolidat';
export const TRAVEL_CLAUSES = [
  `${CODE}:art.311(1)-(3)`,
  `${CODE}:art.311(4)-(6)`,
  `${CODE}:art.311(7)-(12)`,
  `${CODE}:norme.art.311.pct.85`,
];
export const GOODS_CLAUSES = [
  `${CODE}:art.312(1)`,
  `${CODE}:art.312(2)-(4)`,
  `${CODE}:art.312(5)-(12)`,
  `${CODE}:norme.art.312.pct.86`,
];
export const FLAT_RATE_CLAUSES = [
  `${CODE}:art.315^1(1)-(4)`,
  `${CODE}:art.315^1(5)-(8)`,
  `${CODE}:art.315^1(17)-(18)`,
  `${CODE}:norme.art.315^1.pct.87^1`,
];
export const MENTION_CLAUSE = `${CODE}:art.319(20)(k),(n),(o)`;

/**
 * The semantic codes the declarations read:
 * - `MS-311-<rate>`: a travel agency's VAT of a period's margin (D300 rd. 9, base and VAT;
 *   D394's informatii incasari_ag, costuri_ag, marja_ag, tva_ag from its attributes);
 * - `MS-311-L`: a travel agency's sale under the scheme, the price as invoiced, no VAT of its
 *   own (no D300 row; D394 LS);
 * - `MS-311-A`: a single service bought from another agency applying the scheme (norme pct. 85
 *   alin. (7)): D300 rd. 29, D394 AS;
 * - `MS-312-<rate>`: an item sold under the margin scheme, base the margin less its VAT (D300
 *   rd. 9; D394 LS at its price and informatii pret_vanzare, pret_cumparare, marja_antic,
 *   tva_antic);
 * - `MS-312-A`: an item bought for resale under the scheme (D300 rd. 29; D394 AS from a dealer,
 *   N from a person not registered for VAT);
 * - `FR-315`: the agricultural flat-rate compensation paid (D300 rd. 27 and 31; D394 N; SAF-T
 *   308301 or 358301).
 */
export const schemeCodes = {
  travel: (rate: string) => `MS-311-${rate}`,
  travelSale: 'MS-311-L',
  travelPurchase: 'MS-311-A',
  goods: (rate: string) => `MS-312-${rate}`,
  goodsPurchase: 'MS-312-A',
  flatRate: 'FR-315',
} as const;
export const isTravelMarginCode = (code: string) => /^MS-311-\d+$/.test(code);
export const isGoodsMarginCode = (code: string) => /^MS-312-\d+$/.test(code);
/** Every code of the margin schemes and the flat rate. */
export const isSchemeCode = (code: string) => /^(MS-31[12]-(\d+|L|A)|FR-315)$/.test(code);

/** The kinds of goods of art. 312 alin. (1) lit. a)–d), as the invoice's mention names them. */
export const goodsKinds = ['second_hand', 'works_of_art', 'collectibles_antiques'] as const;
export type GoodsKind = (typeof goodsKinds)[number];

/** The mentions of art. 319 alin. (20) lit. n) and o), as written on the invoice. */
export const schemeMentions = {
  travel: 'regimul marjei - agenții de turism',
  second_hand: 'regimul marjei - bunuri second-hand',
  works_of_art: 'regimul marjei - opere de artă',
  collectibles_antiques: 'regimul marjei - obiecte de colecție și antichități',
} as const;

/** Lower case, without diacritics, every dash a hyphen and spaces collapsed. */
export const folded = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/\s*-\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();

/** The VAT breakdowns of an invoice, as far as their reasons go. */
type Mentions = { taxes?: readonly { exemptionReason?: string | null }[] };

/** Whether an invoice's VAT breakdowns state a mention (BT-120): the reason of an exempt or
 * non-taxable category, where RO_CIUS writes it. */
export function statesMention(body: Mentions, mention: string): boolean {
  const wanted = folded(mention);
  return (body.taxes ?? []).some(
    (tax) => tax.exemptionReason && folded(tax.exemptionReason).includes(wanted),
  );
}

/** The margin scheme an invoice's breakdowns name, if one. */
export function mentionedScheme(body: Mentions): keyof typeof schemeMentions | null {
  for (const [scheme, mention] of Object.entries(schemeMentions))
    if (statesMention(body, mention)) return scheme as keyof typeof schemeMentions;
  return null;
}

/**
 * The VAT a margin includes, at a rate, by the hundred-plus method: margin × rate ÷ (100 +
 * rate), half up to the ban, and the base, the margin less it. A margin of zero or less gives no
 * VAT (norme pct. 86 alin. (5)): the caller decides whether a negative one is allowed.
 */
export function marginVat(marginBani: bigint, rate: string): { vat: bigint; base: bigint } {
  if (marginBani <= 0n) return { vat: 0n, base: 0n };
  const scaled = parseScaled(rate, 4);
  const vat = divRound(marginBani * scaled, 1_000_000n + scaled, 'halfAwayFromZero');
  return { vat, base: marginBani - vat };
}

export const ron = (value: string) => parseMoney(value, LEDGER_CURRENCY);
export const lei = (bani: bigint) => formatMoney(bani, LEDGER_CURRENCY);
export const block = (
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
export const warn = (code: string, message: string, details?: Issue['details']): Issue => ({
  code,
  severity: 'ack',
  message,
  ...(details === undefined ? {} : { details }),
});

/** A rule the evaluation needs, or the gap as a blocking issue. */
export function ruleOf<T>(
  rules: RuleContext,
  key: string,
  date: LocalDate,
  issues: Issue[],
  scope?: Record<string, string>,
): T | null {
  try {
    return rules.param<T>(key, 'vat_chargeability_date', date, scope);
  } catch (error) {
    if (!(error instanceof RuleGapError)) throw error;
    issues.push(block('RULE_GAP', error.message));
    return null;
  }
}

/** The margin rule and the standard rate it taxes at, on a date. */
export function marginRates(
  rules: RuleContext,
  key: 'ro.vat.margin.travel' | 'ro.vat.margin.goods',
  date: LocalDate,
  issues: Issue[],
): { rule: MarginRule; rate: string } | null {
  const rule = ruleOf<MarginRule>(rules, key, date, issues);
  const rate = ruleOf<string>(rules, 'ro.vat.rate', date, issues, { category: 'S' });
  return rule && rate ? { rule, rate } : null;
}

/** Every breakdown of the invoice without VAT, as a margin-scheme or flat-rate invoice is. */
export const showsNoVat = (body: Pick<InvoiceDocument, 'taxes'>) =>
  body.taxes.every((tax) => ron(tax.tax) === 0n && tax.category !== 'S');
