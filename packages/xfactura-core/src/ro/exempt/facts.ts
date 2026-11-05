import type { ProfileFact } from '../../kernel';
import type { LocalDate } from '../../time';
import { prorataFact, type ProrataFact } from './prorata';

/**
 * The provisional pro-rata in force on a date (Codul fiscal art. 300 alin. (9)–(10)): the
 * `vat.prorata` fact recorded for that year, from 1 January or from the day the company became
 * mixed. A fact recorded for an earlier year does not carry: the provisional pro-rata is
 * communicated each year (by 25 January), so the year's own is asked.
 */
export function provisionalProrata(
  facts: readonly ProfileFact[],
  date: LocalDate,
):
  | { found: true; fact: ProrataFact; from: LocalDate }
  | { found: false; reason: 'none' | 'earlier_year' | 'invalid'; from: LocalDate | null } {
  let latest: ProfileFact | null = null;
  for (const fact of facts)
    if (fact.axis === 'vat.prorata' && fact.effectiveFrom <= date) latest = fact;
  if (!latest) return { found: false, reason: 'none', from: null };
  if (latest.effectiveFrom.slice(0, 4) !== date.slice(0, 4))
    return { found: false, reason: 'earlier_year', from: latest.effectiveFrom };
  const fact = prorataFact(latest.value);
  if (!fact) return { found: false, reason: 'invalid', from: latest.effectiveFrom };
  return { found: true, fact, from: latest.effectiveFrom };
}
