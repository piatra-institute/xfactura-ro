import { describe, expect, test } from 'bun:test';
import {
  checkD204,
  d204Counties,
  d204Format,
  quotaText,
  writeD204,
  type D204,
} from '../src/ro/declarations/d204';
import { counties } from '../src/ro/geo';

// Synthetic people and amounts; every expected figure is computed by hand.
const ion = '1750312170031';
const maria = '2800911170044';

/** A family enterprise: 50,000 − 4,012 = 45,988 lei, 60/40 (27,592.80 and 18,395.20). */
const declaration = (overrides: Partial<D204> = {}): D204 => ({
  year: 2025,
  association: { name: 'Popescu Ion Întreprindere Familială', cif: '12345674', address: 'Galați' },
  representative: { name: 'Popescu Ion', cnp: ion, address: 'Str. Morii nr. 3, Galați' },
  activity: {
    caen: '1071',
    county: 'GL',
    seat: 'Str. Morii nr. 3',
    contract: { number: '1234/2025', date: '2025-01-20' },
    gross: 50_000,
    deductible: 4012,
    net: 45_988,
    loss: 0,
  },
  members: [
    { name: 'Popescu Ion', cnp: ion, quotaBp: 6000, net: 27_593, loss: 0 },
    { name: 'Popescu Maria', cnp: maria, quotaBp: 4000, net: 18_395, loss: 0 },
  ],
  ...overrides,
});
const errors = (model: D204) =>
  checkD204(model)
    .filter((check) => check.severity === 'error')
    .map((check) => check.code);
