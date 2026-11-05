import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import type { z } from 'zod';
import type { JsonValue } from 'xfactura-core/kernel';
import type { DraftFacts } from 'xfactura-core/ro/annual/documents';
import { recordedAt } from 'xfactura-core/ro/determinations';
import { obligationDue } from 'xfactura-core/ro/obligations';
import type { QuestionRequest } from 'xfactura-core/questions/kinds';
import { RuleGapError, type RuleContext } from 'xfactura-core/rules';
import { addDays, type LocalDate } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import { artifactEvents, artifacts, fiscalYears, profileFacts } from '../db/schema';
import type { Actor, Commands } from '../kernel/commands';
import { annualInput, disclosuresOf, documentsOf, informativeOf, openQuestions } from './annual';
import { statementConfigs } from './s1005';

/** The latest prepared statement of a kind and year not superseded, with its summary. */
async function preparedOf(tx: Transaction, companyId: string, kind: string, year: number) {
  const rows = await tx
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.companyId, companyId),
        eq(artifacts.kind, kind),
        eq(artifacts.period, String(year)),
      ),
    )
    .orderBy(asc(artifacts.createdAt));
  for (const row of rows.reverse()) {
    const steps = await tx
      .select({ state: artifactEvents.state, detail: artifactEvents.detail })
      .from(artifactEvents)
      .where(and(eq(artifactEvents.companyId, companyId), eq(artifactEvents.artifactId, row.id)))
      .orderBy(asc(artifactEvents.seq));
    if (steps.some((step) => step.state === 'superseded')) continue;
    const summary = steps.find((step) => step.state === 'prepared')?.detail;
    return {
      artifactId: row.id,
      state: steps.at(-1)!.state,
      summary: summary ? (JSON.parse(summary) as { draft?: DraftFacts; audit?: never }) : null,
    };
  }
  return null;
}

/**
 * What a statement's package waits on a person for: its F30 chapters, the disclosures and, once
 * prepared, the accompanying documents of its drafts.
 */
export async function wantedOf(
  tx: Transaction,
  companyId: string,
  kind: 'S1005' | 'S1003',
  year: number,
): Promise<{ wanted: QuestionRequest[]; prepared: Awaited<ReturnType<typeof preparedOf>> }> {
  const [financial] = await tx
    .select()
    .from(fiscalYears)
    .where(
      and(
        eq(fiscalYears.companyId, companyId),
        eq(fiscalYears.kind, 'financial'),
        eq(fiscalYears.to, `${year}-12-31`),
      ),
    );
  const wanted: QuestionRequest[] = [];
  if (financial)
    wanted.push(
      ...(await informativeOf(tx, companyId, kind, financial, statementConfigs[kind].informative))
        .missing,
    );
  const disclosures = await disclosuresOf(tx, companyId, kind, year);
  if (!disclosures.answer) wanted.push(disclosures.request);
  const prepared = await preparedOf(tx, companyId, kind, year);
  if (prepared?.summary?.draft) {
    const { statuses } = await documentsOf(
      tx,
      companyId,
      prepared.summary.draft,
      (prepared.summary as { audit?: { kind: 'statutory' | 'voluntary' | 'censors' } }).audit,
    );
    wanted.push(...statuses.filter((status) => !status.supplied).map((status) => status.request));
  }
  return { wanted, prepared };
}

/** Opens a statement's questions (`annual.ask`): agents may, people answer. */
export function annualAsk(
  commands: Commands,
  actor: Actor,
  key: string,
  input: z.infer<typeof annualInput>,
) {
  return commands.run(actor, key, 'annual.ask', input, 'write', async (tx) => {
    const { wanted } = await wantedOf(tx, actor.companyId, input.kind, input.year);
    const result = await openQuestions(tx, commands, actor, wanted);
    return { kind: input.kind, year: input.year, ...result };
  });
}

