/**
 * The PDF reader's process, spawned by `extractPdfText` (`pdf-text.ts`) or `pdfAttachments`
 * (`pdf-attachments.ts`); never imported. The PDF arrives on stdin; one JSON result leaves on
 * stdout, and the process exits. The mode and limits come as JSON in the first argument.
 */
import { createHash } from 'node:crypto';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFString,
  decodePDFRawStream,
} from 'pdf-lib';
import {
  pdfAttachmentsLimits,
  type PdfAttachmentLocation,
  type PdfAttachmentsWireResult,
} from './pdf-attachments';
import { pdfLines, pdfTextLimits, type PdfText, type PdfTextRun } from './pdf-text';

const rawArgs = JSON.parse(process.argv[2] ?? '{}') as Record<string, unknown>;
const mode = rawArgs.mode === 'attachments' ? 'attachments' : 'text';

const textLimits: Pick<typeof pdfTextLimits, 'pages' | 'textBytes' | 'memoryBytes'> = {
  ...pdfTextLimits,
  ...rawArgs,
};
const attachmentLimits: Pick<
  typeof pdfAttachmentsLimits,
  'pages' | 'attachments' | 'attachmentBytes' | 'memoryBytes'
> = {
  ...pdfAttachmentsLimits,
  ...rawArgs,
};
const memoryBytes = mode === 'attachments' ? attachmentLimits.memoryBytes : textLimits.memoryBytes;

const warnings: string[] = [];
// Nothing but the result may reach stdout: pdf.js reports warnings through the console.
for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
  console[method] =
    method === 'warn' && mode === 'attachments'
      ? (...args: unknown[]) => {
          warnings.push(args.map(String).join(' '));
        }
      : () => {};
}

// No native addon may load: pdf.js would reach for @napi-rs/canvas only to render, never here.
process.dlopen = () => {
  throw new Error('Native addons are disabled in the PDF reader.');
};
// No URL is given to pdf.js; should anything still try the network, it fails.
globalThis.fetch = Object.assign(
  () => Promise.reject(new Error('The network is disabled in the PDF reader.')),
  { preconnect: () => {} },
) as unknown as typeof fetch;
for (const name of ['WebSocket', 'EventSource', 'XMLHttpRequest'])
  Reflect.deleteProperty(globalThis, name);
// pdf.js 6 has no eval path left (its `isEvalSupported` option is gone); it compiles PostScript
// functions to WebAssembly, falling back to its interpreter without it. Nothing generates code.
Reflect.deleteProperty(globalThis, 'WebAssembly');

// The watchdog runs beside the parser, which may be stuck inflating a stream: past the memory
// limit it kills the process, which the caller reports as too large.
const watchdog = `setInterval(() => {
  if (process.memoryUsage.rss() > ${Number(memoryBytes)}) process.kill(process.pid, 'SIGKILL');
}, 10);`;
new Worker(URL.createObjectURL(new Blob([watchdog], { type: 'application/javascript' })));

async function finish(result: PdfText | PdfAttachmentsWireResult): Promise<never> {
  await Bun.write(Bun.stdout, JSON.stringify(result));
  process.exit(0);
}

const fatalAttachmentWarnings = [
  /\b_parsedAnnotations:/,
  /\bcollectAnnotationsByType:/,
  /\bcreateGlobals:/,
  /\bAnnotation is missing\b/,
  /\bignoring annotation data\b/,
  /\bignoring textContent\b/,
  /\bCannot fetch `oldAnnotation`/,
  /\bA non-linked annotation\b/,
  /\bAnnotationBorderStyle\b/,
  /\bPopup annotation\b/,
  /\bRichMedia annotation\b/,
  /\bSoundAnnotation\b/,
  /\bFreeTextAnnotation\b/,
  /\bInvalid stream:/,
  /\bEmpty "[^"]+" stream\./,
  /\bEmbedded file specification points to non-existing\/invalid content\b/,
  /\bRelated file specifications are not supported\b/,
  /\bgetContentStream - ignoring sub-stream\b/,
  /\breached the end of the stream\b/i,
  /\bEOD marker not found\b/,
  /\bEOI marker not found\b/,
  /\/DecodeParms should not be an Array\b/,
  /\bFilter "[^"]+" is not supported\./,
  /\bFilter "Crypt" is missing a cipher transform\./,
  /\bIndexing all PDF objects\b/,
  /\bXRef\.parse\b/,
  /\bindexObjects\b/,
  /\breadXRef\b/,
  /\bIgnoring circular reference:/,
  /\bSearch depth limit reached\b/,
  /\bInvalid PDF header version:/,
];

