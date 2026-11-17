import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Actor } from '../../source/engine/kernel/commands';
import type { PreviewEffect, ProposalView } from '../../source/engine/kernel/views';
import type { WorkItem } from '../../source/engine/kernel/work';
import { axisValueName, profileGroups } from '../../source/engine/kernel/work-names';
import { profileAxes } from '../../source/engine/modules/company';
import { invoiceXml } from './fixtures/invoice';
import { journal, scenario, type Scenario } from './scenario';

/*
 * The reads and work items the accounting interface is built on: the profile with its labels
 * (`profile.current`), a fact a person states without a file (`profile.record`), the company at a
 * glance (`company.summary`), a treatment evaluated without storing it (`proposals.preview`), one
 * posted entry (`ledger.entry`) and documents by date and booking (`documents.list`).
 */

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

/** 10 November 2026, in Bucharest. */
const now = () => Date.UTC(2026, 10, 10, 10);
async function company(options: Parameters<typeof scenario>[0] = {}) {
  const s = await scenario({ clock: now, ...options });
  open.push(s);
  return s;
}
async function agent(s: Scenario, scopes: string[]): Promise<Actor> {
  const grant = await s.invoke<{ token: string }>(s.reviewer, 'agents.issue', {
    name: 'Asistent',
    scopes,
    expiresAt: s.expiresIn(7),
  });
  return s.engine.agents.authenticate(grant.token, s.company.id);
}

type Labelled = { value: string; label: string };
type Value = Labelled & { applies: boolean };
type ProfileItem = {
  axis: string;
  name: string;
  group: string;
  applies: boolean;
  yearly: boolean;
  values: Value[];
  current:
    | (Labelled & {
        effectiveFrom: string;
        factId: string;
        evidenceId: string;
        confirmedFor?: number;
        needsConfirmation?: boolean;
      })
    | null;
  impliedDefault: Labelled | null;
  history: (Labelled & {
    effectiveFrom: string;
    superseded: boolean;
    supersedesId: string | null;
  })[];
};
type Profile = { date: string; items: ProfileItem[]; groups: { group: string; name: string }[] };
const profile = (s: Scenario, actor: Actor, date?: string) =>
  s.invoke<Profile>(actor, 'profile.current', date ? { date } : {});
const axis = (found: Profile, name: string) => found.items.find((item) => item.axis === name)!;

/** Every table's row count: what a read must leave as it found it. */
async function rowCounts(s: Scenario) {
  return s.db.read(async (tx) => {
    const tables = await tx.all<{ name: string }>(
      sql`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name`,
    );
    const counts: Record<string, number> = {};
    for (const { name } of tables) {
      const [row] = await tx.all<{ count: number }>(
        sql.raw(`select count(*) as count from "${name}"`),
      );
      counts[name] = row!.count;
    }
    return counts;
  });
}

