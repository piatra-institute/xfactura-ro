import { z } from 'zod';
import type { Effect, Issue, LineSpec, OpenItemState, ScheduleRow, Treatment } from '../../kernel';
import { allocate, formatMoney, LEDGER_CURRENCY, parseMoney } from '../../money';
import { isLocalDate, type LocalDate } from '../../time';

const block = (code: string, message: string, path?: string): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
});
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const lastDay = (value: string) =>
  new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)), 0))
    .toISOString()
    .slice(0, 10) as LocalDate;
const addMonths = (value: string, count: number) => {
  const index = Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7)) - 1 + count;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
};

export const deferralInput = z
  .object({
    /** The day the amount moves to 471 or 472, in the month it was booked. */
    date: z.string().refine((value): boolean => isLocalDate(value)),
    /** The expense (6xx) or revenue (70x) account it was booked on, and is released back to. */
    account: z.string().regex(/^(6\d{2,5}|70\d{1,4})$/),
    amount: z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/),
    /** The first month released, and how many months the amount covers. */
    from: month,
    months: z.number().int().min(1).max(120),
    /** The supplier or customer the amount concerns. */
    partyId: z.uuid(),
    /** The invoice it was booked from, when there is one. */
    documentId: z.uuid().optional(),
    /** The invoice, policy or contract that shows the period covered. */
    evidenceId: z.uuid(),
  })
  .strict();
export type DeferralInput = z.infer<typeof deferralInput>;

/**
 * An expense paid or a revenue billed for later periods (OMFP nr. 1.802/2014: cheltuieli și
 * venituri înregistrate în avans) leaves the year's result: the amount moves from its account to
 * 471 or 472, an open item of the partner, with a schedule releasing it back month by month in
 * equal parts (the remainder in the first months).
 */
export const deferral: Treatment<DeferralInput> = {
  id: 'deferrals.defer',
  version: 1,
  description:
    'Cheltuieli sau venituri în avans (471, 472): suma trece din contul ei, cu graficul lunar de reluare.',
  input: deferralInput,
  agent: true,
  subject: (input) => `deferral:${input.evidenceId}:${input.account}`,
  plan: (input) => ({
    evidence: [input.evidenceId],
    parties: [input.partyId],
    ...(input.documentId ? { documents: [input.documentId] } : {}),
  }),
  evaluate(input, loaded) {
    const issues: Issue[] = [];
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(block('EVIDENCE', 'Documentul justificativ nu este disponibil.', 'evidenceId'));
    if (!loaded.parties.has(input.partyId))
      issues.push(block('PARTY', 'Partenerul nu există.', 'partyId'));
    if (input.documentId && !loaded.documents.has(input.documentId))
      issues.push(block('DOCUMENT', 'Documentul nu este disponibil.', 'documentId'));
    const amount = parseMoney(input.amount, LEDGER_CURRENCY);
    if (amount <= 0n) issues.push(block('AMOUNT', 'Suma este zero.', 'amount'));
    if (input.from < input.date.slice(0, 7))
      issues.push(block('FROM', 'Reluarea începe în luna înregistrării sau după ea.', 'from'));
    if (issues.length) return { effect: null, issues };

    const revenue = input.account.startsWith('7');
    const rows: ScheduleRow[] = allocate(amount, Array(input.months).fill(1n)).map(
      (bani, index) => {
        const key = addMonths(input.from, index);
        return { key, due: lastDay(key), bani, counterAccount: input.account };
      },
    );
    const control = revenue ? '472' : '471';
    const lines: LineSpec[] = revenue
      ? [
          { account: input.account, side: 'D', bani: amount },
          {
            account: control,
            side: 'C',
            bani: amount,
            openItem: 'deferral',
            partyId: input.partyId,
          },
        ]
      : [
          {
            account: control,
            side: 'D',
            bani: amount,
            openItem: 'deferral',
            partyId: input.partyId,
          },
          { account: input.account, side: 'C', bani: amount },
        ];
    const until = rows.at(-1)!.key;
    const effect: Effect = {
      schema: 'effect@1',
      date: input.date as LocalDate,
      journalClass: 'general',
      journalCode: 'DIVERSE',
      description: `${revenue ? 'Venituri' : 'Cheltuieli'} în avans ${input.from}–${until}`,
      lines,
      openItems: [
        {
          ref: 'deferral',
          kind: revenue ? 'deferral.revenue' : 'deferral.expense',
          controlAccount: control,
          partyId: input.partyId,
          currency: LEDGER_CURRENCY,
          normalSide: revenue ? 'C' : 'D',
          mayReverse: false,
          ...(input.documentId ? { documentId: input.documentId } : {}),
        },
      ],
      taxEntries: [],
      schedules: [
        {
          ref: 'release',
          openItem: 'deferral',
          version: 1,
          method: 'monthly_equal',
          rows,
          basis: { from: input.from, months: input.months, amount: input.amount },
        },
      ],
      explanation: {
        summary: `${formatMoney(amount, LEDGER_CURRENCY)} lei din ${input.account} în ${control}, reluați în ${input.months} luni (${input.from}–${until}).`,
        details: { account: input.account, from: input.from, months: input.months },
      },
    };
    return { effect, issues };
  },
};

