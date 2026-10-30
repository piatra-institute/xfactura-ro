import type { Side } from '../../kernel';
import { allocate, divRound } from '../../money';
import type { LocalDate } from '../../time';
import { classify, natureOf, type NatureCatalogue, type NatureCode } from './natures';

/**
 * The Registrul-jurnal de încasări și plăți (OMFP nr. 170/2015, cod 14-1-1/b) as a projection of
 * the internal double-entry ledger: one row per posted line on a treasury account (5121, 5124,
 * 5311, 5314 and their analytics), at the document amount including VAT, cash and bank, receipts
 * and payments. Each row carries the nature of what it settles:
 *
 * - a line settling an invoice (an open item with a document) takes the nature of the invoice's
 *   booked accounts, pro rata to the part settled, net and VAT apart; the invoice's credit notes
 *   are part of it;
 * - a realized exchange difference in the same entry is folded into what it settled, since the
 *   cash basis measures income and expense at the rate of the receipt or payment;
 * - an item without a document (an advance on 542, the owner's account, payroll liabilities) takes
 *   the nature of its control account, and a line without an item the nature of its account;
 * - treasury lines of one entry on opposite sides are a transfer between own accounts, for what
 *   they offset.
 *
 * Partial payments are allocated pro rata to the invoice's composition: an open question for the
 * expert contabil (docs/PFA_II_IF.md §5, question 4).
 */

/** The synthetic accounts whose lines are receipts and payments. */
export const treasuryAccounts = ['5121', '5124', '5311', '5314'] as const;
export const isTreasury = (account: string) =>
  (treasuryAccounts as readonly string[]).includes(account.split('.')[0]!);
export const channelOf = (account: string): 'cash' | 'bank' =>
  account.startsWith('531') ? 'cash' : 'bank';
/** The journals of invoice recognitions and credit notes: what they book on an invoice's open
 * item is its composition. */
export const chargeJournals = ['VANZARI', 'CUMPARARI'] as const;

export interface LedgerLine {
  lineNo: number;
  account: string;
  side: Side;
  /** Signed as booked: a negative amount is a red storno on its side. */
  bani: bigint;
  openItem: string | null;
  memo: string | null;
  currency: { code: string; minor: bigint; rate: string } | null;
}

export interface LedgerEntry {
  id: string;
  seq: number;
  date: LocalDate;
  journalCode: string;
  description: string;
  lines: readonly LedgerLine[];
}

export interface LedgerItem {
  id: string;
  controlAccount: string;
  documentId: string | null;
}

export interface NaturePart {
  nature: NatureCode;
  /** The account the nature was read from. */
  account: string;
  /** Money in positive, money out negative. */
  flow: bigint;
}

export interface JournalRow {
  entryId: string;
  lineNo: number;
  date: LocalDate;
  account: string;
  channel: 'cash' | 'bank';
  direction: 'receipt' | 'payment';
  /** The amount in its column, as booked (negative for a red storno). */
  bani: bigint;
  currency: LedgerLine['currency'];
  /** What the row is, adding up to its flow. */
  parts: NaturePart[];
}

/** Money in: a debit on a treasury account, a credit on any other. */
const treasuryFlow = (line: LedgerLine) => (line.side === 'D' ? line.bani : -line.bani);
const counterFlow = (line: LedgerLine) => (line.side === 'C' ? line.bani : -line.bani);
const sum = (values: readonly bigint[]) => values.reduce((total, value) => total + value, 0n);
const abs = (value: bigint) => (value < 0n ? -value : value);

/**
 * `total` split in proportion to signed `weights` whose sum is not zero. The parts add up to
 * `total`; with weights of one sign this is the largest-remainder split.
 */
export function prorate(total: bigint, weights: readonly bigint[]): bigint[] {
  const whole = sum(weights);
  if (whole === 0n) throw new RangeError('Weights must not add up to zero.');
  if (weights.every((weight) => weight >= 0n)) return allocate(total, weights);
  if (weights.every((weight) => weight <= 0n))
    return allocate(
      total,
      weights.map((weight) => -weight),
    );
  const parts = weights.map((weight) => divRound(total * weight, whole, 'halfAwayFromZero'));
  const largest = weights.reduce(
    (best, weight, index) => (abs(weight) > abs(weights[best]!) ? index : best),
    0,
  );
  parts[largest]! += total - sum(parts);
  return parts;
}

/** Parts with the same nature and account added up, zeros dropped, in first-seen order. */
function merge(parts: readonly NaturePart[]): NaturePart[] {
  const merged = new Map<string, NaturePart>();
  for (const part of parts) {
    const key = `${part.nature}|${part.account}`;
    const existing = merged.get(key);
    if (existing) existing.flow += part.flow;
    else merged.set(key, { ...part });
  }
  return [...merged.values()].filter((part) => part.flow !== 0n);
}

export interface JournalInput {
  /** Posted entries with at least one treasury line, in posting order. */
  entries: readonly LedgerEntry[];
  /** The open items their lines name. */
  items: ReadonlyMap<string, LedgerItem>;
  /** For each item with a document, every posted entry that touched it. */
  itemEntries: ReadonlyMap<string, readonly LedgerEntry[]>;
  catalogue: NatureCatalogue;
}

/** What an invoice's open item is made of: its charges' other lines, by account, money in
 * positive (a sale's revenue and VAT are positive, a purchase's expense and VAT negative). */
