import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Commands, type Actor } from './commands';
import type { Transaction } from './db';
import {
  Amount,
  canonical,
  idSchema,
  openingSchema,
  purchaseSchema,
  reviewSchema,
  postingLines,
  requireCondition,
  type ProposalBody,
} from './domain';
import {
  approvals,
  companies,
  correctionOutcomes,
  evidence,
  facts,
  fiscalInterpretations,
  journals,
  proposals,
  taxPositions,
} from './schema';
import { sha256 } from './object-store';
import { postJournal } from './ledger';
import { postGeneral } from './general-ledger';
import { financialYearForDate } from './foundation';

export async function companyYear(tx: Transaction, companyId: string) {
  const [company] = await tx.select().from(companies).where(eq(companies.id, companyId));
  requireCondition(company, 'NOT_FOUND', 'Compania nu este disponibilă.', 404);
  return company.year;
}

export async function retainFact(
  tx: Transaction,
  actor: Actor,
  kind: 'opening' | 'purchase' | 'correction',
  body: ProposalBody,
  supersedesId?: string,
) {
  const [source] = await tx
    .select({ id: evidence.id })
    .from(evidence)
    .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, body.evidenceId)));
  requireCondition(source, 'NOT_FOUND', 'Documentul nu este disponibil.', 404);
  const factId = randomUUID();
  await tx.insert(facts).values({
    id: factId,
    companyId: actor.companyId,
    kind,
    body,
    evidenceId: body.evidenceId,
    supersedesId,
    createdBy: actor.actorId,
  });

  let [position] = await tx
    .select()
    .from(taxPositions)
    .where(eq(taxPositions.companyId, actor.companyId));
  if (!position) {
    const year = await companyYear(tx, actor.companyId);
    [position] = await tx
      .insert(taxPositions)
      .values({
        id: randomUUID(),
        companyId: actor.companyId,
        periodFrom: `${year}-01-01`,
        periodTo: `${year}-12-31`,
      })
      .returning();
  }
  await tx
    .insert(fiscalInterpretations)
    .values({ id: randomUUID(), companyId: actor.companyId, factId, positionId: position.id });
  return factId;
}

export async function findProposal(tx: Transaction, companyId: string, id: string) {
  idSchema.parse(id);
  const [proposal] = await tx
    .select()
    .from(proposals)
    .where(and(eq(proposals.companyId, companyId), eq(proposals.id, id)));
  requireCondition(proposal, 'NOT_FOUND', 'Propunerea nu este disponibilă.', 404);
  return proposal;
}

export class Books {
  constructor(private readonly runner: Commands) {}

  async proposeOpening(actor: Actor, key: string, input: unknown) {
    const body = openingSchema.parse(input);
    return this.runner.run(actor, key, 'books.proposeOpening', body, 'write', async (tx) => {
      const year = await companyYear(tx, actor.companyId);
      requireCondition(
        body.date === `${year}-01-01` && new Amount(body.amount).gt(0),
        'OPENING_SCOPE',
        'Poziția inițială trebuie să aibă un sold pozitiv la 1 ianuarie.',
      );
      const [previous] = await tx
        .select()
        .from(proposals)
        .where(and(eq(proposals.companyId, actor.companyId), eq(proposals.sourceKey, 'opening')));
      if (previous) {
        requireCondition(
          canonical(previous.body) === canonical(body),
          'OPENING_EXISTS',
          'Există deja o poziție inițială.',
          409,
        );
        return previous;
      }
      const existing = await tx
        .select()
        .from(proposals)
        .where(and(eq(proposals.companyId, actor.companyId), eq(proposals.kind, 'general')));
      requireCondition(
        !existing.some(
          (row) =>
            'purpose' in row.body && row.body.purpose === 'opening' && row.body.date === body.date,
        ),
        'OPENING_EXISTS',
        'Există deja o poziție inițială.',
        409,
      );
      const factId = await retainFact(tx, actor, 'opening', body);
      const hash = sha256(canonical({ kind: 'opening', version: 1, body, factId }));
      const [proposal] = await tx
        .insert(proposals)
        .values({
          id: randomUUID(),
          companyId: actor.companyId,
          factId,
          kind: 'opening',
          hash,
          body,
          sourceKey: 'opening',
          createdBy: actor.actorId,
        })
        .returning();
      return proposal;
    });
  }

