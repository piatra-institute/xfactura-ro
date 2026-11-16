import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * What one attachment reading of a PDF may take. A PDF past any of them fails with a typed
 * reason; none is read partially, so an inventory is always the whole document's.
 */
export interface PdfAttachmentsLimits {
  inputBytes: number;
  pages: number;
  /** From spawning the reader to its answer; the reader is killed past it. */
  timeoutMs: number;
  /** Maximum number of attachments returned across the document and its pages. */
  attachments: number;
  /** Maximum total raw bytes across all attachments. */
  attachmentBytes: number;
  /** The reader process's resident memory; its watchdog kills it past it (decompression bombs). */
  memoryBytes: number;
}

export const pdfAttachmentsLimits: Readonly<PdfAttachmentsLimits> = {
  inputBytes: 64 * 1024 * 1024,
  pages: 200,
  timeoutMs: 10_000,
  attachments: 100,
  attachmentBytes: 24 * 1024 * 1024,
  memoryBytes: 512 * 1024 * 1024,
};

export const pdfAttachmentLocation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('document') }),
  z.object({ kind: z.literal('page'), page: z.number().int().positive() }),
]);
export type PdfAttachmentLocation = z.infer<typeof pdfAttachmentLocation>;

export const pdfAttachmentsWireResult = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    attachments: z.array(
      z.object({
        name: z.string(),
        base64: z.string(),
        location: pdfAttachmentLocation,
      }),
    ),
  }),
  z.object({
    ok: z.literal(false),
    /** `failed`: the reader itself failed (it could not start, or crashed), not the PDF. */
    reason: z.enum(['encrypted', 'corrupt', 'ambiguous', 'too_large', 'timeout', 'failed']),
    limit: z.enum(['input', 'pages', 'attachments', 'attachmentBytes', 'memory']).optional(),
    pageCount: z.number().int().nonnegative().optional(),
  }),
]);
export type PdfAttachmentsWireResult = z.infer<typeof pdfAttachmentsWireResult>;

export interface PdfAttachment {
  name: string;
  bytes: Uint8Array;
  location: PdfAttachmentLocation;
}

export type PdfAttachments =
  { ok: true; attachments: PdfAttachment[] } | Extract<PdfAttachmentsWireResult, { ok: false }>;

// From source the reader sits next to this file; in the `build` bundle (whose entry is
// build/index.js) it is emitted as build/engine/adapters/pdf-text.worker.js.
const worker = [
  new URL('./pdf-text.worker.ts', import.meta.url),
  new URL('./engine/adapters/pdf-text.worker.js', import.meta.url),
]
  .map((url) => fileURLToPath(url))
  .find((path) => existsSync(path))!;

/** At most this many attachment readers run at once; the others wait their turn. */
const parallel = 4;
let running = 0;
const waiting: (() => void)[] = [];
async function turn<T>(work: () => Promise<T>) {
  // A finishing reader hands its turn to the first waiting one, so none starts in between.
  if (running < parallel) running++;
  else await new Promise<void>((resolve) => waiting.push(resolve));
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}

/**
 * Files attached to a PDF (the document's embedded files and file attachment annotations on
 * pages), read in a separate Bun process by both pdf.js and pdf-lib:
 * - the PDF arrives on stdin and one JSON result leaves on stdout; the process gets no
 *   environment (no secrets), loads no `.env`, installs nothing, and may load no native addon;
 * - pdf.js runs without eval or WebAssembly, font loading, a worker thread, or a URL to fetch;
 *   `fetch` and WebSocket are removed;
 * - both readers must agree on the multiset of `(name, sha256)` pairs, or the result is
 *   `ambiguous`;
 * - the limits hold: a larger input is refused unread, the reader stops past pages, attachment
 *   count or attachment bytes, its watchdog kills it past memory, and it is killed past time.
 * Never throws: every outcome is a result, encrypted, corrupt, ambiguous, too large or timed out
 * included.
 */
export async function pdfAttachments(
  bytes: Uint8Array,
  options: {
    limits?: Partial<PdfAttachmentsLimits>;
    /** Called with the reader's process id once it runs (tests watch it die). */
    onSpawn?: (pid: number) => void;
  } = {},
): Promise<PdfAttachments> {
  const limits = { ...pdfAttachmentsLimits, ...options.limits };
  if (bytes.length > limits.inputBytes) return { ok: false, reason: 'too_large', limit: 'input' };
  return turn(() => read(bytes, limits, options.onSpawn));
}

async function read(
  bytes: Uint8Array,
  limits: PdfAttachmentsLimits,
  onSpawn?: (pid: number) => void,
): Promise<PdfAttachments> {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(bytes, limits);
  } catch {
    return { ok: false, reason: 'failed' };
  }
  onSpawn?.(child.pid);
  let timedOut = false;
  let overflow = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, limits.timeoutMs);
  const chunks: Uint8Array[] = [];
  try {
    // Base64 expands attachment bytes by 4/3, plus names, locations and JSON punctuation.
    const cap = Math.ceil((limits.attachmentBytes * 4) / 3) + limits.attachments * 1024 + 64 * 1024;
    let size = 0;
    for await (const chunk of child.stdout) {
      size += chunk.length;
      if (size > cap) {
        overflow = true;
        child.kill('SIGKILL');
        break;
      }
      chunks.push(chunk);
    }
    await child.exited;
  } catch {
    child.kill('SIGKILL');
    return { ok: false, reason: 'failed' };
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) return { ok: false, reason: 'timeout' };
  if (overflow) return { ok: false, reason: 'too_large', limit: 'attachmentBytes' };
  // Only the watchdog (or the system's out-of-memory killer) kills the reader otherwise.
  if (child.signalCode === 'SIGKILL') return { ok: false, reason: 'too_large', limit: 'memory' };
  if (child.exitCode !== 0) return { ok: false, reason: 'failed' };
  try {
    const parsed = pdfAttachmentsWireResult.safeParse(
      JSON.parse(Buffer.concat(chunks).toString('utf8')),
    );
    if (!parsed.success) return { ok: false, reason: 'failed' };
    if (!parsed.data.ok) return parsed.data;
    return {
      ok: true,
      attachments: parsed.data.attachments.map((item) => ({
        name: item.name,
        bytes: new Uint8Array(Buffer.from(item.base64, 'base64')),
        location: item.location,
      })),
    };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

function spawn(bytes: Uint8Array, limits: PdfAttachmentsLimits) {
  return Bun.spawn(
    [
      process.execPath,
      '--smol',
      '--no-env-file',
      '--no-install',
      worker,
      JSON.stringify({
        mode: 'attachments',
        pages: limits.pages,
        attachments: limits.attachments,
        attachmentBytes: limits.attachmentBytes,
        memoryBytes: limits.memoryBytes,
      }),
    ],
    {
      cwd: dirname(worker),
      env: {},
      stdin: bytes,
      stdout: 'pipe',
      stderr: 'ignore',
    },
  );
}

/** Whether a PDF carries a signature dictionary. Presence only: the signature itself is
 * verified by ANAF when the document is filed. */
export function pdfHasSignature(bytes: Uint8Array) {
  const text = Buffer.from(bytes).toString('latin1');
  return /\/Type\s*\/Sig\b/.test(text) && /\/ByteRange\s*\[/.test(text);
}
