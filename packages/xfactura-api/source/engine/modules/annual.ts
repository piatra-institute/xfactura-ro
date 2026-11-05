import { and, asc, desc, eq, gte, lte, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Party } from 'xfactura-core/einvoice';
import { canonical, hashOf } from 'xfactura-core/hash';
import type { ReadSetEntry } from 'xfactura-core/kernel';
import {
  draftDocuments,
  owedDocuments,
  type AnnualStatementKind,
  type DraftFacts,
} from 'xfactura-core/ro/annual/documents';
import type { Cells } from 'xfactura-core/ro/annual/form';
import { halfYearReport, type HalfYearDecision } from 'xfactura-core/ro/annual/half-year';
import {
  informativeRows,
  type AnnualBalance,
  type AnnualOpenItem,
  type AnnualYearBooks,
  type InformativeAnswer,
  type InformativeAsk,
  type InformativeSpec,
} from 'xfactura-core/ro/annual/informative';
import type { DisclosuresAnswer } from 'xfactura-core/ro/annual/questions';
import type { QuestionRequest } from 'xfactura-core/questions/kinds';
import { recordedAt } from 'xfactura-core/ro/determinations';
import { RuleGapError, type RuleContext } from 'xfactura-core/rules';
import type { LocalDate } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import {
  employmentTerms,
  entries,
  fiscalYears,
  fxRates,
  lines,
  openItems,
  parties,
  profileFacts,
  questions,
  questionWithdrawals,
} from '../db/schema';
import type { Actor, Commands } from '../kernel/commands';
import { standing } from './questions';

/*
 * The annual statements' package beyond the forms (Y2): what the registers give F30, the chapters
 * a person answers, the disclosures of the notes, the accompanying documents owed and the engine's
 * drafts, the signatures, the inactivity declaration and the half-year report decision. Pure rules
 * live in core `ro/annual`; this module reads the books for them and opens the questions.
 */

const debitSum =
  sql<bigint>`sum(CASE WHEN ${lines.side} = 'D' THEN ${lines.bani} ELSE 0 END)`.mapWith(BigInt);
const creditSum =
  sql<bigint>`sum(CASE WHEN ${lines.side} = 'C' THEN ${lines.bani} ELSE 0 END)`.mapWith(BigInt);
const join = and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId));
const partnerOf = sql<
  string | null
>`CASE WHEN ${lines.openItemId} IS NOT NULL THEN ${lines.partyId} END`;
const always = '1900-01-01';

async function partyKinds(tx: Transaction, companyId: string) {
  const rows = await tx
    .select({ id: parties.id, country: parties.country, kind: parties.kind })
    .from(parties)
    .where(eq(parties.companyId, companyId));
  return new Map(rows.map((row) => [row.id, { country: row.country, kind: row.kind }]));
}

/** Balances by account and, on the accounts kept on open items, by partner, debit positive. */
async function balancesAt(
  tx: Transaction,
  companyId: string,
  where: { from: string; to: string; journal?: string },
): Promise<AnnualBalance[]> {
  const kinds = await partyKinds(tx, companyId);
  const rows = await tx
    .select({ account: lines.account, partner: partnerOf, debit: debitSum, credit: creditSum })
    .from(lines)
    .innerJoin(entries, join)
    .where(
      and(
        eq(lines.companyId, companyId),
        gte(entries.date, where.from),
        lte(entries.date, where.to),
        where.journal ? eq(entries.journalCode, where.journal) : undefined,
      ),
    )
    .groupBy(lines.account, partnerOf)
    .orderBy(asc(lines.account), asc(partnerOf));
  return rows
    .filter((row) => row.debit !== row.credit)
    .map((row) => ({
      account: row.account,
      bani: row.debit - row.credit,
      partner: row.partner ? (kinds.get(row.partner) ?? null) : null,
    }));
}

