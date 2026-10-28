import { and, asc, eq, exists, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { Transaction } from './db';
import {
  canonical,
  deferralRescheduleEffect,
  fromBani,
  generalBodySchema,
  requireCondition,
  toBani,
} from './domain';
import {
  deferralPostings,
  deferralReleases,
  deferralCancellations,
  deferralReschedules,
  actionReviews,
  invoiceDocuments,
  journals,
  proposals,
} from './schema';
import { sha256 } from './object-store';

export async function loadDeferrals(tx: Transaction, companyId: string, ids: string[]) {
  if (!ids.length) return [];
  const roots = await tx
    .select({
      record: deferralPostings,
      journal: journals,
      proposal: proposals,
      invoice: invoiceDocuments,
    })
    .from(deferralPostings)
    .innerJoin(
      journals,
      and(
        eq(journals.companyId, deferralPostings.companyId),
        eq(journals.id, deferralPostings.journalId),
      ),
    )
    .innerJoin(
      proposals,
      and(
        eq(proposals.companyId, deferralPostings.companyId),
        eq(proposals.id, deferralPostings.deferralId),
      ),
    )
    .innerJoin(
      invoiceDocuments,
      and(
        eq(invoiceDocuments.companyId, deferralPostings.companyId),
        eq(invoiceDocuments.id, deferralPostings.invoiceId),
      ),
    )
    .where(
      and(eq(deferralPostings.companyId, companyId), inArray(deferralPostings.deferralId, ids)),
    );
  const releases = await tx
    .select({ record: deferralReleases, date: journals.date })
    .from(deferralReleases)
    .innerJoin(
      journals,
      and(
        eq(journals.companyId, deferralReleases.companyId),
        eq(journals.id, deferralReleases.journalId),
      ),
    )
    .where(
      and(eq(deferralReleases.companyId, companyId), inArray(deferralReleases.deferralId, ids)),
    )
    .orderBy(asc(deferralReleases.month));
  const cancellations = await tx
    .select({ record: deferralCancellations, date: journals.date })
    .from(deferralCancellations)
    .innerJoin(
      journals,
      and(
        eq(journals.companyId, deferralCancellations.companyId),
        eq(journals.id, deferralCancellations.journalId),
      ),
    )
    .where(
      and(
        eq(deferralCancellations.companyId, companyId),
        inArray(deferralCancellations.deferralId, ids),
      ),
    );
  const reschedules = await tx
    .select()
    .from(deferralReschedules)
    .where(
      and(
        eq(deferralReschedules.companyId, companyId),
        inArray(deferralReschedules.deferralId, ids),
      ),
    )
    .orderBy(asc(deferralReschedules.sequence));
  return roots.map((root) => {
    const body = generalBodySchema.parse(root.proposal.body),
      interpretation = body.invoice,
      treatment = interpretation?.deferral;
    requireCondition(
      interpretation && treatment,
      'DEFERRAL_SOURCE',
      'Factura nu identifică alocarea pe perioade.',
      500,
    );
    const ownReleases = releases.filter((row) => row.record.deferralId === root.record.deferralId);
    const cancellation = cancellations.find(
      (row) => row.record.deferralId === root.record.deferralId,
    );
    const ownReschedules = reschedules
      .filter((row) => row.deferralId === root.record.deferralId)
      .map((row) => ({ ...row, body: deferralRescheduleEffect.parse(row.body) }));
    return {
      ...root,
      body,
      interpretation,
      treatment,
      releases: ownReleases,
      cancellation,
      reschedules: ownReschedules,
      hash: sha256(
        canonical({
          proposalHash: root.proposal.hash,
          journalId: root.journal.id,
          releases: ownReleases.map(({ record, date }) => ({
            month: record.month,
            date,
            journalId: record.journalId,
            amount: record.amountBani.toString(),
          })),
          ...(cancellation
            ? {
                cancellation: {
                  invoiceId: cancellation.record.creditInvoiceId,
                  journalId: cancellation.record.journalId,
                  from: cancellation.record.fromMonth,
                  to: cancellation.record.toMonth,
                  amount: cancellation.record.amountBani.toString(),
                  date: cancellation.date,
                },
              }
            : {}),
          ...(ownReschedules.length
            ? {
                reschedules: ownReschedules.map((row) => ({
                  id: row.id,
                  sequence: row.sequence,
                  date: row.date,
                  body: row.body,
                })),
              }
            : {}),
        }),
      ),
    };
  });
}
export type DeferralState = Awaited<ReturnType<typeof loadDeferrals>>[number];
export function deferralSchedule(state: DeferralState, date?: string) {
  const latest = state.reschedules.filter((row) => !date || row.date <= date).at(-1);
  return latest?.body.afterSchedule ?? state.treatment.schedule;
}
export function rescheduleContext(state: DeferralState) {
  const latest = state.reschedules.at(-1);
  return latest ? { rescheduleId: latest.id, rescheduleVersion: latest.sequence } : {};
}
export function rescheduleReviewSuperseded(tx: Transaction) {
  return and(
    eq(actionReviews.operation, 'deferrals.reschedule'),
    isNull(actionReviews.executedAt),
    exists(
      tx
        .select({ id: deferralReschedules.id })
        .from(deferralReschedules)
        .where(
          and(
            eq(deferralReschedules.companyId, actionReviews.companyId),
            sql`${deferralReschedules.deferralId}=json_extract(${actionReviews.effect},'$.deferralId')`,
            gte(
              deferralReschedules.sequence,
              sql<number>`json_extract(${actionReviews.effect},'$.sequence')`,
            ),
          ),
        ),
    ),
  )!;
}
export function deferralView(state: DeferralState, date: string) {
  const released = state.releases.filter((row) => row.date <= date),
    byMonth = new Map(released.map((row) => [row.record.month, row.record]));
  const cancellation =
      state.cancellation && state.cancellation.date <= date ? state.cancellation : undefined,
    cancelled = cancellation?.record.amountBani ?? 0n;
  const allocated = released.reduce((sum, row) => sum + row.record.amountBani, 0n),
    remaining = toBani(state.treatment.amount) - allocated - cancelled;
  const effectiveSchedule = deferralSchedule(state, date),
    lastReschedule = state.reschedules.filter((row) => row.date <= date).at(-1);
  const schedule = effectiveSchedule.map((item) => ({
    ...item,
    journalId: byMonth.get(item.month)?.journalId ?? null,
    cancellationJournalId:
      cancellation && item.month >= cancellation.record.fromMonth
        ? cancellation.record.journalId
        : null,
    status:
      cancellation && item.month >= cancellation.record.fromMonth
        ? ('cancelled' as const)
        : item.amount === '0.00'
          ? ('not_required' as const)
          : byMonth.has(item.month)
            ? ('posted' as const)
            : ('scheduled' as const),
  }));
  return {
    id: state.record.deferralId,
    invoiceId: state.invoice.id,
    number: state.invoice.body.number,
    direction: state.invoice.direction,
    date: state.journal.date,
    financialYearId: state.body.financialYearId,
    journalId: state.journal.id,
    evidenceId: state.interpretation.treatmentEvidenceId,
    invoiceEvidenceId: state.invoice.evidenceId,
    account: state.interpretation.account,
    controlAccount: state.invoice.direction === 'purchase' ? ('471' as const) : ('472' as const),
    serviceFrom: state.treatment.serviceFrom,
    serviceTo: effectiveSchedule.at(-1)!.date,
    ...(lastReschedule
      ? {
          reschedule: {
            id: lastReschedule.id,
            version: lastReschedule.sequence,
            date: lastReschedule.date,
            effectiveFrom: lastReschedule.body.effectiveFrom,
            evidenceId: lastReschedule.evidenceId,
            originalServiceTo: state.treatment.serviceTo,
          },
        }
      : {}),
    amount: state.treatment.amount,
    allocated: fromBani(allocated),
    cancelled: fromBani(cancelled),
    remaining: fromBani(remaining),
    status:
      remaining === 0n
        ? cancelled > 0n
          ? ('cancelled' as const)
          : ('allocated' as const)
        : ('open' as const),
    cancellation: cancellation
      ? {
          creditInvoiceId: cancellation.record.creditInvoiceId,
          journalId: cancellation.record.journalId,
          date: cancellation.date,
          from: cancellation.record.fromMonth,
          to: cancellation.record.toMonth,
          amount: fromBani(cancelled),
        }
      : null,
    nextDueMonth:
      schedule.find((row) => row.date <= date && row.status === 'scheduled')?.month ?? null,
    schedule,
    hash: state.hash,
  };
}

/** Monthly drafts bind an exact calendar version; cancellation or amendment supersedes them. */
export function deferralReleaseSuperseded(tx: Transaction) {
  const cancelled = exists(
    tx
      .select({ id: deferralCancellations.deferralId })
      .from(deferralCancellations)
      .where(
        and(
          eq(deferralCancellations.companyId, proposals.companyId),
          sql`json_extract(${proposals.body}, '$.deferralRelease.deferralId')=${deferralCancellations.deferralId}`,
          sql`json_extract(${proposals.body}, '$.deferralRelease.month') between ${deferralCancellations.fromMonth} and ${deferralCancellations.toMonth}`,
        ),
      ),
  );
  const amended = exists(
    tx
      .select({ id: deferralReschedules.id })
      .from(deferralReschedules)
      .where(
        and(
          eq(deferralReschedules.companyId, proposals.companyId),
          sql`json_extract(${proposals.body},'$.deferralRelease.deferralId')=${deferralReschedules.deferralId}`,
          sql`${deferralReschedules.sequence}>coalesce(json_extract(${proposals.body},'$.deferralRelease.rescheduleVersion'),0)`,
        ),
      ),
  );
  const posted = exists(
    tx
      .select({ id: journals.id })
      .from(journals)
      .where(and(eq(journals.companyId, proposals.companyId), eq(journals.sourceId, proposals.id))),
  );
  return sql`(not ${posted} and (${cancelled} or ${amended}))`;
}
export async function supersededDeferralReleaseIds(tx: Transaction, companyId: string) {
  return new Set(
    (
      await tx
        .select({ id: proposals.id })
        .from(proposals)
        .where(and(eq(proposals.companyId, companyId), deferralReleaseSuperseded(tx)))
    ).map((row) => row.id),
  );
}
