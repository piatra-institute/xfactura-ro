import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ParameterRegister } from 'xfactura-core/rules';
import { parseLocalDate } from 'xfactura-core/time';
import { scenario, type Scenario } from '../../xfactura-api/test/engine/scenario';
import {
  compareBalances,
  separateZeroPresence,
  type EngineBalancePeriod,
} from '../src/compare/balances';
import { difference } from '../src/compare/differences';
import { readEngineBalances, readEngineJournals, type ReadOperation } from '../src/compare/engine';
import {
  compareJournals,
  migrationSubject,
  type EngineJournalEntry,
} from '../src/compare/journals';
import { checkSourceChain } from '../src/compare/source-chain';
import { migrationJournal, type MigrationJournalInput } from '../src/treatments/journal';
import { filed, mapping, sourceBooks, sourceJournal } from './fixtures/books';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

async function engine(changed = false) {
  const s = await scenario({
    name: 'Comparație Sintetică SRL',
    treatments: [migrationJournal],
    register: new ParameterRegister([], []),
  });
  open.push(s);
  const evidence = await s.evidence('jurnal-sintetic.txt', 'Invented comparison evidence');
  for (const source of sourceJournal()) {
    const january = source.reference.startsWith('2026-01');
    if (changed && january && source.reference.endsWith('/missing')) continue;
    const entry: MigrationJournalInput = {
      source: source.source,
      reference: source.reference,
      evidenceId: evidence.id,
      date: parseLocalDate(source.transaction.date!),
      journalCode: 'DIVERSE',
      description: 'Notă sintetică',
      newItems: [],
      lines: source.transaction.lines.map((line) => ({
        account: mapping(line.account!)!,
        side: line.side === 'debit' ? 'D' : 'C',
        amount: line.amount!.amount!,
      })),
      taxEntries: (source.taxEntries ?? []).map((tax) => ({
        key: 'vat',
        tax: 'VAT',
        code: tax.code!,
        direction: 'input',
        base: tax.base!,
        amount: tax.tax!,
        deductible: tax.deductible!,
        booked: tax.tax!,
        taxPoint: parseLocalDate(source.transaction.date!),
        exigibility: parseLocalDate(source.transaction.date!),
        taxPeriod: tax.period!,
        line: 1,
        attributes: {},
      })),
    };
    // Split the same debit differently from the filed transaction.
    if (january && source.reference.endsWith('/amount')) {
      entry.lines[0]!.amount = '10';
      entry.lines[1]!.amount = changed ? '21' : '20';
      entry.lines[2]!.amount = changed ? '31' : '30';
    }
    if (changed && january && source.reference.endsWith('/account'))
      entry.lines[0]!.account = '625';
    if (changed && january && source.reference.endsWith('/tax'))
      entry.taxEntries[0]!.code = 'SYN-B';
    const posted = await s.book('migration.journal', entry);
    expect(posted.status).toBe('posted');
    expect(posted.rules.used).toEqual([]);
  }
  const read: ReadOperation = (operation, input) => s.invoke(s.owner, operation, input);
  return {
    s,
    read,
    balances: await Promise.all([
      readEngineBalances(read, s.year.id, '2026-01-01', '2026-01-31'),
      readEngineBalances(read, s.year.id, '2026-02-01', '2026-02-28'),
    ]),
    journal: await readEngineJournals(read, '2026-01-01', '2026-02-28', 2),
  };
}

