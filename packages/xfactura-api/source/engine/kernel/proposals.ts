import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, notExists } from 'drizzle-orm';
import { requireCondition } from 'xfactura-core/errors';
import { canonical, derivedId, hashOf } from 'xfactura-core/hash';
import {
  financialYearOf,
  validateEffect,
  type Effect,
  type Issue,
  type Loaded,
  type ReadSetEntry,
  type Treatment,
} from 'xfactura-core/kernel';
import {
  RuleContext,
  RuleGapError,
  type ParameterRegister,
  type UseMode,
} from 'xfactura-core/rules';
import type { Transaction } from '../db/database';
import {
  approvals,
  entries,
  periodEvents,
  profileFacts,
  proposals,
  proposalVersions,
  taxPeriodEvents,
  withdrawals,
} from '../db/schema';
import type { Actor, Commands } from './commands';
import { writeEntry } from './ledger';
import { loadAccounts, loadState, mergeStates } from './state';
import { viewEffect, type ProposalView, type StoredEffect } from './views';
import type { PostingPolicies } from './policies';

const assurance: Record<string, UseMode> = {
  preview: 'preview',
  shadow: 'shadow',
  live: 'posting',
};

export interface Evaluated {
  effect: Effect | null;
  issues: Issue[];
  readSet: ReadSetEntry[];
  rules: { mode: UseMode; used: { id: string; status: string; attestationId?: string }[] };
  rulesHash: string;
  effectHash: string;
  blocking: boolean;
}

/** Replaces the refs a treatment used for new open items and schedules with stable ids. */
function resolveRefs(effect: Effect, proposalId: string): Effect {
  const items = new Map(
    effect.openItems.map((item) => [item.ref, derivedId(proposalId, 'openItem', item.ref)]),
  );
  const resolve = (reference: string | undefined) =>
    reference === undefined ? undefined : (items.get(reference) ?? reference);
  return {
    ...effect,
    lines: effect.lines.map((line) =>
      line.openItem === undefined ? line : { ...line, openItem: resolve(line.openItem)! },
    ),
    openItems: effect.openItems.map((item) => ({ ...item, ref: items.get(item.ref)! })),
    schedules: effect.schedules.map((schedule) => ({
      ...schedule,
      ref: schedule.version === 1 ? derivedId(proposalId, 'schedule', schedule.ref) : schedule.ref,
      openItem: resolve(schedule.openItem)!,
    })),
  };
}

function accountCodes(effect: Effect) {
  return [
    ...new Set([
      ...effect.lines.map((line) => line.account),
      ...effect.schedules.flatMap((schedule) => schedule.rows.map((row) => row.counterAccount)),
    ]),
  ];
}

const block = (code: string, message: string, details?: Issue['details']): Issue => ({
  code,
  severity: 'block',
  message,
  ...(details === undefined ? {} : { details }),
});

export class Proposals {
  private readonly treatments = new Map<string, Treatment>();

  constructor(
    private readonly commands: Commands,
    private readonly register: ParameterRegister,
    private readonly policies: PostingPolicies,
  ) {}

  addTreatment(...treatments: Treatment[]) {
    for (const treatment of treatments) this.treatments.set(treatment.id, treatment);
  }

  treatment(id: string) {
    const treatment = this.treatments.get(id);
    requireCondition(treatment, 'TREATMENT', 'Tratamentul contabil nu este disponibil.', 404);
    return treatment;
  }

  allTreatments() {
    return [...this.treatments.values()];
  }

  private async mode(tx: Transaction, companyId: string): Promise<UseMode> {
    const [fact] = await tx
      .select({ value: profileFacts.value })
      .from(profileFacts)
      .where(and(eq(profileFacts.companyId, companyId), eq(profileFacts.axis, 'books.assurance')))
      .orderBy(desc(profileFacts.effectiveFrom), desc(profileFacts.createdAt))
      .limit(1);
    return assurance[fact?.value ?? 'preview'] ?? 'preview';
  }

