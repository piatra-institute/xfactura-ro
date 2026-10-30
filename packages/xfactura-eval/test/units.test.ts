import { describe, expect, test } from 'bun:test';
import { decode, encode, normalize } from '../src/agents/model';
import { toolNames } from '../src/agents/llm';
import { bani, compare, lei, type Normal } from '../src/run/effects';
import { receiptPng } from '../src/world/png';

const normal = (overrides: Partial<Normal> = {}): Normal => ({
  treatment: 'invoices.recognize',
  status: 'posted',
  date: '2026-10-02',
  month: '2026-10',
  lines: ['C 401 121.00 @30114503', 'D 4426 21.00', 'D 626 100.00'],
  taxes: ['input S-21 base 100.00 tax 21.00 deductible 21.00'],
  taxPeriods: ['S-21 2026-10'],
  accounts: ['D 626'],
  partners: ['30114503'],
  schedules: [],
  vat: ['in S-21 full'],
  output: 0n,
  deductible: 2100n,
  profit: -10000n,
  ...overrides,
});

describe('effects', () => {
  test('amounts in bani and back', () => {
    expect(bani('121.00')).toBe(12100n);
    expect(bani('-0.05')).toBe(-5n);
    expect(lei(-12345n)).toBe('-123.45');
  });

  test('an identical booking is exact; nothing booked is missing and misstates the whole', () => {
    expect(compare(normal(), normal())).toMatchObject({ exact: true, critical: [] });
    const missing = compare(normal(), null);
    expect(missing.exact).toBe(false);
    expect(missing.fields.account).toBe('missing');
    expect(missing.vatDelta).toBe(2100n);
    expect(missing.profitDelta).toBe(10000n);
  });

  test('a wrong account is a field error, not a critical one', () => {
    const agent = normal({
      lines: ['C 401 121.00 @30114503', 'D 4426 21.00', 'D 628 100.00'],
      accounts: ['D 628'],
    });
    const result = compare(normal(), agent);
    expect(result.exact).toBe(false);
    expect(result.fields).toMatchObject({ account: 'mismatch', vat: 'match', partner: 'match' });
    expect(result.critical).toEqual([]);
  });

  test('a wrong deduction, period or partner is critical', () => {
    const half = normal({
      taxes: ['input S-21 base 100.00 tax 21.00 deductible 10.50'],
      deductible: 1050n,
      profit: -11050n,
    });
    expect(compare(normal(), half).critical).toEqual(['vat']);
    expect(compare(normal(), half).vatDelta).toBe(1050n);
    expect(compare(normal(), normal({ taxPeriods: ['S-21 2026-11'] })).critical).toEqual([
      'period',
    ]);
    expect(compare(normal(), normal({ partners: ['42093102'] })).critical).toEqual(['partner']);
  });
});

describe('recordings', () => {
  const a = '0e7c1d4a-1b2c-4d3e-8f40-123456789abc';
  const b = '9f8e7d6c-5b4a-4321-8fed-cba987654321';

  test('identifiers, hashes and timestamps become placeholders in order of first appearance', () => {
    const request = {
      messages: [
        { role: 'user', content: `Proposal ${b} then ${a}` },
        {
          role: 'user',
          content: JSON.stringify({ id: a, at: '2026-10-30T10:00:00.123Z', hash: 'f'.repeat(64) }),
        },
      ],
    };
    const { value, values } = normalize(request);
    expect(values).toEqual([b, a, '2026-10-30T10:00:00.123Z', 'f'.repeat(64)]);
    expect(JSON.stringify(value)).not.toContain(a);
    // The same conversation with other identifiers normalizes the same.
    const other = JSON.parse(
      JSON.stringify(request)
        .replaceAll(a, '11111111-2222-4333-8444-555555555555')
        .replaceAll(b, '66666666-7777-4888-9999-aaaaaaaaaaaa'),
    );
    expect(normalize(other).value).toEqual(value);
  });

  test('responses are kept with placeholders and filled with the replaying run’s values', () => {
    const response = { content: [{ type: 'tool_use', input: { proposalId: a, note: 'x' } }] };
    const stored = encode(response, [b, a]);
    expect(JSON.stringify(stored)).toContain('⟦2⟧');
    expect(decode(stored, ['x', 'y'])).toEqual({
      content: [{ type: 'tool_use', input: { proposalId: 'y', note: 'x' } }],
    });
  });

  test("the period of an unread file is the engine clock's, so it decides like any value", () => {
    const item = (period: string) => ({
      content: JSON.stringify({ items: [{ kind: 'evidence.unused', period, subject: { id: a } }] }),
    });
    expect(normalize(item('2026-10')).value).not.toEqual(normalize(item('2027-03')).value);
  });

  test('tool names the Messages API accepts', () => {
    const { forward, back } = toolNames([{ name: 'work.list' }, { name: 'capabilities.invoke' }]);
    expect(forward.get('work.list')).toBe('work_list');
    expect(back.get('capabilities_invoke')).toBe('capabilities.invoke');
  });
});

test('the receipt photo is a PNG', () => {
  const png = receiptPng(['BON FISCAL', 'TOTAL 300.00']);
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});
