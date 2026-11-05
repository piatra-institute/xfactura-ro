import { describe, expect, test } from 'bun:test';
import {
  turnoverKey,
  type AccountTurnover,
  type AnswerRecord,
  type AssetState,
  type JsonValue,
  type Loaded,
  type ProfileFact,
  type ProfitPosting,
} from '../src/kernel';
import { parseMoney } from '../src/money';
import { accountClassifications } from '../src/ro/profit/accounts';
import { assetDeduction, fiscalThrough, type FiscalBasis } from '../src/ro/profit/depreciation';
import { recoverLosses } from '../src/ro/profit/losses';
import { fiscalRegister } from '../src/ro/profit/register';
import {
  calculateD101,
  checkD101,
  d101Due,
  d101PaymentNumber,
  d101Rows,
  deriveD101Rows,
  type D101Rows,
} from '../src/ro/declarations/d101';
import { profitNatures } from '../src/questions/kinds';
import { agent as profitAgent } from '../src/ro/profit';
import { roRegister } from '../src/ro/register';
import { emptyLoaded } from '../src/ro/reviews/specs/world';
import {
  priorYearCorrection,
  profitTax,
  profitTaxInput,
  type ProfitPosition,
} from '../src/ro/treatments/profit-tax';
import { RuleContext } from '../src/rules';
import type { LocalDate } from '../src/time';

/*
 * The profit tax by hand-checked cases: the rows of the bridge, the fiscal depreciation, the loss
 * vintages and the D101 the quarter's and the year's computations write. Amounts are from Codul
 * fiscal title II as the parameters cite it; the arithmetic is shown beside each.
 */

const AUTHORITY = '00000000-0000-4000-8000-0000000000a1';
const EVIDENCE = '00000000-0000-4000-8000-0000000000e1';
const rules = () => new RuleContext(roRegister(), 'preview');
const fact = (axis: string, value: string, effectiveFrom: string): ProfileFact => ({
  axis,
  value,
  effectiveFrom: effectiveFrom as LocalDate,
});
const bani = (lei: string) => parseMoney(lei, 'RON');
const row = (account: string, debit: string, credit = '0'): AccountTurnover => ({
  account,
  debit: bani(debit),
  credit: bani(credit),
});
let answerSeq = 0;
const answer = (
  kind: string,
  subject: { kind: string; id: string },
  value: JsonValue,
): AnswerRecord => {
  answerSeq += 1;
  return {
    questionId: `q-${answerSeq}`,
    answerId: `a-${answerSeq}`,
    kind,
    subject,
    params: {},
    value,
    evidenceId: EVIDENCE,
    answeredAt: `2026-01-01T00:00:${String(answerSeq).padStart(2, '0')}Z`,
  };
};
const classify = (account: string, nature: string, extra: Record<string, JsonValue> = {}) =>
  answer(
    'profit.account',
    { kind: 'account', id: account },
    { nature, evidenceIds: [EVIDENCE], ...extra },
  );
const noLosses = () =>
  answer(
    'profit.losses',
    { kind: 'company', id: 'losses' },
    { vintages: [], evidenceIds: [EVIDENCE] },
  );

interface World {
  period: string;
  date?: string;
  facts?: ProfileFact[];
  /** Classes 6–7 from the period's start to its end. */
  result: AccountTurnover[];
  capital?: string;
  reserve?: string;
  answers?: AnswerRecord[];
  assets?: AssetState[];
  postings?: ProfitPosting[];
  /** The previous financial year is kept, with this 70x turnover. */
  previousTurnover?: string;
  input?: Record<string, unknown>;
}

const quarterly = [
  fact('income_tax', 'profit', '2026-01-01'),
  fact('profit.system', 'quarterly', '2026-01-01'),
];

