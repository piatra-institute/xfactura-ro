import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { accountCodePattern, formatQuantity, isStockAccount } from 'xfactura-core/kernel';
import { formatMoney } from 'xfactura-core/money';
import { units } from 'xfactura-core/ro/saft/data/codes';
import {
  periodCostOf,
  productionStockAccounts,
  supportedItemAccount,
} from 'xfactura-core/ro/stock';
import type { LocalDate } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import {
  entries,
  evidence,
  ledgerAccounts,
  lines,
  parties,
  proposals,
  stockItemVatCategories,
  stockItems,
  stockLayers,
  stockMoves,
  warehouses,
} from '../db/schema';
import { appendAudit, type Actor, type Commands } from '../kernel/commands';
import type { CloseCheck } from '../kernel/periods';
import { entryStands } from '../kernel/ledger';
import { loadStock } from '../kernel/state';

/*
 * The stock register (G1): the item catalogue and the warehouses, kept as recorded, and what the
 * ledger's entries posted on them: each item's quantity and value per warehouse and layer, its
 * card (fișa de magazie), and the register against the ledger's stock accounts. The layers and
 * moves are written only by posted entries (`effect@2`), under the database's invariants.
 */

const lei = (bani: bigint) => formatMoney(bani, 'RON');
const day = z.iso.date();
const sign = sql`case ${lines.side} when 'D' then 1 else -1 end`;

export const itemInput = z
  .object({
    code: z.string().trim().min(1).max(40),
    name: z.string().trim().min(1).max(200),
    /** UN/ECE Recommendation 20 code of the unit of measure, from the D406 list (H87 a piece,
     * KGM a kilogram, LTR a litre, …). */
    unit: z.enum(Object.keys(units) as [string, ...string[]]),
    /** The NC8 code of the combined nomenclature, when known. */
    nc8: z
      .string()
      .regex(/^\d{8}$/)
      .optional(),
    /** The stock account: 371 goods, 301 raw materials, 302x consumables, 303 inventory objects,
     * 381 packaging (or their analytics). */
    account: z.string().regex(accountCodePattern),
    /** How it is normally taxed when sold; the rate is the register's on the sale's date. */
    vatCategory: z.enum(stockItemVatCategories).optional(),
  })
  .strict();
export const itemView = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  unit: z.string(),
  nc8: z.string().nullable(),
  account: z.string(),
  vatCategory: z.string().nullable(),
});

export const warehouseInput = z
  .object({
    code: z.string().trim().min(1).max(20),
    name: z.string().trim().min(1).max(200),
    /** The person responsible for it (gestionarul). */
    keeper: z.string().trim().min(3).max(200),
    keeperPartyId: z.uuid().optional(),
    /** The keeper's appointment. */
    evidenceId: z.uuid().optional(),
  })
  .strict();
export const warehouseView = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  keeper: z.string(),
  keeperPartyId: z.string().nullable(),
});

export const registerInput = z
  .object({
    /** The day the register is read at; every posted move when omitted. */
    date: day.optional(),
    itemId: z.uuid().optional(),
    warehouseId: z.uuid().optional(),
    /** With each position's layers. */
    layers: z.boolean().default(false),
  })
  .strict();
const layerView = z.object({
  id: z.string(),
  method: z.string(),
  date: z.string(),
  quantity: z.string(),
  value: z.string(),
});
export const registerView = z.object({
  date: z.string().nullable(),
  positions: z.array(
    z.object({
      itemId: z.string(),
      code: z.string(),
      name: z.string(),
      unit: z.string(),
      warehouseId: z.string(),
      warehouse: z.string(),
      account: z.string(),
      quantity: z.string(),
      value: z.string(),
      layers: z.array(layerView).optional(),
    }),
  ),
  /** Per stock account: the register's value, the ledger's balance and what the ledger holds
   * outside the register (lines no move explains). */
  accounts: z.array(
    z.object({
      account: z.string(),
      register: z.string(),
      ledger: z.string(),
      outside: z.string(),
    }),
  ),
});

