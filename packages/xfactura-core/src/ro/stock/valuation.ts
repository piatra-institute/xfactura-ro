import {
  formatQuantity,
  profileAt,
  stockPositionKey,
  type Issue,
  type JsonValue,
  type LineSpec,
  type Loaded,
  type StockDay,
  type StockLayerMethod,
  type StockLayerSpec,
  type StockMoveSpec,
} from '../../kernel';
import { formatMoney } from '../../money';
import { questionIssue } from '../../questions/kinds';
import type { LocalDate } from '../../time';

/*
 * The stock register's valuation (OMFP nr. 1.802/2014, the output methods): what a quantity
 * leaving a position is worth, lot by lot first in, first out, or at the weighted average of the
 * item's pool in the warehouse, recomputed at each receipt or once a period; and the layers and
 * moves an effect posts for it. Pure: a `StockBook` works on the positions a treatment read and
 * the lines it is building, so several receipts and exits in one effect see each other.
 */

/** The company's written accounting policy for its stock, on a date. */
export interface StockPolicy {
  /** `fifo`, `lifo`, `average` (weighted average after each receipt) or `periodic` (the
   * month's weighted average, `stock.periodCost`). */
  method: StockLayerMethod;
  /** Whether a pool's quantity may fall below zero (`policy.stock.negative` allow). */
  negative: boolean;
}

const block = (code: string, message: string, details?: JsonValue): Issue => ({
  code,
  severity: 'block',
  message,
  ...(details === undefined ? {} : { details }),
});

/** The axis of a warehouse's own method, at cost or at retail price, in place of the company's
 * `policy.stock.retail` for that warehouse. */
export const warehouseRetailAxis = (warehouseId: string) => `policy.stock.retail.${warehouseId}`;

/**
 * Whether a warehouse's goods are kept at cost or at their retail price on a date (OMFP nr.
 * 1.802/2014 pct. 286 alin. (8): the retail price method in retail trade, for numerous,
 * fast-moving articles of similar margins): the warehouse's own dated fact, else the company's
 * (`policy.stock.retail`); null when neither is recorded. A shop's warehouse can then be kept at
 * retail price beside a depot at cost, stocks of a different use (pct. 287 alin. (3); a different
 * place alone does not justify it, alin. (4), which the person recording the fact states).
 */
export function retailMethodAt(
  loaded: Loaded,
  warehouseId: string,
  date: LocalDate,
): 'cost' | 'retail' | null {
  const value =
    profileAt(loaded, warehouseRetailAxis(warehouseId), date) ??
    profileAt(loaded, 'policy.stock.retail', date);
  return value === 'cost' || value === 'retail' ? value : null;
}

/**
 * The stock policy recorded for `date`, or the issues asking for it: the output method
 * (`policy.stock.valuation`), the inventory method (`policy.stock.inventory`, which must be the
 * perpetual one for the register), and whether stock may go negative (`policy.stock.negative`).
 * None is assumed. The `warehouses` a treatment moves goods in must be kept at cost: one at
 * retail price is refused (`retailMethodAt`); a treatment over the register as a whole names
 * none, the register holding no warehouse at retail price.
 */