/** A financial year of the books, as the informative data reads it. */
export async function yearBooks(
  tx: Transaction,
  companyId: string,
  year: { from: string; to: string },
): Promise<AnnualYearBooks> {
  const number = Number(year.to.slice(0, 4));
  const kinds = await partyKinds(tx, companyId);
  const turnover = await tx
    .select({ account: lines.account, debit: debitSum, credit: creditSum })
    .from(lines)
    .innerJoin(entries, join)
    .where(
      and(
        eq(lines.companyId, companyId),
        gte(entries.date, year.from),
        lte(entries.date, year.to),
        ne(entries.journalCode, 'INCHIDERE'),
      ),
    )
    .groupBy(lines.account)
    .orderBy(asc(lines.account));
  const items = await tx
    .select({
      id: openItems.id,
      account: openItems.controlAccount,
      normalSide: openItems.normalSide,
      dueDate: openItems.dueDate,
      partyId: openItems.partyId,
      debit: debitSum,
      credit: creditSum,
    })
    .from(lines)
    .innerJoin(entries, join)
    .innerJoin(
      openItems,
      and(eq(openItems.companyId, lines.companyId), eq(openItems.id, lines.openItemId)),
    )
    .where(and(eq(lines.companyId, companyId), lte(entries.date, year.to)))
    .groupBy(openItems.id)
    .orderBy(asc(openItems.id));
  const open: AnnualOpenItem[] = items
    .map((item) => ({
      account: item.account,
      bani: item.normalSide === 'D' ? item.debit - item.credit : item.credit - item.debit,
      dueDate: item.dueDate,
      partner: kinds.get(item.partyId) ?? { country: 'RO', kind: 'unknown' },
    }))
    .filter((item) => item.bani !== 0n);
  // Dividends: the credits of 457 in entries debiting 117 (from retained earnings) or 463
  // (interim).
  const dividendLines = await tx
    .select({ entryId: lines.entryId, account: lines.account, side: lines.side, bani: lines.bani })
    .from(lines)
    .innerJoin(entries, join)
    .where(
      and(
        eq(lines.companyId, companyId),
        gte(entries.date, year.from),
        lte(entries.date, year.to),
        sql`(substr(${lines.account}, 1, 3) IN ('457', '117', '463'))`,
      ),
    );
  const byEntry = new Map<string, typeof dividendLines>();
  for (const line of dividendLines)
    byEntry.set(line.entryId, [...(byEntry.get(line.entryId) ?? []), line]);
  const dividends = { retained: 0n, interim: 0n };
  for (const group of byEntry.values()) {
    const credited = group
      .filter((line) => line.account.startsWith('457') && line.side === 'C')
      .reduce((sum, line) => sum + BigInt(line.bani), 0n);
    if (!credited) continue;
    if (group.some((line) => line.account.startsWith('117') && line.side === 'D'))
      dividends.retained += credited;
    else if (group.some((line) => line.account.startsWith('463') && line.side === 'D'))
      dividends.interim += credited;
  }
  const contracts = await contractsOf(tx, companyId);
  const headcount = Array.from({ length: 12 }, (_, index) => {
    const from = `${number}-${String(index + 1).padStart(2, '0')}-01`;
    const to = new Date(Date.UTC(number, index + 1, 0)).toISOString().slice(0, 10);
    return new Set(
      contracts
        .filter((item) => item.start <= to && (item.end === null || item.end >= from))
        .map((item) => item.employeeId),
    ).size;
  });
  const end = `${number}-12-31`;
  return {
    year: number,
    closing: await balancesAt(tx, companyId, { from: always, to: year.to }),
    turnover: turnover.map((row) => ({
      account: row.account,
      debit: row.debit,
      credit: row.credit,
    })),
    openItems: open,
    headcount,
    employeesAtEnd: new Set(
      contracts
        .filter((item) => item.start <= end && (item.end === null || item.end >= end))
        .map((item) => item.employeeId),
    ).size,
    dividends,
  };
}

async function contractsOf(tx: Transaction, companyId: string) {
  const rows = await tx
    .select()
    .from(employmentTerms)
    .where(eq(employmentTerms.companyId, companyId))
    .orderBy(asc(employmentTerms.contractId), asc(employmentTerms.seq));
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) latest.set(row.contractId, row);
  return [...latest.values()].map((row) => ({
    employeeId: row.employeeId,
    start: row.startDate,
    end: row.endDate ?? null,
  }));
}

