import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  inArray,
  lte,
  notExists,
  sql,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import { parseCamt } from 'xfactura-core/bank/camt';
import { csvMappingSchema, parseBankCsv, type CsvMapping } from 'xfactura-core/bank/csv';
import { parseMt940 } from 'xfactura-core/bank/mt940';
import {
  canonicalBankAccount,
  checkedStatements,
  entrySourceId,
  statementFinancialHash,
  statementOf,
  statementsAdjoin,
  statementsOverlap,
  type BankStatementDocument,
  type CheckedStatement,
  type StatementRow,
  type StatementSpan,
} from 'xfactura-core/bank/statement-document';
import { verifyCitation, type CitationStatus } from 'xfactura-core/documents/checks';
import { citationSchema } from 'xfactura-core/documents/schemas';
import { requireCondition } from 'xfactura-core/errors';
import { canonical, hashOf } from 'xfactura-core/hash';
import { signedMoneySchema } from 'xfactura-core/values';
import { formatMoney, isSupportedCurrency, parseMoney } from 'xfactura-core/money';
import { monthEnd, type Month } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import {
  bankMappings,
  bankMovements,
  bankStatements,
  entries,
  evidence,
  fiscalYears,
  ledgerAccounts,
  lines,
  proposals,
  treasuryAccounts,
} from '../db/schema';
import type { ObjectStore } from '../adapters/object-store';
import type { Actor, Commands, Ids } from '../kernel/commands';
import { entryStands } from '../kernel/ledger';
import type { CloseCheck, Finding } from '../kernel/periods';
import { movementState } from '../kernel/work';
import type { Evidence } from './evidence';

const day = z.iso.date();
export const treasuryAccountInput = z
  .object({
    kind: z.enum(['bank', 'cash']),
    name: z.string().trim().min(2).max(200),
    iban: z.string().trim().min(15).max(34).optional(),
    currency: z
      .string()
      .refine((code): boolean => isSupportedCurrency(code), 'Moneda nu este acceptată.'),
    ledgerAccount: z.string().regex(/^5(12|31)\d(\.[A-Z0-9_-]{1,24})?$/),
    openedOn: day,
  })
  .strict()
  .refine((input) => (input.kind === 'bank') === Boolean(input.iban), {
    message: 'Un cont bancar are IBAN; casa nu are.',
    path: ['iban'],
  })
  // Lei are kept on 5121/5311 and foreign currency on 5124/5314 (OMFP 1802/2014 chart).
  .refine((input) => /^5(121|311)/.test(input.ledgerAccount) === (input.currency === 'RON'), {
    message: 'Contul contabil nu corespunde monedei.',
    path: ['ledgerAccount'],
  });
export const bankImportInput = z
  .object({ evidenceId: z.uuid(), financialYearId: z.uuid() })
  .strict();
/** A balance stated on a statement, with where it was read: a line of the file's text layer
 * (`evidence.read`), of this file or of another one (`evidenceId`). */
const citedBalance = z
  .object({
    amount: signedMoneySchema,
    citation: citationSchema.extend({ evidenceId: z.uuid().optional() }).strict(),
  })
  .strict();
export const csvImportInput = z
  .object({
    evidenceId: z.uuid(),
    /** The bank account (`treasury.accounts`) the export is of. */
    accountId: z.uuid(),
    /** How the file reads; without it, the mapping the account's last CSV import used. */
    mapping: csvMappingSchema.optional(),
    /** The opening and closing balances, each cited, when the mapping takes them as given. */
    balances: z.object({ opening: citedBalance, closing: citedBalance }).strict().optional(),
    /** The days the statement covers, when they reach past its first and last movements. */
    period: z.object({ from: day, to: day }).strict().optional(),
  })
  .strict();
