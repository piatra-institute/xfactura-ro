import { z } from 'zod';
import { RuleGapError, type RuleContext } from '../../rules';
import type { LocalDate } from '../../time';
import { euVatPrefixes } from '../geo';

/*
 * The VAT rates of the Member States of consumption, as the Commission's TEDB gives them
 * (src/ro/sources/oss.ts, EC/TEDB; the data in rates-data.ts): the standard rate, and each
 * reduced, super-reduced or parking rate with the TEDB categories it applies to. A rate the
 * register does not hold for the country and date is never taken from an invoice: it is a gap.
 */

export const rateKinds = ['reduced', 'super_reduced', 'parking'] as const;
const rate = z.string().regex(/^(0|[1-9]\d?)(\.\d{1,2})?$/);
export const memberStateRates = z
  .object({
    standard: rate,
    reduced: z.array(
      z
        .object({
          rate,
          kind: z.enum(rateKinds),
          /** TEDB's category identifiers (BOOKS, FOODSTUFFS, …) the rate applies to. */
          categories: z.array(z.string().regex(/^[A-Z0-9_]+$/)).min(1),
        })
        .strict(),
    ),
  })
  .strict();
export type MemberStateRates = z.infer<typeof memberStateRates>;

/** The Member States of consumption a company established in Romania declares in the Union
 * scheme, by the D398 code (Greece is EL; Romania is never one, ANAF's rule R15). */
export const consumptionStates: readonly string[] = Object.values(euVatPrefixes).filter(
  (code) => code !== 'RO',
);

/** The D398 code of an invoice's ISO country (GR is EL), or null outside the Union. */
export function memberStateOf(country: string): string | null {
  const code = euVatPrefixes[country.toUpperCase()];
  return code && code !== 'RO' ? code : null;
}

export type ResolvedRate =
  | {
      found: true;
      type: 'standard' | 'reduced';
      kind: 'standard' | (typeof rateKinds)[number];
      categories: string[];
      version: string;
    }
  | { found: false; reason: string; gap?: string };

/** Two rates are equal as numbers (19 and 19.00). */
const same = (a: string, b: string) => Number(a) === Number(b);

/**
 * The rate an invoice line states, against the Member State's rates on the tax point: its
 * standard rate, or one of its reduced rates, the latter only for a category the rate applies to
 * (the line names it). Without the country's version, a RULE_GAP.
 */
export function resolveRate(
  rules: RuleContext,
  country: string,
  date: LocalDate,
  stated: string,
  category?: string,
): ResolvedRate {
  let rates: MemberStateRates;
  try {
    rates = rules.param<MemberStateRates>('ro.vat.oss.rates', 'vat_chargeability_date', date, {
      country,
    });
  } catch (error) {
    if (!(error instanceof RuleGapError)) throw error;
    return { found: false, reason: error.message, gap: error.message };
  }
  const version =
    [...rules.used.keys()].find((id) => id.startsWith(`ro.vat.oss.rates/${country}/`)) ?? '';
  if (same(stated, rates.standard))
    return { found: true, type: 'standard', kind: 'standard', categories: [], version };
  const reduced = rates.reduced.filter((item) => same(item.rate, stated));
  if (!reduced.length)
    return {
      found: false,
      reason: `Cota ${stated}% nu este o cotă a statului membru ${country} la ${date} (standard ${rates.standard}%, reduse ${[...new Set(rates.reduced.map((item) => item.rate))].join('%, ') || '–'}%).`,
    };
  if (!category)
    return {
      found: false,
      reason: `Cota ${stated}% a statului membru ${country} este redusă: indicați categoria TEDB a bunului sau serviciului (${[...new Set(reduced.flatMap((item) => item.categories))].join(', ')}).`,
    };
  const match = reduced.find((item) => item.categories.includes(category));
  if (!match)
    return {
      found: false,
      reason: `Cota ${stated}% a statului membru ${country} nu se aplică categoriei ${category} (se aplică: ${[...new Set(reduced.flatMap((item) => item.categories))].join(', ')}).`,
    };
  return { found: true, type: 'reduced', kind: match.kind, categories: match.categories, version };
}
