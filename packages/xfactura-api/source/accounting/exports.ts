import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Commands, type Actor } from './commands';
import { idSchema, requireCondition } from './domain';
import {
  allocations,
  accrualPostings,
  accrualMatches,
  accrualAdjustments,
  deferralPostings,
  deferralReleases,
  deferralCancellations,
  unbilledSalePostings,
  unbilledSaleMatches,
  approvals,
  audit,
  actionReviews,
  accountingYears,
  ledgerAccounts,
  regimeEvents,
  accountingPolicies,
  invoiceDocuments,
  invoiceCredits,
  invoicePostings,
  invoiceSettlements,
  movementPostings,
  movementSources,
  treasuryAccounts,
  bankAccounts,
  companies,
  correctionOutcomes,
  evidence,
  facts,
  fiscalInterpretations,
  jobs,
  journalLines,
  journals,
  movements,
  periods,
  proposals,
  statementMovements,
  statements,
  taxPositions,
} from './schema';
import type { ObjectStore } from './object-store';

const exportTables = {
  deferralCancellations,
  deferralPostings,
  deferralReleases,
  accrualAdjustments,
  unbilledSalePostings,
  unbilledSaleMatches,
  accrualPostings,
  accrualMatches,
  accountingYears,
  ledgerAccounts,
  regimeEvents,
  accountingPolicies,
  invoiceDocuments,
  invoiceCredits,
  invoicePostings,
  invoiceSettlements,
  movementPostings,
  movementSources,
  treasuryAccounts,
  evidence,
  facts,
  proposals,
  approvals,
  correctionOutcomes,
  taxPositions,
  fiscalInterpretations,
  periods,
  journals,
  journalLines,
  bankAccounts,
  statements,
  movements,
  statementMovements,
  allocations,
  audit,
  actionReviews,
};
export const jsonSafe = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item)),
  );

export class Exports {
  constructor(
    private readonly runner: Commands,
    private readonly objects: ObjectStore,
  ) {}

  async request(actor: Actor, key: string) {
    return this.runner.run(actor, key, 'exports.request', {}, 'read', async (tx) => {
      const [company] = await tx.select().from(companies).where(eq(companies.id, actor.companyId));
      const data: Record<string, unknown> = { company };
      for (const [name, table] of Object.entries(exportTables)) {
        data[name] = jsonSafe(
          await tx.select().from(table).where(eq(table.companyId, actor.companyId)),
        );
      }
      const sources = await tx
        .select({
          id: evidence.id,
          hash: evidence.hash,
          filename: evidence.filename,
          size: evidence.size,
        })
        .from(evidence)
        .where(eq(evidence.companyId, actor.companyId));
      const [job] = await tx
        .insert(jobs)
        .values({
          id: randomUUID(),
          ...actor,
          kind: 'export',
          payload: {
            format: 'xfactura-a1',
            version: 1,
            requestedAt: new Date().toISOString(),
            data,
            evidence: sources,
          },
        })
        .returning({ id: jobs.id, status: jobs.status });
      return job;
    });
  }

  async download(actor: Actor, jobId: string) {
    idSchema.parse(jobId);
    return this.runner.read(
      actor,
      async (tx) => {
        const [job] = await tx
          .select()
          .from(jobs)
          .where(
            and(eq(jobs.companyId, actor.companyId), eq(jobs.id, jobId), eq(jobs.status, 'done')),
          );
        requireCondition(job?.result, 'NOT_FOUND', 'Exportul nu este încă disponibil.', 404);
        return {
          bytes: await this.objects.get(actor.companyId, job.result.hash),
          hash: job.result.hash,
        };
      },
      'exports.download',
    );
  }
}
