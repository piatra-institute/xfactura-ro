import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { canonical } from 'xfactura-core/hash';
import { criteriaSchema, defaultCriteria, type Criteria } from 'xfactura-core/templates';
import type { Transaction } from '../db/database';
import { automationCriteria, automationEvents, postingPolicies, templates } from '../db/schema';
import { appendAudit, type Actor, type Commands, type Ids } from './commands';
import { Jobs } from './jobs';
import { SYSTEM_PRINCIPAL } from './principals';

/*
 * The kill switch of automatic posting and the criteria a template graduates by. A pause stops
 * every posting policy of its scope (the company, one policy, or the policies bound to one
 * template) at once: `PostingPolicies.match` skips them and the database refuses their entries
 * (`inv:binding`). Any member or agent pauses; only a person who may review resumes. The worker
 * pauses too, in the name of the system principal, when a policy's work is reversed or corrected
 * (a demotion).
 */

export { SYSTEM_PRINCIPAL };

export const automationScopes = ['company', 'policy', 'template'] as const;
export type AutomationScope = (typeof automationScopes)[number];

/** Why the system paused a policy. */
export const demotionTriggers = [
  'reversal',
  'correction',
  'new_party',
  'unusual_amount',
  'changed_answer',
] as const;
export type DemotionTrigger = (typeof demotionTriggers)[number];

const reason = z.string().trim().min(10).max(1000);
export const switchInput = z
  .object({
    scope: z.enum(automationScopes),
    /** The policy or template; none for the company. */
    id: z.uuid().optional(),
    reason,
  })
  .strict()
  .refine((input) => (input.scope === 'company') === (input.id === undefined), {
    message: 'Indicați politica sau șablonul, ori nimic pentru întreaga companie.',
    path: ['id'],
  });
export const criteriaInput = criteriaSchema.extend({ reason }).strict();

const eventView = z.object({
  seq: z.number(),
  scope: z.enum(automationScopes),
  id: z.string().nullable(),
  kind: z.enum(['pause', 'resume']),
  reason: z.string(),
  trigger: z.string().nullable(),
  details: z.unknown(),
  by: z.string(),
  agentId: z.string().nullable(),
  /** Set when the engine itself paused (a demotion), not a person or an agent. */
  system: z.boolean(),
  at: z.string(),
});
export const switchView = z.object({
  scope: z.enum(automationScopes),
  /** The policy or template; null for the company. */
  scopeId: z.string().nullable(),
  paused: z.boolean(),
  /** False when the scope already was in that state: nothing was recorded. */
  changed: z.boolean(),
  event: eventView.nullable(),
});
export const statusView = z.object({
  company: z.object({ paused: z.boolean(), event: eventView.nullable() }),
  /** Policies and templates whose latest event is a pause. */
  paused: z.array(eventView),
  criteria: criteriaSchema.extend({
    /** Null while the defaults hold. */
    seq: z.number().nullable(),
  }),
  /** The latest events, newest first. */
  events: z.array(eventView),
});

type EventRow = typeof automationEvents.$inferSelect;
const view = (row: EventRow): z.infer<typeof eventView> => ({
  seq: row.seq,
  scope: row.scope,
  id: row.scopeId,
  kind: row.kind,
  reason: row.reason,
  trigger: row.trigger,
  details: row.details ? (JSON.parse(row.details) as unknown) : null,
  by: row.createdBy,
  agentId: row.agentId,
  system: row.createdBy === SYSTEM_PRINCIPAL,
  at: row.createdAt,
});

/** Queues, in the system's name, a sweep of a policy over the open proposals it covers: after
 * the policy is created, and when a resume lets it post again. */
export async function sweepAfter(tx: Transaction, companyId: string, policyId: string, ids: Ids) {
  await Jobs.enqueue(tx, {
    id: ids(),
    companyId,
    actorId: SYSTEM_PRINCIPAL,
    kind: 'policies.sweep',
    params: { policyId },
  });
}

/** The scopes whose latest event is a pause. */
export async function pausedScopes(tx: Pick<Transaction, 'select'>, companyId: string) {
  const rows = await tx
    .select()
    .from(automationEvents)
    .where(
      and(
        eq(automationEvents.companyId, companyId),
        // Qualified by hand: inside the subquery an unqualified column binds to `f`.
        sql.raw(`"acc_automation_events"."seq" = (select max(f.seq) from acc_automation_events f
          where f.company_id = "acc_automation_events"."company_id"
            and f.scope = "acc_automation_events"."scope"
            and f.scope_id is "acc_automation_events"."scope_id")`),
      ),
    );
  const paused = rows.filter((row) => row.kind === 'pause');
  return {
    company: paused.some((row) => row.scope === 'company'),
    policies: new Set(paused.filter((row) => row.scope === 'policy').map((row) => row.scopeId!)),
    templates: new Set(paused.filter((row) => row.scope === 'template').map((row) => row.scopeId!)),
    rows: paused,
  };
}
export type Paused = Awaited<ReturnType<typeof pausedScopes>>;

