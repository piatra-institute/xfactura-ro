import type { LocalDate } from '../time';

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type Side = 'D' | 'C';
/** `memo` entries change schedules or references without journal lines. */
export type JournalClass = 'general' | 'memo';

export const openItemKinds = [
  'receivable',
  'payable',
  'advance.paid',
  'advance.received',
  'accrual.payable',
  'accrual.receivable',
  'deferral.expense',
  'deferral.revenue',
  'employee.payable',
  'tax.payable',
  'tax.receivable',
  'unapplied.receipt',
  'unapplied.payment',
  /** Money borrowed (credits, loans, a finance lease's liability), per lender and contract. */
  'loan.payable',
  /** Interest accrued on a loan and not yet paid. */
  'loan.interest',
] as const;
export type OpenItemKind = (typeof openItemKinds)[number];
/** How an account is controlled: by open items of one kind, by tax entries, by the retail
 * price method (`retail`: a warehouse's goods at sale price, their markup and the VAT their price
 * includes, each line tagged with its warehouse, `retail:<id>`), or not at all. */
export type ControlKind = OpenItemKind | 'tax' | 'retail';

export interface LineCurrency {
  code: string;
  /** Signed amount in the currency's minor units; 0 on lines that only adjust RON (FX differences). */
  minor: bigint;
  rateId: string;
  rate: string;
}

export interface LineSpec {
  account: string;
  side: Side;
  /** Signed RON amount in bani. A negative amount is a red storno on the stated side. */
  bani: bigint;
  currency?: LineCurrency;
  partyId?: string;
  /** An existing open item id from the read-set, or the `ref` of an item this effect creates. */
  openItem?: string;
  /** Marks a line on a tax-controlled account that clears a tax period (e.g. VAT settlement to
   * 4423/4424) rather than booking a taxable transaction. */
  taxSettlement?: { tax: string; period: string };
  analytics?: { costCenter?: string; project?: string; item?: string };
  memo?: string;
}

export interface OpenItemSpec {
  ref: string;
  kind: OpenItemKind;
  controlAccount: string;
  partyId: string;
  currency: string;
  /** The side on which the item's balance is expected (D for receivables, C for payables). */
  normalSide: Side;
  /** Whether the balance may cross to the other side (e.g. an overpaid receivable). */
  mayReverse: boolean;
  dueDate?: LocalDate;
  documentId?: string;
}

export interface TaxEntrySpec {
  key: string;
  tax: string;
  /** Semantic code defined by the tax rule package; declaration rows are derived from it. */
  code: string;
  direction: 'output' | 'input';
  baseBani: bigint;
  taxBani: bigint;
  deductibleBani: bigint;
  taxPoint: LocalDate;
  /** Null while the tax is not yet chargeable (e.g. VAT on collection). */
  exigibility: LocalDate | null;
  taxPeriod: string | null;
  /** Index of the tax-controlled line this entry books, and the amount it books there: positive
   * on the credit side for output tax and on the debit side for input tax. Entries without a line
   * (non-deductible VAT, reverse charge memoranda) book 0. */
  line?: number;
  ledgerBani: bigint;
  partyId?: string;
  documentId?: string;
  originTaxEntry?: string;
  currency?: { code: string; baseMinor: bigint; taxMinor: bigint; rateId: string; rate: string };
  attributes: Record<string, string>;
}

export interface ScheduleRow {
  key: string;
  due: LocalDate;
  /** In the open item's currency, in minor units: bani for an item in lei. */
  bani: bigint;
  counterAccount: string;
}

export interface ScheduleSpec {
  ref: string;
  openItem: string;
  version: number;
  method: string;
  rows: ScheduleRow[];
  basis: JsonValue;
}

export interface Explanation {
  summary: string;
  details?: JsonValue;
}

/** How a stock layer is valued when goods leave it (OMFP 1802/2014 pct. 96): a lot of one
 * receipt, consumed first in, first out (`fifo`) or last in, first out (`lifo`), or the weighted-
 * average pool of an item in a warehouse, recomputed after each receipt (`average`) or once a
 * period (`periodic`). */
export const stockLayerMethods = ['fifo', 'lifo', 'average', 'periodic'] as const;
export type StockLayerMethod = (typeof stockLayerMethods)[number];

