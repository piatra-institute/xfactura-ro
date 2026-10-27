import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { Commands, type Actor } from './commands';
import type { Transaction } from './db';
import {
  Amount,
  canonical,
  fromBani,
  matchSchema,
  parseBankCsv,
  requireCondition,
  statementSchema,
  toBani,
  type PostingLine,
} from './domain';
import {
  allocations,
  evidence,
  journals,
  movements,
  movementPostings,
  proposals,
  periods,
  statementMovements,
  statements,
} from './schema';
import { sha256, type ObjectStore } from './object-store';
import { postJournal } from './ledger';
import { purchaseState, paymentCapacity } from './purchase-state';
import { financialYearForDate } from './foundation';
import { ensureBankAccount, treasuryAccount } from './treasury';

export class Bank {
  constructor(
    private readonly runner: Commands,
    private readonly objects: ObjectStore,
  ) {}

  async importStatement(actor: Actor, key: string, input: unknown) {
    const body = statementSchema.parse(input);
    return this.runner.run(actor, key, 'bank.importStatement', body, 'write', async (tx) => {
      const [source] = await tx
        .select()
        .from(evidence)
        .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, body.evidenceId)));
      requireCondition(source, 'NOT_FOUND', 'Documentul nu este disponibil.', 404);
      requireCondition(source.size <= 2_000_000, 'IMPORT_LIMIT', 'Extrasul CSV depășește 2 MB.');
      const bytes = await this.objects.get(actor.companyId, source.hash);
      const rows = parseBankCsv(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      const financialYear = await financialYearForDate(tx, actor.companyId, body.from);
      requireCondition(
        body.to <= financialYear.to,
        'PERIOD_SCOPE',
        'Extrasul trebuie să aparțină unui singur exercițiu financiar.',
      );
      requireCondition(
        rows.every((row) => row.date >= body.from && row.date <= body.to),
        'STATEMENT_DATE',
        'Mișcare în afara intervalului extrasului.',
      );
      const closing = rows.reduce(
        (balance, row) => balance.plus(row.amount),
        new Amount(body.opening),
      );
      requireCondition(
        closing.eq(body.closing),
        'STATEMENT_BALANCE',
        'Soldul inițial plus mișcările diferă de soldul final.',
      );

      const hash = sha256(canonical(body));
      const [previous] = await tx
        .select()
        .from(statements)
        .where(
          and(
            eq(statements.companyId, actor.companyId),
            eq(statements.bankAccount, body.bankAccount),
            eq(statements.sourceId, body.statementId),
          ),
        );
      if (previous) {
        requireCondition(
          previous.hash === hash,
          'STATEMENT_CONFLICT',
          'Identificatorul extrasului există cu alte date.',
          409,
        );
        return { id: previous.id };
      }
      await ensureBankAccount(tx, actor, body.bankAccount, body.from);
      const statementId = randomUUID();
      await tx.insert(statements).values({
        id: statementId,
        companyId: actor.companyId,
        evidenceId: source.id,
        bankAccount: body.bankAccount,
        sourceId: body.statementId,
        periodFrom: body.from,
        periodTo: body.to,
        openingBani: toBani(body.opening),
        closingBani: toBani(body.closing),
        hash,
      });

      for (const row of rows) {
        const [previousMovement] = await tx
          .select()
          .from(movements)
          .where(
            and(
              eq(movements.companyId, actor.companyId),
              eq(movements.bankAccount, body.bankAccount),
              eq(movements.sourceId, row.sourceId),
            ),
          );
        if (previousMovement) {
          requireCondition(
            previousMovement.date === row.date &&
              previousMovement.amountBani === toBani(row.amount) &&
              previousMovement.reference === row.reference,
            'MOVEMENT_CONFLICT',
            'Mișcare bancară cu același identificator și alte date.',
            409,
          );
        }
        const movementId = previousMovement?.id ?? randomUUID();
        if (!previousMovement)
          await tx.insert(movements).values({
            id: movementId,
            companyId: actor.companyId,
            bankAccount: body.bankAccount,
            sourceId: row.sourceId,
            date: row.date,
            amountBani: toBani(row.amount),
            reference: row.reference,
          });
        await tx
          .insert(statementMovements)
          .values({ companyId: actor.companyId, statementId, movementId });
      }
      return { id: statementId };
    });
  }

  async match(actor: Actor, key: string, input: unknown) {
    const body = matchSchema.parse(input);
    return this.runner.run(actor, key, 'bank.match', body, 'review', (tx) =>
      this.executeMatch(tx, actor, body),
    );
  }

  async inspectMatch(tx: Transaction, actor: Actor, body: ReturnType<typeof matchSchema.parse>) {
    const [movement] = await tx
      .select()
      .from(movements)
      .where(and(eq(movements.companyId, actor.companyId), eq(movements.id, body.movementId)));
    const [proposal] = await tx
      .select()
      .from(proposals)
      .where(
        and(
          eq(proposals.companyId, actor.companyId),
          eq(proposals.id, body.proposalId),
          eq(proposals.kind, 'purchase'),
        ),
      );
    requireCondition(
      movement && proposal,
      'NOT_FOUND',
      'Plata sau factura nu este disponibilă.',
      404,
    );
    const [previous] = await tx
      .select()
      .from(allocations)
      .where(
        and(eq(allocations.companyId, actor.companyId), eq(allocations.movementId, movement.id)),
      );
    requireCondition(!previous, 'ALLOCATION_CONFLICT', 'Mișcarea a fost deja alocată.', 409);
    const [native] = await tx
      .select()
      .from(movementPostings)
      .where(
        and(
          eq(movementPostings.companyId, actor.companyId),
          eq(movementPostings.movementId, movement.id),
        ),
      );
    requireCondition(!native, 'ALLOCATION_CONFLICT', 'Mișcarea a fost deja reconciliată.', 409);
    const account = await treasuryAccount(tx, actor.companyId, movement.bankAccount, movement.date);
    requireCondition(
      account.kind === 'bank',
      'PAYMENT_SCOPE',
      'Pentru numerar folosiți alocarea nativă.',
    );
    const amountBani = toBani(body.amount);
    requireCondition(
      movement.amountBani < 0n && -movement.amountBani === amountBani,
      'PAYMENT_SCOPE',
      'Alocați plata integrală unei facturi. Plățile grupate necesită revizuire separată.',
    );
    const [posted] = await tx
      .select({ id: journals.id })
      .from(journals)
      .where(
        and(
          eq(journals.companyId, actor.companyId),
          eq(journals.kind, 'purchase'),
          eq(journals.sourceId, proposal.id),
        ),
      );
    requireCondition(posted, 'POSTING_REQUIRED', 'Contabilizați factura înainte de reconciliere.');
    const state = await purchaseState(tx, actor.companyId, proposal.id);
    const purchase = state.body;
    requireCondition(
      amountBani > 0n && state.paidBani + amountBani <= paymentCapacity(state, movement.date),
      'OVER_ALLOCATION',
      'Plata depășește soldul facturii. Păstrați diferența pentru revizuire.',
    );

    const [origin] = await tx
      .select({ evidenceId: statements.evidenceId })
      .from(statementMovements)
      .innerJoin(
        statements,
        and(
          eq(statements.companyId, statementMovements.companyId),
          eq(statements.id, statementMovements.statementId),
        ),
      )
      .where(
        and(
          eq(statementMovements.companyId, actor.companyId),
          eq(statementMovements.movementId, movement.id),
        ),
      )
      .orderBy(asc(statements.id))
      .limit(1);
    requireCondition(origin, 'STATEMENT_REQUIRED', 'Lipsește extrasul original al plății.');
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
    return {
      movement,
      proposal,
      state,
      purchase,
      origin,
      amountBani,
      ledgerAccount: account.ledgerAccount,
    };
  }

  async previewMatch(tx: Transaction, actor: Actor, input: unknown) {
    const body = matchSchema.parse(input);
    const { movement, proposal, state, origin, amountBani, ledgerAccount } =
      await this.inspectMatch(tx, actor, body);
    const sources = await tx
      .select({ id: evidence.id, hash: evidence.hash })
      .from(evidence)
      .where(
        and(
          eq(evidence.companyId, actor.companyId),
          inArray(evidence.id, [
            origin.evidenceId,
            proposal.body.evidenceId,
            state.head.evidenceId,
          ]),
        ),
      )
      .orderBy(asc(evidence.id));
    return {
      kind: 'bank.match' as const,
      date: movement.date,
      movement: {
        id: movement.id,
        bankAccount: movement.bankAccount,
        amount: fromBani(movement.amountBani),
        reference: movement.reference,
      },
      purchase: {
        id: proposal.id,
        version: proposal.version,
        hash: proposal.hash,
        currentJournalId: state.head.id,
        amount: state.amount,
        paid: fromBani(state.paidBani),
      },
      evidence: sources,
      lines: [
        { account: '401', debit: fromBani(amountBani), credit: '0.00' },
        { account: ledgerAccount, debit: '0.00', credit: fromBani(amountBani) },
      ] satisfies PostingLine[],
    };
  }

  async executeMatch(tx: Transaction, actor: Actor, input: unknown) {
    const body = matchSchema.parse(input);
    const [previous] = await tx
      .select()
      .from(allocations)
      .where(
        and(
          eq(allocations.companyId, actor.companyId),
          eq(allocations.movementId, body.movementId),
        ),
      );
    if (previous) {
      requireCondition(
        previous.proposalId === body.proposalId && previous.amountBani === toBani(body.amount),
        'ALLOCATION_CONFLICT',
        'Mișcarea a fost deja alocată.',
        409,
      );
      return { id: previous.id };
    }
    const { movement, proposal, purchase, origin, amountBani, ledgerAccount } =
      await this.inspectMatch(tx, actor, body);
    const journal = await postJournal(tx, actor, {
      date: movement.date,
      kind: 'payment',
      sourceId: movement.id,
      evidenceId: origin.evidenceId,
      description: `Plată · ${purchase.supplier} · ${purchase.invoiceNumber}`,
      lines: [
        { account: '401', debit: fromBani(amountBani), credit: '0.00' },
        { account: ledgerAccount, debit: '0.00', credit: fromBani(amountBani) },
      ],
    });
    const id = randomUUID();
    await tx.insert(allocations).values({
      id,
      companyId: actor.companyId,
      movementId: movement.id,
      proposalId: proposal.id,
      amountBani,
      journalId: journal.id,
    });
    return { id };
  }
}
