import { describe, expect, test } from 'bun:test';
import { roRegister } from '../src/ro/register';
import { obligationDue } from '../src/ro/obligations';
import { d112Filing, payrollPaymentPeriod, quarterMonths } from '../src/ro/payroll';
import { RuleContext } from '../src/rules';
import { monthEnd, monthStart, type LocalDate, type Month } from '../src/time';

/** The day a month's D112 is due under a schedule, from the deadline parameters. */
function due(month: string, period: 'monthly' | 'quarterly', events: string[] = []) {
  const filing = d112Filing(month, period, events);
  const counted = filing.counted.includes('Q')
    ? quarterMonths(month)
    : [filing.counted, filing.counted];
  const rules = new RuleContext(roRegister(), 'preview');
  return obligationDue(
    filing.deadline,
    {
      start: monthStart(counted[0] as Month),
      end: monthEnd(counted.at(-1) as Month) as LocalDate,
    },
    rules,
  ).due as string;
}

describe('quarterly D112 (Codul fiscal art. 147 alin. (4)–(11))', () => {
  test('monthly: each month by the 25th of the next, moved off a Sunday', () => {
    expect(d112Filing('2026-07', 'monthly', [])).toEqual({
      month: '2026-07',
      deadline: 'D112',
      counted: '2026-07',
      basis: 'monthly',
      event: null,
    });
    // 25 August 2026 is a Tuesday; 25 October a Sunday.
    expect(due('2026-07', 'monthly')).toBe('2026-08-25');
    expect(due('2026-09', 'monthly')).toBe('2026-10-26');
  });

  test('quarterly: one return per month, each by the 25th after the quarter', () => {
    expect(['2026-07', '2026-08', '2026-09'].map((month) => due(month, 'quarterly'))).toEqual([
      '2026-10-26',
      '2026-10-26',
      '2026-10-26',
    ]);
    expect(d112Filing('2026-08', 'quarterly', []).basis).toBe('quarterly');
  });

  test('an event in the first month brings only it forward', () => {
    expect(
      ['2026-07', '2026-08', '2026-09'].map((month) => due(month, 'quarterly', ['2026-07'])),
    ).toEqual(['2026-08-25', '2026-10-26', '2026-10-26']);
  });

  test('an event in the second month brings the first two to the 25th of the third', () => {
    const events = ['2026-08'];
    expect(d112Filing('2026-07', 'quarterly', events)).toMatchObject({
      deadline: 'D112',
      counted: '2026-08',
      basis: 'event',
      event: '2026-08',
    });
    expect(
      ['2026-07', '2026-08', '2026-09'].map((month) => due(month, 'quarterly', events)),
    ).toEqual(['2026-09-25', '2026-09-25', '2026-10-26']);
  });

  test('an event in the last month changes no date; November’s is filed by 21 December', () => {
    expect(
      ['2026-07', '2026-08', '2026-09'].map((month) => due(month, 'quarterly', ['2026-09'])),
    ).toEqual(['2026-10-26', '2026-10-26', '2026-10-26']);
    expect(d112Filing('2026-07', 'quarterly', ['2026-09']).basis).toBe('event');
    // 25 December is moved to the 21st (a Monday in 2026).
    expect(due('2026-11', 'quarterly', ['2026-11'])).toBe('2026-12-21');
    expect(due('2026-10', 'quarterly', ['2026-11'])).toBe('2026-12-21');
  });

  test('payment stays with the quarter whatever the declaration does', () => {
    expect(payrollPaymentPeriod('2026-08', 'quarterly')).toEqual({
      deadline: 'D112.quarterly',
      counted: '2026-Q3',
    });
    expect(payrollPaymentPeriod('2026-08', 'monthly')).toEqual({
      deadline: 'D112',
      counted: '2026-08',
    });
    expect(quarterMonths('2026-11')).toEqual(['2026-10', '2026-11', '2026-12']);
  });
});
