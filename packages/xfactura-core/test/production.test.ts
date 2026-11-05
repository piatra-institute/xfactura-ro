import { describe, expect, test } from 'bun:test';
import {
  stockPositionKey,
  type AnswerRecord,
  type Loaded,
  type ProductionLine,
  type StockLayerState,
} from '../src/kernel';
import { RuleContext } from '../src/rules';
import { roRegister } from '../src/ro/register';
import {
  absorbed,
  allocateOverhead,
  costInput,
  differencesOnExits,
  labourByHours,
  labourByShares,
  orderTag,
  outputInput,
  productionCost,
  productionOutput,
  productionPolicyAt,
  productionVersions,
  productionWipReverse,
  wipReverseInput,
} from '../src/ro/production';
import { citationProblems } from '../src/ro/sources';
import { emptyLoaded } from '../src/ro/reviews/specs/world';
import type { LocalDate } from '../src/time';

// Production (G4), pure: the arithmetic of the costing and the treatments on fixed figures.

const TABLE = '00000000-0000-4000-8000-00000000e001';
const BOARD = '00000000-0000-4000-8000-00000000e002';
const PROGRESS = '00000000-0000-4000-8000-00000000e003';
const SHOP = '00000000-0000-4000-8000-00000000e004';
const FINISHED = '00000000-0000-4000-8000-00000000e005';
const BOM = '00000000-0000-4000-8000-00000000e006';
const ORDER = '00000000-0000-4000-8000-00000000e007';
const FILE = '00000000-0000-4000-8000-00000000e008';
const SCRAP = '00000000-0000-4000-8000-00000000e009';

const rules = () => new RuleContext(roRegister(), 'preview');
const date = (text: string) => text as LocalDate;

function world(
  options: {
    method?: 'standard' | 'actual';
    lines?: ProductionLine[];
    closedOn?: string;
    layers?: StockLayerState[];
    answers?: AnswerRecord[];
  } = {},
): Loaded {
  const facts = [
    ['vat.status', 'normal_vat'],
    ['policy.stock.valuation', 'fifo'],
    ['policy.stock.inventory', 'permanent'],
    ['policy.stock.negative', 'refuse'],
    ...(options.method ? [['policy.production.cost', options.method]] : []),
  ].map(([axis, value]) => ({ axis: axis!, value: value!, effectiveFrom: date('2026-01-01') }));
  const item = (id: string, code: string, account: string) =>
    [
      id,
      { id, code, name: code, unit: 'H87', nc8: null, account, vatCategory: 'standard' },
    ] as const;
  const position = (item: string, warehouse: string) =>
    [
      stockPositionKey(item, warehouse),
      {
        item,
        warehouse,
        moves: 0,
        layers: (options.layers ?? []).filter(
          (layer) => layer.item === item && layer.warehouse === warehouse,
        ),
      },
    ] as const;
  return {
    ...emptyLoaded(facts),
    years: [{ id: 'fy', kind: 'financial', from: date('2026-01-01'), to: date('2026-12-31') }],
    evidence: new Map([
      [FILE, { id: FILE, hash: 'h', filename: 'f.pdf', mediaType: 'application/pdf' }],
    ]),
    answers: new Map((options.answers ?? []).map((answer) => [answer.questionId, answer])),
    stock: new Map([
      position(PROGRESS, SHOP),
      position(TABLE, FINISHED),
      position(SCRAP, FINISHED),
    ]),
    stockItems: new Map([
      item(TABLE, 'MASA-1', '345'),
      item(BOARD, 'PAL-18', '301'),
      item(PROGRESS, 'PIC-MASA', '331'),
      item(SCRAP, 'DESEU-1', '346'),
    ]),
    warehouses: new Map([
      [SHOP, { id: SHOP, code: 'A1', name: 'Atelier', keeper: 'Pop Ion' }],
      [FINISHED, { id: FINISHED, code: 'P1', name: 'Produse', keeper: 'Pop Ion' }],
    ]),
    production: {
      boms: new Map([
        [
          BOM,
          {
            id: BOM,
            itemId: TABLE,
            version: 1,
            validFrom: date('2026-01-01'),
            outputQuantity: 1_000n,
            standardCost: 55_000n,
            labourHours: null,
            machineHours: null,
            evidenceId: FILE,
            lines: [{ lineNo: 1, itemId: BOARD, quantity: 2_000n }],
          },
        ],
      ]),
      orders: new Map([
        [
          ORDER,
          {
            id: ORDER,
            number: 'CP-1',
            itemId: TABLE,
            bomId: BOM,
            quantity: 10_000n,
            openedOn: date('2026-03-02'),
            closedOn: options.closedOn ? date(options.closedOn) : null,
            evidenceId: FILE,
          },
        ],
      ]),
      lines: options.lines ?? [],
    },
  };
}

