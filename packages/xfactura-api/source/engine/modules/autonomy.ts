import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { canonical, hashOf } from 'xfactura-core/hash';
import type { JsonValue } from 'xfactura-core/kernel';
import { divRound, formatMoney, parseMoney } from 'xfactura-core/money';
import {
  effectParties,
  graduation,
  inScope,
  subjectKindOf,
  templateScope,
  type TemplateDefinition,
} from 'xfactura-core/templates';
import { bucharestDate } from 'xfactura-core/time';
import type { Database, Transaction } from '../db/database';
import { entries, postingPolicies, proposals, proposalVersions } from '../db/schema';
import type { ActionHandler } from '../kernel/actions';
import { criteriaOf, demote, SYSTEM_PRINCIPAL, type DemotionTrigger } from '../kernel/automation';
import { appendAudit } from '../kernel/commands';
import { entryStands } from '../kernel/ledger';
import type { AuditEvent } from '../kernel/events';
import type { JobHandler } from '../kernel/jobs';
import type { Precondition, PolicyInput, PostingPolicies } from '../kernel/policies';
import type { Projector } from '../kernel/projectors';
import type { Basis, Evaluated, Proposals } from '../kernel/proposals';
import type { Templates } from './templates';

/*
 * Earned autonomy. A template graduates when its predictions came out correct often enough
 * (the company's criteria); `policies.request` then proposes, from its graduation report, a
 * posting policy bound to it with partner and amount limits, which a person approves as a
 * reviewed action. Once created, the worker sweeps the open proposals the policy covers. A policy
 * whose posting is reversed, whose template's proposal a person corrects, or which meets a new
 * partner or an unusual amount is paused by the system (a demotion) until a person resumes it.
 */

/** How far beyond the amounts observed a graduated policy reaches, in hundredths. */
const observedFactor = 150n;

export const policyRequestInput = z
  .object({
    templateId: z.uuid(),
    name: z.string().trim().min(3).max(200).optional(),
  })
  .strict();
export type PolicyRequest = z.infer<typeof policyRequestInput>;

/** A graduation report: a template's current version, its track record against the company's
 * criteria, and the policy it may earn. */
export type GraduationReport = Awaited<ReturnType<Autonomy['report']>>;

const ron = (bani: bigint) => formatMoney(bani, 'RON');
/** An amount widened by the observed factor, rounded up to the ban. */
const widened = (bani: bigint) => divRound(bani * observedFactor, 100n, 'ceiling');

export class Autonomy {
  constructor(
    private readonly db: Database,
    private readonly proposals: Proposals,
    private readonly policies: PostingPolicies,
    private readonly templates: Templates,
    private readonly clock: () => number,
  ) {}

  /** A template's graduation report: deterministic for the same books. */
  async report(tx: Transaction, companyId: string, templateId: string) {
    const row = await this.templates.latest(tx, companyId, templateId);
    requireCondition(row, 'TEMPLATE_NOT_FOUND', 'Șablonul nu este disponibil.', 404);
    const criteria = await criteriaOf(tx, companyId);
    const { outcomes } = await this.templates.outcomes(tx, companyId, templateId, row.version);
    const track = graduation(outcomes, criteria);
    // What was decided only: a document arriving before the person approves the request does
    // not make its preview stale.
    const counts = { correct: 0, corrected: 0, rejected: 0 };
    for (const item of outcomes) if (item.outcome !== 'pending') counts[item.outcome]++;
    // The facts people stated that the counted run relied on (a vehicle's use): the policy is
    // bound to them, and a changed answer demotes it.
    const answers =
      outcomes
        .filter((item) => item.outcome === 'correct' && item.basis === track.basis)
        .at(-1)
        ?.answers.map((fact) => ({
          questionId: fact.questionId,
          kind: fact.kind,
          subject: fact.subject,
          value: fact.value as JsonValue,
          valueHash: fact.valueHash,
        })) ?? [];
    return {
      template: {
        id: row.id,
        version: row.version,
        name: row.name,
        treatment: row.treatmentId,
        partyId: row.partyId,
        documentKind: row.documentKind,
        mapping: JSON.parse(row.mapping) as JsonValue,
      },
      criteria: {
        minCorrect: criteria.minCorrect,
        minMonths: criteria.minMonths,
        policyDays: criteria.policyDays,
      },
      counts,
      met: track.met,
      failing: track.failing,
      rulesHash: track.rulesHash,
      answers,
      correct: track.correct,
      months: track.months,
      observed: track.observed
        ? {
            min: ron(track.observed.min),
            max: ron(track.observed.max),
            maxPerMonth: track.observed.maxPerMonth,
          }
        : null,
    };
  }

