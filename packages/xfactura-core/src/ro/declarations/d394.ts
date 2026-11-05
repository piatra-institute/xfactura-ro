import { DomainError } from '../../errors';
import { element, serializeXml } from '../../xml/write';
import { isValidCnp, isValidCui } from '../identifiers';

/**
 * The informative statement of domestic supplies and acquisitions (D394, "declarația informativă
 * privind livrările/prestările și achizițiile efectuate pe teritoriul național") for reporting
 * periods from 08/2025, after ANAF's XML structure of 15.09.2025 (structD394_15092025).
 *
 * ANAF's validator (DUKIntegrator, D394Validator J8.0.2 of 08.09.2025) requires the namespace
 * `mfp:anaf:dgti:d394:declaratie:v5` for periods from 08/2025 and `...:v4`, without the 21% and
 * 11% attributes, for 04/2022–07/2025. Where the structure and the validator differ, this module
 * follows the validator: `identificare` and `idReprezentant` are not elements, their fields are
 * attributes of `declaratie394`; the declarant attributes (nume_declar, prenume_declar,
 * functie_declar) are refused as unknown, while the representative's name, capacity and address
 * are always required; tvaDedAI21–tvaDedAI5 are required whatever the declarant's VAT system;
 * facturiASI, bazaASI, tvaV, tip_N and serieF do not exist.
 *
 * Covered: the normal VAT system (sistemTVA 0) and VAT on collection (sistemTVA 1, with the VAT
 * collected and deducted on the invoices paid in the period, tvaCol and tvaDed); supplies (L) and
 * acquisitions (A from suppliers applying the normal VAT system, AI from suppliers applying VAT
 * on collection) with partners registered for VAT in Romania; supplies to persons not registered
 * for VAT; simplified invoices and receipts; the domestic reverse charge (V at rate 0 and C at
 * the rate, with op11 by product code and rezumat1's detaliu, as validator J8.0.2 takes them:
 * no tip_N, no tvaV, V without tva or tvaPR); acquisitions from persons not registered for VAT
 * (N, OPANAF nr. 3.769/2015 anexa nr. 2 secțiunea a 2-a pct. 2: at rate 0, without VAT, by the
 * document received, tip_document; with op11 by the nature of what was bought, required for an
 * individual or a partner without a code, and rezumat1 per document type with its detaliu,
 * nrN and valN); invoice series; storno, cancelled and self-issued invoices; refund details. The
 * structure lets the sections of other regimes be absent: special schemes (LS, AS),
 * non-established partners (tip_partener 3, 4), cash register receipts (op2, lista) and the
 * travel-agency and second-hand margins.
 *
 * Amounts are whole lei, N(15), negative for adjustments; invoice counts are non-negative.
 */

export type D394Type = 'L' | 'T' | 'S' | 'A';

/** VAT rates (cota) of supplies and acquisitions; 0 belongs to the regimes not covered. */
export const d394Rates = ['21', '11', '9', '5', '19', '20', '24'] as const;
export type D394Rate = (typeof d394Rates)[number];

/** The structure's county list (Nomenclator 1) by ISO 3166-2:RO subdivision code. */
export const d394Counties: Readonly<Record<string, string>> = {
  'RO-AB': '01',
  'RO-AR': '02',
  'RO-AG': '03',
  'RO-BC': '04',
  'RO-BH': '05',
  'RO-BN': '06',
  'RO-BT': '07',
  'RO-BV': '08',
  'RO-BR': '09',
  'RO-BZ': '10',
  'RO-CS': '11',
  'RO-CL': '51',
  'RO-CJ': '12',
  'RO-CT': '13',
  'RO-CV': '14',
  'RO-DB': '15',
  'RO-DJ': '16',
  'RO-GL': '17',
  'RO-GR': '52',
  'RO-GJ': '18',
  'RO-HR': '19',
  'RO-HD': '20',
  'RO-IL': '21',
  'RO-IS': '22',
  'RO-IF': '23',
  'RO-MM': '24',
  'RO-MH': '25',
  'RO-MS': '26',
  'RO-NT': '27',
  'RO-OT': '28',
  'RO-PH': '29',
  'RO-SM': '30',
  'RO-SJ': '31',
  'RO-SB': '32',
  'RO-SV': '33',
  'RO-TR': '34',
  'RO-TM': '35',
  'RO-TL': '36',
  'RO-VS': '37',
  'RO-VL': '38',
  'RO-VN': '39',
  'RO-B': '40',
};

export type D394Address = {
  /** taraP: ISO 3166-1 alpha-2 code from the structure's country list. */
  country: string;
  /** judP: ISO 3166-2:RO county code (RO-GL, RO-B), written as the structure's county number.
   * Required for RO, absent elsewhere. */
  county?: string;
  /** locP */
  locality?: string;
  /** strP */
  street?: string;
  /** nrP */
  number?: string;
  /** blP */
  building?: string;
  /** apP */
  apartment?: string;
  /** detP */
  details?: string;
};

export type D394Partner =
  /** tip_partener 1: registered for VAT in Romania; cuiP is the CUI without the RO prefix. */
  | { kind: 'registered'; cui: string; name: string }
  /** tip_partener 2: not registered for VAT. cuiP is the CUI of an entity or the CNP/NIF of an
   * individual; without one, the address identifies the partner. Each record counts as a partner
   * in nrCui2. */
  | { kind: 'unregistered'; code?: string; name: string; address?: D394Address };

/** The product codes of op11 and rezumat1's detaliu for registered partners (Nomenclator cod
 * produse, tip_partener 1): cereals by their NC code, summed under 21 in detaliu; 22–31 and 36
 * the other goods and services of art. 331 alin. (2). */
export const d394ProductCodes = [
  '1001',
  '1002',
  '1003',
  '1004',
  '1005',
  '1201',
  '1205',
  '120600',
  '121291',
  '10086000',
  '120400',
  '22',
  '23',
  '24',
  '25',
  '26',
  '27',
  '28',
  '29',
  '30',
  '31',
  '36',
] as const;
/** The product codes of op11 and rezumat1's detaliu for partners not registered for VAT
 * (Nomenclator cod produse pt tip_partener = 2), the nature of an acquisition of type N (anexa
 * nr. 1 lit. D pct. 6: cereals and technical plants, waste, timber, land, buildings, other goods,
 * services): cereals by their NC code, summed under 21 in detaliu; 22 waste, 23 timber, 32 land,
 * 33 buildings, 34 other goods, 35 services. */
export const d394UnregisteredProductCodes = [
  '1001',
  '1002',
  '1003',
  '1004',
  '1005',
  '1201',
  '1205',
  '120600',
  '121291',
  '10086000',
  '120400',
  '22',
  '23',
  '32',
  '33',
  '34',
  '35',
] as const;
/** The detaliu code (bun) a product is summed under: 21 for the cereals' NC codes. */
export const d394ProductGroup = (code: string) => (code.length > 2 ? '21' : code);

/** tip_document (document_N in rezumat1) of an acquisition of type N: 1 invoices, 2 purchase
 * slips (borderouri de achiziții), 3 sheets of the agricultural sales booklet, 4 contracts, 5
 * other documents. */
export const d394DocumentTypes = {
  invoice: '1',
  purchaseSlip: '2',
  agriculturalBooklet: '3',
  contract: '4',
  other: '5',
} as const;
export type D394DocumentType = keyof typeof d394DocumentTypes;

/** op11: one product of a reverse-charge operation (V, C) or the nature of an acquisition from a
 * person not registered for VAT (N). On an invoice holding several, nrFactPR is 1 for the product
 * with the largest base (V, N) or VAT (C), 0 for the others. */
