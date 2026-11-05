import { parseScaled } from '../../money';
import { RuleGapError, type RuleContext } from '../../rules';
import { monthStart, type Month } from '../../time';
import type { DeductionTable, MinimumWageRelief, SupplementaryDeduction } from './parameters';

/**
 * Pay items by how the Fiscal Code treats them: money paid as salary, bonuses or annual leave pay
 * is in every base; meal and holiday vouchers are salary income for the tax (art. 76 alin. (3)
 * lit. h)) and in the CASS base (art. 157), but not in the CAS or CAM bases (art. 142 lit. r),
 * art. 220^4). Bonuses are kept apart because annual leave pay is averaged without them. The sick
 * pay for ordinary illness (code 01), the employer's part and the fund's, is salary income for the
 * tax (art. 76 alin. (1)) and in the CAS and CASS bases (art. 139 alin. (1) lit. o), art. 157
 * alin. (1) lit. v)); the fund's part is not in the CAM base (art. 220^5). The other indemnity
 * codes (`ro.sick.codes`): those of incapacity other than 01 are taxed but outside the CASS base
 * (art. 155 alin. (1) lit. i)); those FNUASS bears for maternity, maternal risk and care are
 * neither taxed (art. 62 lit. c)) nor in the CASS base; all are in the CAS base (art. 139 alin. (1)
 * lit. o)), none borne by FNUASS in CAM's (art. 220^5). The indemnity of a work accident or
 * occupational disease (Legea nr. 346/2002, codes 02–04) is salary income for the tax (art. 76
 * alin. (1)), outside the CASS base (art. 155 alin. (1) lit. i), norme pct. 3 alin. (9)) and the
 * CAS base (the state budget's part: art. 141 lit. a), norme pct. 41; the employer's 3 days as
 * D112 computes B4_7, from OUG nr. 158/2005's indemnities only), its state budget's part outside
 * CAM's (art. 220^5); that part is recovered from the pension house like FNUASS's, on 4382. A
 * benefit in kind (`benefit`, valued by
 * `evaluateBenefits`) is income not paid in money, in every base (art. 139 alin. (1) lit. a), 157
 * alin. (1) lit. a), 220^4 alin. (1) lit. a)).
 */
export const payItemKinds = [
  'salary',
  'bonus',
  'leave',
  'meal_vouchers',
  'holiday_vouchers',
  'sick_employer',
  'sick_fund',
  'sick_employer_nocass',
  'sick_fund_nocass',
  'sick_fund_exempt',
  'accident_employer',
  'accident_fund',
  'benefit',
] as const;
const sickKinds: readonly PayItemKind[] = [
  'sick_employer',
  'sick_fund',
  'sick_employer_nocass',
  'sick_fund_nocass',
  'sick_fund_exempt',
];
const fundKinds: readonly PayItemKind[] = ['sick_fund', 'sick_fund_nocass', 'sick_fund_exempt'];
const accidentKinds: readonly PayItemKind[] = ['accident_employer', 'accident_fund'];
const moneyKinds: readonly PayItemKind[] = [
  'salary',
  'bonus',
  'leave',
  ...sickKinds,
  ...accidentKinds,
];
const voucherKinds: readonly PayItemKind[] = ['meal_vouchers', 'holiday_vouchers'];
export type PayItemKind = (typeof payItemKinds)[number];

/** Why the minimum contribution for the contract's active days does not apply (art. 146 alin.
 * (5^7)): pupils and students up to 26, apprentices up to 18, people with disabilities allowed
 * shorter days, old-age pensioners, and several contracts together at least the minimum wage. */
export const minimumExemptions = [
  'student',
  'apprentice',
  'disability',
  'pensioner',
  'other_contracts',
] as const;
export type MinimumExemption = (typeof minimumExemptions)[number];

