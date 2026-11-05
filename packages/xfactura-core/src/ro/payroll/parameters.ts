import { z } from 'zod';
import type { ParameterDefinition, ParameterVersion } from '../../rules';
import { parseLocalDate as date } from '../../time';

const percent = z.string().regex(/^(0|[1-9]\d{0,2})(\.\d{1,4})?$/);
const lei = z.string().regex(/^(0|[1-9]\d*)$/);

export const deductionTable = z
  .object({
    /** The table covers gross incomes up to the minimum wage plus this many lei. */
    span: lei,
    /** Each row after the first covers this many lei more. */
    step: lei,
    /** Percentages of the minimum wage for 0, 1, 2, 3 and 4 or more dependents; the first row is
     * for incomes up to the minimum wage. */
    rows: z.array(z.tuple([percent, percent, percent, percent, percent])).min(1),
  })
  .strict();
export type DeductionTable = z.infer<typeof deductionTable>;

export const supplementaryDeduction = z.object({ youngPercent: percent, perChild: lei }).strict();
export type SupplementaryDeduction = z.infer<typeof supplementaryDeduction>;

export const minimumWageRelief = z
  .object({
    amount: lei,
    grossCeiling: lei,
    /** A base salary lowered on or after this date loses the relief. */
    baseFrozenSince: z.iso.date(),
  })
  .strict();
export type MinimumWageRelief = z.infer<typeof minimumWageRelief>;

/** The vehicle benefit: a percentage of the input value for each month (norme pct. 12 alin. (5)
 * lit. a)). */
export const carBenefit = z.object({ monthlyPercent: percent }).strict();
export type CarBenefit = z.infer<typeof carBenefit>;

/** The limits benefits in kind are measured against (art. 76 alin. (4) lit. a), (4^1)). */
export const benefitLimits = z
  .object({
    /** The monthly cap of the alin. (4^1) items together, as a percentage of the base salary. */
    capPercentOfBase: percent,
    /** Housing (alin. (4^1) lit. c)): a percentage of the minimum wage, per person and month. */
    housingPercentOfMinimum: percent,
    /** Gifts (alin. (4) lit. a)): lei per person and occasion. */
    giftPerOccasion: lei,
    /** Voluntary health insurance (alin. (4^1) lit. f)): euro per person and year. */
    healthEuroPerYear: lei,
  })
  .strict();
export type BenefitLimits = z.infer<typeof benefitLimits>;

/** The limits of Legea nr. 165/2018 on meal and holiday vouchers. */
export const voucherLimits = z
  .object({
    /** The meal voucher's maximum nominal value, in lei; one voucher per day worked. */
    mealNominal: lei,
    /** The maximum is only the floor of an indexation the register does not hold (art. 32): a
     * meal voucher above it is not known to exceed the law. */
    mealFloorOnly: z.boolean(),
    /** Holiday vouchers an employee may receive in a fiscal year, in minimum wages. */
    holidayMinimumWages: z.string().regex(/^[1-9]\d?$/),
  })
  .strict();
export type VoucherLimits = z.infer<typeof voucherLimits>;

const fraction = z.tuple([z.number().int().min(1), z.number().int().min(1)]);
/** The share of the net monthly income a garnishment may take (Codul de procedură civilă art.
 * 729) and what the Labour Code allows together (art. 169). */
export const garnishmentLimits = z
  .object({
    maintenance: fraction,
    other: fraction,
    several: fraction,
    cumulative: fraction,
  })
  .strict();
export type GarnishmentLimits = z.infer<typeof garnishmentLimits>;

const rate = (key: string, description: string): ParameterDefinition => ({
  key,
  axis: 'payroll_month_start',
  continuity: 'block',
  scope: [],
  value: percent,
  description,
});

