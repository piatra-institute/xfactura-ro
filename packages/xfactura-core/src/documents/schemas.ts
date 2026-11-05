import { z } from 'zod';
import { requireCondition } from '../errors';
import { hashOf } from '../hash';
import { invoiceKinds } from '../ro/treatments/invoices';
import {
  taxDecisionDocumentSchema,
  taxDecisionDocumentInput,
  taxDocumentKinds,
  taxStatementDocumentSchema,
  taxStatementDocumentInput,
  type TaxDecisionDocument,
  type TaxStatementDocument,
} from '../ro/taxaccount/documents';
import {
  inventoryDocumentKind,
  inventoryListInput,
  inventoryListSchema,
  type InventoryList,
} from '../ro/yearend/documents';
import {
  customsDeclarationInput,
  customsDeclarationSchema,
  customsDocumentKind,
  tradeIdentity,
  viesCheckInput,
  viesCheckSchema,
  viesDocumentKind,
  type CustomsDeclaration,
  type ViesCheck,
} from '../ro/trade/documents';
import {
  extractedInvoiceVersion,
  invoiceDocumentSchema,
  type InvoiceDocument,
} from '../ubl/invoice-document';
import {
  isZReportKind,
  zReportDocumentSchema,
  zReportInput,
  zReportKind,
  type ZReportDocument,
} from '../ro/retail/documents';
import { Amount, dateSchema, moneySchema, signedMoneySchema } from '../values';

/*
 * Documents an agent reads from a PDF or a photo and records with `documents.record`: invoices
 * and credit notes in the UBL parser's shape, fiscal receipts and contracts in shapes of their
 * own. Each field may cite the line of the file it was read from; the engine checks the
 * citations and the document's own arithmetic (./checks.ts) and keeps both with it.
 */

export const receiptSchemaVersion = 'extracted-receipt-1';
export const contractSchemaVersion = 'extracted-contract-1';

/** Every kind of document the engine keeps. */
export const documentKinds = {
  ...invoiceKinds,
  /** A fiscal receipt (bon fiscal) the company received. */
  receipt: 'receipt.received',
  contract: 'contract',
  /** ANAF's decisions and the taxpayer's account statement (ro/taxaccount/documents.ts). */
  taxDecision: taxDocumentKinds.decision,
  taxStatement: taxDocumentKinds.statement,
  /** The annual inventory's lists (ro/yearend/documents.ts). */
  inventoryList: inventoryDocumentKind,
  /** A customs declaration of import or export, and a VIES answer (ro/trade/documents.ts). */
  customsDeclaration: customsDocumentKind,
  viesCheck: viesDocumentKind,
  /** A fiscal cash register's daily closing report (ro/retail/documents.ts). */
  zReport: zReportKind,
} as const;
export type DocumentKind = (typeof documentKinds)[keyof typeof documentKinds];
/** The kinds `documents.record` accepts. */
export const extractedKinds = [
  documentKinds.purchase,
  documentKinds.sale,
  documentKinds.purchaseCredit,
  documentKinds.saleCredit,
  documentKinds.receipt,
  documentKinds.contract,
  documentKinds.taxDecision,
  documentKinds.taxStatement,
  documentKinds.inventoryList,
  documentKinds.customsDeclaration,
  documentKinds.viesCheck,
  documentKinds.zReport,
] as const;
export type ExtractedKind = (typeof extractedKinds)[number];
export const isInvoiceKind = (kind: string) =>
  (Object.values(invoiceKinds) as string[]).includes(kind);
export const isCreditKind = (kind: string) =>
  kind === invoiceKinds.saleCredit || kind === invoiceKinds.purchaseCredit;
export const isIssuedKind = (kind: string) =>
  kind === invoiceKinds.sale || kind === invoiceKinds.saleCredit;
export const isTaxKind = (kind: string) =>
  kind === documentKinds.taxDecision || kind === documentKinds.taxStatement;

