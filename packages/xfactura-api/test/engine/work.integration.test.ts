import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { strToU8, zipSync } from 'fflate';
import { z } from 'zod';
import type { Treatment } from 'xfactura-core/kernel';
import { ParameterRegister, type ParameterVersion } from 'xfactura-core/rules';
import type { LocalDate } from 'xfactura-core/time';
import { documentLinks, documents, evidence, spvMessages } from '../../source/engine/db/schema';
import { defaultRegister } from '../../source/engine/engine';
import type { ActionView } from '../../source/engine/kernel/actions';
import type { Actor } from '../../source/engine/kernel/commands';
import type { WorkItem } from '../../source/engine/kernel/work';
import { iban, mt940 } from './fixtures/bank';
import { invoiceXml, type XmlInput } from './fixtures/invoice';
import { journal, scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

/** 10 November 2026, in Bucharest. */
const now = () => Date.UTC(2026, 10, 10, 10);
type Page = { items: WorkItem[]; next: string | null; asOfSeq: number };
type Movement = { id: string; amount: string; state: string; settled: boolean };

async function agent(s: Scenario, scopes: string[]): Promise<Actor> {
  const grant = await s.invoke<{ token: string }>(s.reviewer, 'agents.issue', {
    name: 'Asistent',
    scopes,
    expiresAt: s.expiresIn(7),
  });
  return s.engine.agents.authenticate(grant.token, s.company.id);
}
const list = (s: Scenario, actor: Actor, input: Record<string, unknown> = {}) =>
  s.invoke<Page>(actor, 'work.list', { limit: 200, ...input });
const items = async (s: Scenario, actor: Actor, input: Record<string, unknown> = {}) =>
  (await list(s, actor, input)).items;
const kinds = (found: WorkItem[]) => [...new Set(found.map((item) => item.kind))].sort();
const of = (found: WorkItem[], kind: string) => found.filter((item) => item.kind === kind);

/** A VAT-registered company with a bank account and its October statement, an invoice nobody
 * booked, a file nobody read, proposals in every state and an SPV message from a buyer. */
async function books(options: Parameters<typeof scenario>[0] = {}) {
  const s = await scenario({ clock: now, ...options });
  open.push(s);
  await s.invoke(s.owner, 'profile.record', {
    axis: 'vat.status',
    value: 'normal_vat',
    effectiveFrom: '2026-01-01',
    evidenceId: (await s.evidence('certificat.pdf')).id,
  });
  // The VAT period of 2026, a yearly determination the closure reads before listing D300.
  await s.invoke(s.owner, 'profile.record', {
    axis: 'vat.period',
    value: 'monthly',
    effectiveFrom: '2026-01-01',
    evidenceId: (await s.evidence('vector-fiscal.pdf')).id,
  });
  await s.invoke(s.owner, 'treasury.createAccount', {
    kind: 'bank',
    name: 'Cont curent',
    iban,
    currency: 'RON',
    ledgerAccount: '5121',
    openedOn: '2026-01-01',
  });
  const { id: note } = await s.evidence('nota.pdf');
  const expense = (amount: string, date: string) =>
    journal(
      note,
      [
        { account: '628', side: 'D', amount },
        { account: '5121', side: 'C', amount },
      ],
      { date },
    );
  await s.book(
    'ledger.general',
    journal(
      note,
      [
        { account: '5121', side: 'D', amount: '1000.00' },
        { account: '1012', side: 'C', amount: '1000.00' },
      ],
      { date: '2026-10-01' },
    ),
  );
  const awaiting = await s.propose('ledger.general', expense('10.00', '2026-10-20'));
  const approved = await s.approve(
    await s.propose('ledger.general', expense('11.00', '2026-10-21')),
  );
  const blocked = await s.propose('deferrals.defer', {
    date: '2026-10-31',
    account: '628',
    amount: '0',
    from: '2026-11',
    months: 2,
    partyId: (await s.party('Furnizor SRL')).id,
    evidenceId: note,
  });
  const invoice = async (input: XmlInput) => {
    const { id } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: `${input.number}.xml`,
      mediaType: 'application/xml',
      base64: Buffer.from(invoiceXml(input)).toString('base64'),
    });
    return s.invoke<{ id: string; partyId: string; evidenceId: string }>(
      s.owner,
      'invoices.import',
      { evidenceId: id },
    );
  };
  const unbooked = await invoice({ number: 'F-100', date: '2026-10-12' });
  const { id: statementFile } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
    filename: 'extras-octombrie.sta',
    mediaType: 'text/plain',
    base64: Buffer.from(mt940).toString('base64'),
  });
  await s.invoke(s.owner, 'bank.import', { evidenceId: statementFile, financialYearId: s.year.id });
  const movements = await s.list<Movement>(s.owner, 'bank.movements', {});
  const unread = await s.evidence('scrisoare.pdf');
  await s.db.write((tx) =>
    tx.insert(spvMessages).values({
      companyId: s.company.id,
      id: '4100',
      uploadId: '5100',
      kind: 'buyer_message',
      createdAtAnaf: Date.UTC(2026, 9, 20),
      details: 'Mesaj de la cumpărător',
      outcome: 'recorded',
      createdBy: s.owner.actorId,
    }),
  );
  return { s, awaiting, approved, blocked, unbooked, movements, unread, invoice, note };
}

