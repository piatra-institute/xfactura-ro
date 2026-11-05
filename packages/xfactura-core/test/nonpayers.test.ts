import { describe, expect, test } from 'bun:test';
import type { ProfileFact } from '../src/kernel';
import {
  calculateD301,
  checkD301,
  d301PaymentNumber,
  writeD301,
  type D301,
} from '../src/ro/declarations/d301';
import {
  determineVatEu,
  determineVatStatus,
  determineVatThreshold,
  determineYear,
  evaluateClosure,
  type ClosureBooks,
  type DeterminationContext,
  type Known,
  type YearFigures,
} from '../src/ro/determinations';
import {
  agent,
  capitalGoodAdjustment,
  lateRegistrationExposure,
  type CapitalGoodsRule,
} from '../src/ro/nonpayers';
import { roRegister } from '../src/ro/register';
import { d406StartOf } from '../src/ro/saft/applicability';
import { clause } from '../src/ro/sources';
import { RuleContext } from '../src/rules';
import type { LocalDate } from '../src/time';

// Synthetic companies; amounts computed by hand.
const register = roRegister();
const rules = () => new RuleContext(register, 'preview');
const fact = (axis: string, value: string, effectiveFrom: string): ProfileFact => ({
  axis,
  value,
  effectiveFrom: effectiveFrom as LocalDate,
});
const books = <T>(value: T): Known<T> => ({ known: true, value, source: 'books', ref: null });
const lei = (amount: string) => BigInt(Math.round(Number(amount) * 100));
const figures = (year: number, exemption = '300000'): YearFigures => ({
  year,
  kept: true,
  turnover: books(lei(exemption)),
  netTurnover: books(lei(exemption)),
  totalRevenue: books(lei(exemption)),
  vatTurnover: books(0n),
  exemptionTurnover: books(lei(exemption)),
  totalAssets: books(0n),
  averageEmployees: books('0'),
  averageEmployeesD112: books('0'),
  euGoodsAcquisitions: books(false),
  eurRate: books({ rate: '5.0800', multiplier: 1, date: '2025-12-31' }),
});
const nonPayer = [
  fact('entity.form', 'srl', '2020-01-01'),
  fact('vat.status', 'non_vat', '2020-01-01'),
  fact('vat.eu', 'none', '2020-01-01'),
  fact('employer', 'no', '2020-01-01'),
  fact('income_tax', 'micro', '2026-01-01'),
  fact('size.category', 'micro', '2026-01-01'),
  fact('activity.goods', 'no', '2020-01-01'),
  fact('regime.excluded', 'none', '2020-01-01'),
];
const day = (date: string, amount: string) => ({
  date: date as LocalDate,
  exemption: lei(amount),
  vat: 0n,
});
function context(overrides: Partial<DeterminationContext> = {}): DeterminationContext {
  return {
    year: 2026,
    facts: nonPayer,
    previous: figures(2025),
    current: figures(2026),
    activity: { year: 2026, kept: true, quarterTurnover: [0n, 0n, 0n, 0n], days: [] },
    contracts: [],
    micro: { known: false, reason: 'n/a', question: null },
    today: '2026-10-30' as LocalDate,
    ...overrides,
  };
}
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
const months = Array.from(
  { length: 12 },
  (_, index) => `2026-${String(index + 1).padStart(2, '0')}`,
);
function closure(
  facts: ProfileFact[],
  books: Partial<ClosureBooks> = {},
  activity: Partial<DeterminationContext['activity']> = {},
  confirmed: Record<string, string> = {},
) {
  const determinations = determineYear(
    context({
      facts,
      activity: {
        year: 2026,
        kept: true,
        quarterTurnover: [0n, 0n, 0n, 0n],
        days: [],
        ...activity,
      },
    }),
    rules(),
  ).filter((item) => !['income_tax', 'size.category'].includes(item.axis));
  return evaluateClosure({
    interval: { from: '2026-07', to: '2026-12' },
    facts,
    determinations,
    confirmed,
    books: { ...noBooks, ...books },
    d406Start: d406StartOf(rules(), months),
  });
}