export const cardInput = z
  .object({
    itemId: z.uuid(),
    warehouseId: z.uuid(),
    from: day.optional(),
    to: day.optional(),
  })
  .strict();
export const cardView = z.object({
  item: itemView,
  warehouse: warehouseView,
  opening: z.object({ quantity: z.string(), value: z.string() }),
  moves: z.array(
    z.object({
      date: z.string(),
      entryId: z.string(),
      number: z.number(),
      treatment: z.string(),
      description: z.string(),
      quantity: z.string(),
      value: z.string(),
      balance: z.object({ quantity: z.string(), value: z.string() }),
    }),
  ),
  closing: z.object({ quantity: z.string(), value: z.string() }),
});

/**
 * Per stock account at a date (every posted entry when omitted): the register's value (its
 * moves), the ledger's balance, and what the ledger holds outside the register: the lines on
 * the account that no move explains (an effect@1 booking, a takeover's credit). The register
 * equals the ledger exactly when nothing is held outside it.
 */
export async function stockAccounts(tx: Transaction, companyId: string, date?: string) {
  const dated = date ? [lte(entries.date, date)] : [];
  // Class 3 by an index range on the account (the register's accounts are filtered below).
  const ledger = await tx
    .select({
      account: lines.account,
      bani: sql<bigint>`sum(${sign} * ${lines.bani})`.mapWith(BigInt),
      // A dealer's item under the margin scheme (371 tagged `margin:`, its own per-document
      // register, V4), or goods at retail price (`retail:`, kept by value on their warehouse's
      // accounts, G2), that no stock move names.
      margin: sql<bigint>`sum(CASE WHEN (coalesce(${lines.item}, '') LIKE 'margin:%'
          OR coalesce(${lines.item}, '') LIKE 'retail:%') AND NOT EXISTS (
          SELECT 1 FROM ${stockMoves} m WHERE m.company_id = ${lines.companyId}
            AND m.entry_id = ${lines.entryId} AND m.line_no = ${lines.lineNo})
        THEN ${sign} * ${lines.bani} ELSE 0 END)`.mapWith(BigInt),
    })
    .from(lines)
    .innerJoin(entries, and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId)))
    .where(
      and(
        eq(lines.companyId, companyId),
        sql`${lines.account} >= '3' AND ${lines.account} < '4'`,
        ...dated,
      ),
    )
    .groupBy(lines.account);
  // The register entry by entry (CROSS JOIN keeps the entries outermost). The moves naming a line
  // add up to it, on its account (inv:stock_move_line): theirs is the value of the lines they
  // explain, read without looking up the moves of each line.
  const register = await tx
    .select({
      account: stockMoves.account,
      bani: sql<bigint>`sum(${stockMoves.bani})`.mapWith(BigInt),
      named:
        sql<bigint>`sum(CASE WHEN ${stockMoves.lineNo} IS NOT NULL THEN ${stockMoves.bani} ELSE 0 END)`.mapWith(
          BigInt,
        ),
    })
    .from(entries)
    .crossJoin(stockMoves)
    .where(
      and(
        eq(entries.companyId, companyId),
        eq(stockMoves.companyId, entries.companyId),
        eq(stockMoves.entryId, entries.id),
        ...dated,
      ),
    )
    .groupBy(stockMoves.account);
  const named = new Map(register.map((row) => [row.account, row.named]));
  const accounts = new Map<string, { register: bigint; ledger: bigint; outside: bigint }>();
  for (const row of ledger) {
    if (!isStockAccount(row.account)) continue;
    accounts.set(row.account, {
      register: 0n,
      ledger: row.bani,
      outside: row.bani - row.margin - (named.get(row.account) ?? 0n),
    });
  }
  for (const row of register) {
    const held = accounts.get(row.account) ?? { register: 0n, ledger: 0n, outside: 0n };
    held.register = row.bani;
    accounts.set(row.account, held);
  }
  return [...accounts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([account, held]) => ({ account, ...held }));
}

