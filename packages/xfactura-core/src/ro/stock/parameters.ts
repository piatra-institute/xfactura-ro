import { z } from 'zod';
import { stockAccountSynthetics } from '../../kernel';
import type { ParameterDefinition, ParameterVersion } from '../../rules';
import { parseLocalDate as date } from '../../time';

/*
 * The stock register's accounts and methods (G1, docs/ACCOUNTING_ENGINE.md): which accounts hold
 * stock by quantity, what an exit is expensed to, where a write-down, a difference at receipt and
 * a difference at the count go, and which output methods a company may choose. Every value is
 * read in OMFP nr. 1.802/2014, its 2014 text and the legislative portal's consolidation (to 1
 * February 2022), which words the stock rules (pct. 95–96, 272–292) and the functions of the
 * accounts of classes 3 and 6 alike but for pct. 276; it is `extracted`, and the readings the text leaves open are the expert's
 * (src/ro/reviews/specs/stock.ts). Amendments after the consolidation are not verified, so the
 * versions run from 2026, reviewed through its end.
 */

const account = z.string().regex(/^[1-8]\d{2,3}$/);
const byPrefix = z
  .array(z.object({ prefix: z.string().regex(/^3\d{2,3}$/), account }).strict())
  .min(1)
  .max(30);

const stockAccounts = z
  .object({
    /** The synthetic accounts the register explains by quantity (the kernel's
     * `stockAccountSynthetics`; a test keeps the two equal). */
    quantity: z.array(z.string().regex(/^3\d{2}$/)).min(1),
    /** The accounts whose items the treatments cover: materials (30x), goods (371), packaging
     * (381). Production (33x, 34x), stock held by third parties (35x) and biological assets (36x)
     * are kept by quantity but booked by no treatment yet. */
    covered: z.array(z.string().regex(/^3\d{2}$/)).min(1),
    /** What an exit is expensed to, by the stock account's prefix (the longest that matches): a
     * consumption, a sale's cost, a shortage at the count (the functions of 601–608). */
    expense: byPrefix,
    /** The write-down allowance by the stock account's prefix (group 39), its expense and its
     * reversal (pct. 292; the functions of 39x, 6814, 7814). */
    impairment: z.object({ allowances: byPrefix, expense: account, revenue: account }).strict(),
    /** Goods received without their invoice, held against the supplier until it comes (pct. 284
     * alin. (2) lit. b); the function of 408); a shortage at receipt the supplier answers for, a
     * claim on it (the function of 461). */
    receipt: z.object({ uninvoiced: account, shortage: account }).strict(),
    /** A surplus found at a count: credited to the stock account's own expense (null; the
     * functions of 371, 30x and 381 name 607, 601–603 and 608) or to this revenue. */
    count: z.object({ surplus: account.nullable() }).strict(),
    /** The retail method (pct. 286 alin. (8); the functions of 371, 378 and 4428): the goods'
     * markup and the VAT included in their sale price. */
    retail: z.object({ markup: account, vat: account }).strict(),
  })
  .strict();
export type StockAccounts = z.infer<typeof stockAccounts>;

/** The output methods a company's policy may choose (pct. 96 alin. (1)–(4)). */
const stockMethods = z
  .object({
    /** The methods the text allows, as `policy.stock.valuation` names them. */
    allowed: z.array(z.enum(['fifo', 'lifo', 'average', 'periodic'])).min(1),
    /** The longest period a periodic average is computed over, in months; the text bounds it
     * by the average storage time (pct. 96 alin. (2)), which the engine does not know. */
    periodMonths: z.number().int().min(1).max(12),
  })
  .strict();
export type StockMethods = z.infer<typeof stockMethods>;