  /** Issues about where the entry would land, found before anyone approves it. */
  private async placement(tx: Transaction, companyId: string, effect: Effect, loaded: Loaded) {
    const issues: Issue[] = [];
    if (!financialYearOf(loaded, effect.date))
      issues.push(block('FINANCIAL_YEAR', 'Data nu aparține unui exercițiu financiar configurat.'));
    const [period] = await tx
      .select({ kind: periodEvents.kind })
      .from(periodEvents)
      .where(
        and(eq(periodEvents.companyId, companyId), eq(periodEvents.month, effect.date.slice(0, 7))),
      )
      .orderBy(desc(periodEvents.seq))
      .limit(1);
    if (period?.kind === 'close') issues.push(block('PERIOD_CLOSED', 'Luna este închisă.'));
    const periods = [
      ...new Set(effect.taxEntries.map((entry) => `${entry.tax}/${entry.taxPeriod}`)),
    ];
    for (const key of periods) {
      const [tax, taxPeriod] = key.split('/') as [string, string];
      if (taxPeriod === 'null') continue;
      const [event] = await tx
        .select({ kind: taxPeriodEvents.kind })
        .from(taxPeriodEvents)
        .where(
          and(
            eq(taxPeriodEvents.companyId, companyId),
            eq(taxPeriodEvents.tax, tax),
            eq(taxPeriodEvents.period, taxPeriod),
          ),
        )
        .orderBy(desc(taxPeriodEvents.seq))
        .limit(1);
      if (event?.kind === 'lock')
        issues.push(block('TAX_PERIOD_LOCKED', `Perioada fiscală ${taxPeriod} a fost declarată.`));
    }
    return issues;
  }