export type D394Product = {
  /** codPR: of d394ProductCodes for V and C, of d394UnregisteredProductCodes for N. */
  code: (typeof d394ProductCodes)[number] | (typeof d394UnregisteredProductCodes)[number];
  /** nrFactPR */
  invoices: number;
  /** bazaPR */
  base: number;
  /** tvaPR; absent for V and N. */
  vat: number;
};

export type D394Operation = {
  /** tip: L supplies of goods and services; A acquisitions from suppliers applying the normal
   * VAT system; AI acquisitions from suppliers applying VAT on collection; V supplies and C
   * acquisitions under the domestic reverse charge (art. 331), registered partners only, with
   * their products; N acquisitions from persons not registered for VAT. Unregistered partners
   * take only L and N. Simplified invoices are reported per rate, not here. */
  type: 'L' | 'A' | 'AI' | 'V' | 'C' | 'N';
  /** cota: 0 for V and N, the self-assessed rate for C. */
  rate: D394Rate | '0';
  partner: D394Partner;
  /** nrFact: invoices (for N, the documents of `document`) with this partner, of this type and
   * rate, in the period. */
  invoices: number;
  /** baza: for N, the value of the acquisitions. */
  base: number;
  /** tva; 0 for V and N, which write none. */
  vat: number;
  /** tip_document, for N. */
  document?: D394DocumentType;
  /** op11, for V and C, and for N its nature (required for an individual, identified by CNP or
   * NIF, or a partner without a code, and refused for any other, R233.4). */
  products?: D394Product[];
};

export type D394Amount = { base: number; vat: number };

/** Simplified invoices and receipts of one rate (rezumat2); an absent kind has none. */
export type D394Simplified = {
  /** bazaFSLcod, TVAFSLcod: supplies with simplified invoices showing the customer's VAT code. */
  salesWithCode?: D394Amount;
  /** bazaFSL, TVAFSL: supplies with simplified invoices without the customer's VAT code, for
   * which no fiscal receipt was issued. */
  salesWithoutCode?: D394Amount;
  /** bazaFSA, TVAFSA: acquisitions with simplified invoices showing the company's VAT code, from
   * suppliers applying the normal VAT system, without fiscal receipts. */
  purchases?: D394Amount;
  /** bazaFSAI, TVAFSAI: the same, from suppliers applying VAT on collection. */
  purchasesCashVat?: D394Amount;
  /** bazaBFAI, TVABFAI: acquisitions with fiscal receipts that meet the conditions of a
   * simplified invoice and show the company's VAT code. */
  receipts?: D394Amount;
};

type Range = {
  /** serieI */
  series?: string;
  /** nrI */
  first: string;
  /** nrF */
  last?: string;
};

/** serieFacturi: tip 1 a range allocated to the company, 2 invoices it issued in the period,
 * 3 invoices beneficiaries issued on its behalf, 4 invoices third parties issued on its behalf. */
export type D394InvoiceSeries =
  | (Range & { type: 'allocated' | 'issued' })
  | (Range & {
      type: 'beneficiary' | 'thirdParty';
      /** den, cui: the beneficiary or third party. */
      issuer: { name: string; cui: string };
    });

/** facturi: tip_factura 1 storno, 2 cancelled, 3 self-invoiced (autofacturare), 4 issued as
 * beneficiary on behalf of suppliers. Only self-invoices carry amounts; a rate absent from them
 * is written as 0. */
export type D394Invoice =
  | { type: 'storno' | 'cancelled' | 'onBehalf'; series?: string; number: string }
  | {
      type: 'selfInvoice';
      series?: string;
      number: string;
      amounts: Partial<Record<D394Rate, D394Amount>>;
    };

/** Nature of the period's operations, required when the VAT return requests a refund. */
export const d394RefundFlags = [
  ['achizitiiPE', 'Achiziții legate direct de bunuri imobile: parcuri eoliene'],
  ['achizitiiCR', 'Achiziții legate direct de bunuri imobile: construcții rezidențiale'],
  ['achizitiiCB', 'Achiziții legate direct de bunuri imobile: clădiri de birouri'],
  ['achizitiiCI', 'Achiziții legate direct de bunuri imobile: construcții industriale'],
  ['achizitiiA', 'Achiziții legate direct de bunuri imobile: altele'],
  ['achizitiiB24', 'Achiziții de bunuri, altele decât cele legate de bunuri imobile, cota 24%'],
  ['achizitiiB21', 'Achiziții de bunuri, altele decât cele legate de bunuri imobile, cota 21%'],
  ['achizitiiB11', 'Achiziții de bunuri, altele decât cele legate de bunuri imobile, cota 11%'],
  ['achizitiiB20', 'Achiziții de bunuri, altele decât cele legate de bunuri imobile, cota 20%'],
  ['achizitiiB19', 'Achiziții de bunuri, altele decât cele legate de bunuri imobile, cota 19%'],
  ['achizitiiB9', 'Achiziții de bunuri, altele decât cele legate de bunuri imobile, cota 9%'],
  ['achizitiiB5', 'Achiziții de bunuri, altele decât cele legate de bunuri imobile, cota 5%'],
  ['achizitiiS24', 'Achiziții de servicii, altele decât cele legate de bunuri imobile, cota 24%'],
  ['achizitiiS21', 'Achiziții de servicii, altele decât cele legate de bunuri imobile, cota 21%'],
  ['achizitiiS11', 'Achiziții de servicii, altele decât cele legate de bunuri imobile, cota 11%'],
  ['achizitiiS20', 'Achiziții de servicii, altele decât cele legate de bunuri imobile, cota 20%'],
  ['achizitiiS19', 'Achiziții de servicii, altele decât cele legate de bunuri imobile, cota 19%'],
  ['achizitiiS9', 'Achiziții de servicii, altele decât cele legate de bunuri imobile, cota 9%'],
  ['achizitiiS5', 'Achiziții de servicii, altele decât cele legate de bunuri imobile, cota 5%'],
  ['importB', 'Importuri de bunuri'],
  ['acINecorp', 'Achiziții de imobilizări necorporale'],
  ['livrariBI', 'Livrări de bunuri imobile'],
  ['BUN24', 'Livrări de bunuri, cu excepția bunurilor imobile, cota 24%'],
  ['BUN21', 'Livrări de bunuri, cu excepția bunurilor imobile, cota 21%'],
  ['BUN11', 'Livrări de bunuri, cu excepția bunurilor imobile, cota 11%'],
  ['BUN20', 'Livrări de bunuri, cu excepția bunurilor imobile, cota 20%'],
  ['BUN19', 'Livrări de bunuri, cu excepția bunurilor imobile, cota 19%'],
  ['BUN9', 'Livrări de bunuri, cu excepția bunurilor imobile, cota 9%'],
  ['BUN5', 'Livrări de bunuri, cu excepția bunurilor imobile, cota 5%'],
  ['valoareScutit', 'Livrări de bunuri scutite de TVA'],
  ['BunTI', 'Livrări de bunuri/prestări de servicii pentru care se aplică taxarea inversă'],
  ['Prest24', 'Prestări de servicii, cota 24%'],
  ['Prest21', 'Prestări de servicii, cota 21%'],
  ['Prest11', 'Prestări de servicii, cota 11%'],
  ['Prest20', 'Prestări de servicii, cota 20%'],
  ['Prest19', 'Prestări de servicii, cota 19%'],
  ['Prest9', 'Prestări de servicii, cota 9%'],
  ['Prest5', 'Prestări de servicii, cota 5%'],
  ['PrestScutit', 'Prestări de servicii scutite de TVA'],
  ['LIntra', 'Livrări intracomunitare de bunuri'],
  ['PrestIntra', 'Prestări intracomunitare de servicii'],
  ['Export', 'Exporturi de bunuri'],
  ['livINecorp', 'Livrări de imobilizări necorporale'],
  ['efectuat', 'Persoana impozabilă a efectuat livrări de bunuri/prestări de servicii în perioadă'],
] as const;
export type D394RefundFlag = (typeof d394RefundFlags)[number][0];

