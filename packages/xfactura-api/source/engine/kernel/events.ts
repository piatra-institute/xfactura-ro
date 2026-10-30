import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import type { DataClass } from 'xfactura-core/kernel';
import type { Transaction } from '../db/database';
import { audit } from '../db/schema';
import type { Actor, Commands } from './commands';
import type { OperationRegistry } from './operations';
import { SYSTEM_PRINCIPAL } from './principals';

/*
 * The change feed. Every command appends one row to the company's hash-chained audit log, with
 * the references its result names (`refs`); consequences recorded inside a command (a posting
 * policy applied, a declaration's step, …) append rows of their own. `events.since` reads the log
 * in order, so agents and the engine's worker learn what changed without rereading every list.
 */

/** What a reference names. */
export const refKinds = [
  'proposal',
  'entry',
  'document',
  'movement',
  'statement',
  'treasuryAccount',
  'evidence',
  'action',
  'declaration',
  'submission',
  'policy',
  'party',
  'asset',
  'employee',
  'contract',
  'payrollRun',
  'incomeSource',
  'series',
  'year',
  'account',
  'profileFact',
  'grant',
  'invitation',
  'member',
  'job',
  'question',
  'disposition',
  'template',
] as const;
export type RefKind = (typeof refKinds)[number];
export type Ref = { kind: RefKind; id: string };

/** Fields that name a record, wherever a result or an event body carries them. */
const fields: [field: string, kind: RefKind][] = [
  ['proposalId', 'proposal'],
  ['entryId', 'entry'],
  ['documentId', 'document'],
  ['movementId', 'movement'],
  ['statementId', 'statement'],
  ['treasuryAccountId', 'treasuryAccount'],
  ['evidenceId', 'evidence'],
  ['actionId', 'action'],
  ['requestId', 'action'],
  ['artifactId', 'declaration'],
  ['submissionId', 'submission'],
  ['policyId', 'policy'],
  ['partyId', 'party'],
  ['assetId', 'asset'],
  ['employeeId', 'employee'],
  ['contractId', 'contract'],
  ['runId', 'payrollRun'],
  ['invitationId', 'invitation'],
  ['userId', 'member'],
  ['questionId', 'question'],
  ['profileFactId', 'profileFact'],
  ['templateId', 'template'],
];

/** What the `id` of an operation's result names, where its form does not tell. */
const resultIds: Partial<Record<string, RefKind>> = {
  'proposals.approve': 'proposal',
  'proposals.withdraw': 'proposal',
  'ledger.post': 'proposal',
  'invoices.import': 'document',
  'documents.record': 'document',
  'documents.supersede': 'document',
  'evidence.record': 'evidence',
  'declarations.prepare': 'declaration',
  'declarations.validate': 'declaration',
  'declarations.pdf': 'declaration',
  'assets.register': 'asset',
  'payroll.employees.record': 'employee',
  'payroll.runs.prepare': 'payrollRun',
  'spv.submit': 'submission',
  'spv.refresh': 'submission',
  'sales.series.create': 'series',
  'treasury.createAccount': 'treasuryAccount',
  'exports.request': 'job',
  'parties.create': 'party',
  'policies.create': 'policy',
  'policies.revoke': 'policy',
  'agents.issue': 'grant',
  'agents.revoke': 'grant',
  'company.invite': 'invitation',
  'years.create': 'year',
  'profile.record': 'profileFact',
  'questions.ask': 'question',
  'questions.answer': 'question',
  'questions.withdraw': 'question',
  'work.dispose': 'disposition',
};

/** What the `id` of an operation's result names: a treatment's `.propose` and `.revise` return
 * proposals, reviewed actions' requests and decisions return actions. */
export function resultKind(operation: string): RefKind | undefined {
  const named = resultIds[operation];
  if (named) return named;
  if (operation.endsWith('.propose') || operation.endsWith('.revise')) return 'proposal';
  if (operation.endsWith('.request') || operation.startsWith('actions.')) return 'action';
  return undefined;
}

/** Proposal subjects that name a record. */
const subjects: [prefix: string, kind: RefKind][] = [
  ['document:', 'document'],
  ['movement:', 'movement'],
  ['reverse:', 'entry'],
  ['asset-disposal:', 'asset'],
  ['lease:', 'asset'],
];