describe('profile.current', () => {
  test('lists every axis once, grouped, each allowed value with a label', async () => {
    const s = await company();
    const found = await profile(s, s.owner);
    expect(found.date).toBe('2026-11-10');
    expect(found.groups.map((group) => group.group)).toEqual([...profileGroups]);
    expect(found.groups.every((group) => group.name.length > 0)).toBe(true);
    const axes = found.items.map((item) => item.axis);
    expect(new Set(axes).size).toBe(axes.length);
    expect([...axes].sort()).toEqual(Object.keys(profileAxes).sort());
    // Grouped for people: each group's axes together, in the groups' order.
    const order = found.items.map((item) => profileGroups.indexOf(item.group as never));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    for (const item of found.items) {
      expect(item.name, item.axis).not.toBe(item.axis);
      expect(item.values.map((value) => value.value)).toEqual([
        ...(profileAxes[item.axis as keyof typeof profileAxes] as readonly string[]),
      ]);
      // No value without its own label in the engine's names table.
      for (const value of item.values) {
        expect(axisValueName(item.axis, value.value), `${item.axis}=${value.value}`).not.toBeNull();
        expect(value.label).toBe(axisValueName(item.axis, value.value)!);
        expect(value.label).not.toBe(value.value);
      }
    }
    expect(axis(found, 'vat.status').values).toEqual([
      { value: 'non_vat', label: 'Neplătitor de TVA', applies: true },
      { value: 'normal_vat', label: 'Plătitor de TVA', applies: true },
    ]);
    expect(axis(found, 'vat.eu').values[1]).toEqual({
      value: 'special',
      label: 'Cod de TVA special (art. 317)',
      applies: true,
    });
    // The CASS exceptions name the minimum they lift and their condition.
    expect(axis(found, 'cass.exception')).toMatchObject({
      name: 'Excepția de la CASS minimă',
      values: [
        { value: 'none', label: 'Fără excepție de la CASS minimă' },
        { value: 'salary', label: 'Exceptat: salarii de cel puțin 6 salarii minime' },
        {
          value: 'other_income',
          label: 'Exceptat: alte venituri cu CASS la cel puțin 6 salarii minime',
        },
        { value: 'pension', label: 'Exceptat: venituri din pensii' },
        {
          value: 'previous_year',
          label: 'Exceptat: exceptat sau cu opțiune în anul precedent',
        },
      ],
    });
    // Nothing recorded: the values the engine reads anyway, and no other.
    expect(
      found.items
        .filter((item) => item.impliedDefault)
        .map((item) => [item.axis, item.impliedDefault!.value]),
    ).toEqual([
      ['entity.form', 'srl'],
      ['books.system', 'double'],
      ['books.assurance', 'preview'],
      ['controls.segregation', 'off'],
    ]);
    expect(found.items.every((item) => item.current === null && item.history.length === 0)).toBe(
      true,
    );
  });

  test('applies by the legal form, value by value, as profile.record checks it', async () => {
    const s = await company();
    const applying = (found: Profile, name: string) =>
      axis(found, name)
        .values.filter((value) => value.applies)
        .map((value) => value.value);
    const srl = await profile(s, s.owner);
    expect(
      ['income_tax', 'cas.status', 'cass.exception', 'books.system', 'vat.status'].map(
        (name) => axis(srl, name).applies,
      ),
    ).toEqual([true, false, false, true, true]);
    // An SRL keeps double entry: it may record it, never single entry.
    expect(applying(srl, 'books.system')).toEqual(['double']);
    expect(applying(srl, 'entity.form')).toEqual(['srl', 'pfa', 'ii', 'if']);
    await s.invoke(s.owner, 'profile.record', {
      axis: 'books.system',
      value: 'double',
      effectiveFrom: '2026-01-01',
    });
    expect(
      (
        await s.refused(
          s.invoke(s.owner, 'profile.record', {
            axis: 'books.system',
            value: 'single',
            effectiveFrom: '2026-01-01',
          }),
        )
      )?.code,
    ).toBe('BOOKS_SYSTEM_FORM');
    // Double entry recorded: the company is an SRL, and no PFA, II or IF form applies any more.
    expect(applying(await profile(s, s.owner), 'entity.form')).toEqual(['srl']);
    expect(
      (
        await s.refused(
          s.invoke(s.owner, 'profile.record', {
            axis: 'entity.form',
            value: 'pfa',
            effectiveFrom: '2026-01-01',
          }),
        )
      )?.code,
    ).toBe('ENTITY_FORM_CHANGE');

    const other = await company();
    await other.invoke(other.owner, 'profile.record', {
      axis: 'entity.form',
      value: 'pfa',
      effectiveFrom: '2026-01-01',
    });
    const pfa = await profile(other, other.owner);
    expect(
      ['income_tax', 'cas.status', 'cass.exception', 'books.system', 'vat.status'].map(
        (name) => axis(pfa, name).applies,
      ),
    ).toEqual([false, true, true, true, true]);
    expect(applying(pfa, 'books.system')).toEqual(['double', 'single']);
    expect(applying(pfa, 'entity.form')).toEqual(['pfa', 'ii', 'if']);
    expect(axis(pfa, 'books.system').impliedDefault).toEqual({
      value: 'single',
      label: 'Partidă simplă',
    });
    expect(axis(pfa, 'entity.form').current).toMatchObject({
      value: 'pfa',
      label: 'Persoană fizică autorizată (PFA)',
      effectiveFrom: '2026-01-01',
    });
  });

  test('the value in effect: superseded facts dropped, the last one by the date, a yearly fact with the year it was stated for', async () => {
    const s = await company();
    const record = (fields: Record<string, string>) =>
      s.invoke<{ id: string; evidenceId: string }>(s.owner, 'profile.record', fields);
    const { id: certificate } = await s.evidence('certificat.pdf');
    const first = await record({
      axis: 'vat.status',
      value: 'non_vat',
      effectiveFrom: '2026-01-01',
      evidenceId: certificate,
    });
    const registered = await record({
      axis: 'vat.status',
      value: 'normal_vat',
      effectiveFrom: '2026-05-14',
    });
    // The registration was recorded from the wrong day: corrected, it starts on 1 June.
    const corrected = await record({
      axis: 'vat.status',
      value: 'normal_vat',
      effectiveFrom: '2026-06-01',
      supersedesId: registered.id,
    });
    const may = axis(await profile(s, s.owner, '2026-05-20'), 'vat.status');
    expect(may.current).toMatchObject({
      value: 'non_vat',
      factId: first.id,
      evidenceId: certificate,
      recordedBy: s.owner.actorId,
    });
    expect(axis(await profile(s, s.owner, '2026-06-01'), 'vat.status').current).toMatchObject({
      value: 'normal_vat',
      label: 'Plătitor de TVA',
      factId: corrected.id,
      evidenceId: corrected.evidenceId,
    });
    expect(
      may.history.map((fact) => [
        fact.value,
        fact.effectiveFrom,
        fact.superseded,
        fact.supersedesId,
      ]),
    ).toEqual([
      ['non_vat', '2026-01-01', false, null],
      ['normal_vat', '2026-05-14', true, null],
      ['normal_vat', '2026-06-01', false, registered.id],
    ]);
    // A yearly fact stays in effect, as treatments read it, until the next year's is stated:
    // it says which year it was stated for and whether the day's year still needs its own.
    await record({ axis: 'income_tax', value: 'micro', effectiveFrom: '2026-01-01' });
    expect(axis(await profile(s, s.owner, '2026-12-31'), 'income_tax')).toMatchObject({
      yearly: true,
      current: { value: 'micro', confirmedFor: 2026, needsConfirmation: false },
    });
    expect(axis(await profile(s, s.owner, '2027-01-04'), 'income_tax').current).toMatchObject({
      value: 'micro',
      effectiveFrom: '2026-01-01',
      confirmedFor: 2026,
      needsConfirmation: true,
    });
    expect(axis(await profile(s, s.owner, '2027-01-04'), 'vat.status').current).not.toHaveProperty(
      'confirmedFor',
    );
    // An agent reads it too.
    const reader = await agent(s, ['profile.current']);
    expect(axis(await profile(s, reader), 'vat.status').current?.value).toBe('normal_vat');
  });
});

describe('profile.record without a file', () => {
  test('keeps the person’s statement as the fact’s evidence, with the same checks as with a file', async () => {
    const s = await company();
    const recorded = await s.invoke<{ id: string; evidenceId: string; axis: string }>(
      s.reviewer,
      'profile.record',
      { axis: 'employer', value: 'yes', effectiveFrom: '2026-03-01' },
    );
    const file = await s.invoke<{ filename: string; mediaType: string; base64: string }>(
      s.owner,
      'evidence.get',
      { id: recorded.evidenceId },
    );
    expect(file.mediaType).toBe('application/vnd.xfactura.answer+json');
    expect(JSON.parse(Buffer.from(file.base64, 'base64').toString('utf8'))).toEqual({
      schema: 'xfactura.statement@1',
      statementId: recorded.evidenceId,
      kind: 'profile.fact',
      axis: 'employer',
      value: 'yes',
      effectiveFrom: '2026-03-01',
      supersedesId: null,
      statedBy: s.reviewer.actorId,
      statedAt: new Date(now()).toISOString(),
    });
    // The statement is used: it is no unused file on the worklist.
    const unused = await s.invoke<{ items: WorkItem[] }>(s.owner, 'work.list', {
      kinds: ['evidence.unused'],
    });
    expect(unused.items.map((item) => item.subject.id)).not.toContain(recorded.evidenceId);
    // Refusals: a value the axis does not take, a fact of another form, a person who may not
    // record facts, an agent; none leaves a file behind.
    const before = await rowCounts(s);
    expect(
      (
        await s.refused(
          s.invoke(s.owner, 'profile.record', {
            axis: 'vat.status',
            value: 'exempt',
            effectiveFrom: '2026-01-01',
          }),
        )
      )?.code,
    ).toBe('VALIDATION');
    expect(
      (
        await s.refused(
          s.invoke(s.owner, 'profile.record', {
            axis: 'cas.status',
            value: 'liable',
            effectiveFrom: '2026-01-01',
          }),
        )
      )?.code,
    ).toBe('PROFILE_FORM');
    expect(
      (
        await s.refused(
          s.invoke(s.viewer, 'profile.record', {
            axis: 'employer',
            value: 'no',
            effectiveFrom: '2026-01-01',
          }),
        )
      )?.code,
    ).toBe('FORBIDDEN');
    const assistant = await agent(s, ['profile.current']);
    const afterGrant = await rowCounts(s);
    expect(
      (
        await s.refused(
          s.invoke(assistant, 'profile.record', {
            axis: 'employer',
            value: 'no',
            effectiveFrom: '2026-01-01',
          }),
        )
      )?.code,
    ).toBe('AGENT_SCOPE');
    expect(afterGrant.acc_evidence).toBe(before.acc_evidence);
    expect(afterGrant.acc_profile_facts).toBe(before.acc_profile_facts);
    expect((await rowCounts(s)).acc_evidence).toBe(before.acc_evidence);
  });
});

