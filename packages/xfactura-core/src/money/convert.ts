import { currencyExponent, LEDGER_CURRENCY } from './currency';
import { divRound, parseDecimal, type Rounding } from './decimal';

/** A reference rate quoted as `rate` units of the target currency per `multiplier` units of the
 * source currency (BNR quotes HUF, JPY and KRW per 100 units). */
export type Quote = { rate: string; multiplier: number };

/** Converts minor units exactly, rounding once at the end. */
export function convertMinor(
  minor: bigint,
  from: string,
  quote: Quote,
  to: string = LEDGER_CURRENCY,
  mode: Rounding = 'halfAwayFromZero',
): bigint {
  if (!Number.isSafeInteger(quote.multiplier) || quote.multiplier <= 0)
    throw new RangeError('Invalid rate multiplier.');
  const rate = parseDecimal(quote.rate);
  if (rate.numerator <= 0n) throw new RangeError('Rates must be positive.');
  const scale = 10n ** BigInt(currencyExponent(to));
  const unit = 10n ** BigInt(currencyExponent(from));
  return divRound(
    minor * rate.numerator * scale,
    rate.denominator * BigInt(quote.multiplier) * unit,
    mode,
  );
}
