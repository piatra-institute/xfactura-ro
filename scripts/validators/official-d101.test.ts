// ANAF's DUKIntegrator with the D101 validator (J11.0.4 of 22.09.2026), as installed by
// `bun run validators:fetch`, over the writer's synthetic annual profit tax returns and over
// mutations that must be rejected. Without DUKIntegrator or Java the tests are skipped, never
// passed.
import { describe, expect } from 'bun:test';
import { anaf, validateAnaf } from './anaf';
import {
  calculateD101,
  checkD101,
  d101Rows,
  deriveD101Rows,
  writeD101,
  type D101,
  type D101Rows,
} from '../../packages/xfactura-core/src/ro/declarations/d101';

/** The rows given, the derived ones computed as the structure's formulas do. */
function rows(values: Partial<Record<(typeof d101Rows)[number], bigint>>): D101Rows {
  let r = deriveD101Rows({
    ...(Object.fromEntries(d101Rows.map((row) => [row, 0n])) as D101Rows),
    ...values,
  });
  // The tax at 16% of the taxable profit, rounded half up to the leu.
  if (values.P411 === undefined) r = deriveD101Rows({ ...r, P411: (r.P40 * 16n + 50n) / 100n });
  return r;
}

const declaration = (values: D101Rows, extra: Partial<D101> = {}): D101 => ({
  period: { from: '2026-01-01', to: '2026-12-31' },
  microExitQuarter: null,
  rectifying: false,
  afterReserveCancellation: null,
  declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' },
  payer: {
    cui: '18547290',
    caen: '6201',
    name: 'Exemplu Servicii SRL',
    address: 'Str. Lungă nr. 10, Galați, jud. Galați',
    phone: '0236000000',
    email: 'contabilitate@exemplu.ro',
  },
  rows: values,
  ...extra,
});

// A year with protocol over its limit, a fine, depreciation replaced by its fiscal version, the
// legal reserve, a 2024 loss recovered within 70% and the quarters declared.
const year = rows({
  P1: 200000n,
  P2: 120000n,
  P11: 4000n,
  P13: 4000n,
  P23: 9000n,
  P25: 500n,
  P26: 1200n,
  P28: 5000n,
  P39: 30000n,
  P39a: 30000n,
  P50: 6000n,
});
// FP-05: 2,000 of sponsorship, 200,000 turnover: 1,500 credited, the lesser of 0.75% and 20%.
const sponsored = (() => {
  const r = rows({ P1: 200000n, P2: 102000n, P27: 2000n });
  return deriveD101Rows({ ...r, P43: 1500n, P431: 1500n });
})();
// A loss year: the results negative, the loss carried (rd. 40^1).
const loss = rows({ P1: 50000n, P2: 80000n, P28: 1000n });
// Leaving micro in the third quarter: from 1 July, the micro months' FX gain as rd. 8.
const exit = rows({ P1: 300000n, P2: 132000n, P8: 300n, P23: 32000n, P50: 32000n });

const declarations: Record<string, D101> = {
  year: declaration(year),
  sponsorship: declaration(sponsored),
  loss: declaration(loss),
  'micro-exit-q3': declaration(exit, {
    period: { from: '2026-07-01', to: '2026-12-31' },
    microExitQuarter: 3,
  }),
  // FP-03: the year rectified after a correction on 1174, 5,000 lei less of taxable result.
  rectifying: declaration(rows({ P1: 100000n, P2: 49600n, P9: 5000n, P23: 9600n }), {
    rectifying: true,
  }),
  // The return of 2025 (filed by 25 June 2026), and the representative.
  'year-2025': declaration(rows({ P1: 90000n, P2: 50000n }), {
    period: { from: '2025-01-01', to: '2025-12-31' },
    representative: {
      cui: '14399840',
      name: 'Contabil Test SRL',
      address: 'Bd. Unirii 5, București',
      email: 'office@contabil.ro',
    },
  }),
};

describe('official D101 validation', () => {
  anaf(
    'DUKIntegrator accepts every synthetic return without errors or warnings',
    async () => {
      for (const [name, model] of Object.entries(declarations))
        expect([name, checkD101(model)]).toEqual([name, []]);
      expect(calculateD101(declarations.year!)).toMatchObject({
        dueCode: '250627',
        dueDate: '2027-06-25',
        paymentNumber: '11103011226250627000040',
      });
      // 200,000 − 120,000 = 80,000; − 8,000 deductions + 15,700 added back = 87,700; 30,000
      // recovered: 57,700 × 16% = 9,232, 6,000 declared, 3,232 to pay.
      expect([year.P35, year.P39a, year.P40, year.P48, year.P52]).toEqual([
        87700n,
        30000n,
        57700n,
        9232n,
        3232n,
      ]);
      expect([loss.P38a, loss.P40a]).toEqual([-29000n, 29000n]);
      const results = await validateAnaf(
        'D101',
        Object.fromEntries(
          Object.entries(declarations).map(([name, model]) => [name, writeD101(model)]),
        ),
      );
      expect(results).toEqual(
        Object.fromEntries(Object.keys(declarations).map((name) => [name, 'ok'])),
      );
    },
    120_000,
  );

  anaf(
    'DUKIntegrator rejects a wrong control sum, payment number, due date, formula and period',
    async () => {
      const xml = writeD101(declarations.year!);
      const mutate = (from: string, to: string) => {
        expect(xml).toContain(from);
        return xml.replace(from, to);
      };
      const control = calculateD101(declarations.year!).controlSum;
      const results = await validateAnaf('D101', {
        'control-sum': mutate(`totalPlata_A="${control}"`, `totalPlata_A="${control + 1n}"`),
        'payment-number': mutate(
          'nr_evid="11103011226250627000040"',
          'nr_evid="11103011226250627000041"',
        ),
        // The March deadline the law had before OUG nr. 8/2026.
        'march-deadline': mutate('scadenta="250627"', 'scadenta="250327"'),
        'taxable-profit': mutate('P40="57700"', 'P40="57701"'),
        // A quarter of exit whose period starts on 1 January.
        'exit-period': mutate('d_alte="0"', 'd_alte="0" trim_micro="3"'),
        'sponsorship-over-20': writeD101(
          declaration(deriveD101Rows({ ...sponsored, P43: 3300n, P431: 3300n })),
        ),
      });
      for (const [name, result] of Object.entries(results))
        expect([name, result.startsWith('E:')]).toEqual([name, true]);
      expect(results['control-sum']).toContain('R19');
      expect(results['payment-number']).toContain('nr_evid');
    },
    120_000,
  );
});
