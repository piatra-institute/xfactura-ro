import { and, asc, desc, eq, gte, inArray, lte, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { canonical, hashOf } from 'xfactura-core/hash';
import type { ProfileFact } from 'xfactura-core/kernel';
import { s1005FromLedger, type S1005LedgerEntry } from 'xfactura-core/ro/annual/s1005-accounts';
import {
  average,
  confirmQuestion,
  determineYear,
  evaluateClosure,
  figuresQuestion,
  microQuestion,
  monthlyHeadcount,
  recordedAt,
  recordedInYear,
  thresholdWatches,
  yearlyAxes,
  type Closure,
  type ClosureBooks,
  type Contract,
  type Determination,
  type DeterminationContext,
  type Known,
  type ThresholdWatch,
  type YearActivity,
  type YearFigures,
} from 'xfactura-core/ro/determinations';
import { exemptCodes, exemptWithDeduction } from 'xfactura-core/ro/exempt';
import { euVatPrefixes } from 'xfactura-core/ro/geo';
import { quarterMonths } from 'xfactura-core/ro/payroll';
import { d406StartOf } from 'xfactura-core/ro/saft/applicability';
import {
  microConditionsAnswer,
  type MicroConditionsAnswer,
  type QuestionRequest,
  type YearFigureName,
} from 'xfactura-core/questions/kinds';
import type { RuleContext } from 'xfactura-core/rules';
import { bucharestDate, type LocalDate } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import {
  assetEvents,
  assets,
  documents,
  employmentTerms,
  entries,
  fiscalYears,
  fxRates,
  incomeSources,
  lines,
  parties,
  payrollLines,
  payrollRunEvents,
  payrollRuns,
  profileFacts,
  proposals,
  proposalVersions,
  questionAnswers,
  questions,
  questionWithdrawals,
  taxEntries,
  stockMoves,
} from '../db/schema';
import type { Actor, Commands } from '../kernel/commands';
import { entryStands } from '../kernel/ledger';
import { halfYearOf } from './annual';
import { distanceSalesOf } from './d398';
import { standing } from './questions';

/*
 * The yearly determinations and the obligation closure, fed from the books (core
 * `ro/determinations` is pure): each year's figures (turnover, revenues, VAT bases, total assets,
 * headcount, the BNR rate at the close), the employment contracts, the answers people gave, and
 * what the books show over a range of months. `determinations.propose` opens the questions a
 * person answers: the computed facts to confirm, and what only the owner knows.
 */

const yearInput = z.number().int().min(2016).max(2100);
export const determinationsInput = z.object({ year: yearInput }).strict();
export const closureInput = z
  .object({
    from: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    to: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  })
  .strict()
  .refine((input) => input.from <= input.to, {
    message: 'Luna de început este după cea de sfârșit.',
  })
  .refine((input) => Number(input.to.slice(0, 4)) - Number(input.from.slice(0, 4)) <= 2, {
    message: 'Închiderea cuprinde cel mult trei ani calendaristici.',
  });

const questionView = z.object({
  kind: z.string(),
  subject: z.object({ kind: z.string(), id: z.string() }),
  params: z.record(z.string(), z.unknown()),
});
export const determinationView = z.object({
  axis: z.string(),
  year: z.number(),
  status: z.enum(['proposed', 'needs_evidence', 'unsupported', 'rule_gap', 'not_applicable']),
  value: z.string().nullable(),
  effectiveFrom: z.string(),
  changes: z.array(z.object({ value: z.string(), effectiveFrom: z.string(), reason: z.string() })),
  summary: z.string(),
  lines: z.array(z.string()),
  inputs: z.record(z.string(), z.unknown()),
  clauses: z.array(z.string()),
  versions: z.array(z.string()),
  questions: z.array(questionView),
  dependsOn: z.array(z.string()),
  unsupported: z
    .object({ trigger: z.string(), message: z.string(), capabilities: z.array(z.string()) })
    .nullable(),
  fingerprint: z.string(),
  /** The facts recorded within the year on this axis, and whether they agree with the
   * computation (or were confirmed against it). */
  recorded: z.object({
    values: z.array(z.object({ value: z.string(), effectiveFrom: z.string() })),
    confirmed: z.boolean(),
    agrees: z.boolean().nullable(),
  }),
});
export const watchView = z.object({
  key: z.string(),
  axis: z.string(),
  year: z.number(),
  limit: z.string(),
  value: z.string(),
  percent: z.number(),
  clauses: z.array(z.string()),
  message: z.string(),
});
export const determinationsView = z.object({
  year: z.number(),
  determinations: z.array(determinationView),
  watches: z.array(watchView),
});
export const proposeView = determinationsView.extend({
  asked: z.array(
    questionView.extend({ questionId: z.string(), reused: z.boolean(), answered: z.boolean() }),
  ),
  withdrawn: z.array(z.string()),
});
const obligationItem = z.object({
  kind: z.string(),
  deadline: z.string().nullable(),
  period: z.string(),
  deadlinePeriod: z.string().nullable(),
  state: z.enum(['applies', 'needs_evidence', 'unsupported']),
  rule: z.string(),
  clauses: z.array(z.string()),
  facts: z.array(z.string()),
  blockers: z.array(z.string()),
});
export const closureView = z.object({
  version: z.string(),
  rulesHash: z.string(),
  interval: z.object({ from: z.string(), to: z.string() }),
  status: z.enum(['ELIGIBLE', 'NEEDS_EVIDENCE', 'UNSUPPORTED']),
  obligations: z.array(obligationItem),
  needs: z.array(
    z.object({
      id: z.string(),
      code: z.string(),
      fact: z.string(),
      message: z.string(),
      question: questionView,
      rules: z.array(z.string()),
    }),
  ),
  unsupported: z.array(
    z.object({
      trigger: z.string(),
      message: z.string(),
      missingCapabilities: z.array(z.string()),
      evidenceIds: z.array(z.string()),
      rule: z.string(),
      resolution: z.string(),
    }),
  ),
  gaps: z.array(
    z.object({
      code: z.string(),
      rules: z.array(z.string()),
      slots: z.array(z.string()),
      message: z.string(),
    }),
  ),
  trace: z.array(
    z.object({
      rule: z.string(),
      iteration: z.number(),
      read: z.array(z.string()),
      produced: z.array(z.string()),
    }),
  ),
});

const pad = (value: number) => String(value).padStart(2, '0');
const lastDay = (month: string) =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0))
    .toISOString()
    .slice(0, 10);
const debit = sql<bigint>`sum(CASE WHEN ${lines.side} = 'D' THEN ${lines.bani} ELSE 0 END)`.mapWith(
  BigInt,
);
const credit =
  sql<bigint>`sum(CASE WHEN ${lines.side} = 'C' THEN ${lines.bani} ELSE 0 END)`.mapWith(BigInt);
const lineEntry = and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId));
const known = <T>(value: T, source: 'books' | 'answer', ref: string | null = null): Known<T> => ({
  known: true,
  value,
  source,
  ref,
});
const unknown = <T>(reason: string, question: QuestionRequest | null): Known<T> => ({
  known: false,
  reason,
  question,
});

/** The recorded facts, superseded ones left out, with their ids and evidence. */
async function factRows(tx: Transaction, companyId: string) {
  const rows = await tx
    .select()
    .from(profileFacts)
    .where(eq(profileFacts.companyId, companyId))
    .orderBy(asc(profileFacts.effectiveFrom), asc(profileFacts.createdAt), asc(profileFacts.id));
  const superseded = new Set(rows.map((row) => row.supersedesId).filter(Boolean));
  return rows.filter((row) => !superseded.has(row.id));
}
const asFacts = (rows: Awaited<ReturnType<typeof factRows>>): ProfileFact[] =>
  rows.map((row) => ({
    axis: row.axis,
    value: row.value,
    effectiveFrom: row.effectiveFrom as LocalDate,
  }));

