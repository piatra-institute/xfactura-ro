import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WireError } from '../../source/engine/kernel/errors';
import { wireError } from '../../source/engine/kernel/errors';
import type { ProposalView } from '../../source/engine/kernel/views';
import type { ActionView } from '../../source/engine/kernel/actions';
import type { Actor } from '../../source/engine/kernel/commands';
import { Database } from '../../source/engine/db/database';
import { user } from '../../source/engine/db/schema';
import { LocalObjectStore } from '../../source/engine/adapters/object-store';
import { Engine } from '../../source/engine/engine';
import type { EFacturaPort } from '../../source/engine/adapters/efactura';

export const secret = 'synthetic-engine-secret-at-least-32-characters';

/** A company on a fresh engine, with an owner, a reviewer and a viewer. */
export async function scenario(
  options: { year?: number; efactura?: EFacturaPort; clock?: () => number } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'xfactura-scenario-'));
  const db = new Database(`file:${directory}/books.db`);
  await db.migrate();
  const objects = new LocalObjectStore(join(directory, 'objects'));
  const engine = new Engine(db, objects, secret, {
    ...(options.efactura ? { efactura: options.efactura } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const people = async (...names: string[]) => {
    const ids = names.map(() => randomUUID());
    const now = new Date();
    await db.write((tx) =>
      tx.insert(user).values(
        ids.map((id, index) => ({
          id,
          name: names[index]!,
          email: `${names[index]}-${id.slice(0, 8)}@example.test`,
          createdAt: now,
          updatedAt: now,
        })),
      ),
    );
    return ids;
  };
  const [ownerId, reviewerId, viewerId] = await people('owner', 'reviewer', 'viewer');
  const company = await engine.companies.create(ownerId!, randomUUID(), {
    name: 'Pilot SRL',
    cui: '12345678',
    year: options.year ?? 2026,
  });
  const owner: Actor = { actorId: ownerId!, companyId: company.id };
  const join_ = async (person: string, role: 'reviewer' | 'viewer') => {
    const [row] = await db.authOrm
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, person));
    const invitation = await engine.companies.invite(owner, randomUUID(), {
      email: row!.email,
      role,
    });
    await engine.companies.accept(person, invitation.token);
  };
  await join_(reviewerId!, 'reviewer');
  await join_(viewerId!, 'viewer');
  const reviewer: Actor = { actorId: reviewerId!, companyId: company.id };
  const viewer: Actor = { actorId: viewerId!, companyId: company.id };

  const invoke = <T = unknown>(
    actor: Actor,
    operation: string,
    input: unknown = {},
    key: string = randomUUID(),
  ) => engine.invoke(actor, operation, key, input) as Promise<T>;
  /** The wire error an invocation fails with, or undefined if it succeeds. */
  const refused = async (operation: Promise<unknown>): Promise<WireError['error'] | undefined> => {
    try {
      await operation;
      return undefined;
    } catch (error) {
      return wireError(error).error;
    }
  };
  const years = await invoke<{ id: string; kind: string; from: string }[]>(owner, 'years.list');
  const year = years.find((item) => item.kind === 'financial')!;

  const s = {
    engine,
    db,
    objects,
    directory,
    company,
    owner,
    reviewer,
    viewer,
    year,
    people,
    join: join_,
    invoke,
    refused,
    async evidence(filename = 'nota.pdf', content: string = randomUUID()) {
      return invoke<{ id: string }>(owner, 'evidence.record', {
        filename,
        mediaType: 'application/pdf',
        base64: Buffer.from(content).toString('base64'),
      });
    },
    async party(name = 'Client SRL', taxId: string = String(Math.floor(Math.random() * 1e8))) {
      return invoke<{ id: string }>(owner, 'parties.create', {
        kind: 'ro_legal_entity',
        country: 'RO',
        taxId,
        name,
      });
    },
    propose: (treatment: string, input: unknown, actor: Actor = owner) =>
      invoke<ProposalView>(actor, `${treatment}.propose`, input),
    revise: (treatment: string, proposal: ProposalView, input: unknown, actor: Actor = owner) =>
      invoke<ProposalView>(actor, `${treatment}.revise`, {
        proposalId: proposal.id,
        version: proposal.version,
        input,
      }),
    approve: (proposal: ProposalView, actor: Actor = reviewer, acknowledge: string[] = []) =>
      invoke<ProposalView>(actor, 'proposals.approve', {
        proposalId: proposal.id,
        version: proposal.version,
        effectHash: proposal.effectHash,
        acknowledge,
      }),
    post: (proposal: ProposalView, actor: Actor = reviewer) =>
      invoke<ProposalView>(actor, 'ledger.post', {
        proposalId: proposal.id,
        version: proposal.version,
        effectHash: proposal.effectHash,
      }),
    /** Proposes, approves and posts; returns the posted proposal. */
    async book(treatment: string, input: unknown) {
      const proposal = await s.propose(treatment, input);
      if (proposal.status === 'posted') return proposal;
      return s.post(await s.approve(proposal));
    },
    trialBalance: (from?: string, to?: string) =>
      invoke<{
        rows: {
          account: string;
          opening: { debit: string; credit: string };
          current: { debit: string; credit: string };
          closing: { debit: string; credit: string };
        }[];
        totals: Record<string, { debit: string; credit: string }>;
      }>(owner, 'ledger.trialBalance', {
        financialYearId: year.id,
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      }),
    async close(month: string, actor: Actor = owner) {
      const request = await invoke<ActionView>(actor, 'periods.close.request', { month });
      return request;
    },
    async closeApproved(month: string) {
      const request = await s.close(month);
      await invoke(reviewer, 'actions.approve', {
        id: request.id,
        previewHash: request.previewHash,
      });
      return invoke<ActionView>(reviewer, 'actions.execute', { id: request.id });
    },
    async dispose() {
      await db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
  return s;
}
export type Scenario = Awaited<ReturnType<typeof scenario>>;

/** A general-journal input with sensible defaults. */
export function journal(
  evidenceId: string,
  lines: { account: string; side: 'D' | 'C'; amount: string; [key: string]: unknown }[],
  extra: Record<string, unknown> = {},
) {
  return {
    date: '2026-03-10',
    purpose: 'general',
    reference: `NC-${randomUUID().slice(0, 8)}`,
    description: 'Notă contabilă',
    evidenceId,
    lines,
    ...extra,
  };
}
