export type Rounding =
  'halfAwayFromZero' | 'halfEven' | 'towardZero' | 'awayFromZero' | 'floor' | 'ceiling';

export const INT64_MAX = 9223372036854775807n;

/** Exact integer division with an explicit rounding mode. */
export function divRound(numerator: bigint, denominator: bigint, mode: Rounding): bigint {
  if (denominator === 0n) throw new RangeError('Division by zero.');
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  const quotient = numerator / denominator;
  const remainder = numerator - quotient * denominator;
  if (remainder === 0n) return quotient;
  const sign = numerator < 0n ? -1n : 1n;
  const twice = 2n * (remainder < 0n ? -remainder : remainder);
  switch (mode) {
    case 'towardZero':
      return quotient;
    case 'awayFromZero':
      return quotient + sign;
    case 'floor':
      return sign < 0n ? quotient - 1n : quotient;
    case 'ceiling':
      return sign > 0n ? quotient + 1n : quotient;
    case 'halfAwayFromZero':
      return twice >= denominator ? quotient + sign : quotient;
    case 'halfEven':
      return twice > denominator || (twice === denominator && quotient % 2n !== 0n)
        ? quotient + sign
        : quotient;
  }
}

const decimalPattern = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/;

/** A finite decimal as an exact fraction; the denominator is a power of ten. */
export type Ratio = { numerator: bigint; denominator: bigint };

export function parseDecimal(text: string): Ratio {
  const match = decimalPattern.exec(text);
  if (!match) throw new RangeError(`Invalid decimal: ${text}`);
  const [, sign = '', whole = '0', fraction = ''] = match;
  const numerator = BigInt(whole + fraction) * (sign ? -1n : 1n);
  return { numerator, denominator: 10n ** BigInt(fraction.length) };
}

/** Parses a decimal into integer units of 10^-scale. More fraction digits than `scale` is an
 * error, never an implicit rounding. */
export function parseScaled(text: string, scale: number): bigint {
  const match = decimalPattern.exec(text);
  if (!match) throw new RangeError(`Invalid decimal: ${text}`);
  const [, sign = '', whole = '0', fraction = ''] = match;
  if (fraction.length > scale) throw new RangeError(`More than ${scale} decimals: ${text}`);
  const units = BigInt(whole + fraction.padEnd(scale, '0'));
  return sign ? -units : units;
}

export function formatScaled(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return `${negative ? '-' : ''}${whole}${scale > 0 ? `.${fraction}` : ''}`;
}

/** Rescales an exact ratio to integer units of 10^-scale. */
export function roundRatio(value: Ratio, scale: number, mode: Rounding): bigint {
  return divRound(value.numerator * 10n ** BigInt(scale), value.denominator, mode);
}