/**
 * Where a document's content comes from, from the strongest:
 * - `efactura`: the XML ANAF's SPV holds (synced or downloaded);
 * - `issued`: issued by the engine itself (`sales.issue`);
 * - `ubl_upload`: a UBL XML file uploaded by a person or an agent;
 * - `invoicer`: the browser invoicer's export;
 * - `amef`: a fiscal cash register's own export (`retail.importZ`, ro/retail/documents.ts);
 * - `extracted`: read by an agent from a PDF or a photo (`documents.record`).
 */
export const authorities = [
  'efactura',
  'issued',
  'ubl_upload',
  'invoicer',
  'amef',
  'extracted',
] as const;
export type Authority = (typeof authorities)[number];

/** A field's source: the line of the file's text layer (`evidence.read`) it was read from. */
export const citationSchema = z
  .object({
    page: z.number().int().min(1).max(100_000),
    line: z.number().int().min(1).max(1_000_000),
    /** The words on that line that carry the value, as the line shows them. */
    text: z.string().min(1).max(1000),
  })
  .strict();
export type Citation = z.infer<typeof citationSchema>;
/** A field path in the body (`totals.gross`, `taxes.0.tax`, `supplier.taxId`). */
export const fieldPathSchema = z
  .string()
  .max(200)
  .regex(/^[A-Za-z][A-Za-z]*(\.(\d{1,4}|[A-Za-z][A-Za-z]*))*$/);
export const citationsSchema = z
  .record(fieldPathSchema, citationSchema)
  .refine((value) => Object.keys(value).length <= 400, 'Cel mult 400 de citări.');
export type Citations = z.infer<typeof citationsSchema>;

const rateSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,2})(\.\d{1,4})?$/)
  .transform((value) => new Amount(value).toString());
const partySchema = z
  .object({
    name: z.string().min(1).max(500),
    taxId: z.string().min(1).max(100),
    country: z.string().regex(/^[A-Z]{2}$/),
  })
  .strict();
const currencySchema = z.string().regex(/^[A-Z]{3}$/);

/**
 * An invoice or credit note as an agent reads it: the UBL parser's shape, with defaults for what
 * a printed invoice rarely states (allowances, charges, prepaid amounts, rounding, line ids). The
 * engine completes it into `invoiceDocumentSchema` (`extractedInvoiceBody`).
 */
