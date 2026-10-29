import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  calculateD100,
  checkD100,
  d100Namespace,
  d100Obligations,
  d100PaymentNumber,
  writeD100,
  type D100,
  type D100DividendTax,
  type D100MicroTax,
  type D100Obligation,
  type D100OtherObligation,
} from '../src/ro/declarations/d100';

const model = (obligations: D100Obligation[], extra: Partial<D100> = {}): D100 => ({
  period: { year: 2026, month: 9 },
  afterReserveCancellation: false,
  dissolution: false,
  declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' },
  payer: { cui: '18547290', name: 'Exemplu Servicii SRL', address: 'Str. Lungă nr. 10, Galați' },
  obligations,
  ...extra,
});
const micro = (base: number, extra: Partial<D100MicroTax> = {}): D100MicroTax => ({
  kind: 'micro',
  base,
  ...extra,
});
const dividends = (
  beneficiary: D100DividendTax['beneficiary'],
  withheld: number,
  extra: Partial<D100DividendTax> = {},
): D100DividendTax => ({ kind: 'dividends', beneficiary, withheld, ...extra });
const other = (extra: Partial<D100OtherObligation> = {}): D100OtherObligation => ({
  kind: 'other',
  code: '605',
  budgetCode: '5503',
  dueDate: '2026-10-25',
  due: 100,
  deductible: 0,
  payable: 100,
  refund: 0,
  ...extra,
});
const june = { year: 2026, month: 6 };
const december = { year: 2026, month: 12 };
const quarter = model([micro(120_000)]);
const paid = model([dividends('individual', 4800), dividends('company', 1600)], { period: june });
const codes = (value: D100) => checkD100(value).map((check) => `${check.severity}:${check.code}`);
const attribute = (xml: string, name: string) => new RegExp(` ${name}="([^"]*)"`).exec(xml)?.[1];

describe('D100 obligations, namespace and payment number', () => {
  test('lists the codes computed here with the nomenclature wording and budget code', () => {
    expect(d100Obligations).toEqual([
      ['121', '5503XXXXXX', 'Impozit pe veniturile microîntreprinderilor'],
      ['604', '5503XXXXXX', 'Impozit pe veniturile din dividende distribuite PF'],
      ['150', '5503XXXXXX', 'Impozit pe dividende distribuite PJ'],
    ]);
  });

  test('uses namespace v2 from 01/2026, nothing earlier or past the schema', () => {
    expect(d100Namespace({ year: 2026, month: 1 })).toBe('mfp:anaf:dgti:d100:declaratie:v2');
    expect(d100Namespace({ year: 2100, month: 12 })).toBe('mfp:anaf:dgti:d100:declaratie:v2');
    expect(() => d100Namespace({ year: 2025, month: 12 })).toThrow('ianuarie 2026');
    expect(() => d100Namespace({ year: 2026, month: 13 })).toThrow();
    expect(() => d100Namespace({ year: 2101, month: 1 })).toThrow();
    expect(() => d100Namespace({ year: 2026.5, month: 1 })).toThrow();
  });

  test('codes the obligation, period and due date, with the digit sum last', () => {
    expect(d100PaymentNumber('121', { year: 2026, month: 9 }, '2026-10-25')).toBe(
      '10121010926251026000039',
    );
    expect(d100PaymentNumber('604', june, '2026-07-25')).toBe('10604010626250726000048');
    expect(d100PaymentNumber('150', june, '2026-07-25')).toBe('10150010626250726000044');
    expect(d100PaymentNumber('121', december, '2027-06-25')).toBe('10121011226250627000039');
    // The structure's example ends in 35, though its first 21 digits sum to 34, as the validator
    // requires.
    expect(d100PaymentNumber('602', { year: 2011, month: 6 }, '2011-07-25')).toBe(
      '10602010611250711000034',
    );
  });
});

