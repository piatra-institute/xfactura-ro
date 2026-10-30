import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, gte, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { derivedId } from 'xfactura-core/hash';
import type { Database, Transaction } from '../db/database';
import { audit, companies, cursors, jobs, schedules } from '../db/schema';
import { readEvents, type AuditEvent } from './events';

/*
 * Work outside a request, run by the worker (`worker.ts`):
 * - jobs: queued work of a kind (an export, a scheduled run), claimed under a lease that the
 *   handler renews between long steps, so a crashed worker's job is taken over, and failed after
 *   repeated interruptions;
 * - schedules: recurring jobs, each slot queued once whatever the number of workers;
 * - consumers: processes that follow every company's audit log from a cursor of their own.
 */

export type Job = typeof jobs.$inferSelect;
/** A job claimed by this process, under `leaseToken`. */
export type ClaimedJob = Job & { leaseToken: string };

export interface Lease {
  /** Extends the lease; fails with LEASE_LOST once another process holds the job. */
  renew(): Promise<void>;
}

/** Work of one kind. Authority is the handler's to recheck: the job keeps who asked for it. */
export interface JobHandler {
  kind: string;
  /** Why a job interrupted on every attempt failed, for the person who asked for it. */
  interrupted: string;
  /** Does the work, renewing the lease between long steps; returns the result to store. */
  run(job: ClaimedJob, lease: Lease): Promise<unknown>;
  /** Checks, in the transaction storing the result, that it may still be stored. */
  complete?(tx: Transaction, job: ClaimedJob): Promise<void>;
}

/** When a schedule recurs. */
export const scheduleRule = z.discriminatedUnion('kind', [
  /** Every `minutes`, counted from the first slot. */
  z
    .object({
      kind: z.literal('interval'),
      minutes: z
        .number()
        .int()
        .min(1)
        .max(366 * 24 * 60),
    })
    .strict(),
]);
export type ScheduleRule = z.infer<typeof scheduleRule>;

/** The first slot after `now` of a rule whose last slot was `slot`: slots missed while no
 * worker ran are run once, not caught up one by one. */
export function nextSlot(rule: ScheduleRule, slot: number, now: number) {
  const period = rule.minutes * 60_000;
  return slot + (Math.floor(Math.max(now - slot, 0) / period) + 1) * period;
}

/** The job a schedule's slot queues: the same id for every worker that queues it. */
export const scheduledJobId = (scheduleId: string, slot: number) =>
  derivedId('schedule', scheduleId, String(slot));

const message = (error: unknown) =>
  (error instanceof Error ? error.message : 'Lucrarea a eșuat.').slice(0, 500);

export class Jobs {
  private readonly handlers = new Map<string, JobHandler>();

  constructor(
    private readonly db: Database,
    /** Wall-clock time for leases and schedules, not the engine's business clock. */
    private readonly clock: () => number = Date.now,
    private readonly leaseMs = 60_000,
    private readonly maxAttempts = 3,
  ) {}

  add(...handlers: JobHandler[]) {
    for (const handler of handlers) {
      if (this.handlers.has(handler.kind)) throw new Error(`Duplicate job kind ${handler.kind}.`);
      this.handlers.set(handler.kind, handler);
    }
  }

  /** Queues a job in the caller's transaction. A job with a given id is queued at most once:
   * the second time returns undefined. */
  static async enqueue(
    tx: Transaction,
    job: {
      id?: string;
      companyId: string;
      actorId: string;
      agentId?: string | null;
      kind: string;
      params: unknown;
    },
  ) {
    const [row] = await tx
      .insert(jobs)
      .values({
        id: job.id ?? randomUUID(),
        companyId: job.companyId,
        actorId: job.actorId,
        agentId: job.agentId ?? null,
        kind: job.kind,
        params: job.params,
      })
      .onConflictDoNothing()
      .returning();
    return row;
  }

