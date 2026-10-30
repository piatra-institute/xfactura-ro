import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, count, eq } from 'drizzle-orm';
import {
  audit,
  jobs,
  proposalChecks,
  proposalVersions,
  schedules,
} from '../../source/engine/db/schema';
import type { Actor } from '../../source/engine/kernel/commands';
import { eventClasses, resultKind, type Ref } from '../../source/engine/kernel/events';
import {
  Consumers,
  Jobs,
  nextSlot,
  scheduledJobId,
  type JobHandler,
} from '../../source/engine/kernel/jobs';
import { outputSchema } from '../../source/engine/kernel/operations';
import { projectConsumer, proposalStaleness } from '../../source/engine/kernel/projectors';
import type { ProposalView } from '../../source/engine/kernel/views';
import { createEngine } from '../../source/engine/runtime';
import { config } from '../../source/engine/config';
import { journal, scenario, type Scenario } from './scenario';

type Shown = {
  seq: number;
  at: string;
  operation: string;
  actor: { userId: string; agentId: string | null };
  refs: Ref[];
  hash: string;
};
type Event = Shown | { seq: number; redacted: true };
type Feed = { items: Event[]; next: string | null; head: number };

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});
const fresh = async () => {
  const s = await scenario();
  open.push(s);
  return s;
};
const feed = (s: Scenario, actor: Actor, input: { after?: number | string; limit?: number } = {}) =>
  s.invoke<Feed>(actor, 'events.since', { limit: 500, ...input });
const shown = (event: Event): event is Shown => !('redacted' in event);
const seqs = (page: Feed) => page.items.map((event) => event.seq);
const range = (to: number) => Array.from({ length: to }, (_, index) => index + 1);
const expiresAt = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

async function agent(s: Scenario, scopes: string[]) {
  const grant = await s.invoke<{ id: string; token: string }>(s.reviewer, 'agents.issue', {
    name: 'Asistent',
    scopes,
    expiresAt: expiresAt(),
  });
  return s.engine.agents.authenticate(grant.token, s.company.id);
}

const expense = (evidenceId: string, amount: string) =>
  journal(evidenceId, [
    { account: '628', side: 'D', amount },
    { account: '5121', side: 'C', amount },
  ]);

/** A posted sale on credit; returns its receivable. */
async function receivable(s: Scenario) {
  const { id: evidenceId } = await s.evidence();
  const client = await s.party();
  const sale = await s.book(
    'ledger.general',
    journal(
      evidenceId,
      [
        { account: '4111', side: 'D', amount: '1000.00', newItem: 'client' },
        { account: '704', side: 'C', amount: '1000.00' },
      ],
      { newItems: [{ ref: 'client', partyId: client.id }] },
    ),
  );
  const item = sale.effect!.openItems[0]!.id;
  const receipt = (amount: string) =>
    journal(evidenceId, [
      { account: '5121', side: 'D', amount },
      { account: '4111', side: 'C', amount, openItem: item },
    ]);
  return { item, receipt, evidenceId };
}

