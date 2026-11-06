import { vatTaxCodes } from './data/tax';

/**
 * How the engine's VAT codes (the `code` of its tax entries) are reported as SAF-T TaxCodes of
 * TaxType 300 (data/tax `vatTaxCodes`, from RO_SAFT_SchemaDefCod_05.02.2026.xlsx): supplies from
 * sheet Livrari (31xxxx), acquisitions with the VAT deducted in full from Achizitii ded 100%
 * (30xxxx), with half of it deducted (vehicles, Codul fiscal art. 298) from Achizitii ded 50%
 * (34xxxx) and without deduction from Achizitii neded (35xxxx). Each row quotes the code's
 * description and, as ANAF's sheets give it, its row of the D300 from 01.08.2025.
 *
 * A reverse charge (RC-*) is one operation: the code ANAF lists for it corresponds to both the
 * collected VAT (D300 rd. 7) and its deduction (rd. 22), so it is reported once, with the
 * acquisition, and the collected side has no code of its own. The engine's codes without a row
 * here (O, S-9, S-5, partial deductions) have no certain TaxCode: the caller reports them as
 * problems for the expert, never as a guess.
 *
 * VAT on collection (`cashVat`): the invoices of a supplier applying it have codes of their own,
 * its sales (Livrari 3103xx, "furnizorii care aplică TVA la încasare", no D300 row: the VAT is
 * declared when collected) and its customers' acquisitions ("Achizitii pentru care se aplica TVA
 * la incasare", 3013xx, 3413xx, 3513xx). The release a collection or payment books (4428 to 4427
 * or 4426) is a general-ledger entry without a source document: sheet TVA_NoteContabile, "TVA
 * neexigibilă" 3801xx (d406CashVatReleaseCode).
 *
 * A purchase whose VAT is deducted under a pro-rata (art. 300 alin. (5), `prorata` on its tax
 * entry) takes its code from sheet Achizitii baserate (36xxxx), the TaxTable giving the pro-rata
 * as the code's BaseRate (ANAF's guide, section 2.5; answers v1.2, MF.TT.11: 90% is 0,9000).
 */
export type D406VatCodeRow = {
  direction: 'output' | 'input';
  /** The engine's code: S-<rate>, RC-EU-SERV, RC-NONEU-SERV, EXP-EU-SERV, EXP-NONEU-SERV,
   * TI-A-<rate>, TI-L, the exempt codes, O. */
  code: string;
  /** The VAT rate, for the reverse charges taxed at the standard rate of their tax point. */
  rate?: string;
  /** For acquisitions: the VAT deducted in full, by half, not at all, or under a pro-rata (art.
   * 300 alin. (5): the provisional pro-rata, which the TaxTable gives as the code's BaseRate). */
  deduction?: 'full' | 'half' | 'none' | 'prorata';
  /** The supplier applies VAT on collection. */
  cashVat?: true;
  /** A distance sale or TBE service to a consumer in another Member State with its place in
   * Romania (art. 278^1 alin. (1); the tax entry's `distance: origin`). */
  distance?: true;
  /** VAT a company outside VAT owes through the special return (D301; `regime: special`). */
  special?: true;
  /** The SAF-T TaxCode. */
  taxCode: string;
  /** Its description in ANAF's nomenclature, as vatTaxCodes has it. */
  description: string;
  /** Its D300 rows from 01.08.2025, as ANAF's sheet gives them. */
  d300: string;
};

export const d406VatCodes: readonly D406VatCodeRow[] = [
  {
    direction: 'output',
    code: 'S-21',
    taxCode: '310344',
    description: 'Livrări de bunuri şi prestări de servicii taxabile cu cota 21%',
    d300: '9',
  },
  {
    direction: 'output',
    code: 'S-19',
    taxCode: '310309',
    description: 'Livrări de bunuri şi prestări de servicii taxabile cu cota 19%',
    d300: '9.1',
  },
  {
    direction: 'output',
    code: 'S-11',
    taxCode: '310351',
    description: 'Livrări de bunuri şi prestări de servicii taxabile cu cota 11%',
    d300: '10',
  },
  {
    direction: 'output',
    code: 'EXP-EU-SERV',
    taxCode: '310307',
    description:
      'Prestări de servicii intracomunitare care nu beneficiază de scutire in statul membru in care taxa este datorată (servicii cf reg B2B)',
    d300: '3/3.1',
  },
  {
    direction: 'output',
    code: 'EXP-NONEU-SERV',
    taxCode: '310305',
    description: 'Prestare de servicii pentru care locul prestarii este in afara UE',
    d300: '3',
  },
  {
    direction: 'input',
    code: 'S-21',
    deduction: 'full',
    taxCode: '301104',
    description:
      'Achiziţii de bunuri şi servicii taxabile cu cota de 21%, altele decât importurile si cele supuse masurilor de simplificare',
    d300: '24',
  },
  {
    direction: 'input',
    code: 'S-19',
    deduction: 'full',
    taxCode: '301101',
    description:
      'Achiziţii de bunuri şi servicii taxabile cu cota de 19%, altele decât importurile si cele supuse masurilor de simplificare',
    d300: '24.1',
  },
  {
    direction: 'input',
    code: 'S-11',
    deduction: 'full',
    taxCode: '301105',
    description:
      'Achiziţii de bunuri şi servicii taxabile cu cota de 11% altele decât importurile si cele supuse masurilor de simplificare',
    d300: '25',
  },
  {
    direction: 'input',
    code: 'RC-EU-SERV',
    rate: '21',
    deduction: 'full',
    taxCode: '300704',
    description: 'Achiziţii de servicii intracomunitare (AIC de servicii cf reg B2B) 21%',
    d300: '7/7.1/22/22.1',
  },
  {
    direction: 'input',
    code: 'RC-EU-SERV',
    rate: '19',
    deduction: 'full',
    taxCode: '300701',
    description: 'Achiziţii de servicii intracomunitare (AIC de servicii cf reg B2B) 19%',
    d300: '7/7.1/22/22.1',
  },
  {
    direction: 'input',
    code: 'RC-NONEU-SERV',
    rate: '21',
    deduction: 'full',
    taxCode: '300504',
    description:
      'Achizitii de bunuri (altele decat AIC de bunuri si importuri cu masuri de simplificare ) si achizitii de servicii (altele decat AIC de servicii cf reg B2B), pentru care care beneficiarul din Romania este obligat la plata TVA 21%',
    d300: '7/22',
  },
  {
    direction: 'input',
    code: 'RC-NONEU-SERV',
    rate: '19',
    deduction: 'full',
    taxCode: '300501',
    description:
      'Achizitii de bunuri (altele decat AIC de bunuri si importuri cu masuri de simplificare ) si achizitii de servicii (altele decat AIC de servicii cf reg B2B), pentru care care beneficiarul din Romania este obligat la plata TVA 19%',
    d300: '7/22',
  },
  {
    direction: 'input',
    code: 'S-21',
    deduction: 'half',
    taxCode: '341104',
    description:
      'Achiziţii de bunuri şi servicii taxabile cu cota de 21%, altele decât importurile si cele supuse masurilor de simplificare',
    d300: '24',
  },
  {
    direction: 'input',
    code: 'S-19',
    deduction: 'half',
    taxCode: '341101',
    description:
      'Achiziţii de bunuri şi servicii taxabile cu cota de 19%, altele decât importurile si cele supuse masurilor de simplificare',
    d300: '24.1',
  },
  {
    direction: 'input',
    code: 'S-11',
    deduction: 'half',
    taxCode: '341105',
    description:
      'Achiziţii de bunuri şi servicii taxabile cu cota de 11% altele decât importurile si cele supuse masurilor de simplificare',
    d300: '25',
  },
  {
    direction: 'input',
    code: 'S-21',
    deduction: 'none',
    taxCode: '351104',
    description:
      'Achiziţii de bunuri şi servicii taxabile cu cota de 21%, altele decât importurile si cele supuse masurilor de simplificare',
    d300: '24',
  },
  {
    direction: 'input',
    code: 'S-19',
    deduction: 'none',
    taxCode: '351101',
    description:
      'Achiziţii de bunuri şi servicii taxabile cu cota de 19%, altele decât importurile si cele supuse masurilor de simplificare',
    d300: '24.1',
  },
  {
    direction: 'input',
    code: 'S-11',
    deduction: 'none',
    taxCode: '351105',
    description:
      'Achiziţii de bunuri şi servicii taxabile cu cota de 11% altele decât importurile si cele supuse masurilor de simplificare',
    d300: '25',
  },
  {
    direction: 'input',
    code: 'RC-EU-SERV',
    rate: '21',
    deduction: 'none',
    taxCode: '350704',
    description: 'Achiziţii de servicii intracomunitare (AIC de servicii cf reg B2B) 21%',
    d300: '7/7.1/22/22.1',
  },
  {
    direction: 'input',
    code: 'RC-EU-SERV',
    rate: '19',
    deduction: 'none',
    taxCode: '350701',
    description: 'Achiziţii de servicii intracomunitare (AIC de servicii cf reg B2B) 19%',
    d300: '7/7.1/22/22.1',
  },
  {
    direction: 'input',
    code: 'RC-NONEU-SERV',
    rate: '21',
    deduction: 'none',
    taxCode: '350504',
    description:
      'Achizitii de bunuri (altele decat AIC de bunuri si importuri cu masuri de simplificare ) si achizitii de servicii (altele decat AIC de servicii cf reg B2B), pentru care care beneficiarul din Romania este obligat la plata TVA 21%',
    d300: '7/22',
  },
  {
    direction: 'input',
    code: 'RC-NONEU-SERV',
    rate: '19',
    deduction: 'none',
    taxCode: '350501',
    description:
      'Achizitii de bunuri (altele decat AIC de bunuri si importuri cu masuri de simplificare ) si achizitii de servicii (altele decat AIC de servicii cf reg B2B), pentru care care beneficiarul din Romania este obligat la plata TVA 19%',
    d300: '7/22',
  },
  {
    direction: 'output',
    code: 'S-21',
    cashVat: true,
    taxCode: '310350',
    description: 'Livrări/ prestări de către furnizorii care aplică TVA la încasare 21%',
    d300: '',
  },
  {
    direction: 'output',
    code: 'S-19',
    cashVat: true,
    taxCode: '310335',
    description: 'Livrări/ prestări de către furnizorii care aplică TVA la încasare 19%',
    d300: '',
  },
  {
    direction: 'output',
    code: 'S-11',
    cashVat: true,
    taxCode: '310354',
    description: 'Livrări/ prestări de către furnizorii care aplică TVA la încasare 11%',
    d300: '',
  },
  ...(
    [
      ['S-21', 'full', '301305'],
      ['S-19', 'full', '301301'],
      ['S-11', 'full', '301306'],
      ['S-21', 'half', '341306'],
      ['S-19', 'half', '341301'],
      ['S-21', 'none', '351305'],
      ['S-19', 'none', '351301'],
      ['S-11', 'none', '351306'],
    ] as const
  ).map(([code, deduction, taxCode]): D406VatCodeRow => ({
    direction: 'input',
    code,
    deduction,
    cashVat: true,
    taxCode,
    description: `Achizitii pentru care se aplica TVA la incasare ${code.slice(2)}%`,
    d300: '',
  })),
  // Achizitii baserate: a purchase for operations with and without the right of deduction.
  {
    direction: 'input',
    code: 'S-21',
    deduction: 'prorata',
    taxCode: '361104',
    description:
      'Achiziţii de bunuri şi servicii taxabile cu cota de 21%, altele decât importurile si cele supuse masurilor de simplificare',
    d300: '24',
  },
  {
    direction: 'input',
    code: 'S-19',
    deduction: 'prorata',
    taxCode: '361101',
    description:
      'Achiziţii de bunuri şi servicii taxabile cu cota de 19%, altele decât importurile si cele supuse masurilor de simplificare',
    d300: '24.1',
  },
  {
    direction: 'input',
    code: 'S-11',
    deduction: 'prorata',
    taxCode: '361105',
    description:
      'Achiziţii de bunuri şi servicii taxabile cu cota de 11% altele decât importurile si cele supuse masurilor de simplificare',
    d300: '25',
  },
  ...(
    [
      ['S-21', '361305'],
      ['S-19', '361301'],
      ['S-11', '361306'],
    ] as const
  ).map(([code, taxCode]): D406VatCodeRow => ({
    direction: 'input',
    code,
    deduction: 'prorata',
    cashVat: true,
    taxCode,
    description: `Achizitii pentru care se aplica TVA la incasare ${code.slice(2)}%`,
    d300: '',
  })),
];

