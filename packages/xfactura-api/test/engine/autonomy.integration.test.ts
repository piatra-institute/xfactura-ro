import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { approvals, templatePredictions } from '../../source/engine/db/schema';
import type { ActionView } from '../../source/engine/kernel/actions';
import type { Actor } from '../../source/engine/kernel/commands';
import type { ProposalView } from '../../source/engine/kernel/views';
import { iban, mt940 } from './fixtures/bank';
import { invoiceXml } from './fixtures/invoice';
import { pdfDocument, show } from './fixtures/pdf';
import { journal, scenario, type Scenario } from './scenario';

/*
 * Phase 1's exit scenario for earned autonomy: an agent books a supplier's monthly invoices, a
 * person approves them in batches, a template is approved and measured in the shadow, it
 * graduates, a person grants it a policy, the next invoice posts itself, and a pause, a resume
 * and a correction steer it. Every amount and text is synthetic and written by hand.
 */

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

type WorkItem = {
  id: string;
  kind: string;
  subject: { kind: string; id: string };
  details: Record<string, unknown>;
  next: { operation: string; by: string; inputHint: Record<string, unknown> }[];
};
type Preview = {
  members: { proposalId: string; state: string; amount: string }[];
  totals: {
    accounts: { account: string; debit: string; credit: string }[];
    taxes: {
      tax: string;
      code: string;
      direction: string;
      base: string;
      amount: string;
      deductible: string;
    }[];
    gross: string;
  };
  findings: { code: string; items: string[] }[];
};
type Policy = {
  id: string;
  treatments: string[];
  preconditions: { kind: string; [key: string]: unknown }[];
  paused: boolean;
  requestId: string | null;
  validFrom: string;
};

/** A VAT-registered company on the 15 October 2026, an agent of the reviewer's with every
 * toolset it needs, and the worker's loop. */
async function setup(options: { cui?: string; supplier?: string } = {}) {
  const s = await scenario({
    clock: () => Date.parse('2026-10-15T09:00:00Z'),
    ...(options.cui ? { cui: options.cui } : {}),
  });
  open.push(s);
  const { id: certificate } = await s.evidence('certificat-tva.pdf');
  await s.invoke(s.owner, 'profile.record', {
    axis: 'vat.status',
    value: 'normal_vat',
    effectiveFrom: '2026-01-01',
    evidenceId: certificate,
  });
  const grant = await s.invoke<{ token: string }>(s.reviewer, 'agents.issue', {
    name: 'Agent contabil',
    scopes: [
      'toolset:inbox',
      'toolset:review',
      'toolset:books',
      'toolset:bank',
      'toolset:admin',
      'toolset:reference',
    ],
    expiresAt: s.expiresIn(7),
  });
  const agent = await s.engine.agents.authenticate(grant.token, s.company.id);
  /** The worker: consumers of the audit log and queued jobs, until nothing is left. */
  const worker = async () => {
    for (let round = 0; round < 50; round++) {
      const projected = await s.engine.consumers.runOnce();
      const ran = await s.engine.jobs.runOne();
      if (!projected && !ran) return;
    }
    throw new Error('The worker did not settle.');
  };
  const supplier = options.supplier ?? '87654321';
  /** A purchase invoice of the supplier (or another) as e-Factura XML, imported by the agent. */
  const invoice = async (
    number: string,
    date: string,
    gross = '121.00',
    line: { name?: string; counterparty?: string } = {},
  ) => {
    const net = (Number(gross) / 1.21).toFixed(2);
    const tax = (Number(gross) - Number(net)).toFixed(2);
    const xml = invoiceXml({
      number,
      date,
      net,
      tax,
      gross,
      counterparty: line.counterparty ?? supplier,
      ...(line.name ? { lines: [{ rate: '21', net, name: line.name }] } : {}),
      ...(options.cui ? { company: options.cui } : {}),
    });
    const { id: evidenceId } = await s.invoke<{ id: string }>(agent, 'evidence.record', {
      filename: `${number}.xml`,
      mediaType: 'application/xml',
      base64: Buffer.from(xml).toString('base64'),
    });
    return s.invoke<{ id: string; partyId: string }>(agent, 'invoices.import', { evidenceId });
  };
  const propose = (
    documentId: string,
    basis?: { answers: string[]; template?: string },
    account = '626',
  ) =>
    s.invoke<ProposalView>(agent, 'proposals.propose', {
      treatment: 'invoices.recognize',
      input: { documentId, account },
      ...(basis ? { basis } : {}),
    });
  /** The agent requests a batch, a person approves its preview, the agent executes it. */
  const batch = async (proposals: ProposalView[], approver: Actor = s.owner) => {
    const request = await s.invoke<ActionView>(agent, 'proposals.batch.request', {
      members: proposals.map((proposal) => ({
        proposalId: proposal.id,
        version: proposal.version,
        effectHash: proposal.effectHash,
      })),
    });
    await s.invoke(approver, 'actions.approve', {
      id: request.id,
      previewHash: request.previewHash,
    });
    return s.invoke<ActionView>(agent, 'actions.execute', { id: request.id });
  };
  /** A reviewed action requested by the agent, approved by a person, executed by the agent. */
  const reviewed = async (operation: string, input: unknown) => {
    const request = await s.invoke<ActionView>(agent, operation, input);
    await s.invoke(s.owner, 'actions.approve', {
      id: request.id,
      previewHash: request.previewHash,
    });
    return {
      request,
      executed: await s.invoke<ActionView>(agent, 'actions.execute', { id: request.id }),
    };
  };
  const work = async (kinds: string[]) =>
    (await s.invoke<{ items: WorkItem[] }>(agent, 'work.list', { kinds })).items;
  const get = (proposal: { id: string }) =>
    s.invoke<ProposalView>(s.owner, 'proposals.get', { id: proposal.id });
  const policies = async () => s.list<Policy>(s.owner, 'policies.list');
  return { s, agent, worker, invoice, propose, batch, reviewed, work, get, policies };
}

