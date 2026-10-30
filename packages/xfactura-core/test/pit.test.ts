import { describe, expect, test } from 'bun:test';
import { booksSystemOf, entityFormOf } from '../src/ro/entity';
import {
  adjustedNorm,
  casDue,
  cassDue,
  classify,
  defaultCatalogue,
  deductibleContributions,
  distributeByQuota,
  incomeTax,
  journalRows,
  monthlyTotals,
  natures,
  offsetLosses,
  pitDefinitions,
  pitVersions,
  prorate,
  realSourceIncome,
  toLeu,
  type CasRule,
  type CassRule,
  type LedgerEntry,
  type LedgerItem,
  type LedgerLine,
  type LossRule,
  type PitLimits,
} from '../src/ro/pit';
import { clause } from '../src/ro/sources';
import { ParameterRegister, RuleContext } from '../src/rules';
import type { LocalDate } from '../src/time';

const lei = (value: number) => BigInt(Math.round(value * 100));
const day = (value: string) => value as LocalDate;
const register = () => new ParameterRegister(pitDefinitions, pitVersions);
const yearly = <T>(key: string, year: number) =>
  new RuleContext(register(), 'preview').param<T>(key, 'fiscal_year_start', day(`${year}-01-01`));

describe('PFA parameters', () => {
  test('every income year resolves from the register, 2027 has no minimum wage yet', () => {
    expect(register().check()).toEqual([]);
    expect(yearly<string>('ro.min_wage.contributions', 2026)).toBe('4050');
    expect(yearly<string>('ro.min_wage.contributions', 2025)).toBe('4050');
    expect(yearly<CassRule>('ro.cass.independent', 2025).maximumWages).toBe(60);
    expect(yearly<CassRule>('ro.cass.independent', 2026).maximumWages).toBe(72);
    expect(
      register().resolve('ro.min_wage.contributions', {
        axis: 'fiscal_year_start',
        date: day('2027-01-01'),
        mode: 'preview',
      }),
    ).toMatchObject({ ok: false, gap: { reason: 'NO_VERSION' } });
    // Open-ended values stop at their review horizon instead of carrying on unreviewed.
    expect(
      register().resolve('ro.pit.rate', {
        axis: 'fiscal_year_start',
        date: day('2027-01-01'),
        mode: 'preview',
      }),
    ).toMatchObject({ ok: false, gap: { reason: 'BEYOND_HORIZON' } });
    // Nothing reviewed: posting and filing refuse the values.
    expect(
      register().resolve('ro.pit.rate', {
        axis: 'fiscal_year_start',
        date: day('2026-01-01'),
        mode: 'filing',
      }),
    ).toMatchObject({ ok: false, gap: { reason: 'INSUFFICIENT_REVIEW' } });
  });

  test('every nature cites registered clauses and the catalogue names only known natures', () => {
    for (const nature of Object.values(natures))
      for (const id of nature.clauses) expect(clause(id)?.id).toBe(id);
    expect(classify(defaultCatalogue, '704', 100n)).toBe('income.activity');
    expect(classify(defaultCatalogue, '6022.VEH50', -100n)).toBe('expense.vehicle');
    expect(classify(defaultCatalogue, '623.PROTOCOL', -100n)).toBe('expense.protocol');
    expect(classify(defaultCatalogue, '6581', -100n)).toBe('excluded.fines');
    expect(classify(defaultCatalogue, '4551', 100n)).toBe('excluded.contribution');
    expect(classify(defaultCatalogue, '4551', -100n)).toBe('excluded.withdrawal');
    expect(classify(defaultCatalogue, '1621', -100n)).toBe('excluded.repayment');
    expect(classify(defaultCatalogue, '2131', -100n)).toBe('asset.acquisition');
    expect(classify(defaultCatalogue, '8035', -100n)).toBe('unclassified');
  });

  test('a PFA keeps single-entry books unless it records otherwise; an SRL double entry', () => {
    const fact = (axis: string, value: string, from = '2026-01-01') => ({
      axis,
      value,
      effectiveFrom: day(from),
    });
    expect(booksSystemOf([], day('2026-05-01'))).toBe('double');
    expect(entityFormOf([], day('2026-05-01'))).toBe('srl');
    const pfa = [fact('entity.form', 'pfa', '2026-03-01')];
    expect(booksSystemOf(pfa, day('2026-02-28'))).toBe('double');
    expect(booksSystemOf(pfa, day('2026-03-01'))).toBe('single');
  });
});

