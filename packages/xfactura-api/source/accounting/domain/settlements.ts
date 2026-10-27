import { z } from 'zod';
import { accountCodeSchema, dateSchema, idSchema, moneySchema, signedMoneySchema } from './values';

export const treasuryAccountInput = z
  .object({
    identifier: z.string().trim().min(4).max(50),
    kind: z.enum(['bank', 'cash']),
    currency: z.literal('RON'),
    ledgerAccount: accountCodeSchema,
    openedOn: dateSchema,
    evidenceId: idSchema,
  })
  .strict();
export const cashMovementInput = z
  .object({
    account: z.string().trim().min(4).max(50),
    sourceId: z.string().trim().min(1).max(100),
    date: dateSchema,
    amount: signedMoneySchema,
    reference: z.string().trim().min(1).max(500),
    evidenceId: idSchema,
  })
  .strict();
export const settlementInput = z
  .object({
    financialYearId: idSchema,
    movementId: idSchema,
    allocations: z
      .array(z.object({ invoiceId: idSchema, amount: signedMoneySchema }).strict())
      .max(100),
    fee: z
      .object({ amount: moneySchema, account: accountCodeSchema, evidenceId: idSchema })
      .strict()
      .optional(),
  })
  .strict();
export const settlementBodySchema = z
  .object({
    schemaVersion: z.literal(1),
    movementId: idSchema,
    account: z.string(),
    ledgerAccount: accountCodeSchema,
    movementHash: z.string().regex(/^[a-f0-9]{64}$/),
    sourceEvidenceId: idSchema,
    allocations: z
      .array(
        z
          .object({
            invoiceId: idSchema,
            amount: signedMoneySchema,
            positionHash: z.string().regex(/^[a-f0-9]{64}$/),
            positionVersion: z.number().int().min(0),
          })
          .strict(),
      )
      .max(100),
    fee: z
      .object({ amount: moneySchema, account: accountCodeSchema, evidenceId: idSchema })
      .strict()
      .optional(),
    stateHash: z.string().regex(/^[a-f0-9]{64}$/),
    cashJournalCount: z.number().int().min(0).optional(),
  })
  .strict();
export type SettlementInput = z.infer<typeof settlementInput>;
export type SettlementBody = z.infer<typeof settlementBodySchema>;

export const creditNoteInput = z
  .object({
    invoiceId: idSchema,
    originalInvoiceId: idSchema,
    financialYearId: idSchema,
    recognitionDate: dateSchema,
    decisionDate: dateSchema,
    treatmentEvidenceId: idSchema,
    kind: z.enum(['commercial_discount', 'cancellation']),
    periodBasis: z.literal('current_period_event'),
    reason: z.string().trim().min(10).max(1000),
  })
  .strict();
export const creditDetailsSchema = z
  .object({
    originalInvoiceId: idSchema,
    originalJournalId: idSchema,
    originalFinancialYearId: idSchema,
    originalProposalHash: z.string().regex(/^[a-f0-9]{64}$/),
    kind: z.enum(['commercial_discount', 'cancellation']),
    decisionDate: dateSchema,
    periodBasis: z.literal('current_period_event'),
    reason: z.string(),
    priorCreditHash: z.string().regex(/^[a-f0-9]{64}$/),
    priorCreditCount: z.number().int().min(0),
  })
  .strict();
export type CreditNoteInput = z.infer<typeof creditNoteInput>;
