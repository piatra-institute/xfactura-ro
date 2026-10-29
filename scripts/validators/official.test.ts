// Runs the official validation artifacts over the writer's synthetic corpus, and over mutations
// that must be rejected. Without the artifacts (`bun run validators:fetch`), Java or xmllint the
// tests are skipped, never passed.
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { $ } from 'bun';
import {
  calculateInvoice,
  fromInvoicer,
  writeInvoice,
  type InvoiceDraft,
  type InvoicerInvoice,
} from '../../packages/xfactura-core/src/einvoice';
import {
  calculateD112,
  checkD112,
  writeD112,
  type D112,
  type D112Insured,
} from '../../packages/xfactura-core/src/ro/declarations/d112';
import { writeD300, type D300 } from '../../packages/xfactura-core/src/ro/declarations/d300';
import {
  checkD394,
  d394RefundFlags,
  writeD394,
  type D394,
  type D394Operation,
  type D394Partner,
} from '../../packages/xfactura-core/src/ro/declarations/d394';

const root = path.join(import.meta.dir, '../..');
const ready =
  existsSync(path.join(root, '.validators/en16931-ubl/xslt/EN16931-UBL-validation.xslt')) &&
  existsSync(path.join(root, '.validators/ubl-2.1/xsd')) &&
  existsSync(path.join(root, '.validators/saxon/Saxon-HE-12.7.jar')) &&
  Bun.which('java') !== null &&
  Bun.which('xmllint') !== null;
const official = ready ? test : test.skip;

const seller = {
  name: 'Exemplu Servicii SRL',
  vatId: 'RO18547290',
  address: { lines: ['Str. Lungă 10'], city: 'Galați', subdivision: 'RO-GL', country: 'RO' },
};
const buyer = {
  name: 'Client Test SRL',
  vatId: 'RO14399840',
  address: { lines: ['Bd. Unirii 5'], city: 'SECTOR3', subdivision: 'RO-B', country: 'RO' },
};
const service = (
  price: string,
  vat: InvoiceDraft['lines'][number]['vat'] = { category: 'S', rate: '21' },
) => ({
  name: 'Servicii',
  quantity: '1',
  unitCode: 'C62',
  price,
  vat,
});
const base: InvoiceDraft = {
  typeCode: '380',
  number: 'XF-1',
  issueDate: '2026-03-10',
  dueDate: '2026-04-09',
  currency: 'RON',
  seller,
  buyer,
  payment: { meansCode: '30', accounts: [{ id: 'RO49AAAA1B31007593840000' }] },
  lines: [service('100')],
};

const drafts: Record<string, InvoiceDraft> = {
  'credit-note': {
    ...base,
    typeCode: '381',
    precedingInvoices: [{ number: 'XF-0', issueDate: '2026-02-10' }],
  },
  euro: {
    ...base,
    currency: 'EUR',
    vatCurrency: 'RON',
    vatAccountingTotal: '104.30',
    notes: ['Curs BNR 4,9670 lei/euro'],
  },
  exempt: { ...base, lines: [service('100', { category: 'E', exemptionCode: 'VATEX-EU-132' })] },
  'reverse-charge': {
    ...base,
    buyer: {
      ...buyer,
      vatId: 'DE123456789',
      address: { lines: ['Hauptstraße 1'], city: 'Berlin', country: 'DE' },
    },
    lines: [service('1000', { category: 'AE', exemptionCode: 'VATEX-EU-AE' })],
  },
  adjustments: {
    ...base,
    adjustments: [
      { charge: false, reason: 'Reducere', percent: '5', vat: { category: 'S', rate: '21' } },
      { charge: true, reason: 'Transport', amount: '25', vat: { category: 'S', rate: '21' } },
    ],
    prepaid: '50',
    lines: [
      { ...service('200'), period: { start: '2026-03-01', end: '2026-03-31' } },
      {
        ...service('99.99'),
        adjustments: [{ charge: false, reason: 'Fidelitate', amount: '9.99' }],
      },
    ],
  },
  storno: {
    ...base,
    precedingInvoices: [{ number: 'XF-0' }],
    lines: [{ ...service('100'), quantity: '-1' }],
  },
};

