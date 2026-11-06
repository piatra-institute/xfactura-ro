import { z } from 'zod';
import {
  parseQuantity,
  financialYearOf,
  isStockAccount,
  type Issue,
  type JsonValue,
  type LineSpec,
  type Loaded,
  type OpenItemSpec,
  type PostedEntry,
  type StockQuery,
} from '../../kernel';
import { allocate } from '../../money';
import type { RuleContext } from '../../rules';
import type { LocalDate } from '../../time';
import { expenseFor, type StockReturns } from './parameters';
import { itemOf, productAccounts, stockAccountsAt, warehouseOf } from './treatments';
import { prorate, StockBook, stockPolicyAt } from './valuation';

/*
 * The stock register on invoices (G1): a purchase invoice of goods received into a warehouse, the
 * reception note (NIR) with an item per invoice line and its differences; a sale of goods out of
 * a warehouse at the policy's value (607 against 371); and the returns, to the supplier on its
 * credit note and from the customer on the company's. The invoice treatments call these once
 * they have built their lines; an input without `stock` leaves them as they were.
 */

const block = (code: string, message: string, path?: string, details?: JsonValue): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
  ...(details === undefined ? {} : { details }),
});
const ack = (code: string, message: string, details?: JsonValue): Issue => ({
  code,
  severity: 'ack',
  message,
  ...(details === undefined ? {} : { details }),
});

/** A quantity of zero or more (a line received short, in full). */
const received = z
  .string()
  .regex(/^(0|[1-9]\d{0,14})(\.\d{1,3})?$/)
  .optional();

/**
 * The goods an invoice moves: each invoice line (its id, BT-126) with the catalogue's item and
 * the quantity in the item's unit as the invoice states it; for a purchase, the quantity the
 * reception found when it differs (the NIR's difference).
 */
export const invoiceStockInput = z
  .object({
    warehouseId: z.uuid(),
    lines: z
      .array(
        z
          .object({
            line: z.string().min(1).max(100),
            itemId: z.uuid(),
            /** Zero only on a supplier's credit note that corrects a price (no goods move). */
            quantity: z.string().regex(/^(0|[1-9]\d{0,14})(\.\d{1,3})?$/),
            received,
          })
          .strict(),
      )
      .min(1)
      .max(1000),
  })
  .strict()
  .refine((stock) => new Set(stock.lines.map((line) => line.line)).size === stock.lines.length, {
    message: 'O linie a facturii apare o singură dată.',
    path: ['lines'],
  });
export type InvoiceStock = z.infer<typeof invoiceStockInput>;

/** The positions an invoice's stock reads. */
export const invoiceStockQuery = (stock: InvoiceStock): StockQuery => {
  const items = [...new Set(stock.lines.map((line) => line.itemId))];
  return {
    positions: items.map((item) => ({ item, warehouse: stock.warehouseId })),
    items,
    warehouses: [stock.warehouseId],
    // A sale's goods leave at what the positions held on its date, which the plan does not know
    // (the invoice's), so the days the positions moved on in the open months are read.
    dated: true,
  };
};

/** An invoice's line as the stock reads it: its id, VAT category key and net amount. */
export interface StockInvoiceLine {
  id: string;
  key: string;
  /** In the document's currency, minor units: only the weights matter. */
  net: bigint;
}

/** What a part of the invoice the treatment booked is: its account and VAT category key, and the
 * index of its line among the effect's lines (none for a part without one). */
export interface StockPart {
  account: string;
  vat: string;
  line: number | undefined;
}

export interface StockResult {
  issues: Issue[];
  openItems: OpenItemSpec[];
  book: StockBook | null;
  /** What the explanation shows. */
  details: JsonValue;
}

const failed = (issues: Issue[]): StockResult => ({
  issues,
  openItems: [],
  book: null,
  details: null,
});

