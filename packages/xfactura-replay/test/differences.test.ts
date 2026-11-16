import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyCauses,
  loadCauses,
  matchesCause,
  validateCause,
  type Cause,
} from '../src/compare/causes';
import { difference, summarizeDifferences, type Difference } from '../src/compare/differences';
import { DifferenceStore } from '../src/compare/store';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function temporary() {
  const path = await mkdtemp(join(tmpdir(), 'replay-differences-'));
  directories.push(path);
  return path;
}
async function store() {
  return new DifferenceStore(join(await temporary(), '.private'), 'synthetic');
}
const finding = (source = '10', engine = '11'): Difference =>
  difference({
    kind: 'balance-field',
    period: '2026-01',
    locator: { account: '628.synthetic', field: 'debitTurnover' },
    accounts: ['628.synthetic'],
    source,
    engine,
    delta: '1',
  });
const cause: Cause = {
  id: 'synthetic-choice',
  explanation: 'The accountant supplied a different grouping.',
  class: 'accountant-choice',
  pattern: {
    kind: 'balance-field',
    accountSynthetic: '628',
    period: { from: '2026-01', to: '2026-02' },
  },
};

describe('append-only difference store', () => {
  test('classification survives changed values, a resolution, reopening and a fresh reader', async () => {
    const log = await store();
    const first = finding();
    await log.reconcile('balances', [first]);
    const original = await readFile(log.path, 'utf8');
    await log.classify(first.id, 'accountant-choice', {
      id: 'synthetic-reviewer',
      reason: 'Reviewed the invented fixture.',
    });
    const classified = await readFile(log.path, 'utf8');
    expect(classified.startsWith(original)).toBe(true);
    expect(JSON.parse(classified.trim().split('\n').at(-1)!)).toMatchObject({
      type: 'classified',
      id: first.id,
      class: 'accountant-choice',
      by: { type: 'person', id: 'synthetic-reviewer' },
    });
    const next = await log.reconcile('balances', [finding('20', '21')]);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      id: first.id,
      class: 'accountant-choice',
      status: 'open',
      source: '20',
      engine: '21',
    });
    expect((await readFile(log.path, 'utf8')).startsWith(classified)).toBe(true);
    expect(summarizeDifferences(next, 'synthetic-secret').gate).toBe(true);
    expect((await log.reconcile('balances', []))[0]).toMatchObject({
      status: 'resolved',
      class: 'accountant-choice',
    });
    expect(summarizeDifferences(await log.read(), 'synthetic-secret').total).toBe(0);
    expect((await log.reconcile('balances', [first]))[0]).toMatchObject({
      status: 'open',
      class: 'accountant-choice',
    });
    const reader = new DifferenceStore(join(log.directory, '..'), 'synthetic');
    expect(await reader.read()).toEqual(await log.read());
  });

  test('rules classify only unclassified observations and append their own provenance', async () => {
    const log = await store();
    const result = await log.reconcile('balances', [finding()], [cause]);
    expect(result[0]).toMatchObject({ class: cause.class, causeId: cause.id });
    expect(
      (await readFile(log.path, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).type),
    ).toEqual(['observed', 'classified']);
    await log.classify(finding().id, 'legal-reading', {
      id: 'expert-synthetic',
      reason: 'Requires expert review.',
    });
    expect((await log.reconcile('balances', [finding()], [cause]))[0]).toMatchObject({
      class: 'legal-reading',
    });
    expect((await log.read())[0]!.causeId).toBeUndefined();
  });

  test('reruns resolve only their declared scope and duplicate observations cannot be appended', async () => {
    const log = await store();
    const journal = difference({
      kind: 'journal-lines',
      period: '2026-01',
      locator: { subject: 'migration:synthetic:example' },
      source: [],
      engine: [],
    });
    await log.reconcile('balances', [finding()]);
    await log.reconcile('journals', [journal]);
    await log.reconcile('balances', []);
    expect((await log.read()).find((item) => item.id === journal.id)!.status).toBe('open');
    const before = await readFile(log.path, 'utf8');
    await expect(log.reconcile('journals', [journal, journal])).rejects.toThrow('STORE_DUPLICATE');
    await expect(log.reconcile('different-scope', [journal])).rejects.toThrow('STORE_SCOPE');
    await expect(
      log.classify('unknown', 'mapping', { id: 'person', reason: 'Example' }),
    ).rejects.toThrow('STORE_REFERENCE');
    expect(await readFile(log.path, 'utf8')).toBe(before);
  });

  test('unclassified is the gate, and missing evidence can be explicitly classified', async () => {
    const log = await store();
    expect(summarizeDifferences(await log.reconcile('balances', [finding()]), 'key').gate).toBe(
      false,
    );
    await log.classify(finding().id, 'missing-evidence', {
      id: 'person',
      reason: 'Evidence requested.',
    });
    expect(summarizeDifferences(await log.read(), 'key').gate).toBe(true);
    await log.classify(finding().id, 'unclassified', {
      id: 'person',
      reason: 'Reopened the classification.',
    });
    expect(summarizeDifferences(await log.read(), 'key').gate).toBe(false);
  });

  test('invalid identities, truncated history and concurrent writers fail without rewriting', async () => {
    const log = await store();
    await expect(
      log.reconcile('balances', [{ ...finding(), id: 'sha256:' + '0'.repeat(64) }]),
    ).rejects.toThrow('STORE_ID');
    await log.reconcile('balances', [finding()]);
    const lock = join(log.directory, '.differences.lock');
    await mkdir(lock);
    await expect(log.reconcile('balances', [])).rejects.toThrow('STORE_BUSY');
    await rm(lock, { recursive: true });
    await writeFile(log.path, '{"type":', { flag: 'a' });
    const broken = await readFile(log.path, 'utf8');
    await expect(log.read()).rejects.toThrow('STORE_TRUNCATED');
    await expect(log.reconcile('balances', [])).rejects.toThrow('STORE_TRUNCATED');
    expect(await readFile(log.path, 'utf8')).toBe(broken);
  });

  test('paths are confined to a private company directory and reject symlink escapes', async () => {
    const root = await temporary();
    expect(() => new DifferenceStore(root, 'synthetic')).toThrow('STORE_PRIVATE_PATH');
    expect(() => new DifferenceStore(join(root, '.private'), '../public')).toThrow(
      'STORE_PRIVATE_PATH',
    );
    await mkdir(join(root, '.private'));
    await mkdir(join(root, 'public'));
    await symlink(join(root, 'public'), join(root, '.private', 'synthetic'));
    await expect(
      new DifferenceStore(join(root, '.private'), 'synthetic').reconcile('balances', [finding()]),
    ).rejects.toThrow('STORE_PRIVATE_PATH');
    await rm(join(root, '.private', 'synthetic'));
    const log = new DifferenceStore(join(root, '.private'), 'synthetic');
    await log.reconcile('balances', []);
    const target = join(root, 'public', 'target.jsonl');
    await writeFile(target, '');
    await symlink(target, log.path);
    await expect(log.read()).rejects.toThrow('STORE_FILE');
    expect(await readFile(target, 'utf8')).toBe('');
  });
});