describe('registration after the small-enterprise threshold', () => {
  const crossing = [
    day('2026-03-10', '200000'),
    day('2026-09-15', '150000'),
    day('2026-10-05', '50000'),
  ];

  test('vat.status: a payer from the crossing day, valid from it (art. 316 alin. (1^1) lit. b))', () => {
    const status = determineVatStatus(
      context({
        activity: { year: 2026, kept: true, quarterTurnover: [0n, 0n, 0n, 0n], days: crossing },
      }),
      rules(),
    );
    expect(status).toMatchObject({
      status: 'proposed',
      value: 'non_vat',
      changes: [{ value: 'normal_vat', effectiveFrom: '2026-10-05' }],
    });
    expect(status.clauses).toContain('ANAF/Cod-fiscal-consolidat:art.316(1)(b),(1^1)');
    // Registered later than the crossing: the date stays the crossing's; the later date is said.
    const late = determineVatStatus(
      context({
        facts: [...nonPayer, fact('vat.status', 'normal_vat', '2026-11-03')],
        activity: { year: 2026, kept: true, quarterTurnover: [0n, 0n, 0n, 0n], days: crossing },
      }),
      rules(),
    );
    expect(late.changes).toEqual([
      expect.objectContaining({ value: 'normal_vat', effectiveFrom: '2026-10-05' }),
    ]);
    expect(late.lines.join(' ')).toContain('este după depășirea plafonului (2026-10-05)');
    // A registration recorded from the crossing day does not stop the count that finds it.
    const recorded = determineVatThreshold(
      context({
        facts: [...nonPayer, fact('vat.status', 'normal_vat', '2026-10-05')],
        activity: { year: 2026, kept: true, quarterTurnover: [0n, 0n, 0n, 0n], days: crossing },
      }),
      rules(),
    );
    expect(recorded.changes).toEqual([
      expect.objectContaining({ value: 'exceeded', effectiveFrom: '2026-10-05' }),
    ]);
    // A registration by option before any crossing is taken from the recorded fact.
    const option = determineVatStatus(
      context({ facts: [...nonPayer, fact('vat.status', 'normal_vat', '2026-04-01')] }),
      rules(),
    );
    expect(option.changes).toEqual([
      expect.objectContaining({ value: 'normal_vat', effectiveFrom: '2026-04-01' }),
    ]);
  });

  test('a company set up during the year: the whole threshold, from its first day (art. 310 alin. (5))', () => {
    const facts = [
      fact('entity.form', 'srl', '2026-05-12'),
      fact('vat.status', 'non_vat', '2026-05-12'),
    ];
    const threshold = determineVatThreshold(
      context({
        facts,
        activity: {
          year: 2026,
          kept: false,
          start: '2026-05-12' as LocalDate,
          quarterTurnover: [0n, 0n, 0n, 0n],
          days: [day('2026-06-01', '300000'), day('2026-11-20', '95000.01')],
        },
      }),
      rules(),
    );
    expect(threshold).toMatchObject({
      status: 'proposed',
      effectiveFrom: '2026-05-12',
      changes: [{ value: 'exceeded', effectiveFrom: '2026-11-20' }],
    });
    expect(threshold.clauses).toContain('ANAF/Cod-fiscal-consolidat:art.310(4)-(5)');
    expect(threshold.lines[0]).toContain('plafonul nu se proporționalizează');
    // Without the start and with the year not kept from 1 January, nothing is assumed.
    expect(
      determineVatThreshold(
        context({
          facts,
          activity: { year: 2026, kept: false, quarterTurnover: [0n, 0n, 0n, 0n], days: [] },
        }),
        rules(),
      ).status,
    ).toBe('needs_evidence');
  });

  test('the closure asks for the registration, then lists the returns from it', () => {
    const before = closure(nonPayer, {}, { days: crossing });
    expect(before.status).toBe('NEEDS_EVIDENCE');
    expect(before.needs).toContainEqual(
      expect.objectContaining({ code: 'DETERMINATION_CONFLICT', fact: 'vat.status/2026' }),
    );
    expect(before.obligations.find((item) => item.kind === 'D300')).toMatchObject({
      period: '2026-10',
      state: 'needs_evidence',
    });
    const registered = closure(
      [
        ...nonPayer,
        fact('vat.status', 'normal_vat', '2026-10-05'),
        fact('vat.period', 'quarterly', '2026-10-05'),
      ],
      {},
      { days: crossing },
    );
    expect(
      registered.obligations
        .filter((item) => item.kind === 'D300')
        .map((item) => `${item.period} ${item.state}`),
    ).toEqual(['2026-Q4 applies']);
    expect(registered.needs.filter((need) => need.fact.startsWith('vat.status'))).toEqual([]);
  });
});

