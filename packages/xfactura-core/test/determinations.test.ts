import { describe, expect, test } from 'bun:test';
import type { ProfileFact } from '../src/kernel';
import type { MicroConditionsAnswer } from '../src/questions/kinds';
import {
  agent,
  closureRules,
  determineCashVat,
  determineIncomeTax,
  determinePayrollPeriod,
  determineSizeCategory,
  determineVatPeriod,
  determineVatThreshold,
  determineYear,
  evaluateClosure,
  evaluateRules,
  nextCategory,
  thresholdWatches,
  type ClosureBooks,
  type ClosureInput,
  type Contract,
  type DeterminationContext,
  type Known,
  type YearFigures,
} from '../src/ro/determinations';
import { roRegister } from '../src/ro/register';
import { d406Begun, d406StartOf } from '../src/ro/saft/applicability';
import { clause } from '../src/ro/sources';
import { RuleContext } from '../src/rules';
import type { LocalDate } from '../src/time';

const register = roRegister();
const rules = () => new RuleContext(register, 'preview');
const EVIDENCE = '00000000-0000-4000-8000-0000000000e1';

const fact = (axis: string, value: string, effectiveFrom = '2026-01-01'): ProfileFact => ({
  axis,
  value,
  effectiveFrom: effectiveFrom as LocalDate,
});
const books = <T>(value: T): Known<T> => ({ known: true, value, source: 'books', ref: null });
/** A BNR rate of 5,0800 lei for 100.000 € = 508.000,00 lei (hypothetical, for the fixtures). */
const RATE = books({ rate: '5.0800', multiplier: 1, date: '2025-12-31' });
const lei = (amount: string) => BigInt(Math.round(Number(amount) * 100));

function figures(year: number, overrides: Partial<YearFigures> = {}): YearFigures {
  return {
    year,
    kept: true,
    turnover: books(lei('300000')),
    netTurnover: books(lei('300000')),
    totalRevenue: books(lei('310000')),
    vatTurnover: books(lei('300000')),
    exemptionTurnover: books(lei('300000')),
    totalAssets: books(lei('200000')),
    averageEmployees: books('2.00'),
    averageEmployeesD112: books('2.00'),
    euGoodsAcquisitions: books(false),
    eurRate: RATE,
    ...overrides,
  };
}
const employee: Contract = {
  employeeId: 'e1',
  start: '2024-03-01' as LocalDate,
  end: null,
  dailyHours: 8,
};
const conditions = (overrides: Partial<MicroConditionsAnswer> = {}): MicroConditionsAnswer => ({
  stateOwned: false,
  dissolution: false,
  excludedActivity: false,
  shareholders: 'only_micro',
  statementsOnTime: 'yes',
  mandate: false,
  established: null,
  lateStatementsFrom: null,
  linked: [],
  evidenceIds: [EVIDENCE],
  ...overrides,
});
function context(overrides: Partial<DeterminationContext> = {}): DeterminationContext {
  return {
    year: 2026,
    facts: [
      fact('entity.form', 'srl', '2020-01-01'),
      fact('income_tax', 'micro', '2025-01-01'),
      fact('vat.status', 'normal_vat', '2020-01-01'),
      fact('vat.cash', 'no', '2020-01-01'),
    ],
    previous: figures(2025),
    current: figures(2026),
    activity: { year: 2026, kept: true, quarterTurnover: [0n, 0n, 0n, 0n], days: [] },
    contracts: [employee],
    micro: { known: true, value: conditions(), source: 'answer', ref: EVIDENCE },
    today: '2026-10-30' as LocalDate,
    ...overrides,
  };
}

