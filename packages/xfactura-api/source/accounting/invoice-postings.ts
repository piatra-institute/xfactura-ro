import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Transaction } from './db';
import type { Actor } from './commands';
import {
  Amount,
  accountCodeSchema,
  canonical,
  dateSchema,
  idSchema,
  invoiceTreatmentSchema,
  requireCondition,
  type GeneralBody,
  type PostingLine,
} from './domain';
import { invoiceDocuments, evidence } from './schema';
import { invoiceRule } from './accounting-catalogue';
import { regimesAt } from './foundation';
import { checkCreditPosting } from './invoice-credits';
import { checkAccrualInvoicePosting } from './accrual-matching';
import { checkUnbilledSaleInvoicePosting } from './unbilled-sale-matching';
import { checkDeferralInvoicePosting } from './deferral-interpretation';
import { checkDeferralCreditPosting } from './deferral-credits';
import { checkAdvanceInvoicePosting } from './advance-interpretation';
import { checkAdvanceFinalPosting } from './advance-final';
import { checkAdvanceCreditPosting } from './advance-credits';

export const invoicePostingInput = z
  .object({
    invoiceId: idSchema,
    financialYearId: idSchema,
    recognitionDate: dateSchema,
    serviceDate: dateSchema,
    taxPointDate: dateSchema,
    treatmentEvidenceId: idSchema,
    deduction: z.enum(['full', 'none']),
    counterpartyVatCollection: z.literal('no'),
    account: accountCodeSchema,
  })
  .strict();
export type InvoicePostingInput = z.infer<typeof invoicePostingInput>;

/** Deterministic bounded treatment; importing a document never establishes service delivery. */
export async function interpretInvoice(
  tx: Transaction,
  actor: Actor,
  input: InvoicePostingInput,
  timing: 'service' | 'early_subscription' | 'early_advance' = 'service',
) {
  const [invoice] = await tx
    .select()
    .from(invoiceDocuments)
    .where(
      and(
        eq(invoiceDocuments.companyId, actor.companyId),
        eq(invoiceDocuments.id, input.invoiceId),
      ),
    );
  requireCondition(invoice, 'NOT_FOUND', 'Factura nu este disponibilă.', 404);
  const [treatmentSource] = await tx
    .select({ id: evidence.id })
    .from(evidence)
    .where(
      and(eq(evidence.companyId, actor.companyId), eq(evidence.id, input.treatmentEvidenceId)),
    );
  requireCondition(
    treatmentSource,
    'NOT_FOUND',
    'Documentul tratamentului nu este disponibil.',
    404,
  );
  const doc = invoice.body,
    totals = doc.totals;
  requireCondition(
    doc.documentType === 'invoice' &&
      doc.currency === 'RON' &&
      doc.supplier.country === 'RO' &&
      doc.customer.country === 'RO',
    'UNSUPPORTED_TREATMENT',
    'Această propunere acoperă facturi de servicii interne în RON. Este necesar un tratament separat.',
  );
  requireCondition(
    timing === 'early_advance'
      ? input.recognitionDate === doc.issueDate &&
          input.serviceDate > doc.issueDate &&
          input.taxPointDate <= doc.issueDate &&
          (!doc.taxPointDate || doc.taxPointDate === input.taxPointDate)
      : timing === 'early_subscription'
        ? input.recognitionDate === doc.issueDate &&
          input.taxPointDate === doc.issueDate &&
          input.serviceDate >= doc.issueDate &&
          (!doc.taxPointDate || doc.taxPointDate === doc.issueDate)
        : input.recognitionDate.slice(0, 7) === input.serviceDate.slice(0, 7) &&
          input.serviceDate === input.taxPointDate &&
          doc.issueDate.slice(0, 7) === input.recognitionDate.slice(0, 7) &&
          (!doc.taxPointDate || doc.taxPointDate === input.taxPointDate),
    'UNSUPPORTED_PERIOD_TREATMENT',
    'Perioadele diferite necesită tratarea explicită a angajamentelor și a exigibilității.',
  );
  requireCondition(
    totals.allowances === '0.00' &&
      totals.charges === '0.00' &&
      totals.prepaid === '0.00' &&
      totals.rounding === '0.00' &&
      new Amount(totals.net).gt(0),
    'UNSUPPORTED_TREATMENT',
    'Avansurile, reducerile globale și rotunjirile necesită un tratament separat.',
  );
  requireCondition(
    doc.taxes.length === 1,
    'UNSUPPORTED_TREATMENT',
    'Categoriile TVA mixte necesită un tratament separat.',
  );
  const tax = doc.taxes[0],
    rule = invoiceRule(input.taxPointDate, tax.category);
  requireCondition(
    (tax.rate ?? '0') === rule.rate &&
      doc.lines.every(
        (line) => line.vatCategory === tax.category && (line.vatRate ?? '0') === rule.rate,
      ),
    'VAT_RATE',
    'Cota sau categoria TVA diferă de regula datei de exigibilitate.',
  );
  requireCondition(
    new Amount(tax.base)
      .mul(rule.rate)
      .div(100)
      .toDecimalPlaces(2, Amount.ROUND_HALF_UP)
      .eq(tax.tax),
    'VAT_AMOUNT',
    'TVA nu corespunde bazei și cotei declarate.',
  );
  const registrations = await regimesAt(tx, actor.companyId, input.taxPointDate);
  requireCondition(
    registrations.vat,
    'NEEDS_EVIDENCE',
    'Este necesar statutul TVA documentat pentru data exigibilității.',
  );
  const normalVat = registrations.vat.value === 'normal_vat';
  const registrationIds = [registrations.vat.id];
  if (normalVat) {
    requireCondition(
      registrations.vat_collection,
      'NEEDS_EVIDENCE',
      'Este necesar statutul documentat privind TVA la încasare.',
    );
    requireCondition(
      registrations.vat_collection.value === 'no',
      'UNSUPPORTED_TREATMENT',
      'TVA la încasare necesită un tratament separat.',
    );
    registrationIds.push(registrations.vat_collection.id);
  }
  if (invoice.direction === 'sale') {
    requireCondition(
      input.deduction === 'none' && tax.category === (normalVat ? 'S' : 'O'),
      'VAT_TREATMENT',
      'Categoria TVA nu corespunde statutului emitentului.',
    );
    requireCondition(
      /^704(?:\.|$)/.test(input.account),
      'UNSUPPORTED_ACCOUNT',
      'Propunerea acoperă venituri din servicii, în contul 704 sau analitic.',
    );
  } else {
    requireCondition(
      (input.deduction === 'none' || normalVat) && /^628(?:\.|$)/.test(input.account),
      'UNSUPPORTED_ACCOUNT',
      'Propunerea acoperă servicii în contul 628 sau analitic și deducere numai pentru plătitori TVA.',
    );
    requireCondition(
      input.deduction !== 'full' || tax.category === 'S',
      'VAT_TREATMENT',
      'Deducerea integrală necesită o categorie TVA acceptată.',
    );
  }
  const deductibleTax =
    invoice.direction === 'purchase' && input.deduction === 'full' ? totals.tax : '0.00';
  const lines: PostingLine[] =
    invoice.direction === 'sale'
      ? [
          { account: '4111', debit: totals.gross, credit: '0.00' },
          { account: input.account, debit: '0.00', credit: totals.net },
        ]
      : [
          {
            account: input.account,
            debit: new Amount(totals.gross).minus(deductibleTax).toFixed(2),
            credit: '0.00',
          },
          { account: '401', debit: '0.00', credit: totals.gross },
        ];
  if (invoice.direction === 'sale' && new Amount(totals.tax).gt(0))
    lines.push({ account: '4427', debit: '0.00', credit: totals.tax });
  if (new Amount(deductibleTax).gt(0))
    lines.push({ account: '4426', debit: deductibleTax, credit: '0.00' });
  const treatment = invoiceTreatmentSchema.parse({
    invoiceId: invoice.id,
    invoiceHash: invoice.hash,
    treatmentEvidenceId: input.treatmentEvidenceId,
    direction: invoice.direction,
    serviceDate: input.serviceDate,
    taxPointDate: input.taxPointDate,
    deduction: input.deduction,
    counterpartyVatCollection: input.counterpartyVatCollection,
    account: input.account,
    registrationIds,
    ruleId: rule.id,
    ruleHash: rule.hash,
    net: totals.net,
    tax: totals.tax,
    gross: totals.gross,
    deductibleTax,
  });
  return { invoice, lines, treatment };
}

