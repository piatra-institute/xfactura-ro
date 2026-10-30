import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { canonical, hashOf, sha256Hex } from 'xfactura-core/hash';
import type { DataClass } from 'xfactura-core/kernel';
import type { Database, Transaction } from '../db/database';
import { agentGrants, audit, commands, memberships, type Role } from '../db/schema';
import { auditRefs, refsOf } from './events';

export type Permission = 'read' | 'write' | 'review' | 'manage';
const permissions: Record<Role, readonly Permission[]> = {
  owner: ['read', 'write', 'review', 'manage'],
  reviewer: ['read', 'write', 'review'],
  viewer: ['read'],
};
export const roleAllows = (role: Role, permission: Permission) =>
  permissions[role].includes(permission);

/** The engine's time, in milliseconds since the epoch: what every decision on time reads. */
export type Clock = () => number;
/** Makes the identifiers of the records the engine creates. */
export type Ids = () => string;

/** A human, or an agent acting under a grant issued by that human. */
export type Actor = { actorId: string; companyId: string; agentId?: string };
export type Access = { role: Role; epoch: number };

/** Reading the catalogue itself: every principal may, without naming it in a grant. */
export const discoveryOperations: readonly string[] = [
  'capabilities.list',
  'capabilities.search',
  'capabilities.describe',
];

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
 * allows the permission and, for an agent, an unrevoked grant, unexpired at `now` (the engine's
 * time), issued under the member's current epoch, that names this operation.
 */
export async function authorize(
  tx: Pick<Transaction, 'select'>,
  actor: Actor,
  permission: Permission,
  operation: string,
  agentAllowed: (operation: string) => boolean,
  now: number,
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
      grant && !grant.revokedAt && grant.expiresAt > now && grant.membershipEpoch === member.epoch,
      'AGENT_REVOKED',
      'Accesul agentului a expirat sau a fost revocat.',
      403,
    );
    requireCondition(
      agentAllowed(operation) &&
        (discoveryOperations.includes(operation) || grant.scopes.includes(operation)),
      'AGENT_SCOPE',
      'Agentul nu are permisiunea necesară pentru această acțiune.',
      403,
    );
  }
  return { role: member.role, epoch: member.epoch };
}

/** A body with the references it names (`refsOf`), unless it lists them itself. */
function withRefs(action: string, body: unknown) {
  if (typeof body !== 'object' || body === null || Array.isArray(body) || 'refs' in body)
    return body;
  return { ...body, ...auditRefs(refsOf(action, body)) };
}

/** Appends to the company's hash-chained audit log; the body records the references it names. */
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
  const body = canonical(withRefs(entry.action, entry.body));
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

/** What the operation registry declares about an operation. */
export type OperationPolicy = (operation: string) =>
  | {
      agent: boolean;
      permission: Permission;
      effect: string;
      dataClasses: readonly DataClass[];
    }
  | undefined;

export class Commands {
  /** The engine's time: grants, invitations and policies expire on it, and every module that
   * decides on today's date reads it. Wall time by default. */
  readonly clock: Clock;
  /** The identifiers of the records the engine creates: random by default, seeded by the
   * evaluation harness so that a run lists its records in the same order every time. */
  readonly ids: Ids;

  constructor(
    readonly db: Database,
    private readonly policy: OperationPolicy,
    options: { clock?: Clock; ids?: Ids } = {},
  ) {
    this.clock = options.clock ?? Date.now;
    this.ids = options.ids ?? randomUUID;
  }

  authorize(
    tx: Pick<Transaction, 'select'>,
    actor: Actor,
    permission: Permission,
    operation: string,
  ) {
    return authorize(
      tx,
      actor,
      permission,
      operation,
      (id) => this.policy(id)?.agent ?? false,
      this.clock(),
    );
  }

  /**
   * Which operations this principal may invoke now, as `authorize` decides: those its role's
   * permission allows and, for an agent, that agents may use and its grant names (discovery
   * always). For a caller already authorized in this transaction, under `role`.
   */
  async usable(
    tx: Pick<Transaction, 'select'>,
    actor: Actor,
    role: Role,
  ): Promise<(operation: string) => boolean> {
    const [grant] = actor.agentId
      ? await tx
          .select({ scopes: agentGrants.scopes })
          .from(agentGrants)
          .where(and(eq(agentGrants.companyId, actor.companyId), eq(agentGrants.id, actor.agentId)))
      : [];
    return (operation) => {
      const declared = this.policy(operation);
      return (
        !!declared &&
        roleAllows(role, declared.permission) &&
        (!actor.agentId ||
          (!!grant &&
            declared.agent &&
            (discoveryOperations.includes(operation) || grant.scopes.includes(operation))))
      );
    };
  }

  /**
   * Whether this principal may read data of every class given, as the change feed decides
   * (`events.since`): a person always, since roles carry no data-class rules yet; an agent when
   * the read operations its grant names, `events.since` aside, together cover them.
   */
  async readable(
    tx: Pick<Transaction, 'select'>,
    actor: Actor,
  ): Promise<(classes: readonly DataClass[]) => boolean> {
    if (!actor.agentId) return () => true;
    const [grant] = await tx
      .select({ scopes: agentGrants.scopes })
      .from(agentGrants)
      .where(and(eq(agentGrants.companyId, actor.companyId), eq(agentGrants.id, actor.agentId)));
    const covered = new Set<DataClass>(
      (grant?.scopes ?? []).flatMap((id) => {
        const declared = this.policy(id);
        return declared?.effect === 'read' && id !== 'events.since' ? declared.dataClasses : [];
      }),
    );
    return (classes) => classes.every((kind) => covered.has(kind));
  }

  /** The data classes an operation declares; undefined for one the engine does not know. */
  dataClassesOf(operation: string) {
    return this.policy(operation)?.dataClasses;
  }

  /** An authorized read in a consistent snapshot, at the permission its operation declares. */
  async read<T>(
    actor: Actor,
    operation: string,
    read: (tx: Transaction, access: Access) => Promise<T>,
  ) {
    idSchema.parse(actor.companyId);
    const permission = this.policy(operation)?.permission ?? 'read';
    return this.db.read(async (tx) =>
      read(tx, await this.authorize(tx, actor, permission, operation)),
    );
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
        // The command row keeps the result for replay; the audit chain binds its hash and the
        // records it names, which the change feed (`events.since`) reports.
        body: {
          commandHash: hash,
          resultHash: hashOf(result),
          ...auditRefs(refsOf(operation, result)),
        },
      });
      return result;
    });
  }
}
