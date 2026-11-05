import { z } from 'zod';
import {
  profileAt,
  vatPeriodOf,
  type Effect,
  type Issue,
  type TaxEntrySpec,
  type Treatment,
} from '../../kernel';
import { formatMoney, LEDGER_CURRENCY, parseMoney } from '../../money';
import type { LocalDate } from '../../time';
import { invoiceDocumentSchema } from '../../ubl/invoice-document';
import { invoiceKinds } from '../treatments/invoices';
import { zReportDocumentSchema, zReportKind } from './documents';

/*
 * An invoice the company issued at a buyer's request for a sale its cash register already
 * receipted (Codul fiscal art. 319 alin. (10) lit. a): the buyer may ask for the invoice; the
 * norms' pct. 97 alin. (1): «conform bon fiscal nr./data»). The receipt and the invoice are one
 * sale: the Z report booked its revenue and its VAT, so the invoice books neither (ANAF's SAF-T
 * answers: no accounting entry of its own). It is a memo entry of two tax entries that cancel
 * out, without ledger lines: the invoice's VAT at its rate, by the buyer, and the same amounts
 * taken out of the Z report's day. D300 nets them (the VAT is declared once, with the Z report);
 * D394 lists the invoice among the supplies (L) and leaves its receipts out of the cash
 * registers' receipts (op2, OPANAF nr. 3.769/2015 anexa nr. 2 lit. G: "nu vor fi incluse ...
 * bonurile fiscale pentru care au fost emise facturi").
 */

export const RECEIPT_INVOICE_CLAUSES = [
  'ANAF/Cod-fiscal-consolidat:art.319(10)(a)',
  'ANAF/Cod-fiscal-consolidat:norme.art.319.pct.97(1)',
  'OPANAF3769/2015-A:anexa2.litG',
  'ANAF/SAFT_FAQ_2022:GL.raportZ',
];

const block = (code: string, message: string, path?: string): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
});
const ron = (value: string) => parseMoney(value, LEDGER_CURRENCY);
const lei = (bani: bigint) => formatMoney(bani, LEDGER_CURRENCY);

export const receiptInvoiceInput = z
  .object({
    /** The issued invoice. */
    documentId: z.uuid(),
    /** The Z report whose day holds the receipts the invoice was issued for. */
    zReportId: z.uuid(),
    /** The receipts' numbers, as the invoice cites them. */
    receipts: z.array(z.string().trim().min(1).max(40)).min(1).max(50),
  })
  .strict();
export type ReceiptInvoiceInput = z.infer<typeof receiptInvoiceInput>;

