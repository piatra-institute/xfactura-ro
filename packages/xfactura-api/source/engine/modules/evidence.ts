import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { evidence } from '../db/schema';
import { idSchema, type Actor, type Commands } from '../kernel/commands';
import { sha256, type ObjectStore } from '../adapters/object-store';
import {
  decodeText,
  evidenceFormats,
  imageSize,
  imageType,
  longLine,
  sniffFormat,
  textEncodings,
  textFileExtractor,
  textFileLines,
  visionImageTypes,
  type EvidenceFormat,
  type VisionImageType,
} from '../adapters/evidence-text';
import {
  extractPdfText,
  pdfTextExtractor,
  pdfTextLimits,
  pdfTextSettled,
  type PdfText,
} from '../adapters/pdf-text';

export const evidenceInput = z
  .object({
    filename: z
      .string()
      .min(1)
      .max(240)
      .refine((name) => !/[\x00-\x1f]/.test(name), 'Numele documentului nu este valid.'),
    mediaType: z.string().min(1).max(150),
    base64: z.base64().max(Math.ceil((64 * 1024 * 1024 * 4) / 3)),
  })
  .strict();
export const evidenceView = z.object({
  id: z.string(),
  hash: z.string(),
  filename: z.string(),
  mediaType: z.string(),
  size: z.number(),
});

/** What `evidence.read` returns per call, at most; the inline limit SECURITY.md promises. */
export const evidenceReadLimit = 256 * 1024;
/** The least an agent may ask for: the envelope and one part of a line always fit. */
const evidenceReadMinimum = 8 * 1024;
/**
 * The largest image `evidence.read` returns (mode `image`), whose base64 is then at most 5 MiB:
 * the per-image limit of the common vision APIs, measured on the base64 (Anthropic's on Amazon
 * Bedrock and Google Cloud; its own API takes 10 MB). `maxBytes` does not apply to images.
 */
export const imageBase64Limit = 5 * 1024 * 1024;
export const imageByteLimit = (imageBase64Limit / 4) * 3;
/** The longest side a vision model accepts, in pixels. */
export const imagePixelLimit = 8000;

export const evidenceReadInput = z
  .object({
    id: z.uuid(),
    /** `meta`: what the file is and how to read it; `text`: its lines, page by page; `image`: a
     * photo or scan itself, base64, for the agent's own vision model. */
    mode: z.enum(['meta', 'text', 'image']),
    /** Only this page (from 1); without it, from the first page or the cursor on. */
    page: z.number().int().min(1).max(100_000).optional(),
    /** The previous call's `next`, to continue where it stopped. */
    cursor: z
      .string()
      .regex(/^\d{1,6}:\d{1,7}$/)
      .nullable()
      .optional(),
    /** The most bytes this call's JSON result may take. */
    maxBytes: z.number().int().min(evidenceReadMinimum).max(evidenceReadLimit).default(65_536),
  })
  .strict();

const readingFailure = z.object({
  reason: z.enum(['encrypted', 'corrupt', 'too_large', 'timeout', 'failed']),
  limit: z.enum(['input', 'pages', 'text', 'memory']).nullable(),
});
export const evidenceReading = evidenceView.extend({
  /** What the bytes are, whatever media type the file was declared with. */
  format: z.enum(evidenceFormats),
  encoding: z.enum(textEncodings).nullable(),
  /** Pages of a PDF; 1 for a text file or an image; null when unknown. */
  pageCount: z.number().nullable(),
  /** Whether the engine reads text in the file; when false, nothing here can be cited. */
  textLayer: z.boolean(),
  pagesWithoutText: z.array(z.number()),
  /** How to read it: `text` here, `vision` with the agent's own model (no OCR on the server),
   * or `unreadable` (see `failure` and `note`). */
  reading: z.enum(['text', 'vision', 'unreadable']),
  failure: readingFailure.nullable(),
  /** The text layer's version; line numbers, and citations to them, hold for it. */
  extractor: z.string().nullable(),
  /** What to do next, for agents, in English; null when the text reads whole. */
  note: z.string().nullable(),
  /** `text` mode: the lines of the pages read, numbered from 1 on each page. A line longer than
   * 1,000 characters comes in parts, each with the line's number. */
  pages: z
    .array(
      z.object({
        page: z.number(),
        lineCount: z.number(),
        lines: z.array(
          z.object({
            line: z.number(),
            text: z.string(),
            part: z.number().optional(),
            parts: z.number().optional(),
          }),
        ),
      }),
    )
    .optional(),
  /** `text` mode: the cursor of the rest, or null when this call reached the end. */
  next: z.string().nullable().optional(),
  /** `image` mode: the image, its type judged from its bytes, its size from its header (null
   * when the header does not say). Over MCP the bytes travel as an image content block instead
   * of `base64`. */
  image: z
    .object({
      mediaType: z.enum(visionImageTypes),
      width: z.number().nullable(),
      height: z.number().nullable(),
      bytes: z.number(),
      base64: z.string().optional(),
    })
    .optional(),
});
export type EvidenceReading = z.infer<typeof evidenceReading>;

