import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { canonical, hashOf } from 'xfactura-core/hash';
import {
  answerLifetimes,
  normalizeSubject,
  questionKind,
  questionKindIds,
  questionSubjectSchema,
  type QuestionKind,
  type QuestionSubject,
} from 'xfactura-core/questions/kinds';
import type { Transaction } from '../db/database';
import { answerMediaType } from '../db/invariants';
import { evidence, questionAnswers, questions, questionWithdrawals } from '../db/schema';
import type { ObjectStore } from '../adapters/object-store';
import { roleAllows, type Actor, type Commands } from '../kernel/commands';
import { q } from '../kernel/work';
import { profileInput, writeProfileFact } from './company';

/*
 * Questions to people. An agent asks (`questions.ask`) what the books depend on and nobody
 * recorded: the engine first looks for an answer that still holds (by the kind's lifetime) and
 * returns it, so a person is never asked twice; otherwise it opens the question. Only a person
 * answers. Each answer is kept as evidence, so the proposals that rely on it (their `basis`) and
 * the profile facts it records cite it; a later answer replaces an earlier one, and the proposals
 * citing the question become stale.
 */

const reason = z.string().trim().min(10).max(1000);
export const askInput = z
  .object({
    kind: z.enum(questionKindIds),
    subject: questionSubjectSchema,
    params: z.record(z.string(), z.unknown()).default({}),
    /** When the answer is needed by. */
    due: z.iso.date().optional(),
  })
  .strict();
export const answerInput = z
  .object({
    questionId: z.uuid(),
    /** The answer, as the kind's answer schema reads it (`questions.list` shows the prompt). */
    value: z.unknown(),
  })
  .strict();
