import { canonical, hashOf } from '../../hash';
import { buildItem, packetIdOf, type ReviewContext } from './packet';
import { tierFor, tierRank, type PacketItem, type ReviewRecord } from './types';

const show = (value: unknown) => {
  const text = canonical(value ?? null);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
};
const same = (a: unknown, b: unknown) => canonical(a ?? null) === canonical(b ?? null);

/** What differs between the item a reviewer saw and the item the register builds now. */
export function itemChanges(before: PacketItem, after: PacketItem): string[] {
  const changes: string[] = [];
  if (before.description !== after.description) changes.push('description changed');
  if (before.axis !== after.axis) changes.push(`axis ${before.axis} → ${after.axis}`);
  for (const old of before.versions) {
    const now = after.versions.find((version) => version.id === old.id);
    if (!now) {
      changes.push(`version ${old.id} withdrawn or removed`);
      continue;
    }
    for (const field of [
      'value',
      'scope',
      'from',
      'to',
      'reviewedThrough',
      'knowledgeDate',
      'clauses',
    ] as const)
      if (!same(old[field], now[field]))
        changes.push(`${old.id} ${field} ${show(old[field])} → ${show(now[field])}`);
  }
  const clauses = new Set([...before.sources, ...after.sources].map((item) => item.clause));
  for (const id of clauses) {
    const old = before.sources.find((item) => item.clause === id);
    const now = after.sources.find((item) => item.clause === id);
    if (!old) changes.push(`clause ${id} added`);
    else if (!now) changes.push(`clause ${id} no longer cited`);
    else
      for (const field of [
        'role',
        'source',
        'title',
        'locator',
        'status',
        'summary',
        'snapshots',
        'anchors',
      ] as const)
        if (!same(old[field], now[field])) changes.push(`clause ${id} ${field} changed`);
  }
  if (before.readings.engine !== after.readings.engine) changes.push("engine's reading changed");
  if (before.readings.alternative !== after.readings.alternative)
    changes.push('alternative reading changed');
  if (before.cases.length !== after.cases.length)
    changes.push(`cases ${before.cases.length} → ${after.cases.length}`);
  before.cases.forEach((old, index) => {
    const now = after.cases[index];
    if (!now) return;
    const label = `case ${index + 1} («${old.title}»)`;
    if (old.title !== now.title || old.facts !== now.facts) changes.push(`${label} facts changed`);
    for (const reading of ['engine', 'alternative'] as const)
      if (!same(old[reading], now[reading]))
        changes.push(
          old[reading].summary === now[reading].summary
            ? `${label} ${reading} outcome details changed`
            : `${label} ${reading} outcome «${old[reading].summary}» → «${now[reading].summary}»`,
        );
  });
  if (!same(before.question, after.question)) changes.push('question changed');
  if (!same(before.scope, after.scope)) changes.push('scope changed');
  if (!same(before.gaps, after.gaps)) changes.push('stated gaps changed');
  if (!changes.length && !same(before, after)) changes.push('item changed');
  return changes;
}

/**
 * What keeps a review status honest: a version marked `interpreted` or `cases_approved` needs a
 * partner accountant's (or the expert's) record, and one marked `signed` the expert's; the
 * record's packet must hash to its packet hash, the reviewer must have chosen the engine's
 * reading (A), and the packet regenerated for that version (its item rebuilt from today's
 * register, spec and sources) must hash the same. Anything else names what changed.
 */
export function reviewProblems(context: ReviewContext, records: readonly ReviewRecord[]): string[] {
  const problems: string[] = [];
  const intact: ReviewRecord[] = [];
  for (const record of records) {
    const hash = hashOf(record.packet);
    if (hash !== record.packetSha256)
      problems.push(
        `${record.packetId}: the packet the record holds hashes to ${hash}, not ${record.packetSha256}`,
      );
    else if (packetIdOf(record.packet.items) !== record.packetId)
      problems.push(`${record.packetId}: the packet's content does not match its id`);
    else intact.push(record);
  }
  const latestFirst = [...intact].sort((a, b) => b.date.localeCompare(a.date));

  for (const version of context.register.versions) {
    const need = tierFor(version.status);
    if (!need) continue;
    const candidates = latestFirst.filter(
      (record) =>
        tierRank[record.tier] >= tierRank[need] &&
        record.packet.items.some((item) => item.versions.some((entry) => entry.id === version.id)),
    );
    if (!candidates.length) {
      problems.push(`${version.id}: ${version.status} without a ${need} review record`);
      continue;
    }
    const reasons: string[] = [];
    let bound = false;
    for (const record of candidates) {
      const item = record.packet.items.find((entry) =>
        entry.versions.some((reviewed) => reviewed.id === version.id),
      )!;
      const decision = record.decisions.find((entry) => entry.key === item.key);
      const why: string[] = [];
      if (decision?.choice !== 'A')
        why.push(
          decision
            ? `the reviewer chose ${decision.choice}${decision.text ? ` («${decision.text}»)` : ''}, not the engine's reading`
            : `no answer for ${item.key}`,
        );
      let current: PacketItem | undefined;
      try {
        current = buildItem(
          context,
          item.key,
          item.versions.map((entry) => entry.id),
        );
      } catch (error) {
        why.push(`cannot regenerate ${item.key}: ${(error as Error).message}`);
      }
      if (current) {
        const regenerated = {
          ...record.packet,
          items: record.packet.items.map((entry) => (entry === item ? current : entry)),
        };
        if (hashOf(regenerated) !== record.packetSha256) why.push(...itemChanges(item, current));
      }
      if (!why.length) {
        bound = true;
        break;
      }
      reasons.push(`${record.packetId} (${record.tier}, ${record.date}): ${why.join('; ')}`);
    }
    if (!bound)
      problems.push(
        `${version.id}: ${version.status}, but no review binds it: ${reasons.join(' | ')}`,
      );
  }
  return problems;
}
