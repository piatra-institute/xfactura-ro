import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, max, sql } from 'drizzle-orm';
import { canonical, derivedId, hashOf } from 'xfactura-core/hash';
import type { Effect, LineSpec, OpenItemSpec, TaxEntrySpec } from 'xfactura-core/kernel';
import { parseLocalDate } from 'xfactura-core/time';
import { Database } from '../../source/engine/db/database';
import {
  actionDecisions,
  actionRequests,
  approvals,
  companies,
  entries,
  fiscalYears,
  ledgerAccounts,
  memberships,
  parties,
  periodEvents,
  proposals,
  proposalVersions,
  user,
} from '../../source/engine/db/schema';
import { writeEntry } from '../../source/engine/kernel/ledger';

// A minimal chart covering every control kind the invariants distinguish.
const chart: [code: string, controlKind: string | null, postable?: boolean][] = [
  ['70', null, false],
  ['704', null],
  ['628', null],
  ['5121', null],
  ['5124', null],
  ['665', null],
  ['765', null],
  ['4111', 'receivable'],
  ['401', 'payable'],
  ['471', 'deferral.expense'],
  ['4426', 'tax'],
  ['4427', 'tax'],
  ['4423', 'tax'],
];

export type World = Awaited<ReturnType<typeof createWorld>>;

