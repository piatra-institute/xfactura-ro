import { describe, expect, test } from 'bun:test';
import { citationProblems, clauses, legalSources, unsourced } from '../src/ro/sources';
import { fxVersions } from '../src/ro/fx';
import { vatVersions } from '../src/ro/vat';

const versions = [...vatVersions, ...fxVersions];

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
    // The FX rate-date conventions cite the law and the accounting order, neither snapshotted.
    expect(unsourced(versions).map((version) => version.id)).toEqual([
      'ro.fx.rate_date.accounting/2024-01-01',
      'ro.fx.rate_date.vat/2024-01-01',
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
