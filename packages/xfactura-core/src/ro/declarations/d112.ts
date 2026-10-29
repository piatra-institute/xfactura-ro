import { DomainError } from '../../errors';
import { element, serializeXml } from '../../xml/write';
import { counties } from '../geo';
import { isValidCnp, isValidCui } from '../identifiers';
import { minimumExemptions, type MinimumExemption } from '../payroll/calculate';

/**
 * The monthly return of social contributions, income tax and the nominal record of insured
 * persons (D112, "Declarația privind obligațiile de plată a contribuțiilor sociale, impozitului pe
 * venit și evidența nominală a persoanelor asigurate") for reporting months 07/2026–12/2026, after
 * ANAF's XML structure D112_A7.2.6 v7 of 07.09.2026 (structura_D112_0726_070926).
 *
 * The structure's parameters are those of 07–12/2026: the minimum wage of 4325 lei, the 200 lei
 * OUG 89/2025 leaves out of the bases, and the working days (NZL) of 2026. Earlier months have their
 * own structures (4050 lei, 300 lei); ANAF's validator (DUKIntegrator, D112Validator J27.0.7 of
 * 09.10.2026) applies this one's table to months after 12/2026 too, for which none is published.
 * Where the XSD of 14.08.2026 and the validator differ, this module follows the validator: the
 * XSD types A_1, A_sal1 and A_sal2 as 1–30, lacks obligations 458 and 459, and allows asigExc only
 * 0–1.
 *
 * Covered: an employer owing CAM (datCAM 1), with no secondary establishments, whose insured are
 * employees under an individual employment contract (Nomenclator 5 types 1 and 51), at their main
 * job or elsewhere, in normal working conditions and without medical leave in the month: section A
 * of each insured person, with E1 or E2 and one E3. The structure lets the rest be absent: the
 * insured's sections B and D (several contracts, special or particular conditions, medical leave),
 * C (other categories), det1 (seconded employees) and E4 (redirected tax); the employer's C2, C3,
 * C5, D, E1–E4 (medical leave, work accidents, unemployment fund, construction), F1–F2 (secondary
 * establishments) and G; non-residents and exemptions from income tax (asigScu).
 *
 * The minimum-wage relief is A_13S of insured type 51, with A_13C = A_13 + A_13S; C1_11 adds it
 * back. Meal and holiday vouchers are in the gross income E3_8 (E3_60, E3_10, E3_75), A_sal2 and
 * the CASS base A_11, not in the CAS (A_13) or CAM (A_5) bases.
 *
 * Amounts are whole lei, N(15), never negative. Contributions are rounded arithmetically, a
 * nonzero amount below one leu becoming one leu.
 */

export const d112InsuredTypes = [
  ['1', 'Salariat (exclusiv 1.1)'],
  [
    '51',
    'Salariat (are CIM cu normă întreagă), beneficiar al măsurii „200 de lei din salariul minim, sumă netaxabilă” cf. OUG nr. 89/2025',
  ],
] as const;
/** A_1, E3_2: the Nomenclator 5 types covered. */
export type D112InsuredType = (typeof d112InsuredTypes)[number][0];

