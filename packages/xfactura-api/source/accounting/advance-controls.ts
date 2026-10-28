import { and, eq, gte, lte, sql } from 'drizzle-orm';
import type { Transaction } from './db';
import { fromBani, toBani } from './domain';
import { advancePayments, advanceInvoices, journals, journalLines } from './schema';
import {
  loadAdvancePayments,
  loadAdvanceInvoices,
  advancePaymentView,
  advanceRemaining,
} from './advance-state';
export async function advanceControls(
  tx: Transaction,
  companyId: string,
  from: string,
  date: string,
) {
  const cashIds = await tx
    .select({ id: advancePayments.paymentId })
    .from(advancePayments)
    .innerJoin(
      journals,
      and(
        eq(journals.companyId, advancePayments.companyId),
        eq(journals.id, advancePayments.journalId),
      ),
    )
    .where(and(eq(advancePayments.companyId, companyId), lte(journals.date, date)));
  const invoiceIds = await tx
    .select({ id: advanceInvoices.invoiceId })
    .from(advanceInvoices)
    .innerJoin(
      journals,
      and(
        eq(journals.companyId, advanceInvoices.companyId),
        eq(journals.id, advanceInvoices.journalId),
      ),
    )
    .where(and(eq(advanceInvoices.companyId, companyId), lte(journals.date, date)));
  const payments = await loadAdvancePayments(
      tx,
      companyId,
      cashIds.map((row) => row.id),
    ),
    invoices = await loadAdvanceInvoices(
      tx,
      companyId,
      invoiceIds.map((row) => row.id),
    );
  let purchase = 0n,
    sale = 0n;
  for (const payment of payments) {
    const p = advancePaymentView(payment, date);
    if (p.direction === 'purchase') purchase += toBani(p.remainingControl);
    else sale += toBani(p.remainingControl);
  }
  for (const invoice of invoices) {
    const remaining = advanceRemaining(invoice, date);
    if (invoice.invoice.direction === 'purchase') purchase += remaining.control;
    else sale += remaining.control;
  }
  const lines = await tx
    .select({
      account: journalLines.account,
      debit: journalLines.debitBani,
      credit: journalLines.creditBani,
    })
    .from(journalLines)
    .innerJoin(
      journals,
      and(eq(journals.companyId, journalLines.companyId), eq(journals.id, journalLines.journalId)),
    )
    .where(
      and(
        eq(journalLines.companyId, companyId),
        gte(journals.date, from),
        lte(journals.date, date),
        sql`(${journalLines.account} in ('4092','419') or ${journalLines.account} like '4092.%' or ${journalLines.account} like '419.%')`,
      ),
    );
  const p = lines
      .filter((row) => /^4092(?:\.|$)/.test(row.account))
      .reduce((s, r) => s + r.debit - r.credit, 0n),
    s = lines
      .filter((row) => /^419(?:\.|$)/.test(row.account))
      .reduce((s, r) => s + r.credit - r.debit, 0n),
    control = (ledger: bigint, remaining: bigint) => ({
      ledger: fromBani(ledger),
      remaining: fromBani(remaining),
      difference: fromBani(ledger - remaining),
    });
  return {
    paymentCount: payments.length,
    invoiceCount: invoices.length,
    supplier: control(p, purchase),
    customer: control(s, sale),
    status: p === purchase && s === sale ? ('reconciled' as const) : ('needs_review' as const),
  };
}