/** Parts of a result that carry references of their own. */
const nested = ['recognition', 'statements', 'outcomes', 'results', 'answer'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The records an operation's result (or a consequence's body) names, in a stable order and
 * without duplicates: the result's own `id`, the fields naming records, a proposal's subject and
 * posted entry, and the records of a bulk result's items. Only identifiers, never content: a
 * result's token or amounts never enter the audit log through here.
 */
export function refsOf(operation: string, value: unknown): Ref[] {
  if (!isRecord(value)) return [];
  const refs = new Map<string, Ref>();
  const add = (kind: RefKind, id: unknown) => {
    if (typeof id === 'string' && id.length > 0 && id.length <= 200)
      refs.set(`${kind}/${id}`, { kind, id });
  };
  const named = (record: Record<string, unknown>) => {
    for (const [field, kind] of fields) add(kind, record[field]);
  };
  const own = resultKind(operation);
  if (own) add(own, value.id);
  if (operation === 'accounts.create') add('account', value.code);
  if (operation.startsWith('pfa.sources.')) add('incomeSource', value.sourceId);
  named(value);
  // A pause or resume names its policy or template.
  if (
    operation.startsWith('automation.') &&
    (value.scope === 'policy' || value.scope === 'template')
  )
    add(value.scope, value.scopeId);
  // An executed action's result: a batch's postings, the template or policy it created.
  if (own === 'action' && isRecord(value.result)) {
    named(value.result);
    for (const item of Array.isArray(value.result.posted) ? value.result.posted : [])
      if (isRecord(item)) named(item);
  }
  if (own === 'proposal') {
    if (typeof value.subject === 'string')
      for (const [prefix, kind] of subjects)
        if (value.subject.startsWith(prefix)) add(kind, value.subject.slice(prefix.length));
    if (isRecord(value.entry)) {
      add('entry', value.entry.id);
      add('policy', value.entry.policyId);
    }
  }
  for (const key of nested) {
    const inner = value[key];
    for (const item of Array.isArray(inner) ? inner : [inner]) if (isRecord(item)) named(item);
  }
  return [...refs.values()];
}

/** References kept on one audit row; how many were left out is recorded beside them. */
export const refLimit = 1000;
export function auditRefs(refs: Ref[]): { refs: Ref[]; refsOmitted?: number } {
  return refs.length > refLimit
    ? { refs: refs.slice(0, refLimit), refsOmitted: refs.length - refLimit }
    : { refs };
}

/** Audit rows that are not operations: consequences recorded inside a command. */
const consequences: [action: RegExp, classes: readonly DataClass[]][] = [
  [/^policies\.applied$/, ['books']],
  [/^policies\.swept$/, ['books']],
  [/^automation\.demoted$/, ['books']],
  [/^company\.create$/, ['books']],
  [/^company\.acceptInvitation$/, ['personal', 'credentials']],
  [/^declarations\.[a-z_]+$/, ['tax']],
  [/^spv\.submission\.[a-z_]+$/, ['books']],
  [/^spv\.connected$/, ['credentials']],
  [/^assets\.registered$/, ['books', 'evidence']],
  [/^payroll\.runs\.prepared$/, ['payroll', 'personal']],
  [/^pfa\.sources\.recorded$/, ['tax', 'evidence']],
  [/^if\.members\.recorded$/, ['tax', 'personal', 'evidence']],
];

/** The data classes an audit row discloses: its operation's, or its consequence's; undefined
 * for an action the engine does not know. */
export function eventClasses(
  operations: OperationRegistry,
  action: string,
): readonly DataClass[] | undefined {
  return (
    operations.find(action)?.dataClasses ??
    consequences.find(([pattern]) => pattern.test(action))?.[1]
  );
}

/**
 * Whether a principal may see an event, by its action. A person sees every event of a company
 * they belong to: roles carry no data-class rules yet. An agent sees an event only when the read
 * operations its grant names together cover every data class of the event; `events.since` itself
 * covers none (`Commands.readable`, the rule proposals' inputs follow too). An event of an
 * unknown action is hidden from agents.
 */
export async function eventVisibility(
  tx: Pick<Transaction, 'select'>,
  commands: Commands,
  operations: OperationRegistry,
  actor: Actor,
): Promise<(action: string) => boolean> {
  if (!actor.agentId) return () => true;
  const readable = await commands.readable(tx, actor);
  return (action) => {
    const classes = eventClasses(operations, action);
    return classes !== undefined && readable(classes);
  };
}

