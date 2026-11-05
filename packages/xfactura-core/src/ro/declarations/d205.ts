import { DomainError } from '../../errors';
import { element, serializeXml } from '../../xml/write';
import { isValidCnp, isValidCui } from '../identifiers';

/**
 * The informative statement of tax withheld at source and investment gains/losses, per income
 * beneficiary (D205, "Declarație informativă privind impozitul reținut la sursă și
 * câștigurile/pierderile din investiții, pe beneficiari de venit"), for reporting years 2025 and
 * 2026, after ANAF's XML structure of 12.02.2026 (structura_D205_2025_120226, OPANAF nr. 102/2025).
 *
 * ANAF's validator (DUKIntegrator, D205Validator J9.0.5, jar of 24.02.2026) requires the namespace
 * `mfp:anaf:dgti:d205:declaratie:v3`, which the structure names and the XSD (d205_2025_v3, whose
 * targetNamespace still reads v2) declares. The structure and the XSD start at 2025, the validator
 * at 2024; the structure's dividend rates end with 16% for 2026, so later years are refused. Where
 * the XSD and the validator differ, this module follows the validator: cifSS is written only for a
 * successor's declaration.
 *
 * Covered: dividends (tip_venit 08) paid by a Romanian company to resident individuals, one
 * sect_II and one benef record per individual (the validator keys tip_venit1 + cifR as unique),
 * with Rezid 1 and tip_plata 2 ("impozit final"). The completion instructions of OPANAF nr.
 * 102/2025 (cap. V) declare dividends "pentru fiecare persoană fizică beneficiară", identified by
 * CNP or NIF (here by CNP): dividends of companies are left out, although the validator accepts a
 * CUI in cifR, and the validator allows non-residents (Rezid 2) only for other income types. The
 * structure lets the other income types, gains and losses (castig1, pierdere1), in-kind rent (VB,
 * GAR) and non-residents (Stat_R, cifS) be absent.
 *
 * Per individual the instructions ask for the dividends distributed in the year (divid_D,
 * "totalul venitului distribuit din dividende, într-un an fiscal"), those paid in it (divid_P,
 * "totalul venitului plătit acționarilor sau asociaților din dividendele distribuite"), and the
 * base and tax (baza1, imp1) of the year. The tax on dividends distributed and unpaid at the end of
 * the year, paid by 25 January of the next (art. 97 alin. (7) Cod fiscal), "se cuprinde în
 * declarația aferentă perioadei în care s-a aprobat distribuirea dividendelor": it belongs to the
 * year of distribution, and paying those dividends later adds only to that year's divid_P.
 *
 * Interest paid to resident individuals under civil contracts (tip_venit 09, "1.b) venituri din
 * dobânzi - 10%", col. 9 and 10 only): one record per individual, with the gross interest paid in
 * the year as baza1 and the tax withheld at payment (art. 97 alin. (2) Cod fiscal) as imp1;
 * divid_D and divid_P are for dividends only. An individual with dividends and interest has a
 * record of each type (the validator keys tip_venit1 + cifR).
 *
 * Rent paid to resident individuals by the company (tip_venit 29, "1.k) venituri din cedarea
 * folosinței bunurilor ... plătite de PJ", 10%, art. 84^1 Cod fiscal): one record per landlord,
 * with the net income the tax was computed on (the gross less 20%) as baza1 and the tax withheld
 * as imp1; VB and GAR (rent paid only in kind, a guarantee kept for the rent, art. 84^1 alin. (8))
 * are 0, those cases not being covered. Intellectual property (tip 01) is among the codes the
 * structure abolished: its payers declare it in D112 (art. 132 alin. (2)).
 *
 * A rectifying declaration (d_rec 1) holds only the corrected records, each with its full corrected
 * amounts; a record with every amount zero removes the initial one.
 *
 * Amounts are whole lei, N(15), never negative.
 */

