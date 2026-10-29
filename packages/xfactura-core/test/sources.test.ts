import { describe, expect, test } from 'bun:test';
import { citationProblems, clauses, legalSources, unsourced } from '../src/ro/sources';
import { fxVersions } from '../src/ro/fx';
import { dividendVersions } from '../src/ro/dividends';
import { etvaVersions } from '../src/ro/etva';
import { microVersions } from '../src/ro/micro';
import { payrollVersions } from '../src/ro/payroll';
import { procedureVersions } from '../src/ro/procedure';
import { vatVersions } from '../src/ro/vat';

const versions = [
  ...vatVersions,
  ...fxVersions,
  ...procedureVersions,
  ...payrollVersions,
  ...microVersions,
  ...dividendVersions,
  ...etvaVersions,
];

describe('source register', () => {
  test('every parameter version cites registered clauses, and located clauses have snapshots', () => {
    expect(citationProblems(versions)).toEqual([]);
  });

  test('identifiers are unique and every snapshot hash is a SHA-256', () => {
    expect(new Set(legalSources.map((source) => source.id)).size).toBe(legalSources.length);
    expect(new Set(clauses.map((item) => item.id)).size).toBe(clauses.length);
    for (const source of legalSources)
      for (const snapshot of source.snapshots) expect(snapshot.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test('reports the parameters still cited only to texts nobody has read', () => {
    // The FX rate-date conventions and the rounding of declarations and payroll amounts cite acts
    // not yet snapshotted.
    expect(unsourced(versions).map((version) => version.id)).toEqual([
      'ro.fx.rate_date.accounting/2024-01-01',
      'ro.fx.rate_date.vat/2024-01-01',
      'ro.declaration.rounding/2016-01-01',
      'ro.payroll.amount_rounding/2026-01-01',
    ]);
  });

  test('refuses an uncited version or an unknown clause', () => {
    const [sample] = vatVersions;
    expect(citationProblems([{ ...sample!, id: 'x', clauses: [] }])).toEqual(['x: cites nothing']);
    expect(citationProblems([{ ...sample!, id: 'y', clauses: ['nowhere'] }])).toEqual([
      'y: unknown clause nowhere',
    ]);
  });
});
