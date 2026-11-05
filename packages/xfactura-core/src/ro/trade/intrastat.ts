import type { RuleContext } from '../../rules';
import type { LocalDate } from '../../time';
import {
  Draft,
  guarded,
  lei,
  recordedAt,
  WATCH_PERCENT,
  type Determination,
  type DeterminationContext,
  type ThresholdWatch,
} from '../determinations/determine';
import type { IntrastatThresholds } from './parameters';

/*
 * The Intrastat watch (INS): a company registered for VAT whose intra-Union trade in goods
 * exceeds the year's threshold, separately for arrivals (introduceri) and dispatches (expedieri),
 * files INS's statistical declaration each month: for the whole year when the previous year's
 * flow exceeded that year's threshold (the yearly order, art. 2), otherwise from the month the
 * year's cumulated flow exceeds it (art. 3). The flows are the books' intra-community
 * acquisitions (AIC-…) and supplies (EX-IC) by the month the goods moved. The declaration is
 * INS's, filed outside the engine: the closure lists it with its deadline, a person records it
 * filed (`obligation.filed`), and `intrastat.data` gives what the books hold of its lines.
 */

export const intrastatFlows = ['arrivals', 'dispatches'] as const;
export type IntrastatFlow = (typeof intrastatFlows)[number];
export const intrastatAxis = (flow: IntrastatFlow) => `intrastat.${flow}` as const;
/** The obligation's kind on the calendar. */
export const intrastatKind = (flow: IntrastatFlow) => `Intrastat.${flow}` as const;

/** A month's intra-Union goods, in bani: acquisitions (arrivals) and supplies (dispatches). */
export interface IntrastatMonth {
  month: string;
  arrivals: bigint;
  dispatches: bigint;
}

const flowName = (flow: IntrastatFlow) => (flow === 'arrivals' ? 'introducerile' : 'expedierile');
const CLAUSES = ['INS/Intrastat:norme.obligati', 'INS/Intrastat:termen'];

/**
 * Whether, and from which month, the company is an Intrastat data provider for a flow in a year:
 * `provider` from 1 January after a year over its threshold, or from the month the cumulated flow
 * crosses this year's; `none` otherwise. Not applicable without the flow in the year (nor a
 * recorded fact); the previous year from the books or asked, never assumed nil.
 */
