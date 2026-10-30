// Runs ANAF's D212 validator (J13.0.1, D212Validator_01082025.zip) over the writer's synthetic
// declarations for the income of 2024 (an_r 2025), and over mutations it must reject. The
// validator loads only in ANAF's SAF-T kit (it needs `dec.DECTagCtx`, absent from the general
// kit). It checks the structure, the CNP, the CAEN list and a few rules, not the arithmetic,
// which checkD212 controls. Without the kit or Java the tests are skipped, never passed.
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { anafSaft, saftDuk, validateAnaf } from './anaf';
import {
  checkD212,
  writeD212,
  type D212,
  type D212Norm,
} from '../../packages/xfactura-core/src/ro/declarations/d212';

const validator = existsSync(path.join(saftDuk, 'lib/D212Validator.jar')) ? anafSaft : test.skip;

/** A PFA's 2024 in the real system (synthetic CNP and amounts; the minimum wage of the structure,
 * 3,300 lei). */
const declaration = (overrides: Partial<D212> = {}): D212 => ({
  year: 2024,
  taxpayer: {
    cnp: '2850722170021',
    lastName: 'Ionescu',
    initial: 'V',
    firstName: 'Maria',
    address: 'Str. Lunga nr. 10, Galati, jud. Galati',
    phone: '0236000000',
    email: 'maria.ionescu@example.test',
    iban: 'RO49AAAA1B31007593840000',
  },
  activity: {
    caen: '6920',
    seat: 'Str. Lunga nr. 10, Galati',
    authorization: { number: '123/2019', date: '2019-03-15' },
    gross: 50_000,
    deductible: 4012,
    carriedLosses: 0,
    offsetLoss: 0,
  },
  casStatus: 'liable',
  // 45,988 lei: CAS on 12 × 3,300 = 39,600 lei.
  cas: { base: 39_600, due: 9900 },
  cassException: false,
  cass: { base: 45_988, due: 4599, minimumDifference: 0 },
  tax: { deductibleCas: 9900, deductibleCass: 4599, due: 3149 },
  ...overrides,
});

const activity = declaration().activity!;
const declarations: Record<string, D212> = {
  'cas-and-cass': declaration(),
  // 100,000 lei: CAS on 24 wages (79,200 lei), CASS 10,000, taxable 70,200.
  'upper-band': declaration({
    activity: { ...activity, gross: 120_000, deductible: 20_000, startedOn: '2024-02-01' },
    cas: { base: 79_200, due: 19_800 },
    cass: { base: 100_000, due: 10_000, minimumDifference: 0 },
    tax: { deductibleCas: 19_800, deductibleCass: 10_000, due: 7020 },
  }),
  // 15,000 lei: CASS on the minimum of 6 wages (19,800 lei, 1,980), 1,500 of it deducted.
  'cass-minimum': declaration({
    activity: { ...activity, gross: 18_000, deductible: 3000 },
    cas: null,
    cass: { base: 19_800, due: 1980, minimumDifference: 480 },
    tax: { deductibleCas: 0, deductibleCass: 1500, due: 1350 },
  }),
  // Losses carried from 2022: at most 70% of 40,000 lei offset.
  'losses-carried': declaration({
    activity: {
      ...activity,
      gross: 46_000,
      deductible: 6000,
      carriedLosses: 35_000,
      offsetLoss: 28_000,
    },
    cas: { base: 39_600, due: 9900 },
    cass: { base: 40_000, due: 4000, minimumDifference: 0 },
    tax: { deductibleCas: 9900, deductibleCass: 2100, due: 0 },
  }),
  // A loss, and the option to pay CASS in 2025 (situation B): 6 × 4,050 lei.
  'loss-and-option': declaration({
    activity: { ...activity, gross: 3000, deductible: 4958, endedOn: '2024-11-30' },
    cas: null,
    cass: null,
    tax: { deductibleCas: 0, deductibleCass: 0, due: 0 },
    cassOption: { situation: 'B', base: 24_300, due: 2430 },
  }),
  // A pensioner: no CAS.
  pensioner: declaration({
    casStatus: 'pensioner',
    cas: null,
    tax: { deductibleCas: 0, deductibleCass: 4599, due: 4139 },
  }),
  rectifying: declaration({ rectifies: { income: true, option: false } }),
  // A member of an association (forma_org 2): only the net income distributed, 45,988 lei.
  member: declaration({
    activity: {
      caen: activity.caen,
      seat: activity.seat,
      authorization: activity.authorization,
      association: { number: '45/2020', date: '2020-02-10', net: 45_988, loss: 0 },
      carriedLosses: 0,
      offsetLoss: 0,
    },
  }),
  // On a norm, started on 2 December 2024 (the structure's Subsection 2 is for those only):
  // 40,000 × 1.10 × 0.80 = 35,200 lei, × 30/365 days = 2,893 lei; CASS on 6 × 3,300 lei.
  norm: normDeclaration(),
  'norm-member': normDeclaration({ association: true }),
};