export function stockPolicyAt(
  loaded: Loaded,
  date: LocalDate,
  warehouses: readonly string[] = [],
): StockPolicy | Issue[] {
  const issues: Issue[] = [];
  const ask = (axis: string, message: string) =>
    issues.push(
      questionIssue('POLICY_MISSING', message, {
        kind: 'profile.fact',
        subject: { kind: 'profile', id: axis },
        params: { axis, from: date },
      }),
    );
  const method = profileAt(loaded, 'policy.stock.valuation', date);
  const inventory = profileAt(loaded, 'policy.stock.inventory', date);
  const negative = profileAt(loaded, 'policy.stock.negative', date);
  if (method !== 'fifo' && method !== 'lifo' && method !== 'average' && method !== 'periodic')
    ask(
      'policy.stock.valuation',
      'Înregistrați metoda de evaluare a ieșirilor din gestiune din politicile contabile (FIFO, LIFO sau costul mediu ponderat, după fiecare recepție sau lunar).',
    );
  if (!inventory)
    ask(
      'policy.stock.inventory',
      'Înregistrați metoda de evidență a stocurilor din politicile contabile (inventarul permanent sau intermitent).',
    );
  else if (inventory !== 'permanent')
    issues.push(
      block(
        'STOCK_INTERMITTENT',
        'Cu inventarul intermitent, intrările se înregistrează pe cheltuieli și stocul se stabilește la inventariere: stocul se stabilește la sfârșitul perioadei (stock.intermittent).',
      ),
    );
  // The retail price method (pct. 286 alin. (8): goods at their sale price with VAT, the markup
  // on 378 and the VAT on 4428) keeps a warehouse's goods by value, without quantities (core
  // ro/retail, G2): the register's treatments, by quantity at cost, do not apply to it.
  for (const warehouse of new Set(warehouses))
    if (retailMethodAt(loaded, warehouse, date) === 'retail')
      issues.push(
        block(
          'STOCK_RETAIL_METHOD',
          `Gestiunea ${loaded.warehouses.get(warehouse)?.code ?? warehouse} ține mărfurile la preț cu amănuntul (OMFP 1802/2014 pct. 286 alin. (8)), global-valoric: gestiunea pe articole la cost nu se aplică; folosiți recepția cu retail, rapoartele Z cu goods și retail.discharge, retail.count.`,
          { warehouse },
        ),
      );
  if (negative !== 'allow' && negative !== 'refuse')
    ask(
      'policy.stock.negative',
      'Înregistrați dacă politicile contabile admit stocuri negative temporar (descărcarea înaintea recepției), sau le refuză.',
    );
  if (issues.length) return issues;
  return { method: method as StockLayerMethod, negative: negative === 'allow' };
}

/** `total × part ÷ whole`, rounded half away from zero to the ban. */
export function prorate(total: bigint, part: bigint, whole: bigint): bigint {
  if (whole === 0n) return 0n;
  const negative = (total < 0n !== part < 0n) !== whole < 0n;
  const numerator = (total < 0n ? -total : total) * (part < 0n ? -part : part);
  const denominator = whole < 0n ? -whole : whole;
  const rounded = (2n * numerator + denominator) / (2n * denominator);
  return negative ? -rounded : rounded;
}

/** A layer as the effect being built leaves it. */
interface WorkingLayer {
  id: string;
  item: string;
  warehouse: string;
  account: string;
  method: StockLayerMethod;
  date: LocalDate;
  /** Posting order: existing layers by their entry, new ones after every existing one. */
  order: number;
  mayGoNegative: boolean;
  quantity: bigint;
  bani: bigint;
  /** Its posted moves per day of the months still open, when read (`StockQuery.dated`). */
  days?: readonly StockDay[];
}

/**
 * What a layer holds at the end of `date`, its moves dated later taken off (the effect's own are
 * on its date), and the least it holds from that day on, as its moves dated later leave it. Its
 * whole quantity and value when its days were not read.
 */
function onDate(layer: WorkingLayer, date: LocalDate) {
  const later = (layer.days ?? []).filter((day) => day.date > date);
  let quantity = layer.quantity;
  let bani = layer.bani;
  for (const day of later) {
    quantity -= day.quantity;
    bani -= day.bani;
  }
  let least = quantity;
  let running = quantity;
  for (const day of later) {
    running += day.quantity;
    if (running < least) least = running;
  }
  return { quantity, bani, least };
}

/** What a receipt or an exit concerns. */
export interface StockTarget {
  item: string;
  warehouse: string;
  /** The item's stock account. */
  account: string;
  /** Thousandths of the item's unit, positive. */
  quantity: bigint;
  date: LocalDate;
}

