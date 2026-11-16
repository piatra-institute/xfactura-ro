import { describe, expect, test } from 'bun:test';
import { SaxesParser } from 'saxes';
import { DomainError } from '../src/errors';
import { writeS1003 } from '../src/ro/annual/s1003';
import { writeS1005 } from '../src/ro/annual/s1005';
import { writeS1046 } from '../src/ro/annual/s1046';
import { writeD100 } from '../src/ro/declarations/d100';
import { d101Rows, deriveD101Rows, writeD101, type D101Rows } from '../src/ro/declarations/d101';
import { writeD112 } from '../src/ro/declarations/d112';
import { writeD204 } from '../src/ro/declarations/d204';
import { writeD205 } from '../src/ro/declarations/d205';
import { writeD207 } from '../src/ro/declarations/d207';
import { writeD212, type D212 } from '../src/ro/declarations/d212';
import { writeD300 } from '../src/ro/declarations/d300';
import { writeD301 } from '../src/ro/declarations/d301';
import { writeD390 } from '../src/ro/declarations/d390';
import { writeD394 } from '../src/ro/declarations/d394';
import { writeD398 } from '../src/ro/declarations/d398';
// Use the public export that consumers will import.
import { declarationForms, fieldMap, readDeclaration } from 'xfactura-core/ro/declarations/read';
import { consultingStatements } from './fixtures/s1003';
import { servicesStatements, startupStatements } from './fixtures/s1005';