/** A company with a bank account in lei, a cash desk in euro, customers and suppliers. */
async function trading() {
  const s = await company();
  await s.invoke(s.owner, 'profile.record', {
    axis: 'vat.status',
    value: 'normal_vat',
    effectiveFrom: '2026-01-01',
  });
  await s.invoke(s.owner, 'profile.record', {
    axis: 'vat.period',
    value: 'monthly',
    effectiveFrom: '2026-01-01',
  });
  const bank = await s.invoke<{ id: string }>(s.owner, 'treasury.createAccount', {
    kind: 'bank',
    name: 'Cont curent',
    iban: 'RO49AAAA1B31007593840000',
    currency: 'RON',
    ledgerAccount: '5121',
    openedOn: '2026-01-01',
  });
  const desk = await s.invoke<{ id: string }>(s.owner, 'treasury.createAccount', {
    kind: 'cash',
    name: 'Casa în euro',
    currency: 'EUR',
    ledgerAccount: '5314',
    openedOn: '2026-01-01',
  });
  const { id: note } = await s.evidence('nota.pdf');
  const client = await s.party('Client Sintetic SRL', '11111111');
  const supplier = await s.party('Furnizor Sintetic SRL', '22222222');
  await s.book(
    'ledger.general',
    journal(
      note,
      [
        { account: '5121', side: 'D', amount: '10000.00' },
        { account: '1012', side: 'C', amount: '10000.00' },
      ],
      { date: '2026-01-05', reference: 'NC-CAPITAL' },
    ),
  );
  await s.book(
    'ledger.general',
    journal(
      note,
      [
        {
          account: '5314',
          side: 'D',
          amount: '497.50',
          currency: {
            code: 'EUR',
            amount: '100.00',
            rate: '4.9750',
            rateId: 'BNR/EUR/2026-02-02/1',
          },
        },
        { account: '5121', side: 'C', amount: '497.50' },
      ],
      { date: '2026-02-02', reference: 'NC-SCHIMB' },
    ),
  );
  // What customers owe: one invoice past due on 10 November, one not yet due.
  for (const [reference, amount, dueDate] of [
    ['NC-C1', '1210.00', '2026-10-15'],
    ['NC-C2', '500.00', '2026-12-15'],
  ] as const)
    await s.book(
      'ledger.general',
      journal(
        note,
        [
          { account: '4111', side: 'D', amount, newItem: 'c' },
          { account: '704', side: 'C', amount },
        ],
        {
          date: '2026-10-01',
          reference,
          newItems: [{ ref: 'c', partyId: client.id, dueDate }],
        },
      ),
    );
  // What is owed to suppliers: an invoice past due, and one not yet received (408).
  await s.book(
    'ledger.general',
    journal(
      note,
      [
        { account: '628', side: 'D', amount: '300.00' },
        { account: '401', side: 'C', amount: '300.00', newItem: 's' },
      ],
      {
        date: '2026-10-02',
        reference: 'NC-S1',
        newItems: [{ ref: 's', partyId: supplier.id, dueDate: '2026-11-01' }],
      },
    ),
  );
  await s.book(
    'ledger.general',
    journal(
      note,
      [
        { account: '628', side: 'D', amount: '100.00' },
        { account: '408', side: 'C', amount: '100.00', newItem: 'n' },
      ],
      { date: '2026-10-31', reference: 'NC-S2', newItems: [{ ref: 'n', partyId: supplier.id }] },
    ),
  );
  return { s, bank, desk, note, client, supplier };
}

type Money = { minor: string; currency: string };
type Summary = {
  date: string;
  cash: {
    accounts: {
      id: string;
      ledgerAccount: string;
      currency: string;
      balance: Money;
      ledgerBalance: Money;
    }[];
    totals: Money[];
  };
  receivables: {
    count: number;
    currencies: {
      currency: string;
      total: string;
      count: number;
      overdue: string;
      overdueCount: number;
    }[];
    unrepresented: { code: string; accounts: { account: string; balance: Money }[] } | null;
  };
  payables: Summary['receivables'];
  tax: { owed: Money; overdue: Money; claims: Money; net: Money; obligations: number } | null;
  taxReason: { code: string; message: string } | null;
  work: {
    total: number;
    by: { person: number; agent: number; neither: number };
    severity: { block: number; warn: number; info: number };
    complete: boolean;
    next: string | null;
  };
  deadlines: {
    kind: string;
    period: string;
    due: string | null;
    status: string;
    artifactId: string | null;
  }[];
};

