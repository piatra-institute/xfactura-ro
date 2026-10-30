import { describe, expect, test } from 'bun:test';
import type { Evaluation } from '../src/kernel';
import { RuleContext } from '../src/rules';
import type { LocalDate } from '../src/time';
import {
  normalizePlate,
  normalizeSubject,
  questionIssue,
  questionKinds,
  questionOf,
} from '../src/questions/kinds';
import { roRegister } from '../src/ro/register';
import {
  emptyLoaded,
  purchaseEvaluation,
  purchaseInvoice,
  saleInvoice,
  vehicleAnswerRecord,
} from '../src/ro/reviews/specs/world';
import { invoiceKinds, invoiceRecognition, recognitionInput } from '../src/ro/treatments/invoices';
import { suggestsVehicle } from '../src/ro/vehicles';

// Codul fiscal art. 298 and the norms' pct. 68: a car's lease, fuel and repairs deduct VAT in
// full only when it is used only for the business (with its log) or the article excepts it;
// otherwise 50%. Amounts by hand: 1.500,00 lei at 21% is 315,00 lei of VAT, half 157,50.

const register = roRegister();
const DOCUMENT = '00000000-0000-4000-8000-0000000000d1';
const LOG = '00000000-0000-4000-8000-0000000000e3';
const CERTIFICATE = '00000000-0000-4000-8000-0000000000e4';
const lease = purchaseInvoice({
  issueDate: '2026-10-05',
  net: '1500.00',
  rate: '21',
  description: 'Rată leasing operațional autoturism B-123-XFA, octombrie 2026',
});
const mixed = vehicleAnswerRecord('B-123-XFA', { use: 'mixed', from: '2026-01-01' });
const exclusive = vehicleAnswerRecord('b 123 xfa', {
  use: 'business_only',
  from: '2026-01-01',
  logEvidenceId: LOG,
});

const run = (
  input: Record<string, unknown>,
  answers: Parameters<typeof purchaseEvaluation>[3] = [],
  body = lease,
) => purchaseEvaluation(register, body, input, answers).evaluation;
const codes = (evaluation: Evaluation) => evaluation.issues.map((issue) => issue.code);
const deducted = (evaluation: Evaluation) =>
  evaluation.effect?.taxEntries.map((entry) => [entry.taxBani, entry.deductibleBani]);

describe('registrations', () => {
  test('are read in one spelling, on every path', () => {
    expect(normalizePlate('b-123 xfa')).toBe('B123XFA');
    expect(normalizePlate(' CJ - 12 - ABC ')).toBe('CJ12ABC');
    expect(normalizeSubject('vehicle.use', { kind: 'vehicle', id: 'B-123-XFA' })).toEqual({
      kind: 'vehicle',
      id: 'B123XFA',
    });
    // Other kinds keep their subjects as given.
    expect(normalizeSubject('choice', { kind: 'party', id: 'Furnizor-1' }).id).toBe('Furnizor-1');
    const issue = questionIssue('VEHICLE_USE', 'De întrebat.', {
      kind: 'vehicle.use',
      subject: { kind: 'vehicle', id: 'B-123-XFA' },
      params: {},
    });
    expect(questionOf(issue)!.subject.id).toBe('B123XFA');
    // An issue stored before the normalization is read in the same spelling.
    expect(
      questionOf({
        details: {
          question: { kind: 'vehicle.use', subject: { kind: 'vehicle', id: 'b 123-xfa' } },
        },
      })!.subject.id,
    ).toBe('B123XFA');
  });

  test('the input refuses one that is not a registration, and a vehicle beside allocations', () => {
    const base = { documentId: '00000000-0000-4000-8000-0000000000d1', account: '612' };
    expect(recognitionInput.safeParse({ ...base, vehicle: 'B-123-XFA' }).success).toBe(true);
    expect(recognitionInput.safeParse({ ...base, vehicle: '--' }).success).toBe(false);
    expect(recognitionInput.safeParse({ ...base, vehicle: 'B/123/XFA' }).success).toBe(false);
    expect(
      recognitionInput.safeParse({
        documentId: base.documentId,
        vehicle: 'B-123-XFA',
        allocations: [{ account: '612', vat: 'S-21', amount: '1500.00' }],
      }).success,
    ).toBe(false);
  });
});

