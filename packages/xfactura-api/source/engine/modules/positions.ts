import { and, eq, inArray, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { openItemKinds } from 'xfactura-core/kernel';
import { formatMoney } from 'xfactura-core/money';
import { documents, openItems, parties } from '../db/schema';
import type { Actor, Commands } from '../kernel/commands';
import { loadOpenItems } from '../kernel/state';

export const positionQuery = z
  .object({
    partyId: z.uuid().optional(),
    kind: z.enum(openItemKinds).optional(),
    openOnly: z.boolean().default(true),
  })
  .strict();

/** Open items (receivables, payables, advances, …) with their balances and documents. */
export class Positions {
  constructor(private readonly commands: Commands) {}

  list(actor: Actor, input: z.infer<typeof positionQuery>) {
    return this.commands.read(actor, 'openItems.list', async (tx) => {
      const where: SQL[] = [];
      if (input.partyId) where.push(eq(openItems.partyId, input.partyId));
      if (input.kind) where.push(eq(openItems.kind, input.kind));
      const items = (await loadOpenItems(tx, actor.companyId, where)).filter(
        (item) => !input.openOnly || item.balanceBani !== 0n || item.balanceMinor !== 0n,
      );
      const partyNames = new Map(
        items.length
          ? (
              await tx
                .select({ id: parties.id, name: parties.name })
                .from(parties)
                .where(
                  and(
                    eq(parties.companyId, actor.companyId),
                    inArray(parties.id, [...new Set(items.map((item) => item.partyId))]),
                  ),
                )
            ).map((row) => [row.id, row.name])
          : [],
      );
      const documentIds = items.flatMap((item) => (item.documentId ? [item.documentId] : []));
      const numbers = new Map(
        documentIds.length
          ? (
              await tx
                .select({ id: documents.id, number: documents.number })
                .from(documents)
                .where(
                  and(eq(documents.companyId, actor.companyId), inArray(documents.id, documentIds)),
                )
            ).map((row) => [row.id, row.number])
          : [],
      );
      return items.map((item) => ({
        id: item.id,
        kind: item.kind,
        account: item.controlAccount,
        partyId: item.partyId,
        party: partyNames.get(item.partyId) ?? null,
        document: item.documentId ? (numbers.get(item.documentId) ?? null) : null,
        currency: item.currency,
        balance: formatMoney(item.balanceBani, 'RON'),
        balanceCurrency: formatMoney(item.balanceMinor, item.currency),
        dueDate: item.dueDate,
      }));
    });
  }
}
