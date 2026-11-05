// ANAF's DUKIntegrator with the S1003 validator (J14.0.0 of 10.02.2026, package S1003_20260210)
// and the S1046 validator (J1.2.0, package S1046_20160209), as installed by `bun run
// validators:fetch`, over the writers' 2025 statements of an invented small entity, an inactivity
// declaration, and mutations. Without DUKIntegrator or Java the tests are skipped, never passed.
//
// What J14.0.0 checks: its rule set for 2025 (s1003validator/v13) holds the schema, the
// identification (R22a, the CAEN lists, the namespace) and the value ranges, but none of the
// form's arithmetic: 2024's (v12) held them, 2025's does not. The arithmetic of the structure is
// checkS1003's alone, and this test pins that the validator accepts what only checkS1003 rejects,
// so a later package that applies them shows up as drift.
import { describe, expect } from 'bun:test';
import { anaf, validateAnaf } from './anaf';
import {
  checkS1003,
  completeS1003,
  s1003Format,
  writeS1003,
  type S1003,
} from '../../packages/xfactura-core/src/ro/annual/s1003';
import { s1046Format, writeS1046 } from '../../packages/xfactura-core/src/ro/annual/s1046';
import { consultingStatements } from '../../packages/xfactura-core/test/fixtures/s1003';

const errorCodes = (model: S1003) =>
  checkS1003(model)
    .filter((check) => check.severity === 'error')
    .map((check) => check.code)
    .sort();

describe('official S1003 validation', () => {
  anaf(
    'DUKIntegrator accepts the 2025 statements of a small entity',
    async () => {
      const model = consultingStatements();
      expect(checkS1003(model)).toEqual([]);
      const filed = completeS1003(model);
      expect(filed.F20['69']).toEqual([1_055_040, 1_115_940]);
      expect(filed.F10['49']).toEqual([2_795_040, 3_910_980]);
      expect(await validateAnaf('S1003', { consulting: writeS1003(model) })).toEqual({
        consulting: 'ok',
      });
    },
    120_000,
  );

  anaf(
    'DUKIntegrator rejects the identification and range errors; the arithmetic is checkS1003’s',
    async () => {
      const filed = completeS1003(consultingStatements());
      const xml = writeS1003(filed);
      const mutate = (from: string, to: string) => {
        expect(xml).toContain(from);
        return xml.replace(from, to);
      };
      const debts = filed.F30['95']![1] as number;
      // The form's arithmetic: rejected here, under the structure's codes.
      const arithmetic: Record<string, { model: S1003; from: string; to: string }> = {
        'equity-total': {
          model: { ...filed, F10: { ...filed.F10, '49': [2_795_040, 3_910_981] } },
          from: 'F10_0492="3910980"',
          to: 'F10_0492="3910981"',
        },
        'net-profit': {
          model: { ...filed, F20: { ...filed.F20, '69': [1_055_040, 1_115_941] } },
          from: 'F20_0692="1115940"',
          to: 'F20_0692="1115941"',
        },
        'operating-loss': {
          model: { ...filed, F20: { ...filed.F20, '44': [0, 1] } },
          from: 'F20_0442="0"',
          to: 'F20_0442="1"',
        },
        turnover: {
          model: { ...filed, F20: { ...filed.F20, '01': [4_800_000, 5_200_001] } },
          from: 'F20_0012="5200000"',
          to: 'F20_0012="5200001"',
        },
        debts: {
          model: {
            ...filed,
            F30: { ...filed.F30, '95': [filed.F30['95']![0], debts + 1] },
          },
          from: `F30_0952="${debts}"`,
          to: `F30_0952="${debts + 1}"`,
        },
        'fixed-asset-row': {
          model: { ...filed, F40: { ...filed.F40, '10': [150_000, 0, 0, 0, 149_999] } },
          from: 'F40_0105="150000"',
          to: 'F40_0105="149999"',
        },
      };
      expect(
        Object.fromEntries(
          Object.entries(arithmetic).map(([name, { model }]) => [name, errorCodes(model)]),
        ),
      ).toEqual({
        'equity-total': ['F10_62', 'F10_64'],
        'net-profit': ['F10_F20_3', 'F10_F30_1', 'F20_40'],
        'operating-loss': ['F20_20'],
        turnover: ['F20_2', 'F20_4'],
        debts: ['F30_56'],
        'fixed-asset-row': ['F40_14', 'F40_27'],
      });
      const results = await validateAnaf('S1003', {
        ...Object.fromEntries(
          Object.entries(arithmetic).map(([name, { from, to }]) => [name, mutate(from, to)]),
        ),
        'preparer-cif': mutate(' cif_intocmit="18547290"', ''),
        caen: mutate('caen="7022"', 'caen="9999"'),
        percent: mutate('F30_1514="100"', 'F30_1514="101"'),
        namespace: xml.replaceAll('s1003:declaratie:v15', 's1003:declaratie:v14'),
        'year-2026': mutate('an="2025"', 'an="2026"'),
      });
      // J14.0.0 does not apply the structure's arithmetic for 2025.
      for (const name of Object.keys(arithmetic)) expect(results[name]).toBe('ok');
      expect(errorCodes({ ...filed, preparer: { ...filed.preparer, cif: undefined } })).toEqual([
        'R22a',
      ]);
      expect(results['preparer-cif']).toStartWith('E:');
      expect(results['preparer-cif']).toContain('R22a');
      expect(errorCodes({ ...filed, entity: { ...filed.entity, caen: '9999' } })).toEqual([
        'S1003_CAEN',
      ]);
      expect(results.caen).toBe(
        "E: validari globale\n eroare atribut: caen: valoarea '9999' nu se afla in lista",
      );
      expect(results.percent).toBe(
        "E: F30 (1)\n eroare atribut: F30_1514: valoarea '101' nu se incadreaza in intervalul cerut",
      );
      expect(results.namespace).toStartWith('F:');
      expect(results.namespace).toContain(
        "Valoarea corecta este xmlns='mfp:anaf:dgti:s1003:declaratie:v15'",
      );
      // J14.0.0 takes a later year under its 2025 rules; the writer refuses a year without a
      // published package.
      expect(results['year-2026']).toBe('ok');
      expect(() => s1003Format(2026)).toThrow('ANAF nu a publicat formatul pentru 2026');
    },
    180_000,
  );
});

describe('official S1046 validation', () => {
  anaf(
    'DUKIntegrator accepts the inactivity declaration and checks its control sum',
    async () => {
      const xml = writeS1046({
        year: 2025,
        yearEnd: '2025-12-31',
        entityKind: 1,
        entity: {
          cui: '18547290',
          name: 'Exemplu Inactiv SRL',
          address: { locality: 'Galați', street: 'Str. Lungă', number: '10' },
          tradeRegister: 'J17/123/2024',
          county: 17,
          largeTaxpayer: false,
        },
        capital: 200,
        declarant: 'Popescu Ana',
      });
      const results = await validateAnaf('S1046', {
        declaration: xml,
        total: xml.replace('totalPlata_A="200"', 'totalPlata_A="201"'),
      });
      expect(results.declaration).toBe('ok');
      expect(results.total).toBe(
        'E: validari globale\n eroare regula: R16: totalPlata_A (201) = capital (200)',
      );
      expect(() => s1046Format(2026)).toThrow('pagina ANAF pentru 2026 nu a fost citită');
    },
    120_000,
  );
});