describe('the VAT owed for registering late (art. 310 alin. (6^1)–(6^2))', () => {
  test('inclusive and added readings, deductions decided or not', () => {
    const exposure = lateRegistrationExposure({
      from: '2026-10-05' as LocalDate,
      until: '2026-10-31' as LocalDate,
      revenueBani: lei('90000'),
      abroadBani: lei('15000'),
      excludedBani: lei('4500'),
      rate: '21',
      limitedShare: '50',
      purchases: [
        {
          documentId: 'a',
          number: 'A-1',
          taxPoint: '2026-10-12' as LocalDate,
          baseBani: lei('1000'),
          vatBani: lei('210'),
          deduction: 'full',
        },
        {
          documentId: 'b',
          number: 'A-2',
          taxPoint: '2026-10-15' as LocalDate,
          baseBani: lei('2000'),
          vatBani: lei('420'),
          deduction: 'limited',
        },
      ],
    });
    // 70.500 lei taxable: 70.500 × 21 / 121 = 12.235,54; added: 14.805,00.
    expect(exposure.considerationBani).toBe(lei('70500'));
    expect(exposure.collected.inclusive).toEqual({
      baseBani: lei('58264.46'),
      vatBani: lei('12235.54'),
    });
    expect(exposure.collected.added.vatBani).toBe(lei('14805'));
    expect(exposure.deductibleBani).toBe(lei('420'));
    expect(exposure.net).toEqual({ inclusive: lei('11815.54'), added: lei('14385') });
    const undecided = lateRegistrationExposure({
      from: '2026-10-05' as LocalDate,
      until: '2026-10-31' as LocalDate,
      revenueBani: lei('1000'),
      abroadBani: 0n,
      excludedBani: 0n,
      rate: '21',
      limitedShare: '50',
      purchases: [
        {
          documentId: 'a',
          number: 'A-1',
          taxPoint: '2026-10-12' as LocalDate,
          baseBani: lei('100'),
          vatBani: lei('21'),
          deduction: null,
        },
      ],
    });
    expect([undecided.undecided, undecided.net]).toEqual([1, null]);
  });

  test("the capital goods' once-for-all adjustment, the change's year included (art. 305 alin. (5))", () => {
    const rule = new RuleContext(register, 'preview').param<CapitalGoodsRule>(
      'ro.vat.capital_goods',
      'vat_chargeability_date',
      '2026-08-20' as LocalDate,
    );
    const good = {
      assetId: 'a',
      number: 'MF-1',
      name: 'Laptop',
      immovable: false,
      acquiredOn: '2025-09-10' as LocalDate,
      vatBani: lei('2100'),
      deductedBani: lei('2100'),
    };
    expect(
      capitalGoodAdjustment(good, 'deregistration', '2026-08-20' as LocalDate, rule),
    ).toMatchObject({ years: 5, remaining: 4, bani: -lei('1680') });
    // Entering VAT: the VAT not deducted, in favour of the company.
    expect(
      capitalGoodAdjustment(
        { ...good, deductedBani: 0n },
        'registration',
        '2026-10-05' as LocalDate,
        rule,
      ).bani,
    ).toBe(lei('1680'));
    // A building: twenty years; past the period, nothing.
    expect(
      capitalGoodAdjustment(
        {
          ...good,
          immovable: true,
          acquiredOn: '2018-03-15' as LocalDate,
          vatBani: lei('190000'),
          deductedBani: lei('190000'),
        },
        'deregistration',
        '2026-07-01' as LocalDate,
        rule,
      ),
    ).toMatchObject({ years: 20, remaining: 12, bani: -lei('114000') });
    expect(
      capitalGoodAdjustment(
        { ...good, acquiredOn: '2020-02-01' as LocalDate },
        'deregistration',
        '2026-07-01' as LocalDate,
        rule,
      ).bani,
    ).toBe(0n);
  });
});

