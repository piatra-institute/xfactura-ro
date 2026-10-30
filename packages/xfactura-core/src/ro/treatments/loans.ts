import { z } from 'zod';
import {
  itemLinesKey,
  type Effect,
  type FxRate,
  type Issue,
  type LineSpec,
  type Loaded,
  type OpenItemKind,
  type OpenItemSpec,
  type OpenItemState,
  type ReadPlan,
  type ScheduleRow,
  type Treatment,
} from '../../kernel';
import {
  convertMinor,
  divRound,
  formatMoney,
  LEDGER_CURRENCY,
  parseMoney,
  parseScaled,
} from '../../money';
import { RuleGapError, type RuleContext } from '../../rules';
import { isLocalDate, monthEnd, type LocalDate, type Month } from '../../time';
import { controlKindOf } from '../chart';
import {
  financingClauses,
  instalmentsFrom,
  interestAccountCodes,
  interestAccrued,
  interestRows,
  isLeaseMethod,
  loanAccountCodes,
  loanAccounts,
  loanSchedule,
  owed,
  principalRows,
  termMismatch,
  type Instalment,
  type ScheduleMethod,
} from '../financing';
import { selectRate } from '../fx';

const block = (code: string, message: string, path?: string): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
});
const ack = (code: string, message: string): Issue => ({ code, severity: 'ack', message });
const localDate = z
  .string()
  .refine((value): boolean => isLocalDate(value))
  .transform((value) => value as LocalDate);
const amount = z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/);

/** A contract's instalments, in the loan's currency, or its terms. */
export const planInput = {
  /** The instalments as the contract's repayment schedule (graficul de rambursare) gives them. */
  instalments: z
    .array(
      z
        .object({
          due: localDate,
          principal: amount.default('0'),
          interest: amount.default('0'),
          /** The start of the interest period, when it is not the previous instalment's due date. */
          from: localDate.optional(),
        })
        .strict(),
    )
    .min(1)
    .max(600)
    .optional(),
  /** Or the contract's terms: monthly instalments computed from an annual rate. */
  terms: z
    .object({
      method: z.enum(['annuity', 'linear']),
      rate: z.string().regex(/^(0|[1-9]\d{0,2})(\.\d{1,4})?$/),
      months: z.number().int().min(1).max(600),
      firstDue: localDate,
    })
    .strict()
    .optional(),
};
type PlanInput = {
  instalments?: { due: LocalDate; principal: string; interest: string; from?: LocalDate }[];
  terms?: { method: 'annuity' | 'linear'; rate: string; months: number; firstDue: LocalDate };
};
const onePlan = (input: PlanInput) =>
  (input.instalments === undefined) !== (input.terms === undefined);
const onePlanMessage =
  'Indicați fie ratele din graficul de rambursare, fie condițiile contractului.';

/** The instalments of a plan, in minor units of `currency`. */
export function planInstalments(
  input: PlanInput,
  principal: bigint,
  currency: string,
): { instalments: Instalment[]; method: ScheduleMethod } {
  if (input.terms)
    return { instalments: instalmentsFrom(principal, input.terms), method: input.terms.method };
  return {
    instalments: input.instalments!.map((row) => ({
      due: row.due,
      principal: parseMoney(row.principal, currency),
      interest: parseMoney(row.interest, currency),
      ...(row.from ? { from: row.from } : {}),
    })),
    method: 'contract',
  };
}

/** The synthetic account a loan's line is on: the loan account or one of its analytics. */
const loanAccountOf = (account: string) => account.split('.')[0]!;

/** A loan item: one held on a loan account (1621, 5191, 166x, 167, 4551), owed by the company. */
export const isLoan = (item: OpenItemState) =>
  loanAccountCodes.includes(loanAccountOf(item.controlAccount)) && item.normalSide === 'C';

