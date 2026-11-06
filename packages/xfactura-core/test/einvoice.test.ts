import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import {
  calculateInvoice,
  checkInvoice,
  compareInvoices,
  fromInvoicer,
  readInvoice,
  verifyInvoice,
  writeInvoice,
  type InvoiceDraft,
  type InvoicerInvoice,
} from '../src/einvoice';
import { bucharestSector, countryCode, countyCode } from '../src/ro/geo';
import { isValidCnp, isValidCui } from '../src/ro/identifiers';

const bytes = (text: string) => new TextEncoder().encode(text);
const roundTrip = (draft: InvoiceDraft) => {
  const invoice = calculateInvoice(draft);
  return { invoice, read: readInvoice(bytes(writeInvoice(invoice))) };
};

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
const draft = (lines: InvoiceDraft['lines'], extra: Partial<InvoiceDraft> = {}): InvoiceDraft => ({
  typeCode: '380',
  number: 'XF-1',
  issueDate: '2026-03-10',
  currency: 'RON',
  seller,
  buyer,
  lines,
  ...extra,
});
const service = (price: string, quantity = '1', rate = '21') => ({
  name: 'Servicii',
  quantity,
  unitCode: 'C62',
  price,
  vat: { category: 'S' as const, rate },
});

describe('e-Factura calculation', () => {
  test('rounds each line, adjustment and VAT category once, half away from zero', () => {
    const invoice = calculateInvoice(
      draft([
        service('12.345', '2.5', '19'), // 30.8625 → 30.86
        service('10.005', '1', '19'), // 10.005 → 10.01
        {
          ...service('199.99', '3', '19'), // 599.97, 10% = 59.997 → 60.00
          adjustments: [{ charge: false, reason: 'Discount volum', percent: '10' }],
        },
      ]),
    );
    expect(invoice.lines.map((line) => line.netAmount)).toEqual(['30.86', '10.01', '539.97']);
    expect(invoice.lines[2]!.adjustments).toEqual([
      { charge: false, reason: 'Discount volum', amount: '60.00', percent: '10', base: '599.97' },
    ]);
    // 580.84 × 19% = 110.3596
    expect(invoice.vatBreakdown).toEqual([
      { category: 'S', rate: '19', taxable: '580.84', tax: '110.36' },
    ]);
    expect(invoice.totals).toEqual({
      lines: '580.84',
      allowances: '0.00',
      charges: '0.00',
      taxExclusive: '580.84',
      tax: '110.36',
      taxInclusive: '691.20',
      prepaid: '0.00',
      rounding: '0.00',
      payable: '691.20',
    });
  });

  test('keeps a breakdown per rate and applies document adjustments to their category', () => {
    const invoice = calculateInvoice(
      draft([service('1000', '1', '19'), service('1000', '1', '21')], {
        adjustments: [
          { charge: false, reason: 'Reducere', percent: '5', vat: { category: 'S', rate: '21' } },
          { charge: true, reason: 'Transport', amount: '50', vat: { category: 'S', rate: '19' } },
        ],
        prepaid: '100',
      }),
    );
    expect(invoice.vatBreakdown).toEqual([
      { category: 'S', rate: '19', taxable: '1050.00', tax: '199.50' },
      { category: 'S', rate: '21', taxable: '950.00', tax: '199.50' },
    ]);
    expect(invoice.totals).toMatchObject({
      lines: '2000.00',
      allowances: '50.00',
      charges: '50.00',
      taxExclusive: '2000.00',
      tax: '399.00',
      taxInclusive: '2399.00',
      prepaid: '100.00',
      payable: '2299.00',
    });
  });

  test('rounds negative storno amounts symmetrically', () => {
    const invoice = calculateInvoice(draft([service('0.335', '-1', '21'), service('100', '-1')]));
    expect(invoice.lines.map((line) => line.netAmount)).toEqual(['-0.34', '-100.00']);
    // -100.34 × 21% = -21.0714
    expect(invoice.totals).toMatchObject({ tax: '-21.07', payable: '-121.41' });
  });

  test('states 0 for zero-rated categories, none for O, and moves exemptions to the breakdown', () => {
    const invoice = calculateInvoice(
      draft([
        { ...service('100'), vat: { category: 'E', exemptionCode: 'VATEX-EU-132' } },
        { ...service('50'), vat: { category: 'E', exemptionCode: 'VATEX-EU-132' } },
      ]),
    );
    expect(invoice.lines[0]!.vat).toEqual({ category: 'E', rate: '0' });
    expect(invoice.vatBreakdown).toEqual([
      { category: 'E', rate: '0', taxable: '150.00', tax: '0.00', exemptionCode: 'VATEX-EU-132' },
    ]);
    expect(() =>
      calculateInvoice(draft([{ ...service('1'), vat: { category: 'O', rate: '0' } }])),
    ).toThrow('nu au cotă');
    expect(() => calculateInvoice(draft([{ ...service('1'), vat: { category: 'S' } }]))).toThrow(
      'cotă pozitivă',
    );
  });

  test('rejects amounts it would otherwise have to round silently', () => {
    expect(() => calculateInvoice(draft([service('1.123456789')]))).toThrow();
    expect(() =>
      calculateInvoice(
        draft([
          { ...service('10'), adjustments: [{ charge: false, reason: 'X', amount: '1.005' }] },
        ]),
      ),
    ).toThrow();
  });
});

