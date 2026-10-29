import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Accounting } from './application';
import { authorize, type Actor } from './commands';
import { capabilityPolicy, roleAllows, type CapabilityId } from './capability-policy';
import { issueAgentSchema } from './agents';
import { journalPage, movementPage, proposalPage, reviewPage, summaryInput } from './agent-queries';
import {
  accountInput,
  accountQuery,
  policyInput,
  policyQuery,
  regimeInput,
  yearInput,
} from './foundation';
import { balanceInput, ledgerReviewInput } from './general-ledger';
import { invoiceImportInput, invoicePage } from './invoices';
import {
  archiveInput,
  archiveOutput,
  invoiceSourcesInput,
  invoiceSourceOutput,
} from './invoice-archives';
import { invoicePostingInput } from './invoice-postings';
import { treasuryPage } from './treasury';
import {
  bankFileInput,
  bankFileReadInput,
  bankFileOutput,
  bankStatementEntryPage,
  bankStatementEntriesOutput,
} from './bank-statement-files';
import { positionQuery, positionRead } from './invoice-positions';
import { settlementRevisionInput } from './settlements';
import { deferralPageInput, deferralReadInput, deferralReconcileInput } from './deferrals';
import {
  advanceReadInput,
  advancePaymentReadInput,
  advancePageInput,
  advanceReconcileInput,
} from './advances';
import { advanceCashVatOutput } from './advance-registers';
import {
  accrualPageInput,
  accrualReadInput,
  accrualReconcileInput,
  accrualAdjustmentPageInput,
} from './accruals';
import {
  unbilledSalePageInput,
  unbilledSaleReadInput,
  unbilledSaleReconcileInput,
  unbilledSaleAdjustmentPageInput,
} from './unbilled-sales';
import {
  vatEntriesInput,
  vatEntryOutput,
  vatPeriodInput,
  vatSummaryOutput,
  unbilledSaleVatOutput,
  unbilledSaleVatInput,
  unbilledSaleAdjustmentVatOutput,
} from './vat-registers';
import { obligationOutput, ruleOutput } from './accounting-catalogue';
import {
  approvalOutput,
  balanceOutput,
  companyOutput,
  emptySchema,
  evidenceOutput,
  grantOutput,
  hashSchema,
  jobOutput,
  journalOutput,
  movementOutput,
  pageInput,
  pageOutput,
  periodOutput,
  postingOutput,
  proposalOutput,
  proposalView,
  recordIdSchema,
  reviewOutput,
  statementOutput,
  accountOutput,
  yearOutput,
  regimeOutput,
  ledgerBalanceOutput,
  policyOutput,
  invoiceOutput,
  positionOutput,
  treasuryAccountOutput,
  accrualPositionOutput,
  accrualAdjustmentOutput,
  accrualReconcileOutput,
  unbilledSalePositionOutput,
  unbilledSaleAdjustmentOutput,
  unbilledSaleReconcileOutput,
  deferralPositionOutput,
  deferralReconcileOutput,
  advancePaymentOutput,
  advancePositionOutput,
  advanceReconcileOutput,
} from './capability-contracts';
import {
  correctionSchema,
  dateSchema,
  generalJournalSchema,
  cashMovementInput,
  creditNoteInput,
  settlementInput,
  treasuryAccountInput,
  accrualInput,
  accrualAdjustmentInput,
  accrualInvoiceInput,
  unbilledSaleInput,
  unbilledSaleInvoiceInput,
  unbilledSaleAdjustmentInput,
  deferralInput,
  deferralReleaseInput,
  advancePaymentInput,
  advanceInvoiceInput,
  advanceFinalInput,
  advanceCreditInput,
  advanceRefundInput,
  deferralCreditInput,
  deferralDiscountInput,
  deferralScopeReductionInput,
  deferralSupplementInput,
  deferralRescheduleInput,
  idSchema,
  inviteSchema,
  matchSchema,
  openingSchema,
  purchaseSchema,
  requireCondition,
  reviewSchema,
  statementSchema,
} from './domain';
import {
  actionRequestSchema,
  actionReviewSchema,
  monthSchema,
  rejectReviewSchema,
} from './reviews';
import { agentGrants } from './schema';

export const capabilityDescriptor = z.object({
  id: z.string(),
  description: z.string(),
  permission: z.string(),
  effect: z.string(),
  approval: z.string(),
  agent: z.boolean(),
  status: z.literal('implemented'),
  inputSchema: z.record(z.string(), z.json()),
  outputSchema: z.record(z.string(), z.json()),
});
const discoveryOutput = z.object({
  version: z.literal('1'),
  capabilities: z.array(capabilityDescriptor),
});

type Definition = {
  description: string;
  input: z.ZodType;
  output: z.ZodType;
  invoke: (actor: Actor, key: string, input: unknown) => Promise<unknown>;
};
function define<I extends z.ZodType, O extends z.ZodType>(
  description: string,
  input: I,
  output: O,
  handler: (actor: Actor, key: string, body: z.output<I>) => Promise<unknown>,
): Definition {
  return {
    description,
    input,
    output,
    invoke: async (actor, key, body) => {
      const result = output.safeParse(await handler(actor, key, input.parse(body)));
      requireCondition(
        result.success,
        'CAPABILITY_RESULT',
        'Rezultatul operațiunii nu respectă contractul API.',
        500,
      );
      return result.data;
    },
  };
}
const proposalReviewInput = reviewSchema.extend({ id: idSchema }).strict();

export class Capabilities {
  readonly definitions: Partial<Record<CapabilityId, Definition>>;