export const receiptInput = z
  .object({
    /** The bank movement that brings the money in. */
    movementId: z.uuid(),
    /** 1621 long-term or 5191 short-term bank credit, 1661/1663 an affiliated or associated
     * entity's loan, 167 another lender's, 4551 an associate's. */
    account: z.enum(loanAccountCodes as [string, ...string[]]),
    /** The lender. */
    partyId: z.uuid(),
    /** The loan contract, with its repayment schedule. */
    evidenceId: z.uuid(),
    ...planInput,
    description: z.string().trim().min(3).max(500).optional(),
  })
  .strict()
  .refine(onePlan, onePlanMessage);
export type ReceiptInput = z.infer<typeof receiptInput>;

/**
 * Money borrowed, as the bank movement that brings it in: Dr the bank account / Cr the loan
 * account (OMFP 1802/2014: 162 long-term and 519 short-term bank credits, 166, 167, 4551), an open
 * item of the lender in the movement's currency, with the contract's schedule: its principal
 * repayments on the loan account and each period's interest on the account it accrues to (168x,
 * 5198, 4558). A credit in a currency is recorded at the accounting rate of the day it is received.
 * Repayments are bank movements settling the loan and its interest (`bank.settle`); the interest
 * is accrued month by month (`loans.accrue`).
 */
export const loanReceipt: Treatment<ReceiptInput> = {
  id: 'loans.receive',
  version: 1,
  description:
    'Credit sau împrumut primit prin bancă (162, 519, 166, 167, 4551), cu graficul de rambursare și dobânzile.',
  input: receiptInput,
  agent: true,
  subject: (input) => `movement:${input.movementId}`,
  plan: (input) => ({
    movements: [input.movementId],
    parties: [input.partyId],
    evidence: [input.evidenceId],
  }),
  followUp(input, loaded) {
    const movement = loaded.movements.get(input.movementId);
    return movement && movement.currency !== LEDGER_CURRENCY
      ? { fx: [{ currency: movement.currency, until: movement.bookingDate }], profile: true }
      : null;
  },
  evaluate(input, loaded, rules) {
    const issues: Issue[] = [];
    const movement = loaded.movements.get(input.movementId);
    if (!movement)
      return {
        effect: null,
        issues: [block('MOVEMENT', 'Mișcarea bancară nu este disponibilă.', 'movementId')],
      };
    if (movement.amountMinor <= 0n)
      issues.push(block('DIRECTION', 'Un împrumut se primește printr-o încasare.', 'movementId'));
    const lender = loaded.parties.get(input.partyId);
    if (!lender) issues.push(block('PARTY', 'Creditorul nu există.', 'partyId'));
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(block('EVIDENCE', 'Contractul nu este disponibil.', 'evidenceId'));
    const currency = movement.currency;
    let rate: FxRate | undefined;
    if (currency !== LEDGER_CURRENCY) {
      const selected = selectRate(loaded, rules, currency, movement.bookingDate, 'accounting');
      if ('code' in selected) issues.push(selected);
      else rate = selected;
    }
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };

    const principal = movement.amountMinor;
    const { instalments, method } = planInstalments(input, principal, currency);
    const interestAccount = loanAccounts[input.account]!.interest;
    const plan = loanSchedule(instalments, movement.bookingDate, input.account, interestAccount);
    issues.push(...plan.issues);
    const repaid = principalRows(plan.rows, input.account).reduce((sum, row) => sum + row.bani, 0n);
    if (repaid !== principal)
      issues.push(
        block(
          'SCHEDULE_PRINCIPAL',
          `Ratele de principal însumează ${formatMoney(repaid, currency)} ${currency}, iar împrumutul primit este de ${formatMoney(principal, currency)} ${currency}.`,
          'instalments',
        ),
      );
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };
    const lastDue = plan.rows.at(-1)!.due;
    if (termMismatch(input.account, movement.bookingDate, lastDue))
      issues.push(
        ack(
          'LOAN_TERM',
          `Contul ${input.account} (${loanAccounts[input.account]!.name.toLowerCase()}) nu corespunde duratei împrumutului (ultima rată la ${lastDue}): confirmați contul.`,
        ),
      );

    const bani = rate
      ? convertMinor(principal, currency, { rate: rate.rate, multiplier: rate.multiplier })
      : principal;
    const withCurrency = (line: LineSpec): LineSpec =>
      rate
        ? {
            ...line,
            currency: { code: currency, minor: principal, rateId: rate.id, rate: rate.rate },
          }
        : line;
    const item: OpenItemSpec = {
      ref: 'loan',
      kind: controlKindOf(input.account) as OpenItemKind,
      controlAccount: input.account,
      partyId: input.partyId,
      currency,
      normalSide: 'C',
      mayReverse: false,
      dueDate: lastDue,
    };
    const effect: Effect = {
      schema: 'effect@1',
      date: movement.bookingDate,
      journalClass: 'general',
      journalCode: 'BANCA',
      description: input.description ?? `Împrumut primit de la ${lender!.name}`.slice(0, 500),
      lines: [
        withCurrency({ account: movement.ledgerAccount, side: 'D', bani }),
        withCurrency({
          account: input.account,
          side: 'C',
          bani,
          openItem: 'loan',
          partyId: input.partyId,
        }),
      ],
      openItems: [item],
      taxEntries: [],
      schedules: [
        {
          ref: 'plan',
          openItem: 'loan',
          version: 1,
          method,
          rows: plan.rows,
          basis: {
            start: movement.bookingDate,
            evidenceId: input.evidenceId,
            ...(input.terms ? { terms: input.terms } : {}),
          },
        },
      ],
      explanation: {
        summary: `${formatMoney(principal, currency)} ${currency} de la ${lender!.name} pe ${input.account}, rambursat în ${principalRows(plan.rows, input.account).length} rate până la ${lastDue}${rate ? `, la cursul ${rate.rate}` : ''}.`,
        details: {
          account: input.account,
          interestAccount,
          interest: formatMoney(
            interestRows(plan.rows).reduce((sum, row) => sum + row.bani, 0n),
            currency,
          ),
          clauses: [
            input.account === '5191'
              ? financingClauses.shortTerm
              : input.account === '4551'
                ? financingClauses.associates
                : financingClauses.loans,
          ],
        },
      },
    };
    return { effect, issues };
  },
};

