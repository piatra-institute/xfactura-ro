import { LEDGER_CURRENCY } from 'xfactura-core/money';
import type {
  D406Filed,
  D406FiledInvoice,
  D406FiledJournal,
  D406FiledPayment,
  D406FiledTransaction,
} from 'xfactura-core/ro/saft/read';
import { isLocalDate, type LocalDate } from 'xfactura-core/time';
import { add } from '../compare/decimal';
import type { SourceJournalTransaction } from '../compare/journals';
import type { DifferenceClass } from '../compare/differences';
import type { MigrationJournalInput } from '../treatments/journal';
import { money, negate, sameAmount } from './amounts';
import { comparedTaxes, translateTaxes, type ReadingTable, type TaxRefusal } from './taxes';
import { ResolutionError, type ReplayMapping } from './view';

type Line = MigrationJournalInput['lines'][number];
type NewItem = MigrationJournalInput['newItems'][number];

/** Open-item kinds whose balance normally sits on the debit side, as the chart derives them. */
const debitKinds = new Set([
  'receivable',
  'advance.paid',
  'accrual.receivable',
  'deferral.expense',
  'tax.receivable',
  'unapplied.payment',
]);

/**
 * An open item the replay knows: an engine account, a party key, the document it carries (null
 * for a party's unallocated item, which also carries its opening balance) and its currency.
 */
export const itemKey = (
  account: string,
  party: string,
  document: string | null,
  currency: string,
): string => JSON.stringify([account, party, document, currency]);

/**
 * The engine's open items by their replay key. A key that a second item takes (one partner's
 * document number reused on one account) becomes ambiguous: neither item is found by it again.
 */
export class ItemIndex {
  private readonly items = new Map<string, string>();
  private readonly ambiguous = new Set<string>();
  /** Items opened in all, ambiguous keys' included. */
  size = 0;
  /** The item a key names, or undefined when it names none or is ambiguous. */
  get(key: string): string | undefined {
    return this.ambiguous.has(key) ? undefined : this.items.get(key);
  }
  isAmbiguous(key: string): boolean {
    return this.ambiguous.has(key);
  }
  /** Whether a key already names an item, or did before it became ambiguous. */
  has(key: string): boolean {
    return this.items.has(key);
  }
  set(key: string, id: string) {
    this.size++;
    if (this.items.has(key)) this.ambiguous.add(key);
    else this.items.set(key, id);
  }
}

/** Every filed invoice by number, with the engine account and party it was booked on. */
export type InvoiceIndex = Map<
  string,
  { account: string | undefined; party: string | undefined; posting: string }[]
>;

/** A GL transaction's place in the run: its filing's selection start and TransactionID. */
export const postingKey = (periodStart: string, transaction: string | undefined) =>
  `${periodStart}/${transaction ?? ''}`;

export function invoiceIndex(filed: readonly D406Filed[], mapping: ReplayMapping): InvoiceIndex {
  const index: InvoiceIndex = new Map();
  for (const file of filed)
    for (const [section, role] of [
      ['salesInvoices', 'customer'],
      ['purchaseInvoices', 'supplier'],
    ] as const)
      for (const invoice of file.sourceDocuments[section]?.invoices ?? []) {
        if (!invoice.number) continue;
        const list = index.get(invoice.number) ?? [];
        list.push({
          account: mapping.account(invoice.account)?.code,
          party: invoice.party?.id
            ? mapping.partyOf({ origin: 'd406', role, id: invoice.party.id })
            : undefined,
          posting: postingKey(file.header.selection.start ?? '', invoice.transaction),
        });
        index.set(invoice.number, list);
      }
  return index;
}

/** A settlement whose document's item the replay could not find. */
export type SettlementNote = {
  line: number;
  account: string;
  party: string;
  document: string | null;
  class: Extract<DifferenceClass, 'mapping' | 'source-inconsistency' | 'unsupported'>;
  reason: string;
};

export type TranslationContext = {
  mapping: ReplayMapping;
  /** The period's filing: its invoices and payments name the transactions they were booked by. */
  filed: D406Filed;
  /** The filing's selection start, which prefixes each reference. */
  periodStart: string;
  evidenceId: string;
  items: ItemIndex;
  partyId: (key: string) => string | undefined;
  invoices: InvoiceIndex;
  /** What became of each transaction the run has already replayed, by `postingKey`. */
  postings?: ReadonlyMap<string, 'posted' | 'refused'>;
  readings?: ReadingTable;
};

/** An invoice whose document key already names an item. */
export type ReusedKey = { line: number; account: string; party: string; document: string };

