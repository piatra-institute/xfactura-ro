import { describe, expect, test } from 'bun:test';
import type { Evaluation, Loaded, PartyRecord } from '../src/kernel';
import { RuleContext } from '../src/rules';
import { roRegister } from '../src/ro/register';
import * as schemesAgent from '../src/ro/schemes/agent';
import {
  flatRateCompensation,
  flatRateInput,
  flatRateRecognition,
} from '../src/ro/schemes/agriculture';
import {
  marginPurchase,
  marginPurchaseInput,
  marginSale,
  marginSaleInput,
  parseMarginItem,
} from '../src/ro/schemes/invoices';
import { marginVat, mentionedScheme, schemeMentions } from '../src/ro/schemes/margin';
import {
  documentsCounted,
  earlierPeriods,
  travelMargin,
  travelMarginInput,
} from '../src/ro/schemes/travel';
import {
  farmerEvaluation,
  farmerWorld,
  goodsEvaluation,
  goodsWorld,
  schemeIds,
  schemeInvoice,
  travelEvaluation,
  travelWorld,
} from '../src/ro/reviews/specs/schemes';
import { emptyLoaded } from '../src/ro/reviews/specs/world';
import { questionKinds } from '../src/questions/kinds';
import { invoiceKinds } from '../src/ro/treatments/invoices';
import type { LocalDate } from '../src/time';

// The special VAT schemes (V4). Amounts by hand, at the standard rate of 21%, VAT = margin × 21
// ÷ 121 half up:
//   travel: 10.000,00 − 7.580,00 = 2.420,00 → VAT 420,00, base 2.000,00; a second trip at
//   3.000,00 − 3.605,00 = −605,00 brings the period to 1.815,00 → VAT 315,00, base 1.500,00;
//   goods: 1.500,00 − 1.000,00 = 500,00 → VAT 86,78 (86,776), base 413,22; 1.800,00 − 2.000,00
//   gives no VAT;
//   flat rate: 8% of 10.000,00 = 800,00.

const register = roRegister();
const codes = (evaluation: Evaluation) => evaluation.issues.map((issue) => issue.code);
const blocks = (evaluation: Evaluation) =>
  evaluation.issues.filter((issue) => issue.severity === 'block').map((issue) => issue.code);
const lines = (evaluation: Evaluation) =>
  evaluation.effect?.lines.map((line) => `${line.side} ${line.account} ${line.bani}`);

describe('the margin', () => {
  test('VAT inclusive by the hundred-plus method, nothing on a margin of zero or less', () => {
    expect(marginVat(242000n, '21')).toEqual({ vat: 42000n, base: 200000n });
    expect(marginVat(50000n, '21')).toEqual({ vat: 8678n, base: 41322n });
    expect(marginVat(30000n, '21')).toEqual({ vat: 5207n, base: 24793n });
    expect(marginVat(0n, '21')).toEqual({ vat: 0n, base: 0n });
    expect(marginVat(-20000n, '21')).toEqual({ vat: 0n, base: 0n });
    // The 19% the norms wrote (19 × 100 / 119) for a 2025 margin.
    expect(marginVat(11900n, '19')).toEqual({ vat: 1900n, base: 10000n });
  });

  test('the invoice mentions of art. 319 alin. (20) lit. n) and o), read through dashes and diacritics', () => {
    const mention = (reason: string) =>
      mentionedScheme(
        schemeInvoice({
          number: '1',
          issueDate: '2026-10-01',
          sale: true,
          partner: { name: 'Client', taxId: 'RO13548146' },
          lines: ['100.00'],
          reason,
        }),
      );
    expect(mention('Regimul marjei – agenții de turism')).toBe('travel');
    expect(mention('regimul marjei - agentii de turism')).toBe('travel');
    expect(mention('REGIMUL MARJEI-BUNURI SECOND-HAND')).toBe('second_hand');
    expect(mention(schemeMentions.collectibles_antiques)).toBe('collectibles_antiques');
    expect(mention('art. 292 alin. (2) lit. g)')).toBeNull();
  });
});