  /** The policy a report proposes: bound to the template version and the report, limited to its
   * partner and to the amounts observed, never on an extracted document or a warning. */
  proposedPolicy(report: GraduationReport, reportHash: string, today: string, name?: string) {
    const { template } = report;
    const partyId = template.partyId;
    const treatment = templateScope.shape.treatment.parse(template.treatment);
    const max = report.observed ? parseMoney(report.observed.max, 'RON') : 0n;
    const conditions: (Precondition | false)[] = [
      { kind: 'template', id: template.id, version: template.version },
      { kind: 'graduation', reportHash },
      !!partyId && { kind: 'parties', ids: [partyId] },
      // A settlement booked to an account (bank fees) has no partner to know.
      !(
        treatment === 'bank.settle' &&
        (template.mapping as { settle?: string } | null)?.settle === 'account'
      ) && { kind: 'knownParty', minPosted: report.criteria.minMonths },
      !!partyId && { kind: 'withinObserved', factor: '1.50' },
      { kind: 'maxDocumentAmount', amount: ron(widened(max)) },
      { kind: 'monthlyCap', amount: ron(widened(max) * BigInt(report.observed?.maxPerMonth ?? 1)) },
      // Never what an agent read from a PDF or a photo.
      subjectKindOf(treatment) === 'document' && {
        kind: 'sourceAuthority',
        allow: ['efactura', 'issued', 'ubl_upload', 'invoicer'],
      },
      // The answers it graduated on (a vehicle's use): another answer is a person's to look at.
      report.answers.length > 0 && {
        kind: 'answers',
        answers: report.answers.map(({ questionId, valueHash }) => ({ questionId, valueHash })),
      },
      { kind: 'noWarnings' },
    ];
    const preconditions = conditions.filter((item): item is Precondition => item !== false);
    return {
      name: name ?? `Șablonul ${template.name}`,
      treatments: [template.treatment],
      rulesHashes: report.rulesHash ? [report.rulesHash] : [],
      preconditions,
      validFrom: today,
      expiresInDays: report.criteria.policyDays,
    };
  }

  /** The reviewed request of a policy from a template's graduation report. */
  requestHandler(): ActionHandler<PolicyRequest> {
    return {
      // Its kind is the operation that requests it.
      operation: 'policies.request',
      request: 'policies.request',
      permission: 'write',
      input: policyRequestInput,
      preview: async (tx, companyId, input) => {
        const report = await this.report(tx, companyId, input.templateId);
        const reportHash = hashOf(report);
        // Valid for what is dated from the start of the month the request is made in.
        const policy = this.proposedPolicy(
          report,
          reportHash,
          `${bucharestDate(this.clock()).slice(0, 7)}-01`,
          input.name,
        );
        this.policies.validate(policy.treatments);
        const findings = report.met
          ? []
          : [
              {
                code: 'GRADUATION',
                severity: 'block',
                message: `Șablonul nu a îndeplinit criteriile: ${report.failing.join(', ')}.`,
                items: report.failing,
              },
            ];
        const preview = { report, reportHash, policy, findings };
        return { blocking: !report.met, preview: JSON.parse(canonical(preview)) as JsonValue };
      },
      execute: async (tx, actor, _input, requestId, preview, { decision }) => {
        const { policy } = preview as {
          policy: Omit<PolicyInput, 'expiresAt'> & { expiresInDays: number };
        };
        const { expiresInDays, ...rest } = policy;
        const created = await this.policies.insert(
          tx,
          actor.companyId,
          { ...rest, expiresAt: new Date(this.clock() + expiresInDays * 86_400_000).toISOString() },
          { userId: decision.decidedBy, epoch: decision.decidedEpoch },
          requestId,
        );
        await this.policies.sweepAfter(tx, actor.companyId, created.id);
        return { policyId: created.id, expiresAt: created.expiresAt };
      },
    };
  }

