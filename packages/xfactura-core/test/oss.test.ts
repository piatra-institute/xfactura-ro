import { describe, expect, test } from 'bun:test';
import type { Loaded, ProfileFact, TaxLedgerEntry } from '../src/kernel';
import { calculateD398, checkD398, writeD398, type D398 } from '../src/ro/declarations/d398';
import {
  determineYear,
  evaluateClosure,
  thresholdWatches,
  type ClosureBooks,
  type DeterminationContext,
  type Known,
  type YearFigures,
} from '../src/ro/determinations';
import { obligationDue } from '../src/ro/obligations';
import {
  agent,
  euConsumerInput,
  euConsumerRecognition,
  memberStateOf,
  resolveRate,
  type DistanceSale,
} from '../src/ro/oss';
import { emptyLoaded } from '../src/ro/reviews/specs/world';
import { roRegister } from '../src/ro/register';
import { d406StartOf } from '../src/ro/saft/applicability';
import { d406VatTaxCode } from '../src/ro/saft/tax-codes';
import { clause } from '../src/ro/sources';
import { invoiceKinds } from '../src/ro/treatments/invoices';
import { RuleContext } from '../src/rules';
import type { LocalDate } from '../src/time';
import { invoiceDocumentSchema } from '../src/ubl/invoice-document';

// Synthetic e-commerce SRL selling e-books and courses to consumers; amounts computed by hand.
const register = roRegister();
const rules = () => new RuleContext(register, 'preview');
const fact = (axis: string, value: string, effectiveFrom: string): ProfileFact => ({
  axis,
  value,
  effectiveFrom: effectiveFrom as LocalDate,
});
const lei = (text: string) => BigInt(Math.round(Number(text) * 100));
const books = <T>(value: T): Known<T> => ({ known: true, value, source: 'books', ref: null });
const figures = (year: number): YearFigures => ({
  year,
  kept: true,
  turnover: books(0n),
  netTurnover: books(0n),
  totalRevenue: books(0n),
  vatTurnover: books(0n),
  exemptionTurnover: books(0n),
  totalAssets: books(0n),
  averageEmployees: books('0'),
  averageEmployeesD112: books('0'),
  euGoodsAcquisitions: books(false),
  eurRate: books({ rate: '5.0800', multiplier: 1, date: '2025-12-31' }),
  distanceTurnover: books(0n),
});
const payer = [
  fact('entity.form', 'srl', '2020-01-01'),
  fact('vat.status', 'normal_vat', '2020-01-01'),
  fact('vat.period', 'quarterly', '2026-01-01'),
  fact('employer', 'no', '2020-01-01'),
  fact('income_tax', 'micro', '2026-01-01'),
  fact('size.category', 'micro', '2026-01-01'),
  fact('activity.goods', 'no', '2020-01-01'),
  fact('regime.excluded', 'none', '2020-01-01'),
  fact('vat.cash', 'no', '2020-01-01'),
];
const sale = (date: string, amount: string, regime: 'origin' | 'oss' = 'origin'): DistanceSale => ({
  date: date as LocalDate,
  documentId: `doc-${date}`,
  number: `EB-${date}`,
  base: lei(amount),
  regime,
  country: 'DE',
});
function context(
  facts: ProfileFact[],
  distance: DistanceSale[],
  previous = '0',
): DeterminationContext {
  return {
    year: 2026,
    facts,
    previous: { ...figures(2025), distanceTurnover: books(lei(previous)) },
    current: figures(2026),
    activity: {
      year: 2026,
      kept: true,
      quarterTurnover: [0n, 0n, 0n, 0n],
      days: [],
      distance,
    },
    contracts: [],
    micro: { known: false, reason: 'n/a', question: null },
    today: '2026-11-05' as LocalDate,
  };
}
const emptyBooks: ClosureBooks = {
  firstDay: '2026-01-01',
  financialYearEnds: ['2026-12-31'],
  employmentMonths: [],
  payrollEventMonths: [],
  euServiceMonths: [],
  dividendMonths: [],
  foreignPurchases: [],
  stockMonths: [],
  sponsorshipMonths: [],
  payrollWithoutContractMonths: [],
  incomeSources: [],
  assetYears: [],
};
const of = (items: ReturnType<typeof determineYear>, axis: string) =>
  items.find((item) => item.axis === axis)!;

