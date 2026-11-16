import { copyCorpus } from '../../packages/xfactura-replay/src/corpus/copy';
import { comparePaths } from '../../packages/xfactura-replay/src/corpus/files';
import {
  corpusKinds,
  inventoryCorpus,
  type CorpusRecord,
} from '../../packages/xfactura-replay/src/corpus/inventory';

export function inventorySummary(records: readonly CorpusRecord[]) {
  const byKind = Object.fromEntries(corpusKinds.map((kind) => [kind, 0]));
  const byFormAndVersion = new Map<string, number>();
  const byCompanyCode = new Map<string, number>();
  const problems = new Map<string, number>();
  const excludedByReason = { 'validator-kit': 0, duplicate: 0 };
  let excludedFiles = 0;
  let excludedBytes = 0;
  const increment = (counts: Map<string, number>, key: string) =>
    counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const record of records) {
    byKind[record.kind]!++;
    for (const key of new Set(record.returns.map((item) => `${item.form} v${item.version}`)))
      increment(byFormAndVersion, key);
    for (const code of new Set(record.returns.map((item) => item.fiscalCode)))
      if (code !== null) increment(byCompanyCode, code);
    for (const problem of record.problems) increment(problems, problem);
    if (record.excluded.length) {
      excludedFiles++;
      excludedBytes += record.size;
      for (const reason of record.excluded) excludedByReason[reason]++;
    }
  }
  const sorted = (counts: Map<string, number>) =>
    Object.fromEntries([...counts].sort(([a], [b]) => comparePaths(a, b)));
  return {
    totalFiles: records.length,
    includedFiles: records.length - excludedFiles,
    byKind,
    byFormAndVersion: sorted(byFormAndVersion),
    byCompanyCode: sorted(byCompanyCode),
    excludedFiles,
    excludedBytes,
    excludedByReason,
    problems: sorted(problems),
  };
}

async function main(args: string[]): Promise<void> {
  const dry = args.includes('--dry');
  const repair = args.includes('--repair');
  const positional = args.filter((arg) => arg !== '--dry' && arg !== '--repair');
  if (
    positional.length !== 2 ||
    args.filter((arg) => arg === '--dry').length > 1 ||
    args.filter((arg) => arg === '--repair').length > 1 ||
    positional.some((arg) => arg.startsWith('--'))
  )
    throw new Error(
      'Usage: bun scripts/differential/inventory.ts <source> <output> [--dry] [--repair]',
    );
  const [source, output] = positional as [string, string];
  const records = await inventoryCorpus(source);
  const summary = inventorySummary(records);
  if (dry) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  else {
    const result = await copyCorpus(source, output, records, { repair });
    process.stdout.write(`${JSON.stringify({ ...summary, ...result }, null, 2)}\n`);
  }
}

if (import.meta.main)
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'INVENTORY_FAILED'}\n`);
    process.exitCode = 1;
  });
