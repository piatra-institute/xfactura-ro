import { hashOf } from '../../hash';
import type { JsonValue } from '../../kernel';

/*
 * The year's close and the next year's opening (Y1): the itemized closing snapshot a reviewed
 * year close records (`years.close`), and the check that the next year opens with exactly it.
 * The ledger is continuous, so the opening of a year whose previous year the books keep is that
 * year's closing; the snapshot is what proves it stayed so, per account and currency, per open
 * item (the partners' balances D406 and the inventory register report) and per fixed asset (its
 * value, the depreciation and impairment held, its fiscal basis), with the balances carried into
 * the next year's computations (the loss vintages, the definitive pro-rata).
 */

export interface SnapshotAccount {
  account: string;
  currency: string;
  /** Debit less credit, in lei and in the currency's minor units, as decimal strings. */
  bani: string;
  minor: string;
}
export interface SnapshotItem {
  id: string;
  account: string;
  partyId: string;
  currency: string;
  bani: string;
  minor: string;
}
export interface SnapshotAsset {
  id: string;
  number: string;
  account: string;
  value: string;
  depreciated: string;
  impaired: string;
  /** Its fiscal basis' version at the close, or null: recorded, not compared at the opening. */
  fiscal: number | null;
}
export interface ClosingSnapshot {
  yearEnd: string;
  accounts: SnapshotAccount[];
  items: SnapshotItem[];
  assets: SnapshotAsset[];
  /** What the next year's computations carry: the loss vintages after the year's profit tax,
   * the year's definitive pro-rata, the capital goods in their adjustment period. */
  carried: { [key: string]: JsonValue };
}

export interface SnapshotDifference {
  section: 'accounts' | 'items' | 'assets' | 'carried';
  id: string;
  closing: JsonValue;
  opening: JsonValue;
}

/** The snapshot in its canonical order, so equal books hash alike. */
export function canonicalSnapshot(snapshot: ClosingSnapshot): ClosingSnapshot {
  const by =
    <T>(key: (row: T) => string) =>
    (a: T, b: T) =>
      key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
  return {
    yearEnd: snapshot.yearEnd,
    accounts: [...snapshot.accounts].sort(by((row) => `${row.account}/${row.currency}`)),
    items: [...snapshot.items].sort(by((row) => row.id)),
    assets: [...snapshot.assets].sort(by((row) => row.id)),
    carried: snapshot.carried,
  };
}

export const snapshotHash = (snapshot: ClosingSnapshot) =>
  hashOf(canonicalSnapshot(snapshot) as unknown as JsonValue);

/** Every row of one snapshot that differs from the other's, by section and id. */
export function snapshotDifferences(
  closing: ClosingSnapshot,
  opening: ClosingSnapshot,
): SnapshotDifference[] {
  const differences: SnapshotDifference[] = [];
  const section = <T extends object>(
    name: SnapshotDifference['section'],
    before: readonly T[],
    after: readonly T[],
    key: (row: T) => string,
  ) => {
    const left = new Map(before.map((row) => [key(row), row]));
    const right = new Map(after.map((row) => [key(row), row]));
    for (const id of [...new Set([...left.keys(), ...right.keys()])].sort()) {
      const a = left.get(id) ?? null;
      const b = right.get(id) ?? null;
      if (hashOf(a as unknown as JsonValue) !== hashOf(b as unknown as JsonValue))
        differences.push({
          section: name,
          id,
          closing: a as unknown as JsonValue,
          opening: b as unknown as JsonValue,
        });
    }
  };
  section(
    'accounts',
    closing.accounts,
    opening.accounts,
    (row) => `${row.account}/${row.currency}`,
  );
  section('items', closing.items, opening.items, (row) => row.id);
  // An asset's fiscal basis is recorded, not compared: a version recorded since is the basis of
  // the computations after it (Codul fiscal art. 28), which the closed year's are not, and nothing
  // the next year opens with changes. The register's cards and disposals of a locked year do not
  // change (`assets.register` and `assets.dispose` refuse them), nor its tagged lines.
  const held = ({ fiscal: _, ...asset }: SnapshotAsset) => asset;
  section('assets', closing.assets.map(held), opening.assets.map(held), (row) => row.id);
  for (const key of [
    ...new Set([...Object.keys(closing.carried), ...Object.keys(opening.carried)]),
  ].sort()) {
    const a = closing.carried[key] ?? null;
    const b = opening.carried[key] ?? null;
    if (hashOf(a) !== hashOf(b))
      differences.push({ section: 'carried', id: key, closing: a, opening: b });
  }
  return differences;
}