describe('e-Factura UBL', () => {
  test('writes and reads back invoices and credit notes unchanged', () => {
    for (const extra of [
      {},
      {
        typeCode: '381' as const,
        precedingInvoices: [{ number: 'XF-0', issueDate: '2026-02-01' }],
        dueDate: '2026-04-10',
        payment: { meansCode: '30', accounts: [{ id: 'RO49AAAA1B31007593840000' }] },
      },
      {
        currency: 'EUR',
        vatCurrency: 'RON' as const,
        vatAccountingTotal: '104.30',
        notes: ['Curs BNR 4,9670 lei/euro'],
        invoicingPeriod: { start: '2026-02-01', end: '2026-02-28' },
        deliveryDate: '2026-02-28',
        taxPointCode: '3' as const,
      },
      // A credit note in euro, its VAT in lei at its invoice's rate (Codul fiscal art. 282 alin.
      // (9)): 22.05 EUR × 4.9670 = 109.52.
      {
        typeCode: '381' as const,
        precedingInvoices: [{ number: 'XF-0', issueDate: '2026-02-01' }],
        currency: 'EUR',
        vatCurrency: 'RON' as const,
        vatAccountingTotal: '109.52',
        notes: ['Curs BNR 4,9670 lei/euro, al facturii XF-0'],
        payment: { meansCode: '30', accounts: [{ id: 'RO49AAAA1B31007593840000' }] },
      },
    ]) {
      const { invoice, read } = roundTrip(
        draft(
          [
            {
              ...service('100'),
              description: 'Detalii & condiții <speciale>',
              adjustments: [{ charge: true, reason: 'Urgență', amount: '5' }],
            },
          ],
          extra,
        ),
      );
      expect(read).toEqual(invoice);
      expect(verifyInvoice(read)).toEqual([]);
    }
  });

  test('is canonical and follows the UBL element order', () => {
    const invoice = calculateInvoice(
      draft([service('100')], { dueDate: '2026-04-09', notes: ['N'] }),
    );
    const xml = writeInvoice(invoice);
    expect(writeInvoice(readInvoice(bytes(xml)))).toBe(xml);
    const order = [...xml.matchAll(/^  <(cac|cbc):(\w+)/gm)].map((match) => match[2]);
    expect(order).toEqual([
      'CustomizationID',
      'ID',
      'IssueDate',
      'DueDate',
      'InvoiceTypeCode',
      'Note',
      'DocumentCurrencyCode',
      'AccountingSupplierParty',
      'AccountingCustomerParty',
      'TaxTotal',
      'LegalMonetaryTotal',
      'InvoiceLine',
    ]);
  });

  test('reports stated amounts that disagree with the recalculation', () => {
    const xml = writeInvoice(calculateInvoice(draft([service('100')]))).replace(
      '<cbc:PayableAmount currencyID="RON">121.00</cbc:PayableAmount>',
      '<cbc:PayableAmount currencyID="RON">121.01</cbc:PayableAmount>',
    );
    expect(verifyInvoice(readInvoice(bytes(xml)))).toEqual(['total payable: 121.01 ≠ 121.00']);
  });

  test('property: any calculated invoice survives writing and reading', () => {
    const decimal = (max: number, scale: number) =>
      fc
        .tuple(fc.integer({ min: 0, max }), fc.integer({ min: 0, max: 10 ** scale - 1 }))
        .map(([whole, fraction]) => `${whole}.${String(fraction).padStart(scale, '0')}`);
    const text = fc.string({ minLength: 1, maxLength: 40 }).filter((value) => {
      const trimmed = value.trim();
      return trimmed.length > 0 && !/[\u0000-\u001f￾￿]/.test(value) && trimmed === value;
    });
    const line = fc.record({
      name: text,
      quantity: fc
        .tuple(decimal(9999, 3), fc.boolean())
        .map(([value, negative]) => (negative ? `-${value}` : value)),
      unitCode: fc.constantFrom('C62', 'H87', 'HUR'),
      price: decimal(99999, 4),
      vat: fc.constantFrom(
        { category: 'S' as const, rate: '21' },
        { category: 'S' as const, rate: '11' },
        { category: 'Z' as const },
        { category: 'AE' as const, exemptionCode: 'VATEX-EU-AE' },
      ),
      adjustments: fc.array(
        fc.oneof(
          fc.record({ charge: fc.boolean(), reason: text, amount: decimal(99, 2) }),
          fc.record({ charge: fc.boolean(), reason: text, percent: decimal(50, 2) }),
        ),
        { maxLength: 2 },
      ),
    });
    fc.assert(
      fc.property(
        fc.array(line, { minLength: 1, maxLength: 6 }),
        fc.constantFrom('380', '381'),
        (lines, typeCode) => {
          const { invoice, read } = roundTrip(
            draft(lines, { typeCode: typeCode as '380' | '381' }),
          );
          expect(read).toEqual(invoice);
          expect(verifyInvoice(read)).toEqual([]);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('invoice checks', () => {
  test('flag Romanian addresses, lei VAT for foreign currency and VAT identifiers', () => {
    const invoice = calculateInvoice(
      draft([service('100')], {
        currency: 'EUR',
        seller: { ...seller, vatId: undefined },
        buyer: { ...buyer, address: { ...buyer.address, city: 'București' } },
      }),
    );
    expect(checkInvoice(invoice).map((check) => check.code)).toEqual([
      'RO_SECTOR',
      'VAT_CURRENCY',
      'SELLER_VAT_ID',
    ]);
    expect(checkInvoice(calculateInvoice(draft([service('100')])))).toEqual([]);
  });

  test('a seller without a VAT code invoices outside the scope of VAT, without VAT codes', () => {
    const { draft: converted, notes } = fromInvoicer({
      id: 'non-payer',
      seller: {
        name: 'PFA Exemplu',
        vatNumber: '18547290',
        vatPayer: false,
        address: 'Str. A 1',
        city: 'Cluj-Napoca',
        county: 'Cluj',
        country: 'România',
      },
      buyer: {
        name: 'Client Test SRL',
        vatNumber: 'RO14399840',
        vatPayer: true,
        address: 'Bd. B 2',
        city: 'Brașov',
        county: 'Brașov',
        country: 'România',
      },
      metadata: {
        number: '1',
        currency: 'RON',
        issueDate: Date.parse('2026-03-10T10:00:00Z'),
        dueDate: Date.parse('2026-03-20T10:00:00Z'),
      },
      products: [{ name: 'Servicii', price: 500, quantity: 1, vatRate: 0 }],
    });
    const invoice = calculateInvoice(converted);
    expect(invoice.seller).toMatchObject({ legalId: '18547290' });
    expect(invoice.buyer).toMatchObject({ legalId: '14399840' });
    expect(invoice.buyer.vatId).toBeUndefined();
    expect(invoice.vatBreakdown).toEqual([
      {
        category: 'O',
        taxable: '500.00',
        tax: '0.00',
        exemptionCode: 'VATEX-EU-O',
        exemptionReason: 'Neplătitor de TVA',
      },
    ]);
    expect(notes.map((note) => note.code)).toContain('BUYER_VAT_ID_OMITTED');
    expect(checkInvoice(invoice)).toEqual([]);
  });
});

describe('Romanian identifiers and places', () => {
  test('normalizes counties, Bucharest sectors and countries without defaulting', () => {
    expect(
      ['Galaţi', 'Neamț', 'Arges', 'Municipiul Bucureşti', 'Mun. București', 'RO-CJ', 'IF'].map(
        countyCode,
      ),
    ).toEqual(['RO-GL', 'RO-NT', 'RO-AG', 'RO-B', 'RO-B', 'RO-CJ', 'RO-IF']);
    expect(countyCode('Atlantis')).toBeUndefined();
    expect(
      ['Sector 3', 'Sectorul 6', 'sector1', 'București Sectorul 2', 'Sector 7', 'Ilfov'].map(
        bucharestSector,
      ),
    ).toEqual(['SECTOR3', 'SECTOR6', 'SECTOR1', 'SECTOR2', undefined, undefined]);
    expect(
      ['România', 'Germania', 'Republica Moldova', 'Regatul Unit', 'de'].map(countryCode),
    ).toEqual(['RO', 'DE', 'MD', 'GB', 'DE']);
    expect(countryCode('Republica')).toBeUndefined();
  });

  test('checks CNP control digits', () => {
    // Synthetic: sex and century 1, born 1980-01-01, county 40, serial 001, control 6.
    expect(
      ['1800101400016', '1800101400013', '180010140001', '0800101400016'].map(isValidCnp),
    ).toEqual([true, false, false, false]);
  });

  test('checks CUI control digits', () => {
    expect(['18547290', 'RO14399840', '12345678', '0123', 'RO'].map(isValidCui)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});

/**
 * The synthetic invoices in fixtures/einvoice/invoicer.json, written by the previous PHP
 * generator (josemmo/einvoicing through xfactura-web/scripts/php-oracle.ts). The TypeScript
 * writer must agree on every field except these intentional differences.
 */
const fixtures = path.join(import.meta.dir, 'fixtures/einvoice');
const intended: Record<string, Record<string, string | undefined>> = {
  // Prices are written as entered or derived (4 decimals), not rounded to 2.
  'decimal-quantity': { 'lines.0.price': '12.345', 'lines.1.price': '10.005' },
  'rounding-many-lines': {
    'lines.0.price': '0.335',
    'lines.1.price': '0.335',
    'lines.2.price': '0.335',
    'lines.3.price': '33.333',
  },
  'vat-included': { 'lines.1.price': '84.0336' },
  // An RO-prefixed code is a VAT identifier (BT-31), not a legal registration number (BT-30).
  'seller-vat-payer-absent': { 'seller.legalId': undefined, 'seller.vatId': 'RO18547290' },
  // The issue date is the Romanian calendar date, not the UTC date.
  'local-midnight': { issueDate: '2026-01-01', dueDate: '2026-01-31' },
  // A foreign buyer keeps its country and VAT code.
  euro: { 'buyer.address.country': 'DE', 'buyer.vatId': 'DE123456789' },
};

describe('agreement with the previous PHP generator', () => {
  const sources = JSON.parse(
    readFileSync(path.join(fixtures, 'invoicer.json'), 'utf8'),
  ) as InvoicerInvoice[];
  test('covers every fixture', () => {
    expect(readdirSync(path.join(fixtures, 'php')).sort()).toEqual(
      sources.map((item) => `${item.id}.xml`).sort(),
    );
  });
  for (const source of sources)
    test(source.id, () => {
      const expected = readInvoice(readFileSync(path.join(fixtures, 'php', `${source.id}.xml`)));
      const actual = calculateInvoice(fromInvoicer(source).draft);
      const differences = Object.fromEntries(
        compareInvoices(expected, actual)
          // The seller's IBAN is now written as a payment instruction (BG-16).
          .filter((difference) => !difference.path.startsWith('payment.'))
          .map((difference) => [difference.path, difference.actual]),
      );
      expect(differences).toEqual(intended[source.id] ?? {});
      expect(verifyInvoice(readInvoice(bytes(writeInvoice(actual))))).toEqual([]);
    });
});
