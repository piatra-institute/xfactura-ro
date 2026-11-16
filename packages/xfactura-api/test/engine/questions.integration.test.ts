import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { questionAnswers, questions } from '../../source/engine/db/schema';
import type { Actor } from '../../source/engine/kernel/commands';
import type { ProposalView } from '../../source/engine/kernel/views';
import type { WorkItem } from '../../source/engine/kernel/work';
import type { QuestionView } from '../../source/engine/modules/questions';
import { invoiceXml } from './fixtures/invoice';
import { scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

/** 10 November 2026, in Bucharest. */
const now = () => Date.UTC(2026, 10, 10, 10);
const expiresAt = () => new Date(now() + 7 * 86_400_000).toISOString();

async function company() {
  const s = await scenario({ clock: now });
  open.push(s);
  await s.invoke(s.owner, 'profile.record', {
    axis: 'vat.status',
    value: 'normal_vat',
    effectiveFrom: '2026-01-01',
    evidenceId: (await s.evidence('certificat.pdf')).id,
  });
  return s;
}
async function agent(s: Scenario, scopes: string[]): Promise<Actor> {
  const grant = await s.invoke<{ token: string }>(s.reviewer, 'agents.issue', {
    name: 'Asistent',
    scopes,
    expiresAt: expiresAt(),
  });
  return s.engine.agents.authenticate(grant.token, s.company.id);
}
const work = async (s: Scenario, actor: Actor, input: Record<string, unknown> = {}) =>
  (await s.invoke<{ items: WorkItem[] }>(actor, 'work.list', { limit: 200, ...input })).items;
const about = (items: WorkItem[], id: string) => items.filter((item) => item.subject.id === id);
type Asked = QuestionView & { reused: boolean };
const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`);

/** A yearly subscription bought in October and recognized on 628, whose period the agent cannot
 * tell: it proposes the deferral without a schedule. */
async function subscription() {
  const s = await company();
  const { id: evidenceId } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
    filename: 'F-SAAS.xml',
    mediaType: 'application/xml',
    base64: Buffer.from(
      invoiceXml({
        number: 'F-SAAS',
        date: '2026-10-15',
        net: '1200.00',
        tax: '252.00',
        gross: '1452.00',
      }),
    ).toString('base64'),
  });
  const document = await s.invoke<{ id: string; partyId: string }>(s.owner, 'invoices.import', {
    evidenceId,
  });
  await s.book('invoices.recognize', { documentId: document.id, account: '628' });
  const bot = await agent(s, [
    'toolset:review',
    'deferrals.defer.propose',
    'deferrals.defer.revise',
  ]);
  const input = {
    date: '2026-10-31',
    account: '628',
    amount: '1200.00',
    partyId: document.partyId,
    documentId: document.id,
    evidenceId,
  };
  const blocked = await s.invoke<ProposalView>(bot, 'proposals.propose', {
    treatment: 'deferrals.defer',
    input,
  });
  return { s, bot, blocked, evidenceId, input };
}

describe('questions to people', () => {
  test('a deferral asks which months it covers; a person answers, the agent revises citing the answer, and it posts', async () => {
    const { s, bot, blocked, evidenceId } = await subscription();
    expect(blocked.status).toBe('blocked');
    expect(blocked.issues).toEqual([
      expect.objectContaining({
        code: 'DEFERRAL_SCHEDULE',
        severity: 'block',
        details: {
          question: {
            kind: 'deferral.schedule',
            subject: { kind: 'deferral', id: `${evidenceId}:628` },
            params: expect.objectContaining({ account: '628', amount: '1200.00' }),
          },
        },
      }),
    ]);

    // The worklist turns the issue into a question to ask, and says how.
    const needed = async () =>
      about(await work(s, bot, { kinds: ['question.needed'] }), blocked.id);
    let [item] = await needed();
    expect(item).toMatchObject({
      id: `question.needed:proposal:${blocked.id}`,
      kind: 'question.needed',
      severity: 'block',
    });
    expect(item!.next).toEqual([
      {
        operation: 'questions.ask',
        by: 'agent',
        allowed: true,
        complete: true,
        inputHint: (blocked.issues[0]!.details as { question: Record<string, unknown> }).question,
      },
    ]);
    const asked = await s.invoke<Asked>(bot, 'questions.ask', item!.next[0]!.inputHint);
    expect(asked).toMatchObject({
      kind: 'deferral.schedule',
      status: 'open',
      holds: 'once',
      reused: false,
      askedBy: s.reviewer.actorId,
      answer: null,
    });
    expect(asked.agentId).not.toBeNull();
    expect(asked.prompt).toContain('1200.00 lei');
    // Asking again returns the same question: nobody is asked twice.
    expect(await s.invoke<Asked>(bot, 'questions.ask', item!.next[0]!.inputHint)).toMatchObject({
      id: asked.id,
      reused: true,
    });

    // Now it waits on a person: nothing for the agent, an open question for people.
    [item] = await needed();
    expect(item!.next).toEqual([
      {
        operation: 'questions.answer',
        by: 'human',
        allowed: false,
        reason: { kind: 'grant' },
        complete: false,
        missing: ['value'],
        inputHint: { questionId: asked.id },
      },
    ]);
    expect(
      about(await work(s, bot, { by: 'agent', kinds: ['question.needed'] }), blocked.id),
    ).toEqual([]);
    expect(about(await work(s, s.owner, { kinds: ['question.open'] }), asked.id)).toEqual([
      expect.objectContaining({ kind: 'question.open', severity: 'warn' }),
    ]);

    // Only a person answers, and only with a valid answer.
    const value = { from: '2026-10', months: 12 };
    expect(
      (await s.refused(s.invoke(bot, 'questions.answer', { questionId: asked.id, value })))?.code,
    ).toBe('AGENT_SCOPE');
    expect(
      (
        await s.refused(
          s.invoke(s.owner, 'questions.answer', {
            questionId: asked.id,
            value: { from: '2026-10', months: 0 },
          }),
        )
      )?.code,
    ).toBe('VALIDATION');
    const answered = await s.invoke<QuestionView>(s.owner, 'questions.answer', {
      questionId: asked.id,
      value,
    });
    expect(answered).toMatchObject({
      status: 'answered',
      answer: { seq: 1, value, answeredBy: s.owner.actorId },
    });
    // The answer is kept as evidence: what was asked and what the person said.
    const kept = await s.invoke<{ mediaType: string; pages: { lines: { text: string }[] }[] }>(
      s.owner,
      'evidence.read',
      { id: answered.answer!.evidenceId, mode: 'text' },
    );
    expect(kept.mediaType).toBe('application/vnd.xfactura.answer+json');
    expect(kept.pages[0]!.lines.map((line) => line.text).join('')).toContain('"months":12');
    expect(about(await work(s, s.owner, { kinds: ['question.open'] }), asked.id)).toEqual([]);

    // The agent revises citing the answer as the basis.
    [item] = await needed();
    const [revise] = item!.next;
    expect(revise).toMatchObject({
      operation: 'proposals.revise',
      by: 'agent',
      inputHint: { proposalId: blocked.id, version: 1, basis: { answers: [asked.id] } },
    });
    const hint = revise!.inputHint as { input: Record<string, unknown> };
    const revised = await s.invoke<ProposalView>(bot, 'proposals.revise', {
      ...revise!.inputHint,
      input: { ...hint.input, ...value },
    });
    expect(revised.status).toBe('proposed');
    expect(revised.version).toBe(2);
    expect(lines(revised)).toEqual(['D 471 1200.00', 'C 628 1200.00']);
    expect(revised.basis).toEqual({
      answers: [
        { questionId: asked.id, answerId: answered.answer!.id, kind: 'deferral.schedule', value },
      ],
    });
    expect(await needed()).toEqual([]);

    // A person approves; the agent posts what was approved.
    const [awaiting] = about(
      await work(s, s.owner, { kinds: ['proposal.awaitingApproval'] }),
      revised.id,
    );
    expect(awaiting!.next).toEqual([
      {
        operation: 'proposals.approve',
        by: 'human',
        allowed: true,
        complete: true,
        inputHint: {
          proposalId: revised.id,
          version: 2,
          effectHash: revised.effectHash,
          acknowledge: [],
        },
      },
    ]);
    await s.approve(revised);
    const [approved] = about(await work(s, bot, { kinds: ['proposal.approved'] }), revised.id);
    expect(approved!.next[0]).toMatchObject({ operation: 'ledger.post', by: 'agent' });
    const posted = await s.invoke<ProposalView>(bot, 'ledger.post', approved!.next[0]!.inputHint);
    expect(posted.status).toBe('posted');
    expect(about(await work(s, s.owner), revised.id)).toEqual([]);
  });

  test("a car's lease asks how the car is used; the answer decides the deduction, and the next invoice for the car reuses it", async () => {
    const s = await company();
    const bot = await agent(s, ['toolset:review', 'toolset:inbox']);
    /** A monthly operating lease of the car, imported from e-Factura: 1.500,00 lei + 21%. */
    const lease = async (number: string, date: string) => {
      const { id: evidenceId } = await s.invoke<{ id: string }>(bot, 'evidence.record', {
        filename: `${number}.xml`,
        mediaType: 'application/xml',
        base64: Buffer.from(
          invoiceXml({
            number,
            date,
            net: '1500.00',
            tax: '315.00',
            gross: '1815.00',
            lines: [
              {
                rate: '21',
                net: '1500.00',
                name: 'Rată leasing operațional autoturism B-123-XFA',
              },
            ],
          }),
        ).toString('base64'),
      });
      return s.invoke<{ id: string }>(bot, 'invoices.import', { evidenceId });
    };
    const vatOf = (proposal: ProposalView) =>
      proposal.effect?.taxEntries.map((entry) => [entry.amount, entry.deductible]);

    // The agent names the car, as the invoice does: the engine asks how it is used.
    const october = await lease('LO-10', '2026-10-05');
    const input = {
      documentId: october.id,
      account: '612',
      deduction: 'limited',
      vehicle: 'B-123-XFA',
    };
    const blocked = await s.invoke<ProposalView>(bot, 'proposals.propose', {
      treatment: 'invoices.recognize',
      input,
    });
    expect(blocked.status).toBe('blocked');
    const question = {
      kind: 'vehicle.use',
      subject: { kind: 'vehicle', id: 'B123XFA' },
      params: { documentId: october.id, date: '2026-10-05' },
    };
    expect(blocked.issues).toEqual([
      expect.objectContaining({ code: 'VEHICLE_USE', severity: 'block', details: { question } }),
    ]);
    const needed = async () =>
      about(await work(s, bot, { kinds: ['question.needed'] }), blocked.id);
    let [item] = await needed();
    expect(item!.next).toMatchObject([
      { operation: 'questions.ask', by: 'agent', allowed: true, inputHint: question },
    ]);
    const asked = await s.invoke<Asked>(bot, 'questions.ask', item!.next[0]!.inputHint);
    expect(asked).toMatchObject({
      kind: 'vehicle.use',
      subject: { kind: 'vehicle', id: 'B123XFA' },
      status: 'open',
      holds: 'untilChanged',
      reused: false,
    });
    expect(asked.prompt).toContain('B123XFA');
    // Any spelling of the registration, any parameters: the same question.
    expect(
      await s.invoke<Asked>(bot, 'questions.ask', {
        kind: 'vehicle.use',
        subject: { kind: 'vehicle', id: 'b 123-xfa' },
        params: {},
      }),
    ).toMatchObject({ id: asked.id, reused: true });
    [item] = await needed();
    expect(item!.next).toMatchObject([
      { operation: 'questions.answer', by: 'human', inputHint: { questionId: asked.id } },
    ]);

    // Only the owner knows: the car is used privately too. Exclusive use needs the log.
    const value = { use: 'mixed', from: '2026-01-01' };
    expect(
      (await s.refused(s.invoke(bot, 'questions.answer', { questionId: asked.id, value })))?.code,
    ).toBe('AGENT_SCOPE');
    expect(
      (
        await s.refused(
          s.invoke(s.owner, 'questions.answer', {
            questionId: asked.id,
            value: { use: 'business_only', from: '2026-01-01' },
          }),
        )
      )?.code,
    ).toBe('VALIDATION');
    const answered = await s.invoke<QuestionView>(s.owner, 'questions.answer', {
      questionId: asked.id,
      value,
    });

    // The agent revises citing the answer: half the VAT is deducted, the rest is expense.
    [item] = await needed();
    const [revise] = item!.next;
    expect(revise).toMatchObject({
      operation: 'proposals.revise',
      by: 'agent',
      allowed: true,
      inputHint: { proposalId: blocked.id, version: 1, input, basis: { answers: [asked.id] } },
    });
    const revised = await s.invoke<ProposalView>(bot, 'proposals.revise', revise!.inputHint);
    expect(revised.status).toBe('proposed');
    expect(revised.issues).toEqual([]);
    expect(vatOf(revised)).toEqual([['315.00', '157.50']]);
    expect(lines(revised)).toEqual(['D 612 1657.50', 'D 4426 157.50', 'C 401 1815.00']);
    expect(revised.basis).toEqual({
      answers: [
        { questionId: asked.id, answerId: answered.answer!.id, kind: 'vehicle.use', value },
      ],
    });
    expect(await needed()).toEqual([]);
    await s.approve(revised);
    const posted = await s.invoke<ProposalView>(bot, 'ledger.post', {
      proposalId: revised.id,
      version: revised.version,
      effectHash: revised.effectHash,
    });
    expect(posted.status).toBe('posted');

    // November's invoice for the same car: the answer holds, nobody is asked again.
    const november = await lease('LO-11', '2026-11-05');
    const reused = await s.invoke<Asked>(bot, 'questions.ask', {
      kind: 'vehicle.use',
      subject: { kind: 'vehicle', id: 'B-123-XFA' },
      params: { documentId: november.id, date: '2026-11-05' },
    });
    expect(reused).toMatchObject({ id: asked.id, reused: true, status: 'answered' });
    // A deduction the answer does not allow is refused, whatever the agent proposes.
    const wrong = await s.invoke<ProposalView>(bot, 'proposals.propose', {
      treatment: 'invoices.recognize',
      input: { ...input, documentId: november.id, deduction: 'full' },
      basis: { answers: [reused.id] },
    });
    expect(wrong.status).toBe('blocked');
    expect(wrong.issues.map((issue) => issue.code)).toEqual(['VEHICLE_DEDUCTION']);
    expect(about(await work(s, bot, { kinds: ['question.needed'] }), wrong.id)).toEqual([]);
    const second = await s.invoke<ProposalView>(bot, 'proposals.revise', {
      proposalId: wrong.id,
      version: wrong.version,
      input: { ...input, documentId: november.id },
    });
    expect(second.status).toBe('proposed');
    expect(vatOf(second)).toEqual([['315.00', '157.50']]);
    expect(second.basis?.answers.map((answer) => answer.questionId)).toEqual([asked.id]);
    const vehicles = await s.invoke<{ items: QuestionView[] }>(s.owner, 'questions.list', {
      kind: 'vehicle.use',
    });
    expect(vehicles.items.map((entry) => entry.id)).toEqual([asked.id]);

    // The same lease without naming the car: the reviewer confirms it concerns none.
    await s.invoke(bot, 'proposals.withdraw', {
      proposalId: second.id,
      reason: 'Test: aceeași factură fără vehicul.',
    });
    const unnamed = await s.invoke<ProposalView>(bot, 'proposals.propose', {
      treatment: 'invoices.recognize',
      input: { documentId: november.id, account: '612', deduction: 'limited' },
    });
    expect(unnamed.status).toBe('proposed');
    expect(unnamed.issues).toEqual([
      expect.objectContaining({ code: 'VEHICLE_UNNAMED', severity: 'ack' }),
    ]);
  });

  test("the answer that holds is the latest by the engine's time, never the database's", async () => {
    let at = Date.UTC(2026, 10, 10, 10);
    const s = await scenario({ clock: () => at });
    open.push(s);
    await s.invoke(s.owner, 'profile.record', {
      axis: 'vat.status',
      value: 'normal_vat',
      effectiveFrom: '2026-01-01',
      evidenceId: (await s.evidence('certificat.pdf')).id,
    });
    const bot = await agent(s, ['toolset:review', 'toolset:inbox']);
    const { id: evidenceId } = await s.invoke<{ id: string }>(bot, 'evidence.record', {
      filename: 'LO-11.xml',
      mediaType: 'application/xml',
      base64: Buffer.from(
        invoiceXml({
          number: 'LO-11',
          date: '2026-11-05',
          net: '1500.00',
          tax: '315.00',
          gross: '1815.00',
        }),
      ).toString('base64'),
    });
    const lease = await s.invoke<{ id: string }>(bot, 'invoices.import', { evidenceId });
    const ask = () =>
      s.invoke<Asked>(bot, 'questions.ask', {
        kind: 'vehicle.use',
        subject: { kind: 'vehicle', id: 'B-123-XFA' },
        params: {},
      });
    const first = await ask();
    at = Date.UTC(2026, 10, 12, 10);
    await s.invoke(s.owner, 'questions.answer', {
      questionId: first.id,
      value: { use: 'mixed', from: '2026-01-01' },
    });
    // A second question about the same car, as an earlier install could hold, answered after
    // the first in the database's time but at an earlier time of the engine.
    const second = randomUUID();
    await s.db.write((tx) =>
      tx.insert(questions).values({
        id: second,
        companyId: s.company.id,
        kind: 'vehicle.use',
        subjectKind: 'vehicle',
        subjectId: 'B123XFA',
        params: '{}',
        askedBy: s.owner.actorId,
      }),
    );
    at = Date.UTC(2026, 10, 11, 10);
    await s.invoke(s.owner, 'questions.answer', {
      questionId: second,
      value: {
        use: 'business_only',
        from: '2026-01-01',
        logEvidenceId: (await s.evidence('foaie-de-parcurs.pdf')).id,
      },
    });
    const recorded = await s.db.read((tx) =>
      tx
        .select({ questionId: questionAnswers.questionId, engineAt: questionAnswers.engineAt })
        .from(questionAnswers)
        .where(eq(questionAnswers.companyId, s.company.id)),
    );
    expect(recorded).toEqual(
      expect.arrayContaining([
        { questionId: first.id, engineAt: Date.UTC(2026, 10, 12, 10) },
        { questionId: second, engineAt: Date.UTC(2026, 10, 11, 10) },
      ]),
    );
    // The answer an agent reuses is the engine's latest: the first question's.
    at = Date.UTC(2026, 10, 13, 10);
    expect(await ask()).toMatchObject({
      id: first.id,
      reused: true,
      answer: { value: { use: 'mixed' } },
    });
    // A proposal citing both reads the same one: mixed use, the limited deduction.
    const propose = (deduction: string) =>
      s.invoke<ProposalView>(bot, 'proposals.propose', {
        treatment: 'invoices.recognize',
        input: { documentId: lease.id, account: '612', vehicle: 'B-123-XFA', deduction },
        basis: { answers: [first.id, second] },
      });
    const limited = await propose('limited');
    expect(limited.issues.map((issue) => issue.code)).not.toContain('VEHICLE_DEDUCTION');
    await s.invoke(bot, 'proposals.withdraw', {
      proposalId: limited.id,
      reason: 'Verificăm deducerea completă.',
    });
    expect((await propose('full')).issues.map((issue) => issue.code)).toContain(
      'VEHICLE_DEDUCTION',
    );
  });

  test('a later answer makes the proposals citing the question stale', async () => {
    const { s, bot, blocked } = await subscription();
    const [item] = about(await work(s, bot, { kinds: ['question.needed'] }), blocked.id);
    const asked = await s.invoke<Asked>(bot, 'questions.ask', item!.next[0]!.inputHint);
    const first = await s.invoke<QuestionView>(s.owner, 'questions.answer', {
      questionId: asked.id,
      value: { from: '2026-10', months: 12 },
    });
    const [ready] = about(await work(s, bot, { kinds: ['question.needed'] }), blocked.id);
    const hint = ready!.next[0]!.inputHint as { input: Record<string, unknown> };
    const cited = await s.invoke<ProposalView>(bot, 'proposals.revise', {
      ...hint,
      input: { ...hint.input, from: '2026-10', months: 12 },
    });
    await s.approve(cited);

    // The person corrects the answer: the version read the earlier one, and is stale.
    const second = await s.invoke<QuestionView>(s.owner, 'questions.answer', {
      questionId: asked.id,
      value: { from: '2026-11', months: 12 },
    });
    expect(second.answer).toMatchObject({ seq: 2, value: { from: '2026-11', months: 12 } });
    expect((await s.refused(s.post(cited)))?.code).toBe('STALE');
    const rechecked = await s.invoke<ProposalView>(bot, 'proposals.get', {
      id: cited.id,
      recheck: true,
    });
    expect(rechecked.status).toBe('stale');
    expect(rechecked.check!.changed).toContainEqual({
      kind: 'answer',
      id: asked.id,
      before: first.answer!.id,
      after: second.answer!.id,
    });
    const [stale] = about(await work(s, bot, { kinds: ['proposal.stale'] }), cited.id);
    expect(stale!.next[0]).toMatchObject({ operation: 'proposals.revise', by: 'agent' });

    // Revised without a basis, the version keeps the previous one's, now at the later answer.
    const again = await s.invoke<ProposalView>(bot, 'deferrals.defer.revise', {
      proposalId: cited.id,
      version: rechecked.version,
      input: { ...hint.input, from: '2026-11', months: 12 },
    });
    expect(again.basis?.answers).toEqual([
      expect.objectContaining({ questionId: asked.id, answerId: second.answer!.id }),
    ]);
    expect(again.effect?.schedules[0]?.rows[0]?.key).toBe('2026-11');
    expect((await s.post(await s.approve(again))).status).toBe('posted');
  });

  test('an answer cited that does not settle the question goes back to a person', async () => {
    const { s, bot, blocked, input } = await subscription();
    const needed = async () =>
      about(await work(s, bot, { kinds: ['question.needed'] }), blocked.id);
    const [item] = await needed();
    const asked = await s.invoke<Asked>(bot, 'questions.ask', item!.next[0]!.inputHint);
    await s.invoke(s.owner, 'questions.answer', {
      questionId: asked.id,
      value: { from: '2026-10', months: 12 },
    });
    // The agent cites the answer but leaves the schedule out: the question stands.
    const cited = await s.invoke<ProposalView>(bot, 'proposals.revise', {
      proposalId: blocked.id,
      version: 1,
      input,
      basis: { answers: [asked.id] },
    });
    expect(cited.status).toBe('blocked');
    const [again] = await needed();
    expect(again!.details.questions).toEqual([
      expect.objectContaining({ state: 'unsettled', questionId: asked.id }),
    ]);
    expect(again!.next).toEqual([
      {
        operation: 'questions.answer',
        by: 'human',
        allowed: false,
        reason: { kind: 'grant' },
        complete: false,
        missing: ['value'],
        inputHint: { questionId: asked.id },
      },
    ]);
  });

  test('an invoice with the VAT status unknown asks a reviewer, whose answer records the fact', async () => {
    const s = await scenario({ clock: now });
    open.push(s);
    const { id: evidenceId } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: 'F-1.xml',
      mediaType: 'application/xml',
      base64: Buffer.from(invoiceXml({ number: 'F-1' })).toString('base64'),
    });
    const document = await s.invoke<{ id: string }>(s.owner, 'invoices.import', { evidenceId });
    const bot = await agent(s, [
      'toolset:review',
      'invoices.recognize.propose',
      'invoices.recognize.revise',
    ]);
    const input = { documentId: document.id, account: '628' };
    const blocked = await s.invoke<ProposalView>(bot, 'proposals.propose', {
      treatment: 'invoices.recognize',
      input,
    });
    expect(blocked.issues.find((issue) => issue.code === 'DETERMINATION_MISSING')?.details).toEqual(
      {
        question: {
          kind: 'profile.fact',
          subject: { kind: 'profile', id: 'vat.status' },
          params: { axis: 'vat.status', from: '2026-10-01' },
        },
      },
    );
    const [item] = about(await work(s, bot, { kinds: ['question.needed'] }), blocked.id);
    const asked = await s.invoke<Asked>(bot, 'questions.ask', item!.next[0]!.inputHint);
    const answered = await s.invoke<QuestionView>(s.reviewer, 'questions.answer', {
      questionId: asked.id,
      value: { value: 'normal_vat', effectiveFrom: '2026-01-01' },
    });
    expect(answered.profileFactId).toBeDefined();
    // The new fact makes the proposal stale; it stays a question to revise citing the answer.
    while (await s.engine.consumers.runOnce());
    expect((await s.invoke<ProposalView>(bot, 'proposals.get', { id: blocked.id })).status).toBe(
      'stale',
    );
    const [ready] = about(await work(s, bot, { kinds: ['question.needed'] }), blocked.id);
    expect(ready!.next[0]).toMatchObject({
      operation: 'proposals.revise',
      inputHint: { basis: { answers: [asked.id] } },
    });
    const revised = await s.invoke<ProposalView>(
      bot,
      'proposals.revise',
      ready!.next[0]!.inputHint,
    );
    expect(revised.status).toBe('proposed');
    expect(revised.issues.map((issue) => issue.code)).not.toContain('DETERMINATION_MISSING');
    expect(revised.basis?.answers[0]).toMatchObject({ questionId: asked.id, kind: 'profile.fact' });
  });

  test('a basis cites only answered questions of the company', async () => {
    const { s, bot, blocked, input } = await subscription();
    const [item] = about(await work(s, bot, { kinds: ['question.needed'] }), blocked.id);
    const asked = await s.invoke<Asked>(bot, 'questions.ask', item!.next[0]!.inputHint);
    const revise = (answers: string[]) =>
      s.refused(
        s.invoke(bot, 'proposals.revise', {
          proposalId: blocked.id,
          version: 1,
          input: { ...input, from: '2026-10', months: 12 },
          basis: { answers },
        }),
      );
    expect((await revise([asked.id]))?.code).toBe('QUESTION_UNANSWERED');
    expect((await revise([crypto.randomUUID()]))?.code).toBe('QUESTION_NOT_FOUND');
  });

  test('answers hold as long as their kind says', async () => {
    const s = await company();
    const bot = await agent(s, ['toolset:review', 'questions.list']);
    const ask = (input: Record<string, unknown>) => s.invoke<Asked>(bot, 'questions.ask', input);
    const answer = (questionId: string, value: unknown, actor: Actor = s.owner) =>
      s.invoke<QuestionView>(actor, 'questions.answer', { questionId, value });

    // untilChanged: a vehicle's use holds whatever the purchase, until answered again. Exclusive
    // business use needs the vehicle log, kept as evidence.
    const vehicle = { kind: 'vehicle.use', subject: { kind: 'vehicle', id: 'B123ABC' } };
    const car = await ask({ ...vehicle, params: { date: '2026-10-01' } });
    expect(car).toMatchObject({ status: 'open', holds: 'untilChanged' });
    expect(
      (await s.refused(answer(car.id, { use: 'business_only', from: '2026-01-01' })))?.code,
    ).toBe('VALIDATION');
    expect(
      (
        await s.refused(
          answer(car.id, {
            use: 'business_only',
            from: '2026-01-01',
            logEvidenceId: crypto.randomUUID(),
          }),
        )
      )?.code,
    ).toBe('EVIDENCE');
    const { id: log } = await s.evidence('foaie-de-parcurs.pdf');
    await answer(car.id, { use: 'business_only', from: '2026-01-01', logEvidenceId: log });
    expect(await ask({ ...vehicle, params: { date: '2026-11-03' } })).toMatchObject({
      id: car.id,
      status: 'answered',
      reused: true,
      answer: { value: { use: 'business_only', logEvidenceId: log } },
    });
    // A subject a kind is not about is refused.
    expect(
      (await s.refused(ask({ kind: 'vehicle.use', subject: { kind: 'document', id: 'x' } })))?.code,
    ).toBe('QUESTION_SUBJECT');

    // perPeriod: a month's absences hold for that month only.
    const absences = { kind: 'payroll.absences', subject: { kind: 'company', id: s.company.id } };
    const october = await ask({ ...absences, params: { month: '2026-10' } });
    await answer(october.id, { absences: [] });
    expect(await ask({ ...absences, params: { month: '2026-10' } })).toMatchObject({
      id: october.id,
      reused: true,
    });
    expect(await ask({ ...absences, params: { month: '2026-11' } })).toMatchObject({
      status: 'open',
      reused: false,
    });
    // Sick leave needs its medical certificate.
    const november = await ask({ ...absences, params: { month: '2026-11' } });
    expect(
      (
        await s.refused(
          answer(november.id, {
            absences: [
              {
                employeeId: crypto.randomUUID(),
                kind: 'medical',
                from: '2026-11-03',
                to: '2026-11-05',
              },
            ],
          }),
        )
      )?.code,
    ).toBe('VALIDATION');

    // once: a choice holds for the same options; one open question per kind and subject.
    const choice = (options: string[]) => ({
      kind: 'choice',
      subject: { kind: 'party', id: 'furnizor' },
      params: {
        question: 'Furnizorul facturează lunar sau anual?',
        options: options.map((value) => ({ value, label: value })),
      },
    });
    const monthly = await ask(choice(['lunar', 'anual']));
    expect((await s.refused(ask(choice(['lunar', 'anual', 'trimestrial']))))?.code).toBe(
      'QUESTION_OPEN',
    );
    expect((await s.refused(answer(monthly.id, { value: 'zilnic' })))?.code).toBe('VALIDATION');
    await answer(monthly.id, { value: 'anual' });
    expect(await ask(choice(['lunar', 'anual']))).toMatchObject({ id: monthly.id, reused: true });
    expect(await ask(choice(['lunar', 'anual', 'trimestrial']))).toMatchObject({ reused: false });

    // Withdrawing: only a question nobody answered; a withdrawn one takes no answer.
    const missing = await ask({
      kind: 'evidence.missing',
      subject: { kind: 'movement', id: 'm-1' },
      params: { what: 'Contractul de închiriere al biroului' },
    });
    const reason = 'Contractul a fost găsit între timp.';
    expect(
      (await s.refused(s.invoke(bot, 'questions.withdraw', { questionId: monthly.id, reason })))
        ?.code,
    ).toBe('QUESTION_ANSWERED');
    expect(
      await s.invoke<QuestionView>(bot, 'questions.withdraw', { questionId: missing.id, reason }),
    ).toMatchObject({ status: 'withdrawn' });
    expect((await s.refused(answer(missing.id, { unavailable: true, reason })))?.code).toBe(
      'QUESTION_WITHDRAWN',
    );

    // The list, by status, a page at a time.
    const listed = async (input: Record<string, unknown>) =>
      (await s.invoke<{ items: QuestionView[]; next: string | null }>(bot, 'questions.list', input))
        .items;
    expect((await listed({ status: 'withdrawn' })).map((item) => item.id)).toEqual([missing.id]);
    expect((await listed({ status: 'answered' })).map((item) => item.kind).sort()).toEqual([
      'choice',
      'payroll.absences',
      'vehicle.use',
    ]);
    const first = await s.invoke<{ items: QuestionView[]; next: string | null }>(
      bot,
      'questions.list',
      { limit: 2 },
    );
    const rest = await listed({ after: first.next, limit: 50 });
    expect([...first.items, ...rest].map((item) => item.id)).toEqual(
      (await listed({ limit: 50 })).map((item) => item.id),
    );
  });

  test('a company fact answered by a reviewer is recorded, citing the answer', async () => {
    const s = await company();
    const bot = await agent(s, ['toolset:review']);
    const asked = await s.invoke<Asked>(bot, 'questions.ask', {
      kind: 'profile.fact',
      subject: { kind: 'profile', id: 'employer' },
      params: { axis: 'employer', from: '2026-01-01' },
      due: '2026-11-20',
    });
    expect(asked).toMatchObject({ status: 'open', due: '2026-11-20' });
    const answer = (actor: Actor, value: unknown) =>
      s.invoke<QuestionView>(actor, 'questions.answer', { questionId: asked.id, value });
    expect(
      (await s.refused(answer(s.viewer, { value: 'yes', effectiveFrom: '2026-01-01' })))?.code,
    ).toBe('FORBIDDEN');
    expect(
      (await s.refused(answer(s.reviewer, { value: 'maybe', effectiveFrom: '2026-01-01' })))?.code,
    ).toBe('VALIDATION');
    const answered = await answer(s.reviewer, { value: 'yes', effectiveFrom: '2026-01-01' });
    expect(answered.profileFactId).toBeDefined();
    const facts = await s.list<{ id: string; axis: string; value: string; evidenceId: string }>(
      s.owner,
      'profile.read',
    );
    expect(facts.find((fact) => fact.axis === 'employer')).toMatchObject({
      id: answered.profileFactId,
      value: 'yes',
      evidenceId: answered.answer!.evidenceId,
    });
    // The change feed names the question and the fact it recorded.
    const feed = await s.invoke<{ items: { operation: string; refs: { kind: string }[] }[] }>(
      s.owner,
      'events.since',
      { limit: 500 },
    );
    expect(
      feed.items
        .find((event) => event.operation === 'questions.answer')
        ?.refs.map((ref) => ref.kind),
    ).toEqual(expect.arrayContaining(['question', 'profileFact', 'evidence']));
  });
});
