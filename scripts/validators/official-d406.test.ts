// Runs ANAF's D406 (SAF-T) validator and the published schema over the writer's synthetic files,
// and over mutations that must be rejected. The validator runs from ANAF's SAF-T kit: it needs the
// kit's `dec` library (dec/DECTagStruct), which the general DUKIntegrator kit lacks. Without the
// kit, Java or xmllint the tests are skipped, never passed.
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { $ } from 'bun';
import { anafSaft, saftDuk, validateAnaf } from './anaf';
import {
  checkD406,
  d406PartyId,
  writeD406,
  type D406,
  type D406Journal,
} from '../../packages/xfactura-core/src/ro/saft/d406';
import {
  checkD406Assets,
  writeD406Assets,
  type D406AssetTransaction,
  type D406Assets,
} from '../../packages/xfactura-core/src/ro/saft/assets';

const root = path.join(import.meta.dir, '../..');
const xsd = path.join(root, '.sources/ANAF_D406/Ro_SAFT_Schema_v249_2025.xsd');
const validator = existsSync(path.join(saftDuk, 'lib/D406Validator.jar')) ? anafSaft : test.skip;
const schema = existsSync(xsd) && Bun.which('xmllint') !== null ? test : test.skip;

const customer = d406PartyId({ kind: 'ro', cui: '14399840' });
const supplier = d406PartyId({ kind: 'ro', cui: '31552803' });
const vat = (base: string, amount: string, currencyAmount?: string) => ({
  type: '300',
  code: '310344',
  base,
  amount,
  ...(currencyAmount && { currencyAmount }),
});

/** A month (or the quarter ending in it) of a small service company: two sales and one purchase
 * invoice at 21%, a collection and a payment, payroll and depreciation. With `euro`, the second
 * invoice is EUR 400 + 84 VAT at the BNR rate 5.08. */
