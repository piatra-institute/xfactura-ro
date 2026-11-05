import { describe, expect, test } from 'bun:test';
import { procedureDefinitions, procedureVersions } from '../src/ro/procedure';
import {
  benefitTotals,
  calculatePay,
  evaluateBenefits,
  garnish,
  payrollDefinitions,
  payrollVersions,
  type BenefitInput,
  type GarnishmentOrder,
  type PayInput,
  voucherExcess,
} from '../src/ro/payroll';
import {
  sickIndemnity,
  sickLeaveDefinitions,
  sickLeaveVersions,
  type SickCertificate,
} from '../src/ro/payroll/sick-leave';
import { ParameterRegister, RuleContext, type ParameterVersion } from '../src/rules';
import type { LocalDate, Month } from '../src/time';

const rules = (extra: ParameterVersion[] = []) =>
  new RuleContext(
    new ParameterRegister(
      [...payrollDefinitions, ...sickLeaveDefinitions, ...procedureDefinitions],
      [...payrollVersions, ...sickLeaveVersions, ...procedureVersions, ...extra],
    ),
    'preview',
  );
const october = '2026-10' as Month;
const context = { baseSalary: 800_000n, minimumWage: 432_500n, micro: false as boolean | null };
const value = (input: BenefitInput, overrides: Partial<typeof context> = {}) =>
  evaluateBenefits(october, [input], { ...context, ...overrides }, rules());

describe('benefits in kind (Codul fiscal art. 76)', () => {
  test('a company car used privately: 1.7% of its input value a month, by the private kilometres', () => {
    const car = {
      kind: 'car' as const,
      label: 'Dacia B-123-XFA',
      inputValue: 12_000_000n,
      rent: null,
      km: null,
      passenger: true,
      exclusiveBusiness: true,
    };
    // 120,000 lei × 1.7% = 2,040 lei; mixed use, 300 of 1,500 km private: 408 lei.
    expect(benefitTotals(value(car).results).fields).toEqual({ E3_44: 204_000n });
    expect(
      benefitTotals(value({ ...car, km: { personal: 300, total: 1500 } }).results).taxable,
    ).toBe(40_800n);
    // Rented from a third party: the rent.
    expect(benefitTotals(value({ ...car, inputValue: null, rent: 150_000n }).results).taxable).toBe(
      150_000n,
    );
    // A passenger car not used only for the business is no benefit (lit. ț), ț^1)).
    const mixed = value({ ...car, exclusiveBusiness: false });
    expect(benefitTotals(mixed.results)).toEqual({ taxable: 0n, exempt: 0n, fields: {} });
    expect(mixed.results[0]!.steps[0]!.clauses).toContain(
      'ANAF/Cod-fiscal-consolidat:art.76(4)(ț)',
    );
    expect(
      value({ ...car, exclusiveBusiness: false }, { micro: true }).results[0]!.steps[0]!.clauses,
    ).toContain('ANAF/Cod-fiscal-consolidat:art.76(4)(ț1)');
    expect(value({ ...car, exclusiveBusiness: false }, { micro: null }).issues[0]!.code).toBe(
      'BENEFIT_CAR_REGIME',
    );
  });

  test('gifts: 300 lei per person and occasion left out, the rest income', () => {
    const gift = (occasion: 'religious_holiday' | 'other') =>
      value({
        kind: 'gift',
        label: 'Cadouri de Crăciun',
        occasion,
        persons: [
          { recipient: 'employee', value: 40_000n },
          { recipient: 'child', value: 25_000n },
        ],
      });
    expect(benefitTotals(gift('religious_holiday').results)).toEqual({
      taxable: 10_000n,
      exempt: 55_000n,
      fields: { E3_44: 10_000n, E3_86: 55_000n },
    });
    expect(benefitTotals(gift('other').results).taxable).toBe(65_000n);
  });

  test('housing and health insurance within the 33% of the base salary, in the order given', () => {
    const housing: BenefitInput = {
      kind: 'housing',
      label: 'Garsonieră',
      value: 120_000n,
      conditions: true,
    };
    // 20% of 4,325 lei = 865 lei left out; 335 lei income.
    expect(benefitTotals(value(housing).results).fields).toEqual({
      E3_78: 86_500n,
      E3_44: 33_500n,
    });
    const insurance: BenefitInput = {
      kind: 'insurance',
      label: 'Abonament medical',
      premium: 250_000n,
      health: true,
      eurRate: '5.0000',
      yearToDateCents: 0n,
    };
    // 400 euro × 5 = 2,000 lei left out; but the 33% of 3,000 lei (990 lei) shared with the
    // housing first leaves 125 lei.
    const both = evaluateBenefits(
      october,
      [housing, insurance],
      { ...context, baseSalary: 300_000n },
      rules(),
    );
    expect(benefitTotals(both.results).fields).toEqual({
      E3_78: 86_500n,
      E3_44: 33_500n,
      E3_71: 12_500n,
      E3_58: 237_500n,
    });
    expect(benefitTotals(value({ ...insurance, eurRate: null }).results).taxable).toBe(0n);
    expect(value({ ...insurance, eurRate: null }).issues[0]!.code).toBe('BENEFIT_EUR_RATE');
  });
});

