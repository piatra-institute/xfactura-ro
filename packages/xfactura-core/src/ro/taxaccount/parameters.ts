import { z } from 'zod';
import type { ParameterDefinition, ParameterVersion } from '../../rules';
import { parseLocalDate as date } from '../../time';
import { advanceRule, distributionOrder } from './distribution';
import { obligationCatalogue, taxAccounts } from './obligations';

/*
 * The tax account (T2): payments to the single treasury account (contul unic) and their
 * distribution, ANAF's decisions on interest and penalties, refunds and offsets. Read in the
 * consolidated Codul de procedură fiscală (L207/2015, the legislative portal's consolidation of
 * 08.08.2026), ANAF's methodology of distribution (OPANAF nr. 1.613/2018, as OPANAF nr. 146/2025
 * amended it) and nomenclator (OPANAF nr. 1.612/2018, its annex as OPANAF nr. 551/2021 replaced
 * it), and OMFP nr. 1.802/2014. Every value is `extracted`: cited, not reviewed.
 */

const CPF = 'L207/2015';
const percent = z.string().regex(/^(0|[1-9]\d{0,2})(\.\d{1,4})?$/);

/** `ro.taxaccount.interest`: the daily rates of the accessories, in percent. */
export const accessoryRates = z
  .object({
    /** Art. 174 alin. (5): interest for each day of delay. */
    interest: percent,
    /** Art. 176 alin. (2): the late-payment penalty for each day of delay. */
    latePenalty: percent,
    /** Art. 181 alin. (1): the non-declaration penalty for each day. */
    nondeclaration: percent,
  })
  .strict();
export type AccessoryRates = z.infer<typeof accessoryRates>;

/** `ro.taxaccount.decision_due`: art. 156 alin. (1): what a decision establishes is due on the
 * `first` day of the next month when communicated by the `split` day, else on the `second`. */
export const decisionDue = z
  .object({
    split: z.number().int().min(1).max(31),
    first: z.number().int().min(1).max(28),
    second: z.number().int().min(1).max(28),
  })
  .strict();
export type DecisionDue = z.infer<typeof decisionDue>;

export const taxAccountDefinitions: ParameterDefinition[] = [
  {
    key: 'ro.taxaccount.obligations',
    axis: 'payment_date',
    continuity: 'block',
    scope: [],
    value: obligationCatalogue,
    description:
      'Obligațiile față de stat ținute în contabilitate: tipul, bugetul, categoria din ordinea de distribuire și dacă se plătesc în contul unic.',
  },
  {
    key: 'ro.taxaccount.distribution',
    axis: 'payment_date',
    continuity: 'block',
    scope: [],
    value: distributionOrder,
    description:
      'Ordinea de distribuire a sumelor plătite în contul unic: între bugete proporțional, apoi pe categorii (reținere la sursă, principale, accesorii) și proporțional în cadrul categoriei.',
  },
  {
    key: 'ro.taxaccount.advance',
    axis: 'payment_date',
    continuity: 'block',
    scope: [],
    value: advanceRule,
    description:
      'Ce stinge o plată în contul unic dincolo de obligațiile scadente la data ei: obligațiile cunoscute, la scadența fiecăreia, sau nimic până la o distribuire ulterioară.',
  },
  {
    key: 'ro.taxaccount.accounts',
    axis: 'accounting_transaction_date',
    continuity: 'block',
    scope: [],
    value: taxAccounts,
    description:
      'Conturile în care se înregistrează dobânzile, penalitățile și amenzile datorate bugetului și plățile încă nedistribuite.',
  },
  {
    key: 'ro.taxaccount.interest',
    axis: 'payment_date',
    continuity: 'block',
    scope: [],
    value: accessoryRates,
    description:
      'Nivelul dobânzii, al penalității de întârziere și al penalității de nedeclarare, pentru fiecare zi.',
  },
  {
    key: 'ro.taxaccount.decision_due',
    axis: 'accounting_transaction_date',
    continuity: 'block',
    scope: [],
    value: decisionDue,
    description:
      'Termenul de plată al diferențelor și accesoriilor stabilite prin decizie, după data comunicării.',
  },
];

const version = (
  key: string,
  value: ParameterVersion['value'],
  clauses: string[],
  from: string,
  to: string | null = null,
): ParameterVersion => ({
  id: `${key}/${from}`,
  key,
  scope: {},
  value,
  from: date(from),
  to: to === null ? null : date(to),
  reviewedThrough: date('2026-12-31'),
  knowledgeDate: null,
  status: 'extracted',
  clauses,
});

const withheld = (type: string, budget: string) => ({
  type,
  budget,
  category: 'withheld',
  single: true,
});

/** The taxes withheld at source on 446, by the treatment and the tag of the line (`wht:` and the
 * D100 obligation, `withheldTag`): each due by the 25th of the month after it was withheld, the
 * deadline of the return that declares it. */