describe('micro-enterprise or profit tax', () => {
  test('all conditions met, micro the year before: micro, with the computation and its clauses', () => {
    const result = determineIncomeTax(context(), rules());
    expect(result).toMatchObject({
      status: 'proposed',
      value: 'micro',
      effectiveFrom: '2026-01-01',
    });
    expect(result.changes).toEqual([]);
    expect(result.versions).toContain('ro.micro.revenue_limit_eur/2026-01-01');
    expect(result.clauses).toContain('ANAF/Cod-fiscal-consolidat:art.47(1^1)');
    expect(result.lines.join('\n')).toContain('Lit. c): îndeplinită');
    // Every clause a determination cites is registered.
    for (const id of result.clauses) expect(clause(id)).toBeDefined();
  });

  const failing: [string, Partial<DeterminationContext>, string][] = [
    [
      'c) turnover above 100.000 €',
      { previous: figures(2025, { turnover: books(lei('508000.01')) }) },
      'c',
    ],
    [
      'c) with the linked enterprises',
      {
        micro: books(
          conditions({
            linked: [
              { name: 'Alta SRL', relation: 'c', basis: 'turnover', previousYear: '300000.00' },
            ],
          }),
        ),
      },
      'c',
    ],
    ['g) no employee, no mandate', { contracts: [] }, 'g'],
    ['d) state capital', { micro: books(conditions({ stateOwned: true })) }, 'd'],
    ['e) dissolution', { micro: books(conditions({ dissolution: true })) }, 'e'],
    ['h) not designated', { micro: books(conditions({ shareholders: 'not_designated' })) }, 'h'],
    ['i) statements late', { micro: books(conditions({ statementsOnTime: 'no' })) }, 'i'],
    ['alin. (3) excluded activity', { micro: books(conditions({ excludedActivity: true })) }, '3'],
  ];
  for (const [title, overrides, id] of failing)
    test(`each condition failing gives profit tax: ${title}`, () => {
      const result = determineIncomeTax(context(overrides), rules());
      expect(result.status).toBe('proposed');
      expect(result.value).toBe('profit');
      expect(result.inputs.conditions).toContainEqual({ id, state: 'failed' });
    });

  test('a mandate contract meets the employee condition; the consulting share is no condition', () => {
    const result = determineIncomeTax(
      context({ contracts: [], micro: books(conditions({ mandate: true })) }),
      rules(),
    );
    expect(result.value).toBe('micro');
    expect(result.inputs.conditions).toContainEqual({ id: 'f', state: 'not_applicable' });
  });

  test('unknown owner conditions or turnover: NEEDS_EVIDENCE naming the questions', () => {
    const owner = determineIncomeTax(
      context({ micro: { known: false, reason: 'neîntrebat', question: null } }),
      rules(),
    );
    expect(owner.status).toBe('needs_evidence');
    expect(owner.questions.map((question) => question.kind)).toEqual(['micro.conditions']);
    const turnover = determineIncomeTax(
      context({
        previous: figures(2025, {
          turnover: {
            known: false,
            reason: 'anul 2025 nu este în registre',
            question: {
              kind: 'year.figures',
              subject: { kind: 'year', id: '2025' },
              params: { year: 2025, figures: ['turnover'] },
            },
          },
        }),
      }),
      rules(),
    );
    expect(turnover.status).toBe('needs_evidence');
    expect(turnover.questions[0]).toMatchObject({ kind: 'year.figures', params: { year: 2025 } });
    // Eligible without a recorded regime the year before: the option is asked, never assumed.
    const option = determineIncomeTax(
      context({ facts: [fact('entity.form', 'srl', '2020-01-01')] }),
      rules(),
    );
    expect(option.status).toBe('needs_evidence');
    expect(option.questions[0]).toMatchObject({
      kind: 'profile.fact',
      subject: { id: 'income_tax/2026' },
    });
  });

  test('the limit crossed in the third quarter: profit tax from that quarter', () => {
    const result = determineIncomeTax(
      context({
        activity: {
          year: 2026,
          kept: true,
          quarterTurnover: [lei('150000'), lei('150000'), lei('250000'), 0n],
          days: [],
        },
      }),
      rules(),
    );
    expect(result.value).toBe('micro');
    expect(result.changes).toEqual([
      expect.objectContaining({ value: 'profit', effectiveFrom: '2026-07-01' }),
    ]);
  });

  test('the only employee leaves and is not replaced in 30 days: profit from the next quarter', () => {
    const left: Contract = { ...employee, end: '2026-04-15' as LocalDate };
    const result = determineIncomeTax(context({ contracts: [left] }), rules());
    expect(result.changes[0]).toMatchObject({ value: 'profit', effectiveFrom: '2026-07-01' });
    const replaced = determineIncomeTax(
      context({
        contracts: [
          left,
          { employeeId: 'e2', start: '2026-05-10' as LocalDate, end: null, dailyHours: 8 },
        ],
      }),
      rules(),
    );
    expect(replaced.changes).toEqual([]);
  });

  test('a linked individual enterprise on a norm adds a quarter of its norm per quarter', () => {
    const answer = conditions({
      linked: [
        {
          name: 'PFA Ion',
          relation: 'd',
          basis: 'norma',
          previousYear: '40000.00',
          currentYear: { throughQuarter: 4, amount: '40000.00' },
        },
      ],
    });
    // Own turnover 480.000 lei by Q3; the norm adds 3 × 10.000 lei: 510.000 lei > 508.000 lei.
    const result = determineIncomeTax(
      context({
        micro: books(answer),
        activity: {
          year: 2026,
          kept: true,
          quarterTurnover: [lei('160000'), lei('160000'), lei('160000'), 0n],
          days: [],
        },
      }),
      rules(),
    );
    expect(result.changes[0]).toMatchObject({ effectiveFrom: '2026-07-01' });
  });

  test('an excluded activity started, or the shareholders choosing it to leave: profit from that quarter', () => {
    const exit = (overrides: Partial<MicroConditionsAnswer>) =>
      determineIncomeTax(context({ micro: books(conditions(overrides)) }), rules());
    // Art. 52 alin. (4) and (7): the quarter it happened in.
    expect(exit({ excludedActivityFrom: '2026-05-10' }).changes[0]).toMatchObject({
      value: 'profit',
      effectiveFrom: '2026-04-01',
    });
    const holdings = exit({ shareholdersExitFrom: '2026-08-01' });
    expect(holdings.changes[0]).toMatchObject({ value: 'profit', effectiveFrom: '2026-07-01' });
    expect(holdings.clauses).toContain('ANAF/Cod-fiscal-consolidat:art.52(4),(6)-(7)');
  });

  test('a PFA is not a micro-enterprise; a year before the rule is a RULE_GAP', () => {
    expect(
      determineIncomeTax(context({ facts: [fact('entity.form', 'pfa', '2020-01-01')] }), rules())
        .status,
    ).toBe('not_applicable');
    expect(determineIncomeTax(context({ year: 2025 }), rules()).status).toBe('rule_gap');
  });
});