export async function financialYear(tx: Transaction, companyId: string, end: string) {
  const [row] = await tx
    .select()
    .from(fiscalYears)
    .where(
      and(
        eq(fiscalYears.companyId, companyId),
        eq(fiscalYears.kind, 'financial'),
        eq(fiscalYears.to, end),
      ),
    );
  return row;
}

async function factsOf(tx: Transaction, companyId: string) {
  return (
    await tx
      .select()
      .from(profileFacts)
      .where(eq(profileFacts.companyId, companyId))
      .orderBy(asc(profileFacts.effectiveFrom), asc(profileFacts.createdAt))
  ).map((row) => ({
    axis: row.axis,
    value: row.value,
    effectiveFrom: row.effectiveFrom as LocalDate,
  }));
}

/** The F30 subject of a statement's chapter, disclosures and documents. */
const subject = (statement: string, year: number, part?: string) => ({
  kind: 'annual',
  id: [statement, year, part].filter((item) => item !== undefined).join('/'),
});

export type InformativeResult = {
  rows: Record<string, Cells>;
  asks: InformativeAsk[];
  missing: QuestionRequest[];
  issues: { code: string; message: string }[];
  /** The answers read, for staleness. */
  inputs: ReadSetEntry[];
};

/**
 * F30 of a statement from the registers and the answers: the previous year from the engine's
 * books when it keeps it, else from the opening entries (balances only).
 */
export async function informativeOf(
  tx: Transaction,
  companyId: string,
  statement: AnnualStatementKind,
  year: { from: string; to: string },
  spec: InformativeSpec,
): Promise<InformativeResult> {
  const number = Number(year.to.slice(0, 4));
  const before = await financialYear(tx, companyId, `${number - 1}-12-31`);
  const opening = before
    ? null
    : await balancesAt(tx, companyId, { from: year.from, to: year.to, journal: 'DESCHIDERE' });
  const facts = await factsOf(tx, companyId);
  const books = {
    form: recordedAt(facts, 'entity.form', year.to) ?? 'srl',
    current: await yearBooks(tx, companyId, year),
    previous: before
      ? await yearBooks(tx, companyId, before)
      : opening && opening.length
        ? { opening }
        : null,
  };
  // The chapters asked, then their answers.
  const first = informativeRows(spec, books, {});
  const answers: Record<string, InformativeAnswer> = {};
  const inputs: ReadSetEntry[] = [];
  const missing: QuestionRequest[] = [];
  for (const ask of first.asks) {
    const request: QuestionRequest = {
      kind: 'annual.informative',
      subject: subject(statement, number, ask.chapter),
      params: { statement, year: number, chapter: ask.chapter, rows: ask.rows } as never,
    };
    const found = await standing(tx, companyId, request);
    if (!found.answered) {
      missing.push(request);
      continue;
    }
    const value = JSON.parse(found.answered.answer!.value) as InformativeAnswer;
    answers[ask.chapter] = value;
    inputs.push({ kind: 'answer', id: found.answered.row.id, version: found.answered.answer!.id });
  }
  const result = informativeRows(spec, books, answers);
  const contracts = await contractsOf(tx, companyId);
  inputs.push({ kind: 'profile', id: 'employment.contracts', version: hashOf(contracts) });
  return {
    rows: result.rows,
    asks: result.asks,
    missing,
    issues: result.issues.map((issue) => ({ code: issue.code, message: issue.message })),
    inputs,
  };
}

/** The person's disclosures for a statement, if answered. */
export async function disclosuresOf(
  tx: Transaction,
  companyId: string,
  statement: AnnualStatementKind,
  year: number,
) {
  const request: QuestionRequest = {
    kind: 'annual.disclosures',
    subject: subject(statement, year),
    params: { statement, year },
  };
  const found = await standing(tx, companyId, request);
  return {
    request,
    answer: found.answered ? (JSON.parse(found.answered.answer!.value) as DisclosuresAnswer) : null,
    input: found.answered
      ? ({
          kind: 'answer',
          id: found.answered.row.id,
          version: found.answered.answer!.id,
        } as ReadSetEntry)
      : null,
  };
}

export type SignatureRole = {
  role: 'administrator' | 'accountant';
  name: string;
  /** calit_intocmit, for the accountant. */
  quality?: number;
  membership?: string;
  cif?: string;
};

