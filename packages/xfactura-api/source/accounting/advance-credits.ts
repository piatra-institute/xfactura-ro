import type { Transaction } from './db';
import type { Actor } from './commands';
import {
  advanceCreditInput,
  advanceCreditSchema,
  canonical,
  fromBani,
  invoiceTreatmentSchema,
  requireCondition,
  toBani,
  type AdvanceCreditInput,
  type GeneralBody,
} from './domain';
import { interpretCreditNote } from './invoice-credits';
import { loadAdvanceInvoices, advanceRemaining } from './advance-state';
import { checkAdvanceSource } from './advance-interpretation';
export async function interpretAdvanceCredit(
  tx: Transaction,
  actor: Actor,
  input: AdvanceCreditInput,
) {
  const result = await interpretCreditNote(tx, actor, input, 'invoiced_advance');
  const [state] = await loadAdvanceInvoices(tx, actor.companyId, [input.originalInvoiceId]);
  requireCondition(state, 'NOT_FOUND', 'Factura de avans nu este disponibilă.', 404);
  await checkAdvanceSource(tx, actor, state);
  requireCondition(
    state.uses.every((row) => row.date <= input.recognitionDate) &&
      state.events.every((row) => row.date <= input.recognitionDate),
    'ADVANCE_EVENT_ORDER',
    'Corecția nu poate preceda evenimentele avansului deja contabilizate.',
  );
  const remaining = advanceRemaining(state),
    i = result.treatment;
  requireCondition(
    toBani(i.net) <= remaining.net &&
      toBani(i.tax) <= remaining.tax &&
      toBani(i.gross) <= remaining.gross,
    'ADVANCE_OVER_CREDIT',
    'Corecția depășește avansul neutilizat.',
    409,
  );
  return {
    ...result,
    treatment: invoiceTreatmentSchema.parse({
      ...i,
      advanceCredit: advanceCreditSchema.parse({
        schemaVersion: 1,
        stateHash: state.hash,
        priorUseCount: state.uses.length,
        availableNet: fromBani(remaining.net),
        availableTax: fromBani(remaining.tax),
        availableGross: fromBani(remaining.gross),
        controlAmount:
          state.invoice.direction === 'sale'
            ? i.net
            : fromBani(toBani(i.gross) - toBani(i.deductibleTax)),
      }),
    }),
  };
}
export async function checkAdvanceCreditPosting(tx: Transaction, actor: Actor, body: GeneralBody) {
  const i = body.invoice,
    c = i?.credit;
  if (!i?.advanceCredit || !c) return false;
  requireCondition(
    !i.advance &&
      !i.advanceFinal &&
      !i.deferral &&
      !i.deferralCredit &&
      !i.accrualMatch &&
      !i.unbilledSaleMatch,
    'MULTIPLE_ORIGINS',
    'Corecția identifică un singur avans.',
  );
  const expected = await interpretAdvanceCredit(
    tx,
    actor,
    advanceCreditInput.parse({
      financialYearId: body.financialYearId,
      invoiceId: i.invoiceId,
      originalInvoiceId: c.originalInvoiceId,
      recognitionDate: body.date,
      decisionDate: c.decisionDate,
      treatmentEvidenceId: i.treatmentEvidenceId,
      kind: c.kind,
      periodBasis: c.periodBasis,
      reason: c.reason,
    }),
  );
  requireCondition(
    canonical(expected.treatment) === canonical(i) &&
      canonical(expected.lines) === canonical(body.lines) &&
      body.evidenceId === expected.invoice.evidenceId &&
      body.purpose === i.direction &&
      body.sourceReference === `invoice:${i.invoiceId}` &&
      !body.correctsJournalId,
    'STALE_ADVANCE_CREDIT',
    'Avansul sau utilizările lui s-au schimbat. Revizuiți propunerea.',
    409,
  );
  return true;
}
