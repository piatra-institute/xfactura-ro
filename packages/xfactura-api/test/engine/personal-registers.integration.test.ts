import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { canonical } from 'xfactura-core/hash';
import { createApp } from '../../source/engine/http/app';
import { payrollLines, questionAnswers, templatePredictions } from '../../source/engine/db/schema';
import type { ActionView } from '../../source/engine/kernel/actions';
import type { Actor } from '../../source/engine/kernel/commands';
import type { ProposalView } from '../../source/engine/kernel/views';
import { camt, camtEntry, iban } from './fixtures/bank';
import { journal, scenario, secret, type Scenario } from './scenario';

// Personal data in the registers (6 November 2026): payments of pay in the money registers, the
// personnel's balance confirmations at the year's end, what a D112's period tells of sick leave,
// sick leave kept sealed at rest, the documents of a run's benefits, and the opening's
// differences. Each is read by an agent whose grant does not cover the classes (over HTTP), by a
// viewer, and by the owner. No assertion prints a CNP or a diagnosis.

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

/** A synthetic CNP with a valid control digit. */
function cnp(body: string) {
  const weights = [2, 7, 9, 1, 4, 6, 3, 5, 8, 2, 7, 9];
  const control =
    weights.reduce((sum, weight, index) => sum + weight * Number(body[index]), 0) % 11;
  return `${body}${control === 10 ? 1 : control}`;
}

/** Whether what a call returns holds a text (a boolean, so that no failure prints it). */
const holds = async (text: string, read: unknown) => JSON.stringify(await read).includes(text);

const publicUrl = 'http://localhost:3000';

/** An agent of the reviewer's granted these operations, with a way to call them over HTTP as an
 * agent's client does (REST, bearer credential). */
async function agentOf(s: Scenario, scopes: string[]) {
  const grant = await s.invoke<{ token: string }>(s.reviewer, 'agents.issue', {
    name: 'Asistent',
    scopes,
    expiresAt: s.expiresIn(7),
  });
  const actor = await s.engine.agents.authenticate(grant.token, s.company.id);
  const { app } = createApp(s.engine, { publicUrl, authSecret: secret });
  const http = async <T = unknown>(operation: string, input: unknown = {}) => {
    const response = await app.request(
      `${publicUrl}/api/accounting/v1/companies/${s.company.id}/capabilities/${operation}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${grant.token}`,
          'content-type': 'application/json',
          'idempotency-key': randomUUID(),
        },
        body: JSON.stringify(input),
      },
    );
    const body = (await response.json()) as T & { error?: { code: string } };
    return { status: response.status, body };
  };
  return Object.assign(actor, { http });
}

/** The reads every test grants; an agent whose reads also cover payroll and personal data names
 * `questions.list`, which declares them. */
const reads = [
  'bank.movements',
  'work.list',
  'work.get',
  'proposals.get',
  'proposals.list',
  'proposals.propose',
  'bank.settle.propose',
  'proposals.batch.request',
  'actions.get',
  'actions.execute',
  'ledger.journal',
  'cash.register',
  'pfa.journal',
  'templates.performance',
  'yearend.review',
  'inventory.compare',
  'years.opening',
  'declarations.list',
  'obligations.calendar',
  'closure.evaluate',
  'evidence.read',
  'evidence.list',
];

type Run = {
  id: string;
  lines: { contractId: string; issues: { code: string; message: string }[] }[];
};

/** An employer with a valid CUI, its seller details and ANAF as a partner, and ways to hire, run
 * and book the payroll of a month. */
async function employer(options: { clock?: () => number; period?: 'quarterly' } = {}) {
  const s = await scenario({ cui: '18547290', ...(options.clock ? { clock: options.clock } : {}) });
  open.push(s);
  for (const [axis, value] of [
    ['employer', 'yes'],
    ['policy.payroll.employer_share', '635'],
    ...(options.period
      ? [
          ['entity.form', 'srl'],
          ['vat.status', 'non_vat'],
          ['vat.eu', 'none'],
          ['income_tax', 'micro'],
          ['payroll.period', options.period],
        ]
      : []),
  ])
    await s.invoke(s.owner, 'profile.record', {
      axis,
      value,
      effectiveFrom: '2026-01-01',
      evidenceId: (await s.evidence(`${axis}.pdf`)).id,
    });
  await s.invoke(s.owner, 'sales.seller.record', {
    details: {
      name: 'Exemplu Servicii SRL',
      vatId: 'RO18547290',
      address: { lines: ['Str. Lungă 10'], city: 'Galați', subdivision: 'RO-GL', country: 'RO' },
    },
  });
  const anaf = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
    kind: 'ro_public_institution',
    country: 'RO',
    name: 'ANAF',
  });
  const hire = async (name: [string, string], code: string, baseSalary: string) => {
    const employee = await s.invoke<{ id: string; partyId: string }>(
      s.owner,
      'payroll.employees.record',
      { lastName: name[0], firstName: name[1], cnp: code, healthFund: 'RO-GL' },
    );
    const contract = await s.invoke<{ contractId: string }>(s.owner, 'payroll.contracts.record', {
      employeeId: employee.id,
      number: `CIM-${name[0]}`,
      startDate: '2025-02-15',
      effectiveFrom: '2025-02-15',
      dailyHours: 8,
      mainJob: true,
      occupation: '251201',
      baseSalary,
    });
    return { ...employee, contractId: contract.contractId };
  };
  const prepare = (month = '2026-10', entries: unknown[] = []) =>
    s.invoke<Run>(s.owner, 'payroll.runs.prepare', { month, entries });
  const book = (run: Run, month = '2026-10') =>
    s.book('payroll.recognize', { runId: run.id, month, round: 1, authorityId: anaf.id });
  return { s, anaf, hire, prepare, book };
}

/** Each person's net pay owed on 421 after a posted run, in lei, by party. */
async function netPay(s: Scenario) {
  const items = await s.list<{ id: string; account: string; partyId: string; balance: string }>(
    s.owner,
    'openItems.list',
  );
  return new Map(
    items
      .filter((item) => item.account === '421')
      .map((item) => [item.partyId, { id: item.id, amount: item.balance.replace('-', '') }]),
  );
}

const bani = (amount: string) => Math.round(Number(amount) * 100);
const lei = (cents: number) => (cents / 100).toFixed(2);