  /** Evaluates a treatment for a proposal: deterministic for the same input and state. */
  async evaluate(
    tx: Transaction,
    companyId: string,
    proposalId: string,
    treatment: Treatment,
    input: unknown,
  ): Promise<Evaluated> {
    let state = await loadState(tx, companyId, treatment.plan(input));
    const followUp = treatment.followUp?.(input, state.loaded);
    if (followUp) state = mergeStates(state, await loadState(tx, companyId, followUp));
    const { loaded, readSet } = state;
    const mode = await this.mode(tx, companyId);
    const rules = new RuleContext(this.register, mode);
    let effect: Effect | null = null;
    const issues: Issue[] = [];
    try {
      const evaluation = treatment.evaluate(input, loaded, rules);
      issues.push(...evaluation.issues);
      effect = evaluation.effect && resolveRefs(evaluation.effect, proposalId);
    } catch (error) {
      if (!(error instanceof RuleGapError)) throw error;
      issues.push(block('RULE_GAP', error.message, { ...error.gap }));
    }
    if (effect) {
      const accounts = await loadAccounts(tx, companyId, accountCodes(effect));
      issues.push(
        ...validateEffect(effect, {
          account: (code) => accounts.get(code),
          openItem: (id) => loaded.openItems.get(id),
        }),
        ...(await this.placement(tx, companyId, effect, loaded)),
      );
    }
    const used = [...rules.used]
      .map(([id, use]) => ({
        id,
        status: use.status,
        ...(use.attestationId ? { attestationId: use.attestationId } : {}),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const rulesRecord = { mode, used };
    // Policies bind to the treatment version and the parameter versions it relied on.
    const rulesHash = hashOf({
      treatment: treatment.id,
      version: treatment.version,
      parameters: used.map((use) => use.id),
    });
    const effectHash = hashOf({
      treatment: treatment.id,
      version: treatment.version,
      input,
      readSet,
      rules: rulesRecord,
      effect,
      issues,
    });
    return {
      effect,
      issues,
      readSet,
      rules: rulesRecord,
      rulesHash,
      effectHash,
      blocking: issues.some((issue) => issue.severity === 'block'),
    };
  }

  /** Proposes a treatment, or revises an open proposal of the same subject. */
  async propose(
    actor: Actor,
    key: string,
    treatmentId: string,
    rawInput: unknown,
    revision?: { proposalId: string; version: number },
  ) {
    const treatment = this.treatment(treatmentId);
    const input = treatment.input.parse(rawInput);
    const operation = `${treatment.id}.${revision ? 'revise' : 'propose'}`;
    return this.commands.run(
      actor,
      key,
      operation,
      { input, revision: revision ?? null },
      'write',
      async (tx) => {
        const subjectKey = treatment.subject(input);
        // The open proposal for this subject, if any; a withdrawal frees the subject.
        const [existing] = await tx
          .select()
          .from(proposals)
          .where(
            and(
              eq(proposals.companyId, actor.companyId),
              eq(proposals.subjectKey, subjectKey),
              notExists(
                tx
                  .select({ id: withdrawals.proposalId })
                  .from(withdrawals)
                  .where(
                    and(
                      eq(withdrawals.companyId, proposals.companyId),
                      eq(withdrawals.proposalId, proposals.id),
                    ),
                  ),
              ),
            ),
          );
        const latest = existing
          ? await this.latestVersion(tx, actor.companyId, existing.id)
          : undefined;
        let proposalId: string;
        if (revision) {
          requireCondition(
            existing && existing.id === revision.proposalId,
            'SUBJECT_MISMATCH',
            'Revizuirea trebuie să păstreze obiectul propunerii.',
            409,
          );
          requireCondition(
            latest?.version === revision.version,
            'STALE',
            'Propunerea s-a schimbat. Reîncărcați datele.',
            409,
          );
          proposalId = existing.id;
        } else if (existing) {
          requireCondition(
            latest?.input === canonical(input),
            'SUBJECT_EXISTS',
            'Există deja o propunere pentru acest obiect. Revizuiți propunerea existentă.',
            409,
            { proposalId: existing.id, version: latest?.version ?? 0 },
          );
          return this.view(tx, actor.companyId, existing.id);
        } else {
          proposalId = randomUUID();
          await tx.insert(proposals).values({
            id: proposalId,
            companyId: actor.companyId,
            treatmentId: treatment.id,
            subjectKey,
            createdBy: actor.actorId,
          });
        }
        const version = (latest?.version ?? 0) + 1;
        const evaluated = await this.evaluate(tx, actor.companyId, proposalId, treatment, input);
        await tx.insert(proposalVersions).values({
          companyId: actor.companyId,
          proposalId,
          version,
          treatmentVersion: treatment.version,
          input: canonical(input),
          readSet: canonical(evaluated.readSet),
          rules: canonical(evaluated.rules),
          rulesHash: evaluated.rulesHash,
          effect: evaluated.effect ? canonical(evaluated.effect) : null,
          issues: canonical(evaluated.issues),
          blocking: evaluated.blocking,
          effectHash: evaluated.effectHash,
          entryDate: evaluated.effect?.date ?? null,
          createdBy: actor.actorId,
          agentId: actor.agentId ?? null,
        });
        if (!evaluated.blocking) {
          const policy = await this.policies.match(tx, actor.companyId, treatment.id, evaluated);
          if (policy)
            await this.write(tx, actor, proposalId, version, evaluated, { policyId: policy.id });
        }
        return this.view(tx, actor.companyId, proposalId);
      },
    );
  }

  /** Human approval of one exact version, including every warning it carries. */
  async approve(
    actor: Actor,
    key: string,
    input: { proposalId: string; version: number; effectHash: string; acknowledge: string[] },
  ) {
    requireCondition(!actor.agentId, 'AGENT_SCOPE', 'Aprobarea aparține unei persoane.', 403);
    return this.commands.run(
      actor,
      key,
      'proposals.approve',
      input,
      'review',
      async (tx, access) => {
        const row = await this.current(tx, actor.companyId, input.proposalId, input.version);
        requireCondition(
          row.effectHash === input.effectHash,
          'STALE',
          'Versiunea verificată nu mai este actuală.',
          409,
        );
        requireCondition(
          !row.blocking,
          'BLOCKING_ISSUES',
          'Propunerea are probleme care împiedică aprobarea.',
          409,
        );
        const required = (JSON.parse(row.issues) as Issue[])
          .filter((issue) => issue.severity === 'ack')
          .map((issue) => issue.code);
        requireCondition(
          required.every((code) => input.acknowledge.includes(code)),
          'ACKNOWLEDGEMENT_REQUIRED',
          'Confirmați fiecare avertisment al propunerii înainte de aprobare.',
          409,
          { required },
        );
        const [existing] = await tx
          .select()
          .from(approvals)
          .where(
            and(
              eq(approvals.companyId, actor.companyId),
              eq(approvals.proposalId, input.proposalId),
              eq(approvals.version, input.version),
            ),
          );
        if (!existing)
          await tx.insert(approvals).values({
            id: randomUUID(),
            companyId: actor.companyId,
            proposalId: input.proposalId,
            version: input.version,
            effectHash: input.effectHash,
            approverId: actor.actorId,
            approverEpoch: access.epoch,
            acknowledgements: canonical([...new Set(input.acknowledge)].sort()),
          });
        return this.view(tx, actor.companyId, input.proposalId);
      },
    );
  }

  /** Posts an approved version after re-evaluating it against the current books. */
  async post(
    actor: Actor,
    key: string,
    input: { proposalId: string; version: number; effectHash: string },
  ) {
    return this.commands.run(actor, key, 'ledger.post', input, 'review', async (tx) => {
      const [posted] = await tx
        .select({ id: entries.id })
        .from(entries)
        .where(
          and(eq(entries.companyId, actor.companyId), eq(entries.proposalId, input.proposalId)),
        );
      if (posted) return this.view(tx, actor.companyId, input.proposalId);
      const row = await this.current(tx, actor.companyId, input.proposalId, input.version);
      requireCondition(
        row.effectHash === input.effectHash,
        'STALE',
        'Versiunea verificată nu mai este actuală.',
        409,
      );
      const [approval] = await tx
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, actor.companyId),
            eq(approvals.proposalId, input.proposalId),
            eq(approvals.version, input.version),
            eq(approvals.effectHash, input.effectHash),
          ),
        );
      requireCondition(
        approval,
        'APPROVAL_REQUIRED',
        'Aprobați versiunea exactă înainte de contabilizare.',
        409,
      );
      const [proposal] = await tx
        .select()
        .from(proposals)
        .where(and(eq(proposals.companyId, actor.companyId), eq(proposals.id, input.proposalId)));
      const treatment = this.treatment(proposal!.treatmentId);
      // Re-parsing must reproduce the stored input exactly; a non-idempotent schema shows up as STALE.
      const stored = treatment.input.parse(JSON.parse(row.input));
      const evaluated = await this.evaluate(
        tx,
        actor.companyId,
        input.proposalId,
        treatment,
        stored,
      );
      requireCondition(
        evaluated.effectHash === row.effectHash,
        'STALE',
        'Registrele s-au schimbat de la aprobare. Revizuiți propunerea.',
        409,
        { issues: evaluated.issues },
      );
      await this.write(tx, actor, input.proposalId, input.version, evaluated, {
        approvalId: approval.id,
      });
      return this.view(tx, actor.companyId, input.proposalId);
    });
  }

