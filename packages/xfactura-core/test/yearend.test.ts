import { describe, expect, test } from 'bun:test';
import { checkDocument } from '../src/documents/checks';
import { extractedBody } from '../src/documents/schemas';
import {
  itemLinesKey,
  turnoverKey,
  type AnswerRecord,
  type AssetState,
  type ItemLines,
  type Loaded,
  type OpenItemState,
} from '../src/kernel';
import { parseMoney } from '../src/money';
import { roRegister } from '../src/ro/register';
import { emptyLoaded } from '../src/ro/reviews/specs/world';
import {
  assetImpairment,
  assetImpairmentInput,
  compareInventory,
  inventoryDifferences,
  inventoryInput,
  inventoryListSchema,
  provisionInput,
  provisionRecord,
  receivableImpairment,
  receivableImpairmentInput,
  snapshotDifferences,
  snapshotHash,
  type ClosingSnapshot,
  type InventoryList,
} from '../src/ro/yearend';
import { RuleContext } from '../src/rules';
import type { LocalDate } from '../src/time';

const rules = () => new RuleContext(roRegister(), 'preview');
const bani = (text: string) => parseMoney(text, 'RON');
const END = '2026-12-31' as LocalDate;
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DECISION = ID(1);
const LIST = ID(2);
const lines = (evaluation: {
  effect: { lines: { side: string; account: string; bani: bigint }[] } | null;
}) => evaluation.effect?.lines.map((line) => `${line.side} ${line.account} ${line.bani}`);
const codes = (evaluation: { issues: { code: string }[] }) =>
  evaluation.issues.map((issue) => issue.code);

function list(overrides: Partial<InventoryList> = {}): InventoryList {
  return inventoryListSchema.parse({
    parserVersion: 'extracted-inventory-list-1',
    title: 'Lista de inventariere',
    company: { name: 'Pilot SRL', taxId: '12345678' },
    date: END,
    commission: { decision: '7', decisionDate: '2026-12-01', members: ['Pop Ion'] },
    assets: null,
    cash: null,
    bank: null,
    partners: null,
    stock: null,
    ...overrides,
  });
}

function asset(overrides: Partial<AssetState> = {}): AssetState {
  return {
    id: ID(10),
    number: 'MF-1',
    name: 'Laptop',
    catalogCode: '2.2.9',
    account: '214',
    depreciationAccount: '2814',
    expenseAccount: '6811',
    value: bani('6000.00'),
    lifeMonths: 36,
    commissionedOn: '2026-06-15' as LocalDate,
    disposedOn: null,
    depreciated: bani('1000.00'),
    fiscal: null,
    ...overrides,
  };
}

/** The year 2026 with the given facts, lists, assets and cash. */
function world(options: {
  facts?: { axis: string; value: string }[];
  list?: InventoryList;
  assets?: AssetState[];
  cash?: string;
  itemLines?: ItemLines[];
  itemLinePrefixes?: string[];
  answers?: AnswerRecord[];
  items?: OpenItemState[];
}): Loaded {
  const loaded = emptyLoaded(
    (options.facts ?? []).map((item) => ({ ...item, effectiveFrom: '2026-01-01' as LocalDate })),
  );
  const always = '1900-01-01' as LocalDate;
  return {
    ...loaded,
    years: [{ id: 'fy', kind: 'financial', from: '2026-01-01' as LocalDate, to: END }],
    evidence: new Map([
      [
        DECISION,
        { id: DECISION, hash: 'h', filename: 'decizie.pdf', mediaType: 'application/pdf' },
      ],
    ]),
    documents: options.list
      ? new Map([
          [
            LIST,
            {
              id: LIST,
              kind: 'inventory.list',
              schema: 'extracted-inventory-list-1',
              body: options.list,
              bodyHash: 'list',
              docDate: END,
              partyId: null,
              currency: null,
              number: null,
              evidenceId: null,
            },
          ],
        ])
      : new Map(),
    assets: new Map((options.assets ?? []).map((item) => [item.id, item])),
    turnover: new Map([
      [
        turnoverKey({ prefixes: ['531'], from: always, to: END }),
        options.cash ? [{ account: '5311', debit: bani(options.cash), credit: 0n }] : [],
      ],
      [turnoverKey({ prefixes: ['3'], from: always, to: END }), []],
    ]),
    itemLines: new Map([
      [itemLinesKey({ prefixes: options.itemLinePrefixes ?? ['29'] }), options.itemLines ?? []],
    ]),
    parties: new Map([
      [ID(20), { id: ID(20), kind: 'ro_individual', country: 'RO', taxId: null, name: 'Casier' }],
      [
        ID(21),
        { id: ID(21), kind: 'ro_legal_entity', country: 'RO', taxId: '200', name: 'Client SRL' },
      ],
    ]),
    openItems: new Map((options.items ?? []).map((item) => [item.id, item])),
    answers: new Map((options.answers ?? []).map((item) => [item.questionId, item])),
  };
}

