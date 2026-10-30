import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  calculateD205,
  checkD205,
  d205DividendRates,
  d205IncomeTypes,
  d205Namespace,
  writeD205,
  type D205,
  type D205Beneficiary,
  type D205Payment,
} from '../src/ro/declarations/d205';

const payment = (gross: number, tax: number, patch: Partial<D205Payment> = {}): D205Payment => ({
  date: '2026-06-15',
  distributed: '2026-04-20',
  gross,
  tax,
  ...patch,
});

type Individual = Extract<D205Beneficiary, { kind: 'individual' }>;

/** 30,000 lei of 2026 dividends paid at once, 16% withheld. */
const individual = (patch: Partial<Individual> = {}): Individual => ({
  kind: 'individual',
  cnp: '1781105170030',
  name: 'Dumitrescu Andrei',
  payments: [payment(30_000, 4800)],
  unpaid: [],
  ...patch,
});

/** 20,000 lei paid in two instalments. */
const instalments = individual({
  cnp: '2850722170021',
  name: 'Georgescu Elena',
  payments: [payment(12_000, 1920), payment(8000, 1280, { date: '2026-11-16' })],
});

const company: D205Beneficiary = {
  kind: 'company',
  cui: '14399840',
  name: 'Partener Investiții SRL',
  payments: [payment(10_000, 1600)],
  unpaid: [],
};

const model = (
  beneficiaries: D205Beneficiary[] = [individual()],
  extra: Partial<D205> = {},
): D205 => ({
  year: 2026,
  correction: false,
  declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' },
  payer: {
    cui: '18547290',
    name: 'Exemplu Servicii SRL',
    address: 'Str. Lungă nr. 10, Galați',
  },
  paidAs: 'gross',
  beneficiaries,
  ...extra,
});

const codes = (value: D205) => checkD205(value).map((check) => `${check.severity}:${check.code}`);
const attribute = (xml: string, name: string, element = 'declaratie205') =>
  new RegExp(`<${element} [^>]*?\\b${name}="([^"]*)"`).exec(xml)?.[1];
const elements = (xml: string, name: string) =>
  [...xml.matchAll(new RegExp(`<${name} [^>]*/?>`, 'g'))].map((match) => match[0]);

describe('D205 namespace and catalogues', () => {
  test('uses v3 for the reporting years 2025 and 2026 and nothing else', () => {
    expect(d205Namespace(2025)).toBe('mfp:anaf:dgti:d205:declaratie:v3');
    expect(d205Namespace(2026)).toBe('mfp:anaf:dgti:d205:declaratie:v3');
    for (const year of [2024, 2027, 2025.5])
      expect(() => d205Namespace(year)).toThrow('2025 și 2026');
  });

  test('lists the dividend and interest codes and the structure’s rates', () => {
    expect(d205IncomeTypes.map(([code]) => code)).toEqual(['08', '09']);
    expect(d205IncomeTypes[0][1]).toContain('venituri din dividende');
    expect(d205DividendRates).toEqual({ 2024: 8, 2025: 10, 2026: 16 });
  });
});

