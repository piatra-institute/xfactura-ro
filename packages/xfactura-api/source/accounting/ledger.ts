import { randomUUID } from 'node:crypto';
import { eq, max } from 'drizzle-orm';
import type { Transaction } from './db';
import type { Actor } from './commands';
import { assertBalanced, toBani, type PostingLine } from './domain';
import { journals } from './schema';

type Entry = {
  date: string;
  kind: 'opening' | 'purchase' | 'payment' | 'correction' | 'general';
  sourceId: string;
  evidenceId: string;
  approvalId?: string;
  description: string;
  lines: PostingLine[];
};

export async function postJournal(tx: Transaction, actor: Actor, entry: Entry) {
  assertBalanced(entry.lines);
  const [last] = await tx
    .select({ number: max(journals.number) })
    .from(journals)
    .where(eq(journals.companyId, actor.companyId));
  const [result] = await tx
    .insert(journals)
    .values({
      id: randomUUID(),
      companyId: actor.companyId,
      createdBy: actor.actorId,
      number: (last.number ?? 0) + 1,
      date: entry.date,
      kind: entry.kind,
      sourceId: entry.sourceId,
      evidenceId: entry.evidenceId,
      approvalId: entry.approvalId,
      description: entry.description,
      lines: entry.lines.map((line) => ({
        account: line.account,
        debitBani: toBani(line.debit).toString(),
        creditBani: toBani(line.credit).toString(),
      })),
    })
    .returning({ id: journals.id, number: journals.number });
  return result;
}