describe('filed books against private migration.journal operations', () => {
  let books: Awaited<ReturnType<typeof engine>>;
  beforeAll(async () => {
    books = await engine();
  });

  test('two independent monthly balances and merged journal lines agree exactly', () => {
    const balance = compareBalances(sourceBooks(), books.balances, mapping);
    expect(balance.differences).toEqual([]);
    expect(balance.rows).toHaveLength(10);
    expect(
      balance.rows.find((row) => row.period === '2026-02' && row.account === '628')!.engine,
    ).toEqual({
      opening: { debit: '90', credit: '0' },
      debitTurnover: '50',
      creditTurnover: '0',
      closing: { debit: '140', credit: '0' },
    });
    expect(compareJournals(sourceJournal(), books.journal, mapping)).toEqual([]);
    expect(balance.chain).toEqual({ transitionsChecked: 1, accountsCompared: 5, byKind: {} });
  });

  test('an amount, a moved account, an absent transaction and a changed tax code produce exactly four journal findings', async () => {
    const changed = await engine(true);
    const differences = compareJournals(sourceJournal(), changed.journal, mapping);
    expect(differences.map((item) => [item.kind, item.locator.subject])).toEqual([
      ['journal-lines', 'migration:synthetic:2026-01/account'],
      ['journal-lines', 'migration:synthetic:2026-01/amount'],
      ['journal-only-source', 'migration:synthetic:2026-01/missing'],
      ['journal-tax', 'migration:synthetic:2026-01/tax'],
    ]);
    const rerun = structuredClone(changed.journal).reverse();
    const amountEntry = rerun.find(
      (entry) => entry.subject.endsWith('/amount') && entry.date.startsWith('2026-01'),
    )!;
    amountEntry.lines = amountEntry.lines.map((line) => ({ ...line, amount: '25' })).reverse();
    expect(
      compareJournals(sourceJournal().reverse(), rerun, mapping).map((item) => item.id),
    ).toEqual(differences.map((item) => item.id));
    const balances = compareBalances(sourceBooks(), changed.balances, mapping);
    expect(
      balances.differences.find(
        (item) =>
          item.period === '2026-01' &&
          item.locator.account === '628' &&
          item.locator.field === 'debitTurnover',
      ),
    ).toMatchObject({ source: '90', engine: '91', delta: '1' });
  });

  test('one balance field produces one signed exact delta and an identity independent of values', () => {
    const changed = structuredClone(books.balances);
    const row = changed[0]!.rows.find((row) => row.account === '628')!;
    row.values.debitTurnover = '89.99';
    const first = compareBalances(sourceBooks(), changed, mapping).differences;
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      kind: 'balance-field',
      locator: { account: '628', field: 'debitTurnover' },
      source: '90',
      engine: '89.99',
      delta: '-0.01',
    });
    row.values.debitTurnover = '90.000000000000000001';
    const second = compareBalances(sourceBooks(), changed, mapping).differences;
    expect(second[0]!.id).toBe(first[0]!.id);
    expect(second[0]!.delta).toBe('0.000000000000000001');
  });

  test('a one-sided account with only zeros is counted apart only when asked', () => {
    const changed = structuredClone(books.balances);
    const zero = { debit: '0.00', credit: '0.00' };
    changed[0]!.rows.push({
      account: '461',
      values: { opening: zero, debitTurnover: '0.00', creditTurnover: '0.00', closing: zero },
    });
    changed[0]!.rows.push({
      account: '462',
      values: { opening: zero, debitTurnover: '1.00', creditTurnover: '1.00', closing: zero },
    });
    const kinds = (options?: { zeroPresence: 'separate' }) =>
      compareBalances(sourceBooks(), changed, mapping, options).differences.map((item) => [
        item.kind,
        item.locator.account,
      ]);
    expect(kinds()).toEqual([
      ['balance-only-engine', '461'],
      ['balance-only-engine', '462'],
    ]);
    // Movement without a balance is still a difference.
    expect(kinds({ zeroPresence: 'separate' })).toEqual([
      ['balance-presence-zero', '461'],
      ['balance-only-engine', '462'],
    ]);
    const chain = (source: { debit: string; credit: string }) =>
      difference({
        kind: 'source-chain-only-previous',
        period: '2026-02',
        locator: { sourceAccount: 'source-461', previousPeriod: '2026-01' },
        source,
        engine: null,
      });
    expect(
      separateZeroPresence([
        chain({ debit: '0', credit: '0' }),
        chain({ debit: '1', credit: '0' }),
      ]).map((item) => item.kind),
    ).toEqual(['source-chain-presence-zero', 'source-chain-only-previous']);
  });

  test('both unpaired sides, duplicate identities, missing mappings and redacted reads stay visible', async () => {
    const entries = structuredClone(books.journal);
    entries[0]!.subject = 'migration:other:extra:reference';
    expect(
      compareJournals(sourceJournal(), entries, mapping)
        .map((item) => item.kind)
        .sort(),
    ).toEqual(['journal-only-engine', 'journal-only-source']);
    expect(migrationSubject('synthetic', 'ref:with:colons')).toBe(
      'migration:synthetic:ref:with:colons',
    );
    expect(() =>
      compareJournals([...sourceJournal(), sourceJournal()[0]!], entries, mapping),
    ).toThrow('COMPARISON_REFERENCE_DUPLICATE');
    expect(() => compareJournals(sourceJournal(), [...entries, entries[0]!], mapping)).toThrow(
      'COMPARISON_REFERENCE_DUPLICATE',
    );
    const gaps = compareJournals([sourceJournal()[0]!], [books.journal[0]!], () => undefined);
    // An incomplete mapping cannot suppress the remaining line comparison.
    expect(gaps.map((item) => item.kind)).toEqual([
      'mapping-account',
      'mapping-account',
      'journal-lines',
    ]);
    const redacted: ReadOperation = async () =>
      ({ entries: [{ id: 'synthetic', seq: 1, redacted: true, lines: [] }], next: null }) as never;
    await expect(readEngineJournals(redacted, '2026-01-01', '2026-01-31')).rejects.toThrow(
      'COMPARISON_ENGINE_REDACTED',
    );
  });

  test('tax multisets compare all requested fields, retain duplicates and require missing evidence', () => {
    const source = sourceJournal().find((entry) => entry.reference.endsWith('/tax'))!;
    const entry = books.journal.find(
      (entry) => entry.subject === migrationSubject(source.source, source.reference),
    )!;
    for (const [field, value] of [
      ['code', 'SYN-B'],
      ['base', '61'],
      ['tax', '13'],
      ['deductible', '11'],
      ['period', '2026-02'],
    ] as const) {
      const changed = structuredClone(entry);
      changed.taxEntries = changed.taxEntries.map((tax) => ({ ...tax, [field]: value }));
      expect(compareJournals([source], [changed], mapping).map((item) => item.kind)).toEqual([
        'journal-tax',
      ]);
    }
    // Tax multiplicity is established by the filed lines, never by supplemental evidence.
    const double = structuredClone(source);
    double.transaction.lines[1]!.tax!.push(structuredClone(double.transaction.lines[1]!.tax![0]!));
    double.taxEntries = [...source.taxEntries!, ...source.taxEntries!];
    expect(compareJournals([double], [entry], mapping).map((item) => item.kind)).toEqual([
      'journal-tax',
    ]);
    expect(
      compareJournals(
        [double],
        [{ ...entry, taxEntries: [...entry.taxEntries, ...entry.taxEntries].reverse() }],
        mapping,
      ),
    ).toEqual([]);
    const many = Array.from({ length: 4000 }, () => source.taxEntries![0]!);
    const manySource = structuredClone(source);
    manySource.transaction.lines[1]!.tax = Array.from({ length: 4000 }, () => ({
      code: 'SYN-A',
      base: '60',
      amount: '12',
    }));
    manySource.taxEntries = many;
    expect(compareJournals([manySource], [{ ...entry, taxEntries: many }], mapping)).toEqual([]);
    const { taxEntries: _taxEntries, ...fileOnly } = source;
    expect(fileOnly.transaction.lines[1]!.tax).toEqual([
      { code: 'SYN-A', base: '60', amount: '12' },
    ]);
    expect(compareJournals([fileOnly], [entry], mapping).map((item) => item.kind)).toEqual([
      'journal-tax-evidence',
    ]);
    const wrongCode = {
      ...entry,
      taxEntries: entry.taxEntries.map((tax) => ({ ...tax, code: 'SYN-B' })),
    };
    expect(compareJournals([fileOnly], [wrongCode], mapping).map((item) => item.kind)).toEqual([
      'journal-tax-evidence',
      'journal-tax',
    ]);
  });

  test('missing balance fields and accounts are not zero and periods cannot overlap', () => {
    const source = sourceBooks();
    delete source[0]!.masterFiles.accounts[0]!.openingDebit;
    const differences = compareBalances(source, books.balances, mapping).differences;
    expect(differences.map((item) => [item.kind, item.source, item.delta])).toEqual([
      ['balance-field', null, undefined],
      ['balance-field', null, undefined],
    ]);
    expect(
      compareBalances(sourceBooks(), [], mapping).differences.map((item) => item.kind),
    ).toEqual(['balance-period-only-source', 'balance-period-only-source']);
    expect(() => compareBalances([source[0]!, source[0]!], books.balances, mapping)).toThrow(
      'COMPARISON_PERIOD_OVERLAP',
    );
  });
});

