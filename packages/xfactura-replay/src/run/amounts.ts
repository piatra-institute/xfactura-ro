import { decimal } from '../compare/decimal';

/**
 * A filed amount as `migration.journal` takes it: lei with at most two decimals, written with
 * exactly two. A value that needs more decimals, or is not a decimal, gives null; nothing is
 * rounded.
 */
export function money(value: string | undefined): string | null {
  if (value === undefined) return null;
  const parsed = decimal(value);
  if (!parsed) return null;
  let { units, scale } = parsed;
  while (scale > 2 && units % 10n === 0n) {
    units /= 10n;
    scale--;
  }
  if (scale > 2) return null;
  units *= 10n ** BigInt(2 - scale);
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(3, '0');
  const text = `${digits.slice(0, -2)}.${digits.slice(-2)}`;
  if (!/^(0|[1-9]\d{0,15})\.\d{2}$/.test(text)) return null;
  return negative ? `-${text}` : text;
}

/** The same amount with the opposite sign; zero stays unsigned. */
export function negate(value: string): string {
  if (/^-?0+(\.0+)?$/.test(value)) return value.replace(/^-/, '');
  return value.startsWith('-') ? value.slice(1) : `-${value}`;
}

export function isZero(value: string | undefined): boolean {
  const parsed = value === undefined ? null : decimal(value);
  return parsed !== null && parsed.units === 0n;
}

/** Exact decimal equality of two filed amounts, whatever their spelling. */
export function sameAmount(a: string | undefined, b: string | undefined): boolean {
  const x = a === undefined ? null : money(a);
  return x !== null && x === (b === undefined ? null : money(b));
}
