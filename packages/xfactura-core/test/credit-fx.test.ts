import { describe, expect, test } from 'bun:test';
import type { Effect, Evaluation, PostedEntry } from '../src/kernel';
import { formatMoney } from '../src/money';
import { roRegister } from '../src/ro/register';
import {
  creditEvaluation,
  creditIds,
  creditLoaded,
  euroDocument,
} from '../src/ro/reviews/specs/credit';
import { checkD406, d406PartyId, writeD406, type D406, type D406Line } from '../src/ro/saft/d406';
import { creditInput, creditRecognition, creditVatInLei } from '../src/ro/treatments/invoices';
import { RuleContext, type ParameterRegister } from '../src/rules';

// The world of src/ro/reviews/specs/credit.ts: EXP-1 of 10.03.2026, 1,000.00 + 210.00 EUR, VAT
// 1,045.07 lei, booked by invoices.recognize at 4.9765 (receivable 6,021.57 lei = 1,210.00 EUR ×
// 4.9765, rounded); BNR's euro at 4.9850 on 20.03, 4.9900 on 31.03, 5.0100 on 08.04.2026. Every
// amount below by hand:
//   CN-1 of 20.03 (100.00 + 21.00 EUR, VAT 104.51 lei = 21.00 × 4.9765): revenue 100.00 × 4.9850 =
//     498.50; VAT base 100.00 × 4.9765 = 497.65; receivable 121.00 × 4.9765 = 602.1565 → 602.16;
//     498.50 + 104.51 − 602.16 = 0.85 gained.
//   CN-1 of 08.04 after the revaluation at 4.9900 (200.00 + 42.00 EUR, VAT 209.01 lei): revenue
//     1,002.00, base 995.30, receivable 242.00 × 4.99 = 1,207.58; 1,002.00 + 209.01 − 1,207.58 =
//     3.43 gained.
//   The purchase paid in full, credited on 20.03 (100.00 + 21.00 EUR): expense 498.50, VAT 104.51,
//     the supplier owes 121.00 EUR × 4.9850 = 603.185 → 603.19 (461); 603.19 − 603.01 = 0.18
//     gained.
const register = roRegister();
const withValue = (key: string, value: unknown): ParameterRegister =>
  register.withVersions(
    register.versions.map((version) =>
      version.key === key ? { ...version, value: value as never } : version,
    ),
  );
const note = (issueDate: string, net: string, ronVat: string, purchase = false) =>
  euroDocument({
    credit: true,
    purchase,
    number: 'CN-1',
    issueDate,
    net,
    ronVat,
    original: 'EXP-1',
  });
const lines = (effect: Effect | null) =>
  effect?.lines.map(
    (line) =>
      `${line.side} ${line.account} ${formatMoney(line.bani, 'RON')}${line.currency ? ` [${formatMoney(line.currency.minor, line.currency.code)} @ ${line.currency.rate}]` : ''}`,
  );
const codes = (evaluation: Evaluation) => evaluation.issues.map((issue) => issue.code);