const bytes = (xml: string) => new TextEncoder().encode(xml);
const read = (xml: string) => readDeclaration(bytes(xml));
const cui = '18547290';
const cnp = '1781105170030';
const declarant = { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' };
const company = { cui, name: 'Exemplu Servicii SRL', address: 'Str. Lungă nr. 10, Galați' };
const xsi = 'http://www.w3.org/2001/XMLSchema-instance';

function errorCode(xml: string): string {
  try {
    read(xml);
    throw new Error('Expected a declaration error.');
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return error.code;
  }
}

/** Count XML content independently of the reader's tree traversal and path construction. */
function contentFieldCount(xml: string): number {
  let count = 0;
  const stack: { hasChildren: boolean; hasText: boolean }[] = [];
  const parser = new SaxesParser({ xmlns: true });
  parser.on('opentag', (tag) => {
    if (stack.length) stack.at(-1)!.hasChildren = true;
    stack.push({ hasChildren: false, hasText: false });
    count += Object.values(tag.attributes).filter(
      (attribute) => attribute.uri !== 'http://www.w3.org/2000/xmlns/',
    ).length;
  });
  const text = (value: string) => {
    if (value.length && stack.length) stack.at(-1)!.hasText = true;
  };
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('closetag', () => {
    const node = stack.pop()!;
    if (!node.hasChildren && node.hasText) count++;
  });
  parser.write(xml).close();
  return count;
}

// Inputs reused from the respective writers' unit tests; all identities and amounts are synthetic.
const d212: D212 = {
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
  cas: { base: 97_200, due: 24_300 },
  cassException: false,
  cass: { base: 120_000, due: 12_000, minimumDifference: 0 },
  tax: { deductibleCas: 24_300, deductibleCass: 12_000, due: 8370 },
};

type WriterCase = {
  form: keyof typeof declarationForms;
  version: number;
  year: string;
  month: string;
  fiscalCode?: string;
  rectifying: 'input' | false | null;
  expectedFields?: Record<string, string>;
  write: (rectifying: boolean) => string;
};

const writers: WriterCase[] = [
  {
    form: 'D300',
    version: 12,
    year: '2026',
    month: '9',
    rectifying: null,
    expectedFields: {
      'declaratie300/@totalPlata_A': '4155',
      'declaratie300/@R9_1': '1000',
      'declaratie300/@R9_2': '210',
    },
    write: () =>
      writeD300({
        period: { year: 2026, month: 9 },
        type: 'L',
        company: {
          ...company,
          bank: 'Banca Exemplu',
          account: 'RO49AAAA1B31007593840000',
          caen: '6201',
        },
        declarant,
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
        rows: { R9_1: 1000, R9_2: 210, R22_1: 500, R22_2: 105, R28_2: 105 },
      }),
  },
  {
    form: 'D301',
    version: 1,
    year: '2026',
    month: '10',
    rectifying: 'input',
    write: (rectifying) =>
      writeD301({
        period: { year: 2026, month: 10 },
        rectification: rectifying,
        afterReserveCancellation: 0,
        company: { cif: cui, name: 'Exemplu', bank: 'Trezoreria', account: 'RO12TREZ' },
        registeredArt317: true,
        declarant,
        lines: [4, 5].map((section) => ({
          section: section as 4 | 5,
          number: 'FB-1',
          date: '2026-10-15',
          currencyValue: '1000.00',
          currency: 'EUR',
          rate: '5.0912',
          baseBani: 509100n,
          vatBani: 106900n,
        })),
      }),
  },
  {
    form: 'D390',
    version: 3,
    year: '2026',
    month: '10',
    rectifying: 'input',
    write: (rectifying) =>
      writeD390({
        period: { year: 2026, month: 10 },
        rectification: rectifying,
        declarant,
        company,
        operations: [
          { type: 'S', country: 'IE', code: '6388047V', name: 'Supplier Limited', base: 498 },
          { type: 'P', country: 'DE', code: '123456788', name: 'Kunde GmbH', base: 150 },
        ],
      }),
  },
  {
    form: 'D394',
    version: 5,
    year: '2026',
    month: '9',
    rectifying: null,
    expectedFields: {
      'declaratie394/op1[1]/@cuiP': '14399840',
      'declaratie394/op1[1]/@tva': '2100',
      'declaratie394/op1[2]/@cuiP': '13548146',
      'declaratie394/op1[2]/@baza': '4000',
    },
    write: () =>
      writeD394({
        period: { year: 2026, month: 9 },
        type: 'L',
        company: { ...company, caen: '6201', phone: '0236000000' },
        representative: { name: 'Popescu Ana', role: 'Administrator', address: 'Str. Lungă 10' },
        preparer: { kind: 'company', cui, name: company.name, capacity: 'Administrator' },
        consultation: false,
        affiliates: false,
        operations: [
          {
            type: 'L',
            rate: '21',
            partner: { kind: 'registered', cui: '14399840', name: 'Client Unu SRL' },
            invoices: 2,
            base: 10000,
            vat: 2100,
          },
          {
            type: 'L',
            rate: '21',
            partner: { kind: 'registered', cui: '13548146', name: 'Client Doi SRL' },
            invoices: 1,
            base: 4000,
            vat: 840,
          },
        ],
        simplified: {},
        series: [
          { type: 'allocated', series: 'XF', first: '1', last: '99999' },
          { type: 'issued', series: 'XF', first: '101', last: '103' },
        ],
        issuedInvoices: { own: 3, byBeneficiaries: 0, byThirdParties: 0 },
        invoices: [],
        cashVatDeductible: {},
      }),
  },
  {
    form: 'D100',
    version: 2,
    year: '2026',
    month: '9',
    rectifying: null,
    write: () =>
      writeD100({
        period: { year: 2026, month: 9 },
        afterReserveCancellation: false,
        dissolution: false,
        declarant,
        payer: company,
        obligations: [{ kind: 'micro', tax: 1200 }],
      }),
  },
  {
    form: 'D101',
    version: 10,
    year: '2026',
    month: '12',
    rectifying: 'input',
    write: (rectifying) =>
      writeD101({
        period: { from: '2026-01-01', to: '2026-12-31' },
        microExitQuarter: null,
        rectifying,
        afterReserveCancellation: null,
        declarant,
        payer: { ...company, caen: '6201' },
        rows: deriveD101Rows(Object.fromEntries(d101Rows.map((row) => [row, 0n])) as D101Rows),
      }),
  },
  {
    form: 'D112',
    version: 7,
    year: '2026',
    month: '10',
    rectifying: 'input',
    write: (rectifying) =>
      writeD112({
        period: { year: 2026, month: 10 },
        correction: rectifying,
        declarant,
        employer: {
          cui,
          caen: '6201',
          name: company.name,
          registeredOffice: { address: company.address },
          healthFund: 'RO-GL',
        },
        insured: [
          {
            cnp,
            lastName: 'Dumitrescu',
            firstName: 'Andrei',
            from: '2023-09-01',
            healthFund: 'RO-GL',
            sickLeaveInsured: true,
            unemploymentInsured: true,
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
            },
          },
        ],
      }),
  },
  {
    form: 'D205',
    version: 3,
    year: '2026',
    month: '12',
    rectifying: 'input',
    write: (rectifying) =>
      writeD205({
        year: 2026,
        correction: rectifying,
        declarant,
        payer: company,
        paidAs: 'gross',
        beneficiaries: [
          {
            kind: 'individual',
            cnp,
            name: 'Dumitrescu Andrei',
            payments: [{ date: '2026-06-15', distributed: '2026-04-20', gross: 30000, tax: 4800 }],
            unpaid: [],
          },
        ],
      }),
  },
  {
    form: 'D207',
    version: 2,
    year: '2026',
    month: '12',
    rectifying: 'input',
    write: (rectifying) =>
      writeD207({
        year: 2026,
        correction: rectifying,
        declarant,
        payer: company,
        beneficiaries: [
          {
            name: 'Software GmbH',
            state: 'DE',
            foreignId: 'DE123456789',
            incomeType: '03',
            act: 1,
            payments: [{ date: '2026-03-20', base: 4000, tax: 640 }],
          },
          {
            name: 'Lender BV',
            state: 'NL',
            incomeType: '19',
            act: 2,
            payments: [{ date: '2026-06-30', base: 1500, tax: 0 }],
          },
        ],
      }),
  },
  {
    form: 'D212',
    version: 11,
    year: '2026',
    month: '12',
    fiscalCode: cnp,
    rectifying: 'input',
    write: (rectifying) => writeD212({ ...d212, rectifies: { income: rectifying, option: false } }),
  },
  {
    form: 'D212',
    version: 11,
    year: '2025',
    month: '12',
    fiscalCode: cnp,
    rectifying: 'input',
    write: (rectifying) =>
      writeD212({
        ...d212,
        year: 2024,
        rectifies: { income: rectifying, option: false },
        cas: { base: 79_200, due: 19_800 },
        tax: { deductibleCas: 19_800, deductibleCass: 12_000, due: 8820 },
      }),
  },
  {
    form: 'D204',
    version: 3,
    year: '2025',
    month: '12',
    fiscalCode: '12345674',
    rectifying: 'input',
    write: (rectifying) =>
      writeD204({
        year: 2025,
        rectifies: rectifying,
        association: {
          name: 'Popescu Ion Întreprindere Familială',
          cif: '12345674',
          address: 'Galați',
        },
        representative: {
          name: 'Popescu Ion',
          cnp: '1750312170031',
          address: 'Str. Morii 3, Galați',
        },
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
          { name: 'Popescu Ion', cnp: '1750312170031', quotaBp: 6000, net: 27_593, loss: 0 },
          { name: 'Popescu Maria', cnp: '2800911170044', quotaBp: 4000, net: 18_395, loss: 0 },
        ],
      }),
  },
  {
    form: 'D398',
    version: 1,
    year: '2026',
    month: '9',
    fiscalCode: `RO${cui}`,
    rectifying: false,
    write: () =>
      writeD398({
        period: { year: 2026, month: 9 },
        vatId: cui,
        name: 'Exemplu Digital SRL',
        supplies: [
          {
            state: 'DE',
            type: 'services',
            rateType: 'standard',
            rate: '19',
            taxableCents: 100000n,
            vatCents: 19000n,
          },
        ],
        corrections: [{ state: 'DE', year: 2026, month: 6, vatCents: -1900n }],
      }),
  },
  {
    form: 'S1005',
    version: 15,
    year: '2025',
    month: '12',
    rectifying: null,
    expectedFields: {
      'Bilant1005/F10/@F10_0021': '5000',
      'Bilant1005/F10/@F10_0022': '11500',
    },
    write: () => writeS1005(servicesStatements()),
  },
  {
    form: 'S1005',
    version: 15,
    year: '2025',
    month: '12',
    fiscalCode: '14399840',
    rectifying: null,
    write: () => writeS1005(startupStatements()),
  },
  {
    form: 'S1003',
    version: 15,
    year: '2025',
    month: '12',
    fiscalCode: '14399840',
    rectifying: null,
    expectedFields: {
      'Bilant1003/F10/@F10_0021': '90000',
      'Bilant1003/F10/@F10_0022': '60000',
    },
    write: () => writeS1003(consultingStatements()),
  },
  {
    form: 'S1046',
    version: 1,
    year: '2025',
    month: '12',
    rectifying: null,
    write: () =>
      writeS1046({
        year: 2025,
        yearEnd: '2025-12-31',
        entityKind: 1,
        entity: {
          cui,
          name: 'Exemplu Inactiv SRL',
          address: { locality: 'Galați' },
          tradeRegister: 'J17/123/2024',
          county: 17,
          largeTaxpayer: false,
        },
        capital: 200,
        declarant: 'Popescu Ana',
      }),
  },
];

