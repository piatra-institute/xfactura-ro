import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  validateEffect,
  type AccountInfo,
  type ControlKind,
  type Effect,
  type ScheduleRow,
} from '../src/kernel';
import { controlKindOf } from '../src/ro/chart';
import {
  carryingRelease,
  currentPortion,
  instalmentsFrom,
  interestAccrued,
  interestKey,
  interestPeriod,
  loanSchedule,
  principalDue,
  principalKey,
  termMismatch,
  type Instalment,
} from '../src/ro/financing';
import { parseLocalDate as day, type LocalDate } from '../src/time';

// Every expected amount is computed by hand from the stated terms, independently of the code.

const sum = (
  rows: readonly { principal?: bigint; interest?: bigint; bani?: bigint }[],
  key: 'principal' | 'interest' | 'bani',
) => rows.reduce((total, row) => total + (row[key] ?? 0n), 0n);

describe('instalments from a loan’s terms', () => {
  test('an annuity of 12,000.00 at 6% over 12 months: 1,032.80 a month, the last closing it', () => {
    const rows = instalmentsFrom(1_200_000n, {
      method: 'annuity',
      rate: '6',
      months: 12,
      firstDue: day('2026-04-15'),
    });
    expect(rows).toHaveLength(12);
    // 12,000 × 0.5% = 60.00 interest, 1,032.80 − 60.00 = 972.80 principal.
    expect(rows[0]).toEqual({ due: day('2026-04-15'), principal: 97_280n, interest: 6000n });
    // 11,027.20 × 0.5% = 55.136 → 55.14; 1,032.80 − 55.14 = 977.66.
    expect(rows[1]).toEqual({ due: day('2026-05-15'), principal: 97_766n, interest: 5514n });
    expect(rows[11]!.due).toBe(day('2027-03-15'));
    expect(sum(rows, 'principal')).toBe(1_200_000n);
    for (const row of rows.slice(0, 11)) expect(row.principal + row.interest).toBe(103_280n);
  });

  test('equal principal parts of 1,000.00 at 12% over 3 months, the remainder first', () => {
    expect(
      instalmentsFrom(100_000n, {
        method: 'linear',
        rate: '12',
        months: 3,
        firstDue: day('2026-01-31'),
      }),
    ).toEqual([
      // 1,000.00 × 1% = 10.00; 666.66 × 1% = 6.6666 → 6.67; 333.33 × 1% = 3.3333 → 3.33.
      { due: day('2026-01-31'), principal: 33_334n, interest: 1000n },
      { due: day('2026-02-28'), principal: 33_333n, interest: 667n },
      { due: day('2026-03-31'), principal: 33_333n, interest: 333n },
    ]);
  });

  test('repay exactly the principal, whatever the terms', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10_000_000_000n }),
        fc.integer({ min: 0, max: 2500 }),
        fc.integer({ min: 1, max: 120 }),
        fc.constantFrom('annuity' as const, 'linear' as const),
        (principal, basisPoints, months, method) => {
          const rate = (basisPoints / 100).toFixed(2);
          const rows = instalmentsFrom(principal, {
            method,
            rate,
            months,
            firstDue: day('2026-01-31'),
          });
          expect(rows).toHaveLength(months);
          expect(sum(rows, 'principal')).toBe(principal);
          for (const row of rows) {
            expect(row.principal).toBeGreaterThanOrEqual(0n);
            expect(row.interest).toBeGreaterThanOrEqual(0n);
          }
        },
      ),
    );
  });
});