  /**
   * The open proposals a new policy covers, posted in the system's name when a re-evaluation
   * gives their version's effect hash and every condition holds; each in its own transaction.
   */
  sweepJob(): JobHandler {
    return {
      kind: 'policies.sweep',
      interrupted: 'Aplicarea politicii asupra propunerilor deschise a fost întreruptă.',
      run: async (job, lease) => {
        const { policyId } = job.params as { policyId: string };
        const [policy] = await this.db.read((tx) =>
          tx
            .select()
            .from(postingPolicies)
            .where(
              and(eq(postingPolicies.companyId, job.companyId), eq(postingPolicies.id, policyId)),
            ),
        );
        if (!policy) return { posted: 0, left: 0 };
        const open = await this.db.read((tx) =>
          this.proposals.openOf(tx, job.companyId, JSON.parse(policy.treatments) as string[], 1000),
        );
        const actor = { actorId: SYSTEM_PRINCIPAL, companyId: job.companyId };
        let posted = 0;
        const left: Record<string, number> = {};
        for (const [index, proposalId] of open.entries()) {
          if (index && index % 20 === 0) await lease.renew();
          const result = await this.proposals.sweepOne(actor, policyId, proposalId);
          if (result.posted) posted++;
          else left[result.reason] = (left[result.reason] ?? 0) + 1;
        }
        await this.db.write((tx) =>
          appendAudit(tx, {
            companyId: job.companyId,
            actorId: SYSTEM_PRINCIPAL,
            action: 'policies.swept',
            body: { policyId, posted, left },
          }),
        );
        return { posted, left };
      },
    };
  }

  // Demotions

  /** The policies bound to a template, for a reason: each paused by the system. */
  private async demoteBound(
    tx: Transaction,
    companyId: string,
    templateId: string,
    trigger: DemotionTrigger,
    reason: string,
    details: Record<string, unknown>,
  ) {
    for (const policy of await this.policies.boundTo(tx, companyId, templateId))
      await demote(tx, companyId, policy.id, trigger, reason, { templateId, ...details });
  }