describe('the worklist', () => {
  test('lists what waits on agents and people, each with who moves it on and how', async () => {
    const { s, awaiting, approved, blocked, unbooked, movements, unread } = await books();
    const bot = await agent(s, ['toolset:review']);
    const page = await list(s, bot);
    expect(page.next).toBeNull();
    const head = (await s.invoke<{ head: number }>(s.owner, 'events.since', { limit: 1 })).head;
    expect(page.asOfSeq).toBe(head);
    for (const item of page.items) {
      expect(item.id).toBe(`${item.kind}:${item.subject.kind}:${item.subject.id}`);
      expect(item.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(item.asOfSeq).toBe(head);
    }
    expect(kinds(page.items)).toEqual([
      'bank.unexplained',
      'close.finding',
      'determination.missing',
      'document.unproposed',
      'evidence.unused',
      'obligation.due',
      'period.unclosed',
      'proposal.approved',
      'proposal.awaitingApproval',
      'proposal.blocked',
      'spv.message',
    ]);
    const find = (kind: string, id: string) =>
      page.items.find((item) => item.kind === kind && item.subject.id === id)!;

    // Proposals: a person approves; an agent posts what was approved and revises what is blocked.
    expect(find('proposal.awaitingApproval', awaiting.id).next).toEqual([
      {
        operation: 'proposals.approve',
        by: 'human',
        allowed: false,
        inputHint: {
          proposalId: awaiting.id,
          version: 1,
          effectHash: awaiting.effectHash,
          acknowledge: [],
        },
      },
    ]);
    expect(find('proposal.approved', approved.id)).toMatchObject({
      severity: 'warn',
      period: '2026-10',
      next: [
        {
          operation: 'ledger.post',
          by: 'agent',
          inputHint: { proposalId: approved.id, version: 1, effectHash: approved.effectHash },
        },
      ],
    });
    expect(find('proposal.blocked', blocked.id)).toMatchObject({
      severity: 'block',
      details: { issues: [expect.objectContaining({ code: 'AMOUNT' })] },
      next: [
        { operation: 'proposals.revise', by: 'agent' },
        { operation: 'proposals.withdraw', by: 'agent' },
      ],
    });
    // Intake: the invoice nobody booked, the movements nobody explained, the file nobody read.
    expect(find('document.unproposed', unbooked.id)).toMatchObject({
      severity: 'warn',
      period: '2026-10',
      details: { kind: 'invoice.received', number: 'F-100', totals: { gross: '121.00' } },
      // The operation an agent calls through MCP: the generic proposals.propose, naming the
      // treatment and the input to start from.
      next: [
        {
          operation: 'proposals.propose',
          by: 'agent',
          inputHint: { treatment: 'invoices.recognize', input: { documentId: unbooked.id } },
        },
        { operation: 'work.dispose', by: 'human', inputHint: { disposition: 'no_booking' } },
      ],
    });
    expect(
      of(page.items, 'bank.unexplained')
        .map((item) => item.subject.id)
        .sort(),
    ).toEqual(movements.map((movement) => movement.id).sort());
    expect(of(page.items, 'evidence.unused').map((item) => item.subject.id)).toEqual([unread.id]);
    expect(find('spv.message', '4100')).toMatchObject({ severity: 'info' });
    // Returns not filed: overdue ones block.
    expect(find('obligation.due', 'D300|2026-09')).toMatchObject({
      severity: 'block',
      due: '2026-10-26',
      details: { status: 'overdue' },
      next: [
        {
          operation: 'declarations.prepare',
          by: 'agent',
          inputHint: { kind: 'D300', period: '2026-09' },
        },
      ],
    });
    expect(find('obligation.due', 'D300|2026-10')).toMatchObject({ severity: 'info' });
    // October's close checks, and the month itself, which ended and is not closed.
    expect(find('close.finding', '2026-10/bank.explained/UNEXPLAINED_MOVEMENTS')).toMatchObject({
      severity: 'block',
      period: '2026-10',
    });
    expect(find('period.unclosed', '2026-10')).toMatchObject({ next: [] });

    // Filters: what an agent can move on, at least a severity, some kinds.
    const forAgent = await items(s, bot, { by: 'agent' });
    expect(forAgent.every((item) => item.next.some((step) => step.by === 'agent'))).toBe(true);
    expect(of(forAgent, 'proposal.awaitingApproval')).toEqual([]);
    const forPeople = await items(s, bot, { by: 'human' });
    expect(of(forPeople, 'proposal.awaitingApproval')).toHaveLength(1);
    expect(of(forPeople, 'period.unclosed')).toHaveLength(1);
    expect(kinds(await items(s, bot, { severity: 'block' }))).toEqual([
      'close.finding',
      'obligation.due',
      'proposal.blocked',
    ]);
    expect(
      (await items(s, bot, { severity: 'warn' })).every((item) => item.severity !== 'info'),
    ).toBe(true);
    expect(kinds(await items(s, bot, { kinds: ['bank.unexplained', 'spv.message'] }))).toEqual([
      'bank.unexplained',
      'spv.message',
    ]);
  });

  test('each step says whether the caller may take it; by agent keeps what it can move on', async () => {
    const { s, approved, blocked, unbooked } = await books();
    const steps = (found: WorkItem[], kind: string, id: string) =>
      Object.fromEntries(
        found
          .find((item) => item.kind === kind && item.subject.id === id)!
          .next.map((step) => [`${step.operation}/${step.by}`, step.allowed]),
      );
    // An agent for review: it posts and withdraws, but neither books documents, prepares
    // returns, approves, nor revises a deferral (the generic revision needs the treatment's own).
    const bot = await agent(s, ['toolset:review']);
    const all = await items(s, bot);
    expect(steps(all, 'proposal.approved', approved.id)).toEqual({ 'ledger.post/agent': true });
    expect(steps(all, 'proposal.blocked', blocked.id)).toEqual({
      'proposals.revise/agent': false,
      'proposals.withdraw/agent': true,
    });
    expect(steps(all, 'document.unproposed', unbooked.id)).toEqual({
      'proposals.propose/agent': false,
      'work.dispose/human': false,
    });
    expect(steps(all, 'obligation.due', 'D300|2026-09')).toEqual({
      'declarations.prepare/agent': false,
    });
    // by agent: only items with a step it may take; by human: the rest of what waits on a person.
    const forAgent = await items(s, bot, { by: 'agent' });
    expect(
      forAgent.every((item) => item.next.some((step) => step.by === 'agent' && step.allowed)),
    ).toBe(true);
    expect(of(forAgent, 'proposal.approved')).toHaveLength(1);
    expect(of(forAgent, 'proposal.blocked')).toHaveLength(1);
    for (const kind of ['document.unproposed', 'bank.unexplained', 'proposal.awaitingApproval'])
      expect(of(forAgent, kind)).toEqual([]);
    expect(forAgent.map((item) => item.subject.id)).not.toContain('D300|2026-09');
    const forPeople = await items(s, bot, { by: 'human' });
    expect(forPeople.map((item) => item.subject.id)).toContain('D300|2026-09');
    expect(of(forPeople, 'bank.unexplained').length).toBe(of(all, 'bank.unexplained').length);
    expect(of(forPeople, 'proposal.approved')).toEqual([]);
    // With the treatment's own revision, the generic one is allowed too.
    const reviser = await agent(s, ['toolset:review', 'deferrals.defer.revise']);
    expect(steps(await items(s, reviser), 'proposal.blocked', blocked.id)).toEqual({
      'proposals.revise/agent': true,
      'proposals.withdraw/agent': true,
    });
    // Proposing goes through proposals.propose, which needs the treatment's own .propose too, as
    // invoking it does. A grant naming only the treatment's own operation is shown that form,
    // with the treatment's input itself; one naming both, the generic form.
    const typed = await agent(s, ['work.list', 'invoices.recognize.propose']);
    const unproposed = (found: WorkItem[]) =>
      found.find((item) => item.kind === 'document.unproposed' && item.subject.id === unbooked.id)!
        .next[0];
    expect(unproposed(await items(s, typed))).toEqual({
      operation: 'invoices.recognize.propose',
      by: 'agent',
      allowed: true,
      inputHint: { documentId: unbooked.id },
    });
    const both = await agent(s, ['toolset:review', 'invoices.recognize.propose']);
    expect(unproposed(await items(s, both))).toEqual({
      operation: 'proposals.propose',
      by: 'agent',
      allowed: true,
      inputHint: { treatment: 'invoices.recognize', input: { documentId: unbooked.id } },
    });
    // The same for a revision: the treatment's own .revise when the generic one is not granted.
    const typedReviser = await agent(s, ['work.list', 'deferrals.defer.revise']);
    expect(
      (await items(s, typedReviser))
        .find((item) => item.kind === 'proposal.blocked' && item.subject.id === blocked.id)!
        .next.map((step) => `${step.operation}/${step.allowed}`),
    ).toEqual(['deferrals.defer.revise/true', 'proposals.withdraw/false']);
    // People by their role: a viewer posts nothing; a reviewer approves and posts.
    const viewer = await items(s, s.viewer);
    expect(steps(viewer, 'proposal.approved', approved.id)).toEqual({ 'ledger.post/agent': false });
    expect(of(await items(s, s.viewer, { by: 'agent' }), 'proposal.approved')).toEqual([]);
    expect(steps(await items(s, s.reviewer), 'proposal.approved', approved.id)).toEqual({
      'ledger.post/agent': true,
    });
    // work.get reads the same flags.
    const one = await s.invoke<{ item: WorkItem }>(bot, 'work.get', {
      id: `proposal.blocked:proposal:${blocked.id}`,
    });
    expect(one.item.next.map((step) => step.allowed)).toEqual([false, true]);
  });

  test('pages resume where they ended, whatever the limit', async () => {
    const { s } = await books();
    const whole = (await items(s, s.owner)).map((item) => item.id);
    expect(whole.length).toBeGreaterThan(20);
    for (const limit of [1, 3, 7]) {
      const seen: string[] = [];
      let after: string | null = null;
      for (;;) {
        const page: Page = await list(s, s.owner, { limit, ...(after ? { after } : {}) });
        expect(page.items.length).toBeLessThanOrEqual(limit);
        seen.push(...page.items.map((item) => item.id));
        if (!page.next) break;
        after = page.next;
      }
      expect(seen).toEqual(whole);
    }
    expect((await s.refused(list(s, s.owner, { after: 'nowhere:x' })))?.code).toBe('WORK_CURSOR');
  });

  test('work.get rereads one item: open, then resolved once its work is done', async () => {
    const { s, awaiting } = await books();
    const id = `proposal.awaitingApproval:proposal:${awaiting.id}`;
    const read = (itemId = id) =>
      s.invoke<{ state: string; item: WorkItem | null }>(s.owner, 'work.get', { id: itemId });
    expect(await read()).toMatchObject({ state: 'open', item: { id, severity: 'warn' } });
    await s.approve(awaiting);
    expect(await read()).toMatchObject({ state: 'resolved', item: null });
    expect(await read(`proposal.approved:proposal:${awaiting.id}`)).toMatchObject({
      state: 'open',
    });
    expect((await s.refused(read('nothing')))?.code).toBe('WORK_ITEM');
  });
});

describe('bank movements', () => {
  test('carry their state: unexplained, proposed, approved, settled', async () => {
    const { s, movements } = await books();
    const fee = movements.find((movement) => movement.amount === '-2.03')!;
    const state = async () =>
      (await s.list<Movement>(s.owner, 'bank.movements', {})).find((m) => m.id === fee.id)!.state;
    const waiting = async () =>
      of(await items(s, s.owner, { kinds: ['bank.unexplained'] }), 'bank.unexplained').map(
        (item) => item.subject.id,
      );
    expect(await state()).toBe('unexplained');
    expect(await waiting()).toContain(fee.id);
    const proposed = await s.propose('bank.settle', {
      movementId: fee.id,
      lines: [{ account: '627', amount: '2.03' }],
    });
    expect(proposed.status).toBe('proposed');
    expect(await state()).toBe('proposed');
    expect(await waiting()).not.toContain(fee.id);
    const approved = await s.approve(proposed);
    expect(await state()).toBe('approved');
    await s.post(approved);
    expect(await state()).toBe('settled');
    expect(
      (await s.list<Movement>(s.owner, 'bank.movements', { state: 'unexplained' })).map(
        (m) => m.id,
      ),
    ).not.toContain(fee.id);
    expect(
      (await s.list<Movement>(s.owner, 'bank.movements', { state: 'settled' })).map((m) => m.id),
    ).toEqual([fee.id]);
  });
});

describe('dispositions', () => {
  test('a person decides that a document needs no booking or a message was dealt with; an agent only closes unused files', async () => {
    const { s, unbooked, unread } = await books();
    const bot = await agent(s, ['toolset:review']);
    const all = await items(s, s.owner);
    const document = all.find((item) => item.kind === 'document.unproposed')!;
    const message = all.find((item) => item.kind === 'spv.message')!;
    const file = all.find((item) => item.kind === 'evidence.unused')!;
    const reason = 'Factura a fost emisă greșit și anulată de furnizor.';
    const dispose = (actor: Actor, item: WorkItem, overrides: Record<string, unknown> = {}) =>
      s.invoke<{ id: string; subject: { id: string } }>(actor, 'work.dispose', {
        id: item.id,
        fingerprint: item.fingerprint,
        disposition: 'no_booking',
        reason,
        ...overrides,
      });

    expect((await s.refused(dispose(bot, document)))?.code).toBe('AGENT_SCOPE');
    expect(
      (await s.refused(dispose(s.owner, document, { fingerprint: 'f'.repeat(64) })))?.code,
    ).toBe('STALE');
    const blocking = all.find(
      (item) => item.severity === 'block' && item.kind === 'close.finding',
    )!;
    expect((await s.refused(dispose(s.owner, blocking)))?.code).toBe('WORK_BLOCKING');
    const proposal = all.find((item) => item.kind === 'proposal.awaitingApproval')!;
    expect((await s.refused(dispose(s.owner, proposal)))?.code).toBe('WORK_DISPOSITION');

    await dispose(s.owner, document);
    await dispose(s.owner, message, { disposition: 'dealt_with' });
    await dispose(bot, file);
    const after = await items(s, s.owner);
    expect(after.map((item) => item.subject.id)).not.toContain(unbooked.id);
    expect(after.map((item) => item.subject.id)).not.toContain(unread.id);
    expect(after.map((item) => item.subject.id)).not.toContain('4100');
    expect(
      await s.invoke<{ state: string; disposition: { createdBy: string } }>(s.owner, 'work.get', {
        id: document.id,
      }),
    ).toMatchObject({ state: 'disposed', disposition: { createdBy: s.owner.actorId } });
    // An item that is gone cannot be disposed of again.
    expect((await s.refused(dispose(s.owner, file)))?.code).toBe('WORK_RESOLVED');
  });

  test('an item disposed of comes back when it changes', async () => {
    const { s, invoice } = await books();
    const unchecked = async () =>
      of(await items(s, s.owner, { kinds: ['close.finding'] }), 'close.finding').find(
        (item) => item.details.code === 'SUPPLIER_STATUS_UNCHECKED',
      );
    const warning = (await unchecked())!;
    expect(warning).toMatchObject({ severity: 'warn', details: { count: 1 } });
    await s.invoke(s.owner, 'work.dispose', {
      id: warning.id,
      fingerprint: warning.fingerprint,
      disposition: 'dealt_with',
      reason: 'Furnizorul a fost verificat manual pe site-ul ANAF.',
    });
    expect(await unchecked()).toBeUndefined();
    // A second supplier's invoice in October: the finding is no longer what was decided on.
    await invoice({ number: 'F-200', date: '2026-10-14', counterparty: '14399840' });
    expect(await unchecked()).toMatchObject({ id: warning.id, details: { count: 2 } });
  });
});

describe('documents and their copies', () => {
  test('copies that disagree, and a booking read from the lesser copy', async () => {
    const { s } = await books();
    // An invoice from e-Factura, read from an archive downloaded from the SPV.
    const archive = zipSync({
      '5200.xml': strToU8(invoiceXml({ number: 'F-300', date: '2026-10-16' })),
      'semnatura_5200.xml': strToU8('<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"/>'),
    });
    const { id: zip } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: '5200.zip',
      mediaType: 'application/zip',
      base64: Buffer.from(archive).toString('base64'),
    });
    const unbooked = {
      id: (
        await s.invoke<{ documentId: string }>(s.owner, 'spv.importArchive', { evidenceId: zip })
      ).documentId,
    };
    // An agent's reading of the same invoice from its PDF, with the gross misread.
    const [efactura] = await s.db.read((tx) =>
      tx
        .select()
        .from(documents)
        .where(and(eq(documents.companyId, s.company.id), eq(documents.id, unbooked.id))),
    );
    const extracted = randomUUID();
    const file = randomUUID();
    const hash = file.replaceAll('-', '').padEnd(64, 'a');
    const body = JSON.parse(efactura!.body) as { totals: Record<string, string> };
    body.totals.gross = '112.00';
    await s.db.write(async (tx) => {
      await tx.insert(evidence).values({
        id: file,
        companyId: s.company.id,
        hash,
        filename: 'F-100.pdf',
        mediaType: 'application/pdf',
        size: 10,
        createdBy: s.owner.actorId,
      });
      await tx.insert(documents).values({
        ...efactura!,
        id: extracted,
        body: JSON.stringify(body),
        bodyHash: randomUUID(),
        sourceKey: `extract:${hash}:1`,
        evidenceId: file,
        origin: 'extracted',
        authority: 'extracted',
        createdAt: undefined,
      } as typeof documents.$inferInsert);
      await tx.insert(documentLinks).values({
        companyId: s.company.id,
        fromId: extracted,
        toId: unbooked.id,
        kind: 'same_as',
        createdBy: s.owner.actorId,
      });
    });
    const found = await items(s, s.owner);
    // Counted once for the group: the root stands for it.
    expect(of(found, 'document.unproposed').map((item) => item.subject.id)).toContain(unbooked.id);
    expect(of(found, 'document.unproposed').map((item) => item.subject.id)).not.toContain(
      extracted,
    );
    const differ = of(found, 'document.originsDiffer');
    expect(differ).toEqual([
      expect.objectContaining({
        subject: { kind: 'document', id: unbooked.id },
        details: {
          rootId: unbooked.id,
          differences: [
            {
              field: 'gross',
              values: expect.arrayContaining([
                { documentId: unbooked.id, authority: 'efactura', value: '121.00' },
                { documentId: extracted, authority: 'extracted', value: '112.00' },
              ]),
            },
          ],
        },
      }),
    ]);
    expect(differ[0]!.next).toContainEqual({
      operation: 'documents.supersede',
      by: 'agent',
      allowed: true,
      inputHint: { documentId: extracted },
    });

    // A recognition proposed from the extracted copy: revise it onto the e-Factura one.
    const fromCopy = await s.propose('invoices.recognize', {
      documentId: extracted,
      account: '628',
    });
    expect(fromCopy.subject).toBe(`document:${unbooked.id}`);
    const [better] = of(await items(s, s.owner), 'document.betterSource');
    expect(better).toMatchObject({
      subject: { kind: 'proposal', id: fromCopy.id },
      details: { documentId: extracted, better: unbooked.id },
      next: [
        {
          operation: 'proposals.revise',
          by: 'agent',
          inputHint: {
            proposalId: fromCopy.id,
            version: fromCopy.version,
            input: { documentId: unbooked.id, account: '628' },
          },
        },
      ],
    });
    await s.invoke(s.owner, 'proposals.revise', better!.next[0]!.inputHint);
    const after = await items(s, s.owner);
    expect(of(after, 'document.betterSource')).toEqual([]);
    expect(of(after, 'document.unproposed').map((item) => item.subject.id)).not.toContain(
      unbooked.id,
    );
  });
});

