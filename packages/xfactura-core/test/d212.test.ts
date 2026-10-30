import { describe, expect, test } from 'bun:test';
import {
  calculateD212,
  checkD212,
  d212Format,
  writeD212,
  type D212,
} from '../src/ro/declarations/d212';
import { isValidIban } from '../src/ro/identifiers';

// Synthetic people and amounts. Every expected figure is computed by hand from the structures'
// formulas, not by the writer.
const cnp = '1781105170030'; // digits sum to 34

const declaration = (overrides: Partial<D212> = {}): D212 => ({
  year: 2025,
  taxpayer: {
    cnp,
    lastName: 'Popescu',
    initial: 'm',
    firstName: 'Ion',
    address: 'Str. Exemplu nr. 1, Cluj-Napoca, Cluj',
    email: 'ion.popescu@example.test',
    iban: 'RO49AAAA1B31007593840000',
  },
  activity: {
    caen: '6201',
    seat: 'Str. Exemplu nr. 1, Cluj-Napoca',
    authorization: { number: 'F12/345/2023', date: '2023-12-20' },
    gross: 150_000,
    deductible: 30_000,
    carriedLosses: 0,
    offsetLoss: 0,
  },
  casStatus: 'liable',
  // 120,000 lei is at least 24 minimum wages (97,200): CAS on 97,200 lei.
  cas: { base: 97_200, due: 24_300 },
  cassException: false,
  cass: { base: 120_000, due: 12_000, minimumDifference: 0 },
  tax: { deductibleCas: 24_300, deductibleCass: 12_000, due: 8370 },
  ...overrides,
});

/** An element's attributes in document order. */
function attributes(xml: string, name: string): [string, string][] {
  const match = new RegExp(`<${name}(\\s[^>]*?)/?>`).exec(xml);
  if (!match) return [];
  return [...match[1]!.matchAll(/([\w:-]+)="([^"]*)"/g)].map((item) => [item[1]!, item[2]!]);
}
const values = (xml: string, name: string) => Object.fromEntries(attributes(xml, name));
const errors = (model: D212) =>
  checkD212(model)
    .filter((check) => check.severity === 'error')
    .map((check) => check.code);
const warnings = (model: D212) =>
  checkD212(model)
    .filter((check) => check.severity === 'warning')
    .map((check) => check.code);

/**
 * The web form's attribute order (anaf.ro/declaratii/duf V-1.8.10, bundle 0q0aa-_tiydwh.js,
 * SHA-256 e93cef76053d11622890e2ad9b48505d4f42d0f377c3477135170e6ed0d10337), read from its XML
 * writer: what the form emits for an_r 2026, in this order, skipping empty values.
 */
