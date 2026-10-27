import { createHmac, randomUUID } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import { agentCapabilities, type CapabilityId } from './capability-policy';
import { authorize, Commands, type Actor } from './commands';
import { canonical, idSchema, requireCondition } from './domain';
import { agentGrants } from './schema';
import { sha256 } from './object-store';
import { pageInput } from './capability-contracts';

export const issueAgentSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    scopes: z
      .array(z.enum(agentCapabilities as [CapabilityId, ...CapabilityId[]]))
      .min(1)
      .max(agentCapabilities.length)
      .refine((items) => new Set(items).size === items.length, 'Permisiuni duplicate.'),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const publicGrantColumns = {
  id: agentGrants.id,
  companyId: agentGrants.companyId,
  name: agentGrants.name,
  scopes: agentGrants.scopes,
  expiresAt: agentGrants.expiresAt,
  revokedAt: agentGrants.revokedAt,
  createdBy: agentGrants.createdBy,
  createdAt: agentGrants.createdAt,
};

export class Agents {
  constructor(
    private readonly runner: Commands,
    private readonly secret: string,
  ) {}

  async issue(actor: Actor, key: string, input: unknown) {
    const body = issueAgentSchema.parse(input);
    // Derivation permits recovery of a lost HTTP response without persisting the credential
    // in command results, audit records, exports or the grant table.
    const token = `xfa_${createHmac('sha256', this.secret)
      .update(
        canonical({
          purpose: 'accounting-agent',
          actorId: actor.actorId,
          companyId: actor.companyId,
          key,
        }),
      )
      .digest('hex')}`;
    const result = await this.runner.run(actor, key, 'agents.issue', body, 'review', async (tx) => {
      const expiresAt = Date.parse(body.expiresAt);
      requireCondition(
        expiresAt > Date.now() && expiresAt <= Date.now() + 90 * 86400000,
        'AGENT_EXPIRY',
        'Alegeți o expirare în următoarele 90 de zile.',
      );
      const [grant] = await tx
        .insert(agentGrants)
        .values({
          id: randomUUID(),
          companyId: actor.companyId,
          name: body.name,
          tokenHash: sha256(token),
          scopes: body.scopes,
          expiresAt,
          createdBy: actor.actorId,
        })
        .returning(publicGrantColumns);
      return grant;
    });
    // Cached issuance cannot resurrect or reveal a revoked/expired credential.
    await this.authenticate(token, actor.companyId);
    return { ...result, token };
  }

  async authenticate(token: string, companyId: string): Promise<Actor> {
    idSchema.parse(companyId);
    requireCondition(
      /^xfa_[a-f0-9]{64}$/.test(token),
      'UNAUTHENTICATED',
      'Credențială invalidă.',
      401,
    );
    return this.runner.db.read(async (tx) => {
      const [grant] = await tx
        .select()
        .from(agentGrants)
        .where(and(eq(agentGrants.companyId, companyId), eq(agentGrants.tokenHash, sha256(token))));
      requireCondition(
        grant && !grant.revokedAt && grant.expiresAt > Date.now(),
        'UNAUTHENTICATED',
        'Credențiala nu este disponibilă.',
        401,
      );
      const actor = { actorId: grant.createdBy, companyId, agentId: grant.id };
      await authorize(tx, actor, 'read', 'capabilities.list');
      return actor;
    });
  }

  async list(actor: Actor, input: unknown = {}) {
    const body = pageInput.parse(input);
    if (body.cursor) idSchema.parse(body.cursor);
    return this.runner.db.read(async (tx) => {
      const role = await authorize(tx, actor, 'review', 'agents.list');
      const rows = await tx
        .select(publicGrantColumns)
        .from(agentGrants)
        .where(
          and(
            eq(agentGrants.companyId, actor.companyId),
            role === 'owner' ? undefined : eq(agentGrants.createdBy, actor.actorId),
            body.cursor ? gt(agentGrants.id, body.cursor) : undefined,
          ),
        )
        .orderBy(agentGrants.id)
        .limit(body.limit + 1);
      return {
        items: rows.slice(0, body.limit),
        nextCursor: rows.length > body.limit ? rows[body.limit - 1].id : null,
      };
    });
  }

  async revoke(actor: Actor, key: string, id: string) {
    idSchema.parse(id);
    return this.runner.run(actor, key, 'agents.revoke', { id }, 'review', async (tx) => {
      const role = await authorize(tx, actor, 'review', 'agents.revoke');
      const [grant] = await tx
        .select(publicGrantColumns)
        .from(agentGrants)
        .where(and(eq(agentGrants.companyId, actor.companyId), eq(agentGrants.id, id)));
      requireCondition(
        grant && (role === 'owner' || grant.createdBy === actor.actorId),
        'NOT_FOUND',
        'Agentul nu este disponibil.',
        404,
      );
      if (!grant.revokedAt)
        await tx
          .update(agentGrants)
          .set({ revokedAt: Date.now() })
          .where(eq(agentGrants.id, grant.id));
      return { id, revoked: true as const };
    });
  }
}
