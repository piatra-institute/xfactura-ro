import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { vatDefinitions, vatVersions } from '../src/ro/vat';
import {
  ParameterRegister,
  RuleContext,
  RuleGapError,
  resolveParameter,
  type ParameterDefinition,
  type ParameterVersion,
} from '../src/rules';
import { parseLocalDate as date } from '../src/time';

const register = new ParameterRegister(vatDefinitions, vatVersions);
const rate = (day: string, mode: 'preview' | 'posting' = 'preview', category = 'S') =>
  register.resolve<string>('ro.vat.rate', {
    axis: 'vat_chargeability_date',
    date: date(day),
    scope: { category },
    mode,
  });

const definition: ParameterDefinition<string> = {
  key: 'test.rate',
  axis: 'vat_chargeability_date',
  continuity: 'attest_allowed',
  scope: [],
  value: z.string(),
  description: 'test',
};
const signed: ParameterVersion = {
  id: 'test.rate/1',
  key: 'test.rate',
  scope: {},
  value: '21',
  from: date('2025-08-01'),
  to: null,
  reviewedThrough: date('2026-12-31'),
  knowledgeDate: date('2025-07-25'),
  status: 'signed',
  clauses: ['test'],
};

describe('parameter resolution', () => {
  test('selects the version in force on the axis date', () => {
    expect(rate('2024-06-15')).toMatchObject({ ok: true, value: '19' });
    expect(rate('2025-07-31')).toMatchObject({ ok: true, value: '19' });
    expect(rate('2025-08-01')).toMatchObject({ ok: true, value: '21' });
  });

  test('reports gaps instead of defaulting', () => {
    expect(rate('2023-12-31')).toMatchObject({ ok: false, gap: { reason: 'NO_VERSION' } });
    expect(rate('2026-03-01', 'preview', 'AE')).toMatchObject({
      ok: false,
      gap: { reason: 'NO_VERSION' },
    });
    expect(rate('2027-01-04')).toMatchObject({ ok: false, gap: { reason: 'BEYOND_HORIZON' } });
  });

  test('unreviewed values support previews but not posting', () => {
    expect(rate('2026-03-01', 'posting')).toMatchObject({
      ok: false,
      gap: { reason: 'INSUFFICIENT_REVIEW', have: 'extracted', need: 'signed' },
    });
  });

  test('an attestation extends issuing continuity but never filing', () => {
    const attestation = {
      id: 'owner-2027',
      key: 'test.rate',
      scope: {},
      from: date('2027-01-01'),
      to: date('2027-01-31'),
    };
    const query = { axis: 'vat_chargeability_date' as const, date: date('2027-01-04') };
    expect(
      resolveParameter(definition, [signed], { ...query, mode: 'posting' }, [attestation]),
    ).toEqual({
      ok: true,
      value: '21',
      versionId: 'test.rate/1',
      status: 'signed',
      attestationId: 'owner-2027',
    });
    expect(
      resolveParameter(definition, [signed], { ...query, mode: 'filing' }, [attestation]),
    ).toMatchObject({ ok: false, gap: { reason: 'BEYOND_HORIZON' } });
    expect(
      resolveParameter(
        { ...definition, continuity: 'block' },
        [signed],
        { ...query, mode: 'posting' },
        [attestation],
      ),
    ).toMatchObject({ ok: false, gap: { reason: 'BEYOND_HORIZON' } });
  });

  test('rejects a query on the wrong date axis', () => {
    expect(() =>
      resolveParameter(definition, [signed], {
        axis: 'payment_date',
        date: date('2026-01-01'),
        mode: 'preview',
      }),
    ).toThrow(TypeError);
  });

  test('a rule context records the versions it used and throws on gaps', () => {
    const context = new RuleContext(register, 'preview');
    expect(
      context.param('ro.vat.rate', 'vat_chargeability_date', date('2025-09-01'), { category: 'S' }),
    ).toBe('21');
    expect([...context.used.keys()]).toEqual(['ro.vat.rate/S/2025-08-01']);
    expect(() =>
      context.param('ro.vat.rate', 'vat_chargeability_date', date('2027-02-01'), { category: 'S' }),
    ).toThrow(RuleGapError);
  });
});

describe('register consistency', () => {
  test('rejects overlapping, open-ended unreviewed, malformed and unknown versions', () => {
    const problems = (versions: ParameterVersion[]) => {
      try {
        new ParameterRegister([definition], versions);
        return [];
      } catch (error) {
        return JSON.parse((error as Error).message.split(': ')[1]!).map(
          (item: { problem: string }) => item.problem,
        );
      }
    };
    expect(
      problems([signed, { ...signed, id: 'test.rate/2', from: date('2026-01-01') }]),
    ).toContain('OVERLAP');
    expect(problems([{ ...signed, reviewedThrough: null }])).toEqual(['HORIZON']);
    expect(problems([{ ...signed, value: 21 }])).toEqual(['VALUE']);
    expect(problems([{ ...signed, key: 'other' }])).toEqual(['UNKNOWN_KEY']);
    expect(problems([{ ...signed, scope: { category: 'S' } }])).toEqual(['SCOPE']);
    expect(problems([signed, { ...signed, id: 'old', withdrawn: true }])).toEqual([]);
  });

  test('lists open-ended versions reaching their review horizon', () => {
    expect(register.horizon(date('2026-12-31')).map((version) => version.id)).toEqual([
      'ro.vat.rate/S/2025-08-01',
      'ro.vat.rate/O/2024-01-01',
    ]);
  });
});
