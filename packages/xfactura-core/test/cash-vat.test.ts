import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  validateEffect,
  type AccountInfo,
  type LineSpec,
  type OpenItemState,
  type PostedEntry,
  type TaxEntrySpec,
} from '../src/kernel';
import { divRound } from '../src/money';
import {
  bookRelease,
  creditSplit,
  deferredInvoice,
  mentionsCashVat,
  releasedShare,
  type DeferredInvoice,
} from '../src/ro/cash-vat';
import { parseLocalDate, type LocalDate } from '../src/time';

const day = (text: string) => parseLocalDate(text);
const documentId = 'doc-1';

/** A sale of `base` + `vat` under VAT on collection: its entry and its receivable. */
function sale(base: bigint, vat: bigint) {
  const origin: PostedEntry = {
    id: 'entry-1',
    number: 1,
    date: day('2026-10-05'),
    journalCode: 'VANZARI',
    description: 'Factură emisă XF0001',
    lines: [
      { account: '4111', side: 'D', bani: base + vat, openItem: 'item-1', partyId: 'party' },
      { account: '704', side: 'C', bani: base },
      { account: '4428', side: 'C', bani: vat },
    ],
    taxEntries: [
      {
        key: 'vat',
        tax: 'VAT',
        code: 'S-21',
        direction: 'output',
        baseBani: base,
        taxBani: vat,
        deductibleBani: 0n,
        ledgerBani: vat,
        line: 2,
        taxPoint: day('2026-10-05'),
        exigibility: null,
        taxPeriod: '2026-10',
        partyId: 'party',
        documentId,
        attributes: { cashVat: 'own', invoice: documentId },
      },
    ],
  };
  const item: OpenItemState = {
    id: 'item-1',
    kind: 'receivable',
    controlAccount: '4111',
    partyId: 'party',
    currency: 'RON',
    normalSide: 'D',
    mayReverse: false,
    balanceBani: base + vat,
    balanceMinor: base + vat,
    documentId,
    dueDate: null,
    originEntryId: origin.id,
    movements: 1,
    history: [origin.id],
  };
  return { origin, item, entries: new Map([[origin.id, origin]]) };
}
type Books = ReturnType<typeof sale>;

/** Posts an entry touching the item: its lines on the item move the balance. */
function post(books: Books, entry: Omit<PostedEntry, 'id' | 'number'>) {
  const id = `entry-${books.entries.size + 1}`;
  books.entries.set(id, { ...entry, id, number: books.entries.size + 1 });
  const moved = entry.lines
    .filter((line) => line.openItem === books.item.id)
    .reduce((sum, line) => sum + (line.side === 'D' ? line.bani : -line.bani), 0n);
  books.item = {
    ...books.item,
    balanceBani: books.item.balanceBani + moved,
    balanceMinor: books.item.balanceMinor + moved,
    movements: books.item.movements + 1,
    history: [...books.item.history!, id],
  };
}
const deferral = (books: Books) => deferredInvoice(books.item, books) as DeferredInvoice;

/** Collects `bani` in cash on `date`, releasing what the invoice defers. */
function collect(books: Books, bani: bigint, date = '2026-10-20') {
  const invoice = deferral(books);
  const lines: LineSpec[] = [
    { account: '5311', side: 'D', bani },
    { account: '4111', side: 'C', bani, openItem: books.item.id, partyId: 'party' },
  ];
  const taxEntries = bookRelease(invoice, bani, day(date), date.slice(0, 7), lines);
  post(books, {
    date: day(date),
    journalCode: 'CASA',
    description: 'Încasare',
    lines,
    taxEntries,
  });
  return { lines, taxEntries };
}
const released = (taxEntries: TaxEntrySpec[]) =>
  taxEntries.filter((entry) => entry.exigibility !== null).reduce((sum, e) => sum + e.taxBani, 0n);

describe('the mention of VAT on collection', () => {
  test('is found with or without diacritics, in any case, among other mentions', () => {
    for (const text of ['TVA la încasare', 'TVA LA ÎNCASARE', 'Plata la 30 zile # tva la incasare'])
      expect(mentionsCashVat(text)).toBe(true);
    for (const text of ['TVA încasată', 'TVA la încasarea facturii', 'taxare inversă'])
      expect(mentionsCashVat(text)).toBe(false);
  });
});

