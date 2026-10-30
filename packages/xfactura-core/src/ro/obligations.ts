import { z } from 'zod';
import type { ParameterDefinition, ParameterVersion, RuleContext } from '../rules';
import { addDays, parseLocalDate as date, type LocalDate } from '../time';
import { workingDaysBetween } from './calendar';

/** The returns the engine prepares, by the deadline that applies to them. */
export const obligationKinds = [
  'D300',
  'D390',
  'D394',
  'D112',
  'D100.micro',
  'D100.dividends',
  'D205',
  'D406',
  'S1005',
] as const;
export type ObligationKind = (typeof obligationKinds)[number];

export const deadlineSchema = z.discriminatedUnion('kind', [
  /** A day of the month after the period's last month, or that month's last day when it is
   * shorter (D394's 30th is the 28th or 29th in February). */
  z.object({ kind: z.literal('next_month_day'), day: z.number().int().min(1).max(31) }).strict(),
  /** The last calendar day of the month after the period. */
  z.object({ kind: z.literal('next_month_last_day') }).strict(),
  /** The last day of February of the year after the period's. */
  z.object({ kind: z.literal('february_last_day') }).strict(),
  /** A number of days after the period's last day. */
  z.object({ kind: z.literal('days_after'), days: z.number().int().min(1).max(366) }).strict(),
]);
export type Deadline = z.infer<typeof deadlineSchema>;

export const deadlineShiftSchema = z
  .object({
    /** A deadline falling on a non-working day moves to the next working day. */
    nonWorking: z.literal('next_working_day'),
    /** A return or payment to ANAF due on 25 December is due on 21 December, or on the last
     * working day before it when 21 December is not one. */
    december25: z.literal('december_21_or_previous_working_day'),
  })
  .strict();
export type DeadlineShift = z.infer<typeof deadlineShiftSchema>;

export const obligationDefinitions: ParameterDefinition[] = [
  ...obligationKinds.map((kind): ParameterDefinition => ({
    key: `ro.deadline.${kind}`,
    axis: 'reporting_period_start',
    continuity: 'block',
    scope: [],
    value: deadlineSchema,
    description: `Termenul de depunere al declarației ${kind.replace('.', ' ')} față de perioada de raportare.`,
  })),
  {
    key: 'ro.deadline.shift',
    axis: 'reporting_period_start',
    continuity: 'block',
    scope: [],
    value: deadlineShiftSchema,
    description:
      'Mutarea termenelor care cad într-o zi nelucrătoare și a celor de la 25 decembrie.',
  },
];

const version = (
  key: string,
  value: ParameterVersion['value'],
  clauses: string[],
  from: string,
): ParameterVersion => ({
  id: `${key}/${from}`,
  key,
  scope: {},
  value,
  from: date(from),
  to: null,
  reviewedThrough: date('2026-12-31'),
  knowledgeDate: null,
  status: 'extracted',
  clauses,
});
const day25 = { kind: 'next_month_day', day: 25 };

/** The deadlines as the texts read on 30.10.2026 give them. */
export const obligationVersions: ParameterVersion[] = [
  version('ro.deadline.D300', day25, ['ANAF/Cod-fiscal-consolidat:art.323(1)'], '2016-01-01'),
  version('ro.deadline.D390', day25, ['OPANAF591/2016:anexa4.pct.1.1'], '2016-01-01'),
  version(
    'ro.deadline.D394',
    { kind: 'next_month_day', day: 30 },
    ['OPANAF2328/2016:art.I'],
    '2016-07-01',
  ),
  version('ro.deadline.D112', day25, ['ANAF/Cod-fiscal-consolidat:art.147(1)'], '2016-01-01'),
  version(
    'ro.deadline.D100.micro',
    day25,
    ['ANAF/Cod-fiscal-consolidat:art.56(1)-(2)'],
    '2016-01-01',
  ),
  version(
    'ro.deadline.D100.dividends',
    day25,
    ['ANAF/Cod-fiscal-consolidat:art.43(2)', 'ANAF/Cod-fiscal-consolidat:art.97(7)'],
    '2016-01-01',
  ),
  version(
    'ro.deadline.D205',
    { kind: 'february_last_day' },
    ['ANAF/Cod-fiscal-consolidat:art.132(2)'],
    '2016-01-01',
  ),
  version(
    'ro.deadline.D406',
    { kind: 'next_month_last_day' },
    ['OPANAF1783/2021:anexa4.pct.1-4'],
    '2022-01-01',
  ),
  version(
    'ro.deadline.S1005',
    { kind: 'days_after', days: 150 },
    ['L82/1991:art.36(1)(a)'],
    '2025-01-01',
  ),
  version(
    'ro.deadline.shift',
    { nonWorking: 'next_working_day', december25: 'december_21_or_previous_working_day' },
    [
      'ANAF/Cod-procedura-fiscala-2019:art.75',
      'L134/2010:art.181(2)',
      'ANAF/Cod-procedura-fiscala-2019:art.155(2)',
    ],
    '2016-01-01',
  ),
];

const pad = (value: number) => String(value).padStart(2, '0');
const lastDayOf = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10) as LocalDate;
const isWorkingDay = (day: LocalDate) => workingDaysBetween(day, day).length === 1;

export type DueDate = {
  /** The deadline the texts give. */
  nominal: LocalDate;
  /** The last day to file, after moving a deadline off a non-working day or 25 December. */
  due: LocalDate;
  /** The parameter versions read: the deadline's and the shift's; their clauses cite the texts. */
  versions: string[];
};

/**
 * The last day to file a return for a period (its first and last day: a month, a quarter, a
 * year or, for dividends, the month of payment). Throws RuleGapError where the deadline is not
 * sourced. The move off non-working days applies to every deadline, ANAF's "ultima zi
 * calendaristică" included, as the procedure code's general rule (art. 75) reads; the expert
 * reviews that reading.
 */
export function obligationDue(
  kind: ObligationKind,
  period: { start: LocalDate; end: LocalDate },
  rules: RuleContext,
): DueDate {
  const deadline = rules.param<Deadline>(
    `ro.deadline.${kind}`,
    'reporting_period_start',
    period.start,
  );
  const shift = rules.param<DeadlineShift>(
    'ro.deadline.shift',
    'reporting_period_start',
    period.start,
  );
  const year = Number(period.end.slice(0, 4));
  const month = Number(period.end.slice(5, 7));
  const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  const nominal =
    deadline.kind === 'next_month_day'
      ? ([
          lastDayOf(next.year, next.month),
          `${next.year}-${pad(next.month)}-${pad(deadline.day)}`,
        ].sort()[0]! as LocalDate)
      : deadline.kind === 'next_month_last_day'
        ? lastDayOf(next.year, next.month)
        : deadline.kind === 'february_last_day'
          ? lastDayOf(year + 1, 2)
          : addDays(period.end, deadline.days);
  let due = nominal;
  if (nominal.endsWith('-12-25') && shift.december25 === 'december_21_or_previous_working_day') {
    due = `${nominal.slice(0, 4)}-12-21` as LocalDate;
    while (!isWorkingDay(due)) due = addDays(due, -1);
  } else while (!isWorkingDay(due)) due = addDays(due, 1);
  const versions = [...rules.used.keys()].filter(
    (id) => id.startsWith(`ro.deadline.${kind}/`) || id.startsWith('ro.deadline.shift/'),
  );
  return { nominal, due, versions };
}