function period(type: 'L' | 'T', months: [number, number, number], euro = false): D406 {
  const [first, second, last] = months.map((month) => `2026-${String(month).padStart(2, '0')}`);
  const second2 = euro
    ? { net: '2032.00', vat: '426.72', gross: '2458.72' }
    : { net: '2000.00', vat: '420.00', gross: '2420.00' };
  const eur = (amount: string) => (euro ? { currency: { code: 'EUR', amount, rate: '5.08' } } : {});
  const journals: D406Journal[] = [
    {
      id: 'VZ',
      description: 'Jurnal de vânzări',
      type: 'VZ',
      transactions: [
        {
          id: 'VZ-101',
          date: `${first}-05`,
          description: 'Factura XF-101 Client Test SRL',
          lines: [
            {
              id: 'VZ-101-1',
              account: '4111.01',
              side: 'debit',
              amount: '1210.00',
              customer,
              document: 'XF-101',
              description: 'Client Test SRL',
            },
            {
              id: 'VZ-101-2',
              account: '704',
              side: 'credit',
              amount: '1000.00',
              document: 'XF-101',
              description: 'Servicii de consultanță',
              tax: [vat('1000.00', '210.00')],
            },
            {
              id: 'VZ-101-3',
              account: '4427',
              side: 'credit',
              amount: '210.00',
              document: 'XF-101',
              description: 'TVA colectată 21%',
            },
          ],
        },
        {
          id: 'VZ-102',
          date: `${second}-20`,
          description: 'Factura XF-102 Client Test SRL',
          lines: [
            {
              id: 'VZ-102-1',
              account: '4111.01',
              side: 'debit',
              amount: second2.gross,
              ...eur('484.00'),
              customer,
              document: 'XF-102',
              description: 'Client Test SRL',
            },
            {
              id: 'VZ-102-2',
              account: '704',
              side: 'credit',
              amount: second2.net,
              ...eur('400.00'),
              document: 'XF-102',
              description: 'Servicii de consultanță',
              tax: [vat(second2.net, second2.vat, euro ? '84.00' : undefined)],
            },
            {
              id: 'VZ-102-3',
              account: '4427',
              side: 'credit',
              amount: second2.vat,
              document: 'XF-102',
              description: 'TVA colectată 21%',
            },
          ],
        },
      ],
    },
    {
      id: 'CP',
      description: 'Jurnal de cumpărări',
      type: 'CP',
      transactions: [
        {
          id: 'CP-7781',
          date: `${second}-08`,
          description: 'Factura F-7781 Furnizor Test SRL',
          lines: [
            {
              id: 'CP-7781-1',
              account: '628',
              side: 'debit',
              amount: '500.00',
              document: 'F-7781',
              description: 'Servicii de găzduire',
              tax: [{ type: '300', code: '301104', base: '500.00', amount: '105.00' }],
            },
            {
              id: 'CP-7781-2',
              account: '4426',
              side: 'debit',
              amount: '105.00',
              document: 'F-7781',
              description: 'TVA deductibilă 21%',
            },
            {
              id: 'CP-7781-3',
              account: '401.01',
              side: 'credit',
              amount: '605.00',
              supplier,
              document: 'F-7781',
              description: 'Furnizor Test SRL',
            },
          ],
        },
      ],
    },
    {
      id: 'BC',
      description: 'Registru de bancă',
      type: 'BC',
      transactions: [
        {
          id: 'BC-15',
          date: `${last}-15`,
          description: 'Încasare XF-099 Client Test SRL',
          lines: [
            {
              id: 'BC-15-1',
              account: '5121',
              side: 'debit',
              amount: '2420.00',
              description: 'Încasare prin bancă',
            },
            {
              id: 'BC-15-2',
              account: '4111.01',
              side: 'credit',
              amount: '2420.00',
              customer,
              document: 'XF-099',
              description: 'Client Test SRL',
            },
          ],
        },
        {
          id: 'BC-16',
          date: `${last}-16`,
          description: 'Plată F-7700 Furnizor Test SRL',
          lines: [
            {
              id: 'BC-16-1',
              account: '401.01',
              side: 'debit',
              amount: '1210.00',
              supplier,
              document: 'F-7700',
              description: 'Furnizor Test SRL',
            },
            {
              id: 'BC-16-2',
              account: '5121',
              side: 'credit',
              amount: '1210.00',
              description: 'Plată prin bancă',
            },
          ],
        },
      ],
    },
    {
      id: 'NC',
      description: 'Note contabile diverse',
      type: 'NC',
      transactions: [
        {
          id: 'SAL-10',
          date: `${last}-30`,
          description: 'Stat de salarii',
          lines: [
            {
              id: 'SAL-10-1',
              account: '641',
              side: 'debit',
              amount: '4500.00',
              description: 'Salarii brute',
            },
            {
              id: 'SAL-10-2',
              account: '421',
              side: 'credit',
              amount: '4500.00',
              description: 'Salarii datorate',
            },
            {
              id: 'SAL-10-3',
              account: '421',
              side: 'debit',
              amount: '1125.00',
              description: 'CAS reținut',
            },
            {
              id: 'SAL-10-4',
              account: '4315',
              side: 'credit',
              amount: '1125.00',
              description: 'CAS 25%',
              tax: [{ type: '412', code: '000000', base: '4500.00', amount: '1125.00' }],
            },
            {
              id: 'SAL-10-5',
              account: '421',
              side: 'debit',
              amount: '450.00',
              description: 'CASS reținut',
            },
            {
              id: 'SAL-10-6',
              account: '4316',
              side: 'credit',
              amount: '450.00',
              description: 'CASS 10%',
              tax: [{ type: '432', code: '000000', base: '4500.00', amount: '450.00' }],
            },
            {
              id: 'SAL-10-7',
              account: '421',
              side: 'debit',
              amount: '293.00',
              description: 'Impozit reținut',
            },
            {
              id: 'SAL-10-8',
              account: '444',
              side: 'credit',
              amount: '293.00',
              description: 'Impozit pe salarii 10%',
              tax: [{ type: '602', code: '000000', base: '2925.00', amount: '293.00' }],
            },
            {
              id: 'SAL-10-9',
              account: '646',
              side: 'debit',
              amount: '101.00',
              description: 'CAM 2,25%',
            },
            {
              id: 'SAL-10-10',
              account: '436',
              side: 'credit',
              amount: '101.00',
              description: 'CAM datorată',
              tax: [{ type: '480', code: '000000', base: '4500.00', amount: '101.00' }],
            },
          ],
        },
        {
          id: 'AM-10',
          date: `${last}-30`,
          description: 'Amortizare echipamente',
          lines: [
            {
              id: 'AM-10-1',
              account: '6811',
              side: 'debit',
              amount: '100.00',
              description: 'Amortizare',
            },
            {
              id: 'AM-10-2',
              account: '2813',
              side: 'credit',
              amount: '100.00',
              description: 'Amortizare echipamente',
            },
          ],
        },
      ],
    },
  ];
  const service = (amount: string, tax: string, currency?: string) => ({
    account: '704',
    product: 'SRV-CONS',
    description: 'Servicii de consultanță',
    quantity: '1',
    unitPrice: amount,
    amount,
    ...(currency && { currency: { code: 'EUR', amount: currency, rate: '5.08' } }),
    tax: [vat(amount, tax, euro && currency ? '84.00' : undefined)],
  });
  return {
    type,
    period: { year: 2026, month: months[2] },
    created: '2026-11-10',
    software: { company: 'xFactura', name: 'xFactura', version: '0.0.1' },
    company: {
      cui: '18547290',
      name: 'Exemplu Servicii SRL',
      address: {
        street: 'Str. Lungă',
        number: '10',
        city: 'Galați',
        postalCode: '800001',
        county: 'RO-GL',
        country: 'RO',
      },
      contact: {
        firstName: 'Ana',
        lastName: 'Popescu',
        phone: '0236000000',
        email: 'contabil@example.ro',
      },
      ibans: ['RO49AAAA1B31007593840000'],
      vatRegime: '100010',
    },
    accounts: [
      { code: '1012', description: 'Capital subscris vărsat', opening: '-200.00' },
      { code: '1171', description: 'Rezultatul reportat', opening: '-28620.00' },
      { code: '2131', description: 'Echipamente tehnologice', opening: '12000.00' },
      { code: '2813', description: 'Amortizarea instalațiilor', opening: '-2000.00' },
      { code: '401.01', description: 'Furnizori interni', opening: '-1210.00' },
      { code: '4111.01', description: 'Clienți interni', opening: '2420.00' },
      { code: '421', description: 'Personal - salarii datorate', opening: '0' },
      { code: '4315', description: 'Contribuția de asigurări sociale', opening: '0' },
      { code: '4316', description: 'Contribuția de asigurări sociale de sănătate', opening: '0' },
      { code: '436', description: 'Contribuția asiguratorie pentru muncă', opening: '0' },
      { code: '4426', description: 'TVA deductibilă', opening: '0' },
      { code: '4427', description: 'TVA colectată', opening: '0' },
      { code: '444', description: 'Impozitul pe venituri de natura salariilor', opening: '0' },
      { code: '5121', description: 'Conturi la bănci în lei', opening: '30000.00' },
      {
        code: '628',
        description: 'Alte cheltuieli cu serviciile executate de terți',
        opening: '9000.00',
      },
      { code: '641', description: 'Cheltuieli cu salariile personalului', opening: '36000.00' },
      {
        code: '646',
        description: 'Cheltuieli privind contribuția asiguratorie pentru muncă',
        standard: '6461',
        opening: '810.00',
      },
      {
        code: '6811',
        description: 'Cheltuieli de exploatare privind amortizarea imobilizărilor',
        opening: '1800.00',
      },
      { code: '704', description: 'Venituri din servicii prestate', opening: '-60000.00' },
    ],
    customers: [
      {
        id: customer,
        name: 'Client Test SRL',
        address: {
          street: 'Bd. Unirii',
          number: '5',
          city: 'București',
          county: 'RO-B',
          country: 'RO',
        },
        account: '4111.01',
        opening: '2420.00',
      },
    ],
    suppliers: [
      {
        id: supplier,
        name: 'Furnizor Test SRL',
        address: {
          street: 'Str. Morii',
          number: '2',
          city: 'Brăila',
          county: 'RO-BR',
          country: 'RO',
        },
        account: '401.01',
        opening: '-1210.00',
      },
    ],
    products: [
      { code: 'SRV-CONS', description: 'Servicii de consultanță', kind: 'services', unit: 'E48' },
      { code: 'SRV-HOST', description: 'Servicii de găzduire', kind: 'services', unit: 'E48' },
    ],
    journals,
    salesInvoices: [
      {
        number: 'XF-101',
        party: customer,
        date: `${first}-05`,
        type: '380',
        transaction: 'VZ-101',
        lines: [service('1000.00', '210.00')],
      },
      {
        number: 'XF-102',
        party: customer,
        date: `${second}-20`,
        type: '380',
        transaction: 'VZ-102',
        lines: [service(second2.net, second2.vat, euro ? '400.00' : undefined)],
      },
    ],
    purchaseInvoices: [
      {
        number: 'F-7781',
        party: supplier,
        date: `${second}-08`,
        type: '380',
        transaction: 'CP-7781',
        lines: [
          {
            account: '628',
            product: 'SRV-HOST',
            description: 'Servicii de găzduire',
            quantity: '1',
            unitPrice: '500.00',
            amount: '500.00',
            tax: [{ type: '300', code: '301104', base: '500.00', amount: '105.00' }],
          },
        ],
      },
    ],
    payments: [
      {
        reference: 'OP-1',
        date: `${last}-15`,
        mechanism: '42',
        description: 'Încasare XF-099',
        direction: 'collection',
        transaction: 'BC-15',
        lines: [{ account: '4111.01', customer, document: 'XF-099', amount: '2420.00' }],
      },
      {
        reference: 'OP-2',
        date: `${last}-16`,
        mechanism: '42',
        description: 'Plată F-7700',
        direction: 'payment',
        transaction: 'BC-16',
        lines: [{ account: '401.01', supplier, document: 'F-7700', amount: '1210.00' }],
      },
    ],
  };
}

