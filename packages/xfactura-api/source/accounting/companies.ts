import { randomUUID, createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { canonical, companySchema, inviteSchema, requireCondition } from './domain';
import { Commands, authorize, commandKey, type Actor } from './commands';
import { companies, memberships, commands, audit, invitations, user } from './schema';
import { sha256 } from './object-store';
import { initializeCompany } from './foundation';

export class Companies {
  constructor(
    private readonly runner: Commands,
    private readonly invitationSecret: string,
  ) {}

  async list(actorId: string) {
    return this.runner.db.orm
      .select({ company: companies })
      .from(companies)
      .innerJoin(memberships, eq(memberships.companyId, companies.id))
      .where(and(eq(memberships.userId, actorId), eq(memberships.active, true)))
      .then((rows) => rows.map((row) => row.company));
  }

  async create(actorId: string, key: string, input: unknown) {
    const body = companySchema.parse(input);
    commandKey(key);
    const hash = sha256(canonical(body));
    return this.runner.db.write(async (tx) => {
      const [previous] = await tx
        .select()
        .from(commands)
        .where(
          and(
            eq(commands.actorId, actorId),
            eq(commands.key, key),
            eq(commands.operation, 'company.create'),
          ),
        );
      if (previous) {
        await authorize(tx, { actorId, companyId: previous.companyId });
        requireCondition(
          previous.hash === hash,
          'IDEMPOTENCY_CONFLICT',
          'Cheia a fost deja folosită pentru alte date.',
          409,
        );
        return previous.result as { id: string; name: string; cui: string; year: number };
      }
      const id = randomUUID();
      await tx.insert(companies).values({ id, ...body, createdBy: actorId });
      await tx.insert(memberships).values({ companyId: id, userId: actorId, role: 'owner' });
      await initializeCompany(tx, { id, year: body.year, createdBy: actorId });
      const result = { id, ...body };
      await tx
        .insert(commands)
        .values({ companyId: id, actorId, key, operation: 'company.create', hash, result });
      await tx
        .insert(audit)
        .values({ companyId: id, actorId, action: 'company.create', body: result });
      return result;
    });
  }

  async invite(actor: Actor, key: string, input: unknown) {
    const body = inviteSchema.parse(input);
    const token = createHmac('sha256', this.invitationSecret)
      .update(canonical({ ...actor, key, purpose: 'invite' }))
      .digest('hex');
    const result = await this.runner.run(
      actor,
      key,
      'company.invite',
      body,
      'manage',
      async (tx) => {
        const id = randomUUID();
        await tx.insert(invitations).values({
          id,
          companyId: actor.companyId,
          ...body,
          email: body.email.toLowerCase(),
          tokenHash: sha256(token),
          expiresAt: Date.now() + 48 * 3600000,
          createdBy: actor.actorId,
        });
        return { id, expiresInHours: 48 };
      },
    );
    return { ...result, token };
  }

  async accept(actorId: string, token: string) {
    requireCondition(/^[a-f0-9]{64}$/.test(token), 'INVITATION', 'Invitație invalidă.');
    return this.runner.db.write(async (tx) => {
      const [person] = await tx
        .select({ email: user.email })
        .from(user)
        .where(eq(user.id, actorId));
      const [invitation] = await tx
        .select()
        .from(invitations)
        .where(eq(invitations.tokenHash, sha256(token)));
      requireCondition(
        person && invitation && person.email.toLowerCase() === invitation.email,
        'INVITATION',
        'Invitația nu este disponibilă pentru acest cont.',
        404,
      );
      if (invitation.acceptedAt) {
        await authorize(tx, { actorId, companyId: invitation.companyId });
        return { id: invitation.companyId };
      }
      requireCondition(
        invitation.expiresAt > Date.now(),
        'INVITATION',
        'Invitația a expirat.',
        404,
      );
      await authorize(
        tx,
        { actorId: invitation.createdBy, companyId: invitation.companyId },
        'manage',
      );
      await tx
        .insert(memberships)
        .values({ companyId: invitation.companyId, userId: actorId, role: invitation.role })
        .onConflictDoUpdate({
          target: [memberships.companyId, memberships.userId],
          set: { role: invitation.role, active: true },
        });
      await tx
        .update(invitations)
        .set({ acceptedAt: Date.now() })
        .where(eq(invitations.id, invitation.id));
      await tx.insert(audit).values({
        companyId: invitation.companyId,
        actorId,
        action: 'company.acceptInvite',
        body: { invitationId: invitation.id },
      });
      return { id: invitation.companyId };
    });
  }

  async revoke(actor: Actor, key: string, userId: string) {
    return this.runner.run(actor, key, 'company.revoke', { userId }, 'manage', async (tx) => {
      const [member] = await tx
        .select()
        .from(memberships)
        .where(and(eq(memberships.companyId, actor.companyId), eq(memberships.userId, userId)));
      requireCondition(member, 'NOT_FOUND', 'Membrul nu este disponibil.', 404);
      requireCondition(
        member.role !== 'owner',
        'OWNER_REQUIRED',
        'Proprietarul nu poate fi revocat prin această acțiune.',
      );
      await tx
        .update(memberships)
        .set({ active: false })
        .where(and(eq(memberships.companyId, actor.companyId), eq(memberships.userId, userId)));
      return { revoked: true };
    });
  }
}
