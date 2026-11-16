import { comparePaths } from '../corpus/files';
import type { Mapping } from './schema';
import type { MappingProblem } from './check';

/** All public output consists of counts, fixed reason codes, and numeric schema paths. */
export function mappingSummary(mapping: Mapping, problems: MappingProblem[]) {
  const byRule = new Map<string, number>();
  const unresolvedByReason = new Map<string, number>();
  const unresolvedPathsByReason = new Map<string, string[]>();
  const blockingByReason = new Map<string, number>();
  const increment = (counts: Map<string, number>, key: string) =>
    counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const collection of ['accounts', 'partners'] as const)
    mapping[collection].forEach((entry, i) => {
      increment(byRule, entry.decidedBy);
      if ('target' in entry && entry.target.status === 'unresolved') {
        const reason = entry.target.reason;
        increment(unresolvedByReason, reason);
        const paths = unresolvedPathsByReason.get(reason) ?? [];
        paths.push(`${collection}.${i}.target`);
        unresolvedPathsByReason.set(reason, paths);
      }
    });
  for (const problem of problems) increment(blockingByReason, problem.code);
  const sorted = <T>(map: Map<string, T>) =>
    Object.fromEntries([...map].sort(([a], [b]) => comparePaths(a, b)));
  return {
    sourceAccounts: mapping.accounts.length,
    sourcePartners: mapping.partners.length,
    byRule: sorted(byRule),
    unresolvedByReason: sorted(unresolvedByReason),
    unresolvedPathsByReason: sorted(unresolvedPathsByReason),
    placeholderParties: mapping.placeholders.length,
    placeholderPartiesPerAccount: mapping.accounts.flatMap((account, i) => {
      const count = mapping.placeholders.filter(
        (p) => p.sourceAccountId === account.sourceId,
      ).length;
      return count ? [{ path: `accounts.${i}`, count }] : [];
    }),
    blockingByReason: sorted(blockingByReason),
    blocking: problems,
  };
}