describe('D100 calculation', () => {
  test('declares the quarter micro tax as 1% of the base, due on the 25th of the next month', () => {
    expect(calculateD100(quarter)).toEqual({
      namespace: 'mfp:anaf:dgti:d100:declaratie:v2',
      lines: [
        {
          code: '121',
          budgetCode: '5503XXXXXX',
          dueDate: '2026-10-25',
          paymentNumber: '10121010926251026000039',
          due: 1200n,
          deductible: 0n,
          payable: 1200n,
          refund: 0n,
          rate: '1',
          minimumTax: false,
        },
      ],
      controlSum: 2400n,
    });
  });

  test('rounds the micro tax half up to whole lei', () => {
    const due = (base: number) => calculateD100(model([micro(base)])).lines[0]!.due;
    expect([due(120_049), due(120_050), due(49), due(50), due(0)]).toEqual([
      1200n,
      1201n,
      0n,
      1n,
      0n,
    ]);
  });

  test('subtracts the deductible amount and the reduction from the micro tax, never below 0', () => {
    const { lines, controlSum } = calculateD100(
      model([micro(120_000, { deductible: 100, reduction: 150 })]),
    );
    expect(lines[0]).toMatchObject({
      due: 1200n,
      deductible: 100n,
      reduction: 150n,
      payable: 950n,
    });
    // suma_redu counts towards totalPlata_A: 1200 + 100 + 950 + 0 + 150.
    expect(controlSum).toBe(2400n);
    expect(calculateD100(model([micro(1000, { deductible: 15 })])).lines[0]!.payable).toBe(0n);
  });

  test('declares dividend tax by beneficiary for the month of payment', () => {
    const { lines, controlSum } = calculateD100(paid);
    expect(lines.map(({ code, dueDate, due, payable }) => [code, dueDate, due, payable])).toEqual([
      ['604', '2026-07-25', 4800n, 4800n],
      ['150', '2026-07-25', 1600n, 1600n],
    ]);
    expect(lines.every((item) => item.rate === undefined && item.deductible === 0n)).toBe(true);
    expect(controlSum).toBe(12_800n);
  });

  test('adds the tax on dividends unpaid at year end to December, due on 25 January', () => {
    const { lines } = calculateD100(
      model(
        [
          dividends('individual', 800, { unpaidAtYearEnd: 4000 }),
          dividends('company', 0, { unpaidAtYearEnd: 1600 }),
        ],
        { period: december },
      ),
    );
    expect(lines.map(({ code, dueDate, due }) => [code, dueDate, due])).toEqual([
      ['604', '2027-01-25', 4800n],
      ['150', '2027-01-25', 1600n],
    ]);
    expect(lines[0]!.paymentNumber).toBe('10604011226250127000040');
  });

  test('dates the fourth quarter as chosen', () => {
    const dueDate = (fourthQuarterDue: 'january' | 'june') =>
      calculateD100(model([micro(90_000, { fourthQuarterDue })], { period: december })).lines[0]!
        .dueDate;
    expect(dueDate('january')).toBe('2027-01-25');
    expect(dueDate('june')).toBe('2027-06-25');
  });

  test('takes other obligations as given, padding the budget code', () => {
    const { lines, controlSum } = calculateD100(
      model([micro(120_000), other({ due: 300, deductible: 50, payable: 250, minimumTax: true })]),
    );
    expect(lines[1]).toEqual({
      code: '605',
      budgetCode: '5503XXXXXX',
      dueDate: '2026-10-25',
      paymentNumber: '10605010926251026000046',
      due: 300n,
      deductible: 50n,
      payable: 250n,
      refund: 0n,
      minimumTax: true,
    });
    expect(controlSum).toBe(2400n + 600n);
  });

  test('keeps the micro payable and the control sum consistent', () => {
    const amount = fc.integer({ min: 0, max: 1_000_000_000 });
    fc.assert(
      fc.property(amount, amount, amount, (base, deductible, reduction) => {
        const { lines, controlSum } = calculateD100(
          model([micro(base, { deductible, reduction }), dividends('individual', deductible)]),
        );
        const [tax, dividend] = lines as [(typeof lines)[0], (typeof lines)[0]];
        const rest = tax.due - tax.deductible - tax.reduction!;
        expect(tax.payable).toBe(rest > 0n ? rest : 0n);
        expect(tax.due * 100n - BigInt(base)).toBeLessThanOrEqual(50n);
        expect(BigInt(base) - tax.due * 100n).toBeLessThan(50n);
        expect(controlSum).toBe(
          tax.due + tax.deductible + tax.payable + tax.reduction! + 2n * dividend.due,
        );
      }),
      { numRuns: 200 },
    );
  });
});