export const withdrawInput = z.object({ questionId: z.uuid(), reason }).strict();
export const questionStatuses = ['open', 'answered', 'withdrawn'] as const;
export const questionQuery = z
  .object({
    status: z.enum(questionStatuses).optional(),
    kind: z.enum(questionKindIds).optional(),
    after: z.uuid().optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict();

export const questionView = z.object({
  id: z.string(),
  kind: z.string(),
  subject: z.object({ kind: z.string(), id: z.string() }),
  params: z.record(z.string(), z.unknown()),
  /** The question as a person reads it, in Romanian. */
  prompt: z.string(),
  /** What the kind asks, in English. */
  summary: z.string(),
  holds: z.enum(answerLifetimes),
  due: z.string().nullable(),
  status: z.enum(questionStatuses),
  askedBy: z.string(),
  agentId: z.string().nullable(),
  createdAt: z.string(),
  /** The latest answer: the one that holds. */
  answer: z
    .object({
      id: z.string(),
      seq: z.number(),
      value: z.unknown(),
      /** The answer kept as evidence (`application/vnd.xfactura.answer+json`). */
      evidenceId: z.string(),
      answeredBy: z.string(),
      at: z.string(),
    })
    .nullable(),
  /** The profile fact an answer to a `profile.fact` question recorded. */
  profileFactId: z.string().optional(),
  /** Every profile fact the answer recorded (a confirmed determination with its changes). */
  profileFactIds: z.array(z.string()).optional(),
});
export type QuestionView = z.infer<typeof questionView>;
export const askView = questionView.extend({
  /** True when an earlier question was returned: its answer still holds, or it awaits one. */
  reused: z.boolean(),
});

type QuestionRow = typeof questions.$inferSelect;
type AnswerRow = typeof questionAnswers.$inferSelect;

const kindOf = (id: string): QuestionKind => {
  const kind = questionKind(id);
  requireCondition(kind, 'QUESTION_KIND', 'Tipul întrebării nu este cunoscut.', 422);
  return kind;
};

/** A question with its latest answer and whether it was withdrawn. */
interface Asked {
  row: QuestionRow;
  answer: AnswerRow | null;
  withdrawn: boolean;
}

/** The questions with these ids, with their latest answers and withdrawals. */
async function load(tx: Transaction, companyId: string, rows: QuestionRow[]): Promise<Asked[]> {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const answers = await tx
    .select()
    .from(questionAnswers)
    .where(and(eq(questionAnswers.companyId, companyId), inArray(questionAnswers.questionId, ids)));
  const latest = new Map<string, AnswerRow>();
  for (const answer of answers)
    if ((latest.get(answer.questionId)?.seq ?? 0) < answer.seq)
      latest.set(answer.questionId, answer);
  const withdrawn = new Set(
    (
      await tx
        .select({ id: questionWithdrawals.questionId })
        .from(questionWithdrawals)
        .where(
          and(
            eq(questionWithdrawals.companyId, companyId),
            inArray(questionWithdrawals.questionId, ids),
          ),
        )
    ).map((row) => row.id),
  );
  return rows.map((row) => ({
    row,
    answer: latest.get(row.id) ?? null,
    withdrawn: withdrawn.has(row.id),
  }));
}

function view(asked: Asked): QuestionView {
  const { row, answer } = asked;
  const kind = kindOf(row.kind);
  const params = JSON.parse(row.params) as Record<string, unknown>;
  const subject = { kind: row.subjectKind, id: row.subjectId };
  return {
    id: row.id,
    kind: row.kind,
    subject,
    params,
    prompt: kind.prompt(subject, kind.params.parse(params)),
    summary: kind.summary,
    holds: kind.holds,
    due: row.due,
    status: answer ? 'answered' : asked.withdrawn ? 'withdrawn' : 'open',
    askedBy: row.askedBy,
    agentId: row.agentId,
    createdAt: row.createdAt,
    answer: answer
      ? {
          id: answer.id,
          seq: answer.seq,
          value: JSON.parse(answer.value) as unknown,
          evidenceId: answer.evidenceId,
          answeredBy: answer.answeredBy,
          at: answer.createdAt,
        }
      : null,
  };
}

/**
 * Where a question of a kind about a subject stands: the answered question whose answer still
 * holds for these parameters (by the kind's lifetime), and the open question, if any.
 * - `once`: an answer to the same parameters;
 * - `perPeriod`: an answer for the same period;
 * - `untilChanged`: the latest answer, whatever the parameters.
 * The subject is read as its kind spells it (`B-123-XFA` is the vehicle `B123XFA`).
 */
export async function standing(
  tx: Transaction,
  companyId: string,
  request: { kind: string; subject: QuestionSubject; params: unknown },
): Promise<{ answered: Asked | null; open: Asked | null; params: unknown }> {
  const kind = kindOf(request.kind);
  const params = kind.params.parse(request.params);
  const subject = normalizeSubject(kind.id, request.subject);
  const rows = await tx
    .select()
    .from(questions)
    .where(
      and(
        eq(questions.companyId, companyId),
        eq(questions.kind, request.kind),
        eq(questions.subjectKind, subject.kind),
        eq(questions.subjectId, subject.id),
      ),
    )
    .orderBy(asc(questions.createdAt), asc(questions.id));
  const asked = await load(tx, companyId, rows);
  const holds = (item: Asked) => {
    if (kind.holds === 'untilChanged') return true;
    const earlier = kind.params.parse(JSON.parse(item.row.params));
    if (kind.holds === 'perPeriod') return kind.period!(earlier) === kind.period!(params);
    return hashOf(earlier) === hashOf(params);
  };
  // The latest by the engine's time of the answer (an answer recorded before the engine kept it
  // counts as the earliest), then by the question's id: never the database's wall time.
  const answered = asked
    .filter((item) => item.answer && holds(item))
    .sort(
      (a, b) =>
        (a.answer!.engineAt ?? 0) - (b.answer!.engineAt ?? 0) ||
        (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0),
    )
    .at(-1);
  const open = asked.find((item) => !item.answer && !item.withdrawn) ?? null;
  return { answered: answered ?? null, open, params };
}

export class Questions {
  constructor(
    private readonly commands: Commands,
    private readonly objects: ObjectStore,
    private readonly clock: () => number = Date.now,
  ) {}

  private async find(tx: Transaction, companyId: string, id: string) {
    const [row] = await tx
      .select()
      .from(questions)
      .where(and(eq(questions.companyId, companyId), eq(questions.id, id)));
    requireCondition(row, 'NOT_FOUND', 'Întrebarea nu există.', 404);
    return (await load(tx, companyId, [row]))[0]!;
  }

  /** Returns the answer that still holds, or the question already open, or opens a new one. */
  ask(actor: Actor, key: string, input: z.infer<typeof askInput>) {
    return this.commands.run(actor, key, 'questions.ask', input, 'write', async (tx) => {
      const kind = kindOf(input.kind);
      requireCondition(
        kind.subjects.includes(input.subject.kind),
        'QUESTION_SUBJECT',
        `O întrebare ${kind.id} privește: ${kind.subjects.join(', ')}.`,
        422,
        { subjects: [...kind.subjects] },
      );
      // One spelling per subject, so that a treatment's issue, the worklist and the agent name
      // the same question.
      const subject = normalizeSubject(kind.id, input.subject);
      requireCondition(
        subject.id.length > 0,
        'QUESTION_SUBJECT',
        'Obiectul întrebării nu are identificator.',
        422,
        { subjects: [...kind.subjects] },
      );
      const found = await standing(tx, actor.companyId, { ...input, subject });
      if (found.answered) return { ...view(found.answered), reused: true };
      if (found.open) {
        // An answer that holds whatever the parameters is one question per subject: the open one
        // is returned as it was asked.
        requireCondition(
          kind.holds === 'untilChanged' ||
            hashOf(kind.params.parse(JSON.parse(found.open.row.params))) === hashOf(found.params),
          'QUESTION_OPEN',
          'Aceeași întrebare despre același obiect așteaptă deja un răspuns, cu alți parametri: retrageți-o întâi.',
          409,
          { questionId: found.open.row.id },
        );
        return { ...view(found.open), reused: true };
      }
      const id = this.commands.ids();
      await tx.insert(questions).values({
        id,
        companyId: actor.companyId,
        kind: input.kind,
        subjectKind: subject.kind,
        subjectId: subject.id,
        params: canonical(found.params),
        askedBy: actor.actorId,
        agentId: actor.agentId ?? null,
        due: input.due ?? null,
      });
      return { ...view(await this.find(tx, actor.companyId, id)), reused: false };
    });
  }

  /**
   * A person's answer, kept as evidence. Answering again replaces the earlier answer. A
   * `profile.fact` answer needs the review permission and records the fact itself, citing the
   * answer as its evidence.
   */
  answer(actor: Actor, key: string, input: z.infer<typeof answerInput>) {
    requireCondition(!actor.agentId, 'AGENT_SCOPE', 'Răspunsul aparține unei persoane.', 403);
    return this.commands.run(actor, key, 'questions.answer', input, 'write', async (tx, access) => {
      const asked = await this.find(tx, actor.companyId, input.questionId);
      requireCondition(!asked.withdrawn, 'QUESTION_WITHDRAWN', 'Întrebarea a fost retrasă.', 409);
      const kind = kindOf(asked.row.kind);
      const params = kind.params.parse(JSON.parse(asked.row.params));
      const value = kind.answer(params).parse(input.value);
      // Kinds whose answers record company facts (`profile.fact`, `determination.confirm`).
      const recordsFact = kind.facts !== undefined;
      requireCondition(
        !recordsFact || roleAllows(access.role, 'review'),
        'FORBIDDEN',
        'Un fapt al companiei se înregistrează de un proprietar sau un revizor.',
        403,
      );
      const cited = [...new Set(kind.evidence(value))];
      if (cited.length) {
        const kept = await tx
          .select({ id: evidence.id })
          .from(evidence)
          .where(and(eq(evidence.companyId, actor.companyId), inArray(evidence.id, cited)));
        requireCondition(
          kept.length === cited.length,
          'EVIDENCE',
          'Documentul justificativ nu este disponibil.',
          404,
          { missing: cited.filter((id) => !kept.some((row) => row.id === id)) },
        );
      }
      const id = this.commands.ids();
      const seq = (asked.answer?.seq ?? 0) + 1;
      const subject = { kind: asked.row.subjectKind, id: asked.row.subjectId };
      // The answer as evidence: what was asked, what the person answered, and when.
      const bytes = new TextEncoder().encode(
        canonical({
          schema: 'xfactura.answer@1',
          answerId: id,
          questionId: asked.row.id,
          seq,
          kind: kind.id,
          subject,
          params,
          prompt: kind.prompt(subject, params),
          value,
          evidence: cited,
          answeredBy: actor.actorId,
          answeredAt: new Date(this.clock()).toISOString(),
        }),
      );
      const hash = await this.objects.put(actor.companyId, bytes);
      const evidenceId = this.commands.ids();
      await tx.insert(evidence).values({
        id: evidenceId,
        companyId: actor.companyId,
        hash,
        filename: `raspuns-${asked.row.id}-${seq}.json`,
        mediaType: answerMediaType,
        size: bytes.length,
        createdBy: actor.actorId,
        engineAt: this.commands.clock(),
      });
      await tx.insert(questionAnswers).values({
        id,
        companyId: actor.companyId,
        questionId: asked.row.id,
        seq,
        value: canonical(value),
        evidenceId,
        answeredBy: actor.actorId,
        agentId: null,
        epoch: access.epoch,
        engineAt: this.clock(),
      });
      const profileFactIds: string[] = [];
      for (const fact of kind.facts?.(params, value) ?? [])
        profileFactIds.push(
          (
            await writeProfileFact(
              tx,
              actor,
              profileInput.parse({ ...fact, evidenceId }),
              this.commands.ids,
            )
          ).id,
        );
      const result = view(await this.find(tx, actor.companyId, asked.row.id));
      return profileFactIds.length
        ? { ...result, profileFactId: profileFactIds[0]!, profileFactIds }
        : result;
    });
  }

  /** Withdraws a question nobody answered. */
  withdraw(actor: Actor, key: string, input: z.infer<typeof withdrawInput>) {
    return this.commands.run(actor, key, 'questions.withdraw', input, 'write', async (tx) => {
      const asked = await this.find(tx, actor.companyId, input.questionId);
      requireCondition(!asked.answer, 'QUESTION_ANSWERED', 'Întrebarea are deja un răspuns.', 409);
      requireCondition(!asked.withdrawn, 'QUESTION_WITHDRAWN', 'Întrebarea a fost retrasă.', 409);
      await tx.insert(questionWithdrawals).values({
        companyId: actor.companyId,
        questionId: asked.row.id,
        reason: input.reason,
        createdBy: actor.actorId,
        agentId: actor.agentId ?? null,
      });
      return view(await this.find(tx, actor.companyId, asked.row.id));
    });
  }

  /** Questions in the order they were asked, by status or kind, a page at a time. */
  list(actor: Actor, input: z.infer<typeof questionQuery>) {
    return this.commands.read(actor, 'questions.list', async (tx) => {
      const answered = sql`exists (select 1 from ${questionAnswers} a
        where a.company_id = ${q(questions.companyId)} and a.question_id = ${q(questions.id)})`;
      const withdrawn = sql`exists (select 1 from ${questionWithdrawals} w
        where w.company_id = ${q(questions.companyId)} and w.question_id = ${q(questions.id)})`;
      let cursor: { createdAt: string; id: string } | undefined;
      if (input.after) {
        [cursor] = await tx
          .select({ createdAt: questions.createdAt, id: questions.id })
          .from(questions)
          .where(and(eq(questions.companyId, actor.companyId), eq(questions.id, input.after)));
        requireCondition(
          cursor,
          'NOT_FOUND',
          'Întrebarea de la care continuă lista nu există.',
          404,
        );
      }
      const rows = await tx
        .select()
        .from(questions)
        .where(
          and(
            eq(questions.companyId, actor.companyId),
            input.kind ? eq(questions.kind, input.kind) : undefined,
            input.status === 'answered'
              ? answered
              : input.status === 'withdrawn'
                ? and(sql`not ${answered}`, withdrawn)
                : input.status === 'open'
                  ? and(sql`not ${answered}`, sql`not ${withdrawn}`)
                  : undefined,
            cursor
              ? or(
                  gt(questions.createdAt, cursor.createdAt),
                  and(eq(questions.createdAt, cursor.createdAt), gt(questions.id, cursor.id)),
                )
              : undefined,
          ),
        )
        .orderBy(asc(questions.createdAt), asc(questions.id))
        .limit(input.limit + 1);
      const page = rows.slice(0, input.limit);
      return {
        items: (await load(tx, actor.companyId, page)).map(view),
        next: rows.length > input.limit ? page.at(-1)!.id : null,
      };
    });
  }
}
