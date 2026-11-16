import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { comparePaths, fileSha256, ownerPath } from './files';
import type { CorpusRecord } from './inventory';

async function statOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function validatePath(path: string) {
  if (
    !path ||
    isAbsolute(path) ||
    /[\\\0:]/.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..') ||
    path.split('/')[0]!.toLowerCase() === 'manifest.json'
  )
    throw new Error('UNSAFE_CORPUS_PATH');
}

const within = (parent: string, path: string) => {
  const part = relative(parent, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
};

/** Resolve platform aliases such as /tmp before creating the output, but refuse an output
 * folder that is itself a symlink. Missing parents are resolved without writing them. */
async function outputRoot(path: string): Promise<string> {
  const absolute = resolve(path);
  const stat = await statOrNull(absolute);
  if (stat) {
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('UNSAFE_OUTPUT_FOLDER');
    return realpath(absolute);
  }
  const parent = dirname(absolute);
  if (parent === absolute) throw new Error('UNSAFE_OUTPUT_FOLDER');
  const ancestor = await statOrNull(parent);
  const base = ancestor ? await realpath(parent) : await outputRoot(parent);
  return join(base, relative(parent, absolute));
}

/** Preflight every existing component. Neither directory links nor file links may redirect
 * a read or replacement outside its declared tree. */
async function checkPath(root: string, path: string, source: boolean) {
  let current = root;
  const parts = path.split('/');
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    const stat = await statOrNull(current);
    if (!stat) {
      if (source) throw new Error('SOURCE_MISSING');
      return;
    }
    const leaf = index === parts.length - 1;
    if (stat.isSymbolicLink() || (leaf ? !stat.isFile() : !stat.isDirectory()))
      throw new Error(source ? 'UNSAFE_SOURCE_PATH' : 'UNSAFE_OUTPUT_PATH');
  }
}

async function replaceFile(destination: string, write: (path: string) => Promise<void>) {
  const temporary = await mkdtemp(join(dirname(destination), '.replay-'));
  try {
    const path = join(temporary, 'data');
    await write(path);
    await rename(path, destination);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export interface CopyResult {
  copied: number;
  unchanged: number;
  manifestChanged: boolean;
}

export interface CopyOptions {
  repair?: boolean;
}

export class OutputConflict extends Error {
  readonly code = 'OUTPUT_CONFLICT';

  constructor(readonly path: string) {
    super(`OUTPUT_CONFLICT: ${path}`);
    this.name = 'OutputConflict';
  }
}

/** The existing output chose a duplicate group's owner by another rule, so copies at paths the
 * current rule gives to duplicates are still in it. Repair never deletes files, so even
 * `repair` refuses: the output folder has to be removed and the corpus copied again. */
export class OwnerRuleChanged extends Error {
  readonly code = 'OWNER_RULE_CHANGED';

  constructor() {
    super(
      'OWNER_RULE_CHANGED: the output was made by a different duplicate owner rule and must be rebuilt: remove the output folder and copy again',
    );
    this.name = 'OwnerRuleChanged';
  }
}

/** True when a previous manifest names, for some content hash, an owner other than the one the
 * current rule picks among that manifest's own paths. A manifest that cannot be read this way
 * is left to the ordinary manifest comparison. */
function ownersFollowOtherRule(previous: Buffer): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(previous.toString('utf8'));
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  const groups = new Map<string, { paths: string[]; owners: string[] }>();
  for (const item of parsed as unknown[]) {
    const entry = item as { path?: unknown; sha256?: unknown; duplicateOf?: unknown } | null;
    if (typeof entry?.path !== 'string' || typeof entry.sha256 !== 'string') return false;
    const group = groups.get(entry.sha256) ?? { paths: [], owners: [] };
    group.paths.push(entry.path);
    if (entry.duplicateOf === null) group.owners.push(entry.path);
    groups.set(entry.sha256, group);
  }
  return [...groups.values()].some(
    ({ paths, owners }) => owners.length === 1 && owners[0] !== ownerPath(paths),
  );
}

/** The manifest has no run-specific fields. Replacements use fresh files so an existing
 * hardlink cannot modify the source. Different output bytes require explicit repair; all
 * conflicts are checked before writing, and matching files and manifests are left alone. */
export async function copyCorpus(
  source: string,
  output: string,
  records: readonly CorpusRecord[],
  options: CopyOptions = {},
): Promise<CopyResult> {
  const sourceRoot = await realpath(source);
  const targetRoot = await outputRoot(output);
  if (within(sourceRoot, targetRoot) || within(targetRoot, sourceRoot))
    throw new Error('SOURCE_OUTPUT_OVERLAP');
  const sorted = [...records].sort((a, b) => comparePaths(a.path, b.path));
  const paths = new Set<string>();
  for (const record of sorted) {
    validatePath(record.path);
    if (paths.has(record.path)) throw new Error('DUPLICATE_CORPUS_PATH');
    paths.add(record.path);
    if (
      !Number.isSafeInteger(record.size) ||
      record.size < 0 ||
      !/^[a-f0-9]{64}$/.test(record.sha256)
    )
      throw new Error('INVALID_CORPUS_RECORD');
    if (record.excluded.length) continue;
    await checkPath(sourceRoot, record.path, true);
    await checkPath(targetRoot, record.path, false);
  }
  await checkPath(targetRoot, 'manifest.json', false);
  const manifest = join(targetRoot, 'manifest.json');
  const previous = (await statOrNull(manifest)) ? await readFile(manifest) : null;
  if (previous !== null && ownersFollowOtherRule(previous)) throw new OwnerRuleChanged();
  const pending = new Set<string>();
  for (const record of sorted) {
    if (record.excluded.length) continue;
    const existing = await statOrNull(join(targetRoot, record.path));
    const matches =
      existing?.size === record.size &&
      (await fileSha256(join(targetRoot, record.path))) === record.sha256;
    if (existing && !matches && !options.repair) throw new OutputConflict(record.path);
    if (!matches) pending.add(record.path);
  }
  const serialized = Buffer.from(`${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
  const manifestChanged = previous === null || !previous.equals(serialized);
  if (previous !== null && manifestChanged && !options.repair)
    throw new OutputConflict('manifest.json');
  await mkdir(targetRoot, { recursive: true });
  let copied = 0;
  let unchanged = 0;
  for (const record of sorted) {
    if (record.excluded.length) continue;
    const from = join(sourceRoot, record.path);
    const to = join(targetRoot, record.path);
    if ((await lstat(from)).size !== record.size) throw new Error('SOURCE_CHANGED');
    if (!pending.has(record.path)) {
      if ((await fileSha256(from)) !== record.sha256) throw new Error('SOURCE_CHANGED');
      unchanged++;
      continue;
    }
    await mkdir(dirname(to), { recursive: true });
    await replaceFile(to, async (temporary) => {
      await copyFile(from, temporary);
      if ((await fileSha256(temporary)) !== record.sha256) throw new Error('SOURCE_CHANGED');
    });
    copied++;
  }
  if (manifestChanged) await replaceFile(manifest, (temporary) => writeFile(temporary, serialized));
  return { copied, unchanged, manifestChanged };
}