describe('earned autonomy, from batches to a demoted policy', () => {
  test('a monthly supplier invoice graduates, posts itself, pauses, resumes and is demoted', async () => {
    const { s, agent, worker, invoice, propose, batch, reviewed, work, get, policies } =
      await setup();

    // 1–2. The first months: the agent proposes, a person approves them in one batch.
    const first = [];
    for (const [number, date] of [
      ['F-01', '2026-01-05'],
      ['F-02', '2026-02-05'],
      ['F-03', '2026-03-05'],
    ] as const)
      first.push(await propose((await invoice(number, date)).id));
    const request = await s.invoke<ActionView>(agent, 'proposals.batch.request', {
      members: first.map((proposal) => ({
        proposalId: proposal.id,
        version: proposal.version,
        effectHash: proposal.effectHash,
      })),
    });
    const preview = request.preview as Preview;
    expect(preview.members.map((item) => item.state)).toEqual(['ready', 'ready', 'ready']);
    expect(preview.totals).toEqual({
      accounts: [
        { account: '401', debit: '0.00', credit: '363.00' },
        { account: '4426', debit: '63.00', credit: '0.00' },
        { account: '626', debit: '300.00', credit: '0.00' },
      ],
      taxes: [
        {
          tax: 'VAT',
          code: 'S-21',
          direction: 'input',
          base: '300.00',
          amount: '63.00',
          deductible: '63.00',
        },
      ],
      gross: '363.00',
    });
    // An agent never approves.
    expect(
      (
        await s.refused(
          s.invoke(agent, 'actions.approve', { id: request.id, previewHash: request.previewHash }),
        )
      )?.code,
    ).toBe('AGENT_SCOPE');
    await s.invoke(s.owner, 'actions.approve', {
      id: request.id,
      previewHash: request.previewHash,
    });
    const executed = await s.invoke<ActionView>(agent, 'actions.execute', { id: request.id });
    expect((executed.result as { count: number }).count).toBe(3);
    for (const proposal of first) {
      const posted = await get(proposal);
      expect(posted.status).toBe('posted');
      expect(posted.approval).toMatchObject({ approverId: s.owner.actorId, batchId: request.id });
    }

    // 3. The worklist sees a recurring partner without a template; the agent requests one from
    // its hint and the backtest confirms the three postings.
    const [candidate] = await work(['template.candidate']);
    expect(candidate).toMatchObject({
      kind: 'template.candidate',
      details: { treatment: 'invoices.recognize', documentKind: 'invoice.received', posted: 3 },
    });
    const hint = candidate!.next[0]!;
    expect(hint).toMatchObject({ operation: 'templates.request', by: 'agent' });
    const template = await reviewed('templates.request', {
      ...hint.inputHint,
      name: 'Abonament internet',
    });
    expect(template.request.preview).toMatchObject({
      template: { version: 1, mapping: { account: '626', deduction: 'full' } },
      backtest: { posted: 3, matching: 3, differing: 0, notApplicable: 0 },
      findings: [],
    });
    const templateId = (template.executed.result as { templateId: string }).templateId;
    expect(await work(['template.candidate'])).toEqual([]);

    // 4. In the shadow: each new invoice is predicted before anything is posted for it; the
    // agent proposes what the template makes, citing it, and a person approves them in batches.
    const shadow = async (dates: [string, string][]) => {
      const proposed = [];
      for (const [number, date] of dates) {
        const document = await invoice(number, date);
        await worker();
        proposed.push(await propose(document.id, { answers: [], template: templateId }));
      }
      await batch(proposed);
      await worker();
      return proposed;
    };
    const shadowed = await shadow([
      ['F-04A', '2026-04-03'],
      ['F-04B', '2026-04-20'],
      ['F-05A', '2026-05-03'],
    ]);
    expect(shadowed[0]!.basis).toEqual({ answers: [], template: { id: templateId, version: 1 } });
    const predictions = await s.db.read((tx) =>
      tx
        .select()
        .from(templatePredictions)
        .where(
          and(
            eq(templatePredictions.companyId, s.company.id),
            eq(templatePredictions.templateId, templateId),
          ),
        ),
    );
    expect(predictions.map((row) => row.status)).toEqual(['predicted', 'predicted', 'predicted']);
    // Not yet: three correct bookings in two months.
    expect(await work(['template.graduation'])).toEqual([]);
    await shadow([
      ['F-05B', '2026-05-20'],
      ['F-06A', '2026-06-03'],
      ['F-06B', '2026-06-20'],
    ]);
    const performance = await s.invoke<{
      versions: { version: number; months: Record<string, unknown>[] }[];
      corrections: unknown[];
    }>(agent, 'templates.performance', { templateId });
    expect(performance.versions[0]!.months).toEqual([
      { month: '2026-04', correct: 2, corrected: 0, rejected: 0, pending: 0 },
      { month: '2026-05', correct: 2, corrected: 0, rejected: 0, pending: 0 },
      { month: '2026-06', correct: 2, corrected: 0, rejected: 0, pending: 0 },
    ]);
    expect(performance.corrections).toEqual([]);

    // 5. Graduation: the agent requests the policy from the report; a person approves it.
    const [graduated] = await work(['template.graduation']);
    expect(graduated).toMatchObject({
      subject: { kind: 'template', id: templateId },
      details: { correct: 6, months: ['2026-04', '2026-05', '2026-06'] },
      next: [{ operation: 'policies.request', by: 'agent', inputHint: { templateId } }],
    });
    const granted = await reviewed('policies.request', { templateId });
    const policyPreview = granted.request.preview as {
      report: { met: boolean; correct: number };
      reportHash: string;
      policy: { preconditions: { kind: string }[]; validFrom: string; expiresInDays: number };
    };
    expect(policyPreview.report).toMatchObject({ met: true, correct: 6 });
    expect(policyPreview.policy.validFrom).toBe('2026-10-01');
    expect(policyPreview.policy.expiresInDays).toBe(90);
    const [policy] = await policies();
    expect(policy).toMatchObject({
      treatments: ['invoices.recognize'],
      requestId: granted.request.id,
      paused: false,
      preconditions: [
        { kind: 'template', id: templateId, version: 1 },
        { kind: 'graduation', reportHash: policyPreview.reportHash },
        { kind: 'parties' },
        { kind: 'knownParty', minPosted: 3 },
        { kind: 'withinObserved', factor: '1.50' },
        { kind: 'maxDocumentAmount', amount: '181.50' },
        { kind: 'monthlyCap', amount: '363.00' },
        { kind: 'sourceAuthority', allow: ['efactura', 'issued', 'ubl_upload', 'invoicer'] },
        { kind: 'noWarnings' },
      ],
    });
    await worker();
    expect(await work(['template.graduation'])).toEqual([]);

    // 6. The next month posts itself.
    const october = await invoice('F-10A', '2026-10-05');
    await worker();
    const automatic = await propose(october.id, { answers: [], template: templateId });
    expect(automatic.status).toBe('posted');
    expect(automatic.approval).toBeNull();
    expect(automatic.entry).toMatchObject({ policyId: policy!.id, agentId: expect.any(String) });

    // 8. A pause stops it at once; a resume lets it post again (the sweep posts what waited).
    const paused = await s.invoke<{ paused: boolean; changed: boolean }>(
      agent,
      'automation.pause',
      {
        scope: 'company',
        reason: 'Verificăm furnizorul înainte de închiderea lunii.',
      },
    );
    expect(paused).toMatchObject({ paused: true, changed: true });
    const waiting = await propose((await invoice('F-10B', '2026-10-12')).id, {
      answers: [],
      template: templateId,
    });
    expect(waiting.status).toBe('proposed');
    expect(
      (
        await s.refused(
          s.invoke(agent, 'automation.resume', {
            scope: 'company',
            reason: 'Am verificat furnizorul.',
          }),
        )
      )?.code,
    ).toBe('AGENT_SCOPE');
    await s.invoke(s.owner, 'automation.resume', {
      scope: 'company',
      reason: 'Am verificat furnizorul, totul este în regulă.',
    });
    await worker();
    const swept = await get(waiting);
    expect(swept.status).toBe('posted');
    expect(swept.entry).toMatchObject({ policyId: policy!.id, postedBy: 'system', agentId: null });
    const feed = await s.invoke<{
      items: {
        operation: string;
        actor?: { userId: string; agentId: string | null; system?: boolean };
      }[];
    }>(s.owner, 'events.since', { after: 0, limit: 500 });
    expect(
      feed.items.filter((item) => item.operation === 'policies.swept').map((item) => item.actor),
    ).toEqual([
      { userId: 'system', agentId: null, system: true },
      { userId: 'system', agentId: null, system: true },
    ]);

    // 7. A person corrects one: the automatic entry is reversed and booked again elsewhere; the
    // worker demotes the policy in the system's name, and the worklist asks a person to look.
    const { id: note } = await s.evidence('nota-storno.pdf');
    await s.book('ledger.reverse', {
      entryId: automatic.entry!.id,
      date: '2026-10-14',
      reason: 'Abonamentul era pentru alt punct de lucru.',
      evidenceId: note,
      method: 'red',
    });
    await worker();
    const [demoted] = await policies();
    expect(demoted!.paused).toBe(true);
    const status = await s.invoke<{
      paused: { scope: string; id: string; trigger: string; system: boolean }[];
    }>(agent, 'automation.status');
    expect(status.paused).toMatchObject([
      { scope: 'policy', id: policy!.id, trigger: 'reversal', system: true },
    ]);
    const [attention] = await work(['automation.paused']);
    expect(attention).toMatchObject({
      subject: { kind: 'policy', id: policy!.id },
      details: { trigger: 'reversal', system: true },
      next: [
        { operation: 'automation.resume', by: 'human' },
        { operation: 'policies.revoke', by: 'human' },
      ],
    });
    const held = await propose((await invoice('F-10C', '2026-10-13')).id, {
      answers: [],
      template: templateId,
    });
    expect(held.status).toBe('proposed');
    // The reversal counts against the template's record.
    const after = await s.invoke<{ corrections: { reason: string }[] }>(
      agent,
      'templates.performance',
      { templateId },
    );
    expect(after.corrections.map((item) => item.reason)).toEqual(['reversed']);
  });
});

