import { z } from 'zod';
import type { AnswerRecord, Loaded } from '../../kernel';
import type { QuestionKind } from '../../questions/kinds';

/*
 * What retail asks people (agent-ready, `retail/agent.ts`): the goods a fiscal cash register's
 * day sold, when its Z report gives only totals and the company keeps its goods by quantity at
 * cost (the stock register, G1). The answer names the warehouse and each item with its quantity,
 * citing the register's report by article or the keeper's report (raportul de gestiune); it holds
 * for that report only.
 */

export const zGoodsAnswer = z
  .object({
    warehouseId: z.uuid(),
    lines: z
      .array(
        z
          .object({
            itemId: z.uuid(),
            quantity: z
              .string()
              .regex(/^(0|[1-9]\d{0,14})(\.\d{1,3})?$/)
              .refine((value) => Number(value) > 0, 'Cantitatea este pozitivă.'),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
    /** The report by article, the keeper's report or another record of the goods sold. */
    evidenceId: z.uuid(),
  })
  .strict();
export type ZGoodsAnswer = z.infer<typeof zGoodsAnswer>;

export const zGoods: QuestionKind<{ date?: string | undefined }, ZGoodsAnswer> = {
  id: 'retail.goods',
  summary:
    "The goods a register's Z report sold, when it gives only totals and goods are kept by quantity at cost: the warehouse and each item with its quantity, citing the report by article or the keeper's report.",
  holds: 'once',
  subjects: ['document'],
  params: z
    .object({
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    })
    .strict(),
  answer: () => zGoodsAnswer,
  prompt: (subject, params) =>
    `Raportul Z ${subject.id}${params.date ? ` din ${params.date}` : ''} arată doar totalurile zilei. Ce mărfuri au ieșit din gestiune (gestiunea, fiecare articol și cantitatea), după raportul pe articole al casei de marcat sau raportul de gestiune? Atașați documentul.`,
  evidence: (answer) => [answer.evidenceId],
};

/** The latest answer about a Z report's goods in the proposal's basis, if any. */
export function zGoodsAnswerOf(
  loaded: Loaded,
  documentId: string,
): { record: AnswerRecord; value: ZGoodsAnswer } | null {
  let found: { record: AnswerRecord; value: ZGoodsAnswer } | null = null;
  for (const record of loaded.answers.values()) {
    if (
      record.kind !== zGoods.id ||
      record.subject.kind !== 'document' ||
      record.subject.id !== documentId
    )
      continue;
    const parsed = zGoodsAnswer.safeParse(record.value);
    if (!parsed.success) continue;
    if (
      !found ||
      found.record.answeredAt < record.answeredAt ||
      (found.record.answeredAt === record.answeredAt && found.record.answerId < record.answerId)
    )
      found = { record, value: parsed.data };
  }
  return found;
}