export const payrollDefinitions: ParameterDefinition[] = [
  rate('ro.payroll.income_tax.rate', 'Cota impozitului pe veniturile din salarii.'),
  rate('ro.payroll.cas.rate', 'Cota CAS datorate de angajat, în condiții normale de muncă.'),
  rate('ro.payroll.cass.rate', 'Cota CASS datorate de angajat.'),
  rate(
    'ro.payroll.cam.rate',
    'Cota contribuției asiguratorii pentru muncă, datorate de angajator.',
  ),
  {
    key: 'ro.payroll.minimum_wage',
    axis: 'payroll_month_start',
    continuity: 'block',
    scope: [],
    value: lei,
    description:
      'Salariul de bază minim brut pe țară garantat în plată, pentru norma întreagă, în lei.',
  },
  {
    key: 'ro.payroll.personal_deduction',
    axis: 'payroll_month_start',
    continuity: 'block',
    scope: [],
    value: deductionTable,
    description: 'Tabelul deducerii personale de bază, în procente din salariul minim.',
  },
  {
    key: 'ro.payroll.supplementary_deduction',
    axis: 'payroll_month_start',
    continuity: 'block',
    scope: [],
    value: supplementaryDeduction,
    description:
      'Deducerea personală suplimentară: procentul din salariul minim până la 26 de ani și suma pentru fiecare copil înscris la școală.',
  },
  {
    key: 'ro.payroll.minimum_wage_relief',
    axis: 'payroll_month_start',
    continuity: 'block',
    scope: [],
    value: minimumWageRelief,
    description:
      'Suma care nu se include în bazele de calcul pentru salariații plătiți cu salariul minim, și plafonul venitului brut până la care se acordă.',
  },
  {
    key: 'ro.payroll.benefit.car',
    axis: 'payroll_month_start',
    continuity: 'block',
    scope: [],
    value: carBenefit,
    description:
      'Evaluarea folosinței gratuite a vehiculului în scop personal: procentul lunar din valoarea de intrare.',
  },
  {
    key: 'ro.payroll.benefit.limits',
    axis: 'payroll_month_start',
    continuity: 'block',
    scope: [],
    value: benefitLimits,
    description:
      'Limitele avantajelor: plafonul lunar de 33% din salariul de bază, cazarea (20% din salariul minim), cadourile (300 lei pe ocazie) și asigurarea voluntară de sănătate (400 euro pe an).',
  },
  {
    key: 'ro.payroll.voucher.limits',
    axis: 'payroll_month_start',
    continuity: 'block',
    scope: [],
    value: voucherLimits,
    description:
      'Limitele biletelor de valoare: valoarea nominală maximă a tichetului de masă (un tichet pe zi lucrată) și plafonul anual al voucherelor de vacanță, în salarii minime.',
  },
  {
    key: 'ro.payroll.mandate.deduction',
    axis: 'payroll_month_start',
    continuity: 'block',
    scope: [],
    value: z.enum(['main_job_declared']),
    description:
      'Deducerea personală pentru remunerația administratorului cu contract de mandat: doar când persoana declară acolo funcția de bază.',
  },
  {
    key: 'ro.payroll.correction.retroactive',
    axis: 'payroll_month_start',
    continuity: 'block',
    scope: [],
    value: z.enum(['recompute_month']),
    description:
      'Corectarea unei luni închise pentru o modificare retroactivă a contractului: luna se recalculează și D112 se rectifică.',
  },
  {
    key: 'ro.garnishment.limits',
    axis: 'payroll_month_start',
    continuity: 'block',
    scope: [],
    value: garnishmentLimits,
    description:
      'Partea din venitul lunar net care poate fi urmărită prin poprire: pentru întreținere, pentru alte datorii, pentru mai multe urmăriri, și reținerile cumulate.',
  },
  {
    key: 'ro.deadline.reges.start',
    axis: 'payroll_month_start',
    continuity: 'block',
    scope: [],
    value: z.object({ daysBefore: z.number().int().min(0).max(31), since: z.iso.date() }).strict(),
    description:
      'Termenul de transmitere a contractului individual de muncă în REGES-ONLINE (zile înainte de începerea activității) și data de la care registrul este REGES-ONLINE, nu Revisal.',
  },
  {
    key: 'ro.deadline.reges.change',
    axis: 'payroll_month_start',
    continuity: 'block',
    scope: [],
    value: z
      .object({
        daysBefore: z.number().int().min(0).max(31),
        salaryWorkingDays: z.number().int().min(1).max(60),
      })
      .strict(),
    description:
      'Termenul de transmitere în REGES-ONLINE a unei modificări a contractului: zile înainte de producerea modificării funcției, duratei sau timpului de muncă și zile lucrătoare după modificarea salariului.',
  },
  {
    key: 'ro.deadline.reges.end',
    axis: 'payroll_month_start',
    continuity: 'block',
    scope: [],
    value: z.object({ daysBefore: z.number().int().min(0).max(31) }).strict(),
    description:
      'Termenul de transmitere în REGES-ONLINE a încetării contractului individual de muncă: zile înainte de data încetării (0: cel târziu la data încetării).',
  },
  {
    key: 'ro.payroll.tax_base_rounding',
    axis: 'payroll_month_start',
    continuity: 'block',
    scope: [],
    value: z.enum(['leu_half_down']),
    description:
      'Rotunjirea bazei de calcul al impozitului la leu (până la 50 de bani inclusiv se neglijează).',
  },
  {
    key: 'ro.payroll.amount_rounding',
    axis: 'payroll_month_start',
    continuity: 'block',
    scope: [],
    value: z.enum(['leu_half_up']),
    description:
      'Rotunjirea contribuțiilor și a impozitului la leu (de la 50 de bani prin majorare).',
  },
];