/** A file's text layer: what `evidence.read` shows and what citations are checked against. */
const textLayer = z.object({
  format: z.enum(evidenceFormats),
  encoding: z.enum(textEncodings).nullable(),
  extractor: z.string().nullable(),
  pageCount: z.number().nullable(),
  /** `pages[p - 1][l - 1]` is line `l` of page `p`. */
  pages: z.array(z.array(z.string())),
  failure: readingFailure.nullable(),
});
export type TextLayer = z.infer<typeof textLayer>;

/** The cached text layer's kind: every reader's version, so that a new one derives it again. */
const textLayerKind = `text-layer.1.${textFileExtractor}.${pdfTextExtractor}`;
const textFileLimit = pdfTextLimits.inputBytes;

type EvidenceRecord = typeof evidence.$inferSelect;

/** Original source files: immutable, content-addressed and company-scoped. */
export class Evidence {
  /** Text layers being derived, so that concurrent reads of one file start one reader. */
  private readonly deriving = new Map<string, Promise<TextLayer>>();

  constructor(
    private readonly commands: Commands,
    private readonly objects: ObjectStore,
  ) {}

  async record(actor: Actor, key: string, input: z.infer<typeof evidenceInput>) {
    const bytes = Buffer.from(input.base64, 'base64');
    const hash = sha256(bytes);
    return this.commands.run(
      actor,
      key,
      'evidence.record',
      { hash, filename: input.filename, mediaType: input.mediaType },
      'write',
      async (tx) => {
        const [existing] = await tx
          .select()
          .from(evidence)
          .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.hash, hash)));
        if (existing)
          return {
            id: existing.id,
            hash,
            filename: existing.filename,
            mediaType: existing.mediaType,
            size: existing.size,
          };
        await this.objects.put(actor.companyId, bytes, 64 * 1024 * 1024);
        const id = this.commands.ids();
        await tx.insert(evidence).values({
          id,
          companyId: actor.companyId,
          hash,
          filename: input.filename,
          mediaType: input.mediaType,
          size: bytes.length,
          createdBy: actor.actorId,
          engineAt: this.commands.clock(),
        });
        return {
          id,
          hash,
          filename: input.filename,
          mediaType: input.mediaType,
          size: bytes.length,
        };
      },
    );
  }

  list(actor: Actor) {
    return this.commands.read(actor, 'evidence.list', (tx) =>
      tx
        .select({
          id: evidence.id,
          hash: evidence.hash,
          filename: evidence.filename,
          mediaType: evidence.mediaType,
          size: evidence.size,
        })
        .from(evidence)
        .where(eq(evidence.companyId, actor.companyId))
        .orderBy(asc(evidence.createdAt), asc(evidence.id)),
    );
  }

  /** The whole file, for people (`evidence.get`, the REST download): agents are refused, as
   * `evidence.get` is no agent operation; they read with `readText`. */
  async read(actor: Actor, id: string) {
    idSchema.parse(id);
    return this.commands.read(actor, 'evidence.get', async (tx) => {
      const [record] = await tx
        .select()
        .from(evidence)
        .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, id)));
      requireCondition(record, 'NOT_FOUND', 'Documentul nu este disponibil.', 404);
      return { record, bytes: await this.objects.get(actor.companyId, record.hash) };
    });
  }

  /** `evidence.read`: what a file is and how to read it, or its lines, page by page. */
  async readText(actor: Actor, input: z.infer<typeof evidenceReadInput>): Promise<EvidenceReading> {
    const record = await this.commands.read(actor, 'evidence.read', async (tx) => {
      const [row] = await tx
        .select()
        .from(evidence)
        .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, input.id)));
      requireCondition(row, 'NOT_FOUND', 'Documentul nu este disponibil.', 404);
      return row;
    });
    // An image is refused before anything is derived from a file that is none.
    const image = input.mode === 'image' ? await this.image(actor.companyId, record) : undefined;
    // Outside the read transaction: a PDF may take seconds to read.
    const layer = await this.textLayer(actor.companyId, record);
    const base = describeLayer(record, layer);
    if (input.page !== undefined)
      requireCondition(
        base.pageCount !== null && input.page <= base.pageCount,
        'EVIDENCE_PAGE',
        'Pagina nu există în document.',
        422,
        { pageCount: base.pageCount },
      );
    if (image) return { ...base, image };
    if (input.mode === 'meta') return base;
    if (base.reading !== 'text') return { ...base, pages: [], next: null };
    return paginate(base, layer.pages, input);
  }

  /**
   * An image for the agent's own vision model: JPEG, PNG, GIF or WebP, at most `imageByteLimit`
   * bytes (5 MiB of base64) and `imagePixelLimit` pixels a side. Refused otherwise, saying what
   * to ask the person for.
   */
  private async image(companyId: string, record: EvidenceRecord) {
    const bytes = await this.objects.get(companyId, record.hash);
    const type = imageType(bytes);
    requireCondition(
      type !== null,
      'EVIDENCE_NOT_IMAGE',
      'Documentul nu este o imagine: citiți-l în modul text.',
      422,
      { format: sniffFormat(bytes, record.mediaType, record.filename) },
    );
    requireCondition(
      (visionImageTypes as readonly string[]).includes(type),
      'EVIDENCE_IMAGE_FORMAT',
      `Imaginile ${type.toUpperCase()} nu sunt citite de modelele de vedere: cereți o copie JPEG sau PNG.`,
      422,
      { format: type, accepted: [...visionImageTypes] },
    );
    const mediaType = type as VisionImageType;
    requireCondition(
      bytes.length <= imageByteLimit,
      'EVIDENCE_IMAGE_SIZE',
      `Imaginea are ${(bytes.length / 1024 / 1024).toFixed(1)} MiB; în base64 depășește 5 MiB, limita pe imagine a modelelor de vedere: cereți o copie mai mică.`,
      422,
      { size: bytes.length, limit: imageByteLimit },
    );
    const size = imageSize(bytes, mediaType);
    requireCondition(
      !size || (size.width <= imagePixelLimit && size.height <= imagePixelLimit),
      'EVIDENCE_IMAGE_DIMENSIONS',
      `Imaginea are ${size?.width} × ${size?.height} pixeli; modelele de vedere primesc cel mult ${imagePixelLimit} pe latură: cereți o copie redimensionată.`,
      422,
      { width: size?.width, height: size?.height, limit: imagePixelLimit },
    );
    return {
      mediaType,
      width: size?.width ?? null,
      height: size?.height ?? null,
      bytes: bytes.length,
      base64: Buffer.from(bytes).toString('base64'),
    };
  }

  /**
   * A file's text layer, derived once per reader version and kept beside the evidence. The
   * caller has authorized the read; `record` is the company's evidence row.
   */
  async textLayer(companyId: string, record: EvidenceRecord): Promise<TextLayer> {
    // A cache that cannot be read is a miss: the layer is derived again.
    const kept = await this.objects
      .getDerivative(companyId, record.hash, textLayerKind)
      .catch(() => undefined);
    if (kept) {
      try {
        const parsed = textLayer.safeParse(JSON.parse(Buffer.from(kept).toString('utf8')));
        if (parsed.success) return parsed.data;
      } catch {
        // Derive it again below.
      }
    }
    const key = `${companyId}/${record.hash}`;
    let pending = this.deriving.get(key);
    if (!pending) {
      pending = this.derive(companyId, record).finally(() => this.deriving.delete(key));
      this.deriving.set(key, pending);
    }
    return pending;
  }

  private async derive(companyId: string, record: EvidenceRecord): Promise<TextLayer> {
    const bytes = await this.objects.get(companyId, record.hash);
    const format = sniffFormat(bytes, record.mediaType, record.filename);
    const { layer, settled } =
      format === 'pdf' ? pdfLayer(await extractPdfText(bytes)) : fileLayer(bytes, format);
    // Kept only when the same bytes always give it; a cache failure never fails the read.
    if (settled)
      await this.objects
        .putDerivative(companyId, record.hash, textLayerKind, Buffer.from(JSON.stringify(layer)))
        .catch(() => {});
    return layer;
  }
}

const unread = (format: EvidenceFormat, failure: TextLayer['failure'] = null): TextLayer => ({
  format,
  encoding: null,
  extractor: null,
  pageCount: format === 'image' ? 1 : null,
  pages: [],
  failure,
});

function pdfLayer(result: PdfText): { layer: TextLayer; settled: boolean } {
  return {
    settled: pdfTextSettled(result),
    layer: result.ok
      ? {
          format: 'pdf',
          encoding: null,
          extractor: pdfTextExtractor,
          pageCount: result.pages.length,
          pages: result.pages,
          failure: null,
        }
      : {
          ...unread('pdf', { reason: result.reason, limit: result.limit ?? null }),
          pageCount: result.pageCount ?? null,
        },
  };
}

function fileLayer(
  bytes: Uint8Array,
  format: EvidenceFormat,
): { layer: TextLayer; settled: boolean } {
  if (format === 'image' || format === 'binary') return { layer: unread(format), settled: true };
  if (bytes.length > textFileLimit)
    return { layer: unread(format, { reason: 'too_large', limit: 'input' }), settled: true };
  const decoded = decodeText(bytes);
  if (!decoded) return { layer: unread('binary'), settled: true };
  return {
    settled: true,
    layer: {
      format,
      encoding: decoded.encoding,
      extractor: textFileExtractor,
      pageCount: 1,
      pages: [textFileLines(decoded.text, format)],
      failure: null,
    },
  };
}

