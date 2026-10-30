import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pdfTextExtractor } from '../../source/engine/adapters/pdf-text';
import type { EvidenceReading } from '../../source/engine/modules/evidence';
import { pdfDocument, show } from './fixtures/pdf';
import { scenario, type Scenario } from './scenario';

let s: Scenario;
beforeAll(async () => {
  s = await scenario();
});
afterAll(async () => {
  await s?.dispose();
});

const record = (filename: string, mediaType: string, bytes: Uint8Array | string) =>
  s.invoke<{ id: string; hash: string }>(s.owner, 'evidence.record', {
    filename,
    mediaType,
    base64: Buffer.from(bytes).toString('base64'),
  });
const read = (input: Record<string, unknown>, actor = s.owner) =>
  s.invoke<EvidenceReading>(actor, 'evidence.read', input);
const issue = (scopes: string[]) =>
  s.invoke<{ token: string; scopes: string[] }>(s.reviewer, 'agents.issue', {
    name: 'Cititor',
    scopes,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });

/** Windows-1250 for the letters the tests use; the rest is ASCII. */
const cp1250: Record<string, number> = {
  ă: 0xe3,
  â: 0xe2,
  î: 0xee,
  ş: 0xba,
  ţ: 0xfe,
  Ş: 0xaa,
  Ţ: 0xde,
};
const windows1250 = (text: string) =>
  new Uint8Array([...text].map((character) => cp1250[character] ?? character.charCodeAt(0)));

const statement = pdfDocument(
  Array.from({ length: 12 }, (_, page) => ({
    content: Array.from({ length: 30 }, (_, line) =>
      [
        show(40, 800 - line * 20, `${String(line + 1).padStart(2, '0')}.10.2026`, 9),
        show(120, 800 - line * 20, `Plată furnizor ${page + 1}/${line + 1} ${'ș'.repeat(100)}`, 9),
        show(480, 800 - line * 20, `${page + 1}${line},00`, 9),
      ].join('\n'),
    ).join('\n'),
  })),
);