describe('change feed', () => {
  test('each command records the records its result names, in order and without gaps', async () => {
    const s = await fresh();
    const { id: evidenceId } = await s.evidence();
    const posted = await s.book('ledger.general', expense(evidenceId, '12.00'));
    const page = await feed(s, s.owner);
    expect(seqs(page)).toEqual(range(page.head));
    expect(page.next).toBeNull();
    const events = page.items.filter(shown);
    const last = (operation: string) => events.findLast((event) => event.operation === operation)!;
    expect(last('evidence.record').refs).toEqual([{ kind: 'evidence', id: evidenceId }]);
    expect(last('ledger.general.propose').refs).toEqual([{ kind: 'proposal', id: posted.id }]);
    expect(last('ledger.post').refs).toEqual([
      { kind: 'proposal', id: posted.id },
      { kind: 'entry', id: posted.entry!.id },
    ]);
    expect(last('ledger.post').actor).toEqual({ userId: s.reviewer.actorId, agentId: null });
    // The feed reports the audit chain's own hashes.
    const rows = await s.db.read((tx) =>
      tx.select().from(audit).where(eq(audit.companyId, s.company.id)),
    );
    expect(events.map((event) => event.hash)).toEqual(rows.map((row) => row.hash));
    // Pages follow `next`, which also takes a number.
    const first = await feed(s, s.owner, { limit: 2 });
    expect(seqs(first)).toEqual([1, 2]);
    expect(first.next).toBe('2');
    const rest = await feed(s, s.owner, { after: first.next! });
    expect(seqs(rest)).toEqual(range(page.head).slice(2));
    expect(seqs(await feed(s, s.owner, { after: 2, limit: 1 }))).toEqual([3]);
    expect((await feed(s, s.owner, { after: page.head })).items).toEqual([]);
  });

  test("a policy's posting is an event of its own, naming the policy, proposal and entry", async () => {
    const s = await fresh();
    const { id: evidenceId } = await s.evidence();
    const sample = await s.propose('ledger.general', expense(evidenceId, '1.00'));
    const policy = await s.invoke<{ id: string }>(s.reviewer, 'policies.create', {
      name: 'Comisioane bancare mici',
      treatments: ['ledger.general'],
      rulesHashes: [sample.rulesHash],
      preconditions: [{ kind: 'noWarnings' }, { kind: 'maxLineAmount', amount: '100.00' }],
      validFrom: '2026-01-01',
      expiresAt: expiresAt(),
    });
    const automatic = await s.propose('ledger.general', expense(evidenceId, '25.00'));
    expect(automatic.status).toBe('posted');
    const events = (await feed(s, s.owner)).items.filter(shown);
    const [applied, proposed] = events.slice(-2);
    expect(applied).toMatchObject({
      operation: 'policies.applied',
      actor: { userId: s.owner.actorId, agentId: null },
      refs: [
        { kind: 'proposal', id: automatic.id },
        { kind: 'entry', id: automatic.entry!.id },
        { kind: 'policy', id: policy.id },
      ],
    });
    expect(proposed!.operation).toBe('ledger.general.propose');
    expect(proposed!.refs).toContainEqual({ kind: 'policy', id: policy.id });
    // A proposal no policy posts records no application.
    await s.propose('ledger.general', expense(evidenceId, '250.00'));
    expect(
      (await feed(s, s.owner)).items.filter(
        (event) => shown(event) && event.operation === 'policies.applied',
      ),
    ).toHaveLength(1);
  });

  test('an agent sees the events of the data its grant reads; the others keep their place', async () => {
    const s = await fresh();
    const books = await agent(s, ['events.since', 'proposals.list']);
    const files = await agent(s, ['events.since', 'proposals.list', 'evidence.list']);
    const feedOnly = await agent(s, ['events.since']);
    const { id: evidenceId } = await s.evidence();
    await s.propose('ledger.general', expense(evidenceId, '10.00'));
    await s.party('Furnizor SRL');
    const all = (await feed(s, s.viewer)).items;
    // People see every event: roles carry no data-class rules yet.
    expect(all.every(shown)).toBe(true);
    const operations = (all as Shown[]).map((event) => event.operation);
    const visibleTo = async (actor: Actor) => {
      const page = await feed(s, actor);
      expect(seqs(page)).toEqual(range(all.length));
      for (const event of page.items)
        if (!shown(event)) expect(event).toEqual({ seq: event.seq, redacted: true });
      return page.items.filter(shown).map((event) => event.operation);
    };
    expect(await visibleTo(books)).toEqual(
      operations.filter((operation) =>
        ['company.create', 'ledger.general.propose', 'parties.create'].includes(operation),
      ),
    );
    expect(await visibleTo(files)).toEqual(
      operations.filter((operation) =>
        ['company.create', 'evidence.record', 'ledger.general.propose', 'parties.create'].includes(
          operation,
        ),
      ),
    );
    // Membership, invitations and credentials are no data class a grant may read.
    expect(operations).toEqual(expect.arrayContaining(['company.invite', 'agents.issue']));
    expect(await visibleTo(feedOnly)).toEqual([]);
  });

  test('every audit action has data classes, and refs carry no secrets', async () => {
    const s = await fresh();
    await agent(s, ['events.since']);
    const { id: evidenceId } = await s.evidence();
    await s.book('ledger.general', expense(evidenceId, '5.00'));
    await s.close('2026-01');
    const rows = await s.db.read((tx) =>
      tx.select().from(audit).where(eq(audit.companyId, s.company.id)),
    );
    expect(
      rows.filter((row) => !eventClasses(s.engine.operations, row.action)).map((row) => row.action),
    ).toEqual([]);
    // An invitation's or a grant's token is in the command's stored result, never in the log.
    expect(rows.some((row) => row.body.includes('xfa_'))).toBe(false);
    const issued = rows.find((row) => row.action === 'agents.issue')!;
    expect(JSON.parse(issued.body).refs).toEqual([{ kind: 'grant', id: expect.any(String) }]);
  });

  test('every command whose result has an id says what that id names', async () => {
    const s = await fresh();
    const unnamed = s.engine.operations
      .all()
      .filter((operation) => operation.effect !== 'read')
      .filter((operation) => {
        const schema = outputSchema(operation) as { properties?: Record<string, unknown> };
        return schema.properties?.id !== undefined && resultKind(operation.id) === undefined;
      })
      .map((operation) => operation.id);
    expect(unnamed).toEqual([]);
  });
});

