import { z } from 'zod';
import { formatQuantity, type Effect } from 'xfactura-core/kernel';
import { formatMoney } from 'xfactura-core/money';

/** An effect as stored: JSON with bigint values as decimal-integer strings. */
export type Stored<T> = T extends string
  ? T
  : T extends bigint
    ? string
    : T extends (infer U)[]
      ? Stored<U>[]
      : T extends object
        ? { [K in keyof T]: Stored<T[K]> }
        : T;
export type StoredEffect = Stored<Effect>;

const ron = (bani: string) => formatMoney(BigInt(bani), 'RON');
const money = z.string().regex(/^-?\d+\.\d{2}$/);

export const effectView = z.object({
  date: z.string(),
  journalClass: z.enum(['general', 'memo']),
  journalCode: z.string(),
  description: z.string(),
  lines: z.array(
    z.object({
      account: z.string(),
      side: z.enum(['D', 'C']),
      amount: money,
      currency: z
        .object({ code: z.string(), amount: z.string(), rate: z.string(), rateId: z.string() })
        .optional(),
      partyId: z.string().optional(),
      openItem: z.string().optional(),
      taxSettlement: z.object({ tax: z.string(), period: z.string() }).optional(),
      analytics: z.record(z.string(), z.string()).optional(),
      memo: z.string().optional(),
      /** For a caller who may not read health data, on a payroll of one person: the accounts
       * this line's amount includes beside its own (`['4382']`, the sick pay the fund bears,
       * folded into 641 whether or not there was any). */
      includes: z.array(z.string()).optional(),
    }),
  ),
  openItems: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      controlAccount: z.string(),
      partyId: z.string(),
      currency: z.string(),
      normalSide: z.enum(['D', 'C']),
      mayReverse: z.boolean(),
      dueDate: z.string().optional(),
      documentId: z.string().optional(),
    }),
  ),
  taxEntries: z.array(
    z.object({
      key: z.string(),
      tax: z.string(),
      code: z.string(),
      direction: z.enum(['output', 'input']),
      base: money,
      amount: money,
      deductible: money,
      booked: money,
      taxPoint: z.string(),
      exigibility: z.string().nullable(),
      taxPeriod: z.string().nullable(),
      line: z.number().optional(),
      attributes: z.record(z.string(), z.string()),
    }),
  ),
  schedules: z.array(
    z.object({
      id: z.string(),
      openItem: z.string(),
      version: z.number(),
      method: z.string(),
      rows: z.array(
        z.object({ key: z.string(), due: z.string(), amount: money, counterAccount: z.string() }),
      ),
    }),
  ),
  /** The stock register's layers the effect creates and its moves (effect@2). */
  stockLayers: z
    .array(
      z.object({
        id: z.string(),
        item: z.string(),
        warehouse: z.string(),
        account: z.string(),
        method: z.string(),
        date: z.string(),
        mayGoNegative: z.boolean(),
      }),
    )
    .optional(),
  stockMoves: z
    .array(
      z.object({
        item: z.string(),
        warehouse: z.string(),
        account: z.string(),
        layer: z.string(),
        quantity: z.string(),
        amount: money,
        line: z.number().optional(),
      }),
    )
    .optional(),
  explanation: z.object({ summary: z.string(), details: z.unknown().optional() }),
});

/** The effect as callers see it: decimal amounts in RON and in the line currency. */
export function viewEffect(effect: StoredEffect): z.infer<typeof effectView> {
  return {
    date: effect.date,
    journalClass: effect.journalClass,
    journalCode: effect.journalCode,
    description: effect.description,
    lines: effect.lines.map(({ bani, currency, ...line }) => ({
      ...line,
      amount: ron(bani),
      ...(currency
        ? {
            currency: {
              code: currency.code,
              amount: formatMoney(BigInt(currency.minor), currency.code),
              rate: currency.rate,
              rateId: currency.rateId,
            },
          }
        : {}),
    })),
    openItems: effect.openItems.map(({ ref, ...item }) => ({ id: ref, ...item })),
    taxEntries: effect.taxEntries.map((entry) => ({
      key: entry.key,
      tax: entry.tax,
      code: entry.code,
      direction: entry.direction,
      base: ron(entry.baseBani),
      amount: ron(entry.taxBani),
      deductible: ron(entry.deductibleBani),
      booked: ron(entry.ledgerBani),
      taxPoint: entry.taxPoint,
      exigibility: entry.exigibility,
      taxPeriod: entry.taxPeriod,
      ...(entry.line === undefined ? {} : { line: entry.line }),
      attributes: entry.attributes,
    })),
    schedules: effect.schedules.map((schedule) => ({
      id: schedule.ref,
      openItem: schedule.openItem,
      version: schedule.version,
      method: schedule.method,
      rows: schedule.rows.map((row) => ({
        key: row.key,
        due: row.due,
        amount: ron(row.bani),
        counterAccount: row.counterAccount,
      })),
    })),
    ...(effect.stockLayers
      ? { stockLayers: effect.stockLayers.map(({ ref, ...layer }) => ({ id: ref, ...layer })) }
      : {}),
    ...(effect.stockMoves
      ? {
          stockMoves: effect.stockMoves.map(({ quantity, bani, ...move }) => ({
            ...move,
            quantity: formatQuantity(BigInt(quantity)),
            amount: ron(bani),
          })),
        }
      : {}),
    explanation: effect.explanation,
  };
}

