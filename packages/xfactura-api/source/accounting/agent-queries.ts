import { and, asc, eq, exists, getTableColumns, gt, gte, lte, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Commands, type Actor } from './commands';
import {
  dateSchema,
  fromBani,
  idSchema,
  proposalLines,
  requireCondition,
  trialBalance,
} from './domain';
import {
  actionReviews,
  accountingYears,
  allocations,
  approvals,
  audit,
  companies,
  correctionOutcomes,
  evidence,
  jobs,
  journalLines,
  journals,
  movements,
  movementPostings,
  proposals,
  statements,
} from './schema';
import { findProposal } from './books';
import type { Transaction } from './db';
import { pageInput } from './capability-contracts';
import type { CapabilityId } from './capability-policy';
import { deferralReleaseSuperseded, rescheduleReviewSuperseded } from './deferral-state';

export const datedPage = pageInput
  .extend({ from: dateSchema.optional(), to: dateSchema.optional() })
  .strict()
  .refine((value) => !value.from || !value.to || value.from <= value.to, 'Interval invalid.');
export const proposalPage = datedPage.safeExtend({
  kind: z.enum(['opening', 'purchase', 'correction', 'general']).optional(),
  status: z.enum(['pending', 'approved', 'posted', 'withdrawn', 'superseded']).optional(),
});
export const movementPage = datedPage.safeExtend({ matched: z.boolean().optional() });
export const journalPage = datedPage.safeExtend({
  kind: z.enum(['opening', 'purchase', 'payment', 'correction', 'general']).optional(),
});
export const reviewPage = pageInput
  .extend({ status: z.enum(['pending', 'approved', 'executed', 'superseded']).optional() })
  .strict();

const proposalApproved = (tx: Transaction) =>
  exists(
    tx
      .select({ id: approvals.id })
      .from(approvals)
      .where(
        and(
          eq(approvals.companyId, proposals.companyId),
          eq(approvals.proposalId, proposals.id),
          eq(approvals.version, proposals.version),
          eq(approvals.hash, proposals.hash),
        ),
      ),
  );
const proposalPosted = (tx: Transaction) =>
  exists(
    tx
      .select({ id: journals.id })
      .from(journals)
      .where(
        and(
          eq(journals.companyId, proposals.companyId),
          eq(journals.sourceId, proposals.id),
          eq(journals.kind, proposals.kind),
        ),
      ),
  );
const proposalWithdrawn = (tx: Transaction) =>
  exists(
    tx
      .select({ id: correctionOutcomes.proposalId })
      .from(correctionOutcomes)
      .where(
        and(
          eq(correctionOutcomes.companyId, proposals.companyId),
          eq(correctionOutcomes.proposalId, proposals.id),
          eq(correctionOutcomes.status, 'withdrawn'),
        ),
      ),
  );
function linesFor(row: typeof proposals.$inferSelect) {
  return proposalLines(row.kind, row.body);
}
export const summaryInput = z.object({ financialYearId: idSchema.optional() }).strict();
const uuidCursor = (value?: string) => (value === undefined ? undefined : idSchema.parse(value));
function numberedCursor(value?: string) {
  if (value === undefined) return undefined;
  requireCondition(/^[1-9]\d{0,14}$/.test(value), 'CURSOR', 'Cursor invalid.');
  return Number(value);
}
function page<T>(rows: T[], limit: number, cursor: (item: T) => string) {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? cursor(items[items.length - 1]) : null };
}

export class AgentQueries {
  constructor(private readonly runner: Commands) {}

  summary(actor: Actor, input: unknown = {}) {
    const body = summaryInput.parse(input);
    return this.runner.read(
      actor,
      async (tx) => {
        const [company] = await tx
          .select()
          .from(companies)
          .where(eq(companies.id, actor.companyId));
        const years = await tx
          .select()
          .from(accountingYears)
          .where(
            and(
              eq(accountingYears.companyId, actor.companyId),
              eq(accountingYears.kind, 'financial'),
              body.financialYearId ? eq(accountingYears.id, body.financialYearId) : undefined,
            ),
          );
        requireCondition(
          years.length === 1,
          'FINANCIAL_YEAR',
          'Selectați un exercițiu financiar disponibil.',
        );
        const financialYear = years[0];
        const lines = await tx
          .select({
            account: journalLines.account,
            debitBani: journalLines.debitBani,
            creditBani: journalLines.creditBani,
          })
          .from(journalLines)
          .innerJoin(
            journals,
            and(
              eq(journals.companyId, journalLines.companyId),
              eq(journals.id, journalLines.journalId),
            ),
          )
          .where(
            and(
              eq(journalLines.companyId, actor.companyId),
              gte(journals.date, financialYear.from),
              lte(journals.date, financialYear.to),
            ),
          );
        return {
          company,
          financialYear,
          balances: trialBalance(
            lines.map((line) => ({
              account: line.account,
              debit: fromBani(line.debitBani),
              credit: fromBani(line.creditBani),
            })),
          ),
        };
      },
      'books.summary',
    );
  }