const pay = (overrides: Partial<PayInput> = {}) =>
  calculatePay(
    {
      month: october,
      baseSalary: 800_000n,
      dailyHours: 8,
      mainJob: true,
      workingDays: 22,
      activeDays: 22,
      items: [{ kind: 'salary', amount: 800_000n, label: 'Salariu' }],
      dependents: 0,
      under26: false,
      childrenInSchool: 0,
      unionDues: 0n,
      minimumExemption: null,
      ...overrides,
    },
    rules(),
  );

describe('the pay with benefits, and the mandate', () => {
  test('a benefit in kind is in every base and paid in no money', () => {
    const { result } = pay({
      items: [
        { kind: 'salary', amount: 800_000n, label: 'Salariu' },
        { kind: 'benefit', amount: 204_000n, label: 'Autoturism' },
      ],
    });
    expect(result).toMatchObject({
      gross: 1_004_000n,
      inKind: 204_000n,
      casBase: 1_004_000n,
      cassBase: 1_004_000n,
      camBase: 1_004_000n,
      cas: 251_000n,
      cass: 100_400n,
    });
    // The tax on 10,040 − 2,510 − 1,004 = 6,526 lei; the net is the salary paid in money.
    expect(result!.tax).toBe(65_300n);
    expect(result!.net).toBe(800_000n - 251_000n - 100_400n - 65_300n);
  });

  test('a mandate: no minimum contribution, no minimum wage, the deduction only at the main job', () => {
    const low = pay({
      mandate: true,
      baseSalary: 100_000n,
      mainJob: false,
      items: [{ kind: 'salary', amount: 100_000n, label: 'Remunerație' }],
    });
    expect(low.issues).toEqual([]);
    expect(low.result).toMatchObject({
      casEmployer: 0n,
      cassEmployer: 0n,
      cas: 25_000n,
      cass: 10_000n,
      tax: 6_500n,
    });
    expect(low.result!.steps.find((step) => step.code === 'tax.base')!.clauses).toContain(
      'ANAF/Cod-fiscal-consolidat:art.78(2)(b)',
    );
    // At the main job declared there, the personal deduction (20% of 4,325 = 865 lei).
    const main = pay({
      mandate: true,
      baseSalary: 432_500n,
      items: [{ kind: 'salary', amount: 432_500n, label: 'Remunerație' }],
    });
    expect(main.result!.deduction.basic).toBe(86_500n);
    expect(main.result!.relief).toBe(0n);
  });

  test('a contribution below one leu is one leu, as D112 declares it; the tax is rounded alone', () => {
    // 20 lei: CAS 5, CASS 2, CAM 2.25% = 0.45 → 1 leu (the structure's rounding); the tax 10% of
    // 20 − 5 − 2 = 13 lei is 1.30 → 1 leu.
    const small = pay({
      mandate: true,
      baseSalary: 2_000n,
      mainJob: false,
      items: [{ kind: 'salary', amount: 2_000n, label: 'Remunerație' }],
    });
    expect(small.result).toMatchObject({ cas: 500n, cass: 200n, cam: 100n, tax: 100n });
    // 4 lei: CAS 1 leu, CASS 0.40 → 1 and CAM 0.09 → 1 leu each; the tax, 10% of 4 − 1 − 1 = 2
    // lei, is 0.20 lei: nothing.
    const tiny = pay({
      mandate: true,
      baseSalary: 400n,
      mainJob: false,
      items: [{ kind: 'salary', amount: 400n, label: 'Remunerație' }],
    });
    expect(tiny.result).toMatchObject({ cas: 100n, cass: 100n, cam: 100n, tax: 0n });
  });
});