export type D394Preparer =
  /** tip_intocmit 0: a legal person, identified by its CUI; calitate_intocmit is required. */
  | { kind: 'company'; cui: string; name: string; capacity: string }
  /** tip_intocmit 1: an individual, identified by CNP or NIF, with a capacity
   * (calitate_intocmit), a position in the taxable person (functie_intocmit), or both. */
  | { kind: 'individual'; cnp: string; name: string; capacity?: string; position?: string };

export type D394 = {
  /** luna, an: the period's last month (the quarter's, semester's or year's for T, S, A). */
  period: { year: number; month: number };
  /** tip_D394: L lunar, T trimestrial, S semestrial, A anual. */
  type: D394Type;
  company: {
    /** cui: the VAT registration code, digits only, without the RO prefix. */
    cui: string;
    /** caen: a CAEN Rev. 2 or Rev. 3 class. */
    caen: string;
    /** den */
    name: string;
    /** adresa: the fiscal domicile, as free text. */
    address: string;
    /** telefon: required by the structure. */
    phone: string;
    /** fax */
    fax?: string;
    /** mail */
    email?: string;
  };
  /** The legal representative or proxy (idReprezentant). */
  representative: {
    /** cifR: CUI, CNP or NIF. */
    cif?: string;
    /** denR */
    name: string;
    /** functie_reprez: the capacity in which the representative acts. */
    role: string;
    /** adresaR */
    address: string;
    /** telefonR */
    phone?: string;
    /** faxR */
    fax?: string;
    /** mailR */
    email?: string;
  };
  /** Who prepared the statement (tip_intocmit, den_intocmit, cif_intocmit, …). */
  preparer: D394Preparer;
  /** optiune: consent to the consultation of the transactions conducted with the company through
   * ANAF's applications ("consultarea … tranzacțiilor derulate cu aceasta"). */
  consultation: boolean;
  /** schimb_optiune: this statement changes an earlier refusal into consent. */
  consultationChanged?: boolean;
  /** prsAfiliat: operations with affiliated persons in the period. */
  affiliates: boolean;
  /** op1, in the order given. */
  operations: D394Operation[];
  /** rezumat2 inputs by rate; a rate absent here had no simplified invoices or receipts. */
  simplified: Partial<Record<D394Rate, D394Simplified>>;
  /** serieFacturi */
  series: D394InvoiceSeries[];
  /** nrFacturi, nrFacturi_benef, nrFacturi_terti: invoices issued in the period by the company,
   * by beneficiaries on its behalf and by third parties on its behalf. */
  issuedInvoices: { own: number; byBeneficiaries: number; byThirdParties: number };
  /** facturi */
  invoices: D394Invoice[];
  /** tvaDedAI<rate>: deductible VAT of invoices paid in the period, whenever received, to
   * suppliers applying VAT on collection. The structure requires every rate but 24; an absent
   * rate is written as 0, and 24 only when given. */
  cashVatDeductible: Partial<Record<D394Rate, number>>;
  /** sistemTVA 1: the company applies VAT on collection. tvaCol<rate>: the VAT collected on the
   * invoices it collected in the period, whenever issued; tvaDed<rate>: the deductible VAT of the
   * invoices it paid in the period, whenever received, to suppliers applying the normal VAT
   * system. Every rate is written, an absent one as 0. */
  vatOnCollection?: {
    collected: Partial<Record<D394Rate, number>>;
    deductible: Partial<Record<D394Rate, number>>;
  };
  /** solicit: the period's VAT return requests a refund; then every flag is written (0/1). */
  refund?: Record<D394RefundFlag, boolean>;
};

export type D394Totals = { invoices: bigint; base: bigint; vat: bigint };

/** rezumat1: one per partner type and rate present among the operations. */
export type D394PartnerSummary = {
  partnerType: 1 | 2;
  rate: D394Rate | '0';
  /** document_N: rate 0 of unregistered partners, one summary per document type. */
  document?: D394DocumentType;
  /** facturiN, bazaN: acquisitions from unregistered partners (N), rate 0. */
  unregisteredAcquisitions?: D394Totals;
  /** facturiL, bazaL, tvaL */
  supplies: D394Totals;
  /** facturiA, bazaA, tvaA; registered partners only. */
  acquisitions?: D394Totals;
  /** facturiAI, bazaAI, tvaAI; registered partners only. */
  cashVatAcquisitions?: D394Totals;
  /** facturiV, bazaV: rate 0, registered partners only. */
  reverseSupplies?: D394Totals;
  /** facturiC, bazaC, tvaC: registered partners only. */
  reverseAcquisitions?: D394Totals;
  /** detaliu: for registered partners the reverse-charge products by code (bun), nrLivV/bazaLivV
   * at rate 0, nrAchizC/bazaAchizC/tvaAchizC at a rate; for unregistered ones at rate 0 the
   * nature of the acquisitions N (bun), nrN/valN. */
  details?: { code: string; totals: D394Totals }[];
};

/** rezumat2: one per rate with operations or simplified invoices. */
export type D394RateSummary = {
  rate: D394Rate;
  /** nrFacturiL, bazaL, tvaL */
  supplies: D394Totals;
  /** nrFacturiA, bazaA, tvaA */
  acquisitions: D394Totals;
  /** nrFacturiAI, bazaAI, tvaAI */
  cashVatAcquisitions: D394Totals;
  simplified: Record<keyof D394Simplified, { base: bigint; vat: bigint }>;
};

export type D394Calculation = {
  namespace: string;
  /** op_efectuate: the statement reports operations, simplified invoices, series or invoices. */
  operationsReported: boolean;
  /** nrCui1: distinct registered partners; nrCui2: records of unregistered partners. */
  partners: { registered: number; unregistered: number };
  byPartner: D394PartnerSummary[];
  byRate: D394RateSummary[];
  /** totalPlata_A: nrCui1–nrCui4 plus every rezumat2 bazaL, bazaA and bazaAI. */
  controlSum: bigint;
};

const maxAmount = 999_999_999_999_999n; // N(15)
const typeMonths: Record<D394Type, readonly number[]> = {
  L: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  // Quarterly statements end a quarter or, with intra-community acquisitions, its second month.
  T: [2, 3, 5, 6, 8, 9, 11, 12],
  S: [6, 12],
  A: [12],
};
const seriesCodes = { allocated: '1', issued: '2', beneficiary: '3', thirdParty: '4' } as const;
const invoiceCodes = { storno: '1', cancelled: '2', selfInvoice: '3', onBehalf: '4' } as const;
const simplifiedKinds = [
  'salesWithCode',
  'salesWithoutCode',
  'purchases',
  'purchasesCashVat',
  'receipts',
] as const satisfies readonly (keyof D394Simplified)[];

const periodIndex = (year: number, month: number) => year * 12 + month - 1;
const firstPeriod = periodIndex(2025, 8);

function isPeriod(period: D394['period']): boolean {
  return (
    Number.isInteger(period.year) &&
    Number.isInteger(period.month) &&
    period.month >= 1 &&
    period.month <= 12 &&
    period.year <= 2100 &&
    periodIndex(period.year, period.month) >= firstPeriod
  );
}

