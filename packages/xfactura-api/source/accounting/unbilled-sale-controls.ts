import { and, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import type { Transaction } from './db';
import { fromBani } from './domain';
import {
  invoicePostings,
  journalLines,
  journals,
  proposals,
  unbilledSaleMatches,
  unbilledSalePostings,
  unbilledSaleAdjustments,
} from './schema';

/** Positions span years; each selected financial year must carry its opening 418 balance. */
export async function unbilledSaleControls(
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
        sql`cast(replace(json_extract(${proposals.body}, '$.unbilledSale.gross'),'.','') as integer)`,
      ),
    })
    .from(unbilledSalePostings)
    .innerJoin(
      proposals,
      and(
        eq(proposals.companyId, unbilledSalePostings.companyId),
        eq(proposals.id, unbilledSalePostings.unbilledSaleId),
      ),
    )
    .innerJoin(
      journals,
      and(
        eq(journals.companyId, unbilledSalePostings.companyId),
        eq(journals.id, unbilledSalePostings.journalId),
      ),
    )
    .where(and(eq(unbilledSalePostings.companyId, companyId), lte(journals.date, date)));
  const [matched] = await tx
    .select({ gross: exactSum(sql`${unbilledSaleMatches.grossBani}`) })
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
    .where(and(eq(unbilledSaleMatches.companyId, companyId), lte(journals.date, date)));
  const [control] = await tx
    .select({ balance: exactSum(sql`${journalLines.debitBani}-${journalLines.creditBani}`) })
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
        sql`(${journalLines.account}='418' or ${journalLines.account} like '418.%')`,
      ),
    );
  const [adjusted] = await tx
    .select({ gross: exactSum(sql`${unbilledSaleAdjustments.grossBani}`) })
    .from(unbilledSaleAdjustments)
    .innerJoin(
      journals,
      and(
        eq(journals.companyId, unbilledSaleAdjustments.companyId),
        eq(journals.id, unbilledSaleAdjustments.journalId),
      ),
    )
    .where(and(eq(unbilledSaleAdjustments.companyId, companyId), lte(journals.date, date)));
  const unbilled = original.gross + adjusted.gross - matched.gross;
  return {
    unbilledSaleCount: original.count,
    receivable: {
      ledger: fromBani(control.balance),
      unbilled: fromBani(unbilled),
      difference: fromBani(control.balance - unbilled),
    },
    status: control.balance === unbilled ? ('reconciled' as const) : ('needs_review' as const),
  };
}