/** A_3, Nomenclator 12: N full time, Pn part time of n hours a day. */
export const d112ContractTypes = ['N', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'] as const;
export type D112ContractType = (typeof d112ContractTypes)[number];

/** tip_rec, the reason a declaration is filed. */
export const d112Reasons = [
  [
    '2',
    'Declarație depusă ca urmare a acordării unor drepturi bănești stabilite prin lege sau în baza unor hotărâri judecătorești definitive și irevocabile/definitive și executorii, ori prin care s-a dispus reîncadrarea în muncă, potrivit art. 147 alin. (3) și (3^1) și art. 169 alin. (3) și (3^2) din Codul fiscal',
  ],
  [
    '3',
    'Declarație depusă ca urmare a unei inspecții fiscale sau a stabilirii obligațiilor fiscale din oficiu',
  ],
  [
    '4',
    'Declarație depusă după anularea rezervei verificării ulterioare, art. 105 alin. (6) lit. a) din Codul de procedură fiscală',
  ],
  [
    '5',
    'Declarație depusă după anularea rezervei verificării ulterioare, art. 105 alin. (6) lit. b) din Codul de procedură fiscală',
  ],
  [
    '7',
    'Declarație depusă ca urmare a acordării cumulat de sume potrivit art. 146 alin. (10) și (11) din Codul fiscal',
  ],
  [
    '8',
    'Declarație depusă ca urmare a unor hotărâri judecătorești prin care s-a dispus reîncadrarea activității în condiții deosebite sau speciale de muncă pentru perioade anterioare, potrivit art. 147 alin. (3^2) din Codul fiscal',
  ],
  ['9', 'Declarație depusă ca urmare a unei notificări de conformare'],
] as const;
export type D112Reason = (typeof d112Reasons)[number][0];

/** The obligations (Nomenclator 3) this module computes, in the form's order: code, budget code
 * (A_codBugetar) and label. */
export const d112Obligations = [
  ['602', '5503XXXXXX', 'Impozit pe veniturile din salarii și asimilate salariilor'],
  ['412', '5503XXXXXX', 'CAS datorată de asigurați'],
  ['432', '5503XXXXXX', 'CASS datorată de asigurați'],
  ['480', '20470300XX', 'Contribuția asiguratorie pentru muncă (CAM)'],
  [
    '458',
    '5503XXXXXX',
    'CAS suportată de angajator/plătitorul de venit (art. 146 alin. (5^9) din Codul fiscal)',
  ],
  [
    '459',
    '5503XXXXXX',
    'CASS suportată de angajator/plătitorul de venit (art. 168 alin. (6^1) din Codul fiscal)',
  ],
] as const;
export type D112ObligationCode = (typeof d112Obligations)[number][0];

/**
 * casaAng, casaSn (Nomenclator 2): a county health insurance house by its ISO 3166-2:RO code
 * (RO-GL, RO-B), or OPSNAJ, the house of the defence, public order, national security and judicial
 * authority sector, which insures some employees and no employer.
 */
export type D112HealthFund = `RO-${string}` | 'OPSNAJ';

export type D112Minimum =
  /** asigExc 1, with motivExc: the minimum contribution does not apply (art. 146 alin. (5^7)). */
  | { kind: 'exempt'; reason: MinimumExemption }
  /** asigExc 2: CAS and CASS are due at least on `base`, the limit sum (rd. 8.1, 9.1) of art. 146
   * alin. (5^6) and art. 168 alin. (6^1) Cod fiscal, the difference borne by the employer. The
   * structure computes it as (4325 − 200) × A_8 / NZL rounded; ANAF's validator accepts any value
   * from round(4125 × A_8 / NZL) − 1 up, so it is an input, checked against the structure. */
  | { kind: 'due'; base: number };

export type D112Insured = {
  /** cnpAsig */
  cnp: string;
  /** numeAsig */
  lastName: string;
  /** prenAsig */
  firstName: string;
  /** dataAng: the date the person became insured with the employer, YYYY-MM-DD. */
  from: string;
  /** dataSf: the date the person stopped being insured, within or before the period. */
  until?: string;
  /** casaSn */
  healthFund: D112HealthFund;
  /** asigCI: insured for medical leave and benefits (concedii și indemnizații). */
  sickLeaveInsured: boolean;
  /** asigSO: insured in the unemployment insurance system. */
  unemploymentInsured: boolean;
  /** asigExc, motivExc; absent when the CAS base reaches the minimum wage for the days worked. */
  minimum?: D112Minimum;
  /** asiguratA */
  employment: {
    /** A_1 */
    type: D112InsuredType;
    /** A_2 */
    pensioner: boolean;
    /** A_3 */
    contract: D112ContractType;
    /** A_4: the daily norm of the workplace, 6, 7 or 8 hours. */
    normHours: number;
    /** A_sal1: the monthly gross base salary of the contract. */
    baseSalary: number;
    /** A_6: hours actually worked in the month. */
    hoursWorked: number;
    /** A_7: hours the contract was suspended in the month. */
    hoursSuspended: number;
    /** A_8: days worked. */
    daysWorked: number;
    /** A_9: the base for the unemployment benefit; the structure gives no formula. */
    unemploymentBase: number;
    /** A_5: the CAM base. */
    camBase: number;
    /** A_11: the CASS base, vouchers included. */
    cassBase: number;
    /** A_12: CASS withheld. */
    cass: number;
    /** A_13: the CAS base, without vouchers. */
    casBase: number;
    /** A_14: CAS withheld. */
    cas: number;
    /** A_13S: the minimum-wage amount left out of the bases (OUG 89/2025), type 51 only. */
    relief: number;
  };
  /** asiguratE3, and E1 or E2 */
  income: {
    /** E3_3: 1 at the main job (funcția de bază), 2 elsewhere. */
    mainJob: boolean;
    /** The salary paid in money; E3_8 adds the vouchers. */
    cash: number;
    /** E3_10: meal vouchers, within E3_60. */
    mealVouchers: number;
    /** E3_75: holiday vouchers, within E3_60. */
    holidayVouchers: number;
    /** E3_11: dependents, main job only. */
    dependents: number;
    /** E3_121, E3_1221, E3_1222: the basic personal deduction and the supplementary ones of art. 77
     * alin. (10) lit. a) (under 26) and lit. b) (children in school), main job only; whole lei,
     * rounded arithmetically. */
    deduction: { basic: number; young: number; children: number };
    /** E3_13: other deductions (union dues, voluntary pension and health contributions). */
    otherDeductions: number;
    /** E3_14 */
    taxBase: number;
    /** E3_15 */
    tax: number;
    /** E3_16: the amount paid to the person. */
    paid: number;
  };
};

export type D112 = {
  /** luna_r, an_r */
  period: { year: number; month: number };
  /** d_rec: corrects the declaration already filed for the period. */
  correction: boolean;
  /** tip_rec */
  reason?: D112Reason;
  declarant: {
    /** nume_declar */
    lastName: string;
    /** prenume_declar */
    firstName: string;
    /** functie_declar */
    role: string;
  };
  employer: {
    /** cif: digits only, without the RO prefix. */
    cui: string;
    /** cifS: the successor, for a declaration filed under art. 90 alin. (4) Cod procedură fiscală. */
    successorCui?: string;
    /** rgCom */
    tradeRegister?: string;
    /** caen: a class of Nomenclator 1. */
    caen: string;
    /** den */
    name: string;
    /** adrSoc, telSoc, faxSoc, mailSoc */
    registeredOffice: { address: string; phone?: string; fax?: string; email?: string };
    /** adrFisc, telFisc, faxFisc, mailFisc */
    fiscalDomicile?: { address?: string; phone?: string; fax?: string; email?: string };
    /** casaAng */
    healthFund: D112HealthFund;
  };
  insured: D112Insured[];
};

/** The structure's computed fields of one insured person. */
export type D112InsuredCalculation = {
  /** idAsig */
  id: number;
  /** E3_8, A_sal2: income in money and vouchers. */
  income: bigint;
  /** E3_60: the vouchers. */
  benefits: bigint;
  /** A_13C: the CAS base plus the amount left out, for type 51. */
  reliefIncome: bigint;
  /** A_13P, A_14P, A_11P, A_12P: the limit sums and the contributions due on them. */
  limit: { casBase: bigint; cas: bigint; cassBase: bigint; cass: bigint };
  /** A_14D, A_12D: the difference borne by the employer. */
  employer: { cas: bigint; cass: bigint };
  /** E3_9: CAS and CASS withheld. */
  contributions: bigint;
  /** E3_12, E3_122 */
  deduction: { total: bigint; supplementary: bigint };
  /** Timp_E3 */
  tax: bigint;
};

export type D112Obligation = {
  code: D112ObligationCode;
  budgetCode: string;
  /** A_datorat, A_deductibil, A_scutit, A_plata */
  owed: bigint;
  deductible: bigint;
  exempt: bigint;
  payable: bigint;
};

export type D112Calculation = {
  namespace: string;
  /** NZL: the working days of the month. */
  workingDays: number;
  insured: D112InsuredCalculation[];
  /** angajatorA: every obligation with an amount, or the income tax alone when none has. */
  obligations: D112Obligation[];
  /** angajatorB */
  counts: {
    /** B_cnp: insured for unemployment. */
    unemployment: number;
    /** B_sanatate: insured for medical leave and benefits. */
    sickLeave: number;
    /** B_pensie: insured owing CAS. */
    pension: number;
    /** B_sal: employees. */
    employees: number;
  };
  /** B_brutSalarii: the CASS bases of those insured for medical leave. */
  grossSalaries: bigint;
  /** C1_11, C1_T1: income in normal working conditions. */
  normalIncome: bigint;
  /** C4_baza, C4_ct */
  cam: { base: bigint; amount: bigint };
  /** totalPlata_A */
  controlSum: bigint;
};

const maxAmount = 999_999_999_999_999n; // N(15)
// Structure parameters for 07–12/2026: salMin, Suma200 (OUG 89/2025), pCAM, Cipens, Cisan.
const minimumWage = 4325n;
const reliefLimit = 200n;
const camRate = 225n; // basis points
const casRate = 2500n;
const cassRate = 1000n;
/** NZL of the months covered, as the structure and the validator count them. */
const workingDaysByMonth: Readonly<Record<number, number>> = {
  7: 23,
  8: 21,
  9: 22,
  10: 22,
  11: 20,
  12: 21,
};

const periodIndex = (year: number, month: number) => year * 12 + month - 1;
const firstPeriod = periodIndex(2026, 7);
const lastPeriod = periodIndex(2026, 12);

function isPeriod(period: D112['period']): boolean {
  if (!Number.isInteger(period.year) || !Number.isInteger(period.month)) return false;
  if (period.month < 1 || period.month > 12) return false;
  const index = periodIndex(period.year, period.month);
  return index >= firstPeriod && index <= lastPeriod;
}

const periodMessage =
  'Declarația D112 în această structură se depune pentru lunile iulie–decembrie 2026.';

/** The structure's namespace for a reporting month of 07/2026–12/2026. */
export function d112Namespace(period: D112['period']): string {
  if (!isPeriod(period)) throw new DomainError('D112_PERIOD', periodMessage);
  return 'mfp:anaf:dgti:declaratie_unica:declaratie:v7';
}

/** casaAng/casaSn for a health fund, or undefined when it is not in Nomenclator 2. */
function healthFundCode(fund: string): string | undefined {
  if (fund === 'OPSNAJ') return '_A';
  if (!counties[fund]) return undefined;
  return fund === 'RO-B' ? '_B' : fund.slice(3);
}

/** amount × basis points / 10000, rounded half up; a nonzero amount below one leu is one leu. */
function contribution(base: bigint, rate: bigint): bigint {
  const product = base * rate;
  const whole = product / 10_000n;
  const rounded = 2n * (product % 10_000n) >= 10_000n ? whole + 1n : whole;
  return rounded === 0n && product > 0n ? 1n : rounded;
}

/** The structure's limit sum: (salMin − Suma200) × A_8 / NZL, rounded; the validator truncates. */
function structureLimit(daysWorked: number, workingDays: number) {
  const product = (minimumWage - reliefLimit) * BigInt(daysWorked);
  const days = BigInt(workingDays);
  const floor = product / days;
  return { rounded: 2n * (product % days) >= days ? floor + 1n : floor, floor };
}

const contractHours = (contract: D112ContractType, normHours: number) =>
  contract === 'N' ? normHours : Number(contract.slice(1));

type Problem = { code: string; path: string; message: string };

const isAmount = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 999_999_999_999_999;

/** The inputs calculateD112 cannot use: amounts, counts and nomenclature codes. */
function inputProblems(model: D112): Problem[] {
  const problems: Problem[] = [];
  const amount = (path: string, value: unknown, label: string) => {
    if (!isAmount(value))
      problems.push({
        code: 'D112_AMOUNT',
        path,
        message: `${label}: o sumă în lei, fără zecimale, nenegativă, de cel mult 15 cifre.`,
      });
  };
  const count = (path: string, value: unknown, label: string, max: number) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max)
      problems.push({
        code: 'D112_COUNT',
        path,
        message: `${label} este un număr natural de cel mult ${max}.`,
      });
  };
  model.insured.forEach((insured, index) => {
    const path = `insured.${index}`;
    const { employment: work, income, minimum } = insured;
    if (!d112InsuredTypes.some(([type]) => type === work.type))
      problems.push({
        code: 'D112_TYPE',
        path: `${path}.employment.type`,
        message: `Tipul de asigurat ${work.type} nu este acoperit; se declară salariați cu contract individual de muncă (tipurile 1 și 51).`,
      });
    if (!(d112ContractTypes as readonly string[]).includes(work.contract))
      problems.push({
        code: 'D112_CONTRACT',
        path: `${path}.employment.contract`,
        message: `Tipul de contract ${work.contract} nu există în Nomenclatorul 12.`,
      });
    if (![6, 7, 8].includes(work.normHours))
      problems.push({
        code: 'D112_CONTRACT',
        path: `${path}.employment.normHours`,
        message: 'Norma zilnică a locului de muncă este de 6, 7 sau 8 ore.',
      });
    count(`${path}.employment.hoursWorked`, work.hoursWorked, 'Numărul orelor lucrate', 999);
    count(
      `${path}.employment.hoursSuspended`,
      work.hoursSuspended,
      'Numărul orelor suspendate',
      999,
    );
    count(`${path}.employment.daysWorked`, work.daysWorked, 'Numărul zilelor lucrate', 99);
    for (const [key, label] of [
      ['baseSalary', 'Salariul de bază'],
      ['unemploymentBase', 'Baza indemnizației de șomaj'],
      ['camBase', 'Baza CAM'],
      ['cassBase', 'Baza CASS'],
      ['cass', 'CASS'],
      ['casBase', 'Baza CAS'],
      ['cas', 'CAS'],
      ['relief', 'Suma neimpozabilă'],
    ] as const)
      amount(`${path}.employment.${key}`, work[key], label);
    for (const [key, label] of [
      ['cash', 'Venitul în bani'],
      ['mealVouchers', 'Valoarea tichetelor de masă'],
      ['holidayVouchers', 'Valoarea voucherelor de vacanță'],
      ['otherDeductions', 'Alte deduceri'],
      ['taxBase', 'Baza de calcul a impozitului'],
      ['tax', 'Impozitul'],
      ['paid', 'Suma încasată'],
    ] as const)
      amount(`${path}.income.${key}`, income[key], label);
    for (const key of ['basic', 'young', 'children'] as const)
      amount(`${path}.income.deduction.${key}`, income.deduction[key], 'Deducerea personală');
    count(`${path}.income.dependents`, income.dependents, 'Numărul persoanelor în întreținere', 99);
    if (!minimum) return;
    if (minimum.kind === 'due')
      amount(`${path}.minimum.base`, minimum.base, 'Suma limită de calcul');
    else if (minimum.kind !== 'exempt' || !minimumExemptions.includes(minimum.reason))
      problems.push({
        code: 'D112_MINIMUM',
        path: `${path}.minimum`,
        message:
          'Excepția de la contribuția minimă are unul dintre motivele art. 146 alin. (5^7) Cod fiscal.',
      });
  });
  return problems;
}

