import { createHmac, randomUUID } from 'node:crypto';
import { and, asc, eq, gt, gte, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { canonical, hashOf } from 'xfactura-core/hash';
import { accountCodePattern } from 'xfactura-core/kernel';
import { chartAmendments, controlKindOf, referenceChart } from 'xfactura-core/ro/chart';
import type { Transaction } from '../db/database';
import {
  commands,
  companies,
  evidence,
  fiscalYears,
  invitations,
  ledgerAccounts,
  memberships,
  parties,
  profileFacts,
  user,
} from '../db/schema';
import { appendAudit, commandKey, type Actor, type Commands } from '../kernel/commands';
import { sha256 } from '../adapters/object-store';

const day = z.iso.date();

export const companyInput = z
  .object({
    name: z.string().trim().min(2).max(200),
    cui: z.string().regex(/^\d{2,10}$/),
    /** The first financial and fiscal year (calendar year). */
    year: z.number().int().min(2020).max(2100),
  })
  .strict();
export const companyView = z.object({ id: z.string(), name: z.string(), cui: z.string() });

export const inviteInput = z
  .object({ email: z.email(), role: z.enum(['reviewer', 'viewer']) })
  .strict();
export const yearInput = z
  .object({
    kind: z.enum(['financial', 'fiscal']),
    label: z.string().trim().min(1).max(100),
    from: day,
    to: day,
  })
  .strict()
  .refine((value) => value.from <= value.to, 'Interval invalid.');
export const accountInput = z
  .object({
    code: z.string().regex(accountCodePattern).includes('.'),
    name: z.string().trim().min(2).max(300),
    validFrom: day,
  })
  .strict();
export const accountQuery = z
  .object({
    prefix: z
      .string()
      .regex(/^[1-9][\dA-Z_.-]{0,40}$/)
      .optional(),
    after: z.string().max(80).optional(),
    limit: z.number().int().min(1).max(1000).default(200),
  })
  .strict();

/** Dated company facts the engine reads, with their allowed values. */
export const profileAxes = {
  'vat.status': ['non_vat', 'normal_vat'],
  'vat.period': ['monthly', 'quarterly'],
  'vat.cash': ['no', 'yes'],
  'vat.eu': ['none', 'special'],
  income_tax: ['micro', 'profit'],
  employer: ['no', 'yes'],
  'books.assurance': ['preview', 'shadow', 'live'],
  'controls.segregation': ['off', 'on'],
  // Accounting policies (OMFP 1802/2014 requires them in writing): dated, with their evidence.
  'policy.storno': ['red', 'black'],
  // Where contributions borne in an employee's name (the part-time minimum) are expensed.
  'policy.payroll.employer_share': ['635', '6458'],
} as const;
export const profileInput = z
  .object({
    axis: z.enum(
      Object.keys(profileAxes) as [keyof typeof profileAxes, ...(keyof typeof profileAxes)[]],
    ),
    value: z.string(),
    effectiveFrom: day,
    evidenceId: z.uuid(),
    supersedesId: z.uuid().optional(),
  })
  .strict()
  .refine((fact) => (profileAxes[fact.axis] as readonly string[]).includes(fact.value), {
    message: 'Valoare nepermisă pentru această axă.',
    path: ['value'],
  });
export const partyInput = z
  .object({
    kind: z.enum([
      'ro_legal_entity',
      'ro_individual_enterprise',
      'ro_individual',
      'ro_public_institution',
      'eu_taxable',
      'non_eu',
    ]),
    country: z.string().regex(/^[A-Z]{2}$/),
    taxId: z.string().trim().min(1).max(40).optional(),
    name: z.string().trim().min(1).max(300),
  })
  .strict();

/** Loads the reference chart with the kernel's control kinds and the first year. */
async function initializeCompany(
  tx: Transaction,
  companyId: string,
  year: number,
  createdBy: string,
) {
  await tx.insert(fiscalYears).values(
    (['financial', 'fiscal'] as const).map((kind) => ({
      id: randomUUID(),
      companyId,
      kind,
      label: String(year),
      from: `${year}-01-01`,
      to: `${year}-12-31`,
      createdBy,
    })),
  );
  const rows = [
    { validFrom: '2015-01-01', chartVersion: referenceChart.id, accounts: referenceChart.accounts },
    ...chartAmendments.map((amendment) => ({
      validFrom: amendment.validFrom,
      chartVersion: amendment.clause,
      accounts: amendment.accounts,
    })),
  ].flatMap(({ validFrom, chartVersion, accounts }) =>
    accounts.map((account) => ({
      companyId,
      code: account.code,
      parentCode: account.parentCode,
      name: account.name,
      nature: account.balance,
      book: account.book,
      postable: account.postable,
      controlKind: account.postable ? controlKindOf(account.code) : null,
      validFrom,
      chartVersion,
      createdBy,
    })),
  );
  for (let index = 0; index < rows.length; index += 50)
    await tx.insert(ledgerAccounts).values(rows.slice(index, index + 50));
}

export class Companies {
  constructor(
    private readonly commands: Commands,
    private readonly secret: string,
  ) {}

  list(actorId: string) {
    return this.commands.db.read((tx) =>
      tx
        .select({ id: companies.id, name: companies.name, cui: companies.cui })
        .from(companies)
        .innerJoin(memberships, eq(memberships.companyId, companies.id))
        .where(and(eq(memberships.userId, actorId), eq(memberships.active, true)))
        .orderBy(asc(companies.name)),
    );
  }

  /** Creates a company owned by the actor. Idempotent per actor and key, before any membership. */
  async create(actorId: string, key: string, input: z.infer<typeof companyInput>) {
    commandKey(key);
    const hash = hashOf({ operation: 'company.create', input });
    return this.commands.db.write(async (tx) => {
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
        requireCondition(
          previous.hash === hash,
          'IDEMPOTENCY_CONFLICT',
          'Cheia a fost deja folosită pentru alte date.',
          409,
        );
        await this.commands.authorize(
          tx,
          { actorId, companyId: previous.companyId },
          'read',
          'company.get',
        );
        return previous.result as z.infer<typeof companyView>;
      }
      const id = randomUUID();
      await tx
        .insert(companies)
        .values({ id, name: input.name, cui: input.cui, createdBy: actorId });
      await tx.insert(memberships).values({ companyId: id, userId: actorId, role: 'owner' });
      await initializeCompany(tx, id, input.year, actorId);
      const result = { id, name: input.name, cui: input.cui };
      await tx
        .insert(commands)
        .values({ companyId: id, actorId, key, operation: 'company.create', hash, result });
      await appendAudit(tx, {
        companyId: id,
        actorId,
        action: 'company.create',
        body: { commandHash: hash, resultHash: hashOf(result) },
      });
      return result;
    });
  }

  async invite(actor: Actor, key: string, input: z.infer<typeof inviteInput>) {
    // Derived from the command, so a retried request recovers the same token without storing it.
    const token = createHmac('sha256', this.secret)
      .update(
        canonical({ purpose: 'invite', actorId: actor.actorId, companyId: actor.companyId, key }),
      )
      .digest('hex');
    const result = await this.commands.run(
      actor,
      key,
      'company.invite',
      input,
      'manage',
      async (tx) => {
        const id = randomUUID();
        await tx.insert(invitations).values({
          id,
          companyId: actor.companyId,
          email: input.email.toLowerCase(),
          role: input.role,
          tokenHash: sha256(token),
          expiresAt: Date.now() + 48 * 3_600_000,
          createdBy: actor.actorId,
        });
        return { id, expiresInHours: 48 };
      },
    );
    return { ...result, token };
  }

  /** Accepts an invitation for the signed-in person. A returning member starts a new epoch. */
  async accept(actorId: string, token: string) {
    requireCondition(/^[a-f0-9]{64}$/.test(token), 'INVITATION', 'Invitație invalidă.');
    return this.commands.db.write(async (tx) => {
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
        await this.commands.authorize(
          tx,
          { actorId, companyId: invitation.companyId },
          'read',
          'company.get',
        );
        return { id: invitation.companyId };
      }
      requireCondition(
        invitation.expiresAt > Date.now(),
        'INVITATION',
        'Invitația a expirat.',
        404,
      );
      await this.commands.authorize(
        tx,
        { actorId: invitation.createdBy, companyId: invitation.companyId },
        'manage',
        'company.invite',
      );
      const member = and(
        eq(memberships.companyId, invitation.companyId),
        eq(memberships.userId, actorId),
      );
      const [existing] = await tx.select().from(memberships).where(member);
      if (!existing)
        await tx
          .insert(memberships)
          .values({ companyId: invitation.companyId, userId: actorId, role: invitation.role });
      else if (!existing.active || existing.role !== invitation.role)
        await tx
          .update(memberships)
          .set({ role: invitation.role, active: true, epoch: sql`${memberships.epoch} + 1` })
          .where(member);
      await tx
        .update(invitations)
        .set({ acceptedAt: Date.now() })
        .where(eq(invitations.id, invitation.id));
      await appendAudit(tx, {
        companyId: invitation.companyId,
        actorId,
        action: 'company.acceptInvitation',
        body: { invitationId: invitation.id, role: invitation.role },
      });
      return { id: invitation.companyId };
    });
  }

  async revokeMember(actor: Actor, key: string, input: { userId: string }) {
    return this.commands.run(actor, key, 'company.revoke', input, 'manage', async (tx) => {
      const member = and(
        eq(memberships.companyId, actor.companyId),
        eq(memberships.userId, input.userId),
      );
      const [existing] = await tx.select().from(memberships).where(member);
      requireCondition(existing, 'NOT_FOUND', 'Membrul nu este disponibil.', 404);
      requireCondition(
        existing.role !== 'owner',
        'OWNER_REQUIRED',
        'Proprietarul nu poate fi revocat prin această acțiune.',
      );
      if (existing.active)
        await tx
          .update(memberships)
          .set({ active: false, epoch: sql`${memberships.epoch} + 1` })
          .where(member);
      return { userId: input.userId, revoked: true as const };
    });
  }

  members(actor: Actor) {
    return this.commands.read(actor, 'company.members', (tx) =>
      tx
        .select({
          userId: memberships.userId,
          name: user.name,
          email: user.email,
          role: memberships.role,
          active: memberships.active,
        })
        .from(memberships)
        .innerJoin(user, eq(user.id, memberships.userId))
        .where(eq(memberships.companyId, actor.companyId))
        .orderBy(asc(user.email)),
    );
  }
}