/** tip_venit, tip_venit1: the Nomenclator natura veniturilor codes covered. */
export const d205IncomeTypes = [
  ['08', '1.a) venituri din dividende - 8%/2024, 10%/2025, 16%/2026'],
  ['09', '1.b) venituri din dobânzi - 10%'],
  ['29', '1.k) venituri din cedarea folosinței bunurilor plătite de PJ - 10%'],
] as const;
export type D205IncomeType = (typeof d205IncomeTypes)[number][0];

/** The structure's dividend tax rates in percent, by the year the dividends were distributed. */
export const d205DividendRates: Readonly<Record<number, number>> = { 2024: 8, 2025: 10, 2026: 16 };

/** A payment of dividends in the reporting year. */
export type D205Payment = {
  /** The payment date, YYYY-MM-DD, within the reporting year. */
  date: string;
  /** The date of the decision distributing the dividends, YYYY-MM-DD; a year before the reporting
   * year means they were unpaid at the end of that year and their tax was declared then. */
  distributed: string;
  /** Gross dividends paid. */
  gross: number;
  /** The tax on them: withheld at payment, or, for dividends distributed in an earlier year, paid
   * by 25 January after it. */
  tax: number;
};

/** Dividends distributed in the reporting year and unpaid at its end, with the tax withheld on
 * them by 25 January of the following year. */
export type D205Unpaid = { gross: number; tax: number };

/** The structure's interest rate in percent (tip_venit 09). */
export const d205InterestRate = 10;

/** Interest paid in the reporting year under a civil contract, with the tax withheld from it. */
export type D205Interest = {
  /** The payment date, YYYY-MM-DD, within the reporting year. */
  date: string;
  /** Gross interest paid. */
  gross: number;
  tax: number;
};

/** The structure's rent rate in percent (tip_venit 29), on the net income. */
export const d205RentRate = 10;

/** Rent paid to the individual in the reporting year, with the tax withheld from it. */
export type D205Rent = {
  /** The payment date, YYYY-MM-DD, within the reporting year. */
  date: string;
  /** The net income the tax was computed on (the gross less 20%), whole lei. */
  base: number;
  tax: number;
};

export type D205Beneficiary =
  /** A resident individual: one benef record, all payments and unpaid dividends together. */
  | {
      kind: 'individual';
      /** cifR */
      cnp: string;
      /** den1: "Nume și prenume". */
      name: string;
      payments: D205Payment[];
      unpaid: D205Unpaid[];
      /** Interest paid to them (tip_venit 09). */
      interest?: D205Interest[];
      /** Rent paid to them (tip_venit 29). */
      rent?: D205Rent[];
    }
  /** A Romanian company, left out of the declaration. */
  | { kind: 'company'; cui: string; name: string; payments: D205Payment[]; unpaid: D205Unpaid[] };

export type D205 = {
  /** an: the reporting year; luna is always 12. */
  year: number;
  /** d_rec: corrects the declaration filed for the year with the records that change. */
  correction: boolean;
  declarant: {
    /** nume_declar */
    lastName: string;
    /** prenume_declar */
    firstName: string;
    /** functie_declar */
    role: string;
  };
  /** Secțiunea I: the income payer. */
  payer: {
    /** cui: digits only, without the RO prefix. */
    cui: string;
    /** cifSS, with d_succ 1: the successor, for a declaration filed under art. 90 alin. (4) Cod
     * procedură fiscală. */
    successorCui?: string;
    /** den */
    name: string;
    /** adresa: the fiscal domicile. */
    address: string;
    /** telefon */
    phone?: string;
    /** fax */
    fax?: string;
    /** mail */
    email?: string;
  };
  /** divid_P: the instructions do not say whether the dividends paid are declared before or after
   * the tax; `gross` declares the gross dividends, `net` what the beneficiaries received. */
  paidAs: 'gross' | 'net';
  /** In the order of the records. */
  beneficiaries: D205Beneficiary[];
};