describe('VAT period and D112 period', () => {
  test('quarterly VAT under 100.000 € and without EU goods; monthly above or with them', () => {
    expect(determineVatPeriod(context(), rules())).toMatchObject({
      status: 'proposed',
      value: 'quarterly',
    });
    expect(
      determineVatPeriod(
        context({ previous: figures(2025, { vatTurnover: books(lei('508000.01')) }) }),
        rules(),
      ).value,
    ).toBe('monthly');
    expect(
      determineVatPeriod(
        context({ previous: figures(2025, { euGoodsAcquisitions: books(true) }) }),
        rules(),
      ).value,
    ).toBe('monthly');
    // Registered during the year: the turnover before registration, recalculated for a whole
    // year (art. 322 alin. (4)); none here, so quarterly from the registration.
    const registered = determineVatPeriod(
      context({
        facts: [
          fact('entity.form', 'srl', '2020-01-01'),
          fact('vat.status', 'non_vat', '2020-01-01'),
          fact('vat.status', 'normal_vat', '2026-05-01'),
        ],
      }),
      rules(),
    );
    expect(registered).toMatchObject({
      status: 'proposed',
      value: 'quarterly',
      effectiveFrom: '2026-05-01',
    });
  });

  test('D112: quarterly for a micro-enterprise under 3 employees on average, monthly at 3', () => {
    const facts = [...context().facts, fact('income_tax', 'micro', '2026-01-01')];
    expect(determinePayrollPeriod(context({ facts }), rules()).value).toBe('quarterly');
    expect(
      determinePayrollPeriod(
        context({ facts, previous: figures(2025, { averageEmployeesD112: books('3.00') }) }),
        rules(),
      ).value,
    ).toBe('monthly');
    // A profit-tax payer also needs total revenues of at most 100.000 €.
    const profit = [...context().facts, fact('income_tax', 'profit', '2026-01-01')];
    expect(
      determinePayrollPeriod(
        context({ facts: profit, previous: figures(2025, { totalRevenue: books(lei('600000')) }) }),
        rules(),
      ).value,
    ).toBe('monthly');
    // The regime of the year not recorded yet: it depends on it.
    expect(determinePayrollPeriod(context(), rules())).toMatchObject({
      status: 'needs_evidence',
      dependsOn: ['income_tax'],
    });
    // A PFA with employees: quarterly (art. 80 alin. (2) lit. d)).
    expect(
      determinePayrollPeriod(
        context({ facts: [fact('entity.form', 'pfa', '2020-01-01')] }),
        rules(),
      ).value,
    ).toBe('quarterly');
  });
});

describe('size category over two years', () => {
  const small = {
    totalAssets: books(lei('3000000')),
    netTurnover: books(lei('5000000')),
    averageEmployees: books('8.00'),
  };
  const large = {
    totalAssets: books(lei('30000000')),
    netTurnover: books(lei('60000000')),
    averageEmployees: books('60.00'),
  };
  const year = (
    previousCategory: string,
    before: Partial<YearFigures>,
    now: Partial<YearFigures>,
    today = '2027-02-01',
  ) =>
    determineSizeCategory(
      context({
        facts: [...context().facts, fact('size.category', previousCategory, '2025-01-01')],
        previous: figures(2025, before),
        current: figures(2026, now),
        today: today as LocalDate,
      }),
      rules(),
    );

  test('a microentity stays one unless both years exceed two criteria', () => {
    expect(year('micro', {}, small).value).toBe('micro');
    expect(year('micro', small, {}).value).toBe('micro');
    expect(year('micro', small, small).value).toBe('small');
    // Before the year ends, a crossing year before needs the year's figures.
    expect(year('micro', small, small, '2026-10-30').status).toBe('needs_evidence');
    // Without a crossing, the category is known before the year ends.
    expect(year('micro', {}, {}, '2026-10-30').value).toBe('micro');
  });

  test('two categories up in one year moves one step: to the lower of the two', () => {
    expect(nextCategory('micro', 'medium_large', 'small')).toBe('small');
    expect(nextCategory('small', 'micro', 'micro')).toBe('micro');
    expect(year('small', small, large).value).toBe('small');
  });

  test('medium or large, and the audit, are UNSUPPORTED', () => {
    const result = year('small', large, large);
    expect(result.status).toBe('unsupported');
    expect(result.unsupported?.trigger).toBe('AUDIT_REQUIRED');
    const audit = {
      totalAssets: books(lei('17000000')),
      netTurnover: books(lei('33000000')),
      averageEmployees: books('20.00'),
    };
    expect(year('small', audit, audit).unsupported?.trigger).toBe('AUDIT_REQUIRED');
  });

  test('the previous category unknown: asked, never assumed', () => {
    const result = determineSizeCategory(context(), rules());
    expect(result.status).toBe('needs_evidence');
    expect(result.questions[0]).toMatchObject({ subject: { id: 'size.category/2025' } });
  });
});

describe('VAT thresholds', () => {
  const nonPayer = [
    fact('entity.form', 'srl', '2020-01-01'),
    fact('vat.status', 'non_vat', '2020-01-01'),
  ];
  const days = [
    { date: '2026-03-10' as LocalDate, exemption: lei('200000'), vat: 0n },
    { date: '2026-09-15' as LocalDate, exemption: lei('150000'), vat: 0n },
    { date: '2026-10-05' as LocalDate, exemption: lei('50000'), vat: 0n },
  ];
  test('art. 310: the day the threshold is crossed, registration due and valid from then', () => {
    const result = determineVatThreshold(
      context({
        facts: nonPayer,
        activity: { year: 2026, kept: true, quarterTurnover: [0n, 0n, 0n, 0n], days },
      }),
      rules(),
    );
    expect(result).toMatchObject({
      status: 'proposed',
      value: 'under',
      changes: [{ value: 'exceeded', effectiveFrom: '2026-10-05' }],
      unsupported: null,
    });
    expect(result.inputs.crossed).toBe('2026-10-05');
    expect(
      determineVatThreshold(
        context({
          facts: nonPayer,
          activity: {
            year: 2026,
            kept: true,
            quarterTurnover: [0n, 0n, 0n, 0n],
            days: days.slice(0, 2),
          },
        }),
        rules(),
      ).value,
    ).toBe('under');
  });

  test('watches report the threshold at 80% and over', () => {
    const at88 = thresholdWatches(
      context({
        facts: nonPayer,
        activity: {
          year: 2026,
          kept: true,
          quarterTurnover: [0n, 0n, 0n, 0n],
          days: days.slice(0, 2),
        },
      }),
      rules(),
    );
    expect(at88).toEqual([
      expect.objectContaining({ key: 'ro.vat.exemption.threshold', percent: 88 }),
    ]);
    expect(thresholdWatches(context({ facts: nonPayer }), rules())).toEqual([]);
  });

  test('VAT on collection: ineligible above the ceiling the year before; exit after the next period', () => {
    const cash = [
      ...context().facts,
      fact('vat.cash', 'yes', '2025-01-01'),
      fact('vat.period', 'monthly', '2026-01-01'),
    ];
    expect(
      determineCashVat(
        context({
          facts: cash,
          previous: figures(2025, { vatTurnover: books(lei('5000000.01')) }),
        }),
        rules(),
      ),
    ).toMatchObject({ status: 'proposed', value: 'no' });
    const crossing = determineCashVat(
      context({
        facts: cash,
        activity: {
          year: 2026,
          kept: true,
          quarterTurnover: [0n, 0n, 0n, 0n],
          days: [{ date: '2026-06-20' as LocalDate, exemption: 0n, vat: lei('5000000.01') }],
        },
      }),
      rules(),
    );
    expect(crossing.value).toBe('yes');
    expect(crossing.changes).toEqual([
      expect.objectContaining({ value: 'no', effectiveFrom: '2026-08-01' }),
    ]);
  });
});