/** A worklist item of the annual statements, before the worklist adds its id. */
export type AnnualWork = {
  subjectId: string;
  severity: 'block' | 'warn' | 'info';
  year: number;
  kind: string;
  message: string;
  details: { [key: string]: JsonValue };
};

/** How many days before the statements' deadline their missing answers block the worklist. */
const blockingDays = 30;

/**
 * The annual statements' worklist (core `ro/annual/agent.ts`): for each financial year ended in
 * the last fifteen months, the statement its size category gives and what it waits on. While
 * ANAF has published no format for the year (a FORMAT_GAP), the answers are information: the
 * statement cannot be prepared yet. With the format, they warn, and block from 30 days before
 * the deadline (`ro.deadline.S1005`, `ro.deadline.S1003`), or when the deadline is not sourced.
 * The half-year report is the obligation closure's (`SF.halfyear`), on the calendar.
 */
export async function annualWork(
  tx: Transaction,
  companyId: string,
  today: LocalDate,
  rules: RuleContext,
): Promise<AnnualWork[]> {
  const items: AnnualWork[] = [];
  const since = `${Number(today.slice(0, 4)) - 2}-01-01`;
  const years = await tx
    .select()
    .from(fiscalYears)
    .where(
      and(
        eq(fiscalYears.companyId, companyId),
        eq(fiscalYears.kind, 'financial'),
        gte(fiscalYears.to, since),
        lte(fiscalYears.to, today),
      ),
    );
  const facts = (
    await tx
      .select()
      .from(profileFacts)
      .where(
        and(
          eq(profileFacts.companyId, companyId),
          inArray(profileFacts.axis, ['size.category', 'activity.none']),
        ),
      )
      .orderBy(asc(profileFacts.effectiveFrom), asc(profileFacts.createdAt))
  ).map((row) => ({
    axis: row.axis,
    value: row.value,
    effectiveFrom: row.effectiveFrom as LocalDate,
  }));
  for (const financial of years) {
    if (!financial.to.endsWith('-12-31')) continue;
    const year = Number(financial.to.slice(0, 4));
    if (recordedAt(facts, 'activity.none', financial.to) === 'yes') continue;
    const size = recordedAt(facts, 'size.category', financial.to);
    const kind = size === 'micro' ? 'S1005' : size === 'small' ? 'S1003' : null;
    if (!kind) continue;
    const { wanted, prepared } = await wantedOf(tx, companyId, kind, year);
    if (prepared && ['submitted', 'accepted'].includes(prepared.state)) continue;
    if (!wanted.length) continue;
    let format = true;
    try {
      statementConfigs[kind].format(year);
    } catch {
      format = false;
    }
    let due: string | null = null;
    try {
      due = obligationDue(
        kind,
        { start: `${year}-01-01` as LocalDate, end: `${year}-12-31` as LocalDate },
        rules,
      ).due;
    } catch (error) {
      if (!(error instanceof RuleGapError)) throw error;
    }
    const severity = !format
      ? 'info'
      : due && addDays(today, blockingDays) < due
        ? 'warn'
        : 'block';
    items.push({
      subjectId: `${kind}|${year}`,
      severity,
      year,
      kind,
      message: `${kind} ${year} așteaptă ${wanted.length} răspunsuri: ${wanted
        .map((request) => `${request.kind} ${request.subject.id}`)
        .join(', ')}.${
        !format
          ? ` ANAF nu a publicat formatul situațiilor pentru ${year}: ele se întocmesc după publicarea lui.`
          : due
            ? ` Termenul de depunere: ${due}.`
            : ''
      }`,
      details: {
        kind,
        year,
        wanted: wanted.map((request) => ({ kind: request.kind, subject: request.subject.id })),
        format,
        due,
      },
    });
  }
  // The half-year report is the obligation closure's (`SF.halfyear`): the calendar and its
  // worklist items show it, owed or unknown.
  return items;
}