  /**
   * Pauses, in the system's name, the policies events show at fault: a policy's posting being
   * reversed; a template's proposal corrected (a person's revision dropping the template, or a
   * posting that differs from its prediction); a proposal a policy's template covers whose
   * partner is new or whose amount is unusual for the policy.
   */
  async demotions(companyId: string, events: AuditEvent[]) {
    // Nothing to demote in a company without posting policies.
    const [any] = await this.db.read((tx) =>
      tx
        .select({ id: postingPolicies.id })
        .from(postingPolicies)
        .where(eq(postingPolicies.companyId, companyId))
        .limit(1),
    );
    if (!any) return true;
    for (const event of events) {
      if (event.actorId === SYSTEM_PRINCIPAL && event.operation !== 'policies.applied') continue;
      const proposalIds = event.refs.filter((ref) => ref.kind === 'proposal').map((ref) => ref.id);
      // A reversal of an entry a policy posted.
      if (/^ledger\.reverse\.(propose|revise)$/.test(event.operation))
        for (const ref of event.refs.filter((item) => item.kind === 'entry'))
          await this.db.write(async (tx) => {
            const [entry] = await tx
              .select({ policyId: entries.policyId, proposalId: entries.proposalId })
              .from(entries)
              .where(and(eq(entries.companyId, companyId), eq(entries.id, ref.id)));
            if (entry?.policyId)
              await demote(
                tx,
                companyId,
                entry.policyId,
                'reversal',
                'O înregistrare contabilizată automat de politică este stornată.',
                { entryId: ref.id, proposalId: entry.proposalId },
              );
          });
      if (!proposalIds.length) continue;
      // A person's revision that no longer cites the template the previous version cited.
      if (/\.revise$/.test(event.operation) && !event.agentId)
        await this.db.write(async (tx) => {
          for (const proposalId of proposalIds) {
            const versions = await tx
              .select({ version: proposalVersions.version, basis: proposalVersions.basis })
              .from(proposalVersions)
              .where(
                and(
                  eq(proposalVersions.companyId, companyId),
                  eq(proposalVersions.proposalId, proposalId),
                ),
              )
              .orderBy(sql`${proposalVersions.version} desc`)
              .limit(2);
            const [now, before] = versions.map((row) =>
              row.basis ? (JSON.parse(row.basis) as Basis).template : undefined,
            );
            if (before && now?.id !== before.id)
              await this.demoteBound(
                tx,
                companyId,
                before.id,
                'correction',
                'O persoană a corectat o propunere făcută după șablon.',
                { proposalId },
              );
          }
        });
      // A posting that differs from what a template predicted for its subject.
      if (/^(ledger\.post|actions\.execute|policies\.applied)$/.test(event.operation))
        await this.db.write(async (tx) => {
          const subjects = (
            await tx
              .select({ subject: proposals.subjectKey })
              .from(proposals)
              .where(and(eq(proposals.companyId, companyId), inArray(proposals.id, proposalIds)))
          ).map((row) => row.subject);
          for (const corrected of await this.templates.correctedBy(
            tx,
            companyId,
            subjects,
            proposalIds,
          ))
            await this.demoteBound(
              tx,
              companyId,
              corrected.templateId,
              'correction',
              'Ce s-a contabilizat diferă de ce a prevăzut șablonul.',
              { proposalId: corrected.proposalId, subject: corrected.subject },
            );
        });
      // A new partner or an unusual amount within a template a policy is bound to.
      if (/\.(propose|revise)$/.test(event.operation))
        await this.db.write(async (tx) => {
          for (const proposalId of proposalIds) await this.unusual(tx, companyId, proposalId);
        });
    }
    return true;
  }