export const scheduleInput = z
  .object({
    /** The loan (its open item on 1621, 5191, 166x, 167 or 4551). */
    openItem: z.uuid(),
    /** From this day the plan is the new one; rows due by then stay as they were. */
    date: localDate,
    /** The contract, its addendum or the bank's new schedule. */
    evidenceId: z.uuid(),
    /** For a loan without a schedule (an associate's money received through `bank.settle` or
     * `cash.record`, a loan carried in an opening entry): the day its interest starts. */
    start: localDate.optional(),
    ...planInput,
  })
  .strict()
  .refine(onePlan, onePlanMessage);
export type ScheduleInput = z.infer<typeof scheduleInput>;

const sameRow = (a: ScheduleRow, b: ScheduleRow) =>
  a.key === b.key && a.bani === b.bani && a.counterAccount === b.counterAccount && a.due === b.due;

/**
 * A loan's plan given or changed without money moving, as a memorandum entry: the schedule of a
 * loan that has none (an associate's money received through `bank.settle` or `cash.record`, a loan
 * carried in the opening balance), or a new version of one (a variable rate reset, a repayment
 * rescheduled). A new version keeps every row due by its date, and repays the same principal.
 */
export const loanPlan: Treatment<ScheduleInput> = {
  id: 'loans.schedule',
  version: 1,
  description: 'Graficul de rambursare al unui împrumut existent, sau o versiune nouă a lui.',
  input: scheduleInput,
  agent: true,
  subject: (input) => `loan-schedule:${input.openItem}:${input.evidenceId}`,
  plan: (input) => ({
    evidence: [input.evidenceId],
    openItems: [{ ids: [input.openItem], schedules: true }],
  }),
  followUp(input, loaded) {
    const item = loaded.openItems.get(input.openItem);
    return item ? { entries: [item.originEntryId] } : null;
  },
  evaluate(input, loaded) {
    const issues: Issue[] = [];
    const item = loaded.openItems.get(input.openItem);
    if (!item || !isLoan(item))
      return {
        effect: null,
        issues: [block('LOAN', 'Poziția nu este un împrumut primit.', 'openItem')],
      };
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(block('EVIDENCE', 'Documentul nu este disponibil.', 'evidenceId'));
    if (isLeaseMethod(item.schedule?.method))
      issues.push(
        block('LEASE', 'Graficul unui leasing financiar nu se revizuiește încă.', 'openItem'),
      );
    const account = loanAccountOf(item.controlAccount);
    const interestAccount = loanAccounts[account]!.interest;
    const origin = loaded.entries.get(item.originEntryId);
    const current = item.schedule;
    const start = current ? undefined : input.start;
    if (!current && !start)
      issues.push(
        block('START', 'Indicați data de la care curge dobânda împrumutului (start).', 'start'),
      );
    if (current && input.start)
      issues.push(
        block('START', 'Împrumutul are deja un grafic: începutul lui nu se schimbă.', 'start'),
      );
    if (start && origin && start < origin.date)
      issues.push(block('START', 'Dobânda nu curge înainte de primirea împrumutului.', 'start'));
    if (origin && input.date < origin.date)
      issues.push(block('DATE', 'Graficul nu precede primirea împrumutului.', 'date'));
    if (issues.length) return { effect: null, issues };

    // The principal the plan repays: the current schedule's, or what is still owed.
    const kept = current?.rows.filter((row) => row.due <= input.date) ?? [];
    const principal = current
      ? principalRows(current.rows, item.controlAccount).reduce((sum, row) => sum + row.bani, 0n)
      : owed(item);
    const keptPrincipal = principalRows(kept, item.controlAccount).reduce(
      (sum, row) => sum + row.bani,
      0n,
    );
    const { instalments, method } = planInstalments(
      input,
      principal - keptPrincipal,
      item.currency,
    );
    // The new rows continue from the last kept one, or start with the loan's interest.
    const from = start ?? kept.at(-1)?.due ?? origin?.date ?? input.date;
    const plan = loanSchedule(instalments, from, item.controlAccount, interestAccount);
    issues.push(...plan.issues);
    const rows = [...kept, ...plan.rows.filter((row) => !kept.some((old) => sameRow(old, row)))];
    if (plan.rows.some((row) => row.due <= input.date && !kept.some((old) => sameRow(old, row))))
      issues.push(
        block(
          'SCHEDULE_PAST',
          `Rândurile scadente până la ${input.date} rămân cele din graficul în vigoare.`,
          'instalments',
        ),
      );
    if (new Set(rows.map((row) => row.key)).size !== rows.length)
      issues.push(block('SCHEDULE', 'Graficul are rânduri duplicate.', 'instalments'));
    const repaid = principalRows(rows, item.controlAccount).reduce(
      (sum, row) => sum + row.bani,
      0n,
    );
    if (repaid !== principal)
      issues.push(
        block(
          'SCHEDULE_PRINCIPAL',
          `Ratele de principal însumează ${formatMoney(repaid, item.currency)} ${item.currency}, iar împrumutul este de ${formatMoney(principal, item.currency)} ${item.currency}.`,
          'instalments',
        ),
      );
    if (issues.length) return { effect: null, issues };

    const sorted = rows.sort((a, b) =>
      a.due === b.due ? (a.key < b.key ? -1 : 1) : a.due < b.due ? -1 : 1,
    );
    const effect: Effect = {
      schema: 'effect@1',
      date: input.date,
      journalClass: 'memo',
      journalCode: 'DIVERSE',
      description: `${current ? 'Grafic revizuit' : 'Grafic de rambursare'} împrumut ${account}`,
      lines: [],
      openItems: [],
      taxEntries: [],
      schedules: [
        {
          ref: current?.id ?? 'plan',
          openItem: item.id,
          version: (current?.version ?? 0) + 1,
          method,
          rows: sorted,
          basis: {
            start: from,
            evidenceId: input.evidenceId,
            ...(input.terms ? { terms: input.terms } : {}),
          },
        },
      ],
      explanation: {
        summary: `${formatMoney(principal, item.currency)} ${item.currency} în ${principalRows(sorted, item.controlAccount).length} rate, dobânda pe ${interestAccount}${current ? `; versiunea ${current.version + 1}, de la ${input.date}` : ''}.`,
        details: { account, interestAccount, version: (current?.version ?? 0) + 1 },
      },
    };
    return { effect, issues };
  },
};

