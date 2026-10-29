// ANAF's DUKIntegrator with the S1005 validator (J14.0.3 of 17.03.2026, package S1005_20260317),
// as installed by `bun run validators:fetch`, over the writer's 2025 statements of two invented
// microentities and over mutations it must reject. Without DUKIntegrator or Java the tests are
// skipped, never passed.
import { describe, expect } from 'bun:test';
import { anaf, validateAnaf } from './anaf';
import {
  checkS1005,
  completeS1005,
  s1005Format,
  writeS1005,
  type S1005,
} from '../../packages/xfactura-core/src/ro/annual/s1005';
import {
  servicesStatements,
  startupStatements,
} from '../../packages/xfactura-core/test/fixtures/s1005';

/** The rule codes of DUKIntegrator's errors ("eroare regula: F10_62: …"), sorted. */
const ruleCodes = (result: string) =>
  [...result.matchAll(/eroare regula: (?:\/\/)?([A-Za-z0-9_.]+):/g)]
    .map((match) => match[1]!)
    .sort();
const errorCodes = (model: S1005) =>
  checkS1005(model)
    .filter((check) => check.severity === 'error')
    .map((check) => check.code)
    .sort();

describe('official S1005 validation', () => {
  anaf(
    'DUKIntegrator accepts the 2025 statements without errors or warnings',
    async () => {
      const statements: Record<string, S1005> = {
        // Profit in 2024 and 2025, fixed assets, VAT, employees, chapters III, VIII and XII.
        services: servicesStatements(),
        // A first year with a loss, negative equity, a long-term shareholder loan, no F40 rows.
        startup: startupStatements(),
      };
      for (const model of Object.values(statements)) expect(checkS1005(model)).toEqual([]);
      const services = completeS1005(statements.services!);
      expect(services.F10['49']).toEqual([73_219, 104_254]);
      expect(services.F20['08']).toEqual([67_979, 81_035]);
      expect(completeS1005(statements.startup!).F10['46']).toEqual([0, -2691]);
      const results = await validateAnaf(
        'S1005',
        Object.fromEntries(
          Object.entries(statements).map(([name, model]) => [name, writeS1005(model)]),
        ),
      );
      expect(results).toEqual({ services: 'ok', startup: 'ok' });
    },
    120_000,
  );

  anaf(
    'DUKIntegrator rejects what checkS1005 rejects, under the same rule codes',
    async () => {
      const filed = completeS1005(servicesStatements());
      const xml = writeS1005(filed);
      const mutate = (from: string, to: string) => {
        expect(xml).toContain(from);
        return xml.replace(from, to);
      };
      // Each case: the model checkS1005 rejects, and the XML the writer would give for it.
      const cases: Record<string, { model: S1005; from: string; to: string }> = {
        'equity-total': {
          model: { ...filed, F10: { ...filed.F10, '49': [73_219, 104_255] } },
          from: 'F10_0492="104254"',
          to: 'F10_0492="104255"',
        },
        'net-profit': {
          model: { ...filed, F20: { ...filed.F20, '08': [67_979, 81_036] } },
          from: 'F20_0082="81035"',
          to: 'F20_0082="81036"',
        },
        'xix-net-profit': {
          model: { ...filed, F30: { ...filed.F30, '235': [67_979, 81_034] } },
          from: 'F30_2352="81035"',
          to: 'F30_2352="81034"',
        },
        'xix-operating-loss': {
          model: { ...filed, F30: { ...filed.F30, '210': [0, 1] } },
          from: 'F30_2102="0"',
          to: 'F30_2102="1"',
        },
        'xix-turnover': {
          model: { ...filed, F30: { ...filed.F30, '167': [120_000, 150_001] } },
          from: 'F30_1672="150000"',
          to: 'F30_1672="150001"',
        },
        'fixed-asset-row': {
          model: { ...filed, F40: { ...filed.F40, '10': [0, 8000, 0, 0, 7999] } },
          from: 'F40_0105="8000"',
          to: 'F40_0105="7999"',
        },
        'preparer-cif': {
          model: { ...filed, preparer: { ...filed.preparer, cif: undefined } },
          from: ' cif_intocmit="14399840"',
          to: '',
        },
      };
      const expected = Object.fromEntries(
        Object.entries(cases).map(([name, { model }]) => [name, errorCodes(model)]),
      );
      expect(expected).toEqual({
        'equity-total': ['F10_62', 'F10_64'],
        'net-profit': ['F10_F20_3', 'F10_F30_1', 'F20_2', 'F20_F30_8'],
        'xix-net-profit': ['F20_F30_8', 'F30_148.1'],
        'xix-operating-loss': ['F30_128.2'],
        'xix-turnover': ['F20_F30_2', 'F30_102', 'F30_112'],
        'fixed-asset-row': ['F40_14', 'F40_27'],
        'preparer-cif': ['R22a'],
      });
      const results = await validateAnaf('S1005', {
        ...Object.fromEntries(
          Object.entries(cases).map(([name, { from, to }]) => [name, mutate(from, to)]),
        ),
        // CAEN 9999 is in no list: checkS1005 has the validator's list.
        caen: mutate('caen="6210"', 'caen="9999"'),
        namespace: xml.replaceAll('s1005:declaratie:v15', 's1005:declaratie:v14'),
        'year-2026': mutate('an="2025"', 'an="2026"'),
      });
      for (const name of Object.keys(cases)) {
        expect(results[name]).toStartWith('E:');
        expect(ruleCodes(results[name]!)).toEqual(expected[name]!);
      }
      expect(errorCodes({ ...filed, entity: { ...filed.entity, caen: '9999' } })).toEqual([
        'S1005_CAEN',
      ]);
      expect(results.caen).toBe(
        "E: validari globale\n eroare atribut: caen: valoarea '9999' nu se afla in lista",
      );
      expect(results.namespace).toStartWith('F:');
      expect(results.namespace).toContain(
        "Valoarea corecta este xmlns='mfp:anaf:dgti:s1005:declaratie:v15'",
      );
      // J14.0.3 applies its 2025 rules to a later year too; the writer refuses one it has no
      // format for.
      expect(results['year-2026']).toBe('ok');
      expect(() => s1005Format(2026)).toThrow('formatul pentru 2026 nu este cunoscut');
    },
    120_000,
  );
});