// ---------------------------------------------------------------------------------------------

const noBooks: ClosureBooks = {
  firstDay: '2026-01-01',
  financialYearEnds: ['2026-12-31'],
  employmentMonths: [],
  payrollEventMonths: [],
  euServiceMonths: [],
  dividendMonths: [],
  foreignPurchases: [],
  stockMonths: [],
  sponsorshipMonths: [],
  payrollWithoutContractMonths: [],
  incomeSources: [],
  assetYears: [],
};
/** `ro.d406.start` for every month of 2025–2026, as the engine reads it. */
const d406Start = d406StartOf(
  rules(),
  [2025, 2026].flatMap((year) =>
    Array.from({ length: 12 }, (_, index) => `${year}-${String(index + 1).padStart(2, '0')}`),
  ),
);
/** A non-VAT services SRL on micro tax, no employees, with every fact known. */
const known = [
  fact('entity.form', 'srl', '2020-01-01'),
  fact('vat.status', 'non_vat', '2020-01-01'),
  fact('vat.eu', 'none', '2020-01-01'),
  fact('employer', 'no', '2020-01-01'),
  fact('income_tax', 'micro', '2026-01-01'),
  fact('size.category', 'micro', '2026-01-01'),
  fact('activity.goods', 'no', '2020-01-01'),
  fact('regime.excluded', 'none', '2020-01-01'),
];
function closure(overrides: Partial<ClosureInput> = {}, determinationFacts = known) {
  const facts = overrides.facts ?? determinationFacts;
  return evaluateClosure({
    interval: { from: '2026-07', to: '2026-12' },
    facts,
    determinations: determineYear(
      context({
        facts,
        micro: books(conditions()),
        previous: figures(2025),
        contracts: [{ ...employee, dailyHours: 0 }],
        today: '2026-10-30' as LocalDate,
      }),
      rules(),
    ).filter((item) => item.axis !== 'income_tax'),
    confirmed: {},
    books: noBooks,
    d406Start,
    ...overrides,
  });
}
const lines = (result: ReturnType<typeof evaluateClosure>) =>
  result.obligations.map((item) => `${item.kind} ${item.period} ${item.state}`);

