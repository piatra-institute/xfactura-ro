import { and, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type { Transaction } from './db';
import { fromBani } from './domain';
import {
  accrualMatches,
  accrualPostings,
  invoicePostings,
  journalLines,
  journals,
  proposals,
} from './schema';

/** The accrual subledger spans years; the GL must carry it in the selected year's opening. */
export async function accrualControls(
  tx: Transaction,
  companyId: string,
  from: string,
  date: string,
) {
  const exactSum = (value: SQL) => sql`coalesce(sum(${value}),0)`.mapWith((value) => BigInt(value));
  const [original] = await tx
    .select({
      count: sql`count(*)`.mapWith(Number),
      gross: exactSum(
        sql`cast(replace(json_extract(${proposals.body}, '$.accrual.gross'),'.','') as integer)`,
      ),
      deferredTax: exactSum(
        sql`cast(replace(json_extract(${proposals.body}, '$.accrual.deferredTax'),'.','') as integer)`,
      ),
    })
    .from(accrualPostings)
    .innerJoin(
      proposals,
      and(
        eq(proposals.companyId, accrualPostings.companyId),
        eq(proposals.id, accrualPostings.accrualId),
      ),
    )
    .innerJoin(
      journals,
      and(
        eq(journals.companyId, accrualPostings.companyId),
        eq(journals.id, accrualPostings.journalId),
      ),
    )
    .where(and(eq(accrualPostings.companyId, companyId), lte(journals.date, date)));
  const [matched] = await tx
    .select({
      gross: exactSum(sql`${accrualMatches.grossBani}`),
      tax: exactSum(sql`${accrualMatches.deductibleTaxBani}`),
    })
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
    .where(and(eq(accrualMatches.companyId, companyId), lte(journals.date, date)));
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
        inArray(sql`substr(${journalLines.account},1,3)`, ['408', '442']),
      ),
    );
  const liability = lines
    .filter((line) => /^408(?:\.|$)/.test(line.account))
    .reduce((sum, line) => sum + line.credit - line.debit, 0n);
  const awaitingVat = lines
    .filter((line) => /^4428(?:\.|$)/.test(line.account))
    .reduce((sum, line) => sum + line.debit - line.credit, 0n);
  const unbilled = original.gross - matched.gross,
    deferred = original.deferredTax - matched.tax;
  return {
    accrualCount: original.count,
    liability: {
      ledger: fromBani(liability),
      unbilled: fromBani(unbilled),
      difference: fromBani(liability - unbilled),
    },
    vatAwaitingInvoice: {
      ledger: fromBani(awaitingVat),
      unbilled: fromBani(deferred),
      difference: fromBani(awaitingVat - deferred),
    },
    status:
      liability === unbilled && awaitingVat === deferred
        ? ('reconciled' as const)
        : ('needs_review' as const),
  };
}
