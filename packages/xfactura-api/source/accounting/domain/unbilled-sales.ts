import { z } from 'zod';
import { accountCodeSchema, dateSchema, idSchema, moneySchema, signedMoneySchema } from './values';

const fields = {
  evidenceId: idSchema,
  evidenceDate: dateSchema,
  reference: z.string().trim().min(1).max(150),
  date: dateSchema,
  serviceFrom: dateSchema,
  serviceTo: dateSchema,
  customer: z
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
  taxPointBasis: z.literal('completed_service'),
  measurementBasis: z.literal('estimated_consideration').optional(),
  reason: z.string().trim().min(10).max(1000),
};
export const unbilledSaleInput = z.object({ financialYearId: idSchema, ...fields }).strict();
export const unbilledSaleTreatmentSchema = z
  .object({
    schemaVersion: z.literal(1),
    ...fields,
    tax: moneySchema,
    gross: moneySchema,
    rate: z.string(),
    ruleId: z.string(),
    ruleHash: z.string().regex(/^[a-f0-9]{64}$/),
    registrationIds: z.array(idSchema).min(1).max(2),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const unbilledSaleInvoiceInput = z
  .object({
    financialYearId: idSchema,
    invoiceId: idSchema,
    recognitionDate: dateSchema,
    allocations: z
      .array(z.object({ unbilledSaleId: idSchema, net: moneySchema, tax: moneySchema }).strict())
      .min(1)
      .max(100),
  })
  .strict();
export const unbilledSaleMatchSchema = z
  .object({
    schemaVersion: z.literal(1),
    allocations: z
      .array(
        z
          .object({
            unbilledSaleId: idSchema,
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
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export type UnbilledSaleInput = z.infer<typeof unbilledSaleInput>;
export type UnbilledSaleInvoiceInput = z.infer<typeof unbilledSaleInvoiceInput>;

const adjustmentFields = {
  unbilledSaleId: idSchema,
  reference: z.string().trim().min(1).max(150),
  evidenceId: idSchema,
  evidenceDate: dateSchema,
  newInformationDate: dateSchema,
  date: dateSchema,
  periodBasis: z.literal('current_year_estimate_change'),
  changeBasis: z.literal('new_measurement_information'),
  action: z.enum(['reestimate', 'release']),
  remainingNet: moneySchema,
  reason: z.string().trim().min(10).max(1000),
};
export const unbilledSaleAdjustmentInput = z
  .object({ financialYearId: idSchema, ...adjustmentFields })
  .strict();
export const unbilledSaleAmountsSchema = z
  .object({ net: moneySchema, tax: moneySchema, gross: moneySchema })
  .strict();
export const unbilledSaleAdjustmentSchema = z
  .object({
    schemaVersion: z.literal(1),
    ...adjustmentFields,
    originalJournalId: idSchema,
    originalFinancialYearId: idSchema,
    originalProposalHash: z.string().regex(/^[a-f0-9]{64}$/),
    previousJournalId: idSchema,
    serviceReference: z.string(),
    positionHash: z.string().regex(/^[a-f0-9]{64}$/),
    positionVersion: z.number().int().nonnegative(),
    account: accountCodeSchema,
    taxPointDate: dateSchema,
    taxTreatment: z.enum(['non_vat', 'same_service_month']),
    rate: z.string(),
    ruleId: z.string(),
    ruleHash: z.string().regex(/^[a-f0-9]{64}$/),
    registrationIds: z.array(idSchema).min(1).max(4),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    previousRemaining: unbilledSaleAmountsSchema,
    remaining: unbilledSaleAmountsSchema,
    delta: z
      .object({ net: signedMoneySchema, tax: signedMoneySchema, gross: signedMoneySchema })
      .strict(),
  })
  .strict();
export type UnbilledSaleAdjustmentInput = z.infer<typeof unbilledSaleAdjustmentInput>;