function run(world: World) {
  const input = profitTaxInput.parse({
    period: world.period,
    date: world.date ?? (world.period.length === 4 ? `${world.period}-12-31` : '2026-09-30'),
    authorityId: AUTHORITY,
    ...world.input,
  });
  const loaded: Loaded = {
    ...emptyLoaded(world.facts ?? quarterly),
    years: world.previousTurnover
      ? [
          {
            id: 'y2025',
            kind: 'financial',
            from: '2025-01-01' as LocalDate,
            to: '2025-12-31' as LocalDate,
          },
        ]
      : [],
    evidence: new Map([
      [EVIDENCE, { id: EVIDENCE, hash: 'h', filename: 'e.pdf', mediaType: 'application/pdf' }],
    ]),
    parties: new Map([
      [
        AUTHORITY,
        { id: AUTHORITY, kind: 'ro_public_institution', country: 'RO', taxId: null, name: 'ANAF' },
      ],
    ]),
    answers: new Map((world.answers ?? [noLosses()]).map((item) => [item.questionId, item])),
    assets: new Map((world.assets ?? []).map((asset) => [asset.id, asset])),
    profitPostings: world.postings ?? [],
    fxRates: new Map([
      [
        'EUR',
        [
          {
            id: 'e1',
            source: 'BNR',
            currency: 'EUR',
            date: '2026-12-31' as LocalDate,
            rate: '5.0900',
            multiplier: 1,
          },
          {
            id: 'e2',
            source: 'BNR',
            currency: 'EUR',
            date: '2026-09-30' as LocalDate,
            rate: '5.0900',
            multiplier: 1,
          },
          {
            id: 'e0',
            source: 'BNR',
            currency: 'EUR',
            date: '2025-12-31' as LocalDate,
            rate: '5.0800',
            multiplier: 1,
          },
        ],
      ],
    ]),
  };
  // A rectification reads no turnover: it starts from the year's last position.
  const plan = profitTax.followUp!(input, loaded);
  const turnover = new Map<string, AccountTurnover[]>();
  if (plan) {
    const [result, capital, reserve, previous, microFx] = plan.turnover!;
    turnover.set(turnoverKey(result!), world.result);
    turnover.set(turnoverKey(capital!), world.capital ? [row('1012', '0', world.capital)] : []);
    turnover.set(turnoverKey(reserve!), world.reserve ? [row('1061', '0', world.reserve)] : []);
    turnover.set(
      turnoverKey(previous!),
      world.previousTurnover ? [row('704', '0', world.previousTurnover)] : [],
    );
    if (microFx)
      turnover.set(turnoverKey(microFx), [row('765', '0', '400.00'), row('665', '100.00')]);
  }
  const evaluation = profitTax.evaluate(input, { ...loaded, turnover }, rules());
  const details = (evaluation.effect?.explanation.details ?? {}) as { position?: ProfitPosition };
  return { ...evaluation, position: details.position ?? null };
}
const codes = (result: { issues: { code: string }[] }) => result.issues.map((issue) => issue.code);
const lines = (result: ReturnType<typeof run>) =>
  result.effect?.lines.map((line) => `${line.side} ${line.account} ${line.bani}`) ?? [];

