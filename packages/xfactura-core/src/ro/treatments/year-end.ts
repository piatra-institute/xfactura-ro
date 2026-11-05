import { z } from 'zod';
import {
  financialYearOf,
  turnoverKey,
  type AccountTurnover,
  type Effect,
  type Issue,
  type LineSpec,
  type Treatment,
  type TurnoverQuery,
} from '../../kernel';
import { divRound, formatMoney, parseMoney } from '../../money';
import { isLocalDate, type LocalDate } from '../../time';

const block = (code: string, message: string, path?: string): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
});
const localDate = z.string().refine((value): boolean => isLocalDate(value));
const always = '1900-01-01' as LocalDate;
const net = (rows: readonly AccountTurnover[], prefix: string) =>
  rows
    .filter((row) => row.account.startsWith(prefix))
    .reduce((sum, row) => sum + row.credit - row.debit, 0n);

const closingQuery = (yearEnd: string): TurnoverQuery => ({
  prefixes: ['6', '7'],
  from: `${yearEnd.slice(0, 4)}-01-01` as LocalDate,
  to: yearEnd as LocalDate,
});

export const resultClosingInput = z
  .object({
    /** The last day of the financial year. */
    yearEnd: localDate,
    /** The closing note (nota contabilă de închidere). */
    evidenceId: z.uuid(),
  })
  .strict();
export type ResultClosingInput = z.infer<typeof resultClosingInput>;

/**
 * The year's result: every expense (6xx) and revenue (7xx) account brought to zero against 121 on
 * the year's last day, in the closing journal, so the next year opens with none of them. A
 * later entry of the year in classes 6 or 7 makes it stale.
 */
export const resultClosing: Treatment<ResultClosingInput> = {
  id: 'year.closeResult',
  version: 1,
  description:
    'Închiderea conturilor de cheltuieli și venituri în contul 121 la sfârșitul exercițiului.',
  input: resultClosingInput,
  agent: true,
  summary: 'Year-end closing of the expense and revenue accounts into account 121.',
  toolset: 'close',
  subject: (input) => `year-result:${input.yearEnd}`,
  plan: (input) => ({ evidence: [input.evidenceId], turnover: [closingQuery(input.yearEnd)] }),
  evaluate(input, loaded) {
    const issues: Issue[] = [];
    const year = financialYearOf(loaded, input.yearEnd as LocalDate);
    if (!year || year.to !== input.yearEnd)
      return {
        effect: null,
        issues: [
          block('YEAR_END', 'Data nu este ultima zi a unui exercițiu financiar.', 'yearEnd'),
        ],
      };
    // The closing reads the calendar year: a modified financial year is not supported yet.
    if (year.from !== closingQuery(input.yearEnd).from)
      return {
        effect: null,
        issues: [block('YEAR_START', 'Exercițiile financiare modificate nu sunt încă suportate.')],
      };
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(block('EVIDENCE', 'Documentul justificativ nu este disponibil.', 'evidenceId'));
    const rows = (loaded.turnover.get(turnoverKey(closingQuery(input.yearEnd))) ?? []).filter(
      (row) => row.debit !== row.credit,
    );
    if (!rows.length)
      issues.push(
        block('NOTHING_TO_CLOSE', 'Conturile de cheltuieli și venituri sunt deja închise.'),
      );
    if (issues.length) return { effect: null, issues };

    const lines: LineSpec[] = rows.map((row) => {
      const balance = row.debit - row.credit;
      return {
        account: row.account,
        side: balance > 0n ? 'C' : 'D',
        bani: balance > 0n ? balance : -balance,
      };
    });
    const result = rows.reduce((sum, row) => sum + row.credit - row.debit, 0n);
    if (result !== 0n)
      lines.push({
        account: '121',
        side: result > 0n ? 'C' : 'D',
        bani: result > 0n ? result : -result,
      });
    const effect: Effect = {
      schema: 'effect@1',
      date: input.yearEnd as LocalDate,
      journalClass: 'general',
      journalCode: 'INCHIDERE',
      description: `Închiderea conturilor de venituri și cheltuieli ${year.from.slice(0, 4)}`,
      lines,
      openItems: [],
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: `${result >= 0n ? 'Profit' : 'Pierdere'} ${formatMoney(result >= 0n ? result : -result, 'RON')} lei din ${rows.length} conturi.`,
        details: {
          year: year.from.slice(0, 4),
          revenue: formatMoney(net(rows, '7'), 'RON'),
          expenses: formatMoney(-net(rows, '6'), 'RON'),
          result: formatMoney(result, 'RON'),
        },
      },
    };
    return { effect, issues };
  },
};

