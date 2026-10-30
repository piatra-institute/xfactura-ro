import { describe, expect, test } from 'bun:test';
import {
  obligationDefinitions,
  obligationDue,
  obligationVersions,
  type ObligationKind,
} from '../src/ro/obligations';
import { clauses } from '../src/ro/sources';
import { ParameterRegister, RuleContext, RuleGapError } from '../src/rules';
import type { LocalDate } from '../src/time';

const rules = () =>
  new RuleContext(new ParameterRegister(obligationDefinitions, obligationVersions), 'preview');
const due = (kind: ObligationKind, start: string, end: string) => {
  const result = obligationDue(kind, { start: start as LocalDate, end: end as LocalDate }, rules());
  return { ...result, nominal: String(result.nominal), due: String(result.due) };
};

describe('filing deadlines', () => {
  test('the 25th of the next month, moved to the next working day', () => {
    expect(due('D300', '2026-10-01', '2026-10-31')).toMatchObject({
      nominal: '2026-11-25',
      due: '2026-11-25',
      versions: ['ro.deadline.D300/2016-01-01', 'ro.deadline.shift/2016-01-01'],
    });
    // 25 October 2026 is a Sunday.
    expect(due('D112', '2026-09-01', '2026-09-30')).toMatchObject({
      nominal: '2026-10-25',
      due: '2026-10-26',
    });
    expect(due('D100.micro', '2026-07-01', '2026-09-30').due).toBe('2026-10-26');
  });

  test('what falls due on 25 December is due on 21 December, or the working day before', () => {
    expect(due('D300', '2026-11-01', '2026-11-30')).toMatchObject({
      nominal: '2026-12-25',
      due: '2026-12-21',
    });
    // 21 December 2025 is a Sunday.
    expect(due('D112', '2025-11-01', '2025-11-30').due).toBe('2025-12-19');
  });

  test('D406 at the end of the next month, D205 in February, S1005 150 days after the year', () => {
    // 31 October 2026 is a Saturday.
    expect(due('D406', '2026-07-01', '2026-09-30')).toMatchObject({
      nominal: '2026-10-31',
      due: '2026-11-02',
    });
    expect(due('D406', '2026-11-01', '2026-11-30').due).toBe('2026-12-31');
    expect(due('D205', '2026-01-01', '2026-12-31')).toMatchObject({
      nominal: '2027-02-28',
      due: '2027-03-01',
    });
    // 30 May 2026 is a Saturday and 1 June a public holiday.
    expect(due('S1005', '2025-01-01', '2025-12-31')).toMatchObject({
      nominal: '2026-05-30',
      due: '2026-06-02',
    });
  });

  test('D394 on the 30th, in February on its last day', () => {
    // 30 November and 1 December 2026 are public holidays.
    expect(due('D394', '2026-10-01', '2026-10-31')).toMatchObject({
      nominal: '2026-11-30',
      due: '2026-12-02',
    });
    // 28 February 2026 is a Saturday; 2024 is a leap year.
    expect(due('D394', '2026-01-01', '2026-01-31')).toMatchObject({
      nominal: '2026-02-28',
      due: '2026-03-02',
    });
    expect(due('D394', '2024-01-01', '2024-01-31').nominal).toBe('2024-02-29');
    expect(due('D394', '2026-07-01', '2026-09-30').due).toBe('2026-10-30');
  });

  test('D212 on 25 May of the year after the income’s', () => {
    expect(due('D212', '2025-01-01', '2025-12-31')).toMatchObject({
      nominal: '2026-05-25',
      due: '2026-05-25',
      versions: ['ro.deadline.D212/2025-01-01', 'ro.deadline.shift/2016-01-01'],
    });
    expect(due('D212', '2026-01-01', '2026-12-31').due).toBe('2027-05-25');
  });

  test('a deadline before its source is a gap, never a guess', () => {
    expect(() => due('D394', '2016-01-01', '2016-01-31')).toThrow(RuleGapError);
    expect(() => due('D406', '2021-10-01', '2021-12-31')).toThrow(RuleGapError);
    // The texts read give D212's deadline from the income of 2025.
    expect(() => due('D212', '2024-01-01', '2024-12-31')).toThrow(RuleGapError);
  });

  test('every deadline cites registered clauses', () => {
    const known = new Set(clauses.map((clause) => clause.id));
    for (const version of obligationVersions)
      for (const clause of version.clauses) expect(known.has(clause)).toBe(true);
  });
});
