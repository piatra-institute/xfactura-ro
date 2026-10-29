import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  calculateD300,
  checkD300,
  d300Namespace,
  d300PaymentNumber,
  d300RowNumber,
  d300Rows,
  writeD300,
  type D300,
  type D300InputElement,
} from '../src/ro/declarations/d300';

const model = (rows: D300['rows'] = {}, extra: Partial<D300> = {}): D300 => ({
  period: { year: 2026, month: 9 },
  type: 'L',
  company: {
    cui: '18547290',
    name: 'Exemplu Servicii SRL',
    address: 'Str. Lungă nr. 10, Galați',
    bank: 'Banca Exemplu',
    account: 'RO49AAAA1B31007593840000',
    caen: '6201',
  },
  declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' },
  groupRepresentative: false,
  simplifiedDomestic: false,
  afterReserveCancellation: false,
  proRata: '100',
  reverseCharge: {
    cereals: false,
    mobilePhones: false,
    integratedCircuits: false,
    consoles: false,
  },
  refundRequested: false,
  rows,
  ...extra,
});
const payable = model({ R9_1: 1000, R9_2: 210, R22_1: 500, R22_2: 105, R28_2: 105 });
const codes = (value: D300) => checkD300(value).map((check) => `${check.severity}:${check.code}`);
const attribute = (xml: string, name: string) => new RegExp(` ${name}="([^"]*)"`).exec(xml)?.[1];

describe('D300 row catalogue', () => {
  test('lists every row accepted from 08/2025, once, with the 2026 form numbering', () => {
    const elements = d300Rows.map((row) => row.element);
    expect(elements.length).toBe(127);
    expect(new Set(elements).size).toBe(127);
    const current = d300Rows.filter((row) => !('until' in row));
    expect(current.length).toBe(103);
    const numbered = new Set(
      current.filter((row) => row.section !== 'informative').map((row) => row.row),
    );
    const expected = [
      ...Array.from({ length: 45 }, (_, index) => String(index + 1)),
      ...['3.1', '5.1', '7.1', '12.1', '12.2', '20.1', '22.1', '26.1', '26.2', '29.1'],
    ];
    expect([...numbered].sort()).toEqual(expected.sort());
  });

  test('marks the transitional-rate rows as ending in 12/2025', () => {
    const transitional: string[] = d300Rows
      .filter((row) => 'until' in row)
      .map((row) => row.element);
    expect(transitional).toEqual(
      ['R69', 'R70', 'R71', 'R12_3', 'R72', 'R73', 'R74', 'R75', 'R24', 'R25_3', 'R76', 'R77']
        .flatMap((base) => [`${base}_1`, `${base}_2`])
        .sort((a, b) => elementOrder(a) - elementOrder(b)),
    );
    for (const row of d300Rows.filter((item) => 'until' in item))
      expect(['19', '9', '5']).toContain(row.rate ?? '');
  });

  test('gives each rate row its rate and both columns, VAT in column 2', () => {
    const rates = Object.fromEntries(
      d300Rows
        .filter((row) => 'rate' in row && !('until' in row) && row.column === 1)
        .map((row) => [row.element, row.rate]),
    );
    expect(rates).toEqual({
      R9_1: '21',
      R10_1: '11',
      R11_1: '9',
      R12_1_1: '21',
      R12_2_1: '11',
      R22_1: '21',
      R23_1: '11',
      R25_1_1: '21',
      R25_2_1: '11',
    });
    expect(d300Rows.find((row) => row.element === 'R9_2')).toMatchObject({
      row: '9',
      column: 2,
      section: 'output',
      label: 'Livrări de bunuri şi prestări de servicii taxabile cu cota 21%',
      computed: false,
    });
  });

  test('keeps the sections in form order and marks the derived rows', () => {
    const order = ['output', 'input', 'settlement', 'informative'];
    const sections = d300Rows.map((row) => order.indexOf(row.section));
    expect(sections).toEqual([...sections].sort((a, b) => a - b));
    expect(d300Rows.filter((row) => row.computed).length).toBe(35);
    for (const name of ['R17_2', 'R18_1', 'R25_1_2', 'R27_2', 'R42_2'])
      expect(d300Rows.find((row) => row.element === name)?.computed).toBe(true);
    for (const name of ['R5_1', 'R12_1', 'R28_2', 'R35_2', 'R38_2'])
      expect(d300Rows.find((row) => row.element === name)?.computed).toBe(false);
  });

  test('numbers rows from 26 onward one higher on the 2025 form', () => {
    const row = (name: string) => d300Rows.find((item) => item.element === name)!;
    expect(d300RowNumber(row('R25_1'), { year: 2026, month: 1 })).toBe('26');
    expect(d300RowNumber(row('R25_1'), { year: 2025, month: 12 })).toBe('27');
    expect(d300RowNumber(row('R42_2'), { year: 2025, month: 8 })).toBe('46');
    expect(d300RowNumber(row('R22_2'), { year: 2025, month: 8 })).toBe('24');
  });
});

