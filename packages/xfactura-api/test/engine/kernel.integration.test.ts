import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Treatment } from 'xfactura-core/kernel';
import { parseLocalDate } from 'xfactura-core/time';
import { proposals } from '../../source/engine/db/schema';
import type { ActionView } from '../../source/engine/kernel/actions';
import type { Actor } from '../../source/engine/kernel/commands';
import type { ProposalView } from '../../source/engine/kernel/views';
import type { WorkItem } from '../../source/engine/kernel/work';
import { invoiceXml } from './fixtures/invoice';
import { journal, scenario, type Scenario } from './scenario';

/** A small expense whose warnings (`ack`) and notes (`info`) the input chooses. */
const warned: Treatment<{ reference: string; warnings: string[]; notes: string[] }> = {
  id: 'test.warned',
  version: 1,
  description: 'Cheltuială de test cu avertismentele alese.',
  summary: 'Test expense with the warnings the input chooses.',
  input: z
    .object({
      reference: z.string(),
      warnings: z.array(z.string()).default([]),
      notes: z.array(z.string()).default([]),
    })
    .strict(),
  agent: true,
  subject: (input) => `test:${input.reference}`,
  plan: () => ({}),
  evaluate: (input) => ({
    effect: {
      schema: 'effect@1',
      date: parseLocalDate('2026-03-10'),
      journalClass: 'general',
      journalCode: 'DIVERSE',
      description: 'Cheltuială de test',
      lines: [
        { account: '628', side: 'D', bani: 1000n },
        { account: '5121', side: 'C', bani: 1000n },
      ],
      openItems: [],
      taxEntries: [],
      schedules: [],
      explanation: { summary: 'test' },
    },
    issues: [
      ...input.warnings.map((code) => ({
        code,
        severity: 'ack' as const,
        message: 'Avertisment.',
      })),
      ...input.notes.map((code) => ({ code, severity: 'info' as const, message: 'Notă.' })),
    ],
  }),
};

/** An expense whose proposals read personal data, as payroll's do; blocked when the input asks. */
const personal: Treatment<{ reference: string; blocked: boolean }> = {
  id: 'test.personal',
  version: 1,
  description: 'Cheltuială de test care citește date personale.',
  summary: 'Test expense whose proposals read personal data.',
  dataClasses: ['books', 'personal'],
  input: z.object({ reference: z.string(), blocked: z.boolean().default(false) }).strict(),
  agent: true,
  subject: (input) => `test:${input.reference}`,
  plan: () => ({}),
  evaluate: (input, loaded, rules) =>
    input.blocked
      ? {
          effect: null,
          issues: [{ code: 'TEST_BLOCKED', severity: 'block' as const, message: 'Blocată.' }],
        }
      : warned.evaluate({ reference: input.reference, warnings: [], notes: [] }, loaded, rules),
};

const open: Scenario[] = [];
const fresh = async (options: Parameters<typeof scenario>[0] = {}) => {
  const s = await scenario(options);
  open.push(s);
  return s;
};
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

const row = (balance: Awaited<ReturnType<Scenario['trialBalance']>>, account: string) =>
  balance.rows.find((item) => item.account === account);

describe('company setup', () => {
  test('seeds the reference chart with kernel controls and distinct years', async () => {
    const s = await fresh();
    const accounts = await s.invoke<{
      items: { code: string; controlKind: string | null; postable: boolean }[];
    }>(s.owner, 'accounts.list', { prefix: '4', limit: 1000 });
    const control = (code: string) =>
      accounts.items.find((item) => item.code === code)?.controlKind;
    expect([
      control('4111'),
      control('401'),
      control('4427'),
      control('4423'),
      control('5121'),
    ]).toEqual(['receivable', 'payable', 'tax', 'tax.payable', undefined]);
    const years = await s.list<{ kind: string; from: string; to: string }>(s.owner, 'years.list');
    expect(years.map((year) => `${year.kind}:${year.from}:${year.to}`)).toEqual([
      'financial:2026-01-01:2026-12-31',
      'fiscal:2026-01-01:2026-12-31',
    ]);
  });

  test('analytical accounts inherit the control of their synthetic account', async () => {
    const s = await fresh();
    const created = await s.invoke<{ controlKind: string }>(s.owner, 'accounts.create', {
      code: '401.FURNIZORI_IT',
      name: 'Furnizori servicii IT',
      validFrom: '2026-01-01',
    });
    expect(created.controlKind).toBe('payable');
    expect(
      (
        await s.refused(
          s.invoke(s.owner, 'accounts.create', {
            code: '70.X',
            name: 'Grup',
            validFrom: '2026-01-01',
          }),
        )
      )?.code,
    ).toBe('ACCOUNT_PARENT');
    expect(
      (
        await s.refused(
          s.invoke(s.reviewer, 'accounts.create', {
            code: '401.Y',
            name: 'Y',
            validFrom: '2026-01-01',
          }),
        )
      )?.code,
    ).toBe('FORBIDDEN');
  });
});

