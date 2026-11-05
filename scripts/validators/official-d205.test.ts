// Runs ANAF's DUKIntegrator over the D205 writer's synthetic declarations for 2026, and over
// mutations it must reject. Without DUKIntegrator or Java the tests are skipped, never passed.
import { describe, expect } from 'bun:test';
import { anaf, validateAnaf } from './anaf';
import {
  calculateD205,
  checkD205,
  writeD205,
  type D205,
  type D205Beneficiary,
  type D205Payment,
} from '../../packages/xfactura-core/src/ro/declarations/d205';

type Individual = Extract<D205Beneficiary, { kind: 'individual' }>;

/** Dividends the general meeting of 20 April 2026 distributed, 16% withheld at payment. */
const paid = (date: string, gross: number, tax: number): D205Payment => ({
  date,
  distributed: '2026-04-20',
  gross,
  tax,
});

const individual = (
  cnp: string,
  name: string,
  payments: D205Payment[],
  unpaid: Individual['unpaid'] = [],
): Individual => ({ kind: 'individual', cnp, name, payments, unpaid });

const declaration = (beneficiaries: D205Beneficiary[], correction = false): D205 => ({
  year: 2026,
  correction,
  declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' },
  payer: { cui: '18547290', name: 'Exemplu Servicii SRL', address: 'Str. Lungă nr. 10, Galați' },
  paidAs: 'gross',
  beneficiaries,
});

const shareholder = individual('1781105170030', 'Dumitrescu Andrei', [
  paid('2026-06-15', 30_000, 4800),
]);
const partner: D205Beneficiary = {
  kind: 'company',
  cui: '14399840',
  name: 'Partener Investiții SRL',
  payments: [paid('2026-06-15', 10_000, 1600)],
  unpaid: [],
};
const instalments = (second: number) =>
  individual('2850722170021', 'Georgescu Elena', [
    paid('2026-06-15', 12_000, 1920),
    paid('2026-11-16', second, (second * 16) / 100),
  ]);

const declarations: Record<string, D205> = {
  'one-individual': declaration([shareholder]),
  // The company's dividends are left out: D205 declares individuals.
  'company-and-instalments': declaration([shareholder, partner, instalments(8000)]),
  // The second instalment was 9000 lei; Ionescu Mihai's record, filed by mistake, is removed.
  rectifying: declaration(
    [instalments(9000), individual('1900315170013', 'Ionescu Mihai', [])],
    true,
  ),
  // 2025 dividends unpaid at the end of 2025 (10% paid by 25 January 2026), paid in 2026; 2026
  // dividends partly unpaid at the end of 2026, their 16% withheld by 25 January 2027.
  'year-end': declaration([
    individual(
      '2790312400010',
      'Vasilescu Maria',
      [
        { date: '2026-02-10', distributed: '2025-05-12', gross: 10_000, tax: 1000 },
        paid('2026-07-01', 6000, 960),
      ],
      [{ gross: 4000, tax: 640 }],
    ),
  ]),
  // An associate's loan: interest paid twice, 10% withheld, beside a shareholder's dividends
  // and a lender with interest only.
  interest: declaration([
    {
      ...shareholder,
      interest: [
        { date: '2026-06-30', gross: 400, tax: 40 },
        { date: '2026-12-15', gross: 450, tax: 45 },
      ],
    },
    {
      kind: 'individual',
      cnp: '2850722170021',
      name: 'Georgescu Elena',
      payments: [],
      unpaid: [],
      interest: [{ date: '2026-09-30', gross: 1200, tax: 120 }],
    },
  ]),
  // Rent paid by the company to a landlord (tip 29): the net income (the gross less 20%) and
  // 10% of it, beside the same person's dividends.
  rent: declaration([
    {
      ...shareholder,
      rent: [
        { date: '2026-04-05', base: 2000, tax: 200 },
        { date: '2026-05-05', base: 988, tax: 99 },
      ],
    },
  ]),
};

