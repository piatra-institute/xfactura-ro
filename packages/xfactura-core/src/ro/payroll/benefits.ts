import { parseScaled } from '../../money';
import type { RuleContext } from '../../rules';
import { monthStart, type Month } from '../../time';
import type { BenefitLimits, CarBenefit, VoucherLimits } from './parameters';

/**
 * Benefits in kind (avantaje în natură, Codul fiscal art. 76 alin. (3)–(4^2)), valued as the
 * methodological norms value them (pct. 12 alin. (4)–(9)) and split into what is taxable salary
 * income and what the law leaves out of income:
 *
 * - a vehicle used privately: 1.7% of its input value for each month, or the rent when it is
 *   rented from a third party, in proportion to the private kilometres for mixed use (norme pct. 12
 *   alin. (5) lit. a), (6) lit. a)), commuting not counted (alin. (9)); none for a vehicle whose
 *   expenses are deductible at 50% (art. 76 alin. (4) lit. ț)) or, at a micro-enterprise, one of
 *   art. 25 alin. (3) lit. l) not used exclusively for the business (lit. ț^1));
 * - housing put at the employee's disposal: within 20% of the minimum wage when the conditions of
 *   art. 76 alin. (4^1) lit. c) hold, and within the monthly 33% of the base salary that alin.
 *   (4^1) caps together, in the order the employer sets (alin. (4^2));
 * - gifts at Easter, Christmas and similar holidays, 8 March and 1 June: 300 lei per person and
 *   occasion (art. 76 alin. (4) lit. a)); any other gift is income;
 * - insurance premiums: voluntary health insurance and medical subscriptions within 400 euro a
 *   year (alin. (4^1) lit. f)), within the 33%; other premiums not mandatory are income when paid
 *   (alin. (3) lit. g));
 * - anything else a person states is a taxable benefit (art. 76 alin. (2) lit. s)), with its
 *   basis; vouchers above the limits of Legea nr. 165/2018 become one by themselves
 *   (`voucherExcess`).
 *
 * What is taxable is salary income in every base: tax, CAS (art. 139 alin. (1) lit. a)), CASS
 * (art. 157 alin. (1) lit. a), u)) and CAM (art. 220^4 alin. (1) lit. a), n)); what the law leaves
 * out is in none (art. 142 lit. b), s), aa^1), 157 alin. (2), 220^4 alin. (2)). D112 declares both:
 * the taxable part in E3_44 or E3_58, the exempt part in E3_86, E3_78 or E3_71.
 */

export const benefitKinds = ['car', 'housing', 'gift', 'insurance', 'other'] as const;
export type BenefitKind = (typeof benefitKinds)[number];
export const giftOccasions = ['religious_holiday', 'march_8', 'june_1', 'other'] as const;
export type GiftOccasion = (typeof giftOccasions)[number];

/** Where D112 declares a benefit's part (asiguratE3). */
export type BenefitField = 'E3_44' | 'E3_58' | 'E3_86' | 'E3_78' | 'E3_71';

export type BenefitInput =
  | {
      kind: 'car';
      label: string;
      /** The vehicle's input value (valoarea de intrare), in bani; null when it is rented. */
      inputValue: bigint | null;
      /** The month's rent paid to a third party, in bani; null when the company owns it. */
      rent: bigint | null;
      /** Private and total kilometres of the month for mixed use; null when used only privately.
       * Commuting is not private use (norme pct. 12 alin. (9)). */
      km: { personal: number; total: number } | null;
      /** A passenger vehicle of art. 25 alin. (3) lit. l) (up to 3,500 kg, up to 9 seats). */
      passenger: boolean;
      /** Used exclusively for the business (art. 25 alin. (3) lit. l) pct. 1–6). */
      exclusiveBusiness: boolean;
    }
  | {
      kind: 'housing';
      label: string;
      /** The rent the employer pays, or the value of its own housing, in bani. */
      value: bigint;
      /** The employee declared the conditions of art. 76 alin. (4^1) lit. c) (no home in the
       * locality, the space rented under a contract, one of the spouses). */
      conditions: boolean;
    }
  | {
      kind: 'gift';
      label: string;
      occasion: GiftOccasion;
      /** The value for each person: the employee and each minor child, in bani. */
      persons: readonly { recipient: 'employee' | 'child'; value: bigint }[];
    }
  | {
      kind: 'insurance';
      label: string;
      premium: bigint;
      /** Voluntary health insurance or a medical subscription (alin. (4^1) lit. f)). */
      health: boolean;
      /** For health insurance: the BNR EUR rate of the month's last day, and what earlier months
       * of the year already left out of income, in euro cents. */
      eurRate: string | null;
      yearToDateCents: bigint;
    }
  | {
      kind: 'other';
      label: string;
      value: bigint;
      /** Why it is income, in the person's words. */
      basis: string;
    };

