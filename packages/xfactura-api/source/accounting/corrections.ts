import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { Commands, type Actor } from './commands';
import type { Transaction } from './db';
import {
  canonical,
  correctionBodySchema,
  correctionLines,
  correctionSchema,
  requireCondition,
  reviewSchema,
  toBani,
  type CorrectionInput,
} from './domain';
import { companyYear, findProposal, retainFact } from './books';
import {
  approvals,
  correctionOutcomes,
  fiscalInterpretations,
  journals,
  periods,
  proposals,
} from './schema';
import { postJournal } from './ledger';
import { sha256 } from './object-store';
import { purchaseState } from './purchase-state';

async function currentTarget(tx: Transaction, companyId: string, journalId: string) {
  const [target] = await tx
    .select()
    .from(journals)
    .where(and(eq(journals.companyId, companyId), eq(journals.id, journalId)));
  requireCondition(target, 'NOT_FOUND', 'Înregistrarea nu este disponibilă.', 404);
  requireCondition(
    target.kind === 'purchase' || target.kind === 'correction',
    'CORRECTION_SCOPE',
    'Acest flux corectează facturi de servicii contabilizate.',
  );
  const rootId =
    target.kind === 'purchase'
      ? target.sourceId
      : correctionBodySchema.parse((await findProposal(tx, companyId, target.sourceId)).body)
          .purchaseProposalId;
  const state = await purchaseState(tx, companyId, rootId);
  requireCondition(
    state.head.id === journalId,
    'STALE_CORRECTION',
    'Înregistrarea are deja o corecție. Reîncărcați ultima versiune.',
    409,
  );
  return state;
}

async function reviewedBody(tx: Transaction, actor: Actor, input: CorrectionInput) {
  const state = await currentTarget(tx, actor.companyId, input.journalId);
  const year = await companyYear(tx, actor.companyId);
  requireCondition(
    input.date.startsWith(`${year}-`) && input.date >= state.head.date,
    'CORRECTION_DATE',
    'Corecția trebuie înregistrată în același exercițiu, la data înregistrării corectate sau ulterior.',
  );
  const [period] = await tx
    .select()
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
    'Luna corecției este închisă. Alegeți o perioadă deschisă.',
    409,
  );
  requireCondition(
    input.amount !== state.amount,
    'UNCHANGED_AMOUNT',
    'Suma corectată este identică cu suma înregistrată.',
  );
  requireCondition(
    toBani(input.amount) >= state.paidBani,
    'ALLOCATED_PAYMENTS',
    'Suma corectată este mai mică decât plățile alocate. Revizuiți alocările înainte de corecție.',
    409,
  );
  return {
    body: { ...input, purchaseProposalId: state.proposal.id, previousAmount: state.amount },
    state,
  };
}

export class Corrections {
  constructor(private readonly runner: Commands) {}

  async propose(
    actor: Actor,
    key: string,
    input: unknown,
    revision?: { id: string; version: number },
  ) {
    const parsed = correctionSchema.parse(input);
    return this.runner.run(
      actor,
      key,
      revision ? 'corrections.revise' : 'corrections.propose',
      { body: parsed, revision: revision ?? null },
      'write',
      async (tx) => {
        const previous = revision
          ? await findProposal(tx, actor.companyId, revision.id)
          : undefined;
        if (previous && revision) {
          requireCondition(
            previous.kind === 'correction' && previous.version === revision.version,
            'STALE_VERSION',
            'Propunerea s-a schimbat. Reîncărcați datele.',
            409,
          );
          const [outcome] = await tx
            .select()
            .from(correctionOutcomes)
            .where(
              and(
                eq(correctionOutcomes.companyId, actor.companyId),
                eq(correctionOutcomes.proposalId, previous.id),
              ),
            );
          requireCondition(
            !outcome,
            'RESOLVED_CORRECTION',
            'Corecția a fost deja contabilizată sau retrasă.',
            409,
          );
        }
        const { body } = await reviewedBody(tx, actor, parsed);
        const factId = await retainFact(tx, actor, 'correction', body, previous?.factId);
        const version = (previous?.version ?? 0) + 1;
        const hash = sha256(canonical({ kind: 'correction', version, body, factId }));
        if (previous) {
          const [result] = await tx
            .update(proposals)
            .set({ factId, body, version, hash })
            .where(and(eq(proposals.companyId, actor.companyId), eq(proposals.id, previous.id)))
            .returning();
          return result;
        }
        const id = randomUUID();
        const [result] = await tx
          .insert(proposals)
          .values({
            id,
            companyId: actor.companyId,
            factId,
            kind: 'correction',
            version,
            hash,
            body,
            sourceKey: `correction:${id}`,
            createdBy: actor.actorId,
          })
          .returning();
        return result;
      },
    );
  }

