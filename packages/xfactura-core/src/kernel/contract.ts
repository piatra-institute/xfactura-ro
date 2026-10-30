/*
 * The vocabulary operations and treatments describe themselves with to agents. The engine's
 * operation registry requires it on every operation; treatments carry their part of it so the
 * `<treatment>.propose` and `.revise` operations generated from them inherit it.
 */

/** The work an operation serves. Agents find operations by toolset and grants may name one. */
export const toolsets = [
  /** Bringing documents in: evidence, e-Factura and invoices, and proposing their bookings. */
  'inbox',
  /** Bank and cash: statements, movements, their settlement and the cash register. */
  'bank',
  /** The ledger: explicit entries, reversals, registers, assets, loans and issued invoices. */
  'books',
  /** Proposals and reviewed actions: reading, posting what a person approved, policies. */
  'review',
  /** Month and year end: close checks, revaluation, depreciation, accruals, result closing. */
  'close',
  /** Taxes and returns: VAT, micro and withholding taxes, declarations, ANAF's SPV and registers. */
  'tax',
  /** Employees, contracts and payroll runs. */
  'payroll',
  /** Company configuration, members, agent credentials, ANAF connection and exports. */
  'admin',
  /** Lookups the others rely on: capabilities, rules, rates, years, accounts, partners, profile. */
  'reference',
] as const;
export type Toolset = (typeof toolsets)[number];

/** The kinds of company data an operation reads or writes. */
export const dataClasses = [
  /** Accounting records: entries, proposals, documents, partners, registers. */
  'books',
  /** Original files and what was read from them. */
  'evidence',
  /** Identifying data about individuals beyond a partner's name: CNPs, members' emails. */
  'personal',
  /** Employees, employment terms and pay. */
  'payroll',
  /** Tax computations, returns and the company's standing with ANAF. */
  'tax',
  /** Access: invitations, agent credentials, the ANAF connection. */
  'credentials',
] as const;
export type DataClass = (typeof dataClasses)[number];