/**
 * The domestic reverse charge (art. 331, src/ro/receipts/reverse-charge.ts), from the sheets'
 * "supuse măsurilor de simplificare" rows: a supply (TI-L) is Livrari 310312, without VAT (D300 rd.
 * 13); an acquisition (TI-A-<rate>) is one operation, its collected VAT (rd. 12) and its deduction
 * (rd. 27 in ANAF's sheets) reported once, with the acquisition, by its deduction: Achizitii ded
 * 100% 3009xx, Achizitii neded 3509xx; the collected side has no code of its own.
 */
export const d406DomesticReverseChargeCodes: readonly D406VatCodeRow[] = [
  {
    direction: 'output',
    code: 'TI-L',
    taxCode: '310312',
    description:
      'Livrari de bunuri si prestari de servicii supuse masurilor de simplificare (taxare inversa)',
    d300: '13',
  },
  ...(
    [
      ['21', '300906', '350906', '12.1/27.1'],
      ['11', '300907', '350907', '12.2/27.2'],
      ['19', '300901', '350901', '12.3/27.3'],
      ['9', '300902', '350902', '12.4/27.4'],
      ['5', '300903', '350903', '12.5/27.5'],
    ] as const
  ).flatMap(([rate, full, none, d300]): D406VatCodeRow[] =>
    (
      [
        ['full', full],
        ['none', none],
      ] as const
    ).map(([deduction, taxCode]) => ({
      direction: 'input',
      code: `TI-A-${rate}`,
      deduction,
      taxCode,
      description: `Achiziţii de bunuri şi servicii supuse măsurilor de simplificare taxabile cu cota de ${rate}${['21', '11'].includes(rate) && deduction === 'full' ? '' : ' '}%`,
      d300,
    })),
  ),
];

