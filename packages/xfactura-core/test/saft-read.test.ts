import { describe, expect, test } from 'bun:test';
import { DomainError } from '../src/errors';
import {
  calculateD406,
  d406LineParts,
  d406Namespace,
  d406PartyId,
  writeD406,
  type D406,
  type D406Line,
  type D406Transaction,
} from '../src/ro/saft/d406';
import { roRegister } from '../src/ro/register';
import { RuleContext } from '../src/rules';
import { writeD406Assets, type D406Assets } from '../src/ro/saft/assets';
import { writeD406Stock, type D406Stock } from '../src/ro/saft/stock';
import {
  checkD406Accounts,
  checkD406Balances,
  checkD406Filed,
  checkD406Partners,
  checkD406Totals,
  readD406,
  toD406,
} from '../src/ro/saft/read';

const utf8 = (xml: string) => new TextEncoder().encode(xml);
const customer = d406PartyId({ kind: 'ro', cui: '14399840' });
const supplier = d406PartyId({ kind: 'ro', cui: '31552803' });

const line = (
  id: string,
  account: string,
  side: D406Line['side'],
  amount: string,
  extra: Partial<D406Line> = {},
): D406Line => ({ id, account, side, amount, description: `Linia ${id}`, ...extra });

const vat = (base: string, amount: string, code = '310344') => ({
  type: '300',
  code,
  base,
  amount,
});

const sale: D406Transaction = {
  id: 'VZ-1',
  date: '2026-10-05',
  description: 'Factura XF-1',
  lines: [
    line('1', '4111.01', 'debit', '1210.00', { customer, document: 'XF-1' }),
    line('2', '704', 'credit', '1000.00', { tax: [vat('1000.00', '210.00')] }),
    line('3', '4427', 'credit', '210.00'),
  ],
};

const purchase: D406Transaction = {
  id: 'CP-1',
  date: '2026-10-08',
  description: 'Factura F-1',
  lines: [
    line('4', '628', 'debit', '500.00', { tax: [vat('500.00', '105.00', '301104')] }),
    line('5', '4426', 'debit', '105.00'),
    line('6', '401.01', 'credit', '605.00', { supplier }),
  ],
};

const receipt: D406Transaction = {
  id: 'BC-1',
  date: '2026-10-15',
  description: 'Încasare XF-0',
  lines: [
    line('7', '5121', 'debit', '1000.00'),
    line('8', '4111.01', 'credit', '1000.00', { customer, document: 'XF-0' }),
  ],
};

const payroll: D406Transaction = {
  id: 'SAL-1',
  date: '2026-10-30',
  description: 'Stat de salarii',
  lines: [
    line('9', '641', 'debit', '4500.00'),
    line('10', '421', 'credit', '4500.00'),
    line('11', '421', 'debit', '1125.00'),
    line('12', '4315', 'credit', '1125.00', {
      tax: [{ type: '412', code: '000000', base: '4500.00', amount: '1125.00' }],
    }),
    line('13', '646', 'debit', '101.00'),
    line('14', '436', 'credit', '101.00'),
  ],
};

// Unchanged copy of the writer fixture from saft.test.ts (keeps '0' openings, etc.).
const writerModel = (extra: Partial<D406> = {}): D406 => ({
  type: 'L',
  period: { year: 2026, month: 10 },
  created: '2026-11-10',
  software: { company: 'xFactura', name: 'xFactura', version: '0.0.1' },
  company: {
    cui: '18547290',
    name: 'Exemplu Servicii SRL',
    address: { street: 'Str. Lungă', number: '10', city: 'Galați', county: 'RO-GL', country: 'RO' },
    contact: { firstName: 'Ana', lastName: 'Popescu', phone: '0236000000' },
    ibans: ['RO49AAAA1B31007593840000'],
    vatRegime: '100010',
  },
  accounts: [
    { code: '1012', description: 'Capital subscris vărsat', opening: '-200.00' },
    { code: '1171', description: 'Rezultatul reportat', opening: '-30000.00' },
    { code: '401.01', description: 'Furnizori', opening: '-800.00' },
    { code: '4111.01', description: 'Clienți', opening: '1000.00' },
    { code: '421', description: 'Salarii datorate', opening: '0' },
    { code: '4315', description: 'CAS', opening: '0' },
    { code: '436', description: 'CAM', opening: '0' },
    { code: '4426', description: 'TVA deductibilă', opening: '0' },
    { code: '4427', description: 'TVA colectată', opening: '0' },
    { code: '5121', description: 'Bancă', opening: '30000.00' },
    { code: '628', description: 'Servicii terți', opening: '0' },
    { code: '641', description: 'Salarii', opening: '0' },
    { code: '646', description: 'CAM', standard: '6461', opening: '0' },
    { code: '704', description: 'Venituri din servicii', opening: '0' },
  ],
  customers: [
    {
      id: customer,
      name: 'Client Test SRL',
      address: { city: 'București', county: 'RO-B', country: 'RO' },
      account: '4111.01',
      opening: '1000.00',
    },
  ],
  suppliers: [
    {
      id: supplier,
      name: 'Furnizor Test SRL',
      address: { city: 'Brăila', county: 'RO-BR', country: 'RO' },
      account: '401.01',
      opening: '-800.00',
    },
  ],
  products: [{ code: 'SRV', description: 'Servicii', kind: 'services', unit: 'E48' }],
  journals: [
    {
      id: 'J',
      description: 'Registru jurnal',
      type: 'J',
      transactions: [sale, purchase, receipt, payroll],
    },
  ],
  salesInvoices: [
    {
      number: 'XF-1',
      party: customer,
      date: '2026-10-05',
      type: '380',
      transaction: 'VZ-1',
      lines: [
        {
          account: '704',
          product: 'SRV',
          description: 'Servicii',
          quantity: '1',
          unitPrice: '1000.00',
          amount: '1000.00',
          tax: [vat('1000.00', '210.00')],
        },
      ],
    },
  ],
  purchaseInvoices: [
    {
      number: 'F-1',
      party: supplier,
      date: '2026-10-08',
      type: '380',
      lines: [
        {
          account: '628',
          description: 'Găzduire',
          quantity: '1',
          unit: 'H87',
          unitPrice: '500.00',
          amount: '500.00',
          tax: [vat('500.00', '105.00', '301104')],
        },
      ],
    },
  ],
  payments: [
    {
      reference: 'OP-1',
      date: '2026-10-15',
      mechanism: '42',
      description: 'Încasare XF-0',
      direction: 'collection',
      lines: [{ account: '4111.01', customer, document: 'XF-0', amount: '1000.00' }],
    },
  ],
  ...extra,
});

function saftDoc(body: {
  header?: string;
  masterFiles?: string;
  generalLedger?: string;
  sourceDocuments?: string;
}): Uint8Array {
  const header =
    body.header ??
    `<nsSAFT:Header>
    <nsSAFT:AuditFileVersion>2.0</nsSAFT:AuditFileVersion>
    <nsSAFT:AuditFileCountry>RO</nsSAFT:AuditFileCountry>
    <nsSAFT:AuditFileRegion>RO-GL</nsSAFT:AuditFileRegion>
    <nsSAFT:AuditFileDateCreated>2026-11-10</nsSAFT:AuditFileDateCreated>
    <nsSAFT:SoftwareCompanyName>Saga</nsSAFT:SoftwareCompanyName>
    <nsSAFT:SoftwareID>SAGA C</nsSAFT:SoftwareID>
    <nsSAFT:SoftwareVersion>100</nsSAFT:SoftwareVersion>
    <nsSAFT:Company>
      <nsSAFT:RegistrationNumber>RO18547290</nsSAFT:RegistrationNumber>
      <nsSAFT:Name>Exemplu SAGA SRL</nsSAFT:Name>
      <nsSAFT:Address>
        <nsSAFT:StreetName>Str. Exemplu</nsSAFT:StreetName>
        <nsSAFT:City>Galați</nsSAFT:City>
        <nsSAFT:PostalCode>800001</nsSAFT:PostalCode>
        <nsSAFT:Region>RO-GL</nsSAFT:Region>
        <nsSAFT:Country>RO</nsSAFT:Country>
        <nsSAFT:AddressType>PostalAddress</nsSAFT:AddressType>
      </nsSAFT:Address>
      <nsSAFT:Contact>
        <nsSAFT:ContactPerson>
          <nsSAFT:FirstName>Ion</nsSAFT:FirstName>
          <nsSAFT:LastName>Ionescu</nsSAFT:LastName>
          <nsSAFT:OtherTitles>ADMINISTRATOR</nsSAFT:OtherTitles>
        </nsSAFT:ContactPerson>
        <nsSAFT:Telephone>0236000000</nsSAFT:Telephone>
        <nsSAFT:Email>office@example.ro</nsSAFT:Email>
      </nsSAFT:Contact>
      <nsSAFT:TaxRegistration>
        <nsSAFT:TaxRegistrationNumber>J17/100/2020</nsSAFT:TaxRegistrationNumber>
        <nsSAFT:TaxType>100010</nsSAFT:TaxType>
        <nsSAFT:TaxNumber>18547290</nsSAFT:TaxNumber>
        <nsSAFT:TaxAuthority>ANAF</nsSAFT:TaxAuthority>
      </nsSAFT:TaxRegistration>
      <nsSAFT:BankAccount>
        <nsSAFT:IBANNumber>RO49AAAA1B31007593840000</nsSAFT:IBANNumber>
      </nsSAFT:BankAccount>
    </nsSAFT:Company>
    <nsSAFT:DefaultCurrencyCode>RON</nsSAFT:DefaultCurrencyCode>
    <nsSAFT:SelectionCriteria>
      <nsSAFT:SelectionStartDate>2026-10-01</nsSAFT:SelectionStartDate>
      <nsSAFT:SelectionEndDate>2026-10-31</nsSAFT:SelectionEndDate>
    </nsSAFT:SelectionCriteria>
    <nsSAFT:HeaderComment>L</nsSAFT:HeaderComment>
    <nsSAFT:SegmentIndex>1</nsSAFT:SegmentIndex>
    <nsSAFT:TotalSegmentsInsequence>1</nsSAFT:TotalSegmentsInsequence>
    <nsSAFT:TaxAccountingBasis>A</nsSAFT:TaxAccountingBasis>
  </nsSAFT:Header>`;

  const masterFiles =
    body.masterFiles ??
    `<nsSAFT:MasterFiles>
    <nsSAFT:GeneralLedgerAccounts>
      <nsSAFT:Account>
        <nsSAFT:AccountID>40100009</nsSAFT:AccountID>
        <nsSAFT:AccountDescription>Furnizor analitic</nsSAFT:AccountDescription>
        <nsSAFT:StandardAccountID>401.00009</nsSAFT:StandardAccountID>
        <nsSAFT:AccountCreationDate>2025-01-01</nsSAFT:AccountCreationDate>
        <nsSAFT:AccountType>Pasiv</nsSAFT:AccountType>
        <nsSAFT:OpeningCreditBalance>0.00</nsSAFT:OpeningCreditBalance>
        <nsSAFT:ClosingCreditBalance>0.00</nsSAFT:ClosingCreditBalance>
      </nsSAFT:Account>
      <nsSAFT:Account>
        <nsSAFT:AccountID>5121</nsSAFT:AccountID>
        <nsSAFT:AccountDescription>Bancă</nsSAFT:AccountDescription>
        <nsSAFT:StandardAccountID>5121</nsSAFT:StandardAccountID>
        <nsSAFT:AccountType>Activ</nsSAFT:AccountType>
        <nsSAFT:OpeningDebitBalance>1000.00</nsSAFT:OpeningDebitBalance>
        <nsSAFT:ClosingDebitBalance>1000.00</nsSAFT:ClosingDebitBalance>
      </nsSAFT:Account>
    </nsSAFT:GeneralLedgerAccounts>
    <nsSAFT:Customers/>
    <nsSAFT:Suppliers>
      <nsSAFT:Supplier>
        <nsSAFT:CompanyStructure>
          <nsSAFT:RegistrationNumber>${supplier}</nsSAFT:RegistrationNumber>
          <nsSAFT:Name>Furnizor Test SRL</nsSAFT:Name>
          <nsSAFT:Address>
            <nsSAFT:City>Brăila</nsSAFT:City>
            <nsSAFT:PostalCode>810001</nsSAFT:PostalCode>
            <nsSAFT:Region>RO-BR</nsSAFT:Region>
            <nsSAFT:Country>RO</nsSAFT:Country>
            <nsSAFT:AddressType>PostalAddress</nsSAFT:AddressType>
          </nsSAFT:Address>
        </nsSAFT:CompanyStructure>
        <nsSAFT:SupplierID>${supplier}</nsSAFT:SupplierID>
        <nsSAFT:SelfBillingIndicator>0</nsSAFT:SelfBillingIndicator>
        <nsSAFT:AccountID>40100009</nsSAFT:AccountID>
        <nsSAFT:OpeningCreditBalance>0.00</nsSAFT:OpeningCreditBalance>
        <nsSAFT:ClosingCreditBalance>0.00</nsSAFT:ClosingCreditBalance>
      </nsSAFT:Supplier>
    </nsSAFT:Suppliers>
    <nsSAFT:TaxTable/>
    <nsSAFT:UOMTable/>
    <nsSAFT:AnalysisTypeTable/>
    <nsSAFT:MovementTypeTable/>
    <nsSAFT:Products/>
    <nsSAFT:Owners/>
    <nsSAFT:Assets/>
  </nsSAFT:MasterFiles>`;

  const generalLedger =
    body.generalLedger ??
    `<nsSAFT:GeneralLedgerEntries>
    <nsSAFT:NumberOfEntries>0</nsSAFT:NumberOfEntries>
    <nsSAFT:TotalDebit>0.00</nsSAFT:TotalDebit>
    <nsSAFT:TotalCredit>0.00</nsSAFT:TotalCredit>
    <nsSAFT:Journal>
      <nsSAFT:JournalID>1</nsSAFT:JournalID>
      <nsSAFT:Description>Registru jurnal</nsSAFT:Description>
      <nsSAFT:Type>1</nsSAFT:Type>
    </nsSAFT:Journal>
  </nsSAFT:GeneralLedgerEntries>`;

  const sourceDocuments =
    body.sourceDocuments ??
    `<nsSAFT:SourceDocuments>
    <nsSAFT:SalesInvoices/>
    <nsSAFT:PurchaseInvoices/>
    <nsSAFT:Payments/>
    <nsSAFT:MovementOfGoods/>
  </nsSAFT:SourceDocuments>`;

  return utf8(`<?xml version="1.0" encoding="UTF-8"?>
<nsSAFT:AuditFile xmlns:nsSAFT="${d406Namespace}">
  ${header}
  ${masterFiles}
  ${generalLedger}
  ${sourceDocuments}
</nsSAFT:AuditFile>`);
}

