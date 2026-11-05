import { z } from 'zod';
import type { ParameterDefinition, ParameterVersion } from '../../rules';
import { parseLocalDate as date } from '../../time';

/*
 * The profit tax of a Romanian legal person (Codul fiscal title II), as ANAF's consolidated text
 * reads it (snapshot ANAF/Cod-fiscal-consolidat, updated to Legea nr. 204/2026), with the changes
 * of OUG nr. 8/2026 read in its own text (snapshot OUG8/2026). Every value is `extracted`: cited,
 * not reviewed. Versions start on 1 January 2026 unless the text dates them otherwise; earlier
 * years are a rule gap, never a fallback.
 */

const code = (clause: string) => `ANAF/Cod-fiscal-consolidat:${clause}`;
const percent = z.string().regex(/^(0|[1-9]\d{0,2})(\.\d{1,4})?$/);
const lei = z.string().regex(/^(0|[1-9]\d{0,15})$/);

/** The degressive coefficient for a normal life up to `maxYears` (null: above the last). */
export const degressiveSchema = z
  .array(z.object({ maxYears: z.number().int().min(1).nullable(), factor: percent }).strict())
  .min(1);

export const depreciationRules = z
  .object({
    /** Art. 28 alin. (7): the linear rate multiplied by 1.5 (2–5 years), 2.0 (6–10), 2.5 (>10). */
    degressive: degressiveSchema,
    /** The shortest normal life the degressive method has a coefficient for, in years. */
    degressiveMinYears: z.number().int().min(1),
    /** Art. 28 alin. (8): the accelerated method deducts at most this share of the fiscal value in
     * the first year of use, then the rest linearly over the life remaining. */
    acceleratedFirstYear: percent,
    /** Art. 28 alin. (14): depreciation of an M1 passenger car is deductible up to this many lei
     * a month; at its disposal, the value left up to the same amount times the months left (norme
     * pct. 27). */
    m1MonthlyCap: lei,
    /** Art. 28 alin. (9): software is depreciated over this many months. */
    softwareMonths: z.number().int().min(1),
  })
  .strict();
export type DepreciationRules = z.infer<typeof depreciationRules>;

export const superAccelerated = z
  .object({
    /** Art. 28 alin. (8^1): at most this share in the first year. */
    firstYear: percent,
    /** The catalogue's subgroups it is allowed for (2.1 equipment, 2.4 animals and plantations). */
    subgroups: z.array(z.string().regex(/^\d\.\d{1,2}$/)).min(1),
  })
  .strict();
export type SuperAccelerated = z.infer<typeof superAccelerated>;

export const sponsorshipLimits = z
  .object({
    /** Art. 25 alin. (4) lit. i) pct. 1: the share of the turnover. */
    turnover: percent,
    /** Pct. 2: the share of the profit tax owed. */
    tax: percent,
  })
  .strict();
export type SponsorshipLimits = z.infer<typeof sponsorshipLimits>;

export const legalReserveLimits = z
  .object({
    /** Art. 26 alin. (1) lit. a): the share of the accounting profit plus the profit tax expense. */
    rate: percent,
    /** Until the reserve reaches this share of the subscribed and paid-in capital. */
    capitalShare: percent,
  })
  .strict();
export type LegalReserveLimits = z.infer<typeof legalReserveLimits>;

export const receivableImpairment = z
  .object({
    /** Art. 26 alin. (1) lit. c): the deductible share of the impairment adjustments. */
    share: percent,
    /** Unpaid for more than this many days after the due date. */
    overdueDays: z.number().int().min(1),
  })
  .strict();
export type ReceivableImpairment = z.infer<typeof receivableImpairment>;

export const lossCarryforward = z
  .object({
    /** Art. 31 alin. (1), (7), (8): the share of the taxable profit losses recover. */
    share: percent,
    /** The consecutive years after the loss's year it may be recovered in. */
    years: z.number().int().min(1).max(20),
  })
  .strict();
export type LossCarryforward = z.infer<typeof lossCarryforward>;

export const minimumTax = z
  .object({
    /** Art. 18^1 alin. (1): the previous year's turnover above which the minimum turnover tax
     * applies, in euro at the rate of that year's close. */
    turnoverEur: lei,
  })
  .strict();
export type MinimumTax = z.infer<typeof minimumTax>;

export const interestCeiling = z
  .object({
    /** Art. 40^2 alin. (4): the exceeding borrowing costs deductible in any case, in euro. */
    totalEur: lei,
    /** The lower ceiling for costs from affiliated persons. */
    affiliatedEur: lei,
  })
  .strict();
export type InterestCeiling = z.infer<typeof interestCeiling>;