/**
 * Exempt operations and the adjustments of deductible VAT (V2, src/ro/exempt): an exempt
 * purchase (EX-IN, D300 rd. 29) on the deductible sheet, its VAT being nil, and a purchase outside
 * the scope of VAT (category O: a supplier not registered for VAT, D300 rd. 29's "neimpozabilă sau
 * supusă unui regim special de taxă", OPANAF nr. 174/2026) on the same row; the adjustments of
 * rd. 34 by the rate of the VAT they adjust (`rate` attribute): the pro-rata's "Ajustări conform
 * pro-rata", the capital goods' and the stock's "Ajustări de taxă".
 */
export const d406ExemptCodes: readonly D406VatCodeRow[] = [
  {
    direction: 'output',
    code: 'EX-292',
    taxCode: '310326',
    description: 'Livrări de bunuri și prestări de servicii scutite fără drept de deducere',
    d300: '15',
  },
  {
    direction: 'output',
    code: 'EX-294',
    taxCode: '310314',
    description:
      'Livrari de bunuri si /sau prestari de servicii scutite cu drept de deducere, altele decat Exporturile si operatiunile prevazute la art 294 alin (5) din Codul Fiscal',
    d300: '14',
  },
  {
    direction: 'output',
    code: 'EX-EXPORT',
    taxCode: '310313',
    description:
      'Livrari de bunuri scutite cu drept de deducere cf Art. 294 alin (1) lit a) si b) din Codul Fiscal (Exporturi)',
    d300: '14',
  },
  {
    direction: 'output',
    code: 'EX-IC',
    taxCode: '310301',
    description: 'Livrări intracomunitare de bunuri, scutite',
    d300: '1',
  },
  {
    direction: 'input',
    code: 'EX-IN',
    deduction: 'full',
    taxCode: '308302',
    description:
      'Achiziţii de bunuri şi servicii scutite de taxă sau neimpozabile altele decat AIC servicii scutite de taxa',
    d300: '29',
  },
  {
    direction: 'input',
    code: 'O',
    deduction: 'full',
    taxCode: '308302',
    description:
      'Achiziţii de bunuri şi servicii scutite de taxă sau neimpozabile altele decat AIC servicii scutite de taxa',
    d300: '29',
  },
  ...(
    [
      ['ADJ-300', '21', '307327', 'Ajustări conform pro-rata'],
      ['ADJ-300', '11', '307328', 'Ajustări conform pro-rata'],
      ['ADJ-300', '19', '307311', 'Ajustări conform pro-rata'],
      ['ADJ-305', '21', '307329', 'Ajustări de taxă'],
      ['ADJ-305', '11', '307330', 'Ajustări de taxă'],
      ['ADJ-305', '19', '307321', 'Ajustări de taxă'],
      ['ADJ-304', '21', '307329', 'Ajustări de taxă'],
      ['ADJ-304', '11', '307330', 'Ajustări de taxă'],
      ['ADJ-304', '19', '307321', 'Ajustări de taxă'],
    ] as const
  ).map(([code, rate, taxCode, description]): D406VatCodeRow => ({
    direction: 'input',
    code,
    rate,
    deduction: 'full',
    taxCode,
    description,
    d300: '34',
  })),
];

