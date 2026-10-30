import { and, asc, desc, eq, gte, inArray, isNull, notExists, sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import { DomainError, requireCondition } from 'xfactura-core/errors';
import { canonical, derivedId, hashOf } from 'xfactura-core/hash';
import {
  financialYearOf,
  validateEffect,
  type AnswerRecord,
  type Effect,
  type Issue,
  type JsonValue,
  type Loaded,
  type ReadSetEntry,
  type Treatment,
} from 'xfactura-core/kernel';
import { booksSystemOf, singleEntryExcluded } from 'xfactura-core/ro/entity';
import {
  RuleContext,
  RuleGapError,
  type ParameterRegister,
  type UseMode,
} from 'xfactura-core/rules';
import { effectFingerprint } from 'xfactura-core/templates';
import { bucharestDate, type LocalDate } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import {
  approvals,
  documents,
  entries,
  periodEvents,
  profileFacts,
  proposalChecks,
  proposals,
  proposalVersions,
  questionAnswers,
  questions,
  taxPeriodEvents,
  withdrawals,
} from '../db/schema';
import { appendAudit, type Actor, type Commands } from './commands';
import {
  requireActiveApprover,
  requireSegregated,
  segregationOn,
  type Segregation,
} from './controls';
import { holdsSubject, writeEntry } from './ledger';
import { loadAccounts, loadState, mergeStates } from './state';
import { auditHead } from './events';
import { rootOf, sourceReview } from './sources';
import { viewEffect, type ProposalChange, type ProposalView, type StoredEffect } from './views';
import type { PostingPolicies } from './policies';

const assurance: Record<string, UseMode> = {
  preview: 'preview',
  shadow: 'shadow',
  live: 'posting',
};

/** What a proposal relies on beyond the books: the questions whose answers it cites, and the
 * template that made its input (by id; the version kept is the template's current one). */
export type BasisInput = { answers: string[]; template?: string | undefined };
export type TemplateRef = { id: string; version: number };
export type Basis = { answers: string[]; template?: TemplateRef };

/** The basis a version keeps: its answers' questions, sorted and once each, and the template;
 * null without either. */
export function basisOf(
  input: { answers?: string[] | undefined } | null | undefined,
  template?: TemplateRef | null,
): Basis | null {
  const answers = [...new Set(input?.answers ?? [])].sort();
  if (template) return { answers, template };
  return answers.length ? { answers } : null;
}

/** What the templates tell proposals: a template's current version, and whether an input is
 * what a version makes of its document or movement while the template stands. */
export interface TemplateSource {
  current(tx: Transaction, companyId: string, templateId: string): Promise<TemplateRef | null>;
  conforms(
    tx: Transaction,
    companyId: string,
    template: TemplateRef,
    treatmentId: string,
    input: unknown,
  ): Promise<boolean>;
  /** The questions whose answers that hold a template version relies on (a vehicle's use): a
   * proposal citing the template cites them too. */
  answers(tx: Transaction, companyId: string, template: TemplateRef): Promise<string[]>;
}

/** One version a batch names: it must be the latest, unchanged, and need no acknowledgement. */
export type BatchMember = { proposalId: string; version: number; effectHash: string };
/** Where a batch member stands: `ready`, or why it cannot be approved in a batch. */
export const memberStates = [
  'ready',
  'missing',
  'superseded',
  'changed',
  'posted',
  'withdrawn',
  'blocked',
  'acknowledgement',
  'stale',
] as const;
export type MemberState = (typeof memberStates)[number];

/**
 * The answers a basis cites, each question at its latest answer: the read-set entries (empty
 * for a question without one) and the answers a treatment reads (`Loaded.answers`).
 */
export async function basisAnswers(
  tx: Transaction,
  companyId: string,
  basis: Basis | null,
): Promise<{ readSet: ReadSetEntry[]; answers: Map<string, AnswerRecord> }> {
  const answers = new Map<string, AnswerRecord>();
  if (!basis?.answers.length) return { readSet: [], answers };
  const rows = await tx
    .select({
      questionId: questionAnswers.questionId,
      id: questionAnswers.id,
      seq: questionAnswers.seq,
      value: questionAnswers.value,
      evidenceId: questionAnswers.evidenceId,
      engineAt: questionAnswers.engineAt,
      kind: questions.kind,
      subjectKind: questions.subjectKind,
      subjectId: questions.subjectId,
      params: questions.params,
    })
    .from(questionAnswers)
    .innerJoin(
      questions,
      and(
        eq(questions.companyId, questionAnswers.companyId),
        eq(questions.id, questionAnswers.questionId),
      ),
    )
    .where(
      and(
        eq(questionAnswers.companyId, companyId),
        inArray(questionAnswers.questionId, basis.answers),
      ),
    );
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows)
    if ((latest.get(row.questionId)?.seq ?? 0) < row.seq) latest.set(row.questionId, row);
  for (const [questionId, row] of latest)
    answers.set(questionId, {
      questionId,
      answerId: row.id,
      kind: row.kind,
      subject: { kind: row.subjectKind, id: row.subjectId },
      params: JSON.parse(row.params) as JsonValue,
      value: JSON.parse(row.value) as JsonValue,
      evidenceId: row.evidenceId,
      // The engine's time of the answer, never the database's: no treatment decides on wall
      // time. An answer recorded before the engine kept it counts as the earliest.
      answeredAt: new Date(row.engineAt ?? 0).toISOString(),
    });
  return {
    readSet: basis.answers.map((questionId) => ({
      kind: 'answer' as const,
      id: questionId,
      version: latest.get(questionId)?.id ?? '',
    })),
    answers,
  };
}

/** The read-set entries of a basis: each question, at its latest answer (empty without one). */
export async function answerReads(
  tx: Transaction,
  companyId: string,
  basis: Basis | null,
): Promise<ReadSetEntry[]> {
  return (await basisAnswers(tx, companyId, basis)).readSet;
}

export interface Evaluated {
  effect: Effect | null;
  issues: Issue[];
  readSet: ReadSetEntry[];
  rules: { mode: UseMode; used: { id: string; status: string; attestationId?: string }[] };
  rulesHash: string;
  effectHash: string;
  blocking: boolean;
}

/** Replaces the refs a treatment used for new open items and schedules with stable ids. */
function resolveRefs(effect: Effect, proposalId: string): Effect {
  const items = new Map(
    effect.openItems.map((item) => [item.ref, derivedId(proposalId, 'openItem', item.ref)]),
  );
  const resolve = (reference: string | undefined) =>
    reference === undefined ? undefined : (items.get(reference) ?? reference);
  return {
    ...effect,
    lines: effect.lines.map((line) =>
      line.openItem === undefined ? line : { ...line, openItem: resolve(line.openItem)! },
    ),
    openItems: effect.openItems.map((item) => ({ ...item, ref: items.get(item.ref)! })),
    schedules: effect.schedules.map((schedule) => ({
      ...schedule,
      ref: schedule.version === 1 ? derivedId(proposalId, 'schedule', schedule.ref) : schedule.ref,
      openItem: resolve(schedule.openItem)!,
    })),
  };
}

