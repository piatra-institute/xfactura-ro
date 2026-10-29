import { afterAll, expect, test } from 'bun:test';
import type { ProposalView } from '../../source/engine/kernel/views';
import type { ActionView } from '../../source/engine/kernel/actions';
import { journal, scenario, type Scenario } from './scenario';

// K3 exit criterion: a company with 100,000 posted lines closes each month in under a second,
// through the full request → approve → execute review. Run with `bun run test:perf`.
let s: Scenario;
afterAll(async () => s?.dispose());

test('closes each month of a 100,000-line year in under a second', async () => {
  s = await scenario();
  const { id: evidenceId } = await s.evidence();
  const expense = (month: number, index: number, size: number) =>
    journal(
      evidenceId,
      [
        ...Array.from({ length: size - 1 }, (_, line) => ({
          account: line % 2 ? '628' : '627',
          side: 'D' as const,
          amount: `${(line % 97) + 1}.${String(line % 100).padStart(2, '0')}`,
        })),
        {
          account: '5121',
          side: 'C' as const,
          amount: (
            Array.from(
              { length: size - 1 },
              (_, line) => ((line % 97) + 1) * 100 + (line % 100),
            ).reduce((a, b) => a + b, 0) / 100
          ).toFixed(2),
        },
      ],
      {
        date: `2026-${String(month).padStart(2, '0')}-${String(10 + (index % 15)).padStart(2, '0')}`,
        reference: `NC-${month}-${index}`,
      },
    );
  const sample = await s.propose('ledger.general', expense(1, 999, 3));
  await s.invoke(s.owner, 'proposals.withdraw', {
    proposalId: sample.id,
    reason: 'Exemplu pentru politică',
  });
  await s.invoke(s.reviewer, 'policies.create', {
    name: 'Încărcare sintetică',
    treatments: ['ledger.general'],
    rulesHashes: [sample.rulesHash],
    preconditions: [],
    validFrom: '2026-01-01',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });

  const started = performance.now();
  let lines = 0;
  for (let month = 1; month <= 12; month++)
    for (let index = 0; index < 10; index++) {
      const posted = await s.propose('ledger.general', expense(month, index, 834));
      expect(posted.status).toBe('posted' satisfies ProposalView['status']);
      lines += 834;
    }
  const loading = performance.now() - started;
  expect(lines).toBeGreaterThanOrEqual(100_000);

  const timings: number[] = [];
  for (let month = 1; month <= 12; month++) {
    const monthStarted = performance.now();
    const closed = await s.closeApproved(`2026-${String(month).padStart(2, '0')}`);
    timings.push(performance.now() - monthStarted);
    expect(closed.status).toBe('executed' satisfies ActionView['status']);
  }
  const balance = await s.trialBalance();
  expect(balance.totals.current.debit).toBe(balance.totals.current.credit);
  console.log(
    `posted ${lines} lines in ${(loading / 1000).toFixed(1)} s; month close: max ${Math.max(...timings).toFixed(0)} ms, ` +
      `mean ${(timings.reduce((a, b) => a + b, 0) / timings.length).toFixed(0)} ms; ` +
      `rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MiB`,
  );
  expect(Math.max(...timings)).toBeLessThan(1000);
}, 600_000);
