import { describe, expect, test } from 'bun:test';
import { clause } from '../src/ro/sources';
import { calculateD207, checkD207, writeD207, type D207 } from '../src/ro/declarations/d207';
import { evaluateClosure, type ClosureBooks } from '../src/ro/determinations/closure';
import { d406StartOf } from '../src/ro/saft/applicability';
import { roRegister } from '../src/ro/register';
import { certificateCovers } from '../src/ro/treatments/withholding';
import {
  agent,
  whtCode,
  whtTaxCodes,
  withheldOf,
  withholdingVersions,
} from '../src/ro/withholding';
import { RuleContext } from '../src/rules';
import type { LocalDate } from '../src/time';

const rules = () => new RuleContext(roRegister(), 'preview');

describe('WHT codes (RO_SAFT_SchemaDefCod_16.02.2026)', () => {
  test('the workbook of 16.02.2026 adds 604040, dividends to individuals at 16%', () => {
    expect(whtTaxCodes['604040']).toEqual({
      type: '604',
      percentage: '16',
      regime: 'domestic',
      description: 'Impozit pe veniturile din dividende distribuite persoanelor fizice',
    });
    expect(Object.keys(whtTaxCodes)).toHaveLength(124);
  });

  test("picks the code of the type, rate and regime, the individuals' where the sheet has one", () => {
    expect(whtCode('604', 'domestic', '16')).toBe('604040');
    expect(whtCode('150', 'domestic', '16')).toBe('150080');
    expect(whtCode('605', 'domestic', '10')).toBe('605010');
    expect(whtCode('628', 'domestic', '10')).toBe('628010');
    expect(whtCode('633', 'domestic', '16')).toBe('633010');
    expect(whtCode('633', 'domestic', '10', true)).toBe('633130');
    expect(whtCode('636', 'domestic', '10', true)).toBe('636040');
    expect(whtCode('633', 'treaty', '5')).toBe('633050');
    expect(whtCode('633', 'treaty', '0')).toBe('633120');
    // A treaty's dividend rate the sheet lists only as a domestic code: that code.
    expect(whtCode('631', 'treaty', '10')).toBe('631070');
    // Never a gross-up's or a directive's code; none for a rate the sheet does not list.
    expect(whtCode('633', 'treaty', '19.047619')).toBeNull();
    expect(whtCode('633', 'treaty', '7.5')).toBeNull();
  });

  test('reads what a posting withheld, the older dividend and interest postings included', () => {
    expect(
      withheldOf(
        'dividends.withhold',
        { beneficiary: 'individual', rate: '16' },
        1_000_000n,
        160_000n,
      ),
    ).toEqual({
      type: '604',
      taxCode: '604040',
      regime: 'domestic',
      rate: '16',
      base: '1000000',
      gross: '1000000',
      tax: '160000',
      annual: 'D205',
    });
    expect(withheldOf('loans.withhold', { rate: '10' }, 50_000n, 5000n)?.taxCode).toBe('605010');
    expect(withheldOf('ledger.general', {}, 0n, 0n)).toBeNull();
  });
});

describe('withholding parameters', () => {
  test('rent 10% of the gross less 20%, intellectual property less 40%, non-residents 16% or 10%', () => {
    const at = (key: string, scope?: Record<string, string>) =>
      rules().param<string>(key, 'payment_date', '2026-06-01' as LocalDate, scope);
    expect([at('ro.rent.tax_rate'), at('ro.rent.expense_rate')]).toEqual(['10', '20']);
    expect([at('ro.ip.tax_rate'), at('ro.ip.expense_rate')]).toEqual(['10', '40']);
    expect(at('ro.nonresident.tax_rate', { income: 'royalties', beneficiary: 'company' })).toBe(
      '16',
    );
    expect(
      at('ro.nonresident.tax_rate', { income: 'interest', beneficiary: 'individual_treaty' }),
    ).toBe('10');
    expect(
      at('ro.nonresident.tax_rate', { income: 'services', beneficiary: 'individual_other' }),
    ).toBe('16');
    expect(
      rules().param<string>(
        'ro.dividend.tax_rate',
        'distribution_decision_date',
        '2026-05-01' as LocalDate,
        {
          beneficiary: 'nonresident',
        },
      ),
    ).toBe('16');
    // Earlier payments are a gap: only the text in force in 2026 was read.
    expect(() =>
      rules().param('ro.rent.tax_rate', 'payment_date', '2025-12-20' as LocalDate),
    ).toThrow();
    for (const version of withholdingVersions)
      for (const id of version.clauses) expect(clause(id)).toBeDefined();
  });

  test("a certificate covers the year it is presented in and the next year's first 60 days", () => {
    const certificate = { presentedOn: '2026-03-01', year: 2026 };
    const covers = (date: string) => certificateCovers(certificate, date as LocalDate, 60);
    expect(covers('2026-02-28')).toBe(false);
    expect(covers('2026-03-01')).toBe(true);
    expect(covers('2026-12-31')).toBe(true);
    expect(covers('2027-03-01')).toBe(true);
    expect(covers('2027-03-02')).toBe(false);
    expect(
      certificateCovers({ presentedOn: '2026-03-01', year: 2025 }, '2026-04-01' as LocalDate, 60),
    ).toBe(false);
  });
});