/**
 * April 2026 with a finance lease's instalment, as the engine books it (a lease settled in lei at
 * the euro's rate, a car half deducted): principal 300.00 EUR = 1,512.00 lei and interest 403.20
 * lei, both at 21% (402.19 VAT, split 317.52 / 84.67, half deducted under the 50% code 341104).
 * The principal releases 1,515.00 from 167 at its carrying amount, in lei; the 3.00 gain goes to
 * 768 and the 158.76 VAT not deducted on the principal to 635, neither a base line. One rate spans
 * two accounts: each invoice line keeps the account of its part.
 */
function leaseMonth(): D406 {
  const model = period('L', [4, 4, 4]);
  model.accounts.push(
    { code: '167', description: 'Alte împrumuturi și datorii asimilate', opening: '-100000.00' },
    { code: '2133', description: 'Mijloace de transport', opening: '100000.00' },
    { code: '404', description: 'Furnizori de imobilizări', opening: '0' },
    {
      code: '635',
      description: 'Cheltuieli cu alte impozite și taxe',
      standard: '635',
      opening: '0',
    },
    { code: '666', description: 'Cheltuieli privind dobânzile', opening: '0' },
    { code: '768', description: 'Alte venituri financiare', opening: '0' },
  );
  model.accounts.sort((a, b) => (a.code < b.code ? -1 : 1));
  model.suppliers.push({ ...model.suppliers[0]!, account: '404', opening: '0' });
  model.products.push(
    { code: 'LS-CAPITAL', description: 'Rata de capital', kind: 'services', unit: 'C62' },
    { code: 'LS-DOBANDA', description: 'Dobânda', kind: 'services', unit: 'C62' },
  );
  const half = (base: string, amount: string) => [{ type: '300', code: '341104', base, amount }];
  model.journals[1]!.transactions.push({
    id: 'CP-LS-0001',
    date: '2026-04-01',
    description: 'Factura LS-0001 Furnizor Test SRL',
    lines: [
      {
        id: 'CP-LS-1',
        account: '167',
        side: 'debit',
        amount: '1515.00',
        document: 'LS-0001',
        description: 'Rata de capital',
        tax: half('1512.00', '317.52'),
      },
      {
        id: 'CP-LS-2',
        account: '635',
        side: 'debit',
        amount: '158.76',
        document: 'LS-0001',
        description: 'TVA nededusă',
      },
      {
        id: 'CP-LS-3',
        account: '768',
        side: 'credit',
        amount: '3.00',
        document: 'LS-0001',
        description: 'Diferență de curs la rata de leasing',
      },
      {
        id: 'CP-LS-4',
        account: '666',
        side: 'debit',
        amount: '445.53',
        document: 'LS-0001',
        description: 'Dobânda',
        tax: half('403.20', '84.67'),
      },
      {
        id: 'CP-LS-5',
        account: '4426',
        side: 'debit',
        amount: '201.10',
        document: 'LS-0001',
        description: 'TVA deductibilă',
      },
      {
        id: 'CP-LS-6',
        account: '404',
        side: 'credit',
        amount: '2317.39',
        supplier,
        document: 'LS-0001',
        description: 'Furnizor Test SRL',
      },
    ],
  });
  const line = (
    account: string,
    product: string,
    description: string,
    net: string,
    vat: string,
  ) => ({
    account,
    product,
    description,
    quantity: '1',
    unitPrice: net,
    amount: net,
    tax: half(net, vat),
  });
  model.purchaseInvoices.push({
    number: 'LS-0001',
    party: supplier,
    account: '404',
    date: '2026-04-01',
    type: '380',
    transaction: 'CP-LS-0001',
    lines: [
      line('167', 'LS-CAPITAL', 'Rata de capital', '1512.00', '317.52'),
      line('666', 'LS-DOBANDA', 'Dobânda', '403.20', '84.67'),
    ],
  });
  return model;
}

