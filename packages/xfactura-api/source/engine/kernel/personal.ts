import type { DataClass } from 'xfactura-core/kernel';
import { formatMoney, parseMoney } from 'xfactura-core/money';
import { isValidCnp } from 'xfactura-core/ro/identifiers';

/*
 * Personal data in what a caller reads. CNPs are sealed at rest and opened only into the files
 * that must carry them (returns, a B2C invoice); a person's pay is in the books on the personnel
 * accounts. A reader who may not read the `personal` class sees no CNP, and one who may not read
 * `payroll` and `personal` sees no amount on a personnel account tied to a person.
 */

/** What a CNP becomes for a reader who may not read personal data, as `sales.preview` writes a
 * B2C buyer's: 13 asterisks. */
export const cnpMask = '*************';

/** The classes a person's pay belongs to: who earned, was withheld or is owed what. */
export const payClasses: readonly DataClass[] = ['payroll', 'personal'];

/** Fields that hold a party's identifier, where a CNP is masked whole. */
const identifierKeys = new Set([
  'taxId',
  'legalId',
  'vatId',
  'buyerTaxId',
  'cnp',
  'careCnp',
  'counterpartyTaxId',
  'supplierTaxId',
  'customerTaxId',
]);

const isCnp = (text: string) => isValidCnp(text.replace(/\s+/g, '').replace(/^RO/i, ''));
const thirteen = /(?<!\d)[1-9]\d{12}(?!\d)/g;

/**
 * A text with its CNPs masked: each run of 13 digits that passes a CNP's check digit or, with
 * `digits`, every run of 13 digits (a validator's message may quote one that fails it).
 */
export function maskCnpText(text: string, digits = false) {
  return text.replace(thirteen, (run) => (digits || isValidCnp(run) ? cnpMask : run));
}

/**
 * A JSON value with every CNP masked: an identifier field (`taxId`, `legalId`, `vatId`, …) that
 * holds one, with or without RO, and a CNP inside a citation's or a message's text. Codes that
 * merely have 13 digits elsewhere (an article's EAN) are left as they are.
 */
export function maskCnps<T>(value: T): T {
  const walk = (item: unknown, key?: string): unknown => {
    if (typeof item === 'string')
      return key && identifierKeys.has(key)
        ? isCnp(item)
          ? cnpMask
          : maskCnpText(item)
        : key === 'text' || key === 'message' || key === 'detail'
          ? maskCnpText(item)
          : item;
    if (Array.isArray(item)) return item.map((element) => walk(element, key));
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>).map(([name, child]) => [
          name,
          walk(child, name),
        ]),
      );
    return item;
  };
  return walk(value) as T;
}

/** A personnel account (class 42: 421–428): its lines and items name the person paid, withheld
 * from or owed. */
export const personnelAccount = (account: string) => account.startsWith('42');

type AmountLine = {
  account: string;
  side: 'D' | 'C';
  amount: string;
  partyId?: string | undefined;
  openItem?: string | undefined;
  memo?: string | undefined;
  analytics?: Record<string, string> | undefined;
  currency?: unknown;
};

/**
 * Lines as a reader who may not read pay sees them: those on personnel accounts summed per
 * account and side, in lei, without the person (party, open item, memo, analytics), at the
 * place of the first; the others as they are.
 */
export function withoutPersons<Line extends AmountLine>(lines: Line[]): Line[] {
  const out: Line[] = [];
  const merged = new Map<string, { index: number; bani: bigint }>();
  for (const line of lines) {
    if (!personnelAccount(line.account)) {
      out.push(line);
      continue;
    }
    const key = `${line.account}/${line.side}`;
    const bani = parseMoney(line.amount, 'RON');
    const known = merged.get(key);
    if (known) {
      known.bani += bani;
      continue;
    }
    const {
      partyId: _party,
      openItem: _item,
      memo: _memo,
      analytics: _analytics,
      currency: _currency,
      ...rest
    } = line;
    merged.set(key, { index: out.length, bani });
    out.push(rest as Line);
  }
  for (const { index, bani } of merged.values())
    out[index] = { ...out[index]!, amount: formatMoney(bani, 'RON') };
  return out;
}

