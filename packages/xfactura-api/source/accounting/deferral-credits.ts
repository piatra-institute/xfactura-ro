import { and, eq } from 'drizzle-orm';
import type { Transaction } from './db';
import type { Actor } from './commands';
import {
  canonical,
  deferralCreditInput,
  deferralCreditSchema,
  fromBani,
  invoiceTreatmentSchema,
  requireCondition,
  toBani,
  type DeferralCreditInput,
  type GeneralBody,
} from './domain';
import { interpretCreditNote } from './invoice-credits';
import { checkDeferralSource } from './deferral-interpretation';
import { deferralSchedule, loadDeferrals, rescheduleContext } from './deferral-state';
import { evidence } from './schema';

/** New cancellation of unprovided, complete future months; earned amounts stay intact. */
export async function interpretDeferralCredit(
  tx: Transaction,
  actor: Actor,
  input: DeferralCreditInput,
) {
  const result = await interpretCreditNote(tx, actor, input, 'deferred_subscription');
  const [state] = await loadDeferrals(tx, actor.companyId, [result.original.proposal.id]);
  requireCondition(state, 'NOT_FOUND', 'Abonamentul original nu este disponibil.', 404);
  await checkDeferralSource(tx, actor, state);
  requireCondition(
    state.reschedules.every((row) => row.date <= input.recognitionDate),
    'DEFERRAL_EVENT_ORDER',
    'Data anulării nu poate preceda modificările planului.',
    409,
  );
  requireCondition(
    result.original.credits.every((row) => row.date <= input.recognitionDate),
    'DEFERRAL_EVENT_ORDER',
    'Data anulării nu poate preceda corecțiile deja contabilizate.',
    409,
  );
  requireCondition(
    !state.cancellation,
    'DEFERRAL_ALREADY_CANCELLED',
    'Abonamentul are deja o anulare. O altă modificare necesită un tratament separat.',
    409,
  );
  requireCondition(
    input.cancelFrom.endsWith('-01') &&
      input.cancelFrom >= input.recognitionDate &&
      input.cancelFrom >= result.invoice.body.issueDate &&
      deferralSchedule(state).some((row) => row.month === input.cancelFrom),
    'DEFERRAL_CANCELLATION_PERIOD',
    'Anularea acoperă numai luni calendaristice viitoare, de la prima zi a lunii.',
  );
  requireCondition(
    !result.invoice.body.taxPointDate ||
      result.invoice.body.taxPointDate === state.interpretation.taxPointDate,
    'CREDIT_ORIGIN',
    'Exigibilitatea originală nu se schimbă prin anulare.',
  );
  requireCondition(
    state.releases.every((row) => row.date <= input.recognitionDate),
    'DEFERRAL_EVENT_ORDER',
    'Data anulării nu poate preceda alocările deja contabilizate.',
    409,
  );
  requireCondition(
    !state.releases.some((row) => row.record.month >= input.cancelFrom),
    'DEFERRAL_MONTH_ALLOCATED',
    'Lunile anulate au deja sume recunoscute. Este necesar un tratament de corecție distinct.',
    409,
  );
  const [source] = await tx
    .select({ hash: evidence.hash })
    .from(evidence)
    .where(
      and(eq(evidence.companyId, actor.companyId), eq(evidence.id, input.treatmentEvidenceId)),
    );
  requireCondition(source, 'NOT_FOUND', 'Acordul de anulare nu este disponibil.', 404);
  requireCondition(
    ![
      state.interpretation.treatmentEvidenceId,
      state.invoice.evidenceId,
      result.invoice.evidenceId,
    ].includes(input.treatmentEvidenceId),
    'DEFERRAL_CANCELLATION_EVIDENCE',
    'Păstrați separat acordul care justifică anularea serviciilor viitoare.',
  );
  const months = deferralSchedule(state).filter((row) => row.month >= input.cancelFrom),
    amount = months.reduce((sum, row) => sum + toBani(row.amount), 0n),
    creditAmount =
      state.invoice.direction === 'purchase'
        ? toBani(result.treatment.gross) - toBani(result.treatment.deductibleTax)
        : toBani(result.treatment.net),
    allocated = state.releases.reduce((sum, row) => sum + row.record.amountBani, 0n),
    remainingBefore = toBani(state.treatment.amount) - allocated;
  requireCondition(
    amount > 0n && creditAmount === amount,
    'DEFERRAL_CREDIT_AMOUNT',
    'Valoarea corecției trebuie să coincidă exact cu lunile anulate, inclusiv TVA nerecuperabilă.',
  );
  const treatment = invoiceTreatmentSchema.parse({
    ...result.treatment,
    deferralCredit: deferralCreditSchema.parse({
      schemaVersion: 1,
      deferralId: state.record.deferralId,
      controlAccount: state.invoice.direction === 'purchase' ? '471' : '472',
      cancelFrom: input.cancelFrom,
      cancelTo: months.at(-1)!.month,
      amount: fromBani(amount),
      allocated: fromBani(allocated),
      remainingBefore: fromBani(remainingBefore),
      remainingAfter: fromBani(remainingBefore - amount),
      priorReleaseCount: state.releases.length,
      priorStateHash: state.hash,
      evidenceHash: source.hash,
      months,
      ...rescheduleContext(state),
    }),
  });
  return { ...result, treatment, state };
}

export async function checkDeferralCreditPosting(tx: Transaction, actor: Actor, body: GeneralBody) {
  const invoice = body.invoice,
    cancellation = invoice?.deferralCredit,
    credit = invoice?.credit;
  if (!cancellation) return false;
  requireCondition(
    invoice &&
      credit &&
      !invoice.deferral &&
      !invoice.deferralDiscount &&
      !invoice.accrualMatch &&
      !invoice.unbilledSaleMatch,
    'MULTIPLE_ORIGINS',
    'Corecția identifică un singur abonament original.',
  );
  const expected = await interpretDeferralCredit(
    tx,
    actor,
    deferralCreditInput.parse({
      financialYearId: body.financialYearId,
      invoiceId: invoice.invoiceId,
      originalInvoiceId: credit.originalInvoiceId,
      recognitionDate: body.date,
      decisionDate: credit.decisionDate,
      treatmentEvidenceId: invoice.treatmentEvidenceId,
      kind: credit.kind,
      periodBasis: credit.periodBasis,
      reason: credit.reason,
      cancelFrom: cancellation.cancelFrom,
    }),
  );
  requireCondition(
    canonical(expected.treatment) === canonical(invoice) &&
      canonical(expected.lines) === canonical(body.lines) &&
      body.purpose === expected.invoice.direction &&
      body.sourceReference === `invoice:${expected.invoice.id}` &&
      body.evidenceId === expected.invoice.evidenceId &&
      !body.correctsJournalId,
    'STALE_DEFERRAL_CREDIT',
    'Alocările sau tratamentul abonamentului s-au schimbat. Revizuiți propunerea.',
    409,
  );
  return true;
}
