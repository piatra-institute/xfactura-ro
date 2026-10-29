import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { alias } from 'drizzle-orm/sqlite-core';
import { Commands, type Actor } from './commands';
import {
  advancePaymentInput,
  advanceInvoiceInput,
  advanceFinalInput,
  advanceCreditInput,
  advanceRefundInput,
  dateSchema,
  idSchema,
  requireCondition,
} from './domain';
import {
  advancePayments,
  advanceInvoices,
  advanceInvoiceMatches,
  advanceRefunds,
  advanceUses,
  invoiceCredits,
  invoiceDocuments,
  journals,
  proposals,
} from './schema';
import { generalBody, retainGeneralProposal } from './general-ledger';
import { interpretAdvancePayment, interpretAdvanceInvoice } from './advance-interpretation';
import { interpretAdvanceFinal } from './advance-final';
import { interpretAdvanceCredit } from './advance-credits';
import { interpretAdvanceRefund } from './advance-refunds';
import {
  advancePaymentView,
  advanceInvoiceView,
  loadAdvancePayments,
  loadAdvanceInvoices,
} from './advance-state';
import { advanceControls } from './advance-controls';
import { financialYearForDate } from './foundation';

export const advanceReadInput = z.object({ invoiceId: idSchema, date: dateSchema }).strict();
export const advancePaymentReadInput = z.object({ id: idSchema, date: dateSchema }).strict();
export const advancePageInput = z
  .object({
    date: dateSchema,
    direction: z.enum(['purchase', 'sale']).optional(),
    onlyOpen: z.boolean().default(true),
    limit: z.number().int().min(1).max(100).default(25),
    cursor: idSchema.optional(),
  })
  .strict();
export const advanceReconcileInput = z
  .object({ financialYearId: idSchema, date: dateSchema })
  .strict();
