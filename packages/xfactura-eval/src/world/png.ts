import { deflateSync } from 'node:zlib';

/*
 * A photographed receipt for the worlds: text printed in a 5×7 bitmap font onto a grayscale
 * PNG. The image has no text layer, so the engine reads it as `vision` and only an agent's own
 * vision model can read it, as with a real photo. Written by hand so the bytes are the same on
 * every machine.
 */

const glyphs: Record<string, string> = {
  A: '.###. #...# #...# ##### #...# #...# #...#',
  B: '####. #...# #...# ####. #...# #...# ####.',
  C: '.###. #...# #.... #.... #.... #...# .###.',
  D: '###.. #..#. #...# #...# #...# #..#. ###..',
  E: '##### #.... #.... ####. #.... #.... #####',
  F: '##### #.... #.... ####. #.... #.... #....',
  G: '.###. #...# #.... #.### #...# #...# .####',
  H: '#...# #...# #...# ##### #...# #...# #...#',
  I: '.###. ..#.. ..#.. ..#.. ..#.. ..#.. .###.',
  J: '..### ...#. ...#. ...#. ...#. #..#. .##..',
  K: '#...# #..#. #.#.. ##... #.#.. #..#. #...#',
  L: '#.... #.... #.... #.... #.... #.... #####',
  M: '#...# ##.## #.#.# #.#.# #...# #...# #...#',
  N: '#...# #...# ##..# #.#.# #..## #...# #...#',
  O: '.###. #...# #...# #...# #...# #...# .###.',
  P: '####. #...# #...# ####. #.... #.... #....',
  Q: '.###. #...# #...# #...# #.#.# #..#. .##.#',
  R: '####. #...# #...# ####. #.#.. #..#. #...#',
  S: '.#### #.... #.... .###. ....# ....# ####.',
  T: '##### ..#.. ..#.. ..#.. ..#.. ..#.. ..#..',
  U: '#...# #...# #...# #...# #...# #...# .###.',
  V: '#...# #...# #...# #...# #...# .#.#. ..#..',
  W: '#...# #...# #...# #.#.# #.#.# #.#.# .#.#.',
  X: '#...# #...# .#.#. ..#.. .#.#. #...# #...#',
  Y: '#...# #...# .#.#. ..#.. ..#.. ..#.. ..#..',
  Z: '##### ....# ...#. ..#.. .#... #.... #####',
  '0': '.###. #...# #..## #.#.# ##..# #...# .###.',
  '1': '..#.. .##.. ..#.. ..#.. ..#.. ..#.. .###.',
  '2': '.###. #...# ....# ...#. ..#.. .#... #####',
  '3': '##### ...#. ..#.. ...#. ....# #...# .###.',
  '4': '...#. ..##. .#.#. #..#. ##### ...#. ...#.',
  '5': '##### #.... ####. ....# ....# #...# .###.',
  '6': '..##. .#... #.... ####. #...# #...# .###.',
  '7': '##### ....# ...#. ..#.. .#... .#... .#...',
  '8': '.###. #...# #...# .###. #...# #...# .###.',
  '9': '.###. #...# #...# .#### ....# ...#. .##..',
  '.': '..... ..... ..... ..... ..... .##.. .##..',
  ',': '..... ..... ..... ..... .##.. ..#.. .#...',
  ':': '..... .##.. .##.. ..... .##.. .##.. .....',
  '-': '..... ..... ..... ##### ..... ..... .....',
  '/': '..... ....# ...#. ..#.. .#... #.... .....',
  '%': '##... ##..# ...#. ..#.. .#... #..## ...##',
  '*': '..... ..#.. #.#.# .###. #.#.# ..#.. .....',
  '=': '..... ..... ##### ..... ##### ..... .....',
  '#': '.#.#. .#.#. ##### .#.#. ##### .#.#. .#.#.',
  '(': '...#. ..#.. .#... .#... .#... ..#.. ...#.',
  ')': '.#... ..#.. ...#. ...#. ...#. ..#.. .#...',
  '+': '..... ..#.. ..#.. ##### ..#.. ..#.. .....',
  ' ': '..... ..... ..... ..... ..... ..... .....',
};
/** Romanian letters a receipt printer prints without their marks. */
const plain: Record<string, string> = { Ă: 'A', Â: 'A', Î: 'I', Ș: 'S', Ş: 'S', Ț: 'T', Ţ: 'T' };

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** A grayscale PNG of `lines`, each character a 5×7 glyph scaled `scale` times. */
export function receiptPng(lines: string[], scale = 3): Uint8Array {
  const columns = Math.max(...lines.map((line) => line.length));
  const cellWidth = 6 * scale;
  const cellHeight = 10 * scale;
  const margin = 4 * cellWidth;
  const width = columns * cellWidth + 2 * margin;
  const height = lines.length * cellHeight + 2 * margin;
  const paper = 244;
  const ink = 28;
  const rows = Array.from({ length: height }, () => new Uint8Array(width + 1).fill(paper));
  rows.forEach((row) => (row[0] = 0)); // filter type: none
  lines.forEach((line, lineIndex) => {
    [...line.toUpperCase()].forEach((character, column) => {
      const glyph = glyphs[plain[character] ?? character];
      if (!glyph) throw new Error(`The receipt font has no glyph for ${character}`);
      glyph.split(' ').forEach((bits, y) => {
        [...bits].forEach((bit, x) => {
          if (bit !== '#') return;
          for (let dy = 0; dy < scale; dy++)
            for (let dx = 0; dx < scale; dx++)
              rows[margin + lineIndex * cellHeight + y * scale + dy]![
                1 + margin + column * cellWidth + x * scale + dx
              ] = ink;
        });
      });
    });
  });
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 0, 0, 0, 0], 8); // 8-bit grayscale, deflate, no interlace
  const raw = Buffer.concat(rows);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', new Uint8Array()),
    ]),
  );
}
