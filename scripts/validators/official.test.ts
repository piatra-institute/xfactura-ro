// Runs the official validation artifacts over the writer's synthetic corpus, and over mutations
// that must be rejected. Without the artifacts (`bun run validators:fetch`), Java or xmllint the
// tests are skipped, never passed.
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { $ } from 'bun';
import { anaf, anafD112FirstHalf, d112FirstHalfDuk, validateAnaf } from './anaf';
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
  type D112SickCertificate,
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
  // A credit note in euro: BT-6 and its VAT in lei (BT-111) at its invoice's rate, 21.00 EUR ×
  // 4.9670 = 104.31 (Codul fiscal art. 282 alin. (9)).
  'euro-credit-note': {
    ...base,
    typeCode: '381',
    currency: 'EUR',
    vatCurrency: 'RON',
    vatAccountingTotal: '104.31',
    precedingInvoices: [{ number: 'XF-0', issueDate: '2026-02-10' }],
    notes: ['Curs BNR 4,9670 lei/euro, al facturii XF-0'],
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
  // The domestic reverse charge (art. 331): waste bought on rd. 12 (repeated as deductible on rd.
  // 26), cereals sold on rd. 13 with their flag, and a receipt's VAT on rd. 24.
  'reverse-charge': vatReturn(
    {
      R9_1: 1000,
      R9_2: 210,
      R12_1: 10000,
      R12_2: 2100,
      R12_1_1: 10000,
      R12_1_2: 2100,
      R13_1: 5000,
      R22_1: 248,
      R22_2: 52,
      R28_2: 2152,
    },
    {
      reverseCharge: {
        cereals: true,
        mobilePhones: false,
        integratedCircuits: false,
        consoles: false,
      },
    },
  ),
  // 08–12/2025: namespace v11 and a transitional 19% row.
  'transitional-2025': vatReturn(
    { R9_1: 1000, R9_2: 210, R69_1: 500, R69_2: 95, R74_1: 200, R74_2: 38, R28_2: 38 },
    { period: { year: 2025, month: 10 } },
  ),
};

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
  // A company applying VAT on collection: invoices issued and received in full, the VAT it
  // collected and deducted on the invoices paid in the period.
  'vat-on-collection': statement({
    ...invoiced,
    operations: [
      sale(registered('14399840', 'Client Unu SRL'), '21', 2, 10000, 2100),
      sale(registered('16341004', 'Furnizor Unu SRL'), '21', 1, 1000, 210, 'A'),
      sale(registered('13548146', 'Furnizor Doi SRL'), '21', 1, 500, 105, 'AI'),
    ],
    cashVatDeductible: { '21': 42 },
    vatOnCollection: { collected: { '21': 1050, '11': 0 }, deductible: { '21': 210 } },
  }),
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
  // The domestic reverse charge: laptops and phones bought (C, at 21%, the invoice counted for
  // the larger product), waste and wheat sold (V, rate 0, the wheat by its NC code under 21), and
  // receipts deducted as simplified invoices.
  'reverse-charge': statement({
    ...invoiced,
    operations: [
      sale(registered('14399840', 'Client Unu SRL'), '21', 2, 10000, 2100),
      {
        type: 'C',
        rate: '21',
        partner: registered('13548146', 'Furnizor IT SRL'),
        invoices: 1,
        base: 30000,
        vat: 6300,
        products: [
          { code: '31', invoices: 1, base: 25000, vat: 5250 },
          { code: '29', invoices: 0, base: 5000, vat: 1050 },
        ],
      },
      {
        type: 'V',
        rate: '0',
        partner: registered('10376500', 'Reciclare Exemplu SRL'),
        invoices: 2,
        base: 8000,
        vat: 0,
        products: [
          { code: '22', invoices: 1, base: 5000, vat: 0 },
          { code: '1001', invoices: 1, base: 3000, vat: 0 },
        ],
      },
    ],
    simplified: { '21': { receipts: { base: 248, vat: 52 } } },
  }),
  // Acquisitions from persons not registered for VAT (N, rate 0, no VAT): an exempt invoice of a
  // company outside VAT (its CUI, no nature needed), two invoices outside the scope of VAT from
  // another, the rent of an individual's flat under a contract (CNP, services) and wheat bought
  // from a farmer without a code, on a purchase slip (its NC code, under 21 in detaliu).
  unregistered: statement({
    ...invoiced,
    operations: [
      sale(registered('14399840', 'Client Unu SRL'), '21', 1, 2000, 420),
      {
        type: 'N',
        rate: '0',
        partner: { kind: 'unregistered', code: '6859662', name: 'Clinica Exemplu SRL' },
        invoices: 1,
        base: 300,
        vat: 0,
        document: 'invoice',
      },
      {
        type: 'N',
        rate: '0',
        partner: { kind: 'unregistered', code: '10376500', name: 'Mică Întreprindere SRL' },
        invoices: 2,
        base: 1500,
        vat: 0,
        document: 'invoice',
      },
      {
        type: 'N',
        rate: '0',
        partner: { kind: 'unregistered', code: '1900101400012', name: 'Ionescu Mihai' },
        invoices: 1,
        base: 2500,
        vat: 0,
        document: 'contract',
        products: [{ code: '35', invoices: 1, base: 2500, vat: 0 }],
      },
      {
        type: 'N',
        rate: '0',
        partner: { kind: 'unregistered', code: '2900101400022', name: 'Ionescu Maria' },
        invoices: 1,
        base: 800,
        vat: 0,
        document: 'other',
        products: [
          { code: '34', invoices: 1, base: 600, vat: 0 },
          { code: '22', invoices: 0, base: 200, vat: 0 },
        ],
      },
      {
        type: 'N',
        rate: '0',
        partner: {
          kind: 'unregistered',
          name: 'Georgescu Elena',
          address: { country: 'RO', county: 'RO-GL', locality: 'Galați', street: 'Str. Brăilei' },
        },
        invoices: 1,
        base: 4000,
        vat: 0,
        document: 'purchaseSlip',
        products: [{ code: '1001', invoices: 1, base: 4000, vat: 0 }],
      },
    ],
  }),
  // The special schemes (V4): a travel agency's and a dealer's supplies under the margin schemes
  // (LS, rate 0, no VAT) to a registered customer and to an individual, an item bought from a
  // dealer under the scheme (AS) and one from an individual (N), with the margins' fields.
  special: statement({
    ...invoiced,
    operations: [
      sale(registered('14399840', 'Client Unu SRL'), '0', 2, 11500, 0, 'LS'),
      sale(
        { kind: 'unregistered', code: '1900101400012', name: 'Ionescu Mihai' },
        '0',
        1,
        1800,
        0,
        'LS',
      ),
      sale(registered('13548146', 'Anticariat Exemplu SRL'), '0', 1, 2000, 0, 'AS'),
      {
        type: 'N',
        rate: '0',
        partner: { kind: 'unregistered', code: '2900101400022', name: 'Ionescu Maria' },
        invoices: 1,
        base: 1000,
        vat: 0,
        document: 'invoice',
        products: [{ code: '34', invoices: 1, base: 1000, vat: 0 }],
      },
    ],
    margins: {
      travel: { receipts: 10000, costs: 7580, margin: 2000, vat: 420 },
      goods: { sales: 3300, purchases: 3000, margin: 300, vat: 87 },
    },
  }),
  // Partners established abroad (OPANAF nr. 3.769/2015 anexa nr. 2 secțiunea 1 lit. E–F): a
  // supply with Romanian VAT to a company of another Member State (type 3) and services bought
  // outside the Union, their VAT self-assessed (C, type 4); an invoice at two rates counted once,
  // for the larger VAT (secțiunea a 2-a pct. 5).
  abroad: statement({
    ...invoiced,
    operations: [
      sale(registered('14399840', 'Client Unu SRL'), '21', 1, 100, 21),
      sale(registered('14399840', 'Client Unu SRL'), '11', 0, 50, 6),
      sale(
        { kind: 'nonEstablished', region: 'eu', code: 'DE123456789', name: 'Beispiel GmbH' },
        '21',
        1,
        400,
        84,
      ),
      sale(
        { kind: 'nonEstablished', region: 'nonEu', code: '94-1234567', name: 'Example Inc.' },
        '21',
        2,
        500,
        105,
        'C',
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
      // N: the nature (op11) only for individuals, and required for them.
      const unregistered = statements.unregistered!;
      const [company, individual] = [unregistered.operations[1]!, unregistered.operations[3]!];
      const natured = statement({
        ...unregistered,
        operations: unregistered.operations.map((operation) =>
          operation === company
            ? { ...operation, products: [{ code: '35', invoices: 1, base: 300, vat: 0 }] }
            : operation,
        ),
      });
      const unnatured = statement({
        ...unregistered,
        operations: unregistered.operations.map((operation) =>
          operation === individual ? { ...operation, products: [] } : operation,
        ),
      });
      expect(checkD394(natured).map((check) => check.code)).toEqual(['D394_PRODUCTS']);
      expect(checkD394(unnatured).map((check) => check.code)).toEqual(['D394_PRODUCTS']);
      const n = writeD394(unregistered);
      const edit = (from: string, to: string) => {
        expect(n).toContain(from);
        return n.replace(from, to);
      };
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
        'nature-company': edit(
          'baza="300"/>',
          'baza="300"><op11 nrFactPR="1" codPR="35" bazaPR="300"/></op1>',
        ),
        'nature-missing': edit('<op11 nrFactPR="1" codPR="35" bazaPR="2500"/>', ''),
        'partner-count-abroad': writeD394(statements.abroad!).replace('nrCui4="1"', 'nrCui4="0"'),
      });
      expect(results['control-sum']).toStartWith('E:');
      expect(results['control-sum']).toContain('R17');
      expect(results['partner-count']).toContain('R122');
      expect(results['rate-summary']).toStartWith('E:');
      expect(results.duplicate).toContain('R218.4');
      expect(results['no-county']).toContain('R222.3');
      expect(results.unallocated).toContain('R112.2');
      expect(results['nature-company']).toContain('R233.4');
      expect(results['nature-missing']).toContain('R233.6');
      expect(results['partner-count-abroad']).toStartWith('E:');
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

type Certificate = D112SickCertificate;
/** A code 01 certificate prescribed by the family doctor on its first day, on a base of 36,000
 * lei over 127 working days (283.46 lei a day). */
const certificate = (
  number: string,
  from: string,
  to: string,
  paid: Pick<Certificate, 'unpaidDays' | 'employerDays' | 'fundDays' | 'percent'> &
    Pick<Certificate, 'employer' | 'fund'>,
  extra: Partial<Certificate> = {},
): Certificate => ({
  series: 'CCMAM',
  number,
  issued: from,
  from,
  to,
  code: '01',
  place: 'family_doctor',
  diagnosis: '101',
  base: { income: 36000, days: 127 },
  ...paid,
  ...extra,
});
// The payroll engine's October 2026 for 6,000 lei a month and two episodes, each losing its first
// working day (OUG 91/2025): 5–9 October, 5 working days at 55%, 4 paid by the employer (624 lei);
// 19–28 October, 8 working days at 65%, 5 paid by the employer (921) and 2 by FNUASS (368). Nine
// of 22 days worked, 6,000 × 9 / 22 = 2,455 lei; the CAM base leaves out FNUASS's part; the
// unemployment base is the pay in money, as the engine declares it.
const sickCertificates = [
  certificate('1001', '2026-10-05', '2026-10-09', {
    unpaidDays: 1,
    employerDays: 4,
    fundDays: 0,
    percent: '55',
    employer: 624,
    fund: 0,
  }),
  certificate('1002', '2026-10-19', '2026-10-28', {
    unpaidDays: 1,
    employerDays: 5,
    fundDays: 2,
    percent: '65',
    employer: 921,
    fund: 368,
  }),
];
const sickEmployee = insured({
  cnp: '2931204170043',
  lastName: 'Constantinescu',
  firstName: 'Ioana',
  from: '2022-06-01',
  employment: {
    baseSalary: 6000,
    hoursWorked: 72,
    hoursSuspended: 104,
    daysWorked: 9,
    unemploymentBase: 4368,
    camBase: 4000,
    cassBase: 4368,
    cass: 437,
    casBase: 4368,
    cas: 1092,
  },
  income: {
    cash: 4368,
    deduction: { basic: 843, young: 0, children: 0 },
    taxBase: 1996,
    tax: 200,
    paid: 2639,
  },
  sickLeave: sickCertificates,
});
const sickLeave: Record<string, D112> = {
  'sick-leave': payroll([sickEmployee, fullTimeEmployee]),
  // 1–2 October continue a certificate of 28–30 September, whose first day was already unpaid:
  // two more days by the employer at 55% (312 lei), 20 days worked (5,455 lei).
  continuation: payroll([
    insured({
      ...fullTimeEmployee,
      employment: {
        baseSalary: 6000,
        hoursWorked: 160,
        hoursSuspended: 16,
        daysWorked: 20,
        unemploymentBase: 5767,
        camBase: 5767,
        cassBase: 5767,
        cass: 577,
        casBase: 5767,
        cas: 1442,
      },
      income: {
        cash: 5767,
        deduction: { basic: 238, young: 0, children: 0 },
        taxBase: 3510,
        tax: 351,
        paid: 3397,
      },
      sickLeave: [
        certificate(
          '1003',
          '2026-10-01',
          '2026-10-02',
          { unpaidDays: 0, employerDays: 2, fundDays: 0, percent: '55', employer: 312, fund: 0 },
          { continues: { series: 'CCMAM', number: '0998', initialFrom: '2026-09-28' } },
        ),
      ],
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

  // January–June 2026: the structure of 30.03.2026 (salMin 4050, Suma300 300 lei; NZL 18 in
  // January, 21 in June), validated by the J26.0.3 ANAF published for those months and by the
  // general kit's J27.0.8, which keeps their table.
  const january = (people: D112Insured[], month = 1): D112 => ({
    ...payroll(people),
    period: { year: 2026, month },
    parameters: { minimumWage: 4050, relief: 300 },
  });
  const days = (person: D112Insured, daysWorked: number, hours = 8): D112Insured => ({
    ...person,
    employment: { ...person.employment, daysWorked, hoursWorked: daysWorked * hours },
  });
  const firstHalf: Record<string, D112> = {
    // 300 lei of the minimum wage outside every base: CAS 25% × 3750 = 937,50 → 938, CASS 375,
    // deduction 20% × 4050 = 810, tax 10% × (3750 − 938 − 375 − 810 = 1627) = 163.
    'january-minimum-wage': january([
      days(
        insured({
          cnp: '1900315170013',
          lastName: 'Ionescu',
          firstName: 'Mihai',
          from: '2024-03-01',
          employment: {
            type: '51',
            baseSalary: 4050,
            unemploymentBase: 4050,
            camBase: 3750,
            cassBase: 3750,
            cass: 375,
            casBase: 3750,
            cas: 938,
            relief: 300,
          },
          income: {
            cash: 4050,
            deduction: { basic: 810, young: 0, children: 0 },
            taxBase: 1627,
            tax: 163,
            paid: 2574,
          },
        }),
        18,
      ),
    ]),
    // The part-time contract's limit sum: (4050 − 300) × 18 / 18 = 3750 lei; the full-time
    // employee's deduction 10,5% × 4050 = 425.
    'january-part-time': january([
      days(
        {
          ...partTimeEmployee,
          minimum: { kind: 'due', base: 3750 },
          income: {
            ...partTimeEmployee.income,
            deduction: { basic: 810, young: 0, children: 0 },
            taxBase: 815,
            tax: 82,
            paid: 1543,
          },
        },
        18,
        4,
      ),
      days(
        {
          ...fullTimeEmployee,
          income: {
            ...fullTimeEmployee.income,
            deduction: { basic: 425, young: 0, children: 0 },
            taxBase: 2825,
            tax: 283,
            paid: 2967,
          },
        },
        18,
      ),
    ]),
    'june-full-time': january(
      [
        days(
          {
            ...fullTimeEmployee,
            income: {
              ...fullTimeEmployee.income,
              deduction: { basic: 425, young: 0, children: 0 },
              taxBase: 2825,
              tax: 283,
              paid: 2967,
            },
          },
          21,
        ),
      ],
      6,
    ),
  };

  // January 2026 with medical leave, as the payroll engine computes it (d112.integration.test.ts):
  // 12–23 January at 65%, none of the days lost (issued before 1 February), 5 by the employer and
  // 5 by FNUASS; maternity all month, 85% from FNUASS; a work accident the pension house confirmed,
  // 19–30 January at 80%, 3 days by the employer and 7 by the state social insurance budget, in B3
  // and C3. Declared without the fields 07/2026 added (D_9b, D_14a, D_15a, D_16a, B3_7D, C2_155,
  // C2_156), which both validators refuse in these months.
  const firstHalfLeave = january([
    insured({
      cnp: '2931204170043',
      lastName: 'Constantinescu',
      firstName: 'Ioana',
      from: '2022-06-01',
      employment: {
        baseSalary: 6000,
        hoursWorked: 64,
        hoursSuspended: 80,
        daysWorked: 8,
        unemploymentBase: 4509,
        camBase: 3588,
        cassBase: 4509,
        cass: 451,
        casBase: 4509,
        cas: 1127,
      },
      income: {
        cash: 4509,
        deduction: { basic: 608, young: 0, children: 0 },
        taxBase: 2323,
        tax: 232,
        paid: 2699,
      },
      sickLeave: [
        certificate(
          '2001',
          '2026-01-12',
          '2026-01-23',
          { unpaidDays: 0, employerDays: 5, fundDays: 5, percent: '65', employer: 921, fund: 921 },
          { place: 'ambulatory' },
        ),
      ],
    }),
    insured({
      cnp: '2850722170021',
      lastName: 'Georgescu',
      firstName: 'Elena',
      from: '2025-02-15',
      employment: {
        baseSalary: 6000,
        hoursWorked: 0,
        hoursSuspended: 144,
        daysWorked: 0,
        casBase: 3023,
        cas: 756,
      },
      income: { deduction: { basic: 810, young: 0, children: 0 }, paid: 2267 },
      sickLeave: [
        certificate(
          '2002',
          '2026-01-01',
          '2026-01-31',
          { unpaidDays: 0, employerDays: 0, fundDays: 18, percent: null, employer: 0, fund: 3023 },
          { code: '08', place: 'ambulatory', diagnosis: '806', base: { income: 24300, days: 123 } },
        ),
      ],
    }),
    insured({
      ...fullTimeEmployee,
      employment: {
        baseSalary: 6000,
        hoursWorked: 64,
        hoursSuspended: 80,
        daysWorked: 8,
        unemploymentBase: 5334,
        camBase: 3467,
        cassBase: 2667,
        cass: 267,
        casBase: 2667,
        cas: 667,
      },
      income: {
        cash: 5334,
        deduction: { basic: 284, young: 0, children: 0 },
        taxBase: 4116,
        tax: 412,
        paid: 3988,
      },
      accidents: { cases: 1, days: 10, fundDays: 7, employer: 800, fund: 1867 },
    }),
  ]);

  anafD112FirstHalf(
    'DUKIntegrator accepts January 2026 with medical leave, maternity and a work accident, in J26.0.3 and in J27.0.8',
    async () => {
      // Maternity has a CAS base without days worked or CASS: warnings of the writer only.
      expect(checkD112(firstHalfLeave).map((check) => `${check.severity}:${check.code}`)).toEqual([
        'warning:D112_DAYS',
        'warning:D112_CAS',
      ]);
      const calculation = calculateD112(firstHalfLeave);
      expect(
        Object.fromEntries(calculation.obligations.map(({ code, owed }) => [code, owed])),
      ).toEqual({ '602': 644n, '412': 2550n, '432': 718n, '480': 159n });
      expect(calculation.medicalLeave?.recoverable).toBe(3944n);
      expect(calculation.accidents).toEqual({ cases: 1, days: 10, total: 2667n, fund: 1867n });
      const xml = writeD112(firstHalfLeave);
      expect(xml).toContain('D_9="01" D_10="3" D_14="5" D_15="5" D_16="10" D_17="36000"');
      // The fields 07/2026 added, unknown in January to both validators.
      const july = xml.replace(' D_14="5"', ' D_14a="5" D_14="5"');
      expect(july).not.toBe(xml);
      for (const kit of [d112FirstHalfDuk, undefined]) {
        const results = await validateAnaf('D112', { xml, july }, kit);
        expect(results.xml).toBe('ok');
        expect(results.july).toContain("atribut necunoscut ('D_14a')");
      }
      // D_17 within 12 × 6 × 4050 lei in both.
      const over = xml.replace(
        'D_17="24300" D_18="123" D_19="197.56"',
        'D_17="291601" D_18="123" D_19="2370.74"',
      );
      expect(over).not.toBe(xml);
      for (const kit of [d112FirstHalfDuk, undefined])
        expect((await validateAnaf('D112', { over }, kit)).over).toContain(
          'S106: D_17 (291601) <= 12*(salmin pe ultimele 6 luni) (291600)',
        );
    },
    120_000,
  );

  anafD112FirstHalf(
    'DUKIntegrator accepts the January–June 2026 payrolls, in J26.0.3 and in J27.0.8',
    async () => {
      for (const model of Object.values(firstHalf)) expect(checkD112(model)).toEqual([]);
      const written = Object.fromEntries(
        Object.entries(firstHalf).map(([name, model]) => [name, writeD112(model)]),
      );
      const ok = Object.fromEntries(Object.keys(firstHalf).map((name) => [name, 'ok']));
      expect(await validateAnaf('D112', written, d112FirstHalfDuk)).toEqual(ok);
      expect(await validateAnaf('D112', written)).toEqual(ok);
      // Both apply January's limit sum, (4050 − 300) × 18 / 18.
      const low = written['january-part-time']!.replace('A_13P="3750"', 'A_13P="3500"');
      expect(low).not.toBe(written['january-part-time']);
      for (const verdict of [
        await validateAnaf('D112', { low }, d112FirstHalfDuk),
        await validateAnaf('D112', { low }),
      ])
        expect(verdict.low).toContain('SP1A.3: A_13P(3500) trebuie sa fie = 3750');
      // The register's parameters must be the structure's.
      expect(
        checkD112({
          ...firstHalf['january-minimum-wage']!,
          parameters: { minimumWage: 4325, relief: 200 },
        }).map((check) => check.code),
      ).toContain('D112_PARAMETERS');
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

describe('official D112 validation of medical leave', () => {
  anaf(
    'DUKIntegrator accepts certificates paid by the employer, by FNUASS and continued',
    async () => {
      for (const model of Object.values(sickLeave)) expect(checkD112(model)).toEqual([]);
      const calculation = calculateD112(sickLeave['sick-leave']!);
      expect(
        Object.fromEntries(calculation.obligations.map(({ code, owed }) => [code, owed])),
      ).toEqual({ '602': 469n, '412': 2342n, '432': 937n, '480': 203n });
      expect(calculation.medicalLeave?.incapacity).toEqual({
        cases: 2,
        days: 11,
        employerDays: 9,
        fundDays: 2,
        employer: 1545n,
        fund: 368n,
      });
      expect(calculation.medicalLeave?.recoverable).toBe(368n);
      const results = await validateAnaf(
        'D112',
        Object.fromEntries(
          Object.entries(sickLeave).map(([name, model]) => [name, writeD112(model)]),
        ),
      );
      expect(results).toEqual(
        Object.fromEntries(Object.keys(sickLeave).map((name) => [name, 'ok'])),
      );
    },
    120_000,
  );

  anaf(
    'DUKIntegrator rejects what checkD112 rejects, wrong totals, and section D beside section A',
    async () => {
      const xml = writeD112(sickLeave['sick-leave']!);
      const mutate = (from: string, to: string) => {
        expect(xml).toContain(from);
        return xml.replace(from, to);
      };
      const withCertificate = (index: number, patch: Partial<D112SickCertificate>) =>
        payroll([
          {
            ...sickEmployee,
            sickLeave: sickCertificates.map((item, at) =>
              at === index ? { ...item, ...patch } : item,
            ),
          },
        ]);
      const rejected: Record<string, D112> = {
        // Eleven calendar days from the family doctor, the ninth working day paid by FNUASS.
        'family-doctor-11-days': withCertificate(1, { to: '2026-10-29', fundDays: 3, fund: 553 }),
        'six-employer-days': withCertificate(1, { employerDays: 6, fundDays: 1, fund: 184 }),
        'base-over-ceiling': withCertificate(0, { base: { income: 320000, days: 127 } }),
      };
      expect(
        Object.fromEntries(
          Object.entries(rejected).map(([name, model]) => [
            name,
            checkD112(model).map((check) => `${check.severity}:${check.code}`),
          ]),
        ),
      ).toEqual({
        'family-doctor-11-days': ['error:D112_SICK_DATES'],
        'six-employer-days': ['error:D112_SICK_DAYS'],
        'base-over-ceiling': ['error:D112_SICK_BASE'],
      });
      // The same employee in section A: the structure does not allow D beside it.
      const sectionA = mutate(
        '<asiguratB1 B1_1="1" B1_sal1="6000" B1_sal2="4368"',
        '<asiguratA A_1="1" A_sal1="6000" A_sal2="4368" A_2="0" A_3="N" A_4="8" A_5="4000" A_6="72" A_7="104" A_8="9" A_9="4368" A_11="4368" A_12="437" A_13="4368" A_14="1092" A_13P="0" A_14P="0" A_11P="0" A_12P="0" A_14D="0" A_12D="0" A_13S="0" A_13C="0"/>\n    <asiguratX',
      )
        .replace(/ *<asiguratX [^>]*\/>\n( *<asiguratB[234] [^>]*\/>\n){3}/, '')
        .replace('E3_1="B"', 'E3_1="A"');
      expect(sectionA).not.toContain('asiguratB');
      const results = await validateAnaf('D112', {
        recoverable: mutate('C2_16="368"', 'C2_16="367"'),
        'daily-average': mutate('D_19="283.46"', 'D_19="283.45"'),
        'indemnity-base': mutate('B3_7="1913"', 'B3_7="1914"'),
        'section-a': sectionA,
        ...Object.fromEntries(
          Object.entries(rejected).map(([name, model]) => [name, writeD112(model)]),
        ),
      });
      expect(results.recoverable).toStartWith('E:');
      expect(results.recoverable).toContain('A45');
      expect(results['daily-average']).toContain('S108');
      expect(results['indemnity-base']).toContain('S60.1');
      expect(results['section-a']).toStartWith('F:');
      expect(results['section-a']).toContain("'asiguratD' este gresit pozitionata");
      expect(results['family-doctor-11-days']).toContain('S96.11');
      expect(results['six-employer-days']).toContain('S103');
      expect(results['base-over-ceiling']).toContain('S106');
    },
    120_000,
  );
});