describe('every declaration writer reads back', () => {
  for (const writer of writers) {
    for (const rectifying of writer.rectifying === 'input' ? [false, true] : [false]) {
      test(`${writer.form} v${writer.version}, ${writer.year}/${writer.month}, rectifying=${rectifying}`, () => {
        const xml = writer.write(rectifying);
        const declaration = read(xml);
        const { fields, ...header } = declaration;
        expect(header).toMatchObject({
          form: writer.form,
          version: writer.version,
          period: { year: writer.year, month: writer.month, quarter: null },
          fiscalCode: writer.fiscalCode ?? cui,
          rectifying: writer.rectifying === 'input' ? rectifying : writer.rectifying,
        });
        expect(fields).toHaveLength(contentFieldCount(xml));
        const indexed = fieldMap(declaration);
        expect(indexed.size).toBe(fields.length);
        for (const [path, value] of Object.entries(writer.expectedFields ?? {}))
          expect(indexed.get(path)).toBe(value);
        expect(fields.some((field) => field.path.includes('@xmlns'))).toBe(false);
        expect(fields.some((field) => field.path.includes('http://www.w3.org/2000/xmlns/'))).toBe(
          false,
        );
      });
    }
  }

  test('the descriptor table covers exactly the writers plus D700 and D710', () => {
    expect(Object.keys(declarationForms).sort()).toEqual(
      [...new Set([...writers.map((writer) => writer.form), 'D700', 'D710'])].sort(),
    );
  });
});