describe('jobs', () => {
  const echo = (calls: string[], run?: JobHandler['run']): JobHandler => ({
    kind: 'test.echo',
    interrupted: 'Întreruptă repetat.',
    run:
      run ??
      (async (job) => {
        calls.push(job.id);
        return { echoed: job.params };
      }),
  });
  const queue = (s: Scenario, id?: string) =>
    s.db.write((tx) =>
      Jobs.enqueue(tx, {
        ...(id ? { id } : {}),
        companyId: s.company.id,
        actorId: s.owner.actorId,
        kind: 'test.echo',
        params: { n: 1 },
      }),
    );
  const job = async (s: Scenario, id: string) =>
    (
      await s.db.read((tx) =>
        tx
          .select()
          .from(jobs)
          .where(and(eq(jobs.companyId, s.company.id), eq(jobs.id, id))),
      )
    )[0]!;

  test('runs only kinds it knows, renews its lease and stores the result', async () => {
    const s = await fresh();
    let now = Date.now();
    const runner = new Jobs(s.db, () => now);
    expect(await runner.runOne()).toBe(false);
    const queued = await queue(s);
    expect(await runner.runOne()).toBe(false);
    runner.add(
      echo([], async (_, lease) => {
        // Longer than one lease: only the renewal keeps the job this worker's.
        now += 50_000;
        await lease.renew();
        now += 50_000;
        return { ok: true };
      }),
    );
    expect(await runner.runOne()).toBe(true);
    expect(await job(s, queued!.id)).toMatchObject({
      status: 'done',
      attempts: 1,
      result: { ok: true },
      leaseUntil: null,
    });
    expect(await runner.runOne()).toBe(false);
  });

  test('a worker that lost its lease neither stores nor fails the job its successor holds', async () => {
    const s = await fresh();
    let now = Date.now();
    const calls: string[] = [];
    const first = new Jobs(s.db, () => now);
    const second = new Jobs(s.db, () => now);
    first.add(echo(calls));
    second.add(echo(calls));
    const queued = await queue(s);
    const stalled = (await first.claim())!;
    now += 61_000;
    const taken = (await second.claim())!;
    expect(taken.id).toBe(stalled.id);
    expect(taken.attempts).toBe(2);
    await first.run(stalled);
    expect(await job(s, queued!.id)).toMatchObject({
      status: 'running',
      leaseToken: taken.leaseToken,
    });
    await second.run(taken);
    expect(await job(s, queued!.id)).toMatchObject({
      status: 'done',
      result: { echoed: { n: 1 } },
    });
  });

  test('a job interrupted on every attempt fails with its kind’s reason', async () => {
    const s = await fresh();
    let now = Date.now();
    const runner = new Jobs(s.db, () => now);
    runner.add(echo([]));
    const queued = await queue(s);
    for (const attempt of [1, 2, 3]) {
      expect((await runner.claim())?.attempts).toBe(attempt);
      now += 61_000;
    }
    expect(await runner.claim()).toBeNull();
    expect(await job(s, queued!.id)).toMatchObject({
      status: 'failed',
      error: 'Întreruptă repetat.',
    });
  });

  test('a schedule queues each slot once, however many workers race for it', async () => {
    const s = await fresh();
    const start = Date.parse('2026-10-30T08:00:00Z');
    const hour = 3_600_000;
    const now = start + 2.5 * hour;
    const id = await s.db.write((tx) =>
      Jobs.schedule(tx, {
        companyId: s.company.id,
        actorId: s.owner.actorId,
        kind: 'test.echo',
        rule: { kind: 'interval', minutes: 60 },
        params: { n: 2 },
        firstRunAt: start,
      }),
    );
    // Two workers racing for the slot. (Processes share the database file; within one process
    // writes are queued, as two blocking BEGINs would stall the event loop.)
    const queued = await Promise.all([
      new Jobs(s.db, () => now).enqueueDue(),
      new Jobs(s.db, () => now).enqueueDue(),
    ]);
    expect(queued[0] + queued[1]).toBe(1);
    const rows = await s.db.read((tx) =>
      tx.select().from(jobs).where(eq(jobs.companyId, s.company.id)),
    );
    // The slots missed while no worker ran are run once, not one by one.
    expect(rows.map((row) => row.id)).toEqual([scheduledJobId(id, start)]);
    expect(rows[0]).toMatchObject({ kind: 'test.echo', params: { n: 2 }, status: 'pending' });
    const [schedule] = await s.db.read((tx) =>
      tx.select().from(schedules).where(eq(schedules.id, id)),
    );
    expect(schedule!.nextRunAt).toBe(start + 3 * hour);
    expect(nextSlot({ kind: 'interval', minutes: 60 }, start, start)).toBe(start + hour);
    // Queuing the same slot again adds nothing.
    expect(await queue(s, scheduledJobId(id, start))).toBeUndefined();
    expect(await new Jobs(s.db, () => now).enqueueDue()).toBe(0);
  });
});

