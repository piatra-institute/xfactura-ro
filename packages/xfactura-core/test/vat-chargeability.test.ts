import { describe, expect, test } from 'bun:test';
import type { Evaluation, Loaded, OpenItemState, PostedEntry } from '../src/kernel';
import { emptyLoaded, saleInvoice } from '../src/ro/reviews/specs/world';
import { roRegister } from '../src/ro/register';
import {
  chargeabilityOf,
  creditInput,
  creditRecognition,
  invoiceKinds,
  invoiceRecognition,
  recognitionInput,
} from '../src/ro/treatments/invoices';
import { RuleContext } from '../src/rules';
import type { LocalDate } from '../src/time';
import {
  invoiceDocumentSchema,
  parseInvoiceXml,
  type InvoiceDocument,
} from '../src/ubl/invoice-document';
import { invoiceXml } from './fixtures/invoice';

// Synthetic invoices around the standard rate's change from 19% to 21% on 1 August 2025.
// Expected dates and periods by hand from Codul fiscal art. 281, 282 alin. (1)–(2) and (9), and
// art. 291 alin. (4)–(6).

const register = roRegister();
const PARTY = '00000000-0000-4000-8000-0000000000c1';
const ORIGINAL = '00000000-0000-4000-8000-0000000000d1';
const CREDIT = '00000000-0000-4000-8000-0000000000d2';
const ITEM = '00000000-0000-4000-8000-0000000000f1';
const day = (value: string) => value as LocalDate;

function loadedWith(documents: [id: string, kind: string, body: InvoiceDocument][]): Loaded {
  const loaded = emptyLoaded([
    { axis: 'vat.status', value: 'normal_vat', effectiveFrom: day('2020-01-01') },
  ]);
  for (const [id, kind, body] of documents)
    (loaded.documents as Map<string, unknown>).set(id, {
      id,
      kind,
      schema: 'invoice',
      body,
      bodyHash: id,
      docDate: body.issueDate,
      partyId: PARTY,
      currency: 'RON',
      number: body.number,
      evidenceId: null,
    });
  return loaded;
}

function recognize(body: InvoiceDocument, account = '704') {
  const rules = new RuleContext(register, 'preview');
  const evaluation = invoiceRecognition.evaluate(
    recognitionInput.parse({ documentId: ORIGINAL, account }),
    loadedWith([[ORIGINAL, invoiceKinds.sale, body]]),
    rules,
  );
  return { evaluation, used: [...rules.used.keys()] };
}

const codes = (evaluation: Evaluation) => evaluation.issues.map((issue) => issue.code);
/** The VAT entry's code, tax point, period and amount. */
const vatOf = (evaluation: Evaluation) =>
  evaluation.effect?.taxEntries.map((entry) => [
    entry.code,
    entry.taxPoint,
    entry.taxPeriod,
    entry.taxBani,
  ]);

const sale = (options: Parameters<typeof saleInvoice>[0]) => saleInvoice(options);

describe('the date VAT becomes chargeable', () => {
  test('the supply date (BT-72), unless the invoice or a stated tax point came first', () => {
    const of = (body: Partial<InvoiceDocument>) =>
      chargeabilityOf({ issueDate: '2025-08-05', taxPointDate: null, ...body });
    expect(of({})).toEqual({ date: day('2025-08-05'), basis: 'issue_date', supplied: null });
    expect(of({ taxPointDate: '2025-07-31' })).toEqual({
      date: day('2025-07-31'),
      basis: 'tax_point',
      supplied: null,
    });
    // Supplied before the invoice: the supply's date (art. 282 alin. (1)).
    expect(of({ deliveryDate: '2025-07-28' })).toMatchObject({
      date: '2025-07-28',
      basis: 'supply',
    });
    // Invoiced before the supply: the issue date (art. 282 alin. (2) lit. a)).
    expect(of({ deliveryDate: '2025-08-10' })).toMatchObject({
      date: '2025-08-05',
      basis: 'invoice',
      supplied: '2025-08-10',
    });
    // An advance collected earlier, stated as the tax point (art. 282 alin. (2) lit. b)).
    expect(of({ deliveryDate: '2025-08-01', taxPointDate: '2025-07-20' })).toMatchObject({
      date: '2025-07-20',
      basis: 'tax_point',
    });
    // A stated tax point later than the supply does not move it.
    expect(of({ deliveryDate: '2025-07-28', taxPointDate: '2025-08-05' })).toMatchObject({
      date: '2025-07-28',
      basis: 'supply',
    });
  });

  test('the UBL parser reads the supply date (BT-72) and the invoiced period (BG-14)', () => {
    const bytes = (xml: string) => new TextEncoder().encode(xml);
    const body = parseInvoiceXml(
      bytes(
        invoiceXml({
          date: '2025-08-05',
          deliveryDate: '2025-07-28',
          period: { start: '2025-07-01', end: '2025-07-31' },
        }),
      ),
    );
    expect([body.deliveryDate, body.invoicePeriod]).toEqual([
      '2025-07-28',
      { start: '2025-07-01', end: '2025-07-31' },
    ]);
    // Absent fields stay absent, so earlier documents keep their stored body.
    const plain = parseInvoiceXml(bytes(invoiceXml({ date: '2025-08-05' })));
    expect(plain).not.toHaveProperty('deliveryDate');
    expect(plain).not.toHaveProperty('invoicePeriod');
  });
});

