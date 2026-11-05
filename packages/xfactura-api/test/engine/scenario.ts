import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromJsonSchema, type JsonSchemaType } from '@modelcontextprotocol/server';
import type { WireError } from '../../source/engine/kernel/errors';
import { wireError } from '../../source/engine/kernel/errors';
import type { ProposalView } from '../../source/engine/kernel/views';
import type { ActionView } from '../../source/engine/kernel/actions';
import type { Actor } from '../../source/engine/kernel/commands';
import { Database } from '../../source/engine/db/database';
import { user } from '../../source/engine/db/schema';
import { LocalObjectStore } from '../../source/engine/adapters/object-store';
import { Engine } from '../../source/engine/engine';
import { outputSchema } from '../../source/engine/kernel/operations';
import type { EFacturaPort } from '../../source/engine/adapters/efactura';
import type { TaxpayerRegistryPort } from '../../source/engine/adapters/anaf-taxpayers';
import type { ViesPort } from '../../source/engine/adapters/vies';
import type { DeclarationValidator } from '../../source/engine/adapters/declaration-validator';
import type { DeclarationKind } from '../../source/engine/modules/declarations';
import type { Treatment } from 'xfactura-core/kernel';
import type { ParameterRegister } from 'xfactura-core/rules';

export const secret = 'synthetic-engine-secret-at-least-32-characters';

const validators = new Map<string, ReturnType<typeof fromJsonSchema>>();
/**
 * Fails when an operation returns what its advertised output schema refuses, validated as the
 * MCP server and its clients validate it: the JSON the caller receives, against the JSON Schema.
 */
export async function checkContract(engine: Engine, operation: string, output: unknown) {
  let validator = validators.get(operation);
  if (!validator) {
    validator = fromJsonSchema(outputSchema(engine.operations.get(operation)) as JsonSchemaType);
    validators.set(operation, validator);
  }
  const result = await validator['~standard'].validate(JSON.parse(JSON.stringify(output)));
  if (result.issues)
    throw new Error(
      `${operation} returned what its output schema refuses: ${result.issues.map((issue) => issue.message).join('; ')}`,
    );
}

/** A company on a fresh engine, with an owner, a reviewer and a viewer. */
export async function scenario(
  options: {
    year?: number;
    /** The company's name; Pilot SRL unless a test needs another. */
    name?: string;
    /** The company's CUI; 12345678 unless a test needs a valid checksum. */
    cui?: string;
    efactura?: EFacturaPort;
    taxpayers?: TaxpayerRegistryPort;
    /** VIES on-the-Web, a fake in tests. */
    vies?: ViesPort;
    /** The engine's time; the wall's by default. */
    clock?: () => number;
    /** The engine's identifiers, and its people's; random by default. */
    ids?: () => string;
    declarations?: DeclarationKind[];
    declarationValidator?: DeclarationValidator;
    /** A rule register other than the engine's, for a year the engine's does not cover yet. */
    register?: ParameterRegister;
    /** Treatments beyond the engine's, for kernel behaviour no real treatment exercises. */
    treatments?: Treatment[];
    /** How the new database gets its schema: every migration, unless a test of a migration starts
     * the books from an earlier one. */
    migrate?: (db: Database) => Promise<void>;
    anaf?: ConstructorParameters<typeof Engine>[3] extends infer O
      ? O extends { anaf?: infer A }
        ? A
        : never
      : never;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'xfactura-scenario-'));
  const db = new Database(`file:${directory}/books.db`);
  await (options.migrate ? options.migrate(db) : db.migrate());
  const objects = new LocalObjectStore(join(directory, 'objects'));
  const engine = new Engine(db, objects, secret, {
    ...(options.efactura ? { efactura: options.efactura } : {}),
    ...(options.taxpayers ? { taxpayers: options.taxpayers } : {}),
    ...(options.vies ? { vies: options.vies } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.ids ? { ids: options.ids } : {}),
    ...(options.declarations ? { declarations: options.declarations } : {}),
    ...(options.declarationValidator ? { declarationValidator: options.declarationValidator } : {}),
    ...(options.anaf ? { anaf: options.anaf } : {}),
    ...(options.register ? { register: options.register } : {}),
    ...(options.treatments ? { treatments: options.treatments } : {}),
  });
  const people = async (...names: string[]) => {
    const ids = names.map(() => (options.ids ?? randomUUID)());
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
    name: options.name ?? 'Pilot SRL',
    cui: options.cui ?? '12345678',
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

  /** Invokes an operation as REST and MCP do, and holds its output to the advertised schema. */
  const invoke = async <T = unknown>(
    actor: Actor,
    operation: string,
    input: unknown = {},
    key: string = randomUUID(),
  ) => {
    const output = await engine.invoke(actor, operation, key, input);
    await checkContract(engine, operation, output);
    return output as T;
  };
  /** The wire error an invocation fails with, or undefined if it succeeds. */
  const refused = async (operation: Promise<unknown>): Promise<WireError['error'] | undefined> => {
    try {
      await operation;
      return undefined;
    } catch (error) {
      return wireError(error).error;
    }
  };
  const years = await invoke<{ items: { id: string; kind: string; from: string }[] }>(
    owner,
    'years.list',
  );
  const year = years.items.find((item) => item.kind === 'financial')!;

  const s = {
    engine,
    /** The engine's time, which grants, invitations and policies expire on. */
    now: options.clock ?? Date.now,
    /** An expiry `days` after the engine's time, for grants and policies. */
    expiresIn: (days: number) =>
      new Date((options.clock ?? Date.now)() + days * 86_400_000).toISOString(),
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
    /** The items of a list operation's `{ items, next }`, for lists a test reads whole. */
    list: async <T = unknown>(actor: Actor, operation: string, input: unknown = {}) =>
      (await invoke<{ items: T[]; next: string | null }>(actor, operation, input)).items,
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