describe('proposal staleness', () => {
  const position = (s: Scenario) =>
    s.db.read((tx) => Consumers.position(tx, s.company.id, 'project'));
  const get = (s: Scenario, proposal: ProposalView, recheck = false) =>
    s.invoke<ProposalView>(s.owner, 'proposals.get', { id: proposal.id, recheck });

  test('the worker marks a proposal stale once the books it read change', async () => {
    const s = await fresh();
    const { item, receipt, evidenceId } = await receivable(s);
    const input = receipt('600.00');
    const first = await s.approve(await s.propose('ledger.general', input));
    const unrelated = await s.propose('ledger.general', expense(evidenceId, '7.00'));
    await s.book('ledger.general', receipt('300.00'));
    // Until a check runs, nothing claims to know.
    expect(await get(s, first)).toMatchObject({ status: 'approved', check: null });
    expect(await s.engine.consumers.runOnce()).toBe(true);
    const stale = await get(s, first);
    const head = (await feed(s, s.owner)).head;
    expect(stale.status).toBe('stale');
    expect(stale.approval).not.toBeNull();
    expect(stale.check).toMatchObject({ seq: head, stale: true });
    const moved = stale.check!.changed.find((change) => change.kind === 'openItem')!;
    expect(moved.id).toBe(item);
    expect(moved.before).not.toBe(moved.after);
    expect(await get(s, unrelated)).toMatchObject({
      status: 'proposed',
      check: { seq: head, stale: false, changed: [] },
    });
    expect(
      (await s.list<ProposalView>(s.owner, 'proposals.list', { status: 'stale' })).map((p) => p.id),
    ).toEqual([first.id]);
    expect(await position(s)).toBe(head);
    expect(await s.engine.consumers.runOnce()).toBe(false);
    // The cache is a signal; posting re-evaluates as before.
    expect((await s.refused(s.post(first)))?.code).toBe('STALE');
    const revised = await s.revise('ledger.general', stale, input);
    expect(revised).toMatchObject({ status: 'proposed', version: 2, check: null });
  });

  test('proposals.get with recheck finds staleness live and writes nothing to the books', async () => {
    const s = await fresh();
    const { receipt } = await receivable(s);
    const first = await s.propose('ledger.general', receipt('600.00'));
    await s.book('ledger.general', receipt('300.00'));
    const counts = () =>
      s.db.read(async (tx) => [
        (await tx.select({ n: count() }).from(audit).where(eq(audit.companyId, s.company.id)))[0]!
          .n,
        (
          await tx
            .select({ n: count() })
            .from(proposalVersions)
            .where(eq(proposalVersions.companyId, s.company.id))
        )[0]!.n,
      ]);
    const reader = await agent(s, ['proposals.get']);
    const before = await counts();
    const rechecked = await s.invoke<ProposalView>(reader, 'proposals.get', {
      id: first.id,
      recheck: true,
    });
    expect(rechecked.status).toBe('stale');
    expect(await counts()).toEqual(before);
    // A recheck of an unchanged proposal clears nothing it should not: still current.
    const current = await s.propose('ledger.general', receipt('100.00'));
    expect(await get(s, current, true)).toMatchObject({
      status: 'proposed',
      check: { stale: false },
    });
  });

  test('events that change nothing a proposal reads trigger no recheck', async () => {
    const s = await fresh();
    const { id: evidenceId } = await s.evidence();
    const pending = await s.propose('ledger.general', expense(evidenceId, '3.00'));
    await s.engine.consumers.runOnce();
    const checked = (await get(s, pending)).check!.seq;
    await s.approve(pending);
    await s.invoke(s.owner, 'proposals.withdraw', {
      proposalId: (await s.propose('ledger.general', expense(evidenceId, '4.00'))).id,
      reason: 'Introdusă din greșeală',
    });
    expect(await s.engine.consumers.runOnce()).toBe(true);
    expect((await get(s, pending)).check!.seq).toBe(checked);
    expect(await position(s)).toBe((await feed(s, s.owner)).head);
    await s.book('ledger.general', expense(evidenceId, '5.00'));
    await s.engine.consumers.runOnce();
    expect((await get(s, pending)).check!.seq).toBe((await feed(s, s.owner)).head);
  });

  test('a recheck budget keeps the cursor until every open proposal is checked', async () => {
    const s = await fresh();
    const { id: evidenceId } = await s.evidence();
    await s.propose('ledger.general', expense(evidenceId, '1.00'));
    await s.propose('ledger.general', expense(evidenceId, '2.00'));
    const consumers = new Consumers(s.db);
    consumers.add(projectConsumer([proposalStaleness(s.db, s.engine.proposals, 1)]));
    const checks = async () =>
      (
        await s.db.read((tx) =>
          tx
            .select({ n: count() })
            .from(proposalChecks)
            .where(eq(proposalChecks.companyId, s.company.id)),
        )
      )[0]!.n;
    expect(await consumers.runOnce()).toBe(true);
    expect([await checks(), await position(s)]).toEqual([1, 0]);
    expect(await consumers.runOnce()).toBe(true);
    expect([await checks(), await position(s)]).toEqual([2, (await feed(s, s.owner)).head]);
  });
});