/**
 * The fingerprint each yearly fact was confirmed against: a fact recorded by an answer to a
 * `determination.confirm` question cites the answer as evidence, and the question holds the
 * fingerprint of the computation shown.
 */
async function confirmations(
  tx: Transaction,
  companyId: string,
  rows: Awaited<ReturnType<typeof factRows>>,
) {
  const evidenceIds = [...new Set(rows.map((row) => row.evidenceId))];
  if (!evidenceIds.length) return {};
  const answered = await tx
    .select({ params: questions.params })
    .from(questionAnswers)
    .innerJoin(
      questions,
      and(
        eq(questions.companyId, questionAnswers.companyId),
        eq(questions.id, questionAnswers.questionId),
      ),
    )
    .where(
      and(
        eq(questionAnswers.companyId, companyId),
        eq(questions.kind, 'determination.confirm'),
        inArray(questionAnswers.evidenceId, evidenceIds),
      ),
    )
    // In the engine's time of the answers, never the database's: the latest confirmation holds.
    .orderBy(sql`coalesce(${questionAnswers.engineAt}, 0)`, asc(questionAnswers.id));
  const result: Record<string, string> = {};
  for (const row of answered) {
    const params = JSON.parse(row.params) as { axis: string; year: number; fingerprint: string };
    result[`${params.axis}/${params.year}`] = params.fingerprint;
  }
  return result;
}

/** Each employment contract's latest terms. An administrator's mandate is not an employment
 * contract: it counts for the micro-enterprise only through art. 51 alin. (4) lit. b), which the
 * `micro.conditions` answer states, never as a full-time employee. */
async function contractsOf(tx: Transaction, companyId: string): Promise<Contract[]> {
  const rows = await tx
    .select()
    .from(employmentTerms)
    .where(and(eq(employmentTerms.companyId, companyId), eq(employmentTerms.kind, 'employment')))
    .orderBy(asc(employmentTerms.contractId), asc(employmentTerms.seq));
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) latest.set(row.contractId, row);
  return [...latest.values()].map((row) => ({
    employeeId: row.employeeId,
    start: row.startDate as LocalDate,
    end: (row.endDate as LocalDate | null) ?? null,
    dailyHours: row.dailyHours,
  }));
}

/** The latest answer to a question of a kind about a subject. */
async function latestAnswers(tx: Transaction, companyId: string, kind: string, subjectId: string) {
  return (
    tx
      .select({ value: questionAnswers.value, evidenceId: questionAnswers.evidenceId })
      .from(questionAnswers)
      .innerJoin(
        questions,
        and(
          eq(questions.companyId, questionAnswers.companyId),
          eq(questions.id, questionAnswers.questionId),
        ),
      )
      .where(
        and(
          eq(questionAnswers.companyId, companyId),
          eq(questions.kind, kind),
          eq(questions.subjectKind, 'year'),
          eq(questions.subjectId, subjectId),
        ),
      )
      // In the engine's time of the answers (one recorded before it kept it counts as the
      // earliest), then by the question's own order.
      .orderBy(
        sql`coalesce(${questionAnswers.engineAt}, 0)`,
        asc(questionAnswers.seq),
        asc(questionAnswers.id),
      )
  );
}

/** Whether the engine keeps a year's books from 1 January: a financial year starting then. */
async function keeps(tx: Transaction, companyId: string, year: number) {
  const [row] = await tx
    .select({ id: fiscalYears.id })
    .from(fiscalYears)
    .where(
      and(
        eq(fiscalYears.companyId, companyId),
        eq(fiscalYears.kind, 'financial'),
        lte(fiscalYears.from, `${year}-01-01`),
        gte(fiscalYears.to, `${year}-12-31`),
      ),
    );
  return Boolean(row);
}

/** The year's turnover of classes 6 and 7 by account, without the closing journal. */
async function yearTurnover(tx: Transaction, companyId: string, from: string, to: string) {
  return tx
    .select({ account: lines.account, debit, credit })
    .from(lines)
    .innerJoin(entries, lineEntry)
    .where(
      and(
        eq(lines.companyId, companyId),
        gte(entries.date, from),
        lte(entries.date, to),
        sql`substr(${lines.account}, 1, 1) = '7'`,
        ne(entries.journalCode, 'INCHIDERE'),
      ),
    )
    .groupBy(lines.account);
}
const netCredit = (
  rows: readonly { account: string; debit: bigint; credit: bigint }[],
  test: (account: string) => boolean,
) => rows.filter((row) => test(row.account)).reduce((sum, row) => sum + row.credit - row.debit, 0n);

/**
 * Each day's supplies in the two VAT bases:
 * - art. 310 alin. (2), the small-enterprise threshold: the revenue booked on 70x (net of 709)
 *   on the day, less the supplies with the place abroad (EXP-… tax entries). A non-payer's sales
 *   carry no VAT tax entries, so the revenue is the measure; selling fixed or intangible assets
 *   (7583) is left out, as the article leaves it out;
 * - art. 282 alin. (3^1) and art. 322 alin. (2): the bases of the output tax entries, taxable
 *   (S-…) and abroad with a right of deduction (EXP-…), by tax point.
 */
