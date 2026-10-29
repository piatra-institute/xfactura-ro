import { z } from 'zod';
import {
  accountCodePattern,
  profileAt,
  type DocumentRecord,
  type Effect,
  type Issue,
  type LineSpec,
  type Loaded,
  type TaxEntrySpec,
  type Treatment,
} from '../../kernel';
import { LEDGER_CURRENCY, parseMoney } from '../../money';
import type { RuleContext } from '../../rules';
import { isLocalDate, type LocalDate } from '../../time';
import { invoiceDocumentSchema, type InvoiceDocument } from '../../ubl/invoice-document';

/** Document kinds produced by importing an e-Factura invoice or credit note. */
export const invoiceKinds = {
  sale: 'invoice.issued',
  purchase: 'invoice.received',
  saleCredit: 'creditNote.issued',
  purchaseCredit: 'creditNote.received',
} as const;

const block = (code: string, message: string, path?: string): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
});
const warn = (code: string, message: string): Issue => ({ code, severity: 'ack', message });
const ron = (value: string) => parseMoney(value, LEDGER_CURRENCY);
const date = (value: string) => value as LocalDate;

type Invoice = { record: DocumentRecord; body: InvoiceDocument; direction: 'sale' | 'purchase' };

function invoiceOf(loaded: Loaded, id: string, credit: boolean): Invoice | Issue {
  const record = loaded.documents.get(id);
  if (!record) return block('DOCUMENT', 'Documentul nu este disponibil.', 'documentId');
  const kinds = credit
    ? [invoiceKinds.saleCredit, invoiceKinds.purchaseCredit]
    : [invoiceKinds.sale, invoiceKinds.purchase];
  if (!(kinds as readonly string[]).includes(record.kind))
    return block(
      'DOCUMENT_KIND',
      'Documentul nu este de tipul așteptat de acest tratament.',
      'documentId',
    );
  const direction =
    record.kind === invoiceKinds.sale || record.kind === invoiceKinds.saleCredit
      ? 'sale'
      : 'purchase';
  return { record, body: invoiceDocumentSchema.parse(record.body), direction };
}

/**
 * The VAT the engine can determine for a document: one tax category on every line, in RON,
 * with the company's registration on the tax-point date. Returns the issues that prevent it.
 */
function vatFor(invoice: Invoice, loaded: Loaded, rules: RuleContext, taxPoint: LocalDate) {
  const issues: Issue[] = [];
  const body = invoice.body;
  const status = profileAt(loaded, 'vat.status', taxPoint);
  if (body.currency !== LEDGER_CURRENCY)
    issues.push(block('CURRENCY', 'Documentele în valută cer tratamentul de curs valutar.'));
  const categories = new Set([
    ...body.taxes.map((tax) => `${tax.category}/${tax.rate}`),
    ...body.lines.map((line) => `${line.vatCategory}/${line.vatRate}`),
  ]);
  if (body.taxes.length !== 1 || categories.size !== 1)
    issues.push(
      block('TAX_MIX', 'Documentele cu mai multe cote sau categorii TVA cer un tratament separat.'),
    );
  if (!status)
    issues.push(
      block('DETERMINATION_MISSING', 'Înregistrați regimul TVA al companiei pentru această dată.'),
    );
  const tax = body.taxes[0]!;
  if (tax.category === 'S') {
    const rate = rules.param<string>('ro.vat.rate', 'vat_chargeability_date', taxPoint, {
      category: 'S',
    });
    if (tax.rate !== rate)
      issues.push(
        block('VAT_RATE', `Cota din document (${tax.rate}%) diferă de cota în vigoare (${rate}%).`),
      );
  } else if (tax.category !== 'O' || ron(tax.tax) !== 0n)
    issues.push(block('TAX_CATEGORY', `Categoria TVA ${tax.category} cere un tratament separat.`));
  if (invoice.direction === 'sale') {
    if (status === 'normal_vat' && tax.category !== 'S')
      issues.push(
        block('TAX_CATEGORY', 'Un plătitor de TVA facturează această operațiune cu TVA.'),
      );
    if (status === 'non_vat' && tax.category !== 'O')
      issues.push(block('TAX_CATEGORY', 'Un neplătitor de TVA nu colectează TVA.'));
  }
  return { issues, status, category: tax.category, rate: tax.rate };
}