export interface PayInput {
  month: Month;
  /** The contract's monthly base salary for its working time, in bani. */
  baseSalary: bigint;
  /** Contract hours per working day; 8 is full time. */
  dailyHours: number;
  /** Funcția de bază: the personal deduction and union dues reduce the tax only there. */
  mainJob: boolean;
  /** Working days in the month, and those in which the contract was active (not suspended). */
  workingDays: number;
  activeDays: number;
  /** What the employee earned for the month, in bani. */
  items: readonly { kind: PayItemKind; amount: bigint; label: string }[];
  dependents: number;
  under26: boolean;
  childrenInSchool: number;
  /** Union dues withheld this month, in bani. */
  unionDues: bigint;
  /** The base salary was lowered since the minimum-wage relief's ordinance: no relief. */
  baseReduced?: boolean;
  minimumExemption: MinimumExemption | null;
  /** Remuneration under an administration or mandate contract (art. 76 alin. (2) lit. o)), not
   * an employment contract: no minimum wage, minimum-wage relief or minimum contribution (art.
   * 146 alin. (5^6) is for employment contracts). */
  mandate?: boolean;
}

export type PayStep = { code: string; amount: bigint; clauses: readonly string[] };
export type PayIssue = { code: string; message: string };

/** Every amount is in bani; contributions, the tax base and the tax are whole lei. */
export interface PayResult {
  minimumWage: bigint;
  /** Salary income for the tax: money, vouchers and benefits in kind, without the indemnities
   * art. 62 lit. c) leaves out. */
  gross: bigint;
  cash: bigint;
  vouchers: bigint;
  /** Benefits in kind, taxable. */
  inKind: bigint;
  /** Indemnities paid in money that are not taxed (art. 62 lit. c)). */
  exempt: bigint;
  /** The minimum-wage amount left out of the bases. */
  relief: bigint;
  casBase: bigint;
  cassBase: bigint;
  camBase: bigint;
  /** The sick pay borne by the employer and by the health insurance fund (FNUASS), which the
   * employer pays and recovers. */
  sickEmployer: bigint;
  sickFund: bigint;
  /** A work accident's or occupational disease's indemnity: the employer's days, and the state
   * social insurance budget's, which the employer pays and recovers from the pension house. */
  accidentEmployer: bigint;
  accidentFund: bigint;
  /** Withheld from the employee. */
  cas: bigint;
  cass: bigint;
  /** The difference up to the minimum contribution, borne by the employer in the employee's
   * name (art. 146 alin. (5^9)). */
  casEmployer: bigint;
  cassEmployer: bigint;
  deduction: { basic: bigint; young: bigint; children: bigint; total: bigint };
  taxBase: bigint;
  tax: bigint;
  unionDues: bigint;
  /** Paid to the employee in money. */
  net: bigint;
  cam: bigint;
  /** What the month costs the employer: gross, contributions borne for the employee and CAM. */
  cost: bigint;
  steps: PayStep[];
}

const code = (clause: string) => `ANAF/Cod-fiscal-consolidat:${clause}`;
const D112 = 'ANAF/D112-0726:salariul-minim';
const sum = (values: readonly bigint[]) => values.reduce((total, value) => total + value, 0n);
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** `numerator / denominator` bani, rounded to whole lei. */
function toLeu(numerator: bigint, denominator: bigint, mode: 'leu_half_up' | 'leu_half_down') {
  const whole = numerator / (denominator * 100n);
  const twice = 2n * (numerator - whole * denominator * 100n);
  const up = mode === 'leu_half_up' ? twice >= denominator * 100n : twice > denominator * 100n;
  return (up ? whole + 1n : whole) * 100n;
}

/** `amount × percent / 100`, with the percent read at four decimals. */
const ofPercent = (amount: bigint, percent: string) => ({
  numerator: amount * parseScaled(percent, 4),
  denominator: 1_000_000n,
});

/**
 * One employee's pay for a month under one contract: gross to net, the contributions withheld
 * and those borne by the employer, and the tax (Codul fiscal art. 77, 78, 138–146, 156–168,
 * 220^1–220^6). Rule gaps and inputs the rules do not settle come back as issues, never as a
 * guessed amount.
 */