/** A month without customers, as a shop selling only on Z reports has: the Customers section
 * empty (ANAF's definitions MF.C.1, Customer 0..*). */
function withoutCustomers(): D406 {
  const model = period('L', [10, 10, 10]);
  const strip = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(strip)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([key]) => key !== 'customer')
              .map(([key, item]) => [key, strip(item)]),
          )
        : value;
  return {
    ...model,
    customers: [],
    salesInvoices: [],
    payments: model.payments.filter((payment) => !JSON.stringify(payment).includes(customer)),
    journals: strip(model.journals) as D406Journal[],
  };
}

/**
 * A quarter with domestic sales and sales declared in the Union scheme (D398): an e-course and an
 * e-newspaper on one invoice to a German consumer (400 € at 19% and 100 € at 7%, at 5,06) and a
 * French course (1.000 € at 20%, at 5,07), each consumer a customer of its own (04 and a code of
 * the books), the VAT owed in euro on 4423; the French course half credited in red in the same
 * quarter (500 € at 20%, at 5,08). 310340 at each consumer state's rate (sheet Livrari: "În
 * funcție de Cota TVA din statul membru în care sa fac livrările"), the TaxTable listing it once
 * per state and rate with the state as its Country (`ro.d406.oss`).
 */
function unionSchemeQuarter(): D406 {
  const model = period('T', [7, 8, 9]);
  const german = d406PartyId({ kind: 'internal', code: 'A1B2C3D4E5F6' });
  const french = d406PartyId({ kind: 'internal', code: 'F6E5D4C3B2A1' });
  const eur = (amount: string, rate: string) => ({ currency: { code: 'EUR', amount, rate } });
  const oss = (base: string, amount: string, percentage: string, country: string) => ({
    type: '300',
    code: '310340',
    percentage,
    country,
    base,
    amount,
  });
  const sale = (
    id: string,
    date: string,
    party: string,
    gross: [string, string],
    vat: [string, string],
    rate: string,
    revenue: string,
    taxes: ReturnType<typeof oss>[],
  ) => ({
    id,
    date,
    description: `Factura ${id} consumator (OSS)`,
    lines: [
      {
        id: `${id}-1`,
        account: '4111.01',
        side: 'debit' as const,
        amount: gross[0],
        ...eur(gross[1], rate),
        customer: party,
        document: id,
        description: 'Consumator',
      },
      {
        id: `${id}-2`,
        account: '704',
        side: 'credit' as const,
        amount: revenue,
        document: id,
        description: 'Curs online',
        tax: taxes,
      },
      {
        id: `${id}-3`,
        account: '4423',
        side: 'credit' as const,
        amount: vat[0],
        ...eur(vat[1], rate),
        document: id,
        description: 'TVA prin regimul special Uniune (D398)',
      },
    ],
  });
  const de19 = oss('2024.00', '384.56', '19', 'DE');
  const de7 = oss('506.00', '35.42', '7', 'DE');
  const fr20 = oss('5070.00', '1014.00', '20', 'FR');
  const credit = oss('-2540.00', '-508.00', '20', 'FR');
  model.accounts.push({ code: '4423', description: 'TVA de plată', opening: '0' });
  model.customers.push(
    ...[
      [german, 'Berlin', 'DE'],
      [french, 'Lyon', 'FR'],
    ].map(([id, city, country]) => ({
      id: id!,
      name: 'Consumator',
      address: { city: city!, country: country! },
      account: '4111.01',
      opening: '0',
    })),
  );
  model.journals[0]!.transactions.push(
    sale(
      'EX-9',
      '2026-07-10',
      german,
      ['2949.98', '583.00'],
      ['419.98', '83.00'],
      '5.06',
      '2530.00',
      [de19, de7],
    ),
    sale(
      'EX-11',
      '2026-08-10',
      french,
      ['6084.00', '1200.00'],
      ['1014.00', '200.00'],
      '5.07',
      '5070.00',
      [fr20],
    ),
    sale(
      'CN-1',
      '2026-09-12',
      french,
      ['-3048.00', '-600.00'],
      ['-508.00', '-100.00'],
      '5.08',
      '-2540.00',
      [credit],
    ),
  );
  const invoice = (
    number: string,
    date: string,
    party: string,
    type: string,
    lines: [string, ReturnType<typeof oss>][],
  ) => ({
    number,
    party,
    date,
    type,
    transaction: number,
    lines: lines.map(([amount, tax]) => ({
      account: '704',
      product: 'CURS',
      description: 'Curs online',
      quantity: amount.startsWith('-') ? '-1' : '1',
      unitPrice: amount.replace('-', ''),
      amount,
      tax: [tax],
    })),
  });
  model.products.push({ code: 'CURS', description: 'Curs online', kind: 'services', unit: 'E48' });
  model.salesInvoices.push(
    invoice('EX-9', '2026-07-10', german, '380', [
      ['2024.00', de19],
      ['506.00', de7],
    ]),
    invoice('EX-11', '2026-08-10', french, '380', [['5070.00', fr20]]),
    invoice('CN-1', '2026-09-12', french, '381', [['-2540.00', credit]]),
  );
  return model;
}