describe('public causes', () => {
  test('every repository cause passes the privacy check and fixture requirement', async () => {
    const causes = await loadCauses();
    expect(causes.length).toBeGreaterThan(0);
    for (const item of causes) expect(validateCause(item)).toEqual(item);
    expect(
      applyCauses(
        [
          difference({
            kind: 'source-chain-balance',
            period: '2026-02',
            locator: { sourceAccount: 'invented', previousPeriod: '2026-01', field: 'debit' },
            source: '10',
            engine: '11',
          }),
        ],
        causes,
      )[0]!.class,
    ).toBe('source-inconsistency');
  });

  test.each([
    ['company', 'RO90000003', 'CAUSE_COMPANY_CODE'],
    ['bare company', '90000003', 'CAUSE_COMPANY_CODE'],
    ['labelled company', 'CUI: 12', 'CAUSE_COMPANY_CODE'],
    ['personal', '1990101999999', 'CAUSE_PERSONAL_CODE'],
    ['IBAN', 'RO49AAAA1B31007593840000', 'CAUSE_IBAN'],
    ['spaced IBAN', 'ro49 aaaa 1b31 0075 9384 0000', 'CAUSE_IBAN'],
    ['decimal amount', '123.45', 'CAUSE_AMOUNT'],
    ['integer amount', '123', 'CAUSE_AMOUNT'],
    ['comma amount', '12,34', 'CAUSE_AMOUNT'],
    ['grouped amount', '12 340.00', 'CAUSE_AMOUNT'],
    ['grouped Romanian amount', '12\u00a0340,00', 'CAUSE_AMOUNT'],
    ['dot grouping with comma decimal', '1.200,34', 'CAUSE_AMOUNT'],
    ['comma grouping with dot decimal', '1,200.34', 'CAUSE_AMOUNT'],
    ['grouped amount with internal zeroes', '1.000,01', 'CAUSE_AMOUNT'],
    ['small amount', '0.001234', 'CAUSE_AMOUNT'],
    ['exponent amount', '1.234e2', 'CAUSE_AMOUNT'],
  ])('rejects forbidden %s shapes in a cause file', async (_name, forbidden, code) => {
    const directory = join(await temporary(), 'causes');
    await mkdir(directory);
    await writeFile(
      join(directory, 'synthetic-choice.json'),
      JSON.stringify({ ...cause, explanation: `Private detail ${forbidden}` }),
    );
    await expect(loadCauses(directory)).rejects.toThrow(code);
  });

  test('matches only structural fields and refuses ambiguous causes and value patterns', () => {
    expect(matchesCause(cause, finding('123456.78', '876543.21'))).toBe(true);
    expect(
      matchesCause({ ...cause, pattern: { ...cause.pattern, taxCode: 'SYN-A' } }, finding()),
    ).toBe(false);
    expect(
      matchesCause(
        { ...cause, pattern: { ...cause.pattern, taxCode: 'SYN-A' } },
        { ...finding(), taxCodes: ['SYN-A'] },
      ),
    ).toBe(true);
    expect(matchesCause(cause, { ...finding(), period: '2026-03' })).toBe(false);
    expect(matchesCause(cause, { ...finding(), accounts: ['627.synthetic'] })).toBe(false);
    expect(matchesCause(cause, { ...finding(), kind: 'journal-lines' })).toBe(false);
    expect(() => validateCause({ ...cause, pattern: { ...cause.pattern, amount: '10' } })).toThrow(
      'CAUSE_SCHEMA',
    );
    expect(() => applyCauses([finding()], [cause, { ...cause, id: 'second-choice' }])).toThrow(
      'CAUSE_AMBIGUOUS',
    );
    expect(() => validateCause({ ...cause, class: 'engine-defect' })).toThrow('CAUSE_FIXTURE');
    expect(
      validateCause({
        ...cause,
        explanation: 'A synthetic 12.00 or 0.012 example.',
        class: 'engine-defect',
        fixture: 'test/fixtures/books.ts',
      }).class,
    ).toBe('engine-defect');
  });

  test('cause loaders require a real synthetic fixture for engine defects', async () => {
    const root = await temporary();
    const directory = join(root, 'causes');
    await mkdir(directory);
    await mkdir(join(root, 'test/fixtures'), { recursive: true });
    await writeFile(
      join(directory, 'synthetic-choice.json'),
      JSON.stringify({ ...cause, class: 'engine-defect', fixture: 'test/fixtures/missing.ts' }),
    );
    await expect(loadCauses(directory)).rejects.toThrow('CAUSE_FIXTURE');
    await writeFile(join(root, 'test/fixtures/missing.ts'), '// Invented reproducer\n');
    expect(await loadCauses(directory)).toHaveLength(1);
  });
});