const vatEntry = (
  invoice: Invoice,
  entry: Partial<TaxEntrySpec> &
    Pick<TaxEntrySpec, 'baseBani' | 'taxBani' | 'deductibleBani' | 'ledgerBani' | 'taxPoint'>,
  code: string,
): TaxEntrySpec => ({
  key: 'vat',
  tax: 'VAT',
  code,
  direction: invoice.direction === 'sale' ? 'output' : 'input',
  exigibility: entry.taxPoint,
  taxPeriod: entry.taxPoint.slice(0, 7),
  documentId: invoice.record.id,
  ...(invoice.record.partyId ? { partyId: invoice.record.partyId } : {}),
  attributes: {
    documentType: invoice.body.documentType,
    number: invoice.body.number,
    counterpartyTaxId:
      invoice.direction === 'sale' ? invoice.body.customer.taxId : invoice.body.supplier.taxId,
    counterpartyCountry:
      invoice.direction === 'sale' ? invoice.body.customer.country : invoice.body.supplier.country,
  },
  ...entry,
});

export const recognitionInput = z
  .object({
    documentId: z.uuid(),
    /** Revenue account (70x) for a sale; expense account (6xx) for a purchase. */
    account: z.string().regex(accountCodePattern),
    /** Input VAT deduction for a purchase; ignored for a sale. */
    deduction: z.enum(['full', 'none']).default('full'),
    /** When the service was provided, if it differs from the tax point. */
    serviceDate: z
      .string()
      .refine((value): boolean => isLocalDate(value))
      .optional(),
  })
  .strict();
export type RecognitionInput = z.infer<typeof recognitionInput>;

/**
 * Recognizes a domestic RON service invoice: revenue and output VAT for a sale, expense and
 * deductible (or non-deductible) VAT for a purchase, with the receivable or payable as an open
 * item of the counterparty. VAT comes from the rule register at the tax-point date.
 */