/** The lines mapped to each part, the part's value split over them by their net amounts. */
function splitParts(
  stock: InvoiceStock,
  invoiceLines: readonly StockInvoiceLine[],
  parts: readonly StockPart[],
  lines: readonly LineSpec[],
  loaded: Loaded,
  issues: Issue[],
) {
  const byId = new Map(invoiceLines.map((line) => [line.id, line]));
  const mapped: {
    row: InvoiceStock['lines'][number];
    index: number;
    item: NonNullable<ReturnType<typeof loaded.stockItems.get>>;
    part: number;
    value: bigint;
  }[] = [];
  stock.lines.forEach((row, index) => {
    const path = `stock.lines.${index}`;
    const line = byId.get(row.line);
    if (!line)
      return void issues.push(
        block('STOCK_INVOICE_LINE', `Factura nu are linia ${row.line}.`, `${path}.line`),
      );
    const item = itemOf(loaded, row.itemId, `${path}.itemId`);
    if ('severity' in item) return void issues.push(item);
    const candidates = parts.flatMap((part, p) =>
      part.vat === line.key && part.account === item.account && part.line !== undefined ? [p] : [],
    );
    if (candidates.length !== 1)
      return void issues.push(
        block(
          'STOCK_PART',
          candidates.length
            ? `Mai multe părți ale facturii sunt pe contul ${item.account} în categoria ${line.key}: linia ${row.line} nu se poate atribui uneia.`
            : `Linia ${row.line} (${item.code}) cere o parte a facturii pe contul articolului, ${item.account}, în categoria ${line.key}.`,
          path,
        ),
      );
    mapped.push({ row, index, item, part: candidates[0]!, value: 0n });
  });
  // Each stock part's value over its mapped lines, by their nets: charges inside the part (the
  // transport invoiced with the goods) enter the goods' cost (OMFP 1802/2014 pct. 8 pct. 6).
  parts.forEach((part, p) => {
    if (part.line === undefined) return;
    const members = mapped.filter((entry) => entry.part === p);
    if (!members.length) return;
    const line = lines[part.line]!;
    const signed = line.side === 'D' ? line.bani : -line.bani;
    const weights = members.map((entry) => byId.get(entry.row.line)!.net);
    const shares = weights.some((weight) => weight !== 0n)
      ? allocate(signed, weights)
      : weights.map(() => 0n);
    members.forEach((entry, i) => (entry.value = shares[i]!));
  });
  return mapped;
}

/**
 * A purchase invoice's goods received into a warehouse (OMFP 1802/2014 pct. 283–284; the NIR):
 * each mapped line's share of its part enters the item's stock. A line received short leaves out
 * the missing quantity's share, claimed from the supplier (461) until its credit note; one
 * received in excess enters the excess at the invoice's unit cost, owed to the supplier on 408
 * until its invoice. Every line of a stock part must be an item's.
 */