type StoredItem = { account: string; currency: string; bani: string; minor: string };

/** A closing snapshot's open items as a reader who may not read pay sees them: those on personnel
 * accounts summed per account and currency, without their id and party. */
export function itemsWithoutPersons<Item extends StoredItem>(items: Item[]) {
  const merged = new Map<string, StoredItem>();
  const out: (Item | StoredItem)[] = [];
  for (const item of items) {
    if (!personnelAccount(item.account)) {
      out.push(item);
      continue;
    }
    const key = `${item.account}/${item.currency}`;
    const known = merged.get(key);
    if (known) {
      known.bani = String(BigInt(known.bani) + BigInt(item.bani));
      known.minor = String(BigInt(known.minor) + BigInt(item.minor));
      continue;
    }
    const { account, currency, bani, minor } = item;
    const sum = { account, currency, bani, minor };
    merged.set(key, sum);
    out.push(sum);
  }
  return out;
}

/**
 * A reviewed action's preview as a reader who may not read pay sees it: the year close's closing
 * snapshot (`years.close`) holds each open item at the year's end, an employee's unpaid pay among
 * them.
 */
export function previewWithoutPersons(operation: string, preview: unknown) {
  const closing = (preview as { closing?: { items?: StoredItem[] } } | null)?.closing;
  if (operation !== 'years.close' || !Array.isArray(closing?.items)) return preview;
  return {
    ...(preview as Record<string, unknown>),
    closing: { ...closing, items: itemsWithoutPersons(closing.items) },
  };
}

/*
 * Health data (GDPR art. 9): who was on medical leave, with which certificate, indemnity code and
 * diagnosis, and work accidents. It is redacted for every caller who may not read the `health`
 * class (`Commands.disclosable`): a viewer, and an agent whose grant names no operation declaring
 * it.
 */

/** The classes a reader of health data needs. */
export const healthClasses: readonly DataClass[] = ['health'];

/** What a redacted sick-leave issue says instead: that one exists, not whose or which. */
export const healthIssue = {
  code: 'HEALTH_REDACTED',
  message:
    'O problemă privind un concediu medical (date de sănătate), pe care această identitate nu o poate citi: o vede un proprietar sau un revizor.',
} as const;

/** A payroll line's issues as a reader who may not read health data sees them: those of its
 * medical certificates (marked `health`; before the mark, `SICK_*`), which name the certificate
 * and its code, replaced by `healthIssue`. */
export function issuesWithoutHealth<Issue extends { code: string; message: string; health?: true }>(
  issues: Issue[],
): (Issue | typeof healthIssue)[] {
  return issues.map((issue) =>
    issue.health || issue.code.startsWith('SICK_') ? healthIssue : issue,
  );
}

type Difference = { section: string; id: string; closing: unknown; opening: unknown };

/**
 * A year's opening checked against its close (`years.opening`) as a reader who may not read pay
 * sees it: the differences of open items on personnel accounts summed per account and currency,
 * on each side, without the item and its person; the others as they are.
 */
export function differencesWithoutPersons<Item extends Difference>(differences: Item[]) {
  const out: (Item | Difference)[] = [];
  const merged = new Map<string, { closing: StoredItem; opening: StoredItem }>();
  const add = (sum: StoredItem, item: StoredItem | null) => {
    if (!item) return;
    sum.bani = String(BigInt(sum.bani) + BigInt(item.bani));
    sum.minor = String(BigInt(sum.minor) + BigInt(item.minor));
  };
  for (const difference of differences) {
    const closing = difference.closing as StoredItem | null;
    const opening = difference.opening as StoredItem | null;
    const item = closing ?? opening;
    if (difference.section !== 'items' || !item || !personnelAccount(item.account)) {
      out.push(difference);
      continue;
    }
    const id = `${item.account}/${item.currency}`;
    let sums = merged.get(id);
    if (!sums) {
      const zero = () => ({
        account: item.account,
        currency: item.currency,
        bani: '0',
        minor: '0',
      });
      sums = { closing: zero(), opening: zero() };
      merged.set(id, sums);
      out.push({ section: 'items', id, ...sums });
    }
    add(sums.closing, closing);
    add(sums.opening, opening);
  }
  return out;
}
