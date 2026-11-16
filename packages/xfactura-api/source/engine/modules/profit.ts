import { and, asc, eq, gte, inArray, lte, ne, or, like, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { JsonValue } from 'xfactura-core/kernel';
import { normalizePlate, type ProfitAccountAnswer } from 'xfactura-core/questions/kinds';
import { fiscalRegister, natureOf, type RegisterInput } from 'xfactura-core/ro/profit';
import type { CorrectionPosition, ProfitPosition } from 'xfactura-core/ro/treatments/profit-tax';
import type { LocalDate } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import { documents, entries, lines, proposals, proposalVersions } from '../db/schema';
import type { Actor, Commands } from '../kernel/commands';
import { entryStands } from '../kernel/ledger';
import { loadState } from '../kernel/state';
import type { ProfitWorkItem, WorkStep } from '../kernel/work';
import {
  causeFromQuestion,
  dateLabel,
  idLabel,
  textLabel,
  type DetailLabels,
  type WorkCause,
} from '../kernel/work-names';
import { standing } from './questions';

/*
 * The profit tax's registers (core ro/profit): the fiscal register (Registrul de evidență
 * fiscală, OMF nr. 808/2026) and the loss vintages, both projections of the computations posted
 * by `tax.profit` and of the prior-year corrections; and what the worklist shows of the module.
 */

export const profitYearInput = z.object({ year: z.number().int().min(2016).max(2100) }).strict();

interface Posting {
  entryId: string;
  number: number;
  seq: number;
  date: string;
  treatmentId: string;
  input: Record<string, unknown>;
  position: ProfitPosition | CorrectionPosition | null;
  lines: RegisterInput['lines'];
}

/** The postings that stand of the profit tax and of prior-year corrections, in posting order. */
export async function profitPostings(tx: Transaction, companyId: string): Promise<Posting[]> {
  const rows = await tx
    .select({
      entryId: entries.id,
      number: entries.number,
      seq: entries.seq,
      date: entries.date,
      treatmentId: proposals.treatmentId,
      input: proposalVersions.input,
      effect: proposalVersions.effect,
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
        inArray(proposals.treatmentId, ['tax.profit', 'correction.priorYear']),
        entryStands('"acc_entries"'),
      ),
    )
    .orderBy(asc(entries.seq));
  return rows.map((row) => {
    const details =
      (JSON.parse(row.effect ?? '{}') as { explanation?: { details?: Record<string, unknown> } })
        .explanation?.details ?? {};
    return {
      entryId: row.entryId,
      number: Number(row.number),
      seq: Number(row.seq),
      date: row.date,
      treatmentId: row.treatmentId,
      input: JSON.parse(row.input) as Record<string, unknown>,
      position: (details.position ?? null) as Posting['position'],
      lines: (details.lines ?? []) as RegisterInput['lines'],
    };
  });
}

const isPosition = (value: Posting['position']): value is ProfitPosition =>
  value?.schema === 'profit-position@1';
const isCorrection = (value: Posting['position']): value is CorrectionPosition =>
  value?.schema === 'profit-correction@1';

/** The fiscal register and the loss vintages, read from the books. */
export class Profit {
  constructor(private readonly commands: Commands) {}

  /**
   * The fiscal register of a year: every computation of the year and every correction of it, in
   * posting order, each line with the accounts it came from and, for those, the entries that
   * booked them in the period (at most 50 per account).
   */
  register(actor: Actor, input: z.infer<typeof profitYearInput>) {
    return this.commands.read(actor, 'profit.register', async (tx) => {
      const all = await profitPostings(tx, actor.companyId);
      const mine = all.filter((posting) =>
        isPosition(posting.position)
          ? posting.position.year === input.year
          : isCorrection(posting.position) && posting.position.year === input.year,
      );
      const rows = fiscalRegister(
        mine.map((posting): RegisterInput => {
          const position = posting.position!;
          return isPosition(position)
            ? {
                entryId: posting.entryId,
                date: posting.date,
                period: position.period,
                kind: position.kind,
                rows: position.rows,
                lines: posting.lines,
              }
            : {
                entryId: posting.entryId,
                date: posting.date,
                period: String(position.year),
                kind: 'correction',
                rows: null,
                lines: [],
                correction: position,
              };
        }),
      );
      // Where each line's amounts were booked: the entries on its accounts in the period.
      const traced = new Map<string, JsonValue>();
      for (const posting of mine) {
        if (!isPosition(posting.position)) continue;
        const { start, end } = posting.position;
        for (const account of [...new Set(posting.lines.flatMap((line) => line.accounts))]) {
          const key = `${posting.entryId}|${account}`;
          if (traced.has(key) || !/^[67]/.test(account)) continue;
          const booked = await tx
            .select({
              entryId: entries.id,
              number: entries.number,
              date: entries.date,
              description: entries.description,
              documentId: proposals.documentId,
              documentNumber: documents.number,
              debit:
                sql<bigint>`sum(CASE WHEN ${lines.side} = 'D' THEN ${lines.bani} ELSE 0 END)`.mapWith(
                  BigInt,
                ),
              credit:
                sql<bigint>`sum(CASE WHEN ${lines.side} = 'C' THEN ${lines.bani} ELSE 0 END)`.mapWith(
                  BigInt,
                ),
            })
            .from(lines)
            .innerJoin(
              entries,
              and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId)),
            )
            .innerJoin(
              proposals,
              and(eq(proposals.companyId, entries.companyId), eq(proposals.id, entries.proposalId)),
            )
            .leftJoin(
              documents,
              and(
                eq(documents.companyId, proposals.companyId),
                eq(documents.id, proposals.documentId),
              ),
            )
            .where(
              and(
                eq(lines.companyId, actor.companyId),
                or(eq(lines.account, account), like(lines.account, `${account}.%`)),
                gte(entries.date, start || `${input.year}-01-01`),
                lte(entries.date, end),
                ne(entries.journalCode, 'INCHIDERE'),
              ),
            )
            .groupBy(entries.id)
            .orderBy(asc(entries.seq))
            .limit(50);
          traced.set(
            key,
            booked.map((row) => ({
              entryId: row.entryId,
              number: Number(row.number),
              date: row.date,
              description: row.description,
              documentId: row.documentId,
              document: row.documentNumber,
              debit: (row.debit ?? 0n).toString(),
              credit: (row.credit ?? 0n).toString(),
            })),
          );
        }
      }
      return {
        year: input.year,
        format: 'OMF808/2026',
        columns: [
          'Nr. crt.',
          'Explicații privind operațiunile efectuate și calculul rezultatului fiscal și al impozitului pe profit',
          'Valoarea - lei -',
        ],
        items: rows.map((row) => ({
          ...row,
          entries: row.accounts.flatMap((account) => {
            const found = traced.get(`${row.entryId}|${account}`);
            return Array.isArray(found) ? found : [];
          }),
        })),
        next: null,
      };
    });
  }

  /** The loss vintages each year's computation started from, used and left, up to a year. */
  losses(actor: Actor, input: z.infer<typeof profitYearInput>) {
    return this.commands.read(actor, 'profit.losses', async (tx) => {
      const latest = new Map<string, ProfitPosition>();
      for (const posting of await profitPostings(tx, actor.companyId))
        if (isPosition(posting.position) && posting.position.kind !== 'quarter')
          latest.set(posting.position.period, posting.position);
      const items = [...latest.values()]
        .filter((position) => position.year <= input.year)
        .sort((a, b) => a.year - b.year)
        .map((position) => ({
          year: position.year,
          kind: position.kind,
          before: position.losses.before,
          used: position.losses.used,
          after: position.losses.after,
          created: position.rows.P40a ?? '0',
          recovered: position.rows.P39a ?? '0',
        }));
      return {
        items,
        next: null,
        clauses: [
          'ANAF/Cod-fiscal-consolidat:art.31(1)',
          'ANAF/Cod-fiscal-consolidat:art.31(7)-(8)',
        ],
      };
    });
  }
}