  /** Adds a recurring job in the caller's transaction; its first slot is `firstRunAt`. */
  static async schedule(
    tx: Transaction,
    schedule: {
      id?: string;
      companyId: string;
      actorId: string;
      agentId?: string | null;
      kind: string;
      rule: ScheduleRule;
      params: unknown;
      firstRunAt: number;
    },
  ) {
    const id = schedule.id ?? randomUUID();
    await tx.insert(schedules).values({
      id,
      companyId: schedule.companyId,
      kind: schedule.kind,
      rule: scheduleRule.parse(schedule.rule),
      params: schedule.params,
      actorId: schedule.actorId,
      agentId: schedule.agentId ?? null,
      nextRunAt: schedule.firstRunAt,
    });
    return id;
  }

  /**
   * Queues the job of every schedule whose slot has come and moves the schedule to its next
   * slot. The job's id derives from the schedule and the slot, so workers racing on the same
   * slot queue it once. Returns how many jobs this call queued.
   */
  async enqueueDue(limit = 100) {
    const now = this.clock();
    return this.db.write(async (tx) => {
      const due = await tx
        .select()
        .from(schedules)
        .where(lte(schedules.nextRunAt, now))
        .orderBy(asc(schedules.nextRunAt))
        .limit(limit);
      let queued = 0;
      for (const schedule of due) {
        const slot = schedule.nextRunAt;
        const job = await Jobs.enqueue(tx, {
          id: scheduledJobId(schedule.id, slot),
          companyId: schedule.companyId,
          actorId: schedule.actorId,
          agentId: schedule.agentId,
          kind: schedule.kind,
          params: schedule.params,
        });
        if (job) queued++;
        await tx
          .update(schedules)
          .set({ nextRunAt: nextSlot(scheduleRule.parse(schedule.rule), slot, now) })
          .where(
            and(
              eq(schedules.companyId, schedule.companyId),
              eq(schedules.id, schedule.id),
              eq(schedules.nextRunAt, slot),
            ),
          );
      }
      return queued;
    });
  }

  /** Claims the oldest runnable job of a known kind: pending, or running under an expired
   * lease. Jobs whose lease expired on their last attempt fail first. */
  async claim(): Promise<ClaimedJob | null> {
    const kinds = [...this.handlers.keys()];
    if (kinds.length === 0) return null;
    return this.db.write(async (tx) => {
      const now = this.clock();
      for (const handler of this.handlers.values())
        await tx
          .update(jobs)
          .set({ status: 'failed', error: handler.interrupted, leaseUntil: null })
          .where(
            and(
              eq(jobs.kind, handler.kind),
              eq(jobs.status, 'running'),
              lt(jobs.leaseUntil, now),
              gte(jobs.attempts, this.maxAttempts),
            ),
          );
      const [next] = await tx
        .select()
        .from(jobs)
        .where(
          and(
            inArray(jobs.kind, kinds),
            lt(jobs.attempts, this.maxAttempts),
            or(
              eq(jobs.status, 'pending'),
              and(eq(jobs.status, 'running'), lt(jobs.leaseUntil, now)),
            ),
          ),
        )
        .orderBy(asc(jobs.createdAt), asc(jobs.id))
        .limit(1);
      if (!next) return null;
      const claimed = {
        ...next,
        status: 'running' as const,
        attempts: next.attempts + 1,
        leaseToken: randomUUID(),
        leaseUntil: now + this.leaseMs,
      };
      await tx
        .update(jobs)
        .set({
          status: claimed.status,
          attempts: claimed.attempts,
          leaseToken: claimed.leaseToken,
          leaseUntil: claimed.leaseUntil,
        })
        .where(and(eq(jobs.companyId, next.companyId), eq(jobs.id, next.id)));
      return claimed;
    });
  }

  /** Claims and runs one job; returns false when there is none. A failure is stored on the job,
   * never thrown. */
  async runOne() {
    const job = await this.claim();
    if (!job) return false;
    await this.run(job);
    return true;
  }

