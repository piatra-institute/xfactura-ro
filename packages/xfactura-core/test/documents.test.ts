import { describe, expect, test } from 'bun:test';
import {
  amountsIn,
  checkDocument,
  companyParty,
  datesIn,
  verifyCitation,
  type CheckContext,
} from '../src/documents/checks';
import {
  documentIdentity,
  extractedBody,
  normalizedNumber,
  type Citations,
} from '../src/documents/schemas';
import { hashOf } from '../src/hash';
import type { LocalDate } from '../src/time';
import type { InvoiceDocument } from '../src/ubl/invoice-document';

// Synthetic parties with valid control digits; the amounts are specified by hand.
const company = '12345674';
const supplier = '87654329';
const rates = () => ({ standard: '21', reduced: ['11'] });

const invoiceInput = (overrides: Record<string, unknown> = {}) => ({
  number: 'FCT 0042',
  issueDate: '2026-10-05',
  dueDate: '2026-11-04',
  currency: 'RON',
  supplier: { name: 'Furnizor SRL', taxId: `RO${supplier}`, country: 'RO' },
  customer: { name: 'Pilot SRL', taxId: company, country: 'RO' },
  payeeIbans: ['RO49AAAA1B31007593840000'],
  lines: [
    { description: 'Servicii consultanță', net: '1000.00', vatCategory: 'S', vatRate: '21' },
    { description: 'Abonament', net: '200.00', vatCategory: 'S', vatRate: '21' },
  ],
  taxes: [{ base: '1200.00', tax: '252.00', category: 'S', rate: '21' }],
  totals: { net: '1200.00', tax: '252.00', gross: '1452.00' },
  ...overrides,
});

// The printed invoice's text layer, as evidence.read numbers it.
const page = [
  'FACTURĂ FISCALĂ',
  'Seria FCT nr. 0042 din 05.10.2026',
  'Furnizor: Furnizor SRL   CIF: RO 87654329',
  'Client: Pilot SRL   CUI: 12345674',
  'Total fără TVA: 1.200,00 lei',
  'TVA 21%: 252,00 lei',
  'Total de plată: 1.452,00 lei',
  'Scadență: 4 noiembrie 2026',
];
const citations: Citations = {
  number: { page: 1, line: 2, text: 'FCT nr. 0042' },
  issueDate: { page: 1, line: 2, text: 'din 05.10.2026' },
  'supplier.taxId': { page: 1, line: 3, text: 'CIF: RO 87654329' },
  'totals.net': { page: 1, line: 5, text: 'Total fără TVA: 1.200,00 lei' },
  'totals.tax': { page: 1, line: 6, text: '252,00' },
  'totals.gross': { page: 1, line: 7, text: 'Total de plată: 1.452,00' },
  dueDate: { page: 1, line: 8, text: '4 noiembrie 2026' },
};

function context(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    kind: 'invoice.received',
    body: extractedBody('invoice.received', invoiceInput()),
    companyTaxId: company,
    today: '2026-10-30' as LocalDate,
    rates,
    pages: [page],
    citations,
    ...overrides,
  };
}
const outcome = (result: ReturnType<typeof checkDocument>) =>
  Object.fromEntries(result.checks.map((check) => [check.code, check.status]));

describe('extracted invoices', () => {
  test('complete into the UBL parser’s shape, which the treatments read', () => {
    const body = extractedBody('creditNote.received', invoiceInput()) as InvoiceDocument;
    expect(body).toMatchObject({
      parserVersion: 'extracted-invoice-1',
      documentType: 'credit_note',
      customizationId: '',
      lines: [{ id: '1' }, { id: '2' }],
      totals: { lineNet: '1200.00', allowances: '0.00', payable: '1452.00' },
      taxes: [{ exemptionReason: null }],
    });
  });

  test('share their identity with the e-Factura copy, whatever the spacing of the number', () => {
    const body = extractedBody('invoice.received', invoiceInput());
    const identity = documentIdentity('invoice.received', body, company);
    // recordInvoice's key: supplier without RO, number, date, type.
    expect(identity).toBe(hashOf([supplier, 'FCT0042', '2026-10-05', 'invoice']));
    expect(
      documentIdentity(
        'invoice.received',
        extractedBody('invoice.received', invoiceInput({ number: 'fct0042' })),
        company,
      ),
    ).toBe(identity);
    expect(normalizedNumber('ｆｃｔ 00 42')).toBe('FCT0042');
  });
});

