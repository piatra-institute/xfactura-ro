import { describe, expect, test } from 'bun:test';
import type { Evaluation, Loaded, OpenItemState, PartyRecord } from '../src/kernel';
import { turnoverKey } from '../src/kernel';
import { roRegister } from '../src/ro/register';
import * as receiptsAgent from '../src/ro/receipts/agent';
import { reverseChargeApplies } from '../src/ro/receipts/reverse-charge';
import {
  fuelReceipt,
  receiptEvaluation,
  receiptIds,
  receiptLoaded,
  reverseChargeEvaluation,
  reverseChargeInvoice,
} from '../src/ro/reviews/specs/receipts';
import { vehicleAnswerRecord } from '../src/ro/reviews/specs/world';
import { questionKinds } from '../src/questions/kinds';
import type { LocalDate } from '../src/time';

// Codul fiscal art. 319 alin. (12) lit. a), art. 290 alin. (2) and the norms' pct. 69 alin. (6):
// a receipt showing the company's VAT code, at most 100 euro (5,0815 lei on 16.10.2026: 508,15
// lei), is a simplified invoice. Amounts by hand: 300,00 lei of fuel at 21% hold 52,07 lei of
// VAT (300 × 21 / 121 = 52,066), net 247,93; half the VAT, rounded half up, is 26,04 (26,035).

const register = roRegister();
const codes = (evaluation: Evaluation) => evaluation.issues.map((issue) => issue.code);
const lines = (evaluation: Evaluation) =>
  evaluation.effect?.lines.map((line) => `${line.side} ${line.account} ${line.bani}`);
const run = (loaded: Loaded, input: Record<string, unknown>) =>
  receiptEvaluation(register, loaded, input).evaluation;
const fuel = fuelReceipt({ gross: '300.00', tax: '52.07', buyerTaxId: 'RO18547290' });
const EMPLOYEE = '00000000-0000-4000-8000-0000000000f1';
const ADVANCE = '00000000-0000-4000-8000-0000000000f2';
const REPORT = '00000000-0000-4000-8000-0000000000f3';

