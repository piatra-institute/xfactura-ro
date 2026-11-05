import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { externalReturns, obligationDue, type ObligationKind } from 'xfactura-core/ro/obligations';
import { RuleGapError, type RuleContext } from 'xfactura-core/rules';
import type { LocalDate } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import { artifactEvents, artifacts } from '../db/schema';
import { closureOf } from './determinations';
import { standing as answered } from './questions';

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
export const calendarInput = z
  .object({
    /** The first and last month whose periods end in the calendar. */
    from: month,
    to: month,
    /** The day the statuses are read on (overdue after the due date); today by default. */
    today: z.iso.date().optional(),
  })
  .strict()
  .refine((input) => input.from <= input.to, {
    message: 'Luna de început este după cea de sfârșit.',
  })
  .refine(
    (input) =>
      Number(input.to.slice(0, 4)) * 12 +
        Number(input.to.slice(5, 7)) -
        (Number(input.from.slice(0, 4)) * 12 + Number(input.from.slice(5, 7))) <
      36,
    { message: 'Calendarul cuprinde cel mult 36 de luni.' },
  );

export const obligationView = z.object({
  /** The return (the declaration kind it is prepared as). */
  kind: z.string(),
  /** Which deadline applies: D100 is due for the micro tax and for dividend tax alike. */
  deadline: z.string(),
  period: z.string(),
  start: z.string(),
  end: z.string(),
  nominal: z.string().nullable(),
  due: z.string().nullable(),
  status: z.enum([
    'due',
    'overdue',
    'prepared',
    'authorized',
    'filed',
    'accepted',
    'rejected',
    'blocked',
  ]),
  artifactId: z.string().nullable(),
  /** The parameter versions the deadline was read from, or why it could not be. */
  versions: z.array(z.string()),
  gap: z.string().nullable(),
  /** Official texts that disagree on the deadline: each reading with its date and clauses. The
   * due date is the earliest, until an expert contabil settles it. */
  conflict: z
    .array(
      z.object({
        due: z.string(),
        nominal: z.string(),
        clauses: z.array(z.string()),
        text: z.string(),
      }),
    )
    .nullable(),
  /** The closure rule that produced the return, the facts it read (with their basis) and the
   * clauses it cites (docs/CONFORMANCE.md). */
  basis: z.object({
    rule: z.string(),
    facts: z.array(z.string()),
    clauses: z.array(z.string()),
  }),
  /** For a return blocked by an unknown fact: the question to ask (NEEDS_EVIDENCE). */
  question: z
    .object({
      kind: z.string(),
      subject: z.object({ kind: z.string(), id: z.string() }),
      params: z.record(z.string(), z.unknown()),
    })
    .nullable(),
  /** What blocks it: the closure's needs (ids) or the cases not covered (UNSUPPORTED triggers). */
  blockers: z.array(z.string()),
});
type ObligationView = z.infer<typeof obligationView>;

const pad = (value: number) => String(value).padStart(2, '0');
const lastDay = (year: number, monthNumber: number) =>
  new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10) as LocalDate;

/** A VAT period's first and last day ('2026-10' or '2026-Q4'). */
function bounds(period: string): { start: LocalDate; end: LocalDate } {
  const quarter = /^(\d{4})-Q([1-4])$/.exec(period);
  if (quarter) {
    const [year, last] = [Number(quarter[1]), Number(quarter[2]) * 3];
    return { start: `${year}-${pad(last - 2)}-01` as LocalDate, end: lastDay(year, last) };
  }
  if (/^\d{4}$/.test(period))
    return { start: `${period}-01-01` as LocalDate, end: `${period}-12-31` as LocalDate };
  const [year, number] = [Number(period.slice(0, 4)), Number(period.slice(5, 7))];
  return { start: `${period}-01` as LocalDate, end: lastDay(year, number) };
}

/** Where a return stands: its latest version not superseded. */
async function standing(tx: Transaction, companyId: string, kinds: string[]) {
  const rows = await tx
    .select({ id: artifacts.id, kind: artifacts.kind, period: artifacts.period })
    .from(artifacts)
    .where(and(eq(artifacts.companyId, companyId), inArray(artifacts.kind, kinds)))
    .orderBy(asc(artifacts.createdAt));
  const result = new Map<string, { artifactId: string; state: string }>();
  for (const row of rows) {
    const steps = await tx
      .select({ state: artifactEvents.state })
      .from(artifactEvents)
      .where(and(eq(artifactEvents.companyId, companyId), eq(artifactEvents.artifactId, row.id)))
      .orderBy(asc(artifactEvents.seq));
    const states = steps.map((step) => step.state);
    if (states.includes('superseded')) continue;
    result.set(`${row.kind}|${row.period}`, { artifactId: row.id, state: states.at(-1)! });
  }
  return result;
}