export type BenefitPart = { field: BenefitField; amount: bigint };
export type BenefitResult = {
  kind: BenefitKind;
  label: string;
  taxable: BenefitPart[];
  exempt: BenefitPart[];
  /** Health insurance left out this month, in euro cents, for the year's running total. */
  exemptCents: bigint;
  steps: { code: string; amount: bigint; clauses: readonly string[] }[];
};
export type BenefitIssue = { code: string; message: string };

const code = (clause: string) => `ANAF/Cod-fiscal-consolidat:${clause}`;
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const sum = (values: readonly bigint[]) => values.reduce((total, value) => total + value, 0n);
/** `numerator / denominator` rounded half up to the ban. */
const halfUp = (numerator: bigint, denominator: bigint) =>
  (2n * numerator + denominator) / (2n * denominator);

/**
 * Values a month's benefits for one contract. `baseSalary` is the contract's base salary (the
 * 33% cap of alin. (4^1)); `minimumWage` the month's, in bani. The benefits are taken in the
 * order given, the employer's order for the 33% cap (art. 76 alin. (4^2)).
 */
export function evaluateBenefits(
  month: Month,
  benefits: readonly BenefitInput[],
  context: { baseSalary: bigint; minimumWage: bigint; micro: boolean | null },
  rules: RuleContext,
): { results: BenefitResult[]; issues: BenefitIssue[] } {
  const at = monthStart(month);
  const issues: BenefitIssue[] = [];
  const results: BenefitResult[] = [];
  const limits = rules.param<BenefitLimits>('ro.payroll.benefit.limits', 'payroll_month_start', at);
  // The monthly 33% of the base salary the alin. (4^1) items share.
  let capLeft = halfUp(context.baseSalary * parseScaled(limits.capPercentOfBase, 4), 1_000_000n);
  const capped = (amount: bigint) => {
    const used = min(amount, max(0n, capLeft));
    capLeft -= used;
    return used;
  };
  for (const benefit of benefits) {
    const steps: BenefitResult['steps'] = [];
    const result: BenefitResult = {
      kind: benefit.kind,
      label: benefit.label,
      taxable: [],
      exempt: [],
      exemptCents: 0n,
      steps,
    };
    if (benefit.kind === 'car') {
      const car = rules.param<CarBenefit>('ro.payroll.benefit.car', 'payroll_month_start', at);
      if ((benefit.inputValue === null) === (benefit.rent === null)) {
        issues.push({
          code: 'BENEFIT_CAR',
          message: `${benefit.label}: completați fie valoarea de intrare a vehiculului, fie chiria plătită terțului (norme pct. 12 alin. (5) lit. a)).`,
        });
        continue;
      }
      if (benefit.km && (benefit.km.total <= 0 || benefit.km.personal > benefit.km.total)) {
        issues.push({
          code: 'BENEFIT_CAR',
          message: `${benefit.label}: kilometrii în interes personal nu pot depăși totalul lunii.`,
        });
        continue;
      }
      // Art. 76 alin. (4) lit. ț) and ț^1): a passenger vehicle not used only for the business
      // is not a benefit, whether its expenses are deductible at 50% or the company is a micro.
      if (benefit.passenger && !benefit.exclusiveBusiness) {
        if (context.micro === null) {
          issues.push({
            code: 'BENEFIT_CAR_REGIME',
            message: `${benefit.label}: regimul de impozitare al companiei în lună nu este înregistrat (art. 76 alin. (4) lit. ț) pentru impozitul pe profit, lit. ț^1) pentru microîntreprinderi).`,
          });
          continue;
        }
        steps.push({
          code: 'benefit.car.exempt',
          amount: 0n,
          clauses: [code(context.micro ? 'art.76(4)(ț1)' : 'art.76(4)(ț)'), code('art.142(s)')],
        });
        results.push(result);
        continue;
      }
      const monthly =
        benefit.rent ??
        halfUp(benefit.inputValue! * parseScaled(car.monthlyPercent, 4), 1_000_000n);
      const value = benefit.km
        ? halfUp(monthly * BigInt(benefit.km.personal), BigInt(benefit.km.total))
        : monthly;
      steps.push({
        code: benefit.rent === null ? 'benefit.car.monthly' : 'benefit.car.rent',
        amount: monthly,
        clauses: [code('norme.art.76.pct.12(5)')],
      });
      steps.push({
        code: 'benefit.car',
        amount: value,
        clauses: [code('art.76(3)(a)'), ...(benefit.km ? [code('norme.art.76.pct.12(6)')] : [])],
      });
      if (value) result.taxable.push({ field: 'E3_44', amount: value });
    } else if (benefit.kind === 'housing') {
      const ceiling = benefit.conditions
        ? halfUp(context.minimumWage * parseScaled(limits.housingPercentOfMinimum, 4), 1_000_000n)
        : 0n;
      const exempt = capped(min(benefit.value, ceiling));
      if (exempt) {
        result.exempt.push({ field: 'E3_78', amount: exempt });
        steps.push({
          code: 'benefit.housing.exempt',
          amount: exempt,
          clauses: [code('art.76(4^1)(c)')],
        });
      }
      const taxable = benefit.value - exempt;
      if (taxable) {
        result.taxable.push({ field: 'E3_44', amount: taxable });
        steps.push({
          code: 'benefit.housing',
          amount: taxable,
          clauses: [code('art.76(3)(b)'), code('norme.art.76.pct.12(5)')],
        });
      }
    } else if (benefit.kind === 'gift') {
      const limit = BigInt(limits.giftPerOccasion) * 100n;
      const exemptOccasion = benefit.occasion !== 'other';
      if (benefit.occasion === 'march_8' && benefit.persons.some((p) => p.recipient === 'child')) {
        issues.push({
          code: 'BENEFIT_GIFT',
          message: `${benefit.label}: de 8 martie cadoul se acordă angajatelor, nu copiilor (art. 76 alin. (4) lit. a) pct. (ii)).`,
        });
        continue;
      }
      if (benefit.occasion === 'june_1' && !benefit.persons.every((p) => p.recipient === 'child')) {
        issues.push({
          code: 'BENEFIT_GIFT',
          message: `${benefit.label}: de 1 iunie cadoul se acordă în beneficiul copiilor minori (art. 76 alin. (4) lit. a) pct. (iii)).`,
        });
        continue;
      }
      const exempt = exemptOccasion ? sum(benefit.persons.map((p) => min(p.value, limit))) : 0n;
      const taxable = sum(benefit.persons.map((p) => p.value)) - exempt;
      if (exempt) {
        result.exempt.push({ field: 'E3_86', amount: exempt });
        steps.push({
          code: 'benefit.gift.exempt',
          amount: exempt,
          clauses: [code('art.76(4)(a)'), code('art.142(b)')],
        });
      }
      if (taxable) {
        result.taxable.push({ field: 'E3_44', amount: taxable });
        steps.push({ code: 'benefit.gift', amount: taxable, clauses: [code('art.76(3)(b)')] });
      }
    } else if (benefit.kind === 'insurance') {
      let exempt = 0n;
      if (benefit.health) {
        if (!benefit.eurRate) {
          issues.push({
            code: 'BENEFIT_EUR_RATE',
            message: `${benefit.label}: lipsește cursul BNR al euro din ultima zi a lunii, pentru plafonul de 400 de euro pe an.`,
          });
          continue;
        }
        const rate = parseScaled(benefit.eurRate, 4);
        const annualCents = BigInt(limits.healthEuroPerYear) * 100n;
        const leftCents = max(0n, annualCents - benefit.yearToDateCents);
        // Euro cents left × the rate (four decimals) in bani, rounded down so the cap holds.
        const leftBani = (leftCents * rate) / 10_000n;
        exempt = capped(min(benefit.premium, leftBani));
        result.exemptCents = exempt === leftBani ? leftCents : (exempt * 10_000n) / rate;
        if (exempt) {
          result.exempt.push({ field: 'E3_71', amount: exempt });
          steps.push({
            code: 'benefit.insurance.exempt',
            amount: exempt,
            clauses: [code('art.76(4^1)(f)'), code('art.76(10)')],
          });
        }
      }
      const taxable = benefit.premium - exempt;
      if (taxable) {
        result.taxable.push({ field: 'E3_58', amount: taxable });
        steps.push({ code: 'benefit.insurance', amount: taxable, clauses: [code('art.76(3)(g)')] });
      }
    } else {
      if (benefit.value) result.taxable.push({ field: 'E3_44', amount: benefit.value });
      steps.push({
        code: 'benefit.other',
        amount: benefit.value,
        clauses: [code('art.76(2)(s)'), code('art.76(3)')],
      });
    }
    results.push(result);
  }
  return { results, issues };
}