const webOrder = {
  d212: 'an_r luna_r d_rec rectif1 rectif2 totalPlata_A bifa_conformare bifa18 bifa19 bifa23 anulare_litA anulare_litB bifa111 bifa112 bifa14 bifa113 bifa121 bifa15 bifa122 bifa131 bifa132 nume_c initiala_c prenume_c cif cont_bancar adresa_c telefon_c fax_c email_c nerezident stat_rezidenta den_stat_rezidenta cif_str statut den_i cif_i adresa_i telefon_i fax_i email_i xmlns:xsi xsi:schemaLocation xmlns',
  oblig_realizat:
    'oblimpozit_real_bonif str_cas_baza str_cas_datorat str_cass_baza str_cass_datorat real_camere_inchiriere real_venit_inchiriere real_impozit_inchiriere cas_total_ven cas_baza cas_datorat cas_retinut_platitor cas_dif_plus bifa_cas_real bifa_cas_recalculat bifa_cas_sub_plafon cass_total_ven_ai baza_cass_datorat_ai cass_anuala_ai cass_datorat_art180_ai cass_datorat_ai cass_retinut_platitor_alin6_ai cass_dif_plus_ai cass_dif_minus6_ai cass_ven_dpi cass_ven_asc cass_ven_cfb cass_ven_inv cass_ven_asp cass_ven_alt cass_total_ven cass_baza cass_anuala cass_datorat_art180 cass_datorat cass_retinut cass_dif_plus cass_dif_minus bifa_cass_real bifa_cass_datorat_dpi bifa_cass_datorat_ai real_venit_net_recalculat_ai real_cas-deduc_ai real_cass-deductibil_ai real_venit_net_impozabil_ai real_venit_net_impozabil_redus_ai real_impozit_datorat_ai real_cas_venit_net_ai real_cas_total_ven_ai real_cas_pondere_ai real_cas_datorata_ai real_cas_deductibila_ai real_cass_venit_net_ai real_cass_total_ven_ai real_cass_pondere_ai real_cass_datorata_ai real_cass_calculata_ai real_cass_deductibila_ai real_venit_net_recalculat_dpi real_cas_dpi real_venit_net_impozabil_dpi real_venit_net_impozabil_redus_dpi real_impozit_datorat_dpi real_cas_venit_net_dpi real_cas_total_ven_dpi real_cas_pondere_dpi real_cas_datorata_dpi real_cas_deductibila_dpi real_diferenta_CASS real_impozit_diferenta_CASS oblimpoz_real_total oblimpoz_real_anticipat oblimpoz_real_dif_deplata oblimpoz_real_dif_restituit oblcas_real_difPlus oblcas_real_str oblcass_real_difPlus_ai oblcass_real_difMinus_ai oblcass_real_difMinus_174 oblcass_real_difPlus_dpi oblcass_real_difMinus_dpi oblcass_real_str oblcass_real_str_pensie impozit_venit_plus impozit_venit_minus cas_plus cass_plus cass_minus dif_de_plata dif_de_restituit',
  oblig_estimat:
    'bifa_optiune situatie_optiune baza_optiune cass_optiune bifa_optiune_coasigurat totalCassDatorat totalCassDatoratCoasigurat',
  cap11:
    'scutire reg categ_venit den_venit det_ven_net tip_chirie forma_org caen den_caen descriere_sediu_bun nr_doc_autoriz data_doc_autoriz nr_doc_asociere data_doc_asociere data_incep data_sf data_suspendare nr_zile_scutite venit_brut chelt_deduc pierdere venit_net_anual pierdere_precedenta pierdere_compensata venit_recalculat venit_redus impozit11 impozit_retinut',
};