describe('margin.travel', () => {
  test("one trip: the period's margin, its VAT on rd. 9, the revenue reduced", () => {
    const { evaluation } = travelEvaluation(register, [
      { reference: 'CT-1', sales: ['10000.00'], costs: [{ gross: '7580.00' }] },
    ]);
    expect(blocks(evaluation)).toEqual([]);
    expect(codes(evaluation)).toEqual(['TRAVEL_COSTS']);
    expect(lines(evaluation)).toEqual(['D 704 42000', 'C 4427 42000']);
    const [entry] = evaluation.effect!.taxEntries;
    expect(entry).toMatchObject({
      code: 'MS-311-21',
      direction: 'output',
      baseBani: 200000n,
      taxBani: 42000n,
      taxPeriod: '2026-10',
      line: 1,
    });
    expect(entry!.attributes).toMatchObject({
      sales: '10000.00',
      costs: '7580.00',
      margin: '2420.00',
      trips: '1',
    });
    expect(entry!.attributes.documents!.split(',')).toHaveLength(2);
  });

  test('two trips, one at a loss: the period nets them (an info), the per-trip reading would not', () => {
    const { evaluation } = travelEvaluation(register, [
      { reference: 'CT-1', sales: ['10000.00'], costs: [{ gross: '7580.00' }] },
      { reference: 'CT-2', sales: ['3000.00'], costs: [{ gross: '3605.00' }] },
    ]);
    expect(codes(evaluation)).toEqual(['TRAVEL_TRIP_NEGATIVE', 'TRAVEL_COSTS']);
    expect(evaluation.effect!.taxEntries[0]).toMatchObject({ baseBani: 150000n, taxBani: 31500n });
  });

  test('a negative period is UNSUPPORTED; a deducted cost, a trip outside the Union, own means and a document counted twice are refused', () => {
    const negative = travelEvaluation(register, [
      { reference: 'CT-3', sales: ['2000.00'], costs: [{ gross: '2420.00' }] },
    ]).evaluation;
    expect(blocks(negative)).toEqual(['TRAVEL_MARGIN_NEGATIVE']);
    const deducted = travelEvaluation(register, [
      { reference: 'CT-1', sales: ['10000.00'], costs: [{ gross: '7580.00', deducted: true }] },
    ]).evaluation;
    expect(blocks(deducted)).toEqual(['TRAVEL_COST_DEDUCTED']);

    const { loaded, input } = travelWorld([
      { reference: 'CT-1', sales: ['10000.00'], costs: [{ gross: '7580.00' }] },
    ]);
    const trips = input.trips as { place: string; costs: unknown[]; supplied: string }[];
    const evaluate = (changed: Record<string, unknown>) =>
      travelMarginEvaluate(loaded, { ...input, ...changed });
    expect(blocks(evaluate({ trips: [{ ...trips[0]!, place: 'mixed' }] }))).toEqual([
      'TRAVEL_OUTSIDE_EU',
    ]);
    expect(blocks(evaluate({ trips: [{ ...trips[0]!, costs: [] }] }))).toContain(
      'TRAVEL_OWN_MEANS',
    );
    expect(blocks(evaluate({ trips: [{ ...trips[0]!, supplied: '2026-11-02' }] }))).toEqual([
      'TRAVEL_SUPPLIED',
    ]);
    expect(
      blocks(evaluate({ trips: [trips[0]!, { ...trips[0]!, reference: 'CT-1 bis' }] })),
    ).toContain('TRAVEL_DOCUMENT_TWICE');
    expect(blocks(evaluate({ date: '2026-11-01' }))).toContain('PERIOD');
  });

  test('the documents a posted computation counted, net of its reversal, are refused in a later one', () => {
    const { loaded, input } = travelWorld([
      { reference: 'CT-1', sales: ['10000.00'], costs: [{ gross: '7580.00' }] },
    ]);
    const posted = travelMarginEvaluate(loaded, input).effect!.taxEntries[0]!;
    const ledger = (reversed: boolean) => ({
      tax: 'VAT',
      period: '2026-10',
      settlements: [],
      entries: [
        {
          ...posted,
          entryId: 'e1',
          seq: 1,
          taxNo: 1,
          documentId: null,
          partyId: null,
          originTaxEntry: null,
        },
        ...(reversed
          ? [
              {
                ...posted,
                entryId: 'e2',
                seq: 2,
                taxNo: 1,
                baseBani: -posted.baseBani,
                documentId: null,
                partyId: null,
                originTaxEntry: 'e1:1',
              },
            ]
          : []),
      ],
    });
    (loaded.taxLedger as Map<string, unknown>).set('VAT|2026-10', ledger(false));
    expect(documentsCounted(loaded, earlierPeriods('2026-11')).size).toBe(2);
    expect(blocks(travelMarginEvaluate(loaded, { ...input, round: 2 }))).toContain(
      'TRAVEL_DOCUMENT_USED',
    );
    (loaded.taxLedger as Map<string, unknown>).set('VAT|2026-10', ledger(true));
    expect(documentsCounted(loaded, earlierPeriods('2026-11')).size).toBe(0);
  });
});