describe('the release of deferred VAT', () => {
  test("releases each collection's share with cumulative rounding, all of it in the end", () => {
    // 1,000.00 + 210.00: 500.00 releases 86.78 (210 × 500 / 1,210 = 86.776…), 710.00 the rest.
    const books = sale(100000n, 21000n);
    const first = collect(books, 50000n);
    expect(
      first.taxEntries.map((entry) => [entry.baseBani, entry.taxBani, entry.exigibility]),
    ).toEqual([
      [-41322n, -8678n, null],
      [41322n, 8678n, day('2026-10-20')],
    ]);
    expect(first.lines.slice(2)).toEqual([
      { account: '4428', side: 'D', bani: 8678n },
      { account: '4427', side: 'C', bani: 8678n },
    ]);
    const second = collect(books, 71000n, '2026-11-10');
    expect(released(second.taxEntries)).toBe(12322n);
    expect(second.taxEntries[1]!.taxPeriod).toBe('2026-11');
    expect(deferral(books).categories[0]!.remaining.tax).toBe(0n);
  });

  test('every release is round(VAT × settled to date / gross) less the same before, and they add up', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10_000_000n }),
        fc.array(fc.bigInt({ min: 1n, max: 1_000_000n }), { minLength: 1, maxLength: 8 }),
        (base, parts) => {
          const vat = divRound(base * 21n, 100n, 'halfAwayFromZero');
          const gross = base + vat;
          const books = sale(base, vat);
          let settled = 0n;
          let total = 0n;
          for (const part of parts) {
            const bani = gross - settled < part ? gross - settled : part;
            if (bani <= 0n) break;
            const { taxEntries } = collect(books, bani);
            const before = divRound(vat * settled, gross, 'halfAwayFromZero');
            settled += bani;
            const after = divRound(vat * settled, gross, 'halfAwayFromZero');
            expect(released(taxEntries)).toBe(after - before);
            total += released(taxEntries);
          }
          if (settled < gross) total += released(collect(books, gross - settled).taxEntries);
          expect(total).toBe(vat);
          expect(deferral(books).categories[0]!.remaining).toEqual({
            base: 0n,
            tax: 0n,
            deductible: 0n,
            ledger: 0n,
          });
        },
      ),
    );
  });

  test('balances as an effect: the deferred and chargeable sides on 4428 and 4427', () => {
    const books = sale(100000n, 21000n);
    const { lines, taxEntries } = collect(books, 60500n);
    const accounts: Record<string, AccountInfo['controlKind']> = {
      '5311': null,
      '4111': 'receivable',
      '4427': 'tax',
      '4428': 'tax',
    };
    const issues = validateEffect(
      {
        schema: 'effect@1',
        date: day('2026-10-20'),
        journalClass: 'general',
        journalCode: 'CASA',
        description: 'Încasare',
        lines,
        openItems: [],
        taxEntries,
        schedules: [],
        explanation: { summary: 'test' },
      },
      {
        account: (code) => ({
          code,
          postable: true,
          controlKind: accounts[code] ?? null,
          validFrom: day('2015-01-01'),
          validTo: null,
        }),
        openItem: () => ({ ...books.item, balanceBani: 121000n, balanceMinor: 121000n }),
      },
    );
    expect(issues).toEqual([]);
  });

  test('a credit note starts a new anchor: the norms example (5,000 + 1,000 VAT at 20%)', () => {
    // Collected 2,000.00: 1,000 × 2,000 / 6,000 = 333.33. A 10% discount (−500, −100) reduces
    // the 666.67 deferred to 566.67, all released by the 3,400.00 left to collect.
    const books = sale(500000n, 100000n);
    expect(released(collect(books, 200000n).taxEntries)).toBe(33333n);
    const category = deferral(books).categories[0]!;
    const split = creditSplit(
      category,
      { base: 50000n, tax: 10000n, deductible: 0n, ledger: 10000n },
      false,
    );
    expect(split.chargeable).toEqual({ base: 0n, tax: 0n, deductible: 0n, ledger: 0n });
    post(books, {
      date: day('2026-11-03'),
      journalCode: 'VANZARI',
      description: 'Notă de credit',
      lines: [
        { account: '4111', side: 'D', bani: -60000n, openItem: books.item.id },
        { account: '704', side: 'C', bani: -50000n },
        { account: '4428', side: 'C', bani: -10000n },
      ],
      taxEntries: [
        {
          ...category.origin,
          key: 'vat',
          baseBani: -50000n,
          taxBani: -10000n,
          ledgerBani: -10000n,
          line: 2,
          taxPoint: day('2026-11-03'),
          taxPeriod: '2026-11',
          documentId: 'credit-1',
          originTaxEntry: `${documentId}:vat`,
        },
      ],
    });
    const anchored = deferral(books);
    expect([anchored.anchorBalance, anchored.categories[0]!.anchor.tax]).toEqual([340000n, 56667n]);
    expect(released(collect(books, 100000n).taxEntries)).toBe(16667n);
    expect(released(collect(books, 240000n).taxEntries)).toBe(40000n);
    expect(deferral(books).categories[0]!.remaining.tax).toBe(0n);
  });

  test('a credit note above the deferral makes the rest chargeable; one settling the invoice takes it all', () => {
    const books = sale(100000n, 21000n);
    collect(books, 100000n);
    const category = deferral(books).categories[0]!;
    // 3,645 left deferred (21,000 − 17,355), 21,000 of balance.
    expect(category.remaining.tax).toBe(3645n);
    const above = creditSplit(
      category,
      { base: 20000n, tax: 4200n, deductible: 0n, ledger: 4200n },
      false,
    );
    expect([above.deferred.tax, above.chargeable.tax]).toEqual([3645n, 555n]);
    const settling = creditSplit(
      category,
      { base: 17355n, tax: 3644n, deductible: 0n, ledger: 3644n },
      true,
    );
    expect([settling.deferred.tax, settling.chargeable.tax]).toEqual([3645n, -1n]);
  });

  test('an invoice outside the system defers nothing; other movements and gaps are refused', () => {
    const books = sale(100000n, 21000n);
    const normal = {
      ...books.origin,
      taxEntries: [
        { ...books.origin.taxEntries[0]!, exigibility: day('2026-10-05'), attributes: {} },
      ],
    };
    expect(deferredInvoice(books.item, { entries: new Map([[normal.id, normal]]) })).toBeNull();
    post(books, {
      date: day('2026-10-12'),
      journalCode: 'DIVERSE',
      description: 'Compensare',
      lines: [
        { account: '401', side: 'D', bani: 10000n },
        { account: '4111', side: 'C', bani: 10000n, openItem: books.item.id },
      ],
      taxEntries: [],
    });
    expect((deferredInvoice(books.item, books) as { code: string }).code).toBe('CASH_VAT_MOVEMENT');
    const fresh = sale(100000n, 21000n);
    const missing = { ...fresh.item, history: [...fresh.item.history!, 'entry-404'] };
    expect((deferredInvoice(missing, fresh) as { code: string }).code).toBe('CASH_VAT_HISTORY');
  });

  test('a payment releases a purchase onto 4426, its debit line first', () => {
    const books = sale(100000n, 21000n);
    const purchase: DeferredInvoice = {
      ...deferral(books),
      direction: 'input',
      categories: deferral(books).categories.map((category) => ({
        ...category,
        origin: { ...category.origin, direction: 'input', deductibleBani: 21000n },
        anchor: { ...category.anchor, deductible: 21000n },
        remaining: { ...category.remaining, deductible: 21000n },
      })),
    };
    const lines: LineSpec[] = [];
    const entries = bookRelease(
      purchase,
      121000n,
      day('2026-10-15') as LocalDate,
      '2026-10',
      lines,
    );
    expect(lines).toEqual([
      { account: '4426', side: 'D', bani: 21000n },
      { account: '4428', side: 'C', bani: 21000n },
    ]);
    expect(entries.map((entry) => [entry.ledgerBani, entry.attributes.release])).toEqual([
      [21000n, 'payment'],
      [-21000n, 'payment'],
    ]);
    expect(releasedShare(purchase, 0n)[0]!.amounts.tax).toBe(0n);
  });
});
