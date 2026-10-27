import { and, eq, gte, lte } from 'drizzle-orm';
import { Commands, type Actor } from './commands';
import { canonical, fromBani, requireCondition } from './domain';
import type { Transaction } from './db';
import { sha256 } from './object-store';
import { financialYearForDate } from './foundation';
import { accrualControls } from './accrual-controls';
import {
  allocations,
  companies,
  correctionOutcomes,
  journalLines,
  invoiceDocuments,
  journals,
  movements,
  movementPostings,
  treasuryAccounts,
  periods,
  proposals,
  statementMovements,
  statements,
} from './schema';

export class Periods {
  constructor(private readonly runner: Commands) {}

  async close(actor: Actor, key: string, month: string) {
    requireCondition(/^\d{4}-(0[1-9]|1[0-2])-01$/.test(month), 'MONTH', 'Lună invalidă.');
    return this.runner.run(actor, key, 'periods.close', { month }, 'review', async (tx) => {
      return this.executeClose(tx, actor, month);
    });
  }

  async previewClose(tx: Transaction, actor: Actor, month: string) {
    requireCondition(/^\d{4}-(0[1-9]|1[0-2])-01$/.test(month), 'MONTH', 'Lună invalidă.');
    const [company] = await tx.select().from(companies).where(eq(companies.id, actor.companyId));
    const financialYear = await financialYearForDate(tx, actor.companyId, month);
    const [previous] = await tx
      .select()
      .from(periods)
      .where(and(eq(periods.companyId, actor.companyId), eq(periods.month, month)));
    requireCondition(!previous?.closedAt, 'PERIOD_CLOSED', 'Perioada este închisă.', 409);
    const proposed = await tx
      .select()
      .from(proposals)
      .where(eq(proposals.companyId, actor.companyId));
    const posted = await tx
      .select()
      .from(journals)
      .where(
        and(
          eq(journals.companyId, actor.companyId),
          gte(journals.date, financialYear.from),
          lte(journals.date, financialYear.to),
        ),
      );
    const outcomes = await tx
      .select()
      .from(correctionOutcomes)
      .where(eq(correctionOutcomes.companyId, actor.companyId));
    requireCondition(
      posted.some(
        (entry) =>
          entry.kind === 'opening' ||
          (entry.kind === 'general' &&
            proposed.some(
              (proposal) =>
                proposal.id === entry.sourceId &&
                'purpose' in proposal.body &&
                proposal.body.purpose === 'opening',
            )),
      ),
      'OPENING_REQUIRED',
      'Contabilizați poziția inițială înainte de închiderea lunii.',
    );
    requireCondition(
      !proposed.some(
        (item) =>
          item.body.date.slice(0, 7) === month.slice(0, 7) &&
          !outcomes.some(
            (outcome) => outcome.proposalId === item.id && outcome.status === 'withdrawn',
          ) &&
          !posted.some((entry) => entry.kind === item.kind && entry.sourceId === item.id),
      ),
      'UNPOSTED_ITEMS',
      'Există propuneri necontabilizate în această lună.',
    );
    const imported = await tx
      .select()
      .from(invoiceDocuments)
      .where(eq(invoiceDocuments.companyId, actor.companyId));
    requireCondition(
      !imported.some(
        (invoice) =>
          invoice.body.issueDate.slice(0, 7) === month.slice(0, 7) &&
          !posted.some((entry) =>
            proposed.some(
              (proposal) =>
                proposal.id === entry.sourceId &&
                'invoice' in proposal.body &&
                proposal.body.invoice?.invoiceId === invoice.id,
            ),
          ),
      ),
      'UNPOSTED_INVOICES',
      'Există facturi importate fără o înregistrare contabilizată în această lună.',
    );
    const bank = await tx.select().from(movements).where(eq(movements.companyId, actor.companyId));
    const matched = await tx
      .select()
      .from(allocations)
      .where(eq(allocations.companyId, actor.companyId));
    const nativeMatched = await tx
      .select()
      .from(movementPostings)
      .where(eq(movementPostings.companyId, actor.companyId));
    requireCondition(
      !bank.some(
        (item) =>
          item.date.slice(0, 7) === month.slice(0, 7) &&
          !matched.some((allocation) => allocation.movementId === item.id) &&
          !nativeMatched.some((posting) => posting.movementId === item.id),
      ),
      'UNRECONCILED',
      'Există mișcări bancare sau de numerar nereconciliate.',
    );
    const statement = await tx
      .select()
      .from(statements)
      .where(eq(statements.companyId, actor.companyId));
    const lastDay = new Date(`${month}T00:00:00Z`);
    lastDay.setUTCMonth(lastDay.getUTCMonth() + 1);
    lastDay.setUTCDate(0);
    const monthEnd = lastDay.toISOString().slice(0, 10);
    requireCondition(
      monthEnd <= financialYear.to,
      'PERIOD_SCOPE',
      'Luna depășește exercițiul financiar.',
    );
    const accounts = await tx
      .select()
      .from(treasuryAccounts)
      .where(
        and(
          eq(treasuryAccounts.companyId, actor.companyId),
          lte(treasuryAccounts.openedOn, monthEnd),
        ),
      );
    const banks = accounts.filter((account) => account.kind === 'bank');
    const covering = statement.filter((item) =>
      banks.some(
        (account) =>
          account.identifier === item.bankAccount &&
          item.periodFrom <= (account.openedOn > month ? account.openedOn : month) &&
          item.periodTo >= monthEnd,
      ),
    );
    requireCondition(
      banks.every((account) => covering.some((item) => item.bankAccount === account.identifier)),
      'STATEMENT_REQUIRED',
      'Lipsește extrasul complet pentru un cont bancar activ.',
    );
    const links = await tx
      .select()
      .from(statementMovements)
      .where(eq(statementMovements.companyId, actor.companyId));
    const lines = await tx
      .select()
      .from(journalLines)
      .where(eq(journalLines.companyId, actor.companyId));
    const dates = new Map(posted.map((entry) => [entry.id, entry.date]));
    const throughEnd = lines.filter(
      (line) => dates.has(line.journalId) && dates.get(line.journalId)! <= monthEnd,
    );
    requireCondition(
      !throughEnd.some(
        (line) =>
          /^(5121|5311)(?:\.|$)/.test(line.account) &&
          !accounts.some((account) => account.ledgerAccount === line.account),
      ),
      'TREASURY_ACCOUNT',
      'Configurați corespondența fiecărui cont bancar sau de casă din registru.',
    );
    const balanceAt = (ledgerAccount: string, date: string) =>
      lines
        .filter(
          (line) =>
            line.account === ledgerAccount &&
            dates.has(line.journalId) &&
            dates.get(line.journalId)! <= date,
        )
        .reduce((sum, line) => sum + line.debitBani - line.creditBani, 0n);
    const checkpoints = [
      ...statement
        .filter((item) => item.periodTo.slice(0, 7) === month.slice(0, 7))
        .map((source) => ({ source, date: source.periodTo })),
      ...covering.map((source) => ({ source, date: monthEnd })),
    ];
    for (const { source, date } of checkpoints) {
      const account = banks.find((item) => item.identifier === source.bankAccount);
      requireCondition(account, 'TREASURY_ACCOUNT', 'Contul extrasului nu este configurat.');
      const movementIds = new Set(
        links.filter((item) => item.statementId === source.id).map((item) => item.movementId),
      );
      const statementBalance = bank
        .filter((item) => movementIds.has(item.id) && item.date <= date)
        .reduce((sum, item) => sum + item.amountBani, source.openingBani);
      requireCondition(
        balanceAt(account.ledgerAccount, date) === statementBalance,
        'BANK_DIFFERENCE',
        'Soldul contabil diferă de extrasul bancar.',
      );
    }
    for (const account of accounts.filter((item) => item.kind === 'cash')) {
      for (const date of [
        ...new Set(
          throughEnd
            .filter((line) => line.account === account.ledgerAccount)
            .map((line) => dates.get(line.journalId)!),
        ),
      ])
        requireCondition(
          balanceAt(account.ledgerAccount, date) >= 0n,
          'NEGATIVE_CASH',
          'Registrul de casă conține un sold negativ.',
        );
    }
    const accruals = await accrualControls(tx, actor.companyId, financialYear.from, monthEnd);
    requireCondition(
      accruals.accrualCount === 0 || accruals.status === 'reconciled',
      'ACCRUAL_CONTROL_DIFFERENCE',
      'Soldurile 408 sau 4428 diferă de angajamentele documentate. Verificați soldurile reportate și potrivirile facturilor.',
    );
    return {
      kind: 'periods.close' as const,
      month,
      journalCount: posted.filter((entry) => entry.date <= monthEnd).length,
      bankBalance: fromBani(
        banks.reduce((sum, account) => sum + balanceAt(account.ledgerAccount, monthEnd), 0n),
      ),
      cashBalance: fromBani(
        accounts
          .filter((item) => item.kind === 'cash')
          .reduce((sum, account) => sum + balanceAt(account.ledgerAccount, monthEnd), 0n),
      ),
      statementIds: covering.map((item) => item.id).sort(),
      // The short review projection is bound to the entire checked accounting state.
      // New proposals, imports, corrections or allocations invalidate the review.
      stateHash: sha256(
        canonical({
          company,
          financialYear,
          accruals,
          accounts,
          nativeMatched: nativeMatched.sort((a, b) => a.movementId.localeCompare(b.movementId)),
          imported: imported.sort((a, b) => a.id.localeCompare(b.id)),
          proposed: proposed.sort((a, b) => a.id.localeCompare(b.id)),
          posted: posted.sort((a, b) => a.number - b.number),
          outcomes: outcomes.sort((a, b) => a.proposalId.localeCompare(b.proposalId)),
          bank: bank
            .sort((a, b) => a.id.localeCompare(b.id))
            .map(({ amountBani, ...row }) => ({ ...row, amount: amountBani.toString() })),
          matched: matched
            .sort((a, b) => a.id.localeCompare(b.id))
            .map(({ amountBani, ...row }) => ({
              ...row,
              amount: amountBani.toString(),
            })),
          statement: statement
            .sort((a, b) => a.id.localeCompare(b.id))
            .map(({ openingBani, closingBani, ...row }) => ({
              ...row,
              opening: openingBani.toString(),
              closing: closingBani.toString(),
            })),
          links: links.sort(
            (a, b) =>
              a.statementId.localeCompare(b.statementId) ||
              a.movementId.localeCompare(b.movementId),
          ),
        }),
      ),
    };
  }

  async executeClose(tx: Transaction, actor: Actor, month: string) {
    const [previous] = await tx
      .select()
      .from(periods)
      .where(and(eq(periods.companyId, actor.companyId), eq(periods.month, month)));
    if (previous?.closedAt) return previous;
    await this.previewClose(tx, actor, month);
    const closedAt = new Date().toISOString();
    const [result] = await tx
      .insert(periods)
      .values({ companyId: actor.companyId, month, closedAt, closedBy: actor.actorId })
      .onConflictDoUpdate({
        target: [periods.companyId, periods.month],
        set: { closedAt, closedBy: actor.actorId },
      })
      .returning();
    return result;
  }
}