describe('general journal', () => {
  test('an opening position at the start of the year is the initial balance', async () => {
    const s = await fresh();
    const { id: evidenceId } = await s.evidence();
    const supplier = await s.party('Furnizor SRL');
    const opening = await s.book(
      'ledger.general',
      journal(
        evidenceId,
        [
          { account: '5121', side: 'D', amount: '10000.00' },
          { account: '401', side: 'C', amount: '1500.00', newItem: 'furnizor' },
          { account: '1012', side: 'C', amount: '8500.00' },
        ],
        {
          date: '2026-01-01',
          purpose: 'opening',
          newItems: [{ ref: 'furnizor', partyId: supplier.id, dueDate: '2026-01-31' }],
        },
      ),
    );
    expect(opening.status).toBe('posted');
    expect(opening.entry?.number).toBe(1);
    expect(opening.effect?.openItems).toHaveLength(1);
    const balance = await s.trialBalance();
    expect(row(balance, '5121')?.opening).toEqual({ debit: '10000.00', credit: '0.00' });
    expect(row(balance, '401')?.current).toEqual({ debit: '0.00', credit: '0.00' });
    expect(balance.totals.opening).toEqual({ debit: '10000.00', credit: '10000.00' });
  });

  test('an opening position must be dated on the first day of the year', async () => {
    const s = await fresh();
    const { id: evidenceId } = await s.evidence();
    const proposal = await s.propose(
      'ledger.general',
      journal(
        evidenceId,
        [
          { account: '5121', side: 'D', amount: '1.00' },
          { account: '1012', side: 'C', amount: '1.00' },
        ],
        { date: '2026-02-01', purpose: 'opening' },
      ),
    );
    expect(proposal.status).toBe('blocked');
    expect(proposal.issues.map((issue) => issue.code)).toEqual(['OPENING_DATE']);
    expect((await s.refused(s.approve(proposal)))?.code).toBe('BLOCKING_ISSUES');
  });

  test('control accounts require open items; VAT accounts require their own treatments', async () => {
    const s = await fresh();
    const { id: evidenceId } = await s.evidence();
    const receivable = await s.propose(
      'ledger.general',
      journal(evidenceId, [
        { account: '4111', side: 'D', amount: '100.00' },
        { account: '704', side: 'C', amount: '100.00' },
      ]),
    );
    expect(receivable.issues.map((issue) => issue.code)).toEqual(['CONTROL_OPEN_ITEM']);
    const vat = await s.propose(
      'ledger.general',
      journal(evidenceId, [
        { account: '5121', side: 'D', amount: '19.00' },
        { account: '4427', side: 'C', amount: '19.00' },
      ]),
    );
    expect(vat.issues.map((issue) => issue.code)).toEqual(['TAX_LINE_UNEXPLAINED']);
    const unbalanced = await s.propose(
      'ledger.general',
      journal(evidenceId, [
        { account: '5121', side: 'D', amount: '100.00' },
        { account: '704', side: 'C', amount: '99.99' },
      ]),
    );
    expect(unbalanced.issues.map((issue) => issue.code)).toEqual(['UNBALANCED']);
  });

  test('approval binds the exact version: a revision needs a new approval', async () => {
    const s = await fresh();
    const { id: evidenceId } = await s.evidence();
    const input = journal(evidenceId, [
      { account: '628', side: 'D', amount: '250.00' },
      { account: '5121', side: 'C', amount: '250.00' },
    ]);
    const first = await s.approve(await s.propose('ledger.general', input));
    expect(first.status).toBe('approved');
    const revised = await s.revise('ledger.general', first, {
      ...input,
      lines: [
        { account: '628', side: 'D', amount: '260.00' },
        { account: '5121', side: 'C', amount: '260.00' },
      ],
    });
    expect([revised.version, revised.status]).toEqual([2, 'proposed']);
    expect((await s.refused(s.post(first)))?.code).toBe('STALE');
    const posted = await s.post(await s.approve(revised));
    expect(posted.status).toBe('posted');
    expect(posted.effect?.lines.map((line) => line.amount)).toEqual(['260.00', '260.00']);
    expect((await s.refused(s.revise('ledger.general', posted, input)))?.code).toBe(
      'ALREADY_POSTED',
    );
  });

  test('the same subject cannot be proposed twice with different content', async () => {
    const s = await fresh();
    const { id: evidenceId } = await s.evidence();
    const input = journal(evidenceId, [
      { account: '628', side: 'D', amount: '10.00' },
      { account: '5121', side: 'C', amount: '10.00' },
    ]);
    const first = await s.propose('ledger.general', input);
    expect((await s.propose('ledger.general', input)).id).toBe(first.id);
    const conflict = await s.refused(
      s.propose('ledger.general', { ...input, description: 'Alt conținut' }),
    );
    expect(conflict?.code).toBe('SUBJECT_EXISTS');
  });

  test('viewers cannot propose and nobody can approve their own blocked work', async () => {
    const s = await fresh();
    const { id: evidenceId } = await s.evidence();
    const input = journal(evidenceId, [
      { account: '628', side: 'D', amount: '10.00' },
      { account: '5121', side: 'C', amount: '10.00' },
    ]);
    expect((await s.refused(s.propose('ledger.general', input, s.viewer)))?.code).toBe('FORBIDDEN');
    const proposal = await s.propose('ledger.general', input);
    expect((await s.refused(s.approve(proposal, s.viewer)))?.code).toBe('FORBIDDEN');
  });
});

