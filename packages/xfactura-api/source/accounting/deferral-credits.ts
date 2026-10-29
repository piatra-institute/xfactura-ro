import { and, eq, inArray } from 'drizzle-orm';
import type { Transaction } from './db';
import type { Actor } from './commands';
import {
  canonical,
  actualDaySchedule,
  allocationSchedule,
  deferralCreditInput,
  deferralCreditSchema,
  deferralScopeReductionInput,
  fromBani,
  invoiceTreatmentSchema,
  requireCondition,
  toBani,
  type DeferralCreditInput,
  type DeferralScopeReductionInput,
  type GeneralBody,
} from './domain';
import { interpretCreditNote } from './invoice-credits';
import { checkDeferralHorizon, checkDeferralSource, openMonth } from './deferral-interpretation';
import { deferralSchedule, loadDeferrals, rescheduleContext } from './deferral-state';
import { evidence, periods } from './schema';

/** Full or partial cancellation of future service scope; recognized benefits stay intact. */
export async function interpretDeferralCredit(
  tx: Transaction,
  actor: Actor,
  input: DeferralCreditInput | DeferralScopeReductionInput,
) {
  const scopeReduction = 'changeBasis' in input;
  const result = await interpretCreditNote(tx, actor, input, 'deferred_subscription');
  const [state] = await loadDeferrals(tx, actor.companyId, [result.original.proposal.id]);
  requireCondition(state, 'NOT_FOUND', 'Abonamentul original nu este disponibil.', 404);
  requireCondition(
    !scopeReduction || state.treatment.schemaVersion !== 3,
    'DEFERRAL_SCOPE_ALLOCATION',
    'Diminuarea unui plan de beneficii documentate necesită un nou plan explicit; repartizarea uniformă nu se presupune.',
  );
  await checkDeferralSource(tx, actor, state);
  await openMonth(tx, actor.companyId, input.recognitionDate);
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
    (!scopeReduction || input.recognitionDate >= result.invoice.body.issueDate) &&
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
    futureAmount = months.reduce((sum, row) => sum + toBani(row.amount), 0n),
    creditAmount =
      state.invoice.direction === 'purchase'
        ? toBani(result.treatment.gross) - toBani(result.treatment.deductibleTax)
        : toBani(result.treatment.net),
    allocated = state.releases.reduce((sum, row) => sum + row.record.amountBani, 0n),
    remainingBefore = toBani(state.treatment.amount) - allocated;
  requireCondition(
    creditAmount > 0n &&
      (scopeReduction ? creditAmount < futureAmount : creditAmount === futureAmount),
    'DEFERRAL_CREDIT_AMOUNT',
    scopeReduction
      ? 'Reducerea serviciilor viitoare trebuie să lase o valoare pozitivă de alocat.'
      : 'Valoarea corecției trebuie să coincidă exact cu lunile anulate, inclusiv TVA nerecuperabilă.',
  );
  const amount = creditAmount;
  const beforeSchedule = deferralSchedule(state);
  let scope;
  if (scopeReduction) {
    requireCondition(
      !state.reschedules.some((row) => row.evidenceId === input.treatmentEvidenceId),
      'DEFERRAL_CANCELLATION_EVIDENCE',
      'Păstrați separat acordul privind diminuarea serviciilor viitoare.',
    );
    const first = months[0],
      last = months.at(-1)!,
      remainingAmount = fromBani(futureAmount - amount),
      afterSchedule = [
        ...beforeSchedule.filter((row) => row.month < input.cancelFrom),
        ...(state.treatment.method === 'actual_calendar_days'
          ? actualDaySchedule(
              remainingAmount,
              'serviceFrom' in first && typeof first.serviceFrom === 'string'
                ? first.serviceFrom
                : first.month,
              'serviceTo' in last && typeof last.serviceTo === 'string'
                ? last.serviceTo
                : last.date,
            ).schedule
          : allocationSchedule(remainingAmount, first.month, last.date)),
      ];
    const released = new Set(state.releases.map((row) => row.record.month));
    requireCondition(
      beforeSchedule.every(
        (row) =>
          row.date > input.recognitionDate || row.amount === '0.00' || released.has(row.month),
      ),
      'DEFERRAL_ALLOCATION_DUE',
      'Contabilizați alocările deja scadente înainte de modificarea serviciilor.',
      409,
    );
    const locks = await tx
      .select()
      .from(periods)
      .where(
        and(
          eq(periods.companyId, actor.companyId),
          inArray(
            periods.month,
            months.map((row) => row.month),
          ),
        ),
      );
    requireCondition(
      !locks.some((row) => row.closedAt),
      'CLOSED_PERIOD',
      'O lună modificată este închisă.',
      409,
    );
    await checkDeferralHorizon(tx, actor, {
      invoice: state.invoice,
      treatment: {
        taxPointDate: state.interpretation.taxPointDate,
        deferral: { schedule: afterSchedule },
      },
    });
    scope = {
      schemaVersion: 2,
      changeBasis: input.changeBasis,
      remainingServices: input.remainingServices,
      method: state.treatment.method,
      beforeSchedule,
      afterSchedule,
    };
  }
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
      ...scope,
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
    (cancellation.schemaVersion === 2 ? deferralScopeReductionInput : deferralCreditInput).parse({
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
      ...(cancellation.schemaVersion === 2
        ? {
            changeBasis: cancellation.changeBasis,
            remainingServices: cancellation.remainingServices,
          }
        : {}),
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