export type Translated = {
  reference: string;
  /** Decisions of the tax translation a reader of the transaction's differences should know. */
  notes: string[];
  /** The filed transaction as the journal comparison reads it, with its tax supplements. */
  comparison: SourceJournalTransaction;
  /** Engine accounts of the lines that could be mapped. */
  accounts: string[];
  /** Lab assumptions the transaction rests on. */
  assumptions: string[];
} & (
  | {
      ok: true;
      input: MigrationJournalInput;
      /** New items and the keys they take once posted. */
      newItems: { ref: string; key: string }[];
      settlements: SettlementNote[];
      reused: ReusedKey[];
      /** Lines that settle an item their document already names. */
      settledByDocument: number;
    }
  | { ok: false; refusal: TaxRefusal }
);

/** The reference of a filed transaction: its filing's period start, journal and TransactionID
 * (its position in the journal when it has none). */
export const transactionReference = (
  periodStart: string,
  journal: D406FiledJournal,
  transaction: D406FiledTransaction,
) =>
  `${periodStart}/${journal.id ?? ''}/${transaction.id ?? `#${journal.transactions.indexOf(transaction)}`}`;

/** The transaction's Period and PeriodYear as YYYY-MM, or null. */
export function transactionMonth(transaction: D406FiledTransaction): string | null {
  if (
    !/^\d{4}$/.test(transaction.periodYear ?? '') ||
    !/^(?:0?[1-9]|1[0-2])$/.test(transaction.period ?? '')
  )
    return null;
  return `${transaction.periodYear}-${transaction.period!.padStart(2, '0')}`;
}

type Linked = {
  invoices: { invoice: D406FiledInvoice; role: 'customer' | 'supplier' }[];
  payments: D406FiledPayment[];
};

/** The invoices and payments that name each GL transaction as their posting. */
export function linkedDocuments(filed: D406Filed): Map<string, Linked> {
  const links = new Map<string, Linked>();
  const of = (id: string) => {
    let linked = links.get(id);
    if (!linked) links.set(id, (linked = { invoices: [], payments: [] }));
    return linked;
  };
  for (const [section, role] of [
    ['salesInvoices', 'customer'],
    ['purchaseInvoices', 'supplier'],
  ] as const)
    for (const invoice of filed.sourceDocuments[section]?.invoices ?? [])
      if (invoice.transaction) of(invoice.transaction).invoices.push({ invoice, role });
  for (const payment of filed.sourceDocuments.payments?.payments ?? [])
    if (payment.transaction) of(payment.transaction).payments.push(payment);
  return links;
}

const document = (value: string | undefined) =>
  value === undefined || value === '' || value === '0' ? null : value;

/**
 * One filed GL transaction as one `migration.journal` input: mapped accounts, the filed sides
 * and amounts, the party of each control line, its open item and its tax entries. Nothing is
 * computed: amounts, currencies and rates are the filed ones. A transaction that cannot be
 * expressed is refused with a code, never adjusted.
 */
