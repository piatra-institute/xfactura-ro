import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { procedureDefinitions, procedureVersions } from '../src/ro/procedure';
import {
  calculatePay,
  minimumExemptions,
  payrollDefinitions,
  payrollVersions,
  type PayInput,
  type PayResult,
} from '../src/ro/payroll';
import { ParameterRegister, RuleContext } from '../src/rules';
import type { Month } from '../src/time';

const rules = () =>
  new RuleContext(
    new ParameterRegister(
      [...payrollDefinitions, ...procedureDefinitions],
      [...payrollVersions, ...procedureVersions],
    ),
    'preview',
  );
const lei = (value: number) => BigInt(Math.round(value * 100));

const pay = (input: Partial<PayInput> & { salary?: number; vouchers?: number }) => {
  const { salary, vouchers, ...rest } = input;
  return calculatePay(
    {
      month: '2026-10' as Month,
      baseSalary: lei(salary ?? 0),
      dailyHours: 8,
      mainJob: true,
      workingDays: 22,
      activeDays: 22,
      items: [
        { kind: 'salary', amount: lei(salary ?? 0), label: 'Salariu de bază' },
        ...(vouchers
          ? [{ kind: 'meal_vouchers' as const, amount: lei(vouchers), label: 'Tichete' }]
          : []),
      ],
      dependents: 0,
      under26: false,
      childrenInSchool: 0,
      unionDues: 0n,
      minimumExemption: null,
      ...rest,
    },
    rules(),
  );
};

/** The amounts a payslip shows, in lei. */
const slip = (result: PayResult | null) =>
  result && {
    gross: Number(result.gross) / 100,
    relief: Number(result.relief) / 100,
    cas: Number(result.cas) / 100,
    cass: Number(result.cass) / 100,
    casEmployer: Number(result.casEmployer) / 100,
    cassEmployer: Number(result.cassEmployer) / 100,
    deduction: Number(result.deduction.total) / 100,
    taxBase: Number(result.taxBase) / 100,
    tax: Number(result.tax) / 100,
    net: Number(result.net) / 100,
    cam: Number(result.cam) / 100,
    cost: Number(result.cost) / 100,
  };

