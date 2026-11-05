// ANAF's DUKIntegrator with the D301 validator (J1.2.5 of 22.10.2020, structure D301_A2.0.0), as
// installed by `bun run validators:fetch`, over the writer's synthetic special returns and over
// mutations that must be rejected. Without DUKIntegrator or Java the tests are skipped, never
// passed.
import { describe, expect } from 'bun:test';
import { anaf, validateAnaf } from './anaf';
import {
  calculateD301,
  checkD301,
  writeD301,
  type D301,
  type D301Line,
} from '../../packages/xfactura-core/src/ro/declarations/d301';

const meta: Omit<D301Line, 'section'> = {
  number: '4567891234',
  date: '2026-10-15',
  currencyValue: '1000.00',
  currency: 'EUR',
  rate: '5.0912',
  baseBani: 509100n,
  vatBani: 106900n,
};
const openai: Omit<D301Line, 'section'> = {
  number: 'INV-2026-10-77',
  date: '2026-10-03',
  currencyValue: '120.00',
  currency: 'USD',
  rate: '4.3755',
  baseBani: 52500n,
  vatBani: 11000n,
};

const declaration = (lines: D301Line[], extra: Partial<D301> = {}): D301 => ({
  period: { year: 2026, month: 10 },
  rectification: false,
  afterReserveCancellation: 0,
  company: {
    cif: '18547290',
    name: 'Exemplu Servicii SRL',
    address: 'Str. Lungă nr. 10, Galați, jud. Galați',
    email: 'contabilitate@exemplu.ro',
    bank: 'Trezoreria Galati',
    account: 'RO12TREZ3065503XXXXXXXXX',
  },
  registeredArt317: true,
  declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' },
  lines,
  ...extra,
});

const declarations: Record<string, D301> = {
  // Meta ads from Ireland, with the art. 317 code: section 4 and its repeat in 4.1.
  'meta-art317': declaration([
    { ...meta, section: 4 },
    { ...meta, section: 5 },
  ]),
  // An AI provider from the United States and Meta: only the EU supplier repeats in 4.1.
  'us-and-eu': declaration([
    { ...openai, section: 4 },
    { ...meta, section: 4 },
    { ...meta, section: 5 },
  ]),
  // A company with no code at all buying from outside the Union (pers_inreg 1).
  'no-code-us': declaration([{ ...openai, section: 4 }], { registeredArt317: false }),
  // December, its payment due in January of the next year.
  december: declaration(
    [
      { ...meta, date: '2026-12-02', section: 4 },
      { ...meta, date: '2026-12-02', section: 5 },
    ],
    { period: { year: 2026, month: 12 } },
  ),
};

describe('official D301 validation', () => {
  anaf(
    'DUKIntegrator accepts every synthetic special return without errors or warnings',
    async () => {
      for (const [name, model] of Object.entries(declarations))
        expect([name, checkD301(model)]).toEqual([name, []]);
      expect(calculateD301(declarations['us-and-eu']!)).toMatchObject({
        payable: 117900n,
        paymentNumber: '10301011026251126000032',
      });
      expect(calculateD301(declarations.december!).paymentNumber).toBe('10301011226250127000034');
      const results = await validateAnaf(
        'D301',
        Object.fromEntries(
          Object.entries(declarations).map(([name, model]) => [name, writeD301(model)]),
        ),
      );
      expect(results).toEqual(
        Object.fromEntries(Object.keys(declarations).map((name) => [name, 'ok'])),
      );
    },
    120_000,
  );

  anaf(
    'DUKIntegrator rejects a wrong control sum, a wrong section total, a payment number and a 4.1 line missing from 4',
    async () => {
      const xml = writeD301(declarations['meta-art317']!);
      const mutate = (from: string, to: string) => {
        expect(xml).toContain(from);
        return xml.replace(from, to);
      };
      const orphan = declaration([{ ...meta, section: 5 }]);
      expect(checkD301(orphan).map((check) => check.code)).toEqual(['D301_SECTION_41']);
      const results = await validateAnaf('D301', {
        // The validator tolerates a difference of one leu (its rounding), not more.
        'control-sum': mutate('totalPlata_A="12320"', 'totalPlata_A="12400"'),
        total: mutate('tva4="1069.00"', 'tva4="1070.00"'),
        'payment-number': mutate(
          'nr_evid="10301011026251126000032"',
          'nr_evid="10301011026251126000031"',
        ),
        orphan: writeD301(orphan),
      });
      expect(results['control-sum']).toStartWith('E:');
      expect(results['control-sum']).toContain('R28');
      expect(results.total).toContain('R25: tva4');
      expect(results['payment-number']).toContain('R16: nr_evid');
      expect(results.orphan).toContain('R32');
    },
    120_000,
  );
});