export function translateTransaction(
  journal: D406FiledJournal,
  transaction: D406FiledTransaction,
  context: TranslationContext,
  links: Map<string, Linked> = linkedDocuments(context.filed),
): Translated {
  const { mapping } = context;
  const reference = transactionReference(context.periodStart, journal, transaction);
  const compared = comparedTaxes(
    transaction,
    transaction.lines.map((line) => mapping.account(line.account)?.code),
    context.readings,
  );
  const notes: string[] = [];
  const assumptions = new Set<string>();
  const accounts: string[] = [];
  const base = () => ({
    reference,
    notes: [...notes],
    comparison: {
      source: mapping.source,
      reference,
      transaction: {
        ...transaction,
        lines: transaction.lines.map((line, l) => ({ ...line, tax: compared[l]! })),
      },
    } as SourceJournalTransaction,
    accounts: [...new Set(accounts)],
    assumptions: [...assumptions].sort(),
  });
  const refuse = (code: string, message: string): Translated => ({
    ...base(),
    ok: false,
    refusal: { code, message },
  });

  for (const line of transaction.lines) {
    for (const id of line.account ? mapping.sourceAccountAssumptions(line.account) : [])
      assumptions.add(id);
    const target = mapping.account(line.account);
    if (target) accounts.push(target.code);
  }
  const date = transaction.posted ?? transaction.date;
  const month = transactionMonth(transaction);
  if (!date || !isLocalDate(date) || !month)
    return refuse('TRANSACTION_DATE', 'Nota nu are o dată sau o perioadă valabilă.');
  const taxPoint = (
    transaction.date && isLocalDate(transaction.date) ? transaction.date : date
  ) as LocalDate;

  const linked = links.get(transaction.id ?? '') ?? { invoices: [], payments: [] };
  const lines: Line[] = [];
  const currencies: string[] = [];
  for (const line of transaction.lines) {
    const target = mapping.account(line.account);
    if (!target) return refuse('ACCOUNT_UNMAPPED', 'Contul liniei nu este mapat.');
    if (line.side !== 'debit' && line.side !== 'credit')
      return refuse('LINE_SIDE', 'Linia nu are sens debit sau credit.');
    const amount = money(line.amount?.amount);
    if (amount === null) return refuse('AMOUNT_FORMAT', 'Suma liniei nu are două zecimale.');
    const code = line.amount?.currencyCode;
    let currency: Line['currency'];
    if (code && code !== LEDGER_CURRENCY) {
      const { currencyAmount, exchangeRate } = line.amount!;
      if (currencyAmount === undefined || exchangeRate === undefined)
        return refuse('CURRENCY_INCOMPLETE', 'Linia în valută nu are suma sau cursul.');
      currency = { code, amount: currencyAmount, rate: exchangeRate, rateId: 'd406' };
    }
    currencies.push(currency?.code ?? LEDGER_CURRENCY);
    lines.push({
      account: target.code,
      side: line.side === 'debit' ? 'D' : 'C',
      amount,
      ...(currency ? { currency } : {}),
    });
  }

  // The invoices this transaction books, with the engine account and party of each.
  const invoices = linked.invoices.flatMap(({ invoice, role }) => {
    const party = invoice.party?.id
      ? mapping.partyOf({ origin: 'd406', role, id: invoice.party.id })
      : undefined;
    const account = mapping.account(invoice.account)?.code;
    return invoice.number && party && account ? [{ number: invoice.number, party, account }] : [];
  });
  const invoiceParty =
    new Set(invoices.map((item) => item.party)).size === 1
      ? context.partyId(invoices[0]!.party)
      : undefined;
  const taxes = translateTaxes({
    transaction,
    lines: lines.map((line) => ({ account: line.account, side: line.side, amount: line.amount })),
    taxPoint,
    period: month,
    ...(invoiceParty ? { partyId: invoiceParty } : {}),
    ...(context.readings ? { readings: context.readings } : {}),
  });
  if ('code' in taxes) return refuse(taxes.code, taxes.message);
  notes.push(...taxes.notes);
  for (const [l, settlement] of taxes.settlements) lines[l]!.taxSettlement = settlement;

  const usedPayments = new Set<object>();
  const paymentDocument = (l: number, party: string): string | null | undefined => {
    const line = transaction.lines[l]!;
    for (const payment of linked.payments)
      for (const candidate of payment.lines) {
        if (usedPayments.has(candidate)) continue;
        if (candidate.account !== line.account) continue;
        if (!sameAmount(candidate.amount?.amount, line.amount?.amount)) continue;
        const named = (['customer', 'supplier'] as const).flatMap((role) => {
          const id = candidate[role];
          return id && id !== '0' && id !== mapping.ownMarker
            ? [mapping.partyOf({ origin: 'd406', role, id })]
            : [];
        });
        if (named.length && !named.includes(party)) continue;
        usedPayments.add(candidate);
        return document(candidate.document);
      }
    return undefined;
  };

  const newItems: (NewItem & { key: string; net: string; normal: 'D' | 'C' })[] = [];
  const settlements: SettlementNote[] = [];
  const reused: ReusedKey[] = [];
  let settledByDocument = 0;
  const declare = (key: string, party: string, invoice: boolean, normal: 'D' | 'C') => {
    let item = newItems.find((candidate) => candidate.key === key);
    if (!item) {
      const partyId = context.partyId(party)!;
      item = { ref: `i${newItems.length + 1}`, partyId, key, net: '0', normal };
      // A party's unallocated item may cross sides; an invoice's only when it opens there.
      if (!invoice) item.mayReverse = true;
      newItems.push(item);
    }
    return item;
  };
  for (const [l, line] of lines.entries()) {
    const target = mapping.account(transaction.lines[l]!.account)!;
    const kind = target.controlKind;
    if (!kind || kind === 'tax' || kind === 'retail') continue;
    let party: string;
    try {
      party = mapping.lineParty(transaction, transaction.lines[l]!, target);
    } catch (error) {
      if (error instanceof ResolutionError)
        return refuse(error.code, 'Linia de control nu are un partener.');
      throw error;
    }
    for (const id of mapping.partyAssumptions(party)) assumptions.add(id);
    const partyId = context.partyId(party);
    if (!partyId) return refuse('PARTY_UNAVAILABLE', 'Partenerul nu a putut fi creat.');
    line.partyId = partyId;
    const currency = currencies[l]!;
    const normal = debitKinds.has(kind) ? 'D' : 'C';
    const own = invoices.filter((item) => item.account === line.account && item.party === party);
    if (own.length > 1)
      return refuse('INVOICE_LINES_AMBIGUOUS', 'Mai multe facturi au același cont și partener.');
    let key: string;
    let invoice = false;
    let named: string | null | undefined;
    if (own.length === 1) {
      invoice = true;
      named = own[0]!.number;
      key = itemKey(line.account, party, named, currency);
      // The invoice still opens its own item; the key it shares becomes ambiguous once posted.
      if (context.items.has(key) && !reused.some((item) => item.document === named))
        reused.push({ line: l, account: line.account, party, document: named });
    } else {
      named = document(transaction.lines[l]!.document) ?? paymentDocument(l, party);
      const documentKey = named ? itemKey(line.account, party, named, currency) : null;
      const known = documentKey ? context.items.get(documentKey) : undefined;
      const found =
        documentKey && (known ?? newItems.find((candidate) => candidate.key === documentKey)?.ref);
      if (documentKey && found) {
        key = documentKey;
        if (known) settledByDocument++;
      } else {
        key = itemKey(line.account, party, null, currency);
        // A settlement with a partner the source names is noted when its item is unknown; a
        // placeholder party's lines (taxes, payroll) have no documents and keep one item.
        if ((named || linked.payments.length) && !mapping.isPlaceholderParty(party)) {
          const filed = named
            ? (context.invoices.get(named) ?? []).filter((item) => item.party === party)
            : [];
          const own = filed.filter((item) => item.account === line.account);
          const state = (item: (typeof own)[number]) => context.postings?.get(item.posting);
          const reason = !named
            ? 'SETTLEMENT_NO_DOCUMENT'
            : documentKey && context.items.isAmbiguous(documentKey)
              ? 'SETTLEMENT_DOCUMENT_AMBIGUOUS'
              : !filed.length
                ? 'SETTLEMENT_DOCUMENT_UNFILED'
                : !own.length
                  ? 'SETTLEMENT_DOCUMENT_ELSEWHERE'
                  : own.some((item) => state(item) === undefined)
                    ? 'SETTLEMENT_BEFORE_INVOICE'
                    : own.some((item) => state(item) === 'refused')
                      ? 'SETTLEMENT_INVOICE_REFUSED'
                      : 'SETTLEMENT_ITEM_NOT_OPEN';
          settlements.push({
            line: l,
            account: line.account,
            party,
            document: named ?? null,
            class:
              reason === 'SETTLEMENT_DOCUMENT_ELSEWHERE' ||
              reason === 'SETTLEMENT_DOCUMENT_AMBIGUOUS'
                ? 'source-inconsistency'
                : reason === 'SETTLEMENT_INVOICE_REFUSED'
                  ? 'unsupported'
                  : 'mapping',
            reason,
          });
        }
      }
    }
    if (named) line.memo = `Document ${named}`.slice(0, 500);
    const existing = invoice ? undefined : context.items.get(key);
    if (existing) {
      line.openItem = existing;
      continue;
    }
    const item = declare(key, party, invoice, normal);
    line.newItem = item.ref;
    item.net = add(item.net, line.side === 'D' ? line.amount : negate(line.amount))!;
  }
  for (const item of newItems)
    if (item.mayReverse === undefined) {
      const net = item.net.startsWith('-') ? 'C' : item.net === '0' ? item.normal : 'D';
      item.mayReverse = net !== item.normal;
    }

  return {
    ...base(),
    comparison: { ...base().comparison, taxEntries: taxes.supplements },
    ok: true,
    input: {
      source: mapping.source,
      reference,
      evidenceId: context.evidenceId,
      date: date as LocalDate,
      journalCode: (journal.id ?? 'D406').slice(0, 100) || 'D406',
      description: (transaction.description || journal.description || 'Notă contabilă D406').slice(
        0,
        1000,
      ),
      lines,
      newItems: newItems.map(({ key: _key, net: _net, normal: _normal, ...item }) => item),
      taxEntries: taxes.entries,
    },
    newItems: newItems.map((item) => ({ ref: item.ref, key: item.key })),
    settlements,
    reused,
    settledByDocument,
  };
}
