import { and, eq } from 'drizzle-orm';
import type { Transaction } from './db';
import type { Actor } from './commands';
import {
  Amount,
  accrualAdjustmentInput,
  accrualAdjustmentSchema,
  canonical,
  fromBani,
  requireCondition,
  toBani,
  type AccrualAdjustmentInput,
  type GeneralBody,
  type PostingLine,
} from './domain';
import { financialYearForDate, regimesAt } from './foundation';
import { evidence, periods } from './schema';
import { accrualRemaining, loadAccruals } from './accrual-state';
import { checkAccrualPosting } from './accruals';

export async function interpretAccrualAdjustment(
  tx: Transaction,
  actor: Actor,
  input: AccrualAdjustmentInput,
) {
  const [state] = await loadAccruals(tx, actor.companyId, [input.accrualId]);
  requireCondition(state, 'NOT_FOUND', 'Angajamentul nu este disponibil.', 404);
  const year = await financialYearForDate(tx, actor.companyId, input.date);
  const [period] = await tx
    .select({ closedAt: periods.closedAt })
    .from(periods)
    .where(
      and(
        eq(periods.companyId, actor.companyId),
        eq(periods.month, `${input.date.slice(0, 7)}-01`),
      ),
    );
  requireCondition(
    !period?.closedAt,
    'CLOSED_PERIOD',
    'Luna ajustării este închisă. Alegeți o perioadă deschisă.',
    409,
  );
  requireCondition(
    year.id === input.financialYearId && state.body.financialYearId === year.id,
    'ACCRUAL_ADJUSTMENT_PERIOD',
    'Ajustările între exerciții necesită evaluarea distinctă a estimării, erorii sau evenimentului de închidere.',
  );
  const latestDate = [
    state.journal.date,
    ...state.matches.map((row) => row.date),
    ...state.adjustments.map((row) => row.journal.date),
  ]
    .sort()
    .at(-1)!;
  requireCondition(
    input.evidenceDate <= input.newInformationDate &&
      input.newInformationDate <= input.date &&
      input.newInformationDate >= state.journal.date &&
      input.newInformationDate.slice(0, 7) === input.date.slice(0, 7) &&
      input.date >= latestDate,
    'ACCRUAL_ADJUSTMENT_DATE',
    'Documentați informația nouă în luna ajustării, după recunoaștere și potrivirile deja înregistrate.',
  );
  const [source] = await tx
    .select({ hash: evidence.hash })
    .from(evidence)
    .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, input.evidenceId)));
  requireCondition(source, 'NOT_FOUND', 'Documentul ajustării nu este disponibil.', 404);
  requireCondition(
    input.evidenceId !== state.treatment.evidenceId,
    'ACCRUAL_ADJUSTMENT_EVIDENCE',
    'Păstrați separat documentul informației noi care justifică ajustarea.',
  );
  await checkAccrualPosting(tx, actor, state.body);
  const old = state.treatment,
    current = await regimesAt(tx, actor.companyId, input.date),
    original = await regimesAt(tx, actor.companyId, old.taxPointDate);
  requireCondition(
    current.vat &&
      current.vat.value === original.vat?.value &&
      (current.vat.value !== 'normal_vat' || current.vat_collection?.value === 'no'),
    'ACCRUAL_ADJUSTMENT_VAT_TRANSITION',
    'Schimbările de regim TVA necesită un tratament distinct.',
  );
  const previous = accrualRemaining(state);
  requireCondition(
    previous.gross > 0n,
    'ACCRUAL_RESOLVED',
    'Angajamentul nu mai are o sumă nefacturată de ajustat.',
    409,
  );
  const net = toBani(input.remainingNet);
  requireCondition(
    input.action === 'release' ? net === 0n : net > 0n,
    'ACCRUAL_ADJUSTMENT_AMOUNT',
    'Eliberarea are sold zero; noua estimare trebuie să fie pozitivă.',
  );
  const tax = toBani(
      new Amount(input.remainingNet)
        .mul(old.rate)
        .div(100)
        .toDecimalPlaces(2, Amount.ROUND_HALF_UP)
        .toFixed(2),
    ),
    remaining = { net, tax, gross: net + tax, deferredTax: old.deduction === 'full' ? tax : 0n };
  const amounts = (value: typeof previous) => ({
    net: fromBani(value.net),
    tax: fromBani(value.tax),
    gross: fromBani(value.gross),
    deferredTax: fromBani(value.deferredTax),
  });
  const delta = {
    net: remaining.net - previous.net,
    tax: remaining.tax - previous.tax,
    gross: remaining.gross - previous.gross,
    deferredTax: remaining.deferredTax - previous.deferredTax,
  };
  requireCondition(
    delta.net !== 0n || delta.tax !== 0n,
    'UNCHANGED_AMOUNT',
    'Estimarea este identică cu soldul nefacturat.',
    409,
  );
  const { financialYearId: _year, ...request } = input;
  const previousJournalId = state.adjustments.at(-1)?.journal.id ?? state.journal.id;
  const treatment = accrualAdjustmentSchema.parse({
    ...request,
    schemaVersion: 1,
    originalJournalId: state.journal.id,
    originalFinancialYearId: state.body.financialYearId,
    originalProposalHash: state.proposal.hash,
    previousJournalId,
    accrualReference: old.reference,
    positionHash: state.hash,
    positionVersion: state.matches.length + state.adjustments.length,
    account: old.account,
    rate: old.rate,
    ruleId: old.ruleId,
    ruleHash: old.ruleHash,
    registrationIds: [
      ...new Set([
        ...old.registrationIds,
        current.vat.id,
        ...(current.vat.value === 'normal_vat' && current.vat_collection
          ? [current.vat_collection.id]
          : []),
      ]),
    ],
    sourceHash: source.hash,
    previousRemaining: amounts(previous),
    remaining: amounts(remaining),
    delta: amounts(delta),
  });
  const movements = [
    { account: old.account, amount: delta.gross - delta.deferredTax },
    { account: '408', amount: -delta.gross },
    { account: '4428', amount: delta.deferredTax },
  ];
  const lines: PostingLine[] = movements
    .filter((row) => row.amount !== 0n)
    .map(({ account, amount }) => ({
      account,
      debit: fromBani(amount > 0n ? amount : 0n),
      credit: fromBani(amount < 0n ? -amount : 0n),
    }));
  return { treatment, lines, previousJournalId };
}
export async function checkAccrualAdjustmentPosting(
  tx: Transaction,
  actor: Actor,
  body: GeneralBody,
) {
  if (!body.accrualAdjustment) return;
  const value = body.accrualAdjustment;
  const input = accrualAdjustmentInput.parse({
    financialYearId: body.financialYearId,
    accrualId: value.accrualId,
    reference: value.reference,
    evidenceId: value.evidenceId,
    evidenceDate: value.evidenceDate,
    newInformationDate: value.newInformationDate,
    date: value.date,
    periodBasis: value.periodBasis,
    action: value.action,
    remainingNet: value.remainingNet,
    reason: value.reason,
  });
  const expected = await interpretAccrualAdjustment(tx, actor, input);
  requireCondition(
    canonical(expected.treatment) === canonical(value) &&
      canonical(expected.lines) === canonical(body.lines) &&
      body.date === value.date &&
      body.evidenceId === value.evidenceId &&
      body.purpose === 'adjustment' &&
      body.correctsJournalId === expected.previousJournalId &&
      body.sourceReference === `accrual-adjustment:${value.reference}`,
    'STALE_ACCRUAL_ADJUSTMENT',
    'Soldul sau tratamentul angajamentului s-au schimbat. Revizuiți ajustarea.',
    409,
  );
}