describe('the inventory lists', () => {
  test('are documents of their own, checked for consistency and cited amounts', () => {
    const body = extractedBody('inventory.list', {
      title: 'Lista 1',
      company: { name: 'Pilot SRL', taxId: '12345678' },
      date: END,
      commission: { decision: '7', decisionDate: '2026-12-01', members: ['Pop Ion'] },
      assets: [{ number: 'MF-1', name: 'Laptop', found: false, value: '10.00' }],
      cash: [{ account: '5311', currency: 'RON', counted: '850.00' }],
      partners: [{ name: 'Client', account: '4111', currency: 'RON', status: 'confirmed' }],
    });
    const { checks } = checkDocument({
      kind: 'inventory.list',
      body,
      companyTaxId: '12345678',
      today: '2027-01-20' as LocalDate,
      rates: () => ({ standard: '21', reduced: [] }),
      pages: null,
      citations: {},
    });
    const totals = checks.find((check) => check.code === 'TOTALS')!;
    expect(totals.status).toBe('failed');
    expect(totals.details).toEqual([
      'Rândul 1 (MF-1): un activ lipsă nu are valoare de inventar.',
      'Rândul 1 (Client): soldul confirmat se indică exact când partenerul a răspuns.',
    ]);
    expect(checks.find((check) => check.code === 'COMPANY_PARTY')!.status).toBe('passed');
    expect(checks.find((check) => check.code === 'CITATIONS')!.details).toMatchObject({
      missing: [
        'date',
        'commission.decision',
        'assets.0.number',
        'assets.0.value',
        'cash.0.counted',
      ],
    });
  });

  test('are compared with the books: gaps, differences, and stock not covered', () => {
    const comparison = compareInventory(
      [
        list({
          assets: [
            { number: 'MF-1', name: 'Laptop', found: false, value: null, note: null },
            { number: 'MF-2', name: 'Imprimantă', found: true, value: '300.00', note: null },
            { number: 'MF-9', name: 'Monitor', found: true, value: '500.00', note: 'găsit' },
          ],
          cash: [{ account: '5311', currency: 'RON', counted: '900.00' }],
          partners: [
            {
              name: 'Client SRL',
              taxId: 'RO200',
              account: '4111',
              currency: 'RON',
              confirmed: '1000.00',
              status: 'disputed',
              note: null,
            },
          ],
        }),
      ],
      {
        date: END,
        assets: [
          { id: 'a1', number: 'MF-1', name: 'Laptop', net: bani('5000.00') },
          { id: 'a2', number: 'MF-2', name: 'Imprimantă', net: bani('800.00') },
          { id: 'a3', number: 'MF-3', name: 'Scaun', net: bani('200.00') },
        ],
        cash: [{ account: '5311', currency: 'RON', bani: bani('1000.00'), minor: bani('1000.00') }],
        bank: [{ account: '5121', currency: 'RON', bani: 1n, minor: 1n }],
        partners: [
          {
            partyId: 'p1',
            taxId: '200',
            name: 'Client SRL',
            account: '4111',
            currency: 'RON',
            minor: bani('1210.00'),
          },
        ],
        stock: [{ account: '371', bani: bani('50.00') }],
      },
    );
    expect(comparison.differences.map((item) => item.kind)).toEqual([
      'asset.missing',
      'asset.impaired',
      'asset.surplus',
      'cash',
      'partner',
    ]);
    expect(comparison.gaps.map((item) => item.code)).toEqual([
      'INVENTORY_UNLISTED',
      'INVENTORY_BANK_UNCONFIRMED',
    ]);
    expect(comparison.unsupported.map((item) => item.code)).toEqual(['INVENTORY_STOCK']);
  });
});