/** One benef record. */
export type D205Record = {
  /** id_inreg */
  id: number;
  /** The beneficiary's index in the model. */
  beneficiary: number;
  incomeType: D205IncomeType;
  /** divid_D: distributed in the year, paid or not; dividends only. */
  distributed: bigint;
  /** divid_P: paid in the year, whenever distributed. */
  paid: bigint;
  /** baza1: the gross dividends taxed in the year, those distributed in it. */
  base: bigint;
  /** imp1: the tax on them. */
  tax: bigint;
};

/** sect_II: the totals of one income type. */
export type D205Summary = {
  incomeType: D205IncomeType;
  /** nrben */
  beneficiaries: number;
  /** Tbaza */
  base: bigint;
  /** Timp */
  tax: bigint;
};

export type D205Calculation = {
  namespace: string;
  records: D205Record[];
  summaries: D205Summary[];
  /** The company beneficiaries left out, by index. */
  omitted: number[];
  /** totalPlata_A: every sect_II nrben, Tcastig, Tpierd, T_VB, T_GAR, Tbaza and Timp. */
  controlSum: bigint;
};

const maxAmount = 999_999_999_999_999n; // N(15)
const firstYear = 2025;
const lastYear = 2026;

const isYear = (year: number) => Number.isInteger(year) && year >= firstYear && year <= lastYear;
const yearMessage = 'Declarația D205 în această structură se depune pentru anii 2025 și 2026.';

