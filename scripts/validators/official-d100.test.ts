// ANAF's DUKIntegrator with the D100 validator (J21.0.8 of 14.09.2026), as installed by
// `bun run validators:fetch`, over the writer's synthetic declarations and over mutations that
// must be rejected. Without DUKIntegrator or Java the tests are skipped, never passed.
import { describe, expect } from 'bun:test';
import { anaf, validateAnaf } from './anaf';
import {
  calculateD100,
  checkD100,
  writeD100,
  type D100,
} from '../../packages/xfactura-core/src/ro/declarations/d100';

const declaration = (obligations: D100['obligations'], extra: Partial<D100> = {}): D100 => ({
  period: { year: 2026, month: 9 },
  afterReserveCancellation: false,
  dissolution: false,
  declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' },
  payer: {
    cui: '18547290',
    name: 'Exemplu Servicii SRL',
    address: 'Str. Lungă nr. 10, Galați, jud. Galați',
    phone: '0236000000',
    email: 'contabilitate@exemplu.ro',
  },
  obligations,
  ...extra,
});

const declarations: Record<string, D100> = {
  // Q3 2026: 1% of a 120,000 lei base (1,200 lei), declared for September.
  'micro-q3': declaration([{ kind: 'micro', tax: 1200 }]),
  // June 2026: dividend tax withheld from individuals (604) and a Romanian company (150).
  dividends: declaration(
    [
      { kind: 'dividends', beneficiary: 'individual', withheld: 4800 },
      { kind: 'dividends', beneficiary: 'company', withheld: 1600 },
    ],
    { period: { year: 2026, month: 6 } },
  ),
  // The Q3 declaration filed again after the reserve of subsequent verification was cancelled:
  // the only correction a D100 carries; any other is the D710.
  'micro-q3-after-reserve-cancellation': declaration([{ kind: 'micro', tax: 1200 }], {
    afterReserveCancellation: true,
  }),
  // December 2026: tax on dividends paid in December and on those still unpaid at year end.
  'dividends-year-end': declaration(
    [{ kind: 'dividends', beneficiary: 'individual', withheld: 800, unpaidAtYearEnd: 4000 }],
    { period: { year: 2026, month: 12 } },
  ),
  // October 2026: the tax withheld on interest paid to an associate, beside dividend tax.
  interest: declaration(
    [
      { kind: 'dividends', beneficiary: 'individual', withheld: 1600 },
      { kind: 'interest', withheld: 85 },
    ],
    { period: { year: 2026, month: 10 } },
  ),
  // Q4 2026 dated as the validator requires, 25 June of the next year.
  'micro-q4-june': declaration([{ kind: 'micro', tax: 900, fourthQuarterDue: 'june' }], {
    period: { year: 2026, month: 12 },
  }),
  // The micro tax with a reduction, the tax withheld on interest paid to individuals, the
  // successor, dissolution and the representative.
  'micro-dissolution': declaration(
    [
      { kind: 'micro', tax: 400, deductible: 100, reduction: 60 },
      { kind: 'interest', withheld: 150 },
    ],
    {
      period: { year: 2026, month: 8 },
      dissolution: true,
      successorCui: '14399840',
      representative: {
        cui: '14399840',
        name: 'Contabil Test SRL',
        address: 'Bd. Unirii 5, București',
        email: 'office@contabil.ro',
      },
    },
  ),
};

describe('official D100 validation', () => {
  anaf(
    'DUKIntegrator accepts every synthetic declaration without errors or warnings',
    async () => {
      for (const [name, model] of Object.entries(declarations))
        expect([name, checkD100(model).filter((check) => check.severity === 'error')]).toEqual([
          name,
          [],
        ]);
      const amounts = (name: string) =>
        calculateD100(declarations[name]!).lines.map(({ code, due, payable }) => [
          code,
          due,
          payable,
        ]);
      expect(amounts('micro-q3')).toEqual([['121', 1200n, 1200n]]);
      expect(amounts('dividends')).toEqual([
        ['604', 4800n, 4800n],
        ['150', 1600n, 1600n],
      ]);
      expect(amounts('dividends-year-end')).toEqual([['604', 4800n, 4800n]]);
      expect(amounts('interest')).toEqual([
        ['604', 1600n, 1600n],
        ['605', 85n, 85n],
      ]);
      expect(calculateD100(declarations['micro-q3']!).controlSum).toBe(2400n);
      expect(calculateD100(declarations.dividends!).controlSum).toBe(12_800n);
      const results = await validateAnaf(
        'D100',
        Object.fromEntries(
          Object.entries(declarations).map(([name, model]) => [name, writeD100(model)]),
        ),
      );
      expect(results).toEqual(
        Object.fromEntries(Object.keys(declarations).map((name) => [name, 'ok'])),
      );
    },
    120_000,
  );

  anaf(
    'DUKIntegrator rejects a wrong control sum, payment number or cota, and the 25 January Q4 date',
    async () => {
      const xml = writeD100(declarations['micro-q3']!);
      const mutate = (from: string, to: string) => {
        expect(xml).toContain(from);
        return xml.replace(from, to);
      };
      const january = declaration([{ kind: 'micro', tax: 900, fourthQuarterDue: 'january' }], {
        period: { year: 2026, month: 12 },
      });
      expect(checkD100(january).map((check) => `${check.severity}:${check.code}`)).toEqual([
        'warning:D100_FOURTH_QUARTER',
      ]);
      const results = await validateAnaf('D100', {
        'control-sum': mutate('totalPlata_A="2400"', 'totalPlata_A="2401"'),
        'payment-number': mutate(
          'nr_evid="10121010926251026000039"',
          'nr_evid="10121010926251026000038"',
        ),
        cota: mutate(' cota="1"', ''),
        'q4-january': writeD100(january),
      });
      expect(results['control-sum']).toStartWith('E:');
      expect(results['control-sum']).toContain('R11b');
      expect(results['payment-number']).toStartWith('E:');
      expect(results['payment-number']).toContain('nr_evid');
      expect(results.cota).toContain('Rcota');
      expect(results['q4-january']).toContain('ar fi trebuit sa fie 25.06.2027');
    },
    120_000,
  );
});
