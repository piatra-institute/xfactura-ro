import { RuleGapError, type RuleContext } from '../../rules';
import { monthEnd, monthStart, type LocalDate, type Month } from '../../time';
import { obligationDue, type ObligationKind } from '../obligations';

/**
 * The due date (scadența) of a tax an item of the authority holds: the deadline of the return
 * that declares it for the months `first`–`last` (`ro.deadline.*`, moved off a non-working day),
 * read as the tax account reads an item that carries none (`taxaccount/obligations.ts`). The
 * treatment that opens the item gives it this date, so the worklist and the tax account agree. A
 * deadline the register does not cover leaves the item without one, as the tax account leaves it.
 */
export function taxDue(
  kind: ObligationKind,
  first: string,
  last: string,
  rules: RuleContext,
): { dueDate: LocalDate } | Record<string, never> {
  try {
    return {
      dueDate: obligationDue(
        kind,
        { start: monthStart(first as Month), end: monthEnd(last as Month) },
        rules,
      ).due,
    };
  } catch (error) {
    if (!(error instanceof RuleGapError)) throw error;
    return {};
  }
}