describe('reversal', () => {
  async function sale(s: Scenario) {
    const { id: evidenceId } = await s.evidence();
    const client = await s.party();
    return s.book(
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
  }

  test('a red storno mirrors every line and clears the receivable', async () => {
    const s = await fresh();
    const original = await sale(s);
    const { id: evidenceId } = await s.evidence('storno.pdf');
    const reversed = await s.book('ledger.reverse', {
      entryId: original.entry!.id,
      date: '2026-03-20',
      reason: 'Factura emisă din eroare',
      evidenceId,
      method: 'red',
    });
    expect(
      reversed.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`),
    ).toEqual(['D 4111 -1000.00', 'C 704 -1000.00']);
    const balance = await s.trialBalance();
    expect(row(balance, '4111')?.closing).toEqual({ debit: '0.00', credit: '0.00' });
    // Red storno keeps turnover: the debit column nets to zero.
    expect(row(balance, '4111')?.current).toEqual({ debit: '0.00', credit: '0.00' });
  });

  test('without a method, the recorded storno policy decides; without either, nothing posts', async () => {
    const s = await fresh();
    const original = await sale(s);
    const { id: evidenceId } = await s.evidence('storno.pdf');
    const input = {
      entryId: original.entry!.id,
      date: '2026-03-20',
      reason: 'Factura emisă din eroare',
      evidenceId,
    };
    const blocked = await s.propose('ledger.reverse', input);
    expect(blocked.issues.map((issue) => issue.code)).toContain('POLICY_MISSING');
    const { id: policyEvidence } = await s.evidence('politici-contabile.pdf');
    await s.invoke(s.owner, 'profile.record', {
      axis: 'policy.storno',
      value: 'black',
      effectiveFrom: '2026-01-01',
      evidenceId: policyEvidence,
    });
    const reversed = await s.revise('ledger.reverse', blocked, input);
    expect(
      reversed.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`),
    ).toEqual(['C 4111 1000.00', 'D 704 1000.00']);
  });

  test('a settled receivable cannot be reversed past zero', async () => {
    const s = await fresh();
    const original = await sale(s);
    const item = original.effect!.openItems[0]!.id;
    const { id: evidenceId } = await s.evidence('extras.pdf');
    await s.book(
      'ledger.general',
      journal(evidenceId, [
        { account: '5121', side: 'D', amount: '1000.00' },
        { account: '4111', side: 'C', amount: '1000.00', openItem: item },
      ]),
    );
    const reversal = await s.propose('ledger.reverse', {
      entryId: original.entry!.id,
      date: '2026-03-20',
      reason: 'Factura emisă din eroare',
      evidenceId,
      method: 'black',
    });
    expect(reversal.issues.map((issue) => issue.code)).toEqual(['OPEN_ITEM_REVERSED']);
  });

  test('a stale read is refused at posting, not silently applied', async () => {
    const s = await fresh();
    const original = await sale(s);
    const item = original.effect!.openItems[0]!.id;
    const { id: evidenceId } = await s.evidence('extras.pdf');
    const receipt = (amount: string) =>
      journal(evidenceId, [
        { account: '5121', side: 'D', amount },
        { account: '4111', side: 'C', amount, openItem: item },
      ]);
    const first = await s.approve(await s.propose('ledger.general', receipt('600.00')));
    await s.book('ledger.general', receipt('300.00'));
    const refusal = await s.refused(s.post(first));
    expect(refusal?.code).toBe('STALE');
  });
});

