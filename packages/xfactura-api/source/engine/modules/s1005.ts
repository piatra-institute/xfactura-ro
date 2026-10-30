import { and, asc, eq, gte, lte, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Party } from 'xfactura-core/einvoice';
import { DomainError } from 'xfactura-core/errors';
import type { ReadSetEntry } from 'xfactura-core/kernel';
import {
  checkS1005,
  completeS1005,
  s1005Counties,
  s1005Format,
  writeS1005,
  type S1005,
  type S1005Address,
  type S1005Cells,
  type S1005F10Row,
  type S1005F20Row,
  type S1005F30Row,
  type S1005F40Row,
  type S1005PreparerQuality,
} from 'xfactura-core/ro/annual/s1005';
import { s1005F40FromLedger } from 'xfactura-core/ro/annual/s1005-assets';
import {
  s1005Columns,
  s1005Formulas,
  s1005FromLedger,
  type S1005LedgerEntry,
  type S1005LedgerRows,
} from 'xfactura-core/ro/annual/s1005-accounts';
import { booksSystemOf } from 'xfactura-core/ro/entity';
import { counties } from 'xfactura-core/ro/geo';
import type { LocalDate } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import { companies, entries, fiscalYears, lines } from '../db/schema';
import { loadState } from '../kernel/state';
import { sellerDetails } from './d300';
import type { DeclarationKind, DeclarationProblem } from './declarations';

const text = (max: number) => z.string().trim().min(1).max(max);
const account = z.string().regex(/^[1-9]\d{2}[0-9.]*$/);
/** A row's cells by column, whole lei; null leaves a cell empty. */
const cells = z.array(z.number().int().safe().nullable()).min(1).max(6);
const rows = z.record(z.string().regex(/^\d{1,3}[a-z]?$/), cells);