  /**
   * Pauses the policies whose template's scope holds an open proposal that the policy refuses for
   * a reason a person should look at: a new partner, an amount outside what was observed, or a
   * fact people stated that changed since the template graduated (a vehicle's use). Only what the
   * template itself covers counts: its treatment, document kind or direction, words and partner.
   * A template of one partner covers only that partner's documents (for a movement, the
   * settlements booking that partner), so another supplier's invoice never demotes its policy,
   * and a new partner matters only to a template of any partner.
   */
  private async unusual(tx: Transaction, companyId: string, proposalId: string) {
    const [proposal] = await tx
      .select()
      .from(proposals)
      .where(and(eq(proposals.companyId, companyId), eq(proposals.id, proposalId)));
    if (!proposal) return;
    const [posted] = await tx
      .select({ id: entries.id })
      .from(entries)
      .where(and(eq(entries.companyId, companyId), eq(entries.proposalId, proposalId)));
    if (posted) return;
    const [version] = await tx
      .select()
      .from(proposalVersions)
      .where(
        and(eq(proposalVersions.companyId, companyId), eq(proposalVersions.proposalId, proposalId)),
      )
      .orderBy(sql`${proposalVersions.version} desc`)
      .limit(1);
    if (!version || version.blocking || !version.effect) return;
    const input = JSON.parse(version.input) as unknown;
    const active = (await this.templates.active(tx, companyId)).filter(
      (row) => row.treatmentId === proposal.treatmentId,
    );
    let evaluated: Evaluated | null | undefined;
    const evaluate = async () => {
      if (evaluated !== undefined) return evaluated;
      const treatment = this.proposals.treatment(proposal.treatmentId);
      const result = await this.proposals.evaluate(
        tx,
        companyId,
        proposalId,
        treatment,
        treatment.input.parse(input),
        version.basis ? (JSON.parse(version.basis) as Basis) : null,
      );
      evaluated = result.effect ? result : null;
      return evaluated;
    };
    for (const template of active) {
      const definition: TemplateDefinition = {
        scope: templateScope.parse(JSON.parse(template.scope)),
        mapping: JSON.parse(template.mapping),
      };
      const policies = await this.policies.boundTo(tx, companyId, template.id);
      if (!policies.length) continue;
      const subject = await this.subjectOfInput(tx, companyId, definition, input);
      if (!subject || !inScope(definition, subject)) continue;
      const partner = definition.scope.partyId;
      // A movement's partner is the one whose open item it settles: what the entry books.
      if (subject.kind === 'movement' && partner) {
        const current = await evaluate();
        if (!current || !effectParties(current.effect!).includes(partner)) continue;
      }
      const current = await evaluate();
      if (!current) return;
      for (const policy of policies) {
        const failing = await this.policies.failing(tx, companyId, policy, {
          treatmentId: proposal.treatmentId,
          input,
          evaluated: current,
          work: { createdBy: version.createdBy, agentId: version.agentId },
        });
        const trigger: DemotionTrigger | null =
          !partner && (failing.includes('knownParty') || failing.includes('parties'))
            ? 'new_party'
            : failing.includes('withinObserved') || failing.includes('maxDocumentAmount')
              ? 'unusual_amount'
              : failing.includes('answers')
                ? 'changed_answer'
                : null;
        if (trigger)
          await demote(
            tx,
            companyId,
            policy.id,
            trigger,
            trigger === 'new_party'
              ? 'A apărut un partener nou în aria șablonului politicii.'
              : trigger === 'unusual_amount'
                ? 'A apărut o sumă neobișnuită în aria șablonului politicii.'
                : 'S-a schimbat un răspuns pe care se sprijinea politica (de exemplu folosirea unui vehicul): o persoană verifică noile înregistrări.',
            { templateId: template.id, proposalId },
          );
      }
    }
  }

  private async subjectOfInput(
    tx: Transaction,
    companyId: string,
    definition: TemplateDefinition,
    input: unknown,
  ) {
    const named = (field: string) =>
      typeof input === 'object' && input !== null && field in input
        ? (input as Record<string, unknown>)[field]
        : undefined;
    const id = named(
      subjectKindOf(definition.scope.treatment) === 'document' ? 'documentId' : 'movementId',
    );
    if (typeof id !== 'string') return null;
    return subjectKindOf(definition.scope.treatment) === 'document'
      ? this.templates.documentSubject(tx, companyId, id)
      : this.templates.movementSubject(tx, companyId, definition, id);
  }

  // The worklist

