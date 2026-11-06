import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { DeclarationValidator } from '../../source/engine/adapters/declaration-validator';
import { commands, spvMessages } from '../../source/engine/db/schema';
import type { ActionView } from '../../source/engine/kernel/actions';
import type { Actor } from '../../source/engine/kernel/commands';
import { differencesWithoutPersons } from '../../source/engine/kernel/personal';
import type { ProposalView } from '../../source/engine/kernel/views';
import { pdfDocument, show } from './fixtures/pdf';
import { journal, scenario, type Scenario } from './scenario';

// Personal data the engine returns (5 November 2026): health data (sick leave, its codes and
// certificates) as its own class, the views writes return, the identifiers registers show, an
// agent re-reading what it extracted, and what the sweep of every operation's classes found.
// No assertion prints a CNP or a diagnosis: each compares a boolean or a masked value.

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
const holds = async (text: string, read: Promise<unknown>) =>
  JSON.stringify(await read).includes(text);

/** An agent of the reviewer's (or another member's), granted these scopes. */
async function agentOf(s: Scenario, scopes: string[], issuer: Actor = s.reviewer) {
  const grant = await s.invoke<{ token: string; scopes: string[] }>(issuer, 'agents.issue', {
    name: 'Asistent',
    scopes,
    expiresAt: s.expiresIn(7),
  });
  return Object.assign(await s.engine.agents.authenticate(grant.token, s.company.id), {
    scopes: grant.scopes,
  });
}

type Question = {
  id: string;
  answer: { id: string; value: unknown; redacted?: true; evidenceId: string } | null;
};
type Run = {
  id: string;
  lines: { contractId: string; issues: { code: string; message: string }[] }[];
};
type Artifact = { id: string; state: string; steps: { state: string; detail: string | null }[] };

const personnel = <Row extends { account: string }>(rows: Row[]) =>
  rows.filter((row) => row.account.startsWith('42'));

/** An employer with a valid CUI, its seller details, ANAF as a partner, and ways to hire, run
 * and file the payroll of October 2026. */
