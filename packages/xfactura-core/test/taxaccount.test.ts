import { describe, expect, test } from 'bun:test';
import { checkDocument } from '../src/documents/checks';
import { extractedBody } from '../src/documents/schemas';
import { formatMoney, parseMoney } from '../src/money';
import { roRegister } from '../src/ro/register';
import {
  accessoryOf,
  decisionDueDate,
  distribute,
  distributeSeparate,
  reconcileStatement,
  type Obligation,
  type ObligationCatalogue,
  type TaxStatementDocument,
} from '../src/ro/taxaccount';
import { RuleContext } from '../src/rules';
import type { LocalDate } from '../src/time';

// Synthetic obligations; expected amounts by hand from CPF art. 163 alin. (3)–(5) and art. 165.
const bani = (text: string) => parseMoney(text, 'RON');
const lei = (value: bigint) => formatMoney(value, 'RON');
const rules = new RuleContext(roRegister(), 'preview');
const at = (date: string) => ({
  order: rules.param<never>('ro.taxaccount.distribution', 'payment_date', date as LocalDate),
  advance: rules.param<never>('ro.taxaccount.advance', 'payment_date', date as LocalDate),
});
let next = 0;
const owed = (
  type: Obligation['type'],
  amount: string,
  due: string,
  extra: Partial<Obligation> = {},
): Obligation => ({
  id: `o${++next}`,
  account: '444',
  type,
  period: due.slice(0, 7),
  budget: type === 'cas' ? 'social_insurance' : type === 'cass' ? 'health_insurance' : 'state',
  category: ['salary_tax', 'cas', 'cass', 'dividend_tax'].includes(type) ? 'withheld' : 'principal',
  due: due as LocalDate,
  age: due as LocalDate,
  owed: bani(amount),
  designatable: false,
  separate: false,
  source: 'test',
  ...extra,
});
const shares = (result: ReturnType<typeof distribute>) =>
  Object.fromEntries(
    result.allocations.map((allocation) => [
      `${allocation.obligation.type}:${allocation.obligation.period}:${allocation.stage}`,
      lei(allocation.bani),
    ]),
  );

describe('the distribution of a payment to the single account', () => {
  test('between budgets in proportion, then withheld taxes before the other principal ones', () => {
    const result = distribute(
      bani('2000.00'),
      '2026-11-25' as LocalDate,
      [
        owed('salary_tax', '600.00', '2026-11-25'),
        owed('cas', '1500.00', '2026-11-25'),
        owed('cass', '600.00', '2026-11-25'),
        owed('profit', '1300.00', '2026-10-26'),
      ],
      at('2026-11-25'),
    );
    // Owed 4,000: the state budget 1,900 (47.5%), BASS 1,500 (37.5%), FNUASS 600 (15%).
    // State 950: salary tax 600 (withheld) first, then profit tax 350.
    expect(shares(result)).toEqual({
      'salary_tax:2026-11:due': '600.00',
      'profit:2026-10:due': '350.00',
      'cas:2026-11:due': '750.00',
      'cass:2026-11:due': '300.00',
    });
    expect(result.undistributed).toBe(0n);
  });

  test('within a category in proportion between types, each type oldest first', () => {
    const result = distribute(
      bani('2000.00'),
      '2026-11-25' as LocalDate,
      [
        owed('salary_tax', '1000.00', '2026-10-26'),
        owed('salary_tax', '1000.00', '2026-11-25'),
        owed('dividend_tax', '2000.00', '2026-11-25'),
      ],
      at('2026-11-25'),
    );
    expect(shares(result)).toEqual({
      'salary_tax:2026-10:due': '1000.00',
      'dividend_tax:2026-11:due': '1000.00',
    });
  });

  test('before the due date it settles the obligations as they fall due; the rest stays undistributed', () => {
    const result = distribute(
      bani('6000.00'),
      '2026-11-20' as LocalDate,
      [owed('salary_tax', '2000.00', '2026-11-25'), owed('cas', '3000.00', '2026-11-25')],
      at('2026-11-20'),
    );
    expect(shares(result)).toEqual({
      'salary_tax:2026-11:later': '2000.00',
      'cas:2026-11:later': '3000.00',
    });
    expect(lei(result.undistributed)).toBe('1000.00');
    // Without any obligation, everything stays undistributed.
    expect(distribute(bani('500.00'), '2026-11-20' as LocalDate, [], at('2026-11-20'))).toEqual(
      expect.objectContaining({ allocations: [], undistributed: bani('500.00') }),
    );
  });

  test('designated obligations first; separate ones and those without a due date left out', () => {
    const fine = owed('micro', '300.00', '2026-11-05', { designatable: true });
    const vat = owed('vat', '5000.00', '2026-11-25', { separate: true });
    const result = distribute(
      bani('1000.00'),
      '2026-11-25' as LocalDate,
      [fine, vat, owed('salary_tax', '500.00', '2026-11-25')],
      at('2026-11-25'),
      new Map([[fine.id, bani('300.00')]]),
    );
    expect(
      result.allocations.map((item) => [item.obligation.type, item.stage, lei(item.bani)]),
    ).toEqual([
      ['micro', 'designated', '300.00'],
      ['salary_tax', 'due', '500.00'],
    ]);
    expect(lei(result.undistributed)).toBe('200.00');
  });

  test('into a tax own account: principal by age, then accessories, the excess paid in excess', () => {
    const result = distributeSeparate(
      bani('1500.00'),
      '2026-11-25' as LocalDate,
      [
        owed('vat', '200.00', '2026-11-05', { category: 'accessory', separate: true }),
        owed('vat', '1000.00', '2026-11-25', { separate: true }),
      ],
      { beyondDue: 'at_due_date' },
    );
    expect(result.allocations.map((item) => [item.obligation.category, lei(item.bani)])).toEqual([
      ['principal', '1000.00'],
      ['accessory', '200.00'],
    ]);
    expect(lei(result.undistributed)).toBe('300.00');
  });
});

