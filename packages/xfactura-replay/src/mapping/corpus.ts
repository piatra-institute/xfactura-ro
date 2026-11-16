import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { readD406, type D406Filed } from 'xfactura-core/ro/saft/read';
import { pdfAttachments } from '../../../xfactura-api/source/engine/adapters/pdf-attachments';
import { comparePaths } from '../corpus/files';
import { MappingError } from './schema';
import { filedCompany } from './propose';

const manifestSchema = z.array(
  z.object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    duplicateOf: z.string().nullable(),
    excluded: z.array(z.enum(['duplicate', 'validator-kit'])),
    returns: z.array(
      z.object({
        form: z.string(),
        fiscalCode: z.string().nullable(),
        attachment: z.string().nullable(),
      }),
    ),
  }),
);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const companyCode = (value: string) => value.replace(/\s+/g, '').replace(/^RO/i, '');
const within = (root: string, path: string) => {
  const suffix = relative(root, path);
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
};

function relativeParts(path: string): string[] {
  const parts = path.split('/');
  if (
    isAbsolute(path) ||
    /^[A-Za-z]:/.test(path) ||
    path.includes('\\') ||
    parts.some((part) => !part || part === '.' || part === '..')
  )
    throw new MappingError('MAPPING_CORPUS_PATH');
  return parts;
}

async function corpusFile(root: string, path: string): Promise<Uint8Array> {
  const parts = relativeParts(path);
  let current = root;
  for (const [i, part] of parts.entries()) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (i === parts.length - 1 ? !info.isFile() : !info.isDirectory()))
      throw new MappingError('MAPPING_INPUT_SYMLINK');
  }
  return readFile(current);
}

/** Input files identify the company; the manifest owns the corpus's complete filing set. */
export async function readCompanyFilings(
  inputs: readonly string[],
  manifestPath = resolve('.private/corpus/manifest.json'),
): Promise<D406Filed[]> {
  const seedBytes = await Promise.all(inputs.map((path) => readFile(path)));
  const seeds = seedBytes.map(readD406);
  const company = filedCompany(seeds);
  const root = dirname(manifestPath);
  let content: string;
  try {
    const info = await lstat(manifestPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new MappingError('MAPPING_CORPUS_PATH');
    content = await readFile(manifestPath, 'utf8');
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    if (inputs.some((input) => within(root, resolve(input))))
      throw new MappingError('MAPPING_CORPUS_MANIFEST_REQUIRED');
    // Filesystem aliases such as macOS /var and /private/var must not turn a corpus
    // input into standalone mode when its manifest is absent.
    let physicalRoot: string | undefined;
    try {
      physicalRoot = await realpath(root);
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    if (physicalRoot)
      for (const input of inputs)
        if (within(physicalRoot, await realpath(input)))
          throw new MappingError('MAPPING_CORPUS_MANIFEST_REQUIRED');
    return [...new Map(seedBytes.map((bytes, i) => [digest(bytes), seeds[i]!])).values()];
  }
  const parsed = manifestSchema.safeParse(JSON.parse(content));
  if (!parsed.success) throw new MappingError('MAPPING_CORPUS_SCHEMA');
  const records = new Map(parsed.data.map((record) => [record.path, record]));
  if (records.size !== parsed.data.length) throw new MappingError('MAPPING_CORPUS_DUPLICATE');
  for (const record of records.values()) relativeParts(record.path);
  const canonical = (path: string) => {
    const visited = new Set<string>();
    let record = records.get(path)!;
    const sha256 = record.sha256;
    while (record.duplicateOf !== null) {
      if (visited.has(record.path)) throw new MappingError('MAPPING_CORPUS_DUPLICATE');
      visited.add(record.path);
      const next = records.get(record.duplicateOf);
      if (!next || next.sha256 !== sha256) throw new MappingError('MAPPING_CORPUS_DUPLICATE');
      record = next;
    }
    if (record.excluded.length) throw new MappingError('MAPPING_CORPUS_EXCLUDED');
    return record;
  };
  const files = new Map<string, Uint8Array>();
  const attachments = new Map<string, ReturnType<typeof pdfAttachments>>();
  const documents = new Map<string, D406Filed>();
  for (const record of [...records.values()].sort((a, b) => comparePaths(a.path, b.path))) {
    const matching = record.returns.filter(
      (item) =>
        item.form === 'D406' &&
        item.fiscalCode !== null &&
        companyCode(item.fiscalCode) === company,
    );
    if (!matching.length) continue;
    const owner = canonical(record.path);
    let bytes = files.get(owner.path);
    if (!bytes) {
      bytes = await corpusFile(root, owner.path);
      if (digest(bytes) !== owner.sha256) throw new MappingError('MAPPING_CORPUS_CHANGED');
      files.set(owner.path, bytes);
    }
    for (const item of matching) {
      let xml = bytes;
      if (item.attachment !== null) {
        let extracted = attachments.get(owner.path);
        if (!extracted) {
          extracted = pdfAttachments(bytes);
          attachments.set(owner.path, extracted);
        }
        const matches = extracted.filter((attachment) => attachment.name === item.attachment);
        if (matches.length !== 1) throw new MappingError('MAPPING_CORPUS_ATTACHMENT');
        xml = matches[0]!.bytes;
      }
      const hash = digest(xml);
      if (documents.has(hash)) continue;
      const filed = readD406(xml);
      if (filedCompany([filed]) !== company) throw new MappingError('MAPPING_COMPANY_MISMATCH');
      documents.set(hash, filed);
    }
  }
  if (!documents.size) throw new MappingError('MAPPING_CORPUS_COMPANY_UNKNOWN');
  return [...documents.values()];
}

export function filingCoverage(filed: readonly D406Filed[]) {
  const periods = new Set(
    filed.flatMap(({ header }) =>
      header.selection.start && header.selection.end
        ? [JSON.stringify([header.selection.start, header.selection.end])]
        : [],
    ),
  );
  return { periodsCovered: periods.size, filedDocuments: filed.length };
}