describe('obligation closure', () => {
  test('everything known and covered: ELIGIBLE, each return with its rule and facts', () => {
    const result = closure();
    expect(result.status).toBe('ELIGIBLE');
    expect(lines(result)).toEqual([
      'D100 2026-09 applies',
      'D406 2026-Q3 applies',
      'D100 2026-12 applies',
      'D406 2026-Q4 applies',
      'S1005 2026 applies',
    ]);
    const d406 = result.obligations[1]!;
    expect(d406.rule).toBe('obligation.d406@2026-09');
    expect(d406.facts).toEqual([
      'vat@2026-09=non_vat (fapt vat.status)',
      'vatPeriod@2026-09=none (neplătitor de TVA)',
      'form@2026-09=srl (fapt entity.form)',
      'd406Begun@2026-09=yes (toate categoriile de contribuabili, de la 2025-01-01 (anexa nr. 5 pct. 1.1 lit. d)–g)))',
    ]);
    expect(d406.clauses).toEqual(['OPANAF1783/2021:anexa4.pct.1-4', 'OPANAF407/2025:anexa5.pct.4']);
    expect(result.trace.length).toBeGreaterThan(0);
    // Every clause a rule cites is registered.
    for (const rule of closureRules({
      interval: { from: '2026-01', to: '2026-12' },
      facts: known,
      determinations: [],
      confirmed: {},
      books: {
        ...noBooks,
        euServiceMonths: ['2026-03'],
        dividendMonths: ['2026-04'],
        foreignPurchases: [{ month: '2026-05', documentId: 'd', country: 'IE' }],
        assetYears: ['2026'],
      },
      d406Start,
    }))
      for (const id of rule.clauses) expect(clause(id)).toBeDefined();
  });

  test("CONFORMANCE: a non-VAT company's Irish software purchase is UNSUPPORTED, with its invoice", () => {
    const result = closure({
      books: {
        ...noBooks,
        foreignPurchases: [{ month: '2026-08', documentId: 'invoice-ie', country: 'IE' }],
      },
    });
    expect(result.status).toBe('UNSUPPORTED');
    expect(result.unsupported).toEqual([
      expect.objectContaining({
        trigger: 'FOREIGN_SERVICE_PURCHASE',
        missingCapabilities: ['FOREIGN_PURCHASE_TREATMENT'],
        evidenceIds: ['invoice-ie'],
      }),
    ]);
  });

  test('CONFORMANCE: a VAT-ceiling transition fails closed', () => {
    // Art. 310: a non-payer crossing the threshold.
    const crossing = determineVatThreshold(
      context({
        facts: known,
        activity: {
          year: 2026,
          kept: true,
          quarterTurnover: [0n, 0n, 0n, 0n],
          days: [{ date: '2026-08-03' as LocalDate, exemption: lei('400000'), vat: 0n }],
        },
      }),
      rules(),
    );
    // Registration is due from the crossing day: the returns wait on it, asked.
    const result = closure({ determinations: [crossing] });
    expect(result.status).toBe('NEEDS_EVIDENCE');
    expect(result.needs).toContainEqual(
      expect.objectContaining({
        code: 'DETERMINATION_CONFLICT',
        fact: 'vat.status',
        question: expect.objectContaining({ params: { axis: 'vat.status', from: '2026-08-03' } }),
      }),
    );
    // VAT on collection: the ceiling crossed while the recorded regime stays on it.
    const payer = [
      ...known.filter((item) => !item.axis.startsWith('vat.')),
      fact('vat.status', 'normal_vat', '2020-01-01'),
      fact('vat.period', 'monthly', '2026-01-01'),
      fact('vat.cash', 'yes', '2025-01-01'),
    ];
    const cash = determineCashVat(
      context({
        facts: payer,
        activity: {
          year: 2026,
          kept: true,
          quarterTurnover: [0n, 0n, 0n, 0n],
          days: [{ date: '2026-08-03' as LocalDate, exemption: 0n, vat: lei('5000001') }],
        },
      }),
      rules(),
    );
    const vatPeriod = determineVatPeriod(
      context({ facts: payer, previous: figures(2025, { vatTurnover: books(lei('600000')) }) }),
      rules(),
    );
    const transition = closure({ facts: payer, determinations: [cash, vatPeriod] });
    expect(transition.status).toBe('NEEDS_EVIDENCE');
    expect(transition.needs).toContainEqual(
      expect.objectContaining({
        code: 'DETERMINATION_CONFLICT',
        fact: 'vat.cash/2026',
        question: expect.objectContaining({ kind: 'determination.confirm' }),
      }),
    );
  });

  test('CONFORMANCE: no normal VAT, yet D406 applies; unknown VAT blocks it, never drops it', () => {
    expect(lines(closure())).toContain('D406 2026-Q3 applies');
    const facts = known.filter((item) => item.axis !== 'vat.status');
    const result = closure({ facts });
    expect(result.status).toBe('NEEDS_EVIDENCE');
    expect(lines(result)).toContain('D406 2026-07 needs_evidence');
    expect(result.needs).toContainEqual(
      expect.objectContaining({
        code: 'FACT_UNKNOWN',
        fact: 'vat.status',
        question: {
          kind: 'profile.fact',
          subject: { kind: 'profile', id: 'vat.status' },
          params: { axis: 'vat.status' },
        },
      }),
    );
  });

  test('CONFORMANCE: payroll-type remuneration of the administrator without employees is UNSUPPORTED', () => {
    const result = closure({ books: { ...noBooks, payrollWithoutContractMonths: ['2026-09'] } });
    expect(result.status).toBe('UNSUPPORTED');
    expect(result.unsupported[0]).toMatchObject({ trigger: 'PAYROLL_WITHOUT_EMPLOYEES' });
  });

  test('CONFORMANCE: sponsorship triggers the credit and D107, UNSUPPORTED', () => {
    const result = closure({ books: { ...noBooks, sponsorshipMonths: ['2026-11'] } });
    expect(result.unsupported.map((item) => item.trigger)).toEqual(['SPONSORSHIP']);
  });

  test('every unknown material fact is a need naming its question; known uncovered cases win', () => {
    const result = closure({ facts: [] });
    expect(result.status).toBe('NEEDS_EVIDENCE');
    expect(result.needs.map((need) => need.fact).sort()).toEqual([
      'activity.goods',
      'employer',
      'entity.form',
      'regime.excluded',
      'vat.status',
    ]);
    // The form unknown: a company's statements wait on it; an individual's D212 is not listed.
    expect(lines(result)).toContain('S1005 2026 needs_evidence');
    expect(lines(result).filter((line) => /^D2(12|04) /.test(line))).toEqual([]);
    const goods = closure({
      facts: [
        ...known.filter((item) => item.axis !== 'regime.excluded'),
        fact('activity.goods', 'yes', '2026-01-01'),
      ],
    });
    expect(goods.status).toBe('UNSUPPORTED');
    expect(goods.unsupported.map((item) => item.trigger)).toEqual(['GOODS_STOCK']);
  });

  test('a yearly determination missing, or contradicted by the books, blocks what depends on it', () => {
    const facts = known.filter((item) => item.axis !== 'income_tax');
    const missing = closure({ facts });
    expect(lines(missing)).toContain('D100 2026-09 needs_evidence');
    expect(missing.needs.find((need) => need.fact === 'income_tax/2026')).toMatchObject({
      code: 'DETERMINATION_MISSING',
      question: { kind: 'profile.fact', subject: { id: 'income_tax/2026' } },
    });
    // A fact carried from 2025 is not the 2026 determination.
    const carried = closure({ facts: [...facts, fact('income_tax', 'micro', '2025-01-01')] });
    expect(carried.needs.map((need) => need.fact)).toContain('income_tax/2026');
  });

  test('profit tax: D100 for quarters I–III and D101 for the year, once the system is known', () => {
    const facts = [
      ...known.filter((item) => item.axis !== 'income_tax'),
      fact('income_tax', 'profit', '2026-01-01'),
    ];
    // Not after a micro year: the quarterly system (art. 41 alin. (1)) or the option for the
    // annual one is the company's fact.
    const unknown = closure({ facts });
    expect(unknown.status).toBe('NEEDS_EVIDENCE');
    expect(lines(unknown)).toEqual(
      expect.arrayContaining(['D100 2026-09 needs_evidence', 'D101 2026 needs_evidence']),
    );
    expect(unknown.needs.find((need) => need.fact === 'profit.system')).toMatchObject({
      code: 'FACT_UNKNOWN',
      question: { kind: 'profile.fact', subject: { id: 'profit.system' } },
    });
    const quarterly = closure({
      facts: [...facts, fact('profit.system', 'quarterly', '2026-01-01')],
    });
    expect(quarterly.status).toBe('ELIGIBLE');
    expect(lines(quarterly)).toEqual(
      expect.arrayContaining(['D100 2026-09 applies', 'D101 2026 applies']),
    );
    expect(quarterly.obligations.find((item) => item.kind === 'D101')).toMatchObject({
      deadline: 'D101',
      period: '2026',
    });
    expect(quarterly.obligations.find((item) => item.kind === 'D100')?.deadline).toBe(
      'D100.profit',
    );
    const annual = closure({ facts: [...facts, fact('profit.system', 'annual', '2026-01-01')] });
    expect(annual.unsupported.map((item) => item.trigger)).toEqual(['PROFIT_ANNUAL_SYSTEM']);
  });

  test('leaving micro in the year: micro D100 before, D101 for the rest, and the D700 that declares it', () => {
    const exit = closure({ facts: [...known, fact('income_tax', 'profit', '2026-10-01')] });
    expect(exit.status).toBe('ELIGIBLE');
    expect(lines(exit)).toEqual(
      expect.arrayContaining(['D100 2026-09 applies', 'D101 2026 applies', 'D700 2026 applies']),
    );
    expect(exit.obligations.find((item) => item.kind === 'D100')?.deadline).toBe('D100.micro');
    expect(exit.obligations.find((item) => item.kind === 'D700')).toMatchObject({
      deadline: 'D700.micro_exit',
      deadlinePeriod: null,
      rule: 'scope.income_tax.transition@2026',
    });
    expect(exit.unsupported).toEqual([]);
  });

  test("entering micro on 1 January: the previous year's D101 and the D700 by 31 March", () => {
    const facts = [
      ...known.filter((item) => item.axis !== 'income_tax' && item.axis !== 'size.category'),
      fact('income_tax', 'profit', '2025-01-01'),
      fact('income_tax', 'micro', '2026-01-01'),
      fact('profit.system', 'quarterly', '2025-01-01'),
      fact('size.category', 'micro', '2025-01-01'),
      fact('size.category', 'micro', '2026-01-01'),
    ];
    const entry = closure({
      interval: { from: '2025-12', to: '2026-03' },
      facts,
      books: {
        ...noBooks,
        firstDay: '2025-01-01',
        financialYearEnds: ['2025-12-31', '2026-12-31'],
      },
    });
    expect(lines(entry)).toEqual(
      expect.arrayContaining(['D101 2025 applies', 'D100 2026-03 applies', 'D700 2026 applies']),
    );
    expect(entry.obligations.find((item) => item.kind === 'D700')).toMatchObject({
      deadline: 'D700.micro_entry',
      deadlinePeriod: '2025',
    });
    // Profit again within the year is no entry: a micro-enterprise cannot enter mid-year.
    const midyear = closure({
      interval: { from: '2026-01', to: '2026-12' },
      facts: [
        ...facts,
        fact('income_tax', 'profit', '2026-04-01'),
        fact('income_tax', 'micro', '2026-07-01'),
      ],
    });
    expect(midyear.unsupported.map((item) => item.trigger)).toContain('MICRO_ENTRY_MIDYEAR');
  });

  test('a quarterly D112: each month after the quarter, except a month with sick leave and the months before it', () => {
    const facts = [
      ...known.filter((item) => item.axis !== 'employer'),
      fact('employer', 'yes', '2026-01-01'),
      fact('payroll.period', 'quarterly', '2026-01-01'),
    ];
    const result = closure({ facts, books: { ...noBooks, payrollEventMonths: ['2026-08'] } });
    const d112 = result.obligations.filter((item) => item.kind === 'D112');
    expect(d112.map((item) => [item.period, item.deadline, item.deadlinePeriod])).toEqual([
      // Art. 147 alin. (11): August's sick leave brings July with it, to 25 September.
      ['2026-07', 'D112', '2026-08'],
      ['2026-08', 'D112', null],
      ['2026-09', 'D112.quarterly', '2026-Q3'],
      ['2026-10', 'D112.quarterly', '2026-Q4'],
      ['2026-11', 'D112.quarterly', '2026-Q4'],
      ['2026-12', 'D112.quarterly', '2026-Q4'],
    ]);
  });

  test('nothing before the first financial year: no returns, no needs, no annual return of the year before', () => {
    // Books from 1 January 2026, every fact recorded from then: 2025 is unknown, and not asked.
    const fromBooks = known.map((item) => ({ ...item, effectiveFrom: '2026-01-01' as LocalDate }));
    const interval = { from: '2025-10', to: '2026-03' };
    const result = closure({ interval, facts: fromBooks });
    expect(result.status).toBe('ELIGIBLE');
    expect(lines(result)).toEqual(['D100 2026-03 applies', 'D406 2026-Q1 applies']);
    expect(result.needs).toEqual([]);
    expect(result.trace.filter((item) => item.rule.includes('@2025'))).toEqual([]);
    // A range wholly before the books evaluates nothing.
    const before = closure({ interval: { from: '2025-01', to: '2025-12' }, facts: fromBooks });
    expect([before.obligations, before.needs, before.unsupported]).toEqual([[], [], []]);
    // A first year starting mid-month covers that month: a monthly payer's D300 from February.
    const late = closure({
      interval: { from: '2026-01', to: '2026-03' },
      facts: [
        ...fromBooks.filter((item) => !item.axis.startsWith('vat.')),
        fact('vat.status', 'normal_vat', '2026-01-01'),
        fact('vat.period', 'monthly', '2026-01-01'),
        fact('vat.cash', 'no', '2026-01-01'),
      ],
      determinations: [],
      books: { ...noBooks, firstDay: '2026-02-15' },
    });
    expect(lines(late).filter((line) => line.startsWith('D300'))).toEqual([
      'D300 2026-02 applies',
      'D300 2026-03 applies',
    ]);
    expect(late.needs).toEqual([]);
    expect(late.trace.some((item) => item.rule.endsWith('@2026-01'))).toBe(false);
    // No financial year at all: no restriction, the months before the facts are asked.
    const unkept = closure({
      interval,
      facts: fromBooks,
      books: { ...noBooks, firstDay: null, financialYearEnds: [] },
    });
    expect(unkept.status).toBe('NEEDS_EVIDENCE');
    expect(lines(unkept)).toContain('D300 2025-10 needs_evidence');
    expect(unkept.needs.map((need) => need.fact)).toContain('vat.status');
  });

  test("the form unknown: an individual's D212 and D204 wait, its need is listed, D406 is blocked", () => {
    const facts = known.filter((item) => item.axis !== 'entity.form');
    const result = closure({ facts });
    const form = 'profile.fact|profile:entity.form';
    expect(result.status).toBe('NEEDS_EVIDENCE');
    expect(result.needs.find((need) => need.id === form)).toMatchObject({
      code: 'FACT_UNKNOWN',
      fact: 'entity.form',
      rules: expect.arrayContaining(['fact.entity.form@2026-07']),
    });
    expect(lines(result).filter((line) => /^D2(12|04) /.test(line))).toEqual([]);
    // What depends on the form names its need: the micro tax, and D406 (a company's return, an
    // open question for an individual).
    expect(result.obligations.find((item) => item.kind === 'D100')).toMatchObject({
      period: '2026-09',
      state: 'needs_evidence',
      blockers: [form],
    });
    expect(result.obligations.find((item) => item.kind === 'D406')).toMatchObject({
      period: '2026-Q3',
      state: 'needs_evidence',
      blockers: [form],
      rule: 'obligation.d406@2026-09',
    });
    // A VAT payer whose form is unknown: D300 and D394 do not read the form, D406 does.
    const payer = [
      ...facts.filter((item) => !item.axis.startsWith('vat.')),
      fact('vat.status', 'normal_vat', '2020-01-01'),
      fact('vat.period', 'monthly', '2026-01-01'),
      fact('vat.cash', 'no', '2020-01-01'),
    ];
    const monthly = lines(closure({ facts: payer, determinations: [] }));
    expect(monthly.filter((line) => line.includes(' 2026-07 '))).toEqual([
      'D300 2026-07 applies',
      'D394 2026-07 applies',
      'D406 2026-07 needs_evidence',
    ]);
    // Known, an IF in the real system files D212 and D204.
    const family = closure({
      facts: [...facts, fact('entity.form', 'if', '2020-01-01')],
      books: { ...noBooks, incomeSources: [{ year: '2026', count: 1, real: true }] },
    });
    expect(lines(family)).toEqual(
      expect.arrayContaining(['D204 2026 applies', 'D212 2026 applies']),
    );
  });

  test('a single-entry PFA: no S1005, no D101 nor micro tax, and no D406 (OPANAF nr. 1.783/2021 anexa nr. 5 pct. 4)', () => {
    // Even a profit-tax fact recorded by mistake: income tax follows the form (title IV).
    const facts = [
      ...known.filter(
        (item) => !['entity.form', 'income_tax', 'size.category'].includes(item.axis),
      ),
      fact('entity.form', 'pfa', '2020-01-01'),
      fact('income_tax', 'profit', '2026-01-01'),
    ];
    const result = closure({ facts });
    expect(result.status).toBe('ELIGIBLE');
    expect(lines(result)).toEqual(['D212 2026 applies']);
    expect(result.unsupported).toEqual([]);
    // The D406 rule read the form and listed nothing: PFA, II and IF are exempt.
    expect(result.trace.find((item) => item.rule === 'obligation.d406@2026-09')?.read).toEqual(
      expect.arrayContaining(['form@2026-09=pfa (fapt entity.form)']),
    );
    // The statements follow the books: single entry has none (OMFP nr. 170/2015 cap. II pct. 11).
    expect(result.trace.find((item) => item.rule === 'fact.size.category@2026')?.produced).toEqual([
      'size@2026=none (partidă simplă)',
    ]);
    // A VAT-paying PFA: D300 and D394 as for any payer, and still no D406.
    const payer = closure({
      facts: [
        ...facts.filter((item) => !item.axis.startsWith('vat.')),
        fact('vat.status', 'normal_vat', '2020-01-01'),
        fact('vat.period', 'monthly', '2026-01-01'),
        fact('vat.cash', 'no', '2020-01-01'),
      ],
      determinations: [],
    });
    expect(lines(payer).filter((line) => line.includes(' 2026-07 '))).toEqual([
      'D300 2026-07 applies',
      'D394 2026-07 applies',
    ]);
  });

  test('cyclic or unresolved rules are a named gap, never a pass', () => {
    const evaluation = evaluateRules([
      {
        id: 'a',
        clauses: [],
        reads: ['y'],
        derives: ['x'],
        run: (read, emit) => emit.derive('x', read('y')),
      },
      {
        id: 'b',
        clauses: [],
        reads: ['x'],
        derives: ['y'],
        run: (read, emit) => emit.derive('y', read('x')),
      },
      { id: 'c', clauses: [], reads: ['z'], derives: [], run: () => undefined },
    ]);
    expect(evaluation.gaps).toEqual([
      expect.objectContaining({ code: 'CYCLE', rules: ['a', 'b'], slots: ['y', 'x'] }),
      expect.objectContaining({ code: 'UNRESOLVED', rules: ['c'], slots: ['z'] }),
    ]);
  });
});