describe('evidence.read on PDFs', () => {
  test('meta says what the file is; text gives numbered lines per page', async () => {
    const pdf = pdfDocument([
      {
        content: [show(72, 780, 'Factură nr. 7', 14), show(72, 750, 'Total: 1.190,00 lei')].join(
          '\n',
        ),
      },
      { content: show(72, 780, 'Pagina 2') },
    ]);
    // Declared as anything: the bytes decide.
    const { id, hash } = await record('factura.bin', 'application/octet-stream', pdf);
    const meta = await read({ id, mode: 'meta' });
    expect(meta).toEqual({
      id,
      hash,
      filename: 'factura.bin',
      mediaType: 'application/octet-stream',
      size: pdf.length,
      format: 'pdf',
      encoding: null,
      pageCount: 2,
      textLayer: true,
      pagesWithoutText: [],
      reading: 'text',
      failure: null,
      extractor: pdfTextExtractor,
      note: null,
    });
    const text = await read({ id, mode: 'text' });
    expect(text.pages).toEqual([
      {
        page: 1,
        lineCount: 2,
        lines: [
          { line: 1, text: 'Factură nr. 7' },
          { line: 2, text: 'Total: 1.190,00 lei' },
        ],
      },
      { page: 2, lineCount: 1, lines: [{ line: 1, text: 'Pagina 2' }] },
    ]);
    expect(text.next).toBeNull();
    expect((await read({ id, mode: 'text', page: 2 })).pages).toEqual([
      { page: 2, lineCount: 1, lines: [{ line: 1, text: 'Pagina 2' }] },
    ]);
    expect((await s.refused(read({ id, mode: 'text', page: 3 })))?.code).toBe('EVIDENCE_PAGE');
  });

  test('pages continue with a cursor and no result exceeds maxBytes', async () => {
    const { id } = await record('extras.pdf', 'application/pdf', statement);
    const whole = await read({ id, mode: 'text', maxBytes: 256 * 1024 });
    expect(whole.next).toBeNull();
    expect(whole.pages?.length).toBe(12);
    const all = whole.pages!.flatMap((page) =>
      page.lines.map((line) => [page.page, line.line, line.text]),
    );
    expect(all.length).toBe(360);

    const seen: unknown[] = [];
    let cursor: string | null | undefined;
    let calls = 0;
    do {
      const result = await read({
        id,
        mode: 'text',
        maxBytes: 8192,
        ...(cursor ? { cursor } : {}),
      });
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(8192);
      seen.push(
        ...result.pages!.flatMap((page) =>
          page.lines.map((line) => [page.page, line.line, line.text]),
        ),
      );
      cursor = result.next;
      calls++;
    } while (cursor && calls < 100);
    expect(calls).toBeGreaterThan(10);
    expect(seen).toEqual(all);

    // One page at a time, with its own cursor.
    const first = await read({ id, mode: 'text', page: 3, maxBytes: 8192 });
    expect(first.pages?.every((page) => page.page === 3)).toBe(true);
    const rest = await read({ id, mode: 'text', page: 3, cursor: first.next, maxBytes: 8192 });
    expect([...first.pages![0]!.lines, ...rest.pages![0]!.lines].map((line) => line.line)).toEqual(
      Array.from({ length: 30 }, (_, index) => index + 1),
    );
    expect(rest.next).toBeNull();
    expect(
      (await s.refused(read({ id, mode: 'text', page: 4, cursor: first.next, maxBytes: 8192 })))
        ?.code,
    ).toBe('EVIDENCE_CURSOR');
    for (const maxBytes of [8191, 256 * 1024 + 1])
      expect((await s.refused(read({ id, mode: 'text', maxBytes })))?.code).toBe('VALIDATION');
  });

  test('the text layer is kept beside the evidence, never as evidence', async () => {
    const pdf = pdfDocument([{ content: show(72, 700, 'Chitanță 15') }]);
    const { id, hash } = await record('chitanta.pdf', 'application/pdf', pdf);
    const first = await read({ id, mode: 'text' });
    const directory = join(s.directory, 'objects', s.company.id);
    const kinds = await readdir(join(directory, 'derivatives', hash));
    expect(kinds.length).toBe(1);
    const kept = await readFile(join(directory, 'derivatives', hash, kinds[0]!));
    expect(JSON.parse(kept.subarray(0, kept.indexOf(0x0a)).toString())).toMatchObject({
      format: 'xfactura-derivative-v1',
      evidence: hash,
      kind: kinds[0],
    });
    // Evidence paths take only hashes: a derived file is never read as evidence.
    expect((await s.refused(s.objects.get(s.company.id, 'derivatives')))?.code).toBe('OBJECT_KEY');
    expect(Buffer.from(await s.objects.get(s.company.id, hash)).equals(Buffer.from(pdf))).toBe(
      true,
    );

    // Kept text is read without the original: here, the original is made unreadable.
    const original = join(directory, hash);
    const bytes = await readFile(original);
    await writeFile(original, 'altered');
    try {
      expect(await read({ id, mode: 'text' })).toEqual(first);
    } finally {
      await writeFile(original, bytes);
    }
    // A kept file that fails its check is derived again.
    await writeFile(
      join(directory, 'derivatives', hash, kinds[0]!),
      Buffer.concat([kept.subarray(0, kept.indexOf(0x0a) + 1), Buffer.from('{"forged":true}')]),
    );
    expect(await read({ id, mode: 'text' })).toEqual(first);
    expect(await readFile(join(directory, 'derivatives', hash, kinds[0]!))).toEqual(kept);
  });

  test('scans, mixed files and encrypted PDFs say how to read them', async () => {
    const scan = await record(
      'scan.pdf',
      'application/pdf',
      pdfDocument([{ content: '0 g 0 0 595 842 re f' }]),
    );
    expect(await read({ id: scan.id, mode: 'text' })).toMatchObject({
      format: 'pdf',
      pageCount: 1,
      textLayer: false,
      pagesWithoutText: [1],
      reading: 'vision',
      extractor: null,
      pages: [],
      next: null,
    });
    expect((await read({ id: scan.id, mode: 'meta' })).note).toContain('vision model');

    const mixed = await record(
      'anexe.pdf',
      'application/pdf',
      pdfDocument([{ content: show(72, 700, 'Contract') }, { content: '0 g 0 0 9 9 re f' }]),
    );
    const meta = await read({ id: mixed.id, mode: 'meta' });
    expect(meta).toMatchObject({ reading: 'text', pagesWithoutText: [2], textLayer: true });
    expect(meta.note).toContain('Pages 2 have no text layer');

    const locked = await record(
      'parola.pdf',
      'application/pdf',
      pdfDocument([{ content: show(72, 700, 'Secret') }], { encrypted: true }),
    );
    expect(await read({ id: locked.id, mode: 'text' })).toMatchObject({
      reading: 'unreadable',
      failure: { reason: 'encrypted', limit: null },
      pages: [],
      next: null,
    });
  });
});