export const accrualInput = z
  .object({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    /** A later round accrues what reached the month after an earlier accrual. */
    round: z.number().int().min(1).max(99).default(1),
  })
  .strict();
export type LoanAccrualInput = z.infer<typeof accrualInput>;

const interestLines = { prefixes: interestAccountCodes };

/** The loans whose schedules accrue interest month by month (not a finance lease's, booked from
 * the lessor's invoice), each with its interest account. */
function accruing(loaded: Loaded) {
  return [...loaded.openItems.values()]
    .filter((item) => isLoan(item) && item.schedule)
    .flatMap((item) => {
      const interestAccount = loanAccounts[loanAccountOf(item.controlAccount)]!.interest;
      const rows = interestRows(item.schedule!.rows, interestAccount);
      return rows.length ? [{ item, interestAccount, rows }] : [];
    })
    .sort((a, b) => (a.item.id < b.item.id ? -1 : 1));
}

/** The interest a loan has accrued so far by the lines tagged with it, in its currency. */
function accruedOf(loaded: Loaded, loan: OpenItemState) {
  let accrued = 0n;
  let openItem: string | null = null;
  for (const row of loaded.itemLines.get(itemLinesKey(interestLines)) ?? []) {
    if (row.item !== loan.id) continue;
    accrued +=
      loan.currency === LEDGER_CURRENCY ? row.credit - row.debit : row.creditMinor - row.debitMinor;
    openItem ??= row.openItem;
  }
  return { accrued, openItem };
}