export const transcribedInput = z
  .object({
    evidenceId: z.uuid(),
    accountId: z.uuid(),
    statement: z
      .object({
        /** The statement's own number, when it has one. */
        number: z.string().trim().min(1).max(100).optional(),
        /** The days it covers: the opening balance is at the start of `from`. */
        from: day,
        to: day,
        opening: citedBalance.extend({ citation: citationSchema }),
        closing: citedBalance.extend({ citation: citationSchema }),
        entries: z
          .array(
            z
              .object({
                date: day,
                valueDate: day.optional(),
                /** Signed: money in positive, money out negative. */
                amount: signedMoneySchema,
                description: z.string().max(8000).default(''),
                /** The bank's own reference of the movement, when the statement shows one. */
                reference: z.string().trim().min(1).max(500).optional(),
                counterparty: z.string().trim().min(1).max(500).optional(),
                iban: z.string().trim().min(5).max(42).optional(),
                /** The line that shows the movement's amount. */
                citation: citationSchema,
              })
              .strict(),
          )
          .max(2000),
      })
      .strict(),
  })
  .strict();
export const movementStates = ['unexplained', 'proposed', 'approved', 'settled'] as const;
export const movementQuery = z
  .object({
    treasuryAccountId: z.uuid().optional(),
    from: day.optional(),
    to: day.optional(),
    unsettled: z.boolean().default(false),
    /** Only movements in this state: `unexplained` (no open or posted proposal), `proposed`,
     * `approved` (its open proposal's latest version is approved) or `settled` (posted). */
    state: z.enum(movementStates).optional(),
  })
  .strict();

function parseStatements(
  bytes: Uint8Array,
  year: { from: string; to: string },
): BankStatementDocument[] {
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).replace(/^﻿/, '').trimStart();
  if (head.startsWith('<')) return parseCamt(bytes);
  requireCondition(/:20:/.test(head), 'BANK_FORMAT', 'Folosiți un extras MT940 sau camt.053.');
  return parseMt940(new TextDecoder('utf-8', { fatal: true }).decode(bytes), year);
}

/** Whether a movement has a posted explanation that stands (not reversed since). */
const settled = (tx: Transaction, companyId: string) =>
  tx
    .select({ id: entries.id })
    .from(entries)
    .innerJoin(
      proposals,
      and(eq(proposals.companyId, entries.companyId), eq(proposals.id, entries.proposalId)),
    )
    .where(
      and(
        eq(entries.companyId, companyId),
        eq(proposals.subjectKey, sql`'movement:' || ${bankMovements.id}`),
        entryStands('"acc_entries"'),
      ),
    );

/** The ledger balance of an account at the end of a date, in the account's own currency. */
async function ledgerBalance(tx: Transaction, companyId: string, account: string, at: string) {
  const [row] = await tx
    .select({
      minor:
        sql<bigint>`coalesce(sum(case ${lines.side} when 'D' then 1 else -1 end * coalesce(${lines.currencyMinor}, ${lines.bani})), 0)`.mapWith(
          BigInt,
        ),
    })
    .from(lines)
    .innerJoin(entries, and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId)))
    .where(and(eq(lines.companyId, companyId), eq(lines.account, account), lte(entries.date, at)));
  return row?.minor ?? 0n;
}

type RecordedStatement = typeof bankStatements.$inferSelect;
type TreasuryAccount = typeof treasuryAccounts.$inferSelect;
type Warning = { code: string; message: string };

/** A recorded statement's days, and whether it reports a movement on the first. */
async function recordedSpan(tx: Transaction, row: RecordedStatement): Promise<StatementSpan> {
  const [moved] = await tx
    .select({ id: bankMovements.id })
    .from(bankMovements)
    .where(
      and(
        eq(bankMovements.companyId, row.companyId),
        eq(bankMovements.treasuryAccountId, row.treasuryAccountId),
        eq(bankMovements.bookingDate, row.from),
        eq(bankMovements.statementId, row.id),
      ),
    )
    .limit(1);
  return { from: row.from, to: row.to, movesOnFrom: Boolean(moved) };
}

/**
 * Where a new statement falls among its account's recorded ones; returns the import's warnings.
 *
 * - It reports no day another statement reports (in the database, `statement_overlap`). Without
 *   the bank's reference a movement is known by the statement reporting it, so the same days from
 *   a second statement (camt.053 and MT940, a monthly and its dailies) would count the bank twice.
 * - Next to a recorded statement, with no day between them, the balances must chain. One of the
 *   two documents is then wrong, and recorded statements never change: it is refused while it can
 *   still be corrected.
 * - With days between them, a difference may be the missing statements' movements, and older or
 *   missing statements arrive in any order: a warning. The month close still blocks a statement
 *   that does not continue the previous one.
 */