const periodMessage =
  'Declarația D394 în această structură se depune pentru perioade din august 2025 încolo.';

/** The structure's namespace for a reporting period from 08/2025. */
export function d394Namespace(period: D394['period']): string {
  if (!isPeriod(period)) throw new DomainError('D394_PERIOD', periodMessage);
  return 'mfp:anaf:dgti:d394:declaratie:v5';
}

const isRate = (rate: string): rate is D394Rate => (d394Rates as readonly string[]).includes(rate);

function amountError(value: unknown, label: string): string | undefined {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Math.abs(value) > 999_999_999_999_999
  )
    return `${label} se completează în lei, fără zecimale, cu cel mult 15 cifre.`;
  return undefined;
}

function countError(value: unknown, label: string): string | undefined {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 999_999_999_999_999
  )
    return `${label} este un număr natural de cel mult 15 cifre.`;
  return undefined;
}

type Problem = { code: string; path: string; message: string };

/** The inputs calculateD394 cannot use: amounts, counts, rates and operation types. */
function inputProblems(model: D394): Problem[] {
  const problems: Problem[] = [];
  const amount = (path: string, value: unknown, label: string) => {
    const message = amountError(value, label);
    if (message) problems.push({ code: 'D394_AMOUNT', path, message });
  };
  const count = (path: string, value: unknown, label: string) => {
    const message = countError(value, label);
    if (message) problems.push({ code: 'D394_AMOUNT', path, message });
  };
  model.operations.forEach((operation, index) => {
    const path = `operations.${index}`;
    const reverse = operation.type === 'V' || operation.type === 'C';
    const unregistered = operation.type === 'N';
    if (operation.type === 'V' || unregistered ? operation.rate !== '0' : !isRate(operation.rate))
      problems.push({
        code: 'D394_RATE',
        path: `${path}.rate`,
        message: `Cota ${operation.rate} nu se declară în D394 pentru acest tip de operațiune.`,
      });
    if (reverse && operation.partner.kind !== 'registered')
      problems.push({
        code: 'D394_OPERATION',
        path: `${path}.type`,
        message:
          'Taxarea inversă internă (V, C) se declară doar cu parteneri înregistrați în scopuri de TVA.',
      });
    if (reverse) {
      const products = operation.products ?? [];
      if (!products.length)
        problems.push({
          code: 'D394_PRODUCTS',
          path: `${path}.products`,
          message: 'O operațiune cu taxare inversă se declară cu produsele ei (op11).',
        });
      products.forEach((product, at) => {
        if (!(d394ProductCodes as readonly string[]).includes(product.code))
          problems.push({
            code: 'D394_PRODUCTS',
            path: `${path}.products.${at}.code`,
            message: `Codul de produs ${product.code} nu este în nomenclatorul D394.`,
          });
        count(`${path}.products.${at}.invoices`, product.invoices, 'Numărul de facturi');
        amount(`${path}.products.${at}.base`, product.base, 'Baza impozabilă');
        amount(`${path}.products.${at}.vat`, product.vat, 'TVA');
      });
      const sum = (field: 'base' | 'vat') =>
        products.reduce((total, product) => total + product[field], 0);
      if (
        products.length &&
        (sum('base') !== operation.base ||
          sum('vat') !== operation.vat ||
          (operation.type === 'V' && operation.vat !== 0))
      )
        problems.push({
          code: 'D394_PRODUCTS',
          path: `${path}.products`,
          message:
            operation.type === 'V'
              ? 'Livrările cu taxare inversă nu au TVA, iar produsele lor însumează baza operațiunii.'
              : 'Produsele operațiunii însumează baza și TVA ei.',
        });
    }
    if (unregistered) {
      // N: acquisitions from a person not registered for VAT, by the document received, without
      // VAT; their nature (op11) is required for an individual or a partner without a code.
      const { partner } = operation;
      if (partner.kind !== 'unregistered')
        problems.push({
          code: 'D394_OPERATION',
          path: `${path}.type`,
          message:
            'Achizițiile de tip N se declară doar de la persoane neînregistrate în scopuri de TVA.',
        });
      if (!operation.document || !(operation.document in d394DocumentTypes))
        problems.push({
          code: 'D394_DOCUMENT',
          path: `${path}.document`,
          message:
            'O achiziție de tip N se declară cu tipul documentului: factură, borderou de achiziții, filă din carnetul de comercializare, contract sau alt document.',
        });
      if (operation.vat !== 0)
        problems.push({
          code: 'D394_OPERATION',
          path: `${path}.vat`,
          message: 'Achizițiile de la persoane neînregistrate în scopuri de TVA nu au TVA.',
        });
      const products = operation.products ?? [];
      const individual =
        partner.kind === 'unregistered' &&
        (partner.code === undefined || /^\d{13}$/.test(partner.code));
      if (individual && !products.length)
        problems.push({
          code: 'D394_PRODUCTS',
          path: `${path}.products`,
          message: `Achiziția de la ${partner.name} se declară cu natura bunurilor sau serviciilor (op11): persoană fizică sau partener fără cod.`,
        });
      // R233.4: only an individual's acquisitions (or a partner's without a code) carry op11.
      if (!individual && products.length)
        problems.push({
          code: 'D394_PRODUCTS',
          path: `${path}.products`,
          message: `Natura bunurilor sau serviciilor (op11) se declară doar pentru achizițiile de la persoane fizice, nu de la ${partner.name}.`,
        });
      products.forEach((product, at) => {
        if (!(d394UnregisteredProductCodes as readonly string[]).includes(product.code))
          problems.push({
            code: 'D394_PRODUCTS',
            path: `${path}.products.${at}.code`,
            message: `Codul ${product.code} nu este în nomenclatorul produselor achiziționate de la persoane neînregistrate.`,
          });
        count(`${path}.products.${at}.invoices`, product.invoices, 'Numărul de documente');
        amount(`${path}.products.${at}.base`, product.base, 'Valoarea');
        if (product.vat !== 0)
          problems.push({
            code: 'D394_PRODUCTS',
            path: `${path}.products.${at}.vat`,
            message: 'Produsele achiziționate de la persoane neînregistrate nu au TVA.',
          });
      });
      if (
        products.length &&
        products.reduce((total, product) => total + product.base, 0) !== operation.base
      )
        problems.push({
          code: 'D394_PRODUCTS',
          path: `${path}.products`,
          message: 'Produsele achiziției însumează valoarea ei.',
        });
    } else if (operation.document !== undefined)
      problems.push({
        code: 'D394_DOCUMENT',
        path: `${path}.document`,
        message: 'Tipul documentului se declară doar pentru achizițiile de tip N.',
      });
    if (
      !['L', 'A', 'AI', 'V', 'C', 'N'].includes(operation.type) ||
      !['registered', 'unregistered'].includes(operation.partner.kind)
    )
      problems.push({
        code: 'D394_OPERATION',
        path: `${path}.type`,
        message: `Tipul de operațiune ${operation.type} nu este acoperit.`,
      });
    else if (operation.partner.kind === 'unregistered' && !['L', 'N'].includes(operation.type))
      problems.push({
        code: 'D394_OPERATION',
        path: `${path}.type`,
        message:
          'Cu persoane neînregistrate în scopuri de TVA se declară livrări (L) și achiziții (N).',
      });
    count(`${path}.invoices`, operation.invoices, 'Numărul de facturi');
    amount(`${path}.base`, operation.base, 'Baza impozabilă');
    amount(`${path}.vat`, operation.vat, 'TVA');
  });
  for (const [rate, entry] of Object.entries(model.simplified)) {
    if (!entry) continue;
    if (!isRate(rate)) {
      problems.push({
        code: 'D394_RATE',
        path: `simplified.${rate}`,
        message: `Cota ${rate} nu există în D394.`,
      });
      continue;
    }
    for (const kind of simplifiedKinds) {
      const value = entry[kind];
      if (!value) continue;
      amount(`simplified.${rate}.${kind}.base`, value.base, 'Baza impozabilă');
      amount(`simplified.${rate}.${kind}.vat`, value.vat, 'TVA');
    }
  }
  for (const [path, values, label] of [
    ['cashVatDeductible', model.cashVatDeductible, 'TVA deductibilă'],
    ['vatOnCollection.collected', model.vatOnCollection?.collected ?? {}, 'TVA colectată'],
    ['vatOnCollection.deductible', model.vatOnCollection?.deductible ?? {}, 'TVA deductibilă'],
  ] as const)
    for (const [rate, value] of Object.entries(values)) {
      if (value === undefined) continue;
      if (!isRate(rate))
        problems.push({
          code: 'D394_RATE',
          path: `${path}.${rate}`,
          message: `Cota ${rate} nu există în D394.`,
        });
      else amount(`${path}.${rate}`, value, label);
    }
  model.invoices.forEach((invoice, index) => {
    if (invoice.type !== 'selfInvoice') return;
    for (const [rate, value] of Object.entries(invoice.amounts)) {
      const path = `invoices.${index}.amounts.${rate}`;
      if (!isRate(rate)) {
        problems.push({ code: 'D394_RATE', path, message: `Cota ${rate} nu există în D394.` });
        continue;
      }
      if (!value) continue;
      amount(`${path}.base`, value.base, 'Baza impozabilă');
      amount(`${path}.vat`, value.vat, 'TVA');
    }
  });
  count('issuedInvoices.own', model.issuedInvoices.own, 'Numărul de facturi emise');
  count(
    'issuedInvoices.byBeneficiaries',
    model.issuedInvoices.byBeneficiaries,
    'Numărul de facturi emise de beneficiari',
  );
  count(
    'issuedInvoices.byThirdParties',
    model.issuedInvoices.byThirdParties,
    'Numărul de facturi emise de terți',
  );
  return problems;
}