describe('the tax bridge', () => {
  test('a quarter: protocol over 2%, social over 5%, fines, the tax on the cumulated result', () => {
    const result = run({
      period: '2026-Q3',
      answers: [
        noLosses(),
        classify('623', 'protocol'),
        classify('6581', 'fine'),
        classify('6458', 'social'),
      ],
      result: [
        row('704', '0', '100000.00'),
        row('628', '40000.00'),
        row('623', '3000.00'),
        row('6581', '500.00'),
        row('641', '20000.00'),
        row('6458', '2000.00'),
      ],
      capital: '200.00',
      input: { legalReserve: { evidenceId: EVIDENCE } },
    });
    // No computation of the first two quarters: the third cumulates them, confirmed.
    expect(codes(result)).toEqual([
      'PROFIT_MINIMUM_TAX',
      'PROFIT_QUARTER_MISSING',
      'PROFIT_QUARTER_MISSING',
    ]);
    const rows = result.position!.rows;
    // Profit before tax 100,000 − 65,500 = 34,500. Protocol limit 2% × (34,500 + 3,000) = 750:
    // 2,250 over. Social limit 5% × 20,000 = 1,000: 1,000 over. Legal reserve: 5% × 34,500 =
    // 1,725, capped at a fifth of 200 lei = 40.
    expect([rows.P1, rows.P2, rows.P7, rows.P13, rows.P25, rows.P26, rows.P33]).toEqual([
      '100000',
      '65500',
      '34500',
      '40',
      '500',
      '2250',
      '1000',
    ]);
    // 34,500 − 40 + 500 + 2,250 + 1,000 = 38,210 taxable; 16% = 6,113.6 → 6,114.
    expect([rows.P35, rows.P40, rows.P41, rows.P48]).toEqual(['38210', '38210', '6114', '6114']);
    expect(lines(result)).toEqual(['D 691 611400', 'C 4411 611400']);
    expect(
      checkD101({ ...model(), rows: toRows(rows) }).filter((check) => check.severity === 'error'),
    ).toEqual([]);
  });

  test('an account whose deductibility depends on facts is asked, never guessed', () => {
    const result = run({
      period: '2026-Q1',
      date: '2026-03-31',
      result: [row('704', '0', '10000.00'), row('623', '500.00')],
    });
    expect(result.effect).toBeNull();
    const issue = result.issues.find((item) => item.code === 'PROFIT_CLASSIFICATION')!;
    expect(issue.details).toEqual({
      question: {
        kind: 'profit.account',
        subject: { kind: 'account', id: '623' },
        params: { account: '623' },
      },
    });
    // The system of payment, when nothing says the company was a micro-enterprise.
    const system = run({
      period: '2026-Q1',
      date: '2026-03-31',
      facts: [fact('income_tax', 'profit', '2026-01-01')],
      result: [row('704', '0', '10.00')],
    });
    expect(codes(system)).toContain('PROFIT_SYSTEM');
    // The annual system with prepayments is not covered.
    const annual = run({
      period: '2026-Q1',
      date: '2026-03-31',
      facts: [
        fact('income_tax', 'profit', '2026-01-01'),
        fact('profit.system', 'annual', '2026-01-01'),
      ],
      result: [row('704', '0', '10.00')],
    });
    expect(codes(annual)).toContain('PROFIT_ANNUAL_SYSTEM');
    // The losses carried in must be known.
    expect(
      codes(
        run({
          period: '2026-Q1',
          date: '2026-03-31',
          answers: [],
          result: [row('704', '0', '10.00')],
        }),
      ),
    ).toContain('PROFIT_LOSSES');
  });

  test('a vehicle not used only for the business: half its costs, the VAT kept included', () => {
    const vehicle = (use: 'mixed' | 'business_only') =>
      answer(
        'vehicle.use',
        { kind: 'vehicle', id: 'B123ABC' },
        {
          use,
          from: '2026-01-01',
          ...(use === 'business_only' ? { logEvidenceId: EVIDENCE } : {}),
        },
      );
    const world = (use: 'mixed' | 'business_only'): World => ({
      period: '2026-Q1',
      date: '2026-03-31',
      answers: [
        noLosses(),
        classify('6022.B123ABC', 'vehicle', { vehicle: 'B-123-ABC' }),
        vehicle(use),
      ],
      result: [row('704', '0', '10000.00'), row('6022.B123ABC', '1100.00')],
    });
    // Norme pct. 16 alin. (3), exemplul 2: 1,000 fuel + 100 VAT kept = 1,100 → 550 not deductible.
    expect(run(world('mixed')).position!.rows.P33).toBe('550');
    expect(run(world('business_only')).position!.rows.P33).toBe('0');
    const unanswered = run({
      ...world('mixed'),
      answers: [noLosses(), classify('6022.B123ABC', 'vehicle', { vehicle: 'B123ABC' })],
    });
    expect(codes(unanswered)).toContain('VEHICLE_USE');
  });

  test('FP-04: a 2024 loss of 100,000 recovered from 60,000 at 70%', () => {
    const result = run({
      period: '2026',
      answers: [
        answer(
          'profit.losses',
          { kind: 'company', id: 'losses' },
          {
            vintages: [{ year: 2024, amount: '100000', remaining: '100000' }],
            evidenceIds: [EVIDENCE],
          },
        ),
      ],
      result: [row('704', '0', '100000.00'), row('628', '40000.00')],
    });
    const rows = result.position!.rows;
    // min(100,000, 70% × 60,000) = 42,000; 18,000 taxable; 16% = 2,880; 58,000 left.
    expect([rows.P38a, rows.P39, rows.P39a, rows.P40, rows.P41]).toEqual([
      '60000',
      '100000',
      '42000',
      '18000',
      '2880',
    ]);
    expect(result.position!.losses.after).toEqual([
      { year: 2024, amount: '100000', remaining: '58000' },
    ]);
    expect(lines(result)).toEqual(['D 691 288000', 'C 4411 288000']);
  });

  test('FP-05: sponsorship added back and credited within 0.75% of turnover and 20% of the tax', () => {
    const result = run({
      period: '2026',
      answers: [noLosses(), classify('6582', 'sponsorship')],
      result: [row('704', '0', '200000.00'), row('628', '100000.00'), row('6582', '2000.00')],
    });
    const rows = result.position!.rows;
    // Taxable 98,000 + 2,000 added back = 100,000; tax 16,000; credit min(2,000, 1,500, 3,200).
    expect([rows.P27, rows.P40, rows.P41, rows.P43, rows.P48]).toEqual([
      '2000',
      '100000',
      '16000',
      '1500',
      '14500',
    ]);
    // Unused 500: no carry-forward invented.
    expect(rows.P432).toBe('0');
  });

  test('a loss year books nothing but records the vintage; the next year recovers it', () => {
    const loss = run({
      period: '2026',
      answers: [noLosses()],
      result: [row('704', '0', '50000.00'), row('628', '80000.00')],
    });
    expect(loss.effect?.journalClass).toBe('memo');
    expect(loss.position!.rows.P40a).toBe('30000');
    expect(loss.position!.losses.after).toEqual([
      { year: 2026, amount: '30000', remaining: '30000' },
    ]);
    const next = run({
      period: '2027-Q1',
      date: '2027-03-31',
      facts: quarterly,
      answers: [],
      postings: [posting(loss.position!)],
      result: [row('704', '0', '20000.00')],
    });
    // 2027 has no versions yet: the rules stop it, never a fallback.
    expect(codes(next)).toContain('RULE_GAP');
  });

  test('quarters cumulate: the third declares what the first two did not', () => {
    const q1 = run({
      period: '2026-Q1',
      date: '2026-03-31',
      result: [row('704', '0', '10000.00')],
    });
    expect(q1.position!.tax).toEqual({ cumulative: '1600', declared: '0', due: '1600' });
    const q3 = run({
      period: '2026-Q3',
      postings: [posting(q1.position!)],
      result: [row('704', '0', '30000.00'), row('691', '1600.00')],
    });
    // 30,000 − 1,600 + 1,600 added back = 30,000; 4,800 cumulated; 1,600 declared; 3,200 due.
    expect(q3.position!.tax).toEqual({ cumulative: '4800', declared: '1600', due: '3200' });
    expect(codes(q3)).toContain('PROFIT_QUARTER_MISSING');
    const year = run({
      period: '2026',
      postings: [posting(q1.position!), posting(q3.position!)],
      result: [row('704', '0', '20000.00'), row('691', '4800.00')],
    });
    // The year earned less than its quarters declared: 3,200 to recover, booked back.
    expect([year.position!.rows.P48, year.position!.rows.P50, year.position!.rows.P53]).toEqual([
      '3200',
      '4800',
      '1600',
    ]);
    expect(lines(year)).toEqual(['D 4411 160000', 'C 691 160000']);
  });

  test('leaving micro in Q3: the year from 1 July, the micro months’ FX gain as revenue', () => {
    const facts = [
      fact('income_tax', 'micro', '2026-01-01'),
      fact('income_tax', 'profit', '2026-07-01'),
    ];
    const q3 = run({ period: '2026-Q3', facts, result: [row('704', '0', '20000.00')] });
    expect(codes(q3)).toEqual(['PROFIT_MINIMUM_TAX']);
    // Art. 53 alin. (2) lit. b): 400 − 100 = 300 of FX gain before July, in the first quarter.
    expect([q3.position!.rows.P8, q3.position!.rows.P40, q3.position!.rows.P41]).toEqual([
      '300',
      '20300',
      '3248',
    ]);
    expect([q3.position!.start, q3.position!.microExitQuarter]).toEqual(['2026-07-01', 3]);
    const q2 = run({ period: '2026-Q2', date: '2026-06-30', facts, result: [] });
    expect(codes(q2)).toContain('NOT_PROFIT');
  });

  test('the minimum turnover tax: confirmed without the previous year, refused above 50 million euro', () => {
    const over = run({
      period: '2026-Q1',
      date: '2026-03-31',
      previousTurnover: '254000001.00',
      result: [row('704', '0', '10.00')],
    });
    expect(codes(over)).toContain('PROFIT_MINIMUM_TAX');
    expect(over.issues.find((item) => item.code === 'PROFIT_MINIMUM_TAX')!.severity).toBe('block');
    const under = run({
      period: '2026-Q1',
      date: '2026-03-31',
      previousTurnover: '800000.00',
      result: [row('704', '0', '10.00')],
    });
    expect(codes(under)).toEqual([]);
  });

  test('the previous year’s turnover a cited answer states settles the minimum tax', () => {
    const figures = (turnover: string) =>
      answer(
        'year.figures',
        { kind: 'year', id: '2025' },
        { values: { turnover, netTurnover: turnover }, evidenceIds: [EVIDENCE] },
      );
    const quarter = (extra: AnswerRecord[]) =>
      run({
        period: '2026-Q1',
        date: '2026-03-31',
        answers: [noLosses(), ...extra],
        result: [row('704', '0', '10.00')],
      });
    // 50,000,000 € at 5.0800 (31.12.2025) is 254,000,000.00 lei.
    expect(codes(quarter([figures('800000.00')]))).toEqual([]);
    const over = quarter([figures('254000000.01')]);
    expect(over.issues.find((item) => item.code === 'PROFIT_MINIMUM_TAX')?.severity).toBe('block');
    // Another year's figures settle nothing: the reviewer confirms.
    const other = answer(
      'year.figures',
      { kind: 'year', id: '2024' },
      { values: { turnover: '800000.00' }, evidenceIds: [EVIDENCE] },
    );
    expect(quarter([other]).issues.map((item) => `${item.severity} ${item.code}`)).toEqual([
      'ack PROFIT_MINIMUM_TAX',
    ]);
  });

  test('the legal reserve is asked only while it has room under a fifth of the capital', () => {
    const quarter = (reserve?: string) =>
      run({
        period: '2026-Q1',
        date: '2026-03-31',
        previousTurnover: '800000.00',
        result: [row('704', '0', '10000.00')],
        capital: '200.00',
        ...(reserve ? { reserve } : {}),
      });
    expect(codes(quarter())).toEqual(['LEGAL_RESERVE']);
    expect(codes(quarter('30.00'))).toEqual(['LEGAL_RESERVE']);
    // 40 lei, a fifth of 200: nothing more is set aside, nor deducted.
    const full = quarter('40.00');
    expect(codes(full)).toEqual([]);
    expect(full.position!.rows.P13).toBe('0');
  });

  test('the tax is due with its return: a quarter’s D100, the year’s D101', () => {
    const due = (period: string, date?: string) =>
      run({
        period,
        ...(date ? { date } : {}),
        previousTurnover: '800000.00',
        result: [row('704', '0', '10000.00')],
        input: { legalReserve: { evidenceId: EVIDENCE } },
      }).effect?.openItems[0]?.dueDate;
    // 25 April 2026 is a Saturday: the next working day.
    expect(due('2026-Q1', '2026-03-31')).toBe('2026-04-27' as LocalDate);
    expect(due('2026')).toBe('2027-06-25' as LocalDate);
  });

  test('losses stated for the books’ start are whole lei, rounded as D101 rounds, never cut', () => {
    const stated = answer(
      'profit.losses',
      { kind: 'company', id: 'losses' },
      {
        vintages: [{ year: 2024, amount: '1000.50', remaining: '600.49' }],
        evidenceIds: [EVIDENCE],
      },
    );
    const year = run({
      period: '2026',
      previousTurnover: '800000.00',
      answers: [stated],
      result: [row('704', '0', '10000.00')],
    });
    expect(year.position!.losses.before).toEqual([
      { year: 2024, amount: '1001', remaining: '600' },
    ]);
  });

  test('the annual tax refuses a year whose result is closed', () => {
    const closed = run({
      period: '2026',
      result: [row('704', '0', '10.00'), row('121', '0', '10.00')],
    });
    expect(codes(closed)).toContain('YEAR_CLOSED');
  });
});

