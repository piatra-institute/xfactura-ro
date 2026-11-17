import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { LEDGER_CURRENCY } from 'xfactura-core/money';
import { RuleGapError, type RuleContext } from 'xfactura-core/rules';
import { bucharestDate, type LocalDate } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import { entries, ledgerAccounts, lines, openItems, treasuryAccounts } from '../db/schema';
import type { Actor, Commands } from '../kernel/commands';
import { linesUnder } from '../kernel/ledger';
import { loadOpenItems } from '../kernel/state';
import { worklistRange, type Work } from '../kernel/work';
import { d112WithoutHealth, obligationsCalendar } from './obligations';
import { taxPosition } from './taxaccount';

/*
 * The company at a glance (`company.summary`), every amount the engine's: the money in each bank
 * and cash account, what customers owe and what is owed to suppliers, the position towards the
 * state, the work waiting and the next returns due. Amounts are minor units (bani for lei) as
 * integer strings, each with its currency; nothing is summed across currencies.
 */

const minor = z.string().regex(/^-?\d+$/);
const money = z.object({ minor, currency: z.string() });

export const summaryInput = z
  .object({
    /** The day the amounts are read on; the engine's today in Bucharest by default. */
    date: z.iso.date().optional(),
  })
  .strict();

const openSide = z.object({
  /** How many open items. */
  count: z.number(),
  /** Per currency of the items: their balance, how many, and the part past its due date. */
  currencies: z.array(
    z.object({
      currency: z.string(),
      total: minor,
      count: z.number(),
      overdue: minor,
      overdueCount: z.number(),
    }),
  ),
  /**
   * A balance of the class the open items cannot show: an account of it without open-item
   * control (4118 after a receivable was moved there, 403, 413) holding one on the day, in lei,
   * positive as the side's items are; null when there is none. The side's totals leave it out.
   */
  unrepresented: z
    .object({
      code: z.literal('UNSUPPORTED'),
      accounts: z.array(z.object({ account: z.string(), balance: money })),
    })
    .nullable(),
});

export const summaryView = z.object({
  date: z.string(),
  cash: z.object({
    accounts: z.array(
      z.object({
        id: z.string(),
        kind: z.enum(['bank', 'cash']),
        name: z.string(),
        ledgerAccount: z.string(),
        currency: z.string(),
        /** In the account's currency. */
        balance: money,
        /** In lei, as the ledger carries it (for a foreign currency, at the rates booked). */
        ledgerBalance: money,
      }),
    ),
    /** Per currency of the accounts, each in its own currency. */
    totals: z.array(money),
  }),
  /** Customers' open items (classes 411 and 418), positive when they owe. */
  receivables: openSide,
  /** Suppliers' open items (classes 401, 404 and 408), positive when the company owes. */
  payables: openSide,
  /** The position towards the state (`taxaccount.position`), in lei; null with `taxReason` when
   * a rule it reads is missing. */
  tax: z
    .object({
      /** Owed to the state on obligations, and the part past its due date. */
      owed: money,
      overdue: money,
      /** Owed by the state: refunds and payments not yet distributed. */
      claims: money,
      /** Owed less claims: positive when the company owes. */
      net: money,
      obligations: z.number(),
    })
    .nullable(),
  taxReason: z
    .object({ code: z.literal('RULE_GAP'), message: z.string(), details: z.unknown() })
    .nullable(),
  /** The worklist now, as `work.list` lists it to the caller, whatever the date. */
  work: z.object({
    total: z.number(),
    /** Who acts, as the interface groups the items: a step a person may take (the caller), else
     * one an agent may, else neither. */
    by: z.object({ person: z.number(), agent: z.number(), neither: z.number() }),
    severity: z.object({ block: z.number(), warn: z.number(), info: z.number() }),
    /** False when the count stopped at the page-time limit: the counts are those of the items
     * before `next`, the `work.list` cursor the rest is listed from. */
    complete: z.boolean(),
    next: z.string().nullable(),
    asOfSeq: z.number(),
  }),
  /** The next five returns not yet filed, by due date (overdue ones first), as
   * `obligations.calendar` shows them. */
  deadlines: z.array(
    z.object({
      kind: z.string(),
      period: z.string(),
      deadline: z.string(),
      due: z.string().nullable(),
      status: z.string(),
      artifactId: z.string().nullable(),
    }),
  ),
});