/** The recognition of an invoice issued for a fiscal receipt: no revenue and no VAT of its own. */
export const receiptInvoiceRecognition: Treatment<ReceiptInvoiceInput> = {
  id: 'retail.receiptInvoice',
  version: 1,
  description:
    'Factură emisă la cererea cumpărătorului pentru un bon fiscal: vânzarea și TVA sunt deja în raportul Z, factura le mută doar în declarația D394.',
  input: receiptInvoiceInput,
  agent: true,
  summary:
    'An invoice issued at the buyer’s request for a fiscal receipt: one sale with its Z report, so no revenue or VAT of its own; D394 lists the invoice and leaves its receipts out of op2.',
  toolset: 'books',
  dataClasses: ['books', 'tax'],
  subject: (input) => `document:${input.documentId}`,
  plan: (input) => ({ documents: [input.documentId, input.zReportId], profile: true }),
  evaluate(input, loaded) {
    const issues: Issue[] = [];
    const invoice = loaded.documents.get(input.documentId);
    const report = loaded.documents.get(input.zReportId);
    if (!invoice || invoice.kind !== invoiceKinds.sale)
      return {
        effect: null,
        issues: [block('DOCUMENT_KIND', 'Documentul nu este o factură emisă.', 'documentId')],
      };
    if (!report || report.kind !== zReportKind)
      return {
        effect: null,
        issues: [block('DOCUMENT_KIND', 'Documentul nu este un raport Z.', 'zReportId')],
      };
    const body = invoiceDocumentSchema.parse(invoice.body);
    const day = zReportDocumentSchema.parse(report.body);
    const date = body.issueDate as LocalDate;
    if (body.currency !== LEDGER_CURRENCY)
      issues.push(
        block('CURRENCY', 'Facturile în valută pentru bonuri fiscale nu sunt acoperite.'),
      );
    if (date < day.issueDate)
      issues.push(
        block('RECEIPT_INVOICE_DATE', 'Factura nu poate preceda bonul pentru care se emite.'),
      );
    const period = vatPeriodOf(loaded, date);
    if (period !== vatPeriodOf(loaded, day.issueDate as LocalDate))
      issues.push(
        block(
          'RECEIPT_INVOICE_PERIOD',
          `UNSUPPORTED: factura din ${date} privește bonuri din ${day.issueDate}, altă perioadă fiscală: dacă bonurile se scot din D394-ul perioadei lor (rectificativă) sau din cel curent este o întrebare pentru expert (ro.retail.zreport).`,
        ),
      );
    const status = profileAt(loaded, 'vat.status', date);
    const taxed = body.taxes.filter((row) => ron(row.tax) !== 0n || row.category === 'S');
    if (body.taxes.some((row) => row.category !== 'S' && row.category !== 'O'))
      issues.push(
        block(
          'VAT_CATEGORY',
          'Factura pentru bonuri are doar linii taxate (S) sau, la un neplătitor, neimpozabile (O).',
        ),
      );
    for (const row of taxed) {
      const held = day.taxes.find((tax) => tax.rate === row.rate);
      if (!held || ron(held.gross) < ron(row.base) + ron(row.tax))
        issues.push(
          block(
            'RECEIPT_INVOICE_AMOUNT',
            `Factura are ${lei(ron(row.base) + ron(row.tax))} lei la cota ${row.rate ?? '–'}%, peste vânzările zilei din raportul Z ${day.number} la această cotă.`,
          ),
        );
    }
    if (!invoice.partyId) issues.push(block('PARTY', 'Factura nu are cumpărătorul ca partener.'));
    if (issues.length) return { effect: null, issues };
    const taxEntries: TaxEntrySpec[] = [];
    if (status === 'normal_vat')
      taxed.forEach((row, index) => {
        const code = `S-${row.rate}`;
        const base = ron(row.base);
        const tax = ron(row.tax);
        const common = {
          tax: 'VAT',
          code,
          direction: 'output' as const,
          deductibleBani: 0n,
          ledgerBani: 0n,
          taxPoint: date,
          exigibility: date,
          taxPeriod: period,
        };
        taxEntries.push(
          {
            ...common,
            key: `invoice:${index}`,
            baseBani: base,
            taxBani: tax,
            documentId: invoice.id,
            partyId: invoice.partyId!,
            attributes: {
              documentType: 'invoice',
              fiscalReceipt: report.id,
              number: body.number,
              receipts: input.receipts.join(','),
            },
          },
          {
            ...common,
            key: `zreport:${index}`,
            baseBani: -base,
            taxBani: -tax,
            documentId: report.id,
            attributes: {
              documentType: 'zreport',
              invoiced: invoice.id,
              register: day.register,
              number: day.number,
              receipts: String(-input.receipts.length),
            },
          },
        );
      });
    const effect: Effect = {
      schema: 'effect@1',
      date,
      journalClass: 'memo',
      journalCode: 'VANZARI',
      description:
        `Factură ${body.number} pentru bonurile ${input.receipts.join(', ')} (Z ${day.number})`.slice(
          0,
          500,
        ),
      lines: [],
      openItems: [],
      taxEntries,
      schedules: [],
      explanation: {
        summary: `Factura ${body.number} din ${body.issueDate}, emisă pentru bonurile ${input.receipts.join(', ')} ale raportului Z ${day.number} (${day.issueDate}): ${body.totals.gross} lei, deja înregistrați cu raportul Z; fără venit și TVA proprii.`,
        details: {
          zReport: {
            documentId: report.id,
            register: day.register,
            number: day.number,
            date: day.issueDate,
          },
          receipts: input.receipts,
          clauses: RECEIPT_INVOICE_CLAUSES,
        },
      },
    };
    return { effect, issues };
  },
};
