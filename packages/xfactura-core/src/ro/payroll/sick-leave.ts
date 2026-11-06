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

/** How an indemnity code is paid and taxed. */
export const sickCodeRule = z
  .object({
    /** The C2 row group of D112's Nomenclator 10. */
    group: z.enum([
      'incapacity',
      'isolation',
      'quarantine',
      'maternity',
      'child_care',
      'oncology_care',
      'maternal_risk',
      'accident',
    ]),
    /** Who bears it: the employer for its days and FNUASS after them, FNUASS from the first paid
     * day, or the employer for its days and the state social insurance budget after them,
     * recovered from the territorial pension house (Legea nr. 346/2002 art. 19 alin. (6), 34). */
    payer: z.enum(['employer_then_fund', 'fund', 'employer_then_pension_house']),
    /** Salary income for the tax (art. 76 alin. (1)), or not (art. 62 lit. c)). */
    taxable: z.boolean(),
    /** In the CASS base (art. 155 alin. (1) lit. i): codes 01, 07 and 10 only). */
    cass: z.boolean(),
    /** The episode's first working day is not paid (OUG nr. 91/2025 art. II). */
    reduced: z.boolean(),
  })
  .strict();
export type SickCodeRule = z.infer<typeof sickCodeRule>;

/** Work accidents and occupational diseases (Legea nr. 346/2002): the days the employer bears,
 * and the percentage of a medical-surgical emergency. */