  async proposePurchase(
    actor: Actor,
    key: string,
    input: unknown,
    revision?: { id: string; version: number },
  ) {
    const body = purchaseSchema.parse(input);
    requireCondition(
      new Amount(body.amount).gt(0),
      'AMOUNT',
      'Suma trebuie să fie mai mare decât zero.',
    );
    return this.runner.run(
      actor,
      key,
      revision ? 'books.revisePurchase' : 'books.proposePurchase',
      { body, revision: revision ?? null },
      'write',
      async (tx) => {
        const year = await companyYear(tx, actor.companyId);
        requireCondition(
          body.date.startsWith(`${year}-`) &&
            body.date.slice(0, 7) === body.serviceDate.slice(0, 7),
          'PERIOD_SCOPE',
          'Serviciul și factura trebuie să aparțină aceleiași luni din anul companiei. Pentru perioade diferite, este necesară revizuirea tratamentului contabil.',
        );
        const sourceKey = sha256(canonical([body.supplierCui, body.invoiceNumber, body.date]));
        const previous = revision
          ? await findProposal(tx, actor.companyId, revision.id)
          : undefined;
        if (revision && previous) {
          requireCondition(
            previous.kind === 'purchase' && previous.version === revision.version,
            'STALE_VERSION',
            'Propunerea s-a schimbat. Reîncărcați datele.',
            409,
          );
          const [posted] = await tx
            .select({ id: journals.id })
            .from(journals)
            .where(
              and(
                eq(journals.companyId, actor.companyId),
                eq(journals.kind, 'purchase'),
                eq(journals.sourceId, previous.id),
              ),
            );
          requireCondition(
            !posted,
            'ALREADY_POSTED',
            'O înregistrare contabilizată se corectează printr-o procedură separată.',
            409,
          );
        } else {
          const [duplicate] = await tx
            .select()
            .from(proposals)
            .where(
              and(eq(proposals.companyId, actor.companyId), eq(proposals.sourceKey, sourceKey)),
            );
          if (duplicate) {
            requireCondition(
              canonical(duplicate.body) === canonical(body),
              'DUPLICATE_INVOICE',
              'Această factură există cu alte date. Revizuiți sursele.',
              409,
            );
            return duplicate;
          }
        }

        const factId = await retainFact(tx, actor, 'purchase', body, previous?.factId);
        const version = (previous?.version ?? 0) + 1;
        const hash = sha256(canonical({ kind: 'purchase', version, body, factId }));
        if (previous) {
          const [proposal] = await tx
            .update(proposals)
            .set({ factId, version, hash, body, sourceKey })
            .where(and(eq(proposals.companyId, actor.companyId), eq(proposals.id, previous.id)))
            .returning();
          return proposal;
        }
        const [proposal] = await tx
          .insert(proposals)
          .values({
            id: randomUUID(),
            companyId: actor.companyId,
            factId,
            kind: 'purchase',
            hash,
            body,
            sourceKey,
            createdBy: actor.actorId,
          })
          .returning();
        return proposal;
      },
    );
  }

