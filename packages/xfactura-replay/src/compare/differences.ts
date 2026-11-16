import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';

export const classes = [
  'engine-defect',
  'accountant-choice',
  'legal-reading',
  'unsupported',
  'missing-evidence',
  'mapping',
  'comparator',
  'source-inconsistency',
  'unclassified',
] as const;
export type DifferenceClass = (typeof classes)[number];

export const kinds = [
  'balance-field',
  'balance-only-source',
  'balance-only-engine',
  'balance-period-only-source',
  'balance-period-only-engine',
  'mapping-account',
  'source-balance-both-sides',
  'source-tax-supplement',
  'source-chain-balance',
  'source-chain-evidence',
  'source-chain-only-previous',
  'source-chain-only-next',
  'source-chain-gap',
  'journal-lines',
  'journal-tax',
  'journal-tax-evidence',
  'journal-period',
  'journal-only-source',
  'journal-only-engine',
  'balance-presence-zero',
  'source-chain-presence-zero',
  'replay-settlement-unallocated',
  'replay-opening-refused',
  'replay-invoice-key-reused',
  // A field of a return the engine prepared against the filed one, by the return comparator's
  // class; a return the engine could not prepare; one ANAF's validator refused.
  'return-amount',
  'return-rounding',
  'return-text',
  'return-cosmetic',
  'return-structure',
  'return-zero-omission',
  'return-blocked',
  'return-validation',
] as const;
export type DifferenceKind = (typeof kinds)[number];
export const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export class ComparisonError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'ComparisonError';
  }
}
export function fail(code: string, message: string): never {
  throw new ComparisonError(code, message);
}

export const periodSchema = z
  .string()
  .regex(/^\d{4}-(?:0[1-9]|1[0-2])(?:-\d{2}\/\d{4}-\d{2}-\d{2})?$/);
const locatorSchema = z
  .object({
    account: z.string().optional(),
    sourceAccount: z.string().optional(),
    subject: z.string().optional(),
    entry: z.string().optional(),
    field: z.string().optional(),
    previousPeriod: periodSchema.optional(),
  })
  .strict();

export const observationSchema = z
  .object({
    id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    kind: z.enum(kinds),
    period: periodSchema,
    locator: locatorSchema,
    /** Full mapped accounts are private; only their synthetic part leaves the summary. */
    accounts: z.array(z.string()),
    taxCodes: z.array(z.string()),
    source: z.json(),
    engine: z.json(),
    delta: z.string().optional(),
    /** What a replay driver knew when it observed the finding; never part of its identity. */
    context: z
      .object({
        /** Lab assumptions the finding rests on, by their identifiers in the run's manifest. */
        assumptions: z.array(z.string().min(1)).optional(),
        /** Reason codes of decisions the driver took in translating the source transaction. */
        notes: z.array(z.string().min(1)).optional(),
        /** The driver's or the engine's refusal of the source transaction. */
        refusal: z
          .object({
            stage: z.enum(['translate', 'propose', 'proposal', 'approve', 'post']),
            code: z.string().min(1),
            message: z.string(),
            issues: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        /** A class the driver knows the cause of, with its reason code. */
        cause: z
          .object({
            class: z.enum(classes).exclude(['unclassified']),
            reason: z.string().min(1).max(100),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type Observation = z.infer<typeof observationSchema>;
export type Difference = Observation & {
  class: DifferenceClass;
  status: 'open' | 'resolved';
  causeId?: string;
};
export type AccountMapping = (sourceAccount: string) => string | undefined;

/** Only the kind, period and named structural coordinates participate in identity. */
export function differenceId(
  kind: DifferenceKind,
  period: string,
  locator: Observation['locator'],
): string {
  const coordinates = Object.entries(locator)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => order(a, b));
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(['replay-difference-v1', kind, period, coordinates]))
    .digest('hex')}`;
}

export function difference(
  input: Omit<Observation, 'id' | 'accounts' | 'taxCodes'> & {
    accounts?: string[];
    taxCodes?: string[];
  },
): Difference {
  return {
    ...input,
    id: differenceId(input.kind, input.period, input.locator),
    accounts: [...new Set(input.accounts ?? [])].sort(order),
    taxCodes: [...new Set(input.taxCodes ?? [])].sort(order),
    class: 'unclassified',
    status: 'open',
  };
}

export function syntheticAccount(account: string): string | null {
  const first = account.split('.')[0]!;
  return /^[1-9]\d{2,3}$/.test(first) ? first : null;
}

/** Counts active findings only. A multi-account finding counts once under each affected
 * synthetic account. Unknown source accounts receive caller-keyed pseudonyms. */
export function summarizeDifferences(differences: readonly Difference[], key: string | Uint8Array) {
  if (!key.length) fail('COMPARISON_HASH_KEY', 'Cheia de pseudonimizare nu poate fi goală.');
  const active = differences.filter((item) => item.status === 'open');
  const byClass = Object.fromEntries(classes.map((name) => [name, 0])) as Record<
    DifferenceClass,
    number
  >;
  const byKind = new Map<string, number>();
  const byPeriod = new Map<string, number>();
  const byAccountSynthetic = new Map<string, number>();
  const increment = (counts: Map<string, number>, name: string) =>
    counts.set(name, (counts.get(name) ?? 0) + 1);
  for (const item of active) {
    byClass[item.class]++;
    increment(byKind, item.kind);
    increment(byPeriod, item.period);
    const accounts = new Set(
      item.accounts.map(
        (account) =>
          syntheticAccount(account) ??
          `hmac-sha256:${createHmac('sha256', key).update('xfactura-replay:account:v1\0').update(account).digest('hex')}`,
      ),
    );
    for (const account of accounts) increment(byAccountSynthetic, account);
  }
  const sorted = (counts: Map<string, number>) =>
    Object.fromEntries([...counts].sort(([a], [b]) => order(a, b)));
  return {
    total: active.length,
    byClass,
    byKind: sorted(byKind),
    byPeriod: sorted(byPeriod),
    byAccountSynthetic: sorted(byAccountSynthetic),
    gate: byClass.unclassified === 0,
  };
}
