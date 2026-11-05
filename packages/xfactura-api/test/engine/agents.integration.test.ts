import { afterAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Treatment } from 'xfactura-core/kernel';
import { actionDecisions, agentGrants, memberships } from '../../source/engine/db/schema';
import { Engine } from '../../source/engine/engine';
import type { ActionView } from '../../source/engine/kernel/actions';
import { scenario, secret, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});
const fresh = async () => {
  const s = await scenario();
  open.push(s);
  return s;
};
const expiresAt = () => new Date(Date.now() + 7 * 86_400_000).toISOString();
const issue = (s: Scenario, scopes: string[]) =>
  s.invoke<{ id: string; token: string; scopes: string[]; toolsets: string[] }>(
    s.reviewer,
    'agents.issue',
    { name: 'Asistent', scopes, expiresAt: expiresAt() },
  );
const reviewIds = (s: Scenario) =>
  s.engine.operations
    .grantable()
    .filter((operation) => operation.toolset === 'review')
    .map((operation) => operation.id)
    .sort();

describe('toolset grants', () => {
  test('a toolset expands to its agent operations when issued, beside named operations', async () => {
    const s = await fresh();
    const grant = await issue(s, ['toolset:review', 'parties.list']);
    expect(grant.toolsets).toEqual(['review']);
    expect(grant.scopes).toEqual([...reviewIds(s), 'parties.list'].sort());
    // Approvals belong to people: a toolset never brings them in.
    expect(grant.scopes).toContain('ledger.post');
    expect(grant.scopes).not.toContain('proposals.approve');
    expect(grant.scopes).not.toContain('actions.approve');
    const [listed] = await s.list<{ id: string; scopes: string[]; toolsets: string[] }>(
      s.reviewer,
      'agents.list',
    );
    expect(listed).toMatchObject({ id: grant.id, toolsets: ['review'], scopes: grant.scopes });
    const agent = await s.engine.agents.authenticate(grant.token, s.company.id);
    expect((await s.list(agent, 'actions.list')).length).toBe(0);
    expect((await s.refused(s.invoke(agent, 'evidence.list')))?.code).toBe('AGENT_SCOPE');
  });

  test('an unknown toolset or one without agent operations is refused', async () => {
    const s = await fresh();
    const refusal = await s.refused(issue(s, ['toolset:review', 'toolset:sales', 'toolset:']));
    expect(refusal?.code).toBe('AGENT_SCOPE');
    expect(refusal?.details).toEqual({ unknown: ['toolset:sales', 'toolset:'] });
  });

  test('operations added to a toolset later are not granted by an earlier grant', async () => {
    const s = await fresh();
    const grant = await issue(s, ['toolset:review']);
    const stored = await s.db.read((tx) =>
      tx.select().from(agentGrants).where(eq(agentGrants.id, grant.id)),
    );
    expect(stored[0]).toMatchObject({ scopes: reviewIds(s), toolsets: ['review'] });
    // The catalogue grows: a new review treatment.
    const later: Treatment<{ reference: string }> = {
      id: 'test.later',
      version: 1,
      description: 'Tratament adăugat ulterior.',
      summary: 'A treatment added after the grant.',
      toolset: 'review',
      input: z.object({ reference: z.string() }).strict(),
      agent: true,
      subject: (input) => `test:${input.reference}`,
      plan: () => ({}),
      evaluate: () => ({ effect: null, issues: [] }),
    };
    const grown = new Engine(s.db, s.objects, secret, { treatments: [later] });
    expect(
      grown.operations
        .grantable()
        .filter((operation) => operation.toolset === 'review')
        .map((operation) => operation.id),
    ).toContain('test.later.propose');
    const agent = await grown.agents.authenticate(grant.token, s.company.id);
    const refusal = await s.refused(
      grown.invoke(agent, 'test.later.propose', 'later-propose-1', { reference: 'x' }),
    );
    expect(refusal?.code).toBe('AGENT_SCOPE');
    const { capabilities } = await grown.capabilities(agent);
    expect(capabilities.map((capability) => capability.id)).not.toContain('test.later.propose');
  });
});

