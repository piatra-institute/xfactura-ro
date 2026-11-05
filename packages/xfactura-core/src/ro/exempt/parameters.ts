import { z } from 'zod';
import type { ParameterDefinition, ParameterVersion } from '../../rules';
import { parseLocalDate as date } from '../../time';

/*
 * The legal values of exempt supplies, the pro-rata and the adjustments of deductible VAT (V2,
 * docs/ACCOUNTING_ENGINE.md): how the definitive pro-rata is rounded and where its year-end
 * adjustment is declared and booked (Codul fiscal art. 300 alin. (8), (14); OPANAF nr. 174/2026
 * rd. 34), the same for the adjustment of stock and services not used (art. 304; norme pct. 78)
 * and the smallest adjustment of a capital good that is made (art. 305 alin. (9), repealed).
 * Every version is `extracted`, read in the texts on 5 November 2026: an expert contabil reviews
 * each (src/ro/reviews/specs/exempt.ts).
 */

const account = z.string().regex(/^[1-9]\d{2,3}$/);

const prorata = z
  .object({
    /** The definitive pro-rata, in percent, rounded up to the next whole unit (alin. (8)). */
    rounding: z.literal('up_to_unit'),
    /** The D300 element the year-end adjustment goes on (rd. 34, "ajustări conform pro-rata"). */
    row: z.literal('R31_2'),
    /** Where a deduction the definitive pro-rata takes back is expensed, and where one it adds
     * is taken in. */
    expense: account,
    income: account,
  })
  .strict();
export type ProrataRule = z.infer<typeof prorata>;

const stockAdjustment = z
  .object({
    /** The D300 element the adjustment goes on (rd. 34, "ajustări de taxă"). */
    row: z.literal('R31_2'),
    expense: account,
    income: account,
  })
  .strict();
export type StockAdjustmentRule = z.infer<typeof stockAdjustment>;

export const exemptDefinitions: ParameterDefinition[] = [
  {
    key: 'ro.vat.prorata',
    axis: 'vat_chargeability_date',
    continuity: 'block',
    scope: [],
    value: prorata,
    description:
      'Rotunjirea pro ratei definitive (art. 300 alin. (8)) și rândul decontului și conturile ajustării de la sfârșitul anului a taxei deduse pe bază de pro rata provizorie (art. 300 alin. (14)).',
  },
  {
    key: 'ro.vat.stock_adjustment',
    axis: 'vat_chargeability_date',
    continuity: 'block',
    scope: [],
    value: stockAdjustment,
    description:
      'Rândul decontului și conturile ajustării taxei deductibile pentru bunurile din stoc, serviciile neutilizate, activele în curs și avansuri, la schimbarea regimului de TVA (art. 304; norme pct. 78 și pct. 83 alin. (7), (11)).',
  },
  {
    key: 'ro.vat.capital_goods.minimum',
    axis: 'vat_chargeability_date',
    continuity: 'block',
    scope: [],
    value: z.string().regex(/^(0|[1-9]\d{0,9})$/),
    description:
      'Suma, în lei, sub care nu se efectuează o ajustare a taxei deductibile pentru un bun de capital (art. 305 alin. (9), abrogat; norme pct. 79 alin. (4)); 0: orice ajustare se efectuează.',
  },
];

const version = (
  key: string,
  value: ParameterVersion['value'],
  clauses: string[],
  from: string,
): ParameterVersion => ({
  id: `${key}/${from}`,
  key,
  scope: {},
  value,
  from: date(from),
  to: null,
  reviewedThrough: date('2026-12-31'),
  knowledgeDate: null,
  status: 'extracted',
  clauses,
});
const code = (clause: string) => `ANAF/Cod-fiscal-consolidat:${clause}`;

/**
 * As the texts read on 5 November 2026 give them: the Fiscal Code in ANAF's consolidated text
 * (from 1 January 2026; earlier years are a gap), the D300 rows of OPANAF nr. 174/2026.
 */
export const exemptVersions: ParameterVersion[] = [
  version(
    'ro.vat.prorata',
    { rounding: 'up_to_unit', row: 'R31_2', expense: '635', income: '7588' },
    [code('art.300(8)-(14)'), 'OPANAF174/2026:rd.33-34', 'OPANAF174/2026:pro_rata'],
    '2026-01-01',
  ),
  version(
    'ro.vat.stock_adjustment',
    { row: 'R31_2', expense: '635', income: '7588' },
    [
      code('art.304'),
      code('norme.art.304.pct.78'),
      code('norme.art.310.pct.83(7)-(8),(11)-(12)'),
      'OPANAF174/2026:rd.33-34',
    ],
    '2026-01-01',
  ),
  // Art. 305 alin. (9) was repealed by OUG nr. 78/2024 (the portal's consolidation); norme pct.
  // 79 alin. (4) still sets 1.000 lei "în sensul art. 305 alin. (9)". The engine reads no
  // threshold left: every adjustment is made; the expert decides (specs/exempt.ts).
  version(
    'ro.vat.capital_goods.minimum',
    '0',
    [code('norme.art.305.pct.79(4)'), 'LJR/Cod-fiscal-2025:art.305(9)'],
    '2026-01-01',
  ),
];
