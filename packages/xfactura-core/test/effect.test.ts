import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  validateEffect,
  type AccountInfo,
  type ControlKind,
  type Effect,
  type EffectContext,
  type LineSpec,
  type OpenItemInfo,
  type TaxEntrySpec,
} from '../src/kernel';
import { parseLocalDate } from '../src/time';

const day = parseLocalDate('2026-03-10');
const chart: Record<string, ControlKind | null> = {
  '4111': 'receivable',
  '401': 'payable',
  '4426': 'tax',
  '4427': 'tax',
  '4423': 'tax',
  '704': null,
  '628': null,
  '5121': null,
  '5124': null,
  '665': null,
  '765': null,
};
function context(items: OpenItemInfo[] = []): EffectContext {
  return {
    account: (code) =>
      code in chart
        ? ({
            code,
            postable: true,
            controlKind: chart[code] ?? null,
            validFrom: parseLocalDate('2015-01-01'),
            validTo: null,
          } satisfies AccountInfo)
        : undefined,
    openItem: (id) => items.find((item) => item.id === id),
  };
}
const effect = (lines: LineSpec[], extra: Partial<Effect> = {}): Effect => ({
  schema: 'effect@1',
  date: day,
  journalClass: 'general',
  journalCode: 'VANZARI',
  description: 'Factura 1',
  lines,
  openItems: [],
  taxEntries: [],
  schedules: [],
  explanation: { summary: 'test' },
  ...extra,
});
const vat = (
  line: number,
  ledgerBani: bigint,
  direction: 'output' | 'input' = 'output',
): TaxEntrySpec => ({
  key: `vat-${line}`,
  tax: 'VAT',
  code: 'S-21',
  direction,
  baseBani: (ledgerBani * 100n) / 21n,
  taxBani: ledgerBani,
  deductibleBani: direction === 'input' ? ledgerBani : 0n,
  taxPoint: day,
  exigibility: day,
  taxPeriod: '2026-03',
  line,
  ledgerBani,
  attributes: {},
});
const receivable = {
  ref: 'ar',
  kind: 'receivable' as const,
  controlAccount: '4111',
  partyId: 'client',
  currency: 'RON',
  normalSide: 'D' as const,
  mayReverse: false,
};
const codes = (value: Effect, items: OpenItemInfo[] = []) =>
  validateEffect(value, context(items)).map((issue) => issue.code);
const sale = () =>
  effect(
    [
      { account: '4111', side: 'D', bani: 121000n, openItem: 'ar', partyId: 'client' },
      { account: '704', side: 'C', bani: 100000n },
      { account: '4427', side: 'C', bani: 21000n },
    ],
    { openItems: [receivable], taxEntries: [vat(2, 21000n)] },
  );
const existing = (balanceBani: bigint, extra: Partial<OpenItemInfo> = {}): OpenItemInfo => ({
  ...receivable,
  id: 'ar-1',
  balanceBani,
  balanceMinor: balanceBani,
  ...extra,
});

