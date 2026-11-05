import { DomainError } from '../../errors';
import { element, serializeXml } from '../../xml/write';
import { isValidCnp, isValidCui } from '../identifiers';

/**
 * The annual profit tax return (D101, "Declarație privind impozitul pe profit") of a Romanian
 * legal person, form of OPANAF nr. 206/2025 (financial years ending from 2024), written after
 * ANAF's XML structure of 26.01.2026 (structura_D101_2025_260126) and checked by ANAF's validator
 * (DUKIntegrator, D101Validator J11.0.4 of 22.09.2026), which requires the namespace
 * `mfp:anaf:dgti:d101:declaratie:v10`. Where the published XSD (d101_20250214, namespace v3)
 * differs, this module follows the validator: the dates are `Data_I` and `Data_S`, and `d_reg`
 * is required.
 *
 * Covered: a Romanian legal person other than a bank (cod_obligatie 103), calendar year or the
 * part of it from the quarter it left the micro-enterprise regime (trim_micro), original or
 * rectifying. Not written: a modified fiscal year (Data_M), dissolution (Data_L, Data_B), the
 * fiscal group (d_grup), BNR/ASF regulated entities (d_reglem 1), the regularisation of art.
 * 225/227 (d_reg 1, Stat_rezid). Amounts are whole lei; the results (rd. 3, 6, 7, 10, 22, 35,
 * 38^1) may be negative.
 */

/** The rows of section B, as the structure names them (P38a is rd. 38^1, P081 rd. 8.1, …). */
export const d101Rows = [
  'P1',
  'P2',
  'P3',
  'P4',
  'P5',
  'P6',
  'P7',
  'P8',
  'P081',
  'P082',
  'P083',
  'P084',
  'P9',
  'P091',
  'P10',
  'P11',
  'P111',
  'P112',
  'P113',
  'P12',
  'P121',
  'P122',
  'P13',
  'P14',
  'P15',
  'P151',
  'P16',
  'P17',
  'P171',
  'P172',
  'P173',
  'P18',
  'P19',
  'P20',
  'P21',
  'P22',
  'P23',
  'P24',
  'P25',
  'P26',
  'P27',
  'P28',
  'P29',
  'P30',
  'P31',
  'P32',
  'P33',
  'P34',
  'P35',
  'P36',
  'P37',
  'P38',
  'P38a',
  'P39',
  'P39a',
  'P40',
  'P40a',
  'P41',
  'P411',
  'P412',
  'P42',
  'P421',
  'P422',
  'P4221',
  'P4222',
  'P423',
  'P4231',
  'P43',
  'P431',
  'P432',
  'P43a',
  'P44',
  'P45',
  'P46',
  'P47',
  'P48',
  'P481',
  'P482',
  'P49',
  'P50',
  'P51',
  'P52',
  'P53',
] as const;
export type D101Row = (typeof d101Rows)[number];
export type D101Rows = Record<D101Row, bigint>;

/** The main rows P1–P53, whose sum is the control sum (totalPlata_A): the rows under "din care"
 * and the rows 38^1, 39^1, 40^1 and 43^1 are not added, as the validator's rule R19 computes. */
export const d101ControlRows: readonly D101Row[] = d101Rows.filter((row) =>
  /^P([1-9]|[1-4]\d|5[0-3])$/.test(row),
);

/** Rows that may be negative: the results. */
const signedRows: readonly D101Row[] = ['P3', 'P6', 'P7', 'P10', 'P22', 'P35', 'P38a'];

