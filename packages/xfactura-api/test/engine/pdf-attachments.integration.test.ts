import { describe, expect, test } from 'bun:test';
import { once } from 'node:events';
import { createDeflate, deflateSync } from 'node:zlib';
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString } from 'pdf-lib';
import { pdfAttachments, pdfAttachmentsLimits } from '../../source/engine/adapters/pdf-attachments';
import { pdfDocument, show } from './fixtures/pdf';

const xml = Buffer.from('<declaratie300 luna="10" an="2026"/>');
const specification = '<< /Type /Filespec /F (return.xml) /EF << /F 1 0 R >> >>';

function pdfStream(id: number, dictionary: string, content: Uint8Array, length = content.length) {
  return Buffer.concat([
    Buffer.from(`${id} 0 obj\n<< ${dictionary} /Length ${length} >>\nstream\n`),
    content,
    Buffer.from('\nendstream\nendobj\n'),
  ]);
}

function objectStream(
  objects: [number, string][],
  options: {
    id?: number;
    header?: string;
    first?: number | string;
    count?: number | string;
    filter?: string;
  } = {},
) {
  let offset = 0;
  const pairs = objects.map(([id, body]) => {
    const pair = `${id} ${offset}`;
    offset += body.length + 1;
    return pair;
  });
  const header = options.header ?? `${pairs.join(' ')} `;
  return pdfStream(
    options.id ?? 10,
    `/Type /ObjStm /N ${options.count ?? objects.length} /First ${options.first ?? header.length} /Filter ${options.filter ?? '/FlateDecode'}`,
    deflateSync(Buffer.from(header + objects.map(([, body]) => `${body}\n`).join(''))),
  );
}

/** Valid minimal PDF with a page tree and `/Names /EmbeddedFiles` for `specifications`. */
function catalogPdf(
  parts: Uint8Array[],
  specifications = [2],
  catalog?: string,
  compressed: [number, number, number][] = [],
) {
  const names = specifications.map((id, index) => `(file-${index}) ${id} 0 R`).join(' ');
  const root =
    catalog ??
    `<< /Type /Catalog /Pages 899998 0 R /Names << /EmbeddedFiles << /Names [${names}] >> >> >>`;
  return revision(
    Buffer.from('%PDF-1.7\n'),
    [
      ...parts,
      Buffer.from('899998 0 obj\n<< /Type /Pages /Kids [899999 0 R] /Count 1 >>\nendobj\n'),
      Buffer.from(
        '899999 0 obj\n<< /Type /Page /Parent 899998 0 R /MediaBox [0 0 100 100] >>\nendobj\n',
      ),
      Buffer.from(`900000 0 obj\n${root}\nendobj\n`),
    ],
    900000,
    compressed,
  );
}

/** Minimal PDF attaching `stream` as `name`, Flate-compressed when `flate` is set. */
function pdfWith(stream: Uint8Array, flate: boolean, name = 'd300.xml') {
  const filter = flate ? ' /Filter /FlateDecode' : '';
  return catalogPdf([
    pdfStream(1, `/Type /EmbeddedFile${filter}`, stream),
    Buffer.from(`2 0 obj\n<< /Type /Filespec /F (${name}) /EF << /F 1 0 R >> >>\nendobj\n`),
  ]);
}

function withObjectStreams(compressed: [number, number, number][], ...streams: Uint8Array[]) {
  return catalogPdf(
    [pdfStream(1, '/Type /EmbeddedFile', xml), ...streams],
    [2],
    undefined,
    compressed,
  );
}

