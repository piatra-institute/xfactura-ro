import { z } from 'zod';
import { creditNoteInput } from './settlements';
import {
  accountCodeSchema,
  dateSchema,
  fromBani,
  idSchema,
  moneySchema,
  requireCondition,
  toBani,
} from './values';

const terms = {
  serviceFrom: dateSchema,
  serviceTo: dateSchema,
  evidenceDate: dateSchema,
  reason: z.string().trim().min(10).max(1000),
};
export const deferralInput = z
  .object({
    financialYearId: idSchema,
    invoiceId: idSchema,
    recognitionDate: dateSchema,
    evidenceId: idSchema,
    taxPointBasis: z.literal('early_invoice'),
    account: accountCodeSchema,
    deduction: z.enum(['full', 'none']),
    counterpartyVatCollection: z.literal('no'),
    basis: z.enum(['uniform_subscription', 'uniform_service']),
    method: z.enum(['equal_calendar_months', 'actual_calendar_days']),
    ...terms,
  })
  .strict()
  .refine(
    (value) =>
      value.basis ===
      (value.method === 'equal_calendar_months' ? 'uniform_subscription' : 'uniform_service'),
    { message: 'Documentați baza corespunzătoare metodei de alocare.', path: ['basis'] },
  );
export const deferralSupplementInput = deferralInput
  .safeExtend({
    parentDeferralId: idSchema,
    changeBasis: z.literal('additional_future_services'),
  })
  .strict();
export const deferralSupplementSchema = z
  .object({
    schemaVersion: z.literal(1),
    changeBasis: z.literal('additional_future_services'),
    parentDeferralId: idSchema,
    parentInvoiceId: idSchema,
    parentJournalId: idSchema,
    parentFinancialYearId: idSchema,
    parentProposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const deferralAllocationSchema = z
  .object({ month: dateSchema, date: dateSchema, amount: moneySchema })
  .strict();
export const deferralDayAllocationSchema = deferralAllocationSchema
  .extend({
    serviceFrom: dateSchema,
    serviceTo: dateSchema,
    days: z.number().int().min(1).max(31),
  })
  .strict();
export const deferralScheduleRowSchema = z.union([
  deferralAllocationSchema,
  deferralDayAllocationSchema,
]);
const monthlyTreatmentSchema = z
  .object({
    schemaVersion: z.literal(1),
    basis: z.literal('uniform_subscription'),
    method: z.literal('equal_calendar_months'),
    ...terms,
    taxPointBasis: z.literal('early_invoice'),
    evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
    amount: moneySchema,
    schedule: z.array(deferralAllocationSchema).min(1).max(60),
    supplement: deferralSupplementSchema.optional(),
  })
  .strict();
const dailyTreatmentSchema = z
  .object({
    schemaVersion: z.literal(2),
    basis: z.literal('uniform_service'),
    method: z.literal('actual_calendar_days'),
    ...terms,
    taxPointBasis: z.literal('early_invoice'),
    evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
    amount: moneySchema,
    dayCountBasis: z.literal('actual_inclusive'),
    rounding: z.literal('cumulative_floor_bani'),
    serviceDays: z.number().int().min(1).max(1860),
    schedule: z.array(deferralDayAllocationSchema).min(1).max(60),
    supplement: deferralSupplementSchema.optional(),
  })
  .strict();
export const deferralTreatmentSchema = z.discriminatedUnion('schemaVersion', [
  monthlyTreatmentSchema,
  dailyTreatmentSchema,
]);
export const deferralReleaseInput = z
  .object({ financialYearId: idSchema, deferralId: idSchema, month: dateSchema })
  .strict();
export const deferralReleaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    deferralId: idSchema,
    month: dateSchema,
    date: dateSchema,
    amount: moneySchema,
    sourceInvoiceId: idSchema,
    sourceJournalId: idSchema,
    sourceFinancialYearId: idSchema,
    sourceProposalHash: z.string().regex(/^[a-f0-9]{64}$/),
    evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
    direction: z.enum(['purchase', 'sale']),
    account: accountCodeSchema,
    controlAccount: z.enum(['471', '472']),
    ruleId: z.string(),
    ruleHash: z.string().regex(/^[a-f0-9]{64}$/),
    registrationIds: z.array(idSchema).min(1).max(4),
    cancellationJournalId: idSchema.optional(),
    rescheduleId: idSchema.optional(),
    rescheduleVersion: z.number().int().positive().optional(),
  })
  .strict();

