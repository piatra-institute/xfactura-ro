import { z } from 'zod';
import {
  profileAt,
  turnoverKey,
  type AccountTurnover,
  type AnswerRecord,
  type Effect,
  type FxRate,
  type Issue,
  type JsonValue,
  type Loaded,
  type ReadPlan,
  type Treatment,
  type TurnoverQuery,
} from '../../kernel';
import { divRound, formatMoney, parseMoney, parseScaled } from '../../money';
import {
  normalizePlate,
  questionIssue,
  questionKinds,
  type ProfitAccountAnswer,
  type ProfitLossesAnswer,
} from '../../questions/kinds';
import { RuleGapError, type RuleContext } from '../../rules';
import { addDays, isLocalDate, type LocalDate } from '../../time';
import { deriveD101Rows, type D101Rows } from '../declarations/d101';
import {
  computeBridge,
  determinationInput,
  rowsJson,
  rowsOf,
  type BridgeBooks,
  type BridgeLine,
  type BridgePeriod,
  type BridgeResult,
} from '../profit/bridge';
import { recoverLosses, type LossVintage } from '../profit/losses';
import type { InterestCeiling, MinimumTax } from '../profit/parameters';
import { vehicleAnswer, vehicleDeduction } from '../vehicles';
import { taxDue } from './due';

/*
 * The profit tax of a Romanian legal person (Codul fiscal title II) under the quarterly system
 * (art. 41 alin. (1)): each of the first three quarters, the tax on the fiscal result cumulated
 * from the year's start (or from the quarter the company left the micro-enterprise regime in,
 * art. 52 alin. (6)), less what the earlier quarters declared; the year's own computation, by
 * 31 December in the year's books, settles the year (the annual return, D101, by 25 June).
 * Booked 691 = 4411, owed to the tax authority; a year that owes less than its quarters
 * declared books the difference back (4411 = 691). Every computation is posted, a quarter or a
 * year with nothing to book as a memorandum: the position it records (the bridge's rows, the
 * loss vintages) is what the returns and the fiscal register are read from.
 *
 * A prior-year correction booked on 1174 (`correction.priorYear`) changes the corrected year's
 * fiscal result (art. 19 alin. (3) lit. a)): the year's rectification recomputes its tax from
 * its last position and books the difference on 1174.
 */

const CODE = 'ANAF/Cod-fiscal-consolidat';
const POSITION = 'profit-position@1';
const localDate = z.string().refine((value): boolean => isLocalDate(value));
const block = (code: string, message: string, path?: string, details?: JsonValue): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
  ...(details === undefined ? {} : { details }),
});
const ron = (bani: bigint) => formatMoney(bani, 'RON');
const pad = (value: number) => String(value).padStart(2, '0');

export const profitTaxInput = z
  .object({
    /** A quarter of the quarterly system (the first three: the fourth is the year's), or the
     * year. */
    period: z.string().regex(/^\d{4}(-Q[1-3])?$/),
    /** The posting date: from the quarter's end to the year's end for a quarter; the year's last
     * day for the year; for a rectification, a day of a later year. */
    date: localDate,
    authorityId: z.uuid(),
    round: z.number().int().min(1).max(99).default(1),
    /** Amounts the books do not hold apart, each with its document (`profit/bridge.ts`). */
    determinations: z.array(determinationInput).max(50).default([]),
    /** The decision or policy setting aside the legal reserve (Legea nr. 31/1990 art. 183): its
     * deductible part, 5% of the accounting profit plus the tax until it reaches a fifth of the
     * capital, is deducted (art. 26 alin. (1) lit. a)). */
    legalReserve: z.object({ evidenceId: z.uuid() }).strict().optional(),
    /** A closed year's rectification after prior-year corrections booked on 1174. */
    rectification: z.boolean().default(false),
  })
  .strict()
  .refine((input) => !input.rectification || /^\d{4}$/.test(input.period), {
    message: 'Se rectifică doar impozitul unui an.',
    path: ['rectification'],
  });
export type ProfitTaxInput = z.infer<typeof profitTaxInput>;

interface Period {
  year: number;
  /** 1–3, or null for the year. */
  quarter: number | null;
  yearStart: LocalDate;
  end: LocalDate;
  before: LocalDate;
}

function periodOf(label: string): Period {
  const year = Number(label.slice(0, 4));
  const quarter = label.length > 4 ? Number(label.slice(6)) : null;
  const endMonth = quarter === null ? 12 : quarter * 3;
  const end = addDays(
    (endMonth === 12 ? `${year + 1}-01-01` : `${year}-${pad(endMonth + 1)}-01`) as LocalDate,
    -1,
  );
  return {
    year,
    quarter,
    yearStart: `${year}-01-01` as LocalDate,
    end,
    before: `${year - 1}-12-31` as LocalDate,
  };
}

const quarterStartOf = (date: string) =>
  `${date.slice(0, 4)}-${pad(Math.floor((Number(date.slice(5, 7)) - 1) / 3) * 3 + 1)}-01` as LocalDate;

/**
 * Where the profit tax of the year starts: 1 January, or the first day of the quarter in which
 * the recorded `income_tax` became `profit` during the year (art. 52 alin. (1)–(4), (7)).
 */