/** The structure's namespace for a reporting year of 2025–2026. */
export function d205Namespace(year: number): string {
  if (!isYear(year)) throw new DomainError('D205_YEAR', yearMessage);
  return 'mfp:anaf:dgti:d205:declaratie:v3';
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

const yearOf = (date: string) => Number(date.slice(0, 4));

type Problem = { code: string; path: string; message: string };

const isAmount = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 999_999_999_999_999;

/** The inputs calculateD205 cannot use: beneficiary kinds, amounts and distribution dates. */
function inputProblems(model: D205): Problem[] {
  const problems: Problem[] = [];
  const amount = (path: string, value: unknown, label: string) => {
    if (!isAmount(value))
      problems.push({
        code: 'D205_AMOUNT',
        path,
        message: `${label}: o sumă în lei, fără zecimale, nenegativă, de cel mult 15 cifre.`,
      });
  };
  if (model.paidAs !== 'gross' && model.paidAs !== 'net')
    problems.push({
      code: 'D205_PAID',
      path: 'paidAs',
      message: 'Dividendele plătite se declară brute (gross) sau nete (net).',
    });
  model.beneficiaries.forEach((beneficiary, index) => {
    const path = `beneficiaries.${index}`;
    if (beneficiary.kind !== 'individual' && beneficiary.kind !== 'company')
      problems.push({
        code: 'D205_BENEFICIARY',
        path: `${path}.kind`,
        message: 'Beneficiarul este o persoană fizică sau o societate.',
      });
    beneficiary.payments.forEach((payment, item) => {
      const at = `${path}.payments.${item}`;
      if (!isDate(payment.distributed))
        problems.push({
          code: 'D205_DATE',
          path: `${at}.distributed`,
          message: `Data distribuirii ${payment.distributed} se scrie în forma AAAA-LL-ZZ.`,
        });
      else if (yearOf(payment.distributed) > model.year)
        problems.push({
          code: 'D205_DATE',
          path: `${at}.distributed`,
          message: 'Dividendele distribuite după anul de raportare nu se declară pe acest an.',
        });
      amount(`${at}.gross`, payment.gross, 'Dividendele brute');
      amount(`${at}.tax`, payment.tax, 'Impozitul');
    });
    beneficiary.unpaid.forEach((unpaid, item) => {
      amount(`${path}.unpaid.${item}.gross`, unpaid.gross, 'Dividendele brute neplătite');
      amount(`${path}.unpaid.${item}.tax`, unpaid.tax, 'Impozitul');
    });
    if (beneficiary.kind === 'individual') {
      beneficiary.interest?.forEach((paid, item) => {
        amount(`${path}.interest.${item}.gross`, paid.gross, 'Dobânda brută');
        amount(`${path}.interest.${item}.tax`, paid.tax, 'Impozitul');
      });
      beneficiary.rent?.forEach((paid, item) => {
        amount(`${path}.rent.${item}.base`, paid.base, 'Venitul net din chirii');
        amount(`${path}.rent.${item}.tax`, paid.tax, 'Impozitul');
      });
    }
  });
  return problems;
}

const sum = <T>(items: readonly T[], value: (item: T) => bigint) =>
  items.reduce((total, item) => total + value(item), 0n);
const big = (value: number) => BigInt(value);

/** An individual's interest record: the gross interest paid in the year and the tax on it. */
const interestRecord = (id: number, beneficiary: number, interest: D205Interest[]): D205Record => ({
  id,
  beneficiary,
  incomeType: '09',
  distributed: 0n,
  paid: 0n,
  base: sum(interest, (paid) => big(paid.gross)),
  tax: sum(interest, (paid) => big(paid.tax)),
});

/** A landlord's rent record: the net income of the year's payments and the tax on it. */
const rentRecord = (id: number, beneficiary: number, rent: D205Rent[]): D205Record => ({
  id,
  beneficiary,
  incomeType: '29',
  distributed: 0n,
  paid: 0n,
  base: sum(rent, (paid) => big(paid.base)),
  tax: sum(rent, (paid) => big(paid.tax)),
});

/**
 * The records, sect_II totals and control sum of a declaration. Throws when the year, an amount,
 * a distribution date or a beneficiary kind is not one the declaration accepts; checkD205 lists
 * those without throwing.
 */
export function calculateD205(model: D205): D205Calculation {
  const namespace = d205Namespace(model.year);
  const [problem] = inputProblems(model);
  if (problem) throw new DomainError(problem.code, problem.message);

  const records: D205Record[] = [];
  const omitted: number[] = [];
  model.beneficiaries.forEach((beneficiary, index) => {
    if (beneficiary.kind === 'company') {
      omitted.push(index);
      return;
    }
    const interest = beneficiary.interest ?? [];
    const rent = beneficiary.rent ?? [];
    // An individual without dividends keeps a dividend record only when there is no interest or
    // rent either: in a rectifying declaration, a record of zeros removes the initial one.
    if (
      (interest.length || rent.length) &&
      !beneficiary.payments.length &&
      !beneficiary.unpaid.length
    ) {
      if (interest.length) records.push(interestRecord(records.length + 1, index, interest));
      if (rent.length) records.push(rentRecord(records.length + 1, index, rent));
      return;
    }
    const current = beneficiary.payments.filter(
      (payment) => yearOf(payment.distributed) === model.year,
    );
    const distributed =
      sum(current, (payment) => big(payment.gross)) +
      sum(beneficiary.unpaid, (unpaid) => big(unpaid.gross));
    records.push({
      id: records.length + 1,
      beneficiary: index,
      incomeType: '08',
      distributed,
      paid: sum(beneficiary.payments, (payment) =>
        model.paidAs === 'net' ? big(payment.gross) - big(payment.tax) : big(payment.gross),
      ),
      base: distributed,
      tax:
        sum(current, (payment) => big(payment.tax)) +
        sum(beneficiary.unpaid, (unpaid) => big(unpaid.tax)),
    });
    if (interest.length) records.push(interestRecord(records.length + 1, index, interest));
    if (rent.length) records.push(rentRecord(records.length + 1, index, rent));
  });
  const summaries: D205Summary[] = d205IncomeTypes.flatMap(([incomeType]) => {
    const own = records.filter((record) => record.incomeType === incomeType);
    return own.length
      ? [
          {
            incomeType,
            beneficiaries: own.length,
            base: sum(own, (record) => record.base),
            tax: sum(own, (record) => record.tax),
          },
        ]
      : [];
  });
  return {
    namespace,
    records,
    summaries,
    omitted,
    // Tcastig, Tpierd, T_VB and T_GAR are zero for dividends, interest and rent paid in money.
    controlSum: sum(
      summaries,
      (summary) => BigInt(summary.beneficiaries) + summary.base + summary.tax,
    ),
  };
}

const text = (value: bigint | number) => value.toString();
const noRecords =
  'Declarația cuprinde cel puțin un beneficiar persoană fizică; fără dividende, dobânzi sau chirii plătite persoanelor fizice, D205 nu are ce declara.';

/**
 * Writes the declaration as one `declaratie205` element: the payer's attributes, sect_II per
 * income type, then a benef record per individual, attributes in the XSD's order. The records,
 * totals and totalPlata_A are computed; company beneficiaries are left out.
 */
export function writeD205(model: D205): string {
  const calculation = calculateD205(model);
  if (calculation.records.length === 0) throw new DomainError('D205_BENEFICIARIES', noRecords);
  const { declarant, payer } = model;
  return serializeXml(
    element(
      'declaratie205',
      {
        xmlns: calculation.namespace,
        'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
        'xsi:schemaLocation': `${calculation.namespace} D205.xsd`,
        luna: '12',
        an: String(model.year),
        d_rec: model.correction ? '1' : '0',
        d_succ: payer.successorCui === undefined ? '0' : '1',
        cifSS: payer.successorCui,
        nume_declar: declarant.lastName,
        prenume_declar: declarant.firstName,
        functie_declar: declarant.role,
        cui: payer.cui,
        den: payer.name,
        adresa: payer.address,
        telefon: payer.phone,
        fax: payer.fax,
        mail: payer.email,
        totalPlata_A: text(calculation.controlSum),
      },
      calculation.summaries.map((summary) =>
        element('sect_II', {
          tip_venit: summary.incomeType,
          nrben: text(summary.beneficiaries),
          // Gains and losses (tip_venit 25) and in-kind rent (29) only.
          Tcastig: '0',
          Tpierd: '0',
          Tbaza: text(summary.base),
          Timp: text(summary.tax),
          T_VB: '0',
          T_GAR: '0',
        }),
      ),
      calculation.records.map((record) => {
        const beneficiary = model.beneficiaries[record.beneficiary] as Extract<
          D205Beneficiary,
          { kind: 'individual' }
        >;
        return element('benef', {
          id_inreg: text(record.id),
          tip_venit1: record.incomeType,
          den1: beneficiary.name,
          cifR: beneficiary.cnp,
          tip_plata: '2',
          Rezid: '1',
          baza1: text(record.base),
          imp1: text(record.tax),
          ...(record.incomeType === '08'
            ? { divid_D: text(record.distributed), divid_P: text(record.paid) }
            : {}),
          ...(record.incomeType === '29' ? { VB: '0', GAR: '0' } : {}),
        });
      }),
    ),
  );
}

export type D205Check = {
  code: string;
  /** error: ANAF rejects the declaration (E:) or the structure forbids the value; warning: it is
   * accepted, with a notice (A:) or with a value the structure's rates would not give. */
  severity: 'error' | 'warning';
  path: string;
  message: string;
};

const isCui = (code: string) => /^[1-9]\d{1,9}$/.test(code) && isValidCui(code);

/** A CNP with a valid control digit and birth date; 9, the NIF prefix, is not a CNP. */
function isCnp(cnp: string): boolean {
  if (!/^[1-8]\d{12}$/.test(cnp) || !isValidCnp(cnp)) return false;
  const century = { '1': 1900, '2': 1900, '3': 1800, '4': 1800, '5': 2000, '6': 2000 }[cnp[0]!];
  const month = Number(cnp.slice(3, 5));
  const day = Number(cnp.slice(5, 7));
  // Foreign residents (7, 8) carry no century; their February allows the 29th.
  const year = century === undefined ? 2000 : century + Number(cnp.slice(1, 3));
  return (
    month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
  );
}

const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

/** amount × rate / 100, rounded half up. */
const percent = (amount: number, rate: number) =>
  (BigInt(amount) * BigInt(rate) * 2n + 100n) / 200n;

/**
 * Fast feedback on the structure's validations for the sections written here, as ANAF's
 * validator applies them, in Romanian, and on the dividend rates of the structure. The official
 * validator (DUKIntegrator) remains the oracle.
 */
export function checkD205(model: D205): D205Check[] {
  const checks: D205Check[] = [];
  const add = (severity: D205Check['severity'], code: string, path: string, message: string) =>
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
      if (required) error('D205_TEXT', path, `Completați ${label}.`);
    } else if (trimmed.length > max)
      error('D205_TEXT', path, `Câmpul ${label} are cel mult ${max} caractere.`);
  };
  const { declarant, payer } = model;
  const validYear = isYear(model.year);
  if (!validYear) error('D205_YEAR', 'year', yearMessage);

  textField('declarant.lastName', declarant.lastName, 'numele declarantului', 75, true);
  textField('declarant.firstName', declarant.firstName, 'prenumele declarantului', 75, true);
  textField('declarant.role', declarant.role, 'funcția declarantului', 50, true);

  if (!isCui(payer.cui))
    error(
      'D205_CUI',
      'payer.cui',
      'Codul de identificare fiscală al plătitorului nu este valid; se scrie fără prefixul RO.',
    );
  if (payer.successorCui !== undefined && !isCui(payer.successorCui))
    error(
      'D205_CUI',
      'payer.successorCui',
      'Codul de identificare fiscală al succesorului nu este valid.',
    );
  textField('payer.name', payer.name, 'denumirea plătitorului', 200, true);
  textField('payer.address', payer.address, 'adresa domiciliului fiscal', 1000, true);
  textField('payer.phone', payer.phone, 'telefonul', 15);
  textField('payer.fax', payer.fax, 'faxul', 15);
  textField('payer.email', payer.email, 'e-mailul', 200);
  if (payer.email?.trim() && !isEmail(payer.email))
    warning('D205_EMAIL', 'payer.email', 'E-mailul plătitorului nu este valid.');

  const problems = inputProblems(model);
  for (const problem of problems) error(problem.code, problem.path, problem.message);

  const seen = new Set<string>();
  model.beneficiaries.forEach((beneficiary, index) => {
    const path = `beneficiaries.${index}`;
    if (beneficiary.kind === 'company') {
      warning(
        'D205_COMPANY',
        path,
        `Dividendele societății ${beneficiary.name} (CUI ${beneficiary.cui}) nu se declară în D205, care cuprinde doar persoane fizice.`,
      );
      return;
    }
    if (beneficiary.kind !== 'individual') return;
    textField(`${path}.name`, beneficiary.name, 'numele și prenumele beneficiarului', 100, true);
    if (!isCnp(beneficiary.cnp))
      error('D205_CNP', `${path}.cnp`, `CNP-ul beneficiarului ${beneficiary.name} nu este valid.`);
    else if (seen.has(beneficiary.cnp))
      error(
        'D205_DUPLICATE',
        `${path}.cnp`,
        'Un beneficiar se declară o singură dată; plățile lui se adună într-o înregistrare.',
      );
    seen.add(beneficiary.cnp);
    if (
      !model.correction &&
      beneficiary.payments.length +
        beneficiary.unpaid.length +
        (beneficiary.interest?.length ?? 0) +
        (beneficiary.rent?.length ?? 0) ===
        0
    )
      warning(
        'D205_EMPTY',
        path,
        `Beneficiarul ${beneficiary.name} nu are dividende în anul de raportare; o înregistrare cu zero șterge, într-o declarație rectificativă, înregistrarea inițială.`,
      );
  });

  // Dates, tax rates and tax against base, beneficiary by beneficiary.
  const rated = (path: string, distributedIn: number, gross: unknown, tax: unknown) => {
    if (!isAmount(gross) || !isAmount(tax)) return;
    if (tax > gross) {
      error('D205_TAX', `${path}.tax`, 'Impozitul nu poate depăși dividendele brute.');
      return;
    }
    const rate = d205DividendRates[distributedIn];
    if (rate === undefined) return;
    const expected = percent(gross, rate);
    if (BigInt(tax) < expected - 1n || BigInt(tax) > expected + 1n)
      warning(
        'D205_TAX',
        `${path}.tax`,
        `Impozitul (${tax}) diferă de ${rate}% din ${gross} lei (${expected}), cota dividendelor distribuite în ${distributedIn}.`,
      );
  };
  model.beneficiaries.forEach((beneficiary, index) => {
    const path = `beneficiaries.${index}`;
    beneficiary.payments.forEach((payment, item) => {
      const at = `${path}.payments.${item}`;
      if (!isDate(payment.date))
        error('D205_DATE', `${at}.date`, `Data plății ${payment.date} nu este validă.`);
      else if (yearOf(payment.date) !== model.year)
        error(
          'D205_DATE',
          `${at}.date`,
          `Plata din ${payment.date} nu este din anul de raportare ${model.year}.`,
        );
      else if (isDate(payment.distributed) && payment.distributed > payment.date)
        error('D205_DATE', `${at}.distributed`, 'Dividendele se plătesc după distribuire.');
      if (isDate(payment.distributed))
        rated(at, yearOf(payment.distributed), payment.gross, payment.tax);
    });
    beneficiary.unpaid.forEach((unpaid, item) =>
      rated(`${path}.unpaid.${item}`, model.year, unpaid.gross, unpaid.tax),
    );
    if (beneficiary.kind !== 'individual') return;
    beneficiary.rent?.forEach((paid, item) => {
      const at = `${path}.rent.${item}`;
      if (!isDate(paid.date) || yearOf(paid.date) !== model.year)
        error(
          'D205_DATE',
          `${at}.date`,
          `Chiria plătită la ${paid.date} nu este din anul ${model.year}.`,
        );
      if (!isAmount(paid.base) || !isAmount(paid.tax)) return;
      const expected = percent(paid.base, d205RentRate);
      if (BigInt(paid.tax) < expected - 1n || BigInt(paid.tax) > expected + 1n)
        warning(
          'D205_TAX',
          `${at}.tax`,
          `Impozitul (${paid.tax}) diferă de ${d205RentRate}% din venitul net de ${paid.base} lei (${expected}).`,
        );
    });
    beneficiary.interest?.forEach((paid, item) => {
      const at = `${path}.interest.${item}`;
      if (!isDate(paid.date) || yearOf(paid.date) !== model.year)
        error(
          'D205_DATE',
          `${at}.date`,
          `Dobânda plătită la ${paid.date} nu este din anul ${model.year}.`,
        );
      if (!isAmount(paid.gross) || !isAmount(paid.tax)) return;
      if (paid.tax > paid.gross)
        error('D205_TAX', `${at}.tax`, 'Impozitul nu poate depăși dobânda brută.');
      else {
        const expected = percent(paid.gross, d205InterestRate);
        if (BigInt(paid.tax) < expected - 1n || BigInt(paid.tax) > expected + 1n)
          warning(
            'D205_TAX',
            `${at}.tax`,
            `Impozitul (${paid.tax}) diferă de ${d205InterestRate}% din dobânda de ${paid.gross} lei (${expected}).`,
          );
      }
    });
  });

  if (problems.length || !validYear) return checks;
  const calculation = calculateD205(model);
  if (calculation.records.length === 0) error('D205_BENEFICIARIES', 'beneficiaries', noRecords);
  const totals = [
    calculation.controlSum,
    ...calculation.records.flatMap((record) => [record.distributed, record.paid]),
  ];
  if (totals.some((value) => value > maxAmount))
    error('D205_TOTAL', 'beneficiaries', 'Un total al declarației depășește 15 cifre.');
  return checks;
}
