import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { questionKindIds } from 'xfactura-core/questions/kinds';
import { agent } from 'xfactura-core/ro/profit';
import { DukIntegrator } from '../../source/engine/adapters/declaration-validator';
import { workKinds } from '../../source/engine/kernel/work';
import type { Actor } from '../../source/engine/kernel/commands';
import type { ProposalView } from '../../source/engine/kernel/views';
import { journal, scenario, type Scenario } from './scenario';

/*
 * The profit tax end to end (P1) and the micro ↔ profit transitions (P2), synthetic: amounts by
 * hand from Codul fiscal title II, the returns through ANAF's validators when DUKIntegrator and
 * Java are installed (skipped otherwise, never passed).
 */

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

const dist = path.join(import.meta.dir, '../../../..', '.validators/anaf/dist');
const available = DukIntegrator.available(dist) && Bun.which('java') !== null;

const bnr = (date: string, rate: string) => `<?xml version="1.0" encoding="utf-8"?>
<DataSet xmlns="http://www.bnr.ro/xsd"><Header><Publisher>National Bank of Romania</Publisher><PublishingDate>${date}</PublishingDate><MessageType>DR</MessageType></Header>
<Body><Subject>Reference rates</Subject><OrigCurrency>RON</OrigCurrency>
<Cube date="${date}"><Rate currency="EUR">${rate}</Rate></Cube>
</Body></DataSet>`;

type Question = { id: string; status: string };
type Declaration = { id: string; state: string; steps: { detail: string | null }[] };
const declarant = { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' };

async function company(facts: Record<string, [string, string][]>) {
  // The engine's day: mid-December 2026, so the worklist reads the year under profit tax.
  const s = await scenario({
    cui: '18547290',
    clock: () => Date.parse('2026-12-15T10:00:00Z'),
    ...(available ? { declarationValidator: new DukIntegrator(dist) } : {}),
  });
  open.push(s);
  for (const [axis, values] of Object.entries(facts))
    for (const [value, effectiveFrom] of values)
      await s.invoke(s.owner, 'profile.record', {
        axis,
        value,
        effectiveFrom,
        evidenceId: (await s.evidence(`${axis}.pdf`)).id,
      });
  for (const [date, rate] of [
    ['2025-12-31', '5.0800'],
    ['2026-03-31', '5.0900'],
    ['2026-06-30', '5.0900'],
    ['2026-09-30', '5.0900'],
    ['2026-12-31', '5.0900'],
  ] as const) {
    const { id } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: `bnr-${date}.xml`,
      mediaType: 'application/xml',
      base64: Buffer.from(bnr(date, rate)).toString('base64'),
    });
    await s.invoke(s.owner, 'fx.importBnr', { evidenceId: id });
  }
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
  /** A cash note: revenue or expense against the bank, on a day. */
  const note = async (date: string, account: string, amount: string) => {
    const revenue = account.startsWith('7');
    return s.book(
      'ledger.general',
      journal(
        (await s.evidence('nota.pdf')).id,
        [
          { account: revenue ? '5121' : account, side: 'D', amount },
          { account: revenue ? account : '5121', side: 'C', amount },
        ],
        { date },
      ),
    );
  };
  const acks = (proposal: ProposalView) =>
    proposal.issues.filter((issue) => issue.severity === 'ack').map((issue) => issue.code);
  const post = async (proposal: ProposalView) =>
    s.post(await s.approve(proposal, s.reviewer, acks(proposal)));
  /** Asks what a blocked proposal's issue names, answers it as the owner, returns the question. */
  const answerIssue = async (
    proposal: ProposalView,
    code: string,
    value: unknown,
    about?: string,
  ) => {
    const issue = proposal.issues.find(
      (item) =>
        item.code === code &&
        (about === undefined ||
          (item.details as { question: { subject: { id: string } } }).question.subject.id ===
            about),
    )!;
    const question = (issue.details as { question: Record<string, unknown> }).question;
    const asked = await s.invoke<Question>(s.owner, 'questions.ask', question);
    await s.invoke(s.owner, 'questions.answer', { questionId: asked.id, value });
    return asked.id;
  };
  const prepare = (kind: string, period: string, options: Record<string, unknown>) =>
    s.invoke<Declaration>(s.owner, 'declarations.prepare', {
      kind,
      period,
      options: { declarant, ...options },
    });
  return { s, anaf, note, post, acks, answerIssue, prepare };
}