const code = (clause: string) => `ANAF/Cod-fiscal-consolidat:${clause}`;

/**
 * The values read in ANAF's consolidated Fiscal Code apply from 2026-01-01: the snapshot shows
 * them in force, not since when, so earlier months are a gap until the texts then in force are
 * sourced. The minimum wage and its relief cite texts still to be obtained.
 */
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

export const payrollVersions: ParameterVersion[] = [
  version('ro.payroll.income_tax.rate', '10', [code('art.64(1)(b)'), code('art.78(2)(a)')]),
  version('ro.payroll.cas.rate', '25', [code('art.138(a)')]),
  version('ro.payroll.cass.rate', '10', [code('art.156')]),
  version('ro.payroll.cam.rate', '2.25', [code('art.220^3(1)')]),
  version('ro.payroll.minimum_wage', '4050', ['HG1506/2024:art.1'], '2025-01-01', '2025-12-31'),
  version(
    'ro.payroll.minimum_wage',
    '4050',
    ['HG1506/2024:art.1', 'ANAF/D112-0726:salariul-minim'],
    '2026-01-01',
    '2026-06-30',
  ),
  version(
    'ro.payroll.minimum_wage',
    '4325',
    ['HG146/2026:art.1', 'ANAF/D112-0726:salariul-minim'],
    '2026-07-01',
  ),
  version(
    'ro.payroll.personal_deduction',
    {
      span: '2000',
      step: '50',
      rows: [
        ['20', '25', '30', '35', '45'],
        ['19.5', '24.5', '29.5', '34.5', '44.5'],
        ['19', '24', '29', '34', '44'],
        ['18.5', '23.5', '28.5', '33.5', '43.5'],
        ['18', '23', '28', '33', '43'],
        ['17.5', '22.5', '27.5', '32.5', '42.5'],
        ['17', '22', '27', '32', '42'],
        ['16.5', '21.5', '26.5', '31.5', '41.5'],
        ['16', '21', '26', '31', '41'],
        ['15.5', '20.5', '25.5', '30.5', '40.5'],
        ['15', '20', '25', '30', '40'],
        ['14.5', '19.5', '24.5', '29.5', '39.5'],
        ['14', '19', '24', '29', '39'],
        ['13.5', '18.5', '23.5', '28.5', '38.5'],
        ['13', '18', '23', '28', '38'],
        ['12.5', '17.5', '22.5', '27.5', '37.5'],
        ['12', '17', '22', '27', '37'],
        ['11.5', '16.5', '21.5', '26.5', '36.5'],
        ['11', '16', '21', '26', '36'],
        ['10.5', '15.5', '20.5', '25.5', '35.5'],
        ['10', '15', '20', '25', '35'],
        ['9.5', '14.5', '19.5', '24.5', '34.5'],
        ['9', '14', '19', '24', '34'],
        ['8.5', '13.5', '18.5', '23.5', '33.5'],
        ['8', '13', '18', '23', '33'],
        ['7.5', '12.5', '17.5', '22.5', '32.5'],
        ['7', '12', '17', '22', '32'],
        ['6.5', '11.5', '16.5', '21.5', '31.5'],
        ['6', '11', '16', '21', '31'],
        ['5.5', '10.5', '15.5', '20.5', '30.5'],
        ['5', '10', '15', '20', '30'],
        ['4.5', '9.5', '14.5', '19.5', '29.5'],
        ['4', '9', '14', '19', '29'],
        ['3.5', '8.5', '13.5', '18.5', '28.5'],
        ['3', '8', '13', '18', '28'],
        ['2.5', '7.5', '12.5', '17.5', '27.5'],
        ['2', '7', '12', '17', '27'],
        ['1.5', '6.5', '11.5', '16.5', '26.5'],
        ['1', '6', '11', '16', '26'],
        ['0.5', '5.5', '10.5', '15.5', '25.5'],
        ['0', '5', '10', '15', '25'],
      ],
    },
    [code('art.77')],
  ),
  version('ro.payroll.supplementary_deduction', { youngPercent: '15', perChild: '100' }, [
    code('art.77'),
  ]),
  version(
    'ro.payroll.minimum_wage_relief',
    { amount: '300', grossCeiling: '4300', baseFrozenSince: '2024-12-31' },
    ['OUG156/2024:art.LXVI'],
    '2025-01-01',
    '2025-12-31',
  ),
  version(
    'ro.payroll.minimum_wage_relief',
    { amount: '300', grossCeiling: '4300', baseFrozenSince: '2025-12-24' },
    ['OUG89/2025:art.III', 'ANAF/D112-0726:salariul-minim'],
    '2026-01-01',
    '2026-06-30',
  ),
  version(
    'ro.payroll.minimum_wage_relief',
    { amount: '200', grossCeiling: '4600', baseFrozenSince: '2025-12-24' },
    ['OUG89/2025:art.III', 'ANAF/D112-0726:salariul-minim'],
    '2026-07-01',
    '2026-12-31',
  ),
  version('ro.payroll.benefit.car', { monthlyPercent: '1.7' }, [
    code('norme.art.76.pct.12(5)'),
    code('norme.art.76.pct.12(6)'),
    code('art.76(3)(a)'),
    code('art.76(4)(ț)'),
    code('art.76(4)(ț1)'),
  ]),
  version(
    'ro.payroll.benefit.limits',
    {
      capPercentOfBase: '33',
      housingPercentOfMinimum: '20',
      giftPerOccasion: '300',
      healthEuroPerYear: '400',
    },
    [
      code('art.76(4^1)'),
      code('art.76(4^1)(c)'),
      code('art.76(4^1)(f)'),
      code('art.76(4)(a)'),
      code('art.142(b)'),
    ],
  ),
  // Legea nr. 165/2018: 45 lei a meal voucher from November 2025, kept through September 2026 by
  // Legea nr. 201/2025 art. II; from October 2026 the joint order of art. 32 may index it, and the
  // register holds none, so 45 lei is only its floor (art. 32 alin. (2)). An excess over these
  // limits is not a voucher granted "potrivit legii" (art. 76 alin. (3) lit. h), art. 142 lit. r))
  // but a benefit in every base (`ro.payroll.voucher.limits` review spec).
  version(
    'ro.payroll.voucher.limits',
    { mealNominal: '45', mealFloorOnly: false, holidayMinimumWages: '6' },
    ['L165/2018-A:art.14', 'L165/2018-A:art.12(2)', 'L165/2018-A:art.24(3)', code('art.76(3)(h)')],
    '2025-11-01',
    '2026-09-30',
  ),
  version(
    'ro.payroll.voucher.limits',
    { mealNominal: '45', mealFloorOnly: true, holidayMinimumWages: '6' },
    [
      'L165/2018-A:art.14',
      'L165/2018-A:art.32',
      'L165/2018-A:art.12(2)',
      'L165/2018-A:art.24(3)',
      code('art.76(3)(h)'),
    ],
    '2026-10-01',
  ),
  version('ro.payroll.mandate.deduction', 'main_job_declared', [
    code('art.77'),
    code('art.78(2)(a)'),
    code('art.78(2)(b)'),
    code('norme.art.78.pct.14(9)'),
  ]),
  version('ro.payroll.correction.retroactive', 'recompute_month', [
    code('art.76(1)'),
    code('art.78(3)'),
    code('art.146(9^1)'),
    'OPANAF605/2026:anexa6.cap.II.pct.2',
  ]),
  // Read in the codes as the legislative portal consolidates them: the Codul de procedură civilă
  // of 14.12.2025 (art. 729, the same limits as the 2013 text's art. 728) and the Codul muncii of
  // 27.04.2026 (art. 169).
  version(
    'ro.garnishment.limits',
    { maintenance: [1, 2], other: [1, 3], several: [1, 2], cumulative: [1, 2] },
    ['L134/2010-A:art.729', 'L53/2003-A:art.169', 'L207/2015:art.236'],
  ),
  // HG nr. 295/2025: the contract by the day before the work starts (art. 5 alin. (1) lit. a)), as
  // the Codul muncii says; Revisal ended with 2025 (art. 15, OUG nr. 46/2025). A change of the
  // occupation, the duration or the working time by the day before it takes effect, of the
  // salary within 20 working days (art. 5 alin. (3)–(4)); the end at the latest on its date (art.
  // 5 alin. (1) lit. f)). A change ordered by a court has 10 working days from when the employer
  // learned of it, which the engine does not know.
  version('ro.deadline.reges.start', { daysBefore: 1, since: '2026-01-01' }, [
    'L53/2003-A:art.16(2)',
    'HG295/2025-A:art.5(1)',
    'HG295/2025-A:art.15',
    'ITM/REGES-2026:comunicat',
  ]),
  version('ro.deadline.reges.change', { daysBefore: 1, salaryWorkingDays: 20 }, [
    'HG295/2025-A:art.5(2)-(4)',
    'HG295/2025-A:art.4(2)',
  ]),
  version('ro.deadline.reges.end', { daysBefore: 0 }, [
    'HG295/2025-A:art.5(1)',
    'HG295/2025-A:art.4(2)',
  ]),
  version('ro.payroll.tax_base_rounding', 'leu_half_down', [code('norme.art.64.pct.4')]),
  version('ro.payroll.amount_rounding', 'leu_half_up', ['OUG59/2005:art.1(1)']),
];
