import { z } from 'zod';
import {
  accountCodePattern,
  turnoverKey,
  type Effect,
  type Issue,
  type LineSpec,
  type OpenItemKind,
  type Treatment,
  type TurnoverQuery,
} from '../../kernel';
import { formatMoney, LEDGER_CURRENCY, parseMoney } from '../../money';
import {
  RuleGapError,
  type ParameterDefinition,
  type ParameterVersion,
  type RuleContext,
} from '../../rules';
import { isLocalDate, parseLocalDate, type LocalDate } from '../../time';
import { controlKindOf } from '../chart';

const money = z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/);
const limit = money;

export const cashLimits = z
  .object({
    /** Cash received from or paid to one economic operator (company, PFA) in a day. */
    operator: limit,
    /** Cash paid to economic operators in a day, in total. */
    operatorsTotal: limit,
    /** Cash received from or paid to one individual in a day. */
    individual: limit,
    /** Cash in the cash desk at the end of a day. */
    ceiling: limit,
  })
  .strict();
export type CashLimits = z.infer<typeof cashLimits>;

export const cashDefinitions: ParameterDefinition[] = [
  {
    key: 'ro.cash.limits',
    axis: 'payment_date',
    continuity: 'block',
    scope: [],
    value: cashLimits,
    description:
      'Plafoanele operațiunilor în numerar (Legea nr. 70/2015): pe zi și persoană, plăți totale pe zi, numerarul din casierie la sfârșitul zilei.',
  },
];

/** As ANAF's guide of July 2026 gives them: the 2026 values only, earlier ones are a gap. */
export const cashVersions: ParameterVersion[] = [
  {
    id: 'ro.cash.limits/2026-01-01',
    key: 'ro.cash.limits',
    scope: {},
    value: { operator: '5000', operatorsTotal: '10000', individual: '10000', ceiling: '50000' },
    from: parseLocalDate('2026-01-01'),
    to: null,
    reviewedThrough: parseLocalDate('2026-12-31'),
    knowledgeDate: null,
    status: 'extracted',
    clauses: [
      'L70/2015:art.3(1)',
      'L70/2015:art.4',
      'L70/2015:art.4^2',
      'ANAF/Ploiesti-ghid-numerar-2026:plafoane',
    ],
  },
];

const block = (code: string, message: string, path?: string): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
});
const ack = (code: string, message: string): Issue => ({ code, severity: 'ack', message });

/** Open items a cash movement starts: an advance to an employee or a person to account for it
 * (542), money an associate lends or pays for the company (4551), other debtors and creditors. */
const opened: Readonly<Record<string, { kind: OpenItemKind; side: 'D' | 'C' }>> = {
  '542': { kind: 'receivable', side: 'D' },
  '461': { kind: 'receivable', side: 'D' },
  '4551': { kind: 'payable', side: 'C' },
  '462': { kind: 'payable', side: 'C' },
};

