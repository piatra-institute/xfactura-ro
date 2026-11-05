import { DomainError } from '../../errors';
import { element, serializeXml } from '../../xml/write';
import { isValidCnp, isValidCui } from '../identifiers';

/**
 * The informative statement of tax withheld at source from non-residents, per beneficiary (D207,
 * "Declarație informativă privind impozitul reținut la sursă/impozitul suportat de plătitorul de
 * venit/veniturile scutite, pe beneficiari de venit nerezidenți"), filed by the last day of
 * February for the year before (Codul fiscal art. 231 alin. (1)), after ANAF's XML structure of
 * 20.02.2026 (structura_D207_2025_200226, OPANAF nr. 179/2022, reporting years from 2021) and its
 * schema d207_20025020.xsd, in the namespace `mfp:anaf:dgti:d207:declaratie:v2` that ANAF's
 * validator (D207Validator J2.0.2 of 20.02.2025) requires.
 *
 * Section II totals one income type (tip_venit): its beneficiaries, the exempt gross (Tscutit, for
 * the exempt codes 12–21), the base (Tbaza, for the taxed codes 01–11 and 22–26), the tax withheld
 * (Timp) and the tax borne by the payer (Timps). Sections III–IV hold one record per beneficiary
 * and income type: name, state of residence, the Romanian (cifR) and foreign (cifS) tax codes,
 * base, tax withheld, tax borne and the act applied (Act_N: 1 the Codul fiscal, 2 a double tax
 * treaty, 3 an international agreement). The validator keys a record by cifR and tip_venit1, or,
 * without cifR, by tip_venit1 with cifS or the name; the control sum (rule R16) adds every
 * section II's nrben, Tscutit, Tbaza, Timp and Timps.
 *
 * Amounts are whole lei, N(15), never negative.
 */

/** tip_venit: the nomenclature of the income's nature (structure of 03.01.2022). */
export const d207IncomeTypes: Readonly<Record<string, string>> = {
  '01': 'Venituri din dividende (art. 223 alin. (1) lit. a))',
  '22': 'Venituri din dividende (cf. convențiilor de evitare a dublei impuneri)',
  '02': 'Venituri din dobânzi (art. 223 alin. (1) lit. b) și c))',
  '23': 'Venituri din dobânzi (cf. convențiilor de evitare a dublei impuneri)',
  '03': 'Venituri din redevențe (art. 223 alin. (1) lit. d) și e))',
  '24': 'Venituri din redevențe (cf. convențiilor de evitare a dublei impuneri)',
  '04': 'Venituri din comisioane (art. 223 alin. (1) lit. f) și g))',
  '25': 'Venituri din comisioane (cf. convențiilor de evitare a dublei impuneri)',
  '05': 'Venituri din activități sportive și de divertisment (art. 223 alin. (1) lit. h))',
  '06': 'Remunerații ale persoanelor juridice străine administratori, fondatori sau membri ai consiliului de administrație (art. 223 alin. (1) lit. j))',
  '07': 'Venituri din servicii prestate de persoane nerezidente (art. 223 alin. (1) lit. i), k) și l))',
  '26': 'Plăți pentru servicii tehnice (art. 12 din Acordul România–India)',
  '08': 'Premii acordate la concursuri organizate în România (art. 223 alin. (1) lit. m))',
  '10': 'Venituri din lichidarea unui rezident (art. 223 alin. (1) lit. o))',
  '11': 'Transferul masei patrimoniale fiduciare (art. 223 alin. (1) lit. p))',
  '12': 'Dobânzi scutite (art. 229 alin. (1) lit. a), b), g) și h))',
  '19': 'Dobânzi scutite (cf. convențiilor / acordurilor internaționale)',
  '13': 'Venituri scutite din instrumente financiare derivate, titluri de stat și obligațiuni (art. 229 alin. (1) lit. a))',
  '14': 'Dividende scutite (art. 229 alin. (1) lit. c) și c^1))',
  '20': 'Dividende scutite (cf. convențiilor / acordurilor internaționale)',
  '15': 'Premii scutite (art. 229 alin. (1) lit. d) și e))',
  '16': 'Redevențe scutite (art. 229 alin. (1) lit. g))',
  '21': 'Redevențe scutite (cf. convențiilor / acordurilor internaționale)',
  '17': 'Venituri scutite din consultanță (art. 229 alin. (1) lit. f))',
  '18': 'Câștiguri scutite din jocuri de noroc în alt stat (art. 229 alin. (1) lit. i))',
};