const hasFatalAttachmentWarning = () =>
  warnings.some((message) => fatalAttachmentWarnings.some((pattern) => pattern.test(message)));

const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const platformKeys = ['UF', 'F', 'Unix', 'Mac', 'DOS'] as const;

function decodePdfTextString(value: unknown): string | null {
  if (!(value instanceof PDFString) && !(value instanceof PDFHexString)) return null;
  const bytes = value.asBytes();
  let encoding: 'utf-16be' | 'utf-16le' | 'utf-8' | null = null;
  let payload = bytes;
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = 'utf-16be';
    payload = (bytes.length % 2 === 1 ? bytes.subarray(0, -1) : bytes).subarray(2);
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf-16le';
    payload = (bytes.length % 2 === 1 ? bytes.subarray(0, -1) : bytes).subarray(2);
  } else if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    encoding = 'utf-8';
    payload = bytes.subarray(3);
  }
  if (encoding) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(payload);
    } catch {
      // Fall through to PDFDocEncoding, matching pdf.js's stringToPDFString recovery.
    }
  }
  return PDFHexString.of(Buffer.from(bytes).toString('hex')).decodeText();
}

function normalizeFileName(raw: string): string {
  const normalized = raw.replaceAll('\\\\', '\\').replaceAll('\\/', '/').replaceAll('\\', '/');
  const slash = normalized.lastIndexOf('/');
  return (slash >= 0 ? normalized.slice(slash + 1) : normalized) || 'unnamed';
}

function getInheritableAnnots(node: PDFDict): PDFArray | undefined {
  const seen = new Set<PDFDict>();
  let current: PDFDict | undefined = node;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current.has(PDFName.of('Annots'))) {
      return current.lookupMaybe(PDFName.of('Annots'), PDFArray);
    }
    current = current.lookupMaybe(PDFName.of('Parent'), PDFDict);
  }
  return undefined;
}

class LimitError extends Error {
  constructor(
    readonly limit: 'pages' | 'attachments' | 'attachmentBytes',
    readonly pageCount?: number,
  ) {
    super(limit);
  }
}

async function readAttachmentsWithPdfLib(
  bytes: Uint8Array,
  limits: typeof attachmentLimits,
): Promise<
  | { ok: true; items: { name: string; sha256: string }[] }
  | Extract<PdfAttachmentsWireResult, { ok: false }>
