import { and, eq } from 'drizzle-orm';
import type { Transaction } from './db';
import type { Actor } from './commands';
import {
  Amount,
  accrualInvoiceInput,
  accrualInvoiceMatchSchema,
  canonical,
  fromBani,
  invoiceTreatmentSchema,
  requireCondition,
  toBani,
  type AccrualInvoiceInput,
  type GeneralBody,
  type PostingLine,
} from './domain';
import { accrualRemaining, loadAccruals } from './accrual-state';
import { checkAccrualPosting } from './accruals';
import { evidence, invoiceDocuments, invoicePostings } from './schema';
import { financialYearForDate, regimesAt } from './foundation';

export async function interpretAccrualInvoice(
  tx: Transaction,
  actor: Actor,
  input: AccrualInvoiceInput,
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
    'Factura nu aparține exercițiului de primire selectat.',
  );
  const doc = invoice.body,
    totals = doc.totals;
  requireCondition(
    invoice.direction === 'purchase' &&
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
    'ACCRUAL_INVOICE_SCOPE',
    'Potriviți o factură internă de servicii în RON, fără avansuri sau categorii mixte.',
  );
  requireCondition(
    doc.issueDate <= input.receivedDate &&
      input.receivedDate <= input.recognitionDate &&
      input.receivedDate.slice(0, 7) === input.recognitionDate.slice(0, 7),
    'INVOICE_RECEIPT_DATE',
    'Documentați primirea facturii în luna înregistrării, după data emiterii.',
  );
  const [receipt] = await tx
    .select({ id: evidence.id })
    .from(evidence)
    .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, input.receiptEvidenceId)));
  requireCondition(receipt, 'NOT_FOUND', 'Documentul primirii facturii nu este disponibil.', 404);
  const ids = input.allocations.map((item) => item.accrualId);
  requireCondition(
    new Set(ids).size === ids.length,
    'DUPLICATE_ACCRUAL',
    'Un angajament apare o singură dată în potrivire.',
  );
  const states = await loadAccruals(tx, actor.companyId, ids);
  requireCondition(
    states.length === ids.length,
    'NOT_FOUND',
    'Toate angajamentele trebuie să fie contabilizate în companie.',
    404,
  );
  const first = states[0].treatment,
    tax = doc.taxes[0];
  const current = await regimesAt(tx, actor.companyId, input.receivedDate);
  requireCondition(
    current.vat,
    'NEEDS_EVIDENCE',
    'Este necesar statutul TVA documentat la primirea facturii.',
  );
  requireCondition(
    tax.category === first.vatCategory &&
      (tax.rate ?? '0') === first.rate &&
      doc.lines.every(
        (line) => line.vatCategory === first.vatCategory && (line.vatRate ?? '0') === first.rate,
      ) &&
      (!doc.taxPointDate || doc.taxPointDate === first.taxPointDate) &&
      new Amount(tax.base)
        .mul(first.rate)
        .div(100)
        .toDecimalPlaces(2, Amount.ROUND_HALF_UP)
        .eq(tax.tax),
    'ACCRUAL_VAT_RATE',
    'Factura trebuie să păstreze categoria, cota și data de exigibilitate ale serviciilor recunoscute.',
  );
  const byId = new Map(states.map((state) => [state.record.accrualId, state]));
  const registrationIds = new Set(first.registrationIds);
  registrationIds.add(current.vat.id);
  if (current.vat.value === 'normal_vat') {
    requireCondition(
      current.vat_collection?.value === 'no',
      'ACCRUAL_VAT_TRANSITION',
      'TVA la încasare necesită un tratament distinct.',
    );
    registrationIds.add(current.vat_collection.id);
  }
  const allocations = [];
  for (const item of [...input.allocations].sort((a, b) =>
    a.accrualId.localeCompare(b.accrualId),
  )) {
    const state = byId.get(item.accrualId)!,
      old = state.treatment,
      remaining = accrualRemaining(state);
    await checkAccrualPosting(tx, actor, state.body);
    const originalRegistration = await regimesAt(tx, actor.companyId, old.taxPointDate);
    requireCondition(
      originalRegistration.vat?.value === current.vat.value &&
        old.account === first.account &&
        old.deduction === first.deduction &&
        old.vatCategory === first.vatCategory &&
        old.rate === first.rate &&
        old.taxPointDate === first.taxPointDate,
      'ACCRUAL_VAT_TRANSITION',
      'Regimurile, conturile sau datele diferite necesită o potrivire distinctă.',
    );
    requireCondition(
      old.supplier.taxId === doc.supplier.taxId.replace(/^RO/i, '') &&
        old.supplier.country === doc.supplier.country &&
        state.journal.date <= input.recognitionDate &&
        state.journal.date <= input.receivedDate &&
        old.serviceTo <= doc.issueDate,
      'ACCRUAL_INVOICE_ORIGIN',
      'Factura trebuie să identifice același furnizor și servicii deja primite.',
    );
    const net = toBani(item.net),
      allocatedTax = toBani(item.tax),
      gross = net + allocatedTax;
    const deductibleTax = old.deduction === 'full' ? allocatedTax : 0n;
    requireCondition(
      net > 0n &&
        new Amount(item.net)
          .mul(old.rate)
          .div(100)
          .toDecimalPlaces(2, Amount.ROUND_HALF_UP)
          .eq(item.tax),
      'ACCRUAL_ALLOCATION',
      'Baza și TVA alocate trebuie să se reconcilieze cu cota documentată.',
    );
    requireCondition(
      net <= remaining.net &&
        allocatedTax <= remaining.tax &&
        gross <= remaining.gross &&
        deductibleTax <= remaining.deferredTax,
      'ACCRUAL_OVER_MATCH',
      'Potrivirea depășește soldul angajamentului; diferențele de estimare cer revizuire distinctă.',
      409,
    );
    allocations.push({
      accrualId: item.accrualId,
      originalJournalId: state.journal.id,
      originalFinancialYearId: state.body.financialYearId,
      proposalHash: state.proposal.hash,
      positionHash: state.hash,
      positionVersion: state.matches.length,
      reference: old.reference,
      availableGross: fromBani(remaining.gross),
      remainingGross: fromBani(remaining.gross - gross),
      net: item.net,
      tax: item.tax,
      gross: fromBani(gross),
      deductibleTax: fromBani(deductibleTax),
    });
  }
  requireCondition(
    allocations.reduce((sum, row) => sum + toBani(row.net), 0n) === toBani(totals.net) &&
      allocations.reduce((sum, row) => sum + toBani(row.tax), 0n) === toBani(totals.tax),
    'ACCRUAL_INVOICE_TOTAL',
    'Angajamentele selectate trebuie să explice întreaga bază și TVA ale facturii.',
  );
  const deductibleTax = first.deduction === 'full' ? totals.tax : '0.00';
  const lines: PostingLine[] = [
    { account: '408', debit: totals.gross, credit: '0.00' },
    { account: '401', debit: '0.00', credit: totals.gross },
  ];
  if (new Amount(deductibleTax).gt(0))
    lines.push(
      { account: '4426', debit: deductibleTax, credit: '0.00' },
      { account: '4428', debit: '0.00', credit: deductibleTax },
    );
  const treatment = invoiceTreatmentSchema.parse({
    invoiceId: invoice.id,
    invoiceHash: invoice.hash,
    treatmentEvidenceId: input.receiptEvidenceId,
    direction: 'purchase',
    serviceDate: first.serviceTo,
    taxPointDate: first.taxPointDate,
    deduction: first.deduction,
    counterpartyVatCollection: 'no',
    account: first.account,
    registrationIds: [...registrationIds],
    ruleId: first.ruleId,
    ruleHash: first.ruleHash,
    net: totals.net,
    tax: totals.tax,
    gross: totals.gross,
    deductibleTax,
    accrualMatch: accrualInvoiceMatchSchema.parse({
      schemaVersion: 1,
      receivedDate: input.receivedDate,
      receiptEvidenceId: input.receiptEvidenceId,
      allocations,
    }),
  });
  return { invoice, treatment, lines };
}