describe('the art. 317 code: D301 and D390', () => {
  const coded = nonPayer.map((item) =>
    item.axis === 'vat.eu' ? fact('vat.eu', 'special', '2026-01-15') : item,
  );
  const meta = {
    date: '2026-10-15' as LocalDate,
    documentId: 'meta',
    number: 'FB-1',
    direction: 'purchase' as const,
    country: 'IE',
  };

  test('the code a non-payer needs before its first EU service (art. 317 alin. (1))', () => {
    const activity = {
      year: 2026,
      kept: true,
      quarterTurnover: [0n, 0n, 0n, 0n] as const,
      days: [],
      euServices: [meta],
    };
    expect(determineVatEu(context({ activity }), rules())).toMatchObject({
      status: 'proposed',
      value: 'special',
      effectiveFrom: '2026-10-15',
    });
    expect(determineVatEu(context({ facts: coded, activity }), rules())).toMatchObject({
      value: 'special',
      effectiveFrom: '2026-01-15',
    });
    // A payer needs none; a non-payer without EU services, nothing to compute.
    expect(
      determineVatEu(
        context({ facts: [fact('vat.status', 'normal_vat', '2020-01-01')], activity }),
        rules(),
      ).status,
    ).toBe('not_applicable');
  });

  test('with the code: D301 and D390 apply, the purchases are covered', () => {
    const result = closure(
      coded,
      {
        euServiceMonths: ['2026-10'],
        foreignPurchases: [
          { month: '2026-10', documentId: 'meta', country: 'IE', reverseCharge: true },
          { month: '2026-10', documentId: 'openai', country: 'US', reverseCharge: true },
        ],
        reverseCharges: [
          { date: '2026-10-15', documentId: 'meta', code: 'RC-EU-SERV' },
          { date: '2026-10-03', documentId: 'openai', code: 'RC-NONEU-SERV' },
        ],
      },
      { euServices: [meta] },
    );
    expect(result.unsupported).toEqual([]);
    expect(
      result.obligations
        .filter((item) => ['D301', 'D390'].includes(item.kind))
        .map((item) => `${item.kind} ${item.period} ${item.state}`),
    ).toEqual(['D301 2026-10 applies', 'D390 2026-10 applies']);
    for (const rule of result.trace.filter((item) => item.rule.startsWith('obligation.d301')))
      expect(rule.rule).toBe('obligation.d301@2026-10');
  });

  test('without it: D301 still applies to a US service; an EU one needs the code first', () => {
    const us = closure(nonPayer, {
      foreignPurchases: [
        { month: '2026-10', documentId: 'openai', country: 'US', reverseCharge: true },
      ],
      reverseCharges: [{ date: '2026-10-03', documentId: 'openai', code: 'RC-NONEU-SERV' }],
    });
    expect(us.unsupported).toEqual([]);
    expect(us.obligations.find((item) => item.kind === 'D301')?.state).toBe('applies');
    const eu = closure(
      nonPayer,
      {
        euServiceMonths: ['2026-10'],
        foreignPurchases: [
          { month: '2026-10', documentId: 'meta', country: 'IE', reverseCharge: true },
        ],
        reverseCharges: [{ date: '2026-10-15', documentId: 'meta', code: 'RC-EU-SERV' }],
      },
      { euServices: [meta] },
    );
    // The code is computed as needed: asked against the recorded `none`.
    expect(eu.needs).toContainEqual(
      expect.objectContaining({ code: 'DETERMINATION_CONFLICT', fact: 'vat.eu/2026' }),
    );
    expect(eu.obligations.find((item) => item.kind === 'D390')?.state).toBe('needs_evidence');
    // A person confirms the company holds no code: then it is a known case not covered.
    const computed = determineYear(
      context({
        activity: {
          year: 2026,
          kept: true,
          quarterTurnover: [0n, 0n, 0n, 0n],
          days: [],
          euServices: [meta],
        },
      }),
      rules(),
    ).find((item) => item.axis === 'vat.eu')!;
    const confirmed = closure(
      nonPayer,
      {
        euServiceMonths: ['2026-10'],
        foreignPurchases: [
          { month: '2026-10', documentId: 'meta', country: 'IE', reverseCharge: true },
        ],
        reverseCharges: [{ date: '2026-10-15', documentId: 'meta', code: 'RC-EU-SERV' }],
      },
      { euServices: [meta] },
      { 'vat.eu/2026': computed.fingerprint },
    );
    expect(confirmed.unsupported.map((item) => item.trigger)).toEqual([
      'EU_SERVICES_NON_VAT',
      'FOREIGN_SERVICE_PURCHASE',
    ]);
    expect(confirmed.obligations.find((item) => item.kind === 'D301')?.state).toBe('applies');
  });

  test('the closure cites registered clauses only', () => {
    for (const item of closure(coded, {
      reverseCharges: [{ date: '2026-10-15', documentId: 'm', code: 'RC-EU-SERV' }],
    }).obligations)
      for (const id of item.clauses) expect(clause(id)).toBeDefined();
  });

  test('D301: totals, 4.1 within 4, nr_evid and the XML', () => {
    const line = {
      number: 'FB-1',
      date: '2026-10-15',
      currencyValue: '1000.00',
      currency: 'EUR',
      rate: '5.0912',
      baseBani: 509100n,
      vatBani: 106900n,
    };
    const model: D301 = {
      period: { year: 2026, month: 10 },
      rectification: false,
      afterReserveCancellation: 0,
      company: { cif: '18547290', name: 'Exemplu', bank: 'Trezoreria', account: 'RO12TREZ' },
      registeredArt317: true,
      declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' },
      lines: [
        { ...line, section: 4 },
        { ...line, section: 5 },
      ],
    };
    expect(checkD301(model)).toEqual([]);
    expect(calculateD301(model)).toMatchObject({ payable: 106900n, control: 12320n });
    expect(d301PaymentNumber({ year: 2026, month: 10 })).toBe('10301011026251126000032');
    const xml = writeD301(model);
    expect(xml).toContain('pers_inreg="2"');
    expect(xml).toContain('baza4="5091.00" tva4="1069.00" baza5="5091.00" tva5="1069.00"');
    expect(xml).toContain('data_doc="15.10.2026"');
    expect(
      checkD301({
        ...model,
        lines: [{ ...line, section: 5 }],
        company: { ...model.company, cif: 'RO18547290' },
      }).map((check) => check.code),
    ).toEqual(['D301_CIF', 'D301_SECTION_41']);
  });
});

