import { vatTaxCodes } from './data/tax';
import {
  d406CashVatReleaseCode,
  d406DistanceCodes,
  d406DomesticReverseChargeCodes,
  d406ExemptCodes,
  d406FlatRateCodes,
  d406NonPayerSaleCode,
  d406RegimeCodes,
  d406SpecialCodes,
  d406TradeCodes,
  d406VatCodes,
  d406ZReportCode,
  releaseCodes,
  zReportCodes,
  type D406VatCodeRow,
} from './tax-codes';

/**
 * Why a TaxCode reads back into an engine code whose forward direction keeps refusing it:
 * - `ambiguous`: ANAF's sheet gives the one engine operation two active TaxCodes, and the
 *   register has no version of the rate whose effective interval would tell them apart (a sale
 *   at 9%: `ro.vat.rate.reduced` has only 11% from 2025-08-01);
 * - `reverse-charge-rate`: the D406 module reports a payer's reverse charge at the standard rate
 *   of its tax point (`ro.vat.rate`, category S), so an acquisition filed at a reduced rate has
 *   no forward row (saft.test.ts keeps RC-EU-SERV at 11% without one).
 */
export type D406InverseOnlyReason = 'ambiguous' | 'reverse-charge-rate';

/** A reading with no forward row: the engine code a filed TaxCode means, never one to report. */
export type D406InverseOnlyRow = D406VatCodeRow & { readonly reason: D406InverseOnlyReason };

const inverseOnly = (
  row: Omit<D406VatCodeRow, 'description'>,
  reason: D406InverseOnlyReason,
): D406InverseOnlyRow => ({ ...row, description: vatTaxCodes[row.taxCode]!.description, reason });

/**
 * The inverse-only readings, each quoting its code's description and D300 row from 01.08.2025
 * as ANAF's sheets give them (RO_SAFT_SchemaDefCod_16.02.2026.xlsx):
 * - a sale at 9%: Livrari row 22, 310310 (rd. 10.1; rd. 10 until 31.07.2025), and row 69, 310357
 *   "conform art.III din Legea nr.141/ 2025", active from 01.08.2025 (rd. 11); on collection row
 *   48, 310336, without a D300 row, and row 70, 310358 (rd. 11);
 * - a payer's reverse charge at 11%, 9% and 5%: Achizitii ded 100% and Achizitii neded rows
 *   28–29 and 31 (3005xx, rd. 7/22) and rows 38–39 and 41 (3007xx, rd. 7/7.1/22/22.1).
 */
export const d406InverseOnlyCodes: readonly D406InverseOnlyRow[] = [
  inverseOnly({ direction: 'output', code: 'S-9', taxCode: '310310', d300: '10.1' }, 'ambiguous'),
  inverseOnly({ direction: 'output', code: 'S-9', taxCode: '310357', d300: '11' }, 'ambiguous'),
  inverseOnly(
    { direction: 'output', code: 'S-9', cashVat: true, taxCode: '310336', d300: '' },
    'ambiguous',
  ),
  inverseOnly(
    { direction: 'output', code: 'S-9', cashVat: true, taxCode: '310358', d300: '11' },
    'ambiguous',
  ),
  ...(
    [
      ['RC-EU-SERV', '11', '300705', '350705', '7/7.1/22/22.1'],
      ['RC-EU-SERV', '9', '300702', '350702', '7/7.1/22/22.1'],
      ['RC-EU-SERV', '5', '300703', '350703', '7/7.1/22/22.1'],
      ['RC-NONEU-SERV', '11', '300505', '350505', '7/22'],
      ['RC-NONEU-SERV', '9', '300502', '350502', '7/22'],
      ['RC-NONEU-SERV', '5', '300503', '350503', '7/22'],
    ] as const
  ).flatMap(([code, rate, full, none, d300]) =>
    (
      [
        ['full', full],
        ['none', none],
      ] as const
    ).map(([deduction, taxCode]) =>
      inverseOnly(
        { direction: 'input', code, rate, deduction, taxCode, d300 },
        'reverse-charge-rate',
      ),
    ),
  ),
];

/** The forward row tables and code maps this module indexes, with their original references. */
export const d406CodeReadingSources = {
  rows: [
    ['vat', d406VatCodes],
    ['domestic-reverse-charge', d406DomesticReverseChargeCodes],
    ['exempt', d406ExemptCodes],
    ['flat-rate', d406FlatRateCodes],
    ['distance', d406DistanceCodes],
    ['trade', d406TradeCodes],
    ['regime', d406RegimeCodes],
    ['special', d406SpecialCodes],
  ],
  maps: [
    ['cash-vat-release', releaseCodes, d406CashVatReleaseCode],
    ['z-report', zReportCodes, d406ZReportCode],
  ],
} as const;

