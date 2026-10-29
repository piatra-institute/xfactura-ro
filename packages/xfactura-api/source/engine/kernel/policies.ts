import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { canonical } from 'xfactura-core/hash';
import { parseMoney } from 'xfactura-core/money';
import type { Transaction } from '../db/database';
import { memberships, policyRevocations, postingPolicies } from '../db/schema';
import type { Actor, Commands } from './commands';
import type { Evaluated } from './proposals';

const decimal = z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/);

/** Conditions an evaluated proposal must meet for a policy to post it without a person. */
export const preconditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('noWarnings') }).strict(),
  z.object({ kind: z.literal('maxLineAmount'), amount: decimal }).strict(),
  z
    .object({
      kind: z.literal('accountsWithin'),
      prefixes: z.array(z.string().regex(/^\d{1,4}/)).min(1),
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
});

function satisfies(condition: Precondition, evaluated: Evaluated) {
  const effect = evaluated.effect!;
  switch (condition.kind) {
    case 'noWarnings':
      return evaluated.issues.length === 0;
    case 'maxLineAmount': {
      const limit = parseMoney(condition.amount, 'RON');
      return effect.lines.every((line) => (line.bani < 0n ? -line.bani : line.bani) <= limit);
    }
    case 'accountsWithin':
      return effect.lines.every((line) =>
        condition.prefixes.some((prefix) => line.account.startsWith(prefix)),
      );
  }
}

export class PostingPolicies {
  constructor(private readonly commands: Commands) {}

  async create(actor: Actor, key: string, input: z.infer<typeof policyInput>) {
    requireCondition(
      !actor.agentId,
      'AGENT_SCOPE',
      'Politicile de contabilizare aparțin unei persoane.',
      403,
    );
    const expiresAt = Date.parse(input.expiresAt);
    requireCondition(
      expiresAt > Date.now() && expiresAt <= Date.now() + 366 * 86400000,
      'POLICY_EXPIRY',
      'Alegeți o expirare în următorul an.',
    );
    return this.commands.run(actor, key, 'policies.create', input, 'review', async (tx, access) => {
      const id = randomUUID();
      await tx.insert(postingPolicies).values({
        id,
        companyId: actor.companyId,
        name: input.name,
        treatments: canonical(input.treatments),
        rulesHashes: canonical(input.rulesHashes),
        preconditions: canonical(input.preconditions),
        approvedBy: actor.actorId,
        approverEpoch: access.epoch,
        validFrom: input.validFrom,
        expiresAt,
      });
      return { id, ...input, approvedBy: actor.actorId, revoked: false };
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

  async list(actor: Actor) {
    return this.commands.read(actor, 'policies.list', async (tx) => {
      const rows = await tx
        .select()
        .from(postingPolicies)
        .where(eq(postingPolicies.companyId, actor.companyId))
        .orderBy(asc(postingPolicies.createdAt), asc(postingPolicies.id));
      const revoked = new Set(
        (
          await tx
            .select({ id: policyRevocations.policyId })
            .from(policyRevocations)
            .where(eq(policyRevocations.companyId, actor.companyId))
        ).map((row) => row.id),
      );
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        treatments: JSON.parse(row.treatments) as string[],
        rulesHashes: JSON.parse(row.rulesHashes) as string[],
        preconditions: JSON.parse(row.preconditions) as Precondition[],
        approvedBy: row.approvedBy,
        validFrom: row.validFrom,
        expiresAt: new Date(row.expiresAt).toISOString(),
        revoked: revoked.has(row.id),
      }));
    });
  }

  /** The first active policy whose approver still holds authority and whose conditions hold. */
  async match(tx: Transaction, companyId: string, treatmentId: string, evaluated: Evaluated) {
    const effect = evaluated.effect;
    if (!effect) return undefined;
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
        and(eq(postingPolicies.companyId, companyId), lte(postingPolicies.validFrom, effect.date)),
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
        policy.expiresAt <= Date.now() ||
        !member.active ||
        member.role === 'viewer' ||
        member.epoch !== policy.approverEpoch ||
        !(JSON.parse(policy.treatments) as string[]).includes(treatmentId) ||
        !(JSON.parse(policy.rulesHashes) as string[]).includes(evaluated.rulesHash)
      )
        continue;
      if (
        (JSON.parse(policy.preconditions) as Precondition[]).every((condition) =>
          satisfies(condition, evaluated),
        )
      )
        return { id: policy.id };
    }
    return undefined;
  }
}
