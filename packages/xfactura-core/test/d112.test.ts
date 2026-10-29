import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  calculateD112,
  checkD112,
  d112ContractTypes,
  d112InsuredTypes,
  d112Namespace,
  d112Obligations,
  d112Reasons,
  writeD112,
  type D112,
  type D112Insured,
} from '../src/ro/declarations/d112';

type Patch = Partial<Omit<D112Insured, 'employment' | 'income'>> & {
  employment?: Partial<D112Insured['employment']>;
  income?: Partial<D112Insured['income']>;
};

/** A full-time employee paid 5000 lei in October 2026, at the main job, without dependents. */
const employee = (patch: Patch = {}): D112Insured => ({
  cnp: '1781105170030',
  lastName: 'Dumitrescu',
  firstName: 'Andrei',
  from: '2023-09-01',
  healthFund: 'RO-GL',
  sickLeaveInsured: true,
  unemploymentInsured: true,
  ...patch,
  employment: {
    type: '1',
    pensioner: false,
    contract: 'N',
    normHours: 8,
    baseSalary: 5000,
    hoursWorked: 176,
    hoursSuspended: 0,
    daysWorked: 22,
    unemploymentBase: 5000,
    camBase: 5000,
    cassBase: 5000,
    cass: 500,
    casBase: 5000,
    cas: 1250,
    relief: 0,
    ...patch.employment,
  },
  income: {
    mainJob: true,
    cash: 5000,
    mealVouchers: 0,
    holidayVouchers: 0,
    dependents: 0,
    deduction: { basic: 562, young: 0, children: 0 },
    otherDeductions: 0,
    taxBase: 2688,
    tax: 269,
    paid: 2981,
    ...patch.income,
  },
});

/** The minimum wage, 200 lei of it left out of the bases. */
const minimumWage = employee({
  cnp: '1900315170013',
  lastName: 'Ionescu',
  firstName: 'Mihai',
  from: '2024-03-01',
  employment: {
    type: '51',
    baseSalary: 4325,
    unemploymentBase: 4325,
    camBase: 4125,
    cassBase: 4125,
    cass: 413,
    casBase: 4125,
    cas: 1031,
    relief: 200,
  },
  income: {
    cash: 4325,
    deduction: { basic: 865, young: 0, children: 0 },
    taxBase: 1816,
    tax: 182,
    paid: 2699,
  },
});

/** Four hours a day for 2500 lei, CAS and CASS due on a limit sum. */
const partTime = (base = 4325) =>
  employee({
    cnp: '2850722170021',
    lastName: 'Georgescu',
    firstName: 'Elena',
    from: '2025-02-15',
    minimum: { kind: 'due', base },
    employment: {
      contract: 'P4',
      hoursWorked: 88,
      baseSalary: 2500,
      unemploymentBase: 2500,
      camBase: 2500,
      cassBase: 2500,
      cass: 250,
      casBase: 2500,
      cas: 625,
    },
    income: {
      cash: 2500,
      deduction: { basic: 865, young: 0, children: 0 },
      taxBase: 760,
      tax: 76,
      paid: 1549,
    },
  });

/** 6000 lei of salary and 800 lei of meal vouchers. */
const vouchers = employee({
  cnp: '2931204170043',
  lastName: 'Constantinescu',
  firstName: 'Ioana',
  from: '2022-06-01',
  employment: {
    baseSalary: 6000,
    unemploymentBase: 6000,
    camBase: 6000,
    cassBase: 6800,
    cass: 680,
    casBase: 6000,
    cas: 1500,
  },
  income: {
    cash: 6000,
    mealVouchers: 800,
    deduction: { basic: 0, young: 0, children: 0 },
    taxBase: 4620,
    tax: 462,
    paid: 3358,
  },
});

const model = (insured: D112Insured[] = [employee()], extra: Partial<D112> = {}): D112 => ({
  period: { year: 2026, month: 10 },
  correction: false,
  declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' },
  employer: {
    cui: '18547290',
    caen: '6201',
    name: 'Exemplu Servicii SRL',
    registeredOffice: { address: 'Str. Lungă nr. 10, Galați' },
    healthFund: 'RO-GL',
  },
  insured,
  ...extra,
});

const codes = (value: D112) => checkD112(value).map((check) => `${check.severity}:${check.code}`);
const attribute = (xml: string, name: string, element = 'declaratieUnica') =>
  new RegExp(`<${element} [^>]*?\\b${name}="([^"]*)"`).exec(xml)?.[1];
