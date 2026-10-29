import { z } from 'zod';
import {
  accountCodePattern,
  profileAt,
  turnoverKey,
  type AccountTurnover,
  type Effect,
  type Issue,
  type Treatment,
  type TurnoverQuery,
} from '../../kernel';
import { divRound, formatMoney, parseMoney, parseScaled } from '../../money';
import { RuleGapError } from '../../rules';
import { addDays, isLocalDate, type LocalDate } from '../../time';

const block = (code: string, message: string, path?: string): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
});
const ack = (code: string, message: string): Issue => ({ code, severity: 'ack', message });
const CLAUSE = 'ANAF/Cod-fiscal-consolidat';

/** Revenues art. 53 alin. (1) excludes by their nature, by the account that records them. */
const excludedAccounts: [prefix: string, letter: string][] = [
  ['711', 'a'],
  ['712', 'b'],
  ['721', 'c'],
  ['722', 'c'],
  ['725', 'c'],
  ['741', 'd'],
  ['7584', 'd'],
  ['765', 'h'],
];
/** Accounts whose revenues are excluded only in some cases (provision reversals once
 * non-deductible, compensation for damaged assets, FX-indexed financial revenue, dividends from
 * Romanian companies…): each needs a determination when it has revenue in the quarter. */
const determinedAccounts = ['781', '786', '7581', '7588', '768', '761', '762'];
export const microLetters = ['e', 'f', 'g', 'i', 'k', 'l', 'm', 'n', 'o', 'p'] as const;

export const microTaxInput = z
  .object({
    quarter: z.string().regex(/^\d{4}-Q[1-4]$/),
    /** The posting date, on or after the quarter's end. */
    date: z.string().refine((value): boolean => isLocalDate(value)),
    authorityId: z.uuid(),
    round: z.number().int().min(1).max(99).default(1),
    determinations: z
      .array(
        z
          .object({
            account: z.string().regex(accountCodePattern),
            /** The letter of art. 53 alin. (1) under which `excluded` leaves the base; null when
             * nothing on the account is excluded. */
            letter: z.enum(microLetters).nullable(),
            excluded: z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/),
            evidenceId: z.uuid(),
          })
          .strict(),
      )
      .max(50)
      .default([]),
  })
  .strict();
export type MicroTaxInput = z.infer<typeof microTaxInput>;

function quarterRange(quarter: string) {
  const year = Number(quarter.slice(0, 4));
  const index = Number(quarter.slice(6));
  const month = (n: number) => String(n).padStart(2, '0');
  const from = `${year}-${month(index * 3 - 2)}-01` as LocalDate;
  const to = addDays(
    `${index === 4 ? year + 1 : year}-${month(index === 4 ? 1 : index * 3 + 1)}-01` as LocalDate,
    -1,
  );
  return {
    year,
    index,
    from,
    to,
    yearStart: `${year}-01-01` as LocalDate,
    before: `${year - 1}-12-31` as LocalDate,
  };
}

const queries = (quarter: string) => {
  const range = quarterRange(quarter);
  const inQuarter: TurnoverQuery = { prefixes: ['6', '7'], from: range.from, to: range.to };
  const yearToDate: TurnoverQuery = { prefixes: ['6', '7'], from: range.yearStart, to: range.to };
  return { range, inQuarter, yearToDate };
};

/** Net credit (revenue) or net debit (expense) of the accounts under `prefix`. */
const net = (rows: readonly AccountTurnover[], prefix: string, side: 'C' | 'D' = 'C') =>
  rows
    .filter((row) => row.account.startsWith(prefix))
    .reduce(
      (sum, row) => sum + (side === 'C' ? row.credit - row.debit : row.debit - row.credit),
      0n,
    );

/**
 * The quarterly tax on a micro-enterprise's revenues (Codul fiscal title III): 1% of the
 * quarter's revenues of any source, less those art. 53 alin. (1) excludes and plus those its
 * alin. (2) adds, while the year's turnover stays within the limit. Books the tax (698 = 4418)
 * as owed to the tax authority.
 */