describe('rules', () => {
  // A treatment reading one parameter, reviewed through the end of 2026.
  const amount = 'test.amount';
  const register = () => {
    const base = defaultRegister();
    const version: ParameterVersion = {
      id: 'test.amount@2026',
      key: amount,
      scope: {},
      value: 100,
      from: '2026-01-01' as LocalDate,
      to: null,
      reviewedThrough: '2026-12-31' as LocalDate,
      knowledgeDate: null,
      status: 'extracted',
      clauses: [],
    };
    return new ParameterRegister(
      [
        ...base.keys().map((key) => base.definition(key)),
        {
          key: amount,
          axis: 'accounting_transaction_date',
          continuity: 'block',
          scope: [],
          value: z.number(),
          description: 'Test',
        },
      ],
      [...base.versions, version],
    );
  };
  const ruled: Treatment<{ date: string }> = {
    id: 'test.ruled',
    version: 1,
    description: 'Test',
    summary: 'A test treatment reading one parameter.',
    agent: true,
    input: z.object({ date: z.string() }).strict(),
    subject: (input) => `test:${input.date}`,
    plan: () => ({}),
    evaluate(input, _loaded, rules) {
      const bani = BigInt(
        rules.param<number>(amount, 'accounting_transaction_date', input.date as LocalDate),
      );
      return {
        effect: {
          schema: 'effect@1',
          date: input.date as LocalDate,
          journalClass: 'general',
          journalCode: 'DIVERSE',
          description: 'Test',
          lines: [
            { account: '628', side: 'D', bani },
            { account: '5121', side: 'C', bani },
          ],
          openItems: [],
          taxEntries: [],
          schedules: [],
          explanation: { summary: 'test' },
        },
        issues: [],
      };
    },
  };

  test('proposals blocked for want of a rule, by parameter, and parameters in use about to expire', async () => {
    const s = await scenario({ clock: now, register: register(), treatments: [ruled] });
    open.push(s);
    await s.propose('test.ruled', { date: '2026-10-05' });
    const gaps = await Promise.all(
      ['2027-01-05', '2027-02-05'].map((date) => s.propose('test.ruled', { date })),
    );
    expect(gaps.map((proposal) => proposal.status)).toEqual(['blocked', 'blocked']);
    const found = await items(s, s.owner, { kinds: ['rule.gap', 'rule.expiring'] });
    expect(found.find((item) => item.kind === 'rule.gap')).toMatchObject({
      subject: { kind: 'parameter', id: amount },
      severity: 'block',
      details: {
        key: amount,
        reasons: ['BEYOND_HORIZON'],
        from: '2027-01-05',
        to: '2027-02-05',
        count: 2,
        proposals: expect.arrayContaining(gaps.map((proposal) => proposal.id)),
      },
      next: [],
    });
    expect(found.find((item) => item.subject.id === 'test.amount@2026')).toMatchObject({
      kind: 'rule.expiring',
      severity: 'warn',
      due: '2026-12-31',
    });
    // A proposal blocked only by a missing rule is listed with its rule, not on its own.
    expect(
      of(await items(s, s.owner, { kinds: ['proposal.blocked'] }), 'proposal.blocked'),
    ).toEqual([]);
  });
});

