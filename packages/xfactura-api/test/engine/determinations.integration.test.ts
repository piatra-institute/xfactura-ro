import { afterAll, describe, expect, test } from 'bun:test';
import { agent as module } from 'xfactura-core/ro/determinations';
import type { Actor } from '../../source/engine/kernel/commands';
import type { WorkItem } from '../../source/engine/kernel/work';
import { invoiceXml, type XmlInput } from './fixtures/invoice';
import { scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

// Synthetic BNR rates at the close of 2025, as the micro-tax tests use it (100.000 € =
// 508.000,00 lei); not the published rate.
const bnr = (date: string, rate: string) => `<?xml version="1.0" encoding="utf-8"?>
<DataSet xmlns="http://www.bnr.ro/xsd"><Header><Publisher>National Bank of Romania</Publisher><PublishingDate>${date}</PublishingDate><MessageType>DR</MessageType></Header>
<Body><Subject>Reference rates</Subject><OrigCurrency>RON</OrigCurrency>
<Cube date="${date}"><Rate currency="EUR">${rate}</Rate></Cube>
</Body></DataSet>`;
const CUI = '18547290';

type Determination = {
  axis: string;
  year: number;
  status: string;
  value: string | null;
  changes: { value: string; effectiveFrom: string }[];
  lines: string[];
  questions: { kind: string; subject: { id: string } }[];
  unsupported: { trigger: string } | null;
  recorded: {
    agrees: boolean | null;
    confirmed: boolean;
    values: { value: string; effectiveFrom: string }[];
  };
};
type Proposed = {
  determinations: Determination[];
  asked: { kind: string; subject: { id: string }; questionId: string; reused: boolean }[];
};
type Closure = {
  status: string;
  obligations: { kind: string; period: string; state: string; rule: string; facts: string[] }[];
  needs: { code: string; fact: string; question: { kind: string } }[];
  unsupported: { trigger: string; evidenceIds: string[] }[];
};
type Calendar = { kind: string; period: string; due: string | null; status: string }[];

/** A company on a fixed engine date, its facts recorded with documents, its rates imported. */
async function company(options: {
  year: number;
  today: string;
  facts: Record<string, [string, string]>;
}) {
  let now = Date.parse(`${options.today}T10:00:00Z`);
  const s = await scenario({ year: options.year, cui: CUI, clock: () => now });
  open.push(s);
  const record = async (axis: string, value: string, effectiveFrom: string) =>
    s.invoke(s.owner, 'profile.record', {
      axis,
      value,
      effectiveFrom,
      evidenceId: (await s.evidence(`${axis}-${value}.pdf`)).id,
    });
  for (const [axis, [value, from]] of Object.entries(options.facts))
    await record(axis, value, from);
  const file = async (filename: string, text: string) =>
    (
      await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
        filename,
        mediaType: 'application/xml',
        base64: Buffer.from(text).toString('base64'),
      })
    ).id;
  await s.invoke(s.owner, 'fx.importBnr', {
    evidenceId: await file('bnr-2025.xml', bnr('2025-12-31', '5.0800')),
  });
  const sell = async (input: XmlInput) => {
    const document = await s.invoke<{ id: string }>(s.owner, 'invoices.import', {
      evidenceId: await file(
        `${input.number}.xml`,
        invoiceXml({ company: CUI, direction: 'sale', ...input }),
      ),
    });
    return s.book('invoices.recognize', { documentId: document.id, account: '704' });
  };
  const answer = (actor: Actor, questionId: string, value: unknown) =>
    s.invoke<{ profileFactIds?: string[] }>(actor, 'questions.answer', { questionId, value });
  return {
    s,
    record,
    sell,
    answer,
    setToday: (date: string) => (now = Date.parse(`${date}T10:00:00Z`)),
    evaluate: (year: number) =>
      s.invoke<{ determinations: Determination[]; watches: { key: string; percent: number }[] }>(
        s.owner,
        'determinations.evaluate',
        { year },
      ),
    closure: (from: string, to: string) =>
      s.invoke<Closure>(s.owner, 'closure.evaluate', { from, to }),
    calendar: async (from: string, to: string) =>
      (await s.list<Calendar[number]>(s.owner, 'obligations.calendar', { from, to })).map(
        (item) => `${item.kind} ${item.period} ${item.due ?? '-'} ${item.status}`,
      ),
  };
}
async function tax(s: Scenario): Promise<Actor> {
  const grant = await s.invoke<{ token: string }>(s.reviewer, 'agents.issue', {
    name: 'Asistent fiscal',
    scopes: ['toolset:tax', 'work.list'],
    expiresAt: s.expiresIn(7),
  });
  return s.engine.agents.authenticate(grant.token, s.company.id);
}
const find = (items: Determination[], axis: string) => items.find((item) => item.axis === axis)!;
const work = async (s: Scenario, actor: Actor) =>
  (await s.invoke<{ items: WorkItem[] }>(actor, 'work.list', { limit: 200 })).items;