function revision(
  previous: Uint8Array,
  parts: Uint8Array[],
  root = 900000,
  compressed: [number, number, number][] = [],
) {
  let position = previous.length;
  const entries = new Map<number, { position: number; generation: number }>();
  for (const part of parts) {
    const header = /^(\d+)\s+(\d+)\s+obj/.exec(Buffer.from(part).toString('latin1'))!;
    entries.set(Number(header[1]), { position, generation: Number(header[2]) });
    position += part.length;
  }
  const previousText = Buffer.from(previous).toString('latin1');
  const oldXref = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(previousText)?.[1];
  const oldSize = Math.max(
    0,
    ...[...previousText.matchAll(/\/Size\s+(\d+)/g)].map((match) => Number(match[1])),
  );
  if (compressed.length) {
    const xrefNumber =
      Math.max(root, oldSize - 1, ...entries.keys(), ...compressed.map(([number]) => number)) + 1;
    const fields = new Map<number, [number, number, number]>(
      [...entries].map(([number, entry]) => [number, [1, entry.position, entry.generation]]),
    );
    for (const [number, owner, index] of compressed) fields.set(number, [2, owner, index]);
    fields.set(xrefNumber, [1, position, 0]);
    const rows = [...fields].sort(([left], [right]) => left - right);
    const data = Buffer.concat(
      rows.map(([, [type, offset, generation]]) => {
        const row = Buffer.alloc(7);
        row[0] = type;
        row.writeUInt32BE(offset, 1);
        row.writeUInt16BE(generation, 5);
        return row;
      }),
    );
    return Buffer.concat([
      previous,
      ...parts,
      pdfStream(
        xrefNumber,
        `/Type /XRef /Size ${xrefNumber + 1} /Root ${root} 0 R${oldXref ? ` /Prev ${oldXref}` : ''} /W [1 4 2] /Index [${rows.map(([number]) => `${number} 1`).join(' ')}] /Filter /FlateDecode`,
        deflateSync(data),
      ),
      Buffer.from(`startxref\n${position}\n%%EOF\n`),
    ]);
  }
  const xref = [...entries]
    .map(
      ([id, entry]) =>
        `${id} 1\n${String(entry.position).padStart(10, '0')} ${String(entry.generation).padStart(5, '0')} n\n`,
    )
    .join('');
  return Buffer.concat([
    previous,
    ...parts,
    Buffer.from(
      `xref\n${xref}trailer\n<< /Size ${Math.max(root, oldSize - 1, ...entries.keys()) + 1} /Root ${root} 0 R${oldXref ? ` /Prev ${oldXref}` : ''} >>\nstartxref\n${position}\n%%EOF\n`,
    ),
  ]);
}

async function libraryPdf(objectStreams: boolean) {
  const document = await PDFDocument.create();
  document.addPage();
  await document.attach(xml, 'return.xml', { mimeType: 'application/xml' });
  await document.flush();
  const names = document.catalog.lookup(PDFName.of('Names'), PDFDict);
  const tree = names.lookup(PDFName.of('EmbeddedFiles'), PDFDict);
  // Keep the name tree indirect so the writer places it in the object stream too.
  names.set(PDFName.of('EmbeddedFiles'), document.context.register(tree));
  const [specificationRef, specificationObject] = document.context
    .enumerateIndirectObjects()
    .find(([, object]) => object instanceof PDFDict && object.has(PDFName.of('EF')))!;
  return {
    bytes: await document.save({ useObjectStreams: objectStreams }),
    specificationRef,
    specificationBody: specificationObject.toString(),
    catalogRef: document.context.getObjectRef(document.catalog)!,
  };
}

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