/** Whether the company keeps the stock register: an item in its catalogue. */
export async function keepsRegister(tx: Transaction, companyId: string) {
  const [row] = await tx
    .select({ id: stockItems.id })
    .from(stockItems)
    .where(eq(stockItems.companyId, companyId))
    .limit(1);
  return !!row;
}

/** Each position's quantity and value at a date, from the moves of standing entries. A reversed
 * entry's moves and its reversal's cancel out, so all are summed. */
export async function stockPositions(
  tx: Transaction,
  companyId: string,
  options: { date?: string; itemId?: string; warehouseId?: string; layers?: boolean },
) {
  const where = [
    eq(stockMoves.companyId, companyId),
    ...(options.date ? [lte(entries.date, options.date)] : []),
    ...(options.itemId ? [eq(stockMoves.itemId, options.itemId)] : []),
    ...(options.warehouseId ? [eq(stockMoves.warehouseId, options.warehouseId)] : []),
  ];
  const rows = await tx
    .select({
      item: stockMoves.itemId,
      warehouse: stockMoves.warehouseId,
      account: stockMoves.account,
      layer: stockMoves.layerId,
      quantity: sql<bigint>`sum(${stockMoves.quantity})`.mapWith(BigInt),
      bani: sql<bigint>`sum(${stockMoves.bani})`.mapWith(BigInt),
    })
    .from(stockMoves)
    .innerJoin(
      entries,
      and(eq(entries.companyId, stockMoves.companyId), eq(entries.id, stockMoves.entryId)),
    )
    .where(and(...where))
    .groupBy(stockMoves.itemId, stockMoves.warehouseId, stockMoves.account, stockMoves.layerId);
  const layerRows = options.layers
    ? await tx.select().from(stockLayers).where(eq(stockLayers.companyId, companyId))
    : [];
  const layerOf = new Map(layerRows.map((row) => [row.id, row]));
  const positions = new Map<
    string,
    {
      item: string;
      warehouse: string;
      account: string;
      quantity: bigint;
      bani: bigint;
      layers: { id: string; method: string; date: string; quantity: bigint; bani: bigint }[];
    }
  >();
  for (const row of rows) {
    const key = `${row.item}|${row.warehouse}|${row.account}`;
    const held = positions.get(key) ?? {
      item: row.item,
      warehouse: row.warehouse,
      account: row.account,
      quantity: 0n,
      bani: 0n,
      layers: [],
    };
    held.quantity += row.quantity;
    held.bani += row.bani;
    const layer = layerOf.get(row.layer);
    if (layer && (row.quantity !== 0n || row.bani !== 0n))
      held.layers.push({
        id: layer.id,
        method: layer.method,
        date: layer.date,
        quantity: row.quantity,
        bani: row.bani,
      });
    positions.set(key, held);
  }
  for (const held of positions.values())
    held.layers.sort((a, b) =>
      a.date === b.date ? (a.id < b.id ? -1 : 1) : a.date < b.date ? -1 : 1,
    );
  return [...positions.values()];
}