/**
 * The agricultural flat rate (V4, src/ro/schemes/agriculture.ts): the compensation a buyer pays a
 * farmer under art. 315^1 (FR-315, D300 rd. 27), on ANAF's rows "Achiziții de produse și servicii
 * agricole de la furnizori care aplică regimul special pentru agricultori" at 8%: Achizitii ded
 * 100% 308301 when deducted, Achizitii neded 358301 when not. The margin schemes' codes (MS-311-*,
 * MS-312-*) have no row in ANAF's sheets: they are not reported (the caller's problem).
 */
export const d406FlatRateCodes: readonly D406VatCodeRow[] = [
  {
    direction: 'input',
    code: 'FR-315',
    deduction: 'full',
    taxCode: '308301',
    description:
      'Achiziții de produse și servicii agricole de la furnizori care aplică regimul special pentru agricultori',
    d300: '27',
  },
  {
    direction: 'input',
    code: 'FR-315',
    deduction: 'none',
    taxCode: '358301',
    description:
      'Achiziții de produse și servicii agricole de la furnizori care aplică regimul special pentru agricultori',
    d300: '27',
  },
];

/**
 * A change of VAT regime (V1, src/ro/treatments/vat-registration.ts): the late registration's
 * regularization (REG-310, art. 310 alin. (6^2)–(6^3); D300 rd. 16 and 33), at the standard rate
 * of its range, which its tax entry records: the VAT collected on the supplies made since the
 * threshold, Livrari "Regularizări taxă colectată" (3103xx, the words of D300 rd. 16), and the VAT
 * deductible on the purchases of the range, Achizitii ded 100% "Regularizări taxă dedusă"
 * (3091xx). ANAF's sheet maps these rows to other row numbers of the return; the reading by their
 * words is the expert's to confirm (`ro.vat.late_registration`).
 */
