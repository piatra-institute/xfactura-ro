import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCauses } from '../src/compare/causes';
import { DifferenceStore } from '../src/compare/store';
import type { CompanyFiling } from '../src/mapping/corpus';
import type { Mapping } from '../src/mapping/schema';
import { labAssumptionsSchema } from '../src/run/assumptions';
import { replayCompany } from '../src/run/driver';
import { openReplayEngine } from '../src/run/engine';
import { parseJournalArguments } from '../../../scripts/differential/journal';
import { replayBooksMapping, replayFilings } from './fixtures/replay-books';

const directories: string[] = [];
afterAll(async () => {
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

async function replay(
  filings: CompanyFiling[],
  mapping: Mapping,
  options: {
    store?: DifferenceStore;
    assumptions?: ReturnType<typeof labAssumptionsSchema.parse>;
    to?: string;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'xfactura-replay-'));
  directories.push(root);
  const store = options.store ?? new DifferenceStore(join(root, '.private'), 'synthetic', 'replay');
  const engine = join(root, 'engine');
  await mkdir(engine);
  const result = await replayCompany({
    alias: 'synthetic',
    filings,
    mapping,
    ...(options.assumptions ? { assumptions: options.assumptions } : {}),
    ...(options.to ? { to: options.to } : {}),
    open: (clock) =>
      openReplayEngine(engine, {
        secret: 'synthetic-replay-secret-of-32-chars!',
        seed: 'test',
        clock,
      }),
    store,
    causes: await loadCauses(),
  });
  return {
    result,
    store,
    engine,
    open: (await store.read()).filter((item) => item.status === 'open'),
  };
}

/** The completed run's summary and manifest, as the driver types them. */
function completed(result: Awaited<ReturnType<typeof replayCompany>>) {
  if (result.status !== 'completed') throw new Error('The run was blocked.');
  return result;
}

/** Every row of the replay database but the audit trail: `created_at` columns keep the
 * database's wall time, and the command log and the audit chain record results that show it. */
function contents(engine: string) {
  const db = new Database(join(engine, 'books.db'));
  try {
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' AND name NOT IN ('acc_audit', 'acc_commands') ORDER BY name",
      )
      .all();
    return Object.fromEntries(
      tables.map(({ name }) => [
        name,
        db
          .query<Record<string, unknown>, []>(`SELECT * FROM "${name}" ORDER BY rowid`)
          .all()
          .map((row) =>
            Object.fromEntries(Object.entries(row).filter(([column]) => !/_at$/.test(column))),
          ),
      ]),
    );
  } finally {
    db.close();
  }
}

