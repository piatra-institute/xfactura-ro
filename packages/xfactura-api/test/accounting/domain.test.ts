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
  allocationSchedule,
  actualDaySchedule,
} from '../../source/accounting/domain';

describe('the A1 books', () => {
  test('actual-day allocations retain inclusive days, exact totals and less than one ban of cumulative rounding', () => {
    expect(actualDaySchedule('100.00', '2026-01-16', '2026-03-15')).toEqual({
      serviceDays: 59,
      schedule: [
        {
          month: '2026-01-01',
          date: '2026-01-31',
          amount: '27.11',
          serviceFrom: '2026-01-16',
          serviceTo: '2026-01-31',
          days: 16,
        },
        {
          month: '2026-02-01',
          date: '2026-02-28',
          amount: '47.46',
          serviceFrom: '2026-02-01',
          serviceTo: '2026-02-28',
          days: 28,
        },
        {
          month: '2026-03-01',
          date: '2026-03-31',
          amount: '25.43',
          serviceFrom: '2026-03-01',
          serviceTo: '2026-03-15',
          days: 15,
        },
      ],
    });
    expect(
      actualDaySchedule('100.00', '2024-02-10', '2024-03-09').schedule.map((row) => row.amount),
    ).toEqual(['68.96', '31.04']);
    expect(actualDaySchedule('0.01', '2026-03-05', '2026-03-05')).toMatchObject({
      serviceDays: 1,
      schedule: [{ amount: '0.01', days: 1 }],
    });
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 999999999999999999n }),
        fc.integer({ min: 1996, max: 2101 }),
        fc.integer({ min: 0, max: 11 }),
        fc.integer({ min: 1, max: 28 }),
        fc.integer({ min: 1, max: 1400 }),
        (total, year, month, day, length) => {
          const first = new Date(Date.UTC(year, month, day)),
            last = new Date(first);
          last.setUTCDate(last.getUTCDate() + length - 1);
          const from = first.toISOString().slice(0, 10),
            to = last.toISOString().slice(0, 10),
            amount = `${total / 100n}.${String(total % 100n).padStart(2, '0')}`;
          const result = actualDaySchedule(amount, from, to),
            calendar = new Map<string, number>();
          for (let i = 0; i < length; i++) {
            const date = new Date(first);
            date.setUTCDate(date.getUTCDate() + i);
            const key = date.toISOString().slice(0, 7);
            calendar.set(key, (calendar.get(key) ?? 0) + 1);
          }
          expect(result.serviceDays).toBe(length);
          expect(result.schedule).toHaveLength(calendar.size);
          let cumulativeDays = 0,
            allocated = 0n;
          for (const row of result.schedule) {
            const value = BigInt(row.amount.replace('.', ''));
            expect(value >= 0n).toBe(true);
            expect(row.days).toBe(calendar.get(row.month.slice(0, 7))!);
            expect(row.serviceFrom >= from && row.serviceTo <= to).toBe(true);
            cumulativeDays += row.days;
            allocated += value;
            const shortfall = total * BigInt(cumulativeDays) - allocated * BigInt(length);
            expect(shortfall >= 0n && shortfall < BigInt(length)).toBe(true);
          }
          expect(allocated).toBe(total);
          expect(cumulativeDays).toBe(length);
        },
      ),
      { seed: 20261029, numRuns: 500 },
    );
    for (const [amount, from, to] of [
      ['0.00', '2026-01-01', '2026-01-31'],
      ['1.00', '2026-03-01', '2026-02-28'],
      ['1.00', '2026-02-30', '2026-03-01'],
      ['1.00', '2025-01-01', '2030-01-01'],
    ])
      expect(() => actualDaySchedule(amount, from, to)).toThrow();
  });
  test('uniform subscription schedules preserve exact bani over full months, including leap years', () => {
    const decimal = (value: bigint) => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
    expect(allocationSchedule('100.00', '2024-02-01', '2024-04-30')).toEqual([
      { month: '2024-02-01', date: '2024-02-29', amount: '33.33' },
      { month: '2024-03-01', date: '2024-03-31', amount: '33.33' },
      { month: '2024-04-01', date: '2024-04-30', amount: '33.34' },
    ]);
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 999999999999999999n }),
        fc.integer({ min: 1, max: 60 }),
        (total, count) => {
          const last = new Date(Date.UTC(2025, count, 0)).toISOString().slice(0, 10),
            rows = allocationSchedule(decimal(total), '2025-01-01', last),
            amounts = rows.map((row) => BigInt(row.amount.replace('.', '')));
          expect(rows).toHaveLength(count);
          expect(amounts.reduce((sum, value) => sum + value, 0n)).toBe(total);
          expect(amounts.every((amount) => amount >= 0n)).toBe(true);
          expect(new Set(rows.map((row) => row.month)).size).toBe(count);
          expect(amounts.slice(0, -1).every((amount) => amount === total / BigInt(count))).toBe(
            true,
          );
          expect(amounts[count - 1] - total / BigInt(count)).toBe(total % BigInt(count));
        },
      ),
      { seed: 20261028, numRuns: 500 },
    );
    for (const [amount, from, to] of [
      ['0.00', '2026-01-01', '2026-01-31'],
      ['1.00', '2026-01-02', '2026-01-31'],
      ['1.00', '2026-01-01', '2026-01-30'],
      ['1.00', '2026-03-01', '2026-02-28'],
      ['1.00', '2025-01-01', '2030-01-31'],
    ])
      expect(() => allocationSchedule(amount, from, to)).toThrow();
  });

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
