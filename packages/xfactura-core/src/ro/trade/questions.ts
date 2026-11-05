import { z } from 'zod';
import type { QuestionKind } from '../../questions/kinds';
import { isLocalDate } from '../../time';
import { transportProofInput } from './proof';

/*
 * The questions of goods across the border (G3), answered by a person with the documents:
 * - `goods.proof`: the proof an exempt supply booked before it had it, which OMFP nr. 103/2016
 *   art. 1 alin. (4) lets follow within 90 days of the chargeable event: the transport to another
 *   Member State (Regulation (EU) No 282/2011 art. 45a), or the customs declaration of export with
 *   its exit certified (art. 2 alin. (2));
 * - `etransport.uit`: the UIT code RO e-Transport generated for a transport of goods (OUG nr.
 *   41/2022 art. 8, 11), or why the transport needed none (goods not of high fiscal risk, a
 *   transport outside the ordinance), with the document.
 */

const day = z.string().refine((value): boolean => isLocalDate(value), 'Dată invalidă.');
const define = <Params, Answer>(kind: QuestionKind<Params, Answer>) => kind;

export const goodsProofAnswer = z.union([
  z.object({ basis: z.literal('intra_eu'), transport: transportProofInput }).strict(),
  z.object({ basis: z.literal('export'), declarationId: z.uuid() }).strict(),
]);
export type GoodsProofAnswer = z.infer<typeof goodsProofAnswer>;

export const goodsProof = define({
  id: 'goods.proof',
  summary:
    'The proof of an exempt supply of goods booked before it had it (OMFP 103/2016 art. 1(4), within 90 days): the transport to another Member State (Reg. 282/2011 art. 45a) or the customs export declaration with the exit certified.',
  holds: 'untilChanged',
  subjects: ['document'],
  params: z
    .object({
      basis: z.enum(['intra_eu', 'export']),
      /** The chargeable event, from which the 90 days run. */
      supplied: day,
      due: day,
    })
    .strict(),
  answer: () => goodsProofAnswer,
  prompt: (subject, params) =>
    params.basis === 'intra_eu'
      ? `Livrarea intracomunitară a facturii ${subject.id} (din ${params.supplied}) este scutită dacă bunurile au fost transportate în alt stat membru. Indicați documentele transportului (CMR semnat, conosament, factura transportatorului, asigurarea, plata transportului, chitanța antrepozitarului; declarația cumpărătorului dacă el a transportat), cu emitenții lor, până la ${params.due} (OMFP nr. 103/2016 art. 1 alin. (4); Regulamentul (UE) nr. 282/2011 art. 45a).`
      : `Exportul facturii ${subject.id} (din ${params.supplied}) este scutit cu certificarea ieșirii bunurilor din Uniune. Înregistrați declarația vamală de export cu notificarea de ieșire (customs.declaration) și indicați-o, până la ${params.due} (OMFP nr. 103/2016 art. 2 alin. (2)).`,
  evidence: (answer) =>
    answer.basis === 'intra_eu'
      ? [
          ...answer.transport.documents.map((item) => item.evidenceId),
          ...(answer.transport.buyerStatement ? [answer.transport.buyerStatement.evidenceId] : []),
        ]
      : [],
});

export const etransportAnswer = z.union([
  z
    .object({
      /** The UIT code RO e-Transport generated. */
      uit: z.string().regex(/^[A-Z0-9]{10,20}$/),
      /** The day the data were declared, and the transport's declared start. */
      declaredOn: day,
      start: day,
      /** The system's confirmation, or the transport document carrying the code. */
      evidenceId: z.uuid(),
    })
    .strict(),
  z
    .object({
      required: z.literal(false),
      /** Why no code: goods outside the order of art. 15 alin. (2), a transport the ordinance
       * does not cover. */
      reason: z.string().trim().min(10).max(500),
      evidenceId: z.uuid().optional(),
    })
    .strict(),
]);
export type ETransportAnswer = z.infer<typeof etransportAnswer>;

export const etransportUit = define({
  id: 'etransport.uit',
  summary:
    "The RO e-Transport UIT code of a transport of goods (OUG 41/2022 art. 8, 11): declared at most 3 days before the transport's start and valid 5 days, or why the transport needed none.",
  holds: 'untilChanged',
  subjects: ['document'],
  params: z
    .object({
      /** What the transport is: an intra-community acquisition or supply, an import, an export. */
      flow: z.enum(['acquisition', 'supply', 'import', 'export']),
      date: day,
    })
    .strict(),
  answer: () => etransportAnswer,
  prompt: (subject, params) =>
    `Transportul bunurilor documentului ${subject.id} (${params.flow === 'acquisition' ? 'achiziție intracomunitară' : params.flow === 'supply' ? 'livrare intracomunitară' : params.flow === 'import' ? 'import' : 'export'}, ${params.date}) se declară în RO e-Transport dacă privește bunuri cu risc fiscal ridicat (OUG nr. 41/2022 art. 8): indicați codul UIT, data declarării și data începerii transportului, cu confirmarea; sau motivul pentru care nu s-a cerut cod.`,
  evidence: (answer) =>
    'uit' in answer ? [answer.evidenceId] : answer.evidenceId ? [answer.evidenceId] : [],
});
