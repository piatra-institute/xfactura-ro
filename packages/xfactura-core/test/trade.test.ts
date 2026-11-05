import { describe, expect, test } from 'bun:test';
import type { Effect, Evaluation, ProfileFact } from '../src/kernel';
import { RuleContext } from '../src/rules';
import { roRegister } from '../src/ro/register';
import { d406VatTaxCode } from '../src/ro/saft/tax-codes';
import { obligationDue } from '../src/ro/obligations';
import {
  agent,
  customsProblems,
  determineIntrastat,
  etransportObligation,
  euAcquisitionInput,
  euAcquisitionRecognition,
  euSupplyInput,
  euSupplyRecognition,
  exportInput,
  exportRecognition,
  importInput,
  importRecognition,
  intrastatWatches,
  statementDeadline,
  transportPresumption,
  type CustomsDeclaration,
} from '../src/ro/trade';
import {
  goodsInvoice,
  presumedTransport,
  TRADE_IDS,
  tradeLoaded,
  withDeclaration,
  withVies,
} from '../src/ro/trade/world';
import type { DeterminationContext } from '../src/ro/determinations/determine';
import type { LocalDate } from '../src/time';

// Amounts by hand. An EU supply of 10.000,00 EUR; an acquisition of 2.000,00 EUR at 5,0800 lei
// (BNR, the issue date) and 5,0900 lei (the tax point): goods 10.160,00 lei, VAT base 10.180,00,
// VAT 21% = 2.137,80 lei; an import of 1.000,00 USD at 4,5000 lei = 4.500,00 lei, duty 120,00, VAT
// 21% of (4.550,00 customs value + 120,00) = 980,70 lei.

const rules = () => new RuleContext(roRegister(), 'preview');
const lines = (effect: Effect | null) =>
  effect?.lines.map((line) => `${line.side} ${line.account} ${line.bani}`);
const taxes = (effect: Effect | null) =>
  effect?.taxEntries.map(
    (entry) =>
      `${entry.direction} ${entry.code} ${entry.baseBani} ${entry.taxBani} ${entry.deductibleBani} ${entry.taxPoint} ${entry.taxPeriod}`,
  );
const codes = (evaluation: Evaluation) =>
  evaluation.issues.map((issue) => `${issue.severity} ${issue.code}`);

const partner = { name: 'Partner GmbH', taxId: 'DE123456788', country: 'DE' };

describe('the proof of an intra-community supply', () => {
  const rule = { presumption: 'safe_harbour' as const, documents: 2, buyerStatementDay: 10 };
  test('two independent, non-contradictory documents presume the transport (art. 45a)', () => {
    const verdict = transportPresumption(
      presumedTransport('DE', '2026-10-08'),
      'DE',
      '2026-10-08' as LocalDate,
      rule,
    );
    expect(verdict).toEqual({
      presumed: true,
      reasons: [],
      counted: [TRADE_IDS.cmr, TRADE_IDS.carrier],
    });
  });
  test('one document, a dependent issuer, a contradiction or a late statement do not', () => {
    const one = presumedTransport('DE', '2026-10-08');
    one.documents.pop();
    expect(transportPresumption(one, 'DE', '2026-10-08' as LocalDate, rule).presumed).toBe(false);
    const own = presumedTransport('DE', '2026-10-08');
    own.documents[1]!.independent = false;
    expect(transportPresumption(own, 'DE', '2026-10-08' as LocalDate, rule).reasons.length).toBe(2);
    const contradicting = presumedTransport('DE', '2026-10-08');
    contradicting.documents[1]!.destination = 'AT';
    expect(
      transportPresumption(contradicting, 'DE', '2026-10-08' as LocalDate, rule).reasons[0],
    ).toContain('se contrazic');
    // Two insurance documents: none of the transport itself (lit. (a)).
    const noTransport = presumedTransport('DE', '2026-10-08');
    noTransport.documents[0]!.kind = 'bank_payment' as never;
    expect(transportPresumption(noTransport, 'DE', '2026-10-08' as LocalDate, rule).presumed).toBe(
      false,
    );
    const buyer = { ...presumedTransport('DE', '2026-10-08'), by: 'buyer' as const };
    expect(transportPresumption(buyer, 'DE', '2026-10-08' as LocalDate, rule).reasons[0]).toContain(
      'declarația lui scrisă',
    );
    expect(statementDeadline('2026-10-08' as LocalDate, 10)).toBe('2026-11-10' as LocalDate);
    const late = {
      ...buyer,
      buyerStatement: { evidenceId: TRADE_IDS.cmr, receivedOn: '2026-11-11', destination: 'DE' },
    };
    expect(transportPresumption(late, 'DE', '2026-10-08' as LocalDate, rule).reasons[0]).toContain(
      'după 2026-11-10',
    );
  });
});