type CodeMetadata = Readonly<Pick<D406VatCodeRow, 'code' | 'taxCode' | 'description'>>;

/**
 * One data-backed engine meaning of a TaxType 300 TaxCode. `source` distinguishes the forward
 * row table, a cash-VAT release, a Z report and a non-payer's sale. Row readings preserve every
 * key and the quoted D300 rows, including an explicitly empty D300 string. The maps and the
 * non-payer constant quote no D300 row, so those readings have no `d300` field. A cash-VAT
 * release has no direction: its forward function serves both collections and payments. An
 * `inverse-only` reading (`d406InverseOnlyCodes`) says what a filed code means, with the reason
 * its engine code maps forward to no TaxCode.
 */
export type D406CodeReading =
  | (Readonly<D406VatCodeRow> & {
      readonly source: (typeof d406CodeReadingSources.rows)[number][0];
    })
  | (Readonly<D406InverseOnlyRow> & { readonly source: 'inverse-only' })
  | (CodeMetadata & { readonly source: 'cash-vat-release'; readonly cashVat: true })
  | (CodeMetadata & { readonly source: 'z-report'; readonly direction: 'output' })
  | (CodeMetadata & {
      readonly source: 'non-payer-sale';
      readonly direction: 'output';
      readonly code: 'O';
    });

const emptyReadings: readonly D406CodeReading[] = Object.freeze([]);
const readingsByTaxCode = new Map<string, readonly D406CodeReading[]>();

// Compare the whole reading independently of the property order of its forward row.
const identity = (reading: D406CodeReading) =>
  JSON.stringify(Object.entries(reading).sort(([left], [right]) => left.localeCompare(right)));

function addReading(reading: D406CodeReading): void {
  const existing = readingsByTaxCode.get(reading.taxCode) ?? emptyReadings;
  if (existing.some((item) => identity(item) === identity(reading))) return;
  readingsByTaxCode.set(reading.taxCode, Object.freeze([...existing, Object.freeze(reading)]));
}

for (const [source, rows] of d406CodeReadingSources.rows) {
  for (const row of rows) addReading({ source, ...row });
}

// Enumerate the maps' keys; the forward functions decide whether their TaxCodes are active.
for (const [source, codes, taxCodeOf] of d406CodeReadingSources.maps) {
  for (const code of Object.keys(codes)) {
    const taxCode = taxCodeOf(code);
    if (taxCode) {
      const metadata = { code, taxCode, description: vatTaxCodes[taxCode]!.description };
      addReading(
        source === 'cash-vat-release'
          ? { ...metadata, source, cashVat: true }
          : { ...metadata, source, direction: 'output' },
      );
    }
  }
}

addReading({
  source: 'non-payer-sale',
  direction: 'output',
  code: 'O',
  taxCode: d406NonPayerSaleCode,
  description: vatTaxCodes[d406NonPayerSaleCode]!.description,
});

for (const row of d406InverseOnlyCodes) addReading({ source: 'inverse-only', ...row });

/**
 * Every distinct data-backed reading of a SAF-T VAT TaxCode, without choosing between them.
 * An unknown or unmapped code returns an empty array, even if ANAF's nomenclature describes
 * it; `d406UnreadTaxCode` says why each code of the nomenclature without a reading has none.
 * The computed `d406UnionSchemeTax` path has no enumerable forward rows and is not indexed;
 * a TaxCode alone cannot recover its consumer state, rate or reporting policy.
 */
export function d406CodeReadings(taxCode: string): readonly D406CodeReading[] {
  return readingsByTaxCode.get(taxCode) ?? emptyReadings;
}

/** TaxCodes with more than one distinct data-backed engine reading, sorted by TaxCode. */
export const d406AmbiguousTaxCodes: readonly string[] = Object.freeze(
  [...readingsByTaxCode.keys()].filter((taxCode) => d406CodeReadings(taxCode).length > 1).sort(),
);

/**
 * Why a TaxCode of the nomenclature (data/tax `vatTaxCodes`) has no reading:
 * - `inactive`: ANAF's sheet marks it "x - Inactiv" (column E), though data/tax lists it;
 * - `no-engine-operation`: the engine books no operation the code reports;
 * - `regularization`: it regularizes an operation of an earlier period ("Regularizări ..."),
 *   which the engine does not book as an operation of its own;
 * - `informative`: it carries no operation of its own (a marker, or a line another state's
 *   return reports);
 * - `union-scheme`: `d406UnionSchemeTax` computes it from a sale's consumer state and rate, which
 *   the TaxCode alone does not give back.
 */