/** The company's graduation criteria: its latest record, or the defaults. */
export async function criteriaOf(
  tx: Pick<Transaction, 'select'>,
  companyId: string,
): Promise<Criteria & { seq: number | null }> {
  const [row] = await tx
    .select()
    .from(automationCriteria)
    .where(eq(automationCriteria.companyId, companyId))
    .orderBy(desc(automationCriteria.seq))
    .limit(1);
  return row
    ? {
        minCorrect: row.minCorrect,
        minMonths: row.minMonths,
        policyDays: row.policyDays,
        seq: row.seq,
      }
    : { ...defaultCriteria, seq: null };
}

async function nextSeq(tx: Transaction, companyId: string) {
  const [row] = await tx
    .select({ seq: sql<number>`coalesce(max(${automationEvents.seq}), 0)`.mapWith(Number) })
    .from(automationEvents)
    .where(eq(automationEvents.companyId, companyId));
  return (row?.seq ?? 0) + 1;
}

async function latest(tx: Transaction, companyId: string, scope: AutomationScope, id?: string) {
  const [row] = await tx
    .select()
    .from(automationEvents)
    .where(
      and(
        eq(automationEvents.companyId, companyId),
        eq(automationEvents.scope, scope),
        id === undefined
          ? sql`${automationEvents.scopeId} is null`
          : eq(automationEvents.scopeId, id),
      ),
    )
    .orderBy(desc(automationEvents.seq))
    .limit(1);
  return row;
}

/** Records a pause or resume unless the scope is already in that state. */
async function record(
  tx: Transaction,
  companyId: string,
  event: {
    scope: AutomationScope;
    id?: string | undefined;
    kind: 'pause' | 'resume';
    reason: string;
    trigger?: DemotionTrigger;
    details?: unknown;
    createdBy: string;
    agentId?: string | null;
    epoch: number | null;
  },
) {
  const before = await latest(tx, companyId, event.scope, event.id);
  const paused = before?.kind === 'pause';
  if (paused === (event.kind === 'pause'))
    return {
      scope: event.scope,
      scopeId: event.id ?? null,
      paused,
      changed: false,
      event: before ? view(before) : null,
    };
  const seq = await nextSeq(tx, companyId);
  await tx.insert(automationEvents).values({
    companyId,
    seq,
    scope: event.scope,
    scopeId: event.id ?? null,
    kind: event.kind,
    reason: event.reason,
    trigger: event.trigger ?? null,
    details: event.details === undefined ? null : canonical(event.details),
    createdBy: event.createdBy,
    agentId: event.agentId ?? null,
    epoch: event.epoch,
  });
  const [row] = await tx
    .select()
    .from(automationEvents)
    .where(and(eq(automationEvents.companyId, companyId), eq(automationEvents.seq, seq)));
  return {
    scope: event.scope,
    scopeId: event.id ?? null,
    paused: event.kind === 'pause',
    changed: true,
    event: view(row!),
  };
}

/**
 * The system pauses a policy (a demotion) inside the caller's transaction, with an audit row of
 * its own (`automation.demoted`). Nothing is recorded when the policy is already paused.
 */
export async function demote(
  tx: Transaction,
  companyId: string,
  policyId: string,
  trigger: DemotionTrigger,
  reason: string,
  details: Record<string, unknown>,
) {
  const result = await record(tx, companyId, {
    scope: 'policy',
    id: policyId,
    kind: 'pause',
    reason,
    trigger,
    details,
    createdBy: SYSTEM_PRINCIPAL,
    epoch: null,
  });
  if (result.changed)
    await appendAudit(tx, {
      companyId,
      actorId: SYSTEM_PRINCIPAL,
      action: 'automation.demoted',
      body: { policyId, trigger, reason, ...details },
    });
  return result;
}

export class Automation {
  constructor(private readonly commands: Commands) {}