/**
 * A stock layer an effect creates: a FIFO lot of one receipt, or an item's weighted-average pool
 * in a warehouse, on the item's stock account. Like an open item, it is named by a ref the kernel
 * turns into a stable id; later moves name it by that id.
 */
export interface StockLayerSpec {
  ref: string;
  item: string;
  warehouse: string;
  account: string;
  method: StockLayerMethod;
  /** The day its first quantity entered: FIFO and LIFO consume lots in this order. */
  date: LocalDate;
  /** Whether its quantity may fall below zero (the company's `policy.stock.negative`). */
  mayGoNegative: boolean;
}

/**
 * A quantity and a value entering or leaving a stock layer. Quantities are signed thousandths of
 * the item's unit of measure (3 decimals); values are signed bani. A move explains the amount of
 * one line of the effect on its stock account (`line`), or, without a line, moves goods between
 * warehouses on one account and nets to zero there with the other moves without a line.
 */
export interface StockMoveSpec {
  item: string;
  warehouse: string;
  account: string;
  /** An existing layer id from the read-set, or the `ref` of a layer this effect creates. */
  layer: string;
  quantity: bigint;
  bani: bigint;
  /** Index of the line on `account` whose signed amount (debit positive) this move is part of. */
  line?: number;
}

/** Everything a treatment asks the ledger to record. Nothing reaches the books any other way.
 * `effect@2` adds the stock register's layers and moves; an effect without them stays
 * `effect@1`, so that every effect recorded before hashes as it did. */
export interface Effect {
  schema: 'effect@1' | 'effect@2';
  date: LocalDate;
  journalClass: JournalClass;
  /** SAF-T journal identifier, e.g. sales, purchases, bank or general. */
  journalCode: string;
  description: string;
  lines: LineSpec[];
  openItems: OpenItemSpec[];
  taxEntries: TaxEntrySpec[];
  schedules: ScheduleSpec[];
  /** `effect@2` only: the layers it creates and its moves. */
  stockLayers?: StockLayerSpec[];
  stockMoves?: StockMoveSpec[];
  explanation: Explanation;
}

/** The accounts whose lines the stock register explains by quantity (OMFP 1802/2014, the chart's
 * class 3): raw materials and consumables (301–303), production in progress (331–332), products
 * (341–347), stock held by third parties (351–357), biological assets of the nature of stock
 * (361), goods (371) and packaging (381), their analytics included. Price differences (308, 348,
 * 358, 368, 378, 388), stock in transit (32x) and the adjustments (39x) hold values only. The
 * parameter `ro.stock.accounts` cites them; a test keeps the two equal. */
export const stockAccountSynthetics = [
  '301',
  '302',
  '303',
  '331',
  '332',
  '341',
  '345',
  '346',
  '347',
  '351',
  '354',
  '356',
  '357',
  '361',
  '371',
  '381',
] as const;
export const stockAccountPattern = new RegExp(`^(${stockAccountSynthetics.join('|')})\\d?(\\.|$)`);
export const isStockAccount = (account: string) => stockAccountPattern.test(account);

export type Severity = 'block' | 'ack' | 'info';

/** A finding about a proposal. `block` prevents posting; `ack` requires explicit acknowledgement
 * by the approver; `info` is shown with the proposal. */
export interface Issue {
  code: string;
  severity: Severity;
  message: string;
  path?: string;
  details?: JsonValue;
}

/** Stock quantities are kept in thousandths of the item's unit. */
export const QUANTITY_DECIMALS = 3;
export const quantityPattern = /^-?(0|[1-9]\d{0,14})(\.\d{1,3})?$/;

/** A decimal quantity (`12.5`) in thousandths (`12500n`); null when it is not one. */
export function parseQuantity(text: string): bigint | null {
  if (!quantityPattern.test(text)) return null;
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const value = BigInt(whole!) * 1000n + BigInt(fraction.padEnd(QUANTITY_DECIMALS, '0'));
  return negative ? -value : value;
}

/** Thousandths as a decimal with three places (`12.500`). */
export function formatQuantity(milli: bigint): string {
  const negative = milli < 0n;
  const digits = (negative ? -milli : milli).toString().padStart(4, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -3)}.${digits.slice(-3)}`;
}
