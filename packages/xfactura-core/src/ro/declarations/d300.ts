import { DomainError } from '../../errors';
import { element, serializeXml } from '../../xml/write';
import { isValidCui } from '../identifiers';

/**
 * The Romanian VAT return (D300, "decont de TVA") for reporting periods from 08/2025, after
 * ANAF's XML structure v12.0.0 (source ANAF/D300-12.0.0) and the printed form D300_A12.0.2.
 *
 * ANAF's validator (DUKIntegrator, D300Validator of 11.02.2026) accepts the namespace
 * `mfp:anaf:dgti:d300:declaratie:v12` only for periods from 01/2026 and requires `...:v11` for
 * 08/2025–12/2025. Both use the same attributes; the 2025 periods also accept the
 * transitional-rate rows (19%, 9%, 5%) that the structure dates "01.08.25 – 01.01.26" and the
 * 2026 validator rejects, and number the rows from 26 onward one higher.
 *
 * Amounts are whole lei: every row is N(15), an integer of at most 15 digits, negative for
 * regularizations. The structure states no rounding rule; amounts arrive already in lei.
 */

export type D300Section = 'output' | 'input' | 'settlement' | 'informative';
export type D300Type = 'L' | 'T' | 'S' | 'A';

export type D300Row = {
  /** The XML attribute. */
  element: string;
  /** The row as printed on the form: the 2026 form, or the 2025 form for rows that ended in
   * 2025. Absent for the informative totals the form leaves unnumbered. */
  row?: string;
  /** The row as printed on the 08–12/2025 form, where it differs. */
  row2025?: string;
  /** 1: taxable base ("Valoare"), 2: VAT ("TVA"). Absent for invoice counts. */
  column?: 1 | 2;
  section: D300Section;
  /** The VAT rate of a rate row, in percent. */
  rate?: string;
  /** Label of the printed form, which repeats the structure's; for rows that ended in 2025, the
   * structure's own text. Cross-references are left as printed. */
  label: string;
  /** The last reporting period that accepts the row. */
  until?: '2025-12';
  /** Derived by writeD300 from other rows; never an input. */
  computed: boolean;
};

const totals = [
  'R17_1',
  'R17_2',
  'R27_1',
  'R27_2',
  'R32_2',
  'R33_2',
  'R34_2',
  'R37_2',
  'R40_2',
  'R41_2',
  'R42_2',
] as const;

// Deductible reverse-charge rows repeat their collected counterparts (structure V_7–V_26; the
// validator also requires rd. 27.4/27.5 to equal rd. 12.4/12.5).
const mirrors = {
  R18_1: 'R5_1',
  R18_2: 'R5_2',
  R18_1_1: 'R5_1_1',
  R18_1_2: 'R5_1_2',
  R19_1: 'R6_1',
  R19_2: 'R6_2',
  R20_1: 'R7_1',
  R20_2: 'R7_2',
  R20_1_1: 'R7_1_1',
  R20_1_2: 'R7_1_2',
  R21_1: 'R8_1',
  R21_2: 'R8_2',
  R25_1: 'R12_1',
  R25_2: 'R12_2',
  R25_1_1: 'R12_1_1',
  R25_1_2: 'R12_1_2',
  R25_2_1: 'R12_2_1',
  R25_2_2: 'R12_2_2',
  R25_3_1: 'R12_3_1',
  R25_3_2: 'R12_3_2',
  R76_1: 'R72_1',
  R76_2: 'R72_2',
  R77_1: 'R73_1',
  R77_2: 'R73_2',
} as const;

export type D300ComputedElement = (typeof totals)[number] | keyof typeof mirrors;
const computedElements = new Set<string>([...totals, ...Object.keys(mirrors)]);

type Extra = Pick<D300Row, 'row2025' | 'rate' | 'until'>;

function single<const E extends string>(
  element: E,
  row: string | undefined,
  column: 1 | 2 | undefined,
  section: D300Section,
  label: string,
  extra: Extra = {},
) {
  return {
    element,
    ...(row === undefined ? {} : { row }),
    ...(column === undefined ? {} : { column }),
    section,
    label,
    ...extra,
    computed: computedElements.has(element),
  };
}

/** Both columns of a row: `${base}_1` is the base, `${base}_2` the VAT. */
function pair<const B extends string>(
  base: B,
  row: string,
  section: D300Section,
  label: string,
  extra: Extra = {},
) {
  return [
    single(`${base}_1`, row, 1, section, label, extra),
    single(`${base}_2`, row, 2, section, label, extra),
  ] as const;
}

const t2025 = { until: '2025-12' } as const;
const inspectionIssued =
  'Facturi emise după inspecția fiscală, conform art. 330 alin. (3) din Codul fiscal';
const inspectionReceived =
  'Facturi primite după inspecția fiscală, conform pct. 108 alin. (6) din Normele metodologice de aplicare a Titlului VII din Codul fiscal';
const reregistration =
  'Facturi emise, conform art. 11 alin. (6) și (8) din Codul fiscal, după înregistrarea în scopuri de TVA pentru operațiuni efectuate în perioada în care codul de înregistrare în scopuri de TVA a fost anulat';
const distance =
  'Valoarea totală, fără TVA, a operațiunilor prevăzute la art. 278¹ alin. (1) lit. b) din Codul fiscal, respectiv a vânzărilor intracomunitare de bunuri la distanță și a prestărilor de servicii de telecomunicaţii, de radiodifuziune şi televiziune, precum și servicii furnizate pe cale electronică, către persoane neimpozabile din alte state membre UE';

