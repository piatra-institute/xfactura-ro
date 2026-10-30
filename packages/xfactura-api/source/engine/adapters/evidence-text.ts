/**
 * What an evidence file is, judged from its bytes rather than the media type it was declared
 * with, and the lines of the text ones. Pure: no I/O.
 */

export const evidenceFormats = ['pdf', 'image', 'xml', 'csv', 'text', 'binary'] as const;
export type EvidenceFormat = (typeof evidenceFormats)[number];

export const textEncodings = ['utf-8', 'utf-16le', 'utf-16be', 'windows-1250'] as const;
export type TextEncoding = (typeof textEncodings)[number];

/** The text-file reader's version; line numbers of text files hold for it. */
export const textFileExtractor = 'text-file.1';

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  signature.every((byte, index) => bytes[offset + index] === byte);
const ascii = (bytes: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...bytes.subarray(from, to));

const images: readonly (readonly number[])[] = [
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF
  [0x49, 0x49, 0x2a, 0x00], // TIFF, little-endian
  [0x4d, 0x4d, 0x00, 0x2a], // TIFF, big-endian
  [0x42, 0x4d], // BMP
];
/** ISO media files (`ftyp` box) whose brand is an image: HEIC, HEIF, AVIF. */
const imageBrands = ['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1', 'avif', 'avis'];
const binaries: readonly (readonly number[])[] = [
  [0x50, 0x4b, 0x03, 0x04], // ZIP (also XLSX, DOCX, ODS)
  [0x50, 0x4b, 0x05, 0x06], // empty ZIP
  [0x1f, 0x8b], // gzip
  [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], // OLE2 (XLS, DOC, MSG)
  [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], // 7z
  [0x52, 0x61, 0x72, 0x21], // RAR
];

/** The PDF header may follow up to 1024 bytes of anything, as readers accept it. */
export const isPdf = (bytes: Uint8Array) =>
  Buffer.from(bytes.subarray(0, 1024)).includes('%PDF-', 0, 'latin1');

/**
 * Decodes text without guessing wildly:
 * - a byte order mark decides (UTF-8, UTF-16 LE or BE);
 * - otherwise valid UTF-8 is UTF-8 (ASCII included);
 * - otherwise Windows-1250, which Romanian banks' exports often use, if it reads as text: none
 *   of its five undefined bytes, no NUL;
 * - anything else, or NUL in UTF-8, is not text (undefined).
 */
export function decodeText(
  bytes: Uint8Array,
): { encoding: TextEncoding; text: string } | undefined {
  if (startsWith(bytes, [0xef, 0xbb, 0xbf]))
    return { encoding: 'utf-8', text: new TextDecoder('utf-8').decode(bytes.subarray(3)) };
  if (startsWith(bytes, [0xff, 0xfe]))
    return { encoding: 'utf-16le', text: new TextDecoder('utf-16le').decode(bytes.subarray(2)) };
  if (startsWith(bytes, [0xfe, 0xff]))
    return { encoding: 'utf-16be', text: new TextDecoder('utf-16be').decode(bytes.subarray(2)) };
  if (bytes.includes(0)) return undefined;
  try {
    return { encoding: 'utf-8', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    // Not UTF-8: try Windows-1250 below.
  }
  const text = new TextDecoder('windows-1250').decode(bytes);
  // The WHATWG decoder maps the undefined bytes 0x81, 0x83, 0x88, 0x90, 0x98 to C1 controls.
  if (/[\u0080-\u009f]/.test(text)) return undefined;
  return { encoding: 'windows-1250', text };
}

/** The format of a file, from its leading bytes; text formats from its first character, its
 * declared media type and its name. */
export function sniffFormat(
  bytes: Uint8Array,
  mediaType: string,
  filename: string,
): EvidenceFormat {
  if (isPdf(bytes)) return 'pdf';
  if (images.some((signature) => startsWith(bytes, signature))) return 'image';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && ascii(bytes, 8, 12) === 'WEBP') return 'image';
  if (ascii(bytes, 4, 8) === 'ftyp' && imageBrands.includes(ascii(bytes, 8, 12))) return 'image';
  if (binaries.some((signature) => startsWith(bytes, signature))) return 'binary';
  const decoded = decodeText(bytes.subarray(0, 64 * 1024));
  // A cut through a multibyte character at the sample's end is not a reason to refuse it.
  if (!decoded && !decodeText(bytes)) return 'binary';
  const start = (decoded?.text ?? '').trimStart();
  if (start.startsWith('<')) return 'xml';
  if (/csv/i.test(mediaType) || /\.csv$/i.test(filename)) return 'csv';
  return 'text';
}

