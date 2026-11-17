import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  like,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { hashOf } from 'xfactura-core/hash';
import type {
  AccountBalance,
  AccountInfo,
  ControlKind,
  DocumentRecord,
  EvidenceRecord,
  MovementRecord,
  FiscalYear,
  FxRate,
  ItemLines,
  LineSpec,
  Loaded,
  OpenItemKind,
  OpenItemState,
  PartyRecord,
  PartyStatus,
  PayrollRunState,
  PostedEntry,
  ProductionQuery,
  ProductionState,
  AccountTurnover,
  AssetState,
  ProfitPosting,
  ProfileFact,
  ReadPlan,
  ReadSetEntry,
  StockDay,
  StockItemRecord,
  StockLayerState,
  StockMoveSpec,
  StockPosition,
  StockFlows,
  StockQuery,
  TaxEntrySpec,
  TaxPeriodLedger,
  WarehouseRecord,
} from 'xfactura-core/kernel';
import {
  itemLinesKey,
  partyStatusKey,
  stockPositionKey,
  stockRegisterKey,
  turnoverKey,
} from 'xfactura-core/kernel';
import type { LocalDate } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import { documentBookingRows, entryStands, linesUnder } from './ledger';
import { rootOf } from './sources';
import {
  assetEvents,
  assetFiscal,
  assets,
  documents,
  entries,
  bankMovements,
  bomLines,
  boms,
  evidence,
  fiscalYears,
  fxRates,
  ledgerAccounts,
  lines,
  openItems,
  parties,
  partyStatuses,
  payrollLines,
  payrollRunEvents,
  payrollRuns,
  periodEvents,
  profileFacts,
  proposals,
  proposalVersions,
  scheduleRows,
  stockItems,
  stockLayers,
  stockMoves,
  taxEntries,
  treasuryAccounts,
  warehouses,
  workOrderEvents,
  workOrders,
} from '../db/schema';

const date = (value: string) => value as LocalDate;
/** A turnover read on the original sides (`TurnoverQuery.sides`): the reversal proposal of an
 * entry, and the line of the entry it reverses. */
const reversal = alias(proposals, 'turnover_reversal');
const reversedLine = alias(lines, 'turnover_reversed_line');
/** +1 for a debit line, −1 for a credit line. */
const sign = sql`case ${lines.side} when 'D' then 1 else -1 end`;

/** Lines of posted entries as the effect that recorded them (null columns omitted). */
export function lineSpec(row: typeof lines.$inferSelect): LineSpec {
  return {
    account: row.account,
    side: row.side,
    bani: row.bani,
    ...(row.currency
      ? {
          currency: {
            code: row.currency,
            minor: row.currencyMinor ?? 0n,
            rateId: row.fxRateId ?? '',
            rate: row.fxRate ?? '',
          },
        }
      : {}),
    ...(row.partyId ? { partyId: row.partyId } : {}),
    ...(row.openItemId ? { openItem: row.openItemId } : {}),
    ...(row.taxSettlementTax
      ? { taxSettlement: { tax: row.taxSettlementTax, period: row.taxSettlementPeriod ?? '' } }
      : {}),
    ...(row.costCenter || row.project || row.item
      ? {
          analytics: {
            ...(row.costCenter ? { costCenter: row.costCenter } : {}),
            ...(row.project ? { project: row.project } : {}),
            ...(row.item ? { item: row.item } : {}),
          },
        }
      : {}),
    ...(row.memo ? { memo: row.memo } : {}),
  };
}

function taxEntrySpec(row: typeof taxEntries.$inferSelect): TaxEntrySpec {
  return {
    key: row.key,
    tax: row.tax,
    code: row.code,
    direction: row.direction,
    baseBani: row.baseBani,
    taxBani: row.taxBani,
    deductibleBani: row.deductibleBani,
    taxPoint: date(row.taxPoint),
    exigibility: row.exigibility ? date(row.exigibility) : null,
    taxPeriod: row.taxPeriod,
    ...(row.lineNo === null ? {} : { line: row.lineNo - 1 }),
    ledgerBani: row.ledgerBani,
    ...(row.partyId ? { partyId: row.partyId } : {}),
    ...(row.documentId ? { documentId: row.documentId } : {}),
    ...(row.originTaxEntry ? { originTaxEntry: row.originTaxEntry } : {}),
    ...(row.currency
      ? {
          currency: {
            code: row.currency,
            baseMinor: row.baseMinor ?? 0n,
            taxMinor: row.taxMinor ?? 0n,
            rateId: row.fxRateId ?? '',
            rate: row.fxRate ?? '',
          },
        }
      : {}),
    attributes: JSON.parse(row.attributes) as Record<string, string>,
  };
}

/** A posted stock move as the effect recorded it. */
export function stockMoveSpec(row: typeof stockMoves.$inferSelect): StockMoveSpec {
  return {
    item: row.itemId,
    warehouse: row.warehouseId,
    account: row.account,
    layer: row.layerId,
    quantity: row.quantity,
    bani: row.bani,
    ...(row.lineNo === null ? {} : { line: row.lineNo - 1 }),
  };
}

/**
 * The stock register's positions a query reads, with their layers' balances in FIFO order, and
 * the catalogue's cards and warehouses they name. Each position read is a read-set entry whose
 * version is the number of moves posted on it; a read of the whole register is one entry.
 */