function regimeOf(loaded: Loaded, period: Period) {
  const atStart = profileAt(loaded, 'income_tax', period.yearStart);
  const atEnd = profileAt(loaded, 'income_tax', period.end);
  const change = loaded.profile
    .filter(
      (fact) =>
        fact.axis === 'income_tax' &&
        fact.value === 'profit' &&
        fact.effectiveFrom > period.yearStart &&
        fact.effectiveFrom <= period.end,
    )
    .map((fact) => fact.effectiveFrom)
    .sort()
    .at(-1);
  const start = atStart === 'profit' || !change ? period.yearStart : (change as LocalDate);
  return {
    atStart,
    atEnd,
    start,
    exitQuarter:
      atStart === 'micro' && change
        ? (Math.ceil(Number(change.slice(5, 7)) / 3) as 1 | 2 | 3 | 4)
        : null,
  };
}

/** The reads that depend on what the first read found: the period's start. */
function booksQueries(period: Period, start: LocalDate) {
  const always = '1900-01-01' as LocalDate;
  return {
    result: { prefixes: ['6', '7', '121'], from: start, to: period.end } satisfies TurnoverQuery,
    capital: { prefixes: ['1012'], from: always, to: period.end } satisfies TurnoverQuery,
    reserve: { prefixes: ['1061'], from: always, to: period.before } satisfies TurnoverQuery,
    microFx: {
      prefixes: ['765', '665'],
      from: period.yearStart,
      to: addDays(start, -1),
    } satisfies TurnoverQuery,
    previous: {
      prefixes: ['70'],
      from: `${period.year - 1}-01-01` as LocalDate,
      to: period.before,
    } satisfies TurnoverQuery,
  };
}

/** The latest answer per subject of a kind the basis cites, read by its schema. */
function answersOf<T>(loaded: Loaded, kind: keyof typeof questionKinds) {
  const schema = questionKinds[kind].answer({} as never);
  const latest = new Map<string, { record: AnswerRecord; value: T }>();
  for (const record of loaded.answers.values()) {
    if (record.kind !== kind) continue;
    const parsed = schema.safeParse(record.value);
    if (!parsed.success) continue;
    const known = latest.get(record.subject.id);
    if (
      !known ||
      known.record.answeredAt < record.answeredAt ||
      (known.record.answeredAt === record.answeredAt && known.record.answerId < record.answerId)
    )
      latest.set(record.subject.id, { record, value: parsed.data as T });
  }
  return latest;
}

/** A position as an earlier posting recorded it. */
export interface ProfitPosition {
  schema: typeof POSITION;
  kind: 'quarter' | 'year' | 'rectification';
  period: string;
  year: number;
  start: string;
  end: string;
  microExitQuarter: number | null;
  rows: Record<string, string>;
  /** The tax due for the period (lei): the year's or the quarter's, before what was declared. */
  tax: { cumulative: string; declared: string; due: string };
  losses: {
    before: { year: number; amount: string; remaining: string }[];
    after: { year: number; amount: string; remaining: string }[];
    used: { year: number; amount: string }[];
  };
}

/** A prior-year correction's fiscal effect, as `correction.priorYear` records it. */
export interface CorrectionPosition {
  schema: 'profit-correction@1';
  year: number;
  /** The change in the corrected year's taxable result, in lei (negative: an expense omitted). */
  change: string;
  description: string;
}

const vintagesJson = (items: readonly LossVintage[]) =>
  items.map((item) => ({
    year: item.year,
    amount: item.amount.toString(),
    remaining: item.remaining.toString(),
  }));
const vintagesOf = (items: ProfitPosition['losses']['after']) =>
  items.map((item) => ({
    year: item.year,
    amount: BigInt(item.amount),
    remaining: BigInt(item.remaining),
  }));

/** The positions that stand, in posting order, of the profit tax. */
export function positionsOf(loaded: Loaded) {
  return loaded.profitPostings.flatMap((posting) => {
    const position = posting.position as unknown as ProfitPosition | CorrectionPosition | null;
    return position && typeof position === 'object' && 'schema' in position
      ? [{ posting, position }]
      : [];
  });
}

/** The latest position of each period label (rectifications replace the year's). */
function latestPositions(loaded: Loaded) {
  const latest = new Map<string, ProfitPosition>();
  for (const { position } of positionsOf(loaded))
    if (position.schema === POSITION) latest.set(position.period, position);
  return latest;
}

/** The BNR EUR rate valid on a day: the latest published on or before it, at most 7 days old. */
function eurOn(rates: readonly FxRate[] | undefined, day: LocalDate) {
  const rate = rates?.find((item) => item.date <= day);
  return rate && rate.date >= addDays(day, -7) ? rate : null;
}
const euroInLei = (euro: string, rate: FxRate) =>
  divRound(
    BigInt(euro) * 100n * parseScaled(rate.rate, 4),
    10_000n * BigInt(rate.multiplier),
    'halfAwayFromZero',
  );

/**
 * The turnover of a year the books do not keep, as the latest cited answer about its figures
 * states it (`year.figures`: its `turnover`, else its `netTurnover`), in bani; null without one.
 */