describe('agents', () => {
  const expiresAt = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

  test('an agent prepares, a person approves, and the agent posts only with that scope', async () => {
    const s = await fresh();
    const { id: evidenceId } = await s.evidence();
    const grant = await s.invoke<{ id: string; token: string }>(s.reviewer, 'agents.issue', {
      name: 'Asistent',
      scopes: ['ledger.general.propose', 'proposals.get'],
      expiresAt: expiresAt(),
    });
    const agent = await s.engine.agents.authenticate(grant.token, s.company.id);
    const input = journal(evidenceId, [
      { account: '628', side: 'D', amount: '42.00' },
      { account: '5121', side: 'C', amount: '42.00' },
    ]);
    const proposal = await s.propose('ledger.general', input, agent);
    expect(proposal.agentId).toBe(grant.id);
    expect((await s.refused(s.approve(proposal, agent)))?.code).toBe('AGENT_SCOPE');
    const approved = await s.approve(proposal, s.reviewer);
    expect((await s.refused(s.post(approved, agent)))?.code).toBe('AGENT_SCOPE');
    const listed = await s.invoke<{ capabilities: { id: string }[] }>(agent, 'capabilities.list');
    expect(listed.capabilities.map((capability) => capability.id).sort()).toEqual([
      'capabilities.describe',
      'capabilities.list',
      'capabilities.search',
      'ledger.general.propose',
      'proposals.get',
    ]);
    expect(
      (
        await s.refused(
          s.invoke(s.reviewer, 'agents.issue', {
            name: 'Prea mult',
            scopes: ['proposals.approve'],
            expiresAt: expiresAt(),
          }),
        )
      )?.code,
    ).toBe('AGENT_SCOPE');
  });

  test('revoking and re-inviting a member does not revive their agent grants', async () => {
    const s = await fresh();
    const grant = await s.invoke<{ token: string }>(s.reviewer, 'agents.issue', {
      name: 'Asistent',
      scopes: ['proposals.get'],
      expiresAt: expiresAt(),
    });
    await s.engine.agents.authenticate(grant.token, s.company.id);
    await s.invoke(s.owner, 'company.revoke', { userId: s.reviewer.actorId });
    await s.join(s.reviewer.actorId, 'reviewer');
    const refusal = await s.refused(s.engine.agents.authenticate(grant.token, s.company.id));
    expect(refusal?.code).toBe('AGENT_REVOKED');
  });

  test('command keys are idempotent per principal and refuse different input', async () => {
    const s = await fresh();
    const { id: evidenceId } = await s.evidence();
    const input = journal(evidenceId, [
      { account: '628', side: 'D', amount: '5.00' },
      { account: '5121', side: 'C', amount: '5.00' },
    ]);
    const key = randomUUID();
    const first = await s.invoke<ProposalView>(s.owner, 'ledger.general.propose', input, key);
    const again = await s.invoke<ProposalView>(s.owner, 'ledger.general.propose', input, key);
    expect(again.id).toBe(first.id);
    const conflict = await s.refused(
      s.invoke(s.owner, 'ledger.general.propose', { ...input, description: 'Altceva' }, key),
    );
    expect(conflict?.code).toBe('IDEMPOTENCY_CONFLICT');
  });
});

