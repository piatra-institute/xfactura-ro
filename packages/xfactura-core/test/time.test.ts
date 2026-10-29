import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  addDays,
  addMonths,
  addMonthsToDate,
  bucharestDate,
  daysBetween,
  fromEpochDay,
  isLocalDate,
  isoWeekday,
  monthEnd,
  parseLocalDate,
  toEpochDay,
  utcDate,
  type LocalDate,
  type Month,
} from '../src/time';

const DAY = 86_400_000;
const date = (text: string) => parseLocalDate(text);
const bucharest = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Bucharest',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

describe('calendar arithmetic', () => {
  test('validates dates', () => {
    expect(isLocalDate('2024-02-29')).toBe(true);
    for (const text of [
      '2025-02-29',
      '2024-13-01',
      '2024-00-10',
      '2024-04-31',
      '24-01-01',
      '2024-1-01',
    ])
      expect(isLocalDate(text)).toBe(false);
  });

  test('epoch days agree with the platform for years 1 to 9999', () => {
    fc.assert(
      fc.property(fc.integer({ min: -719162, max: 2932896 }), (days) => {
        const expected = new Date(days * DAY).toISOString().slice(0, 10);
        expect(fromEpochDay(days)).toBe(expected as LocalDate);
        expect(toEpochDay(fromEpochDay(days))).toBe(days);
        expect(isoWeekday(fromEpochDay(days))).toBe(
          ((new Date(days * DAY).getUTCDay() + 6) % 7) + 1,
        );
      }),
    );
  });

  test('months', () => {
    expect(addDays(date('2024-02-28'), 1)).toBe(date('2024-02-29'));
    expect(daysBetween(date('2025-12-31'), date('2026-01-01'))).toBe(1);
    expect(monthEnd('2024-02' as Month)).toBe(date('2024-02-29'));
    expect(addMonths('2025-11' as Month, 3)).toBe('2026-02' as Month);
    expect(addMonths('2026-01' as Month, -1)).toBe('2025-12' as Month);
    expect(addMonthsToDate(date('2024-01-31'), 1)).toBe(date('2024-02-29'));
  });
});

describe('Europe/Bucharest', () => {
  test('matches the platform time-zone database from 1997 to 2099', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(1997, 0, 1), max: Date.UTC(2099, 11, 31) }),
        (instant) => {
          expect(bucharestDate(instant)).toBe(bucharest.format(instant) as LocalDate);
        },
      ),
      { numRuns: 5000 },
    );
  });

  test('transitions at 01:00 UTC on the last Sundays of March and October', () => {
    // Winter: local midnight is 22:00 UTC; summer: 21:00 UTC.
    expect(bucharestDate(Date.UTC(2025, 2, 29, 21))).toBe(date('2025-03-29'));
    expect(bucharestDate(Date.UTC(2025, 2, 29, 22))).toBe(date('2025-03-30'));
    expect(bucharestDate(Date.UTC(2025, 2, 30, 20, 59, 59))).toBe(date('2025-03-30'));
    expect(bucharestDate(Date.UTC(2025, 2, 30, 21))).toBe(date('2025-03-31'));
    expect(bucharestDate(Date.UTC(2025, 9, 25, 20, 59, 59))).toBe(date('2025-10-25'));
    expect(bucharestDate(Date.UTC(2025, 9, 25, 21))).toBe(date('2025-10-26'));
    expect(bucharestDate(Date.UTC(2025, 9, 26, 21, 59, 59))).toBe(date('2025-10-26'));
    expect(bucharestDate(Date.UTC(2025, 9, 26, 22))).toBe(date('2025-10-27'));
  });

  test('local midnight is the previous UTC day, the invoicer date defect', () => {
    const midnight = Date.UTC(2024, 5, 14, 21);
    expect(bucharestDate(midnight)).toBe(date('2024-06-15'));
    expect(utcDate(midnight)).toBe(date('2024-06-14'));
    expect(new Date(midnight).toISOString().slice(0, 10)).toBe('2024-06-14');
  });

  test('rejects instants it does not model', () => {
    expect(() => bucharestDate(Date.UTC(1990, 0, 1))).toThrow();
    expect(() => bucharestDate(Number.NaN)).toThrow();
  });
});
