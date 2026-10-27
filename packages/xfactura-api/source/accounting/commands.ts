import { and, eq } from 'drizzle-orm';
import { canonical, idSchema, requireCondition, type Role } from './domain';
import { type Database, type Transaction } from './db';
import { commands, memberships, audit, agentGrants } from './schema';
import { sha256 } from './object-store';
import {
  capabilityPolicy,
  roleAllows,
  type CapabilityId,
  type Permission,
} from './capability-policy';

export type Capability = Permission;
export type Actor = { actorId: string; companyId: string; agentId?: string };

export const principal = (actor: Actor) =>
  actor.agentId
    ? { kind: 'agent' as const, id: actor.agentId, delegatedBy: actor.actorId }
    : { kind: 'human' as const, id: actor.actorId };

export function commandKey(key: string) {
  requireCondition(
    /^[\w.:-]{8,128}$/.test(key),
    'IDEMPOTENCY_KEY',
    'Furnizați o cheie de idempotență de 8–128 caractere.',
  );
  return key;
}
export async function authorize(
  tx: Pick<Transaction, 'select'>,
  actor: Actor,
  capability: Capability = 'read',
  operation: string = 'company.overview',
): Promise<Role> {
  const [member] = await tx
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.companyId, actor.companyId),
        eq(memberships.userId, actor.actorId),
        eq(memberships.active, true),
      ),
    );
  requireCondition(member, 'NOT_FOUND', 'Compania nu este disponibilă.', 404);
  const allowed = roleAllows(member.role, capability);
  requireCondition(
    allowed,
    'FORBIDDEN',
    'Nu aveți permisiunea necesară pentru această acțiune.',
    403,
  );
  if (actor.agentId) {
    const [grant] = await tx
      .select()
      .from(agentGrants)
      .where(
        and(
          eq(agentGrants.id, actor.agentId),
          eq(agentGrants.companyId, actor.companyId),
          eq(agentGrants.createdBy, actor.actorId),
        ),
      );
    requireCondition(
      grant && !grant.revokedAt && grant.expiresAt > Date.now(),
      'AGENT_REVOKED',
      'Accesul agentului a expirat sau a fost revocat.',
      403,
    );
    const policy = capabilityPolicy[operation as CapabilityId];
    requireCondition(
      policy?.agent && (operation === 'capabilities.list' || grant.scopes.includes(operation)),
      'AGENT_SCOPE',
      'Agentul nu are permisiunea necesară pentru această acțiune.',
      403,
    );
  }
  return member.role;
}

export class Commands {
  constructor(readonly db: Database) {}

  async read<T>(
    actor: Actor,
    read: (tx: Transaction, role: Role) => Promise<T>,
    operation = 'company.overview',
  ) {
    idSchema.parse(actor.companyId);
    return this.db.read(async (tx) => read(tx, await authorize(tx, actor, 'read', operation)));
  }

  async run<T>(
    actor: Actor,
    key: string,
    operation: string,
    input: unknown,
    capability: Capability,
    execute: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    commandKey(key);
    idSchema.parse(actor.companyId);
    const hash = sha256(canonical({ operation, input }));
    const storedKey = actor.agentId ? `agent/${actor.agentId}/${key}` : key;

    return this.db.write(async (tx) => {
      await authorize(tx, actor, capability, operation);
      const [previous] = await tx
        .select()
        .from(commands)
        .where(
          and(
            eq(commands.companyId, actor.companyId),
            eq(commands.actorId, actor.actorId),
            eq(commands.key, storedKey),
          ),
        );
      if (previous) {
        requireCondition(
          previous.hash === hash,
          'IDEMPOTENCY_CONFLICT',
          'Cheia a fost deja folosită pentru alte date.',
          409,
        );
        return previous.result as T;
      }

      const result = await execute(tx);
      await tx.insert(commands).values({
        companyId: actor.companyId,
        actorId: actor.actorId,
        key: storedKey,
        operation,
        hash,
        result,
      });
      await tx.insert(audit).values({
        companyId: actor.companyId,
        actorId: actor.actorId,
        action: operation,
        body: { principal: principal(actor), commandHash: hash, result },
      });
      return result;
    });
  }
}
