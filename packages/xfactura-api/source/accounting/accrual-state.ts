import { and, asc, eq, inArray } from 'drizzle-orm';
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
            deductibleTax: record.deductibleTaxBani.toString(),
          })),
        }),
      ),
    };
  });
}
export type AccrualState = Awaited<ReturnType<typeof loadAccruals>>[number];

export function accrualRemaining(state: AccrualState, date?: string) {
  const matches = state.matches.filter((row) => !date || row.date <= date);
  return {
    net: toBani(state.treatment.net) - matches.reduce((sum, row) => sum + row.record.netBani, 0n),
    tax: toBani(state.treatment.tax) - matches.reduce((sum, row) => sum + row.record.taxBani, 0n),
    gross:
      toBani(state.treatment.gross) - matches.reduce((sum, row) => sum + row.record.grossBani, 0n),
    deferredTax:
      toBani(state.treatment.deferredTax) -
      matches.reduce((sum, row) => sum + row.record.deductibleTaxBani, 0n),
  };
}
export function accrualView(state: AccrualState, date: string) {
  const remaining = accrualRemaining(state, date);
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
    remainingNet: fromBani(remaining.net),
    remainingTax: fromBani(remaining.tax),
    remainingGross: fromBani(remaining.gross),
    remainingDeferredTax: fromBani(remaining.deferredTax),
    matchedGross: fromBani(toBani(state.treatment.gross) - remaining.gross),
    status: remaining.gross === 0n ? ('matched' as const) : ('open' as const),
    hash: state.hash,
  };
}