/** Every row of the return for periods from 08/2025, in the order of the printed form. */
export const d300Rows = [
  single(
    'R1_1',
    '1',
    1,
    'output',
    'Livrări intracomunitare de bunuri, scutite conform art. 294 alin.(2) lit.a) şi d) din Codul fiscal',
  ),
  single(
    'R2_1',
    '2',
    1,
    'output',
    'Regularizări livrări intracomunitare scutite conform art. 294 alin.(2) lit.a) şi d) din Codul fiscal',
  ),
  single(
    'R3_1',
    '3',
    1,
    'output',
    'Livrări de bunuri sau prestări de servicii pentru care locul livrării/locul prestării este în afara României (în UE sau în afara UE), precum şi livrări intracomunitare de bunuri, scutite conform art. 294 alin.(2) lit.b) şi c) din Codul fiscal, din care:',
  ),
  single(
    'R3_1_1',
    '3.1',
    1,
    'output',
    'Prestări de servicii intracomunitare care nu beneficiază de scutire în statul membru în care taxa este datorată',
  ),
  single(
    'R4_1',
    '4',
    1,
    'output',
    'Regularizări privind prestările de servicii intracomunitare care nu beneficiază de scutire în statul membru în care taxa este datorată',
  ),
  ...pair(
    'R5',
    '5',
    'output',
    'Achiziţii intracomunitare de bunuri pentru care cumpărătorul este obligat la plata TVA (taxare inversă), din care:',
  ),
  ...pair(
    'R5_1',
    '5.1',
    'output',
    'Achiziţii intracomunitare pentru care cumpărătorul este obligat la plata TVA (taxare inversă), iar furnizorul este înregistrat în scopuri de TVA în statul membru din care a avut loc livrarea intracomunitară',
  ),
  ...pair(
    'R6',
    '6',
    'output',
    'Regularizări privind achiziţiile intracomunitare de bunuri pentru care cumpărătorul este obligat la plata TVA (taxare inversă)',
  ),
  ...pair(
    'R7',
    '7',
    'output',
    'Achiziţii de bunuri, altele decât cele de la rd.5 şi 6, şi achiziţii de servicii pentru care beneficiarul din România este obligat la plata TVA (taxare inversă), din care:',
  ),
  ...pair(
    'R7_1',
    '7.1',
    'output',
    'Achiziţii de servicii intracomunitare pentru care beneficiarul este obligat la plata TVA (taxare inversă)',
  ),
  ...pair(
    'R8',
    '8',
    'output',
    'Regularizări privind achiziţiile de servicii intracomunitare pentru care beneficiarul este obligat la plata TVA (taxare inversă)',
  ),
  ...pair('R9', '9', 'output', 'Livrări de bunuri şi prestări de servicii taxabile cu cota 21%', {
    rate: '21',
  }),
  ...pair(
    'R69',
    '9.1',
    'output',
    'Livrări de bunuri şi prestări de servicii taxabile cu cota 19%',
    { rate: '19', ...t2025 },
  ),
  ...pair('R10', '10', 'output', 'Livrări de bunuri şi prestări de servicii taxabile cu cota 11%', {
    rate: '11',
  }),
  ...pair(
    'R70',
    '10.1',
    'output',
    'Livrări de bunuri şi prestări de servicii, taxabile cu cota 9%, cu excepția operațiunilor care se declară la rd. 11',
    { rate: '9', ...t2025 },
  ),
  ...pair(
    'R11',
    '11',
    'output',
    'Livrări de bunuri taxabile cu cota 9% conform art. III din Legea nr. 141/2025',
    { rate: '9' },
  ),
  ...pair(
    'R71',
    '11.1',
    'output',
    'Livrări de bunuri şi prestări de servicii taxabile cu cota 5%',
    { rate: '5', ...t2025 },
  ),
  ...pair(
    'R12',
    '12',
    'output',
    'Achiziţii de bunuri şi servicii supuse măsurilor de simplificare pentru care beneficiarul este obligat la plata TVA (taxare inversă), din care:',
  ),
  ...pair('R12_1', '12.1', 'output', 'Achiziţii de bunuri şi servicii, taxabile cu cota 21%', {
    rate: '21',
  }),
  ...pair('R12_2', '12.2', 'output', 'Achiziţii de bunuri, taxabile cu cota 11%', { rate: '11' }),
  ...pair('R12_3', '12.3', 'output', 'Achiziţii de bunuri şi servicii, taxabile cu cota 19%', {
    rate: '19',
    ...t2025,
  }),
  ...pair('R72', '12.4', 'output', 'Achiziţii de bunuri şi servicii, taxabile cu cota 9%', {
    rate: '9',
    ...t2025,
  }),
  ...pair('R73', '12.5', 'output', 'Achiziţii de bunuri, taxabile cu cota 5%', {
    rate: '5',
    ...t2025,
  }),
  single(
    'R13_1',
    '13',
    1,
    'output',
    'Livrări de bunuri şi prestări de servicii supuse măsurilor de simplificare (taxare inversă)',
  ),
  single(
    'R14_1',
    '14',
    1,
    'output',
    'Livrări de bunuri şi prestări de servicii scutite cu drept de deducere, altele decât cele de la rd. 1-3',
  ),
  single(
    'R15_1',
    '15',
    1,
    'output',
    'Livrări de bunuri şi prestări de servicii scutite fără drept de deducere',
  ),
  ...pair('R16', '16', 'output', 'Regularizări taxă colectată'),
  ...pair(
    'R64',
    '17',
    'output',
    'Vânzări intracomunitare de bunuri la distanță și prestări de servicii de telecomunicaţii, de radiodifuziune şi televiziune, precum și servicii furnizate pe cale electronică către persoane neimpozabile dintr-un alt stat membru, pentru care locul livrării/prestării este în România, conform art. 278¹ alin. (1) din Codul fiscal',
  ),
  ...pair(
    'R65',
    '18',
    'output',
    'Regularizări privind vânzările intracomunitare de bunuri la distanță și prestările de servicii de telecomunicaţii, de radiodifuziune şi televiziune, precum și servicii furnizate pe cale electronică către persoane neimpozabile dintr-un alt stat membru, conform art. 278¹ alin. (1) din Codul fiscal',
  ),
  ...pair(
    'R17',
    '19',
    'output',
    'TOTAL TAXĂ COLECTATĂ (sumă de la rd.1 până la rd.18, cu excepţia celor de la rd. 3.1, 5.1, 7.1, 12.1, 12.2)',
  ),
  ...pair(
    'R18',
    '20',
    'input',
    'Achiziţii intracomunitare de bunuri pentru care cumpărătorul este obligat la plata TVA (taxare inversă), din care:',
  ),
  ...pair(
    'R18_1',
    '20.1',
    'input',
    'Achiziţii intracomunitare pentru care cumpărătorul este obligat la plata TVA (taxare inversă), iar furnizorul este înregistrat în scopuri de TVA în statul membru din care a avut loc livrarea',
  ),
  ...pair(
    'R19',
    '21',
    'input',
    'Regularizări privind achiziţiile intracomunitare de bunuri pentru care cumpărătorul este obligat la plata TVA (taxare inversă)',
  ),
  ...pair(
    'R20',
    '22',
    'input',
    'Achiziţii de bunuri, altele decât cele de la rd.20 şi 21, şi achiziţii de servicii pentru care beneficiarul din România este obligat la plata TVA (taxare inversă), din care:',
  ),
  ...pair(
    'R20_1',
    '22.1',
    'input',
    'Achiziţii de servicii intracomunitare pentru care beneficiarul este obligat la plata TVA (taxare inversă)',
  ),
  ...pair(
    'R21',
    '23',
    'input',
    'Regularizări privind achiziţii de servicii intracomunitare pentru care beneficiarul din România este obligat la plata TVA (taxare inversă)',
  ),
  ...pair(
    'R22',
    '24',
    'input',
    'Achiziţii de bunuri şi servicii taxabile cu cota de 21%, altele decât cele de la rd.27',
    { rate: '21' },
  ),
  ...pair(
    'R74',
    '24.1',
    'input',
    'Achiziţii de bunuri şi servicii taxabile cu cota de 19%, altele decât cele de la rd.27',
    { rate: '19', ...t2025 },
  ),
  ...pair('R23', '25', 'input', 'Achiziţii de bunuri şi servicii taxabile cu cota de 11%', {
    rate: '11',
  }),
  ...pair('R75', '25.1', 'input', 'Achiziţii de bunuri, taxabile cu cota 9%', {
    rate: '9',
    ...t2025,
  }),
  ...pair('R24', '26', 'input', 'Achiziţii de bunuri și servicii, taxabile cu cota de 5%', {
    rate: '5',
    ...t2025,
  }),
  ...pair(
    'R25',
    '26',
    'input',
    'Achiziţii de bunuri şi servicii supuse măsurilor de simplificare pentru care beneficiarul este obligat la plata TVA (taxare inversă), din care:',
    { row2025: '27' },
  ),
  ...pair('R25_1', '26.1', 'input', 'Achiziţii de bunuri şi servicii, taxabile cu cota 21%', {
    rate: '21',
    row2025: '27.1',
  }),
  ...pair('R25_2', '26.2', 'input', 'Achiziţii de bunuri, taxabile cu cota 11%', {
    rate: '11',
    row2025: '27.2',
  }),
  ...pair('R25_3', '27.3', 'input', 'Achiziţii de bunuri, taxabile cu cota 19%', {
    rate: '19',
    ...t2025,
  }),
  ...pair('R76', '27.4', 'input', 'Achiziţii de bunuri, taxabile cu cota 9%', {
    rate: '9',
    ...t2025,
  }),
  ...pair('R77', '27.5', 'input', 'Achiziţii de bunuri, taxabile cu cota 5%', {
    rate: '5',
    ...t2025,
  }),
  single(
    'R43_2',
    '27',
    2,
    'input',
    'Compensația în cotă forfetară pentru achiziții de produse și servicii agricole de la furnizori care aplică regimul special pentru agricultori',
    { row2025: '28' },
  ),
  single('R44_2', '28', 2, 'input', 'Regularizări privind compensația în cotă forfetară', {
    row2025: '29',
  }),
  single(
    'R26_1',
    '29',
    1,
    'input',
    'Achiziţii de bunuri şi servicii scutite de taxă sau neimpozabile, din care:',
    { row2025: '30' },
  ),
  single('R26_1_1', '29.1', 1, 'input', 'Achiziţii de servicii intracomunitare scutite de taxă', {
    row2025: '30.1',
  }),
  ...pair(
    'R27',
    '30',
    'input',
    'TOTAL TAXĂ DEDUCTIBILĂ (sumă de la rd.20 până la rd.28, cu excepţia celor de la rd. 20.1, 22.1, 26.1, 26.2)',
    { row2025: '31' },
  ),
  single(
    'R28_2',
    '31',
    2,
    'input',
    'SUB-TOTAL TAXĂ DEDUSĂ CONFORM ART. 297 ŞI ART. 298 SAU ART. 300 ŞI ART. 298 DIN CODUL FISCAL ȘI COMPENSAȚIE ÎN COTĂ FORFETARĂ',
    { row2025: '32' },
  ),
  single(
    'R29_2',
    '32',
    2,
    'input',
    'TVA efectiv restituită cumpărătorilor străini, inclusiv comisionul unităţilor autorizate',
    { row2025: '33' },
  ),
  ...pair('R30', '33', 'input', 'Regularizări taxă dedusă', { row2025: '34' }),
  single('R31_2', '34', 2, 'input', 'Ajustări conform pro-rata / ajustări de taxă', {
    row2025: '35',
  }),
  single('R32_2', '35', 2, 'input', 'TOTAL TAXĂ DEDUSĂ (rd.31+rd.32+rd.33+rd.34)', {
    row2025: '36',
  }),
  single(
    'R33_2',
    '36',
    2,
    'settlement',
    'Suma negativă a TVA în perioada de raportare (rd.35-rd.19)',
    { row2025: '37' },
  ),
  single('R34_2', '37', 2, 'settlement', 'Taxa de plată în perioada de raportare (rd.19-rd.36)', {
    row2025: '38',
  }),
  single(
    'R35_2',
    '38',
    2,
    'settlement',
    'Soldul TVA de plată din decontul perioadei fiscale precedente (rd.45 din decontul perioadei fiscale precedente) neachitate până la data depunerii decontului de TVA',
    { row2025: '39' },
  ),
  single(
    'R36_2',
    '39',
    2,
    'settlement',
    'Diferenţe de TVA de plată stabilite de organele fiscale prin decizie comunicată şi neachitate până la data depunerii decontului de TVA',
    { row2025: '40' },
  ),
  single('R37_2', '40', 2, 'settlement', 'TVA de plată cumulat (rd.37+rd.38+rd.39)', {
    row2025: '41',
  }),
  single(
    'R38_2',
    '41',
    2,
    'settlement',
    'Soldul sumei negative a TVA reportate din perioada precedentă pentru care nu s-a solicitat rambursare (rd.46 din decontul perioadei fiscale precedente)',
    { row2025: '42' },
  ),
  single(
    'R39_2',
    '42',
    2,
    'settlement',
    'Diferenţe negative de TVA stabilite de organele de inspecţie fiscală prin decizie comunicată până la data depunerii decontului de TVA',
    { row2025: '43' },
  ),
  single('R40_2', '43', 2, 'settlement', 'Suma negativă a TVA cumulate (rd.36+rd.41+rd.42)', {
    row2025: '44',
  }),
  single(
    'R41_2',
    '44',
    2,
    'settlement',
    'Sold TVA de plată la sfârşitul perioadei de raportare (rd.40-rd.43)',
    { row2025: '45' },
  ),
  single(
    'R42_2',
    '45',
    2,
    'settlement',
    'Soldul sumei negative de TVA la sfârşitul perioadei de raportare (rd.43-rd.40)',
    { row2025: '46' },
  ),
  single(
    'nr_facturi',
    undefined,
    undefined,
    'informative',
    `${inspectionIssued}: număr total facturi emise`,
  ),
  single('baza', undefined, 1, 'informative', `${inspectionIssued}: total bază de impozitare`),
  single('tva', undefined, 2, 'informative', `${inspectionIssued}: total TVA aferentă`),
  single(
    'nr_facturi_primite',
    undefined,
    undefined,
    'informative',
    `${inspectionReceived}: număr total facturi primite`,
  ),
  single(
    'baza_primite',
    undefined,
    1,
    'informative',
    `${inspectionReceived}: total bază de impozitare`,
  ),
  single('tva_primite', undefined, 2, 'informative', `${inspectionReceived}: total TVA aferentă`),
  single(
    'nr_fact_emise',
    undefined,
    undefined,
    'informative',
    `${reregistration}: număr total facturi emise`,
  ),
  single('total_baza', undefined, 1, 'informative', `${reregistration}: total bază de impozitare`),
  single('total_tva', undefined, 2, 'informative', `${reregistration}: total TVA aferentă`),
  single(
    'valoare_a',
    'A',
    1,
    'informative',
    'Livrări de bunuri şi prestări de servicii realizate a căror TVA aferentă a rămas neexigibilă, existentă în sold la sfârşitul perioadei de raportare, ca urmare a aplicării sistemului TVA la încasare, din care:',
  ),
  single(
    'tva_a',
    'A',
    2,
    'informative',
    'Livrări de bunuri şi prestări de servicii realizate a căror TVA aferentă a rămas neexigibilă, existentă în sold la sfârşitul perioadei de raportare, ca urmare a aplicării sistemului TVA la încasare, din care:',
  ),
  single(
    'valoare_a1',
    'A1',
    1,
    'informative',
    'Livrări de bunuri şi prestări de servicii realizate în ultimele 6 luni/2 trimestre calendaristice',
  ),
  single(
    'tva_a1',
    'A1',
    2,
    'informative',
    'Livrări de bunuri şi prestări de servicii realizate în ultimele 6 luni/2 trimestre calendaristice',
  ),
  single(
    'valoare_b',
    'B',
    1,
    'informative',
    'Achiziţii de bunuri şi servicii realizate pentru care nu s-a exercitat dreptul de deducere a TVA aferentă, existentă în sold la sfârşitul perioadei de raportare, ca urmare a aplicării art. 297 alin. (2) şi (3) din Codul fiscal, din care:',
  ),
  single(
    'tva_b',
    'B',
    2,
    'informative',
    'Achiziţii de bunuri şi servicii realizate pentru care nu s-a exercitat dreptul de deducere a TVA aferentă, existentă în sold la sfârşitul perioadei de raportare, ca urmare a aplicării art. 297 alin. (2) şi (3) din Codul fiscal, din care:',
  ),
  single(
    'valoare_b1',
    'B1',
    1,
    'informative',
    'Achiziţii de bunuri şi servicii realizate în ultimele 6 luni/2 trimestre calendaristice',
  ),
  single(
    'tva_b1',
    'B1',
    2,
    'informative',
    'Achiziţii de bunuri şi servicii realizate în ultimele 6 luni/2 trimestre calendaristice',
  ),
  single('total_precedent', undefined, 1, 'informative', `${distance}: total an precedent`),
  single(
    'total_curent',
    undefined,
    1,
    'informative',
    `${distance}: an curent (inclusiv perioada de raportare)`,
  ),
] as const satisfies readonly D300Row[];

