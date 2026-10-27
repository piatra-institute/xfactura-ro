import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import { Commands, type Actor } from './commands';
import type { Transaction } from './db';
import {
  canonical,
  cashMovementInput,
  requireCondition,
  toBani,
  treasuryAccountInput,
  fromBani,
} from './domain';
import {
  bankAccounts,
  companies,
  evidence,
  ledgerAccounts,
  movementSources,
  movements,
  periods,
  statementMovements,
  statements,
  treasuryAccounts,
} from './schema';
import { financialYearForDate } from './foundation';
export const treasuryPage = z
  .object({
    limit: z.number().int().min(1).max(100).default(25),
    cursor: z.string().max(50).optional(),
  })
  .strict();

export async function initializeTreasury(
  tx: Transaction,
  company: { id: string; year: number; createdBy: string },
) {
  const [legacy] = await tx
    .select()
    .from(bankAccounts)
    .where(eq(bankAccounts.companyId, company.id));
  if (legacy) {
    const [first] = await tx
      .select({ date: statements.periodFrom })
      .from(statements)
      .where(
        and(eq(statements.companyId, company.id), eq(statements.bankAccount, legacy.identifier)),
      )
      .orderBy(asc(statements.periodFrom))
      .limit(1);
    const firstYear = Math.min(company.year, first ? Number(first.date.slice(0, 4)) : company.year);
    await tx
      .insert(treasuryAccounts)
      .values({
        companyId: company.id,
        identifier: legacy.identifier,
        kind: 'bank',
        currency: 'RON',
        ledgerAccount: '5121',
        openedOn: `${firstYear}-01-01`,
        createdBy: company.createdBy,
      })
      .onConflictDoNothing();
  }
}

export async function treasuryAccount(
  tx: Transaction,
  companyId: string,
  identifier: string,
  date: string,
) {
  const [account] = await tx
    .select()
    .from(treasuryAccounts)
    .where(
      and(eq(treasuryAccounts.companyId, companyId), eq(treasuryAccounts.identifier, identifier)),
    );
  requireCondition(
    account && account.openedOn <= date,
    'TREASURY_ACCOUNT',
    'Contul de trezorerie nu este configurat pentru această dată.',
  );
  return account;
}

export async function ensureBankAccount(
  tx: Transaction,
  actor: Actor,
  identifier: string,
  from: string,
) {
  const [existing] = await tx
    .select()
    .from(treasuryAccounts)
    .where(
      and(
        eq(treasuryAccounts.companyId, actor.companyId),
        eq(treasuryAccounts.identifier, identifier),
      ),
    );
  if (existing) {
    requireCondition(
      existing.kind === 'bank' && existing.openedOn <= from,
      'TREASURY_ACCOUNT',
      'Extrasul nu corespunde unui cont bancar activ la această dată.',
    );
    return existing;
  }
  const [another] = await tx
    .select()
    .from(treasuryAccounts)
    .where(and(eq(treasuryAccounts.companyId, actor.companyId), eq(treasuryAccounts.kind, 'bank')))
    .limit(1);
  requireCondition(
    !another,
    'BANK_SCOPE',
    'Configurați contul bancar și contul său analitic înainte de import.',
  );
  const [company] = await tx.select().from(companies).where(eq(companies.id, actor.companyId));
  await tx
    .insert(bankAccounts)
    .values({ companyId: actor.companyId, identifier })
    .onConflictDoNothing();
  const [created] = await tx
    .insert(treasuryAccounts)
    .values({
      companyId: actor.companyId,
      identifier,
      kind: 'bank',
      currency: 'RON',
      ledgerAccount: '5121',
      openedOn: `${Math.min(company.year, Number(from.slice(0, 4)))}-01-01`,
      createdBy: actor.actorId,
    })
    .returning();
  return created;
}

export async function movementEvidence(tx: Transaction, companyId: string, movementId: string) {
  const direct = await tx
    .select({ id: evidence.id, hash: evidence.hash })
    .from(movementSources)
    .innerJoin(
      evidence,
      and(
        eq(evidence.companyId, movementSources.companyId),
        eq(evidence.id, movementSources.evidenceId),
      ),
    )
    .where(
      and(eq(movementSources.companyId, companyId), eq(movementSources.movementId, movementId)),
    );
  const bank = await tx
    .select({ id: evidence.id, hash: evidence.hash })
    .from(statementMovements)
    .innerJoin(
      statements,
      and(
        eq(statements.companyId, statementMovements.companyId),
        eq(statements.id, statementMovements.statementId),
      ),
    )
    .innerJoin(
      evidence,
      and(eq(evidence.companyId, statements.companyId), eq(evidence.id, statements.evidenceId)),
    )
    .where(
      and(
        eq(statementMovements.companyId, companyId),
        eq(statementMovements.movementId, movementId),
      ),
    );
  const distinct = new Map([...direct, ...bank].map((row) => [row.id, row]));
  const sources = [...distinct.values()].sort((a, b) => a.id.localeCompare(b.id));
  requireCondition(
    sources.length > 0,
    'MOVEMENT_EVIDENCE',
    'Lipsește documentul original al mișcării.',
  );
  return sources;
}

