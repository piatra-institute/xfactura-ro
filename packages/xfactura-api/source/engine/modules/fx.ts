import { and, asc, desc, eq, gte, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { parseBnrRates } from 'xfactura-core/fx/bnr';
import { monthEnd, type Month } from 'xfactura-core/time';
import { entries, evidence, fxRates, lines, proposals, treasuryAccounts } from '../db/schema';
import type { ObjectStore } from '../adapters/object-store';
import type { Actor, Commands } from '../kernel/commands';
import type { CloseCheck } from '../kernel/periods';

export const bnrImportInput = z.object({ evidenceId: z.uuid() }).strict();
export const rateQuery = z
  .object({ currency: z.string().regex(/^[A-Z]{3}$/), from: z.iso.date(), to: z.iso.date() })
  .strict();

/**
 * BNR reference rates, kept as published. Rates are public reference data shared by all
 * companies; each import cites the file it came from. A different value for a date already known
 * becomes a new revision rather than replacing the old one.
 */
export class FxRates {
  constructor(
    private readonly commands: Commands,
    private readonly objects: ObjectStore,
  ) {}

  importBnr(actor: Actor, key: string, input: z.infer<typeof bnrImportInput>) {
    return this.commands.run(actor, key, 'fx.importBnr', input, 'write', async (tx) => {
      const [source] = await tx
        .select()
        .from(evidence)
        .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, input.evidenceId)));
      requireCondition(source, 'EVIDENCE', 'Documentul justificativ nu este disponibil.', 404);
      const rates = parseBnrRates(await this.objects.get(actor.companyId, source.hash));
      let added = 0;
      let revised = 0;
      for (const rate of rates) {
        const [latest] = await tx
          .select()
          .from(fxRates)
          .where(
            and(
              eq(fxRates.source, 'BNR'),
              eq(fxRates.currency, rate.currency),
              eq(fxRates.rateDate, rate.date),
            ),
          )
          .orderBy(desc(fxRates.revision))
          .limit(1);
        if (latest && latest.rate === rate.rate && latest.multiplier === rate.multiplier) continue;
        await tx.insert(fxRates).values({
          source: 'BNR',
          currency: rate.currency,
          rateDate: rate.date,
          revision: (latest?.revision ?? 0) + 1,
          rate: rate.rate,
          multiplier: rate.multiplier,
          publishedAt: rate.date,
          evidenceHash: source.hash,
        });
        if (latest) revised++;
        else added++;
      }
      return { rates: rates.length, added, revised };
    });
  }

  rates(actor: Actor, input: z.infer<typeof rateQuery>) {
    return this.commands.read(actor, 'fx.rates', async (tx) =>
      (
        await tx
          .select()
          .from(fxRates)
          .where(
            and(
              eq(fxRates.source, 'BNR'),
              eq(fxRates.currency, input.currency),
              gte(fxRates.rateDate, input.from),
              lte(fxRates.rateDate, input.to),
            ),
          )
          .orderBy(asc(fxRates.rateDate), asc(fxRates.revision))
      ).map((row) => ({
        date: row.rateDate,
        currency: row.currency,
        rate: row.rate,
        multiplier: row.multiplier,
        revision: row.revision,
      })),
    );
  }
}

/** Month-close warning: foreign-currency balances at month end that were not revalued. */
export const fxChecks: CloseCheck[] = [
  {
    id: 'fx.revaluation',
    async run(tx, companyId, month) {
      const end = monthEnd(month as Month);
      const [foreign] = await tx
        .select({ account: lines.account })
        .from(lines)
        .innerJoin(
          entries,
          and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId)),
        )
        .where(
          and(
            eq(lines.companyId, companyId),
            isNotNull(lines.currency),
            lte(entries.date, end),
            // Monetary balances only: partner items and bank or cash accounts, not revenue lines.
            or(
              isNotNull(lines.openItemId),
              inArray(
                lines.account,
                tx
                  .select({ account: treasuryAccounts.ledgerAccount })
                  .from(treasuryAccounts)
                  .where(eq(treasuryAccounts.companyId, companyId)),
              ),
            ),
          ),
        )
        .groupBy(lines.account, lines.currency, lines.openItemId)
        .having(
          sql`sum(case ${lines.side} when 'D' then ${lines.currencyMinor} else -${lines.currencyMinor} end) <> 0`,
        )
        .limit(1);
      if (!foreign) return [];
      const [revalued] = await tx
        .select({ id: entries.id })
        .from(entries)
        .innerJoin(
          proposals,
          and(eq(proposals.companyId, entries.companyId), eq(proposals.id, entries.proposalId)),
        )
        .where(
          and(
            eq(entries.companyId, companyId),
            eq(entries.date, end),
            eq(proposals.treatmentId, 'fx.revalue'),
          ),
        );
      return revalued
        ? []
        : [
            {
              code: 'FX_NOT_REVALUED',
              severity: 'warn' as const,
              message: `Există solduri în valută nereevaluate la ${end}.`,
            },
          ];
    },
  },
];