export const legalReserveInput = z
  .object({
    yearEnd: localDate,
    /** The share of the year's profit set aside, in lei. */
    amount: z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/),
    evidenceId: z.uuid(),
  })
  .strict();
export type LegalReserveInput = z.infer<typeof legalReserveInput>;

const reserveQueries = (yearEnd: string) => ({
  balances: {
    prefixes: ['1012', '1061'],
    from: always,
    to: yearEnd as LocalDate,
  } satisfies TurnoverQuery,
  // The year's own result: what its closing (INCHIDERE, on the year's last day) brought into 121.
  // The year's other 121 entries are the previous year's result, moved out once its statements
  // were approved (`year.transferResult`, dated after that year's end, within this one).
  result: {
    prefixes: ['121'],
    from: yearEnd as LocalDate,
    to: yearEnd as LocalDate,
  } satisfies TurnoverQuery,
});

/**
 * The legal reserve set aside from the year's profit on its last day (Dr 129 / Cr 1061): at least
 * 5% of the profit each year until the reserve reaches a fifth of the share capital (Legea nr.
 * 31/1990 art. 183 alin. (1)). The law does not say whether the profit is before or after income
 * tax, so the amount is the company's; a share below 5% of the year's result (what its closing
 * brought into 121) asks the reviewer to confirm it.
 */
export const legalReserve: Treatment<LegalReserveInput> = {
  id: 'year.legalReserve',
  version: 1,
  description:
    'Constituirea rezervei legale din profitul exercițiului (art. 183 din Legea nr. 31/1990).',
  input: legalReserveInput,
  agent: true,
  summary: "Legal reserve set up from the year's profit (art. 183 of Law 31/1990).",
  toolset: 'close',
  subject: (input) => `legal-reserve:${input.yearEnd}`,
  plan: (input) => {
    const { balances, result } = reserveQueries(input.yearEnd);
    return { evidence: [input.evidenceId], turnover: [balances, result] };
  },
  evaluate(input, loaded) {
    const issues: Issue[] = [];
    const { balances, result } = reserveQueries(input.yearEnd);
    const year = financialYearOf(loaded, input.yearEnd as LocalDate);
    if (!year || year.to !== input.yearEnd)
      issues.push(
        block('YEAR_END', 'Data nu este ultima zi a unui exercițiu financiar.', 'yearEnd'),
      );
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(block('EVIDENCE', 'Documentul justificativ nu este disponibil.', 'evidenceId'));
    const profit = net(loaded.turnover.get(turnoverKey(result)) ?? [], '121');
    if (profit <= 0n)
      issues.push(
        block(
          'NO_PROFIT',
          'Exercițiul nu are profit închis în contul 121 (închideți întâi conturile de rezultat).',
        ),
      );
    const amount = parseMoney(input.amount, 'RON');
    if (amount <= 0n) issues.push(block('AMOUNT', 'Suma rezervei este zero.', 'amount'));
    if (issues.length) return { effect: null, issues };

    const rows = loaded.turnover.get(turnoverKey(balances)) ?? [];
    const capital = net(rows, '1012');
    const reserve = net(rows, '1061');
    const cap = divRound(capital, 5n, 'ceiling');
    const minimum = divRound(profit * 5n, 100n, 'ceiling');
    const acks: Issue[] =
      amount < minimum && reserve + amount < cap
        ? [
            {
              code: 'LEGAL_RESERVE',
              severity: 'ack',
              message: `Rezerva legală se constituie din cel puțin 5% din profit (${formatMoney(minimum, 'RON')} lei din rezultatul din 121) până la o cincime din capitalul social (${formatMoney(cap, 'RON')} lei): confirmați suma.`,
            },
          ]
        : [];
    const effect: Effect = {
      schema: 'effect@1',
      date: input.yearEnd as LocalDate,
      journalClass: 'general',
      journalCode: 'INCHIDERE',
      description: `Rezerva legală ${year!.from.slice(0, 4)}`,
      lines: [
        { account: '129', side: 'D', bani: amount },
        { account: '1061', side: 'C', bani: amount },
      ],
      openItems: [],
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: `Rezervă legală ${formatMoney(amount, 'RON')} lei din profitul de ${formatMoney(profit, 'RON')} lei; rezerva ajunge la ${formatMoney(reserve + amount, 'RON')} lei din plafonul de ${formatMoney(cap, 'RON')} lei.`,
        details: {
          profit: formatMoney(profit, 'RON'),
          capital: formatMoney(capital, 'RON'),
          clause: 'L31/1990:art.183',
        },
      },
    };
    return { effect, issues: acks };
  },
};