describe('earlier namespaces and header layouts', () => {
  const older = [
    {
      xml: '<declaratie300 xmlns="mfp:anaf:dgti:d300:declaratie:v1" an="2011" luna="01" cui="0012345674" totalPlata_A="000.00"/>',
      form: 'D300',
      version: 1,
      year: '2011',
      month: '01',
      fiscalCode: '0012345674',
      rectifying: null,
      expectedFields: {
        'declaratie300/@cui': '0012345674',
        'declaratie300/@totalPlata_A': '000.00',
      },
    },
    {
      xml: '<declaratie394 xmlns="mfp:anaf:dgti:d394:declaratie:v1" an="2011" luna="06"><identificare cui="12345674"/><op1 cuiP="11111111"/><op1 cuiP="22222222"/><op1 cuiP="33333333"/></declaratie394>',
      form: 'D394',
      version: 1,
      year: '2011',
      month: '06',
      fiscalCode: '12345674',
      rectifying: null,
      expectedFields: {
        'declaratie394/identificare/@cui': '12345674',
        'declaratie394/op1[3]/@cuiP': '33333333',
      },
    },
    {
      xml: '<declaratie390 xmlns="mfp:anaf:dgti:d390:declaratie:v1" an="2012" luna="03" cui="12345674" d_rec="1"/>',
      form: 'D390',
      version: 1,
      year: '2012',
      month: '03',
      fiscalCode: '12345674',
      rectifying: true,
      expectedFields: { 'declaratie390/@luna': '03', 'declaratie390/@d_rec': '1' },
    },
    {
      xml: '<declaratieUnica xmlns="mfp:anaf:dgti:declaratie_unica:declaratie:v1" an_r="2011" luna_r="02" d_rec="0"><angajator cif="12345674"/><asigurat cnp="9999999999999"/></declaratieUnica>',
      form: 'D112',
      version: 1,
      year: '2011',
      month: '02',
      fiscalCode: '12345674',
      rectifying: false,
      expectedFields: {
        'declaratieUnica/@luna_r': '02',
        'declaratieUnica/angajator/@cif': '12345674',
      },
    },
    {
      xml: '<declaratie100 xmlns="mfp:anaf:dgti:d100:declaratie:v1" an="2013" luna="09" cui="12345674"/>',
      form: 'D100',
      version: 1,
      year: '2013',
      month: '09',
      fiscalCode: '12345674',
      rectifying: null,
      expectedFields: { 'declaratie100/@luna': '09', 'declaratie100/@cui': '12345674' },
    },
    {
      xml: '<declaratie205 xmlns="mfp:anaf:dgti:d205:declaratie:v1" an="2014" luna="12" cui="12345674" d_rec="1"/>',
      form: 'D205',
      version: 1,
      year: '2014',
      month: '12',
      fiscalCode: '12345674',
      rectifying: true,
      expectedFields: { 'declaratie205/@an': '2014', 'declaratie205/@d_rec': '1' },
    },
    {
      xml: '<declaratie101 xmlns="mfp:anaf:dgti:d101:declaratie:v2" an="2012" luna="12" cif="12345674" d_rec="0"/>',
      form: 'D101',
      version: 2,
      year: '2012',
      month: '12',
      fiscalCode: '12345674',
      rectifying: false,
      expectedFields: { 'declaratie101/@cif': '12345674', 'declaratie101/@d_rec': '0' },
    },
    {
      xml: '<Bilant1003 xmlns="mfp:anaf:dgti:s1003:declaratie:v1" an="2011" luna="12" cui="12345674"><F10 F10_0011="000"/></Bilant1003>',
      form: 'S1003',
      version: 1,
      year: '2011',
      month: '12',
      fiscalCode: '12345674',
      rectifying: null,
      expectedFields: { 'Bilant1003/@an': '2011', 'Bilant1003/F10/@F10_0011': '000' },
    },
    {
      xml: '<Bilant1005 xmlns="mfp:anaf:dgti:s1005:declaratie:v3" an="2014" luna="12" cui="12345674"><F20 F20_0011="000.00"/></Bilant1005>',
      form: 'S1005',
      version: 3,
      year: '2014',
      month: '12',
      fiscalCode: '12345674',
      rectifying: null,
      expectedFields: { 'Bilant1005/@an': '2014', 'Bilant1005/F20/@F20_0011': '000.00' },
    },
  ];
  for (const fixture of older) {
    test(`${fixture.form} v${fixture.version} retains its filed header`, () => {
      const declaration = read(fixture.xml);
      expect(declaration).toMatchObject({
        form: fixture.form,
        version: fixture.version,
        period: { year: fixture.year, month: fixture.month, quarter: null },
        fiscalCode: fixture.fiscalCode,
        rectifying: fixture.rectifying,
      });
      expect(declaration.fields).toHaveLength(contentFieldCount(fixture.xml));
      const indexed = fieldMap(declaration);
      for (const [path, value] of Object.entries(fixture.expectedFields))
        expect(indexed.get(path)).toBe(value);
      expect(
        declaration.fields.some((field) => field.path.includes('http://www.w3.org/2000/xmlns/')),
      ).toBe(false);
    });
  }

  test('namespace version wins over a different schema location version', () => {
    const schema = 'mfp:anaf:dgti:d300:declaratie:v11  D300.xsd';
    const declaration = read(
      `<declaratie300 xmlns="mfp:anaf:dgti:d300:declaratie:v12" xmlns:xsi="${xsi}" xsi:schemaLocation="${schema}" an="2026" luna="1" cui="12345674"/>`,
    );
    expect(declaration.version).toBe(12);
    expect(declaration.namespace).toBe('mfp:anaf:dgti:d300:declaratie:v12');
    expect(declaration.schemaLocation).toBe(schema);
    expect(fieldMap(declaration).get(`declaratie300/@{${xsi}}schemaLocation`)).toBe(schema);
  });

  test('D700 and D710 read identity/period without inferring a rectification flag', () => {
    for (const [form, root, version, attribute] of [
      ['D700', 'D700', 4, 'cif'],
      ['D710', 'declaratie710', 2, 'cui'],
    ] as const) {
      expect(
        read(
          `<${root} xmlns="mfp:anaf:dgti:${form.toLowerCase()}:declaratie:v${version}" an="2024" luna="03" ${attribute}="0012345674" d_rec="1"/>`,
        ),
      ).toMatchObject({
        form,
        version,
        root,
        period: { year: '2024', month: '03', quarter: null },
        fiscalCode: '0012345674',
        rectifying: null,
      });
    }
  });

  test('a reported last month stays a month; absent month/flag stay unknown', () => {
    const declaration = read(
      '<declaratie300 xmlns="mfp:anaf:dgti:d300:declaratie:v12" an="2026" luna="03" tip_decont="T"/>',
    );
    expect(declaration.period).toEqual({ year: '2026', month: '03', quarter: null });
    const yearly = read('<d205 xmlns="mfp:anaf:dgti:d205:declaratie:v1" an="2011"/>');
    expect(yearly.period).toEqual({ year: '2011', month: null, quarter: null });
    expect(yearly.fiscalCode).toBeNull();
    expect(yearly.rectifying).toBeNull();
  });

  test('conflicting identities and unfamiliar flag strings stay unknown', () => {
    expect(
      read(
        '<d394 xmlns="mfp:anaf:dgti:d394:declaratie:v5" cui="11111111"><identificare cui="22222222"/></d394>',
      ).fiscalCode,
    ).toBeNull();
    expect(
      read(
        '<d112 xmlns="mfp:anaf:dgti:d112:declaratie:v7" d_rec="2"><angajator cif="11111111"/><angajator cif="22222222"/></d112>',
      ),
    ).toMatchObject({
      form: 'D112',
      fiscalCode: null,
      rectifying: null,
    });
  });

  test('empty header attributes are unknown while their fields remain empty strings', () => {
    const declaration = read(
      '<declaratie300 xmlns="mfp:anaf:dgti:d300:declaratie:v12" an="2026" luna="" cui=""/>',
    );
    expect(declaration.period).toEqual({ year: '2026', month: null, quarter: null });
    expect(declaration.fiscalCode).toBeNull();
    expect(fieldMap(declaration).get('declaratie300/@luna')).toBe('');
    expect(fieldMap(declaration).get('declaratie300/@cui')).toBe('');

    const empty = read(
      '<d212 xmlns="mfp:anaf:dgti:d212:declaratie:v11" an_r="" luna_r="" cif="" d_rec=""/>',
    );
    expect(empty).toMatchObject({ period: null, fiscalCode: null, rectifying: null });
    expect(fieldMap(empty)).toEqual(
      new Map([
        ['d212/@an_r', ''],
        ['d212/@luna_r', ''],
        ['d212/@cif', ''],
        ['d212/@d_rec', ''],
      ]),
    );
  });

  test('an empty alternative header location does not conflict with a populated one', () => {
    const declaration = read(
      '<d394 xmlns="mfp:anaf:dgti:d394:declaratie:v2" cui=""><identificare cui="0012345674"/></d394>',
    );
    expect(declaration.fiscalCode).toBe('0012345674');
    expect(fieldMap(declaration).get('d394/@cui')).toBe('');
  });

  test('namespace form tokens find descriptors regardless of letter case', () => {
    for (const token of ['D300', 'd300']) {
      const namespace = `mfp:anaf:dgti:${token}:declaratie:v12`;
      expect(
        read(`<declaratie300 xmlns="${namespace}" an="2026" luna="03" cui="0012345674"/>`),
      ).toMatchObject({
        form: 'D300',
        version: 12,
        namespace,
        period: { year: '2026', month: '03', quarter: null },
        fiscalCode: '0012345674',
      });
    }
    expect(
      read(
        '<declaratieUnica xmlns="mfp:anaf:dgti:DECLARATIE_Unica:declaratie:v1" an_r="2011" luna_r="02" d_rec="1"><angajator cif="12345674"/></declaratieUnica>',
      ),
    ).toMatchObject({
      form: 'D112',
      version: 1,
      period: { year: '2011', month: '02', quarter: null },
      fiscalCode: '12345674',
      rectifying: true,
    });
  });
});