async function placeStatement(
  tx: Transaction,
  account: TreasuryAccount,
  statement: CheckedStatement,
): Promise<Warning[]> {
  const recorded = (...conditions: SQL[]) =>
    tx
      .select({ row: bankStatements, filename: evidence.filename })
      .from(bankStatements)
      .innerJoin(
        evidence,
        and(
          eq(evidence.companyId, bankStatements.companyId),
          eq(evidence.id, bankStatements.evidenceId),
        ),
      )
      .where(
        and(
          eq(bankStatements.companyId, account.companyId),
          eq(bankStatements.treasuryAccountId, account.id),
          ...conditions,
        ),
      );
  const named = ({ row, filename }: { row: RecordedStatement; filename: string }) =>
    `${row.sourceId} (${row.format}, ${row.from} – ${row.to}, fișierul ${filename})`;
  const details = ({ row }: { row: RecordedStatement }) => ({
    statementId: row.id,
    sourceId: row.sourceId,
    format: row.format,
    from: row.from,
    to: row.to,
    evidenceId: row.evidenceId,
  });
  const money = (minor: bigint) => `${formatMoney(minor, account.currency)} ${account.currency}`;
  const own: StatementSpan = {
    from: statement.from,
    to: statement.to,
    movesOnFrom: statement.entries.some((entry) => entry.date === statement.from),
  };
  const sharing = await recorded(
    lte(bankStatements.from, statement.to),
    gte(bankStatements.to, statement.from),
  ).orderBy(asc(bankStatements.from));
  for (const other of sharing) {
    if (!statementsOverlap(own, await recordedSpan(tx, other.row))) continue;
    const first = other.row.from > statement.from ? other.row.from : statement.from;
    const last = other.row.to < statement.to ? other.row.to : statement.to;
    const days =
      first === last
        ? `ziua ${first}, deja acoperită`
        : `zilele ${first} – ${last}, deja acoperite`;
    requireCondition(
      false,
      'BANK_STATEMENT_OVERLAP',
      `Extrasul ${statement.sourceId} (${statement.format}, ${statement.from} – ${statement.to}) cuprinde ${days} de extrasul ${named(other)} al contului ${account.name}. Aceleași zile nu se importă din două extrase (de exemplu, MT940 zilnic și camt.053 lunar): mișcările lor ar fi numărate de două ori.`,
      409,
      details(other),
    );
  }
  const warnings: Warning[] = [];
  const opening = parseMoney(statement.opening, statement.currency);
  const closing = parseMoney(statement.closing, statement.currency);
  const [previous] = await recorded(lte(bankStatements.to, statement.from))
    .orderBy(desc(bankStatements.to), desc(bankStatements.from))
    .limit(1);
  if (previous && previous.row.closingMinor !== opening) {
    requireCondition(
      !statementsAdjoin(await recordedSpan(tx, previous.row), own),
      'BANK_STATEMENT_CHAIN',
      `Soldul inițial al extrasului ${statement.sourceId} (${money(opening)} la ${statement.from}) nu continuă soldul final al extrasului ${named(previous)}, de ${money(previous.row.closingMinor)}, care îl precede direct în contul ${account.name}. Verificați extrasele; dacă între ele lipsește un extras, importați-l mai întâi.`,
      409,
      details(previous),
    );
    warnings.push({
      code: 'STATEMENT_GAP',
      message: `Între extrasul ${named(previous)} și extrasul ${statement.sourceId} (${statement.from} – ${statement.to}) lipsesc extrase: soldul inițial ${money(opening)} nu continuă soldul final ${money(previous.row.closingMinor)}. Importați extrasele lipsă.`,
    });
  }
  const [next] = await recorded(gte(bankStatements.from, statement.to))
    .orderBy(asc(bankStatements.from), asc(bankStatements.to))
    .limit(1);
  if (next && next.row.openingMinor !== closing) {
    requireCondition(
      !statementsAdjoin(own, await recordedSpan(tx, next.row)),
      'BANK_STATEMENT_CHAIN',
      `Soldul final al extrasului ${statement.sourceId} (${money(closing)} la ${statement.to}) nu este soldul inițial al extrasului ${named(next)}, de ${money(next.row.openingMinor)}, care îl urmează direct în contul ${account.name}. Verificați extrasele; dacă între ele lipsește un extras, importați-l mai întâi.`,
      409,
      details(next),
    );
    warnings.push({
      code: 'STATEMENT_GAP',
      message: `Între extrasul ${statement.sourceId} (${statement.from} – ${statement.to}) și extrasul ${named(next)} lipsesc extrase: soldul final ${money(closing)} nu este soldul inițial ${money(next.row.openingMinor)}. Importați extrasele lipsă.`,
    });
  }
  return warnings;
}

