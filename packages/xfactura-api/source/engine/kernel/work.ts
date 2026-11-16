import { and, asc, eq, getTableName, inArray, sql, type Column } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { canonical, hashOf } from 'xfactura-core/hash';
import type { DataClass, Issue, JsonValue, Treatment } from 'xfactura-core/kernel';
import { documentTotals, normalizedNumber } from 'xfactura-core/documents/schemas';
import { questionOf, type QuestionRequest } from 'xfactura-core/questions/kinds';
import { euVatPrefixes } from 'xfactura-core/ro/geo';
import { externalReturns } from 'xfactura-core/ro/obligations';
import { mentionedScheme } from 'xfactura-core/ro/schemes';
import type { ParameterRegister } from 'xfactura-core/rules';
import {
  addDays,
  addMonths,
  bucharestDate,
  monthEnd,
  type LocalDate,
  type Month,
} from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import { answerMediaType } from '../db/invariants';
import {
  actionDecisions,
  actionExecutions,
  actionRequests,
  approvals,
  artifactEvents,
  artifacts,
  assetEvents,
  assets,
  bankMappings,
  bankMovements,
  bankStatements,
  dispositions,
  documentLinks,
  documents,
  employmentTerms,
  enterpriseMembers,
  entries,
  evidence,
  fiscalYears,
  fxRates,
  garnishmentReleases,
  garnishments,
  incomeSources,
  parties,
  partyStatuses,
  payrollLines,
  payrollRuns,
  profileFacts,
  proposalChecks,
  proposals,
  proposalVersions,
  questionAnswers,
  questions,
  questionWithdrawals,
  regesRecords,
  spvMessages,
  withdrawals,
  type Role,
} from '../db/schema';
import type { Actor, Commands } from './commands';
import { roleAllows } from './commands';
import { maskCnps, maskCnpText, payClasses, salaryPayment } from './personal';
import { salaryMovements, salarySubjects } from './salaries';
import { pausedScopes } from './automation';
import { auditHead } from './events';
import { documentBooked, entryStands, holdsSubject } from './ledger';
import type { OperationRegistry } from './operations';
import { SYSTEM_PRINCIPAL } from './principals';
import { closedMonths, type CloseCheck } from './periods';
import { groupLinkKinds } from './sources';
import type { ProposalChange } from './views';
import {
  authorityName,
  axisName,
  causeFromFact,
  causeFromQuestion,
  causeFromRule,
  cleanIdentifierText,
  comparableFieldName,
  completeLabels,
  countLabel,
  dateLabel,
  dedupeCauses,
  detailLabelView,
  documentKindName,
  formatObligationKey,
  idLabel,
  minorLabel,
  obligationStatusName,
  operationName,
  parameterName,
  periodLabel,
  periodName,
  questionKindName,
  returnName,
  ruleGapReasonName,
  stepRefusalView,
  subjectKindName,
  textLabel,
  treatmentName,
  workCauseView,
  type DetailLabels,
  type PermissionKind,
  type StepRefusal,
  type WorkCause,
} from './work-names';

/*
 * The worklist: everything waiting on an agent or a person, computed on read from the books.
 * Detectors each list one family of items (proposals to approve or post, returns due, documents
 * nobody booked, …) with indexed anti-joins and a limit; `work.list` walks them in order, a page
 * at a time. Nothing is stored but dispositions: a person's decision that a document needs no
 * booking or a message was dealt with, which hides the item while its fingerprint (a hash of what
 * was decided on) is unchanged.
 */

export const workKinds = [
  'proposal.awaitingApproval',
  'proposal.approved',
  'proposal.blocked',
  'proposal.stale',
  'question.needed',
  'question.open',
  'action.awaitingDecision',
  'action.approved',
  'obligation.due',
  'closure.need',
  'determination.missing',
  'threshold.approaching',
  'profit.unclassified',
  'asset.fiscalMissing',
  'profit.correction',
  'annual.input',
  'taxaccount.differs',
  'taxaccount.undistributed',
  'taxaccount.correction',
  'vat.prorata',
  'vat.capitalGoods',
  'margin.travel',
  'yearend.review',
  'payroll.due',
  'goods.proof',
  'etransport.uit',
  'efactura.due',
  'retail.register',
  'close.finding',
  'period.unclosed',
  'rule.gap',
  'rule.expiring',
  'document.unproposed',
  'document.betterSource',
  'document.originsDiffer',
  'bank.unexplained',
  'spv.message',
  'evidence.unused',
  'automation.paused',
  'template.graduation',
  'template.candidate',
] as const;
export type WorkKind = (typeof workKinds)[number];
export const workSeverities = ['block', 'warn', 'info'] as const;
export type WorkSeverity = (typeof workSeverities)[number];

/** A step that moves an item on: the operation, who may take it, and the input it starts from.
 * `needs`: the data classes taking it reads beyond its operation's (a payment of pay, a person's
 * balance), which a caller must be allowed to read (`Commands.disclosable`). */
export type WorkStep = {
  operation: string;
  by: 'agent' | 'human';
  inputHint: { [key: string]: JsonValue };
  needs?: readonly DataClass[];
  /** Non-empty when the item's current state forbids taking this step. */
  stateReason?: string;
};
/** A step as the caller reads it: `allowed` when the caller may take it now (an agent, a step for
 * agents under its grant and its issuer's role; a person, under their role); `reason` when
 * `allowed` is false; `complete` whether `inputHint` suffices to run the operation as is. */
export type WorkStepView = Pick<WorkStep, 'operation' | 'by'> & {
  allowed: boolean;
  reason?: StepRefusal;
  complete: boolean;
  missing?: string[];
  inputHint: WorkStep['inputHint'];
  needs?: DataClass[];
};

/** An item as a detector finds it, before it gets its id, fingerprint and audit position. */
export interface Draft {
  kind: WorkKind;
  subject: { kind: string; id: string };
  severity: WorkSeverity;
  due: string | null;
  period: string | null;
  /** What is waiting, in Romanian, for people. */
  message: string;
  /** Deduplicated structured causes when waiting on missing facts, questions or rules. */
  causes?: WorkCause[];
  /** What the item is about; its fingerprint hashes them. */
  details: { [key: string]: JsonValue };
  /** Romanian labels and value types for keys in `details`. */
  labels?: DetailLabels;
  next: WorkStep[];
  /** Where the detector's list resumes after this item. */
  cursor: string;
  /** What a caller who may not read these classes reads instead of the message and the details
   * (a payment of pay without the person and the amount); the fingerprint is the item's own. */
  withheld?: Withheld;
}

/** An item's message and details for a caller who may not read `classes`. */
export interface Withheld {
  classes: readonly DataClass[];
  message: string;
  details: { [key: string]: JsonValue };
  labels?: DetailLabels;
}

export interface WorkContext {
  tx: Transaction;
  companyId: string;
  /** The engine's Bucharest date. */
  today: LocalDate;
}

/** What the caller may do and read, which the steps it is shown depend on. */
interface Caller {
  /** An agent, which never takes a step `by: human`. */
  agent: boolean;
  /** Whether the caller's role allows `permission`. */
  roleAllows: (permission: PermissionKind) => boolean;
  /** Whether it may invoke an operation now. */
  allowed: (operation: string) => boolean;
  /** Whether it may read a treatment's inputs (`Commands.readable` on the treatment's classes). */
  reads: (treatment: string) => boolean;
  /** Whether it may read personal data in clear (`Commands.disclosable`): otherwise an item's
   * message and details carry no CNP (an SPV message comparing a B2C sale quotes the buyer's). */
  cnps: boolean;
  /** Whether it may read data of these classes (`Commands.disclosable`): a withheld item's and a
   * step's (`Withheld`, `WorkStep.needs`). */
  discloses: (classes: readonly DataClass[]) => boolean;
}

/** One family of work items, listed with a limit and resumable at an item's cursor. */
export interface Detector {
  id: string;
  kinds: readonly WorkKind[];
  /**
   * Items after `after` (a cursor of this detector's, null from the start), at most about
   * `limit`, and where to resume after them: null when nothing is left. With `only`, just the
   * items about that subject id (`work.get`).
   */
  list(
    context: WorkContext,
    page: { after: string | null; limit: number; only?: string },
  ): Promise<{ items: Draft[]; next: string | null }>;
}

const stepView = z.object({
  operation: z.string(),
  /** Who the step is for: an agent may take it, or only a person. */
  by: z.enum(['agent', 'human']),
  /** Whether the caller may take it now: an agent, a step `by: agent` under its grant
   * (`proposals.revise` needs the treatment's own `.revise` too) and its issuer's role; a person,
   * any step under their role. */
  allowed: z.boolean(),
  /** Why `allowed` is false: lacking role permission, agent grant, data disclosure, or item state. */
  reason: stepRefusalView.optional(),
  /** Whether `inputHint` validates as is against the operation (and treatment) input schema. */
  complete: z.boolean(),
  /** Missing fields when `complete` is false. */
  missing: z.array(z.string()).optional(),
  inputHint: z.record(z.string(), z.unknown()),
  /** When what stops the caller is the data the step reads (a payment of pay, a person's
   * balance): the classes it may not read. The item then waits on someone who may. */
  needs: z.array(z.string()).optional(),
});
export const workItemView = z.object({
  /** Stable while the item waits: its kind and subject (`<kind>:<subject kind>:<subject id>`). */
  id: z.string(),
  kind: z.enum(workKinds),
  subject: z.object({ kind: z.string(), id: z.string() }),
  severity: z.enum(workSeverities),
  due: z.string().nullable(),
  period: z.string().nullable(),
  message: z.string(),
  causes: z.array(workCauseView).optional(),
  details: z.record(z.string(), z.unknown()),
  labels: z.record(z.string(), detailLabelView),
  /** A hash of the kind, subject and details: a disposition holds while it is unchanged. */
  fingerprint: z.string(),
  next: z.array(stepView),
  /** The audit `seq` the item was computed at. */
  asOfSeq: z.number(),
});
export type WorkItem = z.infer<typeof workItemView>;