function expectXmlRoundTrip(model: D406): void {
  const xml = writeD406(model);
  const filed = readD406(utf8(xml));
  expect(filed.unread).toEqual([]);
  expect(checkD406Filed(filed)).toEqual([]);

  const converted = toD406(filed);
  expect(converted.problems).toEqual([]);
  expect(converted.model).toBeDefined();
  expect(writeD406(converted.model!)).toBe(xml);
}

describe('D406 reader round trips (XML equivalence)', () => {
  test('XML equivalence: reading and converting every model built by saft.test.ts reproduces byte-identical XML with no problem', () => {
    const base = writerModel();
    expectXmlRoundTrip(base);

    // Foreign-currency lines (euro).
    expectXmlRoundTrip(
      writerModel({
        journals: [
          {
            id: 'J',
            description: 'J',
            type: 'J',
            transactions: [
              {
                ...receipt,
                lines: [
                  line('1', '5121', 'debit', '508.00'),
                  line('2', '4111.01', 'credit', '508.00', {
                    customer,
                    currency: { code: 'EUR', amount: '100.00', rate: '5.08' },
                  }),
                ],
              },
            ],
          },
        ],
        accounts: base.accounts.map((account) =>
          account.code === '5121'
            ? { ...account, opening: '29000.00' }
            : account.code === '4111.01'
              ? { ...account, opening: '2000.00' }
              : account,
        ),
        customers: [{ ...base.customers[0]!, opening: '2000.00' }],
      }),
    );

    // Intra-EU reverse charge (withEu).
    const eu = d406PartyId({ kind: 'eu', country: 'DE', vat: '123456789' });
    expectXmlRoundTrip(
      writerModel({
        accounts: [...base.accounts, { code: '401.02', description: 'Furnizori UE', opening: '0' }],
        suppliers: [
          ...base.suppliers,
          {
            id: eu,
            name: 'Beispiel GmbH',
            address: { city: 'Berlin', country: 'DE' },
            account: '401.02',
            opening: '0',
          },
        ],
        journals: [
          {
            ...base.journals[0]!,
            transactions: [
              ...base.journals[0]!.transactions,
              {
                id: 'CP-2',
                date: '2026-10-12',
                description: 'Factura DE-77 Beispiel GmbH',
                lines: [
                  line('20', '628', 'debit', '1000.00', {
                    tax: [vat('1000.00', '210.00', '300704')],
                  }),
                  line('21', '4426', 'debit', '210.00'),
                  line('22', '4427', 'credit', '210.00'),
                  line('23', '401.02', 'credit', '1000.00', { supplier: eu }),
                ],
              },
            ],
          },
        ],
        purchaseInvoices: [
          ...base.purchaseInvoices,
          {
            number: 'DE-77',
            party: eu,
            date: '2026-10-12',
            type: '380',
            lines: [
              {
                account: '628',
                description: 'Licențe software',
                quantity: '1',
                unitPrice: '1000.00',
                amount: '1000.00',
                tax: [vat('1000.00', '210.00', '300704')],
              },
            ],
          },
        ],
      }),
    );

    // Empty customers / invoices / payments / products & quarterly escaping.
    const withoutCustomers = writerModel({
      customers: [],
      salesInvoices: [],
      journals: [{ id: 'J', description: 'J', type: 'J', transactions: [purchase, payroll] }],
      payments: [],
    });
    expectXmlRoundTrip(withoutCustomers);
    expectXmlRoundTrip({ ...withoutCustomers, purchaseInvoices: [], products: [] });
    expectXmlRoundTrip(
      writerModel({
        type: 'T',
        period: { year: 2026, month: 12 },
        company: { ...base.company, name: 'Exemplu & Fiii <SRL>' },
      }),
    );

    // Account with explicit numeric AccountID overriding code.
    expectXmlRoundTrip(
      writerModel({
        accounts: [
          ...base.accounts,
          { code: '4111.CL', id: '411199', description: 'Clienți', opening: '0' },
        ],
      }),
    );

    // Multi-account customer (twice).
    expectXmlRoundTrip(
      writerModel({
        accounts: [
          ...base.accounts.map((account) =>
            account.code === '5121' ? { ...account, opening: '30100.00' } : account,
          ),
          { code: '419', description: 'Clienți creditori', opening: '-100.00' },
        ],
        customers: [
          ...base.customers,
          { ...base.customers[0]!, account: '419', opening: '-100.00' },
        ],
        journals: [
          {
            ...base.journals[0]!,
            transactions: [
              ...base.journals[0]!.transactions,
              {
                id: 'NC-1',
                date: '2026-10-20',
                description: 'Avans Client Test SRL',
                lines: [
                  line('30', '5121', 'debit', '300.00'),
                  line('31', '419', 'credit', '300.00', { customer, document: 'AV-1' }),
                ],
              },
            ],
          },
        ],
      }),
    );

    // Union scheme OSS 310340 + decimal rate '5.50' (normalized to '5.5' by writer) + OSS credit.
    const german = d406PartyId({ kind: 'internal', code: 'A1B2C3' });
    const french = d406PartyId({ kind: 'internal', code: 'D4E5F6' });
    const oss = (baseAmt: string, amount: string, percentage: string, country: string) => ({
      type: '300',
      code: '310340',
      percentage,
      country,
      base: baseAmt,
      amount,
    });
    const eur = (amount: string, rate: string) => ({ currency: { code: 'EUR', amount, rate } });
    const ossBase = writerModel({
      accounts: [...base.accounts, { code: '4423', description: 'TVA de plată', opening: '0' }],
      customers: [
        ...base.customers,
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
      ],
      journals: [
        {
          ...base.journals[0]!,
          transactions: [
            ...base.journals[0]!.transactions,
            {
              id: 'VZ-9',
              date: '2026-10-10',
              description: 'Factura EX-9 consumator DE (OSS)',
              lines: [
                line('30', '4111.01', 'debit', '2949.98', {
                  ...eur('583.00', '5.06'),
                  customer: german,
                }),
                line('31', '704', 'credit', '2530.00', {
                  tax: [oss('2024.00', '384.56', '19', 'DE'), oss('506.00', '35.42', '7', 'DE')],
                }),
                line('32', '4423', 'credit', '419.98', eur('83.00', '5.06')),
              ],
            },
            {
              id: 'VZ-11',
              date: '2026-10-12',
              description: 'Factura EX-11 consumator FR (OSS)',
              lines: [
                line('33', '4111.01', 'debit', '6084.00', {
                  ...eur('1200.00', '5.07'),
                  customer: french,
                }),
                line('34', '704', 'credit', '5070.00', {
                  tax: [oss('5070.00', '1014.00', '20', 'FR')],
                }),
                line('35', '4423', 'credit', '1014.00', eur('200.00', '5.07')),
              ],
            },
          ],
        },
      ],
      salesInvoices: [
        ...base.salesInvoices,
        {
          number: 'EX-9',
          party: german,
          date: '2026-10-10',
          type: '380',
          transaction: 'VZ-9',
          lines: [
            {
              account: '704',
              product: 'SRV',
              description: 'Curs online',
              quantity: '1',
              unitPrice: '2024.00',
              amount: '2024.00',
              tax: [oss('2024.00', '384.56', '19', 'DE')],
            },
            {
              account: '704',
              product: 'SRV',
              description: 'Curs online',
              quantity: '1',
              unitPrice: '506.00',
              amount: '506.00',
              tax: [oss('506.00', '35.42', '7', 'DE')],
            },
          ],
        },
        {
          number: 'EX-11',
          party: french,
          date: '2026-10-12',
          type: '380',
          transaction: 'VZ-11',
          lines: [
            {
              account: '704',
              product: 'SRV',
              description: 'Curs online',
              quantity: '1',
              unitPrice: '5070.00',
              amount: '5070.00',
              tax: [oss('5070.00', '1014.00', '20', 'FR')],
            },
          ],
        },
      ],
    });
    expectXmlRoundTrip(ossBase);

    const reducedOss = structuredClone(ossBase);
    reducedOss.journals[0]!.transactions.at(-1)!.lines[1]!.tax = [
      oss('5070.00', '278.85', '5.50', 'RO'),
    ];
    expectXmlRoundTrip(reducedOss);

    // Split foreign-currency lines (d406LineParts).
    const reading = new RuleContext(roRegister(), 'preview').param<{
      unrated: 'split' | 'lei';
      taxBase: 'tax' | 'line';
    }>('ro.d406.conversion', 'reporting_period_start', '2026-03-01' as never);
    const released = { code: 'EUR', amount: '605.00', rate: '4.9900' };
    expectXmlRoundTrip(
      writerModel({
        journals: [
          {
            id: 'J',
            description: 'J',
            type: 'J',
            transactions: [
              sale,
              purchase,
              {
                ...receipt,
                lines: [
                  line('R7', '5121', 'debit', '3018.95', {
                    currency: { code: 'EUR', amount: '605.00', rate: '4.9900' },
                  }),
                  ...d406LineParts(reading, '3015.04', released, '4.9850').map((part, index) =>
                    line(index ? 'R8.2' : 'R8', '4111.01', 'credit', part.amount, {
                      customer,
                      ...(part.currency ? { currency: part.currency } : {}),
                    }),
                  ),
                  line('R9', '7651', 'credit', '3.91'),
                ],
              },
              payroll,
            ],
          },
        ],
        accounts: [
          ...base.accounts.map((account) =>
            account.code === '4111.01' ? { ...account, opening: '1000.00' } : account,
          ),
          { code: '7651', description: 'Venituri din diferențe de curs', opening: '0' },
        ],
        customers: [{ ...base.customers[0]!, opening: '1000.00' }],
        salesInvoices: [],
        purchaseInvoices: [],
        payments: [],
      }),
    );

    // Payment refunding customer (Răspuns 21).
    expectXmlRoundTrip(
      writerModel({
        payments: [
          {
            reference: 'OP-9',
            date: '2026-10-20',
            mechanism: '42',
            description: 'Restituire CN-1',
            direction: 'payment',
            lines: [{ account: '4111.01', supplier: customer, document: 'CN-1', amount: '121.00' }],
          },
        ],
      }),
    );
  });

  test('XML equivalence: quarterly, FX, split currency, OSS 310340, multi-account partner, pro-rata baseRates and WHT', () => {
    const eu = d406PartyId({ kind: 'eu', country: 'DE', vat: '123456789' });
    const ossCustomer = d406PartyId({ kind: 'internal', code: 'A1B2C3' });
    const base = writerModel();
    const rich: D406 = {
      ...base,
      type: 'T',
      period: { year: 2026, month: 12 },
      company: {
        ...base.company,
        name: 'Exemplu & Fiii <SRL>',
        contact: { ...base.company.contact, email: 'ana@exemplu.ro' },
      },
      accounts: [
        ...base.accounts.map((a) =>
          a.code === '5121'
            ? { ...a, opening: '30100.00' }
            : a.code === '4111.01'
              ? { ...a, opening: '2000.00' }
              : a.code === '1171'
                ? { ...a, opening: '-31000.00' }
                : a,
        ),
        { code: '401.02', description: 'Furnizori UE', opening: '0.00' },
        { code: '419', description: 'Clienți creditori', opening: '-100.00' },
        { code: '4423', description: 'TVA de plată', opening: '0.00' },
        { code: '446', description: 'Impozit dividende', opening: '0.00' },
        { code: '457', description: 'Dividende de plată', opening: '0.00' },
        { code: '623', description: 'Protocol', standard: '6231', opening: '0.00' },
      ],
      customers: [
        { ...base.customers[0]!, opening: '2000.00' },
        { ...base.customers[0]!, account: '419', opening: '-100.00' },
        {
          id: ossCustomer,
          name: 'Consumator DE',
          address: { city: 'Berlin', country: 'DE' },
          account: '4111.01',
          opening: '0.00',
        },
      ],
      suppliers: [
        ...base.suppliers,
        {
          id: eu,
          name: 'Beispiel GmbH',
          address: { city: 'Berlin', country: 'DE' },
          account: '401.02',
          opening: '0.00',
        },
      ],
      products: [
        ...base.products,
        {
          code: 'MARFA',
          description: 'Laptop',
          kind: 'goods',
          unit: 'H87',
          commodityCode: '84713000',
        },
      ],
      journals: [
        {
          id: 'J',
          description: 'Registru jurnal',
          type: 'J',
          transactions: [
            ...base.journals[0]!.transactions,
            {
              id: 'FX-1',
              date: '2026-10-10',
              posted: '2026-10-11',
              entered: '2026-10-12',
              source: 'Import',
              description: 'Încasare EUR',
              lines: [
                line('20', '5121', 'debit', '508.00'),
                line('21', '4111.01', 'credit', '508.00', {
                  customer,
                  currency: { code: 'EUR', amount: '100.00', rate: '5.08' },
                }),
              ],
            },
            {
              id: 'PR-1',
              date: '2026-10-12',
              description: 'Protocol cu pro-rată',
              lines: [
                line('22', '623', 'debit', '1000.00', {
                  tax: [vat('1000.00', '210.00', '361104')],
                }),
                line('23', '4426', 'debit', '210.00'),
                line('24', '401.01', 'credit', '1210.00', { supplier }),
              ],
            },
            {
              id: 'OSS-1',
              date: '2026-10-18',
              description: 'Vânzare OSS DE',
              lines: [
                line('25', '4111.01', 'debit', '3010.70', {
                  customer: ossCustomer,
                  currency: { code: 'EUR', amount: '595.00', rate: '5.06' },
                }),
                line('26', '704', 'credit', '2530.00', {
                  tax: [
                    {
                      type: '300',
                      code: '310340',
                      percentage: '19',
                      country: 'DE',
                      base: '2530.00',
                      amount: '480.70',
                    },
                  ],
                }),
                line('27', '4423', 'credit', '480.70', {
                  currency: { code: 'EUR', amount: '95.00', rate: '5.06' },
                }),
              ],
            },
            {
              id: 'DIV-1',
              date: '2026-10-20',
              description: 'Reținere impozit dividende',
              lines: [
                line('28', '457', 'debit', '1000.00', {
                  tax: [{ type: '604', code: '604020', base: '1000.00', amount: '80.00' }],
                }),
                line('29', '446', 'credit', '80.00'),
                line('30', '457', 'credit', '920.00'),
              ],
            },
          ],
        },
      ],
      salesInvoices: [
        ...base.salesInvoices,
        {
          number: 'CN-1',
          party: customer,
          account: '419',
          date: '2026-10-16',
          type: '381',
          selfBilling: true,
          paymentTerms: '30 zile',
          lines: [
            {
              account: '704',
              product: 'MARFA',
              description: 'Storno',
              quantity: '1',
              unit: 'E48',
              unitPrice: '100.00',
              amount: '100.00',
              taxPointDate: '2026-10-17',
              side: 'debit',
              currency: { code: 'EUR', amount: '20.00', rate: '5.00' },
              tax: [
                {
                  type: '300',
                  code: '310344',
                  base: '100.20',
                  amount: '21.04',
                  currencyAmount: '4.20',
                  rate: '5.01',
                },
              ],
            },
          ],
        },
      ],
      payments: [
        ...base.payments,
        {
          reference: 'OP-2',
          date: '2026-10-20',
          mechanism: '10',
          description: 'Restituire client',
          direction: 'payment',
          transaction: 'BC-1',
          lines: [{ account: '4111.01', supplier: customer, document: 'CN-1', amount: '121.00' }],
        },
      ],
      baseRates: { '361104': [75, 90] },
    };

    const xml = writeD406(rich);
    const filed = readD406(utf8(xml));
    expect(filed.unread).toEqual([]);
    expect(checkD406Filed(filed)).toEqual([]);

    const converted = toD406(filed);
    expect(converted.problems).toEqual([]);
    expect(converted.model).toBeDefined();
    expect(writeD406(converted.model!)).toBe(xml);
    expect(calculateD406(converted.model!)).toEqual(calculateD406(rich));
  });

  test('XML equivalence: red and black stornos', () => {
    const redStorno = writerModel({
      salesInvoices: [
        {
          number: 'CN-RED',
          party: customer,
          date: '2026-10-09',
          type: '381',
          lines: [
            {
              account: '704',
              product: 'SRV',
              description: 'Storno în roșu',
              quantity: '-1',
              unitPrice: '-100.00',
              amount: '-100.00',
              tax: [vat('-100.00', '-21.00')],
            },
          ],
        },
      ],
      purchaseInvoices: [],
      payments: [],
    });
    expectXmlRoundTrip(redStorno);

    const blackStorno = writerModel({
      salesInvoices: [
        {
          number: 'CN-BLACK',
          party: customer,
          date: '2026-10-09',
          type: '381',
          lines: [
            {
              account: '704',
              product: 'SRV',
              description: 'Storno în negru',
              quantity: '1',
              unitPrice: '100.00',
              amount: '100.00',
              side: 'debit',
              tax: [vat('100.00', '21.00')],
            },
          ],
        },
      ],
      purchaseInvoices: [],
      payments: [],
    });
    expectXmlRoundTrip(blackStorno);
  });

  test('reads annual assets (A) and on-demand stock (C) files with zero unread elements and refuses periodic conversion', () => {
    const assetsModel: D406Assets = {
      created: '2026-05-01',
      software: writerModel().software,
      company: writerModel().company,
      year: { start: '2025-01-01', end: '2025-12-31' },
      presentation: { percentage: 'percent', disposal: 'gross' },
      accounts: [
        {
          code: '214',
          description: 'Mobilier și aparatură',
          opening: '6000.00',
          closing: '6000.00',
        },
        { code: '2814', description: 'Amortizare', opening: '0.00', closing: '-2000.00' },
      ],
      assets: [
        {
          id: 'MF-001',
          account: '214',
          depreciationAccount: '2814',
          description: 'Laptop',
          supplier: {
            id: supplier,
            name: 'Furnizor Test SRL',
            address: { city: 'Brăila', county: 'RO-BR', country: 'RO' },
          },
          acquired: '2025-01-10',
          commissioned: '2025-01-10',
          catalogCode: '2.2.9',
          lifeMonths: 36,
          costBegin: '6000.00',
          depreciationBegin: '0.00',
          addition: '0.00',
          disposal: '0.00',
          depreciation: '2000.00',
          depreciationRemoved: '0.00',
        },
      ],
      transactions: [
        {
          id: 'AM-1',
          asset: 'MF-001',
          type: '30',
          description: 'Amortizare 2025',
          date: '2025-12-31',
          transaction: 'NT-1',
          cost: '0.00',
          bookValue: '-2000.00',
          amount: '-2000.00',
        },
      ],
    };
    const filedAssets = readD406(utf8(writeD406Assets(assetsModel)));
    expect(filedAssets.unread).toEqual([]);
    expect(filedAssets.header.type).toBe('A');
    expect(filedAssets.masterFiles.assets).toHaveLength(1);
    expect(filedAssets.sourceDocuments.assetTransactions?.transactions).toHaveLength(1);
    const convAssets = toD406(filedAssets);
    expect(convAssets.model).toBeUndefined();
    expect(convAssets.problems.some((p) => p.code === 'D406_TYPE')).toBe(true);
    expect(convAssets.problems.some((p) => p.code === 'D406_UNSUPPORTED_SECTION')).toBe(true);

    const stockModel: D406Stock = {
      created: '2026-11-10',
      software: writerModel().software,
      company: writerModel().company,
      period: { start: '2026-10-01', end: '2026-10-31' },
      owner: { id: `00${writerModel().company.cui}`, account: '371' },
      accounts: [{ code: '371', description: 'Mărfuri', opening: 0n, closing: 10000n }],
      products: [
        {
          code: 'P-1',
          description: 'Produs',
          commodityCode: '0',
          valuation: 'FIFO',
          unit: 'H87',
        },
      ],
      stock: [
        {
          warehouse: 'DEP-1',
          product: 'P-1',
          lot: 'L-1',
          type: 'mărfuri',
          commodityCode: '0',
          owner: `00${writerModel().company.cui}`,
          unit: 'H87',
          unitPrice: 5000n,
          opening: { quantity: 0n, bani: 0n },
          closing: { quantity: 2000n, bani: 10000n },
        },
      ],
      movements: [
        {
          reference: 'NIR-1',
          date: '2026-10-05',
          type: '10',
          document: { type: '380', number: 'F-1' },
          lines: [
            {
              account: '371',
              customer: '0',
              supplier,
              product: 'P-1',
              lot: 'L-1',
              quantity: 2000n,
              unit: 'H87',
              bookValue: 10000n,
              subType: '10',
            },
          ],
        },
      ],
    };
    const filedStock = readD406(utf8(writeD406Stock(stockModel)));
    expect(filedStock.unread).toEqual([]);
    expect(filedStock.header.type).toBe('C');
    expect(filedStock.masterFiles.owners).toHaveLength(1);
    expect(filedStock.masterFiles.physicalStock).toHaveLength(1);
    expect(filedStock.sourceDocuments.movementOfGoods?.movements).toHaveLength(1);
    expect(checkD406Totals(filedStock)).toEqual([]);
    const convStock = toD406(filedStock);
    expect(convStock.model).toBeUndefined();
    expect(convStock.problems.some((p) => p.code === 'D406_TYPE')).toBe(true);
  });
});