describe('evidence.read on other files', () => {
  test('a Windows-1250 bank CSV is decoded, with its own line numbers', async () => {
    const csv = windows1250(
      'Data;Detalii;Sumă\r\n01.10.2026;Plată Ştefan Ţăranu, dobândă;-1.234,56\r\n\r\n02.10.2026;Încasare;500,00\r\n',
    );
    const { id } = await record('extras.csv', 'text/csv', csv);
    expect(await read({ id, mode: 'text' })).toMatchObject({
      format: 'csv',
      encoding: 'windows-1250',
      pageCount: 1,
      reading: 'text',
      extractor: 'text-file.1',
      pages: [
        {
          page: 1,
          lineCount: 4,
          lines: [
            { line: 1, text: 'Data;Detalii;Sumă' },
            { line: 2, text: '01.10.2026;Plată Ştefan Ţăranu, dobândă;-1.234,56' },
            { line: 3, text: '' },
            { line: 4, text: '02.10.2026;Încasare;500,00' },
          ],
        },
      ],
      next: null,
    });
    const utf8 = await record('extras-utf8.csv', 'text/plain', `﻿Data;Sumă\nazi;ș ț\n`);
    expect(await read({ id: utf8.id, mode: 'text' })).toMatchObject({
      format: 'csv',
      encoding: 'utf-8',
      pages: [{ lines: [{ text: 'Data;Sumă' }, { text: 'azi;ș ț' }] }],
    });
  });

  test('XML on one line is broken between tags; long lines come in parts', async () => {
    const items = Array.from({ length: 40 }, (_, index) => `<cbc:Note>Rândul ${index}</cbc:Note>`);
    const xml = `<?xml version="1.0" encoding="UTF-8"?><Invoice>${items.join('')}</Invoice>`;
    const invoice = await record('factura.xml', 'application/xml', xml);
    const text = await read({ id: invoice.id, mode: 'text' });
    expect(text.format).toBe('xml');
    expect(text.pages![0]!.lines.slice(0, 3)).toEqual([
      { line: 1, text: '<?xml version="1.0" encoding="UTF-8"?>' },
      { line: 2, text: '<Invoice>' },
      { line: 3, text: '<cbc:Note>Rândul 0</cbc:Note>' },
    ]);

    const long = await record('note.txt', 'text/plain', `scurt\n${'ă'.repeat(2500)}\nfinal`);
    const lines = (await read({ id: long.id, mode: 'text' })).pages![0]!.lines;
    expect(lines.map(({ line, part, parts }) => [line, part, parts])).toEqual([
      [1, undefined, undefined],
      [2, 1, 3],
      [2, 2, 3],
      [2, 3, 3],
      [3, undefined, undefined],
    ]);
    expect(
      lines
        .filter((line) => line.line === 2)
        .map((line) => line.text)
        .join(''),
    ).toBe('ă'.repeat(2500));
  });

  test('an image has no text layer: the agent’s own vision model reads it', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    const { id } = await record('bon.png', 'image/png', png);
    const meta = await read({ id, mode: 'meta' });
    expect(meta).toMatchObject({
      format: 'image',
      pageCount: 1,
      textLayer: false,
      pagesWithoutText: [1],
      reading: 'vision',
      failure: null,
      extractor: null,
    });
    expect(meta.note).toContain('the engine does no OCR');
    expect(meta.note).toContain('mode "image"');
    expect(await read({ id, mode: 'text' })).toMatchObject({ pages: [], next: null });

    const zip = await record(
      'arhiva.zip',
      'application/zip',
      new Uint8Array([0x50, 0x4b, 3, 4, 1, 2]),
    );
    expect(await read({ id: zip.id, mode: 'meta' })).toMatchObject({
      format: 'binary',
      reading: 'unreadable',
      pageCount: null,
    });
  });
});

