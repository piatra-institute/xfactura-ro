/*
 * Exempt supplies and purchases (Codul fiscal art. 292, 294–296, 297 alin. (4)): the tax codes the
 * engine books them under, the D300 row each goes to (OPANAF nr. 174/2026, rd. 1, 14, 15, 29), the
 * right of deduction each gives (art. 297 alin. (4)) and the VAT exemption reason codes (VATEX,
 * the EN 16931 code list) consistent with each legal basis. A sale names its basis; a purchase
 * carries its supplier's reason through. Nothing here is guessed from the text of a reason: a
 * reason that is not a VATEX code is shown to the reviewer.
 */

/** The engine's codes of exempt operations, as tax entries carry them. */
export const exemptCodes = {
  /** A supply exempt without the right of deduction (art. 292): D300 rd. 15. */
  noDeduction: 'EX-292',
  /** A supply exempt with the right of deduction, other than an export of goods and an
   * intra-community supply (art. 294 alin. (1) lit. c)–p), 295, 296, 297 alin. (4) lit. d)):
   * rd. 14. */
  withDeduction: 'EX-294',
  /** An export of goods (art. 294 alin. (1) lit. a)–b)): rd. 14, its own SAF-T code. */
  export: 'EX-EXPORT',
  /** An intra-community supply of goods to a business with a VAT code of another member state
   * (art. 294 alin. (2) lit. a)): rd. 1, and type L in D390. */
  intraCommunity: 'EX-IC',
  /** A purchase whose supply was exempt or not taxable (categories E and G): rd. 29. */
  purchase: 'EX-IN',
} as const;

/** The year-end pro-rata adjustment (art. 300 alin. (14)–(15)) and the adjustment of stock and
 * services not used (art. 304): D300 rd. 34 (R31_2), signed, as the capital goods' ADJ-305. */
export const adjustmentCodes = {
  prorata: 'ADJ-300',
  stock: 'ADJ-304',
} as const;

/** Output codes that give the right of deduction (art. 297 alin. (4) lit. c)–d)): the numerator
 * of the pro-rata (art. 300 alin. (6) lit. a)) and the VAT turnover of art. 322 alin. (2). */
export const exemptWithDeduction: readonly string[] = [
  exemptCodes.withDeduction,
  exemptCodes.export,
  exemptCodes.intraCommunity,
];

/** Every exempt code, output and input. */
export const allExemptCodes: readonly string[] = Object.values(exemptCodes);

/** A legal basis a sale's exemption is booked under, with what it decides. */
export interface ExemptionBasis {
  /** What the article exempts, in Romanian. */
  label: string;
  /** The e-Factura categories (BT-151) the basis is invoiced in. */
  categories: readonly ('E' | 'K' | 'G')[];
  /** The tax code it is booked under. */
  code: (typeof exemptCodes)[Exclude<keyof typeof exemptCodes, 'purchase'>];
  /** Whether it gives the right of deduction (art. 297 alin. (4)). */
  deduction: boolean;
  /** The VATEX codes consistent with it (the EN 16931 code list, BT-121). */
  vatex: RegExp;
  /** The registered clause of the basis. */
  clause: string;
  /** An exemption the books cannot prove by themselves: the documents of OMFP nr. 103/2016 (an
   * export's customs declaration, an intra-community supply's transport), confirmed by the
   * reviewer. */
  proof?: string;
}

const CODE = 'ANAF/Cod-fiscal-consolidat';

