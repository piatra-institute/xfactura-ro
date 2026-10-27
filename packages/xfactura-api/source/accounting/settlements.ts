import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import type { Transaction } from './db';
import { Commands, type Actor } from './commands';
import {
  canonical,
  fromBani,
  idSchema,
  requireCondition,
  settlementBodySchema,
  settlementInput,
  toBani,
  type GeneralBody,
  type PostingLine,
  type SettlementInput,
} from './domain';
import {
  allocations,
  evidence,
  journalLines,
  journals,
  ledgerAccounts,
  movementPostings,
  movements,
  periods,
} from './schema';
import { loadInvoicePositions, settlementCapacity } from './invoice-positions';
import { financialYearForDate } from './foundation';
import { movementEvidence, treasuryAccount } from './treasury';
import { sha256 } from './object-store';
import { generalBody, retainGeneralProposal } from './general-ledger';

export const settlementRevisionInput = settlementInput
  .extend({ id: idSchema, version: z.number().int().positive() })
  .strict();
const absolute = (value: bigint) => (value < 0n ? -value : value);

export async function interpretSettlement(tx: Transaction, actor: Actor, input: SettlementInput) {
  const [movement] = await tx
    .select()
    .from(movements)
    .where(and(eq(movements.companyId, actor.companyId), eq(movements.id, input.movementId)));
  requireCondition(movement, 'NOT_FOUND', 'Mișcarea nu este disponibilă.', 404);
  const year = await financialYearForDate(tx, actor.companyId, movement.date);
  requireCondition(
    year.id === input.financialYearId,
    'FINANCIAL_YEAR',
    'Mișcarea nu aparține exercițiului selectat.',
  );
  const account = await treasuryAccount(tx, actor.companyId, movement.bankAccount, movement.date);
  const [closed] = await tx
    .select()
    .from(periods)
    .where(
      and(
        eq(periods.companyId, actor.companyId),
        eq(periods.month, `${movement.date.slice(0, 7)}-01`),
      ),
    );
  requireCondition(!closed?.closedAt, 'PERIOD_CLOSED', 'Perioada este închisă.', 409);
  const [legacy] = await tx
    .select({ id: allocations.id })
    .from(allocations)
    .where(
      and(eq(allocations.companyId, actor.companyId), eq(allocations.movementId, movement.id)),
    );
  const [native] = await tx
    .select()
    .from(movementPostings)
    .where(
      and(
        eq(movementPostings.companyId, actor.companyId),
        eq(movementPostings.movementId, movement.id),
      ),
    );
  requireCondition(
    !legacy && !native,
    'ALREADY_RECONCILED',
    'Mișcarea este deja contabilizată și reconciliată.',
    409,
  );
  requireCondition(
    input.allocations.length > 0 || input.fee,
    'EMPTY_SETTLEMENT',
    'Alocați o factură sau documentați comisionul bancar.',
  );
  const ids = input.allocations.map((item) => item.invoiceId);
  requireCondition(
    new Set(ids).size === ids.length,
    'DUPLICATE_ALLOCATION',
    'O factură poate apărea o singură dată în alocare.',
  );
  const states = await loadInvoicePositions(tx, actor.companyId, ids);
  requireCondition(
    states.length === ids.length,
    'POSTING_REQUIRED',
    'Toate facturile trebuie să fie contabilizate și accesibile în companie.',
  );
  const byId = new Map(states.map((state) => [state.invoice.id, state]));
  const lines: PostingLine[] = [];
  let expectedCash = 0n;
  const assigned = [...input.allocations]
    .sort((a, b) => a.invoiceId.localeCompare(b.invoiceId))
    .map((item) => {
      const state = byId.get(item.invoiceId)!;
      requireCondition(
        state.journal.date <= movement.date && state.invoice.body.currency === 'RON',
        'SETTLEMENT_DATE',
        'Plățile înainte de factură și valuta necesită tratamente distincte.',
      );
      const amount = toBani(item.amount),
        capacity = settlementCapacity(state, movement.date);
      requireCondition(
        amount !== 0n && amount * capacity > 0n && absolute(amount) <= absolute(capacity),
        'OVER_ALLOCATION',
        'Alocarea depășește soldul sau suma de restituit la această dată.',
        409,
      );
      const cash = state.invoice.direction === 'sale' ? amount : -amount;
      requireCondition(
        cash * movement.amountBani > 0n,
        'SETTLEMENT_DIRECTION',
        'Sensul mișcării nu corespunde încasării, plății sau restituirii.',
      );
      expectedCash += cash;
      const control = state.invoice.direction === 'sale' ? '4111' : '401';
      lines.push({
        account: control,
        debit: cash < 0n ? fromBani(-cash) : '0.00',
        credit: cash > 0n ? fromBani(cash) : '0.00',
      });
      return { ...item, positionHash: state.hash, positionVersion: state.events.length };
    });
  let feeSource: { id: string; hash: string } | undefined;
  if (input.fee) {
    const amount = toBani(input.fee.amount);
    requireCondition(
      account.kind === 'bank' && amount > 0n && /^627(?:\.|$)/.test(input.fee.account),
      'BANK_FEE',
      'Documentați un comision bancar nenul în contul 627 sau analitic.',
    );
    const [feeAccount] = await tx
      .select()
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.companyId, actor.companyId),
          eq(ledgerAccounts.code, input.fee.account),
        ),
      );
    requireCondition(
      feeAccount?.postable && feeAccount.validFrom <= movement.date,
      'ACCOUNT',
      'Contul comisionului nu este disponibil.',
    );
    [feeSource] = await tx
      .select({ id: evidence.id, hash: evidence.hash })
      .from(evidence)
      .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, input.fee.evidenceId)));
    requireCondition(feeSource, 'NOT_FOUND', 'Documentul comisionului nu este disponibil.', 404);
    expectedCash -= amount;
    lines.push({ account: input.fee.account, debit: input.fee.amount, credit: '0.00' });
  }
  requireCondition(
    expectedCash === movement.amountBani,
    'MOVEMENT_TOTAL',
    'Alocările și comisionul trebuie să explice întreaga mișcare.',
  );
  const sources = await movementEvidence(tx, actor.companyId, movement.id);
  const movementHash = sha256(
    canonical({ ...movement, amountBani: movement.amountBani.toString() }),
  );
  let cashState: Array<{ id: string; date: string; debit: string; credit: string }> = [];
  if (account.kind === 'cash') {
    const cashRows = await tx
      .select({
        id: journals.id,
        date: journals.date,
        debit: journalLines.debitBani,
        credit: journalLines.creditBani,
      })
      .from(journalLines)
      .innerJoin(
        journals,
        and(
          eq(journals.companyId, journalLines.companyId),
          eq(journals.id, journalLines.journalId),
        ),
      )
      .where(
        and(
          eq(journalLines.companyId, actor.companyId),
          eq(journalLines.account, account.ledgerAccount),
          gte(journals.date, year.from),
          lte(journals.date, year.to),
        ),
      )
      .orderBy(asc(journals.date), asc(journals.number));
    const days = new Map<string, bigint>();
    for (const row of cashRows)
      days.set(row.date, (days.get(row.date) ?? 0n) + row.debit - row.credit);
    days.set(movement.date, (days.get(movement.date) ?? 0n) + movement.amountBani);
    let balance = 0n;
    for (const [, change] of [...days].sort(([a], [b]) => a.localeCompare(b))) {
      balance += change;
      requireCondition(
        balance >= 0n,
        'NEGATIVE_CASH',
        'Înregistrarea ar produce un sold de casă negativ.',
      );
    }
    cashState = cashRows.map((row) => ({
      ...row,
      debit: row.debit.toString(),
      credit: row.credit.toString(),
    }));
  }
  lines.push({
    account: account.ledgerAccount,
    debit: movement.amountBani > 0n ? fromBani(movement.amountBani) : '0.00',
    credit: movement.amountBani < 0n ? fromBani(-movement.amountBani) : '0.00',
  });
  const body = settlementBodySchema.parse({
    schemaVersion: 1,
    movementId: movement.id,
    account: account.identifier,
    ledgerAccount: account.ledgerAccount,
    movementHash,
    sourceEvidenceId: sources[0].id,
    allocations: assigned,
    ...(input.fee ? { fee: input.fee } : {}),
    ...(account.kind === 'cash' ? { cashJournalCount: cashState.length } : {}),
    stateHash: sha256(
      canonical({
        movementHash,
        account,
        sources,
        feeSource: feeSource ?? null,
        assigned,
        cashState,
      }),
    ),
  });
  return { movement, body, lines };
}