export const invoiceRecognition: Treatment<RecognitionInput> = {
  id: 'invoices.recognize',
  version: 1,
  description:
    'Factură de servicii în lei: venit sau cheltuială, TVA și creanța sau datoria față de partener.',
  input: recognitionInput,
  agent: true,
  subject: (input) => `document:${input.documentId}`,
  plan: (input) => ({ documents: [input.documentId], profile: true }),
  evaluate(input, loaded, rules) {
    const invoice = invoiceOf(loaded, input.documentId, false);
    if ('code' in invoice) return { effect: null, issues: [invoice] };
    const { body, direction } = invoice;
    const taxPoint = date(body.taxPointDate ?? body.issueDate);
    const vat = vatFor(invoice, loaded, rules, taxPoint);
    const issues = [...vat.issues];
    if (direction === 'sale' ? !input.account.startsWith('70') : !input.account.startsWith('6'))
      issues.push(
        block(
          'ACCOUNT',
          direction === 'sale'
            ? 'Folosiți un cont de venituri (70x).'
            : 'Folosiți un cont de cheltuieli (6xx).',
          'account',
        ),
      );
    if (ron(body.totals.prepaid) !== 0n)
      issues.push(block('PREPAID', 'Facturile cu avans dedus cer tratamentul de avansuri.'));
    if (body.totals.rounding !== '0.00')
      issues.push(block('ROUNDING', 'Rotunjirea sumei de plată cere un tratament separat.'));
    if (
      direction === 'purchase' &&
      input.deduction === 'full' &&
      vat.status === 'non_vat' &&
      vat.category === 'S'
    )
      issues.push(block('DEDUCTION', 'Un neplătitor de TVA nu deduce TVA.', 'deduction'));
    if (input.serviceDate && input.serviceDate.slice(0, 7) !== taxPoint.slice(0, 7))
      issues.push(
        warn(
          'SERVICE_PERIOD',
          'Serviciul aparține altei luni decât faptul generator; verificați dacă este necesară o regularizare.',
        ),
      );
    if (!invoice.record.partyId) issues.push(block('PARTY', 'Documentul nu are partener.'));
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };

    const net = ron(body.totals.net);
    const tax = ron(body.totals.tax);
    const gross = ron(body.totals.gross);
    const partyId = invoice.record.partyId!;
    const code = vat.category === 'S' ? `S-${vat.rate}` : 'O';
    const lines: LineSpec[] = [];
    const taxEntries: TaxEntrySpec[] = [];
    const item = {
      ref: 'counterparty',
      kind: direction === 'sale' ? ('receivable' as const) : ('payable' as const),
      controlAccount: direction === 'sale' ? '4111' : '401',
      partyId,
      currency: LEDGER_CURRENCY,
      normalSide: direction === 'sale' ? ('D' as const) : ('C' as const),
      mayReverse: false,
      documentId: invoice.record.id,
    };
    if (direction === 'sale') {
      lines.push({ account: '4111', side: 'D', bani: gross, openItem: item.ref, partyId });
      lines.push({ account: input.account, side: 'C', bani: net });
      if (tax !== 0n) {
        lines.push({ account: '4427', side: 'C', bani: tax });
        taxEntries.push(
          vatEntry(
            invoice,
            { baseBani: net, taxBani: tax, deductibleBani: 0n, ledgerBani: tax, line: 2, taxPoint },
            code,
          ),
        );
      }
    } else if (input.deduction === 'full' || tax === 0n) {
      lines.push({ account: input.account, side: 'D', bani: net });
      if (tax !== 0n) {
        lines.push({ account: '4426', side: 'D', bani: tax });
        taxEntries.push(
          vatEntry(
            invoice,
            {
              baseBani: net,
              taxBani: tax,
              deductibleBani: tax,
              ledgerBani: tax,
              line: 1,
              taxPoint,
            },
            code,
          ),
        );
      }
      lines.push({ account: '401', side: 'C', bani: gross, openItem: item.ref, partyId });
    } else {
      // Non-deductible VAT is part of the expense; the tax entry records it without a VAT line.
      lines.push({ account: input.account, side: 'D', bani: gross });
      lines.push({ account: '401', side: 'C', bani: gross, openItem: item.ref, partyId });
      taxEntries.push(
        vatEntry(
          invoice,
          { baseBani: net, taxBani: tax, deductibleBani: 0n, ledgerBani: 0n, taxPoint },
          code,
        ),
      );
    }
    const effect: Effect = {
      schema: 'effect@1',
      date: date(body.issueDate),
      journalClass: 'general',
      journalCode: direction === 'sale' ? 'VANZARI' : 'CUMPARARI',
      description: `${direction === 'sale' ? 'Factură emisă' : 'Factură primită'} ${body.number}`,
      lines,
      openItems: [item],
      taxEntries,
      schedules: [],
      explanation: {
        summary: `${body.number} din ${body.issueDate}: bază ${body.totals.net}, TVA ${body.totals.tax}, total ${body.totals.gross} lei.`,
        details: {
          taxPoint,
          category: vat.category,
          rate: vat.rate,
          deduction: direction === 'purchase' ? input.deduction : null,
        },
      },
    };
    return { effect, issues };
  },
};

export const creditInput = z
  .object({
    documentId: z.uuid(),
    originalDocumentId: z.uuid(),
    /** The revenue or expense account the original invoice used. */
    account: z.string().regex(accountCodePattern),
    deduction: z.enum(['full', 'none']).default('full'),
  })
  .strict();
export type CreditInput = z.infer<typeof creditInput>;

/**
 * Recognizes a credit note (381, or a negative 380) against its original invoice: the original
 * accounts and VAT rate are reversed for the credited amount in the credit note's own period,
 * and the original receivable or payable is reduced. Crediting more than remains open is refused.
 */
