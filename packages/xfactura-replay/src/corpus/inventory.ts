import { createReadStream } from 'node:fs';
import { lstat, open, readdir, readFile, realpath } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import {
  pdfAttachments,
  pdfHasSignature,
} from '../../../xfactura-api/source/engine/adapters/pdf-attachments';
import { comparePaths, fileSha256, ownerPath } from './files';
import { readReturnXml, xmlChunks, type ReturnXml } from './xml';

export const corpusKinds = [
  'return-xml',
  'signed-return-pdf',
  'receipt',
  'annual-statement-pdf',
  'efactura-pdf',
  'd406',
  'revisal-export',
  'accounting-database-archive',
  'validator-kit',
  'failed-attempt',
  'other',
] as const;
export type CorpusKind = (typeof corpusKinds)[number];
export type ExclusionReason = 'validator-kit' | 'duplicate';
export type InventoryProblem =
  | 'XML_UNREADABLE'
  | 'PDF_UNREADABLE'
  | 'PDF_ATTACHMENTS_UNREADABLE'
  | 'PDF_ATTACHMENTS_IN_OBJECT_STREAM';

export interface CorpusRecord {
  path: string;
  size: number;
  sha256: string;
  kind: CorpusKind;
  returns: ReturnXml[];
  duplicateOf: string | null;
  excluded: ExclusionReason[];
  problems: InventoryProblem[];
}

interface Content {
  kind: CorpusKind | null;
  returns: ReturnXml[];
  problems: InventoryProblem[];
  pdf: boolean;
  archive: boolean;
  sqlite: boolean;
}

function looksXml(bytes: Uint8Array) {
  return /^\uFEFF?\s*</.test(new TextDecoder().decode(bytes));
}

function pathKind(path: string, content: Content): CorpusKind {
  if (content.kind) return content.kind;
  const folders = path.split('/').slice(0, -1);
  const databaseFolder = folders.some((folder) => /^(?:baza de date|backups?)$/i.test(folder));
  if (content.sqlite && folders.some((folder) => /revisal/i.test(folder))) return 'revisal-export';
  if (content.archive && databaseFolder) return 'accounting-database-archive';
  if (/(?:^|\/)(?:java|dist|duk-update)(?:\/|$)|\.(?:jar(?:\.new)?|class)$/i.test(path))
    return 'validator-kit';
  if (/\.xml\.(?:log|err\.txt)$/i.test(path)) return 'failed-attempt';
  if (/\.rvs$/i.test(path)) return 'revisal-export';
  if (databaseFolder && /\.(?:bck|fbk)$/i.test(path)) return 'accounting-database-archive';
  if (content.pdf) {
    if (/(?:^|\/)(?:recipis[aeă]|recipise)(?:[\s_./-]|$)/i.test(path)) return 'receipt';
    if (/(?:^|\/)e[\s-]?factura(?:[\s_/-]|$)/i.test(path)) return 'efactura-pdf';
  }
  return 'other';
}

/** File specifications may be hidden in object streams even when an EmbeddedFile stream
 * is visible. An XFA form's internal EmbeddedFile stream alone is not an attachment. */
function attachmentProblem(document: PDFDocument, raw: string): InventoryProblem | null {
  const visible = new Set(
    [...raw.matchAll(/(\d+)\s+(\d+)\s+obj\b/g)].map((match) => `${match[1]} ${match[2]}`),
  );
  const specifications = document.context
    .enumerateIndirectObjects()
    .filter(
      ([, object]) =>
        object instanceof PDFDict &&
        (object.get(PDFName.of('Type')) === PDFName.of('Filespec') || object.has(PDFName.of('EF'))),
    );
  const names = document.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  const hasNameTree = names?.has(PDFName.of('EmbeddedFiles')) ?? false;
  if (!specifications.length && !hasNameTree) return null;
  if (
    specifications.some(([ref]) => !visible.has(`${ref.objectNumber} ${ref.generationNumber}`)) ||
    (hasNameTree && !/\/(?:Filespec|EmbeddedFiles)\b/.test(raw) && /\/ObjStm\b/.test(raw))
  )
    return 'PDF_ATTACHMENTS_IN_OBJECT_STREAM';
  return 'PDF_ATTACHMENTS_UNREADABLE';
}