const zero = (): D394Totals => ({ invoices: 0n, base: 0n, vat: 0n });
function add(totals: D394Totals, operation: D394Operation) {
  totals.invoices += BigInt(operation.invoices);
  totals.base += BigInt(operation.base);
  totals.vat += BigInt(operation.vat);
}
const partnerType = (partner: D394Partner) => (partner.kind === 'registered' ? 1 : 2);
// Rate 0 (reverse-charged supplies) first.
const byRateOrder = (a: { rate: D394Rate | '0' }, b: { rate: D394Rate | '0' }) =>
  (d394Rates as readonly string[]).indexOf(a.rate) -
  (d394Rates as readonly string[]).indexOf(b.rate);

/**
 * The summaries, partner counts, op_efectuate and control sum of a statement. Throws when an
 * amount, count, rate or operation type is not one the statement accepts; checkD394 lists those
 * without throwing.
 */
export function calculateD394(model: D394): D394Calculation {
  const namespace = d394Namespace(model.period);
  const [problem] = inputProblems(model);
  if (problem) throw new DomainError(problem.code, problem.message);

  const partners = new Map<string, D394PartnerSummary>();
  const rates = new Map<D394Rate, D394RateSummary>();
  const rateSummary = (rate: D394Rate) => {
    let summary = rates.get(rate);
    if (!summary) {
      summary = {
        rate,
        supplies: zero(),
        acquisitions: zero(),
        cashVatAcquisitions: zero(),
        simplified: Object.fromEntries(
          simplifiedKinds.map((kind) => [kind, { base: 0n, vat: 0n }]),
        ) as D394RateSummary['simplified'],
      };
      rates.set(rate, summary);
    }
    return summary;
  };
  const registered = new Set<string>();
  let unregistered = 0;
  for (const operation of model.operations) {
    const type = partnerType(operation.partner);
    if (operation.partner.kind === 'registered') registered.add(operation.partner.cui);
    else unregistered += 1;
    const key = `${type}|${operation.rate}|${operation.document ?? ''}`;
    let summary = partners.get(key);
    if (!summary) {
      summary =
        type === 2
          ? operation.type === 'N'
            ? {
                partnerType: 2,
                rate: '0',
                document: operation.document!,
                supplies: zero(),
                unregisteredAcquisitions: zero(),
                details: [],
              }
            : { partnerType: 2, rate: operation.rate, supplies: zero() }
          : operation.rate === '0'
            ? {
                partnerType: 1,
                rate: operation.rate,
                supplies: zero(),
                reverseSupplies: zero(),
                details: [],
              }
            : {
                partnerType: 1,
                rate: operation.rate,
                supplies: zero(),
                acquisitions: zero(),
                cashVatAcquisitions: zero(),
                reverseAcquisitions: zero(),
                details: [],
              };
      partners.set(key, summary);
    }
    // Rate 0 (V) has no rezumat2: the structure lists none for it.
    const byRate = operation.rate === '0' ? null : rateSummary(operation.rate);
    if (operation.type === 'L') {
      add(summary.supplies, operation);
      add(byRate!.supplies, operation);
    } else if (operation.type === 'A') {
      add(summary.acquisitions!, operation);
      add(byRate!.acquisitions, operation);
    } else if (operation.type === 'AI') {
      add(summary.cashVatAcquisitions!, operation);
      add(byRate!.cashVatAcquisitions, operation);
    } else if (operation.type === 'N') {
      // Rate 0: no rezumat2. detaliu sums the nature of what was bought (nrN, valN).
      add(summary.unregisteredAcquisitions!, operation);
      for (const product of operation.products ?? []) {
        const code = d394ProductGroup(product.code);
        const details = (summary.details ??= []);
        let detail = details.find((item) => item.code === code);
        if (!detail) details.push((detail = { code, totals: zero() }));
        detail.totals.invoices += BigInt(product.invoices);
        detail.totals.base += BigInt(product.base);
      }
    } else {
      // rezumat2 counts C among the acquisitions (nrFacturiA, bazaA, tvaA are A or C).
      add(
        operation.type === 'V' ? summary.reverseSupplies! : summary.reverseAcquisitions!,
        operation,
      );
      if (operation.type === 'C') add(byRate!.acquisitions, operation);
      for (const product of operation.products ?? []) {
        const code = d394ProductGroup(product.code);
        const details = (summary.details ??= []);
        let detail = details.find((item) => item.code === code);
        if (!detail) details.push((detail = { code, totals: zero() }));
        detail.totals.invoices += BigInt(product.invoices);
        detail.totals.base += BigInt(product.base);
        detail.totals.vat += BigInt(product.vat);
      }
    }
  }
  for (const summary of partners.values())
    summary.details?.sort((a, b) => Number(a.code) - Number(b.code));
  for (const [rate, entry] of Object.entries(model.simplified) as [D394Rate, D394Simplified][]) {
    if (!entry) continue;
    const summary = rateSummary(rate);
    for (const kind of simplifiedKinds) {
      const value = entry[kind];
      if (value) summary.simplified[kind] = { base: BigInt(value.base), vat: BigInt(value.vat) };
    }
  }

  const documentOrder = (summary: D394PartnerSummary) =>
    summary.document ? Number(d394DocumentTypes[summary.document]) : 0;
  const byPartner = [...partners.values()].sort(
    (a, b) =>
      a.partnerType - b.partnerType || byRateOrder(a, b) || documentOrder(a) - documentOrder(b),
  );
  const byRate = [...rates.values()].sort(byRateOrder);
  const controlSum = byRate.reduce(
    (total, summary) =>
      total + summary.supplies.base + summary.acquisitions.base + summary.cashVatAcquisitions.base,
    BigInt(registered.size + unregistered),
  );
  return {
    namespace,
    operationsReported:
      model.operations.length > 0 ||
      byRate.length > 0 ||
      model.series.length > 0 ||
      model.invoices.length > 0,
    partners: { registered: registered.size, unregistered },
    byPartner,
    byRate,
    controlSum,
  };
}