> {
  try {
    const doc = await PDFDocument.load(bytes, {
      updateMetadata: false,
      throwOnInvalidObject: true,
    });
    const pageCount = doc.getPageCount();
    if (pageCount > limits.pages) throw new LimitError('pages', pageCount);

    const items: { name: string; sha256: string }[] = [];
    let totalBytes = 0;

    const pushSpec = (spec: PDFDict) => {
      let name = 'unnamed';
      for (const key of platformKeys) {
        if (spec.has(PDFName.of(key))) {
          const decoded = decodePdfTextString(spec.lookup(PDFName.of(key)));
          if (decoded !== null) name = normalizeFileName(decoded);
          break;
        }
      }
      const ef = spec.lookup(PDFName.of('EF'), PDFDict);
      let stream: PDFRawStream | undefined;
      for (const key of platformKeys) {
        if (ef.has(PDFName.of(key))) {
          const candidate = ef.lookup(PDFName.of(key));
          if (!(candidate instanceof PDFRawStream))
            throw new Error('Embedded file specification entry is not a stream.');
          stream = candidate;
          break;
        }
      }
      if (!stream) throw new Error('Embedded file specification has no stream.');
      if (items.length + 1 > limits.attachments) throw new LimitError('attachments');
      const decoded = decodePDFRawStream(stream).decode();
      totalBytes += decoded.length;
      if (totalBytes > limits.attachmentBytes) throw new LimitError('attachmentBytes');
      items.push({ name, sha256: sha256Hex(decoded) });
    };

    const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
    if (names?.has(PDFName.of('EmbeddedFiles'))) {
      const visited = new Set<string>();
      const walk = (nodeOrRef: unknown, depth: number) => {
        if (depth > 32) throw new Error('Name tree exceeds maximum depth.');
        if (nodeOrRef instanceof PDFRef) {
          const tag = `${nodeOrRef.objectNumber}:${nodeOrRef.generationNumber}`;
          if (visited.has(tag)) throw new Error('Cycle in EmbeddedFiles name tree.');
          visited.add(tag);
        }
        const node =
          nodeOrRef instanceof PDFDict
            ? nodeOrRef
            : nodeOrRef instanceof PDFRef
              ? doc.context.lookup(nodeOrRef, PDFDict)
              : undefined;
        if (!(node instanceof PDFDict)) throw new Error('Invalid EmbeddedFiles tree node.');
        if (node.has(PDFName.of('Kids'))) {
          const kids = node.lookup(PDFName.of('Kids'), PDFArray);
          for (let index = 0; index < kids.size(); index++) {
            walk(kids.get(index), depth + 1);
          }
        }
        if (node.has(PDFName.of('Names'))) {
          const entries = node.lookup(PDFName.of('Names'), PDFArray);
          if (entries.size() % 2 !== 0) throw new Error('Odd EmbeddedFiles /Names array.');
          for (let index = 0; index < entries.size(); index += 2) {
            pushSpec(entries.lookup(index + 1, PDFDict));
          }
        }
      };
      walk(names.get(PDFName.of('EmbeddedFiles')), 0);
    }

    for (const page of doc.getPages()) {
      const annots = getInheritableAnnots(page.node);
      if (!annots) continue;
      for (let index = 0; index < annots.size(); index++) {
        const raw = annots.get(index);
        if (raw instanceof PDFRef && !doc.context.lookup(raw)) {
          throw new Error('Dangling annotation reference.');
        }
        const annot = annots.lookupMaybe(index, PDFDict);
        if (!annot) continue;
        if (annot.lookupMaybe(PDFName.of('Subtype'), PDFName) !== PDFName.of('FileAttachment'))
          continue;
        pushSpec(annot.lookup(PDFName.of('FS'), PDFDict));
      }
    }

    return { ok: true, items };
  } catch (error) {
    if (error instanceof LimitError) {
      return {
        ok: false,
        reason: 'too_large',
        limit: error.limit,
        ...(error.pageCount !== undefined ? { pageCount: error.pageCount } : {}),
      };
    }
    if (error instanceof Error && error.name === 'EncryptedPDFError') {
      return { ok: false, reason: 'encrypted' };
    }
    return { ok: false, reason: 'corrupt' };
  }
}

function multisetKey(item: { name: string; sha256: string }) {
  return `${item.sha256}\0${item.name}`;
}

