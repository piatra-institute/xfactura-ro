import type { JsonValue } from '../../kernel';
import { formatMoney, isSupportedCurrency, LEDGER_CURRENCY, parseMoney } from '../../money';
import type { LocalDate } from '../../time';
import { normalizedTaxId } from '../../documents/schemas';
import type { InventoryList } from './documents';

/*
 * The annual inventory's results (OMF nr. 2.861/2009 pct. 35): what the lists found compared with
 * what the books hold on their date. Pure: the engine reads the books (the register's assets at
 * their net value, the cash desks' and banks' balances, each partner's balance per account and
 * currency, the stock accounts) and the lists, and this says what differs, what the lists do not
 * cover that they must, and what the engine does not cover (stock until G1).
 */

export interface BookCash {
  account: string;
  currency: string;
  /** In lei, and in the currency's minor units (equal for lei). */
  bani: bigint;
  minor: bigint;
}
export interface BookAsset {
  id: string;
  number: string;
  name: string;
  /** The value less the depreciation due by the date and the impairment held. */
  net: bigint;
}
export interface BookPartner {
  partyId: string;
  taxId: string | null;
  name: string;
  account: string;
  currency: string;
  /** Signed: positive what the partner owes the company. In the currency's minor units. */
  minor: bigint;
}
export interface InventoryBooks {
  date: LocalDate;
  assets: readonly BookAsset[];
  /** The cash desks (531x) with a balance or movements in the year. */
  cash: readonly BookCash[];
  /** The bank accounts (512x); left out, banks are not compared. */
  bank?: readonly BookCash[];
  /** Each partner's balance on the accounts held on open items; left out, not compared. */
  partners?: readonly BookPartner[];
  /** The stock accounts' balances (class 3). */
  stock: readonly { account: string; bani: bigint }[];
}

export type InventoryDifference =
  | { kind: 'asset.missing'; assetId: string; number: string; net: bigint }
  | { kind: 'asset.surplus'; number: string; name: string; value: bigint }
  | { kind: 'asset.impaired'; assetId: string; number: string; net: bigint; value: bigint }
  | { kind: 'cash'; account: string; currency: string; book: bigint; counted: bigint }
  | { kind: 'bank'; account: string; currency: string; book: bigint; confirmed: bigint }
  | {
      kind: 'partner';
      partyId: string | null;
      name: string;
      account: string;
      currency: string;
      book: bigint;
      confirmed: bigint | null;
      status: 'confirmed' | 'disputed' | 'no_reply';
    };

export interface InventoryGap {
  code: 'INVENTORY_UNLISTED' | 'INVENTORY_CASH_UNCOUNTED' | 'INVENTORY_BANK_UNCONFIRMED';
  message: string;
}

export interface InventoryComparison {
  date: LocalDate;
  /** Which sections the lists cover. */
  sections: { assets: boolean; cash: boolean; bank: boolean; partners: boolean; stock: boolean };
  differences: InventoryDifference[];
  /** What the books hold that the lists must cover and do not (pct. 2, 29, 34). */
  gaps: InventoryGap[];
  /** What the engine does not cover: stock (G1). */
  unsupported: { code: string; message: string; details?: JsonValue }[];
}

const amountOf = (text: string, currency: string) =>
  parseMoney(text, isSupportedCurrency(currency) ? currency : LEDGER_CURRENCY);
const show = (minor: bigint, currency: string) =>
  `${formatMoney(minor, isSupportedCurrency(currency) ? currency : LEDGER_CURRENCY)} ${currency === LEDGER_CURRENCY ? 'lei' : currency}`;

