import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { obligationDue, type ObligationKind } from 'xfactura-core/ro/obligations';
import type { ClosureObligation } from 'xfactura-core/ro/determinations';
import { RuleGapError, type RuleContext } from 'xfactura-core/rules';
import type { LocalDate } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import { artifactEvents, artifacts, questions } from '../db/schema';
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
  /** For a blocked return whose deadline's rule is not reviewed for its period yet (beyond the
   * register's horizon, before that year's rollover, docs/ROLLOVER.md): the year whose rules it
   * waits for. Whatever else it lacks (that year's VAT period, D406's start) waits on them too. */
  waiting: z.number().int().nullable(),
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

/**
 * The returns a person recorded as filed outside the engine (`obligation.filed`, subject
 * `<return>/<period>`): D700 and INS's Intrastat, which the engine never prepares, and any other
 * return filed through ANAF's portal (a month whose format the engine does not write, a return
 * filed before the books moved here). Only the subjects asked are read.
 */
async function filedOutside(
  tx: Transaction,
  companyId: string,
  due: readonly { kind: string; period: string }[],
) {
  const asked = new Set(
    (
      await tx
        .selectDistinct({ subject: questions.subjectId })
        .from(questions)
        .where(and(eq(questions.companyId, companyId), eq(questions.kind, 'obligation.filed')))
    ).map((row) => row.subject),
  );
  const filed = new Set<string>();
  for (const item of due) {
    if (!asked.has(`${item.kind}/${item.period}`)) continue;
    const found = await answered(tx, companyId, {
      kind: 'obligation.filed',
      subject: { kind: 'obligation', id: `${item.kind}/${item.period}` },
      params: { kind: item.kind, period: item.period },
    });
    if (found.answered) filed.add(`${item.kind}|${item.period}`);
  }
  return filed;
}

/** The year whose rules a blocked return waits for: its deadline's rule is beyond the register's
 * horizon for its period (that year's rules are not reviewed yet), or null. */
function waitingFor(item: ClosureObligation, rules: RuleContext) {
  if (!item.deadline) return null;
  const { start, end } = bounds(item.period);
  try {
    obligationDue(
      item.deadline,
      item.deadlinePeriod ? bounds(item.deadlinePeriod) : { start, end },
      rules,
    );
    return null;
  } catch (error) {
    if (!(error instanceof RuleGapError) || error.gap.reason !== 'BEYOND_HORIZON') return null;
    return Number(error.gap.date.slice(0, 4));
  }
}

/** A need of the obligation closure (NEEDS_EVIDENCE), with the returns it leaves blocked. */
export type ClosureNeedItem = {
  id: string;
  code: string;
  fact: string;
  message: string;
  question: {
    kind: string;
    subject: { kind: string; id: string };
    params: Record<string, unknown>;
  };
  /** The returns of the range it blocks, `<return>|<period>`, none due on another ground. */
  blocks: string[];
  /** The year whose rules every return it blocks waits for, or null. */
  waiting: number | null;
};

/**
 * The closure's needs over a range of months (the worklist's `closure.need`): every fact or
 * determination it cannot read, whether or not a return of the range depends on it (the scope
 * facts, `activity.goods` or `regime.excluded`, decide no single return), with its question.
 */
export async function closureNeeds(
  tx: Transaction,
  companyId: string,
  range: { from: string; to: string },
  rules: RuleContext,
  today: string,
): Promise<ClosureNeedItem[]> {
  const closure = await closureOf(tx, companyId, range, rules, today as LocalDate);
  const key = (item: ClosureObligation) => `${item.kind}|${item.period}`;
  const applies = new Set(closure.obligations.filter((item) => item.state === 'applies').map(key));
  return closure.needs.map((need) => {
    const blocked = closure.obligations.filter(
      (item) =>
        item.state === 'needs_evidence' &&
        item.blockers.includes(need.id) &&
        !applies.has(key(item)),
    );
    const waits = blocked.map((item) => waitingFor(item, rules));
    return {
      id: need.id,
      code: need.code,
      fact: need.fact,
      message: need.message,
      question: {
        kind: need.question.kind,
        subject: need.question.subject,
        params: { ...need.question.params },
      },
      blocks: [...new Set(blocked.map(key))],
      waiting:
        waits.length && waits.every((year) => year !== null)
          ? Math.max(...(waits as number[]))
          : null,
    };
  });
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
  // A return filed outside the engine counts as filed once a person recorded it, unless the
  // engine's own filing of it stands.
  for (const key of await filedOutside(tx, companyId, due))
    if (!['submitted', 'accepted'].includes(filed.get(key)?.state ?? ''))
      filed.set(key, { artifactId: '', state: 'submitted' });

  return (
    due
      .map((item): ObligationView => {
        const { start, end } = bounds(item.period);
        const counted = item.deadlinePeriod ? bounds(item.deadlinePeriod) : { start, end };
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
          waiting: artifact ? null : waitingFor(item, rules),
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
            waiting: null,
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
