/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { matchesOption } from '../../components/accounting/ui/fields';
import {
  dateComplete,
  dateProblem,
  dateRangeProblem,
  moneyProblem,
  monthProblem,
} from '../../components/accounting/ui/validation';

const segment = (type: string, value: number | null) => ({
  type,
  value,
  isEditable: true,
  isPlaceholder: value === null,
});
const literal = { type: 'literal', isEditable: false, isPlaceholder: false };
const date = (day: number | null, month: number | null, year: number | null) => [
  segment('day', day),
  literal,
  segment('month', month),
  literal,
  segment('year', year),
];

describe('a date field', () => {
  test('a complete date that is the value can be submitted', () => {
    expect(dateProblem(date(17, 11, 2026), true, '2026-11-17')).toBe('');
    expect(dateProblem(date(5, 1, 2026), false, '2026-01-05')).toBe('');
  });

  test('part of a date refuses the form, whatever value it had before', () => {
    const problem = 'Data este incompletă: completează ziua, luna și anul sau golește câmpul.';
    expect(dateProblem(date(17, null, 2026), false, '2026-11-17')).toBe(problem);
    expect(dateProblem(date(null, null, 2026), true)).toBe(problem);
  });

  test('a fully cleared date is empty: refused only when required', () => {
    expect(dateProblem(date(null, null, null), false, null)).toBe('');
    expect(dateProblem(date(null, null, null), true, null)).toBe('Completează data.');
  });

  test('a day that does not exist is not the value the field holds', () => {
    expect(dateProblem(date(31, 2, 2026), false, '2026-01-31')).toBe(
      'Ziua scrisă nu există în calendar; verifică data.',
    );
    expect(dateProblem(date(31, 2, 2026), false, null)).not.toBe('');
  });
});

describe('a date against its bounds', () => {
  test('a day within the bounds, or no day, can be submitted', () => {
    expect(dateRangeProblem('2027-03-01', { minValue: '2027-01-01' })).toBe('');
    expect(dateRangeProblem(null, { minValue: '2027-01-01' })).toBe('');
  });

  test('a day outside the bounds is refused in Romanian, with the bounds as people read them', () => {
    expect(dateRangeProblem('2026-11-17', { minValue: '2027-01-01' })).toBe(
      'Alege o dată începând cu 01.01.2027.',
    );
    expect(dateRangeProblem('2028-01-01', { maxValue: '2027-12-31' })).toBe(
      'Alege o dată până la 31.12.2027.',
    );
    expect(dateRangeProblem('2026-11-17', { minValue: '2027-01-01', maxValue: '2027-12-31' })).toBe(
      'Alege o dată între 01.01.2027 și 31.12.2027.',
    );
  });

  test('a date is complete when every part is filled', () => {
    expect(dateComplete(date(17, 11, 2026))).toBe(true);
    expect(dateComplete(date(17, null, 2026))).toBe(false);
  });
});

describe('a month field', () => {
  test('a month within its bounds can be submitted', () => {
    expect(monthProblem('2026-11', { minValue: '2026-01', maxValue: '2026-12' })).toBe('');
    expect(monthProblem(null)).toBe('');
  });

  test('a value outside its bounds, however it was set, is refused', () => {
    expect(monthProblem('2026-11', { minValue: '2027-01' })).toBe(
      'Alege o lună începând cu ianuarie 2027.',
    );
    expect(monthProblem('2028-01', { maxValue: '2027-12' })).toBe(
      'Alege o lună până la decembrie 2027.',
    );
    expect(monthProblem('2026-11', { minValue: '2027-01', maxValue: '2027-12' })).toBe(
      'Alege o lună între ianuarie 2027 și decembrie 2027.',
    );
  });

  test('a value that is not a month, or a missing required month, is refused', () => {
    expect(monthProblem('2026-13')).toBe('Luna aleasă nu este o lună validă.');
    expect(monthProblem('not-a-month')).toBe('Luna aleasă nu este o lună validă.');
    expect(monthProblem('', { isRequired: true })).toBe('Alege luna.');
  });
});

describe('a money field', () => {
  test('an amount, or an optional empty field, can be submitted', () => {
    expect(moneyProblem('1.234,56')).toBe('');
    expect(moneyProblem('')).toBe('');
    expect(moneyProblem('1.234', 'JPY')).toBe('');
  });

  test('a required empty field and text that is not an amount are refused', () => {
    expect(moneyProblem('  ', 'RON', true)).toBe('Completează suma.');
    expect(moneyProblem('1.2.3')).toBe('Scrie suma ca 1.234,56, cu cel mult două zecimale.');
    expect(moneyProblem('12,5', 'JPY')).toBe('Scrie suma ca 1.234, fără zecimale.');
  });
});

describe('a combobox option', () => {
  test('matches what is typed by code and by name, ignoring case and diacritics', () => {
    expect(matchesOption('5121 Conturi la bănci în lei', '512')).toBe(true);
    expect(matchesOption('5121 Conturi la bănci în lei', 'banci')).toBe(true);
    expect(matchesOption('5121 Conturi la bănci în lei', 'CONTURI lei')).toBe(true);
    expect(matchesOption('4111 Clienți', 'furn')).toBe(false);
  });
});