const sum = <T>(items: readonly T[], value: (item: T) => bigint) =>
  items.reduce((total, item) => total + value(item), 0n);
const big = (value: number) => BigInt(value);

function insuredCalculation(insured: D112Insured, index: number): D112InsuredCalculation {
  const { employment: work, income, minimum } = insured;
  const benefits = big(income.mealVouchers) + big(income.holidayVouchers);
  let limit = { casBase: 0n, cas: 0n, cassBase: 0n, cass: 0n };
  if (minimum?.kind === 'due') {
    const base = big(minimum.base);
    const casBase = big(work.casBase) < base ? base : 0n;
    const cassBase = big(work.cassBase) < base ? base : 0n;
    limit = {
      casBase,
      cas: contribution(casBase, casRate),
      cassBase,
      cass: contribution(cassBase, cassRate),
    };
  }
  const positive = (value: bigint) => (value > 0n ? value : 0n);
  const supplementary = big(income.deduction.young) + big(income.deduction.children);
  return {
    id: index + 1,
    income: big(income.cash) + benefits,
    benefits,
    reliefIncome: work.relief > 0 ? big(work.casBase) + big(work.relief) : 0n,
    limit,
    employer: {
      cas: positive(limit.cas - big(work.cas)),
      cass: positive(limit.cass - big(work.cass)),
    },
    contributions: big(work.cas) + big(work.cass),
    deduction: { total: big(income.deduction.basic) + supplementary, supplementary },
    tax: big(income.tax),
  };
}