  constructor(private readonly service: Accounting) {
    this.definitions = {
      'capabilities.list': define(
        'Discover implemented capabilities available to this principal.',
        emptySchema,
        discoveryOutput,
        (actor) => this.list(actor),
      ),
      'books.summary': define(
        'Company identity and financial-year trial balance. Select a year when several exist.',
        summaryInput,
        z.object({
          company: companyOutput,
          financialYear: yearOutput,
          balances: z.array(balanceOutput),
        }),
        (actor, _, body) => service.queries.summary(actor, body),
      ),
      'years.list': define(
        'List configured financial and fiscal years.',
        emptySchema,
        z.array(yearOutput),
        (actor) => service.foundation.years(actor),
      ),
      'years.create': define(
        'Configure a non-overlapping financial or fiscal year.',
        yearInput,
        yearOutput,
        (actor, key, body) => service.foundation.createYear(actor, key, body),
      ),
      'accounts.list': define(
        'Browse the sourced reference chart and company analytical accounts.',
        accountQuery,
        z.object({
          chart: z.object({
            id: z.string(),
            source: z.string(),
            sourceSha256: hashSchema,
            status: z.string(),
          }),
          ...pageOutput(accountOutput).shape,
        }),
        (actor, _, body) => service.foundation.accounts(actor, body),
      ),
      'accounts.create': define(
        'Create a company analytical account beneath a postable parent.',
        accountInput,
        accountOutput,
        (actor, key, body) => service.foundation.createAccount(actor, key, body),
      ),
      'regimes.read': define(
        'Read evidenced registrations effective on a date. Missing facts remain unknown.',
        z.object({ date: dateSchema }).strict(),
        z.object({
          date: dateSchema,
          regimes: z.object({
            vat: regimeOutput.nullable(),
            income_tax: regimeOutput.nullable(),
            eu_vat: regimeOutput.nullable(),
            vat_collection: regimeOutput.nullable(),
          }),
        }),
        (actor, _, body) => service.foundation.regimes(actor, body.date),
      ),
      'regimes.record': define(
        'Record a human-reviewed, effective-dated registration supported by evidence.',
        regimeInput,
        regimeOutput,
        (actor, key, body) => service.foundation.recordRegime(actor, key, body),
      ),
      'ledger.propose': define(
        'Prepare explicit balanced accounting lines for a financial year. Does not infer taxation.',
        generalJournalSchema,
        proposalOutput,
        (actor, key, body) => service.ledger.propose(actor, key, body),
      ),
      'ledger.revise': define(
        'Revise an unposted general proposal and invalidate its old approval.',
        generalJournalSchema
          .extend({ id: idSchema, version: z.number().int().positive() })
          .strict(),
        proposalOutput,
        (actor, key, { id, version, ...body }) =>
          service.ledger.propose(actor, key, body, { id, version }),
      ),
      'ledger.post': define(
        'Post the exact human-approved general proposal, preserving its source and lines.',
        ledgerReviewInput,
        postingOutput,
        (actor, key, body) => service.ledger.post(actor, key, body),
      ),
      'ledger.balance': define(
        'Read exact opening, period movements and closing balances within one financial year.',
        balanceInput,
        ledgerBalanceOutput,
        (actor, _, body) => service.ledger.balance(actor, body),
      ),
      'policies.read': define(
        'Read the approved company policy version effective for a key and date. Records alone do not execute policy.',
        policyQuery,
        policyOutput.nullable(),
        (actor, _, body) => service.foundation.policies(actor, body),
      ),
      'policies.record': define(
        'Retain an evidenced policy version with human authorization; does not grant autonomous execution.',
        policyInput,
        policyOutput,
        (actor, key, body) => service.foundation.recordPolicy(actor, key, body),
      ),
      'rules.list': define(
        'Read draft calculation references and hashes. These are not signed fiscal-package claims.',
        emptySchema,
        z.array(ruleOutput),
        (actor) => service.foundation.rules(actor),
      ),
      'obligations.catalogue': define(
        'Read planned declaration references. Applicability and artifact generation remain unimplemented.',
        emptySchema,
        z.array(obligationOutput),
        (actor) => service.foundation.obligationCatalogue(actor),
      ),
      'invoices.import': define(
        'Parse retained UBL invoice/credit-note XML into immutable document facts. Does not post, certify or establish delivery.',
        invoiceImportInput,
        invoiceOutput,
        (actor, key, body) => service.invoices.import(actor, key, body),
      ),
      'invoices.importArchive': define(
        'Import retained ZIP members atomically, preserving the original archive, extracted bytes and invoice provenance. Does not verify signatures, establish ANAF acceptance or post accounting.',
        archiveInput,
        archiveOutput,
        (actor, key, body) => service.invoiceArchives.import(actor, key, body),
      ),
      'invoices.archive': define(
        'Read an immutable archive manifest, its invoices, supporting files and hashes. A signature file is not verified acceptance.',
        archiveInput,
        archiveOutput,
        (actor, _, body) => service.invoiceArchives.get(actor, body),
      ),
      'invoices.sources': define(
        'Read bounded archive origins of an invoice, including semantically identical XML variants and exact member bytes.',
        invoiceSourcesInput,
        pageOutput(invoiceSourceOutput),
        (actor, _, body) => service.invoiceArchives.sources(actor, body),
      ),
      'invoices.list': define(
        'Read bounded imported invoice facts and source references.',
        invoicePage,
        pageOutput(invoiceOutput),
        (actor, _, body) => service.invoices.list(actor, body),
      ),
      'invoices.get': define(
        'Read one company-scoped imported invoice and reconciled source totals.',
        recordIdSchema,
        invoiceOutput,
        (actor, _, body) => service.invoices.get(actor, body.id),
      ),
      'invoices.propose': define(
        'Prepare domestic RON service invoice lines for VAT/non-VAT, using explicit evidence, dates and deduction decisions. Other treatments require separate coverage.',
        invoicePostingInput,
        proposalOutput,
        (actor, key, body) => service.invoices.propose(actor, key, body),
      ),
      'invoices.proposeCreditNote': define(
        'Prepare a linked service credit note using the original approved tax treatment and an evidenced current-period decision.',
        creditNoteInput,
        proposalOutput,
        (actor, key, body) => service.invoices.proposeCreditNote(actor, key, body),
      ),
      'advances.proposePayment': define(
        'Prepare an evidenced domestic RON supplier/customer bank advance before invoicing; input VAT is not deducted from a payment.',
        advancePaymentInput,
        proposalOutput,
        (actor, key, body) => service.advances.proposePayment(actor, key, body),
      ),
      'advances.revisePayment': define(
        'Revise the unposted advance proposal and require fresh exact human approval.',
        advancePaymentInput.extend({ id: idSchema, version: z.number().int().positive() }).strict(),
        proposalOutput,
        (actor, key, { id, version, ...body }) =>
          service.advances.proposePayment(actor, key, body, { id, version }),
      ),
      'advances.proposeInvoice': define(
        'Prepare a domestic RON advance invoice in 4092/419; optional whole prior payments settle it without duplicating VAT.',
        advanceInvoiceInput,
        proposalOutput,
        (actor, key, body) => service.advances.proposeInvoice(actor, key, body),
      ),
      'advances.reviseInvoice': define(
        'Revise the unposted advance proposal and require fresh exact human approval.',
        advanceInvoiceInput.extend({ id: idSchema, version: z.number().int().positive() }).strict(),
        proposalOutput,
        (actor, key, { id, version, ...body }) =>
          service.advances.proposeInvoice(actor, key, body, { id, version }),
      ),
      'advances.proposeFinalInvoice': define(
        'Prepare the complete service and exact referenced negative advance lines on a final invoice, preserving VAT already recorded.',
        advanceFinalInput,
        proposalOutput,
        (actor, key, body) => service.advances.proposeFinalInvoice(actor, key, body),
      ),
      'advances.reviseFinalInvoice': define(
        'Revise the unposted advance proposal and require fresh exact human approval.',
        advanceFinalInput.extend({ id: idSchema, version: z.number().int().positive() }).strict(),
        proposalOutput,
        (actor, key, { id, version, ...body }) =>
          service.advances.proposeFinalInvoice(actor, key, body, { id, version }),
      ),
      'advances.proposeCreditNote': define(
        'Prepare cancellation of an unused invoiced advance; reject amounts already regularized and preserve refund obligations.',
        advanceCreditInput,
        proposalOutput,
        (actor, key, body) => service.advances.proposeCreditNote(actor, key, body),
      ),
      'advances.reviseCreditNote': define(
        'Revise the unposted advance proposal and require fresh exact human approval.',
        advanceCreditInput.extend({ id: idSchema, version: z.number().int().positive() }).strict(),
        proposalOutput,
        (actor, key, { id, version, ...body }) =>
          service.advances.proposeCreditNote(actor, key, body, { id, version }),
      ),
      'advances.proposeRefund': define(
        'Prepare a documented bank refund of an unmatched, uninvoiced advance. Omit net to return the exact remaining balance, or supply a positive net for a partial refund at the original rate. Retain earlier refunds and the amount available for a later invoice. Requires exact human approval; never moves money.',
        advanceRefundInput,
        proposalOutput,
        (actor, key, body) => service.advances.proposeRefund(actor, key, body),
      ),
      'advances.reviseRefund': define(
        'Revise the unposted advance proposal and require fresh exact human approval.',
        advanceRefundInput.extend({ id: idSchema, version: z.number().int().positive() }).strict(),
        proposalOutput,
        (actor, key, { id, version, ...body }) =>
          service.advances.proposeRefund(actor, key, body, { id, version }),
      ),
      'advances.getPayment': define(
        'Read one dated pre-invoice payment and its invoice/refund resolution.',
        advancePaymentReadInput,
        advancePaymentOutput,
        (actor, _, body) => service.advances.getPayment(actor, body),
      ),
      'advances.get': define(
        'Read one dated invoiced advance, remaining amounts and control balance.',
        advanceReadInput,
        advancePositionOutput,
        (actor, _, body) => service.advances.get(actor, body),
      ),
      'advances.payments': define(
        'Read bounded dated bank advances before invoice, including carried prior-year positions.',
        advancePageInput,
        pageOutput(advancePaymentOutput),
        (actor, _, body) => service.advances.payments(actor, body),
      ),
      'advances.list': define(
        'Read bounded dated invoiced advance positions and exact remaining amounts.',
        advancePageInput,
        pageOutput(advancePositionOutput),
        (actor, _, body) => service.advances.list(actor, body),
      ),
      'advances.reconcile': define(
        'Reconcile native bank/invoice advances to 4092/419 for one financial year.',
        advanceReconcileInput,
        advanceReconcileOutput,
        (actor, _, body) => service.advances.reconcile(actor, body),
      ),
      'vat.advancePayments': define(
        'Read source-linked cash-advance VAT movements; supplier payments alone have no input deduction.',
        unbilledSaleVatInput,
        pageOutput(advanceCashVatOutput),
        (actor, _, body) => service.vat.advancePayments(actor, body),
      ),
      'deferrals.proposeInvoice': define(
        'Prepare an early domestic RON service invoice in 471/472. Use uniform_subscription/equal_calendar_months, uniform_service/actual_calendar_days, or documented_monthly_benefits/evidenced_monthly_amounts with exact benefits rows. Explicit monthly amounts must equal the cost/revenue basis, and their releases require separate service evidence. VAT remains at the invoice tax point.',
        deferralInput,
        proposalOutput,
        (actor, key, body) => service.deferrals.proposeInvoice(actor, key, body),
      ),
      'deferrals.proposeSupplement': define(
        'Prepare a separately invoiced addition of future services linked to a posted contract invoice. Retain a separate agreement, the same parties and service account, and additional_future_services. The new invoice owns its VAT tax point, position and equal-month or actual-day schedule; original amounts stay unchanged. Exact human approval is required before ledger.post.',
        deferralSupplementInput,
        proposalOutput,
        (actor, key, body) => service.deferrals.proposeSupplement(actor, key, body),
      ),
      'deferrals.reviseSupplement': define(
        'Revise an unposted supplemental service invoice or its parent link and invalidate its earlier approval. Obtain fresh human approval for the new exact version.',
        deferralSupplementInput
          .safeExtend({ id: idSchema, version: z.number().int().positive() })
          .strict(),
        proposalOutput,
        (actor, key, { id, version, ...body }) =>
          service.deferrals.proposeSupplement(actor, key, body, { id, version }),
      ),
      'deferrals.proposeCreditNote': define(
        'Prepare an evidenced current-period cancellation of whole future subscription months using a linked credit note. Retain earned amounts; reduce 471/472, invoice position and original-rate VAT. Requires exact human approval before ledger.post.',
        deferralCreditInput,
        proposalOutput,
        (actor, key, body) => service.deferrals.proposeCreditNote(actor, key, body),
      ),
      'deferrals.proposeScopeReduction': define(
        'Prepare a separately evidenced partial cancellation of unprovided services using a linked credit note. Reduce 471/472 and original-rate VAT; preserve earned periods, dates and allocation method. Uniform sources require uniform remaining services. Evidenced monthly sources require remainingServices=documented_monthly_benefits and exact future benefits, with no month increased. Further reductions bind the complete prior credit state and current reduced plan. Requires exact human approval before ledger.post.',
        deferralScopeReductionInput,
        proposalOutput,
        (actor, key, body) => service.deferrals.proposeScopeReduction(actor, key, body),
      ),
      'deferrals.reviseScopeReduction': define(
        'Refresh an unposted future-service scope reduction after its source, credit or calendar snapshot changes. Earlier approval is invalidated; obtain fresh human approval.',
        deferralScopeReductionInput
          .safeExtend({ id: idSchema, version: z.number().int().positive() })
          .strict(),
        proposalOutput,
        (actor, key, { id, version, ...body }) =>
          service.deferrals.proposeScopeReduction(actor, key, body, { id, version }),
      ),
      'deferrals.proposeDiscount': define(
        'Prepare a post-invoice commercial subscription discount in 609/709 with separate agreement and unchanged services. Preserve the original 471/472 allocation schedule; exact human approval remains required.',
        deferralDiscountInput,
        proposalOutput,
        (actor, key, body) => service.deferrals.proposeDiscount(actor, key, body),
      ),
      'deferrals.proposeReschedule': define(
        'Prepare a prospective service schedule from a separate agreement. Preserve the original method, recognized prefix, billed value, scope credits and VAT. After a partial cancellation, redistribute only the reduced future balance; full cancellation cannot be rescheduled. Evidenced monthly amounts require explicit benefits for that remaining value. Returns an exact action review; human approval and reviews.execute apply it without a journal entry.',
        deferralRescheduleInput,
        reviewOutput,
        (actor, key, body) =>
          service.reviews.request(
            actor,
            key,
            { operation: 'deferrals.reschedule', input: body },
            'deferrals.proposeReschedule',
          ),
      ),
      'deferrals.reviseDiscount': define(
        'Revise an unposted subscription discount and refresh its exact source/credit snapshot for fresh human approval.',
        deferralDiscountInput
          .extend({ id: idSchema, version: z.number().int().positive() })
          .strict(),
        proposalOutput,
        (actor, key, { id, version, ...body }) =>
          service.deferrals.proposeDiscount(actor, key, body, { id, version }),
      ),
      'deferrals.reviseCreditNote': define(
        'Refresh an unposted subscription cancellation after allocations invalidate its snapshot; obtain new human approval.',
        deferralCreditInput.extend({ id: idSchema, version: z.number().int().positive() }).strict(),
        proposalOutput,
        (actor, key, { id, version, ...body }) =>
          service.deferrals.proposeCreditNote(actor, key, body, { id, version }),
      ),
      'deferrals.reviseInvoice': define(
        'Revise an unposted subscription invoice/schedule and invalidate its old approval.',
        deferralInput.safeExtend({ id: idSchema, version: z.number().int().positive() }).strict(),
        proposalOutput,
        (actor, key, { id, version, ...body }) =>
          service.deferrals.proposeInvoice(actor, key, body, { id, version }),
      ),
      'deferrals.proposeRelease': define(
        'Prepare one scheduled month-end allocation from 471/472 without repeating invoice VAT. Evidenced monthly amounts require benefitEvidence with a separate service-confirmation evidenceId and evidenceDate covering the service month. Requires exact human approval before ledger.post.',
        deferralReleaseInput,
        proposalOutput,
        (actor, key, body) => service.deferrals.proposeRelease(actor, key, body),
      ),
      'deferrals.reviseRelease': define(
        'Refresh an unposted monthly allocation after reviewed source/registration changes invalidate its snapshot.',
        deferralReleaseInput
          .extend({ id: idSchema, version: z.number().int().positive() })
          .strict(),
        proposalOutput,
        (actor, key, { id, version, ...body }) =>
          service.deferrals.proposeRelease(actor, key, body, { id, version }),
      ),
      'deferrals.get': define(
        'Read one service schedule, dated allocated/remaining amounts, due months and any supplemental-invoice parent link.',
        deferralReadInput,
        deferralPositionOutput,
        (actor, _, body) => service.deferrals.get(actor, body),
      ),
      'deferrals.list': define(
        'Read bounded purchase/sale service positions, optionally filtering open positions or direct supplements by parentDeferralId.',
        deferralPageInput,
        pageOutput(deferralPositionOutput),
        (actor, _, body) => service.deferrals.list(actor, body),
      ),
      'deferrals.reconcile': define(
        'Reconcile native schedules to 471/472 in one financial year and count unposted due allocations. Does not establish fiscal conformance.',
        deferralReconcileInput,
        deferralReconcileOutput,
        (actor, _, body) => service.deferrals.reconcile(actor, body),
      ),
      'invoices.reviseCreditNote': define(
        'Refresh an unposted credit-note proposal after competing credits or a changed review decision.',
        creditNoteInput.extend({ id: idSchema, version: z.number().int().positive() }).strict(),
        proposalOutput,
        (actor, key, { id, version, ...body }) =>
          service.invoices.proposeCreditNote(actor, key, body, { id, version }),
      ),
      'positions.get': define(
        'Read one posted invoice position, including credits, partial settlements and refundable balances at a date.',
        positionRead,
        positionOutput,
        (actor, _, body) => service.positions.read(actor, body),
      ),
      'positions.list': define(
        'Read bounded customer/supplier open positions as of a date; credit notes remain linked to their original invoice.',
        positionQuery,
        pageOutput(positionOutput),
        (actor, _, body) => service.positions.list(actor, body),
      ),
      'accruals.propose': define(
        'Prepare an evidence-backed domestic RON service purchase in 408, retaining estimated recoverable VAT in 4428. Requires exact human approval before ledger.post.',
        accrualInput,
        proposalOutput,
        (actor, key, body) => service.accruals.propose(actor, key, body),
      ),
      'unbilledSales.propose': define(
        'Prepare completed domestic RON services in 418/704, recognizing applicable output VAT at the service tax point. Requires exact human approval before ledger.post.',
        unbilledSaleInput,
        proposalOutput,
        (actor, key, body) => service.unbilledSales.propose(actor, key, body),
      ),
      'unbilledSales.revise': define(
        'Revise an unposted unbilled-service proposal and invalidate its old approval.',
        unbilledSaleInput.extend({ id: idSchema, version: z.number().int().positive() }).strict(),
        proposalOutput,
        (actor, key, { id, version, ...body }) =>
          service.unbilledSales.propose(actor, key, body, { id, version }),
      ),
      'unbilledSales.matchInvoice': define(
        'Prepare an issued invoice against posted unbilled services without recognizing revenue or output VAT again. Supports exact partial/grouped allocations.',
        unbilledSaleInvoiceInput,
        proposalOutput,
        (actor, key, body) => service.unbilledSales.matchInvoice(actor, key, body),
      ),
      'unbilledSales.reviseMatch': define(
        'Refresh an unposted sales invoice match after competing allocations change available balances.',
        unbilledSaleInvoiceInput
          .extend({ id: idSchema, version: z.number().int().positive() })
          .strict(),
        proposalOutput,
        (actor, key, { id, version, ...body }) =>
          service.unbilledSales.matchInvoice(actor, key, body, { id, version }),
      ),
      'unbilledSales.proposeAdjustment': define(
        'Prepare a new-information remeasurement or release of an explicitly estimated, uninvoiced service balance. Same financial year; normal VAT restricted to the original service month. No credit, bad-debt, contract-price or prior-period correction treatment.',
        unbilledSaleAdjustmentInput,
        proposalOutput,
        (actor, key, body) => service.unbilledSales.proposeAdjustment(actor, key, body),
      ),
      'unbilledSales.reviseAdjustment': define(
        'Refresh an unposted unbilled-sales remeasurement against current remaining amounts, requiring fresh exact human approval.',
        unbilledSaleAdjustmentInput
          .extend({ id: idSchema, version: z.number().int().positive() })
          .strict(),
        proposalOutput,
        (actor, key, { id, version, ...body }) =>
          service.unbilledSales.proposeAdjustment(actor, key, body, { id, version }),
      ),
      'unbilledSales.adjustments': define(
        'Read immutable, dated unbilled-sales estimate changes with source evidence and exact signed deltas.',
        unbilledSaleAdjustmentPageInput,
        pageOutput(unbilledSaleAdjustmentOutput),
        (actor, _, body) => service.unbilledSales.adjustments(actor, body),
      ),
      'unbilledSales.get': define(
        'Read one unbilled-service receivable and its dated invoiced/remaining amounts.',
        unbilledSaleReadInput,
        unbilledSalePositionOutput,
        (actor, _, body) => service.unbilledSales.get(actor, body),
      ),
      'unbilledSales.list': define(
        'Read bounded unbilled-service receivables, including prior-year positions.',
        unbilledSalePageInput,
        pageOutput(unbilledSalePositionOutput),
        (actor, _, body) => service.unbilledSales.list(actor, body),
      ),
      'unbilledSales.reconcile': define(
        "Reconcile dated unbilled-service positions to the selected financial year's 418 control balance.",
        unbilledSaleReconcileInput,
        unbilledSaleReconcileOutput,
        (actor, _, body) => service.unbilledSales.reconcile(actor, body),
      ),
      'vat.unbilledSales': define(
        'Read bounded source-linked unbilled-service VAT recognition rows. Later issued invoices do not repeat these tax movements.',
        unbilledSaleVatInput,
        pageOutput(unbilledSaleVatOutput),
        (actor, _, body) => service.vat.unbilledSales(actor, body),
      ),
      'vat.unbilledSaleAdjustments': define(
        'Read signed unbilled-sales estimate movements in the working VAT register, retaining original tax points and source links. Not an official declaration.',
        unbilledSaleVatInput,
        pageOutput(unbilledSaleAdjustmentVatOutput),
        (actor, _, body) => service.vat.unbilledSaleAdjustments(actor, body),
      ),
      'accruals.revise': define(
        'Revise an unposted service accrual and invalidate its previous approval.',
        accrualInput.extend({ id: idSchema, version: z.number().int().positive() }).strict(),
        proposalOutput,
        (actor, key, { id, version, ...body }) =>
          service.accruals.propose(actor, key, body, { id, version }),
      ),
      'accruals.matchInvoice': define(
        'Prepare a later purchase invoice against posted service accruals, without recognizing the expense again. Supports exact partial/grouped matching and releases approved input VAT at documented receipt.',
        accrualInvoiceInput,
        proposalOutput,
        (actor, key, body) => service.accruals.matchInvoice(actor, key, body),
      ),
      'accruals.reviseMatch': define(
        'Refresh an unposted invoice match after a competing match changes accrual balances.',
        accrualInvoiceInput.extend({ id: idSchema, version: z.number().int().positive() }).strict(),
        proposalOutput,
        (actor, key, { id, version, ...body }) =>
          service.accruals.matchInvoice(actor, key, body, { id, version }),
      ),
      'accruals.get': define(
        'Read a posted service accrual and remaining unbilled balance at a date.',
        accrualReadInput,
        accrualPositionOutput,
        (actor, _, body) => service.accruals.get(actor, body),
      ),
      'accruals.proposeAdjustment': define(
        'Prepare an evidenced current-year change to the remaining unbilled purchase estimate, or release that remainder. Retains original postings and invoiced amounts; requires human approval before ledger.post.',
        accrualAdjustmentInput,
        proposalOutput,
        (actor, key, body) => service.accruals.proposeAdjustment(actor, key, body),
      ),
      'accruals.reviseAdjustment': define(
        'Refresh an unposted accrual adjustment after matches or other estimate changes invalidate its exact snapshot.',
        accrualAdjustmentInput
          .extend({ id: idSchema, version: z.number().int().positive() })
          .strict(),
        proposalOutput,
        (actor, key, { id, version, ...body }) =>
          service.accruals.proposeAdjustment(actor, key, body, { id, version }),
      ),
      'accruals.adjustments': define(
        'Read bounded, dated immutable purchase-estimate adjustments and their original links, evidence and exact deltas.',
        accrualAdjustmentPageInput,
        pageOutput(accrualAdjustmentOutput),
        (actor, _, body) => service.accruals.adjustments(actor, body),
      ),
      'accruals.reconcile': define(
        'Reconcile all dated unbilled purchase positions and deferred VAT to 408/4428 in one financial year. Reveals missing opening continuity; other deferred-VAT uses require separate supported classifications.',
        accrualReconcileInput,
        accrualReconcileOutput,
        (actor, _, body) => service.accruals.reconcile(actor, body),
      ),
      'accruals.list': define(
        'Read bounded service accrual positions, including partial invoice matches and deferred VAT.',
        accrualPageInput,
        pageOutput(accrualPositionOutput),
        (actor, _, body) => service.accruals.list(actor, body),
      ),
      'vat.entries': define(
        'Read source-linked working purchase/sale VAT registers with signed credits and original tax rates. Does not produce an official declaration.',
        vatEntriesInput,
        pageOutput(vatEntryOutput),
        (actor, _, body) => service.vat.entries(actor, body),
      ),
      'vat.summary': define(
        'Reconcile working VAT registers to period ledger movements and identify unposted invoices or unclassified entries. Openings are excluded; reconciliation is not fiscal conformance.',
        vatPeriodInput,
        vatSummaryOutput,
        (actor, _, body) => service.vat.summary(actor, body),
      ),
      'treasury.accounts': define(
        'Read company bank and cash account mappings in bounded pages.',
        treasuryPage,
        pageOutput(treasuryAccountOutput),
        (actor, _, body) => service.treasury.accounts(actor, body),
      ),
      'treasury.createAccount': define(
        'Configure a bank or cash account with a distinct ledger account and retained source evidence. Human company owners only.',
        treasuryAccountInput,
        treasuryAccountOutput,
        (actor, key, body) => service.treasury.createAccount(actor, key, body),
      ),
      'treasury.recordCash': define(
        'Retain a documented cash receipt/payment fact. Does not post or move funds.',
        cashMovementInput,
        recordIdSchema,
        (actor, key, body) => service.treasury.recordCashMovement(actor, key, body),
      ),
      'settlements.propose': define(
        'Prepare exact invoice allocations/refunds and bank fees for one complete recorded movement. Human approval is required before ledger.post.',
        settlementInput,
        proposalOutput,
        (actor, key, body) => service.settlements.propose(actor, key, body),
      ),
      'settlements.revise': define(
        'Refresh an unposted settlement snapshot after an invoice balance changes.',
        settlementRevisionInput,
        proposalOutput,
        (actor, key, { id, version, ...body }) =>
          service.settlements.propose(actor, key, body, { id, version }),
      ),
      'evidence.list': define(
        'List retained source metadata in bounded pages.',
        pageInput,
        pageOutput(evidenceOutput),
        (actor, _, body) => service.queries.evidence(actor, body),
      ),
      'evidence.read': define(
        'Read a retained source. Inline base64 is limited to 256 KiB; downloadPath retrieves larger originals.',
        recordIdSchema,
        z.object({
          record: evidenceOutput,
          base64: z.string().optional(),
          downloadPath: z.string(),
        }),
        async (actor, _, body) => {
          const { record, bytes } = await service.documents.read(actor, body.id);
          return {
            record,
            ...(bytes.length <= 256 * 1024
              ? { base64: Buffer.from(bytes).toString('base64') }
              : {}),
            downloadPath: `/api/accounting/v1/companies/${actor.companyId}/evidence/${record.id}`,
          };
        },
      ),
      'evidence.record': define(
        'Retain original source bytes, without posting or inferring fiscal treatment.',
        z
          .object({
            filename: z.string().min(1).max(240),
            mediaType: z.string().max(150),
            base64: z
              .string()
              .min(4)
              .max(13981016)
              .regex(/^[A-Za-z0-9+/]*={0,2}$/),
          })
          .strict(),
        evidenceOutput,
        async (actor, key, body) => {
          const bytes = Buffer.from(body.base64, 'base64');
          requireCondition(
            bytes.length > 0 &&
              bytes.length <= 10 * 1024 * 1024 &&
              bytes.toString('base64') === body.base64,
            'EVIDENCE_SIZE',
            'Documentul depășește limita sau codificarea nu este validă.',
          );
          return service.documents.record(actor, key, {
            filename: body.filename,
            mediaType: body.mediaType,
            bytes,
          });
        },
      ),
      'proposals.list': define(
        'List proposals, exact approval status and deterministic posting effects.',
        proposalPage,
        pageOutput(proposalView),
        (actor, _, body) => service.queries.proposals(actor, body),
      ),
      'proposals.get': define(
        'Read the current exact proposal version, approval status and posting lines.',
        recordIdSchema,
        proposalView,
        (actor, _, body) => service.queries.proposal(actor, body.id),
      ),
      'journals.list': define(
        'Read immutable journal entries; cursor is the last journal number.',
        journalPage,
        pageOutput(journalOutput),
        (actor, _, body) => service.queries.journals(actor, body),
      ),
      'bank.movements': define(
        'Read bank movements with date and matched-status filters.',
        movementPage,
        pageOutput(movementOutput),
        (actor, _, body) => service.queries.movements(actor, body),
      ),
      'statements.list': define(
        'Read bank statement metadata and exact opening/closing amounts.',
        pageInput,
        pageOutput(statementOutput),
        (actor, _, body) => service.queries.statements(actor, body),
      ),
      'jobs.list': define(
        'Read export job states without their private payloads.',
        pageInput,
        pageOutput(jobOutput),
        (actor, _, body) => service.queries.jobs(actor, body),
      ),
      'activity.list': define(
        'Read company audit events; cursor is the last event number.',
        pageInput,
        pageOutput(
          z.object({
            id: z.number().int(),
            companyId: idSchema,
            actorId: z.string(),
            action: z.string(),
            body: z.json(),
            createdAt: z.string(),
          }),
        ),
        (actor, _, body) => service.queries.activity(actor, body),
      ),
      'books.proposeOpening': define(
        'Prepare the supported positive January bank/capital opening position.',
        openingSchema,
        proposalOutput,
        (actor, key, body) => service.books.proposeOpening(actor, key, body),
      ),
      'books.proposePurchase': define(
        'Prepare a domestic RON non-VAT service purchase in one accounting month.',
        purchaseSchema,
        proposalOutput,
        (actor, key, body) => service.books.proposePurchase(actor, key, body),
      ),
      'books.revisePurchase': define(
        'Revise an unposted purchase and invalidate its previous approval.',
        purchaseSchema.extend({ id: idSchema, version: z.number().int().positive() }).strict(),
        proposalOutput,
        (actor, key, { id, version, ...body }) =>
          service.books.proposePurchase(actor, key, body, { id, version }),
      ),
      'books.approve': define(
        'Human authorization of the exact proposal version and hash.',
        proposalReviewInput,
        approvalOutput,
        (actor, key, { id, ...body }) => service.books.approve(actor, key, id, body),
      ),
      'books.post': define(
        'Post the exact human-approved opening or purchase. Never grants approval.',
        proposalReviewInput,
        postingOutput,
        (actor, key, { id, ...body }) => service.books.post(actor, key, id, body),
      ),
      'corrections.propose': define(
        'Prepare a linked current-year purchase correction or full reversal.',
        correctionSchema,
        proposalOutput,
        (actor, key, body) => service.corrections.propose(actor, key, body),
      ),
      'corrections.revise': define(
        'Revise an unposted correction, invalidating its previous approval.',
        correctionSchema.safeExtend({ id: idSchema, version: z.number().int().positive() }),
        proposalOutput,
        (actor, key, { id, version, ...body }) =>
          service.corrections.propose(actor, key, body, { id, version }),
      ),
      'corrections.withdraw': define(
        'Withdraw the exact unposted correction version.',
        proposalReviewInput,
        recordIdSchema,
        (actor, key, { id, ...body }) => service.corrections.withdraw(actor, key, id, body),
      ),
      'corrections.post': define(
        'Execute the exact human-approved correction and retain the original entry.',
        proposalReviewInput,
        recordIdSchema,
        (actor, key, { id, ...body }) => service.corrections.post(actor, key, id, body),
      ),
      'bank.importStatement': define(
        'Import retained bounded CSV evidence with exact statement arithmetic.',
        statementSchema,
        recordIdSchema,
        (actor, key, body) => service.bank.importStatement(actor, key, body),
      ),
      'bank.importFile': define(
        'Import retained complete RON MT940 or camt.053 statements into configured accounts. Preserve booking/value dates, original bank references and entry details; no posting or payment authority.',
        bankFileInput,
        bankFileOutput,
        (actor, key, body) => service.bankFiles.import(actor, key, body),
      ),
      'bank.file': define(
        'Read a retained bank-file manifest and original statement identities.',
        bankFileReadInput,
        bankFileOutput,
        (actor, _, body) => service.bankFiles.get(actor, body),
      ),
      'bank.statementEntries': define(
        'Read booked bank entries with value dates, references, charges and transaction details. Cursor is the last source ordinal; nested details are not additional movements.',
        bankStatementEntryPage,
        bankStatementEntriesOutput,
        (actor, _, body) => service.bankFiles.entries(actor, body),
      ),
      'bank.match': define(
        'Human confirmation of a payment allocation. Agents use reviews.request and reviews.execute.',
        matchSchema,
        recordIdSchema,
        (actor, key, body) => service.bank.match(actor, key, body),
      ),
      'periods.close': define(
        'Human confirmation to lock a reconciled month. Agents use reviewed execution.',
        z.object({ month: monthSchema }).strict(),
        periodOutput,
        (actor, key, body) => service.periods.close(actor, key, body.month),
      ),
      'reviews.request': define(
        'Prepare a payment match, month close or subscription calendar with an exact state-bound effect snapshot.',
        actionRequestSchema,
        reviewOutput,
        (actor, key, body) => service.reviews.request(actor, key, body),
      ),
      'reviews.list': define(
        'Read pending, approved, executed or superseded action reviews with exact effects.',
        reviewPage,
        pageOutput(reviewOutput),
        (actor, _, body) => service.queries.reviews(actor, body),
      ),
      'reviews.approve': define(
        'Human authorization of the exact action snapshot, after checking it is still current.',
        actionReviewSchema,
        reviewOutput,
        (actor, key, body) => service.reviews.approve(actor, key, body),
      ),
      'reviews.reject': define(
        'Human rejection of an exact subscription schedule review, with a retained reason. The original plan and records remain intact.',
        rejectReviewSchema,
        reviewOutput,
        (actor, key, body) => service.reviews.reject(actor, key, body),
      ),
      'reviews.execute': define(
        'Execute a human-approved payment match, month close or subscription calendar after rechecking its exact snapshot.',
        actionReviewSchema,
        reviewOutput,
        (actor, key, body) => service.reviews.execute(actor, key, body),
      ),
      'exports.request': define(
        'Freeze a complete accounting/evidence export for the durable worker.',
        emptySchema,
        z.object({ id: idSchema, status: z.literal('pending') }),
        (actor, key) => service.exports.request(actor, key),
      ),
      'exports.download': define(
        'Retrieve the completed export hash, size and authenticated download path.',
        recordIdSchema,
        z.object({ hash: hashSchema, size: z.number().int(), downloadPath: z.string() }),
        async (actor, _, body) => {
          const { hash, bytes } = await service.exports.download(actor, body.id);
          return {
            hash,
            size: bytes.length,
            downloadPath: `/api/accounting/v1/companies/${actor.companyId}/exports/${body.id}`,
          };
        },
      ),
      'company.invite': define(
        'Create a company invitation. Human company owners only.',
        inviteSchema,
        z.object({ id: idSchema, expiresInHours: z.number().int(), token: z.string() }),
        (actor, key, body) => service.companies.invite(actor, key, body),
      ),
      'company.revoke': define(
        'Revoke a member. Human company owners only.',
        z.object({ id: z.string().min(1).max(128) }).strict(),
        z.object({ revoked: z.literal(true) }),
        (actor, key, body) => service.companies.revoke(actor, key, body.id),
      ),
      'agents.issue': define(
        'Issue a scoped expiring accounting credential, separate from AI-provider keys.',
        issueAgentSchema,
        grantOutput.extend({ token: z.string() }),
        (actor, key, body) => service.agents.issue(actor, key, body),
      ),
      'agents.list': define(
        'List delegated grants without credential hashes or secrets.',
        pageInput,
        pageOutput(grantOutput),
        (actor, _, body) => service.agents.list(actor, body),
      ),
      'agents.revoke': define(
        'Revoke a delegated grant, including cached commands and queued exports.',
        recordIdSchema,
        z.object({ id: idSchema, revoked: z.literal(true) }),
        (actor, key, body) => service.agents.revoke(actor, key, body.id),
      ),
    };
  }

