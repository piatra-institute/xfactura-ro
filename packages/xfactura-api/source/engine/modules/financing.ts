import { z } from 'zod';
import type { OpenItemState } from 'xfactura-core/kernel';
import { formatMoney } from 'xfactura-core/money';
import { booksSystemOf } from 'xfactura-core/ro/entity';
import {
  currentPortion,
  interestRows,
  isLeaseMethod,
  loanAccounts,
  owed,
  principalDue,
  principalRows,
} from 'xfactura-core/ro/financing';
import { accrualReads, interestDue, isLoan } from 'xfactura-core/ro/treatments/loans';
import { monthEnd, type LocalDate, type Month } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import type { Actor, Commands } from '../kernel/commands';
import type { CloseCheck } from '../kernel/periods';
import { loadState } from '../kernel/state';

export const loansInput = z
  .object({
    /** The day the loans are shown at: what they owe, and the part due within twelve months. */
    at: z.iso.date(),
  })
  .strict();

/** Every loan with its schedule, as the books hold them (the accrual's own read). */
async function loans(tx: Transaction, companyId: string) {
  const { loaded } = await loadState(tx, companyId, accrualReads);
  const items = [...loaded.openItems.values()]
    .filter((item) => isLoan(item) && item.schedule)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return { loaded, items };
}

const synthetic = (item: OpenItemState) => item.controlAccount.split('.')[0]!;

/** What a loan's schedule had to repay by a day and the loan has not repaid yet. */
function unpaid(item: OpenItemState, through: LocalDate) {
  const rows = item.schedule!.rows;
  const total = principalRows(rows, item.controlAccount).reduce((sum, row) => sum + row.bani, 0n);
  const repaid = total - owed(item);
  const due = principalDue(rows, item.controlAccount, through) - repaid;
  return due > 0n ? due : 0n;
}

/**
 * Month-close findings for loans and leases:
 * - interest a loan's schedule has accrued by the month's end and not booked (`loans.accrue`)
 *   blocks the close, as accrual accounting requires (OMFP 1802/2014 pct. 215 alin. (2) for
 *   leases, the functions of accounts 168, 519 and 455 for loans); single-entry books recognize
 *   interest when paid;
 * - a finance lease's principal due by then and not yet invoiced by the lessor, and a loan's
 *   repayment due and not made, are warnings: the invoice may come later, and a credit unpaid at
 *   maturity is the bank's to declare overdue (1622, 5192), which the engine does not book yet.
 */
export const financingChecks: CloseCheck[] = [
  {
    id: 'loans.interest',
    async run(tx, companyId, month) {
      const { loaded } = await loadState(tx, companyId, accrualReads);
      const end = monthEnd(month as Month);
      if (booksSystemOf(loaded.profile, end) === 'single') return [];
      const due = interestDue(loaded, end).filter((loan) => loan.due !== 0n);
      return due.length
        ? [
            {
              code: 'LOAN_INTEREST_DUE',
              severity: 'block' as const,
              message: `${due.length} împrumuturi au dobândă de înregistrat până la ${end} (${due.map((loan) => `${formatMoney(loan.due, loan.item.currency)} ${loan.item.currency}`).join(', ')}; loans.accrue).`,
              count: due.length,
            },
          ]
        : [];
    },
  },
  {
    id: 'loans.repayments',
    async run(tx, companyId, month) {
      const { items } = await loans(tx, companyId);
      const end = monthEnd(month as Month);
      const findings = [];
      const leases = items.filter(
        (item) => isLeaseMethod(item.schedule!.method) && unpaid(item, end),
      );
      const credits = items.filter(
        (item) => !isLeaseMethod(item.schedule!.method) && unpaid(item, end),
      );
      if (leases.length)
        findings.push({
          code: 'LEASE_INSTALMENT_DUE',
          severity: 'warn' as const,
          message: `${leases.length} contracte de leasing au rate de capital scadente până la ${end} nefacturate (${leases.map((item) => `${formatMoney(unpaid(item, end), item.currency)} ${item.currency}`).join(', ')}).`,
          count: leases.length,
        });
      if (credits.length)
        findings.push({
          code: 'LOAN_OVERDUE',
          severity: 'warn' as const,
          message: `${credits.length} împrumuturi au rate scadente până la ${end} nerambursate (${credits.map((item) => `${formatMoney(unpaid(item, end), item.currency)} ${item.currency}`).join(', ')}).`,
          count: credits.length,
        });
      return findings;
    },
  },
];

/**
 * The company's loans and finance leases at a day: each with what it still owes, the part due
 * within twelve months (OMFP 1802/2014 pct. 360: the balance sheet shows it among the debts due
 * within a year; the rest beyond), its interest not yet paid and its schedule.
 */
export class Financing {
  constructor(private readonly commands: Commands) {}

  list(actor: Actor, input: z.infer<typeof loansInput>) {
    return this.commands.read(actor, 'loans.list', async (tx) => {
      const { loaded, items } = await loans(tx, actor.companyId);
      const at = input.at as LocalDate;
      const parties = new Map(
        (await loadState(tx, actor.companyId, { parties: items.map((item) => item.partyId) }))
          .loaded.parties,
      );
      const interest = interestDue(loaded, at);
      return items.map((item) => {
        const rows = item.schedule!.rows;
        const stillOwed = owed(item);
        const lease = isLeaseMethod(item.schedule!.method);
        const next = rows.find((row) => row.due > at);
        return {
          id: item.id,
          kind: lease ? ('lease' as const) : ('loan' as const),
          account: item.controlAccount,
          interestAccount: lease ? '666' : loanAccounts[synthetic(item)]!.interest,
          lender: parties.get(item.partyId)?.name ?? item.partyId,
          currency: item.currency,
          owed: formatMoney(stillOwed, item.currency),
          owedLei: formatMoney(-item.balanceBani, 'RON'),
          withinYear: formatMoney(
            currentPortion(rows, item.controlAccount, stillOwed, at),
            item.currency,
          ),
          interestToAccrue: lease
            ? null
            : formatMoney(
                interest.find((loan) => loan.item.id === item.id)?.due ?? 0n,
                item.currency,
              ),
          nextDue: next?.due ?? null,
          schedule: {
            version: item.schedule!.version,
            method: item.schedule!.method,
            principal: principalRows(rows, item.controlAccount).map((row) => ({
              due: row.due,
              amount: formatMoney(row.bani, item.currency),
            })),
            interest: interestRows(rows).map((row) => ({
              from: row.from,
              to: row.to,
              amount: formatMoney(row.bani, item.currency),
            })),
          },
        };
      });
    });
  }
}