describe('D207', () => {
  const model: D207 = {
    year: 2026,
    correction: false,
    declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' },
    payer: { cui: '18547290', name: 'Exemplu Servicii SRL', address: 'Str. Lungă 10, Galați' },
    beneficiaries: [
      {
        name: 'Software GmbH',
        state: 'DE',
        foreignId: 'DE123456789',
        incomeType: '03',
        act: 1,
        payments: [{ date: '2026-03-20', base: 4000, tax: 640 }],
      },
      {
        name: 'Lender BV',
        state: 'NL',
        incomeType: '19',
        act: 2,
        payments: [{ date: '2026-06-30', base: 1500, tax: 0 }],
      },
    ],
  };

  test('totals each type, the exempt gross apart, and the control sum', () => {
    const calculation = calculateD207(model);
    expect(calculation.summaries).toEqual([
      { incomeType: '03', beneficiaries: 1, exempt: 0n, base: 4000n, tax: 640n },
      { incomeType: '19', beneficiaries: 1, exempt: 1500n, base: 0n, tax: 0n },
    ]);
    expect(calculation.controlSum).toBe(1n + 4000n + 640n + 1n + 1500n);
    const xml = writeD207(model);
    expect(xml).toContain('xmlns="mfp:anaf:dgti:d207:declaratie:v2"');
    expect(xml).toContain(
      '<sect_II tip_venit="19" nrben="1" Tscutit="1500" Tbaza="0" Timp="0" Timps="0"/>',
    );
    expect(checkD207(model)).toEqual([]);
  });

  test('refuses a Romanian beneficiary, a taxed exemption and a treaty under a domestic type', () => {
    const wrong: D207 = {
      ...model,
      beneficiaries: [
        { ...model.beneficiaries[0]!, state: 'RO', act: 2 },
        { ...model.beneficiaries[1]!, payments: [{ date: '2026-06-30', base: 1500, tax: 10 }] },
      ],
    };
    expect(checkD207(wrong).map((check) => check.code)).toEqual([
      'D207_STATE',
      'D207_ACT',
      'D207_TAX',
    ]);
  });
});

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
const fact = (axis: string, value: string) => ({
  id: `${axis}-fact`,
  axis,
  value,
  effectiveFrom: '2020-01-01' as LocalDate,
  evidenceId: '00000000-0000-4000-8000-0000000000e1',
  supersedesId: null,
});

describe('the closure of withholding', () => {
  const closure = (withholdings: ClosureBooks['withholdings']) =>
    evaluateClosure({
      interval: { from: '2026-01', to: '2026-12' },
      facts: [
        fact('entity.form', 'srl'),
        fact('vat.status', 'non_vat'),
        fact('vat.eu', 'none'),
        fact('employer', 'no'),
        fact('activity.goods', 'no'),
        fact('regime.excluded', 'none'),
      ],
      determinations: [],
      confirmed: {},
      books: { ...noBooks, ...(withholdings ? { withholdings } : {}) },
      d406Start: d406StartOf(
        rules(),
        Array.from({ length: 12 }, (_, index) => `2026-${String(index + 1).padStart(2, '0')}`),
      ),
    });

  test('a D100 for each month withheld, D205 for residents, D207 for non-residents', () => {
    const result = closure([
      { month: '2026-04', annual: 'D205' },
      { month: '2026-06', annual: 'D207' },
    ]);
    const returns = result.obligations.map(
      (item) => `${item.kind} ${item.period} ${item.deadline}`,
    );
    expect(returns).toEqual(
      expect.arrayContaining([
        'D100 2026-04 D100.withholding',
        'D100 2026-06 D100.withholding',
        'D205 2026 D205',
        'D207 2026 D207',
      ]),
    );
    expect(result.unsupported.map((item) => item.trigger)).not.toContain(
      'D112_INTELLECTUAL_PROPERTY',
    );
    expect(closure(undefined).obligations.map((item) => item.kind)).not.toContain('D207');
  });

  test('intellectual property withheld is declared in D112, which is not written yet', () => {
    const result = closure([{ month: '2026-05', annual: 'D112' }]);
    expect(result.status).toBe('UNSUPPORTED');
    expect(result.unsupported).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          trigger: 'D112_INTELLECTUAL_PROPERTY',
          missingCapabilities: ['D112_INTELLECTUAL_PROPERTY'],
        }),
      ]),
    );
    expect(result.obligations.map((item) => `${item.kind} ${item.period}`)).not.toContain(
      'D100 2026-05',
    );
  });
});

describe('agent.ts', () => {
  test('names the documents, questions and detectors of withholding', () => {
    expect(agent.questions.map((item) => item.kind)).toEqual([
      'nonresident.payee',
      'nonresident.certificate',
    ]);
    expect(agent.detectors.map((item) => item.kind)).toEqual(['obligation.due', 'question.needed']);
    const keys = new Set(roRegister().keys());
    for (const detector of agent.detectors)
      for (const rule of detector.rules) expect(keys.has(rule)).toBe(true);
  });
});
