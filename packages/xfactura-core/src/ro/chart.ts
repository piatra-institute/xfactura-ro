import type { ControlKind } from '../kernel';
import chart from './data/ro-chart.json';

export type ChartAccount = {
  code: string;
  name: string;
  balance: 'debit' | 'credit' | 'both';
  parentCode: string | null;
  postable: boolean;
  book: 'general' | 'off_balance' | 'management';
};

/** The OMFP 1802/2014 reference chart as published in 2014. It is not a reviewed consolidation:
 * accounts introduced later come from their amending orders (`chartAmendments`). */
export const referenceChart = {
  id: chart.id,
  source: chart.source,
  sourceSha256: chart.sourceSha256,
  accounts: chart.accounts as ChartAccount[],
};

/** Accounts later orders added to the chart, with the clause that adds them and the date from
 * which they are used. */
export const chartAmendments: readonly {
  clause: string;
  validFrom: string;
  accounts: readonly ChartAccount[];
}[] = [
  {
    clause: 'OMFP1243/2018:art.1,4',
    validFrom: '2018-01-01',
    accounts: [
      {
        code: '4315',
        name: 'Contribuția de asigurări sociale',
        balance: 'credit',
        parentCode: '431',
        postable: true,
        book: 'general',
      },
      {
        code: '4316',
        name: 'Contribuția de asigurări sociale de sănătate',
        balance: 'credit',
        parentCode: '431',
        postable: true,
        book: 'general',
      },
      {
        code: '436',
        name: 'Contribuția asiguratorie pentru muncă',
        balance: 'credit',
        parentCode: '43',
        postable: true,
        book: 'general',
      },
      {
        code: '646',
        name: 'Cheltuieli privind contribuția asiguratorie pentru muncă',
        balance: 'debit',
        parentCode: '64',
        postable: true,
        book: 'general',
      },
    ],
  },
  {
    // Interim dividends (OMFP nr. 3.067/2018, MO nr. 792 of 17.09.2018): distributed during the
    // year as 463 = 456, regularized against the annual dividends as 457 = 463.
    clause: 'OMFP3067/2018:pct.423^1-423^2',
    validFrom: '2018-09-17',
    accounts: [
      {
        code: '463',
        name: 'Creanțe reprezentând dividende repartizate în cursul exercițiului financiar',
        balance: 'debit',
        parentCode: '46',
        postable: true,
        book: 'general',
      },
    ],
  },
];

/**
 * How the kernel controls each synthetic account: lines on an open-item account must name an
 * open item of that kind (receivable per customer, payable per supplier, liability per tax
 * period…); lines on a `tax` account must be explained by tax entries or mark a period
 * settlement. Analytical accounts inherit their synthetic parent's control. These are kernel
 * defaults subject to the same review as any rule package.
 */
const controls: Record<string, ControlKind> = {
  // Loans by lender and contract (OMFP 1802/2014, the functions of accounts 162, 166, 167 and
  // 519): long-term bank credits, those overdue, debts to affiliated and associated entities,
  // other loans and a finance lease's liability, short-term bank credits; their interest due and
  // unpaid (168x, 5198).
  '1621': 'loan.payable',
  '1622': 'loan.payable',
  '1661': 'loan.payable',
  '1663': 'loan.payable',
  '167': 'loan.payable',
  '1682': 'loan.interest',
  '1685': 'loan.interest',
  '1686': 'loan.interest',
  '1687': 'loan.interest',
  '5191': 'loan.payable',
  '5192': 'loan.payable',
  '5198': 'loan.interest',
  '401': 'payable',
  '404': 'payable',
  '408': 'accrual.payable',
  '4091': 'advance.paid',
  '4092': 'advance.paid',
  '4111': 'receivable',
  '418': 'accrual.receivable',
  '419': 'advance.received',
  '421': 'employee.payable',
  '423': 'employee.payable',
  '426': 'employee.payable',
  '427': 'employee.payable',
  '4311': 'tax.payable',
  '4312': 'tax.payable',
  '4313': 'tax.payable',
  '4314': 'tax.payable',
  '4315': 'tax.payable',
  '4316': 'tax.payable',
  '436': 'tax.payable',
  '4371': 'tax.payable',
  '4372': 'tax.payable',
  '4411': 'tax.payable',
  '4418': 'tax.payable',
  '4423': 'tax.payable',
  '4424': 'tax.receivable',
  '4426': 'tax',
  '4427': 'tax',
  '4428': 'tax',
  '444': 'tax.payable',
  '446': 'tax.payable',
  '447': 'tax.payable',
  // Other debts to and claims on the state budget (OMFP 1802/2014, the functions of account
  // 448): fines, penalties and interest owed (4481), and what the budget owes back, a payment to
  // the single account not yet distributed among them included (4482). Per authority, like the
  // taxes.
  '4481': 'tax.payable',
  '4482': 'tax.receivable',
  // Associates' current accounts and interest on them: per associate, normally owed to them.
  '4551': 'payable',
  '4558': 'payable',
  // The associates' capital settlements (456), interim dividends owed to them included, and the
  // interim dividends distributed during the year (463, OMFP nr. 3.067/2018): per associate.
  '456': 'payable',
  '457': 'payable',
  '461': 'receivable',
  '462': 'payable',
  '463': 'receivable',
  '471': 'deferral.expense',
  '472': 'deferral.revenue',
  // Treasury advances: per person, owed back until their expense report settles them.
  '542': 'receivable',
};

/** The control kind of an account code, inherited from its synthetic prefix. */
export function controlKindOf(code: string): ControlKind | null {
  const synthetic = code.split('.')[0]!;
  return controls[synthetic] ?? null;
}
