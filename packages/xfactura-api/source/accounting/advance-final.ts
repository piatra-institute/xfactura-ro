import { and, eq } from 'drizzle-orm';
import type { Transaction } from './db';
import type { Actor } from './commands';
import {
  advanceFinalSchema,
  advanceFinalInput,
  canonical,
  fromBani,
  generalBodySchema,
  invoiceTreatmentSchema,
  requireCondition,
  toBani,
  type AdvanceFinalInput,
  type GeneralBody,
  type PostingLine,
} from './domain';
import { invoiceDocuments } from './schema';
import {
  advanceEvidence,
  advanceRegistration,
  checkAdvanceSource,
  taxAmount,
  taxIdentity,
} from './advance-interpretation';
import { invoiceRule } from './accounting-catalogue';
import { loadAdvanceInvoices, advanceRemaining } from './advance-state';
import { positionView } from './invoice-positions';

export async function interpretAdvanceFinal(
  tx: Transaction,
  actor: Actor,
  input: AdvanceFinalInput,
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
  requireCondition(invoice, 'NOT_FOUND', 'Factura finală nu este disponibilă.', 404);
  const doc = invoice.body,
    totals = doc.totals,
    source = await advanceEvidence(tx, actor, input.treatmentEvidenceId);
  requireCondition(
    doc.documentType === 'invoice' &&
      doc.invoiceTypeCode !== '386' &&
      doc.currency === 'RON' &&
      doc.supplier.country === 'RO' &&
      doc.customer.country === 'RO' &&
      doc.taxes.length === 1 &&
      totals.allowances === '0.00' &&
      totals.charges === '0.00' &&
      totals.prepaid === '0.00' &&
      totals.rounding === '0.00',
    'UNSUPPORTED_TREATMENT',
    'Această regularizare acoperă servicii interne în RON, cu avansurile stornate pe factura finală.',
  );
  requireCondition(
    input.recognitionDate.slice(0, 7) === doc.issueDate.slice(0, 7) &&
      input.serviceDate.slice(0, 7) === input.recognitionDate.slice(0, 7) &&
      input.taxPointDate === input.serviceDate &&
      (!doc.taxPointDate || doc.taxPointDate === input.taxPointDate),
    'UNSUPPORTED_PERIOD_TREATMENT',
    'Factura finală și serviciul trebuie să aparțină perioadei documentate.',
  );
  const tax = doc.taxes[0],
    rule = invoiceRule(input.taxPointDate, tax.category),
    reg = await advanceRegistration(tx, actor.companyId, input.taxPointDate);
  requireCondition(
    (tax.rate ?? '0') === rule.rate &&
      doc.lines.every(
        (row) => row.vatCategory === tax.category && (row.vatRate ?? '0') === rule.rate,
      ),
    'VAT_RATE',
    'Schimbările de cotă necesită o regularizare distinctă.',
  );
  requireCondition(
    invoice.direction === 'purchase'
      ? /^628(?:\.|$)/.test(input.account) && (input.deduction === 'none' || reg.normal)
      : /^704(?:\.|$)/.test(input.account) &&
          input.deduction === 'none' &&
          tax.category === (reg.normal ? 'S' : 'O'),
    'VAT_TREATMENT',
    'Documentați contul serviciilor și tratamentul TVA.',
  );
  requireCondition(
    input.deduction !== 'full' || tax.category === 'S',
    'VAT_TREATMENT',
    'Deducerea integrală necesită categoria TVA standard.',
  );
  const ids = input.allocations.map((row) => row.advanceInvoiceId),
    lineIds = input.allocations.map((row) => row.lineId),
    negative = doc.lines.filter((row) => toBani(row.net) < 0n),
    positive = doc.lines.filter((row) => toBani(row.net) > 0n);
  requireCondition(
    new Set(ids).size === ids.length &&
      new Set(lineIds).size === lineIds.length &&
      negative.length === input.allocations.length &&
      positive.length > 0 &&
      doc.lines.every((row) => toBani(row.net) !== 0n),
    'ADVANCE_FINAL_LINES',
    'Identificați fiecare linie negativă și un singur avans pentru fiecare alocare.',
  );
  const states = await loadAdvanceInvoices(tx, actor.companyId, ids);
  requireCondition(
    states.length === ids.length,
    'NOT_FOUND',
    'O factură de avans nu este disponibilă.',
    404,
  );
  const assigned = [];
  const party = invoice.direction === 'purchase' ? doc.supplier : doc.customer;
  requireCondition(
    new Set(states.map((row) => row.invoice.body.number)).size === states.length,
    'ADVANCE_REFERENCE',
    'Referințele avansurilor cu numere identice necesită dezambiguizare.',
  );
  for (const allocation of [...input.allocations].sort((a, b) =>
    a.advanceInvoiceId.localeCompare(b.advanceInvoiceId),
  )) {
    const state = states.find((row) => row.invoice.id === allocation.advanceInvoiceId)!,
      remaining = advanceRemaining(state),
      originalParty =
        state.invoice.direction === 'purchase'
          ? state.invoice.body.supplier
          : state.invoice.body.customer;
    await checkAdvanceSource(tx, actor, state);
    const originalReg = await advanceRegistration(
      tx,
      actor.companyId,
      state.treatment.taxPointDate,
    );
    requireCondition(
      state.invoice.direction === invoice.direction &&
        taxIdentity(party.taxId) === taxIdentity(originalParty.taxId) &&
        state.advance.serviceAccount === input.account &&
        state.treatment.deduction === input.deduction &&
        state.invoice.body.taxes[0].category === tax.category &&
        (state.invoice.body.taxes[0].rate ?? '0') === rule.rate &&
        originalReg.normal === reg.normal,
      'ADVANCE_FINAL_ORIGIN',
      'Partenerul, contul, deducerea, cota și regimul trebuie să corespundă avansului.',
    );
    const references =
      doc.invoiceReferences ??
      (doc.originalInvoiceNumber ? [{ number: doc.originalInvoiceNumber, issueDate: null }] : []);
    requireCondition(
      references.some(
        (row) =>
          row.number === state.invoice.body.number &&
          (!row.issueDate || row.issueDate === state.invoice.body.issueDate),
      ),
      'ADVANCE_REFERENCE',
      'Factura finală trebuie să refere factura de avans.',
    );
    const line = negative.find((row) => row.id === allocation.lineId);
    requireCondition(
      line &&
        toBani(line.net) === -toBani(allocation.net) &&
        toBani(allocation.net) > 0n &&
        taxAmount(allocation.net, rule.rate) === allocation.tax,
      'ADVANCE_FINAL_LINES',
      'Baza și TVA trebuie să corespundă exact liniei negative a avansului.',
    );
    requireCondition(
      state.journal.date <= input.recognitionDate &&
        input.serviceDate > state.treatment.taxPointDate &&
        state.events.every((row) => row.date <= input.recognitionDate) &&
        state.uses.every((row) => row.date <= input.recognitionDate),
      'ADVANCE_EVENT_ORDER',
      'Regularizarea nu poate preceda avansul sau evenimentele deja contabilizate.',
    );
    requireCondition(
      positionView(state, input.recognitionDate).balance === '0.00',
      'ADVANCE_UNSETTLED',
      'Factura de avans trebuie achitată și reconciliată înainte de utilizare.',
    );
    const net = toBani(allocation.net),
      taxValue = toBani(allocation.tax),
      gross = net + taxValue;
    requireCondition(
      net <= remaining.net && taxValue <= remaining.tax && gross <= remaining.gross,
      'ADVANCE_OVER_ALLOCATION',
      'Regularizarea depășește avansul disponibil.',
      409,
    );
    assigned.push({
      ...allocation,
      originalJournalId: state.journal.id,
      originalFinancialYearId: generalBodySchema.parse(state.proposal.body).financialYearId,
      originalProposalHash: state.proposal.hash,
      stateHash: state.hash,
      priorUseCount: state.uses.length,
      priorCreditCount: state.credits.length,
      availableNet: fromBani(remaining.net),
      availableTax: fromBani(remaining.tax),
      availableGross: fromBani(remaining.gross),
      gross: fromBani(gross),
      controlAmount: fromBani(
        invoice.direction === 'sale' || input.deduction === 'full' ? net : gross,
      ),
    });
  }
  const serviceNet = fromBani(positive.reduce((sum, row) => sum + toBani(row.net), 0n)),
    serviceTax = taxAmount(serviceNet, rule.rate),
    serviceGross = fromBani(toBani(serviceNet) + toBani(serviceTax)),
    deductibleTax =
      invoice.direction === 'purchase' && input.deduction === 'full' ? totals.tax : '0.00';
  requireCondition(
    toBani(serviceNet) - assigned.reduce((sum, row) => sum + toBani(row.net), 0n) ===
      toBani(totals.net) &&
      toBani(serviceTax) - assigned.reduce((sum, row) => sum + toBani(row.tax), 0n) ===
        toBani(totals.tax),
    'ADVANCE_FINAL_TOTAL',
    'Serviciile și avansurile stornate nu se reconciliază cu totalurile facturii. Diferențele de rotunjire necesită revizuire.',
  );
  const lines: PostingLine[] =
    invoice.direction === 'purchase'
      ? [
          {
            account: input.account,
            debit: input.deduction === 'full' ? serviceNet : serviceGross,
            credit: '0.00',
          },
          ...(totals.gross !== '0.00'
            ? [{ account: '401', debit: '0.00', credit: totals.gross }]
            : []),
          ...(deductibleTax !== '0.00'
            ? [{ account: '4426', debit: deductibleTax, credit: '0.00' }]
            : []),
          ...assigned.map((row) => ({ account: '4092', debit: '0.00', credit: row.controlAmount })),
        ]
      : [
          ...(totals.gross !== '0.00'
            ? [{ account: '4111', debit: totals.gross, credit: '0.00' }]
            : []),
          ...assigned.map((row) => ({ account: '419', debit: row.controlAmount, credit: '0.00' })),
          { account: input.account, debit: '0.00', credit: serviceNet },
          ...(totals.tax !== '0.00'
            ? [{ account: '4427', debit: '0.00', credit: totals.tax }]
            : []),
        ];
  return {
    invoice,
    lines,
    treatment: invoiceTreatmentSchema.parse({
      invoiceId: invoice.id,
      invoiceHash: invoice.hash,
      treatmentEvidenceId: source.id,
      direction: invoice.direction,
      serviceDate: input.serviceDate,
      taxPointDate: input.taxPointDate,
      deduction: input.deduction,
      counterpartyVatCollection: input.counterpartyVatCollection,
      account: input.account,
      registrationIds: [
        ...new Set([...reg.ids, ...states.flatMap((row) => row.treatment.registrationIds)]),
      ],
      ruleId: rule.id,
      ruleHash: rule.hash,
      net: totals.net,
      tax: totals.tax,
      gross: totals.gross,
      deductibleTax,
      advanceFinal: advanceFinalSchema.parse({
        schemaVersion: 1,
        serviceNet,
        serviceTax,
        serviceGross,
        allocations: assigned,
      }),
    }),
  };
}
export async function checkAdvanceFinalPosting(tx: Transaction, actor: Actor, body: GeneralBody) {
  const i = body.invoice,
    f = i?.advanceFinal;
  if (!i || !f) return false;
  requireCondition(
    !i.credit && !i.advance && !i.deferral && !i.accrualMatch && !i.unbilledSaleMatch,
    'MULTIPLE_ORIGINS',
    'Factura finală identifică un singur tratament.',
  );
  const expected = await interpretAdvanceFinal(
    tx,
    actor,
    advanceFinalInput.parse({
      financialYearId: body.financialYearId,
      invoiceId: i.invoiceId,
      recognitionDate: body.date,
      serviceDate: i.serviceDate,
      taxPointDate: i.taxPointDate,
      treatmentEvidenceId: i.treatmentEvidenceId,
      account: i.account,
      deduction: i.deduction,
      counterpartyVatCollection: i.counterpartyVatCollection,
      allocations: f.allocations.map(({ advanceInvoiceId, lineId, net, tax }) => ({
        advanceInvoiceId,
        lineId,
        net,
        tax,
      })),
    }),
  );
  requireCondition(
    canonical(expected.treatment) === canonical(i) &&
      canonical(expected.lines) === canonical(body.lines) &&
      body.evidenceId === expected.invoice.evidenceId &&
      body.purpose === i.direction &&
      body.sourceReference === `invoice:${i.invoiceId}` &&
      !body.correctsJournalId,
    'STALE_ADVANCE_FINAL',
    'Soldul avansului sau efectul regularizării s-a schimbat. Revizuiți propunerea.',
    409,
  );
  return true;
}
