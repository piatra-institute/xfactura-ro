import { and, eq } from 'drizzle-orm';
import type { Transaction } from './db';
import type { Actor } from './commands';
import {
  Amount,
  canonical,
  fromBani,
  invoiceTreatmentSchema,
  requireCondition,
  toBani,
  unbilledSaleInvoiceInput,
  unbilledSaleMatchSchema,
  type GeneralBody,
  type PostingLine,
  type UnbilledSaleInvoiceInput,
} from './domain';
import { invoiceDocuments, invoicePostings } from './schema';
import { financialYearForDate, regimesAt } from './foundation';
import { loadUnbilledSales, unbilledSaleRemaining } from './unbilled-sale-state';
import { checkUnbilledSalePosting } from './unbilled-sales';

export async function interpretUnbilledSaleInvoice(
  tx: Transaction,
  actor: Actor,
  input: UnbilledSaleInvoiceInput,
) {
  const [invoice] = await tx
    .select()
    .from(invoiceDocuments)
    .where(
      and(
        eq(invoiceDocuments.companyId, actor.companyId),
        eq(invoiceDocuments.id, input.invoiceId),
      ),
    );
  requireCondition(invoice, 'NOT_FOUND', 'Factura nu este disponibilă.', 404);
  const [posted] = await tx
    .select({ id: invoicePostings.invoiceId })
    .from(invoicePostings)
    .where(
      and(
        eq(invoicePostings.companyId, actor.companyId),
        eq(invoicePostings.invoiceId, invoice.id),
      ),
    );
  requireCondition(!posted, 'INVOICE_ALREADY_POSTED', 'Factura este deja contabilizată.', 409);
  const year = await financialYearForDate(tx, actor.companyId, input.recognitionDate);
  requireCondition(
    year.id === input.financialYearId,
    'FINANCIAL_YEAR',
    'Factura nu aparține exercițiului selectat.',
  );
  const doc = invoice.body,
    totals = doc.totals;
  requireCondition(
    invoice.direction === 'sale' &&
      doc.documentType === 'invoice' &&
      doc.currency === 'RON' &&
      doc.supplier.country === 'RO' &&
      doc.customer.country === 'RO' &&
      doc.taxes.length === 1 &&
      totals.allowances === '0.00' &&
      totals.charges === '0.00' &&
      totals.prepaid === '0.00' &&
      totals.rounding === '0.00' &&
      new Amount(totals.net).gt(0),
    'UNBILLED_SALE_INVOICE_SCOPE',
    'Potriviți o factură emisă de servicii interne în RON, fără avansuri sau categorii mixte.',
  );
  requireCondition(
    doc.issueDate === input.recognitionDate,
    'UNBILLED_SALE_INVOICE_DATE',
    'Înregistrați factura emisă la data emiterii; venitul și TVA rămân în perioada prestării.',
  );
  const ids = input.allocations.map((row) => row.unbilledSaleId);
  requireCondition(
    new Set(ids).size === ids.length,
    'DUPLICATE_UNBILLED_SALE',
    'Serviciile apar o singură dată în potrivire.',
  );
  const states = await loadUnbilledSales(tx, actor.companyId, ids);
  requireCondition(
    states.length === ids.length,
    'NOT_FOUND',
    'Toate serviciile trebuie să fie contabilizate în companie.',
    404,
  );
  const first = states[0].treatment,
    tax = doc.taxes[0],
    current = await regimesAt(tx, actor.companyId, doc.issueDate);
  requireCondition(current.vat, 'NEEDS_EVIDENCE', 'Documentați statutul TVA la emiterea facturii.');
  requireCondition(
    (doc.taxPointDate ?? doc.issueDate) === first.taxPointDate &&
      tax.category === first.vatCategory &&
      (tax.rate ?? '0') === first.rate &&
      doc.lines.every(
        (line) => line.vatCategory === first.vatCategory && (line.vatRate ?? '0') === first.rate,
      ) &&
      new Amount(tax.base)
        .mul(first.rate)
        .div(100)
        .toDecimalPlaces(2, Amount.ROUND_HALF_UP)
        .eq(tax.tax),
    'UNBILLED_SALE_VAT_RATE',
    'Factura trebuie să păstreze data de exigibilitate, categoria și cota serviciilor prestate.',
  );
  const registrationIds = new Set(first.registrationIds);
  registrationIds.add(current.vat.id);
  if (current.vat.value === 'normal_vat') {
    requireCondition(
      current.vat_collection?.value === 'no',
      'UNBILLED_SALE_VAT_TRANSITION',
      'TVA la încasare necesită un tratament distinct.',
    );
    registrationIds.add(current.vat_collection.id);
  }
  const byId = new Map(states.map((state) => [state.record.unbilledSaleId, state])),
    allocations = [];
  for (const item of [...input.allocations].sort((a, b) =>
    a.unbilledSaleId.localeCompare(b.unbilledSaleId),
  )) {
    const state = byId.get(item.unbilledSaleId)!,
      old = state.treatment,
      remaining = unbilledSaleRemaining(state);
    await checkUnbilledSalePosting(tx, actor, state.body);
    const original = await regimesAt(tx, actor.companyId, old.taxPointDate);
    requireCondition(
      original.vat?.value === current.vat.value &&
        old.account === first.account &&
        old.vatCategory === first.vatCategory &&
        old.rate === first.rate &&
        old.taxPointDate === first.taxPointDate,
      'UNBILLED_SALE_VAT_TRANSITION',
      'Regimurile, conturile sau datele diferite necesită o potrivire distinctă.',
    );
    requireCondition(
      old.customer.taxId === doc.customer.taxId.replace(/^RO/i, '') &&
        old.customer.country === doc.customer.country &&
        state.journal.date <= doc.issueDate,
      'UNBILLED_SALE_INVOICE_ORIGIN',
      'Factura trebuie să identifice același client și servicii deja prestate.',
    );
    requireCondition(
      state.adjustments.every((row) => row.journal.date <= input.recognitionDate) &&
        state.matches.every((row) => row.date <= input.recognitionDate),
      'UNBILLED_SALE_EVENT_ORDER',
      'Factura nu poate preceda o reevaluare deja contabilizată.',
      409,
    );
    const net = toBani(item.net),
      allocatedTax = toBani(item.tax),
      gross = net + allocatedTax;
    requireCondition(
      net > 0n &&
        new Amount(item.net)
          .mul(old.rate)
          .div(100)
          .toDecimalPlaces(2, Amount.ROUND_HALF_UP)
          .eq(item.tax),
      'UNBILLED_SALE_ALLOCATION',
      'Baza și TVA alocate trebuie să corespundă cotei documentate.',
    );
    requireCondition(
      net <= remaining.net && allocatedTax <= remaining.tax && gross <= remaining.gross,
      'UNBILLED_SALE_OVER_MATCH',
      'Potrivirea depășește soldul serviciilor; diferențele cer un tratament distinct.',
      409,
    );
    allocations.push({
      unbilledSaleId: item.unbilledSaleId,
      originalJournalId: state.journal.id,
      originalFinancialYearId: state.body.financialYearId,
      proposalHash: state.proposal.hash,
      positionHash: state.hash,
      positionVersion: state.matches.length + state.adjustments.length,
      ...(state.adjustments.length
        ? { latestAdjustmentJournalId: state.adjustments.at(-1)!.journal.id }
        : {}),
      reference: old.reference,
      availableGross: fromBani(remaining.gross),
      remainingGross: fromBani(remaining.gross - gross),
      net: item.net,
      tax: item.tax,
      gross: fromBani(gross),
    });
  }
  requireCondition(
    allocations.reduce((sum, row) => sum + toBani(row.net), 0n) === toBani(totals.net) &&
      allocations.reduce((sum, row) => sum + toBani(row.tax), 0n) === toBani(totals.tax),
    'UNBILLED_SALE_INVOICE_TOTAL',
    'Serviciile selectate trebuie să explice întreaga bază și TVA ale facturii.',
  );
  const treatment = invoiceTreatmentSchema.parse({
    invoiceId: invoice.id,
    invoiceHash: invoice.hash,
    treatmentEvidenceId: first.evidenceId,
    direction: 'sale',
    serviceDate: first.serviceTo,
    taxPointDate: first.taxPointDate,
    deduction: 'none',
    counterpartyVatCollection: 'no',
    account: first.account,
    registrationIds: [...registrationIds],
    ruleId: first.ruleId,
    ruleHash: first.ruleHash,
    net: totals.net,
    tax: totals.tax,
    gross: totals.gross,
    deductibleTax: '0.00',
    unbilledSaleMatch: unbilledSaleMatchSchema.parse({ schemaVersion: 1, allocations }),
  });
  const lines: PostingLine[] = [
    { account: '4111', debit: totals.gross, credit: '0.00' },
    { account: '418', debit: '0.00', credit: totals.gross },
  ];
  return { invoice, treatment, lines };
}