describe('PDF attachments', () => {
  test('reads a compressed attachment', async () => {
    const content = new TextEncoder().encode('<declaratie300 luna="10" an="2026"/>');
    const result = await pdfAttachments(pdfWith(deflateSync(content), true));
    expect(result).toEqual({
      ok: true,
      attachments: [{ name: 'd300.xml', bytes: content, location: { kind: 'document' } }],
    });
  });

  test.each([false, true])(
    'reads pdf-lib attachments with object streams set to %s',
    async (objectStreams) => {
      const { bytes } = await libraryPdf(objectStreams);
      const raw = Buffer.from(bytes).toString('latin1');
      if (objectStreams) {
        expect(raw).toContain('/ObjStm');
        expect(raw).not.toContain('/Filespec');
        expect(raw).not.toContain('/EmbeddedFiles');
      }
      expect(await pdfAttachments(bytes)).toEqual({
        ok: true,
        attachments: [
          { name: 'return.xml', bytes: new Uint8Array(xml), location: { kind: 'document' } },
        ],
      });
    },
  );

  test('reads a page FileAttachment annotation with its page number', async () => {
    const document = await PDFDocument.create();
    document.addPage();
    const page2 = document.addPage();
    const embedded = document.context.register(
      document.context.flateStream(xml, { Type: 'EmbeddedFile' }),
    );
    const filespec = document.context.register(
      document.context.obj({
        Type: 'Filespec',
        F: PDFString.of('page-note.xml'),
        EF: { F: embedded },
      }),
    );
    const annot = document.context.register(
      document.context.obj({
        Type: 'Annot',
        Subtype: 'FileAttachment',
        Rect: [0, 0, 12, 12],
        FS: filespec,
      }),
    );
    // Also verify hidden annotations (F = 2) are still returned when intent is 'any'.
    const hiddenEmbedded = document.context.register(
      document.context.flateStream(Buffer.from('<hidden/>'), { Type: 'EmbeddedFile' }),
    );
    const hiddenSpec = document.context.register(
      document.context.obj({
        Type: 'Filespec',
        F: PDFString.of('hidden.xml'),
        EF: { F: hiddenEmbedded },
      }),
    );
    const hiddenAnnot = document.context.register(
      document.context.obj({
        Type: 'Annot',
        Subtype: 'FileAttachment',
        Rect: [0, 0, 12, 12],
        F: 2,
        FS: hiddenSpec,
      }),
    );
    page2.node.set(PDFName.of('Annots'), document.context.obj([annot, hiddenAnnot]));
    const bytes = await document.save({ useObjectStreams: true });
    expect(await pdfAttachments(bytes)).toEqual({
      ok: true,
      attachments: [
        { name: 'page-note.xml', bytes: new Uint8Array(xml), location: { kind: 'page', page: 2 } },
        {
          name: 'hidden.xml',
          bytes: new Uint8Array(Buffer.from('<hidden/>')),
          location: { kind: 'page', page: 2 },
        },
      ],
    });
  });

  test('a top-level incremental update replaces a compressed file specification', async () => {
    const { bytes, specificationRef, specificationBody, catalogRef } = await libraryPdf(true);
    const updated = revision(
      bytes,
      [
        Buffer.from(
          `${specificationRef.objectNumber} ${specificationRef.generationNumber} obj\n${specificationBody.replace('return.xml', 'updated.xml').replace(PDFHexString.fromText('return.xml').toString(), PDFHexString.fromText('updated.xml').toString())}\nendobj\n`,
        ),
      ],
      catalogRef.objectNumber,
    );
    expect(await pdfAttachments(updated)).toEqual({
      ok: true,
      attachments: [
        { name: 'updated.xml', bytes: new Uint8Array(xml), location: { kind: 'document' } },
      ],
    });
  });

  test('compressed objects resolve an embedded stream length', async () => {
    const content = catalogPdf(
      [
        Buffer.concat([
          Buffer.from('1 0 obj\n<< /Type /EmbeddedFile /Length 3 0 R >>\nstream\n'),
          xml,
          Buffer.from('\nendstream\nendobj\n'),
        ]),
        objectStream([
          [2, specification],
          [3, String(xml.length)],
        ]),
      ],
      [2],
      undefined,
      [
        [2, 10, 0],
        [3, 10, 1],
      ],
    );
    expect(await pdfAttachments(content)).toEqual({
      ok: true,
      attachments: [
        { name: 'return.xml', bytes: new Uint8Array(xml), location: { kind: 'document' } },
      ],
    });
  });

  test.each([false, true])(
    'resolves an indirect embedded-file dictionary, compressed: %s',
    async (compressed) => {
      const objects: [number, string][] = [[2, specification.replace('<< /F 1 0 R >>', '3 0 R')]];
      const compressedEntries: [number, number, number][] = [[2, 10, 0]];
      const dictionary = '<< /F 1 0 R >>';
      if (compressed) {
        objects.push([3, dictionary]);
        compressedEntries.push([3, 10, 1]);
      }
      const bytes = withObjectStreams(
        compressedEntries,
        objectStream(objects),
        ...(compressed ? [] : [Buffer.from(`3 0 obj\n${dictionary}\nendobj\n`)]),
      );
      expect(await pdfAttachments(bytes)).toEqual({
        ok: true,
        attachments: [
          { name: 'return.xml', bytes: new Uint8Array(xml), location: { kind: 'document' } },
        ],
      });
    },
  );

  test('object markers inside an embedded PDF do not replace its outer objects', async () => {
    const enclosed = Buffer.from('%PDF-1.4\n2 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
    // Stored DEFLATE blocks preserve the inner PDF's literal object markers.
    const bytes = catalogPdf(
      [
        pdfStream(
          1,
          '/Type /EmbeddedFile /Filter /FlateDecode',
          deflateSync(enclosed, { level: 0 }),
        ),
        objectStream([[2, specification.replace('return.xml', 'enclosed.pdf')]]),
      ],
      [2],
      undefined,
      [[2, 10, 0]],
    );
    expect(await pdfAttachments(bytes)).toEqual({
      ok: true,
      attachments: [
        { name: 'enclosed.pdf', bytes: new Uint8Array(enclosed), location: { kind: 'document' } },
      ],
    });
  });

  test('a later object stream replaces an earlier top-level specification', async () => {
    const original = pdfWith(xml, false, 'return.xml');
    const evil = Buffer.from('<evil/>');
    const updated = revision(
      original,
      [
        pdfStream(3, '/Type /EmbeddedFile', evil),
        objectStream([[2, specification.replace('1 0 R', '3 0 R')]]),
      ],
      900000,
      [[2, 10, 0]],
    );
    const reader = await PDFDocument.load(updated, { updateMetadata: false });
    const live = reader.context.lookup(PDFRef.of(2, 0), PDFDict);
    expect(live.lookup(PDFName.of('EF'), PDFDict).get(PDFName.of('F'))?.toString()).toBe('3 0 R');
    const result = await pdfAttachments(updated);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attachments.map((file) => Buffer.from(file.bytes).toString())).toEqual([
        '<evil/>',
      ]);
    }
  });

  test('a generation bump leaves only the newest object number live', async () => {
    const updated = revision(pdfWith(xml, false), [
      pdfStream(3, '/Type /EmbeddedFile', Buffer.from('<evil/>')),
      Buffer.from(`2 1 obj\n${specification.replace('1 0 R', '3 0 R')}\nendobj\n`),
      Buffer.from(
        '900000 0 obj\n<< /Type /Catalog /Pages 899998 0 R /Names << /EmbeddedFiles << /Names [(file-0) 2 1 R] >> >> >>\nendobj\n',
      ),
    ]);
    const result = await pdfAttachments(updated);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attachments.map((file) => Buffer.from(file.bytes).toString())).toEqual([
        '<evil/>',
      ]);
    }
  });

  test.each([false, true])(
    'the selected name and EF key agree regardless of order: %s',
    async (reverse) => {
      const ef = reverse ? '/UF 3 0 R /F 1 0 R' : '/F 1 0 R /UF 3 0 R';
      const content = catalogPdf([
        pdfStream(1, '/Type /EmbeddedFile', xml),
        pdfStream(3, '/Type /EmbeddedFile', Buffer.from('<evil/>')),
        Buffer.from(
          `2 0 obj\n<< /Type /Filespec /F (fallback.xml) /UF (unicode.xml) /EF << ${ef} >> >>\nendobj\n`,
        ),
      ]);
      const result = await pdfAttachments(content);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(
          result.attachments.map((file) => [file.name, Buffer.from(file.bytes).toString()]),
        ).toEqual([['unicode.xml', '<evil/>']]);
      }
    },
  );

  test('a UTF-16BE hex UF and PDFDocEncoding names decode properly', async () => {
    const utf16Name = PDFHexString.fromText('declarație.xml').toString();
    const content = catalogPdf(
      [
        pdfStream(1, '/Type /EmbeddedFile', xml),
        Buffer.from(
          `2 0 obj\n<< /Type /Filespec /UF ${utf16Name} /EF << /UF 1 0 R >> >>\nendobj\n`,
        ),
        Buffer.from(
          `3 0 obj\n<< /Type /Filespec /UF (cost\\240.xml) /EF << /UF 1 0 R >> >>\nendobj\n`,
        ),
      ],
      [2, 3],
    );
    const result = await pdfAttachments(content);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attachments.map((file) => file.name)).toEqual(['declarație.xml', 'cost€.xml']);
    }
  });

  test('an orphaned specification beside the reachable one is ignored, and alone yields none', async () => {
    const withReachable = catalogPdf([
      pdfStream(1, '/Type /EmbeddedFile', xml),
      Buffer.from(
        `2 0 obj\n${specification}\nendobj\n3 0 obj\n${specification.replace('return.xml', 'orphan.xml')}\nendobj\n`,
      ),
    ]);
    const alone = catalogPdf(
      [
        pdfStream(1, '/Type /EmbeddedFile', xml),
        Buffer.from(`3 0 obj\n${specification.replace('return.xml', 'orphan.xml')}\nendobj\n`),
      ],
      [],
    );
    const first = await pdfAttachments(withReachable);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.attachments.map((file) => file.name)).toEqual(['return.xml']);
    expect(await pdfAttachments(alone)).toEqual({ ok: true, attachments: [] });
  });

  test('distinct specifications sharing one name remain distinct', async () => {
    const content = catalogPdf(
      [
        pdfStream(1, '/Type /EmbeddedFile', xml),
        Buffer.from(`2 0 obj\n${specification}\nendobj\n`),
        Buffer.from(`3 0 obj\n${specification}\nendobj\n`),
      ],
      [2, 3],
    );
    const result = await pdfAttachments(content);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attachments.map((file) => file.name)).toEqual(['return.xml', 'return.xml']);
    }
  });

  test('the newest catalog and Kids name tree determine reachability', async () => {
    const old = pdfWith(xml, false);
    const updated = revision(old, [
      pdfStream(3, '/Type /EmbeddedFile', Buffer.from('<evil/>')),
      Buffer.from(`4 0 obj\n${specification.replace('1 0 R', '3 0 R')}\nendobj\n`),
      Buffer.from(
        '900000 0 obj\n<< /Type /Catalog /Pages 899998 0 R /Names << /EmbeddedFiles << /Kids [50 0 R] >> >> >>\nendobj\n',
      ),
      Buffer.from('50 0 obj\n<< /Names [(return.xml) 4 0 R] >>\nendobj\n'),
    ]);
    const result = await pdfAttachments(updated);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attachments.map((file) => Buffer.from(file.bytes).toString())).toEqual([
        '<evil/>',
      ]);
    }
  });

  test('without a resolvable catalog, specifications are not guessed to be attachments', async () => {
    const bytes = Buffer.concat([
      pdfStream(1, '/Type /EmbeddedFile', xml),
      Buffer.from(`2 0 obj\n${specification}\nendobj\n`),
    ]);
    expect(await pdfAttachments(bytes)).toEqual({ ok: false, reason: 'corrupt' });
  });

  test('an indirect stream length excludes inner endobj and spoofed objects', async () => {
    const payload = Buffer.from(
      `0 0 obj endobj\n2 0 obj\n${specification.replace('return.xml', 'spoof.xml')}\nendobj\n`,
    );
    const stream = Buffer.concat([
      Buffer.from('1 0 obj\n<< /Type /EmbeddedFile /Length 11 0 R >>\nstream\n'),
      payload,
      Buffer.from('\nendstream\nendobj\n'),
    ]);
    const content = catalogPdf([
      Buffer.from(`2 0 obj\n${specification}\nendobj\n`),
      stream,
      Buffer.from(`11 0 obj\n${payload.length}\nendobj\n`),
    ]);
    const result = await pdfAttachments(content);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attachments.map((file) => file.name)).toEqual(['return.xml']);
      expect(Buffer.from(result.attachments[0]!.bytes).equals(payload)).toBe(true);
    }
  });

  test('N and First references resolve to integers', async () => {
    // pdf-lib resolves object streams in file order, so indirect N and First precede the stream.
    const content = withObjectStreams(
      [[2, 10, 0]],
      Buffer.from('5 0 obj\n1\nendobj\n'),
      Buffer.from('6 0 obj\n4\nendobj\n'),
      objectStream([[2, specification]], { count: '5 0 R', first: '6 0 R' }),
    );
    const result = await pdfAttachments(content);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.attachments.map((file) => file.name)).toEqual(['return.xml']);
  });

  test('a missing EF/UF falls back to the F stream while reporting the UF name', async () => {
    const content = catalogPdf([
      pdfStream(1, '/Type /EmbeddedFile', xml),
      Buffer.from(
        `2 0 obj\n<< /Type /Filespec /F (fallback.xml) /UF (other.xml) /EF << /F 1 0 R >> >>\nendobj\n`,
      ),
    ]);
    const result = await pdfAttachments(content);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.attachments.map((file) => file.name)).toEqual(['other.xml']);
  });

  test('cyclic and overly deep name trees fail closed', async () => {
    for (const count of [1, 35]) {
      const nodes = Array.from({ length: count }, (_, at) =>
        Buffer.from(
          `${100 + at} 0 obj\n<< /Kids [${at + 1 < count ? 101 + at : 100} 0 R] >>\nendobj\n`,
        ),
      );
      const content = catalogPdf(
        [
          pdfStream(1, '/Type /EmbeddedFile', xml),
          Buffer.from(`2 0 obj\n${specification}\nendobj\n`),
          ...nodes,
        ],
        [],
        '<< /Type /Catalog /Pages 899998 0 R /Names << /EmbeddedFiles 100 0 R >> >>',
      );
      expect(await pdfAttachments(content)).toEqual({ ok: false, reason: 'corrupt' });
    }
  });

  test('an unreadable reachable attachment fails closed instead of returning a partial inventory', async () => {
    const content = catalogPdf(
      [
        pdfStream(1, '/Type /EmbeddedFile', xml),
        Buffer.from(
          `2 0 obj\n${specification}\nendobj\n4 0 obj\n${specification.replace('1 0 R', '99 0 R')}\nendobj\n`,
        ),
      ],
      [2, 4],
    );
    expect(await pdfAttachments(content)).toEqual({ ok: false, reason: 'corrupt' });
  });

  test('PNG-predicted cross references resolve a forward Length outside stream data', async () => {
    const payload = Buffer.from('nested endobj\n0 0 obj endobj\n');
    const parts = [
      Buffer.concat([
        Buffer.from('1 0 obj\n<< /Type /EmbeddedFile /Length 11 0 R >>\nstream\n'),
        payload,
        Buffer.from('\nendstream\nendobj\n'),
      ]),
      Buffer.from(`2 0 obj\n${specification}\nendobj\n`),
      Buffer.from(`11 0 obj\n${payload.length}\nendobj\n`),
      Buffer.from('899998 0 obj\n<< /Type /Pages /Kids [899999 0 R] /Count 1 >>\nendobj\n'),
      Buffer.from(
        '899999 0 obj\n<< /Type /Page /Parent 899998 0 R /MediaBox [0 0 100 100] >>\nendobj\n',
      ),
      Buffer.from(
        '900000 0 obj\n<< /Type /Catalog /Pages 899998 0 R /Names << /EmbeddedFiles << /Names [(return.xml) 2 0 R] >> >> >>\nendobj\n',
      ),
    ];
    let offset = Buffer.byteLength('%PDF-1.7\n');
    const rows = parts.map((part) => {
      const row = Buffer.alloc(7);
      row[0] = 1;
      row.writeUInt32BE(offset, 1);
      offset += part.length;
      return row;
    });
    const predicted = rows.map((row, at) =>
      Buffer.from([2, ...row.map((byte, index) => (byte - (rows[at - 1]?.[index] ?? 0)) & 255)]),
    );
    const xref = pdfStream(
      30,
      '/Type /XRef /Root 900000 0 R /Size 900001 /Index [1 2 11 1 899998 3] /W [1 4 2] /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 7 >>',
      deflateSync(Buffer.concat(predicted)),
    );
    const content = Buffer.concat([
      Buffer.from('%PDF-1.7\n'),
      ...parts,
      xref,
      Buffer.from(`startxref\n${offset}\n%%EOF\n`),
    ]);
    const result = await pdfAttachments(content);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attachments.map((file) => Buffer.from(file.bytes).toString())).toEqual([
        payload.toString(),
      ]);
    }
  });

  test('the newest Root selects a different catalog rather than inheriting the old one', async () => {
    const updated = revision(
      pdfWith(xml, false),
      [
        pdfStream(3, '/Type /EmbeddedFile', Buffer.from('<evil/>')),
        Buffer.from(`4 0 obj\n${specification.replace('1 0 R', '3 0 R')}\nendobj\n`),
        Buffer.from(
          '800000 0 obj\n<< /Type /Catalog /Pages 899998 0 R /Names << /EmbeddedFiles << /Names [(evil) 4 0 R] >> >> >>\nendobj\n',
        ),
      ],
      800000,
    );
    const result = await pdfAttachments(updated);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attachments.map((file) => Buffer.from(file.bytes).toString())).toEqual([
        '<evil/>',
      ]);
    }
  });

  test('a stream dictionary cannot masquerade as the document catalog', async () => {
    const content = revision(Buffer.from('%PDF-1.7\n'), [
      pdfStream(1, '/Type /EmbeddedFile', xml),
      Buffer.from(`2 0 obj\n${specification}\nendobj\n`),
      Buffer.from('899998 0 obj\n<< /Type /Pages /Kids [899999 0 R] /Count 1 >>\nendobj\n'),
      Buffer.from(
        '899999 0 obj\n<< /Type /Page /Parent 899998 0 R /MediaBox [0 0 100 100] >>\nendobj\n',
      ),
      pdfStream(
        900000,
        '/Type /Catalog /Pages 899998 0 R /Names << /EmbeddedFiles << /Names [(a) 2 0 R] >> >>',
        Buffer.from('not a catalog'),
      ),
    ]);
    expect(await pdfAttachments(content)).toEqual({ ok: false, reason: 'corrupt' });
  });

  test('a corrupt stream or unknown filter fails as corrupt instead of returning empty or raw bytes', async () => {
    expect(await pdfAttachments(pdfWith(new Uint8Array([1, 2, 3, 4]), true))).toEqual({
      ok: false,
      reason: 'corrupt',
    });
    const full = deflateSync(
      Buffer.from(Array.from({ length: 4000 }, (_, i) => `<r n="${i}"/>`).join('')),
    );
    expect(await pdfAttachments(pdfWith(full.subarray(0, full.length >> 1), true))).toEqual({
      ok: false,
      reason: 'corrupt',
    });
    const unknownFilter = catalogPdf([
      pdfStream(1, '/Type /EmbeddedFile /Filter /UnknownDecode', xml),
      Buffer.from(`2 0 obj\n${specification}\nendobj\n`),
    ]);
    expect(await pdfAttachments(unknownFilter)).toEqual({ ok: false, reason: 'corrupt' });
  });

  test('a FileAttachment annotation with a bad indirect entry fails as corrupt instead of disappearing', async () => {
    const makeProbe = (extraEntry: string, badRefOffset?: number) => {
      const parts = [
        pdfStream(1, '/Type /EmbeddedFile', xml),
        Buffer.from(`2 0 obj\n${specification}\nendobj\n`),
        pdfStream(5, '/Type /EmbeddedFile', Buffer.from('<evil/>')),
        Buffer.from(
          `6 0 obj\n${specification.replace('1 0 R', '5 0 R').replace('return.xml', 'extra.xml')}\nendobj\n`,
        ),
        Buffer.from(
          `7 0 obj\n<< /Type /Annot /Subtype /FileAttachment /Rect [0 0 10 10] /FS 6 0 R${extraEntry} >>\nendobj\n`,
        ),
        Buffer.from('899998 0 obj\n<< /Type /Pages /Kids [899999 0 R] /Count 1 >>\nendobj\n'),
        Buffer.from(
          '899999 0 obj\n<< /Type /Page /Parent 899998 0 R /MediaBox [0 0 100 100] /Annots [7 0 R] >>\nendobj\n',
        ),
        Buffer.from(
          '900000 0 obj\n<< /Type /Catalog /Pages 899998 0 R /Names << /EmbeddedFiles << /Names [(return.xml) 2 0 R] >> >> >>\nendobj\n',
        ),
        ...(badRefOffset !== undefined ? [Buffer.from('50 0 obj\n(title)\nendobj\n')] : []),
      ];
      let position = Buffer.byteLength('%PDF-1.7\n');
      const entries = new Map<number, number>();
      for (const part of parts) {
        const id = Number(/^(\d+)/.exec(Buffer.from(part).toString('latin1'))![1]);
        entries.set(id, badRefOffset !== undefined && id === 50 ? badRefOffset : position);
        position += part.length;
      }
      const xref = [...entries]
        .sort(([a], [b]) => a - b)
        .map(([id, offset]) => `${id} 1\n${String(offset).padStart(10, '0')} 00000 n \n`)
        .join('');
      return Buffer.concat([
        Buffer.from('%PDF-1.7\n'),
        ...parts,
        Buffer.from(
          `xref\n${xref}trailer\n<< /Size 900001 /Root 900000 0 R >>\nstartxref\n${position}\n%%EOF\n`,
        ),
      ]);
    };

    const control = await pdfAttachments(makeProbe(''));
    expect(control.ok).toBe(true);
    if (control.ok) {
      expect(control.attachments.map((item) => [item.name, item.location])).toEqual([
        ['return.xml', { kind: 'document' }],
        ['extra.xml', { kind: 'page', page: 1 }],
      ]);
    }
    expect(await pdfAttachments(makeProbe(' /T 50 0 R', 30))).toEqual({
      ok: false,
      reason: 'corrupt',
    });
    expect(await pdfAttachments(makeProbe(' /M 50 0 R', 30))).toEqual({
      ok: false,
      reason: 'corrupt',
    });
  });

  test('collapsed name-tree keys (PDFDocEncoding vs UTF-16BE or duplicate raw keys) are ambiguous', async () => {
    const utf16Key = PDFHexString.fromText('return.xml').toString();
    const mixedEncoding = catalogPdf(
      [
        pdfStream(1, '/Type /EmbeddedFile', xml),
        pdfStream(5, '/Type /EmbeddedFile', Buffer.from('<evil/>')),
        Buffer.from(`2 0 obj\n${specification}\nendobj\n`),
        Buffer.from(`6 0 obj\n${specification.replace('1 0 R', '5 0 R')}\nendobj\n`),
      ],
      [],
      `<< /Type /Catalog /Pages 899998 0 R /Names << /EmbeddedFiles << /Names [(return.xml) 2 0 R ${utf16Key} 6 0 R] >> >> >>`,
    );
    expect(await pdfAttachments(mixedEncoding)).toEqual({ ok: false, reason: 'ambiguous' });

    const duplicateRawKey = catalogPdf(
      [
        pdfStream(1, '/Type /EmbeddedFile', xml),
        pdfStream(5, '/Type /EmbeddedFile', Buffer.from('<evil/>')),
        Buffer.from(`2 0 obj\n${specification}\nendobj\n`),
        Buffer.from(`6 0 obj\n${specification.replace('1 0 R', '5 0 R')}\nendobj\n`),
      ],
      [],
      '<< /Type /Catalog /Pages 899998 0 R /Names << /EmbeddedFiles << /Names [(return.xml) 6 0 R (return.xml) 2 0 R] >> >> >>',
    );
    expect(await pdfAttachments(duplicateRawKey)).toEqual({ ok: false, reason: 'ambiguous' });
  });
});