function sameMultiset(
  left: readonly { name: string; sha256: string }[],
  right: readonly { name: string; sha256: string }[],
) {
  if (left.length !== right.length) return false;
  const sortedLeft = left.map(multisetKey).sort();
  const sortedRight = right.map(multisetKey).sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

const input = new Uint8Array(await Bun.stdin.bytes());
// pdf.js's own worker runs on this thread ("fake worker"), so no thread parses beside it.
Object.assign(globalThis, {
  pdfjsWorker: await import(import.meta.resolve('pdfjs-dist/build/pdf.worker.mjs')),
});
const pdfjs = await import('pdfjs-dist');

let document: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>;
try {
  // Copy `input` in attachments mode because pdf.js transfers (detaches) its buffer.
  document = await pdfjs.getDocument({
    data: mode === 'attachments' ? input.slice() : input,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    disableAutoFetch: true,
    disableStream: true,
    disableRange: true,
    enableXfa: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    stopAtErrors: false,
    verbosity: mode === 'attachments' ? 1 : 0,
  }).promise;
} catch (error) {
  await finish({
    ok: false,
    reason: (error as Error)?.name === 'PasswordException' ? 'encrypted' : 'corrupt',
  });
}
const pageCount = document!.numPages;
const maxPages = mode === 'attachments' ? attachmentLimits.pages : textLimits.pages;
if (pageCount > maxPages)
  await finish({ ok: false, reason: 'too_large', limit: 'pages', pageCount });

if (mode === 'attachments') {
  if (hasFatalAttachmentWarning()) await finish({ ok: false, reason: 'corrupt' });

  const attachments: Extract<PdfAttachmentsWireResult, { ok: true }>['attachments'] = [];
  const jsMultiset: { name: string; sha256: string }[] = [];
  let totalBytes = 0;

  const pushAttachment = async (
    name: string,
    content: Uint8Array | null,
    location: PdfAttachmentLocation,
  ) => {
    if (content === null) await finish({ ok: false, reason: 'corrupt' });
    if (attachments.length + 1 > attachmentLimits.attachments)
      await finish({ ok: false, reason: 'too_large', limit: 'attachments' });
    totalBytes += content!.length;
    if (totalBytes > attachmentLimits.attachmentBytes)
      await finish({ ok: false, reason: 'too_large', limit: 'attachmentBytes' });
    jsMultiset.push({ name, sha256: sha256Hex(content!) });
    attachments.push({
      name,
      base64: Buffer.from(content!).toString('base64'),
      location,
    });
  };

  try {
    const docAttachments = await document!.getAttachments();
    if (docAttachments) {
      if (docAttachments.size > attachmentLimits.attachments)
        await finish({ ok: false, reason: 'too_large', limit: 'attachments' });
      for (const [id, entry] of docAttachments) {
        const content = await document!.getAttachmentContent(id);
        await pushAttachment(entry.filename, content, { kind: 'document' });
      }
    }
    for (let number = 1; number <= pageCount; number++) {
      const page = await document!.getPage(number);
      const annotations = (await page.getAnnotations({ intent: 'any' })) as unknown[];
      for (const item of annotations) {
        if (typeof item !== 'object' || item === null) continue;
        const annotation = item as {
          subtype?: unknown;
          fileId?: unknown;
          file?: { filename?: unknown };
        };
        if (annotation.subtype !== 'FileAttachment') continue;
        if (typeof annotation.fileId !== 'string' || !annotation.fileId)
          await finish({ ok: false, reason: 'corrupt' });
        const content = await document!.getAttachmentContent(annotation.fileId as string);
        const filename =
          typeof annotation.file?.filename === 'string' ? annotation.file.filename : 'unnamed';
        await pushAttachment(filename, content, { kind: 'page', page: number });
      }
      page.cleanup();
    }
    await document!.cleanup();
  } catch (error) {
    await finish({
      ok: false,
      reason: (error as Error)?.name === 'PasswordException' ? 'encrypted' : 'corrupt',
    });
  }

  if (hasFatalAttachmentWarning()) await finish({ ok: false, reason: 'corrupt' });

  const libResult = await readAttachmentsWithPdfLib(input, attachmentLimits);
  if (!libResult.ok) await finish(libResult);
  else if (!sameMultiset(jsMultiset, libResult.items))
    await finish({ ok: false, reason: 'ambiguous' });

  await finish({ ok: true, attachments });
}

const pages: string[][] = [];
let size = 0;
for (let number = 1; number <= pageCount; number++) {
  let lines: string[];
  try {
    const page = await document!.getPage(number);
    const content = await page.getTextContent();
    const runs: PdfTextRun[] = content.items.flatMap((item) => ('str' in item ? [item] : []));
    lines = pdfLines(runs, page.getViewport({ scale: 1 }).transform);
    page.cleanup();
  } catch {
    await finish({ ok: false, reason: 'corrupt' });
  }
  size += lines!.reduce((total, line) => total + Buffer.byteLength(line) + 1, 0);
  if (size > textLimits.textBytes)
    await finish({ ok: false, reason: 'too_large', limit: 'text', pageCount });
  pages.push(lines!);
}
await finish({ ok: true, pages });
