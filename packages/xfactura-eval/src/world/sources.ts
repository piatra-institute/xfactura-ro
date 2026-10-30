import { calculateInvoice, writeInvoice } from 'xfactura-core/einvoice';
import { pdfDocument, show } from '../../../xfactura-api/test/engine/fixtures/pdf';
import { receiptPng } from './png';
import type { Source, WorldDocument } from './schema';

/** Windows-1250 for the Romanian letters bank exports use; the rest must be ASCII. */
const cp1250: Record<string, number> = {
  ă: 0xe3,
  â: 0xe2,
  î: 0xee,
  ș: 0xba,
  ş: 0xba,
  ț: 0xfe,
  ţ: 0xfe,
  Ă: 0xc3,
  Â: 0xc2,
  Î: 0xce,
  Ș: 0xaa,
  Ş: 0xaa,
  Ț: 0xde,
  Ţ: 0xde,
};
function windows1250(text: string) {
  return new Uint8Array(
    [...text].map((character) => {
      const code = cp1250[character] ?? character.charCodeAt(0);
      if (code > 0x7f && cp1250[character] === undefined)
        throw new Error(`No Windows-1250 byte for ${character}`);
      return code;
    }),
  );
}

/** The top of a page's first line and the distance between lines, in points. */
const top = 790;
const leading = 16;

/** A file's bytes, as the person who drops it into the books has them. */
export function render(source: Source): Uint8Array {
  switch (source.kind) {
    case 'ubl':
      return new TextEncoder().encode(writeInvoice(calculateInvoice(source.invoice)));
    case 'pdf':
      // An empty line is a gap on the page; the reader leaves it out of the text layer.
      return pdfDocument(
        source.pages.map((lines) => ({
          content: lines
            .flatMap((line, index) => (line ? [show(56, top - index * leading, line, 10)] : []))
            .join('\n'),
        })),
      );
    case 'image':
      return receiptPng(source.lines);
    default:
      return source.encoding === 'windows-1250'
        ? windows1250(source.text)
        : new TextEncoder().encode(source.text);
  }
}

/**
 * Where a citation's text is in the file: the page and line of a PDF the reader numbers as
 * `evidence.read` does (one shown line per line, from 1). Null for a file without a text layer.
 */
export function locate(document: WorldDocument, text: string) {
  if (document.source.kind !== 'pdf') return null;
  for (const [pageIndex, all] of document.source.pages.entries()) {
    const lines = all.filter(Boolean);
    const line = lines.findIndex((candidate) => candidate.includes(text));
    if (line >= 0) return { page: pageIndex + 1, line: line + 1, text };
  }
  throw new Error(`${document.key}: no line shows «${text}»`);
}