export type D300Element = (typeof d300Rows)[number]['element'];
export type D300InputElement = Exclude<D300Element, D300ComputedElement>;

const catalogue = new Map<string, D300Row>(d300Rows.map((row) => [row.element, row]));

// Structure fields 67–68 (rd. 19), 101–102 (rd. 30) and 110 (rd. 35); an absent row counts as 0.
// The structure's R17_2 lists R70_1 where the validator sums R70_2, the VAT of the same row.
const sums: Partial<Record<D300ComputedElement, readonly D300Element[]>> = {
  R17_1: [
    'R1_1',
    'R2_1',
    'R3_1',
    'R4_1',
    'R5_1',
    'R6_1',
    'R7_1',
    'R8_1',
    'R9_1',
    'R10_1',
    'R11_1',
    'R12_1',
    'R13_1',
    'R14_1',
    'R15_1',
    'R16_1',
    'R64_1',
    'R65_1',
    'R69_1',
    'R70_1',
    'R71_1',
  ],
  R17_2: [
    'R5_2',
    'R6_2',
    'R7_2',
    'R8_2',
    'R9_2',
    'R10_2',
    'R11_2',
    'R12_2',
    'R16_2',
    'R64_2',
    'R65_2',
    'R69_2',
    'R70_2',
    'R71_2',
  ],
  R27_1: ['R18_1', 'R19_1', 'R20_1', 'R21_1', 'R22_1', 'R23_1', 'R24_1', 'R25_1', 'R74_1', 'R75_1'],
  R27_2: [
    'R18_2',
    'R19_2',
    'R20_2',
    'R21_2',
    'R22_2',
    'R23_2',
    'R24_2',
    'R25_2',
    'R43_2',
    'R44_2',
    'R74_2',
    'R75_2',
  ],
  R32_2: ['R28_2', 'R29_2', 'R30_2', 'R31_2'],
};

