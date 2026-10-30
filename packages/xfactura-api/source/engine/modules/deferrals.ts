import { formatMoney, LEDGER_CURRENCY } from 'xfactura-core/money';
import { releaseDue } from 'xfactura-core/ro/treatments/deferrals';
import type { LocalDate } from 'xfactura-core/time';
import type { CloseCheck } from '../kernel/periods';
import { loadState } from '../kernel/state';

const monthEnd = (month: string) =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0))
    .toISOString()
    .slice(0, 10) as LocalDate;

/** A month closes once the amounts deferred to 471 and 472 have released their share for it
 * (deferrals.release). */
export const deferralChecks: CloseCheck[] = [
  {
    id: 'deferrals.release',
    async run(tx, companyId, month) {
      const { loaded } = await loadState(tx, companyId, {
        openItems: [
          { kind: 'deferral.expense', openOnly: true, schedules: true },
          { kind: 'deferral.revenue', openOnly: true, schedules: true },
        ],
      });
      let due = 0n;
      let count = 0;
      for (const item of loaded.openItems.values()) {
        const amounts = [...releaseDue(item, monthEnd(month)).values()];
        if (!amounts.length) continue;
        count += 1;
        due += amounts.reduce((sum, bani) => sum + bani, 0n);
      }
      return count
        ? [
            {
              code: 'DEFERRAL_DUE',
              severity: 'block' as const,
              message: `${count} sume în avans au de reluat ${formatMoney(due, LEDGER_CURRENCY)} lei până la ${monthEnd(month)} (deferrals.release).`,
              count,
            },
          ]
        : [];
    },
  },
];