/**
 * The signatures the statements carry (Legea 82/1991 art. 28 alin. (10), (11) și (13); OMF nr.
 * 2.036/2025 anexa nr. 1 pct. 1.6): the administrator, and the economic director, the chief
 * accountant or another person so empowered, employed under the law (qualities 11–13), or a
 * CECCAR member (21 natural person, 22 legal person) with its membership number and fiscal code.
 * Checked when the return is authorized; the signatures themselves are on the filed PDF.
 */
export async function signatureProblems(
  tx: Transaction,
  companyId: string,
  year: number,
  signatures: readonly SignatureRole[] | undefined,
): Promise<{ code: string; message: string }[]> {
  const problems: { code: string; message: string }[] = [];
  const administrator = signatures?.find((item) => item.role === 'administrator');
  const accountant = signatures?.find((item) => item.role === 'accountant');
  if (!administrator?.name.trim())
    problems.push({
      code: 'SIGNATURE_ADMINISTRATOR',
      message:
        'Situațiile financiare anuale se semnează și de administrator sau de persoana care gestionează entitatea (Legea nr. 82/1991 art. 28 alin. (13)).',
    });
  if (!accountant?.name.trim() || accountant.quality === undefined) {
    problems.push({
      code: 'SIGNATURE_ACCOUNTANT',
      message:
        'Situațiile financiare anuale se semnează de directorul economic, contabilul-șef sau altă persoană împuternicită, angajată potrivit legii, ori de un membru CECCAR (art. 28 alin. (10)–(11)).',
    });
    return problems;
  }
  if ([21, 22].includes(accountant.quality) && (!accountant.membership || !accountant.cif))
    problems.push({
      code: 'SIGNATURE_CECCAR',
      message:
        'Membrul CECCAR care semnează se identifică prin numărul de înregistrare în Corpul Experților Contabili și Contabililor Autorizați și prin codul fiscal (art. 28 alin. (11)).',
    });
  if ([11, 12, 13].includes(accountant.quality)) {
    // Art. 10 alin. (2): a person employed under the law. The books must show an employment
    // contract running in the year; which employee signs the person states.
    const contracts = await contractsOf(tx, companyId);
    const employed = contracts.some(
      (item) => item.start <= `${year}-12-31` && (item.end === null || item.end >= `${year}-01-01`),
    );
    if (!employed)
      problems.push({
        code: 'SIGNATURE_NOT_EMPLOYED',
        message: `Calitatea ${accountant.quality} (director economic, contabil-șef sau persoană împuternicită) cere o persoană angajată (Legea nr. 82/1991 art. 10 alin. (2)), dar registrele nu au niciun contract de muncă în ${year}: semnează un membru CECCAR (21 sau 22).`,
      });
  }
  return problems;
}

export type DocumentStatus = {
  document: string;
  title: string;
  clauses: string[];
  drafted: boolean;
  /** The engine's draft hash, when drafted. */
  draft: string | null;
  supplied: { questionId: string; evidenceId: string } | null;
  request: QuestionRequest;
};

/** The accompanying documents owed, the drafts and which a person supplied. */
export async function documentsOf(
  tx: Transaction,
  companyId: string,
  facts: DraftFacts,
  audit: { kind: 'statutory' | 'voluntary' | 'censors' } | undefined,
) {
  const drafts = draftDocuments(facts);
  const statuses: DocumentStatus[] = [];
  for (const owed of owedDocuments(facts.statement, audit)) {
    const draft = drafts.find((item) => item.document === owed.document);
    const request: QuestionRequest = {
      kind: 'annual.document',
      subject: subject(facts.statement, facts.year, owed.document),
      params: {
        statement: facts.statement,
        year: facts.year,
        document: owed.document,
        title: owed.title,
        draft: draft?.hash ?? null,
      },
    };
    const found = await standing(tx, companyId, request);
    statuses.push({
      ...owed,
      draft: draft?.hash ?? null,
      supplied: found.answered
        ? {
            questionId: found.answered.row.id,
            evidenceId: (JSON.parse(found.answered.answer!.value) as { evidenceId: string })
              .evidenceId,
          }
        : null,
      request,
    });
  }
  return { drafts, statuses };
}

