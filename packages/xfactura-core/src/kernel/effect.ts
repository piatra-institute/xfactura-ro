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
] as const;
export type OpenItemKind = (typeof openItemKinds)[number];
/** How an account is controlled: by open items of one kind, by tax entries, or not at all. */
export type ControlKind = OpenItemKind | 'tax';

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

/** Everything a treatment asks the ledger to record. Nothing reaches the books any other way. */
export interface Effect {
  schema: 'effect@1';
  date: LocalDate;
  journalClass: JournalClass;
  /** SAF-T journal identifier, e.g. sales, purchases, bank or general. */
  journalCode: string;
  description: string;
  lines: LineSpec[];
  openItems: OpenItemSpec[];
  taxEntries: TaxEntrySpec[];
  schedules: ScheduleSpec[];
  explanation: Explanation;
}

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