function normDeclaration(overrides: Partial<D212Norm> = {}): D212 {
  const { activity: _, ...model } = declaration({
    cas: null,
    cass: { base: 19_800, due: 1980, minimumDifference: 1691 },
    tax: { deductibleCas: 0, deductibleCass: 0, due: 0 },
  });
  return {
    ...model,
    norm: {
      association: false,
      caen: '9602',
      seat: 'Str. Lunga nr. 10, Galati',
      authorization: { number: '77/2024', date: '2024-11-25' },
      startedOn: '2024-12-02',
      activeDays: 30,
      norm: 40_000,
      increase: { percent: '10', criterion: '01' },
      reduction: { percent: '20', criterion: '05' },
      adjusted: 35_200,
      net: 2893,
      tax: 289,
      ...overrides,
    },
  };
}

describe('official D212 validation', () => {
  validator(
    'DUKIntegrator accepts the declarations for the income of 2024 without errors or warnings',
    async () => {
      for (const model of Object.values(declarations)) expect(checkD212(model)).toEqual([]);
      const results = await validateAnaf(
        'D212',
        Object.fromEntries(
          Object.entries(declarations).map(([name, model]) => [name, writeD212(model)]),
        ),
        saftDuk,
      );
      expect(results).toEqual(
        Object.fromEntries(Object.keys(declarations).map((name) => [name, 'ok'])),
      );
    },
    180_000,
  );

  validator(
    'DUKIntegrator rejects a wrong control sum, CNP or CAEN, a missing cap11, the web form’s attributes',
    async () => {
      const xml = writeD212(declarations['cas-and-cass']!);
      const option = writeD212(declarations['loss-and-option']!);
      const mutate = (source: string, from: string | RegExp, to: string) => {
        expect(source).toMatch(from);
        return source.replace(from, to);
      };
      const results = await validateAnaf(
        'D212',
        {
          'control-sum': mutate(xml, 'totalPlata_A="37"', 'totalPlata_A="38"'),
          cnp: mutate(
            mutate(xml, 'cif="2850722170021"', 'cif="2850722170022"'),
            'totalPlata_A="37"',
            'totalPlata_A="38"',
          ),
          // 6210 is CAEN Rev. 3 (programming); the structure's list is Rev. 2.
          caen: mutate(xml, 'caen="6920"', 'caen="6210"'),
          'no-cap11': mutate(xml, /\s*<cap11[^>]*\/>/, ''),
          // The rectifying flag without the chapter it rectifies (R1).
          rectification: mutate(xml, 'd_rec="0"', 'd_rec="1"'),
          // The web form's 2026 attributes are not in this structure.
          'web-attribute': mutate(
            xml,
            ' cass_datorat_ai=',
            ' cass_anuala_ai="4599" cass_datorat_ai=',
          ),
          // Chapter II's total must be the option's CASS.
          'option-total': mutate(option, 'totalCassDatorat="2430"', 'totalCassDatorat="2431"'),
          // 2024 is filed in another namespace.
          'filing-year': mutate(xml, 'an_r="2025"', 'an_r="2024"'),
          negative: mutate(xml, 'cas_dif_plus="9900"', 'cas_dif_plus="-9900"'),
        },
        saftDuk,
      );
      expect(results['control-sum']).toContain('R4');
      expect(results.cnp).toContain('CNP invalid');
      expect(results.caen).toContain("caen: valoarea '6210' nu se afla in lista");
      expect(results['no-cap11']).toContain('R7');
      expect(results.rectification).toContain('R1');
      expect(results['web-attribute']).toContain('atribut necunoscut');
      expect(results['option-total']).toContain('Rcass_estimat');
      expect(results['filing-year']).toContain('namespace');
      expect(results.negative).toContain('nu se incadreaza in intervalul cerut');
      for (const result of Object.values(results)) expect(result).not.toBe('ok');
    },
    180_000,
  );

  validator(
    'DUKIntegrator rejects a norm without cap12, a coefficient row, a Rev. 3 CAEN, a member’s form 4',
    async () => {
      const norm = writeD212(declarations.norm!);
      const member = writeD212(declarations.member!);
      const mutate = (source: string, from: string | RegExp, to: string) => {
        expect(source).toMatch(from);
        return source.replace(from, to);
      };
      const results = await validateAnaf(
        'D212',
        {
          'no-cap12': mutate(norm, /\s*<cap12[^>]*\/>/, ''),
          // The web form's coefficient rows are not in this structure.
          corectie: mutate(
            norm,
            /<cap12([^>]*)\/>/,
            '<cap12$1><corectie criteriu="01" coeficient_majorare="10.00"/></cap12>',
          ),
          'norm-caen': mutate(norm, 'norma_caen="9602"', 'norma_caen="6210"'),
          // A real-system flag without cap11 (R7).
          'real-flag': mutate(norm, 'bifa111="0"', 'bifa111="1"'),
          'member-form': mutate(member, 'forma_org="2"', 'forma_org="4"'),
          // The web form's association contract is not in this structure.
          'member-contract': mutate(
            member,
            ' venit_net_anual=',
            ' nr_doc_asociere="45/2020" venit_net_anual=',
          ),
        },
        saftDuk,
      );
      expect(results['no-cap12']).toContain('R8');
      expect(results.corectie).toContain("element necunoscut ('corectie')");
      expect(results['norm-caen']).toContain("norma_caen: valoarea '6210' nu se afla in lista");
      expect(results['real-flag']).toContain('R7');
      expect(results['member-form']).toContain('nu se incadreaza in intervalul cerut');
      expect(results['member-contract']).toContain('atribut necunoscut');
      for (const result of Object.values(results)) expect(result).not.toBe('ok');
    },
    180_000,
  );
});