export async function createWorld() {
  const directory = await mkdtemp(join(tmpdir(), 'xfactura-engine-'));
  const db = new Database(`file:${directory}/books.db`);
  await db.migrate();
  const [owner, reviewer, viewer] = [randomUUID(), randomUUID(), randomUUID()];
  const company = randomUUID();
  const year = randomUUID();
  const client = randomUUID();
  const supplier = randomUUID();
  await db.write(async (tx) => {
    const now = new Date();
    await tx.insert(user).values(
      [owner, reviewer, viewer].map((id) => ({
        id,
        name: id.slice(0, 8),
        email: `${id}@example.test`,
        createdAt: now,
        updatedAt: now,
      })),
    );
    await tx
      .insert(companies)
      .values({ id: company, name: 'Test SRL', cui: '12345678', createdBy: owner });
    await tx.insert(memberships).values([
      { companyId: company, userId: owner, role: 'owner' },
      { companyId: company, userId: reviewer, role: 'reviewer' },
      { companyId: company, userId: viewer, role: 'viewer' },
    ]);
    await tx.insert(fiscalYears).values({
      id: year,
      companyId: company,
      kind: 'financial',
      label: '2026',
      from: '2026-01-01',
      to: '2026-12-31',
      createdBy: owner,
    });
    await tx.insert(ledgerAccounts).values(
      chart.map(([code, controlKind, postable = true]) => ({
        companyId: company,
        code,
        name: code,
        nature: 'both' as const,
        book: 'general' as const,
        postable,
        controlKind,
        validFrom: '2015-01-01',
        chartVersion: 'test',
        createdBy: owner,
      })),
    );
    await tx.insert(parties).values([
      {
        id: client,
        companyId: company,
        kind: 'ro_legal_entity',
        country: 'RO',
        taxId: '1',
        name: 'Client',
        createdBy: owner,
      },
      {
        id: supplier,
        companyId: company,
        kind: 'ro_legal_entity',
        country: 'RO',
        taxId: '2',
        name: 'Furnizor',
        createdBy: owner,
      },
    ]);
  });
  return {
    db,
    owner,
    reviewer,
    viewer,
    company,
    year,
    client,
    supplier,
    async close() {
      await db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export const day = (text = '2026-03-10') => parseLocalDate(text);

export function effect(lines: LineSpec[], extra: Partial<Effect> = {}): Effect {
  return {
    schema: 'effect@1',
    date: day(),
    journalClass: 'general',
    journalCode: 'VANZARI',
    description: 'Factura test',
    lines,
    openItems: [],
    taxEntries: [],
    schedules: [],
    explanation: { summary: 'test' },
    ...extra,
  };
}

export function outputVat(
  line: number,
  bani: bigint,
  extra: Partial<TaxEntrySpec> = {},
): TaxEntrySpec {
  return {
    key: `vat-${line}`,
    tax: 'VAT',
    code: 'S-21',
    direction: 'output',
    baseBani: (bani * 100n) / 21n,
    taxBani: bani,
    deductibleBani: 0n,
    taxPoint: day(),
    exigibility: day(),
    taxPeriod: '2026-03',
    line,
    ledgerBani: bani,
    attributes: { scenario: 'domestic' },
    ...extra,
  };
}

export function receivable(
  world: World,
  ref = derivedId('receivable', randomUUID()),
): OpenItemSpec {
  return {
    ref,
    kind: 'receivable',
    controlAccount: '4111',
    partyId: world.client,
    currency: 'RON',
    normalSide: 'D',
    mayReverse: false,
  };
}

/** A domestic sale of 1,000.00 + 21% VAT that creates a receivable. */
export function sale(world: World, item = receivable(world), date = day()): Effect {
  return effect(
    [
      { account: '4111', side: 'D', bani: 121000n, openItem: item.ref, partyId: world.client },
      { account: '704', side: 'C', bani: 100000n },
      { account: '4427', side: 'C', bani: 21000n },
    ],
    {
      date,
      openItems: [item],
      taxEntries: [outputVat(2, 21000n, { taxPoint: date, exigibility: date })],
    },
  );
}

export type Proposed = { proposalId: string; version: number; effectHash: string; effect: Effect };

export async function propose(
  world: World,
  value: Effect,
  options: {
    proposalId?: string;
    subjectKey?: string;
    version?: number;
    blocking?: boolean;
    readSet?: { kind: string; id: string; version: string }[];
    rulesHash?: string;
    effectJson?: string;
    issues?: { code: string; severity: 'block' | 'ack' | 'info'; message: string }[];
    /** Whom the version is created in the name of (the owner), and through which agent grant. */
    createdBy?: string;
    agentId?: string;
  } = {},
): Promise<Proposed> {
  const proposalId = options.proposalId ?? randomUUID();
  const version = options.version ?? 1;
  const effectJson = options.effectJson ?? canonical(value);
  const readSet = canonical(options.readSet ?? []);
  const effectHash = hashOf({ effectJson, readSet, version });
  await world.db.write(async (tx) => {
    if (!options.proposalId)
      await tx.insert(proposals).values({
        id: proposalId,
        companyId: world.company,
        treatmentId: 'test.treatment',
        subjectKey: options.subjectKey ?? proposalId,
        createdBy: world.owner,
      });
    await tx.insert(proposalVersions).values({
      companyId: world.company,
      proposalId,
      version,
      treatmentVersion: 1,
      input: '{}',
      readSet,
      rules: '{}',
      rulesHash: options.rulesHash ?? 'rules-1',
      effect: effectJson,
      issues: canonical(options.issues ?? []),
      blocking: options.blocking ?? false,
      effectHash,
      entryDate: value.date,
      createdBy: options.createdBy ?? world.owner,
      agentId: options.agentId ?? null,
    });
  });
  return { proposalId, version, effectHash, effect: value };
}

export async function epoch(world: World, userId: string) {
  const [row] = await world.db.orm
    .select({ epoch: memberships.epoch })
    .from(memberships)
    .where(and(eq(memberships.companyId, world.company), eq(memberships.userId, userId)));
  return row!.epoch;
}

export async function approve(
  world: World,
  proposed: Proposed,
  approver = world.reviewer,
  hash?: string,
) {
  const id = randomUUID();
  const approverEpoch = await epoch(world, approver);
  await world.db.write((tx) =>
    tx.insert(approvals).values({
      id,
      companyId: world.company,
      proposalId: proposed.proposalId,
      version: proposed.version,
      effectHash: hash ?? proposed.effectHash,
      approverId: approver,
      approverEpoch,
      acknowledgements: '[]',
    }),
  );
  return id;
}

export function post(
  world: World,
  proposed: Proposed,
  binding: { approvalId?: string; policyId?: string },
  rows: Effect = proposed.effect,
) {
  return world.db.write((tx) =>
    writeEntry(
      tx,
      {
        companyId: world.company,
        id: randomUUID(),
        fiscalYearId: world.year,
        proposalId: proposed.proposalId,
        version: proposed.version,
        ...binding,
        postedBy: world.owner,
        engineAt: Date.now(),
      },
      rows,
    ),
  );
}

/** Proposes, approves and posts an effect. */
export async function book(
  world: World,
  value: Effect,
  options: Parameters<typeof propose>[2] = {},
) {
  const proposed = await propose(world, value, options);
  const approvalId = await approve(world, proposed);
  return { ...proposed, entry: await post(world, proposed, { approvalId }) };
}

/** Records an approved action review, the precondition for period events. */
export async function approvedAction(world: World, operation = 'periods.close') {
  const id = randomUUID();
  const decidedEpoch = await epoch(world, world.reviewer);
  await world.db.write(async (tx) => {
    await tx.insert(actionRequests).values({
      id,
      companyId: world.company,
      operation,
      input: '{}',
      preview: '{}',
      previewHash: 'preview',
      createdBy: world.owner,
    });
    await tx.insert(actionDecisions).values({
      companyId: world.company,
      requestId: id,
      decision: 'approve',
      previewHash: 'preview',
      decidedBy: world.reviewer,
      decidedEpoch,
    });
  });
  return id;
}

export async function periodEvent(
  world: World,
  month: string,
  kind: 'close' | 'reopen' = 'close',
  overrides: Partial<typeof periodEvents.$inferInsert> = {},
) {
  const actionId = overrides.actionId ?? (await approvedAction(world));
  return world.db.write(async (tx) => {
    const [last] = await tx
      .select({ seq: max(periodEvents.seq) })
      .from(periodEvents)
      .where(and(eq(periodEvents.companyId, world.company), eq(periodEvents.month, month)));
    const [watermark] = await tx
      .select({ seq: max(entries.seq) })
      .from(entries)
      .where(eq(entries.companyId, world.company));
    const [previous] = await tx
      .select({ hash: periodEvents.hash })
      .from(periodEvents)
      .where(eq(periodEvents.companyId, world.company))
      .orderBy(sql`rowid desc`)
      .limit(1);
    await tx.insert(periodEvents).values({
      companyId: world.company,
      month,
      seq: (last?.seq ?? 0) + 1,
      kind,
      actionId,
      watermarkSeq: watermark?.seq ?? 0,
      snapshotHash: 'snapshot',
      prevHash: previous?.hash ?? '',
      hash: randomUUID(),
      createdBy: world.owner,
      ...overrides,
    });
  });
}

/** The `inv:<code>` an operation was refused with, if any. */
export function invariantCode(error: unknown): string | undefined {
  let cause = error;
  for (let depth = 0; cause && depth < 8; depth++) {
    const match = /inv:([a-z_]+)/.exec(String((cause as Error).message ?? cause));
    if (match) return match[1];
    cause = (cause as { cause?: unknown }).cause;
  }
  return undefined;
}

export async function refusal(operation: Promise<unknown>) {
  try {
    await operation;
    return undefined;
  } catch (error) {
    return invariantCode(error) ?? `unexpected: ${String((error as Error).message ?? error)}`;
  }
}