/** The month close: the register against the ledger's stock accounts at the month's end. */
export const stockChecks: CloseCheck[] = [
  {
    id: 'stock.register',
    async run(tx, companyId, month) {
      if (!(await keepsRegister(tx, companyId))) return [];
      const end = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0))
        .toISOString()
        .slice(0, 10);
      // The moves explain each line they name (inv:stock_move_line), so the register equals the
      // ledger exactly when nothing is held outside it (margin items apart, V4).
      const differing = (await stockAccounts(tx, companyId, end)).filter(
        (row) => row.outside !== 0n,
      );
      const findings = differing.length
        ? [
            {
              code: 'STOCK_LEDGER_DIFFERS',
              severity: 'block' as const,
              message: `Registrul stocurilor diferă de contabilitate la ${end}: ${differing
                .map(
                  (row) =>
                    `${row.account} registru ${lei(row.register)}, cont ${lei(row.ledger)}${row.outside ? ` (${lei(row.outside)} în afara registrului)` : ''}`,
                )
                .join(
                  '; ',
                )}. Înregistrați intrările și ieșirile prin gestiune (recepție, bon de consum, descărcare), sau preluați soldul în gestiune (stock.opening).`,
              count: differing.length,
              items: differing.map((row) => row.account),
            },
          ]
        : [];
      // A periodic average pool whose exits of the month are not yet at the month's average
      // (`stock.periodCost`), read as the costing reads them: a receipt reversed in the month, or
      // exits already at the average, leave nothing to cost.
      const [periodic] = await tx
        .select({ id: stockLayers.id })
        .from(stockLayers)
        .where(and(eq(stockLayers.companyId, companyId), eq(stockLayers.method, 'periodic')))
        .limit(1);
      if (!periodic) return findings;
      const [costed] = await tx
        .select({ id: entries.id })
        .from(proposals)
        .innerJoin(
          entries,
          and(eq(entries.companyId, proposals.companyId), eq(entries.proposalId, proposals.id)),
        )
        .where(
          and(
            eq(proposals.companyId, companyId),
            eq(proposals.subjectKey, `stock:periodCost:${month}`),
            entryStands('"acc_entries"'),
          ),
        )
        .limit(1);
      if (costed) return findings;
      const { positions } = await loadStock(tx, companyId, {
        all: true,
        flows: { from: `${month}-01` as LocalDate, to: end as LocalDate },
      });
      const pending = {
        count: [...positions.values()]
          .flatMap((position) => position.layers)
          .filter((layer) => {
            if (layer.method !== 'periodic' || !layer.flows) return false;
            const costing = periodCostOf(layer.flows);
            return costing === 'empty' || (costing !== null && costing.difference !== 0n);
          }).length,
      };
      if (pending.count)
        findings.push({
          code: 'STOCK_PERIOD_COST_MISSING',
          severity: 'block' as const,
          message: `Ieșirile lunii ${month} din ${pending.count} poziții de stoc sunt evaluate provizoriu, la costul mediu curent: cu costul mediu ponderat calculat lunar, costul lor se stabilește la sfârșitul lunii (stock.periodCost).`,
          count: pending.count,
          items: [month],
        });
      return findings;
    },
  },
];

/** The catalogue, the warehouses and the register's reads. */
export class Stock {
  constructor(private readonly commands: Commands) {}