export class Treasury {
  constructor(private readonly runner: Commands) {}
  accounts(actor: Actor, input: unknown = {}) {
    const body = treasuryPage.parse(input);
    return this.runner.read(
      actor,
      async (tx) => {
        const rows = await tx
          .select()
          .from(treasuryAccounts)
          .where(
            and(
              eq(treasuryAccounts.companyId, actor.companyId),
              body.cursor ? gt(treasuryAccounts.identifier, body.cursor) : undefined,
            ),
          )
          .orderBy(asc(treasuryAccounts.identifier))
          .limit(body.limit + 1);
        return {
          items: rows.slice(0, body.limit),
          nextCursor: rows.length > body.limit ? rows[body.limit - 1].identifier : null,
        };
      },
      'treasury.accounts',
    );
  }
  async createAccount(actor: Actor, key: string, input: unknown) {
    const body = treasuryAccountInput.parse(input);
    return this.runner.run(actor, key, 'treasury.createAccount', body, 'manage', async (tx) => {
      const [source] = await tx
        .select({ id: evidence.id })
        .from(evidence)
        .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, body.evidenceId)));
      requireCondition(source, 'NOT_FOUND', 'Documentul nu este disponibil.', 404);
      const [account] = await tx
        .select()
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.companyId, actor.companyId),
            eq(ledgerAccounts.code, body.ledgerAccount),
          ),
        );
      requireCondition(
        account?.postable &&
          account.book === 'general' &&
          account.validFrom <= body.openedOn &&
          (body.kind === 'bank' ? /^5121(?:\.|$)/ : /^5311(?:\.|$)/).test(body.ledgerAccount),
        'TREASURY_LEDGER',
        'Folosiți un cont valid 5121 pentru bancă sau 5311 pentru casă, cu analitic distinct.',
      );
      const [row] = await tx
        .insert(treasuryAccounts)
        .values({ ...body, companyId: actor.companyId, createdBy: actor.actorId })
        .returning();
      return row;
    });
  }
  async recordCashMovement(actor: Actor, key: string, input: unknown) {
    const body = cashMovementInput.parse(input);
    return this.runner.run(actor, key, 'treasury.recordCash', body, 'write', async (tx) => {
      const account = await treasuryAccount(tx, actor.companyId, body.account, body.date);
      requireCondition(
        account.kind === 'cash' && toBani(body.amount) !== 0n,
        'CASH_MOVEMENT',
        'Înregistrați o mișcare nenulă într-un cont de casă.',
      );
      await financialYearForDate(tx, actor.companyId, body.date);
      const [closed] = await tx
        .select()
        .from(periods)
        .where(
          and(
            eq(periods.companyId, actor.companyId),
            eq(periods.month, `${body.date.slice(0, 7)}-01`),
          ),
        );
      requireCondition(!closed?.closedAt, 'PERIOD_CLOSED', 'Perioada este închisă.', 409);
      const [source] = await tx
        .select({ id: evidence.id })
        .from(evidence)
        .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, body.evidenceId)));
      requireCondition(source, 'NOT_FOUND', 'Documentul nu este disponibil.', 404);
      const [previous] = await tx
        .select()
        .from(movements)
        .where(
          and(
            eq(movements.companyId, actor.companyId),
            eq(movements.bankAccount, body.account),
            eq(movements.sourceId, body.sourceId),
          ),
        );
      if (previous) {
        requireCondition(
          canonical([previous.date, fromBani(previous.amountBani), previous.reference]) ===
            canonical([body.date, body.amount, body.reference]),
          'MOVEMENT_CONFLICT',
          'Mișcarea există cu alte date.',
          409,
        );
        await tx
          .insert(movementSources)
          .values({
            companyId: actor.companyId,
            movementId: previous.id,
            evidenceId: body.evidenceId,
          })
          .onConflictDoNothing();
        return { id: previous.id };
      }
      const id = randomUUID();
      await tx.insert(movements).values({
        id,
        companyId: actor.companyId,
        bankAccount: body.account,
        sourceId: body.sourceId,
        date: body.date,
        amountBani: toBani(body.amount),
        reference: body.reference,
      });
      await tx
        .insert(movementSources)
        .values({ companyId: actor.companyId, movementId: id, evidenceId: body.evidenceId });
      return { id };
    });
  }
}