export const d406RegimeCodes: readonly D406VatCodeRow[] = [
  ...(
    [
      ['21', '310345', '309106'],
      ['11', '310352', '309107'],
      ['19', '310317', '309101'],
    ] as const
  ).flatMap(([rate, collected, deducted]): D406VatCodeRow[] => [
    {
      direction: 'output',
      code: 'REG-310',
      rate,
      taxCode: collected,
      description: vatTaxCodes[collected]!.description,
      d300: '16',
    },
    {
      direction: 'input',
      code: 'REG-310',
      rate,
      deduction: 'full',
      taxCode: deducted,
      description: vatTaxCodes[deducted]!.description,
      d300: '33',
    },
  ]),
];

/**
 * A company outside VAT (art. 310, V1: the header's regime 100020, "Persoană impozabilă ce aplică
 * regimul special de scutire pentru întreprinderile mici"). ANAF's sheets have no row of the
 * special scheme, and the VAT information is required on every line (GL.33, S.I.49):
 * - its sales, invoiced without VAT (category O), exempt by the special scheme and without the
 *   right of deduction: Livrari 310326 "Livrări de bunuri și prestări de servicii scutite fără
 *   drept de deducere" (`d406NonPayerSaleCode`), the expert's to confirm against 310324
 *   ("Operatiuni care nu intra in sfera de aplicare a TVA"), which art. 268 and 310 contradict;
 * - its purchases with VAT, which it cannot deduct: the 3511xx rows (`S-<rate>`, `none`);
 * - the services it buys from abroad, whose VAT it owes through D301 (art. 307 alin. (2), art.
 *   324) and never deducts (`regime: special` on the tax entry): Achizitii neded 3563xx, "pentru
 *   care beneficiarul este obligat la plata TVA cf. art. 307 alin. (2)", with the column D301
 *   (sections 4 and 4.1): 356319/356320/356306 from the Union, 356317/356318/356304 from outside
 *   it. ANAF's answers (v1.2, 5) give 306306 for an art. 317 code holder: the same row with the
 *   deduction a non-payer does not have.
 */
export const d406NonPayerSaleCode = '310326';
export const d406SpecialCodes: readonly D406VatCodeRow[] = (
  [
    ['RC-EU-SERV', '21', '356319'],
    ['RC-EU-SERV', '11', '356320'],
    ['RC-EU-SERV', '19', '356306'],
    ['RC-NONEU-SERV', '21', '356317'],
    ['RC-NONEU-SERV', '11', '356318'],
    ['RC-NONEU-SERV', '19', '356304'],
  ] as const
).map(([code, rate, taxCode]) => ({
  direction: 'input',
  code,
  rate,
  deduction: 'none',
  special: true,
  taxCode,
  description: vatTaxCodes[taxCode]!.description,
  d300: '',
}));

/** Adjustments reported at the rate of the VAT they adjust, which their tax entry records. */
export const d406RatedAdjustments = ['ADJ-300', 'ADJ-304', 'ADJ-305', 'REG-310'];

/** The engine's codes whose collected side is reported with the acquisition. */
export const d406ReverseCharges = ['RC-EU-SERV', 'RC-NONEU-SERV'];
/** Whether a tax entry's collected side is reported with its acquisition: the reverse charges
 * across the border and the domestic one's acquisitions. */
export const d406CollectedWithAcquisition = (code: string) =>
  d406ReverseCharges.includes(code) || /^(TI-A|AIC|IMP-DEF)-\d+$/.test(code);

/** Whether a TaxCode is of sheet Achizitii baserate: the TaxTable gives it the pro-rata. */
export const d406BaseRateCode = (taxCode: string) => vatTaxCodes[taxCode]?.kind === 'baserate';

/**
 * The codes whose rate is the Member State's where the supplies take place, not one of the
 * nomenclature's: Livrari 310340, "Livrări de bunuri expediate/ transportate din RO sau servicii
 * prestate din RO" (Supplies from Member State of identification), its D398 column 1 and its
 * rate column "În funcție de Cota TVA din statul membru în care sa fac livrările"
 * (RO_SAFT_SchemaDefCod_16.02.2026.xlsx). Each line gives the state's rate (TaxPercentage) and
 * the state; the TaxTable lists a TaxCodeDetails per state and rate used.
 */
