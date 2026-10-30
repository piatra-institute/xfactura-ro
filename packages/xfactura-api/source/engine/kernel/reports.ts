import { and, asc, eq, gt, gte, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { formatMoney } from 'xfactura-core/money';
import { invoiceDocumentSchema } from 'xfactura-core/ubl/invoice-document';
import {
  assets,
  bankMovements,
  documents,
  entries,
  fiscalYears,
  ledgerAccounts,
  lines,
  openItems,
  parties,
  proposalVersions,
  proposals,
} from '../db/schema';
import type { Transaction } from '../db/database';
import type { Actor, Commands } from './commands';
import { lineSpec } from './state';

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
  // The recognized document: the proposal's, or the one its input names.
  const documentOf = (row: (typeof rows)[number]) =>
    row.documentId ??
    ((JSON.parse(row.input) as { documentId?: unknown }).documentId as string | undefined) ??
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

export class Reports {
  constructor(private readonly commands: Commands) {}

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

  /** Registrul-jurnal: entries in recording order, with their lines. */
  journal(actor: Actor, input: z.infer<typeof journalInput>) {
    return this.commands.read(actor, 'ledger.journal', async (tx) => {
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
          lines: rows
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
   * are recorded.
   */
  inventoryRegister(actor: Actor, input: z.infer<typeof inventoryInput>) {
    return this.commands.read(actor, 'ledger.inventoryRegister', async (tx) => {
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
              .filter((item) => item.account === synthetic(row.account) && item.bani !== 0n)
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
