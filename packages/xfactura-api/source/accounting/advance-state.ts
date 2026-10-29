import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Transaction } from './db';
import { canonical, fromBani, generalBodySchema, requireCondition, toBani } from './domain';
import {
  advancePayments,
  advanceInvoices,
  advanceInvoiceMatches,
  advanceRefunds,
  advanceUses,
  invoiceDocuments,
  journals,
  proposals,
} from './schema';
import { loadInvoicePositions, positionView } from './invoice-positions';
import { sha256 } from './object-store';

export async function loadAdvancePayments(tx: Transaction, companyId: string, ids: string[]) {
  if (!ids.length) return [];
  const roots = await tx
    .select({ record: advancePayments, journal: journals, proposal: proposals })
    .from(advancePayments)
    .innerJoin(
      journals,
      and(
        eq(journals.companyId, advancePayments.companyId),
        eq(journals.id, advancePayments.journalId),
      ),
    )
    .innerJoin(
      proposals,
      and(
        eq(proposals.companyId, advancePayments.companyId),
        eq(proposals.id, advancePayments.paymentId),
      ),
    )
    .where(and(eq(advancePayments.companyId, companyId), inArray(advancePayments.paymentId, ids)));
  const matches = await tx
    .select({
      record: advanceInvoiceMatches,
      date: journals.date,
      body: proposals.body,
      invoiceEvidenceId: invoiceDocuments.evidenceId,
    })
    .from(advanceInvoiceMatches)
    .innerJoin(
      journals,
      and(
        eq(journals.companyId, advanceInvoiceMatches.companyId),
        eq(journals.id, advanceInvoiceMatches.journalId),
      ),
    )
    .innerJoin(
      proposals,
      and(eq(proposals.companyId, journals.companyId), eq(proposals.id, journals.sourceId)),
    )
    .innerJoin(
      invoiceDocuments,
      and(
        eq(invoiceDocuments.companyId, advanceInvoiceMatches.companyId),
        eq(invoiceDocuments.id, advanceInvoiceMatches.invoiceId),
      ),
    )
    .where(
      and(
        eq(advanceInvoiceMatches.companyId, companyId),
        inArray(advanceInvoiceMatches.paymentId, ids),
      ),
    )
    .orderBy(asc(journals.number));
  const refunds = await tx
    .select({ record: advanceRefunds, date: journals.date, body: proposals.body })
    .from(advanceRefunds)
    .innerJoin(
      journals,
      and(
        eq(journals.companyId, advanceRefunds.companyId),
        eq(journals.id, advanceRefunds.journalId),
      ),
    )
    .innerJoin(
      proposals,
      and(
        eq(proposals.companyId, advanceRefunds.companyId),
        eq(proposals.id, advanceRefunds.proposalId),
      ),
    )
    .where(and(eq(advanceRefunds.companyId, companyId), inArray(advanceRefunds.paymentId, ids)))
    .orderBy(asc(journals.number));
  return roots.map((root) => {
    const body = generalBodySchema.parse(root.proposal.body),
      treatment = body.advancePayment;
    requireCondition(treatment, 'ADVANCE_SOURCE', 'Sursa avansului nu este disponibilă.', 500);
    const ownMatches = matches.filter((row) => row.record.paymentId === root.record.paymentId),
      match = ownMatches.at(-1),
      ownRefunds = refunds
        .filter((row) => row.record.paymentId === root.record.paymentId)
        .map((row) => ({ ...row, treatment: generalBodySchema.parse(row.body).advanceRefund! })),
      refund = ownRefunds.at(-1);
    return {
      ...root,
      body,
      treatment,
      match,
      matches: ownMatches,
      refund,
      refunds: ownRefunds,
      hash: sha256(
        canonical({
          proposalHash: root.proposal.hash,
          journalId: root.journal.id,
          match: match
            ? {
                invoiceId: match.record.invoiceId,
                journalId: match.record.journalId,
                date: match.date,
              }
            : null,
          refund: refund ? { journalId: refund.record.journalId, date: refund.date } : null,
          ...(ownMatches.length > 1
            ? {
                priorMatches: ownMatches.slice(0, -1).map((row) => ({
                  invoiceId: row.record.invoiceId,
                  journalId: row.record.journalId,
                  date: row.date,
                })),
              }
            : {}),
          ...(ownRefunds.length > 1
            ? {
                priorRefunds: ownRefunds
                  .slice(0, -1)
                  .map((row) => ({ journalId: row.record.journalId, date: row.date })),
              }
            : {}),
        }),
      ),
    };
  });
}
export type AdvancePaymentState = Awaited<ReturnType<typeof loadAdvancePayments>>[number];
export function advancePaymentRemaining(state: AdvancePaymentState, date?: string) {
  const refunds = state.refunds.filter((row) => !date || row.date <= date);
  const matches = state.matches.filter((row) => !date || row.date <= date);
  const used = { net: 0n, tax: 0n, gross: 0n, controlAmount: 0n };
  const invoiced = { net: 0n, tax: 0n, gross: 0n, controlAmount: 0n };
  for (const { treatment } of refunds) {
    used.net += toBani(treatment.net);
    used.tax += toBani(treatment.tax);
    used.gross += toBani(treatment.gross);
    used.controlAmount += toBani(treatment.controlAmount);
  }
  for (const { record } of matches) {
    invoiced.net += record.netBani;
    invoiced.tax += record.taxBani;
    invoiced.gross += record.grossBani;
    invoiced.controlAmount +=
      state.treatment.direction === 'purchase' ? record.grossBani : record.netBani;
  }
  return {
    used,
    invoiced,
    net: toBani(state.treatment.net) - used.net - invoiced.net,
    tax: toBani(state.treatment.tax) - used.tax - invoiced.tax,
    gross: toBani(state.treatment.gross) - used.gross - invoiced.gross,
    controlAmount:
      toBani(state.treatment.controlAmount) - used.controlAmount - invoiced.controlAmount,
  };
}
export function advancePaymentView(state: AdvancePaymentState, date: string) {
  const matches = state.matches.filter((row) => row.date <= date),
    match = matches.at(-1),
    refunds = state.refunds.filter((row) => row.date <= date),
    refund = refunds.at(-1),
    remaining = advancePaymentRemaining(state, date);
  return {
    id: state.record.paymentId,
    movementId: state.record.movementId,
    journalId: state.journal.id,
    financialYearId: state.body.financialYearId,
    date: state.journal.date,
    direction: state.treatment.direction,
    counterparty: state.treatment.counterparty,
    net: state.treatment.net,
    tax: state.treatment.tax,
    gross: state.treatment.gross,
    controlAccount: state.treatment.controlAccount,
    controlAmount: state.treatment.controlAmount,
    serviceExpectedOn: state.treatment.serviceExpectedOn,
    evidenceId: state.treatment.evidenceId,
    remainingGross: fromBani(remaining.gross),
    remainingControl: fromBani(remaining.controlAmount),
    invoiceId: match?.record.invoiceId ?? null,
    refundJournalId: refund?.record.journalId ?? null,
    status:
      remaining.gross > 0n
        ? ('open' as const)
        : match
          ? ('invoiced' as const)
          : ('refunded' as const),
    ...(matches.length
      ? {
          remainingNet: fromBani(remaining.net),
          remainingTax: fromBani(remaining.tax),
          invoicedNet: fromBani(remaining.invoiced.net),
          invoicedTax: fromBani(remaining.invoiced.tax),
          invoicedGross: fromBani(remaining.invoiced.gross),
          invoices: matches.map((row) => ({
            invoiceId: row.record.invoiceId,
            journalId: row.record.journalId,
            financialYearId: generalBodySchema.parse(row.body).financialYearId,
            date: row.date,
            net: fromBani(row.record.netBani),
            tax: fromBani(row.record.taxBani),
            gross: fromBani(row.record.grossBani),
          })),
        }
      : {}),
    ...(refunds.some((row) => row.treatment.refundBasis)
      ? {
          refundedNet: fromBani(remaining.used.net),
          refundedTax: fromBani(remaining.used.tax),
          refundedGross: fromBani(remaining.used.gross),
          remainingNet: fromBani(remaining.net),
          remainingTax: fromBani(remaining.tax),
          refunds: refunds.map((row) => ({
            journalId: row.record.journalId,
            financialYearId: generalBodySchema.parse(row.body).financialYearId,
            date: row.date,
            evidenceId: row.treatment.evidenceId,
            net: row.treatment.net,
            tax: row.treatment.tax,
            gross: row.treatment.gross,
            controlAmount: row.treatment.controlAmount,
          })),
        }
      : {}),
    hash: state.hash,
  };
}
export async function loadAdvanceInvoices(tx: Transaction, companyId: string, ids: string[]) {
  if (!ids.length) return [];
  const roots = await tx
    .select()
    .from(advanceInvoices)
    .where(and(eq(advanceInvoices.companyId, companyId), inArray(advanceInvoices.invoiceId, ids)));
  const positions = await loadInvoicePositions(
    tx,
    companyId,
    roots.map((row) => row.invoiceId),
  );
  const uses = await tx
    .select({ record: advanceUses, date: journals.date })
    .from(advanceUses)
    .innerJoin(
      journals,
      and(eq(journals.companyId, advanceUses.companyId), eq(journals.id, advanceUses.journalId)),
    )
    .where(and(eq(advanceUses.companyId, companyId), inArray(advanceUses.advanceInvoiceId, ids)))
    .orderBy(asc(journals.date), asc(advanceUses.finalInvoiceId));
  return positions.map((position) => {
    const treatment = position.treatment.advance;
    requireCondition(treatment, 'ADVANCE_SOURCE', 'Factura nu identifică avansul.', 500);
    const ownUses = uses.filter((row) => row.record.advanceInvoiceId === position.invoice.id);
    return {
      ...position,
      advance: treatment,
      uses: ownUses,
      hash: sha256(
        canonical({
          positionHash: position.hash,
          uses: ownUses.map(({ record, date }) => ({
            invoiceId: record.finalInvoiceId,
            journalId: record.journalId,
            date,
            net: record.netBani.toString(),
            tax: record.taxBani.toString(),
            gross: record.grossBani.toString(),
            control: record.controlBani.toString(),
          })),
        }),
      ),
    };
  });
}
export type AdvanceInvoiceState = Awaited<ReturnType<typeof loadAdvanceInvoices>>[number];
export function advanceRemaining(state: AdvanceInvoiceState, date?: string) {
  const uses = state.uses.filter((row) => !date || row.date <= date),
    credits = state.credits.filter((row) => !date || row.date <= date);
  const used = { net: 0n, tax: 0n, gross: 0n, control: 0n },
    credited = { net: 0n, tax: 0n, gross: 0n, control: 0n };
  for (const { record } of uses) {
    used.net += record.netBani;
    used.tax += record.taxBani;
    used.gross += record.grossBani;
    used.control += record.controlBani;
  }
  for (const { record } of credits) {
    credited.net += record.netBani;
    credited.tax += record.taxBani;
    credited.gross += record.grossBani;
    credited.control +=
      state.invoice.direction === 'sale'
        ? record.netBani
        : record.grossBani - record.deductibleTaxBani;
  }
  return {
    used,
    credited,
    net: toBani(state.treatment.net) - used.net - credited.net,
    tax: toBani(state.treatment.tax) - used.tax - credited.tax,
    gross: toBani(state.treatment.gross) - used.gross - credited.gross,
    control: toBani(state.advance.amount) - used.control - credited.control,
  };
}
export function advanceInvoiceView(state: AdvanceInvoiceState, date: string) {
  const remaining = advanceRemaining(state, date),
    invoice = positionView(state, date);
  return {
    invoiceId: state.invoice.id,
    number: state.invoice.body.number,
    journalId: state.journal.id,
    financialYearId: generalBodySchema.parse(state.proposal.body).financialYearId,
    date: state.journal.date,
    direction: state.invoice.direction,
    account: state.advance.serviceAccount,
    controlAccount: state.advance.controlAccount,
    net: state.treatment.net,
    tax: state.treatment.tax,
    gross: state.treatment.gross,
    controlAmount: state.advance.amount,
    usedNet: fromBani(remaining.used.net),
    creditedNet: fromBani(remaining.credited.net),
    remainingNet: fromBani(remaining.net),
    remainingTax: fromBani(remaining.tax),
    remainingGross: fromBani(remaining.gross),
    remainingControl: fromBani(remaining.control),
    invoiceBalance: invoice.balance,
    serviceExpectedOn: state.advance.serviceExpectedOn,
    evidenceId: state.advance.evidenceId,
    status:
      remaining.net > 0n
        ? ('open' as const)
        : remaining.credited.net > 0n
          ? ('cancelled' as const)
          : ('used' as const),
    hash: state.hash,
  };
}
