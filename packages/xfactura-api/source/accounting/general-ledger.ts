import { randomUUID } from 'node:crypto';
import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import { z } from 'zod';
import { Commands, type Actor } from './commands';
import type { Transaction } from './db';
import {
  Amount,
  assertBalanced,
  canonical,
  dateSchema,
  fromBani,
  generalBodySchema,
  generalJournalSchema,
  idSchema,
  requireCondition,
  reviewSchema,
  type GeneralBody,
} from './domain';
import {
  accountingYears,
  approvals,
  evidence,
  facts,
  journalLines,
  journals,
  ledgerAccounts,
  proposals,
} from './schema';
import { financialYearForDate } from './foundation';
import { sha256 } from './object-store';
import { postJournal } from './ledger';
import { findProposal } from './books';
import { checkInvoicePosting } from './invoice-postings';
import { checkSettlementPosting } from './settlements';
import { checkAccrualPosting } from './accruals';
import { checkUnbilledSalePosting } from './unbilled-sales';
import { checkAccrualAdjustmentPosting } from './accrual-adjustments';
import { checkDeferralReleasePosting } from './deferral-interpretation';
import { checkAdvancePaymentPosting } from './advance-interpretation';
import { checkAdvanceRefundPosting } from './advance-refunds';
import { checkUnbilledSaleAdjustmentPosting } from './unbilled-sale-adjustments';

export const ledgerReviewInput = reviewSchema.extend({ id: idSchema }).strict();
export const balanceInput = z
  .object({ financialYearId: idSchema, from: dateSchema.optional(), to: dateSchema.optional() })
  .strict();

async function validateBody(tx: Transaction, actor: Actor, body: GeneralBody) {
  requireCondition(
    [
      body.invoice,
      body.settlement,
      body.accrual,
      body.unbilledSale,
      body.unbilledSaleAdjustment,
      body.accrualAdjustment,
      body.deferralRelease,
      body.advancePayment,
      body.advanceRefund,
    ].filter(Boolean).length <= 1,
    'MULTIPLE_ORIGINS',
    'O propunere are o singură origine economică.',
  );
  assertBalanced(body.lines);
  const year = await financialYearForDate(tx, actor.companyId, body.date);
  requireCondition(
    year.id === body.financialYearId,
    'FINANCIAL_YEAR',
    'Exercițiul financiar nu corespunde datei.',
  );
  const [source] = await tx
    .select({ id: evidence.id })
    .from(evidence)
    .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, body.evidenceId)));
  requireCondition(source, 'NOT_FOUND', 'Documentul nu este disponibil.', 404);
  const codes = [...new Set(body.lines.map((line) => line.account))];
  const accounts = await tx
    .select()
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.companyId, actor.companyId), inArray(ledgerAccounts.code, codes)));
  requireCondition(
    accounts.length === codes.length &&
      accounts.every(
        (account) =>
          account.postable && account.book === 'general' && account.validFrom <= body.date,
      ),
    'ACCOUNT',
    'Contul nu este disponibil pentru înregistrare la această dată.',
  );
  if (body.purpose === 'opening')
    requireCondition(
      body.date === year.from,
      'OPENING_DATE',
      'Poziția inițială trebuie să fie la începutul exercițiului.',
    );
  if (body.correctsJournalId) {
    const [target] = await tx
      .select()
      .from(journals)
      .where(and(eq(journals.companyId, actor.companyId), eq(journals.id, body.correctsJournalId)));
    requireCondition(
      target && body.purpose === 'adjustment' && body.date >= target.date,
      'CORRECTION_TARGET',
      'Referință de corecție invalidă.',
    );
  }
  await checkInvoicePosting(tx, actor, body);
  await checkSettlementPosting(tx, actor, body);
  await checkAccrualPosting(tx, actor, body);
  await checkUnbilledSalePosting(tx, actor, body);
  await checkUnbilledSaleAdjustmentPosting(tx, actor, body);
  await checkAccrualAdjustmentPosting(tx, actor, body);
  await checkDeferralReleasePosting(tx, actor, body);
  await checkAdvancePaymentPosting(tx, actor, body);
  await checkAdvanceRefundPosting(tx, actor, body);
}

