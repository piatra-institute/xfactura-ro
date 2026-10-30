import { createHmac } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { canonical } from 'xfactura-core/hash';
import { toolsets, type Toolset } from 'xfactura-core/kernel';
import { agentGrants } from '../db/schema';
import { idSchema, type Actor, type Commands } from '../kernel/commands';
import { sha256 } from '../adapters/object-store';

/** A scope naming a whole toolset rather than one operation. */
const toolsetScope = 'toolset:';

export const issueAgentInput = z
  .object({
    name: z.string().trim().min(2).max(100),
    /** Operation ids, or `toolset:<name>` for every agent operation of a toolset. */
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
  /** Every operation the grant allows, toolsets expanded as they were when it was issued. */
  scopes: z.array(z.string()),
  /** The toolsets the issuer named. */
  toolsets: z.array(z.enum(toolsets)),
  expiresAt: z.string(),
  revoked: z.boolean(),
  createdBy: z.string(),
});

const columns = {
  id: agentGrants.id,
  name: agentGrants.name,
  scopes: agentGrants.scopes,
  toolsets: agentGrants.toolsets,
  expiresAt: agentGrants.expiresAt,
  revokedAt: agentGrants.revokedAt,
  createdBy: agentGrants.createdBy,
};
const view = (grant: {
  id: string;
  name: string;
  scopes: string[];
  toolsets: string[];
  expiresAt: number;
  revokedAt: number | null;
  createdBy: string;
}) => ({
  id: grant.id,
  name: grant.name,
  scopes: grant.scopes,
  toolsets: grant.toolsets as Toolset[],
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
    /** The operations a grant may name, with their toolsets. */
    private readonly grantable: () => { id: string; toolset: Toolset }[],
  ) {}

  /**
   * The operation ids a grant's scopes name. A toolset expands to its agent operations now, and
   * the grant stores the expansion: operations added to the toolset later are not granted.
   */
  private expand(scopes: string[]) {
    const operations = this.grantable();
    const ids = new Set<string>();
    const named: Toolset[] = [];
    const unknown: string[] = [];
    for (const scope of scopes) {
      if (scope.startsWith(toolsetScope)) {
        const toolset = scope.slice(toolsetScope.length) as Toolset;
        const members = operations.filter((operation) => operation.toolset === toolset);
        if (members.length === 0) unknown.push(scope);
        else named.push(toolset);
        for (const operation of members) ids.add(operation.id);
      } else if (operations.some((operation) => operation.id === scope)) ids.add(scope);
      else unknown.push(scope);
    }
    return { scopes: [...ids].sort(), toolsets: named.sort(), unknown };
  }

  async issue(actor: Actor, key: string, input: z.infer<typeof issueAgentInput>) {
    requireCondition(!actor.agentId, 'AGENT_SCOPE', 'Agenții nu pot emite credențiale.', 403);
    const { scopes, toolsets: named, unknown } = this.expand(input.scopes);
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
        const now = this.commands.clock();
        requireCondition(
          expiresAt > now && expiresAt <= now + 90 * 86_400_000,
          'AGENT_EXPIRY',
          'Alegeți o expirare în următoarele 90 de zile.',
        );
        const id = this.commands.ids();
        await tx.insert(agentGrants).values({
          id,
          companyId: actor.companyId,
          name: input.name,
          tokenHash: sha256(token),
          scopes,
          toolsets: named,
          membershipEpoch: access.epoch,
          expiresAt,
          createdBy: actor.actorId,
        });
        return view({
          id,
          name: input.name,
          scopes,
          toolsets: named,
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
        grant && !grant.revokedAt && grant.expiresAt > this.commands.clock(),
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
          .set({ revokedAt: this.commands.clock() })
          .where(eq(agentGrants.id, grant.id));
      return { id: input.id, revoked: true as const };
    });
  }
}