  evidence(actor: Actor, input: unknown) {
    const body = pageInput.parse(input);
    return this.runner.read(
      actor,
      async (tx) =>
        page(
          await tx
            .select()
            .from(evidence)
            .where(
              and(
                eq(evidence.companyId, actor.companyId),
                body.cursor ? gt(evidence.id, uuidCursor(body.cursor)!) : undefined,
              ),
            )
            .orderBy(asc(evidence.id))
            .limit(body.limit + 1),
          body.limit,
          (row) => row.id,
        ),
      'evidence.list',
    );
  }

  proposals(actor: Actor, input: unknown) {
    const body = proposalPage.parse(input);
    return this.runner.read(
      actor,
      async (tx) => {
        const status =
          body.status === 'superseded'
            ? deferralReleaseSuperseded(tx)
            : body.status === 'posted'
              ? proposalPosted(tx)
              : body.status === 'withdrawn'
                ? proposalWithdrawn(tx)
                : body.status === 'approved'
                  ? and(
                      proposalApproved(tx),
                      sql`not ${proposalPosted(tx)}`,
                      sql`not ${proposalWithdrawn(tx)}`,
                      sql`not ${deferralReleaseSuperseded(tx)}`,
                    )
                  : body.status === 'pending'
                    ? and(
                        sql`not ${proposalApproved(tx)}`,
                        sql`not ${proposalPosted(tx)}`,
                        sql`not ${proposalWithdrawn(tx)}`,
                        sql`not ${deferralReleaseSuperseded(tx)}`,
                      )
                    : undefined;
        const rows = await tx
          .select({
            ...getTableColumns(proposals),
            approved: sql<boolean>`${proposalApproved(tx)}`.mapWith(Boolean),
            posted: sql<boolean>`${proposalPosted(tx)}`.mapWith(Boolean),
            withdrawn: sql<boolean>`${proposalWithdrawn(tx)}`.mapWith(Boolean),
            superseded: sql<boolean>`${deferralReleaseSuperseded(tx)}`.mapWith(Boolean),
          })
          .from(proposals)
          .where(
            and(
              eq(proposals.companyId, actor.companyId),
              body.cursor ? gt(proposals.id, uuidCursor(body.cursor)!) : undefined,
              body.kind ? eq(proposals.kind, body.kind) : undefined,
              body.from ? sql`${proposals.body}->>'$.date' >= ${body.from}` : undefined,
              body.to ? sql`${proposals.body}->>'$.date' <= ${body.to}` : undefined,
              status,
            ),
          )
          .orderBy(asc(proposals.id))
          .limit(body.limit + 1);
        return page(
          rows.map((row) => ({ ...row, lines: linesFor(row) })),
          body.limit,
          (row) => row.id,
        );
      },
      'proposals.list',
    );
  }

  proposal(actor: Actor, id: string) {
    idSchema.parse(id);
    return this.runner.read(
      actor,
      async (tx) => {
        const proposal = await findProposal(tx, actor.companyId, id);
        const [state] = await tx
          .select({
            approved: sql<boolean>`${proposalApproved(tx)}`.mapWith(Boolean),
            posted: sql<boolean>`${proposalPosted(tx)}`.mapWith(Boolean),
            withdrawn: sql<boolean>`${proposalWithdrawn(tx)}`.mapWith(Boolean),
            superseded: sql<boolean>`${deferralReleaseSuperseded(tx)}`.mapWith(Boolean),
          })
          .from(proposals)
          .where(and(eq(proposals.companyId, actor.companyId), eq(proposals.id, id)));
        return { ...proposal, ...state, lines: linesFor(proposal) };
      },
      'proposals.get',
    );
  }

  journals(actor: Actor, input: unknown) {
    const body = journalPage.parse(input),
      cursor = numberedCursor(body.cursor);
    return this.runner.read(
      actor,
      async (tx) => {
        const rows = await tx
          .select()
          .from(journals)
          .where(
            and(
              eq(journals.companyId, actor.companyId),
              cursor ? gt(journals.number, cursor) : undefined,
              body.kind ? eq(journals.kind, body.kind) : undefined,
              body.from ? sql`${journals.date} >= ${body.from}` : undefined,
              body.to ? sql`${journals.date} <= ${body.to}` : undefined,
            ),
          )
          .orderBy(asc(journals.number))
          .limit(body.limit + 1);
        const normalized = rows.length
          ? await tx
              .select()
              .from(journalLines)
              .where(
                and(
                  eq(journalLines.companyId, actor.companyId),
                  inArray(
                    journalLines.journalId,
                    rows.map((row) => row.id),
                  ),
                ),
              )
              .orderBy(asc(journalLines.line))
          : [];
        return page(
          rows.map((row) => ({
            ...row,
            lines: normalized
              .filter((line) => line.journalId === row.id)
              .map((line) => ({
                account: line.account,
                debit: fromBani(line.debitBani),
                credit: fromBani(line.creditBani),
              })),
          })),
          body.limit,
          (row) => String(row.number),
        );
      },
      'journals.list',
    );
  }