function statedTurnover(loaded: Loaded, year: number): bigint | null {
  const stated = [...loaded.answers.values()]
    .filter((record) => record.kind === 'year.figures' && record.subject.id === String(year))
    .sort((a, b) => (`${a.answeredAt}|${a.answerId}` < `${b.answeredAt}|${b.answerId}` ? -1 : 1))
    .flatMap((record) => {
      const values = (record.value as { values?: Record<string, JsonValue> } | null)?.values ?? {};
      const figure = values.turnover ?? values.netTurnover;
      return typeof figure === 'string' && /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/.test(figure)
        ? [parseMoney(figure, 'RON')]
        : [];
    });
  return stated.at(-1) ?? null;
}

/** The scope checks the bridge does not make: the minimum turnover tax and the interest limit. */
function scopeIssues(
  loaded: Loaded,
  rules: RuleContext,
  period: Period,
  start: LocalDate,
  rows: readonly AccountTurnover[],
): Issue[] {
  const issues: Issue[] = [];
  const queries = booksQueries(period, start);
  const rates = loaded.fxRates.get('EUR');
  // Art. 18^1: above 50 million euro of turnover the year before, the minimum turnover tax.
  const minimum = rules.param<MinimumTax>(
    'ro.profit.minimum_tax',
    'fiscal_year_start',
    period.yearStart,
  );
  const kept = loaded.years.some((year) => year.kind === 'financial' && year.to === period.before);
  // The previous year's turnover: the books' gross 70x credits when they keep the year, else what
  // a cited answer about it states (`year.figures`).
  const gross = kept
    ? (loaded.turnover.get(turnoverKey(queries.previous)) ?? [])
        .filter((row) => !row.account.startsWith('709'))
        .reduce((sum, row) => sum + row.credit, 0n)
    : statedTurnover(loaded, period.year - 1);
  if (gross === null)
    issues.push({
      code: 'PROFIT_MINIMUM_TAX',
      severity: 'ack',
      message: `Impozitul minim pe cifra de afaceri (art. 18^1) se aplică celor cu o cifră de afaceri în anul precedent de peste ${minimum.turnoverEur} euro; registrele nu cuprind anul ${period.year - 1}: confirmați că cifra lui de afaceri nu a depășit pragul, sau citați răspunsul despre cifrele anului (year.figures, turnover).`,
      details: { clause: `${CODE}:art.18^1(1),(17)` },
    });
  else {
    const rate = eurOn(rates, period.before);
    if (gross > 0n && !rate)
      issues.push(
        block('FX_RATE', `Lipsește cursul EUR de la ${period.before} (art. 18^1 alin. (1)).`),
      );
    else if (rate && gross > euroInLei(minimum.turnoverEur, rate))
      issues.push(
        block(
          'PROFIT_MINIMUM_TAX',
          `Cifra de afaceri a anului ${period.year - 1} depășește ${minimum.turnoverEur} euro: impozitul minim pe cifra de afaceri (art. 18^1) nu este acoperit.`,
        ),
      );
  }
  // Art. 40^2: exceeding borrowing costs are deductible up to 500,000 euro (from affiliated
  // persons) and 1,000,000 euro in all; beyond, 30% of a base this module does not compute.
  const ceiling = rules.param<InterestCeiling>(
    'ro.profit.interest_ceiling',
    'reporting_period_start',
    start,
  );
  const net = (prefix: string, side: 'D' | 'C') =>
    rows
      .filter((row) => row.account.startsWith(prefix))
      .reduce(
        (sum, row) => sum + (side === 'D' ? row.debit - row.credit : row.credit - row.debit),
        0n,
      );
  const exceeding = net('666', 'D') - net('766', 'C');
  if (exceeding > 0n) {
    const rate = eurOn(rates, period.end);
    if (!rate)
      issues.push(
        block('FX_RATE', `Lipsește cursul EUR de la ${period.end} (art. 40^2 alin. (4)).`),
      );
    else if (exceeding > euroInLei(ceiling.affiliatedEur, rate))
      issues.push(
        block(
          'PROFIT_INTEREST_LIMIT',
          `Costurile excedentare ale îndatorării (${ron(exceeding)} lei) depășesc ${ceiling.affiliatedEur} euro: limitarea deducerii lor (art. 40^2) nu este acoperită.`,
        ),
      );
  }
  return issues;
}

/**
 * The quarterly or annual profit tax: the bridge from the accounting result to the fiscal result
 * (`profit/bridge.ts`), the losses recovered, the sponsorship credit, the tax and what the
 * earlier quarters declared.
 */