async function outputBases(tx: Transaction, companyId: string, from: string, to: string) {
  const taxed = await tx
    .select({
      date: taxEntries.taxPoint,
      code: taxEntries.code,
      base: sql<bigint>`sum(${taxEntries.baseBani})`.mapWith(BigInt),
    })
    .from(taxEntries)
    .where(
      and(
        eq(taxEntries.companyId, companyId),
        eq(taxEntries.tax, 'VAT'),
        eq(taxEntries.direction, 'output'),
        gte(taxEntries.taxPoint, from),
        lte(taxEntries.taxPoint, to),
      ),
    )
    .groupBy(taxEntries.taxPoint, taxEntries.code);
  const revenue = await tx
    .select({ date: entries.date, debit, credit })
    .from(lines)
    .innerJoin(entries, lineEntry)
    .where(
      and(
        eq(lines.companyId, companyId),
        gte(entries.date, from),
        lte(entries.date, to),
        sql`substr(${lines.account}, 1, 2) = '70'`,
        ne(entries.journalCode, 'INCHIDERE'),
      ),
    )
    .groupBy(entries.date);
  const days = new Map<string, { date: LocalDate; exemption: bigint; vat: bigint }>();
  const day = (date: string) => {
    const found = days.get(date) ?? { date: date as LocalDate, exemption: 0n, vat: 0n };
    days.set(date, found);
    return found;
  };
  for (const row of revenue) day(row.date).exemption += row.credit - row.debit;
  for (const row of taxed) {
    if (row.code.startsWith('EXP-')) day(row.date).exemption -= row.base;
    if (
      row.code.startsWith('S-') ||
      row.code.startsWith('EXP-') ||
      exemptWithDeduction.includes(row.code)
    )
      day(row.date).vat += row.base;
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Total assets at a date: balance sheet A–C of the abridged balance sheet (OMFP pct. 15). */
async function totalAssets(tx: Transaction, companyId: string, date: string) {
  const partner = sql<
    string | null
  >`CASE WHEN ${lines.openItemId} IS NOT NULL THEN ${lines.partyId} END`;
  const rows = await tx
    .select({ account: lines.account, partner, debit, credit })
    .from(lines)
    .innerJoin(entries, lineEntry)
    .where(and(eq(lines.companyId, companyId), lte(entries.date, date)))
    .groupBy(lines.account, partner);
  // Accounts the form spreads over two asset rows: either row counts the same in the total.
  const assetRows: Record<string, '07' | '11' | '03'> = { '508': '07', '471': '11', '267': '03' };
  const closing: S1005LedgerEntry[] = rows
    .filter((row) => row.debit !== row.credit && '12345'.includes(row.account[0]!))
    .map((row) => {
      const rowOf = Object.entries(assetRows).find(([prefix]) => row.account.startsWith(prefix));
      return {
        account: row.account,
        debit: row.debit > row.credit ? row.debit - row.credit : 0n,
        credit: row.credit > row.debit ? row.credit - row.debit : 0n,
        ...(rowOf ? { rows: { F10: rowOf[1] } } : {}),
      };
    });
  const mapped = s1005FromLedger({ closing, turnover: [] });
  const unplaced = mapped.issues.filter((issue) =>
    ['S1005_SPLIT', 'S1005_UNMAPPED', 'S1005_ROW'].includes(issue.code),
  );
  if (unplaced.length) return { unplaced: unplaced.map((issue) => issue.message) };
  const asset = ['01', '02', '03', '05', '06a', '06b', '07', '08', '11', '12'] as const;
  return {
    lei: asset.reduce((sum, row) => sum + BigInt(mapped.F10[row] ?? 0), 0n) * 100n,
  };
}

/** The BNR EUR rate valid at a year's close: the publication on or before 31 December. */
async function closingRate(tx: Transaction, year: number) {
  const [row] = await tx
    .select()
    .from(fxRates)
    .where(
      and(
        eq(fxRates.source, 'BNR'),
        eq(fxRates.currency, 'EUR'),
        lte(fxRates.rateDate, `${year}-12-31`),
        gte(fxRates.rateDate, `${year}-12-24`),
      ),
    )
    .orderBy(desc(fxRates.rateDate), desc(fxRates.revision))
    .limit(1);
  return row;
}

/** Whether invoices from EU suppliers in a year were all booked as services. */
async function euGoodsUnknown(tx: Transaction, companyId: string, year: number) {
  const eu = Object.keys(euVatPrefixes).filter((code) => code !== 'RO');
  const rows = await tx
    .select({ id: documents.id })
    .from(documents)
    .innerJoin(
      parties,
      and(eq(parties.companyId, documents.companyId), eq(parties.id, documents.partyId)),
    )
    .where(
      and(
        eq(documents.companyId, companyId),
        eq(documents.kind, 'invoice.received'),
        inArray(parties.country, eu),
        gte(documents.docDate, `${year}-01-01`),
        lte(documents.docDate, `${year}-12-31`),
        sql`not exists (select 1 from ${taxEntries} t where t.company_id = ${documents.companyId}
          and t.document_id = ${documents.id} and t.code = 'RC-EU-SERV')`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** A year's figures: from the books when the engine keeps the year, else from the answers. */
async function figuresOf(
  tx: Transaction,
  companyId: string,
  year: number,
  contracts: readonly Contract[],
  today: LocalDate,
): Promise<YearFigures> {
  const kept = await keeps(tx, companyId, year);
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const ended = to < today;
  const answers = await latestAnswers(tx, companyId, 'year.figures', String(year));
  const answered = new Map<YearFigureName, { value: string; evidenceId: string }>();
  for (const row of answers)
    for (const [name, value] of Object.entries(
      (JSON.parse(row.value) as { values: Record<string, string> }).values,
    ))
      answered.set(name as YearFigureName, { value, evidenceId: row.evidenceId });
  // Every figure the books lack names one question: the year's figures, all of them.
  const missing: YearFigureName[] = [];
  const pending: { name: YearFigureName; figure: { question: QuestionRequest | null } }[] = [];
  const fromAnswer = <T>(name: YearFigureName, parse: (value: string) => T): Known<T> => {
    const answer = answered.get(name);
    if (answer) return known(parse(answer.value), 'answer', answer.evidenceId);
    if (!missing.includes(name)) missing.push(name);
    const figure = {
      known: false as const,
      reason: `${kept ? 'Registrele nu dau' : `Anul ${year} nu este în registre`}: ${name} se ia din situațiile și declarațiile depuse pentru ${year}.`,
      question: null as QuestionRequest | null,
    };
    pending.push({ name, figure });
    return figure;
  };
  const bani = (value: string) => BigInt(Math.round(Number(value) * 100));
  const rate = await closingRate(tx, year);
  const eurRate: Known<YearFigures['eurRate'] extends Known<infer T> ? T : never> = rate
    ? known(
        { rate: rate.rate, multiplier: rate.multiplier, date: rate.rateDate },
        'books',
        `BNR ${rate.rateDate}`,
      )
    : unknown(`Cursul BNR al EUR valabil la 31.12.${year} nu este importat (fx.importBnr).`, null);
  let figures: YearFigures;
  if (kept) {
    const turnover = await yearTurnover(tx, companyId, from, to);
    const days = await outputBases(tx, companyId, from, to);
    const headcount = monthlyHeadcount(contracts, year);
    const withEmployees = headcount.filter((count) => count > 0);
    const assets = ended ? await totalAssets(tx, companyId, to) : null;
    figures = {
      year,
      kept,
      turnover: known(
        netCredit(turnover, (account) => account.startsWith('70')),
        'books',
      ),
      netTurnover: known(
        netCredit(turnover, (account) => account.startsWith('70') || account.startsWith('7411')),
        'books',
      ),
      totalRevenue: known(
        netCredit(turnover, () => true),
        'books',
      ),
      vatTurnover: known(
        days.reduce((sum, day) => sum + day.vat, 0n),
        'books',
      ),
      exemptionTurnover: known(
        days.reduce((sum, day) => sum + day.exemption, 0n),
        'books',
      ),
      totalAssets: !assets
        ? unknown(
            `Exercițiul ${year} nu s-a încheiat: totalul activelor se citește la 31.12.${year}.`,
            null,
          )
        : assets.lei !== undefined
          ? known(assets.lei, 'books')
          : fromAnswer('totalAssets', bani),
      averageEmployees: known(
        average(
          headcount.reduce((sum, n) => sum + n, 0),
          12,
        ),
        'books',
      ),
      averageEmployeesD112: known(
        average(
          withEmployees.reduce((sum, n) => sum + n, 0),
          withEmployees.length,
        ),
        'books',
      ),
      euGoodsAcquisitions: (await intrastatFlowsOf(tx, companyId, year)).some(
        (row) => row.arrivals !== 0n,
      )
        ? known(true, 'books')
        : (await euGoodsUnknown(tx, companyId, year))
          ? fromAnswer('euGoodsAcquisitions', (value) => value === 'yes')
          : known(false, 'books'),
      eurRate,
    };
  } else
    figures = {
      year,
      kept,
      turnover: fromAnswer('turnover', bani),
      netTurnover: fromAnswer('netTurnover', bani),
      totalRevenue: fromAnswer('totalRevenue', bani),
      vatTurnover: fromAnswer('vatTurnover', bani),
      exemptionTurnover: fromAnswer('exemptionTurnover', bani),
      totalAssets: fromAnswer('totalAssets', bani),
      averageEmployees: fromAnswer('averageEmployees', (value) => value),
      averageEmployeesD112: fromAnswer('averageEmployees', (value) => value),
      euGoodsAcquisitions: fromAnswer('euGoodsAcquisitions', (value) => value === 'yes'),
      eurRate,
    };
  if (missing.length) {
    const question = figuresQuestion(year, missing);
    for (const item of pending) item.figure.question = question;
  }
  return figures;
}

/** The current year's movements: turnover by quarter and the VAT bases by day. */
async function activityOf(tx: Transaction, companyId: string, year: number): Promise<YearActivity> {
  const quarters: bigint[] = [];
  for (let quarter = 1; quarter <= 4; quarter++) {
    const rows = await yearTurnover(
      tx,
      companyId,
      `${year}-${pad(quarter * 3 - 2)}-01`,
      lastDay(`${year}-${pad(quarter * 3)}`),
    );
    quarters.push(netCredit(rows, (account) => account.startsWith('70')));
  }
  const first = await firstBooksDay(tx, companyId);
  return {
    year,
    kept: await keeps(tx, companyId, year),
    quarterTurnover: quarters as unknown as YearActivity['quarterTurnover'],
    days: await outputBases(tx, companyId, `${year}-01-01`, `${year}-12-31`),
    // A first financial year starting within this year: a company set up then (Legea nr.
    // 82/1991 art. 27 alin. (8)).
    start:
      first && first > `${year}-01-01` && first <= `${year}-12-31` ? (first as LocalDate) : null,
    euServices: await euServicesOf(tx, companyId, year),
    distance: await distanceSalesOf(tx, companyId, year),
    intrastat: await intrastatFlowsOf(tx, companyId, year),
  };
}

/**
 * The year's intra-Union goods by the month they moved (core ro/trade): intra-community
 * acquisitions (AIC-…, arrivals) and supplies (EX-IC, dispatches), their bases in lei, by the
 * supply's date the entry records, else its tax point; a reversal's entries net them out.
 */
async function intrastatFlowsOf(tx: Transaction, companyId: string, year: number) {
  const day = sql<string>`coalesce(json_extract(${taxEntries.attributes}, '$.supplied'), ${taxEntries.taxPoint})`;
  const rows = await tx
    .select({
      month: sql<string>`substr(${day}, 1, 7)`,
      code: taxEntries.code,
      base: sql<bigint>`sum(${taxEntries.baseBani})`.mapWith(BigInt),
    })
    .from(taxEntries)
    .where(
      and(
        eq(taxEntries.companyId, companyId),
        eq(taxEntries.tax, 'VAT'),
        eq(taxEntries.direction, 'output'),
        or(
          eq(taxEntries.code, exemptCodes.intraCommunity),
          sql`${taxEntries.code} GLOB 'AIC-[0-9]*'`,
        ),
        sql`${day} >= ${`${year}-01-01`}`,
        sql`${day} <= ${`${year}-12-31`}`,
      ),
    )
    .groupBy(sql`substr(${day}, 1, 7)`, taxEntries.code);
  const months = new Map<string, { month: string; arrivals: bigint; dispatches: bigint }>();
  for (const row of rows) {
    const item = months.get(row.month) ?? { month: row.month, arrivals: 0n, dispatches: 0n };
    if (row.code === exemptCodes.intraCommunity) item.dispatches += row.base;
    else item.arrivals += row.base;
    months.set(row.month, item);
  }
  return [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * The previous year's intra-Union goods for the Intrastat thresholds, read only when this year has
 * some: from the books when the engine keeps that year, else from a person's answer to
 * `year.figures`, asked together with the year's other figures.
 */
async function intrastatPreviousOf(
  tx: Transaction,
  companyId: string,
  previous: YearFigures,
): Promise<Pick<YearFigures, 'intrastatArrivals' | 'intrastatDispatches'>> {
  const year = previous.year;
  if (previous.kept) {
    const flows = await intrastatFlowsOf(tx, companyId, year);
    return {
      intrastatArrivals: known(
        flows.reduce((sum, row) => sum + row.arrivals, 0n),
        'books',
      ),
      intrastatDispatches: known(
        flows.reduce((sum, row) => sum + row.dispatches, 0n),
        'books',
      ),
    };
  }
  const answered: Partial<
    Record<'intrastatArrivals' | 'intrastatDispatches', YearFigures['intrastatArrivals']>
  > = {};
  for (const row of await latestAnswers(tx, companyId, 'year.figures', String(year))) {
    const values = (JSON.parse(row.value) as { values: Record<string, string> }).values;
    for (const name of ['intrastatArrivals', 'intrastatDispatches'] as const)
      if (values[name] !== undefined)
        answered[name] = known(
          BigInt(Math.round(Number(values[name]) * 100)),
          'answer',
          row.evidenceId,
        );
  }
  const asked = Object.values(previous).flatMap((figure) =>
    figure && typeof figure === 'object' && 'known' in figure && !figure.known && figure.question
      ? [figure]
      : [],
  );
  const names = [
    ...new Set([
      ...asked.flatMap((figure) =>
        figure.question!.kind === 'year.figures'
          ? ((figure.question!.params as { figures: string[] }).figures ?? [])
          : [],
      ),
      ...(['intrastatArrivals', 'intrastatDispatches'] as const).filter((name) => !answered[name]),
    ]),
  ];
  const question = figuresQuestion(year, names);
  for (const figure of asked)
    if (figure.question!.kind === 'year.figures') figure.question = question;
  const missing = unknown<bigint>(
    `Anul ${year} nu este în registre: achizițiile și livrările intracomunitare de bunuri se iau din declarațiile D390 (sau Intrastat) depuse pentru ${year}.`,
    question,
  );
  return {
    intrastatArrivals: answered.intrastatArrivals ?? missing,
    intrastatDispatches: answered.intrastatDispatches ?? missing,
  };
}

/**
 * The previous year's distance sales and TBE services to EU consumers (art. 278^1 alin. (1) lit.
 * c)), read only when the year has some: from the books when the engine keeps that year, else
 * from a person's answer to `year.figures`, asked together with the year's other figures.
 */
async function distanceTurnoverOf(
  tx: Transaction,
  companyId: string,
  previous: YearFigures,
): Promise<YearFigures['distanceTurnover']> {
  const year = previous.year;
  if (previous.kept)
    return known(
      (await distanceSalesOf(tx, companyId, year)).reduce((sum, sale) => sum + sale.base, 0n),
      'books',
    );
  for (const row of await latestAnswers(tx, companyId, 'year.figures', String(year))) {
    const value = (JSON.parse(row.value) as { values: Record<string, string> }).values
      .distanceTurnover;
    if (value !== undefined)
      return known(BigInt(Math.round(Number(value) * 100)), 'answer', row.evidenceId);
  }
  // One question per year: the figures already asked, and this one.
  const asked = Object.values(previous).flatMap((figure) =>
    figure && typeof figure === 'object' && 'known' in figure && !figure.known && figure.question
      ? [figure]
      : [],
  );
  const names = [
    ...new Set([
      ...asked.flatMap((figure) =>
        figure.question!.kind === 'year.figures'
          ? ((figure.question!.params as { figures: string[] }).figures ?? [])
          : [],
      ),
      'distanceTurnover',
    ]),
  ];
  const question = figuresQuestion(year, names);
  for (const figure of asked)
    if (figure.question!.kind === 'year.figures') figure.question = question;
  return unknown(
    `Anul ${year} nu este în registre: vânzările la distanță și serviciile electronice către consumatori din alte state membre se iau din ultimul decont de TVA depus pentru ${year} („Total an curent”).`,
    question,
  );
}

/** The year's invoices from suppliers established in another member state, and to customers
 * there, by date: what needs the art. 317 code outside VAT (art. 317 alin. (1) lit. b)–c)). */
async function euServicesOf(tx: Transaction, companyId: string, year: number) {
  const eu = Object.keys(euVatPrefixes).filter((code) => code !== 'RO');
  const rows = await tx
    .select({
      id: documents.id,
      kind: documents.kind,
      number: documents.number,
      date: documents.docDate,
      country: parties.country,
    })
    .from(documents)
    .innerJoin(
      parties,
      and(eq(parties.companyId, documents.companyId), eq(parties.id, documents.partyId)),
    )
    .where(
      and(
        eq(documents.companyId, companyId),
        inArray(documents.kind, ['invoice.received', 'invoice.issued']),
        inArray(parties.country, eu),
        gte(documents.docDate, `${year}-01-01`),
        lte(documents.docDate, `${year}-12-31`),
      ),
    )
    .orderBy(asc(documents.docDate), asc(documents.id));
  return rows.map((row) => ({
    date: row.date as LocalDate,
    documentId: row.id,
    number: row.number ?? row.id,
    direction: row.kind === 'invoice.received' ? ('purchase' as const) : ('sale' as const),
    country: row.country,
  }));
}

/** The owner's latest answer to `micro.conditions` for a year. */
async function microOf(
  tx: Transaction,
  companyId: string,
  year: number,
): Promise<Known<MicroConditionsAnswer>> {
  const [row] = (await latestAnswers(tx, companyId, 'micro.conditions', String(year))).slice(-1);
  return row
    ? known(microConditionsAnswer.parse(JSON.parse(row.value)), 'answer', row.evidenceId)
    : unknown(
        `Condițiile microîntreprinderii pentru ${year} nu au fost întrebate.`,
        microQuestion(year),
      );
}

/** What a determination evaluation reads, per transaction: the worklist's detectors share it. */
const cache = new WeakMap<Transaction, Map<string, Promise<unknown>>>();
function memo<T>(tx: Transaction, key: string, run: () => Promise<T>): Promise<T> {
  let map = cache.get(tx);
  if (!map) cache.set(tx, (map = new Map()));
  if (!map.has(key)) map.set(key, run());
  return map.get(key) as Promise<T>;
}

/** A year's determination context. */
export function contextOf(
  tx: Transaction,
  companyId: string,
  year: number,
  today: LocalDate,
): Promise<{
  context: DeterminationContext;
  confirmed: Record<string, string>;
  rows: Awaited<ReturnType<typeof factRows>>;
}> {
  return memo(tx, `context|${companyId}|${year}|${today}`, async () => {
    const rows = await factRows(tx, companyId);
    const contracts = await contractsOf(tx, companyId);
    const previous = await figuresOf(tx, companyId, year - 1, contracts, today);
    const activity = await activityOf(tx, companyId, year);
    // Distance sales: the threshold of art. 278^1 reads the previous year too (core ro/oss).
    if (activity.distance?.length && !activity.start)
      previous.distanceTurnover = await distanceTurnoverOf(tx, companyId, previous);
    // Intra-Union goods: the Intrastat thresholds read the previous year too (core ro/trade).
    if (activity.intrastat?.length && !activity.start)
      Object.assign(previous, await intrastatPreviousOf(tx, companyId, previous));
    return {
      rows,
      confirmed: await confirmations(tx, companyId, rows),
      context: {
        year,
        facts: asFacts(rows),
        previous,
        current: await figuresOf(tx, companyId, year, contracts, today),
        activity,
        contracts,
        micro: await microOf(tx, companyId, year),
        today,
      },
    };
  });
}

/** A year's determinations, with the facts recorded for them. */
export async function determinationsOf(
  tx: Transaction,
  companyId: string,
  year: number,
  rules: RuleContext,
  today: LocalDate,
) {
  const { context, confirmed } = await contextOf(tx, companyId, year, today);
  const determinations = determineYear(context, rules);
  const watches = thresholdWatches(context, rules);
  return { context, confirmed, determinations, watches };
}

const view = (
  determination: Determination,
  facts: readonly ProfileFact[],
  confirmed: Record<string, string>,
) => {
  const key = `${determination.axis}/${determination.year}`;
  const yearly = yearlyAxes.includes(determination.axis);
  const values = facts
    .filter(
      (fact) =>
        fact.axis === determination.axis &&
        fact.effectiveFrom >= `${determination.year}-01-01` &&
        fact.effectiveFrom <= `${determination.year}-12-31`,
    )
    .map((fact) => ({ value: fact.value, effectiveFrom: fact.effectiveFrom }));
  // Recorded from the computation's start: 1 January, or a later day for a value that starts
  // during the year (a registration, a special code obtained, a company set up).
  const from =
    determination.effectiveFrom > `${determination.year}-01-01`
      ? determination.effectiveFrom
      : `${determination.year}-01-01`;
  const atStart = yearly
    ? recordedInYear(facts, determination.axis, determination.year, from)
    : recordedAt(facts, determination.axis, from);
  const computed = [
    { value: determination.value, effectiveFrom: determination.effectiveFrom },
    ...determination.changes,
  ];
  // A recorded change within the year the computation does not make (a cancellation the law
  // does not allow) disagrees too, for the axes that hold until changed.
  const computedAt = (date: string) =>
    determination.changes.filter((change) => change.effectiveFrom <= date).at(-1)?.value ??
    (date >= determination.effectiveFrom ? determination.value : undefined);
  const agrees =
    determination.status !== 'proposed'
      ? null
      : computed.every(
          (item) =>
            (yearly
              ? recordedInYear(facts, determination.axis, determination.year, item.effectiveFrom)
              : recordedAt(facts, determination.axis, item.effectiveFrom)) === item.value,
        ) &&
        atStart !== null &&
        (yearly ||
          values.every((item) => {
            const expected = computedAt(item.effectiveFrom);
            return expected === undefined || expected === item.value;
          }));
  return {
    ...determination,
    recorded: { values, confirmed: confirmed[key] === determination.fingerprint, agrees },
  };
};
const watchOut = (watch: ThresholdWatch) => ({
  ...watch,
  limit: (Number(watch.limit) / 100).toFixed(2),
  value: (Number(watch.value) / 100).toFixed(2),
});

/** The first day the books cover: the start of the company's first financial year; null when
 * it keeps none (the closure is then not restricted). */
async function firstBooksDay(tx: Transaction, companyId: string): Promise<string | null> {
  const [first] = await tx
    .select({ from: fiscalYears.from })
    .from(fiscalYears)
    .where(and(eq(fiscalYears.companyId, companyId), eq(fiscalYears.kind, 'financial')))
    .orderBy(asc(fiscalYears.from))
    .limit(1);
  return first?.from ?? null;
}

/** What the books show over a range of months, for the closure. */
async function booksOf(
  tx: Transaction,
  companyId: string,
  range: { from: string; to: string },
  contracts: readonly Contract[],
  firstDay: string | null,
): Promise<ClosureBooks> {
  const from = `${range.from}-01`;
  const to = lastDay(range.to);
  const months: string[] = [];
  for (let y = Number(range.from.slice(0, 4)), m = Number(range.from.slice(5, 7)); ;) {
    const label = `${y}-${pad(m)}`;
    if (label > range.to) break;
    months.push(label);
    if (++m === 13) [y, m] = [y + 1, 1];
  }
  // Months with an employment contract or an administrator's mandate (W1): payroll taxes in
  // them are the payroll's.
  const mandates = await tx
    .select({ start: employmentTerms.startDate, end: employmentTerms.endDate })
    .from(employmentTerms)
    .where(and(eq(employmentTerms.companyId, companyId), eq(employmentTerms.kind, 'mandate')));
  const employmentMonths = months.filter((month) =>
    [...contracts, ...mandates].some(
      (contract) =>
        contract.start <= lastDay(month) &&
        (contract.end === null || contract.end >= `${month}-01`),
    ),
  );
  const monthsOfLines = async (accounts: string[]) => {
    const rows = await tx
      .select({ month: sql<string>`substr(${entries.date}, 1, 7)` })
      .from(lines)
      .innerJoin(entries, lineEntry)
      .where(
        and(
          eq(lines.companyId, companyId),
          gte(entries.date, from),
          lte(entries.date, to),
          sql`(${sql.join(
            accounts.map((account) => sql`${lines.account} LIKE ${`${account}%`}`),
            sql` OR `,
          )})`,
        ),
      )
      .groupBy(sql`substr(${entries.date}, 1, 7)`);
    return rows.map((row) => row.month).sort();
  };
  // Sick leave and contracts ended over whole quarters: a later month's event brings a quarterly
  // filer's earlier months forward (art. 147 alin. (11)).
  const quarterFrom = quarterMonths(range.from)[0]!;
  const quarterTo = quarterMonths(range.to)[2]!;
  const sick = await tx
    .select({ month: payrollRuns.month })
    .from(payrollLines)
    .innerJoin(
      payrollRuns,
      and(
        eq(payrollRuns.companyId, payrollLines.companyId),
        eq(payrollRuns.id, payrollLines.runId),
      ),
    )
    .where(
      and(
        eq(payrollLines.companyId, companyId),
        gte(payrollRuns.month, quarterFrom),
        lte(payrollRuns.month, quarterTo),
        sql`${payrollLines.input} LIKE '%"sick":%'`,
        sql`not exists (select 1 from ${payrollRunEvents} e where e.company_id = ${payrollRuns.companyId}
          and e.run_id = ${payrollRuns.id} and e.state = 'superseded')`,
      ),
    );
  const ends = contracts.flatMap((contract) =>
    contract.end && contract.end >= `${quarterFrom}-01` && contract.end <= lastDay(quarterTo)
      ? [contract.end.slice(0, 7)]
      : [],
  );
  const european = await tx
    .select({ month: sql<string>`substr(${taxEntries.taxPoint}, 1, 7)` })
    .from(taxEntries)
    .where(
      and(
        eq(taxEntries.companyId, companyId),
        eq(taxEntries.tax, 'VAT'),
        or(
          inArray(taxEntries.code, ['RC-EU-SERV', 'EXP-EU-SERV', exemptCodes.intraCommunity]),
          // Intra-community acquisitions of goods (core ro/trade), D390 type A.
          sql`${taxEntries.code} GLOB 'AIC-[0-9]*'`,
        ),
        gte(taxEntries.taxPoint, from),
        lte(taxEntries.taxPoint, to),
      ),
    )
    .groupBy(sql`substr(${taxEntries.taxPoint}, 1, 7)`);
  const dividends = await tx
    .select({ month: sql<string>`substr(${entries.date}, 1, 7)` })
    .from(entries)
    .innerJoin(
      proposals,
      and(eq(proposals.companyId, entries.companyId), eq(proposals.id, entries.proposalId)),
    )
    .where(
      and(
        eq(entries.companyId, companyId),
        eq(proposals.treatmentId, 'dividends.withhold'),
        gte(entries.date, `${range.from.slice(0, 4)}-01-01`),
        lte(entries.date, to),
      ),
    )
    .groupBy(sql`substr(${entries.date}, 1, 7)`);
  // The other taxes withheld at source (O1), with the return that declares their beneficiaries.
  const withheld = await tx
    .select({
      month: sql<string>`substr(${entries.date}, 1, 7)`,
      treatment: proposals.treatmentId,
      annual: sql<
        string | null
      >`${proposalVersions.effect} ->> '$.explanation.details.withholding.annual'`,
    })
    .from(entries)
    .innerJoin(
      proposals,
      and(eq(proposals.companyId, entries.companyId), eq(proposals.id, entries.proposalId)),
    )
    .innerJoin(
      proposalVersions,
      and(
        eq(proposalVersions.companyId, entries.companyId),
        eq(proposalVersions.proposalId, entries.proposalId),
        eq(proposalVersions.version, entries.version),
      ),
    )
    .where(
      and(
        eq(entries.companyId, companyId),
        inArray(proposals.treatmentId, [
          'loans.withhold',
          'payees.withhold',
          'nonresidents.withhold',
        ]),
        gte(entries.date, `${range.from.slice(0, 4)}-01-01`),
        lte(entries.date, to),
      ),
    );
  const foreign = await tx
    .select({
      id: documents.id,
      date: documents.docDate,
      country: parties.country,
      reverseCharge: sql<number>`exists (select 1 from ${taxEntries} t
        where t.company_id = ${documents.companyId} and t.document_id = ${documents.id}
        and t.code in ('RC-EU-SERV', 'RC-NONEU-SERV'))`,
    })
    .from(documents)
    .innerJoin(
      parties,
      and(eq(parties.companyId, documents.companyId), eq(parties.id, documents.partyId)),
    )
    .where(
      and(
        eq(documents.companyId, companyId),
        eq(documents.kind, 'invoice.received'),
        ne(parties.country, 'RO'),
        gte(documents.docDate, from),
        lte(documents.docDate, to),
      ),
    );
  const payrollTax = await monthsOfLines(['444', '431', '436']);
  const sources = await tx
    .select()
    .from(incomeSources)
    .where(eq(incomeSources.companyId, companyId))
    .orderBy(asc(incomeSources.sourceId), asc(incomeSources.seq));
  const years = [...new Set(months.map((month) => month.slice(0, 4)))];
  const bySource = [...Map.groupBy(sources, (row) => row.sourceId).values()];
  const yearEnds = await tx
    .select({ to: fiscalYears.to })
    .from(fiscalYears)
    .where(
      and(
        eq(fiscalYears.companyId, companyId),
        eq(fiscalYears.kind, 'financial'),
        gte(fiscalYears.to, from),
        lte(fiscalYears.to, to),
      ),
    );
  // The years a fixed asset was held: a card of the register in use, or a tangible asset account
  // (21x) with a balance or a movement.
  const cards = await tx
    .select({ commissionedOn: assets.commissionedOn, disposedOn: assetEvents.date })
    .from(assets)
    .leftJoin(
      assetEvents,
      and(
        eq(assetEvents.companyId, assets.companyId),
        eq(assetEvents.assetId, assets.id),
        eq(assetEvents.kind, 'disposed'),
      ),
    )
    .where(eq(assets.companyId, companyId));
  const tangible = await tx
    .select({ account: lines.account, date: entries.date, side: lines.side, bani: lines.bani })
    .from(lines)
    .innerJoin(entries, lineEntry)
    .where(
      and(eq(lines.companyId, companyId), lte(entries.date, to), sql`${lines.account} LIKE '21%'`),
    );
  const assetYears = years.filter((year) => {
    if (
      cards.some(
        (card) =>
          card.commissionedOn <= `${year}-12-31` &&
          (!card.disposedOn || card.disposedOn >= `${year}-01-01`),
      )
    )
      return true;
    const balances = new Map<string, bigint>();
    for (const row of tangible) {
      if (row.date > `${year}-12-31`) continue;
      if (row.date >= `${year}-01-01`) return true;
      balances.set(
        row.account,
        (balances.get(row.account) ?? 0n) + (row.side === 'D' ? row.bani : -row.bani),
      );
    }
    return [...balances.values()].some((balance) => balance !== 0n);
  });
  return {
    firstDay,
    financialYearEnds: yearEnds.map((row) => row.to),
    employmentMonths,
    payrollEventMonths: [...new Set([...sick.map((row) => row.month), ...ends])].sort(),
    euServiceMonths: european.map((row) => row.month).sort(),
    exemptNoDeductionMonths: (
      await tx
        .selectDistinct({ month: sql<string>`substr(${taxEntries.taxPoint}, 1, 7)` })
        .from(taxEntries)
        .where(
          and(
            eq(taxEntries.companyId, companyId),
            eq(taxEntries.tax, 'VAT'),
            eq(taxEntries.code, exemptCodes.noDeduction),
            gte(taxEntries.taxPoint, from),
            lte(taxEntries.taxPoint, to),
          ),
        )
    )
      .map((row) => row.month)
      .sort(),
    dividendMonths: dividends.map((row) => row.month).sort(),
    withholdings: [
      ...new Map(
        withheld.map((row) => {
          const annual = (row.treatment === 'loans.withhold' ? 'D205' : (row.annual ?? 'D205')) as
            'D205' | 'D207' | 'D112';
          return [`${row.month}|${annual}`, { month: row.month, annual }] as const;
        }),
      ).values(),
    ].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0)),
    foreignPurchases: foreign.map((row) => ({
      month: row.date.slice(0, 7),
      documentId: row.id,
      country: row.country,
      reverseCharge: Boolean(row.reverseCharge),
    })),
    reverseCharges: (
      await tx
        .select({
          date: taxEntries.taxPoint,
          documentId: taxEntries.documentId,
          code: taxEntries.code,
          base: sql<bigint>`sum(${taxEntries.baseBani})`.mapWith(BigInt),
        })
        .from(taxEntries)
        .where(
          and(
            eq(taxEntries.companyId, companyId),
            eq(taxEntries.tax, 'VAT'),
            eq(taxEntries.direction, 'output'),
            inArray(taxEntries.code, ['RC-EU-SERV', 'RC-NONEU-SERV']),
            gte(taxEntries.taxPoint, from),
            lte(taxEntries.taxPoint, to),
          ),
        )
        .groupBy(taxEntries.taxPoint, taxEntries.documentId, taxEntries.code)
    )
      // A booking reversed in the same period leaves nothing to declare.
      .filter((row) => row.base !== 0n)
      .map((row) => ({ date: row.date, documentId: row.documentId ?? '', code: row.code })),
    // Stock the register does not keep: a line on class 3 that no stock move explains (G1),
    // other than a dealer's items under the margin scheme (371 tagged `margin:`, V4, each its
    // purchase document), a stock account's balance the register took over (`stock.opening`'s
    // credit, which a takeover's debit explains in the same entry), and the register's
    // write-downs (39x, tagged by item).
    stockMonths: (
      await tx
        .selectDistinct({ month: sql<string>`substr(${entries.date}, 1, 7)` })
        .from(lines)
        .innerJoin(entries, lineEntry)
        .innerJoin(
          proposals,
          and(eq(proposals.companyId, entries.companyId), eq(proposals.id, entries.proposalId)),
        )
        .where(
          and(
            eq(lines.companyId, companyId),
            gte(entries.date, from),
            lte(entries.date, to),
            sql`${lines.account} LIKE '3%'`,
            sql`not (${lines.account} LIKE '371%' and coalesce(${lines.item}, '') LIKE 'margin:%')`,
            sql`not (${lines.account} LIKE '39%' and coalesce(${lines.item}, '') LIKE 'impairment:stock:%')`,
            // The products' price differences production books (348, G4), by order and account.
            sql`not (${lines.account} LIKE '348%' and coalesce(${lines.item}, '') LIKE 'production:%')`,
            sql`not exists (select 1 from ${stockMoves} m where m.company_id = ${lines.companyId}
              and m.entry_id = ${lines.entryId} and m.line_no = ${lines.lineNo})`,
            sql`${proposals.treatmentId} <> 'stock.opening'`,
            // An opening balance (DESCHIDERE) the register takes over with `stock.opening`; one
            // it does not take over is the month close's (STOCK_LEDGER_DIFFERS).
            sql`${entries.journalCode} <> 'DESCHIDERE'`,
          ),
        )
    )
      .map((row) => row.month)
      .sort(),
    // Production (G4): the months its postings tagged a line (an order, its work in progress, its
    // price differences).
    productionMonths: (
      await tx
        .selectDistinct({ month: sql<string>`substr(${entries.date}, 1, 7)` })
        .from(lines)
        .innerJoin(entries, lineEntry)
        .where(
          and(
            eq(lines.companyId, companyId),
            gte(entries.date, from),
            lte(entries.date, to),
            sql`coalesce(${lines.item}, '') LIKE 'production:%'`,
          ),
        )
    )
      .map((row) => row.month)
      .sort(),
    // The special VAT schemes (V4), by the month of their tax point, entries that stand.
    schemes: (
      await tx
        .selectDistinct({
          month: sql<string>`substr(${taxEntries.taxPoint}, 1, 7)`,
          code: taxEntries.code,
        })
        .from(taxEntries)
        .innerJoin(
          entries,
          and(eq(entries.companyId, taxEntries.companyId), eq(entries.id, taxEntries.entryId)),
        )
        .where(
          and(
            eq(taxEntries.companyId, companyId),
            eq(taxEntries.tax, 'VAT'),
            gte(taxEntries.taxPoint, from),
            lte(taxEntries.taxPoint, to),
            sql`(${taxEntries.code} LIKE 'MS-31%' or ${taxEntries.code} = 'FR-315')`,
            entryStands('"acc_entries"'),
          ),
        )
    ).map((row) => ({
      month: row.month,
      scheme: row.code.startsWith('MS-311')
        ? ('travel' as const)
        : row.code.startsWith('MS-312')
          ? ('goods' as const)
          : ('flat_rate' as const),
    })),
    sponsorshipMonths: await monthsOfLines(['6582']),
    payrollWithoutContractMonths: payrollTax.filter((month) => !employmentMonths.includes(month)),
    incomeSources: years.map((year) => {
      const active = bySource.filter((versions) => {
        const current = versions.filter((row) => row.effectiveFrom <= `${year}-12-31`).at(-1);
        return (
          current &&
          current.startedOn <= `${year}-12-31` &&
          (!current.endedOn || current.endedOn >= `${year}-01-01`)
        );
      });
      return {
        year,
        count: active.length,
        real: active.some(
          (versions) =>
            versions.filter((row) => row.effectiveFrom <= `${year}-12-31`).at(-1)?.method ===
            'sistem_real',
        ),
      };
    }),
    assetYears,
  };
}

/** The closure of a range of months, computed on read. */
export function closureOf(
  tx: Transaction,
  companyId: string,
  range: { from: string; to: string },
  rules: RuleContext,
  today: LocalDate,
): Promise<Closure> {
  return memo(tx, `closure|${companyId}|${range.from}|${range.to}|${today}`, async () => {
    // The closure lists nothing before the books start: the years before the first financial
    // year are not determined.
    const firstDay = await firstBooksDay(tx, companyId);
    const start = Math.max(Number(range.from.slice(0, 4)), Number(firstDay?.slice(0, 4) ?? 0));
    const years: number[] = [];
    for (let year = start; year <= Number(range.to.slice(0, 4)); year++) years.push(year);
    const determinations: Determination[] = [];
    let confirmed: Record<string, string> = {};
    let facts: ProfileFact[] = [];
    let contracts: readonly Contract[] = [];
    for (const year of years) {
      const result = await determinationsOf(tx, companyId, year, rules, today);
      determinations.push(...result.determinations);
      confirmed = { ...confirmed, ...result.confirmed };
      facts = [...result.context.facts];
      contracts = result.context.contracts;
    }
    // From when the company's category files D406, for every month of the years the range
    // touches (the annual assets file reads the year's first month).
    const months: string[] = [];
    for (let year = Number(range.from.slice(0, 4)); year <= Number(range.to.slice(0, 4)); year++)
      for (let month = 1; month <= 12; month++) months.push(`${year}-${pad(month)}`);
    // The half-year report of each year whose June the range covers (`ro.halfyear.report`).
    const halfYear = [];
    for (const year of years) {
      if (`${year}-06` < range.from || `${year}-06` > range.to) continue;
      const decision = await halfYearOf(tx, companyId, year, rules);
      halfYear.push(
        decision.status === 'gap'
          ? {
              year: String(year),
              status: 'gap' as const,
              due: null,
              message: decision.message,
              missing: [],
            }
          : {
              year: String(year),
              status: decision.status,
              due: decision.due,
              message:
                decision.status === 'unknown'
                  ? `Nu se știe dacă raportarea la 30 iunie ${year} se datorează: lipsesc ${decision.missing.join(', ')}.`
                  : `Raportarea contabilă la 30 iunie ${year} se datorează (${decision.lines.join(' ')}): aplicația nu o întocmește.`,
              missing: decision.missing,
            },
      );
    }
    return evaluateClosure({
      interval: range,
      facts,
      determinations,
      confirmed,
      books: { ...(await booksOf(tx, companyId, range, contracts, firstDay)), halfYear },
      d406Start: d406StartOf(rules, months),
    });
  });
}

export class Determinations {
  constructor(
    private readonly commands: Commands,
    private readonly rules: (tx: Transaction, companyId: string) => Promise<RuleContext>,
    private readonly clock: () => number = Date.now,
  ) {}

  private today(): LocalDate {
    return bucharestDate(this.clock());
  }

  /** A year's determinations with their computation, and the thresholds approached. */
  evaluate(actor: Actor, input: z.infer<typeof determinationsInput>) {
    return this.commands.read(actor, 'determinations.evaluate', async (tx) => {
      const result = await determinationsOf(
        tx,
        actor.companyId,
        input.year,
        await this.rules(tx, actor.companyId),
        this.today(),
      );
      return {
        year: input.year,
        determinations: result.determinations.map((item) =>
          view(item, result.context.facts, result.confirmed),
        ),
        watches: result.watches.map(watchOut),
      };
    });
  }

  /** The closure of a range of months. */
  /** The obligation closure over a range of months. A caller who may not read health data reads
   * a D112 without its deadline's rule and the month it counts from, which tell why it is due then
   * (sick leave, art. 147 alin. (11)), as the calendar shows it (`d112WithoutHealth`). */
  closure(actor: Actor, input: z.infer<typeof closureInput>) {
    return this.commands.read(actor, 'closure.evaluate', async (tx, access) => {
      const closure = await closureOf(
        tx,
        actor.companyId,
        input,
        await this.rules(tx, actor.companyId),
        this.today(),
      );
      if ((await this.commands.disclosable(tx, actor, access.role))(['health'])) return closure;
      return {
        ...closure,
        obligations: closure.obligations.map((item) =>
          item.kind === 'D112' ? { ...item, deadline: 'D112', deadlinePeriod: null } : item,
        ),
      };
    });
  }

  /**
   * Opens what a person must answer for a year: each computed determination not yet recorded
   * or that the recorded facts contradict, to confirm (`determination.confirm`); each question
   * an unknown input names (`micro.conditions`, `year.figures`, `profile.fact`). A question still
   * open about an older computation is withdrawn first; an answer that still holds is returned.
   */
  propose(actor: Actor, key: string, input: z.infer<typeof determinationsInput>) {
    return this.commands.run(actor, key, 'determinations.propose', input, 'write', async (tx) => {
      const rules = await this.rules(tx, actor.companyId);
      const result = await determinationsOf(tx, actor.companyId, input.year, rules, this.today());
      const views = result.determinations.map((item) =>
        view(item, result.context.facts, result.confirmed),
      );
      const wanted: QuestionRequest[] = [];
      for (const item of views) {
        if (item.status === 'proposed' && !item.recorded.agrees && !item.recorded.confirmed)
          wanted.push(confirmQuestion(item));
        if (item.status === 'needs_evidence' || item.status === 'rule_gap')
          wanted.push(...item.questions);
      }
      const asked: z.infer<typeof proposeView>['asked'] = [];
      const withdrawn: string[] = [];
      const seen = new Set<string>();
      for (const request of wanted) {
        const identity = `${request.kind}|${request.subject.kind}:${request.subject.id}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        let found = await standing(tx, actor.companyId, request);
        if (found.answered) {
          asked.push({
            ...request,
            questionId: found.answered.row.id,
            reused: true,
            answered: true,
          });
          continue;
        }
        if (found.open && hashOf(JSON.parse(found.open.row.params)) !== hashOf(found.params)) {
          await tx.insert(questionWithdrawals).values({
            companyId: actor.companyId,
            questionId: found.open.row.id,
            reason: 'Calculul determinării s-a schimbat de când a fost întrebată.',
            createdBy: actor.actorId,
            agentId: actor.agentId ?? null,
          });
          withdrawn.push(found.open.row.id);
          found = { ...found, open: null };
        }
        if (found.open) {
          asked.push({ ...request, questionId: found.open.row.id, reused: true, answered: false });
          continue;
        }
        const id = this.commands.ids();
        await tx.insert(questions).values({
          id,
          companyId: actor.companyId,
          kind: request.kind,
          subjectKind: request.subject.kind,
          subjectId: request.subject.id,
          params: canonical(found.params),
          askedBy: actor.actorId,
          agentId: actor.agentId ?? null,
          due: null,
        });
        asked.push({ ...request, questionId: id, reused: false, answered: false });
      }
      return {
        year: input.year,
        determinations: views,
        watches: result.watches.map(watchOut),
        asked,
        withdrawn,
      };
    });
  }
}

/** A worklist item of the determinations detector, before the worklist adds its id. */
export interface DeterminationItem {
  kind: 'determination.missing' | 'threshold.approaching';
  subjectId: string;
  severity: 'block' | 'warn';
  year: number;
  message: string;
  details: { [key: string]: string | number | boolean | null };
}

/**
 * What the worklist shows about determinations for the current year (and the next one in
 * December): the yearly axes without a fact for the year, or whose fact the books contradict,
 * and the thresholds at 80% or more.
 */
export async function determinationItems(
  tx: Transaction,
  companyId: string,
  rules: RuleContext,
  today: LocalDate,
): Promise<DeterminationItem[]> {
  const year = Number(today.slice(0, 4));
  const items: DeterminationItem[] = [];
  for (const current of today.slice(5, 7) === '12' ? [year, year + 1] : [year]) {
    const result = await determinationsOf(tx, companyId, current, rules, today);
    for (const determination of result.determinations) {
      const shown = view(determination, result.context.facts, result.confirmed);
      const yearly = yearlyAxes.includes(determination.axis);
      const missing =
        yearly &&
        determination.status !== 'not_applicable' &&
        determination.status !== 'unsupported' &&
        !shown.recorded.values.length;
      // A conflict needs a recorded value the computation contradicts: a computed value with
      // nothing recorded is missing (yearly axes) or simply not recorded (the others).
      const recorded = yearly
        ? shown.recorded.values.length > 0
        : recordedAt(result.context.facts, determination.axis, `${current}-12-31`) !== null;
      const conflict = shown.recorded.agrees === false && !shown.recorded.confirmed && recorded;
      if (!missing && !conflict) continue;
      items.push({
        kind: 'determination.missing',
        subjectId: `${determination.axis}/${current}`,
        severity: conflict ? 'block' : 'warn',
        year: current,
        message: conflict
          ? `${determination.axis} înregistrat pentru ${current} diferă de calcul: ${determination.summary}`
          : `${determination.axis} nu este stabilit pentru ${current}: ${determination.summary}`,
        details: {
          axis: determination.axis,
          year: current,
          status: determination.status,
          value: determination.value,
          conflict,
          fingerprint: determination.fingerprint,
        },
      });
    }
    for (const watch of result.watches)
      items.push({
        kind: 'threshold.approaching',
        subjectId: `${watch.key}/${current}`,
        severity: watch.percent >= 100 ? 'block' : 'warn',
        year: current,
        message: watch.message,
        details: {
          key: watch.key,
          axis: watch.axis,
          year: current,
          limit: (Number(watch.limit) / 100).toFixed(2),
          value: (Number(watch.value) / 100).toFixed(2),
          level: watch.percent >= 100 ? 100 : 80,
        },
      });
  }
  return items;
}
