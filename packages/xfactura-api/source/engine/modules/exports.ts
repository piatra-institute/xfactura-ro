import { and, eq, max } from 'drizzle-orm';
import { requireCondition } from 'xfactura-core/errors';
import type { Database } from '../db/database';
import * as schema from '../db/schema';
import type { ObjectStore } from '../adapters/object-store';
import type { Actor, Commands } from '../kernel/commands';
import { Jobs, type ClaimedJob, type JobHandler } from '../kernel/jobs';

const { jobs, entries } = schema;
type Tx = Parameters<Parameters<Database['read']>[0]>[0];
const EVIDENCE_LIMIT = 64 * 1024 * 1024;

/** Every company record an export contains. Authentication, work queues (jobs, outbox),
 * consumers' cursors, caches recomputed from the books (`acc_proposal_checks`), command replays
 * and global reference data are not company records. Schedules are the company's configuration. */
export async function companyRecords(tx: Tx, companyId: string) {
  const s = schema;
  return {
    acc_companies: await tx.select().from(s.companies).where(eq(s.companies.id, companyId)),
    acc_memberships: await tx
      .select()
      .from(s.memberships)
      .where(eq(s.memberships.companyId, companyId)),
    acc_invitations: await tx
      .select()
      .from(s.invitations)
      .where(eq(s.invitations.companyId, companyId)),
    acc_agent_grants: await tx
      .select()
      .from(s.agentGrants)
      .where(eq(s.agentGrants.companyId, companyId)),
    acc_audit: await tx.select().from(s.audit).where(eq(s.audit.companyId, companyId)),
    acc_fiscal_years: await tx
      .select()
      .from(s.fiscalYears)
      .where(eq(s.fiscalYears.companyId, companyId)),
    acc_accounts: await tx
      .select()
      .from(s.ledgerAccounts)
      .where(eq(s.ledgerAccounts.companyId, companyId)),
    acc_profile_facts: await tx
      .select()
      .from(s.profileFacts)
      .where(eq(s.profileFacts.companyId, companyId)),
    acc_parties: await tx.select().from(s.parties).where(eq(s.parties.companyId, companyId)),
    acc_party_versions: await tx
      .select()
      .from(s.partyVersions)
      .where(eq(s.partyVersions.companyId, companyId)),
    acc_series: await tx.select().from(s.series).where(eq(s.series.companyId, companyId)),
    acc_issued_numbers: await tx
      .select()
      .from(s.issuedNumbers)
      .where(eq(s.issuedNumbers.companyId, companyId)),
    acc_evidence: await tx.select().from(s.evidence).where(eq(s.evidence.companyId, companyId)),
    acc_documents: await tx.select().from(s.documents).where(eq(s.documents.companyId, companyId)),
    acc_document_links: await tx
      .select()
      .from(s.documentLinks)
      .where(eq(s.documentLinks.companyId, companyId)),
    acc_proposals: await tx.select().from(s.proposals).where(eq(s.proposals.companyId, companyId)),
    acc_proposal_versions: await tx
      .select()
      .from(s.proposalVersions)
      .where(eq(s.proposalVersions.companyId, companyId)),
    acc_approvals: await tx.select().from(s.approvals).where(eq(s.approvals.companyId, companyId)),
    acc_withdrawals: await tx
      .select()
      .from(s.withdrawals)
      .where(eq(s.withdrawals.companyId, companyId)),
    acc_posting_policies: await tx
      .select()
      .from(s.postingPolicies)
      .where(eq(s.postingPolicies.companyId, companyId)),
    acc_policy_revocations: await tx
      .select()
      .from(s.policyRevocations)
      .where(eq(s.policyRevocations.companyId, companyId)),
    acc_entries: await tx.select().from(s.entries).where(eq(s.entries.companyId, companyId)),
    acc_open_items: await tx.select().from(s.openItems).where(eq(s.openItems.companyId, companyId)),
    acc_lines: await tx.select().from(s.lines).where(eq(s.lines.companyId, companyId)),
    acc_schedule_rows: await tx
      .select()
      .from(s.scheduleRows)
      .where(eq(s.scheduleRows.companyId, companyId)),
    acc_tax_entries: await tx
      .select()
      .from(s.taxEntries)
      .where(eq(s.taxEntries.companyId, companyId)),
    acc_treasury_accounts: await tx
      .select()
      .from(s.treasuryAccounts)
      .where(eq(s.treasuryAccounts.companyId, companyId)),
    acc_bank_statements: await tx
      .select()
      .from(s.bankStatements)
      .where(eq(s.bankStatements.companyId, companyId)),
    acc_bank_movements: await tx
      .select()
      .from(s.bankMovements)
      .where(eq(s.bankMovements.companyId, companyId)),
    acc_bank_mappings: await tx
      .select()
      .from(s.bankMappings)
      .where(eq(s.bankMappings.companyId, companyId)),
    acc_period_events: await tx
      .select()
      .from(s.periodEvents)
      .where(eq(s.periodEvents.companyId, companyId)),
    acc_period_balances: await tx
      .select()
      .from(s.periodBalances)
      .where(eq(s.periodBalances.companyId, companyId)),
    acc_tax_period_events: await tx
      .select()
      .from(s.taxPeriodEvents)
      .where(eq(s.taxPeriodEvents.companyId, companyId)),
    acc_action_requests: await tx
      .select()
      .from(s.actionRequests)
      .where(eq(s.actionRequests.companyId, companyId)),
    acc_action_decisions: await tx
      .select()
      .from(s.actionDecisions)
      .where(eq(s.actionDecisions.companyId, companyId)),
    acc_action_executions: await tx
      .select()
      .from(s.actionExecutions)
      .where(eq(s.actionExecutions.companyId, companyId)),
    acc_submissions: await tx
      .select()
      .from(s.submissions)
      .where(eq(s.submissions.companyId, companyId)),
    acc_submission_events: await tx
      .select()
      .from(s.submissionEvents)
      .where(eq(s.submissionEvents.companyId, companyId)),
    acc_spv_messages: await tx
      .select()
      .from(s.spvMessages)
      .where(eq(s.spvMessages.companyId, companyId)),
    acc_spv_sync_windows: await tx
      .select()
      .from(s.spvSyncWindows)
      .where(eq(s.spvSyncWindows.companyId, companyId)),
    acc_artifacts: await tx.select().from(s.artifacts).where(eq(s.artifacts.companyId, companyId)),
    acc_artifact_events: await tx
      .select()
      .from(s.artifactEvents)
      .where(eq(s.artifactEvents.companyId, companyId)),
    acc_assets: await tx.select().from(s.assets).where(eq(s.assets.companyId, companyId)),
    acc_party_cnps: await tx.select().from(s.partyCnps).where(eq(s.partyCnps.companyId, companyId)),
    acc_party_status: await tx
      .select()
      .from(s.partyStatuses)
      .where(eq(s.partyStatuses.companyId, companyId)),
    acc_income_sources: await tx
      .select()
      .from(s.incomeSources)
      .where(eq(s.incomeSources.companyId, companyId)),
    acc_enterprise_members: await tx
      .select()
      .from(s.enterpriseMembers)
      .where(eq(s.enterpriseMembers.companyId, companyId)),
    acc_anaf_connections: await tx
      .select()
      .from(s.anafConnections)
      .where(eq(s.anafConnections.companyId, companyId)),
    acc_asset_events: await tx
      .select()
      .from(s.assetEvents)
      .where(eq(s.assetEvents.companyId, companyId)),
    acc_employees: await tx.select().from(s.employees).where(eq(s.employees.companyId, companyId)),
    acc_employment_terms: await tx
      .select()
      .from(s.employmentTerms)
      .where(eq(s.employmentTerms.companyId, companyId)),
    acc_payroll_runs: await tx
      .select()
      .from(s.payrollRuns)
      .where(eq(s.payrollRuns.companyId, companyId)),
    acc_payroll_run_events: await tx
      .select()
      .from(s.payrollRunEvents)
      .where(eq(s.payrollRunEvents.companyId, companyId)),
    acc_payroll_lines: await tx
      .select()
      .from(s.payrollLines)
      .where(eq(s.payrollLines.companyId, companyId)),
    acc_schedules: await tx.select().from(s.schedules).where(eq(s.schedules.companyId, companyId)),
    acc_questions: await tx.select().from(s.questions).where(eq(s.questions.companyId, companyId)),
    acc_question_answers: await tx
      .select()
      .from(s.questionAnswers)
      .where(eq(s.questionAnswers.companyId, companyId)),
    acc_question_withdrawals: await tx
      .select()
      .from(s.questionWithdrawals)
      .where(eq(s.questionWithdrawals.companyId, companyId)),
    acc_dispositions: await tx
      .select()
      .from(s.dispositions)
      .where(eq(s.dispositions.companyId, companyId)),
    acc_templates: await tx.select().from(s.templates).where(eq(s.templates.companyId, companyId)),
    acc_template_revocations: await tx
      .select()
      .from(s.templateRevocations)
      .where(eq(s.templateRevocations.companyId, companyId)),
    acc_template_predictions: await tx
      .select()
      .from(s.templatePredictions)
      .where(eq(s.templatePredictions.companyId, companyId)),
    acc_automation_events: await tx
      .select()
      .from(s.automationEvents)
      .where(eq(s.automationEvents.companyId, companyId)),
    acc_automation_criteria: await tx
      .select()
      .from(s.automationCriteria)
      .where(eq(s.automationCriteria.companyId, companyId)),
  };
}