test('summaries expose counts and synthetic accounts, never amounts, locators or private suffixes', () => {
  const one = finding('9876.54', '8765.43');
  const two = difference({
    kind: 'mapping-account',
    period: '2026-02',
    locator: { sourceAccount: 'private-unmapped-account' },
    accounts: ['private-unmapped-account', '628.customer-private', '628.another-private'],
    source: '12345.67',
    engine: null,
  });
  const result = summarizeDifferences([one, two, { ...one, status: 'resolved' }], 'synthetic-key');
  expect(result.total).toBe(2);
  expect(result.byClass.unclassified).toBe(2);
  expect(result.byKind).toEqual({ 'balance-field': 1, 'mapping-account': 1 });
  expect(result.byPeriod).toEqual({ '2026-01': 1, '2026-02': 1 });
  expect(result.byAccountSynthetic['628']).toBe(2);
  expect(result.gate).toBe(false);
  const text = JSON.stringify(result);
  for (const privateValue of [
    '9876.54',
    '8765.43',
    '12345.67',
    'private-unmapped-account',
    'customer-private',
    'another-private',
    'debitTurnover',
    one.id,
  ])
    expect(text).not.toContain(privateValue);
  expect(summarizeDifferences([two], 'synthetic-key')).toEqual(
    summarizeDifferences([two], 'synthetic-key'),
  );
  expect(summarizeDifferences([two], 'different-key').byAccountSynthetic).not.toEqual(
    summarizeDifferences([two], 'synthetic-key').byAccountSynthetic,
  );
  expect(() => summarizeDifferences([one], '')).toThrow('COMPARISON_HASH_KEY');
});
