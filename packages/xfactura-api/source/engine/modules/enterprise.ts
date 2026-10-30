import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { entityFormOf } from 'xfactura-core/ro/entity';
import type { LocalDate } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import { enterpriseMembers, evidence, parties, partyCnps } from '../db/schema';
import { appendAudit, type Actor, type Commands } from '../kernel/commands';
import { loadState } from '../kernel/state';

const day = z.iso.date();
/** A quota as a percent with up to two decimals: 60, 33.33. */
const quota = z.string().regex(/^(100(\.0{1,2})?|[1-9]?\d(\.\d{1,2})?)$/);

export const membersInput = z
  .object({
    /** The day the agreement applies from: the acord de constituire's, or its addendum's. */
    effectiveFrom: day,
    /** The day the enterprise ends, when known. */
    effectiveTo: day.optional(),
    members: z
      .array(
        z
          .object({
            /** An individual partner whose CNP is recorded, sealed (parties.recordCnp). */
            partyId: z.uuid(),
            /** The member's percent of the net income and of the loss (art. 29 alin. (1)). */
            quota,
            representative: z.boolean(),
          })
          .strict(),
      )
      .min(2)
      .max(50),
    /** The acord de constituire, or the addendum. */
    evidenceId: z.uuid(),
  })
  .strict()
  .refine((input) => !input.effectiveTo || input.effectiveFrom <= input.effectiveTo, {
    message: 'Acordul se încheie după ce începe.',
    path: ['effectiveTo'],
  });