/** Compares the year's lists with the books on their date. */
export function compareInventory(
  lists: readonly InventoryList[],
  books: InventoryBooks,
): InventoryComparison {
  const covered = (section: 'assets' | 'cash' | 'bank' | 'partners' | 'stock') =>
    lists.some((list) => list[section] !== null);
  const sections = {
    assets: covered('assets'),
    cash: covered('cash'),
    bank: covered('bank'),
    partners: covered('partners'),
    stock: covered('stock'),
  };
  const differences: InventoryDifference[] = [];
  const gaps: InventoryGap[] = [];
  const unsupported: InventoryComparison['unsupported'] = [];

  // Fixed assets: each card in use at the date is found or missing; a number the register does
  // not hold was found in surplus; one found below its net value is impaired (pct. 34 alin. (2)).
  const listed = new Map<string, NonNullable<InventoryList['assets']>[number]>();
  for (const list of lists) for (const row of list.assets ?? []) listed.set(row.number, row);
  for (const asset of books.assets) {
    const row = listed.get(asset.number);
    if (!row) {
      gaps.push({
        code: 'INVENTORY_UNLISTED',
        message: `Imobilizarea ${asset.number} ${asset.name} nu apare în listele de inventariere de la ${books.date}.`,
      });
      continue;
    }
    if (!row.found)
      differences.push({
        kind: 'asset.missing',
        assetId: asset.id,
        number: asset.number,
        net: asset.net,
      });
    else if (row.value !== null && amountOf(row.value, LEDGER_CURRENCY) < asset.net)
      differences.push({
        kind: 'asset.impaired',
        assetId: asset.id,
        number: asset.number,
        net: asset.net,
        value: amountOf(row.value, LEDGER_CURRENCY),
      });
  }
  const known = new Set(books.assets.map((asset) => asset.number));
  for (const [number, row] of listed)
    if (!known.has(number) && row.found)
      differences.push({
        kind: 'asset.surplus',
        number,
        name: row.name,
        value: row.value === null ? 0n : amountOf(row.value, LEDGER_CURRENCY),
      });

  // Cash counted on the last working day (pct. 29 alin. (3)): every cash desk the books hold.
  const counted = new Map<string, bigint>();
  for (const list of lists)
    for (const row of list.cash ?? [])
      counted.set(`${row.account}/${row.currency}`, amountOf(row.counted, row.currency));
  for (const desk of books.cash) {
    const found = counted.get(`${desk.account}/${desk.currency}`);
    if (found === undefined) {
      gaps.push({
        code: 'INVENTORY_CASH_UNCOUNTED',
        message: `Casieria ${desk.account} (${desk.currency}) nu este inventariată la ${books.date}: soldul din registrul de casă este ${show(desk.minor, desk.currency)}.`,
      });
      continue;
    }
    if (found !== desk.minor)
      differences.push({
        kind: 'cash',
        account: desk.account,
        currency: desk.currency,
        book: desk.minor,
        counted: found,
      });
  }
  for (const [id, amount] of counted)
    if (!books.cash.some((desk) => `${desk.account}/${desk.currency}` === id) && amount !== 0n) {
      const [account, currency] = id.split('/') as [string, string];
      differences.push({ kind: 'cash', account, currency, book: 0n, counted: amount });
    }

  // Banks, on the statements of the year's last day (pct. 29 alin. (2)).
  if (books.bank) {
    const confirmed = new Map<string, bigint>();
    for (const list of lists)
      for (const row of list.bank ?? [])
        confirmed.set(`${row.account}/${row.currency}`, amountOf(row.balance, row.currency));
    for (const bank of books.bank) {
      const found = confirmed.get(`${bank.account}/${bank.currency}`);
      if (found === undefined) {
        gaps.push({
          code: 'INVENTORY_BANK_UNCONFIRMED',
          message: `Contul bancar ${bank.account} (${bank.currency}) nu are extrasul de la ${books.date} în listele de inventariere.`,
        });
        continue;
      }
      if (found !== bank.minor)
        differences.push({
          kind: 'bank',
          account: bank.account,
          currency: bank.currency,
          book: bank.minor,
          confirmed: found,
        });
    }
  }

  // Partners, as each confirmed its balance (pct. 28): only those listed are compared, the norms
  // asking for the balances that weigh in the total.
  if (books.partners) {
    for (const list of lists)
      for (const row of list.partners ?? []) {
        const taxId = row.taxId ? normalizedTaxId(row.taxId) : null;
        const matches = books.partners.filter(
          (partner) =>
            partner.account === row.account &&
            partner.currency === row.currency &&
            (taxId !== null
              ? partner.taxId !== null && normalizedTaxId(partner.taxId) === taxId
              : partner.name.trim().toLowerCase() === row.name.trim().toLowerCase()),
        );
        const book = matches.reduce((sum, partner) => sum + partner.minor, 0n);
        const confirmed = row.confirmed === null ? null : amountOf(row.confirmed, row.currency);
        if (row.status === 'confirmed' && confirmed === book) continue;
        differences.push({
          kind: 'partner',
          partyId: matches[0]?.partyId ?? null,
          name: row.name,
          account: row.account,
          currency: row.currency,
          book,
          confirmed,
          status: row.status,
        });
      }
  }

  // Stock: by quantity only until the stock module exists (G1), so nothing is compared.
  const stockHeld = books.stock.filter((row) => row.bani !== 0n);
  if (stockHeld.length || lists.some((list) => (list.stock ?? []).length > 0))
    unsupported.push({
      code: 'INVENTORY_STOCK',
      message: `Stocurile${stockHeld.length ? ` (${stockHeld.map((row) => row.account).join(', ')})` : ''} nu se pot compara cu listele de inventariere: evidența stocurilor pe articole și cantități nu este încă acoperită (G1), iar diferențele lor se înregistrează în afara aplicației.`,
      details: { accounts: stockHeld.map((row) => row.account) },
    });

  return { date: books.date, sections, differences, gaps, unsupported };
}

/** A difference as people read it. */
export function differenceView(difference: InventoryDifference): JsonValue {
  const lei = (bani: bigint) => formatMoney(bani, LEDGER_CURRENCY);
  switch (difference.kind) {
    case 'asset.missing':
      return { kind: difference.kind, number: difference.number, net: lei(difference.net) };
    case 'asset.surplus':
      return { kind: difference.kind, number: difference.number, value: lei(difference.value) };
    case 'asset.impaired':
      return {
        kind: difference.kind,
        number: difference.number,
        net: lei(difference.net),
        value: lei(difference.value),
      };
    case 'cash':
    case 'bank': {
      const money = (minor: bigint) =>
        formatMoney(
          minor,
          isSupportedCurrency(difference.currency) ? difference.currency : LEDGER_CURRENCY,
        );
      return {
        kind: difference.kind,
        account: difference.account,
        currency: difference.currency,
        book: money(difference.book),
        found: money(difference.kind === 'cash' ? difference.counted : difference.confirmed),
      };
    }
    case 'partner': {
      const money = (minor: bigint) =>
        formatMoney(
          minor,
          isSupportedCurrency(difference.currency) ? difference.currency : LEDGER_CURRENCY,
        );
      return {
        kind: difference.kind,
        partyId: difference.partyId,
        name: difference.name,
        account: difference.account,
        currency: difference.currency,
        book: money(difference.book),
        confirmed: difference.confirmed === null ? null : money(difference.confirmed),
        status: difference.status,
      };
    }
  }
}