describe('SAGA C dialect fixtures', () => {
  test('1. reads a single journal (JournalID=1, Type=1) and GL NumberOfEntries counting transactions', () => {
    const filed = readD406(
      saftDoc({
        generalLedger: `<nsSAFT:GeneralLedgerEntries>
          <nsSAFT:NumberOfEntries>1</nsSAFT:NumberOfEntries>
          <nsSAFT:TotalDebit>100.00</nsSAFT:TotalDebit>
          <nsSAFT:TotalCredit>100.00</nsSAFT:TotalCredit>
          <nsSAFT:Journal>
            <nsSAFT:JournalID>1</nsSAFT:JournalID>
            <nsSAFT:Description>Registru jurnal</nsSAFT:Description>
            <nsSAFT:Type>1</nsSAFT:Type>
            <nsSAFT:Transaction>
              <nsSAFT:TransactionID>10</nsSAFT:TransactionID>
              <nsSAFT:Period>10</nsSAFT:Period>
              <nsSAFT:PeriodYear>2026</nsSAFT:PeriodYear>
              <nsSAFT:TransactionDate>2026-10-05</nsSAFT:TransactionDate>
              <nsSAFT:Description>Notă</nsSAFT:Description>
              <nsSAFT:SystemEntryDate>2026-10-05</nsSAFT:SystemEntryDate>
              <nsSAFT:GLPostingDate>2026-10-05</nsSAFT:GLPostingDate>
              <nsSAFT:CustomerID>0018547290</nsSAFT:CustomerID>
              <nsSAFT:SupplierID>0018547290</nsSAFT:SupplierID>
              <nsSAFT:TransactionLine>
                <nsSAFT:RecordID>1</nsSAFT:RecordID>
                <nsSAFT:AccountID>5121</nsSAFT:AccountID>
                <nsSAFT:CustomerID>0018547290</nsSAFT:CustomerID>
                <nsSAFT:SupplierID>0018547290</nsSAFT:SupplierID>
                <nsSAFT:Description>Intrare</nsSAFT:Description>
                <nsSAFT:DebitAmount><nsSAFT:Amount>100.00</nsSAFT:Amount><nsSAFT:CurrencyCode>RON</nsSAFT:CurrencyCode><nsSAFT:CurrencyAmount>100.00</nsSAFT:CurrencyAmount><nsSAFT:ExchangeRate>1.0000</nsSAFT:ExchangeRate></nsSAFT:DebitAmount>
              </nsSAFT:TransactionLine>
              <nsSAFT:TransactionLine>
                <nsSAFT:RecordID>2</nsSAFT:RecordID>
                <nsSAFT:AccountID>40100009</nsSAFT:AccountID>
                <nsSAFT:CustomerID>0</nsSAFT:CustomerID>
                <nsSAFT:SupplierID>${supplier}</nsSAFT:SupplierID>
                <nsSAFT:Description>Ieșire</nsSAFT:Description>
                <nsSAFT:CreditAmount><nsSAFT:Amount>100.00</nsSAFT:Amount><nsSAFT:CurrencyCode>RON</nsSAFT:CurrencyCode><nsSAFT:CurrencyAmount>100.00</nsSAFT:CurrencyAmount><nsSAFT:ExchangeRate>1.0000</nsSAFT:ExchangeRate></nsSAFT:CreditAmount>
              </nsSAFT:TransactionLine>
            </nsSAFT:Transaction>
          </nsSAFT:Journal>
        </nsSAFT:GeneralLedgerEntries>`,
      }),
    );
    expect(filed.generalLedgerEntries.journals).toHaveLength(1);
    expect(filed.generalLedgerEntries.journals[0]!.id).toBe('1');
    expect(filed.generalLedgerEntries.journals[0]!.type).toBe('1');
    expect(filed.generalLedgerEntries.numberOfEntries).toBe('1');
    expect(filed.generalLedgerEntries.journals[0]!.transactions[0]!.lines[0]!.tax).toBeUndefined();
    expect(checkD406Totals(filed)).toEqual([]);
  });

  test('2. reads one generic product (COD_GENERIC) and invoice lines without ProductCode', () => {
    const filed = readD406(
      saftDoc({
        masterFiles: `<nsSAFT:MasterFiles>
          <nsSAFT:GeneralLedgerAccounts>
            <nsSAFT:Account><nsSAFT:AccountID>4111</nsSAFT:AccountID><nsSAFT:AccountDescription>Clienți</nsSAFT:AccountDescription><nsSAFT:StandardAccountID>4111</nsSAFT:StandardAccountID><nsSAFT:AccountType>Activ</nsSAFT:AccountType><nsSAFT:OpeningDebitBalance>0.00</nsSAFT:OpeningDebitBalance><nsSAFT:ClosingDebitBalance>0.00</nsSAFT:ClosingDebitBalance></nsSAFT:Account>
            <nsSAFT:Account><nsSAFT:AccountID>704</nsSAFT:AccountID><nsSAFT:AccountDescription>Venituri</nsSAFT:AccountDescription><nsSAFT:StandardAccountID>704</nsSAFT:StandardAccountID><nsSAFT:AccountType>Pasiv</nsSAFT:AccountType><nsSAFT:OpeningCreditBalance>0.00</nsSAFT:OpeningCreditBalance><nsSAFT:ClosingCreditBalance>0.00</nsSAFT:ClosingCreditBalance></nsSAFT:Account>
          </nsSAFT:GeneralLedgerAccounts>
          <nsSAFT:Customers>
            <nsSAFT:Customer><nsSAFT:CompanyStructure><nsSAFT:RegistrationNumber>${customer}</nsSAFT:RegistrationNumber><nsSAFT:Name>Client</nsSAFT:Name><nsSAFT:Address><nsSAFT:City>București</nsSAFT:City><nsSAFT:Country>RO</nsSAFT:Country></nsSAFT:Address></nsSAFT:CompanyStructure><nsSAFT:CustomerID>${customer}</nsSAFT:CustomerID><nsSAFT:AccountID>4111</nsSAFT:AccountID><nsSAFT:OpeningDebitBalance>0.00</nsSAFT:OpeningDebitBalance><nsSAFT:ClosingDebitBalance>0.00</nsSAFT:ClosingDebitBalance></nsSAFT:Customer>
          </nsSAFT:Customers>
          <nsSAFT:Suppliers/>
          <nsSAFT:TaxTable/>
          <nsSAFT:UOMTable><nsSAFT:UOMTableEntry><nsSAFT:UnitOfMeasure>H87</nsSAFT:UnitOfMeasure><nsSAFT:Description>bucată</nsSAFT:Description></nsSAFT:UOMTableEntry></nsSAFT:UOMTable>
          <nsSAFT:Products>
            <nsSAFT:Product>
              <nsSAFT:ProductCode>COD_GENERIC</nsSAFT:ProductCode>
              <nsSAFT:GoodsServicesID>01</nsSAFT:GoodsServicesID>
              <nsSAFT:Description>Produs generic</nsSAFT:Description>
              <nsSAFT:ProductCommodityCode>0</nsSAFT:ProductCommodityCode>
              <nsSAFT:ValuationMethod>FIFO</nsSAFT:ValuationMethod>
              <nsSAFT:UOMBase>H87</nsSAFT:UOMBase>
              <nsSAFT:UOMStandard>H87</nsSAFT:UOMStandard>
              <nsSAFT:UOMToUOMBaseConversionFactor>1</nsSAFT:UOMToUOMBaseConversionFactor>
            </nsSAFT:Product>
          </nsSAFT:Products>
        </nsSAFT:MasterFiles>`,
        sourceDocuments: `<nsSAFT:SourceDocuments>
          <nsSAFT:SalesInvoices>
            <nsSAFT:NumberOfEntries>1</nsSAFT:NumberOfEntries>
            <nsSAFT:TotalDebit>0.00</nsSAFT:TotalDebit>
            <nsSAFT:TotalCredit>100.00</nsSAFT:TotalCredit>
            <nsSAFT:Invoice>
              <nsSAFT:InvoiceNo>F-1</nsSAFT:InvoiceNo>
              <nsSAFT:CustomerInfo><nsSAFT:CustomerID>${customer}</nsSAFT:CustomerID></nsSAFT:CustomerInfo>
              <nsSAFT:AccountID>4111</nsSAFT:AccountID>
              <nsSAFT:Period>10</nsSAFT:Period>
              <nsSAFT:PeriodYear>2026</nsSAFT:PeriodYear>
              <nsSAFT:InvoiceDate>2026-10-05</nsSAFT:InvoiceDate>
              <nsSAFT:InvoiceType>380</nsSAFT:InvoiceType>
              <nsSAFT:SelfBillingIndicator>0</nsSAFT:SelfBillingIndicator>
              <nsSAFT:InvoiceLine>
                <nsSAFT:LineNumber>1</nsSAFT:LineNumber>
                <nsSAFT:AccountID>704</nsSAFT:AccountID>
                <nsSAFT:ProductDescription>Consultanță</nsSAFT:ProductDescription>
                <nsSAFT:Quantity>1.000</nsSAFT:Quantity>
                <nsSAFT:InvoiceUOM>H87</nsSAFT:InvoiceUOM>
                <nsSAFT:UnitPrice>100.00</nsSAFT:UnitPrice>
                <nsSAFT:TaxPointDate>2026-10-05</nsSAFT:TaxPointDate>
                <nsSAFT:Description>Consultanță</nsSAFT:Description>
                <nsSAFT:InvoiceLineAmount><nsSAFT:Amount>100.00</nsSAFT:Amount><nsSAFT:CurrencyCode>RON</nsSAFT:CurrencyCode><nsSAFT:CurrencyAmount>100.00</nsSAFT:CurrencyAmount><nsSAFT:ExchangeRate>1.0000</nsSAFT:ExchangeRate></nsSAFT:InvoiceLineAmount>
                <nsSAFT:DebitCreditIndicator>C</nsSAFT:DebitCreditIndicator>
                <nsSAFT:TaxInformation><nsSAFT:TaxType>300</nsSAFT:TaxType><nsSAFT:TaxCode>310344</nsSAFT:TaxCode><nsSAFT:TaxPercentage>21.00</nsSAFT:TaxPercentage><nsSAFT:TaxBase>100.00</nsSAFT:TaxBase><nsSAFT:TaxAmount><nsSAFT:Amount>21.00</nsSAFT:Amount></nsSAFT:TaxAmount></nsSAFT:TaxInformation>
              </nsSAFT:InvoiceLine>
              <nsSAFT:InvoiceDocumentTotals><nsSAFT:NetTotal>100.00</nsSAFT:NetTotal><nsSAFT:GrossTotal>121.00</nsSAFT:GrossTotal></nsSAFT:InvoiceDocumentTotals>
            </nsSAFT:Invoice>
          </nsSAFT:SalesInvoices>
          <nsSAFT:PurchaseInvoices/>
          <nsSAFT:Payments/>
        </nsSAFT:SourceDocuments>`,
      }),
    );
    expect(filed.masterFiles.products).toEqual([
      {
        code: 'COD_GENERIC',
        kind: '01',
        description: 'Produs generic',
        commodityCode: '0',
        valuationMethod: 'FIFO',
        uomBase: 'H87',
        uomStandard: 'H87',
        conversionFactor: '1',
      },
    ]);
    const invLine = filed.sourceDocuments.salesInvoices!.invoices[0]!.lines[0]!;
    expect(invLine.product).toBeUndefined();
    expect(invLine.productDescription).toBe('Consultanță');
    expect(invLine.quantity).toBe('1.000');
  });

  test('3. reads TaxType values 301, 604, 000 in TaxTable and 100010 in Company TaxRegistration', () => {
    const filed = readD406(
      saftDoc({
        masterFiles: `<nsSAFT:MasterFiles>
          <nsSAFT:GeneralLedgerAccounts>
            <nsSAFT:Account><nsSAFT:AccountID>4423</nsSAFT:AccountID><nsSAFT:AccountDescription>TVA de plată</nsSAFT:AccountDescription><nsSAFT:StandardAccountID>4423</nsSAFT:StandardAccountID><nsSAFT:AccountType>Pasiv</nsSAFT:AccountType><nsSAFT:OpeningCreditBalance>0.00</nsSAFT:OpeningCreditBalance><nsSAFT:ClosingCreditBalance>0.00</nsSAFT:ClosingCreditBalance></nsSAFT:Account>
          </nsSAFT:GeneralLedgerAccounts>
          <nsSAFT:Customers/>
          <nsSAFT:Suppliers/>
          <nsSAFT:TaxTable>
            <nsSAFT:TaxTableEntry><nsSAFT:TaxType>000</nsSAFT:TaxType><nsSAFT:Description>Neimpozabil</nsSAFT:Description><nsSAFT:TaxCodeDetails><nsSAFT:TaxCode>000000</nsSAFT:TaxCode><nsSAFT:Description>0</nsSAFT:Description><nsSAFT:TaxPercentage>0.00</nsSAFT:TaxPercentage><nsSAFT:BaseRate>1.0000</nsSAFT:BaseRate><nsSAFT:Country>RO</nsSAFT:Country></nsSAFT:TaxCodeDetails></nsSAFT:TaxTableEntry>
            <nsSAFT:TaxTableEntry><nsSAFT:TaxType>301</nsSAFT:TaxType><nsSAFT:Description>TVA lunar</nsSAFT:Description><nsSAFT:TaxCodeDetails><nsSAFT:TaxCode>000000</nsSAFT:TaxCode><nsSAFT:Description>TVA de plată</nsSAFT:Description><nsSAFT:TaxPercentage>19.00</nsSAFT:TaxPercentage><nsSAFT:BaseRate>1.0000</nsSAFT:BaseRate><nsSAFT:Country>RO</nsSAFT:Country></nsSAFT:TaxCodeDetails></nsSAFT:TaxTableEntry>
            <nsSAFT:TaxTableEntry><nsSAFT:TaxType>604</nsSAFT:TaxType><nsSAFT:Description>Dividende</nsSAFT:Description><nsSAFT:TaxCodeDetails><nsSAFT:TaxCode>604020</nsSAFT:TaxCode><nsSAFT:Description>8%</nsSAFT:Description><nsSAFT:TaxPercentage>8.00</nsSAFT:TaxPercentage><nsSAFT:BaseRate>1.0000</nsSAFT:BaseRate><nsSAFT:Country>RO</nsSAFT:Country></nsSAFT:TaxCodeDetails></nsSAFT:TaxTableEntry>
          </nsSAFT:TaxTable>
          <nsSAFT:UOMTable/>
          <nsSAFT:Products/>
        </nsSAFT:MasterFiles>`,
        generalLedger: `<nsSAFT:GeneralLedgerEntries>
          <nsSAFT:NumberOfEntries>1</nsSAFT:NumberOfEntries>
          <nsSAFT:TotalDebit>100.00</nsSAFT:TotalDebit>
          <nsSAFT:TotalCredit>100.00</nsSAFT:TotalCredit>
          <nsSAFT:Journal>
            <nsSAFT:JournalID>1</nsSAFT:JournalID><nsSAFT:Description>J</nsSAFT:Description><nsSAFT:Type>1</nsSAFT:Type>
            <nsSAFT:Transaction>
              <nsSAFT:TransactionID>1</nsSAFT:TransactionID><nsSAFT:TransactionDate>2026-10-31</nsSAFT:TransactionDate><nsSAFT:Description>Plată TVA</nsSAFT:Description>
              <nsSAFT:TransactionLine>
                <nsSAFT:RecordID>1</nsSAFT:RecordID><nsSAFT:AccountID>4423</nsSAFT:AccountID><nsSAFT:Description>TVA</nsSAFT:Description>
                <nsSAFT:DebitAmount><nsSAFT:Amount>100.00</nsSAFT:Amount></nsSAFT:DebitAmount>
                <nsSAFT:TaxInformation><nsSAFT:TaxType>301</nsSAFT:TaxType><nsSAFT:TaxCode>000000</nsSAFT:TaxCode><nsSAFT:TaxAmount><nsSAFT:Amount>0.00</nsSAFT:Amount></nsSAFT:TaxAmount></nsSAFT:TaxInformation>
              </nsSAFT:TransactionLine>
              <nsSAFT:TransactionLine>
                <nsSAFT:RecordID>2</nsSAFT:RecordID><nsSAFT:AccountID>4423</nsSAFT:AccountID><nsSAFT:Description>Compensare</nsSAFT:Description>
                <nsSAFT:CreditAmount><nsSAFT:Amount>100.00</nsSAFT:Amount></nsSAFT:CreditAmount>
                <nsSAFT:TaxInformation><nsSAFT:TaxType>000</nsSAFT:TaxType><nsSAFT:TaxCode>000000</nsSAFT:TaxCode><nsSAFT:TaxAmount><nsSAFT:Amount>0.00</nsSAFT:Amount></nsSAFT:TaxAmount></nsSAFT:TaxInformation>
              </nsSAFT:TransactionLine>
            </nsSAFT:Transaction>
          </nsSAFT:Journal>
        </nsSAFT:GeneralLedgerEntries>`,
      }),
    );
    expect(filed.header.company.taxRegistrations).toEqual([
      { registrationNumber: 'J17/100/2020', taxType: '100010', taxAuthority: 'ANAF' },
    ]);
    expect(filed.masterFiles.taxTable.map((t) => t.type)).toEqual(['000', '301', '604']);
    expect(filed.generalLedgerEntries.journals[0]!.transactions[0]!.lines[0]!.tax).toEqual([
      { type: '301', code: '000000', amount: '0.00' },
    ]);
    const conv = toD406(filed);
    expect(conv.problems.some((p) => p.code === 'D406_TAX_CODE')).toBe(true);
  });

  test('4. reads PaymentMethod without PaymentMechanism and flags it in toD406', () => {
    const filed = readD406(
      saftDoc({
        sourceDocuments: `<nsSAFT:SourceDocuments>
          <nsSAFT:Payments>
            <nsSAFT:NumberOfEntries>1</nsSAFT:NumberOfEntries>
            <nsSAFT:TotalDebit>0.00</nsSAFT:TotalDebit>
            <nsSAFT:TotalCredit>250.00</nsSAFT:TotalCredit>
            <nsSAFT:Payment>
              <nsSAFT:PaymentRefNo>OP-99</nsSAFT:PaymentRefNo>
              <nsSAFT:Period>10</nsSAFT:Period>
              <nsSAFT:PeriodYear>2026</nsSAFT:PeriodYear>
              <nsSAFT:TransactionID>55</nsSAFT:TransactionID>
              <nsSAFT:TransactionDate>2026-10-12</nsSAFT:TransactionDate>
              <nsSAFT:PaymentMethod>03</nsSAFT:PaymentMethod>
              <nsSAFT:Description>Plată furnizor</nsSAFT:Description>
              <nsSAFT:PaymentLine>
                <nsSAFT:LineNumber>1</nsSAFT:LineNumber>
                <nsSAFT:SourceDocumentID>FACT-77</nsSAFT:SourceDocumentID>
                <nsSAFT:AccountID>40100009</nsSAFT:AccountID>
                <nsSAFT:CustomerID>0</nsSAFT:CustomerID>
                <nsSAFT:SupplierID>${supplier}</nsSAFT:SupplierID>
                <nsSAFT:DebitCreditIndicator>C</nsSAFT:DebitCreditIndicator>
                <nsSAFT:PaymentLineAmount><nsSAFT:Amount>250.00</nsSAFT:Amount><nsSAFT:CurrencyCode>RON</nsSAFT:CurrencyCode><nsSAFT:CurrencyAmount>250.00</nsSAFT:CurrencyAmount><nsSAFT:ExchangeRate>1.0000</nsSAFT:ExchangeRate></nsSAFT:PaymentLineAmount>
              </nsSAFT:PaymentLine>
            </nsSAFT:Payment>
          </nsSAFT:Payments>
        </nsSAFT:SourceDocuments>`,
      }),
    );
    const pay = filed.sourceDocuments.payments!.payments[0]!;
    expect(pay.method).toBe('03');
    expect(pay.mechanism).toBeUndefined();
    expect(pay.totals).toBeUndefined();
    expect(pay.transaction).toBe('55');
    expect(pay.lines[0]!.document).toBe('FACT-77');
    expect(checkD406Totals(filed)).toEqual([]);
    const conv = toD406(filed);
    expect(conv.problems.some((p) => p.code === 'D406_MECHANISM')).toBe(true);
  });

  test('5. reads a supplier credit split over two lines (positive and negative on D) and keeps exact totals', () => {
    const filed = readD406(
      saftDoc({
        masterFiles: `<nsSAFT:MasterFiles>
          <nsSAFT:GeneralLedgerAccounts>
            <nsSAFT:Account><nsSAFT:AccountID>401</nsSAFT:AccountID><nsSAFT:AccountDescription>Furnizori</nsSAFT:AccountDescription><nsSAFT:StandardAccountID>401</nsSAFT:StandardAccountID><nsSAFT:AccountType>Pasiv</nsSAFT:AccountType><nsSAFT:OpeningCreditBalance>0.00</nsSAFT:OpeningCreditBalance><nsSAFT:ClosingCreditBalance>0.00</nsSAFT:ClosingCreditBalance></nsSAFT:Account>
            <nsSAFT:Account><nsSAFT:AccountID>6051</nsSAFT:AccountID><nsSAFT:AccountDescription>Energie</nsSAFT:AccountDescription><nsSAFT:StandardAccountID>6051</nsSAFT:StandardAccountID><nsSAFT:AccountType>Activ</nsSAFT:AccountType><nsSAFT:OpeningDebitBalance>0.00</nsSAFT:OpeningDebitBalance><nsSAFT:ClosingDebitBalance>0.00</nsSAFT:ClosingDebitBalance></nsSAFT:Account>
            <nsSAFT:Account><nsSAFT:AccountID>6581</nsSAFT:AccountID><nsSAFT:AccountDescription>Alte cheltuieli</nsSAFT:AccountDescription><nsSAFT:StandardAccountID>6581</nsSAFT:StandardAccountID><nsSAFT:AccountType>Activ</nsSAFT:AccountType><nsSAFT:OpeningDebitBalance>0.00</nsSAFT:OpeningDebitBalance><nsSAFT:ClosingDebitBalance>0.00</nsSAFT:ClosingDebitBalance></nsSAFT:Account>
          </nsSAFT:GeneralLedgerAccounts>
          <nsSAFT:Customers/>
          <nsSAFT:Suppliers>
            <nsSAFT:Supplier><nsSAFT:CompanyStructure><nsSAFT:RegistrationNumber>${supplier}</nsSAFT:RegistrationNumber><nsSAFT:Name>Furnizor</nsSAFT:Name><nsSAFT:Address><nsSAFT:City>Brăila</nsSAFT:City><nsSAFT:Country>RO</nsSAFT:Country></nsSAFT:Address></nsSAFT:CompanyStructure><nsSAFT:SupplierID>${supplier}</nsSAFT:SupplierID><nsSAFT:AccountID>401</nsSAFT:AccountID><nsSAFT:OpeningCreditBalance>0.00</nsSAFT:OpeningCreditBalance><nsSAFT:ClosingCreditBalance>0.00</nsSAFT:ClosingCreditBalance></nsSAFT:Supplier>
          </nsSAFT:Suppliers>
          <nsSAFT:TaxTable/>
          <nsSAFT:UOMTable/>
          <nsSAFT:Products/>
        </nsSAFT:MasterFiles>`,
        sourceDocuments: `<nsSAFT:SourceDocuments>
          <nsSAFT:PurchaseInvoices>
            <nsSAFT:NumberOfEntries>1</nsSAFT:NumberOfEntries>
            <nsSAFT:TotalDebit>-200.00</nsSAFT:TotalDebit>
            <nsSAFT:TotalCredit>0.00</nsSAFT:TotalCredit>
            <nsSAFT:Invoice>
              <nsSAFT:InvoiceNo>FAC-501</nsSAFT:InvoiceNo>
              <nsSAFT:SupplierInfo><nsSAFT:SupplierID>${supplier}</nsSAFT:SupplierID></nsSAFT:SupplierInfo>
              <nsSAFT:AccountID>401</nsSAFT:AccountID>
              <nsSAFT:InvoiceDate>2026-10-10</nsSAFT:InvoiceDate>
              <nsSAFT:InvoiceType>380</nsSAFT:InvoiceType>
              <nsSAFT:SelfBillingIndicator>0</nsSAFT:SelfBillingIndicator>
              <nsSAFT:TransactionID>77</nsSAFT:TransactionID>
              <nsSAFT:InvoiceLine>
                <nsSAFT:LineNumber>1</nsSAFT:LineNumber><nsSAFT:AccountID>6581</nsSAFT:AccountID><nsSAFT:Quantity>1.000</nsSAFT:Quantity><nsSAFT:UnitPrice>12.50</nsSAFT:UnitPrice><nsSAFT:Description>Taxă</nsSAFT:Description>
                <nsSAFT:InvoiceLineAmount><nsSAFT:Amount>12.50</nsSAFT:Amount></nsSAFT:InvoiceLineAmount>
                <nsSAFT:DebitCreditIndicator>D</nsSAFT:DebitCreditIndicator>
                <nsSAFT:TaxInformation><nsSAFT:TaxType>300</nsSAFT:TaxType><nsSAFT:TaxCode>308302</nsSAFT:TaxCode><nsSAFT:TaxPercentage>0.00</nsSAFT:TaxPercentage><nsSAFT:TaxBase>12.50</nsSAFT:TaxBase><nsSAFT:TaxAmount><nsSAFT:Amount>0.00</nsSAFT:Amount></nsSAFT:TaxAmount></nsSAFT:TaxInformation>
              </nsSAFT:InvoiceLine>
              <nsSAFT:InvoiceLine>
                <nsSAFT:LineNumber>2</nsSAFT:LineNumber><nsSAFT:AccountID>6051</nsSAFT:AccountID><nsSAFT:Quantity>-1.000</nsSAFT:Quantity><nsSAFT:UnitPrice>212.50</nsSAFT:UnitPrice><nsSAFT:Description>Regularizare</nsSAFT:Description>
                <nsSAFT:InvoiceLineAmount><nsSAFT:Amount>-212.50</nsSAFT:Amount></nsSAFT:InvoiceLineAmount>
                <nsSAFT:DebitCreditIndicator>D</nsSAFT:DebitCreditIndicator>
                <nsSAFT:TaxInformation><nsSAFT:TaxType>300</nsSAFT:TaxType><nsSAFT:TaxCode>301104</nsSAFT:TaxCode><nsSAFT:TaxPercentage>21.00</nsSAFT:TaxPercentage><nsSAFT:TaxBase>-212.50</nsSAFT:TaxBase><nsSAFT:TaxAmount><nsSAFT:Amount>-44.63</nsSAFT:Amount></nsSAFT:TaxAmount></nsSAFT:TaxInformation>
              </nsSAFT:InvoiceLine>
              <nsSAFT:InvoiceDocumentTotals>
                <nsSAFT:TaxInformationTotals><nsSAFT:TaxType>300</nsSAFT:TaxType><nsSAFT:TaxCode>308302</nsSAFT:TaxCode><nsSAFT:TaxPercentage>0.00</nsSAFT:TaxPercentage><nsSAFT:TaxBase>12.50</nsSAFT:TaxBase><nsSAFT:TaxAmount><nsSAFT:Amount>0.00</nsSAFT:Amount></nsSAFT:TaxAmount></nsSAFT:TaxInformationTotals>
                <nsSAFT:TaxInformationTotals><nsSAFT:TaxType>300</nsSAFT:TaxType><nsSAFT:TaxCode>301104</nsSAFT:TaxCode><nsSAFT:TaxPercentage>21.00</nsSAFT:TaxPercentage><nsSAFT:TaxBase>-212.50</nsSAFT:TaxBase><nsSAFT:TaxAmount><nsSAFT:Amount>-44.63</nsSAFT:Amount></nsSAFT:TaxAmount></nsSAFT:TaxInformationTotals>
                <nsSAFT:NetTotal>-200.00</nsSAFT:NetTotal>
                <nsSAFT:GrossTotal>-244.63</nsSAFT:GrossTotal>
              </nsSAFT:InvoiceDocumentTotals>
            </nsSAFT:Invoice>
          </nsSAFT:PurchaseInvoices>
        </nsSAFT:SourceDocuments>`,
      }),
    );
    const inv = filed.sourceDocuments.purchaseInvoices!.invoices[0]!;
    expect(inv.type).toBe('380');
    expect(inv.transaction).toBe('77');
    expect(inv.lines.map((l) => l.amount?.amount)).toEqual(['12.50', '-212.50']);
    expect(inv.totals?.netTotal).toBe('-200.00');
    expect(inv.totals?.grossTotal).toBe('-244.63');
    expect(checkD406Totals(filed)).toEqual([]);
  });

  test('6-9. reads dotted StandardAccountID beside integer AccountID, tax on base lines, TransactionID links, SourceDocumentID on payment lines, and unread paths', () => {
    const filed = readD406(
      saftDoc({
        generalLedger: `<nsSAFT:GeneralLedgerEntries>
          <nsSAFT:NumberOfEntries>1</nsSAFT:NumberOfEntries>
          <nsSAFT:TotalDebit>121.00</nsSAFT:TotalDebit>
          <nsSAFT:TotalCredit>121.00</nsSAFT:TotalCredit>
          <nsSAFT:Journal>
            <nsSAFT:JournalID>1</nsSAFT:JournalID><nsSAFT:Description>J</nsSAFT:Description><nsSAFT:Type>1</nsSAFT:Type>
            <nsSAFT:Transaction>
              <nsSAFT:TransactionID>101</nsSAFT:TransactionID>
              <nsSAFT:TransactionDate>2026-10-05</nsSAFT:TransactionDate>
              <nsSAFT:Description>Achiziție</nsSAFT:Description>
              <nsSAFT:BatchID>101</nsSAFT:BatchID>
              <nsSAFT:SystemID>101</nsSAFT:SystemID>
              <nsSAFT:TransactionLine>
                <nsSAFT:RecordID>1</nsSAFT:RecordID>
                <nsSAFT:AccountID>5121</nsSAFT:AccountID>
                <nsSAFT:Description>Bază</nsSAFT:Description>
                <nsSAFT:DebitAmount><nsSAFT:Amount>100.00</nsSAFT:Amount></nsSAFT:DebitAmount>
                <nsSAFT:TaxInformation>
                  <nsSAFT:TaxType>300</nsSAFT:TaxType>
                  <nsSAFT:TaxCode>301104</nsSAFT:TaxCode>
                  <nsSAFT:TaxPercentage>21.00</nsSAFT:TaxPercentage>
                  <nsSAFT:TaxDeclarationPeriod/>
                  <nsSAFT:TaxBase>100.00</nsSAFT:TaxBase>
                  <nsSAFT:TaxAmount><nsSAFT:Amount>21.00</nsSAFT:Amount></nsSAFT:TaxAmount>
                </nsSAFT:TaxInformation>
                <nsSAFT:Analysis><nsSAFT:AnalysisType>A</nsSAFT:AnalysisType><nsSAFT:AnalysisID>0000</nsSAFT:AnalysisID></nsSAFT:Analysis>
              </nsSAFT:TransactionLine>
              <nsSAFT:TransactionLine>
                <nsSAFT:RecordID>2</nsSAFT:RecordID>
                <nsSAFT:AccountID>5121</nsSAFT:AccountID>
                <nsSAFT:Description>TVA</nsSAFT:Description>
                <nsSAFT:DebitAmount><nsSAFT:Amount>21.00</nsSAFT:Amount></nsSAFT:DebitAmount>
                <nsSAFT:TaxInformation><nsSAFT:TaxType>000</nsSAFT:TaxType><nsSAFT:TaxCode>000000</nsSAFT:TaxCode><nsSAFT:TaxAmount><nsSAFT:Amount>0.00</nsSAFT:Amount></nsSAFT:TaxAmount></nsSAFT:TaxInformation>
              </nsSAFT:TransactionLine>
              <nsSAFT:TransactionLine>
                <nsSAFT:RecordID>3</nsSAFT:RecordID>
                <nsSAFT:AccountID>40100009</nsSAFT:AccountID>
                <nsSAFT:SupplierID>${supplier}</nsSAFT:SupplierID>
                <nsSAFT:Description>Furnizor</nsSAFT:Description>
                <nsSAFT:CreditAmount><nsSAFT:Amount>121.00</nsSAFT:Amount></nsSAFT:CreditAmount>
                <nsSAFT:TaxInformation><nsSAFT:TaxType>000</nsSAFT:TaxType><nsSAFT:TaxCode>000000</nsSAFT:TaxCode><nsSAFT:TaxAmount><nsSAFT:Amount>0.00</nsSAFT:Amount></nsSAFT:TaxAmount></nsSAFT:TaxInformation>
              </nsSAFT:TransactionLine>
            </nsSAFT:Transaction>
          </nsSAFT:Journal>
        </nsSAFT:GeneralLedgerEntries>`,
      }),
    );
    expect(filed.masterFiles.accounts[0]!.id).toBe('40100009');
    expect(filed.masterFiles.accounts[0]!.standard).toBe('401.00009');
    expect(filed.generalLedgerEntries.journals[0]!.transactions[0]!.lines[0]!.tax).toEqual([
      { type: '300', code: '301104', percentage: '21.00', base: '100.00', amount: '21.00' },
    ]);
    expect(filed.unread).toEqual([
      { path: 'AuditFile/GeneralLedgerEntries/Journal/Transaction/BatchID', count: 1 },
      { path: 'AuditFile/GeneralLedgerEntries/Journal/Transaction/SystemID', count: 1 },
      {
        path: 'AuditFile/GeneralLedgerEntries/Journal/Transaction/TransactionLine/Analysis',
        count: 1,
      },
      {
        path: 'AuditFile/GeneralLedgerEntries/Journal/Transaction/TransactionLine/Analysis/AnalysisID',
        count: 1,
      },
      {
        path: 'AuditFile/GeneralLedgerEntries/Journal/Transaction/TransactionLine/Analysis/AnalysisType',
        count: 1,
      },
      {
        path: 'AuditFile/GeneralLedgerEntries/Journal/Transaction/TransactionLine/TaxInformation/TaxDeclarationPeriod',
        count: 1,
      },
      { path: 'AuditFile/Header/Company/Address/AddressType', count: 1 },
      { path: 'AuditFile/Header/Company/Contact/ContactPerson/OtherTitles', count: 1 },
      { path: 'AuditFile/Header/Company/TaxRegistration/TaxNumber', count: 1 },
      { path: 'AuditFile/MasterFiles/GeneralLedgerAccounts/Account/AccountCreationDate', count: 1 },
      {
        path: 'AuditFile/MasterFiles/Suppliers/Supplier/CompanyStructure/Address/AddressType',
        count: 1,
      },
      { path: 'AuditFile/MasterFiles/Suppliers/Supplier/SelfBillingIndicator', count: 1 },
    ]);
    const conv = toD406(filed);
    expect(conv.problems.some((p) => p.code === 'D406_STANDARD_ACCOUNT')).toBe(true);
    expect(conv.problems.some((p) => p.code === 'D406_UNREAD')).toBe(true);
  });
});

