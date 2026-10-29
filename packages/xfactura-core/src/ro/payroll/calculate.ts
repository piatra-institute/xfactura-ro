import { parseScaled } from '../../money';
import { RuleGapError, type RuleContext } from '../../rules';
import { monthStart, type Month } from '../../time';
import type { DeductionTable, MinimumWageRelief, SupplementaryDeduction } from './parameters';

/**
 * Pay items by how the Fiscal Code treats them: salary in money is in every base; meal and
 * holiday vouchers are salary income for the tax (art. 76 alin. (3) lit. h)) and in the CASS
 * base (art. 157), but not in the CAS or CAM bases (art. 142 lit. r), art. 220^4). Leave pay,
 * sick leave and benefits in kind have their own rules and are not modelled yet.
 */
export const payItemKinds = ['salary', 'meal_vouchers', 'holiday_vouchers'] as const;
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
  minimumExemption: MinimumExemption | null;
}

export type PayStep = { code: string; amount: bigint; clauses: readonly string[] };
export type PayIssue = { code: string; message: string };

/** Every amount is in bani; contributions, the tax base and the tax are whole lei. */
export interface PayResult {
  minimumWage: bigint;
  gross: bigint;
  cash: bigint;
  vouchers: bigint;
  /** The minimum-wage amount left out of the bases. */
  relief: bigint;
  casBase: bigint;
  cassBase: bigint;
  camBase: bigint;
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

  const cash = sum(input.items.filter((item) => item.kind === 'salary').map((item) => item.amount));
  const vouchers = sum(
    input.items.filter((item) => item.kind !== 'salary').map((item) => item.amount),
  );
  const gross = step('gross', cash + vouchers, [code('art.76(3)(h)')]);
  const fullTime = input.dailyHours === 8;
  const hours = BigInt(input.dailyHours);

  // The base salary is at least the minimum wage for the contract's working time.
  if (input.baseSalary * 8n < minimumWage * hours)
    issues.push({
      code: 'BELOW_MINIMUM_WAGE',
      message: 'Salariul de bază este sub salariul minim brut pe țară pentru norma contractului.',
    });

  // The minimum-wage relief: only where the text to obtain (OUG 89/2025) is unambiguous, a full
  // month of a full-time contract whose base salary is the minimum wage.
  let relief = 0n;
  if (input.baseSalary * 8n === minimumWage * hours) {
    if (!fullTime || !input.mainJob || input.activeDays !== input.workingDays)
      issues.push({
        code: 'RELIEF_UNSETTLED',
        message:
          'Suma neimpozabilă pentru salariul minim, la timp parțial, în afara funcției de bază sau pentru o lună incompletă, se stabilește după textul OUG nr. 89/2025, încă neobținut.',
      });
    else {
      const { amount, grossCeiling } = param<MinimumWageRelief>('ro.payroll.minimum_wage_relief');
      if (cash <= BigInt(grossCeiling) * 100n) relief = min(BigInt(amount) * 100n, cash);
    }
  }
  if (relief) step('relief', relief, [D112]);

  const casRate = param<string>('ro.payroll.cas.rate');
  const cassRate = param<string>('ro.payroll.cass.rate');
  const casBase = step('cas.base', cash - relief, [code('art.139(1)'), code('art.142(r)')]);
  const cassBase = step('cass.base', gross - relief, [code('art.157')]);
  const camBase = step('cam.base', cash - relief, [code('art.220^4')]);
  const cas = step('cas', contribution(casBase, casRate), [code('art.138(a)')]);
  const cass = step('cass', contribution(cassBase, cassRate), [code('art.156')]);

  // The minimum contribution, for the contract's active working days: on the minimum wage less
  // the minimum-wage relief, in whole lei, as ANAF's D112 structure computes it. The relief only
  // lowers it, so it is read only when the contributions could fall below the minimum's.
  let casEmployer = 0n;
  let cassEmployer = 0n;
  if (!input.minimumExemption && input.activeDays > 0) {
    const days = BigInt(input.activeDays);
    const of = BigInt(input.workingDays);
    if (casBase * of < minimumWage * days || cassBase * of < minimumWage * days) {
      const { amount } = param<MinimumWageRelief>('ro.payroll.minimum_wage_relief');
      const minimumBase = toLeu((minimumWage - BigInt(amount) * 100n) * days, of, amountRounding);
      casEmployer = max(0n, contribution(minimumBase, casRate) - cas);
      cassEmployer = max(0n, contribution(minimumBase, cassRate) - cass);
      if (casEmployer || cassEmployer) step('minimum.base', minimumBase, [D112]);
    }
    if (casEmployer) step('cas.employer', casEmployer, [code('art.146(5^6)-(5^9)')]);
    if (cassEmployer) step('cass.employer', cassEmployer, [code('art.168(6^1)')]);
  }

  // The tax: on the net income, less the personal deduction and union dues at the main job.
  const netIncome = gross - relief - cas - cass;
  let basic = 0n;
  let young = 0n;
  let children = 0n;
  if (input.mainJob) {
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
  const unionDeducted = input.mainJob ? input.unionDues : 0n;
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
    [code('art.78(2)(a)'), code('norme.art.64.pct.4')],
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
    relief,
    casBase,
    cassBase,
    camBase,
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
    cost: gross + casEmployer + cassEmployer + cam,
    steps,
  };
  return { result: issues.length ? null : result, issues };
}
