import { and, eq, gte, lte, sql } from 'drizzle-orm';
import type { Transaction } from './db';
import { fromBani, generalBodySchema, toBani } from './domain';
import {
  deferralPostings,
  deferralReleases,
  deferralCancellations,
  deferralReschedules,
  journalLines,
  journals,
  proposals,
} from './schema';

/** Full native history compared with one financial year's carried control balances. */
export async function deferralControls(
  tx: Transaction,
  companyId: string,
  from: string,
  date: string,
) {
  const roots = await tx
    .select({ record: deferralPostings, body: proposals.body })
    .from(deferralPostings)
    .innerJoin(
      proposals,
      and(
        eq(proposals.companyId, deferralPostings.companyId),
        eq(proposals.id, deferralPostings.deferralId),
      ),
    )
    .innerJoin(
      journals,
      and(
        eq(journals.companyId, deferralPostings.companyId),
        eq(journals.id, deferralPostings.journalId),
      ),
    )
    .where(and(eq(deferralPostings.companyId, companyId), lte(journals.date, date)));
  const releases = await tx
    .select({ record: deferralReleases })
    .from(deferralReleases)
    .innerJoin(
      journals,
      and(
        eq(journals.companyId, deferralReleases.companyId),
        eq(journals.id, deferralReleases.journalId),
      ),
    )
    .where(and(eq(deferralReleases.companyId, companyId), lte(journals.date, date)));
  const lines = await tx
    .select({
      account: journalLines.account,
      debit: journalLines.debitBani,
      credit: journalLines.creditBani,
    })
    .from(journalLines)
    .innerJoin(
      journals,
      and(eq(journals.companyId, journalLines.companyId), eq(journals.id, journalLines.journalId)),
    )
    .where(
      and(
        eq(journalLines.companyId, companyId),
        gte(journals.date, from),
        lte(journals.date, date),
        sql`(${journalLines.account} in ('471','472') or ${journalLines.account} like '471.%' or ${journalLines.account} like '472.%')`,
      ),
    );
  const cancellations = await tx
    .select({ record: deferralCancellations, body: proposals.body })
    .from(deferralCancellations)
    .innerJoin(
      journals,
      and(
        eq(journals.companyId, deferralCancellations.companyId),
        eq(journals.id, deferralCancellations.journalId),
      ),
    )
    .innerJoin(
      proposals,
      and(eq(proposals.companyId, journals.companyId), eq(proposals.id, journals.sourceId)),
    )
    .where(and(eq(deferralCancellations.companyId, companyId), lte(journals.date, date)));
  const byDeferral = new Map(
    cancellations.map(({ record, body }) => [
      record.deferralId,
      { ...record, treatment: generalBodySchema.parse(body).invoice!.deferralCredit! },
    ]),
  );
  const reschedules = await tx
    .select()
    .from(deferralReschedules)
    .where(and(eq(deferralReschedules.companyId, companyId), lte(deferralReschedules.date, date)));
  const schedules = new Map<string, typeof deferralReschedules.$inferSelect>();
  for (const row of reschedules)
    if (!schedules.has(row.deferralId) || schedules.get(row.deferralId)!.sequence < row.sequence)
      schedules.set(row.deferralId, row);
  let prepaid = 0n,
    deferredRevenue = 0n,
    dueCount = 0;
  const allocated = new Map<string, bigint>(),
    months = new Set<string>();
  for (const { record } of releases) {
    allocated.set(record.deferralId, (allocated.get(record.deferralId) ?? 0n) + record.amountBani);
    months.add(`${record.deferralId}:${record.month}`);
  }
  for (const root of roots) {
    const invoice = generalBodySchema.parse(root.body).invoice!,
      plan = invoice.deferral!;
    const cancellation = byDeferral.get(root.record.deferralId);
    const remaining =
      toBani(plan.amount) -
      (allocated.get(root.record.deferralId) ?? 0n) -
      (cancellation?.amountBani ?? 0n);
    if (invoice.direction === 'purchase') prepaid += remaining;
    else deferredRevenue += remaining;
    const schedule =
      cancellation && cancellation.treatment.schemaVersion !== 1
        ? cancellation.treatment.afterSchedule
        : (schedules.get(root.record.deferralId)?.body.afterSchedule ?? plan.schedule);
    dueCount += schedule.filter(
      (row) =>
        row.date <= date &&
        row.amount !== '0.00' &&
        (!cancellation ||
          cancellation.treatment.schemaVersion !== 1 ||
          row.month < cancellation.fromMonth) &&
        !months.has(`${root.record.deferralId}:${row.month}`),
    ).length;
  }
  const prepaidLedger = lines
      .filter((row) => /^471(?:\.|$)/.test(row.account))
      .reduce((sum, row) => sum + row.debit - row.credit, 0n),
    revenueLedger = lines
      .filter((row) => /^472(?:\.|$)/.test(row.account))
      .reduce((sum, row) => sum + row.credit - row.debit, 0n);
  const control = (ledger: bigint, remaining: bigint) => ({
    ledger: fromBani(ledger),
    remaining: fromBani(remaining),
    difference: fromBani(ledger - remaining),
  });
  return {
    deferralCount: roots.length,
    dueCount,
    prepaid: control(prepaidLedger, prepaid),
    deferredRevenue: control(revenueLedger, deferredRevenue),
    status:
      prepaidLedger === prepaid && revenueLedger === deferredRevenue && dueCount === 0
        ? ('reconciled' as const)
        : ('needs_review' as const),
  };
}
