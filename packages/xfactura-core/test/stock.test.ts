import { describe, expect, test } from 'bun:test';
import { canonical } from '../src/hash';
import {
  isStockAccount,
  stockAccountSynthetics,
  validateEffect,
  type AccountInfo,
  type Effect,
  type StockLayerInfo,
} from '../src/kernel';
import { roRegister } from '../src/ro/register';
import { prorate } from '../src/ro/stock';
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