const statusOf = (state: string): ObligationView['status'] =>
  ['prepared', 'validation_failed', 'validated_official'].includes(state)
    ? 'prepared'
    : ['authorized', 'exported_for_signing', 'signed_imported'].includes(state)
      ? 'authorized'
      : state === 'submitted'
        ? 'filed'
        : state === 'accepted' || state === 'rejected'
          ? state
          : 'prepared';

/**
 * The company's returns whose periods end in a range of months, each with its deadline and
 * where it stands. Which returns apply is the obligation closure's (`closureOf`, core
 * `ro/determinations/closure.ts`), from the recorded facts, the yearly determinations and the
 * books: a return whose applicability depends on a fact nobody recorded is `blocked`, naming the
 * question to ask; one the engine does not cover is `blocked` with the case (UNSUPPORTED). A
 * deadline the rule register does not source is `blocked` too, never guessed. The months before
 * the company's first financial year list nothing.
 */
export async function obligationsCalendar(
  tx: Transaction,
  companyId: string,
  input: z.infer<typeof calendarInput>,
  rules: RuleContext,
  today: string,
): Promise<ObligationView[]> {
  const closure = await closureOf(
    tx,
    companyId,
    { from: input.from, to: input.to },
    rules,
    today as LocalDate,
  );
  const needs = new Map(closure.needs.map((need) => [need.id, need]));
  const unsupported = new Map(closure.unsupported.map((item) => [item.trigger, item]));
  // One row per return and period; a return due on one ground is due whatever else is unknown.
  const rank = { applies: 0, needs_evidence: 1, unsupported: 2 } as const;
  const chosen = new Map<string, (typeof closure.obligations)[number]>();
  for (const item of closure.obligations) {
    const key = `${item.kind}|${item.period}`;
    const known = chosen.get(key);
    if (!known || rank[item.state] < rank[known.state]) chosen.set(key, item);
  }
  const due = [...chosen.values()];
  const filed = await standing(tx, companyId, [...new Set(due.map((item) => item.kind))]);
  // A return filed outside the engine counts as filed once a person recorded it.
  for (const item of due.filter((row) => externalReturns.includes(row.kind))) {
    const found = await answered(tx, companyId, {
      kind: 'obligation.filed',
      subject: { kind: 'obligation', id: `${item.kind}/${item.period}` },
      params: { kind: item.kind, period: item.period },
    });
    if (found.answered)
      filed.set(`${item.kind}|${item.period}`, { artifactId: '', state: 'submitted' });
  }
  return (
    due
      .map((item): ObligationView => {
        const { start, end } = bounds(item.period);
        const artifact = filed.get(`${item.kind}|${item.period}`);
        const basis = { rule: item.rule, facts: item.facts, clauses: item.clauses };
        const blocked = (gap: string, question: ObligationView['question']): ObligationView => ({
          kind: item.kind,
          deadline: item.deadline ?? item.kind,
          period: item.period,
          start,
          end,
          nominal: null,
          due: null,
          status: artifact ? statusOf(artifact.state) : 'blocked',
          artifactId: artifact?.artifactId || null,
          versions: [],
          gap,
          conflict: null,
          basis,
          question,
          blockers: item.blockers,
        });
        if (item.state === 'needs_evidence') {
          const first = item.blockers.map((id) => needs.get(id)).find(Boolean);
          return blocked(
            item.blockers
              .map((id) => needs.get(id)?.message ?? unsupported.get(id)?.message ?? id)
              .join(' '),
            first ? { ...first.question, params: { ...first.question.params } } : null,
          );
        }
        if (item.state === 'unsupported' || !item.deadline)
          return blocked(
            `UNSUPPORTED: ${item.blockers.map((id) => unsupported.get(id)?.message ?? needs.get(id)?.message ?? id).join(' ')}`,
            null,
          );
        try {
          const counted = item.deadlinePeriod ? bounds(item.deadlinePeriod) : { start, end };
          const deadline = obligationDue(item.deadline as ObligationKind, counted, rules);
          return {
            kind: item.kind,
            deadline: item.deadline,
            period: item.period,
            start,
            end,
            nominal: deadline.nominal,
            due: deadline.due,
            status: artifact ? statusOf(artifact.state) : today > deadline.due ? 'overdue' : 'due',
            artifactId: artifact?.artifactId || null,
            versions: deadline.versions,
            gap: null,
            conflict:
              deadline.conflict?.map((reading) => ({
                due: reading.due,
                nominal: reading.nominal,
                clauses: reading.clauses,
                text: reading.text,
              })) ?? null,
            basis,
            question: null,
            blockers: [],
          };
        } catch (error) {
          if (!(error instanceof RuleGapError)) throw error;
          return { ...blocked(error.message, null), deadline: item.deadline };
        }
      })
      // By due date, the blocked ones (without a deadline) last; then by period and return.
      .sort(
        (a, b) =>
          (a.due ?? '9999').localeCompare(b.due ?? '9999') ||
          a.end.localeCompare(b.end) ||
          a.kind.localeCompare(b.kind),
      )
  );
}
