import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { loadCauses } from '../../packages/xfactura-replay/src/compare/causes';
import { ComparisonError } from '../../packages/xfactura-replay/src/compare/differences';
import { DifferenceStore } from '../../packages/xfactura-replay/src/compare/store';
import { readCompanyFilingDocuments } from '../../packages/xfactura-replay/src/mapping/corpus';
import { MappingError, readMappingFile } from '../../packages/xfactura-replay/src/mapping';
import {
  AssumptionError,
  labAssumptionsSchema,
  type LabAssumptions,
} from '../../packages/xfactura-replay/src/run/assumptions';
import { ReplayError, replayCompany } from '../../packages/xfactura-replay/src/run/driver';
import { openReplayEngine } from '../../packages/xfactura-replay/src/run/engine';

type Arguments = { alias: string; from?: string; to?: string; assumptions?: string };

export function parseJournalArguments(args: string[]): Arguments {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      const next = args[++i];
      if (
        !['--from', '--to', '--lab-assumptions'].includes(arg) ||
        !next ||
        next.startsWith('--') ||
        flags.has(arg)
      )
        throw new ReplayError('REPLAY_USAGE');
      flags.set(arg, next);
    } else positional.push(arg);
  }
  const [alias, ...rest] = positional;
  const month = /^\d{4}-(0[1-9]|1[0-2])$/;
  const from = flags.get('--from');
  const to = flags.get('--to');
  if (
    !alias ||
    rest.length ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(alias) ||
    (from !== undefined && !month.test(from)) ||
    (to !== undefined && !month.test(to)) ||
    (from && to && from > to)
  )
    throw new ReplayError('REPLAY_USAGE');
  return {
    alias,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(flags.has('--lab-assumptions') ? { assumptions: flags.get('--lab-assumptions')! } : {}),
  };
}

const inside = (root: string, path: string) => {
  const part = relative(root, path);
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};

/** A directory below `.private` that no symlink redirects. */
async function privateDirectory(privateRoot: string, parts: string[]): Promise<string> {
  let current = privateRoot;
  for (const part of parts) {
    current = join(current, part);
    await mkdir(current, { recursive: true, mode: 0o700 });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ReplayError('REPLAY_OUTPUT_UNSAFE');
  }
  return current;
}

async function readAssumptions(path: string, privateRoot: string): Promise<LabAssumptions> {
  const target = resolve(path);
  if (!inside(privateRoot, target))
    throw new AssumptionError('ASSUMPTION_FILE_OUTSIDE_PRIVATE', '');
  let content: string;
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink())
      throw new AssumptionError('ASSUMPTION_FILE_UNSAFE', '');
    content = await readFile(target, 'utf8');
  } catch (error) {
    if (error instanceof AssumptionError) throw error;
    throw new AssumptionError('ASSUMPTION_FILE_UNREADABLE', '');
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new AssumptionError('ASSUMPTION_JSON', '');
  }
  const parsed = labAssumptionsSchema.safeParse(value);
  if (!parsed.success)
    throw new AssumptionError('ASSUMPTION_SCHEMA', parsed.error.issues[0]!.path.join('.'));
  return parsed.data;
}

/** The engine secret of a company's replays, kept beside them so that reruns seal alike. */
async function engineSecret(directory: string): Promise<string> {
  const path = join(directory, 'engine.key');
  try {
    await writeFile(path, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new ReplayError('REPLAY_OUTPUT_UNSAFE');
  const secret = (await readFile(path, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new ReplayError('REPLAY_SECRET');
  return secret;
}

export async function runJournalCli(args: string[]): Promise<number> {
  const options = parseJournalArguments(args);
  const privateRoot = resolve('.private');
  const mapping = await readMappingFile(`.private/mapping/${options.alias}.json`);
  if (!mapping) throw new ReplayError('MAPPING_MISSING');
  const assumptions = options.assumptions
    ? await readAssumptions(options.assumptions, privateRoot)
    : undefined;
  const filings = await readCompanyFilingDocuments(mapping.company);
  const directory = await privateDirectory(privateRoot, ['replay', options.alias]);
  // Each run starts from an empty database.
  const engineDirectory = join(directory, 'engine');
  try {
    const info = await lstat(engineDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ReplayError('REPLAY_OUTPUT_UNSAFE');
    await rm(engineDirectory, { recursive: true });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  await privateDirectory(directory, ['engine']);
  const secret = await engineSecret(directory);
  const result = await replayCompany({
    alias: options.alias,
    filings,
    mapping,
    ...(assumptions ? { assumptions } : {}),
    ...(options.from ? { from: options.from } : {}),
    ...(options.to ? { to: options.to } : {}),
    open: (clock) =>
      openReplayEngine(engineDirectory, { secret, seed: `replay:${options.alias}`, clock }),
    store: new DifferenceStore(privateRoot, options.alias, 'replay'),
    causes: await loadCauses(),
  });
  const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  for (const [name, value] of [
    ['summary.json', result.summary],
    ['manifest.json', result.manifest],
  ] as const) {
    const path = join(directory, name);
    await rm(path, { force: true });
    await writeFile(path, text(value), { flag: 'wx', mode: 0o600 });
  }
  process.stdout.write(text(result.summary));
  return result.status === 'blocked' ? 2 : 0;
}

if (import.meta.main)
  runJournalCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      // Engine and parser messages can quote source values: print codes only.
      const known =
        error instanceof ReplayError ||
        error instanceof AssumptionError ||
        error instanceof MappingError ||
        error instanceof ComparisonError;
      const path = error instanceof AssumptionError && error.path ? ` (${error.path})` : '';
      process.stderr.write(
        `${known ? `${(error as { code: string }).code}${path}` : 'REPLAY_FAILED'}\n`,
      );
      if (process.env.XFACTURA_REPLAY_DEBUG === '1' && error instanceof Error)
        process.stderr.write(`${error.stack}\n`);
      process.exitCode = 1;
    });