const certificate = (code: string, from: string, to: string): SickCertificate => ({
  series: 'CCMAM',
  number: '2001',
  code,
  issued: from as LocalDate,
  from: from as LocalDate,
  to: to as LocalDate,
  continuation: false,
  hospitalized: false,
});
// 6 × 4,325 lei over 126 working days.
const base = { income: 6n * 432_500n, days: 126 };
const fresh = { reduced: false, employerDays: 0 };
/** A register whose percentages leave out maternity, to show the refusal. */
const withoutMaternity = () =>
  new ParameterRegister(
    [...payrollDefinitions, ...sickLeaveDefinitions, ...procedureDefinitions],
    [
      ...payrollVersions,
      ...sickLeaveVersions.map((version) =>
        version.key === 'ro.sick.code.percent'
          ? {
              ...version,
              value: Object.fromEntries(
                Object.entries(version.value as Record<string, string>).filter(
                  ([code]) => code !== '08',
                ),
              ),
            }
          : version,
      ),
      ...procedureVersions,
    ],
  );

describe('the other medical-leave codes', () => {
  test('maternal risk: 75%, borne by FNUASS from the first day, no day reduced', () => {
    const { result, issues } = sickIndemnity(
      certificate('15', '2026-10-05', '2026-10-16'),
      base,
      fresh,
      rules(),
    );
    expect(issues).toEqual([]);
    expect(result).toMatchObject({
      percent: '75',
      unpaidDays: 0,
      employerDays: 0,
      fundDays: 10,
      employer: 0n,
      rule: { payer: 'fund', taxable: false, cass: false },
    });
    // 20,595.23 lei a day (truncated to the ban) × 75% × 10 days.
    expect(result!.fund).toBe(154_500n);
  });

  test('cardiovascular disease: 75%, the employer’s days first, the first day reduced', () => {
    const { result } = sickIndemnity(
      certificate('13', '2026-10-05', '2026-10-09'),
      base,
      fresh,
      rules(),
    );
    expect(result).toMatchObject({ percent: '75', unpaidDays: 1, employerDays: 4, fundDays: 0 });
    expect(result!.rule).toMatchObject({ taxable: true, cass: false });
  });

  test('each code’s percentage is the one OUG nr. 158/2005 sets for it', () => {
    const percentOf = (code: string, from = '2026-10-05', to = '2026-10-09') =>
      sickIndemnity(certificate(code, from, to), base, fresh, rules()).result?.percent;
    // Art. 17 alin. (2): tuberculosis, AIDS and cancers, group A infections, emergencies, burns.
    for (const code of ['05', '06', '12', '14', '16']) expect(percentOf(code)).toBe('100');
    // Art. 20 alin. (3): quarantine and isolation; art. 30 and 30^3: child and oncological care.
    expect(percentOf('07')).toBe('100');
    expect(percentOf('51')).toBe('100');
    for (const code of ['09', '91', '17']) expect(percentOf(code)).toBe('85');
    // Art. 17 alin. (2): 100%, the employer's days first, the first day reduced; its steps cite
    // the article.
    const { result } = sickIndemnity(
      certificate('14', '2026-10-05', '2026-10-09'),
      base,
      fresh,
      rules(),
    );
    expect(result).toMatchObject({ unpaidDays: 1, employerDays: 4, fundDays: 0 });
    // 205.95 lei a day × 100% × 4 days, in whole lei.
    expect(result!.employer).toBe(82_400n);
    expect(result!.steps.find((step) => step.code === 'sick.employer')!.clauses).toContain(
      'OUG158/2005-A:art.17(2)',
    );
    // Child care: FNUASS from the second day (OUG nr. 91/2025 art. II alin. (1) lit. b) (ii)).
    expect(
      sickIndemnity(certificate('09', '2026-10-05', '2026-10-09'), base, fresh, rules()).result,
    ).toMatchObject({ unpaidDays: 1, employerDays: 0, fundDays: 4 });
  });

  test('a work accident (Legea nr. 346/2002): 80%, the employer’s first 3 days, the rest from the state budget, no day reduced', () => {
    // Art. 19: the monthly average of the gross salary income (6,000 lei) over the working days of
    // the certificate's month (22 in October 2026): 272.72 lei a day.
    const accidentBase = { income: 600_000n, days: 22 };
    const { result, issues } = sickIndemnity(
      certificate('03', '2026-10-05', '2026-10-16'),
      accidentBase,
      fresh,
      rules(),
    );
    expect(issues).toEqual([]);
    expect(result).toMatchObject({
      percent: '80',
      unpaidDays: 0,
      employerDays: 3,
      fundDays: 7,
      rule: { group: 'accident', payer: 'employer_then_pension_house', taxable: true, cass: false },
    });
    // 272.72 lei × 80% × 3 days = 654.53 lei and × 7 days = 1,527.23 lei, in whole lei.
    expect(result!.employer).toBe(65_500n);
    expect(result!.fund).toBe(152_700n);
    expect(result!.steps.find((step) => step.code === 'sick.fund')!.clauses).toEqual([
      'L346/2002-A:art.34',
      'L346/2002-A:art.33',
    ]);
    // A medical-surgical emergency: 100% (art. 33 alin. (3)).
    expect(
      sickIndemnity(
        { ...certificate('03', '2026-10-05', '2026-10-09'), emergency: true },
        accidentBase,
        fresh,
        rules(),
      ).result,
    ).toMatchObject({ percent: '100', employerDays: 3, fundDays: 2 });
    // In the month's pay: taxed, outside the CAS and CASS bases, the state budget's part outside
    // CAM's and recovered with FNUASS's.
    const { result: month } = calculatePay(
      {
        month: october,
        baseSalary: 600_000n,
        dailyHours: 8,
        mainJob: true,
        workingDays: 22,
        activeDays: 12,
        items: [
          { kind: 'salary', amount: 327_300n, label: 'Salariu' },
          { kind: 'accident_employer', amount: result!.employer, label: 'Accident (angajator)' },
          { kind: 'accident_fund', amount: result!.fund, label: 'Accident (BAS)' },
        ],
        dependents: 0,
        under26: false,
        childrenInSchool: 0,
        unionDues: 0n,
        minimumExemption: null,
      },
      rules(),
    );
    expect(month).toMatchObject({
      gross: 327_300n + 65_500n + 152_700n,
      casBase: 327_300n,
      cassBase: 327_300n,
      camBase: 327_300n + 65_500n,
      accidentEmployer: 65_500n,
      accidentFund: 152_700n,
    });
    expect(month!.steps.find((step) => step.code === 'sick.fund')!.amount).toBe(152_700n);
  });

  test('a code without a percentage in the register, and the codes not computed, are refused', () => {
    expect(
      sickIndemnity(
        certificate('08', '2026-10-01', '2026-10-31'),
        base,
        fresh,
        new RuleContext(withoutMaternity(), 'preview'),
      ).issues[0]!.code,
    ).toBe('SICK_PERCENT');
    const accident = sickIndemnity(
      certificate('10', '2026-10-01', '2026-10-09'),
      base,
      fresh,
      rules(),
    );
    expect(accident.issues[0]).toMatchObject({ code: 'SICK_CODE' });
    expect(accident.issues[0]!.message).toContain('o pătrime');
  });

  test('maternity: 85% (art. 25 alin. (1)), FNUASS alone, untaxed, no day reduced', () => {
    const { result } = sickIndemnity(
      certificate('08', '2026-10-01', '2026-10-31'),
      base,
      fresh,
      rules(),
    );
    expect(result).toMatchObject({ unpaidDays: 0, employerDays: 0, fundDays: 22, percent: '85' });
    expect(result!.rule).toMatchObject({ group: 'maternity', taxable: false, cass: false });
    // Untaxed, outside CASS, in the CAS base, outside CAM's.
    const { result: month } = calculatePay(
      {
        month: october,
        baseSalary: 800_000n,
        dailyHours: 8,
        mainJob: true,
        workingDays: 22,
        activeDays: 0,
        items: [{ kind: 'sick_fund_exempt', amount: result!.fund, label: 'Maternitate' }],
        dependents: 0,
        under26: false,
        childrenInSchool: 0,
        unionDues: 0n,
        minimumExemption: null,
      },
      rules(),
    );
    expect(month).toMatchObject({
      gross: 0n,
      casBase: result!.fund,
      cassBase: 0n,
      camBase: 0n,
      tax: 0n,
    });
  });
});