describe('the inventory differences', () => {
  const run = (options: Parameters<typeof world>[0], input: Record<string, unknown>) =>
    inventoryDifferences.evaluate(
      inventoryInput.parse({ date: END, documentIds: [LIST], evidenceId: DECISION, ...input }),
      world(options),
      rules(),
    );

  test('a missing asset imputed to a third party is its receivable, against 7581, with the VAT and profit questions acknowledged', () => {
    const evaluation = run(
      {
        facts: [
          { axis: 'vat.status', value: 'normal_vat' },
          { axis: 'income_tax', value: 'profit' },
        ],
        list: list({
          assets: [{ number: 'MF-1', name: 'Laptop', found: false, value: null, note: null }],
        }),
        assets: [asset({ disposedOn: END })],
      },
      {
        imputations: [
          { kind: 'asset', ref: 'MF-1', partyId: ID(21), employee: false, amount: '3570.00' },
        ],
      },
    );
    expect(lines(evaluation)).toEqual(['D 461 357000', 'C 7581 357000']);
    expect(evaluation.effect!.openItems).toEqual([
      expect.objectContaining({ kind: 'receivable', controlAccount: '461', partyId: ID(21) }),
    ]);
    expect(codes(evaluation)).toEqual(['CAPITAL_GOODS_CESSATION', 'INVENTORY_DECISION']);
  });

  test('a missing asset not taken out of the register first is refused; an unimputed one is a profit question', () => {
    const missing = list({
      assets: [{ number: 'MF-1', name: 'Laptop', found: false, value: null, note: null }],
    });
    expect(codes(run({ list: missing, assets: [asset()] }, {}))).toEqual([
      'INVENTORY_ASSET_DISPOSAL',
    ]);
    const unimputed = run(
      {
        facts: [{ axis: 'income_tax', value: 'profit' }],
        list: list({
          assets: [{ number: 'MF-1', name: 'Laptop', found: false, value: null, note: null }],
          cash: [{ account: '5311', currency: 'RON', counted: '1040.00' }],
        }),
        assets: [asset({ disposedOn: END })],
        cash: '1000.00',
      },
      {},
    );
    expect(lines(unimputed)).toEqual(['D 5311 4000', 'C 7588 4000']);
    expect(codes(unimputed)).toEqual(['PROFIT_SHORTAGE', 'INVENTORY_DECISION']);
  });

  test('a surplus asset is taken in on its card against 4754; stock and an unmatched imputation block', () => {
    const surplus = run(
      {
        list: list({
          assets: [{ number: 'MF-9', name: 'Monitor', found: true, value: '500.00', note: null }],
        }),
        assets: [
          asset({
            id: ID(11),
            number: 'MF-9',
            name: 'Monitor',
            value: bani('500.00'),
            commissionedOn: END,
            depreciated: 0n,
          }),
        ],
      },
      { surplus: [{ number: 'MF-9', assetId: ID(11) }] },
    );
    // MF-9 is in the register now, so the list finds it: nothing differs.
    expect(codes(surplus)).toEqual(['NOTHING_TO_BOOK']);
    const found = run(
      {
        list: list({
          assets: [{ number: 'MF-9', name: 'Monitor', found: true, value: '500.00', note: null }],
        }),
      },
      {},
    );
    expect(codes(found)).toEqual(['INVENTORY_SURPLUS']);
    const unmatched = run(
      {
        list: list({ cash: [{ account: '5311', currency: 'RON', counted: '1000.00' }] }),
        cash: '1000.00',
      },
      {
        imputations: [
          { kind: 'cash', ref: '5311', partyId: ID(20), employee: true, amount: '1.00' },
        ],
      },
    );
    expect(codes(unmatched)).toEqual(['IMPUTATION_UNMATCHED']);
  });
});

