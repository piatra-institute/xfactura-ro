/**
 * The PDF reader's process, spawned by `extractPdfText` (`pdf-text.ts`); never imported. The PDF
 * arrives on stdin; one JSON `PdfText` leaves on stdout, and the process exits. The limits come
 * as JSON in the first argument.
 */
import { pdfLines, pdfTextLimits, type PdfText, type PdfTextRun } from './pdf-text';

const limits: Pick<typeof pdfTextLimits, 'pages' | 'textBytes' | 'memoryBytes'> = {
  ...pdfTextLimits,
  ...(JSON.parse(process.argv[2] ?? '{}') as object),
};

// Nothing but the result may reach stdout: pdf.js reports warnings through the console.
for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const)
  console[method] = () => {};

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
  if (process.memoryUsage.rss() > ${Number(limits.memoryBytes)}) process.kill(process.pid, 'SIGKILL');
}, 10);`;
new Worker(URL.createObjectURL(new Blob([watchdog], { type: 'application/javascript' })));

async function finish(result: PdfText): Promise<never> {
  await Bun.write(Bun.stdout, JSON.stringify(result));
  process.exit(0);
}

const input = new Uint8Array(await Bun.stdin.bytes());
// pdf.js's own worker runs on this thread ("fake worker"), so no thread parses beside it.
Object.assign(globalThis, {
  pdfjsWorker: await import(import.meta.resolve('pdfjs-dist/build/pdf.worker.mjs')),
});
const pdfjs = await import('pdfjs-dist');

let document: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>;
try {
  document = await pdfjs.getDocument({
    data: input,
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
    verbosity: 0,
  }).promise;
} catch (error) {
  await finish({
    ok: false,
    reason: (error as Error)?.name === 'PasswordException' ? 'encrypted' : 'corrupt',
  });
}
const pageCount = document!.numPages;
if (pageCount > limits.pages)
  await finish({ ok: false, reason: 'too_large', limit: 'pages', pageCount });

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
  if (size > limits.textBytes)
    await finish({ ok: false, reason: 'too_large', limit: 'text', pageCount });
  pages.push(lines!);
}
await finish({ ok: true, pages });