describe('agent-ready', () => {
  test('documents, questions, detectors and templates', () => {
    expect(agent.documentTypes.map((item) => item.id)).toEqual([
      'onrc.extract',
      'registration.certificate',
      'd700',
      'shareholders.register',
      'annual.statements',
    ]);
    expect(agent.questions.map((item) => item.kind)).toEqual([
      'determination.confirm',
      'micro.conditions',
      'year.figures',
      'profile.fact',
    ]);
    expect(agent.detectors.map((item) => item.kind)).toEqual([
      'determination.missing',
      'threshold.approaching',
    ]);
    expect(agent.templates).toEqual([]);
  });
});

describe('D406 by taxpayer category and the annual assets file', () => {
  const start = d406StartOf(rules(), ['2024-06']);
  const at = start['2024-06']!;
  if ('gap' in at) throw new Error(at.gap);
  const category = (value: string, from: string) => fact('taxpayer.category', value, from);

  test('from 1 January 2025 every category files; before it, the category decides', () => {
    const begun = (facts: ProfileFact[], date: string) => {
      const result = d406Begun(facts, at.start, date);
      return result.state === 'known' ? result.value : 'unknown';
    };
    expect(begun([], '2025-01-01')).toBe(true);
    expect(begun([], '2024-06-30')).toBe('unknown');
    expect(begun([], '2021-12-31')).toBe(false);
    expect(begun([category('small', '2020-01-01')], '2024-06-30')).toBe(false);
    expect(begun([category('large', '2020-01-01')], '2022-01-31')).toBe(true);
    // Large from 1 January 2022 only (lit. b)): from 1 July 2022.
    expect(begun([category('large', '2022-01-01')], '2022-06-30')).toBe(false);
    expect(begun([category('large', '2022-01-01')], '2022-07-31')).toBe(true);
    expect(begun([category('medium', '2020-01-01')], '2023-01-31')).toBe(true);
    // Medium in 2021, small from 2023: the medium date never came while medium (pct. 1.2 a)).
    expect(
      begun([category('medium', '2020-01-01'), category('small', '2023-01-01')], '2024-06-30'),
    ).toBe(false);
    // Once begun, it continues (pct. 2): large in 2022, small from 2023.
    expect(
      begun([category('large', '2020-01-01'), category('small', '2023-01-01')], '2024-06-30'),
    ).toBe(true);
  });

  test('books before 2025 ask the category; a small taxpayer files from 2025', () => {
    const before = closure({
      interval: { from: '2024-10', to: '2025-03' },
      books: { ...noBooks, firstDay: '2024-01-01', financialYearEnds: ['2024-12-31'] },
      d406Start: d406StartOf(
        rules(),
        ['2024', '2025'].flatMap((year) =>
          Array.from({ length: 12 }, (_, index) => `${year}-${String(index + 1).padStart(2, '0')}`),
        ),
      ),
    });
    expect(lines(before).filter((line) => line.startsWith('D406'))).toEqual([
      'D406 2024-Q4 needs_evidence',
      'D406 2025-Q1 applies',
    ]);
    expect(before.needs.map((need) => need.fact)).toContain('taxpayer.category');
    const small = closure(
      {
        interval: { from: '2024-10', to: '2025-03' },
        books: { ...noBooks, firstDay: '2024-01-01', financialYearEnds: ['2024-12-31'] },
        d406Start: d406StartOf(
          rules(),
          ['2024', '2025'].flatMap((year) =>
            Array.from(
              { length: 12 },
              (_, index) => `${year}-${String(index + 1).padStart(2, '0')}`,
            ),
          ),
        ),
      },
      [...known, category('small', '2020-01-01')],
    );
    expect(lines(small).filter((line) => line.startsWith('D406'))).toEqual([
      'D406 2025-Q1 applies',
    ]);
    // A month the rule does not reach is a gap, never a guess.
    expect(closure({ d406Start: {} }).unsupported.map((item) => item.trigger)).toContain(
      'RULE_GAP',
    );
  });

  test('the annual assets file applies to a company holding fixed assets for a whole year', () => {
    const held = closure({ books: { ...noBooks, assetYears: ['2026'] } });
    expect(
      held.obligations.find((item) => item.period === '2026' && item.kind === 'D406'),
    ).toMatchObject({
      deadline: 'D406.assets',
      state: 'applies',
      rule: 'obligation.d406.assets@2026',
    });
    expect(lines(closure()).filter((line) => line === 'D406 2026 applies')).toEqual([]);
    // A first year from 10 June has fewer than twelve months: the validator refuses it.
    const short = closure({
      books: { ...noBooks, assetYears: ['2026'], firstDay: '2026-06-10' },
    });
    expect(short.unsupported.map((item) => item.trigger)).toContain('D406_ASSETS_SHORT_YEAR');
    // A PFA files no D406 at all.
    const pfa = closure({ books: { ...noBooks, assetYears: ['2026'] } }, [
      ...known.filter((item) => item.axis !== 'entity.form'),
      fact('entity.form', 'pfa', '2020-01-01'),
    ]);
    expect(lines(pfa).filter((line) => line.startsWith('D406'))).toEqual([]);
  });
});

describe('the half-year report in the closure', () => {
  const half = (status: 'required' | 'none' | 'unknown' | 'gap', missing: string[] = []) =>
    closure({
      interval: { from: '2026-06', to: '2026-06' },
      books: {
        ...noBooks,
        halfYear: [
          { year: '2026', status, due: '2026-08-18', message: 'Raportarea la 30 iunie.', missing },
        ],
      },
    });
  test('owed, it is UNSUPPORTED and kept outside; unknown, it names its question; a rule gap is one', () => {
    const owed = half('required');
    expect(owed.status).toBe('UNSUPPORTED');
    expect(owed.obligations).toContainEqual(
      expect.objectContaining({ kind: 'SF.halfyear', period: '2026-06', state: 'unsupported' }),
    );
    expect(owed.unsupported.map((item) => item.trigger)).toEqual(['HALFYEAR_REPORT']);
    const unknown = half('unknown', ['cifra de afaceri netă 2025']);
    expect(unknown.needs.map((need) => need.question.kind)).toEqual(['year.figures']);
    expect(half('gap').unsupported.map((item) => item.trigger)).toEqual(['RULE_GAP']);
    expect(half('none').obligations.map((item) => item.kind)).not.toContain('SF.halfyear');
  });
});