/** A credit transfer to a named beneficiary, as a camt.053 entry's details. */
const transfer = (amount: string, name: string, account: string, text: string) =>
  `<NtryDtls><TxDtls><Refs><EndToEndId>${text.slice(0, 10)}</EndToEndId></Refs><AmtDtls><TxAmt><Amt Ccy="RON">${amount}</Amt></TxAmt></AmtDtls><RltdPties><Cdtr><Nm>${name}</Nm></Cdtr><CdtrAcct><Id><IBAN>${account}</IBAN></Id></CdtrAcct></RltdPties><RmtInf><Ustrd>${text}</Ustrd></RmtInf></TxDtls></NtryDtls>`;

type Movement = {
  id: string;
  amount: string | null;
  reference: string | null;
  counterparty: string | null;
  counterpartyAccount: string | null;
  redacted?: true;
};
type WorkItem = {
  id: string;
  kind: string;
  subject: { id: string };
  message: string;
  details: Record<string, unknown>;
  next: { operation: string; by: string; allowed: boolean; needs?: string[]; inputHint: unknown }[];
};
type JournalEntry = {
  description: string;
  document: { number: string | null } | null;
  lines: {
    account: string;
    amount: string | null;
    partyId?: string;
    memo?: string;
    includes?: string[];
  }[];
  redacted?: true;
};