test('tax matching with mixed evidence finds a complete pairing without a greedy mismatch', () => {
  const source = sourceJournal()[0]!;
  const taxes = [
    { code: 'SYN-A', base: '10', tax: '2', deductible: '2', period: '2026-01' },
    { code: 'SYN-B', base: '10', tax: '2', deductible: '2', period: '2026-01' },
  ];
  source.taxEntries = [{ base: '10', tax: '2', deductible: '2', period: '2026-01' }, taxes[0]!];
  source.transaction.lines[0]!.tax = [
    { base: '10', amount: '2' },
    { code: 'SYN-A', base: '10', amount: '2' },
  ];
  const entry: EngineJournalEntry = {
    id: 'synthetic',
    subject: migrationSubject(source.source, source.reference),
    date: '2026-01-05',
    lines: [
      { account: '628', side: 'D', amount: '30' },
      { account: '5121', side: 'C', amount: '30' },
    ],
    taxEntries: taxes,
  };
  expect(compareJournals([source], [entry], mapping).map((item) => item.kind)).toEqual([
    'journal-tax-evidence',
  ]);
});

test('source chain is independent of mapping, ordered by dates, and reports breaks, renumbering and gaps', () => {
  const source = sourceBooks();
  source[1]!.masterFiles.accounts[0]!.openingDebit = '91';
  const result = checkSourceChain(source.reverse());
  expect(result.counts).toEqual({
    transitionsChecked: 1,
    accountsCompared: 5,
    byKind: { 'source-chain-balance': 1 },
  });
  expect(result.findings[0]).toMatchObject({
    kind: 'source-chain-balance',
    source: '90',
    engine: '91',
    delta: '1',
    locator: { previousPeriod: '2026-01', sourceAccount: 'source-628', field: 'debit' },
  });
  const renumbered = sourceBooks();
  renumbered[1]!.masterFiles.accounts[0]!.id = 'renumbered';
  expect(checkSourceChain(renumbered).counts).toEqual({
    transitionsChecked: 1,
    accountsCompared: 4,
    byKind: { 'source-chain-only-next': 1, 'source-chain-only-previous': 1 },
  });
  expect(checkSourceChain([sourceBooks()[0]!, filed('2026-03', [])]).counts).toEqual({
    transitionsChecked: 0,
    accountsCompared: 0,
    byKind: { 'source-chain-gap': 1 },
  });
});