export const profitTax: Treatment<ProfitTaxInput> = {
  id: 'tax.profit',
  version: 1,
  description:
    'Impozitul pe profit al unui trimestru (sistemul trimestrial) sau al anului, din rezultatul contabil ajustat fiscal.',
  input: profitTaxInput,
  agent: true,
  summary:
    'Profit tax for a quarter (quarterly system) or the year: the bridge from the accounting result to the fiscal result, losses recovered, sponsorship credit and the tax booked.',
  toolset: 'tax',
  dataClasses: ['books', 'tax'],
  subject: (input) => `profit:${input.period}${input.rectification ? ':rect' : ''}:${input.round}`,
  plan: (input) => {
    const period = periodOf(input.period);
    return {
      profile: true,
      profitPostings: true,
      assets: true,
      parties: [input.authorityId],
      evidence: [
        ...input.determinations.map((item) => item.evidenceId),
        ...(input.legalReserve ? [input.legalReserve.evidenceId] : []),
      ],
      fx: [
        { currency: 'EUR', until: period.end },
        { currency: 'EUR', until: period.before },
      ],
    };
  },
  followUp(input, loaded): ReadPlan | null {
    if (input.rectification) return null;
    const period = periodOf(input.period);
    const { start } = regimeOf(loaded, period);
    const queries = booksQueries(period, start);
    return {
      turnover: [
        queries.result,
        queries.capital,
        queries.reserve,
        queries.previous,
        ...(start > period.yearStart ? [queries.microFx] : []),
      ],
    };
  },
  evaluate(input, loaded, rules) {
    const issues: Issue[] = [];
    const period = periodOf(input.period);
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
    if (input.legalReserve && !loaded.evidence.has(input.legalReserve.evidenceId))
      issues.push(
        block('EVIDENCE', 'Documentul justificativ nu este disponibil.', 'legalReserve.evidenceId'),
      );
    if (input.rectification) return rectify(input, loaded, rules, period, issues);

    if (
      period.quarter === null
        ? input.date !== period.end
        : input.date < period.end || input.date > `${period.year}-12-31`
    )
      issues.push(
        block(
          'TAX_DATE',
          period.quarter === null
            ? `Impozitul anului se înregistrează la ${period.end}, în registrele anului.`
            : `Impozitul trimestrului se înregistrează după încheierea lui (${period.end}), în anul ${period.year}.`,
          'date',
        ),
      );
    const regime = regimeOf(loaded, period);
    if (regime.atEnd !== 'profit')
      return {
        effect: null,
        issues: [
          ...issues,
          block(
            'NOT_PROFIT',
            `Compania nu este înregistrată ca plătitoare de impozit pe profit la ${period.end} (income_tax).`,
          ),
        ],
      };
    if (regime.atStart === 'micro' && regime.start !== quarterStartOf(regime.start))
      issues.push(
        block(
          'PROFIT_START',
          `Impozitul pe profit se datorează din trimestrul ieșirii din sistemul micro (art. 52): faptul income_tax trebuie să înceapă în prima zi a unui trimestru, nu la ${regime.start}.`,
        ),
      );
    // The system of declaring and paying (art. 41): quarterly by law after a micro year, else the
    // company's option (alin. (2)–(3)).
    const microBefore =
      regime.atStart === 'micro' || profileAt(loaded, 'income_tax', period.before) === 'micro';
    const system = profileAt(loaded, 'profit.system', regime.start);
    if (system === 'annual')
      issues.push(
        block(
          'PROFIT_ANNUAL_SYSTEM',
          'Sistemul anual cu plăți anticipate (art. 41 alin. (2)–(3), (8)–(10^1)) nu este acoperit: impozitul se calculează doar în sistemul trimestrial.',
        ),
      );
    else if (!system && !microBefore)
      issues.push(
        questionIssue(
          'PROFIT_SYSTEM',
          'Nu este înregistrat sistemul de declarare și plată a impozitului pe profit (trimestrial, art. 41 alin. (1), sau anual cu plăți anticipate, alin. (2)): întrebați (profile.fact profit.system).',
          {
            kind: 'profile.fact',
            subject: { kind: 'profile', id: 'profit.system' },
            params: { axis: 'profit.system', from: regime.start },
          },
        ),
      );
    if (period.quarter !== null && regime.start > period.end)
      issues.push(
        block('NOT_PROFIT', `În trimestrul ${period.quarter} compania era microîntreprindere.`),
      );

    try {
      const queries = booksQueries(period, regime.start);
      const all = loaded.turnover.get(turnoverKey(queries.result)) ?? [];
      if (all.some((row) => row.account.startsWith('121') && row.debit !== row.credit))
        return {
          effect: null,
          issues: [
            ...issues,
            block(
              'YEAR_CLOSED',
              `Rezultatul anului ${period.year} este închis (121): impozitul anului se înregistrează înainte de închiderea conturilor de venituri și cheltuieli; o corecție ulterioară se face prin rectificare.`,
            ),
          ],
        };
      const result = all.filter((row) => /^[67]/.test(row.account));
      issues.push(...scopeIssues(loaded, rules, period, regime.start, result));
      const net = (key: TurnoverQuery, prefix: string) =>
        (loaded.turnover.get(turnoverKey(key)) ?? [])
          .filter((row) => row.account.startsWith(prefix))
          .reduce((sum, row) => sum + row.credit - row.debit, 0n);
      const microFx =
        regime.start > period.yearStart && regime.exitQuarter !== null && regime.exitQuarter > 1
          ? net(queries.microFx, '765') + net(queries.microFx, '665')
          : null;

      // Loss vintages at the year's start: the latest earlier annual position's, else what a
      // person stated for the books' start (`profit.losses`).
      const latest = latestPositions(loaded);
      const earlier = [...latest.values()]
        .filter((item) => item.kind !== 'quarter' && item.year < period.year)
        .sort((a, b) => a.year - b.year)
        .at(-1);
      let losses: LossVintage[] | null = earlier ? vintagesOf(earlier.losses.after) : null;
      if (!losses) {
        const stated = answersOf<ProfitLossesAnswer>(loaded, 'profit.losses').get('losses');
        // In whole lei, as D101 declares them, rounded as its rows are (half up), never cut.
        const wholeLei = (amount: string) =>
          divRound(parseMoney(amount, 'RON'), 100n, 'halfAwayFromZero');
        if (stated)
          losses = stated.value.vintages.map((item) => ({
            year: item.year,
            amount: wholeLei(item.amount),
            remaining: wholeLei(item.remaining),
          }));
        else
          issues.push(
            questionIssue(
              'PROFIT_LOSSES',
              'Pierderile fiscale reportate din anii dinaintea registrelor nu sunt cunoscute: întrebați (profit.losses), cu declarațiile 101 depuse, și revizuiți propunerea citând răspunsul.',
              {
                kind: 'profit.losses',
                subject: { kind: 'company', id: 'losses' },
                params: { asOf: period.yearStart },
              },
            ),
          );
      }

      const classifications = answersOf<ProfitAccountAnswer>(loaded, 'profit.account');
      const books: BridgeBooks = {
        rows: result,
        capital: net(queries.capital, '1012'),
        reserve: net(queries.reserve, '1061'),
        microFx,
        assets: [...loaded.assets.values()],
        losses: losses ?? [],
        classification: (account) => {
          const found = classifications.get(account);
          return found ? { answer: found.value, answerId: found.record.answerId } : null;
        },
        vehicle: (plate) => {
          const found = vehicleAnswer(loaded, normalizePlate(plate));
          return found
            ? { deduction: vehicleDeduction(found.value), answerId: found.record.answerId }
            : null;
        },
      };
      const declared = [...latest.values()]
        .filter((item) => item.kind === 'quarter' && item.year === period.year)
        .filter((item) => period.quarter === null || Number(item.period.slice(6)) < period.quarter)
        .reduce((sum, item) => sum + BigInt(item.tax.due), 0n);
      const bridgePeriod: BridgePeriod = {
        label: input.period,
        year: period.year,
        start: regime.start,
        end: period.end,
        microExitQuarter: regime.exitQuarter,
      };
      const bridge = computeBridge(
        bridgePeriod,
        books,
        {
          determinations: input.determinations,
          legalReserve: input.legalReserve !== undefined,
          declared,
          annual: period.quarter === null,
        },
        rules,
      );
      issues.push(...bridge.issues);
      // A quarter of the regime without a computation: the next one catches up, but the quarter's
      // return was due.
      if (period.quarter !== null)
        for (
          let quarter = Math.ceil(Number(regime.start.slice(5, 7)) / 3);
          quarter < period.quarter;
          quarter++
        )
          if (!latest.has(`${period.year}-Q${quarter}`))
            issues.push({
              code: 'PROFIT_QUARTER_MISSING',
              severity: 'ack',
              message: `Trimestrul ${quarter} nu are impozitul pe profit calculat: confirmați că se calculează cumulat acum.`,
            });
      // Asked only while the reserve has room: once it reached a fifth of the capital at the
      // year's start, nothing is set aside and nothing is deducted (art. 183, art. 26 alin. (1)).
      if (!input.legalReserve && bridge.bases.reserveRoom > 0n && bridge.bases.profitBeforeTax > 0n)
        issues.push({
          code: 'LEGAL_RESERVE',
          severity: 'ack',
          message: `Nu se deduce rezerva legală (art. 26 alin. (1) lit. a)): o societate o constituie din profit până la o cincime din capitalul social (Legea nr. 31/1990 art. 183). Confirmați că nu se constituie, sau indicați decizia (legalReserve).`,
        });
      if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };
      return {
        effect: booking(input, period, regime, bridge, declared, losses ?? [], rules),
        issues,
      };
    } catch (error) {
      if (!(error instanceof RuleGapError)) throw error;
      return { effect: null, issues: [...issues, block('RULE_GAP', error.message)] };
    }
  },
};

