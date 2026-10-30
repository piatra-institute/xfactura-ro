/**
 * The engine itself: the worker's sweeps, pauses and demotions are recorded in its name, so the
 * audit log never shows them as a person's. It is a user row without credentials (added by the
 * `earned_autonomy` migration) that no company may admit as a member (`inv:system_member`), so it
 * never approves, decides or creates a policy.
 */
export const SYSTEM_PRINCIPAL = 'system';
