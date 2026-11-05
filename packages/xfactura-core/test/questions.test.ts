import { describe, expect, test } from 'bun:test';
import {
  questionIssue,
  questionKind,
  questionKindIds,
  questionKinds,
  questionOf,
} from '../src/questions/kinds';

describe('question kinds', () => {
  test('each kind says what it asks, to whom it applies and how long an answer holds', () => {
    expect(questionKindIds.sort()).toEqual([
      'annual.disclosures',
      'annual.document',
      'annual.informative',
      'capitalGood.use',
      'choice',
      'deferral.schedule',
      'determination.confirm',
      'evidence.missing',
      'micro.conditions',
      'nonresident.certificate',
      'nonresident.payee',
      'obligation.filed',
      'payroll.absences',
      'profile.fact',
      'profit.account',
      'profit.losses',
      'vat.refund',
      'vehicle.use',
      'year.figures',
    ]);
    for (const id of questionKindIds) {
      const kind = questionKind(id)!;
      expect(kind.id).toBe(id);
      expect(kind.summary).toMatch(/^[A-Z].*\.$/);
      expect(kind.subjects.length).toBeGreaterThan(0);
      if (kind.holds === 'perPeriod') expect(kind.period).toBeDefined();
    }
    expect(questionKind('unknown')).toBeUndefined();
  });

  test('answers are checked against the kind, and cite their evidence', () => {
    const vehicle = questionKinds['vehicle.use'];
    expect(vehicle.answer({}).safeParse({ use: 'business_only', from: '2026-01-01' }).success).toBe(
      false,
    );
    const log = '0b6f8f0e-2b1a-4f7e-9a51-1d2c3b4a5e6f';
    const exclusive = vehicle
      .answer({})
      .parse({ use: 'business_only', from: '2026-01-01', logEvidenceId: log });
    expect(vehicle.evidence(exclusive)).toEqual([log]);
    expect(vehicle.answer({}).parse({ use: 'mixed', from: '2026-01-01' })).toEqual({
      use: 'mixed',
      from: '2026-01-01',
    });

    const choice = questionKinds.choice;
    const params = choice.params.parse({
      question: 'Contractul este pe durată determinată?',
      options: [
        { value: 'yes', label: 'Da' },
        { value: 'no', label: 'Nu' },
      ],
    });
    expect(choice.answer(params).safeParse({ value: 'maybe' }).success).toBe(false);
    expect(choice.prompt({ kind: 'party', id: 'x' }, params)).toBe(
      'Contractul este pe durată determinată? (Da / Nu)',
    );
    expect(
      choice.params.safeParse({ question: 'Care?', options: [{ value: 'a', label: 'A' }] }).success,
    ).toBe(false);

    const absences = questionKinds['payroll.absences'];
    expect(absences.period!({ month: '2026-10' })).toBe('2026-10');
    expect(
      absences.answer({ month: '2026-10' }).safeParse({
        absences: [
          {
            employeeId: log,
            kind: 'medical',
            from: '2026-10-05',
            to: '2026-10-03',
            certificateEvidenceId: log,
          },
        ],
      }).success,
    ).toBe(false);

    const deferral = questionKinds['deferral.schedule'];
    expect(deferral.answer({}).safeParse({ from: '2026-10', months: 121 }).success).toBe(false);
  });

  test('an issue carries a question by convention, read back as it was asked', () => {
    const issue = questionIssue('DEFERRAL_SCHEDULE', 'Lipsește perioada.', {
      kind: 'deferral.schedule',
      subject: { kind: 'deferral', id: 'e:628' },
      params: { account: '628' },
    });
    expect(issue).toMatchObject({ code: 'DEFERRAL_SCHEDULE', severity: 'block' });
    expect(questionOf(issue)).toEqual({
      kind: 'deferral.schedule',
      subject: { kind: 'deferral', id: 'e:628' },
      params: { account: '628' },
    });
    expect(questionOf({ details: { question: { kind: 'unknown' } } })).toBeNull();
    expect(questionOf({})).toBeNull();
  });
});
