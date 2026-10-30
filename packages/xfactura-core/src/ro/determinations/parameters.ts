import { z } from 'zod';
import type { ParameterDefinition, ParameterVersion } from '../../rules';
import { parseLocalDate as date } from '../../time';

/*
 * The legal values the yearly determinations read (docs/ACCOUNTING_ENGINE.md, Determinations):
 * the size criteria and the two-year rule, the VAT period's limit, the small-enterprise VAT
 * exemption threshold, the quarterly D112 conditions and the micro-enterprise employee and
 * linked-enterprise rules. Every version is `extracted`: an expert contabil reviews it.
 */

const lei = z.string().regex(/^[1-9]\d{0,15}$/);
const euro = z.string().regex(/^[1-9]\d*$/);
const criteria = z
  .object({
    /** Total assets (balance sheet A–C), in lei. */
    assets: lei,
    /** Net turnover, in lei. */
    turnover: lei,
    /** Average number of employees in the financial year. */
    employees: z.number().int().min(1).max(10_000),
  })
  .strict();
export type SizeCriteria = z.infer<typeof criteria>;

const sizeThresholds = z
  .object({
    /** A microentity does not exceed two of these at the balance sheet date. */
    micro: criteria,
    /** A small entity is not a microentity and does not exceed two of these. */
    small: criteria,
    /** Above two of these in two consecutive years, the statements are audited. */
    audit: criteria,
    /** How many consecutive financial years it takes to change category. */
    consecutiveYears: z.number().int().min(1).max(5),
  })
  .strict();
export type SizeThresholds = z.infer<typeof sizeThresholds>;

const payrollQuarterly = z
  .object({
    /** Art. 80 alin. (2) lit. b): the previous year's total revenues, in euro. */
    revenueLimitEur: euro,
    /** Art. 80 alin. (2) lit. b)–c): an average below this many employees ("până la 3 salariați
     * exclusiv"). */
    employeesBelow: z.number().int().min(1).max(100),
  })
  .strict();
export type PayrollQuarterly = z.infer<typeof payrollQuarterly>;

const microEmployee = z
  .object({
    /** Full-time equivalents the condition of art. 47 alin. (1) lit. g) needs. */
    fte: z.string().regex(/^\d+(\.\d{1,2})?$/),
    /** Days within which a micro-enterprise with one employee replaces a contract that ended
     * (art. 52 alin. (3)). */
    replacementDays: z.number().int().min(1).max(366),
    /** Days a newly registered company has to hire (art. 48 alin. (3)). */
    newCompanyDays: z.number().int().min(1).max(366),
  })
  .strict();
export type MicroEmployee = z.infer<typeof microEmployee>;

const microLinked = z
  .object({
    /** Linked enterprises: holdings above this share (art. 47 alin. (1^1)). */
    holdingAbovePct: z.string().regex(/^\d{1,2}$/),
    /** The share of a linked individual enterprise's yearly income norm counted during the year
     * (art. 52 alin. (5^2): "o pătrime"). */
    normaShare: z.string().regex(/^0\.\d{1,4}$/),
  })
  .strict();
export type MicroLinked = z.infer<typeof microLinked>;

export const determinationDefinitions: ParameterDefinition[] = [
  {
    key: 'ro.size.thresholds',
    axis: 'fiscal_year_start',
    continuity: 'block',
    scope: [],
    value: sizeThresholds,
    description:
      'Criteriile de mărime ale microentităților și ale entităților mici, pragurile auditului statutar și numărul de exerciții consecutive după care se schimbă categoria.',
  },
  {
    key: 'ro.vat.period.limit_eur',
    axis: 'reporting_period_start',
    continuity: 'block',
    scope: [],
    value: euro,
    description:
      'Plafonul cifrei de afaceri din anul precedent, în euro, până la care perioada fiscală de TVA este trimestrul calendaristic.',
  },
  {
    key: 'ro.vat.exemption.threshold',
    axis: 'reporting_period_start',
    continuity: 'block',
    scope: [],
    value: lei,
    description:
      'Plafonul de scutire al întreprinderilor mici (regimul special de scutire), în lei.',
  },
  {
    key: 'ro.payroll.quarterly',
    axis: 'reporting_period_start',
    continuity: 'block',
    scope: [],
    value: payrollQuarterly,
    description:
      'Condițiile în care plătitorii de salarii plătesc impozitul și depun declarația 112 trimestrial.',
  },
  {
    key: 'ro.micro.employee',
    axis: 'reporting_period_start',
    continuity: 'block',
    scope: [],
    value: microEmployee,
    description:
      'Condiția salariatului pentru microîntreprinderi: norma întreagă cerută, termenul de înlocuire a salariatului și termenul unei persoane juridice nou-înființate.',
  },
  {
    key: 'ro.micro.linked',
    axis: 'reporting_period_start',
    continuity: 'block',
    scope: [],
    value: microLinked,
    description:
      'Întreprinderile legate ale unei microîntreprinderi: pragul deținerii și partea din norma anuală de venit cumulată în cursul anului.',
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
const code = (clause: string) => `ANAF/Cod-fiscal-consolidat:${clause}`;

/**
 * As the texts read on 30.10.2026 give them. The Fiscal Code values are read in ANAF's
 * consolidated text, which shows the text in force and not the date each value took effect:
 * they start on 1 January 2026, and earlier years are a gap. The size criteria are those OMF nr.
 * 2.036/2025 quotes from OMFP nr. 1.802/2014 pct. 9 as amended, for the financial year 2025;
 * that pct. 9 still reads so for 2026 is to be confirmed by the expert contabil.
 */
export const determinationVersions: ParameterVersion[] = [
  version(
    'ro.size.thresholds',
    {
      micro: { assets: '2250000', turnover: '4500000', employees: 10 },
      small: { assets: '25000000', turnover: '50000000', employees: 50 },
      audit: { assets: '16000000', turnover: '32000000', employees: 50 },
      consecutiveYears: 2,
    },
    [
      'OMF2036/2025:anexa1.pct.2.1-2.3',
      'OMF2036/2025:anexa1.pct.2.6',
      'OMFP1802/2014:pct.12-13',
      'OMFP1802/2014:pct.15',
    ],
    '2025-01-01',
  ),
  version(
    'ro.vat.period.limit_eur',
    '100000',
    [code('art.322(2)-(6)'), code('norme.art.322.pct.103(2)-(3)')],
    '2026-01-01',
  ),
  version('ro.vat.exemption.threshold', '395000', [code('art.310(1)-(2),(6)')], '2026-01-01'),
  version(
    'ro.payroll.quarterly',
    { revenueLimitEur: '100000', employeesBelow: 3 },
    [code('art.80(2)-(3)'), code('art.147(4)-(10)')],
    '2026-01-01',
  ),
  version(
    'ro.micro.employee',
    { fte: '1', replacementDays: 30, newCompanyDays: 90 },
    [code('art.47(1)(g)'), code('art.48(3)-(3^3)'), code('art.52(2)-(3)')],
    '2026-01-01',
  ),
  version(
    'ro.micro.linked',
    { holdingAbovePct: '25', normaShare: '0.25' },
    [code('art.47(1^1)'), code('art.52(5^1)-(5^2)')],
    '2026-01-01',
  ),
];
