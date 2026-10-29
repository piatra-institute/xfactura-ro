import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { ProposalView } from '../../source/engine/kernel/views';
import { journal, scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
const fresh = async () => {
  const s = await scenario();
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
    const years = await s.invoke<{ kind: string; from: string; to: string }[]>(
      s.owner,
      'years.list',
    );
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
      'capabilities.list',
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
    expect(await s.invoke(s.owner, 'periods.list')).toEqual([
      { month: '2026-03', state: 'closed' },
    ]);
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
