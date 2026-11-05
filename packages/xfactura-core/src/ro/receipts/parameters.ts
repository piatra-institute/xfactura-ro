import { z } from 'zod';
import type { ParameterDefinition, ParameterVersion } from '../../rules';
import { parseLocalDate as date } from '../../time';

/*
 * The legal values of receipts and domestic reverse charge (V3): the limit up to which a fiscal
 * receipt showing the buyer's VAT code is a simplified invoice (Codul fiscal art. 319 alin. (12)
 * lit. a), the norms' pct. 69 alin. (6)), and the operations the buyer self-assesses (art. 331)
 * with the threshold of the electronic goods. Every version is `extracted`, read in the texts on
 * 5 November 2026: an expert contabil reviews each (src/ro/reviews/specs/receipts.ts).
 */

/** The categories of art. 331 alin. (2), by letter: what the agent states of each invoice line. */
export const reverseChargeCategories = {
  waste: 'a',
  timber: 'b',
  cereals: 'c',
  emission_certificates: 'd',
  electricity: 'e',
  green_certificates: 'f',
  real_estate: 'g',
  gold: 'h',
  mobile_phones: 'i',
  integrated_circuits: 'j',
  consoles_tablets_laptops: 'k',
  natural_gas: 'l',
} as const;
export type ReverseChargeCategory = keyof typeof reverseChargeCategories;
export const reverseChargeCategoryIds = Object.keys(reverseChargeCategories) as [
  ReverseChargeCategory,
  ...ReverseChargeCategory[],
];

const category = z.enum(reverseChargeCategoryIds);
const lei = z.string().regex(/^[1-9]\d{0,15}$/);

export const reverseChargeRule = z
  .object({
    /** The categories of alin. (2) in force on the date. */
    categories: z.array(category).min(1),
    /** Alin. (7): the categories whose goods on one invoice, together, reach the amount. */
    threshold: z.object({ categories: z.array(category).min(1), lei }).strict(),
  })
  .strict();
export type ReverseChargeRule = z.infer<typeof reverseChargeRule>;

export const receiptDefinitions: ParameterDefinition[] = [
  {
    key: 'ro.vat.simplified_invoice.limit_eur',
    axis: 'vat_chargeability_date',
    continuity: 'block',
    scope: [],
    value: z.string().regex(/^[1-9]\d{0,5}$/),
    description:
      'Valoarea maximă, inclusiv TVA, în euro, a unei facturi simplificate și a bonului fiscal care ține loc de factură simplificată, la cursul de la art. 290 din Codul fiscal.',
  },
  {
    key: 'ro.vat.reverse_charge.domestic',
    axis: 'vat_chargeability_date',
    continuity: 'block',
    scope: [],
    value: reverseChargeRule,
    description:
      'Operațiunile din țară cu taxare inversă (art. 331 din Codul fiscal): categoriile în vigoare și pragul pe factură al telefoanelor mobile, circuitelor integrate, consolelor, tabletelor și laptopurilor.',
  },
];

export const receiptVersions: ParameterVersion[] = [
  // Unchanged since the Code took effect: the portal's consolidated form notes for alin. (12)
  // only the lit. c) added by OG nr. 22/2025.
  {
    id: 'ro.vat.simplified_invoice.limit_eur/2016-01-01',
    key: 'ro.vat.simplified_invoice.limit_eur',
    scope: {},
    value: '100',
    from: date('2016-01-01'),
    to: null,
    reviewedThrough: date('2026-12-31'),
    knowledgeDate: null,
    status: 'extracted',
    clauses: [
      'ANAF/Cod-fiscal-consolidat:art.319(12)',
      'ANAF/Cod-fiscal-consolidat:norme.art.299.pct.69(3),(6)',
      'ANAF/Cod-fiscal-consolidat:art.290(2)',
      'LJR/Cod-fiscal-2025:art.319(12)',
    ],
  },
  // Letters c)–f) and i)–l) end on 31 December 2026 (alin. (6), as OUG nr. 85/2022 set it): what
  // applies from 2027 waits for the December acts (docs/ROLLOVER.md), so the version ends then.
  {
    id: 'ro.vat.reverse_charge.domestic/2025-01-01',
    key: 'ro.vat.reverse_charge.domestic',
    scope: {},
    value: {
      categories: [...reverseChargeCategoryIds],
      threshold: {
        categories: ['mobile_phones', 'integrated_circuits', 'consoles_tablets_laptops'],
        lei: '22500',
      },
    },
    from: date('2025-01-01'),
    to: date('2026-12-31'),
    reviewedThrough: null,
    knowledgeDate: null,
    status: 'extracted',
    clauses: [
      'ANAF/Cod-fiscal-consolidat:art.331(1)-(3)',
      'ANAF/Cod-fiscal-consolidat:art.331(4)-(7)',
      'ANAF/Cod-fiscal-consolidat:norme.art.331.pct.109(19)',
      'LJR/Cod-fiscal-2025:art.331(6)',
    ],
  },
];
