import { and, eq } from 'drizzle-orm';
import type { Transaction } from './db';
import type { Actor } from './commands';
import {
  canonical,
  deferralDiscountInput,
  deferralDiscountSchema,
  invoiceTreatmentSchema,
  requireCondition,
  type DeferralDiscountInput,
  type GeneralBody,
} from './domain';
import { interpretCreditNote } from './invoice-credits';
import { checkDeferralSource, openMonth } from './deferral-interpretation';
import { loadDeferrals } from './deferral-state';
import { evidence } from './schema';

/** A post-invoice commercial discount changes price, not the delivered services or their schedule. */
export async function interpretDeferralDiscount(
  tx: Transaction,
  actor: Actor,
  input: DeferralDiscountInput,
) {
  const result = await interpretCreditNote(tx, actor, input, 'subscription_discount');
  const [state] = await loadDeferrals(tx, actor.companyId, [result.original.proposal.id]);
  requireCondition(state, 'NOT_FOUND', 'Abonamentul original nu este disponibil.', 404);
  await checkDeferralSource(tx, actor, state);
  await openMonth(tx, actor.companyId, input.recognitionDate);
  requireCondition(
    input.recognitionDate >= result.invoice.body.issueDate,
    'UNSUPPORTED_PERIOD_TREATMENT',
    'Data recunoașterii reducerii nu poate preceda factura de corecție.',
  );
  requireCondition(
    result.original.credits.every((row) => row.date <= input.recognitionDate),
    'DEFERRAL_EVENT_ORDER',
    'Data reducerii nu poate preceda corecțiile deja contabilizate.',
    409,
  );
  requireCondition(
    !result.invoice.body.taxPointDate ||
      result.invoice.body.taxPointDate === state.interpretation.taxPointDate,
    'CREDIT_ORIGIN',
    'Reducerea păstrează exigibilitatea operațiunii originale.',
  );
  const [source] = await tx
    .select({ hash: evidence.hash })
    .from(evidence)
    .where(
      and(eq(evidence.companyId, actor.companyId), eq(evidence.id, input.treatmentEvidenceId)),
    );
  requireCondition(source, 'NOT_FOUND', 'Acordul privind reducerea nu este disponibil.', 404);
  requireCondition(
    ![
      state.invoice.evidenceId,
      state.interpretation.treatmentEvidenceId,
      result.invoice.evidenceId,
    ].includes(input.treatmentEvidenceId),
    'DEFERRAL_DISCOUNT_EVIDENCE',
    'Păstrați separat acordul privind reducerea și serviciile neschimbate.',
  );
  const account = state.invoice.direction === 'purchase' ? '609' : '709';
  const amount = result.lines.find((row) => row.account === account)!;
  const treatment = invoiceTreatmentSchema.parse({
    ...result.treatment,
    deferralDiscount: deferralDiscountSchema.parse({
      schemaVersion: 1,
      deferralId: state.record.deferralId,
      servicesUnchanged: true,
      account,
      amount: state.invoice.direction === 'purchase' ? amount.credit : amount.debit,
      controlAccount: state.invoice.direction === 'purchase' ? '471' : '472',
      sourceAmount: state.treatment.amount,
      cancellationJournalId: state.cancellation?.record.journalId ?? null,
      evidenceHash: source.hash,
      ruleReference: 'OMFP1802:76(5)',
    }),
  });
  return { ...result, treatment, state };
}

export async function checkDeferralDiscountPosting(
  tx: Transaction,
  actor: Actor,
  body: GeneralBody,
) {
  const invoice = body.invoice,
    discount = invoice?.deferralDiscount,
    credit = invoice?.credit;
  if (!discount) return false;
  requireCondition(
    invoice &&
      credit &&
      !invoice.deferral &&
      !invoice.deferralCredit &&
      !invoice.accrualMatch &&
      !invoice.unbilledSaleMatch &&
      !invoice.advance &&
      !invoice.advanceCredit &&
      !invoice.advanceFinal,
    'MULTIPLE_ORIGINS',
    'Reducerea identifică un singur abonament original.',
  );
  const expected = await interpretDeferralDiscount(
    tx,
    actor,
    deferralDiscountInput.parse({
      financialYearId: body.financialYearId,
      invoiceId: invoice.invoiceId,
      originalInvoiceId: credit.originalInvoiceId,
      recognitionDate: body.date,
      decisionDate: credit.decisionDate,
      treatmentEvidenceId: invoice.treatmentEvidenceId,
      kind: credit.kind,
      periodBasis: credit.periodBasis,
      reason: credit.reason,
      servicesUnchanged: discount.servicesUnchanged,
    }),
  );
  requireCondition(
    canonical(expected.treatment) === canonical(invoice) &&
      canonical(expected.lines) === canonical(body.lines) &&
      body.purpose === expected.invoice.direction &&
      body.sourceReference === `invoice:${expected.invoice.id}` &&
      body.evidenceId === expected.invoice.evidenceId &&
      !body.correctsJournalId,
    'STALE_DEFERRAL_DISCOUNT',
    'Sursa, reducerile sau tratamentul s-au schimbat. Revizuiți propunerea.',
    409,
  );
  return true;
}
