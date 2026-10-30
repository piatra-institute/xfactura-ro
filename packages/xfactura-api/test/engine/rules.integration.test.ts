import { afterAll, describe, expect, test } from 'bun:test';
import { scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

type Parameter = {
  id: string;
  status: string;
  reviewedThrough: string | null;
  citations: { clause: string; source: string; locator: string; status: string }[];
};

describe('rule parameters', () => {
  test('list every value with its review status and the clauses it cites', async () => {
    const s = await scenario();
    open.push(s);
    const parameters = await s.list<Parameter>(s.viewer, 'rules.parameters');
    const standard = parameters.find((item) => item.id === 'ro.vat.rate/S/2025-08-01')!;
    expect(standard.status).toBe('extracted');
    expect(standard.citations).toContainEqual({
      clause: 'ANAF/D300-12.0.0:rd.9',
      source: 'Structura fișierului XML al decontului de TVA (D300), versiunea 12.0.0',
      locator: 'rândul 9 (R9_1, R9_2), valabil de la 01.08.2025',
      status: 'located',
    });
    expect(
      parameters.every((item) => item.citations.every((citation) => citation.status !== 'unknown')),
    ).toBe(true);
  });

  test('show the values whose reviewed period ends within the next days', async () => {
    const s = await scenario();
    open.push(s);
    const expiring = await s.list<Parameter>(s.owner, 'rules.horizon', { days: 366 });
    expect(expiring.map((item) => item.id)).toEqual(
      expect.arrayContaining(['ro.vat.rate/S/2025-08-01', 'ro.vat.rate.reduced/2025-08-01']),
    );
    expect(expiring.every((item) => item.reviewedThrough !== null)).toBe(true);
  });

  test('count the days from the engine clock, not the host clock', async () => {
    let now = Date.now();
    const s = await scenario({ clock: () => now });
    open.push(s);
    const parameters = await s.list<Parameter>(s.viewer, 'rules.parameters');
    const bounded = parameters.find((item) => item.reviewedThrough !== null)!;
    const through = Date.parse(`${bounded.reviewedThrough}T12:00:00Z`);
    const horizon = async () =>
      (await s.list<Parameter>(s.viewer, 'rules.horizon', { days: 20 })).map((item) => item.id);
    now = through - 10 * 86_400_000;
    expect(await horizon()).toContain(bounded.id);
    now = through - 100 * 86_400_000;
    expect(await horizon()).not.toContain(bounded.id);
  });
});