/**
 * Records checked bank statements from one document. Every way a statement comes in goes through
 * here: MT940 and camt.053 files today, CSV exports and transcribed PDFs later.
 *
 * - Each statement is for a configured account in its currency.
 * - A statement already recorded with the same content (its financial hash) is the same statement:
 *   recording it again adds nothing.
 * - A new statement covers no day another covers, and chains with its neighbours
 *   (`placeStatement`).
 * - Each reported movement is kept once per account, however many files repeat it, and a repeated
 *   movement must match.
 */
export async function recordStatements(
  tx: Transaction,
  actor: Actor,
  source: { id: string },
  statements: CheckedStatement[],
  ids: Ids,
  /** A transcription's citations with their outcomes, kept with the statement. */
  options: { citations?: string } = {},
) {
  const results = [];
  for (const statement of statements) {
    const [account] = await tx
      .select()
      .from(treasuryAccounts)
      .where(
        and(
          eq(treasuryAccounts.companyId, actor.companyId),
          eq(treasuryAccounts.iban, canonicalBankAccount(statement.bankAccount)),
        ),
      );
    requireCondition(
      account,
      'BANK_ACCOUNT',
      `Contul ${statement.bankAccount} nu este configurat.`,
      422,
      {
        iban: statement.bankAccount,
      },
    );
    requireCondition(
      account.currency === statement.currency,
      'BANK_CURRENCY',
      `Extrasul este în ${statement.currency}, contul ${account.name} în ${account.currency}.`,
    );
    const financialHash = statementFinancialHash(statement);
    const [existing] = await tx
      .select({ id: bankStatements.id })
      .from(bankStatements)
      .where(
        and(
          eq(bankStatements.companyId, actor.companyId),
          eq(bankStatements.treasuryAccountId, account.id),
          eq(bankStatements.financialHash, financialHash),
        ),
      );
    const warnings = existing ? [] : await placeStatement(tx, account, statement);
    const statementId = existing?.id ?? ids();
    if (!existing)
      await tx.insert(bankStatements).values({
        id: statementId,
        companyId: actor.companyId,
        treasuryAccountId: account.id,
        evidenceId: source.id,
        format: statement.format,
        sourceId: statement.sourceId,
        from: statement.from,
        to: statement.to,
        openingMinor: parseMoney(statement.opening, statement.currency),
        closingMinor: parseMoney(statement.closing, statement.currency),
        financialHash,
        citations: options.citations ?? null,
        createdBy: actor.actorId,
      });
    let added = 0;
    for (const entry of statement.entries) {
      const sourceId = entrySourceId(statement, entry);
      const amountMinor = parseMoney(entry.amount, statement.currency);
      const [known] = await tx
        .select()
        .from(bankMovements)
        .where(
          and(
            eq(bankMovements.companyId, actor.companyId),
            eq(bankMovements.treasuryAccountId, account.id),
            eq(bankMovements.sourceId, sourceId),
          ),
        );
      if (known) {
        requireCondition(
          known.amountMinor === amountMinor && known.bookingDate === entry.date,
          'MOVEMENT_CONFLICT',
          'Aceeași mișcare bancară apare cu altă sumă sau dată.',
          409,
          { movementId: known.id },
        );
        continue;
      }
      const detail = entry.details[0];
      await tx.insert(bankMovements).values({
        id: ids(),
        companyId: actor.companyId,
        treasuryAccountId: account.id,
        statementId,
        sourceId,
        bookingDate: entry.date,
        valueDate: entry.valueDate,
        amountMinor,
        currency: statement.currency,
        reference: entry.reference.slice(0, 1000),
        counterparty: (amountMinor > 0n ? detail?.debtor : detail?.creditor) ?? null,
        counterpartyAccount:
          (amountMinor > 0n ? detail?.debtorAccount : detail?.creditorAccount) ?? null,
        details: canonical({
          transactionCode: entry.transactionCode,
          bankReference: entry.bankReference,
          remittance: entry.details.flatMap((item) => item.remittance),
        }),
      });
      added++;
    }
    results.push({
      statementId,
      treasuryAccountId: account.id,
      from: statement.from,
      to: statement.to,
      opening: statement.opening,
      closing: statement.closing,
      movements: statement.entries.length,
      added,
      warnings,
    });
  }
  return results;
}