export const cashInput = z
  .object({
    /** The cash account (531x). */
    account: z.string().regex(/^531\d?$/),
    date: z.string().refine((value): boolean => isLocalDate(value)),
    direction: z.enum(['receipt', 'payment']),
    /** The receipt (chitanță) or cash slip (dispoziție de plată/încasare) number. */
    number: z.string().trim().min(1).max(40),
    /** Who pays or is paid. */
    partyId: z.uuid(),
    /** The receipt or slip itself. */
    evidenceId: z.uuid(),
    /** Invoices and other open items the cash settles. */
    allocations: z
      .array(z.object({ openItem: z.uuid(), amount: money }).strict())
      .max(50)
      .default([]),
    /** A new open item of the person: an advance paid on 542, an associate's money received on
     * 4551, other debtors (461) and creditors (462). */
    opens: z
      .array(z.object({ account: z.enum(['542', '461', '4551', '462']), amount: money }).strict())
      .max(5)
      .default([]),
    /** Amounts booked straight to accounts without partners. */
    lines: z
      .array(
        z
          .object({
            account: z.string().regex(accountCodePattern),
            amount: money,
            memo: z.string().trim().min(1).max(500).optional(),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    description: z.string().trim().min(3).max(500).optional(),
  })
  .strict()
  .refine((input) => input.allocations.length + input.opens.length + input.lines.length > 0, {
    message: 'Explicați încasarea sau plata în numerar.',
  });
export type CashInput = z.infer<typeof cashInput>;

const always = '1900-01-01' as LocalDate;
const balanceQuery = (input: CashInput): TurnoverQuery => ({
  prefixes: [input.account],
  from: always,
  to: input.date as LocalDate,
});

/**
 * A cash receipt or payment in lei, by its receipt or slip: it settles open items, starts an
 * advance or an associate's account, or books to plain accounts, and is numbered in the cash
 * register (registrul de casă). The cash desk never goes negative. Legea nr. 70/2015's limits
 * are acknowledged, not refused: a movement above one person's daily limit, or cash above the
 * end-of-day ceiling. A day's several movements with the same person are not added up yet, and
 * the law's exemptions (taxes, salaries, travel) are for the reviewer.
 */
export const cashMovement: Treatment<CashInput> = {
  id: 'cash.record',
  version: 1,
  description:
    'Încasare sau plată în numerar, cu chitanța sau dispoziția ei, în registrul de casă.',
  input: cashInput,
  agent: true,
  subject: (input) => `cash:${input.account}:${input.direction}:${input.number}`,
  plan: (input) => ({
    evidence: [input.evidenceId],
    parties: [input.partyId],
    openItems: [{ ids: input.allocations.map((allocation) => allocation.openItem) }],
    turnover: [balanceQuery(input)],
  }),
  evaluate(input, loaded, rules: RuleContext) {
    const issues: Issue[] = [];
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(block('EVIDENCE', 'Chitanța sau dispoziția nu este disponibilă.', 'evidenceId'));
    const party = loaded.parties.get(input.partyId);
    if (!party) issues.push(block('PARTY', 'Partenerul nu există.', 'partyId'));
    const receipt = input.direction === 'receipt';
    const side = receipt ? 'C' : 'D';
    const lines: LineSpec[] = [];
    let total = 0n;
    input.allocations.forEach((allocation, index) => {
      const item = loaded.openItems.get(allocation.openItem);
      const bani = parseMoney(allocation.amount, LEDGER_CURRENCY);
      total += bani;
      if (!item) {
        issues.push(
          block('OPEN_ITEM', 'Poziția deschisă nu este disponibilă.', `allocations.${index}`),
        );
        return;
      }
      if (item.currency !== LEDGER_CURRENCY)
        issues.push(
          block(
            'CURRENCY',
            'Numerarul în lei nu decontează o poziție în valută.',
            `allocations.${index}`,
          ),
        );
      lines.push({
        account: item.controlAccount,
        side,
        bani,
        openItem: item.id,
        partyId: item.partyId,
      });
    });
    const openItems: Effect['openItems'] = [];
    input.opens.forEach((open, index) => {
      const bani = parseMoney(open.amount, LEDGER_CURRENCY);
      total += bani;
      const spec = opened[open.account]!;
      // A payment starts what the person owes back (542, 461); a receipt what the company owes.
      if ((spec.side === 'D') !== !receipt)
        issues.push(
          block(
            'DIRECTION',
            `Contul ${open.account} se deschide printr-o ${spec.side === 'D' ? 'plată' : 'încasare'}.`,
            `opens.${index}`,
          ),
        );
      const ref = `opened-${index}`;
      openItems.push({
        ref,
        kind: spec.kind,
        controlAccount: open.account,
        partyId: input.partyId,
        currency: LEDGER_CURRENCY,
        normalSide: spec.side,
        mayReverse: false,
      });
      lines.push({ account: open.account, side, bani, openItem: ref, partyId: input.partyId });
    });
    input.lines.forEach((line, index) => {
      const bani = parseMoney(line.amount, LEDGER_CURRENCY);
      total += bani;
      if (controlKindOf(line.account))
        issues.push(
          block(
            'CONTROL_ACCOUNT',
            `Contul ${line.account} se decontează prin poziții deschise.`,
            `lines.${index}`,
          ),
        );
      lines.push({ account: line.account, side, bani, ...(line.memo ? { memo: line.memo } : {}) });
    });
    if (total <= 0n) issues.push(block('AMOUNT', 'Suma este zero.'));
    const balance = (loaded.turnover.get(turnoverKey(balanceQuery(input))) ?? []).reduce(
      (sum, row) => sum + row.debit - row.credit,
      0n,
    );
    const after = receipt ? balance + total : balance - total;
    if (after < 0n)
      issues.push(
        block(
          'CASH_NEGATIVE',
          `Casieria ar avea un sold negativ (${formatMoney(after, LEDGER_CURRENCY)} lei) la ${input.date}.`,
        ),
      );
    try {
      const limits = rules.param<CashLimits>(
        'ro.cash.limits',
        'payment_date',
        input.date as LocalDate,
      );
      const individual = party?.kind === 'ro_individual';
      const operator =
        party?.kind === 'ro_legal_entity' || party?.kind === 'ro_individual_enterprise';
      const cap = individual ? limits.individual : operator ? limits.operator : null;
      if (cap !== null && total > parseMoney(cap, LEDGER_CURRENCY))
        issues.push(
          ack(
            'CASH_LIMIT',
            `${receipt ? 'Încasarea' : 'Plata'} în numerar de ${formatMoney(total, LEDGER_CURRENCY)} lei depășește plafonul zilnic de ${cap} lei pentru o ${individual ? 'persoană fizică' : 'persoană juridică sau PFA'} (Legea nr. 70/2015): confirmați excepția.`,
          ),
        );
      if (after > parseMoney(limits.ceiling, LEDGER_CURRENCY))
        issues.push(
          ack(
            'CASH_CEILING',
            `Numerarul din casierie ar fi ${formatMoney(after, LEDGER_CURRENCY)} lei, peste plafonul de ${limits.ceiling} lei la sfârșitul zilei (excepție: salarii și plăți către persoane fizice, 3 zile lucrătoare).`,
          ),
        );
    } catch (error) {
      if (!(error instanceof RuleGapError)) throw error;
      issues.push(block('RULE_GAP', error.message));
    }
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };

    const cash: LineSpec = {
      account: input.account,
      side: receipt ? 'D' : 'C',
      bani: total,
      memo: input.number,
    };
    const effect: Effect = {
      schema: 'effect@1',
      date: input.date as LocalDate,
      journalClass: 'general',
      journalCode: 'CASA',
      description:
        input.description ??
        `${receipt ? 'Încasare' : 'Plată'} în numerar ${input.number}${party ? ` ${party.name}` : ''}`.slice(
          0,
          500,
        ),
      lines: [cash, ...lines],
      openItems,
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: `${receipt ? 'Încasare' : 'Plată'} ${formatMoney(total, LEDGER_CURRENCY)} lei, ${input.number}; sold casierie ${formatMoney(after, LEDGER_CURRENCY)} lei.`,
        details: { number: input.number, balance: formatMoney(after, LEDGER_CURRENCY) },
      },
    };
    return { effect, issues };
  },
};

export const expenseReportInput = z
  .object({
    /** The advance paid (its open item on 542). */
    advanceId: z.uuid(),
    date: z.string().refine((value): boolean => isLocalDate(value)),
    /** The expense report (decont de cheltuieli) with the receipts. */
    evidenceId: z.uuid(),
    /** What was spent, at the amounts paid (VAT on receipts is not deducted). */
    expenses: z
      .array(
        z
          .object({
            account: z.string().regex(/^6\d{2,5}$/),
            amount: money,
            memo: z.string().trim().min(1).max(500).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
export type ExpenseReportInput = z.infer<typeof expenseReportInput>;

/**
 * The expense report of an advance for expenses (decont de avans, OMFP nr. 2.634/2015): the
 * receipts justify part of the advance, booked to expenses against 542; what is left is returned
 * in cash (a `cash.record` receipt settling the same advance). Spending more than the advance is
 * refused: the difference is paid to the person first, as a further advance. VAT on the receipts
 * is not deducted: simplified invoices are not reported yet.
 */
export const expenseReport: Treatment<ExpenseReportInput> = {
  id: 'cash.expenseReport',
  version: 1,
  description: 'Decontul unui avans spre decontare (542): cheltuielile justificate cu documente.',
  input: expenseReportInput,
  agent: true,
  subject: (input) => `expense-report:${input.evidenceId}`,
  plan: (input) => ({ evidence: [input.evidenceId], openItems: [{ ids: [input.advanceId] }] }),
  evaluate(input, loaded) {
    const issues: Issue[] = [];
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(block('EVIDENCE', 'Decontul nu este disponibil.', 'evidenceId'));
    const advance = loaded.openItems.get(input.advanceId);
    if (!advance || advance.controlAccount !== '542')
      return {
        effect: null,
        issues: [block('ADVANCE', 'Poziția nu este un avans spre decontare (542).', 'advanceId')],
      };
    const total = input.expenses.reduce(
      (sum, expense) => sum + parseMoney(expense.amount, LEDGER_CURRENCY),
      0n,
    );
    if (total > advance.balanceBani)
      issues.push(
        block(
          'EXCESS',
          `Cheltuielile (${formatMoney(total, LEDGER_CURRENCY)} lei) depășesc avansul nedecontat (${formatMoney(advance.balanceBani, LEDGER_CURRENCY)} lei): plătiți întâi diferența ca avans.`,
        ),
      );
    if (issues.length) return { effect: null, issues };
    const effect: Effect = {
      schema: 'effect@1',
      date: input.date as LocalDate,
      journalClass: 'general',
      journalCode: 'DIVERSE',
      description: 'Decont de cheltuieli din avans',
      lines: [
        ...input.expenses.map((expense): LineSpec => ({
          account: expense.account,
          side: 'D',
          bani: parseMoney(expense.amount, LEDGER_CURRENCY),
          ...(expense.memo ? { memo: expense.memo } : {}),
        })),
        {
          account: '542',
          side: 'C',
          bani: total,
          openItem: advance.id,
          partyId: advance.partyId,
        },
      ],
      openItems: [],
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: `${formatMoney(total, LEDGER_CURRENCY)} lei justificați din avansul de ${formatMoney(advance.balanceBani, LEDGER_CURRENCY)} lei.`,
        details: { advanceId: advance.id },
      },
    };
    return { effect, issues };
  },
};
