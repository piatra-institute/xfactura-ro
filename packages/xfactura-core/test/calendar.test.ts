import { describe, expect, test } from 'bun:test';
import { legalHolidays, orthodoxEaster, workingDays } from '../src/ro/calendar';
import type { Month } from '../src/time';

describe('Romanian calendar', () => {
  test('Orthodox Easter', () => {
    expect([2024, 2025, 2026, 2027].map((year) => String(orthodoxEaster(year)))).toEqual([
      '2024-05-05',
      '2025-04-20',
      '2026-04-12',
      '2027-05-02',
    ]);
  });

  test('the public holidays of 2026', () => {
    expect(legalHolidays(2026).map(String)).toEqual([
      '2026-01-01',
      '2026-01-02',
      '2026-01-06',
      '2026-01-07',
      '2026-01-24',
      '2026-04-10',
      '2026-04-12',
      '2026-04-13',
      '2026-05-01',
      '2026-05-31',
      // Whit Monday and Children's Day.
      '2026-06-01',
      '2026-08-15',
      '2026-11-30',
      '2026-12-01',
      '2026-12-25',
      '2026-12-26',
    ]);
  });

  test("2026's working days by month", () => {
    const months = Array.from(
      { length: 12 },
      (_, index) => `2026-${String(index + 1).padStart(2, '0')}` as Month,
    );
    expect(months.map(workingDays)).toEqual([18, 20, 22, 20, 20, 21, 23, 21, 22, 22, 20, 21]);
  });
});