describe('official D205 validation', () => {
  anaf(
    'DUKIntegrator accepts the 2026 declarations without errors or warnings',
    async () => {
      expect(checkD205(declarations['one-individual']!)).toEqual([]);
      expect(
        checkD205(declarations['company-and-instalments']!).map(
          (check) => `${check.severity}:${check.code}`,
        ),
      ).toEqual(['warning:D205_COMPANY']);
      expect(checkD205(declarations.rectifying!)).toEqual([]);
      expect(checkD205(declarations['year-end']!)).toEqual([]);
      expect(checkD205(declarations.interest!)).toEqual([]);
      expect(checkD205(declarations.rent!)).toEqual([]);
      expect(
        calculateD205(declarations.rent!).records.map((record) => [
          record.incomeType,
          record.base,
          record.tax,
        ]),
      ).toEqual([
        ['08', 30_000n, 4800n],
        ['29', 2988n, 299n],
      ]);
      expect(
        calculateD205(declarations.interest!).summaries.map((summary) => [
          summary.incomeType,
          summary.beneficiaries,
          summary.base,
          summary.tax,
        ]),
      ).toEqual([
        ['08', 1, 30_000n, 4800n],
        ['09', 2, 2050n, 205n],
      ]);
      const totals = (name: string) => {
        const { summaries, controlSum } = calculateD205(declarations[name]!);
        return { ...summaries[0], controlSum };
      };
      expect(totals('one-individual')).toEqual({
        incomeType: '08',
        beneficiaries: 1,
        base: 30_000n,
        tax: 4800n,
        controlSum: 34_801n,
      });
      expect(totals('company-and-instalments')).toEqual({
        incomeType: '08',
        beneficiaries: 2,
        base: 50_000n,
        tax: 8000n,
        controlSum: 58_002n,
      });
      expect(totals('rectifying')).toEqual({
        incomeType: '08',
        beneficiaries: 2,
        base: 21_000n,
        tax: 3360n,
        controlSum: 24_362n,
      });
      expect(calculateD205(declarations['year-end']!).records).toEqual([
        {
          id: 1,
          beneficiary: 0,
          incomeType: '08',
          distributed: 10_000n,
          paid: 16_000n,
          base: 10_000n,
          tax: 1600n,
        },
      ]);
      const results = await validateAnaf(
        'D205',
        Object.fromEntries(
          Object.entries(declarations).map(([name, model]) => [name, writeD205(model)]),
        ),
      );
      expect(results).toEqual(
        Object.fromEntries(Object.keys(declarations).map((name) => [name, 'ok'])),
      );
    },
    120_000,
  );

  anaf(
    'DUKIntegrator rejects what checkD205 rejects, and a wrong control sum or total',
    async () => {
      const xml = writeD205(declarations['company-and-instalments']!);
      const mutate = (from: string, to: string) => {
        expect(xml).toContain(from);
        return xml.replace(from, to);
      };
      const rejected: Record<string, D205> = {
        duplicate: declaration([shareholder, instalments(8000), shareholder]),
        'birth-month': declaration([
          individual('1781305170038', 'Dumitrescu Andrei', shareholder.payments),
        ]),
      };
      expect(
        Object.fromEntries(
          Object.entries(rejected).map(([name, model]) => [
            name,
            checkD205(model).map((check) => `${check.severity}:${check.code}`),
          ]),
        ),
      ).toEqual({ duplicate: ['error:D205_DUPLICATE'], 'birth-month': ['error:D205_CNP'] });
      const results = await validateAnaf('D205', {
        'control-sum': mutate('totalPlata_A="58002"', 'totalPlata_A="58003"'),
        'total-base': mutate('Tbaza="50000"', 'Tbaza="50001"'),
        'total-tax': mutate('Timp="8000"', 'Timp="7999"'),
        beneficiaries: mutate('nrben="2"', 'nrben="3"'),
        ...Object.fromEntries(
          Object.entries(rejected).map(([name, model]) => [name, writeD205(model)]),
        ),
      });
      expect(results['control-sum']).toStartWith('E:');
      expect(results['control-sum']).toContain('R15');
      expect(results['total-base']).toContain('R22');
      expect(results['total-tax']).toContain('R23');
      expect(results.beneficiaries).toContain('R19');
      expect(results.duplicate).toContain('R41b');
      expect(results['birth-month']).toContain('R29');
    },
    120_000,
  );
});