export type D300 = {
  /** an, luna: the period's last month (the quarter's, semester's or year's for T, S, A). */
  period: { year: number; month: number };
  /** tip_decont: L lunar, T trimestrial, S semestrial, A anual. */
  type: D300Type;
  company: {
    /** cui: the VAT registration code, digits only, without the RO prefix. */
    cui: string;
    /** den */
    name: string;
    /** adresa: the fiscal domicile, as free text. */
    address: string;
    /** telefon */
    phone?: string;
    /** fax */
    fax?: string;
    /** mail */
    email?: string;
    /** banca */
    bank: string;
    /** cont */
    account: string;
    /** caen: a CAEN Rev. 2 or Rev. 3 class. */
    caen: string;
  };
  declarant: {
    /** nume_declar */
    lastName: string;
    /** prenume_declar */
    firstName: string;
    /** functie_declar */
    role: string;
  };
  /** cuiSuccesor: the successor's fiscal code. */
  successorCui?: string;
  /** depusReprezentant: a consolidated return of a single fiscal group's representative
   * (art. 269 alin. (9) Cod fiscal). */
  groupRepresentative: boolean;
  /** bifa_interne: the simplified method for domestic operations applies. */
  simplifiedDomestic: boolean;
  /** temei: filed after the reserve of subsequent verification was cancelled (art. 105 alin. (6)
   * lit. b) Cod procedură fiscală), written as 2; otherwise 0. */
  afterReserveCancellation: boolean;
  /** pro_rata: percent, 0–100 with at most two decimals. The structure defines no default; the
   * printed form pre-fills 100. */
  proRata: string;
  /** bifa_cereale, bifa_mob, bifa_disp, bifa_cons: reverse-charged supplies under art. 331 Cod
   * fiscal whose VAT became chargeable in the period. */
  reverseCharge: {
    cereals: boolean;
    mobilePhones: boolean;
    integratedCircuits: boolean;
    consoles: boolean;
  };
  /** solicit_ramb: refund of the negative balance (rd. 45) is requested. */
  refundRequested: boolean;
  /** Input rows in whole lei. Totals, settlement results and the deductible rows that repeat
   * collected reverse-charge rows are computed. rd. 31 (R28_2), the VAT deducted under art.
   * 297–298 or 300, is an input: the return does not determine it. */
  rows: Partial<Record<D300InputElement, number>>;
};