type Revision = { id: string; version: number };
export class Advances {
  constructor(private readonly runner: Commands) {}
  proposePayment(actor: Actor, key: string, input: unknown, revision?: Revision) {
    const body = advancePaymentInput.parse(input);
    return this.runner.run(
      actor,
      key,
      revision ? 'advances.revisePayment' : 'advances.proposePayment',
      { body, revision: revision ?? null },
      'write',
      async (tx) => {
        const r = await interpretAdvancePayment(tx, actor, body);
        return retainGeneralProposal(
          tx,
          actor,
          generalBody({
            financialYearId: body.financialYearId,
            evidenceId: r.treatment.sourceEvidenceId,
            date: r.movement.date,
            purpose: 'general',
            description: `${body.direction === 'purchase' ? 'Avans furnizor' : 'Avans client'} · ${body.reference}`,
            sourceReference: `advance-payment:${body.movementId}`,
            lines: r.lines,
            advancePayment: r.treatment,
          }),
          revision,
        );
      },
    );
  }
  proposeRefund(actor: Actor, key: string, input: unknown, revision?: Revision) {
    const body = advanceRefundInput.parse(input);
    return this.runner.run(
      actor,
      key,
      revision ? 'advances.reviseRefund' : 'advances.proposeRefund',
      { body, revision: revision ?? null },
      'write',
      async (tx) => {
        const r = await interpretAdvanceRefund(tx, actor, body);
        return retainGeneralProposal(
          tx,
          actor,
          generalBody({
            financialYearId: body.financialYearId,
            evidenceId: r.treatment.sourceEvidenceId,
            date: r.movement.date,
            purpose: 'general',
            description: 'Restituire avans nefacturat',
            sourceReference: `advance-refund:${body.movementId}`,
            lines: r.lines,
            advanceRefund: r.treatment,
          }),
          revision,
        );
      },
    );
  }
  proposeInvoice(actor: Actor, key: string, input: unknown, revision?: Revision) {
    const body = advanceInvoiceInput.parse(input);
    return this.runner.run(
      actor,
      key,
      revision ? 'advances.reviseInvoice' : 'advances.proposeInvoice',
      { body, revision: revision ?? null },
      'write',
      async (tx) => {
        const r = await interpretAdvanceInvoice(tx, actor, body);
        return retainGeneralProposal(
          tx,
          actor,
          generalBody({
            financialYearId: body.financialYearId,
            evidenceId: r.invoice.evidenceId,
            date: body.recognitionDate,
            purpose: r.invoice.direction,
            description: `Factură de avans · ${r.invoice.body.number}`,
            sourceReference: `invoice:${r.invoice.id}`,
            lines: r.lines,
            invoice: r.treatment,
          }),
          revision,
        );
      },
    );
  }
  proposeFinalInvoice(actor: Actor, key: string, input: unknown, revision?: Revision) {
    const body = advanceFinalInput.parse(input);
    return this.runner.run(
      actor,
      key,
      revision ? 'advances.reviseFinalInvoice' : 'advances.proposeFinalInvoice',
      { body, revision: revision ?? null },
      'write',
      async (tx) => {
        const r = await interpretAdvanceFinal(tx, actor, body);
        return retainGeneralProposal(
          tx,
          actor,
          generalBody({
            financialYearId: body.financialYearId,
            evidenceId: r.invoice.evidenceId,
            date: body.recognitionDate,
            purpose: r.invoice.direction,
            description: `Factură finală · ${r.invoice.body.number}`,
            sourceReference: `invoice:${r.invoice.id}`,
            lines: r.lines,
            invoice: r.treatment,
          }),
          revision,
        );
      },
    );
  }
  proposeCreditNote(actor: Actor, key: string, input: unknown, revision?: Revision) {
    const body = advanceCreditInput.parse(input);
    return this.runner.run(
      actor,
      key,
      revision ? 'advances.reviseCreditNote' : 'advances.proposeCreditNote',
      { body, revision: revision ?? null },
      'write',
      async (tx) => {
        const r = await interpretAdvanceCredit(tx, actor, body);
        return retainGeneralProposal(
          tx,
          actor,
          generalBody({
            financialYearId: body.financialYearId,
            evidenceId: r.invoice.evidenceId,
            date: body.recognitionDate,
            purpose: r.invoice.direction,
            description: `Anulare avans neutilizat · ${r.invoice.body.number}`,
            sourceReference: `invoice:${r.invoice.id}`,
            lines: r.lines,
            invoice: r.treatment,
          }),
          revision,
        );
      },
    );
  }
  getPayment(actor: Actor, input: unknown) {
    const body = advancePaymentReadInput.parse(input);
    return this.runner.read(
      actor,
      async (tx) => {
        const [state] = await loadAdvancePayments(tx, actor.companyId, [body.id]);
        requireCondition(
          state && state.journal.date <= body.date,
          'NOT_FOUND',
          'Avansul nu este disponibil la această dată.',
          404,
        );
        return advancePaymentView(state, body.date);
      },
      'advances.getPayment',
    );
  }
  get(actor: Actor, input: unknown) {
    const body = advanceReadInput.parse(input);
    return this.runner.read(
      actor,
      async (tx) => {
        const [state] = await loadAdvanceInvoices(tx, actor.companyId, [body.invoiceId]);
        requireCondition(
          state && state.journal.date <= body.date,
          'NOT_FOUND',
          'Factura de avans nu este disponibilă la această dată.',
          404,
        );
        return advanceInvoiceView(state, body.date);
      },
      'advances.get',
    );
  }
  payments(actor: Actor, input: unknown) {
    const body = advancePageInput.parse(input);
    return this.runner.read(
      actor,
      async (tx) => {
        const matchJournal = alias(journals, 'advance_match_journal');
        const matchedGross = tx
          .select({ amount: sql<bigint>`coalesce(sum(${advanceInvoiceMatches.grossBani}),0)` })
          .from(advanceInvoiceMatches)
          .innerJoin(
            matchJournal,
            and(
              eq(matchJournal.companyId, advanceInvoiceMatches.companyId),
              eq(matchJournal.id, advanceInvoiceMatches.journalId),
            ),
          )
          .where(
            and(
              eq(advanceInvoiceMatches.companyId, advancePayments.companyId),
              eq(advanceInvoiceMatches.paymentId, advancePayments.paymentId),
              lte(matchJournal.date, body.date),
            ),
          );
        const refundJournal = alias(journals, 'advance_refund_journal'),
          refundProposal = alias(proposals, 'advance_refund_proposal');
        const refundedGross = tx
          .select({
            amount: sql<bigint>`coalesce(sum(cast(replace(json_extract(${refundProposal.body},'$.advanceRefund.gross'),'.','') as integer)),0)`,
          })
          .from(advanceRefunds)
          .innerJoin(
            refundJournal,
            and(
              eq(refundJournal.companyId, advanceRefunds.companyId),
              eq(refundJournal.id, advanceRefunds.journalId),
            ),
          )
          .innerJoin(
            refundProposal,
            and(
              eq(refundProposal.companyId, advanceRefunds.companyId),
              eq(refundProposal.id, advanceRefunds.proposalId),
            ),
          )
          .where(
            and(
              eq(advanceRefunds.companyId, advancePayments.companyId),
              eq(advanceRefunds.paymentId, advancePayments.paymentId),
              lte(refundJournal.date, body.date),
            ),
          );
        const resolved = sql`${matchedGross}+${refundedGross}>=cast(replace(json_extract(${proposals.body},'$.advancePayment.gross'),'.','') as integer)`;
        const rows = await tx
          .select({ id: advancePayments.paymentId })
          .from(advancePayments)
          .innerJoin(
            journals,
            and(
              eq(journals.companyId, advancePayments.companyId),
              eq(journals.id, advancePayments.journalId),
            ),
          )
          .innerJoin(
            proposals,
            and(
              eq(proposals.companyId, advancePayments.companyId),
              eq(proposals.id, advancePayments.paymentId),
            ),
          )
          .where(
            and(
              eq(advancePayments.companyId, actor.companyId),
              lte(journals.date, body.date),
              body.cursor ? gt(advancePayments.paymentId, body.cursor) : undefined,
              body.direction
                ? sql`json_extract(${proposals.body},'$.advancePayment.direction')=${body.direction}`
                : undefined,
              body.onlyOpen ? sql`not ${resolved}` : undefined,
            ),
          )
          .orderBy(asc(advancePayments.paymentId))
          .limit(body.limit + 1);
        const states = await loadAdvancePayments(
            tx,
            actor.companyId,
            rows.slice(0, body.limit).map((row) => row.id),
          ),
          byId = new Map(states.map((row) => [row.record.paymentId, row]));
        return {
          items: rows
            .slice(0, body.limit)
            .map((row) => advancePaymentView(byId.get(row.id)!, body.date)),
          nextCursor: rows.length > body.limit ? rows[body.limit - 1].id : null,
        };
      },
      'advances.payments',
    );
  }
  list(actor: Actor, input: unknown) {
    const body = advancePageInput.parse(input);
    return this.runner.read(
      actor,
      async (tx) => {
        const used = tx
          .select({ amount: sql`coalesce(sum(${advanceUses.netBani}),0)` })
          .from(advanceUses)
          .innerJoin(
            journals,
            and(
              eq(journals.companyId, advanceUses.companyId),
              eq(journals.id, advanceUses.journalId),
            ),
          )
          .where(
            and(
              eq(advanceUses.companyId, advanceInvoices.companyId),
              eq(advanceUses.advanceInvoiceId, advanceInvoices.invoiceId),
              lte(journals.date, body.date),
            ),
          );
        const credited = tx
          .select({ amount: sql`coalesce(sum(${invoiceCredits.netBani}),0)` })
          .from(invoiceCredits)
          .innerJoin(
            journals,
            and(
              eq(journals.companyId, invoiceCredits.companyId),
              eq(journals.id, invoiceCredits.journalId),
            ),
          )
          .where(
            and(
              eq(invoiceCredits.companyId, advanceInvoices.companyId),
              eq(invoiceCredits.originalInvoiceId, advanceInvoices.invoiceId),
              lte(journals.date, body.date),
            ),
          );
        const rows = await tx
          .select({ id: advanceInvoices.invoiceId })
          .from(advanceInvoices)
          .innerJoin(
            journals,
            and(
              eq(journals.companyId, advanceInvoices.companyId),
              eq(journals.id, advanceInvoices.journalId),
            ),
          )
          .innerJoin(
            proposals,
            and(
              eq(proposals.companyId, advanceInvoices.companyId),
              eq(proposals.id, advanceInvoices.proposalId),
            ),
          )
          .innerJoin(
            invoiceDocuments,
            and(
              eq(invoiceDocuments.companyId, advanceInvoices.companyId),
              eq(invoiceDocuments.id, advanceInvoices.invoiceId),
            ),
          )
          .where(
            and(
              eq(advanceInvoices.companyId, actor.companyId),
              lte(journals.date, body.date),
              body.cursor ? gt(advanceInvoices.invoiceId, body.cursor) : undefined,
              body.direction ? eq(invoiceDocuments.direction, body.direction) : undefined,
              body.onlyOpen
                ? sql`cast(replace(json_extract(${proposals.body},'$.invoice.net'),'.','') as integer)>(${used})+(${credited})`
                : undefined,
            ),
          )
          .orderBy(asc(advanceInvoices.invoiceId))
          .limit(body.limit + 1);
        const states = await loadAdvanceInvoices(
            tx,
            actor.companyId,
            rows.slice(0, body.limit).map((row) => row.id),
          ),
          byId = new Map(states.map((row) => [row.invoice.id, row]));
        return {
          items: rows
            .slice(0, body.limit)
            .map((row) => advanceInvoiceView(byId.get(row.id)!, body.date)),
          nextCursor: rows.length > body.limit ? rows[body.limit - 1].id : null,
        };
      },
      'advances.list',
    );
  }
  reconcile(actor: Actor, input: unknown) {
    const body = advanceReconcileInput.parse(input);
    return this.runner.read(
      actor,
      async (tx) => {
        const year = await financialYearForDate(tx, actor.companyId, body.date);
        requireCondition(
          year.id === body.financialYearId,
          'FINANCIAL_YEAR',
          'Data nu aparține exercițiului selectat.',
        );
        return { ...body, ...(await advanceControls(tx, actor.companyId, year.from, body.date)) };
      },
      'advances.reconcile',
    );
  }
}