describe('document checks', () => {
  test('a consistent invoice with verified citations passes every check', () => {
    const result = checkDocument(context());
    expect(outcome(result)).toEqual({
      COMPANY_PARTY: 'passed',
      TOTALS: 'passed',
      VAT_CATEGORIES: 'passed',
      VAT_RATE: 'passed',
      TAX_IDS: 'passed',
      IBAN: 'passed',
      DATES: 'passed',
      CITATIONS: 'passed',
    });
    expect(result.citations.every((item) => item.status === 'verified')).toBe(true);
  });

  test('totals and VAT that do not add up fail, and block treatments', () => {
    const body = extractedBody(
      'invoice.received',
      invoiceInput({
        taxes: [{ base: '1200.00', tax: '250.00', category: 'S', rate: '21' }],
        totals: { net: '1200.00', tax: '250.00', gross: '1452.00' },
      }),
    );
    const result = checkDocument(context({ body }));
    const totals = result.checks.find((check) => check.code === 'TOTALS')!;
    expect(totals).toMatchObject({ status: 'failed', blocking: true });
    expect(totals.details).toEqual([
      { rule: 'net + tax = gross', computed: '1450.00', stated: '1452.00' },
    ]);
    expect(result.checks.find((check) => check.code === 'VAT_CATEGORIES')).toMatchObject({
      status: 'failed',
      blocking: true,
    });
  });

  test('VAT may differ by half a ban per line from the base at the rate', () => {
    const lines = Array.from({ length: 4 }, () => ({
      description: 'x',
      net: '0.33',
      vatCategory: 'S',
      vatRate: '21',
    }));
    // 1.32 × 21% = 0.2772: 0.28; four lines rounded one by one say 0.07 each, 0.28 too, and
    // 0.30 is two bani off, as four lines may be.
    const at = (tax: string) =>
      outcome(
        checkDocument(
          context({
            body: extractedBody(
              'invoice.received',
              invoiceInput({
                lines,
                taxes: [{ base: '1.32', tax, category: 'S', rate: '21' }],
                totals: {
                  net: '1.32',
                  tax,
                  gross: (1.32 + Number(tax)).toFixed(2),
                },
              }),
            ),
            citations: {},
          }),
        ),
      ).VAT_CATEGORIES;
    expect([at('0.28'), at('0.30'), at('0.31')]).toEqual(['passed', 'passed', 'failed']);
  });

  test('rates, tax ids, accounts and dates are checked; a rule gap leaves the rate unverified', () => {
    const body = extractedBody(
      'invoice.received',
      invoiceInput({
        issueDate: '2026-11-15',
        dueDate: '2026-11-01',
        supplier: { name: 'Furnizor SRL', taxId: 'RO87654321', country: 'RO' },
        payeeIbans: ['RO49AAAA1B31007593840001'],
        lines: [{ description: 'x', net: '1000.00', vatCategory: 'S', vatRate: '19' }],
        taxes: [{ base: '1000.00', tax: '190.00', category: 'S', rate: '19' }],
        totals: { net: '1000.00', tax: '190.00', gross: '1190.00' },
      }),
    );
    expect(outcome(checkDocument(context({ body, citations: {} })))).toMatchObject({
      VAT_RATE: 'failed',
      TAX_IDS: 'failed',
      IBAN: 'failed',
      DATES: 'failed',
      CITATIONS: 'unverified',
    });
    expect(
      outcome(checkDocument(context({ rates: () => ({ gap: 'BEYOND_HORIZON' }) }))).VAT_RATE,
    ).toBe('unverified');
  });

  test('each citation is checked against its line and the value it should show', () => {
    const verify = (
      citation: Parameters<typeof verifyCitation>[1],
      value: string,
      kind = 'money',
    ) => verifyCitation([page], citation, { kind: kind as 'money', value });
    expect(verify({ page: 1, line: 7, text: '1.452,00' }, '1452.00')).toEqual({
      status: 'verified',
      reason: null,
    });
    // Whitespace runs collapse; the words must be on the line, and must show the value.
    expect(
      verify({ page: 1, line: 7, text: 'Total   de plată:  1.452,00' }, '1452.00').status,
    ).toBe('verified');
    expect(verify({ page: 1, line: 6, text: '1.452,00' }, '1452.00').reason).toBe('text');
    expect(verify({ page: 1, line: 7, text: '1.452,00' }, '1425.00').reason).toBe('value');
    expect(verify({ page: 1, line: 40, text: '1.452,00' }, '1452.00').reason).toBe('line');
    expect(verify({ page: 2, line: 1, text: '1.452,00' }, '1452.00').reason).toBe('page');
    expect(
      verifyCitation(null, { page: 1, line: 1, text: 'x' }, { kind: 'money', value: '1' }),
    ).toEqual({
      status: 'unverified',
      reason: 'no_text_layer',
    });
    expect(verifyCitation([page], { page: 1, line: 1, text: 'x' }, null).reason).toBe('field');
    expect(verify({ page: 1, line: 3, text: 'RO 87654329' }, supplier, 'taxId').status).toBe(
      'verified',
    );
    expect(verify({ page: 1, line: 3, text: 'RO 87654329' }, '7654329', 'taxId').reason).toBe(
      'value',
    );
  });

  test('a wrong citation is stored as failed; without a text layer, citations are unverified', () => {
    const wrong = checkDocument(
      context({
        citations: { ...citations, 'totals.gross': { page: 1, line: 6, text: '252,00' } },
      }),
    );
    expect(outcome(wrong).CITATIONS).toBe('failed');
    expect(wrong.citations.find((item) => item.field === 'totals.gross')).toMatchObject({
      status: 'failed',
      reason: 'value',
    });
    const photo = checkDocument(context({ pages: null }));
    expect(outcome(photo).CITATIONS).toBe('unverified');
    expect(photo.citations.every((item) => item.status === 'unverified')).toBe(true);
  });

  test('numbers and dates read in the forms documents print them', () => {
    expect(amountsIn('Total: 1.234,56 lei')).toContain('1234.56');
    expect(amountsIn('Total: 1,234.56 EUR')).toContain('1234.56');
    expect(amountsIn('2 buc x 100,50')).toContain('100.5');
    expect(amountsIn('Sold: 12 345,60')).toContain('12345.6');
    expect(amountsIn('Cota 21%')).toContain('21');
    expect([...datesIn('din 05.03.2026, scadent 2026-04-04, emis 5 martie 2026')]).toEqual([
      '2026-03-05',
      '2026-04-04',
    ]);
    expect(datesIn('31.02.2026').size).toBe(0);
  });

  test('a document the company is not exactly one party of is refused', () => {
    const neither = extractedBody(
      'invoice.received',
      invoiceInput({ customer: { name: 'Alt SRL', taxId: '11111110', country: 'RO' } }),
    );
    expect(companyParty('invoice.received', neither, company).ok).toBe(false);
    expect(
      companyParty('invoice.issued', extractedBody('invoice.issued', invoiceInput()), company),
    ).toEqual({
      ok: false,
      message: 'Compania este clientul: documentul este primit, nu emis.',
    });
    const receipt = {
      seller: { name: 'Magazin SRL', taxId: supplier, country: 'RO' },
      buyerTaxId: '11111110',
      number: '0042',
      issueDate: '2026-10-05',
      currency: 'RON',
      lines: [{ description: 'Hârtie', gross: '12.10', vatRate: '21' }],
      taxes: [{ rate: '21', gross: '12.10', tax: '2.10' }],
      totals: { gross: '12.10', tax: '2.10' },
    };
    expect(
      companyParty('receipt.received', extractedBody('receipt.received', receipt), company).ok,
    ).toBe(false);
    const contract = {
      title: 'Contract de închiriere',
      date: '2026-01-05',
      parties: [
        { name: 'Pilot SRL', taxId: `RO${company}`, country: 'RO', role: 'chiriaș' },
        { name: 'Pilot SRL', taxId: company, country: 'RO', role: 'proprietar' },
      ],
      effectiveFrom: '2026-02-01',
    };
    expect(companyParty('contract', extractedBody('contract', contract), company).ok).toBe(false);
  });

  test('a receipt’s VAT is checked per rate on its gross amounts', () => {
    const receipt = extractedBody('receipt.received', {
      seller: { name: 'Magazin SRL', taxId: supplier, country: 'RO' },
      number: '0042',
      register: 'AMEF 4400012345',
      issueDate: '2026-10-05',
      time: '14:22',
      currency: 'RON',
      lines: [
        { description: 'Hârtie', gross: '12.10', vatRate: '21' },
        { description: 'Carte', gross: '11.10', vatRate: '11' },
      ],
      taxes: [
        { rate: '21', gross: '12.10', tax: '2.10' },
        { rate: '11', gross: '11.10', tax: '1.10' },
      ],
      totals: { gross: '23.20', tax: '3.20' },
      payment: 'card',
    });
    const result = checkDocument(
      context({ kind: 'receipt.received', body: receipt, citations: {} }),
    );
    expect(outcome(result)).toMatchObject({
      TOTALS: 'passed',
      VAT_CATEGORIES: 'passed',
      VAT_RATE: 'passed',
      TAX_IDS: 'passed',
      DATES: 'passed',
    });
    expect(documentIdentity('receipt.received', receipt, company)).not.toBeNull();
    // Without the register, receipts of a chain's stores cannot be told apart: no identity.
    expect(
      documentIdentity('receipt.received', { ...receipt, register: null }, company),
    ).toBeNull();
  });
});
