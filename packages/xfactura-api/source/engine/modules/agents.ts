import { createHmac, randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { canonical } from 'xfactura-core/hash';
import { agentGrants } from '../db/schema';
import { idSchema, type Actor, type Commands } from '../kernel/commands';
import { sha256 } from '../adapters/object-store';

export const issueAgentInput = z
  .object({
    name: z.string().trim().min(2).max(100),
    scopes: z
      .array(z.string().min(1).max(100))
      .min(1)
      .max(200)
      .refine((items) => new Set(items).size === items.length, 'Permisiuni duplicate.'),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const grantView = z.object({
  id: z.string(),
  name: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.string(),
  revoked: z.boolean(),
  createdBy: z.string(),
});

const columns = {
  id: agentGrants.id,
  name: agentGrants.name,
  scopes: agentGrants.scopes,
  expiresAt: agentGrants.expiresAt,
  revokedAt: agentGrants.revokedAt,
  createdBy: agentGrants.createdBy,
};
const view = (grant: {
  id: string;
  name: string;
  scopes: string[];
  expiresAt: number;
  revokedAt: number | null;
  createdBy: string;
}) => ({
  id: grant.id,
  name: grant.name,
  scopes: grant.scopes,
  expiresAt: new Date(grant.expiresAt).toISOString(),
  revoked: grant.revokedAt !== null,
  createdBy: grant.createdBy,
});

/**
 * Delegated agent credentials. A grant acts for the person who issued it, within the named
 * operations and that person's current role, and dies when their membership changes.
 */
export class Agents {
  constructor(
    private readonly commands: Commands,
    private readonly secret: string,
    private readonly agentOperations: () => string[],
  ) {}

  async issue(actor: Actor, key: string, input: z.infer<typeof issueAgentInput>) {
    requireCondition(!actor.agentId, 'AGENT_SCOPE', 'Agenții nu pot emite credențiale.', 403);
    const allowed = new Set(this.agentOperations());
    const unknown = input.scopes.filter((scope) => !allowed.has(scope));
    requireCondition(
      unknown.length === 0,
      'AGENT_SCOPE',
      'Unele permisiuni nu sunt disponibile agenților.',
      422,
      { unknown },
    );
    // Derived from the command, so a retried request recovers the token without storing it.
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
    const result = await this.commands.run(
      actor,
      key,
      'agents.issue',
      input,
      'review',
      async (tx, access) => {
        const expiresAt = Date.parse(input.expiresAt);
        requireCondition(
          expiresAt > Date.now() && expiresAt <= Date.now() + 90 * 86_400_000,
          'AGENT_EXPIRY',
          'Alegeți o expirare în următoarele 90 de zile.',
        );
        const id = randomUUID();
        await tx.insert(agentGrants).values({
          id,
          companyId: actor.companyId,
          name: input.name,
          tokenHash: sha256(token),
          scopes: input.scopes,
          membershipEpoch: access.epoch,
          expiresAt,
          createdBy: actor.actorId,
        });
        return view({
          id,
          name: input.name,
          scopes: input.scopes,
          expiresAt,
          revokedAt: null,
          createdBy: actor.actorId,
        });
      },
    );
    // A replayed issuance cannot reveal a credential that has since been revoked or expired.
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
    return this.commands.db.read(async (tx) => {
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
      await this.commands.authorize(tx, actor, 'read', 'capabilities.list');
      return actor;
    });
  }

  list(actor: Actor) {
    return this.commands.read(actor, 'agents.list', async (tx, access) =>
      (
        await tx
          .select(columns)
          .from(agentGrants)
          .where(
            and(
              eq(agentGrants.companyId, actor.companyId),
              access.role === 'owner' ? undefined : eq(agentGrants.createdBy, actor.actorId),
            ),
          )
          .orderBy(asc(agentGrants.createdAt), asc(agentGrants.id))
      ).map(view),
    );
  }

  revoke(actor: Actor, key: string, input: { id: string }) {
    return this.commands.run(actor, key, 'agents.revoke', input, 'review', async (tx, access) => {
      const [grant] = await tx
        .select(columns)
        .from(agentGrants)
        .where(and(eq(agentGrants.companyId, actor.companyId), eq(agentGrants.id, input.id)));
      requireCondition(
        grant && (access.role === 'owner' || grant.createdBy === actor.actorId),
        'NOT_FOUND',
        'Agentul nu este disponibil.',
        404,
      );
      if (!grant.revokedAt)
        await tx
          .update(agentGrants)
          .set({ revokedAt: Date.now() })
          .where(eq(agentGrants.id, grant.id));
      return { id: input.id, revoked: true as const };
    });
  }
}