export function composition(
  item: LedgerItem,
  itemEntries: readonly LedgerEntry[],
): Map<string, bigint> {
  const weights = new Map<string, bigint>();
  for (const entry of itemEntries) {
    if (!(chargeJournals as readonly string[]).includes(entry.journalCode)) continue;
    if (entry.lines.some((line) => isTreasury(line.account))) continue;
    for (const line of entry.lines) {
      if (line.openItem === item.id) continue;
      weights.set(line.account, (weights.get(line.account) ?? 0n) + counterFlow(line));
    }
  }
  return weights;
}

/** The nature parts that explain an entry's non-treasury lines, adding up to their flow. */
export function explain(
  lines: readonly LedgerLine[],
  input: Pick<JournalInput, 'items' | 'itemEntries' | 'catalogue'>,
): NaturePart[] {
  const parts: NaturePart[] = [];
  const settled: NaturePart[] = [];
  const differences: LedgerLine[] = [];
  for (const line of lines) {
    const flow = counterFlow(line);
    const item = line.openItem ? input.items.get(line.openItem) : undefined;
    if (item?.documentId) {
      const weights = [...composition(item, input.itemEntries.get(item.id) ?? [])].filter(
        ([, weight]) => weight !== 0n,
      );
      if (!weights.length || sum(weights.map(([, weight]) => weight)) === 0n) {
        parts.push({ nature: 'unattributed', account: line.account, flow });
        continue;
      }
      const shares = prorate(
        flow,
        weights.map(([, weight]) => weight),
      );
      weights.forEach(([account], index) =>
        settled.push({
          nature: classify(input.catalogue, account, shares[index]!),
          account,
          flow: shares[index]!,
        }),
      );
      continue;
    }
    if (!line.openItem && /^(765|665)/.test(line.account)) {
      differences.push(line);
      continue;
    }
    const account = item ? item.controlAccount : line.account;
    parts.push({ nature: classify(input.catalogue, account, flow), account, flow });
  }
  // A realized exchange difference goes with the invoices it was realized on: with their income
  // or expense, since their VAT stays in lei as the invoice stated it.
  const difference = sum(differences.map(counterFlow));
  const net = settled.filter((part) => natureOf(part.nature)?.kind !== 'vat');
  const carriers = net.length && sum(net.map((part) => part.flow)) !== 0n ? net : settled;
  const base = sum(carriers.map((part) => part.flow));
  if (difference !== 0n && carriers.length && base !== 0n) {
    const shares = prorate(
      difference,
      carriers.map((part) => part.flow),
    );
    carriers.forEach((part, index) => (part.flow += shares[index]!));
  } else
    for (const line of differences) {
      const flow = counterFlow(line);
      parts.push({
        nature: classify(input.catalogue, line.account, flow),
        account: line.account,
        flow,
      });
    }
  return merge([...settled, ...parts]);
}

/**
 * The rows of the Registrul-jurnal for the given entries, in the order of the receipt or payment:
 * date, then posting sequence, then line. Opening balances (journal DESCHIDERE) are balances, not
 * receipts or payments, and give no row.
 */
export function journalRows(input: JournalInput): JournalRow[] {
  const rows: JournalRow[] = [];
  const entries = [...input.entries]
    .filter((entry) => entry.journalCode !== 'DESCHIDERE')
    .sort((a, b) => (a.date === b.date ? a.seq - b.seq : a.date < b.date ? -1 : 1));
  for (const entry of entries) {
    const treasury = entry.lines.filter((line) => isTreasury(line.account));
    if (!treasury.length) continue;
    const others = entry.lines.filter((line) => !isTreasury(line.account));
    const explained = explain(others, input);
    const net = sum(treasury.map(treasuryFlow));
    // The side that carries the net amount shares the explanation pro rata; what the other side
    // offsets of it is a transfer between own accounts. Without a net amount (a pure transfer),
    // whatever explains nothing goes on the first line.
    const carriers =
      net === 0n
        ? treasury.slice(0, 1)
        : treasury.filter((line) => (net > 0n ? treasuryFlow(line) > 0n : treasuryFlow(line) < 0n));
    const carried = net === 0n ? [0n] : prorate(net, carriers.map(treasuryFlow));
    const split = explained.map((part) => (net === 0n ? [part.flow] : prorate(part.flow, carried)));
    for (const line of [...treasury].sort((a, b) => a.lineNo - b.lineNo)) {
      const flow = treasuryFlow(line);
      const index = carriers.indexOf(line);
      const own =
        index < 0 ? [] : explained.map((part, p) => ({ ...part, flow: split[p]![index]! }));
      const share = index < 0 ? 0n : carried[index]!;
      rows.push({
        entryId: entry.id,
        lineNo: line.lineNo,
        date: entry.date,
        account: line.account,
        channel: channelOf(line.account),
        direction: line.side === 'D' ? 'receipt' : 'payment',
        bani: line.bani,
        currency: line.currency,
        parts: merge([...own, { nature: 'transfer', account: line.account, flow: flow - share }]),
      });
    }
  }
  return rows;
}

export interface MonthTotals {
  month: string;
  receipts: { cash: bigint; bank: bigint };
  payments: { cash: bigint; bank: bigint };
}

/** The monthly totals the register requires (OMFP nr. 170/2015 cap. III pct. 12). */
export function monthlyTotals(rows: readonly JournalRow[]): MonthTotals[] {
  const months = new Map<string, MonthTotals>();
  for (const row of rows) {
    const month = row.date.slice(0, 7);
    const totals = months.get(month) ?? {
      month,
      receipts: { cash: 0n, bank: 0n },
      payments: { cash: 0n, bank: 0n },
    };
    totals[row.direction === 'receipt' ? 'receipts' : 'payments'][row.channel] += row.bani;
    months.set(month, totals);
  }
  return [...months.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
}