const files: Record<string, D406> = {
  'month-2026-10': period('L', [10, 10, 10]),
  'month-2026-10-eur': period('L', [10, 10, 10], true),
  'quarter-2026-q3': period('T', [7, 8, 9]),
  'month-2026-04-lease': leaseMonth(),
  'quarter-2026-q3-oss': unionSchemeQuarter(),
};

/** xmllint against the published XSD, whose target namespace is D406T's; the periodic file is in
 * the D406 namespace, so a copy of the schema is retargeted. */
async function schemaErrors(documents: Record<string, string>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'xfactura-d406-xsd-'));
  try {
    const schemaFile = path.join(directory, 'd406.xsd');
    const source = await readFile(xsd, 'utf8');
    await writeFile(
      schemaFile,
      source.replaceAll('mfp:anaf:dgti:d406t:declaratie:v1', 'mfp:anaf:dgti:d406:declaratie:v1'),
    );
    const results: Record<string, string[]> = {};
    for (const [name, xml] of Object.entries(documents)) {
      const file = path.join(directory, `${name}.xml`);
      await writeFile(file, xml);
      const output = await $`xmllint --noout --nonet --schema ${schemaFile} ${file}`
        .nothrow()
        .quiet();
      results[name] = output.stderr
        .toString()
        .split('\n')
        .filter((line) => line && !line.endsWith(' validates'));
    }
    return results;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Replaces the first `from` after `marker`, which must both be there. */
function mutate(source: string, marker: string, from: string, to: string) {
  const at = source.indexOf(marker);
  const index = source.indexOf(from, at);
  if (at < 0 || index < 0) throw new Error(`${marker} … ${from} is not in the file`);
  return source.slice(0, index) + to + source.slice(index + from.length);
}

/** Files the validator rejects, and files it accepts that ANAF's consistency tests (15, 16)
 * reject after filing: the validator does not check the entries' balance, the totals or the
 * currency conversion (a line 500 lei off its EUR amount × rate passes too). */
function mutations() {
  const xml = writeD406(files['month-2026-10']!);
  const euro = writeD406(files['month-2026-10-eur']!);
  return {
    // 4429 is not a subdivision of 442 in the standard chart.
    account: mutate(xml, '<nsSAFT:AccountID>4426', '4426', '4429'),
    cui: mutate(xml, '<nsSAFT:CustomerID>0014399840', '0014399840', '0014399841'),
    conversion: mutate(euro, '<nsSAFT:RecordID>VZ-102-2', '2032.00', '2033.00'),
    period: mutate(xml, '<nsSAFT:SelectionStartDate>', '2026-10-01', '2026-09-01'),
    'wrong-total': mutate(xml, '<nsSAFT:GeneralLedgerEntries>', '14434.00', '14435.00'),
    // The depreciation entry's credit, in lei and in its currency side.
    unbalanced: mutate(
      mutate(xml, '<nsSAFT:RecordID>AM-10-2', '100.00', '90.00'),
      '<nsSAFT:RecordID>AM-10-2',
      '100.00',
      '90.00',
    ),
  };
}

describe('official D406 validation', () => {
  test('the synthetic files pass checkD406, which rejects what the mutations change', () => {
    for (const model of Object.values(files)) expect(checkD406(model)).toEqual([]);
    const unbalanced = structuredClone(files['month-2026-10']!);
    unbalanced.journals[3]!.transactions[1]!.lines[1]!.amount = '90.00';
    expect(checkD406(unbalanced).map((check) => check.code)).toEqual(['D406_UNBALANCED']);
    const euro = structuredClone(files['month-2026-10-eur']!);
    euro.journals[0]!.transactions[1]!.lines[1]!.amount = '2033.00';
    expect(checkD406(euro).map((check) => check.code)).toContain('D406_CONVERSION');
    expect(Object.keys(mutations())).toHaveLength(6);
  });

  schema('the synthetic files are valid against ANAF schema 2.4.9', async () => {
    const results = await schemaErrors(
      Object.fromEntries(Object.entries(files).map(([name, model]) => [name, writeD406(model)])),
    );
    expect(results).toEqual(Object.fromEntries(Object.keys(files).map((name) => [name, []])));
  });

  validator(
    'DUKIntegrator accepts the monthly, euro, quarterly, lease and Union scheme files without errors or warnings',
    async () => {
      const results = await validateAnaf(
        'D406',
        Object.fromEntries(Object.entries(files).map(([name, model]) => [name, writeD406(model)])),
        saftDuk,
      );
      expect(results).toEqual(Object.fromEntries(Object.keys(files).map((name) => [name, 'ok'])));
    },
    180_000,
  );

  validator(
    'DUKIntegrator accepts a month without customers, or without any invoice and product',
    async () => {
      const model = withoutCustomers();
      const bare = { ...model, purchaseInvoices: [], products: [] };
      expect([checkD406(model), checkD406(bare)]).toEqual([[], []]);
      const results = await validateAnaf(
        'D406',
        { shop: writeD406(model), bare: writeD406(bare) },
        saftDuk,
      );
      expect(results).toEqual({ shop: 'ok', bare: 'ok' });
    },
    180_000,
  );

  validator(
    'DUKIntegrator rejects what its rules cover; balances, totals and conversions are left to checkD406',
    async () => {
      const results = await validateAnaf('D406', mutations(), saftDuk);
      expect(results.account).toContain('planul de conturi');
      expect(results.cui).toContain('formatul este invalid');
      expect(results.period).toContain('nu corespunde cu perioada declarata');
      // Once a file has an error, DUKIntegrator also lists the 21% codes (in its parameters for
      // periods from 2025-07) as "nu se afla in lista"; the files without errors pass with them.
      expect(results.account).toContain("valoarea '310344' nu se afla in lista");
      expect(results.conversion).toBe('ok');
      expect(results['wrong-total']).toBe('ok');
      expect(results.unbalanced).toBe('ok');
    },
    180_000,
  );
});

/**
 * The financial year 2026's fixed-asset register: a laptop bought in August (6,000.00 over 36
 * months, from September: 166.67, 166.66, 166.67, 166.67), a car held all year (60,000.00 over 60 months, 9,000.00
 * depreciated by 2025) and a machine sold on 15 June (12,000.00 over 48 months, 3,000.00 by 2025,
 * 1,500.00 to June, sold for 9,000.00: a gain of 1,500.00 on its net 7,500.00).
 */
function assetsYear(): D406Assets {
  const own = { id: '0018547290', name: 'Exemplu Servicii SRL', address: periodic.company.address };
  const vendor = {
    id: supplier,
    name: 'Furnizor Test SRL',
    address: { street: 'Str. Morii', number: '2', city: 'Brăila', county: 'RO-BR', country: 'RO' },
  };
  const monthly = (
    asset: string,
    amount: string,
    months: string[],
    first: number,
  ): D406AssetTransaction[] =>
    months.map((date, index) => ({
      id: `AM-${asset}-${date.slice(0, 7)}`,
      asset,
      type: '30',
      description: 'Amortizare',
      date,
      supplier: own,
      transaction: `AM-${first + index}`,
      cost: '0.00',
      bookValue: `-${amount}`,
      amount: `-${amount}`,
    }));
  const ends = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, index) => {
      const month = from + index;
      const day = new Date(Date.UTC(2026, month, 0)).getUTCDate();
      return `2026-${String(month).padStart(2, '0')}-${day}`;
    });
  return {
    year: { start: '2026-01-01', end: '2026-12-31' },
    created: '2027-03-10',
    software: periodic.software,
    company: periodic.company,
    presentation: { percentage: 'percent', disposal: 'gross' },
    accounts: [
      { code: '2131', description: 'Echipamente tehnologice', opening: '12000.00', closing: '0' },
      {
        code: '2133',
        description: 'Mijloace de transport',
        opening: '60000.00',
        closing: '60000.00',
      },
      {
        code: '214',
        description: 'Mobilier, aparatură birotică',
        opening: '0',
        closing: '6000.00',
      },
      {
        code: '2813',
        description: 'Amortizarea instalațiilor',
        opening: '-12000.00',
        closing: '-21000.00',
      },
      {
        code: '2814',
        description: 'Amortizarea altor imobilizări',
        opening: '0',
        closing: '-666.67',
      },
    ],
    assets: [
      {
        id: 'MF-001',
        account: '214',
        depreciationAccount: '2814',
        description: 'Laptop',
        supplier: vendor,
        acquired: '2026-08-10',
        commissioned: '2026-08-10',
        catalogCode: '2.2.9',
        lifeMonths: 36,
        costBegin: '0.00',
        depreciationBegin: '0.00',
        addition: '6000.00',
        disposal: '0.00',
        depreciation: '666.67',
        depreciationRemoved: '0.00',
      },
      {
        id: 'MF-002',
        account: '2133',
        depreciationAccount: '2813',
        description: 'Autoturism',
        acquired: '2025-03-02',
        commissioned: '2025-03-02',
        catalogCode: '2.3.2.1.1',
        lifeMonths: 60,
        costBegin: '60000.00',
        depreciationBegin: '9000.00',
        addition: '0.00',
        disposal: '0.00',
        depreciation: '12000.00',
        depreciationRemoved: '0.00',
      },
      {
        id: 'MF-003',
        account: '2131',
        depreciationAccount: '2813',
        description: 'Utilaj',
        supplier: vendor,
        acquired: '2024-12-10',
        commissioned: '2024-12-10',
        catalogCode: '2.1.16.1',
        lifeMonths: 48,
        costBegin: '12000.00',
        depreciationBegin: '3000.00',
        addition: '0.00',
        disposal: '12000.00',
        depreciation: '1500.00',
        depreciationRemoved: '4500.00',
      },
    ],
    transactions: [
      {
        id: 'IN-MF-001',
        asset: 'MF-001',
        type: '10',
        description: 'Achiziție',
        date: '2026-08-10',
        supplier: vendor,
        transaction: 'CP-12',
        cost: '6000.00',
        bookValue: '6000.00',
        amount: '6000.00',
      },
      ...monthly('MF-001', '166.67', ends(9, 9), 109),
      ...monthly('MF-001', '166.66', ends(10, 10), 110),
      ...monthly('MF-001', '166.67', ends(11, 12), 111),
      ...monthly('MF-002', '1000.00', ends(1, 12), 1),
      ...monthly('MF-003', '250.00', ends(1, 6), 13),
      {
        id: 'OUT-MF-003',
        asset: 'MF-003',
        type: '20',
        description: 'Vânzare',
        date: '2026-06-15',
        supplier: own,
        transaction: 'IM-3',
        cost: '0.00',
        bookValue: '-7500.00',
        amount: '1500.00',
      },
    ],
  };
}
const periodic = period('L', [10, 10, 10]);

