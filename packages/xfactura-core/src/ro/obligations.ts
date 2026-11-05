import { z } from 'zod';
import type { ParameterDefinition, ParameterVersion, RuleContext } from '../rules';
import { addDays, parseLocalDate as date, type LocalDate } from '../time';
import { workingDaysBetween } from './calendar';

/** The returns the engine prepares, by the deadline that applies to them. */
export const obligationKinds = [
  'D300',
  'D301',
  'D390',
  'D394',
  'D112',
  'D112.quarterly',
  'D100.micro',
  'D100.dividends',
  'D205',
  'D406',
  'D406.assets',
  'S1005',
  'S1003',
  'S1046',
  'D212',
  'D204',
  'D100.profit',
  'D101',
  'D700.micro_entry',
  'D700.micro_exit',
  'D700.micro_exit_january',
] as const;
export type ObligationKind = (typeof obligationKinds)[number];

/** Returns the company files outside the engine, through ANAF's portal: the engine computes when
 * they are due, and a person records the filing (`obligation.filed`). */
export const externalReturns: readonly string[] = ['D700'];

const deadlineKinds = [
  /** A day of the month after the period's last month, or that month's last day when it is
   * shorter (D394's 30th is the 28th or 29th in February). */
  z.object({ kind: z.literal('next_month_day'), day: z.number().int().min(1).max(31) }).strict(),
  /** The last calendar day of the month after the period. */
  z.object({ kind: z.literal('next_month_last_day') }).strict(),
  /** The last day of February of the year after the period's. */
  z.object({ kind: z.literal('february_last_day') }).strict(),
  /** A number of days after the period's last day. */
  z.object({ kind: z.literal('days_after'), days: z.number().int().min(1).max(366) }).strict(),
  /** A day of the year after the period's (D212's 25 May), or of a later year (`years`). */
  z
    .object({
      kind: z.literal('next_year_date'),
      month: z.number().int().min(1).max(12),
      day: z.number().int().min(1).max(31),
      years: z.number().int().min(2).max(3).optional(),
    })
    .strict(),
] as const;
const singleDeadline = z.discriminatedUnion('kind', [...deadlineKinds]);
export const deadlineSchema = z.discriminatedUnion('kind', [
  ...deadlineKinds,
  /** Official texts that disagree on the deadline, each reading with the clauses that give it:
   * never settled by the engine. The earliest is the date to file by, shown with the conflict
   * until an expert contabil answers. */
  z
    .object({
      kind: z.literal('conflict'),
      readings: z
        .array(
          z
            .object({
              deadline: singleDeadline,
              clauses: z.array(z.string().min(1)).min(1),
              text: z.string().min(1),
            })
            .strict(),
        )
        .min(2),
    })
    .strict(),
]);
export type Deadline = z.infer<typeof deadlineSchema>;
type SingleDeadline = z.infer<typeof singleDeadline>;

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
  // The special return of a person not registered under art. 316: the 25th of the month after
  // the one in which the VAT becomes chargeable, only for the months it does.
  version(
    'ro.deadline.D301',
    day25,
    ['ANAF/Cod-fiscal-consolidat:art.324(1)-(2)', 'OPANAF592/2016:anexa2.pct.II'],
    '2026-01-01',
  ),
  version('ro.deadline.D390', day25, ['OPANAF591/2016:anexa4.pct.1.1'], '2016-01-01'),
  version(
    'ro.deadline.D394',
    { kind: 'next_month_day', day: 30 },
    ['OPANAF2328/2016:art.I'],
    '2016-07-01',
  ),
  version('ro.deadline.D112', day25, ['ANAF/Cod-fiscal-consolidat:art.147(1)'], '2016-01-01'),
  // A quarterly filer's D112 for each month of the quarter: the 25th of the month after the
  // quarter, counted from the quarter's last month (the calendar passes the quarter as period).
  version(
    'ro.deadline.D112.quarterly',
    day25,
    ['ANAF/Cod-fiscal-consolidat:art.147(4)-(10)'],
    '2026-01-01',
  ),
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
  // The annual assets file (D406 Active): by the annual statements' deadline (anexa nr. 4 pct. 1
  // and 7), so with their two readings for 2025 and the law's 150 days from 2026 (S1005, S1003).
  ...(() => {
    const assets = ['OPANAF1783/2021:anexa4.pct.1,7-8', 'ANAF/D406_Clarificare_2022:precizari'];
    return [
      {
        ...version(
          'ro.deadline.D406.assets',
          {
            kind: 'conflict',
            readings: [
              {
                deadline: { kind: 'days_after', days: 150 },
                clauses: [...assets, 'L82/1991:art.36(1)(a)'],
                text: 'OPANAF nr. 1.783/2021, anexa nr. 4 pct. 1 și 7: activele se raportează până la termenul de depunere a situațiilor financiare; Legea contabilității nr. 82/1991, art. 36 alin. (1) lit. a): în termen de 150 de zile de la încheierea exercițiului financiar.',
              },
              {
                deadline: { kind: 'next_year_date', month: 5, day: 31 },
                clauses: [...assets, 'OMF2036/2025:anexa1.pct.3.1(1)(a)'],
                text: 'OPANAF nr. 1.783/2021, anexa nr. 4 pct. 1 și 7: activele se raportează până la termenul de depunere a situațiilor financiare; OMF nr. 2.036/2025, anexa nr. 1 pct. 3.1 alin. (1) lit. a): până la 31 mai inclusiv a exercițiului următor.',
              },
            ],
          },
          [...assets, 'L82/1991:art.36(1)(a)', 'OMF2036/2025:anexa1.pct.3.1(1)(a)'],
          '2025-01-01',
        ),
        to: date('2025-12-31'),
      },
      version(
        'ro.deadline.D406.assets',
        { kind: 'days_after', days: 150 },
        [...assets, 'L82/1991:art.36(1)(a)'],
        '2026-01-01',
      ),
    ];
  })(),
  // The annual statements of a company (L31/1990), micro (S1005) or small (S1003): Legea
  // contabilității gives 150 days from the year's end, OMF nr. 2.036/2025 (financial year 2025)
  // 31 May of the next year. The engine does not settle it: both readings are shown, the earlier
  // to file by (30 May, or 31 May in a leap year). OMF nr. 2.036/2025 orders the statements of
  // 2025 only (it repealed OMF nr. 107/2025, which ordered 2024's); no order is published for
  // 2026's, so from 2026 the law's 150 days stand alone until one is.
  ...(['S1005', 'S1003'] as const).flatMap((kind) => [
    version(
      `ro.deadline.${kind}`,
      { kind: 'days_after', days: 150 },
      ['L82/1991:art.36(1)(a)'],
      '2026-01-01',
    ),
    {
      ...version(
        `ro.deadline.${kind}`,
        {
          kind: 'conflict',
          readings: [
            {
              deadline: { kind: 'days_after', days: 150 },
              clauses: ['L82/1991:art.36(1)(a)'],
              text: 'Legea contabilității nr. 82/1991, art. 36 alin. (1) lit. a): societățile depun situațiile financiare anuale în termen de 150 de zile de la încheierea exercițiului financiar.',
            },
            {
              deadline: { kind: 'next_year_date', month: 5, day: 31 },
              clauses: ['OMF2036/2025:anexa1.pct.3.1(1)(a)'],
              text: 'OMF nr. 2.036/2025, anexa nr. 1 pct. 3.1 alin. (1) lit. a): societățile reglementate de Legea nr. 31/1990 depun până la data de 31 mai inclusiv a exercițiului financiar următor celui de raportare.',
            },
          ],
        },
        ['L82/1991:art.36(1)(a)', 'OMF2036/2025:anexa1.pct.3.1(1)(a)'],
        '2025-01-01',
      ),
      to: date('2025-12-31'),
    },
  ]),
  // The inactivity declaration: 60 days from the year's end, in the law and, for 2025, in the
  // order.
  {
    ...version(
      'ro.deadline.S1046',
      { kind: 'days_after', days: 60 },
      ['L82/1991:art.36(2)', 'OMF2036/2025:anexa1.pct.3.3'],
      '2025-01-01',
    ),
    to: date('2025-12-31'),
  },
  version(
    'ro.deadline.S1046',
    { kind: 'days_after', days: 60 },
    ['L82/1991:art.36(2)'],
    '2026-01-01',
  ),
  // Income of 2025 (OPANAF nr. 2.736/2025) and, as the Code reads now, of 2026.
  version(
    'ro.deadline.D212',
    { kind: 'next_year_date', month: 5, day: 25 },
    ['ANAF/Cod-fiscal-consolidat:art.122(3)', 'OPANAF2736/2025:instr.I.1'],
    '2025-01-01',
  ),
  // Income of 2025 and 2026. The Code and the form's instructions in force (OPANAF nr.
  // 470/2021, whose form OPANAF nr. 90/2022 replaced from the income of 2022 without touching the
  // deadline) give the last day of February; the methodological norms still give 15 March. The
  // engine does not settle it: both readings are shown, the earlier to file by. (OPANAF nr.
  // 97/2019's 15 February applied to the income of 2018–2019, before OPANAF nr. 470/2021.)
  version(
    'ro.deadline.D204',
    {
      kind: 'conflict',
      readings: [
        {
          deadline: { kind: 'february_last_day' },
          clauses: ['ANAF/Cod-fiscal-consolidat:art.125(4)', 'OPANAF470/2021:anexa2.pct.3.1'],
          text: 'Codul fiscal, art. 125 alin. (4), și instrucțiunile formularului 204 (OPANAF nr. 470/2021, anexa nr. 2 pct. 3.1): până în ultima zi a lunii februarie a anului următor celui de realizare a venitului.',
        },
        {
          deadline: { kind: 'next_year_date', month: 3, day: 15 },
          clauses: ['ANAF/Cod-fiscal-consolidat:norme.art.125.pct.41(4)'],
          text: 'Normele metodologice ale Codului fiscal, titlul IV pct. 41 alin. (4): până la 15 martie a anului următor (text neactualizat).',
        },
      ],
    },
    [
      'ANAF/Cod-fiscal-consolidat:art.125(4)',
      'OPANAF470/2021:anexa2.pct.3.1',
      'ANAF/Cod-fiscal-consolidat:norme.art.125.pct.41(4)',
    ],
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
  /** Texts that disagree: each reading's date with its clauses. `nominal` and `due` are then the
   * earliest reading's, for the expert contabil to confirm or correct. */
  conflict?: { nominal: LocalDate; due: LocalDate; clauses: string[]; text: string }[];
};