test('comparison arithmetic is exact beyond floating point and merges many-to-one mappings', () => {
  const source = filed('2026-01', [
    { id: 'alpha', openingDebit: '9007199254740993.01', closingDebit: '9007199254740993.01' },
    { id: 'beta', openingDebit: '0.02', closingDebit: '0.02' },
  ]);
  const engine: EngineBalancePeriod = {
    period: '2026-01',
    from: '2026-01-01',
    to: '2026-01-31',
    rows: [
      {
        account: '628',
        values: {
          opening: { debit: '9007199254740993.03', credit: '0' },
          closing: { debit: '9007199254740993.04', credit: '0' },
          debitTurnover: '0',
          creditTurnover: '0',
        },
      },
    ],
  };
  const result = compareBalances([source], [engine], () => '628');
  expect(result.differences).toHaveLength(1);
  expect(result.differences[0]!.delta).toBe('0.01');
});

test('zero-sum line groups and signed corrections are preserved', () => {
  const source = sourceJournal()[0]!;
  source.transaction.lines = [
    { account: 'source-628', side: 'debit', amount: { amount: '-0.1' } },
    { account: 'source-628', side: 'debit', amount: { amount: '0.10' } },
  ];
  const entry: EngineJournalEntry = {
    id: 'synthetic',
    subject: migrationSubject(source.source, source.reference),
    date: '2026-01-05',
    lines: [{ account: '628', side: 'D', amount: '0' }],
    taxEntries: [],
  };
  expect(compareJournals([source], [entry], mapping)).toEqual([]);
  expect(compareJournals([source], [{ ...entry, lines: [] }], mapping)).toHaveLength(1);
});