export type D300Calculation = {
  namespace: string;
  /** Every written row: the inputs given, the mirrors of given rows, and all totals. */
  amounts: Partial<Record<D300Element, bigint>>;
  /** nr_evid */
  paymentNumber: string;
  /** totalPlata_A */
  controlSum: bigint;
};

const maxAmount = 999_999_999_999_999n; // N(15)
const typeCodes: Record<D300Type, string> = { L: '301', T: '302', S: '303', A: '304' };
const typeMonths: Record<D300Type, readonly number[]> = {
  L: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  // Quarterly returns end a quarter or, for intra-community acquisitions, its second month.
  T: [2, 3, 5, 6, 8, 9, 11, 12],
  S: [6, 12],
  A: [12],
};
// The informative rows outside totalPlata_A: the validator and the form sum every row of the
// return and the two invoice groups after inspection, nothing else.
const outsideControlSum = new Set([
  'nr_fact_emise',
  'total_baza',
  'total_tva',
  'valoare_a',
  'tva_a',
  'valoare_a1',
  'tva_a1',
  'valoare_b',
  'tva_b',
  'valoare_b1',
  'tva_b1',
  'total_precedent',
  'total_curent',
]);

const periodIndex = (year: number, month: number) => year * 12 + month - 1;
const firstPeriod = periodIndex(2025, 8);
const firstV12Period = periodIndex(2026, 1);

