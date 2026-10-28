import { and, eq, gt, lte, inArray } from 'drizzle-orm';
import type { Transaction } from './db';
import type { Actor } from './commands';
import {
  Amount,
  allocationSchedule,
  actualDaySchedule,
  canonical,
  deferralInput,
  deferralReleaseSchema,
  deferralTreatmentSchema,
  invoiceTreatmentSchema,
  requireCondition,
  type DeferralInput,
  type DeferralReleaseInput,
  type GeneralBody,
  type PostingLine,
} from './domain';
import { evidence, periods, regimeEvents } from './schema';
import { interpretInvoice } from './invoice-postings';
import { invoiceRule } from './accounting-catalogue';
import { financialYearForDate, regimesAt } from './foundation';
import {
  deferralSchedule,
  loadDeferrals,
  rescheduleContext,
  type DeferralState,
} from './deferral-state';
import { attachDeferralSupplement } from './deferral-supplements';

export async function openMonth(tx: Transaction, companyId: string, date: string) {
  const [period] = await tx
    .select({ closedAt: periods.closedAt })
    .from(periods)
    .where(and(eq(periods.companyId, companyId), eq(periods.month, `${date.slice(0, 7)}-01`)));
  requireCondition(!period?.closedAt, 'CLOSED_PERIOD', 'Luna înregistrării este închisă.', 409);
}
export async function interpretDeferralInvoice(
  tx: Transaction,
  actor: Actor,
  input: DeferralInput,
) {
  const result = await interpretInvoice(
    tx,
    actor,
    {
      invoiceId: input.invoiceId,
      financialYearId: input.financialYearId,
      recognitionDate: input.recognitionDate,
      serviceDate: input.serviceFrom,
      taxPointDate: input.recognitionDate,
      treatmentEvidenceId: input.evidenceId,
      account: input.account,
      deduction: input.deduction,
      counterpartyVatCollection: input.counterpartyVatCollection,
    },
    'early_subscription',
  );
  requireCondition(
    input.evidenceDate <= result.invoice.body.issueDate,
    'DEFERRAL_EVIDENCE_DATE',
    'Documentați condițiile abonamentului cunoscute la înregistrarea facturii.',
  );
  const [source] = await tx
    .select({ hash: evidence.hash })
    .from(evidence)
    .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, input.evidenceId)));
  requireCondition(source, 'NOT_FOUND', 'Documentul abonamentului nu este disponibil.', 404);
  requireCondition(
    input.evidenceId !== result.invoice.evidenceId,
    'DEFERRAL_EVIDENCE',
    'Păstrați separat condițiile abonamentului; factura singură nu justifică alocarea.',
  );
  const amount =
    result.invoice.direction === 'purchase'
      ? new Amount(result.treatment.gross).minus(result.treatment.deductibleTax).toFixed(2)
      : result.treatment.net;
  const daily =
    input.method === 'actual_calendar_days'
      ? actualDaySchedule(amount, input.serviceFrom, input.serviceTo)
      : null;
  const schedule =
    daily?.schedule ?? allocationSchedule(amount, input.serviceFrom, input.serviceTo);
  const plan = deferralTreatmentSchema.parse({
    schemaVersion: daily ? 2 : 1,
    basis: input.basis,
    method: input.method,
    taxPointBasis: input.taxPointBasis,
    serviceFrom: input.serviceFrom,
    serviceTo: input.serviceTo,
    evidenceDate: input.evidenceDate,
    reason: input.reason,
    evidenceHash: source.hash,
    amount,
    schedule,
    ...(daily
      ? {
          serviceDays: daily.serviceDays,
          dayCountBasis: 'actual_inclusive',
          rounding: 'cumulative_floor_bani',
        }
      : {}),
  });
  return {
    invoice: result.invoice,
    treatment: invoiceTreatmentSchema.parse({ ...result.treatment, deferral: plan }),
    lines: result.lines.map((line) =>
      line.account === input.account
        ? { ...line, account: result.invoice.direction === 'purchase' ? '471' : '472' }
        : line,
    ),
  };
}