export const creditRecognition: Treatment<CreditInput> = {
  id: 'invoices.credit',
  version: 1,
  description:
    'Notă de credit sau factură storno legată de factura inițială, cu cota TVA a acesteia.',
  input: creditInput,
  agent: true,
  subject: (input) => `document:${input.documentId}`,
  plan: (input) => ({
    documents: [input.documentId, input.originalDocumentId],
    openItems: [{ documentId: input.originalDocumentId }],
    profile: true,
  }),
  evaluate(input, loaded, rules) {
    const credit = invoiceOf(loaded, input.documentId, true);
    const original = invoiceOf(loaded, input.originalDocumentId, false);
    if ('code' in credit || 'code' in original)
      return {
        effect: null,
        issues: ['code' in credit ? credit : [], 'code' in original ? original : []].flat(),
      };
    const issues: Issue[] = [];
    if (
      credit.direction !== original.direction ||
      credit.record.partyId !== original.record.partyId
    )
      issues.push(
        block(
          'ORIGINAL',
          'Factura inițială are alt partener sau altă direcție.',
          'originalDocumentId',
        ),
      );
    const referenced =
      credit.body.originalInvoiceNumber ?? credit.body.invoiceReferences?.[0]?.number ?? null;
    if (referenced !== original.body.number)
      issues.push(
        block(
          'REFERENCE',
          'Documentul nu face referire la factura inițială indicată.',
          'originalDocumentId',
        ),
      );
    const taxPoint = date(credit.body.taxPointDate ?? credit.body.issueDate);
    const originalTaxPoint = date(original.body.taxPointDate ?? original.body.issueDate);
    const vat = vatFor(original, loaded, rules, originalTaxPoint);
    issues.push(...vat.issues);
    const creditTax = credit.body.taxes[0];
    if (
      credit.body.taxes.length !== 1 ||
      creditTax?.category !== vat.category ||
      creditTax?.rate !== vat.rate
    )
      issues.push(
        block('VAT_RATE', 'Nota de credit păstrează categoria și cota TVA a facturii inițiale.'),
      );
    const item = [...loaded.openItems.values()].find(
      (open) => open.documentId === original.record.id,
    );
    if (!item)
      issues.push(
        block(
          'ORIGINAL_OPEN_ITEM',
          'Factura inițială nu este contabilizată.',
          'originalDocumentId',
        ),
      );
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };

    const net = ron(credit.body.totals.net);
    const tax = ron(credit.body.totals.tax);
    const gross = ron(credit.body.totals.gross);
    const partyId = credit.record.partyId!;
    const code = vat.category === 'S' ? `S-${vat.rate}` : 'O';
    // Red storno: the original sides with negative amounts, so turnover stays correct.
    const lines: LineSpec[] = [];
    const taxEntries: TaxEntrySpec[] = [];
    const entry = (line: number | undefined, ledger: bigint, deductible: bigint) =>
      vatEntry(
        credit,
        {
          baseBani: -net,
          taxBani: -tax,
          deductibleBani: -deductible,
          ledgerBani: -ledger,
          taxPoint,
          ...(line === undefined ? {} : { line }),
          originTaxEntry: `${original.record.id}:vat`,
        },
        code,
      );
    if (credit.direction === 'sale') {
      lines.push({ account: '4111', side: 'D', bani: -gross, openItem: item!.id, partyId });
      lines.push({ account: input.account, side: 'C', bani: -net });
      if (tax !== 0n) {
        lines.push({ account: '4427', side: 'C', bani: -tax });
        taxEntries.push(entry(2, tax, 0n));
      }
    } else if (input.deduction === 'full' || tax === 0n) {
      lines.push({ account: input.account, side: 'D', bani: -net });
      if (tax !== 0n) {
        lines.push({ account: '4426', side: 'D', bani: -tax });
        taxEntries.push(entry(1, tax, tax));
      }
      lines.push({ account: '401', side: 'C', bani: -gross, openItem: item!.id, partyId });
    } else {
      lines.push({ account: input.account, side: 'D', bani: -gross });
      lines.push({ account: '401', side: 'C', bani: -gross, openItem: item!.id, partyId });
      taxEntries.push(entry(undefined, 0n, 0n));
    }
    const effect: Effect = {
      schema: 'effect@1',
      date: date(credit.body.issueDate),
      journalClass: 'general',
      journalCode: credit.direction === 'sale' ? 'VANZARI' : 'CUMPARARI',
      description: `Notă de credit ${credit.body.number} pentru ${original.body.number}`,
      lines,
      openItems: [],
      taxEntries,
      schedules: [],
      explanation: {
        summary: `${credit.body.number} reduce ${original.body.number} cu ${credit.body.totals.gross} lei, la cota inițială.`,
        details: { originalDocumentId: original.record.id, taxPoint },
      },
    };
    return { effect, issues };
  },
};