describe('impairments', () => {
  const receivable = (overrides: Partial<OpenItemState> = {}): OpenItemState => ({
    id: ID(30),
    kind: 'receivable',
    controlAccount: '4111',
    partyId: ID(21),
    currency: 'RON',
    normalSide: 'D',
    mayReverse: false,
    balanceBani: bani('12100.00'),
    balanceMinor: bani('12100.00'),
    documentId: null,
    dueDate: '2025-10-01' as LocalDate,
    originEntryId: ID(31),
    movements: 1,
    history: [ID(31)],
    origin: {
      treatmentId: 'invoices.recognize',
      subject: 'document:x',
      date: '2025-09-01' as LocalDate,
      tag: null,
    },
    ...overrides,
  });
  const answer = (
    status: string,
    recoverable: string,
    extra: Record<string, unknown> = {},
  ): AnswerRecord => ({
    questionId: 'q',
    answerId: 'a',
    kind: 'receivable.collectibility',
    subject: { kind: 'party', id: ID(21) },
    params: { yearEnd: END },
    value: {
      status,
      recoverable,
      guaranteed: false,
      affiliated: false,
      evidenceIds: status === 'collectible' ? [] : [DECISION],
      ...extra,
    },
    evidenceId: DECISION,
    answeredAt: '2027-01-10T08:00:00.000Z',
  });
  const run = (options: Parameters<typeof world>[0]) =>
    receivableImpairment.evaluate(
      receivableImpairmentInput.parse({ yearEnd: END, evidenceId: DECISION }),
      world({
        itemLinePrefixes: ['491'],
        facts: [{ axis: 'policy.impairment.receivables', value: 'overdue_90' }],
        ...options,
      }),
      rules(),
    );

  test('a bankruptcy declared is impaired in full and deductible by art. 26 alin. (1) lit. j)', () => {
    const evaluation = run({ items: [receivable()], answers: [answer('bankruptcy', '0')] });
    expect(lines(evaluation)).toEqual(['C 491 1210000', 'D 6814 1210000']);
    expect((evaluation.effect!.explanation.details as { profit: unknown[] }).profit).toEqual([
      expect.objectContaining({
        rule: 'provision_deductible',
        clause: 'art.26(1)(j)',
        amount: '12100.00',
      }),
    ]);
  });

  test('a recovered customer reverses its impairment; one guaranteed is not deductible', () => {
    const held: ItemLines = {
      item: `impairment:${ID(30)}`,
      account: '491',
      openItem: null,
      debit: 0n,
      credit: bani('5000.00'),
      debitMinor: 0n,
      creditMinor: 0n,
    };
    const reversal = run({
      items: [receivable()],
      answers: [answer('collectible', '100')],
      itemLines: [held],
    });
    expect(lines(reversal)).toEqual(['D 491 500000', 'C 7814 500000']);
    const guaranteed = run({
      items: [receivable()],
      answers: [answer('litigation', '50', { guaranteed: true })],
    });
    expect(lines(guaranteed)).toEqual(['C 491 605000', 'D 6814 605000']);
    expect((guaranteed.effect!.explanation.details as { profit: unknown[] }).profit).toEqual([]);
    // A receivable collected after the year's end: its year-end balance is what is tested.
    const collected = run({
      items: [receivable({ balanceBani: 0n, balanceMinor: 0n })],
      itemLines: [held],
    });
    expect(lines(collected)).toEqual(['D 491 500000', 'C 7814 500000']);
  });

  test("a fixed asset's impairment is the net value above the commission's, reversed when it rose or the asset left", () => {
    const evaluate = (value: string, extra: Partial<AssetState> = {}, held = 0n) =>
      assetImpairment.evaluate(
        assetImpairmentInput.parse({
          date: END,
          evidenceId: DECISION,
          assets: [{ assetId: ID(10), value, evidenceId: DECISION }],
        }),
        world({
          assets: [asset(extra)],
          itemLines: held
            ? [
                {
                  item: `impairment:${ID(10)}`,
                  account: '2914',
                  openItem: null,
                  debit: 0n,
                  credit: held,
                  debitMinor: 0n,
                  creditMinor: 0n,
                },
              ]
            : [],
        }),
        rules(),
      );
    // 6,000.00 less six months' depreciation (1,000.00) is 5,000.00; the commission says 3,500.00.
    expect(lines(evaluate('3500.00'))).toEqual(['C 2914 150000', 'D 6813 150000']);
    expect(lines(evaluate('4500.00', {}, bani('1500.00')))).toEqual([
      'D 2914 100000',
      'C 7813 100000',
    ]);
    expect(lines(evaluate('0.00', { disposedOn: END }, bani('1500.00')))).toEqual([
      'D 2914 150000',
      'C 7813 150000',
    ]);
  });
});