function elementOrder(name: string) {
  return d300Rows.findIndex((row) => row.element === name);
}

describe('D300 payment number and namespace', () => {
  test('reproduces the structure example', () => {
    expect(d300PaymentNumber({ year: 2011, month: 1 }, 'L')).toBe('10301010111250211000020');
  });

  test('codes the return type and dates the payment on the 25th of the next month', () => {
    expect(d300PaymentNumber({ year: 2026, month: 9 }, 'L')).toBe('10301010926251026000039');
    expect(d300PaymentNumber({ year: 2026, month: 9 }, 'T')).toBe('10302010926251026000040');
    expect(d300PaymentNumber({ year: 2026, month: 6 }, 'S')).toBe('10303010626250726000044');
    expect(d300PaymentNumber({ year: 2026, month: 12 }, 'A')).toBe('10304011226250127000037');
  });

  test('uses v11 for 08–12/2025, v12 from 01/2026, nothing earlier', () => {
    expect(d300Namespace({ year: 2025, month: 8 })).toBe('mfp:anaf:dgti:d300:declaratie:v11');
    expect(d300Namespace({ year: 2025, month: 12 })).toBe('mfp:anaf:dgti:d300:declaratie:v11');
    expect(d300Namespace({ year: 2026, month: 1 })).toBe('mfp:anaf:dgti:d300:declaratie:v12');
    expect(() => d300Namespace({ year: 2025, month: 7 })).toThrow('august 2025');
    expect(() => d300Namespace({ year: 2026, month: 13 })).toThrow();
  });
});

