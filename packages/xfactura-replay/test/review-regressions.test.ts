import { describe, expect, test } from 'bun:test';
import { compareBalances, type EngineBalancePeriod } from '../src/compare/balances';
import {
  compareJournals,
  migrationSubject,
  type EngineJournalEntry,
} from '../src/compare/journals';
import { checkSourceChain } from '../src/compare/source-chain';
import { filed, mapping, sourceJournal } from './fixtures/books';

function taxPair() {
  const source = sourceJournal().find((entry) => entry.reference.endsWith('/tax'))!;
  const engine: EngineJournalEntry = {
    id: 'synthetic-entry',
    subject: migrationSubject(source.source, source.reference),
    date: source.transaction.date!,
    lines: source.transaction.lines.map((line) => ({
      account: mapping(line.account!)!,
      side: line.side === 'debit' ? 'D' : 'C',
      amount: line.amount!.amount!,
    })),
    taxEntries: source.taxEntries!,
  };
  return { source, engine };
}

describe('review regressions', () => {
  test.each([
    ['code', 'SYN-B'],
    ['base', '61'],
    ['amount', '13'],
  ] as const)('supplement cannot override a changed filed tax %s', (field, value) => {
    const { source, engine } = taxPair();
    source.transaction.lines[1]!.tax![0]![field] = value;
    const result = compareJournals([source], [engine], mapping);
    expect(result.map((item) => item.kind)).toContain('journal-tax');
    expect(result.map((item) => item.kind)).toContain('source-tax-supplement');
    const tax = result.find((item) => item.kind === 'journal-tax')!;
    expect(tax.source).toEqual([
      expect.objectContaining({ [field === 'amount' ? 'tax' : field]: value }),
    ]);
  });

  test('empty supplements and engine taxes do not erase the filed tax', () => {
    const { source, engine } = taxPair();
    source.taxEntries = [];
    engine.taxEntries = [];
    const result = compareJournals([source], [engine], mapping);
    expect(result.map((item) => item.kind)).toEqual(['journal-tax-evidence', 'journal-tax']);
    expect(result[1]!.source).toEqual([
      expect.objectContaining({ code: 'SYN-A', base: '60', tax: '12' }),
    ]);
  });

  test('supplemental rows cannot add a filed tax, and empty evidence keeps every filed duplicate', () => {
    const { source, engine } = taxPair();
    source.transaction.lines[1]!.tax!.push({ code: 'SYN-A', base: '60', amount: '12' });
    source.taxEntries = [];
    engine.taxEntries = [];
    expect(
      compareJournals([source], [engine], mapping).find((item) => item.kind === 'journal-tax')!
        .source,
    ).toHaveLength(2);
    source.transaction.lines[1]!.tax = [];
    source.taxEntries = [
      { code: 'SYN-A', base: '60', tax: '12', deductible: '12', period: '2026-01' },
    ];
    const result = compareJournals([source], [engine], mapping);
    expect(result.map((item) => item.kind)).toEqual(['source-tax-supplement']);
  });

  test('sparse supplemental evidence uses explicit filed coordinates without changing tax identity', () => {
    const { source, engine } = taxPair();
    source.transaction.lines[0]!.tax = [{ code: 'SYN-B', base: '10', amount: '2' }];
    source.taxEntries = [
      { filed: { line: 1, tax: 0 }, deductible: '12', period: '2026-01' },
      { filed: { line: 0, tax: 0 }, deductible: '2', period: '2026-01' },
    ];
    engine.taxEntries = [
      ...engine.taxEntries,
      { code: 'SYN-B', base: '10', tax: '2', deductible: '2', period: '2026-01' },
    ];
    expect(compareJournals([source], [engine], mapping)).toEqual([]);
    source.taxEntries = [source.taxEntries[0]!, source.taxEntries[0]!];
    expect(compareJournals([source], [engine], mapping).map((item) => item.kind)).toEqual([
      'source-tax-supplement',
      'journal-tax-evidence',
    ]);
  });

  test('supplements add only deductible and period, and contradicting assertions stay visible', () => {
    const { source, engine } = taxPair();
    source.taxEntries = [{ deductible: '12.00', period: '2026-01' }];
    expect(compareJournals([source], [engine], mapping)).toEqual([]);
    source.taxEntries = [
      { code: 'SYN-A', base: '60.000', tax: '12.00', deductible: '12', period: '2026-01' },
    ];
    expect(compareJournals([source], [engine], mapping)).toEqual([]);
    source.taxEntries = [
      { code: 'SYN-B', base: '60', tax: '12', deductible: '12', period: '2026-01' },
    ];
    const result = compareJournals([source], [engine], mapping);
    expect(result.map((item) => item.kind)).toContain('source-tax-supplement');
    const id = result.find((item) => item.kind === 'source-tax-supplement')!.id;
    source.taxEntries[0]!.base = '61';
    expect(
      compareJournals([source], [engine], mapping).find(
        (item) => item.kind === 'source-tax-supplement',
      )!.id,
    ).toBe(id);
    expect(compareJournals([source], [], mapping).map((item) => item.kind)).toEqual([
      'source-tax-supplement',
      'journal-only-source',
    ]);
    expect(result.find((item) => item.kind === 'journal-tax')).toBeUndefined();
  });

  test('a filed balance with both sides cannot disappear when its net matches the engine', () => {
    const source = filed('2026-01', [
      {
        id: 'source-628',
        standard: '628',
        openingDebit: '15',
        openingCredit: '10',
        closingDebit: '20',
        closingCredit: '15',
      },
    ]);
    const engine: EngineBalancePeriod = {
      period: '2026-01',
      from: '2026-01-01',
      to: '2026-01-31',
      rows: [
        {
          account: '628',
          values: {
            opening: { debit: '5', credit: '0' },
            closing: { debit: '5', credit: '0' },
            debitTurnover: '0',
            creditTurnover: '0',
          },
        },
      ],
    };
    const result = compareBalances([source], [engine], mapping);
    expect(
      result.differences.map((item) => [item.kind, item.locator.sourceAccount, item.locator.field]),
    ).toEqual([
      ['source-balance-both-sides', 'source-628', 'opening'],
      ['source-balance-both-sides', 'source-628', 'closing'],
    ]);
    expect(checkSourceChain([source]).findings.map((item) => item.id)).toEqual(
      result.differences.map((item) => item.id),
    );
    source.masterFiles.accounts[0]!.openingDebit = '25';
    expect(checkSourceChain([source]).findings[0]!.id).toBe(result.differences[0]!.id);
    source.masterFiles.accounts[0]!.openingDebit = '0';
    source.masterFiles.accounts[0]!.openingCredit = '0';
    expect(checkSourceChain([source]).findings[0]!.kind).toBe('source-balance-both-sides');
  });

  test('an unmapped line retains differences on mapped lines and taxes in the same transaction', () => {
    const { source, engine } = taxPair();
    source.transaction.lines.push({ account: 'unmapped', side: 'debit', amount: { amount: '5' } });
    engine.lines = engine.lines.map((line) =>
      line.account === '628' ? { ...line, amount: '61' } : line,
    );
    engine.taxEntries = engine.taxEntries.map((tax) => ({ ...tax, code: 'SYN-B' }));
    const result = compareJournals([source], [engine], mapping);
    expect(result.map((item) => item.kind)).toEqual([
      'mapping-account',
      'journal-lines',
      'journal-tax',
    ]);
    expect(result.find((item) => item.kind === 'journal-lines')!.accounts).toEqual(['628']);
  });
});