/** Hundredths of a percent: '33.33' is 3333. */
export const quotaBp = (value: string) => {
  const [whole, fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
};
export const quotaText = (bp: number) =>
  `${Math.trunc(bp / 100)}.${String(bp % 100).padStart(2, '0')}`;

export type MemberRow = typeof enterpriseMembers.$inferSelect;

/** Every agreement version, oldest first, each with its members in the order recorded. */
export async function agreements(tx: Transaction, companyId: string) {
  const rows = await tx
    .select()
    .from(enterpriseMembers)
    .where(eq(enterpriseMembers.companyId, companyId))
    .orderBy(asc(enterpriseMembers.version), asc(enterpriseMembers.position));
  return [...Map.groupBy(rows, (row) => row.version)].map(([version, members]) => ({
    version,
    effectiveFrom: members[0]!.effectiveFrom,
    effectiveTo: members[0]!.effectiveTo,
    evidenceId: members[0]!.evidenceId,
    members,
  }));
}

export type Agreement = Awaited<ReturnType<typeof agreements>>[number];

/** The agreements in force at some point of a period: those starting before its end and not
 * replaced or ended before its start. */
export function agreementsIn(all: readonly Agreement[], start: string, end: string) {
  return all.filter((agreement, index) => {
    const next = all[index + 1];
    return (
      agreement.effectiveFrom <= end &&
      (!next || next.effectiveFrom > start) &&
      (!agreement.effectiveTo || agreement.effectiveTo >= start)
    );
  });
}

/**
 * The members of a family enterprise (OUG nr. 44/2008 art. 28–31): who they are, each one's
 * quota of the net income and of the loss, and the representative, as the acord de constituire or
 * an addendum sets them. Each agreement is recorded whole and complete: at least 2 members (art.
 * 28 alin. (1)), quotas adding to 100% and one representative (art. 29 alin. (1)–(2)), each an
 * individual whose CNP is sealed. The database checks the same again, and that a new agreement
 * follows only a complete one.
 */
export class EnterpriseMembers {
  constructor(private readonly commands: Commands) {}

  record(actor: Actor, key: string, input: z.infer<typeof membersInput>) {
    return this.commands.run(actor, key, 'if.members.record', input, 'review', async (tx) => {
      const { loaded } = await loadState(tx, actor.companyId, { profile: true });
      requireCondition(
        entityFormOf(loaded.profile, input.effectiveFrom as LocalDate) === 'if',
        'ENTERPRISE_MEMBER_FORM',
        'Membrii se înregistrează pentru o întreprindere familială (entity.form if la data acordului).',
      );
      const [file] = await tx
        .select({ id: evidence.id })
        .from(evidence)
        .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, input.evidenceId)));
      requireCondition(file, 'EVIDENCE', 'Acordul de constituire nu este disponibil.', 404);
      const ids = input.members.map((member) => member.partyId);
      requireCondition(
        new Set(ids).size === ids.length,
        'ENTERPRISE_MEMBER_DUPLICATE',
        'Un membru apare de mai multe ori în acord.',
      );
      const total = input.members.reduce((sum, member) => sum + quotaBp(member.quota), 0);
      requireCondition(
        total === 10_000 && input.members.every((member) => quotaBp(member.quota) > 0),
        'ENTERPRISE_MEMBER_QUOTA',
        `Cotele membrilor din venitul net se însumează la ${quotaText(total)}%, nu la 100% (art. 29 alin. (1) din OUG nr. 44/2008).`,
      );
      requireCondition(
        input.members.filter((member) => member.representative).length === 1,
        'ENTERPRISE_MEMBER_REPRESENTATIVE',
        'Acordul desemnează un singur reprezentant dintre membri (art. 29 alin. (1)–(2)).',
      );
      const people = await tx
        .select({ id: parties.id, kind: parties.kind, sealed: partyCnps.partyId })
        .from(parties)
        .leftJoin(
          partyCnps,
          and(eq(partyCnps.companyId, parties.companyId), eq(partyCnps.partyId, parties.id)),
        )
        .where(and(eq(parties.companyId, actor.companyId), inArray(parties.id, ids)));
      const missing = input.members.filter((member) => {
        const person = people.find((row) => row.id === member.partyId);
        return person?.kind !== 'ro_individual' || !person.sealed;
      });
      requireCondition(
        !missing.length,
        'ENTERPRISE_MEMBER_CNP',
        'Fiecare membru este un partener persoană fizică cu CNP-ul înregistrat (parties.recordCnp).',
      );
      const last = (await agreements(tx, actor.companyId)).at(-1);
      requireCondition(
        !last ||
          (input.effectiveFrom > last.effectiveFrom &&
            (!last.effectiveTo || input.effectiveFrom > last.effectiveTo)),
        'ENTERPRISE_MEMBER_DATE',
        'Un act adițional se aplică după acordul anterior.',
      );
      const version = (last?.version ?? 0) + 1;
      await tx.insert(enterpriseMembers).values(
        input.members.map((member, index) => ({
          companyId: actor.companyId,
          version,
          position: index + 1,
          partyId: member.partyId,
          quotaBp: quotaBp(member.quota),
          representative: member.representative,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo ?? null,
          evidenceId: input.evidenceId,
          createdBy: actor.actorId,
        })),
      );
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.actorId,
        action: 'if.members.recorded',
        body: { version, members: input.members.length },
      });
      return { version };
    });
  }

  /** The agreements with their members; no CNP is read. */
  list(actor: Actor) {
    return this.commands.read(actor, 'if.members.list', async (tx) => {
      const all = await agreements(tx, actor.companyId);
      const names = new Map(
        (
          await tx
            .select({ id: parties.id, name: parties.name })
            .from(parties)
            .where(eq(parties.companyId, actor.companyId))
        ).map((row) => [row.id, row.name]),
      );
      return all.map((agreement) => ({
        version: agreement.version,
        effectiveFrom: agreement.effectiveFrom,
        effectiveTo: agreement.effectiveTo,
        evidenceId: agreement.evidenceId,
        members: agreement.members.map((member) => ({
          partyId: member.partyId,
          name: names.get(member.partyId) ?? null,
          quota: quotaText(member.quotaBp),
          representative: member.representative,
        })),
      }));
    });
  }
}
