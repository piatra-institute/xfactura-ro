/**
 * When a month's D112 is filed and its contributions and wage tax are paid, by the employer's
 * D112 period (the yearly determination `payroll.period`).
 *
 * - Monthly: the month's D112 by the 25th of the next month (Codul fiscal art. 147 alin. (1)),
 *   and the tax and contributions by the same day (art. 80 alin. (1), art. 81 alin. (1)).
 * - Quarterly (art. 80 alin. (2), art. 147 alin. (4)–(5)): one D112 for each month of the quarter,
 *   each by the 25th of the month after the quarter; the tax, CAS, CASS and CAM of each month are
 *   paid by that day too (art. 80 alin. (2), art. 146 alin. (3), art. 168 alin. (3), art. 220^6
 *   alin. (1)). OPANAF nr. 605/2026 anexa nr. 6 cap. I repeats it ("câte unei declarații pentru
 *   fiecare lună din trimestru").
 * - The exception (art. 147 alin. (11)): a month of the quarter in which an employee is on sick
 *   leave or stops being insured (a contract ended) is declared by the 25th of the next month,
 *   and the months of the quarter before it with it; the months after it wait for the quarter's
 *   deadline. The text says the earlier months go with the event for the end of insurance in the
 *   second month; the engine applies it to sick leave too, the earlier of the two readings (an
 *   expert question, `ro.deadline.D112.quarterly`). Payment is not moved: the payment articles
 *   do not refer to alin. (11).
 *
 * The option to file monthly (art. 147 alin. (8)–(9), the "Lunară prin opțiune" box of the forms
 * of OPANAF nr. 1.699/2021) makes the year monthly: it is the determination's value, as recorded.
 */
export type PayrollPeriod = 'monthly' | 'quarterly';

const quarterOf = (month: string) =>
  `${month.slice(0, 4)}-Q${Math.ceil(Number(month.slice(5, 7)) / 3)}`;

/** The three months of a month's quarter, in order. */
export function quarterMonths(month: string): string[] {
  const first = (Math.ceil(Number(month.slice(5, 7)) / 3) - 1) * 3 + 1;
  return [0, 1, 2].map((step) => `${month.slice(0, 4)}-${String(first + step).padStart(2, '0')}`);
}

export interface D112Filing {
  month: string;
  /** The deadline parameter (`ro.deadline.D112` or `ro.deadline.D112.quarterly`). */
  deadline: 'D112' | 'D112.quarterly';
  /** The period the deadline counts from: a month (YYYY-MM) or a quarter (YYYY-Qn). */
  counted: string;
  /** Why: monthly (alin. (1)), quarterly (alin. (4)–(5)) or brought forward (alin. (11)). */
  basis: 'monthly' | 'quarterly' | 'event';
  /** The month of the quarter whose sick leave or end of insurance brings it forward. */
  event: string | null;
}

/**
 * A month's D112 deadline: the month's own for a monthly filer; for a quarterly filer, the
 * quarter's, unless sick leave or the end of insurance in this month or a later month of the same
 * quarter brings it to the 25th after the earliest such month (art. 147 alin. (11)). An event in
 * the quarter's last month gives the quarter's own day.
 */
export function d112Filing(
  month: string,
  period: PayrollPeriod,
  eventMonths: readonly string[],
): D112Filing {
  if (period === 'monthly')
    return { month, deadline: 'D112', counted: month, basis: 'monthly', event: null };
  const months = quarterMonths(month);
  const event = months.filter((item) => item >= month && eventMonths.includes(item))[0] ?? null;
  if (event && event !== months[2])
    return { month, deadline: 'D112', counted: event, basis: 'event', event };
  return {
    month,
    deadline: 'D112.quarterly',
    counted: quarterOf(month),
    basis: event ? 'event' : 'quarterly',
    event,
  };
}

/**
 * The period whose deadline the month's wage tax and contributions are paid by: the month, or
 * the quarter for a quarterly payer (art. 80 alin. (2), art. 146 alin. (3), art. 168 alin. (3),
 * art. 220^6 alin. (1)), whatever alin. (11) does to the declaration.
 */
export function payrollPaymentPeriod(month: string, period: PayrollPeriod) {
  return period === 'monthly'
    ? { deadline: 'D112' as const, counted: month }
    : { deadline: 'D112.quarterly' as const, counted: quarterOf(month) };
}