/** Shared by the capability endpoint and the existing human proposal-review route. */
export async function postGeneral(
  tx: Transaction,
  actor: Actor,
  proposalId: string,
  review: z.infer<typeof reviewSchema>,
) {
  const proposal = await findProposal(tx, actor.companyId, proposalId);
  requireCondition(
    proposal.kind === 'general' &&
      proposal.version === review.version &&
      proposal.hash === review.hash,
    'STALE_APPROVAL',
    'Propunerea sau versiunea verificată diferă.',
    409,
  );
  const body = generalBodySchema.parse(proposal.body);
  const [previous] = await tx
    .select({ id: journals.id, number: journals.number })
    .from(journals)
    .where(
      and(
        eq(journals.companyId, actor.companyId),
        eq(journals.kind, 'general'),
        eq(journals.sourceId, proposal.id),
      ),
    );
  if (previous) return previous;
  await validateBody(tx, actor, body);
  const [approval] = await tx
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.companyId, actor.companyId),
        eq(approvals.proposalId, proposal.id),
        eq(approvals.version, review.version),
        eq(approvals.hash, review.hash),
      ),
    );
  requireCondition(
    approval,
    'APPROVAL_REQUIRED',
    'Aprobați versiunea exactă înainte de contabilizare.',
    409,
  );
  return postJournal(tx, actor, {
    date: body.date,
    kind: 'general',
    sourceId: proposal.id,
    approvalId: approval.id,
    evidenceId: body.evidenceId,
    description: body.description,
    lines: body.lines,
  });
}

export function generalBody(input: unknown) {
  const parsed = generalJournalSchema.parse(input);
  assertBalanced(parsed.lines);
  return generalBodySchema.parse({
    ...parsed,
    schemaVersion: 2,
    ruleVersion: 'ro-general-ledger-2',
    amount: parsed.lines.reduce((sum, line) => sum.plus(line.debit), new Amount(0)).toFixed(2),
  });
}

/** Must be called inside an authorized command transaction. */
export async function retainGeneralProposal(
  tx: Transaction,
  actor: Actor,
  body: GeneralBody,
  revision?: { id: string; version: number },
) {
  await validateBody(tx, actor, body);
  const sourceKey =
    body.purpose === 'opening'
      ? `general-opening:${body.financialYearId}`
      : sha256(canonical(['general', body.financialYearId, body.purpose, body.sourceReference]));
  const previous = revision ? await findProposal(tx, actor.companyId, revision.id) : undefined;
  if (revision && previous) {
    requireCondition(
      previous.kind === 'general' && previous.version === revision.version,
      'STALE_VERSION',
      'Propunerea s-a schimbat.',
      409,
    );
    const [posted] = await tx
      .select({ id: journals.id })
      .from(journals)
      .where(
        and(
          eq(journals.companyId, actor.companyId),
          eq(journals.sourceId, previous.id),
          eq(journals.kind, 'general'),
        ),
      );
    requireCondition(
      !posted,
      'ALREADY_POSTED',
      'O înregistrare contabilizată se corectează printr-o înregistrare legată.',
      409,
    );
  }
  if (!revision) {
    const [duplicate] = await tx
      .select()
      .from(proposals)
      .where(and(eq(proposals.companyId, actor.companyId), eq(proposals.sourceKey, sourceKey)));
    if (duplicate) {
      requireCondition(
        canonical(duplicate.body) === canonical(body),
        'SOURCE_CONFLICT',
        'Referința există cu alte date.',
        409,
      );
      return duplicate;
    }
  }
  if (body.purpose === 'opening') {
    const existing = await tx
      .select()
      .from(proposals)
      .where(eq(proposals.companyId, actor.companyId));
    requireCondition(
      !existing.some(
        (row) =>
          row.id !== previous?.id &&
          row.body.date === body.date &&
          (row.kind === 'opening' ||
            (row.kind === 'general' && generalBodySchema.parse(row.body).purpose === 'opening')),
      ),
      'OPENING_EXISTS',
      'Există deja o poziție inițială pentru acest exercițiu.',
      409,
    );
  }
  const factId = randomUUID(),
    version = (previous?.version ?? 0) + 1;
  await tx.insert(facts).values({
    id: factId,
    companyId: actor.companyId,
    kind: 'general',
    evidenceId: body.evidenceId,
    body,
    supersedesId: previous?.factId,
    createdBy: actor.actorId,
  });
  const hash = sha256(canonical({ kind: 'general', version, body, factId }));
  if (previous) {
    const [proposal] = await tx
      .update(proposals)
      .set({ factId, body, version, hash, sourceKey })
      .where(and(eq(proposals.companyId, actor.companyId), eq(proposals.id, previous.id)))
      .returning();
    return proposal;
  }
  const [proposal] = await tx
    .insert(proposals)
    .values({
      id: randomUUID(),
      companyId: actor.companyId,
      kind: 'general',
      factId,
      body,
      version,
      hash,
      sourceKey,
      createdBy: actor.actorId,
    })
    .returning();
  return proposal;
}

