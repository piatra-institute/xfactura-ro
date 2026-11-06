import { describe, expect, test } from 'bun:test';
import { canonical } from '../src/hash';
import {
  isStockAccount,
  stockAccountSynthetics,
  validateEffect,
  type AccountInfo,
  type Effect,
  type LineSpec,
  type Loaded,
  type StockLayerInfo,
  type StockMoveSpec,
} from '../src/kernel';
import { roRegister } from '../src/ro/register';
import { emptyLoaded } from '../src/ro/reviews/specs/world';
import { prorate, StockBook } from '../src/ro/stock';
import type { LocalDate } from '../src/time';

const day = '2026-03-10' as LocalDate;
const account = (code: string): AccountInfo => ({
  code,
  postable: true,
  controlKind: null,
  validFrom: '2015-01-01' as LocalDate,
  validTo: null,
});
const item = { id: 'item', account: '371', unit: 'H87' };
const lot = (quantity: bigint, bani: bigint): StockLayerInfo => ({
  id: 'lot',
  item: 'item',
  warehouse: 'w1',
  account: '371',
  method: 'fifo',
  mayGoNegative: false,
  quantity,
  bani,
});
const context = (layer?: StockLayerInfo) => ({
  account,
  openItem: () => undefined,
  stockLayer: (id: string) => (layer && id === layer.id ? layer : undefined),
  stockItem: (id: string) => (id === 'item' ? item : undefined),
  warehouse: (id: string) => id === 'w1' || id === 'w2',
});
const base = (lines: Effect['lines']): Effect => ({
  schema: 'effect@1',
  date: day,
  journalClass: 'general',
  journalCode: 'DIVERSE',
  description: 'Test',
  lines,
  openItems: [],
  taxEntries: [],
  schedules: [],
  explanation: { summary: 'test' },
});
const receipt = (bani: bigint): Effect => ({
  ...base([
    { account: '371', side: 'D', bani: 10_000n },
    { account: '5121', side: 'C', bani: 10_000n },
  ]),
  schema: 'effect@2',
  stockLayers: [
    {
      ref: 'new',
      item: 'item',
      warehouse: 'w1',
      account: '371',
      method: 'fifo',
      date: day,
      mayGoNegative: false,
    },
  ],
  stockMoves: [
    {
      item: 'item',
      warehouse: 'w1',
      account: '371',
      layer: 'new',
      quantity: 10_000n,
      bani,
      line: 0,
    },
  ],
});
const codes = (effect: Effect, layer?: StockLayerInfo) =>
  validateEffect(effect, context(layer)).map((issue) => issue.code);