export type D101 = {
  /** The period the return covers: 1 January, or the first day of the quarter the company left
   * the micro-enterprise regime (trim_micro), to 31 December. */
  period: { from: string; to: string };
  /** trim_micro: the quarter the company left the micro-enterprise regime in, or null. */
  microExitQuarter: 1 | 2 | 3 | 4 | null;
  /** d_rec: 0 original, 1 rectifying. */
  rectifying: boolean;
  /** d_anulare 1, temei 1 or 2: filed after the reserve of subsequent verification was
   * cancelled (art. 105 alin. (6) lit. a) or b) of the procedure code). */
  afterReserveCancellation: 1 | 2 | null;
  /** d_succ 1 and cifS: filed by the successor under art. 90 alin. (4) of the procedure code. */
  successorCui?: string;
  declarant: { lastName: string; firstName: string; role: string };
  /** Section A: cif without the RO prefix, the CAEN code, name and address. */
  payer: {
    cui: string;
    caen: string;
    name: string;
    address: string;
    phone?: string;
    fax?: string;
    email?: string;
  };
  /** Section C, the empowered representative. */
  representative?: {
    cui: string;
    name?: string;
    address?: string;
    phone?: string;
    fax?: string;
    email?: string;
  };
  /** Section B, every row, in whole lei. */
  rows: D101Rows;
};

export type D101Calculation = {
  namespace: string;
  /** scadenta, ZZLLAA, and the same as a date. */
  dueCode: string;
  dueDate: string;
  /** nr_evid */
  paymentNumber: string;
  /** totalPlata_A */
  controlSum: bigint;
};

const NAMESPACE = 'mfp:anaf:dgti:d101:declaratie:v10';
const pad = (value: number) => String(value).padStart(2, '0');
const maxAmount = 999_999_999_999_999n;

function isDate(date: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const value = new Date(Date.UTC(year, month - 1, day));
  return (
    value.getUTCFullYear() === year &&
    value.getUTCMonth() === month - 1 &&
    value.getUTCDate() === day
  );
}

/**
 * scadenta (structure field 17): the 25th of the month six months after the period's end for a
 * period ending from 2022 (the June deadline), as ZZLLAA.
 */
export function d101Due(to: string): { code: string; date: string } {
  let year = Number(to.slice(0, 4));
  let month = Number(to.slice(5, 7)) + 6;
  if (month > 12) [year, month] = [year + 1, month - 12];
  return { code: `25${pad(month)}${pad(year % 100)}`, date: `${year}-${pad(month)}-25` };
}

/**
 * nr_evid (field 19): "11", the obligation code (103), "01", the period end's month and year
 * (LLAA), the due date (ZZLLAA), 0 (no dissolution), "000", and the sum of the 21 digits before
 * it, two digits.
 */
export function d101PaymentNumber(to: string, dueCode: string): string {
  const body = `1110301${to.slice(5, 7)}${to.slice(2, 4)}${dueCode}0000`;
  const sum = [...body].reduce((total, digit) => total + Number(digit), 0);
  return `${body}${pad(sum % 100)}`;
}

/** The structure's namespace for a period: years ending from 2024. */
export function d101Namespace(period: D101['period']): string {
  if (!isDate(period.to) || Number(period.to.slice(0, 4)) < 2024)
    throw new DomainError(
      'D101_PERIOD',
      'Declarația 101 se depune aici pentru anii care se încheie din 2024 încolo.',
    );
  return NAMESPACE;
}

export function calculateD101(model: D101): D101Calculation {
  const namespace = d101Namespace(model.period);
  const due = d101Due(model.period.to);
  return {
    namespace,
    dueCode: due.code,
    dueDate: due.date,
    paymentNumber: d101PaymentNumber(model.period.to, due.code),
    controlSum: d101ControlRows.reduce((sum, row) => sum + model.rows[row], 0n),
  };
}

const flag = (value: boolean) => (value ? '1' : '0');
const optional = (value: string | undefined) => (value?.trim() ? value : undefined);
const structureDate = (date: string) => date.split('-').reverse().join('.');

