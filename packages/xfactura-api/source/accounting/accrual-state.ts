import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Transaction } from './db';
import { canonical, fromBani, generalBodySchema, requireCondition, toBani } from './domain';
import { accrualMatches, accrualPostings, invoicePostings, journals, proposals } from './schema';
import { sha256 } from './object-store';

export async function loadAccruals(tx: Transaction, companyId: string, ids: string[]) {
  if (!ids.length) return [];
  const roots = await tx
    .select({ record: accrualPostings, journal: journals, proposal: proposals })
    .from(accrualPostings)
    .innerJoin(
      journals,
      and(
        eq(journals.companyId, accrualPostings.companyId),
        eq(journals.id, accrualPostings.journalId),
      ),
    )
    .innerJoin(
      proposals,
      and(
        eq(proposals.companyId, accrualPostings.companyId),
        eq(proposals.id, accrualPostings.accrualId),
      ),
    )
    .where(and(eq(accrualPostings.companyId, companyId), inArray(accrualPostings.accrualId, ids)));
  const matches = await tx
    .select({ record: accrualMatches, date: journals.date, journalId: journals.id })
    .from(accrualMatches)
    .innerJoin(
      invoicePostings,
      and(
        eq(invoicePostings.companyId, accrualMatches.companyId),
        eq(invoicePostings.invoiceId, accrualMatches.invoiceId),
      ),
    )
    .innerJoin(
      journals,
      and(
        eq(journals.companyId, invoicePostings.companyId),
        eq(journals.id, invoicePostings.journalId),
      ),
    )
    .where(and(eq(accrualMatches.companyId, companyId), inArray(accrualMatches.accrualId, ids)))
    .orderBy(asc(journals.date), asc(accrualMatches.invoiceId));
  // Approved journal facts are authoritative; the adjustment table is a guarded projection.
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
        inArray(sql`json_extract(${proposals.body}, '$.accrualAdjustment.accrualId')`, ids),
      ),
    )
    .orderBy(asc(journals.number));
  const adjustments = adjustmentRows.map((row) => {
    const treatment = generalBodySchema.parse(row.proposal.body).accrualAdjustment;
    requireCondition(treatment, 'ACCRUAL_SOURCE', 'Ajustarea nu identifică angajamentul.', 500);
    return { ...row, treatment };
  });
  return roots.map((root) => {
    const body = generalBodySchema.parse(root.proposal.body),
      treatment = body.accrual;
    requireCondition(
      treatment,
      'ACCRUAL_SOURCE',
      'Înregistrarea nu are un angajament identificat.',
      500,
    );
    const ownMatches = matches.filter((row) => row.record.accrualId === root.record.accrualId);
    const ownAdjustments = adjustments.filter(
      (row) => row.treatment.accrualId === root.record.accrualId,
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
            deductibleTax: record.deductibleTaxBani.toString(),
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
export type AccrualState = Awaited<ReturnType<typeof loadAccruals>>[number];

export function accrualRemaining(state: AccrualState, date?: string) {
  const matches = state.matches.filter((row) => !date || row.date <= date);
  const effective = accrualEffective(state, date);
  return {
    net: effective.net - matches.reduce((sum, row) => sum + row.record.netBani, 0n),
    tax: effective.tax - matches.reduce((sum, row) => sum + row.record.taxBani, 0n),
    gross: effective.gross - matches.reduce((sum, row) => sum + row.record.grossBani, 0n),
    deferredTax:
      effective.deferredTax - matches.reduce((sum, row) => sum + row.record.deductibleTaxBani, 0n),
  };
}
export function accrualEffective(state: AccrualState, date?: string) {
  const adjustments = state.adjustments.filter((row) => !date || row.journal.date <= date);
  const value = (field: 'net' | 'tax' | 'gross' | 'deferredTax') =>
    toBani(state.treatment[field]) +
    adjustments.reduce((sum, row) => sum + toBani(row.treatment.delta[field]), 0n);
  return {
    net: value('net'),
    tax: value('tax'),
    gross: value('gross'),
    deferredTax: value('deferredTax'),
  };
}
export function accrualView(state: AccrualState, date: string) {
  const remaining = accrualRemaining(state, date);
  const effective = accrualEffective(state, date),
    adjustments = state.adjustments.filter((row) => row.journal.date <= date);
  return {
    id: state.record.accrualId,
    reference: state.treatment.reference,
    date: state.journal.date,
    financialYearId: state.body.financialYearId,
    journalId: state.journal.id,
    evidenceId: state.treatment.evidenceId,
    supplier: state.treatment.supplier,
    serviceFrom: state.treatment.serviceFrom,
    serviceTo: state.treatment.serviceTo,
    net: state.treatment.net,
    tax: state.treatment.tax,
    gross: state.treatment.gross,
    deferredTax: state.treatment.deferredTax,
    adjustedNet: fromBani(effective.net),
    adjustedTax: fromBani(effective.tax),
    adjustedGross: fromBani(effective.gross),
    adjustedDeferredTax: fromBani(effective.deferredTax),
    adjustmentCount: adjustments.length,
    remainingNet: fromBani(remaining.net),
    remainingTax: fromBani(remaining.tax),
    remainingGross: fromBani(remaining.gross),
    remainingDeferredTax: fromBani(remaining.deferredTax),
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
