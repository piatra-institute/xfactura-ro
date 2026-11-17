/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  formatAmount,
  formatDate,
  formatDateTime,
  formatMinor,
  formatMoney,
  formatMoneyInput,
  formatMonth,
  formatMonths,
  formatMonthShort,
  formatQuantity,
  parseMoney,
} from '../../components/accounting/format';

describe('dates and months', () => {
  test('an ISO date reads day first with dots', () => {
    expect(formatDate('2026-11-17')).toBe('17.11.2026');
    expect(formatDate('2026-01-05')).toBe('05.01.2026');
    expect(formatDate('not a date')).toBe('not a date');
  });

  test('a month reads by its Romanian name', () => {
    expect(formatMonth('2026-01')).toBe('ianuarie 2026');
    expect(formatMonth('2026-11')).toBe('noiembrie 2026');
    expect(formatMonthShort('2026-01')).toBe('ian 2026');
    expect(formatMonthShort('2026-11')).toBe('nov 2026');
    expect(formatMonth('2026-13')).toBe('2026-13');
  });

  test('contiguous months collapse into runs and separate runs are joined', () => {
    const year = Array.from(
      { length: 12 },
      (_, index) => `2026-${String(index + 1).padStart(2, '0')}`,
    );
    expect(formatMonths(year)).toBe('ian–dec 2026');
    expect(formatMonths(['2026-03'])).toBe('mar 2026');
    expect(formatMonths(['2026-01', '2026-02', '2026-04'])).toBe('ian–feb 2026, apr 2026');
    expect(formatMonths(['2026-02', '2025-11', '2025-12', '2026-01'])).toBe('nov 2025–feb 2026');
    expect(formatMonths(['2026-05', '2026-05', '2026-06'])).toBe('mai–iun 2026');
    expect(formatMonths([])).toBe('');
  });

  test('an instant reads in Bucharest time', () => {
    expect(formatDateTime('2026-11-16T13:52:10.848Z')).toBe('16.11.2026, 15:52');
    // Summer time: UTC+3.
    expect(formatDateTime('2026-07-01T21:30:00Z')).toBe('02.07.2026, 00:30');
  });
});

describe('money', () => {
  test('minor units are always grouped and exact', () => {
    expect(formatMinor(123456n)).toBe('1.234,56 RON');
    expect(formatMinor('123456')).toBe('1.234,56 RON');
    expect(formatMinor(100000n)).toBe('1.000,00 RON');
    expect(formatMinor(5n)).toBe('0,05 RON');
    expect(formatMinor(0n)).toBe('0,00 RON');
    expect(formatMinor(-123456n, 'EUR')).toBe('−1.234,56 EUR');
    expect(formatMinor('-1')).toBe('−0,01 RON');
    // Beyond the exact range of a double.
    expect(formatMinor(9007199254740993n)).toBe('90.071.992.547.409,93 RON');
    expect(formatMinor(123456n, 'RON', { suffix: false })).toBe('1.234,56');
  });

  test("minor units follow core's currency exponent", () => {
    // JPY, ISK and KRW have no minor unit: 1234 minor units are 1.234 of the currency.
    expect(formatMinor('1234', 'JPY')).toBe('1.234 JPY');
    expect(formatMinor(-5n, 'ISK')).toBe('−5 ISK');
    expect(formatMinor(1000000n, 'KRW')).toBe('1.000.000 KRW');
    expect(formatMinor('1234', 'EUR')).toBe('12,34 EUR');
  });

  test('minor units that are not an integer, or a currency core does not know, are errors', () => {
    for (const text of ['', ' ', '12.5', '1,2', 'abc', ' 12', '--1', '+'])
      expect(() => formatMinor(text)).toThrow(RangeError);
    expect(() => formatMinor(1n, 'XYZ')).toThrow(RangeError);
  });

  test('engine decimals keep every digit and use the true minus sign', () => {
    expect(formatMoney('1234.56')).toBe('1.234,56 RON');
    expect(formatMoney('1000')).toBe('1.000,00 RON');
    expect(formatMoney('-100.00')).toBe('−100,00 RON');
    expect(formatMoney('0.5', 'EUR')).toBe('0,50 EUR');
    expect(formatMoney('12.3456', 'USD')).toBe('12,3456 USD');
    expect(formatMoney('-0.00')).toBe('0,00 RON');
    expect(formatMoney('1000000.01')).toBe('1.000.000,01 RON');
    expect(formatMoney('1234', 'JPY')).toBe('1.234 JPY');
    expect(formatMoney('-1234', 'KRW')).toBe('−1.234 KRW');
    expect(formatAmount('121.00')).toBe('121,00');
    expect(formatAmount('-1234.5')).toBe('−1.234,50');
  });

  test('quantities keep their decimals', () => {
    expect(formatQuantity('12.500')).toBe('12,500');
    expect(formatQuantity('-1234')).toBe('−1.234');
  });

  test('typed amounts become the decimal string the engine expects', () => {
    expect(parseMoney('1.234,56')).toBe('1234.56');
    expect(parseMoney('1234,56')).toBe('1234.56');
    expect(parseMoney('1234.56')).toBe('1234.56');
    expect(parseMoney('1.234')).toBe('1234.00');
    expect(parseMoney('1.234.567,8')).toBe('1234567.80');
    expect(parseMoney(' 12,5 ')).toBe('12.50');
    expect(parseMoney('-0,5')).toBe('-0.50');
    expect(parseMoney('−7')).toBe('-7.00');
    expect(parseMoney('0007')).toBe('7.00');
    expect(parseMoney(',5')).toBe('0.50');
    expect(parseMoney('1,234')).toBeNull();
    expect(parseMoney('1.23.4')).toBeNull();
    expect(parseMoney('12,34,5')).toBeNull();
    expect(parseMoney('abc')).toBeNull();
    expect(parseMoney('')).toBeNull();
    expect(formatMoneyInput('-1234.50')).toBe('-1.234,50');
  });

  test('typed amounts follow the currency exponent: no decimals for JPY, ISK, KRW', () => {
    expect(parseMoney('1.234', 'JPY')).toBe('1234');
    expect(parseMoney('1234', 'ISK')).toBe('1234');
    expect(parseMoney('-0', 'KRW')).toBe('0');
    expect(parseMoney('12,5', 'JPY')).toBeNull();
    expect(parseMoney('12.50', 'JPY')).toBeNull();
    expect(parseMoney('12,50', 'EUR')).toBe('12.50');
    expect(formatMoneyInput('1234', 'JPY')).toBe('1.234');
    expect(() => parseMoney('1', 'XYZ')).toThrow(RangeError);
  });
});