export type JobView = {
  id: string;
  status: string;
  size: number | null;
  hash: string | null;
  error: string | null;
};
const view = (job: typeof jobs.$inferSelect): JobView => {
  const result = job.result as { hash: string; size: number } | null;
  return {
    id: job.id,
    status: job.status,
    size: result?.size ?? null,
    hash: result?.hash ?? null,
    error: job.error,
  };
};
const json = (value: unknown) =>
  JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? item.toString() : item));

const actorOf = (job: ClaimedJob): Actor => ({
  actorId: job.actorId,
  companyId: job.companyId,
  ...(job.agentId ? { agentId: job.agentId } : {}),
});

/** Builds a requested export. Authority is rechecked when the work runs and again when the
 * file is stored, not only when it was requested. */
export function exportJob(commands: Commands, objects: ObjectStore): JobHandler {
  return {
    kind: 'export',
    interrupted: 'Exportul a fost întrerupt repetat; cereți un export nou.',
    async run(job, lease) {
      const actor = actorOf(job);
      const snapshot = await commands.db.read(async (tx) => {
        await commands.authorize(tx, actor, 'review', 'exports.request');
        const tables = await companyRecords(tx, job.companyId);
        const [last] = await tx
          .select({ seq: max(entries.seq) })
          .from(entries)
          .where(eq(entries.companyId, job.companyId));
        return { tables, watermark: last?.seq ?? 0 };
      });
      const sources = snapshot.tables.acc_evidence;
      requireCondition(
        sources.reduce((total, source) => total + source.size, 0) <= EVIDENCE_LIMIT,
        'EXPORT_LIMIT',
        'Documentele depășesc 64 MB; exportul complet se face de operator.',
      );
      const originals = [];
      for (const source of sources) {
        const bytes = await objects.get(job.companyId, source.hash);
        originals.push({
          id: source.id,
          hash: source.hash,
          filename: source.filename,
          base64: bytes.toString('base64'),
        });
        await lease.renew();
      }
      const bytes = Buffer.from(
        json({
          format: 'xfactura-export',
          version: 2,
          companyId: job.companyId,
          exportedAt: new Date(commands.clock()).toISOString(),
          watermark: snapshot.watermark,
          tables: snapshot.tables,
          originals,
        }),
      );
      const hash = await objects.put(job.companyId, bytes, 128 * 1024 * 1024);
      return { hash, size: bytes.length };
    },
    async complete(tx, job) {
      await commands.authorize(tx, actorOf(job), 'review', 'exports.request');
    },
  };
}

/** Complete company exports: every record and every original file, built by the worker. */
export class Exports {
  constructor(
    private readonly commands: Commands,
    private readonly objects: ObjectStore,
  ) {}

  request(actor: Actor, key: string) {
    return this.commands.run(actor, key, 'exports.request', {}, 'review', async (tx) => {
      const job = await Jobs.enqueue(tx, {
        id: this.commands.ids(),
        companyId: actor.companyId,
        actorId: actor.actorId,
        agentId: actor.agentId ?? null,
        kind: 'export',
        params: {},
      });
      return view(job!);
    });
  }

  get(actor: Actor, id: string) {
    return this.commands.read(actor, 'exports.get', async (tx) => {
      const [job] = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.companyId, actor.companyId), eq(jobs.id, id), eq(jobs.kind, 'export')));
      requireCondition(job, 'NOT_FOUND', 'Exportul nu este disponibil.', 404);
      return view(job);
    });
  }

  async download(actor: Actor, id: string) {
    const job = await this.get(actor, id);
    requireCondition(
      job.status === 'done' && job.hash,
      'EXPORT_PENDING',
      'Exportul nu este încă gata.',
      409,
    );
    return { bytes: await this.objects.get(actor.companyId, job.hash), hash: job.hash };
  }
}