/**
 * The positions an effect moves, and the layers and moves it posts. Receipts create a FIFO lot or
 * add to the item's pool; exits consume lots in order, or the pool at its average. Each move
 * names the effect line it explains; `lines` is the effect's line list, to which a receipt into a
 * negative pool adds the correction of the pool's value.
 */
export class StockBook {
  readonly layers: StockLayerSpec[] = [];
  readonly moves: StockMoveSpec[] = [];
  private readonly positions = new Map<string, WorkingLayer[]>();
  private created = 0;

  constructor(
    private readonly loaded: Loaded,
    private readonly lines: LineSpec[],
    /** Distinguishes the refs of the layers one effect creates. */
    private readonly prefix = 'layer',
    /** The treatment read the whole register: a position it does not hold is empty. */
    private readonly whole = false,
  ) {}

  /** The position's layers, as the effect so far leaves them; null when it was not read. */
  private position(item: string, warehouse: string): WorkingLayer[] | null {
    const key = stockPositionKey(item, warehouse);
    const known = this.positions.get(key);
    if (known) return known;
    const read = this.loaded.stock.get(key);
    if (!read && !this.whole) return null;
    const layers = (read?.layers ?? []).map((layer) => ({ ...layer, order: layer.seq }));
    this.positions.set(key, layers);
    return layers;
  }

  /** What a position holds now: its quantity and value, over every layer. */
  held(item: string, warehouse: string): { quantity: bigint; bani: bigint } | null {
    const layers = this.position(item, warehouse);
    if (!layers) return null;
    return layers.reduce(
      (sum, layer) => ({ quantity: sum.quantity + layer.quantity, bani: sum.bani + layer.bani }),
      { quantity: 0n, bani: 0n },
    );
  }

  private move(layer: WorkingLayer, quantity: bigint, bani: bigint, line: number | undefined) {
    layer.quantity += quantity;
    layer.bani += bani;
    this.moves.push({
      item: layer.item,
      warehouse: layer.warehouse,
      account: layer.account,
      layer: layer.id,
      quantity,
      bani,
      ...(line === undefined ? {} : { line }),
    });
  }

  private newLayer(target: StockTarget, method: StockLayerMethod, mayGoNegative: boolean) {
    const layers = this.position(target.item, target.warehouse)!;
    const ref = `${this.prefix}-${++this.created}`;
    const layer: WorkingLayer = {
      id: ref,
      item: target.item,
      warehouse: target.warehouse,
      account: target.account,
      method,
      date: target.date,
      order: Number.MAX_SAFE_INTEGER - 1_000_000 + this.created,
      mayGoNegative,
      quantity: 0n,
      bani: 0n,
    };
    this.layers.push({
      ref,
      item: layer.item,
      warehouse: layer.warehouse,
      account: layer.account,
      method,
      date: layer.date,
      mayGoNegative,
    });
    layers.push(layer);
    layers.sort((a, b) => (a.date === b.date ? a.order - b.order : a.date < b.date ? -1 : 1));
    return layer;
  }