/** The booking of a computation, and the position its explanation records. */
function booking(
  input: ProfitTaxInput,
  period: Period,
  regime: { start: LocalDate; exitQuarter: number | null },
  bridge: BridgeResult,
  declared: bigint,
  before: readonly LossVintage[],
  rules: RuleContext,
): Effect {
  const rows = bridge.rows;
  const annual = period.quarter === null;
  const due = rows.P48 - declared;
  const after: LossVintage[] = annual
    ? [
        ...(bridge.recovery?.after ?? before.filter((item) => item.year < period.year)),
        ...(rows.P40a > 0n ? [{ year: period.year, amount: rows.P40a, remaining: rows.P40a }] : []),
      ]
    : [...before];
  const position: ProfitPosition = {
    schema: POSITION,
    kind: annual ? 'year' : 'quarter',
    period: input.period,
    year: period.year,
    start: regime.start,
    end: period.end,
    microExitQuarter: regime.exitQuarter,
    rows: rowsJson(rows),
    tax: {
      cumulative: rows.P48.toString(),
      declared: declared.toString(),
      due: (annual ? due : due > 0n ? due : 0n).toString(),
    },
    losses: {
      before: vintagesJson(before),
      after: vintagesJson(after),
      used: (bridge.recovery?.used ?? []).map((item) => ({
        year: item.year,
        amount: item.amount.toString(),
      })),
    },
  };
  return effectOf(
    input,
    period,
    position,
    bridge.lines,
    annual ? due : due > 0n ? due : 0n,
    '691',
    bridge,
    rules,
  );
}