type Cited = { what: string; status: CitationStatus; reason: string | null };

/** The citation outcomes of a statement's balances and rows; refused when one does not hold on a
 * file that has a text layer. Without one (a scan, a photo), they stay unverified. */
function requireCitations(results: Cited[]) {
  const failed = results.filter((result) => result.status === 'failed');
  requireCondition(
    !failed.length,
    'BANK_CITATION',
    `Citările nu corespund fișierului: ${failed.map((result) => `${result.what} (${result.reason})`).join(', ')}. Recitiți liniile cu evidence.read.`,
    422,
    { failed },
  );
  return {
    verified: results.filter((result) => result.status === 'verified').length,
    unverified: results
      .filter((result) => result.status === 'unverified')
      .map((result) => result.what),
  };
}

export class Treasury {
  constructor(
    private readonly commands: Commands,
    private readonly objects: ObjectStore,
    /** Text layers, against which statements' citations are checked. */
    private readonly evidence: Evidence,
  ) {}

  /** A file's citable lines; null without a text layer. */
  private async pages(companyId: string, record: typeof evidence.$inferSelect) {
    const layer = await this.evidence.textLayer(companyId, record);
    return { pages: layer.pages.length ? layer.pages : null, extractor: layer.extractor };
  }

  /** The evidence rows and the bank account a file import reads, before its transaction. */
  private prepare(actor: Actor, operation: string, evidenceIds: string[], accountId: string) {
    return this.commands.read(actor, operation, async (tx) => {
      const rows = await tx
        .select()
        .from(evidence)
        .where(and(eq(evidence.companyId, actor.companyId), inArray(evidence.id, evidenceIds)));
      for (const id of evidenceIds)
        requireCondition(
          rows.some((row) => row.id === id),
          'EVIDENCE',
          'Documentul justificativ nu este disponibil.',
          404,
          { evidenceId: id },
        );
      const [account] = await tx
        .select()
        .from(treasuryAccounts)
        .where(
          and(eq(treasuryAccounts.companyId, actor.companyId), eq(treasuryAccounts.id, accountId)),
        );
      requireCondition(account, 'NOT_FOUND', 'Contul bancar nu este disponibil.', 404);
      requireCondition(
        account.kind === 'bank' && account.iban,
        'BANK_ACCOUNT',
        'Extrasele se înregistrează pe un cont bancar cu IBAN.',
      );
      return { rows, account: { ...account, iban: account.iban } };
    });
  }

  /** The financial year a statement ending on `to` belongs to. */
  private async yearOf(tx: Transaction, companyId: string, to: string) {
    const [year] = await tx
      .select()
      .from(fiscalYears)
      .where(
        and(
          eq(fiscalYears.companyId, companyId),
          eq(fiscalYears.kind, 'financial'),
          lte(fiscalYears.from, to),
          gte(fiscalYears.to, to),
        ),
      );
    requireCondition(
      year,
      'FINANCIAL_YEAR',
      `Data ${to} nu aparține unui exercițiu financiar configurat.`,
    );
    return { from: year.from, to: year.to };
  }

