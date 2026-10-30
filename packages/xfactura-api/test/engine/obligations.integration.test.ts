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
    (await s.invoke<Obligation[]>(s.owner, 'obligations.calendar', { from, to, today })).map(
      (item) => `${item.kind} ${item.period} ${item.due ?? '-'} ${item.status}`,
    );
  return { s, calendar };
}

describe('obligations calendar', () => {
  test('a monthly VAT payer, employer and microenterprise: what applies, when it is due, where it stands', async () => {
    const { calendar } = await company({
      'vat.status': 'normal_vat',
      employer: 'yes',
      income_tax: 'micro',
    });
    expect(await calendar('2026-09', '2026-11')).toEqual([
      // 25 October 2026 is a Sunday; on the 27th these are overdue.
      'D100 2026-09 2026-10-26 overdue',
      'D112 2026-09 2026-10-26 overdue',
      'D300 2026-09 2026-10-26 overdue',
      // 31 October is a Saturday.
      'D406 2026-09 2026-11-02 due',
      'D112 2026-10 2026-11-25 due',
      'D300 2026-10 2026-11-25 due',
      // 30 November and 1 December are public holidays.
      'D406 2026-10 2026-12-02 due',
      // Due on 25 December, so on 21 December.
      'D112 2026-11 2026-12-21 due',
      'D300 2026-11 2026-12-21 due',
      'D406 2026-11 2026-12-31 due',
      // D394's deadline in force is not sourced: blocked, never guessed.
      'D394 2026-09 - blocked',
      'D394 2026-10 - blocked',
      'D394 2026-11 - blocked',
    ]);
  });

  test('a company outside VAT files D406 quarterly, and its statements 150 days after the year', async () => {
    const { calendar } = await company({});
    expect(await calendar('2026-07', '2026-12', '2026-10-01')).toEqual([
      'D406 2026-Q3 2026-11-02 due',
      // 31 January 2027 is a Sunday; 30 May 2027 too.
      'D406 2026-Q4 2027-02-01 due',
      'S1005 2026 2027-05-31 due',
    ]);
  });
});