export const d406MemberStateRateCodes: readonly string[] = ['310340'];

/**
 * Sales to consumers in other Member States (core ro/oss) with the place in Romania below the
 * threshold of art. 278^1, from ANAF's sheet Livrari, by rate (D300 rd. 17). Those declared in
 * the Union scheme (EXP-OSS) are reported as `ro.d406.oss` reads ANAF's texts
 * (d406UnionSchemeTax), never by this table.
 */
export const d406DistanceCodes: readonly D406VatCodeRow[] = (
  [
    ['S-21', '310346'],
    ['S-11', '310356'],
    ['S-19', '310320'],
    ['S-9', '310343'],
    ['S-5', '310328'],
  ] as const
).map(([code, taxCode]): D406VatCodeRow => ({
  direction: 'output',
  code,
  distance: true,
  taxCode,
  description: vatTaxCodes[taxCode]!.description,
  d300: '17',
}));

/** How D406 reports a sale declared in the Union scheme (`ro.d406.oss`, saft/parameters.ts). */
export type D406UnionSchemeReading = {
  /** 310340, at the consumer state's rate, or 310325, at its 0%. */
  code: '310340' | '310325';
  /** The TaxTable's Country of a 310340 entry: the consumer state, or RO (MF.TT.12's default). */
  country: 'consumer' | 'RO';
};

/** A Member State's ISO 3166-1 code from its VAT prefix (EL is Greece's prefix, GR its code). */
const isoOf = (state: string) => (state === 'EL' ? 'GR' : state);

/**
 * The TaxInformation of a sale declared in the Union scheme (EXP-OSS, its tax entry's consumer
 * state and rate) as `ro.d406.oss` reads ANAF's texts:
 * - 310340 (Livrari: "Livrări de bunuri expediate/ transportate din RO sau servicii prestate din
 *   RO", D398 column 1, its rate "În funcție de Cota TVA din statul membru în care sa fac
 *   livrările") at the consumer state's rate, with its VAT; the TaxTable lists a TaxCodeDetails
 *   per state and rate, the state or RO as its Country;
 * - or 310325 ("Livrari de bunuri/ prestari de servicii care nu sunt raportabile in decontul de
 *   TVA din Romania si care se raporteaza in decontul de TVA din alte tari", ANAF's answers v1.2,
 *   Răspuns 6, for distance sales declared in Bulgaria and Hungary) at its 0%, without the VAT
 *   owed abroad (`vat` false: TaxAmount 0).
 */
export function d406UnionSchemeTax(
  reading: D406UnionSchemeReading,
  sale: { state: string; rate: string },
): { taxCode: string; percentage?: string; country?: string; vat: boolean } {
  if (reading.code === '310325') return { taxCode: '310325', vat: false };
  return {
    taxCode: '310340',
    percentage: sale.rate,
    country: reading.country === 'RO' ? 'RO' : isoOf(sale.state),
    vat: true,
  };
}

/**
 * Goods across the border (G3, src/ro/trade), from ANAF's sheets Achizitii ded 100% and Achizitii
 * neded: an intra-community acquisition of goods from a supplier registered in the Member State
 * of dispatch (AIC-<rate>, D300 5/5.1/20/20.1; 3002xx, 3502xx) and an import whose VAT is
 * subject to the simplification measures (IMP-DEF-<rate>, art. 326 alin. (4)–(5), D300 7/22;
 * 3006xx, 3506xx) are each one operation, reported once with the acquisition by its deduction;
 * an import whose VAT was paid at customs (IMP-<rate>, D300 24/25; 3012xx, 3512xx) is an
 * acquisition. Supplies keep V2's codes (EX-IC 310301, EX-EXPORT 310313).
 */