export const stockDefinitions: ParameterDefinition[] = [
  {
    key: 'ro.stock.accounts',
    axis: 'accounting_transaction_date',
    continuity: 'block',
    scope: [],
    value: stockAccounts,
    description:
      'Conturile stocurilor ținute pe cantități, cheltuiala ieșirilor pe conturi, ajustările pentru depreciere (39x), bunurile sosite fără factură (408), lipsurile la recepție imputabile furnizorului (461) și metoda prețului cu amănuntul (378, 4428) (OMFP nr. 1.802/2014 pct. 276, 284, 286, 292 și funcțiunile conturilor din clasele 3 și 6).',
  },
  {
    key: 'ro.stock.methods',
    axis: 'accounting_transaction_date',
    continuity: 'block',
    scope: [],
    value: stockMethods,
    description:
      'Metodele de evaluare a ieșirilor din gestiune pe care politicile contabile le pot alege: CMP după fiecare recepție sau periodic, FIFO, LIFO (OMFP nr. 1.802/2014 pct. 96 alin. (1)–(4)), și perioada costului mediu periodic.',
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
const OMFPA = (clause: string) => `OMFP1802/2014-A:${clause}`;

/** As read on 5 November 2026 in both texts of OMFP nr. 1.802/2014. */
export const stockVersions: ParameterVersion[] = [
  version(
    'ro.stock.accounts',
    {
      quantity: [...stockAccountSynthetics],
      covered: ['301', '302', '303', '371', '381'],
      // Consumption, sale and shortage: each stock account's expense of group 60 (601 "valoarea
      // ... incluse pe cheltuieli, constatate lipsă la inventar"; 607 "valoarea mărfurilor
      // vândute, constatate lipsă la inventar"; 608 likewise for packaging).
      expense: [
        { prefix: '301', account: '601' },
        { prefix: '3021', account: '6021' },
        { prefix: '3022', account: '6022' },
        { prefix: '3023', account: '6023' },
        { prefix: '3024', account: '6024' },
        { prefix: '3025', account: '6025' },
        { prefix: '3026', account: '6026' },
        { prefix: '3028', account: '6028' },
        { prefix: '303', account: '603' },
        { prefix: '371', account: '607' },
        { prefix: '381', account: '608' },
      ],
      impairment: {
        allowances: [
          { prefix: '301', account: '391' },
          { prefix: '302', account: '3921' },
          { prefix: '303', account: '3922' },
          { prefix: '371', account: '397' },
          { prefix: '381', account: '398' },
        ],
        expense: '6814',
        revenue: '7814',
      },
      receipt: { uninvoiced: '408', shortage: '461' },
      count: { surplus: null },
      retail: { markup: '378', vat: '4428' },
    },
    [
      OMFPA('pct.272-276'),
      OMFP('plan.clasa3'),
      OMFP('pct.283-284'),
      OMFP('pct.285-286'),
      OMFP('pct.289-292'),
      OMFP('conturi.30'),
      OMFP('conturi.371-378'),
      OMFP('conturi.381-388'),
      OMFP('conturi.39'),
      OMFP('conturi.408'),
      OMFP('conturi.4428'),
      OMFP('conturi.461'),
      OMFP('conturi.60'),
      OMFP('conturi.681'),
      OMFP('conturi.781'),
    ],
  ),
  // Pct. 96 alin. (1) names CMP, FIFO and LIFO; alin. (2) lets the average be computed
  // periodically or after each receipt, over a period no longer than the average storage time,
  // which the engine reads as a month (the spec asks the expert).
  version(
    'ro.stock.methods',
    { allowed: ['fifo', 'lifo', 'average', 'periodic'], periodMonths: 1 },
    [OMFPA('pct.95-96'), OMFP('pct.287')],
  ),
];

/** The account an exit from `stockAccount` is expensed to: the longest matching prefix. */
export function expenseFor(accounts: StockAccounts, stockAccount: string): string | null {
  const synthetic = stockAccount.split('.')[0]!;
  const match = accounts.expense
    .filter((row) => synthetic.startsWith(row.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  return match?.account ?? null;
}

/** The write-down allowance of `stockAccount`: the longest matching prefix. */
export function allowanceFor(accounts: StockAccounts, stockAccount: string): string | null {
  const synthetic = stockAccount.split('.')[0]!;
  const match = accounts.impairment.allowances
    .filter((row) => synthetic.startsWith(row.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  return match?.account ?? null;
}

/** Why an item cannot be kept on `account` yet; null when the treatments cover it. */
export function supportedItemAccount(account: string): string | null {
  const synthetic = account.split('.')[0]!.slice(0, 3);
  if (['301', '302', '303', '371', '381'].includes(synthetic)) return null;
  if (synthetic.startsWith('33') || synthetic.startsWith('34'))
    return 'Producția în curs și produsele (33x, 34x) se țin prin modulul de producție (G4), care nu există încă.';
  if (synthetic.startsWith('35'))
    return 'Stocurile aflate la terți (35x) nu sunt încă acoperite: transferul la terți și înapoi.';
  return 'Activele biologice de natura stocurilor (361) nu sunt încă acoperite.';
}
