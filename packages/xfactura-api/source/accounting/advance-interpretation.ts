import { and, eq, gt, inArray, lte } from 'drizzle-orm';
import type { Transaction } from './db';
import type { Actor } from './commands';
import {
  Amount,
  advanceInvoiceSchema,
  advancePaymentSchema,
  canonical,
  fromBani,
  generalBodySchema,
  invoiceTreatmentSchema,
  requireCondition,
  toBani,
  type AdvanceInvoiceInput,
  type AdvancePaymentInput,
  type GeneralBody,
  type PostingLine,
} from './domain';
import {
  allocations,
  companies,
  evidence,
  movementPostings,
  movements,
  periods,
  regimeEvents,
} from './schema';
import { financialYearForDate, regimesAt } from './foundation';
import { invoiceRule } from './accounting-catalogue';
import { treasuryAccount, movementEvidence } from './treasury';
import { interpretInvoice } from './invoice-postings';
import {
  advancePaymentRemaining,
  loadAdvancePayments,
  type AdvanceInvoiceState,
} from './advance-state';
import { sha256 } from './object-store';

export const taxIdentity = (value: string) => value.trim().replace(/^RO/i, '');
export const taxAmount = (net: string, rate: string) =>
  new Amount(net).mul(rate).div(100).toDecimalPlaces(2, Amount.ROUND_HALF_UP).toFixed(2);