describe('graduating a car’s lease', () => {
  test('it follows the answer about the car, graduates, posts at it, and a changed answer demotes it', async () => {
    const { s, agent, worker, invoice, batch, reviewed, work, get, policies } = await setup({
      supplier: '33445560',
    });
    const plate = 'B-123-XFA';
    const lease = (number: string, date: string) =>
      invoice(number, date, '1815.00', { name: `Rată leasing operațional autoturism ${plate}` });
    // The owner says once how the car is used: also privately, so half its VAT is deducted.
    const asked = await s.invoke<{ id: string }>(agent, 'questions.ask', {
      kind: 'vehicle.use',
      subject: { kind: 'vehicle', id: plate },
      params: {},
    });
    await s.invoke(s.owner, 'questions.answer', {
      questionId: asked.id,
      value: { use: 'mixed', from: '2026-01-01' },
    });
    const half = { account: '612', vehicle: plate, deduction: 'limited' };
    const proposeLease = (
      documentId: string,
      basis: { answers: string[]; template?: string },
      input = half,
    ) =>
      s.invoke<ProposalView>(agent, 'proposals.propose', {
        treatment: 'invoices.recognize',
        input: { documentId, ...input },
        basis,
      });
    // Three months booked by hand, citing the answer, approved in one batch.
    const first = [];
    for (const [number, date] of [
      ['L-01', '2026-01-05'],
      ['L-02', '2026-02-05'],
      ['L-03', '2026-03-05'],
    ] as const)
      first.push(await proposeLease((await lease(number, date)).id, { answers: [asked.id] }));
    await batch(first);
    await worker();
    // The worklist suggests a template that names the car, its deduction left to the answer.
    const [candidate] = await work(['template.candidate']);
    expect(candidate!.next[0]!.inputHint).toMatchObject({
      mapping: { account: '612', vehicle: plate },
    });
    const template = await reviewed('templates.request', {
      ...candidate!.next[0]!.inputHint,
      name: 'Leasing autoturism',
    });
    expect(template.request.preview).toMatchObject({
      backtest: { posted: 3, matching: 3, differing: 0 },
    });
    const templateId = (template.executed.result as { templateId: string }).templateId;
    // In the shadow: the template's input cites the answer that holds, as an agent's would.
    const cited = { answers: [], template: templateId };
    for (const [number, date] of [
      ['L-04A', '2026-04-05'],
      ['L-04B', '2026-04-20'],
      ['L-05A', '2026-05-05'],
      ['L-05B', '2026-05-20'],
      ['L-06A', '2026-06-05'],
      ['L-06B', '2026-06-20'],
    ] as const) {
      const document = await lease(number, date);
      await worker();
      const proposed = await proposeLease(document.id, cited);
      expect(proposed.basis).toMatchObject({
        answers: [{ questionId: asked.id, kind: 'vehicle.use', value: { use: 'mixed' } }],
        template: { id: templateId, version: 1 },
      });
      await batch([proposed]);
      await worker();
    }
    const predictions = await s.db.read((tx) =>
      tx
        .select({ status: templatePredictions.status })
        .from(templatePredictions)
        .where(eq(templatePredictions.templateId, templateId)),
    );
    expect(predictions.map((row) => row.status)).toEqual(Array(6).fill('predicted'));
    // Graduated: the policy is bound to the answer it was measured on.
    const [graduated] = await work(['template.graduation']);
    expect(graduated).toMatchObject({ details: { correct: 6 } });
    const granted = await reviewed('policies.request', { templateId });
    expect(granted.request.preview).toMatchObject({
      report: {
        met: true,
        answers: [{ questionId: asked.id, kind: 'vehicle.use', value: { use: 'mixed' } }],
      },
    });
    const [policy] = await policies();
    expect(policy!.preconditions).toContainEqual(
      expect.objectContaining({
        kind: 'answers',
        answers: [expect.objectContaining({ questionId: asked.id })],
      }),
    );
    await worker();
    // October's lease posts itself, at half the VAT the answer allows.
    const october = await lease('L-10A', '2026-10-05');
    await worker();
    const automatic = await proposeLease(october.id, cited);
    expect(automatic).toMatchObject({ status: 'posted', entry: { policyId: policy!.id } });
    expect(automatic.effect?.taxEntries).toMatchObject([
      { amount: '315.00', deductible: '157.50' },
    ]);
    // From October the car is used only for the business, with its log: the owner answers again.
    const { id: log } = await s.evidence('foaie-de-parcurs.pdf');
    await s.invoke(s.owner, 'questions.answer', {
      questionId: asked.id,
      value: { use: 'business_only', from: '2026-10-01', logEvidenceId: log },
    });
    // The next lease, as the template now makes it: the whole VAT, under the new answer. It
    // differs from what the policy was measured on, so it waits for a person and the policy is
    // paused.
    const next = await lease('L-10B', '2026-10-12');
    await worker();
    const full = await proposeLease(next.id, cited, { ...half, deduction: 'full' });
    expect(full.status).toBe('proposed');
    expect(full.effect?.taxEntries).toMatchObject([{ amount: '315.00', deductible: '315.00' }]);
    // The template's earlier deduction no longer conforms: the answer decides.
    expect(
      (await s.refused(proposeLease((await lease('L-10C', '2026-10-13')).id, cited)))?.code,
    ).toBe('TEMPLATE_CONFORMANCE');
    await worker();
    expect((await get(full)).status).toBe('proposed');
    const [demoted] = await policies();
    expect(demoted!.paused).toBe(true);
    const status = await s.invoke<{ paused: { trigger: string }[] }>(agent, 'automation.status');
    expect(status.paused.map((item) => item.trigger)).toEqual(['changed_answer']);
  });
});