const withheldAt = (type: string, deadline: 'D100.withholding' | 'D112') => ({
  ...withheld(type, 'state'),
  deadline,
});
const principal = {
  '444': withheld('salary_tax', 'state'),
  '4315': withheld('cas', 'social_insurance'),
  '4316': withheld('cass', 'health_insurance'),
  '4411': { type: 'profit', budget: 'state', category: 'principal', single: true },
  '4418': { type: 'micro', budget: 'state', category: 'principal', single: true },
  '4423': { type: 'vat', budget: 'state', category: 'principal', single: false },
  '436': { type: 'cam', budget: 'state', category: 'principal', single: false },
};
const withheld551 = {
  'dividends.withhold': withheld('dividend_tax', 'state'),
  'loans.withhold': { ...withheld('interest_tax', 'state'), due: 'withholding_date' },
  // Poz. 11: intellectual property paid to individuals, due by the 25th of the month after it
  // was withheld (art. 72 alin. (5)), the deadline of D112, which declares it (art. 132 alin.
  // (2), art. 147 alin. (1)).
  'payees.withhold#wht:611': withheldAt('ip_tax', 'D112'),
  // Poz. 18–21 and 24: non-residents' dividends, interest, royalties, commissions and services
  // (art. 223 alin. (1) lit. a)–g), i), k), l)), due by the 25th of the next month (art. 224
  // alin. (5)).
  'nonresidents.withhold#wht:631': withheldAt('nonresident_dividend_tax', 'D100.withholding'),
  'nonresidents.withhold#wht:632': withheldAt('nonresident_interest_tax', 'D100.withholding'),
  'nonresidents.withhold#wht:633': withheldAt('nonresident_royalty_tax', 'D100.withholding'),
  'nonresidents.withhold#wht:634': withheldAt('nonresident_commission_tax', 'D100.withholding'),
  'nonresidents.withhold#wht:636': withheldAt('nonresident_services_tax', 'D100.withholding'),
};
const clauses551 = [
  'OPANAF551/2021:anexa',
  'OPANAF551/2021:anexa.poz.11',
  'OPANAF551/2021:anexa.poz.18-24',
  `${CPF}:art.163(2)`,
  `${CPF}:art.163(7)`,
  'ANAF/Cod-fiscal-consolidat:art.2(2)',
  'ANAF/Cod-fiscal-consolidat:art.220^6(1)',
  'ANAF/Cod-fiscal-consolidat:art.97(2)',
  'ANAF/Cod-fiscal-consolidat:art.72(2)-(6)',
  'ANAF/Cod-fiscal-consolidat:art.224(5)',
];

export const taxAccountVersions: ParameterVersion[] = [
  // The nomenclator as OPANAF nr. 551/2021 replaced its annex (MO nr. 377 of 12.04.2021); OPANAF
  // nr. 1.985/2022 and 170/2023 add none of the types the engine books. VAT and the work
  // insurance contribution are not in it: each is paid into its own account.
  version(
    'ro.taxaccount.obligations',
    { principal, byTreatment: { '446': withheld551 } },
    clauses551,
    '2021-04-12',
    '2024-05-08',
  ),
  // OPANAF nr. 874/2024 (MO nr. 422 of 09.05.2024) adds poz. 33^3: the tax on rent paid to
  // individuals, withheld by entities keeping accounts (art. 84^1), due by the 25th of the month
  // after it was withheld (alin. (6)). Before it, the nomenclator does not name it: its own account
  // (Codul de procedură fiscală art. 163 alin. (7)).
  version(
    'ro.taxaccount.obligations',
    {
      principal,
      byTreatment: {
        '446': {
          ...withheld551,
          'payees.withhold#wht:628': withheldAt('rent_tax', 'D100.withholding'),
        },
      },
    },
    [...clauses551, 'OPANAF874/2024:art.I.pct.2', 'ANAF/Cod-fiscal-consolidat:art.84^1(3)-(6)'],
    '2024-05-09',
  ),
  version(
    'ro.taxaccount.distribution',
    {
      budgets: 'proportional',
      categories: ['withheld', 'principal', 'accessory'],
      withinCategory: 'by_type',
    },
    [`${CPF}:art.163(3)-(5)`, `${CPF}:art.165(1),(3)`, 'OPANAF1613/2018:pct.4-7'],
    '2018-07-01',
  ),
  version(
    'ro.taxaccount.advance',
    { beyondDue: 'at_due_date' },
    [`${CPF}:art.165(1)`, `${CPF}:art.173(3)`, 'OPANAF1613/2018:pct.8-10'],
    '2018-07-01',
  ),
  version(
    'ro.taxaccount.accounts',
    {
      accessoriesExpense: '6581',
      accessories: '4481',
      undistributed: '4482',
      refundable: ['4424'],
    },
    ['OMFP1802/2014:conturi.448', 'OMFP1802/2014:conturi.658', 'OMFP1802/2014:conturi.442'],
    '2015-01-01',
  ),
  version(
    'ro.taxaccount.interest',
    { interest: '0.02', latePenalty: '0.01', nondeclaration: '0.08' },
    [`${CPF}:art.174(1),(5)`, `${CPF}:art.176(1)-(2)`, `${CPF}:art.181(1)`],
    '2016-01-01',
  ),
  version(
    'ro.taxaccount.decision_due',
    { split: 15, first: 5, second: 20 },
    [`${CPF}:art.156(1)`],
    '2016-01-01',
  ),
];