describe('invoices.credit in a currency', () => {
  test('VAT at its invoice’s rate, revenue at its own date’s, the receivable at its carrying amount', () => {
    const { evaluation, rules } = creditEvaluation(
      register,
      note('2026-03-20', '100.00', '104.51'),
    );
    expect(codes(evaluation)).toEqual([]);
    expect(lines(evaluation.effect)).toEqual([
      'D 4111 -602.16 [-121.00 @ 4.9765]',
      'C 704 -498.50 [-100.00 @ 4.9850]',
      'C 4427 -104.51 [-21.00 @ 4.9765]',
      'C 7651 0.85',
    ]);
    expect(evaluation.effect?.taxEntries).toEqual([
      expect.objectContaining({
        code: 'S-21',
        baseBani: -49765n,
        taxBani: -10451n,
        taxPeriod: '2026-03',
        originTaxEntry: `${creditIds.original}:vat`,
        currency: {
          code: 'EUR',
          baseMinor: -10000n,
          taxMinor: -2100n,
          rateId: 'BNR/EUR/2026-03-10/1',
          rate: '4.9765',
        },
      }),
    ]);
    expect([...rules.used.keys()]).toEqual(
      expect.arrayContaining([
        'ro.fx.adjustment.vat/2016-01-01',
        'ro.fx.adjustment.books/2016-01-01',
      ]),
    );
    expect(evaluation.effect?.explanation.details).toMatchObject({
      fx: { books: { rate: '4.9850' }, vat: { rate: '4.9765' }, difference: '-0.85' },
    });
  });

  test('a receivable revalued at month-end leaves at the revaluation’s rate, in the note’s VAT period', () => {
    const { evaluation } = creditEvaluation(register, note('2026-04-08', '200.00', '209.01'), {
      revalued: true,
    });
    expect(codes(evaluation)).toEqual([]);
    expect(lines(evaluation.effect)).toEqual([
      'D 4111 -1207.58 [-242.00 @ 4.9900]',
      'C 704 -1002.00 [-200.00 @ 5.0100]',
      'C 4427 -209.01 [-42.00 @ 4.9765]',
      'C 7651 3.43',
    ]);
    expect(evaluation.effect?.taxEntries[0]).toMatchObject({
      baseBani: -99530n,
      taxPoint: '2026-04-08',
      taxPeriod: '2026-04',
    });
  });

  test('the alternative readings: VAT at the note’s own rate, or the books at the invoice’s', () => {
    // The event's rate: 21.00 × 4.9850 = 104.685 → 104.69, so the stated 104.51 is to confirm.
    const event = creditEvaluation(
      withValue('ro.fx.adjustment.vat', 'event'),
      note('2026-03-20', '100.00', '104.51'),
    ).evaluation;
    expect(codes(event)).toEqual(['VAT_FX']);
    expect(event.effect?.taxEntries[0]).toMatchObject({ baseBani: -49850n });
    expect(event.issues[0]!.message).toContain('104.69');
    // The invoice's accounting rate: 100.00 × 4.9765 = 497.65, no difference left.
    const original = creditEvaluation(
      withValue('ro.fx.adjustment.books', 'base_operation'),
      note('2026-03-20', '100.00', '104.51'),
    ).evaluation;
    expect(lines(original.effect)).toEqual([
      'D 4111 -602.16 [-121.00 @ 4.9765]',
      'C 704 -497.65 [-100.00 @ 4.9765]',
      'C 4427 -104.51 [-21.00 @ 4.9765]',
    ]);
  });

  test('beyond what the payable holds, the supplier owes a refund in euro at the note’s rate', () => {
    const { evaluation } = creditEvaluation(
      register,
      note('2026-03-20', '100.00', '104.51', true),
      {
        purchase: true,
        settled: true,
      },
    );
    expect(codes(evaluation)).toEqual(['CREDIT_REFUND']);
    expect(evaluation.issues[0]!.message).toContain('121.00 EUR');
    expect(lines(evaluation.effect)).toEqual([
      'D 628 -498.50 [-100.00 @ 4.9850]',
      'D 4426 -104.51 [-21.00 @ 4.9765]',
      'D 461 603.19 [121.00 @ 4.9850]',
      'C 7651 0.18',
    ]);
    expect(evaluation.effect?.openItems).toEqual([
      expect.objectContaining({ controlAccount: '461', kind: 'receivable', currency: 'EUR' }),
    ]);
  });

  test('refuses another currency than the invoice’s, a note without VAT in lei, stock and VAT on collection', () => {
    const run = (
      credit = note('2026-03-20', '100.00', '104.51'),
      extra: Record<string, unknown> = {},
      change?: (loaded: ReturnType<typeof creditLoaded>) => void,
    ) => {
      const loaded = creditLoaded(register, credit);
      change?.(loaded);
      return codes(
        creditRecognition.evaluate(
          creditInput.parse({
            documentId: creditIds.credit,
            originalDocumentId: creditIds.original,
            account: '704',
            ...extra,
          }),
          loaded,
          new RuleContext(register, 'preview'),
        ),
      );
    };
    const lei = note('2026-03-20', '100.00', '104.51');
    expect(run({ ...lei, currency: 'RON', vatCurrency: undefined })).toEqual(['CURRENCY']);
    expect(run({ ...lei, vatAccountingTotal: undefined })).toEqual(['VAT_CURRENCY']);
    // Goods are no longer refused: a warehouse the books do not know is.
    expect(
      run(undefined, {
        stock: {
          warehouseId: '00000000-0000-4000-8000-0000000000a9',
          lines: [{ line: '1', itemId: '00000000-0000-4000-8000-0000000000a8', quantity: '1' }],
        },
      }),
    ).toContain('STOCK_WAREHOUSE_UNKNOWN');
    // An invoice deferring its VAT (`cashVat`, no exigibility) cannot be in a currency: the
    // recognition refuses it, and so does its credit note.
    expect(
      run(undefined, {}, (loaded) => {
        const entry = loaded.entries.get(creditIds.entry)!;
        (loaded.entries as Map<string, PostedEntry>).set(creditIds.entry, {
          ...entry,
          taxEntries: entry.taxEntries.map((tax) => ({
            ...tax,
            exigibility: null,
            attributes: { ...tax.attributes, cashVat: 'own', invoice: creditIds.original },
          })),
        });
      }),
    ).toEqual(['CASH_VAT_CURRENCY']);
  });
});