export async function checkAccrualInvoicePosting(tx: Transaction, actor: Actor, body: GeneralBody) {
  const treatment = body.invoice;
  if (!treatment?.accrualMatch) return false;
  requireCondition(
    !treatment.credit && !body.accrual && !body.settlement,
    'MULTIPLE_ORIGINS',
    'Potrivirea facturii are o singură origine contabilă.',
  );
  const match = treatment.accrualMatch;
  const expected = await interpretAccrualInvoice(
    tx,
    actor,
    accrualInvoiceInput.parse({
      financialYearId: body.financialYearId,
      invoiceId: treatment.invoiceId,
      recognitionDate: body.date,
      receivedDate: match.receivedDate,
      receiptEvidenceId: match.receiptEvidenceId,
      allocations: match.allocations.map(({ accrualId, net, tax }) => ({ accrualId, net, tax })),
    }),
  );
  requireCondition(
    canonical(expected.treatment) === canonical(treatment) &&
      canonical(expected.lines) === canonical(body.lines) &&
      body.purpose === 'purchase' &&
      body.evidenceId === expected.invoice.evidenceId &&
      body.sourceReference === `invoice:${expected.invoice.id}`,
    'STALE_ACCRUAL_MATCH',
    'Soldurile angajamentelor sau tratamentul s-au schimbat. Revizuiți potrivirea.',
    409,
  );
  return true;
}