export const d406TradeCodes: readonly D406VatCodeRow[] = (
  [
    ['AIC', '21', '300204', '350204', '5/5.1/20/20.1'],
    ['AIC', '11', '300205', '350205', '5/5.1/20/20.1'],
    ['AIC', '19', '300201', '350201', '5/5.1/20/20.1'],
    ['IMP-DEF', '21', '300604', '350604', '7/22'],
    ['IMP-DEF', '11', '300605', '350605', '7/22'],
    ['IMP-DEF', '19', '300601', '350601', '7/22'],
    ['IMP', '21', '301204', '351204', '24'],
    ['IMP', '11', '301205', '351205', '25'],
    ['IMP', '19', '301201', '351201', '24.1'],
  ] as const
).flatMap(([prefix, rate, full, none, d300]): D406VatCodeRow[] =>
  (
    [
      ['full', full],
      ['none', none],
    ] as const
  ).map(([deduction, taxCode]) => ({
    direction: 'input',
    code: `${prefix}-${rate}`,
    deduction,
    taxCode,
    description: vatTaxCodes[taxCode]?.description ?? '',
    d300,
  })),
);

/**
 * The TaxCode of a tax entry: a code of vatTaxCodes; null for the collected side of a reverse
 * charge, which its acquisition's code reports; undefined when no row matches.
 */
export function d406VatTaxCode(entry: {
  direction: 'output' | 'input';
  code: string;
  rate?: string;
  deduction?: 'full' | 'half' | 'none' | 'prorata' | 'partial';
  /** The supplier (the company, for a sale) applies VAT on collection. */
  cashVat?: boolean;
  /** A sale to a consumer in another Member State below the threshold (`distance: origin`). */
  distance?: boolean;
  /** VAT owed through the special return outside VAT (`regime: special`). */
  special?: boolean;
}): string | null | undefined {
  if (entry.direction === 'output' && d406CollectedWithAcquisition(entry.code)) return null;
  const row = [
    ...d406VatCodes,
    ...d406DomesticReverseChargeCodes,
    ...d406ExemptCodes,
    ...d406FlatRateCodes,
    ...d406DistanceCodes,
    ...d406TradeCodes,
    ...d406RegimeCodes,
    ...d406SpecialCodes,
  ].find(
    (item) =>
      item.direction === entry.direction &&
      item.code === entry.code &&
      (item.rate === undefined || item.rate === entry.rate) &&
      (item.deduction === undefined || item.deduction === entry.deduction) &&
      (item.cashVat ?? false) === (entry.cashVat ?? false) &&
      (item.distance ?? false) === (entry.distance ?? false) &&
      (item.special ?? false) === (entry.special ?? false),
  );
  return row && vatTaxCodes[row.taxCode] ? row.taxCode : undefined;
}

/** "TVA neexigibilă" of TVA_NoteContabile by rate, for the release of VAT on collection. */
const releaseCodes: Readonly<Record<string, string>> = {
  'S-19': '380101',
  'S-9': '380102',
  'S-5': '380103',
  'S-20': '380104',
  'S-24': '380105',
  'S-21': '380106',
  'S-11': '380107',
};

/** The TaxCode of a release of VAT on collection, by the engine's code; undefined without one. */
export function d406CashVatReleaseCode(code: string): string | undefined {
  const taxCode = releaseCodes[code];
  return taxCode && vatTaxCodes[taxCode] ? taxCode : undefined;
}

/** The sales a fiscal cash register's Z report books (G2), by rate: sheet TVA_NoteContabile,
 * "Livrări/ prestări pentru care nu există obligația emiterii facturii … conform Art. 319 aliniat
 * 10 din Cod Fiscal" 3803xx, on the general-ledger entry, as ANAF's SAF-T answers say for the
 * registers' daily reports (General Ledger Entries, answer 1). */
const zReportCodes: Readonly<Record<string, string>> = {
  'S-19': '380301',
  'S-9': '380302',
  'S-5': '380303',
  'S-21': '380305',
  'S-11': '380306',
};

/** The TaxCode of a Z report's sales at a rate, by the engine's code; undefined without one. */
export function d406ZReportCode(code: string): string | undefined {
  const taxCode = zReportCodes[code];
  return taxCode && vatTaxCodes[taxCode] ? taxCode : undefined;
}