describe('payments of pay in the money registers', () => {
  // bank.movements, the worklist, the journal, a batch and a template's track record showed an
  // employee's net pay to any agent: the counterparty, the IBAN and the amount, which the
  // personnel accounts' summing did not cover.
  test('a payment of pay names no one, and states one person’s pay to no one, who may not read pay', async () => {
    const { s, hire, prepare, book } = await employer();
    const ana = await hire(['Popescu', 'Ana'], cnp('290050117002'), '5000');
    const dan = await hire(['Ionescu', 'Dan'], cnp('180010112345'), '6000');
    const ion = await hire(['Georgescu', 'Ion'], cnp('170030112345'), '4500');
    await book(await prepare());
    const owed = await netPay(s);
    const [toAna, toDan, toIon] = [ana, dan, ion].map((person) => owed.get(person.partyId)!);
    const batchTotal = lei(bani(toDan!.amount) + bani(toIon!.amount));
    const anaAccount = 'RO49AAAA1B31007593840001';

    await s.invoke(s.owner, 'treasury.createAccount', {
      kind: 'bank',
      name: 'Cont curent',
      iban,
      currency: 'RON',
      ledgerAccount: '5121',
      openedOn: '2026-01-01',
    });
    const paid = bani(toAna!.amount) + bani(batchTotal) + 10_000;
    const statement = camt({
      id: 'NOVEMBER-2026',
      from: '2026-11-01',
      to: '2026-11-30',
      opening: '50000.00',
      closing: lei(5_000_000 - paid),
      entries: [
        camtEntry({
          amount: toAna!.amount,
          bankRef: 'SAL-ANA',
          date: '2026-11-10',
          text: 'Salariu octombrie Popescu Ana',
          details: transfer(toAna!.amount, 'POPESCU ANA', anaAccount, 'Salariu octombrie'),
        }),
        camtEntry({
          amount: batchTotal,
          bankRef: 'SAL-LOT',
          date: '2026-11-10',
          text: 'Lot salarii',
        }),
        camtEntry({
          amount: '100.00',
          bankRef: 'PAY-F1',
          date: '2026-11-12',
          text: 'Factura F-1',
          details: transfer('100.00', 'FURNIZOR SRL', 'RO49AAAA1B31007593840002', 'Factura F-1'),
        }),
      ].join(''),
    });
    const { id: file } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: 'extras-noiembrie.xml',
      mediaType: 'application/xml',
      base64: Buffer.from(statement).toString('base64'),
    });
    await s.invoke(s.owner, 'bank.import', { evidenceId: file, financialYearId: s.year.id });
    const movements = async (actor: Actor) => s.list<Movement>(actor, 'bank.movements');
    const all = await movements(s.owner);
    const of = (rows: Movement[], id: string) => rows.find((row) => row.id === id)!;
    const anaMove = all.find((row) => row.counterparty === 'POPESCU ANA')!;
    const batchMove = all.find((row) => row.reference === 'Lot salarii')!;
    const supplierMove = all.find((row) => row.counterparty === 'FURNIZOR SRL')!;
    expect(anaMove.counterpartyAccount).toBe(anaAccount);

    const agent = await agentOf(s, reads);
    const payroll = await agentOf(s, [...reads, 'questions.list']);
    // Unexplained, Ana's pay is known by its counterparty, an employee: salaries, without her
    // name, account, reference and amount. The batch names no one; the supplier is as it is.
    const viaHttp = await agent.http<{ items: Movement[] }>('bank.movements');
    expect(viaHttp.status).toBe(200);
    for (const rows of [viaHttp.body.items, await movements(s.viewer)]) {
      expect(of(rows, anaMove.id)).toMatchObject({
        amount: null,
        reference: null,
        counterparty: 'Plată salarii',
        counterpartyAccount: null,
        redacted: true,
      });
      expect(of(rows, supplierMove.id)).toEqual(of(all, supplierMove.id));
      expect(await holds('POPESCU', rows)).toBe(false);
      expect(await holds(toAna!.amount.replace('.', ','), rows)).toBe(false);
    }
    expect(of(await movements(payroll), anaMove.id)).toEqual(anaMove);

    // The worklist leaves it to someone who may read it, and says why.
    const unexplained = async (actor: Actor, by?: 'agent' | 'human') =>
      (
        await s.list<WorkItem>(actor, 'work.list', {
          kinds: ['bank.unexplained'],
          ...(by ? { by } : {}),
        })
      ).find((item) => item.subject.id === anaMove.id);
    for (const actor of [agent, s.viewer]) {
      const item = (await unexplained(actor))!;
      expect(item.message).toContain('Plată salarii');
      expect(item.details).toMatchObject({ amountMinor: null, counterparty: 'Plată salarii' });
      expect(await holds('Popescu', item)).toBe(false);
    }
    const step = (await unexplained(agent))!.next.find(
      (item) => item.operation === 'bank.settle.propose' || item.operation === 'proposals.propose',
    )!;
    expect(step).toMatchObject({ allowed: false, needs: ['payroll', 'personal'] });
    expect(await unexplained(agent, 'agent')).toBeUndefined();
    expect(await unexplained(agent, 'human')).toBeDefined();
    expect((await unexplained(payroll, 'agent'))?.details.counterparty).toBe('POPESCU ANA');
    expect((await unexplained(s.owner))!.details.counterparty).toBe('POPESCU ANA');
    // Proposing it anyway is refused with the reason, and nothing is recorded.
    const refused = await agent.http('bank.settle.propose', {
      movementId: anaMove.id,
      lines: [{ account: '628', amount: toAna!.amount }],
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({
      code: 'PAY_DATA',
      details: { missing: ['payroll', 'personal'] },
    });

    // A template measured on these movements, before anything was posted for them.
    const template = await s.invoke<ActionView>(s.owner, 'templates.request', {
      name: 'Plăți după număr',
      scope: { treatment: 'bank.settle', documentKind: 'movement.paid' },
      mapping: { settle: 'openItem', match: 'number' },
    });
    await s.invoke(s.reviewer, 'actions.approve', {
      id: template.id,
      previewHash: template.previewHash,
    });
    const templateId = (
      (await s.invoke<ActionView>(s.reviewer, 'actions.execute', { id: template.id })).result as {
        templateId: string;
      }
    ).templateId;
    await s.db.write((tx) =>
      tx.insert(templatePredictions).values({
        companyId: s.company.id,
        templateId,
        templateVersion: 1,
        sourceKey: `movement:${anaMove.id}`,
        status: 'predicted',
        subjectKey: `movement:${anaMove.id}`,
        input: canonical({ movementId: anaMove.id, lines: [{ account: '628', amount: '1.00' }] }),
        fingerprint: 'a-different-booking',
        asOfSeq: 1,
      }),
    );

    // The owner explains both payments of pay; the agent asks for their batch approval.
    const settleAna = await s.propose('bank.settle', {
      movementId: anaMove.id,
      allocations: [{ openItem: toAna!.id, amount: toAna!.amount }],
    });
    const settleBatch = await s.propose('bank.settle', {
      movementId: batchMove.id,
      allocations: [
        { openItem: toDan!.id, amount: toDan!.amount },
        { openItem: toIon!.id, amount: toIon!.amount },
      ],
    });
    for (const actor of [agent, s.viewer]) {
      const seen = await s.invoke<ProposalView>(actor, 'proposals.get', { id: settleAna.id });
      expect(seen).toMatchObject({
        effect: null,
        redacted: true,
        effectHash: settleAna.effectHash,
      });
      expect(await holds('POPESCU', seen)).toBe(false);
    }
    expect(
      (await s.invoke<ProposalView>(payroll, 'proposals.get', { id: settleAna.id })).effect,
    ).not.toBeNull();
    const request = await agent.http<ActionView>('proposals.batch.request', {
      members: [settleAna, settleBatch].map((proposal) => ({
        proposalId: proposal.id,
        version: proposal.version,
        effectHash: proposal.effectHash,
      })),
    });
    expect(request.status).toBe(200);
    type Preview = {
      members: { proposalId: string; description: string; amount: string | null }[];
    };
    const members = (view: ActionView) => (view.preview as unknown as Preview).members;
    for (const actor of [agent, s.viewer]) {
      const shown = members(
        await s.invoke<ActionView>(actor, 'actions.get', { id: request.body.id }),
      );
      expect(shown.map((member) => [member.description, member.amount])).toEqual([
        ['Plată salarii', null],
        ['Plată salarii', batchTotal],
      ]);
    }
    const whole = members(
      await s.invoke<ActionView>(s.owner, 'actions.get', { id: request.body.id }),
    );
    expect(whole.map((member) => member.amount)).toEqual([toAna!.amount, batchTotal]);
    await s.invoke(s.reviewer, 'actions.approve', {
      id: request.body.id,
      previewHash: request.body.previewHash,
    });
    expect((await agent.http<ActionView>('actions.execute', { id: request.body.id })).status).toBe(
      200,
    );

    // Posted: the batch's total stands, one person's does not.
    for (const rows of [(await agent.http<{ items: Movement[] }>('bank.movements')).body.items]) {
      expect(of(rows, anaMove.id)).toMatchObject({ amount: null, counterparty: 'Plată salarii' });
      expect(of(rows, batchMove.id)).toMatchObject({
        amount: `-${batchTotal}`,
        counterparty: 'Plată salarii',
        reference: null,
        redacted: true,
      });
    }
    const entries = async (actor: Actor) =>
      (
        await s.invoke<{ entries: JournalEntry[] }>(actor, 'ledger.journal', {
          from: '2026-11-01',
          to: '2026-11-30',
        })
      ).entries;
    for (const actor of [agent, s.viewer]) {
      const [anaEntry, batchEntry] = await entries(actor);
      expect(anaEntry).toMatchObject({ description: 'Plată salarii', redacted: true });
      expect(anaEntry!.document?.number).toBeNull();
      expect(anaEntry!.lines.map((line) => [line.account, line.amount])).toEqual([
        ['5121', null],
        ['421', null],
      ]);
      expect(batchEntry!.lines.map((line) => [line.account, line.amount])).toEqual([
        ['5121', batchTotal],
        ['421', batchTotal],
      ]);
      expect(batchEntry!.lines.some((line) => line.partyId)).toBe(false);
      expect(await holds('Popescu', [anaEntry, batchEntry])).toBe(false);
    }
    const booked = await entries(s.owner);
    expect(booked[0]!.description).toContain('Popescu Ana');
    expect(booked[1]!.lines.filter((line) => line.partyId)).toHaveLength(2);

    // The template's track record: the posting it was measured against, without the person.
    type Performance = {
      outcomes: { subject: string; amount: string | null; redacted?: true }[];
      corrections: { subject: string; predicted: unknown; posted: unknown }[];
    };
    const performance = async (actor: Actor) =>
      s.invoke<Performance>(actor, 'templates.performance', { templateId });
    for (const actor of [agent, s.viewer]) {
      const seen = await performance(actor);
      expect(seen.outcomes).toEqual([
        expect.objectContaining({
          subject: `movement:${anaMove.id}`,
          amount: null,
          redacted: true,
        }),
      ]);
      expect(seen.corrections).toEqual([
        expect.objectContaining({ predicted: null, posted: null }),
      ]);
    }
    const full = await performance(s.owner);
    expect(full.outcomes[0]!.amount).toBe(toAna!.amount);
    expect(await holds(toAna!.id, full.corrections)).toBe(true);
  });

  test('the cash register shows a day’s payments of pay as one row of salaries', async () => {
    const { s, hire } = await employer();
    const dan = await hire(['Ionescu', 'Dan'], cnp('180010112345'), '6000');
    const ion = await hire(['Georgescu', 'Ion'], cnp('170030112345'), '4500');
    const evidenceId = (await s.evidence('registru.pdf')).id;
    await s.book(
      'ledger.general',
      journal(
        evidenceId,
        [
          { account: '5311', side: 'D', amount: '5000.00' },
          { account: '1012', side: 'C', amount: '5000.00' },
        ],
        { date: '2026-01-01', purpose: 'opening' },
      ),
    );
    // Two employees' pay, paid in cash the same day as a purchase.
    for (const [person, amount, name] of [
      [dan, '300.00', 'Ionescu Dan'],
      [ion, '200.00', 'Georgescu Ion'],
    ] as const) {
      const owed = await s.book(
        'ledger.general',
        journal(
          evidenceId,
          [
            { account: '641', side: 'D', amount },
            { account: '421', side: 'C', amount, newItem: 'pay' },
          ],
          { date: '2026-10-14', newItems: [{ ref: 'pay', partyId: person.partyId }] },
        ),
      );
      await s.book(
        'ledger.general',
        journal(
          evidenceId,
          [
            { account: '421', side: 'D', amount, openItem: owed.effect!.openItems[0]!.id },
            { account: '5311', side: 'C', amount, memo: `DP-${amount}` },
          ],
          { date: '2026-10-15', description: `Salariu ${name}` },
        ),
      );
    }
    await s.book(
      'ledger.general',
      journal(
        evidenceId,
        [
          { account: '628', side: 'D', amount: '50.00' },
          { account: '5311', side: 'C', amount: '50.00', memo: 'DP-3' },
        ],
        { date: '2026-10-15', description: 'Taxe poștale' },
      ),
    );
    type Register = {
      days: {
        date: string;
        movements: {
          document: string | null;
          description: string;
          receipt: string | null;
          payment: string | null;
          redacted?: true;
        }[];
        closing: string;
      }[];
    };
    const day = async (actor: Actor) =>
      (
        await s.invoke<Register>(actor, 'cash.register', {
          account: '5311',
          from: '2026-10-15',
          to: '2026-10-15',
        })
      ).days[0]!;
    const agent = await agentOf(s, reads);
    const viaHttp = await agent.http<Register>('cash.register', {
      account: '5311',
      from: '2026-10-15',
      to: '2026-10-15',
    });
    for (const seen of [viaHttp.body.days[0]!, await day(s.viewer)]) {
      expect(seen.movements).toEqual([
        {
          document: null,
          description: 'Plată salarii',
          receipt: null,
          payment: '500.00',
          redacted: true,
        },
        { document: 'DP-3', description: 'Taxe poștale', receipt: null, payment: '50.00' },
      ]);
      expect(seen.closing).toBe('4450.00');
    }
    const full = await day(s.owner);
    expect(full.movements.map((row) => row.description)).toEqual([
      'Salariu Ionescu Dan',
      'Salariu Georgescu Ion',
      'Taxe poștale',
    ]);
  });

  test('a PFA’s receipts and payments journal shows a payment of pay without the person', async () => {
    const s = await scenario();
    open.push(s);
    const evidenceId = (await s.evidence('certificat.pdf')).id;
    for (const [axis, value] of [
      ['entity.form', 'pfa'],
      ['books.system', 'single'],
    ])
      await s.invoke(s.owner, 'profile.record', {
        axis,
        value,
        effectiveFrom: '2026-01-01',
        evidenceId,
      });
    const employee = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
      kind: 'ro_individual',
      country: 'RO',
      taxId: cnp('290050117002'),
      name: 'Popescu Ana',
    });
    await s.book(
      'ledger.general',
      journal(
        evidenceId,
        [
          { account: '5311', side: 'D', amount: '9000.00' },
          { account: '1012', side: 'C', amount: '9000.00' },
        ],
        { date: '2026-01-01', purpose: 'opening' },
      ),
    );
    const owed = await s.book(
      'ledger.general',
      journal(
        evidenceId,
        [
          { account: '641', side: 'D', amount: '3000.00' },
          { account: '421', side: 'C', amount: '3000.00', newItem: 'ana' },
        ],
        { date: '2026-10-31', newItems: [{ ref: 'ana', partyId: employee.id }] },
      ),
    );
    await s.book(
      'ledger.general',
      journal(
        evidenceId,
        [
          { account: '421', side: 'D', amount: '3000.00', openItem: owed.effect!.openItems[0]!.id },
          { account: '5311', side: 'C', amount: '3000.00', memo: 'DP-1' },
        ],
        { date: '2026-11-05', description: 'Salariu Popescu Ana' },
      ),
    );
    type Row = {
      date: string;
      explanation: string;
      payments: { cash: string | null; bank: string | null };
      natures: { amount: string | null }[];
      redacted?: true;
    };
    const rows = async (actor: Actor) =>
      (await s.invoke<{ rows: Row[] }>(actor, 'pfa.journal', { year: 2026, month: '2026-11' }))
        .rows;
    const agent = await agentOf(s, reads);
    for (const seen of [
      (await agent.http<{ rows: Row[] }>('pfa.journal', { year: 2026, month: '2026-11' })).body
        .rows,
      await rows(s.viewer),
    ]) {
      expect(seen).toEqual([
        expect.objectContaining({
          explanation: 'Plată salarii',
          payments: { cash: null, bank: null },
          redacted: true,
        }),
      ]);
      expect(seen[0]!.natures.every((nature) => nature.amount === null)).toBe(true);
      expect(await holds('Popescu', seen)).toBe(false);
    }
    const [full] = await rows(s.owner);
    expect(full!.explanation).toContain('Popescu Ana');
    expect(full!.payments.cash).toBe('3000.00');
  });
});