  /**
   * Goods entering a position at their cost (`bani`, the part of `line` they are): a new lot
   * under FIFO, else into the item's pool (created at its first receipt). A pool that was below
   * zero and comes back to zero or above holds what is left of the receipt at the receipt's unit
   * cost: the units its exits took beyond the stock were valued at an estimate, and they cost what
   * the receipt cost, so the difference is corrected against `expense`, on two new lines. Returns
   * the issues; none when it was recorded.
   */
  receive(
    target: StockTarget,
    bani: bigint,
    line: number | undefined,
    policy: StockPolicy,
    expense?: string,
  ): Issue[] {
    const layers = this.position(target.item, target.warehouse);
    if (!layers)
      return [block('STOCK_POSITION', 'Poziția de stoc nu a fost citită.', { item: target.item })];
    const conflicting = layers.find(
      (layer) => layer.method !== policy.method && (layer.quantity !== 0n || layer.bani !== 0n),
    );
    if (conflicting) return [methodChanged(target, conflicting.method, policy.method)];
    if (policy.method === 'fifo' || policy.method === 'lifo') {
      this.move(this.newLayer(target, policy.method, false), target.quantity, bani, line);
      return [];
    }
    const pool =
      layers.find((layer) => layer.method === policy.method && layer.account === target.account) ??
      this.newLayer(target, policy.method, policy.negative);
    const before = pool.quantity;
    this.move(pool, target.quantity, bani, line);
    // A pool that went negative and is filled again: its exits beyond the stock were valued at an
    // estimate, which the receipt's cost now corrects, so that what is left holds the receipt's
    // unit cost (no value without a quantity, when nothing is left).
    const held =
      before < 0n && pool.quantity >= 0n
        ? pool.quantity === 0n
          ? 0n
          : prorate(bani, pool.quantity, target.quantity)
        : pool.bani;
    if (held !== pool.bani) {
      if (!expense)
        return [
          block(
            'STOCK_CORRECTION',
            'Recepția acoperă un stoc negativ, iar corecția valorii ieșirilor lui nu are un cont de cheltuieli.',
          ),
        ];
      const correction = held - pool.bani;
      const debit = correction > 0n;
      const amount = debit ? correction : -correction;
      this.lines.push(
        {
          account: debit ? target.account : expense,
          side: 'D',
          bani: amount,
          memo: 'Corecția stocului negativ',
        },
        {
          account: debit ? expense : target.account,
          side: 'C',
          bani: amount,
          memo: 'Corecția stocului negativ',
        },
      );
      this.move(pool, 0n, correction, this.lines.length - (debit ? 2 : 1));
    }
    return [];
  }

  /**
   * Goods leaving a position, valued by the policy: FIFO from the oldest lot received on or
   * before the date, LIFO from the newest, or at the pool's average on the date (under the
   * periodic average, the running one until the month's costing). An exit dated before moves
   * already posted (an invoice booked after a later receipt) takes what the position held on its
   * date, at that date's average, and no more than it holds on every later day, so that none
   * goes below zero; a pool `policy.stock.negative` allows below zero takes the rest at the
   * average it holds now. Returns the value taken (positive) or the issues.
   */
  issue(
    target: StockTarget,
    line: number | undefined,
    policy: StockPolicy,
  ): { bani: bigint } | { issues: Issue[] } {
    const layers = this.position(target.item, target.warehouse);
    if (!layers)
      return {
        issues: [
          block('STOCK_POSITION', 'Poziția de stoc nu a fost citită.', { item: target.item }),
        ],
      };
    const conflicting = layers.find(
      (layer) => layer.method !== policy.method && (layer.quantity !== 0n || layer.bani !== 0n),
    );
    if (conflicting) return { issues: [methodChanged(target, conflicting.method, policy.method)] };
    const lots = policy.method === 'fifo' || policy.method === 'lifo';
    const pool = lots
      ? undefined
      : layers.find((layer) => layer.method === policy.method && layer.account === target.account);
    // What can leave each lot on the date: the least it holds from then on.
    const room = (layer: WorkingLayer) => {
      if (layer.date > target.date) return 0n;
      const least = onDate(layer, target.date).least;
      return least > 0n ? least : 0n;
    };
    const at = pool && pool.date <= target.date ? onDate(pool, target.date) : null;
    const available = lots
      ? layers
          .filter((layer) => layer.method === policy.method)
          .reduce((sum, layer) => sum + room(layer), 0n)
      : at && at.least > 0n
        ? at.least
        : 0n;
    const short = () =>
      block(
        'STOCK_INSUFFICIENT',
        `Gestiunea nu are cantitatea cerută la ${target.date}: ${formatQuantity(available)} disponibil, ${formatQuantity(target.quantity)} cerut.`,
        {
          item: target.item,
          warehouse: target.warehouse,
          available: formatQuantity(available),
          requested: formatQuantity(target.quantity),
        },
      );
    if (lots) {
      if (available < target.quantity) return { issues: [short()] };
      let remaining = target.quantity;
      let total = 0n;
      // FIFO from the first lot, LIFO from the last one received on or before the date.
      for (const lot of policy.method === 'fifo' ? layers : [...layers].reverse()) {
        if (remaining === 0n) break;
        if (lot.method !== policy.method) continue;
        const free = room(lot);
        if (free === 0n) continue;
        const taken = remaining < free ? remaining : free;
        const value = taken === lot.quantity ? lot.bani : prorate(lot.bani, taken, lot.quantity);
        this.move(lot, -taken, -value, line);
        total += value;
        remaining -= taken;
      }
      return { bani: total };
    }
    const covered = at !== null && at.least >= target.quantity;
    if (!pool || (!covered && !pool.mayGoNegative)) return { issues: [short()] };
    // Covered on its date, at that date's average; beyond the stock (a pool allowed below zero),
    // at the average the pool holds now, which the receipts dated after the exit make. The
    // periodic average values an exit at the running average until the month's costing
    // (`stock.periodCost`) brings the month's exits to its weighted average.
    const basis = covered ? at : { quantity: pool.quantity, bani: pool.bani };
    if (basis.quantity <= 0n)
      return {
        issues: [
          block(
            'STOCK_COST_UNKNOWN',
            'Stocul este zero sau negativ: costul mediu al ieșirii nu se poate stabili până la o recepție.',
            { item: target.item, warehouse: target.warehouse },
          ),
        ],
      };
    const value =
      target.quantity === basis.quantity
        ? basis.bani
        : prorate(basis.bani, target.quantity, basis.quantity);
    this.move(pool, -target.quantity, -value, line);
    return { bani: value };
  }