/**
 * The structure's derived fields of a declaration: per insured person the limit sums, the
 * difference borne by the employer and the E1/E2/E3 totals; for the employer the counts, the CAM
 * base and amount, the obligations and totalPlata_A. Throws when an amount, count or code is not
 * one the declaration accepts; checkD112 lists those without throwing.
 */
export function calculateD112(model: D112): D112Calculation {
  const namespace = d112Namespace(model.period);
  const [problem] = inputProblems(model);
  if (problem) throw new DomainError(problem.code, problem.message);

  const insured = model.insured.map(insuredCalculation);
  const people = model.insured;
  const camBase = sum(people, (person) => big(person.employment.camBase));
  const cam = { base: camBase, amount: contribution(camBase, camRate) };
  const amounts: Record<D112ObligationCode, bigint> = {
    '602': sum(insured, (person) => person.tax),
    '412': sum(people, (person) => big(person.employment.cas)),
    '432': sum(people, (person) => big(person.employment.cass)),
    '480': cam.amount,
    '458': sum(insured, (person) => person.employer.cas),
    '459': sum(insured, (person) => person.employer.cass),
  };
  const due = d112Obligations.filter(([code]) => amounts[code] > 0n);
  const obligations = (due.length ? due : d112Obligations.slice(0, 1)).map(
    ([code, budgetCode]) => ({
      code,
      budgetCode,
      owed: amounts[code],
      deductible: 0n,
      exempt: 0n,
      payable: amounts[code],
    }),
  );
  const unemploymentBase = (person: D112Insured) =>
    person.unemploymentInsured && !person.employment.pensioner;
  return {
    namespace,
    workingDays: workingDaysByMonth[model.period.month]!,
    insured,
    obligations,
    counts: {
      unemployment: people.filter(unemploymentBase).length,
      sickLeave: people.filter((person) => person.sickLeaveInsured).length,
      pension: people.filter((person) => person.employment.cas > 0).length,
      employees: people.length,
    },
    grossSalaries: sum(
      people.filter((person) => person.sickLeaveInsured),
      (person) => big(person.employment.cassBase),
    ),
    normalIncome: sum(
      people,
      (person) => big(person.employment.casBase) + big(person.employment.relief),
    ),
    cam,
    controlSum: sum(obligations, (obligation) => obligation.payable),
  };
}