export const resultTransferInput = z
  .object({
    /** The closed year's last day. */
    yearEnd: localDate,
    /** The date the shareholders approved the annual financial statements. */
    date: localDate,
    /** The shareholders' decision approving them and the profit's allocation. */
    evidenceId: z.uuid(),
  })
  .strict();
export type ResultTransferInput = z.infer<typeof resultTransferInput>;

const transferQuery = (input: ResultTransferInput): TurnoverQuery => ({
  prefixes: ['121', '129'],
  from: always,
  to: input.date as LocalDate,
});

/**
 * Once the shareholders approve the year's financial statements, the year's result leaves 121:
 * the allocations already made (129) are cleared against it, and what remains of the profit goes
 * to retained earnings (1171), from which dividends are distributed; a loss is carried there too.
 */
export const resultTransfer: Treatment<ResultTransferInput> = {
  id: 'year.transferResult',
  version: 1,
  description:
    'Repartizarea rezultatului exercițiului încheiat, după aprobarea situațiilor financiare.',
  input: resultTransferInput,
  agent: true,
  summary: "Distribution of the closed year's result after the financial statements are approved.",
  toolset: 'close',
  subject: (input) => `year-transfer:${input.yearEnd}`,
  plan: (input) => ({ evidence: [input.evidenceId], turnover: [transferQuery(input)] }),
  evaluate(input, loaded) {
    const issues: Issue[] = [];
    if (input.date <= input.yearEnd)
      issues.push(
        block('DATE', 'Rezultatul se repartizează după încheierea exercițiului.', 'date'),
      );
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(block('EVIDENCE', 'Hotărârea asociaților nu este disponibilă.', 'evidenceId'));
    const rows = loaded.turnover.get(turnoverKey(transferQuery(input))) ?? [];
    const result = net(rows, '121');
    const allocated = -net(rows, '129');
    if (result === 0n && allocated === 0n)
      issues.push(block('NOTHING_TO_TRANSFER', 'Contul 121 nu are rezultat de repartizat.'));
    if (issues.length) return { effect: null, issues };

    const lines: LineSpec[] = [];
    if (allocated !== 0n)
      lines.push(
        { account: '121', side: 'D', bani: allocated },
        { account: '129', side: 'C', bani: allocated },
      );
    const remaining = result - allocated;
    if (remaining > 0n)
      lines.push(
        { account: '121', side: 'D', bani: remaining },
        { account: '1171', side: 'C', bani: remaining },
      );
    if (remaining < 0n)
      lines.push(
        { account: '1171', side: 'D', bani: -remaining },
        { account: '121', side: 'C', bani: -remaining },
      );
    const effect: Effect = {
      schema: 'effect@1',
      date: input.date as LocalDate,
      journalClass: 'general',
      journalCode: 'DIVERSE',
      description: `Repartizarea rezultatului exercițiului încheiat la ${input.yearEnd}`,
      lines,
      openItems: [],
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: `Rezultat ${formatMoney(result, 'RON')} lei: ${formatMoney(allocated, 'RON')} lei repartizați în exercițiu, ${formatMoney(remaining, 'RON')} lei în rezultatul reportat.`,
        details: { yearEnd: input.yearEnd },
      },
    };
    return { effect, issues };
  },
};
