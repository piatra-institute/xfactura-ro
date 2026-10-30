import { DomainError } from '../../errors';
import { element, serializeXml } from '../../xml/write';
import { isValidCnp, isValidCui } from '../identifiers';

/**
 * The declaration of payment obligations to the state budget (D100, "Declarație privind
 * obligațiile de plată la bugetul de stat") for reporting periods from 01/2026, after ANAF's XML
 * structure for D100/D710 valid from 01/2024 (OPANAF nr. 57/2026), updated 14.09.2026
 * (structura_D100-D710_0126_140926), and its schema d100_24022022.xsd.
 *
 * ANAF's validator (DUKIntegrator, D100Validator J21.0.8 of 14.09.2026) requires the namespace
 * `mfp:anaf:dgti:d100:declaratie:v2`. Where the XSD and the validator differ, this module follows
 * the validator and the structure: the e-mail is `mail` (the XSD's `mai`), the representative
 * (cifR … emailR) and bifa_impozit_minim exist, and cota is 1 for 121 from 2026. For the fourth
 * quarter of 121 they disagree on the due date: the structure ends the 25 June exception with the
 * reporting year 2025, so 25 January; the validator still requires 25 June of the next year. The
 * caller chooses (fourthQuarterDue).
 *
 * Covered: the micro-enterprise income tax of a quarter (121), the dividend tax withheld from
 * individuals (604) and Romanian companies (150), and the tax withheld on interest paid to
 * individuals (605, nomenclature position 7: art. 97 and 132, monthly, due the 25th of the next
 * month, model 1#); any other obligation of the nomenclature as
 * typed amounts, with its budget code and due date given. A declaration filed after the reserve of
 * subsequent verification was cancelled is a D100 (d_anulare 1, temei 2); any other correction is
 * the rectifying declaration D710 (`declaratie710`, with the amounts as declared and as
 * corrected), a separate form with its own schema and validator, not written here. Neither are
 * d_energie (D710 only), d_modif (103), Data_I (131, 132), Data_IC, d_nInf and d_bonif (701);
 * those obligations are refused.
 *
 * Amounts are whole lei, N(15), never negative.
 */

/** The obligations computed here (nomenclature positions 5, 6, 4 and 7): code, budget code
 * (cod_bugetar: 20470101 replaced by 5503, padded with X to ten characters) and wording. */
export const d100Obligations = [
  ['121', '5503XXXXXX', 'Impozit pe veniturile microîntreprinderilor'],
  ['604', '5503XXXXXX', 'Impozit pe veniturile din dividende distribuite PF'],
  ['150', '5503XXXXXX', 'Impozit pe dividende distribuite PJ'],
  ['605', '5503XXXXXX', 'Impozit pe veniturile din dobânzi'],
] as const;
export type D100ObligationCode = (typeof d100Obligations)[number][0];

export type D100MicroTax = {
  /** 121, art. 47–56 Cod fiscal: declared for the quarter's last month, or for any month by a
   * company dissolving. */
  kind: 'micro';
  /** The quarter's taxable base, whole lei; suma_dat is 1% of it (cota 1), rounded half up. */
  base: number;
  /** suma_ded, "Suma deductibilă / Suma datorată anterior / Bonificație 10%": the structure
   * names no deduction for 121; absent is 0. */
  deductible?: number;
  /** suma_redu, "Reducere impozit cf. OUG 153/2020": at most 15% of suma_dat. */
  reduction?: number;
  /** scadenta of the fourth quarter (month 12): 25 January (the structure) or 25 June (the
   * validator) of the next year. Required in month 12, absent otherwise. */
  fourthQuarterDue?: 'january' | 'june';
};

export type D100DividendTax = {
  /** 604 for individuals (art. 97 alin. (7) Cod fiscal), 150 for Romanian companies (art. 43). */
  kind: 'dividends';
  beneficiary: 'individual' | 'company';
  /** The tax withheld on the dividends paid in the month, whole lei: the sum of each payment's
   * tax as booked (446), which a total gross cannot reproduce. */
  withheld: number;
  /** December only: the tax on dividends distributed and still unpaid at the end of the year the
   * annual financial statements were approved, due by 25 January. */
  unpaidAtYearEnd?: number;
};

/** Any other obligation of the nomenclature: the structure treats every line alike, while its
 * budget code, due date and model of completion depend on the code and are inputs here. */