describe('provisions', () => {
  const run = (input: Record<string, unknown>, options: Parameters<typeof world>[0] = {}) =>
    provisionRecord.evaluate(
      provisionInput.parse({ date: END, evidenceId: DECISION, ...input }),
      world({ itemLinePrefixes: ['151', '428'], ...options }),
      rules(),
    );
  test('brought to the best estimate, kept per obligation; a warranty within its rates is deductible', () => {
    const warranty = run({
      kind: 'warranty',
      reference: 'garantii-2026',
      amount: '2000.00',
      deductible: '1500.00',
    });
    expect(lines(warranty)).toEqual(['D 6812 200000', 'C 1512 200000']);
    expect((warranty.effect!.explanation.details as { profit: unknown[] }).profit).toEqual([
      expect.objectContaining({
        rule: 'provision_deductible',
        clause: 'art.26(1)(b)',
        amount: '1500.00',
      }),
    ]);
    const lowered = run(
      { kind: 'litigation', reference: 'dosar-1', amount: '1000.00' },
      {
        itemLines: [
          {
            item: 'provision:litigation:dosar-1',
            account: '1511',
            openItem: null,
            debit: 0n,
            credit: bani('3000.00'),
            debitMinor: 0n,
            creditMinor: 0n,
          },
        ],
      },
    );
    expect(lines(lowered)).toEqual(['D 1511 200000', 'C 7812 200000']);
    expect(
      codes(run({ kind: 'litigation', reference: 'dosar-1', amount: '1.00', deductible: '1.00' })),
    ).toEqual(['PROVISION_DEDUCTIBLE']);
  });

  test("untaken leave asks its question, and the year's review fixes the other amounts", () => {
    expect(codes(run({ kind: 'leave', reference: 'concedii-2026', amount: '100.00' }))).toEqual([
      'LEAVE_UNTAKEN',
    ]);
    const review: AnswerRecord = {
      questionId: 'r',
      answerId: 'r1',
      kind: 'provisions.review',
      subject: { kind: 'company', id: 'company' },
      params: { year: 2026 },
      value: {
        obligations: [
          { kind: 'litigation', reference: 'dosar-1', amount: '3000.00', evidenceId: DECISION },
        ],
      },
      evidenceId: DECISION,
      answeredAt: '2027-01-10T08:00:00.000Z',
    };
    expect(
      codes(
        run({ kind: 'litigation', reference: 'dosar-1', amount: '2000.00' }, { answers: [review] }),
      ),
    ).toEqual(['PROVISION_AMOUNT']);
    expect(
      codes(run({ kind: 'bonus', reference: 'prime', amount: '2000.00' }, { answers: [review] })),
    ).toEqual(['PROVISION_UNLISTED']);
  });
});

describe('the closing snapshot', () => {
  const snapshot = (overrides: Partial<ClosingSnapshot> = {}): ClosingSnapshot => ({
    yearEnd: END,
    accounts: [{ account: '5121', currency: 'RON', bani: '100', minor: '100' }],
    items: [{ id: 'i1', account: '4111', partyId: 'p', currency: 'RON', bani: '50', minor: '50' }],
    assets: [
      {
        id: 'a',
        number: 'MF-1',
        account: '214',
        value: '600',
        depreciated: '100',
        impaired: '0',
        fiscal: 1,
      },
    ],
    carried: { losses: null, prorata: null },
    ...overrides,
  });
  test('the opening equals the closing, per account, item, asset and carried balance', () => {
    expect(snapshotDifferences(snapshot(), snapshot())).toEqual([]);
    expect(snapshotHash(snapshot())).toBe(
      snapshotHash(snapshot({ accounts: [...snapshot().accounts] })),
    );
    expect(
      snapshotDifferences(
        snapshot(),
        snapshot({
          items: [
            { id: 'i1', account: '4111', partyId: 'p', currency: 'RON', bani: '40', minor: '40' },
          ],
          carried: { losses: [{ year: 2026, amount: '1' }], prorata: null },
        }),
      ).map((item) => `${item.section}:${item.id}`),
    ).toEqual(['items:i1', 'carried:losses']);
  });
});