/** An image's leading bytes with the size its header states, padded to `length`. */
const png = (width: number, height: number, length = 64) => {
  const bytes = new Uint8Array(length);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
};
// A JPEG whose first segment is an APP0 and whose frame (SOF0) is 640 × 480.
const jpeg = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0, 4, 0x4a, 0x46, 0xff, 0xc0, 0, 11, 8, 0x01, 0xe0, 0x02, 0x80, 3, 0, 0,
  0, 0, 0,
]);
const webp = (() => {
  const bytes = new Uint8Array(40);
  bytes.set([...Buffer.from('RIFF'), 32, 0, 0, 0, ...Buffer.from('WEBPVP8X'), 10, 0, 0, 0, 0]);
  // VP8X: width and height less one, in 24 bits each, from byte 24.
  bytes.set([0x1f, 0x03, 0, 0x57, 0x02, 0], 24);
  return bytes;
})();

describe('evidence for agents', () => {
  test('an agent receives a photo as an image for its vision model, within the vision limits', async () => {
    const grant = await issue(['evidence.read']);
    const agent = await s.engine.agents.authenticate(grant.token, s.company.id);
    const image = async (filename: string, mediaType: string, bytes: Uint8Array) =>
      read({ id: (await record(filename, mediaType, bytes)).id, mode: 'image' }, agent);
    const photo = png(1200, 1600);
    const read1 = await image('bon.png', 'application/octet-stream', photo);
    expect(read1).toMatchObject({ format: 'image', reading: 'vision', textLayer: false });
    expect(read1.image).toEqual({
      mediaType: 'image/png',
      width: 1200,
      height: 1600,
      bytes: photo.length,
      base64: Buffer.from(photo).toString('base64'),
    });
    expect((await image('bon.jpg', 'image/jpeg', jpeg)).image).toMatchObject({
      mediaType: 'image/jpeg',
      width: 640,
      height: 480,
    });
    expect((await image('bon.webp', 'image/webp', webp)).image).toMatchObject({
      mediaType: 'image/webp',
      width: 800,
      height: 600,
    });
    // maxBytes bounds text; an image is bounded by what vision models accept.
    const refused = async (filename: string, bytes: Uint8Array) =>
      (await s.refused(image(filename, 'image/png', bytes)))?.code;
    expect(await refused('mare.png', png(1000, 1000, 3 * 1024 * 1024 + 768 * 1024 + 1))).toBe(
      'EVIDENCE_IMAGE_SIZE',
    );
    expect(await refused('lat.png', png(9000, 100))).toBe('EVIDENCE_IMAGE_DIMENSIONS');
    const heic = new Uint8Array([0, 0, 0, 24, ...Buffer.from('ftypheic'), 0, 0, 0, 0]);
    expect(await refused('bon.heic', heic)).toBe('EVIDENCE_IMAGE_FORMAT');
    expect(await refused('factura.pdf', pdfDocument([{ content: show(72, 780, 'Factura') }]))).toBe(
      'EVIDENCE_NOT_IMAGE',
    );
    // The largest image fits: its base64 is exactly 5 MiB.
    const largest = png(1000, 1000, 3 * 1024 * 1024 + 768 * 1024);
    expect((await image('limita.png', 'image/png', largest)).image?.base64?.length).toBe(
      5 * 1024 * 1024,
    );
  });

  test('an agent reads evidence with evidence.read; the whole file stays with people', async () => {
    const { id } = await record('nota.txt', 'text/plain', 'Notă contabilă');
    const grant = await issue(['evidence.read', 'evidence.list']);
    const agent = await s.engine.agents.authenticate(grant.token, s.company.id);
    expect((await read({ id, mode: 'text' }, agent)).pages?.[0]?.lines).toEqual([
      { line: 1, text: 'Notă contabilă' },
    ]);
    expect((await s.refused(s.invoke(agent, 'evidence.get', { id })))?.code).toBe('AGENT_SCOPE');
    expect((await s.refused(s.engine.evidence.read(agent, id)))?.code).toBe('AGENT_SCOPE');
    // No grant can name it, alone or through its toolset.
    expect((await s.refused(issue(['evidence.get'])))?.code).toBe('AGENT_SCOPE');
    const inbox = await issue(['toolset:inbox']);
    expect(inbox.scopes).toContain('evidence.read');
    expect(inbox.scopes).not.toContain('evidence.get');
    // People keep it.
    expect((await s.invoke<{ base64: string }>(s.viewer, 'evidence.get', { id })).base64).toBe(
      Buffer.from('Notă contabilă').toString('base64'),
    );
    expect(s.engine.operations.get('evidence.read')).toMatchObject({
      agent: true,
      toolset: 'inbox',
      dataClasses: ['evidence'],
      effect: 'read',
      risk: 'low',
    });
  });
});