describe('the threshold of art. 278^1', () => {
  test('is 46.337 lei, cited, and from 2026 only', () => {
    const threshold = rules().param<{ lei: string; eur: string }>(
      'ro.vat.distance.threshold',
      'reporting_period_start',
      '2026-01-01' as LocalDate,
    );
    expect(threshold).toEqual({ eur: '10000', lei: '46337' });
    expect(clause('ANAF/Cod-fiscal-consolidat:art.278^1(5)')?.status).toBe('located');
    expect(() =>
      rules().param(
        'ro.vat.distance.threshold',
        'reporting_period_start',
        '2025-06-01' as LocalDate,
      ),
    ).toThrow();
  });

  test('below it the place is in Romania; the sale that exceeds it moves it to the destination', () => {
    const below = determineYear(
      context(payer, [sale('2026-02-10', '20000'), sale('2026-05-10', '20000')]),
      rules(),
    );
    expect(of(below, 'vat.distance')).toMatchObject({
      status: 'proposed',
      value: 'origin',
      changes: [],
    });
    expect(of(below, 'vat.oss').status).toBe('not_applicable');
    // 20.000 + 20.000 + 6.338 = 46.338 lei > 46.337 lei: from the third sale.
    const crossing = determineYear(
      context(payer, [
        sale('2026-02-10', '20000'),
        sale('2026-05-10', '20000'),
        sale('2026-07-03', '6338'),
      ]),
      rules(),
    );
    const distance = of(crossing, 'vat.distance');
    expect(distance.value).toBe('origin');
    expect(distance.changes).toEqual([
      expect.objectContaining({ value: 'destination', effectiveFrom: '2026-07-03' }),
    ]);
    // Destination without the Union scheme recorded: asked, never assumed.
    expect(of(crossing, 'vat.oss')).toMatchObject({ status: 'needs_evidence' });
    expect(of(crossing, 'vat.oss').questions[0]).toMatchObject({
      kind: 'profile.fact',
      params: { axis: 'vat.oss', from: '2026-07-03' },
    });
  });

  test('a previous year above it, and the option for two years, put the place at the destination', () => {
    const previous = of(
      determineYear(context(payer, [sale('2026-02-10', '100')], '50000'), rules()),
      'vat.distance',
    );
    expect(previous).toMatchObject({ value: 'destination', effectiveFrom: '2026-01-01' });
    const option = of(
      determineYear(
        context(
          [...payer, fact('vat.distance', 'option', '2025-03-01')],
          [sale('2026-02-10', '100')],
        ),
        rules(),
      ),
      'vat.distance',
    );
    expect(option).toMatchObject({ value: 'option', effectiveFrom: '2026-01-01' });
    // An option of 2024 holds 2024 and 2025: in 2026 the threshold decides again.
    const lapsed = of(
      determineYear(
        context(
          [...payer, fact('vat.distance', 'option', '2024-03-01')],
          [sale('2026-02-10', '100')],
        ),
        rules(),
      ),
      'vat.distance',
    );
    expect(lapsed.value).toBe('origin');
  });

  test('the worklist watch warns at 80% while the place is in Romania', () => {
    const watches = thresholdWatches(
      context(
        [...payer, fact('vat.distance', 'origin', '2026-01-01')],
        [sale('2026-03-01', '38000')],
      ),
      rules(),
    );
    expect(watches).toEqual([
      expect.objectContaining({
        key: 'ro.vat.distance.threshold',
        axis: 'vat.distance',
        percent: 82,
      }),
    ]);
  });

  test('the Union scheme: none is UNSUPPORTED, the non-Union scheme too, the import scheme too', () => {
    const crossing = [sale('2026-02-10', '50000')];
    const none = of(
      determineYear(context([...payer, fact('vat.oss', 'none', '2026-01-01')], crossing), rules()),
      'vat.oss',
    );
    expect(none.unsupported?.trigger).toBe('EU_DESTINATION_VAT_UNREGISTERED');
    const late = of(
      determineYear(context([...payer, fact('vat.oss', 'union', '2026-04-01')], crossing), rules()),
      'vat.oss',
    );
    expect(late.unsupported?.trigger).toBe('EU_DESTINATION_VAT_UNREGISTERED');
    const union = of(
      determineYear(context([...payer, fact('vat.oss', 'union', '2026-02-01')], crossing), rules()),
      'vat.oss',
    );
    expect(union).toMatchObject({
      status: 'proposed',
      value: 'union',
      effectiveFrom: '2026-02-01',
    });
    const nonUnion = of(
      determineYear(
        context([...payer, fact('vat.oss', 'non_union', '2026-01-01')], crossing),
        rules(),
      ),
      'vat.oss',
    );
    expect(nonUnion.unsupported?.trigger).toBe('OSS_NON_UNION');
    const ioss = of(
      determineYear(context([...payer, fact('vat.ioss', 'registered', '2026-01-01')], []), rules()),
      'vat.ioss',
    );
    expect(ioss.unsupported?.trigger).toBe('IOSS_SCHEME');
    const goods = of(
      determineYear(context([...payer, fact('activity.goods', 'yes', '2026-01-01')], []), rules()),
      'vat.ioss',
    );
    expect(goods.status).toBe('needs_evidence');
  });
});

describe('the Member States’ rates (TEDB)', () => {
  test('standard, reduced with its category, and the 2026 changes from their day', () => {
    const at = (country: string, day: string, rate: string, category?: string) =>
      resolveRate(rules(), country, day as LocalDate, rate, category);
    expect(at('DE', '2026-08-01', '19')).toMatchObject({ found: true, type: 'standard' });
    expect(at('FR', '2026-08-01', '20')).toMatchObject({ found: true, type: 'standard' });
    expect(at('IT', '2026-08-01', '22')).toMatchObject({ found: true, type: 'standard' });
    expect(at('FI', '2026-08-01', '25.5')).toMatchObject({ found: true, type: 'standard' });
    expect(at('DE', '2026-08-01', '7')).toMatchObject({ found: false });
    expect(at('DE', '2026-08-01', '7', 'NEWSPAPERS')).toMatchObject({
      found: true,
      type: 'reduced',
    });
    expect(at('DE', '2026-08-01', '21')).toMatchObject({ found: false });
    // Austria's 4,9% for foodstuffs from 1 July 2026; Ireland's 9% restaurants too.
    expect(at('AT', '2026-06-30', '4.9', 'FOODSTUFFS')).toMatchObject({ found: false });
    expect(at('AT', '2026-07-01', '4.9', 'FOODSTUFFS')).toMatchObject({ found: true });
    expect(at('IE', '2026-06-30', '9', 'RESTAURANT')).toMatchObject({ found: false });
    expect(at('IE', '2026-07-01', '9', 'RESTAURANT')).toMatchObject({ found: true });
    // Before 2026 the register holds nothing: a gap, never a guessed rate.
    expect(at('DE', '2025-12-31', '19')).toMatchObject({ found: false, gap: expect.any(String) });
    expect(memberStateOf('GR')).toBe('EL');
    expect(memberStateOf('RO')).toBeNull();
    expect(memberStateOf('GB')).toBeNull();
  });
});