// EXP-1's 1,000.00 EUR were 10 units of goods (371) in depot D1, under the weighted average:
//   bought at 4.9765, they entered at 4,976.50 lei, 497.65 each;
//   sold from a pool that held them at 30.00 lei each, they left at 300.00 lei (607).
// CN-1 of 20.03 credits one unit, 100.00 + 21.00 EUR:
//   from the customer, it comes back at what the sale took it out at, 30.00 (Cr 371 / Dr 607 in
//   red), whatever the rates; the revenue, VAT and receivable as without goods (0.85 gained);
//   to the supplier, it leaves at what its receipt brought it in at, 497.65 lei, not 100.00 ×
//   4.9850 = 498.50: with the VAT at 4.9765 (104.51) and the payable at its carrying 602.16 there
//   is no exchange difference; after March's revaluation at 4.9900 the payable leaves at 121.00 ×
//   4.9900 = 603.79, and 603.79 − 497.65 − 104.51 = 1.63 is gained.
describe('invoices.credit in a currency, with goods', () => {
  const WAREHOUSE = '00000000-0000-4000-8000-0000000000a9';
  const ITEM = '00000000-0000-4000-8000-0000000000a8';
  const LAYER = '00000000-0000-4000-8000-0000000000a7';
  const policies = [
    ['policy.stock.valuation', 'average'],
    ['policy.stock.inventory', 'permanent'],
    ['policy.stock.negative', 'refuse'],
  ].map(([axis, value]) => ({ axis: axis!, value: value!, effectiveFrom: '2026-01-01' as never }));
  function withGoods(purchase: boolean, options: { revalued?: boolean } = {}) {
    const credit = note('2026-03-20', '100.00', '104.51', purchase);
    const loaded = creditLoaded(register, credit, { purchase, ...options });
    const entries = loaded.entries as Map<string, PostedEntry>;
    const entry = entries.get(creditIds.entry)!;
    const lines = purchase
      ? entry.lines.map((line) => (line.account === '628' ? { ...line, account: '371' } : line))
      : [
          ...entry.lines,
          { account: '371', side: 'C' as const, bani: 30_000n },
          { account: '607', side: 'D' as const, bani: 30_000n },
        ];
    const move = purchase
      ? { quantity: 10_000n, bani: 497_650n, line: 0 }
      : { quantity: -10_000n, bani: -30_000n, line: lines.length - 2 };
    entries.set(creditIds.entry, {
      ...entry,
      lines,
      stockMoves: [{ item: ITEM, warehouse: WAREHOUSE, account: '371', layer: LAYER, ...move }],
    });
    // The pool as it stands: the 10 bought, or 5 left after the sale.
    const held = purchase
      ? { quantity: 10_000n, bani: 497_650n }
      : { quantity: 5_000n, bani: 15_000n };
    return {
      credit,
      loaded: {
        ...loaded,
        profile: [...loaded.profile, ...policies],
        stock: new Map([
          [
            `${ITEM}|${WAREHOUSE}`,
            {
              item: ITEM,
              warehouse: WAREHOUSE,
              moves: purchase ? 1 : 2,
              layers: [
                {
                  id: LAYER,
                  item: ITEM,
                  warehouse: WAREHOUSE,
                  account: '371',
                  method: 'average' as const,
                  mayGoNegative: false,
                  ...held,
                  date: (purchase ? '2026-03-10' : '2026-03-02') as never,
                  originEntryId: purchase ? creditIds.entry : creditIds.revaluation,
                  seq: 1,
                  days: [],
                },
              ],
            },
          ],
        ]),
        stockItems: new Map([
          [
            ITEM,
            {
              id: ITEM,
              code: 'CAF-1',
              name: 'Cafea',
              unit: 'H87',
              nc8: null,
              account: '371',
              vatCategory: 'standard',
            },
          ],
        ]),
        warehouses: new Map([
          [WAREHOUSE, { id: WAREHOUSE, code: 'D1', name: 'Depozit', keeper: 'Ionescu Maria' }],
        ]),
      },
    };
  }
  const evaluate = (purchase: boolean, options: { revalued?: boolean } = {}) => {
    const { loaded } = withGoods(purchase, options);
    return creditRecognition.evaluate(
      creditInput.parse({
        documentId: creditIds.credit,
        originalDocumentId: creditIds.original,
        account: purchase ? '371' : '704',
        stock: { warehouseId: WAREHOUSE, lines: [{ line: '1', itemId: ITEM, quantity: '1' }] },
      }),
      loaded,
      new RuleContext(register, 'preview'),
    );
  };
  const moves = (evaluation: Evaluation) =>
    evaluation.effect?.stockMoves?.map(
      (move) => `${move.quantity} ${formatMoney(move.bani, 'RON')} ${move.line}`,
    );

  test('from the customer: back at the cost the sale took it out at, in lei', () => {
    const evaluation = evaluate(false);
    expect(codes(evaluation)).toEqual([]);
    expect(lines(evaluation.effect)).toEqual([
      'D 4111 -602.16 [-121.00 @ 4.9765]',
      'C 704 -498.50 [-100.00 @ 4.9850]',
      'C 4427 -104.51 [-21.00 @ 4.9765]',
      'C 371 -30.00',
      'D 607 -30.00',
      'C 7651 0.85',
    ]);
    expect(moves(evaluation)).toEqual(['1000 30.00 3']);
  });

  test('to the supplier: out at the cost its receipt entered at, the payable at its carrying amount', () => {
    const evaluation = evaluate(true);
    expect(codes(evaluation)).toEqual([]);
    expect(lines(evaluation.effect)).toEqual([
      'D 371 -497.65',
      'D 4426 -104.51 [-21.00 @ 4.9765]',
      'C 401 -602.16 [-121.00 @ 4.9765]',
    ]);
    expect(moves(evaluation)).toEqual(['-1000 -497.65 0']);
    const revalued = evaluate(true, { revalued: true });
    expect(lines(revalued.effect)).toEqual([
      'D 371 -497.65',
      'D 4426 -104.51 [-21.00 @ 4.9765]',
      'C 401 -603.79 [-121.00 @ 4.9900]',
      'C 7651 1.63',
    ]);
    expect(revalued.effect?.explanation.details).toMatchObject({
      fx: { difference: '1.63' },
      stock: { atCost: true },
    });
  });
});