/** What a summary may spend on counting the worklist, from its start: within a worklist page's
 * time limit with the rest of it. */
const workBudget = 200;

const sideOf = (
  items: { currency: string; balance: bigint; dueDate: string | null }[],
  date: string,
) => {
  const byCurrency = new Map<
    string,
    { total: bigint; count: number; overdue: bigint; overdueCount: number }
  >();
  for (const item of items) {
    const sum = byCurrency.get(item.currency) ?? {
      total: 0n,
      count: 0,
      overdue: 0n,
      overdueCount: 0,
    };
    sum.total += item.balance;
    sum.count++;
    if (item.dueDate !== null && item.dueDate < date) {
      sum.overdue += item.balance;
      sum.overdueCount++;
    }
    byCurrency.set(item.currency, sum);
  }
  return {
    count: items.length,
    currencies: [...byCurrency]
      .sort(([a], [b]) => (a === LEDGER_CURRENCY ? -1 : b === LEDGER_CURRENCY ? 1 : a < b ? -1 : 1))
      .map(([currency, sum]) => ({
        currency,
        total: sum.total.toString(),
        count: sum.count,
        overdue: sum.overdue.toString(),
        overdueCount: sum.overdueCount,
      })),
  };
};

const lei = (bani: bigint) => ({ minor: bani.toString(), currency: LEDGER_CURRENCY });