describe('posting policies', () => {
  test('an approved policy posts covered proposals until it is revoked', async () => {
    const s = await fresh();
    const { id: evidenceId } = await s.evidence();
    const expense = (amount: string) =>
      journal(evidenceId, [
        { account: '628', side: 'D', amount },
        { account: '5121', side: 'C', amount },
      ]);
    const sample = await s.propose('ledger.general', expense('1.00'));
    const policy = await s.invoke<{ id: string }>(s.reviewer, 'policies.create', {
      name: 'Comisioane bancare mici',
      treatments: ['ledger.general'],
      rulesHashes: [sample.rulesHash],
      preconditions: [
        { kind: 'noWarnings' },
        { kind: 'maxLineAmount', amount: '100.00' },
        { kind: 'accountsWithin', prefixes: ['627', '628', '5121'] },
      ],
      validFrom: '2026-01-01',
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    const automatic = await s.propose('ledger.general', expense('25.00'));
    expect(automatic.status).toBe('posted');
    expect((await s.propose('ledger.general', expense('250.00'))).status).toBe('proposed');
    await s.invoke(s.reviewer, 'policies.revoke', {
      id: policy.id,
      reason: 'Politica nu mai este necesară',
    });
    expect((await s.propose('ledger.general', expense('26.00'))).status).toBe('proposed');
  });
});

describe('policy warnings', () => {
  const policyFor = (s: Scenario, rulesHash: string, preconditions: unknown[]) =>
    s.invoke<{ id: string }>(s.reviewer, 'policies.create', {
      name: 'Cheltuieli de test',
      treatments: ['test.warned'],
      rulesHashes: [rulesHash],
      preconditions,
      validFrom: '2026-01-01',
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
  const propose = (s: Scenario, warnings: string[] = [], notes: string[] = []) =>
    s.propose('test.warned', { reference: randomUUID(), warnings, notes });

  test('a policy posts only the warnings it names, and the entry shows its binding', async () => {
    const s = await fresh({ treatments: [warned] });
    const sample = await propose(s);
    const policy = await policyFor(s, sample.rulesHash, [
      { kind: 'acknowledges', codes: ['VAT_FX'] },
    ]);
    expect((await propose(s, ['PARTY_INACTIVE'])).status).toBe('proposed');
    expect((await propose(s, ['VAT_FX', 'PARTY_INACTIVE'])).status).toBe('proposed');
    const posted = await propose(s, ['VAT_FX'], ['NOTE']);
    expect(posted.status).toBe('posted');
    expect(posted.approval).toBeNull();
    expect(posted.entry).toMatchObject({
      policyId: policy.id,
      postedBy: s.owner.actorId,
      agentId: null,
    });
  });

  test('noWarnings refuses every warning but lets notes through', async () => {
    const s = await fresh({ treatments: [warned] });
    const sample = await propose(s);
    await policyFor(s, sample.rulesHash, [
      { kind: 'noWarnings' },
      { kind: 'acknowledges', codes: ['VAT_FX'] },
    ]);
    expect((await propose(s, ['VAT_FX'])).status).toBe('proposed');
    expect((await propose(s, [], ['NOTE'])).status).toBe('posted');
  });

  test('an approved entry shows who posted it and through which agent', async () => {
    const s = await fresh({ treatments: [warned] });
    const grant = await s.invoke<{ id: string; token: string }>(s.reviewer, 'agents.issue', {
      name: 'Asistent',
      scopes: ['ledger.post'],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const agent = await s.engine.agents.authenticate(grant.token, s.company.id);
    const approved = await s.approve(await propose(s, ['VAT_FX']), s.reviewer, ['VAT_FX']);
    const posted = await s.post(approved, agent);
    expect(posted.entry).toMatchObject({
      policyId: null,
      postedBy: s.reviewer.actorId,
      agentId: grant.id,
    });
    expect(posted.approval?.approverId).toBe(s.reviewer.actorId);
  });
});

describe('approval controls', () => {
  const expense = (evidenceId: string, amount = '10.00', date = '2026-03-10') =>
    journal(
      evidenceId,
      [
        { account: '628', side: 'D', amount },
        { account: '5121', side: 'C', amount },
      ],
      { date },
    );
  const segregate = async (s: Scenario, value: 'on' | 'strict') => {
    const { id: evidenceId } = await s.evidence('decizie-administrator.pdf');
    await s.invoke(s.owner, 'profile.record', {
      axis: 'controls.segregation',
      value,
      effectiveFrom: '2026-01-01',
      evidenceId,
    });
  };
  const decide = (s: Scenario, actor: Actor, request: ActionView) =>
    s.invoke<ActionView>(actor, 'actions.approve', {
      id: request.id,
      previewHash: request.previewHash,
    });
  const agentOf = async (s: Scenario, issuer: Actor) => {
    const grant = await s.invoke<{ token: string }>(issuer, 'agents.issue', {
      name: 'Asistent',
      scopes: ['ledger.general.propose', 'periods.close.request'],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    return s.engine.agents.authenticate(grant.token, s.company.id);
  };

  test('without segregation, one person proposes, approves, posts and closes alone', async () => {
    const s = await fresh();
    const { id: evidenceId } = await s.evidence();
    const proposal = await s.propose('ledger.general', expense(evidenceId));
    expect((await s.post(await s.approve(proposal, s.owner), s.owner)).status).toBe('posted');
    const request = await s.close('2026-03');
    await decide(s, s.owner, request);
    const closed = await s.invoke<ActionView>(s.owner, 'actions.execute', { id: request.id });
    expect(closed.status).toBe('executed');
  });

  test('segregation on: nobody approves their own version; a grant issuer approves its agent', async () => {
    const s = await fresh();
    await segregate(s, 'on');
    const { id: evidenceId } = await s.evidence();
    const own = await s.propose('ledger.general', expense(evidenceId));
    const refusal = await s.refused(s.approve(own, s.owner));
    expect(refusal).toMatchObject({ code: 'SEGREGATION', details: { segregation: 'on' } });
    expect((await s.approve(own, s.reviewer)).status).toBe('approved');
    const agent = await agentOf(s, s.reviewer);
    const drafted = await s.propose('ledger.general', expense(evidenceId, '11.00'), agent);
    expect((await s.approve(drafted, s.reviewer)).status).toBe('approved');
  });

  test('segregation on: an action is approved by someone other than who requested it', async () => {
    const s = await fresh();
    await segregate(s, 'on');
    const first = await s.close('2026-03');
    expect((await s.refused(decide(s, s.owner, first)))?.code).toBe('SEGREGATION');
    const rejected = await s.invoke<ActionView>(s.owner, 'actions.reject', {
      id: first.id,
      previewHash: first.previewHash,
      reason: 'Cerută din greșeală',
    });
    expect(rejected.status).toBe('rejected');
    const second = await s.close('2026-03');
    await decide(s, s.reviewer, second);
    const closed = await s.invoke<ActionView>(s.owner, 'actions.execute', { id: second.id });
    expect(closed.status).toBe('executed');
  });

  test('segregation strict: nobody approves what their own agent prepared', async () => {
    const s = await fresh();
    await segregate(s, 'strict');
    const { id: evidenceId } = await s.evidence();
    const agent = await agentOf(s, s.reviewer);
    const drafted = await s.propose('ledger.general', expense(evidenceId), agent);
    expect(await s.refused(s.approve(drafted, s.reviewer))).toMatchObject({
      code: 'SEGREGATION',
      details: { segregation: 'strict' },
    });
    expect((await s.post(await s.approve(drafted, s.owner))).status).toBe('posted');
    const request = await s.invoke<ActionView>(agent, 'periods.close.request', {
      month: '2026-03',
    });
    expect((await s.refused(decide(s, s.reviewer, request)))?.code).toBe('SEGREGATION');
    expect((await decide(s, s.owner, request)).status).toBe('approved');
  });

  test('segregation on: a policy does not post the work of the person who approved it', async () => {
    const s = await fresh();
    await segregate(s, 'on');
    const { id: evidenceId } = await s.evidence();
    const sample = await s.propose('ledger.general', expense(evidenceId, '1.00'), s.reviewer);
    const policy = await s.invoke<{ id: string }>(s.reviewer, 'policies.create', {
      name: 'Comisioane bancare mici',
      treatments: ['ledger.general'],
      rulesHashes: [sample.rulesHash],
      preconditions: [{ kind: 'maxLineAmount', amount: '100.00' }],
      validFrom: '2026-01-01',
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    const own = await s.propose('ledger.general', expense(evidenceId, '2.00'), s.reviewer);
    expect(own.status).toBe('proposed');
    const others = await s.propose('ledger.general', expense(evidenceId, '3.00'));
    expect(others.status).toBe('posted');
    expect(others.entry?.policyId).toBe(policy.id);
  });

  test('an approval stops counting once its giver loses authority', async () => {
    const s = await fresh();
    const { id: evidenceId } = await s.evidence();
    const request = await s.close('2026-03');
    await decide(s, s.reviewer, request);
    const approved = await s.approve(
      await s.propose('ledger.general', expense(evidenceId, '10.00', '2026-04-10')),
    );
    await s.invoke(s.owner, 'company.revoke', { userId: s.reviewer.actorId });
    // Coming back is a new membership epoch: the earlier approvals stay void.
    await s.join(s.reviewer.actorId, 'reviewer');
    const execute = await s.refused(s.invoke(s.owner, 'actions.execute', { id: request.id }));
    expect(execute?.code).toBe('APPROVER_INACTIVE');
    expect((await s.refused(s.post(approved, s.owner)))?.code).toBe('APPROVER_INACTIVE');
  });
});

describe('proposal documents', () => {
  test('a proposal records the document its subject names', async () => {
    const s = await fresh();
    const { id: evidenceId } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: 'INV-1.xml',
      mediaType: 'application/xml',
      base64: Buffer.from(invoiceXml({ number: 'INV-1', date: '2026-03-10' })).toString('base64'),
    });
    const document = await s.invoke<{ id: string }>(s.owner, 'invoices.import', { evidenceId });
    const recognized = await s.propose('invoices.recognize', {
      documentId: document.id,
      account: '628',
    });
    const general = await s.propose('ledger.general', journalOf(evidenceId));
    const documentOf = async (proposal: ProposalView) =>
      (
        await s.db.orm
          .select({ documentId: proposals.documentId })
          .from(proposals)
          .where(and(eq(proposals.companyId, s.company.id), eq(proposals.id, proposal.id)))
      )[0]?.documentId;
    expect(await documentOf(recognized)).toBe(document.id);
    expect(await documentOf(general)).toBeNull();
  });
});

const journalOf = (evidenceId: string) =>
  journal(evidenceId, [
    { account: '628', side: 'D', amount: '5.00' },
    { account: '5121', side: 'C', amount: '5.00' },
  ]);

describe('periods', () => {
  test('a month closes only through an approved, unchanged preview', async () => {
    const s = await fresh();
    const { id: evidenceId } = await s.evidence();
    const entry = (date: string, amount: string) =>
      journal(
        evidenceId,
        [
          { account: '628', side: 'D', amount },
          { account: '5121', side: 'C', amount },
        ],
        { date },
      );
    await s.book('ledger.general', entry('2026-03-05', '100.00'));
    const pending = await s.propose('ledger.general', entry('2026-03-06', '50.00'));
    const blocked = await s.close('2026-03');
    expect(
      (blocked.preview as { findings: { code: string }[] }).findings.map((item) => item.code),
    ).toEqual(['UNPOSTED']);
    expect(
      (
        await s.refused(
          s.invoke(s.reviewer, 'actions.approve', {
            id: blocked.id,
            previewHash: blocked.previewHash,
          }),
        )
      )?.code,
    ).toBe('BLOCKING_ISSUES');
    await s.invoke(s.owner, 'proposals.withdraw', {
      proposalId: pending.id,
      reason: 'Înregistrare dublată',
    });

    const request = await s.close('2026-03');
    await s.invoke(s.reviewer, 'actions.approve', {
      id: request.id,
      previewHash: request.previewHash,
    });
    const closed = await s.invoke<{ status: string; result: { seq: number } }>(
      s.reviewer,
      'actions.execute',
      { id: request.id },
    );
    expect(closed.status).toBe('executed');
    const late = await s.propose('ledger.general', entry('2026-03-31', '10.00'));
    expect(late.issues.map((issue) => issue.code)).toEqual(['PERIOD_CLOSED']);
    expect(await s.list(s.owner, 'periods.list')).toEqual([{ month: '2026-03', state: 'closed' }]);
  });

  test('a later entry makes an approved close stale', async () => {
    const s = await fresh();
    const { id: evidenceId } = await s.evidence();
    const entry = (amount: string) =>
      journal(evidenceId, [
        { account: '628', side: 'D', amount },
        { account: '5121', side: 'C', amount },
      ]);
    await s.book('ledger.general', entry('100.00'));
    const request = await s.close('2026-03');
    await s.invoke(s.reviewer, 'actions.approve', {
      id: request.id,
      previewHash: request.previewHash,
    });
    await s.book('ledger.general', entry('5.00'));
    expect(
      (await s.refused(s.invoke(s.reviewer, 'actions.execute', { id: request.id })))?.code,
    ).toBe('STALE');
  });

  test('months close in order and reopen in reverse order', async () => {
    const s = await fresh();
    const { id: evidenceId } = await s.evidence();
    for (const date of ['2026-02-10', '2026-03-10'])
      await s.book(
        'ledger.general',
        journal(
          evidenceId,
          [
            { account: '628', side: 'D', amount: '1.00' },
            { account: '5121', side: 'C', amount: '1.00' },
          ],
          { date },
        ),
      );
    const early = await s.close('2026-03');
    expect(
      (early.preview as { findings: { code: string }[] }).findings.map((item) => item.code),
    ).toEqual(['EARLIER_OPEN']);
    await s.closeApproved('2026-02');
    await s.closeApproved('2026-03');
    const reopen = await s.invoke<{ preview: { findings: { code: string }[] } }>(
      s.reviewer,
      'periods.reopen.request',
      {
        month: '2026-02',
        reason: 'Factură furnizor primită târziu',
      },
    );
    expect(reopen.preview.findings.map((item) => item.code)).toEqual(['LATER_CLOSED']);
  });
});

describe('reading proposals', () => {
  test('a proposal shows its input and basis to whoever may read every data class of its treatment', async () => {
    const s = await fresh({ treatments: [warned, personal] });
    const { id: evidenceId } = await s.evidence();
    const books = await s.propose(
      'ledger.general',
      journal(evidenceId, [
        { account: '628', side: 'D', amount: '42.00' },
        { account: '5121', side: 'C', amount: '42.00' },
      ]),
    );
    const sensitive = await s.propose('test.personal', { reference: 'P-1', blocked: true });
    // A person answers a question the sensitive proposal then relies on.
    const asked = await s.invoke<{ id: string }>(s.owner, 'questions.ask', {
      kind: 'choice',
      subject: { kind: 'proposal', id: sensitive.id },
      params: {
        question: 'Se înregistrează?',
        options: [
          { value: 'yes', label: 'Da' },
          { value: 'no', label: 'Nu' },
        ],
      },
    });
    await s.invoke(s.owner, 'questions.answer', { questionId: asked.id, value: { value: 'yes' } });
    const revised = await s.invoke<ProposalView>(s.owner, 'proposals.revise', {
      proposalId: sensitive.id,
      version: 1,
      input: { reference: 'P-1', blocked: true },
      basis: { answers: [asked.id] },
    });
    // What proposing returns is unchanged: no input.
    expect(books.input).toBeUndefined();
    expect(revised.basis?.answers).toEqual([expect.objectContaining({ questionId: asked.id })]);

    const read = (actor: Actor, id: string) =>
      s.invoke<ProposalView>(actor, 'proposals.get', { id });
    const agent = async (scopes: string[]) => {
      const grant = await s.invoke<{ token: string }>(s.reviewer, 'agents.issue', {
        name: 'Asistent',
        scopes,
        expiresAt: s.expiresIn(7),
      });
      return s.engine.agents.authenticate(grant.token, s.company.id);
    };
    // People read every input: roles carry no data-class rules.
    const whole = await read(s.viewer, revised.id);
    expect(whole).toMatchObject({
      version: 2,
      input: { reference: 'P-1', blocked: true },
      basis: {
        answers: [expect.objectContaining({ questionId: asked.id, value: { value: 'yes' } })],
      },
    });
    expect(whole.redacted).toBeUndefined();
    const journalInput = (await read(s.owner, books.id)).input!;
    expect(journalInput).toMatchObject({ evidenceId, purpose: 'general' });

    // An agent whose reads cover the books but not personal data: the books' input, and the
    // personal proposal redacted, in reads, lists and the worklist alike.
    const narrow = await agent(['toolset:review', 'test.personal.revise']);
    expect((await read(narrow, books.id)).input).toEqual(journalInput);
    expect(await read(narrow, revised.id)).toMatchObject({
      id: revised.id,
      status: 'blocked',
      input: null,
      basis: null,
      redacted: true,
    });
    const list = (actor: Actor, input: Record<string, unknown> = {}) =>
      s.list<ProposalView>(actor, 'proposals.list', input);
    expect((await list(narrow)).map((view) => 'input' in view)).toEqual([false, false]);
    expect(
      (await list(narrow, { withInput: true })).map((view) => [view.input, view.redacted]),
    ).toEqual([
      [journalInput, undefined],
      [null, true],
    ]);
    const revise = async (actor: Actor) =>
      (await s.list<WorkItem>(actor, 'work.list', { kinds: ['proposal.blocked'], limit: 200 }))
        .find((item) => item.subject.id === revised.id)!
        .next.find((step) => step.operation === 'proposals.revise')!;
    expect(await revise(narrow)).toEqual({
      operation: 'proposals.revise',
      by: 'agent',
      allowed: true,
      complete: false,
      missing: ['input'],
      inputHint: { proposalId: revised.id, version: 2 },
    });
    expect((await revise(s.owner)).inputHint).toEqual({
      proposalId: revised.id,
      version: 2,
      input: { reference: 'P-1', blocked: true },
    });

    // A read that covers personal data (questions.list) discloses it.
    const wide = await agent(['toolset:review', 'test.personal.revise', 'questions.list']);
    expect(await read(wide, revised.id)).toMatchObject({
      input: { reference: 'P-1', blocked: true },
      basis: { answers: [expect.objectContaining({ questionId: asked.id })] },
    });
    expect((await revise(wide)).inputHint).toMatchObject({ input: { reference: 'P-1' } });
  });
});