/** The exemptions a sale can be booked under, by basis. */
export const exemptionBases = {
  'art.292(1)': {
    label:
      'activități de interes general (spitalizare, îngrijiri medicale, învățământ, asistență socială, cultură, sport): art. 292 alin. (1)',
    categories: ['E'],
    code: exemptCodes.noDeduction,
    deduction: false,
    vatex: /^VATEX-EU-132(-1[A-Q])?$/,
    clause: `${CODE}:art.292(1)`,
  },
  'art.292(2)(a)': {
    label:
      'servicii financiar-bancare (credite, garanții, plăți, valută, titluri): art. 292 alin. (2) lit. a)',
    categories: ['E'],
    code: exemptCodes.noDeduction,
    deduction: false,
    vatex: /^VATEX-EU-135-1$/,
    clause: `${CODE}:art.292(2)`,
  },
  'art.292(2)(b)': {
    label: 'asigurări și reasigurări, cu intermedierea lor: art. 292 alin. (2) lit. b)',
    categories: ['E'],
    code: exemptCodes.noDeduction,
    deduction: false,
    vatex: /^VATEX-EU-135-1$/,
    clause: `${CODE}:art.292(2)`,
  },
  'art.292(2)(c)': {
    label: 'pariuri, loterii și jocuri de noroc autorizate: art. 292 alin. (2) lit. c)',
    categories: ['E'],
    code: exemptCodes.noDeduction,
    deduction: false,
    vatex: /^VATEX-EU-135-1$/,
    clause: `${CODE}:art.292(2)`,
  },
  'art.292(2)(d)': {
    label: 'timbre poștale și fiscale la valoarea nominală: art. 292 alin. (2) lit. d)',
    categories: ['E'],
    code: exemptCodes.noDeduction,
    deduction: false,
    vatex: /^VATEX-EU-135-1$/,
    clause: `${CODE}:art.292(2)`,
  },
  'art.292(2)(e)': {
    label:
      'arendarea, concesionarea, închirierea și leasingul de bunuri imobile (fără opțiunea de taxare): art. 292 alin. (2) lit. e)',
    categories: ['E'],
    code: exemptCodes.noDeduction,
    deduction: false,
    vatex: /^VATEX-EU-135-1$/,
    clause: `${CODE}:art.292(2)`,
  },
  'art.292(2)(f)': {
    label:
      'livrarea de construcții vechi și a terenurilor neconstruibile (fără opțiunea de taxare): art. 292 alin. (2) lit. f)',
    categories: ['E'],
    code: exemptCodes.noDeduction,
    deduction: false,
    vatex: /^VATEX-EU-135-1$/,
    clause: `${CODE}:art.292(2)`,
  },
  'art.292(2)(g)': {
    label:
      'livrarea bunurilor afectate unei activități scutite, fără TVA dedusă la achiziție: art. 292 alin. (2) lit. g)',
    categories: ['E'],
    code: exemptCodes.noDeduction,
    deduction: false,
    vatex: /^VATEX-EU-13[25](-1)?$/,
    clause: `${CODE}:art.292(2)`,
  },
  'art.297(4)(d)': {
    label:
      'servicii financiare sau de asigurare scutite (art. 292 alin. (2) lit. a) pct. 1–5 și lit. b)) către un client stabilit în afara Uniunii Europene sau legate direct de bunuri exportate: cu drept de deducere, art. 297 alin. (4) lit. d)',
    categories: ['E'],
    code: exemptCodes.withDeduction,
    deduction: true,
    vatex: /^VATEX-EU-135-1$/,
    clause: `${CODE}:art.297(4)`,
  },
  'art.294(1)(a)-(b)': {
    label:
      'exportul de bunuri, expediate în afara Uniunii Europene de furnizor sau de cumpărătorul nestabilit în România: art. 294 alin. (1) lit. a)–b)',
    categories: ['G', 'E'],
    code: exemptCodes.export,
    deduction: true,
    vatex: /^VATEX-EU-G$/,
    clause: `${CODE}:art.294(1)`,
    proof:
      'Scutirea exportului se justifică cu declarația vamală de export cu viza biroului vamal de ieșire (OMFP nr. 103/2016).',
  },
  'art.294(1)(c)-(p)': {
    label:
      'alte operațiuni scutite cu drept de deducere: servicii legate direct de export sau de import, transport internațional, nave și aeronave, misiuni diplomatice și organisme internaționale: art. 294 alin. (1) lit. c)–p)',
    categories: ['E'],
    code: exemptCodes.withDeduction,
    deduction: true,
    vatex: /^VATEX-EU-(144|146-1E|148(-[A-G])?|151(-1(A|AA|B|C|D|E))?)$/,
    clause: `${CODE}:art.294(1)`,
    proof:
      'Scutirea se justifică cu documentele cerute de OMFP nr. 103/2016 pentru operațiunea respectivă (contractul, documentele de transport, declarația vamală).',
  },
  'art.294(2)(a)': {
    label:
      'livrare intracomunitară de bunuri către o persoană impozabilă cu cod de TVA dintr-un alt stat membru: art. 294 alin. (2) lit. a)',
    categories: ['K'],
    code: exemptCodes.intraCommunity,
    deduction: true,
    vatex: /^VATEX-EU-IC$/,
    clause: `${CODE}:art.294(2)`,
    proof:
      'Scutirea livrării intracomunitare se justifică cu documentele de transport în alt stat membru și cu codul valabil de TVA al cumpărătorului (OMFP nr. 103/2016), care se declară în D390.',
  },
  'art.295': {
    label: 'scutiri speciale legate de traficul internațional de bunuri: art. 295',
    categories: ['E'],
    code: exemptCodes.withDeduction,
    deduction: true,
    vatex: /^VATEX-EU-159$/,
    clause: `${CODE}:art.295`,
  },
  'art.296': {
    label:
      'servicii ale intermediarilor în numele și în contul altei persoane, legate de operațiunile scutite de la art. 294–295: art. 296',
    categories: ['E'],
    code: exemptCodes.withDeduction,
    deduction: true,
    vatex: /^VATEX-EU-153$/,
    clause: `${CODE}:art.296`,
  },
} as const satisfies Record<string, ExemptionBasis>;

export type ExemptionBasisId = keyof typeof exemptionBases;
export const exemptionBasisIds = Object.keys(exemptionBases) as [
  ExemptionBasisId,
  ...ExemptionBasisId[],
];

/** The financial and real-estate operations of art. 300 alin. (7) lit. c), left out of the
 * pro-rata when accessory to the main activity (norme pct. 70 alin. (3)–(4)). */
export const accessoryBases: readonly ExemptionBasisId[] = [
  'art.292(2)(a)',
  'art.292(2)(e)',
  'art.292(2)(f)',
];

/** VATEX codes that are no exempt supply this module books: not subject (O), reverse charge (AE),
 * margin schemes (D, F, I, J), imports (143), amounts outside the base (79-C, art. 286 alin. (4)
 * lit. e)), travel agents outside the Union (309). */
const otherVatex = /^VATEX-EU-(O|AE|D|F|I|J|143(-1[A-L]|-1FA)?|79-C|309)$/;

/** What a sale's stated exemption reason says about a basis: consistent, contradicting it, a code
 * the module does not book, or a free text the reviewer reads. */
export function reasonAgrees(
  basis: ExemptionBasisId,
  reason: string | null,
): 'agrees' | 'contradicts' | 'other' | 'text' | 'missing' {
  if (!reason) return 'missing';
  const code = reason.trim().toUpperCase();
  if (!code.startsWith('VATEX-')) return 'text';
  if (otherVatex.test(code)) return 'other';
  return exemptionBases[basis].vatex.test(code) ? 'agrees' : 'contradicts';
}

/** The categories (BT-151) the engine books as exempt: E exempt, K intra-community, G export. */
export const exemptCategories = ['E', 'K', 'G'] as const;
export type ExemptCategory = (typeof exemptCategories)[number];
export const isExemptCategory = (category: string): category is ExemptCategory =>
  (exemptCategories as readonly string[]).includes(category);