describe('vouchers within Legea nr. 165/2018', () => {
  const minimumWage = 432_500n;
  test('meal vouchers above 45 lei a day worked: the excess is a benefit in E3_44', () => {
    const split = voucherExcess(
      '2026-09' as Month,
      { meal: 110_000n, holiday: 0n },
      { daysWorked: 20, holidayEarlier: 0n, minimumWage },
      rules(),
    );
    expect(split.issues).toEqual([]);
    // 20 days × 45 lei = 900 lei stay vouchers; 200 lei are a benefit in every base.
    expect(split.meal).toBe(90_000n);
    expect(split.excess).toHaveLength(1);
    expect(split.excess[0]).toMatchObject({
      kind: 'other',
      taxable: [{ field: 'E3_44', amount: 20_000n }],
    });
    expect(split.excess[0]!.steps[0]!.clauses).toEqual(
      expect.arrayContaining(['L165/2018-A:art.14', 'L165/2018-A:art.12(2)']),
    );
    // Within the limit nothing changes.
    expect(
      voucherExcess(
        '2026-09' as Month,
        { meal: 90_000n, holiday: 0n },
        { daysWorked: 20, holidayEarlier: 0n, minimumWage },
        rules(),
      ),
    ).toMatchObject({ meal: 90_000n, excess: [] });
  });

  test('holiday vouchers above 6 minimum wages in the year: the excess is a benefit', () => {
    const split = voucherExcess(
      '2026-10' as Month,
      { meal: 0n, holiday: 300_000n },
      { daysWorked: 22, holidayEarlier: 2_400_000n, minimumWage },
      rules(),
    );
    // 6 × 4,325 = 25,950 lei a year; 24,000 already granted leave 1,950 lei.
    expect(split.holiday).toBe(195_000n);
    expect(split.excess[0]!.taxable).toEqual([{ field: 'E3_44', amount: 105_000n }]);
  });

  test('from October 2026, 45 lei is only the floor of an unknown indexation: an excess stops the line', () => {
    const split = voucherExcess(
      '2026-10' as Month,
      { meal: 110_000n, holiday: 0n },
      { daysWorked: 22, holidayEarlier: 0n, minimumWage },
      rules(),
    );
    expect(split.issues.map((issue) => issue.code)).toEqual(['VOUCHER_INDEXATION']);
    expect(split.excess).toEqual([]);
    // 22 × 45 lei is within the floor: no question.
    expect(
      voucherExcess(
        '2026-10' as Month,
        { meal: 99_000n, holiday: 0n },
        { daysWorked: 22, holidayEarlier: 0n, minimumWage },
        rules(),
      ).issues,
    ).toEqual([]);
  });
});

