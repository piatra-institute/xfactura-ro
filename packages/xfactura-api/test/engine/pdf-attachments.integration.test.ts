import { describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { pdfAttachments } from '../../source/engine/adapters/pdf-attachments';

/** A minimal PDF attaching `stream` as `name`, Flate-compressed when `flate` is set. */
function pdfWith(stream: Uint8Array, flate: boolean, name = 'd300.xml') {
  const filter = flate ? ' /Filter /FlateDecode' : '';
  const head = `%PDF-1.4\n1 0 obj\n<< /Type /EmbeddedFile${filter} /Length ${stream.length} >>\nstream\n`;
  const tail = `\nendstream\nendobj\n2 0 obj\n<< /Type /Filespec /F (${name}) /EF << /F 1 0 R >> >>\nendobj\n%%EOF\n`;
  return new Uint8Array([
    ...new TextEncoder().encode(head),
    ...stream,
    ...new TextEncoder().encode(tail),
  ]);
}

describe('PDF attachments', () => {
  test('reads a compressed attachment', () => {
    const xml = new TextEncoder().encode('<declaratie300 luna="10" an="2026"/>');
    const [attachment] = pdfAttachments(pdfWith(deflateSync(xml), true));
    expect(attachment?.name).toBe('d300.xml');
    expect(new TextDecoder().decode(attachment?.bytes)).toBe(
      '<declaratie300 luna="10" an="2026"/>',
    );
  });

  test('a corrupt stream is skipped instead of failing the whole file', () => {
    expect(pdfAttachments(pdfWith(new Uint8Array([1, 2, 3, 4]), true))).toEqual([]);
  });

  test('a compression bomb stops at the evidence size limit', () => {
    // About 64 KiB that would inflate past 64 MiB.
    const bomb = deflateSync(new Uint8Array(64 * 1024 * 1024 + 1));
    expect(bomb.length).toBeLessThan(100 * 1024);
    expect(pdfAttachments(pdfWith(bomb, true))).toEqual([]);
  });
});
