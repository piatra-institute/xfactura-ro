import type { Issue, LineSpec, Loaded, OpenItemState, PostedEntry, TaxEntrySpec } from '../kernel';
import { divRound } from '../money';
import type { LocalDate } from '../time';

/**
 * VAT on collection (sistemul TVA la încasare, Codul fiscal art. 282 alin. (3)–(10)): a sale's VAT
 * waits on 4428 until the customer pays, and so does the deduction of a purchase made by a company
 * applying the system (art. 297 alin. (3)) or from a supplier applying it (art. 297 alin. (2)).
 *
 * The books keep the deferral on the invoice's tax entries: one per VAT category, with no
 * exigibility, on 4428, in the tax period of the invoice. Each collection or payment releases its
 * share (4428 to 4427, or 4426 to 4428) as a pair of tax entries in its own period: the deferred
 * side, still without exigibility, takes the share off the invoice's deferral; the chargeable side
 * declares it. A credit note reduces the deferral first (art. 282 alin. (10)). Every entry of an
 * invoice's deferral carries the invoice's document as its `invoice` attribute, so the invoice's
 * open item and its history say what is still deferred.
 */
export const cashVatClauses = {
  chargeability: 'ANAF/Cod-fiscal-consolidat:art.282(3)',
  scope: 'ANAF/Cod-fiscal-consolidat:art.282(6)',
  transition: 'ANAF/Cod-fiscal-consolidat:art.282(7)',
  share: 'ANAF/Cod-fiscal-consolidat:art.282(8)',
  corrections: 'ANAF/Cod-fiscal-consolidat:art.282(10)',
  supplier: 'ANAF/Cod-fiscal-consolidat:art.297(2)',
  own: 'ANAF/Cod-fiscal-consolidat:art.297(3)',
  mention: 'ANAF/Cod-fiscal-consolidat:art.319(20)(p)',
} as const;

/** The mention an invoice under the system carries (art. 319 alin. (20) lit. p)), in BT-22. */
export const cashVatMention = 'TVA la încasare';

/** Whether a text carries the mention, with or without diacritics, in any case. */
export function mentionsCashVat(text: string): boolean {
  return /\bTVA\s+la\s+[îi]ncasare\b/iu.test(text.normalize('NFC'));
}

/** Who applies the system to an operation, as its tax entries' `cashVat` attribute records it:
 * the company itself (a sale, or a purchase under art. 297 alin. (3)), the supplier (a purchase
 * under art. 297 alin. (2)), or both. */
export type CashVatParty = 'own' | 'supplier' | 'own+supplier';

export const supplierAppliesCashVat = (value: string | undefined) =>
  value === 'supplier' || value === 'own+supplier';

/** A tax entry's amounts: base, VAT, deductible VAT and the amount booked on its tax line. */
export type CashVatAmounts = { base: bigint; tax: bigint; deductible: bigint; ledger: bigint };

const fields = ['base', 'tax', 'deductible', 'ledger'] as const;
const none = (): CashVatAmounts => ({ base: 0n, tax: 0n, deductible: 0n, ledger: 0n });
const map = (f: (field: (typeof fields)[number]) => bigint): CashVatAmounts =>
  Object.fromEntries(fields.map((field) => [field, f(field)])) as CashVatAmounts;
export const amountsOf = (entry: TaxEntrySpec): CashVatAmounts => ({
  base: entry.baseBani,
  tax: entry.taxBani,
  deductible: entry.deductibleBani,
  ledger: entry.ledgerBani,
});
const plus = (a: CashVatAmounts, b: CashVatAmounts) => map((field) => a[field] + b[field]);
const minus = (a: CashVatAmounts, b: CashVatAmounts) => map((field) => a[field] - b[field]);
const isZero = (a: CashVatAmounts) => fields.every((field) => a[field] === 0n);

/** One VAT category of an invoice under the system. */
export type DeferredCategory = {
  /** The invoice's tax entry: its key, code (S-<rate>), direction, tax point and attributes. */
  origin: TaxEntrySpec;
  /** Still deferred: on 4428 (`ledger`), with its base, VAT and deductible VAT. */
  remaining: CashVatAmounts;
  /** Deferred after the invoice or its latest correction; with `anchorBalance`, what the share
   * of each later collection or payment is computed from. */
  anchor: CashVatAmounts;
  /** Released since the anchor. */
  released: CashVatAmounts;
};