export const issueView = z.object({
  code: z.string(),
  severity: z.enum(['block', 'ack', 'info']),
  message: z.string(),
  path: z.string().optional(),
  details: z.unknown().optional(),
});

/**
 * What differs between a version's own evaluation and a later one against the books: a read-set
 * entry (`kind` and `id` as the treatment read them, `before` and `after` their versions, null
 * when absent), or `rules` (the parameter versions or the assurance mode), `issues` (their codes),
 * `treatment` (its version) or, when nothing narrower explains it, `effect` (the effect hashes).
 */
export const proposalChange = z.object({
  kind: z.string(),
  id: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
});
export type ProposalChange = z.infer<typeof proposalChange>;

export const proposalStatuses = [
  'blocked',
  'proposed',
  'approved',
  'stale',
  'posted',
  'withdrawn',
] as const;

export const proposalView = z.object({
  id: z.string(),
  treatment: z.string(),
  subject: z.string(),
  /** `stale`: an open proposal whose latest re-evaluation (`check`) found the books changed
   * since the version was evaluated; revise it. It takes precedence over blocked, proposed and
   * approved, which the `approval` and `issues` fields still show. */
  status: z.enum(proposalStatuses),
  version: z.number(),
  effectHash: z.string(),
  rulesHash: z.string(),
  /** The least-reviewed rule the effect relied on; `preview` books accept unreviewed rules. */
  rules: z.object({
    mode: z.enum(['preview', 'shadow', 'posting']),
    used: z.array(z.object({ id: z.string(), status: z.string() })),
  }),
  issues: z.array(issueView),
  effect: effectView.nullable(),
  /** The approval of this exact version; `batchId` names the reviewed batch it came with. */
  approval: z
    .object({
      id: z.string(),
      approverId: z.string(),
      at: z.string(),
      batchId: z.string().optional(),
    })
    .nullable(),
  /** The posted entry: bound to the approval above or, when `policyId` is set, to a posting
   * policy; posted by `postedBy`, through `agentId` when an agent posted it. */
  entry: z
    .object({
      id: z.string(),
      number: z.number(),
      seq: z.number(),
      policyId: z.string().nullable(),
      postedBy: z.string(),
      agentId: z.string().nullable(),
    })
    .nullable(),
  createdBy: z.string(),
  agentId: z.string().nullable(),
  /** The latest re-evaluation of this version against the books, as of audit `seq`; null until
   * one has run (the worker runs one after the books change; `proposals.get` with `recheck`). A
   * signal only: `ledger.post` re-evaluates regardless. */
  check: z
    .object({ seq: z.number(), stale: z.boolean(), changed: z.array(proposalChange) })
    .nullable(),
  /** What the version relies on (`basis`): the answers, each as the version read it (the
   * question, the answer then latest, its kind and value), and the template that made its input,
   * when it cites one; null without a basis. */
  basis: z
    .object({
      answers: z.array(
        z.object({
          questionId: z.string(),
          answerId: z.string().nullable(),
          kind: z.string().nullable(),
          /** Null and `redacted` for a caller who may not read the kind's data classes (an
           * answer about sick leave is `health`), as `questions.list` shows it. */
          value: z.unknown(),
          redacted: z.literal(true).optional(),
        }),
      ),
      template: z.object({ id: z.string(), version: z.number() }).optional(),
    })
    .nullable(),
  /** The version's input as its treatment read it, what `proposals.revise` starts from: on
   * `proposals.get`, and on `proposals.list` with `withInput`; null when `redacted`. */
  input: z.record(z.string(), z.unknown()).nullable().optional(),
  /** On `proposals.get` and `proposals.list`, true when the caller may not read every data class
   * of the treatment (payroll's: `payroll`, `personal`), as `events.since` decides: `input` and
   * `basis` are then null. */
  redacted: z.literal(true).optional(),
});
export type ProposalView = z.infer<typeof proposalView>;
