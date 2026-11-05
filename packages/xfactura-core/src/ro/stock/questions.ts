import { z } from 'zod';
import type { QuestionKind } from '../../questions/kinds';

/*
 * What the stock register asks people (agent-ready, `stock/agent.ts`): which item of the
 * catalogue a supplier's product is. An agent maps each line of a purchase invoice to an item; a
 * product it cannot map with certainty is asked once, and the answer holds for the supplier's
 * product until changed, so later invoices reuse it.
 */

/** A supplier's product as the question names it: the supplier and the product's name on its
 * invoices, in capitals, its spaces collapsed. */
export const normalizeSupplierItem = (id: string) => id.trim().replace(/\s+/g, ' ').toUpperCase();

export const supplierItemAnswer = z
  .object({
    /** The catalogue's item the product is. */
    itemId: z.uuid(),
    /** How many of the item's units one unit of the invoice is (a box of 12 pieces: 12). */
    factor: z
      .string()
      .regex(/^(0|[1-9]\d{0,9})(\.\d{1,6})?$/)
      .refine((value) => Number(value) > 0, 'Factorul este pozitiv.'),
  })
  .strict();
export type SupplierItemAnswer = z.infer<typeof supplierItemAnswer>;

export const supplierItem: QuestionKind<
  { documentId?: string | undefined; line?: string | undefined },
  SupplierItemAnswer
> = {
  id: 'stock.item',
  summary:
    "Which catalogue item a supplier's product is, and how many of the item's units one invoice unit holds: asked once per supplier product, reused for its later invoices until changed.",
  holds: 'untilChanged',
  subjects: ['supplierItem'],
  normalize: normalizeSupplierItem,
  params: z
    .object({ documentId: z.uuid().optional(), line: z.string().min(1).max(100).optional() })
    .strict(),
  answer: () => supplierItemAnswer,
  prompt: (subject, params) =>
    `Ce articol din nomenclatorul de stocuri este produsul ${subject.id}${params.line ? ` (linia ${params.line} a facturii)` : ''}, și câte unități ale articolului conține o unitate de pe factură? Răspunsul se folosește la recepțiile următoare ale aceluiași produs.`,
  evidence: () => [],
};
