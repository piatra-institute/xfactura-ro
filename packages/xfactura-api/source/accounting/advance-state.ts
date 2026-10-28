import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Transaction } from './db';
import { canonical, fromBani, generalBodySchema, requireCondition, toBani } from './domain';
import {
  advancePayments,
  advanceInvoices,
  advanceInvoiceMatches,
  advanceRefunds,
  advanceUses,
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
    .select({ record: advanceInvoiceMatches, date: journals.date })
    .from(advanceInvoiceMatches)
    .innerJoin(
      journals,
      and(
        eq(journals.companyId, advanceInvoiceMatches.companyId),
        eq(journals.id, advanceInvoiceMatches.journalId),
      ),
    )
    .where(
      and(
        eq(advanceInvoiceMatches.companyId, companyId),
        inArray(advanceInvoiceMatches.paymentId, ids),
      ),
    );
  const refunds = await tx
    .select({ record: advanceRefunds, date: journals.date })
    .from(advanceRefunds)
    .innerJoin(
      journals,
      and(
        eq(journals.companyId, advanceRefunds.companyId),
        eq(journals.id, advanceRefunds.journalId),
      ),
    )
    .where(and(eq(advanceRefunds.companyId, companyId), inArray(advanceRefunds.paymentId, ids)));
  return roots.map((root) => {
    const body = generalBodySchema.parse(root.proposal.body),
      treatment = body.advancePayment;
    requireCondition(treatment, 'ADVANCE_SOURCE', 'Sursa avansului nu este disponibilă.', 500);
    const match = matches.find((row) => row.record.paymentId === root.record.paymentId),
      refund = refunds.find((row) => row.record.paymentId === root.record.paymentId);
    return {
      ...root,
      body,
      treatment,
      match,
      refund,
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
        }),
      ),
    };
  });
}
export type AdvancePaymentState = Awaited<ReturnType<typeof loadAdvancePayments>>[number];
export function advancePaymentView(state: AdvancePaymentState, date: string) {
  const match = state.match && state.match.date <= date ? state.match : undefined,
    refund = state.refund && state.refund.date <= date ? state.refund : undefined;
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
    remainingGross: match || refund ? '0.00' : state.treatment.gross,
    remainingControl: match || refund ? '0.00' : state.treatment.controlAmount,
    invoiceId: match?.record.invoiceId ?? null,
    refundJournalId: refund?.record.journalId ?? null,
    status: match ? ('invoiced' as const) : refund ? ('refunded' as const) : ('open' as const),
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
