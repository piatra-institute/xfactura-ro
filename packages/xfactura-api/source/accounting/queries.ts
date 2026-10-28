import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { Commands, type Actor } from './commands';
import { supersededDeferralReleaseIds } from './deferral-state';
import {
  correctionBodySchema,
  fromBani,
  idSchema,
  proposalLines,
  requireCondition,
  trialBalance,
} from './domain';
import {
  allocations,
  accountingYears,
  approvals,
  companies,
  correctionOutcomes,
  evidence,
  fiscalInterpretations,
  jobs,
  journalLines,
  ledgerAccounts,
  journals,
  memberships,
  movements,
  movementPostings,
  invoiceSettlements,
  invoiceDocuments,
  invoiceArchiveEntries,
  periods,
  proposals,
  statements,
  taxPositions,
} from './schema';

export function overview(runner: Commands, actor: Actor, financialYearId?: string) {
  if (financialYearId) idSchema.parse(financialYearId);
  return runner.read(actor, async (tx, role) => {
    const [company] = await tx.select().from(companies).where(eq(companies.id, actor.companyId));
    const financialYears = await tx
      .select()
      .from(accountingYears)
      .where(
        and(eq(accountingYears.companyId, actor.companyId), eq(accountingYears.kind, 'financial')),
      )
      .orderBy(asc(accountingYears.from));
    const financialYear = financialYearId
      ? financialYears.find((year) => year.id === financialYearId)
      : financialYears.find((year) => year.from === `${company.year}-01-01`);
    requireCondition(financialYear, 'NOT_FOUND', 'Exercițiul financiar nu este disponibil.', 404);
    const sources = await tx
      .select()
      .from(evidence)
      .where(eq(evidence.companyId, actor.companyId))
      .orderBy(asc(evidence.createdAt));
    const proposed = await tx
      .select()
      .from(proposals)
      .where(
        and(
          eq(proposals.companyId, actor.companyId),
          sql`${proposals.body}->>'$.date' between ${financialYear.from} and ${financialYear.to}`,
        ),
      )
      .orderBy(asc(proposals.createdAt));
    const approved = await tx
      .select()
      .from(approvals)
      .where(eq(approvals.companyId, actor.companyId));
    const posted = await tx
      .select()
      .from(journals)
      .where(
        and(
          eq(journals.companyId, actor.companyId),
          gte(journals.date, financialYear.from),
          lte(journals.date, financialYear.to),
        ),
      )
      .orderBy(asc(journals.number));
    const lines = await tx
      .select()
      .from(journalLines)
      .where(eq(journalLines.companyId, actor.companyId))
      .orderBy(asc(journalLines.line));
    const payments = await tx
      .select()
      .from(allocations)
      .where(eq(allocations.companyId, actor.companyId));
    const nativeMatches = await tx
      .select()
      .from(movementPostings)
      .where(eq(movementPostings.companyId, actor.companyId));
    const nativePayments = await tx
      .select()
      .from(invoiceSettlements)
      .where(eq(invoiceSettlements.companyId, actor.companyId));
    const bankMovements = await tx
      .select()
      .from(movements)
      .where(
        and(
          eq(movements.companyId, actor.companyId),
          gte(movements.date, financialYear.from),
          lte(movements.date, financialYear.to),
        ),
      )
      .orderBy(asc(movements.date));
    const bankStatements = await tx
      .select()
      .from(statements)
      .where(
        and(
          eq(statements.companyId, actor.companyId),
          gte(statements.periodTo, financialYear.from),
          lte(statements.periodFrom, financialYear.to),
        ),
      )
      .orderBy(desc(statements.periodTo));
    const positions = await tx
      .select()
      .from(taxPositions)
      .where(eq(taxPositions.companyId, actor.companyId));
    const fiscal = await tx
      .select()
      .from(fiscalInterpretations)
      .where(eq(fiscalInterpretations.companyId, actor.companyId));
    const members = await tx
      .select()
      .from(memberships)
      .where(eq(memberships.companyId, actor.companyId));
    const outcomes = await tx
      .select()
      .from(correctionOutcomes)
      .where(eq(correctionOutcomes.companyId, actor.companyId));
    const superseded = await supersededDeferralReleaseIds(tx, actor.companyId);
    const closedPeriods = await tx
      .select()
      .from(periods)
      .where(
        and(
          eq(periods.companyId, actor.companyId),
          gte(periods.month, financialYear.from),
          lte(periods.month, financialYear.to),
        ),
      );
    const exports = await tx
      .select({
        id: jobs.id,
        status: jobs.status,
        result: jobs.result,
        error: jobs.error,
        createdAt: jobs.createdAt,
      })
      .from(jobs)
      .where(eq(jobs.companyId, actor.companyId))
      .orderBy(desc(jobs.createdAt));

    const postedIds = new Set(posted.map((entry) => entry.id));
    const codes = [
      ...new Set([
        ...lines.filter((line) => postedIds.has(line.journalId)).map((line) => line.account),
        ...proposed.flatMap((proposal) =>
          proposalLines(proposal.kind, proposal.body).map((line) => line.account),
        ),
      ]),
    ];
    const names = codes.length
      ? await tx
          .select({ code: ledgerAccounts.code, name: ledgerAccounts.name })
          .from(ledgerAccounts)
          .where(
            and(eq(ledgerAccounts.companyId, actor.companyId), inArray(ledgerAccounts.code, codes)),
          )
      : [];
    const invoiceIds = [
      ...new Set(
        proposed.flatMap(({ body }) => [
          ...('invoice' in body && body.invoice
            ? [
                body.invoice.invoiceId,
                ...(body.invoice.credit ? [body.invoice.credit.originalInvoiceId] : []),
                ...(body.invoice.advanceFinal?.allocations.map((row) => row.advanceInvoiceId) ??
                  []),
              ]
            : []),
          ...('settlement' in body && body.settlement
            ? body.settlement.allocations.map((item) => item.invoiceId)
            : []),
        ]),
      ),
    ];
    const invoiceLabels = invoiceIds.length
      ? await tx
          .select({
            id: invoiceDocuments.id,
            body: invoiceDocuments.body,
            evidenceId: invoiceDocuments.evidenceId,
            direction: invoiceDocuments.direction,
          })
          .from(invoiceDocuments)
          .where(
            and(
              eq(invoiceDocuments.companyId, actor.companyId),
              inArray(invoiceDocuments.id, invoiceIds),
            ),
          )
      : [];
    const archiveCounts = invoiceIds.length
      ? await tx
          .select({
            invoiceId: invoiceArchiveEntries.invoiceId,
            count: sql<number>`count(distinct ${invoiceArchiveEntries.archiveEvidenceId})`.mapWith(
              Number,
            ),
          })
          .from(invoiceArchiveEntries)
          .where(
            and(
              eq(invoiceArchiveEntries.companyId, actor.companyId),
              inArray(invoiceArchiveEntries.invoiceId, invoiceIds),
            ),
          )
          .groupBy(invoiceArchiveEntries.invoiceId)
      : [];
    const publicLines = lines
      .filter((line) => postedIds.has(line.journalId))
      .map((line) => ({
        account: line.account,
        debit: fromBani(line.debitBani),
        credit: fromBani(line.creditBani),
      }));
    return {
      company,
      financialYear,
      financialYears,
      invoiceArchiveCounts: Object.fromEntries(
        archiveCounts.map((row) => [row.invoiceId!, row.count]),
      ),
      accountNames: Object.fromEntries(names.map((row) => [row.code, row.name])),
      invoiceLabels: Object.fromEntries(
        invoiceLabels.map(({ id, body, evidenceId, direction }) => [
          id,
          {
            number: body.number,
            evidenceId,
            counterparty: direction === 'sale' ? body.customer.name : body.supplier.name,
          },
        ]),
      ),
      role,
      evidence: sources,
      taxPositions: positions,
      fiscalInterpretations: fiscal,
      members,
      corrections: outcomes,
      closedPeriods,
      jobs: exports,
      balances: trialBalance(publicLines),
      proposals: proposed.map((proposal) => {
        const applied = outcomes
          .filter(
            (outcome) => outcome.status === 'posted' && outcome.purchaseProposalId === proposal.id,
          )
          .map((outcome) => ({
            outcome,
            journal: posted.find((entry) => entry.id === outcome.journalId)!,
            proposal: proposed.find((item) => item.id === outcome.proposalId)!,
          }))
          .sort((a, b) => a.journal.number - b.journal.number);
        const latest = applied.at(-1);
        return {
          ...proposal,
          superseded: superseded.has(proposal.id),
          withdrawn: outcomes.some(
            (outcome) => outcome.proposalId === proposal.id && outcome.status === 'withdrawn',
          ),
          currentAmount: latest
            ? correctionBodySchema.parse(latest.proposal.body).amount
            : proposal.body.amount,
          currentJournalId:
            latest?.journal.id ??
            posted.find((entry) => entry.kind === proposal.kind && entry.sourceId === proposal.id)
              ?.id ??
            null,
          approved: approved.some(
            (item) =>
              item.proposalId === proposal.id &&
              item.version === proposal.version &&
              item.hash === proposal.hash,
          ),
          posted: posted.some(
            (item) => item.kind === proposal.kind && item.sourceId === proposal.id,
          ),
          paid: fromBani(
            'invoice' in proposal.body && proposal.body.invoice && !proposal.body.invoice.credit
              ? nativePayments
                  .filter(
                    (item) =>
                      item.invoiceId ===
                      ('invoice' in proposal.body ? proposal.body.invoice?.invoiceId : null),
                  )
                  .reduce((sum, item) => sum + item.clearedBani, 0n)
              : payments
                  .filter((item) => item.proposalId === proposal.id)
                  .reduce((sum, item) => sum + item.amountBani, 0n),
          ),
        };
      }),
      journals: posted.map(({ lines: _stored, ...entry }) => ({
        ...entry,
        correctsJournalId:
          outcomes.find((outcome) => outcome.journalId === entry.id)?.targetJournalId ??
          proposed.flatMap((proposal) =>
            proposal.id === entry.sourceId &&
            'correctsJournalId' in proposal.body &&
            proposal.body.correctsJournalId
              ? [proposal.body.correctsJournalId]
              : [],
          )[0] ??
          null,
        correctedByJournalId:
          outcomes.find(
            (outcome) => outcome.targetJournalId === entry.id && outcome.status === 'posted',
          )?.journalId ?? null,
        lines: lines
          .filter((line) => line.journalId === entry.id)
          .map((line) => ({
            account: line.account,
            debit: fromBani(line.debitBani),
            credit: fromBani(line.creditBani),
          })),
      })),
      movements: bankMovements.map(({ amountBani, ...movement }) => ({
        ...movement,
        amount: fromBani(amountBani),
        matched:
          payments.some((item) => item.movementId === movement.id) ||
          nativeMatches.some((item) => item.movementId === movement.id),
      })),
      statements: bankStatements.map(({ openingBani, closingBani, ...statement }) => ({
        ...statement,
        opening: fromBani(openingBani),
        closing: fromBani(closingBani),
      })),
    };
  });
}
export type Overview = Awaited<ReturnType<typeof overview>>;
