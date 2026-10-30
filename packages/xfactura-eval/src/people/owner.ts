import { hiddenAnswer, type Books, type QuestionView } from '../engine/books';
import { plateKey } from '../world/schema';

/** A question as the scores compare them: `<kind>:<what it is about>`. */
export async function questionKey(books: Books, question: QuestionView) {
  switch (question.kind) {
    case 'profile.fact':
      return `profile.fact:${question.subject.id}`;
    case 'vehicle.use':
      return `vehicle.use:${plateKey(question.subject.id)}`;
    default: {
      const file = await fileOfQuestion(books, question);
      return `${question.kind}:${file ?? `${question.subject.kind}:${question.subject.id}`}`;
    }
  }
}

/** The world file a question is about, from its subject or its parameters. */
export async function fileOfQuestion(books: Books, question: QuestionView) {
  const { kind, id } = question.subject;
  const params = question.params ?? {};
  if (kind === 'deferral' || kind === 'evidence')
    return books.fileOf.get(id.split(':')[0]!) ?? null;
  if (kind === 'document') return books.fileOfDocument(id);
  if (typeof params.documentId === 'string') return books.fileOfDocument(params.documentId);
  if (typeof params.evidenceId === 'string') return books.fileOf.get(params.evidenceId) ?? null;
  return null;
}

/**
 * The simulated owner: answers open questions from the world's hidden facts and nothing else.
 * A question the hidden facts do not settle stays open, as it would with a person who does not
 * know either.
 */
export class SimulatedOwner {
  readonly answered: string[] = [];
  readonly unanswerable = new Set<string>();

  constructor(private readonly books: Books) {}

  /** Answers what it can; returns how many it answered. */
  async answer() {
    let count = 0;
    for (const question of await this.books.questions()) {
      if (question.status !== 'open' || this.unanswerable.has(question.id)) continue;
      const value = hiddenAnswer(
        this.books.world,
        question,
        await fileOfQuestion(this.books, question),
      );
      if (!value) {
        this.unanswerable.add(question.id);
        continue;
      }
      await this.books.invoke('questions.answer', { questionId: question.id, value });
      this.answered.push(question.id);
      count += 1;
    }
    if (count) await this.books.project();
    return count;
  }
}