  async withdraw(actor: Actor, key: string, input: { proposalId: string; reason: string }) {
    return this.commands.run(actor, key, 'proposals.withdraw', input, 'write', async (tx) => {
      await this.current(tx, actor.companyId, input.proposalId);
      await tx.insert(withdrawals).values({
        companyId: actor.companyId,
        proposalId: input.proposalId,
        reason: input.reason,
        createdBy: actor.actorId,
      });
      return this.view(tx, actor.companyId, input.proposalId);
    });
  }

  /** Writes the evaluated effect; the database invariants verify it once more. */
  private async write(
    tx: Transaction,
    actor: Actor,
    proposalId: string,
    version: number,
    evaluated: Evaluated,
    binding: { approvalId: string } | { policyId: string },
  ) {
    const effect = evaluated.effect!;
    const { loaded } = await loadState(tx, actor.companyId, {});
    const year = financialYearOf(loaded, effect.date);
    requireCondition(
      year,
      'FINANCIAL_YEAR',
      'Data nu aparține unui exercițiu financiar configurat.',
    );
    return writeEntry(
      tx,
      {
        companyId: actor.companyId,
        id: derivedId(proposalId, 'entry'),
        fiscalYearId: year.id,
        proposalId,
        version,
        ...binding,
        postedBy: actor.actorId,
        ...(actor.agentId ? { agentId: actor.agentId } : {}),
      },
      effect,
    );
  }

  private async latestVersion(tx: Transaction, companyId: string, proposalId: string) {
    const [row] = await tx
      .select()
      .from(proposalVersions)
      .where(
        and(eq(proposalVersions.companyId, companyId), eq(proposalVersions.proposalId, proposalId)),
      )
      .orderBy(desc(proposalVersions.version))
      .limit(1);
    return row;
  }

  /** The latest version of an open proposal; optionally it must be `version`. */
  private async current(tx: Transaction, companyId: string, proposalId: string, version?: number) {
    const row = await this.latestVersion(tx, companyId, proposalId);
    requireCondition(row, 'NOT_FOUND', 'Propunerea nu este disponibilă.', 404);
    requireCondition(
      version === undefined || row.version === version,
      'STALE',
      'Propunerea s-a schimbat. Reîncărcați datele.',
      409,
    );
    const [withdrawn] = await tx
      .select()
      .from(withdrawals)
      .where(and(eq(withdrawals.companyId, companyId), eq(withdrawals.proposalId, proposalId)));
    requireCondition(!withdrawn, 'WITHDRAWN', 'Propunerea a fost retrasă.', 409);
    const [posted] = await tx
      .select({ id: entries.id })
      .from(entries)
      .where(and(eq(entries.companyId, companyId), eq(entries.proposalId, proposalId)));
    requireCondition(!posted, 'ALREADY_POSTED', 'Propunerea este deja contabilizată.', 409);
    return row;
  }