const elements = (xml: string, name: string) =>
  [...xml.matchAll(new RegExp(`<${name} [^>]*/?>`, 'g'))].map((match) => match[0]);
const owed = (value: D112) =>
  Object.fromEntries(
    calculateD112(value).obligations.map((obligation) => [obligation.code, obligation.owed]),
  );

describe('D112 namespace and catalogues', () => {
  test('uses v7 for July–December 2026 and nothing else', () => {
    expect(d112Namespace({ year: 2026, month: 7 })).toBe(
      'mfp:anaf:dgti:declaratie_unica:declaratie:v7',
    );
    expect(d112Namespace({ year: 2026, month: 12 })).toBe(
      'mfp:anaf:dgti:declaratie_unica:declaratie:v7',
    );
    for (const period of [
      { year: 2026, month: 6 },
      { year: 2027, month: 1 },
      { year: 2026, month: 13 },
      { year: 2026.5, month: 8 },
    ])
      expect(() => d112Namespace(period)).toThrow('iulie–decembrie 2026');
  });

  test('lists the codes the structure allows for the covered fields', () => {
    expect(d112InsuredTypes.map(([type]) => type)).toEqual(['1', '51']);
    expect(d112ContractTypes).toEqual(['N', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7']);
    expect(d112Reasons.map(([reason]) => reason)).toEqual(['2', '3', '4', '5', '7', '8', '9']);
    expect(d112Obligations.map(([code, budget]) => `${code}:${budget}`)).toEqual([
      '602:5503XXXXXX',
      '412:5503XXXXXX',
      '432:5503XXXXXX',
      '480:20470300XX',
      '458:5503XXXXXX',
      '459:5503XXXXXX',
    ]);
    for (const list of [d112InsuredTypes, d112Reasons, d112Obligations])
      expect(list.every((entry) => entry.at(-1)!.length > 0)).toBe(true);
  });

  test('takes the working days of the month from the structure', () => {
    const days = [7, 8, 9, 10, 11, 12].map(
      (month) => calculateD112(model(undefined, { period: { year: 2026, month } })).workingDays,
    );
    expect(days).toEqual([23, 21, 22, 22, 20, 21]);
  });
});

describe('D112 calculation', () => {
  test('reports the minimum-wage relief as A_13S and adds it back in C1_11', () => {
    const calculation = calculateD112(model([minimumWage]));
    expect(calculation.insured[0]).toMatchObject({
      id: 1,
      income: 4325n,
      reliefIncome: 4325n,
      contributions: 1444n,
      deduction: { total: 865n, supplementary: 0n },
      tax: 182n,
      limit: { casBase: 0n, cas: 0n, cassBase: 0n, cass: 0n },
      employer: { cas: 0n, cass: 0n },
    });
    expect(owed(model([minimumWage]))).toEqual({
      '602': 182n,
      '412': 1031n,
      '432': 413n,
      '480': 93n,
    });
    expect(calculation.counts).toEqual({ unemployment: 1, sickLeave: 1, pension: 1, employees: 1 });
    expect(calculation.grossSalaries).toBe(4125n);
    expect(calculation.normalIncome).toBe(4325n);
    expect(calculation.cam).toEqual({ base: 4125n, amount: 93n });
    expect(calculation.controlSum).toBe(1719n);
  });

  test('derives the employer-borne difference from the limit sum', () => {
    const [part] = calculateD112(model([partTime()])).insured;
    expect(part!.limit).toEqual({ casBase: 4325n, cas: 1081n, cassBase: 4325n, cass: 433n });
    expect(part!.employer).toEqual({ cas: 456n, cass: 183n });
    // The structure's own limit sum, (4325 − 200) × 22 / 22.
    const [structure] = calculateD112(model([partTime(4125)])).insured;
    expect(structure!.limit).toEqual({ casBase: 4125n, cas: 1031n, cassBase: 4125n, cass: 413n });
    expect(structure!.employer).toEqual({ cas: 406n, cass: 163n });

    const both = calculateD112(model([partTime(), employee()]));
    expect(both.obligations.map((obligation) => [obligation.code, obligation.owed])).toEqual([
      ['602', 345n],
      ['412', 1875n],
      ['432', 750n],
      ['480', 169n],
      ['458', 456n],
      ['459', 183n],
    ]);
    expect(both.controlSum).toBe(3778n);
    expect(both.insured.map((person) => person.id)).toEqual([1, 2]);
  });

  test('applies the limit to the CASS base only while it is below it', () => {
    const [person] = calculateD112(
      model(
        [
          partTime(4325),
          // Vouchers lift the CASS base to the limit; the CAS base stays below it.
        ].map((insured) => ({
          ...insured,
          employment: { ...insured.employment, cassBase: 4400, cass: 440 },
          income: { ...insured.income, mealVouchers: 1900 },
        })),
      ),
    ).insured;
    expect(person!.limit).toEqual({ casBase: 4325n, cas: 1081n, cassBase: 0n, cass: 0n });
    expect(person!.employer).toEqual({ cas: 456n, cass: 0n });
  });

  test('declares nothing borne by the employer for an exempt employee', () => {
    const exempt = { ...partTime(), minimum: { kind: 'exempt', reason: 'student' } as const };
    const calculation = calculateD112(model([exempt]));
    expect(calculation.insured[0]!.employer).toEqual({ cas: 0n, cass: 0n });
    expect(calculation.obligations.map((obligation) => obligation.code)).toEqual([
      '602',
      '412',
      '432',
      '480',
    ]);
  });

  test('keeps meal vouchers in the gross income and the CASS base only', () => {
    const calculation = calculateD112(model([vouchers]));
    expect(calculation.insured[0]).toMatchObject({ income: 6800n, benefits: 800n });
    expect(owed(model([vouchers]))).toEqual({
      '602': 462n,
      '412': 1500n,
      '432': 680n,
      '480': 135n,
    });
    expect(calculation.grossSalaries).toBe(6800n);
    expect(calculation.normalIncome).toBe(6000n);
    expect(calculation.cam).toEqual({ base: 6000n, amount: 135n });
  });

  test('rounds CAM once on the employer total, a fraction of a leu to one leu', () => {
    const half = (cnp: string) =>
      employee({
        cnp,
        employment: { camBase: 2500, cassBase: 2500, cass: 250, casBase: 2500, cas: 625 },
      });
    // 56.25 + 56.25 lei: 113 on the total, not 56 + 56.
    expect(calculateD112(model([half('1781105170030'), half('2960811170089')])).cam).toEqual({
      base: 5000n,
      amount: 113n,
    });
    expect(calculateD112(model([employee({ employment: { camBase: 10 } })])).cam.amount).toBe(1n);
  });

  test('counts insured by the structure’s rules', () => {
    const pensioner = employee({
      cnp: '2960811170089',
      sickLeaveInsured: false,
      employment: { pensioner: true, unemploymentBase: 0 },
    });
    const calculation = calculateD112(model([employee(), pensioner]));
    expect(calculation.counts).toEqual({
      unemployment: 1,
      sickLeave: 1,
      pension: 2,
      employees: 2,
    });
    expect(calculation.grossSalaries).toBe(5000n);
  });

  test('writes the income tax alone when no obligation has an amount', () => {
    const idle = employee({
      employment: {
        hoursWorked: 0,
        hoursSuspended: 176,
        daysWorked: 0,
        unemploymentBase: 0,
        camBase: 0,
        cassBase: 0,
        cass: 0,
        casBase: 0,
        cas: 0,
      },
      income: {
        cash: 0,
        deduction: { basic: 0, young: 0, children: 0 },
        taxBase: 0,
        tax: 0,
        paid: 0,
      },
    });
    const calculation = calculateD112(model([idle]));
    expect(calculation.obligations).toEqual([
      { code: '602', budgetCode: '5503XXXXXX', owed: 0n, deductible: 0n, exempt: 0n, payable: 0n },
    ]);
    expect(calculation.controlSum).toBe(0n);
  });

  test('agrees between its obligations and the insured for any amounts', () => {
    const amount = fc.integer({ min: 0, max: 100_000 });
    const person = fc
      .record({
        cas: amount,
        cass: amount,
        camBase: amount,
        tax: amount,
        base: fc.option(fc.integer({ min: 1, max: 9000 }), { nil: undefined }),
      })
      .map(({ cas, cass, camBase, tax, base }) =>
        employee({
          cnp: '1781105170030',
          minimum: base === undefined ? undefined : { kind: 'due', base },
          employment: { cas, cass, camBase, casBase: 1000, cassBase: 1000 },
          income: { tax, taxBase: tax },
        }),
      );
    fc.assert(
      fc.property(fc.array(person, { minLength: 1, maxLength: 12 }), (insured) => {
        const calculation = calculateD112(model(insured));
        const byCode = Object.fromEntries(
          calculation.obligations.map((obligation) => [obligation.code, obligation.payable]),
        );
        const total = (pick: (person: D112Insured) => number) =>
          insured.reduce((sum, person) => sum + BigInt(pick(person)), 0n);
        expect(byCode['412'] ?? 0n).toBe(total((person) => person.employment.cas));
        expect(byCode['432'] ?? 0n).toBe(total((person) => person.employment.cass));
        expect(byCode['602'] ?? 0n).toBe(total((person) => person.income.tax));
        expect(byCode['458'] ?? 0n).toBe(
          calculation.insured.reduce((sum, person) => sum + person.employer.cas, 0n),
        );
        expect(calculation.controlSum).toBe(
          calculation.obligations.reduce((sum, obligation) => sum + obligation.payable, 0n),
        );
        for (const person of calculation.insured) {
          expect(person.employer.cas >= 0n && person.employer.cass >= 0n).toBe(true);
          expect(person.limit.cas).toBe((person.limit.casBase * 25n + 50n) / 100n);
        }
      }),
      { numRuns: 200 },
    );
  });

  test('refuses inputs it cannot sum', () => {
    const one = (patch: Patch) => model([employee(patch)]);
    expect(() => calculateD112(one({ employment: { cas: 10.5 } }))).toThrow('fără zecimale');
    expect(() => calculateD112(one({ income: { tax: -1 } }))).toThrow('nenegativă');
    expect(() => calculateD112(one({ employment: { casBase: 1e15 } }))).toThrow('15 cifre');
    expect(() => calculateD112(one({ employment: { daysWorked: 100 } }))).toThrow('99');
    expect(() => calculateD112(one({ employment: { type: '3' as '1' } }))).toThrow(
      'tipurile 1 și 51',
    );
    expect(() => calculateD112(one({ employment: { contract: 'P8' as 'P7' } }))).toThrow(
      'Nomenclatorul 12',
    );
    expect(() => calculateD112(one({ employment: { normHours: 5 } }))).toThrow('6, 7 sau 8');
    expect(() =>
      calculateD112(one({ minimum: { kind: 'exempt', reason: 'intern' as 'student' } })),
    ).toThrow('art. 146 alin. (5^7)');
    expect(() => calculateD112(model(undefined, { period: { year: 2026, month: 6 } }))).toThrow(
      'iulie–decembrie 2026',
    );
  });
});

describe('D112 XML', () => {
  test('writes the declaration of one employee in full', () => {
    expect(writeD112(model([minimumWage]))).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<declaratieUnica xmlns="mfp:anaf:dgti:declaratie_unica:declaratie:v7"' +
        ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
        ' xsi:schemaLocation="mfp:anaf:dgti:declaratie_unica:declaratie:v7 D112.xsd"' +
        ' luna_r="10" an_r="2026" d_rec="0" nume_declar="Popescu" prenume_declar="Ana"' +
        ' functie_declar="Administrator">\n' +
        '  <angajator cif="18547290" caen="6201" den="Exemplu Servicii SRL"' +
        ' adrSoc="Str. Lungă nr. 10, Galați" casaAng="GL" datCAM="1" totalPlata_A="1719">\n' +
        '    <angajatorA A_codOblig="602" A_codBugetar="5503XXXXXX" A_datorat="182"' +
        ' A_deductibil="0" A_scutit="0" A_plata="182"/>\n' +
        '    <angajatorA A_codOblig="412" A_codBugetar="5503XXXXXX" A_datorat="1031"' +
        ' A_deductibil="0" A_scutit="0" A_plata="1031"/>\n' +
        '    <angajatorA A_codOblig="432" A_codBugetar="5503XXXXXX" A_datorat="413"' +
        ' A_deductibil="0" A_scutit="0" A_plata="413"/>\n' +
        '    <angajatorA A_codOblig="480" A_codBugetar="20470300XX" A_datorat="93"' +
        ' A_deductibil="0" A_scutit="0" A_plata="93"/>\n' +
        '    <angajatorB B_cnp="1" B_sanatate="1" B_pensie="1" B_sal="1" B_brutSalarii="4125"/>\n' +
        '    <angajatorC1 C1_11="4325" C1_12="0" C1_13="0" C1_21="0" C1_22="0" C1_23="0"' +
        ' C1_31="0" C1_32="0" C1_33="0" C1_T1="4325" C1_T2="0" C1_T="0" C1_T3="0" C1_5="0"/>\n' +
        '    <angajatorC4 C4_baza="4125" C4_ct="93"/>\n' +
        '  </angajator>\n' +
        '  <asigurat cnpAsig="1900315170013" idAsig="1" numeAsig="Ionescu" prenAsig="Mihai"' +
        ' dataAng="01.03.2024" casaSn="GL" asigCI="1" asigSO="1" Timp_E3="182">\n' +
        '    <asiguratA A_1="51" A_sal1="4325" A_sal2="4325" A_2="0" A_3="N" A_4="8" A_5="4125"' +
        ' A_6="176" A_7="0" A_8="22" A_9="4325" A_11="4125" A_12="413" A_13="4125" A_14="1031"' +
        ' A_13P="0" A_14P="0" A_11P="0" A_12P="0" A_14D="0" A_12D="0" A_13S="200"' +
        ' A_13C="4325"/>\n' +
        '    <asiguratE1 E1_1="4325" E1_2="1444" E1_3="0" E1_4="865" E1_41="865" E1_42="0"' +
        ' E1_421="0" E1_422="0" E1_5="0" E1_6="1816" E1_7="182"/>\n' +
        '    <asiguratE3 E3_1="A" E3_2="51" E3_3="1" E3_4="P" E3_8="4325" E3_9="1444" E3_19="0"' +
        ' E3_11="0" E3_12="865" E3_121="865" E3_122="0" E3_1221="0" E3_1222="0" E3_13="0"' +
        ' E3_14="1816" E3_15="182" E3_16="2699"/>\n' +
        '  </asigurat>\n' +
        '</declaratieUnica>\n',
    );
  });

  test('writes the limit sums and the minimum-contribution flags', () => {
    const xml = writeD112(model([partTime(), employee()]));
    expect(elements(xml, 'asigurat').map((tag) => attribute(tag, 'asigExc', 'asigurat'))).toEqual([
      '2',
      undefined,
    ]);
    const [part] = elements(xml, 'asiguratA');
    for (const [name, value] of [
      ['A_3', 'P4'],
      ['A_6', '88'],
      ['A_13P', '4325'],
      ['A_14P', '1081'],
      ['A_11P', '4325'],
      ['A_12P', '433'],
      ['A_14D', '456'],
      ['A_12D', '183'],
    ])
      expect(attribute(part!, name, 'asiguratA')).toBe(value);
    expect(elements(xml, 'angajatorA').slice(-2)).toEqual([
      '<angajatorA A_codOblig="458" A_codBugetar="5503XXXXXX" A_datorat="456" A_deductibil="0" A_scutit="0" A_plata="456"/>',
      '<angajatorA A_codOblig="459" A_codBugetar="5503XXXXXX" A_datorat="183" A_deductibil="0" A_scutit="0" A_plata="183"/>',
    ]);
    const exempt = writeD112(
      model([{ ...partTime(), minimum: { kind: 'exempt', reason: 'other_contracts' } }]),
    );
    expect(attribute(exempt, 'asigExc', 'asigurat')).toBe('1');
    expect(attribute(exempt, 'motivExc', 'asigurat')).toBe('5');
    expect(attribute(exempt, 'A_13P', 'asiguratA')).toBe('0');
  });

  test('writes vouchers within the gross income and E2 outside the main job', () => {
    const xml = writeD112(model([vouchers]));
    expect(attribute(xml, 'A_sal2', 'asiguratA')).toBe('6800');
    expect(elements(xml, 'asiguratE3')[0]).toContain(
      'E3_8="6800" E3_60="800" E3_10="800" E3_9="2180"',
    );
    const holiday = writeD112(
      model([
        employee({
          income: {
            mainJob: false,
            holidayVouchers: 300,
            deduction: { basic: 0, young: 0, children: 0 },
            taxBase: 3550,
            tax: 355,
          },
        }),
      ]),
    );
    expect(elements(holiday, 'asiguratE3')[0]).toContain(
      'E3_3="2" E3_4="P" E3_8="5300" E3_60="300" E3_75="300"',
    );
    expect(elements(holiday, 'asiguratE1')).toEqual([]);
    expect(elements(holiday, 'asiguratE2')).toEqual([
      '<asiguratE2 E2_1="5300" E2_2="1750" E2_3="3550" E2_4="355"/>',
    ]);
  });

  test('writes the supplementary deductions under art. 77 alin. (10)', () => {
    const young = writeD112(
      model([
        employee({
          cnp: '6010101400071',
          income: { dependents: 1, deduction: { basic: 778, young: 649, children: 100 } },
        }),
      ]),
    );
    expect(elements(young, 'asiguratE1')[0]).toContain(
      'E1_3="1" E1_4="1527" E1_41="778" E1_42="749" E1_421="649" E1_422="100"',
    );
    expect(elements(young, 'asiguratE3')[0]).toContain(
      'E3_11="1" E3_12="1527" E3_121="778" E3_122="749" E3_1221="649" E3_1222="100"',
    );
  });

  test('writes the identification options and escapes text', () => {
    const xml = writeD112(
      model(
        [
          employee({
            until: '2026-10-31',
            healthFund: 'RO-B',
            employment: { pensioner: true, unemploymentBase: 0 },
          }),
          employee({ cnp: '2960811170089', healthFund: 'OPSNAJ', unemploymentInsured: false }),
        ],
        {
          correction: true,
          reason: '9',
          employer: {
            cui: '18547290',
            successorCui: '14399840',
            tradeRegister: 'J17/123/2020',
            caen: '6201',
            name: 'Exemplu & "Fiul" SRL',
            registeredOffice: {
              address: 'Str. Lungă nr. 10',
              phone: '0236000000',
              fax: '0236000001',
              email: 'office@exemplu.ro',
            },
            fiscalDomicile: { address: 'Str. Scurtă nr. 2', email: 'fiscal@exemplu.ro' },
            healthFund: 'RO-B',
          },
        },
      ),
    );
    expect([attribute(xml, 'd_rec'), attribute(xml, 'tip_rec')]).toEqual(['1', '9']);
    const employer = elements(xml, 'angajator')[0]!;
    expect(employer).toContain(
      'cif="18547290" cifS="14399840" rgCom="J17/123/2020" caen="6201" den="Exemplu &amp; &quot;Fiul&quot; SRL"',
    );
    expect(employer).toContain(
      'telSoc="0236000000" faxSoc="0236000001" mailSoc="office@exemplu.ro" adrFisc="Str. Scurtă nr. 2" mailFisc="fiscal@exemplu.ro" casaAng="_B"',
    );
    const [first, second] = elements(xml, 'asigurat');
    expect(first).toContain('dataAng="01.09.2023" dataSf="31.10.2026" casaSn="_B"');
    expect(attribute(first!, 'A_2', 'asigurat')).toBeUndefined();
    expect(attribute(elements(xml, 'asiguratA')[0]!, 'A_2', 'asiguratA')).toBe('1');
    expect(second).toContain('casaSn="_A" asigCI="1" asigSO="2"');
    expect(attribute(xml, 'B_cnp', 'angajatorB')).toBe('0');
  });

  test('refuses an unknown health fund or date and is deterministic', () => {
    expect(() => writeD112(model([employee({ healthFund: 'RO-XX' })]))).toThrow('RO-XX');
    expect(() => writeD112(model([employee({ from: '01.09.2023' })]))).toThrow('AAAA-LL-ZZ');
    const value = model([partTime(), vouchers]);
    expect(writeD112(value)).toBe(writeD112(structuredClone(value)));
  });
});

describe('D112 checks', () => {
  test('pass for consistent declarations', () => {
    expect(checkD112(model())).toEqual([]);
    expect(checkD112(model([minimumWage]))).toEqual([]);
    expect(checkD112(model([vouchers]))).toEqual([]);
    expect(checkD112(model([partTime(4125), employee()]))).toEqual([]);
  });

  test('warn when the limit sum differs from the structure’s, and refuse one below it', () => {
    expect(checkD112(model([partTime()]))).toEqual([
      {
        code: 'D112_MINIMUM_BASE',
        severity: 'warning',
        path: 'insured.0.minimum.base',
        message:
          'Structura ANAF calculează suma limită ca (4325 − 200) lei × 22 / 22 zile = 4125 lei, nu 4325; validatorul acceptă orice sumă de cel puțin 4124 lei.',
      },
    ]);
    expect(codes(model([partTime(4124)]))).toEqual(['warning:D112_MINIMUM_BASE']);
    expect(codes(model([partTime(4123)]))).toEqual(['error:D112_MINIMUM']);
    // 21 of 22 days: 4125 × 21 / 22 = 3937.5, rounded 3938, truncated 3937 by the validator.
    const fewer = (base: number) =>
      model([
        {
          ...partTime(base),
          employment: { ...partTime().employment, daysWorked: 21, hoursWorked: 84 },
        },
      ]);
    expect(codes(fewer(3938))).toEqual([]);
    expect(codes(fewer(3936))).toEqual(['warning:D112_MINIMUM_BASE']);
    expect(codes(fewer(3935))).toEqual(['error:D112_MINIMUM']);
  });

  test('require the minimum-contribution flags for part time below the minimum', () => {
    const { minimum: _minimum, ...withoutMinimum } = partTime();
    expect(codes(model([withoutMinimum]))).toEqual(['error:D112_MINIMUM']);
    expect(
      codes(model([{ ...partTime(), minimum: { kind: 'exempt', reason: 'pensioner' } }])),
    ).toEqual([]);
    // Neexceptarea only while the CAS base is below the limit sum.
    expect(codes(model([employee({ minimum: { kind: 'due', base: 4125 } })]))).toEqual([
      'error:D112_MINIMUM',
    ]);
    // Within 3 lei of the minimum the validator asks for nothing.
    const near = employee({
      employment: {
        contract: 'P7',
        hoursWorked: 154,
        casBase: 4122,
        cas: 1031,
        cassBase: 4122,
        cass: 412,
      },
    });
    expect(codes(model([near]))).toEqual([]);
  });

  test('match the declaration type to a correction', () => {
    expect(codes(model(undefined, { reason: '3' }))).toEqual([]);
    expect(codes(model(undefined, { reason: '9' }))).toEqual(['error:D112_REASON']);
    expect(codes(model(undefined, { correction: true, reason: '9' }))).toEqual([]);
    expect(codes(model(undefined, { correction: true, reason: '7' }))).toEqual([
      'error:D112_REASON',
    ]);
    expect(codes(model(undefined, { reason: '6' as '5' }))).toEqual(['error:D112_REASON']);
    expect(codes(model(undefined, { period: { year: 2027, month: 1 } }))).toEqual([
      'error:D112_PERIOD',
    ]);
  });

  test('check the declarant and the employer', () => {
    const checks = checkD112(
      model(undefined, {
        declarant: { lastName: ' ', firstName: 'A'.repeat(76), role: 'Administrator' },
        employer: {
          cui: 'RO18547290',
          successorCui: '14399841',
          tradeRegister: 'J17/123/2020/0001',
          caen: '62',
          name: '',
          registeredOffice: { address: '', email: 'office@' },
          fiscalDomicile: { phone: '0'.repeat(16) },
          healthFund: 'OPSNAJ',
        },
      }),
    );
    expect(checks.map((check) => `${check.severity}:${check.code}:${check.path}`)).toEqual([
      'error:D112_TEXT:declarant.lastName',
      'error:D112_TEXT:declarant.firstName',
      'error:D112_CUI:employer.cui',
      'error:D112_CUI:employer.successorCui',
      'error:D112_TEXT:employer.tradeRegister',
      'error:D112_CAEN:employer.caen',
      'error:D112_TEXT:employer.name',
      'error:D112_TEXT:employer.registeredOffice.address',
      'warning:D112_EMAIL:employer.registeredOffice.email',
      'error:D112_TEXT:employer.fiscalDomicile.phone',
      'error:D112_HEALTH_FUND:employer.healthFund',
    ]);
    expect(codes(model([]))).toEqual(['error:D112_INSURED']);
  });

  test('check the insured person’s identity, dates and health fund', () => {
    const one = (patch: Patch) => codes(model([employee(patch)]));
    expect(one({ cnp: '1781105170031' })).toEqual(['error:D112_CNP']);
    expect(one({ cnp: '5150601170058' })).toEqual(['error:D112_CNP']);
    // Fifteen years old in November 2026, not in October.
    expect(one({ cnp: '5111101170066' })).toEqual(['error:D112_CNP']);
    expect(
      codes(
        model(
          [employee({ cnp: '5111101170066', employment: { hoursWorked: 160, daysWorked: 20 } })],
          {
            period: { year: 2026, month: 11 },
          },
        ),
      ),
    ).toEqual([]);
    expect(codes(model([employee(), employee()]))).toEqual(['error:D112_CNP']);
    expect(one({ lastName: '', firstName: 'B'.repeat(76) })).toEqual([
      'error:D112_TEXT',
      'error:D112_TEXT',
    ]);
    expect(one({ from: '2026-11-01' })).toEqual(['error:D112_DATE']);
    expect(one({ from: '2026-02-30' })).toEqual(['error:D112_DATE']);
    expect(one({ until: '2023-08-31' })).toEqual(['error:D112_DATE']);
    expect(one({ until: '2026-11-02' })).toEqual(['error:D112_DATE']);
    expect(one({ until: '2026-10-31' })).toEqual([]);
    expect(one({ healthFund: 'RO-XX' })).toEqual(['error:D112_HEALTH_FUND']);
    expect(one({ healthFund: 'OPSNAJ' })).toEqual([]);
  });

  test('check hours and days against the month and the contract', () => {
    const work = (employment: Patch['employment']) => codes(model([employee({ employment })]));
    expect(work({ hoursWorked: 177 })).toEqual(['error:D112_HOURS']);
    expect(work({ hoursWorked: 170, hoursSuspended: 8 })).toEqual(['error:D112_HOURS']);
    expect(work({ daysWorked: 23 })).toEqual(['error:D112_DAYS']);
    expect(work({ contract: 'P4', hoursWorked: 89 })).toEqual(['error:D112_HOURS']);
    expect(work({ contract: 'P6', normHours: 6, hoursWorked: 132 })).toEqual([
      'error:D112_CONTRACT',
    ]);
    expect(work({ normHours: 7, hoursWorked: 154 })).toEqual([]);
    expect(work({ hoursWorked: 0, hoursSuspended: 0 })).toEqual([
      'error:D112_HOURS',
      'warning:D112_UNEMPLOYMENT',
    ]);
    expect(work({ unemploymentBase: 0 })).toEqual(['warning:D112_UNEMPLOYMENT']);
    expect(work({ pensioner: true })).toEqual(['error:D112_UNEMPLOYMENT']);
    expect(work({ pensioner: true, unemploymentBase: 0 })).toEqual([]);
  });

  test('check the bases and contributions as the validator rounds them', () => {
    const work = (employment: Patch['employment']) => codes(model([employee({ employment })]));
    expect(work({ cas: 1252 })).toEqual([]);
    expect(work({ cas: 1253 })).toEqual(['error:D112_CAS']);
    expect(work({ cas: 1247 })).toEqual(['error:D112_CAS']);
    expect(work({ cass: 499 })).toEqual([]);
    expect(work({ cass: 498 })).toEqual(['error:D112_CASS']);
    expect(work({ cass: 503 })).toEqual(['error:D112_CASS']);
    expect(work({ casBase: 0, cas: 0 })).toEqual(['error:D112_CAS']);
    expect(work({ daysWorked: 0, hoursWorked: 0, hoursSuspended: 176 })).toEqual([
      'warning:D112_UNEMPLOYMENT',
      'warning:D112_DAYS',
    ]);
    expect(work({ cassBase: 0, cass: 0 })).toEqual(['warning:D112_CASS', 'warning:D112_CAS']);
    expect(work({ camBase: 0 })).toEqual(['warning:D112_CAM']);
  });

  test('check the minimum-wage relief and type 51', () => {
    const work = (employment: Patch['employment'], income: Patch['income'] = {}) =>
      codes(
        model([
          {
            ...minimumWage,
            employment: { ...minimumWage.employment, ...employment },
            income: { ...minimumWage.income, ...income },
          },
        ]),
      );
    expect(work({ type: '1' })).toEqual(['error:D112_RELIEF']);
    expect(work({ relief: 250 })).toEqual(['warning:D112_RELIEF']);
    expect(work({ contract: 'P4', hoursWorked: 88 })).toEqual(['error:D112_TYPE']);
    expect(work({}, { mainJob: false, deduction: { basic: 0, young: 0, children: 0 } })).toEqual([
      'error:D112_MAIN_JOB',
    ]);
  });

  test('check the income tax fields', () => {
    const income = (patch: Patch['income']) => codes(model([employee({ income: patch })]));
    expect(income({ mainJob: false })).toEqual(['error:D112_MAIN_JOB']);
    expect(income({ mainJob: false, deduction: { basic: 0, young: 0, children: 0 } })).toEqual([]);
    expect(income({ tax: 2689 })).toEqual(['error:D112_TAX']);
    expect(income({ taxBase: 5001, tax: 269 })).toEqual(['warning:D112_TAX']);
  });

  test('report what calculateD112 refuses, path by path', () => {
    const checks = checkD112(
      model([
        employee({ employment: { type: '25' as '1', cas: 1.5 } }),
        employee({ cnp: '2960811170089', income: { tax: -5 } }),
      ]),
    );
    expect(checks.map((check) => `${check.code}:${check.path}`)).toEqual([
      'D112_TYPE:insured.0.employment.type',
      'D112_AMOUNT:insured.0.employment.cas',
      'D112_AMOUNT:insured.1.income.tax',
    ]);
  });

  test('report totals beyond 15 digits', () => {
    const huge = (cnp: string) => employee({ cnp, employment: { camBase: 999_999_999_999_999 } });
    expect(codes(model([huge('1781105170030'), huge('2960811170089')]))).toContain(
      'error:D112_TOTAL',
    );
  });
});