export type D100OtherObligation = {
  kind: 'other';
  /** cod_oblig */
  code: string;
  /** cod_bugetar as the nomenclature gives it; padded with X to ten characters. */
  budgetCode: string;
  /** scadenta, YYYY-MM-DD, by the nomenclature's rule for the code. */
  dueDate: string;
  /** suma_dat, suma_ded, suma_plata, suma_rest */
  due: number;
  deductible: number;
  payable: number;
  refund: number;
  /** bifa_impozit_minim: "Impozit minim pe cifra de afaceri". */
  minimumTax?: boolean;
};

export type D100InterestTax = {
  /** 605, art. 97 alin. (2) Cod fiscal: interest paid to individuals under civil contracts. */
  kind: 'interest';
  /** The tax withheld on the interest paid in the month, whole lei: the sum of each payment's
   * tax as booked (446). */
  withheld: number;
};

export type D100Obligation = D100MicroTax | D100DividendTax | D100InterestTax | D100OtherObligation;

export type D100Contact = {
  /** adresa, adrR */
  address: string;
  /** telefon, telR */
  phone?: string;
  /** fax, faxR */
  fax?: string;
  /** mail, emailR */
  email?: string;
};

export type D100 = {
  /** luna, an: the month the obligations belong to; for a quarter, its last month. */
  period: { year: number; month: number };
  /** d_anulare 1 and temei 2: filed or corrected after the reserve of subsequent verification was
   * cancelled, under art. 105 alin. (6) lit. b) Cod procedură fiscală (final court decisions
   * establishing income owed to beneficiaries); otherwise d_anulare 0. */
  afterReserveCancellation: boolean;
  /** d_dizolv: a legal person dissolving, with or without liquidation. */
  dissolution: boolean;
  /** d_succ 1 and cifS: filed by the successor under art. 90 alin. (4) Cod procedură fiscală. */
  successorCui?: string;
  declarant: {
    /** nume_declar */
    lastName: string;
    /** prenume_declar */
    firstName: string;
    /** functie_declar */
    role: string;
  };
  /** Section A, the taxpayer or payer: cui (a CUI without the RO prefix, or a CNP) and den. */
  payer: D100Contact & { cui: string; name: string };
  /** Section C, the empowered representative: cifR and denR. */
  representative?: Partial<D100Contact> & { cui: string; name?: string };
  /** One line each; excise duties (codes 2xx) may repeat with different due dates. */
  obligations: D100Obligation[];
};

export type D100Line = {
  /** cod_oblig */
  code: string;
  /** cod_bugetar */
  budgetCode: string;
  /** scadenta, YYYY-MM-DD */
  dueDate: string;
  /** nr_evid */
  paymentNumber: string;
  /** suma_dat, suma_ded, suma_plata, suma_rest */
  due: bigint;
  deductible: bigint;
  payable: bigint;
  refund: bigint;
  /** suma_redu, written for 121 when given. */
  reduction?: bigint;
  /** cota: 1 for 121. */
  rate?: '1';
  /** bifa_impozit_minim */
  minimumTax: boolean;
};

export type D100Calculation = {
  namespace: string;
  /** The obligations in the model's order. */
  lines: D100Line[];
  /** totalPlata_A: suma_dat + suma_ded + suma_plata + suma_rest + suma_redu over every line. */
  controlSum: bigint;
};

const maxAmount = 999_999_999_999_999n; // N(15)
const maxLines = 1300;
// Dedicated kinds, and obligations whose header fields this module does not write.
const reservedCodes: Readonly<Record<string, string>> = {
  '121': 'se declară ca impozit pe veniturile microîntreprinderilor (kind micro)',
  '150': 'se declară ca impozit pe dividende (kind dividends)',
  '604': 'se declară ca impozit pe dividende (kind dividends)',
  '605': 'se declară ca impozit pe dobânzi (kind interest)',
  '131': 'cere data încheierii exercițiului financiar (Data_I), pe care modulul nu o scrie',
  '132': 'cere data încheierii exercițiului financiar (Data_I), pe care modulul nu o scrie',
  '701': 'cere Data_IC și bifele d_nInf, d_bonif, pe care modulul nu le scrie',
};

const periodIndex = (year: number, month: number) => year * 12 + month - 1;
const firstPeriod = periodIndex(2026, 1);
const lastPeriod = periodIndex(2100, 12);

