import { z } from 'zod';
import {
  accountCodePattern,
  isStockAccount,
  type Issue,
  type LineSpec,
  type Loaded,
} from '../../kernel';
import { allocate, parseMoney } from '../../money';
import type { RuleContext } from '../../rules';
import type { LocalDate } from '../../time';
import type { InvoiceDocument } from '../../ubl/invoice-document';
import { receiveInvoiceStock, type InvoiceStock, type StockResult } from '../stock/invoices';

/*
 * The goods of a purchase across the border (an intra-community acquisition, an import): the
 * invoice's net split over its accounts, each part in lei with its share of what enters the
 * goods' cost besides the price (customs duties, VAT not deducted), and the goods received into
 * the stock register (G1, the NIR) when the parts are on stock accounts.
 */

const block = (code: string, message: string, path?: string): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
});

/** A purchase's goods: on stock accounts with `stock`, or on an expense or a fixed asset. */
const purchaseAccount = /^(6|2[01])/;

export const goodsParts = z
  .array(
    z
      .object({
        account: z.string().regex(accountCodePattern),
        amount: z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/),
      })
      .strict(),
  )
  .min(1)
  .max(50);

export interface GoodsBooking {
  lines: LineSpec[];
  /** The indexes of the parts' lines. */
  partLines: number[];
  stock: StockResult | null;
  issues: Issue[];
}

/** The key the stock register maps the invoice's lines to its parts with: one category. */
const KEY = 'goods';

/**
 * The parts' lines, in lei: `net` (the invoice's net at its rate) split by the parts' amounts,
 * each with its share of `cost` (duties, VAT not deducted). With `stock`, the parts must be on
 * the items' stock accounts and the goods enter the register.
 */
export function bookGoods(args: {
  body: InvoiceDocument;
  account?: string;
  allocations?: z.infer<typeof goodsParts>;
  stock?: InvoiceStock;
  net: bigint;
  cost: bigint;
  loaded: Loaded;
  rules: RuleContext;
  date: LocalDate;
  partyId: string;
  documentId: string;
  memo: string;
}): GoodsBooking {
  const { body } = args;
  const issues: Issue[] = [];
  const minor = (value: string) => parseMoney(value, body.currency);
  const parts = args.allocations ?? [{ account: args.account!, amount: body.totals.net }];
  const total = parts.reduce((sum, part) => sum + minor(part.amount), 0n);
  if (total !== minor(body.totals.net))
    issues.push(
      block(
        'ALLOCATION',
        `Părțile însumează ${total} unități minore, iar factura ${minor(body.totals.net)}: repartizați întreaga valoare netă.`,
        'allocations',
      ),
    );
  parts.forEach((part, index) => {
    const stockAccount = isStockAccount(part.account);
    if (stockAccount && !args.stock)
      issues.push(
        block(
          'ACCOUNT',
          `Contul ${part.account} este un cont de stocuri: indicați recepția bunurilor în gestiune (stock).`,
          args.allocations ? `allocations.${index}.account` : 'account',
        ),
      );
    if (!stockAccount && !purchaseAccount.test(part.account))
      issues.push(
        block(
          'ACCOUNT',
          'Folosiți un cont de stocuri (cu recepția în gestiune), de cheltuieli (6xx) sau de imobilizări (20x, 21x).',
          args.allocations ? `allocations.${index}.account` : 'account',
        ),
      );
  });
  if (issues.length) return { lines: [], partLines: [], stock: null, issues };
  const weights = parts.map((part) => minor(part.amount));
  const lei = weights.some((weight) => weight !== 0n)
    ? allocate(args.net, weights)
    : weights.map(() => 0n);
  const extra = args.cost
    ? weights.some((weight) => weight !== 0n)
      ? allocate(args.cost, weights)
      : weights.map(() => 0n)
    : weights.map(() => 0n);
  const lines: LineSpec[] = parts.map((part, index) => ({
    account: part.account,
    side: 'D',
    bani: lei[index]! + extra[index]!,
    memo: args.memo,
  }));
  const partLines = parts.map((_, index) => index);
  let stock: StockResult | null = null;
  if (args.stock) {
    stock = receiveInvoiceStock({
      stock: args.stock,
      loaded: args.loaded,
      rules: args.rules,
      date: args.date,
      partyId: args.partyId,
      documentId: args.documentId,
      invoiceLines: body.lines.map((line) => ({
        id: line.id,
        key: KEY,
        net: minor(line.net),
      })),
      parts: parts.map((part, index) => ({ account: part.account, vat: KEY, line: index })),
      lines,
    });
    issues.push(...stock.issues);
  }
  return { lines, partLines, stock, issues };
}