describe('goods.euSupply', () => {
  const supply = (issueDate: string, deliveryDate = '2026-10-08') =>
    goodsInvoice({
      direction: 'sale',
      number: 'IC-1',
      issueDate,
      deliveryDate,
      currency: 'RON',
      category: 'K',
      reason: 'VATEX-EU-IC',
      partner,
      lines: ['10000.00'],
    });
  const input = (extra: Record<string, unknown> = {}) =>
    euSupplyInput.parse({
      documentId: TRADE_IDS.invoice,
      account: '707',
      arrangement: 'standard',
      viesDocumentId: TRADE_IDS.vies,
      transport: presumedTransport('DE', '2026-10-08'),
      ...extra,
    });

  test('exempt at the invoice, with the buyer checked in VIES and the transport presumed', () => {
    const loaded = withVies(tradeLoaded(supply('2026-10-09'), 'sale'), 'DE123456788', '2026-10-08');
    const evaluation = euSupplyRecognition.evaluate(input(), loaded, rules());
    expect(codes(evaluation)).toEqual(['info TRANSPORT_PRESUMED', 'info D390_REQUIRED']);
    expect(lines(evaluation.effect)).toEqual(['D 4111 1000000', 'C 707 1000000']);
    expect(taxes(evaluation.effect)).toEqual(['output EX-IC 1000000 0 0 2026-10-09 2026-10']);
    expect(evaluation.effect!.taxEntries[0]!.attributes).toMatchObject({
      supplied: '2026-10-08',
      vies: '2026-10-08',
      proof: 'presumed',
      proofDue: '2027-01-06',
    });
  });

  test('an invoice after the 15th of the next month: chargeable on the 15th (art. 283)', () => {
    const loaded = withVies(tradeLoaded(supply('2026-11-20'), 'sale'), 'DE123456788', '2026-10-08');
    const evaluation = euSupplyRecognition.evaluate(input(), loaded, rules());
    expect(codes(evaluation)).toContain('ack INVOICE_LATE');
    expect(taxes(evaluation.effect)).toEqual(['output EX-IC 1000000 0 0 2026-11-15 2026-11']);
  });

  test('an invalid code, a late check, a triangle and missing transport', () => {
    const invalid = withVies(
      tradeLoaded(supply('2026-10-09'), 'sale'),
      'DE123456788',
      '2026-10-08',
      false,
    );
    expect(codes(euSupplyRecognition.evaluate(input(), invalid, rules()))).toContain(
      'block VIES_INVALID',
    );
    const late = withVies(tradeLoaded(supply('2026-10-09'), 'sale'), 'DE123456788', '2026-10-12');
    expect(codes(euSupplyRecognition.evaluate(input(), late, rules()))).toContain(
      'block VIES_LATE',
    );
    const after = withVies(tradeLoaded(supply('2026-10-20'), 'sale'), 'DE123456788', '2026-10-12');
    expect(codes(euSupplyRecognition.evaluate(input(), after, rules()))).toContain(
      'ack VIES_AFTER_SUPPLY',
    );
    const ok = withVies(tradeLoaded(supply('2026-10-09'), 'sale'), 'DE123456788', '2026-10-08');
    expect(
      codes(
        euSupplyRecognition.evaluate(
          input({ arrangement: 'triangular_intermediary' }),
          ok,
          rules(),
        ),
      ),
    ).toContain('block TRIANGULATION');
    expect(
      codes(euSupplyRecognition.evaluate(input({ arrangement: 'call_off_stock' }), ok, rules())),
    ).toContain('block CALL_OFF_STOCK');
    const pending = euSupplyRecognition.evaluate(input({ transport: undefined }), ok, rules());
    expect(codes(pending)).toContain('ack TRANSPORT_PENDING');
    expect(pending.effect!.taxEntries[0]!.attributes.proof).toBe('pending');
  });
});