export function receiveInvoiceStock(args: {
  stock: InvoiceStock;
  loaded: Loaded;
  rules: RuleContext;
  date: LocalDate;
  partyId: string;
  documentId: string;
  invoiceLines: readonly StockInvoiceLine[];
  parts: readonly StockPart[];
  lines: LineSpec[];
}): StockResult {
  const { stock, loaded, rules, date, lines } = args;
  const issues: Issue[] = [];
  const warehouse = warehouseOf(loaded, stock.warehouseId, 'stock.warehouseId');
  if ('severity' in warehouse) issues.push(warehouse);
  const policy = stockPolicyAt(loaded, date, [stock.warehouseId]);
  if (Array.isArray(policy)) issues.push(...policy);
  if (issues.length || Array.isArray(policy)) return failed(issues);
  const accounts = stockAccountsAt(rules, date);
  const mapped = splitParts(stock, args.invoiceLines, args.parts, lines, loaded, issues);
  // The claim and the uninvoiced excess are the supplier's, not the document's: the invoice's
  // own payable stays the one its credit note reduces.
  // A stock part needs its items; a line of its category no item names is a charge (transport,
  // handling) that enters the items' cost, when no other part of the category could hold it.
  args.parts.forEach((part, p) => {
    if (part.line === undefined || !isStockAccount(part.account)) return;
    if (!mapped.some((entry) => entry.part === p))
      issues.push(
        block(
          'STOCK_PART_UNMAPPED',
          `Partea pe contul ${part.account} (${part.vat}) nu are articole: indicați articolul fiecărei linii.`,
          'stock.lines',
        ),
      );
  });
  const charged = [
    ...new Set(
      args.invoiceLines
        .filter((line) => !mapped.some((entry) => entry.row.line === line.id))
        .map((line) => line.key),
    ),
  ].filter((key) => {
    const members = args.parts.filter((part) => part.vat === key);
    return members.length > 0 && members.every((part) => isStockAccount(part.account));
  });
  if (charged.length)
    issues.push(
      ack(
        'STOCK_CHARGES',
        `Liniile fără articol din ${charged.join(', ')} intră în costul articolelor, proporțional cu valoarea lor (transport, manipulare: OMFP 1802/2014 pct. 8 pct. 6). Confirmați.`,
      ),
    );
  if (issues.some((issue) => issue.severity === 'block')) return failed(issues);
  const book = new StockBook(loaded, lines, 'receipt');
  let shortage = 0n;
  let surplus = 0n;
  const rows: JsonValue[] = [];
  for (const entry of mapped) {
    const invoiced = parseQuantity(entry.row.quantity)!;
    if (invoiced === 0n) {
      issues.push(
        block(
          'STOCK_QUANTITY',
          'Cantitatea facturată este pozitivă.',
          `stock.lines.${entry.index}.quantity`,
        ),
      );
      continue;
    }
    const got = entry.row.received === undefined ? invoiced : parseQuantity(entry.row.received)!;
    let value = entry.value;
    if (got < invoiced) {
      const missing = prorate(entry.value, invoiced - got, invoiced);
      shortage += missing;
      value -= missing;
    } else if (got > invoiced) {
      const excess = prorate(entry.value, got - invoiced, invoiced);
      surplus += excess;
      value += excess;
    }
    const partLine = args.parts[entry.part]!.line!;
    if (got !== invoiced) {
      const line = lines[partLine]!;
      lines[partLine] = { ...line, bani: line.bani + (value - entry.value) };
    }
    rows.push({
      line: entry.row.line,
      item: entry.item.code,
      invoiced: entry.row.quantity,
      received: entry.row.received ?? entry.row.quantity,
    });
    if (got === 0n) continue;
    issues.push(
      ...book.receive(
        {
          item: entry.item.id,
          warehouse: stock.warehouseId,
          account: entry.item.account,
          quantity: got,
          date,
        },
        value,
        partLine,
        policy,
        expenseFor(accounts, entry.item.account) ?? undefined,
      ),
    );
  }
  const zeroed = args.parts.find(
    (part) => part.line !== undefined && lines[part.line]?.bani === 0n,
  );
  if (zeroed)
    issues.push(
      block(
        'STOCK_NOTHING_RECEIVED',
        `Nimic din partea pe contul ${zeroed.account} nu a fost recepționat.`,
      ),
    );
  const openItems: OpenItemSpec[] = [];
  if (shortage) {
    openItems.push({
      ref: 'receipt-shortage',
      kind: 'receivable',
      controlAccount: accounts.receipt.shortage,
      partyId: args.partyId,
      currency: 'RON',
      normalSide: 'D',
      mayReverse: false,
    });
    lines.push({
      account: accounts.receipt.shortage,
      side: 'D',
      bani: shortage,
      openItem: 'receipt-shortage',
      partyId: args.partyId,
      memo: 'Lipsă la recepție, imputabilă furnizorului',
    });
  }
  if (surplus) {
    openItems.push({
      ref: 'receipt-surplus',
      kind: 'accrual.payable',
      controlAccount: accounts.receipt.uninvoiced,
      partyId: args.partyId,
      currency: 'RON',
      normalSide: 'C',
      mayReverse: false,
    });
    lines.push({
      account: accounts.receipt.uninvoiced,
      side: 'C',
      bani: surplus,
      openItem: 'receipt-surplus',
      partyId: args.partyId,
      memo: 'Plus la recepție, nefacturat',
    });
  }
  if (shortage || surplus)
    issues.push(
      ack(
        'RECEIPT_DIFFERENCE',
        `Recepția constată diferențe față de factură${shortage ? `: lipsă de ${formatLei(shortage)} lei, pretinsă furnizorului (461) până la nota lui de credit` : ''}${surplus ? `${shortage ? ';' : ':'} plus de ${formatLei(surplus)} lei, datorat furnizorului (408) până la factura lui` : ''}. Confirmați nota de recepție și constatare de diferențe.`,
      ),
    );
  return {
    issues,
    openItems,
    book,
    details: {
      warehouseId: stock.warehouseId,
      method: policy.method,
      lines: rows,
      ...(shortage ? { shortage: formatLei(shortage) } : {}),
      ...(surplus ? { surplus: formatLei(surplus) } : {}),
    },
  };
}