const scope = {
  'entity.form': ['srl', '2020-01-01'],
  'activity.goods': ['no', '2020-01-01'],
  'regime.excluded': ['none', '2020-01-01'],
  employer: ['no', '2020-01-01'],
} as Record<string, [string, string]>;

describe('determinations', () => {
  test('a company moves from micro to profit tax at a year boundary', async () => {
    const { s, sell, evaluate, closure, calendar, answer } = await company({
      year: 2025,
      today: '2026-02-16',
      facts: {
        ...scope,
        'vat.status': ['normal_vat', '2020-01-01'],
        'vat.cash': ['no', '2020-01-01'],
        'vat.period': ['monthly', '2025-01-01'],
        income_tax: ['micro', '2025-01-01'],
        'size.category': ['micro', '2025-01-01'],
      },
    });
    for (const kind of ['financial', 'fiscal'])
      await s.invoke(s.owner, 'years.create', {
        kind,
        label: '2026',
        from: '2026-01-01',
        to: '2026-12-31',
      });
    // 2025's turnover in the books: 600.000 lei, above 100.000 € at the BNR rate of 31.12.2025.
    await sell({
      number: 'V-2025',
      date: '2025-11-10',
      net: '600000.00',
      tax: '126000.00',
      gross: '726000.00',
    });

    const year = await evaluate(2026);
    expect(find(year.determinations, 'income_tax')).toMatchObject({
      status: 'proposed',
      value: 'profit',
      recorded: { agrees: false, confirmed: false },
    });
    expect(find(year.determinations, 'income_tax').lines.join('\n')).toContain(
      'Lit. c): NEÎNDEPLINITĂ. Cifra de afaceri 2025: 600.000,00 lei',
    );
    // Not yet confirmed: the first quarter's return is blocked, never assumed micro.
    expect(await calendar('2026-03', '2026-03')).toContain('D100 2026-03 - blocked');

    // An agent opens the questions; a person confirms the computation, which records the fact.
    const bot = await tax(s);
    const proposed = await s.invoke<Proposed>(bot, 'determinations.propose', { year: 2026 });
    const confirm = proposed.asked.find((item) => item.subject.id === 'income_tax/2026')!;
    expect(confirm).toMatchObject({ kind: 'determination.confirm', reused: false });
    expect(proposed.asked.find((item) => item.subject.id === 'vat.period/2026')).toMatchObject({
      kind: 'determination.confirm',
    });
    expect((await s.refused(answer(bot, confirm.questionId, { confirm: true })))?.code).toBe(
      'AGENT_SCOPE',
    );
    expect(
      (await answer(s.reviewer, confirm.questionId, { confirm: true })).profileFactIds,
    ).toHaveLength(1);
    const vatPeriod = proposed.asked.find((item) => item.subject.id === 'vat.period/2026')!;
    await answer(s.reviewer, vatPeriod.questionId, { confirm: true });

    expect(find((await evaluate(2026)).determinations, 'income_tax').recorded).toEqual({
      agrees: true,
      confirmed: true,
      values: [{ value: 'profit', effectiveFrom: '2026-01-01' }],
    });
    // The calendar follows the closure: micro tax for 2025's last quarter, profit tax for 2026's
    // first (quarterly by law after a micro year, art. 41 alin. (6) lit. d)), and the D700 that
    // declares leaving the regime from 1 January, by the earlier reading of art. 55 alin. (5).
    const rows = await calendar('2025-12', '2026-03');
    expect(rows).toContain('D100 2025-12 2026-01-26 overdue');
    expect(rows.filter((row) => row.startsWith('D100 2026'))).toEqual([
      'D100 2026-03 2026-04-27 due',
    ]);
    expect(rows).toContain('D700 2026 2026-03-31 due');
    const result = await closure('2025-12', '2026-03');
    expect(result.status).toBe('ELIGIBLE');
    expect(result.unsupported).toEqual([]);
    expect(result.obligations.find((item) => item.kind === 'D700')).toMatchObject({
      deadline: 'D700.micro_exit_january',
      deadlinePeriod: '2025',
    });
    expect(
      result.obligations.find((item) => item.kind === 'D100' && item.period === '2025-12'),
    ).toMatchObject({
      state: 'applies',
      rule: 'obligation.income_tax@2025-12',
      facts: ['incomeTax@2025-12=micro (fapt income_tax 2025)'],
    });
    // 2025 stays micro: its limit is checked at 2024's rate, a year the register does not hold.
    expect(find((await evaluate(2025)).determinations, 'income_tax').status).toBe('rule_gap');
  });

  test('a quarterly VAT payer: the figures of a year the books lack, the owner conditions, a conflict', async () => {
    const { s, record, evaluate, closure, calendar, answer } = await company({
      year: 2026,
      today: '2026-10-30',
      facts: {
        ...scope,
        'vat.status': ['normal_vat', '2020-01-01'],
        'vat.cash': ['no', '2020-01-01'],
        income_tax: ['micro', '2025-01-01'],
      },
    });
    const bot = await tax(s);
    // The worklist names what is missing for 2026, and the returns it blocks.
    const before = await work(s, bot);
    expect(
      before
        .filter((item) => item.kind === 'determination.missing')
        .map((item) => item.subject.id)
        .sort(),
    ).toEqual(['income_tax/2026', 'size.category/2026', 'vat.period/2026']);
    expect(before.find((item) => item.subject.id === 'D300|2026-07')).toMatchObject({
      severity: 'block',
      details: { status: 'blocked' },
      next: [{ operation: 'determinations.propose', by: 'agent', inputHint: { year: 2026 } }],
    });

    // The agent asks; 2025 is not in the books, so its figures are asked with the filed returns.
    const first = await s.invoke<Proposed>(bot, 'determinations.propose', { year: 2026 });
    expect(first.asked.map((item) => `${item.kind} ${item.subject.id}`).sort()).toEqual([
      'micro.conditions 2026',
      'profile.fact size.category/2025',
      'year.figures 2025',
    ]);
    const asked = (kind: string) => first.asked.find((item) => item.kind === kind)!.questionId;
    const statements = (await s.evidence('situatii-financiare-2025.pdf')).id;
    await answer(s.reviewer, asked('year.figures'), {
      values: {
        turnover: '300000.00',
        netTurnover: '300000.00',
        totalRevenue: '305000.00',
        vatTurnover: '300000.00',
        exemptionTurnover: '300000.00',
        totalAssets: '150000.00',
        averageEmployees: '0',
        euGoodsAcquisitions: 'no',
      },
      evidenceIds: [statements],
    });
    // The owner's conditions, with the trade register's certificate and the shareholders'
    // register (module.documentTypes).
    expect(module.documentTypes.map((item) => item.id)).toContain('onrc.extract');
    await answer(s.reviewer, asked('micro.conditions'), {
      stateOwned: false,
      dissolution: false,
      excludedActivity: false,
      shareholders: 'only_micro',
      statementsOnTime: 'yes',
      mandate: true,
      established: null,
      lateStatementsFrom: null,
      linked: [],
      evidenceIds: [
        (await s.evidence('certificat-constatator.pdf')).id,
        (await s.evidence('registrul-asociatilor.pdf')).id,
      ],
    });
    const computed = (await evaluate(2026)).determinations;
    expect(find(computed, 'income_tax')).toMatchObject({ status: 'proposed', value: 'micro' });
    expect(find(computed, 'vat.period')).toMatchObject({ status: 'proposed', value: 'quarterly' });
    expect(find(computed, 'vat.period').lines[0]).toContain(
      '300.000,00 lei, față de 100000 € × 5.0800',
    );

    // The owner records monthly from habit: the books contradict it, and the closure says so.
    await record('vat.period', 'monthly', '2026-01-01');
    const conflict = await closure('2026-07', '2026-09');
    expect(conflict.status).toBe('NEEDS_EVIDENCE');
    expect(conflict.needs).toContainEqual(
      expect.objectContaining({
        code: 'DETERMINATION_CONFLICT',
        fact: 'vat.period/2026',
        question: expect.objectContaining({ kind: 'determination.confirm' }),
      }),
    );
    expect(
      (await work(s, bot)).find((item) => item.subject.id === 'vat.period/2026'),
    ).toMatchObject({
      kind: 'determination.missing',
      severity: 'block',
      details: { conflict: true },
    });

    const second = await s.invoke<Proposed>(bot, 'determinations.propose', { year: 2026 });
    for (const subject of ['income_tax/2026', 'vat.period/2026'])
      await answer(
        s.reviewer,
        second.asked.find(
          (item) => item.subject.id === subject && item.kind === 'determination.confirm',
        )!.questionId,
        { confirm: true },
      );
    // Asked again, the confirmed computations are not reopened.
    const third = await s.invoke<Proposed>(bot, 'determinations.propose', { year: 2026 });
    expect(third.asked.filter((item) => item.kind === 'determination.confirm')).toEqual([]);

    expect(await calendar('2026-07', '2026-09')).toEqual([
      'D100 2026-09 2026-10-26 overdue',
      'D300 2026-Q3 2026-10-26 overdue',
      'D394 2026-Q3 2026-10-30 due',
      'D406 2026-Q3 2026-11-02 due',
    ]);
    expect((await closure('2026-07', '2026-09')).status).toBe('ELIGIBLE');
    // The module's agent contract: no booking template fields.
    expect(module.templates).toEqual([]);
  });

  test('a non-payer approaching the small-enterprise threshold: warned at 80%, registration due past it', async () => {
    const { s, sell, evaluate, closure } = await company({
      year: 2026,
      today: '2026-10-30',
      facts: {
        ...scope,
        'vat.status': ['non_vat', '2020-01-01'],
        'vat.eu': ['none', '2020-01-01'],
        income_tax: ['profit', '2026-01-01'],
      },
    });
    const sale = (number: string, date: string, net: string) =>
      sell({ number, date, category: 'O', rate: '0', tax: '0.00', net, gross: net });
    await sale('V-1', '2026-03-10', '200000.00');
    await sale('V-2', '2026-09-15', '130000.00');
    const bot = await tax(s);
    const watched = (await work(s, bot)).find((item) => item.kind === 'threshold.approaching')!;
    expect(watched).toMatchObject({
      subject: { kind: 'threshold', id: 'ro.vat.exemption.threshold/2026' },
      severity: 'warn',
      details: {
        key: 'ro.vat.exemption.threshold',
        limit: '395000.00',
        value: '330000.00',
        level: 80,
      },
      next: [{ operation: 'determinations.propose', by: 'agent', inputHint: { year: 2026 } }],
    });
    expect(find((await evaluate(2026)).determinations, 'vat.threshold')).toMatchObject({
      status: 'proposed',
      value: 'under',
    });
    // Under the threshold with nothing recorded is not a conflict.
    expect(
      (await work(s, bot)).filter((item) => item.kind === 'determination.missing'),
    ).not.toContainEqual(
      expect.objectContaining({ subject: { kind: 'determination', id: 'vat.threshold/2026' } }),
    );

    await sale('V-3', '2026-10-05', '70000.00');
    const crossed = (await work(s, bot)).find((item) => item.kind === 'threshold.approaching')!;
    expect(crossed).toMatchObject({
      severity: 'block',
      details: { level: 100, value: '400000.00' },
    });
    expect(crossed.fingerprint).not.toBe(watched.fingerprint);
    const threshold = find((await evaluate(2026)).determinations, 'vat.threshold');
    expect(threshold).toMatchObject({
      status: 'proposed',
      changes: [{ value: 'exceeded', effectiveFrom: '2026-10-05' }],
      unsupported: null,
    });
    // Registration under art. 316 is due from the crossing day (V1): the closure asks for it,
    // never assumes it, and the worklist blocks on it.
    expect(find((await evaluate(2026)).determinations, 'vat.status')).toMatchObject({
      changes: [{ value: 'normal_vat', effectiveFrom: '2026-10-05' }],
      recorded: { agrees: false },
    });
    const result = await closure('2026-10', '2026-10');
    expect(result.status).toBe('NEEDS_EVIDENCE');
    expect(result.needs).toContainEqual(
      expect.objectContaining({ code: 'DETERMINATION_CONFLICT', fact: 'vat.status/2026' }),
    );
    expect(
      (await work(s, bot)).find((item) => item.subject.id === 'vat.status/2026'),
    ).toMatchObject({ kind: 'determination.missing', severity: 'block' });
  });

  test('books from 1 January 2026: the worklist asks nothing of 2025, and offers no D212 while the form is unknown', async () => {
    const from = '2026-01-01';
    const { s, record, setToday } = await company({
      year: 2026,
      today: '2026-01-15',
      facts: {
        'activity.goods': ['no', from],
        'regime.excluded': ['none', from],
        employer: ['no', from],
        'vat.status': ['normal_vat', from],
        'vat.cash': ['no', from],
        'vat.period': ['monthly', from],
      },
    });
    let bot = await tax(s);
    const returns = async () =>
      (await work(s, bot)).filter((item) => item.kind === 'obligation.due');
    const form = {
      operation: 'questions.ask',
      by: 'agent',
      inputHint: { kind: 'profile.fact', subject: { kind: 'profile', id: 'entity.form' } },
    };
    // In January the worklist reaches back to October 2025, before the books: nothing of it.
    const january = await returns();
    expect(january.filter((item) => /\|2025/.test(item.subject.id))).toEqual([]);
    expect(
      january.flatMap((item) => item.next).filter((step) => step.inputHint.year === 2025),
    ).toEqual([]);
    expect(january.filter((item) => item.subject.id.startsWith('D212|'))).toEqual([]);
    expect(january.find((item) => item.subject.id === 'D300|2026-01')).toMatchObject({
      details: { status: 'due' },
    });
    // The form nobody recorded is asked through what reads it: D406 (a company's return, an open
    // question for an individual) and the micro tax.
    expect(january.find((item) => item.subject.id === 'D406|2026-01')).toMatchObject({
      severity: 'block',
      next: [form],
    });
    expect(january.find((item) => item.subject.id === 'D100|2026-03')).toMatchObject({
      next: [form],
    });

    // In November the window holds December: still no D212, whose form is unknown.
    setToday('2026-11-10');
    bot = await tax(s);
    const november = await returns();
    expect(november.filter((item) => item.subject.id.startsWith('D212|'))).toEqual([]);
    expect(november.find((item) => item.subject.id === 'D100|2026-09')).toMatchObject({
      next: [form],
    });
    // An SRL: D406 is due, and D212 never listed.
    await record('entity.form', 'srl', from);
    const known = await returns();
    expect(known.find((item) => item.subject.id === 'D406|2026-10')).toMatchObject({
      details: { status: 'due' },
    });
    expect(known.filter((item) => item.subject.id.startsWith('D212|'))).toEqual([]);
  });

  test("a non-payer's purchase from an Irish supplier: UNSUPPORTED with the invoice", async () => {
    const { s, closure } = await company({
      year: 2026,
      today: '2026-10-30',
      facts: {
        ...scope,
        'vat.status': ['non_vat', '2020-01-01'],
        'vat.eu': ['none', '2020-01-01'],
        income_tax: ['micro', '2026-01-01'],
      },
    });
    const purchase = await s.invoke<{ id: string }>(s.owner, 'invoices.import', {
      evidenceId: (
        await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
          filename: 'ie-software.xml',
          mediaType: 'application/xml',
          base64: Buffer.from(
            invoiceXml({
              company: CUI,
              number: 'IE-77',
              date: '2026-08-04',
              country: 'IE',
              counterparty: 'IE6388047V',
              category: 'AE',
              rate: '0',
              tax: '0.00',
              net: '450.00',
              gross: '450.00',
            }),
          ).toString('base64'),
        })
      ).id,
    });
    const result = await closure('2026-08', '2026-08');
    expect(result.status).toBe('UNSUPPORTED');
    expect(result.unsupported).toEqual([
      expect.objectContaining({ trigger: 'FOREIGN_SERVICE_PURCHASE', evidenceIds: [purchase.id] }),
    ]);
  });
});
