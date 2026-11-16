import { lstat, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { fail, order } from './differences';

const manifestSchema = z.array(
  z.object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    duplicateOf: z.string().nullable(),
    excluded: z.array(z.string()),
    returns: z.array(
      z.object({
        form: z.string(),
        fiscalCode: z.string().nullable(),
        attachment: z.string().nullable(),
      }),
    ),
  }),
);
export const fiscalIdentity = (value: string) => value.trim().replace(/^RO/i, '');

function safePath(path: string) {
  if (
    isAbsolute(path) ||
    /[\\\0:]/.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    fail('SOURCE_CHAIN_MANIFEST_PATH', 'Manifestul conține o cale nesigură.');
}

export type ManifestD406File = { path: string; sha256: string; attachments: Set<string | null> };

/** Select identity from metadata, then resolve copied byte owners without trusting folders. */
export async function manifestD406Files(
  manifest: string,
  fiscalCode: string,
): Promise<ManifestD406File[]> {
  if (!(await lstat(manifest)).isFile())
    fail('SOURCE_CHAIN_MANIFEST', 'Manifestul trebuie să fie un fișier obișnuit.');
  let json: unknown;
  try {
    json = JSON.parse(await readFile(manifest, 'utf8'));
  } catch {
    fail('SOURCE_CHAIN_MANIFEST', 'Manifestul nu este JSON valid.');
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success)
    fail('SOURCE_CHAIN_MANIFEST', 'Manifestul nu respectă structura corpusului.');
  const records = new Map(parsed.data.map((record) => [record.path, record]));
  if (records.size !== parsed.data.length)
    fail('SOURCE_CHAIN_MANIFEST', 'Manifestul conține căi duplicate.');
  const selected = new Map<string, ManifestD406File>();
  for (const record of records.values()) {
    const returns = record.returns.filter(
      (item) =>
        item.form === 'D406' &&
        item.fiscalCode !== null &&
        fiscalIdentity(item.fiscalCode) === fiscalIdentity(fiscalCode),
    );
    if (!returns.length) continue;
    let owner = record;
    const visited = new Set<string>();
    for (;;) {
      safePath(owner.path);
      if (visited.has(owner.path))
        fail('SOURCE_CHAIN_MANIFEST_DUPLICATE', 'Lanțul duplicatelor este circular.');
      visited.add(owner.path);
      if (owner.duplicateOf === null) break;
      safePath(owner.duplicateOf);
      const next = records.get(owner.duplicateOf);
      if (!next || next.sha256 !== record.sha256)
        fail(
          'SOURCE_CHAIN_MANIFEST_DUPLICATE',
          'Proprietarul duplicatului lipsește sau are alt conținut.',
        );
      owner = next;
    }
    if (owner.excluded.length)
      fail(
        'SOURCE_CHAIN_MANIFEST_DUPLICATE',
        'Proprietarul duplicatului nu este disponibil în copia corpusului.',
      );
    const file = selected.get(owner.path) ?? {
      path: join(dirname(manifest), owner.path),
      sha256: owner.sha256,
      attachments: new Set<string | null>(),
    };
    for (const item of returns) file.attachments.add(item.attachment);
    selected.set(owner.path, file);
  }
  for (const [path] of selected) {
    let current = dirname(manifest);
    const parts = path.split('/');
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const info = await lstat(current);
      if (
        info.isSymbolicLink() ||
        (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())
      )
        fail(
          'SOURCE_CHAIN_MANIFEST_PATH',
          'Calea din manifest nu poate conține legături simbolice.',
        );
    }
  }
  return [...selected.values()].sort((a, b) => order(a.path, b.path));
}
