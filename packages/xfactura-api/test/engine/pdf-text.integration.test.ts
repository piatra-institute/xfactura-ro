import { describe, expect, test } from 'bun:test';
import { once } from 'node:events';
import { createDeflate } from 'node:zlib';
import {
  extractPdfText,
  pdfLines,
  pdfTextLimits,
  type PdfTextRun,
} from '../../source/engine/adapters/pdf-text';
import { pdfDocument, show } from './fixtures/pdf';

const invoice = pdfDocument([
  {
    content: [
      show(72, 780, 'Factură fiscală nr. 7', 14),
      show(72, 750, 'Furnizor: Ștefan Țăran SRL'),
      show(380, 750, 'Total: 1.190,00 lei'),
      // Drawn twice at the same place, as simulated bold is.
      show(72, 730, 'Cumpărător: Pilot SRL'),
      show(72.2, 730, 'Cumpărător: Pilot SRL'),
      show(72, 710, 'Plata în'),
      show(113, 710, 'ziua încasării'),
    ].join('\n'),
  },
  { content: show(72, 780, 'Pagina 2: condiții'), flate: true },
]);

/** `mib` MiB of spaces, Flate-compressed without holding them in memory. */
async function deflatedSpaces(mib: number) {
  const deflate = createDeflate({ level: 9 });
  const chunks: Buffer[] = [];
  deflate.on('data', (chunk: Buffer) => chunks.push(chunk));
  const ended = once(deflate, 'end');
  const block = Buffer.alloc(1024 * 1024, 0x20);
  for (let index = 0; index < mib; index++) if (!deflate.write(block)) await once(deflate, 'drain');
  deflate.end();
  await ended;
  return new Uint8Array(Buffer.concat(chunks));
}

describe('PDF text', () => {
  test('rebuilds lines by position, page by page, with Romanian letters', async () => {
    expect(await extractPdfText(invoice)).toEqual({
      ok: true,
      pages: [
        [
          'Factură fiscală nr. 7',
          'Furnizor: Ștefan Țăran SRL\tTotal: 1.190,00 lei',
          'Cumpărător: Pilot SRL',
          'Plata în ziua încasării',
        ],
        ['Pagina 2: condiții'],
      ],
    });
  });

  test('the same PDF always gives the same lines', async () => {
    const [first, second] = await Promise.all([extractPdfText(invoice), extractPdfText(invoice)]);
    expect(second).toEqual(first);
  });

  test("a rotated page reads in the page's reading direction", async () => {
    const rotated = pdfDocument([
      {
        content: [show(72, 760, 'Linia unu'), show(300, 760, 'dreapta'), show(72, 740, 'Linia doi')]
          .reverse()
          .join('\n'),
        rotate: 90,
      },
    ]);
    expect(await extractPdfText(rotated)).toEqual({
      ok: true,
      pages: [['Linia unu\tdreapta', 'Linia doi']],
    });
  });

  test('a scanned page has no lines', async () => {
    const scan = pdfDocument([
      { content: '0 0 1 rg 10 10 100 100 re f' },
      { content: show(72, 700, 'Anexă') },
    ]);
    expect(await extractPdfText(scan)).toEqual({ ok: true, pages: [[], ['Anexă']] });
  });
});

describe('PDF line algorithm', () => {
  const run = (str: string, x: number, y: number, size = 10, width = str.length * size * 0.5) => ({
    str,
    transform: [size, 0, 0, size, x, y],
    width,
    height: size,
  });
  const page = [1, 0, 0, -1, 0, 842];

  test('lines depend on positions only, not on the order runs come in', () => {
    const runs: PdfTextRun[] = [
      run('Data', 72, 700),
      run('01.10.2026', 200, 700),
      run('Plată', 72, 688),
      run('furnizor', 101, 688),
      run('1.234,56', 400, 688.5),
      run('Sold', 72, 676),
      run(' ', 90, 676),
    ];
    const expected = ['Data\t01.10.2026', 'Plată furnizor\t1.234,56', 'Sold'];
    expect(pdfLines(runs, page)).toEqual(expected);
    for (let seed = 1; seed <= 20; seed++) {
      const shuffled = [...runs].sort(
        (a, b) =>
          ((a.str.length * seed) % 7) - ((b.str.length * seed) % 7) ||
          a.transform[4]! - b.transform[4]!,
      );
      expect(pdfLines(shuffled, page)).toEqual(expected);
    }
  });

  test('vertical runs read as their own lines; controls become spaces', () => {
    const vertical = {
      str: 'Generat automat',
      transform: [0, 10, -10, 0, 30, 400],
      width: 75,
      height: 10,
    };
    const skewed = { str: 'Ștampilă', transform: [7, 7, -7, 7, 300, 300], width: 40, height: 10 };
    expect(pdfLines([run('Total\u0000de plată', 72, 700), vertical, skewed], page)).toEqual([
      'Total de plată',
      'Generat automat',
      'Ștampilă',
    ]);
  });
});