/** An invoice's deferred VAT as its open item's history leaves it. */
export type DeferredInvoice = {
  item: OpenItemState;
  /** The invoice's entry and document. */
  origin: PostedEntry;
  documentId: string;
  direction: 'output' | 'input';
  /** Still to collect or pay, and as it stood at the anchor. */
  balance: bigint;
  anchorBalance: bigint;
  categories: DeferredCategory[];
};

const block = (code: string, message: string): Issue => ({ code, severity: 'block', message });

/**
 * What an invoice's open item still defers, from the item's history (`history`, its entries read
 * with `entries`): null for an invoice outside the system. Collections and payments (bank and cash
 * journals) release their share; credit notes reduce the deferral and start a new anchor. Any
 * other movement on the item (a compensation or write-off by general journal) is refused: the
 * release it would need is not computed.
 */
export function deferredInvoice(
  item: OpenItemState,
  loaded: Pick<Loaded, 'entries'>,
): DeferredInvoice | Issue | null {
  const origin = loaded.entries.get(item.originEntryId);
  if (!item.documentId) return null;
  if (!origin || !item.history)
    return block(
      'CASH_VAT_HISTORY',
      'Istoricul poziției facturii nu este disponibil: TVA la încasare nu se poate calcula.',
    );
  const tied = (entry: PostedEntry) =>
    entry.taxEntries.filter(
      (tax) => tax.tax === 'VAT' && tax.attributes.invoice === item.documentId,
    );
  const deferred = tied(origin).filter((tax) => tax.exigibility === null);
  if (!deferred.length) return null;
  // How much an entry reduced what is still to collect or pay.
  const reduction = (entry: PostedEntry) =>
    entry.lines
      .filter((line) => line.openItem === item.id)
      .reduce((sum, line) => sum + (line.side === item.normalSide ? -line.bani : line.bani), 0n);
  const categories: DeferredCategory[] = deferred.map((origin) => ({
    origin,
    remaining: amountsOf(origin),
    anchor: amountsOf(origin),
    released: none(),
  }));
  const category = (tax: TaxEntrySpec) =>
    categories.find(
      (item) => item.origin.code === tax.code && item.origin.direction === tax.direction,
    );
  let balance = -reduction(origin);
  let anchorBalance = balance;
  for (const id of item.history) {
    if (id === origin.id) continue;
    const entry = loaded.entries.get(id);
    if (!entry)
      return block(
        'CASH_VAT_HISTORY',
        'O înregistrare a poziției facturii nu este disponibilă: TVA la încasare nu se poate calcula.',
      );
    const taxes = tied(entry);
    const moved = reduction(entry);
    if (taxes.some((tax) => tax.attributes.release)) {
      for (const tax of taxes) {
        const target = category(tax);
        if (!target)
          return block(
            'CASH_VAT_HISTORY',
            `Nota ${entry.number} eliberează TVA pe o cotă pe care factura nu o amână.`,
          );
        if (tax.exigibility === null) target.remaining = plus(target.remaining, amountsOf(tax));
        else target.released = plus(target.released, amountsOf(tax));
      }
      balance -= moved;
    } else if (taxes.length) {
      // A correction (credit note, reversal): what it took off the deferral, then a new anchor.
      // A category the invoice did not defer (a non-deductible purchase) has nothing to take.
      for (const tax of taxes) {
        const target = category(tax);
        if (target && tax.exigibility === null)
          target.remaining = plus(target.remaining, amountsOf(tax));
      }
      balance -= moved;
      for (const target of categories) {
        target.anchor = target.remaining;
        target.released = none();
      }
      anchorBalance = balance;
    } else if (entry.journalCode === 'BANCA' || entry.journalCode === 'CASA') balance -= moved;
    else
      return block(
        'CASH_VAT_MOVEMENT',
        `Factura are TVA la încasare, iar nota ${entry.number} (${entry.description}) îi modifică soldul fără a fi o încasare, o plată sau o notă de credit: TVA neexigibilă aferentă nu se poate stabili automat. Stornați nota și înregistrați încasarea sau plata.`,
      );
  }
  const outstanding = item.normalSide === 'D' ? item.balanceBani : -item.balanceBani;
  if (balance !== outstanding)
    return block(
      'CASH_VAT_HISTORY',
      'Istoricul poziției facturii nu explică soldul ei: TVA la încasare nu se poate calcula.',
    );
  return {
    item,
    origin,
    documentId: item.documentId,
    direction: deferred[0]!.direction,
    balance,
    anchorBalance,
    categories,
  };
}