const formatLei = (bani: bigint) => {
  const negative = bani < 0n;
  const digits = (negative ? -bani : bani).toString().padStart(3, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
};

/**
 * A sale's goods out of a warehouse (OMFP 1802/2014 pct. 95 alin. (1), 96; the functions of 371
 * and 607): each mapped line's item at the policy's value, credited to its stock account and
 * expensed (607 for goods). Only goods (371) are sold so; other stock is transferred to goods
 * first (the function of 371: materials sold as such).
 */
export function issueInvoiceStock(args: {
  stock: InvoiceStock;
  loaded: Loaded;
  rules: RuleContext;
  date: LocalDate;
  invoiceLines: readonly StockInvoiceLine[];
  lines: LineSpec[];
  /** A credit note: the goods come back, at what they left at (`original`). */
  original?: PostedEntry;
}): StockResult {
  const { stock, loaded, rules, date, lines } = args;
  const issues: Issue[] = [];
  const warehouse = warehouseOf(loaded, stock.warehouseId, 'stock.warehouseId');
  if ('severity' in warehouse) issues.push(warehouse);
  const policy = stockPolicyAt(loaded, date, [stock.warehouseId]);
  if (Array.isArray(policy)) issues.push(...policy);
  if (issues.length || Array.isArray(policy)) return failed(issues);
  const accounts = stockAccountsAt(rules, date);
  const byId = new Map(args.invoiceLines.map((line) => [line.id, line]));
  const book = new StockBook(loaded, lines, args.original ? 'return' : 'sale');
  const expenses = new Map<string, bigint>();
  const rows: JsonValue[] = [];
  stock.lines.forEach((row, index) => {
    const path = `stock.lines.${index}`;
    if (!byId.has(row.line))
      return void issues.push(
        block('STOCK_INVOICE_LINE', `Factura nu are linia ${row.line}.`, `${path}.line`),
      );
    if (row.received !== undefined)
      return void issues.push(
        block('STOCK_RECEIVED', 'Cantitatea recepționată se indică doar la o achiziție.', path),
      );
    const item = itemOf(loaded, row.itemId, `${path}.itemId`, productAccounts);
    if ('severity' in item) return void issues.push(item);
    // Goods (371) leave onto 607; the company's products (341, 345, 346, G4) onto 711, at their
    // registration price (the functions of 345 and 711: "valoarea la preț de înregistrare a
    // produselor finite vândute"), their price differences following at the month's end.
    if (
      !item.account.startsWith('371') &&
      !productAccounts.some((account) => item.account.startsWith(account))
    )
      return void issues.push(
        block(
          'STOCK_SALE_ACCOUNT',
          `Se vând ca mărfuri doar articolele din 371, iar produsele proprii din 341, 345, 346; ${item.code} este în ${item.account}: transferați-l întâi în mărfuri (funcțiunea contului 371).`,
          `${path}.itemId`,
        ),
      );
    const expense = expenseFor(accounts, item.account)!;
    const quantity = parseQuantity(row.quantity)!;
    if (quantity === 0n)
      return void issues.push(
        block('STOCK_QUANTITY', 'Cantitatea este pozitivă.', `${path}.quantity`),
      );
    const target = {
      item: item.id,
      warehouse: stock.warehouseId,
      account: item.account,
      quantity,
      date,
    };
    if (args.original) {
      // The goods come back at the cost they left at with the original sale.
      const out = (args.original.stockMoves ?? []).filter(
        (move) => move.item === item.id && move.quantity < 0n,
      );
      const sold = out.reduce((sum, move) => sum - move.quantity, 0n);
      const cost = out.reduce((sum, move) => sum - move.bani, 0n);
      if (sold < quantity)
        return void issues.push(
          block(
            'STOCK_RETURN_EXCEEDS',
            `Vânzarea inițială a scos din gestiune mai puțin din ${item.code} decât se returnează.`,
            path,
          ),
        );
      const value = prorate(cost, quantity, sold);
      const line = lines.length;
      // Red storno, as the credit note books its revenue: the credit on 371 is negative.
      lines.push({ account: item.account, side: 'C', bani: -value, memo: item.code });
      issues.push(...book.receive(target, value, line, policy, expense));
      expenses.set(expense, (expenses.get(expense) ?? 0n) - value);
      rows.push({ line: row.line, item: item.code, quantity: row.quantity });
      return;
    }
    const line = lines.length;
    lines.push({ account: item.account, side: 'C', bani: 0n, memo: item.code });
    const out = book.issue(target, line, policy);
    if ('issues' in out) return void issues.push(...out.issues);
    if (out.bani === 0n)
      return void issues.push(
        block('STOCK_VALUE', `${item.code} nu are valoare în gestiune.`, path),
      );
    lines[line] = { ...lines[line]!, bani: out.bani };
    expenses.set(expense, (expenses.get(expense) ?? 0n) + out.bani);
    rows.push({ line: row.line, item: item.code, quantity: row.quantity });
  });
  if (issues.some((issue) => issue.severity === 'block')) return failed(issues);
  for (const [account, bani] of expenses)
    if (bani !== 0n)
      // A credit note's red storno debits the expense with a negative amount.
      lines.push({
        account,
        side: 'D',
        bani,
        memo: args.original ? 'Retur de la client' : 'Descărcarea gestiunii',
      });
  return {
    issues,
    openItems: [],
    book,
    details: { warehouseId: stock.warehouseId, method: policy.method, lines: rows },
  };
}

/**
 * Goods returned to the supplier on its credit note (or a price credited on goods still held):
 * the credit note's stock part leaves the lots the original invoice created (FIFO, LIFO) or the
 * item's pool, at the credited value, no more than each held on the note's date (`giveBack`); a
 * line with no quantity corrects the cost of what is still held (OMFP 1802/2014 pct. 76). A
 * discount on goods no longer held goes to 609 instead. Out of a pool under the weighted average
 * after each receipt, as `ro.stock.returns` reads it.
 *
 * A credit note in a currency (`atCost`, the original's entry) takes its goods out at the cost
 * their receipt entered at, in lei (the original's moves of the item in the warehouse), not at a
 * rate: each stock part's line becomes that cost, without a currency amount, and `shift` is what
 * that changes in the parts' lines (signed as the lines), which the partner's exchange difference
 * takes.
 */
export function returnInvoiceStock(args: {
  stock: InvoiceStock;
  loaded: Loaded;
  rules: RuleContext;
  date: LocalDate;
  invoiceLines: readonly StockInvoiceLine[];
  parts: readonly StockPart[];
  lines: LineSpec[];
  /** The entry that posted the original invoice. */
  originEntryId: string | undefined;
  atCost?: PostedEntry;
}): StockResult & { shift: bigint } {
  const { stock, loaded, date, lines } = args;
  const issues: Issue[] = [];
  const warehouse = warehouseOf(loaded, stock.warehouseId, 'stock.warehouseId');
  if ('severity' in warehouse) issues.push(warehouse);
  const policy = stockPolicyAt(loaded, date, [stock.warehouseId]);
  if (Array.isArray(policy)) issues.push(...policy);
  if (issues.length || Array.isArray(policy)) return { ...failed(issues), shift: 0n };
  const mapped = splitParts(stock, args.invoiceLines, args.parts, lines, loaded, issues);
  if (args.atCost) {
    // A line of a stock part's category no item names would be a charge credited with the
    // goods, whose cost in lei the note does not give.
    const charged = [
      ...new Set(
        args.invoiceLines
          .filter((line) => !mapped.some((entry) => entry.row.line === line.id))
          .map((line) => line.key),
      ),
    ].filter((key) => {
      const members = args.parts.filter((part) => part.vat === key);
      return members.length > 0 && members.every((part) => isStockAccount(part.account));
    });
    if (charged.length)
      issues.push(
        block(
          'STOCK_CREDIT_CHARGES',
          `Liniile fără articol din ${charged.join(', ')} ale unei note de credit în valută nu sunt acoperite: costul lor în lei, intrat cu bunurile, nu se cunoaște.`,
          'stock.lines',
        ),
      );
  }
  if (issues.length) return { ...failed(issues), shift: 0n };
  const accounts = stockAccountsAt(args.rules, date);
  // Out of a pool under the weighted average after each receipt: at the purchase price, or at the
  // date's average (`ro.stock.returns`).
  const average =
    policy.method === 'average' &&
    args.rules.param<StockReturns>('ro.stock.returns', 'accounting_transaction_date', date).pool ===
      'average';
  const book = new StockBook(loaded, lines, 'return');
  const rows: JsonValue[] = [];
  for (const entry of mapped) {
    if (entry.row.received !== undefined) {
      issues.push(
        block(
          'STOCK_RECEIVED',
          'Cantitatea recepționată se indică doar la o achiziție.',
          `stock.lines.${entry.index}`,
        ),
      );
      continue;
    }
    const quantity = parseQuantity(entry.row.quantity)!;
    if (args.atCost && quantity > 0n) {
      const received = (args.atCost.stockMoves ?? []).filter(
        (move) =>
          move.item === entry.item.id && move.warehouse === stock.warehouseId && move.quantity > 0n,
      );
      const units = received.reduce((sum, move) => sum + move.quantity, 0n);
      if (units === 0n) {
        issues.push(
          block(
            'STOCK_RETURN_RECEIPT',
            `Factura inițială nu a recepționat ${entry.item.code} în gestiunea ${warehouse.code}: costul cu care bunurile au intrat nu se cunoaște.`,
            `stock.lines.${entry.index}`,
          ),
        );
        continue;
      }
      // The cost the receipt entered them at: the original's lei, at its own rate.
      const cost = received.reduce((sum, move) => sum + move.bani, 0n);
      entry.value = -prorate(cost, quantity, units);
    }
    const partLine = args.parts[entry.part]!.line!;
    const lots =
      policy.method === 'fifo' || policy.method === 'lifo'
        ? (loaded.stock.get(`${entry.item.id}|${stock.warehouseId}`)?.layers ?? []).filter(
            (layer) => layer.originEntryId === args.originEntryId,
          )
        : null;
    const out = book.giveBack(
      {
        item: entry.item.id,
        warehouse: stock.warehouseId,
        account: entry.item.account,
        quantity,
        date,
      },
      entry.value,
      partLine,
      policy,
      lots?.map((lot) => lot.id) ?? null,
      expenseFor(accounts, entry.item.account) ?? undefined,
      average,
    );
    issues.push(...out);
    rows.push({ line: entry.row.line, item: entry.item.code, quantity: entry.row.quantity });
  }
  // In a currency, each stock part's line is what its goods left at, in lei.
  let shift = 0n;
  if (args.atCost)
    args.parts.forEach((part, p) => {
      const members = mapped.filter((entry) => entry.part === p);
      if (
        part.line === undefined ||
        !members.some((entry) => parseQuantity(entry.row.quantity)! > 0n)
      )
        return;
      const { currency: _currency, ...line } = lines[part.line]!;
      const signed = members.reduce((sum, entry) => sum + entry.value, 0n);
      const bani = line.side === 'D' ? signed : -signed;
      shift += line.side === 'D' ? bani - line.bani : line.bani - bani;
      lines[part.line] = { ...line, bani };
    });
  return {
    issues,
    openItems: [],
    book: issues.some((issue) => issue.severity === 'block') ? null : book,
    details: {
      warehouseId: stock.warehouseId,
      method: policy.method,
      ...(average ? { returns: 'average' } : {}),
      ...(args.atCost ? { atCost: true } : {}),
      lines: rows,
    },
    shift,
  };
}

/** Whether a sale's original was booked in an earlier financial year than its credit note: a
 * return then corrects the earlier year through 418/408 (OMFP 1802/2014 pct. 330), which the
 * register does not cover. */
export function returnFromPriorYear(loaded: Loaded, original: PostedEntry, date: LocalDate) {
  const before = financialYearOf(loaded, original.date);
  const now = financialYearOf(loaded, date);
  return before !== undefined && now !== undefined && before.id !== now.id;
}
