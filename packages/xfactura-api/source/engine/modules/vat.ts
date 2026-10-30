import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import { formatMoney } from 'xfactura-core/money';
import { documents, entries, parties, taxEntries } from '../db/schema';
import type { Actor, Commands } from '../kernel/commands';

// A VAT period: a month (2026-10), or a quarter (2026-Q4) for quarterly payers.
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/);
export const vatJournalInput = z
  .object({ direction: z.enum(['output', 'input']), from: month, to: month })
  .strict()
  .refine((value) => value.from <= value.to, 'Interval invalid.');

const money = z.string();
export const vatJournalView = z.object({
  direction: z.enum(['output', 'input']),
  from: z.string(),
  to: z.string(),
  rows: z.array(
    z.object({
      entry: z.number(),
      date: z.string(),
      taxPeriod: z.string(),
      /** When the VAT became chargeable (deductible); null while deferred (VAT on collection). */
      exigibility: z.string().nullable(),
      document: z.string().nullable(),
      documentDate: z.string().nullable(),
      counterparty: z.string().nullable(),
      counterpartyTaxId: z.string().nullable(),
      code: z.string(),
      base: money,
      vat: money,
      deductible: money,
    }),
  ),
  totals: z.array(z.object({ code: z.string(), base: money, vat: money, deductible: money })),
});

const ron = (bani: bigint) => formatMoney(bani, 'RON');

/**
 * The sales and purchase VAT journals, from the tax ledger. A working register for review and
 * reconciliation; the official D300/D394 projections are separate, versioned artifacts.
 */
export class VatRegisters {
  constructor(private readonly commands: Commands) {}

  journal(actor: Actor, input: z.infer<typeof vatJournalInput>) {
    return this.commands.read(actor, 'vat.journal', async (tx) => {
      const rows = await tx
        .select({
          entry: entries.number,
          seq: entries.seq,
          date: entries.date,
          taxPeriod: taxEntries.taxPeriod,
          exigibility: taxEntries.exigibility,
          document: documents.number,
          documentDate: documents.docDate,
          counterparty: parties.name,
          counterpartyTaxId: parties.taxId,
          code: taxEntries.code,
          base: taxEntries.baseBani,
          vat: taxEntries.taxBani,
          deductible: taxEntries.deductibleBani,
        })
        .from(taxEntries)
        .innerJoin(
          entries,
          and(eq(entries.companyId, taxEntries.companyId), eq(entries.id, taxEntries.entryId)),
        )
        .leftJoin(
          documents,
          and(
            eq(documents.companyId, taxEntries.companyId),
            eq(documents.id, taxEntries.documentId),
          ),
        )
        .leftJoin(
          parties,
          and(eq(parties.companyId, taxEntries.companyId), eq(parties.id, taxEntries.partyId)),
        )
        .where(
          and(
            eq(taxEntries.companyId, actor.companyId),
            eq(taxEntries.tax, 'VAT'),
            eq(taxEntries.direction, input.direction),
            gte(taxEntries.taxPeriod, input.from),
            lte(taxEntries.taxPeriod, input.to),
          ),
        )
        .orderBy(asc(taxEntries.taxPeriod), asc(entries.seq), asc(taxEntries.taxNo));
      const totals = new Map<string, { base: bigint; vat: bigint; deductible: bigint }>();
      for (const row of rows) {
        const total = totals.get(row.code) ?? { base: 0n, vat: 0n, deductible: 0n };
        total.base += row.base;
        total.vat += row.vat;
        total.deductible += row.deductible;
        totals.set(row.code, total);
      }
      return {
        direction: input.direction,
        from: input.from,
        to: input.to,
        rows: rows.map((row) => ({
          entry: row.entry,
          date: row.date,
          taxPeriod: row.taxPeriod ?? '',
          exigibility: row.exigibility,
          document: row.document,
          documentDate: row.documentDate,
          counterparty: row.counterparty,
          counterpartyTaxId: row.counterpartyTaxId,
          code: row.code,
          base: ron(row.base),
          vat: ron(row.vat),
          deductible: ron(row.deductible),
        })),
        totals: [...totals]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([code, total]) => ({
            code,
            base: ron(total.base),
            vat: ron(total.vat),
            deductible: ron(total.deductible),
          })),
      };
    });
  }
}
