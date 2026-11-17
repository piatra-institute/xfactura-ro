import { currencyExponent, isSupportedCurrency } from 'xfactura-core/money';

/**
 * Every date, month and amount the accounting interface shows is formatted here, in Romanian.
 * Amounts are exact: they are read as decimal strings or integer minor units and never pass
 * through floating point.
 */

const monthNames = [
  'ianuarie',
  'februarie',
  'martie',
  'aprilie',
  'mai',
  'iunie',
  'iulie',
  'august',
  'septembrie',
  'octombrie',
  'noiembrie',
  'decembrie',
] as const;
const shortMonthNames = [
  'ian',
  'feb',
  'mar',
  'apr',
  'mai',
  'iun',
  'iul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
] as const;

/** The true minus sign, which reads as a sign rather than a hyphen. */
export const minus = '−';

const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/;
const isoMonth = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** `2026-11-17` → `17.11.2026`; anything that is not an ISO date is returned unchanged. */
export function formatDate(date: string) {
  const match = isoDate.exec(date);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : date;
}

/** The Romanian name of a month, 1 to 12. */
export function monthName(month: number, short = false) {
  return (short ? shortMonthNames : monthNames)[month - 1] ?? '';
}

/** `2026-01` → `ianuarie 2026`; anything that is not an ISO month is returned unchanged. */
export function formatMonth(month: string) {
  const match = isoMonth.exec(month);
  return match ? `${monthName(Number(match[2]))} ${match[1]}` : month;
}

/** `2026-01` → `ian 2026`. */
export function formatMonthShort(month: string) {
  const match = isoMonth.exec(month);
  return match ? `${monthName(Number(match[2]), true)} ${match[1]}` : month;
}

/** The months as an index that grows by one from each month to the next. */
const monthIndex = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7));

/**
 * Months collapsed into runs: `ian–dec 2026`, `nov 2025–feb 2026`, `mar 2026`; separate runs are
 * joined with `, `. Duplicates are ignored and the order is chronological.
 */
export function formatMonths(months: readonly string[]) {
  const valid = [...new Set(months.filter((month) => isoMonth.test(month)))].sort();
  const runs: [string, string][] = [];
  for (const month of valid) {
    const last = runs.at(-1);
    if (last && monthIndex(month) === monthIndex(last[1]) + 1) last[1] = month;
    else runs.push([month, month]);
  }
  return runs
    .map(([from, to]) => {
      if (from === to) return formatMonthShort(from);
      const sameYear = from.slice(0, 4) === to.slice(0, 4);
      const start = sameYear ? monthName(Number(from.slice(5, 7)), true) : formatMonthShort(from);
      return `${start}–${formatMonthShort(to)}`;
    })
    .join(', ');
}

/** Groups the digits of a whole number by thousands with a dot: `1234567` → `1.234.567`. */
function group(digits: string) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** A currency's minor digits from core's ISO 4217 table; a bare amount has two, as RON. */
function minorDigits(currency: string) {
  return currency && isSupportedCurrency(currency) ? currencyExponent(currency) : 2;
}

/**
 * An amount in integer minor units, as a bigint or an integer string, split by the currency's
 * minor digits from core: `123456n` → `1.234,56 RON`, `1234n, 'JPY'` → `1.234 JPY`. Always grouped,
 * exact, negative amounts with the true minus sign. Text that is not an integer, and a currency
 * core does not know, are errors.
 */
export function formatMinor(
  minor: bigint | string,
  currency = 'RON',
  { suffix = true }: { suffix?: boolean } = {},
) {
  if (typeof minor === 'string' && !/^[+-]?\d+$/.test(minor))
    throw new RangeError(`Not an amount in minor units: "${minor}"`);
  const value = typeof minor === 'bigint' ? minor : BigInt(minor);
  const exponent = currencyExponent(currency);
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(exponent + 1, '0');
  const whole = exponent ? digits.slice(0, -exponent) : digits;
  const fraction = exponent ? `,${digits.slice(-exponent)}` : '';
  const amount = `${negative ? minus : ''}${group(whole)}${fraction}`;
  return suffix ? `${amount} ${currency}` : amount;
}

