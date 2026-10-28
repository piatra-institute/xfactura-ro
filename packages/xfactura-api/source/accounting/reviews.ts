import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { authorize, Commands, type Actor } from './commands';
import type { Transaction } from './db';
import {
  canonical,
  deferralRescheduleEffect,
  deferralRescheduleInput,
  idSchema,
  matchSchema,
  requireCondition,
} from './domain';
import { actionReviews } from './schema';
import { sha256 } from './object-store';
import type { Bank } from './bank';
import type { Periods } from './periods';
import { executeDeferralReschedule, previewDeferralReschedule } from './deferral-reschedules';

export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-01$/);
export const actionRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('bank.match'), input: matchSchema }).strict(),
  z
    .object({
      operation: z.literal('periods.close'),
      input: z.object({ month: monthSchema }).strict(),
    })
    .strict(),
  z
    .object({ operation: z.literal('deferrals.reschedule'), input: deferralRescheduleInput })
    .strict(),
]);
export const actionReviewSchema = z
  .object({ id: idSchema, hash: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const rejectReviewSchema = actionReviewSchema
  .extend({ reason: z.string().trim().min(10).max(1000) })
  .strict();

export class Reviews {
  constructor(
    private readonly runner: Commands,
    private readonly bank: Bank,
    private readonly periods: Periods,
  ) {}

  private async preview(
    tx: Transaction,
    actor: Actor,
    request: z.infer<typeof actionRequestSchema>,
  ) {
    if (request.operation === 'bank.match') return this.bank.previewMatch(tx, actor, request.input);
    if (request.operation === 'periods.close')
      return this.periods.previewClose(tx, actor, request.input.month);
    return previewDeferralReschedule(tx, actor, request.input);
  }

  private async find(tx: Transaction, actor: Actor, id: string) {
    const [review] = await tx
      .select()
      .from(actionReviews)
      .where(and(eq(actionReviews.companyId, actor.companyId), eq(actionReviews.id, id)));
    requireCondition(review, 'NOT_FOUND', 'Solicitarea nu este disponibilă.', 404);
    return review;
  }

  private hash(actor: Actor, request: z.infer<typeof actionRequestSchema>, effect: unknown) {
    return sha256(canonical({ companyId: actor.companyId, ...request, effect }));
  }

  async request(
    actor: Actor,
    key: string,
    input: unknown,
    operation: 'reviews.request' | 'deferrals.proposeReschedule' = 'reviews.request',
  ) {
    const request = actionRequestSchema.parse(input);
    requireCondition(
      operation === 'reviews.request' || request.operation === 'deferrals.reschedule',
      'REVIEW_OPERATION',
      'Operație de revizuire invalidă.',
    );
    return this.runner.run(actor, key, operation, request, 'write', async (tx) => {
      const effect = await this.preview(tx, actor, request);
      const [review] = await tx
        .insert(actionReviews)
        .values({
          id: randomUUID(),
          companyId: actor.companyId,
          ...request,
          effect,
          hash: this.hash(actor, request, effect),
          createdBy: actor.actorId,
        })
        .returning();
      return review;
    });
  }

  async approve(actor: Actor, key: string, input: unknown) {
    const body = actionReviewSchema.parse(input);
    return this.runner.run(actor, key, 'reviews.approve', body, 'review', async (tx) => {
      const review = await this.find(tx, actor, body.id);
      requireCondition(
        review.hash === body.hash,
        'STALE_APPROVAL',
        'Versiunea verificată diferă.',
        409,
      );
      if (review.executedAt) return review;
      const request = actionRequestSchema.parse({
        operation: review.operation,
        input: review.input,
      });
      const effect = await this.preview(tx, actor, request);
      requireCondition(
        this.hash(actor, request, effect) === review.hash,
        'STALE_APPROVAL',
        'Datele s-au schimbat. Pregătiți o nouă solicitare.',
        409,
      );
      if (review.approvedAt) return review;
      const [approved] = await tx
        .update(actionReviews)
        .set({
          approvedBy: actor.actorId,
          approvedAt: new Date().toISOString(),
        })
        .where(and(eq(actionReviews.companyId, actor.companyId), eq(actionReviews.id, review.id)))
        .returning();
      return approved;
    });
  }

  async execute(actor: Actor, key: string, input: unknown) {
    const body = actionReviewSchema.parse(input);
    return this.runner.run(actor, key, 'reviews.execute', body, 'review', async (tx) => {
      const review = await this.find(tx, actor, body.id);
      requireCondition(
        review.hash === body.hash,
        'STALE_APPROVAL',
        'Versiunea verificată diferă.',
        409,
      );
      if (review.executedAt && (review.result as { kind?: string } | null)?.kind === 'declined')
        return review;
      requireCondition(
        review.approvedBy && review.approvedAt,
        'APPROVAL_REQUIRED',
        'Aprobați versiunea exactă înainte de executare.',
        409,
      );
      if (review.executedAt) return review;
      if (review.operation === 'deferrals.reschedule')
        await authorize(tx, { actorId: review.approvedBy, companyId: actor.companyId }, 'review');
      const request = actionRequestSchema.parse({
        operation: review.operation,
        input: review.input,
      });
      const effect = await this.preview(tx, actor, request);
      requireCondition(
        this.hash(actor, request, effect) === review.hash,
        'STALE_APPROVAL',
        'Datele s-au schimbat. Pregătiți o nouă solicitare.',
        409,
      );
      const result =
        request.operation === 'bank.match'
          ? await this.bank.executeMatch(tx, actor, request.input)
          : request.operation === 'periods.close'
            ? await this.periods.executeClose(tx, actor, request.input.month)
            : await executeDeferralReschedule(
                tx,
                actor,
                review.id,
                deferralRescheduleEffect.parse(effect),
              );
      const [executed] = await tx
        .update(actionReviews)
        .set({ result, executedAt: new Date().toISOString() })
        .where(and(eq(actionReviews.companyId, actor.companyId), eq(actionReviews.id, review.id)))
        .returning();
      return executed;
    });
  }

  async reject(actor: Actor, key: string, input: unknown) {
    const body = rejectReviewSchema.parse(input);
    return this.runner.run(actor, key, 'reviews.reject', body, 'review', async (tx) => {
      const review = await this.find(tx, actor, body.id);
      requireCondition(
        review.operation === 'deferrals.reschedule',
        'REVIEW_OPERATION',
        'Această respingere se aplică planurilor de alocare.',
      );
      requireCondition(
        review.hash === body.hash,
        'STALE_APPROVAL',
        'Versiunea verificată diferă.',
        409,
      );
      if (review.executedAt) {
        requireCondition(
          (review.result as { kind?: string } | null)?.kind === 'declined',
          'REVIEW_EXECUTED',
          'Planul a fost deja aplicat.',
          409,
        );
        return review;
      }
      const now = new Date().toISOString();
      const [closed] = await tx
        .update(actionReviews)
        .set({
          result: {
            kind: 'declined',
            reason: body.reason,
            decidedBy: actor.actorId,
            decidedAt: now,
          },
          executedAt: now,
        })
        .where(and(eq(actionReviews.companyId, actor.companyId), eq(actionReviews.id, review.id)))
        .returning();
      return closed;
    });
  }
}