async function inspectPdf(bytes: Uint8Array, content: Content): Promise<void> {
  const raw = Buffer.from(bytes).toString('latin1');
  if (!raw.slice(0, 1024).includes('%PDF-')) {
    content.problems.push('PDF_UNREADABLE');
    return;
  }
  let attachments: ReturnType<typeof pdfAttachments> = [];
  try {
    attachments = pdfAttachments(bytes);
  } catch {
    // Diagnose attachment structure below without treating internal XFA streams as files.
  }
  for (const attachment of attachments) {
    if (!looksXml(attachment.bytes) && !/\.xml$/i.test(attachment.name)) continue;
    try {
      const parsed = await readReturnXml(xmlChunks(attachment.bytes));
      if (parsed) content.returns.push({ ...parsed, attachment: attachment.name });
    } catch {
      if (!content.problems.includes('XML_UNREADABLE')) content.problems.push('XML_UNREADABLE');
    }
  }
  if (content.returns.length) {
    content.pdf = true;
    content.kind = content.returns.some((item) => item.form === 'D406')
      ? 'd406'
      : content.returns.some((item) => item.form.startsWith('S'))
        ? 'annual-statement-pdf'
        : pdfHasSignature(bytes)
          ? 'signed-return-pdf'
          : 'other';
    return;
  }
  try {
    const document = await PDFDocument.load(bytes, {
      updateMetadata: false,
      throwOnInvalidObject: true,
    });
    document.getPageCount();
    content.pdf = true;
    if (attachments.length === 0) {
      const problem = attachmentProblem(document, raw);
      if (problem) content.problems.push(problem);
    }
    const description = `${document.getTitle() ?? ''} ${document.getSubject() ?? ''}`;
    if (/\brecipis[aă]\b/i.test(description)) content.kind = 'receipt';
    else if (/\be[\s-]?factura\b/i.test(description)) content.kind = 'efactura-pdf';
  } catch {
    if (attachments.length === 0 && /\/(?:Filespec|EmbeddedFiles)\b/.test(raw))
      content.problems.push('PDF_ATTACHMENTS_UNREADABLE');
    content.problems.push('PDF_UNREADABLE');
  }
}

async function inspectContent(path: string, prefix: Uint8Array): Promise<Content> {
  const content: Content = {
    kind: null,
    returns: [],
    problems: [],
    pdf: false,
    archive: false,
    sqlite: false,
  };
  const signature = Buffer.from(prefix).toString('latin1');
  content.archive = /^(?:PK\x03\x04|PK\x05\x06|Rar!\x1a\x07)/.test(signature);
  content.sqlite = signature.startsWith('SQLite format 3\0');
  if (content.archive || content.sqlite) return content;
  if (looksXml(prefix)) {
    try {
      const parsed = await readReturnXml(createReadStream(path, { highWaterMark: 8192 }));
      if (parsed) {
        content.returns.push(parsed);
        content.kind = parsed.form === 'D406' ? 'd406' : 'return-xml';
      }
    } catch {
      content.problems.push('XML_UNREADABLE');
    }
  } else if (signature.slice(0, 1024).includes('%PDF-') || extname(path).toLowerCase() === '.pdf') {
    await inspectPdf(await readFile(path), content);
  }
  return content;
}

async function walk(root: string, relative = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error('SOURCE_SYMLINK');
    if (entry.isDirectory()) files.push(...(await walk(root, path)));
    else if (entry.isFile()) files.push(path);
    else throw new Error('SOURCE_NOT_REGULAR_FILE');
  }
  return files;
}

/** No writes, dates or filename-derived fiscal facts. A duplicate group is owned by its path
 * with the fewest segments, then the first in code-unit order, including when that owner is
 * itself a validator file. Records stay in path order. */
export async function inventoryCorpus(source: string): Promise<CorpusRecord[]> {
  const root = await realpath(source);
  const paths = (await walk(root)).sort(comparePaths);
  const contentByHash = new Map<string, Content>();
  const facts = new Map<string, { size: number; sha256: string }>();
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const absolute = join(root, path);
    const size = (await lstat(absolute)).size;
    const sha256 = await fileSha256(absolute);
    facts.set(path, { size, sha256 });
    const group = groups.get(sha256);
    if (group) group.push(path);
    else groups.set(sha256, [path]);
  }
  const owners = new Map([...groups].map(([sha256, group]) => [sha256, ownerPath(group)]));
  const records: CorpusRecord[] = [];
  for (const path of paths) {
    const absolute = join(root, path);
    const { size, sha256 } = facts.get(path)!;
    const contentKey = `${sha256}:${extname(path).toLowerCase() === '.pdf' ? 'pdf' : ''}`;
    let content = contentByHash.get(contentKey);
    if (!content) {
      const file = await open(absolute, 'r');
      let prefix: Uint8Array;
      try {
        const buffer = new Uint8Array(4096);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        prefix = buffer.subarray(0, bytesRead);
      } finally {
        await file.close();
      }
      content = await inspectContent(absolute, prefix);
      contentByHash.set(contentKey, content);
    }
    const kind = pathKind(path, content);
    const owner = owners.get(sha256)!;
    const duplicateOf = owner === path ? null : owner;
    const excluded: ExclusionReason[] = [];
    if (kind === 'validator-kit') excluded.push('validator-kit');
    if (duplicateOf) excluded.push('duplicate');
    records.push({
      path,
      size,
      sha256,
      kind,
      returns: content.returns,
      duplicateOf,
      excluded,
      problems: content.problems,
    });
  }
  return records;
}