const DOCUMENT = '00000000-0000-4000-8000-0000000000e1';
const ORIGINAL = '00000000-0000-4000-8000-0000000000e2';
const CUSTOMER = '00000000-0000-4000-8000-0000000000c1';
const AUTHORITY = '00000000-0000-4000-8000-0000000000a1';
function invoice(
  options: {
    number?: string;
    date?: string;
    country?: string;
    taxId?: string;
    currency?: string;
    rate?: string;
    net?: string;
    tax?: string;
    credit?: boolean;
    original?: string;
  } = {},
) {
  const net = options.net ?? '100.00';
  const tax = options.tax ?? '19.00';
  const gross = (Number(net) + Number(tax)).toFixed(2);
  return invoiceDocumentSchema.parse({
    parserVersion: 'ubl-invoice-4',
    documentType: options.credit ? 'credit_note' : 'invoice',
    number: options.number ?? 'EB-1',
    issueDate: options.date ?? '2026-08-10',
    taxPointDate: null,
    currency: options.currency ?? 'EUR',
    supplier: { name: 'Exemplu Digital SRL', taxId: 'RO18547290', country: 'RO' },
    customer: {
      name: 'Anna Schmidt',
      taxId: options.taxId ?? '0000000000000',
      country: options.country ?? 'DE',
    },
    originalInvoiceNumber: options.original ?? null,
    customizationId: 'urn:cen.eu:en16931:2017',
    lines: [
      { id: '1', description: 'Curs online', net, vatCategory: 'S', vatRate: options.rate ?? '19' },
    ],
    taxes: [{ base: net, tax, category: 'S', rate: options.rate ?? '19', exemptionReason: null }],
    totals: {
      lineNet: net,
      net,
      tax,
      gross,
      allowances: '0.00',
      charges: '0.00',
      prepaid: '0.00',
      rounding: '0.00',
      payable: gross,
    },
  });
}
function loaded(facts: ProfileFact[], body = invoice(), extra: (state: Loaded) => void = () => {}) {
  const state = emptyLoaded(facts);
  const put = (id: string, document: typeof body, kind: string) =>
    (state.documents as Map<string, unknown>).set(id, {
      id,
      kind,
      schema: 'invoice',
      body: document,
      bodyHash: id,
      docDate: document.issueDate,
      partyId: CUSTOMER,
      currency: document.currency,
      number: document.number,
      evidenceId: null,
    });
  put(
    DOCUMENT,
    body,
    body.documentType === 'credit_note' ? invoiceKinds.saleCredit : invoiceKinds.sale,
  );
  (state.parties as Map<string, unknown>).set(AUTHORITY, {
    id: AUTHORITY,
    kind: 'ro_public_institution',
    country: 'RO',
    taxId: '8000000000',
    name: 'ANAF',
  });
  (state.fxRates as Map<string, unknown>).set('EUR', [
    {
      id: 'bnr-eur',
      source: 'BNR',
      currency: 'EUR',
      date: '2026-08-07',
      rate: '5.0000',
      multiplier: 1,
    },
  ]);
  extra(state);
  (state as { put?: typeof put }).put = put;
  return state;
}
const evaluate = (state: Loaded, input: Record<string, unknown>) =>
  euConsumerRecognition.evaluate(
    euConsumerInput.parse({ documentId: DOCUMENT, account: '704', supply: 'electronic', ...input }),
    state,
    rules(),
  );
const location = [
  { kind: 'billing_address', country: 'DE' },
  { kind: 'ip', country: 'DE' },
];
const codes = (issues: readonly { code: string }[]) => issues.map((issue) => issue.code);