function isPeriod(period: D100['period']): boolean {
  if (!Number.isInteger(period.year) || !Number.isInteger(period.month)) return false;
  if (period.month < 1 || period.month > 12) return false;
  const index = periodIndex(period.year, period.month);
  return index >= firstPeriod && index <= lastPeriod;
}

const periodMessage =
  'Declarația D100 se depune aici pentru perioade de raportare din ianuarie 2026 încolo.';

/** The structure's namespace for a reporting period from 01/2026. */
export function d100Namespace(period: D100['period']): string {
  if (!isPeriod(period)) throw new DomainError('D100_PERIOD', periodMessage);
  return 'mfp:anaf:dgti:d100:declaratie:v2';
}

const pad = (value: number) => String(value).padStart(2, '0');

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
 * nr_evid, the payment evidence number (structure field 16): "10", the obligation code, "01", the
 * period's month and year (LLAA), the due date (ZZLLAA), "0000", and the sum of the 21 digits
 * before it, two digits.
 */
export function d100PaymentNumber(code: string, period: D100['period'], dueDate: string): string {
  const [year, month, day] = dueDate.split('-') as [string, string, string];
  const body = `10${code}01${pad(period.month)}${pad(period.year % 100)}${day}${month}${year.slice(2)}0000`;
  const sum = [...body].reduce((total, digit) => total + Number(digit), 0);
  return `${body}${pad(sum % 100)}`;
}

/** 25LU: the 25th of the month after the period. */
function nextMonth25({ year, month }: D100['period']): string {
  return month === 12 ? `${year + 1}-01-25` : `${year}-${pad(month + 1)}-25`;
}

type Problem = { code: string; path: string; message: string };

const isAmount = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 999_999_999_999_999;

/** The inputs calculateD100 cannot use: amounts, codes, dates, and fields the period refuses. */
function inputProblems(model: D100): Problem[] {
  const problems: Problem[] = [];
  const problem = (code: string, path: string, message: string) =>
    problems.push({ code, path, message });
  const amount = (path: string, value: unknown, label: string) => {
    if (!isAmount(value))
      problem(
        'D100_AMOUNT',
        path,
        `${label}: o sumă în lei, fără zecimale, nenegativă, de cel mult 15 cifre.`,
      );
  };
  if (model.obligations.length === 0)
    problem('D100_OBLIGATIONS', 'obligations', 'Declarația cuprinde cel puțin o obligație.');
  if (model.obligations.length > maxLines)
    problem(
      'D100_OBLIGATIONS',
      'obligations',
      `Declarația cuprinde cel mult ${maxLines} de obligații.`,
    );
  const december = model.period.month === 12;
  model.obligations.forEach((obligation, index) => {
    const path = `obligations.${index}`;
    switch (obligation.kind) {
      case 'micro':
        amount(`${path}.base`, obligation.base, 'Baza impozabilă');
        if (obligation.deductible !== undefined)
          amount(`${path}.deductible`, obligation.deductible, 'Suma deductibilă');
        if (obligation.reduction !== undefined)
          amount(`${path}.reduction`, obligation.reduction, 'Reducerea de impozit');
        if (december && !['january', 'june'].includes(obligation.fourthQuarterDue ?? ''))
          problem(
            'D100_DUE_DATE',
            `${path}.fourthQuarterDue`,
            'Pentru trimestrul IV alegeți scadența: 25 ianuarie (structura ANAF) sau 25 iunie (validatorul ANAF) a anului următor.',
          );
        if (!december && obligation.fourthQuarterDue !== undefined)
          problem(
            'D100_DUE_DATE',
            `${path}.fourthQuarterDue`,
            'Scadența trimestrului IV se alege doar în declarația lunii decembrie.',
          );
        return;
      case 'dividends':
        if (!['individual', 'company'].includes(obligation.beneficiary))
          problem(
            'D100_BENEFICIARY',
            `${path}.beneficiary`,
            'Beneficiarul dividendelor este o persoană fizică sau o persoană juridică română.',
          );
        amount(`${path}.withheld`, obligation.withheld, 'Impozitul reținut');
        if (obligation.unpaidAtYearEnd !== undefined) {
          amount(
            `${path}.unpaidAtYearEnd`,
            obligation.unpaidAtYearEnd,
            'Impozitul pe dividendele neplătite',
          );
          if (!december)
            problem(
              'D100_YEAR_END',
              `${path}.unpaidAtYearEnd`,
              'Impozitul pe dividendele distribuite și neplătite până la sfârșitul anului se declară în declarația lunii decembrie, cu scadența 25 ianuarie.',
            );
        }
        return;
      case 'interest':
        amount(`${path}.withheld`, obligation.withheld, 'Impozitul reținut');
        return;
      case 'other':
        if (!/^[1-9]\d{2}$/.test(obligation.code))
          problem('D100_CODE', `${path}.code`, 'Codul obligației are trei cifre.');
        else if (reservedCodes[obligation.code])
          problem(
            'D100_CODE',
            `${path}.code`,
            `Obligația ${obligation.code} ${reservedCodes[obligation.code]}.`,
          );
        if (!/^[0-9A-Z]{1,10}$/.test(obligation.budgetCode))
          problem(
            'D100_BUDGET_CODE',
            `${path}.budgetCode`,
            'Codul bugetar are cel mult 10 caractere, cifre și majuscule.',
          );
        if (!isDate(obligation.dueDate))
          problem('D100_DUE_DATE', `${path}.dueDate`, 'Scadența se scrie în forma AAAA-LL-ZZ.');
        for (const [key, label] of [
          ['due', 'Suma datorată'],
          ['deductible', 'Suma deductibilă'],
          ['payable', 'Suma de plată'],
          ['refund', 'Suma de restituit'],
        ] as const)
          amount(`${path}.${key}`, obligation[key], label);
        return;
      default:
        problem(
          'D100_KIND',
          path,
          'Obligația este impozitul microîntreprinderii, impozitul pe dividende, impozitul pe dobânzi sau altă obligație din nomenclator.',
        );
    }
  });
  return problems;
}