export function calculatePay(
  input: PayInput,
  rules: RuleContext,
): { result: PayResult | null; issues: PayIssue[] } {
  const issues: PayIssue[] = [];
  if (
    !Number.isInteger(input.workingDays) ||
    !Number.isInteger(input.activeDays) ||
    input.workingDays < 1 ||
    input.activeDays < 0 ||
    input.activeDays > input.workingDays
  )
    issues.push({ code: 'DAYS', message: 'Zilele lucrătoare și zilele active nu sunt coerente.' });
  if (!Number.isInteger(input.dailyHours) || input.dailyHours < 1 || input.dailyHours > 8)
    issues.push({ code: 'HOURS', message: 'Norma zilnică este între 1 și 8 ore.' });
  if (
    input.baseSalary < 0n ||
    input.unionDues < 0n ||
    input.items.some((item) => item.amount < 0n) ||
    !Number.isInteger(input.dependents) ||
    input.dependents < 0 ||
    !Number.isInteger(input.childrenInSchool) ||
    input.childrenInSchool < 0
  )
    issues.push({ code: 'AMOUNTS', message: 'Sumele și numărul persoanelor nu pot fi negative.' });
  if (issues.length) return { result: null, issues };

  try {
    return compute(input, rules);
  } catch (error) {
    if (!(error instanceof RuleGapError)) throw error;
    return { result: null, issues: [{ code: 'RULE_GAP', message: error.message }] };
  }
}