const linesJson = (lines: readonly BridgeLine[]) =>
  lines.map((line) => ({
    row: line.row,
    amount: ron(line.bani),
    accounts: line.accounts,
    clause: line.clause,
    text: line.text,
    basis: line.basis,
  }));

function effectOf(
  input: ProfitTaxInput,
  period: Period,
  position: ProfitPosition,
  bridgeLines: readonly BridgeLine[],
  /** In whole lei: positive owed, negative to recover. */
  amount: bigint,
  counter: '691' | '1174',
  bridge: BridgeResult | null,
  rules: RuleContext,
): Effect {
  const bani = amount * 100n;
  const label =
    position.kind === 'quarter'
      ? `trimestrul ${period.quarter} ${period.year}`
      : position.kind === 'year'
        ? `anul ${period.year}`
        : `rectificarea anului ${period.year}`;
  const details = {
    position: position as unknown as JsonValue,
    lines: linesJson(bridgeLines),
    ...(bridge
      ? {
          bases: {
            profitBeforeTax: ron(bridge.bases.profitBeforeTax),
            protocol: ron(bridge.bases.protocol),
            protocolLimit: ron(bridge.bases.protocolLimit),
            social: ron(bridge.bases.social),
            socialLimit: ron(bridge.bases.socialLimit),
            salaries: ron(bridge.bases.salaries),
            turnover: ron(bridge.bases.turnover),
            sponsorship: ron(bridge.bases.sponsorship),
          },
          assets: bridge.assets.map((item) => ({
            assetId: item.assetId,
            number: item.number,
            method: item.method,
            depreciation: ron(item.depreciation),
            disposal: ron(item.disposal),
            full: ron(item.full),
            capped: ron(item.capped),
          })),
        }
      : {}),
    clauses: [
      `${CODE}:art.17`,
      `${CODE}:art.19(1)`,
      `${CODE}:art.41(1)`,
      ...(position.kind === 'rectification' ? [`${CODE}:art.19(3)`] : []),
      ...(position.microExitQuarter ? [`${CODE}:art.52(1),(5)`] : []),
      'OUG59/2005:art.1(1)',
    ],
  };
  const summary = `Profit impozabil ${position.rows.P40} lei${position.rows.P40a !== '0' ? `, pierdere fiscală ${position.rows.P40a} lei` : ''}, impozit ${position.tax.cumulative} lei, declarat anterior ${position.tax.declared} lei: ${amount > 0n ? `de plată ${amount}` : amount < 0n ? `de recuperat ${-amount}` : 'nimic de înregistrat'} lei.`;
  const base = {
    schema: 'effect@1' as const,
    date: input.date as LocalDate,
    journalCode: 'IMPOZITE',
    description: `Impozit pe profit, ${label}${input.round > 1 ? ` (runda ${input.round})` : ''}`,
    taxEntries: [],
    schedules: [],
    explanation: { summary, details: details as JsonValue },
  };
  if (amount === 0n) return { ...base, journalClass: 'memo', lines: [], openItems: [] };
  const owed = amount > 0n;
  return {
    ...base,
    journalClass: 'general',
    lines: owed
      ? [
          { account: counter, side: 'D', bani },
          { account: '4411', side: 'C', bani, openItem: 'profit', partyId: input.authorityId },
        ]
      : [
          {
            account: '4411',
            side: 'D',
            bani: -bani,
            openItem: 'profit',
            partyId: input.authorityId,
          },
          { account: counter, side: 'C', bani: -bani },
        ],
    openItems: [
      {
        ref: 'profit',
        kind: 'tax.payable',
        controlAccount: '4411',
        partyId: input.authorityId,
        currency: 'RON',
        normalSide: owed ? 'C' : 'D',
        mayReverse: false,
        // Due with its return: a quarter's D100 (art. 41 alin. (1)), the year's (and its
        // rectification's) D101.
        ...(period.quarter === null
          ? taxDue('D101', `${period.year}-01`, `${period.year}-12`, rules)
          : taxDue(
              'D100.profit',
              `${period.year}-${pad(period.quarter * 3 - 2)}`,
              `${period.year}-${pad(period.quarter * 3)}`,
              rules,
            )),
      },
    ],
  };
}

/**
 * A closed year's tax after prior-year corrections (art. 19 alin. (3) lit. a)): the year's last
 * position, with each correction's change of the result as an item similar to revenue (rd. 8) or
 * to expenses (rd. 9), its losses and tax recomputed; the difference from what the year booked
 * goes on 1174.
 */