describe('the rate across 1 August 2025', () => {
  test('a July supply invoiced in August with its date (BT-72): 19%, and VAT in July', () => {
    const { evaluation } = recognize(
      sale({ issueDate: '2025-08-05', deliveryDate: '2025-07-28', net: '1000.00', rate: '19' }),
    );
    expect(codes(evaluation)).toEqual([]);
    expect(vatOf(evaluation)).toEqual([['S-19', '2025-07-28', '2025-07', 19000n]]);
    // The entry is still dated on the invoice.
    expect(evaluation.effect?.date).toBe(day('2025-08-05'));
    expect(evaluation.effect?.explanation.details).toMatchObject({
      taxPoint: '2025-07-28',
      supplyDate: '2025-07-28',
      taxPointBasis: 'supply',
    });
    // 21% on that invoice is not the rate of its supply.
    const wrong = recognize(
      sale({ issueDate: '2025-08-05', deliveryDate: '2025-07-28', net: '1000.00', rate: '21' }),
    );
    expect(codes(wrong.evaluation)).toEqual(['VAT_RATE']);
  });

  test('without BT-72 the issue date stands for the supply, and the reviewer confirms it', () => {
    const nineteen = recognize(sale({ issueDate: '2025-08-05', net: '1000.00', rate: '19' }));
    expect(codes(nineteen.evaluation)).toEqual(['VAT_RATE', 'SUPPLY_DATE_ASSUMED']);
    const twentyOne = recognize(sale({ issueDate: '2025-08-05', net: '1000.00', rate: '21' }));
    expect(codes(twentyOne.evaluation)).toEqual(['SUPPLY_DATE_ASSUMED']);
    expect(twentyOne.evaluation.issues[0]).toMatchObject({
      severity: 'ack',
      details: { from: '2025-07-01', rates: ['19', '21'] },
    });
    expect(vatOf(twentyOne.evaluation)).toEqual([['S-21', '2025-08-05', '2025-08', 21000n]]);
    // The rates the check compared are bound to the proposal.
    expect(twentyOne.used).toEqual(['ro.vat.rate/S/2025-08-01', 'ro.vat.rate/S/2024-01-01']);
    // A month later no change of rate is near: nothing to confirm.
    const october = recognize(sale({ issueDate: '2025-10-03', net: '1000.00', rate: '21' }));
    expect(codes(october.evaluation)).toEqual([]);
    expect(october.used).toEqual(['ro.vat.rate/S/2025-08-01']);
  });

  test('a stated tax point (BT-7) is the issuer saying when VAT is due: no assumption', () => {
    const { evaluation } = recognize(
      sale({ issueDate: '2025-08-05', taxPointDate: '2025-07-28', net: '1000.00', rate: '19' }),
    );
    expect(codes(evaluation)).toEqual([]);
    expect(vatOf(evaluation)).toEqual([['S-19', '2025-07-28', '2025-07', 19000n]]);
  });

  test('an invoiced period (BG-14) does not choose the rate; it is named in the warning', () => {
    const { evaluation } = recognize(
      sale({
        issueDate: '2025-08-05',
        invoicePeriod: { start: '2025-06-01', end: '2025-07-31' },
        net: '1000.00',
        rate: '19',
      }),
    );
    expect(codes(evaluation)).toEqual(['VAT_RATE', 'SUPPLY_DATE_ASSUMED']);
    const warning = evaluation.issues[1]!;
    expect(warning.message).toContain('perioada 2025-06-01–2025-07-31 (BG-14)');
    expect(warning.message).toContain('art. 281 alin. (8)');
    // The window starts with the period, when it starts earlier than the previous month.
    expect(warning.details).toMatchObject({ from: '2025-06-01' });
  });

  test('a foreign-currency invoice reads the rates up to both its issue date and its tax point', () => {
    const body = invoiceDocumentSchema.parse({
      ...sale({ issueDate: '2025-09-05', deliveryDate: '2025-07-28', net: '1000.00', rate: '19' }),
      currency: 'EUR',
    });
    const plan = invoiceRecognition.followUp!(
      recognitionInput.parse({ documentId: ORIGINAL, account: '704' }),
      loadedWith([[ORIGINAL, invoiceKinds.sale, body]]),
    );
    expect(plan?.fx).toEqual([
      { currency: 'EUR', until: day('2025-09-05') },
      { currency: 'EUR', until: day('2025-07-28') },
    ]);
  });

  test('a later stated tax point than the supply is not followed, and is flagged', () => {
    const { evaluation } = recognize(
      sale({
        issueDate: '2025-08-05',
        taxPointDate: '2025-08-05',
        deliveryDate: '2025-07-28',
        net: '1000.00',
        rate: '19',
      }),
    );
    expect(codes(evaluation)).toEqual(['TAX_POINT_DATES']);
    expect(vatOf(evaluation)).toEqual([['S-19', '2025-07-28', '2025-07', 19000n]]);
  });
});