/**
 * An engine decimal string (`1234.56`, `-0.5`, `100`) → `1.234,56 RON`. The fraction keeps every
 * digit the engine sent and at least the currency's minor digits (two without a currency). A value
 * that is not a decimal is returned unchanged.
 */
export function formatMoney(value: string, currency = 'RON') {
  const amount = formatDecimal(value, minorDigits(currency));
  return amount === null ? value : currency ? `${amount} ${currency}` : amount;
}

/** A decimal string grouped with at least `digits` decimals; null when it is not a decimal. */
function formatDecimal(value: string, digits: number) {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const whole = match[2]!.replace(/^0+(?=\d)/, '');
  const fraction = (match[3] ?? '').padEnd(digits, '0');
  const zero = /^0+$/.test(whole + fraction);
  return `${match[1] === '-' && !zero ? minus : ''}${group(whole)}${fraction ? `,${fraction}` : ''}`;
}

/** An engine amount without its currency, for a table whose caption names the currency. */
export function formatAmount(value: string) {
  return formatMoney(value, '');
}

/** An engine quantity (`12.500`, thousandths) with the Romanian decimal comma. */
export function formatQuantity(value: string) {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = value.replace('-', '').split('.');
  return `${negative ? minus : ''}${group(whole)}${fraction ? `,${fraction}` : ''}`;
}

const bucharest = new Intl.DateTimeFormat('ro-RO', {
  timeZone: 'Europe/Bucharest',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** An engine instant shown in Romanian time: `2026-11-16T13:52:10Z` → `16.11.2026, 15:52`. */
export function formatDateTime(instant: string) {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return instant;
  const parts = bucharest.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('day')}.${part('month')}.${part('year')}, ${part('hour')}:${part('minute')}`;
}

/**
 * Reads an amount a person typed, Romanian style (`1.234,56`, `1234,5`, `-12`), into the decimal
 * string the engine expects for the currency (`1234.56`; `1234` for JPY, which has no minor unit).
 * A dot followed by exactly three digits groups thousands; any other single dot is a decimal
 * point, so `12.50` is also accepted. Returns null for text that is not an amount or has more
 * decimals than the currency's minor digits.
 */
export function parseMoney(text: string, currency = 'RON') {
  const exponent = currencyExponent(currency);
  const compact = text.replace(/[\s\u00a0\u202f]/g, '').replace(minus, '-');
  const match = /^([+-]?)([\d.,]+)$/.exec(compact);
  if (!match) return null;
  const body = match[2]!;
  let whole: string;
  let fraction = '';
  if (body.includes(',')) {
    const [left = '', right, ...rest] = body.split(',');
    if (rest.length || right === undefined) return null;
    if (left.includes('.') && !/^\d{1,3}(\.\d{3})+$/.test(left)) return null;
    whole = left.replace(/\./g, '');
    fraction = right;
  } else if (/^\d{1,3}(\.\d{3})+$/.test(body)) {
    whole = body.replace(/\./g, '');
  } else {
    const [left = '', right, ...rest] = body.split('.');
    if (rest.length) return null;
    whole = left;
    fraction = right ?? '';
  }
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(fraction) || !(whole || fraction)) return null;
  if (fraction.length > exponent) return null;
  const units = whole.replace(/^0+(?=\d)/, '') || '0';
  const digits = exponent ? `${units}.${fraction.padEnd(exponent, '0')}` : units;
  return match[1] === '-' && /[1-9]/.test(digits) ? `-${digits}` : digits;
}

/** A decimal string as a person types it back: `1234.56` → `1.234,56`. */
export function formatMoneyInput(value: string, currency = 'RON') {
  return (formatDecimal(value, currencyExponent(currency)) ?? value).replace(minus, '-');
}