describe('fiscal depreciation (art. 28)', () => {
  const basis = (method: FiscalBasis['method'], extra: Partial<FiscalBasis> = {}): FiscalBasis => ({
    version: 1,
    method,
    value: bani('350000.00'),
    lifeMonths: 120,
    firstYearPercent: null,
    m1: false,
    newAsset: false,
    evidenceId: EVIDENCE,
    ...extra,
  });
  const rule = () =>
    rules().param<never>('ro.profit.depreciation', 'fiscal_year_start', '2026-01-01' as LocalDate);

  test('degressive, as norme pct. 25 work it: 20% of the value left, linear from the sixth year', () => {
    const years = [12, 24, 36, 48, 60, 72, 120].map((months) =>
      fiscalThrough(basis('degressive'), months, rule(), '50'),
    );
    expect(years.map(String)).toEqual([
      '7000000',
      '12600000',
      '17080000',
      '20664000',
      '23531200',
      '25824960',
      '35000000',
    ]);
  });

  test('accelerated: half in the first year, the rest linearly', () => {
    const accelerated = basis('accelerated', {
      firstYearPercent: '50',
      lifeMonths: 36,
      value: bani('12000.00'),
    });
    expect(
      [12, 24, 36].map((months) => fiscalThrough(accelerated, months, rule(), '50').toString()),
    ).toEqual(['600000', '900000', '1200000']);
  });

  test('an M1 car: 1,500 lei a month, and the value left capped the same at disposal', () => {
    const car = {
      id: 'car',
      number: 'MF-1',
      name: 'Autoturism',
      catalogCode: '2.3.2.1.1',
      account: '2133',
      depreciationAccount: '2813',
      expenseAccount: '6811',
      value: bani('180000.00'),
      lifeMonths: 60,
      commissionedOn: '2025-12-10' as LocalDate,
      disposedOn: null,
      depreciated: 0n,
      fiscal: null,
    } satisfies AssetState;
    const linear = basis('linear', { value: bani('180000.00'), lifeMonths: 60, m1: true });
    const year = assetDeduction(
      car,
      linear,
      { from: '2026-01-01' as LocalDate, to: '2026-12-31' as LocalDate },
      rule(),
      '50',
    );
    // 3,000 a month, 1,500 deductible: 18,000 of 36,000.
    expect([year.depreciation, year.capped]).toEqual([bani('18000.00'), bani('18000.00')]);
  });
});