describe('advances across the change', () => {
  test('an advance invoiced in July for an August supply: 19% now, regularized at the supply', () => {
    const { evaluation } = recognize(
      sale({ issueDate: '2025-07-25', deliveryDate: '2025-08-10', net: '1000.00', rate: '19' }),
      '419',
    );
    expect(codes(evaluation)).toEqual(['RATE_REGULARIZATION']);
    expect(evaluation.issues[0]!.message).toContain('Art. 291 alin. (6)');
    expect(vatOf(evaluation)).toEqual([['S-19', '2025-07-25', '2025-07', 19000n]]);
    expect(evaluation.effect?.openItems.map((item) => item.kind)).toEqual([
      'receivable',
      'advance.received',
    ]);
  });

  test('an advance collected before the change, stated as the tax point (BT-7)', () => {
    // Collected on 20 July, invoiced on 5 August for a supply of 1 August.
    const { evaluation } = recognize(
      sale({
        issueDate: '2025-08-05',
        taxPointDate: '2025-07-20',
        deliveryDate: '2025-08-01',
        net: '1000.00',
        rate: '19',
      }),
    );
    expect(codes(evaluation)).toEqual(['RATE_REGULARIZATION']);
    expect(vatOf(evaluation)).toEqual([['S-19', '2025-07-20', '2025-07', 19000n]]);
  });

  test('an advance invoiced on 1 August for a September supply is at 21%, with nothing to regularize', () => {
    const { evaluation } = recognize(
      sale({ issueDate: '2025-08-01', deliveryDate: '2025-09-15', net: '1000.00', rate: '21' }),
      '419',
    );
    expect(codes(evaluation)).toEqual([]);
    expect(vatOf(evaluation)).toEqual([['S-21', '2025-08-01', '2025-08', 21000n]]);
  });
});

describe('credit notes for supplies before the change', () => {
  /** The original's posting, as the credit note reads it: its receivable and the entry. */
  function credited(original: InvoiceDocument, rate: string) {
    const posted = recognize(original).evaluation.effect!;
    const credit = invoiceDocumentSchema.parse({
      ...sale({ issueDate: '2025-09-10', net: '200.00', rate }),
      documentType: 'credit_note',
      number: 'CN-1',
      originalInvoiceNumber: original.number,
    });
    const loaded = loadedWith([
      [ORIGINAL, invoiceKinds.sale, original],
      [CREDIT, invoiceKinds.saleCredit, credit],
    ]);
    const entry: PostedEntry = {
      id: 'origin',
      number: 1,
      date: posted.date,
      journalCode: posted.journalCode,
      description: posted.description,
      lines: posted.lines.map((line) => (line.openItem ? { ...line, openItem: ITEM } : line)),
      taxEntries: posted.taxEntries,
    };
    (loaded.entries as Map<string, PostedEntry>).set(entry.id, entry);
    const gross = posted.lines.find((line) => line.account === '4111')!.bani;
    const item: OpenItemState = {
      id: ITEM,
      kind: 'receivable',
      controlAccount: '4111',
      partyId: PARTY,
      currency: 'RON',
      normalSide: 'D',
      mayReverse: false,
      balanceBani: gross,
      balanceMinor: gross,
      documentId: ORIGINAL,
      dueDate: null,
      originEntryId: entry.id,
      movements: 1,
      history: [entry.id],
    };
    (loaded.openItems as Map<string, OpenItemState>).set(ITEM, item);
    const rules = new RuleContext(register, 'preview');
    return creditRecognition.evaluate(
      creditInput.parse({ documentId: CREDIT, originalDocumentId: ORIGINAL, account: '704' }),
      loaded,
      rules,
    );
  }

  test("a credit note after the change keeps the original's 19%, in its own period", () => {
    // The original: supplied 28 July, invoiced 5 August, with BT-72.
    const original = sale({
      issueDate: '2025-08-05',
      deliveryDate: '2025-07-28',
      net: '1000.00',
      rate: '19',
    });
    const evaluation = credited(original, '19');
    expect(codes(evaluation)).toEqual([]);
    expect(vatOf(evaluation)).toEqual([['S-19', '2025-09-10', '2025-09', -3800n]]);
    // 21% on the credit note is not the original's rate (art. 282 alin. (9)).
    expect(codes(credited(original, '21'))).toEqual(['VAT_RATE']);
  });

  test('an original invoiced in July without BT-72 is credited at 19% too', () => {
    const original = sale({ issueDate: '2025-07-20', net: '1000.00', rate: '19' });
    const evaluation = credited(original, '19');
    expect(codes(evaluation)).toEqual([]);
    expect(vatOf(evaluation)).toEqual([['S-19', '2025-09-10', '2025-09', -3800n]]);
  });
});
