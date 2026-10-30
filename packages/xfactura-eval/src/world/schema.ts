import { z } from 'zod';
import type { InvoiceDraft } from 'xfactura-core/einvoice';

/*
 * A world is one company's month, written as data: the files that arrive (source documents),
 * the facts only the owner knows (hidden facts, read by the simulated owner and nobody else),
 * and, per file, the gold decision: how it enters the books, the questions its evidence cannot
 * settle, and the treatments and inputs a careful accountant would propose. Gold effects are
 * never written here: they come from running the engine on the gold inputs.
 *
 * Values in gold inputs that start with `@` are references resolved in the engine the decision
 * runs in (ids differ from one engine to the next):
 * - `@doc:<key>`: the document recorded from that file (the root of its group);
 * - `@evidence:<key>`: the file itself;
 * - `@party:<key>`: the document's partner;
 * - `@openItem:<key>`: the receivable or payable its posted recognition opened;
 * - `@movement:<date>:<amount>`: the bank movement booked that day for that signed amount;
 * - `@treasury:<key>`: a treasury account of the setup;
 * - `@holder`: the holder of a PFA or II, a partner of the setup;
 * - `@year`: the financial year.
 */

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const month = z.string().regex(/^\d{4}-\d{2}$/);
const amount = z.string().regex(/^-?\d+\.\d{2}$/);
const json = z.record(z.string(), z.unknown());

/** Whether an accountant checked the decision. Every decision starts as a draft. */
export const goldStatus = z.enum(['draft', 'checked']);

/**
 * A question the evidence cannot settle, as `<kind>:<about>`: `profile.fact:<axis>`,
 * `vehicle.use:<registration without spaces or dashes>`, `deferral.schedule:<document key>`.
 */
export const expectedQuestion = z.string().regex(/^[a-z][A-Za-z.]+:[^\s]+$/);

/** How the file becomes a record of the books. */
export const intakeSchema = z.discriminatedUnion('op', [
  /** An e-Factura XML: the engine reads it whole. */
  z.object({ op: z.literal('invoices.import') }).strict(),
  /** A PDF or a photo read into a document. `citations` names, per field, the text on the line
   * that shows it; the runner finds the line in the file's text layer. */
  z
    .object({
      op: z.literal('documents.record'),
      kind: z.string(),
      body: json,
      citations: z.record(z.string(), z.string()).default({}),
    })
    .strict(),
  /** An MT940 or camt.053 statement. */
  z.object({ op: z.literal('bank.import') }).strict(),
  /** A bank's CSV export, with the column mapping that reads it. */
  z
    .object({
      op: z.literal('bank.importCsv'),
      account: z.string(),
      mapping: json,
      period: z.object({ from: date, to: date }).strict().optional(),
    })
    .strict(),
  /** Nothing to record: the file is not a document of the books. */
  z.object({ op: z.literal('none') }).strict(),
]);
export type Intake = z.infer<typeof intakeSchema>;

export const decisionSchema = z
  .object({
    /** Unique in the world; reports name decisions by it. */
    key: z.string().regex(/^[a-z0-9][A-Za-z0-9.:-]*$/),
    treatment: z.string(),
    input: json,
  })
  .strict();
export type Decision = z.infer<typeof decisionSchema>;