/** The annual file in the schema's d406 namespace, through the same retargeted copy of the XSD. */
const annualFiles = () => ({
  'assets-2026': writeD406Assets(assetsYear()),
  'assets-2026-fraction-net': writeD406Assets({
    ...assetsYear(),
    presentation: { percentage: 'fraction', disposal: 'net' },
  }),
});

describe('official D406 annual assets file', () => {
  test('checkD406Assets accepts the register and refuses one that disagrees with its accounts', () => {
    expect(checkD406Assets(assetsYear())).toEqual([]);
    const missing = assetsYear();
    missing.assets.pop();
    missing.transactions = missing.transactions.filter((item) => item.asset !== 'MF-003');
    expect(checkD406Assets(missing).map((check) => check.code)).toEqual([
      'D406A_REGISTER',
      'D406A_REGISTER',
    ]);
    const short = { ...assetsYear(), year: { start: '2026-06-10', end: '2026-12-31' } };
    expect(checkD406Assets(short).map((check) => check.code)).toContain('D406A_YEAR');
    const depreciation = assetsYear();
    depreciation.transactions = depreciation.transactions.slice(0, -2);
    expect(checkD406Assets(depreciation).map((check) => check.code)).toEqual([
      'D406A_TRANSACTIONS',
      'D406A_TRANSACTIONS',
    ]);
  });

  test('writes the values as ANAF answers and examples read them', async () => {
    const xml = writeD406Assets(assetsYear());
    const machine = xml.slice(xml.indexOf('<nsSAFT:AssetID>MF-003'));
    for (const [element, value] of [
      ['AcquisitionAndProductionCostsBegin', '12000.00'],
      ['AcquisitionAndProductionCostsEnd', '0.00'],
      ['AssetLifeYear', '4'],
      ['AssetDisposal', '-12000.00'],
      ['BookValueBegin', '9000.00'],
      ['DepreciationPercentage', '25.00'],
      ['DepreciationForPeriod', '-1500.00'],
      ['AccumulatedDepreciation', '0.00'],
      ['BookValueEnd', '0.00'],
    ])
      expect(machine).toContain(`<nsSAFT:${element}>${value}</nsSAFT:${element}>`);
    expect(xml).toContain('<nsSAFT:HeaderComment>A</nsSAFT:HeaderComment>');
    expect(xml).toContain(
      '<nsSAFT:NumberOfAssetTransactions>24</nsSAFT:NumberOfAssetTransactions>',
    );
    expect(annualFiles()['assets-2026-fraction-net']).toContain(
      '<nsSAFT:DepreciationPercentage>0.2500</nsSAFT:DepreciationPercentage>',
    );
  });

  schema('the annual files are valid against ANAF schema 2.4.9', async () => {
    const files = annualFiles();
    expect(await schemaErrors(files)).toEqual(
      Object.fromEntries(Object.keys(files).map((name) => [name, []])),
    );
  });

  validator(
    'DUKIntegrator accepts the annual files, and rejects a short year, an unknown movement and assets in a monthly file',
    async () => {
      const xml = writeD406Assets(assetsYear());
      const results = await validateAnaf(
        'D406',
        {
          ...annualFiles(),
          short: mutate(xml, '<nsSAFT:SelectionStartDate>', '2026-01-01', '2026-06-01'),
          movement: mutate(xml, '<nsSAFT:AssetTransactionType>', '10', '15'),
          monthly: mutate(xml, '<nsSAFT:HeaderComment>', 'A<', 'L<'),
        },
        saftDuk,
      );
      expect([results['assets-2026'], results['assets-2026-fraction-net']]).toEqual(['ok', 'ok']);
      expect(results.short).toContain('Tipul declaratiei A nu corespunde cu perioada declarata');
      expect(results.movement).toContain("valoarea '15' nu se afla in lista");
      expect(results.monthly).toContain("elementul 'AssetID' a depasit numarul maxim de aparitii");
    },
    180_000,
  );
});