function rectify(
  input: ProfitTaxInput,
  loaded: Loaded,
  rules: RuleContext,
  period: Period,
  issues: Issue[],
) {
  try {
    const positions = positionsOf(loaded);
    const latest = latestPositions(loaded).get(input.period);
    if (!latest)
      return {
        effect: null,
        issues: [
          ...issues,
          block(
            'PROFIT_YEAR_OUTSIDE',
            `Registrele nu au impozitul pe profit calculat pentru ${input.period}: declarația 101 rectificativă se întocmește în afara aplicației.`,
          ),
        ],
      };
    if (input.date <= period.end)
      issues.push(
        block(
          'TAX_DATE',
          `Rectificarea se înregistrează după închiderea anului ${period.year}.`,
          'date',
        ),
      );
    // The corrections of the year posted after its last position.
    const since = positions.findIndex(({ position }) => position === latest);
    const corrections = positions
      .slice(since + 1)
      .flatMap(({ position }) =>
        position.schema === 'profit-correction@1' && position.year === period.year
          ? [position]
          : [],
      );
    if (!corrections.length)
      return {
        effect: null,
        issues: [
          ...issues,
          block(
            'NOTHING_TO_RECTIFY',
            `Nicio corecție a anului ${period.year} după ultimul calcul.`,
          ),
        ],
      };
    const rows: D101Rows = rowsOf(latest.rows);
    const change = corrections.reduce((sum, item) => sum + BigInt(item.change), 0n);
    if (change > 0n) rows.P8 += change;
    else rows.P9 += -change;
    // The losses and the tax again, from the vintages the year started with.
    rows.P39 = 0n;
    rows.P39a = 0n;
    let derived = deriveD101Rows(rows);
    const before = vintagesOf(latest.losses.before);
    const recovery = before.length ? recoverLosses(before, period.year, derived.P38a, rules) : null;
    if (recovery) {
      rows.P39 = recovery.available;
      rows.P39a = recovery.recovered;
    }
    derived = deriveD101Rows(rows);
    const rate = rules.param<string>(
      'ro.profit.rate',
      'reporting_period_start',
      latest.start as LocalDate,
    );
    rows.P411 = divRound(derived.P40 * parseScaled(rate, 4), 1_000_000n, 'halfAwayFromZero');
    derived = deriveD101Rows(rows);
    // The sponsorship credit keeps within 20% of the new tax.
    if (rows.P43 * 100n > (derived.P41 - derived.P42) * 20n) {
      const cap = divRound((derived.P41 - derived.P42) * 20n, 100n, 'floor');
      rows.P43 = cap > 0n ? cap : 0n;
      rows.P431 = rows.P43;
    }
    derived = deriveD101Rows(rows);
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };
    const previous = BigInt(latest.tax.cumulative);
    const after = [
      ...(recovery?.after ?? before.filter((item) => item.year < period.year)),
      ...(derived.P40a > 0n
        ? [{ year: period.year, amount: derived.P40a, remaining: derived.P40a }]
        : []),
    ];
    const position: ProfitPosition = {
      schema: POSITION,
      kind: 'rectification',
      period: input.period,
      year: period.year,
      start: latest.start,
      end: latest.end,
      microExitQuarter: latest.microExitQuarter,
      rows: rowsJson(derived),
      tax: {
        cumulative: derived.P48.toString(),
        declared: latest.tax.declared,
        due: (derived.P48 - previous).toString(),
      },
      losses: {
        before: latest.losses.before,
        after: vintagesJson(after),
        used: (recovery?.used ?? []).map((item) => ({
          year: item.year,
          amount: item.amount.toString(),
        })),
      },
    };
    const lines: BridgeLine[] = corrections.map((item) => ({
      row: BigInt(item.change) > 0n ? 'P8' : 'P9',
      bani: (BigInt(item.change) > 0n ? BigInt(item.change) : -BigInt(item.change)) * 100n,
      accounts: ['1174'],
      clause: `${CODE}:art.19(3)`,
      text: item.description,
      basis: [],
    }));
    issues.push({
      code: 'PROFIT_DOWNSTREAM',
      severity: 'ack',
      message: `Rectificarea anului ${period.year} schimbă pierderile reportate ale anilor următori${derived.P40a !== BigInt(latest.rows.P40a ?? '0') ? '' : ' doar dacă pierderea s-a schimbat'}: verificați calculele anilor de după el.`,
    });
    return {
      effect: effectOf(input, period, position, lines, derived.P48 - previous, '1174', null, rules),
      issues,
    };
  } catch (error) {
    if (!(error instanceof RuleGapError)) throw error;
    return { effect: null, issues: [...issues, block('RULE_GAP', error.message)] };
  }
}

