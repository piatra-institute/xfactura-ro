import { z } from 'zod';
import type { ParameterDefinition, ParameterVersion } from '../../rules';
import { parseLocalDate as date } from '../../time';

/*
 * The legal values of the non-payers' module (docs/ACCOUNTING_ENGINE.md, "Non-payers"): where a
 * non-payer books the VAT it owes on services bought from abroad, how the VAT owed for a late
 * registration is declared and booked, how the first year's turnover is recalculated for the VAT
 * period, and the capital goods' adjustment periods. Every version is `extracted`, read in the
 * texts on 5 November 2026: an expert contabil reviews each (src/ro/reviews/specs/nonpayers.ts).
 */

const account = z.string().regex(/^[1-9]\d{2,3}$/);

const lateRegistration = z
  .object({
    /** The D300 row pair of the VAT that should have been collected (Regularizări taxă
     * colectată): base R16_1, VAT R16_2. */
    collected: z.literal('R16'),
    /** The D300 row pair of the VAT that could have been deducted (Regularizări taxă dedusă):
     * base R30_1, VAT R30_2. */
    deducted: z.literal('R30'),
    /** Where the VAT not charged to customers is expensed. */
    expense: account,
    /** Where the VAT now deducted on purchases expensed with it is taken back. */
    income: account,
  })
  .strict();
export type LateRegistration = z.infer<typeof lateRegistration>;

const capitalGoods = z
  .object({
    /** Years of the adjustment period of movable capital goods (art. 305 alin. (2) lit. a)). */
    movable: z.number().int().min(1).max(50),
    /** Of immovable property, its construction or acquisition (lit. b)). */
    immovable: z.number().int().min(1).max(50),
    /** The D300 element the adjustments go on (rd. 34, "ajustări de taxă"). */
    row: z.literal('R31_2'),
    /** Where an adjustment in favour of the state is expensed, and where one in favour of the
     * company is taken in. */
    expense: account,
    income: account,
  })
  .strict();
export type CapitalGoodsRule = z.infer<typeof capitalGoods>;

export const nonpayerDefinitions: ParameterDefinition[] = [
  {
    key: 'ro.vat.special.payable_account',
    axis: 'vat_chargeability_date',
    continuity: 'block',
    scope: [],
    value: account,
    description:
      'Contul pe care o persoană neînregistrată în scopuri de TVA după art. 316 înregistrează taxa datorată prin decontul special (D301) pentru serviciile cumpărate de la prestatori nestabiliți în România.',
  },
  {
    key: 'ro.vat.late_registration',
    axis: 'reporting_period_start',
    continuity: 'block',
    scope: [],
    value: lateRegistration,
    description:
      'Rândurile primului decont după înregistrare pe care se înscrie taxa datorată pentru înregistrarea întârziată (art. 310 alin. (6^2)–(6^3)) și conturile în care se înregistrează.',
  },
  {
    key: 'ro.vat.registration.annualized',
    axis: 'reporting_period_start',
    continuity: 'block',
    scope: [],
    value: z.enum(['days', 'months']),
    description:
      'Cum se recalculează pentru un an întreg cifra de afaceri a întreprinderii mici care se înregistrează în cursul anului (art. 322 alin. (4)–(5)): proporțional cu zilele sau cu lunile de activitate.',
  },
  {
    key: 'ro.vat.capital_goods',
    axis: 'vat_chargeability_date',
    continuity: 'block',
    scope: [],
    value: capitalGoods,
    description:
      'Perioadele de ajustare a taxei deductibile pentru bunurile de capital (art. 305), rândul decontului și conturile ajustării la trecerea între regimul normal și regimul special de scutire.',
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
 * As the texts read on 5 November 2026 give them. The Fiscal Code is read in ANAF's consolidated
 * text, which shows the text in force: its values start on 1 January 2026, earlier years are a
 * gap. The D300 rows are those of OPANAF nr. 174/2026, used from the returns of January 2026.
 */
export const nonpayerVersions: ParameterVersion[] = [
  version(
    'ro.vat.special.payable_account',
    '4423',
    [
      code('art.307(2)'),
      code('art.324(1)-(2)'),
      'OPANAF592/2016:anexa2.pct.I',
      'OMFP1802/2014:cont.4423',
    ],
    '2026-01-01',
  ),
  version(
    'ro.vat.late_registration',
    { collected: 'R16', deducted: 'R30', expense: '635', income: '7588' },
    [
      code('art.310(6^1)-(6^3)'),
      code('norme.art.291.pct.36(b)'),
      'OPANAF174/2026:rd.16',
      'OPANAF174/2026:rd.33-34',
    ],
    '2026-01-01',
  ),
  version('ro.vat.registration.annualized', 'days', [code('art.322(4)-(5)')], '2026-01-01'),
  version(
    'ro.vat.capital_goods',
    { movable: 5, immovable: 20, row: 'R31_2', expense: '635', income: '7588' },
    [
      code('art.305(2)-(5)'),
      code('norme.art.310.pct.83(7)-(8),(11)-(12)'),
      'OPANAF174/2026:rd.33-34',
    ],
    '2026-01-01',
  ),
];