export async function loadStock(tx: Transaction, companyId: string, query: StockQuery) {
  const readSet: ReadSetEntry[] = [];
  const wanted = new Map<string, { item: string; warehouse: string }>();
  for (const position of query.positions ?? [])
    wanted.set(stockPositionKey(position.item, position.warehouse), position);
  if (query.touchedBy)
    for (const row of await tx
      .selectDistinct({ item: stockMoves.itemId, warehouse: stockMoves.warehouseId })
      .from(stockMoves)
      .where(and(eq(stockMoves.companyId, companyId), eq(stockMoves.entryId, query.touchedBy))))
      wanted.set(stockPositionKey(row.item, row.warehouse), row);
  const itemIds = [...new Set([...wanted.values()].map((position) => position.item))];
  const scope = query.all
    ? [eq(stockLayers.companyId, companyId)]
    : [eq(stockLayers.companyId, companyId), inArray(stockLayers.itemId, itemIds)];
  const layerRows =
    query.all || itemIds.length
      ? await tx
          .select({ layer: stockLayers, seq: entries.seq })
          .from(stockLayers)
          .innerJoin(
            entries,
            and(
              eq(entries.companyId, stockLayers.companyId),
              eq(entries.id, stockLayers.originEntryId),
            ),
          )
          .where(and(...scope))
          .orderBy(asc(stockLayers.date), asc(entries.seq), asc(stockLayers.id))
      : [];
  const moveScope = query.all
    ? [eq(stockMoves.companyId, companyId)]
    : [eq(stockMoves.companyId, companyId), inArray(stockMoves.itemId, itemIds)];
  const balances = new Map<string, { quantity: bigint; bani: bigint }>();
  const counts = new Map<string, number>();
  let total = 0;
  if (query.all || itemIds.length) {
    // Each layer's balance from the layer index alone (`stock_move_layer`): the items' layers,
    // whose moves are on their item (`inv:stock_move_layer`), rather than every move of the items.
    const layerScope = query.all
      ? [eq(stockMoves.companyId, companyId)]
      : [
          eq(stockMoves.companyId, companyId),
          inArray(
            stockMoves.layerId,
            tx
              .select({ id: stockLayers.id })
              .from(stockLayers)
              .where(and(...scope)),
          ),
        ];
    for (const row of await tx
      .select({
        layer: stockMoves.layerId,
        quantity: sql<bigint>`coalesce(sum(${stockMoves.quantity}), 0)`.mapWith(BigInt),
        bani: sql<bigint>`coalesce(sum(${stockMoves.bani}), 0)`.mapWith(BigInt),
      })
      .from(stockMoves)
      .where(and(...layerScope))
      .groupBy(stockMoves.layerId))
      balances.set(row.layer, { quantity: row.quantity, bani: row.bani });
    for (const row of await tx
      .select({
        item: stockMoves.itemId,
        warehouse: stockMoves.warehouseId,
        count: sql<number>`count(*)`.mapWith(Number),
      })
      .from(stockMoves)
      .where(and(...moveScope))
      .groupBy(stockMoves.itemId, stockMoves.warehouseId)) {
      counts.set(stockPositionKey(row.item, row.warehouse), row.count);
      total += row.count;
    }
  }
  // Each layer's flows in the range: before it, entering in it, leaving in it. A move in the range
  // enters or leaves by the line it explains (a debit or a credit of the stock account, so a red
  // storno of a receipt or a return to the supplier is a negative entry), a reversal's move by
  // the move it mirrors (the same number in the reversed entry, whose subject names it), so that
  // a storno in black nets against its original too; a move without a line by its quantity's sign.
  const flows = new Map<string, StockFlows>();
  if (query.flows && (query.all || itemIds.length)) {
    const { from, to } = query.flows;
    const zero = () => ({ quantity: 0n, bani: 0n });
    const mirrored = sql`coalesce((SELECT substr(rp.subject_key, 9) FROM acc_proposals rp
      WHERE rp.company_id = ${entries.companyId} AND rp.id = ${entries.proposalId}
        AND substr(rp.subject_key, 1, 8) = 'reverse:'), ${stockMoves.entryId})`;
    const side = sql`coalesce((SELECT CASE WHEN ol.side IS NOT NULL THEN ol.side
          WHEN om.quantity < 0 THEN 'C' ELSE 'D' END
        FROM acc_stock_moves om LEFT JOIN acc_lines ol ON ol.company_id = om.company_id
          AND ol.entry_id = om.entry_id AND ol.line_no = om.line_no
        WHERE om.company_id = ${stockMoves.companyId} AND om.entry_id = ${mirrored}
          AND om.move_no = ${stockMoves.moveNo}),
      CASE WHEN ${stockMoves.quantity} < 0 THEN 'C' ELSE 'D' END)`;
    for (const row of await tx
      .select({
        layer: stockMoves.layerId,
        part: sql<string>`CASE WHEN ${entries.date} < ${from} THEN 'opening'
          WHEN ${entries.date} > ${to} THEN 'later'
          WHEN ${side} = 'C' THEN 'left' ELSE 'entered' END`,
        quantity: sql<bigint>`coalesce(sum(${stockMoves.quantity}), 0)`.mapWith(BigInt),
        bani: sql<bigint>`coalesce(sum(${stockMoves.bani}), 0)`.mapWith(BigInt),
      })
      .from(stockMoves)
      .innerJoin(
        entries,
        and(eq(entries.companyId, stockMoves.companyId), eq(entries.id, stockMoves.entryId)),
      )
      .where(and(...moveScope))
      .groupBy(stockMoves.layerId, sql`2`)) {
      const held = flows.get(row.layer) ?? { opening: zero(), entered: zero(), left: zero() };
      if (row.part !== 'later')
        held[row.part as keyof StockFlows] = { quantity: row.quantity, bani: row.bani };
      flows.set(row.layer, held);
    }
  }
  // Each layer's moves per day in the months still open: nothing is posted on or before the last
  // closed month (`inv:later_period_closed`), so what moved after any exit's date is here. The
  // open months' entries are read first when a month is closed, the items' moves otherwise.
  const days = new Map<string, StockDay[]>();
  if (query.dated && (query.all || itemIds.length)) {
    const [closed] = await tx
      .select({ month: sql<string | null>`max(${periodEvents.month})` })
      .from(periodEvents)
      .where(
        and(
          eq(periodEvents.companyId, companyId),
          eq(periodEvents.kind, 'close'),
          sql`${periodEvents.seq} = (SELECT max(q.seq) FROM acc_period_events q
            WHERE q.company_id = ${periodEvents.companyId} AND q.month = ${periodEvents.month})`,
        ),
      );
    const select = {
      layer: stockMoves.layerId,
      date: entries.date,
      quantity: sql<bigint>`coalesce(sum(${stockMoves.quantity}), 0)`.mapWith(BigInt),
      bani: sql<bigint>`coalesce(sum(${stockMoves.bani}), 0)`.mapWith(BigInt),
    };
    const join = [
      eq(entries.companyId, stockMoves.companyId),
      eq(entries.id, stockMoves.entryId),
    ] as const;
    const rows = closed?.month
      ? await tx
          .select(select)
          .from(entries)
          .crossJoin(stockMoves)
          .where(
            and(
              eq(entries.companyId, companyId),
              sql`${entries.period} > ${closed.month}`,
              ...join,
              ...(query.all ? [] : [inArray(stockMoves.itemId, itemIds)]),
            ),
          )
          .groupBy(stockMoves.layerId, entries.date)
      : await tx
          .select(select)
          .from(stockMoves)
          .crossJoin(entries)
          .where(and(...moveScope, ...join))
          .groupBy(stockMoves.layerId, entries.date);
    for (const row of rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
      const list = days.get(row.layer) ?? [];
      list.push({ date: date(row.date), quantity: row.quantity, bani: row.bani });
      days.set(row.layer, list);
    }
  }
  const positions = new Map<string, StockPosition>();
  const layersOf = new Map<string, StockLayerState[]>();
  for (const { layer, seq } of layerRows) {
    const key = stockPositionKey(layer.itemId, layer.warehouseId);
    if (!query.all && !wanted.has(key)) continue;
    const held = balances.get(layer.id) ?? { quantity: 0n, bani: 0n };
    const list = layersOf.get(key) ?? [];
    list.push({
      id: layer.id,
      item: layer.itemId,
      warehouse: layer.warehouseId,
      account: layer.account,
      method: layer.method,
      mayGoNegative: layer.mayGoNegative,
      quantity: held.quantity,
      bani: held.bani,
      date: date(layer.date),
      originEntryId: layer.originEntryId,
      seq: Number(seq),
      ...(query.flows
        ? {
            flows: flows.get(layer.id) ?? {
              opening: { quantity: 0n, bani: 0n },
              entered: { quantity: 0n, bani: 0n },
              left: { quantity: 0n, bani: 0n },
            },
          }
        : {}),
      ...(query.dated ? { days: days.get(layer.id) ?? [] } : {}),
    });
    layersOf.set(key, list);
  }
  const keys = query.all ? [...layersOf.keys()] : [...wanted.keys()];
  for (const key of keys.sort()) {
    const [item, warehouse] = key.split('|') as [string, string];
    positions.set(key, {
      item,
      warehouse,
      moves: counts.get(key) ?? 0,
      layers: layersOf.get(key) ?? [],
    });
    if (!query.all) readSet.push({ kind: 'stock', id: key, version: String(counts.get(key) ?? 0) });
  }
  // The whole register as one read: any move posted changes its count. A company that never
  // moved stock reads nothing, so what read the register before it existed hashes as it did; its
  // first move still makes such a proposal stale on its re-evaluation.
  if (query.all && total > 0)
    readSet.push({ kind: 'stock', id: stockRegisterKey, version: String(total) });
  const itemSet = new Set([...[...positions.values()].map((p) => p.item), ...(query.items ?? [])]);
  const items = new Map<string, StockItemRecord>();
  if (itemSet.size || query.catalogue)
    for (const row of await tx
      .select()
      .from(stockItems)
      .where(
        and(
          eq(stockItems.companyId, companyId),
          ...(query.catalogue ? [] : [inArray(stockItems.id, [...itemSet])]),
        ),
      )
      .orderBy(asc(stockItems.code)))
      items.set(row.id, {
        id: row.id,
        code: row.code,
        name: row.name,
        unit: row.unit,
        nc8: row.nc8,
        account: row.account,
        vatCategory: row.vatCategory,
      });
  const warehouseSet = new Set([
    ...[...positions.values()].map((p) => p.warehouse),
    ...(query.warehouses ?? []),
  ]);
  const stores = new Map<string, WarehouseRecord>();
  if (warehouseSet.size || query.catalogue)
    for (const row of await tx
      .select()
      .from(warehouses)
      .where(
        and(
          eq(warehouses.companyId, companyId),
          ...(query.catalogue ? [] : [inArray(warehouses.id, [...warehouseSet])]),
        ),
      )
      .orderBy(asc(warehouses.code)))
      stores.set(row.id, { id: row.id, code: row.code, name: row.name, keeper: row.keeper });
  return { positions, items, warehouses: stores, readSet };
}

