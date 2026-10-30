// Runs ANAF's D204 validator (J3.0.14, D204_16012026.zip) over the writer's synthetic returns of a
// family enterprise for the income of 2025 and 2024, and over mutations it must reject. It checks
// the identification codes, the lists, the dates and the loss rows; it does not require the quotas
// to add up to 100% and only warns about a member's share, which checkD204 controls. Without
// DUKIntegrator or Java the tests are skipped, never passed.
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { anaf, duk, validateAnaf } from './anaf';
import {
  checkD204,
  writeD204,
  type D204,
} from '../../packages/xfactura-core/src/ro/declarations/d204';

const validator = existsSync(path.join(duk, 'lib/D204Validator.jar')) ? anaf : test.skip;

// Synthetic CNPs and CUI (valid control digits, nobody's).
const ion = '1750312170031';
const maria = '2800911170044';
const andrei = '5020304123459';

/** A family enterprise of two members in the real system: 185,432 − 62,715 = 122,717 lei, 60/40
 * (73,630.20 and 49,086.80: the leftover leu to the larger remainder). */
const declaration = (overrides: Partial<D204> = {}): D204 => ({
  year: 2025,
  association: {
    name: 'Popescu Ion Întreprindere Familială',
    cif: '12345674',
    address: 'Str. Morii nr. 3, Galați, jud. Galați',
    email: 'if.popescu@example.test',
  },
  representative: {
    name: 'Popescu Ion',
    cnp: ion,
    address: 'Str. Morii nr. 3, Galați, jud. Galați',
    phone: '0236000000',
  },
  activity: {
    caen: '1071',
    county: 'GL',
    locality: 'Galați',
    seat: 'Str. Morii nr. 3',
    contract: { number: '1234/2020', date: '2020-01-15' },
    authorization: { number: 'F17/123/2020', date: '2020-01-10' },
    gross: 185_432,
    deductible: 62_715,
    net: 122_717,
    loss: 0,
  },
  members: [
    { name: 'Popescu Ion', cnp: ion, quotaBp: 6000, net: 73_630, loss: 0 },
    {
      name: 'Popescu Maria',
      cnp: maria,
      domicile: 'Str. Morii nr. 3, Galați',
      quotaBp: 4000,
      net: 49_087,
      loss: 0,
    },
  ],
  ...overrides,
});

const base = declaration();
/** The writer's XML for a model checkD204 refuses: the valid model's XML with the wrong values. */
function writeD204Unchecked(model: D204) {
  let xml = writeD204(base);
  const swap = (from: string, to: string) => {
    expect(xml).toContain(from);
    xml = xml.replace(from, to);
  };
  const [first, second] = model.members;
  if (model.activity.net !== base.activity.net)
    swap(`net3="${base.activity.net}"`, `net3="${model.activity.net}"`);
  if (first!.quotaBp !== base.members[0]!.quotaBp)
    swap(`cota_d="${base.members[0]!.quotaBp / 100}"`, `cota_d="${first!.quotaBp / 100}"`);
  if (first!.net !== base.members[0]!.net)
    swap(`venit_d="${base.members[0]!.net}"`, `venit_d="${first!.net}"`);
  if (second!.net !== base.members[1]!.net)
    swap(`venit_d="${base.members[1]!.net}"`, `venit_d="${second!.net}"`);
  if (model.representative.cnp !== base.representative.cnp)
    swap(`cif_r="${base.representative.cnp}"`, `cif_r="${model.representative.cnp}"`);
  return xml;
}
const declarations: Record<string, D204> = {
  profit: base,
  // 61,097 − 48,250 = 12,847 lei of loss: 7,708.20 and 5,138.80.
  loss: declaration({
    activity: { ...base.activity, gross: 48_250, deductible: 61_097, net: 0, loss: 12_847 },
    members: [
      { ...base.members[0]!, net: 0, loss: 7708 },
      { ...base.members[1]!, net: 0, loss: 5139 },
    ],
  }),
  // Three members, two decimals: 90,001 lei at 33.34/33.33/33.33.
  'three-members': declaration({
    activity: {
      ...base.activity,
      gross: 150_001,
      deductible: 60_000,
      net: 90_001,
      startedOn: '2025-03-01',
    },
    members: [
      { name: 'Popescu Ion', cnp: ion, quotaBp: 3334, net: 30_007, loss: 0 },
      { name: 'Popescu Maria', cnp: maria, quotaBp: 3333, net: 29_997, loss: 0 },
      { name: 'Popescu Andrei', cnp: andrei, quotaBp: 3333, net: 29_997, loss: 0 },
    ],
  }),
  // Bucharest needs its sector; the CAEN Rev. 3 list applies from 2025.
  bucharest: declaration({
    activity: { ...base.activity, county: 'B', sector: 3, locality: 'București', caen: '6210' },
  }),
  // The income of 2024: CAEN Rev. 2 only.
  'income-2024': declaration({ year: 2024, rectifies: true }),
};

