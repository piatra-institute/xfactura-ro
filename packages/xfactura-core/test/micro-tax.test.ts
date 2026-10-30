import { describe, expect, test } from 'bun:test';
import type { Evaluation } from '../src/kernel';
import { microEvaluation, microLoaded, type MicroQuarter } from '../src/ro/reviews/specs/world';
import { roRegister } from '../src/ro/register';
import { microQuarterRange, microTax, microTaxInput } from '../src/ro/treatments/micro-tax';
import { RuleContext } from '../src/rules';

// Synthetic quarters of 2026, with a hypothetical BNR rate of 5.0800 lei for 31.12.2025
// (100,000 euro = 508,000.00 lei). Expected amounts by hand from Codul fiscal art. 51, 53 and
// 54 alin. (1), and OUG nr. 59/2005 art. 1 alin. (1).

const register = roRegister();
const EUR = '5.0800';
const AUTHORITY = '00000000-0000-4000-8000-0000000000a1';

const quarter = (extra: Partial<MicroQuarter> = {}): MicroQuarter => ({
  quarter: '2026-Q2',
  quarterRevenue: { '704': '120000.00' },
  yearRevenue: { '704': '450000.00' },
  eurRate: EUR,
  ...extra,
});
const evaluate = (world: MicroQuarter) => microEvaluation(register, world).evaluation;
const codes = (evaluation: Evaluation) => evaluation.issues.map((issue) => issue.code);
const tax = (evaluation: Evaluation) => evaluation.effect?.lines[0]!.bani;

describe('micro tax rounding', () => {
  test('1% of the base in lei and bani; only the tax is set in whole lei, half up', () => {
    const at = (amount: string) =>
      evaluate(quarter({ quarterRevenue: { '704': amount }, yearRevenue: { '704': amount } }));
    // 249.496 lei → 249; rounding the base first would give 24,950 → 250.
    expect(tax(at('24949.60'))).toBe(24_900n);
    expect(at('24949.60').effect?.explanation.details).toMatchObject({
      base: '24949.60',
      rounding: 'half_up_leu',
    });
    // 249.50 lei → 250: 50 bani go up.
    expect(tax(at('24950.00'))).toBe(25_000n);
    expect(tax(at('24949.99'))).toBe(24_900n);
    // Under 50 bani of tax: nothing to book.
    expect(codes(at('49.99'))).toContain('ZERO_TAX');
    expect(tax(at('50.00'))).toBe(100n);
  });

  test('the rounding is the cited parameter, bound to the proposal', () => {
    const { rules } = microEvaluation(register, quarter());
    expect([...rules.used.keys()]).toContain('ro.declaration.rounding/2016-01-01');
  });
});