/** What each loan with a schedule has to accrue through a day, in its currency: the interest its
 * schedule has accrued by then (`interestAccrued`) less what was booked for it. */
export function interestDue(loaded: Loaded, through: LocalDate) {
  return accruing(loaded).map(({ item, interestAccount, rows }) => {
    const { accrued, openItem } = accruedOf(loaded, item);
    return { item, interestAccount, openItem, due: interestAccrued(rows, through) - accrued };
  });
}

/** The read of the loans to accrue and what they accrued: every loan with its schedule, the
 * interest lines tagged with them, and the profile for the accounting rate. */
export const accrualReads: ReadPlan = {
  openItems: [{ accounts: loanAccountCodes, schedules: true }],
  itemLines: interestLines,
  profile: true,
};

/**
 * A month's interest on the loans, on its last day (OMFP 1802/2014, the functions of accounts
 * 666, 168, 519 and 455): for each loan with a schedule, the interest its periods have accrued
 * by then, each period's interest spread over its days, less what was already accrued for it:
 * Dr 666 / Cr the loan's interest account (1682, 5198, 1685, 1686, 1687, 4558), on one interest
 * item per loan, owed to the lender. A missed month is caught up and nothing is accrued twice; a
 * lower rate in a revised schedule takes back what was accrued over it. Interest in a currency is
 * accrued at the month's last accounting rate. Paying it settles the interest item, which may run
 * ahead of the accrual between month ends.
 */
