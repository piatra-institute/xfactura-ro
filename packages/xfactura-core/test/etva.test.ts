import { describe, expect, test } from 'bun:test';
import { etvaDifferences } from '../src/ro/etva';

const threshold = { percent: '20', lei: '1000' };
const october = { year: 2026, month: 10 };

describe('RO e-TVA differences', () => {
  test('a row differs significantly only at both 20% and 1,000 lei', () => {
    const rows = etvaDifferences(
      { R9_1: 10000, R9_2: 2100, R22_1: 5000, R22_2: 1050, R10_2: 900 },
      { R9_1: 10000, R9_2: 2100, R22_1: 11000, R22_2: 2310, R10_2: 1700 },
      threshold,
      october,
    );
    expect(
      rows.map(({ element, difference, significant }) => [element, difference, significant]),
    ).toEqual([
      ['R9_2', 0, false],
      // 800 lei, though 47%: under the amount.
      ['R10_2', -800, false],
      ['R22_2', -1260, true],
    ]);
  });

  test('compares the value where a row has no VAT, and leaves out regularizations', () => {
    const rows = etvaDifferences({ R3_1: 50000, R16_2: 5000 }, { R3_1: 30000 }, threshold, october);
    expect(rows).toEqual([
      {
        row: '3',
        element: 'R3_1',
        declared: 50000,
        prefilled: 30000,
        difference: 20000,
        significant: true,
      },
    ]);
  });

  test('a row the pre-filled return lacks is significant from 1,000 lei', () => {
    const [row] = etvaDifferences({ R9_2: 1000 }, {}, threshold, october);
    expect(row).toMatchObject({ prefilled: 0, difference: 1000, significant: true });
    expect(etvaDifferences({ R9_2: 999 }, {}, threshold, october)[0]?.significant).toBe(false);
  });
});