const flag = (value: boolean) => (value ? '1' : '0');
const text = (value: bigint | number) => value.toString();

/** YYYY-MM-DD as the structure's dd.mm.yyyy. */
function structureDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new DomainError('D112_DATE', `Data ${date} se scrie în forma AAAA-LL-ZZ.`);
  return `${match[3]}.${match[2]}.${match[1]}`;
}

function fundCode(fund: string): string {
  const code = healthFundCode(fund);
  if (!code)
    throw new DomainError(
      'D112_HEALTH_FUND',
      `Casa de asigurări de sănătate ${fund} nu există în Nomenclatorul 2.`,
    );
  return code;
}

/**
 * Writes the declaration as one `declaratieUnica` element: the employer with its obligations
 * (angajatorA), counts (B), income in normal working conditions (C1) and CAM (C4), then each
 * insured person with section A, E1 or E2, and E3, attributes in the XSD's order. Every field the
 * structure computes is computed; the others are the model's.
 */
export function writeD112(model: D112): string {
  const calculation = calculateD112(model);
  const { employer, declarant } = model;
  const office = employer.registeredOffice;
  const fiscal = employer.fiscalDomicile;
  return serializeXml(
    element(
      'declaratieUnica',
      {
        xmlns: calculation.namespace,
        'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
        'xsi:schemaLocation': `${calculation.namespace} D112.xsd`,
        luna_r: String(model.period.month),
        an_r: String(model.period.year),
        d_rec: flag(model.correction),
        tip_rec: model.reason,
        nume_declar: declarant.lastName,
        prenume_declar: declarant.firstName,
        functie_declar: declarant.role,
      },
      element(
        'angajator',
        {
          cif: employer.cui,
          cifS: employer.successorCui,
          rgCom: employer.tradeRegister,
          caen: employer.caen,
          den: employer.name,
          adrSoc: office.address,
          telSoc: office.phone,
          faxSoc: office.fax,
          mailSoc: office.email,
          adrFisc: fiscal?.address,
          telFisc: fiscal?.phone,
          faxFisc: fiscal?.fax,
          mailFisc: fiscal?.email,
          casaAng: fundCode(employer.healthFund),
          datCAM: '1',
          totalPlata_A: text(calculation.controlSum),
        },
        calculation.obligations.map((obligation) =>
          element('angajatorA', {
            A_codOblig: obligation.code,
            A_codBugetar: obligation.budgetCode,
            A_datorat: text(obligation.owed),
            A_deductibil: text(obligation.deductible),
            A_scutit: text(obligation.exempt),
            A_plata: text(obligation.payable),
          }),
        ),
        element('angajatorB', {
          B_cnp: text(calculation.counts.unemployment),
          B_sanatate: text(calculation.counts.sickLeave),
          B_pensie: text(calculation.counts.pension),
          B_sal: text(calculation.counts.employees),
          B_brutSalarii: text(calculation.grossSalaries),
        }),
        // Medical-leave bases (C1_12…), special conditions and exemptions have no amounts here.
        element('angajatorC1', {
          C1_11: text(calculation.normalIncome),
          C1_12: '0',
          C1_13: '0',
          C1_21: '0',
          C1_22: '0',
          C1_23: '0',
          C1_31: '0',
          C1_32: '0',
          C1_33: '0',
          C1_T1: text(calculation.normalIncome),
          C1_T2: '0',
          C1_T: '0',
          C1_T3: '0',
          C1_5: '0',
        }),
        element('angajatorC4', {
          C4_baza: text(calculation.cam.base),
          C4_ct: text(calculation.cam.amount),
        }),
      ),
      model.insured.map((insured, index) => insuredElement(insured, calculation.insured[index]!)),
    ),
  );
}

