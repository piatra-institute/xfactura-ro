import { and, asc, eq, inArray, sql } from 'drizzle-orm';
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
  // Approved journal facts are authoritative, including while migrating older projections.
  const adjustmentRows = await tx
    .select({ proposal: proposals, journal: journals })
    .from(journals)
    .innerJoin(
      proposals,
      and(eq(proposals.companyId, journals.companyId), eq(proposals.id, journals.sourceId)),
    )
    .where(
      and(
        eq(journals.companyId, companyId),
        eq(journals.kind, 'general'),
        inArray(
          sql`json_extract(${proposals.body},'$.unbilledSaleAdjustment.unbilledSaleId')`,
          ids,
        ),
      ),
    )
    .orderBy(asc(journals.number));
  const adjustments = adjustmentRows.map((row) => {
    const treatment = generalBodySchema.parse(row.proposal.body).unbilledSaleAdjustment;
    requireCondition(
      treatment,
      'UNBILLED_SALE_SOURCE',
      'Reevaluarea nu identifică serviciile.',
      500,
    );
    return { ...row, treatment };
  });
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
    const ownAdjustments = adjustments.filter(
      (row) => row.treatment.unbilledSaleId === root.record.unbilledSaleId,
    );
    return {
      ...root,
      body,
      treatment,
      matches: ownMatches,
      adjustments: ownAdjustments,
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
          ...(ownAdjustments.length
            ? {
                adjustments: ownAdjustments.map((row) => ({
                  journalId: row.journal.id,
                  proposalHash: row.proposal.hash,
                  date: row.journal.date,
                  delta: row.treatment.delta,
                })),
              }
            : {}),
        }),
      ),
    };
  });
}
export type UnbilledSaleState = Awaited<ReturnType<typeof loadUnbilledSales>>[number];
export function unbilledSaleRemaining(state: UnbilledSaleState, date?: string) {
  const matches = state.matches.filter((row) => !date || row.date <= date);
  const effective = unbilledSaleEffective(state, date);
  return {
    net: effective.net - matches.reduce((sum, row) => sum + row.record.netBani, 0n),
    tax: effective.tax - matches.reduce((sum, row) => sum + row.record.taxBani, 0n),
    gross: effective.gross - matches.reduce((sum, row) => sum + row.record.grossBani, 0n),
  };
}
export function unbilledSaleEffective(state: UnbilledSaleState, date?: string) {
  const adjustments = state.adjustments.filter((row) => !date || row.journal.date <= date);
  const value = (key: 'net' | 'tax' | 'gross') =>
    toBani(state.treatment[key]) +
    adjustments.reduce((sum, row) => sum + toBani(row.treatment.delta[key]), 0n);
  return { net: value('net'), tax: value('tax'), gross: value('gross') };
}
export function unbilledSaleView(state: UnbilledSaleState, date: string) {
  const remaining = unbilledSaleRemaining(state, date);
  const effective = unbilledSaleEffective(state, date),
    adjustments = state.adjustments.filter((row) => row.journal.date <= date);
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
    ...(state.treatment.measurementBasis
      ? { measurementBasis: state.treatment.measurementBasis }
      : {}),
    adjustedNet: fromBani(effective.net),
    adjustedTax: fromBani(effective.tax),
    adjustedGross: fromBani(effective.gross),
    adjustmentCount: adjustments.length,
    remainingNet: fromBani(remaining.net),
    remainingTax: fromBani(remaining.tax),
    remainingGross: fromBani(remaining.gross),
    matchedGross: fromBani(effective.gross - remaining.gross),
    status:
      remaining.gross === 0n
        ? adjustments.at(-1)?.treatment.action === 'release'
          ? ('released' as const)
          : ('matched' as const)
        : ('open' as const),
    hash: state.hash,
  };
}