describe('decisions', () => {
  test('due on the 5th or the 20th of the next month by the communication day (art. 156)', () => {
    const due = { split: 15, first: 5, second: 20 };
    expect(decisionDueDate('2026-11-15' as LocalDate, due)).toBe('2026-12-05' as LocalDate);
    expect(decisionDueDate('2026-11-16' as LocalDate, due)).toBe('2026-12-20' as LocalDate);
    expect(decisionDueDate('2026-12-20' as LocalDate, due)).toBe('2027-01-20' as LocalDate);
  });

  test('interest and penalties recomputed in whole lei', () => {
    // 10,000 lei × 0.02% × 31 days = 62 lei; × 0.01% = 31 lei.
    expect(accessoryOf('10000.00', 31, '0.02')).toBe(6200n);
    expect(accessoryOf('10000.00', 31, '0.01')).toBe(3100n);
    // 1,234.56 × 0.02% × 17 = 4.197… → 4 lei.
    expect(accessoryOf('1234.56', 17, '0.02')).toBe(400n);
  });

  test('a decision whose lines do not add up fails its arithmetic check', () => {
    const body = extractedBody('tax.decision', {
      decision: 'accessories',
      title: 'Decizie referitoare la obligațiile fiscale accesorii',
      issuer: { name: 'AJFP Galați' },
      taxpayer: { name: 'Exemplu SRL', taxId: '18547290' },
      number: '123',
      issueDate: '2026-11-02',
      communicatedOn: '2026-11-04',
      lines: [
        {
          kind: 'interest',
          obligation: 'profit',
          period: '2026-Q2',
          label: 'Impozit pe profit',
          amount: '62.00',
        },
        {
          kind: 'late_penalty',
          obligation: 'profit',
          period: '2026-Q2',
          label: 'Impozit pe profit',
          amount: '31.00',
        },
      ],
      totals: { amount: '100.00' },
    });
    const { checks } = checkDocument({
      kind: 'tax.decision',
      body,
      companyTaxId: '18547290',
      today: '2026-11-05' as LocalDate,
      rates: () => ({ standard: '21', reduced: [] }),
      pages: null,
      citations: {},
    });
    expect(checks.find((check) => check.code === 'TOTALS')?.status).toBe('failed');
    expect(checks.find((check) => check.code === 'COMPANY_PARTY')?.status).toBe('passed');
  });
});

describe("the statement of the taxpayer's account against the books", () => {
  const catalogue = rules.param<ObligationCatalogue>(
    'ro.taxaccount.obligations',
    'payment_date',
    '2026-11-30' as LocalDate,
  );
  const statement = (rows: Partial<TaxStatementDocument['rows'][number]>[]) =>
    ({
      parserVersion: 'extracted-tax-statement-1',
      source: 'situatie_sintetica',
      title: 'Situație sintetică',
      taxpayer: { name: 'Exemplu SRL', taxId: '18547290' },
      asOf: '2026-11-30',
      from: null,
      rows: rows.map((row) => ({
        label: 'x',
        code: null,
        kind: 'principal',
        budget: null,
        period: null,
        opening: null,
        debit: null,
        credit: null,
        ...row,
      })),
      totals: null,
    }) as TaxStatementDocument;

  test('matches within a leu, and explains what differs', () => {
    const rows = reconcileStatement(
      statement([
        { obligation: 'salary_tax', balance: '500.00' },
        { obligation: 'profit', kind: 'accessory', balance: '93.00' },
      ]),
      [
        {
          obligation: 'salary_tax',
          kind: 'principal',
          period: '2026-10',
          items: [{ openItem: 'a', account: '444', period: '2026-10', balance: bani('500.40') }],
        },
        {
          obligation: 'cam',
          kind: 'principal',
          period: '2026-10',
          items: [{ openItem: 'b', account: '436', period: '2026-10', balance: bani('120.00') }],
        },
      ],
      catalogue,
    );
    const by = Object.fromEntries(rows.map((row) => [`${row.obligation}:${row.kind}`, row]));
    expect(by['salary_tax:principal']).toEqual(
      expect.objectContaining({ matched: true, difference: '-0.40' }),
    );
    expect(by['profit:accessory']!.explanations[0]!.code).toBe('ACCESSORIES_UNBOOKED');
    expect(by['cam:principal']!.explanations[0]!.code).toBe('NOT_ON_STATEMENT');
  });

  test('differences of the single account that cancel out are a distribution ANAF made otherwise', () => {
    const rows = reconcileStatement(
      statement([
        { obligation: 'salary_tax', balance: '300.00' },
        { obligation: 'cas', balance: '0.00' },
      ]),
      [
        {
          obligation: 'salary_tax',
          kind: 'principal',
          period: null,
          items: [{ openItem: 'a', account: '444', period: '2026-10', balance: 0n }],
        },
        {
          obligation: 'cas',
          kind: 'principal',
          period: null,
          items: [{ openItem: 'b', account: '4315', period: '2026-10', balance: bani('300.00') }],
        },
      ],
      catalogue,
    );
    expect(rows.every((row) => row.explanations.some((item) => item.code === 'DISTRIBUTION'))).toBe(
      true,
    );
  });
});
