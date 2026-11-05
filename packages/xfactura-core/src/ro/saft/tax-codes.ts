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
 */
export type D406VatCodeRow = {
  direction: 'output' | 'input';
  /** The engine's code: S-<rate>, RC-EU-SERV, RC-NONEU-SERV, EXP-EU-SERV, EXP-NONEU-SERV. */
  code: string;
  /** The VAT rate, for the reverse charges taxed at the standard rate of their tax point. */
  rate?: string;
  /** For acquisitions: the VAT deducted in full, by half or not at all. */
  deduction?: 'full' | 'half' | 'none';
  /** The supplier applies VAT on collection. */
  cashVat?: true;
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
];

/**
 * Exempt operations and the adjustments of deductible VAT (V2, src/ro/exempt): an exempt
 * purchase (EX-IN, D300 rd. 29) on the deductible sheet, its VAT being nil; the adjustments of
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

/** Adjustments reported at the rate of the VAT they adjust, which their tax entry records. */
export const d406RatedAdjustments = ['ADJ-300', 'ADJ-304', 'ADJ-305'];

/** The engine's codes whose collected side is reported with the acquisition. */
export const d406ReverseCharges = ['RC-EU-SERV', 'RC-NONEU-SERV'];

/**
 * The TaxCode of a tax entry: a code of vatTaxCodes; null for the collected side of a reverse
 * charge, which its acquisition's code reports; undefined when no row matches.
 */
export function d406VatTaxCode(entry: {
  direction: 'output' | 'input';
  code: string;
  rate?: string;
  deduction?: 'full' | 'half' | 'none' | 'partial';
  /** The supplier (the company, for a sale) applies VAT on collection. */
  cashVat?: boolean;
}): string | null | undefined {
  if (entry.direction === 'output' && d406ReverseCharges.includes(entry.code)) return null;
  const row = [...d406VatCodes, ...d406ExemptCodes].find(
    (item) =>
      item.direction === entry.direction &&
      item.code === entry.code &&
      (item.rate === undefined || item.rate === entry.rate) &&
      (item.deduction === undefined || item.deduction === entry.deduction) &&
      (item.cashVat ?? false) === (entry.cashVat ?? false),
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