  /** The policy or template a scope names must be the company's. */
  private async requireScope(
    tx: Transaction,
    companyId: string,
    scope: AutomationScope,
    id?: string,
  ) {
    if (scope === 'company') return;
    const table = scope === 'policy' ? postingPolicies : templates;
    const [row] = await tx
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.companyId, companyId), eq(table.id, id!)))
      .limit(1);
    requireCondition(
      row,
      'NOT_FOUND',
      scope === 'policy' ? 'Politica nu este disponibilă.' : 'Șablonul nu este disponibil.',
      404,
    );
  }

  /** Any member, or an agent, stops automatic posting in a scope at once. */
  pause(actor: Actor, key: string, input: z.infer<typeof switchInput>) {
    return this.commands.run(actor, key, 'automation.pause', input, 'read', async (tx, access) => {
      await this.requireScope(tx, actor.companyId, input.scope, input.id);
      return record(tx, actor.companyId, {
        scope: input.scope,
        id: input.id,
        kind: 'pause',
        reason: input.reason,
        createdBy: actor.actorId,
        agentId: actor.agentId ?? null,
        epoch: access.epoch,
      });
    });
  }

  /** A person who may review lets a scope post automatically again. */
  resume(actor: Actor, key: string, input: z.infer<typeof switchInput>) {
    requireCondition(
      !actor.agentId,
      'AGENT_SCOPE',
      'Reluarea contabilizării automate aparține unei persoane.',
      403,
    );
    return this.commands.run(
      actor,
      key,
      'automation.resume',
      input,
      'review',
      async (tx, access) => {
        await this.requireScope(tx, actor.companyId, input.scope, input.id);
        const result = await record(tx, actor.companyId, {
          scope: input.scope,
          id: input.id,
          kind: 'resume',
          reason: input.reason,
          createdBy: actor.actorId,
          epoch: access.epoch,
        });
        // What waited while paused is swept again by the policies the resume lets post.
        if (result.changed)
          for (const policyId of await this.resumed(tx, actor.companyId, input.scope, input.id))
            await sweepAfter(tx, actor.companyId, policyId, this.commands.ids);
        return result;
      },
    );
  }

  /** The unrevoked policies a scope covers: all, one, or those bound to a template. */
  private async resumed(tx: Transaction, companyId: string, scope: AutomationScope, id?: string) {
    const rows = await tx
      .select({ id: postingPolicies.id })
      .from(postingPolicies)
      .where(
        and(
          eq(postingPolicies.companyId, companyId),
          scope === 'policy' ? eq(postingPolicies.id, id!) : undefined,
          scope === 'template'
            ? sql`exists (select 1 from json_each("acc_posting_policies"."preconditions_json") c
                where json_extract(c.value, '$.kind') = 'template' and json_extract(c.value, '$.id') = ${id!})`
            : undefined,
          sql.raw(`not exists (select 1 from acc_policy_revocations r
            where r.company_id = "acc_posting_policies"."company_id" and r.policy_id = "acc_posting_policies"."id")`),
        ),
      );
    return rows.map((row) => row.id);
  }

  /** An owner or accountant tightens the graduation criteria (never below the defaults). */
  recordCriteria(actor: Actor, key: string, input: z.infer<typeof criteriaInput>) {
    requireCondition(!actor.agentId, 'AGENT_SCOPE', 'Criteriile aparțin unei persoane.', 403);
    return this.commands.run(
      actor,
      key,
      'automation.criteria.record',
      input,
      'review',
      async (tx, access) => {
        const [last] = await tx
          .select({ seq: sql<number>`coalesce(max(${automationCriteria.seq}), 0)`.mapWith(Number) })
          .from(automationCriteria)
          .where(eq(automationCriteria.companyId, actor.companyId));
        const seq = (last?.seq ?? 0) + 1;
        await tx.insert(automationCriteria).values({
          companyId: actor.companyId,
          seq,
          minCorrect: input.minCorrect,
          minMonths: input.minMonths,
          policyDays: input.policyDays,
          reason: input.reason,
          createdBy: actor.actorId,
          epoch: access.epoch,
        });
        return { ...(await criteriaOf(tx, actor.companyId)), seq };
      },
    );
  }

  status(actor: Actor) {
    return this.commands.read(actor, 'automation.status', async (tx) => {
      const paused = await pausedScopes(tx, actor.companyId);
      const company = await latest(tx, actor.companyId, 'company');
      const events = await tx
        .select()
        .from(automationEvents)
        .where(eq(automationEvents.companyId, actor.companyId))
        .orderBy(desc(automationEvents.seq))
        .limit(50);
      return {
        company: { paused: paused.company, event: company ? view(company) : null },
        paused: paused.rows
          .filter((row) => row.scope !== 'company')
          .sort((a, b) => a.seq - b.seq)
          .map(view),
        criteria: await criteriaOf(tx, actor.companyId),
        events: events.map(view),
      };
    });
  }
}
