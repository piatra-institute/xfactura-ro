import { DomainError } from '../../errors';
import { element, serializeXml } from '../../xml/write';
import { isValidCui } from '../identifiers';
import { annualAddressText, annualCounties, type AnnualAddress, type StatementCheck } from './form';

/**
 * The inactivity declaration (S1046, "Declarație de inactivitate", tipBIL DI): a company that has
 * carried out no activity since it was set up draws up no annual statements and files this
 * declaration instead, within 60 days of the financial year's end (Legea contabilității nr.
 * 82/1991 art. 36 alin. (2); OMF nr. 2.036/2025 anexa nr. 1 pct. 3.3). It holds the
 * identification the order lists (pct. 3.3 alin. (4)): name, address, phone, trade register
 * number, CUI and the share capital, and the declarant, the person who manages the entity.
 *
 * The XML follows ANAF's structure A1.0.0 of 28.01.2016 (structura_S1046_DI_280116, namespace
 * `mfp:anaf:dgti:s1046:declaratie:v1`, "an >= 2015") and the schema s1046_20160128.xsd; the
 * validator J1.2.0 of 08.02.2016 is the one ANAF's page for the financial year 2025 publishes.
 * The structure covers any later year, but the engine writes only the years whose ANAF page
 * publishes the package (2025): a later year is a format gap until its page is read, never
 * assumed from 2025's.
 */

export type S1046Format = { year: number; namespace: string; validator: string; structure: string };

const formats: Readonly<Record<number, S1046Format>> = {
  2025: {
    year: 2025,
    namespace: 'mfp:anaf:dgti:s1046:declaratie:v1',
    validator: 'S1046Validator J1.2.0 (08.02.2016)',
    structure: 'structura_S1046_DI_280116 (A1.0.0, 28.01.2016)',
  },
};

const yearMessage = (year: number) =>
  `S1046 se scrie aici doar pentru exercițiul financiar 2025; pagina ANAF pentru ${year} nu a fost citită.`;

/** The format of a financial year; throws for a year without a known format. */
export function s1046Format(year: number): S1046Format {
  const format = formats[year];
  if (!format) throw new DomainError('S1046_YEAR', yearMessage(year));
  return format;
}

/** Tip_soc: the kind of entity (structura pt. 4). */
export const s1046EntityKinds = [
  [1, 'Operatori economici'],
  [2, 'Persoane juridice fără scop patrimonial'],
  [3, 'Entități autorizate, reglementate și supravegheate de BNR'],
  [4, 'Entități autorizate, reglementate și supravegheate de ASF'],
] as const;

export type S1046 = {
  /** an: the financial year; luna is 12 and data_S its last day. */
  year: number;
  /** data_S: the financial year's last day, YYYY-MM-DD (31 December). */
  yearEnd: string;
  /** Tip_soc. */
  entityKind: 1 | 2 | 3 | 4;
  entity: {
    cui: string;
    /** den, C(50). */
    name: string;
    address: AnnualAddress;
    phone?: string;
    tradeRegister: string;
    county: number;
    largeTaxpayer: boolean;
  };
  /** capital: the share capital in whole lei, N(15) >= 0; totalPlata_A repeats it. */
  capital: number;
  /** nume_declarant: the person who manages the entity (OMF nr. 2.036/2025 pct. 3.3 alin. (1)). */
  declarant: string;
};

const counties = new Set<number>(annualCounties.map(([code]) => code));

/** The declaration's checks, in Romanian, under the structure's fields. */
export function checkS1046(model: S1046): StatementCheck[] {
  const checks: StatementCheck[] = [];
  const error = (code: string, path: string, message: string) =>
    checks.push({ code, severity: 'error', path, message });
  if (!formats[model.year]) error('S1046_YEAR', 'year', yearMessage(model.year));
  if (model.yearEnd.slice(0, 4) !== String(model.year))
    error('S1046_DATE', 'yearEnd', 'Data de sfârșit (data_S) este în anul raportării.');
  if (!/^[1-9]\d{1,9}$/.test(model.entity.cui) || !isValidCui(model.entity.cui))
    error(
      'S1046_CUI',
      'entity.cui',
      'Codul unic de înregistrare nu este valid; se scrie fără prefixul RO.',
    );
  const text = (path: string, value: string | undefined, label: string, max: number) => {
    const trimmed = value?.trim() ?? '';
    if (!trimmed) error('S1046_TEXT', path, `Completați ${label}.`);
    else if (trimmed.length > max)
      error('S1046_TEXT', path, `Câmpul ${label} are cel mult ${max} caractere.`);
  };
  text('entity.name', model.entity.name, 'denumirea entității', 50);
  text('entity.address', annualAddressText(model.entity.address), 'adresa', 200);
  text('entity.tradeRegister', model.entity.tradeRegister, 'numărul din registrul comerțului', 18);
  text('declarant', model.declarant, 'numele declarantului', 75);
  if (model.entity.phone !== undefined && model.entity.phone.trim().length > 15)
    error('S1046_TEXT', 'entity.phone', 'Telefonul are cel mult 15 caractere.');
  if (!counties.has(model.entity.county))
    error(
      'S1046_COUNTY',
      'entity.county',
      'Județul sediului nu este în nomenclatorul ANAF (codTT).',
    );
  if (
    !Number.isSafeInteger(model.capital) ||
    model.capital < 0 ||
    model.capital > 999_999_999_999_999
  )
    error('S1046_CAPITAL', 'capital', 'Capitalul social este o sumă în lei, întreagă, nenegativă.');
  return checks;
}

const dmy = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)}`;

/** The declaration's XML; throws when a check fails. */
export function writeS1046(model: S1046): string {
  const format = s1046Format(model.year);
  const [first, ...rest] = checkS1046(model);
  if (first) throw new DomainError(first.code, first.message, 422, [first, ...rest]);
  const { entity } = model;
  return serializeXml(
    element('s1046', {
      xmlns: format.namespace,
      'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
      'xsi:schemaLocation': `${format.namespace} s1046.xsd`,
      luna: '12',
      an: String(model.year),
      Tip_soc: String(model.entityKind),
      data_S: dmy(model.yearEnd),
      cui: entity.cui,
      den: entity.name.trim(),
      adresa: annualAddressText(entity.address),
      telefon: entity.phone?.trim() || undefined,
      regCom: entity.tradeRegister.trim(),
      bifaMC: entity.largeTaxpayer ? '1' : '0',
      tipBIL: 'DI',
      codTT: String(entity.county),
      codJJ: entity.largeTaxpayer ? '41' : String(entity.county),
      capital: String(model.capital),
      nume_declarant: model.declarant.trim(),
      totalPlata_A: String(model.capital),
    }),
  );
}