describe('createEngine', () => {
  test('builds the engine the API and the worker share, with the ANAF application', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xfactura-runtime-'));
    const names = [
      'DATABASE_URL',
      'ACCOUNTING_AUTH_SECRET',
      'ACCOUNTING_OBJECT_DIR',
      'ACCOUNTING_ANAF_CLIENT_ID',
      'ACCOUNTING_ANAF_CLIENT_SECRET',
      'ACCOUNTING_ANAF_REDIRECT_URI',
    ];
    const saved = names.map((name) => process.env[name]);
    Object.assign(process.env, {
      DATABASE_URL: `file:${directory}/books.db`,
      ACCOUNTING_AUTH_SECRET: 'synthetic-runtime-secret-at-least-32-characters',
      ACCOUNTING_OBJECT_DIR: join(directory, 'objects'),
      ACCOUNTING_ANAF_CLIENT_ID: 'client',
      ACCOUNTING_ANAF_CLIENT_SECRET: 'secret',
      ACCOUNTING_ANAF_REDIRECT_URI: 'https://example.test/anaf',
    });
    try {
      const { db, engine, options } = await createEngine(config());
      expect(options.databaseUrl).toBe(`file:${directory}/books.db`);
      expect(engine.anaf).not.toBeNull();
      expect(engine.operations.find('events.since')).toBeDefined();
      await db.migrate();
      expect(await engine.jobs.runOne()).toBe(false);
      expect(await engine.consumers.runOnce()).toBe(false);
      await db.close();
    } finally {
      names.forEach((name, index) => {
        if (saved[index] === undefined) delete process.env[name];
        else process.env[name] = saved[index];
      });
      await rm(directory, { recursive: true, force: true });
    }
  });
});