// Expected amounts by hand from the Fiscal Code articles cited in src/ro/payroll; the two
// minimum-wage cases also match the net and employer cost the Government published.
describe('payroll: gross to net', () => {
  test('the minimum wage from July 2026: 4,325 gross, 2,699 net, 4,418 cost', () => {
    expect(slip(pay({ salary: 4325 }).result)).toEqual({
      gross: 4325,
      relief: 200,
      cas: 1031,
      cass: 413,
      casEmployer: 0,
      cassEmployer: 0,
      deduction: 865,
      taxBase: 1816,
      tax: 182,
      net: 2699,
      cam: 93,
      cost: 4418,
    });
  });

  test('the minimum wage until June 2026: 4,050 gross, 2,574 net, 4,134 cost', () => {
    expect(slip(pay({ month: '2026-03' as Month, salary: 4050 }).result)).toEqual({
      gross: 4050,
      relief: 300,
      cas: 938,
      cass: 375,
      casEmployer: 0,
      cassEmployer: 0,
      deduction: 810,
      taxBase: 1627,
      tax: 163,
      net: 2574,
      cam: 84,
      cost: 4134,
    });
  });

  test('above the minimum wage: the deduction band, and the tax base rounded at more than 50 bani', () => {
    // 5,000 is 675 above the minimum: band 651–700, 13% of 4,325 = 562.25; base 2,687.75 → 2,688.
    expect(slip(pay({ salary: 5000 }).result)).toEqual({
      gross: 5000,
      relief: 0,
      cas: 1250,
      cass: 500,
      casEmployer: 0,
      cassEmployer: 0,
      deduction: 562.25,
      taxBase: 2688,
      tax: 269,
      net: 2981,
      cam: 113,
      cost: 5113,
    });
  });

  test('meal vouchers: taxed and in the CASS base, not in the CAS or CAM bases', () => {
    expect(slip(pay({ salary: 6000, vouchers: 800 }).result)).toEqual({
      gross: 6800,
      relief: 0,
      cas: 1500,
      cass: 680,
      casEmployer: 0,
      cassEmployer: 0,
      deduction: 0,
      taxBase: 4620,
      tax: 462,
      net: 3358,
      cam: 135,
      cost: 6935,
    });
  });

  test('dependents, under 26 and children in school', () => {
    // 4,400 is 75 above the minimum: 2 dependents → 29%; 15% for under 26; 2 × 100 lei.
    const { result } = pay({ salary: 4400, dependents: 2, under26: true, childrenInSchool: 2 });
    expect(result?.deduction).toEqual({
      basic: lei(1254.25),
      young: lei(648.75),
      children: lei(200),
      total: lei(2103),
    });
    expect(slip(result)).toMatchObject({ taxBase: 757, tax: 76, net: 2784 });
  });

  test('part time: contributions at least on the minimum wage, the difference borne by the employer', () => {
    const half = pay({ salary: 2500, dailyHours: 4 });
    expect(slip(half.result)).toEqual({
      gross: 2500,
      relief: 0,
      cas: 625,
      cass: 250,
      casEmployer: 456,
      cassEmployer: 183,
      deduction: 865,
      taxBase: 760,
      tax: 76,
      net: 1549,
      cam: 56,
      cost: 3195,
    });
    const student = pay({ salary: 2500, dailyHours: 4, minimumExemption: 'student' });
    expect(slip(student.result)).toMatchObject({ casEmployer: 0, cassEmployer: 0, cost: 2556 });
  });

  test('the minimum is for the days the contract was active', () => {
    // Active 11 of 22 days: the floor is on half the minimum wage.
    const { result } = pay({ salary: 2500, dailyHours: 4, activeDays: 11 });
    expect(slip(result)).toMatchObject({ cas: 625, casEmployer: 0, cass: 250, cassEmployer: 0 });
  });

  test('the deduction is limited to the net income', () => {
    const { result } = pay({ salary: 1500, dailyHours: 2, dependents: 4, childrenInSchool: 3 });
    expect(slip(result)).toMatchObject({ deduction: 975, taxBase: 0, tax: 0, net: 975 });
  });

  test('no personal deduction away from the main job', () => {
    const { result } = pay({ salary: 3300, dailyHours: 6, mainJob: false });
    expect(slip(result)).toMatchObject({ deduction: 0, taxBase: 2145, tax: 215 });
  });

  test('refuses what the rules do not settle', () => {
    const codes = (input: Parameters<typeof pay>[0]) => pay(input).issues.map((item) => item.code);
    expect(codes({ month: '2025-12' as Month, salary: 5000 })).toEqual(['RULE_GAP']);
    expect(codes({ salary: 4000 })).toEqual(['BELOW_MINIMUM_WAGE']);
    expect(codes({ salary: 4325, activeDays: 10 })).toEqual(['RELIEF_UNSETTLED']);
    expect(codes({ salary: 2162.5, dailyHours: 4 })).toEqual(['RELIEF_UNSETTLED']);
    expect(codes({ salary: 5000, activeDays: 23 })).toEqual(['DAYS']);
    expect(codes({ salary: 5000, vouchers: 20000 })).toEqual(['NEGATIVE_NET']);
  });

  test('properties: money adds up and every amount is whole lei', () => {
    fc.assert(
      fc.property(
        fc.record({
          salary: fc.integer({ min: 4400_00, max: 40_000_00 }),
          vouchers: fc.integer({ min: 0, max: 900_00 }),
          hours: fc.integer({ min: 1, max: 8 }),
          active: fc.integer({ min: 0, max: 21 }),
          dependents: fc.integer({ min: 0, max: 6 }),
          children: fc.integer({ min: 0, max: 3 }),
          under26: fc.boolean(),
          mainJob: fc.boolean(),
          union: fc.integer({ min: 0, max: 50_00 }),
          exemption: fc.option(fc.constantFrom(...minimumExemptions), { nil: null }),
        }),
        (draw) => {
          const { result } = calculatePay(
            {
              month: '2026-11' as Month,
              baseSalary: BigInt(draw.salary),
              dailyHours: draw.hours,
              mainJob: draw.mainJob,
              workingDays: 21,
              activeDays: draw.active,
              items: [
                { kind: 'salary', amount: BigInt(draw.salary), label: 'Salariu' },
                { kind: 'meal_vouchers', amount: BigInt(draw.vouchers), label: 'Tichete' },
              ],
              dependents: draw.dependents,
              under26: draw.under26,
              childrenInSchool: draw.children,
              unionDues: BigInt(draw.union),
              minimumExemption: draw.exemption,
            },
            rules(),
          );
          if (!result) return;
          expect(result.net + result.cas + result.cass + result.tax + result.unionDues).toBe(
            result.cash,
          );
          expect(result.cost).toBe(
            result.gross + result.casEmployer + result.cassEmployer + result.cam,
          );
          for (const amount of [result.cas, result.cass, result.tax, result.taxBase, result.cam])
            expect(amount % 100n).toBe(0n);
          expect(result.tax).toBeGreaterThanOrEqual(0n);
          expect(result.deduction.total).toBeLessThanOrEqual(
            result.deduction.basic + result.deduction.young + result.deduction.children,
          );
        },
      ),
      { numRuns: 300 },
    );
  });
});
