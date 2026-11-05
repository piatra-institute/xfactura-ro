import { and, asc, eq, gt, or, sql } from 'drizzle-orm';
import { z, type ZodType } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { canonical, hashOf } from 'xfactura-core/hash';
import type { JsonValue } from 'xfactura-core/kernel';
import { bucharestDate } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import { actionDecisions, actionExecutions, actionRequests } from '../db/schema';
import type { Actor, Commands, Permission } from './commands';
import { requireActiveApprover, requireSegregated, segregationOn } from './controls';
import { payClasses, previewWithoutPersons } from './personal';

/**
 * A reviewed action without journal lines (closing or reopening a month, …). A request stores a
 * preview; a person approves that exact preview; execution recomputes it and proceeds only if it
 * is unchanged and has no blocking findings.
 */
export interface ActionHandler<Input> {
  /** The action's kind (`periods.close`, `proposals.batch`, …). */
  operation: string;
  /** The operation that requests it, when not `<operation>.request`. */
  request?: string;
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
    context: ExecutionContext,
  ): Promise<JsonValue>;
  /** Refuses an approval this person may not give for the preview, beyond the action's own
   * segregation (a batch: each member's). */
  approvable?(
    tx: Transaction,
    companyId: string,
    decider: string,
    input: Input,
    preview: JsonValue,
  ): Promise<void>;
  /** What differs between the approved preview and the current one, for the STALE refusal. */
  changes?(approved: JsonValue, current: JsonValue): JsonValue;
}

/** The approval an execution acts on: who decided, under which membership epoch. */
export type ExecutionContext = { decision: { decidedBy: string; decidedEpoch: number } };

export const actionStatuses = ['requested', 'approved', 'rejected', 'executed'] as const;

export type ActionView = {
  id: string;
  operation: string;
  input: JsonValue;
  preview: JsonValue;
  previewHash: string;
  status: (typeof actionStatuses)[number];
  result: JsonValue | null;
};

/** Which requests to list: by status, by kind (the action, e.g. `periods.close`), a page at a
 * time in request order. */
