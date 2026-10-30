import { deflateSync } from 'node:zlib';

/**
 * Minimal PDFs written by hand for the reader's tests: Helvetica text in WinAnsi, with the
 * Romanian letters it lacks mapped to free codes by glyph name, a cross-reference table and
 * a trailer. Hostile variants override what they need.
 */
export interface PdfPage {
  /** The page's content stream: operators, or raw bytes. */
  content: string | Uint8Array;
  /** Compress the content stream with Flate, or `deflated`: it already is. */
  flate?: boolean | 'deflated';
  rotate?: 0 | 90 | 180 | 270;
}

/** Letters missing from WinAnsi, at codes 128 onwards, named as pdf.js maps them. */
const extra: Record<string, [number, string]> = {
  ă: [128, 'uni0103'],
  ș: [129, 'uni0219'],
  ț: [130, 'uni021B'],
  Ă: [131, 'uni0102'],
  Ș: [132, 'uni0218'],
  Ț: [133, 'uni021A'],
};
const winAnsi: Record<string, number> = { â: 0xe2, î: 0xee, Â: 0xc2, Î: 0xce };

/** A PDF string literal for `text` in the fixture font. */
export function literal(text: string) {
  let out = '';
  for (const character of text) {
    const code = extra[character]?.[0] ?? winAnsi[character] ?? character.charCodeAt(0);
    if (code > 255) throw new Error(`No code for ${character}`);
    out +=
      character === '(' || character === ')' || character === '\\'
        ? `\\${character}`
        : code < 32 || code > 126
          ? `\\${code.toString(8).padStart(3, '0')}`
          : character;
  }
  return `(${out})`;
}

/** Shows `text` at (x, y) in points from the bottom left, in the fixture font. */
export const show = (x: number, y: number, text: string, size = 10) =>
  `BT /F1 ${size} Tf ${x} ${y} Td ${literal(text)} Tj ET`;

const font = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [128 ${Object.values(
  extra,
)
  .map(([, name]) => `/${name}`)
  .join(' ')}] >> >>`;

export function pdfDocument(
  pages: PdfPage[],
  options: {
    /** The page count the page tree claims, whatever it holds. */
    count?: number;
    /** A standard security handler whose user password is not empty. */
    encrypted?: boolean;
    /** Extra entries for the first page's dictionary. */
    pageExtra?: string;
  } = {},
): Uint8Array {
  const objects: (string | Uint8Array)[] = [];
  const add = (body: string | Uint8Array) => objects.push(body);
  add(font); // 1
  const tree = 2 + pages.length * 2;
  const kids: number[] = [];
  pages.forEach((page, index) => {
    const raw =
      typeof page.content === 'string' ? Buffer.from(page.content, 'latin1') : page.content;
    const data = page.flate === true ? deflateSync(raw) : raw;
    add(
      Buffer.concat([
        Buffer.from(
          `<< /Length ${data.length}${page.flate ? ' /Filter /FlateDecode' : ''} >>\nstream\n`,
          'latin1',
        ),
        data,
        Buffer.from('\nendstream', 'latin1'),
      ]),
    );
    kids.push(objects.length + 1);
    add(
      `<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 595 842]${page.rotate ? ` /Rotate ${page.rotate}` : ''} /Resources << /Font << /F1 1 0 R >> >> /Contents ${objects.length} 0 R${index === 0 && options.pageExtra ? ` ${options.pageExtra}` : ''} >>`,
    );
  });
  add(
    `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(' ')}] /Count ${options.count ?? pages.length} >>`,
  );
  add(`<< /Type /Catalog /Pages ${tree} 0 R >>`);
  const catalog = objects.length;
  if (options.encrypted)
    add(
      `<< /Filter /Standard /V 1 /R 2 /Length 40 /P -4 /O <${'ab'.repeat(32)}> /U <${'cd'.repeat(32)}> >>`,
    );
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = chunks[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, 'latin1'),
      typeof body === 'string' ? Buffer.from(body, 'latin1') : Buffer.from(body),
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    offsets.push(offset);
    offset += chunk.length;
    chunks.push(chunk);
  });
  const id = `<${'0123456789abcdef'.repeat(2)}>`;
  chunks.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
        .map((at) => `${String(at).padStart(10, '0')} 00000 n \n`)
        .join('')}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R${
        options.encrypted ? ` /Encrypt ${objects.length} 0 R /ID [${id} ${id}]` : ''
      } >>\nstartxref\n${offset}\n%%EOF\n`,
      'latin1',
    ),
  );
  return new Uint8Array(Buffer.concat(chunks));
}