/**
 * The share of each category's deferral a collection or payment of `settled` releases, with
 * cumulative rounding: round(anchor × settled since the anchor / anchor balance) less what was
 * released since the anchor. Without corrections the anchor is the invoice, so the release is
 * round(VAT × settled to date / gross) − round(VAT × settled before / gross), and settling the
 * whole balance releases exactly what is left.
 */
export function releasedShare(invoice: DeferredInvoice, settled: bigint) {
  const after = invoice.balance - settled;
  const since = invoice.anchorBalance - after;
  return invoice.categories.map((category) => ({
    category,
    amounts:
      invoice.anchorBalance <= 0n
        ? none()
        : map(
            (field) =>
              divRound(category.anchor[field] * since, invoice.anchorBalance, 'halfAwayFromZero') -
              category.released[field],
          ),
  }));
}

/**
 * Books the release of a collection (a sale: Dr 4428 / Cr 4427) or a payment (a purchase:
 * Dr 4426 / Cr 4428), appending its lines to `lines`: per category, the deferred side and the
 * chargeable side, linked to the invoice's tax entry, in the tax period of `date`.
 */
export function bookRelease(
  invoice: DeferredInvoice,
  settled: bigint,
  date: LocalDate,
  taxPeriod: string,
  lines: LineSpec[],
): TaxEntrySpec[] {
  const taxEntries: TaxEntrySpec[] = [];
  const sale = invoice.direction === 'output';
  const release = sale ? 'collection' : 'payment';
  for (const { category, amounts } of releasedShare(invoice, settled)) {
    if (isZero(amounts)) continue;
    const { origin } = category;
    const common = {
      tax: origin.tax,
      code: origin.code,
      direction: origin.direction,
      taxPoint: origin.taxPoint,
      taxPeriod,
      ...(origin.partyId ? { partyId: origin.partyId } : {}),
      documentId: invoice.documentId,
      originTaxEntry: `${invoice.origin.id}:${origin.key}`,
      attributes: { ...origin.attributes, release },
    };
    const line = (account: string, side: 'D' | 'C') => {
      if (amounts.ledger === 0n) return {};
      lines.push({ account, side, bani: amounts.ledger });
      return { line: lines.length - 1 };
    };
    const key = `release:${invoice.item.id}:${origin.key}`;
    const deferred = (): TaxEntrySpec => ({
      ...common,
      key: `${key}:deferred`,
      baseBani: -amounts.base,
      taxBani: -amounts.tax,
      deductibleBani: -amounts.deductible,
      ledgerBani: -amounts.ledger,
      exigibility: null,
      ...line('4428', sale ? 'D' : 'C'),
    });
    const chargeable = (): TaxEntrySpec => ({
      ...common,
      key,
      baseBani: amounts.base,
      taxBani: amounts.tax,
      deductibleBani: amounts.deductible,
      ledgerBani: amounts.ledger,
      exigibility: date,
      ...line(sale ? '4427' : '4426', sale ? 'C' : 'D'),
    });
    // The debit line first: 4428 for a collection, 4426 for a payment.
    if (sale) taxEntries.push(deferred(), chargeable());
    else taxEntries.push(chargeable(), deferred());
  }
  return taxEntries;
}

/**
 * How a credit note on an invoice under the system splits a category's reduction (positive
 * amounts) between its deferral and the VAT already chargeable (art. 282 alin. (10) lit. a)
 * pct. 2): the deferral is reduced first, and what exceeds it reduces the chargeable VAT on the
 * credit note's date. A credit note that settles the invoice in full takes the whole deferral, so
 * nothing stays on 4428: the difference, of either sign, is chargeable.
 */
export function creditSplit(category: DeferredCategory, credit: CashVatAmounts, settles: boolean) {
  const { remaining } = category;
  const deferred = settles
    ? remaining
    : credit.tax <= remaining.tax
      ? map((field) => (credit[field] < remaining[field] ? credit[field] : remaining[field]))
      : remaining;
  return { deferred, chargeable: minus(credit, deferred) };
}

export const isZeroAmounts = isZero;
