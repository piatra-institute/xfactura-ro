import { afterAll, describe, expect, test } from 'bun:test';
import { and, desc, eq } from 'drizzle-orm';
import { parseMoney } from 'xfactura-core/money';
import { periodBalances, periodEvents } from '../../source/engine/db/schema';
import type { ActionView } from '../../source/engine/kernel/actions';
import { journal, scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
const fresh = async () => {
  const s = await scenario();
  open.push(s);
  return s;
};
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

const monthEnd = (month: string) => {
  const [year, number] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
};

/** A month's closing balances as its latest close recorded them, null when it is not closed. */
async function snapshot(s: Scenario, month: string) {
  return s.db.read(async (tx) => {
    const [event] = await tx
      .select({ kind: periodEvents.kind, seq: periodEvents.seq })
      .from(periodEvents)
      .where(and(eq(periodEvents.companyId, s.company.id), eq(periodEvents.month, month)))
      .orderBy(desc(periodEvents.seq))
      .limit(1);
    if (event?.kind !== 'close') return null;
    const rows = await tx
      .select()
      .from(periodBalances)
      .where(
        and(
          eq(periodBalances.companyId, s.company.id),
          eq(periodBalances.month, month),
          eq(periodBalances.closeSeq, event.seq),
        ),
      );
    return Object.fromEntries(
      rows
        .filter((row) => row.closingBani !== 0n)
        .map((row) => [row.account, row.closingBani.toString()]),
    );
  });
}

/** The same balances from the trial balance, which reads every line dated up to the month's end. */
async function ledger(s: Scenario, month: string, financialYearId = s.year.id) {
  const balance = await s.invoke<Awaited<ReturnType<Scenario['trialBalance']>>>(
    s.owner,
    'ledger.trialBalance',
    { financialYearId, to: monthEnd(month) },
  );
  return Object.fromEntries(
    balance.rows
      .map(
        (row) =>
          [
            row.account,
            parseMoney(row.closing.debit, 'RON') - parseMoney(row.closing.credit, 'RON'),
          ] as const,
      )
      .filter(([, bani]) => bani !== 0n)
      .map(([account, bani]) => [account, bani.toString()]),
  );
}

const findings = (request: ActionView) =>
  (request.preview as { findings: { code: string; severity: string }[] }).findings;
const blocking = (request: ActionView) =>
  findings(request)
    .filter((item) => item.severity === 'block')
    .map((item) => item.code);

async function decide(s: Scenario, request: ActionView) {
  await s.invoke(s.reviewer, 'actions.approve', {
    id: request.id,
    previewHash: request.previewHash,
  });
  return s.invoke<ActionView>(s.reviewer, 'actions.execute', { id: request.id });
}
const reopen = (s: Scenario, month: string) =>
  s.invoke<ActionView>(s.owner, 'periods.reopen.request', {
    month,
    reason: 'Document primit după închidere',
  });
async function reopenApproved(s: Scenario, month: string) {
  return decide(s, await reopen(s, month));
}

/**
 * Proposes an expense on the date and posts it unless its proposal is blocked; a blocked one is
 * withdrawn, so it holds no month's close. The blocking codes, empty when it was posted.
 */
async function attempt(
  s: Scenario,
  date: string,
  amount: string,
  [debit, credit]: readonly [string, string] = ['628', '5121'],
) {
  const proposal = await s.propose(
    'ledger.general',
    journal(
      (await s.evidence()).id,
      [
        { account: debit, side: 'D', amount },
        { account: credit, side: 'C', amount },
      ],
      { date },
    ),
  );
  const blocked = proposal.issues
    .filter((issue) => issue.severity === 'block')
    .map((issue) => issue.code);
  if (blocked.length)
    await s.invoke(s.owner, 'proposals.withdraw', {
      proposalId: proposal.id,
      reason: 'Luna nu mai primește înregistrări',
    });
  else await s.post(await s.approve(proposal));
  return blocked;
}

describe('a close covers every earlier month', () => {
  test('an empty month left open before a closed one takes no entry a later close would miss', async () => {
    const s = await fresh();
    expect(await attempt(s, '2026-01-10', '100.00')).toEqual([]);
    expect(await attempt(s, '2026-03-10', '30.00')).toEqual([]);
    await s.closeApproved('2026-01');
    // Approved before the close, which then makes it stale: posting evaluates it again.
    const approved = await s.approve(
      await s.propose(
        'ledger.general',
        journal(
          (await s.evidence()).id,
          [
            { account: '628', side: 'D', amount: '9.00' },
            { account: '5121', side: 'C', amount: '9.00' },
          ],
          { date: '2026-02-20' },
        ),
      ),
    );
    // February is empty: nothing asks it closed before March.
    expect((await s.closeApproved('2026-03')).status).toBe('executed');
    // Nor does the worklist after: March's close covers it.
    const work = await s.invoke<{ items: { kind: string; period: string | null }[] }>(
      s.owner,
      'work.list',
      { limit: 200, kinds: ['period.unclosed', 'close.finding'] },
    );
    expect(work.items.filter((item) => item.period === '2026-02')).toEqual([]);
    const stale = await s.refused(s.post(approved));
    expect(stale?.code).toBe('STALE');
    expect((stale?.details as { issues: { code: string }[] }).issues.map((i) => i.code)).toEqual([
      'LATER_CLOSED',
    ]);
    await s.invoke(s.owner, 'proposals.withdraw', {
      proposalId: approved.id,
      reason: 'Luna nu mai primește înregistrări',
    });
    const late = await attempt(s, '2026-02-15', '7.00');
    // An entry in February would ask February closed before April; it closes empty either way.
    expect((await s.closeApproved('2026-02')).status).toBe('executed');
    expect((await s.closeApproved('2026-04')).status).toBe('executed');
    // March's balances, and April's from them, would miss an entry dated in February after
    // March closed.
    for (const month of ['2026-02', '2026-03', '2026-04'])
      expect(await snapshot(s, month)).toEqual(await ledger(s, month));
    expect(late).toEqual(['LATER_CLOSED']);
  });

  test('a later close starts from the latest month still closed, not from a reopened one', async () => {
    const s = await fresh();
    await attempt(s, '2026-01-10', '100.00');
    await s.closeApproved('2026-01');
    await s.closeApproved('2026-02');
    await reopenApproved(s, '2026-02');
    await reopenApproved(s, '2026-01');
    expect(await attempt(s, '2026-01-20', '40.00')).toEqual([]);
    await s.closeApproved('2026-01');
    // February's first close, reopened since, holds January's balances before the 40.00.
    expect((await s.closeApproved('2026-03')).status).toBe('executed');
    expect(await snapshot(s, '2026-03')).toEqual(await ledger(s, '2026-03'));
    expect(await snapshot(s, '2026-03')).toEqual({ '628': '14000', '5121': '-14000' });
  });

  test('a month reopens only after every later closed month, empty ones included', async () => {
    const s = await fresh();
    await attempt(s, '2026-01-10', '100.00');
    await s.closeApproved('2026-01');
    await s.closeApproved('2026-02');
    expect(blocking(await reopen(s, '2026-01'))).toEqual(['LATER_CLOSED']);
    await reopenApproved(s, '2026-02');
    await reopenApproved(s, '2026-01');
    await attempt(s, '2026-01-20', '40.00');
    for (const month of ['2026-01', '2026-02', '2026-03'])
      expect((await s.closeApproved(month)).status).toBe('executed');
    for (const month of ['2026-01', '2026-02', '2026-03'])
      expect(await snapshot(s, month)).toEqual(await ledger(s, month));
  });
});

describe('the year-end entries', () => {
  test('the closing journal goes into a December left open, until a later month closes', async () => {
    const s = await fresh();
    await attempt(s, '2026-11-10', '1000.00', ['5121', '704']);
    await attempt(s, '2026-11-12', '400.00', ['628', '5121']);
    await s.closeApproved('2026-11');
    const next = await s.invoke<{ id: string }>(s.owner, 'years.create', {
      kind: 'financial',
      label: '2027',
      from: '2027-01-01',
      to: '2027-12-31',
    });
    await attempt(s, '2027-01-15', '50.00');
    // December is empty, so January closes without it, and covers it.
    expect((await s.closeApproved('2027-01')).status).toBe('executed');
    const input = { yearEnd: '2026-12-31', evidenceId: (await s.evidence('nota.pdf')).id };
    const refused = await s.propose('year.closeResult', input);
    expect(refused.issues.map((issue) => issue.code)).toEqual(['LATER_CLOSED']);
    await s.invoke(s.owner, 'proposals.withdraw', {
      proposalId: refused.id,
      reason: 'Se redeschide ianuarie',
    });
    // January reopened, December takes the year-end entries again.
    await reopenApproved(s, '2027-01');
    const closing = await s.book('year.closeResult', input);
    expect(closing.status).toBe('posted');
    await s.closeApproved('2026-12');
    await s.closeApproved('2027-01');
    expect(await snapshot(s, '2026-12')).toEqual(await ledger(s, '2026-12'));
    expect(await snapshot(s, '2027-01')).toEqual(await ledger(s, '2027-01', next.id));
    expect(await snapshot(s, '2027-01')).toEqual({
      '121': '-60000',
      '5121': '55000',
      '628': '5000',
    });
  });
});

/** A small deterministic generator (mulberry32), so a failing sequence repeats. */
function generator(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

describe('postings, closes and reopens in any order', () => {
  const months = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];
  const pairs = [
    ['628', '5121'],
    ['627', '5121'],
    ['5121', '1012'],
  ] as const;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8])
    test(`sequence ${seed}: every close's balances are the trial balance's`, async () => {
      const s = await fresh();
      const random = generator(seed);
      const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
      // The model: the months closed now, and those with entries.
      const closed = new Set<string>();
      const booked = new Set<string>();
      const latest = () => [...closed].sort().at(-1) ?? '';
      // What the model allows, chosen more often than chance would, so that sequences keep
      // closing and reopening; any month otherwise, to be refused. Few postings leave months
      // empty, closed and reopened between others: four of these sequences fail when a close
      // starts from a reopened month's old balances.
      const allowed = {
        post: () => months.filter((month) => month > latest()),
        close: () =>
          months.filter(
            (month) =>
              !closed.has(month) &&
              ![...booked].some((other) => other < month && !closed.has(other)),
          ),
        reopen: () => (closed.size ? [latest()] : []),
      };
      const choose = (action: keyof typeof allowed) => {
        const candidates = allowed[action]();
        return candidates.length && random() < 0.6 ? pick(candidates) : pick(months);
      };
      for (let step = 0; step < 100; step++) {
        const roll = random();
        const month = choose(roll < 0.2 ? 'post' : roll < 0.55 ? 'close' : 'reopen');
        if (roll < 0.2) {
          const date = `${month}-${String(1 + Math.floor(random() * 28)).padStart(2, '0')}`;
          const amount = `${1 + Math.floor(random() * 900)}.${String(Math.floor(random() * 100)).padStart(2, '0')}`;
          const refused = await attempt(s, date, amount, pick(pairs));
          expect(refused).toEqual(
            closed.has(month)
              ? ['PERIOD_CLOSED']
              : [...closed].some((other) => other > month)
                ? ['LATER_CLOSED']
                : [],
          );
          if (!refused.length) booked.add(month);
        } else if (roll < 0.55) {
          const request = await s.close(month);
          const expected = [
            ...(closed.has(month) ? ['PERIOD_CLOSED'] : []),
            ...([...booked].some((other) => other < month && !closed.has(other))
              ? ['EARLIER_OPEN']
              : []),
          ];
          expect(blocking(request)).toEqual(expected);
          if (expected.length) continue;
          expect((await decide(s, request)).status).toBe('executed');
          closed.add(month);
          expect(await snapshot(s, month)).toEqual(await ledger(s, month));
        } else {
          const request = await reopen(s, month);
          const expected = [
            ...(closed.has(month) ? [] : ['PERIOD_OPEN']),
            ...([...closed].some((other) => other > month) ? ['LATER_CLOSED'] : []),
          ];
          expect(blocking(request)).toEqual(expected);
          if (expected.length) continue;
          expect((await decide(s, request)).status).toBe('executed');
          closed.delete(month);
        }
      }
      // Each month still closed: its latest close holds every line up to its end.
      for (const month of months)
        if (closed.has(month)) expect(await snapshot(s, month)).toEqual(await ledger(s, month));
        else expect(await snapshot(s, month)).toBeNull();
      expect(
        (await s.list<{ month: string; state: string }>(s.owner, 'periods.list'))
          .filter((item) => item.state === 'closed')
          .map((item) => item.month),
      ).toEqual(months.filter((month) => closed.has(month)));
    }, 120_000);
});