describe('replaying filed D406 months through migration.journal', () => {
  test('two synthetic months replay with no difference, and one altered closing is exactly one', async () => {
    const filings = replayFilings();
    const mapping = replayBooksMapping(filings);
    const first = await replay(filings, mapping);
    expect(first.result.status).toBe('completed');
    const { summary } = completed(first.result);
    expect(summary.transactions).toEqual({
      read: 9,
      posted: 9,
      refused: 0,
      refusedByReason: {},
      acknowledgedWarnings: {},
    });
    expect(summary.opening).toMatchObject({ treatment: 'ledger.general', balances: 4, items: 2 });
    expect(summary.periods).toMatchObject({ selected: 2, balanced: 2 });
    expect(first.open).toEqual([]);
    expect(summary.differences.total).toBe(0);
    // Every settlement found its item: the opening's and the invoices'.
    expect(summary.items.unallocatedSettlements).toEqual({});
    // The same inputs give the same records and the same summary.
    const again = await replay(filings, mapping);
    expect(again.result.summary).toEqual(first.result.summary);
    expect(contents(again.engine)).toEqual(contents(first.engine));

    const altered = replayFilings();
    const account = altered[1]!.filed.masterFiles.accounts.find((item) => item.id === '5121')!;
    expect(account.closingDebit).toBe('2300.00');
    account.closingDebit = '2300.01';
    const second = await replay(altered, mapping, { store: first.store });
    expect(
      second.open.map(({ kind, period, locator, delta }) => ({ kind, period, locator, delta })),
    ).toEqual([
      {
        kind: 'balance-field',
        period: '2026-02',
        locator: { account: '5121', field: 'closing.debit' },
        delta: '-0.01',
      },
    ]);
    expect(second.open[0]!.class).toBe('unclassified');
    expect(completed(second.result).summary.periods.balanced).toBe(1);
  });

  test('an unconfirmed placeholder blocks the run; a lab assumption accepts it and is recorded', async () => {
    const filings = replayFilings();
    const mapping = replayBooksMapping(filings, false);
    const blocked = await replay(filings, mapping);
    expect(blocked.result.status).toBe('blocked');
    expect(blocked.result.summary.mapping.blockers).toEqual({
      PLACEHOLDER_UNCONFIRMED: 3,
    });
    expect(blocked.open).toEqual([]);

    const assumptions = labAssumptionsSchema.parse({
      schemaVersion: 1,
      statedBy: 'test',
      accept: mapping.placeholders.map((placeholder) => ({
        kind: 'placeholder',
        sourceAccountId: placeholder.sourceAccountId,
      })),
    });
    const run = await replay(filings, mapping, { assumptions });
    expect(run.result.status).toBe('completed');
    const { summary, manifest } = completed(run.result);
    expect(summary.labAssumptions).toMatchObject({
      stated: true,
      applied: 3,
      byKind: { 'accept-placeholder': 3 },
    });
    expect(summary.mapping.waived).toEqual({ PLACEHOLDER_UNCONFIRMED: 3 });
    expect(manifest.assumptions!.applied.map((item: { id: string }) => item.id)).toEqual([
      'accept.0',
      'accept.1',
      'accept.2',
    ]);
    // The placeholders carry the VAT closing and its payment: the transactions that used them.
    expect(Object.keys(manifest.assumptionsTouched).length).toBeGreaterThan(0);
    expect(run.open).toEqual([]);
    expect(mapping.placeholders.every((placeholder) => !placeholder.confirmedByPerson)).toBe(true);
  });

  test('a payment naming no known invoice stores a mapping difference for its settlement', async () => {
    const filings = replayFilings();
    const january = filings[0]!.filed;
    const receipt = january.generalLedgerEntries.journals[0]!.transactions.find(
      (item) => item.id === 'T4',
    )!;
    const customer = receipt.lines[1]!.customer!;
    january.sourceDocuments.payments!.payments.push({
      transaction: 'T4',
      lines: [
        {
          account: receipt.lines[1]!.account,
          customer,
          supplier: '0',
          document: 'V-0',
          side: 'debit',
          amount: { amount: '300.00' },
        },
      ],
    });
    const run = await replay(filings, replayBooksMapping(filings), { to: '2026-01' });
    expect(
      run.open.map(({ kind, class: kind_, source, engine }) => [kind, kind_, source, engine]),
    ).toEqual([
      [
        'replay-settlement-unallocated',
        'mapping',
        'V-0',
        { reason: 'SETTLEMENT_DOCUMENT_UNFILED' },
      ],
    ]);
    expect(completed(run.result).summary.periods.balanced).toBe(1);
  });

  test('a reused invoice key and a baseless marker a return needs are stored with their causes', async () => {
    const filings = replayFilings();
    const journal = (index: number, id: string) =>
      filings[index]!.filed.generalLedgerEntries.journals[0]!.transactions.find(
        (item) => item.id === id,
      )!;
    // February books a second invoice under January's number from the same supplier.
    filings[1]!.filed.sourceDocuments.purchaseInvoices!.invoices.find(
      (invoice) => invoice.transaction === 'T7',
    )!.number = 'F-1';
    // An exempt purchase's code without a base, as SAGA writes it on a line of no VAT account.
    journal(0, 'T4').lines[0]!.tax = [{ type: '300', code: '308302', amount: '0.00' }];
    const run = await replay(filings, replayBooksMapping(filings));
    expect(
      run.open
        .map(({ kind, period, class: kind_, context }) => [
          kind,
          period,
          kind_,
          context?.cause?.reason,
        ])
        .sort(),
    ).toEqual([
      ['journal-tax', '2026-01', 'missing-evidence', 'MARKER_WITHOUT_BASE'],
      ['journal-tax-evidence', '2026-01', 'missing-evidence', 'MARKER_WITHOUT_BASE'],
      ['replay-invoice-key-reused', '2026-02', 'source-inconsistency', 'INVOICE_KEY_REUSED'],
    ]);
    const { summary } = completed(run.result);
    expect(summary.items).toMatchObject({ invoiceKeysReused: 1 });
    expect(summary.periods.balanced).toBe(2);
  });

  test('books that open with nothing post no opening and store no refusal', async () => {
    const filings = replayFilings();
    const { masterFiles } = filings[0]!.filed;
    for (const record of [
      ...masterFiles.accounts,
      ...masterFiles.customers,
      ...masterFiles.suppliers,
    ])
      Object.assign(record, { openingDebit: '0.00', openingCredit: undefined });
    const run = await replay(filings, replayBooksMapping(filings), { to: '2026-01' });
    expect(completed(run.result).summary.opening).toMatchObject({ treatment: 'none', balances: 0 });
    expect(run.open.filter((item) => item.kind === 'replay-opening-refused')).toEqual([]);
  });

  test('the command takes an alias, a month range and an assumptions file', () => {
    expect(
      parseJournalArguments([
        'synthetic',
        '--from',
        '2026-01',
        '--to',
        '2026-02',
        '--lab-assumptions',
        '.private/replay/synthetic/assumptions.json',
      ]),
    ).toEqual({
      alias: 'synthetic',
      from: '2026-01',
      to: '2026-02',
      assumptions: '.private/replay/synthetic/assumptions.json',
    });
    for (const args of [
      [],
      ['Synthetic'],
      ['synthetic', 'extra'],
      ['synthetic', '--from', '2026-13'],
      ['synthetic', '--from', '2026-02', '--to', '2026-01'],
      ['synthetic', '--unknown', 'x'],
      ['synthetic', '--to'],
    ])
      expect(() => parseJournalArguments(args)).toThrow('REPLAY_USAGE');
  });
});