describe('the personnel’s balances at the year’s end', () => {
  // yearend.review, its worklist items, the year close's findings and inventory.compare named
  // an employee whose balance on a personnel account did not confirm, with the amount.
  test('a personnel confirmation names no one to who may not read pay, and waits on a person', async () => {
    const s = await scenario({ clock: () => Date.parse('2027-02-20T10:00:00Z') });
    open.push(s);
    const person = (name: string, code: string) =>
      s.invoke<{ id: string }>(s.owner, 'parties.create', {
        kind: 'ro_individual',
        country: 'RO',
        taxId: cnp(code),
        name,
      });
    await person('Popescu Ana', '290050117002');
    const dan = await person('Ionescu Dan', '180010112345');
    const evidenceId = (await s.evidence('stat.pdf')).id;
    await s.book(
      'ledger.general',
      journal(
        evidenceId,
        [
          { account: '641', side: 'D', amount: '3000.00' },
          { account: '421', side: 'C', amount: '3000.00', newItem: 'dan' },
        ],
        { date: '2026-12-31', newItems: [{ ref: 'dan', partyId: dan.id }] },
      ),
    );
    const list = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: 'inventar.txt',
      mediaType: 'text/plain',
      base64: Buffer.from('Lista de inventariere 31.12.2026').toString('base64'),
    });
    await s.invoke(s.owner, 'documents.record', {
      evidenceId: list.id,
      kind: 'inventory.list',
      body: {
        title: 'Lista de inventariere la 31.12.2026',
        company: { name: 'Pilot SRL', taxId: '12345678' },
        date: '2026-12-31',
        commission: { decision: '45', decisionDate: '2026-12-01', members: ['Pop Ion'] },
        partners: [
          {
            name: 'Popescu Ana',
            taxId: null,
            account: '425',
            currency: 'RON',
            confirmed: null,
            status: 'no_reply',
          },
          {
            name: 'Ionescu Dan',
            taxId: null,
            account: '421',
            currency: 'RON',
            confirmed: '-2500.00',
            status: 'disputed',
          },
        ],
      },
    });
    const agent = await agentOf(s, reads);
    type Review = {
      items: {
        id: string;
        check: string;
        message: string;
        details: Record<string, unknown>;
        redacted?: true;
      }[];
    };
    const partners = (review: Review) =>
      review.items.filter((item) => item.check === 'inventory.partners');
    const review = (actor: Actor) =>
      s.invoke<Review>(actor, 'yearend.review', { financialYearId: s.year.id });
    const ids = ['inventory.partners|personnel/425/RON', 'inventory.partners|personnel/421/RON'];
    const pay = (items: Review['items']) => items.find((item) => item.id === ids[1])!;
    for (const shown of [
      partners((await agent.http<Review>('yearend.review', { financialYearId: s.year.id })).body),
      partners(await review(s.viewer)),
    ]) {
      expect(shown.map((item) => item.id)).toEqual(ids);
      expect(pay(shown)).toMatchObject({
        details: { account: '421', currency: 'RON', partners: 1, redacted: true },
        redacted: true,
      });
      expect(pay(shown).message).toContain('personalului din 421');
      expect(await holds('Ionescu', shown)).toBe(false);
      expect(await holds('Popescu', shown)).toBe(false);
      expect(await holds('2500', shown)).toBe(false);
    }
    const full = partners(await review(s.owner));
    expect(full.map((item) => item.id)).toEqual(ids);
    expect(pay(full).message).toContain('Ionescu Dan confirmă -2500.00');
    expect(pay(full).details).toMatchObject({
      partners: [{ partyId: dan.id, name: 'Ionescu Dan', book: '-3000.00' }],
    });

    // The comparison counts the personnel's differences per account, without who or how much.
    type Compared = { differences: Record<string, unknown>[] };
    for (const compared of [
      (await agent.http<Compared>('inventory.compare', { date: '2026-12-31' })).body,
      await s.invoke<Compared>(s.viewer, 'inventory.compare', { date: '2026-12-31' }),
    ])
      expect(compared.differences).toEqual([
        expect.objectContaining({ account: '425', name: null, book: null, persons: 1 }),
        expect.objectContaining({ account: '421', name: null, book: null, persons: 1 }),
      ]);
    expect(
      (await s.invoke<Compared>(s.owner, 'inventory.compare', { date: '2026-12-31' })).differences,
    ).toEqual([
      expect.objectContaining({ name: 'Popescu Ana', account: '425', status: 'no_reply' }),
      expect.objectContaining({ partyId: dan.id, account: '421', book: '-3000.00' }),
    ]);

    // The worklist keeps the item actionable: it waits on a person, or an agent that may read it.
    const work = (actor: Actor, by?: 'agent' | 'human') =>
      s
        .list<WorkItem>(actor, 'work.list', { kinds: ['yearend.review'], ...(by ? { by } : {}) })
        .then((items) => items.find((item) => item.subject.id === `2026|${ids[1]}`));
    const item = (await work(agent))!;
    expect(item.details).toEqual({
      check: 'inventory.partners',
      account: '421',
      currency: 'RON',
      partners: 1,
      redacted: true,
    });
    expect(item.next).toEqual([
      expect.objectContaining({
        operation: 'inventory.compare',
        allowed: false,
        needs: ['payroll', 'personal'],
      }),
    ]);
    expect(await work(agent, 'agent')).toBeUndefined();
    expect(await work(agent, 'human')).toBeDefined();
    expect(await holds('Ionescu', await work(s.viewer))).toBe(false);
    expect(await holds('Ionescu Dan', await work(s.owner))).toBe(true);
    const payroll = await agentOf(s, [...reads, 'questions.list']);
    expect((await work(payroll, 'agent'))?.next[0]?.allowed).toBe(true);

    // The year close's findings name no one, for whoever reads the request.
    const request = await s.invoke<ActionView>(s.owner, 'years.close.request', {
      financialYearId: s.year.id,
    });
    type Findings = { findings: { code: string; message: string }[] };
    for (const actor of [agent, s.viewer, s.owner]) {
      const findings = (
        (await s.invoke<ActionView>(actor, 'actions.get', { id: request.id }))
          .preview as unknown as Findings
      ).findings.filter((finding) => finding.code === 'YEAR_END_INVENTORY_PARTNERS');
      expect(findings).toHaveLength(2);
      expect(await holds('Ionescu', findings)).toBe(false);
    }
  });
});