describe('validateEffect', () => {
  test('accepts a domestic sale with output VAT', () => {
    expect(codes(sale())).toEqual([]);
  });

  test('requires balance, known accounts and non-zero lines', () => {
    const value = sale();
    value.lines[1]!.bani = 99999n;
    expect(codes(value)).toContain('UNBALANCED');
    expect(
      codes(
        effect([
          { account: '999', side: 'D', bani: 1n },
          { account: '704', side: 'C', bani: 1n },
        ]),
      ),
    ).toContain('ACCOUNT_UNKNOWN');
    expect(
      codes(
        effect([
          { account: '5121', side: 'D', bani: 0n },
          { account: '704', side: 'C', bani: 0n },
        ]),
      ),
    ).toContain('LINE_ZERO');
  });

  test('control accounts require a matching open item and others forbid one', () => {
    const missing = sale();
    delete missing.lines[0]!.openItem;
    expect(codes(missing)).toEqual(
      expect.arrayContaining(['CONTROL_OPEN_ITEM', 'OPEN_ITEM_UNUSED']),
    );
    const stray = sale();
    stray.lines[1]!.openItem = 'ar';
    expect(codes(stray)).toContain('OPEN_ITEM_NOT_CONTROL');
    const wrongParty = sale();
    wrongParty.lines[0]!.partyId = 'other';
    expect(codes(wrongParty)).toContain('OPEN_ITEM_PARTY');
  });

  test('tax lines must equal their linked tax entries', () => {
    const value = sale();
    value.taxEntries[0]!.ledgerBani = 20999n;
    expect(codes(value)).toContain('TAX_LINE_MISMATCH');
    const unexplained = sale();
    unexplained.taxEntries = [];
    expect(codes(unexplained)).toContain('TAX_LINE_UNEXPLAINED');
  });

  test('VAT settlement lines need no tax entries', () => {
    const settlement = effect([
      {
        account: '4427',
        side: 'D',
        bani: 21000n,
        taxSettlement: { tax: 'VAT', period: '2026-03' },
      },
      {
        account: '4426',
        side: 'C',
        bani: 15000n,
        taxSettlement: { tax: 'VAT', period: '2026-03' },
      },
      { account: '4423', side: 'C', bani: 6000n, taxSettlement: { tax: 'VAT', period: '2026-03' } },
    ]);
    expect(codes(settlement)).toEqual([]);
    settlement.lines[0]!.account = '5121';
    expect(codes(settlement)).toContain('TAX_SETTLEMENT_ACCOUNT');
  });

  test('a red storno credit note clears the receivable exactly', () => {
    const credit = effect(
      [
        { account: '4111', side: 'D', bani: -121000n, openItem: 'ar-1', partyId: 'client' },
        { account: '704', side: 'C', bani: -100000n },
        { account: '4427', side: 'C', bani: -21000n },
      ],
      { taxEntries: [vat(2, -21000n)] },
    );
    expect(codes(credit, [existing(121000n)])).toEqual([]);
    expect(codes(credit, [existing(100000n)])).toContain('OPEN_ITEM_REVERSED');
  });

  test('settlements cannot exceed the open balance unless the item may reverse', () => {
    const receipt = effect([
      { account: '5121', side: 'D', bani: 125000n },
      { account: '4111', side: 'C', bani: 125000n, openItem: 'ar-1' },
    ]);
    expect(codes(receipt, [existing(121000n)])).toContain('OPEN_ITEM_REVERSED');
    expect(codes(receipt, [existing(121000n, { mayReverse: true })])).toEqual([]);
  });

  test('foreign-currency items close in both currencies', () => {
    const item = existing(49765n, { currency: 'EUR', balanceMinor: 10000n });
    const eur = { code: 'EUR', rateId: 'bnr-2026-03-10', rate: '5.0000' };
    const settled = effect([
      { account: '5124', side: 'D', bani: 50000n, currency: { ...eur, minor: 10000n } },
      {
        account: '4111',
        side: 'C',
        bani: 49765n,
        openItem: 'ar-1',
        currency: { ...eur, minor: 10000n },
      },
      { account: '765', side: 'C', bani: 235n },
    ]);
    expect(codes(settled, [item])).toEqual([]);
    const residual = structuredClone(settled);
    residual.lines[1]!.bani = 49000n;
    residual.lines[2]!.bani = 1000n;
    expect(codes(residual, [item])).toContain('OPEN_ITEM_RESIDUAL');
    const ronLine = structuredClone(settled);
    delete ronLine.lines[1]!.currency;
    expect(codes(ronLine, [item])).toContain('OPEN_ITEM_CURRENCY');
  });

  test('schedules must allocate exactly the created balance', () => {
    const deferral = {
      ...receivable,
      ref: 'prepaid',
      kind: 'deferral.expense' as const,
      controlAccount: '471',
    };
    chart['471'] = 'deferral.expense';
    const value = effect(
      [
        { account: '471', side: 'D', bani: 120000n, openItem: 'prepaid' },
        { account: '401', side: 'C', bani: 120000n, openItem: 'ap' },
      ],
      {
        openItems: [
          deferral,
          { ...receivable, ref: 'ap', kind: 'payable', controlAccount: '401', normalSide: 'C' },
        ],
        schedules: [
          {
            ref: 'plan',
            openItem: 'prepaid',
            version: 1,
            method: 'equal-months',
            basis: null,
            rows: [1, 2, 3].map((month) => ({
              key: `2026-0${month + 2}`,
              due: parseLocalDate(`2026-0${month + 2}-28`),
              bani: 40000n,
              counterAccount: '628',
            })),
          },
        ],
      },
    );
    expect(codes(value)).toEqual([]);
    value.schedules[0]!.rows[2]!.bani = 39999n;
    expect(codes(value)).toContain('SCHEDULE_TOTAL');
  });

  test('any balanced set of plain lines passes, and any single change unbalances it', () => {
    const plain = ['704', '628', '5121', '665', '765'];
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.constantFrom(...plain), fc.bigInt({ min: 1n, max: 10n ** 12n })), {
          minLength: 1,
          maxLength: 20,
        }),
        fc.bigInt({ min: 1n, max: 1000n }),
        (debits, change) => {
          const total = debits.reduce((sum, [, bani]) => sum + bani, 0n);
          const lines: LineSpec[] = [
            ...debits.map(([account, bani]): LineSpec => ({ account, side: 'D', bani })),
            { account: '5121', side: 'C', bani: total },
          ];
          expect(codes(effect(lines))).toEqual([]);
          lines[0]!.bani += change;
          expect(codes(effect(lines))).toContain('UNBALANCED');
        },
      ),
    );
  });
});