/** A line longer than this many characters is broken: between tags in XML, else in parts. */
export const longLine = 1000;

/**
 * The lines of a text file, numbered as in the file: split at CRLF, CR or LF, empty lines kept,
 * the empty line after a final line break dropped. XML lines longer than `longLine` (a file on
 * one line, as e-Factura's often are) are broken between tags, so their lines are the file's
 * after that break. Control characters other than tab become U+FFFD.
 */
export function textFileLines(text: string, format: EvidenceFormat): string[] {
  const lines = clean(text).split(/\r\n|\r|\n/);
  if (lines.at(-1) === '') lines.pop();
  if (format !== 'xml') return lines;
  return lines.flatMap((line) =>
    line.length > longLine ? line.replace(/>\s*</g, '>\n<').split('\n') : [line],
  );
}

/** Text as JSON carries it compactly and safely: well-formed, controls other than tab and
 * line breaks replaced. */
export const clean = (text: string) =>
  text.toWellFormed().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '�');

/** The image formats an agent may receive (`evidence.read`, mode `image`): those the common
 * vision models accept. HEIC, AVIF, TIFF and BMP are not among them. */
export const visionImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
export type VisionImageType = (typeof visionImageTypes)[number];

/** An image's format from its leading bytes: a vision type, another image format, or null. */
export function imageType(bytes: Uint8Array): VisionImageType | 'heic' | 'tiff' | 'bmp' | null {
  if (startsWith(bytes, images[0]!)) return 'image/png';
  if (startsWith(bytes, images[1]!)) return 'image/jpeg';
  if (startsWith(bytes, images[2]!)) return 'image/gif';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && ascii(bytes, 8, 12) === 'WEBP')
    return 'image/webp';
  if (startsWith(bytes, images[3]!) || startsWith(bytes, images[4]!)) return 'tiff';
  if (startsWith(bytes, images[5]!)) return 'bmp';
  if (ascii(bytes, 4, 8) === 'ftyp' && imageBrands.includes(ascii(bytes, 8, 12))) return 'heic';
  return null;
}

/** An image's pixel dimensions, read from its header without decoding it; null when the header
 * does not say. */
export function imageSize(
  bytes: Uint8Array,
  type: VisionImageType,
): { width: number; height: number } | null {
  const u16be = (at: number) => (bytes[at]! << 8) | bytes[at + 1]!;
  const u16le = (at: number) => bytes[at]! | (bytes[at + 1]! << 8);
  const u24le = (at: number) => u16le(at) | (bytes[at + 2]! << 16);
  const u32be = (at: number) => u16be(at) * 65536 + u16be(at + 2);
  if (type === 'image/png')
    return bytes.length >= 24 && ascii(bytes, 12, 16) === 'IHDR'
      ? { width: u32be(16), height: u32be(20) }
      : null;
  if (type === 'image/gif')
    return bytes.length >= 10 ? { width: u16le(6), height: u16le(8) } : null;
  if (type === 'image/webp') {
    if (bytes.length < 30) return null;
    const chunk = ascii(bytes, 12, 16);
    if (chunk === 'VP8 ') return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    if (chunk === 'VP8L')
      return {
        width: 1 + (((bytes[22]! & 0x3f) << 8) | bytes[21]!),
        height: 1 + (((bytes[24]! & 0x0f) << 10) | (bytes[23]! << 2) | ((bytes[22]! & 0xc0) >> 6)),
      };
    if (chunk === 'VP8X') return { width: 1 + u24le(24), height: 1 + u24le(27) };
    return null;
  }
  // JPEG: the first start-of-frame marker (SOF0–SOF15, except DHT, JPG and DAC) holds the size.
  for (let at = 2; at + 9 < bytes.length;) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      at += 2;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return { width: u16be(at + 7), height: u16be(at + 5) };
    at += 2 + u16be(at + 2);
  }
  return null;
}