  get(actor: Actor, proposalId: string) {
    return this.commands.read(actor, 'proposals.get', (tx) =>
      this.view(tx, actor.companyId, proposalId),
    );
  }

  /** Proposals in creation order, optionally only those in one status. */
  list(actor: Actor, input: { status?: ProposalView['status']; after?: string; limit: number }) {
    return this.commands.read(actor, 'proposals.list', async (tx) => {
      const rows = await tx
        .select()
        .from(proposals)
        .where(eq(proposals.companyId, actor.companyId))
        .orderBy(asc(proposals.createdAt), asc(proposals.id));
      const start = input.after ? rows.findIndex((row) => row.id === input.after) + 1 : 0;
      const views = (await this.views(tx, actor.companyId, rows.slice(start))).filter(
        (view) => !input.status || view.status === input.status,
      );
      const page = views.slice(0, input.limit);
      return { items: page, next: views.length > input.limit ? page.at(-1)!.id : null };
    });
  }

  async view(tx: Transaction, companyId: string, proposalId: string): Promise<ProposalView> {
    const [proposal] = await tx
      .select()
      .from(proposals)
      .where(and(eq(proposals.companyId, companyId), eq(proposals.id, proposalId)));
    requireCondition(proposal, 'NOT_FOUND', 'Propunerea nu este disponibilă.', 404);
    return (await this.views(tx, companyId, [proposal]))[0]!;
  }

  async views(tx: Transaction, companyId: string, rows: (typeof proposals.$inferSelect)[]) {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const versions = await tx
      .select()
      .from(proposalVersions)
      .where(
        and(eq(proposalVersions.companyId, companyId), inArray(proposalVersions.proposalId, ids)),
      );
    const latest = new Map<string, (typeof versions)[number]>();
    for (const version of versions)
      if ((latest.get(version.proposalId)?.version ?? 0) < version.version)
        latest.set(version.proposalId, version);
    const approvalRows = await tx
      .select()
      .from(approvals)
      .where(and(eq(approvals.companyId, companyId), inArray(approvals.proposalId, ids)));
    const entryRows = await tx
      .select({
        id: entries.id,
        proposalId: entries.proposalId,
        number: entries.number,
        seq: entries.seq,
      })
      .from(entries)
      .where(and(eq(entries.companyId, companyId), inArray(entries.proposalId, ids)));
    const withdrawn = new Set(
      (
        await tx
          .select({ proposalId: withdrawals.proposalId })
          .from(withdrawals)
          .where(and(eq(withdrawals.companyId, companyId), inArray(withdrawals.proposalId, ids)))
      ).map((row) => row.proposalId),
    );
    return rows.map((proposal): ProposalView => {
      const version = latest.get(proposal.id)!;
      const approval = approvalRows.find(
        (row) =>
          row.proposalId === proposal.id &&
          row.version === version.version &&
          row.effectHash === version.effectHash,
      );
      const entry = entryRows.find((row) => row.proposalId === proposal.id);
      const rules = JSON.parse(version.rules) as ProposalView['rules'];
      return {
        id: proposal.id,
        treatment: proposal.treatmentId,
        subject: proposal.subjectKey,
        status: entry
          ? 'posted'
          : withdrawn.has(proposal.id)
            ? 'withdrawn'
            : version.blocking
              ? 'blocked'
              : approval
                ? 'approved'
                : 'proposed',
        version: version.version,
        effectHash: version.effectHash,
        rulesHash: version.rulesHash,
        rules: { mode: rules.mode, used: rules.used.map(({ id, status }) => ({ id, status })) },
        issues: JSON.parse(version.issues),
        effect: version.effect ? viewEffect(JSON.parse(version.effect) as StoredEffect) : null,
        approval: approval
          ? { id: approval.id, approverId: approval.approverId, at: approval.createdAt }
          : null,
        entry: entry ? { id: entry.id, number: entry.number, seq: entry.seq } : null,
        createdBy: version.createdBy,
        agentId: version.agentId,
      };
    });
  }
}
