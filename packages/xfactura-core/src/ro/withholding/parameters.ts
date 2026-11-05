import { z } from 'zod';
import type { ParameterDefinition, ParameterVersion } from '../../rules';
import { parseLocalDate as date } from '../../time';

/*
 * The rates of the taxes a company withholds at source from what it pays to people and to
 * non-residents (O1), read in ANAF's consolidated Codul fiscal (updated through Legea nr.
 * 204/2026). Only the text in force in 2026 was read: earlier payments are a gap.
 *
 * - Rent paid to an individual (art. 84^1): the payer sets the net income at each payment, the
 *   gross less 20% (alin. (3)), and withholds 10% of it (alin. (5)), a final tax paid by the 25th
 *   of the next month (alin. (6)). The article applies from the income of 2024 (OUG nr. 115/2023
 *   art. LIII pct. 64 and art. LVII alin. (3), as the legislative portal's consolidation notes it).
 * - Intellectual property paid to an individual (art. 72): the gross less 40% (alin. (2)), 10% of
 *   it withheld at payment (alin. (4)), final (alin. (5)).
 * - A non-resident's income from Romania (art. 223–224): on the gross, 16% for dividends (art. 224
 *   alin. (4) lit. b)), 10% for the other income of an individual resident in an EU state or in a
 *   state with a double tax treaty (lit. c^1)), 16% for any other (lit. d)); 50% for income paid
 *   into a state without an exchange-of-information instrument after an artificial transaction
 *   (lit. c)) is not covered. A treaty's rate, never assumed, comes from the treaty and the
 *   residence certificate, presented at payment (art. 230 alin. (2)), valid in the year presented
 *   and the first 60 days of the next (`ro.nonresident.certificate_days`).
 */

const code = (clause: string) => `ANAF/Cod-fiscal-consolidat:${clause}`;
const percent = z.string().regex(/^(0|[1-9]\d{0,2})(\.\d{1,4})?$/);

/** What a non-resident is paid, as art. 223 alin. (1) lists it. */
export const nonresidentIncomes = [
  /** Lit. a). */
  'dividends',
  /** Lit. b), c). */
  'interest',
  /** Lit. d), e): art. 7 pct. 36, software licences included where the rights are more than
   * those needed to use the program (norme art. 223 pct. 2). */
  'royalties',
  /** Lit. f), g). */
  'commissions',
  /** Lit. i) management or consulting from a resident, k) services performed in Romania, l)
   * independent professions in Romania. */
  'services',
] as const;
export type NonresidentIncome = (typeof nonresidentIncomes)[number];

/** Who receives it: a company; an individual resident in an EU state or a treaty state (art. 224
 * alin. (4) lit. c^1)); another individual. */
export const nonresidentBeneficiaries = [
  'company',
  'individual_treaty',
  'individual_other',
] as const;
export type NonresidentBeneficiary = (typeof nonresidentBeneficiaries)[number];

export const withholdingDefinitions: ParameterDefinition[] = [
  {
    key: 'ro.rent.tax_rate',
    axis: 'payment_date',
    continuity: 'block',
    scope: [],
    value: percent,
    description:
      'Cota impozitului pe veniturile din cedarea folosinței bunurilor plătite de persoane juridice, reținut la sursă la plata chiriei, aplicată venitului net.',
  },
  {
    key: 'ro.rent.expense_rate',
    axis: 'payment_date',
    continuity: 'block',
    scope: [],
    value: percent,
    description:
      'Cota cheltuielilor deduse din venitul brut din chirii la fiecare plată, pentru venitul net din cedarea folosinței bunurilor plătit de persoane juridice.',
  },
  {
    key: 'ro.ip.tax_rate',
    axis: 'payment_date',
    continuity: 'block',
    scope: [],
    value: percent,
    description:
      'Cota impozitului pe veniturile din drepturi de proprietate intelectuală plătite de persoane juridice, reținut la sursă la plată, aplicată venitului net.',
  },
  {
    key: 'ro.ip.expense_rate',
    axis: 'payment_date',
    continuity: 'block',
    scope: [],
    value: percent,
    description:
      'Cota forfetară a cheltuielilor deduse din venitul brut din drepturi de proprietate intelectuală, pentru venitul net stabilit de plătitor.',
  },
  {
    key: 'ro.nonresident.tax_rate',
    axis: 'payment_date',
    continuity: 'block',
    scope: ['income', 'beneficiary'],
    value: percent,
    description:
      'Cota impozitului pe veniturile obținute din România de nerezidenți, altele decât dividendele, aplicată venitului brut, după natura venitului și beneficiar (Codul fiscal art. 224 alin. (4)).',
  },
  {
    key: 'ro.nonresident.certificate_days',
    axis: 'payment_date',
    continuity: 'block',
    scope: [],
    value: z.number().int().min(0).max(366),
    description:
      'Zilele calendaristice din anul următor în care certificatul de rezidență fiscală prezentat în anul plăților rămâne valabil.',
  },
];

const version = (
  key: string,
  value: string | number,
  clauses: string[],
  scope: Record<string, string> = {},
): ParameterVersion => ({
  id: `${key}/${Object.values(scope)
    .map((item) => `${item}/`)
    .join('')}2026-01-01`,
  key,
  scope,
  value,
  from: date('2026-01-01'),
  to: null,
  reviewedThrough: date('2026-12-31'),
  knowledgeDate: null,
  status: 'extracted',
  clauses,
});

const rentClauses = [code('art.84^1(3)-(6)'), 'LJR/Cod-fiscal-2025:art.84^1'];
const ipClauses = [code('art.72(2)-(6)')];

/** The domestic rate of art. 224 alin. (4) for each income other than dividends (whose rate,
 * `ro.dividend.tax_rate` for `nonresident`, follows the distribution's date like a resident's)
 * and each beneficiary. */
const nonresidentRate = (beneficiary: NonresidentBeneficiary): { rate: string; clause: string } =>
  beneficiary === 'individual_treaty'
    ? { rate: '10', clause: code('art.224(4)(c^1)') }
    : { rate: '16', clause: code('art.224(4)(d)') };

export const withholdingVersions: ParameterVersion[] = [
  version('ro.rent.tax_rate', '10', rentClauses),
  version('ro.rent.expense_rate', '20', rentClauses),
  version('ro.ip.tax_rate', '10', ipClauses),
  version('ro.ip.expense_rate', '40', ipClauses),
  ...nonresidentIncomes
    .filter((income) => income !== 'dividends')
    .flatMap((income) =>
      nonresidentBeneficiaries.map((beneficiary) => {
        const { rate, clause } = nonresidentRate(beneficiary);
        return version(
          'ro.nonresident.tax_rate',
          rate,
          [code('art.223(1)'), clause, code('art.224(5)')],
          { income, beneficiary },
        );
      }),
    ),
  version('ro.nonresident.certificate_days', 60, [code('art.230(1)-(2)')]),
];