describe('the norms’ worked examples (oracles)', () => {
  test('normă: 23.000 lei, +25%, −60% → 11.500 lei net, 1.150 lei tax (norme pct. 8 alin. (14))', () => {
    const result = adjustedNorm(
      {
        norm: lei(23000),
        increasePercent: '25',
        reductionPercent: '60',
        activeDays: null,
        // The example predates the floor of 12 minimum wages on 1 January (Legea nr. 239/2025).
        floor: null,
      },
      'leu_half_down',
    );
    expect(result).toMatchObject({
      increase: lei(5750),
      reduction: lei(17250),
      adjusted: lei(11500),
      issues: [],
    });
    expect(incomeTax(result.adjusted, '10', 'leu_half_down')).toBe(lei(1150));
  });

  test('art. 118: 60.000 − 45.000 + 30.000 − 6.250 CAS = 38.750 lei, tax 3.875 lei (norme pct. 35 alin. (9))', () => {
    // The example's own rule (2018): the loss offset in full, CAS deducted in full; the 70% limit
    // and the proportional deduction came later.
    const example: LossRule = { sharePercent: '100', years: 5, legacyBefore: 2000, legacyYears: 7 };
    const veneers = offsetLosses(
      2018,
      lei(60000),
      [{ year: 2017, bani: lei(45000) }],
      example,
      'leu_half_down',
    );
    expect(veneers.recalculated).toBe(lei(15000));
    const taxable = veneers.recalculated + lei(30000) - lei(6250);
    expect(taxable).toBe(lei(38750));
    expect(incomeTax(taxable, '10', 'leu_half_down')).toBe(lei(3875));
    // The carpentry loss of 12.000 lei is carried to the next years, untouched.
    expect(
      offsetLosses(2019, 0n, [{ year: 2018, bani: lei(12000) }], example, 'leu_half_down')
        .remaining,
    ).toEqual([{ year: 2018, bani: lei(12000) }]);
  });
});

// Fixtures built by hand from the texts cited, for the income year 2026 (minimum wage 4.050 lei on
// 1 January). Constructed for these tests, not reviewed by an expert contabil.
const wage = lei(4050);
const cas: CasRule = { thresholdWages: 12, lowerBaseWages: 12, upperBaseWages: 24 };
const cass: CassRule = { minimumWages: 6, maximumWages: 72 };
const current: LossRule = { sharePercent: '70', years: 5, legacyBefore: 2024, legacyYears: 7 };
const limits: PitLimits = {
  scholarshipPercent: '5',
  protocolPercent: '2',
  socialPercent: '5',
  professionalPercent: '5',
  vehiclePercent: '50',
  associationEur: '4000',
  pensionEur: '400',
  occupationalPensionEur: '400',
  peppEur: '400',
  healthEur: '400',
  sportEur: '100',
  etfEur: '400',
};
const casOf = (cumulated: number, extra: Partial<Parameters<typeof casDue>[0]> = {}) =>
  casDue(
    { cumulated: lei(cumulated), status: 'liable', option: false, chosen: null, ...extra },
    { minimumWage: wage, rate: '25', rule: cas, rounding: 'leu_half_down' },
  );
const cassOf = (cumulated: number, exception = false) =>
  cassDue(
    { cumulated: lei(cumulated), exception },
    { minimumWage: wage, rate: '10', rule: cass, rounding: 'leu_half_down' },
  );

