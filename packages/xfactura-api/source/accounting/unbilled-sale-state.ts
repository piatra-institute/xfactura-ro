import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Transaction } from './db';
import { canonical, fromBani, generalBodySchema, requireCondition, toBani } from './domain';
import {
  invoicePostings,
  journals,
  proposals,
  unbilledSaleMatches,
  unbilledSalePostings,
} from './schema';
import { sha256 } from './object-store';

export async function loadUnbilledSales(tx: Transaction, companyId: string, ids: string[]) {
  if (!ids.length) return [];
  const roots = await tx
    .select({ record: unbilledSalePostings, journal: journals, proposal: proposals })
    .from(unbilledSalePostings)
    .innerJoin(
      journals,
      and(
        eq(journals.companyId, unbilledSalePostings.companyId),
        eq(journals.id, unbilledSalePostings.journalId),
      ),
    )
    .innerJoin(
      proposals,
      and(
        eq(proposals.companyId, unbilledSalePostings.companyId),
        eq(proposals.id, unbilledSalePostings.unbilledSaleId),
      ),
    )
    .where(
      and(
        eq(unbilledSalePostings.companyId, companyId),
        inArray(unbilledSalePostings.unbilledSaleId, ids),
      ),
    );
  const matches = await tx
    .select({ record: unbilledSaleMatches, date: journals.date, journalId: journals.id })
    .from(unbilledSaleMatches)
    .innerJoin(
      invoicePostings,
      and(
        eq(invoicePostings.companyId, unbilledSaleMatches.companyId),
        eq(invoicePostings.invoiceId, unbilledSaleMatches.invoiceId),
      ),
    )
    .innerJoin(
      journals,
      and(
        eq(journals.companyId, invoicePostings.companyId),
        eq(journals.id, invoicePostings.journalId),
      ),
    )
    .where(
      and(
        eq(unbilledSaleMatches.companyId, companyId),
        inArray(unbilledSaleMatches.unbilledSaleId, ids),
      ),
    )
    .orderBy(asc(journals.date), asc(unbilledSaleMatches.invoiceId));
  return roots.map((root) => {
    const body = generalBodySchema.parse(root.proposal.body),
      treatment = body.unbilledSale;
    requireCondition(
      treatment,
      'UNBILLED_SALE_SOURCE',
      'Înregistrarea nu identifică servicii de facturat.',
      500,
    );
    const ownMatches = matches.filter(
      (row) => row.record.unbilledSaleId === root.record.unbilledSaleId,
    );
    return {
      ...root,
      body,
      treatment,
      matches: ownMatches,
      hash: sha256(
        canonical({
          proposalHash: root.proposal.hash,
          journalId: root.journal.id,
          matches: ownMatches.map(({ record, ...row }) => ({
            ...row,
            invoiceId: record.invoiceId,
            net: record.netBani.toString(),
            tax: record.taxBani.toString(),
            gross: record.grossBani.toString(),
          })),
        }),
      ),
    };
  });
}
export type UnbilledSaleState = Awaited<ReturnType<typeof loadUnbilledSales>>[number];
export function unbilledSaleRemaining(state: UnbilledSaleState, date?: string) {
  const matches = state.matches.filter((row) => !date || row.date <= date);
  return {
    net: toBani(state.treatment.net) - matches.reduce((sum, row) => sum + row.record.netBani, 0n),
    tax: toBani(state.treatment.tax) - matches.reduce((sum, row) => sum + row.record.taxBani, 0n),
    gross:
      toBani(state.treatment.gross) - matches.reduce((sum, row) => sum + row.record.grossBani, 0n),
  };
}
export function unbilledSaleView(state: UnbilledSaleState, date: string) {
  const remaining = unbilledSaleRemaining(state, date);
  return {
    id: state.record.unbilledSaleId,
    reference: state.treatment.reference,
    date: state.journal.date,
    financialYearId: state.body.financialYearId,
    journalId: state.journal.id,
    evidenceId: state.treatment.evidenceId,
    customer: state.treatment.customer,
    serviceFrom: state.treatment.serviceFrom,
    serviceTo: state.treatment.serviceTo,
    taxPointDate: state.treatment.taxPointDate,
    net: state.treatment.net,
    tax: state.treatment.tax,
    gross: state.treatment.gross,
    remainingNet: fromBani(remaining.net),
    remainingTax: fromBani(remaining.tax),
    remainingGross: fromBani(remaining.gross),
    matchedGross: fromBani(toBani(state.treatment.gross) - remaining.gross),
    status: remaining.gross === 0n ? ('matched' as const) : ('open' as const),
    hash: state.hash,
  };
}
