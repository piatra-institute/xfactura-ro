// Fetches the official sources the rule register cites (src/ro/sources) into .sources/, and
// checks them: a registered snapshot must hash the same (a difference is drift to review, never
// an automatic update), and a source without a snapshot prints the hash to register. Files the
// owner downloads by hand (sites that refuse automated access) go in .sources/inbox/, where
// they are matched to sources by hash.
//   bun scripts/sources/fetch.ts
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { legalSources } from '../../packages/xfactura-core/src/ro/sources';

const root = path.join(import.meta.dir, '../..', '.sources');
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
let drift = 0;

for (const source of legalSources.filter((item) => item.fetch)) {
  for (const url of source.urls) {
    const response = await fetch(url);
    if (!response.ok) {
      console.log(`unavailable ${source.id}: HTTP ${response.status} ${url}`);
      continue;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const hash = sha256(bytes);
    const directory = path.join(root, source.id.replace(/[^\w.-]+/g, '_'));
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, path.basename(new URL(url).pathname)), bytes);
    const registered = source.snapshots.filter((snapshot) => snapshot.url === url);
    if (!registered.length)
      console.log(
        `new ${source.id}: sha256 ${hash} (${response.headers.get('content-type')}) ${url}`,
      );
    else if (registered.some((snapshot) => snapshot.sha256 === hash))
      console.log(`verified ${source.id}`);
    else {
      drift += 1;
      console.log(
        `DRIFT ${source.id}: ${url} now hashes ${hash}; review the change before re-pinning.`,
      );
    }
  }
}

const inbox = path.join(root, 'inbox');
if (existsSync(inbox))
  for (const name of readdirSync(inbox)) {
    const hash = sha256(await readFile(path.join(inbox, name)));
    const match = legalSources.find((source) =>
      source.snapshots.some((snapshot) => snapshot.sha256 === hash),
    );
    console.log(
      match ? `inbox ${name}: ${match.id}` : `inbox ${name}: sha256 ${hash}, not yet registered`,
    );
  }
process.exit(drift ? 1 : 0);
