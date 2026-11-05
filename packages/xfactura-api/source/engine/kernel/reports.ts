import { and, asc, eq, gt, gte, inArray, like, lt, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { formatMoney } from 'xfactura-core/money';
import { booksSystemOf } from 'xfactura-core/ro/entity';
import {
  isTreasury,
  journalRows,
  monthlyTotals,
  natureOf,
  treasuryAccounts,
  type JournalRow,
  type LedgerEntry,
  type LedgerItem,
  type NatureCatalogue,
} from 'xfactura-core/ro/pit';
import { RuleGapError, type RuleContext } from 'xfactura-core/rules';
import type { LocalDate } from 'xfactura-core/time';
import { invoiceDocumentSchema } from 'xfactura-core/ubl/invoice-document';
import {
  assetEvents,
  assets,
  bankMovements,
  documents,
  entries,
  fiscalYears,
  incomeSources,
  ledgerAccounts,
  lines,
  openItems,
  parties,
  proposalVersions,
  proposals,
} from '../db/schema';
import type { Transaction } from '../db/database';
import type { Actor, Commands } from './commands';
import { payClasses, personnelAccount, withoutPersons } from './personal';
import { lineSpec, loadState } from './state';

const ron = (bani: bigint) => formatMoney(bani, 'RON');
const day = z.iso.date();
const pair = z.object({ debit: z.string(), credit: z.string() });

export const trialBalanceInput = z
  .object({ financialYearId: z.uuid(), from: day.optional(), to: day.optional() })
  .strict();
export const trialBalanceView = z.object({
  year: z.object({ id: z.string(), from: z.string(), to: z.string() }),
  from: z.string(),
  to: z.string(),
  rows: z.array(
    z.object({
      account: z.string(),
      name: z.string(),
      opening: pair,
      previous: pair,
      current: pair,
      total: pair,
      closing: pair,
    }),
  ),
  totals: z.object({ opening: pair, previous: pair, current: pair, total: pair, closing: pair }),
});

export const journalInput = z
  .object({
    from: day,
    to: day,
    after: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(500).default(100),
  })
  .strict();

export const generalLedgerInput = z
  .object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), account: z.string().optional() })
  .strict();
export const inventoryInput = z.object({ date: day }).strict();
export const cashJournalInput = z
  .object({
    year: z.number().int().min(2000).max(2100),
    /** Only this month's rows; numbering and balances stay the year's. */
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .optional(),
  })
  .strict()
  .refine((input) => !input.month || input.month.startsWith(String(input.year)), {
    message: 'Luna trebuie să fie în anul cerut.',
    path: ['month'],
  });
export const singleInventoryInput = z
  .object({
    /** At the start of activity, at a year's end, or at cessation (OMFP nr. 170/2015 cap. V). */
    occasion: z.enum(['start', 'year_end', 'cessation']),
    year: z.number().int().min(2000).max(2100).optional(),
  })
  .strict()
  .refine((input) => input.occasion !== 'year_end' || input.year !== undefined, {
    message: 'Indicați anul încheiat.',
    path: ['year'],
  });

/** The justifying document a register shows for an entry, by what the entry recognized. */
const documentTypes: Record<string, string> = {
  'invoice.issued': 'Factură emisă',
  'invoice.received': 'Factură primită',
  'creditNote.issued': 'Factură de stornare emisă',
  'creditNote.received': 'Factură de stornare primită',
  'ledger.general': 'Notă contabilă',
  'ledger.reverse': 'Notă contabilă de stornare',
  'bank.settle': 'Extras de cont',
  'payroll.recognize': 'Stat de plată',
  'vat.settle': 'Decont de TVA',
  'tax.micro': 'Notă de calcul impozit',
  'dividends.distribute': 'Hotărârea asociaților',
  'dividends.withhold': 'Dispoziție de plată dividende',
  'assets.depreciate': 'Notă de calcul amortizare',
  'assets.derecognize': 'Proces-verbal de scoatere din funcțiune',
  'year.closeResult': 'Notă contabilă de închidere',
  'year.legalReserve': 'Notă contabilă de închidere',
  'year.transferResult': 'Hotărârea asociaților',
  'fx.revalue': 'Notă de calcul reevaluare',
  'tax.pay': 'Extras de cont',
  'tax.distribute': 'Fișa pe plătitor / notă de distribuire',
  'tax.decision': 'Decizie ANAF',
  'tax.statement': 'Fișa pe plătitor',
};

/** The synthetic account of an analytical one (4111.01 is kept on 4111). */
const synthetic = (account: string) => account.split('.')[0]!;

/** A balance as Romanian registers show it: on the debit or the credit side. */
const sides = (net: bigint) => ({
  debit: ron(net > 0n ? net : 0n),
  credit: ron(net < 0n ? -net : 0n),
});