describe('capability discovery', () => {
  test('search finds only what the principal may use, by words or toolset', async () => {
    const s = await fresh();
    const grant = await issue(s, ['toolset:inbox', 'proposals.get']);
    const agent = await s.engine.agents.authenticate(grant.token, s.company.id);
    type Match = { id: string; summary: string; toolset: string; effect: string };
    const inbox = await s.list<Match>(agent, 'capabilities.search', { toolset: 'inbox' });
    expect(inbox.map((match) => match.id)).toContain('invoices.import');
    expect(inbox.every((match) => match.toolset === 'inbox')).toBe(true);
    // Every word must match; Romanian text matches without its diacritics.
    expect(
      (await s.list<Match>(agent, 'capabilities.search', { query: 'credit note' })).map(
        (match) => match.id,
      ),
    ).toEqual([
      'documents.list',
      'documents.record',
      'invoices.credit.propose',
      'invoices.credit.revise',
      'invoices.import',
    ]);
    expect(
      (await s.list<Match>(agent, 'capabilities.search', { query: 'factura e-Factura' })).map(
        (match) => match.id,
      ),
    ).toContain('invoices.import');
    // Outside the grant: the owner finds approvals, the agent does not.
    expect(await s.list(agent, 'capabilities.search', { query: 'approves' })).toEqual([]);
    expect(
      (await s.list<Match>(s.owner, 'capabilities.search', { query: 'approves' })).map(
        (match) => match.id,
      ),
    ).toEqual(['actions.approve', 'proposals.approve']);
    const viewer = await s.list<Match>(s.viewer, 'capabilities.search', {});
    // A viewer reads, and may stop automatic posting: any member pulls the brake.
    expect(viewer.filter((match) => match.effect !== 'read').map((match) => match.id)).toEqual([
      'automation.pause',
    ]);
    expect(viewer.map((match) => match.id)).not.toContain('evidence.record');
  });

  test('describe gives the contract of what the principal may use, and refuses the rest', async () => {
    const s = await fresh();
    const grant = await issue(s, ['proposals.list']);
    const agent = await s.engine.agents.authenticate(grant.token, s.company.id);
    const contract = await s.invoke<{
      id: string;
      toolset: string;
      risk: string;
      inputSchema: { properties: Record<string, unknown> };
      outputSchema: { type: string; properties: Record<string, unknown> };
    }>(agent, 'capabilities.describe', { id: 'proposals.list' });
    expect(contract).toMatchObject({ id: 'proposals.list', toolset: 'review', risk: 'low' });
    expect(Object.keys(contract.inputSchema.properties)).toEqual([
      'status',
      'after',
      'limit',
      'withInput',
    ]);
    expect(contract.outputSchema.type).toBe('object');
    expect(Object.keys(contract.outputSchema.properties)).toEqual(['items', 'next']);
    const outside = await s.refused(
      s.invoke(agent, 'capabilities.describe', { id: 'evidence.list' }),
    );
    expect(outside?.code).toBe('AGENT_SCOPE');
    const human = await s.refused(
      s.invoke(s.viewer, 'capabilities.describe', { id: 'proposals.approve' }),
    );
    expect(human?.code).toBe('FORBIDDEN');
    const missing = await s.refused(s.invoke(s.owner, 'capabilities.describe', { id: 'nope' }));
    expect(missing?.code).toBe('CAPABILITY_NOT_FOUND');
  });
});

describe('actions.list', () => {
  test('finds requests by status and kind, in request order, a page at a time', async () => {
    const s = await fresh();
    const january = await s.close('2026-01');
    const approved = await s.invoke<ActionView>(s.reviewer, 'actions.approve', {
      id: january.id,
      previewHash: january.previewHash,
    });
    expect(approved.status).toBe('approved');
    const ids = async (input: Record<string, unknown>) =>
      (await s.list<ActionView>(s.viewer, 'actions.list', input)).map((action) => action.id);
    expect(await ids({ status: 'approved' })).toEqual([january.id]);
    await s.invoke(s.reviewer, 'actions.execute', { id: january.id });
    const february = await s.close('2026-02');
    const march = await s.close('2026-03');
    expect(await ids({ status: 'requested' })).toEqual([february.id, march.id]);
    expect(await ids({ status: 'executed' })).toEqual([january.id]);
    expect(await ids({ status: 'approved' })).toEqual([]);
    expect(await ids({ kind: 'periods.close' })).toEqual([january.id, february.id, march.id]);
    expect(await ids({ kind: 'periods.reopen' })).toEqual([]);
    const first = await s.invoke<{ items: ActionView[]; next: string | null }>(
      s.viewer,
      'actions.list',
      { limit: 2 },
    );
    expect(first.items.map((action) => action.id)).toEqual([january.id, february.id]);
    expect(first.next).toBe(february.id);
    const second = await s.invoke<{ items: ActionView[]; next: string | null }>(
      s.viewer,
      'actions.list',
      { limit: 2, after: first.next },
    );
    expect(second).toMatchObject({ items: [{ id: march.id, status: 'requested' }], next: null });
  });
});

describe('agents never approve', () => {
  // The rule had no database backstop: approvals, decisions and policies recorded no agent, so a
  // code path that skipped the engine's refusal would have stored an agent's approval as its
  // issuer's. Each now records the acting agent, and the database refuses one.
  test('an approval, a decision or a policy made through a grant is refused, by the database too', async () => {
    const s = await fresh();
    const grant = await issue(s, ['toolset:review']);
    const agent = await s.engine.agents.authenticate(grant.token, s.company.id);
    const policy = {
      name: 'Cheltuieli mici',
      treatments: ['ledger.general'],
      rulesHashes: ['a'.repeat(64)],
      preconditions: [],
      validFrom: '2026-01-01',
      expiresAt: s.expiresIn(30),
    };
    const january = await s.close('2026-01');
    for (const [operation, input] of [
      ['policies.create', policy],
      ['actions.approve', { id: january.id, previewHash: january.previewHash }],
    ] as const)
      expect((await s.refused(s.invoke(agent, operation, input)))?.code).toBe('AGENT_SCOPE');
    // A path that skipped the engine's refusal records the agent, and the database refuses it.
    const [member] = await s.engine.db.read((tx) =>
      tx.select().from(memberships).where(eq(memberships.userId, s.reviewer.actorId)),
    );
    const bypass = await s.refused(
      s.engine.db.write((tx) =>
        s.engine.policies.insert(
          tx,
          s.company.id,
          policy,
          { userId: s.reviewer.actorId, epoch: member!.epoch },
          null,
          grant.id,
        ),
      ),
    );
    expect(bypass).toMatchObject({ details: { invariant: 'policy_person' } });
    // What a person approves records no agent.
    const approved = await s.invoke<ActionView>(s.reviewer, 'actions.approve', {
      id: january.id,
      previewHash: january.previewHash,
    });
    expect(approved.status).toBe('approved');
    const [decision] = await s.engine.db.read((tx) =>
      tx.select().from(actionDecisions).where(eq(actionDecisions.requestId, january.id)),
    );
    expect(decision).toMatchObject({ decidedBy: s.reviewer.actorId, agentId: null });
  });
});