export const actionQuery = z
  .object({
    status: z.enum(actionStatuses).optional(),
    kind: z.string().min(1).max(100).optional(),
    after: z.uuid().optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict();

export class Actions {
  private readonly handlers = new Map<string, ActionHandler<unknown>>();

  constructor(
    private readonly commands: Commands,
    /** The engine's time: the date on which the company's controls are read. */
    private readonly clock: () => number = Date.now,
  ) {}

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
      handler.request ?? `${operation}.request`,
      input,
      handler.permission,
      async (tx) => {
        const { preview } = await handler.preview(tx, actor.companyId, input);
        const id = this.commands.ids();
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
        return this.shown(tx, actor, await this.view(tx, actor.companyId, id));
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
      // The decision's time: segregation is read on its day, here and by the database.
      const now = this.clock();
      const request = await this.find(tx, actor.companyId, input.id);
      const handler = this.handler(request.operation);
      requireCondition(
        request.previewHash === input.previewHash,
        'STALE',
        'Previzualizarea verificată nu mai este actuală.',
        409,
      );
      // Rejecting only stops a request, so a requester may still reject their own.
      if (input.decision === 'approve')
        requireSegregated(
          await segregationOn(tx, actor.companyId, bucharestDate(now)),
          actor.actorId,
          { createdBy: request.createdBy, agentId: request.agentId },
          'action',
        );
      const parsed = handler.input.parse(JSON.parse(request.input));
      const current = await handler.preview(tx, actor.companyId, parsed);
      requireCondition(
        hashOf(current.preview) === request.previewHash,
        'STALE',
        'Registrele s-au schimbat de la cerere. Solicitați o previzualizare nouă.',
        409,
        handler.changes?.(JSON.parse(request.preview) as JsonValue, current.preview),
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
      if (input.decision === 'approve')
        await handler.approvable?.(tx, actor.companyId, actor.actorId, parsed, current.preview);
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
        // None, as agents never decide; the database refuses one (`inv:decision_person`).
        agentId: actor.agentId ?? null,
        reason: input.reason ?? null,
        engineAt: now,
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
      if (done) return this.shown(tx, actor, await this.view(tx, actor.companyId, input.id));
      await requireActiveApprover(
        tx,
        actor.companyId,
        { userId: decision.decidedBy, epoch: decision.decidedEpoch },
        'Persoana care a aprobat acțiunea nu mai este proprietar sau revizor activ. Cereți din nou acțiunea și o aprobare nouă.',
      );
      const parsed = handler.input.parse(JSON.parse(request.input));
      const current = await handler.preview(tx, actor.companyId, parsed);
      requireCondition(
        hashOf(current.preview) === request.previewHash && !current.blocking,
        'STALE',
        'Registrele s-au schimbat de la aprobare. Solicitați o previzualizare nouă.',
        409,
        handler.changes?.(JSON.parse(request.preview) as JsonValue, current.preview),
      );
      const result = await handler.execute(tx, actor, parsed, input.id, current.preview, {
        decision: { decidedBy: decision.decidedBy, decidedEpoch: decision.decidedEpoch },
      });
      await tx.insert(actionExecutions).values({
        companyId: actor.companyId,
        requestId: input.id,
        result: canonical(result),
        executedBy: actor.actorId,
      });
      return this.shown(tx, actor, await this.view(tx, actor.companyId, input.id));
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

  /** A view as this caller sees it: an agent whose reads do not cover `payroll` and `personal`
   * sees no one's pay in a preview (the year close's snapshot sums the personnel accounts' open
   * items, `previewWithoutPersons`). The preview hash is the one approved, whatever is shown. */
  private async shown(tx: Transaction, actor: Actor, view: ActionView): Promise<ActionView> {
    if ((await this.commands.readable(tx, actor))(payClasses)) return view;
    return { ...view, preview: previewWithoutPersons(view.operation, view.preview) as JsonValue };
  }

  get(actor: Actor, id: string) {
    return this.commands.read(actor, 'actions.get', async (tx) =>
      this.shown(tx, actor, await this.view(tx, actor.companyId, id)),
    );
  }

  /** Requests in the order they were made, with the status `view` derives, filtered in SQL. */
  list(actor: Actor, input: z.infer<typeof actionQuery>) {
    return this.commands.read(actor, 'actions.list', async (tx) => {
      const company = eq(actionRequests.companyId, actor.companyId);
      let cursor: { createdAt: string; id: string } | undefined;
      if (input.after) {
        [cursor] = await tx
          .select({ createdAt: actionRequests.createdAt, id: actionRequests.id })
          .from(actionRequests)
          .where(and(company, eq(actionRequests.id, input.after)));
        requireCondition(cursor, 'NOT_FOUND', 'Acțiunea de la care continuă lista nu există.', 404);
      }
      const status = sql<string>`CASE
        WHEN ${actionExecutions.requestId} IS NOT NULL THEN 'executed'
        WHEN ${actionDecisions.decision} = 'approve' THEN 'approved'
        WHEN ${actionDecisions.decision} = 'reject' THEN 'rejected'
        ELSE 'requested' END`;
      const rows = await tx
        .select({ id: actionRequests.id })
        .from(actionRequests)
        .leftJoin(
          actionDecisions,
          and(
            eq(actionDecisions.companyId, actionRequests.companyId),
            eq(actionDecisions.requestId, actionRequests.id),
          ),
        )
        .leftJoin(
          actionExecutions,
          and(
            eq(actionExecutions.companyId, actionRequests.companyId),
            eq(actionExecutions.requestId, actionRequests.id),
          ),
        )
        .where(
          and(
            company,
            input.kind ? eq(actionRequests.operation, input.kind) : undefined,
            input.status ? sql`${status} = ${input.status}` : undefined,
            cursor
              ? or(
                  gt(actionRequests.createdAt, cursor.createdAt),
                  and(
                    eq(actionRequests.createdAt, cursor.createdAt),
                    gt(actionRequests.id, cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(asc(actionRequests.createdAt), asc(actionRequests.id))
        .limit(input.limit + 1);
      const page = rows.slice(0, input.limit);
      return {
        items: await Promise.all(
          page.map(async (row) =>
            this.shown(tx, actor, await this.view(tx, actor.companyId, row.id)),
          ),
        ),
        next: rows.length > input.limit ? page.at(-1)!.id : null,
      };
    });
  }
}