/** The treatment the spec runs, on a changed input. */
function travelMarginEvaluate(loaded: Loaded, input: Record<string, unknown>) {
  return travelMargin.evaluate(
    travelMarginInput.parse(input),
    loaded,
    new RuleContext(register, 'preview'),
  );
}

describe('margin.sale and margin.purchase: goods', () => {
  test('a purchase from an individual: the item on 371, its self-invoice confirmed, rd. 29', () => {
    const loaded = emptyLoaded([
      { axis: 'vat.status', value: 'normal_vat', effectiveFrom: '2020-01-01' as LocalDate },
      { axis: 'activity.goods', value: 'margin_goods', effectiveFrom: '2026-01-01' as LocalDate },
    ]);
    const body = schemeInvoice({
      number: 'AF-1',
      issueDate: '2026-09-10',
      sale: false,
      partner: { name: 'Ion Popescu', taxId: '1800101400016' },
      lines: ['1000.00'],
      category: 'O',
    });
    (loaded.documents as Map<string, unknown>).set(schemeIds.purchase(1), {
      id: schemeIds.purchase(1),
      kind: invoiceKinds.purchase,
      schema: body.parserVersion,
      body,
      bodyHash: 'x',
      docDate: body.issueDate,
      partyId: schemeIds.partner,
      currency: 'RON',
      number: body.number,
      evidenceId: null,
    });
    const run = (input: Record<string, unknown>, at = loaded) =>
      marginPurchase.evaluate(
        marginPurchaseInput.parse({ documentId: schemeIds.purchase(1), scheme: 'goods', ...input }),
        at,
        new RuleContext(register, 'preview'),
      );
    const bought = run({ goods: 'second_hand', supplier: 'individual' });
    expect(blocks(bought)).toEqual([]);
    expect(codes(bought)).toEqual(['MARGIN_SELF_INVOICE']);
    expect(lines(bought)).toEqual(['D 371 100000', 'C 401 100000']);
    const line = bought.effect!.lines[0]!;
    expect(parseMarginItem(line.analytics!.item!)).toEqual({
      goods: 'second_hand',
      documentId: schemeIds.purchase(1),
    });
    expect(bought.effect!.taxEntries[0]).toMatchObject({
      code: 'MS-312-A',
      direction: 'input',
      baseBani: 100000n,
      taxBani: 0n,
      deductibleBani: 0n,
    });
    // A dealer must be registered for VAT; quantity stock is not covered; without the statement,
    // a question.
    expect(blocks(run({ goods: 'second_hand', supplier: 'dealer' }))).toEqual(['MARGIN_SUPPLIER']);
    const stock = emptyLoaded([
      { axis: 'vat.status', value: 'normal_vat', effectiveFrom: '2020-01-01' as LocalDate },
      { axis: 'activity.goods', value: 'yes', effectiveFrom: '2026-01-01' as LocalDate },
    ]);
    (stock.documents as Map<string, unknown>).set(
      schemeIds.purchase(1),
      loaded.documents.get(schemeIds.purchase(1)),
    );
    expect(blocks(run({ goods: 'second_hand', supplier: 'individual' }, stock))).toEqual([
      'MARGIN_STOCK',
    ]);
    const unknown = emptyLoaded([
      { axis: 'vat.status', value: 'normal_vat', effectiveFrom: '2020-01-01' as LocalDate },
    ]);
    (unknown.documents as Map<string, unknown>).set(
      schemeIds.purchase(1),
      loaded.documents.get(schemeIds.purchase(1)),
    );
    const asked = run({ goods: 'second_hand', supplier: 'individual' }, unknown);
    expect(
      (
        asked.issues.find((issue) => issue.code === 'MARGIN_STOCK')!.details as {
          question: { subject: { id: string } };
        }
      ).question.subject.id,
    ).toBe('activity.goods');
  });

  test('a sale at a margin and a sale at a loss: VAT on each margin, nothing on the loss', () => {
    const one = goodsEvaluation(register, [{ cost: '1000.00', price: '1500.00' }]).evaluation;
    expect(blocks(one)).toEqual([]);
    expect(lines(one)).toEqual([
      'D 4111 150000',
      'C 707 141322',
      'C 4427 8678',
      'D 607 100000',
      'C 371 100000',
    ]);
    expect(one.effect!.taxEntries[0]).toMatchObject({
      code: 'MS-312-21',
      baseBani: 41322n,
      taxBani: 8678n,
      line: 2,
    });
    expect(one.effect!.taxEntries[0]!.attributes).toMatchObject({
      price: '1500.00',
      cost: '1000.00',
      margin: '500.00',
      goods: 'second_hand',
    });
    const loss = goodsEvaluation(register, [{ cost: '2000.00', price: '1800.00' }]).evaluation;
    expect(blocks(loss)).toEqual([]);
    expect(lines(loss)).toEqual(['D 4111 180000', 'C 707 180000', 'D 607 200000', 'C 371 200000']);
    expect(loss.effect!.taxEntries[0]).toMatchObject({ baseBani: 0n, taxBani: 0n });
    expect(loss.effect!.taxEntries[0]!.line).toBeUndefined();
    // Both on one invoice: the loss does not reduce the other item's VAT.
    const both = goodsEvaluation(register, [
      { cost: '1000.00', price: '1500.00' },
      { cost: '2000.00', price: '1800.00' },
    ]).evaluation;
    expect(both.effect!.taxEntries.map((entry) => entry.taxBani)).toEqual([8678n, 0n]);
  });

  test('an item sold twice, an unknown item, VAT shown and the price not adding up are refused', () => {
    expect(
      blocks(
        goodsEvaluation(register, [{ cost: '1000.00', price: '1500.00' }], { sold: true })
          .evaluation,
      ),
    ).toEqual(['MARGIN_ITEM_SOLD']);
    const { loaded, input } = goodsWorld([{ cost: '1000.00', price: '1500.00' }]);
    const run = (changed: Record<string, unknown>) =>
      marginSale.evaluate(
        marginSaleInput.parse({ ...input, ...changed }),
        loaded,
        new RuleContext(register, 'preview'),
      );
    expect(
      blocks(run({ items: [{ purchaseDocumentId: schemeIds.purchase(9), price: '1500.00' }] })),
    ).toEqual(['MARGIN_ITEM_UNKNOWN']);
    expect(
      blocks(run({ items: [{ purchaseDocumentId: schemeIds.purchase(1), price: '1400.00' }] })),
    ).toEqual(['ALLOCATION']);
  });

  test('the normal regime instead (art. 312 alin. (7)): VAT on the whole price, the item still leaves 371', () => {
    const normal = goodsEvaluation(register, [{ cost: '1000.00', price: '1500.00' }], {
      regime: 'normal',
    }).evaluation;
    expect(blocks(normal)).toEqual([]);
    expect(lines(normal)).toEqual([
      'D 4111 181500',
      'C 707 150000',
      'C 4427 31500',
      'D 607 100000',
      'C 371 100000',
    ]);
    expect(normal.effect!.taxEntries[0]).toMatchObject({ code: 'S-21', baseBani: 150000n });
  });
});