function accountCodes(effect: Effect) {
  return [
    ...new Set([
      ...effect.lines.map((line) => line.account),
      ...effect.schedules.flatMap((schedule) => schedule.rows.map((row) => row.counterAccount)),
    ]),
  ];
}

/** A re-evaluation of a proposal's latest version against the books as of audit `checkedSeq`. */
export interface ProposalCheck {
  proposalId: string;
  version: number;
  checkedSeq: number;
  /** The effect hash differs: posting the version would be refused as STALE. */
  stale: boolean;
  changed: ProposalChange[];
}

/** What differs between a stored version and its re-evaluation (see `proposalChange`). */
function changesOf(
  row: typeof proposalVersions.$inferSelect,
  treatment: Treatment,
  evaluated: Evaluated,
): ProposalChange[] {
  const key = (entry: ReadSetEntry) => `${entry.kind}/${entry.id}`;
  const before = new Map(
    (JSON.parse(row.readSet) as ReadSetEntry[]).map((entry) => [key(entry), entry]),
  );
  const after = new Map(evaluated.readSet.map((entry) => [key(entry), entry]));
  const changes: ProposalChange[] = [];
  for (const [id, entry] of after) {
    const previous = before.get(id);
    if (previous?.version !== entry.version)
      changes.push({
        kind: entry.kind,
        id: entry.id,
        before: previous?.version ?? null,
        after: entry.version,
      });
  }
  for (const [id, entry] of before)
    if (!after.has(id))
      changes.push({ kind: entry.kind, id: entry.id, before: entry.version, after: null });
  if (row.treatmentVersion !== treatment.version)
    changes.push({
      kind: 'treatment',
      id: treatment.id,
      before: String(row.treatmentVersion),
      after: String(treatment.version),
    });
  if (row.rules !== canonical(evaluated.rules))
    changes.push({
      kind: 'rules',
      id: evaluated.rules.mode,
      before: hashOf(JSON.parse(row.rules)),
      after: hashOf(evaluated.rules),
    });
  const codes = (issues: Issue[]) =>
    issues
      .map((issue) => `${issue.severity}:${issue.code}`)
      .sort()
      .join(',') || null;
  const issuesBefore = codes(JSON.parse(row.issues) as Issue[]);
  const issuesAfter = codes(evaluated.issues);
  if (issuesBefore !== issuesAfter)
    changes.push({ kind: 'issues', id: 'codes', before: issuesBefore, after: issuesAfter });
  if (changes.length === 0)
    changes.push({
      kind: 'effect',
      id: row.proposalId,
      before: row.effectHash,
      after: evaluated.effectHash,
    });
  return changes;
}

/** Caches a check, unless one of a later version, or of the same version at a later `seq`, is
 * already cached. */