describe('the kernel’s stock moves (effect@2)', () => {
  test('an effect@1 keeps no stock keys and its checks are those of before', () => {
    const plain = base([
      { account: '371', side: 'D', bani: 10_000n },
      { account: '5121', side: 'C', bani: 10_000n },
    ]);
    expect(codes(plain)).toEqual([]);
    expect(canonical(plain)).not.toContain('stock');
    // An effect@1 may not carry moves, nor an effect@2 come without them.
    expect(codes({ ...plain, stockMoves: [] })).toEqual(['EFFECT_SCHEMA']);
    expect(codes({ ...plain, schema: 'effect@2', stockMoves: [] })).toEqual(['EFFECT_SCHEMA']);
  });

  test('moves explain their line exactly, on their layer', () => {
    expect(codes(receipt(10_000n))).toEqual([]);
    expect(codes(receipt(9_000n))).toEqual(['STOCK_LINE_MISMATCH']);
    const elsewhere = receipt(10_000n);
    elsewhere.stockMoves![0]!.warehouse = 'w2';
    expect(codes(elsewhere)).toEqual(['STOCK_MOVE_LAYER']);
  });

  test('no lot goes below zero or keeps a value without a quantity', () => {
    const exit = (quantity: bigint, bani: bigint): Effect => ({
      ...base([
        { account: '607', side: 'D', bani },
        { account: '371', side: 'C', bani },
      ]),
      schema: 'effect@2',
      stockLayers: [],
      stockMoves: [
        {
          item: 'item',
          warehouse: 'w1',
          account: '371',
          layer: 'lot',
          quantity: -quantity,
          bani: -bani,
          line: 1,
        },
      ],
    });
    expect(codes(exit(4_000n, 4_000n), lot(10_000n, 10_000n))).toEqual([]);
    expect(codes(exit(11_000n, 11_000n), lot(10_000n, 10_000n))).toEqual(['STOCK_NEGATIVE']);
    expect(codes(exit(10_000n, 9_000n), lot(10_000n, 10_000n))).toEqual(['STOCK_RESIDUAL']);
  });

  test('moves without a line are transfers that net to zero', () => {
    const transfer: Effect = {
      ...base([]),
      journalClass: 'memo',
      schema: 'effect@2',
      stockLayers: [
        {
          ref: 'there',
          item: 'item',
          warehouse: 'w2',
          account: '371',
          method: 'fifo',
          date: day,
          mayGoNegative: false,
        },
      ],
      stockMoves: [
        {
          item: 'item',
          warehouse: 'w1',
          account: '371',
          layer: 'lot',
          quantity: -3_000n,
          bani: -3_000n,
        },
        {
          item: 'item',
          warehouse: 'w2',
          account: '371',
          layer: 'there',
          quantity: 3_000n,
          bani: 3_000n,
        },
      ],
    };
    expect(codes(transfer, lot(10_000n, 10_000n))).toEqual([]);
    transfer.stockMoves![1]!.quantity = 2_000n;
    expect(codes(transfer, lot(10_000n, 10_000n))).toEqual(['STOCK_TRANSFER_UNBALANCED']);
  });

  test('the stock accounts are the register parameter’s, and value shares round half up', () => {
    const version = roRegister().versions.find((item) => item.key === 'ro.stock.accounts')!;
    expect((version.value as { quantity: string[] }).quantity).toEqual([...stockAccountSynthetics]);
    expect(['371', '3021', '371.M1', '308', '378', '397', '327'].map(isStockAccount)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(prorate(12_400n, 2n, 12n)).toBe(2_067n);
    expect(prorate(-12_400n, 2n, 12n)).toBe(-2_067n);
  });
});

// Goods going back to their supplier, on its credit note or by a receipt's storno, valued on their
// own date (StockBook.giveBack, StockBook.reverse). By hand, a pool under the weighted average:
//   1 March 10 in at 100.00; 10 March 10 in at 200.00 (20 at 300.00, 15.00 each); 12 March 15 out
//   at 225.00 (5 at 75.00); 25 March 10 in at 300.00 (15 at 375.00, 25.00 each);
//   2 of the 10 March receipt back on 15 March at 40.00 (20.00 each): at the purchase price the
//     pool keeps 3 at 35.00; at the date's average (15.00) they leave at 30.00, the 10.00 the
//     supplier credits beyond it to 607 (Dr 371 / Cr 607);
//   5 back on 15 March at 100.00: the pool held exactly 5 then, at 75.00, which they take, the
//     25.00 more to 607, whichever the reading; 10 on 15 March: refused, it held 5;
//   the 10 March receipt reversed on 11 March: refused, the exit of the 12th took 15 of the 20;
//     on 26 March: at its 200.00, or at the date's 25.00, 250.00, the 50.00 more against 607.
describe('returns to the supplier on their date', () => {
  const pool = {
    id: 'pool',
    item: 'item',
    warehouse: 'w1',
    account: '371',
    method: 'average',
    mayGoNegative: false,
    quantity: 15_000n,
    bani: 37_500n,
    date: '2026-03-01' as LocalDate,
    originEntryId: 'av-1',
    seq: 1,
    days: [
      { date: '2026-03-01' as LocalDate, quantity: 10_000n, bani: 10_000n },
      { date: '2026-03-10' as LocalDate, quantity: 10_000n, bani: 20_000n },
      { date: '2026-03-12' as LocalDate, quantity: -15_000n, bani: -22_500n },
      { date: '2026-03-25' as LocalDate, quantity: 10_000n, bani: 30_000n },
    ],
  } as const;
  const loaded = (): Loaded => ({
    ...emptyLoaded([]),
    stock: new Map([['item|w1', { item: 'item', warehouse: 'w1', moves: 4, layers: [pool] }]]),
  });
  const policy = { method: 'average' as const, negative: false };
  const shown = (book: StockBook, lines: LineSpec[], issues: { code: string }[]) => ({
    codes: issues.map((issue) => issue.code),
    lines: lines.map((line) => `${line.side} ${line.account} ${line.bani}`),
    moves: book.moves.map((move) => `${move.quantity} ${move.bani} ${move.line}`),
  });
  const give = (date: string, quantity: bigint, bani: bigint, average = false) => {
    const lines: LineSpec[] = [{ account: '371', side: 'D', bani: -bani }];
    const book = new StockBook(loaded(), lines);
    const issues = book.giveBack(
      { item: 'item', warehouse: 'w1', account: '371', quantity, date: date as LocalDate },
      -bani,
      0,
      policy,
      null,
      '607',
      average,
    );
    return shown(book, lines, issues);
  };

  test('out of a pool: at the purchase price, or at the date’s average', () => {
    expect(give('2026-03-15', 2_000n, 4_000n)).toEqual({
      codes: [],
      lines: ['D 371 -4000'],
      moves: ['-2000 -4000 0'],
    });
    expect(give('2026-03-15', 2_000n, 4_000n, true)).toEqual({
      codes: [],
      lines: ['D 371 -4000', 'D 371 1000', 'C 607 1000'],
      moves: ['-2000 -4000 0', '0 1000 1'],
    });
    // Emptied on its date: what the pool held then, the rest to the expense.
    expect(give('2026-03-15', 5_000n, 10_000n).lines).toEqual([
      'D 371 -10000',
      'D 371 2500',
      'C 607 2500',
    ]);
    expect(give('2026-03-15', 10_000n, 20_000n).codes).toEqual(['STOCK_RETURN_CONSUMED']);
  });

  test('a storno takes what the layer held on its date, its differences after the mirrored moves', () => {
    const receipt: StockMoveSpec = {
      item: 'item',
      warehouse: 'w1',
      account: '371',
      layer: 'pool',
      quantity: 10_000n,
      bani: 20_000n,
      line: 0,
    };
    const reverse = (date: string, average: boolean) => {
      const lines: LineSpec[] = [{ account: '371', side: 'D', bani: -20_000n }];
      const book = new StockBook(loaded(), lines);
      const issues = book.reverse(
        [receipt],
        date as LocalDate,
        () => average,
        () => '607',
      );
      return shown(book, lines, issues);
    };
    expect(reverse('2026-03-11', false).codes).toEqual(['STOCK_INSUFFICIENT']);
    expect(reverse('2026-03-26', false)).toEqual({
      codes: [],
      lines: ['D 371 -20000'],
      moves: ['-10000 -20000 0'],
    });
    expect(reverse('2026-03-26', true)).toEqual({
      codes: [],
      lines: ['D 371 -20000', 'D 607 5000', 'C 371 5000'],
      moves: ['-10000 -20000 0', '0 -5000 2'],
    });
  });
});
