import type { Transaction } from './db';
import type { Actor } from './commands';
import {
  advanceRefundSchema,
  canonical,
  requireCondition,
  toBani,
  type AdvanceRefundInput,
  type GeneralBody,
  type PostingLine,
} from './domain';
import { loadAdvancePayments } from './advance-state';
import { advanceEvidence, advanceMovement, advanceRegistration } from './advance-interpretation';
export async function interpretAdvanceRefund(
  tx: Transaction,
  actor: Actor,
  input: AdvanceRefundInput,
) {
  const [state] = await loadAdvancePayments(tx, actor.companyId, [input.paymentId]);
  requireCondition(state, 'NOT_FOUND', 'Avansul nu este disponibil.', 404);
  requireCondition(
    !state.match && !state.refund,
    'ADVANCE_PAYMENT_RESOLVED',
    'Avansul este deja facturat sau restituit.',
    409,
  );
  const context = await advanceMovement(tx, actor, input.movementId, input.financialYearId),
    source = await advanceEvidence(tx, actor, input.evidenceId),
    p = state.treatment,
    reg = await advanceRegistration(tx, actor.companyId, context.movement.date),
    old = await advanceRegistration(tx, actor.companyId, p.date);
  requireCondition(
    reg.normal === old.normal && old.ids.every((id) => p.registrationIds.includes(id)),
    'UNSUPPORTED_REGISTRATION_TRANSITION',
    'Schimbarea statutului TVA necesită revizuire distinctă.',
  );
  requireCondition(
    context.movement.amountBani === (p.direction === 'purchase' ? 1n : -1n) * toBani(p.gross) &&
      context.movement.date >= p.date,
    'ADVANCE_REFUND_AMOUNT',
    'Restituirea trebuie să acopere exact avansul bancar nefacturat.',
  );
  requireCondition(
    input.decisionDate >= p.date &&
      input.decisionDate <= context.movement.date &&
      input.decisionDate.slice(0, 7) === context.movement.date.slice(0, 7) &&
      input.evidenceId !== p.evidenceId &&
      !context.sources.some((row) => row.id === source.id),
    'ADVANCE_REFUND_EVIDENCE',
    'Documentați separat acordul curent de restituire.',
  );
  const lines: PostingLine[] =
    p.direction === 'purchase'
      ? [
          { account: context.account.ledgerAccount, debit: p.gross, credit: '0.00' },
          { account: '4092', debit: '0.00', credit: p.gross },
        ]
      : [
          { account: '419', debit: p.net, credit: '0.00' },
          ...(p.tax !== '0.00' ? [{ account: '4427', debit: p.tax, credit: '0.00' }] : []),
          { account: context.account.ledgerAccount, debit: '0.00', credit: p.gross },
        ];
  const { financialYearId: _, ...request } = input;
  return {
    ...context,
    lines,
    treatment: advanceRefundSchema.parse({
      ...request,
      schemaVersion: 1,
      date: context.movement.date,
      originalTaxPointDate: p.taxPointDate,
      vatCategory: p.vatCategory,
      paymentJournalId: state.journal.id,
      originalFinancialYearId: state.body.financialYearId,
      paymentHash: state.proposal.hash,
      stateHash: state.hash,
      direction: p.direction,
      controlAccount: p.controlAccount,
      controlAmount: p.controlAmount,
      net: p.net,
      tax: p.tax,
      gross: p.gross,
      ledgerAccount: context.account.ledgerAccount,
      treasuryAccount: context.account.identifier,
      sourceEvidenceId: context.sources[0].id,
      movementHash: context.hash,
      evidenceHash: source.hash,
      ruleId: p.ruleId,
      ruleHash: p.ruleHash,
      registrationIds: [...new Set([...p.registrationIds, ...reg.ids])],
    }),
  };
}
export async function checkAdvanceRefundPosting(tx: Transaction, actor: Actor, body: GeneralBody) {
  const p = body.advanceRefund;
  if (!p) return;
  const expected = await interpretAdvanceRefund(tx, actor, {
    financialYearId: body.financialYearId,
    paymentId: p.paymentId,
    movementId: p.movementId,
    evidenceId: p.evidenceId,
    decisionDate: p.decisionDate,
    periodBasis: p.periodBasis,
    reason: p.reason,
  });
  requireCondition(
    canonical(p) === canonical(expected.treatment) &&
      canonical(body.lines) === canonical(expected.lines) &&
      body.date === p.date &&
      body.evidenceId === p.sourceEvidenceId &&
      body.purpose === 'general' &&
      !body.correctsJournalId &&
      body.sourceReference === `advance-refund:${p.movementId}`,
    'STALE_ADVANCE_REFUND',
    'Datele sau efectul restituirii s-au schimbat. Revizuiți propunerea.',
    409,
  );
}