  /**
   * Recurring partner and treatment pairs without a template: at least three posted bookings
   * that stand (reversed ones aside) in at least two months, of a document treatment by the
   * document's partner, of a settlement by the partner it settled; each with the latest posted
   * input to start a template from.
   */
  async candidates(tx: Transaction, companyId: string) {
    const rows = await tx.all<{
      treatment_id: string;
      party_id: string;
      kind: string;
      posted: number | bigint;
      months: number | bigint;
      input_json: string;
    }>(sql`
      with booked as (
        select q.treatment_id, d.party_id, d.kind, e.period, e.seq, q.id as proposal_id, e.version
        from acc_proposals q
        join acc_entries e on e.company_id = q.company_id and e.proposal_id = q.id
        join acc_documents d on d.company_id = q.company_id and d.id = q.document_id
        where q.company_id = ${companyId} and q.treatment_id = 'invoices.recognize'
          and d.party_id is not null and ${entryStands('e')}
        union all
        select q.treatment_id, l.party_id,
          case when exists (select 1 from acc_lines b where b.company_id = e.company_id and b.entry_id = e.id
            and b.side = 'C' and b.account like '512%') then 'movement.paid' else 'movement.received' end,
          e.period, e.seq, q.id, e.version
        from acc_proposals q
        join acc_entries e on e.company_id = q.company_id and e.proposal_id = q.id
        join acc_lines l on l.company_id = e.company_id and l.entry_id = e.id and l.party_id is not null
          and l.open_item_id is not null
        where q.company_id = ${companyId} and q.treatment_id = 'bank.settle' and ${entryStands('e')}
        group by q.id
      )
      select b.treatment_id, b.party_id, b.kind, count(*) as posted, count(distinct b.period) as months,
        (select v.input_json from booked c join acc_proposal_versions v on v.company_id = ${companyId}
          and v.proposal_id = c.proposal_id and v.version = c.version
          where c.treatment_id = b.treatment_id and c.party_id = b.party_id and c.kind = b.kind
          order by c.seq desc limit 1) as input_json
      from booked b
      where not exists (select 1 from acc_templates t where t.company_id = ${companyId}
        and t.treatment_id = b.treatment_id and t.party_id = b.party_id and t.document_kind = b.kind
        and not exists (select 1 from acc_template_revocations r where r.company_id = t.company_id
          and r.template_id = t.id))
      group by b.treatment_id, b.party_id, b.kind
      having count(*) >= 3 and count(distinct b.period) >= 2
      order by b.treatment_id, b.party_id, b.kind`);
    return rows.map((row) => {
      const input = JSON.parse(row.input_json) as Record<string, JsonValue>;
      // The latest posting's account to start from, with its vehicle when it named one (the
      // deduction then follows the answer about it); a settlement matches by invoice number.
      const mapping: JsonValue =
        row.treatment_id === 'bank.settle'
          ? { settle: 'openItem', match: 'number' }
          : typeof input.account !== 'string'
            ? null
            : typeof input.vehicle === 'string'
              ? { account: input.account, vehicle: input.vehicle }
              : { account: input.account, deduction: input.deduction ?? 'full' };
      return {
        treatment: row.treatment_id,
        partyId: row.party_id,
        documentKind: row.kind,
        posted: Number(row.posted),
        months: Number(row.months),
        mapping,
      };
    });
  }

  /** Templates whose report meets the criteria and that no unexpired policy is bound to at
   * their current version, nor a pending request. */
  async graduations(tx: Transaction, companyId: string) {
    const found = [];
    for (const template of await this.templates.active(tx, companyId)) {
      const bound = (await this.policies.boundTo(tx, companyId, template.id)).some((policy) =>
        (JSON.parse(policy.preconditions) as Precondition[]).some(
          (condition) => condition.kind === 'template' && condition.version === template.version,
        ),
      );
      if (bound) continue;
      const [pending] = await tx.all<{ id: string }>(sql`
        select r.id from acc_action_requests r
        where r.company_id = ${companyId} and r.operation = 'policies.request'
          and json_extract(r.input_json, '$.templateId') = ${template.id}
          and not exists (select 1 from acc_action_decisions d where d.company_id = r.company_id
            and d.request_id = r.id and d.decision = 'reject')
          and not exists (select 1 from acc_action_executions x where x.company_id = r.company_id
            and x.request_id = r.id)
        limit 1`);
      if (pending) continue;
      const report = await this.report(tx, companyId, template.id);
      if (report.met) found.push({ template: report.template, report });
    }
    return found;
  }
}

/** The worker's projector that demotes policies. */
export function demotionProjector(autonomy: Autonomy): Projector {
  return {
    name: 'automation.demotion',
    project: (companyId, events) => autonomy.demotions(companyId, events),
  };
}
