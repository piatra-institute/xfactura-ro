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
 */
export type D406VatCodeRow = {
  direction: 'output' | 'input';
  /** The engine's code: S-<rate>, RC-EU-SERV, RC-NONEU-SERV, EXP-EU-SERV, EXP-NONEU-SERV. */
  code: string;
  /** The VAT rate, for the reverse charges taxed at the standard rate of their tax point. */
  rate?: string;
  /** For acquisitions: the VAT deducted in full, by half or not at all. */
  deduction?: 'full' | 'half' | 'none';
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
];

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
}): string | null | undefined {
  if (entry.direction === 'output' && d406ReverseCharges.includes(entry.code)) return null;
  const row = d406VatCodes.find(
    (item) =>
      item.direction === entry.direction &&
      item.code === entry.code &&
      (item.rate === undefined || item.rate === entry.rate) &&
      (item.deduction === undefined || item.deduction === entry.deduction),
  );
  return row && vatTaxCodes[row.taxCode] ? row.taxCode : undefined;
}