function compute(input: PayInput, rules: RuleContext) {
  const issues: PayIssue[] = [];
  const at = monthStart(input.month);
  const param = <T>(key: string) => rules.param<T>(key, 'payroll_month_start', at);
  const amountRounding = param<'leu_half_up'>('ro.payroll.amount_rounding');
  const contribution = (amount: bigint, percent: string) => {
    const { numerator, denominator } = ofPercent(amount, percent);
    return toLeu(numerator, denominator, amountRounding);
  };
  const minimumWage = BigInt(param<string>('ro.payroll.minimum_wage')) * 100n;
  const steps: PayStep[] = [];
  const step = (stepCode: string, amount: bigint, clauses: readonly string[]) => {
    steps.push({ code: stepCode, amount, clauses });
    return amount;
  };

  const ofKind = (kinds: readonly PayItemKind[]) =>
    sum(input.items.filter((item) => kinds.includes(item.kind)).map((item) => item.amount));
  const cash = ofKind(moneyKinds);
  const vouchers = ofKind(voucherKinds);
  const inKind = ofKind(['benefit']);
  const sick = ofKind(sickKinds);
  const sickEmployer = ofKind(['sick_employer', 'sick_employer_nocass']);
  const sickFund = ofKind(fundKinds);
  const exempt = ofKind(['sick_fund_exempt']);
  const noCass = ofKind(['sick_employer_nocass', 'sick_fund_nocass', 'sick_fund_exempt']);
  const accidentEmployer = ofKind(['accident_employer']);
  const accidentFund = ofKind(['accident_fund']);
  const accident = accidentEmployer + accidentFund;
  const mandate = input.mandate === true;
  if (inKind) step('benefits', inKind, [code('art.76(3)')]);
  if (exempt) step('sick.exempt', exempt, [code('art.62(c)')]);
  const gross = step('gross', cash + vouchers + inKind - exempt, [
    code('art.76(3)(h)'),
    ...(sick || accident ? [code('art.76(1)')] : []),
    ...(mandate ? [code('art.76(2)(o)')] : []),
  ]);
  const fullTime = input.dailyHours === 8;
  const hours = BigInt(input.dailyHours);

  // The base salary is at least the minimum wage for the contract's working time.
  if (!mandate && input.baseSalary * 8n < minimumWage * hours)
    issues.push({
      code: 'BELOW_MINIMUM_WAGE',
      message: 'Salariul de bază este sub salariul minim brut pe țară pentru norma contractului.',
    });

  // The minimum-wage relief (OUG 156/2024 art. LXVI for 2025, OUG 89/2025 art. III for 2026): a
  // full-time contract at the main job whose base salary is the minimum wage, not lowered since
  // the ordinance, with salary in money up to the ceiling. For part of a month the law lists what
  // reduces the amount but not how, so such a month is left to the expert.
  let relief = 0n;
  if (
    !mandate &&
    fullTime &&
    input.mainJob &&
    !input.baseReduced &&
    input.baseSalary === minimumWage
  ) {
    const { amount, grossCeiling } = param<MinimumWageRelief>('ro.payroll.minimum_wage_relief');
    if (cash <= BigInt(grossCeiling) * 100n) {
      if (input.activeDays !== input.workingDays)
        issues.push({
          code: 'RELIEF_UNSETTLED',
          message:
            'Suma neimpozabilă pentru salariul minim se diminuează pentru o lună incompletă (OUG nr. 89/2025 art. III alin. (4)), fără ca textul să arate cum: stabiliți-o cu expertul contabil.',
        });
      else if (inKind)
        issues.push({
          code: 'RELIEF_BENEFIT',
          message:
            'OUG nr. 89/2025 art. III nu spune dacă avantajele în natură intră în plafonul venitului brut al sumei neimpozabile: stabiliți luna cu expertul contabil.',
        });
      else relief = min(BigInt(amount) * 100n, cash);
    }
  }
  if (relief) step('relief', relief, [D112]);

  const casRate = param<string>('ro.payroll.cas.rate');
  const cassRate = param<string>('ro.payroll.cass.rate');
  if (sickEmployer) step('sick.employer', sickEmployer, [code('art.139(1)(o)')]);
  // What the employer pays and recovers, from FNUASS and from the pension house: the booking
  // reads it as one claim (4382).
  if (sickFund || accidentFund)
    step('sick.fund', sickFund + accidentFund, [
      ...(sickFund ? [code('art.139(1)(o)')] : []),
      ...(accidentFund ? ['L346/2002-A:art.34'] : []),
    ]);
  if (accident) step('accident', accident, ['L346/2002-A:art.33', 'L346/2002-A:art.34']);
  const casBase = step('cas.base', cash + inKind - relief - accident, [
    code('art.139(1)'),
    code('art.142(r)'),
    ...(sick ? [code('art.139(1)(o)')] : []),
    ...(accident ? [code('art.141(a)'), code('norme.art.141.pct.41')] : []),
    ...(mandate ? [code('art.139(1)(d)')] : []),
  ]);
  const cassBase = step('cass.base', cash + vouchers + inKind - noCass - accident - relief, [
    code('art.157'),
    ...(sick ? [code('art.157(1)(v)')] : []),
    ...(noCass || accident ? [code('art.155(1)(i)')] : []),
    ...(mandate ? [code('art.157(1)(e)')] : []),
  ]);
  const camBase = step('cam.base', cash + inKind - relief - sickFund - accidentFund, [
    code('art.220^4'),
    ...(sickFund || accidentFund ? [code('art.220^5')] : []),
    ...(mandate ? [code('art.220^4(1)(d)')] : []),
  ]);
  const cas = step('cas', contribution(casBase, casRate), [code('art.138(a)')]);
  const cass = step('cass', contribution(cassBase, cassRate), [code('art.156')]);

  // The minimum contribution, for the contract's active working days: on the minimum wage less
  // the minimum-wage relief, in whole lei, as ANAF's D112 structure computes it. The relief only
  // lowers it, so it is read only when the contributions could fall below the minimum's. Sick
  // pay is for the days the contract is suspended, so it does not count towards the minimum.
  let casEmployer = 0n;
  let cassEmployer = 0n;
  if (!mandate && !input.minimumExemption && input.activeDays > 0) {
    const days = BigInt(input.activeDays);
    const of = BigInt(input.workingDays);
    const activeCas = casBase - sick;
    // Only the indemnities in the CASS base come off it: those outside it never entered.
    const activeCass = cassBase - (sick - noCass);
    if (activeCas * of < minimumWage * days || activeCass * of < minimumWage * days) {
      const { amount } = param<MinimumWageRelief>('ro.payroll.minimum_wage_relief');
      const minimumBase = toLeu((minimumWage - BigInt(amount) * 100n) * days, of, amountRounding);
      casEmployer = max(0n, contribution(minimumBase, casRate) - contribution(activeCas, casRate));
      cassEmployer = max(
        0n,
        contribution(minimumBase, cassRate) - contribution(activeCass, cassRate),
      );
      if (casEmployer || cassEmployer) step('minimum.base', minimumBase, [D112]);
    }
    if (casEmployer) step('cas.employer', casEmployer, [code('art.146(5^6)-(5^9)')]);
    if (cassEmployer) step('cass.employer', cassEmployer, [code('art.168(6^1)')]);
  }

  // The tax: on the net income, less the personal deduction and union dues at the main job. The
  // CAS of an indemnity the tax leaves out is not deducted from the taxable income.
  const casTaxable = exempt ? contribution(casBase - exempt, casRate) : cas;
  if (exempt) step('cas.taxable', casTaxable, [code('art.78(2)(a)'), code('art.62(c)')]);
  const netIncome = gross - relief - casTaxable - cass;
  let basic = 0n;
  let young = 0n;
  let children = 0n;
  // A mandate's remuneration is deducted from only where the person declares the main job there
  // (`ro.payroll.mandate.deduction`, an interpretation awaiting review).
  const deducts =
    input.mainJob &&
    (!mandate ||
      param<'main_job_declared'>('ro.payroll.mandate.deduction') === 'main_job_declared');
  if (deducts) {
    const table = param<DeductionTable>('ro.payroll.personal_deduction');
    const supplementary = param<SupplementaryDeduction>('ro.payroll.supplementary_deduction');
    const excess = gross - minimumWage;
    const stepBani = BigInt(table.step) * 100n;
    const band = excess <= 0n ? 0 : Number((excess + stepBani - 1n) / stepBani);
    const row = table.rows[band];
    const withinSpan = excess <= BigInt(table.span) * 100n;
    // Whole lei, rounded arithmetically, as the D112 declares the deductions.
    const percentOfMinimum = (percent: string) => {
      const { numerator, denominator } = ofPercent(minimumWage, percent);
      return toLeu(numerator, denominator, 'leu_half_up');
    };
    if (row && withinSpan) basic = percentOfMinimum(row[Math.min(input.dependents, 4)]!);
    if (input.under26 && withinSpan) young = percentOfMinimum(supplementary.youngPercent);
    children = BigInt(supplementary.perChild) * 100n * BigInt(input.childrenInSchool);
  }
  const unionDeducted = deducts ? input.unionDues : 0n;
  const total = min(basic + young + children, max(0n, netIncome - unionDeducted));
  if (basic) step('deduction.basic', basic, [code('art.77'), D112]);
  if (young) step('deduction.young', young, [code('art.77'), D112]);
  if (children) step('deduction.children', children, [code('art.77')]);
  if (total !== basic + young + children) step('deduction.limited', total, [code('art.77')]);
  if (unionDeducted) step('union', unionDeducted, [code('art.78(2)(a)')]);
  const taxBase = step(
    'tax.base',
    toLeu(
      max(0n, netIncome - total - unionDeducted),
      1n,
      param<'leu_half_down'>('ro.payroll.tax_base_rounding'),
    ),
    [code(deducts ? 'art.78(2)(a)' : 'art.78(2)(b)'), code('norme.art.64.pct.4')],
  );
  const tax = step('tax', contribution(taxBase, param<string>('ro.payroll.income_tax.rate')), [
    code('art.64(1)(b)'),
  ]);
  const net = step('net', cash - cas - cass - tax - input.unionDues, []);
  if (net < 0n)
    issues.push({
      code: 'NEGATIVE_NET',
      message: 'Reținerile depășesc suma de plată în bani.',
    });
  const cam = step('cam', contribution(camBase, param<string>('ro.payroll.cam.rate')), [
    code('art.220^3(1)'),
  ]);
  const result: PayResult = {
    minimumWage,
    gross,
    cash,
    vouchers,
    inKind,
    exempt,
    relief,
    casBase,
    cassBase,
    camBase,
    sickEmployer,
    sickFund,
    accidentEmployer,
    accidentFund,
    cas,
    cass,
    casEmployer,
    cassEmployer,
    deduction: { basic, young, children, total },
    taxBase,
    tax,
    unionDues: input.unionDues,
    net,
    cam,
    cost: cash + vouchers + inKind + casEmployer + cassEmployer + cam,
    steps,
  };
  return { result: issues.length ? null : result, issues };
}
