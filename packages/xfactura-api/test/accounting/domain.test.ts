import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  assertBalanced,
  correctionLines,
  money,
  parseBankCsv,
  BANK_CSV_HEADER,
  trialBalance,
  type PostingLine,
} from '../../source/accounting/domain';

describe('the A1 books', () => {
  test('opening, purchase and payment produce the independently specified balances', () => {
    const entries: PostingLine[][] = [
      [
        { account: '5121', debit: '1000.00', credit: '0.00' },
        { account: '1012', debit: '0.00', credit: '1000.00' },
      ],
      [
        { account: '628', debit: '100.00', credit: '0.00' },
        { account: '401', debit: '0.00', credit: '100.00' },
      ],
      [
        { account: '401', debit: '100.00', credit: '0.00' },
        { account: '5121', debit: '0.00', credit: '100.00' },
      ],
    ];
    for (const lines of entries) assertBalanced(lines);
    expect(trialBalance(entries.flat())).toEqual([
      { account: '1012', debit: '0.00', credit: '1000.00', balance: '-1000.00' },
      { account: '401', debit: '100.00', credit: '100.00', balance: '0.00' },
      { account: '5121', debit: '1000.00', credit: '100.00', balance: '900.00' },
      { account: '628', debit: '100.00', credit: '0.00', balance: '100.00' },
    ]);
  });

  test('posting rejects imbalance, doublesided lines and implicit rounding', () => {
    expect(() => assertBalanced([{ account: '628', debit: '0.10', credit: '0.00' }])).toThrow();
    expect(() => assertBalanced([{ account: '628', debit: '1.00', credit: '1.00' }])).toThrow();
    for (const value of [
      1.1,
      '1.001',
      '1e2',
      '-1.00',
      'Infinity',
      '01.00',
      '10000000000000000.00',
    ]) {
      expect(() => money(value)).toThrow();
    }
    expect(money('0')).toBe('0.00');
    expect(money('0.1')).toBe('0.10');
  });

  test('generated balanced entries retain exact debit/credit equality', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000_000 }), (cents) => {
        const amount = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
        const lines: PostingLine[] = [
          { account: '628', debit: amount, credit: '0.00' },
          { account: '401', debit: '0.00', credit: amount },
        ];
        assertBalanced(lines);
        expect(trialBalance(lines).map((row) => row.balance)).toEqual([`-${amount}`, amount]);
      }),
      { seed: 20261026, numRuns: 1000 },
    );
  });

  test('bank CSV preserves quoted references and rejects malformed or ambiguous rows', () => {
    const row = 'PAY-1,2026-10-03,-100.01,RON,"Invoice, ""P-1"""';
    expect(parseBankCsv(`${BANK_CSV_HEADER}\n${row}`)).toEqual([
      { sourceId: 'PAY-1', date: '2026-10-03', amount: '-100.01', reference: 'Invoice, "P-1"' },
    ]);
    for (const invalid of [
      `${row}\n${row}`,
      'PAY-1,2026-02-30,-100.00,RON,Invoice',
      'PAY-1,2026-10-03,-100.001,RON,Invoice',
      'PAY-1,2026-10-03,0,RON,Invoice',
      'PAY-1,2026-10-03,-100.00,EUR,Invoice',
      'PAY-1,2026-10-03,-100.00,RON,"Invoice"oops',
      'PAY-1,2026-10-03,-100.00,RON,un"quoted',
      'PAY-1,2026-10-03,-100.00,RON,"unfinished',
    ])
      expect(() => parseBankCsv(`${BANK_CSV_HEADER}\n${invalid}`)).toThrow();
  });

  test('correction and reversal effects retain exact balances across large amounts', () => {
    const decimal = (value: bigint) => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 999999999999999999n }),
        fc.bigInt({ min: 0n, max: 999999999999999999n }),
        (previous, next) => {
          const lines = correctionLines(decimal(previous), decimal(next));
          assertBalanced(lines);
          const original: PostingLine[] = [
            { account: '628', debit: decimal(previous), credit: '0.00' },
            { account: '401', debit: '0.00', credit: decimal(previous) },
          ];
          const balances = trialBalance([...original, ...lines]);
          expect(balances.find((row) => row.account === '628')?.balance).toBe(decimal(next));
          expect(balances.find((row) => row.account === '401')?.balance).toBe(
            next === 0n ? '0.00' : `-${decimal(next)}`,
          );
        },
      ),
      { seed: 20261027, numRuns: 250 },
    );
  });
});
