import { allocate, divRound } from '../../money';

/*
 * Production's arithmetic (G4), pure: the share of a month's labour and overheads each work order
 * takes, the fixed overheads absorbed at normal capacity, and the price differences' coefficient.
 * Amounts are bani, quantities and hours thousandths; every split is a largest-remainder split, so
 * its parts add up to what is split.
 */

/** `total × part ÷ whole`, half away from zero; 0 when `whole` is 0. */
export const share = (total: bigint, part: bigint, whole: bigint) =>
  whole === 0n ? 0n : divRound(total * part, whole, 'halfAwayFromZero');

/** `total` split over the weights, with what no weight takes; nothing split without a weight. */
export function split(
  total: bigint,
  weights: readonly { id: string; weight: bigint }[],
  rest = 0n,
): { parts: Map<string, bigint>; rest: bigint } {
  const parts = new Map<string, bigint>();
  const all = [...weights.map((row) => row.weight), rest];
  if (total === 0n || all.every((weight) => weight === 0n)) return { parts, rest: total };
  const pieces = allocate(total, all);
  weights.forEach((row, index) => {
    if (pieces[index] !== 0n) parts.set(row.id, (parts.get(row.id) ?? 0n) + pieces[index]!);
  });
  return { parts, rest: pieces.at(-1)! };
}

/** One contract's labour of the month: its cost, the hours it worked and those on each order. */
export interface ContractLabour {
  contractId: string;
  cost: bigint;
  hours: bigint;
  orders: readonly { orderId: string; hours: bigint }[];
}

/**
 * Direct labour by the hours worked on each order (the timesheet): each contract's cost of the
 * month split by its hours, the hours on no order staying an expense of the period.
 */
export function labourByHours(contracts: readonly ContractLabour[]) {
  const byOrder = new Map<string, bigint>();
  const hours = new Map<string, bigint>();
  let unallocated = 0n;
  for (const contract of contracts) {
    const onOrders = contract.orders.reduce((sum, row) => sum + row.hours, 0n);
    const { parts, rest } = split(
      contract.cost,
      contract.orders.map((row) => ({ id: row.orderId, weight: row.hours })),
      contract.hours - onOrders,
    );
    for (const [orderId, part] of parts) byOrder.set(orderId, (byOrder.get(orderId) ?? 0n) + part);
    for (const row of contract.orders)
      hours.set(row.orderId, (hours.get(row.orderId) ?? 0n) + row.hours);
    unallocated += rest;
  }
  return { byOrder, hours, unallocated };
}

/** A key stated in hundredths of a percent per order (`12.50` → 1250): the pool split by it, the
 * percent no order takes staying an expense of the period. */
export function labourByShares(
  pool: bigint,
  shares: readonly { orderId: string; basis: bigint }[],
) {
  const taken = shares.reduce((sum, row) => sum + row.basis, 0n);
  const { parts, rest } = split(
    pool,
    shares.map((row) => ({ id: row.orderId, weight: row.basis })),
    10_000n - taken,
  );
  return { byOrder: parts, unallocated: rest };
}

/** A pool of production overheads: fixed ones at normal capacity, variable ones in full. */
export interface OverheadPool {
  amount: bigint;
  behaviour: 'fixed' | 'variable';
  /** For fixed overheads: the normal capacity in the key's units, or the actual level when it
   * approximates the normal one (pct. 8 pct. 7). */
  capacity?: { normal: bigint } | { approximates: true };
}

/**
 * What a pool's orders absorb (OMFP nr. 1.802/2014 pct. 8 pct. 7): variable overheads on the
 * actual use, in full; fixed ones at the rate of normal capacity, so that a month below it leaves
 * the rest an expense of the period and a month above it does not value the products above their
 * cost (the whole pool, no more). `activity` is the key's total on the orders.
 */
export function absorbed(pool: OverheadPool, activity: bigint): bigint {
  if (pool.amount <= 0n || activity <= 0n) return 0n;
  if (pool.behaviour === 'variable') return pool.amount;
  if (!pool.capacity) throw new Error('A fixed pool needs its capacity.');
  if ('approximates' in pool.capacity) return pool.amount;
  const normal = pool.capacity.normal;
  return activity >= normal ? pool.amount : share(pool.amount, activity, normal);
}

/** The pool's absorbed part split over the orders by their key, and what stays an expense. */
export function allocateOverhead(
  pool: OverheadPool,
  weights: readonly { id: string; weight: bigint }[],
) {
  const activity = weights.reduce((sum, row) => sum + row.weight, 0n);
  const taken = absorbed(pool, activity);
  const { parts } = split(taken, weights);
  return { parts, absorbed: taken, unallocated: pool.amount - taken, activity };
}

/**
 * The price differences on the exits (pct. 286 alin. (4), (7)): the coefficient is the
 * differences' opening balance with those of the entries over the stock's opening balance with the
 * entries, at registration price; it applies to the exits at registration price. Cumulated from
 * the year's start, what earlier months of the year took is deducted, so that the differences
 * follow the goods exactly: when the stock is gone, so are its differences.
 */
export function differencesOnExits(figures: {
  differences: { opening: bigint; entered: bigint };
  stock: { opening: bigint; entered: bigint };
  exits: bigint;
  /** What earlier months of the same cumulation took (0 for a month's own coefficient). */
  taken: bigint;
}): { share: bigint; numerator: bigint; denominator: bigint } | null {
  const numerator = figures.differences.opening + figures.differences.entered;
  const denominator = figures.stock.opening + figures.stock.entered;
  if (denominator <= 0n) return null;
  return {
    share: share(numerator, figures.exits, denominator) - figures.taken,
    numerator,
    denominator,
  };
}