async function employer(options: { validator?: DeclarationValidator } = {}) {
  const s = await scenario({
    cui: '18547290',
    ...(options.validator ? { declarationValidator: options.validator } : {}),
  });
  open.push(s);
  for (const [axis, value] of [
    ['employer', 'yes'],
    ['policy.payroll.employer_share', '635'],
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
  const prepare = (entries: unknown[] = []) =>
    s.invoke<Run>(s.owner, 'payroll.runs.prepare', { month: '2026-10', workingDays: 22, entries });
  const recognition = (run: Run) => ({
    runId: run.id,
    month: '2026-10',
    round: 1,
    authorityId: anaf.id,
  });
  const d112 = (actor: Actor = s.owner) =>
    s.invoke<Artifact>(actor, 'declarations.prepare', {
      kind: 'D112',
      period: '2026-10',
      options: {
        declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' },
        caen: '6201',
        phone: '0236000000',
      },
    });
  /** A month's absences asked by an agent and answered by the owner. */
  const absences = async (asker: Actor, value: unknown[]) => {
    const asked = await s.invoke<Question>(asker, 'questions.ask', {
      kind: 'payroll.absences',
      subject: { kind: 'company', id: s.company.id },
      params: { month: '2026-10' },
    });
    const answered = await s.invoke<Question>(s.owner, 'questions.answer', {
      questionId: asked.id,
      value: { absences: value },
    });
    return { asked, answered };
  };
  return { s, anaf, hire, prepare, recognition, d112, absences };
}

/** A medical certificate kept as evidence, as a text file an agent could read. */
const certificateFile = (s: Scenario, number: string) =>
  s.invoke<{ id: string }>(s.owner, 'evidence.record', {
    filename: `certificat-${number}.txt`,
    mediaType: 'text/plain',
    base64: Buffer.from(
      `Certificat de concediu medical CCMAM ${number}, cod indemnizație 08`,
    ).toString('base64'),
  });

describe('health data', () => {
  // questions.list declared payroll and personal, so a grant naming it (any review or reference
  // toolset) read a month's sick leave: who, when, the indemnity code and the certificate.
  test('a month’s sick leave reaches only who may read health data: answers, files, absences, events', async () => {
    const { s, hire, absences } = await employer();
    const ana = await hire(['Popescu', 'Ana'], cnp('290050117002'), '5000');
    const certificate = await certificateFile(s, '9');
    // A review and reference grant: it reads payroll and personal data (questions.list), and
    // asks the question itself.
    const review = await agentOf(s, ['toolset:review', 'toolset:reference', 'evidence.read']);
    const sick = [
      {
        employeeId: ana.id,
        kind: 'medical',
        from: '2026-10-05',
        to: '2026-10-09',
        code: '08',
        certificateEvidenceId: certificate.id,
      },
    ];
    const { asked, answered } = await absences(review, sick);
    // The person answering reads what they answered.
    expect(answered.answer!.value).toEqual({ absences: sick });

    const listed = async (actor: Actor) =>
      (await s.list<Question>(actor, 'questions.list', { kind: 'payroll.absences' }))[0]!;
    // Redacted: the question answered, without what was answered.
    for (const actor of [review, s.viewer])
      expect((await listed(actor)).answer).toEqual({
        ...answered.answer!,
        value: null,
        redacted: true,
      });
    expect((await listed(s.owner)).answer!.value).toEqual({ absences: sick });
    expect((await listed(s.reviewer)).answer!.value).toEqual({ absences: sick });
    // Asked again, the answer that holds comes back the same way.
    expect(
      await s.invoke(review, 'questions.ask', {
        kind: 'payroll.absences',
        subject: { kind: 'company', id: s.company.id },
        params: { month: '2026-10' },
      }),
    ).toMatchObject({ id: asked.id, reused: true, answer: { value: null, redacted: true } });

    // The certificate and the answer's own file are health data.
    for (const id of [certificate.id, answered.answer!.evidenceId]) {
      expect(
        await s.refused(s.invoke(review, 'evidence.read', { id, mode: 'text' })),
      ).toMatchObject({
        code: 'EVIDENCE_CLASS',
        details: {
          dataClasses: ['evidence', 'health', 'payroll', 'personal'],
          missing: ['health'],
          reason: 'grant',
        },
      });
      expect(await s.refused(s.invoke(s.viewer, 'evidence.get', { id }))).toMatchObject({
        code: 'EVIDENCE_CLASS',
        details: { missing: ['health', 'payroll', 'personal'], reason: 'role' },
      });
      expect(
        (await s.list<{ id: string }>(review, 'evidence.list')).find((item) => item.id === id),
      ).toMatchObject({ filename: null, redacted: true });
    }
    // The change feed names the answer and its file, never what it says.
    const feed = await s.invoke<{ items: { operation?: string; refs?: { kind: string }[] }[] }>(
      review,
      'events.since',
      { after: 0, limit: 500 },
    );
    const event = feed.items.find((item) => item.operation === 'questions.answer')!;
    expect(Object.keys(event).sort()).toEqual(['actor', 'at', 'hash', 'operation', 'refs', 'seq']);
    expect(event.refs!.map((ref) => ref.kind).sort()).toEqual(['evidence', 'question']);
    expect(await holds('CCMAM', Promise.resolve(feed))).toBe(false);

    // A grant naming the read of health data (payroll.absences.list) reads all of it.
    const health = await agentOf(s, [
      'toolset:review',
      'toolset:reference',
      'evidence.read',
      'payroll.absences.list',
    ]);
    expect((await listed(health)).answer!.value).toEqual({ absences: sick });
    expect(await s.invoke(health, 'payroll.absences.list', { month: '2026-10' })).toMatchObject({
      month: '2026-10',
      items: [{ questionId: asked.id, answerId: answered.answer!.id, absences: sick }],
    });
    expect(
      await holds(
        'CCMAM 9',
        s.invoke(health, 'evidence.read', { id: certificate.id, mode: 'text' }),
      ),
    ).toBe(true);
    // A viewer reads the absences without them; the review grant may not call it.
    expect(await s.invoke(s.viewer, 'payroll.absences.list', { month: '2026-10' })).toMatchObject({
      items: [{ questionId: asked.id, absences: null, redacted: true }],
    });
    expect(
      (await s.refused(s.invoke(review, 'payroll.absences.list', { month: '2026-10' })))?.code,
    ).toBe('AGENT_SCOPE');
  });

  test('no toolset grants health data: a grant names the operation, and earlier grants gain nothing', async () => {
    const { s } = await employer();
    const every = await agentOf(s, [
      'toolset:inbox',
      'toolset:bank',
      'toolset:books',
      'toolset:review',
      'toolset:close',
      'toolset:tax',
      'toolset:payroll',
      'toolset:admin',
      'toolset:reference',
    ]);
    const declaring = s.engine.operations
      .grantable()
      .filter((operation) => operation.dataClasses.includes('health'))
      .map((operation) => operation.id)
      .sort();
    expect(declaring).toEqual(['exports.get', 'exports.request', 'payroll.absences.list']);
    expect(every.scopes.filter((id) => declaring.includes(id))).toEqual([]);
    expect(every.scopes).toContain('questions.list');
    // Its reads cover payroll and personal data, not health.
    const covers = await s.db.read(async (tx) => s.engine.commands.readable(tx, every));
    expect([covers(['payroll', 'personal']), covers(['health'])]).toEqual([true, false]);
    // Named, it is granted; its contract says what it reads.
    const named = await agentOf(s, ['payroll.absences.list']);
    expect(
      await s.invoke(named, 'capabilities.describe', { id: 'payroll.absences.list' }),
    ).toMatchObject({ dataClasses: ['payroll', 'personal', 'health'], risk: 'medium' });
  });

  // payroll.runs.get showed a viewer each certificate's issue with its code (a work accident);
  // declarations.prepare told any agent preparing D112 which employee's certificate failed; and
  // ANAF's validator may quote a diagnosis in the return's steps.
  test('a payroll run and D112 show a certificate only to who may read health data', async () => {
    const validator: DeclarationValidator = {
      id: 'validator de test',
      validate: async () => ({ ok: false, messages: ['E: cod de diagnostic D_23 = 101 invalid.'] }),
      pdf: async () => ({ ok: false, messages: [] }),
    };
    const { s, hire, prepare, recognition, d112 } = await employer({ validator });
    const ana = await hire(['Popescu', 'Ana'], cnp('290050117002'), '5000');
    const accident = await prepare([
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
    const issues = async (actor: Actor) =>
      (await s.invoke<Run>(actor, 'payroll.runs.get', { runId: accident.id })).lines[0]!.issues;
    expect((await issues(s.owner)).map((issue) => issue.code)).toContain(
      'SICK_ACCIDENT_UNCONFIRMED',
    );
    expect(await holds('CCMAM 7', issues(s.owner))).toBe(true);
    const seen = await issues(s.viewer);
    expect(seen.map((issue) => issue.code)).toContain('HEALTH_REDACTED');
    expect(seen.some((issue) => issue.code.startsWith('SICK_'))).toBe(false);
    expect(await holds('CCMAM', Promise.resolve(seen))).toBe(false);
    expect(await holds('CCMAM', s.invoke(s.viewer, 'payroll.runs.list'))).toBe(false);
    expect(await holds('CCMAM 7', s.invoke(s.owner, 'payroll.runs.list'))).toBe(true);

    // A certificate without where it was prescribed and its diagnosis stops D112.
    const certificate = {
      series: 'CCMAM',
      number: '9',
      code: '01',
      issued: '2026-10-05',
      from: '2026-10-05',
      to: '2026-10-09',
    };
    const run = await prepare([
      {
        contractId: ana.contractId,
        sickLeave: [certificate],
        sickBase: { income: '24300', days: 121 },
      },
    ]);
    await s.book('payroll.recognize', recognition(run));
    const tax = await agentOf(s, ['toolset:tax', 'toolset:reference']);
    const refusal = (await s.refused(d112(tax)))!;
    expect(refusal.code).toBe('D112_SICK_CERTIFICATE');
    expect(refusal.details).toMatchObject({
      problems: [{ code: 'D112_SICK_CERTIFICATE', health: true }],
    });
    expect(await holds('CCMAM', Promise.resolve(refusal))).toBe(false);
    expect(await holds('Popescu', Promise.resolve(refusal))).toBe(false);
    const full = (await s.refused(d112(s.owner)))!;
    expect(await holds('CCMAM 9', Promise.resolve(full))).toBe(true);
  });

  test('ANAF’s validator messages on a D112 reach only who may read health data', async () => {
    const validator: DeclarationValidator = {
      id: 'validator de test',
      validate: async () => ({ ok: false, messages: ['E: cod de diagnostic D_23 = 101 invalid.'] }),
      pdf: async () => ({ ok: false, messages: [] }),
    };
    const { s, hire, prepare, recognition, d112 } = await employer({ validator });
    const ana = await hire(['Popescu', 'Ana'], cnp('290050117002'), '5000');
    const run = await prepare([
      {
        contractId: ana.contractId,
        sickLeave: [
          {
            series: 'CCMAM',
            number: '9',
            code: '01',
            issued: '2026-10-05',
            from: '2026-10-05',
            to: '2026-10-09',
            place: 'family_doctor',
            diagnosis: '101',
          },
        ],
        sickBase: { income: '24300', days: 121 },
      },
    ]);
    await s.book('payroll.recognize', recognition(run));
    const prepared = await d112();
    expect(prepared.state).toBe('validation_failed');
    const failed = (artifact: Artifact) =>
      artifact.steps.find((step) => step.state === 'validation_failed')!.detail;
    expect(failed(prepared)).toContain('D_23');
    const tax = await agentOf(s, ['toolset:tax', 'toolset:reference']);
    const list = async (actor: Actor) =>
      (await s.list<Artifact>(actor, 'declarations.list')).find((item) => item.id === prepared.id)!;
    for (const actor of [tax, s.viewer]) {
      const shown = await list(actor);
      expect(failed(shown)).toContain('date de sănătate');
      expect(failed(shown)).not.toContain('D_23');
      // The engine's own summary stays.
      expect(JSON.parse(shown.steps[0]!.detail!)).toMatchObject({ month: '2026-10', insured: 1 });
    }
    expect(failed(await list(s.reviewer))).toContain('D_23');
    const health = await agentOf(s, ['toolset:tax', 'toolset:reference', 'payroll.absences.list']);
    expect(failed(await list(health))).toContain('D_23');
  });

  // The documents a run's benefits in kind were valued from were named only in the run's input,
  // which the engine did not keep: any agent granted evidence.read read them.
  test('the documents of a run’s benefits in kind are payroll and personal data', async () => {
    const { s, hire, prepare } = await employer();
    const ana = await hire(['Popescu', 'Ana'], cnp('290050117002'), '5000');
    const policy = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: 'polita-popescu.txt',
      mediaType: 'text/plain',
      base64: Buffer.from('Poliță de asigurare de viață, asigurat Popescu Ana').toString('base64'),
    });
    const agent = await agentOf(s, ['evidence.read', 'evidence.list']);
    expect(
      (await s.invoke<{ format: string }>(agent, 'evidence.read', { id: policy.id, mode: 'meta' }))
        .format,
    ).toBe('text');
    await prepare([
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
    expect(
      await s.refused(s.invoke(agent, 'evidence.read', { id: policy.id, mode: 'meta' })),
    ).toMatchObject({
      code: 'EVIDENCE_CLASS',
      details: { dataClasses: ['evidence', 'payroll', 'personal'], reason: 'grant' },
    });
    const payroll = await agentOf(s, ['evidence.read', 'questions.list']);
    expect(
      (
        await s.invoke<{ format: string }>(payroll, 'evidence.read', {
          id: policy.id,
          mode: 'meta',
        })
      ).format,
    ).toBe('text');
  });
});

describe('the views writes return', () => {
  // `.propose`, `.revise` and `ledger.post` returned the proposal as stored: each employee's pay
  // on 421 to an agent whose reads proposals.get would have summed; a retry returned the stored
  // result as it was.
  test('an agent reads what its commands return as proposals.get shows it, on a retry too', async () => {
    const { s, hire, prepare, recognition, absences } = await employer();
    const ana = await hire(['Popescu', 'Ana'], cnp('290050112345'), '4325');
    await hire(['Ionescu', 'Dan'], cnp('180010112345'), '6000');
    const run = await prepare();
    // Its grant names no read of payroll or personal data.
    const agent = await agentOf(s, [
      'payroll.recognize.propose',
      'payroll.recognize.revise',
      'ledger.post',
      'years.close.request',
    ]);
    const key = randomUUID();
    const proposed = await s.invoke<ProposalView>(
      agent,
      'payroll.recognize.propose',
      recognition(run),
      key,
    );
    const summed = (view: ProposalView) => {
      expect(view.redacted).toBe(true);
      expect(view.basis).toBeNull();
      expect(personnel(view.effect!.lines).some((line) => line.partyId)).toBe(false);
      expect(personnel(view.effect!.lines)).toHaveLength(2);
      expect(view.effect!.openItems.filter((item) => item.controlAccount === '421')).toEqual([]);
    };
    summed(proposed);
    // The retry reads the same, while the command keeps its own result: the redaction is at the
    // reading.
    expect(
      await s.invoke<ProposalView>(agent, 'payroll.recognize.propose', recognition(run), key),
    ).toEqual(proposed);
    const [stored] = await s.db.read((tx) =>
      tx
        .select({ result: commands.result })
        .from(commands)
        .where(
          and(
            eq(commands.companyId, s.company.id),
            eq(commands.key, `agent/${agent.agentId}/${key}`),
          ),
        ),
    );
    expect(
      personnel((stored!.result as ProposalView).effect!.lines).filter((line) => line.partyId),
    ).toHaveLength(4);
    // A person reads it whole; a viewer may not write.
    const full = await s.invoke<ProposalView>(s.owner, 'proposals.get', { id: proposed.id });
    expect(personnel(full.effect!.lines).filter((line) => line.partyId)).toHaveLength(4);
    expect(
      (await s.refused(s.invoke(s.viewer, 'payroll.recognize.propose', recognition(run))))?.code,
    ).toBe('FORBIDDEN');

    // A revision citing the month's sick leave: its basis keeps the answer's place for a caller
    // who may not read health data.
    const certificate = await certificateFile(s, '11');
    const sick = [
      {
        employeeId: ana.id,
        kind: 'medical',
        from: '2026-10-05',
        to: '2026-10-09',
        code: '08',
        certificateEvidenceId: certificate.id,
      },
    ];
    const { asked } = await absences(s.owner, sick);
    const revised = await s.invoke<ProposalView>(s.owner, 'payroll.recognize.revise', {
      proposalId: proposed.id,
      version: proposed.version,
      input: recognition(run),
      basis: { answers: [asked.id] },
    });
    expect(revised.basis!.answers[0]!.value).toEqual({ absences: sick });
    const payroll = await agentOf(s, ['proposals.get', 'questions.list']);
    const health = await agentOf(s, ['proposals.get', 'questions.list', 'payroll.absences.list']);
    for (const actor of [payroll, s.viewer])
      expect(
        (await s.invoke<ProposalView>(actor, 'proposals.get', { id: proposed.id })).basis!
          .answers[0],
      ).toMatchObject({
        questionId: asked.id,
        kind: 'payroll.absences',
        value: null,
        redacted: true,
      });
    for (const actor of [health, s.owner])
      expect(
        (await s.invoke<ProposalView>(actor, 'proposals.get', { id: proposed.id })).basis!
          .answers[0]!.value,
      ).toEqual({ absences: sick });

    // Posted by the agent once a person approved it: the posted view is redacted the same way.
    const posted = await s.invoke<ProposalView>(agent, 'ledger.post', {
      proposalId: revised.id,
      version: revised.version,
      effectHash: (await s.approve(revised)).effectHash,
    });
    expect(posted.status).toBe('posted');
    summed(posted);

    // A reviewed action the agent requests: the year close's snapshot sums the unpaid pay.
    const request = await s.invoke<ActionView>(agent, 'years.close.request', {
      financialYearId: s.year.id,
    });
    type Closing = { closing: { items: { account: string; partyId?: string }[] } };
    expect(
      personnel((request.preview as unknown as Closing).closing.items).some((item) => item.partyId),
    ).toBe(false);
    const whole = await s.invoke<ActionView>(s.owner, 'actions.get', { id: request.id });
    expect(
      personnel((whole.preview as unknown as Closing).closing.items).filter((item) => item.partyId),
    ).toHaveLength(2);
  });
});

describe('re-reading an extraction', () => {
  // An agent read a supplier's PDF, recorded the invoice it read, and could not read the PDF
  // again: the document named an individual by CNP, so the file became personal. It was refused
  // without saying why.
  test('an agent whose grant covers personal data reads its extraction again; another is told why not', async () => {
    const s = await scenario({ cui: '12345674' });
    open.push(s);
    const code = cnp('180010112345');
    const inbox = await agentOf(s, ['toolset:inbox']);
    const wide = await agentOf(s, ['toolset:inbox', 'toolset:reference']);
    const extract = async (agent: Actor, number: string) => {
      const pdf = pdfDocument([
        {
          content: [
            show(72, 780, 'FACTURĂ', 14),
            show(72, 750, `Seria AF nr. ${number} din 05.10.2026`),
            show(72, 730, `Furnizor: Ion Popescu, CNP ${code}`),
            show(72, 710, 'Client: Pilot SRL, CUI: RO12345674'),
            show(72, 680, 'Total de plată: 500,00 lei'),
          ].join('\n'),
        },
      ]);
      const { id } = await s.invoke<{ id: string }>(agent, 'evidence.record', {
        filename: `AF-${number}.pdf`,
        mediaType: 'application/pdf',
        base64: Buffer.from(pdf).toString('base64'),
      });
      const read = () => s.invoke(agent, 'evidence.read', { id, mode: 'text' });
      expect(await holds(code, read())).toBe(true);
      await s.invoke(agent, 'documents.record', {
        evidenceId: id,
        kind: 'invoice.received',
        body: {
          number: `AF ${number}`,
          issueDate: '2026-10-05',
          currency: 'RON',
          supplier: { name: 'Ion Popescu', taxId: code, country: 'RO' },
          customer: { name: 'Pilot SRL', taxId: 'RO12345674', country: 'RO' },
          lines: [
            { description: 'Bunuri second-hand', net: '500.00', vatCategory: 'O', vatRate: '0' },
          ],
          taxes: [{ base: '500.00', tax: '0.00', category: 'O', rate: '0' }],
          totals: { net: '500.00', tax: '0.00', gross: '500.00' },
        },
        citations: {
          number: { page: 1, line: 2, text: `AF nr. ${number}` },
          'supplier.taxId': { page: 1, line: 3, text: code },
          'totals.gross': { page: 1, line: 5, text: '500,00' },
        },
      });
      return { id, read };
    };
    const narrow = await extract(inbox, '1');
    const refusal = (await s.refused(narrow.read()))!;
    expect(refusal).toMatchObject({
      code: 'EVIDENCE_CLASS',
      details: { dataClasses: ['evidence', 'personal'], missing: ['personal'], reason: 'grant' },
    });
    expect(refusal.message).toContain('date personale');
    expect(refusal.message).toContain('permisiunea acestui agent');
    expect(await holds(code, Promise.resolve(refusal))).toBe(false);
    // Its grant covers personal data (toolset:reference names questions.list): it reads it.
    const covered = await extract(wide, '2');
    expect(await holds(code, covered.read())).toBe(true);
    // A viewer is refused by its role; the owner reads both.
    expect(await s.refused(s.invoke(s.viewer, 'evidence.get', { id: covered.id }))).toMatchObject({
      code: 'EVIDENCE_CLASS',
      details: { missing: ['personal'], reason: 'role' },
    });
    expect(
      await holds(code, s.invoke(s.owner, 'evidence.read', { id: narrow.id, mode: 'text' })),
    ).toBe(true);
  });
});

describe('what the sweep of operations found', () => {
  // parties.get gave an individual's address and contact to any agent and a CNP in the details
  // to a viewer; only the identifier was masked, for agents.
  test('an individual’s details reach only who may read personal data', async () => {
    const s = await scenario();
    open.push(s);
    const person = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
      kind: 'ro_individual',
      country: 'RO',
      name: 'Maria Ionescu',
    });
    await s.invoke(s.owner, 'parties.recordDetails', {
      partyId: person.id,
      details: {
        name: 'Maria Ionescu',
        address: {
          lines: ['Str. Domnească 7'],
          city: 'Galați',
          subdivision: 'RO-GL',
          country: 'RO',
        },
        contact: { email: 'maria@example.test', phone: '0722000000' },
      },
    });
    const get = (actor: Actor) =>
      s.invoke<{ name: string; details: unknown; redacted?: true }>(actor, 'parties.get', {
        partyId: person.id,
      });
    const agent = await agentOf(s, ['parties.get']);
    for (const actor of [agent, s.viewer])
      expect(await get(actor)).toMatchObject({
        name: 'Maria Ionescu',
        details: null,
        redacted: true,
      });
    expect(await holds('Domnească', get(s.owner))).toBe(true);
    // An agent whose reads cover personal data reads them.
    const wide = await agentOf(s, ['parties.get', 'questions.list']);
    expect(await holds('Domnească', get(wide))).toBe(true);
  });

  // An SPV copy of a B2C sale that differed from the books quoted both buyers' CNPs in the
  // message, shown to every agent and viewer by spv.messages and the worklist.
  test('ANAF’s messages and the worklist show no CNP to who may not read it', async () => {
    const s = await scenario();
    open.push(s);
    const code = cnp('290050117002');
    await s.db.write((tx) =>
      tx.insert(spvMessages).values({
        companyId: s.company.id,
        id: '4000000001',
        uploadId: '5000000001',
        kind: 'sent',
        createdAtAnaf: Date.parse('2026-10-20T10:00:00Z'),
        details: 'Factura XF0001',
        outcome: 'differs',
        detail: `client: "${code}" în registre, "*************" în SPV`,
        createdBy: s.owner.actorId,
      }),
    );
    const agent = await agentOf(s, ['spv.messages', 'work.list']);
    const messages = (actor: Actor) => s.list(actor, 'spv.messages');
    const work = (actor: Actor) => s.list(actor, 'work.list', { kinds: ['spv.message'] });
    for (const actor of [agent, s.viewer]) {
      expect(await holds(code, messages(actor))).toBe(false);
      expect(await holds(code, work(actor))).toBe(false);
      expect(await holds('client: \\"*************\\" în registre', messages(actor))).toBe(true);
    }
    expect(await holds(code, messages(s.owner))).toBe(true);
    expect(await holds(code, work(s.owner))).toBe(true);
  });

  // pfa.inventory listed each employee's unpaid pay by name, as ledger.inventoryRegister did
  // before it summed them.
  test('a PFA’s inventory shows an agent the personnel accounts without the person', async () => {
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
        (await s.evidence('stat.pdf')).id,
        [
          { account: '641', side: 'D', amount: '3000.00' },
          { account: '421', side: 'C', amount: '3000.00', newItem: 'ana' },
        ],
        { date: '2026-10-31', newItems: [{ ref: 'ana', partyId: employee.id }] },
      ),
    );
    type Inventory = {
      sections: { title: string; rows: { description: string; value: string }[] }[];
    };
    const debts = async (actor: Actor) =>
      (
        await s.invoke<Inventory>(actor, 'pfa.inventory', { occasion: 'year_end', year: 2026 })
      ).sections
        .find((section) => section.title === 'Datorii')!
        .rows.map((row) => `${row.description}: ${row.value}`);
    expect(await debts(s.owner)).toContain('421 Popescu Ana: 3000.00');
    const agent = await agentOf(s, ['pfa.inventory']);
    const shown = await debts(agent);
    expect(shown.some((row) => row.includes('Popescu'))).toBe(false);
    expect(shown.filter((row) => row.startsWith('421 ') && row.endsWith(': 3000.00'))).toHaveLength(
      1,
    );
  });

  // years.opening returned the differences between a closed year's snapshot and its books item
  // by item, an employee's unpaid pay among them (SnapshotDifference, section items).
  test('the opening’s differences show an agent the personnel accounts summed', () => {
    const item = (id: string, account: string, partyId: string, bani: string) => ({
      id,
      account,
      partyId,
      currency: 'RON',
      bani,
      minor: bani,
    });
    expect(
      differencesWithoutPersons([
        { section: 'accounts', id: '421/RON', closing: { bani: '-5000' }, opening: null },
        { section: 'items', id: 'a', closing: item('a', '421', 'ana', '-300000'), opening: null },
        {
          section: 'items',
          id: 'b',
          closing: item('b', '421', 'dan', '-200000'),
          opening: item('b', '421', 'dan', '-100000'),
        },
        {
          section: 'items',
          id: 'c',
          closing: item('c', '401', 'furnizor', '-5000'),
          opening: null,
        },
      ]),
    ).toEqual([
      { section: 'accounts', id: '421/RON', closing: { bani: '-5000' }, opening: null },
      {
        section: 'items',
        id: '421/RON',
        closing: { account: '421', currency: 'RON', bani: '-500000', minor: '-500000' },
        opening: { account: '421', currency: 'RON', bani: '-100000', minor: '-100000' },
      },
      { section: 'items', id: 'c', closing: item('c', '401', 'furnizor', '-5000'), opening: null },
    ]);
  });
});
