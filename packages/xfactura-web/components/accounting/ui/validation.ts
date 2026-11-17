import { currencyExponent } from 'xfactura-core/money';
import { formatDate, formatMonth, parseMoney } from '../format';

/**
 * Why a field's value cannot be submitted, in Romanian, or an empty string when it can. The fields
 * attach these messages to the form control they submit, so the browser refuses the form.
 */

const isoMonth = /^\d{4}-(0[1-9]|1[0-2])$/;

/** A month (`YYYY-MM`): its format, its bounds and whether one is required. */
export function monthProblem(
  value: string | null | undefined,
  {
    minValue,
    maxValue,
    isRequired,
  }: { minValue?: string; maxValue?: string; isRequired?: boolean } = {},
) {
  if (!value) return isRequired ? 'Alege luna.' : '';
  if (!isoMonth.test(value)) return 'Luna aleasă nu este o lună validă.';
  const early = !!minValue && value < minValue;
  const late = !!maxValue && value > maxValue;
  if (!early && !late) return '';
  if (minValue && maxValue)
    return `Alege o lună între ${formatMonth(minValue)} și ${formatMonth(maxValue)}.`;
  return early
    ? `Alege o lună începând cu ${formatMonth(minValue!)}.`
    : `Alege o lună până la ${formatMonth(maxValue!)}.`;
}

/** An amount as typed: whether it reads as an amount in the currency, and whether one is required. */
export function moneyProblem(text: string, currency = 'RON', isRequired = false) {
  if (!text.trim()) return isRequired ? 'Completează suma.' : '';
  if (parseMoney(text, currency) !== null) return '';
  const digits = currencyExponent(currency);
  return digits === 0
    ? 'Scrie suma ca 1.234, fără zecimale.'
    : digits === 2
      ? 'Scrie suma ca 1.234,56, cu cel mult două zecimale.'
      : `Scrie suma cu cel mult ${digits} zecimale.`;
}

type Segment = { type: string; value?: number | null; isEditable: boolean; isPlaceholder: boolean };

/**
 * A date's segments: all filled, or all empty, never a part of a date; and, when filled, the day
 * they show must be the field's value (31.02 is shown while typed but is no date).
 */
export function dateProblem(
  segments: readonly Segment[],
  isRequired = false,
  value?: string | null,
) {
  const editable = segments.filter((segment) => segment.isEditable);
  const filled = editable.filter((segment) => !segment.isPlaceholder).length;
  if (filled === 0) return isRequired ? 'Completează data.' : '';
  if (filled < editable.length)
    return 'Data este incompletă: completează ziua, luna și anul sau golește câmpul.';
  if (value === undefined) return '';
  const part = (type: string) =>
    String(segments.find((segment) => segment.type === type)?.value ?? '').padStart(2, '0');
  const shown = `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
  return value === shown ? '' : 'Ziua scrisă nu există în calendar; verifică data.';
}

/** Whether every part of a date is filled. */
export function dateComplete(segments: readonly Segment[]) {
  return segments.every((segment) => !segment.isEditable || !segment.isPlaceholder);
}

/** A whole date (`YYYY-MM-DD`) against its bounds, with the bounds written as people read them. */
export function dateRangeProblem(
  value: string | null | undefined,
  { minValue, maxValue }: { minValue?: string; maxValue?: string } = {},
) {
  if (!value) return '';
  const early = !!minValue && value < minValue;
  const late = !!maxValue && value > maxValue;
  if (!early && !late) return '';
  if (minValue && maxValue)
    return `Alege o dată între ${formatDate(minValue)} și ${formatDate(maxValue)}.`;
  return early
    ? `Alege o dată începând cu ${formatDate(minValue!)}.`
    : `Alege o dată până la ${formatDate(maxValue!)}.`;
}