function isPeriod(period: D300['period']): boolean {
  return (
    Number.isInteger(period.year) &&
    Number.isInteger(period.month) &&
    period.month >= 1 &&
    period.month <= 12 &&
    period.year <= 2100 &&
    periodIndex(period.year, period.month) >= firstPeriod
  );
}

/** The structure's namespace for a reporting period from 08/2025. */
export function d300Namespace(period: D300['period']): string {
  if (!isPeriod(period))
    throw new DomainError(
      'D300_PERIOD',
      'Decontul D300 în această structură se depune pentru perioade din august 2025 încolo.',
    );
  const version = periodIndex(period.year, period.month) >= firstV12Period ? 'v12' : 'v11';
  return `mfp:anaf:dgti:d300:declaratie:${version}`;
}

function accepts(row: D300Row, period: D300['period']): boolean {
  return !row.until || periodIndex(period.year, period.month) <= periodIndex(2025, 12);
}

/** The row number printed on the form of the period. */
export function d300RowNumber(row: D300Row, period: D300['period']): string | undefined {
  return periodIndex(period.year, period.month) < firstV12Period && row.row2025
    ? row.row2025
    : row.row;
}

const pad = (value: number) => String(value).padStart(2, '0');

/**
 * nr_evid, the payment evidence number (structure field 25): "10", the tax code 301/302/303/304
 * for L/T/S/A, "01", the period's month and year (LLAA), the payment due date (ZZLLAA), "0000",
 * and the sum of the 21 digits before it, two digits. The due date is the 25th of the month after
 * the period, as the validator and the form's own calculation require for every allowed month.
 */
export function d300PaymentNumber(period: D300['period'], type: D300Type): string {
  const [dueYear, dueMonth] =
    period.month === 12 ? [period.year + 1, 1] : [period.year, period.month + 1];
  const body = `10${typeCodes[type]}01${pad(period.month)}${pad(period.year % 100)}25${pad(dueMonth)}${pad(dueYear % 100)}0000`;
  const sum = [...body].reduce((total, digit) => total + Number(digit), 0);
  return `${body}${pad(sum % 100)}`;
}

function amountError(element: string, value: unknown): string | undefined {
  if (!catalogue.has(element)) return `Rândul ${element} nu există în decont.`;
  if (computedElements.has(element)) return `Rândul ${element} se calculează; nu se completează.`;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Math.abs(value) > 999_999_999_999_999
  )
    return `Suma de la ${element} se completează în lei, fără zecimale, cu cel mult 15 cifre.`;
  return undefined;
}

/**
 * The derived rows, nr_evid and totalPlata_A of a return. Throws when a row is not an amount the
 * return accepts for the period; checkD300 lists those without throwing.
 */
export function calculateD300(model: D300): D300Calculation {
  const namespace = d300Namespace(model.period);
  const amounts: Partial<Record<D300Element, bigint>> = {};
  for (const [name, value] of Object.entries(model.rows)) {
    if (value === undefined) continue;
    const problem = amountError(name, value);
    if (problem) throw new DomainError('D300_ROW', problem);
    if (!accepts(catalogue.get(name)!, model.period))
      throw new DomainError('D300_ROW', transitionalMessage(name));
    amounts[name as D300Element] = BigInt(value);
  }
  for (const [target, source] of Object.entries(mirrors) as [D300Element, D300Element][])
    if (amounts[source] !== undefined) amounts[target] = amounts[source];

  const get = (name: D300Element) => amounts[name] ?? 0n;
  const sum = (names: readonly D300Element[]) =>
    names.reduce((total, name) => total + get(name), 0n);
  const positive = (value: bigint) => (value > 0n ? value : 0n);
  for (const [total, parts] of Object.entries(sums) as [D300Element, D300Element[]][])
    amounts[total] = sum(parts);
  // Structure fields 111–112 and 115–120.
  amounts.R33_2 = positive(get('R32_2') - get('R17_2'));
  amounts.R34_2 = positive(get('R17_2') - get('R32_2'));
  amounts.R37_2 = sum(['R34_2', 'R35_2', 'R36_2']);
  amounts.R40_2 = sum(['R33_2', 'R38_2', 'R39_2']);
  amounts.R41_2 = positive(get('R37_2') - get('R40_2'));
  amounts.R42_2 = positive(get('R40_2') - get('R37_2'));

  const controlSum = (Object.entries(amounts) as [string, bigint][])
    .filter(([name]) => !outsideControlSum.has(name))
    .reduce((total, [, value]) => total + value, 0n);
  return {
    namespace,
    amounts,
    paymentNumber: d300PaymentNumber(model.period, model.type),
    controlSum,
  };
}

