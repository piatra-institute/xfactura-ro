import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import pdfjsPackage from 'pdfjs-dist/package.json';

/**
 * What one reading of a PDF may take. A PDF past any of them fails with a typed reason; none is
 * read partially, so a text layer is always the whole document's.
 */
export interface PdfTextLimits {
  inputBytes: number;
  pages: number;
  /** From spawning the reader to its answer; the reader is killed past it. */
  timeoutMs: number;
  /** The UTF-8 bytes of every line of every page. */
  textBytes: number;
  /** The reader process's resident memory; its watchdog kills it past it (decompression bombs). */
  memoryBytes: number;
}

export const pdfTextLimits: Readonly<PdfTextLimits> = {
  inputBytes: 20 * 1024 * 1024,
  pages: 200,
  timeoutMs: 10_000,
  textBytes: 2 * 1024 * 1024,
  memoryBytes: 512 * 1024 * 1024,
};

/**
 * The text layer's version: the line algorithm's and pdf.js's. Line numbers, and the citations
 * that point to them, hold for one version; cached text is kept under it.
 */
export const pdfTextExtractor = `pdf-text.1.pdfjs-${pdfjsPackage.version}`;

export const pdfTextResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), pages: z.array(z.array(z.string())) }),
  z.object({
    ok: z.literal(false),
    /** `failed`: the reader itself failed (it could not start, or crashed), not the PDF. */
    reason: z.enum(['encrypted', 'corrupt', 'too_large', 'timeout', 'failed']),
    limit: z.enum(['input', 'pages', 'text', 'memory']).optional(),
    pageCount: z.number().int().nonnegative().optional(),
  }),
]);
export type PdfText = z.infer<typeof pdfTextResult>;

/** Whether the same bytes always give this result, so that it may be kept. */
export const pdfTextSettled = (result: PdfText) =>
  result.ok || result.reason === 'encrypted' || result.reason === 'corrupt';

/** A text run as pdf.js reports it: its string, its text-to-user-space transform, its advance. */
export interface PdfTextRun {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

type Matrix = [number, number, number, number, number, number];
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const finite = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;
const matrix = (values: number[]) =>
  [0, 1, 2, 3, 4, 5].map((index) => finite(values[index])) as Matrix;

/** The four reading directions, in device space (y grows downwards): right, down, left, up. */
const directions: readonly [number, number][] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];
/** A run within about 10° of a reading direction reads in it; any other run is a line alone. */
const aligned = Math.cos((10 * Math.PI) / 180);
/** Runs whose baselines differ by at most this share of the smaller font size share a line. */
const sameLine = 0.5;
/** A gap of at least this share of the font size separates words (as pdf.js decides), and of at
 * least the second share, columns. */
const wordGap = 0.1;
const columnGap = 1.5;

type Run = { text: string; x: number; y: number; end: number; size: number; index: number };

const byPosition = (a: Run, b: Run) => a.y - b.y || a.x - b.x || a.index - b.index;

/**
 * Rebuilds a page's lines from pdf.js's text runs by their positions alone, so that the same PDF
 * always gives the same lines:
 * 1. each run is placed in device space through the page's viewport (its rotation and crop);
 * 2. runs read in one of four directions; within a direction, a run joins the line above it when
 *    their baselines are closer than half the smaller font size, and lines go top to bottom;
 * 3. within a line, runs go by position along the line: a gap of a tenth of the font size is a
 *    space, one of one and a half font sizes a tab (a column), an overlap of the same text at the
 *    same place (simulated bold) is dropped;
 * 4. runs in no reading direction are lines of their own, after the others.
 * Whitespace-only runs are dropped (gaps decide spacing), control characters become spaces, and
 * empty lines are left out.
 */
export function pdfLines(runs: readonly PdfTextRun[], viewport: number[]): string[] {
  const view = matrix(viewport);
  const groups: Run[][] = directions.map(() => []);
  const skewed: Run[] = [];
  runs.forEach((run, index) => {
    const text = String(run.str ?? '')
      .toWellFormed()
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
    if (!text.trim()) return;
    const device = multiply(view, matrix(run.transform));
    const length = Math.hypot(device[0], device[1]);
    const size = Math.hypot(device[2], device[3]) || Math.max(finite(run.height), 1);
    const width = Math.max(finite(run.width), 0);
    const direction = directions.findIndex(
      ([dx, dy]) => length > 0 && (device[0] * dx + device[1] * dy) / length >= aligned,
    );
    if (direction < 0) {
      skewed.push({ text, x: device[4], y: device[5], end: device[4], size, index });
      return;
    }
    // Coordinates along the reading direction (x) and across it, downwards (y).
    const [dx, dy] = directions[direction]!;
    const x = device[4] * dx + device[5] * dy;
    const y = -device[4] * dy + device[5] * dx;
    groups[direction]!.push({ text, x, y, end: x + width, size, index });
  });

  const lines: string[] = [];
  for (const group of groups) {
    const rows: Run[][] = [];
    for (const run of group.sort(byPosition)) {
      const row = rows.at(-1);
      const anchor = row?.[0];
      if (row && anchor && run.y - anchor.y <= sameLine * Math.min(run.size, anchor.size))
        row.push(run);
      else rows.push([run]);
    }
    for (const row of rows) lines.push(joinRow(row));
  }
  for (const run of skewed.sort(byPosition)) lines.push(run.text);
  return lines.map((line) => line.trim()).filter(Boolean);
}

