import type { RuleContext } from '../../rules';
import { addDays, monthStart, type LocalDate, type Month } from '../../time';
import { addWorkingDays } from '../calendar';

/**
 * When REGES-ONLINE must have an event of an employment contract (HG nr. 295/2025 art. 5): its
 * start by the day before the work starts (`ro.deadline.reges.start`); a change of the occupation,
 * the duration (the end date) or the working time by the day before the change takes effect, of
 * the salary within the working days after it (`ro.deadline.reges.change`), the earliest of them
 * when several change together; the end at the latest on its date (`ro.deadline.reges.end`). A
 * change of the start date is a correction (art. 5 alin. (8)), due when the employer learns of the
 * error: it has no deadline the engine can set.
 */
export type RegesEvent = 'start' | 'change' | 'end';
export type RegesField = 'salary' | 'hours' | 'occupation' | 'end_date' | 'start_date';

export function regesDeadline(
  event: RegesEvent,
  effective: LocalDate,
  changed: readonly RegesField[],
  rules: RuleContext,
): { deadline: LocalDate | null; blocked: string | null; rule: string } {
  const at = monthStart(effective.slice(0, 7) as Month);
  if (event === 'start') {
    const { daysBefore } = rules.param<{ daysBefore: number }>(
      'ro.deadline.reges.start',
      'payroll_month_start',
      at,
    );
    return {
      deadline: addDays(effective, -daysBefore),
      blocked: null,
      rule: 'ro.deadline.reges.start',
    };
  }
  if (event === 'end') {
    const { daysBefore } = rules.param<{ daysBefore: number }>(
      'ro.deadline.reges.end',
      'payroll_month_start',
      at,
    );
    return {
      deadline: addDays(effective, -daysBefore),
      blocked: null,
      rule: 'ro.deadline.reges.end',
    };
  }
  const rule = 'ro.deadline.reges.change';
  if (changed.includes('start_date'))
    return {
      deadline: null,
      blocked:
        'Data începerii activității se corectează în registru la data la care angajatorul a aflat de eroare (HG nr. 295/2025 art. 5 alin. (8)): înregistrați transmiterea când o faceți.',
      rule,
    };
  const terms = rules.param<{ daysBefore: number; salaryWorkingDays: number }>(
    rule,
    'payroll_month_start',
    at,
  );
  const deadlines: LocalDate[] = [];
  if (changed.some((field) => field !== 'salary'))
    deadlines.push(addDays(effective, -terms.daysBefore));
  if (changed.includes('salary'))
    deadlines.push(addWorkingDays(effective, terms.salaryWorkingDays));
  return { deadline: deadlines.sort()[0] ?? null, blocked: null, rule };
}