export const loanAccrual: Treatment<LoanAccrualInput> = {
  id: 'loans.accrue',
  version: 1,
  description: 'Dobânda lunară a împrumuturilor (666 = 1682, 5198, 1687, 4558).',
  input: accrualInput,
  agent: true,
  subject: (input) => `loans-accrue:${input.month}:${input.round}`,
  plan: () => accrualReads,
  followUp(input, loaded) {
    const end = monthEnd(input.month as Month);
    const items = [
      ...new Set(
        (loaded.itemLines.get(itemLinesKey(interestLines)) ?? []).flatMap((row) =>
          row.openItem ? [row.openItem] : [],
        ),
      ),
    ];
    const currencies = [
      ...new Set(
        accruing(loaded)
          .map(({ item }) => item.currency)
          .filter((code) => code !== LEDGER_CURRENCY),
      ),
    ].sort();
    const plan: ReadPlan = {
      ...(items.length ? { openItems: [{ ids: items }] } : {}),
      ...(currencies.length
        ? { fx: currencies.map((currency) => ({ currency, until: end })) }
        : {}),
    };
    return plan.openItems || plan.fx ? plan : null;
  },
  evaluate(input, loaded, rules) {
    const end = monthEnd(input.month as Month);
    const issues: Issue[] = [];
    const lines: LineSpec[] = [];
    const openItems: OpenItemSpec[] = [];
    const accrued: Record<string, string>[] = [];
    let total = 0n;
    for (const { item, interestAccount, openItem, due } of interestDue(loaded, end)) {
      if (due === 0n) continue;
      let rate: FxRate | undefined;
      if (item.currency !== LEDGER_CURRENCY) {
        const selected = selectRate(loaded, rules, item.currency, end, 'accounting');
        if ('code' in selected) {
          if (!issues.some((issue) => issue.message === selected.message)) issues.push(selected);
          continue;
        }
        rate = selected;
      }
      const bani = rate
        ? convertMinor(due, item.currency, { rate: rate.rate, multiplier: rate.multiplier })
        : due;
      let target = openItem;
      if (!target) {
        target = `interest-${openItems.length}`;
        openItems.push({
          ref: target,
          kind: controlKindOf(interestAccount) as OpenItemKind,
          controlAccount: interestAccount,
          partyId: item.partyId,
          currency: item.currency,
          normalSide: 'C',
          // Paid on its due date, the interest of a period runs ahead of the month-end accrual.
          mayReverse: true,
        });
      }
      total += bani;
      lines.push(
        { account: '666', side: 'D', bani, analytics: { item: item.id } },
        {
          account: interestAccount,
          side: 'C',
          bani,
          openItem: target,
          partyId: item.partyId,
          analytics: { item: item.id },
          ...(rate
            ? { currency: { code: item.currency, minor: due, rateId: rate.id, rate: rate.rate } }
            : {}),
        },
      );
      accrued.push({
        loan: item.id,
        account: item.controlAccount,
        interestAccount,
        amount: formatMoney(due, item.currency),
        currency: item.currency,
      });
    }
    if (issues.length) return { effect: null, issues };
    if (!lines.length)
      return {
        effect: null,
        issues: [block('NOTHING_TO_ACCRUE', `Nicio dobândă de înregistrat până la ${end}.`)],
      };
    const effect: Effect = {
      schema: 'effect@1',
      date: end,
      journalClass: 'general',
      journalCode: 'DIVERSE',
      description: `Dobânzi la împrumuturi ${input.month}`,
      lines,
      openItems,
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: `${accrued.length} împrumuturi, dobândă ${formatMoney(total, LEDGER_CURRENCY)} lei până la ${end}.`,
        details: { month: input.month, accrued, clauses: [financingClauses.interest] },
      },
    };
    return { effect, issues };
  },
};

export const withholdingInput = z
  .object({
    /** The interest owed to an individual (its item on 4558, 1687, …). */
    openItem: z.uuid(),
    /** The day the interest is paid. */
    date: localDate,
    /** The gross interest paid now. */
    gross: amount,
    authorityId: z.uuid(),
  })
  .strict();
export type InterestWithholdingInput = z.infer<typeof withholdingInput>;

/**
 * The tax withheld from interest paid to an individual under a civil contract, such as an
 * associate's loan (Codul fiscal art. 97 alin. (2)): computed at payment, at the register's rate
 * (`ro.interest.tax_rate`), in whole lei; Dr the interest owed / Cr 446, owed to the tax
 * authority. The net is then paid through the bank against the same interest item. It is
 * declared in D100 (605) for the month and in D205 (tip 09) for the year. Interest paid to a
 * company is not taxed at source; to a non-resident it falls under art. 223, not supported yet.
 */