describe('invoices.euConsumer', () => {
  test('the place is asked, never assumed; two items of the customer’s location are required', () => {
    const asked = evaluate(loaded(payer), { location });
    expect(asked.effect).toBeNull();
    expect(asked.issues[0]).toMatchObject({
      code: 'DETERMINATION_MISSING',
      details: { question: { kind: 'profile.fact', params: { axis: 'vat.distance' } } },
    });
    const located = evaluate(loaded([...payer, fact('vat.distance', 'origin', '2026-01-01')]), {
      location: [location[0]],
    });
    expect(codes(located.issues)).toContain('CUSTOMER_LOCATION');
  });

  test('one item suffices only as Regulation (EU) No 282/2011 art. 24b allows it, acknowledged', () => {
    const state = () =>
      loaded(
        [...payer, fact('vat.distance', 'origin', '2026-01-01')],
        invoice({ currency: 'RON', rate: '21', net: '500.00', tax: '105.00' }),
      );
    const issue = (result: ReturnType<typeof evaluate>, code: string) =>
      result.issues.find((item) => item.code === code);
    // The customer's SIM the service is supplied through: the presumption of lit. (b).
    const sim = evaluate(state(), { location: [{ kind: 'sim', country: 'DE' }] });
    expect(sim.effect).not.toBeNull();
    expect(issue(sim, 'LOCATION_PRESUMED')).toMatchObject({
      severity: 'ack',
      details: { clauses: expect.arrayContaining(['REG282/2011-A:art.24b']) },
    });
    expect(codes(sim.issues)).not.toContain('CUSTOMER_LOCATION');
    // A single item a third party involved in the supply gave: below €100,000, confirmed.
    const bank = evaluate(state(), {
      location: [{ kind: 'bank', country: 'DE', thirdParty: true }],
    });
    expect(bank.effect).not.toBeNull();
    expect(issue(bank, 'LOCATION_SINGLE_ITEM')?.severity).toBe('ack');
    // The customer's own statement, or "other" information, is not such an item.
    for (const only of [
      { kind: 'billing_address', country: 'DE' },
      { kind: 'other', country: 'DE', thirdParty: true },
      { kind: 'ip', country: 'FR', thirdParty: true },
    ])
      expect(codes(evaluate(state(), { location: [only] }).issues)).toContain('CUSTOMER_LOCATION');
    // Two items that disagree still stop the sale.
    expect(
      codes(
        evaluate(state(), {
          location: [
            { kind: 'sim', country: 'DE' },
            { kind: 'ip', country: 'AT' },
          ],
        }).issues,
      ),
    ).toContain('CUSTOMER_LOCATION');
  });

  test('below the threshold: Romanian VAT on 4427, D300 rd. 17, e-Factura B2C', () => {
    const state = loaded(
      [...payer, fact('vat.distance', 'origin', '2026-01-01')],
      invoice({ currency: 'RON', rate: '21', net: '500.00', tax: '105.00' }),
    );
    const result = evaluate(state, { location });
    expect(result.effect?.lines.map((line) => `${line.side} ${line.account} ${line.bani}`)).toEqual(
      ['D 4111 60500', 'C 704 50000', 'C 4427 10500'],
    );
    expect(result.effect?.taxEntries[0]).toMatchObject({
      code: 'S-21',
      baseBani: 50000n,
      taxBani: 10500n,
      attributes: { distance: 'origin', country: 'DE' },
    });
    expect(codes(result.issues)).toContain('EFACTURA_B2C');
    // The German rate below the threshold is refused: the place is in Romania.
    const wrong = evaluate(loaded([...payer, fact('vat.distance', 'origin', '2026-01-01')]), {
      location,
    });
    expect(codes(wrong.issues)).toContain('ORIGIN_RATE');
  });

  test('the sale that crosses the threshold asks for the destination from its day', () => {
    const prior: TaxLedgerEntry = {
      entryId: 'e-1',
      seq: 1,
      taxNo: 1,
      key: 'vat',
      direction: 'output',
      code: 'S-21',
      baseBani: lei('46000'),
      taxBani: lei('9660'),
      deductibleBani: 0n,
      ledgerBani: lei('9660'),
      taxPoint: '2026-05-10' as LocalDate,
      exigibility: '2026-05-10' as LocalDate,
      documentId: 'other',
      partyId: null,
      originTaxEntry: null,
      attributes: { distance: 'origin', country: 'FR' },
    };
    const state = loaded(
      [...payer, fact('vat.distance', 'origin', '2026-01-01')],
      invoice({ currency: 'RON', rate: '21', net: '500.00', tax: '105.00' }),
      (item) =>
        (item.taxLedger as Map<string, unknown>).set('VAT|2026-Q2', {
          tax: 'VAT',
          period: '2026-Q2',
          entries: [prior],
          settlements: [],
        }),
    );
    const result = evaluate(state, { location });
    expect(result.effect).toBeNull();
    expect(
      result.issues.find((issue) => issue.code === 'DISTANCE_THRESHOLD_CROSSED'),
    ).toMatchObject({
      details: { question: { params: { axis: 'vat.distance', from: '2026-08-10' } } },
    });
  });

  test('above it, in the Union scheme: the German VAT owed in euro on 4423, outside 4427', () => {
    const facts = [
      ...payer,
      fact('vat.distance', 'destination', '2026-07-03'),
      fact('vat.oss', 'union', '2026-07-01'),
    ];
    const result = evaluate(loaded(facts), { location, authorityId: AUTHORITY });
    // 119.00 EUR at 5.0000 = 595.00 lei; VAT 19.00 EUR = 95.00 lei.
    expect(result.effect?.lines.map((line) => `${line.side} ${line.account} ${line.bani}`)).toEqual(
      ['D 4111 59500', 'C 704 50000', 'C 4423 9500'],
    );
    expect(result.effect?.openItems.find((item) => item.ref === 'oss')).toMatchObject({
      kind: 'tax.payable',
      currency: 'EUR',
      dueDate: '2026-10-31',
      partyId: AUTHORITY,
    });
    expect(result.effect?.taxEntries[0]).toMatchObject({
      code: 'EXP-OSS',
      ledgerBani: 0n,
      taxBani: 9500n,
      attributes: {
        regime: 'oss',
        country: 'DE',
        rate: '19',
        rateType: 'standard',
        quarter: '2026-Q3',
        taxMinor: '1900',
      },
    });
    expect(codes(result.issues)).toContain('EFACTURA_NOT_REQUIRED');
    // A German reduced rate needs its TEDB category, acknowledged by the reviewer.
    const reduced = evaluate(loaded(facts, invoice({ rate: '7', tax: '7.00' })), {
      location,
      authorityId: AUTHORITY,
    });
    expect(codes(reduced.issues)).toContain('OSS_RATE');
    const books = evaluate(loaded(facts, invoice({ rate: '7', tax: '7.00' })), {
      location,
      authorityId: AUTHORITY,
      categories: { '7': 'NEWSPAPERS' },
    });
    expect(codes(books.issues)).toContain('OSS_REDUCED_RATE');
    expect(books.effect?.taxEntries[0]?.attributes).toMatchObject({
      rateType: 'reduced',
      category: 'NEWSPAPERS',
    });
    // Not registered: the destination's VAT cannot be declared from Romania.
    const unregistered = evaluate(
      loaded([
        ...payer,
        fact('vat.distance', 'destination', '2026-07-03'),
        fact('vat.oss', 'none', '2026-07-01'),
      ]),
      { location, authorityId: AUTHORITY },
    );
    expect(codes(unregistered.issues)).toContain('OSS_NOT_REGISTERED');
    // A customer with a German VAT code is a business: the B2B rules.
    const business = evaluate(loaded(facts, invoice({ taxId: 'DE123456788' })), {
      location,
      authorityId: AUTHORITY,
    });
    expect(codes(business.issues)).toContain('CUSTOMER_TAXABLE');
  });

  test('a credit note of a later quarter corrects its sale’s quarter', () => {
    const facts = [
      ...payer,
      fact('vat.distance', 'destination', '2026-07-03'),
      fact('vat.oss', 'union', '2026-07-01'),
    ];
    const state = loaded(
      facts,
      invoice({
        number: 'CN-1',
        date: '2026-10-12',
        credit: true,
        net: '50.00',
        tax: '9.50',
        original: 'EB-1',
      }),
      (item) => {
        (item.openItems as Map<string, unknown>).set('item-receivable', {
          id: 'item-receivable',
          kind: 'receivable',
          controlAccount: '4111',
          partyId: CUSTOMER,
          currency: 'EUR',
          documentId: ORIGINAL,
          balanceBani: 59500n,
        });
        (item.fxRates as Map<string, unknown>).set('EUR', [
          {
            id: 'bnr-eur-10',
            source: 'BNR',
            currency: 'EUR',
            date: '2026-10-09',
            rate: '5.1000',
            multiplier: 1,
          },
        ]);
      },
    );
    (state as unknown as { put: (id: string, body: unknown, kind: string) => void }).put(
      ORIGINAL,
      invoice(),
      invoiceKinds.sale,
    );
    const result = evaluate(state, { authorityId: AUTHORITY, originalDocumentId: ORIGINAL });
    expect(result.issues.filter((issue) => issue.severity === 'block')).toEqual([]);
    expect(result.effect?.taxEntries[0]?.attributes).toMatchObject({
      quarter: '2026-Q4',
      corrects: '2026-Q3',
      taxMinor: '-950',
    });
    expect(result.effect?.openItems.find((item) => item.ref === 'oss')).toMatchObject({
      mayReverse: true,
      dueDate: '2027-01-31',
    });
  });
});

