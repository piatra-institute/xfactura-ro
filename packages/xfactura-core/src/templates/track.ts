import { z } from 'zod';

/*
 * A template's track record. Each document or movement a template applies to gets a prediction
 * before anything is posted for it (the engine's worker records it); what was posted decides the
 * outcome. Agents are measured the same way, by their first version of each proposal.
 */

/** What became of a prediction (or of an agent's first version):
 * - `correct`: what was posted books exactly what was predicted, and stands;
 * - `corrected`: what was posted books something else, or was reversed since;
 * - `rejected`: the proposal was withdrawn and nothing was posted;
 * - `pending`: nothing posted yet. */
export const outcomeKinds = ['correct', 'corrected', 'rejected', 'pending'] as const;
export type OutcomeKind = (typeof outcomeKinds)[number];

/** What was posted for a subject, as far as the track record reads it. */
export type Posted = {
  fingerprint: string | null;
  /** A reversal of the entry was posted. */
  reversed: boolean;
  /** The entry's month. */
  month: string;
  /** The treatment and parameter versions the posted version used. */
  rulesHash: string;
  /** What people stated that it relied on: a key of the answers its basis cited, each question
   * with its answer's value (`''` without any). */
  basis: string;
  /** Its debits in bani. */
  amount: bigint;
};

export type Outcome = {
  outcome: OutcomeKind;
  /** Why it counts as corrected. */
  reason: 'changed' | 'reversed' | null;
  month: string | null;
  rulesHash: string | null;
  basis: string | null;
  amount: bigint | null;
};

/** The outcome of a prediction of `fingerprint`, from what was posted for its subject, if
 * anything, and whether its proposals were all withdrawn. */
export function outcomeOf(
  fingerprint: string | null,
  posted: Posted | null,
  withdrawn: boolean,
): Outcome {
  if (!posted)
    return {
      outcome: withdrawn ? 'rejected' : 'pending',
      reason: null,
      month: null,
      rulesHash: null,
      basis: null,
      amount: null,
    };
  const reason = posted.reversed
    ? ('reversed' as const)
    : posted.fingerprint !== fingerprint
      ? ('changed' as const)
      : null;
  return {
    outcome: reason ? 'corrected' : 'correct',
    reason,
    month: posted.month,
    rulesHash: posted.rulesHash,
    basis: posted.basis,
    amount: posted.amount,
  };
}

/** Outcomes counted per month of posting (pending and rejected ones under null). */
export function outcomesByMonth(outcomes: readonly Pick<Outcome, 'outcome' | 'month'>[]) {
  const months = new Map<string | null, Record<OutcomeKind, number>>();
  for (const { outcome, month } of outcomes) {
    const counts = months.get(month) ?? { correct: 0, corrected: 0, rejected: 0, pending: 0 };
    counts[outcome]++;
    months.set(month, counts);
  }
  return [...months.entries()]
    .sort(([a], [b]) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1))
    .map(([month, counts]) => ({ month, ...counts }));
}

/** When a template graduates. A company may tighten each criterion, never loosen it below the
 * default: at least 6 correct bookings across at least 3 months, no correction, the same rules,
 * and a policy that expires within 90 days. */
export const defaultCriteria = { minCorrect: 6, minMonths: 3, policyDays: 90 } as const;
export const criteriaSchema = z
  .object({
    minCorrect: z.number().int().min(defaultCriteria.minCorrect).max(1000),
    minMonths: z.number().int().min(defaultCriteria.minMonths).max(120),
    policyDays: z.number().int().min(1).max(defaultCriteria.policyDays),
  })
  .strict();
export type Criteria = z.infer<typeof criteriaSchema>;

/** Why a template has not graduated. */
export type GraduationGap = 'MIN_CORRECT' | 'MIN_MONTHS' | 'CORRECTIONS';

/**
 * Whether a track record (in posting order) meets the criteria. Only correct outcomes under the
 * rules of the latest one, and on the same facts people stated (its basis: a vehicle's use), count,
 * so a change of rules or of an answer starts the run again; any correction stops it, whatever the
 * rules, until a new version of the template starts a new run. The amounts observed in the counted
 * run bound the policy the template may earn.
 */
export function graduation(outcomes: readonly Outcome[], criteria: Criteria) {
  const correct = outcomes.filter((item) => item.outcome === 'correct');
  const rulesHash = correct.at(-1)?.rulesHash ?? null;
  const basis = correct.at(-1)?.basis ?? null;
  const counted = correct.filter((item) => item.rulesHash === rulesHash && item.basis === basis);
  const months = [...new Set(counted.map((item) => item.month!))].sort();
  const corrections = outcomes.filter((item) => item.outcome === 'corrected').length;
  const failing: GraduationGap[] = [];
  if (counted.length < criteria.minCorrect) failing.push('MIN_CORRECT');
  if (months.length < criteria.minMonths) failing.push('MIN_MONTHS');
  if (corrections > 0) failing.push('CORRECTIONS');
  const amounts = counted.map((item) => item.amount!);
  const perMonth = months.map((month) => counted.filter((item) => item.month === month).length);
  return {
    met: failing.length === 0,
    failing,
    rulesHash,
    basis,
    correct: counted.length,
    months,
    corrections,
    observed: amounts.length
      ? {
          min: amounts.reduce((a, b) => (a < b ? a : b)),
          max: amounts.reduce((a, b) => (a > b ? a : b)),
          maxPerMonth: Math.max(...perMonth),
        }
      : null,
  };
}