export const interestWithholding: Treatment<InterestWithholdingInput> = {
  id: 'loans.withhold',
  version: 1,
  description: 'Impozitul pe dobânzi reținut la plata dobânzii către o persoană fizică.',
  input: withholdingInput,
  agent: true,
  subject: (input) => `interest-tax:${input.openItem}:${input.date}`,
  plan: (input) => ({ openItems: [{ ids: [input.openItem] }], parties: [input.authorityId] }),
  followUp(input, loaded) {
    const item = loaded.openItems.get(input.openItem);
    return item ? { parties: [item.partyId] } : null;
  },
  evaluate(input, loaded, rules: RuleContext) {
    const issues: Issue[] = [];
    const item = loaded.openItems.get(input.openItem);
    if (!item || !interestAccountCodes.includes(loanAccountOf(item.controlAccount)))
      return {
        effect: null,
        issues: [block('INTEREST', 'Poziția nu este o dobândă datorată.', 'openItem')],
      };
    if (loaded.parties.get(input.authorityId)?.kind !== 'ro_public_institution')
      issues.push(
        block(
          'AUTHORITY',
          'Partenerul trebuie să fie autoritatea fiscală (instituție publică).',
          'authorityId',
        ),
      );
    const lender = loaded.parties.get(item.partyId);
    if (lender?.kind !== 'ro_individual')
      issues.push(
        block(
          'BENEFICIARY',
          lender?.kind === 'ro_legal_entity'
            ? 'Dobânda plătită unei persoane juridice române nu se impozitează la sursă.'
            : 'Impozitul pe dobânzile plătite nerezidenților (art. 223 din Codul fiscal) nu este încă suportat.',
          'openItem',
        ),
      );
    if (item.currency !== LEDGER_CURRENCY)
      issues.push(
        block('CURRENCY', 'Reținerea impozitului pe dobânzi în valută nu este încă suportată.'),
      );
    const gross = parseMoney(input.gross, LEDGER_CURRENCY);
    if (gross === 0n) issues.push(block('AMOUNT', 'Dobânda plătită este zero.', 'gross'));
    if (issues.length) return { effect: null, issues };

    let rate: string;
    let rounding: string;
    try {
      rate = rules.param<string>('ro.interest.tax_rate', 'payment_date', input.date, {
        beneficiary: 'individual',
      });
      rounding = rules.param<string>(
        'ro.declaration.rounding',
        'reporting_period_start',
        `${input.date.slice(0, 7)}-01` as LocalDate,
      );
    } catch (error) {
      if (!(error instanceof RuleGapError)) throw error;
      return { effect: null, issues: [block('RULE_GAP', error.message)] };
    }
    // Whole lei, half up (`half_up_leu`), on each payment.
    const tax = divRound(gross * parseScaled(rate, 4), 100_000_000n, 'halfAwayFromZero') * 100n;
    const effect: Effect = {
      schema: 'effect@1',
      date: input.date,
      journalClass: 'general',
      journalCode: 'DIVERSE',
      description: `Impozit pe dobânzi reținut ${lender!.name}`.slice(0, 500),
      lines: [
        {
          account: item.controlAccount,
          side: 'D',
          bani: tax,
          openItem: item.id,
          partyId: item.partyId,
        },
        {
          account: '446',
          side: 'C',
          bani: tax,
          openItem: 'interest-tax',
          partyId: input.authorityId,
        },
      ],
      openItems: [
        {
          ref: 'interest-tax',
          kind: 'tax.payable',
          controlAccount: '446',
          partyId: input.authorityId,
          currency: LEDGER_CURRENCY,
          normalSide: 'C',
          mayReverse: false,
        },
      ],
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: `Dobândă brută ${formatMoney(gross, LEDGER_CURRENCY)} lei, impozit ${rate}% ${formatMoney(tax, LEDGER_CURRENCY)} lei, net de plată ${formatMoney(gross - tax, LEDGER_CURRENCY)} lei.`,
        details: {
          beneficiary: 'individual',
          rate,
          rounding,
          gross: formatMoney(gross, LEDGER_CURRENCY),
          clauses: [financingClauses.withholding],
        },
      },
    };
    return { effect, issues };
  },
};
