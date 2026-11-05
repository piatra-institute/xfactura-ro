// ANAF's DUKIntegrator with the D398 validator (J1.0.11 of 29.04.2025, structure A1.0.10), installed
// by `bun run validators:fetch` in the SAF-T kit (its newer `dec` library alone loads it), over the
// writer's synthetic Union scheme returns and over mutations that must be rejected. Without the
// kit or Java the tests are skipped, never passed.
import { describe, expect } from 'bun:test';
import { anafSaft, saftDuk, validateAnaf } from './anaf';
import {
  calculateD398,
  checkD398,
  writeD398,
  type D398,
} from '../../packages/xfactura-core/src/ro/declarations/d398';

const declaration = (extra: Partial<D398> = {}): D398 => ({
  period: { year: 2026, month: 9 },
  vatId: '18547290',
  name: 'Exemplu Digital SRL',
  supplies: [
    {
      state: 'DE',
      type: 'services',
      rateType: 'standard',
      rate: '19',
      taxableCents: 40000n,
      vatCents: 7600n,
    },
    {
      state: 'DE',
      type: 'services',
      rateType: 'reduced',
      rate: '7',
      taxableCents: 10000n,
      vatCents: 700n,
    },
    {
      state: 'FR',
      type: 'services',
      rateType: 'standard',
      rate: '20',
      taxableCents: 100000n,
      vatCents: 20000n,
    },
    {
      state: 'IT',
      type: 'services',
      rateType: 'standard',
      rate: '22',
      taxableCents: 50000n,
      vatCents: 11000n,
    },
  ],
  corrections: [],
  ...extra,
});

const declarations: Record<string, D398> = {
  // Three Member States of consumption, a German reduced rate.
  'three-states': declaration(),
  // A quarter of the scheme without sales: filed all the same (art. 315 alin. (6)).
  nil: declaration({ supplies: [] }),
  // A refund of a French sale of the previous quarter: a negative correction (alin. (11)).
  correction: declaration({
    period: { year: 2026, month: 12 },
    supplies: [
      {
        state: 'DE',
        type: 'services',
        rateType: 'standard',
        rate: '19',
        taxableCents: 20000n,
        vatCents: 3800n,
      },
    ],
    corrections: [{ state: 'FR', year: 2026, month: 9, vatCents: -10000n }],
  }),
  // Goods dispatched from Romania (supply type 1) and Finland's 25,5%.
  goods: declaration({
    supplies: [
      {
        state: 'FI',
        type: 'goods',
        rateType: 'standard',
        rate: '25.5',
        taxableCents: 10000n,
        vatCents: 2550n,
      },
      {
        state: 'AT',
        type: 'goods',
        rateType: 'reduced',
        rate: '10',
        taxableCents: 10000n,
        vatCents: 1000n,
      },
    ],
  }),
  // A correction of a state without supplies this quarter only.
  'correction-only': declaration({
    supplies: [],
    corrections: [{ state: 'IT', year: 2026, month: 6, vatCents: 2200n }],
  }),
};

describe("ANAF's D398 validator", () => {
  anafSaft(
    'accepts the writer’s returns',
    async () => {
      for (const [name, model] of Object.entries(declarations))
        expect([name, checkD398(model)]).toEqual([name, []]);
      expect(calculateD398(declarations.correction!).due).toBe(3800n);
      expect(calculateD398(declarations['correction-only']!).due).toBe(2200n);
      const results = await validateAnaf(
        'D398',
        Object.fromEntries(
          Object.entries(declarations).map(([name, model]) => [name, writeD398(model)]),
        ),
        saftDuk,
      );
      expect(results).toEqual(
        Object.fromEntries(Object.keys(declarations).map((name) => [name, 'ok'])),
      );
    },
    120_000,
  );

  anafSaft(
    'refuses what the writer’s checks refuse: VAT outside R29.1, no e_int, no RO prefix',
    async () => {
      const outside = declaration({
        supplies: [
          {
            state: 'DE',
            type: 'services',
            rateType: 'standard',
            rate: '19',
            taxableCents: 100000n,
            vatCents: 18999n,
          },
        ],
      });
      expect(checkD398(outside).map((check) => check.code)).toEqual(['D398_VAT']);
      const xml = writeD398(declaration());
      const results = await validateAnaf(
        'D398',
        {
          outside: writeD398(outside),
          'no-e-int': xml.replace(' e_int="0"', ''),
          'no-prefix': xml.replace('vat_id_no="RO18547290"', 'vat_id_no="18547290"'),
          // Estonia's 24% (TEDB, from July 2025) is not in J1.0.11's list: a warning only.
          estonia: writeD398(
            declaration({
              supplies: [
                {
                  state: 'EE',
                  type: 'services',
                  rateType: 'standard',
                  rate: '24',
                  taxableCents: 10000n,
                  vatCents: 2400n,
                },
              ],
            }),
          ),
        },
        saftDuk,
      );
      expect(results.outside).toContain('R29.1');
      expect(results['no-e-int']).toContain('R5.1');
      expect(results['no-prefix']).toContain('R10');
      expect(results.estonia).toStartWith('A:');
      expect(results.estonia).toContain('R27.2');
    },
    120_000,
  );
});