/** Writes the return as one `declaratie101` element, its attributes in the structure's order. */
export function writeD101(model: D101): string {
  const calculation = calculateD101(model);
  const { from, to } = model.period;
  const { declarant, payer, representative: agent } = model;
  return serializeXml(
    element('declaratie101', {
      xmlns: calculation.namespace,
      luna_i: String(Number(from.slice(5, 7))),
      luna: String(Number(to.slice(5, 7))),
      an: to.slice(0, 4),
      an_i: from.slice(0, 4),
      d_rec: flag(model.rectifying),
      d_reg: '0',
      d_anulare: flag(model.afterReserveCancellation !== null),
      temei:
        model.afterReserveCancellation === null
          ? undefined
          : String(model.afterReserveCancellation),
      d_succ: flag(model.successorCui !== undefined),
      cifS: model.successorCui,
      d_alte: '0',
      d_reglem: '0',
      trim_micro: model.microExitQuarter === null ? undefined : String(model.microExitQuarter),
      Data_I: structureDate(from),
      Data_S: structureDate(to),
      cod_obligatie: '103',
      scadenta: calculation.dueCode,
      cod_bug: '5503XXXXXX',
      nr_evid: calculation.paymentNumber,
      totalPlata_A: calculation.controlSum.toString(),
      nume_declar: declarant.lastName,
      prenume_declar: declarant.firstName,
      functie_declar: declarant.role,
      cif: payer.cui,
      caen: payer.caen,
      denumire: payer.name,
      adresa: payer.address,
      telefon: optional(payer.phone),
      fax: optional(payer.fax),
      email: optional(payer.email),
      cifR: agent?.cui,
      denR: optional(agent?.name),
      adrR: optional(agent?.address),
      telR: optional(agent?.phone),
      faxR: optional(agent?.fax),
      emailR: optional(agent?.email),
      ...Object.fromEntries(d101Rows.map((row) => [row, model.rows[row].toString()])),
    }),
  );
}

export type D101Check = {
  code: string;
  /** error: ANAF's validator rejects it (E:); warning: accepted with a notice (A:). */
  severity: 'error' | 'warning';
  path: string;
  message: string;
};

const isCui = (code: string) => /^[1-9]\d{1,9}$/.test(code) && isValidCui(code);
const isCuiOrCnp = (code: string) =>
  isCui(code) || (/^[1-9]\d{12}$/.test(code) && isValidCnp(code));

/** max(0, value) */
const positive = (value: bigint) => (value > 0n ? value : 0n);

/**
 * The rows the structure computes from the others, from the rows given: what writing them
 * requires, so a model can be completed before it is checked.
 */
export function deriveD101Rows(rows: D101Rows): D101Rows {
  const r = { ...rows };
  r.P3 = r.P1 - r.P2;
  r.P6 = r.P4 - r.P5;
  r.P7 = r.P3 + r.P6;
  r.P10 = r.P7 + r.P8 - r.P9;
  r.P16 = r.P11 + r.P12 + r.P13 + r.P14 + r.P15;
  r.P21 = r.P17 + r.P18 + r.P19 + r.P20;
  r.P22 = r.P10 - r.P16 - r.P21;
  r.P34 = r.P23 + r.P24 + r.P25 + r.P26 + r.P27 + r.P28 + r.P29 + r.P30 + r.P31 + r.P32 + r.P33;
  r.P35 = r.P22 + r.P34;
  r.P38a = r.P35 + r.P36 + r.P37 - r.P38;
  r.P40 = r.P38a >= 0n && r.P39a >= 0n && r.P38a - r.P39a > 0n ? r.P38a - r.P39a : 0n;
  r.P40a = r.P38a < 0n ? -r.P38a : 0n;
  r.P41 = r.P411 + r.P412;
  r.P42 = r.P421 + r.P422 + r.P423;
  const v1 = positive(r.P41 - r.P42 - r.P43 - r.P44 - r.P45);
  const noMinimum = r.P46 === 0n && r.P47 === 0n;
  r.P481 = noMinimum || r.P46 >= r.P47 ? v1 : 0n;
  r.P482 = !noMinimum && r.P47 > r.P46 ? positive(r.P47 - r.P421 - r.P431 - r.P43a) : 0n;
  r.P48 = r.P481 + r.P482;
  const due = r.P48 + r.P51 - (r.P49 + r.P50);
  r.P52 = positive(due);
  r.P53 = positive(-due);
  return r;
}