export async function checkSettlementPosting(tx: Transaction, actor: Actor, body: GeneralBody) {
  if (!body.settlement) return;
  requireCondition(
    !body.invoice,
    'MULTIPLE_ORIGINS',
    'O propunere are o singură origine economică.',
  );
  const input = body.settlement;
  const expected = await interpretSettlement(tx, actor, {
    financialYearId: body.financialYearId,
    movementId: input.movementId,
    allocations: input.allocations.map(({ invoiceId, amount }) => ({ invoiceId, amount })),
    ...(input.fee ? { fee: input.fee } : {}),
  });
  requireCondition(
    canonical(expected.body) === canonical(input) &&
      canonical(expected.lines) === canonical(body.lines) &&
      body.purpose === 'general' &&
      body.date === expected.movement.date &&
      body.evidenceId === input.sourceEvidenceId &&
      body.sourceReference === `settlement:${input.movementId}`,
    'STALE_SETTLEMENT',
    'Soldul, documentele sau efectul alocării s-au schimbat. Revizuiți propunerea.',
    409,
  );
}

export class Settlements {
  constructor(private readonly runner: Commands) {}
  async propose(
    actor: Actor,
    key: string,
    input: unknown,
    revision?: { id: string; version: number },
  ) {
    const body = settlementInput.parse(input);
    return this.runner.run(
      actor,
      key,
      revision ? 'settlements.revise' : 'settlements.propose',
      { body, revision: revision ?? null },
      'write',
      async (tx) => {
        const effect = await interpretSettlement(tx, actor, body);
        return retainGeneralProposal(
          tx,
          actor,
          generalBody({
            financialYearId: body.financialYearId,
            evidenceId: effect.body.sourceEvidenceId,
            date: effect.movement.date,
            purpose: 'general',
            description: `${effect.movement.amountBani > 0n ? 'Încasare' : 'Plată'} · ${effect.movement.reference}`,
            sourceReference: `settlement:${effect.movement.id}`,
            lines: effect.lines,
            settlement: effect.body,
          }),
          revision,
        );
      },
    );
  }
}