export const priorYearCorrectionInput = z
  .object({
    /** The posting date, in the current, open year. */
    date: localDate,
    /** The year the error belongs to: an earlier financial year, approved. */
    year: z.number().int().min(2000).max(2100),
    reference: z.string().trim().min(1).max(100),
    description: z.string().trim().min(3).max(1000),
    /** What shows the error and its discovery: the document, the materiality assessment. */
    evidenceId: z.uuid(),
    /** The lines: one side on 1174, the other on the accounts the error left wrong; none on
     * classes 6 or 7. */
    lines: z
      .array(
        z
          .object({
            account: z.string().regex(/^\d{3,4}(\.[A-Z0-9_-]{1,24})*$/),
            side: z.enum(['D', 'C']),
            amount: z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/),
            partyId: z.uuid().optional(),
            /** An open item the correction settles or adjusts. */
            openItem: z.uuid().optional(),
            /** A payable or receivable the correction opens (an invoice left out). */
            newItem: z
              .object({ kind: z.enum(['payable', 'receivable']), dueDate: localDate.optional() })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(2)
      .max(50),
    /** The change in the corrected year's taxable result, in lei (negative: a deductible expense
     * omitted; positive: a taxable revenue omitted); zero when it has none. */
    fiscalChange: z.string().regex(/^-?(0|[1-9]\d{0,15})$/),
  })
  .strict();
export type PriorYearCorrectionInput = z.infer<typeof priorYearCorrectionInput>;

/**
 * A material error of an approved earlier year, corrected on retained earnings (1174, OMFP nr.
 * 1.802/2014 pct. 66–67): never through this year's expenses or revenues. Its fiscal effect is
 * the corrected year's (art. 19 alin. (3) lit. a)), recorded with the entry for that year's
 * rectification (`tax.profit` with `rectification`) and its rectifying D101.
 */
export const priorYearCorrection: Treatment<PriorYearCorrectionInput> = {
  id: 'correction.priorYear',
  version: 1,
  description:
    'Corectarea unei erori semnificative a unui exercițiu anterior aprobat, pe seama rezultatului reportat (1174).',
  input: priorYearCorrectionInput,
  agent: true,
  summary:
    "Correction of a material error of an approved earlier year on retained earnings (1174), with its fiscal effect on that year's profit tax.",
  toolset: 'books',
  dataClasses: ['books', 'tax'],
  subject: (input) => `correction:${input.year}:${input.reference}`,
  plan: (input) => ({
    evidence: [input.evidenceId],
    openItems: [{ ids: input.lines.flatMap((line) => (line.openItem ? [line.openItem] : [])) }],
    parties: [...new Set(input.lines.flatMap((line) => (line.partyId ? [line.partyId] : [])))],
  }),
  evaluate(input, loaded) {
    const issues: Issue[] = [];
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(block('EVIDENCE', 'Documentul justificativ nu este disponibil.', 'evidenceId'));
    if (input.year >= Number(input.date.slice(0, 4)))
      issues.push(
        block(
          'CORRECTION_YEAR',
          'Se corectează un exercițiu anterior celui în care se înregistrează corecția.',
          'year',
        ),
      );
    if (!input.lines.some((line) => line.account.startsWith('1174')))
      issues.push(
        block(
          'CORRECTION_ACCOUNT',
          'O eroare a unui exercițiu anterior se corectează pe seama contului 1174.',
          'lines',
        ),
      );
    input.lines.forEach((line, index) => {
      if (/^[67]/.test(line.account))
        issues.push(
          block(
            'CORRECTION_ACCOUNT',
            'O eroare semnificativă a unui exercițiu anterior nu trece prin cheltuielile sau veniturile anului curent (OMFP nr. 1.802/2014 pct. 66–67).',
            `lines.${index}.account`,
          ),
        );
      if (line.openItem && !loaded.openItems.has(line.openItem))
        issues.push(block('OPEN_ITEM', 'Poziția deschisă nu există.', `lines.${index}.openItem`));
      if (line.newItem && !line.partyId)
        issues.push(
          block('PARTY', 'O datorie sau o creanță nouă are un partener.', `lines.${index}.partyId`),
        );
    });
    if (issues.length) return { effect: null, issues };
    const lines = input.lines.map((line, index) => ({
      account: line.account,
      side: line.side,
      bani: parseMoney(line.amount, 'RON'),
      ...(line.partyId ? { partyId: line.partyId } : {}),
      ...(line.openItem
        ? { openItem: line.openItem }
        : line.newItem
          ? { openItem: `item-${index}` }
          : {}),
    }));
    const openItems = input.lines.flatMap((line, index) =>
      line.newItem
        ? [
            {
              ref: `item-${index}`,
              kind: line.newItem.kind,
              controlAccount: line.account,
              partyId: line.partyId!,
              currency: 'RON',
              normalSide: (line.newItem.kind === 'payable' ? 'C' : 'D') as 'C' | 'D',
              mayReverse: false,
              ...(line.newItem.dueDate ? { dueDate: line.newItem.dueDate as LocalDate } : {}),
            },
          ]
        : [],
    );
    const position: CorrectionPosition = {
      schema: 'profit-correction@1',
      year: input.year,
      change: BigInt(input.fiscalChange).toString(),
      description: input.description,
    };
    const change = BigInt(input.fiscalChange);
    const effect: Effect = {
      schema: 'effect@1',
      date: input.date as LocalDate,
      journalClass: 'general',
      journalCode: 'DIVERSE',
      description: `Corectarea erorii din ${input.year}: ${input.description}`,
      lines,
      openItems,
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: `Eroare din ${input.year} corectată pe seama rezultatului reportat (1174); rezultatul fiscal al anului ${input.year} se schimbă cu ${change} lei.`,
        details: {
          position: position as unknown as JsonValue,
          clauses: ['OMFP1802/2014:pct.66-67', `${CODE}:art.19(3)`],
        },
      },
    };
    const acks: Issue[] =
      change !== 0n
        ? [
            {
              code: 'PRIOR_YEAR_D101',
              severity: 'ack',
              message: `Corecția schimbă rezultatul fiscal al anului ${input.year} cu ${change} lei: declarația 101 a acelui an se rectifică (art. 19 alin. (3) lit. a)), iar impozitul se recalculează (tax.profit, rectification).`,
            },
          ]
        : [];
    return { effect, issues: acks };
  },
};

export const profitPeriodOf = periodOf;
