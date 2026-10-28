import { and, eq } from 'drizzle-orm';
import type { Transaction } from './db';
import type { Actor } from './commands';
import type { interpretDeferralInvoice } from './deferral-interpretation';
import {
  deferralSupplementSchema,
  invoiceTreatmentSchema,
  requireCondition,
  Amount,
} from './domain';
import { deferralSupplements } from './schema';
import { loadDeferrals } from './deferral-state';
import { regimesAt } from './foundation';

const identity = (value: string) => value.trim().replace(/^RO/i, '');

/** A separately invoiced addition owns its value, tax point and future benefits. */
export async function attachDeferralSupplement(
  tx: Transaction,
  actor: Actor,
  result: Awaited<ReturnType<typeof interpretDeferralInvoice>>,
  input: { parentDeferralId: string; changeBasis: 'additional_future_services' },
  posted?: { deferralId: string },
) {
  const [parent] = await loadDeferrals(tx, actor.companyId, [input.parentDeferralId]);
  requireCondition(parent, 'NOT_FOUND', 'Factura contractului nu este disponibilă.', 404);
  const invoice = result.invoice,
    doc = invoice.body,
    original = parent.invoice.body,
    plan = result.treatment.deferral!;
  requireCondition(
    invoice.id !== parent.invoice.id &&
      parent.journal.date <= result.treatment.taxPointDate &&
      invoice.direction === parent.invoice.direction &&
      doc.currency === original.currency &&
      identity(doc.supplier.taxId) === identity(original.supplier.taxId) &&
      identity(doc.customer.taxId) === identity(original.customer.taxId) &&
      result.treatment.account === parent.interpretation.account,
    'DEFERRAL_SUPPLEMENT_ORIGIN',
    'Factura suplimentară trebuie să păstreze părțile, sensul, moneda și clasificarea contractului.',
  );
  requireCondition(
    (doc.invoiceTypeCode ?? '380') === '380' &&
      doc.lines.every((row) => new Amount(row.net).gt(0)) &&
      (!doc.originalInvoiceNumber || doc.originalInvoiceNumber === original.number) &&
      (doc.invoiceReferences?.length ?? 0) <= 1,
    'DEFERRAL_SUPPLEMENT_DOCUMENT',
    'Documentați separat servicii viitoare suplimentare; avansurile și corecțiile de preț au tratamente distincte.',
  );
  requireCondition(
    plan.evidenceDate >= parent.journal.date &&
      ![parent.invoice.evidenceId, parent.interpretation.treatmentEvidenceId].includes(
        result.treatment.treatmentEvidenceId,
      ),
    'DEFERRAL_SUPPLEMENT_EVIDENCE',
    'Păstrați separat acordul care autorizează serviciile suplimentare.',
  );
  const before = await regimesAt(tx, actor.companyId, parent.interpretation.taxPointDate),
    current = await regimesAt(tx, actor.companyId, result.treatment.taxPointDate);
  requireCondition(
    before.vat?.value === current.vat?.value,
    'DEFERRAL_SUPPLEMENT_REGIME',
    'Schimbarea regimului TVA între facturi necesită un tratament distinct.',
  );
  if (posted) {
    // Later parent releases/credits do not rewrite this already posted, independent invoice.
    const [link] = await tx
      .select()
      .from(deferralSupplements)
      .where(
        and(
          eq(deferralSupplements.companyId, actor.companyId),
          eq(deferralSupplements.deferralId, posted.deferralId),
          eq(deferralSupplements.parentDeferralId, parent.record.deferralId),
        ),
      );
    requireCondition(
      link,
      'DEFERRAL_SUPPLEMENT_SOURCE',
      'Legătura facturii suplimentare nu este verificată.',
      409,
    );
  } else {
    requireCondition(
      !parent.cancellation ||
        parent.cancellation.treatment.schemaVersion !== 1 ||
        parent.cancellation.date > result.treatment.taxPointDate,
      'DEFERRAL_SUPPLEMENT_CANCELLED',
      'Un contract cu serviciile viitoare anulate necesită un nou acord de contract, separat.',
      409,
    );
  }
  const supplement = deferralSupplementSchema.parse({
    schemaVersion: 1,
    changeBasis: input.changeBasis,
    parentDeferralId: parent.record.deferralId,
    parentInvoiceId: parent.invoice.id,
    parentJournalId: parent.journal.id,
    parentFinancialYearId: parent.body.financialYearId,
    parentProposalHash: parent.proposal.hash,
  });
  return {
    ...result,
    treatment: invoiceTreatmentSchema.parse({
      ...result.treatment,
      deferral: { ...plan, supplement },
    }),
  };
}