/**
 * Production (G4): the bills of materials with their lines, the work orders with the day each
 * closed, and, with `lines`, every line tagged `production:…` dated in the range, summed per tag,
 * account, entry date and the stock item its moves carry. One read: a BOM version, an order, an
 * event or a tagged line posted in the range changes its version.
 */
async function loadProduction(tx: Transaction, companyId: string, query: ProductionQuery) {
  const bomRows = await tx
    .select()
    .from(boms)
    .where(eq(boms.companyId, companyId))
    .orderBy(asc(boms.itemId), asc(boms.version));
  const lineRows = await tx
    .select()
    .from(bomLines)
    .where(eq(bomLines.companyId, companyId))
    .orderBy(asc(bomLines.bomId), asc(bomLines.lineNo));
  const orderRows = await tx
    .select()
    .from(workOrders)
    .where(eq(workOrders.companyId, companyId))
    .orderBy(asc(workOrders.number));
  const eventRows = await tx
    .select()
    .from(workOrderEvents)
    .where(eq(workOrderEvents.companyId, companyId))
    .orderBy(asc(workOrderEvents.orderId), asc(workOrderEvents.seq));
  const bomMap: ProductionState['boms'] extends ReadonlyMap<string, infer V>
    ? Map<string, V>
    : never = new Map();
  for (const row of bomRows)
    bomMap.set(row.id, {
      id: row.id,
      itemId: row.itemId,
      version: row.version,
      validFrom: date(row.validFrom),
      outputQuantity: row.outputQuantity,
      standardCost: row.standardCost,
      labourHours: row.labourHours,
      machineHours: row.machineHours,
      evidenceId: row.evidenceId,
      lines: lineRows
        .filter((line) => line.bomId === row.id)
        .map((line) => ({ lineNo: line.lineNo, itemId: line.itemId, quantity: line.quantity })),
    });
  const closed = new Map(
    eventRows.filter((row) => row.kind === 'closed').map((row) => [row.orderId, row.date]),
  );
  const orderMap: ProductionState['orders'] extends ReadonlyMap<string, infer V>
    ? Map<string, V>
    : never = new Map();
  for (const row of orderRows)
    orderMap.set(row.id, {
      id: row.id,
      number: row.number,
      itemId: row.itemId,
      bomId: row.bomId,
      quantity: row.quantity,
      openedOn: date(row.openedOn),
      closedOn: closed.has(row.id) ? date(closed.get(row.id)!) : null,
      evidenceId: row.evidenceId,
    });
  const tagged: ProductionState['lines'][number][] = [];
  let mark = '';
  if (query.lines) {
    const { from, to } = query.lines;
    const range = and(
      eq(lines.companyId, companyId),
      like(lines.item, 'production:%'),
      lte(entries.date, to),
      ...(from ? [gte(entries.date, from)] : []),
    );
    const join = and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId));
    // The moves of each tagged line, summed per line first: a line taking two lots has two moves.
    const moved = tx
      .select({
        entryId: stockMoves.entryId,
        lineNo: stockMoves.lineNo,
        item: sql<string>`max(${stockMoves.itemId})`.as('moved_item'),
        quantity: sql<bigint>`sum(${stockMoves.quantity})`.as('moved_quantity'),
      })
      .from(stockMoves)
      .where(
        and(
          eq(stockMoves.companyId, companyId),
          inArray(
            stockMoves.entryId,
            tx
              .select({ id: lines.entryId })
              .from(lines)
              .where(and(eq(lines.companyId, companyId), like(lines.item, 'production:%'))),
          ),
        ),
      )
      .groupBy(stockMoves.entryId, stockMoves.lineNo)
      .as('moved');
    const rows = await tx
      .select({
        tag: lines.item,
        account: lines.account,
        date: entries.date,
        debit:
          sql<bigint>`sum(CASE WHEN ${lines.side} = 'D' THEN ${lines.bani} ELSE 0 END)`.mapWith(
            BigInt,
          ),
        credit:
          sql<bigint>`sum(CASE WHEN ${lines.side} = 'C' THEN ${lines.bani} ELSE 0 END)`.mapWith(
            BigInt,
          ),
        item: moved.item,
        quantity: sql<bigint>`coalesce(sum(${moved.quantity}), 0)`.mapWith(BigInt),
      })
      .from(lines)
      .innerJoin(entries, join)
      .leftJoin(moved, and(eq(moved.entryId, lines.entryId), eq(moved.lineNo, lines.lineNo)))
      .where(range)
      .groupBy(lines.item, lines.account, entries.date, sql`moved_item`)
      .orderBy(asc(lines.item), asc(lines.account), asc(entries.date), sql`moved_item`);
    for (const row of rows)
      tagged.push({
        tag: row.tag!,
        account: row.account,
        date: date(row.date),
        debit: row.debit,
        credit: row.credit,
        item: row.item ?? null,
        quantity: row.quantity,
      });
    const [counted] = await tx
      .select({
        count: sql<number>`count(*)`.mapWith(Number),
        last: sql<number>`COALESCE(max(${entries.seq}), 0)`.mapWith(Number),
      })
      .from(lines)
      .innerJoin(entries, join)
      .where(range);
    mark = `/${counted!.count}/${counted!.last}`;
  }
  const readSet: ReadSetEntry[] = [
    {
      kind: 'production',
      id: query.lines ? `lines|${query.lines.from ?? ''}|${query.lines.to}` : 'catalogue',
      version: `${bomRows.length}/${orderRows.length}/${eventRows.length}${mark}`,
    },
  ];
  const state: ProductionState = { boms: bomMap, orders: orderMap, lines: tagged };
  return { state, readSet };
}