test('many-to-one balance mapping nets opposite opening and closing sides, without netting turnover', () => {
  const source = filed(
    '2026-01',
    [
      { id: 'alpha', openingDebit: '15', closingDebit: '20' },
      { id: 'beta', openingCredit: '10', closingCredit: '12' },
    ],
    [
      {
        id: 'synthetic',
        period: '01',
        periodYear: '2026',
        lines: [
          { account: 'alpha', side: 'debit', amount: { amount: '5' } },
          { account: 'beta', side: 'credit', amount: { amount: '2' } },
        ],
      },
    ],
  );
  const engine: EngineBalancePeriod = {
    period: '2026-01',
    from: '2026-01-01',
    to: '2026-01-31',
    rows: [
      {
        account: '628',
        values: {
          opening: { debit: '5', credit: '0' },
          closing: { debit: '8', credit: '0' },
          debitTurnover: '5',
          creditTurnover: '2',
        },
      },
    ],
  };
  expect(compareBalances([source], [engine], () => '628').differences).toEqual([]);
  engine.rows[0]!.values.debitTurnover = '3';
  engine.rows[0]!.values.creditTurnover = '0';
  expect(
    compareBalances([source], [engine], () => '628').differences.map((item) => item.locator.field),
  ).toEqual(['debitTurnover', 'creditTurnover']);
});

test('engine reads retain the annual opening and obtain the first-use account opening from the engine', async () => {
  const s = await scenario({
    treatments: [migrationJournal],
    register: new ParameterRegister([], []),
  });
  open.push(s);
  const evidence = await s.evidence('opening-synthetic.txt', 'Invented opening');
  const base = {
    source: 'synthetic',
    evidenceId: evidence.id,
    description: 'Notă sintetică',
    taxEntries: [],
    newItems: [],
  };
  expect(
    (
      await s.book('migration.journal', {
        ...base,
        reference: 'opening',
        date: '2026-01-01',
        journalCode: 'DESCHIDERE',
        lines: [
          { account: '5121', side: 'D', amount: '100' },
          { account: '1012', side: 'C', amount: '100' },
        ],
      })
    ).status,
  ).toBe('posted');
  expect(
    (
      await s.book('migration.journal', {
        ...base,
        reference: 'movement',
        date: '2026-02-02',
        journalCode: 'DIVERSE',
        lines: [
          { account: '628', side: 'D', amount: '10' },
          { account: '5121', side: 'C', amount: '10' },
        ],
      })
    ).status,
  ).toBe('posted');
  const read: ReadOperation = (operation, input) => s.invoke(s.owner, operation, input);
  const january = await readEngineBalances(read, s.year.id, '2026-01-01', '2026-01-31');
  expect(january.rows.find((row) => row.account === '5121')!.values).toEqual({
    opening: { debit: '100.00', credit: '0.00' },
    debitTurnover: '0.00',
    creditTurnover: '0.00',
    closing: { debit: '100.00', credit: '0.00' },
  });
  const february = await readEngineBalances(read, s.year.id, '2026-02-01', '2026-02-28');
  expect(february.rows.find((row) => row.account === '628')!.values.opening).toEqual({
    debit: '0.00',
    credit: '0.00',
  });
  expect(february.rows.find((row) => row.account === '5121')!.values.opening).toEqual({
    debit: '100.00',
    credit: '0.00',
  });
});
