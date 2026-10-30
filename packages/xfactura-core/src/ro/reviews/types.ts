import { z } from 'zod';
import type { ParameterRegister, ReviewStatus } from '../../rules';
import { isLocalDate } from '../../time';

export const PACKET_FORMAT = 'xfactura.review-packet@1';
export const RECORD_FORMAT = 'xfactura.review-record@1';

/**
 * Who reviewed: a partner accountant marks a reading `interpreted` (it unlocks shadow use); the
 * expert contabil signs it (it unlocks posting and filing).
 */
export type ReviewTier = 'interpreted' | 'signed';
export const tierRank: Record<ReviewTier, number> = { interpreted: 1, signed: 2 };

/** The tier of record a version's status needs; null for `extracted`, which needs none. */
export function tierFor(status: ReviewStatus): ReviewTier | null {
  return status === 'extracted' ? null : status === 'signed' ? 'signed' : 'interpreted';
}

/** A worked case's result under one reading, as the engine's code computed it. */
export interface CaseOutcome {
  summary: string;
  lines: string[];
}

export interface ReviewCase {
  title: string;
  /** The facts of the case, in Romanian. */
  facts: string;
  /** Runs the engine's code on the case under both readings. It may only use `register`, so a
   * changed value changes the outcomes and voids the reviews of them. */
  run(register: ParameterRegister): { engine: CaseOutcome; alternative: CaseOutcome };
}

/**
 * What a reviewer is asked about one parameter, written by a person from the cited clauses. The
 * packet generator never invents any of it.
 */
export interface ReviewSpec {
  key: string;
  /** `mechanical`: the value is read straight from a clause, and is batched with the act's other
   * rows; `interpretation`: the clause admits more than one reading, and gets its own packet. */
  kind: 'mechanical' | 'interpretation';
  /** The source whose packet batches a mechanical row. */
  act: string;
  /** Estimated minutes of the expert's time; the queue divides by it. */
  minutes: number;
  /** One sentence each, in Romanian. */
  readings: { engine: string; alternative: string };
  question: string;
  /** Registered clauses the readings rely on beyond those the versions cite. */
  context: readonly string[];
  /** Three to five. */
  cases: readonly ReviewCase[];
  /** What the readings could not source, said plainly. */
  gaps: readonly string[];
}

/** Where an excerpt of a clause starts and ends in its snapshot's text (whitespace collapsed). */
export interface Anchor {
  from: string;
  to: string;
}

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const localDate = z.string().refine((value) => isLocalDate(value), 'not a date');
const outcomeSchema = z.object({ summary: z.string(), lines: z.array(z.string()) }).strict();

export const packetItemSchema = z
  .object({
    key: z.string().min(1),
    description: z.string(),
    axis: z.string(),
    /** Everything about a version but its status: raising the status must not change it. */
    versions: z
      .array(
        z
          .object({
            id: z.string().min(1),
            scope: z.record(z.string(), z.string()),
            value: z.json(),
            from: localDate,
            to: localDate.nullable(),
            reviewedThrough: localDate.nullable(),
            knowledgeDate: localDate.nullable(),
            clauses: z.array(z.string()),
          })
          .strict(),
      )
      .min(1),
    sources: z.array(
      z
        .object({
          clause: z.string(),
          role: z.enum(['cited', 'context']),
          source: z.string(),
          title: z.string(),
          locator: z.string(),
          status: z.enum(['located', 'pending']),
          summary: z.string(),
          snapshots: z.array(z.object({ url: z.string(), sha256 }).strict()),
          /** Pin the excerpt together with the snapshot hash; null when none is recorded. */
          anchors: z.array(z.object({ from: z.string(), to: z.string() }).strict()).nullable(),
        })
        .strict(),
    ),
    readings: z.object({ engine: z.string(), alternative: z.string() }).strict(),
    cases: z
      .array(
        z
          .object({
            title: z.string(),
            facts: z.string(),
            engine: outcomeSchema,
            alternative: outcomeSchema,
          })
          .strict(),
      )
      .min(3)
      .max(5),
    question: z
      .object({
        text: z.string(),
        options: z.object({ A: z.string(), B: z.string(), C: z.string() }).strict(),
      })
      .strict(),
    scope: z
      .object({
        profiles: z.array(z.object({ id: z.string(), title: z.string() }).strict()),
        obligations: z.array(z.string()),
      })
      .strict(),
    gaps: z.array(z.string()),
  })
  .strict();
export type PacketItem = z.infer<typeof packetItemSchema>;

/** The canonical JSON whose SHA-256 is the packet hash. Nothing time- or file-dependent. */
export const reviewPacketSchema = z
  .object({
    format: z.literal(PACKET_FORMAT),
    id: z.string().regex(/^RP-[a-f0-9]{12}$/),
    items: z.array(packetItemSchema).min(1),
  })
  .strict();
export type ReviewPacket = z.infer<typeof reviewPacketSchema>;

export const reviewRecordSchema = z
  .object({
    format: z.literal(RECORD_FORMAT),
    packetId: z.string(),
    packetSha256: sha256,
    tier: z.enum(['interpreted', 'signed']),
    reviewer: z
      .object({
        /** e.g. `expert contabil`, `contabil autorizat`. */
        role: z.string().min(1),
        /** Null when the reviewer did not agree to publish their identity in the repository; the
         * signed file, kept by the owner, still names them. */
        name: z.string().min(1).nullable(),
        ceccar: z.string().min(1).max(40).nullable(),
        identityPublished: z.boolean(),
      })
      .strict(),
    /** The day of the signature, or of the review when the file is not signed. */
    date: localDate,
    decisions: z
      .array(
        z
          .object({
            key: z.string(),
            /** The form field the answer was read from. */
            field: z.string(),
            /** A: the engine's reading; B: the alternative; C: the reviewer's own (`text`). */
            choice: z.enum(['A', 'B', 'C']),
            text: z.string().optional(),
          })
          .strict(),
      )
      .min(1),
    file: z
      .object({
        sha256,
        /** Presence only: the qualified certificate is not verified by this tooling. */
        signature: z.enum(['present_not_verified', 'absent']),
        /** Whether the last signature's byte range ends at the end of the file (nothing was
         * appended after signing). Null without a signature. */
        coversWholeFile: z.boolean().nullable(),
      })
      .strict(),
    /** The clause excerpts the reviewed file showed (they are outside the packet hash). */
    excerpts: z.array(
      z.object({ clause: z.string(), shown: z.boolean(), sha256: sha256.nullable() }).strict(),
    ),
    packet: reviewPacketSchema,
  })
  .strict()
  .superRefine((record, context) => {
    const fail = (message: string) => context.addIssue({ code: 'custom', message });
    if (record.packet.id !== record.packetId) fail('packetId differs from the packet it holds');
    if (record.tier === 'signed') {
      if (record.file.signature !== 'present_not_verified' || record.file.coversWholeFile !== true)
        fail('a signed review needs a signature that covers the whole file');
      if (record.reviewer.identityPublished && !record.reviewer.ceccar)
        fail('the expert contabil is identified by a CECCAR membership number');
    }
    if (record.reviewer.identityPublished !== (record.reviewer.name !== null))
      fail('a published identity has a name; a withheld one has none');
    for (const decision of record.decisions)
      if ((decision.choice === 'C') !== (decision.text !== undefined && decision.text.length > 0))
        fail(`${decision.key}: free text goes with answer C, and only with it`);
  });
export type ReviewRecord = z.infer<typeof reviewRecordSchema>;
