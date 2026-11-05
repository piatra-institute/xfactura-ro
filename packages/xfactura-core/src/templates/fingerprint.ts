import { hashOf } from '../hash';

/** An effect as its ledger rows and tax entries show it: bigint amounts, or their stored text. */
type Amount = bigint | string;
export type FingerprintEffect = {
  lines: {
    account: string;
    side: 'D' | 'C';
    bani: Amount;
    currency?: { code: string; minor: Amount } | undefined;
    openItem?: string | undefined;
  }[];
  openItems: { ref: string }[];
  taxEntries: {
    tax: string;
    code: string;
    direction: string;
    baseBani: Amount;
    taxBani: Amount;
    deductibleBani: Amount;
  }[];
  schedules: { method: string; rows: { due: string; bani: Amount; counterAccount: string }[] }[];
  /** effect@2: the stock moves, by item, warehouse and account; an effect without them
   * fingerprints as before. */
  stockMoves?:
    | { item: string; warehouse: string; account: string; quantity: Amount; bani: Amount }[]
    | undefined;
};

const text = (value: Amount) => (typeof value === 'bigint' ? value.toString() : value);
const sorted = (rows: string[][]) =>
  rows.map((row) => JSON.stringify(row)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * What an effect books, without the ids it creates: each line's account, side, amount and
 * currency, and the existing open item it settles; each tax entry's tax, code, direction, base,
 * tax and deductible part; each schedule's method and rows. Two evaluations of the same booking
 * for different proposals share it, so a template's prediction compares with what was posted.
 */
export function effectFingerprint(effect: FingerprintEffect): string {
  const created = new Set(effect.openItems.map((item) => item.ref));
  return hashOf({
    lines: sorted(
      effect.lines.map((line) => [
        line.account,
        line.side,
        text(line.bani),
        line.currency?.code ?? '',
        line.currency ? text(line.currency.minor) : '',
        line.openItem && !created.has(line.openItem) ? line.openItem : '',
      ]),
    ),
    taxes: sorted(
      effect.taxEntries.map((entry) => [
        entry.tax,
        entry.code,
        entry.direction,
        text(entry.baseBani),
        text(entry.taxBani),
        text(entry.deductibleBani),
      ]),
    ),
    schedules: sorted(
      effect.schedules.map((schedule) => [
        schedule.method,
        ...schedule.rows.map((row) => `${row.due}/${text(row.bani)}/${row.counterAccount}`),
      ]),
    ),
    ...(effect.stockMoves?.length
      ? {
          stock: sorted(
            effect.stockMoves.map((move) => [
              move.item,
              move.warehouse,
              move.account,
              text(move.quantity),
              text(move.bani),
            ]),
          ),
        }
      : {}),
  });
}

/** What an effect moves: its debits in lei (a red storno on the credit side counts as one). */
export function effectAmount(effect: Pick<FingerprintEffect, 'lines'>): bigint {
  let total = 0n;
  for (const line of effect.lines) {
    const bani = BigInt(line.bani);
    if ((line.side === 'D' && bani > 0n) || (line.side === 'C' && bani < 0n))
      total += bani < 0n ? -bani : bani;
  }
  return total;
}

/** The partners an effect books: on its lines, the open items it creates and its tax entries. */
export function effectParties(effect: {
  lines: { partyId?: string | undefined }[];
  openItems: { partyId: string }[];
  taxEntries: { partyId?: string | undefined }[];
}): string[] {
  return [
    ...new Set([
      ...effect.lines.flatMap((line) => (line.partyId ? [line.partyId] : [])),
      ...effect.openItems.map((item) => item.partyId),
      ...effect.taxEntries.flatMap((entry) => (entry.partyId ? [entry.partyId] : [])),
    ]),
  ].sort();
}
