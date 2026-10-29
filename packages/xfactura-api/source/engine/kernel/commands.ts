import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { canonical, hashOf, sha256Hex } from 'xfactura-core/hash';
import type { Database, Transaction } from '../db/database';
import { agentGrants, audit, commands, memberships, type Role } from '../db/schema';

export type Permission = 'read' | 'write' | 'review' | 'manage';
const permissions: Record<Role, readonly Permission[]> = {
  owner: ['read', 'write', 'review', 'manage'],
  reviewer: ['read', 'write', 'review'],
  viewer: ['read'],
};
export const roleAllows = (role: Role, permission: Permission) =>
  permissions[role].includes(permission);

/** A human, or an agent acting under a grant issued by that human. */
export type Actor = { actorId: string; companyId: string; agentId?: string };
export type Access = { role: Role; epoch: number };

export const idSchema = z.uuid();
const keyPattern = /^[\w.:-]{8,128}$/;

export function commandKey(key: string) {
  requireCondition(
    keyPattern.test(key),
    'IDEMPOTENCY_KEY',
    'Furnizați o cheie de idempotență de 8–128 caractere.',
  );
  return key;
}

/**
 * Checks live authority inside the caller's transaction: an active membership whose role
 * allows the permission and, for an agent, an unrevoked, unexpired grant issued under the
 * member's current epoch that names this operation.
 */
export async function authorize(
  tx: Pick<Transaction, 'select'>,
  actor: Actor,
  permission: Permission,
  operation: string,
  agentAllowed: (operation: string) => boolean,
): Promise<Access> {
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
  requireCondition(
    roleAllows(member.role, permission),
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
      grant &&
        !grant.revokedAt &&
        grant.expiresAt > Date.now() &&
        grant.membershipEpoch === member.epoch,
      'AGENT_REVOKED',
      'Accesul agentului a expirat sau a fost revocat.',
      403,
    );
    requireCondition(
      agentAllowed(operation) &&
        (operation === 'capabilities.list' || grant.scopes.includes(operation)),
      'AGENT_SCOPE',
      'Agentul nu are permisiunea necesară pentru această acțiune.',
      403,
    );
  }
  return { role: member.role, epoch: member.epoch };
}

/** Appends to the company's hash-chained audit log. */
export async function appendAudit(
  tx: Transaction,
  entry: { companyId: string; actorId: string; agentId?: string; action: string; body: unknown },
) {
  const [last] = await tx
    .select({ seq: audit.seq, hash: audit.hash })
    .from(audit)
    .where(eq(audit.companyId, entry.companyId))
    .orderBy(desc(audit.seq))
    .limit(1);
  const seq = (last?.seq ?? 0) + 1;
  const prevHash = last?.hash ?? '';
  const body = canonical(entry.body);
  const record = {
    seq,
    actorId: entry.actorId,
    agentId: entry.agentId ?? null,
    action: entry.action,
    body,
  };
  await tx.insert(audit).values({
    companyId: entry.companyId,
    seq,
    actorId: entry.actorId,
    agentId: entry.agentId ?? null,
    action: entry.action,
    body,
    prevHash,
    hash: sha256Hex(`${prevHash}\n${canonical(record)}`),
  });
}

export class Commands {
  constructor(
    readonly db: Database,
    private readonly agentAllowed: (operation: string) => boolean,
  ) {}

  authorize(
    tx: Pick<Transaction, 'select'>,
    actor: Actor,
    permission: Permission,
    operation: string,
  ) {
    return authorize(tx, actor, permission, operation, this.agentAllowed);
  }

  /** An authorized read in a consistent snapshot. */
  async read<T>(
    actor: Actor,
    operation: string,
    read: (tx: Transaction, access: Access) => Promise<T>,
  ) {
    idSchema.parse(actor.companyId);
    return this.db.read(async (tx) => read(tx, await this.authorize(tx, actor, 'read', operation)));
  }

  /**
   * An authorized, idempotent mutation. A repeated key with the same input returns the stored
   * result after rechecking authority; a repeated key with different input is refused. Agent
   * keys live in their own namespace. The result must be plain JSON.
   */
  async run<T>(
    actor: Actor,
    key: string,
    operation: string,
    input: unknown,
    permission: Permission,
    execute: (tx: Transaction, access: Access) => Promise<T>,
  ): Promise<T> {
    commandKey(key);
    idSchema.parse(actor.companyId);
    const hash = hashOf({ operation, input });
    const storedKey = actor.agentId ? `agent/${actor.agentId}/${key}` : key;
    return this.db.write(async (tx) => {
      const access = await this.authorize(tx, actor, permission, operation);
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
      const result = await execute(tx, access);
      await tx.insert(commands).values({
        companyId: actor.companyId,
        actorId: actor.actorId,
        key: storedKey,
        operation,
        hash,
        result,
      });
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.actorId,
        ...(actor.agentId ? { agentId: actor.agentId } : {}),
        action: operation,
        // The command row keeps the result for replay; the audit chain binds its hash.
        body: { commandHash: hash, resultHash: hashOf(result) },
      });
      return result;
    });
  }
}