  /**
   * Goods leaving one warehouse for another on the same account, at the value they leave at:
   * FIFO lots keep their receipt dates in the warehouse they enter. Moves without a line.
   */
  transfer(
    target: StockTarget,
    to: string,
    policy: StockPolicy,
  ): { bani: bigint } | { issues: Issue[] } {
    if (policy.method === 'periodic')
      return {
        issues: [
          block(
            'STOCK_TRANSFER_PERIODIC',
            'Cu costul mediu calculat lunar, transferul între gestiuni se evaluează abia la sfârșitul lunii: nu este acoperit.',
          ),
        ],
      };
    const before = this.moves.length;
    const out = this.issue(target, undefined, policy);
    if ('issues' in out) return out;
    const destination = this.position(target.item, to);
    if (!destination)
      return {
        issues: [
          block('STOCK_POSITION', 'Poziția de stoc nu a fost citită.', { item: target.item }),
        ],
      };
    for (const consumed of this.moves.slice(before)) {
      const lot = this.position(target.item, target.warehouse)!.find(
        (layer) => layer.id === consumed.layer,
      )!;
      const entering = { ...target, warehouse: to, quantity: -consumed.quantity, date: lot.date };
      const issues = this.receive(entering, -consumed.bani, undefined, policy);
      if (issues.length) return { issues };
    }
    return out;
  }