describe('field paths and unmodified string values', () => {
  test('indexes repeated siblings from 1, independently under each parent, in document order', () => {
    const declaration =
      read(`<declaratie394 xmlns="mfp:anaf:dgti:d394:declaratie:v1" totalPlata_A="000.00">
      <op1 cuiP="11111111"><value> 001.2300 </value><value><![CDATA[00.00]]></value></op1>
      <unique flag=""/>
      <op1 cuiP="22222222"><value>−0.00</value></op1>
      <op1 cuiP="33333333"><value> Ștefan &amp; Co </value></op1>
      <empty/><whitespace>  </whitespace>
    </declaratie394>`);
    expect(declaration.fields).toEqual([
      { path: 'declaratie394/@totalPlata_A', value: '000.00' },
      { path: 'declaratie394/op1[1]/@cuiP', value: '11111111' },
      { path: 'declaratie394/op1[1]/value[1]/#text', value: ' 001.2300 ' },
      { path: 'declaratie394/op1[1]/value[2]/#text', value: '00.00' },
      { path: 'declaratie394/unique/@flag', value: '' },
      { path: 'declaratie394/op1[2]/@cuiP', value: '22222222' },
      { path: 'declaratie394/op1[2]/value/#text', value: '−0.00' },
      { path: 'declaratie394/op1[3]/@cuiP', value: '33333333' },
      { path: 'declaratie394/op1[3]/value/#text', value: ' Ștefan & Co ' },
      { path: 'declaratie394/whitespace/#text', value: '  ' },
    ]);
    expect(fieldMap(declaration).size).toBe(10);
  });

  test('expands namespaced attributes and treats prefix aliases as the same namespace', () => {
    const body =
      '<p:item a="01" x:a="02" y:a="03"/><other xmlns="urn:other"><item>04</item><p:item>05</p:item></other>';
    const declaration = read(
      `<p:root xmlns:p="urn:root" xmlns:x="urn:x" xmlns:y="urn:y">${body}</p:root>`,
    );
    expect(declaration.fields).toEqual([
      { path: 'root/item/@a', value: '01' },
      { path: 'root/item/@{urn:x}a', value: '02' },
      { path: 'root/item/@{urn:y}a', value: '03' },
      { path: 'root/other/item[1]/#text', value: '04' },
      { path: 'root/other/item[2]/#text', value: '05' },
    ]);
    const alias = read('<root xmlns="urn:root" xmlns:z="urn:x"><item z:a="02"/></root>');
    expect(fieldMap(alias).get('root/item/@{urn:x}a')).toBe('02');
    expect(declaration.namespace).toBe('urn:root');
    expect(declaration.schemaLocation).toBeNull();
  });

  test('a leaf combines text, CDATA and character references without trimming', () => {
    expect(read('<r> 00<![CDATA[.010]]>&#48;\n</r>').fields).toEqual([
      { path: 'r/#text', value: ' 00.0100\n' },
    ]);
  });

  test('fieldMap rejects duplicates even when both values are identical', () => {
    const declaration = read('<r a="01"/>');
    declaration.fields.push({ path: 'r/@a', value: '01' });
    expect(() => fieldMap(declaration)).toThrow('aceeași cale');
  });
});

