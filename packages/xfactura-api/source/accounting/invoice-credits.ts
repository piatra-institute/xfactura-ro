import { and, eq } from 'drizzle-orm';
import type { Transaction } from './db';
import type { Actor } from './commands';
import {
  Amount,
  canonical,
  creditNoteInput,
  generalBodySchema,
  invoiceTreatmentSchema,
  requireCondition,
  toBani,
  type CreditNoteInput,
  type GeneralBody,
  type PostingLine,
} from './domain';
import { evidence, invoiceDocuments } from './schema';
import { creditSnapshot, invoicePosition } from './invoice-positions';
import { regimesAt } from './foundation';

const identity = (value: string) => value.trim().replace(/^RO/i, '');
/** The original approved tax treatment owns the rate; the credit's issue date does not replace it. */
export async function interpretCreditNote(tx: Transaction, actor: Actor, input: CreditNoteInput) {
  const [credit] = await tx
    .select()
    .from(invoiceDocuments)
    .where(
      and(
        eq(invoiceDocuments.companyId, actor.companyId),
        eq(invoiceDocuments.id, input.invoiceId),
      ),
    );
  requireCondition(credit, 'NOT_FOUND', 'Factura de corecție nu este disponibilă.', 404);
  const original = await invoicePosition(tx, actor.companyId, input.originalInvoiceId);
  const doc = credit.body,
    base = original.invoice.body,
    previous = original.treatment;
  requireCondition(
    doc.documentType === 'credit_note' &&
      doc.currency === 'RON' &&
      base.currency === 'RON' &&
      credit.direction === original.invoice.direction &&
      doc.originalInvoiceNumber === base.number &&
      doc.supplier.country === base.supplier.country &&
      doc.customer.country === base.customer.country &&
      identity(doc.supplier.taxId) === identity(base.supplier.taxId) &&
      identity(doc.customer.taxId) === identity(base.customer.taxId),
    'CREDIT_ORIGIN',
    'Corecția trebuie să identifice factura originală și aceleași părți, sens și monedă.',
  );
  requireCondition(
    input.recognitionDate >= original.journal.date &&
      doc.issueDate >= base.issueDate &&
      input.decisionDate >= base.issueDate &&
      input.decisionDate <= doc.issueDate &&
      input.decisionDate <= input.recognitionDate &&
      input.decisionDate.slice(0, 7) === input.recognitionDate.slice(0, 7) &&
      doc.issueDate.slice(0, 7) === input.recognitionDate.slice(0, 7),
    'UNSUPPORTED_PERIOD_TREATMENT',
    'Este necesar un eveniment curent documentat; erorile și evenimentele de ajustare anuale au proceduri distincte.',
  );
  const [source] = await tx
    .select({ id: evidence.id })
    .from(evidence)
    .where(
      and(eq(evidence.companyId, actor.companyId), eq(evidence.id, input.treatmentEvidenceId)),
    );
  requireCondition(source, 'NOT_FOUND', 'Documentul deciziei nu este disponibil.', 404);
  const totals = doc.totals;
  requireCondition(
    totals.allowances === '0.00' &&
      totals.charges === '0.00' &&
      totals.prepaid === '0.00' &&
      totals.rounding === '0.00' &&
      doc.taxes.length === 1 &&
      base.taxes.length === 1 &&
      new Amount(totals.net).gt(0),
    'UNSUPPORTED_TREATMENT',
    'Este necesară o corecție simplă a serviciilor, cu o singură categorie TVA.',
  );
  const tax = doc.taxes[0],
    originalTax = base.taxes[0];
  requireCondition(
    tax.category === originalTax.category &&
      (tax.rate ?? '0') === (originalTax.rate ?? '0') &&
      doc.lines.every(
        (line) =>
          line.vatCategory === originalTax.category &&
          (line.vatRate ?? '0') === (originalTax.rate ?? '0'),
      ),
    'CREDIT_VAT_RATE',
    'Corecția folosește categoria și cota operațiunii originale.',
  );
  requireCondition(
    new Amount(tax.base)
      .mul(originalTax.rate ?? '0')
      .div(100)
      .toDecimalPlaces(2, Amount.ROUND_HALF_UP)
      .eq(tax.tax),
    'VAT_AMOUNT',
    'TVA corecției nu se reconciliază cu baza și cota originală.',
  );
  const oldRegistration = await regimesAt(tx, actor.companyId, previous.taxPointDate);
  const currentRegistration = await regimesAt(tx, actor.companyId, input.recognitionDate);
  requireCondition(
    oldRegistration.vat &&
      currentRegistration.vat &&
      previous.registrationIds.includes(oldRegistration.vat.id),
    'STALE_ORIGINAL_TREATMENT',
    'Istoricul TVA al operațiunii originale necesită revizuire.',
    409,
  );
  requireCondition(
    oldRegistration.vat.value === currentRegistration.vat.value &&
      (oldRegistration.vat.value !== 'normal_vat' ||
        (currentRegistration.vat_collection?.value === 'no' &&
          oldRegistration.vat_collection?.value === 'no' &&
          previous.registrationIds.includes(oldRegistration.vat_collection.id))),
    'UNSUPPORTED_REGISTRATION_TRANSITION',
    'Schimbarea înregistrării TVA sau TVA la încasare necesită un tratament distinct.',
  );
  const creditedNet = original.credits.reduce((sum, row) => sum + row.record.netBani, 0n);
  const creditedTax = original.credits.reduce((sum, row) => sum + row.record.taxBani, 0n);
  const creditedGross = original.credits.reduce((sum, row) => sum + row.record.grossBani, 0n);
  requireCondition(
    creditedNet + toBani(totals.net) <= toBani(previous.net) &&
      creditedTax + toBani(totals.tax) <= toBani(previous.tax) &&
      creditedGross + toBani(totals.gross) <= toBani(previous.gross),
    'OVER_CREDIT',
    'Corecțiile cumulate depășesc operațiunea originală.',
    409,
  );
  const account =
    input.kind === 'commercial_discount'
      ? credit.direction === 'sale'
        ? '709'
        : '609'
      : previous.account;
  const deductibleTax = previous.deduction === 'full' ? totals.tax : '0.00';
  const lines: PostingLine[] =
    credit.direction === 'sale'
      ? [
          { account: '4111', debit: '0.00', credit: totals.gross },
          { account, debit: totals.net, credit: '0.00' },
        ]
      : [
          { account: '401', debit: totals.gross, credit: '0.00' },
          {
            account,
            debit: '0.00',
            credit: new Amount(totals.gross).minus(deductibleTax).toFixed(2),
          },
        ];
  if (credit.direction === 'sale' && new Amount(totals.tax).gt(0))
    lines.push({ account: '4427', debit: totals.tax, credit: '0.00' });
  if (credit.direction === 'purchase' && new Amount(deductibleTax).gt(0))
    lines.push({ account: '4426', debit: '0.00', credit: deductibleTax });
  const { accrualMatch: _matchedAccruals, ...originalTreatment } = previous;
  const treatment = invoiceTreatmentSchema.parse({
    ...originalTreatment,
    invoiceId: credit.id,
    invoiceHash: credit.hash,
    treatmentEvidenceId: input.treatmentEvidenceId,
    account,
    net: totals.net,
    tax: totals.tax,
    gross: totals.gross,
    deductibleTax,
    registrationIds: [
      ...new Set([
        ...previous.registrationIds,
        currentRegistration.vat.id,
        ...(currentRegistration.vat.value === 'normal_vat' && currentRegistration.vat_collection
          ? [currentRegistration.vat_collection.id]
          : []),
      ]),
    ],
    credit: {
      originalInvoiceId: original.invoice.id,
      originalJournalId: original.journal.id,
      originalFinancialYearId: generalBodySchema.parse(original.proposal.body).financialYearId,
      originalProposalHash: original.proposal.hash,
      kind: input.kind,
      decisionDate: input.decisionDate,
      periodBasis: input.periodBasis,
      reason: input.reason,
      priorCreditHash: creditSnapshot(original),
      priorCreditCount: original.credits.length,
    },
  });
  return { invoice: credit, original, treatment, lines };
}

export async function checkCreditPosting(tx: Transaction, actor: Actor, body: GeneralBody) {
  const treatment = body.invoice;
  if (!treatment?.credit) return false;
  const credit = treatment.credit;
  const expected = await interpretCreditNote(
    tx,
    actor,
    creditNoteInput.parse({
      invoiceId: treatment.invoiceId,
      originalInvoiceId: credit.originalInvoiceId,
      financialYearId: body.financialYearId,
      recognitionDate: body.date,
      decisionDate: credit.decisionDate,
      treatmentEvidenceId: treatment.treatmentEvidenceId,
      kind: credit.kind,
      periodBasis: credit.periodBasis,
      reason: credit.reason,
    }),
  );
  requireCondition(
    canonical(expected.treatment) === canonical(treatment) &&
      canonical(expected.lines) === canonical(body.lines) &&
      body.purpose === expected.invoice.direction &&
      body.sourceReference === `invoice:${expected.invoice.id}` &&
      body.evidenceId === expected.invoice.evidenceId,
    'STALE_CREDIT',
    'Factura originală sau corecțiile anterioare s-au schimbat. Revizuiți propunerea.',
    409,
  );
  return true;
}