export type D406UnreadReason =
  'inactive' | 'no-engine-operation' | 'regularization' | 'informative' | 'union-scheme';

/** Codes of the nomenclature without a reading, with the reason and what they are. */
export type D406UnreadGroup = {
  readonly reason: D406UnreadReason;
  /** What the codes are and why the engine reads none of them. */
  readonly what: string;
  readonly codes: readonly string[];
};

const group = (reason: D406UnreadReason, what: string, ...codes: string[]): D406UnreadGroup =>
  Object.freeze({ reason, what, codes: Object.freeze(codes.flatMap((line) => line.split(' '))) });

/**
 * Every TaxType 300 code of data/tax `vatTaxCodes` with no reading, grouped by reason, so that a
 * code without a reading is a decision (saft-tax-code-readings.test.ts checks that each code is
 * read or listed here, never both). Rows cited are of RO_SAFT_SchemaDefCod_16.02.2026.xlsx.
 */
export const d406UnreadTaxCodeGroups: readonly D406UnreadGroup[] = Object.freeze([
  group(
    'inactive',
    'Achizitii ded 50%: the rows column E marks "x - Inactiv" (341105, row 58, also marked, keeps the forward row of S-11 deducted by half).',
    '340202 340203 340205 340302 340303 340305 340402 340403 340405 340502 340503 340505 340602',
    '340603 340605 340702 340703 340705 340802 340803 340805 340901 340902 340903 340904 340905',
    '340906 340907 341102 341103 341202 341203 341205 341302 341303 341304 341305 346301 346302',
    '346303 346311 346312 346313 346314 346315 346316 347301 347302 347311 347312 347313 347314',
    '347315 347316 347321 347322 347323 347324 347325 347326 348301 348302 348303 348304 348305',
    '348306 348307 348308 349102 349103 349107',
  ),
  group(
    'inactive',
    'Achizitii neded: the rows column E marks "x - Inactiv" (358301, row 108, also marked, keeps the forward row of FR-315 not deducted).',
    '351304 356301 356302 356303 356311 356312 356313 356314 356315 356316 357301 357302 357311',
    '357312 357313 357314 357315 357316 357321 357322 357323 357324 357325 357326 358304 358305',
    '358306 358307 358308',
  ),
  group(
    'regularization',
    'Regularizations of intra-Community acquisitions of goods (rows 22–26 of each purchases sheet, D300 rd. 6/21) and of services (rows 42–46, rd. 8/23); in Achizitii ded 50% the rows not marked inactive.',
    '300401 300402 300403 300404 300405 300801 300802 300803 300804 300805 340401 340404 340801',
    '340804 350401 350402 350403 350404 350405 350801 350802 350803 350804 350805 360401 360402',
    '360403 360404 360405 360801 360802 360803 360804 360805',
  ),
  group(
    'regularization',
    '"Regularizări taxă dedusă" (Achizitii ded 100% rows 118–121, the other purchases sheets rows 116–122; D300 rd. 34) other than the rows REG-310 reports (309101, 309106, 309107).',
    '309102 309103 309104 309105 349101 349104 349105 349106 359101 359102 359103 359104 359105',
    '359106 359107 369101 369102 369103 369104 369105 369106 369107',
  ),
  group(
    'regularization',
    'Regularizations of supplies (Livrari rows 14, 20, 27–28, 30–31, 33, 41, 59, 71: D300 rd. 2, 4, 16, 18) other than the rows REG-310 reports (310317, 310345, 310352), and of the flat-rate compensation (Achizitii ded 100% row 114, rd. 29).',
    '308307 310302 310308 310315 310316 310318 310319 310321 310329 310347 310359',
  ),
  group(
    'no-engine-operation',
    "Intra-Community acquisitions of goods with the reverse charge, other than from a supplier registered in the Member State of dispatch (rows 12–16 of each purchases sheet): the engine's AIC-<rate> is the acquisition from such a supplier (trade/acquisition.ts).",
    '300101 300102 300103 300104 300105 350101 350102 350103 350104 350105 360101 360102 360103',
    '360104 360105',
  ),
  group(
    'no-engine-operation',
    'Half or pro-rata deductions of acquisitions whose treatments deduct in full or not at all (AIC, IMP, IMP-DEF, RC-EU-SERV, RC-NONEU-SERV, TI-A: trade/acquisition.ts, trade/import.ts, treatments/cross-border.ts, receipts/reverse-charge.ts): Achizitii ded 50% rows 12, 15, 17, 20, 27, 30, 32, 35, 37, 40, 59, 62 and Achizitii baserate rows 17–21, 27–41, 47–53, 59–63.',
    '340201 340204 340301 340304 340501 340504 340601 340604 340701 340704 341201 341204 360201',
    '360202 360203 360204 360205 360501 360502 360503 360504 360505 360601 360602 360603 360604',
    '360605 360701 360702 360703 360704 360705 360901 360902 360903 360904 360905 360906 360907',
    '361201 361202 361203 361204 361205',
  ),
  group(
    'no-engine-operation',
    'VAT owed through D301 with a deduction (Achizitii ded 100% rows 70–88, Achizitii ded 50% and Achizitii baserate rows 73–78 and 85–88): the cross-border treatment refuses a deduction under the special regime, and a company outside VAT has no intra-Community acquisition of goods in the engine.',
    '306301 306302 306303 306304 306306 306307 306308 306309 306310 306311 306312 306313 306314',
    '306315 306316 306317 306318 306319 306320 346304 346306 346307 346308 346309 346310 346317',
    '346318 346319 346320 366304 366306 366307 366308 366309 366310 366317 366318 366319 366320',
  ),
  group(
    'no-engine-operation',
    'Invoices issued or received after a tax inspection (Livrari rows 34, 50–51, 60, 67; Achizitii ded 100% rows 91–93 and 102–103; the other purchases sheets rows 91–95).',
    '307303 307304 307305 307325 307326 310322 310338 310339 310348 310355 347303 347304 347305',
    '347306 347307 357303 357304 357305 357306 357307 367303 367304 367305 367306 367307',
  ),
  group(
    'no-engine-operation',
    'Invoices issued under art. 11 alin. (6) and (8) after a new VAT registration, for operations of the period the registration was cancelled (Livrari rows 35, 42–46, 61, 65).',
    '310323 310330 310331 310332 310333 310334 310349 310353',
  ),
  group(
    'no-engine-operation',
    'Adjustments on sheet Achizitii baserate (rows 89–90, 96–107): the engine reports its adjustments on Achizitii ded 100% (ADJ-300, ADJ-304, ADJ-305).',
    '367301 367302 367311 367312 367313 367314 367315 367316 367321 367322 367323 367324 367325',
    '367326',
  ),
  group(
    'no-engine-operation',
    "Supplies without an engine basis (Livrari rows 15–16, 18, 36, 39, 53–54): exempt under art. 294 alin. (2) lit. b)–c) or alin. (5), goods supplied outside Romania, intra-Community services exempt where the tax is due, operations outside the scope of VAT (a payer's sale in O is refused; a company outside VAT reports 310326, d406NonPayerSaleCode), and supplies whose collected VAT is shown in one amount.",
    '310303 310304 310306 310324 310327 310341 310342',
  ),
  group(
    'no-engine-operation',
    'Purchases without an engine operation (Achizitii ded 100% rows 110–113, 115–116; Achizitii neded rows 109–110): intra-Community services exempt, VAT refunded to travellers from abroad, and the exempt purchases of the nondeductible sheet (the engine reports an exempt or non-taxable purchase, which has no VAT, on 308302).',
    '308303 308304 308305 308306 308308 308309 358302 358303',
  ),
  group(
    'no-engine-operation',
    'TVA_NoteContabile rows 12–18 ("Autocolectare TVA") and 28 (a cash register\'s sales not subject to VAT, which retail/zreport.ts refuses as UNSUPPORTED).',
    '380001 380002 380003 380004 380005 380006 380007 380304',
  ),
  group(
    'informative',
    'Achizitii ded 100% row 67, purchases reported in another state\'s VAT return, and TVA_NoteContabile row 24, "Notă închidere TVA": the marker of the entry closing the VAT accounts (rate -1), which books no tax entry.',
    '301304 380200',
  ),
  group(
    'union-scheme',
    'Livrari rows 37 and 52: a sale declared in the Union scheme, as ro.d406.oss reads it (d406UnionSchemeTax).',
    '310325 310340',
  ),
]);

const unreadByTaxCode = new Map(
  d406UnreadTaxCodeGroups.flatMap((item) => item.codes.map((code) => [code, item] as const)),
);

/** Why a TaxCode has no reading, or undefined when it is not one of the unread codes. */
export function d406UnreadTaxCode(taxCode: string): D406UnreadGroup | undefined {
  return unreadByTaxCode.get(taxCode);
}
