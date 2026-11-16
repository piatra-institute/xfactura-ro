import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { MappingError, mappingSchema, type Mapping } from './schema';

const absent = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';
const contains = (root: string, path: string) => {
  const part = relative(root, path);
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};

/** The worktree's .private may be a shared symlink; descendants must never redirect writes. */
export async function privateMappingPath(
  path: string,
  repository = process.cwd(),
): Promise<string> {
  const root = resolve(repository, '.private');
  const target = resolve(repository, path);
  if (!contains(root, target)) throw new MappingError('MAPPING_OUTPUT_OUTSIDE_PRIVATE');
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const physicalRoot = await realpath(root);
    let current = root;
    for (const part of relative(root, dirname(target)).split(sep).filter(Boolean)) {
      current = join(current, part);
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error: unknown) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      }
      const info = await lstat(current);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        !contains(physicalRoot, await realpath(current))
      )
        throw new MappingError('MAPPING_OUTPUT_UNSAFE');
    }
    try {
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) throw new MappingError('MAPPING_OUTPUT_UNSAFE');
    } catch (error: unknown) {
      if (!absent(error)) throw error;
    }
    return target;
  } catch (error: unknown) {
    if (error instanceof MappingError) throw error;
    throw new MappingError('MAPPING_OUTPUT_UNAVAILABLE');
  }
}

export async function readMappingFile(
  path: string,
  repository?: string,
): Promise<Mapping | undefined> {
  const target = await privateMappingPath(path, repository);
  try {
    return mappingSchema.parse(JSON.parse(await readFile(target, 'utf8')));
  } catch (error: unknown) {
    if (absent(error)) return undefined;
    throw new MappingError('MAPPING_PREVIOUS_READ');
  }
}

export async function writeMappingFile(
  path: string,
  mapping: Mapping,
  repository?: string,
): Promise<void> {
  const target = await privateMappingPath(path, repository);
  const content = `${JSON.stringify(mappingSchema.parse(mapping), null, 2)}\n`;
  try {
    if ((await readFile(target, 'utf8')) === content) return;
  } catch (error: unknown) {
    if (!absent(error)) throw new MappingError('MAPPING_OUTPUT_READ');
  }
  const temporary = join(dirname(target), `.mapping-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    // Atomic replacement also avoids modifying any pre-existing hardlink outside .private.
    await privateMappingPath(path, repository);
    await rename(temporary, target);
  } catch {
    throw new MappingError('MAPPING_OUTPUT_WRITE');
  } finally {
    await rm(temporary, { force: true });
  }
}