describe('invoices.flatRate', () => {
  test('the compensation of 8%, deducted like VAT once the register answer covers the supply', () => {
    expect(flatRateCompensation(1000000n, '8')).toBe(80000n);
    const { evaluation } = farmerEvaluation(register, {
      price: '10000.00',
      compensation: '800.00',
      registeredFrom: '2025-03-01',
    });
    expect(blocks(evaluation)).toEqual([]);
    expect(codes(evaluation)).toEqual(['FLAT_RATE_PRODUCTS']);
    expect(lines(evaluation)).toEqual(['D 6028 1000000', 'D 4426 80000', 'C 401 1080000']);
    expect(evaluation.effect!.taxEntries[0]).toMatchObject({
      code: 'FR-315',
      direction: 'input',
      baseBani: 1000000n,
      taxBani: 80000n,
      deductibleBani: 80000n,
      line: 1,
    });
    // Not deducted: the compensation stays in the expense.
    const kept = farmerEvaluation(register, {
      price: '10000.00',
      compensation: '800.00',
      registeredFrom: '2025-03-01',
      deduction: 'none',
    }).evaluation;
    expect(lines(kept)).toEqual(['D 6028 1000000', 'D 6028 80000', 'C 401 1080000']);
  });

  test('without the answer a question; outside the register or at another percent refused; a supplier recorded as a company confirmed', () => {
    const asked = farmerEvaluation(register, {
      price: '10000.00',
      compensation: '800.00',
    }).evaluation;
    const issue = asked.issues.find((item) => item.code === 'FLAT_RATE_REGISTER')!;
    expect(issue.details).toMatchObject({
      question: { kind: 'farmer.register', subject: { kind: 'party', id: schemeIds.farmer } },
    });
    expect(
      blocks(
        farmerEvaluation(register, {
          price: '10000.00',
          compensation: '800.00',
          registeredFrom: '2026-11-01',
        }).evaluation,
      ),
    ).toEqual(['FLAT_RATE_REGISTER']);
    expect(
      blocks(
        farmerEvaluation(register, {
          price: '10000.00',
          compensation: '900.00',
          registeredFrom: '2025-03-01',
        }).evaluation,
      ),
    ).toEqual(['FLAT_RATE_AMOUNT']);
    const { loaded, input } = farmerWorld({
      price: '10000.00',
      compensation: '800.00',
      registeredFrom: '2025-03-01',
    });
    (loaded.parties as Map<string, PartyRecord>).set(schemeIds.farmer, {
      ...loaded.parties.get(schemeIds.farmer)!,
      kind: 'ro_legal_entity',
    });
    const company = flatRateRecognition.evaluate(
      flatRateInput.parse(input),
      loaded,
      new RuleContext(register, 'preview'),
    );
    expect(blocks(company)).toEqual([]);
    expect(codes(company)).toContain('FLAT_RATE_SUPPLIER_FORM');
    // A stock account waits for G1.
    const stock = flatRateRecognition.evaluate(
      flatRateInput.parse({ ...input, parts: [{ account: '371', amount: '10000.00' }] }),
      farmerWorld({ price: '10000.00', compensation: '800.00', registeredFrom: '2025-03-01' })
        .loaded,
      new RuleContext(register, 'preview'),
    );
    expect(blocks(stock)).toEqual(['ACCOUNT']);
  });

  test("the farmer's own sale: the products' revenue and the compensation apart, no VAT", () => {
    const loaded = emptyLoaded([
      { axis: 'entity.form', value: 'pfa', effectiveFrom: '2026-01-01' as LocalDate },
      { axis: 'vat.status', value: 'non_vat', effectiveFrom: '2026-01-01' as LocalDate },
      { axis: 'vat.agriculture', value: 'special', effectiveFrom: '2026-03-01' as LocalDate },
    ]);
    const body = schemeInvoice({
      number: 'AGR-1',
      issueDate: '2026-10-12',
      sale: true,
      partner: { name: 'Client exemplu SRL', taxId: 'RO13548146' },
      lines: ['10000.00', '800.00'],
      category: 'O',
      reason: 'VATEX-EU-O',
    });
    (loaded.documents as Map<string, unknown>).set(schemeIds.sale(1), {
      id: schemeIds.sale(1),
      kind: invoiceKinds.sale,
      schema: body.parserVersion,
      body,
      bodyHash: 'x',
      docDate: body.issueDate,
      partyId: schemeIds.partner,
      currency: 'RON',
      number: body.number,
      evidenceId: null,
    });
    const run = (input: Record<string, unknown>, at = loaded) =>
      flatRateRecognition.evaluate(
        flatRateInput.parse({
          documentId: schemeIds.sale(1),
          parts: [{ account: '701', amount: '10000.00' }],
          ...input,
        }),
        at,
        new RuleContext(register, 'preview'),
      );
    const sold = run({ compensationAccount: '7588' });
    expect(blocks(sold)).toEqual([]);
    expect(lines(sold)).toEqual(['D 4111 1080000', 'C 701 1000000', 'C 7588 80000']);
    expect(sold.effect!.taxEntries).toEqual([]);
    // The compensation's account is the accountant's choice; an SRL is no farmer.
    expect(blocks(run({}))).toEqual(['FLAT_RATE_ACCOUNT']);
    const srl = emptyLoaded([
      { axis: 'entity.form', value: 'srl', effectiveFrom: '2026-01-01' as LocalDate },
      { axis: 'vat.status', value: 'non_vat', effectiveFrom: '2026-01-01' as LocalDate },
      { axis: 'vat.agriculture', value: 'special', effectiveFrom: '2026-03-01' as LocalDate },
    ]);
    (srl.documents as Map<string, unknown>).set(
      schemeIds.sale(1),
      loaded.documents.get(schemeIds.sale(1)),
    );
    expect(blocks(run({ compensationAccount: '7588' }, srl))).toEqual(['FLAT_RATE_FARMER']);
  });

  test('the farmer register question kind takes an extract and a date', () => {
    const kind = questionKinds['farmer.register'];
    expect(
      kind
        .answer({})
        .safeParse({ registered: true, from: '2025-03-01', evidenceId: schemeIds.evidence })
        .success,
    ).toBe(true);
    expect(
      kind.answer({}).safeParse({
        registered: true,
        from: '2025-03-01',
        until: '2024-01-01',
        evidenceId: schemeIds.evidence,
      }).success,
    ).toBe(false);
    expect(kind.subjects).toEqual(['party']);
  });
});

test('the module is agent-ready: documents, questions, detectors', () => {
  expect(schemesAgent.questions.map((item) => item.kind)).toEqual([
    'farmer.register',
    'profile.fact',
  ]);
  expect(schemesAgent.detectors.map((item) => item.kind)).toEqual([
    'margin.travel',
    'document.unproposed',
    'question.needed',
    'obligation.due',
  ]);
  for (const key of ['ro.vat.margin.travel', 'ro.vat.margin.goods', 'ro.vat.flat_rate.agriculture'])
    expect(register.versions.find((version) => version.key === key)?.status).toBe('extracted');
});