export async function companySummary(
  deps: {
    commands: Commands;
    work: Work;
    rules: (tx: Transaction, companyId: string) => Promise<RuleContext>;
    clock: () => number;
  },
  actor: Actor,
  input: z.infer<typeof summaryInput>,
): Promise<z.infer<typeof summaryView>> {
  const started = performance.now();
  const today = bucharestDate(deps.clock());
  const date = (input.date ?? today) as LocalDate;
  return deps.commands.read(actor, 'company.summary', async (tx, access) => {
    const rules = await deps.rules(tx, actor.companyId);

    // Each treasury account's ledger account on the day: lei, and its own currency's amounts.
    const treasury = await tx
      .select()
      .from(treasuryAccounts)
      .where(eq(treasuryAccounts.companyId, actor.companyId))
      .orderBy(asc(treasuryAccounts.ledgerAccount));
    const sign = sql`case ${lines.side} when 'D' then 1 else -1 end`;
    const balances = treasury.length
      ? await tx
          .select({
            account: lines.account,
            bani: sql<bigint>`coalesce(sum(${sign} * ${lines.bani}), 0)`.mapWith(BigInt),
            minor:
              sql<bigint>`coalesce(sum(case when ${lines.currency} = ${treasuryAccounts.currency}
              then ${sign} * ${lines.currencyMinor} else 0 end), 0)`.mapWith(BigInt),
          })
          .from(lines)
          .innerJoin(
            entries,
            and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId)),
          )
          .innerJoin(
            treasuryAccounts,
            and(
              eq(treasuryAccounts.companyId, lines.companyId),
              eq(treasuryAccounts.ledgerAccount, lines.account),
            ),
          )
          .where(
            and(
              eq(lines.companyId, actor.companyId),
              inArray(
                lines.account,
                treasury.map((account) => account.ledgerAccount),
              ),
              lte(entries.date, date),
            ),
          )
          .groupBy(lines.account)
      : [];
    const cashAccounts = treasury.map((account) => {
      const found = balances.find((row) => row.account === account.ledgerAccount);
      const bani = found?.bani ?? 0n;
      const own = account.currency === LEDGER_CURRENCY ? bani : (found?.minor ?? 0n);
      return {
        id: account.id,
        kind: account.kind,
        name: account.name,
        ledgerAccount: account.ledgerAccount,
        currency: account.currency,
        balance: { minor: own, currency: account.currency },
        ledgerBalance: lei(bani),
      };
    });
    const cashTotals = new Map<string, bigint>();
    for (const account of cashAccounts)
      cashTotals.set(
        account.currency,
        (cashTotals.get(account.currency) ?? 0n) + account.balance.minor,
      );

    // Customers' and suppliers' open items on the day, as `openItems.list` reads them.
    const open = (
      await loadOpenItems(
        tx,
        actor.companyId,
        [
          inArray(openItems.kind, [
            'receivable',
            'accrual.receivable',
            'payable',
            'accrual.payable',
          ]),
        ],
        date,
      )
    ).filter((item) => item.balanceBani !== 0n || item.balanceMinor !== 0n);
    // What the classes hold on the day on accounts without open-item control: not shown by
    // items, so stated as unsupported rather than left out silently.
    const uncontrolled = await tx
      .select({
        account: lines.account,
        bani: sql<bigint>`coalesce(sum(${sign} * ${lines.bani}), 0)`.mapWith(BigInt),
      })
      .from(lines)
      .innerJoin(
        entries,
        and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId)),
      )
      .innerJoin(
        ledgerAccounts,
        and(eq(ledgerAccounts.companyId, lines.companyId), eq(ledgerAccounts.code, lines.account)),
      )
      .where(
        and(
          linesUnder(actor.companyId, ['40', '41']),
          isNull(ledgerAccounts.controlKind),
          lte(entries.date, date),
        ),
      )
      .groupBy(lines.account)
      .orderBy(asc(lines.account));
    const side = (classPrefix: string, direction: 1n | -1n) => {
      const accounts = uncontrolled
        .filter((row) => row.account.startsWith(classPrefix) && row.bani !== 0n)
        .map((row) => ({ account: row.account, balance: lei(direction * row.bani) }));
      return {
        ...sideOf(
          open
            .filter((item) => item.controlAccount.startsWith(classPrefix))
            .map((item) => ({
              currency: item.currency,
              balance: direction * item.balanceMinor,
              dueDate: item.dueDate,
            })),
          date,
        ),
        unrepresented: accounts.length ? { code: 'UNSUPPORTED' as const, accounts } : null,
      };
    };

    // The position towards the state, unless a rule it reads is missing.
    let tax: z.infer<typeof summaryView>['tax'] = null;
    let taxReason: z.infer<typeof summaryView>['taxReason'] = null;
    try {
      const rows = await taxPosition(tx, actor.companyId, date, rules);
      const owed = rows.filter((row) => !row.claim).reduce((sum, row) => sum + row.bani, 0n);
      const claims = rows.filter((row) => row.claim).reduce((sum, row) => sum + row.bani, 0n);
      const overdue = rows
        .filter((row) => !row.claim && row.due !== null && row.due < date)
        .reduce((sum, row) => sum + row.bani, 0n);
      tax = {
        owed: lei(owed),
        overdue: lei(overdue),
        claims: lei(claims),
        net: lei(owed - claims),
        obligations: rows.filter((row) => !row.claim).length,
      };
    } catch (error) {
      if (!(error instanceof RuleGapError)) throw error;
      taxReason = { code: 'RULE_GAP', message: error.message, details: { ...error.gap } };
    }

    // The next returns: over the worklist's months, so that it reads the same closure.
    const range = await worklistRange(tx, actor.companyId, date);
    const health = (await deps.commands.disclosable(tx, actor, access.role))(['health']);
    const calendar = await obligationsCalendar(tx, actor.companyId, range, rules, date);
    const deadlines = calendar
      .filter((item) => !['filed', 'accepted'].includes(item.status))
      .map((item) => (health ? item : d112WithoutHealth(item)))
      .sort((a, b) => {
        const key = (item: typeof a) => [
          item.due ?? '9999-12-31',
          item.end,
          item.kind,
          item.period,
        ];
        const [x, y] = [key(a), key(b)];
        for (let index = 0; index < x.length; index++)
          if (x[index] !== y[index]) return x[index]! < y[index]! ? -1 : 1;
        return 0;
      })
      .slice(0, 5)
      .map((item) => ({
        kind: item.kind,
        period: item.period,
        deadline: item.deadline,
        due: item.due,
        status: item.status,
        artifactId: item.artifactId,
      }));

    const work = await deps.work.tally(tx, actor, access.role, started + workBudget);
    return {
      date,
      cash: {
        accounts: cashAccounts.map((account) => ({
          ...account,
          balance: { minor: account.balance.minor.toString(), currency: account.currency },
        })),
        totals: [...cashTotals]
          .sort(([a], [b]) =>
            a === LEDGER_CURRENCY ? -1 : b === LEDGER_CURRENCY ? 1 : a < b ? -1 : 1,
          )
          .map(([currency, total]) => ({ minor: total.toString(), currency })),
      },
      receivables: side('41', 1n),
      payables: side('40', -1n),
      tax,
      taxReason,
      work,
      deadlines,
    };
  });
}