function insuredElement(insured: D112Insured, calculation: D112InsuredCalculation) {
  const { employment: work, income, minimum } = insured;
  const optional = (value: bigint | number) => (value ? text(value) : undefined);
  const main = income.mainJob;
  const contributions = text(calculation.contributions);
  return element(
    'asigurat',
    {
      cnpAsig: insured.cnp,
      idAsig: String(calculation.id),
      numeAsig: insured.lastName,
      prenAsig: insured.firstName,
      dataAng: structureDate(insured.from),
      dataSf: insured.until === undefined ? undefined : structureDate(insured.until),
      casaSn: fundCode(insured.healthFund),
      asigCI: insured.sickLeaveInsured ? '1' : '2',
      asigSO: insured.unemploymentInsured ? '1' : '2',
      asigExc: minimum ? (minimum.kind === 'exempt' ? '1' : '2') : undefined,
      motivExc:
        minimum?.kind === 'exempt'
          ? String(minimumExemptions.indexOf(minimum.reason) + 1)
          : undefined,
      Timp_E3: text(calculation.tax),
    },
    element('asiguratA', {
      A_1: work.type,
      A_sal1: text(work.baseSalary),
      A_sal2: text(calculation.income),
      A_2: flag(work.pensioner),
      A_3: work.contract,
      A_4: String(work.normHours),
      A_5: text(work.camBase),
      A_6: String(work.hoursWorked),
      A_7: String(work.hoursSuspended),
      A_8: String(work.daysWorked),
      A_9: text(work.unemploymentBase),
      A_11: text(work.cassBase),
      A_12: text(work.cass),
      A_13: text(work.casBase),
      A_14: text(work.cas),
      A_13P: text(calculation.limit.casBase),
      A_14P: text(calculation.limit.cas),
      A_11P: text(calculation.limit.cassBase),
      A_12P: text(calculation.limit.cass),
      A_14D: text(calculation.employer.cas),
      A_12D: text(calculation.employer.cass),
      A_13S: text(work.relief),
      A_13C: text(calculation.reliefIncome),
    }),
    main
      ? element('asiguratE1', {
          E1_1: text(calculation.income),
          E1_2: contributions,
          E1_3: String(income.dependents),
          E1_4: text(calculation.deduction.total),
          E1_41: text(income.deduction.basic),
          E1_42: text(calculation.deduction.supplementary),
          E1_421: text(income.deduction.young),
          E1_422: text(income.deduction.children),
          E1_5: text(income.otherDeductions),
          E1_6: text(income.taxBase),
          E1_7: text(income.tax),
        })
      : element('asiguratE2', {
          E2_1: text(calculation.income),
          E2_2: contributions,
          E2_3: text(income.taxBase),
          E2_4: text(income.tax),
        }),
    element('asiguratE3', {
      E3_1: 'A',
      E3_2: work.type,
      E3_3: main ? '1' : '2',
      E3_4: 'P',
      E3_8: text(calculation.income),
      E3_60: optional(calculation.benefits),
      E3_10: optional(income.mealVouchers),
      E3_75: optional(income.holidayVouchers),
      E3_9: contributions,
      E3_19: '0',
      E3_11: String(income.dependents),
      E3_12: text(calculation.deduction.total),
      E3_121: text(income.deduction.basic),
      E3_122: text(calculation.deduction.supplementary),
      E3_1221: text(income.deduction.young),
      E3_1222: text(income.deduction.children),
      E3_13: text(income.otherDeductions),
      E3_14: text(income.taxBase),
      E3_15: text(income.tax),
      E3_16: text(income.paid),
    }),
  );
}

export type D112Check = {
  code: string;
  /** error: ANAF rejects the declaration (E:) or the structure forbids the value; warning: it is
   * accepted, with a notice (A:) or with a value the structure's own formula would not give. */
  severity: 'error' | 'warning';
  path: string;
  message: string;
};

const isCui = (code: string) => /^[1-9]\d{1,9}$/.test(code) && isValidCui(code);

/** The birth month within a CNP, for Romanian citizens (sex digits 1–6). */
function cnpBirth(cnp: string): { year: number; month: number } | undefined {
  const century = { '1': 1900, '2': 1900, '3': 1800, '4': 1800, '5': 2000, '6': 2000 }[cnp[0]!];
  if (century === undefined) return undefined;
  return { year: century + Number(cnp.slice(1, 3)), month: Number(cnp.slice(3, 5)) };
}

