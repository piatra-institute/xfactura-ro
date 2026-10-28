import { z } from 'zod';
import {
  correctionBodySchema,
  generalBodySchema,
  dateSchema,
  accountCodeSchema,
  idSchema,
  lineSchema,
  openingSchema,
  purchaseSchema,
  accrualAdjustmentSchema,
} from './domain';
import { monthSchema } from './reviews';
import { invoiceDocumentSchema } from './invoice-document';

// Output money has no transformation: generated schemas describe the actual wire format.
export const decimalString = z.string().regex(/^-?\d+\.\d{2}$/);
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const emptySchema = z.object({}).strict();
export const recordIdSchema = z.object({ id: idSchema }).strict();
export const companyOutput = z.object({
  id: idSchema,
  name: z.string(),
  cui: z.string(),
  year: z.number().int(),
  createdBy: z.string(),
  createdAt: z.string(),
});
export const evidenceOutput = z.object({
  id: idSchema,
  companyId: idSchema,
  hash: hashSchema,
  filename: z.string(),
  mediaType: z.string(),
  size: z.number().int(),
  createdBy: z.string(),
  createdAt: z.string(),
});
export const proposalOutput = z.object({
  id: idSchema,
  companyId: idSchema,
  factId: idSchema,
  kind: z.enum(['opening', 'purchase', 'correction', 'general']),
  version: z.number().int(),
  hash: hashSchema,
  body: z.union([openingSchema, purchaseSchema, correctionBodySchema, generalBodySchema]),
  sourceKey: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
});
export const proposalView = proposalOutput.extend({
  approved: z.boolean(),
  posted: z.boolean(),
  withdrawn: z.boolean(),
  superseded: z.boolean(),
  lines: z.array(lineSchema),
});
export const approvalOutput = z.object({
  id: idSchema,
  companyId: idSchema,
  proposalId: idSchema,
  version: z.number().int(),
  hash: hashSchema,
  createdBy: z.string(),
  createdAt: z.string(),
});
export const postingOutput = z.object({ id: idSchema, number: z.number().int() });
export const journalOutput = z.object({
  id: idSchema,
  companyId: idSchema,
  number: z.number().int(),
  date: z.string(),
  kind: z.enum(['opening', 'purchase', 'payment', 'correction', 'general']),
  sourceId: idSchema,
  approvalId: idSchema.nullable(),
  evidenceId: idSchema,
  description: z.string(),
  lines: z.array(lineSchema),
  createdBy: z.string(),
  createdAt: z.string(),
});
export const periodOutput = z.object({
  companyId: idSchema,
  month: monthSchema,
  closedAt: z.string().nullable(),
  closedBy: z.string().nullable(),
});
export const balanceOutput = z.object({
  account: z.string(),
  debit: decimalString,
  credit: decimalString,
  balance: decimalString,
});
export const yearOutput = z.object({
  id: idSchema,
  companyId: idSchema,
  kind: z.enum(['financial', 'fiscal']),
  label: z.string(),
  from: dateSchema,
  to: dateSchema,
  createdBy: z.string(),
  createdAt: z.string(),
});
export const accountOutput = z.object({
  companyId: idSchema,
  code: accountCodeSchema,
  name: z.string(),
  parentCode: accountCodeSchema.nullable(),
  balance: z.enum(['debit', 'credit', 'both']),
  book: z.enum(['general', 'off_balance', 'management']),
  postable: z.boolean(),
  chartVersion: z.string(),
  validFrom: dateSchema,
  createdBy: z.string(),
  createdAt: z.string(),
});
export const regimeOutput = z.object({
  id: idSchema,
  companyId: idSchema,
  axis: z.enum(['vat', 'income_tax', 'eu_vat', 'vat_collection']),
  value: z.string(),
  effectiveFrom: dateSchema,
  evidenceId: idSchema,
  createdBy: z.string(),
  createdAt: z.string(),
});
export const ledgerBalanceOutput = z.object({
  financialYear: yearOutput,
  from: dateSchema,
  to: dateSchema,
  balances: z.array(
    z.object({
      account: accountCodeSchema,
      opening: decimalString,
      debit: decimalString,
      credit: decimalString,
      closing: decimalString,
    }),
  ),
});
export const policyOutput = z.object({
  id: idSchema,
  companyId: idSchema,
  key: z.string(),
  version: z.number().int(),
  effectiveFrom: dateSchema,
  title: z.string(),
  body: z.record(z.string(), z.json()),
  evidenceId: idSchema,
  createdBy: z.string(),
  createdAt: z.string(),
});
export const invoiceOutput = z.object({
  id: idSchema,
  companyId: idSchema,
  evidenceId: idSchema,
  direction: z.enum(['purchase', 'sale']),
  sourceKey: hashSchema,
  hash: hashSchema,
  body: invoiceDocumentSchema,
  createdBy: z.string(),
  createdAt: z.string(),
});
export const positionOutput = z.object({
  invoiceId: idSchema,
  number: z.string(),
  direction: z.enum(['purchase', 'sale']),
  date: dateSchema,
  issueDate: dateSchema,
  recognitionDate: dateSchema,
  currency: z.string(),
  counterparty: z.object({ name: z.string(), taxId: z.string(), country: z.string() }),
  originalJournalId: idSchema,
  gross: decimalString,
  credited: decimalString,
  settled: decimalString,
  balance: decimalString,
  status: z.enum(['open', 'settled', 'refund_due']),
  hash: hashSchema,
});
export const treasuryAccountOutput = z.object({
  companyId: idSchema,
  identifier: z.string(),
  kind: z.enum(['bank', 'cash']),
  currency: z.literal('RON'),
  ledgerAccount: accountCodeSchema,
  openedOn: dateSchema,
  evidenceId: idSchema.nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
});
export const accrualPositionOutput = z.object({
  id: idSchema,
  reference: z.string(),
  date: dateSchema,
  financialYearId: idSchema,
  journalId: idSchema,
  evidenceId: idSchema,
  supplier: z.object({ name: z.string(), taxId: z.string(), country: z.literal('RO') }),
  serviceFrom: dateSchema,
  serviceTo: dateSchema,
  net: decimalString,
  tax: decimalString,
  gross: decimalString,
  deferredTax: decimalString,
  adjustedNet: decimalString,
  adjustedTax: decimalString,
  adjustedGross: decimalString,
  adjustedDeferredTax: decimalString,
  adjustmentCount: z.number().int(),
  remainingNet: decimalString,
  remainingTax: decimalString,
  remainingGross: decimalString,
  remainingDeferredTax: decimalString,
  matchedGross: decimalString,
  status: z.enum(['open', 'matched', 'released']),
  hash: hashSchema,
});
export const accrualAdjustmentOutput = z.object({
  id: idSchema,
  journalId: idSchema,
  proposalHash: hashSchema,
  treatment: accrualAdjustmentSchema,
  createdAt: z.string(),
});
const accrualControlOutput = z.object({
  ledger: decimalString,
  unbilled: decimalString,
  difference: decimalString,
});
export const accrualReconcileOutput = z.object({
  financialYearId: idSchema,
  date: dateSchema,
  accrualCount: z.number().int(),
  liability: accrualControlOutput,
  vatAwaitingInvoice: accrualControlOutput,
  status: z.enum(['reconciled', 'needs_review']),
});
export const unbilledSalePositionOutput = z.object({
  id: idSchema,
  reference: z.string(),
  date: dateSchema,
  financialYearId: idSchema,
  journalId: idSchema,
  evidenceId: idSchema,
  customer: z.object({ name: z.string(), taxId: z.string(), country: z.literal('RO') }),
  serviceFrom: dateSchema,
  serviceTo: dateSchema,
  taxPointDate: dateSchema,
  net: decimalString,
  tax: decimalString,
  gross: decimalString,
  remainingNet: decimalString,
  remainingTax: decimalString,
  remainingGross: decimalString,
  matchedGross: decimalString,
  status: z.enum(['open', 'matched']),
  hash: hashSchema,
});
export const unbilledSaleReconcileOutput = z.object({
  financialYearId: idSchema,
  date: dateSchema,
  unbilledSaleCount: z.number().int(),
  receivable: accrualControlOutput,
  status: z.enum(['reconciled', 'needs_review']),
});
export const deferralPositionOutput = z.object({
  id: idSchema,
  invoiceId: idSchema,
  number: z.string(),
  direction: z.enum(['purchase', 'sale']),
  date: dateSchema,
  financialYearId: idSchema,
  journalId: idSchema,
  evidenceId: idSchema,
  invoiceEvidenceId: idSchema,
  account: accountCodeSchema,
  controlAccount: z.enum(['471', '472']),
  serviceFrom: dateSchema,
  serviceTo: dateSchema,
  amount: decimalString,
  allocated: decimalString,
  cancelled: decimalString,
  remaining: decimalString,
  status: z.enum(['open', 'allocated', 'cancelled']),
  cancellation: z
    .object({
      creditInvoiceId: idSchema,
      journalId: idSchema,
      date: dateSchema,
      from: dateSchema,
      to: dateSchema,
      amount: decimalString,
    })
    .nullable(),
  nextDueMonth: dateSchema.nullable(),
  schedule: z
    .array(
      z.object({
        month: dateSchema,
        date: dateSchema,
        amount: decimalString,
        journalId: idSchema.nullable(),
        cancellationJournalId: idSchema.nullable(),
        status: z.enum(['scheduled', 'posted', 'not_required', 'cancelled']),
      }),
    )
    .min(1)
    .max(60),
  hash: hashSchema,
});
const deferralControlOutput = z.object({
  ledger: decimalString,
  remaining: decimalString,
  difference: decimalString,
});
export const deferralReconcileOutput = z.object({
  financialYearId: idSchema,
  date: dateSchema,
  deferralCount: z.number().int(),
  dueCount: z.number().int(),
  prepaid: deferralControlOutput,
  deferredRevenue: deferralControlOutput,
  status: z.enum(['reconciled', 'needs_review']),
});
export const advancePaymentOutput = z.object({
  id: idSchema,
  movementId: idSchema,
  journalId: idSchema,
  financialYearId: idSchema,
  date: dateSchema,
  direction: z.enum(['purchase', 'sale']),
  counterparty: z.object({ name: z.string(), taxId: z.string(), country: z.literal('RO') }),
  net: decimalString,
  tax: decimalString,
  gross: decimalString,
  controlAccount: z.enum(['4092', '419']),
  controlAmount: decimalString,
  serviceExpectedOn: dateSchema,
  evidenceId: idSchema,
  remainingGross: decimalString,
  remainingControl: decimalString,
  invoiceId: idSchema.nullable(),
  refundJournalId: idSchema.nullable(),
  status: z.enum(['open', 'invoiced', 'refunded']),
  hash: hashSchema,
});
export const advancePositionOutput = z.object({
  invoiceId: idSchema,
  number: z.string(),
  journalId: idSchema,
  financialYearId: idSchema,
  date: dateSchema,
  direction: z.enum(['purchase', 'sale']),
  account: accountCodeSchema,
  controlAccount: z.enum(['4092', '419']),
  net: decimalString,
  tax: decimalString,
  gross: decimalString,
  controlAmount: decimalString,
  usedNet: decimalString,
  creditedNet: decimalString,
  remainingNet: decimalString,
  remainingTax: decimalString,
  remainingGross: decimalString,
  remainingControl: decimalString,
  invoiceBalance: decimalString,
  serviceExpectedOn: dateSchema,
  evidenceId: idSchema,
  status: z.enum(['open', 'used', 'cancelled']),
  hash: hashSchema,
});
export const advanceReconcileOutput = z.object({
  financialYearId: idSchema,
  date: dateSchema,
  paymentCount: z.number().int(),
  invoiceCount: z.number().int(),
  supplier: z.object({
    ledger: decimalString,
    remaining: decimalString,
    difference: decimalString,
  }),
  customer: z.object({
    ledger: decimalString,
    remaining: decimalString,
    difference: decimalString,
  }),
  status: z.enum(['reconciled', 'needs_review']),
});
export const movementOutput = z.object({
  id: idSchema,
  companyId: idSchema,
  bankAccount: z.string(),
  sourceId: z.string(),
  date: z.string(),
  amount: decimalString,
  reference: z.string(),
  matched: z.boolean(),
});
export const statementOutput = z.object({
  id: idSchema,
  companyId: idSchema,
  evidenceId: idSchema,
  bankAccount: z.string(),
  sourceId: z.string(),
  periodFrom: z.string(),
  periodTo: z.string(),
  opening: decimalString,
  closing: decimalString,
  hash: hashSchema,
  createdAt: z.string(),
});
export const jobOutput = z.object({
  id: idSchema,
  status: z.enum(['pending', 'running', 'done', 'failed']),
  result: z.object({ hash: hashSchema, size: z.number().int() }).nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
});
export const matchEffect = z.object({
  kind: z.literal('bank.match'),
  date: z.string(),
  movement: z.object({
    id: idSchema,
    bankAccount: z.string(),
    amount: decimalString,
    reference: z.string(),
  }),
  purchase: z.object({
    id: idSchema,
    version: z.number().int(),
    hash: hashSchema,
    currentJournalId: idSchema,
    amount: decimalString,
    paid: decimalString,
  }),
  evidence: z.array(z.object({ id: idSchema, hash: hashSchema })),
  lines: z.array(lineSchema),
});
export const closeEffect = z.object({
  kind: z.literal('periods.close'),
  month: monthSchema,
  journalCount: z.number().int(),
  bankBalance: decimalString,
  cashBalance: decimalString.optional(),
  statementIds: z.array(idSchema),
  stateHash: hashSchema,
});
export const reviewOutput = z.object({
  id: idSchema,
  companyId: idSchema,
  operation: z.enum(['bank.match', 'periods.close']),
  input: z.json(),
  effect: z.discriminatedUnion('kind', [matchEffect, closeEffect]),
  hash: hashSchema,
  approvedBy: z.string().nullable(),
  approvedAt: z.string().nullable(),
  result: z.json().nullable(),
  executedAt: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
});
export const grantOutput = z.object({
  id: idSchema,
  companyId: idSchema,
  name: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.number().int(),
  revokedAt: z.number().int().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
});
export const pageInput = z
  .object({
    limit: z.number().int().min(1).max(100).default(25),
    cursor: z.string().max(100).optional(),
  })
  .strict();
export const pageOutput = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });
