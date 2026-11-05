import { afterAll, describe, expect, test } from 'bun:test';
import { scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

type Obligation = {
  kind: string;
  period: string;
  due: string | null;
  status: string;
  gap: string | null;
};

async function company(profile: Record<string, string>) {
  const s = await scenario();
  open.push(s);
  for (const [axis, value] of Object.entries(profile))
    await s.invoke(s.owner, 'profile.record', {
      axis,
      value,
      effectiveFrom: '2026-01-01',
      evidenceId: (await s.evidence(`${axis}.pdf`)).id,
    });
  const calendar = async (from: string, to: string, today = '2026-10-27') =>
    (await s.list<Obligation>(s.owner, 'obligations.calendar', { from, to, today })).map(
      (item) => `${item.kind} ${item.period} ${item.due ?? '-'} ${item.status}`,
    );
  return { s, calendar };
}

describe('obligations calendar', () => {
  test('a monthly VAT payer, employer and microenterprise: what applies, when it is due, where it stands', async () => {
    const { calendar } = await company({
      'entity.form': 'srl',
      'vat.status': 'normal_vat',
      'vat.period': 'monthly',
      employer: 'yes',
      'payroll.period': 'monthly',
      income_tax: 'micro',
    });
    expect(await calendar('2026-09', '2026-11')).toEqual([
      // 25 October 2026 is a Sunday; on the 27th these are overdue.
      'D100 2026-09 2026-10-26 overdue',
      'D112 2026-09 2026-10-26 overdue',
      'D300 2026-09 2026-10-26 overdue',
      'D394 2026-09 2026-10-30 due',
      // 31 October is a Saturday.
      'D406 2026-09 2026-11-02 due',
      'D112 2026-10 2026-11-25 due',
      'D300 2026-10 2026-11-25 due',
      // 30 November and 1 December are public holidays.
      'D394 2026-10 2026-12-02 due',
      'D406 2026-10 2026-12-02 due',
      // Due on 25 December, so on 21 December.
      'D112 2026-11 2026-12-21 due',
      'D300 2026-11 2026-12-21 due',
      'D394 2026-11 2026-12-30 due',
      'D406 2026-11 2026-12-31 due',
    ]);
    // The deadlines were read through 2026: a later period is blocked, never guessed.
    expect(await calendar('2027-01', '2027-01')).toContain('D300 2027-01 - blocked');
  });

  test('a company outside VAT files D406 quarterly, and its statements 150 days after the year', async () => {
    const { calendar } = await company({
      'entity.form': 'srl',
      'vat.status': 'non_vat',
      'vat.eu': 'none',
      employer: 'no',
      income_tax: 'micro',
      'size.category': 'micro',
    });
    expect(await calendar('2026-07', '2026-12', '2026-10-01')).toEqual([
      'D100 2026-09 2026-10-26 due',
      'D406 2026-Q3 2026-11-02 due',
      'D100 2026-12 2027-01-25 due',
      // 31 January 2027 is a Sunday; 30 May 2027 too.
      'D406 2026-Q4 2027-02-01 due',
      'S1005 2026 2027-05-31 due',
    ]);
  });

  test('a fact nobody recorded blocks the returns that depend on it, naming the question', async () => {
    const { s, calendar } = await company({ 'entity.form': 'srl', employer: 'no' });
    const rows = await calendar('2026-07', '2026-09', '2026-10-01');
    // Whether the company is a VAT payer decides D300, D394 and the period of D406: unknown,
    // they are blocked, never dropped or assumed.
    expect(rows).toContain('D300 2026-07 - blocked');
    expect(rows).toContain('D406 2026-07 - blocked');
    expect(rows).toContain('D100 2026-09 - blocked');
    const items = await s.list<{
      kind: string;
      period: string;
      gap: string | null;
      question: { kind: string; subject: { id: string } } | null;
      basis: { rule: string; facts: string[] };
    }>(s.owner, 'obligations.calendar', { from: '2026-07', to: '2026-07', today: '2026-10-01' });
    expect(items.find((item) => item.kind === 'D300')).toMatchObject({
      question: { kind: 'profile.fact', subject: { id: 'vat.status' } },
      basis: { rule: 'obligation.vat@2026-07', facts: ['vat@2026-07=?', 'vatPeriod@2026-07=?'] },
    });
    // Recording it unblocks them: a non-payer files D406 for the quarter.
    await s.invoke(s.owner, 'profile.record', {
      axis: 'vat.status',
      value: 'non_vat',
      effectiveFrom: '2026-01-01',
      evidenceId: (await s.evidence('vector.pdf')).id,
    });
    expect(await calendar('2026-07', '2026-09', '2026-10-01')).toEqual([
      'D406 2026-Q3 2026-11-02 due',
      'D100 2026-09 - blocked',
    ]);
  });

  test('books from 1 January 2026: nothing before them, nor the annual returns of 2025', async () => {
    // The company's first financial year is 2026 (scenario()), its facts recorded from then.
    const { s, calendar } = await company({
      'entity.form': 'srl',
      'vat.status': 'normal_vat',
      'vat.period': 'monthly',
      employer: 'no',
      income_tax: 'micro',
    });
    const rows = await calendar('2025-10', '2026-03', '2026-01-15');
    expect(rows.filter((row) => row.split(' ')[1]!.startsWith('2025'))).toEqual([]);
    expect(rows).toContain('D300 2026-01 2026-02-25 due');
    expect(rows).toContain('D406 2026-01 2026-03-02 due');
    expect(await calendar('2025-01', '2025-12', '2026-01-15')).toEqual([]);
    const closure = await s.invoke<{ obligations: unknown[]; needs: { fact: string }[] }>(
      s.owner,
      'closure.evaluate',
      { from: '2025-10', to: '2025-12' },
    );
    expect([closure.obligations, closure.needs]).toEqual([[], []]);
  });

  test('a return filed outside the engine is filed; next year’s wait for their rules', async () => {
    const { s, calendar } = await company({
      'entity.form': 'srl',
      'vat.status': 'normal_vat',
      'vat.period': 'monthly',
      employer: 'yes',
      'payroll.period': 'monthly',
      income_tax: 'micro',
    });
    // March's D112, filed through ANAF's portal before the books moved here: a person records
    // it with ANAF's receipt, whatever the return.
    const asked = await s.invoke<{ id: string }>(s.owner, 'questions.ask', {
      kind: 'obligation.filed',
      subject: { kind: 'obligation', id: 'D112/2026-03' },
      params: { kind: 'D112', period: '2026-03' },
    });
    expect(await calendar('2026-03', '2026-03')).toContain('D112 2026-03 2026-04-27 overdue');
    await s.invoke(s.reviewer, 'questions.answer', {
      questionId: asked.id,
      value: {
        registrationNumber: 'INTERNT-400000001-2026',
        submittedOn: '2026-04-24',
        evidenceId: (await s.evidence('recipisa-d112-2026-03.pdf')).id,
      },
    });
    expect(await calendar('2026-03', '2026-03')).toContain('D112 2026-03 2026-04-27 filed');
    // January 2027's returns: blocked, their deadlines' rules beyond the register's horizon, so
    // waiting for the rules of 2027; December's are not.
    const rows = await s.list<{
      kind: string;
      period: string;
      status: string;
      waiting: number | null;
    }>(s.owner, 'obligations.calendar', { from: '2026-12', to: '2027-01', today: '2026-11-10' });
    const waiting = (period: string) =>
      rows
        .filter((row) => row.period === period)
        .map((row) => `${row.kind} ${row.status} ${row.waiting}`);
    expect(waiting('2027-01')).toEqual(
      expect.arrayContaining(['D300 blocked 2027', 'D112 blocked 2027', 'D406 blocked 2027']),
    );
    expect(waiting('2026-12').every((row) => row.endsWith(' null'))).toBe(true);
  });

  test('a PFA: D300 and D394 as for any payer; no D406 (exempt), no S1005 nor D101', async () => {
    const { calendar } = await company({
      'entity.form': 'pfa',
      'vat.status': 'normal_vat',
      'vat.period': 'monthly',
      employer: 'no',
    });
    const rows = await calendar('2026-12', '2026-12', '2026-10-27');
    expect(rows).toContain('D300 2026-12 2027-01-25 due');
    expect(rows.filter((row) => /^(S1005|D101|D100|D406) /.test(row))).toEqual([]);
  });
});