describe('fixtures built from the texts (not expert-reviewed)', () => {
  test('CAS: nothing below 12 wages unless opted for, then 12 or 24 wages, pensioners exempt (art. 148, 150)', () => {
    expect(casOf(40000).due).toBe(0n);
    expect(casOf(40000, { option: true })).toMatchObject({ base: lei(48600), due: lei(12150) });
    expect(casOf(60000)).toMatchObject({ base: lei(48600), due: lei(12150) });
    expect(casOf(100000)).toMatchObject({ base: lei(97200), due: lei(24300) });
    expect(casOf(100000, { chosen: lei(120000) })).toMatchObject({ due: lei(30000) });
    expect(casOf(100000, { chosen: lei(50000) }).issues.map((issue) => issue.code)).toEqual([
      'CAS_BASE',
    ]);
    expect(casOf(100000, { status: 'pensioner' })).toMatchObject({ due: 0n, exempt: true });
  });

  test('CASS: the minimum of 6 wages unless excepted, nothing on a loss, the cap of 72 wages (art. 170, 174)', () => {
    expect(cassOf(20000)).toMatchObject({ due: lei(2430), minimumDifference: lei(430) });
    expect(cassOf(20000, true)).toMatchObject({ due: lei(2000), minimumDifference: 0n });
    expect(cassOf(0)).toMatchObject({ due: 0n });
    expect(cassOf(400000)).toMatchObject({ base: lei(291600), due: lei(29160) });
  });

  test('the art. 118 example under the 2026 rules: 70% offset, CAS and CASS deducted pro rata', () => {
    const veneers = offsetLosses(
      2026,
      lei(60000),
      [{ year: 2025, bani: lei(45000) }],
      current,
      'leu_half_down',
    );
    expect(veneers).toMatchObject({ offset: lei(42000), recalculated: lei(18000) });
    expect(veneers.remaining).toEqual([{ year: 2025, bani: lei(3000) }]);
    const recalculated = veneers.recalculated + lei(30000);
    const cumulated = lei(90000);
    const contributions = { cas: casOf(90000), cass: cassOf(90000) };
    expect(contributions.cas.due).toBe(lei(12150));
    expect(contributions.cass.due).toBe(lei(9000));
    const deducted = deductibleContributions(
      {
        realNet: cumulated,
        recalculated,
        cas: { due: contributions.cas.due, cumulated },
        cass: { due: contributions.cass.due, minimumDifference: 0n, cumulated },
      },
      'leu_half_down',
    );
    expect(deducted).toEqual({ cas: lei(12150), cass: lei(9000) });
    const taxable = recalculated - deducted.cas - deducted.cass;
    expect(taxable).toBe(lei(26850));
    expect(incomeTax(taxable, '10', 'leu_half_down')).toBe(lei(2685));
  });

  test('deducted contributions: only the real system’s share, never the CASS minimum’s difference', () => {
    expect(
      deductibleContributions(
        {
          realNet: lei(20000),
          recalculated: lei(20000),
          cas: { due: 0n, cumulated: lei(20000) },
          cass: { due: lei(2430), minimumDifference: lei(430), cumulated: lei(20000) },
        },
        'leu_half_down',
      ),
    ).toEqual({ cas: 0n, cass: lei(2000) });
    // Half the cumulated income from a normă: half the CAS is deducted.
    expect(
      deductibleContributions(
        {
          realNet: lei(50000),
          recalculated: lei(50000),
          cas: { due: lei(24300), cumulated: lei(100000) },
          cass: { due: lei(10000), minimumDifference: 0n, cumulated: lei(100000) },
        },
        'leu_half_down',
      ),
    ).toEqual({ cas: lei(12150), cass: lei(5000) });
  });

  test('losses: oldest first, 70% of the net income, 5 years (7 for losses before 2024)', () => {
    const vintages = [
      { year: 2018, bani: lei(1000) },
      { year: 2020, bani: lei(5000) },
      { year: 2024, bani: lei(20000) },
    ];
    const year2026 = offsetLosses(2026, lei(10000), vintages, current, 'leu_half_down');
    // 2018's loss is past its 7 years (2019–2025); 2020's is used first.
    expect(year2026.available).toBe(lei(25000));
    expect(year2026.offset).toBe(lei(7000));
    expect(year2026.remaining).toEqual([{ year: 2024, bani: lei(18000) }]);
    expect(year2026.expired).toEqual([]);
    // In 2029, 2024's loss is used for the last time; what is left of it is lost.
    const year2029 = offsetLosses(2029, lei(10000), year2026.remaining, current, 'leu_half_down');
    expect(year2029).toMatchObject({ offset: lei(7000), remaining: [] });
    expect(year2029.expired).toEqual([{ year: 2024, bani: lei(11000) }]);
  });

  test('art. 68: vehicles at 50%, protocol at 2% of the base, euro limits need the year’s rate', () => {
    const source = realSourceIncome(
      {
        parts: [
          { nature: 'income.activity', flow: lei(100000) },
          { nature: 'expense.full', flow: lei(-20000) },
          { nature: 'expense.protocol', flow: lei(-5000) },
          { nature: 'expense.vehicle', flow: lei(-4000) },
          { nature: 'excluded.fines', flow: lei(-500) },
          { nature: 'asset.acquisition', flow: lei(-10000) },
          { nature: 'vat', flow: lei(-1900) },
        ],
        nonCash: [
          { nature: 'expense.depreciation', flow: lei(-1000), label: 'Amortizare fiscală' },
        ],
      },
      { limits, rounding: 'leu_half_down', eurRate: null, persons: 1 },
    );
    // Base: 100.000 − 20.000 − 2.000 (vehicles) − 1.000 (depreciation) = 77.000; protocol 1.540.
    expect(source.base).toBe(lei(77000));
    expect(source.expenses.find((line) => line.nature === 'expense.protocol')?.deductible).toBe(
      lei(1540),
    );
    expect(source.totals).toEqual({
      gross: lei(100000),
      deductible: lei(24540),
      net: lei(75460),
      loss: 0n,
    });
    expect(source.excluded.map((line) => [line.nature, line.bani])).toEqual([
      ['excluded.fines', lei(500)],
      ['asset.acquisition', lei(10000)],
    ]);
    const health = (eurRate: string | null) =>
      realSourceIncome(
        {
          parts: [
            { nature: 'income.activity', flow: lei(10000) },
            { nature: 'expense.health', flow: lei(-3000) },
          ],
          nonCash: [],
        },
        { limits, rounding: 'leu_half_down', eurRate, persons: 1 },
      );
    expect(health(null).issues.map((issue) => issue.code)).toEqual(['PIT_EUR_RATE']);
    expect(health('5.0000').totals.deductible).toBe(lei(2000));
  });

  test('a norm below 12 minimum wages is refused; part of a year is prorated over 365 days', () => {
    const norm = (value: number, activeDays: number | null) =>
      adjustedNorm(
        {
          norm: lei(value),
          increasePercent: null,
          reductionPercent: '10',
          activeDays,
          floor: wage * 12n,
        },
        'leu_half_down',
      );
    expect(norm(40000, null).issues.map((issue) => issue.code)).toEqual(['PIT_NORM_FLOOR']);
    expect(norm(73000, 73).adjusted).toBe(lei(13140));
  });

  test('an association’s net income is distributed by quota to the leu, adding up (art. 125 alin. (5))', () => {
    // 45.988 × 60% = 27.592,80 and × 40% = 18.395,20: the leftover leu to the larger remainder.
    expect(distributeByQuota(lei(45_988), [6000, 4000])).toEqual([lei(27_593), lei(18_395)]);
    expect(distributeByQuota(lei(100), [3333, 3333, 3334])).toEqual([lei(33), lei(33), lei(34)]);
    expect(distributeByQuota(0n, [5000, 5000])).toEqual([0n, 0n]);
    expect(() => distributeByQuota(lei(10.5), [5000, 5000])).toThrow(RangeError);
  });

  test('rounding to the leu drops up to 50 bani (art. 66)', () => {
    expect(toLeu(lei(10.5))).toBe(lei(10));
    expect(toLeu(lei(10.51))).toBe(lei(11));
  });
});