/** The justifying document of each entry: its type, number and date (OMFP 2634/2015 pct. 45). */
export async function justifyingDocuments(
  tx: Transaction,
  companyId: string,
  page: (typeof entries.$inferSelect)[],
) {
  const found = new Map<string, { type: string; number: string | null; date: string }>();
  if (!page.length) return found;
  const rows = await tx
    .select({
      entryId: entries.id,
      treatmentId: proposals.treatmentId,
      documentId: proposals.documentId,
      input: proposalVersions.input,
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
        inArray(
          entries.id,
          page.map((entry) => entry.id),
        ),
      ),
    );
  // The recognized document: the one the posted version's input names (a revision may name
  // another than the first version), or the proposal's.
  const documentOf = (row: (typeof rows)[number]) =>
    ((JSON.parse(row.input) as { documentId?: unknown }).documentId as string | undefined) ??
    row.documentId ??
    null;
  const documentIds = rows.flatMap((row) => {
    const id = documentOf(row);
    return id ? [id] : [];
  });
  const docs = new Map(
    (documentIds.length
      ? await tx
          .select({ id: documents.id, kind: documents.kind, body: documents.body })
          .from(documents)
          .where(and(eq(documents.companyId, companyId), inArray(documents.id, documentIds)))
      : []
    ).map((row) => [row.id, row]),
  );
  const movementIds = rows.flatMap((row) =>
    row.treatmentId === 'bank.settle'
      ? [(JSON.parse(row.input) as { movementId: string }).movementId]
      : [],
  );
  const movements = new Map(
    (movementIds.length
      ? await tx
          .select()
          .from(bankMovements)
          .where(
            and(eq(bankMovements.companyId, companyId), inArray(bankMovements.id, movementIds)),
          )
      : []
    ).map((row) => [row.id, row]),
  );
  for (const row of rows) {
    const entry = page.find((item) => item.id === row.entryId)!;
    const input = JSON.parse(row.input) as Record<string, unknown>;
    const documentId = documentOf(row);
    const document = documentId ? docs.get(documentId) : undefined;
    if (document) {
      const body = invoiceDocumentSchema.safeParse(JSON.parse(document.body));
      found.set(row.entryId, {
        type: documentTypes[document.kind] ?? document.kind,
        number: body.success ? body.data.number : null,
        date: body.success ? body.data.issueDate : entry.date,
      });
      continue;
    }
    const movement =
      row.treatmentId === 'bank.settle' ? movements.get(String(input.movementId)) : undefined;
    found.set(row.entryId, {
      type: documentTypes[row.treatmentId] ?? 'Notă contabilă',
      number: movement
        ? movement.reference
        : typeof input.reference === 'string'
          ? input.reference
          : String(input.month ?? input.quarter ?? input.period ?? entry.number),
      date: movement ? movement.bookingDate : entry.date,
    });
  }
  return found;
}

const treasuryLine = or(
  ...treasuryAccounts.flatMap((account) => [
    eq(lines.account, account),
    like(lines.account, `${account}.%`),
  ]),
)!;
const chunks = <T>(values: readonly T[], size = 500) =>
  Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
    values.slice(index * size, (index + 1) * size),
  );

/** Posted entries with their lines, as the single-entry projections read them. */
async function ledgerEntries(tx: Transaction, companyId: string, ids: readonly string[]) {
  const found: LedgerEntry[] = [];
  for (const part of chunks([...new Set(ids)])) {
    if (!part.length) continue;
    const headers = await tx
      .select()
      .from(entries)
      .where(and(eq(entries.companyId, companyId), inArray(entries.id, part)));
    const rows = await tx
      .select()
      .from(lines)
      .where(and(eq(lines.companyId, companyId), inArray(lines.entryId, part)))
      .orderBy(asc(lines.entryId), asc(lines.lineNo));
    const byEntry = Map.groupBy(rows, (row) => row.entryId);
    for (const header of headers)
      found.push({
        id: header.id,
        seq: header.seq,
        date: header.date as LocalDate,
        journalCode: header.journalCode,
        description: header.description,
        lines: (byEntry.get(header.id) ?? []).map((row) => ({
          lineNo: row.lineNo,
          account: row.account,
          side: row.side,
          bani: row.bani,
          openItem: row.openItemId,
          memo: row.memo,
          currency: row.currency
            ? { code: row.currency, minor: row.currencyMinor ?? 0n, rate: row.fxRate ?? '' }
            : null,
        })),
      });
  }
  return found.sort((a, b) => a.seq - b.seq);
}

/**
 * What the single-entry projections read for a period: the entries with a treasury line, the open
 * items their lines name with their partners, and, for each invoice item, every entry that touched
 * it (its composition, credit notes included).
 */
export async function loadTreasuryLedger(
  tx: Transaction,
  companyId: string,
  from: string,
  to: string,
) {
  const treasuryIds = await tx
    .selectDistinct({ id: lines.entryId })
    .from(lines)
    .innerJoin(entries, and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId)))
    .where(
      and(
        eq(lines.companyId, companyId),
        treasuryLine,
        gte(entries.date, from),
        lte(entries.date, to),
      ),
    );
  const ledger = await ledgerEntries(
    tx,
    companyId,
    treasuryIds.map((row) => row.id),
  );
  const itemIds = [
    ...new Set(ledger.flatMap((entry) => entry.lines.flatMap((line) => line.openItem ?? []))),
  ];
  const { items, partyNames } = await itemsOf(tx, companyId, itemIds);
  const itemEntries = await entriesOfItems(tx, companyId, items);
  return { entries: ledger, items, partyNames, itemEntries };
}