const limitNotes: Record<string, string> = {
  input: `it is larger than ${pdfTextLimits.inputBytes / 1024 / 1024} MiB`,
  pages: `it has more than ${pdfTextLimits.pages} pages`,
  text: `it holds more than ${pdfTextLimits.textBytes / 1024 / 1024} MiB of text`,
  memory: 'reading it needs more memory than allowed',
};

/** What a file is and how an agent reads it, without its lines. */
function describeLayer(record: EvidenceRecord, layer: TextLayer): EvidenceReading {
  const pagesWithoutText =
    layer.format === 'image'
      ? [1]
      : layer.format === 'pdf'
        ? layer.pages.flatMap((lines, index) => (lines.length ? [] : [index + 1]))
        : [];
  const textLayer =
    layer.failure === null &&
    (layer.format === 'pdf'
      ? layer.pages.some((lines) => lines.length > 0)
      : layer.extractor !== null);
  const reading = textLayer
    ? 'text'
    : layer.failure === null && (layer.format === 'pdf' || layer.format === 'image')
      ? 'vision'
      : 'unreadable';
  return {
    id: record.id,
    hash: record.hash,
    filename: record.filename,
    mediaType: record.mediaType,
    size: record.size,
    format: layer.format,
    encoding: layer.encoding,
    pageCount: layer.pageCount,
    textLayer,
    pagesWithoutText,
    reading,
    failure: layer.failure,
    extractor: textLayer ? layer.extractor : null,
    note: noteOn(layer, reading, pagesWithoutText),
  };
}