export const microTax: Treatment<MicroTaxInput> = {
  id: 'tax.micro',
  version: 1,
  description: 'Impozitul pe veniturile microîntreprinderii pentru un trimestru.',
  input: microTaxInput,
  agent: true,
  subject: (input) => `micro:${input.quarter}:${input.round}`,
  plan: (input) => {
    const { range, inQuarter, yearToDate } = queries(input.quarter);
    return {
      turnover: [inQuarter, yearToDate],
      parties: [input.authorityId],
      evidence: input.determinations.map((item) => item.evidenceId),
      profile: true,
      fx: [{ currency: 'EUR', until: range.before }],
    };
  },
  evaluate(input, loaded, rules) {
    const issues: Issue[] = [];
    const { range, inQuarter, yearToDate } = queries(input.quarter);
    if (input.date < range.to)
      issues.push(
        block(
          'TAX_DATE',
          `Impozitul se calculează după încheierea trimestrului (${range.to}).`,
          'date',
        ),
      );
    if (profileAt(loaded, 'income_tax', range.to) !== 'micro')
      issues.push(
        block(
          'NOT_MICRO',
          'Compania nu este înregistrată ca plătitoare de impozit pe veniturile microîntreprinderilor.',
        ),
      );
    if (loaded.parties.get(input.authorityId)?.kind !== 'ro_public_institution')
      issues.push(
        block(
          'AUTHORITY',
          'Partenerul trebuie să fie autoritatea fiscală (instituție publică).',
          'authorityId',
        ),
      );
    for (const [index, item] of input.determinations.entries())
      if (!loaded.evidence.has(item.evidenceId))
        issues.push(
          block(
            'EVIDENCE',
            'Documentul justificativ nu este disponibil.',
            `determinations.${index}.evidenceId`,
          ),
        );

    let rate: string;
    let limit: string;
    try {
      rate = rules.param<string>('ro.micro.rate', 'reporting_period_start', range.from);
      limit = rules.param<string>(
        'ro.micro.revenue_limit_eur',
        'reporting_period_start',
        range.from,
      );
    } catch (error) {
      if (!(error instanceof RuleGapError)) throw error;
      return { effect: null, issues: [...issues, block('RULE_GAP', error.message)] };
    }

    const quarter = loaded.turnover.get(turnoverKey(inQuarter)) ?? [];
    const year = loaded.turnover.get(turnoverKey(yearToDate)) ?? [];

    // The year's turnover (70x, net of 709) against the limit, at the previous year-end rate.
    const euro = loaded.fxRates.get('EUR')?.[0];
    const turnover = net(year, '70');
    if (!euro) issues.push(block('FX_RATE', `Lipsește cursul EUR de la ${range.before}.`));
    else {
      const limitBani = divRound(
        BigInt(limit) * 100n * parseScaled(euro.rate, 4),
        10_000n * BigInt(euro.multiplier),
        'halfAwayFromZero',
      );
      if (turnover > limitBani)
        issues.push(
          block(
            'MICRO_LIMIT',
            `Cifra de afaceri a anului (${formatMoney(turnover, 'RON')} lei) depășește ${limit} euro (${formatMoney(limitBani, 'RON')} lei): din acest trimestru se datorează impozit pe profit.`,
          ),
        );
    }

    // Revenues the law excludes only in some cases must be determined, account by account.
    const determined = new Map(input.determinations.map((item) => [item.account, item]));
    for (const prefix of determinedAccounts)
      for (const row of quarter.filter((item) => item.account.startsWith(prefix)))
        if (row.credit - row.debit !== 0n && !determined.has(row.account))
          issues.push(
            block(
              'MICRO_DETERMINATION',
              `Veniturile din contul ${row.account} se scad din baza impozabilă doar în anumite cazuri (art. 53 alin. (1)): stabiliți cât se scade.`,
            ),
          );
    for (const [index, item] of input.determinations.entries()) {
      const excluded = parseMoney(item.excluded, 'RON');
      if (excluded > net(quarter, item.account) || (item.letter === null && excluded !== 0n))
        issues.push(
          block(
            'MICRO_DETERMINATION',
            `Suma scăzută din contul ${item.account} depășește veniturile lui din trimestru sau nu are temei.`,
            `determinations.${index}`,
          ),
        );
    }
    issues.push(
      ack(
        'MICRO_EMPLOYEE',
        'Confirmați că microîntreprinderea a avut în trimestru cel puțin un salariat cu normă întreagă sau echivalent (art. 47 alin. (1) lit. g)).',
      ),
    );
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };

    const revenue = net(quarter, '7');
    const exclusions = excludedAccounts
      .map(([prefix, letter]) => ({ letter, account: prefix, bani: net(quarter, prefix) }))
      .filter((item) => item.bani !== 0n);
    const decided = input.determinations
      .filter((item) => item.letter)
      .map((item) => ({
        letter: item.letter!,
        account: item.account,
        bani: parseMoney(item.excluded, 'RON'),
      }));
    const discounts = net(quarter, '609');
    const fxGain = range.index === 4 ? net(year, '765') - net(year, '665', 'D') : 0n;
    const additions = [
      ...(discounts > 0n ? [{ letter: 'a', account: '609', bani: discounts }] : []),
      ...(fxGain > 0n ? [{ letter: 'b', account: '765-665', bani: fxGain }] : []),
    ];
    const base =
      [...exclusions, ...decided].reduce((sum, item) => sum - item.bani, revenue) +
      additions.reduce((sum, item) => sum + item.bani, 0n);
    // Whole lei: the base half up, then the tax on it.
    const baseLei = base > 0n ? divRound(base, 100n, 'halfAwayFromZero') : 0n;
    const tax = divRound(baseLei * parseScaled(rate, 4), 1_000_000n, 'halfAwayFromZero') * 100n;
    if (tax === 0n)
      return {
        effect: null,
        issues: [
          ...issues,
          block(
            'ZERO_TAX',
            `Impozitul trimestrului ${input.quarter} este zero: nu se înregistrează nimic (declarația se depune).`,
          ),
        ],
      };

    const effect: Effect = {
      schema: 'effect@1',
      date: input.date as LocalDate,
      journalClass: 'general',
      journalCode: 'IMPOZITE',
      description: `Impozit pe veniturile microîntreprinderii ${input.quarter}${input.round > 1 ? ` (runda ${input.round})` : ''}`,
      lines: [
        { account: '698', side: 'D', bani: tax },
        { account: '4418', side: 'C', bani: tax, openItem: 'micro', partyId: input.authorityId },
      ],
      openItems: [
        {
          ref: 'micro',
          kind: 'tax.payable',
          controlAccount: '4418',
          partyId: input.authorityId,
          currency: 'RON',
          normalSide: 'C',
          mayReverse: false,
        },
      ],
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: `Venituri ${formatMoney(revenue, 'RON')} lei, bază ${baseLei} lei, impozit ${rate}%: ${formatMoney(tax, 'RON')} lei.`,
        details: {
          quarter: input.quarter,
          revenue: formatMoney(revenue, 'RON'),
          exclusions: [...exclusions, ...decided].map((item) => ({
            letter: item.letter,
            account: item.account,
            amount: formatMoney(item.bani, 'RON'),
          })),
          additions: additions.map((item) => ({
            letter: item.letter,
            account: item.account,
            amount: formatMoney(item.bani, 'RON'),
          })),
          base: String(baseLei),
          rate,
          turnover: formatMoney(turnover, 'RON'),
          clauses: [`${CLAUSE}:art.51(1)`, `${CLAUSE}:art.53`, `${CLAUSE}:art.52(1),(5)`],
        },
      },
    };
    return { effect, issues };
  },
};

/** A quarter's dates: its first and last day, the year's start and the previous year's end. */
export const microQuarterRange = (quarter: string) => quarterRange(quarter);