/** Known rate/registration transitions need their own adjustment treatment. */
async function checkRegistrationPath(tx: Transaction, actor: Actor, from: string, to: string) {
  const original = await regimesAt(tx, actor.companyId, from);
  const changes = await tx
    .select({ axis: regimeEvents.axis, value: regimeEvents.value })
    .from(regimeEvents)
    .where(
      and(
        eq(regimeEvents.companyId, actor.companyId),
        inArray(regimeEvents.axis, ['vat', 'vat_collection']),
        gt(regimeEvents.effectiveFrom, from),
        lte(regimeEvents.effectiveFrom, to),
      ),
    );
  requireCondition(
    changes.every((row) =>
      row.axis === 'vat'
        ? row.value === original.vat?.value
        : original.vat?.value !== 'normal_vat' || row.value === 'no',
    ),
    'DEFERRAL_VAT_TRANSITION',
    'Schimbările de regim din interiorul perioadei cer un tratament distinct.',
  );
}
export async function checkDeferralHorizon(
  tx: Transaction,
  actor: Actor,
  result: {
    invoice: Awaited<ReturnType<typeof interpretDeferralInvoice>>['invoice'];
    treatment: { taxPointDate: string; deferral?: { schedule: { date: string }[] } };
  },
) {
  const original = await regimesAt(tx, actor.companyId, result.treatment.taxPointDate),
    category = result.invoice.body.taxes[0].category,
    rate = result.invoice.body.taxes[0].rate ?? '0';
  await checkRegistrationPath(
    tx,
    actor,
    result.treatment.taxPointDate,
    result.treatment.deferral!.schedule.at(-1)!.date,
  );
  for (const allocation of result.treatment.deferral!.schedule) {
    const current = await regimesAt(tx, actor.companyId, allocation.date);
    requireCondition(
      invoiceRule(allocation.date, category).rate === rate &&
        current.vat?.value === original.vat?.value &&
        (current.vat?.value !== 'normal_vat' || current.vat_collection?.value === 'no'),
      'DEFERRAL_VAT_TRANSITION',
      'Schimbările de cotă sau regim pe durata abonamentului necesită un tratament distinct.',
    );
  }
}
function invoiceRequest(body: GeneralBody): DeferralInput {
  const invoice = body.invoice!,
    plan = invoice.deferral!;
  return deferralInput.parse({
    financialYearId: body.financialYearId,
    invoiceId: invoice.invoiceId,
    recognitionDate: body.date,
    evidenceId: invoice.treatmentEvidenceId,
    taxPointBasis: plan.taxPointBasis,
    account: invoice.account,
    deduction: invoice.deduction,
    counterpartyVatCollection: invoice.counterpartyVatCollection,
    basis: plan.basis,
    method: plan.method,
    serviceFrom: plan.serviceFrom,
    serviceTo: plan.serviceTo,
    evidenceDate: plan.evidenceDate,
    reason: plan.reason,
  });
}
export async function checkDeferralInvoicePosting(
  tx: Transaction,
  actor: Actor,
  body: GeneralBody,
) {
  if (!body.invoice?.deferral) return false;
  requireCondition(
    !body.invoice.credit &&
      !body.invoice.accrualMatch &&
      !body.invoice.unbilledSaleMatch &&
      !body.invoice.deferralCredit,
    'MULTIPLE_ORIGINS',
    'Factura are un singur tratament de recunoaștere.',
  );
  const interpreted = await interpretDeferralInvoice(tx, actor, invoiceRequest(body));
  const expected = body.invoice.deferral.supplement
    ? await attachDeferralSupplement(tx, actor, interpreted, body.invoice.deferral.supplement)
    : interpreted;
  await checkDeferralHorizon(tx, actor, expected);
  await openMonth(tx, actor.companyId, body.date);
  requireCondition(
    canonical(expected.treatment) === canonical(body.invoice) &&
      canonical(expected.lines) === canonical(body.lines) &&
      body.purpose === expected.invoice.direction &&
      body.evidenceId === expected.invoice.evidenceId &&
      body.sourceReference === `invoice:${expected.invoice.id}`,
    'STALE_DEFERRAL',
    'Condițiile, sursa sau tratamentul facturii s-au schimbat. Revizuiți propunerea.',
    409,
  );
  return true;
}
export async function checkDeferralSource(tx: Transaction, actor: Actor, state: DeferralState) {
  const interpreted = await interpretDeferralInvoice(tx, actor, invoiceRequest(state.body));
  const expected = state.treatment.supplement
    ? await attachDeferralSupplement(
        tx,
        actor,
        interpreted,
        state.treatment.supplement,
        state.record,
      )
    : interpreted;
  requireCondition(
    canonical(expected.treatment) === canonical(state.interpretation) &&
      canonical(expected.lines) === canonical(state.body.lines),
    'STALE_DEFERRAL_SOURCE',
    'Tratamentul original necesită revizuire înainte de alocare.',
    409,
  );
}
export async function interpretDeferralRelease(
  tx: Transaction,
  actor: Actor,
  input: DeferralReleaseInput,
) {
  const [state] = await loadDeferrals(tx, actor.companyId, [input.deferralId]);
  requireCondition(state, 'NOT_FOUND', 'Alocarea pe perioade nu este disponibilă.', 404);
  const allocation = deferralSchedule(state).find((row) => row.month === input.month);
  requireCondition(allocation, 'DEFERRAL_MONTH', 'Luna nu aparține planului de alocare.');
  requireCondition(
    !state.cancellation ||
      state.cancellation.treatment.schemaVersion === 2 ||
      input.month < state.cancellation.record.fromMonth,
    'DEFERRAL_MONTH_CANCELLED',
    'Serviciile din această lună au fost anulate.',
    409,
  );
  requireCondition(
    allocation.amount !== '0.00',
    'NOTHING_DUE',
    'Această lună nu necesită o înregistrare valorică.',
  );
  requireCondition(
    !state.releases.some((row) => row.record.month === input.month),
    'DEFERRAL_ALREADY_ALLOCATED',
    'Luna este deja alocată.',
    409,
  );
  const year = await financialYearForDate(tx, actor.companyId, allocation.date);
  requireCondition(
    year.id === input.financialYearId,
    'FINANCIAL_YEAR',
    'Luna nu aparține exercițiului selectat.',
  );
  await openMonth(tx, actor.companyId, allocation.date);
  await checkDeferralSource(tx, actor, state);
  await checkRegistrationPath(tx, actor, state.interpretation.taxPointDate, allocation.date);
  const old = state.interpretation,
    current = await regimesAt(tx, actor.companyId, allocation.date),
    original = await regimesAt(tx, actor.companyId, old.taxPointDate),
    category = state.invoice.body.taxes[0].category;
  requireCondition(
    current.vat &&
      current.vat.value === original.vat?.value &&
      (current.vat.value !== 'normal_vat' || current.vat_collection?.value === 'no') &&
      invoiceRule(allocation.date, category).rate === (state.invoice.body.taxes[0].rate ?? '0'),
    'DEFERRAL_VAT_TRANSITION',
    'Schimbarea cotei sau regimului TVA necesită revizuirea abonamentului.',
  );
  const direction = state.invoice.direction,
    controlAccount = direction === 'purchase' ? '471' : '472';
  const treatment = deferralReleaseSchema.parse({
    schemaVersion: 1,
    deferralId: input.deferralId,
    month: input.month,
    date: allocation.date,
    amount: allocation.amount,
    sourceInvoiceId: state.invoice.id,
    sourceJournalId: state.journal.id,
    sourceFinancialYearId: state.body.financialYearId,
    sourceProposalHash: state.proposal.hash,
    evidenceHash: state.treatment.evidenceHash,
    direction,
    account: old.account,
    controlAccount,
    ruleId: old.ruleId,
    ruleHash: old.ruleHash,
    registrationIds: [
      ...new Set([
        ...old.registrationIds,
        current.vat.id,
        ...(current.vat.value === 'normal_vat' && current.vat_collection
          ? [current.vat_collection.id]
          : []),
      ]),
    ],
    ...(state.cancellation ? { cancellationJournalId: state.cancellation.record.journalId } : {}),
    ...rescheduleContext(state),
  });
  const lines: PostingLine[] = [
    {
      account: direction === 'purchase' ? old.account : controlAccount,
      debit: allocation.amount,
      credit: '0.00',
    },
    {
      account: direction === 'purchase' ? controlAccount : old.account,
      debit: '0.00',
      credit: allocation.amount,
    },
  ];
  return { state, treatment, lines };
}
export async function checkDeferralReleasePosting(
  tx: Transaction,
  actor: Actor,
  body: GeneralBody,
) {
  if (!body.deferralRelease) return;
  const expected = await interpretDeferralRelease(tx, actor, {
    financialYearId: body.financialYearId,
    deferralId: body.deferralRelease.deferralId,
    month: body.deferralRelease.month,
  });
  requireCondition(
    canonical(expected.treatment) === canonical(body.deferralRelease) &&
      canonical(expected.lines) === canonical(body.lines) &&
      body.date === expected.treatment.date &&
      body.evidenceId === expected.state.interpretation.treatmentEvidenceId &&
      body.purpose === 'general' &&
      !body.correctsJournalId &&
      body.sourceReference ===
        `deferral-release:${expected.treatment.deferralId}:${expected.treatment.month}`,
    'STALE_DEFERRAL_RELEASE',
    'Sursa sau tratamentul alocării s-au schimbat. Revizuiți propunerea.',
    409,
  );
}
