import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AssumptionError, labAssumptionsSchema, type LabAssumptions } from './assumptions';
import { ReplayError } from './driver';

const inside = (root: string, path: string) => {
  const part = relative(root, path);
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};

/** A directory below `.private` that no symlink redirects, made when absent. */
export async function privateDirectory(root: string, parts: readonly string[]): Promise<string> {
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    await mkdir(current, { recursive: true, mode: 0o700 });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ReplayError('REPLAY_OUTPUT_UNSAFE');
  }
  return current;
}

/** Removes a private directory's contents and makes it again, empty. */
export async function emptyDirectory(parent: string, name: string): Promise<string> {
  const path = join(parent, name);
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ReplayError('REPLAY_OUTPUT_UNSAFE');
    await rm(path, { recursive: true });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  return privateDirectory(parent, [name]);
}

/** A lab assumptions file, which must lie under `.private`. */
export async function readAssumptionsFile(
  path: string,
  privateRoot: string,
): Promise<LabAssumptions> {
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
export async function engineSecret(directory: string): Promise<string> {
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

/** Replaces a private file, mode 0600. */
export async function writePrivate(path: string, content: string | Uint8Array): Promise<void> {
  await rm(path, { force: true });
  await writeFile(path, content, { flag: 'wx', mode: 0o600 });
}
