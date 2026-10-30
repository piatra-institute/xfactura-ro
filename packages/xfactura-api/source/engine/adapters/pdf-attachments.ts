import { inflateSync } from 'node:zlib';

/** No attachment inflates past the evidence size limit, so a compression bomb fails fast. */
const MAX_INFLATED = 64 * 1024 * 1024;

/**
 * Files attached to a PDF, as ANAF's tools attach a declaration's XML to its PDF. Reads the
 * file specifications (`/F` or `/UF` names with an `/EF` stream) and their embedded-file
 * streams, Flate-compressed or not; for an object rewritten by an incremental update (a
 * signature appended to the file), the last revision counts. Not a general PDF reader.
 */
export function pdfAttachments(bytes: Uint8Array): { name: string; bytes: Uint8Array }[] {
  const text = Buffer.from(bytes).toString('latin1');
  const objects = new Map<string, { body: string; start: number }>();
  for (const match of text.matchAll(/(\d+)\s+(\d+)\s+obj\b/g)) {
    const end = text.indexOf('endobj', match.index);
    if (end < 0) continue;
    objects.set(`${match[1]} ${match[2]}`, {
      body: text.slice(match.index + match[0].length, end),
      start: match.index + match[0].length,
    });
  }
  const resolve = (value: string) => {
    const reference = /^(\d+)\s+(\d+)\s+R$/.exec(value.trim());
    return reference ? objects.get(`${reference[1]} ${reference[2]}`)?.body.trim() : value.trim();
  };
  const stream = (id: string): Uint8Array | undefined => {
    const object = objects.get(id);
    if (!object) return undefined;
    const marker = /stream\r?\n/.exec(object.body);
    if (!marker) return undefined;
    const dictionary = object.body.slice(0, marker.index);
    const length = Number(resolve(/\/Length\s+(\d+\s+\d+\s+R|\d+)/.exec(dictionary)?.[1] ?? 'NaN'));
    if (!Number.isFinite(length)) return undefined;
    const offset = object.start + marker.index + marker[0].length;
    const raw = Buffer.from(text.slice(offset, offset + length), 'latin1');
    if (!/\/FlateDecode/.test(dictionary)) return new Uint8Array(raw);
    try {
      return new Uint8Array(inflateSync(raw, { maxOutputLength: MAX_INFLATED }));
    } catch {
      return undefined;
    }
  };
  const attachments: { name: string; bytes: Uint8Array }[] = [];
  for (const { body } of objects.values()) {
    const embedded = /\/EF\s*<<[^>]*?\/(?:UF|F)\s+(\d+\s+\d+)\s+R/.exec(body);
    const name = /\/UF\s*\(([^)]*)\)/.exec(body)?.[1] ?? /\/F\s*\(([^)]*)\)/.exec(body)?.[1];
    if (!embedded || !name) continue;
    const content = stream(embedded[1]!);
    if (content) attachments.push({ name, bytes: content });
  }
  return attachments;
}

/** Whether a PDF carries a signature dictionary. Presence only: the signature itself is
 * verified by ANAF when the document is filed. */
export function pdfHasSignature(bytes: Uint8Array) {
  const text = Buffer.from(bytes).toString('latin1');
  return /\/Type\s*\/Sig\b/.test(text) && /\/ByteRange\s*\[/.test(text);
}
