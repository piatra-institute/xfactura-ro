import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export const comparePaths = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Hash every byte without retaining database backups or SAF-T bodies in memory. */
export async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
