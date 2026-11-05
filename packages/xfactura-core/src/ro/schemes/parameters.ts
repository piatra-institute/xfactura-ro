import { z } from 'zod';
import type { ParameterDefinition, ParameterVersion } from '../../rules';
import { parseLocalDate as date } from '../../time';

/*
 * The legal values of the special VAT schemes (V4, docs/ACCOUNTING_ENGINE.md): how the margin of
 * a travel agency (Codul fiscal art. 311 alin. (4); norme pct. 85 alin. (4)) and of a dealer in
 * second-hand goods, works of art, collectors' items and antiques (art. 312 alin. (1) lit. g),
 * (4); norme pct. 86 alin. (4)–(5)) gives its VAT and where the D300 declares it (OPANAF nr.
 * 174/2026 rd. 9), and the agricultural flat-rate compensation a buyer pays and deducts (art. 315^1
 * alin. (2), (17); OPANAF nr. 174/2026 rd. 27). Every version is `extracted`, read in the texts on
 * 5 November 2026, from 2026 (earlier years are a gap, as for the other VAT parameters): an expert
 * contabil reviews each (src/ro/reviews/specs/schemes.ts).
 */

const margin = z
  .object({
    /** What one computation of the VAT covers: every single service of a fiscal period
     * together (`period`), or each supply alone (`supply`). */
    basis: z.enum(['period', 'supply']),
    /** The rate the margin is taxed at: the standard rate in force on the tax point. */
    rate: z.literal('standard'),
    /** The margin includes its VAT: VAT = margin × rate ÷ (100 + rate) ("procedeul sutei
     * mărite"), half up to the ban; the base is the margin less its VAT. */
    method: z.literal('inclusive'),
    /** A negative margin: no VAT (`zero`), or a case the texts do not settle (`unsupported`). */
    negative: z.enum(['zero', 'unsupported']),
    /** The D300 row (base and VAT) the margin is declared on. */
    row: z.literal('R9'),
  })
  .strict();
export type MarginRule = z.infer<typeof margin>;

const flatRate = z
  .object({
    /** The compensation percent of art. 315^1 alin. (2), applied to the price without VAT. */
    percent: z.string().regex(/^(0|[1-9]\d?)(\.\d{1,2})?$/),
    /** The D300 element (rd. 27, VAT column only) the compensation paid is declared on. */
    row: z.literal('R43_2'),
    /** Where the deducted compensation is booked: deducted like VAT (art. 315^1 alin. (17)). */
    account: z.literal('4426'),
  })
  .strict();
export type FlatRateRule = z.infer<typeof flatRate>;

export const schemeDefinitions: ParameterDefinition[] = [
  {
    key: 'ro.vat.margin.travel',
    axis: 'vat_chargeability_date',
    continuity: 'block',
    scope: [],
    value: margin,
    description:
      'Regimul special al agențiilor de turism (art. 311 din Codul fiscal): ce cuprinde un calcul al marjei (serviciile unice ale perioadei fiscale), cota, procedeul sutei mărite, marja negativă și rândul decontului.',
  },
  {
    key: 'ro.vat.margin.goods',
    axis: 'vat_chargeability_date',
    continuity: 'block',
    scope: [],
    value: margin,
    description:
      'Regimul special pentru bunurile second-hand, operele de artă, obiectele de colecție și antichitățile (art. 312 din Codul fiscal): marja pe fiecare livrare, cota, procedeul sutei mărite, marja negativă și rândul decontului.',
  },
  {
    key: 'ro.vat.flat_rate.agriculture',
    axis: 'vat_chargeability_date',
    continuity: 'block',
    scope: [],
    value: flatRate,
    description:
      'Compensația în cotă forfetară a regimului special pentru agricultori (art. 315^1 din Codul fiscal): procentul aplicat prețului fără taxă, contul și rândul decontului cumpărătorului care o deduce.',
  },
];

const version = (
  key: string,
  value: ParameterVersion['value'],
  clauses: string[],
): ParameterVersion => ({
  id: `${key}/2026-01-01`,
  key,
  scope: {},
  value,
  from: date('2026-01-01'),
  to: null,
  reviewedThrough: date('2026-12-31'),
  knowledgeDate: null,
  status: 'extracted',
  clauses,
});
const code = (clause: string) => `ANAF/Cod-fiscal-consolidat:${clause}`;

export const schemeVersions: ParameterVersion[] = [
  // The single services of a fiscal period, from its journals (norme pct. 85 alin. (4) lit. c)),
  // at the standard rate by the hundred-plus method (lit. d), written for 19% in 2017 and read
  // for the rate in force); a period whose margin is negative is not settled by the text.
  version(
    'ro.vat.margin.travel',
    { basis: 'period', rate: 'standard', method: 'inclusive', negative: 'unsupported', row: 'R9' },
    [
      code('art.311(4)-(6)'),
      code('norme.art.311.pct.85'),
      code('art.311(7)-(12)'),
      'OPANAF174/2026:rd.9.special',
    ],
  ),
  // Each supply's margin, by the hundred-plus method; a negative margin collects nothing (norme
  // pct. 86 alin. (4)–(5)); the period's VAT is the sum of its supplies'.
  version(
    'ro.vat.margin.goods',
    { basis: 'supply', rate: 'standard', method: 'inclusive', negative: 'zero', row: 'R9' },
    [
      code('art.312(1)'),
      code('art.312(2)-(4)'),
      code('norme.art.312.pct.86'),
      code('art.312(13)-(15)'),
      'OPANAF174/2026:rd.9.special',
    ],
  ),
  // 8% from 2019 (alin. (2)), deducted by the registered buyer like VAT (alin. (17)), on rd. 27.
  version('ro.vat.flat_rate.agriculture', { percent: '8', row: 'R43_2', account: '4426' }, [
    code('art.315^1(1)-(4)'),
    code('art.315^1(17)-(18)'),
    code('norme.art.315^1.pct.87^1'),
    'OPANAF174/2026:rd.27-28',
  ]),
];
