import { z } from 'zod';
import type { FxRate, Issue, Loaded } from '../kernel';
import type { ParameterDefinition, ParameterVersion, RuleContext } from '../rules';
import { daysBetween, parseLocalDate as date, type LocalDate } from '../time';
import { booksSystemOf } from './entity';

const rateDate = z.enum(['on_or_before', 'before']);

/** Whose rate an adjustment of an operation in a currency (a credit note, Codul fiscal art. 287)
 * takes: its base operation's, the invoice it corrects (`base_operation`), or the rate of the
 * event's own date (`event`). */
export const adjustmentRates = ['base_operation', 'event'] as const;
export type AdjustmentRate = (typeof adjustmentRates)[number];

export const fxDefinitions: ParameterDefinition[] = [
  {
    key: 'ro.fx.rate_date.accounting',
    axis: 'accounting_transaction_date',
    continuity: 'attest_allowed',
    scope: ['books'],
    value: rateDate,
    description:
      'Cursul BNR pentru înregistrarea contabilă a unei operațiuni în valută, după sistemul contabil (`double`, `single`): cel publicat la data operațiunii sau ultimul anterior (`on_or_before`), ori strict cel anterior datei (`before`).',
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
  {
    key: 'ro.fx.adjustment.vat',
    axis: 'vat_chargeability_date',
    continuity: 'attest_allowed',
    scope: [],
    value: z.enum(adjustmentRates),
    description:
      'Cursul la care se ajustează baza de impozitare și TVA a unei operațiuni în valută, la evenimentele de la art. 287 (o notă de credit): cursul operațiunii de bază, cu care i s-a determinat baza de impozitare (`base_operation`), sau cursul de la data evenimentului (`event`).',
  },
  {
    key: 'ro.fx.adjustment.books',
    axis: 'accounting_transaction_date',
    continuity: 'attest_allowed',
    scope: [],
    value: z.enum(adjustmentRates),
    description:
      'Cursul la care se înregistrează în contabilitate venitul sau cheltuiala pe care o reduce o notă de credit în valută: cursul de la data notei, a operațiunii (`event`), sau cursul facturii inițiale (`base_operation`). Creanța sau datoria se reduce la valoarea ei contabilă, iar diferența este diferență de curs.',
  },
];

// Which publication applies to a date is the known ambiguity in Romanian FX practice; both
// versions are unreviewed until an expert contabil interprets the governing texts. Single-entry
// books take the rate of the last banking day before the operation (OMFP nr. 170/2015 cap. III
// pct. 18), for receipts, payments and documents alike.
export const fxVersions: ParameterVersion[] = [
  {
    id: 'ro.fx.rate_date.accounting/2024-01-01',
    key: 'ro.fx.rate_date.accounting',
    scope: { books: 'double' },
    value: 'on_or_before',
    from: date('2024-01-01'),
    to: null,
    reviewedThrough: date('2026-12-31'),
    knowledgeDate: null,
    status: 'extracted',
    clauses: ['OMFP1802/2014:pct.315-316'],
  },
  {
    id: 'ro.fx.rate_date.accounting/single/2024-01-01',
    key: 'ro.fx.rate_date.accounting',
    scope: { books: 'single' },
    value: 'before',
    from: date('2024-01-01'),
    to: null,
    reviewedThrough: date('2026-12-31'),
    knowledgeDate: null,
    status: 'extracted',
    clauses: ['OMFP170/2015:cap.III.pct.18'],
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
    clauses: ['L227/2015:art.290'],
  },
  // A credit note's VAT base and VAT keep the rate its invoice's base was converted at: the Code
  // says so (art. 282 alin. (9)), and the norms name that rate (pct. 25 alin. (2)); the event's
  // rate only when the base operation cannot be determined, which a credit note naming its
  // invoice never is. Read on 5 November 2026 in ANAF's consolidated text and the portal's form
  // of 25.10.2026.
  {
    id: 'ro.fx.adjustment.vat/2016-01-01',
    key: 'ro.fx.adjustment.vat',
    scope: {},
    value: 'base_operation',
    from: date('2016-01-01'),
    to: null,
    reviewedThrough: date('2026-12-31'),
    knowledgeDate: null,
    status: 'extracted',
    clauses: ['ANAF/Cod-fiscal-consolidat:art.282(9)'],
  },
  // The books: a transaction in a currency is recorded at the rate of the day it takes place
  // (OMFP nr. 1.802/2014 pct. 319), and the credit note is the document of an event of its own
  // date (pct. 314 alin. (2)–(3)); the receivable or payable it reduces leaves at its carrying
  // amount, the difference an exchange difference (pct. 322). That the reduction of revenue or
  // expense is that transaction, not a correction at the invoice's rate, is the expert's to
  // confirm (src/ro/reviews/specs/credit.ts).
  {
    id: 'ro.fx.adjustment.books/2016-01-01',
    key: 'ro.fx.adjustment.books',
    scope: {},
    value: 'event',
    from: date('2016-01-01'),
    to: null,
    reviewedThrough: date('2026-12-31'),
    knowledgeDate: null,
    status: 'extracted',
    clauses: ['OMFP1802/2014:pct.319', 'OMFP1802/2014:pct.322'],
  },
];

/** BNR does not publish on weekends and holidays; a rate older than this is treated as missing. */
const MAX_RATE_AGE_DAYS = 7;

/**
 * The reference rate the rules select for a currency at a date, or the issue preventing it. The
 * accounting rate depends on the books system, read from the profile: a treatment converting at
 * the accounting rate reads the profile.
 */
export function selectRate(
  loaded: Loaded,
  rules: RuleContext,
  currency: string,
  at: LocalDate,
  purpose: 'accounting' | 'vat',
): FxRate | Issue {
  const mode =
    purpose === 'vat'
      ? rules.param<'on_or_before' | 'before'>('ro.fx.rate_date.vat', 'vat_chargeability_date', at)
      : rules.param<'on_or_before' | 'before'>(
          'ro.fx.rate_date.accounting',
          'accounting_transaction_date',
          at,
          { books: booksSystemOf(loaded.profile, at) },
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
