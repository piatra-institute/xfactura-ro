import { describe, expect, test } from 'bun:test';
import { checkS1005, completeS1005 } from '../src/ro/annual/s1005';
import { s1005FromLedger } from '../src/ro/annual/s1005-accounts';
import { s1005F40FromLedger } from '../src/ro/annual/s1005-assets';
import { credit, debit, services, servicesStatements } from './fixtures/s1005';

describe('S1005 F40 from the ledger', () => {
  test('the services company: the laptop held, the server bought, a year of depreciation', () => {
    const previous = s1005FromLedger({
      closing: services.closing2024,
      turnover: services.turnover2024,
    });
    const current = s1005FromLedger({
      closing: services.closing2025,
      turnover: services.turnover2025,
    });
    const { F40, issues } = s1005F40FromLedger({
      opening: previous.closing,
      closing: current.closing,
      movements: [debit('2131', '8000.00'), credit('2813', '500.00'), credit('2814', '1000.00')],
    });
    expect(issues).toEqual([]);
    // The rows the fixture states by hand, as its registers give them.
    expect(F40).toEqual(servicesStatements().F40);
    // And the statements still pass every control, F10_F40_1–6 included.
    const model = completeS1005({ ...servicesStatements(), F40 });
    expect(checkS1005(model).filter((check) => check.severity === 'error')).toEqual([]);
  });

  test('rounding leaves the balances as F10 adds them; the residue goes to the larger movement', () => {
    const { F40 } = s1005F40FromLedger({
      opening: [],
      // F10 placed 1,833.37 lei of depreciation as 1,834 lei.
      closing: [
        { account: '2131', lei: 5500 },
        { account: '2813', lei: -1834 },
      ],
      movements: [debit('2131', '5500.00'), credit('2813', '1833.37')],
    });
    expect(F40).toEqual({ '10': [0, 5500, 0, 0, 5500], '29': [0, 1834, 0, 1834] });
  });

  test('a reduction asks how much of it was scrapped; an unknown account is an issue', () => {
    const sold = {
      opening: [
        { account: '2133', lei: 30000 },
        { account: '2813', lei: -30000 },
      ],
      closing: [],
      movements: [credit('2133', '30000.00'), debit('2813', '30000.00')],
    };
    expect(s1005F40FromLedger(sold).issues.map((issue) => issue.code)).toEqual([
      'S1005_F40_SCRAPPED',
    ]);
    const { F40, issues } = s1005F40FromLedger({ ...sold, scrapped: { '10': 0 } });
    expect(issues).toEqual([]);
    expect(F40).toEqual({ '10': [30000, 0, 30000, 0, 0], '29': [30000, 0, 30000, 0] });
    expect(
      s1005F40FromLedger({ ...sold, scrapped: { '10': 40000 } }).issues.map((i) => i.code),
    ).toEqual(['S1005_F40_SCRAPPED']);
    expect(
      s1005F40FromLedger({
        opening: [],
        closing: [{ account: '2675', lei: 1000 }],
        movements: [debit('2675', '1000.00')],
      }).issues.map((issue) => issue.code),
    ).toEqual(['S1005_F40_ACCOUNT']);
  });
});
