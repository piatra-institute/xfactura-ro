import { z } from 'zod';
import { accountCodeSchema, dateSchema, idSchema, moneySchema, signedMoneySchema } from './values';

const accrualFields = {
  evidenceId: idSchema,
  evidenceDate: dateSchema,
  reference: z.string().trim().min(1).max(150),
  date: dateSchema,
  serviceFrom: dateSchema,
  serviceTo: dateSchema,
  supplier: z
    .object({
      name: z.string().trim().min(2).max(200),
      taxId: z.string().regex(/^\d{2,10}$/),
      country: z.literal('RO'),
    })
    .strict(),
  currency: z.literal('RON'),
  account: accountCodeSchema,
  net: moneySchema,
  vatCategory: z.enum(['S', 'O']),
  taxPointDate: dateSchema,
  deduction: z.enum(['full', 'none']),
  counterpartyVatCollection: z.literal('no'),
  reason: z.string().trim().min(10).max(1000),
};
export const accrualInput = z.object({ financialYearId: idSchema, ...accrualFields }).strict();
export const accrualTreatmentSchema = z
  .object({
    schemaVersion: z.literal(1),
    ...accrualFields,
    tax: moneySchema,
    gross: moneySchema,
    deferredTax: moneySchema,
    rate: z.string(),
    ruleId: z.string(),
    ruleHash: z.string().regex(/^[a-f0-9]{64}$/),
    registrationIds: z.array(idSchema).min(1).max(2),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const accrualInvoiceInput = z
  .object({
    financialYearId: idSchema,
    invoiceId: idSchema,
    recognitionDate: dateSchema,
    receivedDate: dateSchema,
    receiptEvidenceId: idSchema,
    allocations: z
      .array(z.object({ accrualId: idSchema, net: moneySchema, tax: moneySchema }).strict())
      .min(1)
      .max(100),
  })
  .strict();
export const accrualInvoiceMatchSchema = z
  .object({
    schemaVersion: z.literal(1),
    receivedDate: dateSchema,
    receiptEvidenceId: idSchema,
    allocations: z
      .array(
        z
          .object({
            accrualId: idSchema,
            originalJournalId: idSchema,
            originalFinancialYearId: idSchema,
            latestAdjustmentJournalId: idSchema.optional(),
            proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
            positionHash: z.string().regex(/^[a-f0-9]{64}$/),
            positionVersion: z.number().int().min(0),
            reference: z.string(),
            availableGross: moneySchema,
            remainingGross: moneySchema,
            net: moneySchema,
            tax: moneySchema,
            gross: moneySchema,
            deductibleTax: moneySchema,
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export type AccrualInput = z.infer<typeof accrualInput>;
export type AccrualTreatment = z.infer<typeof accrualTreatmentSchema>;
export type AccrualInvoiceInput = z.infer<typeof accrualInvoiceInput>;

const adjustmentFields = {
  accrualId: idSchema,
  reference: z.string().trim().min(1).max(150),
  evidenceId: idSchema,
  evidenceDate: dateSchema,
  newInformationDate: dateSchema,
  date: dateSchema,
  periodBasis: z.literal('current_year_estimate_change'),
  action: z.enum(['reestimate', 'release']),
  remainingNet: moneySchema,
  reason: z.string().trim().min(10).max(1000),
};
export const accrualAdjustmentInput = z
  .object({ financialYearId: idSchema, ...adjustmentFields })
  .strict();
export const accrualAmountsSchema = z
  .object({ net: moneySchema, tax: moneySchema, gross: moneySchema, deferredTax: moneySchema })
  .strict();
export const accrualDeltaSchema = z
  .object({
    net: signedMoneySchema,
    tax: signedMoneySchema,
    gross: signedMoneySchema,
    deferredTax: signedMoneySchema,
  })
  .strict();
export const accrualAdjustmentSchema = z
  .object({
    schemaVersion: z.literal(1),
    ...adjustmentFields,
    originalJournalId: idSchema,
    originalFinancialYearId: idSchema,
    originalProposalHash: z.string().regex(/^[a-f0-9]{64}$/),
    previousJournalId: idSchema,
    accrualReference: z.string(),
    positionHash: z.string().regex(/^[a-f0-9]{64}$/),
    positionVersion: z.number().int().min(0),
    account: accountCodeSchema,
    rate: z.string(),
    ruleId: z.string(),
    ruleHash: z.string().regex(/^[a-f0-9]{64}$/),
    registrationIds: z.array(idSchema).min(1).max(4),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    previousRemaining: accrualAmountsSchema,
    remaining: accrualAmountsSchema,
    delta: accrualDeltaSchema,
  })
  .strict();
export type AccrualAdjustmentInput = z.infer<typeof accrualAdjustmentInput>;
