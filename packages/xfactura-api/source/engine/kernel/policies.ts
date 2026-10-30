import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { canonical } from 'xfactura-core/hash';
import { parseMoney, parseScaled } from 'xfactura-core/money';
import { authorities } from 'xfactura-core/documents/schemas';
import { effectAmount, effectParties } from 'xfactura-core/templates';
import type { Transaction } from '../db/database';
import {
  actionRequests,
  documents,
  memberships,
  policyRevocations,
  postingPolicies,
} from '../db/schema';
import { criteriaOf, pausedScopes, sweepAfter } from './automation';
import type { Actor, Commands } from './commands';
import { selfApproval, type Segregation, type Work } from './controls';
import type { Evaluated } from './proposals';

const decimal = z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/);

/**
 * Conditions an evaluated proposal must meet for a policy to post it without a person. A warning
 * (an `ack` issue) is posted only if an `acknowledges` condition names its code, as a person
 * names it when approving; `noWarnings` refuses every warning. `info` issues need neither. An
 * extracted document (read by an agent from a PDF or a photo) is never posted unless a
 * `sourceAuthority` condition allows `extracted`.
 */
export const preconditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('noWarnings') }).strict(),
  z
    .object({
      kind: z.literal('acknowledges'),
      codes: z
        .array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/))
        .min(1)
        .max(50),
    })
    .strict(),
  z.object({ kind: z.literal('maxLineAmount'), amount: decimal }).strict(),
  z
    .object({
      kind: z.literal('accountsWithin'),
      prefixes: z.array(z.string().regex(/^\d{1,4}/)).min(1),
    })
    .strict(),
  /** Every partner the entry books is one of these. */
  z.object({ kind: z.literal('parties'), ids: z.array(z.uuid()).min(1).max(50) }).strict(),
  /** The input is exactly what this template version makes of the document or movement. */
  z
    .object({ kind: z.literal('template'), id: z.uuid(), version: z.number().int().positive() })
    .strict(),
  /** The entry moves at most this much (its debits, in lei). */
  z.object({ kind: z.literal('maxDocumentAmount'), amount: decimal }).strict(),
  /** What the policy posts in the entry's month, this entry included, stays within this. */
  z.object({ kind: z.literal('monthlyCap'), amount: decimal }).strict(),
  /** The documents read come only from these sources; `extracted` must be named to be posted. */
  z
    .object({
      kind: z.literal('sourceAuthority'),
      allow: z.array(z.enum(authorities)).min(1).max(authorities.length),
    })
    .strict(),
  /** Every partner the entry books has at least this many posted entries already. */
  z
    .object({ kind: z.literal('knownParty'), minPosted: z.number().int().min(1).max(1000) })
    .strict(),
  /** The entry's amount lies within the amounts posted before for its treatment and partners,
   * widened by `factor` (between 1 and 9.99) each way. */
  z
    .object({
      kind: z.literal('withinObserved'),
      factor: z.string().regex(/^[1-9](\.\d{1,2})?$/),
    })
    .strict(),
  /** The policy was granted on this graduation report (`policies.request`). */
  z
    .object({ kind: z.literal('graduation'), reportHash: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict(),
  /** The version relies on exactly these facts people stated: each question its basis cites
   * with its answer's value (a hash of it), as when the template graduated (a vehicle's use). A
   * changed answer is not posted, and demotes the policy (`changed_answer`). */
  z
    .object({
      kind: z.literal('answers'),
      answers: z
        .array(
          z
            .object({ questionId: z.uuid(), valueHash: z.string().regex(/^[a-f0-9]{64}$/) })
            .strict(),
        )
        .min(1)
        .max(20),
    })
    .strict(),
]);
export type Precondition = z.infer<typeof preconditionSchema>;