export async function checkUnbilledSaleInvoicePosting(
  tx: Transaction,
  actor: Actor,
  body: GeneralBody,
) {
  const treatment = body.invoice;
  if (!treatment?.unbilledSaleMatch) return false;
  requireCondition(
    !treatment.credit &&
      !treatment.accrualMatch &&
      !body.accrual &&
      !body.unbilledSale &&
      !body.settlement,
    'MULTIPLE_ORIGINS',
    'Potrivirea facturii are o singură origine contabilă.',
  );
  const expected = await interpretUnbilledSaleInvoice(
    tx,
    actor,
    unbilledSaleInvoiceInput.parse({
      financialYearId: body.financialYearId,
      invoiceId: treatment.invoiceId,
      recognitionDate: body.date,
      allocations: treatment.unbilledSaleMatch.allocations.map(({ unbilledSaleId, net, tax }) => ({
        unbilledSaleId,
        net,
        tax,
      })),
    }),
  );
  requireCondition(
    canonical(expected.treatment) === canonical(treatment) &&
      canonical(expected.lines) === canonical(body.lines) &&
      body.purpose === 'sale' &&
      body.evidenceId === expected.invoice.evidenceId &&
      body.sourceReference === `invoice:${expected.invoice.id}`,
    'STALE_UNBILLED_SALE_MATCH',
    'Soldurile sau tratamentul serviciilor s-au schimbat. Revizuiți potrivirea.',
    409,
  );
  return true;
}
