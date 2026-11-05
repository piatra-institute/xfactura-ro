// Runs ANAF's DUKIntegrator (D207Validator J2.0.2) over the D207 writer's synthetic declarations
// for 2026, and over mutations it must reject. Without DUKIntegrator or Java the tests are
// skipped, never passed.
import { describe, expect } from 'bun:test';
import { anaf, validateAnaf } from './anaf';
import {
  calculateD207,
  checkD207,
  writeD207,
  type D207,
  type D207Beneficiary,
} from '../../packages/xfactura-core/src/ro/declarations/d207';

const declaration = (beneficiaries: D207Beneficiary[], correction = false): D207 => ({
  year: 2026,
  correction,
  declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' },
  payer: { cui: '18547290', name: 'Exemplu Servicii SRL', address: 'Str. Lungă nr. 10, Galați' },
  beneficiaries,
});

/** A software licence from a German company, 16% under the Codul fiscal. */
const licence: D207Beneficiary = {
  name: 'Software GmbH',
  state: 'DE',
  foreignId: 'DE123456789',
  incomeType: '03',
  act: 1,
  payments: [
    { date: '2026-03-20', base: 4000, tax: 640 },
    { date: '2026-09-20', base: 1000, tax: 160 },
  ],
};
/** The same kind of licence from another company, 5% under a treaty with the certificate. */
const treaty: D207Beneficiary = {
  name: 'Code AG',
  state: 'AT',
  foreignId: 'ATU12345678',
  incomeType: '24',
  act: 2,
  payments: [{ date: '2026-04-20', base: 2000, tax: 100 }],
};
/** Interest exempt under a treaty: its gross is Tscutit and its tax 0. */
const exempt: D207Beneficiary = {
  name: 'Lender BV',
  state: 'NL',
  foreignId: 'NL123456789B01',
  incomeType: '19',
  act: 2,
  payments: [{ date: '2026-06-30', base: 1500, tax: 0 }],
};
/** Dividends to an American company at 16%. */
const dividends: D207Beneficiary = {
  name: 'Holding Inc',
  state: 'US',
  foreignId: '12-3456789',
  incomeType: '01',
  act: 1,
  payments: [{ date: '2026-07-15', base: 10_000, tax: 1600 }],
};

const declarations: Record<string, D207> = {
  licence: declaration([licence]),
  mixed: declaration([licence, treaty, exempt, dividends]),
  rectifying: declaration([treaty], true),
};

describe('official D207 validation', () => {
  anaf(
    'DUKIntegrator accepts the 2026 declarations without errors or warnings',
    async () => {
      for (const model of Object.values(declarations)) expect(checkD207(model)).toEqual([]);
      const { summaries, controlSum } = calculateD207(declarations.mixed!);
      expect(
        summaries.map((summary) => [
          summary.incomeType,
          summary.beneficiaries,
          summary.exempt,
          summary.base,
          summary.tax,
        ]),
      ).toEqual([
        ['01', 1, 0n, 10_000n, 1600n],
        ['03', 1, 0n, 5000n, 800n],
        ['24', 1, 0n, 2000n, 100n],
        ['19', 1, 1500n, 0n, 0n],
      ]);
      // nrben + Tscutit + Tbaza + Timp (+ Timps 0) over every section II.
      expect(controlSum).toBe(4n + 1500n + 17_000n + 2500n);
      const results = await validateAnaf(
        'D207',
        Object.fromEntries(
          Object.entries(declarations).map(([name, model]) => [name, writeD207(model)]),
        ),
      );
      expect(results).toEqual(
        Object.fromEntries(Object.keys(declarations).map((name) => [name, 'ok'])),
      );
    },
    120_000,
  );

  anaf(
    'DUKIntegrator rejects what checkD207 rejects, and a wrong control sum or total',
    async () => {
      const xml = writeD207(declarations.mixed!);
      const mutate = (from: string, to: string) => {
        expect(xml).toContain(from);
        return xml.replace(from, to);
      };
      const rejected: Record<string, D207> = {
        'exempt-taxed': declaration([
          { ...exempt, payments: [{ date: '2026-06-30', base: 1500, tax: 15 }] },
        ]),
        duplicate: declaration([licence, licence]),
      };
      expect(
        Object.fromEntries(
          Object.entries(rejected).map(([name, model]) => [
            name,
            checkD207(model).map((check) => `${check.severity}:${check.code}`),
          ]),
        ),
      ).toEqual({ 'exempt-taxed': ['error:D207_TAX'], duplicate: ['error:D207_DUPLICATE'] });
      const results = await validateAnaf('D207', {
        'control-sum': mutate(
          `totalPlata_A="${calculateD207(declarations.mixed!).controlSum}"`,
          'totalPlata_A="1"',
        ),
        'total-base': mutate('Tbaza="5000"', 'Tbaza="5001"'),
        'total-tax': mutate('Timp="800"', 'Timp="799"'),
        ...Object.fromEntries(
          Object.entries(rejected).map(([name, model]) => [name, writeD207(model)]),
        ),
      });
      for (const name of ['control-sum', 'total-base', 'total-tax', 'exempt-taxed', 'duplicate'])
        expect(results[name]).toStartWith('E:');
      expect(results['control-sum']).toContain('R16');
    },
    120_000,
  );
});