const flag = (value: boolean) => (value ? '1' : '0');
const text = (value: bigint | number) => value.toString();
const totals = (suffix: string, value: D394Totals, count = `facturi${suffix}`) => ({
  [count]: text(value.invoices),
  [`baza${suffix}`]: text(value.base),
  [`tva${suffix}`]: text(value.vat),
});
// Rates of the self-invoice and tvaDedAI attributes, in the structure's order; 24 is optional.
const requiredRates = ['21', '11', '20', '19', '9', '5'] as const;

function county(code: string): string {
  const number = d394Counties[code];
  if (!number)
    throw new DomainError('D394_ADDRESS', `Județul ${code} nu există în nomenclatorul D394.`);
  return number;
}

/**
 * Writes the statement as one `declaratie394` element: identification attributes, informatii,
 * rezumat1 by partner type and rate, rezumat2 by rate, serieFacturi, facturi and op1, in the
 * validator's order. Summaries, partner counts, op_efectuate and totalPlata_A are computed.
 */
export function writeD394(model: D394): string {
  const calculation = calculateD394(model);
  const { company, representative, preparer } = model;
  const cashVat = model.cashVatDeductible;
  // Every rate, an absent one as 0; 24 for tvaDedAI only when given (the validator requires
  // tvaDed24 and tvaCol24 under VAT on collection, R135.2 and R143.2).
  const byRate = (prefix: string, values: Partial<Record<D394Rate, number>>, all = false) => ({
    [`${prefix}24`]: values['24'] === undefined && !all ? undefined : text(values['24'] ?? 0),
    ...Object.fromEntries(
      requiredRates.map((rate) => [`${prefix}${rate}`, text(values[rate] ?? 0)]),
    ),
  });
  return serializeXml(
    element(
      'declaratie394',
      {
        xmlns: calculation.namespace,
        'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
        'xsi:schemaLocation': `${calculation.namespace} D394.xsd`,
        luna: String(model.period.month),
        an: String(model.period.year),
        tip_D394: model.type,
        sistemTVA: model.vatOnCollection ? '1' : '0',
        op_efectuate: flag(calculation.operationsReported),
        prsAfiliat: flag(model.affiliates),
        cui: company.cui,
        caen: company.caen,
        den: company.name,
        adresa: company.address,
        telefon: company.phone,
        fax: company.fax,
        mail: company.email,
        totalPlata_A: text(calculation.controlSum),
        cifR: representative.cif,
        denR: representative.name,
        functie_reprez: representative.role,
        adresaR: representative.address,
        telefonR: representative.phone,
        faxR: representative.fax,
        mailR: representative.email,
        tip_intocmit: preparer.kind === 'company' ? '0' : '1',
        den_intocmit: preparer.name,
        cif_intocmit: preparer.kind === 'company' ? preparer.cui : preparer.cnp,
        calitate_intocmit: preparer.capacity,
        functie_intocmit: preparer.kind === 'individual' ? preparer.position : undefined,
        optiune: flag(model.consultation),
        schimb_optiune: model.consultationChanged ? '1' : undefined,
      },
      element('informatii', {
        nrCui1: text(calculation.partners.registered),
        nrCui2: text(calculation.partners.unregistered),
        nrCui3: '0',
        nrCui4: '0',
        // Totals of op2 (cash registers), which this module does not write.
        nr_BF_i1: '0',
        incasari_i1: '0',
        incasari_i2: '0',
        nrFacturi_terti: text(model.issuedInvoices.byThirdParties),
        nrFacturi_benef: text(model.issuedInvoices.byBeneficiaries),
        nrFacturi: text(model.issuedInvoices.own),
        ...(model.vatOnCollection && byRate('tvaDed', model.vatOnCollection.deductible, true)),
        ...byRate('tvaDedAI', cashVat),
        ...(model.vatOnCollection && byRate('tvaCol', model.vatOnCollection.collected, true)),
        solicit: flag(model.refund !== undefined),
        ...(model.refund &&
          Object.fromEntries(d394RefundFlags.map(([name]) => [name, flag(model.refund![name])]))),
      }),
      calculation.byPartner.map((summary) =>
        summary.unregisteredAcquisitions
          ? // Rate 0 of unregistered partners: their acquisitions (N) of one document type, with
            // the nature of what was bought.
            element(
              'rezumat1',
              {
                tip_partener: '2',
                cota: '0',
                // R41, R42: with invoices (document_N 1) the special schemes' supplies, which this
                // module does not write, are 0; with any other document they are absent.
                ...(summary.document === 'invoice' ? { facturiLS: '0', bazaLS: '0' } : {}),
                facturiN: text(summary.unregisteredAcquisitions.invoices),
                document_N: d394DocumentTypes[summary.document!],
                bazaN: text(summary.unregisteredAcquisitions.base),
              },
              (summary.details ?? []).map((detail) =>
                element('detaliu', {
                  bun: detail.code,
                  nrN: text(detail.totals.invoices),
                  valN: text(detail.totals.base),
                }),
              ),
            )
          : summary.reverseSupplies
            ? // Rate 0 of a registered partner: the supplies under reverse charge (V), with the
              // special schemes' fields the validator requires there (R41.1, R42.1, R49.1, R50.1).
              element(
                'rezumat1',
                {
                  tip_partener: '1',
                  cota: '0',
                  facturiLS: '0',
                  bazaLS: '0',
                  facturiAS: '0',
                  bazaAS: '0',
                  facturiV: text(summary.reverseSupplies.invoices),
                  bazaV: text(summary.reverseSupplies.base),
                },
                (summary.details ?? []).map((detail) =>
                  element('detaliu', {
                    bun: detail.code,
                    nrLivV: text(detail.totals.invoices),
                    bazaLivV: text(detail.totals.base),
                  }),
                ),
              )
            : element(
                'rezumat1',
                {
                  tip_partener: String(summary.partnerType),
                  cota: summary.rate,
                  ...totals('L', summary.supplies),
                  ...(summary.acquisitions && totals('A', summary.acquisitions)),
                  ...(summary.cashVatAcquisitions && totals('AI', summary.cashVatAcquisitions)),
                  ...(summary.reverseAcquisitions && totals('C', summary.reverseAcquisitions)),
                },
                (summary.details ?? []).map((detail) =>
                  element('detaliu', {
                    bun: detail.code,
                    nrAchizC: text(detail.totals.invoices),
                    bazaAchizC: text(detail.totals.base),
                    tvaAchizC: text(detail.totals.vat),
                  }),
                ),
              ),
      ),
      calculation.byRate.map((summary) => {
        const simplified = summary.simplified;
        return element('rezumat2', {
          cota: summary.rate,
          bazaFSLcod: text(simplified.salesWithCode.base),
          TVAFSLcod: text(simplified.salesWithCode.vat),
          bazaFSL: text(simplified.salesWithoutCode.base),
          TVAFSL: text(simplified.salesWithoutCode.vat),
          bazaFSA: text(simplified.purchases.base),
          TVAFSA: text(simplified.purchases.vat),
          bazaFSAI: text(simplified.purchasesCashVat.base),
          TVAFSAI: text(simplified.purchasesCashVat.vat),
          bazaBFAI: text(simplified.receipts.base),
          TVABFAI: text(simplified.receipts.vat),
          ...totals('L', summary.supplies, 'nrFacturiL'),
          ...totals('A', summary.acquisitions, 'nrFacturiA'),
          ...totals('AI', summary.cashVatAcquisitions, 'nrFacturiAI'),
          baza_incasari_i1: '0',
          tva_incasari_i1: '0',
          baza_incasari_i2: '0',
          tva_incasari_i2: '0',
        });
      }),
      model.series.map((series) =>
        element('serieFacturi', {
          tip: seriesCodes[series.type],
          serieI: series.series,
          nrI: series.first,
          nrF: series.last,
          ...('issuer' in series && { den: series.issuer.name, cui: series.issuer.cui }),
        }),
      ),
      model.invoices.map((invoice) =>
        element('facturi', {
          tip_factura: invoiceCodes[invoice.type],
          serie: invoice.series,
          nr: invoice.number,
          ...(invoice.type === 'selfInvoice' && selfInvoiceAmounts(invoice.amounts)),
        }),
      ),
      model.operations.map((operation) => {
        const { partner } = operation;
        const address = partner.kind === 'unregistered' ? partner.address : undefined;
        return element(
          'op1',
          {
            tip: operation.type,
            tip_partener: String(partnerType(partner)),
            cota: operation.rate,
            cuiP: partner.kind === 'registered' ? partner.cui : partner.code,
            denP: partner.name,
            taraP: address?.country,
            locP: address?.locality,
            judP: address?.county === undefined ? undefined : county(address.county),
            strP: address?.street,
            nrP: address?.number,
            blP: address?.building,
            apP: address?.apartment,
            detP: address?.details,
            tip_document: operation.document ? d394DocumentTypes[operation.document] : undefined,
            nrFact: text(operation.invoices),
            baza: text(operation.base),
            // R232.2: V and N carry no tva, nor their products a tvaPR.
            tva: operation.type === 'V' || operation.type === 'N' ? undefined : text(operation.vat),
          },
          (operation.products ?? []).map((product) =>
            element('op11', {
              nrFactPR: text(product.invoices),
              codPR: product.code,
              bazaPR: text(product.base),
              tvaPR:
                operation.type === 'V' || operation.type === 'N' ? undefined : text(product.vat),
            }),
          ),
        );
      }),
    ),
  );
}