describe('D406: a credit note’s VAT at its invoice’s rate', () => {
  // CN-1 of 08.04.2026 as the books hold it: the receivable at 4.9900, the revenue at 5.0100, the
  // VAT at EXP-1's 4.9765 (−42.00 × 4.9765 = −209.013 → −209.01), the difference on 7651.
  const customer = d406PartyId({ kind: 'ro', cui: '14399840' });
  const euro = (amount: string, rate: string) => ({ currency: { code: 'EUR', amount, rate } });
  const model = (rate?: string): D406 => {
    const lines: D406Line[] = [
      {
        id: '1',
        account: '4111.01',
        side: 'debit',
        amount: '-1207.58',
        ...euro('-242.00', '4.9900'),
        customer,
        document: 'CN-1',
        description: 'Client Test SRL',
      },
      {
        id: '2',
        account: '704',
        side: 'credit',
        amount: '-1002.00',
        ...euro('-200.00', '5.0100'),
        document: 'CN-1',
        description: 'Venituri din servicii',
        tax: [
          {
            type: '300',
            code: '310344',
            base: '-995.30',
            amount: '-209.01',
            currencyAmount: '-42.00',
            ...(rate ? { rate } : {}),
          },
        ],
      },
      {
        id: '3',
        account: '4427',
        side: 'credit',
        amount: '-209.01',
        ...euro('-42.00', '4.9765'),
        document: 'CN-1',
        description: 'TVA colectată',
      },
      {
        id: '4',
        account: '7651',
        side: 'credit',
        amount: '3.43',
        document: 'CN-1',
        description: 'Diferență de curs realizată',
      },
    ];
    return {
      type: 'L',
      period: { year: 2026, month: 4 },
      created: '2026-05-10',
      software: { company: 'xFactura', name: 'xFactura', version: '0.0.1' },
      company: {
        cui: '18547290',
        name: 'Exemplu Servicii SRL',
        address: {
          street: 'Str. Lungă',
          number: '10',
          city: 'Galați',
          county: 'RO-GL',
          country: 'RO',
        },
        contact: { firstName: 'Ana', lastName: 'Popescu', phone: '0236000000' },
        ibans: ['RO49AAAA1B31007593840000'],
        vatRegime: '100010',
      },
      accounts: [
        { code: '1012', description: 'Capital subscris vărsat', opening: '-5000.00' },
        { code: '4111.01', description: 'Clienți', opening: '5000.00' },
        { code: '4427', description: 'TVA colectată', opening: '0' },
        { code: '704', description: 'Venituri din servicii', opening: '0' },
        { code: '7651', description: 'Venituri din diferențe de curs', opening: '0' },
      ],
      customers: [
        {
          id: customer,
          name: 'Client Test SRL',
          address: { city: 'Brașov', county: 'RO-BV', country: 'RO' },
          account: '4111.01',
          opening: '5000.00',
        },
      ],
      suppliers: [],
      products: [],
      journals: [
        {
          id: 'VZ',
          description: 'Jurnal de vânzări',
          type: 'VZ',
          transactions: [{ id: 'VZ-1', date: '2026-04-08', description: 'Nota CN-1', lines }],
        },
      ],
      salesInvoices: [],
      purchaseInvoices: [],
      payments: [],
    };
  };
  const conversions = (value: D406) =>
    checkD406(value).filter((check) => check.code === 'D406_CONVERSION');

  test('each amount is its currency at its own rate: the TaxAmount states the invoice’s', () => {
    expect(conversions(model('4.9765'))).toEqual([]);
    // At the line's rate the VAT would be −42.00 × 5.0100 = −210.42.
    expect(conversions(model()).map((check) => check.message)).toEqual([
      'TVA în lei (-209.01) diferă de -42.00 × 5.0100.',
    ]);
    expect(conversions(model('4.9900')).map((check) => check.path)).toEqual([
      'journals.0.transactions.0.lines.1.tax.0.amount',
    ]);
    expect(writeD406(model('4.9765')).replace(/>\s+</g, '><')).toContain(
      '<nsSAFT:TaxAmount><nsSAFT:Amount>-209.01</nsSAFT:Amount><nsSAFT:CurrencyCode>EUR</nsSAFT:CurrencyCode><nsSAFT:CurrencyAmount>-42.00</nsSAFT:CurrencyAmount><nsSAFT:ExchangeRate>4.9765</nsSAFT:ExchangeRate></nsSAFT:TaxAmount>',
    );
    expect(checkD406(model('0')).map((check) => check.code)).toContain('D406_RATE');
  });
});