  createItem(actor: Actor, key: string, input: z.infer<typeof itemInput>) {
    return this.commands.run(actor, key, 'stock.items.create', input, 'write', async (tx) => {
      requireCondition(
        isStockAccount(input.account),
        'STOCK_ACCOUNT',
        `Contul ${input.account} nu este un cont de stocuri ținut pe cantități (30x, 331, 34x, 371, 381 și analiticele lor).`,
      );
      // Products and work in progress (G4) are catalogued too; production's treatments move them.
      const unsupported = supportedItemAccount(input.account, productionStockAccounts);
      requireCondition(!unsupported, 'UNSUPPORTED', unsupported ?? '', 422);
      const [account] = await tx
        .select({ postable: ledgerAccounts.postable })
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.companyId, actor.companyId),
            eq(ledgerAccounts.code, input.account),
          ),
        );
      requireCondition(
        account?.postable,
        'ACCOUNT',
        `Contul ${input.account} nu există sau nu este analitic.`,
      );
      const [existing] = await tx
        .select({ id: stockItems.id })
        .from(stockItems)
        .where(and(eq(stockItems.companyId, actor.companyId), eq(stockItems.code, input.code)));
      requireCondition(
        !existing,
        'STOCK_ITEM_EXISTS',
        `Articolul ${input.code} există deja.`,
        409,
        {
          itemId: existing?.id ?? null,
        },
      );
      const id = this.commands.ids();
      const row = {
        id,
        companyId: actor.companyId,
        code: input.code,
        name: input.name,
        unit: input.unit,
        nc8: input.nc8 ?? null,
        account: input.account,
        vatCategory: input.vatCategory ?? null,
        createdBy: actor.actorId,
      };
      await tx.insert(stockItems).values(row);
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.actorId,
        ...(actor.agentId ? { agentId: actor.agentId } : {}),
        action: 'stock.items.create',
        body: { id, code: input.code, account: input.account },
      });
      return {
        id,
        code: row.code,
        name: row.name,
        unit: row.unit,
        nc8: row.nc8,
        account: row.account,
        vatCategory: row.vatCategory,
      };
    });
  }

  listItems(actor: Actor) {
    return this.commands.read(actor, 'stock.items.list', async (tx) => ({
      items: (
        await tx
          .select()
          .from(stockItems)
          .where(eq(stockItems.companyId, actor.companyId))
          .orderBy(asc(stockItems.code))
      ).map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        unit: row.unit,
        nc8: row.nc8,
        account: row.account,
        vatCategory: row.vatCategory,
      })),
      next: null,
    }));
  }

  createWarehouse(actor: Actor, key: string, input: z.infer<typeof warehouseInput>) {
    return this.commands.run(actor, key, 'stock.warehouses.create', input, 'write', async (tx) => {
      if (input.keeperPartyId) {
        const [party] = await tx
          .select({ id: parties.id })
          .from(parties)
          .where(and(eq(parties.companyId, actor.companyId), eq(parties.id, input.keeperPartyId)));
        requireCondition(party, 'PARTY', 'Gestionarul nu există ca partener.', 404);
      }
      if (input.evidenceId) {
        const [file] = await tx
          .select({ id: evidence.id })
          .from(evidence)
          .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, input.evidenceId)));
        requireCondition(
          file,
          'EVIDENCE',
          'Decizia de numire a gestionarului nu este disponibilă.',
          404,
        );
      }
      const [existing] = await tx
        .select({ id: warehouses.id })
        .from(warehouses)
        .where(and(eq(warehouses.companyId, actor.companyId), eq(warehouses.code, input.code)));
      requireCondition(!existing, 'WAREHOUSE_EXISTS', `Gestiunea ${input.code} există deja.`, 409, {
        warehouseId: existing?.id ?? null,
      });
      const id = this.commands.ids();
      await tx.insert(warehouses).values({
        id,
        companyId: actor.companyId,
        code: input.code,
        name: input.name,
        keeper: input.keeper,
        keeperPartyId: input.keeperPartyId ?? null,
        evidenceId: input.evidenceId ?? null,
        createdBy: actor.actorId,
      });
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.actorId,
        ...(actor.agentId ? { agentId: actor.agentId } : {}),
        action: 'stock.warehouses.create',
        body: { id, code: input.code },
      });
      return {
        id,
        code: input.code,
        name: input.name,
        keeper: input.keeper,
        keeperPartyId: input.keeperPartyId ?? null,
      };
    });
  }

  listWarehouses(actor: Actor) {
    return this.commands.read(actor, 'stock.warehouses.list', async (tx) => ({
      items: (
        await tx
          .select()
          .from(warehouses)
          .where(eq(warehouses.companyId, actor.companyId))
          .orderBy(asc(warehouses.code))
      ).map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        keeper: row.keeper,
        keeperPartyId: row.keeperPartyId,
      })),
      next: null,
    }));
  }

  /** The register at a date: each position's quantity and value (and layers), and each stock
   * account's register against the ledger. */
  register(actor: Actor, input: z.infer<typeof registerInput>) {
    return this.commands.read(actor, 'stock.register', async (tx) => {
      const positions = await stockPositions(tx, actor.companyId, input);
      const items = new Map(
        (await tx.select().from(stockItems).where(eq(stockItems.companyId, actor.companyId))).map(
          (row) => [row.id, row],
        ),
      );
      const stores = new Map(
        (await tx.select().from(warehouses).where(eq(warehouses.companyId, actor.companyId))).map(
          (row) => [row.id, row],
        ),
      );
      return {
        date: input.date ?? null,
        positions: positions
          .filter((held) => held.quantity !== 0n || held.bani !== 0n)
          .map((held) => {
            const item = items.get(held.item)!;
            return {
              itemId: held.item,
              code: item.code,
              name: item.name,
              unit: item.unit,
              warehouseId: held.warehouse,
              warehouse: stores.get(held.warehouse)?.code ?? '',
              account: held.account,
              quantity: formatQuantity(held.quantity),
              value: lei(held.bani),
              ...(input.layers
                ? {
                    layers: held.layers.map((layer) => ({
                      id: layer.id,
                      method: layer.method,
                      date: layer.date,
                      quantity: formatQuantity(layer.quantity),
                      value: lei(layer.bani),
                    })),
                  }
                : {}),
            };
          })
          .sort((a, b) =>
            a.code === b.code ? (a.warehouse < b.warehouse ? -1 : 1) : a.code < b.code ? -1 : 1,
          ),
        accounts: (await stockAccounts(tx, actor.companyId, input.date)).map((row) => ({
          account: row.account,
          register: lei(row.register),
          ledger: lei(row.ledger),
          outside: lei(row.outside),
        })),
      };
    });
  }

  /** An item's card in a warehouse (fișa de magazie): every move with the running balance. */
  card(actor: Actor, input: z.infer<typeof cardInput>) {
    return this.commands.read(actor, 'stock.card', async (tx) => {
      const [item] = await tx
        .select()
        .from(stockItems)
        .where(and(eq(stockItems.companyId, actor.companyId), eq(stockItems.id, input.itemId)));
      requireCondition(item, 'NOT_FOUND', 'Articolul nu există.', 404);
      const [store] = await tx
        .select()
        .from(warehouses)
        .where(
          and(eq(warehouses.companyId, actor.companyId), eq(warehouses.id, input.warehouseId)),
        );
      requireCondition(store, 'NOT_FOUND', 'Gestiunea nu există.', 404);
      const rows = await tx
        .select({
          date: entries.date,
          entryId: entries.id,
          number: entries.number,
          seq: entries.seq,
          description: entries.description,
          treatment: proposals.treatmentId,
          quantity: sql<bigint>`sum(${stockMoves.quantity})`.mapWith(BigInt),
          bani: sql<bigint>`sum(${stockMoves.bani})`.mapWith(BigInt),
        })
        .from(stockMoves)
        .innerJoin(
          entries,
          and(eq(entries.companyId, stockMoves.companyId), eq(entries.id, stockMoves.entryId)),
        )
        .innerJoin(
          proposals,
          and(eq(proposals.companyId, entries.companyId), eq(proposals.id, entries.proposalId)),
        )
        .where(
          and(
            eq(stockMoves.companyId, actor.companyId),
            eq(stockMoves.itemId, input.itemId),
            eq(stockMoves.warehouseId, input.warehouseId),
            ...(input.to ? [lte(entries.date, input.to)] : []),
          ),
        )
        .groupBy(entries.id)
        .orderBy(asc(entries.date), asc(entries.seq));
      let quantity = 0n;
      let bani = 0n;
      let opening = { quantity: 0n, bani: 0n };
      const moves: z.infer<typeof cardView>['moves'] = [];
      for (const row of rows) {
        quantity += row.quantity;
        bani += row.bani;
        if (input.from && row.date < input.from) {
          opening = { quantity, bani };
          continue;
        }
        moves.push({
          date: row.date,
          entryId: row.entryId,
          number: row.number,
          treatment: row.treatment,
          description: row.description,
          quantity: formatQuantity(row.quantity),
          value: lei(row.bani),
          balance: { quantity: formatQuantity(quantity), value: lei(bani) },
        });
      }
      return {
        item: {
          id: item.id,
          code: item.code,
          name: item.name,
          unit: item.unit,
          nc8: item.nc8,
          account: item.account,
          vatCategory: item.vatCategory,
        },
        warehouse: {
          id: store.id,
          code: store.code,
          name: store.name,
          keeper: store.keeper,
          keeperPartyId: store.keeperPartyId,
        },
        opening: { quantity: formatQuantity(opening.quantity), value: lei(opening.bani) },
        moves,
        closing: { quantity: formatQuantity(quantity), value: lei(bani) },
      };
    });
  }
}
