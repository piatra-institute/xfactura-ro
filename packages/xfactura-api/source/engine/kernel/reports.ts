import { and, asc, eq, gt, gte, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { formatMoney } from 'xfactura-core/money';
import { entries, fiscalYears, ledgerAccounts, lines } from '../db/schema';
import type { Actor, Commands } from './commands';
import { lineSpec } from './state';

const ron = (bani: bigint) => formatMoney(bani, 'RON');
const day = z.iso.date();
const pair = z.object({ debit: z.string(), credit: z.string() });

export const trialBalanceInput = z
  .object({ financialYearId: z.uuid(), from: day.optional(), to: day.optional() })
  .strict();
export const trialBalanceView = z.object({
  year: z.object({ id: z.string(), from: z.string(), to: z.string() }),
  from: z.string(),
  to: z.string(),
  rows: z.array(
    z.object({
      account: z.string(),
      name: z.string(),
      opening: pair,
      previous: pair,
      current: pair,
      total: pair,
      closing: pair,
    }),
  ),
  totals: z.object({ opening: pair, previous: pair, current: pair, total: pair, closing: pair }),
});

export const journalInput = z
  .object({
    from: day,
    to: day,
    after: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(500).default(100),
  })
  .strict();

/** A balance as Romanian registers show it: on the debit or the credit side. */
const sides = (net: bigint) => ({
  debit: ron(net > 0n ? net : 0n),
  credit: ron(net < 0n ? -net : 0n),
});

export class Reports {
  constructor(private readonly commands: Commands) {}

  /**
   * Balanța de verificare: opening balance at the start of the financial year, turnover before
   * the period, turnover in the period, cumulative totals and closing balance per account.
   */
  trialBalance(actor: Actor, input: z.infer<typeof trialBalanceInput>) {
    return this.commands.read(actor, 'ledger.trialBalance', async (tx) => {
      const [year] = await tx
        .select()
        .from(fiscalYears)
        .where(
          and(
            eq(fiscalYears.companyId, actor.companyId),
            eq(fiscalYears.id, input.financialYearId),
            eq(fiscalYears.kind, 'financial'),
          ),
        );
      requireCondition(year, 'NOT_FOUND', 'Exercițiul financiar nu este disponibil.', 404);
      const from = input.from ?? year.from;
      const to = input.to ?? year.to;
      requireCondition(
        year.from <= from && from <= to && to <= year.to,
        'PERIOD',
        'Intervalul trebuie să fie în exercițiul financiar.',
      );
      const amount = (condition: ReturnType<typeof sql>, side?: 'D' | 'C') =>
        sql<bigint>`coalesce(sum(case when ${condition}${side ? sql` and ${lines.side} = ${side}` : sql``} then ${
          side
            ? lines.bani
            : sql`case ${lines.side} when 'D' then ${lines.bani} else -${lines.bani} end`
        } else 0 end), 0)`.mapWith(BigInt);
      // Opening entries dated on the first day of the year are the initial balance, not turnover.
      const opening = sql`(${entries.journalCode} = 'DESCHIDERE' and ${entries.date} = ${year.from})`;
      const before = sql`(${entries.date} < ${year.from} or ${opening})`;
      const previous = sql`${entries.date} >= ${year.from} and ${entries.date} < ${from} and not ${opening}`;
      const current = sql`${entries.date} >= ${from} and ${entries.date} <= ${to} and not ${opening}`;
      const rows = await tx
        .select({
          account: lines.account,
          name: ledgerAccounts.name,
          opening: amount(before),
          previousDebit: amount(previous, 'D'),
          previousCredit: amount(previous, 'C'),
          currentDebit: amount(current, 'D'),
          currentCredit: amount(current, 'C'),
        })
        .from(lines)
        .innerJoin(
          entries,
          and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId)),
        )
        .innerJoin(
          ledgerAccounts,
          and(
            eq(ledgerAccounts.companyId, lines.companyId),
            eq(ledgerAccounts.code, lines.account),
          ),
        )
        .where(and(eq(lines.companyId, actor.companyId), lte(entries.date, to)))
        .groupBy(lines.account)
        .orderBy(asc(lines.account));
      const totals = {
        opening: 0n,
        previousD: 0n,
        previousC: 0n,
        currentD: 0n,
        currentC: 0n,
        openingD: 0n,
        openingC: 0n,
        closingD: 0n,
        closingC: 0n,
      };
      const view = rows.map((row) => {
        const closing =
          row.opening +
          row.previousDebit -
          row.previousCredit +
          row.currentDebit -
          row.currentCredit;
        const opening = sides(row.opening);
        totals.openingD += row.opening > 0n ? row.opening : 0n;
        totals.openingC += row.opening < 0n ? -row.opening : 0n;
        totals.previousD += row.previousDebit;
        totals.previousC += row.previousCredit;
        totals.currentD += row.currentDebit;
        totals.currentC += row.currentCredit;
        totals.closingD += closing > 0n ? closing : 0n;
        totals.closingC += closing < 0n ? -closing : 0n;
        return {
          account: row.account,
          name: row.name,
          opening,
          previous: { debit: ron(row.previousDebit), credit: ron(row.previousCredit) },
          current: { debit: ron(row.currentDebit), credit: ron(row.currentCredit) },
          total: {
            debit: ron(
              (row.opening > 0n ? row.opening : 0n) + row.previousDebit + row.currentDebit,
            ),
            credit: ron(
              (row.opening < 0n ? -row.opening : 0n) + row.previousCredit + row.currentCredit,
            ),
          },
          closing: sides(closing),
        };
      });
      return {
        year: { id: year.id, from: year.from, to: year.to },
        from,
        to,
        rows: view,
        totals: {
          opening: { debit: ron(totals.openingD), credit: ron(totals.openingC) },
          previous: { debit: ron(totals.previousD), credit: ron(totals.previousC) },
          current: { debit: ron(totals.currentD), credit: ron(totals.currentC) },
          total: {
            debit: ron(totals.openingD + totals.previousD + totals.currentD),
            credit: ron(totals.openingC + totals.previousC + totals.currentC),
          },
          closing: { debit: ron(totals.closingD), credit: ron(totals.closingC) },
        },
      };
    });
  }

  /** Registrul-jurnal: entries in recording order, with their lines. */
  journal(actor: Actor, input: z.infer<typeof journalInput>) {
    return this.commands.read(actor, 'ledger.journal', async (tx) => {
      const headers = await tx
        .select()
        .from(entries)
        .where(
          and(
            eq(entries.companyId, actor.companyId),
            gte(entries.date, input.from),
            lte(entries.date, input.to),
            gt(entries.seq, input.after),
          ),
        )
        .orderBy(asc(entries.seq))
        .limit(input.limit + 1);
      const page = headers.slice(0, input.limit);
      const rows = page.length
        ? await tx
            .select()
            .from(lines)
            .where(
              and(
                eq(lines.companyId, actor.companyId),
                inArray(
                  lines.entryId,
                  page.map((entry) => entry.id),
                ),
              ),
            )
            .orderBy(asc(lines.entryId), asc(lines.lineNo))
        : [];
      return {
        entries: page.map((entry) => ({
          id: entry.id,
          number: entry.number,
          seq: entry.seq,
          date: entry.date,
          journalCode: entry.journalCode,
          description: entry.description,
          proposalId: entry.proposalId,
          binding: entry.approvalId ? ('approval' as const) : ('policy' as const),
          lines: rows
            .filter((row) => row.entryId === entry.id)
            .map((row) => {
              const { bani, currency, ...line } = lineSpec(row);
              return {
                ...line,
                amount: ron(bani),
                ...(currency
                  ? {
                      currency: {
                        code: currency.code,
                        amount: formatMoney(currency.minor, currency.code),
                        rate: currency.rate,
                      },
                    }
                  : {}),
              };
            }),
        })),
        next: headers.length > input.limit ? page.at(-1)!.seq : null,
      };
    });
  }
}
