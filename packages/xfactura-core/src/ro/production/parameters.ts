import { z } from 'zod';
import type { ParameterDefinition, ParameterVersion } from '../../rules';
import { parseLocalDate as date } from '../../time';

/*
 * Production's accounts and readings (G4, docs/ACCOUNTING_ENGINE.md): where the work in progress,
 * the products, their price differences and the variation of stocks are booked, which expenses a
 * work order's materials come from, what direct labour costs, which expenses may be production
 * overheads; which cost methods the policies may choose, how the work in progress of an open order
 * is valued, and over which period the price differences' coefficient is computed. Every value is
 * read in OMFP nr. 1.802/2014 as the legislative portal consolidates it (to 1 February 2022, the
 * functions of 345, 348 and 711 as OMFP nr. 773/2015 amended them); it is `extracted`, and the
 * readings the text leaves open are the expert's (src/ro/reviews/specs/production.ts).
 */

const account = z.string().regex(/^[1-8]\d{2,3}$/);

const productionAccounts = z
  .object({
    /** The work in progress of products (331), kept by its count at the period's end. */
    wip: account,
    /** The variation of stocks of products (711), every production entry's counterpart. */
    variation: account,
    /** The product accounts production enters into: semi-finished (341), finished (345) and
     * residual products (346). */
    products: z.array(account).min(1),
    /** Residual products (346): entered at their net realizable value, deducted from the order's
     * cost (pct. 8 pct. 7: secondary products). */
    residual: account,
    /** The products' price differences (348). */
    differences: account,
    /** The accounts a work order's materials are given from (30x, 381), by prefix. */
    materials: z.array(z.string().regex(/^3\d{2,3}$/)).min(1),
    /** Direct labour: the salaries' expense (641) and the employer's contributions on them (646),
     * which the reading includes in the labour's cost. */
    labour: z.object({ salary: account, contributions: z.array(account) }).strict(),
    /** The expenses a production overhead may come from, by prefix, and those it may not. */
    overheads: z
      .object({
        allowed: z.array(z.string().regex(/^6\d{1,3}$/)).min(1),
        excluded: z.array(z.string().regex(/^6\d{1,3}$/)),
      })
      .strict(),
  })
  .strict();
export type ProductionAccounts = z.infer<typeof productionAccounts>;

const productionCosting = z
  .object({
    /** The cost methods `policy.production.cost` may choose: the standard cost (pct. 286
     * alin. (1)–(2)) or the actual production cost (pct. 8 pct. 7). */
    methods: z.array(z.enum(['standard', 'actual'])).min(1),
    /** The work in progress of an order open at the period's end: `accumulated`, the costs the
     * order gathered less its products at their registration price; `completion`, the units the
     * count finds in progress times their degree of completion times the standard unit cost. */
    wip: z.enum(['accumulated', 'completion']),
  })
  .strict();
export type ProductionCosting = z.infer<typeof productionCosting>;

const productionCoefficient = z
  .object({
    /** `year`: the year's opening balances with the entries and exits cumulated from the
     * financial year's start (pct. 286 alin. (4)); `month`: the month's own. */
    basis: z.enum(['year', 'month']),
  })
  .strict();
export type ProductionCoefficient = z.infer<typeof productionCoefficient>;

export const productionDefinitions: ParameterDefinition[] = [
  {
    key: 'ro.production.accounts',
    axis: 'accounting_transaction_date',
    continuity: 'block',
    scope: [],
    value: productionAccounts,
    description:
      'Conturile producției: producția în curs (331), produsele (341, 345, 346), diferențele de preț (348), variația stocurilor (711), conturile materialelor date pe comenzi, manopera directă (641 și contribuția angajatorului, 646) și cheltuielile care pot fi regie de producție (OMFP nr. 1.802/2014 pct. 8 pct. 7, pct. 79 și funcțiunile grupelor 33, 34 și 71).',
  },
  {
    key: 'ro.production.costing',
    axis: 'accounting_transaction_date',
    continuity: 'block',
    scope: [],
    value: productionCosting,
    description:
      'Metodele de calcul al costului produselor pe care politicile contabile le pot alege (costul standard sau costul de producție efectiv) și evaluarea producției în curs a unei comenzi deschise la sfârșitul perioadei (OMFP nr. 1.802/2014 pct. 8 pct. 7, 286 alin. (1)–(3), 288).',
  },
  {
    key: 'ro.production.coefficient',
    axis: 'accounting_transaction_date',
    continuity: 'block',
    scope: [],
    value: productionCoefficient,
    description:
      'Perioada coeficientului de repartizare a diferențelor de preț la produse (348) asupra ieșirilor: cumulat de la începutul exercițiului sau pe lună (OMFP nr. 1.802/2014 pct. 286 alin. (4)–(7)).',
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

const OMFPA = (clause: string) => `OMFP1802/2014-A:${clause}`;

/** As read on 5 November 2026 in the consolidation of OMFP nr. 1.802/2014. */
export const productionVersions: ParameterVersion[] = [
  version(
    'ro.production.accounts',
    {
      wip: '331',
      variation: '711',
      products: ['341', '345', '346'],
      residual: '346',
      differences: '348',
      materials: ['301', '302', '303', '381'],
      // Direct labour (manoperă directă, pct. 8 pct. 7): the salary and the employer's work
      // insurance contribution on it (646, OMFP nr. 1.243/2018), the reading under review.
      labour: { salary: '641', contributions: ['646'] },
      // The operating expenses of groups 60–64 and the depreciation of fixed assets may be
      // production overheads (regia fixă: amortizarea, întreținerea secțiilor; regia variabilă:
      // materialele indirecte, pct. 8 pct. 7); the cost of goods sold (607) and the discounts
      // received (609) never are; other operating, financial and extraordinary expenses are not
      // production costs (pct. 79; borrowing costs only for long-cycle assets, pct. 80, not
      // built).
      overheads: { allowed: ['60', '61', '62', '63', '64', '6811'], excluded: ['607', '609'] },
    },
    [
      OMFPA('pct.8(7)'),
      OMFPA('pct.79'),
      OMFPA('conturi.331-332'),
      OMFPA('conturi.341-346'),
      OMFPA('conturi.348'),
      OMFPA('conturi.711-712'),
      OMFPA('pct.593(4)'),
    ],
  ),
  // The standard cost is allowed in production (pct. 286 alin. (1)); the actual cost is the
  // production cost of pct. 8 pct. 7. The work in progress of a job order is its costs less its
  // products (pct. 288 values it at the production costs, by the count): the reading under review.
  version('ro.production.costing', { methods: ['standard', 'actual'], wip: 'accumulated' }, [
    OMFPA('pct.8(7)'),
    OMFPA('pct.286(1)-(3)'),
    OMFPA('pct.288'),
    OMFPA('pct.435(1)(b)'),
  ]),
  version('ro.production.coefficient', { basis: 'year' }, [
    OMFPA('pct.286(4)-(8)'),
    OMFPA('conturi.348'),
  ]),
];

/** The policy axis production reads, with its values (`profile.record`). */
export const productionPolicyAxes = {
  'policy.production.cost': ['standard', 'actual'],
} as const;