/**
 * The company's profile facts in effect order (effective date, then recording), superseded ones
 * left out: what treatments read as `Loaded.profile`, and what `factInEffect` resolves a value on.
 */
export async function profileRows(tx: Pick<Transaction, 'select'>, companyId: string) {
  const rows = await tx
    .select()
    .from(profileFacts)
    .where(eq(profileFacts.companyId, companyId))
    .orderBy(asc(profileFacts.effectiveFrom), asc(profileFacts.createdAt), asc(profileFacts.id));
  const superseded = new Set(rows.map((row) => row.supersedesId).filter(Boolean));
  return rows.filter((row) => !superseded.has(row.id));
}

/** Open items with their balances, as of everything posted so far; with `asOf`, as of the
 * entries dated on or before that day, and only the items opened by then. */
export async function loadOpenItems(
  tx: Transaction,
  companyId: string,
  where: SQL[],
  asOf?: string,
) {
  const dated = (entryId: SQL | typeof lines.entryId) =>
    sql`(select de.date from ${entries} de where de.company_id = ${openItems.companyId} and de.id = ${entryId})`;
  const counted = asOf === undefined ? sql`1` : sql`${dated(lines.entryId)} <= ${asOf}`;
  const rows = await tx
    .select({
      item: openItems,
      bani: sql<bigint>`coalesce(sum(case when ${counted} then ${sign} * ${lines.bani} else 0 end), 0)`.mapWith(
        BigInt,
      ),
      minor:
        sql<bigint>`coalesce(sum(case when ${counted} then ${sign} * coalesce(${lines.currencyMinor}, ${lines.bani}) else 0 end), 0)`.mapWith(
          BigInt,
        ),
      movements: sql<number>`count(case when ${counted} then ${lines.lineNo} end)`.mapWith(Number),
    })
    .from(openItems)
    .leftJoin(
      lines,
      and(eq(lines.companyId, openItems.companyId), eq(lines.openItemId, openItems.id)),
    )
    .where(
      and(
        eq(openItems.companyId, companyId),
        ...where,
        asOf === undefined ? undefined : sql`${dated(sql`${openItems.originEntryId}`)} <= ${asOf}`,
      ),
    )
    .groupBy(openItems.id)
    .orderBy(asc(openItems.id));
  return rows.map(({ item, bani, minor, movements }): OpenItemState => ({
    id: item.id,
    kind: item.kind as OpenItemKind,
    controlAccount: item.controlAccount,
    partyId: item.partyId,
    currency: item.currency,
    normalSide: item.normalSide,
    mayReverse: item.mayReverse,
    balanceBani: bani,
    balanceMinor: minor,
    documentId: item.documentId,
    dueDate: item.dueDate ? date(item.dueDate) : null,
    originEntryId: item.originEntryId,
    movements,
  }));
}