describe('graduating bank payments', () => {
  test('payments matched by invoice number graduate and settle the next one by themselves', async () => {
    const { s, agent, worker, invoice, batch, reviewed, policies } = await setup();
    await s.invoke(s.owner, 'treasury.createAccount', {
      kind: 'bank',
      name: 'Cont curent',
      iban,
      currency: 'RON',
      ledgerAccount: '5121',
      openedOn: '2026-01-01',
    });
    const { id: opening } = await s.evidence('balanta-deschidere.pdf');
    await s.book(
      'ledger.general',
      journal(
        opening,
        [
          { account: '5121', side: 'D', amount: '10000.00' },
          { account: '1012', side: 'C', amount: '10000.00' },
        ],
        { date: '2026-01-01', purpose: 'opening' },
      ),
    );
    const supplier = (await invoice('F-0301', '2026-03-02')).partyId;
    await s.book('invoices.recognize', {
      documentId: (await invoice('F-0302', '2026-03-03')).id,
      account: '626',
    });
    const template = await reviewed('templates.request', {
      name: 'Plăți furnizor internet',
      scope: { treatment: 'bank.settle', partyId: supplier, documentKind: 'movement.paid' },
      mapping: { settle: 'openItem', match: 'number' },
    });
    const templateId = (template.executed.result as { templateId: string }).templateId;
    let balance = 1_000_000;
    /** A month's statement paying the given invoices, imported by the agent. */
    const statement = async (month: string, paid: string[]) => {
      const [year, mm] = month.split('-');
      const yy = year!.slice(2);
      const last = new Date(Date.UTC(Number(year), Number(mm), 0)).getUTCDate();
      const amount = (cents: number) =>
        `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}`;
      const opened = balance;
      const lines = paid.flatMap((number, index) => {
        balance -= 12_100;
        const day = String(10 + index).padStart(2, '0');
        return [
          `:61:${yy}${mm}${day}${mm}${day}D121,00NTRFNONREF//PAY-${number}`,
          `:86:Plata factura ${number}`,
        ];
      });
      const mt940 = [
        `:20:STMT-${month}`,
        `:25:${iban}`,
        ':28C:001/001',
        `:60F:C${yy}${mm}01RON${amount(opened)}`,
        ...lines,
        `:62F:C${yy}${mm}${last}RON${amount(balance)}`,
      ].join('\n');
      const { id: evidenceId } = await s.invoke<{ id: string }>(agent, 'evidence.record', {
        filename: `extras-${month}.sta`,
        mediaType: 'text/plain',
        base64: Buffer.from(mt940).toString('base64'),
      });
      await s.invoke(agent, 'bank.import', { evidenceId, financialYearId: s.year.id });
      await worker();
    };
    const movements = async () =>
      s.list<{ id: string; reference: string; state: string }>(s.owner, 'bank.movements', {});
    const openItem = async (number: string) =>
      (
        await s.list<{ id: string; document: string | null }>(s.owner, 'openItems.list', {
          partyId: supplier,
        })
      ).find((item) => item.document === number)!.id;
    const settle = async (number: string) => {
      const movement = (await movements()).find((item) => item.reference.includes(number))!;
      return s.invoke<ProposalView>(agent, 'proposals.propose', {
        treatment: 'bank.settle',
        input: {
          movementId: movement.id,
          allocations: [{ openItem: await openItem(number), amount: '121.00' }],
        },
        basis: { answers: [], template: templateId },
      });
    };
    for (const month of ['2026-04', '2026-05', '2026-06']) {
      const numbers = [`F-${month.slice(5)}A`, `F-${month.slice(5)}B`];
      for (const [index, number] of numbers.entries())
        await s.book('invoices.recognize', {
          documentId: (await invoice(number, `${month}-0${index + 1}`)).id,
          account: '626',
        });
      await statement(month, numbers);
      await batch([await settle(numbers[0]!), await settle(numbers[1]!)]);
      await worker();
    }
    const granted = await reviewed('policies.request', { templateId });
    expect(granted.request.preview).toMatchObject({ report: { met: true, correct: 6 } });
    const [policy] = await policies();
    expect(policy!.treatments).toEqual(['bank.settle']);
    // No source authority for a movement: it reads no document.
    expect(policy!.preconditions.map((item) => item.kind)).not.toContain('sourceAuthority');
    await s.book('invoices.recognize', {
      documentId: (await invoice('F-10A', '2026-10-01')).id,
      account: '626',
    });
    await statement('2026-10', ['F-10A']);
    const automatic = await settle('F-10A');
    expect(automatic.status).toBe('posted');
    expect(automatic.entry?.policyId).toBe(policy!.id);
    expect(
      automatic.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`),
    ).toEqual(['C 5121 121.00', 'D 401 121.00']);
  });
});

describe('what never posts by itself', () => {
  // Synthetic parties with valid control digits.
  const company = '12345674';
  const supplier = '87654329';
  const printed = pdfDocument([
    {
      content: [
        show(72, 780, 'FACTURĂ FISCALĂ', 14),
        show(72, 750, 'Seria FCT nr. 0042 din 05.10.2026'),
        show(72, 730, 'Furnizor: Furnizor SRL, CIF: RO87654329'),
        show(72, 710, 'Client: Pilot SRL, CUI: RO12345674'),
        show(72, 680, 'Servicii consultanță octombrie 2026'),
        show(72, 650, 'Total fără TVA: 1.200,00 lei'),
        show(72, 630, 'TVA 21%: 252,00 lei'),
        show(72, 610, 'Total de plată: 1.452,00 lei'),
      ].join('\n'),
    },
  ]);

  test('an extracted document posts only under a policy whose sourceAuthority allows it', async () => {
    const { s, agent } = await setup({ cui: company, supplier });
    const { id: evidenceId } = await s.invoke<{ id: string }>(agent, 'evidence.record', {
      filename: 'factura-0042.pdf',
      mediaType: 'application/pdf',
      base64: Buffer.from(printed).toString('base64'),
    });
    const recorded = await s.invoke<{ id: string }>(agent, 'documents.record', {
      evidenceId,
      kind: 'invoice.received',
      body: {
        number: 'FCT 0042',
        issueDate: '2026-10-05',
        currency: 'RON',
        supplier: { name: 'Furnizor SRL', taxId: `RO${supplier}`, country: 'RO' },
        customer: { name: 'Pilot SRL', taxId: `RO${company}`, country: 'RO' },
        lines: [
          {
            description: 'Servicii consultanță octombrie 2026',
            net: '1200.00',
            vatCategory: 'S',
            vatRate: '21',
          },
        ],
        taxes: [{ base: '1200.00', tax: '252.00', category: 'S', rate: '21' }],
        totals: { net: '1200.00', tax: '252.00', gross: '1452.00' },
      },
      citations: {
        number: { page: 1, line: 2, text: 'FCT nr. 0042' },
        issueDate: { page: 1, line: 2, text: '05.10.2026' },
        'supplier.taxId': { page: 1, line: 3, text: 'CIF: RO87654329' },
        'customer.taxId': { page: 1, line: 4, text: 'RO12345674' },
        'totals.net': { page: 1, line: 6, text: '1.200,00' },
        'totals.tax': { page: 1, line: 7, text: '252,00' },
        'totals.gross': { page: 1, line: 8, text: 'Total de plată: 1.452,00' },
      },
    });
    const sample = await s.invoke<ProposalView>(agent, 'proposals.propose', {
      treatment: 'invoices.recognize',
      input: { documentId: recorded.id, account: '628' },
    });
    expect(sample.issues.map((issue) => issue.code)).toEqual(['SOURCE_EXTRACTED']);
    await s.invoke(agent, 'proposals.withdraw', {
      proposalId: sample.id,
      reason: 'Propunere de probă pentru politică.',
    });
    const policy = (preconditions: unknown[]) =>
      s.invoke<{ id: string }>(s.reviewer, 'policies.create', {
        name: 'Facturi de consultanță',
        treatments: ['invoices.recognize'],
        rulesHashes: [sample.rulesHash],
        preconditions,
        validFrom: '2026-01-01',
        expiresAt: s.expiresIn(30),
      });
    // Acknowledging the warning is not enough: an extraction is never posted unless allowed.
    const acknowledging = await policy([{ kind: 'acknowledges', codes: ['SOURCE_EXTRACTED'] }]);
    const refused = await s.invoke<ProposalView>(agent, 'proposals.propose', {
      treatment: 'invoices.recognize',
      input: { documentId: recorded.id, account: '628' },
    });
    expect(refused.status).toBe('proposed');
    await s.invoke(s.reviewer, 'policies.revoke', {
      id: acknowledging.id,
      reason: 'Înlocuită cu o politică explicită.',
    });
    const explicit = await policy([
      { kind: 'acknowledges', codes: ['SOURCE_EXTRACTED'] },
      { kind: 'sourceAuthority', allow: ['efactura', 'extracted'] },
    ]);
    const revised = await s.invoke<ProposalView>(agent, 'proposals.revise', {
      proposalId: refused.id,
      version: refused.version,
      input: { documentId: recorded.id, account: '628' },
    });
    expect(revised.status).toBe('posted');
    expect(revised.entry?.policyId).toBe(explicit.id);
  });

  test('a policy never names a return, an SPV submission or an unknown treatment', async () => {
    const { s } = await setup();
    for (const treatments of [['declarations.authorize'], ['spv.submit'], ['invented.treatment']])
      expect(
        (
          await s.refused(
            s.invoke(s.reviewer, 'policies.create', {
              name: 'Nepermisă',
              treatments,
              rulesHashes: ['a'.repeat(64)],
              preconditions: [],
              validFrom: '2026-01-01',
              expiresAt: s.expiresIn(1),
            }),
          )
        )?.code,
      ).toBe('POLICY_TREATMENT');
    // Within the company's criteria: a policy expires within 90 days.
    expect(
      (
        await s.refused(
          s.invoke(s.reviewer, 'policies.create', {
            name: 'Prea lungă',
            treatments: ['invoices.recognize'],
            rulesHashes: ['a'.repeat(64)],
            preconditions: [],
            validFrom: '2026-01-01',
            expiresAt: s.expiresIn(120),
          }),
        )
      )?.code,
    ).toBe('POLICY_EXPIRY');
  });
});

describe('batches', () => {
  test('a change after approval refuses the whole batch, naming the member', async () => {
    const { s, agent, invoice, propose, get } = await setup();
    const one = await propose((await invoice('F-1', '2026-03-01')).id);
    const two = await propose((await invoice('F-2', '2026-03-02')).id);
    const request = await s.invoke<ActionView>(agent, 'proposals.batch.request', {
      members: [one, two].map((proposal) => ({
        proposalId: proposal.id,
        version: proposal.version,
        effectHash: proposal.effectHash,
      })),
    });
    await s.invoke(s.owner, 'actions.approve', {
      id: request.id,
      previewHash: request.previewHash,
    });
    // The agent revises one member after the person approved the batch.
    await s.invoke(agent, 'proposals.revise', {
      proposalId: two.id,
      version: two.version,
      input: { documentId: (two.subject as string).slice('document:'.length), account: '628' },
    });
    const stale = await s.refused(s.invoke(agent, 'actions.execute', { id: request.id }));
    expect(stale).toMatchObject({
      code: 'STALE',
      details: { members: [{ proposalId: two.id, before: 'ready', after: 'superseded' }] },
    });
    expect((await get(one)).status).toBe('proposed');
    const posted = await s.db.read((tx) =>
      tx.select().from(approvals).where(eq(approvals.companyId, s.company.id)),
    );
    expect(posted).toEqual([]);
  });

  test('members that read what an earlier member posts refuse the whole batch', async () => {
    const { s, agent, invoice } = await setup();
    await s.invoke(s.owner, 'treasury.createAccount', {
      kind: 'bank',
      name: 'Cont curent',
      iban,
      currency: 'RON',
      ledgerAccount: '5121',
      openedOn: '2026-01-01',
    });
    const document = await invoice('INV-1', '2026-09-20');
    const payable = (
      await s.book('invoices.recognize', { documentId: document.id, account: '626' })
    ).effect!.openItems[0]!.id;
    const { id: evidenceId } = await s.invoke<{ id: string }>(agent, 'evidence.record', {
      filename: 'extras-octombrie.sta',
      mediaType: 'text/plain',
      base64: Buffer.from(mt940).toString('base64'),
    });
    await s.invoke(agent, 'bank.import', { evidenceId, financialYearId: s.year.id });
    const movements = await s.list<{ id: string; amount: string }>(s.owner, 'bank.movements', {});
    // Two payments of the same invoice: each reads the payable the other settles.
    const settle = (amount: string) =>
      s.invoke<ProposalView>(agent, 'bank.settle.propose', {
        movementId: movements.find((movement) => movement.amount === `-${amount}`)!.id,
        allocations: [{ openItem: payable, amount }],
      });
    const members = [await settle('100.00'), await settle('2.03')];
    const request = await s.invoke<ActionView>(agent, 'proposals.batch.request', {
      members: members.map((proposal) => ({
        proposalId: proposal.id,
        version: proposal.version,
        effectHash: proposal.effectHash,
      })),
    });
    expect((request.preview as Preview).findings).toEqual([]);
    await s.invoke(s.owner, 'actions.approve', {
      id: request.id,
      previewHash: request.previewHash,
    });
    expect(await s.refused(s.invoke(agent, 'actions.execute', { id: request.id }))).toMatchObject({
      code: 'BATCH_CONFLICT',
      details: { proposalId: members[1]!.id },
    });
    for (const member of members)
      expect(
        (await s.invoke<ProposalView>(s.owner, 'proposals.get', { id: member.id })).status,
      ).toBe('proposed');
  });

  test('warnings stay out of batches; segregation holds for each member', async () => {
    const { s, agent, invoice, propose } = await setup();
    // Segregation on: the owner may not approve their own proposal, in a batch or alone.
    const { id: decision } = await s.evidence('decizie-separare.pdf');
    await s.invoke(s.owner, 'profile.record', {
      axis: 'controls.segregation',
      value: 'on',
      effectiveFrom: '2026-01-01',
      evidenceId: decision,
    });
    const own = await s.invoke<ProposalView>(s.owner, 'invoices.recognize.propose', {
      documentId: (await invoice('F-1', '2026-03-01')).id,
      account: '626',
    });
    const agents = await propose((await invoice('F-2', '2026-03-02')).id);
    const member = (proposal: ProposalView) => ({
      proposalId: proposal.id,
      version: proposal.version,
      effectHash: proposal.effectHash,
    });
    const request = await s.invoke<ActionView>(agent, 'proposals.batch.request', {
      members: [member(own), member(agents)],
    });
    const refused = await s.refused(
      s.invoke(s.owner, 'actions.approve', { id: request.id, previewHash: request.previewHash }),
    );
    expect(refused).toMatchObject({ code: 'SEGREGATION', details: { members: [own.id] } });
    // The reviewer may: neither member is theirs without an agent.
    await s.invoke(s.reviewer, 'actions.approve', {
      id: request.id,
      previewHash: request.previewHash,
    });

    // A version with a warning to acknowledge is refused from a batch.
    const warned = await s.invoke<ProposalView>(agent, 'proposals.propose', {
      treatment: 'invoices.recognize',
      input: {
        documentId: (await invoice('F-3', '2026-03-03')).id,
        account: '626',
        // A service of another month than its tax point: a warning to acknowledge.
        serviceDate: '2026-02-15',
      },
    });
    expect(warned.issues.some((issue) => issue.severity === 'ack')).toBe(true);
    const batch = await s.refused(
      s.invoke(agent, 'proposals.batch.request', { members: [member(warned)] }),
    );
    expect(batch).toBeUndefined();
    const [blocked] = (await s.list<ActionView>(agent, 'actions.list', { kind: 'proposals.batch' }))
      .slice(-1)
      .map((action) => action.preview as Preview);
    expect(blocked!.findings).toEqual([
      expect.objectContaining({ code: 'BATCH_ACKNOWLEDGEMENT', items: [warned.id] }),
    ]);
  });
});

describe('templates', () => {
  test('a template basis must conform; a person’s correction drops it and demotes its policy', async () => {
    const { s, agent, worker, invoice, propose, reviewed, policies } = await setup();
    const document = await invoice('F-1', '2026-03-01');
    const template = await reviewed('templates.request', {
      name: 'Chirie',
      scope: {
        treatment: 'invoices.recognize',
        partyId: document.partyId,
        documentKind: 'invoice.received',
      },
      mapping: { account: '612' },
    });
    const templateId = (template.executed.result as { templateId: string }).templateId;
    expect(template.request.preview).toMatchObject({
      backtest: { posted: 0, matching: 0 },
      findings: [{ code: 'BACKTEST_EMPTY' }],
    });
    expect(
      (await s.refused(propose(document.id, { answers: [], template: templateId }, '626')))?.code,
    ).toBe('TEMPLATE_CONFORMANCE');
    const sample = await propose(
      (await invoice('F-0', '2026-02-01')).id,
      { answers: [], template: templateId },
      '612',
    );
    // A policy bound to the template, created by a person.
    const policy = await s.invoke<{ id: string }>(s.reviewer, 'policies.create', {
      name: 'Chirie lunară',
      treatments: ['invoices.recognize'],
      rulesHashes: [sample.rulesHash],
      preconditions: [
        { kind: 'template', id: templateId, version: 1 },
        { kind: 'maxDocumentAmount', amount: '1000.00' },
      ],
      validFrom: '2026-01-01',
      expiresAt: s.expiresIn(30),
    });
    await worker();
    // Its sweep posted the open proposal that conforms.
    expect((await s.invoke<ProposalView>(s.owner, 'proposals.get', { id: sample.id })).status).toBe(
      'posted',
    );
    // While the company is paused, a proposal made with the template waits for a person.
    await s.invoke(agent, 'automation.pause', {
      scope: 'company',
      reason: 'Verificăm chiriile din trimestru.',
    });
    const proposed = await propose(document.id, { answers: [], template: templateId }, '612');
    expect(proposed.status).toBe('proposed');
    await worker();
    // A person revises it onto another account: the template is no longer cited.
    const corrected = await s.invoke<ProposalView>(s.owner, 'invoices.recognize.revise', {
      proposalId: proposed.id,
      version: proposed.version,
      input: { documentId: document.id, account: '628' },
    });
    expect(corrected.basis).toBeNull();
    await worker();
    const [demoted] = await policies();
    expect(demoted).toMatchObject({ id: policy.id, paused: true });
    const status = await s.invoke<{
      paused: { trigger: string; details: { proposalId: string } }[];
    }>(agent, 'automation.status');
    expect(status.paused).toMatchObject([
      { trigger: 'correction', details: { proposalId: proposed.id } },
    ]);
  });

  test('outcomes: rejected when withdrawn, corrected when posted otherwise; agents measured alike', async () => {
    const { s, agent, worker, invoice, propose, reviewed } = await setup();
    const first = await invoice('F-1', '2026-03-01');
    const template = await reviewed('templates.request', {
      name: 'Servicii',
      scope: {
        treatment: 'invoices.recognize',
        partyId: first.partyId,
        documentKind: 'invoice.received',
      },
      mapping: { account: '626' },
    });
    const templateId = (template.executed.result as { templateId: string }).templateId;
    const second = await invoice('F-2', '2026-03-02');
    await worker();
    // F-1: the agent's proposal is withdrawn. F-2: a person posts it on another account.
    const withdrawn = await propose(first.id);
    await s.invoke(agent, 'proposals.withdraw', {
      proposalId: withdrawn.id,
      reason: 'Factura este duplicată în alt registru.',
    });
    const changed = await propose(second.id);
    await s.post(
      await s.approve(
        await s.invoke<ProposalView>(s.owner, 'invoices.recognize.revise', {
          proposalId: changed.id,
          version: changed.version,
          input: { documentId: second.id, account: '628' },
        }),
      ),
    );
    await worker();
    const performance = await s.invoke<{
      outcomes: { outcome: string; reason: string | null }[];
      corrections: { predicted: { account: string }; posted: { account: string } }[];
    }>(agent, 'templates.performance', { templateId });
    expect(performance.outcomes.map((item) => `${item.outcome}/${item.reason}`).sort()).toEqual([
      'corrected/changed',
      'rejected/null',
    ]);
    expect(performance.corrections).toMatchObject([
      { predicted: { account: '626' }, posted: { account: '628' } },
    ]);
    // A prediction is never written after the fact: a posted subject gets none.
    const third = await invoice('F-3', '2026-03-03');
    await s.book('invoices.recognize', { documentId: third.id, account: '626' });
    await worker();
    const subjects = (
      await s.db.read((tx) =>
        tx
          .select({ subject: templatePredictions.subjectKey, status: templatePredictions.status })
          .from(templatePredictions)
          .where(eq(templatePredictions.companyId, s.company.id)),
      )
    ).map((row) => row.subject);
    expect(subjects).not.toContain(`document:${third.id}`);
    // The agent's first versions, measured the same way.
    const measured = await s.invoke<{
      items: { months: { correct: number; corrected: number; rejected: number }[] }[];
    }>(s.owner, 'agents.performance', {});
    const totals = measured.items[0]!.months.reduce(
      (sum, month) => ({
        correct: sum.correct + month.correct,
        corrected: sum.corrected + month.corrected,
        rejected: sum.rejected + month.rejected,
      }),
      { correct: 0, corrected: 0, rejected: 0 },
    );
    expect(totals).toEqual({ correct: 0, corrected: 1, rejected: 1 });
  });

  test('a new partner or an unusual amount in a template’s scope demotes its policy', async () => {
    const { s, agent, worker, invoice, propose, reviewed, policies } = await setup();
    const template = await reviewed('templates.request', {
      name: 'Toate serviciile',
      scope: { treatment: 'invoices.recognize', documentKind: 'invoice.received' },
      mapping: { account: '626' },
    });
    const templateId = (template.executed.result as { templateId: string }).templateId;
    const sample = await propose((await invoice('F-1', '2026-03-01')).id);
    await s.post(await s.approve(sample));
    const policy = await s.invoke<{ id: string }>(s.reviewer, 'policies.create', {
      name: 'Servicii cunoscute',
      treatments: ['invoices.recognize'],
      rulesHashes: [sample.rulesHash],
      preconditions: [
        { kind: 'template', id: templateId, version: 1 },
        { kind: 'knownParty', minPosted: 1 },
        { kind: 'withinObserved', factor: '1.50' },
      ],
      validFrom: '2026-01-01',
      expiresAt: s.expiresIn(30),
    });
    await worker();
    // The same supplier, the usual amount: posted by itself.
    expect((await propose((await invoice('F-2', '2026-03-02')).id)).status).toBe('posted');
    // Ten times the usual amount: left for a person, and the policy is paused.
    const unusual = await propose((await invoice('F-3', '2026-03-03', '1210.00')).id);
    expect(unusual.status).toBe('proposed');
    await worker();
    expect((await policies()).find((item) => item.id === policy.id)!.paused).toBe(true);
    const status = await s.invoke<{ paused: { trigger: string }[] }>(agent, 'automation.status');
    expect(status.paused.map((item) => item.trigger)).toEqual(['unusual_amount']);
    // A person resumes it. The template covers any partner, so a supplier never posted before
    // is one a person should look at: the policy leaves it and is paused again.
    await s.invoke(s.owner, 'automation.resume', {
      scope: 'policy',
      id: policy.id,
      reason: 'Suma neobișnuită a fost verificată.',
    });
    await worker();
    const newcomer = await propose(
      (await invoice('N-1', '2026-03-04', '121.00', { counterparty: '33445560' })).id,
    );
    expect(newcomer.status).toBe('proposed');
    await worker();
    const again = await s.invoke<{ paused: { trigger: string }[] }>(agent, 'automation.status');
    expect(again.paused.map((item) => item.trigger)).toEqual(['new_party']);
  });

  test('one supplier’s graduated policy ignores other suppliers, and still meets its own amounts', async () => {
    const { s, agent, worker, invoice, propose, reviewed, policies } = await setup();
    const first = await invoice('F-1', '2026-03-01');
    const template = await reviewed('templates.request', {
      name: 'Internet',
      scope: {
        treatment: 'invoices.recognize',
        partyId: first.partyId,
        documentKind: 'invoice.received',
      },
      mapping: { account: '626' },
    });
    const templateId = (template.executed.result as { templateId: string }).templateId;
    const cited = { answers: [], template: templateId };
    const sample = await propose(first.id, cited);
    await s.post(await s.approve(sample));
    // As a graduation grants it: bound to the template, the partner, what was observed.
    const policy = await s.invoke<{ id: string }>(s.reviewer, 'policies.create', {
      name: 'Internet lunar',
      treatments: ['invoices.recognize'],
      rulesHashes: [sample.rulesHash],
      preconditions: [
        { kind: 'template', id: templateId, version: 1 },
        { kind: 'parties', ids: [first.partyId] },
        { kind: 'knownParty', minPosted: 1 },
        { kind: 'withinObserved', factor: '1.50' },
        { kind: 'noWarnings' },
      ],
      validFrom: '2026-01-01',
      expiresAt: s.expiresIn(30),
    });
    await worker();
    const paused = async () => (await policies()).find((item) => item.id === policy.id)!.paused;
    expect((await propose((await invoice('F-2', '2026-03-02')).id, cited)).status).toBe('posted');
    // Other suppliers' invoices, new ones and of any amount, are outside its template's scope.
    for (const [number, gross, counterparty] of [
      ['A-1', '121.00', '33445560'],
      ['B-1', '12100.00', '44556670'],
    ] as const) {
      const proposal = await propose(
        (await invoice(number, '2026-03-03', gross, { counterparty })).id,
        undefined,
        '628',
      );
      expect(proposal.status).toBe('proposed');
      await worker();
      expect(await paused()).toBe(false);
    }
    expect((await propose((await invoice('F-3', '2026-03-04')).id, cited)).status).toBe('posted');
    // Its own supplier at ten times the usual amount: left for a person, the policy paused.
    const unusual = await propose((await invoice('F-4', '2026-03-05', '1210.00')).id, cited);
    expect(unusual.status).toBe('proposed');
    await worker();
    expect(await paused()).toBe(true);
    const status = await s.invoke<{ paused: { trigger: string }[] }>(agent, 'automation.status');
    expect(status.paused.map((item) => item.trigger)).toEqual(['unusual_amount']);
  });

  test('criteria tighten, never loosen; agents may not set them', async () => {
    const { s, agent } = await setup();
    expect(
      (
        await s.refused(
          s.invoke(s.owner, 'automation.criteria.record', {
            minCorrect: 5,
            minMonths: 3,
            policyDays: 90,
            reason: 'Mai puține înregistrări ar ajunge.',
          }),
        )
      )?.code,
    ).toBe('VALIDATION');
    expect(
      (
        await s.refused(
          s.invoke(agent, 'automation.criteria.record', {
            minCorrect: 8,
            minMonths: 4,
            policyDays: 60,
            reason: 'Criterii mai stricte pentru companie.',
          }),
        )
      )?.code,
    ).toBe('AGENT_SCOPE');
    const tightened = await s.invoke(s.reviewer, 'automation.criteria.record', {
      minCorrect: 8,
      minMonths: 4,
      policyDays: 60,
      reason: 'Contabilul cere criterii mai stricte.',
    });
    expect(tightened).toEqual({ minCorrect: 8, minMonths: 4, policyDays: 60, seq: 1 });
    expect((await s.invoke<{ criteria: unknown }>(agent, 'automation.status')).criteria).toEqual({
      minCorrect: 8,
      minMonths: 4,
      policyDays: 60,
      seq: 1,
    });
    // Policies follow the tightened expiry.
    expect(
      (
        await s.refused(
          s.invoke(s.reviewer, 'policies.create', {
            name: 'Prea lungă',
            treatments: ['invoices.recognize'],
            rulesHashes: ['a'.repeat(64)],
            preconditions: [],
            validFrom: '2026-01-01',
            expiresAt: s.expiresIn(75),
          }),
        )
      )?.code,
    ).toBe('POLICY_EXPIRY');
    // Any member pauses, a viewer included; only a person who reviews resumes.
    await s.invoke(s.viewer, 'automation.pause', {
      scope: 'company',
      reason: 'Am văzut o sumă ciudată în extras.',
    });
    expect(
      (
        await s.refused(
          s.invoke(s.viewer, 'automation.resume', {
            scope: 'company',
            reason: 'Am verificat, totul e în regulă.',
          }),
        )
      )?.code,
    ).toBe('FORBIDDEN');
    expect(randomUUID()).toBeString();
  });
});