export const s1005Options = z
  .object({
    entity: z
      .object({
        tradeRegister: text(18),
        /** codPP: the form of ownership (s1005Ownerships). */
        ownership: z.number().int(),
        caen: z.string().regex(/^\d{4}$/),
        caenActual: z.string().regex(/^\d{4}$/),
        caenVersion: z.union([z.literal(2024), z.literal(2025)]),
        lei: z
          .string()
          .regex(/^[A-Z0-9]{20}$/)
          .optional(),
        largeTaxpayer: z.boolean(),
        branch: z.boolean(),
        economicInterestGroup: z.boolean(),
        netAssetsBelowHalfCapital: z.boolean(),
        phone: text(15).optional(),
        /** The registered office as the form writes it, when the company's address lines are
         * not to be written as the street. */
        address: z
          .object({
            sector: z.number().int().min(1).max(6).optional(),
            locality: text(100),
            street: text(150).optional(),
            number: text(20).optional(),
            block: text(20).optional(),
            staircase: text(20).optional(),
            apartment: text(20).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    administrator: text(75),
    preparer: z
      .object({
        name: text(75),
        quality: z.number().int(),
        membership: text(15).optional(),
        cif: z
          .string()
          .regex(/^\d{2,13}$/)
          .optional(),
      })
      .strict(),
    audit: z
      .object({
        kind: z.enum(['statutory', 'voluntary', 'censors']),
        auditor: z
          .object({
            name: text(200),
            registration: text(20).optional(),
            cif: z
              .string()
              .regex(/^\d{2,13}$/)
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    internalAudit: z.boolean().optional(),
    approved: z.boolean(),
    /** The row of an account the form spreads over several rows (liabilities due within a year,
     * rd. 13, or after it, rd. 16; "din ct." rows): the whole balance goes there. An account
     * whose balance belongs to several rows is kept on analytic accounts, one per row. */
    rows: z
      .record(
        account,
        z
          .object({ F10: text(4).optional(), F20: text(4).optional(), F30: text(4).optional() })
          .strict(),
      )
      .default({}),
    /** The rows the books do not hold yet: F20 rd. 01a and F30 outside chapter XIX (employees,
     * receivables and debts by kind, …). */
    informative: z.object({ F20: rows.optional(), F30: rows.optional() }).strict().default({}),
    /** F40 col. 4: the part of a row's reductions that is dismantling and scrapping, in lei,
     * for each row with reductions. */
    scrapped: z.record(z.string().regex(/^\d{2}$/), z.number().int().min(0).safe()).optional(),
    /** The previous year's F20 and F30 account rows as filed, when that year is not kept in the
     * engine (its balance sheet comes from the opening entries). */
    previous: z
      .object({
        F20: z.record(z.string(), z.number().int().safe()).default({}),
        F30: z.record(z.string(), z.number().int().safe()).default({}),
      })
      .strict()
      .optional(),
  })
  .strict();
type Options = z.infer<typeof s1005Options>;

const always = '1900-01-01';
const signed = (debit: bigint, credit: bigint): S1005LedgerEntry => {
  const balance = debit - credit;
  return {
    account: '',
    debit: balance > 0n ? balance : 0n,
    credit: balance < 0n ? -balance : 0n,
  };
};
const debitSum =
  sql<bigint>`sum(CASE WHEN ${lines.side} = 'D' THEN ${lines.bani} ELSE 0 END)`.mapWith(BigInt);
const creditSum =
  sql<bigint>`sum(CASE WHEN ${lines.side} = 'C' THEN ${lines.bani} ELSE 0 END)`.mapWith(BigInt);
const join = and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId));

/** The partner of a line kept on open items (customers, suppliers, advances, …). */
const partner = sql<
  string | null
>`CASE WHEN ${lines.openItemId} IS NOT NULL THEN ${lines.partyId} END`;

/**
 * Balances at a date, one entry per account and, on the accounts kept on open items, per
 * partner: the forms' "solduri debitoare" and "solduri creditoare" are the analytic balances, so a
 * customer's credit balance is not netted against the others' debit balances. `journal` keeps
 * only that journal's entries.
 */
async function balances(
  tx: Transaction,
  companyId: string,
  where: { from: string; to: string; journal?: string },
): Promise<S1005LedgerEntry[]> {
  const rows = await tx
    .select({ account: lines.account, partner, debit: debitSum, credit: creditSum })
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
    .groupBy(lines.account, partner)
    .orderBy(asc(lines.account), asc(partner));
  return rows
    .filter((row) => row.debit !== row.credit)
    .map((row) => ({ ...signed(row.debit, row.credit), account: row.account }));
}

/** The year's turnover of classes 6 and 7 without the closing into 121 (and its reversals). */
async function turnover(
  tx: Transaction,
  companyId: string,
  year: { from: string; to: string },
): Promise<S1005LedgerEntry[]> {
  const rows = await tx
    .select({ account: lines.account, debit: debitSum, credit: creditSum })
    .from(lines)
    .innerJoin(entries, join)
    .where(
      and(
        eq(lines.companyId, companyId),
        gte(entries.date, year.from),
        lte(entries.date, year.to),
        sql`substr(${lines.account}, 1, 1) IN ('6', '7')`,
        ne(entries.journalCode, 'INCHIDERE'),
      ),
    )
    .groupBy(lines.account)
    .orderBy(asc(lines.account));
  return rows.map((row) => ({ account: row.account, debit: row.debit, credit: row.credit }));
}

/** The year's debits and credits by account, without the opening entries: F40's increases and
 * reductions. */
async function movements(
  tx: Transaction,
  companyId: string,
  year: { from: string; to: string },
): Promise<S1005LedgerEntry[]> {
  const rows = await tx
    .select({ account: lines.account, debit: debitSum, credit: creditSum })
    .from(lines)
    .innerJoin(entries, join)
    .where(
      and(
        eq(lines.companyId, companyId),
        gte(entries.date, year.from),
        lte(entries.date, year.to),
        sql`(substr(${lines.account}, 1, 1) = '2' OR substr(${lines.account}, 1, 3) IN ('409', '490'))`,
        ne(entries.journalCode, 'DESCHIDERE'),
      ),
    )
    .groupBy(lines.account)
    .orderBy(asc(lines.account));
  return rows.map((row) => ({ account: row.account, debit: row.debit, credit: row.credit }));
}

async function financialYear(tx: Transaction, companyId: string, end: string) {
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

async function inputsOf(tx: Transaction, companyId: string, year: string) {
  // Every line up to the year's end: any posting, reversal or late entry makes it stale.
  const { readSet } = await loadState(tx, companyId, {
    turnover: [
      {
        prefixes: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
        from: always as LocalDate,
        to: `${year}-12-31` as LocalDate,
      },
    ],
  });
  const seller = await sellerDetails(tx, companyId);
  const inputs: ReadSetEntry[] = [
    ...readSet,
    ...(seller ? [{ kind: 'party' as const, id: seller.partyId, version: seller.hash }] : []),
  ];
  return { seller, inputs };
}

const plain = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** codTT of a Romanian county (ISO 3166-2:RO), by its name in the form's list. */
function countyCode(subdivision: string | undefined) {
  const name = subdivision ? counties[subdivision] : undefined;
  if (!name) return undefined;
  return s1005Counties.find(
    ([, county]) => plain(county) === plain(name) || plain(county).endsWith(` ${plain(name)}`),
  )?.[0];
}

/** The registered office from the company's address: its lines as the street, Bucharest's
 * sector when the address names one. */
function addressOf(details: Party): S1005Address {
  const { lines: street, city } = details.address;
  const sector = /\bsector(?:ul)?\s*([1-6])\b/i.exec([city, ...street].join(' '))?.[1];
  return {
    ...(sector ? { sector: Number(sector) } : {}),
    locality: city,
    street: street.join(', '),
  };
}

const accountRows = new Set(s1005Formulas.map((formula) => `${formula.form}.${formula.row}`));
const toCells = (values: (number | null)[]): S1005Cells =>
  values.map((value) => (value === null ? undefined : value));

/** The informative rows as cells, refusing the rows the books give. */
function informativeRows<Row extends string>(
  form: 'F20' | 'F30',
  given: Record<string, (number | null)[]> | undefined,
  problems: DeclarationProblem[],
) {
  const result: Partial<Record<Row, S1005Cells>> = {};
  for (const [row, values] of Object.entries(given ?? {})) {
    if (accountRows.has(`${form}.${row}`))
      problems.push({
        code: 'S1005_BOOKS_ROW',
        message: `${form} rd. ${row} se calculează din registre; nu se completează manual.`,
      });
    else result[row as Row] = toCells(values);
  }
  return result;
}

/** The account rows given for the previous year, refusing the others. */
function previousRows<Row extends string>(
  form: 'F20' | 'F30',
  given: Record<string, number>,
  problems: DeclarationProblem[],
) {
  const result: Partial<Record<Row, number>> = {};
  for (const [row, value] of Object.entries(given)) {
    if (!accountRows.has(`${form}.${row}`))
      problems.push({
        code: 'S1005_PREVIOUS',
        message: `${form} rd. ${row} nu este un rând din conturi; dați-l în informative.`,
      });
    else result[row as Row] = value;
  }
  return result;
}

function withRows(ledger: S1005LedgerEntry[], choices: Options['rows']): S1005LedgerEntry[] {
  return ledger.map((entry) => {
    const key = Object.keys(choices)
      .filter((code) => entry.account === code || entry.account.startsWith(`${code}.`))
      .sort((a, b) => b.length - a.length)[0];
    const choice = key ? choices[key]! : undefined;
    if (!choice) return entry;
    return {
      ...entry,
      rows: {
        ...(choice.F10 ? { F10: choice.F10 as S1005F10Row } : {}),
        ...(choice.F20 ? { F20: choice.F20 as S1005F20Row } : {}),
        ...(choice.F30 ? { F30: choice.F30 as S1005F30Row } : {}),
      },
    };
  });
}

/**
 * The annual financial statements of a microentity (S1005) from the books of a financial year
 * ending on 31 December: the balance sheet (F10) from the closing balances, the profit and loss
 * account (F20) and F30 chapter XIX from the year's turnover of classes 6 and 7 without the
 * closing into 121. The previous year's column is the engine's previous financial year when it
 * keeps one; otherwise its balance sheet is the year's opening entries and its profit and loss
 * account the rows filed for it. F40 comes from the same balances and the year's movements of the
 * fixed-asset accounts. The identification, the rows of accounts the form spreads over several
 * rows, the scrapped part of F40's reductions and the informative rows the books do not hold are
 * the preparer's.
 */
export function s1005Declaration(): DeclarationKind {
  return {
    kind: 'S1005',
    description: 'Situații financiare anuale ale microentităților (S1005)',
    tax: null,
    period: z.string().regex(/^\d{4}$/),
    format(year) {
      try {
        return `S1005 ${s1005Format(Number(year)).namespace}`;
      } catch {
        return null;
      }
    },
    options: s1005Options,
    inputs: async (tx, companyId, year) => (await inputsOf(tx, companyId, year)).inputs,
    async prepare(tx, companyId, year, raw) {
      const options = s1005Options.parse(raw);
      const problems: DeclarationProblem[] = [];
      const { seller, inputs } = await inputsOf(tx, companyId, year);
      const fail = () => ({ xml: '', inputs, problems, summary: null });
      // Single-entry books draw up no annual statements (OMFP nr. 170/2015 cap. II pct. 11).
      const { loaded } = await loadState(tx, companyId, { profile: true });
      if (booksSystemOf(loaded.profile, `${year}-12-31` as LocalDate) === 'single') {
        problems.push({
          code: 'SINGLE_ENTRY_EXCLUDED',
          message:
            'Persoanele care țin contabilitatea în partidă simplă nu întocmesc situații financiare anuale (OMFP nr. 170/2015 cap. II pct. 11).',
        });
        return fail();
      }
      if (!seller)
        problems.push({
          code: 'SELLER_DETAILS',
          message: 'Înregistrați datele de identificare ale companiei.',
        });
      const current = await financialYear(tx, companyId, `${year}-12-31`);
      if (!current)
        problems.push({
          code: 'YEAR_END',
          message: `Nu există un exercițiu financiar încheiat la 31.12.${year}.`,
        });
      if (problems.length) return fail();

      const ledgerProblems = (rows: S1005LedgerRows, prefix: string) =>
        rows.issues
          .filter((issue) => issue.severity === 'error')
          .map((issue) => ({ code: issue.code, message: `${prefix}${issue.message}` }));
      const books = s1005FromLedger({
        closing: withRows(
          await balances(tx, companyId, { from: always, to: current!.to }),
          options.rows,
        ),
        turnover: withRows(await turnover(tx, companyId, current!), options.rows),
      });
      problems.push(...ledgerProblems(books, ''));

      // The previous year's column.
      let previous: Pick<S1005LedgerRows, 'F10' | 'F20' | 'F30'> | undefined;
      // F10 col. 1 account by account, which F40's opening balances repeat.
      let openingLei: S1005LedgerRows['closing'] = [];
      const before = await financialYear(tx, companyId, `${Number(year) - 1}-12-31`);
      const opening = await balances(tx, companyId, {
        from: current!.from,
        to: current!.to,
        journal: 'DESCHIDERE',
      });
      if (before) {
        const rows = s1005FromLedger({
          closing: withRows(
            await balances(tx, companyId, { from: always, to: before.to }),
            options.rows,
          ),
          turnover: withRows(await turnover(tx, companyId, before), options.rows),
        });
        problems.push(...ledgerProblems(rows, `Exercițiul ${Number(year) - 1}: `));
        previous = rows;
        openingLei = rows.closing;
        if (options.previous)
          problems.push({
            code: 'S1005_PREVIOUS',
            message: `Exercițiul ${Number(year) - 1} este în registre; rândurile lui nu se dau manual.`,
          });
      } else if (opening.length) {
        const rows = s1005FromLedger({ closing: withRows(opening, options.rows), turnover: [] });
        problems.push(...ledgerProblems(rows, 'Soldurile de deschidere: '));
        openingLei = rows.closing;
        if (!options.previous)
          problems.push({
            code: 'S1005_PREVIOUS',
            message: `Exercițiul ${Number(year) - 1} nu este în registre: indicați rândurile F20 și F30 din conturi ale situațiilor financiare depuse pentru el (previous).`,
          });
        previous = {
          F10: rows.F10,
          F20: previousRows<S1005F20Row>('F20', options.previous?.F20 ?? {}, problems),
          F30: previousRows<S1005F30Row>('F30', options.previous?.F30 ?? {}, problems),
        };
      } else if (options.previous)
        problems.push({
          code: 'S1005_PREVIOUS',
          message: 'Registrele nu au solduri de deschidere: exercițiul este primul al companiei.',
        });

      const details = JSON.parse(seller!.details) as Party;
      const county = countyCode(details.address.subdivision);
      if (county === undefined)
        problems.push({
          code: 'S1005_COUNTY',
          message: 'Județul sediului social nu este în nomenclatorul formularului.',
        });
      const informative = {
        F20: informativeRows<S1005F20Row>('F20', options.informative.F20, problems),
        F30: informativeRows<S1005F30Row>('F30', options.informative.F30, problems),
      };
      const assets = s1005F40FromLedger({
        opening: openingLei,
        closing: books.closing,
        movements: await movements(tx, companyId, current!),
        ...(options.scrapped
          ? { scrapped: options.scrapped as Partial<Record<S1005F40Row, number>> }
          : {}),
      });
      problems.push(
        ...assets.issues
          .filter((issue) => issue.severity === 'error')
          .map((issue) => ({ code: issue.code, message: issue.message })),
      );
      if (problems.length) return fail();

      const [company] = await tx.select().from(companies).where(eq(companies.id, companyId));
      const columns = s1005Columns({ ...(previous ? { previous } : {}), current: books });
      const { phone, address, ...entity } = options.entity;
      const model: S1005 = {
        year: Number(year),
        entity: {
          ...entity,
          cui: company!.cui,
          name: details.name,
          address: address ?? addressOf(details),
          ...(phone ? { phone } : {}),
          county: county!,
        },
        administrator: options.administrator,
        preparer: {
          ...options.preparer,
          quality: options.preparer.quality as S1005PreparerQuality,
        },
        ...(options.audit ? { audit: options.audit } : {}),
        ...(options.internalAudit !== undefined ? { internalAudit: options.internalAudit } : {}),
        approved: options.approved,
        F10: columns.F10,
        F20: { ...columns.F20, ...informative.F20 },
        F30: { ...columns.F30, ...informative.F30 },
        F40: assets.F40,
      };
      let completed: S1005;
      try {
        completed = completeS1005(model);
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        problems.push({ code: error.code, message: error.message });
        return fail();
      }
      const checks = checkS1005(completed);
      problems.push(
        ...checks
          .filter((check) => check.severity === 'error')
          .map((check) => ({ code: check.code, message: `${check.path}: ${check.message}` })),
      );
      if (problems.length) return fail();
      return {
        xml: writeS1005(completed),
        inputs,
        problems,
        summary: {
          year: Number(year),
          previous: before ? 'books' : opening.length ? 'opening' : 'none',
          warnings: [
            ...books.issues.filter((issue) => issue.severity === 'warning'),
            ...checks.filter((check) => check.severity === 'warning'),
          ].map((issue) => `${issue.code}: ${issue.message}`),
        },
      };
    },
  };
}