export const goldSchema = z
  .object({
    status: goldStatus,
    /** Who checked it and when, once an accountant did. */
    checkedBy: z.string().optional(),
    checkedOn: date.optional(),
    /** The reasoning in a sentence or two, for the accountant who checks it. */
    note: z.string().min(1),
    intake: intakeSchema,
    questions: z.array(expectedQuestion).default([]),
    /** Proposals in order; each is posted before the next is proposed. */
    decisions: z.array(decisionSchema).default([]),
    /** The right move is to stop and leave the file to a person: the engine does not support it
     * (UNSUPPORTED), lacks a reviewed rule (RULE_GAP), or the file needs no booking. */
    stop: z
      .object({
        reason: z.enum(['unsupported', 'rule_gap', 'no_booking']),
        note: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((gold) => gold.status === 'draft' || (gold.checkedBy && gold.checkedOn), {
    message: 'A checked decision names who checked it and when.',
  })
  .refine((gold) => !gold.stop || gold.decisions.length === 0, {
    message: 'A file the agent should stop at has no decisions.',
  });
export type Gold = z.infer<typeof goldSchema>;

export const sourceSchema = z.discriminatedUnion('kind', [
  /** An e-Factura invoice, written by the core UBL writer from this draft. */
  z.object({ kind: z.literal('ubl'), invoice: z.custom<InvoiceDraft>() }).strict(),
  /** A PDF with a text layer: one array of lines per page. */
  z.object({ kind: z.literal('pdf'), pages: z.array(z.array(z.string())).min(1) }).strict(),
  /** A photo with no text layer: a receipt printed in a bitmap font. */
  z.object({ kind: z.literal('image'), lines: z.array(z.string()).min(1) }).strict(),
  /** Text as written: MT940, camt.053 XML or CSV. */
  z
    .object({
      kind: z.enum(['mt940', 'camt', 'csv']),
      text: z.string(),
      encoding: z.enum(['utf-8', 'windows-1250']).default('utf-8'),
    })
    .strict(),
]);
export type Source = z.infer<typeof sourceSchema>;

export const documentSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9-]*$/),
    title: z.string(),
    /** When the file reaches the books; files are worked in this order. */
    arrives: date,
    filename: z.string(),
    mediaType: z.string(),
    source: sourceSchema,
    /** For a statement: the treasury account of the setup it reports. */
    statementOf: z.string().optional(),
    /** Facts about this file only the owner knows. */
    hidden: z
      .object({
        'deferral.schedule': z.object({ from: month, months: z.number().int() }).strict(),
      })
      .partial()
      .strict()
      .default({}),
    /** Part of the injection corpus: its text tries to steer the agent. */
    injection: z.boolean().default(false),
    gold: goldSchema,
  })
  .strict();
export type WorldDocument = z.infer<typeof documentSchema>;

export const worldSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    title: z.string(),
    /** The company profile the world exercises, e.g. `srl.micro.vat.services`. */
    profile: z.string(),
    period: month,
    company: z.object({ name: z.string(), cui: z.string().regex(/^\d{2,10}$/) }).strict(),
    /** The engine's clock while the world runs: after the month, so its files are not future. */
    clock: z.iso.datetime(),
    /** What people set up before the agent starts; not scored. */
    setup: z
      .object({
        facts: z
          .array(z.object({ axis: z.string(), value: z.string(), effectiveFrom: date }).strict())
          .default([]),
        accounts: z.array(z.object({ code: z.string(), name: z.string() }).strict()).default([]),
        treasury: z
          .array(
            z
              .object({
                key: z.string(),
                kind: z.enum(['bank', 'cash']),
                name: z.string(),
                iban: z.string().optional(),
                currency: z.string(),
                ledgerAccount: z.string(),
                openedOn: date,
              })
              .strict(),
          )
          .default([]),
        opening: z
          .object({
            date,
            lines: z.array(
              z.object({ account: z.string(), side: z.enum(['D', 'C']), amount }).strict(),
            ),
          })
          .strict()
          .optional(),
        bnr: z
          .array(
            z.object({ date, currency: z.string(), rate: z.string().regex(/^\d+\.\d+$/) }).strict(),
          )
          .default([]),
        /** A PFA's, II's or IF's income source (`pfa.sources.record` without its evidence). */
        incomeSource: json.optional(),
        /** The holder of a PFA or II, as a partner of the books (`@holder` in gold inputs). */
        holder: z.object({ name: z.string() }).strict().optional(),
      })
      .strict(),
    hidden: z
      .object({
        /** Company facts by axis (`vat.status`), recorded when the owner answers. */
        profile: z
          .record(z.string(), z.object({ value: z.string(), effectiveFrom: date }).strict())
          .default({}),
        /** Road vehicles by registration (no spaces or dashes). */
        vehicles: z
          .record(
            z.string(),
            z.object({ use: z.enum(['business_only', 'mixed']), from: date }).strict(),
          )
          .default({}),
      })
      .strict(),
    documents: z.array(documentSchema).min(1),
  })
  .strict()
  .superRefine((world, context) => {
    const keys = new Set<string>();
    const decisions = new Set<string>();
    for (const document of world.documents) {
      if (keys.has(document.key))
        context.addIssue({ code: 'custom', message: `Duplicate document ${document.key}` });
      keys.add(document.key);
      for (const decision of document.gold.decisions) {
        if (decisions.has(decision.key))
          context.addIssue({ code: 'custom', message: `Duplicate decision ${decision.key}` });
        decisions.add(decision.key);
      }
    }
  });
export type World = z.infer<typeof worldSchema>;
export type WorldInput = z.input<typeof worldSchema>;

/** Parses a world, refusing one that is not well formed. */
export const defineWorld = (world: WorldInput): World => worldSchema.parse(world);

/** A registration as the hidden facts key it: capitals, no spaces or dashes. */
export const plateKey = (plate: string) => plate.toUpperCase().replace(/[\s-]/g, '');