describe('official D204 validation', () => {
  validator(
    'DUKIntegrator accepts the family enterprise’s returns without errors or warnings',
    async () => {
      for (const model of Object.values(declarations)) expect(checkD204(model)).toEqual([]);
      const results = await validateAnaf(
        'D204',
        Object.fromEntries(
          Object.entries(declarations).map(([name, model]) => [name, writeD204(model)]),
        ),
      );
      expect(results).toEqual(
        Object.fromEntries(Object.keys(declarations).map((name) => [name, 'ok'])),
      );
    },
    180_000,
  );

  validator(
    'DUKIntegrator rejects a wrong CNP or CUI, the loss rows, the year, a missing associate',
    async () => {
      const xml = writeD204(base);
      const loss = writeD204(declarations.loss!);
      const mutate = (source: string, from: string | RegExp, to: string) => {
        expect(source).toMatch(from);
        return source.replace(from, to);
      };
      const results = await validateAnaf('D204', {
        'member-cnp': mutate(xml, `cif_d="${maria}"`, 'cif_d="2800911170045"'),
        'representative-cnp': mutate(xml, `cif_r="${ion}"`, 'cif_r="1750312170032"'),
        cif: mutate(xml, 'cif="12345674"', 'cif="12345675"'),
        // R46.2: a profit year has no loss; R46.1: the loss is the expenses less the income.
        'profit-loss': mutate(xml, 'pierd3="0"', 'pierd3="10"'),
        'wrong-loss': mutate(loss, 'pierd3="12847"', 'pierd3="12000"'),
        year: mutate(xml, 'an="2025"', 'an="2017"'),
        'no-associate': mutate(xml, /\s*<asociat [^>]*\/>\s*<asociat [^>]*\/>/, ''),
        // Rev. 3 codes are not in the 2024 list.
        'caen-2024': mutate(writeD204(declarations['income-2024']!), 'CAEN="1071"', 'CAEN="6210"'),
        // Bucharest without its sector.
        sector: mutate(writeD204(declarations.bucharest!), ' sector="3"', ''),
        quota: mutate(xml, 'cota_d="40"', 'cota_d="40.001"'),
        'empty-attribute': mutate(xml, 'telefon_r="0236000000"', 'telefon_r=""'),
      });
      expect(results['member-cnp']).toContain('CNP invalid');
      expect(results['representative-cnp']).toContain('CNP invalid');
      expect(results.cif).toContain('CUI invalid');
      expect(results['profit-loss']).toContain('R46.2');
      expect(results['wrong-loss']).toContain('R46.1');
      expect(results.year).toContain("an: valoarea '2017' nu se incadreaza in intervalul cerut");
      expect(results['no-associate']).toContain('lipsa sectiune obligatorie');
      expect(results['caen-2024']).toContain("CAEN: valoarea '6210' nu se afla in lista");
      expect(results.sector).toContain('R32.1');
      expect(results.quota).toContain('nu respecta modelul');
      expect(results['empty-attribute']).toContain('vid nepermis');
      for (const result of Object.values(results)) expect(result).not.toBe('ok');
    },
    180_000,
  );

  validator(
    'what the validator does not check, checkD204 does: quotas, totals, shares, the representative',
    async () => {
      const wrong: Record<string, D204> = {
        // Quotas of 90%.
        quotas: declaration({
          members: [
            { ...base.members[0]!, quotaBp: 5000, net: 61_359 },
            { ...base.members[1]!, quotaBp: 4000, net: 49_087 },
          ],
        }),
        // A net income that is not the gross income less the expenses, distributed as declared.
        totals: declaration({
          activity: { ...base.activity, net: 100_000 },
          members: [
            { ...base.members[0]!, net: 60_000 },
            { ...base.members[1]!, net: 40_000 },
          ],
        }),
        // A share 2 lei away from the quota.
        share: declaration({
          members: [base.members[0]!, { ...base.members[1]!, net: 49_089 }],
        }),
        // The representative is not an associate.
        representative: declaration({
          representative: { ...base.representative, cnp: andrei },
        }),
      };
      expect(
        Object.fromEntries(
          Object.entries(wrong).map(([name, model]) => [
            name,
            checkD204(model)
              .filter((check) => check.severity === 'error')
              .map((check) => check.code),
          ]),
        ),
      ).toEqual({
        quotas: ['D204_QUOTA'],
        totals: ['D204_TOTALS'],
        share: ['D204_DISTRIBUTION'],
        representative: ['D204_REPRESENTATIVE'],
      });
      // ANAF's validator accepts each of them.
      const results = await validateAnaf('D204', {
        quotas: writeD204Unchecked(wrong.quotas!),
        totals: writeD204Unchecked(wrong.totals!),
        representative: writeD204Unchecked(wrong.representative!),
      });
      expect(results).toEqual({ quotas: 'ok', totals: 'ok', representative: 'ok' });
    },
    180_000,
  );
});