/** The exempt income types: their gross goes to Tscutit and their tax is 0. */
const exemptTypes = new Set(['12', '13', '14', '15', '16', '17', '18', '19', '20', '21']);
/** The order section II lists the types in, as the nomenclature does (the record's keys would
 * sort the integer-like ones first). */
const typeOrder = [
  '01',
  '22',
  '02',
  '23',
  '03',
  '24',
  '04',
  '25',
  '05',
  '06',
  '07',
  '26',
  '08',
  '10',
  '11',
  '12',
  '19',
  '13',
  '14',
  '20',
  '15',
  '16',
  '21',
  '17',
  '18',
];

/** One payment to a non-resident in the reporting year. */
export type D207Payment = {
  /** YYYY-MM-DD, within the reporting year. */
  date: string;
  /** The gross income, the base of the tax (or the exempt income), whole lei. */
  base: number;
  /** The tax withheld from it, whole lei. */
  tax: number;
};

export type D207Beneficiary = {
  /** den1 */
  name: string;
  /** Stat_R: ISO 3166-1 alpha-2, as the structure's list of states codes it (GR for Greece). */
  state: string;
  /** cifR: a Romanian CUI, CNP or NIF, when the beneficiary has one. */
  romanianId?: string;
  /** cifS: the tax code in the state of residence. */
  foreignId?: string;
  /** tip_venit1 */
  incomeType: string;
  /** Act_N: 1 the Codul fiscal, 2 a double tax treaty, 3 an international agreement. */
  act: 1 | 2 | 3;
  payments: D207Payment[];
};

export type D207 = {
  /** an: the reporting year; luna is always 12. */
  year: number;
  /** d_rec: replaces the declaration filed for the year. */
  correction: boolean;
  declarant: { lastName: string; firstName: string; role: string };
  /** Section I: the income payer. */
  payer: {
    /** cui: digits only, without RO. */
    cui: string;
    /** cifSS: the successor, for a declaration filed under art. 90 alin. (4) Cod procedură
     * fiscală. */
    successorCui?: string;
    name: string;
    address: string;
    phone?: string;
    fax?: string;
    email?: string;
  };
  beneficiaries: D207Beneficiary[];
};

export type D207Record = {
  /** id_inreg */
  id: number;
  beneficiary: number;
  incomeType: string;
  /** baza1: the base, or the exempt gross. */
  base: bigint;
  /** imp1 */
  tax: bigint;
};

export type D207Summary = {
  incomeType: string;
  /** nrben */
  beneficiaries: number;
  /** Tscutit */
  exempt: bigint;
  /** Tbaza */
  base: bigint;
  /** Timp */
  tax: bigint;
};

export type D207Calculation = {
  namespace: string;
  records: D207Record[];
  summaries: D207Summary[];
  /** totalPlata_A */
  controlSum: bigint;
};

const namespace = 'mfp:anaf:dgti:d207:declaratie:v2';
const firstYear = 2021;
const lastYear = 2026;
const isYear = (year: number) => Number.isInteger(year) && year >= firstYear && year <= lastYear;
const yearMessage = 'Declarația D207 în această structură se depune pentru anii 2021–2026.';

/** The structure's namespace for a reporting year. */
export function d207Namespace(year: number): string {
  if (!isYear(year)) throw new DomainError('D207_YEAR', yearMessage);
  return namespace;
}

type Problem = { code: string; path: string; message: string };

const isAmount = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 999_999_999_999_999;

function inputProblems(model: D207): Problem[] {
  const problems: Problem[] = [];
  model.beneficiaries.forEach((beneficiary, index) => {
    const path = `beneficiaries.${index}`;
    if (!d207IncomeTypes[beneficiary.incomeType])
      problems.push({
        code: 'D207_INCOME_TYPE',
        path: `${path}.incomeType`,
        message: `Tipul de venit ${beneficiary.incomeType} nu este în nomenclatorul D207.`,
      });
    if (![1, 2, 3].includes(beneficiary.act))
      problems.push({
        code: 'D207_ACT',
        path: `${path}.act`,
        message: 'Actul normativ este 1 (Codul fiscal), 2 (convenția) sau 3 (acord internațional).',
      });
    beneficiary.payments.forEach((payment, item) => {
      for (const key of ['base', 'tax'] as const)
        if (!isAmount(payment[key]))
          problems.push({
            code: 'D207_AMOUNT',
            path: `${path}.payments.${item}.${key}`,
            message: 'O sumă în lei, fără zecimale, nenegativă, de cel mult 15 cifre.',
          });
    });
  });
  return problems;
}

