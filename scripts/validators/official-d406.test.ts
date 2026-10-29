// Runs ANAF's D406 (SAF-T) validator and the published schema over the writer's synthetic files,
// and over mutations that must be rejected. The validator runs when DUKIntegrator can load it: the
// D406 validator needs the `dec` library of the SAF-T kit (dec/DECTagStruct), which the general
// DUKIntegrator kit lacks. Without it, Java or xmllint the tests are skipped, never passed.
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { $ } from 'bun';
import { anaf, duk, validateAnaf } from './anaf';
import {
  checkD406,
  d406PartyId,
  writeD406,
  type D406,
  type D406Journal,
} from '../../packages/xfactura-core/src/ro/saft/d406';

const root = path.join(import.meta.dir, '../..');
const xsd = path.join(root, '.sources/ANAF_D406/Ro_SAFT_Schema_v249_2025.xsd');
const dec = path.join(duk, 'lib/DecValidation.jar');
const loadable =
  existsSync(dec) &&
  Bun.which('unzip') !== null &&
  Bun.spawnSync(['unzip', '-l', dec]).stdout.toString().includes('dec/DECTagStruct.class');
const validator = loadable ? anaf : test.skip;
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

const files: Record<string, D406> = {
  'month-2026-10': period('L', [10, 10, 10]),
  'month-2026-10-eur': period('L', [10, 10, 10], true),
  'quarter-2026-q3': period('T', [7, 8, 9]),
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
 * reject after filing: the validator only reads balances and totals. */
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
    'DUKIntegrator accepts the monthly, euro and quarterly files without errors or warnings',
    async () => {
      const results = await validateAnaf(
        'D406',
        Object.fromEntries(Object.entries(files).map(([name, model]) => [name, writeD406(model)])),
      );
      expect(results).toEqual(Object.fromEntries(Object.keys(files).map((name) => [name, 'ok'])));
    },
    180_000,
  );

  validator(
    'DUKIntegrator rejects what its rules cover; balances and totals are left to checkD406',
    async () => {
      const results = await validateAnaf('D406', mutations());
      expect(results.account).toContain('planul de conturi');
      expect(results.cui).toContain('formatul este invalid');
      expect(results.conversion).toContain('CurrencyAmount x ExchangeRate');
      expect(results.period).toContain('nu corespunde cu perioada declarata');
      expect(results['wrong-total']).toBe('ok');
      expect(results.unbalanced).toBe('ok');
    },
    180_000,
  );
});