export const extractedInvoiceInput = z
  .object({
    number: z.string().min(1).max(100),
    issueDate: dateSchema,
    taxPointDate: dateSchema.nullable().default(null),
    /** The date of the supply (BT-72), when the document prints it («data livrării»). */
    deliveryDate: dateSchema.optional(),
    dueDate: dateSchema.optional(),
    currency: currencySchema,
    vatCurrency: currencySchema.optional(),
    vatAccountingTotal: moneySchema.optional(),
    supplier: partySchema,
    customer: partySchema,
    /** A credit note's corrected invoice (BT-25). */
    originalInvoiceNumber: z.string().min(1).max(100).nullable().default(null),
    /** «TVA la încasare» printed on the invoice. */
    vatOnCollection: z.literal(true).optional(),
    payeeIbans: z.array(z.string().min(15).max(42)).min(1).max(5).optional(),
    lines: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100).optional(),
            description: z.string().max(1000),
            net: signedMoneySchema,
            vatCategory: z.string().min(1).max(10),
            vatRate: rateSchema.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
    taxes: z
      .array(
        z
          .object({
            base: moneySchema,
            tax: moneySchema,
            category: z.string().min(1).max(10),
            rate: rateSchema.nullable(),
            exemptionReason: z.string().max(1000).nullable().default(null),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    totals: z
      .object({
        /** The sum of the lines, when the document states it; the engine adds them otherwise. */
        lineNet: moneySchema.optional(),
        net: moneySchema,
        tax: moneySchema,
        gross: moneySchema,
        allowances: moneySchema.default('0.00'),
        charges: moneySchema.default('0.00'),
        prepaid: moneySchema.default('0.00'),
        rounding: z
          .string()
          .regex(/^-?\d+\.\d{2}$/)
          .default('0.00'),
        /** What is due, when the document states it; gross less prepaid plus rounding otherwise. */
        payable: moneySchema.optional(),
      })
      .strict(),
  })
  .strict();
export type ExtractedInvoiceInput = z.infer<typeof extractedInvoiceInput>;

const sum = (values: string[]) => values.reduce((total, value) => total.plus(value), new Amount(0));

/** The stored body of an extracted invoice or credit note of `kind`. */
export function extractedInvoiceBody(kind: string, input: ExtractedInvoiceInput): InvoiceDocument {
  const t = input.totals;
  return invoiceDocumentSchema.parse({
    parserVersion: extractedInvoiceVersion,
    documentType: isCreditKind(kind) ? 'credit_note' : 'invoice',
    ...(input.vatOnCollection ? { vatOnCollection: true } : {}),
    number: input.number,
    issueDate: input.issueDate,
    taxPointDate: input.taxPointDate,
    ...(input.deliveryDate ? { deliveryDate: input.deliveryDate } : {}),
    ...(input.dueDate ? { dueDate: input.dueDate } : {}),
    ...(input.payeeIbans ? { payeeIbans: input.payeeIbans } : {}),
    currency: input.currency,
    ...(input.vatCurrency ? { vatCurrency: input.vatCurrency } : {}),
    ...(input.vatAccountingTotal ? { vatAccountingTotal: input.vatAccountingTotal } : {}),
    supplier: input.supplier,
    customer: input.customer,
    originalInvoiceNumber: input.originalInvoiceNumber,
    customizationId: '',
    lines: input.lines.map((line, index) => ({
      id: line.id ?? String(index + 1),
      description: line.description,
      net: line.net,
      vatCategory: line.vatCategory,
      vatRate: line.vatRate,
    })),
    taxes: input.taxes,
    totals: {
      lineNet: t.lineNet ?? sum(input.lines.map((line) => line.net)).toFixed(2),
      net: t.net,
      tax: t.tax,
      gross: t.gross,
      allowances: t.allowances,
      charges: t.charges,
      prepaid: t.prepaid,
      rounding: t.rounding,
      payable: t.payable ?? new Amount(t.gross).minus(t.prepaid).plus(t.rounding).toFixed(2),
    },
  });
}

/** A fiscal receipt (bon fiscal), as printed: amounts include VAT. */
export const receiptDocumentSchema = z
  .object({
    parserVersion: z.literal(receiptSchemaVersion),
    seller: partySchema,
    /** The buyer's CUI, when the receipt carries it (bon fiscal cu CUI). */
    buyerTaxId: z.string().min(1).max(100).nullable(),
    /** The receipt's number (BF). */
    number: z.string().min(1).max(100),
    /** The fiscal cash register (its unique id or series), whose numbers the receipt continues;
     * without it, receipts of one seller's several registers cannot be told apart. */
    register: z.string().min(1).max(100).nullable(),
    issueDate: dateSchema,
    time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/)
      .nullable(),
    currency: currencySchema,
    lines: z
      .array(
        z
          .object({
            description: z.string().max(1000),
            /** The line's amount with VAT; negative for a discount. */
            gross: signedMoneySchema,
            vatRate: rateSchema,
          })
          .strict(),
      )
      .min(1)
      .max(500),
    /** The VAT totals per rate, as the receipt prints them. */
    taxes: z
      .array(z.object({ rate: rateSchema, gross: moneySchema, tax: moneySchema }).strict())
      .min(1)
      .max(20),
    totals: z.object({ gross: moneySchema, tax: moneySchema }).strict(),
    payment: z.enum(['cash', 'card', 'other']).nullable(),
  })
  .strict();
export type ReceiptDocument = z.infer<typeof receiptDocumentSchema>;
export const receiptInput = receiptDocumentSchema.extend({
  parserVersion: z.literal(receiptSchemaVersion).default(receiptSchemaVersion),
  buyerTaxId: z.string().min(1).max(100).nullable().default(null),
  register: z.string().min(1).max(100).nullable().default(null),
  time: receiptDocumentSchema.shape.time.default(null),
  payment: receiptDocumentSchema.shape.payment.default(null),
});

/** A contract, as far as the books need it: who, from when, for what and for how much. */
export const contractDocumentSchema = z
  .object({
    parserVersion: z.literal(contractSchemaVersion),
    title: z.string().min(1).max(500),
    number: z.string().min(1).max(100).nullable(),
    /** The day it was signed. */
    date: dateSchema,
    parties: z
      .array(
        z
          .object({
            name: z.string().min(1).max(500),
            taxId: z.string().min(1).max(100).nullable(),
            country: z.string().regex(/^[A-Z]{2}$/),
            role: z.string().min(1).max(100),
          })
          .strict(),
      )
      .min(2)
      .max(10),
    effectiveFrom: dateSchema,
    effectiveTo: dateSchema.nullable(),
    currency: currencySchema.nullable(),
    /** The contract's total value, when it states one. */
    value: moneySchema.nullable(),
    /** A recurring amount (a rent, a fee), when it states one. */
    recurring: z
      .object({ amount: moneySchema, period: z.enum(['month', 'quarter', 'year']) })
      .strict()
      .nullable(),
    subject: z.string().max(2000),
  })
  .strict();
export type ContractDocument = z.infer<typeof contractDocumentSchema>;
export const contractInput = contractDocumentSchema.extend({
  parserVersion: z.literal(contractSchemaVersion).default(contractSchemaVersion),
  number: z.string().min(1).max(100).nullable().default(null),
  effectiveTo: dateSchema.nullable().default(null),
  currency: currencySchema.nullable().default(null),
  value: moneySchema.nullable().default(null),
  recurring: contractDocumentSchema.shape.recurring.default(null),
  subject: z.string().max(2000).default(''),
});

export type ExtractedBody =
  | InvoiceDocument
  | ReceiptDocument
  | ContractDocument
  | TaxDecisionDocument
  | TaxStatementDocument
  | InventoryList
  | CustomsDeclaration
  | ViesCheck
  | ZReportDocument;

/** The body an extracted document of `kind` is stored with, from what the agent read. */
export function extractedBody(kind: ExtractedKind, body: unknown): ExtractedBody {
  if (kind === documentKinds.receipt) return receiptDocumentSchema.parse(receiptInput.parse(body));
  if (kind === documentKinds.contract)
    return contractDocumentSchema.parse(contractInput.parse(body));
  if (kind === documentKinds.taxDecision)
    return taxDecisionDocumentSchema.parse(taxDecisionDocumentInput.parse(body));
  if (kind === documentKinds.taxStatement)
    return taxStatementDocumentSchema.parse(taxStatementDocumentInput.parse(body));
  if (kind === documentKinds.inventoryList)
    return inventoryListSchema.parse(inventoryListInput.parse(body));
  if (kind === documentKinds.customsDeclaration)
    return customsDeclarationSchema.parse(customsDeclarationInput.parse(body));
  if (kind === documentKinds.viesCheck) return viesCheckSchema.parse(viesCheckInput.parse(body));
  if (isZReportKind(kind)) return zReportDocumentSchema.parse(zReportInput.parse(body));
  if (typeof body !== 'object' || body === null || !('parserVersion' in body))
    return extractedInvoiceBody(kind, extractedInvoiceInput.parse(body));
  // The UBL parser's full shape, as `documents.get` returns it, is accepted too.
  const full = invoiceDocumentSchema.parse(body);
  requireCondition(
    full.parserVersion === extractedInvoiceVersion &&
      full.documentType === (isCreditKind(kind) ? 'credit_note' : 'invoice'),
    'DOCUMENT_KIND',
    'Documentul extras nu corespunde tipului indicat.',
  );
  return full;
}

/** A Romanian or foreign tax identifier as the engine keeps it: without the RO prefix and
 * spaces (as `recordInvoice` has always normalized the supplier's). */
export const normalizedTaxId = (value: string) => value.replace(/^RO/i, '').replace(/\s+/g, '');
/** A document number as identities compare it: compatibility forms folded, without spaces,
 * in capitals. */
export const normalizedNumber = (value: string) =>
  value.normalize('NFKC').replace(/\s+/g, '').toUpperCase();

/**
 * The identity documents of one invoice share, whatever their source (a PDF, e-Factura, the
 * invoicer): the supplier's tax identifier, the normalized number, the issue date and the type.
 * For a number already in normal form it is the hash `recordInvoice` has always deduplicated
 * e-Factura documents on. Receipts are identified by seller, register and number, and only when
 * the register is known (a chain's stores share its CUI and restart their numbers); contracts by
 * the other party, number and date, when numbered. Null when a document has no identity.
 */
export function documentIdentity(kind: string, body: unknown, companyTaxId: string): string | null {
  if (isInvoiceKind(kind)) {
    const parsed = invoiceDocumentSchema.safeParse(body);
    if (!parsed.success) return null;
    const invoice = parsed.data;
    return hashOf([
      normalizedTaxId(invoice.supplier.taxId),
      normalizedNumber(invoice.number),
      invoice.issueDate,
      invoice.documentType,
    ]);
  }
  if (kind === documentKinds.receipt) {
    const parsed = receiptDocumentSchema.safeParse(body);
    if (!parsed.success || !parsed.data.register) return null;
    const receipt = parsed.data;
    return hashOf([
      'receipt',
      normalizedTaxId(receipt.seller.taxId),
      normalizedNumber(`${receipt.register}/${receipt.number}`),
      receipt.issueDate,
    ]);
  }
  if (kind === documentKinds.contract) {
    const parsed = contractDocumentSchema.safeParse(body);
    if (!parsed.success || !parsed.data.number) return null;
    const contract = parsed.data;
    const other = contract.parties.find(
      (party) => party.taxId && normalizedTaxId(party.taxId) !== companyTaxId,
    );
    if (!other?.taxId) return null;
    return hashOf([
      'contract',
      normalizedTaxId(other.taxId),
      normalizedNumber(contract.number!),
      contract.date,
    ]);
  }
  // A decision by its issuer, number and date; a statement by the day its balances are at and
  // the SPV document it is, so the same statement downloaded twice is one group.
  if (kind === documentKinds.taxDecision) {
    const parsed = taxDecisionDocumentSchema.safeParse(body);
    if (!parsed.success) return null;
    const decision = parsed.data;
    return hashOf([
      'tax.decision',
      decision.issuer.taxId ? normalizedTaxId(decision.issuer.taxId) : decision.issuer.name,
      normalizedNumber(decision.number),
      decision.issueDate,
    ]);
  }
  if (kind === documentKinds.taxStatement) {
    const parsed = taxStatementDocumentSchema.safeParse(body);
    if (!parsed.success) return null;
    return hashOf(['tax.statement', companyTaxId, parsed.data.source, parsed.data.asOf]);
  }
  // A customs declaration by its MRN; a VIES answer by the code, the date and its consultation.
  if (kind === documentKinds.customsDeclaration || kind === documentKinds.viesCheck)
    return tradeIdentity(kind, body);
  // An inventory list by its date and title: the same list recorded twice is one group.
  if (kind === documentKinds.inventoryList) {
    const parsed = inventoryListSchema.safeParse(body);
    if (!parsed.success) return null;
    return hashOf([
      'inventory.list',
      companyTaxId,
      parsed.data.date,
      normalizedNumber(parsed.data.title),
    ]);
  }
  // A Z report by the register and its number: a photo of it and the register's export of the
  // same day are one group.
  if (isZReportKind(kind)) {
    const parsed = zReportDocumentSchema.safeParse(body);
    if (!parsed.success) return null;
    return hashOf([
      'zreport',
      normalizedTaxId(parsed.data.seller.taxId),
      normalizedNumber(parsed.data.register),
      String(Number(parsed.data.number)),
      parsed.data.issueDate,
    ]);
  }
  return null;
}

/** A document's totals as lists show them, whatever its kind; null when it has none. */
export function documentTotals(body: unknown): { net: string; tax: string; gross: string } | null {
  if (typeof body !== 'object' || body === null || !('totals' in body)) return null;
  const totals = (body as { totals: Record<string, unknown> }).totals;
  if (typeof totals?.gross !== 'string' || typeof totals.tax !== 'string') return null;
  const net =
    typeof totals.net === 'string'
      ? totals.net
      : new Amount(totals.gross).minus(totals.tax).toFixed(2);
  return { net, tax: totals.tax, gross: totals.gross };
}