describe('fixed-asset sales and the revenue limit (art. 54 alin. (1))', () => {
  const withSales = (extra: Partial<MicroQuarter>) =>
    quarter({
      quarterRevenue: { '704': '120000.00', '7583': '80000.00' },
      yearRevenue: { '704': '450000.00', '7583': '80000.00' },
      ...extra,
    });

  test('revenue from selling assets stays in the base', () => {
    const evaluation = evaluate(
      withSales({
        assetTransfers: { subgroups: [{ subgroup: '2.3', count: 1, revenue: '80000.00' }] },
      }),
    );
    expect(codes(evaluation)).toEqual(['MICRO_EMPLOYEE']);
    // 120,000 + 80,000 = 200,000 → 2,000.
    expect(tax(evaluation)).toBe(200_000n);
  });

  test('a year with revenue on 7583 needs the transfers stated', () => {
    expect(codes(evaluate(withSales({})))).toEqual(['MICRO_ASSET_TRANSFERS', 'MICRO_EMPLOYEE']);
  });

  test('two assets of the same subgroup add their revenue to the turnover: over the limit', () => {
    const evaluation = evaluate(
      withSales({
        assetTransfers: { subgroups: [{ subgroup: '2.3', count: 2, revenue: '80000.00' }] },
      }),
    );
    // 450,000 + 80,000 = 530,000 > 508,000.
    expect(codes(evaluation)).toEqual(['MICRO_LIMIT', 'MICRO_EMPLOYEE']);
    expect(evaluation.issues[0]!.message).toContain('(80000.00 lei, art. 54 alin. (1))');
    // Under the limit, the explanation records what was added.
    const under = evaluate(
      withSales({
        yearRevenue: { '704': '400000.00', '7583': '80000.00' },
        assetTransfers: { subgroups: [{ subgroup: '2.3', count: 2, revenue: '80000.00' }] },
      }),
    );
    expect(codes(under)).toEqual(['MICRO_EMPLOYEE']);
    expect(under.effect?.explanation.details).toMatchObject({
      turnover: '400000.00',
      assetTransfers: { addedToTurnover: '80000.00', reading: 'same_subgroup' },
    });
  });

  test('a single asset adds nothing', () => {
    expect(
      codes(
        evaluate(
          withSales({
            assetTransfers: { subgroups: [{ subgroup: '2.3', count: 1, revenue: '80000.00' }] },
          }),
        ),
      ),
    ).toEqual(['MICRO_EMPLOYEE']);
  });

  test('assets of different subgroups are the open reading: confirmed when it would decide', () => {
    const transfers = {
      subgroups: [
        { subgroup: '2.3', count: 1, revenue: '60000.00' },
        { subgroup: '2.1', count: 1, revenue: '20000.00' },
      ],
    };
    const evaluation = evaluate(withSales({ assetTransfers: transfers }));
    expect(codes(evaluation)).toEqual(['MICRO_LIMIT_READING', 'MICRO_EMPLOYEE']);
    expect(evaluation.issues[0]).toMatchObject({
      severity: 'ack',
      details: {
        clause: 'ANAF/Cod-fiscal-consolidat:art.54(1)',
        readings: { engine: 'same_subgroup', alternative: 'any_subgroup' },
      },
    });
    expect(tax(evaluation)).toBe(200_000n);
    // Far under the limit either way: nothing to confirm.
    const far = evaluate(
      withSales({
        yearRevenue: { '704': '100000.00', '7583': '80000.00' },
        assetTransfers: transfers,
      }),
    );
    expect(codes(far)).toEqual(['MICRO_EMPLOYEE']);
  });

  test("land counts on its own: two plots add the land's revenue, one plot does not", () => {
    const sales = (land: { count: number; revenue: string }, cars: number) =>
      evaluate(
        withSales({
          yearRevenue: { '704': '400000.00', '7583': '150000.00' },
          assetTransfers: {
            subgroups: [{ subgroup: '2.3', count: cars, revenue: '50000.00' }],
            land,
          },
        }),
      );
    // Two plots: 400,000 + 100,000 = 500,000 ≤ 508,000; the single car's 50,000 is not added.
    expect(codes(sales({ count: 2, revenue: '100000.00' }, 1))).toEqual(['MICRO_EMPLOYEE']);
    expect(sales({ count: 2, revenue: '100000.00' }, 1).effect?.explanation.details).toMatchObject({
      assetTransfers: { addedToTurnover: '100000.00' },
    });
    // One plot and two cars: only the cars' 50,000 → 450,000.
    expect(sales({ count: 1, revenue: '100000.00' }, 2).effect?.explanation.details).toMatchObject({
      assetTransfers: { addedToTurnover: '50000.00' },
    });
  });

  test('the stated revenue cannot exceed the year on 7583, and its evidence must exist', () => {
    const range = microQuarterRange('2026-Q2');
    const world = withSales({});
    const run = (assetTransfers: Record<string, unknown>) =>
      microTax.evaluate(
        microTaxInput.parse({
          quarter: '2026-Q2',
          date: range.to,
          authorityId: AUTHORITY,
          assetTransfers,
        }),
        microLoaded({
          ...world,
          assetTransfers: { subgroups: [] },
        }),
        new RuleContext(register, 'preview'),
      );
    const evidenceId = '00000000-0000-4000-8000-0000000000e1';
    expect(
      codes(run({ subgroups: [{ subgroup: '2.3', count: 2, revenue: '90000.00' }], evidenceId })),
    ).toContain('MICRO_ASSET_TRANSFERS');
    expect(
      codes(
        run({
          subgroups: [{ subgroup: '2.3', count: 2, revenue: '80000.00' }],
          evidenceId: '00000000-0000-4000-8000-0000000000e9',
        }),
      ),
    ).toContain('EVIDENCE');
    expect(() =>
      microTaxInput.parse({
        quarter: '2026-Q2',
        date: range.to,
        authorityId: AUTHORITY,
        assetTransfers: {
          subgroups: [
            { subgroup: '2.3', count: 1, revenue: '1.00' },
            { subgroup: '2.3', count: 1, revenue: '1.00' },
          ],
          evidenceId,
        },
      }),
    ).toThrow();
  });
});