function selfInvoiceAmounts(amounts: Partial<Record<D394Rate, D394Amount>>) {
  const value = (rate: D394Rate, part: keyof D394Amount) => text(amounts[rate]?.[part] ?? 0);
  const optional = (part: keyof D394Amount) =>
    amounts['24'] === undefined ? undefined : value('24', part);
  return {
    baza24: optional('base'),
    ...Object.fromEntries(requiredRates.map((rate) => [`baza${rate}`, value(rate, 'base')])),
    tva5: value('5', 'vat'),
    tva9: value('9', 'vat'),
    tva19: value('19', 'vat'),
    tva20: value('20', 'vat'),
    tva24: optional('vat'),
    tva21: value('21', 'vat'),
    tva11: value('11', 'vat'),
  };
}

export type D394Check = {
  code: string;
  /** error: ANAF rejects the statement (E:); warning: it is accepted with a notice (A:). */
  severity: 'error' | 'warning';
  path: string;
  message: string;
};

const isCnpOrNif = (code: string) => /^\d{13}$/.test(code) && isValidCnp(code);
const isCui = (code: string) => /^[1-9]\d{1,9}$/.test(code) && isValidCui(code);

/**
 * Fast feedback on the validator's rules for the sections written here, its messages summarized
 * in Romanian. The official validator (DUKIntegrator) remains the oracle; it also checks the CAEN
 * and country lists and the birth date within a CNP.
 */