/** A single deadline's day for a period. */
function nominalOf(deadline: SingleDeadline, period: { start: LocalDate; end: LocalDate }) {
  const year = Number(period.end.slice(0, 4));
  const month = Number(period.end.slice(5, 7));
  const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  return deadline.kind === 'next_month_day'
    ? ([
        lastDayOf(next.year, next.month),
        `${next.year}-${pad(next.month)}-${pad(deadline.day)}`,
      ].sort()[0]! as LocalDate)
    : deadline.kind === 'next_month_last_day'
      ? lastDayOf(next.year, next.month)
      : deadline.kind === 'february_last_day'
        ? lastDayOf(year + 1, 2)
        : deadline.kind === 'next_year_date'
          ? ([
              lastDayOf(year + (deadline.years ?? 1), deadline.month),
              `${year + (deadline.years ?? 1)}-${pad(deadline.month)}-${pad(deadline.day)}`,
            ].sort()[0]! as LocalDate)
          : addDays(period.end, deadline.days);
}

/** A deadline moved off a non-working day, or from 25 December to the 21st. */
function shifted(nominal: LocalDate, shift: DeadlineShift) {
  let due = nominal;
  if (nominal.endsWith('-12-25') && shift.december25 === 'december_21_or_previous_working_day') {
    due = `${nominal.slice(0, 4)}-12-21` as LocalDate;
    while (!isWorkingDay(due)) due = addDays(due, -1);
  } else while (!isWorkingDay(due)) due = addDays(due, 1);
  return due;
}

/**
 * The last day to file a return for a period (its first and last day: a month, a quarter, a
 * year or, for dividends, the month of payment). Throws RuleGapError where the deadline is not
 * sourced. The move off non-working days applies to every deadline, ANAF's "ultima zi
 * calendaristică" included, as the procedure code's general rule (art. 75) reads; the expert
 * reviews that reading. Where the texts disagree (`conflict`), every reading is returned and the
 * earliest is the one to file by: the engine does not settle it.
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
  const versions = [...rules.used.keys()].filter(
    (id) => id.startsWith(`ro.deadline.${kind}/`) || id.startsWith('ro.deadline.shift/'),
  );
  if (deadline.kind !== 'conflict') {
    const nominal = nominalOf(deadline, period);
    return { nominal, due: shifted(nominal, shift), versions };
  }
  const readings = deadline.readings
    .map((reading) => {
      const nominal = nominalOf(reading.deadline, period);
      return {
        nominal,
        due: shifted(nominal, shift),
        clauses: reading.clauses,
        text: reading.text,
      };
    })
    .sort((a, b) => a.due.localeCompare(b.due));
  return { nominal: readings[0]!.nominal, due: readings[0]!.due, versions, conflict: readings };
}