/** An item of the profit tax module, as the worklist reads it (core ro/profit/agent.ts). */
export type ProfitWork = ProfitWorkItem;

const agent = (operation: string, inputHint: WorkStep['inputHint'] = {}): WorkStep => ({
  operation,
  by: 'agent',
  inputHint,
});
const human = (operation: string, inputHint: WorkStep['inputHint'] = {}): WorkStep => ({
  operation,
  by: 'human',
  inputHint,
});

/**
 * What the profit tax waits on, for the years under profit tax that are not yet past their
 * annual return (the current one, and the previous one until its D101 is due): accounts whose
 * deductibility depends on facts nobody classified, or holding a vehicle's costs under another
 * classification; fixed assets without a fiscal basis; prior-year corrections not yet carried
 * into the corrected year's tax.
 */
export async function profitWork(
  tx: Transaction,
  companyId: string,
  today: LocalDate,
): Promise<ProfitWork[]> {
  const { loaded } = await loadState(tx, companyId, { profile: true, assets: true });
  const items: ProfitWork[] = [];
  const current = Number(today.slice(0, 4));
  const regimeOf = (year: number) => {
    let start: string | null = null;
    for (const quarter of [1, 2, 3, 4]) {
      const day = `${year}-${String(quarter * 3).padStart(2, '0')}-${quarter === 1 || quarter === 4 ? '31' : '30'}`;
      let value: string | null = null;
      for (const fact of loaded.profile)
        if (fact.axis === 'income_tax' && fact.effectiveFrom <= day) value = fact.value;
      if (value === 'profit') {
        start = `${year}-${String(quarter * 3 - 2).padStart(2, '0')}-01`;
        break;
      }
    }
    return start;
  };
  for (const year of [current - 1, current]) {
    const start = regimeOf(year);
    if (!start) continue;
    const end = `${year}-12-31` < today ? `${year}-12-31` : today;
    if (start > end) continue;
    // Accounts with turnover whose treatment depends on facts.
    const turnover = await tx
      .select({
        account: lines.account,
        net: sql<bigint>`sum(CASE WHEN ${lines.side} = 'D' THEN ${lines.bani} ELSE -${lines.bani} END)`.mapWith(
          BigInt,
        ),
      })
      .from(lines)
      .innerJoin(
        entries,
        and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId)),
      )
      .where(
        and(
          eq(lines.companyId, companyId),
          or(like(lines.account, '6%'), like(lines.account, '7%')),
          gte(entries.date, start),
          lte(entries.date, end),
          ne(entries.journalCode, 'INCHIDERE'),
        ),
      )
      .groupBy(lines.account);
    const classification = async (account: string) => {
      for (const id of [account, account.split('.')[0]!]) {
        // An account the question's parameters refuse has no answer to read.
        const found = await standing(tx, companyId, {
          kind: 'profit.account',
          subject: { kind: 'account', id },
          params: { account: id },
        }).catch((error: unknown) => {
          if (error instanceof z.ZodError) return null;
          throw error;
        });
        if (!found) continue;
        const value = found.answered?.answer?.value;
        if (value)
          return (typeof value === 'string' ? JSON.parse(value) : value) as ProfitAccountAnswer;
      }
      return null;
    };
    const ask = (
      account: string,
      message: string,
      details: ProfitWork['details'],
      labels: DetailLabels,
    ) => {
      const request = {
        kind: 'profit.account' as const,
        subject: { kind: 'account', id: account },
        params: { account },
      };
      items.push({
        kind: 'profit.unclassified',
        subject: { kind: 'account', id: `${account}/${year}` },
        severity: 'block',
        year,
        message,
        causes: [causeFromQuestion(request, message)],
        details: { account, year, ...details },
        labels: { account: textLabel('Cont'), year: { label: 'An', type: 'period' }, ...labels },
        next: [agent('questions.ask', request), human('questions.answer')],
      });
    };
    for (const row of turnover) {
      if (row.net === 0n || natureOf(row.account).nature !== 'classify') continue;
      if (await classification(row.account)) continue;
      ask(
        row.account,
        `Contul ${row.account} are rulaj în ${year}, an cu impozit pe profit: tratamentul lui fiscal depinde de natura cheltuielii sau a venitului, pe care nu a precizat-o nimeni.`,
        { nature: 'classify' },
        { nature: textLabel('Natură') },
      );
    }
    // Purchases booked as a vehicle's whose account is not that vehicle's.
    const vehicles = await tx
      .select({ input: proposalVersions.input })
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
          eq(proposals.treatmentId, 'invoices.recognize'),
          gte(entries.date, start),
          lte(entries.date, end),
          entryStands('"acc_entries"'),
        ),
      );
    const seen = new Set<string>();
    for (const { input } of vehicles) {
      const parsed = JSON.parse(input) as {
        account?: string;
        vehicle?: string;
        allocations?: { account: string; vehicle?: string }[];
      };
      const parts = parsed.allocations ?? [
        { account: parsed.account ?? '', vehicle: parsed.vehicle },
      ];
      for (const part of parts) {
        if (!part.vehicle || !/^6/.test(part.account) || seen.has(part.account)) continue;
        seen.add(part.account);
        const given = await classification(part.account);
        const plate = normalizePlate(part.vehicle);
        if (given?.nature === 'vehicle' && normalizePlate(given.vehicle ?? '') === plate) continue;
        ask(
          part.account,
          `Contul ${part.account} ține cheltuieli ale vehiculului ${plate} (facturi recunoscute cu vehiculul), dar nu este clasificat ca al lui: limita de 50% a art. 25 alin. (3) lit. l) se aplică pe cont; folosiți un cont analitic al vehiculului sau clasificați contul.`,
          { vehicle: plate },
          { vehicle: textLabel('Vehicul') },
        );
      }
    }
    // Fixed assets in use without a fiscal basis.
    for (const asset of loaded.assets.values()) {
      if (asset.fiscal || asset.commissionedOn > end) continue;
      if (asset.disposedOn && asset.disposedOn < start) continue;
      if (items.some((item) => item.kind === 'asset.fiscalMissing' && item.subject.id === asset.id))
        continue;
      items.push({
        kind: 'asset.fiscalMissing',
        subject: { kind: 'asset', id: asset.id },
        severity: 'block',
        year,
        message: `${asset.number} ${asset.name} nu are regimul fiscal de amortizare înregistrat (art. 28): impozitul pe profit nu se poate calcula.`,
        details: { assetId: asset.id, number: asset.number, commissionedOn: asset.commissionedOn },
        labels: {
          assetId: idLabel('Mijloc fix', 'asset'),
          number: textLabel('Număr'),
          commissionedOn: dateLabel('Data punerii în funcțiune'),
        },
        next: [agent('assets.recordFiscal', { assetId: asset.id })],
      });
    }
  }
  // Prior-year corrections not yet carried into the corrected year's tax.
  const postings = await profitPostings(tx, companyId);
  for (const [index, posting] of postings.entries()) {
    if (!isCorrection(posting.position) || posting.position.change === '0') continue;
    const year = posting.position.year;
    const carried = postings
      .slice(index + 1)
      .some(
        (later) =>
          isPosition(later.position) &&
          later.position.kind === 'rectification' &&
          later.position.year === year,
      );
    if (carried) continue;
    const inBooks = postings.some(
      (other) =>
        isPosition(other.position) &&
        other.position.kind === 'year' &&
        other.position.year === year,
    );
    const filingRequest = {
      kind: 'obligation.filed' as const,
      subject: { kind: 'obligation', id: `D101/${year}` },
      params: { kind: 'D101', period: String(year) },
    };
    // A year outside the books: its rectifying D101 is filed outside, which a person records.
    if (!inBooks && (await standing(tx, companyId, filingRequest)).answered) continue;
    const message = inBooks
      ? `Corecția din ${posting.date} schimbă rezultatul fiscal al anului ${year} cu ${posting.position.change} lei: rectificați impozitul anului și declarația 101.`
      : `Corecția din ${posting.date} schimbă rezultatul fiscal al anului ${year}, pe care registrele nu îl cuprind: declarația 101 rectificativă se depune în afara aplicației.`;
    const causes: WorkCause[] | undefined = inBooks
      ? undefined
      : [causeFromQuestion(filingRequest, message)];
    items.push({
      kind: 'profit.correction',
      subject: { kind: 'entry', id: posting.entryId },
      severity: 'warn',
      year,
      message,
      ...(causes ? { causes } : {}),
      details: { year, change: posting.position.change, inBooks },
      labels: {
        year: { label: 'An', type: 'period' },
        change: { label: 'Diferență', type: 'amount', currency: 'RON' },
        inBooks: textLabel('An în registre'),
      },
      next: inBooks
        ? [
            agent('tax.profit.propose', {
              period: String(year),
              rectification: true,
              date: posting.date,
            }),
          ]
        : [agent('questions.ask', filingRequest), human('questions.answer')],
    });
  }
  return items;
}