describe('goods.euAcquisition', () => {
  const invoice = (issueDate: string) =>
    goodsInvoice({
      direction: 'purchase',
      number: 'DE-77',
      issueDate,
      deliveryDate: '2026-10-05',
      currency: 'EUR',
      category: 'K',
      reason: 'VATEX-EU-IC',
      partner,
      lines: ['1500.00', '500.00'],
    });
  const rates = [
    { currency: 'EUR', date: '2026-10-07', rate: '5.0800' },
    { currency: 'EUR', date: '2026-11-13', rate: '5.0900' },
  ];
  const input = euAcquisitionInput.parse({
    documentId: TRADE_IDS.invoice,
    account: '6028',
    arrangement: 'standard',
    rate: 'standard',
    deduction: 'full',
  });

  test('self-assessed at the invoice: 4426 = 4427, D300 rd. 5 and 20 (AIC-21)', () => {
    const loaded = tradeLoaded(invoice('2026-10-07'), 'purchase', { rates });
    const evaluation = euAcquisitionRecognition.evaluate(input, loaded, rules());
    expect(codes(evaluation)).toEqual([]);
    // 2.000,00 EUR at 5,0800 = 10.160,00 lei; VAT on the same base, the tax point the invoice.
    expect(lines(evaluation.effect)).toEqual([
      'D 6028 1016000',
      'C 401 1016000',
      'C 4427 213360',
      'D 4426 213360',
    ]);
    expect(taxes(evaluation.effect)).toEqual([
      'output AIC-21 1016000 213360 0 2026-10-07 2026-10',
      'input AIC-21 1016000 213360 213360 2026-10-07 2026-10',
    ]);
  });

  test('an invoice issued after the 15th of the next month: the 15th, at its BNR rate', () => {
    const loaded = tradeLoaded(invoice('2026-11-20'), 'purchase', {
      rates: [...rates, { currency: 'EUR', date: '2026-11-20', rate: '5.1000' }],
    });
    const evaluation = euAcquisitionRecognition.evaluate(input, loaded, rules());
    expect(codes(evaluation)).toEqual(['ack INVOICE_LATE']);
    // Goods at 5,1000 (the issue date): 10.200,00; VAT base at 5,0900 (15.11): 10.180,00 × 21%.
    expect(lines(evaluation.effect)).toEqual([
      'D 6028 1020000',
      'C 401 1020000',
      'C 4427 213780',
      'D 4426 213780',
    ]);
    expect(taxes(evaluation.effect)![0]).toBe('output AIC-21 1018000 213780 0 2026-11-15 2026-11');
  });

  test('refused: VAT charged by the supplier, a supplier without a code, a non-payer', () => {
    const charged = invoice('2026-10-07');
    charged.taxes[0]!.tax = '380.00';
    expect(
      codes(
        euAcquisitionRecognition.evaluate(
          input,
          tradeLoaded(charged, 'purchase', { rates }),
          rules(),
        ),
      ),
    ).toContain('block VAT_CHARGED');
    const nocode = goodsInvoice({
      direction: 'purchase',
      number: 'DE-78',
      issueDate: '2026-10-07',
      deliveryDate: '2026-10-05',
      currency: 'EUR',
      category: 'K',
      partner: { ...partner, taxId: 'HRB 1234' },
      lines: ['100.00'],
    });
    expect(
      codes(
        euAcquisitionRecognition.evaluate(
          input,
          tradeLoaded(nocode, 'purchase', { rates }),
          rules(),
        ),
      ),
    ).toContain('block SUPPLIER_VAT_ID');
    const nonPayer = tradeLoaded(invoice('2026-10-07'), 'purchase', {
      rates,
      facts: [{ axis: 'vat.status', value: 'non_vat', effectiveFrom: '2026-01-01' } as ProfileFact],
    });
    expect(codes(euAcquisitionRecognition.evaluate(input, nonPayer, rules()))).toContain(
      'block EU_GOODS_NON_PAYER',
    );
  });
});