const sum = <T>(items: readonly T[], value: (item: T) => bigint) =>
  items.reduce((total, item) => total + value(item), 0n);

/**
 * The records, section II totals and control sum. Throws when the year, a type, an act or an
 * amount is not one the declaration accepts; checkD207 lists those without throwing.
 */
export function calculateD207(model: D207): D207Calculation {
  const ns = d207Namespace(model.year);
  const [problem] = inputProblems(model);
  if (problem) throw new DomainError(problem.code, problem.message);
  const records: D207Record[] = model.beneficiaries.map((beneficiary, index) => ({
    id: index + 1,
    beneficiary: index,
    incomeType: beneficiary.incomeType,
    base: sum(beneficiary.payments, (payment) => BigInt(payment.base)),
    tax: sum(beneficiary.payments, (payment) => BigInt(payment.tax)),
  }));
  const summaries: D207Summary[] = typeOrder.flatMap((incomeType) => {
    const own = records.filter((record) => record.incomeType === incomeType);
    if (!own.length) return [];
    const exempt = exemptTypes.has(incomeType);
    return [
      {
        incomeType,
        beneficiaries: own.length,
        exempt: exempt ? sum(own, (record) => record.base) : 0n,
        base: exempt ? 0n : sum(own, (record) => record.base),
        tax: sum(own, (record) => record.tax),
      },
    ];
  });
  return {
    namespace: ns,
    records,
    summaries,
    // Timps is 0: the tax borne by the payer is not covered.
    controlSum: sum(
      summaries,
      (summary) => BigInt(summary.beneficiaries) + summary.exempt + summary.base + summary.tax,
    ),
  };
}

const text = (value: bigint | number) => value.toString();
const optional = (value: string | undefined) => (value?.trim() ? value.trim() : undefined);

/** Writes the declaration: the payer's attributes, section II per income type, a benef record per
 * beneficiary and type, attributes in the XSD's order. */
export function writeD207(model: D207): string {
  const calculation = calculateD207(model);
  if (!calculation.records.length)
    throw new DomainError(
      'D207_BENEFICIARIES',
      'Declarația cuprinde cel puțin un beneficiar nerezident.',
    );
  const { declarant, payer } = model;
  return serializeXml(
    element(
      'declaratie207',
      {
        xmlns: calculation.namespace,
        'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
        'xsi:schemaLocation': `${calculation.namespace} D207.xsd`,
        luna: '12',
        an: String(model.year),
        d_rec: model.correction ? '1' : '0',
        cifSS: payer.successorCui,
        nume_declar: declarant.lastName,
        prenume_declar: declarant.firstName,
        functie_declar: declarant.role,
        cui: payer.cui,
        den: payer.name,
        adresa: payer.address,
        telefon: optional(payer.phone),
        fax: optional(payer.fax),
        mail: optional(payer.email),
        totalPlata_A: text(calculation.controlSum),
      },
      [
        ...calculation.summaries.map((summary) =>
          element('sect_II', {
            tip_venit: summary.incomeType,
            nrben: text(summary.beneficiaries),
            Tscutit: text(summary.exempt),
            Tbaza: text(summary.base),
            Timp: text(summary.tax),
            Timps: '0',
          }),
        ),
        ...calculation.records.map((record) => {
          const beneficiary = model.beneficiaries[record.beneficiary]!;
          return element('benef', {
            id_inreg: text(record.id),
            tip_venit1: record.incomeType,
            den1: beneficiary.name,
            Stat_R: beneficiary.state,
            cifR: optional(beneficiary.romanianId),
            cifS: optional(beneficiary.foreignId),
            baza1: text(record.base),
            imp1: text(record.tax),
            imps1: '0',
            Act_N: String(beneficiary.act),
          });
        }),
      ],
    ),
  );
}

export type D207Check = {
  code: string;
  severity: 'error' | 'warning';
  path: string;
  message: string;
};

