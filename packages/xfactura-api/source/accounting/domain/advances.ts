import { z } from 'zod';
import { accountCodeSchema, dateSchema, idSchema, moneySchema } from './values';
import { creditNoteInput } from './settlements';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const party = z
  .object({
    name: z.string().trim().min(1).max(500),
    taxId: z
      .string()
      .trim()
      .regex(/^(RO)?[0-9]{2,10}$/i),
    country: z.literal('RO'),
  })
  .strict();
const terms = {
  evidenceId: idSchema,
  evidenceDate: dateSchema,
  reference: z.string().trim().min(1).max(100),
  serviceExpectedOn: dateSchema,
  reason: z.string().trim().min(10).max(1000),
};
export const advancePaymentInput = z
  .object({
    financialYearId: idSchema,
    movementId: idSchema,
    direction: z.enum(['purchase', 'sale']),
    counterparty: party,
    account: accountCodeSchema,
    net: moneySchema,
    vatCategory: z.enum(['S', 'O']),
    counterpartyVatCollection: z.literal('no'),
    ...terms,
  })
  .strict();
export const advanceInvoiceInput = z
  .object({
    financialYearId: idSchema,
    invoiceId: idSchema,
    recognitionDate: dateSchema,
    taxPointDate: dateSchema,
    account: accountCodeSchema,
    deduction: z.enum(['full', 'none']),
    counterpartyVatCollection: z.literal('no'),
    paymentIds: z.array(idSchema).max(100).default([]),
    paymentAllocations: z
      .array(z.object({ paymentId: idSchema, net: moneySchema }).strict())
      .min(1)
      .max(100)
      .optional(),
    ...terms,
  })
  .strict();
export const advanceFinalInput = z
  .object({
    financialYearId: idSchema,
    invoiceId: idSchema,
    recognitionDate: dateSchema,
    serviceDate: dateSchema,
    taxPointDate: dateSchema,
    treatmentEvidenceId: idSchema,
    account: accountCodeSchema,
    deduction: z.enum(['full', 'none']),
    counterpartyVatCollection: z.literal('no'),
    allocations: z
      .array(
        z
          .object({
            advanceInvoiceId: idSchema,
            lineId: z.string().min(1).max(100),
            net: moneySchema,
            tax: moneySchema,
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export const advanceCreditInput = creditNoteInput
  .extend({ kind: z.literal('cancellation') })
  .strict();
export const advanceRefundInput = z
  .object({
    financialYearId: idSchema,
    paymentId: idSchema,
    movementId: idSchema,
    evidenceId: idSchema,
    decisionDate: dateSchema,
    periodBasis: z.literal('current_period_event'),
    reason: z.string().trim().min(10).max(1000),
    net: moneySchema.optional(),
  })
  .strict();
const amounts = { net: moneySchema, tax: moneySchema, gross: moneySchema };
export const advancePaymentSchema = advancePaymentInput
  .omit({ financialYearId: true })
  .extend({
    schemaVersion: z.literal(1),
    date: dateSchema,
    taxPointDate: dateSchema,
    tax: moneySchema,
    gross: moneySchema,
    controlAmount: moneySchema,
    controlAccount: z.enum(['4092', '419']),
    ledgerAccount: accountCodeSchema,
    treasuryAccount: z.string(),
    movementHash: hash,
    sourceEvidenceId: idSchema,
    evidenceHash: hash,
    ruleId: z.string(),
    ruleHash: hash,
    registrationIds: z.array(idSchema).min(1).max(8),
  })
  .strict();
const match = z
  .object({
    paymentId: idSchema,
    movementId: idSchema,
    journalId: idSchema,
    financialYearId: idSchema,
    proposalHash: hash,
    stateHash: hash,
    ...amounts,
    allocation: z
      .object({
        requestedNet: moneySchema.nullable(),
        priorInvoiceCount: z.number().int().nonnegative(),
        priorRefundCount: z.number().int().nonnegative(),
        before: z.object(amounts).strict(),
        after: z.object(amounts).strict(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const advanceInvoiceSchema = z
  .object({
    schemaVersion: z.literal(1),
    ...terms,
    evidenceHash: hash,
    serviceAccount: accountCodeSchema,
    controlAccount: z.enum(['4092', '419']),
    amount: moneySchema,
    payments: z.array(match).max(100),
    previousOutputTax: moneySchema,
  })
  .strict();
export const advanceUseSchema = z
  .object({
    advanceInvoiceId: idSchema,
    lineId: z.string(),
    originalJournalId: idSchema,
    originalFinancialYearId: idSchema,
    originalProposalHash: hash,
    stateHash: hash,
    priorUseCount: z.number().int().min(0),
    priorCreditCount: z.number().int().min(0),
    availableNet: moneySchema,
    availableTax: moneySchema,
    availableGross: moneySchema,
    ...amounts,
    controlAmount: moneySchema,
  })
  .strict();
export const advanceFinalSchema = z
  .object({
    schemaVersion: z.literal(1),
    serviceNet: moneySchema,
    serviceTax: moneySchema,
    serviceGross: moneySchema,
    allocations: z.array(advanceUseSchema).min(1).max(100),
  })
  .strict();
export const advanceCreditSchema = z
  .object({
    schemaVersion: z.literal(1),
    stateHash: hash,
    priorUseCount: z.number().int().min(0),
    availableNet: moneySchema,
    availableTax: moneySchema,
    availableGross: moneySchema,
    controlAmount: moneySchema,
  })
  .strict();
export const advanceRefundSchema = advanceRefundInput
  .omit({ financialYearId: true, net: true })
  .extend({
    schemaVersion: z.literal(1),
    date: dateSchema,
    originalTaxPointDate: dateSchema,
    vatCategory: z.enum(['S', 'O']),
    paymentJournalId: idSchema,
    originalFinancialYearId: idSchema,
    paymentHash: hash,
    stateHash: hash,
    direction: z.enum(['purchase', 'sale']),
    controlAccount: z.enum(['4092', '419']),
    controlAmount: moneySchema,
    ...amounts,
    ledgerAccount: accountCodeSchema,
    treasuryAccount: z.string(),
    sourceEvidenceId: idSchema,
    movementHash: hash,
    evidenceHash: hash,
    ruleId: z.string(),
    ruleHash: hash,
    registrationIds: z.array(idSchema),
    refundBasis: z
      .object({
        requestedNet: moneySchema.nullable(),
        priorRefundCount: z.number().int().nonnegative(),
        priorRefundJournalId: idSchema.nullable(),
        priorRefundFinancialYearId: idSchema.nullable(),
        priorInvoiceCount: z.number().int().positive().optional(),
        priorInvoice: z
          .object({ invoiceId: idSchema, journalId: idSchema, financialYearId: idSchema })
          .strict()
          .optional(),
        before: z.object({ ...amounts, controlAmount: moneySchema }).strict(),
        after: z.object({ ...amounts, controlAmount: moneySchema }).strict(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type AdvancePaymentInput = z.infer<typeof advancePaymentInput>;
export type AdvanceInvoiceInput = z.infer<typeof advanceInvoiceInput>;
export type AdvanceFinalInput = z.infer<typeof advanceFinalInput>;
export type AdvanceCreditInput = z.infer<typeof advanceCreditInput>;
export type AdvanceRefundInput = z.infer<typeof advanceRefundInput>;
