import { afterAll, expect, test } from 'bun:test';
import type { ProposalView } from '../../source/engine/kernel/views';
import type { ActionView } from '../../source/engine/kernel/actions';
import { journal, scenario, type Scenario } from './scenario';

// K3 exit criterion: a company with 100,000 posted lines closes each month in under a second,
// through the full request → approve → execute review. Run with `bun run test:perf`. The company
// also keeps the stock register (G1): 10,080 stock moves (84 items received ten times a month),
// which the close reconciles with the stock accounts each month. Held to what is reached: each
// month, December's year-end review included, closes in under 500 ms; the year posts in under
// 12 s; and a receipt in December costs less than three times one in January, its positions and
// pools holding a year of moves (the database's checks read them by index, not by scan: before,
// it cost twenty times as much).
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

  // The stock register: 84 items in one warehouse, at the weighted average.
  for (const [axis, value] of Object.entries({
    'policy.stock.valuation': 'average',
    'policy.stock.inventory': 'permanent',
    'policy.stock.negative': 'refuse',
  }))
    await s.invoke(s.owner, 'profile.record', {
      axis,
      value,
      effectiveFrom: '2026-01-01',
      evidenceId,
    });
  const items: string[] = [];
  for (let index = 0; index < 84; index++)
    items.push(
      (
        await s.invoke<{ id: string }>(s.owner, 'stock.items.create', {
          code: `ART-${index}`,
          name: `Articol ${index}`,
          unit: 'H87',
          account: '371',
        })
      ).id,
    );
  const warehouse = await s.invoke<{ id: string }>(s.owner, 'stock.warehouses.create', {
    code: 'D1',
    name: 'Depozit',
    keeper: 'Ionescu Maria',
  });
  const supplier = await s.party('Furnizor SRL', '14399840');
  const receipt = (month: number, index: number) => ({
    date: `2026-${String(month).padStart(2, '0')}-${String(10 + (index % 15)).padStart(2, '0')}`,
    warehouseId: warehouse.id,
    supplierId: supplier.id,
    reference: `AV-${month}-${index}`,
    evidenceId,
    lines: items.map((itemId, line) => ({
      itemId,
      quantity: String((line % 7) + 1),
      value: `${(line % 13) + 1}.00`,
    })),
  });
  const stockSample = await s.propose('stock.receive', receipt(1, 999));
  await s.invoke(s.owner, 'proposals.withdraw', {
    proposalId: stockSample.id,
    reason: 'Exemplu pentru politică',
  });
  await s.invoke(s.reviewer, 'policies.create', {
    name: 'Recepții sintetice',
    treatments: ['stock.receive'],
    rulesHashes: [stockSample.rulesHash],
    preconditions: [],
    validFrom: '2026-01-01',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });

  const started = performance.now();
  let lines = 0;
  let moves = 0;
  const receipts: number[] = [];
  for (let month = 1; month <= 12; month++)
    for (let index = 0; index < 10; index++) {
      const posted = await s.propose('ledger.general', expense(month, index, 834));
      expect(posted.status).toBe('posted' satisfies ProposalView['status']);
      lines += 834;
      const receiptStarted = performance.now();
      const received = await s.propose('stock.receive', receipt(month, index));
      receipts.push(performance.now() - receiptStarted);
      expect(received.status).toBe('posted' satisfies ProposalView['status']);
      moves += received.effect!.stockMoves!.length;
    }
  const loading = performance.now() - started;
  // The first two months' receipts against the last two's (20 each, a median against noise).
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1]!;
  const growth = median(receipts.slice(-20)) / median(receipts.slice(0, 20));
  expect(lines).toBeGreaterThanOrEqual(100_000);
  expect(moves).toBeGreaterThanOrEqual(10_000);

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
    `posted ${lines} lines and ${moves} stock moves in ${(loading / 1000).toFixed(1)} s ` +
      `(a receipt ${median(receipts.slice(0, 20)).toFixed(0)} ms in January, ${median(receipts.slice(-20)).toFixed(0)} ms in December); ` +
      `month close: max ${Math.max(...timings).toFixed(0)} ms, ` +
      `mean ${(timings.reduce((a, b) => a + b, 0) / timings.length).toFixed(0)} ms; ` +
      `rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MiB; ${timings.map((ms) => ms.toFixed(0)).join(' ')}`,
  );
  expect(Math.max(...timings)).toBeLessThan(500);
  expect(loading).toBeLessThan(12_000);
  expect(growth).toBeLessThan(3);
}, 600_000);