describe('D100 XML', () => {
  test('writes the quarter micro tax as one canonical declaration', () => {
    expect(writeD100(quarter)).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<declaratie100 xmlns="mfp:anaf:dgti:d100:declaratie:v2"' +
        ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
        ' xsi:schemaLocation="mfp:anaf:dgti:d100:declaratie:v2 D100.xsd"' +
        ' luna="9" an="2026" d_anulare="0" d_succ="0" d_dizolv="0"' +
        ' nume_declar="Popescu" prenume_declar="Ana" functie_declar="Administrator"' +
        ' cui="18547290" den="Exemplu Servicii SRL" adresa="Str. Lungă nr. 10, Galați"' +
        ' totalPlata_A="2400">\n' +
        '  <obligatie cod_oblig="121" cod_bugetar="5503XXXXXX" scadenta="25.10.2026"' +
        ' nr_evid="10121010926251026000039" suma_dat="1200" suma_ded="0" suma_plata="1200"' +
        ' suma_rest="0" cota="1" bifa_impozit_minim="0"/>\n' +
        '</declaratie100>\n',
    );
  });

  test('writes each dividend line without cota or reduction', () => {
    const xml = writeD100(paid);
    const lines = xml.match(/<obligatie [^>]*\/>/g)!;
    expect(lines).toEqual([
      '<obligatie cod_oblig="604" cod_bugetar="5503XXXXXX" scadenta="25.07.2026" nr_evid="10604010626250726000048" suma_dat="4800" suma_ded="0" suma_plata="4800" suma_rest="0" bifa_impozit_minim="0"/>',
      '<obligatie cod_oblig="150" cod_bugetar="5503XXXXXX" scadenta="25.07.2026" nr_evid="10150010626250726000044" suma_dat="1600" suma_ded="0" suma_plata="1600" suma_rest="0" bifa_impozit_minim="0"/>',
    ]);
    expect(attribute(xml, 'luna')).toBe('6');
    expect(attribute(xml, 'totalPlata_A')).toBe('12800');
  });

  test('writes the reduction after cota', () => {
    const xml = writeD100(model([micro(120_000, { deductible: 100, reduction: 150 })]));
    expect(xml).toContain(
      'suma_dat="1200" suma_ded="100" suma_plata="950" suma_rest="0" cota="1" suma_redu="150"',
    );
  });

  test('marks a declaration filed after the reserve of subsequent verification was cancelled', () => {
    const xml = writeD100(model([micro(120_000)], { afterReserveCancellation: true }));
    expect(xml).toContain(' d_anulare="1" temei="2" d_succ="0"');
    expect(writeD100(quarter)).not.toContain('temei');
  });

  test('writes the successor, dissolution, contacts and representative, escaping text', () => {
    const xml = writeD100(
      model([micro(40_000)], {
        period: { year: 2026, month: 8 },
        dissolution: true,
        successorCui: '14399840',
        payer: {
          cui: '18547290',
          name: 'Exemplu & "Fiul" SRL',
          address: 'Str. Lungă nr. 10, Galați',
          phone: '0236000000',
          fax: ' ',
          email: 'contabilitate@exemplu.ro',
        },
        representative: {
          cui: '14399840',
          name: 'Contabil Test SRL',
          address: 'Bd. Unirii 5, București',
          phone: '0210000000',
          fax: '0210000001',
          email: 'office@contabil.ro',
        },
      }),
    );
    expect(xml).toContain(' d_anulare="0" d_succ="1" cifS="14399840" d_dizolv="1" nume_declar=');
    expect(attribute(xml, 'den')).toBe('Exemplu &amp; &quot;Fiul&quot; SRL');
    expect(attribute(xml, 'telefon')).toBe('0236000000');
    expect(attribute(xml, 'fax')).toBeUndefined();
    expect(attribute(xml, 'mail')).toBe('contabilitate@exemplu.ro');
    expect(xml).toContain(
      ' totalPlata_A="800" cifR="14399840" denR="Contabil Test SRL" adrR="Bd. Unirii 5, București" telR="0210000000" faxR="0210000001" emailR="office@contabil.ro">',
    );
    expect(attribute(xml, 'scadenta')).toBe('25.09.2026');
  });

  test('refuses what the declaration cannot hold', () => {
    expect(() => writeD100(model([micro(1)], { period: { year: 2025, month: 12 } }))).toThrow(
      'ianuarie 2026',
    );
    expect(() => writeD100(model([]))).toThrow('cel puțin o obligație');
    expect(() => writeD100(model([micro(10.5)]))).toThrow('fără zecimale');
    expect(() => writeD100(model([dividends('individual', -1)]))).toThrow('nenegativă');
    expect(() => writeD100(model([micro(1e15)]))).toThrow('15 cifre');
    expect(() => writeD100(model([micro(1)], { period: december }))).toThrow('trimestrul IV');
    expect(() => writeD100(model([micro(1, { fourthQuarterDue: 'june' })]))).toThrow('decembrie');
    expect(() =>
      writeD100(model([dividends('company', 1, { unpaidAtYearEnd: 1 })], { period: june })),
    ).toThrow('25 ianuarie');
    expect(() => writeD100(model([other({ code: '121' })]))).toThrow('kind micro');
    expect(() => writeD100(model([other({ code: '604' })]))).toThrow('kind dividends');
    expect(() => writeD100(model([other({ code: '701' })]))).toThrow('Data_IC');
    expect(() => writeD100(model([other({ code: '60' })]))).toThrow('trei cifre');
    expect(() => writeD100(model([other({ budgetCode: '20470101XXX' })]))).toThrow('10 caractere');
    expect(() => writeD100(model([other({ dueDate: '25.10.2026' })]))).toThrow('AAAA-LL-ZZ');
    expect(() => writeD100(model([other({ dueDate: '2026-02-30' })]))).toThrow('AAAA-LL-ZZ');
  });

  test('is deterministic', () => {
    expect(writeD100(paid)).toBe(writeD100(structuredClone(paid)));
  });
});

