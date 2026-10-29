import { describe, expect, test } from 'bun:test';
import { referenceChart, chartAmendments } from '../src/ro/chart';
import {
  d406AccountId,
  d406AccountMapping,
  d406AccountType,
  d406AmbiguousAccounts,
  d406InStandardChart,
  d406StandardAccount,
} from '../src/ro/saft/accounts';
import { standardAccounts } from '../src/ro/saft/data/accounts';
import { invoiceTypes, paymentMechanisms, units } from '../src/ro/saft/data/codes';
import { taxTypes, vatTaxCodes } from '../src/ro/saft/data/tax';
import {
  calculateD406,
  checkD406,
  d406ConvertedAmount,
  d406Namespace,
  d406PartyId,
  d406Period,
  writeD406,
  type D406,
  type D406Line,
  type D406Transaction,
} from '../src/ro/saft/d406';

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

const model = (extra: Partial<D406> = {}): D406 => ({
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

const codes = (value: D406) => checkD406(value).map((check) => `${check.severity}:${check.code}`);
const between = (xml: string, tag: string) => xml.match(new RegExp(`<nsSAFT:${tag}>([^<]*)<`))?.[1];

describe('D406 code tables and account mapping', () => {
  test('extracts the subsets the writer uses', () => {
    expect(taxTypes['300']).toBe('Taxa pe valoarea adaugata');
    expect(vatTaxCodes['310344']).toEqual({
      kind: 'sales',
      description: 'Livrări de bunuri şi prestări de servicii taxabile cu cota 21%',
      percentage: '21',
    });
    expect(vatTaxCodes['301104']?.percentage).toBe('21');
    expect(vatTaxCodes['300704']?.kind).toBe('purchases');
    expect(vatTaxCodes['380006']?.kind).toBe('ledger');
    expect(Object.keys(invoiceTypes)).toEqual(['380', '381', '384', '389', '575', '751']);
    expect(paymentMechanisms['42']).toEqual({
      method: '03',
      description: 'Plata în contul bancar',
    });
    expect(paymentMechanisms['10']?.method).toBe('01');
    expect(units['E48']).toBe('unitate de service');
    expect(standardAccounts['4111']).toBe('Clienţi');
  });

  test('maps every postable account of classes 1–8 and the amendments', () => {
    const mapping = d406AccountMapping();
    const postable = [...referenceChart.accounts, ...chartAmendments.flatMap((a) => a.accounts)]
      .filter((account) => account.postable && /^[1-8]/.test(account.code))
      .map((account) => account.code);
    expect(mapping.map((entry) => entry.code).sort()).toEqual(postable.sort());
    expect(mapping.filter((entry) => entry.standard.length === 0)).toEqual([]);
    for (const code of ['4315', '4316', '436', '4111', '5121', '704', '6811'])
      expect(d406StandardAccount(code)).toBe(code);
    // Ambiguous: the engine posts on a synthetic the standard chart subdivides.
    const subdivided = postable.filter((code) =>
      Object.keys(standardAccounts).some((other) => other !== code && other.startsWith(code)),
    );
    expect(Object.keys(d406AmbiguousAccounts).sort()).toEqual(subdivided.sort());
    expect(d406AmbiguousAccounts['646']).toEqual(['6461', '6462']);
    for (const choices of Object.values(d406AmbiguousAccounts))
      for (const choice of choices) expect(standardAccounts[choice]).toBeDefined();
  });

  test('takes the synthetic standard account of an analytical account', () => {
    expect(d406StandardAccount('4111.01')).toBe('4111');
    expect(d406StandardAccount('401.02')).toBe('401');
    expect(d406StandardAccount('646')).toBeUndefined();
    expect(d406StandardAccount('646.01', '6461')).toBe('6461');
    expect(d406StandardAccount('646', '6463')).toBeUndefined();
    expect(d406StandardAccount('4111', '411')).toBeUndefined();
    expect(d406StandardAccount('999')).toBeUndefined();
  });

  test('writes account codes as the integers the validator reads', () => {
    expect(d406AccountId('5121')).toBe('5121');
    expect(d406AccountId('4111.01')).toBe('411101');
    expect(d406AccountId('401.01')).toBe('40101');
    expect(d406AccountId('4426.0001')).toBe('44260001');
    expect(d406AccountId('646')).toBe('646');
    // 605.1 would read as 6051 (energy); a letter has no numeric form.
    expect(d406AccountId('605.1')).toBeUndefined();
    expect(d406AccountId('4111.CL')).toBeUndefined();
  });

  test('derives the account type from the chart', () => {
    expect(d406AccountType('5121')).toBe('Activ');
    expect(d406AccountType('401.01')).toBe('Pasiv');
    expect(d406AccountType('121')).toBe('Bifunctional');
    expect(d406AccountType('436')).toBe('Pasiv');
    expect(d406AccountType('999')).toBeUndefined();
  });

  test('checks ids against the standard chart as the validator does', () => {
    expect(d406InStandardChart('44260001')).toBe(true);
    expect(d406InStandardChart('411101')).toBe(true);
    expect(d406InStandardChart('4429')).toBe(false);
    expect(d406InStandardChart('999')).toBe(false);
  });
});

describe('D406 calculation', () => {
  test('computes closing balances from the openings and the period entries', () => {
    const calculation = calculateD406(model());
    const byCode = Object.fromEntries(calculation.accounts.map((entry) => [entry.code, entry]));
    expect(byCode['4111.01']).toMatchObject({
      id: '411101',
      standard: '4111',
      type: 'Activ',
      opening: 100000n,
      debit: 121000n,
      credit: 100000n,
      closing: 121000n,
    });
    expect(byCode['401.01']).toMatchObject({ opening: -80000n, closing: -140500n });
    expect(byCode['646']).toMatchObject({ id: '646', standard: '6461', closing: 10100n });
    expect(calculation.customers).toEqual([
      { id: customer, opening: 100000n, debit: 121000n, credit: 100000n, closing: 121000n },
    ]);
    expect(calculation.suppliers[0]!.closing).toBe(-140500n);
    expect(calculation.ledger).toEqual({
      lines: 14,
      transactions: 4,
      debit: 854100n,
      credit: 854100n,
    });
    expect(calculation.companyId).toBe('0018547290');
  });

  test('totals invoices and payments, and lists the tax codes and units used', () => {
    const calculation = calculateD406(model());
    expect(calculation.sales).toEqual({
      count: 1,
      debit: 0n,
      credit: 100000n,
      invoices: [
        {
          taxes: [{ type: '300', code: '310344', base: 100000n, amount: 21000n }],
          net: 100000n,
          gross: 121000n,
        },
      ],
    });
    expect(calculation.purchases.debit).toBe(50000n);
    expect(calculation.payments).toEqual({
      count: 1,
      debit: 100000n,
      credit: 0n,
      gross: [100000n],
    });
    expect(calculation.vatCodes).toEqual(['301104', '310344']);
    expect(calculation.units).toEqual(['E48', 'H87']);
  });

  test('nets stornos recorded in red or in black against the invoice', () => {
    const base = model().salesInvoices[0]!.lines[0]!;
    const invoice = (lines: (typeof base)[]) =>
      calculateD406(
        model({
          salesInvoices: [
            { number: 'XF-2', party: customer, date: '2026-10-09', type: '381', lines },
          ],
        }),
      ).sales;
    const red = invoice([
      { ...base, amount: '-100.00', unitPrice: '-100.00', tax: [vat('-100.00', '-21.00')] },
    ]);
    expect(red.invoices[0]).toMatchObject({ net: -10000n, gross: -12100n });
    expect(red.credit).toBe(-10000n);
    const black = invoice([
      {
        ...base,
        side: 'debit',
        amount: '100.00',
        unitPrice: '100.00',
        tax: [vat('100.00', '21.00')],
      },
    ]);
    expect(black.invoices[0]).toMatchObject({ net: -10000n, gross: -12100n });
    expect(black.debit).toBe(10000n);
  });

  test('converts currency amounts as the validator rounds', () => {
    expect(d406ConvertedAmount({ code: 'EUR', amount: '484.00', rate: '5.08' })).toBe(245872n);
    expect(d406ConvertedAmount({ code: 'EUR', amount: '0.99', rate: '5.0899' })).toBe(504n);
  });

  test('gives the selection dates of a month and of a quarter', () => {
    expect(d406Period({ type: 'L', period: { year: 2026, month: 2 } })).toEqual({
      start: '2026-02-01',
      end: '2026-02-28',
    });
    expect(d406Period({ type: 'T', period: { year: 2026, month: 9 } })).toEqual({
      start: '2026-07-01',
      end: '2026-09-30',
    });
  });

  test('refuses amounts it cannot carry and accounts or partners it cannot resolve', () => {
    expect(() =>
      calculateD406(
        model({
          accounts: [
            ...model().accounts.slice(1),
            { code: '1012', description: 'C', opening: '1.234' },
          ],
        }),
      ),
    ).toThrow('cel mult două zecimale');
    const unknown = model({
      journals: [
        {
          id: 'J',
          description: 'J',
          type: 'J',
          transactions: [
            {
              ...receipt,
              lines: [line('1', '5124', 'debit', '1'), line('2', '5121', 'credit', '1')],
            },
          ],
        },
      ],
    });
    expect(() => calculateD406(unknown)).toThrow('Contul 5124 nu figurează');
  });
});

describe('D406 XML', () => {
  test('writes the periodic file in the d406 namespace, sections in the schema order', () => {
    const xml = writeD406(model());
    expect(xml).toStartWith(
      `<?xml version="1.0" encoding="UTF-8"?>\n<nsSAFT:AuditFile xmlns:nsSAFT="${d406Namespace}">`,
    );
    const children = (block: string, indent: number) =>
      [...block.matchAll(new RegExp(`^ {${indent}}<nsSAFT:(\\w+)`, 'gm'))].map((match) => match[1]);
    const block = (tag: string) =>
      xml.slice(xml.indexOf(`<nsSAFT:${tag}>`), xml.indexOf(`</nsSAFT:${tag}>`));
    expect(children(xml, 2)).toEqual([
      'Header',
      'MasterFiles',
      'GeneralLedgerEntries',
      'SourceDocuments',
    ]);
    expect(children(block('MasterFiles'), 4)).toEqual([
      'GeneralLedgerAccounts',
      'Customers',
      'Suppliers',
      'TaxTable',
      'UOMTable',
      'AnalysisTypeTable',
      'MovementTypeTable',
      'Products',
      'Owners',
      'Assets',
    ]);
    expect(children(block('SourceDocuments'), 4)).toEqual([
      'SalesInvoices',
      'PurchaseInvoices',
      'Payments',
      'MovementOfGoods',
    ]);
    for (const empty of [
      'AnalysisTypeTable',
      'MovementTypeTable',
      'Owners',
      'Assets',
      'MovementOfGoods',
    ])
      expect(xml).toContain(`<nsSAFT:${empty}/>`);
    expect(xml).not.toContain('PhysicalStock');
    expect(xml).not.toContain('AssetTransactions');
    expect(between(xml, 'RegistrationNumber')).toBe('RO18547290');
    expect(between(xml, 'HeaderComment')).toBe('L');
    expect(between(xml, 'SelectionStartDate')).toBe('2026-10-01');
    expect(between(xml, 'SelectionEndDate')).toBe('2026-10-31');
    expect(between(xml, 'TaxAccountingBasis')).toBe('A');
  });

  test('writes balances on their side as positive amounts', () => {
    const xml = writeD406(model());
    const account = (id: string) =>
      xml.slice(xml.indexOf(`<nsSAFT:AccountID>${id}<`)).split('</nsSAFT:Account>')[0]!;
    expect(account('411101')).toContain('<nsSAFT:OpeningDebitBalance>1000.00<');
    expect(account('411101')).toContain('<nsSAFT:ClosingDebitBalance>1210.00<');
    expect(account('40101')).toContain('<nsSAFT:OpeningCreditBalance>800.00<');
    expect(account('40101')).toContain('<nsSAFT:ClosingCreditBalance>1405.00<');
    // Zero balances take the account's side.
    expect(account('4427')).toContain('<nsSAFT:OpeningCreditBalance>0.00<');
    expect(account('4426')).toContain('<nsSAFT:OpeningDebitBalance>0.00<');
    expect(account('646')).toContain('<nsSAFT:StandardAccountID>6461<');
  });

  test('names partners on their lines and the company elsewhere', () => {
    const xml = writeD406(model());
    const transaction = (id: string) =>
      xml.slice(xml.indexOf(`<nsSAFT:TransactionID>${id}<`)).split('</nsSAFT:Transaction>')[0]!;
    const sale = transaction('VZ-1');
    expect(between(sale, 'CustomerID')).toBe(customer);
    expect(between(sale, 'SupplierID')).toBe('0');
    expect(sale).toContain(
      `<nsSAFT:CustomerID>0018547290</nsSAFT:CustomerID>\n          <nsSAFT:SupplierID>0018547290<`,
    );
    expect(between(transaction('SAL-1'), 'CustomerID')).toBe('0018547290');
    expect(between(transaction('CP-1'), 'SupplierID')).toBe(supplier);
    // Lines without tax relevance carry TaxType 000 and TaxCode 000000.
    expect(sale).toContain(
      '<nsSAFT:TaxType>000</nsSAFT:TaxType>\n            <nsSAFT:TaxCode>000000<',
    );
    expect(sale).toContain(
      '<nsSAFT:TaxPercentage>21</nsSAFT:TaxPercentage>\n            <nsSAFT:TaxBase>1000.00<',
    );
    expect(between(xml, 'NumberOfEntries')).toBe('14');
  });

  test('writes foreign-currency amounts with their rate', () => {
    const euro = model({
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
      accounts: model().accounts.map((account) =>
        account.code === '5121'
          ? { ...account, opening: '29000.00' }
          : account.code === '4111.01'
            ? { ...account, opening: '2000.00' }
            : account,
      ),
      customers: [{ ...model().customers[0]!, opening: '2000.00' }],
    });
    expect(codes(euro)).toEqual([]);
    const xml = writeD406(euro);
    expect(xml).toContain(
      '<nsSAFT:CreditAmount>\n            <nsSAFT:Amount>508.00</nsSAFT:Amount>\n            <nsSAFT:CurrencyCode>EUR</nsSAFT:CurrencyCode>\n            <nsSAFT:CurrencyAmount>100.00</nsSAFT:CurrencyAmount>\n            <nsSAFT:ExchangeRate>5.08</nsSAFT:ExchangeRate>',
    );
    expect(xml).toContain(
      '<nsSAFT:Amount>508.00</nsSAFT:Amount>\n            <nsSAFT:CurrencyCode>RON</nsSAFT:CurrencyCode>\n            <nsSAFT:CurrencyAmount>508.00<',
    );
  });

  test('writes invoices, payments and the tables they use', () => {
    const xml = writeD406(model());
    expect(xml).toContain('<nsSAFT:TaxCode>301104</nsSAFT:TaxCode>');
    expect(xml).toContain('<nsSAFT:BaseRate>1</nsSAFT:BaseRate>');
    expect(xml).toContain(
      '<nsSAFT:UnitOfMeasure>H87</nsSAFT:UnitOfMeasure>\n        <nsSAFT:Description>bucată<',
    );
    expect(xml).toContain(
      '<nsSAFT:UOMStandard>E48</nsSAFT:UOMStandard>\n        <nsSAFT:UOMToUOMBaseConversionFactor>1<',
    );
    const invoice = xml.slice(xml.indexOf('<nsSAFT:SalesInvoices>'));
    expect(between(invoice, 'TotalCredit')).toBe('1000.00');
    expect(between(invoice, 'AccountID')).toBe('411101');
    expect(between(invoice, 'DebitCreditIndicator')).toBe('C');
    expect(between(invoice, 'GrossTotal')).toBe('1210.00');
    const payments = xml.slice(xml.indexOf('<nsSAFT:Payments>'));
    expect(between(payments, 'PaymentMethod')).toBe('03');
    expect(between(payments, 'PaymentMechanism')).toBe('42');
    expect(between(payments, 'DebitCreditIndicator')).toBe('D');
    expect(between(payments, 'SupplierID')).toBe('0');
  });

  test('writes an intra-EU service purchase with the reverse-charge VAT on its base', () => {
    const eu = d406PartyId({ kind: 'eu', country: 'DE', vat: '123456789' });
    const base = model();
    const reverse: D406Transaction = {
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
    };
    const withEu = model({
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
        { ...base.journals[0]!, transactions: [...base.journals[0]!.transactions, reverse] },
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
    });
    expect(checkD406(withEu)).toEqual([]);
    const xml = writeD406(withEu);
    expect(xml).toContain(`<nsSAFT:SupplierID>01DE123456789</nsSAFT:SupplierID>`);
    expect(xml).toContain('<nsSAFT:AccountID>40102</nsSAFT:AccountID>');
    expect(xml).toContain('<nsSAFT:TaxCode>300704</nsSAFT:TaxCode>');
    expect(calculateD406(withEu).vatCodes).toEqual(['300704', '301104', '310344']);
  });

  test('leaves out source-document sections without documents', () => {
    const xml = writeD406(model({ purchaseInvoices: [], payments: [] }));
    expect(xml).toContain('<nsSAFT:SalesInvoices>');
    expect(xml).not.toContain('PurchaseInvoices');
    expect(xml).not.toContain('<nsSAFT:Payments>');
  });

  test('writes a quarter, escapes text and is deterministic', () => {
    const quarter = model({
      type: 'T',
      period: { year: 2026, month: 12 },
      company: { ...model().company, name: 'Exemplu & Fiii <SRL>' },
    });
    const xml = writeD406(quarter);
    expect(between(xml, 'HeaderComment')).toBe('T');
    expect(between(xml, 'SelectionStartDate')).toBe('2026-10-01');
    expect(xml).toContain('<nsSAFT:Name>Exemplu &amp; Fiii &lt;SRL&gt;</nsSAFT:Name>');
    expect(writeD406(quarter)).toBe(xml);
  });

  test('refuses a file checkD406 rejects', () => {
    expect(() => writeD406(model({ type: 'T' }))).toThrow('trimestre calendaristice');
  });
});

describe('D406 checks', () => {
  test('pass for a consistent month', () => {
    expect(checkD406(model())).toEqual([]);
  });

  test('match the file type to the period', () => {
    expect(codes(model({ type: 'T' }))).toEqual(['error:D406_TYPE']);
    expect(codes(model({ period: { year: 2019, month: 12 } }))).toContain('error:D406_PERIOD');
  });

  test('require a standard account for every account and an unambiguous AccountID', () => {
    const accounts = model().accounts;
    const replace = (code: string, entry: Partial<D406['accounts'][number]>) =>
      model({
        accounts: accounts.map((account) =>
          account.code === code ? { ...account, ...entry } : account,
        ),
      });
    expect(codes(replace('646', { standard: undefined }))).toEqual(['error:D406_STANDARD_ACCOUNT']);
    expect(checkD406(replace('646', { standard: undefined }))[0]!.message).toContain('6461, 6462');
    expect(codes(replace('646', { standard: '6463' }))).toEqual(['error:D406_STANDARD_ACCOUNT']);
    const lettered = model({
      accounts: [...accounts, { code: '4111.CL', description: 'Clienți', opening: '0' }],
    });
    expect(codes(lettered)).toEqual(['error:D406_ACCOUNT_ID']);
    const named = model({
      accounts: [
        ...accounts,
        { code: '4111.CL', id: '411199', description: 'Clienți', opening: '0' },
      ],
    });
    expect(codes(named)).toEqual([]);
    const collision = model({
      accounts: [...accounts, { code: '4111.0.1', description: 'Clienți', opening: '0' }],
    });
    expect(codes(collision)).toEqual(['error:D406_ACCOUNT_ID']);
    const outside = model({
      accounts: [...accounts, { code: '4111.X', id: '5111', description: 'X', opening: '0' }],
    });
    expect(codes(outside)).toEqual(['error:D406_ACCOUNT_ID']);
    const unknown = model({
      accounts: [...accounts, { code: '999', description: 'X', opening: '0' }],
    });
    expect(codes(unknown)).toEqual([
      'error:D406_CLASS',
      'error:D406_ACCOUNT',
      'error:D406_ACCOUNT_PLAN',
      'error:D406_STANDARD_ACCOUNT',
    ]);
  });

  test('require balanced entries and balanced openings', () => {
    const unbalanced = model({
      journals: [
        {
          id: 'J',
          description: 'J',
          type: 'J',
          transactions: [
            sale,
            purchase,
            receipt,
            { ...payroll, lines: payroll.lines.slice(0, -1) },
          ],
        },
      ],
    });
    expect(codes(unbalanced)).toEqual(['error:D406_UNBALANCED']);
    expect(checkD406(unbalanced)[0]!.message).toContain('101.00 lei');
    const opening = model({
      accounts: model().accounts.map((a) =>
        a.code === '5121' ? { ...a, opening: '30001.00' } : a,
      ),
    });
    expect(codes(opening)).toEqual(['error:D406_BALANCES', 'error:D406_BALANCES']);
    const outside = model({
      journals: [
        {
          id: 'J',
          description: 'J',
          type: 'J',
          transactions: [sale, purchase, receipt, { ...payroll, posted: '2026-11-02' }],
        },
      ],
    });
    expect(codes(outside)).toEqual(['error:D406_POSTED']);
  });

  test('check partner codes and addresses', () => {
    const party = model().customers[0]!;
    const with_ = (entry: Partial<typeof party>) =>
      model({
        customers: [{ ...party, ...entry }],
        journals: [{ id: 'J', description: 'J', type: 'J', transactions: [purchase, payroll] }],
        salesInvoices: [],
        payments: [],
        accounts: model().accounts.map((a) =>
          a.code === '4111.01' ? { ...a, opening: party.opening } : a,
        ),
      });
    expect(codes(with_({}))).toEqual([]);
    expect(codes(with_({ id: '0014399841' }))).toEqual(['error:D406_PARTY_ID']);
    expect(codes(with_({ id: 'RO14399840' }))).toEqual(['error:D406_PARTY_ID']);
    expect(
      codes(
        with_({
          id: d406PartyId({ kind: 'eu', country: 'DE', vat: '123456789' }),
          address: { city: 'Berlin', country: 'DE' },
        }),
      ),
    ).toEqual([]);
    expect(codes(with_({ id: '01RO14399840' }))).toEqual(['error:D406_PARTY_ID']);
    expect(codes(with_({ address: { city: 'Berlin', county: 'RO-B', country: 'DE' } }))).toEqual([
      'error:D406_ADDRESS',
    ]);
    expect(codes(with_({ address: { city: 'Galați', county: 'RO-XX', country: 'RO' } }))).toEqual([
      'error:D406_ADDRESS',
    ]);
    expect(
      codes(
        model({
          customers: [],
          salesInvoices: [],
          journals: [{ id: 'J', description: 'J', type: 'J', transactions: [purchase, payroll] }],
          payments: [],
        }),
      ),
    ).toEqual(['error:D406_PARTIES']);
    const anonymous = model({ suppliers: [{ ...model().suppliers[0]!, id: '080000000000000' }] });
    expect(codes(anonymous)).toContain('error:D406_PARTY_ID');
  });

  test('check currency conversion and VAT against its base', () => {
    const converted = (amount: string) =>
      model({
        journals: [
          {
            id: 'J',
            description: 'J',
            type: 'J',
            transactions: [
              {
                ...receipt,
                lines: [
                  line('7', '5121', 'debit', amount),
                  line('8', '4111.01', 'credit', amount, {
                    customer,
                    currency: { code: 'EUR', amount: '100.00', rate: '5.08' },
                  }),
                ],
              },
            ],
          },
        ],
        accounts: model().accounts.map((a) =>
          a.code === '4111.01' ? { ...a, opening: '1000.00' } : a,
        ),
        salesInvoices: [],
        purchaseInvoices: [],
        payments: [],
      });
    expect(codes(converted('509.00'))).toContain('error:D406_CONVERSION');
    const vatOff = model({
      journals: [
        {
          id: 'J',
          description: 'J',
          type: 'J',
          transactions: [
            {
              ...sale,
              lines: [
                sale.lines[0]!,
                { ...sale.lines[1]!, tax: [vat('1000.00', '200.00')] },
                line('3', '4427', 'credit', '210.00', { tax: [vat('1000.00', '210.00')] }),
              ],
            },
            purchase,
            receipt,
            payroll,
          ],
        },
      ],
    });
    expect(codes(vatOff)).toEqual(['warning:D406_VAT', 'warning:D406_VAT_ACCOUNT']);
    const taxed = model({
      journals: [
        {
          id: 'J',
          description: 'J',
          type: 'J',
          transactions: [
            {
              ...sale,
              lines: [
                { ...sale.lines[0]!, tax: [{ type: '000', code: '000000', amount: '1.00' }] },
                ...sale.lines.slice(1),
              ],
            },
            purchase,
            receipt,
            payroll,
          ],
        },
      ],
    });
    expect(codes(taxed)).toEqual(['error:D406_TAX_AMOUNT']);
    const codesOff = model({
      journals: [
        {
          id: 'J',
          description: 'J',
          type: 'J',
          transactions: [
            {
              ...sale,
              lines: [
                { ...sale.lines[0]!, tax: [{ type: '555', code: '000000', amount: '0' }] },
                { ...sale.lines[1]!, tax: [vat('1000.00', '210.00', '310399')] },
                sale.lines[2]!,
              ],
            },
            purchase,
            receipt,
            payroll,
          ],
        },
      ],
    });
    expect(codes(codesOff)).toEqual(['error:D406_TAX_TYPE', 'error:D406_TAX_CODE']);
  });

  test('require the entries a periodic file has', () => {
    expect(codes(model({ products: [] }))).toEqual([
      'error:D406_PRODUCTS',
      'error:D406_PRODUCT_UNKNOWN',
    ]);
    expect(codes(model({ company: { ...model().company, ibans: [] } }))).toEqual([
      'error:D406_BANK',
    ]);
    expect(codes(model({ company: { ...model().company, cui: '18547291' } }))).toEqual([
      'error:D406_CUI',
    ]);
    expect(codes(model({ payments: [{ ...model().payments[0]!, mechanism: '71' }] }))).toEqual([
      'error:D406_MECHANISM',
    ]);
    expect(
      codes(model({ salesInvoices: [{ ...model().salesInvoices[0]!, type: '386' }] })),
    ).toEqual(['error:D406_INVOICE_TYPE']);
  });
});
