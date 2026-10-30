import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import type { ActionView } from '../../source/engine/kernel/actions';
import type { Actor } from '../../source/engine/kernel/commands';
import type { ProposalView } from '../../source/engine/kernel/views';
import type { WorkItem } from '../../source/engine/kernel/work';
import { journal, scenario } from './scenario';

afterEach(() => {
  setSystemTime();
});

/** Identifiers as the evaluation harness seeds them: the same sequence every run. */
const sequence = () => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}`;
};

/** 16 March 2026, months before the wall clock of any run of this suite. */
const engineTime = Date.parse('2026-03-16T10:00:00Z');

/** Timestamps the database writes on its own clock: audit records, never decisions. */
const wallKeys = new Set(['at', 'createdAt', 'postedAt']);
const withoutWallTime = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(withoutWallTime)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => !wallKeys.has(key))
            .map(([key, item]) => [key, withoutWallTime(item)]),
        )
      : value;

/**
 * A month of work at the engine's time, with JavaScript's clock at `wall` (the database's stays
 * the host's): segregation of duties that starts after the engine's day, a grant, a posting policy
 * that posts an agent's proposal, an approved close, a file nobody read.
 */
async function month(wall: number) {
  setSystemTime(wall);
  const s = await scenario({ clock: () => engineTime, ids: sequence() });
  try {
    const file = (name: string) => s.evidence(name, `conținutul fișierului ${name}`);
    // Segregation of duties from April: in March a person still approves their own work, and the
    // database agrees, reading the fact on the engine's day.
    await s.invoke(s.owner, 'profile.record', {
      axis: 'controls.segregation',
      value: 'on',
      effectiveFrom: '2026-04-01',
      evidenceId: (await file('decizie.pdf')).id,
    });
    const { id: evidenceId } = await file('nota.pdf');
    const expense = (reference: string, amount: string) =>
      journal(
        evidenceId,
        [
          { account: '628', side: 'D', amount },
          { account: '5121', side: 'C', amount },
        ],
        { reference },
      );
    const own = await s.propose('ledger.general', expense('NC-1', '10.00'));
    const posted = await s.post(await s.approve(own, s.owner));
    // A grant and a policy that expire a week and a month after the engine's time.
    const grant = await s.invoke<{ id: string; token: string; expiresAt: string }>(
      s.reviewer,
      'agents.issue',
      {
        name: 'Asistent',
        scopes: ['toolset:review', 'ledger.general.propose'],
        expiresAt: s.expiresIn(7),
      },
    );
    const agent: Actor = await s.engine.agents.authenticate(grant.token, s.company.id);
    const policy = await s.invoke<{ id: string }>(s.reviewer, 'policies.create', {
      name: 'Cheltuieli mici',
      treatments: ['ledger.general'],
      rulesHashes: [own.rulesHash],
      preconditions: [{ kind: 'maxLineAmount', amount: '100.00' }],
      validFrom: '2026-01-01',
      expiresAt: s.expiresIn(30),
    });
    const automatic = await s.propose('ledger.general', expense('NC-2', '20.00'), agent);
    // January's close, requested and approved by the same person before segregation.
    const request = await s.close('2026-01');
    await s.invoke(s.owner, 'actions.approve', {
      id: request.id,
      previewHash: request.previewHash,
    });
    const close = await s.invoke<ActionView>(s.reviewer, 'actions.execute', { id: request.id });
    await file('scrisoare.pdf');
    const work = (actor: Actor) =>
      s
        .list<WorkItem>(actor, 'work.list', { limit: 200 })
        .then((items) => items.map((item) => ({ ...item, next: item.next })));
    const proposals = await s.list<ProposalView>(s.owner, 'proposals.list', { withInput: true });
    const ids = await s.db.client.execute(`
      select id from acc_companies union all select id from acc_fiscal_years
      union all select id from acc_evidence union all select id from acc_proposals
      union all select id from acc_approvals union all select id from acc_action_requests
      union all select id from acc_posting_policies union all select id from acc_agent_grants
      union all select id from acc_invitations union all select id from acc_jobs
      union all select id from acc_profile_facts`);
    return {
      company: s.company.id,
      people: [s.owner.actorId, s.reviewer.actorId, s.viewer.actorId],
      grant: { id: grant.id, expiresAt: grant.expiresAt },
      policy: policy.id,
      posted: withoutWallTime(posted) as ProposalView,
      automatic: withoutWallTime(automatic) as ProposalView,
      close: withoutWallTime(close) as ActionView,
      proposals: withoutWallTime(proposals),
      work: {
        agent: withoutWallTime(await work(agent)),
        owner: withoutWallTime(await work(s.owner)),
      },
      ids: ids.rows.map((row) => String(row.id)),
    };
  } finally {
    await s.dispose();
  }
}

describe('the engine clock', () => {
  test('decides as if it were now, however far the wall clock is; seeded identifiers repeat', async () => {
    const past = await month(Date.parse('2019-06-01T00:00:00Z'));
    const future = await month(Date.parse('2033-06-01T00:00:00Z'));
    expect(future).toEqual(past);

    // The people, the company and every record the engine created are named by the sequence.
    expect(past.people).toEqual([1, 2, 3].map((n) => `00000000-0000-4000-8000-00000000000${n}`));
    expect(past.company).toBe('00000000-0000-4000-8000-000000000004');
    expect(past.ids.length).toBeGreaterThan(10);
    expect(past.ids.every((id) => id.startsWith('00000000-0000-4000-8000-'))).toBe(true);
    // Expiries count from the engine's time; segregation is read on its day, by the
    // application and the database alike; the policy is unexpired then, for both.
    expect(past.grant.expiresAt).toBe('2026-03-23T10:00:00.000Z');
    expect(past.posted.status).toBe('posted');
    expect(past.automatic).toMatchObject({
      status: 'posted',
      entry: { policyId: past.policy },
    });
    expect(past.close.status).toBe('executed');
    // The file nobody read arrived in the engine's month.
    expect(
      (past.work.owner as WorkItem[]).find(
        (item) => item.kind === 'evidence.unused' && item.details.filename === 'scrisoare.pdf',
      ),
    ).toMatchObject({ period: '2026-03' });
  });
});