const tagged = (
  account: string,
  day: string,
  debit: bigint,
  credit: bigint,
  item: string | null = null,
  quantity = 0n,
): ProductionLine => ({
  tag: orderTag(ORDER),
  account,
  date: date(day),
  debit,
  credit,
  item,
  quantity,
});
const lines = (evaluation: {
  effect: { lines: { side: string; account: string; bani: bigint }[] } | null;
}) => evaluation.effect?.lines.map((line) => `${line.side} ${line.account} ${line.bani}`);
const codes = (evaluation: { issues: { code: string }[] }) =>
  evaluation.issues.map((issue) => issue.code);

describe('the costing arithmetic', () => {
  test('fixed overheads at normal capacity: below it the rest stays an expense, above it no more', () => {
    const pool = { amount: 80_000n, behaviour: 'fixed' as const, capacity: { normal: 100_000n } };
    expect(absorbed(pool, 36_000n)).toBe(28_800n);
    expect(absorbed(pool, 120_000n)).toBe(80_000n);
    expect(absorbed({ ...pool, capacity: { approximates: true } }, 36_000n)).toBe(80_000n);
    expect(absorbed({ amount: 60_000n, behaviour: 'variable' }, 1n)).toBe(60_000n);
    const result = allocateOverhead(pool, [
      { id: 'a', weight: 20_000n },
      { id: 'b', weight: 16_000n },
    ]);
    expect([...result.parts]).toEqual([
      ['a', 16_000n],
      ['b', 12_800n],
    ]);
    expect(result.unallocated).toBe(51_200n);
  });

  test("direct labour by the timesheet's hours, the hours on no order an expense", () => {
    const result = labourByHours([
      {
        contractId: 'c',
        cost: 613_500n,
        hours: 176_000n,
        orders: [
          { orderId: 'a', hours: 88_000n },
          { orderId: 'b', hours: 44_000n },
        ],
      },
    ]);
    expect([...result.byOrder]).toEqual([
      ['a', 306_750n],
      ['b', 153_375n],
    ]);
    expect(result.unallocated).toBe(153_375n);
    const stated = labourByShares(100_001n, [{ orderId: 'a', basis: 3_333n }]);
    expect(stated.byOrder.get('a')! + stated.unallocated).toBe(100_001n);
  });

  test('the price differences follow the goods: cumulated, what earlier months took deducted', () => {
    // January: 3.000 in at standard with 600 of differences, 1.500 out (300 taken); March: 3.000
    // in without differences, everything out: the rest of the differences goes with it.
    expect(
      differencesOnExits({
        differences: { opening: 0n, entered: 60_000n },
        stock: { opening: 0n, entered: 600_000n },
        exits: 600_000n,
        taken: 30_000n,
      })?.share,
    ).toBe(30_000n);
    expect(
      differencesOnExits({
        differences: { opening: 0n, entered: 0n },
        stock: { opening: 0n, entered: 0n },
        exits: 0n,
        taken: 0n,
      }),
    ).toBeNull();
  });
});