/** An audit row as the engine's own consumers read it: nothing is redacted. */
export type AuditEvent = {
  seq: number;
  at: string;
  operation: string;
  actorId: string;
  agentId: string | null;
  refs: Ref[];
  refsOmitted?: number;
  hash: string;
};

/** A company's audit rows after `after`, in order. */
export async function readEvents(
  tx: Pick<Transaction, 'select'>,
  companyId: string,
  after: number,
  limit: number,
): Promise<AuditEvent[]> {
  const rows = await tx
    .select()
    .from(audit)
    .where(and(eq(audit.companyId, companyId), gt(audit.seq, after)))
    .orderBy(asc(audit.seq))
    .limit(limit);
  return rows.map((row) => {
    const body = JSON.parse(row.body) as { refs?: unknown; refsOmitted?: unknown };
    return {
      seq: row.seq,
      at: row.createdAt,
      operation: row.action,
      actorId: row.actorId,
      agentId: row.agentId,
      refs: Array.isArray(body.refs) ? (body.refs as Ref[]) : [],
      ...(typeof body.refsOmitted === 'number' ? { refsOmitted: body.refsOmitted } : {}),
      hash: row.hash,
    };
  });
}

/** The `seq` of a company's latest audit row; 0 before the first. */
export async function auditHead(tx: Pick<Transaction, 'select'>, companyId: string) {
  const [row] = await tx
    .select({ seq: audit.seq })
    .from(audit)
    .where(eq(audit.companyId, companyId))
    .orderBy(desc(audit.seq))
    .limit(1);
  return row?.seq ?? 0;
}

export const eventsInput = z
  .object({
    /** The last `seq` already seen, or a page's `next`; 0 reads from the start. */
    after: z.union([z.number().int().min(0), z.string().regex(/^(0|[1-9]\d{0,14})$/)]).default(0),
    limit: z.number().int().min(1).max(500).default(100),
  })
  .strict();

export const eventView = z.union([
  z.object({
    seq: z.number(),
    at: z.string(),
    operation: z.string(),
    /** `system: true` marks the engine's own principal (a sweep, a demotion), never a person. */
    actor: z.object({
      userId: z.string(),
      agentId: z.string().nullable(),
      system: z.literal(true).optional(),
    }),
    refs: z.array(z.object({ kind: z.string(), id: z.string() })),
    /** How many references beyond the first 1000 the event names. */
    refsOmitted: z.number().optional(),
    hash: z.string(),
  }),
  z.object({ seq: z.number(), redacted: z.literal(true) }),
]);
export const eventsView = z.object({
  items: z.array(eventView),
  /** The `after` of the next page (the last `seq` returned); null once the page reaches `head`. */
  next: z.string().nullable(),
  /** The latest `seq` when read. */
  head: z.number(),
});

export class Events {
  constructor(
    private readonly commands: Commands,
    private readonly operations: OperationRegistry,
  ) {}

  /** The company's audit log after `after`, in order, without gaps: an event the caller may not
   * read keeps its place as `{ seq, redacted: true }`. */
  since(actor: Actor, input: z.infer<typeof eventsInput>) {
    return this.commands.read(actor, 'events.since', async (tx) => {
      const visible = await eventVisibility(tx, this.commands, this.operations, actor);
      const head = await auditHead(tx, actor.companyId);
      const events = await readEvents(tx, actor.companyId, Number(input.after), input.limit);
      const last = events.at(-1)?.seq;
      return {
        items: events.map(({ actorId, agentId, ...event }) =>
          visible(event.operation)
            ? {
                seq: event.seq,
                at: event.at,
                operation: event.operation,
                actor: {
                  userId: actorId,
                  agentId,
                  ...(actorId === SYSTEM_PRINCIPAL ? { system: true as const } : {}),
                },
                refs: event.refs,
                ...(event.refsOmitted ? { refsOmitted: event.refsOmitted } : {}),
                hash: event.hash,
              }
            : { seq: event.seq, redacted: true as const },
        ),
        next: last !== undefined && last < head ? String(last) : null,
        head,
      };
    });
  }
}
