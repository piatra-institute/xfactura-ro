import { and, eq, inArray } from 'drizzle-orm';
import type { Transaction } from './db';
import type { Actor } from './commands';
import {
  allocationSchedule,
  actualDaySchedule,
  evidencedSchedule,
  canonical,
  deferralRescheduleEffect,
  deferralRescheduleInput,
  fromBani,
  requireCondition,
  toBani,
  type DeferralRescheduleEffect,
} from './domain';
import { deferralSchedule, loadDeferrals } from './deferral-state';
import { checkDeferralHorizon, checkDeferralSource, openMonth } from './deferral-interpretation';
import { creditSnapshot, invoicePosition } from './invoice-positions';
import { financialYearForDate, regimesAt } from './foundation';
import { deferralReschedules, evidence, periods } from './schema';

/** Prospective benefit timing only: no new price, VAT, invoice position or journal entry. */
export async function previewDeferralReschedule(tx: Transaction, actor: Actor, input: unknown) {
  const body = deferralRescheduleInput.parse(input),
    [state] = await loadDeferrals(tx, actor.companyId, [body.deferralId]);
  requireCondition(state, 'NOT_FOUND', 'Abonamentul nu este disponibil.', 404);
  requireCondition(
    body.method === state.treatment.method,
    'DEFERRAL_RESCHEDULE_METHOD',
    'Modificarea păstrează metoda de alocare documentată inițial.',
  );
  const year = await financialYearForDate(tx, actor.companyId, body.date);
  requireCondition(
    year.id === body.financialYearId,
    'FINANCIAL_YEAR',
    'Data nu aparține exercițiului selectat.',
  );
  await openMonth(tx, actor.companyId, body.date);
  await checkDeferralSource(tx, actor, state);
  requireCondition(
    !state.cancellation,
    'DEFERRAL_ALREADY_CANCELLED',
    'Serviciile au deja o anulare totală sau parțială. O altă modificare necesită un tratament distinct.',
    409,
  );
  const latest = state.reschedules.at(-1),
    beforeSchedule = deferralSchedule(state),
    position = await invoicePosition(tx, actor.companyId, state.invoice.id);
  requireCondition(
    (!latest || latest.date <= body.date) &&
      state.releases.every((row) => row.date <= body.date) &&
      position.credits.every((row) => row.date <= body.date),
    'DEFERRAL_EVENT_ORDER',
    'Data modificării nu poate preceda evenimentele deja înregistrate.',
    409,
  );
  requireCondition(
    body.effectiveFrom.endsWith('-01') &&
      (state.treatment.schemaVersion === 1 || body.effectiveFrom >= state.treatment.serviceFrom) &&
      body.effectiveFrom >= body.date &&
      body.evidenceDate <= body.date &&
      body.evidenceDate >= state.journal.date &&
      beforeSchedule.some((row) => row.month === body.effectiveFrom),
    'DEFERRAL_RESCHEDULE_PERIOD',
    'Modificarea începe într-o lună viitoare completă a planului existent.',
  );
  const [source] = await tx
    .select()
    .from(evidence)
    .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, body.evidenceId)));
  requireCondition(source, 'NOT_FOUND', 'Acordul de modificare nu este disponibil.', 404);
  requireCondition(
    ![
      state.invoice.evidenceId,
      state.interpretation.treatmentEvidenceId,
      ...state.reschedules.map((row) => row.evidenceId),
    ].includes(body.evidenceId),
    'DEFERRAL_RESCHEDULE_EVIDENCE',
    'Păstrați separat noul acord privind perioada serviciilor.',
  );
  const released = new Set(state.releases.map((row) => row.record.month));
  requireCondition(
    !state.releases.some((row) => row.record.month >= body.effectiveFrom),
    'DEFERRAL_MONTH_ALLOCATED',
    'Lunile modificate au deja sume recunoscute.',
    409,
  );
  requireCondition(
    beforeSchedule.every(
      (row) => row.date > body.date || row.amount === '0.00' || released.has(row.month),
    ),
    'DEFERRAL_ALLOCATION_DUE',
    'Contabilizați alocările deja scadente înainte de modificarea planului.',
    409,
  );
  const prefix = beforeSchedule.filter((row) => row.month < body.effectiveFrom),
    tail = beforeSchedule.filter((row) => row.month >= body.effectiveFrom),
    amount = tail.reduce((sum, row) => sum + toBani(row.amount), 0n);
  requireCondition(amount > 0n, 'NOTHING_DUE', 'Nu mai există o valoare viitoare de repartizat.');
  const afterSchedule = [
    ...prefix,
    ...(body.method === 'evidenced_monthly_amounts'
      ? evidencedSchedule(fromBani(amount), body.effectiveFrom, body.serviceTo, body.benefits ?? [])
      : body.method === 'actual_calendar_days'
        ? actualDaySchedule(fromBani(amount), body.effectiveFrom, body.serviceTo).schedule
        : allocationSchedule(fromBani(amount), body.effectiveFrom, body.serviceTo)),
  ];
  requireCondition(
    afterSchedule.length <= 60 && canonical(afterSchedule) !== canonical(beforeSchedule),
    'DEFERRAL_RESCHEDULE_PLAN',
    'Planul trebuie să schimbe perioada viitoare și să conțină cel mult 60 de luni.',
  );
  const months = [
    ...new Set(
      [...tail, ...afterSchedule.filter((row) => row.month >= body.effectiveFrom)].map(
        (row) => row.month,
      ),
    ),
  ];
  const locks = await tx
    .select()
    .from(periods)
    .where(and(eq(periods.companyId, actor.companyId), inArray(periods.month, months)));
  requireCondition(
    !locks.some((row) => row.closedAt),
    'CLOSED_PERIOD',
    'O lună modificată este închisă.',
    409,
  );
  const candidate = {
    invoice: state.invoice,
    treatment: {
      ...state.interpretation,
      deferral: { ...state.treatment, serviceTo: body.serviceTo, schedule: afterSchedule },
    },
    lines: state.body.lines,
  };
  await checkDeferralHorizon(tx, actor, candidate);
  const registrationIds = new Set(state.interpretation.registrationIds);
  for (const row of afterSchedule) {
    const current = await regimesAt(tx, actor.companyId, row.date);
    if (current.vat) registrationIds.add(current.vat.id);
    if (current.vat?.value === 'normal_vat' && current.vat_collection)
      registrationIds.add(current.vat_collection.id);
  }
  return deferralRescheduleEffect.parse({
    ...body,
    kind: 'deferrals.reschedule',
    schemaVersion: 1,
    sequence: (latest?.sequence ?? 0) + 1,
    priorRescheduleId: latest?.id ?? null,
    sourceInvoiceId: state.invoice.id,
    sourceJournalId: state.journal.id,
    sourceFinancialYearId: state.body.financialYearId,
    sourceProposalHash: state.proposal.hash,
    evidenceHash: source.hash,
    direction: state.invoice.direction,
    account: state.interpretation.account,
    controlAccount: state.invoice.direction === 'purchase' ? '471' : '472',
    sourceAmount: state.treatment.amount,
    allocated: fromBani(state.releases.reduce((sum, row) => sum + row.record.amountBani, 0n)),
    amount: fromBani(amount),
    priorReleaseCount: state.releases.length,
    priorCreditCount: position.credits.length,
    priorCreditHash: creditSnapshot(position),
    stateHash: state.hash,
    registrationIds: [...registrationIds].sort(),
    beforeSchedule,
    afterSchedule,
  });
}

export async function executeDeferralReschedule(
  tx: Transaction,
  actor: Actor,
  reviewId: string,
  effect: DeferralRescheduleEffect,
) {
  await tx.insert(deferralReschedules).values({
    companyId: actor.companyId,
    id: reviewId,
    deferralId: effect.deferralId,
    sequence: effect.sequence,
    date: effect.date,
    evidenceId: effect.evidenceId,
    body: effect,
    createdBy: actor.actorId,
  });
  return {
    kind: 'rescheduled' as const,
    id: reviewId,
    deferralId: effect.deferralId,
    version: effect.sequence,
  };
}