const line = (
  lineNo: number,
  account: string,
  side: 'D' | 'C',
  amount: number,
  extra: Partial<LedgerLine> = {},
): LedgerLine => ({
  lineNo,
  account,
  side,
  bani: lei(amount),
  openItem: null,
  memo: null,
  currency: null,
  ...extra,
});
let seq = 0;
const entry = (journalCode: string, date: string, lines: LedgerLine[]): LedgerEntry => ({
  id: `e${++seq}`,
  seq,
  date: day(date),
  journalCode,
  description: journalCode,
  lines,
});

describe('Registrul-jurnal de încasări și plăți as a projection', () => {
  const sale = entry('VANZARI', '2026-03-02', [
    line(1, '4111', 'D', 1210, { openItem: 'sale' }),
    line(2, '704', 'C', 1000),
    line(3, '4427', 'C', 210),
  ]);
  const fuel = entry('CUMPARARI', '2026-03-03', [
    line(1, '6022.VEH50', 'D', 552.5),
    line(2, '4426', 'D', 52.5),
    line(3, '401', 'C', 605, { openItem: 'fuel' }),
  ]);
  const credit = entry('VANZARI', '2026-03-04', [
    line(1, '4111', 'C', 121, { openItem: 'sale' }),
    line(2, '704', 'D', 100),
    line(3, '4427', 'D', 21),
  ]);
  const items = new Map<string, LedgerItem>([
    ['sale', { id: 'sale', controlAccount: '4111', documentId: 'F1' }],
    ['fuel', { id: 'fuel', controlAccount: '401', documentId: 'B7' }],
  ]);
  const itemEntries = new Map([
    ['sale', [sale, credit]],
    ['fuel', [fuel]],
  ]);
  const project = (...entries: LedgerEntry[]) =>
    journalRows({ entries, items, itemEntries, catalogue: defaultCatalogue });
  const parts = (row: ReturnType<typeof project>[number]) =>
    row.parts.map((part) => `${part.nature} ${part.flow}`);

  test('a partial receipt takes the invoice’s natures pro rata, after its credit note', () => {
    const [row] = project(
      entry('BANCA', '2026-03-10', [
        line(1, '5121', 'D', 544.5),
        line(2, '4111', 'C', 544.5, { openItem: 'sale' }),
      ]),
    );
    expect(row).toMatchObject({ channel: 'bank', direction: 'receipt', bani: lei(544.5) });
    // Half of 1.089 lei (900 net, 189 VAT).
    expect(parts(row!)).toEqual([`income.activity ${lei(450)}`, `vat ${lei(94.5)}`]);
  });

  test('a payment takes the purchase’s vehicle expense with its VAT kept, and the deducted VAT', () => {
    const [row] = project(
      entry('CASA', '2026-03-11', [
        line(1, '5311', 'C', 605, { memo: 'DP-1' }),
        line(2, '401', 'D', 605, { openItem: 'fuel' }),
      ]),
    );
    expect(row).toMatchObject({ channel: 'cash', direction: 'payment' });
    expect(parts(row!)).toEqual([`expense.vehicle ${lei(-552.5)}`, `vat ${lei(-52.5)}`]);
  });

  test('a bank fee netted from a receipt is an expense within it', () => {
    const [row] = project(
      entry('BANCA', '2026-03-12', [
        line(1, '5121', 'D', 1000),
        line(2, '627', 'D', 89),
        line(3, '4111', 'C', 1089, { openItem: 'sale' }),
      ]),
    );
    expect(parts(row!)).toEqual([
      `income.activity ${lei(900)}`,
      `vat ${lei(189)}`,
      `expense.full ${lei(-89)}`,
    ]);
  });

  test('a realized exchange difference is folded into the income it was realized on', () => {
    const euro = entry('VANZARI', '2026-04-01', [
      line(1, '4111', 'D', 4976.5, { openItem: 'euro' }),
      line(2, '704', 'C', 4976.5),
    ]);
    const rows = journalRows({
      entries: [
        entry('BANCA', '2026-04-20', [
          line(1, '5124', 'D', 5000, { currency: { code: 'EUR', minor: 100000n, rate: '5.0000' } }),
          line(2, '4111', 'C', 4976.5, { openItem: 'euro' }),
          line(3, '7651', 'C', 23.5),
        ]),
      ],
      items: new Map([['euro', { id: 'euro', controlAccount: '4111', documentId: 'F2' }]]),
      itemEntries: new Map([['euro', [euro]]]),
      catalogue: defaultCatalogue,
    });
    expect(parts(rows[0]!)).toEqual([`income.activity ${lei(5000)}`]);
  });

  test('cash deposited at the bank is a transfer on both registers’ sides', () => {
    const rows = project(
      entry('DIVERSE', '2026-03-13', [line(1, '5121', 'D', 300), line(2, '5311', 'C', 300)]),
    );
    expect(rows.map((row) => [row.channel, row.direction, parts(row)])).toEqual([
      ['bank', 'receipt', [`transfer ${lei(300)}`]],
      ['cash', 'payment', [`transfer ${lei(-300)}`]],
    ]);
  });

  test('every row’s natures add up to its amount; receipts less payments are each month’s change', () => {
    const rows = project(
      entry('BANCA', '2026-03-10', [
        line(1, '5121', 'D', 544.5),
        line(2, '4111', 'C', 544.5, { openItem: 'sale' }),
      ]),
      entry('CASA', '2026-03-11', [
        line(1, '5311', 'C', 605),
        line(2, '401', 'D', 605, { openItem: 'fuel' }),
      ]),
      entry('DIVERSE', '2026-04-02', [line(1, '5311', 'D', 1000), line(2, '4551', 'C', 1000)]),
      // A red storno of the contribution: a negative receipt.
      entry('DIVERSE', '2026-04-03', [line(1, '5311', 'D', -1000), line(2, '4551', 'C', -1000)]),
      entry('BANCA', '2026-04-04', [line(1, '5121', 'C', 10), line(2, '8035', 'D', 10)]),
    );
    for (const row of rows)
      expect(row.parts.reduce((total, part) => total + part.flow, 0n)).toBe(
        row.direction === 'receipt' ? row.bani : -row.bani,
      );
    expect(parts(rows.at(-1)!)).toEqual([`unclassified ${lei(-10)}`]);
    expect(monthlyTotals(rows)).toEqual([
      {
        month: '2026-03',
        receipts: { cash: 0n, bank: lei(544.5) },
        payments: { cash: lei(605), bank: 0n },
      },
      { month: '2026-04', receipts: { cash: 0n, bank: 0n }, payments: { cash: 0n, bank: lei(10) } },
    ]);
  });

  test('a signed split keeps its total and the weights’ signs', () => {
    expect(prorate(lei(100), [lei(120), lei(-20)])).toEqual([lei(120), lei(-20)]);
    expect(prorate(-7n, [-1n, -1n, -1n])).toEqual([-3n, -2n, -2n]);
  });
});