  async post(actor: Actor, key: string, id: string, input: unknown) {
    const review = reviewSchema.parse(input);
    return this.runner.run(
      actor,
      key,
      'corrections.post',
      { id, ...review },
      'review',
      async (tx) => {
        const proposal = await findProposal(tx, actor.companyId, id);
        requireCondition(
          proposal.kind === 'correction' &&
            proposal.version === review.version &&
            proposal.hash === review.hash,
          'STALE_APPROVAL',
          'Versiunea verificată nu mai este actuală.',
          409,
        );
        const [outcome] = await tx
          .select()
          .from(correctionOutcomes)
          .where(
            and(
              eq(correctionOutcomes.companyId, actor.companyId),
              eq(correctionOutcomes.proposalId, id),
            ),
          );
        if (outcome) {
          requireCondition(
            outcome.status === 'posted',
            'WITHDRAWN',
            'Propunerea a fost retrasă.',
            409,
          );
          return { id: outcome.journalId! };
        }
        const snapshot = correctionBodySchema.parse(proposal.body);
        const { purchaseProposalId: _root, previousAmount: _amount, ...request } = snapshot;
        const { body, state } = await reviewedBody(tx, actor, request);
        requireCondition(
          canonical(body) === canonical(snapshot),
          'STALE_CORRECTION',
          'Baza corecției s-a schimbat. Refaceți propunerea.',
          409,
        );
        const [approval] = await tx
          .select()
          .from(approvals)
          .where(
            and(
              eq(approvals.companyId, actor.companyId),
              eq(approvals.proposalId, id),
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
        const fiscal = await tx
          .select()
          .from(fiscalInterpretations)
          .where(
            and(
              eq(fiscalInterpretations.companyId, actor.companyId),
              inArray(fiscalInterpretations.factId, [proposal.factId, state.proposal.factId]),
            ),
          );
        requireCondition(
          !fiscal.some((item) => item.affectsPosting && item.status !== 'APPROVED'),
          'FISCAL_JUDGMENT',
          'Tratamentul fiscal poate schimba suma contabilă; revizuirea este necesară.',
        );
        const journal = await postJournal(tx, actor, {
          kind: 'correction',
          sourceId: id,
          date: body.date,
          evidenceId: body.evidenceId,
          approvalId: approval.id,
          description: `${body.action === 'reverse' ? 'Stornare' : 'Corecție'} · ${state.body.supplier} · ${state.body.invoiceNumber}`,
          lines: correctionLines(body.previousAmount, body.amount),
        });
        await tx.insert(correctionOutcomes).values({
          companyId: actor.companyId,
          proposalId: id,
          purchaseProposalId: body.purchaseProposalId,
          targetJournalId: body.journalId,
          status: 'posted',
          journalId: journal.id,
          createdBy: actor.actorId,
        });
        return { id: journal.id };
      },
    );
  }

  async withdraw(actor: Actor, key: string, id: string, input: unknown) {
    const review = reviewSchema.parse(input);
    return this.runner.run(
      actor,
      key,
      'corrections.withdraw',
      { id, ...review },
      'write',
      async (tx) => {
        const proposal = await findProposal(tx, actor.companyId, id);
        requireCondition(
          proposal.kind === 'correction' &&
            proposal.version === review.version &&
            proposal.hash === review.hash,
          'STALE_APPROVAL',
          'Versiunea verificată nu mai este actuală.',
          409,
        );
        const [outcome] = await tx
          .select()
          .from(correctionOutcomes)
          .where(
            and(
              eq(correctionOutcomes.companyId, actor.companyId),
              eq(correctionOutcomes.proposalId, id),
            ),
          );
        if (outcome) {
          requireCondition(
            outcome.status === 'withdrawn',
            'ALREADY_POSTED',
            'Corecția este contabilizată și nu poate fi retrasă.',
            409,
          );
          return { id };
        }
        const body = correctionBodySchema.parse(proposal.body);
        await tx.insert(correctionOutcomes).values({
          companyId: actor.companyId,
          proposalId: id,
          purchaseProposalId: body.purchaseProposalId,
          targetJournalId: body.journalId,
          status: 'withdrawn',
          createdBy: actor.actorId,
        });
        return { id };
      },
    );
  }
}
