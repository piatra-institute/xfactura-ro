import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { roRegister } from '../../packages/xfactura-core/src/ro/register';
import { ParameterRegister, type ParameterVersion } from '../../packages/xfactura-core/src/rules';
import { parseLocalDate as date } from '../../packages/xfactura-core/src/time';
import { ruleFamilies } from './families';
import {
  endMarker,
  nextJanuary,
  replaceTable,
  rolloverRows,
  startMarker,
  stateCounts,
} from './rollover';

const root = fileURLToPath(new URL('../../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'xfactura-rollover-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const run = (...args: string[]) =>
  Bun.spawnSync({
    cmd: [process.execPath, 'scripts/rules/rollover.ts', ...args],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });

test('the committed 2027 rollover table matches the register', () => {
  const result = run('--date', '2027-01-01', '--check', 'docs/ROLLOVER.md');
  expect(result.stderr.toString()).toContain('Rollover table matches');
  expect(result.exitCode).toBe(0);
});

test('check detects drift without writing; regeneration preserves prose and is idempotent', () => {
  const original = readFileSync(join(root, 'docs/ROLLOVER.md'), 'utf8');
  const stale = original.replace('reviewedThrough=2026-12-31', 'reviewedThrough=2027-12-31');
  expect(stale).not.toBe(original);
  const file = join(scratch, 'rollover.md');
  writeFileSync(file, stale);
  const check = run('--date', '2027-01-01', '--check', file);
  expect(check.exitCode).toBe(1);
  expect(check.stderr.toString()).toContain('Rollover table differs');
  expect(readFileSync(file, 'utf8')).toBe(stale);
  for (let i = 0; i < 2; i++) {
    const write = run('--date', '2027-01-01', '--markdown', '--write', file);
    expect(write.exitCode).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(original).toContain(write.stdout.toString().trimEnd());
  }
});

test('every register key has its defining family and every recorded scope reaches the resolver', () => {
  const register = roRegister();
  expect([...ruleFamilies.keys()].sort()).toEqual(register.keys().sort());
  for (const when of ['2025-01-01', '2026-12-31', '2027-01-01', '2028-01-01']) {
    const rows = rolloverRows(date(when));
    expect([...new Set(rows.map((row) => row.key))].sort()).toEqual(register.keys().sort());
    for (const version of register.versions) {
      expect(rows).toContainEqual(
        expect.objectContaining({ key: version.key, scope: version.scope }),
      );
    }
    for (const row of rows) {
      const resolution = register.resolve(row.key, {
        axis: register.definition(row.key).axis,
        date: date(when),
        mode: 'preview',
        scope: row.scope ?? {},
      });
      expect(row.state).toBe(resolution.ok ? 'COVERED' : resolution.gap.reason);
      if (resolution.ok)
        expect(row.versions.map((version) => version.id)).toEqual([resolution.versionId]);
    }
  }
  const rows = rolloverRows(date('2027-01-01'));
  expect(rows.find((row) => row.key === 'ro.deadline.efactura')?.family).toBe('retail');
  expect(rows.filter((row) => row.key === 'ro.vat.rate').map((row) => row.scope)).toEqual([
    { category: 'O' },
    { category: 'S' },
  ]);
});

// Synthetic scopes exercise a mixed-state key without changing the legal register or review tiers.
const definition = roRegister().definition('ro.vat.rate');
const version = (scope: string, overrides: Partial<ParameterVersion> = {}): ParameterVersion => ({
  key: definition.key,
  id: `synthetic/${scope}`,
  scope: { category: scope },
  value: '1',
  from: date('2026-01-01'),
  to: null,
  reviewedThrough: date('2026-12-31'),
  knowledgeDate: null,
  status: 'extracted',
  clauses: ['synthetic:clause'],
  ...overrides,
});

test('interval ends and horizons are inclusive; future and expired versions never become fallbacks', () => {
  const register = new ParameterRegister(
    [definition],
    [
      version('horizon'),
      version('ended', { to: date('2026-12-31'), reviewedThrough: null }),
      version('continues', { to: date('2027-12-31') }),
      version('future', { from: date('2027-07-01'), reviewedThrough: date('2027-12-31') }),
      version('withdrawn', { withdrawn: true }),
    ],
  );
  const before = rolloverRows(date('2026-12-31'), register);
  expect(before.filter((row) => row.state === 'COVERED').map((row) => row.scope?.category)).toEqual(
    ['continues', 'ended', 'horizon'],
  );
  const after = rolloverRows(date('2027-01-01'), register);
  expect(after.map((row) => [row.scope?.category, row.state, row.context])).toEqual([
    ['continues', 'COVERED', 'covering'],
    ['ended', 'NO_VERSION', 'expired'],
    ['future', 'NO_VERSION', 'future'],
    ['horizon', 'BEYOND_HORIZON', 'covering'],
    ['withdrawn', 'NO_VERSION', 'none'],
  ]);
  expect(stateCounts(after)).toEqual({
    COVERED: 1,
    NO_VERSION: 1,
    BEYOND_HORIZON: 1,
    INSUFFICIENT_REVIEW: 0,
    AMBIGUOUS: 0,
  });
  expect(after.find((row) => row.scope?.category === 'withdrawn')?.versions).toEqual([]);
});

test('a defined key with no versions remains a gap, with no invented scope or version', () => {
  const rows = rolloverRows(date('2027-01-01'), new ParameterRegister([definition], []));
  expect(rows).toEqual([
    {
      key: definition.key,
      family: 'vat',
      scope: null,
      state: 'NO_VERSION',
      versions: [],
      context: 'none',
    },
  ]);
  expect(() => rolloverRows(date('2027-01-01'), roRegister(), new Map())).toThrow('No rule family');
});

test('invalid dates and missing, reversed or duplicated markers fail without writing', () => {
  expect(run('--date', '2027-02-29').exitCode).toBe(2);
  const invalid = [
    'No markers',
    `${endMarker}\n${startMarker}`,
    `${startMarker}\n${startMarker}\n${endMarker}`,
    `${startMarker}\n${endMarker}\n${endMarker}`,
  ];
  for (const document of invalid)
    expect(() => replaceTable(document, 'table')).toThrow('ordered pair');
  const file = join(scratch, 'no-markers.md');
  writeFileSync(file, invalid[0]!);
  expect(run('--date', '2027-01-01', '--write', file).exitCode).toBe(2);
  expect(readFileSync(file, 'utf8')).toBe(invalid[0]!);
  expect(run('--check', file, '--write', file).exitCode).toBe(2);
});

test('the default date advances to the next January, including on New Year’s Day', () => {
  expect(nextJanuary(date('2026-11-16'))).toBe(date('2027-01-01'));
  expect(nextJanuary(date('2026-12-31'))).toBe(date('2027-01-01'));
  expect(nextJanuary(date('2027-01-01'))).toBe(date('2028-01-01'));
});