describe('D300 calculation', () => {
  test('totals a payable return', () => {
    const { amounts, controlSum } = calculateD300(payable);
    expect(amounts).toMatchObject({
      R17_1: 1000n,
      R17_2: 210n,
      R27_1: 500n,
      R27_2: 105n,
      R32_2: 105n,
      R33_2: 0n,
      R34_2: 105n,
      R37_2: 105n,
      R40_2: 0n,
      R41_2: 105n,
      R42_2: 0n,
    });
    // Every written row: 1000+210 (rd.9) + 1000+210 (rd.19) + 500+105 (rd.24) + 500+105 (rd.30)
    // + 105 (rd.31) + 105 (rd.35) + 105 (rd.37) + 105 (rd.40) + 105 (rd.44).
    expect(controlSum).toBe(4155n);
  });

  test('carries a negative balance to rd. 45', () => {
    const { amounts } = calculateD300(model({ R22_1: 2000, R22_2: 420, R28_2: 420, R38_2: 80 }));
    expect(amounts).toMatchObject({ R33_2: 420n, R34_2: 0n, R40_2: 500n, R42_2: 500n });
  });

  test('adds prior balances and inspection differences to the cumulative rows', () => {
    const { amounts } = calculateD300(model({ R9_1: 1000, R9_2: 210, R35_2: 40, R36_2: 10 }));
    expect(amounts).toMatchObject({ R34_2: 210n, R37_2: 260n, R41_2: 260n });
    const negative = calculateD300(model({ R9_1: 100, R9_2: 21, R38_2: 50, R39_2: 5 })).amounts;
    expect(negative).toMatchObject({ R37_2: 21n, R40_2: 55n, R41_2: 0n, R42_2: 34n });
  });

  test('repeats reverse-charge rows on the deductible side', () => {
    const { amounts } = calculateD300(
      model({
        R5_1: 800,
        R5_2: 168,
        R5_1_1: 800,
        R5_1_2: 168,
        R7_1: 300,
        R7_2: 63,
        R12_1: 400,
        R12_2: 84,
        R12_1_1: 400,
        R12_1_2: 84,
        R28_2: 315,
      }),
    );
    expect(amounts).toMatchObject({
      R18_1: 800n,
      R18_2: 168n,
      R18_1_1: 800n,
      R20_1: 300n,
      R20_2: 63n,
      R25_1: 400n,
      R25_2: 84n,
      R25_1_1: 400n,
      R25_1_2: 84n,
      R17_1: 1500n,
      R17_2: 315n,
      R27_1: 1500n,
      R27_2: 315n,
      R33_2: 0n,
      R34_2: 0n,
    });
    expect(amounts.R19_1).toBeUndefined();
  });

  test('sums the transitional rows of a 2025 return, rd. 12 but not its sub-rows', () => {
    const { amounts } = calculateD300(
      model(
        {
          ...{ R69_1: 500, R69_2: 95, R71_1: 100, R71_2: 5, R74_1: 200, R74_2: 38 },
          ...{ R12_1: 50, R12_2: 5, R72_1: 50, R72_2: 5 },
        },
        { period: { year: 2025, month: 10 } },
      ),
    );
    expect(amounts).toMatchObject({ R17_1: 650n, R17_2: 105n, R76_1: 50n, R76_2: 5n });
    expect(amounts).toMatchObject({ R25_1: 50n, R27_1: 250n, R27_2: 43n });
  });

  test('leaves the unchargeable-VAT and distance-sales rows out of the control sum', () => {
    const plain = calculateD300(payable).controlSum;
    const informative = calculateD300(
      model({
        ...payable.rows,
        nr_facturi: 2,
        baza: 300,
        tva: 63,
        nr_facturi_primite: 1,
        baza_primite: 100,
        tva_primite: 21,
        nr_fact_emise: 9,
        total_baza: 9,
        total_tva: 9,
        valoare_a: 9,
        tva_a: 9,
        valoare_b: 9,
        tva_b: 9,
        total_precedent: 9,
        total_curent: 9,
      }),
    ).controlSum;
    expect(informative - plain).toBe(2n + 300n + 63n + 1n + 100n + 21n);
  });

  test('settles to exactly one of payable and negative, consistently', () => {
    const inputs: D300InputElement[] = [
      'R9_1',
      'R9_2',
      'R10_2',
      'R16_2',
      'R5_2',
      'R22_2',
      'R23_2',
      'R28_2',
      'R29_2',
      'R30_2',
      'R31_2',
      'R35_2',
      'R36_2',
      'R38_2',
      'R39_2',
    ];
    const amount = fc.integer({ min: -1_000_000_000, max: 1_000_000_000 });
    fc.assert(
      fc.property(
        fc.array(amount, { minLength: inputs.length, maxLength: inputs.length }),
        (values) => {
          const rows = Object.fromEntries(inputs.map((name, index) => [name, values[index]]));
          const { amounts: a, controlSum } = calculateD300(model(rows));
          expect(a.R33_2! * a.R34_2!).toBe(0n);
          expect(a.R41_2! * a.R42_2!).toBe(0n);
          expect(a.R34_2! - a.R33_2!).toBe(a.R17_2! - a.R32_2!);
          expect(a.R41_2! - a.R42_2!).toBe(a.R37_2! - a.R40_2!);
          expect(controlSum).toBe(Object.values(a).reduce((sum, value) => sum + value, 0n));
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('D300 XML', () => {
  test('writes a nil return as one canonical element', () => {
    expect(writeD300(model())).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<declaratie300 xmlns="mfp:anaf:dgti:d300:declaratie:v12"' +
        ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
        ' xsi:schemaLocation="mfp:anaf:dgti:d300:declaratie:v12 D300.xsd"' +
        ' luna="9" an="2026" depusReprezentant="0" bifa_interne="0" temei="0"' +
        ' nume_declar="Popescu" prenume_declar="Ana" functie_declar="Administrator"' +
        ' cui="18547290" den="Exemplu Servicii SRL" adresa="Str. Lungă nr. 10, Galați"' +
        ' banca="Banca Exemplu" cont="RO49AAAA1B31007593840000" caen="6201" tip_decont="L"' +
        ' pro_rata="100" bifa_cereale="N" bifa_mob="N" bifa_disp="N" bifa_cons="N"' +
        ' solicit_ramb="N" nr_evid="10301010926251026000039" totalPlata_A="0"' +
        ' R17_1="0" R17_2="0" R27_1="0" R27_2="0" R32_2="0" R33_2="0" R34_2="0" R37_2="0"' +
        ' R40_2="0" R41_2="0" R42_2="0"/>\n',
    );
  });

  test('writes given rows, their mirrors and every total in form order', () => {
    const xml = writeD300(model({ R5_1: 800, R5_2: 168, R9_1: 1000, R9_2: 210, R28_2: 168 }));
    const names = [...xml.matchAll(/ (R\d+(?:_\d+)*)="/g)].map((match) => match[1]);
    expect(names).toEqual([
      'R5_1',
      'R5_2',
      'R9_1',
      'R9_2',
      'R17_1',
      'R17_2',
      'R18_1',
      'R18_2',
      'R27_1',
      'R27_2',
      'R28_2',
      'R32_2',
      'R33_2',
      'R34_2',
      'R37_2',
      'R40_2',
      'R41_2',
      'R42_2',
    ]);
    expect(attribute(xml, 'R34_2')).toBe('210');
    expect(attribute(xml, 'totalPlata_A')).toBe(
      String(
        calculateD300(model({ R5_1: 800, R5_2: 168, R9_1: 1000, R9_2: 210, R28_2: 168 }))
          .controlSum,
      ),
    );
  });

  test('writes the options, the optional contacts and escapes text', () => {
    const xml = writeD300(
      model(
        { R22_1: 30000, R22_2: 6300, R28_2: 6300 },
        {
          type: 'T',
          company: {
            ...model().company,
            name: 'Exemplu & "Fiul" SRL',
            phone: '0236000000',
            fax: '0236000001',
            email: 'contabilitate@exemplu.ro',
          },
          successorCui: '14399840',
          groupRepresentative: true,
          afterReserveCancellation: true,
          proRata: '87.5',
          reverseCharge: {
            cereals: true,
            mobilePhones: false,
            integratedCircuits: true,
            consoles: false,
          },
          refundRequested: true,
        },
      ),
    );
    expect(attribute(xml, 'den')).toBe('Exemplu &amp; &quot;Fiul&quot; SRL');
    expect(attribute(xml, 'tip_decont')).toBe('T');
    expect(attribute(xml, 'nr_evid')).toBe('10302010926251026000040');
    expect(attribute(xml, 'cuiSuccesor')).toBe('14399840');
    expect(attribute(xml, 'depusReprezentant')).toBe('1');
    expect(attribute(xml, 'temei')).toBe('2');
    expect(attribute(xml, 'pro_rata')).toBe('87.5');
    expect([attribute(xml, 'bifa_cereale'), attribute(xml, 'bifa_disp')]).toEqual(['D', 'D']);
    expect(attribute(xml, 'solicit_ramb')).toBe('D');
    expect(attribute(xml, 'telefon')).toBe('0236000000');
    expect(attribute(xml, 'mail')).toBe('contabilitate@exemplu.ro');
    expect(xml.indexOf(' cuiSuccesor=')).toBeLessThan(xml.indexOf(' nume_declar='));
  });

  test('switches the namespace for 2025 periods and accepts their transitional rows', () => {
    const xml = writeD300(model({ R69_1: 500, R69_2: 95 }, { period: { year: 2025, month: 10 } }));
    expect(attribute(xml, 'xmlns')).toBe('mfp:anaf:dgti:d300:declaratie:v11');
    expect(attribute(xml, 'R69_2')).toBe('95');
  });

  test('refuses what the return cannot hold', () => {
    expect(() => writeD300(model({}, { period: { year: 2025, month: 7 } }))).toThrow('august 2025');
    expect(() => writeD300(model({ R69_1: 1 }))).toThrow('decembrie 2025');
    expect(() => writeD300(model({ R9_1: 10.5 }))).toThrow('fără zecimale');
    expect(() => writeD300(model({ R9_1: 1e15 }))).toThrow('15 cifre');
    expect(() => writeD300(model({ R17_2: 1 } as D300['rows']))).toThrow('se calculează');
    expect(() => writeD300(model({ R17_1_1: 1 } as D300['rows']))).toThrow('nu există');
  });

  test('is deterministic', () => {
    expect(writeD300(payable)).toBe(writeD300(structuredClone(payable)));
  });
});

describe('D300 checks', () => {
  test('pass for a consistent return', () => {
    expect(checkD300(payable)).toEqual([]);
    expect(checkD300(model())).toEqual([]);
  });

  test('match the return type to the month', () => {
    expect(codes(model({}, { type: 'T', period: { year: 2026, month: 7 } }))).toEqual([
      'error:D300_TYPE_MONTH',
    ]);
    for (const month of [2, 3, 5, 6, 8, 9, 11, 12])
      expect(checkD300(model({}, { type: 'T', period: { year: 2026, month } }))).toEqual([]);
    expect(codes(model({}, { type: 'S', period: { year: 2026, month: 9 } }))).toEqual([
      'error:D300_TYPE_MONTH',
    ]);
    expect(codes(model({}, { type: 'A', period: { year: 2026, month: 6 } }))).toEqual([
      'error:D300_TYPE_MONTH',
    ]);
    expect(codes(model({}, { period: { year: 2025, month: 7 } }))).toEqual(['error:D300_PERIOD']);
  });

  test('check the identification fields', () => {
    const company = model().company;
    const checks = checkD300(
      model(
        {},
        {
          company: {
            ...company,
            cui: 'RO18547290',
            name: ' ',
            bank: 'Banca, Exemplu',
            account: 'RO49#',
            caen: '62',
            email: 'nu-este-email',
          },
          successorCui: '18547291',
          declarant: { lastName: 'Popescu', firstName: 'A'.repeat(76), role: 'Administrator' },
          proRata: '100.5',
        },
      ),
    );
    expect(checks.map((check) => check.path)).toEqual([
      'company.cui',
      'successorCui',
      'declarant.firstName',
      'company.name',
      'company.bank',
      'company.account',
      'company.email',
      'company.caen',
      'proRata',
    ]);
    expect(checks.every((check) => check.severity === 'error')).toBe(true);
    expect(codes(model({}, { proRata: '0' }))).toEqual([]);
    expect(codes(model({}, { proRata: '101' }))).toEqual(['error:D300_PRO_RATA']);
  });

  test('report amounts and rows the period does not accept', () => {
    expect(codes(model({ R9_1: 0.5 }))).toEqual(['error:D300_ROW']);
    expect(codes(model({ R69_1: 100, R69_2: 19 }))).toEqual(['error:D300_ROW', 'error:D300_ROW']);
    expect(
      checkD300(model({ R69_1: 100, R69_2: 19 }, { period: { year: 2025, month: 9 } })),
    ).toEqual([]);
    expect(codes(model({ R1_1: 999_999_999_999_999, R2_1: 1 }))).toEqual(['error:D300_TOTAL']);
  });

  test('mirror the structure validations', () => {
    expect(codes(model({ R5_1: 100, R5_2: 21, R26_1_1: 5 }, { simplifiedDomestic: true }))).toEqual(
      ['error:D300_SIMPLIFIED'],
    );
    expect(checkD300(model({ R5_1: 100 }, { simplifiedDomestic: true }))[0]!.message).toContain(
      'rd. 5',
    );
    expect(
      codes(model({ R12_1: 100, R12_2: 21, R12_1_1: 100, R12_1_2: 21, R12_2_1: 10, R12_2_2: 1 })),
    ).toEqual(['error:D300_R12', 'error:D300_R12']);
    expect(codes(model({ R22_1: 100, R22_2: 21, R28_2: 22 }))).toEqual(['error:D300_DEDUCTED']);
    expect(codes(model({ R35_2: 1, R38_2: 1 }))).toEqual(['error:D300_BALANCES']);
    expect(
      codes(model({ R22_1: 20000, R22_2: 4200, R28_2: 4200 }, { refundRequested: true })),
    ).toEqual(['error:D300_REFUND']);
    expect(
      checkD300(model({ R22_1: 30000, R22_2: 6300, R28_2: 6300 }, { refundRequested: true })),
    ).toEqual([]);
    expect(codes(model({ valoare_a: 10, valoare_a1: 11, tva_b: 2, tva_b1: 3 }))).toEqual([
      'error:D300_INFORMATIVE',
      'error:D300_INFORMATIVE',
    ]);
  });

  test('warn when VAT strays more than one point from the rate', () => {
    const vat = (base: number, tax: number) => codes(model({ R9_1: base, R9_2: tax }));
    expect(vat(1000, 200)).toEqual([]);
    expect(vat(1000, 220)).toEqual([]);
    expect(vat(1000, 199)).toEqual(['warning:D300_RATE']);
    expect(vat(1000, 221)).toEqual(['warning:D300_RATE']);
    expect(vat(-1000, -210)).toEqual([]);
    // round(20% × 333) = 67, round(22% × 333) = 73
    expect(vat(333, 67)).toEqual([]);
    expect(vat(333, 66)).toEqual(['warning:D300_RATE']);
    expect(codes(model({ R10_1: 500, R10_2: 105 }))).toEqual(['warning:D300_RATE']);
    expect(codes(model({ R11_2: 9 }))).toEqual(['warning:D300_RATE']);
    expect(
      codes(model({ R74_1: 100, R74_2: 21, R28_2: 21 }, { period: { year: 2025, month: 11 } })),
    ).toEqual(['warning:D300_RATE']);
  });
});