/** Executes a read plan in the caller's transaction and records what was read. */
export async function loadState(tx: Transaction, companyId: string, plan: ReadPlan) {
  const readSet: ReadSetEntry[] = [];
  const years: FiscalYear[] = (
    await tx
      .select()
      .from(fiscalYears)
      .where(eq(fiscalYears.companyId, companyId))
      .orderBy(asc(fiscalYears.from), asc(fiscalYears.kind))
  ).map((row) => ({ id: row.id, kind: row.kind, from: date(row.from), to: date(row.to) }));

  const evidenceMap = new Map<string, EvidenceRecord>();
  if (plan.evidence?.length)
    for (const row of await tx
      .select()
      .from(evidence)
      .where(and(eq(evidence.companyId, companyId), inArray(evidence.id, plan.evidence)))
      .orderBy(asc(evidence.id))) {
      evidenceMap.set(row.id, {
        id: row.id,
        hash: row.hash,
        filename: row.filename,
        mediaType: row.mediaType,
      });
      readSet.push({ kind: 'evidence', id: row.id, version: row.hash });
    }

  const documentMap = new Map<string, DocumentRecord>();
  if (plan.documents?.length)
    for (const row of await tx
      .select()
      .from(documents)
      .where(and(eq(documents.companyId, companyId), inArray(documents.id, plan.documents)))
      .orderBy(asc(documents.id))) {
      documentMap.set(row.id, {
        id: row.id,
        kind: row.kind,
        schema: row.schema,
        body: JSON.parse(row.body),
        bodyHash: row.bodyHash,
        docDate: date(row.docDate),
        partyId: row.partyId,
        currency: row.currency,
        number: row.number,
        evidenceId: row.evidenceId,
      });
      readSet.push({ kind: 'document', id: row.id, version: row.bodyHash });
    }

  for (const id of [...new Set(plan.documentBookings ?? [])].sort()) {
    const [booking] = await tx.all<{ entryId: string; number: number; opening: number }>(
      sql`select entryId, number, opening from (${documentBookingRows(companyId, id, { postedOnly: true })}) limit 1`,
    );
    const document = documentMap.get(id);
    if (document) document.groupId = await rootOf(tx, companyId, id);
    if (document && booking)
      document.booking = {
        entryId: booking.entryId,
        number: Number(booking.number),
        opening: !!booking.opening,
      };
    readSet.push({ kind: 'documentBooking', id, version: booking?.entryId ?? '' });
  }

  const entryMap = new Map<string, PostedEntry>();
  if (plan.entries?.length) {
    const ids = plan.entries;
    const headers = await tx
      .select({
        id: entries.id,
        number: entries.number,
        seq: entries.seq,
        date: entries.date,
        journalClass: entries.journalClass,
        journalCode: entries.journalCode,
        description: entries.description,
        subject: proposals.subjectKey,
      })
      .from(entries)
      .innerJoin(
        proposals,
        and(eq(proposals.companyId, entries.companyId), eq(proposals.id, entries.proposalId)),
      )
      .where(and(eq(entries.companyId, companyId), inArray(entries.id, ids)))
      .orderBy(asc(entries.seq));
    const lineRows = await tx
      .select()
      .from(lines)
      .where(and(eq(lines.companyId, companyId), inArray(lines.entryId, ids)))
      .orderBy(asc(lines.entryId), asc(lines.lineNo));
    const taxRows = await tx
      .select()
      .from(taxEntries)
      .where(and(eq(taxEntries.companyId, companyId), inArray(taxEntries.entryId, ids)))
      .orderBy(asc(taxEntries.entryId), asc(taxEntries.taxNo));
    const moveRows = await tx
      .select()
      .from(stockMoves)
      .where(and(eq(stockMoves.companyId, companyId), inArray(stockMoves.entryId, ids)))
      .orderBy(asc(stockMoves.entryId), asc(stockMoves.moveNo));
    for (const header of headers) {
      const moves = moveRows.filter((row) => row.entryId === header.id).map(stockMoveSpec);
      entryMap.set(header.id, {
        id: header.id,
        number: header.number,
        date: date(header.date),
        journalClass: header.journalClass,
        journalCode: header.journalCode,
        description: header.description,
        lines: lineRows.filter((row) => row.entryId === header.id).map(lineSpec),
        taxEntries: taxRows.filter((row) => row.entryId === header.id).map(taxEntrySpec),
        ...(moves.length ? { stockMoves: moves } : {}),
        ...(header.subject.startsWith('reverse:')
          ? { reverses: header.subject.slice('reverse:'.length) }
          : {}),
      });
      readSet.push({ kind: 'entry', id: header.id, version: String(header.seq) });
    }
  }

  const itemMap = new Map<string, OpenItemState>();
  for (const query of plan.openItems ?? []) {
    const where: SQL[] = [];
    if (query.ids) where.push(query.ids.length ? inArray(openItems.id, query.ids) : sql`0`);
    if (query.touchedBy)
      where.push(
        inArray(
          openItems.id,
          tx
            .select({ id: lines.openItemId })
            .from(lines)
            .where(and(eq(lines.companyId, companyId), eq(lines.entryId, query.touchedBy))),
        ),
      );
    // A document's open items from its bookings that stand: an item a reversal cleared belongs
    // to a booking that no longer counts, and a new booking of the document opens its own.
    if (query.documentId)
      where.push(
        eq(openItems.documentId, query.documentId),
        sql`not exists (select 1 from ${proposals} rv join ${entries} re
          on re.company_id = rv.company_id and re.proposal_id = rv.id
          where rv.company_id = ${openItems.companyId}
            and rv.subject_key = 'reverse:' || ${openItems.originEntryId})`,
      );
    if (query.partyId) where.push(eq(openItems.partyId, query.partyId));
    if (query.kind) where.push(eq(openItems.kind, query.kind));
    if (query.accounts)
      where.push(
        query.accounts.length
          ? or(...query.accounts.map((prefix) => like(openItems.controlAccount, `${prefix}%`)))!
          : sql`0`,
      );
    if (query.foreign) where.push(ne(openItems.currency, 'RON'));
    const items = (await loadOpenItems(tx, companyId, where)).filter(
      (item) => !query.openOnly || item.balanceBani !== 0n || item.balanceMinor !== 0n,
    );
    if (query.schedules && items.length) {
      const rows = await tx
        .select()
        .from(scheduleRows)
        .where(
          and(
            eq(scheduleRows.companyId, companyId),
            inArray(
              scheduleRows.openItemId,
              items.map((item) => item.id),
            ),
          ),
        )
        .orderBy(asc(scheduleRows.dueDate), asc(scheduleRows.rowKey));
      for (const item of items) {
        const own = rows.filter((row) => row.openItemId === item.id);
        const latest = Math.max(...own.map((row) => row.version));
        const current = own.filter((row) => row.version === latest);
        if (current.length) {
          item.schedule = {
            id: current[0]!.scheduleId,
            version: latest,
            method: current[0]!.method,
            rows: current.map((row) => ({
              key: row.rowKey,
              due: date(row.dueDate),
              bani: row.bani,
              counterAccount: row.counterAccount,
            })),
          };
          // A revised schedule adds a version without a line on the item.
          const id = current[0]!.scheduleId;
          if (!readSet.some((entry) => entry.kind === 'schedule' && entry.id === id))
            readSet.push({ kind: 'schedule', id, version: String(latest) });
        }
      }
    }
    if (query.history && items.length) {
      const rows = await tx
        .selectDistinct({ itemId: lines.openItemId, entryId: lines.entryId, seq: entries.seq })
        .from(lines)
        .innerJoin(
          entries,
          and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId)),
        )
        .where(
          and(
            eq(lines.companyId, companyId),
            inArray(
              lines.openItemId,
              items.map((item) => item.id),
            ),
          ),
        )
        .orderBy(asc(entries.seq));
      for (const item of items)
        item.history = rows.filter((row) => row.itemId === item.id).map((row) => row.entryId);
    }
    // What opened each item: never changes, so the item's version covers it.
    if (query.origins && items.length) {
      const rows = await tx
        .select({
          itemId: openItems.id,
          treatmentId: proposals.treatmentId,
          subject: proposals.subjectKey,
          date: entries.date,
          tag: sql<string | null>`(select l.item from ${lines} l
            where l.company_id = ${openItems.companyId} and l.entry_id = ${openItems.originEntryId}
              and l.open_item_id = ${openItems.id} order by l.line_no limit 1)`,
        })
        .from(openItems)
        .innerJoin(
          entries,
          and(eq(entries.companyId, openItems.companyId), eq(entries.id, openItems.originEntryId)),
        )
        .innerJoin(
          proposals,
          and(eq(proposals.companyId, entries.companyId), eq(proposals.id, entries.proposalId)),
        )
        .where(
          and(
            eq(openItems.companyId, companyId),
            inArray(
              openItems.id,
              items.map((item) => item.id),
            ),
          ),
        );
      for (const item of items) {
        const row = rows.find((candidate) => candidate.itemId === item.id);
        if (row)
          item.origin = {
            treatmentId: row.treatmentId,
            subject: row.subject,
            date: date(row.date),
            tag: row.tag,
          };
      }
    }
    for (const item of items) {
      const known = itemMap.get(item.id);
      if (!known || item.schedule || item.history || item.origin)
        itemMap.set(item.id, {
          ...item,
          ...(known?.schedule && !item.schedule ? { schedule: known.schedule } : {}),
          ...(known?.history && !item.history ? { history: known.history } : {}),
          ...(known?.origin && !item.origin ? { origin: known.origin } : {}),
        });
    }
  }
  for (const item of [...itemMap.values()].sort((a, b) => (a.id < b.id ? -1 : 1)))
    readSet.push({ kind: 'openItem', id: item.id, version: String(item.movements) });

  const movementMap = new Map<string, MovementRecord>();
  if (plan.movements?.length)
    for (const { movement, account } of await tx
      .select({ movement: bankMovements, account: treasuryAccounts })
      .from(bankMovements)
      .innerJoin(
        treasuryAccounts,
        and(
          eq(treasuryAccounts.companyId, bankMovements.companyId),
          eq(treasuryAccounts.id, bankMovements.treasuryAccountId),
        ),
      )
      .where(and(eq(bankMovements.companyId, companyId), inArray(bankMovements.id, plan.movements)))
      .orderBy(asc(bankMovements.id))) {
      movementMap.set(movement.id, {
        id: movement.id,
        treasuryAccountId: movement.treasuryAccountId,
        ledgerAccount: account.ledgerAccount,
        currency: movement.currency,
        bookingDate: date(movement.bookingDate),
        valueDate: movement.valueDate ? date(movement.valueDate) : null,
        amountMinor: movement.amountMinor,
        reference: movement.reference,
        counterparty: movement.counterparty,
      });
      readSet.push({ kind: 'movement', id: movement.id, version: movement.sourceId });
    }

  const partyMap = new Map<string, PartyRecord>();
  if (plan.parties?.length)
    for (const row of await tx
      .select()
      .from(parties)
      .where(and(eq(parties.companyId, companyId), inArray(parties.id, plan.parties)))
      .orderBy(asc(parties.id))) {
      const record = {
        id: row.id,
        kind: row.kind,
        country: row.country,
        taxId: row.taxId,
        name: row.name,
      };
      partyMap.set(row.id, record);
      readSet.push({ kind: 'party', id: row.id, version: hashOf(record) });
    }

  let profile: ProfileFact[] = [];
  if (plan.profile) {
    profile = (await profileRows(tx, companyId)).map((row) => ({
      axis: row.axis,
      value: row.value,
      effectiveFrom: date(row.effectiveFrom),
    }));
    readSet.push({ kind: 'profile', id: 'company', version: hashOf(profile) });
  }

  const rateMap = new Map<string, FxRate[]>();
  for (const query of plan.fx ?? []) {
    const rows = await tx
      .select()
      .from(fxRates)
      .where(
        and(
          eq(fxRates.source, 'BNR'),
          eq(fxRates.currency, query.currency),
          lte(fxRates.rateDate, query.until),
        ),
      )
      .orderBy(desc(fxRates.rateDate), desc(fxRates.revision))
      .limit(20);
    const latest: FxRate[] = [];
    for (const row of rows)
      if (latest.at(-1)?.date !== row.rateDate)
        latest.push({
          id: `${row.source}/${row.currency}/${row.rateDate}/${row.revision}`,
          source: row.source,
          currency: row.currency,
          date: date(row.rateDate),
          rate: row.rate,
          multiplier: row.multiplier,
        });
    const known = rateMap.get(query.currency) ?? [];
    for (const rate of latest) if (!known.some((item) => item.id === rate.id)) known.push(rate);
    rateMap.set(
      query.currency,
      known.sort((a, b) => (a.date < b.date ? 1 : -1)),
    );
  }
  for (const rates of rateMap.values())
    for (const rate of rates) readSet.push({ kind: 'fx', id: rate.id, version: rate.rate });

  const balances: AccountBalance[] = [];
  if (plan.foreignBalances) {
    const rows = await tx
      .select({
        account: lines.account,
        currency: lines.currency,
        bani: sql<bigint>`sum(${sign} * ${lines.bani})`.mapWith(BigInt),
        minor: sql<bigint>`sum(${sign} * ${lines.currencyMinor})`.mapWith(BigInt),
      })
      .from(lines)
      .innerJoin(
        entries,
        and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId)),
      )
      .innerJoin(
        treasuryAccounts,
        and(
          eq(treasuryAccounts.companyId, lines.companyId),
          eq(treasuryAccounts.ledgerAccount, lines.account),
        ),
      )
      .where(
        and(
          eq(lines.companyId, companyId),
          isNotNull(lines.currency),
          lte(entries.date, plan.foreignBalances.at),
        ),
      )
      .groupBy(lines.account, lines.currency)
      .orderBy(asc(lines.account), asc(lines.currency));
    for (const row of rows) {
      if (row.bani === 0n && row.minor === 0n) continue;
      const balance = {
        account: row.account,
        currency: row.currency!,
        bani: row.bani,
        minor: row.minor,
      };
      balances.push(balance);
      readSet.push({
        kind: 'balance',
        id: `${row.account}/${row.currency}`,
        version: `${row.bani}/${row.minor}`,
      });
    }
  }

  const taxLedger = new Map<string, TaxPeriodLedger>();
  for (const query of plan.taxPeriods ?? []) {
    const key = `${query.tax}|${query.period}`;
    if (taxLedger.has(key)) continue;
    const posted = and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId));
    const taxRows = await tx
      .select({ tax: taxEntries, seq: entries.seq })
      .from(taxEntries)
      .innerJoin(
        entries,
        and(eq(entries.companyId, taxEntries.companyId), eq(entries.id, taxEntries.entryId)),
      )
      .where(
        and(
          eq(taxEntries.companyId, companyId),
          eq(taxEntries.tax, query.tax),
          eq(taxEntries.taxPeriod, query.period),
        ),
      )
      .orderBy(asc(entries.seq), asc(taxEntries.taxNo));
    const settlementRows = await tx
      .select({ line: lines, seq: entries.seq })
      .from(lines)
      .innerJoin(entries, posted)
      .where(
        and(
          eq(lines.companyId, companyId),
          eq(lines.taxSettlementTax, query.tax),
          eq(lines.taxSettlementPeriod, query.period),
        ),
      )
      .orderBy(asc(entries.seq), asc(lines.lineNo));
    taxLedger.set(key, {
      tax: query.tax,
      period: query.period,
      entries: taxRows.map(({ tax, seq }) => ({
        entryId: tax.entryId,
        seq: Number(seq),
        taxNo: Number(tax.taxNo),
        key: tax.key,
        direction: tax.direction,
        code: tax.code,
        baseBani: tax.baseBani,
        taxBani: tax.taxBani,
        deductibleBani: tax.deductibleBani,
        ledgerBani: tax.ledgerBani,
        taxPoint: date(tax.taxPoint),
        exigibility: tax.exigibility ? date(tax.exigibility) : null,
        documentId: tax.documentId,
        partyId: tax.partyId,
        originTaxEntry: tax.originTaxEntry,
        attributes: JSON.parse(tax.attributes) as Record<string, string>,
      })),
      settlements: settlementRows.map(({ line }) => ({
        entryId: line.entryId,
        account: line.account,
        side: line.side,
        bani: line.bani,
      })),
    });
    // The period as a whole: any entry landing in it changes the count or the last sequence.
    const last = Math.max(
      0,
      ...taxRows.map((row) => Number(row.seq)),
      ...settlementRows.map((row) => Number(row.seq)),
    );
    readSet.push({
      kind: 'taxPeriod',
      id: key,
      version: `${taxRows.length}/${settlementRows.length}/${last}`,
    });
  }

  const payrollRunMap = new Map<string, PayrollRunState>();
  for (const id of new Set(plan.payrollRuns ?? [])) {
    const [run] = await tx
      .select()
      .from(payrollRuns)
      .where(and(eq(payrollRuns.companyId, companyId), eq(payrollRuns.id, id)));
    if (!run) continue;
    const [last] = await tx
      .select({ state: payrollRunEvents.state })
      .from(payrollRunEvents)
      .where(and(eq(payrollRunEvents.companyId, companyId), eq(payrollRunEvents.runId, id)))
      .orderBy(desc(payrollRunEvents.seq))
      .limit(1);
    const rows = await tx
      .select()
      .from(payrollLines)
      .where(and(eq(payrollLines.companyId, companyId), eq(payrollLines.runId, id)))
      .orderBy(asc(payrollLines.contractId));
    payrollRunMap.set(id, {
      id,
      month: run.month,
      round: run.round,
      state: last!.state,
      issues: run.issues,
      corrects: run.corrects ?? null,
      lines: rows.map((row) => ({
        contractId: row.contractId,
        employeeId: row.employeeId,
        partyId: row.partyId,
        cash: row.cash,
        vouchers: row.vouchers,
        cas: row.cas,
        cass: row.cass,
        casEmployer: row.casEmployer,
        cassEmployer: row.cassEmployer,
        tax: row.tax,
        unionDues: row.unionDues,
        net: row.net,
        cam: row.cam,
        ...((result) => {
          const steps = result.steps ?? [];
          const step = (code: string) =>
            BigInt(steps.find((item) => item.code === code)?.amount ?? '0');
          return {
            camBase: step('cam.base'),
            sickFund: step('sick.fund'),
            inKind: step('benefits'),
            garnishments: (result.garnishments ?? []).map((item) => ({
              orderId: item.orderId,
              partyId: item.partyId,
              amount: BigInt(item.amount),
            })),
          };
        })(
          JSON.parse(row.result) as {
            steps?: { code: string; amount: string }[];
            garnishments?: { orderId: string; partyId: string; amount: string }[];
          },
        ),
      })),
    });
    readSet.push({ kind: 'payrollRun', id, version: `${run.resultHash}/${last!.state}` });
  }

  const turnover = new Map<string, AccountTurnover[]>();
  for (const query of plan.turnover ?? []) {
    const key = turnoverKey(query);
    if (turnover.has(key)) continue;
    const range = and(
      linesUnder(companyId, query.prefixes),
      gte(entries.date, query.from),
      lte(entries.date, query.to),
    );
    const join = and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId));
    const rows =
      query.sides === 'original'
        ? // A reversal's line on the side of the line it reverses (the same number in the entry its
          // subject names), with its amount negated when it is on the other side (black storno).
          await tx
            .select({
              account: lines.account,
              debit: sql<bigint>`sum(CASE WHEN coalesce(${reversedLine.side}, ${lines.side}) = 'D'
                THEN CASE WHEN ${lines.side} = 'D' THEN ${lines.bani} ELSE -${lines.bani} END
                ELSE 0 END)`.mapWith(BigInt),
              credit: sql<bigint>`sum(CASE WHEN coalesce(${reversedLine.side}, ${lines.side}) = 'C'
                THEN CASE WHEN ${lines.side} = 'C' THEN ${lines.bani} ELSE -${lines.bani} END
                ELSE 0 END)`.mapWith(BigInt),
            })
            .from(lines)
            .innerJoin(entries, join)
            .leftJoin(
              reversal,
              and(
                eq(reversal.companyId, entries.companyId),
                eq(reversal.id, entries.proposalId),
                sql`substr(${reversal.subjectKey}, 1, 8) = 'reverse:'`,
              ),
            )
            .leftJoin(
              reversedLine,
              and(
                eq(reversedLine.companyId, lines.companyId),
                sql`${reversedLine.entryId} = substr(${reversal.subjectKey}, 9)`,
                eq(reversedLine.lineNo, lines.lineNo),
              ),
            )
            .where(range)
            .groupBy(lines.account)
            .orderBy(asc(lines.account))
        : await tx
            .select({
              account: lines.account,
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
            .innerJoin(entries, join)
            .where(range)
            .groupBy(lines.account)
            .orderBy(asc(lines.account));
    const [mark] = await tx
      .select({
        count: sql<number>`count(*)`.mapWith(Number),
        last: sql<number>`COALESCE(max(${entries.seq}), 0)`.mapWith(Number),
      })
      .from(lines)
      .innerJoin(entries, join)
      .where(range);
    turnover.set(key, rows);
    // Any line posted in the range changes the count or the last sequence.
    readSet.push({ kind: 'turnover', id: key, version: `${mark!.count}/${mark!.last}` });
  }

  const itemLineMap = new Map<string, ItemLines[]>();
  if (plan.itemLines) {
    const key = itemLinesKey(plan.itemLines);
    const range = and(linesUnder(companyId, plan.itemLines.prefixes), isNotNull(lines.item));
    const join = and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId));
    const side = (which: 'D' | 'C', column: typeof lines.bani | typeof lines.currencyMinor) =>
      sql<bigint>`sum(CASE WHEN ${lines.side} = ${which} THEN COALESCE(${column}, 0) ELSE 0 END)`.mapWith(
        BigInt,
      );
    const rows = await tx
      .select({
        item: lines.item,
        account: lines.account,
        openItem: lines.openItemId,
        debit: side('D', lines.bani),
        credit: side('C', lines.bani),
        debitMinor: side('D', lines.currencyMinor),
        creditMinor: side('C', lines.currencyMinor),
      })
      .from(lines)
      .innerJoin(entries, join)
      .where(range)
      .groupBy(lines.item, lines.account, lines.openItemId)
      .orderBy(asc(lines.item), asc(lines.account), asc(lines.openItemId));
    const [mark] = await tx
      .select({
        count: sql<number>`count(*)`.mapWith(Number),
        last: sql<number>`COALESCE(max(${entries.seq}), 0)`.mapWith(Number),
      })
      .from(lines)
      .innerJoin(entries, join)
      .where(range);
    itemLineMap.set(
      key,
      rows.map((row) => ({ ...row, item: row.item! })),
    );
    // Any tagged line posted on these accounts changes the count or the last sequence.
    readSet.push({ kind: 'itemLines', id: key, version: `${mark!.count}/${mark!.last}` });
  }

  const assetMap = new Map<string, AssetState>();
  if (plan.assets) {
    const cards = await tx
      .select()
      .from(assets)
      .where(eq(assets.companyId, companyId))
      .orderBy(asc(assets.number));
    const disposals = new Map(
      (
        await tx
          .select({ assetId: assetEvents.assetId, date: assetEvents.date })
          .from(assetEvents)
          .where(and(eq(assetEvents.companyId, companyId), eq(assetEvents.kind, 'disposed')))
      ).map((row) => [row.assetId, row.date]),
    );
    const booked = await tx
      .select({
        item: lines.item,
        account: lines.account,
        bani: sql<bigint>`sum(CASE WHEN ${lines.side} = 'C' THEN ${lines.bani} ELSE -${lines.bani} END)`.mapWith(
          BigInt,
        ),
        count: sql<number>`count(*)`.mapWith(Number),
        last: sql<number>`max(${entries.seq})`.mapWith(Number),
      })
      .from(lines)
      .innerJoin(
        entries,
        and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId)),
      )
      .where(and(linesUnder(companyId, ['28']), isNotNull(lines.item)))
      .groupBy(lines.item, lines.account);
    // Each asset's latest fiscal basis (art. 28): a new version changes what the tax deducts.
    const bases = new Map<string, typeof assetFiscal.$inferSelect>();
    for (const row of await tx
      .select()
      .from(assetFiscal)
      .where(eq(assetFiscal.companyId, companyId))
      .orderBy(asc(assetFiscal.version)))
      bases.set(row.assetId, row);
    let marks = 0;
    let last = 0;
    for (const card of cards) {
      const row = booked.find(
        (item) => item.item === card.id && item.account === card.depreciationAccount,
      );
      marks += row?.count ?? 0;
      last = Math.max(last, row?.last ?? 0);
      const basis = bases.get(card.id);
      assetMap.set(card.id, {
        id: card.id,
        number: card.number,
        name: card.name,
        catalogCode: card.catalogCode,
        account: card.account,
        depreciationAccount: card.depreciationAccount,
        expenseAccount: card.expenseAccount,
        value: card.valueBani,
        lifeMonths: card.lifeMonths,
        commissionedOn: card.commissionedOn as LocalDate,
        disposedOn: (disposals.get(card.id) as LocalDate | undefined) ?? null,
        depreciated: row?.bani ?? 0n,
        fiscal: basis
          ? {
              version: basis.version,
              method: basis.method,
              value: basis.valueBani,
              lifeMonths: basis.lifeMonths,
              firstYearPercent: basis.firstYearPercent,
              m1: basis.m1,
              newAsset: basis.newAsset,
              evidenceId: basis.evidenceId,
            }
          : null,
      });
    }
    // The register and the depreciation booked for it: a new asset, a disposal or a posted
    // depreciation line changes the version.
    readSet.push({
      kind: 'assets',
      id: 'register',
      version: `${cards.length}/${disposals.size}/${marks}/${last}/${[...bases.values()].reduce((sum, item) => sum + item.version, 0)}`,
    });
  }

  // The profit tax's own postings that stand, and the prior-year corrections: their positions
  // are what the next computation starts from (earlier quarters, the years' loss vintages).
  const profitPostings: ProfitPosting[] = [];
  if (plan.profitPostings) {
    const rows = await tx
      .select({
        entryId: entries.id,
        seq: entries.seq,
        date: entries.date,
        treatmentId: proposals.treatmentId,
        subject: proposals.subjectKey,
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
    for (const row of rows) {
      const effect = JSON.parse(row.effect ?? '{}') as {
        explanation?: { details?: { position?: unknown } };
      };
      profitPostings.push({
        entryId: row.entryId,
        treatmentId: row.treatmentId,
        subject: row.subject,
        date: date(row.date),
        seq: Number(row.seq),
        position: (effect.explanation?.details?.position ?? null) as ProfitPosting['position'],
      });
    }
    // Any posting of either, or a reversal of one, changes the count or the last sequence.
    readSet.push({
      kind: 'profitPostings',
      id: 'tax.profit',
      version: `${rows.length}/${rows.at(-1)?.seq ?? 0}`,
    });
  }

  const statusMap = new Map<string, PartyStatus>();
  for (const query of plan.partyStatus ?? []) {
    const key = partyStatusKey(query.partyId, query.date);
    if (readSet.some((entry) => entry.kind === 'partyStatus' && entry.id === key)) continue;
    // The latest snapshot for exactly this date; none is a read too (version 0).
    const [row] = await tx
      .select()
      .from(partyStatuses)
      .where(
        and(
          eq(partyStatuses.companyId, companyId),
          eq(partyStatuses.partyId, query.partyId),
          eq(partyStatuses.asOf, query.date),
        ),
      )
      .orderBy(desc(partyStatuses.seq))
      .limit(1);
    if (row)
      statusMap.set(key, {
        partyId: row.partyId,
        date: date(row.asOf),
        seq: row.seq,
        cui: row.cui,
        name: row.name,
        vatPayer: row.vatPayer,
        cashVat: row.cashVat,
        inactive: row.inactive,
        inactiveSince: row.inactiveSince ? date(row.inactiveSince) : null,
        reactivatedOn: row.reactivatedOn ? date(row.reactivatedOn) : null,
        splitVat: row.splitVat,
        eInvoice: row.eInvoice,
        struckOffOn: row.struckOffOn ? date(row.struckOffOn) : null,
        evidenceId: row.evidenceId,
        checkedAt: row.createdAt,
      });
    readSet.push({ kind: 'partyStatus', id: key, version: String(row?.seq ?? 0) });
  }

  const stock = plan.stock
    ? await loadStock(tx, companyId, plan.stock)
    : { positions: new Map(), items: new Map(), warehouses: new Map(), readSet: [] };
  readSet.push(...stock.readSet);
  const production = plan.production ? await loadProduction(tx, companyId, plan.production) : null;
  if (production) readSet.push(...production.readSet);

  const loaded: Loaded = {
    years,
    evidence: evidenceMap,
    documents: documentMap,
    entries: entryMap,
    openItems: itemMap,
    movements: movementMap,
    parties: partyMap,
    profile,
    fxRates: rateMap,
    balances,
    taxLedger,
    payrollRuns: payrollRunMap,
    turnover,
    itemLines: itemLineMap,
    assets: assetMap,
    profitPostings,
    partyStatus: statusMap,
    // A basis's answers, never a plan's: the proposal adds them (`basisAnswers`).
    answers: new Map(),
    stock: stock.positions,
    stockItems: stock.items,
    warehouses: stock.warehouses,
    ...(production ? { production: production.state } : {}),
  };
  return { loaded, readSet };
}

export async function loadAccounts(tx: Transaction, companyId: string, codes: string[]) {
  const map = new Map<string, AccountInfo>();
  if (codes.length === 0) return map;
  for (const row of await tx
    .select()
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.companyId, companyId), inArray(ledgerAccounts.code, codes))))
    map.set(row.code, {
      code: row.code,
      postable: row.postable,
      controlKind: row.controlKind as ControlKind | null,
      validFrom: date(row.validFrom),
      validTo: row.validTo ? date(row.validTo) : null,
    });
  return map;
}