// What `sales.issue` writes as an issued credit note's VAT in lei (BT-111): its VAT in euro at the
// rate EXP-1's VAT entry records, 4.9765, as `invoices.credit` expects it, never at the note's own.
describe('the VAT in lei of a credit note in a currency (`creditVatInLei`)', () => {
  const original = (loaded: ReturnType<typeof creditLoaded>) => ({
    taxPoint: '2026-03-10' as never,
    entries: loaded.entries.get(creditIds.entry)!.taxEntries,
  });

  test('its VAT at its invoice’s rate, in March and after the revaluation; the event’s otherwise', () => {
    const rules = new RuleContext(register, 'preview');
    const march = creditLoaded(register, note('2026-03-20', '100.00', '104.51'));
    // 21.00 × 4.9765 = 104.5065 → 104.51, not 21.00 × 4.9850 = 104.685 → 104.69.
    const first = creditVatInLei(
      march,
      rules,
      { currency: 'EUR', taxPoint: '2026-03-20' as never, taxMinor: 2100n },
      original(march),
    );
    expect('code' in first ? first : [first.bani, first.rate.rate]).toEqual([10451n, '4.9765']);
    // 42.00 × 4.9765 = 209.013 → 209.01, in April, the receivable revalued in between.
    const april = creditLoaded(register, note('2026-04-08', '200.00', '209.01'), {
      revalued: true,
    });
    const second = creditVatInLei(
      april,
      rules,
      { currency: 'EUR', taxPoint: '2026-04-08' as never, taxMinor: 4200n },
      original(april),
    );
    expect('code' in second ? second : second.bani).toBe(20901n);
    // It is what the recognition books, without a difference to acknowledge.
    expect(
      creditEvaluation(register, note('2026-04-08', '200.00', '209.01'), {
        revalued: true,
      }).evaluation.issues.map((issue) => issue.code),
    ).toEqual([]);
    // The other reading of `ro.fx.adjustment.vat`: the note's own date's rate.
    const event = creditVatInLei(
      march,
      new RuleContext(withValue('ro.fx.adjustment.vat', 'event'), 'preview'),
      { currency: 'EUR', taxPoint: '2026-03-20' as never, taxMinor: 2100n },
      original(march),
    );
    expect('code' in event ? event : event.bani).toBe(10469n);
  });
});