describe('the close and the worklist', () => {
  test('share the engine’s close checks, on the months not closed', async () => {
    const s = await scenario({ clock: now });
    open.push(s);
    expect(s.engine.closeChecks.map((check) => check.id)).toContain('bank.explained');
    const { id: note } = await s.evidence('nota.pdf');
    await s.book(
      'ledger.general',
      journal(
        note,
        [
          { account: '628', side: 'D', amount: '5.00' },
          { account: '1012', side: 'C', amount: '5.00' },
        ],
        { date: '2026-09-15' },
      ),
    );
    const period = async () =>
      of(await items(s, s.owner, { kinds: ['period.unclosed'] }), 'period.unclosed');
    expect(await period()).toEqual([
      expect.objectContaining({
        subject: { kind: 'month', id: '2026-09' },
        next: [
          {
            operation: 'periods.close.request',
            by: 'agent',
            allowed: true,
            inputHint: { month: '2026-09' },
          },
        ],
      }),
    ]);
    // Requested, the close is an action waiting on a person.
    const request = await s.close('2026-09');
    expect(await period()).toEqual([]);
    const [decision] = of(await items(s, s.owner), 'action.awaitingDecision');
    expect(decision).toMatchObject({
      subject: { kind: 'action', id: request.id },
      period: '2026-09',
      next: [
        { operation: 'actions.approve', by: 'human', inputHint: { id: request.id } },
        { operation: 'actions.reject', by: 'human' },
      ],
    });
    await s.invoke(s.reviewer, 'actions.approve', {
      id: request.id,
      previewHash: request.previewHash,
    });
    const [execute] = of(await items(s, s.owner), 'action.approved');
    expect(execute!.next).toEqual([
      { operation: 'actions.execute', by: 'agent', allowed: true, inputHint: { id: request.id } },
    ]);
    expect(
      (await s.invoke<ActionView>(s.reviewer, 'actions.execute', execute!.next[0]!.inputHint))
        .status,
    ).toBe('executed');
    // September is closed: its checks are no longer run; October is next once it ended.
    const after = await items(s, s.owner);
    expect(
      after.filter((item) => item.period === '2026-09' && item.kind === 'close.finding'),
    ).toEqual([]);
    expect((await period()).map((item) => item.subject.id)).toEqual(['2026-10']);
  });
});