export function determineIntrastat(
  context: DeterminationContext,
  rules: RuleContext,
  flow: IntrastatFlow,
): Determination {
  const year = context.year;
  const axis = intrastatAxis(flow);
  const draft = new Draft(axis, year, rules);
  return guarded(draft, () => {
    const months = [...(context.activity.intrastat ?? [])].sort((a, b) =>
      a.month.localeCompare(b.month),
    );
    const cumulated = months.reduce((sum, item) => sum + item[flow], 0n);
    const recorded = context.facts.some(
      (fact) => fact.axis === axis && fact.effectiveFrom <= `${year}-12-31`,
    );
    if (!cumulated && !recorded)
      return draft.notApplicable(
        `Registrele nu au în ${year} ${flowName(flow)} intra-UE de bunuri.`,
      );
    draft.cite(...CLAUSES);
    const thresholds = draft.param<IntrastatThresholds>(
      'ro.intrastat.thresholds',
      'reporting_period_start',
      `${year}-01-01`,
    );
    const limit = BigInt(thresholds[flow]) * 100n;
    draft.inputs.threshold = thresholds[flow];
    draft.inputs.cumulated = lei(cumulated);
    // The norms' first condition: registered for VAT (a code of identification for VAT).
    const registered =
      recordedAt(context.facts, 'vat.status', `${year}-12-31`) === 'normal_vat' ||
      context.facts.some(
        (fact) =>
          fact.axis === 'vat.status' &&
          fact.value === 'normal_vat' &&
          fact.effectiveFrom.startsWith(`${year}-`),
      );
    if (!registered)
      return draft.finish(
        'proposed',
        'none',
        `${year}-01-01`,
        `Firma nu este înregistrată în scopuri de TVA în ${year}: nu este furnizor de date Intrastat.`,
      );
    // The previous year over its own threshold: the whole year is declared (art. 2).
    const figure =
      flow === 'arrivals'
        ? context.previous.intrastatArrivals
        : context.previous.intrastatDispatches;
    const previous =
      context.activity.start || !figure
        ? 0n
        : draft.known<bigint>('previous', figure, (value) => lei(value));
    if (previous === undefined)
      return draft.needs(
        `${flowName(flow)} intra-UE din ${year - 1} nu sunt în registre: pragul Intrastat se compară și cu anul anterior.`,
      );
    if (previous) {
      const before = draft.param<IntrastatThresholds>(
        'ro.intrastat.thresholds',
        'reporting_period_start',
        `${year - 1}-01-01`,
      );
      const previousLimit = BigInt(before[flow]) * 100n;
      draft.line(
        `${flowName(flow)} din ${year - 1}: ${lei(previous)} lei, față de pragul de ${lei(previousLimit)} lei.`,
      );
      if (previous > previousLimit)
        return draft.finish(
          'proposed',
          'provider',
          `${year}-01-01`,
          `Furnizor de date Intrastat pentru ${flowName(flow)} din tot anul ${year}: în ${year - 1} pragul a fost depășit (ordinul INS, art. 2).`,
        );
    }
    // During the year: from the month the cumulated flow exceeds the threshold (art. 3).
    let running = 0n;
    for (const item of months) {
      running += item[flow];
      if (running > limit) {
        draft.line(
          `${flowName(flow)} cumulate până în ${item.month}: ${lei(running)} lei, peste pragul de ${lei(limit)} lei.`,
        );
        draft.changes.push({
          value: 'provider',
          effectiveFrom: `${item.month}-01` as LocalDate,
          reason: `pragul Intrastat de ${lei(limit)} lei depășit în ${item.month}`,
        });
        return draft.finish(
          'proposed',
          'none',
          `${year}-01-01`,
          `Furnizor de date Intrastat pentru ${flowName(flow)} din ${item.month}: valoarea cumulată, ${lei(running)} lei, depășește pragul de ${lei(limit)} lei (ordinul INS, art. 3).`,
        );
      }
    }
    draft.line(
      `${flowName(flow)} din ${year}: ${lei(cumulated)} lei, sub pragul de ${lei(limit)} lei.`,
    );
    return draft.finish(
      'proposed',
      'none',
      `${year}-01-01`,
      `${flowName(flow)} din ${year}, ${lei(cumulated)} lei, sunt sub pragul Intrastat de ${lei(limit)} lei.`,
    );
  });
}

/** The value a proposed determination gives on a day: its changes, else its value. */
export const valueOn = (determination: Determination, day: string) =>
  determination.changes.filter((change) => change.effectiveFrom <= day).at(-1)?.value ??
  (day >= determination.effectiveFrom ? determination.value : null);

/** The flows at `WATCH_PERCENT` of this year's threshold while the company is not recorded as
 * a provider, nor one for the whole year by the previous year's flow; an unknown previous year
 * does not hide the watch (the determination asks it). */
export function intrastatWatches(
  context: DeterminationContext,
  rules: RuleContext,
): Omit<ThresholdWatch, 'percent' | 'year'>[] {
  const watches: Omit<ThresholdWatch, 'percent' | 'year'>[] = [];
  const at = context.today < `${context.year}-12-31` ? context.today : `${context.year}-12-31`;
  const thresholds = rules.param<IntrastatThresholds>(
    'ro.intrastat.thresholds',
    'reporting_period_start',
    `${context.year}-01-01` as LocalDate,
  );
  for (const flow of intrastatFlows) {
    if (recordedAt(context.facts, intrastatAxis(flow), at) === 'provider') continue;
    const cumulated = (context.activity.intrastat ?? []).reduce(
      (sum, item) => sum + item[flow],
      0n,
    );
    const limit = BigInt(thresholds[flow]) * 100n;
    if (cumulated * 100n < limit * BigInt(WATCH_PERCENT)) continue;
    const determination = determineIntrastat(context, rules, flow);
    if (
      determination.status === 'proposed' &&
      determination.value === 'provider' &&
      !determination.changes.length
    )
      continue;
    watches.push({
      key: 'ro.intrastat.thresholds',
      axis: intrastatAxis(flow),
      limit,
      value: cumulated,
      clauses: CLAUSES,
      message: `${flow === 'arrivals' ? 'Introducerile' : 'Expedierile'} intra-UE de bunuri din ${context.year}, ${lei(cumulated)} lei, față de pragul Intrastat de ${thresholds[flow]} lei: peste prag, declarația statistică Intrastat se depune la INS lunar, până pe 15 a lunii următoare.`,
    });
  }
  return watches;
}
