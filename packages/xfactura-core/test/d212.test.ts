import { describe, expect, test } from 'bun:test';
import {
  calculateD212,
  checkD212,
  d212Format,
  writeD212,
  type D212,
  type D212Activity,
  type D212Norm,
} from '../src/ro/declarations/d212';
import { isValidIban } from '../src/ro/identifiers';

// Synthetic people and amounts. Every expected figure is computed by hand from the structures'
// formulas, not by the writer.
const cnp = '1781105170030'; // digits sum to 34

const activity: D212Activity = {
  caen: '6201',
  seat: 'Str. Exemplu nr. 1, Cluj-Napoca',
  authorization: { number: 'F12/345/2023', date: '2023-12-20' },
  gross: 150_000,
  deductible: 30_000,
  carriedLosses: 0,
  offsetLoss: 0,
};

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
  activity,
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
      activity: { ...activity, gross: 26_000, deductible: 6000 },
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
      activity: { ...activity, gross: 10_000, deductible: 15_000, carriedLosses: 0 },
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
        ...activity,
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
    expect(errors({ ...model, activity: { ...model.activity!, offsetLoss: 30_000 } })).toContain(
      'D212_LOSS',
    );
  });
});

describe('D212 for the income of 2024: D212_A1.0.3', () => {
  // 45,988 lei net: CAS on 12 × 3,300 = 39,600 lei (9,900), CASS 4,599, taxable 31,489, tax 3,149.
  const model = declaration({
    year: 2024,
    activity: { ...activity, gross: 50_000, deductible: 4012 },
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
        activity: { ...model.activity!, gross: 30_000, deductible: 0 },
        cas: { base: 39_600, due: 9900 },
        cass: { base: 30_000, due: 3000, minimumDifference: 0 },
        tax: { deductibleCas: 9900, deductibleCass: 3000, due: 1710 },
      }),
    ).toContain('D212_CAS_OPTION');
  });

  test('a loss writes zero tax in rd.9 and no Section 4', () => {
    const loss = declaration({
      year: 2024,
      activity: { ...activity, gross: 3000, deductible: 4958, carriedLosses: 1000 },
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
      activity: { ...activity, gross: 50_000, deductible: 4955 },
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
          activity: { ...activity, gross: 60_000, deductible: 11_398 },
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
    expect(errors({ ...base, activity: { ...base.activity!, startedOn: '2024-12-01' } })).toEqual([
      'D212_DATE',
    ]);
    expect(
      errors({
        ...base,
        activity: {
          ...base.activity!,
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
      activity: { ...base.activity!, startedOn: '2025-03-01', suspendedOn: '2025-10-01' },
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

describe('D212 on a norm (Subsection 2) and for a member of an association', () => {
  // Income of 2025 on a norm: 50,000 lei, +10% (criterion 01), −20% (criterion 05): 44,000 lei
  // for the whole year. Under 12 × 4,050 lei: no CAS; CASS 4,400; the norm's tax 4,400.
  const norm: D212Norm = {
    association: false,
    caen: '1413',
    seat: 'Str. Exemplu nr. 2, Iași',
    authorization: { number: 'F22/77/2024', date: '2024-12-10' },
    norm: 50_000,
    increase: { percent: '10', criterion: '01' },
    reduction: { percent: '20', criterion: '05' },
    adjusted: 44_000,
    net: 44_000,
    tax: 4400,
  };
  const onNorm = (overrides: Partial<D212Norm> = {}, model: Partial<D212> = {}): D212 => {
    const { activity: _, ...rest } = declaration({
      cas: null,
      cass: { base: 44_000, due: 4400, minimumDifference: 0 },
      tax: { deductibleCas: 0, deductibleCass: 0, due: 0 },
      ...model,
    });
    return { ...rest, norm: { ...norm, ...overrides } };
  };

  test('the web form’s cap12: the place’s rows and its coefficients; no Section 4', () => {
    const model = onNorm();
    expect(errors(model)).toEqual([]);
    // The place's county, locality and street are nomenclator codes the form loads.
    expect(warnings(model)).toEqual(['D212_NORMA_PLACE']);
    const xml = writeD212(model);
    expect(values(xml, 'd212')).toMatchObject({ bifa111: '0', bifa112: '1', bifa14: '0' });
    expect(values(xml, 'oblig_realizat')).toMatchObject({
      cass_total_ven_ai: '44000',
      baza_cass_datorat_ai: '44000',
      cass_datorat_ai: '4400',
      oblimpoz_real_total: '4400',
      dif_de_plata: '8800',
    });
    expect(xml).not.toContain('real_venit_net_recalculat_ai');
    expect(xml).not.toContain('<cap11');
    expect(attributes(xml, 'cap12')).toEqual([
      ['norma_forma_org', '1'],
      ['norma_nr_doc_autoriz', 'F22/77/2024'],
      ['norma_data_doc_autoriz', '10.12.2024'],
      ['norma_venit_impozabil', '44000'],
      ['norma_impozit', '4400'],
    ]);
    expect(attributes(xml, 'norma_loc')).toEqual([
      ['norma_isPGL', '0'],
      ['norma_caen', '1413'],
      ['real_norma_venit', '50000'],
      ['real_ajustare', '44000'],
      ['real_venit_net_anual', '44000'],
      ['real_venit_impozit', '44000'],
    ]);
    expect([...xml.matchAll(/<corectie ([^>]*)\/>/g)].map((match) => match[1])).toEqual([
      'criteriu="01" coeficient_majorare="10.00"',
      'criteriu="05" coeficient_reducere="20.00"',
    ]);
    // Without coefficients the form writes 0 for rd. 8.
    const plain = writeD212(
      onNorm(
        { increase: undefined, reduction: undefined, norm: 44_000 },
        { cass: { base: 44_000, due: 4400, minimumDifference: 0 } },
      ),
    );
    expect(values(plain, 'norma_loc').real_ajustare).toBe('0');
    expect(plain).not.toContain('<corectie');
  });

  test('part of a year: rd. 9 is rd. 8 over 365 days; a December 2024 start in D212_A1.0.3', () => {
    // From 1 April: 275 days. 44,000 × 275 / 365 = 33,150.68 → 33,151 lei.
    const april = onNorm(
      { startedOn: '2025-04-01', activeDays: 275, net: 33_151, tax: 3315 },
      { cass: { base: 33_151, due: 3315, minimumDifference: 0 } },
    );
    expect(errors(april)).toEqual([]);
    expect(values(writeD212(april), 'norma_loc')).toMatchObject({
      norma_data_incep: '01.04.2025',
      real_venit_net_anual: '33151',
    });
    // The register drops 50 bani (art. 66), the form rounds them up: one leu, a warning.
    expect(
      warnings(
        onNorm(
          { startedOn: '2025-04-01', activeDays: 275, net: 33_150, tax: 3315 },
          { cass: { base: 33_150, due: 3315, minimumDifference: 0 } },
        ),
      ),
    ).toContain('D212_ROUNDING');
    // D212_A1.0.3's Subsection 2 is for an activity started in December 2024 only.
    const full = onNorm(
      {},
      { year: 2024, cass: { base: 44_000, due: 4400, minimumDifference: 0 } },
    );
    expect(errors(full)).toContain('D212_NORMA_START');
    const december = onNorm(
      { startedOn: '2024-12-02', activeDays: 30, net: 3616, tax: 362 },
      { year: 2024, cass: { base: 19_800, due: 1980, minimumDifference: 1618 } },
    );
    expect(errors(december)).toEqual([]);
    expect(attributes(writeD212(december), 'cap12')).toEqual([
      ['norma_forma_org', '1'],
      ['norma_caen', '1413'],
      ['norma_descriere_sediu_bun', 'Str. Exemplu nr. 2, Iași'],
      ['norma_nr_doc_autoriz', 'F22/77/2024'],
      ['norma_data_doc_autoriz', '10.12.2024'],
      ['norma_data_incep', '02.12.2024'],
      ['real_norma_venit', '50000'],
      ['real_ajustare', '44000'],
      ['real_venit_net_anual', '3616'],
      ['real_venit_impozit', '3616'],
      ['real_impozit', '362'],
    ]);
  });

  test('the norm’s controls: rd. 8 from the coefficients, the tax, one source, no Section 4', () => {
    expect(
      errors(
        onNorm(
          { adjusted: 45_000, net: 45_000, tax: 4500 },
          { cass: { base: 45_000, due: 4500, minimumDifference: 0 } },
        ),
      ),
    ).toContain('D212_NORMA');
    expect(errors(onNorm({ tax: 4000 }))).toEqual(['D212_NORMA']);
    expect(errors(onNorm({ increase: { percent: '10', criterion: '14' as never } }))).toEqual([
      'D212_NORMA',
    ]);
    expect(
      errors(onNorm({}, { tax: { deductibleCas: 0, deductibleCass: 0, due: 100 } })),
    ).toContain('D212_SECTION4');
    // An activity beside the norm is a second source: CAS and CASS then count both.
    expect(errors({ ...onNorm(), activity })).toEqual(['D212_CAS', 'D212_CASS']);
    // CAS and CASS count the norm: 50,000 lei reach 12 minimum wages.
    expect(
      errors(
        onNorm(
          { increase: undefined, reduction: undefined, adjusted: 50_000, net: 50_000, tax: 5000 },
          { cass: { base: 50_000, due: 5000, minimumDifference: 0 } },
        ),
      ),
    ).toEqual(['D212_CAS']);
  });

  test('a member of an association declares the net income distributed, with the contract', () => {
    const member = declaration({
      activity: {
        caen: '1071',
        seat: 'Str. Morii nr. 3, Galați',
        authorization: { number: 'F17/123/2020', date: '2020-01-10' },
        association: { number: '1234/2020', date: '2020-01-15', net: 120_000, loss: 0 },
        carriedLosses: 0,
        offsetLoss: 0,
      },
    });
    expect(errors(member)).toEqual([]);
    const xml = writeD212(member);
    inWebOrder(xml, 'cap11');
    expect(values(xml, 'cap11')).toEqual({
      categ_venit: '1016',
      den_venit: 'Activități independente in Sistem Real ',
      det_ven_net: '1',
      forma_org: '2',
      caen: '1071',
      descriere_sediu_bun: 'Str. Morii nr. 3, Galați',
      nr_doc_autoriz: 'F17/123/2020',
      data_doc_autoriz: '10.01.2020',
      nr_doc_asociere: '1234/2020',
      data_doc_asociere: '15.01.2020',
      venit_net_anual: '120000',
      pierdere_compensata: '0',
      venit_recalculat: '120000',
    });
    // The same figures as the PFA's: Section 4 on the distributed income.
    expect(values(xml, 'oblig_realizat').real_venit_net_impozabil_ai).toBe('83700');
    // D212_A1.0.3 has one document field, "autorizare/ contract de asociere": the contract.
    const old = writeD212({
      ...member,
      year: 2024,
      cas: { base: 79_200, due: 19_800 },
      tax: { deductibleCas: 19_800, deductibleCass: 12_000, due: 8820 },
    });
    expect(values(old, 'cap11')).toMatchObject({
      forma_org: '2',
      mod_forma_org: '0',
      nr_doc_autoriz: '1234/2020',
      data_doc_autoriz: '15.01.2020',
    });
    expect(old).not.toContain('venit_brut');
    // The association's own gross income and expenses are not the member's to declare.
    expect(
      errors({ ...member, activity: { ...member.activity!, gross: 150_000, deductible: 30_000 } }),
    ).toEqual(['D212_ASSOCIATION']);
  });
});

describe('D212 with several sources and income declared from outside the books', () => {
  // Two activities in the real system: 120,000 + 30,000 = 150,000 lei net (CAS on 24 wages,
  // 97,200; CASS on 150,000 at 10%), a second activity's loss carried at 70% of its own net.
  const second: D212Activity = {
    caen: '7022',
    seat: 'Str. Alta nr. 3, Cluj-Napoca',
    authorization: { number: 'F12/999/2024', date: '2024-03-01' },
    gross: 40_000,
    deductible: 10_000,
    carriedLosses: 25_000,
    offsetLoss: 21_000,
  };
  // Recalculated: 120,000 + (30,000 − 21,000) = 129,000; CAS and CASS weights 1 (no norm):
  // 129,000 − 24,300 − 15,000 = 89,700; tax 8,970.
  const two = (overrides: Partial<D212> = {}) =>
    declaration({
      activities: [second],
      cass: { base: 150_000, due: 15_000, minimumDifference: 0 },
      tax: { deductibleCas: 24_300, deductibleCass: 15_000, due: 8970 },
      ...overrides,
    });

  test('one cap11 per source; CAS, CASS and Section 4 on their sum', () => {
    expect(errors(two())).toEqual([]);
    const xml = writeD212(two());
    expect([...xml.matchAll(/<cap11 /g)]).toHaveLength(2);
    const caps = [...xml.matchAll(/<cap11 ([^>]*)\/>/g)].map((match) =>
      Object.fromEntries([...match[1]!.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]])),
    );
    expect(
      caps.map((cap) => [
        cap.caen,
        cap.venit_net_anual,
        cap.pierdere_compensata,
        cap.venit_recalculat,
      ]),
    ).toEqual([
      ['6201', '120000', '0', '120000'],
      ['7022', '30000', '21000', '9000'],
    ]);
    expect(values(xml, 'oblig_realizat')).toMatchObject({
      cas_total_ven: '150000',
      cass_total_ven_ai: '150000',
      real_venit_net_recalculat_ai: '129000',
      real_cas_venit_net_ai: '150000',
      real_cas_pondere_ai: '1.00000',
      real_venit_net_impozabil_ai: '89700',
      real_impozit_datorat_ai: '8970',
      dif_de_plata: String(8970 + 24_300 + 15_000),
    });
    // The second source's loss offset is capped at 70% of its own net income, not the sum's.
    expect(errors(two({ activities: [{ ...second, offsetLoss: 25_000 }] }))).toContain('D212_LOSS');
  });

  test('a norm beside an activity weighs the real system’s share of the cumulated income', () => {
    const norm: D212Norm = {
      association: false,
      caen: '4520',
      seat: 'Str. Garaj nr. 1, Cluj-Napoca',
      authorization: { number: 'F12/111/2022', date: '2022-01-10' },
      norm: 30_000,
      adjusted: 30_000,
      net: 30_000,
      tax: 3000,
    };
    // 120,000 + 30,000 = 150,000 cumulated; the weight of the real system is 0.8: CAS
    // deductible 0.8 × 24,300 = 19,440, CASS 0.8 × 15,000 = 12,000; 120,000 − 31,440 = 88,560,
    // tax 8,856; Section 7: 8,856 + 3,000.
    const model = declaration({
      norms: [norm],
      cass: { base: 150_000, due: 15_000, minimumDifference: 0 },
      tax: { deductibleCas: 19_440, deductibleCass: 12_000, due: 8856 },
    });
    expect(errors(model)).toEqual([]);
    const xml = writeD212(model);
    expect(values(xml, 'oblig_realizat')).toMatchObject({
      real_cas_pondere_ai: '0.80000',
      'real_cas-deduc_ai': '19440',
      'real_cass-deductibil_ai': '12000',
      real_venit_net_impozabil_ai: '88560',
      oblimpoz_real_total: '11856',
    });
    expect(values(xml, 'd212')).toMatchObject({ bifa111: '1', bifa112: '1', bifa14: '1' });
  });

  test('Section 3.2.2: rent and dividends declared, on the band reached, and its differences', () => {
    // 30,000 + 20,000 = 50,000 lei: at least 12 wages (48,600), base 48,600, CASS 4,860; 1,000
    // withheld by a payer: 3,860 more due.
    const model = declaration({
      cassOther: { rent: 30_000, investment: 20_000, base: 48_600, due: 4860, withheld: 1000 },
    });
    expect(errors(model)).toEqual([]);
    const realized = values(writeD212(model), 'oblig_realizat');
    expect(realized).toMatchObject({
      cass_ven_cfb: '30000',
      cass_ven_inv: '20000',
      cass_total_ven: '50000',
      cass_baza: '48600',
      cass_anuala: '4860',
      cass_datorat: '4860',
      cass_retinut: '1000',
      cass_dif_plus: '3860',
      cass_dif_minus: '0',
      bifa_cass_real: '2',
      bifa_cass_datorat_dpi: '1',
      oblcass_real_difPlus_ai: '12000',
      oblcass_real_difPlus_dpi: '3860',
      cass_plus: '15860',
      dif_de_plata: String(8370 + 24_300 + 12_000 + 3860),
    });
    expect(errors({ ...model, cassOther: { ...model.cassOther!, base: 24_300 } })).toContain(
      'D212_CASS_OTHER',
    );
    // Below 6 wages the form clears the block: nothing written, nothing due.
    const low = declaration({
      cassOther: { rent: 10_000, investment: 0, base: 0, due: 0, withheld: 0 },
    });
    expect(errors(low)).toEqual([]);
    expect(values(writeD212(low), 'oblig_realizat')).toMatchObject({ bifa_cass_datorat_dpi: '0' });
    expect(writeD212(low)).not.toContain('cass_ven_cfb');
    // The 2024 structure is not written with it.
    expect(errors({ ...declaration({ year: 2024 }), cassOther: model.cassOther })).toContain(
      'D212_DECLARED',
    );
  });
});
