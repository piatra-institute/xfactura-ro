import { z } from 'zod';
import type { Effect, Issue, LineSpec, OpenItemKind, Treatment } from '../../kernel';
import { convertMinor, LEDGER_CURRENCY } from '../../money';
import { isLocalDate, monthEnd, monthOf, type LocalDate } from '../../time';
import { INDEXED_LEASE_METHOD } from '../financing';
import { selectRate } from '../fx';

/** Monetary items are settled in a fixed or determinable amount of currency (OMFP 1802/2014 pct.
 * 315) and are revalued each month (pct. 325); advances and deferrals are not (pct. 315 alin.
 * (3), 316 alin. (2)). Receivables and payables include the refund a credit note in a currency
 * opens beyond its invoice's balance (462, 461). Loans and their interest are (the functions of
 * accounts 162, 167, 168 and 519). So is a tax owed or claimed in a currency: the Union scheme's
 * VAT, owed in euro to the special account (Codul fiscal art. 315 alin. (12)–(13); 4423,
 * `invoices.euConsumer`), which no text leaves out of pct. 325's "datoriile în valută". */
export const monetaryKinds: ReadonlySet<OpenItemKind> = new Set<OpenItemKind>([
  'receivable',
  'payable',
  'accrual.payable',
  'accrual.receivable',
  'unapplied.receipt',
  'unapplied.payment',
  'loan.payable',
  'loan.interest',
  'tax.payable',
  'tax.receivable',
]);

export const revaluationInput = z
  .object({
    date: z
      .string()
      .refine((value): boolean => isLocalDate(value))
      .transform((value) => value as LocalDate),
    /** A further revaluation of the same date, after later entries changed the balances. */
    round: z.number().int().min(1).max(99).default(1),
  })
  .strict();
export type RevaluationInput = z.infer<typeof revaluationInput>;

/**
 * Revalues foreign-currency monetary items and bank or cash balances at the month-end reference
 * rate: each balance is brought to its currency amount at that rate, and the differences are
 * exchange gains (7651) or losses (6651) on monetary items. The currency amounts do not change.
 * A finance lease settled in lei at a currency's rate is a liability in lei: its differences are
 * other financial revenue (768) or expense (668), by the functions of account 167.
 */
export const revaluation: Treatment<RevaluationInput> = {
  id: 'fx.revalue',
  version: 2,
  description:
    'Reevaluarea la sfârșit de lună a creanțelor, datoriilor și disponibilităților în valută.',
  input: revaluationInput,
  agent: true,
  summary: 'Month-end revaluation of foreign-currency receivables, payables and cash.',
  toolset: 'close',
  subject: (input) => `fx.revalue:${input.date}:${input.round}`,
  // Every foreign item with its history: one settled after the date was still open on it.
  plan: (input) => ({
    openItems: [{ foreign: true, schedules: true, history: true }],
    foreignBalances: { at: input.date },
    profile: true,
  }),
  followUp(input, loaded) {
    const currencies = new Set([
      ...[...loaded.openItems.values()].map((item) => item.currency),
      ...loaded.balances.map((balance) => balance.currency),
    ]);
    const entries = [
      ...new Set([...loaded.openItems.values()].flatMap((item) => item.history ?? [])),
    ].sort();
    return currencies.size || entries.length
      ? {
          fx: [...currencies].sort().map((currency) => ({ currency, until: input.date })),
          entries,
        }
      : null;
  },
  evaluate(input, loaded, rules) {
    const issues: Issue[] = [];
    if (monthEnd(monthOf(input.date)) !== input.date)
      issues.push({
        code: 'REVALUATION_DATE',
        severity: 'block',
        message: 'Reevaluarea se face la sfârșitul lunii.',
        path: 'date',
      });
    const lines: LineSpec[] = [];
    let gains = 0n;
    let losses = 0n;
    let indexedGains = 0n;
    let indexedLosses = 0n;
    const revalue = (
      target: Omit<LineSpec, 'side' | 'bani'>,
      currency: string,
      bani: bigint,
      minor: bigint,
      indexed = false,
    ) => {
      if (currency === LEDGER_CURRENCY) return;
      const rate = selectRate(loaded, rules, currency, input.date, 'accounting');
      if ('code' in rate) {
        if (!issues.some((issue) => issue.code === rate.code && issue.message === rate.message))
          issues.push(rate);
        return;
      }
      const difference =
        convertMinor(minor, currency, { rate: rate.rate, multiplier: rate.multiplier }) - bani;
      if (difference === 0n) return;
      const increase = difference > 0n;
      const amount = increase ? difference : -difference;
      lines.push({
        ...target,
        side: increase ? 'D' : 'C',
        bani: amount,
        currency: { code: currency, minor: 0n, rateId: rate.id, rate: rate.rate },
      });
      // A higher debit balance or a lower credit balance is a gain.
      if (indexed) {
        if (increase) indexedGains += amount;
        else indexedLosses += amount;
      } else if (increase) gains += amount;
      else losses += amount;
    };
    for (const item of loaded.openItems.values())
      if (monetaryKinds.has(item.kind)) {
        // The item as it stood at the date: a revaluation booked after later entries (a year-end
        // revaluation posted in February) revalues the balance of its date, not today's.
        let bani = item.balanceBani;
        let minor = item.balanceMinor;
        for (const entryId of item.history ?? []) {
          const entry = loaded.entries.get(entryId);
          if (!entry || entry.date <= input.date) continue;
          for (const line of entry.lines)
            if (line.openItem === item.id) {
              const sign = line.side === 'D' ? 1n : -1n;
              bani -= sign * line.bani;
              minor -= sign * (line.currency?.minor ?? 0n);
            }
        }
        revalue(
          { account: item.controlAccount, openItem: item.id, partyId: item.partyId },
          item.currency,
          bani,
          minor,
          item.schedule?.method === INDEXED_LEASE_METHOD,
        );
      }
    for (const balance of loaded.balances)
      revalue({ account: balance.account }, balance.currency, balance.bani, balance.minor);
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };
    if (lines.length === 0)
      return {
        effect: null,
        issues: [
          {
            code: 'NOTHING_TO_REVALUE',
            severity: 'block',
            message: 'Nu există diferențe de curs de înregistrat.',
          },
        ],
      };
    if (gains)
      lines.push({
        account: '7651',
        side: 'C',
        bani: gains,
        memo: 'Diferențe de curs nerealizate',
      });
    if (losses)
      lines.push({
        account: '6651',
        side: 'D',
        bani: losses,
        memo: 'Diferențe de curs nerealizate',
      });
    if (indexedGains)
      lines.push({
        account: '768',
        side: 'C',
        bani: indexedGains,
        memo: 'Diferențe din evaluarea datoriilor în lei decontate la cursul unei valute',
      });
    if (indexedLosses)
      lines.push({
        account: '668',
        side: 'D',
        bani: indexedLosses,
        memo: 'Diferențe din evaluarea datoriilor în lei decontate la cursul unei valute',
      });
    const effect: Effect = {
      schema: 'effect@1',
      date: input.date,
      journalClass: 'general',
      journalCode: 'DIVERSE',
      description: `Reevaluare valutară la ${input.date}`,
      lines,
      openItems: [],
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: `Reevaluarea pozițiilor monetare în valută la cursul BNR din ${input.date}.`,
      },
    };
    return { effect, issues };
  },
};