describe('D406 reader checks and bounds', () => {
  test('checkD406Balances catches unbalanced transactions and unbalanced file totals', () => {
    const filed = readD406(utf8(writeD406(writerModel())));
    expect(checkD406Balances(filed)).toEqual([]);

    const unbalancedTx = structuredClone(filed);
    unbalancedTx.generalLedgerEntries.journals[0]!.transactions[0]!.lines[0]!.amount!.amount =
      '1211.00';
    expect(checkD406Balances(unbalancedTx).map((p) => p.code)).toEqual([
      'D406_UNBALANCED',
      'D406_FILE_UNBALANCED',
    ]);
  });

  test('checkD406Totals catches mismatches in GL, invoices, and payments totals', () => {
    const filed = readD406(utf8(writeD406(writerModel())));
    expect(checkD406Totals(filed)).toEqual([]);

    const bad = structuredClone(filed);
    bad.generalLedgerEntries.numberOfEntries = '999';
    bad.generalLedgerEntries.totalDebit = '0.00';
    bad.sourceDocuments.salesInvoices!.totalCredit = '0.00';
    bad.sourceDocuments.salesInvoices!.invoices[0]!.totals!.grossTotal = '0.00';
    bad.sourceDocuments.payments!.payments[0]!.totals!.grossTotal = '0.00';
    const paths = checkD406Totals(bad).map((p) => p.path);
    expect(paths).toContain('generalLedgerEntries.numberOfEntries');
    expect(paths).toContain('generalLedgerEntries.totalDebit');
    expect(paths).toContain('sourceDocuments.salesInvoices.totalCredit');
    expect(paths).toContain('sourceDocuments.salesInvoices.invoices.0.totals.grossTotal');
    expect(paths).toContain('sourceDocuments.payments.payments.0.totals.grossTotal');
  });

  test('checkD406Accounts catches unknown accounts on GL, parties, invoices and payments', () => {
    const filed = readD406(utf8(writeD406(writerModel())));
    expect(checkD406Accounts(filed)).toEqual([]);

    const bad = structuredClone(filed);
    bad.generalLedgerEntries.journals[0]!.transactions[0]!.lines[0]!.account = '9999';
    bad.sourceDocuments.purchaseInvoices!.invoices[0]!.lines[0]!.account = '8888';
    bad.sourceDocuments.payments!.payments[0]!.lines[0]!.account = '7777';
    expect(checkD406Accounts(bad).map((p) => p.path)).toEqual([
      'generalLedgerEntries.journals.0.transactions.0.lines.0.account',
      'sourceDocuments.purchaseInvoices.invoices.0.lines.0.account',
      'sourceDocuments.payments.payments.0.lines.0.account',
    ]);
  });

  test('checkD406Partners catches unknown partners while allowing 0, company 00+CUI, Răspuns 21 refunds, and checks physical stock owners', () => {
    const refundModel = writerModel({
      payments: [
        {
          reference: 'OP-9',
          date: '2026-10-20',
          mechanism: '42',
          description: 'Restituire client',
          direction: 'payment',
          lines: [{ account: '4111.01', supplier: customer, document: 'CN-1', amount: '121.00' }],
        },
      ],
    });
    const filed = readD406(utf8(writeD406(refundModel)));
    expect(checkD406Partners(filed)).toEqual([]);

    const bad = structuredClone(filed);
    bad.generalLedgerEntries.journals[0]!.transactions[0]!.lines[0]!.customer = '0011111111';
    bad.sourceDocuments.salesInvoices!.invoices[0]!.party!.id = '0022222222';
    bad.sourceDocuments.payments!.payments[0]!.lines[0]!.supplier = '0033333333';
    expect(checkD406Partners(bad).map((p) => p.path)).toEqual([
      'generalLedgerEntries.journals.0.transactions.0.lines.0.customer',
      'sourceDocuments.salesInvoices.invoices.0.party.id',
      'sourceDocuments.payments.payments.0.lines.0.supplier',
    ]);

    const stockWithMissingOwner = readD406(
      utf8(
        writeD406Stock({
          created: '2026-11-10',
          software: writerModel().software,
          company: writerModel().company,
          period: { start: '2026-10-01', end: '2026-10-31' },
          owner: { id: `00${writerModel().company.cui}`, account: '371' },
          accounts: [{ code: '371', description: 'Mărfuri', opening: 0n, closing: 0n }],
          products: [],
          stock: [],
          movements: [],
        }),
      ),
    );
    stockWithMissingOwner.masterFiles.physicalStock = [{ owner: '04Missing' }];
    expect(checkD406Partners(stockWithMissingOwner)).toEqual([
      expect.objectContaining({
        code: 'D406_PARTY_UNKNOWN',
        path: 'masterFiles.physicalStock.0.owner',
      }),
    ]);
  });

  test('rejects non-D406 XML, reads D406 documents > 100,000 elements, and bounds at MAX_SAFT_NODES', () => {
    try {
      readD406(utf8('<Other xmlns="urn:other"/>'));
      throw new Error('Expected D406_FORMAT');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('D406_FORMAT');
    }

    // 34,000 UOMTableEntry nodes * 3 elements each + base structure > 100,000 XML elements.
    const unitEntries =
      '<nsSAFT:UOMTableEntry><nsSAFT:UnitOfMeasure>H87</nsSAFT:UnitOfMeasure><nsSAFT:Description>buc</nsSAFT:Description></nsSAFT:UOMTableEntry>'.repeat(
        34000,
      );
    const large = saftDoc({
      masterFiles: `<nsSAFT:MasterFiles>
        <nsSAFT:GeneralLedgerAccounts/>
        <nsSAFT:Customers/>
        <nsSAFT:Suppliers/>
        <nsSAFT:TaxTable/>
        <nsSAFT:UOMTable>${unitEntries}</nsSAFT:UOMTable>
        <nsSAFT:Products/>
      </nsSAFT:MasterFiles>`,
    });
    const filed = readD406(large);
    expect(filed.masterFiles.units).toHaveLength(34000);
    expect(filed.masterFiles.units[0]).toEqual({ unit: 'H87', description: 'buc' });

    // > 300,000 elements in < 10 MiB is rejected by MAX_SAFT_NODES.
    const tooMany = saftDoc({
      masterFiles: `<nsSAFT:MasterFiles>${'<nsSAFT:Products/>'.repeat(300001)}</nsSAFT:MasterFiles>`,
    });
    expect(() => readD406(tooMany)).toThrow(DomainError);
  });
});