describe('a loan’s schedule', () => {
  const instalments: Instalment[] = [
    { due: day('2026-04-15'), principal: 50_000n, interest: 3100n },
    { due: day('2026-05-15'), principal: 50_000n, interest: 1500n },
  ];

  test('puts principal on the loan account and each period’s interest on its interest account', () => {
    const { rows, issues } = loanSchedule(instalments, day('2026-03-15'), '1621', '1682');
    expect(issues).toEqual([]);
    expect(rows).toEqual([
      {
        key: 'interest:2026-03-15/2026-04-15',
        due: day('2026-04-15'),
        bani: 3100n,
        counterAccount: '1682',
      },
      {
        key: 'principal:2026-04-15',
        due: day('2026-04-15'),
        bani: 50_000n,
        counterAccount: '1621',
      },
      {
        key: 'interest:2026-04-15/2026-05-15',
        due: day('2026-05-15'),
        bani: 1500n,
        counterAccount: '1682',
      },
      {
        key: 'principal:2026-05-15',
        due: day('2026-05-15'),
        bani: 50_000n,
        counterAccount: '1621',
      },
    ]);
    expect(interestPeriod(rows[0]!)).toEqual({ from: day('2026-03-15'), to: day('2026-04-15') });
    expect(interestPeriod(rows[1]!)).toBeNull();
    expect(principalKey(day('2026-04-15'))).toBe('principal:2026-04-15');
    expect(interestKey(day('2026-03-15'), day('2026-04-15'))).toBe(
      'interest:2026-03-15/2026-04-15',
    );
  });

  test('refuses instalments out of order, before the loan or empty', () => {
    const codes = (rows: Instalment[]) =>
      loanSchedule(rows, day('2026-03-15'), '1621', '1682').issues.map((issue) => issue.path);
    expect(codes([instalments[1]!, instalments[0]!])).toEqual(['instalments.1', 'instalments.1']);
    expect(codes([{ due: day('2026-03-10'), principal: 1n, interest: 0n }])).toEqual([
      'instalments.0',
    ]);
    // Interest for a period that would start before the loan.
    expect(
      codes([{ due: day('2026-04-10'), principal: 1n, interest: 1n, from: day('2026-03-01') }]),
    ).toEqual(['instalments.0']);
    // An advance due on the day the loan starts carries no interest.
    expect(codes([{ due: day('2026-03-15'), principal: 1n, interest: 0n }])).toEqual([]);
    expect(codes([{ due: day('2026-04-15'), principal: 0n, interest: 0n }])).toEqual([
      'instalments.0',
    ]);
  });

  test('accrues interest by the days of each period, cumulatively', () => {
    const { rows } = loanSchedule(
      [
        // 15 March–15 April: 31 days, 31.00 lei; 15 April–15 May: 30 days, 30.00 lei.
        { due: day('2026-04-15'), principal: 0n, interest: 3100n },
        { due: day('2026-05-15'), principal: 100_000n, interest: 3000n },
      ],
      day('2026-03-15'),
      '1621',
      '1682',
    );
    // 16 of 31 days by 31 March: 16.00.
    expect(interestAccrued(rows, day('2026-03-31'))).toBe(1600n);
    // The first period in full, and 15 of 30 days of the second: 31.00 + 15.00.
    expect(interestAccrued(rows, day('2026-04-30'))).toBe(4600n);
    expect(interestAccrued(rows, day('2026-05-31'))).toBe(6100n);
    expect(interestAccrued(rows, day('2026-03-15'))).toBe(0n);
    expect(principalDue(rows, '1621', day('2026-04-30'))).toBe(0n);
    expect(principalDue(rows, '1621', day('2026-05-15'))).toBe(100_000n);
  });

  test('never accrues less at a later day, and exactly the interest at the end', () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 0n, max: 10_000_000n }), { minLength: 1, maxLength: 24 }),
        fc.array(fc.integer({ min: 0, max: 800 }), { minLength: 2, maxLength: 10 }),
        (interest, offsets) => {
          const { rows } = loanSchedule(
            interest.map((amount, index) => ({
              due: day(
                `${2027 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}-10`,
              ),
              principal: 1n,
              interest: amount,
            })),
            day('2026-12-20'),
            '1621',
            '1682',
          );
          const dates = offsets
            .map((offset) => new Date(Date.UTC(2026, 11, 20 + offset)).toISOString().slice(0, 10))
            .sort() as LocalDate[];
          let previous = 0n;
          for (const date of dates) {
            const accrued = interestAccrued(rows, date);
            expect(accrued).toBeGreaterThanOrEqual(previous);
            previous = accrued;
          }
          expect(interestAccrued(rows, day('2030-01-01'))).toBe(
            interest.reduce((total, amount) => total + amount, 0n),
          );
        },
      ),
    );
  });
});

describe('what a loan owes within a year', () => {
  // 12,000.00 in 24 monthly instalments of 500.00 from 15 April 2026 to 15 March 2028.
  const { rows } = loanSchedule(
    Array.from({ length: 24 }, (_, index) => ({
      due: day(new Date(Date.UTC(2026, 3 + index, 15)).toISOString().slice(0, 10)),
      principal: 50_000n,
      interest: 0n,
    })),
    day('2026-03-15'),
    '1621',
    '1682',
  );

  test('is the principal due in the twelve months after the day, less what is repaid', () => {
    // Nine instalments repaid by the end of 2026 (7,500.00 owed): 2027's twelve are current, and
    // the three of 2028 long-term.
    expect(currentPortion(rows, '1621', 750_000n, day('2026-12-31'))).toBe(600_000n);
    // An instalment unpaid at maturity is current too.
    expect(currentPortion(rows, '1621', 800_000n, day('2026-12-31'))).toBe(650_000n);
    // Paid ahead, repayments go to the earliest instalments: of 2,000.00 owed, the 500.00 left of
    // December 2027 is current and the 1,500.00 of 2028 long-term.
    expect(currentPortion(rows, '1621', 200_000n, day('2026-12-31'))).toBe(50_000n);
    expect(currentPortion(rows, '1621', 0n, day('2026-12-31'))).toBe(0n);
  });
});