describe('loss vintages (art. 31)', () => {
  test('in order of the losses, 70% cumulated over every vintage, within their years', () => {
    const recovery = recoverLosses(
      [
        { year: 2019, amount: 5000n, remaining: 5000n },
        { year: 2021, amount: 20000n, remaining: 20000n },
        { year: 2024, amount: 50000n, remaining: 50000n },
      ],
      2026,
      40000n,
      rules(),
    );
    // 2019's seven years ended in 2026? 2026 − 2019 = 7: still usable. 70% × 40,000 = 28,000.
    expect([recovery.available, recovery.recovered]).toEqual([75000n, 28000n]);
    expect(recovery.used).toEqual([
      { year: 2019, amount: 5000n },
      { year: 2021, amount: 20000n },
      { year: 2024, amount: 3000n },
    ]);
    const later = recoverLosses(
      [{ year: 2019, amount: 5000n, remaining: 5000n }],
      2027,
      1000n,
      rules(),
    );
    expect([later.recovered, later.expired.length]).toEqual([0n, 1]);
  });
});

describe('D101', () => {
  test('the due date, the payment number and the control sum, as the structure computes them', () => {
    expect(d101Due('2026-12-31')).toEqual({ code: '250627', date: '2027-06-25' });
    expect(d101PaymentNumber('2026-12-31', '250627')).toBe('11103011226250627000040');
    const rows = toRows({ P1: '200000', P2: '120000', P23: '8000', P411: '0' });
    expect(calculateD101({ ...model(), rows: deriveD101Rows(rows) }).controlSum).toBe(
      // P1 + P2 + P3 + P7 + P10 + P22 + P23 + P34 + P35 + P40 + P52 … the main rows only.
      200000n + 120000n + 80000n + 80000n + 80000n + 80000n + 8000n + 8000n + 88000n + 88000n,
    );
  });

  test('refuses a formula off by one leu, a sub-row above its total, and 20% exceeded', () => {
    const rows = deriveD101Rows(
      toRows({ P1: '200000', P2: '100000', P411: '16000', P43: '3201', P431: '3201' }),
    );
    const checks = checkD101({ ...model(), rows: { ...rows, P3: rows.P3 + 1n } }).map(
      (check) => check.code,
    );
    expect(checks).toEqual(expect.arrayContaining(['D101_FORMULA', 'D101_V5']));
  });
});

