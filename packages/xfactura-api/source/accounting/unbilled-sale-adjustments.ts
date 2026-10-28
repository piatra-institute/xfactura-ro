import { and, eq } from 'drizzle-orm';
import type { Transaction } from './db';
import type { Actor } from './commands';
import {
  Amount,
  canonical,
  fromBani,
  requireCondition,
  toBani,
  unbilledSaleAdjustmentInput,
  unbilledSaleAdjustmentSchema,
  type GeneralBody,
  type PostingLine,
  type UnbilledSaleAdjustmentInput,
} from './domain';
import { financialYearForDate, regimesAt } from './foundation';
import { invoiceRule } from './accounting-catalogue';
import { evidence, invoiceDocuments, periods } from './schema';
import { loadUnbilledSales, unbilledSaleRemaining } from './unbilled-sale-state';
import { checkUnbilledSalePosting } from './unbilled-sales';

export async function interpretUnbilledSaleAdjustment(
  tx: Transaction,
  actor: Actor,
  input: UnbilledSaleAdjustmentInput,
) {
  const [state] = await loadUnbilledSales(tx, actor.companyId, [input.unbilledSaleId]);
  requireCondition(state, 'NOT_FOUND', 'Serviciile de facturat nu sunt disponibile.', 404);
  const old = state.treatment;
  requireCondition(
    old.measurementBasis === 'estimated_consideration',
    'UNBILLED_SALE_MEASUREMENT',
    'Recunoașterea inițială trebuie să documenteze o valoare estimată; erorile și modificările de preț cer tratamente distincte.',
  );
  const year = await financialYearForDate(tx, actor.companyId, input.date);
  requireCondition(
    year.id === input.financialYearId && state.body.financialYearId === year.id,
    'UNBILLED_SALE_ADJUSTMENT_PERIOD',
    'Ajustările între exerciții necesită evaluarea distinctă a estimării, erorii sau evenimentului de închidere.',
  );
  const [period] = await tx
    .select({ closedAt: periods.closedAt })
    .from(periods)
    .where(
      and(
        eq(periods.companyId, actor.companyId),
        eq(periods.month, `${input.date.slice(0, 7)}-01`),
      ),
    );
  requireCondition(!period?.closedAt, 'CLOSED_PERIOD', 'Luna ajustării este închisă.', 409);
  const latestDate = [
    state.journal.date,
    ...state.matches.map((row) => row.date),
    ...state.adjustments.map((row) => row.journal.date),
  ]
    .sort()
    .at(-1)!;
  requireCondition(
    input.evidenceDate <= input.newInformationDate &&
      input.newInformationDate >= state.journal.date &&
      input.newInformationDate <= input.date &&
      input.newInformationDate.slice(0, 7) === input.date.slice(0, 7) &&
      input.date >= latestDate,
    'UNBILLED_SALE_ADJUSTMENT_DATE',
    'Documentați informația nouă în luna ajustării, după recunoaștere și evenimentele deja contabilizate.',
  );
  const [source] = await tx
    .select({ hash: evidence.hash })
    .from(evidence)
    .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, input.evidenceId)));
  requireCondition(source, 'NOT_FOUND', 'Documentul reevaluării nu este disponibil.', 404);
  const [invoiceSource] = await tx
    .select({ id: invoiceDocuments.id })
    .from(invoiceDocuments)
    .where(
      and(
        eq(invoiceDocuments.companyId, actor.companyId),
        eq(invoiceDocuments.evidenceId, input.evidenceId),
      ),
    );
  requireCondition(
    !invoiceSource &&
      input.evidenceId !== old.evidenceId &&
      !state.adjustments.some((row) => row.treatment.evidenceId === input.evidenceId),
    'UNBILLED_SALE_ADJUSTMENT_EVIDENCE',
    'Păstrați separat informația nouă privind evaluarea; factura și documentele deja folosite nu o înlocuiesc.',
  );
  await checkUnbilledSalePosting(tx, actor, state.body);
  const current = await regimesAt(tx, actor.companyId, input.date),
    original = await regimesAt(tx, actor.companyId, old.taxPointDate);
  requireCondition(
    current.vat &&
      current.vat.value === original.vat?.value &&
      (current.vat.value !== 'normal_vat' || current.vat_collection?.value === 'no'),
    'UNBILLED_SALE_ADJUSTMENT_VAT_TRANSITION',
    'Schimbările de regim TVA necesită un tratament distinct.',
  );
  const normalVat = current.vat.value === 'normal_vat';
  // This increment does not silently choose a later VAT adjustment/rectification period.
  requireCondition(
    !normalVat || input.date.slice(0, 7) === old.taxPointDate.slice(0, 7),
    'UNBILLED_SALE_ADJUSTMENT_TAX_PERIOD',
    'Reevaluarea TVA în altă lună cere un tratament fiscal separat.',
  );
  invoiceRule(input.date, old.vatCategory);
  const previous = unbilledSaleRemaining(state);
  requireCondition(
    previous.gross > 0n,
    'UNBILLED_SALE_RESOLVED',
    'Nu mai există un sold nefacturat de reevaluat.',
    409,
  );
  const net = toBani(input.remainingNet);
  requireCondition(
    input.action === 'release' ? net === 0n : net > 0n,
    'UNBILLED_SALE_ADJUSTMENT_AMOUNT',
    'Eliberarea are sold zero; noua estimare trebuie să fie pozitivă.',
  );
  const tax = toBani(
    new Amount(input.remainingNet)
      .mul(old.rate)
      .div(100)
      .toDecimalPlaces(2, Amount.ROUND_HALF_UP)
      .toFixed(2),
  );
  const remaining = { net, tax, gross: net + tax };
  const delta = {
    net: net - previous.net,
    tax: tax - previous.tax,
    gross: net + tax - previous.gross,
  };
  requireCondition(
    delta.net !== 0n || delta.tax !== 0n,
    'UNCHANGED_AMOUNT',
    'Estimarea este identică cu soldul nefacturat.',
    409,
  );
  const amounts = (value: typeof previous) => ({
    net: fromBani(value.net),
    tax: fromBani(value.tax),
    gross: fromBani(value.gross),
  });
  const { financialYearId: _year, ...request } = input;
  const previousJournalId = state.adjustments.at(-1)?.journal.id ?? state.journal.id;
  const treatment = unbilledSaleAdjustmentSchema.parse({
    ...request,
    schemaVersion: 1,
    originalJournalId: state.journal.id,
    originalFinancialYearId: state.body.financialYearId,
    originalProposalHash: state.proposal.hash,
    previousJournalId,
    serviceReference: old.reference,
    positionHash: state.hash,
    positionVersion: state.matches.length + state.adjustments.length,
    account: old.account,
    taxPointDate: old.taxPointDate,
    taxTreatment: normalVat ? 'same_service_month' : 'non_vat',
    rate: old.rate,
    ruleId: old.ruleId,
    ruleHash: old.ruleHash,
    registrationIds: [
      ...new Set([
        ...old.registrationIds,
        current.vat.id,
        ...(normalVat && current.vat_collection ? [current.vat_collection.id] : []),
      ]),
    ],
    sourceHash: source.hash,
    previousRemaining: amounts(previous),
    remaining: amounts(remaining),
    delta: amounts(delta),
  });
  const lines: PostingLine[] = [
    { account: '418', amount: delta.gross },
    { account: old.account, amount: -delta.net },
    { account: '4427', amount: -delta.tax },
  ]
    .filter((row) => row.amount !== 0n)
    .map(({ account, amount }) => ({
      account,
      debit: fromBani(amount > 0n ? amount : 0n),
      credit: fromBani(amount < 0n ? -amount : 0n),
    }));
  return { treatment, lines, previousJournalId };
}

export async function checkUnbilledSaleAdjustmentPosting(
  tx: Transaction,
  actor: Actor,
  body: GeneralBody,
) {
  const value = body.unbilledSaleAdjustment;
  if (!value) return;
  const input = unbilledSaleAdjustmentInput
    .strip()
    .parse({ ...value, financialYearId: body.financialYearId });
  const expected = await interpretUnbilledSaleAdjustment(tx, actor, input);
  requireCondition(
    canonical(expected.treatment) === canonical(value) &&
      canonical(expected.lines) === canonical(body.lines) &&
      body.date === value.date &&
      body.evidenceId === value.evidenceId &&
      body.purpose === 'adjustment' &&
      body.correctsJournalId === expected.previousJournalId &&
      body.sourceReference === `unbilled-sale-adjustment:${value.reference}`,
    'STALE_UNBILLED_SALE_ADJUSTMENT',
    'Soldul sau tratamentul serviciilor s-au schimbat. Revizuiți reevaluarea.',
    409,
  );
}
