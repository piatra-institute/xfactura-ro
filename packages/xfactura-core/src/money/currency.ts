import { formatScaled, parseScaled } from './decimal';

// ISO 4217 minor-unit exponents for RON and the currencies BNR publishes reference rates for.
// Units without a minor unit in ISO 4217 (XAU, XDR) are not invoice currencies and are excluded.
const exponents: Record<string, number> = {
  RON: 2,
  AED: 2,
  AUD: 2,
  BGN: 2,
  BRL: 2,
  CAD: 2,
  CHF: 2,
  CNY: 2,
  CZK: 2,
  DKK: 2,
  EGP: 2,
  EUR: 2,
  GBP: 2,
  HKD: 2,
  HUF: 2,
  IDR: 2,
  ILS: 2,
  INR: 2,
  ISK: 0,
  JPY: 0,
  KRW: 0,
  MDL: 2,
  MXN: 2,
  MYR: 2,
  NOK: 2,
  NZD: 2,
  PHP: 2,
  PLN: 2,
  RSD: 2,
  RUB: 2,
  SEK: 2,
  SGD: 2,
  THB: 2,
  TRY: 2,
  UAH: 2,
  USD: 2,
  ZAR: 2,
};

export const LEDGER_CURRENCY = 'RON';

export function isSupportedCurrency(code: string): boolean {
  return Object.hasOwn(exponents, code);
}

export function currencyExponent(code: string): number {
  const exponent = exponents[code];
  if (exponent === undefined) throw new RangeError(`Unsupported currency: ${code}`);
  return exponent;
}

/** Amount text with at most the currency's minor digits, as integer minor units. */
export function parseMoney(text: string, currency: string): bigint {
  return parseScaled(text, currencyExponent(currency));
}

export function formatMoney(minor: bigint, currency: string): string {
  return formatScaled(minor, currencyExponent(currency));
}