describe('company.summary', () => {
  test('the money, what is owed either way, the tax position, the work and the next returns', async () => {
    const { s, bank, desk, note } = await trading();
    // VAT owed to the state for September, due on 25 October.
    const anaf = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
      kind: 'ro_public_institution',
      country: 'RO',
      taxId: '33333333',
      name: 'Administrația fiscală',
    });
    await s.book(
      'ledger.general',
      journal(
        note,
        [
          { account: '628', side: 'D', amount: '210.00' },
          { account: '4423', side: 'C', amount: '210.00', newItem: 'v' },
        ],
        {
          date: '2026-09-30',
          reference: 'NC-TVA',
          newItems: [{ ref: 'v', partyId: anaf.id, dueDate: '2026-10-25' }],
        },
      ),
    );
    const summary = await s.invoke<Summary>(s.owner, 'company.summary');
    expect(summary.date).toBe('2026-11-10');
    expect(
      summary.cash.accounts.map((account) => [
        account.id,
        account.ledgerAccount,
        account.balance,
        account.ledgerBalance,
      ]),
    ).toEqual([
      [bank.id, '5121', { minor: '950250', currency: 'RON' }, { minor: '950250', currency: 'RON' }],
      [desk.id, '5314', { minor: '10000', currency: 'EUR' }, { minor: '49750', currency: 'RON' }],
    ]);
    expect(summary.cash.totals).toEqual([
      { minor: '950250', currency: 'RON' },
      { minor: '10000', currency: 'EUR' },
    ]);
    expect(summary.receivables).toEqual({
      count: 2,
      currencies: [
        { currency: 'RON', total: '171000', count: 2, overdue: '121000', overdueCount: 1 },
      ],
      unrepresented: null,
    });
    // 401 and 408 alike; an invoice not yet received has no due date, so it is not past due.
    expect(summary.payables).toEqual({
      count: 2,
      currencies: [
        { currency: 'RON', total: '40000', count: 2, overdue: '30000', overdueCount: 1 },
      ],
      unrepresented: null,
    });
    expect(summary.tax).toEqual({
      owed: { minor: '21000', currency: 'RON' },
      overdue: { minor: '21000', currency: 'RON' },
      claims: { minor: '0', currency: 'RON' },
      net: { minor: '21000', currency: 'RON' },
      obligations: 1,
    });
    expect(summary.taxReason).toBeNull();
    // Beyond the rules' reviewed horizon the position is not computed: null, and why.
    const later = await s.invoke<Summary>(s.owner, 'company.summary', { date: '2027-06-30' });
    expect(later.tax).toBeNull();
    expect(later.taxReason).toMatchObject({
      code: 'RULE_GAP',
      details: { key: 'ro.taxaccount.obligations', reason: 'BEYOND_HORIZON' },
    });

    // The work, counted as the worklist lists it to this caller and grouped as the interface
    // groups it.
    const listed: WorkItem[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await s.invoke<{ items: WorkItem[]; next: string | null }>(
        s.owner,
        'work.list',
        { limit: 200, ...(after ? { after } : {}) },
      );
      listed.push(...page.items);
      if (!page.next) break;
      after = page.next;
    }
    const who = (item: WorkItem) =>
      item.next.some((step) => step.by === 'human' && step.allowed)
        ? 'person'
        : item.next.some((step) => step.by === 'agent' && step.allowed)
          ? 'agent'
          : 'neither';
    expect(summary.work).toMatchObject({
      complete: true,
      next: null,
      total: listed.length,
      by: {
        person: listed.filter((item) => who(item) === 'person').length,
        agent: listed.filter((item) => who(item) === 'agent').length,
        neither: listed.filter((item) => who(item) === 'neither').length,
      },
      severity: {
        block: listed.filter((item) => item.severity === 'block').length,
        warn: listed.filter((item) => item.severity === 'warn').length,
        info: listed.filter((item) => item.severity === 'info').length,
      },
    });
    expect(summary.work.total).toBeGreaterThan(0);

    // The next five returns not filed, as the calendar shows them, by due date.
    const calendar = await s.list<{
      kind: string;
      period: string;
      due: string | null;
      status: string;
      end: string;
    }>(s.owner, 'obligations.calendar', { from: '2026-01', to: '2027-01', today: '2026-11-10' });
    const unfiled = calendar
      .filter((item) => !['filed', 'accepted'].includes(item.status))
      .sort((a, b) =>
        `${a.due ?? '9999-12-31'}|${a.end}|${a.kind}|${a.period}` <
        `${b.due ?? '9999-12-31'}|${b.end}|${b.kind}|${b.period}`
          ? -1
          : 1,
      );
    expect(summary.deadlines).toHaveLength(5);
    expect(summary.deadlines.map((item) => `${item.kind}|${item.period}|${item.due}`)).toEqual(
      unfiled.slice(0, 5).map((item) => `${item.kind}|${item.period}|${item.due}`),
    );

    // On an earlier day: what stood then.
    const october = await s.invoke<Summary>(s.owner, 'company.summary', { date: '2026-09-30' });
    expect(october.receivables).toEqual({ count: 0, currencies: [], unrepresented: null });
    expect(october.cash.totals).toEqual([
      { minor: '950250', currency: 'RON' },
      { minor: '10000', currency: 'EUR' },
    ]);
  });

  test('a balance of the classes no open item shows is stated, not left out', async () => {
    const { s, note, client } = await trading();
    // A customer's receivable moved to 4118 (doubtful), an account without open items.
    const items = await s.list<{ id: string; account: string; partyId: string; balance: string }>(
      s.owner,
      'openItems.list',
    );
    const due = items.find(
      (item) => item.account === '4111' && item.partyId === client.id && item.balance === '1210.00',
    )!;
    await s.book(
      'ledger.general',
      journal(
        note,
        [
          { account: '4118', side: 'D', amount: '1210.00', partyId: client.id },
          { account: '4111', side: 'C', amount: '1210.00', openItem: due.id },
        ],
        { date: '2026-11-05', reference: 'NC-INCERT' },
      ),
    );
    const summary = await s.invoke<Summary>(s.owner, 'company.summary');
    expect(summary.receivables).toEqual({
      count: 1,
      currencies: [{ currency: 'RON', total: '50000', count: 1, overdue: '0', overdueCount: 0 }],
      unrepresented: {
        code: 'UNSUPPORTED',
        accounts: [{ account: '4118', balance: { minor: '121000', currency: 'RON' } }],
      },
    });
    expect(summary.payables.unrepresented).toBeNull();
    // Before the transfer, the open items showed it all.
    expect(
      (await s.invoke<Summary>(s.owner, 'company.summary', { date: '2026-11-04' })).receivables
        .unrepresented,
    ).toBeNull();
  });

  test('counts the work for the caller: an agent’s own steps, a viewer’s none', async () => {
    const { s } = await trading();
    const assistant = await agent(s, ['company.summary', 'work.list', 'questions.ask']);
    const seen = await s.invoke<Summary>(assistant, 'company.summary');
    const viewed = await s.invoke<Summary>(s.viewer, 'company.summary');
    const owned = await s.invoke<Summary>(s.owner, 'company.summary');
    expect(seen.work.total).toBe(owned.work.total);
    expect(viewed.work.total).toBe(owned.work.total);
    expect(seen.work.by.person).toBe(0);
    expect(viewed.work.by.person + viewed.work.by.agent).toBe(0);
    expect(owned.work.by.person).toBeGreaterThan(0);
    expect(seen.work.by.agent).toBeGreaterThan(0);
  });
});