export const profitDefinitions: ParameterDefinition[] = [
  {
    key: 'ro.profit.rate',
    axis: 'reporting_period_start',
    continuity: 'block',
    scope: [],
    value: percent,
    description: 'Cota impozitului pe profit (art. 17 din Codul fiscal).',
  },
  {
    key: 'ro.profit.protocol_limit',
    axis: 'reporting_period_start',
    continuity: 'block',
    scope: [],
    value: percent,
    description:
      'Limita cheltuielilor de protocol: procent din profitul contabil la care se adaugă cheltuielile cu impozitul pe profit și cele de protocol (art. 25 alin. (3) lit. a)).',
  },
  {
    key: 'ro.profit.social_limit',
    axis: 'reporting_period_start',
    continuity: 'block',
    scope: [],
    value: percent,
    description:
      'Limita cheltuielilor sociale: procent din cheltuielile cu salariile personalului (art. 25 alin. (3) lit. b)).',
  },
  {
    key: 'ro.profit.vehicle_share',
    axis: 'reporting_period_start',
    continuity: 'block',
    scope: [],
    value: percent,
    description:
      'Partea nedeductibilă a cheltuielilor cu vehiculele rutiere motorizate folosite și în alte scopuri decât activitatea economică (art. 25 alin. (3) lit. l)).',
  },
  {
    key: 'ro.profit.sponsorship',
    axis: 'reporting_period_start',
    continuity: 'block',
    scope: [],
    value: sponsorshipLimits,
    description:
      'Limitele sponsorizării scăzute din impozitul pe profit: procent din cifra de afaceri și procent din impozitul pe profit (art. 25 alin. (4) lit. i)).',
  },
  {
    key: 'ro.profit.legal_reserve',
    axis: 'reporting_period_start',
    continuity: 'block',
    scope: [],
    value: legalReserveLimits,
    description:
      'Limita rezervei legale deductibile și plafonul ei față de capitalul social (art. 26 alin. (1) lit. a)).',
  },
  {
    key: 'ro.profit.receivables',
    axis: 'reporting_period_start',
    continuity: 'block',
    scope: [],
    value: receivableImpairment,
    description:
      'Partea deductibilă a ajustărilor pentru deprecierea creanțelor neîncasate peste termen (art. 26 alin. (1) lit. c)).',
  },
  {
    key: 'ro.profit.loss_carryforward',
    axis: 'fiscal_year_start',
    continuity: 'block',
    scope: [],
    value: lossCarryforward,
    description:
      'Recuperarea pierderilor fiscale, după anul în care s-au înregistrat: procentul din profitul impozabil și numărul de ani (art. 31).',
  },
  {
    key: 'ro.profit.depreciation',
    axis: 'fiscal_year_start',
    continuity: 'block',
    scope: [],
    value: depreciationRules,
    description:
      'Metodele amortizării fiscale: coeficienții regimului degresiv, limita primului an la regimul accelerat, plafonul lunar al autoturismelor M1 și durata programelor informatice (art. 28).',
  },
  {
    key: 'ro.profit.superaccelerated',
    axis: 'asset_commissioning_date',
    continuity: 'block',
    scope: [],
    value: superAccelerated,
    description:
      'Amortizarea superaccelerată a activelor noi din subgrupele 2.1 și 2.4 puse în funcțiune în 2026 (art. 28 alin. (8^1)).',
  },
  {
    key: 'ro.profit.asset_threshold',
    axis: 'asset_commissioning_date',
    continuity: 'block',
    scope: [],
    value: lei,
    description:
      'Valoarea fiscală de la care o imobilizare corporală este mijloc fix amortizabil, la data intrării în patrimoniu (art. 28 alin. (2) lit. b)).',
  },
  {
    key: 'ro.profit.minimum_tax',
    axis: 'fiscal_year_start',
    continuity: 'block',
    scope: [],
    value: minimumTax,
    description:
      'Pragul cifrei de afaceri a anului precedent de la care se aplică impozitul minim pe cifra de afaceri (art. 18^1).',
  },
  {
    key: 'ro.profit.interest_ceiling',
    axis: 'reporting_period_start',
    continuity: 'block',
    scope: [],
    value: interestCeiling,
    description:
      'Plafonul costurilor excedentare ale îndatorării deductibile într-o perioadă fiscală (art. 40^2 alin. (4)).',
  },
];