  movements(actor: Actor, input: unknown) {
    const body = movementPage.parse(input);
    return this.runner.read(
      actor,
      async (tx) => {
        const allocated = tx
          .select({ id: allocations.id })
          .from(allocations)
          .where(
            and(
              eq(allocations.companyId, movements.companyId),
              eq(allocations.movementId, movements.id),
            ),
          );
        const native = tx
          .select({ id: movementPostings.movementId })
          .from(movementPostings)
          .where(
            and(
              eq(movementPostings.companyId, movements.companyId),
              eq(movementPostings.movementId, movements.id),
            ),
          );
        const matched = or(exists(allocated), exists(native))!;
        const rows = await tx
          .select({
            ...getTableColumns(movements),
            matched: sql<boolean>`${matched}`.mapWith(Boolean),
          })
          .from(movements)
          .where(
            and(
              eq(movements.companyId, actor.companyId),
              body.cursor ? gt(movements.id, uuidCursor(body.cursor)!) : undefined,
              body.from ? sql`${movements.date} >= ${body.from}` : undefined,
              body.to ? sql`${movements.date} <= ${body.to}` : undefined,
              body.matched === undefined ? undefined : body.matched ? matched : sql`not ${matched}`,
            ),
          )
          .orderBy(asc(movements.id))
          .limit(body.limit + 1);
        return page(
          rows.map(({ amountBani, ...row }) => ({ ...row, amount: fromBani(amountBani) })),
          body.limit,
          (row) => row.id,
        );
      },
      'bank.movements',
    );
  }

  statements(actor: Actor, input: unknown) {
    const body = pageInput.parse(input);
    return this.runner.read(
      actor,
      async (tx) => {
        const rows = await tx
          .select()
          .from(statements)
          .where(
            and(
              eq(statements.companyId, actor.companyId),
              body.cursor ? gt(statements.id, uuidCursor(body.cursor)!) : undefined,
            ),
          )
          .orderBy(asc(statements.id))
          .limit(body.limit + 1);
        return page(
          rows.map(({ openingBani, closingBani, ...row }) => ({
            ...row,
            opening: fromBani(openingBani),
            closing: fromBani(closingBani),
          })),
          body.limit,
          (row) => row.id,
        );
      },
      'statements.list',
    );
  }

  jobs(actor: Actor, input: unknown) {
    const body = pageInput.parse(input);
    return this.runner.read(
      actor,
      async (tx) =>
        page(
          await tx
            .select({
              id: jobs.id,
              status: jobs.status,
              result: jobs.result,
              error: jobs.error,
              createdAt: jobs.createdAt,
            })
            .from(jobs)
            .where(
              and(
                eq(jobs.companyId, actor.companyId),
                body.cursor ? gt(jobs.id, uuidCursor(body.cursor)!) : undefined,
              ),
            )
            .orderBy(asc(jobs.id))
            .limit(body.limit + 1),
          body.limit,
          (row) => row.id,
        ),
      'jobs.list',
    );
  }

  reviews(actor: Actor, input: unknown) {
    const body = reviewPage.parse(input);
    return this.runner.read(
      actor,
      async (tx) => {
        const superseded = rescheduleReviewSuperseded(tx);
        const rows = await tx
          .select({
            ...getTableColumns(actionReviews),
            superseded: sql<boolean>`${superseded}`.mapWith(Boolean),
          })
          .from(actionReviews)
          .where(
            and(
              eq(actionReviews.companyId, actor.companyId),
              body.cursor ? gt(actionReviews.id, uuidCursor(body.cursor)!) : undefined,
              body.status === 'pending'
                ? sql`${actionReviews.approvedAt} is null and ${actionReviews.executedAt} is null and not (${superseded})`
                : body.status === 'approved'
                  ? sql`${actionReviews.approvedAt} is not null and ${actionReviews.executedAt} is null and not (${superseded})`
                  : body.status === 'executed'
                    ? sql`${actionReviews.executedAt} is not null`
                    : body.status === 'superseded'
                      ? superseded
                      : undefined,
            ),
          )
          .orderBy(asc(actionReviews.id))
          .limit(body.limit + 1);
        return page(
          rows.map(({ superseded, ...row }) => (superseded ? { ...row, superseded: true } : row)),
          body.limit,
          (row) => row.id,
        );
      },
      'reviews.list',
    );
  }

  activity(actor: Actor, input: unknown) {
    const body = pageInput.parse(input),
      cursor = numberedCursor(body.cursor);
    return this.runner.read(
      actor,
      async (tx) =>
        page(
          await tx
            .select({ ...getTableColumns(audit), id: sql<number>`${audit.id}`.mapWith(Number) })
            .from(audit)
            .where(
              and(eq(audit.companyId, actor.companyId), cursor ? gt(audit.id, cursor) : undefined),
            )
            .orderBy(asc(audit.id))
            .limit(body.limit + 1),
          body.limit,
          (row) => String(row.id),
        ),
      'activity.list' satisfies CapabilityId,
    );
  }
}