/** The last day of a month, YYYY-MM-DD. */
function lastDayOf({ year, month }: D112['period']): string {
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${day}`;
}

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

const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

/**
 * Fast feedback on the structure's validations for the sections written here, as ANAF's
 * validator applies them, in Romanian. The official validator (DUKIntegrator) remains the oracle;
 * it also checks the CAEN list.
 */
export function checkD112(model: D112): D112Check[] {
  const checks: D112Check[] = [];
  const add = (severity: D112Check['severity'], code: string, path: string, message: string) =>
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
      if (required) error('D112_TEXT', path, `Completați ${label}.`);
    } else if (trimmed.length > max)
      error('D112_TEXT', path, `Câmpul ${label} are cel mult ${max} caractere.`);
  };
  const { period, declarant, employer } = model;
  const validPeriod = isPeriod(period);
  if (!validPeriod) error('D112_PERIOD', 'period', periodMessage);

  // d_rec and tip_rec.
  if (model.reason !== undefined) {
    if (!d112Reasons.some(([reason]) => reason === model.reason))
      error('D112_REASON', 'reason', `Tipul declarației ${model.reason} nu există.`);
    else if (model.reason === '7')
      error(
        'D112_REASON',
        'reason',
        'Tipul 7 de declarație se depune doar de AJOFM, CNAS, CNPP sau ANPIS.',
      );
    else if (!model.correction && !['3', '5'].includes(model.reason))
      error(
        'D112_REASON',
        'reason',
        `Tipul ${model.reason} de declarație se depune doar ca declarație rectificativă.`,
      );
  }

  textField('declarant.lastName', declarant.lastName, 'numele declarantului', 75, true);
  textField('declarant.firstName', declarant.firstName, 'prenumele declarantului', 75, true);
  textField('declarant.role', declarant.role, 'funcția declarantului', 50, true);

  if (!isCui(employer.cui))
    error(
      'D112_CUI',
      'employer.cui',
      'Codul de identificare fiscală nu este valid; se scrie fără prefixul RO.',
    );
  if (employer.successorCui !== undefined && !isCui(employer.successorCui))
    error(
      'D112_CUI',
      'employer.successorCui',
      'Codul de identificare fiscală al succesorului nu este valid.',
    );
  textField('employer.tradeRegister', employer.tradeRegister, 'numărul de înmatriculare', 14);
  if (!/^\d{4}$/.test(employer.caen))
    error('D112_CAEN', 'employer.caen', 'Codul CAEN are patru cifre.');
  textField('employer.name', employer.name, 'denumirea', 200, true);
  for (const [group, place, required] of [
    ['registeredOffice', 'sediului social', true],
    ['fiscalDomicile', 'domiciliului fiscal', false],
  ] as const) {
    const contact = employer[group];
    textField(`employer.${group}.address`, contact?.address, `adresa ${place}`, 1000, required);
    textField(`employer.${group}.phone`, contact?.phone, `telefonul ${place}`, 15);
    textField(`employer.${group}.fax`, contact?.fax, `faxul ${place}`, 15);
    textField(`employer.${group}.email`, contact?.email, `e-mailul ${place}`, 200);
    if (contact?.email?.trim() && !isEmail(contact.email))
      warning('D112_EMAIL', `employer.${group}.email`, `E-mailul ${place} nu este valid.`);
  }
  if (employer.healthFund === 'OPSNAJ' || !healthFundCode(employer.healthFund))
    error(
      'D112_HEALTH_FUND',
      'employer.healthFund',
      'Casa de sănătate a angajatorului este casa județeană sau a municipiului București.',
    );

  if (model.insured.length === 0)
    error(
      'D112_INSURED',
      'insured',
      'Declarația se depune aici pentru cel puțin un salariat; fără asigurați, perioada de asigurare la sănătate se încheie.',
    );

  const problems = inputProblems(model);
  for (const problem of problems) error(problem.code, problem.path, problem.message);
  const invalid = new Set(problems.map((problem) => problem.path.split('.').slice(0, 2).join('.')));

  const workingDays = validPeriod ? workingDaysByMonth[period.month]! : undefined;
  const lastDay = validPeriod ? lastDayOf(period) : undefined;
  const seen = new Set<string>();
  model.insured.forEach((insured, index) => {
    const path = `insured.${index}`;
    const { employment: work, income, minimum } = insured;
    if (!/^[1-9]\d{12}$/.test(insured.cnp) || !isValidCnp(insured.cnp))
      error('D112_CNP', `${path}.cnp`, 'CNP-ul asiguratului nu este valid.');
    else {
      if (seen.has(insured.cnp))
        error('D112_CNP', `${path}.cnp`, 'Un asigurat se declară o singură dată (CNP unic).');
      seen.add(insured.cnp);
      const birth = cnpBirth(insured.cnp);
      if (birth && validPeriod) {
        const months =
          periodIndex(period.year, period.month) - periodIndex(birth.year, birth.month);
        if (months < 15 * 12)
          error('D112_CNP', `${path}.cnp`, 'Asiguratul trebuie să aibă cel puțin 15 ani.');
      }
    }
    textField(`${path}.lastName`, insured.lastName, 'numele asiguratului', 75, true);
    textField(`${path}.firstName`, insured.firstName, 'prenumele asiguratului', 75, true);
    if (!isDate(insured.from))
      error('D112_DATE', `${path}.from`, 'Data intrării în categoria de asigurat nu este validă.');
    else if (lastDay && insured.from > lastDay)
      error(
        'D112_DATE',
        `${path}.from`,
        'Data intrării în categoria de asigurat este după luna de raportare.',
      );
    if (insured.until !== undefined) {
      if (!isDate(insured.until))
        error(
          'D112_DATE',
          `${path}.until`,
          'Data ieșirii din categoria de asigurat nu este validă.',
        );
      else if (insured.until < insured.from)
        error('D112_DATE', `${path}.until`, 'Data ieșirii nu poate fi înaintea datei intrării.');
      else if (lastDay && insured.until > lastDay)
        error('D112_DATE', `${path}.until`, 'Data ieșirii nu poate fi după luna de raportare.');
    }
    if (!healthFundCode(insured.healthFund))
      error(
        'D112_HEALTH_FUND',
        `${path}.healthFund`,
        `Casa de asigurări de sănătate ${insured.healthFund} nu există în Nomenclatorul 2.`,
      );
    if (invalid.has(`insured.${index}`) || workingDays === undefined) return;

    const at = `${path}.employment`;
    const hours = contractHours(work.contract, work.normHours);
    const fullDays = workingDays * hours;
    const ajs = insured.unemploymentInsured && !work.pensioner;
    if (work.contract !== 'N' && hours >= work.normHours)
      error(
        'D112_CONTRACT',
        `${at}.contract`,
        'Timpul parțial are mai puține ore decât norma zilnică.',
      );
    if (work.type === '51' && work.contract !== 'N')
      error(
        'D112_TYPE',
        `${at}.type`,
        'Tipul 51 se declară doar pentru contracte cu normă întreagă.',
      );
    if (work.hoursWorked > fullDays)
      error(
        'D112_HOURS',
        `${at}.hoursWorked`,
        `Orele lucrate depășesc ${fullDays}, zilele lucrătoare ale lunii înmulțite cu orele contractului.`,
      );
    else if (work.hoursWorked + work.hoursSuspended > fullDays)
      error(
        'D112_HOURS',
        `${at}.hoursSuspended`,
        `Orele lucrate și cele suspendate depășesc ${fullDays}.`,
      );
    if (work.daysWorked > workingDays)
      error(
        'D112_DAYS',
        `${at}.daysWorked`,
        `Zilele lucrate depășesc cele ${workingDays} zile lucrătoare ale lunii.`,
      );
    if (ajs && work.hoursWorked + work.hoursSuspended === 0)
      error(
        'D112_HOURS',
        `${at}.hoursWorked`,
        'Pentru un asigurat la șomaj se declară ore lucrate sau suspendate.',
      );
    if (!ajs && work.unemploymentBase > 0)
      error(
        'D112_UNEMPLOYMENT',
        `${at}.unemploymentBase`,
        'Baza indemnizației de șomaj se completează doar pentru asigurații la șomaj care nu sunt pensionari.',
      );
    if (ajs && work.hoursWorked > 0 && work.unemploymentBase === 0)
      warning(
        'D112_UNEMPLOYMENT',
        `${at}.unemploymentBase`,
        'Pentru orele lucrate se completează baza indemnizației de șomaj.',
      );
    if (ajs && work.unemploymentBase > 0 && work.hoursWorked === 0)
      warning(
        'D112_UNEMPLOYMENT',
        `${at}.hoursWorked`,
        'Cu bază a indemnizației de șomaj se declară ore lucrate.',
      );
    if (work.baseSalary === 0 && income.cash + income.mealVouchers + income.holidayVouchers === 0)
      warning(
        'D112_SALARY',
        `${at}.baseSalary`,
        'Salariul de bază și venitul brut nu pot fi amândouă zero.',
      );

    if (work.daysWorked > 0 && work.casBase === 0)
      error('D112_CAS', `${at}.casBase`, 'Pentru zilele lucrate se declară baza CAS.');
    if (work.casBase > 0 && work.daysWorked === 0)
      warning('D112_DAYS', `${at}.daysWorked`, 'Cu bază CAS se declară zilele lucrate.');
    if (work.daysWorked > 0 && work.cassBase === 0)
      warning('D112_CASS', `${at}.cassBase`, 'Pentru zilele lucrate se declară baza CASS.');
    if (work.daysWorked > 0 && work.camBase === 0)
      warning('D112_CAM', `${at}.camBase`, 'Pentru zilele lucrate se declară baza CAM.');
    if (work.casBase > work.cassBase)
      warning('D112_CAS', `${at}.casBase`, 'Baza CAS depășește baza CASS.');
    const cas = contribution(big(work.casBase), casRate);
    if (big(work.cas) < cas - 2n || big(work.cas) > cas + 2n)
      error(
        'D112_CAS',
        `${at}.cas`,
        `CAS (${work.cas}) diferă de 25% din bază (${cas}) cu mai mult de 2 lei.`,
      );
    const cass = contribution(big(work.cassBase), cassRate);
    if (big(work.cass) < cass - 1n || big(work.cass) > cass + 2n)
      error('D112_CASS', `${at}.cass`, `CASS (${work.cass}) diferă de 10% din bază (${cass}).`);

    if (work.relief > 0 && work.type !== '51')
      error(
        'D112_RELIEF',
        `${at}.relief`,
        'Suma neimpozabilă din salariul minim se declară doar pentru tipul 51.',
      );
    else if (big(work.relief) > reliefLimit)
      warning(
        'D112_RELIEF',
        `${at}.relief`,
        `Suma neimpozabilă este de cel mult ${reliefLimit} lei în iulie–decembrie 2026 (OUG nr. 89/2025).`,
      );

    // asigExc, motivExc and the limit sums (S9c1.1, SP1A.3, SP3A).
    const limit = structureLimit(work.daysWorked, workingDays);
    if (
      !minimum &&
      work.contract !== 'N' &&
      work.casBase > 0 &&
      big(work.casBase) < limit.floor - 3n
    )
      error(
        'D112_MINIMUM',
        `${path}.minimum`,
        `Baza CAS (${work.casBase}) a contractului cu timp parțial este sub ${limit.floor} lei; se declară dacă salariatul este exceptat sau nu de la contribuția minimă.`,
      );
    if (minimum?.kind === 'due') {
      const base = big(minimum.base);
      if (work.casBase === 0 || big(work.casBase) >= base)
        error(
          'D112_MINIMUM',
          `${path}.minimum.base`,
          'Neexceptarea se declară doar pentru o bază CAS sub suma limită.',
        );
      else if (base < limit.floor - 1n)
        error(
          'D112_MINIMUM',
          `${path}.minimum.base`,
          `Suma limită (${minimum.base}) este sub (4325 − 200) lei × ${work.daysWorked} / ${workingDays} zile = ${limit.floor} lei.`,
        );
      else if (base !== limit.rounded)
        warning(
          'D112_MINIMUM_BASE',
          `${path}.minimum.base`,
          `Structura ANAF calculează suma limită ca (4325 − 200) lei × ${work.daysWorked} / ${workingDays} zile = ${limit.rounded} lei, nu ${minimum.base}; validatorul acceptă orice sumă de cel puțin ${limit.floor - 1n} lei.`,
        );
    }

    const tax = `${path}.income`;
    if (work.type === '51' && !income.mainJob)
      error('D112_MAIN_JOB', `${tax}.mainJob`, 'Tipul 51 se declară doar la funcția de bază.');
    if (!income.mainJob) {
      const { basic, young, children } = income.deduction;
      if (income.dependents || basic || young || children || income.otherDeductions)
        error(
          'D112_MAIN_JOB',
          `${tax}.deduction`,
          'Persoanele în întreținere, deducerile personale și celelalte deduceri se completează doar la funcția de bază.',
        );
    }
    if (income.tax > income.taxBase)
      error('D112_TAX', `${tax}.tax`, 'Impozitul nu poate depăși baza de calcul.');
    if (income.taxBase > income.cash + income.mealVouchers + income.holidayVouchers)
      warning('D112_TAX', `${tax}.taxBase`, 'Baza de calcul a impozitului depășește venitul brut.');
  });

  if (problems.length || !validPeriod || model.insured.length === 0) return checks;
  const calculation = calculateD112(model);
  const totals = [
    calculation.controlSum,
    calculation.cam.base,
    calculation.grossSalaries,
    calculation.normalIncome,
    ...calculation.obligations.map((obligation) => obligation.owed),
  ];
  if (totals.some((value) => value > maxAmount))
    error('D112_TOTAL', 'insured', 'Un total al declarației depășește 15 cifre.');
  return checks;
}
