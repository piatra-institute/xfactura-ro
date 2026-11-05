import { formatQuantity, parseQuantity, type Loaded } from '../../kernel';
import { formatMoney, parseMoney } from '../../money';
import type { LocalDate } from '../../time';

/*
 * The stock found at a count against the register (OMF nr. 2.861/2009 pct. 35): each item in each
 * warehouse as the lists counted it (by its catalogue code and the warehouse's code) and as the
 * register holds it on the count's date. Pure: the year-end's comparison and `inventory.stock`
 * read it alike.
 */

/** An item in a warehouse as the register holds it on a date. */
export interface RegisterPosition {
  item: string;
  code: string;
  name: string;
  unit: string;
  account: string;
  warehouse: string;
  warehouseCode: string;
  /** Thousandths of the unit. */
  quantity: bigint;
  bani: bigint;
}

/** A row of an inventory list's stock section. */
export interface CountedRow {
  account: string;
  code: string;
  name: string;
  unit: string;
  quantity: string;
  /** The warehouse's code; required once the company keeps the register. */
  warehouse?: string | undefined;
  /** The commission's value (a surplus's fair value, OMFP 1802/2014 pct. 75 alin. (1)). */
  value?: string | undefined;
}

export interface StockDifference {
  item: string;
  code: string;
  account: string;
  warehouse: string;
  warehouseCode: string;
  unit: string;
  /** What the register holds and what was counted, in thousandths. */
  book: bigint;
  counted: bigint;
  /** The register's value of the position. */
  bani: bigint;
  /** The list's value of the row, when it states one. */
  value: bigint | null;
}

export interface StockComparison {
  differences: StockDifference[];
  /** Positions the lists leave out (pct. 2, 18). */
  gaps: string[];
  /** Rows the register cannot place: an unknown code or warehouse, a missing warehouse, a row
   * listed twice. */
  problems: string[];
}

/** The register's positions on `date`, from positions read with `flows` starting the next day
 * (their `opening`), or their current balances without. */
export function registerAt(loaded: Loaded): RegisterPosition[] {
  const positions: RegisterPosition[] = [];
  for (const position of loaded.stock.values()) {
    const item = loaded.stockItems.get(position.item);
    const warehouse = loaded.warehouses.get(position.warehouse);
    if (!item || !warehouse) continue;
    let quantity = 0n;
    let bani = 0n;
    for (const layer of position.layers) {
      quantity += layer.flows ? layer.flows.opening.quantity : layer.quantity;
      bani += layer.flows ? layer.flows.opening.bani : layer.bani;
    }
    if (quantity === 0n && bani === 0n) continue;
    positions.push({
      item: item.id,
      code: item.code,
      name: item.name,
      unit: item.unit,
      account: item.account,
      warehouse: warehouse.id,
      warehouseCode: warehouse.code,
      quantity,
      bani,
    });
  }
  return positions.sort((a, b) =>
    a.code === b.code ? (a.warehouseCode < b.warehouseCode ? -1 : 1) : a.code < b.code ? -1 : 1,
  );
}

/** The day after a date, as `flows` starts a read of the register on `date`. */
export const nextDay = (date: LocalDate) => {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10) as LocalDate;
};

/** Compares the counted rows with the register's positions. */
export function compareStock(
  rows: readonly CountedRow[],
  positions: readonly RegisterPosition[],
  catalogue: {
    items: ReadonlyMap<string, { id: string; account: string; unit: string }>;
    warehouses: ReadonlyMap<string, string>;
  },
): StockComparison {
  const differences: StockDifference[] = [];
  const gaps: string[] = [];
  const problems: string[] = [];
  const counted = new Map<string, { row: CountedRow; quantity: bigint }>();
  rows.forEach((row, index) => {
    const label = `Rândul de stoc ${index + 1} (${row.code})`;
    const item = catalogue.items.get(row.code);
    if (!item) return void problems.push(`${label}: articolul nu este în nomenclator.`);
    if (!row.warehouse) return void problems.push(`${label}: lista nu indică gestiunea.`);
    const warehouse = catalogue.warehouses.get(row.warehouse);
    if (!warehouse) return void problems.push(`${label}: gestiunea ${row.warehouse} nu există.`);
    if (row.unit !== item.unit)
      return void problems.push(
        `${label}: lista numără în ${row.unit}, articolul se ține în ${item.unit}.`,
      );
    const quantity = parseQuantity(row.quantity);
    if (quantity === null)
      return void problems.push(`${label}: cantitatea are mai mult de trei zecimale.`);
    const key = `${item.id}|${warehouse}`;
    if (counted.has(key))
      return void problems.push(`${label}: articolul este listat de două ori în gestiune.`);
    counted.set(key, { row, quantity });
  });
  const byKey = new Map(
    positions.map((position) => [`${position.item}|${position.warehouse}`, position]),
  );
  for (const position of positions) {
    const found = counted.get(`${position.item}|${position.warehouse}`);
    if (!found) {
      gaps.push(
        `Articolul ${position.code} ${position.name} din gestiunea ${position.warehouseCode} (${formatQuantity(position.quantity)} ${position.unit}, ${formatMoney(position.bani, 'RON')} lei) nu apare în listele de inventariere.`,
      );
      continue;
    }
    if (found.quantity !== position.quantity)
      differences.push({
        item: position.item,
        code: position.code,
        account: position.account,
        warehouse: position.warehouse,
        warehouseCode: position.warehouseCode,
        unit: position.unit,
        book: position.quantity,
        counted: found.quantity,
        bani: position.bani,
        value: found.row.value === undefined ? null : parseMoney(found.row.value, 'RON'),
      });
  }
  // Counted where the register holds nothing: a surplus.
  for (const [key, found] of counted) {
    if (byKey.has(key) || found.quantity === 0n) continue;
    const [itemId, warehouseId] = key.split('|') as [string, string];
    const item = [...catalogue.items.values()].find((candidate) => candidate.id === itemId)!;
    differences.push({
      item: itemId,
      code: found.row.code,
      account: item.account,
      warehouse: warehouseId,
      warehouseCode: found.row.warehouse!,
      unit: item.unit,
      book: 0n,
      counted: found.quantity,
      bani: 0n,
      value: found.row.value === undefined ? null : parseMoney(found.row.value, 'RON'),
    });
  }
  // In the catalogue's order, then the warehouses': the booking reads the same whatever ids.
  differences.sort((a, b) =>
    a.code === b.code ? (a.warehouseCode < b.warehouseCode ? -1 : 1) : a.code < b.code ? -1 : 1,
  );
  return { differences, gaps, problems };
}