/** A month's benefits added up: what goes into the bases, and what D112 declares where. */
export function benefitTotals(results: readonly BenefitResult[]) {
  const fields: Partial<Record<BenefitField, bigint>> = {};
  for (const result of results)
    for (const part of [...result.taxable, ...result.exempt])
      fields[part.field] = (fields[part.field] ?? 0n) + part.amount;
  return {
    taxable: sum(results.flatMap((result) => result.taxable.map((part) => part.amount))),
    exempt: sum(results.flatMap((result) => result.exempt.map((part) => part.amount))),
    fields,
  };
}

/**
 * Meal and holiday vouchers within Legea nr. 165/2018 (`ro.payroll.voucher.limits`): meal vouchers
 * at most the maximum nominal value for each day worked (art. 12 alin. (2), art. 14), holiday
 * vouchers at most the year's ceiling in minimum wages (art. 24 alin. (3)), counting those already
 * granted in the year. What is within stays a voucher (art. 76 alin. (3) lit. h), art. 142 lit.
 * r)); the excess is not granted "potrivit legii" and becomes a benefit of kind `other`, in every
 * base and in D112's E3_44 (art. 76 alin. (2) lit. s)). While the meal voucher's maximum is only
 * the floor of an indexation the register does not hold, an excess over it stops the line.
 */