describe('goods.import', () => {
  const invoice = goodsInvoice({
    direction: 'purchase',
    number: 'CN-9',
    issueDate: '2026-10-01',
    currency: 'USD',
    category: 'O',
    partner: { name: 'Shenzhen Ltd', taxId: 'CN91440300', country: 'CN' },
    lines: ['1000.00'],
  });
  const declaration = (vatPayment: CustomsDeclaration['vatPayment']) => ({
    procedure: 'import' as const,
    mrn: '26RO1234567890ABCD',
    acceptedOn: '2026-10-06',
    office: 'Biroul vamal Constanța Sud',
    declarant: { name: 'Exemplu Comerț SRL', taxId: '18547290', country: 'RO' as const },
    partner: { name: 'Shenzhen Ltd', country: 'CN', taxId: null },
    invoices: [{ number: 'CN-9', currency: 'USD', amount: '1000.00' }],
    exchangeRate: '4.5500',
    lines: [
      {
        description: 'Componente electronice',
        commodity: '85423190',
        customsValue: '4550.00',
        duty: '120.00',
        otherTaxes: '0.00',
        ancillary: '0.00',
        vatBase: '4670.00',
        vatRate: '21',
        vat: '980.70',
        origin: 'CN',
      },
    ],
    totals: {
      customsValue: '4550.00',
      duty: '120.00',
      otherTaxes: '0.00',
      vatBase: '4670.00',
      vat: '980.70',
    },
    vatPayment,
  });
  const world = (vatPayment: CustomsDeclaration['vatPayment']) =>
    withDeclaration(
      tradeLoaded(invoice, 'purchase', {
        rates: [{ currency: 'USD', date: '2026-10-01', rate: '4.5000' }],
      }),
      declaration(vatPayment),
    );
  const input = (extra: Record<string, unknown> = {}) =>
    importInput.parse({
      documentId: TRADE_IDS.invoice,
      declarationId: TRADE_IDS.declaration,
      account: '6028',
      deduction: 'full',
      authorityId: TRADE_IDS.customs,
      ...extra,
    });

  test('VAT paid at customs: the duty in the cost, 4426 against the customs debt (rd. 24)', () => {
    const evaluation = importRecognition.evaluate(input(), world({ mode: 'paid' }), rules());
    expect(codes(evaluation)).toEqual(['ack IMPORT_DUTY_COST']);
    expect(lines(evaluation.effect)).toEqual([
      'D 6028 462000',
      'C 401 450000',
      'C 446 110070',
      'D 4426 98070',
    ]);
    expect(taxes(evaluation.effect)).toEqual([
      'input IMP-21 467000 98070 98070 2026-10-06 2026-10',
    ]);
  });

  test('VAT deferred with the certificate: collected and deducted in the return (rd. 7, 22)', () => {
    const deferred = { mode: 'deferred' as const, certificate: 'CA-2026-17' };
    expect(codes(importRecognition.evaluate(input(), world(deferred), rules()))).toContain(
      'block DEFERRAL_CERTIFICATE',
    );
    const evaluation = importRecognition.evaluate(
      input({ certificateEvidenceId: TRADE_IDS.certificate }),
      world(deferred),
      rules(),
    );
    expect(lines(evaluation.effect)).toEqual([
      'D 6028 462000',
      'C 401 450000',
      'C 446 12000',
      'C 4427 98070',
      'D 4426 98070',
    ]);
    expect(taxes(evaluation.effect)).toEqual([
      'output IMP-DEF-21 467000 98070 0 2026-10-06 2026-10',
      'input IMP-DEF-21 467000 98070 98070 2026-10-06 2026-10',
    ]);
  });

  test("the declaration's arithmetic, and a declaration for another invoice", () => {
    expect(customsProblems(declaration({ mode: 'paid' }) as never)).toEqual([]);
    const wrong = declaration({ mode: 'paid' });
    wrong.lines[0]!.vat = '900.00';
    wrong.totals.vat = '900.00';
    expect(customsProblems(wrong as never)).toEqual(['Linia 1: TVA nu este 21% din bază.']);
    const other = withDeclaration(world({ mode: 'paid' }), {
      ...declaration({ mode: 'paid' }),
      invoices: [{ number: 'CN-10', currency: 'USD', amount: '1000.00' }],
    });
    expect(codes(importRecognition.evaluate(input(), other, rules()))).toContain(
      'block DECLARATION_INVOICE',
    );
  });
});