const version = (
  key: string,
  value: ParameterVersion['value'],
  clauses: string[],
  from = '2026-01-01',
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

export const profitVersions: ParameterVersion[] = [
  version('ro.profit.rate', '16', [code('art.17')]),
  version('ro.profit.protocol_limit', '2', [code('art.25(3)(a)')]),
  version('ro.profit.social_limit', '5', [code('art.25(3)(b)')]),
  version('ro.profit.vehicle_share', '50', [code('art.25(3)(l)'), code('norme.art.25.pct.16')]),
  version('ro.profit.sponsorship', { turnover: '0.75', tax: '20' }, [code('art.25(4)(i)')]),
  version('ro.profit.legal_reserve', { rate: '5', capitalShare: '20' }, [
    code('art.26(1)(a)'),
    code('norme.art.26.pct.19(1)'),
  ]),
  version('ro.profit.receivables', { share: '30', overdueDays: 270 }, [
    code('art.26(1)(c)'),
    code('art.26(12)'),
  ]),
  // Losses of 2016–2023 left at 31.12.2023: 70% of the profits from 2024, over what remains of
  // their 7 years (alin. (7)); losses from 2024: 70%, 5 years (alin. (1)). Both are cumulated for
  // the 70% (alin. (8)).
  version(
    'ro.profit.loss_carryforward',
    { share: '70', years: 7 },
    [code('art.31(7)-(8)')],
    '2016-01-01',
    '2023-12-31',
  ),
  version(
    'ro.profit.loss_carryforward',
    { share: '70', years: 5 },
    [code('art.31(1)'), code('art.31(7)-(8)')],
    '2024-01-01',
  ),
  version(
    'ro.profit.depreciation',
    {
      degressive: [
        { maxYears: 5, factor: '1.5' },
        { maxYears: 10, factor: '2.0' },
        { maxYears: null, factor: '2.5' },
      ],
      degressiveMinYears: 2,
      acceleratedFirstYear: '50',
      m1MonthlyCap: '1500',
      softwareMonths: 36,
    },
    [code('art.28'), code('norme.art.28.pct.25-27')],
  ),
  version(
    'ro.profit.superaccelerated',
    { firstYear: '65', subgroups: ['2.1', '2.4'] },
    [code('art.28(8^1)-(8^2)'), 'OUG8/2026:art.6.pct.8'],
    '2026-01-01',
    '2026-12-31',
  ),
  // 5,000 lei from 2026 (OUG nr. 8/2026); assets of 2,500–5,000 lei held at 31.12.2025 keep
  // their depreciation (art. 45 alin. (21^3)). The limit before 2026 is not read: a gap.
  version('ro.profit.asset_threshold', '5000', [code('art.28(2)(b)'), 'OUG8/2026:art.6.pct.7']),
  // The minimum turnover tax applies until 31.12.2026 (alin. (17)); 2027 is a gap until the
  // rollover reads its repeal.
  version(
    'ro.profit.minimum_tax',
    { turnoverEur: '50000000' },
    [code('art.18^1(1),(17)')],
    '2024-01-01',
    '2026-12-31',
  ),
  version('ro.profit.interest_ceiling', { totalEur: '1000000', affiliatedEur: '500000' }, [
    code('art.40^2(4)'),
  ]),
];

/**
 * The deadlines of the profit tax and of the regime's changes, as `ro.deadline.*` versions (their
 * definitions come with the obligation kinds, `src/ro/obligations.ts`).
 */
export const profitDeadlineVersions: ParameterVersion[] = [
  // Quarters I–III of the quarterly system: the 25th of the month after the quarter.
  version('ro.deadline.D100.profit', { kind: 'next_month_day', day: 25 }, [code('art.41(1)')]),
  // The annual return: 25 June of the next year (art. 42 alin. (1) as OUG nr. 8/2026 art. 6 pct.
  // 12 rewrote it), from the return for 2026 (art. 45 alin. (21^4)).
  version('ro.deadline.D101', { kind: 'next_year_date', month: 6, day: 25 }, [
    code('art.42(1)'),
    'OUG8/2026:art.6.pct.12,14',
  ]),
  // Entering the micro-enterprise regime on 1 January: by 31 March of that year (art. 55
  // alin. (2)); the calendar counts it from the previous year, so the versions start with the
  // last year a company could leave or enter from (2025), read in the current consolidation.
  version(
    'ro.deadline.D700.micro_entry',
    { kind: 'next_year_date', month: 3, day: 31 },
    [code('art.55(2)')],
    '2025-01-01',
  ),
  // Leaving it during the year (art. 52): by 31 March of the next year (art. 55 alin. (5)).
  version(
    'ro.deadline.D700.micro_exit',
    { kind: 'next_year_date', month: 3, day: 31 },
    [code('art.55(1),(5)')],
    '2025-01-01',
  ),
  // Leaving it from 1 January (conditions failed at the previous year's end, or the option): "by
  // 31 March of the following fiscal year" reads as the year it leaves in or the one after. Both
  // readings, counted from the last micro year; the earlier to file by.
  version(
    'ro.deadline.D700.micro_exit_january',
    {
      kind: 'conflict',
      readings: [
        {
          deadline: { kind: 'next_year_date', month: 3, day: 31 },
          clauses: [code('art.55(1),(5)')],
          text: 'Codul fiscal, art. 55 alin. (5): ieșirea se comunică până la 31 martie a anului fiscal următor ultimului an de microîntreprindere, adică anul în care se plătește impozit pe profit (ca la intrare, alin. (2)).',
        },
        {
          deadline: { kind: 'next_year_date', month: 3, day: 31, years: 2 },
          clauses: [code('art.55(1),(5)')],
          text: 'Codul fiscal, art. 55 alin. (5), citit literal: până la 31 martie a anului fiscal următor celui în care microîntreprinderea a devenit plătitoare de impozit pe profit.',
        },
      ],
    },
    [code('art.55(1),(5)')],
    '2025-01-01',
  ),
];