const big = (value: number | undefined) => BigInt(value ?? 0);
const positive = (value: bigint) => (value > 0n ? value : 0n);

function line(model: D100, obligation: D100Obligation): D100Line {
  const { period } = model;
  const dated = (code: string, dueDate: string) => ({
    code,
    dueDate,
    paymentNumber: d100PaymentNumber(code, period, dueDate),
  });
  switch (obligation.kind) {
    case 'micro': {
      // Model 9#: suma_plata = suma_dat − suma_ded − suma_redu, at least 0; suma_rest 0.
      const due = (big(obligation.base) + 50n) / 100n;
      const deductible = big(obligation.deductible);
      const reduction = obligation.reduction === undefined ? undefined : big(obligation.reduction);
      const dueDate =
        obligation.fourthQuarterDue === 'june' ? `${period.year + 1}-06-25` : nextMonth25(period);
      return {
        ...dated('121', dueDate),
        budgetCode: '5503XXXXXX',
        due,
        deductible,
        payable: positive(due - deductible - (reduction ?? 0n)),
        refund: 0n,
        ...(reduction === undefined ? {} : { reduction }),
        rate: '1',
        minimumTax: false,
      };
    }
    case 'dividends': {
      // Model 1#: suma_plata = suma_dat.
      const due = big(obligation.withheld) + big(obligation.unpaidAtYearEnd);
      const code = obligation.beneficiary === 'individual' ? '604' : '150';
      return {
        ...dated(code, nextMonth25(period)),
        budgetCode: '5503XXXXXX',
        due,
        deductible: 0n,
        payable: due,
        refund: 0n,
        minimumTax: false,
      };
    }
    case 'interest': {
      // Model 1#: suma_plata = suma_dat.
      const due = big(obligation.withheld);
      return {
        ...dated('605', nextMonth25(period)),
        budgetCode: '5503XXXXXX',
        due,
        deductible: 0n,
        payable: due,
        refund: 0n,
        minimumTax: false,
      };
    }
    case 'other':
      return {
        ...dated(obligation.code, obligation.dueDate),
        budgetCode: obligation.budgetCode.padEnd(10, 'X'),
        due: big(obligation.due),
        deductible: big(obligation.deductible),
        payable: big(obligation.payable),
        refund: big(obligation.refund),
        minimumTax: obligation.minimumTax ?? false,
      };
  }
}

/**
 * The structure's derived fields of a declaration: per line the code, budget code, due date,
 * nr_evid, cota and the amounts of its model of completion; and totalPlata_A. Throws when an
 * input is not one the declaration accepts; checkD100 lists those without throwing.
 */