export const workListInput = z
  .object({
    kinds: z.array(z.enum(workKinds)).min(1).max(workKinds.length).optional(),
    /** `agent`: only items with a step `by: agent` the caller may take (`allowed`); `human`:
     * items waiting on a person: a step only a person may take, no step, or no agent step the
     * caller may take. */
    by: z.enum(['agent', 'human']).optional(),
    /** At least this severity: `warn` lists blocking items and warnings. */
    severity: z.enum(workSeverities).optional(),
    after: z.string().min(1).max(500).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict();
export const workListView = z.object({
  items: z.array(workItemView),
  next: z.string().nullable(),
  asOfSeq: z.number(),
});
export const workGetInput = z.object({ id: z.string().min(3).max(500) }).strict();
const dispositionView = z.object({
  id: z.string(),
  disposition: z.enum(['no_booking', 'dealt_with']),
  reason: z.string(),
  fingerprint: z.string(),
  createdBy: z.string(),
  agentId: z.string().nullable(),
  at: z.string(),
});
export const workGetView = z.object({
  id: z.string(),
  /** `open`: waiting; `disposed`: hidden by a disposition of this exact fingerprint; `resolved`:
   * nothing waits any more. */
  state: z.enum(['open', 'disposed', 'resolved']),
  item: workItemView.nullable(),
  disposition: dispositionView.nullable(),
  asOfSeq: z.number(),
});
export const disposeInput = z
  .object({
    /** The item's id and the fingerprint it was decided on. */
    id: z.string().min(3).max(500),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    disposition: z.enum(['no_booking', 'dealt_with']),
    reason: z.string().trim().min(10).max(1000),
  })
  .strict();
export const disposeView = dispositionView.extend({
  itemId: z.string(),
  subject: z.object({ kind: z.string(), id: z.string() }),
  documentId: z.string().optional(),
  evidenceId: z.string().optional(),
});

/** Items a disposition may hide, by kind; a person decides all but unused evidence. */
const disposable: Partial<Record<WorkKind, 'person' | 'anyone'>> = {
  'document.unproposed': 'person',
  'document.originsDiffer': 'person',
  'spv.message': 'person',
  'close.finding': 'person',
  'evidence.unused': 'anyone',
  'taxaccount.differs': 'person',
};

const itemId = (kind: string, subject: { kind: string; id: string }) =>
  `${kind}:${subject.kind}:${subject.id}`;
function parseItemId(id: string) {
  const first = id.indexOf(':');
  const second = id.indexOf(':', first + 1);
  const kind = id.slice(0, first) as WorkKind;
  requireCondition(
    first > 0 && second > first + 1 && second < id.length - 1 && workKinds.includes(kind),
    'WORK_ITEM',
    'Identificatorul elementului de lucru nu este valid.',
    422,
  );
  return { kind, subject: { kind: id.slice(first + 1, second), id: id.slice(second + 1) } };
}

/**
 * A column named with its table. Drizzle leaves the columns of a single-table select unqualified,
 * and inside a correlated subquery an unqualified name binds to the subquery's own table.
 */
export const q = (column: Column) => sql.raw(`"${getTableName(column.table)}"."${column.name}"`);

const severityRank: Record<WorkSeverity, number> = { block: 0, warn: 1, info: 2 };
const monthOf = (date: string | null | undefined) => (date ? date.slice(0, 7) : null);
const agent = (operation: string, inputHint: WorkStep['inputHint'] = {}): WorkStep => ({
  operation,
  by: 'agent',
  inputHint,
});
const human = (operation: string, inputHint: WorkStep['inputHint'] = {}): WorkStep => ({
  operation,
  by: 'human',
  inputHint,
});
/**
 * Proposing a treatment, from the input to start from: `proposals.propose { treatment, input }`,
 * the generic form an agent's MCP core lists. A caller whose credential names the treatment's own
 * `.propose` but not the generic one is shown that typed form instead (`asCalled`).
 */
const propose = (treatment: string, input: WorkStep['inputHint'] = {}): WorkStep =>
  agent('proposals.propose', { treatment, input });
/** `work.dispose`, completed with the item's id and fingerprint once they are known. */
const dispose = (by: 'agent' | 'human', disposition: 'no_booking' | 'dealt_with'): WorkStep => ({
  operation: 'work.dispose',
  by,
  inputHint: { disposition },
});
const json = (text: string | null) => (text ? (JSON.parse(text) as JsonValue) : null);
/** A step's hint as the caller may read it: a proposal's input only when the caller may read its
 * treatment's data classes (`proposals.get` redacts it the same way). */
function hidden(step: WorkStep, draft: Pick<Draft, 'details'>, caller: Caller) {
  const treatment = draft.details.treatment;
  if (!('input' in step.inputHint) || typeof treatment !== 'string' || caller.reads(treatment))
    return step.inputHint;
  const { input: _, ...rest } = step.inputHint;
  return rest;
}
/** The treatment a generic `proposals.propose` or `proposals.revise` step goes through. */
function treatmentOf(step: WorkStep, draft: Pick<Draft, 'details'>) {
  const treatment =
    step.operation === 'proposals.revise'
      ? draft.details.treatment
      : step.operation === 'proposals.propose'
        ? step.inputHint.treatment
        : undefined;
  return typeof treatment === 'string' ? treatment : undefined;
}
/** The operations a step needs: its own and, for the generic `proposals.revise` and
 * `proposals.propose`, the treatment's own `.revise` or `.propose`, which the command is recorded
 * under and the credential must name too (as `capabilities.invoke` and REST check). */
function stepNeeds(step: WorkStep, draft: Pick<Draft, 'details'>) {
  const treatment = treatmentOf(step, draft);
  if (treatment === undefined) return [step.operation];
  return [step.operation, `${treatment}.${step.operation.slice('proposals.'.length)}`];
}
/**
 * The step as this caller would call it. A generic `proposals.propose` or `proposals.revise` is
 * shown as the treatment's own `.propose` or `.revise` to a caller who may use that and not the
 * generic one (a narrow grant naming the treatment): its input, for `.propose`, is the treatment's
 * input itself; `.revise` takes the same input as `proposals.revise`. A proposal step citing a basis
 * stays generic, as `.propose` takes none.
 */
function asCalled(step: WorkStep, draft: Pick<Draft, 'details'>, caller: Caller): WorkStep {
  const treatment = treatmentOf(step, draft);
  if (treatment === undefined || caller.allowed(step.operation)) return step;
  const typed = `${treatment}.${step.operation.slice('proposals.'.length)}`;
  if (!caller.allowed(typed)) return step;
  if (step.operation === 'proposals.revise') return { ...step, operation: typed };
  if ('basis' in step.inputHint) return step;
  const input = step.inputHint.input;
  return {
    ...step,
    operation: typed,
    inputHint: input && typeof input === 'object' && !Array.isArray(input) ? input : {},
  };
}

/** Resumes a list ordered by id strictly after `after`, or at the one subject `only`. */
const position = (column: Column, page: { after: string | null; only?: string }) =>
  page.only !== undefined
    ? sql`${q(column)} = ${page.only}`
    : page.after !== null
      ? sql`${q(column)} > ${page.after}`
      : undefined;
/** Rows of a page, one more than asked, and where the next resumes. */
function paged<T>(rows: T[], limit: number, cursor: (row: T) => string) {
  const page = rows.slice(0, limit);
  return { page, next: rows.length > limit ? cursor(page.at(-1)!) : null };
}

const notPosted = sql`not exists (select 1 from ${entries} e
  where e.company_id = ${q(proposals.companyId)} and e.proposal_id = ${q(proposals.id)})`;
const notWithdrawn = sql`not exists (select 1 from ${withdrawals} w
  where w.company_id = ${q(proposals.companyId)} and w.proposal_id = ${q(proposals.id)})`;
const latestVersion = sql`(select max(lv.version) from ${proposalVersions} lv
  where lv.company_id = ${q(proposals.companyId)} and lv.proposal_id = ${q(proposals.id)})`;
const groupKinds = sql.raw(`(${groupLinkKinds.map((kind) => `'${kind}'`).join(', ')})`);

// Proposals waiting on a person, an agent or a question.

function proposalsDetector(
  questionState: QuestionState,
  treatments?: () => readonly Treatment[],
): Detector {
  const byId = () => new Map((treatments?.() ?? []).map((item) => [item.id, item]));
  return {
    id: 'proposals',
    kinds: [
      'proposal.stale',
      'question.needed',
      'proposal.blocked',
      'proposal.approved',
      'proposal.awaitingApproval',
    ],
    async list({ tx, companyId }, page) {
      const rows = await tx
        .select({
          id: proposals.id,
          treatment: proposals.treatmentId,
          subject: proposals.subjectKey,
          version: proposalVersions.version,
          input: proposalVersions.input,
          readSet: proposalVersions.readSet,
          issues: proposalVersions.issues,
          blocking: proposalVersions.blocking,
          effectHash: proposalVersions.effectHash,
          entryDate: proposalVersions.entryDate,
          basis: proposalVersions.basis,
          approved: sql<number>`exists (select 1 from ${approvals} a
            where a.company_id = ${q(proposals.companyId)} and a.proposal_id = ${q(proposals.id)}
              and a.version = ${q(proposalVersions.version)}
              and a.effect_hash = ${q(proposalVersions.effectHash)})`.mapWith(Number),
          stale: proposalChecks.stale,
          changed: proposalChecks.changed,
        })
        .from(proposals)
        .innerJoin(
          proposalVersions,
          and(
            eq(proposalVersions.companyId, proposals.companyId),
            eq(proposalVersions.proposalId, proposals.id),
            eq(proposalVersions.version, latestVersion),
          ),
        )
        .leftJoin(
          proposalChecks,
          and(
            eq(proposalChecks.companyId, proposals.companyId),
            eq(proposalChecks.proposalId, proposals.id),
            eq(proposalChecks.version, proposalVersions.version),
          ),
        )
        .where(
          and(
            eq(proposals.companyId, companyId),
            position(proposals.id, page),
            notPosted,
            notWithdrawn,
          ),
        )
        .orderBy(asc(proposals.id))
        .limit(page.limit + 1);
      const { page: chosen, next } = paged(rows, page.limit, (row) => row.id);
      const treatmentMap = byId();
      const items: Draft[] = [];
      for (const row of chosen) {
        const treatmentLabel = treatmentName(row.treatment, treatmentMap);
        const issues = JSON.parse(row.issues) as Issue[];
        const base = {
          subject: { kind: 'proposal', id: row.id },
          due: null,
          period: monthOf(row.entryDate),
          cursor: row.id,
        };
        const named = { proposalId: row.id, version: row.version };
        const revise = (extra: WorkStep['inputHint'] = {}) =>
          agent('proposals.revise', { ...named, input: json(row.input), ...extra });
        const blocks = issues.filter((issue) => issue.severity === 'block');
        const asked = issues
          .map((issue) => ({ issue, question: questionOf(issue) }))
          .filter((item): item is { issue: Issue; question: QuestionRequest } => !!item.question);
        // One item per proposal: a question first (its revision cites the answers and settles
        // staleness too), then stale, blocked, approved, awaiting approval.
        if (asked.length) {
          // The answers this version already relied on: one it read that is still the latest,
          // with the question still raised, did not settle it, and a person answers again.
          const cited = new Set(
            (JSON.parse(row.readSet) as { kind: string; id: string; version: string }[])
              .filter((entry) => entry.kind === 'answer')
              .map((entry) => `${entry.id}/${entry.version}`),
          );
          const states = [];
          for (const { issue, question } of asked) {
            const state = await questionState(tx, companyId, question);
            states.push({
              code: issue.code,
              kind: question.kind,
              subject: question.subject,
              params: question.params,
              state: state.answered
                ? cited.has(`${state.answered.questionId}/${state.answered.answerId}`)
                  ? 'unsettled'
                  : 'answered'
                : state.open
                  ? 'open'
                  : 'unasked',
              questionId: state.answered?.questionId ?? state.open,
            });
          }
          const answered = states.every((item) => item.state === 'answered');
          const next: WorkStep[] = answered
            ? [revise({ basis: { answers: [...new Set(states.map((item) => item.questionId!))] } })]
            : states.flatMap((item) =>
                item.state === 'unasked'
                  ? [
                      agent('questions.ask', {
                        kind: item.kind,
                        subject: item.subject,
                        params: item.params,
                      }),
                    ]
                  : item.state === 'open' || item.state === 'unsettled'
                    ? [human('questions.answer', { questionId: item.questionId })]
                    : [],
              );
          const questionCauses = dedupeCauses([
            ...asked.map(({ issue, question }) => causeFromQuestion(question, issue.message)),
            ...blocks
              .filter((issue) => issue.code === 'RULE_GAP')
              .map((issue) => {
                const gap = (issue.details ?? {}) as { key?: string; reason?: string };
                return causeFromRule(gap.key ?? 'unknown', gap.reason ?? 'RULE_GAP', issue.message);
              }),
          ]);
          items.push({
            ...base,
            kind: 'question.needed',
            severity: 'block',
            message: answered
              ? `S-a răspuns la întrebările propunerii ${treatmentLabel}: revizuiți-o citând răspunsurile.`
              : `Propunerea ${treatmentLabel} așteaptă un răspuns: ${questionCauses.map((cause) => cause.message).join(' ')}`,
            causes: questionCauses,
            details: {
              treatment: row.treatment,
              version: row.version,
              questions: states as unknown as JsonValue,
              blocking: blocks.filter((issue) => !questionOf(issue)).map((issue) => issue.code),
            },
            labels: {
              treatment: textLabel('Tratament'),
              version: countLabel('Versiune'),
              questions: textLabel('Întrebări'),
              blocking: countLabel('Blocaje'),
            },
            next,
          });
          continue;
        }
        if (row.stale) {
          items.push({
            ...base,
            kind: 'proposal.stale',
            severity: 'warn',
            message: `Registrele s-au schimbat de la evaluarea propunerii ${treatmentLabel}: revizuiți-o.`,
            details: {
              treatment: row.treatment,
              version: row.version,
              changed: (JSON.parse(row.changed ?? '[]') as ProposalChange[]).slice(0, 20),
            },
            labels: {
              treatment: textLabel('Tratament'),
              version: countLabel('Versiune'),
              changed: textLabel('Modificări'),
            },
            next: [revise(), agent('proposals.get', { id: row.id, recheck: true })],
          });
          continue;
        }
        if (row.blocking) {
          // A proposal blocked only by missing rules is listed with its rule (`rule.gap`).
          if (blocks.every((issue) => issue.code === 'RULE_GAP')) continue;
          const blockSummary = blocks
            .map((issue) => cleanIdentifierText(issue.message).replace(/\.$/, ''))
            .join('; ');
          items.push({
            ...base,
            kind: 'proposal.blocked',
            severity: 'block',
            message: `Propunerea ${treatmentLabel} are probleme care împiedică aprobarea: ${blockSummary}.`,
            details: {
              treatment: row.treatment,
              version: row.version,
              issues: blocks.map((issue) => ({
                code: issue.code,
                message: issue.message,
                ...(issue.path ? { path: issue.path } : {}),
              })),
            },
            labels: {
              treatment: textLabel('Tratament'),
              version: countLabel('Versiune'),
              issues: textLabel('Probleme'),
            },
            next: [revise(), agent('proposals.withdraw', { proposalId: row.id })],
          });
          continue;
        }
        if (row.approved) {
          items.push({
            ...base,
            kind: 'proposal.approved',
            severity: 'warn',
            message: `Propunerea ${treatmentLabel} este aprobată și necontabilizată.`,
            details: { treatment: row.treatment, version: row.version, effectHash: row.effectHash },
            labels: {
              treatment: textLabel('Tratament'),
              version: countLabel('Versiune'),
              effectHash: textLabel('Amprenta efectului'),
            },
            next: [agent('ledger.post', { ...named, effectHash: row.effectHash })],
          });
          continue;
        }
        const ackIssues = issues.filter((issue) => issue.severity === 'ack');
        const acknowledge = ackIssues.map((issue) => issue.code);
        const ackSummary = ackIssues
          .map((issue) => cleanIdentifierText(issue.message).replace(/\.$/, ''))
          .join('; ');
        items.push({
          ...base,
          kind: 'proposal.awaitingApproval',
          severity: 'warn',
          message: `Propunerea ${treatmentLabel} așteaptă aprobarea unei persoane${ackSummary ? `, cu avertismentele: ${ackSummary}` : ''}.`,
          details: {
            treatment: row.treatment,
            version: row.version,
            effectHash: row.effectHash,
            acknowledge,
          },
          labels: {
            treatment: textLabel('Tratament'),
            version: countLabel('Versiune'),
            effectHash: textLabel('Amprenta efectului'),
            acknowledge: textLabel('Avertismente de confirmat'),
          },
          next: [human('proposals.approve', { ...named, effectHash: row.effectHash, acknowledge })],
        });
      }
      // A proposal paying pay (`salarySubjects`) names its person in its issues and its input: a
      // caller who may not read pay reads that it waits, and takes none of its steps.
      const salaries = await salarySubjects(
        tx,
        companyId,
        chosen.map((row) => row.subject),
      );
      for (const item of items) {
        const row = chosen.find((candidate) => candidate.id === item.subject.id)!;
        if (!salaries.has(row.subject)) continue;
        item.withheld = {
          classes: payClasses,
          message: `Propunerea ${treatmentName(row.treatment, treatmentMap)} (${salaryPayment}) așteaptă: o vede cine poate citi datele salariale.`,
          details: {
            treatment: row.treatment,
            version: row.version,
            effectHash: row.effectHash,
            redacted: true,
          },
          labels: {
            treatment: textLabel('Tratament'),
            version: countLabel('Versiune'),
            effectHash: textLabel('Amprenta efectului'),
            redacted: textLabel('Date cu acces restricționat'),
          },
        };
        item.next = item.next.map((step) => ({ ...step, needs: payClasses }));
      }
      return { items, next };
    },
  };
}

/** Where a question a treatment needs stands: the question whose answer holds, or the one open. */
export type QuestionState = (
  tx: Transaction,
  companyId: string,
  request: QuestionRequest,
) => Promise<{
  /** The question whose answer still holds, and that answer. */
  answered: { questionId: string; answerId: string } | null;
  /** The question asked and not yet answered. */
  open: string | null;
}>;

// Questions waiting on a person.

const questionsDetector: Detector = {
  id: 'questions',
  kinds: ['question.open'],
  async list({ tx, companyId }, page) {
    const rows = await tx
      .select()
      .from(questions)
      .where(
        and(
          eq(questions.companyId, companyId),
          position(questions.id, page),
          sql`not exists (select 1 from ${questionAnswers} a
            where a.company_id = ${q(questions.companyId)} and a.question_id = ${q(questions.id)})`,
          sql`not exists (select 1 from ${questionWithdrawals} w
            where w.company_id = ${q(questions.companyId)} and w.question_id = ${q(questions.id)})`,
        ),
      )
      .orderBy(asc(questions.id))
      .limit(page.limit + 1);
    const { page: chosen, next } = paged(rows, page.limit, (row) => row.id);
    return {
      items: chosen.map((row) => {
        const subjectText =
          row.subjectKind === 'profile' || row.subjectKind === 'determination'
            ? axisName(row.subjectId)
            : `${subjectKindName(row.subjectKind)} ${row.subjectId}`;
        const message = `Întrebarea privind ${questionKindName(row.kind)} (${subjectText}) așteaptă răspunsul unei persoane.`;
        return {
          kind: 'question.open',
          subject: { kind: 'question', id: row.id },
          severity: 'warn',
          due: row.due,
          period: null,
          message,
          causes: [
            causeFromQuestion(
              { kind: row.kind, subject: { kind: row.subjectKind, id: row.subjectId } },
              message,
            ),
          ],
          details: {
            kind: row.kind,
            subject: { kind: row.subjectKind, id: row.subjectId },
            params: json(row.params),
          },
          labels: {
            kind: textLabel('Tip'),
            subject: textLabel('Obiect'),
            params: textLabel('Parametri'),
          },
          next: [
            human('questions.answer', { questionId: row.id }),
            agent('questions.withdraw', { questionId: row.id }),
          ],
          cursor: row.id,
        };
      }),
      next,
    };
  },
};

// Reviewed actions waiting on a decision or on their execution.

function actionsDetector(operations?: () => OperationRegistry): Detector {
  return {
    id: 'actions',
    kinds: ['action.awaitingDecision', 'action.approved'],
    async list({ tx, companyId }, page) {
      const rows = await tx
        .select({
          id: actionRequests.id,
          operation: actionRequests.operation,
          input: actionRequests.input,
          preview: actionRequests.preview,
          previewHash: actionRequests.previewHash,
          decision: actionDecisions.decision,
        })
        .from(actionRequests)
        .leftJoin(
          actionDecisions,
          and(
            eq(actionDecisions.companyId, actionRequests.companyId),
            eq(actionDecisions.requestId, actionRequests.id),
          ),
        )
        .where(
          and(
            eq(actionRequests.companyId, companyId),
            position(actionRequests.id, page),
            sql`(${q(actionDecisions.decision)} is null or ${q(actionDecisions.decision)} = 'approve')`,
            sql`not exists (select 1 from ${actionExecutions} x
            where x.company_id = ${q(actionRequests.companyId)} and x.request_id = ${q(actionRequests.id)})`,
            // A request asked again for the same input is replaced by the later one.
            sql`not exists (select 1 from ${actionRequests} r
            where r.company_id = ${q(actionRequests.companyId)} and r.operation = ${q(actionRequests.operation)}
              and r.input_json = ${q(actionRequests.input)}
              and (r.created_at > ${q(actionRequests.createdAt)}
                or (r.created_at = ${q(actionRequests.createdAt)} and r.id > ${q(actionRequests.id)})))`,
          ),
        )
        .orderBy(asc(actionRequests.id))
        .limit(page.limit + 1);
      const { page: chosen, next } = paged(rows, page.limit, (row) => row.id);
      return {
        items: chosen.map((row): Draft => {
          const input = JSON.parse(row.input) as { month?: string; artifactId?: string };
          const preview = JSON.parse(row.preview) as { findings?: { severity: string }[] };
          const blocking = (preview.findings ?? []).filter(
            (item) => item.severity === 'block',
          ).length;
          const base = {
            subject: { kind: 'action', id: row.id },
            due: null,
            period: input.month ?? null,
            cursor: row.id,
            details: {
              operation: row.operation,
              input: input as JsonValue,
              previewHash: row.previewHash,
              blocking,
            },
            labels: {
              operation: textLabel('Operațiune'),
              input: textLabel('Date de intrare'),
              previewHash: textLabel('Amprenta previzualizării'),
              blocking: countLabel('Blocaje'),
            },
          };
          const opLabel = operationName(row.operation, operations?.());
          return row.decision === 'approve'
            ? {
                ...base,
                kind: 'action.approved',
                severity: 'warn',
                message: `Acțiunea „${opLabel}” este aprobată și neexecutată.`,
                next: [agent('actions.execute', { id: row.id })],
              }
            : {
                ...base,
                kind: 'action.awaitingDecision',
                severity: blocking ? 'block' : 'warn',
                message: blocking
                  ? `Acțiunea „${opLabel}” are ${blocking} probleme care împiedică aprobarea: rezolvați-le și cereți-o din nou.`
                  : `Acțiunea „${opLabel}” așteaptă decizia unei persoane.`,
                next: blocking
                  ? []
                  : [
                      human('actions.approve', { id: row.id, previewHash: row.previewHash }),
                      human('actions.reject', { id: row.id, previewHash: row.previewHash }),
                    ],
              };
        }),
        next,
      };
    },
  };
}

// Returns not yet filed: every one from the books' first month (an overdue return stays until
// it is filed, in the engine or recorded as filed outside it) to two months ahead.

/** A return of the obligations calendar, as far as the worklist reads it. */
export type Obligation = {
  kind: string;
  deadline: string;
  period: string;
  start: string;
  end: string;
  due: string | null;
  status: string;
  artifactId: string | null;
  gap: string | null;
  /** For a return blocked by an unknown fact, the question the closure names. */
  question?: {
    kind: string;
    subject: { kind: string; id: string };
    params: { [key: string]: unknown };
  } | null;
  /** For a blocked return whose deadline's rule is beyond the register's horizon: the year whose
   * rules it waits for. */
  waiting?: number | null;
  /** Structured causes for why the return is blocked, deduplicated by cause id. */
  causes?: WorkCause[];
};
export type ObligationsOf = (
  tx: Transaction,
  companyId: string,
  range: { from: string; to: string },
  today: LocalDate,
) => Promise<Obligation[]>;

/** The months the worklist reads the calendar and the closure over: from the first month of the
 * company's books (its first financial year), or three months back without one, to two months
 * ahead. */
async function worklistRange(tx: Transaction, companyId: string, today: LocalDate) {
  const month = today.slice(0, 7) as Month;
  const [first] = await tx
    .select({ from: sql<string | null>`min(${fiscalYears.from})` })
    .from(fiscalYears)
    .where(and(eq(fiscalYears.companyId, companyId), eq(fiscalYears.kind, 'financial')));
  const back = addMonths(month, -3);
  const start = (first?.from?.slice(0, 7) ?? back) as Month;
  return { from: start < back ? start : back, to: addMonths(month, 2) };
}

/** A closure question's step: the engine opens those of a yearly determination (their
 * parameters are its computation) through `determinations.propose`; others are asked as named. */
function askSteps(question: NonNullable<Obligation['question']>, year: number): WorkStep[] {
  return ['determination.confirm', 'micro.conditions', 'year.figures'].includes(question.kind) ||
    question.subject.id.includes('/')
    ? [agent('determinations.propose', { year })]
    : [agent('questions.ask', question as unknown as WorkStep['inputHint'])];
}

/** Recording a return filed outside the engine: an agent asks, a person answers with ANAF's
 * registration number and receipt (`obligation.filed`). */
const filedOutsideSteps = (item: { kind: string; period: string }): WorkStep[] => [
  agent('questions.ask', {
    kind: 'obligation.filed',
    subject: { kind: 'obligation', id: `${item.kind}/${item.period}` },
    params: { kind: item.kind, period: item.period },
  }),
  human('questions.answer'),
];

/**
 * How much an unfiled return weighs on the worklist. Overdue and rejected returns block. A
 * blocked one blocks once its period has started; before, it warns. One waiting for its year's
 * rules (its deadline's rule beyond the register's horizon, before the rollover) blocks no close
 * of the year before: it is information until its period starts, a warning while it runs, and
 * blocks once it ended, its deadline then weeks away. The others warn within 7 days of their
 * deadline.
 */
function obligationSeverity(item: Obligation, today: LocalDate): WorkSeverity {
  if (['overdue', 'rejected'].includes(item.status)) return 'block';
  if (item.status === 'blocked') {
    const started = item.start <= today;
    if (item.waiting) return item.end < today ? 'block' : started ? 'warn' : 'info';
    return started ? 'block' : 'warn';
  }
  return item.due && item.due <= addDays(today, 7) ? 'warn' : 'info';
}

function obligationsDetector(calendar: ObligationsOf): Detector {
  const key = (item: Obligation) => [item.due ?? '9999-12-31', item.end, item.kind, item.period];
  const after = (a: string[], b: string[]) => {
    for (let index = 0; index < a.length; index++)
      if (a[index] !== b[index]) return a[index]! > b[index]!;
    return false;
  };
  return {
    id: 'obligations',
    kinds: ['obligation.due'],
    async list({ tx, companyId, today }, page) {
      const due = (await calendar(tx, companyId, await worklistRange(tx, companyId, today), today))
        .filter((item) => !['filed', 'accepted'].includes(item.status))
        .filter((item) =>
          page.only !== undefined
            ? `${item.kind}|${item.period}` === page.only
            : page.after === null || after(key(item), page.after.split('|')),
        );
      const items = due.slice(0, page.limit).map((item): Draft => {
        const artifactId = item.artifactId;
        // A return blocked by an unknown fact: the closure's question. One the engine does not
        // cover (or without a deadline rule) is filed outside it, recorded as such. One waiting
        // for its year's rules has nothing to do until they are reviewed.
        const ask: WorkStep[] = item.waiting
          ? []
          : item.question
            ? askSteps(item.question, Number(item.end.slice(0, 4)))
            : filedOutsideSteps(item);
        // A return the company files outside the engine: a person records the filing. Any other
        // overdue or rejected return may have been filed outside it too, recorded the same way.
        const external = externalReturns.includes(item.kind);
        const next: WorkStep[] =
          item.status === 'blocked'
            ? ask
            : external && (item.status === 'due' || item.status === 'overdue')
              ? filedOutsideSteps(item)
              : item.status === 'due' || item.status === 'overdue'
                ? [
                    agent('declarations.prepare', { kind: item.kind, period: item.period }),
                    ...(item.status === 'overdue' ? filedOutsideSteps(item) : []),
                  ]
                : item.status === 'rejected'
                  ? [
                      agent('declarations.prepare', {
                        kind: item.kind,
                        period: item.period,
                        supersedesId: artifactId,
                      }),
                      ...filedOutsideSteps(item),
                    ]
                  : item.status === 'prepared'
                    ? [
                        agent('declarations.validate', { artifactId }),
                        human('declarations.authorize.request', { artifactId }),
                      ]
                    : item.status === 'authorized'
                      ? [
                          agent('declarations.pdf', { artifactId }),
                          agent('declarations.importSigned', { artifactId }),
                          human('declarations.recordSubmission', { artifactId }),
                        ]
                      : [];
        const causes = item.causes?.length
          ? dedupeCauses(
              item.causes.map((cause) => ({
                ...cause,
                message: cleanIdentifierText(cause.message),
              })),
            )
          : undefined;
        const returnLabel = returnName(item.kind);
        const periodLabelText = periodName(item.period);
        const causesText = causes?.map((cause) => cause.message).join(' ');
        const cleanGap = item.gap ? cleanIdentifierText(item.gap) : null;
        const draft: Draft = {
          kind: 'obligation.due',
          subject: { kind: 'obligation', id: `${item.kind}|${item.period}` },
          severity: obligationSeverity(item, today),
          due: item.due,
          period: item.period,
          message:
            item.status === 'blocked'
              ? item.waiting
                ? `${returnLabel} pentru ${periodLabelText} așteaptă regulile pentru ${item.waiting}${cleanGap ? `: ${cleanGap.replace(/\.+$/, '')}` : ''}.`
                : item.question
                  ? `${returnLabel} pentru ${periodLabelText} depinde de: ${causesText || cleanGap || 'lipsește un fapt'}`
                  : `${returnLabel} pentru ${periodLabelText} este blocată: ${causesText || cleanGap || 'lipsește regula.'}`
              : `${returnLabel} pentru ${periodLabelText}${item.due ? `, cu termen la ${item.due}` : ''}: ${obligationStatusName(item.status)}.`,
          ...(causes?.length ? { causes } : {}),
          details: {
            kind: item.kind,
            deadline: item.deadline,
            period: item.period,
            due: item.due,
            status: item.status,
            artifactId,
            gap: item.gap,
            ...(item.question ? { question: item.question as unknown as JsonValue } : {}),
            ...(item.waiting ? { waiting: item.waiting } : {}),
          },
          labels: {
            kind: textLabel('Declarație'),
            deadline: textLabel('Regula termenului'),
            period: periodLabel('Perioadă'),
            due: dateLabel('Termen'),
            status: textLabel('Stare'),
            artifactId: idLabel('Declarație', 'artifact'),
            gap: textLabel('Ce lipsește'),
            ...(item.question ? { question: textLabel('Întrebare') } : {}),
            ...(item.waiting ? { waiting: periodLabel('An așteptat') } : {}),
          },
          next,
          cursor: key(item).join('|'),
        };
        // A D112's deadline rule tells why it is due then (sick leave, art. 147 alin. (11)): a
        // caller who may not read health data reads the return's due date alone, as the
        // calendar shows it (`d112WithoutHealth`).
        if (item.kind === 'D112')
          draft.withheld = {
            classes: ['health'],
            message: draft.message,
            details: { ...draft.details, deadline: 'D112' },
            labels: draft.labels,
          };
        return draft;
      });
      return { items, next: due.length > page.limit ? items.at(-1)!.cursor : null };
    },
  };
}

// The obligation closure's needs over the worklist's range: each fact or determination it cannot
// read (NEEDS_EVIDENCE), the returns it blocks or none (the scope facts), with its question.

/** A need of the obligation closure, as the worklist reads it. */
export type ClosureNeed = {
  id: string;
  code: string;
  fact: string;
  message: string;
  question: NonNullable<Obligation['question']>;
  /** The returns it leaves blocked, `<return>|<period>`. */
  blocks: string[];
  /** The year whose rules every return it blocks waits for, or null. */
  waiting: number | null;
  /** The deadline rule gap when `waiting` is set, if known. */
  waitingRule?: { key: string; reason: string } | null;
};
export type NeedsOf = (
  tx: Transaction,
  companyId: string,
  range: { from: string; to: string },
  today: LocalDate,
) => Promise<ClosureNeed[]>;

function needsDetector(source: NeedsOf): Detector {
  return {
    id: 'needs',
    kinds: ['closure.need'],
    async list({ tx, companyId, today }, page) {
      // In code-unit order, as the cursor compares.
      const found = (await source(tx, companyId, await worklistRange(tx, companyId, today), today))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .filter((need) =>
          page.only !== undefined
            ? need.id === page.only
            : page.after === null || need.id > page.after,
        );
      const items = found.slice(0, page.limit).map((need): Draft => {
        // A yearly fact (`vat.period/2027`) of a year not begun, or one only that year's rules
        // can settle, waits: nobody can answer it yet.
        const year = /\/(\d{4})$/.exec(need.fact)?.[1];
        const waits = need.waiting ?? (year && `${year}-01-01` > today ? Number(year) : null);
        const cleanNeed = cleanIdentifierText(need.message);
        const causes = dedupeCauses([
          causeFromFact(need.fact, cleanNeed),
          ...(waits && need.waitingRule
            ? [
                causeFromRule(
                  need.waitingRule.key,
                  need.waitingRule.reason,
                  `Regulile pentru anul ${waits} nu sunt încă aprobate (${ruleGapReasonName(need.waitingRule.reason)}).`,
                ),
              ]
            : []),
        ]);
        const formattedBlocks = need.blocks.slice(0, 6).map(formatObligationKey).join(', ');
        return {
          kind: 'closure.need',
          subject: { kind: 'need', id: need.id },
          severity: waits ? 'info' : 'warn',
          due: null,
          period: year ?? null,
          message: waits
            ? `${cleanNeed} Se stabilește după începutul anului ${waits}, cu regulile lui.`
            : `${cleanNeed}${
                need.blocks.length
                  ? ` Afectează declarațiile: ${formattedBlocks}${need.blocks.length > 6 ? ` și încă ${need.blocks.length - 6}` : ''}.`
                  : ' Închiderea obligațiilor nu poate confirma ce declarații se datorează.'
              }`,
          causes,
          details: {
            code: need.code,
            fact: need.fact,
            question: need.question as unknown as JsonValue,
            blocks: need.blocks,
            ...(waits ? { waiting: waits } : {}),
          },
          labels: {
            code: textLabel('Cod'),
            fact: textLabel('Fapt'),
            question: textLabel('Întrebare'),
            blocks: textLabel('Declarații afectate'),
            ...(waits ? { waiting: periodLabel('An așteptat') } : {}),
          },
          next: waits ? [] : askSteps(need.question, Number(year ?? today.slice(0, 4))),
          cursor: need.id,
        };
      });
      return { items, next: found.length > page.limit ? items.at(-1)!.cursor : null };
    },
  };
}

// Yearly determinations not recorded or contradicted by the books, and thresholds approached
// (core ro/determinations/agent.ts).

/** An item of the determinations module, as the worklist reads it. */
export type DeterminationWork = {
  kind: 'determination.missing' | 'threshold.approaching';
  subjectId: string;
  severity: 'block' | 'warn';
  year: number;
  message: string;
  causes?: WorkCause[];
  details: { [key: string]: JsonValue };
  labels?: DetailLabels;
};
export type DeterminationsOf = (
  tx: Transaction,
  companyId: string,
  today: LocalDate,
) => Promise<DeterminationWork[]>;

function determinationsDetector(source: DeterminationsOf): Detector {
  const cursorOf = (item: DeterminationWork) => `${item.kind}|${item.subjectId}`;
  return {
    id: 'determinations',
    kinds: ['determination.missing', 'threshold.approaching'],
    async list({ tx, companyId, today }, page) {
      const found = (await source(tx, companyId, today))
        .sort((a, b) => cursorOf(a).localeCompare(cursorOf(b)))
        .filter((item) =>
          page.only !== undefined
            ? item.subjectId === page.only
            : page.after === null || cursorOf(item) > page.after,
        );
      const items = found.slice(0, page.limit).map((item): Draft => ({
        kind: item.kind,
        subject: {
          kind: item.kind === 'determination.missing' ? 'determination' : 'threshold',
          id: item.subjectId,
        },
        severity: item.severity,
        due: null,
        period: String(item.year),
        message: item.message,
        ...(item.causes ? { causes: item.causes } : {}),
        details: item.details,
        ...(item.labels ? { labels: item.labels } : {}),
        next: [agent('determinations.propose', { year: item.year })],
        cursor: cursorOf(item),
      }));
      return { items, next: found.length > page.limit ? items.at(-1)!.cursor : null };
    },
  };
}

// The profit tax: accounts to classify, assets without a fiscal basis, prior-year corrections not
// carried into the corrected year (core ro/profit/agent.ts).

/** An item of the profit tax module, as the worklist reads it. */
export type ProfitWorkItem = {
  kind: 'profit.unclassified' | 'asset.fiscalMissing' | 'profit.correction';
  subject: { kind: string; id: string };
  severity: 'block' | 'warn';
  year: number;
  message: string;
  causes?: WorkCause[];
  details: { [key: string]: JsonValue };
  labels?: DetailLabels;
  next: WorkStep[];
};
export type ProfitWorkOf = (
  tx: Transaction,
  companyId: string,
  today: LocalDate,
) => Promise<ProfitWorkItem[]>;

function profitDetector(source: ProfitWorkOf): Detector {
  const cursorOf = (item: ProfitWorkItem) => `${item.kind}|${item.subject.kind}:${item.subject.id}`;
  return {
    id: 'profit',
    kinds: ['profit.unclassified', 'asset.fiscalMissing', 'profit.correction'],
    async list({ tx, companyId, today }, page) {
      const found = (await source(tx, companyId, today))
        .sort((a, b) => cursorOf(a).localeCompare(cursorOf(b)))
        .filter((item) =>
          page.only !== undefined
            ? item.subject.id === page.only
            : page.after === null || cursorOf(item) > page.after,
        );
      const items = found.slice(0, page.limit).map((item): Draft => ({
        kind: item.kind,
        subject: item.subject,
        severity: item.severity,
        due: null,
        period: String(item.year),
        message: item.message,
        ...(item.causes ? { causes: item.causes } : {}),
        details: item.details,
        ...(item.labels ? { labels: item.labels } : {}),
        next: item.next,
        cursor: cursorOf(item),
      }));
      return { items, next: found.length > page.limit ? items.at(-1)!.cursor : null };
    },
  };
}

// The annual statements: an F30 chapter, the disclosures or an accompanying document a person
// owes, or a half-year report the engine does not prepare (core ro/annual/agent.ts).

/** An item of the annual statements module, as the worklist reads it. */
export type AnnualWorkItem = {
  subjectId: string;
  severity: WorkSeverity;
  year: number;
  kind: string;
  message: string;
  causes?: WorkCause[];
  details: { [key: string]: JsonValue };
  labels?: DetailLabels;
};
export type AnnualWorkOf = (
  tx: Transaction,
  companyId: string,
  today: LocalDate,
) => Promise<AnnualWorkItem[]>;

function annualDetector(source: AnnualWorkOf): Detector {
  return {
    id: 'annual',
    kinds: ['annual.input'],
    async list({ tx, companyId, today }, page) {
      const found = (await source(tx, companyId, today))
        .sort((a, b) => a.subjectId.localeCompare(b.subjectId))
        .filter((item) =>
          page.only !== undefined
            ? item.subjectId === page.only
            : page.after === null || item.subjectId > page.after,
        );
      const items = found.slice(0, page.limit).map((item): Draft => ({
        kind: 'annual.input',
        subject: { kind: 'annual', id: item.subjectId },
        severity: item.severity,
        due: null,
        period: String(item.year),
        message: item.message,
        ...(item.causes ? { causes: item.causes } : {}),
        details: item.details,
        ...(item.labels ? { labels: item.labels } : {}),
        next:
          item.kind === 'halfyear'
            ? []
            : [
                agent('annual.ask', { kind: item.kind, year: item.year }),
                human('questions.answer'),
              ],
        cursor: item.subjectId,
      }));
      return { items, next: found.length > page.limit ? items.at(-1)!.cursor : null };
    },
  };
}

// The tax account: the statement of the account differing from the books, payments not yet
// distributed while obligations are due, a filed D100 to correct (core ro/taxaccount/agent.ts).

/** An item of the tax account module, as the worklist reads it. */
export type TaxAccountWorkItem = {
  kind: 'taxaccount.differs' | 'taxaccount.undistributed' | 'taxaccount.correction';
  subject: { kind: string; id: string };
  severity: 'block' | 'warn';
  period: string;
  message: string;
  causes?: WorkCause[];
  details: { [key: string]: JsonValue };
  labels?: DetailLabels;
  next: WorkStep[];
};
export type TaxAccountWorkOf = (
  tx: Transaction,
  companyId: string,
  today: LocalDate,
) => Promise<TaxAccountWorkItem[]>;

function taxAccountDetector(source: TaxAccountWorkOf): Detector {
  const cursorOf = (item: TaxAccountWorkItem) =>
    `${item.kind}|${item.subject.kind}:${item.subject.id}`;
  return {
    id: 'taxaccount',
    kinds: ['taxaccount.differs', 'taxaccount.undistributed', 'taxaccount.correction'],
    async list({ tx, companyId, today }, page) {
      const found = (await source(tx, companyId, today))
        .sort((a, b) => cursorOf(a).localeCompare(cursorOf(b)))
        .filter((item) =>
          page.only !== undefined
            ? item.subject.id === page.only
            : page.after === null || cursorOf(item) > page.after,
        );
      const items = found.slice(0, page.limit).map((item): Draft => ({
        kind: item.kind,
        subject: item.subject,
        severity: item.severity,
        due: null,
        period: item.period,
        message: item.message,
        ...(item.causes ? { causes: item.causes } : {}),
        details: item.details,
        ...(item.labels ? { labels: item.labels } : {}),
        next: item.next,
        cursor: cursorOf(item),
      }));
      return { items, next: found.length > page.limit ? items.at(-1)!.cursor : null };
    },
  };
}

// The pro-rata and the capital goods' adjustments: a mixed year without its provisional
// pro-rata or its year-end adjustment, a capital good whose changed use waits for the year's
// adjustment (core ro/exempt/agent.ts).

/** An item of the exempt supplies' module, as the worklist reads it. */
export type VatAdjustmentWorkItem = {
  kind: 'vat.prorata' | 'vat.capitalGoods';
  subject: { kind: string; id: string };
  severity: 'block' | 'warn';
  period: string;
  message: string;
  causes?: WorkCause[];
  details: { [key: string]: JsonValue };
  labels?: DetailLabels;
  next: WorkStep[];
};
export type VatAdjustmentWorkOf = (
  tx: Transaction,
  companyId: string,
  today: LocalDate,
) => Promise<VatAdjustmentWorkItem[]>;

function vatAdjustmentDetector(source: VatAdjustmentWorkOf): Detector {
  const cursorOf = (item: VatAdjustmentWorkItem) =>
    `${item.kind}|${item.subject.kind}:${item.subject.id}`;
  return {
    id: 'vatAdjustments',
    kinds: ['vat.prorata', 'vat.capitalGoods'],
    async list({ tx, companyId, today }, page) {
      const found = (await source(tx, companyId, today))
        .sort((a, b) => cursorOf(a).localeCompare(cursorOf(b)))
        .filter((item) =>
          page.only !== undefined
            ? item.subject.id === page.only
            : page.after === null || cursorOf(item) > page.after,
        );
      const items = found.slice(0, page.limit).map((item): Draft => ({
        kind: item.kind,
        subject: item.subject,
        severity: item.severity,
        due: null,
        period: item.period,
        message: item.message,
        ...(item.causes ? { causes: item.causes } : {}),
        details: item.details,
        ...(item.labels ? { labels: item.labels } : {}),
        next: item.next,
        cursor: cursorOf(item),
      }));
      return { items, next: found.length > page.limit ? items.at(-1)!.cursor : null };
    },
  };
}

// The special VAT schemes: a travel agency's sales under the margin scheme that no computation
// of a period's margin counted (core ro/schemes/agent.ts).

/** An item of the special schemes' module, as the worklist reads it. */
export type SchemeWorkItem = {
  kind: 'margin.travel';
  subject: { kind: string; id: string };
  severity: 'block' | 'warn';
  period: string;
  message: string;
  causes?: WorkCause[];
  details: { [key: string]: JsonValue };
  labels?: DetailLabels;
  next: WorkStep[];
};
export type SchemeWorkOf = (
  tx: Transaction,
  companyId: string,
  today: LocalDate,
) => Promise<SchemeWorkItem[]>;

function schemeDetector(source: SchemeWorkOf): Detector {
  const cursorOf = (item: SchemeWorkItem) => `${item.kind}|${item.subject.kind}:${item.subject.id}`;
  return {
    id: 'schemes',
    kinds: ['margin.travel'],
    async list({ tx, companyId, today }, page) {
      const found = (await source(tx, companyId, today))
        .sort((a, b) => cursorOf(a).localeCompare(cursorOf(b)))
        .filter((item) =>
          page.only !== undefined
            ? item.subject.id === page.only
            : page.after === null || cursorOf(item) > page.after,
        );
      const items = found.slice(0, page.limit).map((item): Draft => ({
        kind: item.kind,
        subject: item.subject,
        severity: item.severity,
        due: null,
        period: item.period,
        message: item.message,
        ...(item.causes ? { causes: item.causes } : {}),
        details: item.details,
        ...(item.labels ? { labels: item.labels } : {}),
        next: item.next,
        cursor: cursorOf(item),
      }));
      return { items, next: found.length > page.limit ? items.at(-1)!.cursor : null };
    },
  };
}

// The year-end in full: the annual inventory and its differences, the impairments, the
// provisions, the cut-off, the result, the year close and the next year's opening (core
// ro/yearend/agent.ts).

/** An item of the year-end module, as the worklist reads it. */
export type YearEndWorkItem = {
  subject: { kind: string; id: string };
  severity: 'block' | 'warn';
  period: string;
  message: string;
  causes?: WorkCause[];
  details: { [key: string]: JsonValue };
  labels?: DetailLabels;
  next: WorkStep[];
  withheld?: Withheld;
};
export type YearEndWorkOf = (
  tx: Transaction,
  companyId: string,
  today: LocalDate,
) => Promise<YearEndWorkItem[]>;

function yearEndDetector(source: YearEndWorkOf): Detector {
  const cursorOf = (item: YearEndWorkItem) => `${item.subject.kind}:${item.subject.id}`;
  return {
    id: 'yearend',
    kinds: ['yearend.review'],
    async list({ tx, companyId, today }, page) {
      const found = (await source(tx, companyId, today))
        .sort((a, b) => cursorOf(a).localeCompare(cursorOf(b)))
        .filter((item) =>
          page.only !== undefined
            ? item.subject.id === page.only
            : page.after === null || cursorOf(item) > page.after,
        );
      const items = found.slice(0, page.limit).map((item): Draft => ({
        kind: 'yearend.review',
        subject: item.subject,
        severity: item.severity,
        due: null,
        period: item.period,
        message: item.message,
        ...(item.causes ? { causes: item.causes } : {}),
        details: item.details,
        ...(item.labels ? { labels: item.labels } : {}),
        next: item.next,
        cursor: cursorOf(item),
        ...(item.withheld ? { withheld: item.withheld } : {}),
      }));
      return { items, next: found.length > page.limit ? items.at(-1)!.cursor : null };
    },
  };
}

// Payroll's external obligations and follow-ups: REGES-ONLINE transmissions, a rectifying D112
// after a correction (core ro/payroll/agent.ts).

/** An item of the payroll module, as the worklist reads it. */
export type PayrollWorkOf = YearEndWorkOf;

function payrollDetector(source: PayrollWorkOf): Detector {
  const cursorOf = (item: YearEndWorkItem) => `${item.subject.kind}:${item.subject.id}`;
  return {
    id: 'payroll',
    kinds: ['payroll.due'],
    async list({ tx, companyId, today }, page) {
      const found = (await source(tx, companyId, today))
        .sort((a, b) => cursorOf(a).localeCompare(cursorOf(b)))
        .filter((item) =>
          page.only !== undefined
            ? item.subject.id === page.only
            : page.after === null || cursorOf(item) > page.after,
        );
      const items = found.slice(0, page.limit).map((item): Draft => ({
        kind: 'payroll.due',
        subject: item.subject,
        severity: item.severity,
        due: null,
        period: item.period,
        message: item.message,
        ...(item.causes ? { causes: item.causes } : {}),
        details: item.details,
        ...(item.labels ? { labels: item.labels } : {}),
        next: item.next,
        cursor: cursorOf(item),
      }));
      return { items, next: found.length > page.limit ? items.at(-1)!.cursor : null };
    },
  };
}

// Month-close checks of the months that ended and are not closed.

/** What to do about a close finding, by its code. */
const findingSteps: Record<string, (month: Month) => WorkStep[]> = {
  UNEXPLAINED_MOVEMENTS: () => [propose('bank.settle')],
  TAX_STATEMENT_DIFFERS: () => [agent('taxaccount.reconcile')],
  YEAR_END_REVIEW: () => [agent('work.list', { kinds: ['yearend.review'] })],
  STATEMENT_GAP: () => [
    agent('bank.import'),
    agent('bank.importCsv'),
    agent('bank.recordStatement'),
  ],
  STATEMENT_CHAIN: () => [agent('bank.import'), agent('bank.importCsv')],
  BANK_BALANCE: () => [agent('bank.import'), agent('bank.importCsv')],
  FX_NOT_REVALUED: (month) => [propose('fx.revalue', { date: monthEnd(month) })],
  DEFERRAL_DUE: (month) => [propose('deferrals.release', { month })],
  SPV_COVERAGE_GAP: () => [agent('spv.sync')],
  SPV_PENDING: () => [agent('spv.refresh')],
  SUPPLIER_STATUS_UNCHECKED: (month) => [agent('parties.checkStatus', { month })],
  LOAN_INTEREST_DUE: () => [propose('loans.accrue')],
  // Production (G4, core ro/production/agent.ts): the month's first and last steps.
  PRODUCTION_WIP_REVERSAL_MISSING: (month) => [propose('production.wipReverse', { month })],
  PRODUCTION_COST_MISSING: (month) => [propose('production.cost', { month })],
  PRODUCTION_DIFFERENCES_MISSING: (month) => [propose('production.differences', { month })],
};

function closeDetector(checks: () => CloseCheck[]): Detector {
  /** The months from the first with entries that ended before the current one and are not
   * closed, after the latest closed month: a close covers every earlier month, so nothing is
   * booked there. The month in progress is checked once it ends, as only then can it close: its
   * findings (a deferral or the interest to book at its end, its production costing) are not
   * work yet. */
  async function openMonths(tx: Transaction, companyId: string, current: Month) {
    const [first] = await tx
      .select({ month: sql<string | null>`min(${entries.period})` })
      .from(entries)
      .where(eq(entries.companyId, companyId));
    if (!first?.month || first.month >= current) return [];
    const latest = (await closedMonths(tx, companyId)).at(-1)?.month ?? '';
    const months: Month[] = [];
    for (let month = first.month as Month; month < current; month = addMonths(month, 1))
      if (month > latest) months.push(month);
    return months;
  }
  /** Whether a close of the month is requested or approved and not yet executed. */
  async function closePending(tx: Transaction, companyId: string, month: string) {
    const [row] = await tx
      .select({ id: actionRequests.id })
      .from(actionRequests)
      .leftJoin(
        actionDecisions,
        and(
          eq(actionDecisions.companyId, actionRequests.companyId),
          eq(actionDecisions.requestId, actionRequests.id),
        ),
      )
      .where(
        and(
          eq(actionRequests.companyId, companyId),
          eq(actionRequests.operation, 'periods.close'),
          eq(actionRequests.input, canonical({ month })),
          sql`(${q(actionDecisions.decision)} is null or ${q(actionDecisions.decision)} = 'approve')`,
          sql`not exists (select 1 from ${actionExecutions} x
            where x.company_id = ${q(actionRequests.companyId)} and x.request_id = ${q(actionRequests.id)})`,
        ),
      )
      .limit(1);
    return !!row;
  }
  return {
    id: 'close',
    kinds: ['close.finding', 'period.unclosed'],
    async list({ tx, companyId, today }, page) {
      const current = today.slice(0, 7) as Month;
      const months = await openMonths(tx, companyId, current);
      const [afterMonth, afterIndex] = (page.after ?? '').split('#');
      const only = page.only?.slice(0, 7);
      const remaining = months.filter((month) =>
        only !== undefined
          ? month === only
          : !afterMonth || month > afterMonth || (month === afterMonth && afterIndex !== '*'),
      );
      const month = remaining[0];
      if (!month) return { items: [], next: null };
      // One month per call: its checks are the costliest reads of the worklist.
      const found = (
        await Promise.all(
          checks().map(async (check) =>
            (await check.run(tx, companyId, month)).map((finding) => ({
              check: check.id,
              finding,
            })),
          ),
        )
      ).flat();
      const seen = new Map<string, number>();
      const items: Draft[] = found.map(({ check, finding }, index) => {
        const base = `${month}/${check}/${finding.code}`;
        const repeat = seen.get(base) ?? 0;
        seen.set(base, repeat + 1);
        return {
          kind: 'close.finding',
          subject: { kind: 'finding', id: repeat ? `${base}/${repeat}` : base },
          severity: finding.severity,
          due: null,
          period: month,
          message: cleanIdentifierText(finding.message),
          details: {
            month,
            check,
            code: finding.code,
            ...(finding.count === undefined ? {} : { count: finding.count }),
            ...(finding.items ? { items: finding.items.slice(0, 20) } : {}),
          },
          labels: {
            month: periodLabel('Lună'),
            check: textLabel('Verificare'),
            code: textLabel('Cod'),
            ...(finding.count === undefined ? {} : { count: countLabel('Număr') }),
            ...(finding.items ? { items: textLabel('Elemente') } : {}),
          },
          next: [
            ...(findingSteps[finding.code]?.(month) ?? []),
            ...(finding.severity === 'warn' ? [dispose('human', 'dealt_with')] : []),
          ],
          cursor: `${month}#${index}`,
        };
      });
      // The next month to close, unless its close is already requested.
      if (month === months[0] && !(await closePending(tx, companyId, month))) {
        const blocking = found.filter(({ finding }) => finding.severity === 'block').length;
        items.push({
          kind: 'period.unclosed',
          subject: { kind: 'month', id: month },
          severity: 'warn',
          due: null,
          period: month,
          message: blocking
            ? `Luna ${periodName(month)} s-a încheiat și nu este închisă: rezolvați întâi cele ${blocking} probleme care împiedică închiderea.`
            : `Luna ${periodName(month)} s-a încheiat și nu este închisă: cereți închiderea ei.`,
          details: { month, blocking },
          labels: { month: periodLabel('Lună'), blocking: countLabel('Blocaje') },
          next: blocking ? [] : [agent('periods.close.request', { month })],
          cursor: `${month}#${found.length}`,
        });
      }
      const skip = month === afterMonth && afterIndex !== '*' ? Number(afterIndex) : -1;
      return {
        items: items.filter((item) => Number(item.cursor.split('#')[1]) > skip),
        next: only !== undefined || remaining.length === 1 ? null : `${month}#*`,
      };
    },
  };
}

// Rules: proposals blocked by a missing rule, by parameter; parameters in use expiring soon.

function rulesDetector(register: ParameterRegister): Detector {
  return {
    id: 'rules',
    kinds: ['rule.gap', 'rule.expiring'],
    async list({ tx, companyId, today }, page) {
      const blocked = await tx
        .select({ id: proposals.id, issues: proposalVersions.issues })
        .from(proposals)
        .innerJoin(
          proposalVersions,
          and(
            eq(proposalVersions.companyId, proposals.companyId),
            eq(proposalVersions.proposalId, proposals.id),
            eq(proposalVersions.version, latestVersion),
          ),
        )
        .where(
          and(
            eq(proposals.companyId, companyId),
            eq(proposalVersions.blocking, true),
            sql`instr(${q(proposalVersions.issues)}, '"RULE_GAP"') > 0`,
            notPosted,
            notWithdrawn,
          ),
        )
        .orderBy(asc(proposals.id));
      const gaps = new Map<
        string,
        { reasons: Set<string>; dates: string[]; proposals: string[] }
      >();
      for (const row of blocked)
        for (const issue of JSON.parse(row.issues) as Issue[]) {
          if (issue.code !== 'RULE_GAP') continue;
          const gap = (issue.details ?? {}) as { key?: string; reason?: string; date?: string };
          const key = gap.key ?? 'unknown';
          const group = gaps.get(key) ?? { reasons: new Set(), dates: [], proposals: [] };
          if (gap.reason) group.reasons.add(gap.reason);
          if (gap.date) group.dates.push(gap.date);
          if (!group.proposals.includes(row.id)) group.proposals.push(row.id);
          gaps.set(key, group);
        }
      // Parameters the company's proposals used in the last twelve months of the engine's time,
      // reviewed only until a day within the next sixty.
      const since = Date.parse(`${addDays(today, -365)}T00:00:00.000Z`);
      const used = new Set(
        (
          await tx
            .select({ id: sql<string>`json_extract(u.value, '$.id')` })
            .from(sql`${proposalVersions} v, json_each(v.rules_json, '$.used') u`)
            .where(sql`v.company_id = ${companyId} and v.engine_at >= ${since}`)
            .groupBy(sql`json_extract(u.value, '$.id')`)
        ).map((row) => row.id),
      );
      const expiring = register
        .horizon(addDays(today, 60))
        .filter((version) => used.has(version.id));
      const items: Draft[] = [
        ...[...gaps].map(([key, group]): Draft => {
          const dates = group.dates.sort();
          const reasons = [...group.reasons].sort();
          const label = parameterName(key, register);
          const causes = dedupeCauses(
            (reasons.length ? reasons : ['NOT_FOUND']).map((reason) =>
              causeFromRule(
                key,
                reason,
                `Lipsește o regulă verificată pentru ${label} (${ruleGapReasonName(reason)}).`,
              ),
            ),
          );
          return {
            kind: 'rule.gap',
            subject: { kind: 'parameter', id: key },
            severity: 'block',
            due: null,
            period: null,
            message: `Lipsește o regulă verificată pentru ${label} (${(reasons.length ? reasons : ['NOT_FOUND']).map(ruleGapReasonName).join(', ')}): ${group.proposals.length} propuneri sunt blocate până o aprobă expertul contabil.`,
            causes,
            details: {
              key,
              reasons,
              from: dates[0] ?? null,
              to: dates.at(-1) ?? null,
              count: group.proposals.length,
              proposals: group.proposals.slice(0, 20),
            },
            labels: {
              key: textLabel('Parametru'),
              reasons: textLabel('Motive'),
              from: dateLabel('De la'),
              to: dateLabel('Până la'),
              count: countLabel('Număr'),
              proposals: textLabel('Propuneri'),
            },
            next: [],
            cursor: `rule.gap|${key}`,
          };
        }),
        ...expiring.map((version): Draft => ({
          kind: 'rule.expiring',
          subject: { kind: 'parameter', id: version.id },
          severity: 'warn',
          due: version.reviewedThrough,
          period: null,
          message: `Parametrul „${parameterName(version.key, register)}” este verificat doar până la ${version.reviewedThrough}: o versiune verificată pentru perioada următoare trebuie aprobată.`,
          details: {
            key: version.key,
            versionId: version.id,
            scope: version.scope as JsonValue,
            reviewedThrough: version.reviewedThrough,
          },
          labels: {
            key: textLabel('Parametru'),
            versionId: idLabel('Versiune parametru', 'parameterVersion'),
            scope: textLabel('Domeniu'),
            reviewedThrough: dateLabel('Verificat până la'),
          },
          next: [],
          cursor: `rule.expiring|${version.id}`,
        })),
      ]
        .filter((item) =>
          page.only !== undefined
            ? item.subject.id === page.only
            : page.after === null || item.cursor > page.after,
        )
        .sort((a, b) => (a.cursor < b.cursor ? -1 : 1));
      const chosen = items.slice(0, page.limit);
      return { items: chosen, next: items.length > page.limit ? chosen.at(-1)!.cursor : null };
    },
  };
}

// Documents nobody booked, booked from a lesser copy, or whose copies disagree.

/** The root of a document's group: the document it joined, or itself. */
const rootOf = (document: Column) => sql`coalesce((
  select l.to_id from ${documentLinks} l
  where l.company_id = ${q(documents.companyId)} and l.from_id = ${q(document)} and l.kind in ${groupKinds}), ${q(document)})`;

const documentsDetector: Detector = {
  id: 'documents',
  kinds: ['document.unproposed'],
  async list({ tx, companyId }, page) {
    const rows = await tx
      .select({
        id: documents.id,
        kind: documents.kind,
        number: documents.number,
        date: documents.docDate,
        partyId: documents.partyId,
        country: parties.country,
        currency: documents.currency,
        body: documents.body,
        authority: documents.authority,
        evidenceId: documents.evidenceId,
        members: sql<string | null>`(select group_concat(m.from_id) from ${documentLinks} m
          where m.company_id = ${q(documents.companyId)} and m.to_id = ${q(documents.id)}
            and m.kind in ${groupKinds})`,
      })
      .from(documents)
      .leftJoin(
        parties,
        and(eq(parties.companyId, documents.companyId), eq(parties.id, documents.partyId)),
      )
      .where(
        and(
          eq(documents.companyId, companyId),
          position(documents.id, page),
          // Contracts, statements of the tax account and inventory lists book nothing; customs
          // declarations and VIES answers are read by the booking of their invoice (G3).
          sql`${q(documents.kind)} not in ('contract', 'tax.statement', 'inventory.list', 'customs.declaration', 'vies.check')`,
          // Once per group: its root stands for it.
          sql`not exists (select 1 from ${documentLinks} g
            where g.company_id = ${q(documents.companyId)} and g.from_id = ${q(documents.id)}
              and g.kind in ${groupKinds})`,
          // A corrected extraction stands for the one it superseded, outside a group.
          sql`not (exists (select 1 from ${documentLinks} s
              where s.company_id = ${q(documents.companyId)} and s.to_id = ${q(documents.id)}
                and s.kind = 'supersedes')
            and not exists (select 1 from ${documentLinks} m
              where m.company_id = ${q(documents.companyId)} and m.to_id = ${q(documents.id)}
                and m.kind in ${groupKinds}))`,
          // No held document subject or standing opening carries the group's balance.
          sql`not ${documentBooked(q(documents.companyId), q(documents.id))}`,
        ),
      )
      .orderBy(asc(documents.id))
      .limit(page.limit + 1);
    const { page: chosen, next } = paged(rows, page.limit, (row) => row.id);
    return {
      items: chosen.map((row): Draft => {
        const receipt = row.kind === 'receipt.received';
        const credit = row.kind.startsWith('creditNote.');
        const foreign = row.country !== null && row.country !== 'RO';
        // An invoice in category AE: the domestic reverse charge (art. 331).
        const reverse =
          !receipt &&
          !foreign &&
          (JSON.parse(row.body) as { taxes?: { category?: string }[] }).taxes?.some(
            (tax) => tax.category === 'AE',
          ) === true;
        // An invoice whose exemption reason states «regimul marjei» (V4): its scheme.
        const margin =
          (row.kind === 'invoice.issued' || row.kind === 'invoice.received') && !foreign
            ? mentionedScheme(
                JSON.parse(row.body) as { taxes?: { exemptionReason: string | null }[] },
              )
            : null;
        // An issued invoice to a customer in another Member State without a VAT code of its state:
        // a sale to a consumer, below or above the threshold of art. 278^1 (core ro/oss).
        const customer = (JSON.parse(row.body) as { customer?: { taxId?: string } }).customer;
        const state = foreign ? euVatPrefixes[row.country!] : undefined;
        const euConsumer =
          (row.kind === 'invoice.issued' || row.kind === 'creditNote.issued') &&
          state !== undefined &&
          !(
            (customer?.taxId ?? '').toUpperCase().startsWith(state) &&
            /\d/.test((customer?.taxId ?? '').slice(2))
          );
        const marginStep = (scheme: NonNullable<typeof margin>) =>
          propose(row.kind === 'invoice.issued' ? 'margin.sale' : 'margin.purchase', {
            documentId: row.id,
            scheme: scheme === 'travel' ? 'travel' : 'goods',
            ...(scheme !== 'travel' && row.kind !== 'invoice.issued' ? { goods: scheme } : {}),
          });
        // Goods across the border (G3): an issued invoice in K is an intra-community supply, one
        // in G an export; a received one in K from another Member State an intra-community
        // acquisition; one from outside the Union an import, unless it is services.
        const categories = new Set(
          ((JSON.parse(row.body) as { taxes?: { category?: string }[] }).taxes ?? []).map(
            (tax) => tax.category,
          ),
        );
        const goods =
          credit || receipt
            ? null
            : row.kind === 'invoice.issued' && categories.has('K')
              ? 'goods.euSupply'
              : row.kind === 'invoice.issued' && categories.has('G') && foreign && !state
                ? 'goods.export'
                : row.kind === 'invoice.received' && categories.has('K') && state
                  ? 'goods.euAcquisition'
                  : null;
        const steps: WorkStep[] = receipt
          ? [propose('receipts.recognize', { documentId: row.id })]
          : row.kind === 'zreport'
            ? [propose('retail.zReport', { documentId: row.id })]
            : goods
              ? [propose(goods, { documentId: row.id })]
              : margin
                ? [marginStep(margin)]
                : euConsumer
                  ? [propose('invoices.euConsumer', { documentId: row.id })]
                  : reverse && !credit
                    ? [propose('invoices.reverseCharge', { documentId: row.id })]
                    : row.kind === 'tax.decision'
                      ? [propose('tax.decision', { documentId: row.id })]
                      : credit
                        ? [propose('invoices.credit', { documentId: row.id })]
                        : foreign
                          ? [
                              propose('invoices.crossBorder', { documentId: row.id }),
                              ...(row.kind === 'invoice.received' && !state
                                ? [propose('goods.import', { documentId: row.id })]
                                : []),
                              propose('invoices.recognize', { documentId: row.id }),
                            ]
                          : [propose('invoices.recognize', { documentId: row.id })];
        return {
          kind: 'document.unproposed',
          subject: { kind: 'document', id: row.id },
          severity: 'warn',
          due: null,
          period: monthOf(row.date),
          message: receipt
            ? `Bonul fiscal ${row.number ?? row.id} din ${row.date} nu este înregistrat.`
            : `Documentul (${documentKindName(row.kind)}) ${row.number ?? row.id} din ${row.date} nu are o propunere de înregistrare.`,
          details: {
            kind: row.kind,
            number: row.number,
            date: row.date,
            partyId: row.partyId,
            currency: row.currency,
            totals: documentTotals(JSON.parse(row.body)),
            authority: row.authority,
            evidenceId: row.evidenceId,
            members: row.members ? row.members.split(',').sort() : [],
          },
          labels: {
            kind: textLabel('Tip'),
            number: textLabel('Număr'),
            date: dateLabel('Dată'),
            partyId: idLabel('Partener', 'party'),
            currency: textLabel('Monedă'),
            totals: textLabel('Totaluri'),
            authority: textLabel('Sursă'),
            evidenceId: idLabel('Document justificativ', 'evidence'),
            members: textLabel('Copii ale documentului'),
          },
          next: [...steps, dispose('human', 'no_booking')],
          cursor: row.id,
        };
      }),
      next,
    };
  },
};

function betterSourceDetector(treatments?: () => readonly Treatment[]): Detector {
  const byId = () => new Map((treatments?.() ?? []).map((item) => [item.id, item]));
  return {
    id: 'betterSource',
    kinds: ['document.betterSource'],
    async list({ tx, companyId }, page) {
      // The document the current version reads: its input's, as a revision may move it.
      const root = rootOf(documents.id);
      const rows = await tx
        .select({
          id: proposals.id,
          treatment: proposals.treatmentId,
          documentId: documents.id,
          number: documents.number,
          authority: documents.authority,
          version: proposalVersions.version,
          input: proposalVersions.input,
          entryDate: proposalVersions.entryDate,
          better: sql<string | null>`(select e.id from ${documents} e
          where e.company_id = ${q(proposals.companyId)} and e.authority = 'efactura' and e.id <> ${q(documents.id)}
            and (e.id = ${root} or exists (select 1 from ${documentLinks} b
              where b.company_id = e.company_id and b.from_id = e.id and b.to_id = ${root}
                and b.kind in ${groupKinds}))
          order by e.id limit 1)`,
        })
        .from(proposals)
        .innerJoin(
          proposalVersions,
          and(
            eq(proposalVersions.companyId, proposals.companyId),
            eq(proposalVersions.proposalId, proposals.id),
            eq(proposalVersions.version, latestVersion),
          ),
        )
        .innerJoin(
          documents,
          and(
            eq(documents.companyId, proposals.companyId),
            eq(documents.id, sql`${q(proposalVersions.input)} ->> '$.documentId'`),
          ),
        )
        .where(
          and(
            eq(proposals.companyId, companyId),
            position(proposals.id, page),
            sql`${q(documents.authority)} not in ('efactura', 'issued')`,
            notPosted,
            notWithdrawn,
          ),
        )
        .orderBy(asc(proposals.id))
        .limit(page.limit + 1);
      const { page: chosen, next } = paged(rows, page.limit, (row) => row.id);
      const treatmentMap = byId();
      return {
        items: chosen
          .filter((row) => row.better)
          .map((row): Draft => ({
            kind: 'document.betterSource',
            subject: { kind: 'proposal', id: row.id },
            severity: 'warn',
            due: null,
            period: monthOf(row.entryDate),
            message: `Propunerea ${treatmentName(row.treatment, treatmentMap)} citește documentul ${row.number ?? row.documentId} (${authorityName(row.authority ?? '')}), care există și din e-Factura: revizuiți-o pe documentul e-Factura.`,
            details: {
              treatment: row.treatment,
              version: row.version,
              documentId: row.documentId,
              authority: row.authority,
              better: row.better,
            },
            labels: {
              treatment: textLabel('Tratament'),
              version: countLabel('Versiune'),
              documentId: idLabel('Document', 'document'),
              authority: textLabel('Sursă'),
              better: idLabel('Document e-Factura', 'document'),
            },
            next: [
              agent('proposals.revise', {
                proposalId: row.id,
                version: row.version,
                input: { ...(JSON.parse(row.input) as object), documentId: row.better },
              }),
            ],
            cursor: row.id,
          })),
        next,
      };
    },
  };
}

/** The fields every copy of a document should agree on. */
function comparable(row: {
  partyId: string | null;
  currency: string | null;
  docDate: string;
  number: string | null;
  body: string;
}) {
  const totals = documentTotals(JSON.parse(row.body));
  return {
    partyId: row.partyId,
    currency: row.currency,
    date: row.docDate,
    number: row.number ? normalizedNumber(row.number) : null,
    net: totals?.net ?? null,
    tax: totals?.tax ?? null,
    gross: totals?.gross ?? null,
  };
}

const originsDetector: Detector = {
  id: 'origins',
  kinds: ['document.originsDiffer'],
  async list({ tx, companyId }, page) {
    const roots = await tx
      .selectDistinct({ id: documentLinks.toId })
      .from(documentLinks)
      .where(
        and(
          eq(documentLinks.companyId, companyId),
          inArray(documentLinks.kind, [...groupLinkKinds]),
          position(documentLinks.toId, page),
        ),
      )
      .orderBy(asc(documentLinks.toId))
      .limit(page.limit + 1);
    const { page: chosen, next } = paged(roots, page.limit, (row) => row.id);
    if (!chosen.length) return { items: [], next };
    const rootIds = chosen.map((row) => row.id);
    const links = await tx
      .select({ fromId: documentLinks.fromId, toId: documentLinks.toId })
      .from(documentLinks)
      .where(
        and(
          eq(documentLinks.companyId, companyId),
          inArray(documentLinks.kind, [...groupLinkKinds]),
          inArray(documentLinks.toId, rootIds),
        ),
      );
    const memberIds = [...new Set([...rootIds, ...links.map((link) => link.fromId)])];
    const rows = await tx
      .select({
        id: documents.id,
        authority: documents.authority,
        kind: documents.kind,
        partyId: documents.partyId,
        currency: documents.currency,
        docDate: documents.docDate,
        number: documents.number,
        body: documents.body,
        superseded: sql<number>`exists (select 1 from ${documentLinks} s
          where s.company_id = ${q(documents.companyId)} and s.to_id = ${q(documents.id)}
            and s.kind = 'supersedes')`.mapWith(Number),
      })
      .from(documents)
      .where(and(eq(documents.companyId, companyId), inArray(documents.id, memberIds)));
    const byId = new Map(rows.map((row) => [row.id, row]));
    const items: Draft[] = [];
    for (const rootId of rootIds) {
      const members = [
        rootId,
        ...links.filter((link) => link.toId === rootId).map((link) => link.fromId),
      ]
        .map((id) => byId.get(id)!)
        .filter((row) => row && !row.superseded)
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      if (members.length < 2) continue;
      const fields = members.map((row) => ({ row, fields: comparable(row) }));
      const differences = (
        Object.keys(fields[0]!.fields) as (keyof ReturnType<typeof comparable>)[]
      )
        .filter((field) => new Set(fields.map((item) => item.fields[field])).size > 1)
        .map((field) => ({
          field,
          values: fields.map((item) => ({
            documentId: item.row.id,
            authority: item.row.authority,
            value: item.fields[field],
          })),
        }));
      if (!differences.length) continue;
      const extracted = members.filter((row) => row.authority === 'extracted');
      items.push({
        kind: 'document.originsDiffer',
        subject: { kind: 'document', id: rootId },
        severity: 'warn',
        due: null,
        period: monthOf(byId.get(rootId)?.docDate),
        message: `Copiile documentului ${byId.get(rootId)?.number ?? rootId} diferă (${differences.map((item) => comparableFieldName(item.field)).join(', ')}): verificați extragerea față de original.`,
        details: { rootId, differences },
        labels: {
          rootId: idLabel('Document principal', 'document'),
          differences: textLabel('Diferențe'),
        },
        next: [
          ...extracted.map((row) => agent('documents.supersede', { documentId: row.id })),
          dispose('human', 'dealt_with'),
        ],
        cursor: rootId,
      });
    }
    return { items, next };
  },
};

// Bank movements nobody explained.

/** A movement's state: settled by a posted entry that stands, approved or proposed for one, or
 * unexplained (a reversal of its settlement makes it unexplained again). */
export const movementState = sql<string>`case
  when exists (select 1 from ${proposals} p join ${entries} e on e.company_id = p.company_id and e.proposal_id = p.id
    where p.company_id = ${q(bankMovements.companyId)} and p.subject_key = 'movement:' || ${q(bankMovements.id)}
      and ${entryStands('e')}) then 'settled'
  when exists (select 1 from ${proposals} p
    join ${approvals} a on a.company_id = p.company_id and a.proposal_id = p.id
    where p.company_id = ${q(bankMovements.companyId)} and p.subject_key = 'movement:' || ${q(bankMovements.id)}
      and not exists (select 1 from ${withdrawals} w where w.company_id = p.company_id and w.proposal_id = p.id)
      and not exists (select 1 from ${entries} e where e.company_id = p.company_id and e.proposal_id = p.id)
      and a.version = (select max(v.version) from ${proposalVersions} v
        where v.company_id = p.company_id and v.proposal_id = p.id)) then 'approved'
  when exists (select 1 from ${proposals} p
    where p.company_id = ${q(bankMovements.companyId)} and p.subject_key = 'movement:' || ${q(bankMovements.id)}
      and not exists (select 1 from ${withdrawals} w where w.company_id = p.company_id and w.proposal_id = p.id)
      and not exists (select 1 from ${entries} e where e.company_id = p.company_id and e.proposal_id = p.id)) then 'proposed'
  else 'unexplained' end`;

const bankDetector: Detector = {
  id: 'bank',
  kinds: ['bank.unexplained'],
  async list({ tx, companyId }, page) {
    const rows = await tx
      .select()
      .from(bankMovements)
      .where(
        and(
          eq(bankMovements.companyId, companyId),
          position(bankMovements.id, page),
          sql`not exists (select 1 from ${proposals} p
            where p.company_id = ${q(bankMovements.companyId)} and p.subject_key = 'movement:' || ${q(bankMovements.id)}
              and ${holdsSubject('p')})`,
        ),
      )
      .orderBy(asc(bankMovements.id))
      .limit(page.limit + 1);
    const { page: chosen, next } = paged(rows, page.limit, (row) => row.id);
    // A payment of pay (`salaryMovements`) is explained by someone who may read it: a caller who
    // may not reads it as salaries, without the person, the reference and one person's amount,
    // and may not take its step (`needs`), so that it waits on a person.
    const salaries = await salaryMovements(tx, companyId, chosen);
    return {
      items: chosen.map((row): Draft => {
        const salary = salaries.get(row.id);
        const details = {
          treasuryAccountId: row.treasuryAccountId,
          bookingDate: row.bookingDate,
          amountMinor: String(row.amountMinor),
          currency: row.currency,
          reference: row.reference,
          counterparty: row.counterparty,
        };
        const settle = propose('bank.settle', { movementId: row.id });
        return {
          kind: 'bank.unexplained',
          subject: { kind: 'movement', id: row.id },
          severity: 'warn',
          due: null,
          period: monthOf(row.bookingDate),
          message: `Mișcarea bancară din ${row.bookingDate} (${row.reference}) nu este explicată.`,
          details,
          labels: {
            treasuryAccountId: idLabel('Cont de trezorerie', 'treasuryAccount'),
            bookingDate: dateLabel('Data operațiunii'),
            amountMinor: minorLabel('Sumă', { currencyKey: 'currency' }),
            currency: textLabel('Monedă'),
            reference: textLabel('Referință'),
            counterparty: textLabel('Partener'),
          },
          // A transfer to the State Treasury (an IBAN of bank code TREZ) pays the state: the tax
          // account distributes it (tax.pay).
          next: [
            ...(row.counterpartyAccount?.toUpperCase().slice(4, 8) === 'TREZ'
              ? [propose('tax.pay', { movementId: row.id })]
              : []),
            salary ? { ...settle, needs: payClasses } : settle,
          ],
          cursor: row.id,
          ...(salary
            ? {
                withheld: {
                  classes: payClasses,
                  message: `${salaryPayment} din ${row.bookingDate} nu este explicată: o explică cine poate citi datele salariale (un proprietar, un revizor sau un agent a cărui permisiune acoperă datele salariale și de personal).`,
                  details: {
                    ...details,
                    amountMinor: salary.persons > 1 ? details.amountMinor : null,
                    reference: null,
                    counterparty: salaryPayment,
                    redacted: true,
                  },
                  labels: {
                    treasuryAccountId: idLabel('Cont de trezorerie', 'treasuryAccount'),
                    bookingDate: dateLabel('Data operațiunii'),
                    amountMinor: minorLabel('Sumă', { currencyKey: 'currency' }),
                    currency: textLabel('Monedă'),
                    reference: textLabel('Referință'),
                    counterparty: textLabel('Partener'),
                    redacted: textLabel('Date cu acces restricționat'),
                  },
                },
              }
            : {}),
        };
      }),
      next,
    };
  },
};

// SPV messages that differ, failed, or carry an error or a buyer's message.

const spvDetector: Detector = {
  id: 'spv',
  kinds: ['spv.message'],
  async list({ tx, companyId }, page) {
    const rows = await tx
      .select()
      .from(spvMessages)
      .where(
        and(
          eq(spvMessages.companyId, companyId),
          inArray(spvMessages.outcome, ['differs', 'error', 'recorded']),
          position(spvMessages.id, page),
        ),
      )
      .orderBy(asc(spvMessages.id))
      .limit(page.limit + 1);
    const { page: chosen, next } = paged(rows, page.limit, (row) => row.id);
    return {
      items: chosen.map((row): Draft => ({
        kind: 'spv.message',
        subject: { kind: 'spvMessage', id: row.id },
        severity:
          row.outcome === 'error' ? 'block' : row.kind === 'buyer_message' ? 'info' : 'warn',
        due: null,
        period: new Date(row.createdAtAnaf).toISOString().slice(0, 7),
        message: cleanIdentifierText(
          row.outcome === 'differs'
            ? `Factura din SPV diferă de cea emisă: ${row.detail ?? ''}`
            : row.outcome === 'error'
              ? `Mesajul SPV ${row.id} nu a putut fi citit: ${row.detail ?? ''}`
              : row.kind === 'buyer_message'
                ? `Un cumpărător a trimis un mesaj prin SPV (${row.id}).`
                : `ANAF a trimis o eroare pentru o încărcare necunoscută (${row.uploadId}).`,
        ),
        details: {
          kind: row.kind,
          outcome: row.outcome,
          uploadId: row.uploadId,
          documentId: row.documentId,
          detail: row.detail,
        },
        labels: {
          kind: textLabel('Tip'),
          outcome: textLabel('Rezultat'),
          uploadId: idLabel('Încărcare SPV', 'spvUpload'),
          documentId: idLabel('Document', 'document'),
          detail: textLabel('Detaliu'),
        },
        next: [
          ...(row.documentId ? [agent('documents.get', { id: row.documentId })] : []),
          dispose('human', 'dealt_with'),
        ],
        cursor: row.id,
      })),
      next,
    };
  },
};

// Evidence used nowhere: a file nobody read into the books.

/** Whether a record of any kind names the evidence; the likeliest first. */
/** What uses a file in the books: a document, a proposal, a statement, a payroll record (a run's
 * benefits' documents among them), an answer, a disposition, …; a file nothing uses is unused. */
export const evidenceUsed = [
  sql`exists (select 1 from ${documents} x where x.company_id = ${q(evidence.companyId)} and x.evidence_id = ${q(evidence.id)})`,
  sql`exists (select 1 from ${proposalVersions} x where x.company_id = ${q(evidence.companyId)} and x.input_json ->> '$.evidenceId' = ${q(evidence.id)})`,
  sql`exists (select 1 from ${bankStatements} x where x.company_id = ${q(evidence.companyId)} and x.evidence_id = ${q(evidence.id)})`,
  sql`exists (select 1 from ${spvMessages} x where x.company_id = ${q(evidence.companyId)} and x.evidence_id = ${q(evidence.id)})`,
  sql`exists (select 1 from ${profileFacts} x where x.company_id = ${q(evidence.companyId)} and x.evidence_id = ${q(evidence.id)})`,
  sql`exists (select 1 from ${partyStatuses} x where x.company_id = ${q(evidence.companyId)} and x.evidence_id = ${q(evidence.id)})`,
  sql`exists (select 1 from ${fxRates} x where x.evidence_hash = ${q(evidence.hash)})`,
  sql`exists (select 1 from ${bankMappings} x where x.company_id = ${q(evidence.companyId)} and x.evidence_id = ${q(evidence.id)})`,
  sql`exists (select 1 from ${artifacts} x where x.company_id = ${q(evidence.companyId)} and x.evidence_id = ${q(evidence.id)})`,
  sql`exists (select 1 from ${artifactEvents} x where x.company_id = ${q(evidence.companyId)} and x.evidence_id = ${q(evidence.id)})`,
  sql`exists (select 1 from ${assets} x where x.company_id = ${q(evidence.companyId)} and x.evidence_id = ${q(evidence.id)})`,
  sql`exists (select 1 from ${assetEvents} x where x.company_id = ${q(evidence.companyId)} and x.evidence_id = ${q(evidence.id)})`,
  sql`exists (select 1 from ${incomeSources} x where x.company_id = ${q(evidence.companyId)} and x.evidence_id = ${q(evidence.id)})`,
  sql`exists (select 1 from ${enterpriseMembers} x where x.company_id = ${q(evidence.companyId)} and x.evidence_id = ${q(evidence.id)})`,
  sql`exists (select 1 from ${employmentTerms} x where x.company_id = ${q(evidence.companyId)} and x.evidence_id = ${q(evidence.id)})`,
  sql`exists (select 1 from ${questionAnswers} x where x.company_id = ${q(evidence.companyId)}
    and (x.evidence_id = ${q(evidence.id)} or instr(x.value_json, ${q(evidence.id)}) > 0))`,
  sql`exists (select 1 from ${dispositions} x where x.company_id = ${q(evidence.companyId)}
    and x.subject_kind = 'evidence' and x.subject_id = ${q(evidence.id)})`,
  sql`exists (select 1 from ${payrollLines} x, json_each(x.input_json, '$.benefitEvidence') b
    where x.company_id = ${q(evidence.companyId)} and b.value = ${q(evidence.id)})`,
  sql`exists (select 1 from ${payrollRuns} x where x.company_id = ${q(evidence.companyId)} and x.correction_evidence_id = ${q(evidence.id)})`,
  sql`exists (select 1 from ${garnishments} x where x.company_id = ${q(evidence.companyId)} and x.evidence_id = ${q(evidence.id)})`,
  sql`exists (select 1 from ${garnishmentReleases} x where x.company_id = ${q(evidence.companyId)} and x.evidence_id = ${q(evidence.id)})`,
  sql`exists (select 1 from ${regesRecords} x where x.company_id = ${q(evidence.companyId)} and x.evidence_id = ${q(evidence.id)})`,
];

/**
 * When the latest payroll run that kept its benefits in kind without the documents they were
 * valued from was prepared (runs before 5 November 2026; null when there is none). Those
 * documents are recorded nowhere else unless an answer cites them: every file nothing uses,
 * recorded by then, is taken for one (`evidenceClasses`: payroll and personal), and the worklist
 * lists it without its name to a caller who may not read them.
 */
export async function legacyBenefits(tx: Pick<Transaction, 'select'>, companyId: string) {
  const [row] = await tx
    .select({ at: sql<string | null>`max(${payrollRuns.createdAt})` })
    .from(payrollLines)
    .innerJoin(
      payrollRuns,
      and(
        eq(payrollRuns.companyId, payrollLines.companyId),
        eq(payrollRuns.id, payrollLines.runId),
      ),
    )
    .where(
      and(
        eq(payrollLines.companyId, companyId),
        sql`json_extract(${payrollLines.input}, '$.benefits') is not null`,
        sql`json_extract(${payrollLines.input}, '$.benefitEvidence') is null`,
      ),
    );
  return row?.at ?? null;
}

/** Files in the order of their content's hash, unique within a company: the same files are
 * listed alike whatever identifiers they were given. */
const evidenceDetector: Detector = {
  id: 'evidence',
  kinds: ['evidence.unused'],
  async list({ tx, companyId }, page) {
    const rows = await tx
      .select()
      .from(evidence)
      .where(
        and(
          eq(evidence.companyId, companyId),
          page.only !== undefined
            ? sql`${q(evidence.id)} = ${page.only}`
            : page.after !== null
              ? sql`${q(evidence.hash)} > ${page.after}`
              : undefined,
          sql`${q(evidence.mediaType)} <> ${answerMediaType}`,
          sql`not (${sql.join(evidenceUsed, sql` or `)})`,
        ),
      )
      .orderBy(asc(evidence.hash))
      .limit(page.limit + 1);
    const { page: chosen, next } = paged(rows, page.limit, (row) => row.hash);
    const legacy = chosen.length ? await legacyBenefits(tx, companyId) : null;
    return {
      items: chosen.map((row): Draft => {
        const type = row.mediaType.toLowerCase();
        const name = row.filename.toLowerCase();
        const xml = type.includes('xml') || name.endsWith('.xml');
        const csv = type.includes('csv') || name.endsWith('.csv');
        // Possibly a run's benefit document (`legacyBenefits`): its name may name the employee.
        const withheld: Withheld | undefined =
          legacy && row.createdAt <= legacy
            ? {
                classes: payClasses,
                message:
                  'Un fișier nu este citit în registre; poate fi documentul unui avantaj în natură al unui salariat (date salariale), pe care îl vede cine le poate citi.',
                details: {
                  mediaType: row.mediaType,
                  size: row.size,
                  hash: row.hash,
                  redacted: true,
                },
                labels: {
                  mediaType: textLabel('Tip fișier'),
                  size: countLabel('Dimensiune (octeți)'),
                  hash: textLabel('Amprentă fișier'),
                  redacted: textLabel('Date cu acces restricționat'),
                },
              }
            : undefined;
        return {
          ...(withheld ? { withheld } : {}),
          kind: 'evidence.unused',
          subject: { kind: 'evidence', id: row.id },
          severity: 'warn',
          due: null,
          // The engine's month when it received the file; the database's for files kept before.
          period:
            row.engineAt === null
              ? monthOf(row.createdAt)
              : bucharestDate(row.engineAt).slice(0, 7),
          message: `Fișierul ${row.filename} nu este citit în registre: nu stă la baza niciunui document, extras sau propuneri.`,
          details: {
            filename: row.filename,
            mediaType: row.mediaType,
            size: row.size,
            hash: row.hash,
          },
          labels: {
            filename: textLabel('Fișier'),
            mediaType: textLabel('Tip fișier'),
            size: countLabel('Dimensiune (octeți)'),
            hash: textLabel('Amprentă fișier'),
          },
          next: [
            agent('evidence.read', { id: row.id, mode: 'meta' }),
            ...(xml
              ? [agent('invoices.import', { evidenceId: row.id })]
              : csv
                ? [agent('bank.importCsv', { evidenceId: row.id })]
                : [agent('documents.record', { evidenceId: row.id })]),
            dispose('agent', 'no_booking'),
          ].map((step) => (withheld ? { ...step, needs: payClasses } : step)),
          cursor: row.hash,
        };
      }),
      next,
    };
  },
};

// Earned autonomy: what is paused, which templates graduated, which bookings recur.

/** What the templates' track records tell the worklist. */
export interface AutonomyWork {
  /** Recurring partner and treatment pairs without a template, with a mapping to start from. */
  candidates(
    tx: Transaction,
    companyId: string,
  ): Promise<
    {
      treatment: string;
      partyId: string;
      documentKind: string;
      posted: number;
      months: number;
      mapping: JsonValue;
    }[]
  >;
  /** Templates whose graduation criteria are met and that no policy is bound to yet. */
  graduations(
    tx: Transaction,
    companyId: string,
  ): Promise<
    {
      template: { id: string; version: number; name: string; treatment: string };
      report: { correct: number; months: string[]; rulesHash: string | null };
    }[]
  >;
}

function autonomyDetector(
  autonomy: AutonomyWork,
  treatments?: () => readonly Treatment[],
): Detector {
  const byId = () => new Map((treatments?.() ?? []).map((item) => [item.id, item]));
  return {
    id: 'automation',
    kinds: ['automation.paused', 'template.graduation', 'template.candidate'],
    async list({ tx, companyId }, page) {
      const treatmentMap = byId();
      const drafts: Draft[] = [];
      const paused = await pausedScopes(tx, companyId);
      for (const row of paused.rows) {
        const id = row.scopeId ?? companyId;
        const cleanReason = cleanIdentifierText(row.reason);
        drafts.push({
          kind: 'automation.paused',
          subject: { kind: row.scope, id },
          severity: 'warn',
          due: null,
          period: null,
          message:
            row.createdBy === SYSTEM_PRINCIPAL
              ? `Contabilizarea automată a fost oprită de sistem: ${cleanReason} Verificați și reluați-o sau revocați politica.`
              : `Contabilizarea automată este oprită: ${cleanReason}`,
          details: {
            seq: row.seq,
            reason: row.reason,
            trigger: row.trigger,
            system: row.createdBy === SYSTEM_PRINCIPAL,
            by: row.createdBy,
            details: json(row.details),
          },
          labels: {
            seq: countLabel('Poziție'),
            reason: textLabel('Motiv'),
            trigger: textLabel('Cauză'),
            system: textLabel('Oprit de sistem'),
            by: textLabel('Autor'),
            details: textLabel('Detalii suplimentare'),
          },
          next: [
            human('automation.resume', {
              scope: row.scope,
              ...(row.scopeId ? { id: row.scopeId } : {}),
            }),
            ...(row.scope === 'policy' ? [human('policies.revoke', { id })] : []),
            ...(row.scope === 'template' ? [human('templates.revoke', { templateId: id })] : []),
          ],
          cursor: `0|${row.scope}|${id}`,
        });
      }
      for (const { template, report } of await autonomy.graduations(tx, companyId))
        drafts.push({
          kind: 'template.graduation',
          subject: { kind: 'template', id: template.id },
          severity: 'info',
          due: null,
          period: null,
          message: `Șablonul „${template.name}” a îndeplinit criteriile (${report.correct} înregistrări corecte în ${report.months.length} luni): cereți o politică de contabilizare automată.`,
          details: {
            version: template.version,
            treatment: template.treatment,
            correct: report.correct,
            months: report.months,
            rulesHash: report.rulesHash,
          },
          labels: {
            version: countLabel('Versiune'),
            treatment: textLabel('Tratament'),
            correct: countLabel('Înregistrări corecte'),
            months: textLabel('Luni'),
            rulesHash: textLabel('Amprenta regulilor'),
          },
          next: [agent('policies.request', { templateId: template.id })],
          cursor: `1|${template.id}`,
        });
      for (const candidate of await autonomy.candidates(tx, companyId)) {
        const id = `${candidate.treatment}|${candidate.partyId}|${candidate.documentKind}`;
        drafts.push({
          kind: 'template.candidate',
          subject: { kind: 'recurring', id },
          severity: 'info',
          due: null,
          period: null,
          message: `Tratamentul „${treatmentName(candidate.treatment, treatmentMap)}” (${documentKindName(candidate.documentKind)}) se repetă pentru același partener (${candidate.posted} înregistrări în ${candidate.months} luni) fără un șablon.`,
          details: {
            treatment: candidate.treatment,
            partyId: candidate.partyId,
            documentKind: candidate.documentKind,
            posted: candidate.posted,
            months: candidate.months,
          },
          labels: {
            treatment: textLabel('Tratament'),
            partyId: idLabel('Partener', 'party'),
            documentKind: textLabel('Tip document'),
            posted: countLabel('Înregistrări contabilizate'),
            months: countLabel('Luni'),
          },
          next: [
            agent('templates.request', {
              scope: {
                treatment: candidate.treatment,
                partyId: candidate.partyId,
                documentKind: candidate.documentKind,
              },
              ...(candidate.mapping ? { mapping: candidate.mapping } : {}),
            }),
          ],
          cursor: `2|${id}`,
        });
      }
      const chosen = drafts
        .filter((draft) =>
          page.only !== undefined
            ? draft.subject.id === page.only
            : page.after === null || draft.cursor > page.after,
        )
        .sort((a, b) => (a.cursor < b.cursor ? -1 : 1));
      const { page: items, next } = paged(chosen, page.limit, (draft) => draft.cursor);
      return { items, next };
    },
  };
}

// Goods across the border (G3): exempt supplies whose proof is pending, transports without
// their RO e-Transport code (core ro/trade/agent.ts).

/** An item of the trade module, as the worklist reads it. */
export type TradeWorkItem = {
  kind: 'goods.proof' | 'etransport.uit';
  subject: { kind: string; id: string };
  severity: 'block' | 'warn';
  due: string | null;
  period: string;
  message: string;
  causes?: WorkCause[];
  details: { [key: string]: JsonValue };
  labels?: DetailLabels;
  next: WorkStep[];
};
export type TradeWorkOf = (
  tx: Transaction,
  companyId: string,
  today: LocalDate,
) => Promise<TradeWorkItem[]>;

function tradeDetector(source: TradeWorkOf): Detector {
  const cursorOf = (item: TradeWorkItem) => `${item.kind}|${item.subject.kind}:${item.subject.id}`;
  return {
    id: 'trade',
    kinds: ['goods.proof', 'etransport.uit'],
    async list({ tx, companyId, today }, page) {
      const found = (await source(tx, companyId, today))
        .sort((a, b) => cursorOf(a).localeCompare(cursorOf(b)))
        .filter((item) =>
          page.only !== undefined
            ? item.subject.id === page.only
            : page.after === null || cursorOf(item) > page.after,
        );
      const items = found.slice(0, page.limit).map((item): Draft => ({
        kind: item.kind,
        subject: item.subject,
        severity: item.severity,
        due: item.due,
        period: item.period,
        message: item.message,
        ...(item.causes ? { causes: item.causes } : {}),
        details: item.details,
        ...(item.labels ? { labels: item.labels } : {}),
        next: item.next,
        cursor: cursorOf(item),
      }));
      return { items, next: found.length > page.limit ? items.at(-1)!.cursor : null };
    },
  };
}

// Retail and B2C (G2): issued invoices due to RO e-Factura, the fiscal cash registers' external
// obligations (core ro/retail/agent.ts).

/** An item of the retail module, as the worklist reads it. */
export type RetailWorkItem = {
  kind: 'efactura.due' | 'retail.register';
  subject: { kind: string; id: string };
  severity: 'block' | 'warn';
  due: string | null;
  period: string;
  message: string;
  causes?: WorkCause[];
  details: { [key: string]: JsonValue };
  labels?: DetailLabels;
  next: WorkStep[];
};
export type RetailWorkOf = (
  tx: Transaction,
  companyId: string,
  today: LocalDate,
) => Promise<RetailWorkItem[]>;

function retailDetector(source: RetailWorkOf): Detector {
  const cursorOf = (item: RetailWorkItem) => `${item.kind}|${item.subject.kind}:${item.subject.id}`;
  return {
    id: 'retail',
    kinds: ['efactura.due', 'retail.register'],
    async list({ tx, companyId, today }, page) {
      const found = (await source(tx, companyId, today))
        .sort((a, b) => cursorOf(a).localeCompare(cursorOf(b)))
        .filter((item) =>
          page.only !== undefined
            ? item.subject.id === page.only
            : page.after === null || cursorOf(item) > page.after,
        );
      const items = found.slice(0, page.limit).map((item): Draft => ({
        kind: item.kind,
        subject: item.subject,
        severity: item.severity,
        due: item.due,
        period: item.period,
        message: item.message,
        ...(item.causes ? { causes: item.causes } : {}),
        details: item.details,
        ...(item.labels ? { labels: item.labels } : {}),
        next: item.next,
        cursor: cursorOf(item),
      }));
      return { items, next: found.length > page.limit ? items.at(-1)!.cursor : null };
    },
  };
}

/** What the detectors read beyond the kernel's tables. */
export interface WorkSources {
  closeChecks: () => CloseCheck[];
  register: ParameterRegister;
  obligations: ObligationsOf;
  /** The obligation closure's needs; none without it (a test engine). */
  needs?: NeedsOf;
  questionState: QuestionState;
  autonomy: AutonomyWork;
  determinations: DeterminationsOf;
  profit: ProfitWorkOf;
  annual: AnnualWorkOf;
  taxaccount: TaxAccountWorkOf;
  vatAdjustments: VatAdjustmentWorkOf;
  /** The special VAT schemes' items; none without it (a test engine). */
  schemes?: SchemeWorkOf;
  /** The year-end's review; none without it (a test engine). */
  yearEnd?: YearEndWorkOf;
  /** Payroll's REGES-ONLINE transmissions and rectifying D112s; none without it. */
  payroll?: PayrollWorkOf;
  /** Goods across the border's pending proofs and RO e-Transport codes; none without it. */
  trade?: TradeWorkOf;
  /** Retail's e-Factura deadlines and cash registers' obligations; none without it. */
  retail?: RetailWorkOf;
  /** Operation metadata and input schemas for human names and step completeness. */
  operations?: () => OperationRegistry;
  /** Registered treatments for human names and proposal input completeness. */
  treatments?: () => readonly Treatment[];
}

/** The detectors in worklist order: decisions and blocked work first, then intake. */
export function workDetectors(sources: WorkSources): Detector[] {
  return [
    actionsDetector(sources.operations),
    proposalsDetector(sources.questionState, sources.treatments),
    questionsDetector,
    obligationsDetector(sources.obligations),
    ...(sources.needs ? [needsDetector(sources.needs)] : []),
    determinationsDetector(sources.determinations),
    profitDetector(sources.profit),
    annualDetector(sources.annual),
    taxAccountDetector(sources.taxaccount),
    vatAdjustmentDetector(sources.vatAdjustments),
    ...(sources.schemes ? [schemeDetector(sources.schemes)] : []),
    ...(sources.yearEnd ? [yearEndDetector(sources.yearEnd)] : []),
    ...(sources.payroll ? [payrollDetector(sources.payroll)] : []),
    ...(sources.trade ? [tradeDetector(sources.trade)] : []),
    ...(sources.retail ? [retailDetector(sources.retail)] : []),
    closeDetector(sources.closeChecks),
    rulesDetector(sources.register),
    betterSourceDetector(sources.treatments),
    originsDetector,
    documentsDetector,
    bankDetector,
    spvDetector,
    evidenceDetector,
    autonomyDetector(sources.autonomy, sources.treatments),
  ];
}

/**
 * What one page may spend: detector calls and time. A page past either ends early, possibly with
 * fewer items than asked, and `next` resumes exactly where it stopped; a month's close checks are
 * one call, the costliest. The first call always runs, so every page moves on.
 */
const callBudget = 40;
const timeBudget = 150;

const customMissingFields: Record<string, readonly string[]> = {
  'invoices.recognize': ['account', 'allocations'],
  'invoices.credit': ['account', 'allocations'],
  'bank.settle': ['allocations', 'lines', 'opens', 'cards'],
  'cash.settle': ['allocations', 'lines', 'opens'],
};

function missingFromSchema(
  schema: z.ZodType,
  value: unknown,
  prefix = '',
  treatmentId?: string,
): string[] {
  const parsed = schema.safeParse(value);
  if (parsed.success) return [];
  const fields: string[] = [];
  for (const issue of parsed.error.issues) {
    if (issue.path.length) fields.push(`${prefix}${issue.path.map(String).join('.')}`);
    else if (issue.code === 'custom' && treatmentId && customMissingFields[treatmentId])
      fields.push(...customMissingFields[treatmentId]!.map((name) => `${prefix}${name}`));
    else fields.push(prefix ? prefix.replace(/\.$/, '') : 'input');
  }
  return [...new Set(fields)];
}

function stepCompleteness(
  step: WorkStep,
  draft: Pick<Draft, 'details'>,
  inputHint: WorkStep['inputHint'],
  operations?: OperationRegistry,
  treatments?: ReadonlyMap<string, Treatment>,
): { complete: boolean; missing?: string[] } {
  const op = operations?.find(step.operation);
  if (!op) return { complete: false, missing: ['operation'] };
  const treatmentId = treatmentOf(step, draft);
  const typedTreatment =
    treatmentId === undefined &&
    step.operation.endsWith('.propose') &&
    treatments?.has(step.operation.slice(0, -'.propose'.length))
      ? step.operation.slice(0, -'.propose'.length)
      : undefined;
  const fields = missingFromSchema(op.input, inputHint, '', typedTreatment);
  if (
    (step.operation === 'proposals.propose' || step.operation === 'proposals.revise') &&
    !fields.includes('input')
  ) {
    const treatment = treatmentId ? treatments?.get(treatmentId) : undefined;
    if (treatment)
      fields.push(...missingFromSchema(treatment.input, inputHint.input, 'input.', treatmentId));
    else fields.push('input');
  }
  const unique = [...new Set(fields)];
  return unique.length ? { complete: false, missing: unique } : { complete: true };
}

export class Work {
  private readonly byKind = new Map<WorkKind, Detector>();

  constructor(
    private readonly commands: Commands,
    private readonly detectors: Detector[],
    /** The engine's time: the Bucharest date items are judged on. */
    private readonly clock: () => number = Date.now,
    private readonly metadata: {
      operations?: () => OperationRegistry;
      treatments?: () => readonly Treatment[];
    } = {},
  ) {
    for (const detector of detectors)
      for (const kind of detector.kinds) this.byKind.set(kind, detector);
  }

  /** What this principal may invoke and read now, under `role`. */
  private async caller(tx: Transaction, actor: Actor, role: Role): Promise<Caller> {
    const readable = await this.commands.readable(tx, actor);
    const discloses = await this.commands.disclosable(tx, actor, role);
    return {
      agent: !!actor.agentId,
      roleAllows: (permission) => roleAllows(role, permission),
      allowed: await this.commands.usable(tx, actor, role),
      reads: (treatment) => {
        const classes = this.commands.dataClassesOf(`${treatment}.propose`);
        return !actor.agentId || (!!classes && readable(classes));
      },
      cnps: discloses(['personal']),
      discloses,
    };
  }

  private context(tx: Transaction, companyId: string): WorkContext {
    return { tx, companyId, today: bucharestDate(this.clock()) };
  }

  /** Ids, fingerprints and the audit position, the `work.dispose` steps' inputs, whether
   * the caller may take each step (and why if not), and whether `inputHint` is complete. A
   * proposal's input in a hint goes only to a caller who may read it, as `proposals.get` decides. */
  private finish(
    drafts: Draft[],
    asOfSeq: number,
    caller: Caller,
  ): (WorkItem & { cursor: string })[] {
    const operations = this.metadata.operations?.();
    const treatmentMap = this.metadata.treatments
      ? new Map(this.metadata.treatments().map((item) => [item.id, item]))
      : undefined;
    return drafts.map((draft) => {
      const id = itemId(draft.kind, draft.subject);
      const fingerprint = hashOf({
        kind: draft.kind,
        subject: draft.subject,
        details: draft.details,
      });
      const redacted = draft.withheld && !caller.discloses(draft.withheld.classes);
      const shown = redacted
        ? {
            message: draft.withheld!.message,
            details: draft.withheld!.details,
            labels: draft.withheld!.labels,
          }
        : draft;
      const details = caller.cnps ? shown.details : maskCnps(shown.details);
      return {
        id,
        kind: draft.kind,
        subject: draft.subject,
        severity: draft.severity,
        due: draft.due,
        period: draft.period,
        // The fingerprint is the item's own, whatever the caller reads of it.
        message: caller.cnps ? shown.message : maskCnpText(shown.message),
        ...(draft.causes?.length
          ? {
              causes: caller.cnps
                ? draft.causes
                : draft.causes.map((cause) => ({ ...cause, message: maskCnpText(cause.message) })),
            }
          : {}),
        details,
        labels: completeLabels(details, shown.labels),
        fingerprint,
        next: draft.next.map((found): WorkStepView => {
          const step = asCalled(found, draft, caller);
          const missingData = (step.needs ?? []).filter((kind) => !caller.discloses([kind]));
          const ops = stepNeeds(step, draft);
          let missingRole: PermissionKind | undefined;
          if (operations)
            for (const opId of ops) {
              const perm = operations.find(opId)?.permission;
              if (perm && !caller.roleAllows(perm)) {
                missingRole = perm;
                break;
              }
            }
          const stateReason =
            step.stateReason ??
            (step.operation === 'work.dispose' && draft.severity === 'block'
              ? 'O problemă care blochează se rezolvă, nu se închide printr-o decizie.'
              : undefined);
          const allowed =
            (step.by === 'agent' || !caller.agent) &&
            ops.every(caller.allowed) &&
            !missingData.length &&
            stateReason === undefined;
          const reason: StepRefusal | undefined = allowed
            ? undefined
            : missingRole !== undefined
              ? { kind: 'role', permission: missingRole }
              : (step.by === 'human' && caller.agent) ||
                  (caller.agent && !ops.every(caller.allowed))
                ? { kind: 'grant' }
                : missingData.length
                  ? { kind: 'data' }
                  : stateReason !== undefined
                    ? { kind: 'state', message: stateReason }
                    : { kind: 'grant' };
          // A step whose data the caller may not read shows no input to start from.
          const inputHint =
            step.operation === 'work.dispose'
              ? { id, fingerprint, ...step.inputHint }
              : missingData.length
                ? (({ input: _, ...rest }) => rest)(step.inputHint)
                : hidden(step, draft, caller);
          const completeness = stepCompleteness(step, draft, inputHint, operations, treatmentMap);
          return {
            operation: step.operation,
            by: step.by,
            allowed,
            ...(reason ? { reason } : {}),
            complete: completeness.complete,
            ...(completeness.missing ? { missing: completeness.missing } : {}),
            inputHint,
            ...(missingData.length ? { needs: missingData } : {}),
          };
        }),
        asOfSeq,
        cursor: draft.cursor,
      };
    });
  }

  /** The dispositions of these items' subjects whose fingerprint is the item's. */
  private async disposed(tx: Transaction, companyId: string, items: WorkItem[]) {
    const candidates = items.filter((item) => disposable[item.kind]);
    if (!candidates.length) return new Map<string, typeof dispositions.$inferSelect>();
    const rows = await tx
      .select()
      .from(dispositions)
      .where(
        and(
          eq(dispositions.companyId, companyId),
          inArray(dispositions.subjectId, [...new Set(candidates.map((item) => item.subject.id))]),
        ),
      )
      .orderBy(asc(dispositions.createdAt));
    const found = new Map<string, typeof dispositions.$inferSelect>();
    for (const item of candidates) {
      const match = rows
        .filter(
          (row) =>
            row.subjectKind === item.subject.kind &&
            row.subjectId === item.subject.id &&
            row.fingerprint === item.fingerprint,
        )
        .at(-1);
      if (match) found.set(item.id, match);
    }
    return found;
  }

  list(actor: Actor, input: z.infer<typeof workListInput>) {
    return this.commands.read(actor, 'work.list', async (tx, access) => {
      const context = this.context(tx, actor.companyId);
      const caller = await this.caller(tx, actor, access.role);
      const asOfSeq = await auditHead(tx, actor.companyId);
      let start = 0;
      let resume: string | null = null;
      if (input.after) {
        const split = input.after.indexOf(':');
        start = this.detectors.findIndex(
          (detector) => detector.id === input.after!.slice(0, split),
        );
        requireCondition(
          split > 0 && start >= 0,
          'WORK_CURSOR',
          'Cursorul listei nu este valid.',
          422,
        );
        resume = input.after.slice(split + 1) || null;
      }
      const wanted = (item: WorkItem) =>
        (!input.kinds || input.kinds.includes(item.kind)) &&
        (!input.severity || severityRank[item.severity] <= severityRank[input.severity]) &&
        (!input.by ||
          (input.by === 'agent'
            ? item.next.some((step) => step.by === 'agent' && step.allowed)
            : item.next.some((step) => step.by === 'human') ||
              !item.next.some((step) => step.by === 'agent' && step.allowed)));
      const items: WorkItem[] = [];
      const started = performance.now();
      let calls = 0;
      for (let index = start; index < this.detectors.length; index++) {
        const detector = this.detectors[index]!;
        let after = index === start ? resume : null;
        if (input.kinds && !detector.kinds.some((kind) => input.kinds!.includes(kind))) continue;
        for (;;) {
          if (calls >= callBudget || (calls > 0 && performance.now() - started > timeBudget))
            return { items, next: `${detector.id}:${after ?? ''}`, asOfSeq };
          calls++;
          const batch = await detector.list(context, {
            after,
            limit: Math.min(200, Math.max(input.limit - items.length, 20)),
          });
          const finished = this.finish(batch.items, asOfSeq, caller);
          const hidden = await this.disposed(tx, actor.companyId, finished);
          for (const { cursor, ...item } of finished) {
            after = cursor;
            if (!wanted(item) || hidden.has(item.id)) continue;
            items.push(item);
            if (items.length === input.limit)
              return { items, next: `${detector.id}:${cursor}`, asOfSeq };
          }
          if (batch.next === null) break;
          after = batch.next;
        }
      }
      return { items, next: null, asOfSeq };
    });
  }

  /** The item of this kind about this subject, if it still waits. */
  private async find(context: WorkContext, id: string, caller: Caller) {
    const { kind, subject } = parseItemId(id);
    const detector = this.byKind.get(kind)!;
    const batch = await detector.list(context, { after: null, limit: 50, only: subject.id });
    const asOfSeq = await auditHead(context.tx, context.companyId);
    const item = this.finish(batch.items, asOfSeq, caller).find((candidate) => candidate.id === id);
    return { kind, subject, asOfSeq, item: item ? (({ cursor: _, ...rest }) => rest)(item) : null };
  }

  get(actor: Actor, input: z.infer<typeof workGetInput>) {
    return this.commands.read(actor, 'work.get', async (tx, access) => {
      const found = await this.find(
        this.context(tx, actor.companyId),
        input.id,
        await this.caller(tx, actor, access.role),
      );
      const disposition = found.item
        ? ((await this.disposed(tx, actor.companyId, [found.item])).get(found.item.id) ?? null)
        : null;
      return {
        id: input.id,
        state: !found.item ? 'resolved' : disposition ? 'disposed' : 'open',
        item: found.item,
        disposition: disposition && {
          id: disposition.id,
          disposition: disposition.disposition,
          reason: disposition.reason,
          fingerprint: disposition.fingerprint,
          createdBy: disposition.createdBy,
          agentId: disposition.agentId,
          at: disposition.createdAt,
        },
        asOfSeq: found.asOfSeq,
      } as const;
    });
  }

  /**
   * Records that an item needs nothing more as it stands: a document needs no booking, a message
   * or a warning was dealt with. The item must still wait with the fingerprint decided on; it
   * comes back when that changes. Only unused evidence may be disposed of by an agent.
   */
  dispose(actor: Actor, key: string, input: z.infer<typeof disposeInput>) {
    return this.commands.run(actor, key, 'work.dispose', input, 'write', async (tx) => {
      const { kind, subject } = parseItemId(input.id);
      const who = disposable[kind];
      requireCondition(
        who,
        'WORK_DISPOSITION',
        'Acest element nu se închide printr-o decizie.',
        422,
      );
      requireCondition(
        who === 'anyone' || !actor.agentId,
        'AGENT_SCOPE',
        'Această decizie aparține unei persoane.',
        403,
      );
      // Only the item's fingerprint and severity decide here, never its steps.
      const found = await this.find(this.context(tx, actor.companyId), input.id, {
        agent: !!actor.agentId,
        roleAllows: () => false,
        allowed: () => false,
        reads: () => false,
        cnps: false,
        discloses: () => false,
      });
      requireCondition(found.item, 'WORK_RESOLVED', 'Elementul nu mai așteaptă nimic.', 409);
      requireCondition(
        found.item.fingerprint === input.fingerprint,
        'STALE',
        'Elementul s-a schimbat de când a fost citit. Reîncărcați-l.',
        409,
        { fingerprint: found.item.fingerprint },
      );
      requireCondition(
        found.item.severity !== 'block',
        'WORK_BLOCKING',
        'O problemă care blochează se rezolvă, nu se închide printr-o decizie.',
        409,
      );
      const id = this.commands.ids();
      await tx.insert(dispositions).values({
        id,
        companyId: actor.companyId,
        subjectKind: subject.kind,
        subjectId: subject.id,
        disposition: input.disposition,
        reason: input.reason,
        fingerprint: input.fingerprint,
        createdBy: actor.actorId,
        agentId: actor.agentId ?? null,
      });
      const [row] = await tx
        .select({ at: dispositions.createdAt })
        .from(dispositions)
        .where(and(eq(dispositions.companyId, actor.companyId), eq(dispositions.id, id)));
      return {
        id,
        itemId: input.id,
        subject,
        disposition: input.disposition,
        reason: input.reason,
        fingerprint: input.fingerprint,
        createdBy: actor.actorId,
        agentId: actor.agentId ?? null,
        at: row!.at,
        ...(subject.kind === 'document' ? { documentId: subject.id } : {}),
        ...(subject.kind === 'evidence' ? { evidenceId: subject.id } : {}),
      };
    });
  }
}