/** Ill from the 3rd to the 14th: a certificate whose last days the fund pays. */
const sickLeave = (contractId: string, month: string) => [
  {
    contractId,
    sickLeave: [
      {
        series: 'CCMAM',
        number: '21',
        code: '01',
        issued: `${month}-03`,
        from: `${month}-03`,
        to: `${month}-14`,
        place: 'family_doctor',
        diagnosis: '101',
      },
    ],
    sickBase: { income: '24300', days: 121 },
  },
];

describe('what a D112’s period tells', () => {
  // A quarterly employer's month filed monthly because of sick leave read `basis: event` in the
  // return's summary, and the calendar's deadline told the same; a payroll of one person showed
  // the sick pay claimed from the fund (4382).
  test('a D112 is due when it is, and says why only to who may read health data', async () => {
    const { s, hire, prepare, book } = await employer({ period: 'quarterly' });
    const ana = await hire(['Popescu', 'Ana'], cnp('290050117002'), '5000');
    await hire(['Georgescu', 'Elena'], cnp('285072217002'), '4325');
    await book(await prepare('2026-07'), '2026-07');
    const august = await book(
      await prepare('2026-08', sickLeave(ana.contractId, '2026-08')),
      '2026-08',
    );
    await book(await prepare('2026-09'), '2026-09');
    const prepared = await s.invoke<{ id: string }>(s.owner, 'declarations.prepare', {
      kind: 'D112',
      period: '2026-07',
      options: {
        declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' },
        caen: '6201',
        phone: '0236000000',
      },
    });
    type Artifact = { id: string; steps: { state: string; detail: string | null }[] };
    const filing = (artifacts: Artifact[]) =>
      (
        JSON.parse(artifacts.find((item) => item.id === prepared.id)!.steps[0]!.detail!) as {
          filing: Record<string, unknown>;
        }
      ).filing;
    const agent = await agentOf(s, reads);
    const health = await agentOf(s, [...reads, 'payroll.absences.list']);
    const hidden = {
      period: 'quarterly',
      month: '2026-07',
      deadline: 'D112',
      counted: null,
      basis: null,
      event: null,
    };
    expect(
      filing((await agent.http<{ items: Artifact[] }>('declarations.list')).body.items),
    ).toEqual(hidden);
    expect(filing(await s.list<Artifact>(s.viewer, 'declarations.list'))).toEqual(hidden);
    for (const actor of [s.owner, health])
      expect(filing(await s.list<Artifact>(actor, 'declarations.list'))).toEqual({
        period: 'quarterly',
        month: '2026-07',
        deadline: 'D112',
        counted: '2026-08',
        basis: 'event',
        event: '2026-08',
      });

    // The calendar: the same due dates, every D112 named by its return alone.
    type Obligation = { kind: string; deadline: string; due: string | null; versions: string[] };
    const calendar = async (actor: Actor) =>
      (
        await s.list<Obligation>(actor, 'obligations.calendar', {
          from: '2026-07',
          to: '2026-09',
          today: '2026-08-01',
        })
      ).filter((item) => item.kind === 'D112');
    const due = ['2026-09-25', '2026-09-25', '2026-10-26'];
    for (const seen of [
      (
        await agent.http<{ items: Obligation[] }>('obligations.calendar', {
          from: '2026-07',
          to: '2026-09',
          today: '2026-08-01',
        })
      ).body.items.filter((item) => item.kind === 'D112'),
      await calendar(s.viewer),
    ]) {
      expect(seen.map((item) => [item.deadline, item.due, item.versions])).toEqual(
        due.map((date) => ['D112', date, []]),
      );
    }
    expect((await calendar(s.owner)).map((item) => [item.deadline, item.due])).toEqual([
      ['D112', '2026-09-25'],
      ['D112', '2026-09-25'],
      ['D112.quarterly', '2026-10-26'],
    ]);
    type Closure = {
      obligations: { kind: string; deadline: string; deadlinePeriod: string | null }[];
    };
    const closure = async (actor: Actor) =>
      (
        await s.invoke<Closure>(actor, 'closure.evaluate', { from: '2026-07', to: '2026-09' })
      ).obligations.filter((item) => item.kind === 'D112');
    expect((await closure(agent)).map((item) => [item.deadline, item.deadlinePeriod])).toEqual([
      ['D112', null],
      ['D112', null],
      ['D112', null],
    ]);
    expect((await closure(s.owner)).map((item) => item.deadlinePeriod)).toEqual([
      '2026-08',
      null,
      '2026-Q3',
    ]);
    const obligation = (await s.list<WorkItem>(agent, 'work.list', { kinds: ['obligation.due'] }))
      .filter((item) => item.subject.id.startsWith('D112|'))
      .map((item) => item.details.deadline);
    expect(new Set(obligation)).toEqual(new Set(['D112']));

    // Two people: the sick pay claimed (4382) is not one person's, and stands as booked.
    const claimed = august.effect!.lines.filter((line) => line.account === '4382');
    expect(claimed).toHaveLength(1);
    const lines = async (actor: Actor) =>
      (await s.invoke<ProposalView>(actor, 'proposals.get', { id: august.id })).effect!.lines;
    expect((await lines(agent)).filter((line) => line.account === '4382')).toEqual(claimed);
  });

  test('a payroll of one person shows its sick pay claimed only to who may read health data', async () => {
    const { s, hire, prepare, book } = await employer();
    const ana = await hire(['Popescu', 'Ana'], cnp('290050117002'), '5000');
    const run = await prepare('2026-10', sickLeave(ana.contractId, '2026-10'));
    const booked = await book(run);
    const claim = booked.effect!.lines.find((line) => line.account === '4382')!;
    const expense = booked.effect!.lines.find((line) => line.account === '641')!;
    expect(bani(claim.amount)).toBeGreaterThan(0);
    const folded = lei(bani(claim.amount) + bani(expense.amount));
    const agent = await agentOf(s, [...reads, 'questions.list']);
    const health = await agentOf(s, [...reads, 'questions.list', 'payroll.absences.list']);
    const costs = (lines: { account: string; amount: string | null; includes?: string[] }[]) =>
      lines
        .filter((line) => ['641', '4382'].includes(line.account))
        .map((line) => [line.account, line.amount, line.includes ?? null]);
    const journal = async (actor: Actor) =>
      (
        await s.invoke<{ entries: JournalEntry[] }>(actor, 'ledger.journal', {
          from: '2026-10-01',
          to: '2026-10-31',
        })
      ).entries[0]!.lines;
    const proposal = async (actor: Actor) =>
      (await s.invoke<ProposalView>(actor, 'proposals.get', { id: booked.id })).effect!.lines;
    const viaHttp = await agent.http<{ entries: JournalEntry[] }>('ledger.journal', {
      from: '2026-10-01',
      to: '2026-10-31',
    });
    for (const lines of [
      viaHttp.body.entries[0]!.lines,
      await journal(s.viewer),
      await proposal(agent),
      await proposal(s.viewer),
    ])
      expect(costs(lines)).toEqual([['641', folded, ['4382']]]);
    for (const lines of [await journal(s.owner), await journal(health), await proposal(health)])
      expect(costs(lines)).toEqual([
        ['641', expense.amount, null],
        ['4382', claim.amount, null],
      ]);
  });
});