/** Open items by id, with their partners' names. */
export async function itemsOf(tx: Transaction, companyId: string, ids: readonly string[]) {
  const items = new Map<string, LedgerItem & { partyId: string }>();
  const partyNames = new Map<string, string>();
  for (const part of chunks(ids)) {
    if (!part.length) continue;
    for (const row of await tx
      .select({ item: openItems, name: parties.name })
      .from(openItems)
      .innerJoin(
        parties,
        and(eq(parties.companyId, openItems.companyId), eq(parties.id, openItems.partyId)),
      )
      .where(and(eq(openItems.companyId, companyId), inArray(openItems.id, part)))) {
      items.set(row.item.id, {
        id: row.item.id,
        controlAccount: row.item.controlAccount,
        documentId: row.item.documentId,
        partyId: row.item.partyId,
      });
      partyNames.set(row.item.id, row.name);
    }
  }
  return { items, partyNames };
}

/** For each invoice item, every posted entry with a line on it, in posting order. */
export async function entriesOfItems(
  tx: Transaction,
  companyId: string,
  items: ReadonlyMap<string, LedgerItem>,
) {
  const documentItems = [...items.values()]
    .filter((item) => item.documentId)
    .map((item) => item.id);
  const touching: { entryId: string; itemId: string | null }[] = [];
  for (const part of chunks(documentItems))
    if (part.length)
      touching.push(
        ...(await tx
          .selectDistinct({ entryId: lines.entryId, itemId: lines.openItemId })
          .from(lines)
          .where(and(eq(lines.companyId, companyId), inArray(lines.openItemId, part)))),
      );
  const loaded = new Map(
    (
      await ledgerEntries(
        tx,
        companyId,
        touching.map((row) => row.entryId),
      )
    ).map((entry) => [entry.id, entry]),
  );
  const itemEntries = new Map<string, LedgerEntry[]>();
  for (const row of touching) {
    const list = itemEntries.get(row.itemId!) ?? [];
    list.push(loaded.get(row.entryId)!);
    itemEntries.set(row.itemId!, list);
  }
  for (const list of itemEntries.values()) list.sort((a, b) => a.seq - b.seq);
  return itemEntries;
}

/** The nature catalogue in force for an income year, or the rule gap that prevents it. */
export function catalogueFor(rules: RuleContext, year: number): NatureCatalogue {
  try {
    return rules.param<NatureCatalogue>(
      'ro.pit.natures',
      'fiscal_year_start',
      `${year}-01-01` as LocalDate,
    );
  } catch (error) {
    if (!(error instanceof RuleGapError)) throw error;
    requireCondition(false, 'RULE_GAP', error.message, 422, { ...error.gap });
  }
}

/** Whether the company keeps single-entry books at any time in the year. */
async function singleEntryIn(tx: Transaction, companyId: string, year: number) {
  const { loaded } = await loadState(tx, companyId, { profile: true });
  const dates = [
    `${year}-01-01`,
    ...loaded.profile
      .map((fact) => fact.effectiveFrom)
      .filter((date) => date.startsWith(String(year))),
    `${year}-12-31`,
  ] as LocalDate[];
  return dates.some((date) => booksSystemOf(loaded.profile, date) === 'single');
}

/** The Registrul-jurnal de încasări și plăți of a year, with its monthly totals and balances. */
export async function cashJournalOf(
  tx: Transaction,
  companyId: string,
  year: number,
  catalogue: NatureCatalogue,
) {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const ledger = await loadTreasuryLedger(tx, companyId, from, to);
  const rows = journalRows({
    entries: ledger.entries,
    items: ledger.items,
    itemEntries: ledger.itemEntries,
    catalogue,
  });
  // Each treasury account's balance before the year, opening entries included.
  const opening = new Map<string, bigint>();
  for (const row of await tx
    .select({
      account: lines.account,
      bani: sql<bigint>`coalesce(sum(case ${lines.side} when 'D' then ${lines.bani} else -${lines.bani} end), 0)`.mapWith(
        BigInt,
      ),
    })
    .from(lines)
    .innerJoin(entries, and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId)))
    .where(
      and(
        eq(lines.companyId, companyId),
        treasuryLine,
        or(
          lt(entries.date, from),
          and(eq(entries.journalCode, 'DESCHIDERE'), lte(entries.date, to)),
        ),
      ),
    )
    .groupBy(lines.account))
    opening.set(row.account, row.bani);
  return { rows, opening, ledger };
}

const signed = (row: JournalRow) => (row.direction === 'receipt' ? row.bani : -row.bani);

export class Reports {
  constructor(
    private readonly commands: Commands,
    private readonly rules?: (tx: Transaction, companyId: string) => Promise<RuleContext>,
  ) {}