export function monthEnd(month: string) {
  const date = new Date(`${dateSchema.parse(month).slice(0, 7)}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  date.setUTCDate(0);
  return date.toISOString().slice(0, 10);
}
/** Uniform full-month benefits; remainder bani belong to the final month. */
export function allocationSchedule(amount: string, from: string, to: string) {
  dateSchema.parse(from);
  dateSchema.parse(to);
  const [firstYear, firstMonth] = from.split('-').map(Number),
    [lastYear, lastMonth] = to.split('-').map(Number);
  const count = (lastYear - firstYear) * 12 + lastMonth - firstMonth + 1;
  const total = toBani(amount);
  requireCondition(
    from.endsWith('-01') && to === monthEnd(to) && count >= 1 && count <= 60 && total > 0n,
    'DEFERRAL_SCHEDULE',
    'Alocarea acoperă între una și 60 de luni calendaristice complete, cu valoare pozitivă.',
  );
  const each = total / BigInt(count);
  return Array.from({ length: count }, (_, index) => {
    const month = new Date(Date.UTC(firstYear, firstMonth - 1 + index, 1))
      .toISOString()
      .slice(0, 10);
    return {
      month,
      date: monthEnd(month),
      amount: fromBani(index === count - 1 ? total - each * BigInt(count - 1) : each),
    };
  });
}
export type DeferralInput = z.infer<typeof deferralInput>;
export type DeferralSupplementInput = z.infer<typeof deferralSupplementInput>;
export type DeferralReleaseInput = z.infer<typeof deferralReleaseInput>;

/** Actual inclusive service days; cumulative floor in bani keeps each period boundary within one ban. */
export function actualDaySchedule(amount: string, from: string, to: string) {
  dateSchema.parse(from);
  dateSchema.parse(to);
  const [firstYear, firstMonth] = from.split('-').map(Number),
    [lastYear, lastMonth] = to.split('-').map(Number);
  const count = (lastYear - firstYear) * 12 + lastMonth - firstMonth + 1,
    total = toBani(amount);
  requireCondition(
    from <= to && count >= 1 && count <= 60 && total > 0n,
    'DEFERRAL_SCHEDULE',
    'Documentați între una și 60 de luni de servicii uniforme, cu valoare pozitivă.',
  );
  const daysBetween = (start: string, end: string) =>
    Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
  const serviceDays = daysBetween(from, to);
  let cumulativeDays = 0,
    allocated = 0n;
  const schedule = Array.from({ length: count }, (_, index) => {
    const current = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
    current.setUTCMonth(current.getUTCMonth() + index);
    const month = current.toISOString().slice(0, 10),
      date = monthEnd(month),
      serviceFrom = from > month ? from : month,
      serviceTo = to < date ? to : date,
      days = daysBetween(serviceFrom, serviceTo);
    cumulativeDays += days;
    const target = (total * BigInt(cumulativeDays)) / BigInt(serviceDays),
      value = target - allocated;
    allocated = target;
    return { month, date, amount: fromBani(value), serviceFrom, serviceTo, days };
  });
  return { serviceDays, schedule };
}

export const deferralCreditInput = creditNoteInput
  .extend({ kind: z.literal('cancellation'), cancelFrom: dateSchema })
  .strict();
const fullDeferralCreditSchema = z
  .object({
    schemaVersion: z.literal(1),
    deferralId: idSchema,
    controlAccount: z.enum(['471', '472']),
    cancelFrom: dateSchema,
    cancelTo: dateSchema,
    amount: moneySchema,
    allocated: moneySchema,
    remainingBefore: moneySchema,
    remainingAfter: moneySchema,
    priorReleaseCount: z.number().int().min(0),
    priorStateHash: z.string().regex(/^[a-f0-9]{64}$/),
    evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
    months: z.array(deferralScheduleRowSchema).min(1).max(60),
    rescheduleId: idSchema.optional(),
    rescheduleVersion: z.number().int().positive().optional(),
  })
  .strict();
export type DeferralCreditInput = z.infer<typeof deferralCreditInput>;

export const deferralScopeReductionInput = deferralCreditInput
  .extend({
    changeBasis: z.literal('cancelled_future_services'),
    remainingServices: z.literal('uniform'),
  })
  .strict();
export const deferralScopeReductionSchema = fullDeferralCreditSchema
  .extend({
    schemaVersion: z.literal(2),
    changeBasis: z.literal('cancelled_future_services'),
    remainingServices: z.literal('uniform'),
    method: z.enum(['equal_calendar_months', 'actual_calendar_days']),
    beforeSchedule: z.array(deferralScheduleRowSchema).min(1).max(60),
    afterSchedule: z.array(deferralScheduleRowSchema).min(1).max(60),
  })
  .strict();
export const deferralCreditSchema = z.discriminatedUnion('schemaVersion', [
  fullDeferralCreditSchema,
  deferralScopeReductionSchema,
]);
export type DeferralScopeReductionInput = z.infer<typeof deferralScopeReductionInput>;

export const deferralDiscountInput = creditNoteInput
  .extend({
    kind: z.literal('commercial_discount'),
    servicesUnchanged: z.literal(true),
  })
  .strict();
export const deferralDiscountSchema = z
  .object({
    schemaVersion: z.literal(1),
    deferralId: idSchema,
    servicesUnchanged: z.literal(true),
    account: z.enum(['609', '709']),
    amount: moneySchema,
    controlAccount: z.enum(['471', '472']),
    sourceAmount: moneySchema,
    cancellationJournalId: idSchema.nullable(),
    evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
    ruleReference: z.literal('OMFP1802:76(5)'),
    rescheduleId: idSchema.optional(),
    rescheduleVersion: z.number().int().positive().optional(),
  })
  .strict();
export type DeferralDiscountInput = z.infer<typeof deferralDiscountInput>;

export const deferralRescheduleInput = z
  .object({
    financialYearId: idSchema,
    deferralId: idSchema,
    date: dateSchema,
    effectiveFrom: dateSchema,
    serviceTo: dateSchema,
    evidenceId: idSchema,
    evidenceDate: dateSchema,
    method: z.enum(['equal_calendar_months', 'actual_calendar_days']),
    priceUnchanged: z.literal(true),
    reason: z.string().trim().min(10).max(1000),
  })
  .strict();
export const deferralRescheduleEffect = deferralRescheduleInput
  .extend({
    kind: z.literal('deferrals.reschedule'),
    schemaVersion: z.literal(1),
    sequence: z.number().int().min(1).max(1000),
    priorRescheduleId: idSchema.nullable(),
    sourceInvoiceId: idSchema,
    sourceJournalId: idSchema,
    sourceFinancialYearId: idSchema,
    sourceProposalHash: z.string().regex(/^[a-f0-9]{64}$/),
    evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
    direction: z.enum(['purchase', 'sale']),
    account: accountCodeSchema,
    controlAccount: z.enum(['471', '472']),
    sourceAmount: moneySchema,
    allocated: moneySchema,
    amount: moneySchema,
    priorReleaseCount: z.number().int().nonnegative(),
    priorCreditCount: z.number().int().nonnegative(),
    priorCreditHash: z.string().regex(/^[a-f0-9]{64}$/),
    stateHash: z.string().regex(/^[a-f0-9]{64}$/),
    registrationIds: z.array(idSchema).min(1).max(128),
    beforeSchedule: z.array(deferralScheduleRowSchema).min(1).max(60),
    afterSchedule: z.array(deferralScheduleRowSchema).min(1).max(60),
  })
  .strict();
export type DeferralRescheduleInput = z.infer<typeof deferralRescheduleInput>;
export type DeferralRescheduleEffect = z.infer<typeof deferralRescheduleEffect>;
