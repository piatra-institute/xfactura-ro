import { z } from 'zod';
import type { ParameterDefinition, ParameterVersion } from '../../rules';
import { parseLocalDate as date } from '../../time';

/*
 * The accounts of the year-end in full (Y1, docs/ACCOUNTING_ENGINE.md): where the annual
 * inventory's differences, the impairments and the provisions are booked. Every value is read in
 * OMFP nr. 1.802/2014 (its 2014 text: the functions of the accounts and the evaluation at the
 * inventory) and OMF nr. 2.861/2009 (its 2009 text: imputation at the replacement value), and is
 * `extracted`: an expert contabil reviews each (src/ro/reviews/specs/yearend.ts). Amendments of
 * either order after those texts are not verified (the legislative portal refuses automated
 * access), so the versions run from 2026, reviewed through its end.
 */

const account = z.string().regex(/^[1-8]\d{2,3}$/);

const inventoryAccounts = z
  .object({
    /** Where a shortage imputed to the person found guilty is booked, at the replacement value
     * (OMF nr. 2.861/2009 pct. 40 alin. (2)): an employee (`employee`), anyone else (`third`),
     * against a revenue. */
    imputation: z.object({ employee: account, third: account, revenue: account }).strict(),
    /** A cash shortage nobody answers for, and a cash surplus. */
    cash: z.object({ shortage: account, surplus: account }).strict(),
    /** A fixed asset found in surplus, at the value the commission sets (the functions of 475). */
    assetSurplus: account,
  })
  .strict();
export type InventoryAccounts = z.infer<typeof inventoryAccounts>;

const impairmentAccounts = z
  .object({
    /** The receivables tested at the year end, their allowance and its expense and revenue
     * (pct. 89, 331–332, 353; the function of 491). */
    receivables: z
      .object({
        accounts: z.array(account).min(1).max(10),
        allowance: account,
        expense: account,
        revenue: account,
      })
      .strict(),
    /** A fixed asset's allowance by its account's prefix, and the expense and revenue (pct.
     * 85–86; the function of 291). */
    assets: z
      .object({
        allowances: z
          .array(z.object({ prefix: z.string().regex(/^2\d{2,3}$/), account }).strict())
          .min(1)
          .max(30),
        expense: account,
        revenue: account,
      })
      .strict(),
  })
  .strict();
export type ImpairmentAccounts = z.infer<typeof impairmentAccounts>;

export const provisionKinds = [
  'litigation',
  'warranty',
  'restructuring',
  'pension',
  'tax',
  'termination',
  'bonus',
  'leave',
  'other',
] as const;
export type ProvisionKind = (typeof provisionKinds)[number];

const provisionAccounts = z
  .object({
    /** A provision's expense and the revenue its reduction or cancellation goes to (the
     * function of 151). */
    expense: account,
    revenue: account,
    /** The analytic of 151 each kind is kept on (pct. 377 alin. (2)). */
    kinds: z.record(z.enum(provisionKinds), account),
    /** Untaken leave and bonuses whose amount is measured on the payroll records are debts to
     * the staff, not provisions (pct. 338 alin. (2)): the account and the expense. */
    measured: z
      .object({
        account,
        expense: account,
        kinds: z.array(z.enum(['leave', 'bonus'])).min(1),
      })
      .strict(),
  })
  .strict();
export type ProvisionAccounts = z.infer<typeof provisionAccounts>;

export const yearEndDefinitions: ParameterDefinition[] = [
  {
    key: 'ro.inventory.accounts',
    axis: 'accounting_transaction_date',
    continuity: 'block',
    scope: [],
    value: inventoryAccounts,
    description:
      'Conturile diferențelor constatate la inventariere: lipsurile imputate (salariați, terți) și venitul lor, lipsurile și plusurile de casă, imobilizările constatate plus (OMF nr. 2.861/2009 pct. 40; OMFP nr. 1.802/2014, funcțiunile conturilor 428, 461, 475 și 758).',
  },
  {
    key: 'ro.impairment.accounts',
    axis: 'accounting_transaction_date',
    continuity: 'block',
    scope: [],
    value: impairmentAccounts,
    description:
      'Conturile ajustărilor pentru depreciere la sfârșitul exercițiului: creanțele testate și ajustarea lor (491), ajustările imobilizărilor pe grupe (29x), cheltuielile și veniturile lor (OMFP nr. 1.802/2014 pct. 85–86, 89, 331–332, 353).',
  },
  {
    key: 'ro.provisions.accounts',
    axis: 'accounting_transaction_date',
    continuity: 'block',
    scope: [],
    value: provisionAccounts,
    description:
      'Conturile provizioanelor pe feluri (151x), cheltuiala și venitul lor, și datoria față de personal a concediilor și bonusurilor comensurate pe statele de salarii (OMFP nr. 1.802/2014 pct. 338 alin. (2), 369–388).',
  },
];

const version = (key: string, value: ParameterVersion['value'], clauses: string[]) =>
  ({
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
  }) satisfies ParameterVersion;

const OMFP = (clause: string) => `OMFP1802/2014:${clause}`;
const OMF = (clause: string) => `OMF2861/2009:${clause}`;

/** As read on 5 November 2026 in the stored texts of both orders. */
export const yearEndVersions: ParameterVersion[] = [
  // The imputation's revenue: 758's function names both the shortages imputed to third parties
  // (461) and the staff's debts (428); of its analytics, 7581 holds indemnities. Whether 7581 or
  // 7588 is the expert's (specs/yearend.ts). A cash shortage nobody answers for is another
  // operating expense; a surplus, another operating revenue.
  version(
    'ro.inventory.accounts',
    {
      imputation: { employee: '4282', third: '461', revenue: '7581' },
      cash: { shortage: '6588', surplus: '7588' },
      assetSurplus: '4754',
    },
    [
      OMF('pct.39-40'),
      OMF('pct.46(3)'),
      OMFP('conturi.461'),
      OMFP('conturi.428'),
      OMFP('conturi.758'),
      OMFP('conturi.475'),
    ],
  ),
  version(
    'ro.impairment.accounts',
    {
      receivables: { accounts: ['4111'], allowance: '491', expense: '6814', revenue: '7814' },
      assets: {
        allowances: [
          { prefix: '203', account: '2903' },
          { prefix: '205', account: '2905' },
          { prefix: '206', account: '2906' },
          { prefix: '208', account: '2908' },
          { prefix: '211', account: '2911' },
          { prefix: '212', account: '2912' },
          { prefix: '213', account: '2913' },
          { prefix: '214', account: '2914' },
          { prefix: '215', account: '2915' },
          { prefix: '216', account: '2916' },
          { prefix: '217', account: '2917' },
        ],
        expense: '6813',
        revenue: '7813',
      },
    },
    [
      OMFP('pct.82-84'),
      OMFP('pct.85-86'),
      OMFP('pct.89'),
      OMFP('pct.331-332'),
      OMFP('pct.353'),
      OMFP('conturi.291'),
      OMFP('conturi.491'),
    ],
  ),
  version(
    'ro.provisions.accounts',
    {
      expense: '6812',
      revenue: '7812',
      kinds: {
        litigation: '1511',
        warranty: '1512',
        restructuring: '1514',
        pension: '1515',
        tax: '1516',
        termination: '1517',
        bonus: '1518',
        leave: '1518',
        other: '1518',
      },
      measured: { account: '4281', expense: '641', kinds: ['leave', 'bonus'] },
    },
    [OMFP('pct.335,338'), OMFP('pct.369-377'), OMFP('pct.387-388'), OMFP('conturi.151')],
  ),
];
