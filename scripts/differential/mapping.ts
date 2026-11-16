import { lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chartAmendments, referenceChart } from '../../packages/xfactura-core/src/ro/chart';
import { comparePaths } from '../../packages/xfactura-replay/src/corpus/files';
import {
  readCompanyFilings,
  filingCoverage,
} from '../../packages/xfactura-replay/src/mapping/corpus';
import {
  MappingError,
  checkMapping,
  mappingSummary,
  proposeMapping,
  readMappingFile,
  readSagaDump,
  writeMappingFile,
} from '../../packages/xfactura-replay/src/mapping';

type Arguments = { alias: string; inputs: string[]; saga?: string; out: string };
export function parseMappingArguments(args: string[]): Arguments {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      const next = args[++i];
      if (!['--saga', '--out'].includes(arg) || !next || next.startsWith('--') || flags.has(arg))
        throw new MappingError('MAPPING_USAGE');
      flags.set(arg, next);
    } else positional.push(arg);
  }
  const [alias, ...inputs] = positional;
  if (!alias || !/^[a-z][a-z0-9_-]{0,63}$/.test(alias) || !inputs.length)
    throw new MappingError('MAPPING_USAGE');
  return {
    alias,
    inputs,
    saga: flags.get('--saga'),
    out: flags.get('--out') ?? `.private/mapping/${alias}.json`,
  };
}

async function inputFiles(inputs: string[]): Promise<string[]> {
  const files = new Set<string>();
  const visit = async (path: string) => {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new MappingError('MAPPING_INPUT_SYMLINK');
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort(comparePaths)) await visit(join(path, name));
    } else if (info.isFile() && /\.xml$/i.test(path)) files.add(path);
  };
  for (const input of inputs) await visit(resolve(input));
  if (!files.size) throw new MappingError('MAPPING_INPUT_EMPTY');
  return [...files].sort(comparePaths);
}

export async function runMappingCli(args: string[]): Promise<number> {
  const options = parseMappingArguments(args);
  // Validate the output boundary before touching any company data.
  const previous = await readMappingFile(options.out);
  const saga = options.saga ? await readSagaDump(options.saga) : undefined;
  const filed = await readCompanyFilings(await inputFiles(options.inputs));
  // Offline proposals use the same reference chart and amendments as company initialization.
  // An engine caller supplies accounts.list and parties.list to proposeMapping instead.
  const chart = [...referenceChart.accounts, ...chartAmendments.flatMap((a) => a.accounts)];
  const mapping = proposeMapping(filed, chart, [], previous, { saga });
  const problems = checkMapping(mapping, filed);
  await writeMappingFile(options.out, mapping);
  process.stdout.write(
    `${JSON.stringify({ ...filingCoverage(filed), ...mappingSummary(mapping, problems) }, null, 2)}\n`,
  );
  return problems.length ? 2 : 0;
}

if (import.meta.main)
  runMappingCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      // Parsers and filesystem errors can quote personal source values or filenames.
      process.stderr.write(
        `${error instanceof MappingError ? error.message : 'MAPPING_READ: Fișierele nu au putut fi citite.'}\n`,
      );
      process.exitCode = 1;
    });