export class GeneralLedger {
  constructor(private readonly runner: Commands) {}
  async propose(
    actor: Actor,
    key: string,
    input: unknown,
    revision?: { id: string; version: number },
  ) {
    const body = generalBody(input);
    return this.runner.run(
      actor,
      key,
      revision ? 'ledger.revise' : 'ledger.propose',
      { body, revision: revision ?? null },
      'write',
      (tx) => retainGeneralProposal(tx, actor, body, revision),
    );
  }
  post(actor: Actor, key: string, input: unknown) {
    const { id, ...review } = ledgerReviewInput.parse(input);
    return this.runner.run(actor, key, 'ledger.post', { id, ...review }, 'review', (tx) =>
      postGeneral(tx, actor, id, review),
    );
  }
  balance(actor: Actor, input: unknown) {
    const body = balanceInput.parse(input);
    return this.runner.read(
      actor,
      async (tx) => {
        const [year] = await tx
          .select()
          .from(accountingYears)
          .where(
            and(
              eq(accountingYears.companyId, actor.companyId),
              eq(accountingYears.id, body.financialYearId),
              eq(accountingYears.kind, 'financial'),
            ),
          );
        requireCondition(year, 'NOT_FOUND', 'Exercițiul nu este disponibil.', 404);
        const from = body.from ?? year.from,
          to = body.to ?? year.to;
        requireCondition(
          from >= year.from && to <= year.to && from <= to,
          'REPORT_PERIOD',
          'Intervalul trebuie să aparțină exercițiului financiar.',
        );
        const rows = await tx
          .select({ line: journalLines, date: journals.date })
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
              gte(journals.date, year.from),
              lte(journals.date, to),
            ),
          )
          .orderBy(asc(journalLines.account));
        const balances = new Map<string, { opening: bigint; debit: bigint; credit: bigint }>();
        for (const { line, date } of rows) {
          const row = balances.get(line.account) ?? { opening: 0n, debit: 0n, credit: 0n };
          if (date < from) row.opening += line.debitBani - line.creditBani;
          else {
            row.debit += line.debitBani;
            row.credit += line.creditBani;
          }
          balances.set(line.account, row);
        }
        return {
          financialYear: year,
          from,
          to,
          balances: [...balances].map(([account, row]) => ({
            account,
            opening: fromBani(row.opening),
            debit: fromBani(row.debit),
            credit: fromBani(row.credit),
            closing: fromBani(row.opening + row.debit - row.credit),
          })),
        };
      },
      'ledger.balance',
    );
  }
}