export function checkD394(model: D394): D394Check[] {
  const checks: D394Check[] = [];
  const add = (severity: D394Check['severity'], code: string, path: string, message: string) =>
    checks.push({ code, severity, path, message });
  const error = (code: string, path: string, message: string) => add('error', code, path, message);
  const textField = (
    path: string,
    value: string | undefined,
    label: string,
    max: number,
    required = false,
  ) => {
    const trimmed = value?.trim();
    if (!trimmed) {
      if (required) error('D394_TEXT', path, `Completați ${label}.`);
    } else if (trimmed.length > max)
      error('D394_TEXT', path, `Câmpul ${label} are cel mult ${max} caractere.`);
  };
  const { period, company, representative, preparer } = model;
  const validPeriod = isPeriod(period);

  if (!validPeriod) error('D394_PERIOD', 'period', periodMessage);
  else if (!typeMonths[model.type]?.includes(period.month))
    error(
      'D394_TYPE_MONTH',
      'type',
      `Tipul de declarație ${model.type} nu corespunde lunii de raportare ${period.month}.`,
    );

  if (!isCui(company.cui))
    error(
      'D394_CUI',
      'company.cui',
      'Codul de înregistrare în scopuri de TVA nu este valid; se scrie fără prefixul RO.',
    );
  if (!/^\d{4}$/.test(company.caen))
    error('D394_CAEN', 'company.caen', 'Codul CAEN are patru cifre.');
  textField('company.name', company.name, 'denumirea', 200, true);
  textField('company.address', company.address, 'adresa domiciliului fiscal', 1000, true);
  textField('company.phone', company.phone, 'telefonul', 15, true);
  textField('company.fax', company.fax, 'faxul', 15);
  textField('company.email', company.email, 'e-mailul', 200);

  const cif = representative.cif;
  if (cif !== undefined && !(cif.length <= 10 ? isCui(cif) : isCnpOrNif(cif)))
    error(
      'D394_CUI',
      'representative.cif',
      'Codul de identificare fiscală al reprezentantului (CUI, CNP sau NIF) nu este valid.',
    );
  textField('representative.name', representative.name, 'numele reprezentantului', 200, true);
  textField('representative.role', representative.role, 'calitatea reprezentantului', 100, true);
  textField(
    'representative.address',
    representative.address,
    'adresa reprezentantului',
    1000,
    true,
  );
  textField('representative.phone', representative.phone, 'telefonul reprezentantului', 15);
  textField('representative.fax', representative.fax, 'faxul reprezentantului', 15);
  textField('representative.email', representative.email, 'e-mailul reprezentantului', 200);

  textField('preparer.name', preparer.name, 'numele celui care întocmește declarația', 75, true);
  textField('preparer.capacity', preparer.capacity, 'calitatea celui care întocmește', 75);
  if (preparer.kind === 'company') {
    if (!isCui(preparer.cui))
      error(
        'D394_CUI',
        'preparer.cui',
        'Persoana juridică care întocmește se identifică prin CUI.',
      );
    if (!preparer.capacity?.trim())
      error(
        'D394_PREPARER',
        'preparer.capacity',
        'Pentru o persoană juridică se completează calitatea celui care întocmește.',
      );
  } else {
    if (!isCnpOrNif(preparer.cnp))
      error(
        'D394_CUI',
        'preparer.cnp',
        'Persoana fizică care întocmește se identifică prin CNP sau NIF.',
      );
    textField('preparer.position', preparer.position, 'funcția celui care întocmește', 75);
    if (!preparer.capacity?.trim() && !preparer.position?.trim())
      error(
        'D394_PREPARER',
        'preparer',
        'Pentru o persoană fizică se completează calitatea sau funcția celui care întocmește.',
      );
  }
  if (model.consultationChanged && !model.consultation)
    error(
      'D394_CONSULTATION',
      'consultationChanged',
      'Schimbarea opțiunii înseamnă acordul pentru consultarea tranzacțiilor.',
    );

  const problems = inputProblems(model);
  for (const problem of problems) error(problem.code, problem.path, problem.message);

  const address = (partner: Extract<D394Partner, { kind: 'unregistered' }>, path: string) => {
    const at = `${path}.partner.address`;
    const { address } = partner;
    if (partner.code !== undefined) {
      if (address)
        error('D394_ADDRESS', at, 'Adresa se declară doar pentru partenerii fără cod fiscal.');
      return;
    }
    if (!address) {
      error(
        'D394_ADDRESS',
        at,
        `Partenerul ${partner.name}, fără cod fiscal, se declară cu adresa (cel puțin țara).`,
      );
      return;
    }
    if (!/^[A-Z]{2}$/.test(address.country))
      error('D394_ADDRESS', `${at}.country`, 'Țara se scrie prin codul ISO din două litere.');
    if (address.country === 'RO' && address.county === undefined)
      error('D394_ADDRESS', `${at}.county`, 'Pentru o adresă din România se completează județul.');
    if (address.country !== 'RO' && address.county !== undefined)
      error(
        'D394_ADDRESS',
        `${at}.county`,
        'Județul se completează doar pentru adrese din România.',
      );
    if (address.county !== undefined && !d394Counties[address.county])
      error('D394_ADDRESS', `${at}.county`, `Județul ${address.county} nu există în nomenclator.`);
    textField(`${at}.locality`, address.locality, 'localitatea', 75);
    textField(`${at}.street`, address.street, 'strada', 75);
    textField(`${at}.number`, address.number, 'numărul', 50);
    textField(`${at}.building`, address.building, 'blocul', 50);
    textField(`${at}.apartment`, address.apartment, 'apartamentul', 50);
    textField(`${at}.details`, address.details, 'detaliile adresei', 100);
  };

  const seen = new Set<string>();
  model.operations.forEach((operation, index) => {
    const path = `operations.${index}`;
    const { partner } = operation;
    textField(`${path}.partner.name`, partner.name, 'denumirea partenerului', 200, true);
    if (partner.kind === 'registered') {
      if (!isCui(partner.cui))
        error(
          'D394_PARTNER',
          `${path}.partner.cui`,
          `Codul de TVA al partenerului ${partner.name} nu este valid; se scrie fără prefixul RO.`,
        );
      // R218.4: (tip_partener, cota, tip, cuiP) is unique for registered partners.
      const key = [operation.type, operation.rate, partner.cui].join('|');
      if (seen.has(key))
        error(
          'D394_DUPLICATE',
          path,
          `Partenerul ${partner.cui} apare de mai multe ori cu operațiuni ${operation.type} la cota ${operation.rate}%.`,
        );
      seen.add(key);
    } else {
      if (partner.code !== undefined && !isCui(partner.code) && !isCnpOrNif(partner.code))
        error(
          'D394_PARTNER',
          `${path}.partner.code`,
          `Codul partenerului ${partner.name} nu este un CUI, CNP sau NIF valid.`,
        );
      // R218: (cuiP, tip, cota) is unique, so a partner's acquisitions N are one record.
      if (partner.code !== undefined) {
        const key = ['2', operation.type, operation.rate, partner.code].join('|');
        if (seen.has(key))
          error(
            'D394_DUPLICATE',
            path,
            `Partenerul ${partner.name} apare de mai multe ori cu operațiuni ${operation.type} la cota ${operation.rate}%.`,
          );
        seen.add(key);
      }
      address(partner, path);
    }
    if (
      amountError(operation.base, '') ||
      amountError(operation.vat, '') ||
      !isRate(operation.rate)
    )
      return;
    // R232.3, in the validator's integer arithmetic: |baza × cota / 100 − tva| ≤ 5.
    const difference =
      (BigInt(operation.base) * BigInt(operation.rate)) / 100n - BigInt(operation.vat);
    if (difference > 5n || difference < -5n)
      add(
        'warning',
        'D394_VAT',
        `${path}.vat`,
        `TVA (${operation.vat}) diferă cu mai mult de 5 lei de ${operation.rate}% din bază.`,
      );
  });

  model.series.forEach((series, index) => {
    const path = `series.${index}`;
    textField(`${path}.series`, series.series, 'seria', 20);
    textField(`${path}.first`, series.first, 'numărul inițial', 20, true);
    textField(`${path}.last`, series.last, 'numărul final', 20);
    if (series.type !== 'beneficiary' && series.type !== 'thirdParty') return;
    textField(`${path}.issuer.name`, series.issuer.name, 'denumirea emitentului', 100, true);
    if (!isCui(series.issuer.cui))
      error('D394_CUI', `${path}.issuer.cui`, 'Codul emitentului facturilor nu este un CUI valid.');
  });
  model.invoices.forEach((invoice, index) => {
    textField(`invoices.${index}.series`, invoice.series, 'seria facturii', 20);
    textField(`invoices.${index}.number`, invoice.number, 'numărul facturii', 20, true);
  });

  if (problems.length || !validPeriod) return checks;
  const calculation = calculateD394(model);

  if (!calculation.operationsReported && model.affiliates)
    error(
      'D394_AFFILIATES',
      'affiliates',
      'Fără operațiuni declarate nu se pot declara operațiuni cu persoane afiliate.',
    );
  // R129–R131, R112.1, R112.2.
  const issued = model.issuedInvoices;
  const declared = (type: D394InvoiceSeries['type']) =>
    model.series.some((series) => series.type === type);
  for (const [type, count, label] of [
    ['issued', issued.own, 'emise'],
    ['beneficiary', issued.byBeneficiaries, 'emise de beneficiari în numele companiei'],
    ['thirdParty', issued.byThirdParties, 'emise de terți în numele companiei'],
  ] as const)
    if (count > 0 !== declared(type))
      error(
        'D394_SERIES',
        'issuedInvoices',
        `Numărul facturilor ${label} (${count}) se completează dacă și numai dacă se declară seriile lor.`,
      );
  if (declared('issued') && !declared('allocated'))
    error(
      'D394_SERIES',
      'series',
      'Seriile facturilor emise se declară cu plaja de facturi alocată.',
    );
  if (
    model.operations.some((operation) => operation.type === 'L' || operation.type === 'V') &&
    issued.own + issued.byBeneficiaries + issued.byThirdParties === 0
  )
    error(
      'D394_SERIES',
      'issuedInvoices',
      'Pentru livrările declarate se completează numărul facturilor emise în perioadă.',
    );

  const sums = [
    ...calculation.byPartner.flatMap((summary) => [
      summary.supplies,
      summary.acquisitions,
      summary.cashVatAcquisitions,
    ]),
    ...calculation.byRate.flatMap((summary) => [
      summary.supplies,
      summary.acquisitions,
      summary.cashVatAcquisitions,
    ]),
  ].flatMap((value) => (value ? [value.invoices, value.base, value.vat] : []));
  if ([calculation.controlSum, ...sums].some((value) => value > maxAmount || value < -maxAmount))
    error('D394_TOTAL', 'operations', 'Un total al declarației depășește 15 cifre.');
  return checks;
}