export function voucherExcess(
  month: Month,
  vouchers: { meal: bigint; holiday: bigint },
  context: {
    /** Days worked in the month: the contract's active days less those of annual leave. */
    daysWorked: number;
    /** Holiday vouchers already granted in the fiscal year within the ceiling, in bani. */
    holidayEarlier: bigint;
    minimumWage: bigint;
  },
  rules: RuleContext,
): {
  meal: bigint;
  holiday: bigint;
  excess: BenefitResult[];
  issues: BenefitIssue[];
} {
  const issues: BenefitIssue[] = [];
  const excess: BenefitResult[] = [];
  if (!vouchers.meal && !vouchers.holiday) return { ...vouchers, excess, issues };
  const limits = rules.param<VoucherLimits>(
    'ro.payroll.voucher.limits',
    'payroll_month_start',
    monthStart(month),
  );
  const benefit = (label: string, amount: bigint, clauses: string[]): BenefitResult => ({
    kind: 'other',
    label,
    taxable: [{ field: 'E3_44', amount }],
    exempt: [],
    exemptCents: 0n,
    steps: [
      { code: 'benefit.voucher_excess', amount, clauses: [...clauses, code('art.76(2)(s)')] },
    ],
  });
  let meal = vouchers.meal;
  const mealLimit = BigInt(limits.mealNominal) * 100n * BigInt(Math.max(0, context.daysWorked));
  if (meal > mealLimit) {
    if (limits.mealFloorOnly)
      issues.push({
        code: 'VOUCHER_INDEXATION',
        message: `Tichetele de masă (${meal / 100n} lei) depășesc ${limits.mealNominal} lei pe zi lucrată (${context.daysWorked} zile): valoarea nominală maximă poate fi indexată prin ordinul comun al art. 32 din Legea nr. 165/2018, care nu este în registrul de surse; stabiliți-o cu expertul contabil.`,
      });
    else {
      excess.push(
        benefit('Tichete de masă peste valoarea legală', meal - mealLimit, [
          'L165/2018-A:art.14',
          'L165/2018-A:art.12(2)',
        ]),
      );
      meal = mealLimit;
    }
  }
  let holiday = vouchers.holiday;
  const ceiling = BigInt(limits.holidayMinimumWages) * context.minimumWage;
  const room = ceiling > context.holidayEarlier ? ceiling - context.holidayEarlier : 0n;
  if (holiday > room) {
    excess.push(
      benefit('Vouchere de vacanță peste plafonul anual', holiday - room, [
        'L165/2018-A:art.24(3)',
      ]),
    );
    holiday = room;
  }
  return { meal, holiday, excess, issues };
}