describe('settling a loan held in a currency', () => {
  test('releases its carrying amount in proportion, all of it when paid off', () => {
    // 10,000.00 EUR carried at 50,000.00 lei, a credit balance.
    expect(carryingRelease(-5_000_000n, -1_000_000n, 1_000_000n)).toBe(5_000_000n);
    // 300.00 EUR of it: 1,500.00 lei.
    expect(carryingRelease(-5_000_000n, -1_000_000n, 30_000n)).toBe(150_000n);
    // 333.33 of 10,000.00 EUR carried at 49,765.00 lei: 165,881.6745 bani, half up.
    expect(carryingRelease(-4_976_500n, -1_000_000n, 33_333n)).toBe(165_882n);
  });

  test('fits the account to the loan’s term: 162 beyond a year, 519 within it', () => {
    expect(termMismatch('1621', day('2026-03-15'), day('2027-03-15'))).toBe(true);
    expect(termMismatch('1621', day('2026-03-15'), day('2027-03-16'))).toBe(false);
    expect(termMismatch('5191', day('2026-03-15'), day('2027-03-15'))).toBe(false);
    expect(termMismatch('5191', day('2026-03-15'), day('2027-04-15'))).toBe(true);
    expect(termMismatch('4551', day('2026-03-15'), day('2036-03-15'))).toBe(false);
  });
});

describe('the kernel’s check of a loan’s schedule', () => {
  const accounts: Record<string, ControlKind | null> = {
    '5121': null,
    '5124': null,
    '1621': controlKindOf('1621'),
    '1682': controlKindOf('1682'),
  };
  const context = {
    account: (code: string) =>
      code in accounts
        ? ({
            code,
            postable: true,
            controlKind: accounts[code] ?? null,
            validFrom: day('2015-01-01'),
            validTo: null,
          } satisfies AccountInfo)
        : undefined,
    openItem: () => undefined,
  };
  const drawdown = (currency: string, rows: ScheduleRow[]): Effect => {
    const foreign = currency !== 'RON';
    const line = foreign
      ? { currency: { code: currency, minor: 1_000_000n, rateId: 'BNR/EUR', rate: '5.0000' } }
      : {};
    return {
      schema: 'effect@1',
      date: day('2026-03-15'),
      journalClass: 'general',
      journalCode: 'BANCA',
      description: 'Credit',
      lines: [
        {
          account: foreign ? '5124' : '5121',
          side: 'D',
          bani: foreign ? 5_000_000n : 1_000_000n,
          ...line,
        },
        {
          account: '1621',
          side: 'C',
          bani: foreign ? 5_000_000n : 1_000_000n,
          openItem: 'loan',
          partyId: 'bank',
          ...line,
        },
      ],
      openItems: [
        {
          ref: 'loan',
          kind: 'loan.payable',
          controlAccount: '1621',
          partyId: 'bank',
          currency,
          normalSide: 'C',
          mayReverse: false,
        },
      ],
      taxEntries: [],
      schedules: [
        { ref: 'plan', openItem: 'loan', version: 1, method: 'contract', rows, basis: {} },
      ],
      explanation: { summary: 'test' },
    };
  };
  const plan = (principal: bigint) =>
    loanSchedule(
      [
        { due: day('2026-09-15'), principal: principal / 2n, interest: 25_000n },
        { due: day('2027-03-15'), principal: principal - principal / 2n, interest: 12_500n },
      ],
      day('2026-03-15'),
      '1621',
      '1682',
    ).rows;
  const codes = (value: Effect) => validateEffect(value, context).map((issue) => issue.code);

  test('adds up its principal rows to the balance, beside the interest it books elsewhere', () => {
    expect(controlKindOf('1621')).toBe('loan.payable');
    expect(controlKindOf('1682')).toBe('loan.interest');
    expect(codes(drawdown('RON', plan(1_000_000n)))).toEqual([]);
    expect(codes(drawdown('RON', plan(999_999n)))).toEqual(['SCHEDULE_TOTAL']);
  });

  test('in the loan’s currency for a loan held in one', () => {
    expect(codes(drawdown('EUR', plan(1_000_000n)))).toEqual([]);
    expect(codes(drawdown('EUR', plan(5_000_000n)))).toEqual(['SCHEDULE_TOTAL']);
  });
});