describe('the vehicle.use answer', () => {
  const kind = questionKinds['vehicle.use'];
  test('an exception needs its proof, and both files are cited', () => {
    const answer = kind.answer({});
    expect(
      answer.safeParse({ use: 'mixed', from: '2026-01-01', exception: 'rental_or_leasing' })
        .success,
    ).toBe(false);
    expect(
      answer.safeParse({ use: 'mixed', from: '2026-01-01', exceptionEvidenceId: CERTIFICATE })
        .success,
    ).toBe(false);
    const excepted = answer.parse({
      use: 'business_only',
      from: '2026-01-01',
      logEvidenceId: LOG,
      exception: 'over_3500kg_or_9_seats',
      exceptionEvidenceId: CERTIFICATE,
    });
    expect(kind.evidence(excepted)).toEqual([LOG, CERTIFICATE]);
    expect(kind.normalize!('b-123-xfa')).toBe('B123XFA');
  });
});

describe('invoices.recognize on a vehicle (art. 298)', () => {
  test('a part naming a vehicle asks how it is used, until the basis cites an answer', () => {
    const evaluation = run({ account: '612', deduction: 'limited', vehicle: 'B-123-XFA' });
    expect(evaluation.effect).toBeNull();
    expect(codes(evaluation)).toEqual(['VEHICLE_USE']);
    const issue = evaluation.issues[0]!;
    expect(issue.severity).toBe('block');
    expect(issue.path).toBe('vehicle');
    expect(questionOf(issue)).toEqual({
      kind: 'vehicle.use',
      subject: { kind: 'vehicle', id: 'B123XFA' },
      params: { documentId: '00000000-0000-4000-8000-0000000000d1', date: '2026-10-05' },
    });
  });

  test('mixed use deducts half, rounded to the ban; full deduction contradicts the answer', () => {
    const limited = run({ account: '612', deduction: 'limited', vehicle: 'B-123-XFA' }, [mixed]);
    expect(codes(limited)).toEqual([]);
    expect(deducted(limited)).toEqual([[31500n, 15750n]]);
    // The half not deducted stays in the expense: 1.500,00 + 157,50.
    expect(limited.effect!.lines.find((line) => line.account === '612')!.bani).toBe(165750n);
    const details = limited.effect!.explanation.details as { vehicles: unknown[] };
    expect(details.vehicles).toEqual([
      {
        vehicle: 'B123XFA',
        use: 'mixed',
        from: '2026-01-01',
        exception: null,
        deduction: 'limited',
        questionId: mixed.questionId,
        answerId: mixed.answerId,
        evidence: [mixed.evidenceId],
      },
    ]);

    const full = run({ account: '612', deduction: 'full', vehicle: 'B123XFA' }, [mixed]);
    expect(full.effect).toBeNull();
    expect(codes(full)).toEqual(['VEHICLE_DEDUCTION']);
    expect(full.issues[0]!.details).toMatchObject({ vehicle: 'B123XFA', allowed: 'limited' });
  });

  test('exclusive use, with the log, deducts in full; limited contradicts it', () => {
    const full = run({ account: '612', deduction: 'full', vehicle: 'B-123-XFA' }, [exclusive]);
    expect(codes(full)).toEqual([]);
    expect(deducted(full)).toEqual([[31500n, 31500n]]);
    const limited = run({ account: '612', deduction: 'limited', vehicle: 'B-123-XFA' }, [
      exclusive,
    ]);
    expect(codes(limited)).toEqual(['VEHICLE_DEDUCTION']);
  });

  test('a vehicle the article does not limit deducts in full whatever its use', () => {
    const truck = vehicleAnswerRecord('B-789-XFA', {
      use: 'mixed',
      from: '2026-01-01',
      exception: 'over_3500kg_or_9_seats',
      exceptionEvidenceId: CERTIFICATE,
    });
    const body = purchaseInvoice({
      issueDate: '2026-10-05',
      net: '800.00',
      rate: '21',
      description: 'Motorină autoutilitară B-789-XFA',
    });
    const evaluation = run(
      { account: '6022', deduction: 'full', vehicle: 'B-789-XFA' },
      [truck],
      body,
    );
    expect(codes(evaluation)).toEqual([]);
    expect(deducted(evaluation)).toEqual([[16800n, 16800n]]);
  });

  test('an answer about a later date asks again, and another vehicle answers nothing', () => {
    const later = vehicleAnswerRecord('B-123-XFA', { use: 'mixed', from: '2026-11-01' });
    const evaluation = run({ account: '612', deduction: 'limited', vehicle: 'B-123-XFA' }, [later]);
    expect(codes(evaluation)).toEqual(['VEHICLE_USE']);
    expect(evaluation.issues[0]!.message).toContain('de la 2026-11-01');
    const other = vehicleAnswerRecord('B-999-XFA', { use: 'mixed', from: '2026-01-01' });
    expect(
      codes(run({ account: '612', deduction: 'limited', vehicle: 'B-123-XFA' }, [other])),
    ).toEqual(['VEHICLE_USE']);
  });

  test('parts of one invoice follow their own vehicles', () => {
    const second = vehicleAnswerRecord('B-456-XFA', {
      use: 'business_only',
      from: '2026-01-01',
      logEvidenceId: LOG,
    });
    const evaluation = run(
      {
        allocations: [
          {
            account: '612',
            vat: 'S-21',
            amount: '1000.00',
            deduction: 'limited',
            vehicle: 'B-123-XFA',
          },
          {
            account: '612',
            vat: 'S-21',
            amount: '500.00',
            deduction: 'full',
            vehicle: 'B 456 XFA',
          },
        ],
      },
      [mixed, second],
    );
    expect(codes(evaluation)).toEqual([]);
    // 315,00 split 210,00 and 105,00: half of the first, all of the second.
    expect(deducted(evaluation)).toEqual([[31500n, 21000n]]);
    const unanswered = run(
      {
        allocations: [
          {
            account: '612',
            vat: 'S-21',
            amount: '1000.00',
            deduction: 'limited',
            vehicle: 'B-123-XFA',
          },
          {
            account: '612',
            vat: 'S-21',
            amount: '500.00',
            deduction: 'full',
            vehicle: 'B-456-XFA',
          },
        ],
      },
      [mixed],
    );
    expect(codes(unanswered)).toEqual(['VEHICLE_USE']);
    expect(unanswered.issues[0]!.path).toBe('allocations.1.vehicle');
  });

  test('a part deducting nothing needs no answer', () => {
    const evaluation = run({ account: '612', deduction: 'none', vehicle: 'B-123-XFA' });
    expect(codes(evaluation)).toEqual([]);
    expect(deducted(evaluation)).toEqual([[31500n, 0n]]);
  });

  test('a vehicle cost that names no vehicle is confirmed by the reviewer', () => {
    // The lease of a car on 612, the half deducted, but which car is not said.
    expect(codes(run({ account: '612', deduction: 'limited' }))).toEqual(['VEHICLE_UNNAMED']);
    expect(codes(run({ account: '612', deduction: 'full' }))).toEqual(['VEHICLE_UNNAMED']);
    const rent = purchaseInvoice({
      issueDate: '2026-10-05',
      net: '1500.00',
      rate: '21',
      description: 'Chirie birou, octombrie 2026',
    });
    expect(codes(run({ account: '612', deduction: 'full' }, [], rent))).toEqual([]);
    // Fuel is a vehicle's cost by its account; limited says a vehicle whatever the account.
    expect(codes(run({ account: '6022', deduction: 'full' }, [], rent))).toEqual([
      'VEHICLE_UNNAMED',
    ]);
    expect(codes(run({ account: '628', deduction: 'limited' }, [], rent))).toEqual([
      'VEHICLE_UNNAMED',
    ]);
    expect(codes(run({ account: '628', deduction: 'none' }, [], rent))).toEqual([]);
    expect(suggestsVehicle('2133', [])).toBe(true);
    expect(suggestsVehicle('611.01', ['Reparație B 123 XFA'])).toBe(true);
    expect(suggestsVehicle('611', ['Reparație acoperiș'])).toBe(false);
    expect(suggestsVehicle('628', ['Spălătorie auto'])).toBe(false);
  });

  test('a sale names no vehicle', () => {
    const body = saleInvoice({ issueDate: '2026-10-05', net: '1000.00', rate: '21' });
    const loaded = emptyLoaded([
      { axis: 'vat.status', value: 'normal_vat', effectiveFrom: '2020-01-01' as LocalDate },
    ]);
    (loaded.documents as Map<string, unknown>).set(DOCUMENT, {
      id: DOCUMENT,
      kind: invoiceKinds.sale,
      schema: 'invoice',
      body,
      bodyHash: 'sale',
      docDate: body.issueDate,
      partyId: '00000000-0000-4000-8000-0000000000c1',
      currency: 'RON',
      number: body.number,
      evidenceId: null,
    });
    const evaluation = invoiceRecognition.evaluate(
      recognitionInput.parse({ documentId: DOCUMENT, account: '704', vehicle: 'B-123-XFA' }),
      loaded,
      new RuleContext(register, 'preview'),
    );
    expect(codes(evaluation)).toEqual(['VEHICLE']);
  });
});