describe('garnishments (Codul de procedură civilă art. 729, Codul muncii art. 169)', () => {
  const order = (
    id: string,
    kind: GarnishmentOrder['kind'],
    extra: Partial<GarnishmentOrder> = {},
  ): GarnishmentOrder => ({
    id,
    kind,
    receivedOn: '2026-09-01',
    monthly: { share: [1, 2] },
    remaining: 10_000_000n,
    ...extra,
  });
  const run = (orders: GarnishmentOrder[], net = 400_000n) =>
    garnish(october, net, orders, { minimumNet: 270_000n, protectedIndemnities: false }, rules());

  test('maintenance takes up to half, any other debt up to a third, several half in all', () => {
    expect(run([order('a', 'maintenance')]).withheld).toEqual([{ orderId: 'a', amount: 200_000n }]);
    expect(run([order('b', 'other')]).withheld).toEqual([{ orderId: 'b', amount: 133_300n }]);
    // In the Labour Code's order: maintenance first, then the state, within half of 4,000 lei.
    expect(
      run([
        order('c', 'other', { receivedOn: '2026-01-01' }),
        order('d', 'state', { monthly: { amount: 50_000n } }),
        order('e', 'maintenance', { monthly: { amount: 120_000n } }),
      ]).withheld,
    ).toEqual([
      { orderId: 'e', amount: 120_000n },
      { orderId: 'd', amount: 50_000n },
      { orderId: 'c', amount: 30_000n },
    ]);
  });

  test('never more than the debt left; refused below the net minimum wage or with indemnities', () => {
    expect(run([order('a', 'other', { remaining: 20_000n })]).withheld).toEqual([
      { orderId: 'a', amount: 20_000n },
    ]);
    expect(run([order('a', 'other')], 200_000n).issues[0]!.code).toBe('GARNISHMENT_LOW_INCOME');
    expect(
      garnish(
        october,
        400_000n,
        [order('a', 'other')],
        { minimumNet: 270_000n, protectedIndemnities: true },
        rules(),
      ).issues[0]!.code,
    ).toBe('GARNISHMENT_INDEMNITY');
  });
});