describe('prior-year correction (FP-03)', () => {
  test('on 1174, never through this year’s expenses, with the corrected year’s fiscal change', () => {
    const supplier = '00000000-0000-4000-8000-0000000000c2';
    const input = {
      date: '2026-07-15',
      year: 2025,
      reference: 'COR-1',
      description: 'Factura furnizorului din 2025 omisă',
      evidenceId: EVIDENCE,
      lines: [
        { account: '1174', side: 'D', amount: '5000.00' },
        {
          account: '401',
          side: 'C',
          amount: '5000.00',
          partyId: supplier,
          newItem: { kind: 'payable' },
        },
      ],
      fiscalChange: '-5000',
    };
    const loaded = {
      ...emptyLoaded([]),
      evidence: new Map([
        [EVIDENCE, { id: EVIDENCE, hash: 'h', filename: 'e.pdf', mediaType: 'application/pdf' }],
      ]),
    };
    const result = priorYearCorrection.evaluate(
      priorYearCorrection.input.parse(input),
      loaded,
      rules(),
    );
    expect(result.effect?.lines.map((line) => `${line.side} ${line.account}`)).toEqual([
      'D 1174',
      'C 401',
    ]);
    expect(result.issues.map((issue) => issue.code)).toEqual(['PRIOR_YEAR_D101']);
    const current = priorYearCorrection.evaluate(
      priorYearCorrection.input.parse({
        ...input,
        lines: [{ account: '628', side: 'D', amount: '5000.00' }, input.lines[1]],
      }),
      loaded,
      rules(),
    );
    expect(current.issues.map((issue) => issue.code)).toContain('CORRECTION_ACCOUNT');
  });

  test("the corrected year's rectification: 800 lei less, on 1174", () => {
    const year = run({
      period: '2026',
      answers: [noLosses()],
      result: [row('704', '0', '100000.00'), row('628', '40000.00')],
    });
    const correction: ProfitPosting = {
      entryId: 'c1',
      treatmentId: 'correction.priorYear',
      subject: 'correction:2026:COR-1',
      date: '2027-07-15' as LocalDate,
      seq: 3,
      position: {
        schema: 'profit-correction@1',
        year: 2026,
        change: '-5000',
        description: 'Factură omisă',
      },
    };
    const rectified = run({
      period: '2026',
      date: '2027-07-15',
      postings: [posting(year.position!), correction],
      result: [],
      input: { rectification: true, round: 2 },
    });
    // 60,000 − 5,000 = 55,000; 16% = 8,800, 800 less than 9,600.
    expect([
      rectified.position!.rows.P9,
      rectified.position!.rows.P40,
      rectified.position!.rows.P48,
    ]).toEqual(['5000', '55000', '8800']);
    expect(lines(rectified)).toEqual(['D 4411 80000', 'C 1174 80000']);
  });
});

