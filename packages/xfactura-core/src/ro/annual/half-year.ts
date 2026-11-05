import { z } from 'zod';
import type { ParameterDefinition, ParameterVersion, RuleContext } from '../../rules';
import { parseLocalDate as date, type LocalDate } from '../../time';

/**
 * Who reports at 30 June (the half-year accounting report, S1027/S1050). Legea contabilității
 * art. 28 alin. (2) lets the Ministry of Finance ask for reports within the year; it does so by an
 * order each year. For 2025, OMF nr. 1.194/2025 asked them of the entities under OMFP nr.
 * 1.802/2014 whose net turnover of the previous financial year exceeded the lei equivalent of
 * 1.000.000 euro at the BNR rate valid at that year's close (art. 2 alin. (1), (4)), except the
 * entities without activity since they were set up, those temporarily inactive all half-year,
 * those set up during the year and those in liquidation (anexa pct. 16), by 18 August 2025 (pct.
 * 17). For 2026 no order is published and ANAF lists no S1027–S1050: nobody reports. A later year
 * is a gap until its order is read.
 *
 * The engine does not prepare the half-year report: a company that owes one is shown it as a case
 * the engine does not cover.
 */

export const halfYearRule = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('turnover_above'),
      /** The previous year's net turnover (F20 rd. 01) must exceed this many euro. */
      euro: z.string().regex(/^[1-9]\d*$/),
      /** The last day to file. */
      due: z.iso.date(),
    })
    .strict(),
  /** No order asks for the year's half-year report. */
  z.object({ kind: z.literal('none') }).strict(),
]);
export type HalfYearRule = z.infer<typeof halfYearRule>;

export const halfYearDefinitions: ParameterDefinition[] = [
  {
    key: 'ro.halfyear.report',
    axis: 'reporting_period_start',
    continuity: 'block',
    scope: [],
    value: halfYearRule,
    description:
      'Cine întocmește raportarea contabilă la 30 iunie (ordinul anual al ministrului finanțelor) și până când.',
  },
];

export const halfYearVersions: ParameterVersion[] = [
  {
    id: 'ro.halfyear.report/2025-01-01',
    key: 'ro.halfyear.report',
    scope: {},
    value: { kind: 'turnover_above', euro: '1000000', due: '2025-08-18' },
    from: date('2025-01-01'),
    to: date('2025-12-31'),
    reviewedThrough: date('2025-12-31'),
    knowledgeDate: null,
    status: 'extracted',
    clauses: ['OMF1194/2025:art.2,anexa.pct.16-17'],
  },
  {
    id: 'ro.halfyear.report/2026-01-01',
    key: 'ro.halfyear.report',
    scope: {},
    value: { kind: 'none' },
    from: date('2026-01-01'),
    to: date('2026-12-31'),
    reviewedThrough: date('2026-12-31'),
    knowledgeDate: null,
    status: 'extracted',
    clauses: ['ANAF/raportari-semestriale:2026'],
  },
];

export type HalfYearDecision = {
  year: number;
  /** required: the report is owed (and not covered); none: not owed; unknown: an input is. */
  status: 'required' | 'none' | 'unknown';
  due: string | null;
  lines: string[];
  versions: string[];
  /** What is missing for `unknown`. */
  missing: string[];
};

/**
 * The half-year report decision for a year. `previousNetTurnover` is the previous year's F20
 * rd. 01 in bani (null when unknown), `rate` the BNR EUR rate valid at its close (lei per euro,
 * null when not imported), `excluded` the reason the company is exempt when a person stated one
 * (inactive since set up, temporarily inactive all half-year, set up during the year, in
 * liquidation). Throws RuleGapError past the register's years.
 */
export function halfYearReport(
  year: number,
  inputs: {
    previousNetTurnover: bigint | null;
    rate: { rate: string; date: string } | null;
    excluded: string | null;
  },
  rules: RuleContext,
): HalfYearDecision {
  const start = `${year}-01-01` as LocalDate;
  const rule = rules.param<HalfYearRule>('ro.halfyear.report', 'reporting_period_start', start);
  const versions = [...rules.used.keys()].filter((id) => id.startsWith('ro.halfyear.report/'));
  if (rule.kind === 'none')
    return {
      year,
      status: 'none',
      due: null,
      lines: [`Pentru ${year} niciun ordin nu cere raportarea contabilă la 30 iunie.`],
      versions,
      missing: [],
    };
  if (inputs.excluded)
    return {
      year,
      status: 'none',
      due: null,
      lines: [`Scutită de raportarea la 30 iunie ${year}: ${inputs.excluded}.`],
      versions,
      missing: [],
    };
  const missing = [
    ...(inputs.previousNetTurnover === null ? [`cifra de afaceri netă ${year - 1}`] : []),
    ...(inputs.rate === null ? [`cursul BNR al EUR la 31.12.${year - 1}`] : []),
  ];
  if (missing.length)
    return { year, status: 'unknown', due: rule.due, lines: [], versions, missing };
  // Lei with four decimals of the rate: the limit in bani, half up.
  const [whole, fraction = ''] = inputs.rate!.rate.split('.');
  const rate = BigInt(whole!) * 10_000n + BigInt(fraction.padEnd(4, '0').slice(0, 4));
  const limit = (BigInt(rule.euro) * rate * 100n + 5_000n) / 10_000n;
  const above = inputs.previousNetTurnover! > limit;
  return {
    year,
    status: above ? 'required' : 'none',
    due: above ? rule.due : null,
    lines: [
      `Cifra de afaceri netă ${year - 1}: ${inputs.previousNetTurnover! / 100n} lei, față de ${rule.euro} € × ${inputs.rate!.rate} (BNR ${inputs.rate!.date}) = ${limit / 100n} lei: raportarea la 30 iunie ${year} ${above ? 'se întocmește' : 'nu se întocmește'}.`,
    ],
    versions,
    missing: [],
  };
}