  /**
   * `bank.importCsv`: a bank's CSV export, parsed with a column mapping, the account's last one
   * unless the call gives another. The statement covers its movements' days (or `period`), with
   * the balances the mapping reads (a running balance column, two cells) or the call gives, each
   * cited. It is then checked and recorded like any statement (`recordStatements`), and a new
   * mapping is kept for the account's next export.
   */
  async importCsv(actor: Actor, key: string, input: z.infer<typeof csvImportInput>) {
    const cited = input.balances
      ? [input.balances.opening.citation.evidenceId, input.balances.closing.citation.evidenceId]
      : [];
    const ids = [...new Set([input.evidenceId, ...cited.filter((id) => id !== undefined)])];
    const { rows, account } = await this.prepare(actor, 'bank.importCsv', ids, input.accountId);
    const source = rows.find((row) => row.id === input.evidenceId)!;
    let balanceCitations: Cited[] = [];
    if (input.balances) {
      const layers = new Map(
        await Promise.all(
          rows.map(async (row) => [row.id, await this.pages(actor.companyId, row)] as const),
        ),
      );
      balanceCitations = (['opening', 'closing'] as const).map((what) => {
        const { amount, citation } = input.balances![what];
        const { evidenceId, ...line } = citation;
        return {
          what,
          ...verifyCitation(layers.get(evidenceId ?? input.evidenceId)!.pages, line, {
            kind: 'money',
            value: amount,
          }),
        };
      });
    }
    const outcome = requireCitations(balanceCitations);
    return this.commands.run(actor, key, 'bank.importCsv', input, 'write', async (tx) => {
      const [latest] = await tx
        .select()
        .from(bankMappings)
        .where(
          and(
            eq(bankMappings.companyId, actor.companyId),
            eq(bankMappings.treasuryAccountId, account.id),
          ),
        )
        .orderBy(desc(bankMappings.version))
        .limit(1);
      requireCondition(
        input.mapping || latest,
        'BANK_MAPPING_MISSING',
        'Contul nu are încă o corespondență a coloanelor CSV: indicați-o (mapping) la primul import.',
      );
      const mapping: CsvMapping =
        input.mapping ?? csvMappingSchema.parse(JSON.parse(latest!.mapping));
      const parsed = parseBankCsv(await this.objects.get(actor.companyId, source.hash), mapping);
      const given = mapping.balances.from === 'given';
      requireCondition(
        given === Boolean(input.balances),
        'BANK_BALANCES',
        given
          ? 'Corespondența ia soldurile ca date: indicați soldul inițial și final, fiecare cu citarea lui.'
          : 'Corespondența citește soldurile din fișier: nu le indicați separat.',
      );
      const dates = parsed.rows.map((row) => row.date).sort();
      const from = input.period?.from ?? dates[0];
      const to = input.period?.to ?? dates.at(-1);
      requireCondition(
        from && to,
        'BANK_CSV_EMPTY',
        'Fișierul nu are mișcări: indicați perioada (period) și soldurile.',
      );
      const statement = statementOf({
        format: 'csv',
        sourceId: `csv:${from}:${to}`,
        bankAccount: account.iban,
        currency: account.currency,
        from,
        to,
        opening: given ? input.balances!.opening.amount : parsed.opening!,
        closing: given ? input.balances!.closing.amount : parsed.closing!,
        rows: parsed.rows.map(({ row: _row, ...rest }): StatementRow => rest),
      });
      const checked = checkedStatements([statement], await this.yearOf(tx, actor.companyId, to));
      const statements = await recordStatements(tx, actor, source, checked, this.commands.ids, {
        ...(given ? { citations: canonical({ balances: balanceCitations }) } : {}),
      });
      const mappingHash = hashOf(mapping);
      const saved = latest?.mappingHash !== mappingHash;
      const version = saved ? (latest?.version ?? 0) + 1 : latest!.version;
      if (saved)
        await tx.insert(bankMappings).values({
          companyId: actor.companyId,
          treasuryAccountId: account.id,
          version,
          format: 'csv',
          mapping: canonical(mapping),
          mappingHash,
          evidenceId: source.id,
          createdBy: actor.actorId,
        });
      return {
        statements,
        mapping: { version, saved, mapping },
        citations: outcome,
      };
    });
  }