describe('sick leave at rest', () => {
  // A run kept each certificate's series, number and indemnity code in clear, its issues named
  // them, and an answer about a month's absences said who was ill and with which code.
  test('the books keep a month’s sick leave sealed, and open it for who may read it', async () => {
    const { s, hire, prepare } = await employer();
    const ana = await hire(['Popescu', 'Ana'], cnp('290050117002'), '5000');
    const run = await prepare('2026-10', [
      {
        contractId: ana.contractId,
        sickLeave: [
          {
            series: 'CCMAM',
            number: '7',
            code: '02',
            issued: '2026-10-05',
            from: '2026-10-05',
            to: '2026-10-09',
          },
        ],
      },
    ]);
    const [line] = await s.db.read((tx) =>
      tx
        .select({ input: payrollLines.input, result: payrollLines.result })
        .from(payrollLines)
        .where(eq(payrollLines.runId, run.id)),
    );
    expect(await holds('CCMAM', line)).toBe(false);
    expect(JSON.parse(line!.result).issues).toEqual([
      { health: true, sealed: expect.stringMatching(/^v1\./) },
    ]);
    type Shown = { lines: { issues: { code: string; message: string }[] }[] };
    const issues = async (actor: Actor) =>
      (await s.invoke<Shown>(actor, 'payroll.runs.get', { runId: run.id })).lines[0]!.issues;
    expect((await issues(s.owner))[0]).toMatchObject({ code: 'SICK_ACCIDENT_UNCONFIRMED' });
    expect(await holds('CCMAM 7', await issues(s.owner))).toBe(true);
    expect((await issues(s.viewer)).map((issue) => issue.code)).toEqual(['HEALTH_REDACTED']);

    // The month's absences, as a person answered them.
    const certificate = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: 'certificat.txt',
      mediaType: 'text/plain',
      base64: Buffer.from('Certificat de concediu medical CCMAM 7').toString('base64'),
    });
    const absences = [
      {
        employeeId: ana.id,
        kind: 'medical',
        from: '2026-10-05',
        to: '2026-10-09',
        code: '02',
        certificateEvidenceId: certificate.id,
      },
    ];
    const asked = await s.invoke<{ id: string }>(s.owner, 'questions.ask', {
      kind: 'payroll.absences',
      subject: { kind: 'company', id: s.company.id },
      params: { month: '2026-10' },
    });
    const answered = await s.invoke<{ answer: { id: string; value: unknown } }>(
      s.owner,
      'questions.answer',
      { questionId: asked.id, value: { absences } },
    );
    expect(answered.answer.value).toEqual({ absences });
    const [kept] = await s.db.read((tx) =>
      tx
        .select({ value: questionAnswers.value })
        .from(questionAnswers)
        .where(eq(questionAnswers.id, answered.answer.id)),
    );
    expect(await holds(ana.id, kept)).toBe(false);
    expect(JSON.parse(kept!.value)).toEqual({
      absences: [{ certificateEvidenceId: certificate.id, sealed: expect.stringMatching(/^v1\./) }],
    });
    type Question = { id: string; answer: { value: unknown; redacted?: true } | null };
    const listed = async (actor: Actor) =>
      (await s.list<Question>(actor, 'questions.list', { kind: 'payroll.absences' })).find(
        (item) => item.id === asked.id,
      )!.answer;
    const reader = await agentOf(s, ['questions.list', 'evidence.read']);
    const health = await agentOf(s, ['questions.list', 'payroll.absences.list']);
    for (const actor of [reader, s.viewer])
      expect(await listed(actor)).toMatchObject({ value: null, redacted: true });
    for (const actor of [s.owner, health])
      expect((await listed(actor))!.value).toEqual({ absences });
    expect(
      await health.http<{ items: { absences: unknown[] }[] }>('payroll.absences.list', {
        month: '2026-10',
      }),
    ).toMatchObject({ status: 200, body: { items: [{ absences }] } });
    // The certificate is still the answer's: classified, and used.
    expect(
      (await reader.http('evidence.read', { id: certificate.id, mode: 'meta' })).body.error,
    ).toMatchObject({ code: 'EVIDENCE_CLASS' });
  });
});