const flag = (value: boolean) => (value ? '1' : '0');
const yesNo = (value: boolean) => (value ? 'D' : 'N');

/**
 * Writes the return as the single `declaratie300` element the structure defines, attributes in
 * the structure's order, rows in the form's. Totals, the settlement rows, nr_evid and
 * totalPlata_A are computed; input rows are written when given, zero included.
 */
export function writeD300(model: D300): string {
  const calculation = calculateD300(model);
  const { company, declarant, reverseCharge } = model;
  const rows: Record<string, string> = {};
  for (const row of d300Rows) {
    const value = calculation.amounts[row.element];
    if (value !== undefined) rows[row.element] = value.toString();
  }
  return serializeXml(
    element('declaratie300', {
      xmlns: calculation.namespace,
      'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
      'xsi:schemaLocation': `${calculation.namespace} D300.xsd`,
      luna: String(model.period.month),
      an: String(model.period.year),
      depusReprezentant: flag(model.groupRepresentative),
      bifa_interne: flag(model.simplifiedDomestic),
      temei: model.afterReserveCancellation ? '2' : '0',
      cuiSuccesor: model.successorCui,
      nume_declar: declarant.lastName,
      prenume_declar: declarant.firstName,
      functie_declar: declarant.role,
      cui: company.cui,
      den: company.name,
      adresa: company.address,
      telefon: company.phone,
      fax: company.fax,
      mail: company.email,
      banca: company.bank,
      cont: company.account,
      caen: company.caen,
      tip_decont: model.type,
      pro_rata: model.proRata,
      bifa_cereale: yesNo(reverseCharge.cereals),
      bifa_mob: yesNo(reverseCharge.mobilePhones),
      bifa_disp: yesNo(reverseCharge.integratedCircuits),
      bifa_cons: yesNo(reverseCharge.consoles),
      solicit_ramb: yesNo(model.refundRequested),
      nr_evid: calculation.paymentNumber,
      totalPlata_A: calculation.controlSum.toString(),
      ...rows,
    }),
  );
}

export type D300Check = {
  code: string;
  /** error: ANAF rejects the return (ERR); warning: it is accepted with a notice (ATT). */
  severity: 'error' | 'warning';
  path: string;
  message: string;
};

function transitionalMessage(element: string): string {
  const row = catalogue.get(element)!;
  return `Rândul ${row.row} (${element}) se completează doar pentru perioade până în decembrie 2025.`;
}

const textFields = [
  ['declarant.lastName', 'numele declarantului', 75, true],
  ['declarant.firstName', 'prenumele declarantului', 75, true],
  ['declarant.role', 'funcția declarantului', 50, true],
  ['company.name', 'denumirea', 200, true],
  ['company.address', 'adresa domiciliului fiscal', 1000, true],
  ['company.phone', 'telefonul', 15, false],
  ['company.fax', 'faxul', 15, false],
  ['company.email', 'e-mailul', 200, false],
  ['company.bank', 'banca', 50, true],
  ['company.account', 'contul bancar', 50, true],
] as const;

// Rows the simplified method for domestic operations leaves empty (structure V_1): rd. 1–8 and
// 29.1 as entered, rd. 20–23 through their mirrors.
const outsideSimplified = [
  'R1_1',
  'R2_1',
  'R3_1',
  'R3_1_1',
  'R4_1',
  'R5_1',
  'R5_2',
  'R5_1_1',
  'R5_1_2',
  'R6_1',
  'R6_2',
  'R7_1',
  'R7_2',
  'R7_1_1',
  'R7_1_2',
  'R8_1',
  'R8_2',
  'R26_1_1',
] as const;

/**
 * Fast feedback on the structure's validations, mirroring ANAF's validator as summarized here.
 * The official validator (DUKIntegrator) remains the oracle; it also checks the CAEN list.
 */
