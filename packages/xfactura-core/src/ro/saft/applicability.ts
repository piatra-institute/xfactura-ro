import type { ProfileFact } from '../../kernel';
import { RuleGapError, type RuleContext } from '../../rules';
import type { LocalDate } from '../../time';
import type { D406Start } from './parameters';

/*
 * From when a company files D406, by its taxpayer category (OPANAF nr. 1.783/2021 anexa nr. 5,
 * as OPANAF nr. 407/2025 replaced it; the reference dates are `ro.d406.start`). From the small
 * taxpayers' date (1 January 2025) every category files, including those classified later (pct.
 * 1.1 lit. g)), so the category matters only for the months before it.
 */

/** ANAF's classification (`taxpayer.category`): large, medium or small (the others). */
export const taxpayerCategories = ['large', 'medium', 'small'] as const;
export type TaxpayerCategory = (typeof taxpayerCategories)[number];

/** The reference dates in force for a month, or why they are not (a rule gap). */
export type D406StartAt = { start: D406Start; version: string } | { gap: string };

/** `ro.d406.start` for each month (YYYY-MM), as the closure reads it. */
export function d406StartOf(
  rules: RuleContext,
  months: readonly string[],
): Record<string, D406StartAt> {
  const result: Record<string, D406StartAt> = {};
  for (const month of months)
    try {
      const start = rules.param<D406Start>(
        'ro.d406.start',
        'reporting_period_start',
        `${month}-01` as LocalDate,
      );
      const version =
        [...rules.used.keys()].find((id) => id.startsWith('ro.d406.start/')) ?? 'ro.d406.start';
      result[month] = { start, version };
    } catch (error) {
      if (!(error instanceof RuleGapError)) throw error;
      result[month] = { gap: error.message };
    }
  return result;
}

export type D406Begun =
  { state: 'known'; value: boolean; basis: string } | { state: 'unknown'; message: string };

/**
 * Whether the company's D406 obligation has begun by a date. From the small taxpayers' date,
 * every category's has. Before it, by the recorded `taxpayer.category` facts in effect order: each
 * classification begins on its category's date (a large taxpayer from 1 January 2022, or from 1
 * July 2022 when it entered the category on 1 January 2022, lit. b)) or on the classification's
 * own date when later (lit. g)), provided the classification still holds then; once begun it
 * never stops (pct. 2). A medium taxpayer of 2021 that is small from 2023 files from the small
 * taxpayers' date: its option to file earlier (pct. 1.2 lit. a)) is not derived.
 */
export function d406Begun(
  facts: readonly ProfileFact[],
  start: D406Start,
  date: string,
): D406Begun {
  if (date < start.large)
    return {
      state: 'known',
      value: false,
      basis: `D406 se depune de la ${start.large} (anexa nr. 5 pct. 1.1)`,
    };
  if (date >= start.small)
    return {
      state: 'known',
      value: true,
      basis: `toate categoriile de contribuabili, de la ${start.small} (anexa nr. 5 pct. 1.1 lit. d)–g))`,
    };
  const categories = facts.filter(
    (fact) => fact.axis === 'taxpayer.category' && fact.effectiveFrom <= date,
  );
  if (!categories.length)
    return {
      state: 'unknown',
      message: `Categoria de contribuabil (mare, mijlociu sau mic) nu este înregistrată: de ea depinde dacă D406 se depune înainte de ${start.small} (anexa nr. 5 pct. 1.1).`,
    };
  for (const [index, fact] of categories.entries()) {
    const until = categories[index + 1]?.effectiveFrom ?? null;
    const reference =
      fact.value === 'large'
        ? fact.effectiveFrom === start.large
          ? start.largeFrom2022
          : start.large
        : fact.value === 'medium'
          ? start.medium
          : start.small;
    const begins = fact.effectiveFrom > reference ? fact.effectiveFrom : reference;
    if (begins <= date && (until === null || begins < until))
      return {
        state: 'known',
        value: true,
        basis: `contribuabil ${fact.value === 'large' ? 'mare' : fact.value === 'medium' ? 'mijlociu' : 'mic'} din ${fact.effectiveFrom}: D406 de la ${begins} (anexa nr. 5 pct. 1.1, 2)`,
      };
  }
  const current = categories.at(-1)!;
  return {
    state: 'known',
    value: false,
    basis: `contribuabil ${current.value === 'large' ? 'mare' : current.value === 'medium' ? 'mijlociu' : 'mic'} din ${current.effectiveFrom}: data de referință a categoriei nu a venit (anexa nr. 5 pct. 1.1)`,
  };
}