describe('proposals.preview', () => {
  test('is what proposals.propose stores for the same input, and stores nothing', async () => {
    const { s, note } = await trading();
    const input = journal(
      note,
      [
        { account: '628', side: 'D', amount: '123.45' },
        { account: '5121', side: 'C', amount: '123.45' },
      ],
      { date: '2026-11-03', reference: 'NC-PREVIZ' },
    );
    const before = await rowCounts(s);
    const preview = await s.invoke<{
      treatment: string;
      subject: string;
      effect: ProposalView['effect'];
      issues: ProposalView['issues'];
      blocking: boolean;
      totals: { currency: string; debit: string; credit: string; difference: string }[];
    }>(s.owner, 'proposals.preview', { treatment: 'ledger.general', input });
    expect(await rowCounts(s)).toEqual(before);
    expect(preview.totals).toEqual([
      { currency: 'RON', debit: '12345', credit: '12345', difference: '0' },
    ]);
    const proposed = await s.invoke<ProposalView>(s.owner, 'proposals.propose', {
      treatment: 'ledger.general',
      input,
    });
    const stored = await s.invoke<ProposalView>(s.owner, 'proposals.get', { id: proposed.id });
    expect(preview.subject).toBe(stored.subject);
    expect(preview.effect).toEqual(stored.effect);
    expect(preview.issues).toEqual(stored.issues);
    expect(preview.blocking).toBe(stored.status === 'blocked');

    // While a person types: unbalanced, the difference; in another currency, its own totals.
    const typing = await s.invoke<typeof preview>(s.owner, 'proposals.preview', {
      treatment: 'ledger.general',
      input: journal(
        note,
        [
          { account: '628', side: 'D', amount: '100.00' },
          {
            account: '5314',
            side: 'C',
            amount: '99.50',
            currency: {
              code: 'EUR',
              amount: '20.00',
              rate: '4.9750',
              rateId: 'BNR/EUR/2026-11-03/1',
            },
          },
        ],
        { date: '2026-11-03', reference: 'NC-TASTARE' },
      ),
    });
    expect(typing.totals).toEqual([
      { currency: 'RON', debit: '10000', credit: '9950', difference: '50' },
      { currency: 'EUR', debit: '0', credit: '2000', difference: '-2000' },
    ]);
    expect(typing.blocking).toBe(true);
    expect(typing.issues.map((issue) => issue.code)).toContain('UNBALANCED');
  });

  test('is refused as proposing would be', async () => {
    const { s, note } = await trading();
    const request = {
      treatment: 'ledger.general',
      input: journal(note, [
        { account: '628', side: 'D', amount: '1.00' },
        { account: '5121', side: 'C', amount: '1.00' },
      ]),
    };
    expect((await s.refused(s.invoke(s.viewer, 'proposals.preview', request)))?.code).toBe(
      'FORBIDDEN',
    );
    const generic = await agent(s, ['proposals.preview']);
    expect((await s.refused(s.invoke(generic, 'proposals.preview', request)))?.code).toBe(
      'AGENT_SCOPE',
    );
    const typed = await agent(s, ['proposals.preview', 'ledger.general.propose']);
    const before = await rowCounts(s);
    expect(
      (await s.invoke<{ totals: unknown }>(typed, 'proposals.preview', request)).totals,
    ).toEqual([{ currency: 'RON', debit: '100', credit: '100', difference: '0' }]);
    expect(await rowCounts(s)).toEqual(before);
    expect(
      (
        await s.refused(
          s.invoke(s.owner, 'proposals.preview', { ...request, treatment: 'ledger.unknown' }),
        )
      )?.code,
    ).toBe('TREATMENT');
  });
});

describe('proposals.preview, refused and provisional', () => {
  test('refused wherever proposing is: a subject another proposal holds, a document in the opening', async () => {
    const { s, note } = await trading();
    const entry = (amount: string) =>
      journal(
        note,
        [
          { account: '628', side: 'D', amount },
          { account: '5121', side: 'C', amount },
        ],
        { date: '2026-11-03', reference: 'NC-E1' },
      );
    const held = await s.propose('ledger.general', entry('10.00'));
    const other = { treatment: 'ledger.general', input: entry('11.00') };
    const refusedPropose = await s.refused(s.invoke(s.owner, 'proposals.propose', other));
    const refusedPreview = await s.refused(s.invoke(s.owner, 'proposals.preview', other));
    expect(refusedPropose?.code).toBe('SUBJECT_EXISTS');
    expect(refusedPreview).toEqual(refusedPropose);
    // The holder's own input previews as proposing it returns the holder: its own ids.
    const same = await s.invoke<{ effect: ProposalView['effect'] }>(s.owner, 'proposals.preview', {
      treatment: 'ledger.general',
      input: entry('10.00'),
    });
    expect(same.effect).toEqual(
      (await s.invoke<ProposalView>(s.owner, 'proposals.get', { id: held.id })).effect,
    );

    // A document whose balance a standing opening carries is not recognized again.
    const fresh = await company();
    const { id: xml } = await fresh.invoke<{ id: string }>(fresh.owner, 'evidence.record', {
      filename: 'AR-1.xml',
      mediaType: 'application/xml',
      base64: Buffer.from(
        invoiceXml({ number: 'AR-1', date: '2025-12-15', direction: 'sale' }),
      ).toString('base64'),
    });
    const document = await fresh.invoke<{ id: string; partyId: string }>(
      fresh.owner,
      'invoices.import',
      { evidenceId: xml },
    );
    await fresh.book(
      'ledger.general',
      journal(
        (await fresh.evidence('balanta.pdf')).id,
        [
          { account: '4111', side: 'D', amount: '121.00', newItem: 'customer' },
          { account: '1012', side: 'C', amount: '121.00' },
        ],
        {
          date: '2026-01-01',
          purpose: 'opening',
          reference: 'DESCHIDERE-2026',
          newItems: [{ ref: 'customer', partyId: document.partyId, documentId: document.id }],
        },
      ),
    );
    const recognition = {
      treatment: 'invoices.recognize',
      input: { documentId: document.id, account: '704' },
    };
    const opened = await s.refused(fresh.invoke(fresh.owner, 'proposals.propose', recognition));
    expect(opened?.code).toBe('DOCUMENT_IN_OPENING');
    expect(await s.refused(fresh.invoke(fresh.owner, 'proposals.preview', recognition))).toEqual(
      opened,
    );
  });

  test('what it would create carries provisional references, and no identifier is drawn', async () => {
    let drawn = 0;
    const s = await company({
      ids: () => {
        drawn++;
        return randomUUID();
      },
    });
    const { id: note } = await s.evidence('nota.pdf');
    const client = await s.party('Client Sintetic SRL', '11111111');
    const input = journal(
      note,
      [
        { account: '4111', side: 'D', amount: '242.00', newItem: 'c' },
        { account: '704', side: 'C', amount: '242.00' },
      ],
      {
        date: '2026-10-01',
        reference: 'NC-PROVIZORIU',
        newItems: [{ ref: 'c', partyId: client.id, dueDate: '2026-10-31' }],
      },
    );
    const before = drawn;
    const preview = await s.invoke<{
      effect: PreviewEffect;
    }>(s.owner, 'proposals.preview', { treatment: 'ledger.general', input });
    expect(drawn).toBe(before);
    expect(preview.effect.openItems).toMatchObject([
      { id: 'provisional:openItem:c', provisional: true },
    ]);
    expect(preview.effect.lines.map((line) => [line.openItem, line.provisional])).toEqual([
      ['provisional:openItem:c', true],
      [undefined, undefined],
    ]);
    const proposed = await s.invoke<ProposalView>(s.owner, 'proposals.propose', {
      treatment: 'ledger.general',
      input,
    });
    expect(drawn).toBeGreaterThan(before);
    const real = proposed.effect!.openItems[0]!.id;
    expect(real).not.toBe('provisional:openItem:c');
    expect(real).toMatch(/^[0-9a-f-]{36}$/);
    // The same effect but for the references: provisional where proposing named for real.
    const named = (value: unknown) =>
      JSON.parse(
        JSON.stringify(value)
          .replaceAll('"provisional:openItem:c"', JSON.stringify(real))
          .replaceAll(',"provisional":true', ''),
      ) as unknown;
    expect(named(preview.effect)).toEqual(proposed.effect);
  });
});