/**
 * What an open deferral has due by a day and not yet released, by the account it goes back to:
 * its schedule's rows due by then, less what was already released (the schedule's total less the
 * item's balance), the earliest rows released first.
 */
export function releaseDue(item: OpenItemState, through: LocalDate): Map<string, bigint> {
  const byAccount = new Map<string, bigint>();
  if (!item.schedule) return byAccount;
  const remaining = item.normalSide === 'D' ? item.balanceBani : -item.balanceBani;
  let released = item.schedule.rows.reduce((sum, row) => sum + row.bani, 0n) - remaining;
  for (const row of item.schedule.rows) {
    if (row.due > through) break;
    const done = released < row.bani ? released : row.bani;
    released -= done;
    if (row.bani > done)
      byAccount.set(
        row.counterAccount,
        (byAccount.get(row.counterAccount) ?? 0n) + row.bani - done,
      );
  }
  return byAccount;
}

export const releaseInput = z
  .object({
    month,
    /** A later round releases what reached the month after an earlier release. */
    round: z.number().int().min(1).max(99).default(1),
  })
  .strict();
export type ReleaseInput = z.infer<typeof releaseInput>;

/**
 * A month's share of the amounts deferred to 471 and 472 goes back to their accounts on its last
 * day: for each open deferral, what its schedule has due by then less what was already released
 * (the schedule's total less the item's balance), so a missed month is caught up and nothing is
 * released twice.
 */
export const deferralRelease: Treatment<ReleaseInput> = {
  id: 'deferrals.release',
  version: 1,
  description: 'Reluarea lunară a cheltuielilor și veniturilor în avans (471, 472).',
  input: releaseInput,
  agent: true,
  subject: (input) => `deferrals-release:${input.month}:${input.round}`,
  plan: () => ({
    openItems: [
      { kind: 'deferral.expense', openOnly: true, schedules: true },
      { kind: 'deferral.revenue', openOnly: true, schedules: true },
    ],
  }),
  evaluate(input, loaded) {
    const end = lastDay(input.month);
    const lines: LineSpec[] = [];
    let total = 0n;
    for (const item of [...loaded.openItems.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const byAccount = releaseDue(item, end);
      for (const [account, bani] of byAccount) {
        total += bani;
        const deferred = { openItem: item.id, partyId: item.partyId };
        lines.push(
          ...(item.kind === 'deferral.revenue'
            ? [
                { account: item.controlAccount, side: 'D' as const, bani, ...deferred },
                { account, side: 'C' as const, bani },
              ]
            : [
                { account, side: 'D' as const, bani },
                { account: item.controlAccount, side: 'C' as const, bani, ...deferred },
              ]),
        );
      }
    }
    if (!lines.length)
      return {
        effect: null,
        issues: [
          block(
            'NOTHING_TO_RELEASE',
            `Nicio sumă în avans nu are reluare scadentă în ${input.month}.`,
          ),
        ],
      };
    const effect: Effect = {
      schema: 'effect@1',
      date: end,
      journalClass: 'general',
      journalCode: 'DIVERSE',
      description: `Reluarea cheltuielilor și veniturilor în avans ${input.month}`,
      lines,
      openItems: [],
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: `${formatMoney(total, LEDGER_CURRENCY)} lei reluați din 471 și 472 pentru ${input.month}.`,
        details: { month: input.month },
      },
    };
    return { effect, issues: [] };
  },
};