  /** Runs a claimed job to its end: done with its result, or failed with the reason. */
  async run(job: ClaimedJob) {
    const handler = this.handlers.get(job.kind)!;
    const owned = () =>
      and(
        eq(jobs.companyId, job.companyId),
        eq(jobs.id, job.id),
        eq(jobs.leaseToken, job.leaseToken),
        eq(jobs.status, 'running'),
        gt(jobs.leaseUntil, this.clock()),
      );
    const lost = 'Lucrarea a fost preluată de alt proces.';
    const lease: Lease = {
      renew: async () => {
        const renewed = await this.db.write((tx) =>
          tx
            .update(jobs)
            .set({ leaseUntil: this.clock() + this.leaseMs })
            .where(owned())
            .returning({ id: jobs.id }),
        );
        requireCondition(renewed.length, 'LEASE_LOST', lost, 409);
      },
    };
    try {
      const result = await handler.run(job, lease);
      await this.db.write(async (tx) => {
        await handler.complete?.(tx, job);
        const saved = await tx
          .update(jobs)
          .set({ status: 'done', result: result ?? null, leaseUntil: null })
          .where(owned())
          .returning({ id: jobs.id });
        requireCondition(saved.length, 'LEASE_LOST', lost, 409);
      });
    } catch (error) {
      // Only the holder of the lease records the failure; a lost lease leaves the job to its
      // new holder.
      await this.db.write((tx) =>
        tx
          .update(jobs)
          .set({ status: 'failed', error: message(error), leaseUntil: null })
          .where(
            and(
              eq(jobs.companyId, job.companyId),
              eq(jobs.id, job.id),
              eq(jobs.leaseToken, job.leaseToken),
              eq(jobs.status, 'running'),
            ),
          ),
      );
    }
  }
}

/** A process that follows each company's audit log in order (projections, notifications). */
export interface Consumer {
  /** Its cursor's name; renaming it starts over from the first event. */
  name: string;
  /**
   * Handles a company's next events, in order, idempotently: after a crash it sees them again.
   * Returns false when it stopped short of the last of them (a budget, more to do): the cursor
   * stays and the same events come again on the next run.
   */
  handle(companyId: string, events: AuditEvent[]): Promise<boolean>;
}

/** Each company's position in its audit log, per consumer. */
export class Consumers {
  private readonly consumers: Consumer[] = [];

  constructor(
    private readonly db: Database,
    private readonly batch = 500,
  ) {}

  add(...consumers: Consumer[]) {
    for (const consumer of consumers) {
      if (this.consumers.some((known) => known.name === consumer.name))
        throw new Error(`Duplicate consumer ${consumer.name}.`);
      this.consumers.push(consumer);
    }
  }

  /** Where a consumer is in a company's log: the last `seq` it handled, 0 before any. */
  static async position(tx: Pick<Transaction, 'select'>, companyId: string, consumer: string) {
    const [row] = await tx
      .select({ seq: cursors.seq })
      .from(cursors)
      .where(and(eq(cursors.companyId, companyId), eq(cursors.consumer, consumer)));
    return row?.seq ?? 0;
  }

  /** The companies whose log runs past a consumer's cursor, with both positions. */
  private behind(consumer: string) {
    const head = sql<number>`(select max(${audit.seq}) from ${audit} where ${audit.companyId} = ${companies.id})`;
    const position = sql<number>`coalesce(${cursors.seq}, 0)`;
    return this.db.read((tx) =>
      tx
        .select({ companyId: companies.id, position: position.mapWith(Number) })
        .from(companies)
        .leftJoin(cursors, and(eq(cursors.companyId, companies.id), eq(cursors.consumer, consumer)))
        .where(sql`${head} > ${position}`)
        .orderBy(asc(companies.id)),
    );
  }

  /** Moves a cursor forward, never back: two workers handling the same events agree. */
  private advance(companyId: string, consumer: string, seq: number) {
    return this.db.write((tx) =>
      tx
        .insert(cursors)
        .values({ companyId, consumer, seq })
        .onConflictDoUpdate({
          target: [cursors.companyId, cursors.consumer],
          set: { seq, updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` },
          setWhere: lt(cursors.seq, seq),
        }),
    );
  }

  /** Gives every consumer one batch of each company it is behind on; returns whether there
   * was anything to handle. */
  async runOnce() {
    let worked = false;
    for (const consumer of this.consumers)
      for (const { companyId, position } of await this.behind(consumer.name)) {
        const events = await this.db.read((tx) => readEvents(tx, companyId, position, this.batch));
        if (events.length === 0) continue;
        worked = true;
        if (await consumer.handle(companyId, events))
          await this.advance(companyId, consumer.name, events.at(-1)!.seq);
      }
    return worked;
  }
}