const attributes = (xml: string, name: string) =>
  [...xml.matchAll(new RegExp(`<${name}\\s([^>]*?)/?>`, 'g'))].map((match) =>
    Object.fromEntries([...match[1]!.matchAll(/([\w:]+)="([^"]*)"/g)].map((m) => [m[1], m[2]])),
  );

describe('D204', () => {
  test('pinned for the income of 2022–2026, in structure declaratie:v3', () => {
    expect(d204Format(2025)).toMatchObject({
      namespace: 'mfp:anaf:dgti:d204:declaratie:v3',
      validator: 'D204Validator J3.0.14',
    });
    expect(d204Format(2021)).toBeNull();
    expect(d204Format(2027)).toBeNull();
    expect(errors(declaration({ year: 2027 }))).toEqual(['D204_YEAR']);
    // Every county of the structure's list, by its ISO code.
    expect(
      Object.keys(d204Counties)
        .map((code) => `RO-${code}`)
        .sort(),
    ).toEqual(Object.keys(counties).sort());
    expect([6000, 3333, 1250, 10_000, 5].map(quotaText)).toEqual([
      '60',
      '33.33',
      '12.5',
      '100',
      '0.05',
    ]);
  });

  test('the association, its representative, the activity and the distribution', () => {
    const model = declaration();
    expect(checkD204(model)).toEqual([]);
    const xml = writeD204(model);
    expect(attributes(xml, 'd204')).toEqual([
      {
        xmlns: 'mfp:anaf:dgti:d204:declaratie:v3',
        luna: '12',
        an: '2025',
        d_rec: '0',
        totalPlata_A: '0',
        nume: 'Popescu Ion Întreprindere Familială',
        cif: '12345674',
        adresa: 'Galați',
        den_r: 'Popescu Ion',
        cif_r: ion,
        adresa_r: 'Str. Morii nr. 3, Galați',
      },
    ]);
    expect(attributes(xml, 'activitate')).toEqual([
      {
        categ_venit: '1',
        forma_org: '1',
        det_ven_net: '1',
        nr_asoc: '2',
        CAEN: '1071',
        judet: '17',
        sediu: 'Str. Morii nr. 3',
        nr_contr: '1234/2025',
        data_contr: '20.01.2025',
        venit3: '50000',
        chelt3: '4012',
        net3: '45988',
        pierd3: '0',
      },
    ]);
    expect(attributes(xml, 'asociat')).toEqual([
      { nume_d: 'Popescu Ion', cif_d: ion, cota_d: '60', venit_d: '27593', pierd_d: '0' },
      { nume_d: 'Popescu Maria', cif_d: maria, cota_d: '40', venit_d: '18395', pierd_d: '0' },
    ]);
    // No empty attribute is ever written: ANAF's validator refuses them.
    expect(xml).not.toContain('=""');
  });

  test('controls the validator leaves out: quotas of 100%, totals, shares within a leu', () => {
    const base = declaration();
    expect(
      errors(
        declaration({
          members: [{ ...base.members[0]!, quotaBp: 5000 }, base.members[1]!],
        }),
      ),
    ).toEqual(['D204_DISTRIBUTION', 'D204_QUOTA']);
    expect(errors(declaration({ activity: { ...base.activity, net: 45_000 } }))).toContain(
      'D204_TOTALS',
    );
    // One leu from round(net × quota) is within the structure's margin; two are not.
    const near = declaration({
      members: [
        { ...base.members[0]!, net: 27_592 },
        { ...base.members[1]!, net: 18_396 },
      ],
    });
    expect(errors(near)).toEqual([]);
    expect(
      errors(declaration({ members: [{ ...base.members[0]!, net: 27_595 }, base.members[1]!] })),
    ).toEqual(['D204_DISTRIBUTION']);
    // Shares that do not add up to the total: a warning.
    const short = checkD204(
      declaration({ members: [{ ...base.members[0]!, net: 27_592 }, base.members[1]!] }),
    );
    expect(short.map((check) => [check.code, check.severity])).toEqual([
      ['D204_DISTRIBUTION', 'warning'],
    ]);
    // A loss: no net income, the loss distributed.
    expect(
      errors(
        declaration({
          activity: { ...base.activity, gross: 3000, deductible: 4958, net: 0, loss: 1958 },
          members: [
            { ...base.members[0]!, net: 0, loss: 1175 },
            { ...base.members[1]!, net: 0, loss: 783 },
          ],
        }),
      ),
    ).toEqual([]);
  });

  test('identification, county and sector, contract and dates; no CNP in a message', () => {
    const base = declaration();
    expect(errors(declaration({ association: { ...base.association, cif: '12345675' } }))).toEqual([
      'D204_CIF',
    ]);
    expect(
      errors(
        declaration({
          members: [base.members[0]!, { ...base.members[1]!, cnp: '2800911170045' }],
        }),
      ),
    ).toEqual(['D204_CNP']);
    expect(
      errors(
        declaration({ representative: { ...base.representative, cnp: maria.replace('28', '18') } }),
      ),
    ).toContain('D204_CNP');
    expect(errors(declaration({ activity: { ...base.activity, county: 'B' } }))).toEqual([
      'D204_SECTOR',
    ]);
    expect(errors(declaration({ activity: { ...base.activity, county: 'B', sector: 7 } }))).toEqual(
      ['D204_SECTOR'],
    );
    expect(errors(declaration({ activity: { ...base.activity, county: 'XX' } }))).toEqual([
      'D204_COUNTY',
    ]);
    expect(
      errors(
        declaration({
          activity: { ...base.activity, contract: { number: '1', date: '2026-01-05' } },
        }),
      ),
    ).toEqual(['D204_CONTRACT']);
    expect(
      errors(declaration({ activity: { ...base.activity, startedOn: '2024-05-01' } })),
    ).toEqual(['D204_DATE']);
    const messages = checkD204(
      declaration({
        representative: { ...base.representative, cnp: '1750312170032' },
        members: [{ ...base.members[0]!, cnp: '1750312170032' }, base.members[1]!],
      }),
    ).map((check) => check.message);
    expect(messages.join(' ')).not.toContain('1750312170032');
  });
});
