import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { ZodType } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { canonical, hashOf } from 'xfactura-core/hash';
import type { JsonValue } from 'xfactura-core/kernel';
import type { Transaction } from '../db/database';
import { actionDecisions, actionExecutions, actionRequests } from '../db/schema';
import type { Actor, Commands, Permission } from './commands';

/**
 * A reviewed action without journal lines (closing or reopening a month, …). A request stores a
 * preview; a person approves that exact preview; execution recomputes it and proceeds only if it
 * is unchanged and has no blocking findings.
 */
export interface ActionHandler<Input> {
  operation: string;
  permission: Permission;
  input: ZodType<Input>;
  preview(
    tx: Transaction,
    companyId: string,
    input: Input,
  ): Promise<{ blocking: boolean; preview: JsonValue }>;
  execute(
    tx: Transaction,
    actor: Actor,
    input: Input,
    requestId: string,
    preview: JsonValue,
  ): Promise<JsonValue>;
}

export type ActionView = {
  id: string;
  operation: string;
  input: JsonValue;
  preview: JsonValue;
  previewHash: string;
  status: 'requested' | 'approved' | 'rejected' | 'executed';
  result: JsonValue | null;
};

export class Actions {
  private readonly handlers = new Map<string, ActionHandler<unknown>>();

  constructor(private readonly commands: Commands) {}

  add<Input>(handler: ActionHandler<Input>) {
    this.handlers.set(handler.operation, handler as ActionHandler<unknown>);
  }

  private handler(operation: string) {
    const handler = this.handlers.get(operation);
    requireCondition(handler, 'ACTION', 'Acțiunea nu este disponibilă.', 404);
    return handler;
  }

  async request(actor: Actor, key: string, operation: string, raw: unknown) {
    const handler = this.handler(operation);
    const input = handler.input.parse(raw);
    return this.commands.run(
      actor,
      key,
      `${operation}.request`,
      input,
      handler.permission,
      async (tx) => {
        const { preview } = await handler.preview(tx, actor.companyId, input);
        const id = randomUUID();
        await tx.insert(actionRequests).values({
          id,
          companyId: actor.companyId,
          operation,
          input: canonical(input),
          preview: canonical(preview),
          previewHash: hashOf(preview),
          createdBy: actor.actorId,
          agentId: actor.agentId ?? null,
        });
        return this.view(tx, actor.companyId, id);
      },
    );
  }

  async decide(
    actor: Actor,
    key: string,
    input: { id: string; previewHash: string; decision: 'approve' | 'reject'; reason?: string },
  ) {
    requireCondition(!actor.agentId, 'AGENT_SCOPE', 'Decizia aparține unei persoane.', 403);
    const operation = input.decision === 'approve' ? 'actions.approve' : 'actions.reject';
    return this.commands.run(actor, key, operation, input, 'review', async (tx, access) => {
      const request = await this.find(tx, actor.companyId, input.id);
      const handler = this.handler(request.operation);
      requireCondition(
        request.previewHash === input.previewHash,
        'STALE',
        'Previzualizarea verificată nu mai este actuală.',
        409,
      );
      const current = await handler.preview(
        tx,
        actor.companyId,
        handler.input.parse(JSON.parse(request.input)),
      );
      requireCondition(
        hashOf(current.preview) === request.previewHash,
        'STALE',
        'Registrele s-au schimbat de la cerere. Solicitați o previzualizare nouă.',
        409,
      );
      requireCondition(
        input.decision === 'reject' || !current.blocking,
        'BLOCKING_ISSUES',
        'Previzualizarea are constatări care împiedică aprobarea.',
        409,
      );
      requireCondition(
        input.decision === 'approve' || (input.reason?.trim().length ?? 0) >= 10,
        'REASON',
        'Motivați respingerea în cel puțin 10 caractere.',
      );
      const [existing] = await tx
        .select()
        .from(actionDecisions)
        .where(
          and(
            eq(actionDecisions.companyId, actor.companyId),
            eq(actionDecisions.requestId, input.id),
          ),
        );
      requireCondition(!existing, 'DECIDED', 'Acțiunea are deja o decizie.', 409);
      await tx.insert(actionDecisions).values({
        companyId: actor.companyId,
        requestId: input.id,
        decision: input.decision,
        previewHash: input.previewHash,
        decidedBy: actor.actorId,
        decidedEpoch: access.epoch,
        reason: input.reason ?? null,
      });
      return this.view(tx, actor.companyId, input.id);
    });
  }

  async execute(actor: Actor, key: string, input: { id: string }) {
    return this.commands.run(actor, key, 'actions.execute', input, 'review', async (tx) => {
      const request = await this.find(tx, actor.companyId, input.id);
      const handler = this.handler(request.operation);
      const [decision] = await tx
        .select()
        .from(actionDecisions)
        .where(
          and(
            eq(actionDecisions.companyId, actor.companyId),
            eq(actionDecisions.requestId, input.id),
          ),
        );
      requireCondition(
        decision?.decision === 'approve',
        'APPROVAL_REQUIRED',
        'Acțiunea nu este aprobată.',
        409,
      );
      const [done] = await tx
        .select()
        .from(actionExecutions)
        .where(
          and(
            eq(actionExecutions.companyId, actor.companyId),
            eq(actionExecutions.requestId, input.id),
          ),
        );
      if (done) return this.view(tx, actor.companyId, input.id);
      const parsed = handler.input.parse(JSON.parse(request.input));
      const current = await handler.preview(tx, actor.companyId, parsed);
      requireCondition(
        hashOf(current.preview) === request.previewHash && !current.blocking,
        'STALE',
        'Registrele s-au schimbat de la aprobare. Solicitați o previzualizare nouă.',
        409,
      );
      const result = await handler.execute(tx, actor, parsed, input.id, current.preview);
      await tx.insert(actionExecutions).values({
        companyId: actor.companyId,
        requestId: input.id,
        result: canonical(result),
        executedBy: actor.actorId,
      });
      return this.view(tx, actor.companyId, input.id);
    });
  }

  private async find(tx: Transaction, companyId: string, id: string) {
    const [request] = await tx
      .select()
      .from(actionRequests)
      .where(and(eq(actionRequests.companyId, companyId), eq(actionRequests.id, id)));
    requireCondition(request, 'NOT_FOUND', 'Acțiunea nu este disponibilă.', 404);
    return request;
  }

  async view(tx: Transaction, companyId: string, id: string): Promise<ActionView> {
    const request = await this.find(tx, companyId, id);
    const [decision] = await tx
      .select()
      .from(actionDecisions)
      .where(and(eq(actionDecisions.companyId, companyId), eq(actionDecisions.requestId, id)));
    const [execution] = await tx
      .select()
      .from(actionExecutions)
      .where(and(eq(actionExecutions.companyId, companyId), eq(actionExecutions.requestId, id)));
    return {
      id,
      operation: request.operation,
      input: JSON.parse(request.input),
      preview: JSON.parse(request.preview),
      previewHash: request.previewHash,
      status: execution
        ? 'executed'
        : decision
          ? decision.decision === 'approve'
            ? 'approved'
            : 'rejected'
          : 'requested',
      result: execution ? JSON.parse(execution.result) : null,
    };
  }

  get(actor: Actor, id: string) {
    return this.commands.read(actor, 'actions.get', (tx) => this.view(tx, actor.companyId, id));
  }
}
