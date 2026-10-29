// Fetches the pinned official validation artifacts into .validators/, verifying each SHA-256.
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { $ } from 'bun';

const root = path.join(import.meta.dir, '../..', '.validators');
const { sources } = (await Bun.file(path.join(import.meta.dir, 'sources.json')).json()) as {
  sources: {
    name: string;
    url: string;
    sha256: string;
    extract?: string[];
    into?: string;
    /** Drop the archive's folders, for packages that keep their jars in one. */
    flatten?: boolean;
  }[];
};

for (const source of sources) {
  const directory = path.join(root, source.name);
  const file = path.join(directory, path.basename(new URL(source.url).pathname));
  const marker = `${file}.sha256`;
  if (existsSync(marker) && (await Bun.file(marker).text()).trim() === source.sha256) continue;
  await mkdir(directory, { recursive: true });
  const response = await fetch(source.url);
  if (!response.ok) throw new Error(`${source.url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  if (digest !== source.sha256)
    throw new Error(
      `${source.url}: SHA-256 ${digest}, pinned ${source.sha256}. Review the upstream change before updating the pin.`,
    );
  await writeFile(file, bytes);
  if (source.extract) {
    // Members land under `into` when the archive keeps them at its root (declaration packages).
    const target = path.join(directory, source.into ?? '');
    await mkdir(target, { recursive: true });
    for (const prefix of source.extract)
      if (prefix.endsWith('/'))
        await rm(path.join(target, prefix), { recursive: true, force: true });
    const flags = source.flatten ? ['-q', '-o', '-j'] : ['-q', '-o'];
    await $`unzip ${flags} ${file} ${source.extract.map((prefix) => `${prefix}*`)} -d ${target}`;
    await rm(file);
  }
  await writeFile(marker, `${source.sha256}\n`);
  console.log(`${source.name}: ${path.basename(file)} verified`);
}
console.log(`Validation artifacts are in ${root}.`);