describe('ledger.entry', () => {
  test('one posted entry with its names, evidence, approval and reversals', async () => {
    const { s, note } = await trading();
    const { id: xml } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: 'F-100.xml',
      mediaType: 'application/xml',
      base64: Buffer.from(invoiceXml({ number: 'F-100', date: '2026-10-05' })).toString('base64'),
    });
    const document = await s.invoke<{ id: string }>(s.owner, 'invoices.import', {
      evidenceId: xml,
    });
    const booked = await s.book('invoices.recognize', { documentId: document.id, account: '628' });
    type Entry = {
      id: string;
      number: number;
      date: string;
      journalCode: string;
      treatment: string;
      purpose: string | null;
      documentId: string | null;
      document: { type: string; number: string | null } | null;
      lines: {
        account: string;
        accountName: string | null;
        side: string;
        amount: Money | null;
        partyName: string | null;
        openItem: string | null;
      }[];
      evidence: { id: string; filename: string | null; mediaType: string }[];
      proposalId: string;
      version: number;
      approval: { approverId: string } | null;
      postedBy: string;
      reverses: { entryId: string } | null;
      reversedBy: { entryId: string }[];
    };
    const entry = await s.invoke<Entry>(s.owner, 'ledger.entry', { entryId: booked.entry!.id });
    expect(entry).toMatchObject({
      id: booked.entry!.id,
      date: '2026-10-05',
      treatment: 'invoices.recognize',
      purpose: null,
      documentId: document.id,
      document: { type: 'Factură primită', number: 'F-100' },
      proposalId: booked.id,
      version: booked.version,
      approval: { approverId: s.reviewer.actorId },
      postedBy: s.reviewer.actorId,
      reverses: null,
      reversedBy: [],
    });
    expect(
      entry.lines.map((line) => [
        line.side,
        line.account,
        line.amount?.minor,
        line.amount?.currency,
      ]),
    ).toEqual([
      ['D', '628', '10000', 'RON'],
      ['D', '4426', '2100', 'RON'],
      ['C', '401', '12100', 'RON'],
    ]);
    expect(entry.lines.every((line) => line.accountName)).toBe(true);
    expect(entry.lines.find((line) => line.account === '401')).toMatchObject({
      partyName: 'Companie 87654321',
    });
    expect(entry.evidence).toEqual([
      { id: xml, filename: 'F-100.xml', mediaType: 'application/xml' },
    ]);

    const reversal = await s.book('ledger.reverse', {
      entryId: booked.entry!.id,
      date: '2026-10-20',
      reason: 'Factura a fost înregistrată din eroare',
      evidenceId: note,
      method: 'red',
    });
    const reversed = await s.invoke<Entry>(s.owner, 'ledger.entry', { entryId: booked.entry!.id });
    expect(reversed.reversedBy.map((item) => item.entryId)).toEqual([reversal.entry!.id]);
    const storno = await s.invoke<Entry>(s.owner, 'ledger.entry', {
      entryId: reversal.entry!.id,
    });
    expect(storno).toMatchObject({
      treatment: 'ledger.reverse',
      reverses: { entryId: booked.entry!.id, number: entry.number, date: '2026-10-05' },
    });
    expect(storno.evidence.map((file) => file.id)).toEqual([note]);
    // A general entry states its purpose; an agent reads entries too; an unknown one is refused.
    const general = (await s.list<ProposalView>(s.owner, 'proposals.list')).find(
      (proposal) => proposal.subject === 'journal:general:NC-CAPITAL',
    )!;
    const reader = await agent(s, ['ledger.entry']);
    expect(
      await s.invoke<Entry>(reader, 'ledger.entry', { entryId: general.entry!.id }),
    ).toMatchObject({ purpose: 'general', treatment: 'ledger.general' });
    expect(
      (
        await s.refused(
          s.invoke(s.owner, 'ledger.entry', { entryId: '00000000-0000-4000-8000-000000000001' }),
        )
      )?.code,
    ).toBe('NOT_FOUND');
  });
});

describe('documents.list', () => {
  test('filters by date and booking, pages, and names the partner and the entry', async () => {
    const { s } = await trading();
    const imported: { id: string }[] = [];
    for (const [number, date] of [
      ['F-1', '2026-09-10'],
      ['F-2', '2026-10-05'],
      ['F-3', '2026-10-20'],
    ] as const) {
      const { id } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
        filename: `${number}.xml`,
        mediaType: 'application/xml',
        base64: Buffer.from(invoiceXml({ number, date })).toString('base64'),
      });
      imported.push(await s.invoke<{ id: string }>(s.owner, 'invoices.import', { evidenceId: id }));
    }
    const booked = await s.book('invoices.recognize', {
      documentId: imported[1]!.id,
      account: '628',
    });
    type Listed = {
      id: string;
      number: string;
      date: string;
      party: { id: string; name: string } | null;
      booked: boolean;
      entryId: string | null;
    };
    const page = (input: Record<string, unknown> = {}) =>
      s.invoke<{ items: Listed[]; next: string | null }>(s.owner, 'documents.list', input);
    // As before, every document at once, now with its partner and booking.
    const all = await page();
    expect(all.next).toBeNull();
    expect(all.items.map((item) => [item.number, item.booked, item.entryId])).toEqual([
      ['F-1', false, null],
      ['F-2', true, booked.entry!.id],
      ['F-3', false, null],
    ]);
    expect(all.items[0]!.party?.name).toBe('Companie 87654321');
    expect(
      (await page({ from: '2026-10-01', to: '2026-10-31' })).items.map((item) => item.number),
    ).toEqual(['F-2', 'F-3']);
    expect((await page({ booked: 'booked' })).items.map((item) => item.number)).toEqual(['F-2']);
    expect((await page({ booked: 'unbooked' })).items.map((item) => item.number)).toEqual([
      'F-1',
      'F-3',
    ]);
    const first = await page({ limit: 2 });
    expect(first.items.map((item) => item.number)).toEqual(['F-1', 'F-2']);
    expect(first.next).toBe(`2026-10-05|${imported[1]!.id}`);
    const second = await page({ limit: 2, after: first.next });
    expect(second.items.map((item) => item.number)).toEqual(['F-3']);
    expect(second.next).toBeNull();
  });
});