describe('hostile PDFs', () => {
  test('a corrupt file is corrupt', async () => {
    expect(await extractPdfText(new TextEncoder().encode('%PDF-1.7\n1 0 obj << /Type'))).toEqual({
      ok: false,
      reason: 'corrupt',
    });
  });

  test('a PDF with a user password is encrypted', async () => {
    const locked = pdfDocument([{ content: show(72, 700, 'Secret') }], { encrypted: true });
    expect(await extractPdfText(locked)).toEqual({ ok: false, reason: 'encrypted' });
  });

  test('more pages than the limit are refused before any is read', async () => {
    expect(pdfTextLimits.pages).toBe(200);
    const many = pdfDocument(
      Array.from({ length: 201 }, (_, index) => ({
        content: show(72, 700, `Pagina ${index + 1}`),
      })),
    );
    expect(await extractPdfText(many)).toEqual({
      ok: false,
      reason: 'too_large',
      limit: 'pages',
      pageCount: 201,
    });
    // A page tree claiming a million pages it does not hold reads as what it holds.
    const lying = pdfDocument([{ content: show(72, 700, 'Una') }], { count: 1_000_000 });
    expect(await extractPdfText(lying)).toEqual({ ok: true, pages: [['Una']] });
  });

  test('more text than the limit is refused', async () => {
    const wordy = pdfDocument(
      Array.from({ length: 3 }, () => ({
        content: Array.from({ length: 40 }, (_, line) =>
          show(40, 800 - line * 12, `Rândul ${line} ${'x'.repeat(60)}`, 8),
        ).join('\n'),
      })),
    );
    expect(await extractPdfText(wordy, { limits: { textBytes: 4096 } })).toEqual({
      ok: false,
      reason: 'too_large',
      limit: 'text',
      pageCount: 3,
    });
  });

  test('a larger input is refused unread', async () => {
    expect(pdfTextLimits.inputBytes).toBe(20 * 1024 * 1024);
    expect(await extractPdfText(invoice, { limits: { inputBytes: invoice.length - 1 } })).toEqual({
      ok: false,
      reason: 'too_large',
      limit: 'input',
    });
  });

  test('a decompression bomb is killed at the memory limit', async () => {
    // 512 MiB of spaces in half a MiB: pdf.js inflates a content stream whole.
    const bomb = pdfDocument([{ content: await deflatedSpaces(512), flate: 'deflated' }]);
    expect(bomb.length).toBeLessThan(1024 * 1024);
    expect(await extractPdfText(bomb)).toEqual({ ok: false, reason: 'too_large', limit: 'memory' });
  });

  test('deeply nested objects end in a result, never a crash', async () => {
    const depth = 100_000;
    const nestedArray = pdfDocument([{ content: show(72, 700, 'x') }], {
      pageExtra: `/Deep ${'['.repeat(depth)}${']'.repeat(depth)}`,
    });
    const nestedDictionary = pdfDocument([{ content: show(72, 700, 'x') }], {
      pageExtra: `/Deep ${'<< /A '.repeat(depth)}1${' >>'.repeat(depth)}`,
    });
    const nestedContent = pdfDocument([
      { content: `${'['.repeat(depth)}${']'.repeat(depth)} pop\n${show(72, 700, 'x')}` },
    ]);
    expect(await extractPdfText(nestedArray)).toEqual({ ok: false, reason: 'corrupt' });
    expect(await extractPdfText(nestedDictionary)).toEqual({ ok: false, reason: 'corrupt' });
    const content = await extractPdfText(nestedContent);
    expect(content.ok || content.reason === 'corrupt').toBe(true);
  });

  test('the reader is killed when it runs out of time', async () => {
    expect(pdfTextLimits.timeoutMs).toBe(10_000);
    let pid = 0;
    const result = await extractPdfText(invoice, {
      limits: { timeoutMs: 1 },
      onSpawn: (spawned) => (pid = spawned),
    });
    expect(result).toEqual({ ok: false, reason: 'timeout' });
    expect(pid).toBeGreaterThan(0);
    // The process is gone, not left running.
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