function joinRow(row: Run[]) {
  const ordered = [...row].sort((a, b) => a.x - b.x || a.index - b.index);
  let text = '';
  let previous: Run | undefined;
  for (const run of ordered) {
    if (!previous) {
      text = run.text;
      previous = run;
      continue;
    }
    const size = Math.min(run.size, previous.size);
    if (
      run.text === previous.text &&
      Math.abs(run.x - previous.x) < 0.15 * size &&
      Math.abs(run.y - previous.y) < 0.15 * size
    )
      continue;
    const gap = run.x - previous.end;
    if (gap >= columnGap * size) text = `${text.trimEnd()}\t${run.text.trimStart()}`;
    else if (gap >= wordGap * size && !/\s$/.test(text) && !/^\s/.test(run.text))
      text = `${text} ${run.text}`;
    else text += run.text;
    previous = run.end > previous.end ? run : { ...run, end: previous.end };
  }
  return text;
}

// From source the reader sits next to this file; in the `build` bundle (whose entry is
// build/index.js) it is emitted as build/engine/adapters/pdf-text.worker.js.
const worker = [
  new URL('./pdf-text.worker.ts', import.meta.url),
  new URL('./engine/adapters/pdf-text.worker.js', import.meta.url),
]
  .map((url) => fileURLToPath(url))
  .find((path) => existsSync(path))!;

/** At most this many readers run at once; the others wait their turn. */
const parallel = 2;
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
 * A PDF's lines, page by page, read by pdf.js in a separate Bun process:
 * - the PDF arrives on stdin and one JSON result leaves on stdout; the process gets no
 *   environment (no secrets), loads no `.env`, installs nothing, and may load no native addon;
 * - pdf.js runs without eval or WebAssembly, font loading, a worker thread, or a URL to fetch
 *   (fonts, CMaps, wasm); `fetch` and WebSocket are removed;
 * - the limits hold: a larger input is refused unread, the reader stops past the pages or text,
 *   its watchdog kills it past the memory, and it is killed past the time.
 * Never throws: every outcome is a result, encrypted, corrupt, too large or timed out included.
 */
export async function extractPdfText(
  bytes: Uint8Array,
  options: {
    limits?: Partial<PdfTextLimits>;
    /** Called with the reader's process id once it runs (tests watch it die). */
    onSpawn?: (pid: number) => void;
  } = {},
): Promise<PdfText> {
  const limits = { ...pdfTextLimits, ...options.limits };
  if (bytes.length > limits.inputBytes) return { ok: false, reason: 'too_large', limit: 'input' };
  return turn(() => read(bytes, limits, options.onSpawn));
}

async function read(
  bytes: Uint8Array,
  limits: PdfTextLimits,
  onSpawn?: (pid: number) => void,
): Promise<PdfText> {
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
    // JSON at most doubles the text, plus quotes and commas per line: a generous backstop.
    const cap = 6 * limits.textBytes + 64 * 1024;
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
  if (overflow) return { ok: false, reason: 'too_large', limit: 'text' };
  // Only the watchdog (or the system's out-of-memory killer) kills the reader otherwise.
  if (child.signalCode === 'SIGKILL') return { ok: false, reason: 'too_large', limit: 'memory' };
  if (child.exitCode !== 0) return { ok: false, reason: 'failed' };
  try {
    const parsed = pdfTextResult.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    return parsed.success ? parsed.data : { ok: false, reason: 'failed' };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

function spawn(bytes: Uint8Array, limits: PdfTextLimits) {
  return Bun.spawn(
    [
      process.execPath,
      '--smol',
      '--no-env-file',
      '--no-install',
      worker,
      JSON.stringify({
        pages: limits.pages,
        textBytes: limits.textBytes,
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
