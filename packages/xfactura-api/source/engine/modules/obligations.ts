import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import { z } from 'zod';
import { profileAt, vatPeriodOf } from 'xfactura-core/kernel';
import { obligationDue, type ObligationKind } from 'xfactura-core/ro/obligations';
import { RuleGapError, type RuleContext } from 'xfactura-core/rules';
import type { LocalDate } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import {
  artifactEvents,
  artifacts,
  entries,
  fiscalYears,
  proposals,
  taxEntries,
} from '../db/schema';
import { loadState } from '../kernel/state';

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
});
type ObligationView = z.infer<typeof obligationView>;

const pad = (value: number) => String(value).padStart(2, '0');
const lastDay = (year: number, monthNumber: number) =>
  new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10) as LocalDate;
/** EU services across the border, which the recapitulative statement (D390) reports. */
const intraCommunity = ['RC-EU-SERV', 'EXP-EU-SERV'];

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

/** Months in which a treatment posted, from its entries. */
async function postingMonths(
  tx: Transaction,
  companyId: string,
  treatmentId: string,
  range: { from: string; to: string },
) {
  const rows = await tx
    .select({ date: entries.date })
    .from(entries)
    .innerJoin(
      proposals,
      and(eq(proposals.companyId, entries.companyId), eq(proposals.id, entries.proposalId)),
    )
    .where(
      and(
        eq(entries.companyId, companyId),
        eq(proposals.treatmentId, treatmentId),
        gte(entries.date, range.from),
        lte(entries.date, range.to),
      ),
    );
  return new Set(rows.map((row) => row.date.slice(0, 7)));
}

/**
 * The company's returns whose periods end in a range of months, each with its deadline and
 * where it stands. Which returns apply is read from the company's profile and books:
 * - VAT payers (`vat.status`): D300 and D394 for each VAT period, and D390 for the months with
 *   services across the EU border;
 * - D406 for each VAT period, quarterly for companies not registered for VAT (OPANAF 1783/2021
 *   anexa 4 pct. 2–3); the date from which the company's category reports (anexa 5) is not
 *   checked;
 * - employers (`employer`): D112 monthly (the quarterly filing of art. 147 alin. (4) is not
 *   covered);
 * - D100 in each quarter's last month for microenterprises (`income_tax`) and in the months
 *   dividend tax was withheld; D205 for the years with dividend tax withheld;
 * - S1005 for each financial year (the company's size category is not checked: the engine
 *   prepares only the microentities' statements).
 * A deadline the rule register does not source is `blocked`, never guessed.
 */
export async function obligationsCalendar(
  tx: Transaction,
  companyId: string,
  input: z.infer<typeof calendarInput>,
  rules: RuleContext,
  today: string,
): Promise<ObligationView[]> {
  const { loaded } = await loadState(tx, companyId, { profile: true });
  const from = `${input.from}-01` as LocalDate;
  const to = bounds(input.to).end;
  const months: string[] = [];
  for (let y = Number(input.from.slice(0, 4)), m = Number(input.from.slice(5, 7)); ;) {
    const label = `${y}-${pad(m)}`;
    if (label > input.to) break;
    months.push(label);
    if (++m === 13) [y, m] = [y + 1, 1];
  }

  const due: { kind: string; deadline: ObligationKind; period: string }[] = [];
  const add = (kind: string, period: string, deadline: ObligationKind = kind as ObligationKind) =>
    due.some((item) => item.kind === kind && item.period === period)
      ? undefined
      : due.push({ kind, deadline, period });

  const european = await tx
    .select({ taxPoint: taxEntries.taxPoint })
    .from(taxEntries)
    .where(
      and(
        eq(taxEntries.companyId, companyId),
        eq(taxEntries.tax, 'VAT'),
        inArray(taxEntries.code, intraCommunity),
        gte(taxEntries.taxPoint, from),
        lte(taxEntries.taxPoint, to),
      ),
    );
  const europeanMonths = new Set(european.map((row) => row.taxPoint.slice(0, 7)));
  const dividendMonths = await postingMonths(tx, companyId, 'dividends.withhold', {
    from: `${input.from.slice(0, 4)}-01-01`,
    to,
  });

  for (const label of months) {
    const end = bounds(label).end;
    const quarterEnd = Number(label.slice(5, 7)) % 3 === 0;
    const vatPayer = profileAt(loaded, 'vat.status', end) === 'normal_vat';
    const vatPeriod = vatPeriodOf(loaded, end);
    const periodEnds = !vatPeriod.includes('Q') || quarterEnd;
    if (vatPayer && periodEnds) {
      add('D300', vatPeriod);
      add('D394', vatPeriod);
    }
    if (vatPayer && europeanMonths.has(label)) add('D390', label);
    if (vatPayer ? periodEnds : quarterEnd)
      add('D406', vatPayer ? vatPeriod : `${label.slice(0, 4)}-Q${Number(label.slice(5, 7)) / 3}`);
    if (profileAt(loaded, 'employer', end) === 'yes') add('D112', label);
    if (quarterEnd && profileAt(loaded, 'income_tax', end) === 'micro')
      add('D100', label, 'D100.micro');
    if (dividendMonths.has(label)) add('D100', label, 'D100.dividends');
    if (label.endsWith('-12') && [...dividendMonths].some((m) => m.startsWith(label.slice(0, 4))))
      add('D205', label.slice(0, 4));
  }
  const years = await tx
    .select()
    .from(fiscalYears)
    .where(
      and(
        eq(fiscalYears.companyId, companyId),
        eq(fiscalYears.kind, 'financial'),
        gte(fiscalYears.to, from),
        lte(fiscalYears.to, to),
      ),
    );
  for (const year of years) add('S1005', year.to.slice(0, 4));

  const filed = await standing(tx, companyId, [...new Set(due.map((item) => item.kind))]);
  return (
    due
      .map((item): ObligationView => {
        const { start, end } = bounds(item.period);
        const artifact = filed.get(`${item.kind}|${item.period}`);
        try {
          const deadline = obligationDue(item.deadline, { start, end }, rules);
          return {
            ...item,
            start,
            end,
            nominal: deadline.nominal,
            due: deadline.due,
            status: artifact ? statusOf(artifact.state) : today > deadline.due ? 'overdue' : 'due',
            artifactId: artifact?.artifactId ?? null,
            versions: deadline.versions,
            gap: null,
          };
        } catch (error) {
          if (!(error instanceof RuleGapError)) throw error;
          return {
            ...item,
            start,
            end,
            nominal: null,
            due: null,
            status: artifact ? statusOf(artifact.state) : 'blocked',
            artifactId: artifact?.artifactId ?? null,
            versions: [],
            gap: error.message,
          };
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