  /**
   * `bank.recordStatement`: a statement an agent transcribed from a PDF or a photo, every row and
   * both balances citing the line that shows their amount. Citations are checked against the
   * file's text layer (refused when one does not hold; unverified without a text layer), then the
   * statement is checked and recorded like any other (`recordStatements`).
   */
  async recordStatement(actor: Actor, key: string, input: z.infer<typeof transcribedInput>) {
    const { rows, account } = await this.prepare(
      actor,
      'bank.recordStatement',
      [input.evidenceId],
      input.accountId,
    );
    const source = rows[0]!;
    const { pages, extractor } = await this.pages(actor.companyId, source);
    const transcribed = input.statement;
    const check = (what: string, amount: string, citation: z.infer<typeof citationSchema>) => ({
      what,
      ...citation,
      ...verifyCitation(pages, citation, { kind: 'money', value: amount }),
    });
    const results = [
      check('opening', transcribed.opening.amount, transcribed.opening.citation),
      check('closing', transcribed.closing.amount, transcribed.closing.citation),
      ...transcribed.entries.map((entry, index) =>
        check(`entries.${index}`, entry.amount, entry.citation),
      ),
    ];
    const outcome = requireCitations(results);
    return this.commands.run(actor, key, 'bank.recordStatement', input, 'write', async (tx) => {
      const statement = statementOf({
        format: 'transcribed',
        sourceId: transcribed.number ?? `transcribed:${transcribed.from}:${transcribed.to}`,
        bankAccount: account.iban,
        currency: account.currency,
        from: transcribed.from,
        to: transcribed.to,
        opening: transcribed.opening.amount,
        closing: transcribed.closing.amount,
        rows: transcribed.entries.map((entry) => ({
          date: entry.date,
          valueDate: entry.valueDate ?? null,
          amount: entry.amount,
          description: entry.description,
          reference: entry.reference ?? null,
          counterparty: entry.counterparty ?? null,
          counterpartyAccount: entry.iban?.replace(/\s+/g, '') ?? null,
        })),
      });
      const checked = checkedStatements(
        [statement],
        await this.yearOf(tx, actor.companyId, transcribed.to),
      );
      const statements = await recordStatements(tx, actor, source, checked, this.commands.ids, {
        citations: canonical({ extractor, items: results }),
      });
      return { statements, citations: outcome };
    });
  }

  createAccount(actor: Actor, key: string, input: z.infer<typeof treasuryAccountInput>) {
    return this.commands.run(actor, key, 'treasury.createAccount', input, 'manage', async (tx) => {
      const [account] = await tx
        .select()
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.companyId, actor.companyId),
            eq(ledgerAccounts.code, input.ledgerAccount),
          ),
        );
      requireCondition(
        account?.postable && !account.controlKind,
        'LEDGER_ACCOUNT',
        'Contul contabil nu este disponibil pentru trezorerie.',
      );
      const id = this.commands.ids();
      const iban = input.iban ? canonicalBankAccount(input.iban) : null;
      await tx
        .insert(treasuryAccounts)
        .values({ id, companyId: actor.companyId, ...input, iban, createdBy: actor.actorId });
      return { id, ...input, iban };
    });
  }

  accounts(actor: Actor) {
    return this.commands.read(actor, 'treasury.accounts', (tx) =>
      tx
        .select({
          id: treasuryAccounts.id,
          kind: treasuryAccounts.kind,
          name: treasuryAccounts.name,
          iban: treasuryAccounts.iban,
          currency: treasuryAccounts.currency,
          ledgerAccount: treasuryAccounts.ledgerAccount,
          openedOn: treasuryAccounts.openedOn,
        })
        .from(treasuryAccounts)
        .where(eq(treasuryAccounts.companyId, actor.companyId))
        .orderBy(asc(treasuryAccounts.ledgerAccount)),
    );
  }

  /** Imports MT940 or camt.053 statements from a recorded file (see `recordStatements`). */
  import(actor: Actor, key: string, input: z.infer<typeof bankImportInput>) {
    return this.commands.run(actor, key, 'bank.import', input, 'write', async (tx) => {
      const [source] = await tx
        .select()
        .from(evidence)
        .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, input.evidenceId)));
      requireCondition(source, 'EVIDENCE', 'Documentul justificativ nu este disponibil.', 404);
      const [year] = await tx
        .select()
        .from(fiscalYears)
        .where(
          and(
            eq(fiscalYears.companyId, actor.companyId),
            eq(fiscalYears.id, input.financialYearId),
            eq(fiscalYears.kind, 'financial'),
          ),
        );
      requireCondition(year, 'NOT_FOUND', 'Exercițiul financiar nu este disponibil.', 404);
      const range = { from: year.from, to: year.to };
      const statements = checkedStatements(
        parseStatements(await this.objects.get(actor.companyId, source.hash), range),
        range,
      );
      return {
        statements: await recordStatements(tx, actor, source, statements, this.commands.ids),
      };
    });
  }

  movements(actor: Actor, input: z.infer<typeof movementQuery>) {
    return this.commands.read(actor, 'bank.movements', async (tx) => {
      const rows = await tx
        .select({
          movement: bankMovements,
          settled:
            sql<number>`case when ${exists(settled(tx, actor.companyId))} then 1 else 0 end`.mapWith(
              Number,
            ),
          state: movementState,
        })
        .from(bankMovements)
        .where(
          and(
            eq(bankMovements.companyId, actor.companyId),
            input.treasuryAccountId
              ? eq(bankMovements.treasuryAccountId, input.treasuryAccountId)
              : undefined,
            input.from ? gte(bankMovements.bookingDate, input.from) : undefined,
            input.to ? lte(bankMovements.bookingDate, input.to) : undefined,
            input.unsettled ? notExists(settled(tx, actor.companyId)) : undefined,
            input.state ? sql`${movementState} = ${input.state}` : undefined,
          ),
        )
        .orderBy(asc(bankMovements.bookingDate), asc(bankMovements.id));
      return rows.map(({ movement, settled: isSettled, state }) => ({
        id: movement.id,
        treasuryAccountId: movement.treasuryAccountId,
        bookingDate: movement.bookingDate,
        valueDate: movement.valueDate,
        amount: formatMoney(movement.amountMinor, movement.currency),
        currency: movement.currency,
        reference: movement.reference,
        counterparty: movement.counterparty,
        counterpartyAccount: movement.counterpartyAccount,
        settled: Boolean(isSettled),
        state: state as (typeof movementStates)[number],
      }));
    });
  }
}