describe('the documents of runs prepared before 5 November 2026', () => {
  // A run kept its benefits in kind without the documents they were valued from: no record
  // classified those, and the worklist listed them by name as files nobody read.
  test('a benefit’s document a run did not name stays payroll and personal data', async () => {
    const { s, hire, prepare } = await employer();
    const ana = await hire(['Popescu', 'Ana'], cnp('290050117002'), '5000');
    const policy = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: 'polita-popescu.txt',
      mediaType: 'text/plain',
      base64: Buffer.from('Poliță de asigurare de viață, asigurat Popescu Ana').toString('base64'),
    });
    const run = await prepare('2026-10', [
      {
        contractId: ana.contractId,
        benefits: [
          {
            kind: 'other',
            label: 'Asigurare de viață',
            value: '200.00',
            basis: 'Prima plătită de angajator',
            evidenceId: policy.id,
          },
        ],
      },
    ]);
    const agent = await agentOf(s, reads);
    const unused = async (actor: Actor) =>
      (await s.list<WorkItem>(actor, 'work.list', { kinds: ['evidence.unused'] })).find(
        (item) => item.subject.id === policy.id,
      );
    // A run naming them: the file is the payroll's, not a file nobody read.
    expect(await unused(s.owner)).toBeUndefined();
    // The run as it was kept before 5 November 2026.
    await s.db.client.execute('DROP TRIGGER inv_acc_payroll_lines_no_update');
    await s.db.client.execute({
      sql: `UPDATE acc_payroll_lines SET input_json = json_remove(input_json, '$.benefitEvidence')
        WHERE run_id = ?`,
      args: [run.id],
    });
    await s.db.migrate();
    const later = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: 'factura-ulterioara.txt',
      mediaType: 'text/plain',
      base64: Buffer.from('Factura F-9').toString('base64'),
    });
    const refused = await agent.http('evidence.read', { id: policy.id, mode: 'meta' });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({
      code: 'EVIDENCE_CLASS',
      details: { dataClasses: ['evidence', 'payroll', 'personal'], reason: 'grant' },
    });
    expect(
      (await s.refused(s.invoke(s.viewer, 'evidence.get', { id: policy.id })))?.details,
    ).toMatchObject({ reason: 'role' });
    expect(
      await holds('Popescu', s.invoke(s.owner, 'evidence.read', { id: policy.id, mode: 'text' })),
    ).toBe(true);
    // A file recorded after the run is not taken for one.
    expect((await agent.http('evidence.read', { id: later.id, mode: 'meta' })).status).toBe(200);
    // Listed as unused, it is listed without its name, and left to someone who may read it.
    for (const actor of [agent, s.viewer]) {
      const item = (await unused(actor))!;
      expect(await holds('polita', item)).toBe(false);
      expect(item.next.every((step) => !step.allowed)).toBe(true);
    }
    expect((await unused(s.owner))!.message).toContain('polita-popescu.txt');
  });
});