describe('the D398 of the Union scheme', () => {
  const model: D398 = {
    period: { year: 2026, month: 9 },
    vatId: '18547290',
    name: 'Exemplu Digital SRL',
    supplies: [
      {
        state: 'DE',
        type: 'services',
        rateType: 'standard',
        rate: '19',
        taxableCents: 100000n,
        vatCents: 19000n,
      },
      {
        state: 'FR',
        type: 'services',
        rateType: 'standard',
        rate: '20',
        taxableCents: 50000n,
        vatCents: 10000n,
      },
      {
        state: 'IT',
        type: 'services',
        rateType: 'standard',
        rate: '22',
        taxableCents: 20000n,
        vatCents: 4400n,
      },
    ],
    corrections: [{ state: 'DE', year: 2026, month: 6, vatCents: -1900n }],
  };
  test('totals per state, the due balance with the corrections, the control sum', () => {
    const calculation = calculateD398(model);
    expect(calculation.perState.map((item) => [item.state, item.total, item.balance])).toEqual([
      ['FR', 10000n, 10000n],
      ['DE', 19000n, 17100n],
      ['IT', 4400n, 4400n],
    ]);
    expect(calculation.due).toBe(31500n);
    expect(calculation.control).toBe(1);
    expect(checkD398(model)).toEqual([]);
    const xml = writeD398(model);
    expect(xml).toContain('vat_id_no="RO18547290"');
    expect(xml).toContain('e_int="0"');
    expect(xml).not.toContain('vat_id_no_msest');
    expect(xml).toContain('vat_amount_correction="-19.00"');
    expect(calculateD398({ ...model, supplies: [], corrections: [] })).toMatchObject({
      nil: true,
      control: 2,
    });
  });

  test("ANAF's R29.1 window: the whole euros of base × rate to one euro above", () => {
    const at = (vatCents: bigint) =>
      checkD398({
        ...model,
        corrections: [],
        supplies: [{ ...model.supplies[0]!, vatCents }],
      }).map((check) => check.code);
    expect(at(19000n)).toEqual([]);
    expect(at(19100n)).toEqual([]);
    expect(at(18999n)).toEqual(['D398_VAT']);
    expect(at(19101n)).toEqual(['D398_VAT']);
    expect(
      checkD398({ ...model, supplies: [{ ...model.supplies[0]!, state: 'RO' }] }).map(
        (c) => c.code,
      ),
    ).toContain('D398_STATE');
  });

  test('due on the last calendar day of the next month, a non-working one included', () => {
    // 31 October 2026 is a Saturday: the return stays due that day (art. 315 alin. (6^1)).
    expect(
      obligationDue(
        'D398',
        { start: '2026-07-01' as LocalDate, end: '2026-09-30' as LocalDate },
        rules(),
      ).due as string,
    ).toBe('2026-10-31');
    // D300's own deadline still moves off a weekend.
    expect(
      obligationDue(
        'D394',
        { start: '2026-09-01' as LocalDate, end: '2026-09-30' as LocalDate },
        rules(),
      ).due as string,
    ).toBe('2026-10-30');
  });

  test('the closure lists the D398 of every registered quarter, nil ones too, and IOSS as UNSUPPORTED', () => {
    const facts = [
      ...payer,
      fact('vat.distance', 'origin', '2026-01-01'),
      fact('vat.distance', 'destination', '2026-07-03'),
      fact('vat.oss', 'union', '2026-07-01'),
    ];
    const current = context(facts, [sale('2026-02-10', '46000'), sale('2026-07-03', '400', 'oss')]);
    const determinations = determineYear(current, rules()).filter(
      (item) => !['income_tax', 'size.category'].includes(item.axis),
    );
    const months = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`);
    const closure = evaluateClosure({
      interval: { from: '2026-01', to: '2026-12' },
      facts,
      determinations,
      confirmed: {},
      books: emptyBooks,
      d406Start: d406StartOf(rules(), months),
    });
    expect(
      closure.obligations
        .filter((item) => item.kind === 'D398')
        .map((item) => [item.period, item.state]),
    ).toEqual([
      ['2026-Q3', 'applies'],
      ['2026-Q4', 'applies'],
    ]);
    const iossFacts = [...payer, fact('vat.ioss', 'registered', '2026-01-01')];
    const ioss = evaluateClosure({
      interval: { from: '2026-01', to: '2026-03' },
      facts: iossFacts,
      determinations: determineYear(context(iossFacts, []), rules()).filter(
        (item) => !['income_tax', 'size.category'].includes(item.axis),
      ),
      confirmed: {},
      books: emptyBooks,
      d406Start: d406StartOf(rules(), months),
    });
    expect(ioss.status).toBe('UNSUPPORTED');
    expect(ioss.unsupported.map((item) => item.trigger)).toContain('IOSS_SCHEME');
    expect(ioss.obligations.filter((item) => item.kind === 'D398.import')).toHaveLength(3);
  });
});

describe('SAF-T and the agent', () => {
  test('below the threshold 310346 (D300 rd. 17); the Union scheme 310340 (D398 only)', () => {
    expect(d406VatTaxCode({ direction: 'output', code: 'S-21', distance: true })).toBe('310346');
    expect(d406VatTaxCode({ direction: 'output', code: 'S-21' })).toBe('310344');
    expect(d406VatTaxCode({ direction: 'output', code: 'EXP-OSS' })).toBe('310340');
  });

  test('agent.ts names the documents, questions and detectors', () => {
    expect(agent.detectors.map((item) => item.kind)).toEqual([
      'threshold.approaching',
      'determination.missing',
      'obligation.due',
      'document.unproposed',
    ]);
    expect(agent.questions.map((item) => item.kind)).toEqual([
      'profile.fact',
      'determination.confirm',
      'year.figures',
    ]);
    expect(agent.templates).toEqual([]);
  });
});