/** Month-close checks for bank and cash. */
export const treasuryChecks: CloseCheck[] = [
  {
    id: 'bank.explained',
    async run(tx, companyId, month) {
      const end = monthEnd(month as Month);
      const rows = await tx
        .select({ id: bankMovements.id })
        .from(bankMovements)
        .where(
          and(
            eq(bankMovements.companyId, companyId),
            gte(bankMovements.bookingDate, `${month}-01`),
            lte(bankMovements.bookingDate, end),
            notExists(settled(tx, companyId)),
          ),
        )
        .orderBy(asc(bankMovements.id));
      return rows.length
        ? [
            {
              code: 'UNEXPLAINED_MOVEMENTS',
              severity: 'block' as const,
              message: 'Există mișcări bancare din această lună neexplicate.',
              count: rows.length,
              items: rows.slice(0, 20).map((row) => row.id),
            },
          ]
        : [];
    },
  },
  {
    id: 'bank.statements',
    async run(tx, companyId, month) {
      const findings: Finding[] = [];
      const accounts = await tx
        .select()
        .from(treasuryAccounts)
        .where(eq(treasuryAccounts.companyId, companyId));
      for (const account of accounts) {
        const statements = await tx
          .select()
          .from(bankStatements)
          .where(
            and(
              eq(bankStatements.companyId, companyId),
              eq(bankStatements.treasuryAccountId, account.id),
              lte(bankStatements.to, monthEnd(month as Month)),
            ),
          )
          .orderBy(desc(bankStatements.to), desc(bankStatements.from))
          .limit(2);
        const [latest, previous] = statements;
        if (!latest || latest.to < `${month}-01`) continue;
        if (previous && previous.closingMinor !== latest.openingMinor)
          findings.push({
            code: 'STATEMENT_CHAIN',
            severity: 'block',
            message: `Soldul inițial al extrasului ${latest.sourceId} nu continuă extrasul anterior (${account.name}).`,
            items: [latest.id],
          });
        const balance = await ledgerBalance(tx, companyId, account.ledgerAccount, latest.to);
        if (balance !== latest.closingMinor)
          findings.push({
            code: 'BANK_BALANCE',
            severity: 'block',
            message: `Soldul contabil ${formatMoney(balance, account.currency)} al contului ${account.ledgerAccount} diferă de extras (${formatMoney(latest.closingMinor, account.currency)} ${account.currency}) la ${latest.to}.`,
            items: [latest.id],
          });
      }
      return findings;
    },
  },
];