export function checkD300(model: D300): D300Check[] {
  const checks: D300Check[] = [];
  const add = (severity: D300Check['severity'], code: string, path: string, message: string) =>
    checks.push({ code, severity, path, message });
  const error = (code: string, path: string, message: string) => add('error', code, path, message);
  const { period } = model;
  const validPeriod = isPeriod(period);

  if (!validPeriod)
    error(
      'D300_PERIOD',
      'period',
      'Decontul D300 în această structură se depune pentru perioade din august 2025 încolo.',
    );
  else if (!typeMonths[model.type]?.includes(period.month))
    error(
      'D300_TYPE_MONTH',
      'type',
      `Tipul de decont ${model.type} nu corespunde lunii de raportare ${period.month}.`,
    );

  if (!/^\d{2,10}$/.test(model.company.cui) || !isValidCui(model.company.cui))
    error(
      'D300_CUI',
      'company.cui',
      'Codul de înregistrare în scopuri de TVA nu este valid; se scrie fără prefixul RO.',
    );
  if (
    model.successorCui !== undefined &&
    (!/^\d{2,10}$/.test(model.successorCui) || !isValidCui(model.successorCui))
  )
    error(
      'D300_CUI',
      'successorCui',
      'Codul de identificare fiscală al succesorului nu este valid.',
    );

  for (const [path, label, max, required] of textFields) {
    const [group, key] = path.split('.') as ['declarant' | 'company', string];
    const value = (model[group] as Record<string, string | undefined>)[key]?.trim();
    if (!value) {
      if (required) error('D300_TEXT', path, `Completați ${label}.`);
      continue;
    }
    if (value.length > max)
      error('D300_TEXT', path, `Câmpul ${label} are cel mult ${max} caractere.`);
  }
  for (const [path, value, label] of [
    ['company.bank', model.company.bank, 'Banca'],
    ['company.account', model.company.account, 'Contul bancar'],
  ] as const)
    if (/[,#]/.test(value))
      error('D300_TEXT', path, `${label} nu poate conține caracterele „,” și „#”.`);
  if (model.company.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(model.company.email.trim()))
    error('D300_TEXT', 'company.email', 'Adresa de e-mail nu este validă.');
  if (!/^\d{4}$/.test(model.company.caen))
    error('D300_CAEN', 'company.caen', 'Codul CAEN are patru cifre.');
  if (!/^(0|[1-9]\d{0,2})(\.\d{1,2})?$/.test(model.proRata) || Number(model.proRata) > 100)
    error(
      'D300_PRO_RATA',
      'proRata',
      'Pro-rata este un procent între 0 și 100, cu cel mult două zecimale.',
    );

  let amountsValid = true;
  for (const [name, value] of Object.entries(model.rows)) {
    if (value === undefined) continue;
    const problem = amountError(name, value);
    if (problem) {
      amountsValid = false;
      error('D300_ROW', `rows.${name}`, problem);
    } else if (validPeriod && !accepts(catalogue.get(name)!, period)) {
      amountsValid = false;
      error('D300_ROW', `rows.${name}`, transitionalMessage(name));
    }
  }
  if (!validPeriod || !amountsValid) return checks;

  const { amounts } = calculateD300(model);
  const get = (name: D300Element) => amounts[name] ?? 0n;
  const label = (name: D300Element) => `rd. ${d300RowNumber(catalogue.get(name)!, period)}`;

  for (const name of totals)
    if (get(name) > maxAmount || get(name) < -maxAmount)
      error('D300_TOTAL', `rows.${name}`, `Totalul de la ${label(name)} depășește 15 cifre.`);

  if (model.simplifiedDomestic) {
    const filled = outsideSimplified.filter((name) => get(name) !== 0n);
    if (filled.length)
      error(
        'D300_SIMPLIFIED',
        'simplifiedDomestic',
        `Cu metoda simplificată pentru operațiuni interne nu se completează: ${filled.map(label).join(', ')}.`,
      );
  }

  for (const [total, parts, column] of [
    ['R12_1', ['R12_1_1', 'R12_2_1', 'R12_3_1', 'R72_1', 'R73_1'], 'Baza'],
    ['R12_2', ['R12_1_2', 'R12_2_2', 'R12_3_2', 'R72_2', 'R73_2'], 'TVA'],
  ] as const) {
    const sum = parts.reduce((value, name) => value + get(name), 0n);
    if (get(total) < sum)
      error(
        'D300_R12',
        `rows.${total}`,
        `${column} de la rd. 12 trebuie să fie cel puțin suma rândurilor 12.1–12.5 (${sum}).`,
      );
  }

  // Structure V_6.
  if (get('R28_2') > get('R27_2'))
    error(
      'D300_DEDUCTED',
      'rows.R28_2',
      `TVA dedusă de la ${label('R28_2')} nu poate depăși totalul deductibil de la ${label('R27_2')}.`,
    );
  if (get('R35_2') !== 0n && get('R38_2') !== 0n)
    error(
      'D300_BALANCES',
      'rows.R38_2',
      `Soldul de plată (${label('R35_2')}) și soldul negativ reportat (${label('R38_2')}) din perioada precedentă nu pot fi completate amândouă.`,
    );
  if (model.refundRequested && get('R42_2') < 5000n)
    error(
      'D300_REFUND',
      'refundRequested',
      `Rambursarea se poate solicita doar pentru un sold negativ (${label('R42_2')}) de cel puțin 5.000 lei.`,
    );
  for (const [whole, part] of [
    ['valoare_a', 'valoare_a1'],
    ['tva_a', 'tva_a1'],
    ['valoare_b', 'valoare_b1'],
    ['tva_b', 'tva_b1'],
  ] as const)
    if (get(whole) < get(part))
      error(
        'D300_INFORMATIVE',
        `rows.${part}`,
        `Valoarea de la rândul ${catalogue.get(part)!.row} nu poate depăși pe cea de la rândul ${catalogue.get(whole)!.row}.`,
      );

  // Rate rows: round((rate − 1)% × |base|) ≤ |VAT| ≤ round((rate + 1)% × |base|), as ATT.
  for (const row of d300Rows) {
    if (!row.rate || row.column !== 2 || row.computed || !accepts(row, period)) continue;
    const vat = amounts[row.element];
    const baseName = `${row.element.slice(0, -2)}_1` as D300Element;
    const base = amounts[baseName];
    if (vat === undefined && base === undefined) continue;
    const absolute = (value: bigint) => (value < 0n ? -value : value);
    const rate = BigInt(row.rate);
    const bound = (percent: bigint) => (percent * absolute(base ?? 0n) + 50n) / 100n;
    const tax = absolute(vat ?? 0n);
    if (tax < bound(rate - 1n) || tax > bound(rate + 1n))
      add(
        'warning',
        'D300_RATE',
        `rows.${row.element}`,
        `TVA de la ${label(row.element as D300Element)} nu se încadrează în cota de ${row.rate}% ± 1% din bază.`,
      );
  }
  return checks;
}