describe('the person step of a missing fact', () => {
  test('a proposal waiting on a company fact: a person records it, then the proposal is revised', async () => {
    const s = await company();
    const anaf = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
      kind: 'ro_public_institution',
      country: 'RO',
      name: 'Administrația fiscală',
    });
    const blocked = await s.propose('tax.distribute', { authorityId: anaf.id, date: '2026-11-10' });
    expect(blocked.issues.map((issue) => issue.code)).toContain('TAX_FACILITIES');
    const needed = async (actor: Actor = s.owner) =>
      (
        await s.invoke<{ items: WorkItem[] }>(actor, 'work.list', {
          kinds: ['question.needed'],
          limit: 200,
        })
      ).items.find((item) => item.subject.id === blocked.id)!;
    const asking = await needed();
    expect(asking.next.map((step) => [step.operation, step.by])).toEqual([
      ['questions.ask', 'agent'],
      ['profile.record', 'human'],
    ]);
    expect(asking.next[1]).toMatchObject({
      allowed: true,
      complete: false,
      missing: ['value'],
      inputHint: { axis: 'tax.facilities', effectiveFrom: '2026-11-10' },
    });
    expect(
      (await needed(s.viewer)).next.find((step) => step.operation === 'profile.record'),
    ).toMatchObject({ allowed: false, reason: { kind: 'role', permission: 'review' } });
    // Recorded, the fact settles the question: the proposal is to be revised.
    await s.invoke(s.owner, 'profile.record', { ...asking.next[1]!.inputHint, value: 'none' });
    const settled = await needed();
    expect(settled.message).toBe(
      `Faptele de care depinde propunerea ${'Distribuirea plății fiscale'} sunt înregistrate: revizuiți-o.`,
    );
    expect(settled.next).toMatchObject([
      { operation: 'proposals.revise', by: 'agent', inputHint: { proposalId: blocked.id } },
    ]);
    expect(settled.next[0]!.inputHint).not.toHaveProperty('basis');
    const revised = await s.revise('tax.distribute', blocked, {
      authorityId: anaf.id,
      date: '2026-11-10',
    });
    expect(revised.issues.map((issue) => issue.code)).not.toContain('TAX_FACILITIES');
  });
});

describe('ledger.entry, more', () => {
  test('a reader without pay or health access reads an entry as the journal shows it', async () => {
    const { s, note } = await trading();
    const employee = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
      kind: 'ro_individual',
      country: 'RO',
      name: 'Angajat Sintetic',
    });
    const payroll = await s.book(
      'ledger.general',
      journal(
        note,
        [
          { account: '641', side: 'D', amount: '3000.00' },
          { account: '421', side: 'C', amount: '3000.00', newItem: 'e' },
        ],
        {
          date: '2026-10-31',
          reference: 'NC-SALARII',
          newItems: [{ ref: 'e', partyId: employee.id }],
        },
      ),
    );
    const paid = await s.book(
      'ledger.general',
      journal(
        note,
        [
          {
            account: '421',
            side: 'D',
            amount: '3000.00',
            openItem: payroll.effect!.openItems[0]!.id,
            partyId: employee.id,
          },
          { account: '5121', side: 'C', amount: '3000.00' },
        ],
        { date: '2026-11-05', reference: 'NC-PLATA' },
      ),
    );
    type Shown = {
      description: string;
      redacted?: true;
      lines: {
        account: string;
        amount: Money | null;
        partyId: string | null;
        partyName: string | null;
        includes?: string[];
      }[];
    };
    const owner = await s.invoke<Shown>(s.owner, 'ledger.entry', { entryId: paid.entry!.id });
    expect(owner.redacted).toBeUndefined();
    expect(owner.lines[0]).toMatchObject({
      account: '421',
      amount: { minor: '300000', currency: 'RON' },
      partyName: 'Angajat Sintetic',
    });
    // A viewer may read neither pay nor health: the payment of one person's pay without its
    // amounts or the person, and the payroll's sick pay folded into 641.
    const payment = await s.invoke<Shown>(s.viewer, 'ledger.entry', { entryId: paid.entry!.id });
    expect(payment.redacted).toBe(true);
    expect(payment.description).not.toBe(owner.description);
    expect(payment.lines.map((line) => [line.account, line.amount, line.partyId])).toEqual([
      ['421', null, null],
      ['5121', null, null],
    ]);
    const run = await s.invoke<Shown>(s.viewer, 'ledger.entry', { entryId: payroll.entry!.id });
    expect(run.lines.map((line) => [line.account, line.partyName, line.includes])).toEqual([
      ['641', null, ['4382']],
      ['421', null, undefined],
    ]);
  });

  test('the files a posted input names at any depth', async () => {
    const s = await company({ cui: '18547290', clock: () => Date.UTC(2027, 0, 10, 10) });
    for (const [axis, value] of [
      ['vat.status', 'normal_vat'],
      ['income_tax', 'micro'],
      ['employer', 'yes'],
    ] as const)
      await s.invoke(s.owner, 'profile.record', { axis, value, effectiveFrom: '2026-01-01' });
    const { id: rates } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: 'nbrfxrates.xml',
      mediaType: 'application/xml',
      base64: Buffer.from(
        `<?xml version="1.0" encoding="utf-8"?>
<DataSet xmlns="http://www.bnr.ro/xsd"><Header><Publisher>National Bank of Romania</Publisher><PublishingDate>2025-12-31</PublishingDate><MessageType>DR</MessageType></Header>
<Body><Subject>Reference rates</Subject><OrigCurrency>RON</OrigCurrency>
<Cube date="2025-12-31"><Rate currency="EUR">5.0800</Rate></Cube>
</Body></DataSet>`,
      ).toString('base64'),
    });
    await s.invoke(s.owner, 'fx.importBnr', { evidenceId: rates });
    const anaf = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
      kind: 'ro_public_institution',
      country: 'RO',
      name: 'ANAF',
    });
    await s.book(
      'ledger.general',
      journal(
        (await s.evidence('nota.pdf')).id,
        [
          { account: '5121', side: 'D', amount: '200.00' },
          { account: '7588', side: 'C', amount: '200.00' },
        ],
        { date: '2026-11-20' },
      ),
    );
    const { id: analysis } = await s.evidence('analiza-7588.pdf');
    const proposal = await s.propose('tax.micro', {
      quarter: '2026-Q4',
      date: '2026-12-31',
      authorityId: anaf.id,
      determinations: [{ account: '7588', letter: null, excluded: '0', evidenceId: analysis }],
    });
    const posted = await s.post(
      await s.approve(
        proposal,
        s.reviewer,
        proposal.issues.filter((issue) => issue.severity === 'ack').map((issue) => issue.code),
      ),
    );
    const entry = await s.invoke<{ evidence: { id: string; filename: string | null }[] }>(
      s.owner,
      'ledger.entry',
      { entryId: posted.entry!.id },
    );
    expect(entry.evidence).toContainEqual(
      expect.objectContaining({ id: analysis, filename: 'analiza-7588.pdf' }),
    );
  });
});

