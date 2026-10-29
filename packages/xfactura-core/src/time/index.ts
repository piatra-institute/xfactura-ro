/** A calendar date, `YYYY-MM-DD`. Accounting dates are dates, never instants. */
export type LocalDate = string & { readonly __localDate: unique symbol };
/** A calendar month, `YYYY-MM`. */
export type Month = string & { readonly __month: unique symbol };

const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

// Days since 1970-01-01 for a proleptic Gregorian date (H. Hinnant's civil algorithms).
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

function civilFromDays(days: number): [number, number, number] {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const dayOfEra = z - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36524) -
      Math.floor(dayOfEra / 146096)) /
      365,
  );
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const mp = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return [yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, day];
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');
const format = (year: number, month: number, day: number) =>
  `${pad(year, 4)}-${pad(month)}-${pad(day)}` as LocalDate;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

export function isLocalDate(text: string): text is LocalDate {
  const match = datePattern.exec(text);
  if (!match) return false;
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

export function parseLocalDate(text: string): LocalDate {
  if (!isLocalDate(text)) throw new RangeError(`Invalid date: ${text}`);
  return text;
}

function parts(date: LocalDate): [number, number, number] {
  return [Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10))];
}

export function toEpochDay(date: LocalDate): number {
  return daysFromCivil(...parts(date));
}

export function fromEpochDay(days: number): LocalDate {
  return format(...civilFromDays(days));
}

export function addDays(date: LocalDate, days: number): LocalDate {
  return fromEpochDay(toEpochDay(date) + days);
}

/** Signed number of days from `from` to `to`. */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  return toEpochDay(to) - toEpochDay(from);
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: LocalDate): number {
  return ((((toEpochDay(date) + 3) % 7) + 7) % 7) + 1;
}

export function monthOf(date: LocalDate): Month {
  return date.slice(0, 7) as Month;
}

export function monthStart(month: Month): LocalDate {
  return `${month}-01` as LocalDate;
}

export function monthEnd(month: Month): LocalDate {
  const year = Number(month.slice(0, 4)),
    value = Number(month.slice(5, 7));
  return format(year, value, daysInMonth(year, value));
}

export function addMonths(month: Month, count: number): Month {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + count;
  return `${pad(Math.floor(index / 12), 4)}-${pad((index % 12) + 1)}` as Month;
}

/** Adds months to a date, clamping the day to the target month's length. */
export function addMonthsToDate(date: LocalDate, count: number): LocalDate {
  const target = addMonths(monthOf(date), count);
  const year = Number(target.slice(0, 4)),
    month = Number(target.slice(5, 7));
  return format(year, month, Math.min(parts(date)[2], daysInMonth(year, month)));
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// 01:00 UTC on the last Sunday of the month, the EU daylight-saving transition instant.
function lastSundayTransition(year: number, month: number): number {
  const last = daysFromCivil(year, month, daysInMonth(year, month));
  const weekday = ((((last + 3) % 7) + 7) % 7) + 1;
  return (last - (weekday % 7)) * DAY + HOUR;
}

/**
 * The calendar date in Europe/Bucharest at an instant: UTC+3 between the EU transitions on the
 * last Sundays of March and October at 01:00 UTC, otherwise UTC+2. Romania has applied this rule
 * since 1997; earlier instants are rejected rather than guessed.
 */
export function bucharestDate(epochMilliseconds: number): LocalDate {
  if (!Number.isFinite(epochMilliseconds)) throw new RangeError('Invalid instant.');
  const year = civilFromDays(Math.floor((epochMilliseconds + 2 * HOUR) / DAY))[0];
  if (year < 1997) throw new RangeError('Europe/Bucharest offsets before 1997 are not modelled.');
  const summer =
    epochMilliseconds >= lastSundayTransition(year, 3) &&
    epochMilliseconds < lastSundayTransition(year, 10);
  return fromEpochDay(Math.floor((epochMilliseconds + (summer ? 3 : 2) * HOUR) / DAY));
}

/** The UTC calendar date at an instant, which is what `Date.prototype.toISOString` reports. */
export function utcDate(epochMilliseconds: number): LocalDate {
  if (!Number.isFinite(epochMilliseconds)) throw new RangeError('Invalid instant.');
  return fromEpochDay(Math.floor(epochMilliseconds / DAY));
}