  async list(actor: Actor) {
    return this.service.db.read(async (tx) => {
      const role = await authorize(tx, actor, 'read', 'capabilities.list');
      const [grant] = actor.agentId
        ? await tx.select().from(agentGrants).where(eq(agentGrants.id, actor.agentId))
        : [];
      return {
        version: '1' as const,
        capabilities: Object.entries(this.definitions).flatMap(([id, definition]) => {
          const policy = capabilityPolicy[id as CapabilityId];
          if (
            !roleAllows(role, policy.permission) ||
            (grant && (!policy.agent || (id !== 'capabilities.list' && !grant.scopes.includes(id))))
          )
            return [];
          return [
            {
              id,
              description: definition.description,
              ...policy,
              status: 'implemented' as const,
              inputSchema: z.toJSONSchema(definition.input, { io: 'input' }),
              outputSchema: z.toJSONSchema(definition.output, { io: 'input' }),
            },
          ];
        }),
      };
    });
  }

  async invoke(actor: Actor, id: string, key: string, input: unknown) {
    const definition = Object.hasOwn(this.definitions, id)
      ? this.definitions[id as CapabilityId]
      : undefined;
    requireCondition(definition, 'CAPABILITY_NOT_FOUND', 'Capabilitatea nu este disponibilă.', 404);
    const policy = capabilityPolicy[id as CapabilityId];
    await authorize(this.service.db.orm, actor, policy.permission, id);
    return definition.invoke(actor, key, input);
  }
}