describe('goods.export', () => {
  const invoice = goodsInvoice({
    direction: 'sale',
    number: 'EX-1',
    issueDate: '2026-10-12',
    deliveryDate: '2026-10-12',
    currency: 'RON',
    category: 'G',
    reason: 'VATEX-EU-G',
    partner: { name: 'Buyer Inc', taxId: 'US-77', country: 'US' },
    lines: ['5000.00'],
  });
  const declaration = (exit?: { certifiedOn: string; office: string }) =>
    withDeclaration(tradeLoaded(invoice, 'sale'), {
      procedure: 'export',
      mrn: '26RO0000000000EXP1',
      acceptedOn: '2026-10-12',
      office: 'Biroul vamal Otopeni',
      declarant: { name: 'Exemplu Comerț SRL', taxId: '18547290', country: 'RO' },
      partner: { name: 'Buyer Inc', country: 'US', taxId: null },
      invoices: [{ number: 'EX-1', currency: 'RON', amount: '5000.00' }],
      exchangeRate: null,
      lines: [
        {
          description: 'Marfă',
          commodity: '09012100',
          customsValue: '5000.00',
          duty: '0.00',
          otherTaxes: '0.00',
          ancillary: '0.00',
        },
      ],
      totals: {
        customsValue: '5000.00',
        duty: '0.00',
        otherTaxes: '0.00',
        vatBase: '0.00',
        vat: '0.00',
      },
      ...(exit ? { exit } : {}),
    });
  const input = exportInput.parse({
    documentId: TRADE_IDS.invoice,
    account: '707',
    declarationId: TRADE_IDS.declaration,
  });

  test('exempt with the exit certified (rd. 14, EX-EXPORT)', () => {
    const evaluation = exportRecognition.evaluate(
      input,
      declaration({ certifiedOn: '2026-10-14', office: 'Biroul vamal Nădlac' }),
      rules(),
    );
    expect(codes(evaluation)).toEqual(['info EXPORT_EXIT_CERTIFIED']);
    expect(taxes(evaluation.effect)).toEqual(['output EX-EXPORT 500000 0 0 2026-10-12 2026-10']);
    expect(evaluation.effect!.taxEntries[0]!.attributes).toMatchObject({
      proof: 'certified',
      mrn: '26RO0000000000EXP1',
    });
  });

  test('the exit not yet certified: pending, within 90 days', () => {
    const evaluation = exportRecognition.evaluate(input, declaration(), rules());
    expect(codes(evaluation)).toEqual(['ack EXPORT_EXIT_PENDING']);
    expect(evaluation.effect!.taxEntries[0]!.attributes.proofDue).toBe('2027-01-10');
  });
});

