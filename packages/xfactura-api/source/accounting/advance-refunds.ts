import type { Transaction } from './db';
import type { Actor } from './commands';
import {
  advanceRefundSchema,
  canonical,
  fromBani,
  generalBodySchema,
  requireCondition,
  toBani,
  type AdvanceRefundInput,
  type GeneralBody,
  type PostingLine,
} from './domain';
import { advancePaymentRemaining, loadAdvancePayments } from './advance-state';
import {
  advanceEvidence,
  advanceMovement,
  advanceRegistration,
  checkAdvanceRegistrationPath,
  taxAmount,
} from './advance-interpretation';
import { invoiceRule } from './accounting-catalogue';
export async function interpretAdvanceRefund(
  tx: Transaction,
  actor: Actor,
  input: AdvanceRefundInput,
) {
  const [state] = await loadAdvancePayments(tx, actor.companyId, [input.paymentId]);
  requireCondition(state, 'NOT_FOUND', 'Avansul nu este disponibil.', 404);
  requireCondition(
    advancePaymentRemaining(state).gross > 0n,
    'ADVANCE_PAYMENT_RESOLVED',
    'Avansul este deja facturat sau restituit.',
    409,
  );
  const context = await advanceMovement(tx, actor, input.movementId, input.financialYearId),
    source = await advanceEvidence(tx, actor, input.evidenceId),
    p = state.treatment,
    before = advancePaymentRemaining(state),
    reg = await advanceRegistration(tx, actor.companyId, context.movement.date),
    old = await advanceRegistration(tx, actor.companyId, p.date);
  requireCondition(
    reg.normal === old.normal && old.ids.every((id) => p.registrationIds.includes(id)),
    'UNSUPPORTED_REGISTRATION_TRANSITION',
    'Schimbarea statutului TVA necesită revizuire distinctă.',
  );
  await checkAdvanceRegistrationPath(
    tx,
    actor.companyId,
    p.date,
    context.movement.date,
    old.normal,
  );
  requireCondition(
    context.movement.date >= p.date &&
      state.refunds.every((row) => row.date <= context.movement.date) &&
      state.matches.every((row) => row.date <= context.movement.date),
    'ADVANCE_REFUND_ORDER',
    'Data restituirii nu poate preceda avansul, facturile sau restituirile deja contabilizate.',
  );
  const rule = invoiceRule(p.taxPointDate, p.vatCategory);
  requireCondition(
    rule.id === p.ruleId && rule.hash === p.ruleHash,
    'STALE_ADVANCE_PAYMENT',
    'Regula operațiunii originale necesită revizuire.',
    409,
  );
  const net = input.net === undefined ? before.net : toBani(input.net),
    tax = net === before.net ? before.tax : toBani(taxAmount(fromBani(net), rule.rate)),
    gross = net + tax,
    controlAmount = p.direction === 'purchase' ? gross : net;
  requireCondition(
    net > 0n &&
      net <= before.net &&
      tax >= 0n &&
      tax <= before.tax &&
      gross > 0n &&
      gross <= before.gross &&
      context.movement.amountBani === (p.direction === 'purchase' ? 1n : -1n) * gross,
    'ADVANCE_REFUND_AMOUNT',
    'Baza și TVA restituirii trebuie să explice întreaga mișcare, în limita avansului nefacturat rămas.',
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
  if (input.net !== undefined || state.refunds.length || state.matches.length)
    requireCondition(
      source.id !== p.sourceEvidenceId &&
        !state.matches.some(
          (row) =>
            row.invoiceEvidenceId === source.id ||
            generalBodySchema.parse(row.body).invoice?.treatmentEvidenceId === source.id,
        ) &&
        !state.refunds.some(
          (row) =>
            row.treatment.evidenceId === source.id || row.treatment.sourceEvidenceId === source.id,
        ),
      'ADVANCE_REFUND_EVIDENCE',
      'Păstrați separat noul acord, extrasele bancare și restituirile anterioare.',
    );
  const amounts = {
      net: fromBani(net),
      tax: fromBani(tax),
      gross: fromBani(gross),
      controlAmount: fromBani(controlAmount),
    },
    after = {
      net: fromBani(before.net - net),
      tax: fromBani(before.tax - tax),
      gross: fromBani(before.gross - gross),
      controlAmount: fromBani(before.controlAmount - controlAmount),
    };
  const lines: PostingLine[] =
    p.direction === 'purchase'
      ? [
          { account: context.account.ledgerAccount, debit: amounts.gross, credit: '0.00' },
          { account: '4092', debit: '0.00', credit: amounts.gross },
        ]
      : [
          { account: '419', debit: amounts.net, credit: '0.00' },
          ...(amounts.tax !== '0.00'
            ? [{ account: '4427', debit: amounts.tax, credit: '0.00' }]
            : []),
          { account: context.account.ledgerAccount, debit: '0.00', credit: amounts.gross },
        ];
  const { financialYearId: _, net: _net, ...request } = input;
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
      controlAmount: amounts.controlAmount,
      net: amounts.net,
      tax: amounts.tax,
      gross: amounts.gross,
      ledgerAccount: context.account.ledgerAccount,
      treasuryAccount: context.account.identifier,
      sourceEvidenceId: context.sources[0].id,
      movementHash: context.hash,
      evidenceHash: source.hash,
      ruleId: p.ruleId,
      ruleHash: p.ruleHash,
      registrationIds: [...new Set([...p.registrationIds, ...reg.ids])],
      ...(input.net !== undefined || state.refunds.length || state.matches.length
        ? {
            refundBasis: {
              requestedNet: input.net ?? null,
              priorRefundCount: state.refunds.length,
              priorRefundJournalId: state.refund?.record.journalId ?? null,
              priorRefundFinancialYearId: state.refund
                ? generalBodySchema.parse(state.refund.body).financialYearId
                : null,
              ...(state.match
                ? {
                    priorInvoiceCount: state.matches.length,
                    priorInvoice: {
                      invoiceId: state.match.record.invoiceId,
                      journalId: state.match.record.journalId,
                      financialYearId: generalBodySchema.parse(state.match.body).financialYearId,
                    },
                  }
                : {}),
              before: {
                net: fromBani(before.net),
                tax: fromBani(before.tax),
                gross: fromBani(before.gross),
                controlAmount: fromBani(before.controlAmount),
              },
              after,
            },
          }
        : {}),
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
    ...(p.refundBasis?.requestedNet != null ? { net: p.refundBasis.requestedNet } : {}),
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