const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`) ?? [];
const codes = (proposal: ProposalView) => proposal.issues.map((issue) => issue.code);
const position = (proposal: ProposalView) =>
  (proposal.effect?.explanation.details as { position: { rows: Record<string, string> } }).position;
const rowsOf = (proposal: ProposalView, ...names: string[]) =>
  names.map((name) => position(proposal).rows[name]);

async function work(s: Scenario, actor: Actor, kinds: string[]) {
  return s.list<{ kind: string; subject: { id: string }; next: { operation: string }[] }>(
    actor,
    'work.list',
    { kinds },
  );
}

describe('the module is agent-ready', () => {
  test('its detectors are worklist kinds, its questions question kinds, its steps operations', async () => {
    const { s } = await company({});
    for (const detector of agent.detectors) {
      expect(workKinds).toContain(detector.kind);
      for (const step of detector.next)
        expect(s.engine.operations.find(step.operation)).toBeDefined();
    }
    for (const question of agent.questions) expect(questionKindIds).toContain(question.kind);
    expect(s.engine.operations.find('tax.profit.propose')?.toolset).toBe('tax');
    expect(agent.templates).toEqual([]);
  });
});

describe('profit tax (P1)', () => {
  test('a year under the quarterly system: questions, fiscal depreciation, D100 and D101', async () => {
    const { s, anaf, note, post, answerIssue, prepare } = await company({
      'entity.form': [['srl', '2020-01-01']],
      'vat.status': [['non_vat', '2020-01-01']],
      income_tax: [['profit', '2026-01-01']],
      'profit.system': [['quarterly', '2026-01-01']],
    });
    await note('2026-02-10', '704', '50000.00');
    await note('2026-02-15', '628', '20000.00');
    await note('2026-03-05', '623', '1000.00');
    const input = (period: string, date: string, extra: Record<string, unknown> = {}) => ({
      period,
      date,
      authorityId: anaf.id,
      ...extra,
    });

    // The worklist names the account to classify before anyone proposes.
    const items = await work(s, s.owner, ['profit.unclassified']);
    expect(items.map((item) => item.subject.id)).toEqual(['623/2026']);

    // Q1: the protocol account and the losses carried in are asked, never guessed.
    let q1 = await s.propose('tax.profit', input('2026-Q1', '2026-03-31'));
    expect(codes(q1)).toEqual(expect.arrayContaining(['PROFIT_CLASSIFICATION', 'PROFIT_LOSSES']));
    const evidence = (await s.evidence('analiza-623.pdf')).id;
    const protocol = await answerIssue(q1, 'PROFIT_CLASSIFICATION', {
      nature: 'protocol',
      evidenceIds: [evidence],
    });
    const losses = await answerIssue(q1, 'PROFIT_LOSSES', {
      vintages: [],
      evidenceIds: [(await s.evidence('d101-2025.pdf')).id],
    });
    q1 = await s.invoke<ProposalView>(s.owner, 'tax.profit.revise', {
      proposalId: q1.id,
      version: q1.version,
      input: input('2026-Q1', '2026-03-31'),
      basis: { answers: [protocol, losses] },
    });
    // 50,000 − 21,000 = 29,000; protocol limit 2% × 30,000 = 600, 400 over; 29,400 × 16% = 4,704.
    expect(rowsOf(q1, 'P7', 'P26', 'P40', 'P41')).toEqual(['29000', '400', '29400', '4704']);
    expect(lines(q1)).toEqual(['D 691 4704.00', 'C 4411 4704.00']);
    expect(codes(q1)).toEqual(['PROFIT_MINIMUM_TAX']);
    await post(q1);
    expect(await work(s, s.owner, ['profit.unclassified'])).toEqual([]);

    // A fixed asset put into use in November: degressive fiscally, linear in the books.
    const { id: assetId } = await s.invoke<{ id: string }>(s.owner, 'assets.register', {
      number: 'MF-1',
      name: 'Server',
      catalogCode: '2.2.9',
      account: '214',
      depreciationAccount: '2814',
      expenseAccount: '6811',
      value: '6000.00',
      lifeMonths: 36,
      fiscalLifeMonths: 36,
      commissionedOn: '2026-11-20',
      evidenceId: (await s.evidence('pv-mf1.pdf')).id,
    });
    expect(
      (await work(s, s.owner, ['asset.fiscalMissing'])).map((item) => item.next[0]!.operation),
    ).toEqual(['assets.recordFiscal']);
    await s.invoke(s.owner, 'assets.recordFiscal', {
      assetId,
      method: 'degressive',
      value: '6000.00',
      m1: false,
      evidenceId: (await s.evidence('fisa-mf1.pdf')).id,
    });
    await s.book('assets.depreciate', { month: '2026-12' });
    await note('2026-10-10', '704', '30000.00');
    await note('2026-11-12', '6581', '500.00');
    let year = await s.propose('tax.profit', input('2026', '2026-12-31'));
    expect(codes(year)).toContain('PROFIT_CLASSIFICATION');
    const fine = await answerIssue(
      year,
      'PROFIT_CLASSIFICATION',
      { nature: 'fine', evidenceIds: [(await s.evidence('pv-amenda.pdf')).id] },
      '6581',
    );
    year = await s.invoke<ProposalView>(s.owner, 'tax.profit.revise', {
      proposalId: year.id,
      version: year.version,
      input: input('2026', '2026-12-31'),
      basis: { answers: [protocol, losses, fine] },
    });
    // Revenue 80,000; expenses 21,000 + 500 + 166.67 depreciation + 4,704 tax. For the year the
    // protocol is within 2% × (53,629.33 + 4,704 + 1,000) = 1,186.67: nothing over. Added back:
    // the fine 500 and the book depreciation 167; deducted: the fiscal depreciation 250
    // (degressive, 6,000 × 1.5 / 3 years, a twelfth for December).
    expect(rowsOf(year, 'P26', 'P25', 'P28', 'P11', 'P40')).toEqual([
      '0',
      '500',
      '167',
      '250',
      '58750',
    ]);
    // 58,750 × 16% = 9,400 for the year, 4,704 declared: 4,696 for the year.
    expect(rowsOf(year, 'P48', 'P50', 'P52')).toEqual(['9400', '4704', '4696']);
    expect(lines(year)).toEqual(['D 691 4696.00', 'C 4411 4696.00']);
    await post(year);

    const register = await s.invoke<{ items: { explanation: string; entries: unknown[] }[] }>(
      s.owner,
      'profit.register',
      { year: 2026 },
    );
    expect(register.items.some((item) => item.explanation.includes('cont 6581'))).toBe(true);
    expect(
      register.items.find((item) => item.explanation.includes('cont 6581'))!.entries,
    ).toHaveLength(1);
    const vintages = await s.list<{ year: number; after: unknown[] }>(s.owner, 'profit.losses', {
      year: 2026,
    });
    expect(vintages).toEqual([expect.objectContaining({ year: 2026, after: [] })]);

    // The returns: D100 for March with the profit tax (103), D101 for the year.
    if (available) {
      const d100 = await prepare('D100', '2026-03', {});
      expect([d100.state, JSON.parse(d100.steps[0]!.detail!).obligations]).toEqual([
        'validated_official',
        ['profit'],
      ]);
      const d101 = await prepare('D101', '2026', { caen: '6201' });
      expect(d101.state).toBe('validated_official');
      expect(JSON.parse(d101.steps[0]!.detail!)).toMatchObject({
        tax: '9400',
        declared: '4704',
        payable: '4696',
      });
    }
    const calendar = await s.invoke<{
      items: { kind: string; period: string; due: string | null }[];
    }>(s.owner, 'obligations.calendar', { from: '2026-03', to: '2026-12' });
    expect(calendar.items.filter((item) => item.kind === 'D101' || item.kind === 'D100')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'D100', period: '2026-03', due: '2026-04-27' }),
        expect.objectContaining({ kind: 'D101', period: '2026', due: '2027-06-25' }),
      ]),
    );
  }, 180_000);
});

describe('micro ↔ profit (P2)', () => {
  test('leaving micro in Q3: micro D100 for Q1–Q2, profit tax from 1 July, a partial D101 and its D700', async () => {
    const { s, anaf, note, post, answerIssue, prepare } = await company({
      'entity.form': [['srl', '2020-01-01']],
      'vat.status': [['non_vat', '2020-01-01']],
      employer: [['yes', '2020-01-01']],
      income_tax: [
        ['micro', '2026-01-01'],
        ['profit', '2026-07-01'],
      ],
    });
    await note('2026-02-10', '704', '120000.00');
    await note('2026-05-10', '704', '200000.00');
    await note('2026-08-10', '704', '300000.00');
    await note('2026-08-20', '628', '100000.00');
    const micro = async (quarter: string, date: string) => {
      const proposal = await s.propose('tax.micro', { quarter, date, authorityId: anaf.id });
      return post(proposal);
    };
    expect(lines(await micro('2026-Q1', '2026-03-31'))).toEqual([
      'D 698 1200.00',
      'C 4418 1200.00',
    ]);
    expect(lines(await micro('2026-Q2', '2026-06-30'))).toEqual([
      'D 698 2000.00',
      'C 4418 2000.00',
    ]);
    // Q3 is no longer micro: its revenue crossed 100,000 € (508,000 lei at 5.0800).
    const refused = await s.propose('tax.micro', {
      quarter: '2026-Q3',
      date: '2026-09-30',
      authorityId: anaf.id,
    });
    expect(codes(refused)).toContain('NOT_MICRO');

    let q3 = await s.propose('tax.profit', {
      period: '2026-Q3',
      date: '2026-09-30',
      authorityId: anaf.id,
    });
    const losses = await answerIssue(q3, 'PROFIT_LOSSES', {
      vintages: [],
      evidenceIds: [(await s.evidence('d101-2025.pdf')).id],
    });
    q3 = await s.invoke<ProposalView>(s.owner, 'tax.profit.revise', {
      proposalId: q3.id,
      version: q3.version,
      input: { period: '2026-Q3', date: '2026-09-30', authorityId: anaf.id },
      basis: { answers: [losses] },
    });
    // From 1 July only (art. 52 alin. (6)): 300,000 − 100,000 = 200,000; 32,000.
    expect(rowsOf(q3, 'P1', 'P2', 'P40', 'P41')).toEqual(['300000', '100000', '200000', '32000']);
    await post(q3);
    await note('2026-11-10', '704', '50000.00');
    const proposed = await s.propose('tax.profit', {
      period: '2026',
      date: '2026-12-31',
      authorityId: anaf.id,
    });
    // The losses stated for the books' start, cited again.
    const year = await s.invoke<ProposalView>(s.owner, 'tax.profit.revise', {
      proposalId: proposed.id,
      version: proposed.version,
      input: { period: '2026', date: '2026-12-31', authorityId: anaf.id },
      basis: { answers: [losses] },
    });
    expect(year.issues.filter((issue) => issue.severity === 'block')).toEqual([]);
    // The year from 1 July: 350,000 − 100,000 − 32,000 tax + 32,000 added back = 250,000; 40,000.
    expect(rowsOf(year, 'P40', 'P48', 'P50', 'P52')).toEqual(['250000', '40000', '32000', '8000']);
    expect(position(year)).toMatchObject({ start: '2026-07-01', microExitQuarter: 3 });
    await post(year);

    // The calendar: micro D100 for March and June, profit D100 for September, D101 from July,
    // and the D700 that declares the exit by 31 March 2027 (art. 55 alin. (5)).
    const calendar = await s.invoke<{
      items: {
        kind: string;
        period: string;
        deadline: string;
        due: string | null;
        status: string;
      }[];
    }>(s.owner, 'obligations.calendar', { from: '2026-01', to: '2026-12' });
    const returns = calendar.items
      .filter((item) => ['D100', 'D101', 'D700'].includes(item.kind))
      .map((item) => `${item.kind} ${item.period} ${item.deadline} ${item.due}`);
    expect(returns).toEqual(
      expect.arrayContaining([
        'D100 2026-03 D100.micro 2026-04-27',
        'D100 2026-06 D100.micro 2026-07-27',
        'D100 2026-09 D100.profit 2026-10-26',
        'D101 2026 D101 2027-06-25',
        'D700 2026 D700.micro_exit 2027-03-31',
      ]),
    );
    const closure = await s.invoke<{ unsupported: { trigger: string }[] }>(
      s.owner,
      'closure.evaluate',
      {
        from: '2026-01',
        to: '2026-12',
      },
    );
    expect(closure.unsupported.map((item) => item.trigger)).not.toContain(
      'MICRO_PROFIT_TRANSITION',
    );
    // The D700 is filed through ANAF's portal: a person records it, and the calendar shows it.
    const asked = await s.invoke<Question>(s.owner, 'questions.ask', {
      kind: 'obligation.filed',
      subject: { kind: 'obligation', id: 'D700/2026' },
      params: { kind: 'D700', period: '2026' },
    });
    await s.invoke(s.owner, 'questions.answer', {
      questionId: asked.id,
      value: {
        registrationNumber: 'INTERNT-12345',
        submittedOn: '2026-10-15',
        evidenceId: (await s.evidence('recipisa-d700.pdf')).id,
      },
    });
    const after = await s.invoke<{ items: { kind: string; status: string }[] }>(
      s.owner,
      'obligations.calendar',
      {
        from: '2026-01',
        to: '2026-12',
      },
    );
    expect(after.items.find((item) => item.kind === 'D700')?.status).toBe('filed');

    if (available) {
      expect((await prepare('D100', '2026-06', {})).state).toBe('validated_official');
      const september = await prepare('D100', '2026-09', {});
      expect([september.state, JSON.parse(september.steps[0]!.detail!).obligations]).toEqual([
        'validated_official',
        ['profit'],
      ]);
      const d101 = await prepare('D101', '2026', { caen: '6201' });
      expect(d101.state).toBe('validated_official');
      expect(JSON.parse(d101.steps[0]!.detail!)).toMatchObject({
        period: { from: '2026-07-01', to: '2026-12-31' },
        microExitQuarter: 3,
      });
    }
  }, 180_000);

  test('entering micro on 1 January: the D101 of the last profit year and the D700 by 31 March', async () => {
    const { s } = await company({
      'entity.form': [['srl', '2020-01-01']],
      'vat.status': [['non_vat', '2020-01-01']],
      employer: [['yes', '2020-01-01']],
      income_tax: [
        ['profit', '2026-01-01'],
        ['micro', '2027-01-01'],
      ],
      'profit.system': [['quarterly', '2026-01-01']],
    });
    for (const kind of ['financial', 'fiscal'])
      await s.invoke(s.owner, 'years.create', {
        kind,
        label: '2027',
        from: '2027-01-01',
        to: '2027-12-31',
      });
    const closure = await s.invoke<{
      obligations: {
        kind: string;
        period: string;
        deadline: string;
        deadlinePeriod: string | null;
      }[];
    }>(s.owner, 'closure.evaluate', { from: '2026-12', to: '2027-03' });
    expect(closure.obligations.filter((item) => ['D101', 'D700'].includes(item.kind))).toEqual([
      expect.objectContaining({ kind: 'D101', period: '2026', deadline: 'D101' }),
      expect.objectContaining({
        kind: 'D700',
        period: '2027',
        deadline: 'D700.micro_entry',
        deadlinePeriod: '2026',
      }),
    ]);
    const calendar = await s.invoke<{ items: { kind: string; due: string | null }[] }>(
      s.owner,
      'obligations.calendar',
      {
        from: '2026-12',
        to: '2027-03',
      },
    );
    expect(calendar.items.find((item) => item.kind === 'D700')?.due).toBe('2027-03-31');
  }, 120_000);

  test('FP-03: a 2026 error corrected in 2027 on 1174, the year rectified and its D101 too', async () => {
    const { s, anaf, note, post, answerIssue, prepare } = await company({
      'entity.form': [['srl', '2020-01-01']],
      'vat.status': [['non_vat', '2020-01-01']],
      income_tax: [['profit', '2026-01-01']],
      'profit.system': [['quarterly', '2026-01-01']],
    });
    await note('2026-04-10', '704', '100000.00');
    await note('2026-05-10', '628', '40000.00');
    let year = await s.propose('tax.profit', {
      period: '2026',
      date: '2026-12-31',
      authorityId: anaf.id,
    });
    const losses = await answerIssue(year, 'PROFIT_LOSSES', {
      vintages: [],
      evidenceIds: [(await s.evidence('d101-2025.pdf')).id],
    });
    year = await s.invoke<ProposalView>(s.owner, 'tax.profit.revise', {
      proposalId: year.id,
      version: year.version,
      input: { period: '2026', date: '2026-12-31', authorityId: anaf.id },
      basis: { answers: [losses] },
    });
    expect(rowsOf(year, 'P40', 'P48')).toEqual(['60000', '9600']);
    await post(year);
    for (const kind of ['financial', 'fiscal'])
      await s.invoke(s.owner, 'years.create', {
        kind,
        label: '2027',
        from: '2027-01-01',
        to: '2027-12-31',
      });
    const supplier = await s.party('Furnizor SRL', '14399840');
    const correction = await s.propose('correction.priorYear', {
      date: '2027-07-15',
      year: 2026,
      reference: 'COR-2026-1',
      description: 'Factura de servicii din 2026, omisă',
      evidenceId: (await s.evidence('factura-omisa.pdf')).id,
      lines: [
        { account: '1174', side: 'D', amount: '5000.00' },
        {
          account: '401',
          side: 'C',
          amount: '5000.00',
          partyId: supplier.id,
          newItem: { kind: 'payable' },
        },
      ],
      fiscalChange: '-5000',
    });
    expect(codes(correction)).toEqual(['PRIOR_YEAR_D101']);
    await post(correction);
    const [item] = await work(s, s.owner, ['profit.correction']);
    expect(item!.next[0]!.operation).toBe('tax.profit.propose');
    const rectified = await s.propose('tax.profit', {
      period: '2026',
      date: '2027-07-15',
      authorityId: anaf.id,
      rectification: true,
    });
    // 60,000 − 5,000 = 55,000; 8,800, 800 less than declared: back on 1174.
    expect(rowsOf(rectified, 'P9', 'P40', 'P48')).toEqual(['5000', '55000', '8800']);
    expect(lines(rectified)).toEqual(['D 4411 800.00', 'C 1174 800.00']);
    await post(rectified);
    expect(await work(s, s.owner, ['profit.correction'])).toEqual([]);
    if (available) {
      const d101 = await prepare('D101', '2026', { caen: '6201' });
      expect([d101.state, JSON.parse(d101.steps[0]!.detail!).rectifying]).toEqual([
        'validated_official',
        true,
      ]);
    }
  }, 180_000);
});