describe('unknown namespaces and bounded parsing', () => {
  test('an unknown ANAF form/version keeps every field but has no inferred header', () => {
    expect(
      read(
        '<declaratie999 xmlns="mfp:anaf:dgti:d999:declaratie:v42" an="2030" luna="03" trimestru="1" cui="12345674" d_rec="1"/>',
      ),
    ).toMatchObject({
      form: 'D999',
      version: 42,
      root: 'declaratie999',
      namespace: 'mfp:anaf:dgti:d999:declaratie:v42',
      period: null,
      fiscalCode: null,
      rectifying: null,
    });
  });

  test('a new version of a known form uses the same descriptor', () => {
    expect(
      read(
        '<differentRoot xmlns="mfp:anaf:dgti:d205:declaratie:v99" an="2030" luna="12" cui="0012345674" d_rec="1"/>',
      ),
    ).toMatchObject({
      form: 'D205',
      version: 99,
      root: 'differentRoot',
      period: { year: '2030', month: '12', quarter: null },
      fiscalCode: '0012345674',
      rectifying: true,
    });
  });

  test('non-ANAF and absent namespaces retain the raw namespace and root without guessing', () => {
    for (const namespace of [
      '',
      'urn:d300',
      'https://example.test/mfp:anaf:dgti:d300:declaratie:v12',
    ]) {
      const declaration = read(`<declaratie300 xmlns="${namespace}" an="2026" cui="12345674"/>`);
      expect(declaration).toMatchObject({
        form: null,
        version: null,
        root: 'declaratie300',
        namespace,
        period: null,
        fiscalCode: null,
        rectifying: null,
      });
      expect(fieldMap(declaration).get('declaratie300/@cui')).toBe('12345674');
    }
  });

  test('D406 is refused at its namespace-qualified root, before even malformed entries', () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><ns:AuditFile xmlns:ns="mfp:anaf:dgti:d406:declaratie:v1"><ns:Header/><malformed';
    try {
      read(xml);
      throw new Error('Expected D406 to be refused.');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('DECLARATION_SAFT_UNSUPPORTED');
      expect((error as DomainError).message).toContain('D406');
    }
  });

  test('size is checked before probing oversized comment, DTD and whitespace prologs', () => {
    const root = '<ns:AuditFile xmlns:ns="mfp:anaf:dgti:d406:declaratie:v1"/>';
    const padding = ' '.repeat(11 * 1024 * 1024);
    for (const prolog of [
      `<!--${padding}-->`,
      `<!DOCTYPE ns:AuditFile [<!--${padding}-->]>`,
      padding,
    ])
      expect(errorCode(prolog + root)).toBe('XML_SIZE');
  });

  test('a root beyond the 64 KiB probe is validated fully before D406 is refused', () => {
    const prefix = `<!--${' '.repeat(100 * 1024)}-->`;
    const root = '<ns:AuditFile xmlns:ns="mfp:anaf:dgti:d406:declaratie:v1">';
    expect(errorCode(prefix + root + '<ns:Header/></ns:AuditFile>')).toBe(
      'DECLARATION_SAFT_UNSUPPORTED',
    );
    // This body error proves the long-prolog case falls back to sourceXml before deciding.
    expect(errorCode(prefix + root + '<broken></ns:AuditFile>')).toBe('XML_INVALID');
    expect(errorCode(prefix + root + 'x'.repeat(65537) + '</ns:AuditFile>')).toBe('XML_TEXT');
  });

  test('a root start tag crossing the probe bound also falls back to sourceXml', () => {
    const root = `<ns:AuditFile xmlns:ns="mfp:anaf:dgti:d406:declaratie:v1" padding="${' '.repeat(100 * 1024)}">`;
    expect(errorCode(root + '</ns:AuditFile>')).toBe('DECLARATION_SAFT_UNSUPPORTED');
    expect(errorCode(root + '<broken></ns:AuditFile>')).toBe('XML_INVALID');
  });

  test('D406 does not hide encoding, DTD or root attribute-limit errors', () => {
    const root = '<ns:AuditFile xmlns:ns="mfp:anaf:dgti:d406:declaratie:v1"/>';
    expect(errorCode('<?xml version="1.0" encoding="ISO-8859-1"?>' + root)).toBe('XML_ENCODING');
    expect(errorCode('<!DOCTYPE ns:AuditFile [<!ENTITY x "unused">]>' + root)).toBe('XML_DTD');
    const attributes = Array.from({ length: 2048 }, (_, index) => `a${index}=""`).join(' ');
    expect(
      errorCode(`<ns:AuditFile xmlns:ns="mfp:anaf:dgti:d406:declaratie:v1" ${attributes}/>`),
    ).toBe('XML_COMPLEXITY');
  });

  test('uppercase D406 namespaces are refused too', () => {
    expect(errorCode('<ns:AuditFile xmlns:ns="mfp:anaf:dgti:D406:declaratie:v1"/><broken')).toBe(
      'DECLARATION_SAFT_UNSUPPORTED',
    );
  });

  test('mentioning SAF-T in a comment or an unused prefix does not refuse another form', () => {
    expect(
      read(
        '<!-- mfp:anaf:dgti:d406:declaratie:v1 --><r xmlns:unused="mfp:anaf:dgti:d406:declaratie:v1"/>',
      ).root,
    ).toBe('r');
  });

  test('DTD, size, depth, encoding, text and node limits still reject unsafe XML', () => {
    const inputs = [
      '<!DOCTYPE r [<!ENTITY x "value">]><r>&x;</r>',
      '<?xml version="1.0" encoding="ISO-8859-1"?><r/>',
      '<r>'.repeat(65) + '</r>'.repeat(65),
      `<r>${'x'.repeat(65537)}</r>`,
      `<r>${'<c/>'.repeat(100000)}</r>`,
      '<r><c></r>',
    ];
    for (const xml of inputs) expect(() => read(xml)).toThrow(DomainError);
    expect(() => readDeclaration(new Uint8Array(10 * 1024 * 1024 + 1))).toThrow('limita');
    expect(() => readDeclaration(new Uint8Array([0xff]))).toThrow('UTF-8');
  });
});
