import type { WorkItem } from './work-model';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** The calendar names its first blocker as a question. The full gap guards against a different
 * set of remaining blockers; it is compared verbatim, never parsed into inferred causes. */
function causeOf(item: WorkItem) {
  if (item.kind !== 'obligation.due' || item.details.status !== 'blocked') return null;
  const question = item.details.question;
  if (
    !record(question) ||
    typeof question.kind !== 'string' ||
    !record(question.subject) ||
    typeof question.subject.kind !== 'string' ||
    typeof question.subject.id !== 'string' ||
    !record(question.params) ||
    typeof item.details.gap !== 'string' ||
    !item.details.gap
  )
    return null;
  return {
    key: stable({
      kind: item.kind,
      question,
      gap: item.details.gap,
      waiting: item.details.waiting ?? null,
    }),
    label: item.details.gap,
  };
}

export type WorkCause = { key: string; label: string | null; items: WorkItem[] };
export function groupCauses(items: WorkItem[]): WorkCause[] {
  const groups = new Map<string, WorkCause>();
  for (const item of items) {
    const cause = causeOf(item);
    const key = cause?.key ?? item.id;
    const known = groups.get(key);
    if (known) known.items.push(item);
    else groups.set(key, { key, label: cause?.label ?? null, items: [item] });
  }
  return [...groups.values()];
}