/** Every attribute is one the form writes, in the form's order. */
function inWebOrder(xml: string, name: keyof typeof webOrder) {
  const order = webOrder[name].split(' ');
  const written = attributes(xml, name).map(([key]) => key);
  expect(written.filter((key) => !order.includes(key))).toEqual([]);
  expect(written).toEqual([...written].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
}

describe('D212 formats', () => {
  test('pinned by income year: 2024 in D212_A1.0.3, 2025 in the web form, none after', () => {
    expect(d212Format(2024)).toMatchObject({
      anR: 2025,
      namespace: 'mfp:anaf:dgti:d212:declaratie:v11',
      validator: 'D212Validator J13.0.1',
    });
    expect(d212Format(2025)).toMatchObject({ anR: 2026, validator: null });
    expect(d212Format(2026)).toBeNull();
    expect(d212Format(2023)).toBeNull();
    const later = declaration({ year: 2026 });
    expect(errors(later)).toEqual(['D212_YEAR']);
    expect(() => writeD212(later)).toThrow('2024 și 2025');
  });
});

describe('D212 for the income of 2025: the web form’s structure', () => {
  test('the form’s own figures for one source in the real system, attribute for attribute', () => {
    const model = declaration();
    expect(checkD212(model)).toEqual([]);
    const xml = writeD212(model);
    // The XML the form's writer gives for the same entries (brut 150,000, cheltuieli 30,000,
    // CAS base 97,200), hand-derived from its formulas; den_caen, the CAEN title from the form's
    // list, is the one attribute the engine does not write.
    expect(values(xml, 'd212')).toEqual({
      an_r: '2026',
      luna_r: '12',
      d_rec: '0',
      rectif1: '0',
      rectif2: '0',
      totalPlata_A: '34',
      bifa_conformare: '0',
      bifa18: '0',
      bifa19: '0',
      bifa23: '0',
      anulare_litA: '0',
      anulare_litB: '0',
      bifa111: '1',
      bifa112: '0',
      bifa14: '1',
      bifa113: '0',
      bifa121: '0',
      bifa15: '0',
      bifa122: '0',
      bifa131: '1',
      bifa132: '1',
      nume_c: 'Popescu',
      initiala_c: 'M',
      prenume_c: 'Ion',
      cif: cnp,
      cont_bancar: 'RO49AAAA1B31007593840000',
      adresa_c: 'Str. Exemplu nr. 1, Cluj-Napoca, Cluj',
      email_c: 'ion.popescu@example.test',
      nerezident: '0',
      'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
      'xsi:schemaLocation': 'mfp:anaf:dgti:d212:declaratie:v11',
      xmlns: 'mfp:anaf:dgti:d212:declaratie:v11',
    });
    expect(attributes(xml, 'oblig_realizat')).toEqual(
      Object.entries({
        cas_total_ven: '120000',
        cas_baza: '97200',
        cas_datorat: '24300',
        cas_retinut_platitor: '0',
        cas_dif_plus: '24300',
        bifa_cas_real: '2',
        bifa_cas_recalculat: '0',
        bifa_cas_sub_plafon: '0',
        cass_total_ven_ai: '120000',
        baza_cass_datorat_ai: '120000',
        cass_anuala_ai: '12000',
        cass_datorat_art180_ai: '0',
        cass_datorat_ai: '12000',
        cass_retinut_platitor_alin6_ai: '0',
        cass_dif_plus_ai: '12000',
        cass_dif_minus6_ai: '0',
        bifa_cass_datorat_dpi: '0',
        bifa_cass_datorat_ai: '1',
        real_venit_net_recalculat_ai: '120000',
        'real_cas-deduc_ai': '24300',
        'real_cass-deductibil_ai': '12000',
        real_venit_net_impozabil_ai: '83700',
        real_impozit_datorat_ai: '8370',
        real_cas_venit_net_ai: '120000',
        real_cas_total_ven_ai: '120000',
        real_cas_pondere_ai: '1.00000',
        real_cas_datorata_ai: '24300',
        real_cas_deductibila_ai: '24300',
        real_cass_venit_net_ai: '120000',
        real_cass_total_ven_ai: '120000',
        real_cass_pondere_ai: '1.00000',
        real_cass_datorata_ai: '12000',
        real_cass_deductibila_ai: '12000',
        oblimpoz_real_total: '8370',
        oblimpoz_real_dif_deplata: '8370',
        oblimpoz_real_dif_restituit: '0',
        oblcas_real_difPlus: '24300',
        oblcas_real_str: '0',
        oblcass_real_difPlus_ai: '12000',
        oblcass_real_difMinus_ai: '0',
        oblcass_real_str: '0',
        oblcass_real_str_pensie: '0',
        impozit_venit_plus: '8370',
        impozit_venit_minus: '0',
        cas_plus: '24300',
        cass_plus: '12000',
        cass_minus: '0',
        dif_de_plata: '44670',
        dif_de_restituit: '0',
      }),
    );
    expect(attributes(xml, 'cap11')).toEqual(
      Object.entries({
        categ_venit: '1016',
        den_venit: 'Activități independente in Sistem Real ',
        det_ven_net: '1',
        forma_org: '1',
        caen: '6201',
        descriere_sediu_bun: 'Str. Exemplu nr. 1, Cluj-Napoca',
        nr_doc_autoriz: 'F12/345/2023',
        data_doc_autoriz: '20.12.2023',
        venit_brut: '150000',
        chelt_deduc: '30000',
        venit_net_anual: '120000',
        pierdere_compensata: '0',
        venit_recalculat: '120000',
      }),
    );
    expect(xml).not.toContain('oblig_estimat');
    for (const name of ['d212', 'oblig_realizat', 'cap11'] as const) inWebOrder(xml, name);
  });

  test('below 6 minimum wages: CASS on 24,300 lei, the CASS on the income deducted', () => {
    // 20,000 lei net: CASS 2,430 on the minimum base, of which 430 only to reach it; the form's
    // rd.5 of 4.2 is 10% of 20,000 = 2,000, and that is what is deducted.
    const model = declaration({
      activity: { ...declaration().activity, gross: 26_000, deductible: 6000 },
      cas: null,
      cass: { base: 24_300, due: 2430, minimumDifference: 430 },
      tax: { deductibleCas: 0, deductibleCass: 2000, due: 1800 },
    });
    expect(checkD212(model)).toEqual([]);
    const xml = writeD212(model);
    expect(values(xml, 'd212').bifa131).toBe('0');
    expect(values(xml, 'oblig_realizat')).toMatchObject({
      cass_total_ven_ai: '20000',
      baza_cass_datorat_ai: '24300',
      cass_anuala_ai: '2430',
      real_cas_total_ven_ai: '20000',
      real_cas_datorata_ai: '0',
      real_cass_calculata_ai: '2000',
      real_cass_deductibila_ai: '2000',
      real_venit_net_impozabil_ai: '18000',
      real_impozit_datorat_ai: '1800',
      dif_de_plata: '4230',
    });
    expect(values(xml, 'oblig_realizat')).not.toHaveProperty('cas_baza');
    expect(values(xml, 'oblig_realizat')).not.toHaveProperty('real_cas_deductibila_ai');
    inWebOrder(xml, 'oblig_realizat');
  });

  test('a loss: no contributions, rd.9 not written, and the CASS option for 2026', () => {
    const model = declaration({
      activity: { ...declaration().activity, gross: 10_000, deductible: 15_000, carriedLosses: 0 },
      cas: null,
      cass: null,
      tax: { deductibleCas: 0, deductibleCass: 0, due: 0 },
      cassOption: { situation: 'B', base: 24_300, due: 2430 },
    });
    expect(checkD212(model)).toEqual([]);
    const xml = writeD212(model);
    expect(values(xml, 'cap11')).toMatchObject({
      pierdere: '5000',
      pierdere_compensata: '0',
      venit_recalculat: '0',
    });
    expect(values(xml, 'cap11')).not.toHaveProperty('venit_net_anual');
    expect(values(xml, 'cap11')).not.toHaveProperty('impozit11');
    expect(values(xml, 'oblig_realizat')).toMatchObject({
      cass_total_ven_ai: '0',
      baza_cass_datorat_ai: '0',
      bifa_cass_datorat_ai: '0',
      oblimpoz_real_total: '0',
      dif_de_plata: '0',
    });
    expect(values(xml, 'oblig_realizat')).not.toHaveProperty('real_venit_net_recalculat_ai');
    expect(attributes(xml, 'oblig_estimat')).toEqual([
      ['bifa_optiune', '1'],
      ['situatie_optiune', 'B'],
      ['baza_optiune', '24300'],
      ['cass_optiune', '2430'],
      ['totalCassDatorat', '2430'],
      ['totalCassDatoratCoasigurat', '0'],
    ]);
    inWebOrder(xml, 'oblig_estimat');
    inWebOrder(xml, 'cap11');
    // Situation C needs a zero net income; B a loss.
    expect(errors({ ...model, cassOption: { situation: 'C', base: 24_300, due: 2430 } })).toEqual([
      'D212_CASS_OPTION',
    ]);
  });

  test('a pensioner: no CAS, the form’s status 2, and no weight for CAS', () => {
    const model = declaration({
      casStatus: 'pensioner',
      cas: null,
      tax: { deductibleCas: 0, deductibleCass: 12_000, due: 10_800 },
    });
    expect(checkD212(model)).toEqual([]);
    const xml = writeD212(model);
    expect(values(xml, 'd212')).toMatchObject({ statut: '2', bifa131: '0' });
    expect(values(xml, 'oblig_realizat')).toMatchObject({
      real_cas_total_ven_ai: '0',
      real_venit_net_impozabil_ai: '108000',
    });
    expect(values(xml, 'oblig_realizat')).not.toHaveProperty('real_cas_pondere_ai');
    inWebOrder(xml, 'd212');
    // A pensioner owes no CAS (art. 150).
    expect(errors({ ...model, cas: { base: 97_200, due: 24_300 } })).toEqual(['D212_CAS']);
  });

  test('losses carried: 70% of the net income, the oldest first', () => {
    // 45,000 net, 40,000 carried: at most 31,500 offset, 13,500 recalculated.
    const model = declaration({
      activity: {
        ...declaration().activity,
        gross: 50_000,
        deductible: 5000,
        carriedLosses: 40_000,
        offsetLoss: 31_500,
      },
      cas: null,
      cass: { base: 45_000, due: 4500, minimumDifference: 0 },
      tax: { deductibleCas: 0, deductibleCass: 4500, due: 900 },
    });
    expect(checkD212(model)).toEqual([]);
    expect(values(writeD212(model), 'cap11')).toMatchObject({
      venit_net_anual: '45000',
      pierdere_precedenta: '40000',
      pierdere_compensata: '31500',
      venit_recalculat: '13500',
    });
    expect(errors({ ...model, activity: { ...model.activity, offsetLoss: 30_000 } })).toContain(
      'D212_LOSS',
    );
  });
});

describe('D212 for the income of 2024: D212_A1.0.3', () => {
  // 45,988 lei net: CAS on 12 × 3,300 = 39,600 lei (9,900), CASS 4,599, taxable 31,489, tax 3,149.
  const model = declaration({
    year: 2024,
    activity: { ...declaration().activity, gross: 50_000, deductible: 4012 },
    cas: { base: 39_600, due: 9900 },
    cass: { base: 45_988, due: 4599, minimumDifference: 0 },
    tax: { deductibleCas: 9900, deductibleCass: 4599, due: 3149 },
  });

  test('the structure’s attributes, the name in one field, no zeros the structure leaves out', () => {
    expect(checkD212(model)).toEqual([]);
    const xml = writeD212(model);
    expect(values(xml, 'd212')).toMatchObject({
      an_r: '2025',
      totalPlata_A: '34',
      bifa_succesor: '0',
      bifa14: '1',
      nume_c: 'Popescu m Ion',
      adresa_c: 'Str. Exemplu nr. 1, Cluj-Napoca, Cluj',
    });
    expect(values(xml, 'oblig_realizat')).toEqual({
      bifa_cas_real: '1',
      cas_total_ven: '45988',
      cas_baza: '39600',
      cas_datorat: '9900',
      cas_dif_plus: '9900',
      bifa_cass_datorat_ai: '1',
      bifa_cass_datorat_dpi: '0',
      cass_total_ven_ai: '45988',
      baza_cass_datorat_ai: '45988',
      cass_datorat_ai: '4599',
      cass_dif_plus_ai: '4599',
      real_venit_net_recalculat_ai: '45988',
      'real_cas-deduc_ai': '9900',
      'real_cass-deductibil_ai': '4599',
      real_venit_net_impozabil_ai: '31489',
      real_impozit_datorat_ai: '3149',
      real_cas_venit_net_ai: '45988',
      real_cas_total_ven_ai: '45988',
      real_cas_pondere_ai: '1.00000',
      real_cas_datorata_ai: '9900',
      real_cas_deductibila_ai: '9900',
      real_cass_venit_net_ai: '45988',
      real_cass_total_ven_ai: '45988',
      real_cass_pondere_ai: '1.00000',
      real_cass_datorata_ai: '4599',
      real_cass_deductibila_ai: '4599',
      oblimpoz_real_total: '3149',
      oblimpoz_real_dif_deplata: '3149',
      oblcas_real_difPlus: '9900',
      oblcass_real_difPlus_ai: '4599',
      impozit_venit_plus: '3149',
      cas_plus: '9900',
      cass_plus: '4599',
      dif_de_plata: '17648',
    });
    expect(values(xml, 'cap11')).toEqual({
      scutire: '0',
      reg: '0',
      categ_venit: '1016',
      det_ven_net: '1',
      forma_org: '1',
      mod_forma_org: '0',
      caen: '6201',
      descriere_sediu_bun: 'Str. Exemplu nr. 1, Cluj-Napoca',
      nr_doc_autoriz: 'F12/345/2023',
      data_doc_autoriz: '20.12.2023',
      venit_brut: '50000',
      chelt_deduc: '4012',
      venit_net_anual: '45988',
      venit_recalculat: '45988',
    });
  });

  test('the option to pay CAS below the threshold has no field in this structure', () => {
    expect(
      errors({
        ...model,
        activity: { ...model.activity, gross: 30_000, deductible: 0 },
        cas: { base: 39_600, due: 9900 },
        cass: { base: 30_000, due: 3000, minimumDifference: 0 },
        tax: { deductibleCas: 9900, deductibleCass: 3000, due: 1710 },
      }),
    ).toContain('D212_CAS_OPTION');
  });

  test('a loss writes zero tax in rd.9 and no Section 4', () => {
    const loss = declaration({
      year: 2024,
      activity: { ...declaration().activity, gross: 3000, deductible: 4958, carriedLosses: 1000 },
      cas: null,
      cass: null,
      tax: { deductibleCas: 0, deductibleCass: 0, due: 0 },
    });
    expect(checkD212(loss)).toEqual([]);
    const xml = writeD212(loss);
    expect(values(xml, 'cap11')).toMatchObject({
      pierdere: '1958',
      pierdere_precedenta: '1000',
      impozit11: '0',
    });
    expect(values(xml, 'oblig_realizat')).toEqual({ oblimpoz_real_total: '0', dif_de_plata: '0' });
    expect(values(xml, 'd212')).toMatchObject({ bifa14: '0', bifa131: '0', bifa132: '0' });
  });
});

describe('D212 controls', () => {
  test('the Code drops 50 bani, the form rounds them up: a warning for the expert', () => {
    // 45,045 lei: 10% is 4,504.50 lei. Art. 66 gives 4,504, the form's math.round 4,505.
    const half = declaration({
      activity: { ...declaration().activity, gross: 50_000, deductible: 4955 },
      cas: null,
      cass: { base: 45_045, due: 4504, minimumDifference: 0 },
      tax: { deductibleCas: 0, deductibleCass: 4504, due: 4054 },
    });
    expect(errors(half)).toEqual([]);
    expect(warnings(half)).toEqual(['D212_ROUNDING']);
    expect(errors({ ...half, cass: { base: 45_045, due: 4500, minimumDifference: 0 } })).toEqual([
      'D212_CASS',
    ]);
    // CAS of 25%: 48,602 × 25% = 12,150.50 lei.
    expect(
      warnings(
        declaration({
          activity: { ...declaration().activity, gross: 60_000, deductible: 11_398 },
          cas: { base: 48_602, due: 12_150 },
          cass: { base: 48_602, due: 4860, minimumDifference: 0 },
          tax: { deductibleCas: 12_150, deductibleCass: 4860, due: 3159 },
        }),
      ),
    ).toEqual(['D212_ROUNDING']);
  });

  test('contributions the income calls for, at the structure’s bases', () => {
    const base = declaration();
    expect(errors({ ...base, cas: null })).toContain('D212_CAS');
    expect(errors({ ...base, cas: { base: 48_600, due: 12_150 } })).toEqual(['D212_CAS']);
    expect(errors({ ...base, cass: null })).toContain('D212_CASS');
    expect(
      errors({ ...base, cass: { base: 250_000, due: 25_000, minimumDifference: 0 } }),
    ).toContain('D212_CASS');
    expect(errors({ ...base, tax: { ...base.tax, due: 9000 } })).toEqual(['D212_SECTION4']);
  });

  test('identification: CNP, names, IBAN; the CNP never appears in a message', () => {
    const wrong = declaration({
      taxpayer: {
        ...declaration().taxpayer,
        cnp: '1781105170031',
        lastName: 'Pop3scu',
        iban: 'RO49AAAA1B31007593840001',
      },
    });
    const checks = checkD212(wrong);
    expect(checks.map((check) => check.code)).toEqual(['D212_CNP', 'D212_NAME', 'D212_IBAN']);
    for (const check of checks) expect(check.message).not.toContain('1781105170031');
    expect(isValidIban('RO49 AAAA 1B31 0075 9384 0000')).toBe(true);
    expect(isValidIban('RO49AAAA1B3100759384000')).toBe(false);
  });

  test('the structure’s dates and authorization', () => {
    const base = declaration();
    expect(errors({ ...base, activity: { ...base.activity, startedOn: '2024-12-01' } })).toEqual([
      'D212_DATE',
    ]);
    expect(
      errors({
        ...base,
        activity: {
          ...base.activity,
          authorization: { number: 'F12/345/2023-REG', date: '2023-12-20' },
        },
        year: 2024,
        cas: { base: 79_200, due: 19_800 },
        cass: { base: 120_000, due: 12_000, minimumDifference: 0 },
        tax: { deductibleCas: 19_800, deductibleCass: 12_000, due: 8820 },
      }),
    ).toEqual(['D212_AUTHORIZATION']);
    const xml = writeD212({
      ...base,
      activity: { ...base.activity, startedOn: '2025-03-01', suspendedOn: '2025-10-01' },
    });
    expect(values(xml, 'cap11')).toMatchObject({
      data_incep: '01.03.2025',
      data_suspendare: '01.10.2025',
    });
  });

  test('the derived rows', () => {
    const calc = calculateD212(declaration());
    expect(calc).toMatchObject({
      net: 120_000,
      loss: 0,
      recalculated: 120_000,
      casBand: 2,
      totals: { tax: 8370, cas: 24_300, cass: 12_000, payable: 44_670 },
      controlSum: 34,
    });
  });
});