export class Configuration {
  constructor(private readonly commands: Commands) {}

  years(actor: Actor) {
    return this.commands.read(actor, 'years.list', (tx) =>
      tx
        .select({
          id: fiscalYears.id,
          kind: fiscalYears.kind,
          label: fiscalYears.label,
          from: fiscalYears.from,
          to: fiscalYears.to,
        })
        .from(fiscalYears)
        .where(eq(fiscalYears.companyId, actor.companyId))
        .orderBy(asc(fiscalYears.from), asc(fiscalYears.kind)),
    );
  }

  createYear(actor: Actor, key: string, input: z.infer<typeof yearInput>) {
    return this.commands.run(actor, key, 'years.create', input, 'manage', async (tx) => {
      const id = randomUUID();
      await tx
        .insert(fiscalYears)
        .values({ id, companyId: actor.companyId, ...input, createdBy: actor.actorId });
      return { id, ...input };
    });
  }

  accounts(actor: Actor, input: z.infer<typeof accountQuery>) {
    return this.commands.read(actor, 'accounts.list', async (tx) => {
      const rows = await tx
        .select({
          code: ledgerAccounts.code,
          parentCode: ledgerAccounts.parentCode,
          name: ledgerAccounts.name,
          nature: ledgerAccounts.nature,
          postable: ledgerAccounts.postable,
          controlKind: ledgerAccounts.controlKind,
          validFrom: ledgerAccounts.validFrom,
          validTo: ledgerAccounts.validTo,
        })
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.companyId, actor.companyId),
            input.prefix
              ? and(
                  gte(ledgerAccounts.code, input.prefix),
                  lte(ledgerAccounts.code, `${input.prefix}￿`),
                )
              : undefined,
            input.after ? gt(ledgerAccounts.code, input.after) : undefined,
          ),
        )
        .orderBy(asc(ledgerAccounts.code))
        .limit(input.limit + 1);
      return {
        items: rows.slice(0, input.limit),
        next: rows.length > input.limit ? rows[input.limit - 1]!.code : null,
      };
    });
  }

  /** Adds an analytical account under a postable synthetic, inheriting its control. */
  createAccount(actor: Actor, key: string, input: z.infer<typeof accountInput>) {
    return this.commands.run(actor, key, 'accounts.create', input, 'manage', async (tx) => {
      const parentCode = input.code.slice(0, input.code.lastIndexOf('.'));
      const [parent] = await tx
        .select()
        .from(ledgerAccounts)
        .where(
          and(eq(ledgerAccounts.companyId, actor.companyId), eq(ledgerAccounts.code, parentCode)),
        );
      requireCondition(
        parent?.postable && parent.book === 'general',
        'ACCOUNT_PARENT',
        'Contul analitic se creează sub un cont sintetic utilizabil.',
      );
      await tx.insert(ledgerAccounts).values({
        companyId: actor.companyId,
        code: input.code,
        parentCode,
        name: input.name,
        nature: parent.nature,
        book: parent.book,
        postable: true,
        controlKind: parent.controlKind,
        validFrom: input.validFrom,
        chartVersion: 'company',
        createdBy: actor.actorId,
      });
      return { code: input.code, parentCode, name: input.name, controlKind: parent.controlKind };
    });
  }

  profile(actor: Actor) {
    return this.commands.read(actor, 'profile.read', (tx) =>
      tx
        .select({
          id: profileFacts.id,
          axis: profileFacts.axis,
          value: profileFacts.value,
          effectiveFrom: profileFacts.effectiveFrom,
          evidenceId: profileFacts.evidenceId,
          supersedesId: profileFacts.supersedesId,
          createdBy: profileFacts.createdBy,
          createdAt: profileFacts.createdAt,
        })
        .from(profileFacts)
        .where(eq(profileFacts.companyId, actor.companyId))
        .orderBy(
          asc(profileFacts.axis),
          asc(profileFacts.effectiveFrom),
          asc(profileFacts.createdAt),
        ),
    );
  }

  recordProfile(actor: Actor, key: string, input: z.infer<typeof profileInput>) {
    return this.commands.run(actor, key, 'profile.record', input, 'review', async (tx) => {
      const [source] = await tx
        .select({ id: evidence.id })
        .from(evidence)
        .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, input.evidenceId)));
      requireCondition(source, 'EVIDENCE', 'Documentul justificativ nu este disponibil.', 404);
      if (input.supersedesId) {
        const [superseded] = await tx
          .select()
          .from(profileFacts)
          .where(
            and(
              eq(profileFacts.companyId, actor.companyId),
              eq(profileFacts.id, input.supersedesId),
            ),
          );
        requireCondition(
          superseded?.axis === input.axis,
          'SUPERSEDES',
          'Faptul înlocuit aparține altei axe.',
        );
      }
      const id = randomUUID();
      await tx
        .insert(profileFacts)
        .values({ id, companyId: actor.companyId, ...input, createdBy: actor.actorId });
      return { id, ...input };
    });
  }

  parties(actor: Actor) {
    return this.commands.read(actor, 'parties.list', (tx) =>
      tx
        .select({
          id: parties.id,
          kind: parties.kind,
          country: parties.country,
          taxId: parties.taxId,
          name: parties.name,
        })
        .from(parties)
        .where(eq(parties.companyId, actor.companyId))
        .orderBy(asc(parties.name), asc(parties.id)),
    );
  }

  createParty(actor: Actor, key: string, input: z.infer<typeof partyInput>) {
    return this.commands.run(actor, key, 'parties.create', input, 'write', async (tx) => {
      const taxId = input.taxId?.replace(/^RO/i, '').replace(/\s+/g, '') ?? null;
      const id = randomUUID();
      await tx
        .insert(parties)
        .values({ id, companyId: actor.companyId, ...input, taxId, createdBy: actor.actorId });
      return { id, kind: input.kind, country: input.country, taxId, name: input.name };
    });
  }
}
