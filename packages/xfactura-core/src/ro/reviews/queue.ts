import { RuleContext, RuleGapError } from '../../rules';
import { daysBetween, type LocalDate } from '../../time';
import { obligationDue, type ObligationKind } from '../obligations';
import { microQuarterRange } from '../treatments/micro-tax';
import { obligationCadence, riskWeight } from './catalogue';
import { versionsOf, type ReviewContext } from './packet';

/** About twenty mechanical rows of one act go in one packet. */
export const MECHANICAL_BATCH = 20;

export interface NextDeadline {
  obligation: ObligationKind;
  period: { start: LocalDate; end: LocalDate };
  due: LocalDate;
  days: number;
}

export interface QueueRow {
  key: string;
  /** Versions below `signed`. */
  open: string[];
  kind?: 'mechanical' | 'interpretation';
  act?: string;
  reach?: number;
  risk?: number;
  deadline?: NextDeadline;
  urgency?: number;
  minutes?: number;
  /** reach × risk × urgency ÷ minutes, when every factor is known. */
  score?: number;
  /** The annotations or spec the score lacks. */
  missing: string[];
}

export interface QueuePacket {
  kind: 'mechanical' | 'interpretation';
  act: string;
  keys: string[];
  minutes: number;
  score: number;
  deadline?: NextDeadline;
}

const pad = (value: number) => String(value).padStart(2, '0');
const lastDay = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10) as LocalDate;

/** The periods ending in the last two years and the current one, of a cadence. */
function periods(cadence: 'month' | 'quarter' | 'year', today: LocalDate) {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const result: { start: LocalDate; end: LocalDate }[] = [];
  if (cadence === 'year')
    for (const y of [year - 2, year - 1, year])
      result.push({ start: `${y}-01-01` as LocalDate, end: `${y}-12-31` as LocalDate });
  else if (cadence === 'quarter')
    for (let y = year - 1; y <= year; y += 1)
      for (let q = 1; q <= 4; q += 1) {
        const range = microQuarterRange(`${y}-Q${q}`);
        result.push({ start: range.from, end: range.to });
      }
  else
    for (let offset = -13; offset <= 0; offset += 1) {
      const index = year * 12 + (month - 1) + offset;
      const y = Math.floor(index / 12);
      const m = (index % 12) + 1;
      result.push({ start: `${y}-${pad(m)}-01` as LocalDate, end: lastDay(y, m) });
    }
  return result;
}

/** The earliest deadline on or after `today` of any of the returns, from the calendar's rules. */
export function nextDeadline(
  context: ReviewContext,
  obligations: readonly ObligationKind[],
  today: LocalDate,
): NextDeadline | undefined {
  let best: NextDeadline | undefined;
  for (const obligation of obligations)
    for (const cadence of obligationCadence[obligation])
      for (const period of periods(cadence, today)) {
        let due: LocalDate;
        try {
          due = obligationDue(obligation, period, new RuleContext(context.register, 'preview')).due;
        } catch (error) {
          if (error instanceof RuleGapError) continue;
          throw error;
        }
        if (due < today || (best && best.due <= due)) continue;
        best = { obligation, period, due, days: daysBetween(today, due) };
      }
  return best;
}

/** 3 within a month, 2 within a quarter, 1 beyond. */
export const urgencyOf = (days: number) => (days <= 31 ? 3 : days <= 92 ? 2 : 1);

/**
 * The parameters still below `signed`, ranked by reach × risk × urgency ÷ minutes, and the
 * packets to prepare next: each interpretation alone, mechanical rows by act in batches of about
 * twenty. A row missing an annotation or a spec is not scored: it lists what is missing.
 */
export function reviewQueue(context: ReviewContext, today: LocalDate) {
  const rows: QueueRow[] = [];
  for (const key of context.register.keys()) {
    const open = versionsOf(context.register, key)
      .filter((version) => version.status !== 'signed')
      .map((version) => version.id);
    if (!open.length) continue;
    const spec = context.specs.get(key);
    const annotation = context.annotations[key];
    const row: QueueRow = { key, open, missing: [] };
    if (spec) Object.assign(row, { kind: spec.kind, act: spec.act, minutes: spec.minutes });
    else row.missing.push('spec (readings, cases, minutes)');
    if (annotation?.reach) row.reach = annotation.reach.estimate;
    else row.missing.push('reach');
    if (annotation?.risk) row.risk = riskWeight[annotation.risk.kind];
    else row.missing.push('risk');
    if (annotation?.obligations?.length) {
      const deadline = nextDeadline(context, annotation.obligations, today);
      if (deadline) Object.assign(row, { deadline, urgency: urgencyOf(deadline.days) });
      else row.missing.push('urgency (no deadline resolves for its returns)');
    } else row.missing.push('obligations (urgency)');
    if (!row.missing.length) row.score = (row.reach! * row.risk! * row.urgency!) / row.minutes!;
    rows.push(row);
  }

  const ready = rows
    .filter((row) => row.score !== undefined)
    .sort((a, b) => b.score! - a.score! || a.key.localeCompare(b.key));
  const packets: QueuePacket[] = [];
  const earliest = (items: QueueRow[]) =>
    items.map((row) => row.deadline!).sort((a, b) => a.due.localeCompare(b.due))[0];
  for (const row of ready.filter((item) => item.kind === 'interpretation'))
    packets.push({
      kind: 'interpretation',
      act: row.act!,
      keys: [row.key],
      minutes: row.minutes!,
      score: row.score!,
      deadline: row.deadline,
    });
  const acts = [
    ...new Set(ready.filter((row) => row.kind === 'mechanical').map((row) => row.act!)),
  ];
  for (const act of acts) {
    const batch = ready.filter((row) => row.kind === 'mechanical' && row.act === act);
    for (let start = 0; start < batch.length; start += MECHANICAL_BATCH) {
      const items = batch.slice(start, start + MECHANICAL_BATCH);
      const minutes = items.reduce((sum, row) => sum + row.minutes!, 0);
      packets.push({
        kind: 'mechanical',
        act,
        keys: items.map((row) => row.key),
        minutes,
        score: items.reduce((sum, row) => sum + row.reach! * row.risk! * row.urgency!, 0) / minutes,
        deadline: earliest(items),
      });
    }
  }
  packets.sort((a, b) => b.score - a.score || a.keys[0]!.localeCompare(b.keys[0]!));

  /** Rows with every annotation but no spec: the specs to write next, by reach × risk × urgency. */
  const specsToWrite = rows
    .filter((row) => row.missing.length === 1 && row.missing[0]!.startsWith('spec'))
    .map((row) => ({ ...row, weight: row.reach! * row.risk! * row.urgency! }))
    .sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));
  return { rows, packets, specsToWrite, missing: rows.filter((row) => row.missing.length) };
}