/**
 * The structure's validations as ANAF's validator applies them, in Romanian: the identification,
 * every formula and each "din care" row against its total. The official validator remains the
 * oracle; it also checks the CAEN nomenclature.
 */
export function checkD101(model: D101): D101Check[] {
  const checks: D101Check[] = [];
  const error = (code: string, path: string, message: string) =>
    checks.push({ code, severity: 'error', path, message });
  const text = (
    path: string,
    value: string | undefined,
    label: string,
    max: number,
    required = false,
  ) => {
    const trimmed = value?.trim();
    if (!trimmed) {
      if (required) error('D101_TEXT', path, `Completați ${label}.`);
    } else if (trimmed.length > max)
      error('D101_TEXT', path, `Câmpul ${label} are cel mult ${max} caractere.`);
  };
  const { period, rows } = model;
  try {
    d101Namespace(period);
  } catch (failure) {
    error('D101_PERIOD', 'period', (failure as Error).message);
    return checks;
  }
  if (!isDate(period.from) || period.from > period.to)
    error('D101_PERIOD', 'period.from', 'Perioada începe înainte de sfârșitul ei.');
  if (period.to.slice(5) !== '12-31' || period.from.slice(0, 4) !== period.to.slice(0, 4))
    error(
      'D101_PERIOD',
      'period',
      'Anul fiscal modificat și lichidarea nu sunt acoperite: perioada se încheie la 31 decembrie a anului în care începe.',
    );
  const quarterStart =
    model.microExitQuarter === null ? '01-01' : `${pad(model.microExitQuarter * 3 - 2)}-01`;
  if (period.from.slice(5) !== quarterStart)
    error(
      'D101_PERIOD',
      'period.from',
      model.microExitQuarter === null
        ? 'Perioada începe la 1 ianuarie (R15).'
        : `Perioada începe în prima zi a trimestrului ${model.microExitQuarter}, în care s-a trecut de la impozitul micro la profit (R15).`,
    );
  text('declarant.lastName', model.declarant.lastName, 'numele declarantului', 75, true);
  text('declarant.firstName', model.declarant.firstName, 'prenumele declarantului', 75, true);
  text('declarant.role', model.declarant.role, 'funcția declarantului', 50, true);
  if (!isCui(model.payer.cui))
    error(
      'D101_CUI',
      'payer.cui',
      'Codul de identificare fiscală nu este valid; se scrie fără RO.',
    );
  if (!/^\d{4}$/.test(model.payer.caen))
    error('D101_CAEN', 'payer.caen', 'Codul CAEN are 4 cifre.');
  text('payer.name', model.payer.name, 'denumirea', 200, true);
  text('payer.address', model.payer.address, 'adresa', 1000, true);
  text('payer.phone', model.payer.phone, 'telefonul', 15);
  text('payer.fax', model.payer.fax, 'faxul', 15);
  text('payer.email', model.payer.email, 'e-mailul', 200);
  if (model.successorCui !== undefined && !isCuiOrCnp(model.successorCui))
    error(
      'D101_CUI',
      'successorCui',
      'Codul de identificare fiscală al succesorului nu este valid.',
    );
  if (model.representative) {
    if (!isCuiOrCnp(model.representative.cui))
      error(
        'D101_CUI',
        'representative.cui',
        'Codul de identificare fiscală al împuternicitului nu este valid.',
      );
    text('representative.name', model.representative.name, 'denumirea împuternicitului', 200);
  }

  for (const row of d101Rows) {
    const value = rows[row];
    if (typeof value !== 'bigint') {
      error('D101_ROW', `rows.${row}`, `Lipsește rândul ${row}.`);
      continue;
    }
    if (value < 0n && !signedRows.includes(row))
      error('D101_ROW', `rows.${row}`, `Rândul ${row} nu poate fi negativ.`);
    if ((value < 0n ? -value : value) > maxAmount)
      error('D101_ROW', `rows.${row}`, `Rândul ${row} depășește 15 cifre.`);
  }
  if (checks.some((check) => check.code === 'D101_ROW')) return checks;

  const expected = deriveD101Rows(rows);
  for (const row of [
    'P3',
    'P6',
    'P7',
    'P10',
    'P16',
    'P21',
    'P22',
    'P34',
    'P35',
    'P38a',
    'P40',
    'P40a',
    'P41',
    'P42',
    'P48',
    'P481',
    'P482',
    'P52',
    'P53',
  ] as const)
    if (rows[row] !== expected[row])
      error(
        'D101_FORMULA',
        `rows.${row}`,
        `Rândul ${row} este ${rows[row]}; după formula structurii ar fi ${expected[row]}.`,
      );
  const atLeast = (total: D101Row, parts: D101Row[]) => {
    if (rows[total] < parts.reduce((sum, row) => sum + rows[row], 0n))
      error(
        'D101_PARTS',
        `rows.${total}`,
        `Rândul ${total} este mai mic decât rândurile „din care” (${parts.join(', ')}).`,
      );
  };
  atLeast('P8', ['P081', 'P082', 'P083', 'P084']);
  atLeast('P9', ['P091']);
  atLeast('P11', ['P111', 'P112', 'P113']);
  atLeast('P12', ['P121', 'P122']);
  atLeast('P15', ['P151']);
  atLeast('P17', ['P171', 'P172', 'P173']);
  atLeast('P422', ['P4221', 'P4222']);
  atLeast('P423', ['P4231']);
  atLeast('P43', ['P431', 'P432']);
  // V1–V8
  if (rows.P39a > rows.P39)
    error(
      'D101_V1',
      'rows.P39a',
      'Pierderea recuperată (rd. 39^1) depășește pierderea de recuperat (rd. 39).',
    );
  if (rows.P39a > 0n && rows.P38a <= 0n)
    error(
      'D101_V1',
      'rows.P39a',
      'Pierderea din anii precedenți se recuperează doar dintr-un profit (rd. 38^1).',
    );
  if (rows.P421 > rows.P41)
    error('D101_V2', 'rows.P421', 'Creditul fiscal extern depășește impozitul (rd. 41).');
  if (rows.P422 > rows.P41 - rows.P421)
    error('D101_V3', 'rows.P422', 'Impozitul scutit depășește impozitul rămas.');
  if (rows.P423 > rows.P41 - rows.P421 - rows.P422)
    error('D101_V4', 'rows.P423', 'Scutirile și reducerile depășesc impozitul rămas.');
  if (rows.P43 * 100n > (rows.P41 - rows.P42) * 20n)
    error(
      'D101_V5',
      'rows.P43',
      'Sponsorizarea scăzută (rd. 43) depășește 20% din impozit (rd. 41 − rd. 42).',
    );
  if (rows.P44 > rows.P41 - (rows.P42 + rows.P43))
    error('D101_V6', 'rows.P44', 'Alte sume scăzute depășesc impozitul rămas.');
  if (rows.P45 > rows.P41 - (rows.P42 + rows.P43 + rows.P44))
    error('D101_V7', 'rows.P45', 'Reducerea depășește impozitul rămas.');
  if (rows.P41 <= 0n && rows.P40 > 0n)
    checks.push({
      code: 'D101_TAX',
      severity: 'warning',
      path: 'rows.P41',
      message: 'Profit impozabil fără impozit (rd. 41).',
    });
  return checks;
}
