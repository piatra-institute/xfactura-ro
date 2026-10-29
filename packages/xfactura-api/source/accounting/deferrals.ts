import { and, asc, eq, exists, gt, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { Commands, type Actor } from './commands';
import {
  dateSchema,
  deferralInput,
  deferralReleaseInput,
  deferralCreditInput,
  deferralDiscountInput,
  deferralScopeReductionInput,
  deferralSupplementInput,
  idSchema,
  requireCondition,
} from './domain';
import {
  deferralPostings,
  deferralReleases,
  deferralCancellations,
  deferralSupplements,
  invoiceDocuments,
  invoicePostings,
  journals,
  proposals,
} from './schema';
import { generalBody, retainGeneralProposal } from './general-ledger';
import {
  checkDeferralHorizon,
  interpretDeferralInvoice,
  interpretDeferralRelease,
} from './deferral-interpretation';
import { deferralView, loadDeferrals } from './deferral-state';
import { financialYearForDate } from './foundation';
import { deferralControls } from './deferral-controls';
import { interpretDeferralCredit } from './deferral-credits';
import { interpretDeferralDiscount } from './deferral-discounts';
import { attachDeferralSupplement } from './deferral-supplements';

export const deferralReadInput = z.object({ id: idSchema, date: dateSchema }).strict();
export const deferralPageInput = z
  .object({
    date: dateSchema,
    direction: z.enum(['purchase', 'sale']).optional(),
    onlyOpen: z.boolean().default(true),
    limit: z.number().int().min(1).max(100).default(25),
    cursor: idSchema.optional(),
    parentDeferralId: idSchema.optional(),
  })
  .strict();
export const deferralReconcileInput = z
  .object({ financialYearId: idSchema, date: dateSchema })
  .strict();

export class Deferrals {
  constructor(private readonly runner: Commands) {}
  proposeSupplement(
    actor: Actor,
    key: string,
    input: unknown,
    revision?: { id: string; version: number },
  ) {
    const body = deferralSupplementInput.parse(input);
    return this.runner.run(
      actor,
      key,
      revision ? 'deferrals.reviseSupplement' : 'deferrals.proposeSupplement',
      { body, revision: revision ?? null },
      'write',
      async (tx) => {
        const [posted] = await tx
          .select()
          .from(invoicePostings)
          .where(
            and(
              eq(invoicePostings.companyId, actor.companyId),
              eq(invoicePostings.invoiceId, body.invoiceId),
            ),
          );
        requireCondition(
          !posted,
          'INVOICE_ALREADY_POSTED',
          'Factura este deja contabilizată.',
          409,
        );
        const { parentDeferralId, changeBasis, ...invoiceInput } = body;
        const interpreted = await interpretDeferralInvoice(tx, actor, invoiceInput, 'supplement');
        const result = await attachDeferralSupplement(tx, actor, interpreted, {
          parentDeferralId,
          changeBasis,
        });
        await checkDeferralHorizon(tx, actor, result);
        return retainGeneralProposal(
          tx,
          actor,
          generalBody({
            financialYearId: body.financialYearId,
            evidenceId: result.invoice.evidenceId,
            date: body.recognitionDate,
            purpose: result.invoice.direction,
            description: `Servicii suplimentare · ${result.invoice.body.number}`,
            sourceReference: `invoice:${result.invoice.id}`,
            lines: result.lines,
            invoice: result.treatment,
          }),
          revision,
        );
      },
    );
  }
  proposeScopeReduction(
    actor: Actor,
    key: string,
    input: unknown,
    revision?: { id: string; version: number },
  ) {
    const body = deferralScopeReductionInput.parse(input);
    return this.runner.run(
      actor,
      key,
      revision ? 'deferrals.reviseScopeReduction' : 'deferrals.proposeScopeReduction',
      { body, revision: revision ?? null },
      'write',
      async (tx) => {
        const result = await interpretDeferralCredit(tx, actor, body);
        return retainGeneralProposal(
          tx,
          actor,
          generalBody({
            financialYearId: body.financialYearId,
            evidenceId: result.invoice.evidenceId,
            date: body.recognitionDate,
            purpose: result.invoice.direction,
            description: `Diminuare servicii viitoare · ${result.invoice.body.number}`,
            sourceReference: `invoice:${result.invoice.id}`,
            lines: result.lines,
            invoice: result.treatment,
          }),
          revision,
        );
      },
    );
  }
  proposeDiscount(
    actor: Actor,
    key: string,
    input: unknown,
    revision?: { id: string; version: number },
  ) {
    const body = deferralDiscountInput.parse(input);
    return this.runner.run(
      actor,
      key,
      revision ? 'deferrals.reviseDiscount' : 'deferrals.proposeDiscount',
      { body, revision: revision ?? null },
      'write',
      async (tx) => {
        const result = await interpretDeferralDiscount(tx, actor, body);
        return retainGeneralProposal(
          tx,
          actor,
          generalBody({
            financialYearId: body.financialYearId,
            evidenceId: result.invoice.evidenceId,
            date: body.recognitionDate,
            purpose: result.invoice.direction,
            description: `Reducere comercială abonament · ${result.invoice.body.number}`,
            sourceReference: `invoice:${result.invoice.id}`,
            lines: result.lines,
            invoice: result.treatment,
          }),
          revision,
        );
      },
    );
  }
  proposeCreditNote(
    actor: Actor,
    key: string,
    input: unknown,
    revision?: { id: string; version: number },
  ) {
    const body = deferralCreditInput.parse(input);
    return this.runner.run(
      actor,
      key,
      revision ? 'deferrals.reviseCreditNote' : 'deferrals.proposeCreditNote',
      { body, revision: revision ?? null },
      'write',
      async (tx) => {
        const result = await interpretDeferralCredit(tx, actor, body);
        return retainGeneralProposal(
          tx,
          actor,
          generalBody({
            financialYearId: body.financialYearId,
            evidenceId: result.invoice.evidenceId,
            date: body.recognitionDate,
            purpose: result.invoice.direction,
            description: `Anulare abonament · ${result.invoice.body.number}`,
            sourceReference: `invoice:${result.invoice.id}`,
            lines: result.lines,
            invoice: result.treatment,
          }),
          revision,
        );
      },
    );
  }
  proposeInvoice(
    actor: Actor,
    key: string,
    input: unknown,
    revision?: { id: string; version: number },
  ) {
    const body = deferralInput.parse(input);
    return this.runner.run(
      actor,
      key,
      revision ? 'deferrals.reviseInvoice' : 'deferrals.proposeInvoice',
      { body, revision: revision ?? null },
      'write',
      async (tx) => {
        const [posted] = await tx
          .select({ id: invoicePostings.invoiceId })
          .from(invoicePostings)
          .where(
            and(
              eq(invoicePostings.companyId, actor.companyId),
              eq(invoicePostings.invoiceId, body.invoiceId),
            ),
          );
        requireCondition(
          !posted,
          'INVOICE_ALREADY_POSTED',
          'Factura este deja contabilizată; nu poate fi recunoscută din nou.',
          409,
        );
        const result = await interpretDeferralInvoice(tx, actor, body);
        await checkDeferralHorizon(tx, actor, result);
        const description =
          body.method !== 'equal_calendar_months'
            ? result.invoice.direction === 'purchase'
              ? 'Servicii achiziționate'
              : 'Servicii facturate'
            : result.invoice.direction === 'purchase'
              ? 'Abonament achiziționat'
              : 'Abonament facturat';
        return retainGeneralProposal(
          tx,
          actor,
          generalBody({
            financialYearId: body.financialYearId,
            evidenceId: result.invoice.evidenceId,
            date: body.recognitionDate,
            purpose: result.invoice.direction,
            description: `${description} · ${result.invoice.body.number}`,
            sourceReference: `invoice:${result.invoice.id}`,
            lines: result.lines,
            invoice: result.treatment,
          }),
          revision,
        );
      },
    );
  }
  proposeRelease(
    actor: Actor,
    key: string,
    input: unknown,
    revision?: { id: string; version: number },
  ) {
    const body = deferralReleaseInput.parse(input);
    return this.runner.run(
      actor,
      key,
      revision ? 'deferrals.reviseRelease' : 'deferrals.proposeRelease',
      { body, revision: revision ?? null },
      'write',
      async (tx) => {
        const result = await interpretDeferralRelease(tx, actor, body);
        return retainGeneralProposal(
          tx,
          actor,
          generalBody({
            financialYearId: body.financialYearId,
            evidenceId:
              result.treatment.benefitEvidence?.evidenceId ??
              result.state.interpretation.treatmentEvidenceId,
            date: result.treatment.date,
            purpose: 'general',
            description: `${result.treatment.direction === 'purchase' ? 'Cheltuială aferentă perioadei' : 'Venit aferent perioadei'} · ${result.state.invoice.body.number} · ${body.month.slice(0, 7)}`,
            sourceReference: `deferral-release:${body.deferralId}:${body.month}`,
            lines: result.lines,
            deferralRelease: result.treatment,
          }),
          revision,
        );
      },
    );
  }
  get(actor: Actor, input: unknown) {
    const body = deferralReadInput.parse(input);
    return this.runner.read(
      actor,
      async (tx) => {
        const [state] = await loadDeferrals(tx, actor.companyId, [body.id]);
        requireCondition(
          state && state.journal.date <= body.date,
          'NOT_FOUND',
          'Alocarea nu este disponibilă la această dată.',
          404,
        );
        return deferralView(state, body.date);
      },
      'deferrals.get',
    );
  }
  list(actor: Actor, input: unknown) {
    const body = deferralPageInput.parse(input);
    return this.runner.read(
      actor,
      async (tx) => {
        const used = tx
          .select({ amount: sql`coalesce(sum(${deferralReleases.amountBani}),0)` })
          .from(deferralReleases)
          .innerJoin(
            journals,
            and(
              eq(journals.companyId, deferralReleases.companyId),
              eq(journals.id, deferralReleases.journalId),
            ),
          )
          .where(
            and(
              eq(deferralReleases.companyId, deferralPostings.companyId),
              eq(deferralReleases.deferralId, deferralPostings.deferralId),
              lte(journals.date, body.date),
            ),
          );
        const cancelled = tx
          .select({ amount: sql`coalesce(sum(${deferralCancellations.amountBani}),0)` })
          .from(deferralCancellations)
          .innerJoin(
            journals,
            and(
              eq(journals.companyId, deferralCancellations.companyId),
              eq(journals.id, deferralCancellations.journalId),
            ),
          )
          .where(
            and(
              eq(deferralCancellations.companyId, deferralPostings.companyId),
              eq(deferralCancellations.deferralId, deferralPostings.deferralId),
              lte(journals.date, body.date),
            ),
          );
        const rows = await tx
          .select({ id: deferralPostings.deferralId })
          .from(deferralPostings)
          .innerJoin(
            journals,
            and(
              eq(journals.companyId, deferralPostings.companyId),
              eq(journals.id, deferralPostings.journalId),
            ),
          )
          .innerJoin(
            proposals,
            and(
              eq(proposals.companyId, deferralPostings.companyId),
              eq(proposals.id, deferralPostings.deferralId),
            ),
          )
          .innerJoin(
            invoiceDocuments,
            and(
              eq(invoiceDocuments.companyId, deferralPostings.companyId),
              eq(invoiceDocuments.id, deferralPostings.invoiceId),
            ),
          )
          .where(
            and(
              eq(deferralPostings.companyId, actor.companyId),
              lte(journals.date, body.date),
              body.direction ? eq(invoiceDocuments.direction, body.direction) : undefined,
              body.cursor ? gt(deferralPostings.deferralId, body.cursor) : undefined,
              body.parentDeferralId
                ? exists(
                    tx
                      .select({ id: deferralSupplements.deferralId })
                      .from(deferralSupplements)
                      .where(
                        and(
                          eq(deferralSupplements.companyId, actor.companyId),
                          eq(deferralSupplements.deferralId, deferralPostings.deferralId),
                          eq(deferralSupplements.parentDeferralId, body.parentDeferralId),
                        ),
                      ),
                  )
                : undefined,
              body.onlyOpen
                ? sql`cast(replace(json_extract(${proposals.body}, '$.invoice.deferral.amount'),'.','') as integer)>(${used})+(${cancelled})`
                : undefined,
            ),
          )
          .orderBy(asc(deferralPostings.deferralId))
          .limit(body.limit + 1);
        const states = await loadDeferrals(
            tx,
            actor.companyId,
            rows.slice(0, body.limit).map((row) => row.id),
          ),
          byId = new Map(states.map((row) => [row.record.deferralId, row]));
        return {
          items: rows.slice(0, body.limit).map((row) => deferralView(byId.get(row.id)!, body.date)),
          nextCursor: rows.length > body.limit ? rows[body.limit - 1].id : null,
        };
      },
      'deferrals.list',
    );
  }
  reconcile(actor: Actor, input: unknown) {
    const body = deferralReconcileInput.parse(input);
    return this.runner.read(
      actor,
      async (tx) => {
        const year = await financialYearForDate(tx, actor.companyId, body.date);
        requireCondition(
          year.id === body.financialYearId,
          'FINANCIAL_YEAR',
          'Data nu aparține exercițiului selectat.',
        );
        return { ...body, ...(await deferralControls(tx, actor.companyId, year.from, body.date)) };
      },
      'deferrals.reconcile',
    );
  }
}