  async approve(actor: Actor, key: string, proposalId: string, input: unknown) {
    const review = reviewSchema.parse(input);
    return this.runner.run(
      actor,
      key,
      'books.approve',
      { proposalId, ...review },
      'review',
      async (tx) => {
        const proposal = await findProposal(tx, actor.companyId, proposalId);
        const [outcome] = await tx
          .select()
          .from(correctionOutcomes)
          .where(
            and(
              eq(correctionOutcomes.companyId, actor.companyId),
              eq(correctionOutcomes.proposalId, proposalId),
            ),
          );
        requireCondition(
          !outcome || outcome.status === 'posted',
          'WITHDRAWN',
          'Propunerea a fost retrasă.',
          409,
        );
        requireCondition(
          proposal.version === review.version && proposal.hash === review.hash,
          'STALE_APPROVAL',
          'Versiunea verificată nu mai este actuală.',
          409,
        );
        const [previous] = await tx
          .select()
          .from(approvals)
          .where(
            and(
              eq(approvals.companyId, actor.companyId),
              eq(approvals.proposalId, proposalId),
              eq(approvals.version, review.version),
            ),
          );
        if (previous) return previous;
        const [approval] = await tx
          .insert(approvals)
          .values({
            id: randomUUID(),
            companyId: actor.companyId,
            proposalId,
            ...review,
            createdBy: actor.actorId,
          })
          .returning();
        return approval;
      },
    );
  }

  async post(actor: Actor, key: string, proposalId: string, input: unknown) {
    const review = reviewSchema.parse(input);
    return this.runner.run(
      actor,
      key,
      'books.post',
      { proposalId, ...review },
      'review',
      async (tx) => {
        const proposal = await findProposal(tx, actor.companyId, proposalId);
        if (proposal.kind === 'general') {
          requireCondition(
            !actor.agentId,
            'AGENT_SCOPE',
            'Folosiți capabilitatea ledger.post pentru înregistrări generale.',
            403,
          );
          return postGeneral(tx, actor, proposalId, review);
        }
        requireCondition(
          proposal.kind !== 'correction',
          'CORRECTION_WORKFLOW',
          'Folosiți acțiunea de contabilizare a corecției.',
          409,
        );
        requireCondition(
          proposal.version === review.version && proposal.hash === review.hash,
          'STALE_APPROVAL',
          'Versiunea verificată nu mai este actuală.',
          409,
        );
        const [previous] = await tx
          .select({ id: journals.id, number: journals.number })
          .from(journals)
          .where(
            and(
              eq(journals.companyId, actor.companyId),
              eq(journals.kind, proposal.kind),
              eq(journals.sourceId, proposalId),
            ),
          );
        if (previous) return previous;
        const [approval] = await tx
          .select()
          .from(approvals)
          .where(
            and(
              eq(approvals.companyId, actor.companyId),
              eq(approvals.proposalId, proposalId),
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
        if (proposal.kind === 'purchase') {
          const year = await financialYearForDate(tx, actor.companyId, proposal.body.date);
          const openings = await tx
            .select({ kind: journals.kind, body: proposals.body })
            .from(journals)
            .leftJoin(
              proposals,
              and(eq(proposals.companyId, journals.companyId), eq(proposals.id, journals.sourceId)),
            )
            .where(and(eq(journals.companyId, actor.companyId), eq(journals.date, year.from)));
          requireCondition(
            openings.some(
              (row) =>
                row.kind === 'opening' ||
                (row.kind === 'general' &&
                  row.body &&
                  'purpose' in row.body &&
                  row.body.purpose === 'opening'),
            ),
            'OPENING_REQUIRED',
            'Contabilizați poziția inițială mai întâi.',
          );
        }
        const fiscal = await tx
          .select()
          .from(fiscalInterpretations)
          .where(
            and(
              eq(fiscalInterpretations.companyId, actor.companyId),
              eq(fiscalInterpretations.factId, proposal.factId),
            ),
          );
        requireCondition(
          !fiscal.some((item) => item.affectsPosting && item.status !== 'APPROVED'),
          'FISCAL_JUDGMENT',
          'Tratamentul fiscal poate schimba suma contabilă; revizuirea este necesară.',
        );
        const description =
          proposal.kind === 'opening'
            ? 'Poziție inițială aprobată'
            : `${purchaseSchema.parse(proposal.body).supplier} · ${purchaseSchema.parse(proposal.body).invoiceNumber}`;
        return postJournal(tx, actor, {
          date: proposal.body.date,
          kind: proposal.kind,
          sourceId: proposalId,
          evidenceId: proposal.body.evidenceId,
          approvalId: approval.id,
          description,
          lines: postingLines(proposal.kind, proposal.body.amount),
        });
      },
    );
  }
}
