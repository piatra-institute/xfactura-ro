import { z } from 'zod';
import type { Effect } from 'xfactura-core/kernel';
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

export const proposalView = z.object({
  id: z.string(),
  treatment: z.string(),
  subject: z.string(),
  status: z.enum(['blocked', 'proposed', 'approved', 'posted', 'withdrawn']),
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
  approval: z.object({ id: z.string(), approverId: z.string(), at: z.string() }).nullable(),
  entry: z.object({ id: z.string(), number: z.number(), seq: z.number() }).nullable(),
  createdBy: z.string(),
  agentId: z.string().nullable(),
});
export type ProposalView = z.infer<typeof proposalView>;