describe('D205 calculation', () => {
  test('declares an individual’s dividends with their base and tax', () => {
    const calculation = calculateD205(model());
    expect(calculation.records).toEqual([
      {
        id: 1,
        beneficiary: 0,
        incomeType: '08',
        distributed: 30_000n,
        paid: 30_000n,
        base: 30_000n,
        tax: 4800n,
      },
    ]);
    expect(calculation.summaries).toEqual([
      { incomeType: '08', beneficiaries: 1, base: 30_000n, tax: 4800n },
    ]);
    expect(calculation.omitted).toEqual([]);
    expect(calculation.controlSum).toBe(34_801n);
  });

  test('sums instalments into one record and leaves companies out', () => {
    const calculation = calculateD205(model([individual(), company, instalments]));
    expect(
      calculation.records.map(({ id, beneficiary, distributed, base, tax }) => ({
        id,
        beneficiary,
        distributed,
        base,
        tax,
      })),
    ).toEqual([
      { id: 1, beneficiary: 0, distributed: 30_000n, base: 30_000n, tax: 4800n },
      { id: 2, beneficiary: 2, distributed: 20_000n, base: 20_000n, tax: 3200n },
    ]);
    expect(calculation.omitted).toEqual([1]);
    expect(calculation.summaries).toEqual([
      { incomeType: '08', beneficiaries: 2, base: 50_000n, tax: 8000n },
    ]);
    expect(calculation.controlSum).toBe(58_002n);
  });

  test('declares dividends unpaid at year end in the year of distribution', () => {
    const [record] = calculateD205(
      model([individual({ unpaid: [{ gross: 5000, tax: 800 }] })]),
    ).records;
    expect(record).toMatchObject({
      distributed: 35_000n,
      paid: 30_000n,
      base: 35_000n,
      tax: 5600n,
    });
    const onlyUnpaid = calculateD205(
      model([individual({ payments: [], unpaid: [{ gross: 5000, tax: 800 }] })]),
    );
    expect(onlyUnpaid.records[0]).toMatchObject({
      distributed: 5000n,
      paid: 0n,
      base: 5000n,
      tax: 800n,
    });
    expect(onlyUnpaid.controlSum).toBe(5801n);
  });

  test('adds a payment of earlier dividends to the dividends paid only', () => {
    // Distributed in 2025, unpaid at its end: 10% paid by 25 January 2026, declared for 2025.
    const earlier = payment(10_000, 1000, { date: '2026-03-02', distributed: '2025-05-12' });
    const [record] = calculateD205(
      model([individual({ payments: [earlier, payment(30_000, 4800)] })]),
    ).records;
    expect(record).toMatchObject({
      distributed: 30_000n,
      paid: 40_000n,
      base: 30_000n,
      tax: 4800n,
    });
    const net = calculateD205(
      model([individual({ payments: [earlier, payment(30_000, 4800)] })], { paidAs: 'net' }),
    );
    expect(net.records[0]!.paid).toBe(34_200n);
  });

  test('declares the dividends paid net of tax when asked to', () => {
    const calculation = calculateD205(model([individual(), instalments], { paidAs: 'net' }));
    expect(calculation.records.map((record) => record.paid)).toEqual([25_200n, 16_800n]);
    // divid_P is outside sect_II and the control sum.
    expect(calculation.controlSum).toBe(58_002n);
  });

  test('writes zero for a beneficiary without dividends', () => {
    const calculation = calculateD205(
      model([individual({ payments: [], unpaid: [] })], { correction: true }),
    );
    expect(calculation.records[0]).toMatchObject({ distributed: 0n, paid: 0n, base: 0n, tax: 0n });
    expect(calculation.controlSum).toBe(1n);
  });

  test('agrees between its records, totals and control sum for any amounts', () => {
    const amount = fc.integer({ min: 0, max: 10_000_000 });
    const item = fc.record({ gross: amount, tax: amount, earlier: fc.boolean() });
    const beneficiary = fc
      .record({
        payments: fc.array(item, { maxLength: 4 }),
        unpaid: fc.array(fc.record({ gross: amount, tax: amount }), { maxLength: 2 }),
        company: fc.boolean(),
      })
      .map(({ payments, unpaid, company }): D205Beneficiary => {
        const listed = payments.map(({ gross, tax, earlier }) =>
          payment(gross, tax, earlier ? { distributed: '2025-05-12' } : {}),
        );
        return company
          ? { kind: 'company', cui: '14399840', name: 'Partener SRL', payments: listed, unpaid }
          : individual({ payments: listed, unpaid });
      });
    fc.assert(
      fc.property(
        fc.array(beneficiary, { minLength: 1, maxLength: 10 }),
        fc.constantFrom('gross' as const, 'net' as const),
        (beneficiaries, paidAs) => {
          const value = model(beneficiaries, { paidAs });
          const calculation = calculateD205(value);
          const individuals = beneficiaries.filter((entry) => entry.kind === 'individual');
          expect(calculation.records.length).toBe(individuals.length);
          expect(calculation.omitted.length).toBe(beneficiaries.length - individuals.length);
          expect(calculation.records.map((record) => record.id)).toEqual(
            individuals.map((_, index) => index + 1),
          );
          const base = calculation.records.reduce((total, record) => total + record.base, 0n);
          const tax = calculation.records.reduce((total, record) => total + record.tax, 0n);
          expect(calculation.summaries).toEqual(
            individuals.length
              ? [{ incomeType: '08', beneficiaries: individuals.length, base, tax }]
              : [],
          );
          expect(calculation.controlSum).toBe(BigInt(individuals.length) + base + tax);
          for (const record of calculation.records) {
            const entry = beneficiaries[record.beneficiary]!;
            expect(record.base).toBe(record.distributed);
            const gross = entry.payments.reduce((total, item) => total + BigInt(item.gross), 0n);
            const withheld = entry.payments.reduce((total, item) => total + BigInt(item.tax), 0n);
            expect(record.paid).toBe(paidAs === 'gross' ? gross : gross - withheld);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  test('refuses inputs it cannot sum', () => {
    const one = (patch: Partial<D205Payment>) =>
      model([individual({ payments: [payment(30_000, 4800, patch)] })]);
    expect(() => calculateD205(one({ gross: 30_000.5 }))).toThrow('fără zecimale');
    expect(() => calculateD205(one({ tax: -1 }))).toThrow('nenegativă');
    expect(() => calculateD205(one({ gross: 1e15 }))).toThrow('15 cifre');
    expect(() => calculateD205(one({ distributed: '20.04.2026' }))).toThrow('AAAA-LL-ZZ');
    expect(() => calculateD205(one({ distributed: '2027-01-10' }))).toThrow('după anul');
    expect(() =>
      calculateD205(model([individual({ unpaid: [{ gross: 100, tax: 16.5 } as never] })])),
    ).toThrow('fără zecimale');
    expect(() => calculateD205(model(undefined, { paidAs: 'cash' as 'net' }))).toThrow(
      'brute (gross) sau nete (net)',
    );
    expect(() =>
      calculateD205(model([{ ...individual(), kind: 'trust' } as unknown as D205Beneficiary])),
    ).toThrow('persoană fizică sau o societate');
    expect(() => calculateD205(model(undefined, { year: 2027 }))).toThrow('2025 și 2026');
  });
});

describe('D205 XML', () => {
  test('writes the declaration of one individual in full', () => {
    expect(writeD205(model())).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<declaratie205 xmlns="mfp:anaf:dgti:d205:declaratie:v3"' +
        ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
        ' xsi:schemaLocation="mfp:anaf:dgti:d205:declaratie:v3 D205.xsd"' +
        ' luna="12" an="2026" d_rec="0" d_succ="0" nume_declar="Popescu" prenume_declar="Ana"' +
        ' functie_declar="Administrator" cui="18547290" den="Exemplu Servicii SRL"' +
        ' adresa="Str. Lungă nr. 10, Galați" totalPlata_A="34801">\n' +
        '  <sect_II tip_venit="08" nrben="1" Tcastig="0" Tpierd="0" Tbaza="30000" Timp="4800"' +
        ' T_VB="0" T_GAR="0"/>\n' +
        '  <benef id_inreg="1" tip_venit1="08" den1="Dumitrescu Andrei" cifR="1781105170030"' +
        ' tip_plata="2" Rezid="1" baza1="30000" imp1="4800" divid_D="30000" divid_P="30000"/>\n' +
        '</declaratie205>\n',
    );
  });

  test('writes one record per individual, without companies', () => {
    const xml = writeD205(model([individual(), company, instalments], { paidAs: 'net' }));
    expect(elements(xml, 'sect_II')).toEqual([
      '<sect_II tip_venit="08" nrben="2" Tcastig="0" Tpierd="0" Tbaza="50000" Timp="8000" T_VB="0" T_GAR="0"/>',
    ]);
    expect(elements(xml, 'benef').map((tag) => attribute(tag, 'cifR', 'benef'))).toEqual([
      '1781105170030',
      '2850722170021',
    ]);
    expect(elements(xml, 'benef')[1]).toContain(
      'id_inreg="2" tip_venit1="08" den1="Georgescu Elena"',
    );
    expect(elements(xml, 'benef')[1]).toContain(
      'baza1="20000" imp1="3200" divid_D="20000" divid_P="16800"',
    );
    expect(xml).not.toContain('14399840');
    expect(attribute(xml, 'totalPlata_A')).toBe('58002');
  });

  test('writes a rectifying declaration, a successor and the payer’s contacts', () => {
    const xml = writeD205(
      model(
        [instalments, individual({ cnp: '2790312400010', name: 'Vasilescu Maria', payments: [] })],
        {
          correction: true,
          payer: {
            cui: '18547290',
            successorCui: '14399840',
            name: 'Exemplu & "Fiul" SRL',
            address: 'Str. Lungă nr. 10, Galați',
            phone: '0236000000',
            fax: '0236000001',
            email: 'office@exemplu.ro',
          },
        },
      ),
    );
    expect(xml).toContain('luna="12" an="2026" d_rec="1" d_succ="1" cifSS="14399840"');
    expect(xml).toContain(
      'cui="18547290" den="Exemplu &amp; &quot;Fiul&quot; SRL" adresa="Str. Lungă nr. 10, Galați"' +
        ' telefon="0236000000" fax="0236000001" mail="office@exemplu.ro" totalPlata_A="23202"',
    );
    expect(elements(xml, 'benef')[1]).toBe(
      '<benef id_inreg="2" tip_venit1="08" den1="Vasilescu Maria" cifR="2790312400010"' +
        ' tip_plata="2" Rezid="1" baza1="0" imp1="0" divid_D="0" divid_P="0"/>',
    );
  });

  test('refuses a declaration without individuals and is deterministic', () => {
    expect(() => writeD205(model([company]))).toThrow('cel puțin un beneficiar persoană fizică');
    expect(() => writeD205(model([]))).toThrow('cel puțin un beneficiar persoană fizică');
    const value = model([individual(), company, instalments]);
    expect(writeD205(value)).toBe(writeD205(structuredClone(value)));
  });
});

describe('D205 checks', () => {
  test('pass for consistent declarations', () => {
    expect(checkD205(model())).toEqual([]);
    expect(checkD205(model([individual(), instalments], { paidAs: 'net' }))).toEqual([]);
    expect(
      checkD205(
        model([
          individual({
            payments: [
              payment(10_000, 1000, { date: '2026-03-02', distributed: '2025-05-12' }),
              payment(30_000, 4800),
            ],
            unpaid: [{ gross: 5000, tax: 800 }],
          }),
        ]),
      ),
    ).toEqual([]);
    expect(
      checkD205(
        model(
          [
            individual({
              payments: [payment(30_000, 3000, { date: '2025-06-15', distributed: '2025-04-20' })],
            }),
          ],
          {
            year: 2025,
          },
        ),
      ),
    ).toEqual([]);
  });

  test('warn that a company is left out', () => {
    expect(checkD205(model([individual(), company]))).toEqual([
      {
        code: 'D205_COMPANY',
        severity: 'warning',
        path: 'beneficiaries.1',
        message:
          'Dividendele societății Partener Investiții SRL (CUI 14399840) nu se declară în D205, care cuprinde doar persoane fizice.',
      },
    ]);
    expect(codes(model([company]))).toEqual(['warning:D205_COMPANY', 'error:D205_BENEFICIARIES']);
    expect(codes(model([]))).toEqual(['error:D205_BENEFICIARIES']);
  });

  test('check the identity of each individual, once', () => {
    const one = (patch: Partial<Individual>) => codes(model([individual(patch)]));
    expect(one({ cnp: '1781105170031' })).toEqual(['error:D205_CNP']);
    // A valid control digit, but month 13 and 30 February.
    expect(one({ cnp: '1781305170038' })).toEqual(['error:D205_CNP']);
    expect(one({ cnp: '1790230170042' })).toEqual(['error:D205_CNP']);
    // The NIF prefix.
    expect(one({ cnp: '9001011700016' })).toEqual(['error:D205_CNP']);
    expect(one({ name: ' ' })).toEqual(['error:D205_TEXT']);
    expect(one({ name: 'A'.repeat(101) })).toEqual(['error:D205_TEXT']);
    expect(codes(model([individual(), instalments, individual()]))).toEqual([
      'error:D205_DUPLICATE',
    ]);
  });

  test('check the declarant and the payer', () => {
    const checks = checkD205(
      model(undefined, {
        declarant: { lastName: '', firstName: 'B'.repeat(76), role: 'C'.repeat(51) },
        payer: {
          cui: 'RO18547290',
          successorCui: '14399841',
          name: '',
          address: ' ',
          phone: '0'.repeat(16),
          email: 'office@',
        },
      }),
    );
    expect(checks.map((check) => `${check.severity}:${check.code}:${check.path}`)).toEqual([
      'error:D205_TEXT:declarant.lastName',
      'error:D205_TEXT:declarant.firstName',
      'error:D205_TEXT:declarant.role',
      'error:D205_CUI:payer.cui',
      'error:D205_CUI:payer.successorCui',
      'error:D205_TEXT:payer.name',
      'error:D205_TEXT:payer.address',
      'error:D205_TEXT:payer.phone',
      'warning:D205_EMAIL:payer.email',
    ]);
    const in2024 = payment(30_000, 2400, { date: '2024-06-15', distributed: '2024-04-20' });
    expect(codes(model([individual({ payments: [in2024] })], { year: 2024 }))).toEqual([
      'error:D205_YEAR',
    ]);
  });

  test('check payment and distribution dates', () => {
    const one = (patch: Partial<D205Payment>) =>
      codes(model([individual({ payments: [payment(30_000, 4800, patch)] })]));
    expect(one({ date: '2026-02-30' })).toEqual(['error:D205_DATE']);
    expect(one({ date: '2027-01-05' })).toEqual(['error:D205_DATE']);
    expect(one({ date: '2026-04-19' })).toEqual(['error:D205_DATE']);
    expect(one({ date: '2026-04-20' })).toEqual([]);
    expect(one({ distributed: '2027-01-10', date: '2027-01-15' })).toEqual([
      'error:D205_DATE',
      'error:D205_DATE',
    ]);
  });

  test('check the tax against the rate of the year of distribution', () => {
    const one = (gross: number, tax: number, distributed = '2026-04-20') =>
      codes(model([individual({ payments: [payment(gross, tax, { distributed })] })]));
    expect(one(30_000, 4799)).toEqual([]);
    expect(one(30_000, 4802)).toEqual(['warning:D205_TAX']);
    expect(one(30_000, 3000)).toEqual(['warning:D205_TAX']);
    expect(one(30_000, 3000, '2025-05-12')).toEqual([]);
    expect(one(30_000, 2400, '2024-05-12')).toEqual([]);
    // No rate of the structure for 2023 distributions.
    expect(one(30_000, 0, '2023-05-12')).toEqual([]);
    expect(one(1000, 1001)).toEqual(['error:D205_TAX']);
    // 16% of 1003 lei is 160.48, rounded 160.
    expect(one(1003, 161)).toEqual([]);
    expect(one(1003, 162)).toEqual(['warning:D205_TAX']);
    expect(
      checkD205(model([individual({ unpaid: [{ gross: 5000, tax: 500 }] })])).map(
        (check) => check.path,
      ),
    ).toEqual(['beneficiaries.0.unpaid.0.tax']);
  });

  test('warn about an empty record outside a rectifying declaration', () => {
    const empty = individual({ cnp: '2790312400010', name: 'Vasilescu Maria', payments: [] });
    expect(codes(model([individual(), empty]))).toEqual(['warning:D205_EMPTY']);
    expect(codes(model([individual(), empty], { correction: true }))).toEqual([]);
  });

  test('report what calculateD205 refuses, path by path', () => {
    const checks = checkD205(
      model([
        individual({ payments: [payment(1.5, 0), payment(100, 16, { distributed: '2026' })] }),
        instalments,
        individual({ cnp: '2790312400010', unpaid: [{ gross: -5, tax: 0 }] }),
      ]),
    );
    expect(checks.map((check) => `${check.code}:${check.path}`)).toEqual([
      'D205_AMOUNT:beneficiaries.0.payments.0.gross',
      'D205_DATE:beneficiaries.0.payments.1.distributed',
      'D205_AMOUNT:beneficiaries.2.unpaid.0.gross',
    ]);
  });

  test('report totals beyond 15 digits', () => {
    const huge = (cnp: string) => individual({ cnp, payments: [payment(999_999_999_999_999, 0)] });
    expect(codes(model([huge('1781105170030'), huge('2850722170021')]))).toEqual([
      'warning:D205_TAX',
      'warning:D205_TAX',
      'error:D205_TOTAL',
    ]);
  });
});

describe('D205 interest (tip_venit 09)', () => {
  /** An associate's loan: 850 lei of interest paid in two parts, 10% withheld at payment. */
  const lender = individual({
    payments: [],
    interest: [
      { date: '2026-06-30', gross: 400, tax: 40 },
      { date: '2026-12-15', gross: 450, tax: 45 },
    ],
  });

  test('declares an individual’s interest with its base and tax, without dividend fields', () => {
    const calculation = calculateD205(model([lender]));
    expect(calculation.records).toEqual([
      {
        id: 1,
        beneficiary: 0,
        incomeType: '09',
        distributed: 0n,
        paid: 0n,
        base: 850n,
        tax: 85n,
      },
    ]);
    expect(calculation.summaries).toEqual([
      { incomeType: '09', beneficiaries: 1, base: 850n, tax: 85n },
    ]);
    expect(calculation.controlSum).toBe(1n + 850n + 85n);
    const xml = writeD205(model([lender]));
    const [benef] = elements(xml, 'benef');
    expect(benef).toContain('tip_venit1="09"');
    expect(benef).toContain('tip_plata="2"');
    expect(benef).toContain('Rezid="1"');
    expect(benef).not.toContain('divid_D');
    expect(benef).not.toContain('divid_P');
    expect(codes(model([lender]))).toEqual([]);
  });

  test('gives an individual with dividends and interest a record of each type', () => {
    const both = individual({ interest: [{ date: '2026-09-30', gross: 1000, tax: 100 }] });
    const calculation = calculateD205(model([both, instalments]));
    expect(calculation.records.map((record) => [record.incomeType, record.beneficiary])).toEqual([
      ['08', 0],
      ['09', 0],
      ['08', 1],
    ]);
    expect(
      calculation.summaries.map((summary) => [summary.incomeType, summary.beneficiaries]),
    ).toEqual([
      ['08', 2],
      ['09', 1],
    ]);
    expect(elements(writeD205(model([both, instalments])), 'sect_II')).toHaveLength(2);
  });

  test('warns on a tax other than 10% and refuses one above the interest or out of the year', () => {
    const odd = individual({
      payments: [],
      interest: [
        { date: '2026-06-30', gross: 400, tax: 30 },
        { date: '2025-12-31', gross: 100, tax: 101 },
      ],
    });
    expect(codes(model([odd]))).toEqual(['warning:D205_TAX', 'error:D205_DATE', 'error:D205_TAX']);
  });
});