describe('documents.list, more', () => {
  test('pages through documents of one date by id, and a booking reversed is no booking', async () => {
    const { s, note } = await trading();
    const ids: string[] = [];
    for (const number of ['G-1', 'G-2', 'G-3']) {
      const { id } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
        filename: `${number}.xml`,
        mediaType: 'application/xml',
        base64: Buffer.from(invoiceXml({ number, date: '2026-10-07' })).toString('base64'),
      });
      ids.push((await s.invoke<{ id: string }>(s.owner, 'invoices.import', { evidenceId: id })).id);
    }
    type Listed = { id: string; booked: boolean; entryId: string | null };
    const page = (input: Record<string, unknown>) =>
      s.invoke<{ items: Listed[]; next: string | null }>(s.owner, 'documents.list', input);
    const seen: string[] = [];
    let after: string | undefined;
    for (let round = 0; round < 5; round++) {
      const found = await page({ limit: 1, ...(after ? { after } : {}) });
      seen.push(...found.items.map((item) => item.id));
      if (!found.next) break;
      after = found.next;
    }
    expect(seen).toEqual([...ids].sort());
    const state = async (id: string) =>
      (await page({})).items.find((item) => item.id === id)!.booked;
    // Proposed and withdrawn, or proposed and not posted: not booked.
    const withdrawn = await s.propose('invoices.recognize', { documentId: ids[0], account: '628' });
    expect(await state(ids[0]!)).toBe(false);
    await s.invoke(s.owner, 'proposals.withdraw', {
      proposalId: withdrawn.id,
      reason: 'Contul de cheltuieli a fost ales greșit',
    });
    expect(await state(ids[0]!)).toBe(false);
    // Posted, booked; its entry reversed, not booked any more.
    const booked = await s.book('invoices.recognize', { documentId: ids[1], account: '628' });
    expect(await state(ids[1]!)).toBe(true);
    await s.book('ledger.reverse', {
      entryId: booked.entry!.id,
      date: '2026-10-20',
      reason: 'Factura a fost înregistrată din eroare',
      evidenceId: note,
      method: 'red',
    });
    expect(await state(ids[1]!)).toBe(false);
    expect((await page({ booked: 'booked' })).items.map((item) => item.id)).not.toContain(ids[1]);
  });
});

describe('second review', () => {
  test('a fact recorded on another axis, or one of an earlier year, settles no question', async () => {
    const s = await company();
    for (const [axis, value, effectiveFrom] of [
      ['vat.status', 'normal_vat', '2025-01-01'],
      ['vat.prorata', '50', '2025-01-01'],
    ] as const)
      await s.invoke(s.owner, 'profile.record', { axis, value, effectiveFrom });
    const proposal = await s.propose('vat.proRata', {
      year: 2026,
      date: '2026-12-31',
      evidenceId: (await s.evidence('notificare-prorata.pdf')).id,
    });
    const asked = proposal.issues.find(
      (issue) =>
        (issue.details as { question?: { kind?: string } } | undefined)?.question?.kind ===
        'profile.fact',
    );
    expect(asked).toBeDefined();
    const needed = async () =>
      (
        await s.invoke<{ items: WorkItem[] }>(s.owner, 'work.list', {
          kinds: ['question.needed'],
          limit: 200,
        })
      ).items.find((item) => item.subject.id === proposal.id)!;
    const steps = async () => (await needed()).next.map((step) => step.operation);
    expect(await steps()).toEqual(['questions.ask', 'profile.record']);
    // Another axis recorded: the 2026 pro-rata is still to be stated.
    await s.invoke(s.owner, 'profile.record', {
      axis: 'employer',
      value: 'no',
      effectiveFrom: '2026-01-01',
    });
    expect(await steps()).toEqual(['questions.ask', 'profile.record']);
    expect((await needed()).details.questions).toMatchObject([{ state: 'unasked' }]);
    // The 2026 pro-rata recorded: the proposal is to be revised.
    const record = (await needed()).next.find((step) => step.operation === 'profile.record')!;
    expect(record.inputHint).toEqual({ axis: 'vat.prorata', effectiveFrom: '2026-01-01' });
    await s.invoke(s.owner, 'profile.record', { ...record.inputHint, value: '60' });
    expect(await steps()).toEqual(['proposals.revise']);
    expect((await needed()).details.questions).toMatchObject([{ state: 'recorded' }]);
  });

  test('the held proposal’s own input previews as proposing returns it: stored, before any basis or evaluation', async () => {
    const { s, note } = await trading();
    const input = journal(
      note,
      [
        { account: '628', side: 'D', amount: '42.00' },
        { account: '5121', side: 'C', amount: '42.00' },
      ],
      { date: '2026-11-04', reference: 'NC-HELD' },
    );
    const held = await s.propose('ledger.general', input);
    const request = {
      treatment: 'ledger.general',
      input,
      basis: { answers: ['00000000-0000-4000-8000-00000000abcd'] },
    };
    const proposed = await s.invoke<ProposalView>(s.owner, 'proposals.propose', request);
    expect(proposed.id).toBe(held.id);
    const preview = await s.invoke<{
      effect: ProposalView['effect'];
      issues: ProposalView['issues'];
      blocking: boolean;
      totals: unknown;
    }>(s.owner, 'proposals.preview', request);
    const stored = await s.invoke<ProposalView>(s.owner, 'proposals.get', { id: held.id });
    expect(preview.effect).toEqual(stored.effect);
    expect(preview.issues).toEqual(stored.issues);
    expect(preview.totals).toEqual([
      { currency: 'RON', debit: '4200', credit: '4200', difference: '0' },
    ]);

    // A fact recorded since: proposing returns the stored issues, and so does the preview.
    const anaf = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
      kind: 'ro_public_institution',
      country: 'RO',
      name: 'Administrația fiscală',
    });
    const distribution = { authorityId: anaf.id, date: '2026-11-10' };
    const blocked = await s.propose('tax.distribute', distribution);
    expect(blocked.issues.map((issue) => issue.code)).toContain('TAX_FACILITIES');
    await s.invoke(s.owner, 'profile.record', {
      axis: 'tax.facilities',
      value: 'none',
      effectiveFrom: '2026-11-10',
    });
    const again = { treatment: 'tax.distribute', input: distribution };
    const returned = await s.invoke<ProposalView>(s.owner, 'proposals.propose', again);
    const previewed = await s.invoke<{ issues: ProposalView['issues']; blocking: boolean }>(
      s.owner,
      'proposals.preview',
      again,
    );
    expect(returned.id).toBe(blocked.id);
    expect(previewed.issues).toEqual(returned.issues);
    expect(previewed.issues.map((issue) => issue.code)).toContain('TAX_FACILITIES');
    expect(previewed.blocking).toBe(true);
  });
});