function noteOn(layer: TextLayer, reading: string, pagesWithoutText: number[]): string | null {
  const vision = (what: string) =>
    `read ${what} with your own vision model, from a copy the person shares; the engine does no OCR.`;
  if (reading === 'text')
    return pagesWithoutText.length
      ? `Pages ${pagesWithoutText.join(', ')} have no text layer (scanned): ${vision('them')}`
      : null;
  if (reading === 'vision')
    return layer.format === 'image'
      ? `An image has no text layer: read it with mode "image" (JPEG, PNG, GIF or WebP, base64 up to 5 MiB) and your own vision model; the engine does no OCR.`
      : `This PDF has no text layer (a scan): ${vision('its pages')}`;
  switch (layer.failure?.reason) {
    case 'encrypted':
      return 'The PDF is password-protected: ask the person for an unprotected copy.';
    case 'corrupt':
      return 'The PDF cannot be parsed: ask the person for another copy.';
    case 'too_large':
      return `The file cannot be read here, as ${limitNotes[layer.failure.limit ?? 'input']}: ask the person for the pages that matter.`;
    case 'timeout':
      return `Reading the PDF took longer than ${pdfTextLimits.timeoutMs / 1000} s: try again later, or ask the person for a smaller copy.`;
    case 'failed':
      return 'The reader failed: try again later.';
    default:
      return 'The file is neither text, a PDF nor an image: it cannot be read here.';
  }
}

type ReadLine = { line: number; text: string; part?: number; parts?: number };

/** A page's lines as sent: lines longer than `longLine` characters in numbered parts. */
function segmentsOf(lines: string[]): ReadLine[] {
  return lines.flatMap((text, index) => {
    const characters = [...text];
    if (characters.length <= longLine) return [{ line: index + 1, text }];
    const parts = Math.ceil(characters.length / longLine);
    return Array.from({ length: parts }, (_, part) => ({
      line: index + 1,
      text: characters.slice(part * longLine, (part + 1) * longLine).join(''),
      part: part + 1,
      parts,
    }));
  });
}

const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/**
 * The lines from the page or cursor on, as many as fit: the result's JSON never exceeds
 * `maxBytes`. The cursor is `<page>:<part index on that page>`.
 */
function paginate(
  base: EvidenceReading,
  pages: string[][],
  input: z.infer<typeof evidenceReadInput>,
): EvidenceReading {
  const [cursorPage, cursorIndex] = input.cursor?.split(':').map(Number) ?? [];
  const first = input.page ?? cursorPage ?? 1;
  const last = input.page ?? pages.length;
  requireCondition(
    first >= 1 &&
      first <= Math.max(pages.length, 1) &&
      (cursorPage === undefined || cursorPage === first),
    'EVIDENCE_CURSOR',
    'Cursorul nu aparține acestei citiri.',
  );
  // The envelope with the longest cursor, so that the real one always fits.
  let size = bytesOf({ ...base, pages: [], next: '999999:9999999' });
  const read: NonNullable<EvidenceReading['pages']> = [];
  let next: string | null = null;
  pages: for (let page = first; page <= last; page++) {
    const segments = segmentsOf(pages[page - 1] ?? []);
    let index = page === first ? (cursorIndex ?? 0) : 0;
    requireCondition(
      index <= segments.length,
      'EVIDENCE_CURSOR',
      'Cursorul nu aparține acestei citiri.',
    );
    const entry = { page, lineCount: pages[page - 1]?.length ?? 0, lines: [] as ReadLine[] };
    const entrySize = bytesOf(entry) + (read.length ? 1 : 0);
    if (size + entrySize > input.maxBytes) {
      next = `${page}:${index}`;
      break;
    }
    size += entrySize;
    read.push(entry);
    for (; index < segments.length; index++) {
      const lineSize = bytesOf(segments[index]) + (entry.lines.length ? 1 : 0);
      if (size + lineSize > input.maxBytes) {
        next = `${page}:${index}`;
        // A page without a line read waits for the next call.
        if (!entry.lines.length) read.pop();
        break pages;
      }
      size += lineSize;
      entry.lines.push(segments[index]!);
    }
  }
  requireCondition(
    read.length > 0 || next === null,
    'EVIDENCE_READ_LIMIT',
    'Limita de citire este prea mică pentru acest document.',
  );
  return { ...base, pages: read, next };
}