const isCifR = (code: string) =>
  (/^[1-9]\d{1,9}$/.test(code) && isValidCui(code)) ||
  (/^[1-9]\d{12}$/.test(code) && isValidCnp(code));
const isDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date);

/** The structure's validations for what is written here, in Romanian; ANAF's validator remains
 * the oracle. */
export function checkD207(model: D207): D207Check[] {
  const checks: D207Check[] = [];
  const error = (code: string, path: string, message: string) =>
    checks.push({ code, severity: 'error', path, message });
  const textField = (
    path: string,
    value: string | undefined,
    label: string,
    max: number,
    required = false,
  ) => {
    const trimmed = value?.trim();
    if (!trimmed) {
      if (required) error('D207_TEXT', path, `Completați ${label}.`);
    } else if (trimmed.length > max)
      error('D207_TEXT', path, `Câmpul ${label} are cel mult ${max} caractere.`);
  };
  if (!isYear(model.year)) error('D207_YEAR', 'year', yearMessage);
  textField('declarant.lastName', model.declarant.lastName, 'numele declarantului', 75, true);
  textField('declarant.firstName', model.declarant.firstName, 'prenumele declarantului', 75, true);
  textField('declarant.role', model.declarant.role, 'funcția declarantului', 50, true);
  if (!/^[1-9]\d{1,9}$/.test(model.payer.cui) || !isValidCui(model.payer.cui))
    error('D207_CUI', 'payer.cui', 'Codul de identificare fiscală al plătitorului nu este valid.');
  textField('payer.name', model.payer.name, 'denumirea plătitorului', 200, true);
  textField('payer.address', model.payer.address, 'adresa domiciliului fiscal', 1000, true);
  textField('payer.phone', model.payer.phone, 'telefonul', 15);
  textField('payer.fax', model.payer.fax, 'faxul', 15);
  textField('payer.email', model.payer.email, 'e-mailul', 200);
  for (const problem of inputProblems(model)) error(problem.code, problem.path, problem.message);
  const keys = new Set<string>();
  model.beneficiaries.forEach((beneficiary, index) => {
    const path = `beneficiaries.${index}`;
    textField(`${path}.name`, beneficiary.name, 'numele beneficiarului', 100, true);
    if (!/^[A-Z]{2}$/.test(beneficiary.state) || beneficiary.state === 'RO')
      error('D207_STATE', `${path}.state`, 'Statul de rezidență al nerezidentului nu este valid.');
    if (beneficiary.romanianId !== undefined && !isCifR(beneficiary.romanianId))
      error('D207_CIF', `${path}.romanianId`, 'Codul din România al beneficiarului nu este valid.');
    textField(`${path}.foreignId`, beneficiary.foreignId, 'codul fiscal din străinătate', 20);
    // The validator's key: cifR and the type, or the type with cifS or the name.
    const key = `${beneficiary.incomeType}|${beneficiary.romanianId ?? beneficiary.foreignId ?? beneficiary.name}`;
    if (keys.has(key))
      error(
        'D207_DUPLICATE',
        path,
        'Un beneficiar se declară o singură dată pentru un tip de venit; plățile lui se adună.',
      );
    keys.add(key);
    beneficiary.payments.forEach((payment, item) => {
      const at = `${path}.payments.${item}`;
      if (!isDate(payment.date) || Number(payment.date.slice(0, 4)) !== model.year)
        error(
          'D207_DATE',
          `${at}.date`,
          `Plata din ${payment.date} nu este din anul ${model.year}.`,
        );
      if (exemptTypes.has(beneficiary.incomeType) && payment.tax !== 0)
        error('D207_TAX', `${at}.tax`, 'Venitul scutit nu are impozit reținut.');
      if (isAmount(payment.tax) && isAmount(payment.base) && payment.tax > payment.base)
        error('D207_TAX', `${at}.tax`, 'Impozitul nu poate depăși venitul.');
    });
    if (
      beneficiary.act === 2 &&
      !['19', '20', '21', '22', '23', '24', '25', '26'].includes(beneficiary.incomeType)
    )
      error(
        'D207_ACT',
        `${path}.act`,
        'Cota unei convenții se declară cu tipurile de venit ale convențiilor (19–26).',
      );
  });
  if (!model.beneficiaries.length)
    error(
      'D207_BENEFICIARIES',
      'beneficiaries',
      'Declarația cuprinde cel puțin un beneficiar nerezident.',
    );
  return checks;
}