export async function checkInvoicePosting(tx: Transaction, actor: Actor, body: GeneralBody) {
  if (!body.invoice) return;
  const [document] = await tx
    .select({ body: invoiceDocuments.body })
    .from(invoiceDocuments)
    .where(
      and(
        eq(invoiceDocuments.companyId, actor.companyId),
        eq(invoiceDocuments.id, body.invoice.invoiceId),
      ),
    );
  requireCondition(
    !document ||
      !document.body.lines.some((row) => new Amount(row.net).lt(0)) ||
      body.invoice.advanceFinal,
    'ADVANCE_FINAL_REQUIRED',
    'Liniile negative necesită regularizarea explicită a avansurilor.',
  );
  requireCondition(
    !document || document.body.invoiceTypeCode !== '386' || body.invoice.advance,
    'ADVANCE_INVOICE_REQUIRED',
    'Factura de avans necesită tratamentul distinct în 4092/419.',
  );
  if (await checkAdvanceInvoicePosting(tx, actor, body)) return;
  if (await checkAdvanceFinalPosting(tx, actor, body)) return;
  if (await checkAdvanceCreditPosting(tx, actor, body)) return;
  requireCondition(
    !body.settlement,
    'MULTIPLE_ORIGINS',
    'O propunere are o singură origine economică.',
  );
  if (await checkAccrualInvoicePosting(tx, actor, body)) return;
  if (await checkUnbilledSaleInvoicePosting(tx, actor, body)) return;
  if (await checkDeferralInvoicePosting(tx, actor, body)) return;
  if (await checkDeferralCreditPosting(tx, actor, body)) return;
  if (await checkCreditPosting(tx, actor, body)) return;
  const input = body.invoice;
  const expected = await interpretInvoice(tx, actor, {
    invoiceId: input.invoiceId,
    financialYearId: body.financialYearId,
    recognitionDate: body.date,
    serviceDate: input.serviceDate,
    taxPointDate: input.taxPointDate,
    treatmentEvidenceId: input.treatmentEvidenceId,
    deduction: input.deduction,
    counterpartyVatCollection: input.counterpartyVatCollection,
    account: input.account,
  });
  requireCondition(
    canonical(expected.treatment) === canonical(input) &&
      canonical(expected.lines) === canonical(body.lines) &&
      body.purpose === expected.invoice.direction &&
      body.evidenceId === expected.invoice.evidenceId &&
      body.sourceReference === `invoice:${expected.invoice.id}`,
    'STALE_INVOICE_TREATMENT',
    'Tratamentul, sursa sau înregistrările TVA s-au schimbat. Revizuiți propunerea.',
    409,
  );
}