export function calculateD100(model: D100): D100Calculation {
  const namespace = d100Namespace(model.period);
  const [problem] = inputProblems(model);
  if (problem) throw new DomainError(problem.code, problem.message);
  const lines = model.obligations.map((obligation) => line(model, obligation));
  const controlSum = lines.reduce(
    (total, item) =>
      total + item.due + item.deductible + item.payable + item.refund + (item.reduction ?? 0n),
    0n,
  );
  return { namespace, lines, controlSum };
}

const flag = (value: boolean) => (value ? '1' : '0');
const text = (value: bigint) => value.toString();
const optional = (value: string | undefined) => (value?.trim() ? value : undefined);

/** YYYY-MM-DD as the structure's dd.mm.yyyy. */
const structureDate = (date: string) => date.split('-').reverse().join('.');

/**
 * Writes the declaration as one `declaratie100` element with an `obligatie` per line, attributes
 * in the structure's order. Due dates, nr_evid, cota, the payable and refundable amounts of the
 * dedicated lines and totalPlata_A are computed; blank optional texts are left out.
 */
export function writeD100(model: D100): string {
  const calculation = calculateD100(model);
  const { declarant, payer, representative: agent } = model;
  return serializeXml(
    element(
      'declaratie100',
      {
        xmlns: calculation.namespace,
        'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
        'xsi:schemaLocation': `${calculation.namespace} D100.xsd`,
        luna: String(model.period.month),
        an: String(model.period.year),
        d_anulare: flag(model.afterReserveCancellation),
        temei: model.afterReserveCancellation ? '2' : undefined,
        d_succ: flag(model.successorCui !== undefined),
        cifS: model.successorCui,
        d_dizolv: flag(model.dissolution),
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
        cifR: agent?.cui,
        denR: optional(agent?.name),
        adrR: optional(agent?.address),
        telR: optional(agent?.phone),
        faxR: optional(agent?.fax),
        emailR: optional(agent?.email),
      },
      calculation.lines.map((item) =>
        element('obligatie', {
          cod_oblig: item.code,
          cod_bugetar: item.budgetCode,
          scadenta: structureDate(item.dueDate),
          nr_evid: item.paymentNumber,
          suma_dat: text(item.due),
          suma_ded: text(item.deductible),
          suma_plata: text(item.payable),
          suma_rest: text(item.refund),
          cota: item.rate,
          suma_redu: item.reduction === undefined ? undefined : text(item.reduction),
          bifa_impozit_minim: flag(item.minimumTax),
        }),
      ),
    ),
  );
}

export type D100Check = {
  code: string;
  /** error: ANAF rejects the declaration (E:) or the structure forbids the value; warning: it is
   * accepted, with a notice (A:) or with a value the structure's own formula would not give. */
  severity: 'error' | 'warning';
  path: string;
  message: string;
};

const isCui = (code: string) => /^[1-9]\d{1,9}$/.test(code) && isValidCui(code);
const isCuiOrCnp = (code: string) =>
  isCui(code) || (/^[1-9]\d{12}$/.test(code) && isValidCnp(code));
const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

/**
 * Fast feedback on the structure's validations for the lines written here, as ANAF's validator
 * applies them, in Romanian. The official validator (DUKIntegrator) remains the oracle; it also
 * checks other obligations against the nomenclature: codes, budget codes, due dates, periodicity
 * and models of completion.
 */