describe('D406 reader review fixes', () => {
  test('1. toD406 reports dropped or altered filed facts, runs filed checks, and still returns the built periodic model', () => {
    const baseFiled = readD406(utf8(writeD406(writerModel())));

    const mutateCheck = (
      mutate: (copy: ReturnType<typeof readD406>) => void,
      expectedPath: string,
    ) => {
      const copy = structuredClone(baseFiled);
      mutate(copy);
      const conv = toD406(copy);
      expect(conv.model).toBeDefined();
      expect(conv.problems.some((p) => p.path === expectedPath)).toBe(true);
      expect(conv.problems.every((p) => !p.path.startsWith('AuditFile/'))).toBe(true);
    };

    mutateCheck((c) => {
      c.masterFiles.accounts[0]!.closingCredit = '999.99';
    }, 'masterFiles.accounts.0.closingCredit');
    mutateCheck((c) => {
      c.sourceDocuments.salesInvoices!.totalCredit = '0.00';
    }, 'sourceDocuments.salesInvoices.totalCredit');
    mutateCheck((c) => {
      c.header.segmentIndex = '2';
    }, 'header.segmentIndex');
    mutateCheck((c) => {
      c.header.totalSegments = '3';
    }, 'header.totalSegments');
    mutateCheck((c) => {
      c.header.taxAccountingBasis = 'I';
    }, 'header.taxAccountingBasis');
    mutateCheck((c) => {
      c.generalLedgerEntries.journals[0]!.transactions[0]!.period = '11';
    }, 'generalLedgerEntries.journals.0.transactions.0.period');
    mutateCheck((c) => {
      c.sourceDocuments.salesInvoices!.invoices[0]!.lines[0]!.lineNumber = '9';
    }, 'sourceDocuments.salesInvoices.invoices.0.lines.0.lineNumber');
    mutateCheck((c) => {
      c.sourceDocuments.salesInvoices!.invoices[0]!.party!.billingAddress!.city = 'Cluj';
    }, 'sourceDocuments.salesInvoices.invoices.0.party.billingAddress.city');
    mutateCheck((c) => {
      c.sourceDocuments.salesInvoices!.invoices[0]!.lines[0]!.productDescription = 'Altceva';
    }, 'sourceDocuments.salesInvoices.invoices.0.lines.0.productDescription');
    mutateCheck((c) => {
      c.masterFiles.taxTable[0]!.codes[0]!.percentage = '99';
    }, 'masterFiles.taxTable.0.codes.0.percentage');
    mutateCheck((c) => {
      const tax = c.generalLedgerEntries.journals[0]!.transactions[0]!.lines[1]!.tax![0]!;
      tax.currencyCode = 'RON';
      tax.currencyAmount = '999.00';
    }, 'generalLedgerEntries.journals.0.transactions.0.lines.1.tax.0.currencyAmount');
    mutateCheck((c) => {
      const tax = c.generalLedgerEntries.journals[0]!.transactions[0]!.lines[1]!.tax![0]!;
      tax.exchangeRate = '5.0000';
    }, 'generalLedgerEntries.journals.0.transactions.0.lines.1.tax.0.exchangeRate');
    mutateCheck((c) => {
      c.sourceDocuments.salesInvoices!.invoices[0]!.selfBilling = undefined;
    }, 'sourceDocuments.salesInvoices.invoices.0.selfBilling');
    mutateCheck((c) => {
      c.sourceDocuments.payments!.payments[0]!.lines[0]!.side = undefined;
    }, 'sourceDocuments.payments.payments.0.lines.0.side');
  });

  test('2. counts paired 30xxxx and 35xxxx VAT blocks once in purchase gross totals while retaining both blocks', () => {
    const pairedDoc = (
      base1: string,
      amt1: string,
      base2: string,
      amt2: string,
      grossTotal: string,
    ) =>
      saftDoc({
        masterFiles: `<nsSAFT:MasterFiles>
          <nsSAFT:GeneralLedgerAccounts>
            <nsSAFT:Account><nsSAFT:AccountID>401</nsSAFT:AccountID><nsSAFT:AccountDescription>Furnizori</nsSAFT:AccountDescription><nsSAFT:StandardAccountID>401</nsSAFT:StandardAccountID><nsSAFT:AccountType>Pasiv</nsSAFT:AccountType><nsSAFT:OpeningCreditBalance>0.00</nsSAFT:OpeningCreditBalance><nsSAFT:ClosingCreditBalance>0.00</nsSAFT:ClosingCreditBalance></nsSAFT:Account>
            <nsSAFT:Account><nsSAFT:AccountID>628</nsSAFT:AccountID><nsSAFT:AccountDescription>Servicii</nsSAFT:AccountDescription><nsSAFT:StandardAccountID>628</nsSAFT:StandardAccountID><nsSAFT:AccountType>Activ</nsSAFT:AccountType><nsSAFT:OpeningDebitBalance>0.00</nsSAFT:OpeningDebitBalance><nsSAFT:ClosingDebitBalance>0.00</nsSAFT:ClosingDebitBalance></nsSAFT:Account>
          </nsSAFT:GeneralLedgerAccounts>
          <nsSAFT:Customers/>
          <nsSAFT:Suppliers>
            <nsSAFT:Supplier><nsSAFT:CompanyStructure><nsSAFT:RegistrationNumber>${supplier}</nsSAFT:RegistrationNumber><nsSAFT:Name>Furnizor</nsSAFT:Name><nsSAFT:Address><nsSAFT:City>Brăila</nsSAFT:City><nsSAFT:Country>RO</nsSAFT:Country></nsSAFT:Address></nsSAFT:CompanyStructure><nsSAFT:SupplierID>${supplier}</nsSAFT:SupplierID><nsSAFT:AccountID>401</nsSAFT:AccountID><nsSAFT:OpeningCreditBalance>0.00</nsSAFT:OpeningCreditBalance><nsSAFT:ClosingCreditBalance>0.00</nsSAFT:ClosingCreditBalance></nsSAFT:Supplier>
          </nsSAFT:Suppliers>
          <nsSAFT:TaxTable/>
          <nsSAFT:UOMTable/>
          <nsSAFT:Products/>
        </nsSAFT:MasterFiles>`,
        sourceDocuments: `<nsSAFT:SourceDocuments>
          <nsSAFT:PurchaseInvoices>
            <nsSAFT:NumberOfEntries>1</nsSAFT:NumberOfEntries>
            <nsSAFT:TotalDebit>200.00</nsSAFT:TotalDebit>
            <nsSAFT:TotalCredit>0.00</nsSAFT:TotalCredit>
            <nsSAFT:Invoice>
              <nsSAFT:InvoiceNo>F-PAIRED</nsSAFT:InvoiceNo>
              <nsSAFT:SupplierInfo><nsSAFT:SupplierID>${supplier}</nsSAFT:SupplierID></nsSAFT:SupplierInfo>
              <nsSAFT:AccountID>401</nsSAFT:AccountID>
              <nsSAFT:InvoiceDate>2026-10-10</nsSAFT:InvoiceDate>
              <nsSAFT:InvoiceType>380</nsSAFT:InvoiceType>
              <nsSAFT:SelfBillingIndicator>0</nsSAFT:SelfBillingIndicator>
              <nsSAFT:InvoiceLine>
                <nsSAFT:LineNumber>1</nsSAFT:LineNumber><nsSAFT:AccountID>628</nsSAFT:AccountID><nsSAFT:Quantity>1</nsSAFT:Quantity><nsSAFT:UnitPrice>200.00</nsSAFT:UnitPrice><nsSAFT:Description>Cheltuială mixtă</nsSAFT:Description>
                <nsSAFT:InvoiceLineAmount><nsSAFT:Amount>200.00</nsSAFT:Amount></nsSAFT:InvoiceLineAmount>
                <nsSAFT:DebitCreditIndicator>D</nsSAFT:DebitCreditIndicator>
                <nsSAFT:TaxInformation><nsSAFT:TaxType>300</nsSAFT:TaxType><nsSAFT:TaxCode>301105</nsSAFT:TaxCode><nsSAFT:TaxPercentage>11.00</nsSAFT:TaxPercentage><nsSAFT:TaxBase>${base1}</nsSAFT:TaxBase><nsSAFT:TaxAmount><nsSAFT:Amount>${amt1}</nsSAFT:Amount></nsSAFT:TaxAmount></nsSAFT:TaxInformation>
                <nsSAFT:TaxInformation><nsSAFT:TaxType>300</nsSAFT:TaxType><nsSAFT:TaxCode>351105</nsSAFT:TaxCode><nsSAFT:TaxPercentage>11.00</nsSAFT:TaxPercentage><nsSAFT:TaxBase>${base2}</nsSAFT:TaxBase><nsSAFT:TaxAmount><nsSAFT:Amount>${amt2}</nsSAFT:Amount></nsSAFT:TaxAmount></nsSAFT:TaxInformation>
              </nsSAFT:InvoiceLine>
              <nsSAFT:InvoiceDocumentTotals>
                <nsSAFT:TaxInformationTotals><nsSAFT:TaxType>300</nsSAFT:TaxType><nsSAFT:TaxCode>301105</nsSAFT:TaxCode><nsSAFT:TaxPercentage>11.00</nsSAFT:TaxPercentage><nsSAFT:TaxBase>${base1}</nsSAFT:TaxBase><nsSAFT:TaxAmount><nsSAFT:Amount>${amt1}</nsSAFT:Amount></nsSAFT:TaxAmount></nsSAFT:TaxInformationTotals>
                <nsSAFT:TaxInformationTotals><nsSAFT:TaxType>300</nsSAFT:TaxType><nsSAFT:TaxCode>351105</nsSAFT:TaxCode><nsSAFT:TaxPercentage>11.00</nsSAFT:TaxPercentage><nsSAFT:TaxBase>${base2}</nsSAFT:TaxBase><nsSAFT:TaxAmount><nsSAFT:Amount>${amt2}</nsSAFT:Amount></nsSAFT:TaxAmount></nsSAFT:TaxInformationTotals>
                <nsSAFT:NetTotal>200.00</nsSAFT:NetTotal>
                <nsSAFT:GrossTotal>${grossTotal}</nsSAFT:GrossTotal>
              </nsSAFT:InvoiceDocumentTotals>
            </nsSAFT:Invoice>
          </nsSAFT:PurchaseInvoices>
        </nsSAFT:SourceDocuments>`,
      });

    // Overlap (the real pattern: each block carries full 22.00 VAT, gross is 222.00).
    const overlapping = readD406(pairedDoc('200.00', '22.00', '200.00', '22.00', '222.00'));
    const inv = overlapping.sourceDocuments.purchaseInvoices!.invoices[0]!;
    expect(inv.lines[0]!.tax).toHaveLength(2);
    expect(inv.lines[0]!.tax.map((t) => t.code)).toEqual(['301105', '351105']);
    expect(inv.totals?.taxes).toHaveLength(2);
    expect(checkD406Totals(overlapping)).toEqual([]);

    // Disjoint base split (100.00 + 100.00 = 200.00, 11.00 + 11.00 = 22.00, gross is 222.00).
    const disjoint = readD406(pairedDoc('100.00', '11.00', '100.00', '11.00', '222.00'));
    expect(checkD406Totals(disjoint)).toEqual([]);

    // Equal split written by writeD406 (same base 200.00, 11.00 + 11.00 = 22.00, gross 222.00).
    const splitModel = writerModel({
      purchaseInvoices: [
        {
          number: 'F-SPLIT',
          party: supplier,
          date: '2026-10-10',
          type: '380',
          lines: [
            {
              account: '628',
              product: 'SRV',
              description: 'Cheltuială împărțită',
              quantity: '1',
              unitPrice: '200.00',
              amount: '200.00',
              tax: [
                { type: '300', code: '301105', base: '200.00', amount: '11.00' },
                { type: '300', code: '351105', base: '200.00', amount: '11.00' },
              ],
            },
          ],
        },
      ],
    });
    const splitXml = writeD406(splitModel);
    const splitFiled = readD406(utf8(splitXml));
    expect(checkD406Totals(splitFiled)).toEqual([]);
    const splitConv = toD406(splitFiled);
    expect(splitConv.problems).toEqual([]);
    expect(writeD406(splitConv.model!)).toBe(splitXml);

    // Equal split with wrong gross 211.00 fails.
    const wrongSplitGross = structuredClone(splitFiled);
    wrongSplitGross.sourceDocuments.purchaseInvoices!.invoices[0]!.totals!.grossTotal = '211.00';
    expect(checkD406Totals(wrongSplitGross).some((p) => p.code === 'D406_TOTAL_MISMATCH')).toBe(
      true,
    );

    // Doubled VAT amounts (44.00 + 44.00 on base 200.00 at 11%, gross 244.00) must fail.
    const doubled = readD406(pairedDoc('200.00', '44.00', '200.00', '44.00', '244.00'));
    expect(checkD406Totals(doubled).some((p) => p.code === 'D406_TAX_PAIR')).toBe(true);

    // Unrelated codes (21% 301104 + 11% 351105, cash-VAT mismatch 301104 + 351305, or unknown 309999 + 359999) must fail.
    const unrelatedRates = utf8(
      new TextDecoder()
        .decode(pairedDoc('200.00', '22.00', '200.00', '22.00', '222.00'))
        .replace(
          '<nsSAFT:TaxCode>301105</nsSAFT:TaxCode>',
          '<nsSAFT:TaxCode>301104</nsSAFT:TaxCode>',
        ),
    );
    expect(checkD406Totals(readD406(unrelatedRates)).some((p) => p.code === 'D406_TAX_PAIR')).toBe(
      true,
    );
    const unknownPair = utf8(
      new TextDecoder()
        .decode(pairedDoc('200.00', '22.00', '200.00', '22.00', '222.00'))
        .replace(
          '<nsSAFT:TaxCode>301105</nsSAFT:TaxCode>',
          '<nsSAFT:TaxCode>309999</nsSAFT:TaxCode>',
        )
        .replace(
          '<nsSAFT:TaxCode>351105</nsSAFT:TaxCode>',
          '<nsSAFT:TaxCode>359999</nsSAFT:TaxCode>',
        ),
    );
    expect(checkD406Totals(readD406(unknownPair)).some((p) => p.code === 'D406_TAX_PAIR')).toBe(
      true,
    );

    // Unestablished relationship (mismatched amounts 22.00 vs 15.00 on full base 200.00).
    const ambiguous = readD406(pairedDoc('200.00', '22.00', '200.00', '15.00', '222.00'));
    expect(checkD406Totals(ambiguous).some((p) => p.code === 'D406_TAX_PAIR')).toBe(true);
  });

  test('4-7. preserves attributes/container text in unread, rejects both-side lines, preserves whitespace, and matches namespaces', () => {
    const doc = utf8(`<?xml version="1.0" encoding="UTF-8"?>
<nsSAFT:AuditFile xmlns:nsSAFT="${d406Namespace}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="urn:example saft.xsd">
  <nsSAFT:Header>lost text<nsSAFT:AuditFileVersion>2.0</nsSAFT:AuditFileVersion><nsSAFT:SoftwareID vendor="example">Example</nsSAFT:SoftwareID><SoftwareID xmlns="urn:other">Other</SoftwareID><nsSAFT:Company><nsSAFT:Name>  Exemplu  </nsSAFT:Name></nsSAFT:Company></nsSAFT:Header>
  <nsSAFT:MasterFiles/>
  <nsSAFT:GeneralLedgerEntries>
    <nsSAFT:Journal>
      <nsSAFT:JournalID>1</nsSAFT:JournalID>
      <nsSAFT:Transaction>
        <nsSAFT:TransactionID>1</nsSAFT:TransactionID>
        <nsSAFT:TransactionLine>
          <nsSAFT:RecordID>1</nsSAFT:RecordID>
          <nsSAFT:AccountID>5121</nsSAFT:AccountID>
          <nsSAFT:DebitAmount><nsSAFT:Amount>  1.2300  </nsSAFT:Amount></nsSAFT:DebitAmount>
          <nsSAFT:CreditAmount><nsSAFT:Amount>2.00</nsSAFT:Amount></nsSAFT:CreditAmount>
        </nsSAFT:TransactionLine>
      </nsSAFT:Transaction>
    </nsSAFT:Journal>
  </nsSAFT:GeneralLedgerEntries>
  <nsSAFT:SourceDocuments/>
</nsSAFT:AuditFile>`);
    const filed = readD406(doc);
    expect(filed.header.software.name).toBe('Example');
    expect(filed.header.company.name).toBe('  Exemplu  ');
    const line0 = filed.generalLedgerEntries.journals[0]!.transactions[0]!.lines[0]!;
    expect(line0.side).toBeUndefined();
    expect(line0.amount).toBeUndefined();

    const unreadPaths = filed.unread.map((u) => u.path);
    expect(unreadPaths).toContain(
      'AuditFile/@{http://www.w3.org/2001/XMLSchema-instance}schemaLocation',
    );
    expect(unreadPaths).toContain('AuditFile/Header/#text');
    expect(unreadPaths).toContain('AuditFile/Header/SoftwareID/@vendor');
    expect(unreadPaths).toContain('AuditFile/Header/{urn:other}SoftwareID');
    expect(unreadPaths).toContain(
      'AuditFile/GeneralLedgerEntries/Journal/Transaction/TransactionLine/DebitAmount',
    );
    expect(unreadPaths).toContain(
      'AuditFile/GeneralLedgerEntries/Journal/Transaction/TransactionLine/CreditAmount',
    );
    expect(checkD406Balances(filed).some((p) => p.code === 'D406_SIDE')).toBe(true);
    expect(toD406(filed).problems.some((p) => p.code === 'D406_UNREAD')).toBe(true);

    // Non-trimmed amount scalar is preserved verbatim and rejected by balance check.
    const spacedAmt = readD406(
      saftDoc({
        generalLedger: `<nsSAFT:GeneralLedgerEntries><nsSAFT:Journal><nsSAFT:JournalID>1</nsSAFT:JournalID><nsSAFT:Transaction><nsSAFT:TransactionID>1</nsSAFT:TransactionID><nsSAFT:TransactionLine><nsSAFT:RecordID>1</nsSAFT:RecordID><nsSAFT:AccountID>5121</nsSAFT:AccountID><nsSAFT:DebitAmount><nsSAFT:Amount>  1.2300  </nsSAFT:Amount></nsSAFT:DebitAmount></nsSAFT:TransactionLine></nsSAFT:Transaction></nsSAFT:Journal></nsSAFT:GeneralLedgerEntries>`,
      }),
    );
    expect(
      spacedAmt.generalLedgerEntries.journals[0]!.transactions[0]!.lines[0]!.amount?.amount,
    ).toBe('  1.2300  ');
    expect(checkD406Balances(spacedAmt).some((p) => p.code === 'D406_AMOUNT')).toBe(true);
  });

  test('8-11. flags invalid operands, groups equivalent percentages, and never throws on invalid dates', () => {
    const baseFiled = readD406(utf8(writeD406(writerModel())));

    // 8. Invalid tax amounts / payment amounts / quantities never silently pass totals.
    const badTax = structuredClone(baseFiled);
    const inv = badTax.sourceDocuments.salesInvoices!.invoices[0]!;
    inv.lines[0]!.tax[0]!.amount = 'garbage';
    inv.totals!.taxes[0]!.amount = 'garbage';
    inv.totals!.grossTotal = inv.totals!.netTotal;
    expect(checkD406Totals(badTax).some((p) => p.code === 'D406_AMOUNT')).toBe(true);

    const badPay = structuredClone(baseFiled);
    badPay.sourceDocuments.payments!.payments[0]!.lines[0]!.amount!.amount = 'garbage';
    badPay.sourceDocuments.payments!.payments[0]!.totals!.grossTotal = '0.00';
    expect(checkD406Totals(badPay).some((p) => p.code === 'D406_AMOUNT')).toBe(true);

    const badMove = structuredClone(baseFiled);
    badMove.sourceDocuments.movementOfGoods = {
      numberOfMovementLines: '1',
      totalQuantityReceived: '0.000000',
      totalQuantityIssued: '0.000000',
      movements: [{ lines: [{ quantity: 'garbage' }] }],
    };
    expect(checkD406Totals(badMove).some((p) => p.code === 'D406_QUANTITY')).toBe(true);

    // 9. Equivalent decimal percentages ('21.00' vs '21') match in tax totals without mutating strings.
    const eqPct = structuredClone(baseFiled);
    eqPct.sourceDocuments.salesInvoices!.invoices[0]!.lines[0]!.tax[0]!.percentage = '21.00';
    eqPct.sourceDocuments.salesInvoices!.invoices[0]!.totals!.taxes[0]!.percentage = '21';
    expect(checkD406Totals(eqPct)).toEqual([]);
    expect(eqPct.sourceDocuments.salesInvoices!.invoices[0]!.lines[0]!.tax[0]!.percentage).toBe(
      '21.00',
    );

    // 11. Invalid calendar dates produce D406_DATE problems in toD406 rather than throwing RangeError.
    const badDate = structuredClone(baseFiled);
    badDate.header.created = '2026-13-01';
    badDate.generalLedgerEntries.journals[0]!.transactions[0]!.date = '2026-02-30';
    const conv = toD406(badDate);
    expect(conv.problems.some((p) => p.code === 'D406_DATE' && p.path === 'header.created')).toBe(
      true,
    );
    expect(
      conv.problems.some(
        (p) =>
          p.code === 'D406_DATE' &&
          p.path === 'generalLedgerEntries.journals.0.transactions.0.date',
      ),
    ).toBe(true);
  });

  test('round-3 fixes: no throw on invalid input, missing side marks totals unchecked, unrepresentable/whitespace/mixed-text unread, and filed paths resolve', () => {
    const baseXml = writeD406(writerModel());
    const baseFiled = readD406(utf8(baseXml));

    // P2: Missing TaxCode, unknown TaxCode (399999), and duplicated customer return problems without throwing.
    const missingCode = structuredClone(baseFiled);
    missingCode.sourceDocuments.salesInvoices!.invoices[0]!.lines[0]!.tax[0]!.code = undefined;
    const missingConv = toD406(missingCode);
    expect(missingConv.problems.some((p) => p.code === 'D406_TAX_CODE')).toBe(true);

    const unknownCode = structuredClone(baseFiled);
    unknownCode.sourceDocuments.salesInvoices!.invoices[0]!.lines[0]!.tax[0]!.code = '399999';
    const unknownConv = toD406(unknownCode);
    expect(unknownConv.problems.some((p) => p.code === 'D406_TAX_CODE')).toBe(true);

    const dupCustomer = structuredClone(baseFiled);
    dupCustomer.masterFiles.customers.push(structuredClone(dupCustomer.masterFiles.customers[0]!));
    const dupConv = toD406(dupCustomer);
    expect(
      dupConv.problems.some(
        (p) => p.code === 'D406_PARTY_DUPLICATE' && p.path === 'masterFiles.customers.1.id',
      ),
    ).toBe(true);

    // P2: Missing DebitCreditIndicator reports D406_SIDE and marks dependent totals unchecked.
    const missingSalesSide = structuredClone(baseFiled);
    missingSalesSide.sourceDocuments.salesInvoices!.invoices[0]!.lines[0]!.side = undefined;
    missingSalesSide.sourceDocuments.salesInvoices!.totalCredit = '999.00';
    const salesSideProblems = checkD406Filed(missingSalesSide);
    expect(
      salesSideProblems.some(
        (p) =>
          p.code === 'D406_SIDE' &&
          p.path === 'sourceDocuments.salesInvoices.invoices.0.lines.0.side',
      ),
    ).toBe(true);
    expect(
      salesSideProblems.some(
        (p) =>
          p.code === 'D406_TOTAL_UNCHECKED' &&
          p.path === 'sourceDocuments.salesInvoices.totalCredit',
      ),
    ).toBe(true);

    const missingPaySide = structuredClone(baseFiled);
    missingPaySide.sourceDocuments.payments!.payments[0]!.lines[0]!.side = undefined;
    missingPaySide.sourceDocuments.payments!.totalDebit = '999.00';
    const paySideProblems = checkD406Filed(missingPaySide);
    expect(
      paySideProblems.some(
        (p) =>
          p.code === 'D406_SIDE' && p.path === 'sourceDocuments.payments.payments.0.lines.0.side',
      ),
    ).toBe(true);
    expect(
      paySideProblems.some(
        (p) =>
          p.code === 'D406_TOTAL_UNCHECKED' && p.path === 'sourceDocuments.payments.totalDebit',
      ),
    ).toBe(true);

    // P2: Empty BankAccount, non-XML whitespace (&#xA0;), and mixed container text in unread subtrees.
    const withUnrepresented = baseXml
      .replace('<nsSAFT:Header>', '<nsSAFT:Header>&#xA0;')
      .replace('<nsSAFT:BankAccount>', '<nsSAFT:BankAccount/><nsSAFT:BankAccount>')
      .replace(
        '</nsSAFT:Header>',
        '<nsSAFT:Extra>mixed<nsSAFT:Child>1</nsSAFT:Child></nsSAFT:Extra></nsSAFT:Header>',
      );
    const unreadFiled = readD406(utf8(withUnrepresented));
    const unreadPaths = unreadFiled.unread.map((u) => u.path);
    expect(unreadPaths).toContain('AuditFile/Header/#text');
    expect(unreadPaths).toContain('AuditFile/Header/Company/BankAccount');
    expect(unreadPaths).toContain('AuditFile/Header/Extra');
    expect(unreadPaths).toContain('AuditFile/Header/Extra/#text');
    expect(unreadPaths).toContain('AuditFile/Header/Extra/Child');
    expect(toD406(unreadFiled).problems.some((p) => p.code === 'D406_UNREAD')).toBe(true);

    // P3: Every reported problem path resolves against the filed object (payments, renamed fields, filtered accounts).
    const resolvePath = (root: unknown, path: string): { ok: boolean; hasLeaf: boolean } => {
      const parts = path.split('.');
      let cur: unknown = root;
      for (let idx = 0; idx < parts.length - 1; idx++) {
        const seg = parts[idx]!;
        if (cur === null || typeof cur !== 'object') return { ok: false, hasLeaf: false };
        if (Array.isArray(cur)) {
          if (!/^\d+$/.test(seg) || Number(seg) >= cur.length) return { ok: false, hasLeaf: false };
          cur = cur[Number(seg)];
        } else {
          if (!(seg in cur)) return { ok: false, hasLeaf: false };
          cur = (cur as Record<string, unknown>)[seg];
        }
      }
      if (cur === null || typeof cur !== 'object') return { ok: false, hasLeaf: false };
      const last = parts.at(-1)!;
      if (Array.isArray(cur)) {
        return { ok: /^\d+$/.test(last) && Number(last) < cur.length, hasLeaf: true };
      }
      return { ok: true, hasLeaf: last in cur };
    };

    // Invalid payment mechanism & date, FX rate & tax rate, product unit, and filtered accounts[0].
    const pathCase = structuredClone(baseFiled);
    pathCase.sourceDocuments.payments!.payments[0]!.mechanism = 'INVALID';
    pathCase.sourceDocuments.payments!.payments[0]!.date = '2026-99-99';
    pathCase.masterFiles.products[0]!.uomBase = 'BAD_UNIT';
    pathCase.masterFiles.products[0]!.uomStandard = 'BAD_UNIT';
    pathCase.masterFiles.accounts.unshift({
      id: '999999',
      description: 'Invalid',
      standard: '999999',
      type: 'Activ',
      openingDebit: '0.00',
      closingDebit: '0.00',
    });
    pathCase.masterFiles.accounts[1]!.openingDebit = 'bad';
    const glLine0 = pathCase.generalLedgerEntries.journals[0]!.transactions[0]!.lines[0]!;
    glLine0.amount = {
      amount: '1000.00',
      currencyCode: 'EUR',
      currencyAmount: '200.00',
      exchangeRate: '0',
    };
    const glLine1 = pathCase.generalLedgerEntries.journals[0]!.transactions[0]!.lines[1]!;
    glLine1.amount = {
      amount: '1000.00',
      currencyCode: 'EUR',
      currencyAmount: '200.00',
      exchangeRate: '5.0000',
    };
    glLine1.tax = [
      {
        type: '300',
        code: '310344',
        percentage: '21',
        base: '1000.00',
        amount: '210.00',
        currencyCode: 'EUR',
        currencyAmount: '42.00',
        exchangeRate: '0',
      },
    ];
    const pathConv = toD406(pathCase);
    expect(pathConv.problems.length).toBeGreaterThan(0);
    for (const p of pathConv.problems) {
      const resolved = resolvePath(pathCase, p.path);
      expect(resolved.ok).toBe(true);
    }
    const reportedPaths = pathConv.problems.map((p) => p.path);
    expect(reportedPaths).toContain('sourceDocuments.payments.payments.0.mechanism');
    expect(reportedPaths).not.toContain('sourceDocuments.payments.0.mechanism');
    expect(reportedPaths).not.toContain('sourceDocuments.payments.0.date');
    expect(reportedPaths).toContain('masterFiles.products.0.uomBase');
    expect(reportedPaths).toContain('masterFiles.accounts.1.openingDebit');
    expect(reportedPaths).toContain(
      'generalLedgerEntries.journals.0.transactions.0.lines.0.amount.exchangeRate',
    );
    expect(reportedPaths).toContain(
      'generalLedgerEntries.journals.0.transactions.0.lines.1.tax.0.exchangeRate',
    );
    for (const expectedPresent of [
      'sourceDocuments.payments.payments.0.mechanism',
      'sourceDocuments.payments.payments.0.date',
      'masterFiles.products.0.uomBase',
      'masterFiles.accounts.1.openingDebit',
      'generalLedgerEntries.journals.0.transactions.0.lines.0.amount.exchangeRate',
      'generalLedgerEntries.journals.0.transactions.0.lines.1.tax.0.exchangeRate',
    ]) {
      expect(resolvePath(pathCase, expectedPresent)).toEqual({ ok: true, hasLeaf: true });
    }
  });
});