export async function saveCheck(tx: Transaction, companyId: string, check: ProposalCheck) {
  const values = {
    version: check.version,
    checkedSeq: check.checkedSeq,
    stale: check.stale,
    changed: canonical(check.changed),
  };
  await tx
    .insert(proposalChecks)
    .values({ companyId, proposalId: check.proposalId, ...values })
    .onConflictDoUpdate({
      target: [proposalChecks.companyId, proposalChecks.proposalId],
      set: { ...values, checkedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` },
      setWhere: sql`${proposalChecks.version} < excluded.version or (${proposalChecks.version} = excluded.version and ${proposalChecks.checkedSeq} <= excluded.checked_seq)`,
    });
}

/** The basis a stored version was evaluated with. */
const storedBasis = (row: typeof proposalVersions.$inferSelect) =>
  row.basis ? (JSON.parse(row.basis) as Basis) : null;

const block = (code: string, message: string, details?: Issue['details']): Issue => ({
  code,
  severity: 'block',
  message,
  ...(details === undefined ? {} : { details }),
});

export class Proposals {
  private readonly treatments = new Map<string, Treatment>();
  private templates: TemplateSource | undefined;

  constructor(
    private readonly commands: Commands,
    private readonly register: ParameterRegister,
    private readonly policies: PostingPolicies,
    /** The engine's time: the date on which the company's controls are read. */
    private readonly clock: () => number = Date.now,
  ) {}

  private today() {
    return bucharestDate(this.clock());
  }

  /** Lets a basis cite templates. */
  useTemplates(templates: TemplateSource) {
    this.templates = templates;
  }

  /**
   * The template a version cites, if its input is what the template makes: named in the basis
   * (refused unless it conforms), or kept from the previous version while the input still
   * conforms (a person's correction drops it).
   */
  private async templateBasis(
    tx: Transaction,
    companyId: string,
    treatmentId: string,
    input: unknown,
    named: string | undefined,
    previous: TemplateRef | undefined,
  ): Promise<TemplateRef | null> {
    if (named === undefined && !previous) return null;
    requireCondition(this.templates, 'TEMPLATE', 'Șabloanele nu sunt disponibile.', 404);
    if (named === undefined)
      return (await this.templates.conforms(tx, companyId, previous!, treatmentId, input))
        ? previous!
        : null;
    const current = await this.templates.current(tx, companyId, named);
    requireCondition(current, 'TEMPLATE_NOT_FOUND', 'Șablonul nu este disponibil.', 404, {
      templateId: named,
    });
    requireCondition(
      await this.templates.conforms(tx, companyId, current, treatmentId, input),
      'TEMPLATE_CONFORMANCE',
      'Datele propunerii nu sunt cele pe care șablonul le produce pentru acest document sau această mișcare.',
      409,
      { template: current },
    );
    return current;
  }

  /** The document a proposal recognizes: the one its input names (`documentId`), else its
   * declared subject's (`document:<id>`), when the company has it. */
  private async documentOf(tx: Transaction, companyId: string, subjectKey: string, input: unknown) {
    const named =
      typeof input === 'object' &&
      input !== null &&
      'documentId' in input &&
      typeof input.documentId === 'string'
        ? input.documentId
        : subjectKey.startsWith('document:')
          ? subjectKey.slice('document:'.length)
          : undefined;
    if (!named) return null;
    const [document] = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.companyId, companyId), eq(documents.id, named)));
    return document?.id ?? null;
  }

  addTreatment(...treatments: Treatment[]) {
    for (const treatment of treatments) this.treatments.set(treatment.id, treatment);
  }

  treatment(id: string) {
    const treatment = this.treatments.get(id);
    requireCondition(treatment, 'TREATMENT', 'Tratamentul contabil nu este disponibil.', 404);
    return treatment;
  }

  allTreatments() {
    return [...this.treatments.values()];
  }

  /** The rules as the company's assurance mode admits them, for checks outside a treatment. */
  async ruleContext(tx: Transaction, companyId: string) {
    return new RuleContext(this.register, await this.mode(tx, companyId));
  }

  private async mode(tx: Transaction, companyId: string): Promise<UseMode> {
    const [fact] = await tx
      .select({ value: profileFacts.value })
      .from(profileFacts)
      .where(and(eq(profileFacts.companyId, companyId), eq(profileFacts.axis, 'books.assurance')))
      .orderBy(desc(profileFacts.effectiveFrom), desc(profileFacts.createdAt))
      .limit(1);
    return assurance[fact?.value ?? 'preview'] ?? 'preview';
  }

  /** Issues about where the entry would land, found before anyone approves it. */
  private async placement(tx: Transaction, companyId: string, effect: Effect, loaded: Loaded) {
    const issues: Issue[] = [];
    if (!financialYearOf(loaded, effect.date))
      issues.push(block('FINANCIAL_YEAR', 'Data nu aparține unui exercițiu financiar configurat.'));
    const [period] = await tx
      .select({ kind: periodEvents.kind })
      .from(periodEvents)
      .where(
        and(eq(periodEvents.companyId, companyId), eq(periodEvents.month, effect.date.slice(0, 7))),
      )
      .orderBy(desc(periodEvents.seq))
      .limit(1);
    if (period?.kind === 'close') issues.push(block('PERIOD_CLOSED', 'Luna este închisă.'));
    const periods = [
      ...new Set(effect.taxEntries.map((entry) => `${entry.tax}/${entry.taxPeriod}`)),
    ];
    for (const key of periods) {
      const [tax, taxPeriod] = key.split('/') as [string, string];
      if (taxPeriod === 'null') continue;
      const [event] = await tx
        .select({ kind: taxPeriodEvents.kind })
        .from(taxPeriodEvents)
        .where(
          and(
            eq(taxPeriodEvents.companyId, companyId),
            eq(taxPeriodEvents.tax, tax),
            eq(taxPeriodEvents.period, taxPeriod),
          ),
        )
        .orderBy(desc(taxPeriodEvents.seq))
        .limit(1);
      if (event?.kind === 'lock')
        issues.push(block('TAX_PERIOD_LOCKED', `Perioada fiscală ${taxPeriod} a fost declarată.`));
    }
    return issues;
  }

  /** Evaluates a treatment for a proposal: deterministic for the same input and state. */
  async evaluate(
    tx: Transaction,
    companyId: string,
    proposalId: string,
    treatment: Treatment,
    input: unknown,
    basis: Basis | null = null,
  ): Promise<Evaluated> {
    let state = await loadState(tx, companyId, treatment.plan(input));
    const followUp = treatment.followUp?.(input, state.loaded);
    if (followUp) state = mergeStates(state, await loadState(tx, companyId, followUp));
    // The answers the basis cites, as the person gave them: a treatment that needs a fact reads
    // only those, and a later answer makes the version stale.
    const cited = await basisAnswers(tx, companyId, basis);
    const loaded: Loaded = { ...state.loaded, answers: cited.answers };
    let readSet = state.readSet;
    const mode = await this.mode(tx, companyId);
    const rules = new RuleContext(this.register, mode);
    let effect: Effect | null = null;
    const issues: Issue[] = [];
    try {
      const evaluation = treatment.evaluate(input, loaded, rules);
      issues.push(...evaluation.issues);
      effect = evaluation.effect && resolveRefs(evaluation.effect, proposalId);
    } catch (error) {
      if (!(error instanceof RuleGapError)) throw error;
      issues.push(block('RULE_GAP', error.message, { ...error.gap }));
    }
    // Treatments of a company's double-entry books are refused on single-entry books (a PFA, II
    // or IF): at the entry's date, or under the latest regime when nothing would be posted.
    const excluded = singleEntryExcluded[treatment.id];
    if (excluded) {
      const facts = (await loadState(tx, companyId, { profile: true })).loaded.profile;
      const at = (effect?.date ?? '9999-12-31') as LocalDate;
      if (booksSystemOf(facts, at) === 'single')
        issues.push(
          block(
            'SINGLE_ENTRY_EXCLUDED',
            `Tratamentul ${treatment.id} nu se aplică în contabilitatea în partidă simplă: ${excluded}.`,
            { treatment: treatment.id },
          ),
        );
    }
    if (effect) {
      const accounts = await loadAccounts(tx, companyId, accountCodes(effect));
      issues.push(
        ...validateEffect(effect, {
          account: (code) => accounts.get(code),
          openItem: (id) => loaded.openItems.get(id),
        }),
        ...(await this.placement(tx, companyId, effect, loaded)),
      );
    }
    // Where the documents read come from: an extraction, a superseded copy, a better copy.
    const sources = await sourceReview(tx, companyId, [...loaded.documents.keys()]);
    issues.push(...sources.issues);
    // The answers the basis cites: a later answer makes the version stale. The person approving
    // sees them beside the input.
    readSet = [...readSet, ...sources.readSet, ...cited.readSet];
    const used = [...rules.used]
      .map(([id, use]) => ({
        id,
        status: use.status,
        ...(use.attestationId ? { attestationId: use.attestationId } : {}),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const rulesRecord = { mode, used };
    // Policies bind to the treatment version and the parameter versions it relied on.
    const rulesHash = hashOf({
      treatment: treatment.id,
      version: treatment.version,
      parameters: used.map((use) => use.id),
    });
    // The basis enters the hash only when there is one, so earlier versions keep theirs.
    const effectHash = hashOf({
      treatment: treatment.id,
      version: treatment.version,
      input,
      readSet,
      rules: rulesRecord,
      effect,
      issues,
      ...(basis ? { basis } : {}),
    });
    return {
      effect,
      issues,
      readSet,
      rules: rulesRecord,
      rulesHash,
      effectHash,
      blocking: issues.some((issue) => issue.severity === 'block'),
    };
  }

  /** Proposes a treatment, or revises an open proposal of the same subject. */
  async propose(
    actor: Actor,
    key: string,
    treatmentId: string,
    rawInput: unknown,
    revision?: { proposalId: string; version: number },
    /** The answers it relies on; on a revision, omitted keeps the previous version's. */
    basisInput?: BasisInput,
  ) {
    const treatment = this.treatment(treatmentId);
    const input = treatment.input.parse(rawInput);
    const operation = `${treatment.id}.${revision ? 'revise' : 'propose'}`;
    return this.commands.run(
      actor,
      key,
      operation,
      {
        input,
        revision: revision ?? null,
        ...(basisInput === undefined ? {} : { basis: basisOf(basisInput) }),
      },
      'write',
      async (tx) => {
        // Copies of one document (a PDF read, then e-Factura) share their group's root as
        // subject, so that one of them only is ever recognized.
        const declared = treatment.subject(input);
        const subjectKey = declared.startsWith('document:')
          ? `document:${await rootOf(tx, actor.companyId, declared.slice('document:'.length))}`
          : declared;
        // The proposal holding this subject, open or posted, if any: a withdrawal frees the
        // subject, and so does the reversal of its posted entry (a correction is a reversal and
        // a new proposal).
        const [existing] = await tx
          .select()
          .from(proposals)
          .where(
            and(
              eq(proposals.companyId, actor.companyId),
              eq(proposals.subjectKey, subjectKey),
              holdsSubject('"acc_proposals"'),
            ),
          );
        const latest = existing
          ? await this.latestVersion(tx, actor.companyId, existing.id)
          : undefined;
        let proposalId: string;
        if (revision) {
          requireCondition(
            existing && existing.id === revision.proposalId,
            'SUBJECT_MISMATCH',
            'Revizuirea trebuie să păstreze obiectul propunerii.',
            409,
          );
          requireCondition(
            latest?.version === revision.version,
            'STALE',
            'Propunerea s-a schimbat. Reîncărcați datele.',
            409,
          );
          proposalId = existing.id;
        } else if (existing) {
          requireCondition(
            latest?.input === canonical(input),
            'SUBJECT_EXISTS',
            'Există deja o propunere pentru acest obiect. Revizuiți propunerea existentă.',
            409,
            { proposalId: existing.id, version: latest?.version ?? 0 },
          );
          return this.view(tx, actor.companyId, existing.id);
        } else {
          proposalId = this.commands.ids();
          await tx.insert(proposals).values({
            id: proposalId,
            companyId: actor.companyId,
            treatmentId: treatment.id,
            subjectKey,
            documentId: await this.documentOf(tx, actor.companyId, declared, input),
            createdBy: actor.actorId,
          });
        }
        const version = (latest?.version ?? 0) + 1;
        const previous = revision && latest?.basis ? (JSON.parse(latest.basis) as Basis) : null;
        const template = await this.templateBasis(
          tx,
          actor.companyId,
          treatment.id,
          input,
          basisInput?.template,
          basisInput === undefined ? previous?.template : undefined,
        );
        // A proposal citing a template that names a vehicle cites the answer about its use that
        // holds, as the template's input followed it (the same answer an agent would reuse).
        const held = template ? await this.templates!.answers(tx, actor.companyId, template) : [];
        const cited = basisInput ?? previous;
        const basis = basisOf({ answers: [...(cited?.answers ?? []), ...held] }, template);
        if (basisInput !== undefined) await this.requireAnswered(tx, actor.companyId, basis);
        const evaluated = await this.evaluate(
          tx,
          actor.companyId,
          proposalId,
          treatment,
          input,
          basis,
        );
        await tx.insert(proposalVersions).values({
          companyId: actor.companyId,
          proposalId,
          version,
          treatmentVersion: treatment.version,
          input: canonical(input),
          readSet: canonical(evaluated.readSet),
          rules: canonical(evaluated.rules),
          rulesHash: evaluated.rulesHash,
          effect: evaluated.effect ? canonical(evaluated.effect) : null,
          issues: canonical(evaluated.issues),
          blocking: evaluated.blocking,
          effectHash: evaluated.effectHash,
          entryDate: evaluated.effect?.date ?? null,
          basis: basis ? canonical(basis) : null,
          fingerprint: evaluated.effect ? effectFingerprint(evaluated.effect) : null,
          createdBy: actor.actorId,
          agentId: actor.agentId ?? null,
          engineAt: this.clock(),
        });
        if (!evaluated.blocking) {
          const policy = await this.policies.match(
            tx,
            actor.companyId,
            {
              treatmentId: treatment.id,
              input,
              evaluated,
              work: { createdBy: actor.actorId, agentId: actor.agentId ?? null },
            },
            await segregationOn(tx, actor.companyId, this.today()),
          );
          if (policy) {
            const entry = await this.write(tx, actor, proposalId, version, evaluated, {
              policyId: policy.id,
            });
            // The posting is the policy's, not the proposer's: it gets its own audit row.
            await appendAudit(tx, {
              companyId: actor.companyId,
              actorId: actor.actorId,
              ...(actor.agentId ? { agentId: actor.agentId } : {}),
              action: 'policies.applied',
              body: { policyId: policy.id, proposalId, entryId: entry.id },
            });
          }
        }
        return this.view(tx, actor.companyId, proposalId);
      },
    );
  }

  /** Every question a basis cites is the company's and answered. */
  private async requireAnswered(tx: Transaction, companyId: string, basis: Basis | null) {
    if (!basis?.answers.length) return;
    const asked = new Set(
      (
        await tx
          .select({ id: questions.id })
          .from(questions)
          .where(and(eq(questions.companyId, companyId), inArray(questions.id, basis.answers)))
      ).map((row) => row.id),
    );
    const missing = basis.answers.filter((id) => !asked.has(id));
    requireCondition(!missing.length, 'QUESTION_NOT_FOUND', 'Întrebarea citată nu există.', 404, {
      questions: missing,
    });
    const unanswered = (await answerReads(tx, companyId, basis))
      .filter((read) => !read.version)
      .map((read) => read.id);
    requireCondition(
      !unanswered.length,
      'QUESTION_UNANSWERED',
      'Propunerea poate cita doar întrebări la care s-a răspuns.',
      409,
      { questions: unanswered },
    );
  }

  /** Revises an open proposal through its own treatment (`proposals.revise`). */
  async revise(
    actor: Actor,
    key: string,
    input: { proposalId: string; version: number; input: unknown; basis?: BasisInput },
  ) {
    const [proposal] = await this.commands.db.read((tx) =>
      tx
        .select({ treatmentId: proposals.treatmentId })
        .from(proposals)
        .where(and(eq(proposals.companyId, actor.companyId), eq(proposals.id, input.proposalId))),
    );
    requireCondition(proposal, 'NOT_FOUND', 'Propunerea nu este disponibilă.', 404);
    return this.propose(
      actor,
      key,
      proposal.treatmentId,
      input.input,
      { proposalId: input.proposalId, version: input.version },
      input.basis,
    );
  }

  /** Human approval of one exact version, including every warning it carries. */
  async approve(
    actor: Actor,
    key: string,
    input: { proposalId: string; version: number; effectHash: string; acknowledge: string[] },
  ) {
    requireCondition(!actor.agentId, 'AGENT_SCOPE', 'Aprobarea aparține unei persoane.', 403);
    return this.commands.run(
      actor,
      key,
      'proposals.approve',
      input,
      'review',
      async (tx, access) => {
        const row = await this.current(tx, actor.companyId, input.proposalId, input.version);
        requireCondition(
          row.effectHash === input.effectHash,
          'STALE',
          'Versiunea verificată nu mai este actuală.',
          409,
        );
        requireCondition(
          !row.blocking,
          'BLOCKING_ISSUES',
          'Propunerea are probleme care împiedică aprobarea.',
          409,
        );
        requireSegregated(
          await segregationOn(tx, actor.companyId, this.today()),
          actor.actorId,
          { createdBy: row.createdBy, agentId: row.agentId },
          'proposal',
        );
        const required = (JSON.parse(row.issues) as Issue[])
          .filter((issue) => issue.severity === 'ack')
          .map((issue) => issue.code);
        requireCondition(
          required.every((code) => input.acknowledge.includes(code)),
          'ACKNOWLEDGEMENT_REQUIRED',
          'Confirmați fiecare avertisment al propunerii înainte de aprobare.',
          409,
          { required },
        );
        const [existing] = await tx
          .select()
          .from(approvals)
          .where(
            and(
              eq(approvals.companyId, actor.companyId),
              eq(approvals.proposalId, input.proposalId),
              eq(approvals.version, input.version),
            ),
          );
        if (!existing)
          await tx.insert(approvals).values({
            id: this.commands.ids(),
            companyId: actor.companyId,
            proposalId: input.proposalId,
            version: input.version,
            effectHash: input.effectHash,
            approverId: actor.actorId,
            approverEpoch: access.epoch,
            acknowledgements: canonical([...new Set(input.acknowledge)].sort()),
            engineAt: this.clock(),
          });
        return this.view(tx, actor.companyId, input.proposalId);
      },
    );
  }

  /** Posts an approved version after re-evaluating it against the current books. */
  async post(
    actor: Actor,
    key: string,
    input: { proposalId: string; version: number; effectHash: string },
  ) {
    return this.commands.run(actor, key, 'ledger.post', input, 'review', async (tx) => {
      const [posted] = await tx
        .select({ id: entries.id })
        .from(entries)
        .where(
          and(eq(entries.companyId, actor.companyId), eq(entries.proposalId, input.proposalId)),
        );
      if (posted) return this.view(tx, actor.companyId, input.proposalId);
      const row = await this.current(tx, actor.companyId, input.proposalId, input.version);
      requireCondition(
        row.effectHash === input.effectHash,
        'STALE',
        'Versiunea verificată nu mai este actuală.',
        409,
      );
      const [approval] = await tx
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, actor.companyId),
            eq(approvals.proposalId, input.proposalId),
            eq(approvals.version, input.version),
            eq(approvals.effectHash, input.effectHash),
          ),
        );
      requireCondition(
        approval,
        'APPROVAL_REQUIRED',
        'Aprobați versiunea exactă înainte de contabilizare.',
        409,
      );
      await requireActiveApprover(
        tx,
        actor.companyId,
        { userId: approval.approverId, epoch: approval.approverEpoch },
        'Persoana care a aprobat versiunea nu mai este proprietar sau revizor activ. Revizuiți propunerea și cereți o aprobare nouă.',
      );
      const [proposal] = await tx
        .select()
        .from(proposals)
        .where(and(eq(proposals.companyId, actor.companyId), eq(proposals.id, input.proposalId)));
      const treatment = this.treatment(proposal!.treatmentId);
      // Re-parsing must reproduce the stored input exactly; a non-idempotent schema shows up as STALE.
      const stored = treatment.input.parse(JSON.parse(row.input));
      const evaluated = await this.evaluate(
        tx,
        actor.companyId,
        input.proposalId,
        treatment,
        stored,
        storedBasis(row),
      );
      requireCondition(
        evaluated.effectHash === row.effectHash,
        'STALE',
        'Registrele s-au schimbat de la aprobare. Revizuiți propunerea.',
        409,
        { issues: evaluated.issues },
      );
      await this.write(tx, actor, input.proposalId, input.version, evaluated, {
        approvalId: approval.id,
      });
      return this.view(tx, actor.companyId, input.proposalId);
    });
  }

  /**
   * Where a version a batch names stands now: `ready` when it is the proposal's latest, unposted
   * and not withdrawn, with the effect hash named, without blocking issues or warnings to
   * acknowledge, and a re-evaluation against the current books gives the same effect hash.
   */
  async batchMember(tx: Transaction, companyId: string, member: BatchMember) {
    const [proposal] = await tx
      .select()
      .from(proposals)
      .where(and(eq(proposals.companyId, companyId), eq(proposals.id, member.proposalId)));
    if (!proposal) return { state: 'missing' as MemberState, proposal: null, row: null };
    const row = (await this.latestVersion(tx, companyId, member.proposalId))!;
    const [posted] = await tx
      .select({ id: entries.id })
      .from(entries)
      .where(and(eq(entries.companyId, companyId), eq(entries.proposalId, member.proposalId)));
    const [withdrawn] = await tx
      .select({ id: withdrawals.proposalId })
      .from(withdrawals)
      .where(
        and(eq(withdrawals.companyId, companyId), eq(withdrawals.proposalId, member.proposalId)),
      );
    const state: MemberState = posted
      ? 'posted'
      : withdrawn
        ? 'withdrawn'
        : row.version !== member.version
          ? 'superseded'
          : row.effectHash !== member.effectHash
            ? 'changed'
            : row.blocking
              ? 'blocked'
              : (JSON.parse(row.issues) as Issue[]).some((issue) => issue.severity === 'ack')
                ? 'acknowledgement'
                : 'ready';
    if (state !== 'ready') return { state, proposal, row };
    const check = await this.recheck(tx, companyId, member.proposalId);
    return { state: check?.stale ? ('stale' as const) : state, proposal, row };
  }

  /** Who a version was created in the name of, and through which grant. */
  async authorOf(tx: Transaction, companyId: string, member: BatchMember) {
    const [row] = await tx
      .select({ createdBy: proposalVersions.createdBy, agentId: proposalVersions.agentId })
      .from(proposalVersions)
      .where(
        and(
          eq(proposalVersions.companyId, companyId),
          eq(proposalVersions.proposalId, member.proposalId),
          eq(proposalVersions.version, member.version),
        ),
      );
    return row;
  }

  /**
   * Approves and posts one member of an approved batch in the caller's transaction: the approval
   * is the batch decider's (`inv:batch_member`), under segregation of duties for this version.
   * Refused when posting the members before it changed what this one reads.
   */
  async postBatchMember(
    tx: Transaction,
    actor: Actor,
    member: BatchMember,
    batch: { requestId: string; decidedBy: string; decidedEpoch: number; segregation: Segregation },
  ) {
    const row = await this.current(tx, actor.companyId, member.proposalId, member.version);
    requireCondition(
      row.effectHash === member.effectHash,
      'STALE',
      'Versiunea din lot nu mai este actuală.',
      409,
      { members: [member.proposalId] },
    );
    requireSegregated(
      batch.segregation,
      batch.decidedBy,
      { createdBy: row.createdBy, agentId: row.agentId },
      'proposal',
    );
    const [proposal] = await tx
      .select()
      .from(proposals)
      .where(and(eq(proposals.companyId, actor.companyId), eq(proposals.id, member.proposalId)));
    const treatment = this.treatment(proposal!.treatmentId);
    const evaluated = await this.evaluate(
      tx,
      actor.companyId,
      member.proposalId,
      treatment,
      treatment.input.parse(JSON.parse(row.input)),
      storedBasis(row),
    );
    requireCondition(
      evaluated.effectHash === row.effectHash,
      'BATCH_CONFLICT',
      'Contabilizarea propunerilor dinaintea ei din lot schimbă ce citește această propunere: scoateți-o din lot și aprobați-o separat.',
      409,
      { proposalId: member.proposalId },
    );
    const approvalId = this.commands.ids();
    await tx.insert(approvals).values({
      id: approvalId,
      companyId: actor.companyId,
      proposalId: member.proposalId,
      version: member.version,
      effectHash: member.effectHash,
      approverId: batch.decidedBy,
      approverEpoch: batch.decidedEpoch,
      acknowledgements: canonical([]),
      batchRequestId: batch.requestId,
      engineAt: this.clock(),
    });
    const entry = await this.write(tx, actor, member.proposalId, member.version, evaluated, {
      approvalId,
    });
    return { proposalId: member.proposalId, entryId: entry.id, number: entry.number };
  }

  /**
   * Posts, under one policy, an open proposal whose latest version the policy now covers: in its
   * own transaction, in the name of `actor` (the system principal, for the worker's sweep), and
   * only when a re-evaluation against the current books gives the version's effect hash. Returns
   * the entry, or why it was left.
   */
  async sweepOne(actor: Actor, policyId: string, proposalId: string) {
    return this.commands.db.write(async (tx) => {
      const [proposal] = await tx
        .select()
        .from(proposals)
        .where(and(eq(proposals.companyId, actor.companyId), eq(proposals.id, proposalId)));
      const row = await this.latestVersion(tx, actor.companyId, proposalId);
      const [posted] = await tx
        .select({ id: entries.id })
        .from(entries)
        .where(and(eq(entries.companyId, actor.companyId), eq(entries.proposalId, proposalId)));
      const [withdrawn] = await tx
        .select({ id: withdrawals.proposalId })
        .from(withdrawals)
        .where(
          and(eq(withdrawals.companyId, actor.companyId), eq(withdrawals.proposalId, proposalId)),
        );
      const treatment = proposal && this.treatments.get(proposal.treatmentId);
      if (!proposal || !row || posted || withdrawn || row.blocking || !treatment)
        return { posted: false as const, reason: 'closed' };
      let evaluated: Evaluated;
      let input: unknown;
      try {
        input = treatment.input.parse(JSON.parse(row.input));
        evaluated = await this.evaluate(
          tx,
          actor.companyId,
          proposalId,
          treatment,
          input,
          storedBasis(row),
        );
      } catch (error) {
        if (error instanceof DomainError || error instanceof ZodError)
          return { posted: false as const, reason: 'stale' };
        throw error;
      }
      if (evaluated.effectHash !== row.effectHash)
        return { posted: false as const, reason: 'stale' };
      const policy = await this.policies.match(
        tx,
        actor.companyId,
        {
          treatmentId: treatment.id,
          input,
          evaluated,
          work: { createdBy: row.createdBy, agentId: row.agentId },
        },
        await segregationOn(tx, actor.companyId, this.today()),
        policyId,
      );
      if (!policy) return { posted: false as const, reason: 'conditions' };
      const entry = await this.write(tx, actor, proposalId, row.version, evaluated, { policyId });
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.actorId,
        action: 'policies.applied',
        body: { policyId, proposalId, entryId: entry.id, swept: true },
      });
      return { posted: true as const, entryId: entry.id };
    });
  }

  /** Open proposals whose latest version is not blocked and is one of these treatments, in
   * creation order: what a new policy may sweep. */
  async openOf(tx: Transaction, companyId: string, treatmentIds: string[], limit: number) {
    if (!treatmentIds.length) return [];
    const rows = await tx
      .select({ id: proposals.id })
      .from(proposals)
      .where(
        and(
          eq(proposals.companyId, companyId),
          inArray(proposals.treatmentId, treatmentIds),
          // Qualified by hand: a single-table select leaves its columns unqualified, and inside
          // a subquery they would bind to the subquery's own table.
          sql.raw(`not exists (select 1 from acc_entries e
            where e.company_id = "acc_proposals"."company_id" and e.proposal_id = "acc_proposals"."id")`),
          sql.raw(`not exists (select 1 from acc_withdrawals w
            where w.company_id = "acc_proposals"."company_id" and w.proposal_id = "acc_proposals"."id")`),
        ),
      )
      .orderBy(asc(proposals.createdAt), asc(proposals.id))
      .limit(limit);
    return rows.map((row) => row.id);
  }

  async withdraw(actor: Actor, key: string, input: { proposalId: string; reason: string }) {
    return this.commands.run(actor, key, 'proposals.withdraw', input, 'write', async (tx) => {
      await this.current(tx, actor.companyId, input.proposalId);
      await tx.insert(withdrawals).values({
        companyId: actor.companyId,
        proposalId: input.proposalId,
        reason: input.reason,
        createdBy: actor.actorId,
      });
      return this.view(tx, actor.companyId, input.proposalId);
    });
  }

  /** Writes the evaluated effect; the database invariants verify it once more. */
  private async write(
    tx: Transaction,
    actor: Actor,
    proposalId: string,
    version: number,
    evaluated: Evaluated,
    binding: { approvalId: string } | { policyId: string },
  ) {
    const effect = evaluated.effect!;
    const { loaded } = await loadState(tx, actor.companyId, {});
    const year = financialYearOf(loaded, effect.date);
    requireCondition(
      year,
      'FINANCIAL_YEAR',
      'Data nu aparține unui exercițiu financiar configurat.',
    );
    return writeEntry(
      tx,
      {
        companyId: actor.companyId,
        id: derivedId(proposalId, 'entry'),
        fiscalYearId: year.id,
        proposalId,
        version,
        ...binding,
        postedBy: actor.actorId,
        ...(actor.agentId ? { agentId: actor.agentId } : {}),
        engineAt: this.clock(),
      },
      effect,
    );
  }

  private async latestVersion(tx: Transaction, companyId: string, proposalId: string) {
    const [row] = await tx
      .select()
      .from(proposalVersions)
      .where(
        and(eq(proposalVersions.companyId, companyId), eq(proposalVersions.proposalId, proposalId)),
      )
      .orderBy(desc(proposalVersions.version))
      .limit(1);
    return row;
  }

  /** The latest version of an open proposal; optionally it must be `version`. */
  private async current(tx: Transaction, companyId: string, proposalId: string, version?: number) {
    const row = await this.latestVersion(tx, companyId, proposalId);
    requireCondition(row, 'NOT_FOUND', 'Propunerea nu este disponibilă.', 404);
    requireCondition(
      version === undefined || row.version === version,
      'STALE',
      'Propunerea s-a schimbat. Reîncărcați datele.',
      409,
    );
    const [withdrawn] = await tx
      .select()
      .from(withdrawals)
      .where(and(eq(withdrawals.companyId, companyId), eq(withdrawals.proposalId, proposalId)));
    requireCondition(!withdrawn, 'WITHDRAWN', 'Propunerea a fost retrasă.', 409);
    const [posted] = await tx
      .select({ id: entries.id })
      .from(entries)
      .where(and(eq(entries.companyId, companyId), eq(entries.proposalId, proposalId)));
    requireCondition(!posted, 'ALREADY_POSTED', 'Propunerea este deja contabilizată.', 409);
    return row;
  }

  /**
   * Re-evaluates the latest version of an open proposal against the current books, as posting
   * would, and writes nothing; null for a posted or withdrawn proposal. A version that can no
   * longer be evaluated (its treatment or input refused) is stale too.
   */
  async recheck(
    tx: Transaction,
    companyId: string,
    proposalId: string,
  ): Promise<ProposalCheck | null> {
    const [proposal] = await tx
      .select()
      .from(proposals)
      .where(and(eq(proposals.companyId, companyId), eq(proposals.id, proposalId)));
    requireCondition(proposal, 'NOT_FOUND', 'Propunerea nu este disponibilă.', 404);
    const [posted] = await tx
      .select({ id: entries.id })
      .from(entries)
      .where(and(eq(entries.companyId, companyId), eq(entries.proposalId, proposalId)));
    const [withdrawn] = await tx
      .select({ id: withdrawals.proposalId })
      .from(withdrawals)
      .where(and(eq(withdrawals.companyId, companyId), eq(withdrawals.proposalId, proposalId)));
    const row = await this.latestVersion(tx, companyId, proposalId);
    if (posted || withdrawn || !row) return null;
    const checkedSeq = await auditHead(tx, companyId);
    const found = { proposalId, version: row.version, checkedSeq };
    const treatment = this.treatments.get(proposal.treatmentId);
    try {
      requireCondition(treatment, 'TREATMENT', 'Tratamentul contabil nu este disponibil.', 404);
      const input = treatment.input.parse(JSON.parse(row.input));
      const evaluated = await this.evaluate(
        tx,
        companyId,
        proposalId,
        treatment,
        input,
        storedBasis(row),
      );
      const stale = evaluated.effectHash !== row.effectHash;
      return { ...found, stale, changed: stale ? changesOf(row, treatment, evaluated) : [] };
    } catch (error) {
      if (!(error instanceof DomainError || error instanceof ZodError)) throw error;
      const code = error instanceof DomainError ? error.code : 'VALIDATION';
      return {
        ...found,
        stale: true,
        changed: [{ kind: 'error', id: code, before: null, after: error.message.slice(0, 500) }],
      };
    }
  }

  /** Rechecks a proposal and caches the result, in two transactions; the cache keeps the latest. */
  async refreshCheck(companyId: string, proposalId: string) {
    const check = await this.commands.db.read((tx) => this.recheck(tx, companyId, proposalId));
    if (check) await this.commands.db.write((tx) => saveCheck(tx, companyId, check));
    return check;
  }

  /** Open proposals whose latest version has no cached check as of audit `since` or later, in
   * creation order. */
  async unchecked(tx: Transaction, companyId: string, since: number, limit: number) {
    const latest = tx
      .select({
        proposalId: proposalVersions.proposalId,
        version: sql<number>`max(${proposalVersions.version})`.as('latest_version'),
      })
      .from(proposalVersions)
      .where(eq(proposalVersions.companyId, companyId))
      .groupBy(proposalVersions.proposalId)
      .as('latest');
    const rows = await tx
      .select({ id: proposals.id })
      .from(proposals)
      .innerJoin(latest, eq(latest.proposalId, proposals.id))
      .leftJoin(
        proposalChecks,
        and(
          eq(proposalChecks.companyId, proposals.companyId),
          eq(proposalChecks.proposalId, proposals.id),
          eq(proposalChecks.version, latest.version),
          gte(proposalChecks.checkedSeq, since),
        ),
      )
      .where(
        and(
          eq(proposals.companyId, companyId),
          isNull(proposalChecks.proposalId),
          notExists(
            tx
              .select({ id: entries.id })
              .from(entries)
              .where(
                and(
                  eq(entries.companyId, proposals.companyId),
                  eq(entries.proposalId, proposals.id),
                ),
              ),
          ),
          notExists(
            tx
              .select({ id: withdrawals.proposalId })
              .from(withdrawals)
              .where(
                and(
                  eq(withdrawals.companyId, proposals.companyId),
                  eq(withdrawals.proposalId, proposals.id),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(proposals.createdAt), asc(proposals.id))
      .limit(limit);
    return rows.map((row) => row.id);
  }

  /** A proposal; with `recheck`, after re-evaluating it against the books and caching that. */
  async get(actor: Actor, proposalId: string, recheck = false) {
    if (recheck) {
      const check = await this.commands.read(actor, 'proposals.get', (tx) =>
        this.recheck(tx, actor.companyId, proposalId),
      );
      if (check) await this.commands.db.write((tx) => saveCheck(tx, actor.companyId, check));
    }
    return this.commands.read(actor, 'proposals.get', async (tx) => {
      const [view] = await this.disclosed(
        tx,
        actor,
        [await this.view(tx, actor.companyId, proposalId)],
        true,
      );
      return view!;
    });
  }

  /** Proposals in creation order, optionally only those in one status; with `withInput`, each
   * with its version's input. */
  list(
    actor: Actor,
    input: {
      status?: ProposalView['status'];
      after?: string;
      limit: number;
      withInput?: boolean;
    },
  ) {
    return this.commands.read(actor, 'proposals.list', async (tx) => {
      const rows = await tx
        .select()
        .from(proposals)
        .where(eq(proposals.companyId, actor.companyId))
        .orderBy(asc(proposals.createdAt), asc(proposals.id));
      const start = input.after ? rows.findIndex((row) => row.id === input.after) + 1 : 0;
      const views = (await this.views(tx, actor.companyId, rows.slice(start))).filter(
        (view) => !input.status || view.status === input.status,
      );
      const page = views.slice(0, input.limit);
      return {
        items: await this.disclosed(tx, actor, page, input.withInput ?? false),
        next: views.length > input.limit ? page.at(-1)!.id : null,
      };
    });
  }

  /**
   * What a read discloses beyond the view: with `withInput`, each version's input, what
   * `proposals.revise` starts from. The input and the basis go only to a caller who may read
   * every data class of the treatment, as `events.since` decides (`Commands.readable`): a person,
   * or an agent whose grant's reads cover them; otherwise both are null and the view `redacted`.
   */
  private async disclosed(
    tx: Transaction,
    actor: Actor,
    views: ProposalView[],
    withInput: boolean,
  ): Promise<ProposalView[]> {
    if (!views.length) return views;
    const readable = await this.commands.readable(tx, actor);
    const inputs = new Map<string, string>();
    if (withInput)
      for (const row of await tx
        .select({
          proposalId: proposalVersions.proposalId,
          version: proposalVersions.version,
          input: proposalVersions.input,
        })
        .from(proposalVersions)
        .where(
          and(
            eq(proposalVersions.companyId, actor.companyId),
            inArray(
              proposalVersions.proposalId,
              views.map((view) => view.id),
            ),
          ),
        ))
        inputs.set(`${row.proposalId}/${row.version}`, row.input);
    return views.map((view): ProposalView => {
      // The data classes of the treatment's own operation; an unknown treatment's are unknown.
      const classes = this.commands.dataClassesOf(`${view.treatment}.propose`);
      if (actor.agentId && !(classes && readable(classes)))
        return { ...view, basis: null, ...(withInput ? { input: null } : {}), redacted: true };
      const stored = inputs.get(`${view.id}/${view.version}`);
      return withInput && stored
        ? { ...view, input: JSON.parse(stored) as Record<string, unknown> }
        : view;
    });
  }

  async view(tx: Transaction, companyId: string, proposalId: string): Promise<ProposalView> {
    const [proposal] = await tx
      .select()
      .from(proposals)
      .where(and(eq(proposals.companyId, companyId), eq(proposals.id, proposalId)));
    requireCondition(proposal, 'NOT_FOUND', 'Propunerea nu este disponibilă.', 404);
    return (await this.views(tx, companyId, [proposal]))[0]!;
  }

  async views(tx: Transaction, companyId: string, rows: (typeof proposals.$inferSelect)[]) {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const versions = await tx
      .select()
      .from(proposalVersions)
      .where(
        and(eq(proposalVersions.companyId, companyId), inArray(proposalVersions.proposalId, ids)),
      );
    const latest = new Map<string, (typeof versions)[number]>();
    for (const version of versions)
      if ((latest.get(version.proposalId)?.version ?? 0) < version.version)
        latest.set(version.proposalId, version);
    const approvalRows = await tx
      .select()
      .from(approvals)
      .where(and(eq(approvals.companyId, companyId), inArray(approvals.proposalId, ids)));
    const entryRows = await tx
      .select({
        id: entries.id,
        proposalId: entries.proposalId,
        number: entries.number,
        seq: entries.seq,
        policyId: entries.policyId,
        postedBy: entries.postedBy,
        agentId: entries.agentId,
      })
      .from(entries)
      .where(and(eq(entries.companyId, companyId), inArray(entries.proposalId, ids)));
    const withdrawn = new Set(
      (
        await tx
          .select({ proposalId: withdrawals.proposalId })
          .from(withdrawals)
          .where(and(eq(withdrawals.companyId, companyId), inArray(withdrawals.proposalId, ids)))
      ).map((row) => row.proposalId),
    );
    // The answers the latest versions cite, as each version read them.
    const cited = new Map<string, { questionId: string; answerId: string | null }[]>();
    for (const version of latest.values())
      if (version.basis)
        cited.set(
          version.proposalId,
          (JSON.parse(version.readSet) as ReadSetEntry[])
            .filter((entry) => entry.kind === 'answer')
            .map((entry) => ({ questionId: entry.id, answerId: entry.version || null })),
        );
    const answerIds = [...cited.values()].flatMap((items) =>
      items.flatMap((item) => (item.answerId ? [item.answerId] : [])),
    );
    const answerRows = new Map(
      (answerIds.length
        ? await tx
            .select({
              id: questionAnswers.id,
              value: questionAnswers.value,
              kind: questions.kind,
            })
            .from(questionAnswers)
            .innerJoin(
              questions,
              and(
                eq(questions.companyId, questionAnswers.companyId),
                eq(questions.id, questionAnswers.questionId),
              ),
            )
            .where(
              and(eq(questionAnswers.companyId, companyId), inArray(questionAnswers.id, answerIds)),
            )
        : []
      ).map((row) => [row.id, row]),
    );
    const checks = new Map(
      (
        await tx
          .select()
          .from(proposalChecks)
          .where(
            and(eq(proposalChecks.companyId, companyId), inArray(proposalChecks.proposalId, ids)),
          )
      ).map((row) => [row.proposalId, row]),
    );
    return rows.map((proposal): ProposalView => {
      const version = latest.get(proposal.id)!;
      const cached = checks.get(proposal.id);
      const approval = approvalRows.find(
        (row) =>
          row.proposalId === proposal.id &&
          row.version === version.version &&
          row.effectHash === version.effectHash,
      );
      const entry = entryRows.find((row) => row.proposalId === proposal.id);
      const rules = JSON.parse(version.rules) as ProposalView['rules'];
      // Only a check of the current version of an open proposal says anything.
      const check =
        cached && cached.version === version.version && !entry && !withdrawn.has(proposal.id)
          ? {
              seq: cached.checkedSeq,
              stale: cached.stale,
              changed: JSON.parse(cached.changed) as ProposalChange[],
            }
          : null;
      return {
        id: proposal.id,
        treatment: proposal.treatmentId,
        subject: proposal.subjectKey,
        status: entry
          ? 'posted'
          : withdrawn.has(proposal.id)
            ? 'withdrawn'
            : check?.stale
              ? 'stale'
              : version.blocking
                ? 'blocked'
                : approval
                  ? 'approved'
                  : 'proposed',
        version: version.version,
        effectHash: version.effectHash,
        rulesHash: version.rulesHash,
        rules: { mode: rules.mode, used: rules.used.map(({ id, status }) => ({ id, status })) },
        issues: JSON.parse(version.issues),
        effect: version.effect ? viewEffect(JSON.parse(version.effect) as StoredEffect) : null,
        approval: approval
          ? {
              id: approval.id,
              approverId: approval.approverId,
              at: approval.createdAt,
              ...(approval.batchRequestId ? { batchId: approval.batchRequestId } : {}),
            }
          : null,
        entry: entry
          ? {
              id: entry.id,
              number: entry.number,
              seq: entry.seq,
              policyId: entry.policyId,
              postedBy: entry.postedBy,
              agentId: entry.agentId,
            }
          : null,
        createdBy: version.createdBy,
        agentId: version.agentId,
        check,
        basis: cited.has(proposal.id)
          ? {
              answers: cited.get(proposal.id)!.map((item) => {
                const answer = item.answerId ? answerRows.get(item.answerId) : undefined;
                return {
                  questionId: item.questionId,
                  answerId: item.answerId,
                  kind: answer?.kind ?? null,
                  value: answer ? (JSON.parse(answer.value) as unknown) : null,
                };
              }),
              ...(storedBasis(version)?.template
                ? { template: storedBasis(version)!.template! }
                : {}),
            }
          : null,
      };
    });
  }
}
