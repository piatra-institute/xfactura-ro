import { z } from 'zod';
import type { FxRate, Issue, Loaded } from '../kernel';
import type { ParameterDefinition, ParameterVersion, RuleContext } from '../rules';
import { daysBetween, parseLocalDate as date, type LocalDate } from '../time';

const rateDate = z.enum(['on_or_before', 'before']);

export const fxDefinitions: ParameterDefinition[] = [
  {
    key: 'ro.fx.rate_date.accounting',
    axis: 'accounting_transaction_date',
    continuity: 'attest_allowed',
    scope: [],
    value: rateDate,
    description:
      'Cursul BNR pentru înregistrarea contabilă a unei operațiuni în valută: cel publicat la data operațiunii sau ultimul anterior (`on_or_before`), ori strict cel anterior datei (`before`).',
  },
  {
    key: 'ro.fx.rate_date.vat',
    axis: 'vat_chargeability_date',
    continuity: 'attest_allowed',
    scope: [],
    value: rateDate,
    description:
      'Cursul BNR pentru baza de impozitare TVA a unei operațiuni în valută, la data exigibilității.',
  },
];

// Which publication applies to a date is the known ambiguity in Romanian FX practice; both
// versions are unreviewed until an expert contabil interprets the governing texts.
export const fxVersions: ParameterVersion[] = [
  {
    id: 'ro.fx.rate_date.accounting/2024-01-01',
    key: 'ro.fx.rate_date.accounting',
    scope: {},
    value: 'on_or_before',
    from: date('2024-01-01'),
    to: null,
    reviewedThrough: date('2026-12-31'),
    knowledgeDate: null,
    status: 'extracted',
    clauses: ['OMFP 1802/2014 pct. 315–316, operațiuni în valută (TO-SOURCE)'],
  },
  {
    id: 'ro.fx.rate_date.vat/2024-01-01',
    key: 'ro.fx.rate_date.vat',
    scope: {},
    value: 'on_or_before',
    from: date('2024-01-01'),
    to: null,
    reviewedThrough: date('2026-12-31'),
    knowledgeDate: null,
    status: 'extracted',
    clauses: ['L227/2015 art. 290 și normele de aplicare (TO-SOURCE)'],
  },
];

/** BNR does not publish on weekends and holidays; a rate older than this is treated as missing. */
const MAX_RATE_AGE_DAYS = 7;

/** The reference rate the rules select for a currency at a date, or the issue preventing it. */
export function selectRate(
  loaded: Loaded,
  rules: RuleContext,
  currency: string,
  at: LocalDate,
  purpose: 'accounting' | 'vat',
): FxRate | Issue {
  const mode = rules.param<'on_or_before' | 'before'>(
    `ro.fx.rate_date.${purpose}`,
    purpose === 'vat' ? 'vat_chargeability_date' : 'accounting_transaction_date',
    at,
  );
  const rate = (loaded.fxRates.get(currency) ?? []).find((candidate) =>
    mode === 'on_or_before' ? candidate.date <= at : candidate.date < at,
  );
  if (!rate || daysBetween(rate.date, at) > MAX_RATE_AGE_DAYS)
    return {
      code: 'FX_RATE',
      severity: 'block',
      message: `Lipsește cursul BNR pentru ${currency} la ${at}. Importați cursurile BNR.`,
    };
  return rate;
}
