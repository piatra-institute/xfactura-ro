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
 * accounts introduced later (e.g. 4315, 4316 and 436 for post-2018 payroll contributions) are
 * missing and must be added from their amending orders before payroll posts to them. */
export const referenceChart = {
  id: chart.id,
  source: chart.source,
  sourceSha256: chart.sourceSha256,
  accounts: chart.accounts as ChartAccount[],
};

/**
 * How the kernel controls each synthetic account: lines on an open-item account must name an
 * open item of that kind (receivable per customer, payable per supplier, liability per tax
 * period…); lines on a `tax` account must be explained by tax entries or mark a period
 * settlement. Analytical accounts inherit their synthetic parent's control. These are kernel
 * defaults subject to the same review as any rule package.
 */
const controls: Record<string, ControlKind> = {
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
  '457': 'payable',
  '461': 'receivable',
  '462': 'payable',
  '471': 'deferral.expense',
  '472': 'deferral.revenue',
};

/** The control kind of an account code, inherited from its synthetic prefix. */
export function controlKindOf(code: string): ControlKind | null {
  const synthetic = code.split('.')[0]!;
  return controls[synthetic] ?? null;
}