export const sickAccident = z.object({ employerDays: count, emergencyPercent: percent }).strict();
export type SickAccident = z.infer<typeof sickAccident>;
const code2 = z.string().regex(/^\d{2}$/);

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
    'ro.sick.codes',
    z.record(code2, sickCodeRule),
    'Codurile de indemnizație calculate: cine le suportă, dacă sunt impozabile, dacă intră în baza CASS și dacă se diminuează prima zi.',
  ),
  definition(
    'ro.sick.code.percent',
    z.record(code2, percent),
    'Procentul din baza de calcul al indemnizației pentru codurile cu procent unic (altele decât 01).',
  ),
  definition(
    'ro.sick.accident',
    sickAccident,
    'Accidentele de muncă și bolile profesionale: zilele suportate de angajator și procentul pentru urgențele medico-chirurgicale.',
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
 * Read in the consolidated OUG 158/2005 of 1 July 2026, from 2026: its amendment notes date every
 * change, and none of the articles read here changed in 2026 before 1 July (art. 17 alin. (1) and
 * (1^1) since 1 August 2025, alin. (1^2) from 1 July 2026, `OUG158/2005-A:modificari-2026`), so the
 * values hold for January 2026 too. Only OUG 91/2025 art. II starts later, for the certificates
 * issued from 1 February 2026: those issued in January lose no day, the employer bearing the
 * first five (art. 12 lit. A), as ANAF's D112 structure for 01–06/2026 declares them. The
 * reduction ends with 2027.
 */
const accident: SickCodeRule = {
  group: 'accident',
  payer: 'employer_then_pension_house',
  taxable: true,
  cass: false,
  reduced: false,
};
const incapacity = (cass: boolean): SickCodeRule => ({
  group: 'incapacity',
  payer: 'employer_then_fund',
  taxable: true,
  cass,
  reduced: true,
});

// The codes whose payer, tax, CASS and reduced day the stored texts settle: OUG nr. 158/2005
// (who bears each indemnity), OUG nr. 91/2025 art. II in its notes (the reduced day and its
// exceptions), the D112 structure (its codes, its own list of those exceptions and what FNUASS
// alone bears), the norms of 2018 and the Codul fiscal (art. 62 lit. c), art. 155 alin. (1) lit.
// i)). Isolation (51) keeps its day, as the D112 structure says, although art. II alin. (4)–(5)
// does not list it (`ro.sick.codes` review spec). Work accidents and occupational diseases
// (02–04) follow Legea nr. 346/2002: taxed as salary income (art. 76 alin. (1)), outside the
// CASS base and, for the state budget's part, the CAS base (art. 141 lit. a), norme pct. 41).
// The reduced working time (10, its own formula), the temporary transfer (11, not paid by
// FNUASS) and the supervision of a child in quarantine (92) are left out.
const sickCodes: Record<string, SickCodeRule> = {
  '01': incapacity(true),
  '02': accident,
  '03': accident,
  '04': accident,
  '05': incapacity(false),
  '06': incapacity(false),
  '12': incapacity(false),
  '13': incapacity(false),
  '14': incapacity(false),
  '16': incapacity(false),
  '51': { group: 'isolation', payer: 'fund', taxable: true, cass: false, reduced: false },
  '07': { group: 'quarantine', payer: 'fund', taxable: true, cass: true, reduced: true },
  '08': { group: 'maternity', payer: 'fund', taxable: false, cass: false, reduced: false },
  '09': { group: 'child_care', payer: 'fund', taxable: false, cass: false, reduced: true },
  '91': { group: 'child_care', payer: 'fund', taxable: false, cass: false, reduced: true },
  '15': { group: 'maternal_risk', payer: 'fund', taxable: false, cass: false, reduced: false },
  '17': { group: 'oncology_care', payer: 'fund', taxable: false, cass: false, reduced: false },
};
const sickCodeClauses = [
  'OUG158/2005-A:art.2(1)',
  'OUG158/2005-A:art.12',
  'OUG158/2005-A:art.20(3)',
  'OUG158/2005-A:art.22',
  'OUG158/2005-A:art.25',
  'OUG158/2005-A:art.26',
  'OUG158/2005-A:art.30^3',
  'OUG158/2005-A:art.31',
  'OUG158/2005-A:nota.OUG91-2025.art.II',
  'ANAF/D112-0726:sectiuneaD',
  'ANAF/D112-0726:exceptii-OUG91',
  'ANAF/Cod-fiscal-consolidat:art.62(c)',
  'ANAF/Cod-fiscal-consolidat:art.155(1)(i)',
  'L346/2002-A:art.34',
  'ANAF/Cod-fiscal-consolidat:norme.art.141.pct.41',
  'ANAF/D112-0726:accidente',
];

export const sickLeaveVersions: ParameterVersion[] = [
  version(
    'ro.sick.percent',
    { upTo7: '55', upTo14: '65', over15: '75' },
    ['OUG158/2005-A:art.17(1)', 'OUG158/2005-A:modificari-2026'],
    '2026-01-01',
  ),
  // Certificates issued in January 2026: none of the days is lost, the employer bears the first
  // five and FNUASS the rest (art. 12 lit. A–B); OUG nr. 91/2025 art. II applies from 1 February.
  version(
    'ro.sick.days',
    { unpaid: 0, employer: 5 },
    [
      'OUG158/2005-A:art.12',
      'OUG158/2005-A:nota.OUG91-2025.art.II',
      'OUG158/2005-A:modificari-2026',
      'ANAF/D112-0126:sectiuneaD',
    ],
    '2026-01-01',
    '2026-01-31',
  ),
  version(
    'ro.sick.days',
    { unpaid: 1, employer: 5 },
    ['OUG158/2005-A:nota.OUG91-2025.art.II', 'Norme-OUG158/2005:art.73'],
    '2026-02-01',
    '2027-12-31',
  ),
  version(
    'ro.sick.base_cap',
    '12',
    ['OUG158/2005-A:art.10(1)', 'OUG158/2005-A:modificari-2026', 'ANAF/D112-0126:plafon'],
    '2026-01-01',
  ),
  // Legea nr. 346/2002 as consolidated on 11.11.2024: the employer bears the first 3 days, the
  // state social insurance budget the rest (art. 34); 100% for a medical-surgical emergency (art.
  // 33 alin. (3)). Not reduced by a day: OUG nr. 91/2025 art. II is about the indemnities of OUG
  // nr. 158/2005.
  version(
    'ro.sick.accident',
    { employerDays: 3, emergencyPercent: '100' },
    ['L346/2002-A:art.34', 'L346/2002-A:art.33', 'L346/2002-A:art.19'],
    '2026-01-01',
  ),
  // January 2026: the same codes, none reduced (OUG nr. 91/2025 art. II from 1 February).
  version(
    'ro.sick.codes',
    Object.fromEntries(
      Object.entries(sickCodes).map(([code, rule]) => [code, { ...rule, reduced: false }]),
    ),
    [...sickCodeClauses, 'OUG158/2005-A:modificari-2026', 'ANAF/D112-0126:sectiuneaD'],
    '2026-01-01',
    '2026-01-31',
  ),
  version('ro.sick.codes', sickCodes, sickCodeClauses, '2026-02-01'),
  // The percentage of each code other than 01, read in the consolidated OUG nr. 158/2005: 100% for
  // the diseases of art. 17 alin. (2), for quarantine and isolation (art. 20 alin. (3)); 85% for
  // maternity (art. 25), child care (art. 30 alin. (1)) and the care of an oncological patient
  // (art. 30^3); 75% for cardiovascular diseases (art. 17 alin. (1^1)) and maternal risk (art. 31
  // alin. (4)). Each is applied to the base of art. 10.
  version(
    'ro.sick.code.percent',
    {
      '02': '80',
      '03': '80',
      '04': '80',
      '05': '100',
      '06': '100',
      '07': '100',
      '08': '85',
      '09': '85',
      '12': '100',
      '13': '75',
      '14': '100',
      '15': '75',
      '16': '100',
      '17': '85',
      '51': '100',
      '91': '85',
    },
    [
      'OUG158/2005-A:art.17(1^1)',
      'OUG158/2005-A:art.17(2)',
      'OUG158/2005-A:art.20(3)',
      'OUG158/2005-A:art.25',
      'OUG158/2005-A:art.30',
      'OUG158/2005-A:art.30^3',
      'OUG158/2005-A:art.31',
      'OUG158/2005-A:art.10(1)',
      'L346/2002-A:art.33',
      'OUG158/2005-A:modificari-2026',
    ],
    '2026-01-01',
  ),
];

/** The article of OUG nr. 158/2005 that sets each code's percentage and who bears it. */
const articleOf: Record<string, string> = {
  '01': 'OUG158/2005-A:art.17(1)',
  '02': 'L346/2002-A:art.33',
  '03': 'L346/2002-A:art.33',
  '04': 'L346/2002-A:art.33',
  '05': 'OUG158/2005-A:art.17(2)',
  '06': 'OUG158/2005-A:art.17(2)',
  '12': 'OUG158/2005-A:art.17(2)',
  '14': 'OUG158/2005-A:art.17(2)',
  '16': 'OUG158/2005-A:art.17(2)',
  '13': 'OUG158/2005-A:art.17(1^1)',
  '07': 'OUG158/2005-A:art.20(3)',
  '51': 'OUG158/2005-A:art.20(3)',
  '08': 'OUG158/2005-A:art.25',
  '09': 'OUG158/2005-A:art.30',
  '91': 'OUG158/2005-A:art.30',
  '17': 'OUG158/2005-A:art.30^3',
  '15': 'OUG158/2005-A:art.31',
};

/** Why a code is not calculated, for the codes the register leaves out. */
const uncovered: Record<string, string> = {
  '10': 'reducerea cu o pătrime a duratei de lucru (art. 19 alin. (3), o formulă proprie)',
  '11': 'trecerea temporară în altă muncă (nu se raportează la FNUASS)',
  '92': 'supravegherea copilului în carantină sau izolare: 100% din FNUASS (OUG nr. 158/2005 art. 30 alin. (2)), dar impozitarea și baza CASS a indemnizației nu sunt în registru',
};

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
  /** A work accident or occupational disease treated as a medical-surgical emergency: 100%
   * (Legea nr. 346/2002 art. 33 alin. (3)). */
  emergency?: boolean;
}