/** Whether the year's books show any activity since they began: revenue or expense lines. */
export async function activitySince(tx: Transaction, companyId: string, to: string) {
  const [row] = await tx
    .select({ count: sql<number>`count(*)` })
    .from(lines)
    .innerJoin(entries, join)
    .where(
      and(
        eq(lines.companyId, companyId),
        lte(entries.date, to),
        sql`substr(${lines.account}, 1, 1) IN ('6', '7')`,
      ),
    );
  return Number(row?.count ?? 0) > 0;
}

/** The BNR EUR rate valid at a year's close, if imported. */
async function closingEur(tx: Transaction, year: number) {
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
  return row ? { rate: row.rate, date: row.rateDate } : null;
}

/** The half-year report decision for a year, from the previous year's net turnover. */
export async function halfYearOf(
  tx: Transaction,
  companyId: string,
  year: number,
  rules: RuleContext,
): Promise<HalfYearDecision | { status: 'gap'; message: string }> {
  const before = await financialYear(tx, companyId, `${year - 1}-12-31`);
  let turnover: bigint | null = null;
  if (before) {
    const books = await yearBooks(tx, companyId, before);
    turnover = books.turnover
      .filter((row) => /^(70|7411)/.test(row.account))
      .reduce((sum, row) => sum + row.credit - row.debit, 0n);
  }
  const facts = await factsOf(tx, companyId);
  try {
    return halfYearReport(
      year,
      {
        previousNetTurnover: turnover,
        rate: await closingEur(tx, year - 1),
        excluded:
          recordedAt(facts, 'activity.none', `${year}-06-30`) === 'yes'
            ? 'fără activitate de la înființare'
            : null,
      },
      rules,
    );
  } catch (error) {
    if (error instanceof RuleGapError) return { status: 'gap', message: error.message };
    throw error;
  }
}

export const annualInput = z
  .object({
    kind: z.enum(['S1005', 'S1003']),
    year: z.number().int().min(2025).max(2100),
  })
  .strict();

export const annualAskView = z.object({
  kind: z.string(),
  year: z.number(),
  asked: z.array(
    z.object({
      kind: z.string(),
      subject: z.object({ kind: z.string(), id: z.string() }),
      questionId: z.string(),
      reused: z.boolean(),
      answered: z.boolean(),
    }),
  ),
  withdrawn: z.array(z.string()),
});

/** Opens the questions a statement's package waits on, as `determinations.propose` does. */
export async function openQuestions(
  tx: Transaction,
  commands: Commands,
  actor: Actor,
  wanted: readonly QuestionRequest[],
) {
  const asked: z.infer<typeof annualAskView>['asked'] = [];
  const withdrawn: string[] = [];
  for (const request of wanted) {
    let found = await standing(tx, actor.companyId, request);
    if (found.answered) {
      asked.push({
        kind: request.kind,
        subject: request.subject,
        questionId: found.answered.row.id,
        reused: true,
        answered: true,
      });
      continue;
    }
    // A question open about other rows or another draft is replaced.
    if (found.open && hashOf(JSON.parse(found.open.row.params)) !== hashOf(found.params)) {
      await tx.insert(questionWithdrawals).values({
        companyId: actor.companyId,
        questionId: found.open.row.id,
        reason: 'Ce se întreabă s-a schimbat (registrele sau proiectul documentului).',
        createdBy: actor.actorId,
        agentId: actor.agentId ?? null,
      });
      withdrawn.push(found.open.row.id);
      found = { ...found, open: null };
    }
    if (found.open) {
      asked.push({
        kind: request.kind,
        subject: request.subject,
        questionId: found.open.row.id,
        reused: true,
        answered: false,
      });
      continue;
    }
    const id = commands.ids();
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
    asked.push({
      kind: request.kind,
      subject: request.subject,
      questionId: id,
      reused: false,
      answered: false,
    });
  }
  return { asked, withdrawn };
}

/** The company's registered office as written on the documents. */
export function addressLine(details: Party) {
  return [...details.address.lines, details.address.city].filter(Boolean).join(', ');
}
