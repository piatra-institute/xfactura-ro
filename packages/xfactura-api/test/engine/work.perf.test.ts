import { afterAll, expect, test } from 'bun:test';
import type { ProposalView } from '../../source/engine/kernel/views';
import type { WorkItem } from '../../source/engine/kernel/work';
import { iban, mt940 } from './fixtures/bank';
import { invoiceXml } from './fixtures/invoice';
import { journal, scenario, type Scenario } from './scenario';

// The worklist is computed on read: each page of `work.list` stays under 300 ms for a company
// with 100,000 posted lines and every month of the year open. Run with `bun run test:perf`.
let s: Scenario;
afterAll(async () => s?.dispose());

test('lists the work of a 100,000-line year in pages under 300 ms', async () => {
  s = await scenario({ clock: () => Date.UTC(2026, 10, 10, 10) });
  await s.invoke(s.owner, 'profile.record', {
    axis: 'vat.status',
    value: 'normal_vat',
    effectiveFrom: '2026-01-01',
    evidenceId: (await s.evidence('certificat.pdf')).id,
  });
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
    expiresAt: s.expiresIn(1),
  });

  const started = performance.now();
  let lines = 0;
  for (let month = 1; month <= 12; month++)
    for (let index = 0; index < 10; index++) {
      const posted = await s.propose('ledger.general', expense(month, index, 834));
      expect(posted.status).toBe('posted' satisfies ProposalView['status']);
      lines += 834;
    }
  expect(lines).toBeGreaterThanOrEqual(100_000);
  // Work of every kind beside the books: a statement nobody explained, invoices nobody booked,
  // files nobody read, proposals waiting on a person.
  await s.invoke(s.owner, 'treasury.createAccount', {
    kind: 'bank',
    name: 'Cont curent',
    iban,
    currency: 'RON',
    ledgerAccount: '5121',
    openedOn: '2026-01-01',
  });
  const { id: statement } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
    filename: 'extras.sta',
    mediaType: 'text/plain',
    base64: Buffer.from(mt940).toString('base64'),
  });
  await s.invoke(s.owner, 'bank.import', { evidenceId: statement, financialYearId: s.year.id });
  for (let index = 0; index < 40; index++) {
    const { id } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: `F-${index}.xml`,
      mediaType: 'application/xml',
      base64: Buffer.from(
        invoiceXml({
          number: `F-${index}`,
          date: `2026-10-${String(1 + (index % 28)).padStart(2, '0')}`,
        }),
      ).toString('base64'),
    });
    await s.invoke(s.owner, 'invoices.import', { evidenceId: id });
    await s.evidence(`scrisoare-${index}.pdf`);
  }
  await s.invoke(s.reviewer, 'policies.revoke', {
    id: (await s.list<{ id: string }>(s.owner, 'policies.list'))[0]!.id,
    reason: 'Încărcarea sintetică s-a încheiat.',
  });
  for (let index = 0; index < 40; index++)
    await s.propose('ledger.general', expense(11, 100 + index, 3));
  const loading = performance.now() - started;

  const timings: number[] = [];
  const seen: WorkItem[] = [];
  let after: string | null = null;
  for (;;) {
    const pageStarted = performance.now();
    const page: { items: WorkItem[]; next: string | null } = await s.invoke(
      s.owner,
      'work.list',
      after ? { after } : {},
    );
    timings.push(performance.now() - pageStarted);
    seen.push(...page.items);
    if (!page.next) break;
    after = page.next;
  }
  const kinds = new Set<string>(seen.map((item) => item.kind));
  for (const kind of [
    'proposal.awaitingApproval',
    'obligation.due',
    'close.finding',
    'document.unproposed',
    'bank.unexplained',
    'evidence.unused',
  ])
    expect(kinds).toContain(kind);
  const singleStarted = performance.now();
  await s.invoke(s.owner, 'work.get', {
    id: seen.find((item) => item.kind === 'close.finding')!.id,
  });
  const single = performance.now() - singleStarted;
  // The home screen's summary of the same books stays within a page's time: the money, what is
  // owed, the tax position, the next returns, and the work counted until its budget runs out.
  const summaryStarted = performance.now();
  const summary = await s.invoke<{
    cash: { accounts: { balance: { minor: string } }[] };
    work: { total: number; complete: boolean; next: string | null };
    deadlines: unknown[];
  }>(s.owner, 'company.summary');
  const summaryTime = performance.now() - summaryStarted;
  expect(summary.cash.accounts).toHaveLength(1);
  expect(summary.deadlines).toHaveLength(5);
  expect(summary.work.total).toBeGreaterThan(0);
  expect(summary.work.complete).toBe(summary.work.next === null);
  if (summary.work.complete) expect(summary.work.total).toBe(seen.length);
  else expect(summary.work.total).toBeLessThanOrEqual(seen.length);
  console.log(
    `company.summary ${summaryTime.toFixed(0)} ms, work ${summary.work.total} of ${seen.length} items${summary.work.complete ? '' : ' (stopped at its budget)'}`,
  );
  expect(summaryTime).toBeLessThan(300);
  console.log(
    `posted ${lines} lines in ${(loading / 1000).toFixed(1)} s; ${seen.length} items in ${timings.length} pages: ` +
      `max ${Math.max(...timings).toFixed(0)} ms, mean ${(timings.reduce((a, b) => a + b, 0) / timings.length).toFixed(0)} ms, ` +
      `first ${timings[0]!.toFixed(0)} ms; work.get ${single.toFixed(0)} ms; ` +
      `rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MiB`,
  );
  expect(Math.max(...timings)).toBeLessThan(300);
  expect(single).toBeLessThan(300);
}, 600_000);