describe('Intrastat', () => {
  const context = (
    months: { month: string; arrivals: bigint; dispatches: bigint }[],
    previous = 0n,
  ) =>
    ({
      year: 2026,
      facts: [
        { axis: 'vat.status', value: 'normal_vat', effectiveFrom: '2020-01-01' } as ProfileFact,
      ],
      previous: {
        year: 2025,
        kept: true,
        intrastatArrivals: { known: true, value: previous, source: 'books', ref: null },
        intrastatDispatches: { known: true, value: 0n, source: 'books', ref: null },
      },
      current: {},
      activity: {
        year: 2026,
        kept: true,
        quarterTurnover: [0n, 0n, 0n, 0n],
        days: [],
        intrastat: months,
      },
      contracts: [],
      micro: { known: false, reason: '', question: null },
      today: '2026-11-05',
    }) as unknown as DeterminationContext;

  test('a provider from the month the cumulated arrivals cross 1.000.000 lei', () => {
    const months = [
      { month: '2026-03', arrivals: 60_000_000n, dispatches: 0n },
      { month: '2026-06', arrivals: 50_000_000n, dispatches: 0n },
    ];
    const determination = determineIntrastat(context(months), rules(), 'arrivals');
    expect(determination.status).toBe('proposed');
    expect(determination.value).toBe('none');
    expect(determination.changes).toEqual([
      expect.objectContaining({ value: 'provider', effectiveFrom: '2026-06-01' }),
    ]);
    expect(determineIntrastat(context(months), rules(), 'dispatches').status).toBe(
      'not_applicable',
    );
  });

  test('a provider for the whole year after a year over the threshold; the watch at 80%', () => {
    const months = [{ month: '2026-03', arrivals: 10_000_000n, dispatches: 0n }];
    const determination = determineIntrastat(context(months, 120_000_000n), rules(), 'arrivals');
    expect([determination.value, determination.effectiveFrom]).toEqual(['provider', '2026-01-01']);
    const near = [{ month: '2026-09', arrivals: 85_000_000n, dispatches: 0n }];
    expect(intrastatWatches(context(near), rules())).toEqual([
      expect.objectContaining({ key: 'ro.intrastat.thresholds', value: 85_000_000n }),
    ]);
    expect(
      intrastatWatches(
        context([{ month: '2026-09', arrivals: 1_000_000n, dispatches: 0n }]),
        rules(),
      ),
    ).toEqual([]);
  });

  test('the declaration is due on the 15th, even on a non-working day', () => {
    const due = obligationDue(
      'Intrastat',
      { start: '2026-10-01' as LocalDate, end: '2026-10-31' as LocalDate },
      rules(),
    );
    // 15 November 2026 is a Sunday.
    expect(due.due).toBe('2026-11-15' as LocalDate);
  });
});

describe('RO e-Transport and the SAF-T codes', () => {
  test('declared at most 3 days before the start, the UIT valid 5 days', () => {
    expect(
      etransportObligation('acquisition', '2026-10-05' as LocalDate, {
        declareDaysBefore: 3,
        validityDays: 5,
      }),
    ).toMatchObject({
      declareFrom: '2026-10-02',
      declareBy: '2026-10-05',
      validUntil: '2026-10-09',
    });
  });
  test('acquisitions and deferred imports are reported with their deduction; paid imports too', () => {
    expect(d406VatTaxCode({ direction: 'output', code: 'AIC-21' })).toBeNull();
    expect(d406VatTaxCode({ direction: 'input', code: 'AIC-21', deduction: 'full' })).toBe(
      '300204',
    );
    expect(d406VatTaxCode({ direction: 'input', code: 'AIC-11', deduction: 'none' })).toBe(
      '350205',
    );
    expect(d406VatTaxCode({ direction: 'output', code: 'IMP-DEF-21' })).toBeNull();
    expect(d406VatTaxCode({ direction: 'input', code: 'IMP-DEF-21', deduction: 'full' })).toBe(
      '300604',
    );
    expect(d406VatTaxCode({ direction: 'input', code: 'IMP-21', deduction: 'full' })).toBe(
      '301204',
    );
    expect(d406VatTaxCode({ direction: 'input', code: 'IMP-21', deduction: 'none' })).toBe(
      '351204',
    );
  });
  test('agent.ts names the documents, questions and detectors', () => {
    expect(agent.questions.map((item) => item.kind)).toEqual([
      'goods.proof',
      'etransport.uit',
      'determination.confirm',
      'year.figures',
      'obligation.filed',
    ]);
    expect(agent.detectors.map((item) => item.kind)).toEqual([
      'document.unproposed',
      'goods.proof',
      'etransport.uit',
      'threshold.approaching',
      'obligation.due',
    ]);
    expect(agent.templates).toEqual([]);
  });
});
