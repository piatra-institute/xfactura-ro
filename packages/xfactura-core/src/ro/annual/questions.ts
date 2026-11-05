import { z } from 'zod';
import type { QuestionKind } from '../../questions/kinds';

/*
 * What the annual statements ask people (agent-ready, `annual/agent.ts`): the informative data
 * the books do not hold, the facts the explanatory notes and the declaration state, and the
 * accompanying documents a person signs. Every answer is kept as evidence.
 */

const statement = z.enum(['S1005', 'S1003']);
const year = z.number().int().min(2000).max(2100);
const evidenceIds = z.array(z.uuid()).max(20);
const note = z.string().trim().min(3).max(4000).nullable();

/** The rows of a chapter of F30 the books do not give, with the columns to fill. */
export const informativeParams = z
  .object({
    statement,
    year,
    chapter: z.string().regex(/^[IVX]{1,5}$/),
    rows: z
      .array(
        z
          .object({
            row: z.string().regex(/^\d{1,3}[a-z]?$/),
            label: z.string().min(1).max(600),
            columns: z.array(z.number().int().min(1).max(4)).min(1).max(4),
          })
          .strict(),
      )
      .min(1)
      .max(120),
  })
  .strict();
export type InformativeParams = z.infer<typeof informativeParams>;

const cell = z.number().finite().min(-999_999_999_999_999).max(999_999_999_999_999).nullable();

/** A chapter of F30 the books do not hold: a person gives its rows or states it has nothing to
 * report, with the documents behind it (contracts, the shareholders' register, …). */
export const annualInformative: QuestionKind<
  InformativeParams,
  | { none: true; evidenceIds: string[] }
  | { rows: Record<string, (number | null)[]>; evidenceIds: string[] }
> = {
  id: 'annual.informative',
  summary:
    "A chapter of an annual statement's informative data (F30) that the books do not hold (royalties, rents, subsidies, R&D, the holders of the capital, overdue taxes, …): a person gives the rows asked, or states that the chapter has nothing to report, citing the documents.",
  holds: 'once',
  subjects: ['annual'],
  params: informativeParams,
  answer: (params) =>
    z.union([
      z.object({ none: z.literal(true), evidenceIds: evidenceIds.default([]) }).strict(),
      z
        .object({
          rows: z
            .record(z.string(), z.array(cell).max(4))
            .refine(
              (rows) =>
                Object.keys(rows).every((row) => params.rows.some((item) => item.row === row)),
              { message: 'Se dau doar rândurile întrebate.' },
            ),
          evidenceIds: evidenceIds.min(1),
        })
        .strict(),
    ]),
  prompt: (_subject, params) =>
    `${params.statement} ${params.year}, „Date informative” (F30), capitolul ${params.chapter}: completați ${params.rows
      .map((row) => `rd. ${row.row} (col. ${row.columns.join(', ')}) ${row.label}`)
      .join('; ')}, sau răspundeți că nu sunt de raportat. Atașați documentele din care rezultă.`,
  evidence: (answer) => answer.evidenceIds,
};

export const disclosuresParams = z.object({ statement, year }).strict();
export type DisclosuresParams = z.infer<typeof disclosuresParams>;

export const disclosuresAnswer = z
  .object({
    /** pct. 471 lit. m): the parent drawing up consolidated statements, if any. */
    parent: z
      .object({ name: z.string().trim().min(2).max(200), seat: z.string().trim().min(2).max(300) })
      .strict()
      .nullable(),
    /** pct. 468 lit. d), pct. 471 lit. p): commitments, guarantees, contingent items and
     * off-balance-sheet arrangements (nature and business purpose). */
    commitments: note,
    /** pct. 468 lit. e): advances and credits to the members of the management bodies. */
    managementAdvances: note,
    /** pct. 468 lit. f): income or expense items of exceptional size or incidence. */
    exceptional: note,
    /** pct. 468 lit. g): debts due after more than five years, and secured debts. */
    longTermDebts: note,
    /** pct. 471 lit. q): significant events after the balance-sheet date. */
    subsequentEvents: note,
    /** pct. 471 lit. r), as pct. 469 alin. (3) limits it: transactions with those holding a
     * participating interest, with the entities it holds one in, and with the management. */
    relatedParties: note,
    /** L82 art. 30 lit. c), OMFP pct. 49: the going-concern statement of the declaration. */
    goingConcern: z
      .object({ continues: z.boolean(), uncertainty: note })
      .strict()
      .refine((value) => value.continues || value.uncertainty !== null, {
        message: 'Descrieți incertitudinea privind continuitatea.',
      }),
    evidenceIds: evidenceIds.default([]),
  })
  .strict();
export type DisclosuresAnswer = z.infer<typeof disclosuresAnswer>;

/** What the explanatory notes and the declaration state that the books cannot know. */
export const annualDisclosures: QuestionKind<DisclosuresParams, DisclosuresAnswer> = {
  id: 'annual.disclosures',
  summary:
    "The facts an annual statement's explanatory notes and the administrator's declaration state that the books cannot know: the parent company, commitments and off-balance-sheet arrangements, advances to management, exceptional items, long-term and secured debts, events after the balance sheet date, related-party transactions, and going concern. Null means none.",
  holds: 'once',
  subjects: ['annual'],
  params: disclosuresParams,
  answer: () => disclosuresAnswer,
  prompt: (_subject, params) =>
    `${params.statement} ${params.year}: pentru notele explicative și declarația administratorului, indicați (sau „nu este cazul”): societatea-mamă care întocmește situații consolidate; angajamentele, garanțiile și datoriile contingente, natura și scopul angajamentelor în afara bilanțului; avansurile și creditele acordate administratorilor; elementele de venituri sau cheltuieli excepționale; datoriile exigibile după cinci ani și datoriile garantate; evenimentele ulterioare datei bilanțului; tranzacțiile cu asociații, cu entitățile în care se dețin participații și cu conducerea; dacă entitatea își continuă activitatea.`,
  evidence: (answer) => answer.evidenceIds,
};

/** The accompanying documents of the annual statements a person signs or supplies. */
export const annualDocumentKinds = [
  'notes',
  'administrators.report',
  'profit.distribution',
  'declaration',
  'audit.report',
  'censors.report',
] as const;
export type AnnualDocumentKind = (typeof annualDocumentKinds)[number];

export const documentParams = z
  .object({
    statement,
    year,
    document: z.enum(annualDocumentKinds),
    title: z.string().trim().min(3).max(200),
    /** The hash of the engine's draft, when it drafts the document: a new draft asks again. */
    draft: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  })
  .strict();
export type DocumentParams = z.infer<typeof documentParams>;

/** An accompanying document, signed: the file a person supplies, kept as evidence. */
export const annualDocument: QuestionKind<DocumentParams, { evidenceId: string }> = {
  id: 'annual.document',
  summary:
    'An accompanying document of the annual statements (explanatory notes, administrators’ report, profit distribution proposal, the declaration of art. 30, an audit or censors’ report): a person supplies the signed file, from the engine’s draft where it drafts one.',
  holds: 'once',
  subjects: ['annual'],
  params: documentParams,
  answer: () => z.object({ evidenceId: z.uuid() }).strict(),
  prompt: (_subject, params) =>
    `${params.statement} ${params.year}: încărcați documentul semnat „${params.title}”${params.draft ? ', pornind de la proiectul întocmit de aplicație' : ''}.`,
  evidence: (answer) => [answer.evidenceId],
};
