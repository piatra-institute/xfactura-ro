import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export const comparePaths = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Empty segments from a doubled or trailing separator do not count. */
const segments = (path: string) => path.split('/').filter(Boolean).length;

/** Orders the members of a duplicate group so the owner comes first: fewest path segments,
 * then code-unit order. Folder names play no part. */
export const compareOwners = (a: string, b: string) =>
  segments(a) - segments(b) || comparePaths(a, b);

/** The owner of one duplicate group; `paths` must not be empty. */
export const ownerPath = (paths: readonly string[]): string =>
  paths.reduce((owner, path) => (compareOwners(path, owner) < 0 ? path : owner));

/** Hash every byte without retaining database backups or SAF-T bodies in memory. */
export async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