  /**
   * Goods given back to their supplier at the value its credit note states (`bani`, signed as the
   * line: negative), out of `lots` (FIFO, LIFO: those the original invoice created) or the item's
   * pool. Without a quantity, the value corrects the cost of what is still held. A lot or pool
   * emptied with a value left over gives the rest to `expense`, on two new lines.
   */
  giveBack(
    target: StockTarget,
    bani: bigint,
    line: number,
    policy: StockPolicy,
    lots: readonly string[] | null,
    expense?: string,
  ): Issue[] {
    const layers = this.position(target.item, target.warehouse);
    if (!layers)
      return [block('STOCK_POSITION', 'Poziția de stoc nu a fost citită.', { item: target.item })];
    const sources = (
      lots
        ? layers.filter((layer) => lots.includes(layer.id))
        : layers.filter(
            (layer) => layer.method === policy.method && layer.account === target.account,
          )
    ).filter((layer) => layer.quantity > 0n);
    const held = sources.reduce((sum, layer) => sum + layer.quantity, 0n);
    if (!sources.length || held < target.quantity)
      return [
        block(
          target.quantity === 0n ? 'STOCK_REVALUE_EMPTY' : 'STOCK_RETURN_CONSUMED',
          target.quantity === 0n
            ? 'Reducerea privește bunuri care nu mai sunt în gestiune: înregistrați-o în 609 (reduceri comerciale primite care nu corectează costul stocurilor).'
            : 'Bunurile returnate furnizorului nu mai sunt în lotul recepționat cu factura inițială.',
          { item: target.item },
        ),
      ];
    // How much each source gives: the quantity in order, or, for a price, by what each holds.
    const takes: { layer: WorkingLayer; quantity: bigint; weight: bigint }[] = [];
    let remaining = target.quantity;
    for (const layer of sources) {
      if (target.quantity === 0n) {
        takes.push({ layer, quantity: 0n, weight: layer.quantity });
        continue;
      }
      if (remaining === 0n) break;
      const taken = remaining < layer.quantity ? remaining : layer.quantity;
      takes.push({ layer, quantity: taken, weight: taken });
      remaining -= taken;
    }
    const weights = takes.map((take) => take.weight);
    const total = weights.reduce((sum, weight) => sum + weight, 0n);
    let given = 0n;
    takes.forEach((take, index) => {
      const share = index === takes.length - 1 ? bani - given : prorate(bani, take.weight, total);
      given += share;
      this.move(take.layer, -take.quantity, share, line);
      if (take.layer.quantity === 0n && take.layer.bani !== 0n && expense) {
        const rest = take.layer.bani;
        this.lines.push(
          { account: expense, side: 'D', bani: rest, memo: 'Diferența lotului returnat' },
          {
            account: take.layer.account,
            side: 'C',
            bani: rest,
            memo: 'Diferența lotului returnat',
          },
        );
        this.move(take.layer, 0n, -rest, this.lines.length - 1);
      }
    });
    return [];
  }

  /** A value-only move on the item's pool or newest lot (a price difference on goods still
   * held): `bani` signed, part of `line`. */
  revalue(target: StockTarget, bani: bigint, line: number): Issue[] {
    const layers = this.position(target.item, target.warehouse);
    const held = layers?.filter((layer) => layer.quantity > 0n) ?? [];
    const layer = held.at(-1);
    if (!layer)
      return [
        block(
          'STOCK_REVALUE_EMPTY',
          'Diferența de preț privește bunuri care nu mai sunt în gestiune.',
          { item: target.item },
        ),
      ];
    this.move(layer, 0n, bani, line);
    return [];
  }

  /** The effect's stock part: none when nothing moved, so the effect stays effect@1. */
  effectPart():
    | { schema: 'effect@1' }
    | {
        schema: 'effect@2';
        stockLayers: StockLayerSpec[];
        stockMoves: StockMoveSpec[];
      } {
    return this.moves.length
      ? { schema: 'effect@2', stockLayers: this.layers, stockMoves: this.moves }
      : { schema: 'effect@1' };
  }
}

function methodChanged(target: StockTarget, held: StockLayerMethod, policy: StockLayerMethod) {
  return block(
    'STOCK_METHOD_CHANGED',
    `Articolul este ținut în gestiune după metoda ${held}, iar politica contabilă la ${target.date} este ${policy}: schimbarea metodei de evaluare (cu efectele ei) nu este acoperită.`,
    { item: target.item, warehouse: target.warehouse },
  );
}

/** A quantity and value as people read them. */
export const showStock = (quantity: bigint, bani: bigint, unit: string) =>
  `${formatQuantity(quantity)} ${unit}, ${formatMoney(bani, 'RON')} lei`;
