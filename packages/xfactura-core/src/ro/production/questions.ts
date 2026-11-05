import { z } from 'zod';
import type { QuestionKind } from '../../questions/kinds';

/*
 * What production asks people (agent-ready, `production/agent.ts`): whether the materials a
 * closed work order consumed above its bill of materials' norm were a loss above the normally
 * admitted limits, which stays an expense of the period (OMFP nr. 1.802/2014 pct. 79), or a
 * normal consumption the norm did not foresee, which is part of the products' cost. The engine
 * computes the excess; it never decides it.
 */

export const excessAnswer = z
  .object({
    /** `abnormal`: a loss above the normal limits, left out of the cost; `normal`: part of it. */
    treatment: z.enum(['abnormal', 'normal']),
    /** The proces-verbal of the loss, or the technologist's note justifying the consumption. */
    evidenceId: z.uuid(),
  })
  .strict();
export type ExcessAnswer = z.infer<typeof excessAnswer>;

export const excessParams = z
  .object({
    /** The material consumed above the norm. */
    itemId: z.uuid(),
    /** The excess in thousandths of the material's unit, as the engine computed it. */
    quantity: z.string().regex(/^\d{1,15}(\.\d{1,3})?$/),
  })
  .strict();
export type ExcessParams = z.infer<typeof excessParams>;

export const productionExcess: QuestionKind<ExcessParams, ExcessAnswer> = {
  id: 'production.excess',
  summary:
    "Whether the materials a closed work order consumed above its bill of materials' norm were an abnormal loss (left out of the products' cost, pct. 79) or a normal consumption (part of it).",
  holds: 'once',
  subjects: ['workOrder'],
  params: excessParams,
  answer: () => excessAnswer,
  prompt: (subject, params) =>
    `Comanda de producție ${subject.id} a consumat peste norma din fișa tehnică ${params.quantity} unități din materialul ${params.itemId}. Este o pierdere peste limitele normal admise (rămâne cheltuială a perioadei, OMFP nr. 1.802/2014 pct. 79) sau un consum normal pe care norma nu l-a prevăzut (intră în costul produselor)? Atașați procesul-verbal sau nota tehnologului.`,
  evidence: (value) => [value.evidenceId],
};