describe('D100 checks', () => {
  test('pass for consistent declarations', () => {
    expect(checkD100(quarter)).toEqual([]);
    expect(checkD100(paid)).toEqual([]);
    expect(checkD100(model([micro(120_000)], { afterReserveCancellation: true }))).toEqual([]);
    expect(
      checkD100(
        model([dividends('individual', 800, { unpaidAtYearEnd: 4000 })], { period: december }),
      ),
    ).toEqual([]);
    expect(checkD100(model([micro(120_000), other()]))).toEqual([]);
  });

  test('check the identification fields', () => {
    const checks = checkD100(
      model([micro(120_000)], {
        successorCui: '14399841',
        declarant: { lastName: 'Popescu', firstName: 'A'.repeat(76), role: ' ' },
        payer: {
          cui: 'RO18547290',
          name: 'Exemplu Servicii SRL',
          address: 'Str. Lungă nr. 10, Galați',
          phone: '0'.repeat(16),
          email: 'nu-este-email',
        },
        representative: { cui: '14399841', name: 'Contabil Test SRL' },
      }),
    );
    expect(checks.map((check) => `${check.severity}:${check.path}`)).toEqual([
      'error:declarant.firstName',
      'error:declarant.role',
      'error:payer.cui',
      'error:successorCui',
      'error:payer.phone',
      'warning:payer.email',
      'error:representative.cui',
    ]);
    expect(codes(model([micro(1)], { payer: { ...quarter.payer, cui: '1960101170019' } }))).toEqual(
      [],
    );
  });

  test('require a quarter month for the micro tax, unless the company dissolves', () => {
    expect(codes(model([micro(1)], { period: { year: 2026, month: 8 } }))).toEqual([
      'error:D100_QUARTER',
    ]);
    expect(
      codes(model([micro(1)], { period: { year: 2026, month: 8 }, dissolution: true })),
    ).toEqual([]);
  });

  test('warn that the fourth quarter due date is disputed', () => {
    expect(codes(model([micro(1, { fourthQuarterDue: 'january' })], { period: december }))).toEqual(
      ['warning:D100_FOURTH_QUARTER'],
    );
    expect(codes(model([micro(1)], { period: december }))).toEqual(['error:D100_DUE_DATE']);
  });

  test('allow each obligation once, excise duties once per due date', () => {
    expect(
      codes(model([dividends('individual', 1), dividends('individual', 2)], { period: june })),
    ).toEqual(['error:D100_DUPLICATE']);
    const excise = (dueDate: string) => other({ code: '211', budgetCode: '20A140205', dueDate });
    expect(codes(model([excise('2026-09-15'), excise('2026-10-25')]))).toEqual([]);
    expect(codes(model([excise('2026-10-25'), excise('2026-10-25')]))).toEqual([
      'error:D100_DUPLICATE',
    ]);
  });

  test('warn when the micro deductions leave a negative payable or exceed 15%', () => {
    expect(codes(model([micro(120_000, { reduction: 180 })]))).toEqual([]);
    expect(codes(model([micro(120_000, { reduction: 181 })]))).toEqual(['warning:D100_REDUCTION']);
    expect(codes(model([micro(120_000, { deductible: 1100, reduction: 101 })]))).toEqual([
      'warning:D100_DEDUCTIBLE',
    ]);
  });

  test('list the inputs the calculation refuses, without throwing', () => {
    expect(codes(model([]))).toEqual(['error:D100_OBLIGATIONS']);
    expect(codes(model([micro(0.5), other({ code: '150', dueDate: '2026-13-01' })]))).toEqual([
      'error:D100_AMOUNT',
      'error:D100_CODE',
      'error:D100_DUE_DATE',
    ]);
    expect(
      codes(model([dividends('company', 1, { unpaidAtYearEnd: 1 })], { period: june })),
    ).toEqual(['error:D100_YEAR_END']);
    expect(
      codes(
        model([{ ...dividends('company', 1), beneficiary: 'state' } as unknown as D100Obligation]),
      ),
    ).toEqual(['error:D100_BENEFICIARY']);
    expect(codes(model([micro(1)], { period: { year: 2025, month: 9 } }))).toEqual([
      'error:D100_PERIOD',
    ]);
    expect(
      codes(
        model([dividends('individual', 999_999_999_999_999), dividends('company', 1)], {
          period: june,
        }),
      ),
    ).toEqual(['error:D100_TOTAL']);
  });
});