export function checkD100(model: D100): D100Check[] {
  const checks: D100Check[] = [];
  const add = (severity: D100Check['severity'], code: string, path: string, message: string) =>
    checks.push({ code, severity, path, message });
  const error = (code: string, path: string, message: string) => add('error', code, path, message);
  const warning = (code: string, path: string, message: string) =>
    add('warning', code, path, message);
  const textField = (
    path: string,
    value: string | undefined,
    label: string,
    max: number,
    required = false,
  ) => {
    const trimmed = value?.trim();
    if (!trimmed) {
      if (required) error('D100_TEXT', path, `Completați ${label}.`);
    } else if (trimmed.length > max)
      error('D100_TEXT', path, `Câmpul ${label} are cel mult ${max} caractere.`);
  };
  const contact = (group: 'payer' | 'representative', of: string, required: boolean) => {
    const value = model[group];
    textField(`${group}.address`, value?.address, `adresa ${of}`, 1000, required);
    textField(`${group}.phone`, value?.phone, `telefonul ${of}`, 15);
    textField(`${group}.fax`, value?.fax, `faxul ${of}`, 15);
    textField(`${group}.email`, value?.email, `e-mailul ${of}`, 200);
    if (value?.email?.trim() && !isEmail(value.email))
      warning('D100_EMAIL', `${group}.email`, `E-mailul ${of} nu este valid.`);
  };
  const { period, declarant, payer, representative } = model;
  const validPeriod = isPeriod(period);
  if (!validPeriod) error('D100_PERIOD', 'period', periodMessage);

  textField('declarant.lastName', declarant.lastName, 'numele declarantului', 75, true);
  textField('declarant.firstName', declarant.firstName, 'prenumele declarantului', 75, true);
  textField('declarant.role', declarant.role, 'funcția declarantului', 50, true);
  if (!isCuiOrCnp(payer.cui))
    error(
      'D100_CUI',
      'payer.cui',
      'Codul de identificare fiscală nu este valid; se scrie fără prefixul RO.',
    );
  if (model.successorCui !== undefined && !isCuiOrCnp(model.successorCui))
    error(
      'D100_CUI',
      'successorCui',
      'Codul de identificare fiscală al succesorului nu este valid.',
    );
  textField('payer.name', payer.name, 'denumirea', 200, true);
  contact('payer', 'plătitorului', true);
  if (representative) {
    if (!isCuiOrCnp(representative.cui))
      error(
        'D100_CUI',
        'representative.cui',
        'Codul de identificare fiscală al împuternicitului nu este valid.',
      );
    textField('representative.name', representative.name, 'denumirea împuternicitului', 200);
    contact('representative', 'împuternicitului', false);
  }

  const problems = inputProblems(model);
  for (const problem of problems) error(problem.code, problem.path, problem.message);
  const invalid = new Set(problems.map((problem) => problem.path.split('.').slice(0, 2).join('.')));

  // R13, R15.1: a quarterly obligation in a quarter's last month, unless the company dissolves.
  model.obligations.forEach((obligation, index) => {
    const path = `obligations.${index}`;
    if (obligation.kind !== 'micro' || invalid.has(path) || !validPeriod) return;
    if (!model.dissolution && period.month % 3 !== 0)
      error(
        'D100_QUARTER',
        path,
        'Impozitul pe veniturile microîntreprinderilor se declară pentru ultima lună a trimestrului (martie, iunie, septembrie, decembrie), în afara dizolvării.',
      );
    if (period.month === 12)
      warning(
        'D100_FOURTH_QUARTER',
        `${path}.fourthQuarterDue`,
        'Pentru trimestrul IV, structura ANAF stabilește din 2026 scadența de 25 ianuarie, iar validatorul ANAF cere 25 iunie a anului următor: confirmați scadența aleasă.',
      );
  });
  if (problems.length || !validPeriod) return checks;

  const { lines, controlSum } = calculateD100(model);
  // R15, R15.2: one line per code; excise duties once per due date.
  const seen = new Set<string>();
  lines.forEach((item, index) => {
    const excise = item.code.startsWith('2');
    const key = excise ? `${item.code} ${item.dueDate}` : item.code;
    if (seen.has(key))
      error(
        'D100_DUPLICATE',
        `obligations.${index}`,
        excise
          ? `Acciza ${item.code} se declară o singură dată pentru o scadență.`
          : `Obligația ${item.code} se declară o singură dată în declarație.`,
      );
    seen.add(key);
  });
  model.obligations.forEach((obligation, index) => {
    if (obligation.kind !== 'micro') return;
    const item = lines[index]!;
    const path = `obligations.${index}`;
    // Model 9#: 0 ≤ suma_redu ≤ suma_dat, at most 15% of it from 2022; suma_plata ≥ 0.
    if (item.reduction !== undefined && item.reduction * 100n > item.due * 15n)
      warning(
        'D100_REDUCTION',
        `${path}.reduction`,
        `Reducerea de impozit (${item.reduction}) depășește 15% din impozitul datorat (${item.due}).`,
      );
    else if (item.deductible + (item.reduction ?? 0n) > item.due)
      warning(
        'D100_DEDUCTIBLE',
        `${path}.deductible`,
        `Suma deductibilă și reducerea depășesc impozitul datorat (${item.due}); suma de plată nu poate fi negativă.`,
      );
  });
  if (controlSum > maxAmount || lines.some((item) => item.due > maxAmount))
    error('D100_TOTAL', 'obligations', 'Un total al declarației depășește 15 cifre.');
  return checks;
}
