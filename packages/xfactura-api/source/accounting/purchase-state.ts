import { and, asc, eq } from 'drizzle-orm';
import type { Transaction } from './db';
import { correctionBodySchema, purchaseSchema, requireCondition, toBani } from './domain';
import { allocations, correctionOutcomes, journals, proposals } from './schema';

export async function purchaseState(tx: Transaction, companyId: string, proposalId: string) {
  const [proposal] = await tx
    .select()
    .from(proposals)
    .where(
      and(
        eq(proposals.companyId, companyId),
        eq(proposals.id, proposalId),
        eq(proposals.kind, 'purchase'),
      ),
    );
  const [original] = await tx
    .select()
    .from(journals)
    .where(
      and(
        eq(journals.companyId, companyId),
        eq(journals.sourceId, proposalId),
        eq(journals.kind, 'purchase'),
      ),
    );
  requireCondition(
    proposal && original,
    'NOT_FOUND',
    'Factura contabilizată nu este disponibilă.',
    404,
  );
  const body = purchaseSchema.parse(proposal.body);
  const rows = await tx
    .select({ proposal: proposals, journal: journals, outcome: correctionOutcomes })
    .from(correctionOutcomes)
    .innerJoin(
      proposals,
      and(
        eq(proposals.companyId, correctionOutcomes.companyId),
        eq(proposals.id, correctionOutcomes.proposalId),
      ),
    )
    .innerJoin(
      journals,
      and(
        eq(journals.companyId, correctionOutcomes.companyId),
        eq(journals.id, correctionOutcomes.journalId),
      ),
    )
    .where(
      and(
        eq(correctionOutcomes.companyId, companyId),
        eq(correctionOutcomes.purchaseProposalId, proposalId),
        eq(correctionOutcomes.status, 'posted'),
      ),
    )
    .orderBy(asc(journals.number));
  const changes = rows.map((row) => ({
    ...row,
    body: correctionBodySchema.parse(row.proposal.body),
  }));
  const paid = await tx
    .select()
    .from(allocations)
    .where(and(eq(allocations.companyId, companyId), eq(allocations.proposalId, proposalId)));
  const latest = changes.at(-1);
  return {
    proposal,
    body,
    original,
    changes,
    head: latest?.journal ?? original,
    amount: latest?.body.amount ?? body.amount,
    paidBani: paid.reduce((sum, item) => sum + item.amountBani, 0n),
  };
}

export function paymentCapacity(state: Awaited<ReturnType<typeof purchaseState>>, date: string) {
  requireCondition(
    date >= state.original.date,
    'PAYMENT_DATE',
    'Plata precedă înregistrarea facturii.',
  );
  let amount = toBani(state.body.amount);
  for (const change of state.changes)
    if (change.journal.date <= date) amount = toBani(change.body.amount);
  // A backdated allocation must also respect already posted later reductions.
  for (const change of state.changes)
    if (change.journal.date > date && toBani(change.body.amount) < amount)
      amount = toBani(change.body.amount);
  return amount;
}
