import { z } from 'zod';
import { parseScaled } from '../../money';
import {
  RuleGapError,
  type ParameterDefinition,
  type ParameterVersion,
  type RuleContext,
} from '../../rules';
import { parseLocalDate as date, type LocalDate } from '../../time';
import { workingDaysBetween } from '../calendar';

const percent = z.string().regex(/^(0|[1-9]\d{0,2})(\.\d{1,4})?$/);
const count = z.number().int().min(0).max(31);

export const sickPercents = z
  .object({
    /** Certificates of up to 7 days, of 8 to 14 days, and of more than 15 days. */
    upTo7: percent,
    upTo14: percent,
    over15: percent,
  })
  .strict();
export type SickPercents = z.infer<typeof sickPercents>;

export const sickDays = z
  .object({
    /** Working days at the start of an episode not paid at all. */
    unpaid: count,
    /** The working days after them that the employer pays; the fund pays the rest. */
    employer: count,
  })
  .strict();
export type SickDays = z.infer<typeof sickDays>;

const definition = (key: string, value: z.ZodType, description: string): ParameterDefinition => ({
  key,
  axis: 'medical_certificate_issue_date',
  continuity: 'block',
  scope: [],
  value,
  description,
});

export const sickLeaveDefinitions: ParameterDefinition[] = [
  definition(
    'ro.sick.percent',
    sickPercents,
    'Procentul din baza de calcul al indemnizației pentru incapacitate temporară de muncă din boală obișnuită, după durata certificatului.',
  ),
  definition(
    'ro.sick.days',
    sickDays,
    'Zilele lucrătoare neplătite la începutul episodului și cele suportate de angajator.',
  ),
  definition(
    'ro.sick.base_cap',
    z.string().regex(/^[1-9]\d?$/),
    'Plafonul lunar al veniturilor din baza de calcul, în salarii minime brute pe țară.',
  ),
];

const version = (
  key: string,
  value: ParameterVersion['value'],
  clauses: string[],
  from: string,
  to: string | null = null,
): ParameterVersion => ({
  id: `${key}/${from}`,
  key,
  scope: {},
  value,
  from: date(from),
  to: to === null ? null : date(to),
  reviewedThrough: to === null ? date('2026-12-31') : null,
  knowledgeDate: null,
  status: 'extracted',
  clauses,
});

/**
 * Read in the consolidated OUG 158/2005 of 1 July 2026: it shows the values in force, not since
 * when, so certificates issued before 1 February 2026 (when OUG 91/2025 art. II started reducing
 * a day) are a gap until the earlier texts are sourced. The reduction ends with 2027.
 */
export const sickLeaveVersions: ParameterVersion[] = [
  version(
    'ro.sick.percent',
    { upTo7: '55', upTo14: '65', over15: '75' },
    ['OUG158/2005:art.17(1)'],
    '2026-02-01',
  ),
  version(
    'ro.sick.days',
    { unpaid: 1, employer: 5 },
    ['OUG91/2025:art.II', 'Norme-OUG158/2005:art.73'],
    '2026-02-01',
    '2027-12-31',
  ),
  version('ro.sick.base_cap', '12', ['OUG158/2005:art.10(1)'], '2026-02-01'),
];

/** The indemnity codes calculated: 01, ordinary illness. The others (accidents, the diseases paid
 * at 100%, maternity, childcare and the rest) have their own rules and are refused until
 * sourced. */
export const sickCodes = ['01'] as const;

export interface SickCertificate {
  series: string;
  number: string;
  /** The indemnity code on the certificate (codul de indemnizație). */
  code: string;
  issued: LocalDate;
  from: LocalDate;
  to: LocalDate;
  /** The certificate continues an earlier one of the same episode. */
  continuation: boolean;
  /** Issued for a hospitalized patient: no day is reduced (OUG 91/2025 art. II alin. (4)). */
  hospitalized: boolean;
}

/** The base of the episode's first certificate (OUG 158/2005 art. 10): the insured incomes of the
 * last 6 months of the 12 before the episode's month, each capped at 12 minimum wages, and the
 * insured working days in them. */
export interface SickBase {
  income: bigint;
  days: number;
}

/** What the episode's earlier certificates already used. */
export interface SickEpisode {
  /** Whether an earlier certificate's first day was already left unpaid. */
  reduced: boolean;
  /** The employer's days already paid in the episode. */
  employerDays: number;
}

export interface SickResult {
  /** Working days of the certificate in the month (only working days are paid, art. 10 (8)). */
  days: number;
  unpaidDays: number;
  employerDays: number;
  fundDays: number;
  /** In bani, truncated as the norms' example does. */
  dailyAverage: bigint;
  percent: string;
  /** Whole lei. */
  employer: bigint;
  fund: bigint;
  /** The working days the contract was suspended: all of the certificate's. */
  suspendedDays: LocalDate[];
  steps: { code: string; amount: bigint; clauses: readonly string[] }[];
}

