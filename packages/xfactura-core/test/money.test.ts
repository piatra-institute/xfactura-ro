import { describe, expect, test } from 'bun:test';
import Decimal from 'decimal.js';
import fc from 'fast-check';
import {
  allocate,
  allocateCumulative,
  convertMinor,
  divRound,
  formatMoney,
  formatScaled,
  parseMoney,
  parseScaled,
  type Rounding,
} from '../src/money';

const Oracle = Decimal.clone({ precision: 200 });
const modes: [Rounding, Decimal.Rounding][] = [
  ['halfAwayFromZero', Decimal.ROUND_HALF_UP],
  ['halfEven', Decimal.ROUND_HALF_EVEN],
  ['towardZero', Decimal.ROUND_DOWN],
  ['awayFromZero', Decimal.ROUND_UP],
  ['floor', Decimal.ROUND_FLOOR],
  ['ceiling', Decimal.ROUND_CEIL],
];
const big = fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n });
const positive = fc.bigInt({ min: 1n, max: 10n ** 20n });

describe('divRound', () => {
  test('matches an arbitrary-precision oracle in every mode', () => {
    fc.assert(
      fc.property(big, positive, fc.boolean(), (numerator, magnitude, negate) => {
        const denominator = negate ? -magnitude : magnitude;
        for (const [mode, oracle] of modes) {
          const expected = new Oracle(numerator.toString())
            .div(denominator.toString())
            .toDecimalPlaces(0, oracle)
            .toFixed(0);
          expect(divRound(numerator, denominator, mode).toString()).toBe(expected);
        }
      }),
    );
  });

  test('halves', () => {
    expect(divRound(5n, 2n, 'halfAwayFromZero')).toBe(3n);
    expect(divRound(-5n, 2n, 'halfAwayFromZero')).toBe(-3n);
    expect(divRound(5n, 2n, 'halfEven')).toBe(2n);
    expect(divRound(7n, 2n, 'halfEven')).toBe(4n);
    expect(() => divRound(1n, 0n, 'floor')).toThrow();
  });
});

describe('scaled decimals', () => {
  test('parse and format round-trip', () => {
    fc.assert(
      fc.property(big, fc.integer({ min: 0, max: 8 }), (units, scale) => {
        expect(parseScaled(formatScaled(units, scale), scale)).toBe(units);
      }),
    );
  });

  test('never rounds implicitly and rejects loose syntax', () => {
    expect(parseScaled('12.5', 2)).toBe(1250n);
    expect(parseScaled('-0.07', 2)).toBe(-7n);
    for (const text of ['1.234', '01', '1.', '.5', '+1', '1e3', ' 1', '1,5', ''])
      expect(() => parseScaled(text, 2)).toThrow();
  });

  test('currency exponents', () => {
    expect(parseMoney('1250', 'JPY')).toBe(1250n);
    expect(() => parseMoney('12.5', 'JPY')).toThrow();
    expect(formatMoney(-12345n, 'EUR')).toBe('-123.45');
    expect(() => parseMoney('1', 'XAU')).toThrow();
  });
});

describe('allocation', () => {
  const weights = fc.array(fc.bigInt({ min: 0n, max: 10n ** 12n }), {
    minLength: 1,
    maxLength: 40,
  });

  test('largest remainder sums exactly and stays within one unit of each share', () => {
    fc.assert(
      fc.property(big, weights, (total, values) => {
        fc.pre(values.some((value) => value > 0n));
        const sum = values.reduce((a, b) => a + b, 0n);
        const parts = allocate(total, values);
        expect(parts.reduce((a, b) => a + b, 0n)).toBe(total);
        parts.forEach((part, index) => {
          const error = part * sum - total * values[index]!;
          expect(error < 0n ? -error : error).toBeLessThan(sum);
        });
      }),
    );
  });

  test('ties go to the earlier index', () => {
    expect(allocate(1n, [1n, 1n, 1n])).toEqual([1n, 0n, 0n]);
    expect(allocate(-2n, [1n, 1n, 1n])).toEqual([-1n, -1n, 0n]);
  });

  test('cumulative rounding keeps every prefix at its rounded share', () => {
    fc.assert(
      fc.property(big, weights, (total, values) => {
        fc.pre(values.some((value) => value > 0n));
        const sum = values.reduce((a, b) => a + b, 0n);
        const parts = allocateCumulative(total, values);
        let running = 0n,
          released = 0n;
        parts.forEach((part, index) => {
          running += values[index]!;
          released += part;
          expect(released).toBe(divRound(total * running, sum, 'halfAwayFromZero'));
        });
        expect(released).toBe(total);
      }),
    );
  });

  test('rejects invalid weights', () => {
    expect(() => allocate(10n, [])).toThrow();
    expect(() => allocate(10n, [0n, 0n])).toThrow();
    expect(() => allocateCumulative(10n, [1n, -1n])).toThrow();
  });
});

describe('convertMinor', () => {
  test('matches the oracle for BNR-style quotes', () => {
    const rate = fc
      .tuple(fc.integer({ min: 1, max: 999 }), fc.integer({ min: 0, max: 9999 }))
      .map(([whole, fraction]) => `${whole}.${String(fraction).padStart(4, '0')}`);
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 14n), max: 10n ** 14n }),
        rate,
        fc.constantFrom(1, 100),
        fc.constantFrom('EUR', 'JPY', 'HUF'),
        (minor, quote, multiplier, currency) => {
          const exponent = currency === 'JPY' ? 0 : 2;
          const expected = new Oracle(minor.toString())
            .div(new Oracle(10).pow(exponent))
            .mul(quote)
            .div(multiplier)
            .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
            .mul(100)
            .toFixed(0);
          expect(convertMinor(minor, currency, { rate: quote, multiplier }).toString()).toBe(
            expected,
          );
        },
      ),
    );
  });

  test('worked examples', () => {
    expect(convertMinor(10000n, 'EUR', { rate: '4.9765', multiplier: 1 })).toBe(49765n);
    expect(convertMinor(123n, 'EUR', { rate: '4.9765', multiplier: 1 })).toBe(612n);
    expect(convertMinor(100000n, 'HUF', { rate: '1.2345', multiplier: 100 })).toBe(1235n);
    expect(() => convertMinor(1n, 'EUR', { rate: '0', multiplier: 1 })).toThrow();
    expect(() => convertMinor(1n, 'EUR', { rate: '4.97', multiplier: 0 })).toThrow();
  });
});