describe('the agent contract and the register', () => {
  test('every classification the question offers, the bridge knows; the register explains each computation', () => {
    expect([...profitNatures]).toEqual([...accountClassifications]);
    expect(profitAgent.questions.map((item) => item.kind)).toContain('profit.account');
    const q1 = run({
      period: '2026-Q1',
      date: '2026-03-31',
      result: [row('704', '0', '10000.00')],
    });
    const rows = fiscalRegister([
      {
        entryId: 'e1',
        date: '2026-03-31',
        period: '2026-Q1',
        kind: 'quarter',
        rows: q1.position!.rows,
        lines: [],
      },
    ]);
    expect(rows.map((item) => [item.number, item.row, item.value])).toEqual([
      [1, 'P1', '10000'],
      [2, 'P7', '10000'],
      [3, 'P35', '10000'],
      [4, 'P40', '10000'],
      [5, 'P41', '1600'],
      [6, 'P48', '1600'],
      [7, 'P52', '1600'],
    ]);
  });
});

function posting(position: ProfitPosition): ProfitPosting {
  return {
    entryId: `e-${position.period}`,
    treatmentId: 'tax.profit',
    subject: `profit:${position.period}:1`,
    date: position.end as LocalDate,
    seq: 1,
    position: position as unknown as JsonValue,
  };
}

function toRows(values: Record<string, string>): D101Rows {
  return deriveD101Rows(
    Object.fromEntries(d101Rows.map((item) => [item, BigInt(values[item] ?? '0')])) as D101Rows,
  );
}

function model() {
  return {
    period: { from: '2026-01-01', to: '2026-12-31' },
    microExitQuarter: null,
    rectifying: false,
    afterReserveCancellation: null,
    declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' },
    payer: {
      cui: '18547290',
      caen: '6201',
      name: 'Exemplu Servicii SRL',
      address: 'Str. Lungă 10, Galați',
    },
    rows: toRows({}),
  } as const;
}