describe('hostile PDFs and reader limits', () => {
  test('a corrupt file is corrupt', async () => {
    expect(await pdfAttachments(new TextEncoder().encode('%PDF-1.7\n1 0 obj << /Type'))).toEqual({
      ok: false,
      reason: 'corrupt',
    });
  });

  test('an unterminated object run ends in bounded time', async () => {
    const content = Buffer.from('%PDF-1.7\n' + '1 0 obj '.repeat(300_000));
    const started = performance.now();
    expect(await pdfAttachments(content)).toEqual({ ok: false, reason: 'corrupt' });
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test('a PDF with a user password is encrypted', async () => {
    const locked = pdfDocument([{ content: show(72, 700, 'Secret') }], { encrypted: true });
    expect(await pdfAttachments(locked)).toEqual({ ok: false, reason: 'encrypted' });
  });

  test('a larger input is refused unread', async () => {
    expect(pdfAttachmentsLimits.inputBytes).toBe(64 * 1024 * 1024);
    const sample = pdfWith(xml, false);
    expect(await pdfAttachments(sample, { limits: { inputBytes: sample.length - 1 } })).toEqual({
      ok: false,
      reason: 'too_large',
      limit: 'input',
    });
  });

  test('more pages than the limit are refused', async () => {
    expect(pdfAttachmentsLimits.pages).toBe(200);
    const many = pdfDocument(
      Array.from({ length: 201 }, (_, index) => ({
        content: show(72, 700, `Pagina ${index + 1}`),
      })),
    );
    expect(await pdfAttachments(many)).toEqual({
      ok: false,
      reason: 'too_large',
      limit: 'pages',
      pageCount: 201,
    });
  });

  test('attachment count is bounded across document and page annotations', async () => {
    const document = await PDFDocument.create();
    document.addPage();
    for (let i = 0; i < 4; i++) await document.attach(xml, `f-${i}.xml`);
    const bytes = await document.save({ useObjectStreams: true });
    expect(await pdfAttachments(bytes, { limits: { attachments: 3 } })).toEqual({
      ok: false,
      reason: 'too_large',
      limit: 'attachments',
    });

    const pageDoc = await PDFDocument.create();
    const page = pageDoc.addPage();
    const annots = [];
    for (let i = 0; i < 4; i++) {
      const ef = pageDoc.context.register(
        pageDoc.context.flateStream(xml, { Type: 'EmbeddedFile' }),
      );
      const fs = pageDoc.context.register(
        pageDoc.context.obj({ Type: 'Filespec', F: PDFString.of(`p-${i}.xml`), EF: { F: ef } }),
      );
      annots.push(
        pageDoc.context.register(
          pageDoc.context.obj({
            Type: 'Annot',
            Subtype: 'FileAttachment',
            Rect: [0, 0, 12, 12],
            FS: fs,
          }),
        ),
      );
    }
    page.node.set(PDFName.of('Annots'), pageDoc.context.obj(annots));
    const pageBytes = await pageDoc.save({ useObjectStreams: true });
    expect(await pdfAttachments(pageBytes, { limits: { attachments: 3 } })).toEqual({
      ok: false,
      reason: 'too_large',
      limit: 'attachments',
    });
  });

  test('combined attachment bytes and the attachmentBytes limit are enforced', async () => {
    expect(pdfAttachmentsLimits.attachmentBytes).toBe(24 * 1024 * 1024);
    const sample = await pdfAttachments(pdfWith(xml, false), {
      limits: { attachmentBytes: xml.length - 1 },
    });
    expect(sample).toEqual({
      ok: false,
      reason: 'too_large',
      limit: 'attachmentBytes',
    });

    // Two 13 MiB streams stay under 24 MiB individually but exceed 24 MiB combined under default limits.
    const compressed = deflateSync(Buffer.alloc(13 * 1024 * 1024, 'x'));
    const combined = catalogPdf(
      [
        pdfStream(1, '/Type /EmbeddedFile /Filter /FlateDecode', compressed),
        pdfStream(3, '/Type /EmbeddedFile /Filter /FlateDecode', compressed),
        objectStream([
          [2, specification],
          [4, specification.replace('1 0 R', '3 0 R')],
        ]),
      ],
      [2, 4],
      undefined,
      [
        [2, 10, 0],
        [4, 10, 1],
      ],
    );
    expect(await pdfAttachments(combined)).toEqual({
      ok: false,
      reason: 'too_large',
      limit: 'attachmentBytes',
    });
  });

  test('an embedded decompression bomb is killed at the memory limit', async () => {
    const bomb = await deflatedSpaces(512);
    expect(bomb.length).toBeLessThan(1024 * 1024);
    expect(await pdfAttachments(pdfWith(bomb, true))).toEqual({
      ok: false,
      reason: 'too_large',
      limit: 'memory',
    });
  });

  test('the reader is killed when it runs out of time', async () => {
    expect(pdfAttachmentsLimits.timeoutMs).toBe(10_000);
    let pid = 0;
    const result = await pdfAttachments(pdfWith(xml, false), {
      limits: { timeoutMs: 1 },
      onSpawn: (spawned) => (pid = spawned),
    });
    expect(result).toEqual({ ok: false, reason: 'timeout' });
    expect(pid).toBeGreaterThan(0);
    // The process is gone, not left running.
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