export async function advanceRegistration(tx: Transaction, companyId: string, date: string) {
  const r = await regimesAt(tx, companyId, date);
  requireCondition(r.vat, 'NEEDS_EVIDENCE', 'Documentați statutul TVA pentru data avansului.');
  requireCondition(
    r.vat.value === 'non_vat' || (r.vat_collection && r.vat_collection.value === 'no'),
    'UNSUPPORTED_TREATMENT',
    'TVA la încasare necesită un tratament separat.',
  );
  return {
    normal: r.vat.value === 'normal_vat',
    ids: [
      r.vat.id,
      ...(r.vat.value === 'normal_vat' && r.vat_collection ? [r.vat_collection.id] : []),
    ],
  };
}
export async function advanceEvidence(tx: Transaction, actor: Actor, id: string) {
  const [source] = await tx
    .select({ id: evidence.id, hash: evidence.hash })
    .from(evidence)
    .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, id)));
  requireCondition(source, 'NOT_FOUND', 'Documentul justificativ nu este disponibil.', 404);
  return source;
}
/** Endpoints alone cannot establish a stable registration path across an intervening change. */
export async function checkAdvanceRegistrationPath(
  tx: Transaction,
  companyId: string,
  from: string,
  to: string,
  normal: boolean,
) {
  const changes = await tx
    .select({ axis: regimeEvents.axis, value: regimeEvents.value })
    .from(regimeEvents)
    .where(
      and(
        eq(regimeEvents.companyId, companyId),
        inArray(regimeEvents.axis, ['vat', 'vat_collection']),
        gt(regimeEvents.effectiveFrom, from),
        lte(regimeEvents.effectiveFrom, to),
      ),
    );
  requireCondition(
    changes.every((row) =>
      row.axis === 'vat'
        ? row.value === (normal ? 'normal_vat' : 'non_vat')
        : !normal || row.value === 'no',
    ),
    'UNSUPPORTED_REGISTRATION_TRANSITION',
    'Schimbările intermediare ale înregistrării TVA necesită un tratament distinct.',
  );
}
export async function advanceMovement(
  tx: Transaction,
  actor: Actor,
  movementId: string,
  financialYearId: string,
) {
  const [movement] = await tx
    .select()
    .from(movements)
    .where(and(eq(movements.companyId, actor.companyId), eq(movements.id, movementId)));
  requireCondition(movement, 'NOT_FOUND', 'Mișcarea nu este disponibilă.', 404);
  const year = await financialYearForDate(tx, actor.companyId, movement.date),
    account = await treasuryAccount(tx, actor.companyId, movement.bankAccount, movement.date);
  requireCondition(
    year.id === financialYearId,
    'FINANCIAL_YEAR',
    'Mișcarea nu aparține exercițiului selectat.',
  );
  requireCondition(
    account.kind === 'bank' && account.currency === 'RON',
    'ADVANCE_TREASURY',
    'Avansurile înainte de factură folosesc un cont bancar în RON.',
  );
  const [closed] = await tx
    .select({ closedAt: periods.closedAt })
    .from(periods)
    .where(
      and(
        eq(periods.companyId, actor.companyId),
        eq(periods.month, `${movement.date.slice(0, 7)}-01`),
      ),
    );
  requireCondition(!closed?.closedAt, 'CLOSED_PERIOD', 'Luna este închisă.', 409);
  const [native] = await tx
    .select({ id: movementPostings.movementId })
    .from(movementPostings)
    .where(
      and(
        eq(movementPostings.companyId, actor.companyId),
        eq(movementPostings.movementId, movement.id),
      ),
    );
  const [legacy] = await tx
    .select({ id: allocations.id })
    .from(allocations)
    .where(
      and(eq(allocations.companyId, actor.companyId), eq(allocations.movementId, movement.id)),
    );
  requireCondition(
    !native && !legacy,
    'ALREADY_RECONCILED',
    'Mișcarea este deja contabilizată.',
    409,
  );
  const sources = await movementEvidence(tx, actor.companyId, movement.id);
  return {
    movement,
    account,
    sources,
    hash: sha256(canonical({ ...movement, amountBani: movement.amountBani.toString() })),
  };
}
export async function interpretAdvancePayment(
  tx: Transaction,
  actor: Actor,
  input: AdvancePaymentInput,
) {
  const context = await advanceMovement(tx, actor, input.movementId, input.financialYearId),
    { movement, account } = context;
  const source = await advanceEvidence(tx, actor, input.evidenceId),
    reg = await advanceRegistration(tx, actor.companyId, movement.date),
    rule = invoiceRule(movement.date, input.vatCategory);
  const [company] = await tx
    .select({ cui: companies.cui })
    .from(companies)
    .where(eq(companies.id, actor.companyId));
  requireCondition(
    taxIdentity(input.counterparty.taxId) !== company.cui,
    'ADVANCE_PARTY',
    'Avansul trebuie să identifice partenerul contractual.',
  );
  requireCondition(
    input.evidenceDate <= movement.date &&
      input.serviceExpectedOn > movement.date &&
      !context.sources.some((row) => row.id === source.id),
    'ADVANCE_EVIDENCE',
    'Documentați separat contractul și serviciile viitoare.',
  );
  requireCondition(
    (input.direction === 'sale' ? /^704(?:\.|$)/ : /^628(?:\.|$)/).test(input.account),
    'UNSUPPORTED_ACCOUNT',
    'Acest avans acoperă servicii în 628/704 sau analitic.',
  );
  requireCondition(
    input.direction !== 'sale' || input.vatCategory === (reg.normal ? 'S' : 'O'),
    'VAT_TREATMENT',
    'Categoria TVA nu corespunde statutului emitentului.',
  );
  const tax = taxAmount(input.net, rule.rate),
    gross = fromBani(toBani(input.net) + toBani(tax)),
    amount = toBani(gross);
  requireCondition(
    toBani(input.net) > 0n &&
      movement.amountBani === (input.direction === 'sale' ? amount : -amount),
    'ADVANCE_AMOUNT',
    'Baza și TVA trebuie să explice întreaga mișcare bancară.',
  );
  const controlAccount = input.direction === 'purchase' ? '4092' : '419',
    controlAmount = input.direction === 'purchase' ? gross : input.net;
  const lines: PostingLine[] =
    input.direction === 'purchase'
      ? [
          { account: controlAccount, debit: gross, credit: '0.00' },
          { account: account.ledgerAccount, debit: '0.00', credit: gross },
        ]
      : [
          { account: account.ledgerAccount, debit: gross, credit: '0.00' },
          { account: controlAccount, debit: '0.00', credit: input.net },
          ...(tax !== '0.00' ? [{ account: '4427', debit: '0.00', credit: tax }] : []),
        ];
  const { financialYearId: _, ...request } = input;
  return {
    ...context,
    lines,
    treatment: advancePaymentSchema.parse({
      ...request,
      schemaVersion: 1,
      date: movement.date,
      taxPointDate: movement.date,
      tax,
      gross,
      controlAccount,
      controlAmount,
      ledgerAccount: account.ledgerAccount,
      treasuryAccount: account.identifier,
      movementHash: context.hash,
      sourceEvidenceId: context.sources[0].id,
      evidenceHash: source.hash,
      ruleId: rule.id,
      ruleHash: rule.hash,
      registrationIds: reg.ids,
    }),
  };
}
export async function checkAdvancePaymentPosting(tx: Transaction, actor: Actor, body: GeneralBody) {
  if (!body.advancePayment) return;
  const p = body.advancePayment,
    expected = await interpretAdvancePayment(tx, actor, {
      financialYearId: body.financialYearId,
      movementId: p.movementId,
      direction: p.direction,
      counterparty: p.counterparty,
      account: p.account,
      net: p.net,
      vatCategory: p.vatCategory,
      counterpartyVatCollection: p.counterpartyVatCollection,
      evidenceId: p.evidenceId,
      evidenceDate: p.evidenceDate,
      reference: p.reference,
      serviceExpectedOn: p.serviceExpectedOn,
      reason: p.reason,
    });
  requireCondition(
    canonical(p) === canonical(expected.treatment) &&
      canonical(body.lines) === canonical(expected.lines) &&
      body.date === p.date &&
      body.evidenceId === p.sourceEvidenceId &&
      body.purpose === 'general' &&
      !body.correctsJournalId &&
      body.sourceReference === `advance-payment:${p.movementId}`,
    'STALE_ADVANCE_PAYMENT',
    'Datele sau efectul avansului s-au schimbat. Revizuiți propunerea.',
    409,
  );
}
export async function interpretAdvanceInvoice(
  tx: Transaction,
  actor: Actor,
  input: AdvanceInvoiceInput,
) {
  const expected = await interpretInvoice(
    tx,
    actor,
    {
      financialYearId: input.financialYearId,
      invoiceId: input.invoiceId,
      recognitionDate: input.recognitionDate,
      serviceDate: input.serviceExpectedOn,
      taxPointDate: input.taxPointDate,
      treatmentEvidenceId: input.evidenceId,
      account: input.account,
      deduction: input.deduction,
      counterpartyVatCollection: input.counterpartyVatCollection,
    },
    'early_advance',
  );
  const source = await advanceEvidence(tx, actor, input.evidenceId),
    reg = await advanceRegistration(tx, actor.companyId, input.recognitionDate),
    old = await advanceRegistration(tx, actor.companyId, input.taxPointDate),
    doc = expected.invoice.body;
  requireCondition(
    reg.normal === old.normal,
    'UNSUPPORTED_REGISTRATION_TRANSITION',
    'Schimbarea statutului TVA necesită regularizare distinctă.',
  );
  requireCondition(
    input.evidenceDate <= doc.issueDate && input.evidenceId !== expected.invoice.evidenceId,
    'ADVANCE_EVIDENCE',
    'Păstrați separat contractul pentru avans.',
  );
  requireCondition(
    new Set(input.paymentIds).size === input.paymentIds.length,
    'DUPLICATE_ALLOCATION',
    'Un avans bancar se alocă o singură dată.',
  );
  const payments = await loadAdvancePayments(tx, actor.companyId, input.paymentIds);
  requireCondition(
    payments.length === input.paymentIds.length,
    'NOT_FOUND',
    'Un avans bancar nu este disponibil.',
    404,
  );
  const party = expected.invoice.direction === 'purchase' ? doc.supplier : doc.customer;
  const assigned = [];
  const lines = [...expected.lines];
  for (const payment of payments.sort((a, b) =>
    a.record.paymentId.localeCompare(b.record.paymentId),
  )) {
    const p = payment.treatment,
      remaining = advancePaymentRemaining(payment);
    requireCondition(
      !payment.match && remaining.gross > 0n,
      'ADVANCE_PAYMENT_RESOLVED',
      'Avansul bancar este deja facturat sau restituit.',
      409,
    );
    requireCondition(
      payment.journal.date <= input.recognitionDate &&
        payment.refunds.every((row) => row.date <= input.recognitionDate) &&
        p.direction === expected.invoice.direction &&
        taxIdentity(p.counterparty.taxId) === taxIdentity(party.taxId) &&
        p.account === input.account &&
        p.vatCategory === doc.taxes[0].category &&
        p.ruleHash === expected.treatment.ruleHash,
      'ADVANCE_INVOICE_ORIGIN',
      'Factura trebuie să corespundă partenerului, cotei și serviciilor avansului.',
    );
    const atPayment = await advanceRegistration(tx, actor.companyId, payment.journal.date);
    await checkAdvanceRegistrationPath(
      tx,
      actor.companyId,
      p.date,
      input.recognitionDate,
      atPayment.normal,
    );
    requireCondition(
      atPayment.normal === reg.normal &&
        atPayment.ids.every((id) => p.registrationIds.includes(id)),
      'STALE_ADVANCE_PAYMENT',
      'Istoricul TVA al avansului necesită revizuire.',
      409,
    );
    assigned.push({
      paymentId: payment.record.paymentId,
      movementId: payment.record.movementId,
      journalId: payment.journal.id,
      financialYearId: payment.body.financialYearId,
      proposalHash: payment.proposal.hash,
      stateHash: payment.hash,
      net: fromBani(remaining.net),
      tax: fromBani(remaining.tax),
      gross: fromBani(remaining.gross),
    });
  }
  if (assigned.length) {
    requireCondition(
      input.taxPointDate === payments.map((row) => row.journal.date).sort()[0] &&
        assigned.reduce((sum, row) => sum + toBani(row.net), 0n) ===
          toBani(expected.treatment.net) &&
        assigned.reduce((sum, row) => sum + toBani(row.tax), 0n) ===
          toBani(expected.treatment.tax) &&
        assigned.reduce((sum, row) => sum + toBani(row.gross), 0n) ===
          toBani(expected.treatment.gross),
      'ADVANCE_INVOICE_TOTAL',
      'Această asociere facturează integral avansurile bancare selectate, la exigibilitatea originală.',
    );
  } else
    requireCondition(
      input.taxPointDate === doc.issueDate,
      'ADVANCE_TAX_POINT',
      'Documentați încasarea anterioară sau folosiți exigibilitatea facturii de avans.',
    );
  const controlAccount = expected.invoice.direction === 'purchase' ? '4092' : '419',
    amount =
      expected.invoice.direction === 'purchase'
        ? fromBani(toBani(expected.treatment.gross) - toBani(expected.treatment.deductibleTax))
        : expected.treatment.net;
  const mapped = lines.map((line) =>
    line.account === input.account ? { ...line, account: controlAccount } : line,
  );
  for (const p of assigned) {
    if (expected.invoice.direction === 'purchase')
      mapped.push(
        { account: '401', debit: p.gross, credit: '0.00' },
        { account: '4092', debit: '0.00', credit: p.gross },
      );
    else
      mapped.push(
        { account: '419', debit: p.net, credit: '0.00' },
        ...(p.tax !== '0.00' ? [{ account: '4427', debit: p.tax, credit: '0.00' }] : []),
        { account: '4111', debit: '0.00', credit: p.gross },
      );
  }
  return {
    ...expected,
    lines: mapped,
    treatment: invoiceTreatmentSchema.parse({
      ...expected.treatment,
      account: controlAccount,
      registrationIds: [
        ...new Set([
          ...expected.treatment.registrationIds,
          ...reg.ids,
          ...payments.flatMap((row) => row.treatment.registrationIds),
        ]),
      ],
      advance: advanceInvoiceSchema.parse({
        schemaVersion: 1,
        evidenceId: input.evidenceId,
        evidenceDate: input.evidenceDate,
        reference: input.reference,
        serviceExpectedOn: input.serviceExpectedOn,
        reason: input.reason,
        evidenceHash: source.hash,
        serviceAccount: input.account,
        controlAccount,
        amount,
        payments: assigned,
        previousOutputTax:
          expected.invoice.direction === 'sale'
            ? fromBani(assigned.reduce((sum, row) => sum + toBani(row.tax), 0n))
            : '0.00',
      }),
    }),
  };
}
export async function checkAdvanceInvoicePosting(tx: Transaction, actor: Actor, body: GeneralBody) {
  const i = body.invoice,
    p = i?.advance;
  if (!i || !p) return false;
  requireCondition(
    !i.credit &&
      !i.deferral &&
      !i.accrualMatch &&
      !i.unbilledSaleMatch &&
      !i.advanceFinal &&
      !i.advanceCredit,
    'MULTIPLE_ORIGINS',
    'Factura identifică un singur tratament de avans.',
  );
  const expected = await interpretAdvanceInvoice(tx, actor, {
    financialYearId: body.financialYearId,
    invoiceId: i.invoiceId,
    recognitionDate: body.date,
    taxPointDate: i.taxPointDate,
    account: p.serviceAccount,
    deduction: i.deduction,
    counterpartyVatCollection: i.counterpartyVatCollection,
    paymentIds: p.payments.map((row) => row.paymentId),
    evidenceId: p.evidenceId,
    evidenceDate: p.evidenceDate,
    reference: p.reference,
    serviceExpectedOn: p.serviceExpectedOn,
    reason: p.reason,
  });
  requireCondition(
    canonical(i) === canonical(expected.treatment) &&
      canonical(body.lines) === canonical(expected.lines) &&
      body.evidenceId === expected.invoice.evidenceId &&
      body.purpose === i.direction &&
      body.sourceReference === `invoice:${i.invoiceId}` &&
      !body.correctsJournalId,
    'STALE_ADVANCE_INVOICE',
    'Avansurile sau tratamentul facturii s-au schimbat. Revizuiți propunerea.',
    409,
  );
  return true;
}
export async function checkAdvanceSource(
  tx: Transaction,
  actor: Actor,
  state: AdvanceInvoiceState,
) {
  const body = generalBodySchema.parse(state.proposal.body),
    i = state.treatment,
    p = state.advance;
  const base = await interpretInvoice(
    tx,
    actor,
    {
      financialYearId: body.financialYearId,
      invoiceId: i.invoiceId,
      recognitionDate: body.date,
      serviceDate: p.serviceExpectedOn,
      taxPointDate: i.taxPointDate,
      treatmentEvidenceId: p.evidenceId,
      account: p.serviceAccount,
      deduction: i.deduction,
      counterpartyVatCollection: i.counterpartyVatCollection,
    },
    'early_advance',
  );
  const current = await advanceRegistration(tx, actor.companyId, body.date);
  requireCondition(
    base.treatment.ruleHash === i.ruleHash &&
      base.treatment.registrationIds.every((id) => i.registrationIds.includes(id)) &&
      current.ids.every((id) => i.registrationIds.includes(id)),
    'STALE_ADVANCE_SOURCE',
    'Istoricul facturii de avans necesită revizuire.',
    409,
  );
}
