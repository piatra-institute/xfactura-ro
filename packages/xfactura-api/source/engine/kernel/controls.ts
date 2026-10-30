import { and, desc, eq, lte, notExists } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { requireCondition } from 'xfactura-core/errors';
import type { Transaction } from '../db/database';
import { memberships, profileFacts } from '../db/schema';
import { roleAllows } from './commands';

/**
 * Segregation of duties, the company's `controls.segregation` fact:
 * - `off`, the default (a company of one person): whoever may review approves anything;
 * - `on`: nobody approves a proposal version they created themselves, without an agent, nor an
 *   action they requested themselves;
 * - `strict`: as `on`, and nobody approves what an agent did under a grant they issued.
 * A posting policy approves in advance, so its approver is held to the same rule.
 */
export type Segregation = 'off' | 'on' | 'strict';

/** Work someone may approve: who it was created in the name of, and through which agent grant. */
export type Work = { createdBy: string; agentId: string | null };

/**
 * The segregation in force on a date. The database reads it the same way (the `segregation`
 * invariants), on UTC's date and the next day, and applies the more lenient of the two, so it
 * never refuses what the application allowed on the Bucharest date.
 */
export async function segregationOn(
  tx: Pick<Transaction, 'select'>,
  companyId: string,
  date: string,
): Promise<Segregation> {
  const later = alias(profileFacts, 'later');
  const [fact] = await tx
    .select({ value: profileFacts.value })
    .from(profileFacts)
    .where(
      and(
        eq(profileFacts.companyId, companyId),
        eq(profileFacts.axis, 'controls.segregation'),
        lte(profileFacts.effectiveFrom, date),
        notExists(
          tx
            .select({ id: later.id })
            .from(later)
            .where(
              and(
                eq(later.companyId, profileFacts.companyId),
                eq(later.supersedesId, profileFacts.id),
              ),
            ),
        ),
      ),
    )
    .orderBy(desc(profileFacts.effectiveFrom), desc(profileFacts.createdAt), desc(profileFacts.id))
    .limit(1);
  return fact?.value === 'on' || fact?.value === 'strict' ? fact.value : 'off';
}

/** Whether segregation forbids `person` approving `work`. */
export function selfApproval(level: Segregation, person: string, work: Work) {
  if (level === 'off' || person !== work.createdBy) return false;
  return level === 'strict' || work.agentId === null;
}

const segregationMessages = {
  proposal: {
    own: 'Separarea atribuțiilor: versiunea se aprobă de altă persoană decât cea care a creat-o.',
    agent:
      'Separarea strictă a atribuțiilor: propunerea unui agent nu se aprobă de persoana care i-a emis accesul.',
  },
  action: {
    own: 'Separarea atribuțiilor: acțiunea se aprobă de altă persoană decât cea care a cerut-o.',
    agent:
      'Separarea strictă a atribuțiilor: acțiunea cerută de un agent nu se aprobă de persoana care i-a emis accesul.',
  },
};

/** Refuses an approval that segregation of duties forbids. */
export function requireSegregated(
  level: Segregation,
  person: string,
  work: Work,
  kind: keyof typeof segregationMessages,
) {
  requireCondition(
    !selfApproval(level, person, work),
    'SEGREGATION',
    segregationMessages[kind][work.agentId === null ? 'own' : 'agent'],
    403,
    { segregation: level },
  );
}

/**
 * Refuses to act on an approval whose giver no longer holds the authority they gave it under:
 * an active owner or reviewer whose membership has not changed since (same epoch).
 */
export async function requireActiveApprover(
  tx: Pick<Transaction, 'select'>,
  companyId: string,
  approver: { userId: string; epoch: number },
  message: string,
) {
  const [member] = await tx
    .select()
    .from(memberships)
    .where(and(eq(memberships.companyId, companyId), eq(memberships.userId, approver.userId)));
  requireCondition(
    member?.active && roleAllows(member.role, 'review') && member.epoch === approver.epoch,
    'APPROVER_INACTIVE',
    message,
    409,
  );
}