describe('the production treatments', () => {
  test('without the cost method, production asks for it; the parameters cite located clauses', () => {
    const issue = productionPolicyAt(world(), date('2026-03-10'));
    expect(typeof issue === 'object' && issue.code).toBe('POLICY_MISSING');
    expect(citationProblems(productionVersions)).toEqual([]);
  });

  test('a hand-over: the product at its standard cost, a residual product at its value', () => {
    const input = outputInput.parse({
      orderId: ORDER,
      date: '2026-03-20',
      warehouseId: FINISHED,
      reference: 'BP-1',
      evidenceId: FILE,
      lines: [
        { itemId: TABLE, quantity: '2' },
        { itemId: SCRAP, quantity: '5', value: '20.00' },
      ],
    });
    const standard = productionOutput.evaluate(input, world({ method: 'standard' }), rules());
    expect(codes(standard)).toEqual([]);
    expect(lines(standard)).toEqual(['D 345 110000', 'D 346 2000', 'C 711 112000']);
    expect(standard.effect!.lines.every((line) => line.analytics?.item === orderTag(ORDER))).toBe(
      true,
    );
    const actual = productionOutput.evaluate(input, world({ method: 'actual' }), rules());
    expect(codes(actual)).toEqual(['PRODUCTION_OUTPUT_ACTUAL']);
  });

  test('the costing asks about a closed order’s excess over its norm, and leaves an abnormal one out', () => {
    // 21 boards for 10 tables at 2 a table: one board (100,00) above the norm.
    const month = [
      tagged('601', '2026-03-03', 210_000n, 0n),
      tagged('301', '2026-03-03', 0n, 210_000n, BOARD, -21_000n),
      tagged('345', '2026-03-25', 550_000n, 0n, TABLE, 10_000n),
      tagged('711', '2026-03-25', 0n, 550_000n),
    ];
    const input = costInput.parse({ month: '2026-03', labour: { method: 'none' }, overheads: [] });
    const asked = productionCost.evaluate(
      input,
      world({ method: 'standard', lines: month, closedOn: '2026-03-25' }),
      rules(),
    );
    expect(codes(asked)).toEqual(['PRODUCTION_EXCESS']);
    expect(asked.issues[0]!.details).toEqual({
      question: {
        kind: 'production.excess',
        subject: { kind: 'workOrder', id: ORDER },
        params: { itemId: BOARD, quantity: '1.000' },
      },
    });
    const answer = (treatment: 'abnormal' | 'normal'): AnswerRecord => ({
      questionId: 'q',
      answerId: 'a',
      kind: 'production.excess',
      subject: { kind: 'workOrder', id: ORDER },
      params: { itemId: BOARD, quantity: '1.000' },
      value: { treatment, evidenceId: FILE },
      evidenceId: FILE,
      answeredAt: '2026-04-01T10:00:00Z',
    });
    // Abnormal: 2.100 − 100 = 2.000 for 5.500 at standard, a favourable 3.500.
    const abnormal = productionCost.evaluate(
      input,
      world({
        method: 'standard',
        lines: month,
        closedOn: '2026-03-25',
        answers: [answer('abnormal')],
      }),
      rules(),
    );
    expect(lines(abnormal)).toEqual(['D 711 350000', 'C 348 350000']);
    const normal = productionCost.evaluate(
      input,
      world({
        method: 'standard',
        lines: month,
        closedOn: '2026-03-25',
        answers: [answer('normal')],
      }),
      rules(),
    );
    expect(lines(normal)).toEqual(['D 711 340000', 'C 348 340000']);
  });

  test('an open order needs its count; the work in progress goes back at the next month’s start', () => {
    const month = [
      tagged('601', '2026-03-03', 40_000n, 0n),
      tagged('301', '2026-03-03', 0n, 40_000n, BOARD, -4_000n),
    ];
    const input = { month: '2026-03', labour: { method: 'none' }, overheads: [] };
    const unlisted = productionCost.evaluate(
      costInput.parse(input),
      world({ method: 'standard', lines: month }),
      rules(),
    );
    expect(codes(unlisted)).toEqual(['PRODUCTION_WIP_UNLISTED']);
    const counted = productionCost.evaluate(
      costInput.parse({
        ...input,
        wip: {
          evidenceId: FILE,
          orders: [{ orderId: ORDER, itemId: PROGRESS, warehouseId: SHOP, quantity: '2' }],
        },
      }),
      world({ method: 'standard', lines: month }),
      rules(),
    );
    expect(lines(counted)).toEqual(['D 331 40000', 'C 711 40000']);
    expect(counted.effect!.stockMoves!.map((move) => move.quantity)).toEqual([2_000n]);
    const reversed = productionWipReverse.evaluate(
      wipReverseInput.parse({ month: '2026-04' }),
      world({
        method: 'standard',
        layers: [
          {
            id: 'wip-lot',
            item: PROGRESS,
            warehouse: SHOP,
            account: '331',
            method: 'fifo',
            mayGoNegative: false,
            quantity: 2_000n,
            bani: 40_000n,
            date: date('2026-03-31'),
            originEntryId: 'costing',
            seq: 9,
          },
        ],
      }),
      rules(),
    );
    expect(lines(reversed)).toEqual(['C 331 40000', 'D 711 40000']);
    expect(reversed.effect!.date).toBe(date('2026-04-01'));
  });
  test('at the actual cost, a closed order needs its products, or a statement it was abandoned', () => {
    const month = [
      tagged('601', '2026-03-03', 40_000n, 0n),
      tagged('301', '2026-03-03', 0n, 40_000n, BOARD, -4_000n),
    ];
    const state = world({ method: 'actual', lines: month, closedOn: '2026-03-20' });
    const base = { month: '2026-03', labour: { method: 'none' }, overheads: [] };
    const missing = productionCost.evaluate(costInput.parse(base), state, rules());
    expect(codes(missing)).toEqual(['PRODUCTION_OUTPUTS_MISSING']);
    const abandoned = productionCost.evaluate(
      costInput.parse({ ...base, abandoned: [ORDER] }),
      state,
      rules(),
    );
    expect(codes(abandoned)).toEqual(['PRODUCTION_ABANDONED']);
    expect([abandoned.effect!.journalClass, abandoned.effect!.lines]).toEqual(['memo', []]);
  });
});
