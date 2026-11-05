/*
 * How the tax bridge treats each account of classes 6 and 7 (OMFP nr. 1.802/2014 chart), by
 * its nature: what the general rules of the Codul fiscal (art. 19 alin. (1), art. 25 alin. (1))
 * make of it, what the law limits or refuses by the account's nature, and the accounts whose
 * treatment depends on facts the books do not hold (protocol or advertising, a fine or a
 * contractual penalty, a sponsorship): those a person classifies (`profit.account`), and the
 * bridge never guesses. Analytic accounts (`623.PROT`) take their synthetic account's nature
 * unless classified themselves.
 */

/** What an account is for the bridge. */
export type AccountNature =
  /** A revenue taxed as booked (art. 19 alin. (1)). */
  | 'taxable'
  /** An expense deductible as booked: made for the business (art. 25 alin. (1)). */
  | 'deductible'
  /** Profit tax (691): not deductible, rd. 23 (art. 25 alin. (4) lit. a)). */
  | 'profit_tax'
  /** Depreciation of fixed assets (6811): added back, rd. 28; fiscal depreciation is deducted
   * instead, rd. 11 (art. 28 alin. (17)). */
  | 'depreciation'
  /** The value of assets disposed of (6583): added back with the accounting depreciation, rd.
   * 28; the fiscal value left is deducted, rd. 11 (art. 28 alin. (17); OPANAF nr. 206/2025). */
  | 'asset_disposal'
  /** Provisions and impairment adjustments: not deductible, rd. 29, unless art. 26 allows them
   * (a determination states which). */
  | 'provision'
  /** Their reversal: taxable, unless the provision was not deducted (art. 23 lit. d), a
   * determination). */
  | 'provision_reversal'
  /** Salaries (641): the base of the social expenses' limit (art. 25 alin. (3) lit. b)). */
  | 'salaries'
  /** Deductibility depends on facts: a person classifies the account. */
  | 'classify';

/** The classification a person gives an account whose treatment depends on facts. */
export const accountClassifications = [
  /** Protocol: deductible within the limit of art. 25 alin. (3) lit. a); the excess is rd. 26. */
  'protocol',
  /** Advertising and publicity: deductible (norme pct. 13 alin. (1) lit. a)). */
  'advertising',
  /** Social expenses: deductible within the limit of art. 25 alin. (3) lit. b); the excess is
   * rd. 33. */
  'social',
  /** Late-payment interest, fines, confiscations and penalties owed to Romanian or foreign
   * authorities: not deductible, rd. 25 (art. 25 alin. (4) lit. b)). */
  'fine',
  /** Penalties and damages under contracts in the course of business: deductible (norme pct. 13
   * alin. (1) lit. j)). */
  'contract_penalty',
  /** Sponsorship under Legea nr. 32/1994: added back, rd. 27, and deducted from the tax within
   * the limits of art. 25 alin. (4) lit. i), rd. 43. */
  'sponsorship',
  /** Costs of a road vehicle (`vehicle`): what art. 25 alin. (3) lit. l) limits depends on the
   * answer about its use (`vehicle.use`). */
  'vehicle',
  /** Deductible: made for the business (art. 25 alin. (1)). */
  'deductible',
  /** Not deductible (art. 25 alin. (4), the letter given): rd. 33. */
  'nondeductible',
  /** Dividends from a Romanian legal person: not taxable, rd. 17.1 (art. 23 lit. a)). */
  'dividend_ro',
  /** Other revenue art. 23 makes non-taxable (the letter given): rd. 20. */
  'nontaxable',
  /** Taxable revenue. */
  'taxable',
] as const;
export type AccountClassification = (typeof accountClassifications)[number];

/** What a classification may be given to: an expense's or a revenue's. */
export const expenseClassifications: readonly AccountClassification[] = [
  'protocol',
  'advertising',
  'social',
  'fine',
  'contract_penalty',
  'sponsorship',
  'vehicle',
  'deductible',
  'nondeductible',
];
export const revenueClassifications: readonly AccountClassification[] = [
  'dividend_ro',
  'nontaxable',
  'taxable',
];

/** The accounts by prefix, the longest prefix deciding, with the clause behind each nature. */
const natures: readonly [prefix: string, nature: AccountNature, clause: string][] = [
  ['6', 'deductible', 'art.25(1)'],
  ['7', 'taxable', 'art.19(1)'],
  // Protocol, advertising and publicity share 623 in the chart.
  ['623', 'classify', 'art.25(3)(a)'],
  ['641', 'salaries', 'art.25(2)'],
  // Benefits in kind and vouchers: meal and holiday vouchers (lit. c)), gift vouchers (social).
  ['642', 'classify', 'art.25(3)(b)-(c)'],
  // Voluntary pension and health insurance, other social protection (the employer-share policy
  // may book contributions here).
  ['6456', 'classify', 'art.25(3)(b)'],
  ['6457', 'classify', 'art.25(3)(b)'],
  ['6458', 'classify', 'art.25(3)(b)'],
  // Receivables written off: deductible only in the cases of art. 25 alin. (4) lit. h).
  ['654', 'classify', 'art.25(4)(h)'],
  ['6581', 'classify', 'art.25(4)(b)'],
  ['6582', 'classify', 'art.25(4)(i)'],
  ['6583', 'asset_disposal', 'art.28(17)'],
  ['6587', 'classify', 'art.25(4)(c)'],
  ['6588', 'classify', 'art.25(1)'],
  ['668', 'classify', 'art.25(1)'],
  ['6811', 'depreciation', 'art.28(17)'],
  ['6812', 'provision', 'art.26(1)'],
  ['6813', 'provision', 'art.26(1)'],
  ['6814', 'provision', 'art.26(1)'],
  ['6817', 'provision', 'art.26(1)'],
  ['6863', 'provision', 'art.26(1)'],
  ['6864', 'provision', 'art.26(1)'],
  ['691', 'profit_tax', 'art.25(4)(a)'],
  // Other taxes (the micro-enterprise tax, foreign taxes): what they are decides.
  ['698', 'classify', 'art.25(4)(a)'],
  ['761', 'classify', 'art.23(a)'],
  ['781', 'provision_reversal', 'art.23(d)'],
  ['786', 'provision_reversal', 'art.23(d)'],
];

/** The nature of an account, by its synthetic code's longest prefix in the table. */
export function natureOf(account: string): { nature: AccountNature; clause: string } {
  const synthetic = account.split('.')[0]!;
  let found: (typeof natures)[number] | undefined;
  for (const entry of natures)
    if (synthetic.startsWith(entry[0]) && (!found || entry[0].length > found[0].length))
      found = entry;
  if (!found) throw new Error(`Account ${account} is not an expense or revenue account.`);
  return { nature: found[1], clause: `ANAF/Cod-fiscal-consolidat:${found[2]}` };
}

/** Financial revenue (rd. 4) and expenses (rd. 5); the rest is operating (rd. 1, rd. 2), the
 * profit tax included in rd. 2 (OPANAF nr. 206/2025, instrucțiuni pct. 8). */
export const isFinancial = (account: string) => /^(76|786|66|686)/.test(account);