/** The base of the episode's first certificate (OUG 158/2005 art. 10): the insured incomes of the
 * last 6 months of the 12 before the episode's month, each capped at 12 minimum wages, and the
 * insured working days in them. For a work accident or occupational disease (Legea nr. 346/2002
 * art. 19 alin. (1), (4)): the monthly average of the gross salary income at the employer in the
 * 6 months before, uncapped, and the working days of the certificate's month. */
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
  /** How the code is paid and taxed. */
  rule: SickCodeRule;
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
 * The indemnity on one medical certificate (OUG 158/2005 art. 10, 12 and 17; OUG 91/2025 art. II):
 * the base's daily average times the code's percentage, for its working days, less the episode's
 * first working day where the code is reduced; the employer's days first and the fund's after them
 * for incapacity, the fund's alone for the codes it bears in full. What the texts leave open, and a
 * code whose rules or percentage are not in the register, comes back as an issue.
 */
export function sickIndemnity(
  certificate: SickCertificate,
  base: SickBase,
  episode: SickEpisode,
  rules: RuleContext,
): { result: SickResult | null; issues: { code: string; message: string }[] } {
  const issues: { code: string; message: string }[] = [];
  const param = <T>(key: string) =>
    rules.param<T>(key, 'medical_certificate_issue_date', certificate.issued);
  let rule: SickCodeRule | undefined;
  let codePercent: string | undefined;
  try {
    rule = param<Record<string, SickCodeRule>>('ro.sick.codes')[certificate.code];
    if (rule && certificate.code !== '01')
      codePercent = param<Record<string, string>>('ro.sick.code.percent')[certificate.code];
  } catch (error) {
    if (!(error instanceof RuleGapError)) throw error;
    return { result: null, issues: [{ code: 'RULE_GAP', message: error.message }] };
  }
  if (!rule)
    issues.push({
      code: 'SICK_CODE',
      message: uncovered[certificate.code]
        ? `Indemnizația cu codul ${certificate.code} (${uncovered[certificate.code]}) nu este calculată de aplicație.`
        : `Codul de indemnizație ${certificate.code} nu este în Nomenclatorul 9 al D112 sau nu este calculat.`,
    });
  else if (certificate.code !== '01' && !codePercent)
    issues.push({
      code: 'SICK_PERCENT',
      message: `Procentul indemnizației cu codul ${certificate.code} nu este în registrul de surse (ro.sick.code.percent).`,
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
  if (certificate.code === '01' && length === 15)
    issues.push({
      code: 'SICK_TIER',
      message:
        'Pentru un certificat de 15 zile, art. 17 alin. (1) nu stabilește procentul (65% până la 14 zile, 75% peste 15): stabiliți-l cu expertul contabil.',
    });
  if (issues.length || !rule) return { result: null, issues };

  try {
    let rate: string;
    const accidentRule =
      rule.payer === 'employer_then_pension_house' ? param<SickAccident>('ro.sick.accident') : null;
    if (certificate.code === '01') {
      const percents = param<SickPercents>('ro.sick.percent');
      rate = length <= 7 ? percents.upTo7 : length <= 14 ? percents.upTo14 : percents.over15;
    } else if (accidentRule && certificate.emergency) rate = accidentRule.emergencyPercent;
    else rate = codePercent!;
    const days = accidentRule
      ? { unpaid: 0, employer: accidentRule.employerDays }
      : param<SickDays>('ro.sick.days');
    const suspendedDays = workingDaysBetween(certificate.from, certificate.to);
    const unpaidDays =
      !rule.reduced || certificate.continuation || certificate.hospitalized || episode.reduced
        ? 0
        : Math.min(days.unpaid, suspendedDays.length);
    const paid = suspendedDays.length - unpaidDays;
    const employerDays =
      rule.payer === 'fund' ? 0 : Math.min(paid, Math.max(0, days.employer - episode.employerDays));
    const fundDays = paid - employerDays;
    const dailyAverage = base.income / BigInt(base.days);
    const clauses = accidentRule
      ? ['L346/2002-A:art.19']
      : ['OUG158/2005-A:art.10(1)', 'Norme-OUG158/2005:art.73'];
    const employer = indemnity(dailyAverage, rate, employerDays);
    const fund = indemnity(dailyAverage, rate, fundDays);
    const percentClauses = articleOf[certificate.code] ? [articleOf[certificate.code]!] : [];
    return {
      result: {
        days: suspendedDays.length,
        unpaidDays,
        employerDays,
        fundDays,
        dailyAverage,
        percent: rate,
        rule,
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
                  clauses: ['OUG158/2005-A:nota.OUG91-2025.art.II'],
                },
              ]
            : []),
          {
            code: 'sick.employer',
            amount: employer,
            clauses: [
              accidentRule ? 'L346/2002-A:art.34' : 'OUG158/2005-A:nota.OUG91-2025.art.II',
              ...percentClauses,
            ],
          },
          {
            code: 'sick.fund',
            amount: fund,
            clauses: [
              rule.payer === 'fund'
                ? 'ANAF/D112-0726:sectiuneaD'
                : accidentRule
                  ? 'L346/2002-A:art.34'
                  : 'OUG158/2005-A:art.12',
              ...percentClauses,
            ],
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