describe('the opening of a year after its close', () => {
  // years.opening's summing of the personnel accounts' items for agents was covered only by a
  // unit test of `differencesWithoutPersons`.
  test('the opening’s differences show the personnel accounts summed to who may not read pay', async () => {
    const s = await scenario({ clock: () => Date.parse('2027-02-20T10:00:00Z') });
    open.push(s);
    await s.invoke(s.owner, 'profile.record', {
      axis: 'entity.form',
      value: 'pfa',
      effectiveFrom: '2026-01-01',
      evidenceId: (await s.evidence('entity.form.pdf')).id,
    });
    await s.book(
      'ledger.general',
      journal(
        (await s.evidence('deschidere.pdf')).id,
        [
          { account: '5121', side: 'D', amount: '8000.00' },
          { account: '1012', side: 'C', amount: '8000.00' },
        ],
        { date: '2026-01-01', purpose: 'opening' },
      ),
    );
    const list = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: 'inventar.txt',
      mediaType: 'text/plain',
      base64: Buffer.from('Inventar 31.12.2026').toString('base64'),
    });
    await s.invoke(s.owner, 'documents.record', {
      evidenceId: list.id,
      kind: 'inventory.list',
      body: {
        title: 'Registrul-inventar 2026',
        company: { name: 'Pilot PFA', taxId: '12345678' },
        date: '2026-12-31',
        commission: { decision: '1', decisionDate: '2026-12-15', members: ['Popescu Ana'] },
        bank: [{ account: '5121', currency: 'RON', balance: '8000.00' }],
      },
    });
    for (let month = 1; month <= 12; month++)
      await s.closeApproved(`2026-${String(month).padStart(2, '0')}`);
    const close = await s.invoke<ActionView>(s.owner, 'years.close.request', {
      financialYearId: s.year.id,
    });
    await s.invoke(s.reviewer, 'actions.approve', { id: close.id, previewHash: close.previewHash });
    await s.invoke(s.reviewer, 'actions.execute', { id: close.id });
    const next = await s.invoke<{ id: string }>(s.owner, 'years.create', {
      kind: 'financial',
      label: '2027',
      from: '2027-01-01',
      to: '2027-12-31',
    });
    // The close recorded two employees' unpaid pay the books no longer hold, as if the closed
    // year had changed since.
    const people = await Promise.all(
      [
        ['Popescu Ana', '290050117002'],
        ['Ionescu Dan', '180010112345'],
      ].map(([name, code]) =>
        s.invoke<{ id: string }>(s.owner, 'parties.create', {
          kind: 'ro_individual',
          country: 'RO',
          taxId: cnp(code!),
          name,
        }),
      ),
    );
    const [row] = (
      await s.db.client.execute({
        sql: 'SELECT preview_json FROM acc_action_requests WHERE id = ?',
        args: [close.id],
      })
    ).rows;
    const preview = JSON.parse(String(row!.preview_json)) as {
      closing: { items: Record<string, string>[] };
    };
    preview.closing.items.push(
      ...people.map((party, index) => ({
        id: randomUUID(),
        account: '421',
        partyId: party.id,
        currency: 'RON',
        bani: String(-(300000 + index * 100000)),
        minor: String(-(300000 + index * 100000)),
      })),
    );
    await s.db.client.execute('DROP TRIGGER inv_acc_action_requests_no_update');
    await s.db.client.execute({
      sql: 'UPDATE acc_action_requests SET preview_json = ? WHERE id = ?',
      args: [canonical(preview), close.id],
    });
    await s.db.migrate();

    type Opening = {
      matches: boolean;
      differences: { section: string; id: string; closing: Record<string, string> | null }[];
    };
    const agent = await agentOf(s, reads);
    const summed = {
      section: 'items',
      id: '421/RON',
      closing: { account: '421', currency: 'RON', bani: '-700000', minor: '-700000' },
      opening: { account: '421', currency: 'RON', bani: '0', minor: '0' },
    };
    for (const opening of [
      (await agent.http<Opening>('years.opening', { financialYearId: next.id })).body,
      await s.invoke<Opening>(s.viewer, 'years.opening', { financialYearId: next.id }),
    ]) {
      expect(opening.matches).toBe(false);
      expect(opening.differences).toEqual([summed]);
    }
    const full = await s.invoke<Opening>(s.owner, 'years.opening', { financialYearId: next.id });
    expect(full.differences.map((item) => item.closing?.partyId).sort()).toEqual(
      people.map((party) => party.id).sort(),
    );
    const payroll = await agentOf(s, [...reads, 'questions.list']);
    expect(
      (await s.invoke<Opening>(payroll, 'years.opening', { financialYearId: next.id })).differences,
    ).toHaveLength(2);
  });
});