const calendarDays = (from: LocalDate, to: LocalDate) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

/** `bani × percent / 100 × days`, in whole lei, half up. */
function indemnity(daily: bigint, rate: string, days: number) {
  const numerator = daily * parseScaled(rate, 4) * BigInt(days);
  const denominator = 1_000_000n * 100n;
  const whole = numerator / denominator;
  return (2n * (numerator - whole * denominator) >= denominator ? whole + 1n : whole) * 100n;
}

/**
 * The indemnity for temporary incapacity from ordinary illness on one certificate (OUG 158/2005
 * art. 10, 12 and 17; OUG 91/2025 art. II): the base's daily average times the certificate's
 * percentage, for its working days, less the episode's first working day, the employer's days
 * first and the fund's after them. What the texts leave open comes back as an issue.
 */
export function sickIndemnity(
  certificate: SickCertificate,
  base: SickBase,
  episode: SickEpisode,
  rules: RuleContext,
): { result: SickResult | null; issues: { code: string; message: string }[] } {
  const issues: { code: string; message: string }[] = [];
  if (!(sickCodes as readonly string[]).includes(certificate.code))
    issues.push({
      code: 'SICK_CODE',
      message: `Indemnizația cu codul ${certificate.code} nu este încă calculată: doar codul 01 (boală obișnuită).`,
    });
  if (
    certificate.to < certificate.from ||
    certificate.from.slice(0, 7) !== certificate.to.slice(0, 7)
  )
    issues.push({
      code: 'SICK_DATES',
      message: 'Certificatul de concediu medical acoperă zile dintr-o singură lună.',
    });
  if (base.days < 1 || base.income < 0n)
    issues.push({
      code: 'SICK_BASE',
      message: 'Baza de calcul nu are zile de stagiu: completați-o din adeverința de stagiu.',
    });
  const length = calendarDays(certificate.from, certificate.to);
  if (length === 15)
    issues.push({
      code: 'SICK_TIER',
      message:
        'Pentru un certificat de 15 zile, art. 17 alin. (1) nu stabilește procentul (65% până la 14 zile, 75% peste 15): stabiliți-l cu expertul contabil.',
    });
  if (issues.length) return { result: null, issues };

  try {
    const param = <T>(key: string) =>
      rules.param<T>(key, 'medical_certificate_issue_date', certificate.issued);
    const percents = param<SickPercents>('ro.sick.percent');
    const rate = length <= 7 ? percents.upTo7 : length <= 14 ? percents.upTo14 : percents.over15;
    const days = param<SickDays>('ro.sick.days');
    const suspendedDays = workingDaysBetween(certificate.from, certificate.to);
    const unpaidDays =
      certificate.continuation || certificate.hospitalized || episode.reduced
        ? 0
        : Math.min(days.unpaid, suspendedDays.length);
    const paid = suspendedDays.length - unpaidDays;
    const employerDays = Math.min(paid, Math.max(0, days.employer - episode.employerDays));
    const fundDays = paid - employerDays;
    const dailyAverage = base.income / BigInt(base.days);
    const clauses = ['OUG158/2005:art.10(1)', 'Norme-OUG158/2005:art.73'];
    const employer = indemnity(dailyAverage, rate, employerDays);
    const fund = indemnity(dailyAverage, rate, fundDays);
    return {
      result: {
        days: suspendedDays.length,
        unpaidDays,
        employerDays,
        fundDays,
        dailyAverage,
        percent: rate,
        employer,
        fund,
        suspendedDays,
        steps: [
          { code: 'sick.daily_average', amount: dailyAverage, clauses },
          ...(unpaidDays
            ? [
                {
                  code: 'sick.unpaid_days',
                  amount: BigInt(unpaidDays),
                  clauses: ['OUG91/2025:art.II'],
                },
              ]
            : []),
          {
            code: 'sick.employer',
            amount: employer,
            clauses: ['OUG91/2025:art.II', 'OUG158/2005:art.17(1)'],
          },
          {
            code: 'sick.fund',
            amount: fund,
            clauses: ['OUG158/2005:art.12', 'OUG158/2005:art.17(1)'],
          },
        ],
      },
      issues,
    };
  } catch (error) {
    if (!(error instanceof RuleGapError)) throw error;
    return { result: null, issues: [{ code: 'RULE_GAP', message: error.message }] };
  }
}

/** A month's insured income for the base, capped at `cap` minimum wages (art. 10 alin. (1)). */
export function cappedIncome(income: bigint, minimumWage: bigint, cap: string) {
  const ceiling = minimumWage * BigInt(cap);
  return income > ceiling ? ceiling : income;
}