describe('receipts.recognize', () => {
  test('a fuel receipt with the company code, within the limit, deducts half through the vehicle', () => {
    const plate = 'B-123-XFA';
    const mixed = vehicleAnswerRecord(plate, { use: 'mixed', from: '2026-01-01' });
    // Without an answer about the car, the owner is asked.
    const asked = run(receiptLoaded(fuel), {
      account: '6022',
      vehicle: plate,
      deduction: 'limited',
    });
    expect(codes(asked)).toContain('VEHICLE_USE');
    const question = asked.issues.find((issue) => issue.code === 'VEHICLE_USE')!.details as {
      question: { kind: string; subject: { id: string } };
    };
    expect([question.question.kind, question.question.subject.id]).toEqual([
      'vehicle.use',
      'B123XFA',
    ]);
    // With the answer, half the VAT; deducting all of it is refused.
    const loaded = receiptLoaded(fuel, { answers: [mixed] });
    expect(codes(run(loaded, { account: '6022', vehicle: plate, deduction: 'full' }))).toContain(
      'VEHICLE_DEDUCTION',
    );
    const booked = run(loaded, { account: '6022', vehicle: plate, deduction: 'limited' });
    expect(codes(booked)).toEqual([]);
    expect(lines(booked)).toEqual(['D 6022 27396', 'D 4426 2604', 'C 401 30000']);
    expect(
      booked.effect!.taxEntries.map((entry) => [
        entry.code,
        entry.baseBani,
        entry.taxBani,
        entry.deductibleBani,
        entry.attributes.simplified,
      ]),
    ).toEqual([['S-21', 24793n, 5207n, 2604n, 'receipt']]);
    expect(booked.effect!.openItems.map((item) => [item.controlAccount, item.kind])).toEqual([
      ['401', 'payable'],
    ]);
    const details = booked.effect!.explanation.details as Record<string, unknown>;
    expect(details.limit).toEqual({
      eur: '100',
      lei: '508.15',
      rate: '5.0815',
      rateDate: '2026-10-16',
    });
    expect(details.profitTax).toEqual({
      vatInExpense: '26.03',
      clause: 'ANAF/Cod-fiscal-consolidat:norme.art.25.pct.16',
    });
  });

  test('a receipt without the company code books the VAT into the expense', () => {
    const body = fuelReceipt({ gross: '300.00', tax: '52.07', buyerTaxId: null });
    const refused = run(receiptLoaded(body), { account: '6022' });
    expect(codes(refused)).toEqual(['DEDUCTION', 'RECEIPT_NOT_SIMPLIFIED_INVOICE']);
    expect(refused.issues[0]!.details).toMatchObject({ reason: 'no_buyer_code' });
    const booked = run(receiptLoaded(body), { account: '6022', deduction: 'none' });
    expect(lines(booked)).toEqual(['D 6022 30000', 'C 401 30000']);
    expect(booked.effect!.taxEntries).toEqual([]);
    // No euro rate is needed for it.
    expect(
      codes(run(receiptLoaded(body, { fx: [] }), { account: '6022', deduction: 'none' })),
    ).toEqual(['RECEIPT_NOT_SIMPLIFIED_INVOICE']);
  });

  test('a receipt over the limit deducts nothing and expects the invoice', () => {
    const body = fuelReceipt({ gross: '520.00', tax: '90.25', buyerTaxId: 'RO18547290' });
    expect(codes(run(receiptLoaded(body), { account: '6022' }))).toEqual([
      'DEDUCTION',
      'RECEIPT_INVOICE_EXPECTED',
    ]);
    const booked = run(receiptLoaded(body), { account: '6022', deduction: 'none' });
    expect(codes(booked)).toEqual(['RECEIPT_INVOICE_EXPECTED']);
    expect(lines(booked)).toEqual(['D 6022 52000', 'C 401 52000']);
    // At the limit exactly (100 euro = 508,15 lei) it is a simplified invoice.
    const edge = fuelReceipt({ gross: '508.15', tax: '88.19', buyerTaxId: 'RO18547290' });
    expect(
      run(receiptLoaded(edge), { account: '6022' }).effect!.taxEntries[0]!.deductibleBani,
    ).toBe(8819n);
    // Without the rate the limit is not guessed.
    expect(codes(run(receiptLoaded(body, { fx: [] }), { account: '6022' }))).toContain('FX_RATE');
  });

  test('a CUI printed without RO deducts behind a confirmation; a non-payer deducts nothing', () => {
    const body = fuelReceipt({ gross: '100.00', tax: '17.36', buyerTaxId: '18547290' });
    const booked = run(receiptLoaded(body), { account: '6028' });
    expect(codes(booked)).toEqual(['RECEIPT_BUYER_CODE']);
    expect(booked.effect!.taxEntries[0]!.deductibleBani).toBe(1736n);
    const payer = run(receiptLoaded(fuel, { status: 'non_vat' }), { account: '6022' });
    expect(codes(payer)).toEqual(['DEDUCTION']);
    expect(payer.issues[0]!.details).toMatchObject({ reason: 'non_payer' });
    expect(
      lines(
        run(receiptLoaded(fuel, { status: 'non_vat' }), { account: '6022', deduction: 'none' }),
      ),
    ).toEqual(['D 6022 30000', 'C 401 30000']);
  });

  test('several rates on one receipt: one tax entry per rate, split over accounts', () => {
    // 121,00 at 21% (21,00 VAT) and 55,50 at 11% (5,50 VAT).
    const body = fuelReceipt({
      gross: '176.50',
      tax: '26.50',
      buyerTaxId: 'RO18547290',
      lines: [
        { description: 'Ulei motor', gross: '121.00', vatRate: '21' },
        { description: 'Cafea', gross: '55.50', vatRate: '11' },
      ],
      taxes: [
        { rate: '21', gross: '121.00', tax: '21.00' },
        { rate: '11', gross: '55.50', tax: '5.50' },
      ],
    });
    const booked = run(receiptLoaded(body), {
      allocations: [
        { account: '6022', rate: '21', amount: '121.00' },
        { account: '6232', rate: '11', amount: '55.50' },
      ],
    });
    expect(codes(booked)).toEqual(['REDUCED_RATE', 'VEHICLE_UNNAMED']);
    expect(lines(booked)).toEqual([
      'D 6022 10000',
      'D 6232 5000',
      'D 4426 2100',
      'D 4426 550',
      'C 401 17650',
    ]);
    expect(booked.effect!.taxEntries.map((entry) => [entry.key, entry.code, entry.line])).toEqual([
      ['vat:S-21', 'S-21', 2],
      ['vat:S-11', 'S-11', 3],
    ]);
    // An allocation that does not cover its rate is refused.
    expect(
      codes(
        run(receiptLoaded(body), {
          allocations: [{ account: '6022', rate: '21', amount: '121.00' }],
        }),
      ),
    ).toContain('ALLOCATION');
  });

  test('paid in cash: one entry, the cash desk credited with the receipt number', () => {
    const query = turnoverKey({
      prefixes: ['5311'],
      from: '1900-01-01' as LocalDate,
      to: '2026-10-18' as LocalDate,
    });
    const funded = (bani: bigint) =>
      receiptLoaded(fuel, {
        with: (loaded) =>
          (loaded.turnover as Map<string, unknown>).set(query, [
            { account: '5311', debit: bani, credit: 0n },
          ]),
      });
    const payment = { method: 'cash', account: '5311' };
    const booked = run(funded(100_000n), { account: '6022', payment });
    expect(lines(booked)).toEqual(['D 6022 24793', 'D 4426 5207', 'C 5311 30000']);
    expect(booked.effect!.lines.at(-1)!.memo).toBe('BF 0042');
    expect(booked.effect!.openItems).toEqual([]);
    expect(codes(run(funded(10_000n), { account: '6022', payment }))).toContain('CASH_NEGATIVE');
  });

  test("an employee's receipt settles their advance, or is owed to them on 542", () => {
    const employee: PartyRecord = {
      id: EMPLOYEE,
      kind: 'ro_individual',
      country: 'RO',
      taxId: null,
      name: 'Ionescu Maria',
    };
    const advance = (balance: bigint): OpenItemState => ({
      id: ADVANCE,
      kind: 'receivable',
      controlAccount: '542',
      partyId: EMPLOYEE,
      currency: 'RON',
      normalSide: 'D',
      mayReverse: false,
      balanceBani: balance,
      balanceMinor: balance,
      documentId: null,
      dueDate: null,
      originEntryId: '00000000-0000-4000-8000-0000000000f4',
      movements: 1,
    });
    const loaded = (balance: bigint) =>
      receiptLoaded(fuel, {
        parties: [employee],
        with: (state) => {
          (state.openItems as Map<string, OpenItemState>).set(ADVANCE, advance(balance));
          (state.evidence as Map<string, unknown>).set(REPORT, {
            id: REPORT,
            hash: 'example',
            filename: 'decont.pdf',
            mediaType: 'application/pdf',
          });
        },
      });
    const fromAdvance = { method: 'advance', advanceId: ADVANCE };
    expect(codes(run(loaded(50_000n), { account: '6022', payment: fromAdvance }))).toContain(
      'EXPENSE_REPORT',
    );
    const settled = run(loaded(50_000n), {
      account: '6022',
      payment: fromAdvance,
      reportEvidenceId: REPORT,
    });
    expect(lines(settled)).toEqual(['D 6022 24793', 'D 4426 5207', 'C 542 30000']);
    expect(settled.effect!.lines.at(-1)!.openItem).toBe(ADVANCE);
    expect(
      codes(
        run(loaded(20_000n), { account: '6022', payment: fromAdvance, reportEvidenceId: REPORT }),
      ),
    ).toContain('EXCESS');
    const own = run(loaded(0n), {
      account: '6022',
      payment: { method: 'employee', partyId: EMPLOYEE },
      reportEvidenceId: REPORT,
    });
    expect(lines(own)).toEqual(['D 6022 24793', 'D 4426 5207', 'C 542 30000']);
    expect(
      own.effect!.openItems.map((item) => [item.controlAccount, item.partyId, item.mayReverse]),
    ).toEqual([['542', EMPLOYEE, true]]);
    // The seller is not an employee.
    expect(
      codes(
        run(loaded(0n), {
          account: '6022',
          payment: { method: 'employee', partyId: receiptIds.seller },
          reportEvidenceId: REPORT,
        }),
      ),
    ).toContain('EMPLOYEE');
  });

  test('a receipt without its cash register is confirmed, and only expense accounts are taken', () => {
    const body = fuelReceipt({
      gross: '300.00',
      tax: '52.07',
      buyerTaxId: 'RO18547290',
      register: null,
    });
    expect(codes(run(receiptLoaded(body), { account: '6028' }))).toEqual(['RECEIPT_IDENTITY']);
    expect(codes(run(receiptLoaded(fuel), { account: '401' }))).toContain('ACCOUNT');
  });
});