/** Combines a follow-up read with the first one; entries already loaded keep their first value. */
export function mergeStates(
  first: Awaited<ReturnType<typeof loadState>>,
  second: Awaited<ReturnType<typeof loadState>>,
) {
  const merge = <V>(a: ReadonlyMap<string, V>, b: ReadonlyMap<string, V>) => new Map([...b, ...a]);
  const loaded: Loaded = {
    years: first.loaded.years,
    evidence: merge(first.loaded.evidence, second.loaded.evidence),
    documents: merge(first.loaded.documents, second.loaded.documents),
    entries: merge(first.loaded.entries, second.loaded.entries),
    openItems: merge(first.loaded.openItems, second.loaded.openItems),
    movements: merge(first.loaded.movements, second.loaded.movements),
    parties: merge(first.loaded.parties, second.loaded.parties),
    profile: first.loaded.profile.length ? first.loaded.profile : second.loaded.profile,
    fxRates: merge(first.loaded.fxRates, second.loaded.fxRates),
    balances: first.loaded.balances.length ? first.loaded.balances : second.loaded.balances,
    taxLedger: merge(first.loaded.taxLedger, second.loaded.taxLedger),
    payrollRuns: merge(first.loaded.payrollRuns, second.loaded.payrollRuns),
    turnover: merge(first.loaded.turnover, second.loaded.turnover),
    itemLines: merge(first.loaded.itemLines, second.loaded.itemLines),
    assets: merge(first.loaded.assets, second.loaded.assets),
    profitPostings: first.loaded.profitPostings.length
      ? first.loaded.profitPostings
      : second.loaded.profitPostings,
    partyStatus: merge(first.loaded.partyStatus, second.loaded.partyStatus),
    answers: merge(first.loaded.answers, second.loaded.answers),
    stock: merge(first.loaded.stock, second.loaded.stock),
    stockItems: merge(first.loaded.stockItems, second.loaded.stockItems),
    warehouses: merge(first.loaded.warehouses, second.loaded.warehouses),
    ...((first.loaded.production ?? second.loaded.production)
      ? { production: first.loaded.production ?? second.loaded.production }
      : {}),
  };
  const seen = new Set<string>();
  const readSet = [...first.readSet, ...second.readSet]
    .filter((entry) => {
      const id = `${entry.kind}/${entry.id}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => (a.kind === b.kind ? (a.id < b.id ? -1 : 1) : a.kind < b.kind ? -1 : 1));
  return { loaded, readSet };
}