describe('leaving the VAT system', () => {
  const payer = [
    fact('entity.form', 'srl', '2020-01-01'),
    fact('vat.status', 'normal_vat', '2020-01-01'),
    fact('vat.period', 'quarterly', '2026-01-01'),
    fact('vat.cash', 'no', '2020-01-01'),
    fact('vat.eu', 'none', '2020-01-01'),
    fact('employer', 'no', '2020-01-01'),
    fact('income_tax', 'micro', '2026-01-01'),
    fact('size.category', 'micro', '2026-01-01'),
    fact('activity.goods', 'no', '2020-01-01'),
    fact('regime.excluded', 'none', '2020-01-01'),
    fact('vat.status', 'non_vat', '2026-08-20'),
  ];

  test('the last D300 covers the quarter to the cancellation, due after its month (art. 316 alin. (13))', () => {
    const result = closure(payer);
    expect(
      result.obligations
        .filter((item) => item.kind === 'D300')
        .map((item) => `${item.period} ${item.state} ${item.deadlinePeriod}`),
    ).toEqual(['2026-Q3 applies 2026-08']);
    expect(determineVatStatus(context({ facts: payer }), rules())).toMatchObject({
      changes: [{ value: 'non_vat', effectiveFrom: '2026-08-20' }],
    });
    // The previous year above the threshold: the law does not allow it, the closure asks.
    const ineligible = determineVatStatus(
      context({ facts: payer, previous: figures(2025, '400000') }),
      rules(),
    );
    expect(ineligible.changes).toEqual([]);
  });
});

describe('agent-ready', () => {
  test('documents, questions and detectors name what drives the module', () => {
    expect(agent.documentTypes.map((item) => item.id)).toContain('vat.art317.certificate');
    expect(agent.questions.map((item) => item.kind)).toEqual([
      'determination.confirm',
      'profile.fact',
    ]);
    expect(agent.detectors.map((item) => item.kind)).toEqual([
      'threshold.approaching',
      'determination.missing',
      'obligation.due',
    ]);
    for (const detector of agent.detectors)
      for (const key of detector.rules) expect(register.keys()).toContain(key);
    expect(agent.templates).toEqual([]);
  });
});