export const policyInput = z
  .object({
    name: z.string().trim().min(3).max(200),
    treatments: z.array(z.string().min(1)).min(1).max(20),
    /** The exact treatment and parameter versions approved, from a reviewed proposal. */
    rulesHashes: z
      .array(z.string().regex(/^[a-f0-9]{64}$/))
      .min(1)
      .max(20),
    preconditions: z.array(preconditionSchema).max(20),
    validFrom: z.iso.date(),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type PolicyInput = z.infer<typeof policyInput>;

export const policyView = z.object({
  id: z.string(),
  name: z.string(),
  treatments: z.array(z.string()),
  rulesHashes: z.array(z.string()),
  preconditions: z.array(preconditionSchema),
  approvedBy: z.string(),
  validFrom: z.string(),
  expiresAt: z.string(),
  revoked: z.boolean(),
  /** Its scope, or the company's, or the template it is bound to, is paused. */
  paused: z.boolean(),
  /** The reviewed request (`policies.request`) it was granted by; null when created directly. */
  requestId: z.string().nullable(),
});

/** What a policy checks about one evaluated version. */
export type Candidate = {
  treatmentId: string;
  /** The version's input, as its treatment parses it. */
  input: unknown;
  evaluated: Evaluated;
  /** Who the version was created in the name of, and through which grant. */
  work: Work;
};

/** What only the templates know: whether an input is what a template version makes of its
 * document or movement, while the template stands. */
export interface TemplateFacts {
  conforms(
    tx: Transaction,
    companyId: string,
    template: { id: string; version: number },
    treatmentId: string,
    input: unknown,
  ): Promise<boolean>;
  /** The key of the facts an evaluated version relies on: each question its basis cites with
   * its answer's value hash, sorted by question (`basisKey`; `''` without any). */
  factsOf(tx: Transaction, companyId: string, evaluated: Evaluated): Promise<string>;
}

type PolicyRow = typeof postingPolicies.$inferSelect;

/** Operations a policy may never post through: returns, submissions and what reaches outside. */
const forbidden = /^(declarations|spv)\./;

export class PostingPolicies {
  private facts: TemplateFacts | undefined;

  constructor(
    private readonly commands: Commands,
    /** What the engine knows of a treatment: whether its proposals reach outside the engine. */
    private readonly treatment: (id: string) => { externalEffect: boolean } | undefined = () => ({
      externalEffect: false,
    }),
  ) {}

  /** Lets `template` conditions consult the templates. */
  useTemplates(facts: TemplateFacts) {
    this.facts = facts;
  }

  /**
   * A policy posts only treatments the engine knows, proposed and posted inside it: never a
   * return (`declarations.*`), an SPV submission or anything with an external effect. Matching a
   * bank payment that already happened (`bank.settle`) moves no money and is allowed.
   */
  validate(treatments: string[]) {
    const refused = treatments.filter(
      (id) => forbidden.test(id) || !this.treatment(id) || this.treatment(id)!.externalEffect,
    );
    requireCondition(
      !refused.length,
      'POLICY_TREATMENT',
      'O politică poate contabiliza automat doar tratamente contabile ale motorului: niciodată declarații, transmiteri către ANAF sau operațiuni cu efect în afara lui.',
      422,
      { treatments: refused },
    );
  }

  /** Writes a policy in the caller's transaction, approved by `approver` under `epoch`. */
  async insert(
    tx: Transaction,
    companyId: string,
    input: PolicyInput,
    approver: { userId: string; epoch: number },
    requestId: string | null = null,
  ) {
    this.validate(input.treatments);
    const expiresAt = Date.parse(input.expiresAt);
    const { policyDays } = await criteriaOf(tx, companyId);
    const now = this.commands.clock();
    requireCondition(
      expiresAt > now && expiresAt <= now + policyDays * 86_400_000,
      'POLICY_EXPIRY',
      `Alegeți o expirare în următoarele ${policyDays} de zile.`,
      422,
      { policyDays },
    );
    const id = this.commands.ids();
    await tx.insert(postingPolicies).values({
      id,
      companyId,
      name: input.name,
      treatments: canonical(input.treatments),
      rulesHashes: canonical(input.rulesHashes),
      preconditions: canonical(input.preconditions),
      approvedBy: approver.userId,
      approverEpoch: approver.epoch,
      validFrom: input.validFrom,
      expiresAt,
      requestId,
    });
    return {
      id,
      ...input,
      expiresAt: new Date(expiresAt).toISOString(),
      approvedBy: approver.userId,
      revoked: false,
      paused: false,
      requestId,
    };
  }

  /** Queues, in the system's name, a sweep of a new or resumed policy over the open proposals it
   * covers. */
  sweepAfter(tx: Transaction, companyId: string, policyId: string) {
    return sweepAfter(tx, companyId, policyId, this.commands.ids);
  }

  async create(actor: Actor, key: string, input: PolicyInput) {
    requireCondition(
      !actor.agentId,
      'AGENT_SCOPE',
      'Politicile de contabilizare aparțin unei persoane.',
      403,
    );
    return this.commands.run(actor, key, 'policies.create', input, 'review', async (tx, access) => {
      const created = await this.insert(tx, actor.companyId, input, {
        userId: actor.actorId,
        epoch: access.epoch,
      });
      await this.sweepAfter(tx, actor.companyId, created.id);
      return created;
    });
  }

  async revoke(actor: Actor, key: string, input: { id: string; reason: string }) {
    return this.commands.run(actor, key, 'policies.revoke', input, 'review', async (tx) => {
      const [policy] = await tx
        .select()
        .from(postingPolicies)
        .where(
          and(eq(postingPolicies.companyId, actor.companyId), eq(postingPolicies.id, input.id)),
        );
      requireCondition(policy, 'NOT_FOUND', 'Politica nu este disponibilă.', 404);
      const [revoked] = await tx
        .select()
        .from(policyRevocations)
        .where(
          and(
            eq(policyRevocations.companyId, actor.companyId),
            eq(policyRevocations.policyId, input.id),
          ),
        );
      if (!revoked)
        await tx.insert(policyRevocations).values({
          companyId: actor.companyId,
          policyId: input.id,
          reason: input.reason,
          createdBy: actor.actorId,
        });
      return { id: input.id, revoked: true as const };
    });
  }

  /** Every policy of the company, as callers see it. */
  async views(tx: Pick<Transaction, 'select'>, companyId: string) {
    const rows = await tx
      .select()
      .from(postingPolicies)
      .where(eq(postingPolicies.companyId, companyId))
      .orderBy(asc(postingPolicies.createdAt), asc(postingPolicies.id));
    const revoked = new Set(
      (
        await tx
          .select({ id: policyRevocations.policyId })
          .from(policyRevocations)
          .where(eq(policyRevocations.companyId, companyId))
      ).map((row) => row.id),
    );
    const paused = await pausedScopes(tx, companyId);
    return rows.map((row) => {
      const preconditions = JSON.parse(row.preconditions) as Precondition[];
      return {
        id: row.id,
        name: row.name,
        treatments: JSON.parse(row.treatments) as string[],
        rulesHashes: JSON.parse(row.rulesHashes) as string[],
        preconditions,
        approvedBy: row.approvedBy,
        validFrom: row.validFrom,
        expiresAt: new Date(row.expiresAt).toISOString(),
        revoked: revoked.has(row.id),
        paused: this.pausedFor(paused, row.id, preconditions),
        requestId: row.requestId,
      };
    });
  }

  list(actor: Actor) {
    return this.commands.read(actor, 'policies.list', (tx) => this.views(tx, actor.companyId));
  }

  /** Whether the company, the policy or the template it is bound to is paused. */
  private pausedFor(
    paused: Awaited<ReturnType<typeof pausedScopes>>,
    policyId: string,
    conditions: Precondition[],
  ) {
    return (
      paused.company ||
      paused.policies.has(policyId) ||
      conditions.some(
        (condition) => condition.kind === 'template' && paused.templates.has(condition.id),
      )
    );
  }

  /** What the policy posted in a month, in bani of debit. */
  private async postedInMonth(tx: Transaction, companyId: string, policyId: string, month: string) {
    const [row] = await tx.all<{ total: number | bigint | null }>(sql`
      select coalesce(sum(case when (l.side = 'D') = (l.bani > 0) then abs(l.bani) else 0 end), 0) as total
      from acc_entries e join acc_lines l on l.company_id = e.company_id and l.entry_id = e.id
      where e.company_id = ${companyId} and e.policy_id = ${policyId} and e.period = ${month}`);
    return BigInt(row?.total ?? 0);
  }

  /** How many entries post lines with each partner. */
  private async postedWith(tx: Transaction, companyId: string, partyIds: string[]) {
    const rows = await tx.all<{ party: string; entries: number | bigint }>(sql`
      select l.party_id as party, count(distinct l.entry_id) as entries from acc_lines l
      where l.company_id = ${companyId} and l.party_id in (${sql.join(
        partyIds.map((id) => sql`${id}`),
        sql`, `,
      )}) group by l.party_id`);
    return new Map(rows.map((row) => [row.party, Number(row.entries)]));
  }

  /** The smallest and largest amounts posted for a treatment with any of these partners,
   * reversed entries aside. */
  private async observed(
    tx: Transaction,
    companyId: string,
    treatmentId: string,
    partyIds: string[],
  ) {
    const parties = sql.join(
      partyIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const [row] = await tx.all<{ low: number | bigint | null; high: number | bigint | null }>(sql`
      select min(total) as low, max(total) as high from (
        select e.id, sum(case when (l.side = 'D') = (l.bani > 0) then abs(l.bani) else 0 end) as total
        from acc_entries e
        join acc_proposals p on p.company_id = e.company_id and p.id = e.proposal_id
        join acc_lines l on l.company_id = e.company_id and l.entry_id = e.id
        where e.company_id = ${companyId} and p.treatment_id = ${treatmentId}
          and exists (select 1 from acc_lines m where m.company_id = e.company_id
            and m.entry_id = e.id and m.party_id in (${parties}))
          and not exists (select 1 from acc_proposals r join acc_entries re
            on re.company_id = r.company_id and re.proposal_id = r.id
            where r.company_id = e.company_id and r.subject_key = 'reverse:' || e.id)
        group by e.id)`);
    return row?.low === null || row?.low === undefined
      ? null
      : { low: BigInt(row.low), high: BigInt(row.high!) };
  }

  /** The authority of each document the version read. */
  private async sources(tx: Transaction, companyId: string, evaluated: Evaluated) {
    const ids = evaluated.readSet
      .filter((entry) => entry.kind === 'document')
      .map((entry) => entry.id);
    if (!ids.length) return [];
    return (
      await tx
        .select({ authority: documents.authority })
        .from(documents)
        .where(and(eq(documents.companyId, companyId), inArray(documents.id, ids)))
    ).map((row) => row.authority ?? 'unknown');
  }

  /**
   * The conditions of a policy a version fails, by kind (empty when the policy may post it),
   * the implicit ones included: every warning acknowledged (`acknowledges`), and no extracted
   * document unless allowed (`sourceAuthority`).
   */
  async failing(tx: Transaction, companyId: string, policy: PolicyRow, candidate: Candidate) {
    const { evaluated } = candidate;
    const effect = evaluated.effect!;
    const conditions = JSON.parse(policy.preconditions) as Precondition[];
    const failed = new Set<string>();
    const acknowledged = new Set(
      conditions.flatMap((condition) => (condition.kind === 'acknowledges' ? condition.codes : [])),
    );
    if (evaluated.issues.some((issue) => issue.severity === 'ack' && !acknowledged.has(issue.code)))
      failed.add('acknowledges');
    const allowed = conditions.find((condition) => condition.kind === 'sourceAuthority');
    const sources = await this.sources(tx, companyId, evaluated);
    if (
      sources.some((source) =>
        allowed ? !(allowed.allow as string[]).includes(source) : source === 'extracted',
      )
    )
      failed.add('sourceAuthority');
    const amount = effectAmount(effect);
    const parties = effectParties(effect);
    for (const condition of conditions) {
      switch (condition.kind) {
        case 'noWarnings':
          if (evaluated.issues.some((issue) => issue.severity === 'ack'))
            failed.add(condition.kind);
          break;
        case 'acknowledges':
        case 'sourceAuthority':
          break;
        case 'maxLineAmount': {
          const limit = parseMoney(condition.amount, 'RON');
          if (effect.lines.some((line) => (line.bani < 0n ? -line.bani : line.bani) > limit))
            failed.add(condition.kind);
          break;
        }
        case 'accountsWithin':
          if (
            !effect.lines.every((line) =>
              condition.prefixes.some((prefix) => line.account.startsWith(prefix)),
            )
          )
            failed.add(condition.kind);
          break;
        case 'parties':
          if (!parties.length || parties.some((id) => !condition.ids.includes(id)))
            failed.add(condition.kind);
          break;
        case 'template':
          if (
            !this.facts ||
            !(await this.facts.conforms(
              tx,
              companyId,
              { id: condition.id, version: condition.version },
              candidate.treatmentId,
              candidate.input,
            ))
          )
            failed.add(condition.kind);
          break;
        case 'maxDocumentAmount':
          if (amount > parseMoney(condition.amount, 'RON')) failed.add(condition.kind);
          break;
        case 'monthlyCap': {
          const month = effect.date.slice(0, 7);
          const posted = await this.postedInMonth(tx, companyId, policy.id, month);
          if (posted + amount > parseMoney(condition.amount, 'RON')) failed.add(condition.kind);
          break;
        }
        case 'knownParty': {
          if (!parties.length) {
            failed.add(condition.kind);
            break;
          }
          const counts = await this.postedWith(tx, companyId, parties);
          if (parties.some((id) => (counts.get(id) ?? 0) < condition.minPosted))
            failed.add(condition.kind);
          break;
        }
        case 'withinObserved': {
          const seen = parties.length
            ? await this.observed(tx, companyId, candidate.treatmentId, parties)
            : null;
          // Amounts in bani and the factor in hundredths: low/factor <= amount <= high·factor.
          const factor = parseScaled(condition.factor, 2);
          if (!seen || amount * factor < seen.low * 100n || amount * 100n > seen.high * factor)
            failed.add(condition.kind);
          break;
        }
        case 'answers': {
          const facts = await this.facts?.factsOf(tx, companyId, evaluated);
          if (
            !facts ||
            canonical(
              [...condition.answers].sort((a, b) => (a.questionId < b.questionId ? -1 : 1)),
            ) !== facts
          )
            failed.add(condition.kind);
          break;
        }
        case 'graduation': {
          const [request] = policy.requestId
            ? await tx
                .select({ operation: actionRequests.operation, preview: actionRequests.preview })
                .from(actionRequests)
                .where(
                  and(
                    eq(actionRequests.companyId, companyId),
                    eq(actionRequests.id, policy.requestId),
                  ),
                )
            : [];
          const granted =
            request?.operation === 'policies.request'
              ? (JSON.parse(request.preview) as { reportHash?: string }).reportHash
              : undefined;
          if (granted !== condition.reportHash) failed.add(condition.kind);
          break;
        }
      }
    }
    return [...failed];
  }

  /**
   * The first active policy (or only `only`) whose approver still holds authority, may approve
   * this work under the company's segregation of duties, is not paused (nor the company, nor the
   * template it is bound to), and whose conditions all hold.
   */
  async match(
    tx: Transaction,
    companyId: string,
    candidate: Candidate,
    segregation: Segregation,
    only?: string,
  ) {
    const effect = candidate.evaluated.effect;
    if (!effect) return undefined;
    const paused = await pausedScopes(tx, companyId);
    if (paused.company) return undefined;
    const rows = await tx
      .select({ policy: postingPolicies, member: memberships })
      .from(postingPolicies)
      .innerJoin(
        memberships,
        and(
          eq(memberships.companyId, postingPolicies.companyId),
          eq(memberships.userId, postingPolicies.approvedBy),
        ),
      )
      .where(
        and(
          eq(postingPolicies.companyId, companyId),
          lte(postingPolicies.validFrom, effect.date),
          only ? eq(postingPolicies.id, only) : undefined,
        ),
      )
      .orderBy(asc(postingPolicies.createdAt), asc(postingPolicies.id));
    const ids = rows.map((row) => row.policy.id);
    const revoked = new Set(
      ids.length
        ? (
            await tx
              .select({ id: policyRevocations.policyId })
              .from(policyRevocations)
              .where(
                and(
                  eq(policyRevocations.companyId, companyId),
                  inArray(policyRevocations.policyId, ids),
                ),
              )
          ).map((row) => row.id)
        : [],
    );
    for (const { policy, member } of rows) {
      if (
        revoked.has(policy.id) ||
        policy.expiresAt <= this.commands.clock() ||
        !member.active ||
        member.role === 'viewer' ||
        member.epoch !== policy.approverEpoch ||
        selfApproval(segregation, policy.approvedBy, candidate.work) ||
        !(JSON.parse(policy.treatments) as string[]).includes(candidate.treatmentId) ||
        !(JSON.parse(policy.rulesHashes) as string[]).includes(candidate.evaluated.rulesHash) ||
        this.pausedFor(paused, policy.id, JSON.parse(policy.preconditions) as Precondition[])
      )
        continue;
      if (!(await this.failing(tx, companyId, policy, candidate)).length) return { id: policy.id };
    }
    return undefined;
  }

  /** The active, unpaused policies bound to a template (any version). */
  async boundTo(tx: Transaction, companyId: string, templateId: string) {
    const rows = await tx
      .select()
      .from(postingPolicies)
      .where(
        and(
          eq(postingPolicies.companyId, companyId),
          // Qualified by hand: inside a subquery an unqualified column binds to its own table.
          sql`exists (select 1 from json_each("acc_posting_policies"."preconditions_json") c
            where json_extract(c.value, '$.kind') = 'template'
              and json_extract(c.value, '$.id') = ${templateId})`,
          sql`not exists (select 1 from acc_policy_revocations r
            where r.company_id = "acc_posting_policies"."company_id"
              and r.policy_id = "acc_posting_policies"."id")`,
        ),
      );
    const now = this.commands.clock();
    return rows.filter((row) => row.expiresAt > now);
  }
}