describe('invoices.reverseCharge', () => {
  const waste = (purchase: boolean) =>
    reverseChargeInvoice({
      issueDate: '2026-10-10',
      purchase,
      lines: [{ description: 'Deșeuri feroase', net: '10000.00' }],
    });

  test('a purchase self-assesses the VAT as collected and deducted (4426 = 4427)', () => {
    const { evaluation } = reverseChargeEvaluation(register, waste(true), {
      parts: [{ category: 'waste', account: '6028', amount: '10000.00' }],
    });
    expect(codes(evaluation)).toEqual(['REVERSE_CHARGE_PARTNER']);
    expect(lines(evaluation)).toEqual([
      'D 6028 1000000',
      'C 401 1000000',
      'C 4427 210000',
      'D 4426 210000',
    ]);
    expect(
      evaluation.effect!.taxEntries.map((entry) => [
        entry.direction,
        entry.code,
        entry.baseBani,
        entry.taxBani,
        entry.deductibleBani,
        entry.attributes.product,
      ]),
    ).toEqual([
      ['output', 'TI-A-21', 1000000n, 210000n, 0n, '22'],
      ['input', 'TI-A-21', 1000000n, 210000n, 210000n, '22'],
    ]);
    // Not deducted, the VAT goes into the expense.
    const none = reverseChargeEvaluation(register, waste(true), {
      parts: [{ category: 'waste', account: '6028', amount: '10000.00', deduction: 'none' }],
    }).evaluation;
    expect(lines(none)).toEqual([
      'D 6028 1000000',
      'C 401 1000000',
      'C 4427 210000',
      'D 6028 210000',
    ]);
  });

  test('a sale books no VAT and records the base for rd. 13 and D394 (V)', () => {
    const { evaluation } = reverseChargeEvaluation(register, waste(false), {
      parts: [{ category: 'waste', account: '7588', amount: '10000.00' }],
    });
    expect(codes(evaluation)).toContain('ACCOUNT');
    const booked = reverseChargeEvaluation(register, waste(false), {
      parts: [{ category: 'waste', account: '708', amount: '10000.00' }],
    }).evaluation;
    expect(lines(booked)).toEqual(['D 4111 1000000', 'C 708 1000000']);
    expect(
      booked.effect!.taxEntries.map((entry) => [
        entry.direction,
        entry.code,
        entry.baseBani,
        entry.taxBani,
      ]),
    ).toEqual([['output', 'TI-L', 1000000n, 0n]]);
  });

  test('refused: a non-payer, phones under the threshold, cereals without their NC code, stock', () => {
    const parts = [{ category: 'waste', account: '6028', amount: '10000.00' }];
    expect(
      codes(reverseChargeEvaluation(register, waste(true), { parts }, 'non_vat').evaluation),
    ).toContain('REVERSE_CHARGE_PARTIES');
    const phones = reverseChargeInvoice({
      issueDate: '2026-10-10',
      purchase: true,
      lines: [{ description: 'Telefoane mobile', net: '20000.00' }],
    });
    expect(
      codes(
        reverseChargeEvaluation(register, phones, {
          parts: [{ category: 'mobile_phones', account: '6028', amount: '20000.00' }],
        }).evaluation,
      ),
    ).toContain('REVERSE_CHARGE_THRESHOLD');
    const wheat = reverseChargeInvoice({
      issueDate: '2026-10-10',
      purchase: true,
      lines: [{ description: 'Grâu', net: '10000.00' }],
    });
    expect(
      codes(
        reverseChargeEvaluation(register, wheat, {
          parts: [{ category: 'cereals', account: '6028', amount: '10000.00' }],
        }).evaluation,
      ),
    ).toContain('NC_CODE');
    expect(
      codes(
        reverseChargeEvaluation(register, wheat, {
          parts: [{ category: 'cereals', nc: '1001', account: '371', amount: '10000.00' }],
        }).evaluation,
      ),
    ).toContain('ACCOUNT');
    // 2027 is not read yet: lit. c)–f) and i)–l) end with 2026 (art. 331 alin. (6)).
    const later = reverseChargeInvoice({
      issueDate: '2027-01-05',
      purchase: true,
      lines: [{ description: 'Deșeuri', net: '10000.00' }],
    });
    expect(codes(reverseChargeEvaluation(register, later, { parts }).evaluation)).toContain(
      'RULE_GAP',
    );
  });

  test('the threshold counts the phones, circuits and laptops of one invoice together', () => {
    const rule = {
      categories: ['mobile_phones', 'integrated_circuits', 'consoles_tablets_laptops'] as const,
      threshold: {
        categories: ['mobile_phones', 'integrated_circuits', 'consoles_tablets_laptops'] as const,
        lei: '22500',
      },
    };
    const parts = [
      { category: 'mobile_phones' as const, bani: 790_000n },
      { category: 'consoles_tablets_laptops' as const, bani: 900_000n },
      { category: 'integrated_circuits' as const, bani: 580_000n },
    ];
    const value = {
      categories: [...rule.categories],
      threshold: { ...rule.threshold, categories: [...rule.threshold.categories] },
    };
    expect(reverseChargeApplies(parts, value)).toEqual({ applies: true });
    expect(reverseChargeApplies(parts.slice(0, 1), value)).toMatchObject({
      applies: false,
      reason: 'threshold',
    });
  });
});

describe('agent-ready', () => {
  test('the module names real question kinds and its templates fields', () => {
    for (const question of receiptsAgent.questions)
      expect(Object.keys(questionKinds)).toContain(question.kind);
    expect(receiptsAgent.detectors.map((item) => item.kind)).toEqual([
      'document.unproposed',
      'question.needed',
      'obligation.due',
    ]);
    expect(receiptsAgent.detectors[0]!.rules).toEqual([
      'ro.vat.simplified_invoice.limit_eur',
      'ro.vat.reverse_charge.domestic',
    ]);
    for (const rule of receiptsAgent.detectors.flatMap((item) => item.rules))
      expect(register.keys()).toContain(rule);
    expect(receiptsAgent.templates).toEqual(['account', 'deduction', 'vehicle', 'payment']);
  });
});