  /**
   * Registrul-jurnal de încasări și plăți (OMFP nr. 170/2015, cod 14-1-1/b) for single-entry
   * books: each receipt and payment in cash or by bank, in date order, with its document, the
   * nature of what it settles and the amounts including VAT; monthly totals; and each treasury
   * account's opening balance, receipts, payments and closing balance per month. Amounts in a
   * foreign currency are the lei the ledger booked at the rate of the last banking day before the
   * operation, with the currency amount in the explanation.
   */
  cashJournal(actor: Actor, input: z.infer<typeof cashJournalInput>) {
    return this.commands.read(actor, 'pfa.journal', async (tx) => {
      requireCondition(
        await singleEntryIn(tx, actor.companyId, input.year),
        'SINGLE_ENTRY_ONLY',
        'Registrul-jurnal de încasări și plăți se ține în contabilitatea în partidă simplă (PFA, II, IF).',
      );
      const catalogue = catalogueFor(await this.rules!(tx, actor.companyId), input.year);
      const { rows, opening, ledger } = await cashJournalOf(
        tx,
        actor.companyId,
        input.year,
        catalogue,
      );
      const headers = ledger.entries.length
        ? await tx
            .select()
            .from(entries)
            .where(
              and(
                eq(entries.companyId, actor.companyId),
                inArray(
                  entries.id,
                  ledger.entries.map((entry) => entry.id),
                ),
              ),
            )
        : [];
      const justifying = await justifyingDocuments(tx, actor.companyId, headers);
      const byId = new Map(ledger.entries.map((entry) => [entry.id, entry]));
      const issues: { code: string; message: string; entryId: string }[] = [];
      const view = rows.map((row, index) => {
        const entry = byId.get(row.entryId)!;
        const line = entry.lines.find((item) => item.lineNo === row.lineNo)!;
        const cash = row.channel === 'cash' && line.memo;
        const document = cash
          ? {
              type: row.direction === 'receipt' ? 'Chitanță' : 'Dispoziție de plată',
              number: line.memo,
            }
          : (justifying.get(row.entryId) ?? null);
        const partners = [
          ...new Set(
            entry.lines.flatMap((item) =>
              item.openItem ? (ledger.partyNames.get(item.openItem) ?? []) : [],
            ),
          ),
        ];
        const natures = row.parts.map((part) => {
          const known = natureOf(part.nature);
          if (!known)
            issues.push({
              code:
                part.nature === 'unattributed' ? 'PFA_NATURE_UNATTRIBUTED' : 'PFA_NATURE_MISSING',
              message:
                part.nature === 'unattributed'
                  ? `${entry.description}: factura decontată nu are o compoziție din care să se citească natura.`
                  : `${entry.description}: contul ${part.account} nu are o natură în catalog (ro.pit.natures).`,
              entryId: row.entryId,
            });
          return {
            nature: part.nature,
            label: known?.label ?? 'Natură necunoscută',
            kind: known?.kind ?? null,
            account: part.account,
            amount: ron(part.flow),
          };
        });
        const foreign = row.currency
          ? ` (${formatMoney(row.currency.minor < 0n ? -row.currency.minor : row.currency.minor, row.currency.code)} ${row.currency.code} la cursul ${row.currency.rate})`
          : '';
        return {
          nr: index + 1,
          date: row.date,
          month: row.date.slice(0, 7),
          account: row.account,
          document,
          // In the explanation, amounts as the row's column shows them: what was paid is positive.
          explanation: `${entry.description}${partners.length ? ` – ${partners.join(', ')}` : ''}: ${row.parts
            .map(
              (part, p) =>
                `${natures[p]!.label.toLowerCase()} ${ron(row.direction === 'receipt' ? part.flow : -part.flow)}`,
            )
            .join('; ')}${foreign}`,
          receipts: {
            cash: row.direction === 'receipt' && row.channel === 'cash' ? ron(row.bani) : null,
            bank: row.direction === 'receipt' && row.channel === 'bank' ? ron(row.bani) : null,
          },
          payments: {
            cash: row.direction === 'payment' && row.channel === 'cash' ? ron(row.bani) : null,
            bank: row.direction === 'payment' && row.channel === 'bank' ? ron(row.bani) : null,
          },
          ...(row.currency
            ? {
                currency: {
                  code: row.currency.code,
                  amount: formatMoney(row.currency.minor, row.currency.code),
                  rate: row.currency.rate,
                },
              }
            : {}),
          natures,
          entryId: row.entryId,
        };
      });
      const months = monthlyTotals(rows).map((totals) => ({
        month: totals.month,
        receipts: { cash: ron(totals.receipts.cash), bank: ron(totals.receipts.bank) },
        payments: { cash: ron(totals.payments.cash), bank: ron(totals.payments.bank) },
      }));
      const accountCodes = [
        ...new Set([...opening.keys(), ...rows.map((row) => row.account)]),
      ].sort();
      const accounts = accountCodes.map((account) => {
        let balance = opening.get(account) ?? 0n;
        const opened = balance;
        const perMonth = [
          ...Map.groupBy(
            rows.filter((row) => row.account === account),
            (row) => row.date.slice(0, 7),
          ),
        ]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([month, items]) => {
            const start = balance;
            const receipts = items
              .filter((row) => row.direction === 'receipt')
              .reduce((total, row) => total + row.bani, 0n);
            const payments = items
              .filter((row) => row.direction === 'payment')
              .reduce((total, row) => total + row.bani, 0n);
            balance += items.reduce((total, row) => total + signed(row), 0n);
            return {
              month,
              opening: ron(start),
              receipts: ron(receipts),
              payments: ron(payments),
              closing: ron(balance),
            };
          });
        return { account, opening: ron(opened), months: perMonth, closing: ron(balance) };
      });
      return {
        year: input.year,
        rows: input.month ? view.filter((row) => row.month === input.month) : view,
        months: input.month ? months.filter((totals) => totals.month === input.month) : months,
        accounts,
        issues,
        clauses: ['OMFP170/2015:cap.V.14-1-1', 'OMFP170/2015:cap.III.pct.18'],
      };
    });
  }

  /**
   * Registrul-inventar (OMFP nr. 170/2015, cod 14-1-2/b) for single-entry books, at the start of
   * activity (the earliest income source's start), at a year's end, or at cessation (the last
   * source's end, all sources ended): fixed assets one by one at their entry value, stocks by
   * account, receivables and payables by partner at what is left to collect or pay, cash and bank.
   * The owner's account (4551), equity and depreciation are not inventory items. Values are the
   * books' until a count's differences are recorded.
   */
  singleEntryInventory(actor: Actor, input: z.infer<typeof singleInventoryInput>) {
    return this.commands.read(actor, 'pfa.inventory', async (tx) => {
      const sources = await tx
        .select({
          sourceId: incomeSources.sourceId,
          startedOn: incomeSources.startedOn,
          endedOn: incomeSources.endedOn,
          seq: incomeSources.seq,
        })
        .from(incomeSources)
        .where(eq(incomeSources.companyId, actor.companyId))
        .orderBy(asc(incomeSources.sourceId), asc(incomeSources.seq));
      const latest = [...Map.groupBy(sources, (row) => row.sourceId).values()].map((rows) =>
        rows.at(-1)!,
      );
      let date: string;
      if (input.occasion === 'year_end') date = `${input.year}-12-31`;
      else if (input.occasion === 'start') {
        requireCondition(
          latest.length,
          'INCOME_SOURCE',
          'Înregistrați sursa de venit (pfa.sources.record).',
        );
        date = latest.map((row) => row.startedOn).sort()[0]!;
      } else {
        requireCondition(
          latest.length && latest.every((row) => row.endedOn),
          'CESSATION',
          'Registrul-inventar la încetare se întocmește după încetarea tuturor surselor de venit.',
        );
        date = latest
          .map((row) => row.endedOn!)
          .sort()
          .at(-1)!;
      }
      requireCondition(
        await singleEntryIn(tx, actor.companyId, Number(date.slice(0, 4))),
        'SINGLE_ENTRY_ONLY',
        'Registrul-inventar 14-1-2/b se întocmește în contabilitatea în partidă simplă (PFA, II, IF).',
      );
      const net =
        sql<bigint>`sum(case ${lines.side} when 'D' then ${lines.bani} else -${lines.bani} end)`.mapWith(
          BigInt,
        );
      const join = and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId));
      const balances = await tx
        .select({ account: lines.account, name: ledgerAccounts.name, bani: net })
        .from(lines)
        .innerJoin(entries, join)
        .innerJoin(
          ledgerAccounts,
          and(
            eq(ledgerAccounts.companyId, lines.companyId),
            eq(ledgerAccounts.code, lines.account),
          ),
        )
        .where(and(eq(lines.companyId, actor.companyId), lte(entries.date, date)))
        .groupBy(lines.account)
        .orderBy(asc(lines.account));
      const items = await tx
        .select({ account: openItems.controlAccount, party: parties.name, bani: net })
        .from(lines)
        .innerJoin(entries, join)
        .innerJoin(
          openItems,
          and(eq(openItems.companyId, lines.companyId), eq(openItems.id, lines.openItemId)),
        )
        .innerJoin(
          parties,
          and(eq(parties.companyId, openItems.companyId), eq(parties.id, openItems.partyId)),
        )
        .where(and(eq(lines.companyId, actor.companyId), lte(entries.date, date)))
        .groupBy(openItems.id)
        .orderBy(asc(openItems.controlAccount), asc(parties.name));
      const disposals = new Map(
        (
          await tx
            .select({ assetId: assetEvents.assetId, date: assetEvents.date })
            .from(assetEvents)
            .where(eq(assetEvents.companyId, actor.companyId))
        ).map((row) => [row.assetId, row.date]),
      );
      const cards = (
        await tx
          .select()
          .from(assets)
          .where(and(eq(assets.companyId, actor.companyId), lte(assets.commissionedOn, date)))
          .orderBy(asc(assets.number))
      ).filter((card) => !disposals.has(card.id) || disposals.get(card.id)! > date);
      const synthetic = (account: string) => account.split('.')[0]!;
      const owner = (account: string) => synthetic(account) === '4551';
      const section = (title: string, rows: { description: string; bani: bigint }[]) => ({
        title,
        rows: rows.filter((row) => row.bani !== 0n),
      });
      const sections = [
        section(
          'Imobilizări',
          cards.map((card) => ({
            description: `${card.number} ${card.name}`,
            bani: card.valueBani,
          })),
        ),
        section(
          'Stocuri',
          balances
            .filter((row) => /^3[0-8]/.test(row.account))
            .map((row) => ({ description: `${row.account} ${row.name}`, bani: row.bani })),
        ),
        section('Creanțe', [
          ...items
            .filter((row) => row.bani > 0n && !owner(row.account))
            .map((row) => ({ description: `${row.account} ${row.party}`, bani: row.bani })),
          ...balances
            .filter(
              (row) =>
                /^4/.test(row.account) &&
                row.bani > 0n &&
                !items.some(
                  (item) => item.account === synthetic(row.account) || item.account === row.account,
                ) &&
                !owner(row.account),
            )
            .map((row) => ({ description: `${row.account} ${row.name}`, bani: row.bani })),
        ]),
        section(
          'Disponibilități',
          balances
            .filter((row) => isTreasury(row.account))
            .map((row) => ({ description: `${row.account} ${row.name}`, bani: row.bani })),
        ),
        section('Datorii', [
          ...items
            .filter((row) => row.bani < 0n && !owner(row.account))
            .map((row) => ({ description: `${row.account} ${row.party}`, bani: -row.bani })),
          ...balances
            .filter(
              (row) =>
                (/^4/.test(row.account) || /^(16|519)/.test(row.account)) &&
                row.bani < 0n &&
                !items.some(
                  (item) => item.account === synthetic(row.account) || item.account === row.account,
                ) &&
                !owner(row.account),
            )
            .map((row) => ({ description: `${row.account} ${row.name}`, bani: -row.bani })),
        ]),
      ];
      // Fixed assets are inventoried from the register: one booked without a card would be missed.
      const booked = balances
        .filter((row) => /^2[0-7]/.test(row.account))
        .reduce((sum, row) => sum + row.bani, 0n);
      const carded = cards.reduce((sum, card) => sum + card.valueBani, 0n);
      const issues =
        booked === carded
          ? []
          : [
              {
                code: 'INVENTORY_ASSETS',
                message: `Imobilizările din registre (${ron(booked)} lei) diferă de cele din registrul mijloacelor fixe (${ron(carded)} lei): înregistrați fișele lipsă (assets.register).`,
              },
            ];
      let nr = 0;
      const total = (title: string) =>
        sections
          .filter((item) => item.title === title)
          .flatMap((item) => item.rows)
          .reduce((sum, row) => sum + row.bani, 0n);
      return {
        occasion: input.occasion,
        date,
        sections: sections.map((item) => ({
          title: item.title,
          rows: item.rows.map((row) => ({
            nr: ++nr,
            description: row.description,
            value: ron(row.bani),
          })),
          total: ron(item.rows.reduce((sum, row) => sum + row.bani, 0n)),
        })),
        totals: {
          assets: ron(
            total('Imobilizări') + total('Stocuri') + total('Creanțe') + total('Disponibilități'),
          ),
          liabilities: ron(total('Datorii')),
        },
        issues,
        notes:
          input.occasion === 'cessation'
            ? [
                'La încetare se înscrie valoarea inventariată faptic: înregistrați diferențele constatate la inventariere.',
              ]
            : [],
        clauses: ['OMFP170/2015:cap.V.14-1-2', 'OMFP170/2015:cap.II.pct.8-11'],
      };
    });
  }

  /**
   * Balanța de verificare: opening balance at the start of the financial year, turnover before
   * the period, turnover in the period, cumulative totals and closing balance per account.
   */
  trialBalance(actor: Actor, input: z.infer<typeof trialBalanceInput>) {
    return this.commands.read(actor, 'ledger.trialBalance', async (tx) => {
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
      const from = input.from ?? year.from;
      const to = input.to ?? year.to;
      requireCondition(
        year.from <= from && from <= to && to <= year.to,
        'PERIOD',
        'Intervalul trebuie să fie în exercițiul financiar.',
      );
      const amount = (condition: ReturnType<typeof sql>, side?: 'D' | 'C') =>
        sql<bigint>`coalesce(sum(case when ${condition}${side ? sql` and ${lines.side} = ${side}` : sql``} then ${
          side
            ? lines.bani
            : sql`case ${lines.side} when 'D' then ${lines.bani} else -${lines.bani} end`
        } else 0 end), 0)`.mapWith(BigInt);
      // Opening entries dated on the first day of the year are the initial balance, not turnover.
      const opening = sql`(${entries.journalCode} = 'DESCHIDERE' and ${entries.date} = ${year.from})`;
      const before = sql`(${entries.date} < ${year.from} or ${opening})`;
      const previous = sql`${entries.date} >= ${year.from} and ${entries.date} < ${from} and not ${opening}`;
      const current = sql`${entries.date} >= ${from} and ${entries.date} <= ${to} and not ${opening}`;
      const rows = await tx
        .select({
          account: lines.account,
          name: ledgerAccounts.name,
          opening: amount(before),
          previousDebit: amount(previous, 'D'),
          previousCredit: amount(previous, 'C'),
          currentDebit: amount(current, 'D'),
          currentCredit: amount(current, 'C'),
        })
        .from(lines)
        .innerJoin(
          entries,
          and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId)),
        )
        .innerJoin(
          ledgerAccounts,
          and(
            eq(ledgerAccounts.companyId, lines.companyId),
            eq(ledgerAccounts.code, lines.account),
          ),
        )
        .where(and(eq(lines.companyId, actor.companyId), lte(entries.date, to)))
        .groupBy(lines.account)
        .orderBy(asc(lines.account));
      const totals = {
        opening: 0n,
        previousD: 0n,
        previousC: 0n,
        currentD: 0n,
        currentC: 0n,
        openingD: 0n,
        openingC: 0n,
        closingD: 0n,
        closingC: 0n,
      };
      const view = rows.map((row) => {
        const closing =
          row.opening +
          row.previousDebit -
          row.previousCredit +
          row.currentDebit -
          row.currentCredit;
        const opening = sides(row.opening);
        totals.openingD += row.opening > 0n ? row.opening : 0n;
        totals.openingC += row.opening < 0n ? -row.opening : 0n;
        totals.previousD += row.previousDebit;
        totals.previousC += row.previousCredit;
        totals.currentD += row.currentDebit;
        totals.currentC += row.currentCredit;
        totals.closingD += closing > 0n ? closing : 0n;
        totals.closingC += closing < 0n ? -closing : 0n;
        return {
          account: row.account,
          name: row.name,
          opening,
          previous: { debit: ron(row.previousDebit), credit: ron(row.previousCredit) },
          current: { debit: ron(row.currentDebit), credit: ron(row.currentCredit) },
          total: {
            debit: ron(
              (row.opening > 0n ? row.opening : 0n) + row.previousDebit + row.currentDebit,
            ),
            credit: ron(
              (row.opening < 0n ? -row.opening : 0n) + row.previousCredit + row.currentCredit,
            ),
          },
          closing: sides(closing),
        };
      });
      return {
        year: { id: year.id, from: year.from, to: year.to },
        from,
        to,
        rows: view,
        totals: {
          opening: { debit: ron(totals.openingD), credit: ron(totals.openingC) },
          previous: { debit: ron(totals.previousD), credit: ron(totals.previousC) },
          current: { debit: ron(totals.currentD), credit: ron(totals.currentC) },
          total: {
            debit: ron(totals.openingD + totals.previousD + totals.currentD),
            credit: ron(totals.openingC + totals.previousC + totals.currentC),
          },
          closing: { debit: ron(totals.closingD), credit: ron(totals.closingC) },
        },
      };
    });
  }

  /** Registrul-jurnal: entries in recording order, with their lines. An agent whose reads do not
   * cover `payroll` and `personal` sees the lines on personnel accounts summed per entry, account
   * and side, without the person (`withoutPersons`): a payroll entry's are each employee's pay. */
  journal(actor: Actor, input: z.infer<typeof journalInput>) {
    return this.commands.read(actor, 'ledger.journal', async (tx) => {
      const pay = (await this.commands.readable(tx, actor))(payClasses);
      const headers = await tx
        .select()
        .from(entries)
        .where(
          and(
            eq(entries.companyId, actor.companyId),
            gte(entries.date, input.from),
            lte(entries.date, input.to),
            gt(entries.seq, input.after),
          ),
        )
        .orderBy(asc(entries.seq))
        .limit(input.limit + 1);
      const page = headers.slice(0, input.limit);
      const rows = page.length
        ? await tx
            .select()
            .from(lines)
            .where(
              and(
                eq(lines.companyId, actor.companyId),
                inArray(
                  lines.entryId,
                  page.map((entry) => entry.id),
                ),
              ),
            )
            .orderBy(asc(lines.entryId), asc(lines.lineNo))
        : [];
      const justifying = await justifyingDocuments(tx, actor.companyId, page);
      return {
        entries: page.map((entry) => ({
          id: entry.id,
          number: entry.number,
          document: justifying.get(entry.id) ?? null,
          seq: entry.seq,
          date: entry.date,
          journalCode: entry.journalCode,
          description: entry.description,
          proposalId: entry.proposalId,
          binding: entry.approvalId ? ('approval' as const) : ('policy' as const),
          lines: ((shown) => (pay ? shown : withoutPersons(shown)))(
            rows
              .filter((row) => row.entryId === entry.id)
              .map((row) => {
                const { bani, currency, ...line } = lineSpec(row);
                return {
                  ...line,
                  amount: ron(bani),
                  ...(currency
                    ? {
                        currency: {
                          code: currency.code,
                          amount: formatMoney(currency.minor, currency.code),
                          rate: currency.rate,
                        },
                      }
                    : {}),
                };
              }),
          ),
        })),
        next: headers.length > input.limit ? page.at(-1)!.seq : null,
      };
    });
  }

  /**
   * Cartea mare (OMFP 2634/2015 pct. 47): for a month, each synthetic account's opening balance,
   * its debit and credit turnover by corresponding account, and its closing balance. A line's
   * corresponding accounts are those on the other side of its entry.
   */
  generalLedger(actor: Actor, input: z.infer<typeof generalLedgerInput>) {
    return this.commands.read(actor, 'ledger.generalLedger', async (tx) => {
      const from = `${input.month}-01`;
      const to = `${input.month}-31`;
      const rows = await tx
        .select({ line: lines, date: entries.date })
        .from(lines)
        .innerJoin(
          entries,
          and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId)),
        )
        .where(and(eq(lines.companyId, actor.companyId), lte(entries.date, to)));
      const names = new Map(
        (
          await tx
            .select({ code: ledgerAccounts.code, name: ledgerAccounts.name })
            .from(ledgerAccounts)
            .where(eq(ledgerAccounts.companyId, actor.companyId))
        ).map((row) => [row.code, row.name]),
      );
      const byEntry = new Map<string, typeof rows>();
      for (const row of rows)
        byEntry.set(row.line.entryId, [...(byEntry.get(row.line.entryId) ?? []), row]);
      type Sheet = { opening: bigint; debit: Map<string, bigint>; credit: Map<string, bigint> };
      const sheets = new Map<string, Sheet>();
      const sheet = (account: string) => {
        const existing = sheets.get(account);
        if (existing) return existing;
        const created: Sheet = { opening: 0n, debit: new Map(), credit: new Map() };
        sheets.set(account, created);
        return created;
      };
      for (const { line, date } of rows) {
        const account = synthetic(line.account);
        if (input.account && account !== input.account) continue;
        const signed = line.side === 'D' ? line.bani : -line.bani;
        if (date < from) {
          sheet(account).opening += signed;
          continue;
        }
        const others = [
          ...new Set(
            byEntry
              .get(line.entryId)!
              .filter((other) => other.line.side !== line.side)
              .map((other) => synthetic(other.line.account)),
          ),
        ].sort();
        const correspondent = others.length === 1 ? others[0]! : `% (${others.join(', ')})`;
        const side = line.side === 'D' ? sheet(account).debit : sheet(account).credit;
        side.set(correspondent, (side.get(correspondent) ?? 0n) + line.bani);
      }
      const total = (map: Map<string, bigint>) =>
        [...map.values()].reduce((sum, value) => sum + value, 0n);
      return [...sheets]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([account, { opening, debit, credit }]) => ({
          account,
          name: names.get(account) ?? '',
          opening: sides(opening),
          debit: [...debit].map(([correspondent, bani]) => ({ correspondent, amount: ron(bani) })),
          credit: [...credit].map(([correspondent, bani]) => ({
            correspondent,
            amount: ron(bani),
          })),
          turnover: { debit: ron(total(debit)), credit: ron(total(credit)) },
          closing: sides(opening + total(debit) - total(credit)),
        }));
    });
  }

  /**
   * Registrul-inventar (OMFP 2634/2015 pct. 46): at a date, every asset, liability and equity
   * account (classes 1–5) with a balance, and what makes it up: open items by partner, fixed
   * assets by inventory number. The inventoried value is the books' until inventory differences
   * are recorded. An agent whose reads do not cover `payroll` and `personal` sees a personnel
   * account's balance without the people it is owed to.
   */
  inventoryRegister(actor: Actor, input: z.infer<typeof inventoryInput>) {
    return this.commands.read(actor, 'ledger.inventoryRegister', async (tx) => {
      const pay = (await this.commands.readable(tx, actor))(payClasses);
      const balances = await tx
        .select({
          account: lines.account,
          name: ledgerAccounts.name,
          bani: sql<bigint>`sum(case ${lines.side} when 'D' then ${lines.bani} else -${lines.bani} end)`.mapWith(
            BigInt,
          ),
        })
        .from(lines)
        .innerJoin(
          entries,
          and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId)),
        )
        .innerJoin(
          ledgerAccounts,
          and(
            eq(ledgerAccounts.companyId, lines.companyId),
            eq(ledgerAccounts.code, lines.account),
          ),
        )
        .where(and(eq(lines.companyId, actor.companyId), lte(entries.date, input.date)))
        .groupBy(lines.account)
        .orderBy(asc(lines.account));
      const items = await tx
        .select({
          id: openItems.id,
          account: openItems.controlAccount,
          party: parties.name,
          bani: sql<bigint>`sum(case ${lines.side} when 'D' then ${lines.bani} else -${lines.bani} end)`.mapWith(
            BigInt,
          ),
        })
        .from(lines)
        .innerJoin(
          entries,
          and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId)),
        )
        .innerJoin(
          openItems,
          and(eq(openItems.companyId, lines.companyId), eq(openItems.id, lines.openItemId)),
        )
        .innerJoin(
          parties,
          and(eq(parties.companyId, openItems.companyId), eq(parties.id, openItems.partyId)),
        )
        .where(and(eq(lines.companyId, actor.companyId), lte(entries.date, input.date)))
        .groupBy(openItems.id)
        .orderBy(asc(parties.name));
      const cards = await tx
        .select()
        .from(assets)
        .where(and(eq(assets.companyId, actor.companyId), lte(assets.commissionedOn, input.date)))
        .orderBy(asc(assets.number));
      return balances
        .filter((row) => /^[1-5]/.test(row.account) && row.bani !== 0n)
        .map((row) => ({
          account: row.account,
          name: row.name,
          balance: sides(row.bani),
          items: [
            ...items
              .filter(
                (item) =>
                  item.account === synthetic(row.account) &&
                  item.bani !== 0n &&
                  (pay || !personnelAccount(item.account)),
              )
              .map((item) => ({ description: item.party, balance: sides(item.bani) })),
            ...cards
              .filter((card) => card.account === row.account)
              .map((card) => ({
                description: `${card.number} ${card.name}`,
                balance: sides(card.valueBani),
              })),
          ],
          inventoried: sides(row.bani),
          difference: sides(0n),
        }));
    });
  }
}