async function validate(documents: Record<string, string>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'xfactura-official-'));
  try {
    for (const [name, xml] of Object.entries(documents))
      await writeFile(path.join(directory, `${name}.xml`), xml);
    const report = path.join(directory, 'report.json');
    await $`bun ${path.join(import.meta.dir, 'validate.ts')} --json ${report} ${directory}`
      .nothrow()
      .quiet();
    const { results } = JSON.parse(readFileSync(report, 'utf8')) as {
      results: {
        file: string;
        xsd: string[];
        rules: Record<string, { rule: string; flag: string }[]>;
      }[];
    };
    return Object.fromEntries(
      results.map((result) => [
        path.basename(result.file, '.xml'),
        [
          ...result.xsd.map(() => 'XSD'),
          ...Object.values(result.rules)
            .flat()
            .filter((finding) => finding.flag === 'fatal')
            .map((finding) => finding.rule),
        ],
      ]),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('official EN 16931 validation', () => {
  official(
    'the synthetic corpus passes the UBL 2.1 schema and every fatal EN 16931 rule',
    async () => {
      const invoicer = JSON.parse(
        readFileSync(
          path.join(root, 'packages/xfactura-core/test/fixtures/einvoice/invoicer.json'),
          'utf8',
        ),
      ) as InvoicerInvoice[];
      const documents: Record<string, string> = {};
      for (const source of invoicer)
        documents[`invoicer-${source.id}`] = writeInvoice(
          calculateInvoice(fromInvoicer(source).draft),
        );
      for (const [name, draft] of Object.entries(drafts))
        documents[name] = writeInvoice(calculateInvoice(draft));
      const findings = await validate(documents);
      expect(Object.keys(findings).length).toBe(Object.keys(documents).length);
      expect(Object.entries(findings).filter(([, rules]) => rules.length)).toEqual([]);
    },
    120_000,
  );

  official(
    'mutations of a valid invoice are rejected',
    async () => {
      const xml = writeInvoice(calculateInvoice(base));
      const mutate = (from: string, to: string) => {
        expect(xml).toContain(from);
        return xml.replace(from, to);
      };
      const findings = await validate({
        payable: mutate(
          '<cbc:PayableAmount currencyID="RON">121.00',
          '<cbc:PayableAmount currencyID="RON">121.01',
        ),
        'line-total': mutate(
          '<cbc:LineExtensionAmount currencyID="RON">100.00</cbc:LineExtensionAmount>\n    <cbc:TaxExclusiveAmount',
          '<cbc:LineExtensionAmount currencyID="RON">100.01</cbc:LineExtensionAmount>\n    <cbc:TaxExclusiveAmount',
        ),
        'tax-point-twice': mutate(
          '<cbc:DocumentCurrencyCode>',
          '<cbc:TaxPointDate>2026-03-10</cbc:TaxPointDate>\n  <cac:InvoicePeriod><cbc:DescriptionCode>3</cbc:DescriptionCode></cac:InvoicePeriod>\n  <cbc:DocumentCurrencyCode>',
        ),
        'no-seller-vat-id': mutate(
          '<cbc:CompanyID>RO18547290</cbc:CompanyID>',
          '<cbc:CompanyID></cbc:CompanyID>',
        ),
        'element-order': mutate('<cbc:DueDate>2026-04-09</cbc:DueDate>\n', '').replace(
          '<cbc:DocumentCurrencyCode>',
          '<cbc:DueDate>2026-04-09</cbc:DueDate>\n  <cbc:DocumentCurrencyCode>',
        ),
      });
      expect(findings.payable).toContain('BR-CO-16');
      expect(findings['line-total']).toContain('BR-CO-10');
      expect(findings['tax-point-twice']!.length).toBeGreaterThan(0);
      expect(findings['no-seller-vat-id']!.length).toBeGreaterThan(0);
      expect(findings['element-order']).toContain('XSD');
    },
    120_000,
  );
});

// ANAF's DUKIntegrator with the D300, D394 and D112 validators, as installed by `bun run validators:fetch`.
const duk = path.join(root, '.validators/anaf/dist');
const anaf =
  existsSync(path.join(duk, 'DUKIntegrator.jar')) && Bun.which('java') !== null ? test : test.skip;

const vatReturn = (rows: D300['rows'], extra: Partial<D300> = {}): D300 => ({
  period: { year: 2026, month: 9 },
  type: 'L',
  company: {
    cui: '18547290',
    name: 'Exemplu Servicii SRL',
    address: 'Str. Lungă nr. 10, Galați, jud. Galați',
    phone: '0236000000',
    email: 'contabilitate@exemplu.ro',
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

const vatReturns: Record<string, D300> = {
  nil: vatReturn({}),
  payable: vatReturn({ R9_1: 1000, R9_2: 210, R22_1: 500, R22_2: 105, R28_2: 105 }),
  recoverable: vatReturn(
    { R22_1: 2000, R22_2: 420, R28_2: 420 },
    { period: { year: 2026, month: 8 } },
  ),
  'two-rates': vatReturn({
    R9_1: 1000,
    R9_2: 210,
    R10_1: 500,
    R10_2: 55,
    R22_1: 300,
    R22_2: 63,
    R28_2: 63,
  }),
  // Quarterly returns end in months 3, 6, 9, 12 (or 2, 5, 8, 11 with intra-community acquisitions).
  quarterly: vatReturn(
    { R9_1: 30000, R9_2: 6300, R22_1: 10000, R22_2: 2100, R28_2: 2100 },
    { type: 'T' },
  ),
  // 08–12/2025: namespace v11 and a transitional 19% row.
  'transitional-2025': vatReturn(
    { R9_1: 1000, R9_2: 210, R69_1: 500, R69_2: 95, R74_1: 200, R74_2: 38, R28_2: 38 },
    { period: { year: 2025, month: 10 } },
  ),
};

/** DUKIntegrator's verdict per document: "ok", or its errors (E:) and warnings (A:). */
async function validateAnaf(
  declaration: 'D300' | 'D394' | 'D112',
  documents: Record<string, string>,
) {
  const directory = await mkdtemp(path.join(tmpdir(), `xfactura-${declaration.toLowerCase()}-`));
  try {
    const results = await Promise.all(
      Object.entries(documents).map(async ([name, xml]) => {
        const file = path.join(directory, `${name}.xml`);
        const result = path.join(directory, `${name}.txt`);
        await writeFile(file, xml);
        await $`java -Djava.awt.headless=true -jar DUKIntegrator.jar -v ${declaration} ${file} ${result}`
          .cwd(duk)
          .nothrow()
          .quiet();
        return [name, existsSync(result) ? readFileSync(result, 'utf8').trim() : ''] as const;
      }),
    );
    return Object.fromEntries(results);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('official D300 validation', () => {
  anaf(
    'DUKIntegrator accepts every synthetic return without errors or warnings',
    async () => {
      const results = await validateAnaf(
        'D300',
        Object.fromEntries(
          Object.entries(vatReturns).map(([name, model]) => [name, writeD300(model)]),
        ),
      );
      expect(results).toEqual(
        Object.fromEntries(Object.keys(vatReturns).map((name) => [name, 'ok'])),
      );
    },
    120_000,
  );

  anaf(
    'DUKIntegrator rejects a wrong control sum or payment number',
    async () => {
      const xml = writeD300(vatReturns.payable!);
      const mutate = (from: string, to: string) => {
        expect(xml).toContain(from);
        return xml.replace(from, to);
      };
      const results = await validateAnaf('D300', {
        'control-sum': mutate('totalPlata_A="4155"', 'totalPlata_A="4156"'),
        'payment-number': mutate(
          'nr_evid="10301010926251026000039"',
          'nr_evid="10301010926251026000038"',
        ),
      });
      expect(results['control-sum']).toStartWith('E:');
      expect(results['control-sum']).toContain('totalPlata_A');
      expect(results['payment-number']).toStartWith('E:');
      expect(results['payment-number']).toContain('nr_evid');
    },
    120_000,
  );
});

const registered = (cui: string, name: string): D394Partner => ({ kind: 'registered', cui, name });
const sale = (
  partner: D394Partner,
  rate: D394Operation['rate'],
  invoices: number,
  base: number,
  vat: number,
  type: D394Operation['type'] = 'L',
): D394Operation => ({ type, rate, partner, invoices, base, vat });

const statement = (extra: Partial<D394> = {}): D394 => ({
  period: { year: 2026, month: 9 },
  type: 'L',
  company: {
    cui: '18547290',
    caen: '6201',
    name: 'Exemplu Servicii SRL',
    address: 'Str. Lungă nr. 10, Galați, jud. Galați',
    phone: '0236000000',
    email: 'contabilitate@exemplu.ro',
  },
  representative: { name: 'Popescu Ana', role: 'Administrator', address: 'Str. Lungă nr. 10' },
  preparer: {
    kind: 'company',
    cui: '18547290',
    name: 'Exemplu Servicii SRL',
    capacity: 'Administrator',
  },
  consultation: true,
  affiliates: false,
  operations: [],
  simplified: {},
  series: [],
  issuedInvoices: { own: 0, byBeneficiaries: 0, byThirdParties: 0 },
  invoices: [],
  cashVatDeductible: {},
  ...extra,
});

const invoiced = {
  series: [
    { type: 'allocated', series: 'XF', first: '1', last: '99999' },
    { type: 'issued', series: 'XF', first: '101', last: '104' },
  ],
  issuedInvoices: { own: 4, byBeneficiaries: 0, byThirdParties: 0 },
} satisfies Partial<D394>;
const domestic = statement({
  ...invoiced,
  operations: [
    sale(registered('14399840', 'Client Unu SRL'), '21', 2, 10000, 2100),
    sale(registered('13548146', 'Client Doi SRL'), '21', 1, 4000, 840),
    sale(registered('10376500', 'Client Trei SRL'), '11', 1, 2000, 220),
    sale(registered('16341004', 'Furnizor Unu SRL'), '21', 3, 3000, 630, 'A'),
  ],
});

const statements: Record<string, D394> = {
  // Two partners at 21%, one at 11%, acquisitions from one supplier at 21%.
  monthly: domestic,
  quarterly: { ...domestic, type: 'T', period: { year: 2026, month: 6 } },
  // A period without operations: op_efectuate 0, informatii only.
  nil: statement(),
  individuals: statement({
    ...invoiced,
    operations: [
      sale(registered('14399840', 'Client Unu SRL'), '21', 1, 2000, 420),
      sale(
        { kind: 'unregistered', code: '1900101400012', name: 'Ionescu Mihai' },
        '21',
        1,
        500,
        105,
      ),
      sale(
        {
          kind: 'unregistered',
          name: 'Georgescu Elena',
          address: { country: 'RO', county: 'RO-GL', locality: 'Galați', street: 'Str. Brăilei' },
        },
        '21',
        1,
        300,
        63,
      ),
      sale(
        {
          kind: 'unregistered',
          name: 'Müller Hans',
          address: { country: 'DE', locality: 'Berlin' },
        },
        '11',
        1,
        100,
        11,
      ),
    ],
  }),
  // The first v5 period, with every other covered section.
  'all-sections': statement({
    period: { year: 2025, month: 8 },
    consultation: false,
    affiliates: true,
    representative: {
      cif: '1900101400012',
      name: 'Popescu Ana',
      role: 'Administrator',
      address: 'Str. Lungă nr. 10',
      phone: '0740000000',
    },
    preparer: {
      kind: 'individual',
      cnp: '2900101400022',
      name: 'Ionescu Maria',
      capacity: 'Expert contabil',
    },
    operations: [
      ...domestic.operations,
      sale(registered('16341004', 'Furnizor Unu SRL'), '21', 1, 1000, 210, 'AI'),
      sale(registered('16341004', 'Furnizor Unu SRL'), '19', 1, -100, -19, 'A'),
      sale(
        { kind: 'unregistered', code: '6859662', name: 'Asociația Exemplu' },
        '21',
        1,
        1000,
        210,
      ),
    ],
    simplified: {
      '21': { receipts: { base: 200, vat: 42 }, purchases: { base: 50, vat: 10 } },
      '9': { salesWithCode: { base: 100, vat: 9 } },
    },
    series: [
      ...invoiced.series,
      {
        type: 'thirdParty',
        series: 'TP',
        first: '1',
        last: '2',
        issuer: { name: 'Terț Facturare SRL', cui: '13548146' },
      },
    ],
    issuedInvoices: { own: 4, byBeneficiaries: 0, byThirdParties: 2 },
    invoices: [
      { type: 'storno', series: 'XF', number: '103' },
      { type: 'cancelled', series: 'XF', number: '104' },
      {
        type: 'selfInvoice',
        series: 'XF',
        number: '102',
        amounts: { '21': { base: 100, vat: 21 } },
      },
    ],
    cashVatDeductible: { '21': 210, '19': 38 },
    refund: Object.fromEntries(
      d394RefundFlags.map(([name]) => [
        name,
        ['Prest21', 'achizitiiS21', 'efectuat'].includes(name),
      ]),
    ) as NonNullable<D394['refund']>,
  }),
};

describe('official D394 validation', () => {
  anaf(
    'DUKIntegrator accepts every synthetic statement without errors or warnings',
    async () => {
      for (const model of Object.values(statements)) expect(checkD394(model)).toEqual([]);
      const results = await validateAnaf(
        'D394',
        Object.fromEntries(
          Object.entries(statements).map(([name, model]) => [name, writeD394(model)]),
        ),
      );
      expect(results).toEqual(
        Object.fromEntries(Object.keys(statements).map((name) => [name, 'ok'])),
      );
    },
    120_000,
  );

  anaf(
    'DUKIntegrator rejects what checkD394 rejects, and a wrong control sum or partner count',
    async () => {
      const xml = writeD394(domestic);
      const mutate = (from: string, to: string) => {
        expect(xml).toContain(from);
        return xml.replace(from, to);
      };
      const duplicate = statement({
        ...domestic,
        operations: [...domestic.operations, domestic.operations[0]!],
      });
      const noCounty = statement({
        ...invoiced,
        operations: [
          sale({ kind: 'unregistered', name: 'X', address: { country: 'RO' } }, '21', 1, 1, 0),
        ],
      });
      const unallocated = statement({ ...domestic, series: [invoiced.series[1]] });
      expect(checkD394(duplicate).map((check) => check.code)).toEqual(['D394_DUPLICATE']);
      expect(checkD394(noCounty).map((check) => check.code)).toEqual(['D394_ADDRESS']);
      expect(checkD394(unallocated).map((check) => check.code)).toEqual(['D394_SERIES']);
      const results = await validateAnaf('D394', {
        'control-sum': mutate('totalPlata_A="19004"', 'totalPlata_A="19005"'),
        'partner-count': mutate('nrCui1="4"', 'nrCui1="3"'),
        'rate-summary': mutate('bazaL="14000"', 'bazaL="14001"'),
        duplicate: writeD394(duplicate),
        'no-county': writeD394(noCounty),
        unallocated: writeD394(unallocated),
      });
      expect(results['control-sum']).toStartWith('E:');
      expect(results['control-sum']).toContain('R17');
      expect(results['partner-count']).toContain('R122');
      expect(results['rate-summary']).toStartWith('E:');
      expect(results.duplicate).toContain('R218.4');
      expect(results['no-county']).toContain('R222.3');
      expect(results.unallocated).toContain('R112.2');
    },
    120_000,
  );
});

type Employment = D112Insured['employment'];
type Income = D112Insured['income'];

/** A full-time employee at the main job for every working day of October 2026 (22). */
const insured = (
  person: Pick<D112Insured, 'cnp' | 'lastName' | 'firstName' | 'from'> &
    Partial<Omit<D112Insured, 'employment' | 'income'>> & {
      employment: Partial<Employment>;
      income: Partial<Income>;
    },
): D112Insured => ({
  healthFund: 'RO-GL',
  sickLeaveInsured: true,
  unemploymentInsured: true,
  ...person,
  employment: {
    type: '1',
    pensioner: false,
    contract: 'N',
    normHours: 8,
    baseSalary: 0,
    hoursWorked: 176,
    hoursSuspended: 0,
    daysWorked: 22,
    unemploymentBase: 0,
    camBase: 0,
    cassBase: 0,
    cass: 0,
    casBase: 0,
    cas: 0,
    relief: 0,
    ...person.employment,
  },
  income: {
    mainJob: true,
    cash: 0,
    mealVouchers: 0,
    holidayVouchers: 0,
    dependents: 0,
    deduction: { basic: 0, young: 0, children: 0 },
    otherDeductions: 0,
    taxBase: 0,
    tax: 0,
    paid: 0,
    ...person.income,
  },
});

const payroll = (people: D112Insured[]): D112 => ({
  period: { year: 2026, month: 10 },
  correction: false,
  declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' },
  employer: {
    cui: '18547290',
    caen: '6201',
    name: 'Exemplu Servicii SRL',
    registeredOffice: { address: 'Str. Lungă nr. 10, Galați, jud. Galați', phone: '0236000000' },
    healthFund: 'RO-GL',
  },
  insured: people,
});

// The payroll engine's amounts for October 2026, in lei; the unemployment base is the base salary.
const partTimeEmployee = insured({
  cnp: '2850722170021',
  lastName: 'Georgescu',
  firstName: 'Elena',
  from: '2025-02-15',
  // CAS 625 + 406 and CASS 250 + 163 borne by the employer: 25% and 10% of the structure's
  // limit sum, (4325 − 200) × 22 / 22 = 4125 lei.
  minimum: { kind: 'due', base: 4125 },
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
const fullTimeEmployee = insured({
  cnp: '1781105170030',
  lastName: 'Dumitrescu',
  firstName: 'Andrei',
  from: '2023-09-01',
  employment: {
    baseSalary: 5000,
    unemploymentBase: 5000,
    camBase: 5000,
    cassBase: 5000,
    cass: 500,
    casBase: 5000,
    cas: 1250,
  },
  // The engine's 562.25 lei of deduction, rounded to whole lei as the structure rounds.
  income: {
    cash: 5000,
    deduction: { basic: 562, young: 0, children: 0 },
    taxBase: 2688,
    tax: 269,
    paid: 2981,
  },
});
const payrolls: Record<string, D112> = {
  // The minimum wage, 200 lei of it outside every base.
  'minimum-wage': payroll([
    insured({
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
    }),
  ]),
  'part-time': payroll([partTimeEmployee, fullTimeEmployee]),
  // Meal vouchers in the CASS base and the tax, not in the CAS or CAM bases.
  'meal-vouchers': payroll([
    insured({
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
      income: { cash: 6000, mealVouchers: 800, taxBase: 4620, tax: 462, paid: 3358 },
    }),
  ]),
};

describe('official D112 validation', () => {
  anaf(
    'DUKIntegrator accepts the October 2026 payrolls without errors or warnings',
    async () => {
      expect(checkD112(payrolls['minimum-wage']!)).toEqual([]);
      expect(checkD112(payrolls['meal-vouchers']!)).toEqual([]);
      expect(checkD112(payrolls['part-time']!)).toEqual([]);
      const owed = (name: string) =>
        Object.fromEntries(
          calculateD112(payrolls[name]!).obligations.map(({ code, owed }) => [code, owed]),
        );
      expect(owed('minimum-wage')).toEqual({ '602': 182n, '412': 1031n, '432': 413n, '480': 93n });
      expect(owed('part-time')).toEqual({
        '602': 345n,
        '412': 1875n,
        '432': 750n,
        '480': 169n,
        '458': 406n,
        '459': 163n,
      });
      expect(owed('meal-vouchers')).toEqual({
        '602': 462n,
        '412': 1500n,
        '432': 680n,
        '480': 135n,
      });
      const results = await validateAnaf(
        'D112',
        Object.fromEntries(
          Object.entries(payrolls).map(([name, model]) => [name, writeD112(model)]),
        ),
      );
      expect(results).toEqual(
        Object.fromEntries(Object.keys(payrolls).map((name) => [name, 'ok'])),
      );
    },
    120_000,
  );

  anaf(
    'DUKIntegrator rejects what checkD112 rejects, and a wrong control sum or contribution',
    async () => {
      const xml = writeD112(payrolls['part-time']!);
      const mutate = (from: string, to: string) => {
        expect(xml).toContain(from);
        return xml.replace(from, to);
      };
      const { minimum: _minimum, ...unflagged } = partTimeEmployee;
      const fullTime = (employment: Partial<Employment>) =>
        payroll([
          { ...fullTimeEmployee, employment: { ...fullTimeEmployee.employment, ...employment } },
        ]);
      const rejected: Record<string, D112> = {
        unflagged: payroll([unflagged]),
        'low-limit': payroll([{ ...partTimeEmployee, minimum: { kind: 'due', base: 4123 } }]),
        'relief-type-1': fullTime({
          relief: 200,
          camBase: 4800,
          cassBase: 4800,
          cass: 480,
          casBase: 4800,
          cas: 1200,
        }),
        'type-51-part-time': fullTime({ type: '51', contract: 'P4', hoursWorked: 88 }),
        'under-15': payroll([{ ...fullTimeEmployee, cnp: '5111101170066' }]),
      };
      expect(
        Object.fromEntries(
          Object.entries(rejected).map(([name, model]) => [
            name,
            checkD112(model).map((check) => `${check.severity}:${check.code}`),
          ]),
        ),
      ).toEqual({
        unflagged: ['error:D112_MINIMUM'],
        'low-limit': ['error:D112_MINIMUM'],
        'relief-type-1': ['error:D112_RELIEF'],
        'type-51-part-time': ['error:D112_TYPE'],
        'under-15': ['error:D112_CNP'],
      });
      const results = await validateAnaf('D112', {
        'control-sum': mutate('totalPlata_A="3708"', 'totalPlata_A="3709"'),
        cass: mutate('A_12="500"', 'A_12="520"'),
        'employer-cas': mutate('A_14D="406"', 'A_14D="405"'),
        ...Object.fromEntries(
          Object.entries(rejected).map(([name, model]) => [name, writeD112(model)]),
        ),
      });
      expect(results['control-sum']).toStartWith('E:');
      expect(results['control-sum']).toContain('A19.1');
      expect(results.cass).toContain('S25');
      expect(results['employer-cas']).toContain('SP5A');
      expect(results.unflagged).toContain('S9c1.1');
      expect(results['low-limit']).toContain('SP1A.3');
      expect(results['relief-type-1']).toContain('S1a1');
      expect(results['type-51-part-time']).toContain('A_1 (51) >50 doar pt CIM cu norma intreaga');
      expect(results['under-15']).toContain('S1.2');
    },
    120_000,
  );
});
