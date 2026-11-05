// The local copies of the source register's snapshots (.sources/, never committed) and the
// clause excerpts a review packet shows from them. A missing copy, a copy whose bytes no longer
// hash as registered, or an anchor that does not resolve gives "excerpt unavailable" with the
// reason: the packet is still generated.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Anchor, PacketItem } from '../../packages/xfactura-core/src/ro/reviews';

export const repositoryRoot = path.join(import.meta.dir, '../..');
export const sourcesDirectory = path.join(repositoryRoot, '.sources');

export const sha256 = (bytes: Uint8Array | string) =>
  new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

type Located = { path: string; sha256: string } | { unavailable: string };

/** Where scripts/sources/fetch.ts writes a source's snapshot. */
const directoryOf = (sourceId: string, root: string) =>
  path.join(root, sourceId.replace(/[^\w.-]+/g, '_'));

const hashes = new Map<string, string>();
const hashOfFile = (file: string) => {
  let hash = hashes.get(file);
  if (!hash) hashes.set(file, (hash = sha256(readFileSync(file))));
  return hash;
};

/** The local file holding a registered snapshot: at its fetched place, else any file in the
 * source's directory or the inbox with the registered hash. */
export function locateSnapshot(
  sourceId: string,
  snapshot: { url: string; sha256: string },
  root = sourcesDirectory,
): Located {
  if (!existsSync(root)) return { unavailable: 'snapshot missing (no .sources/ directory)' };
  const directory = directoryOf(sourceId, root);
  const expected = path.join(directory, path.basename(new URL(snapshot.url).pathname));
  const candidates = [
    expected,
    ...[directory, path.join(root, 'inbox')].flatMap((folder) =>
      existsSync(folder)
        ? readdirSync(folder)
            .map((name) => path.join(folder, name))
            .filter((file) => statSync(file).isFile())
        : [],
    ),
  ];
  for (const file of candidates)
    if (existsSync(file) && hashOfFile(file) === snapshot.sha256)
      return { path: file, sha256: snapshot.sha256 };
  return existsSync(expected)
    ? { unavailable: 'snapshot differs from its registered hash (drift to review)' }
    : { unavailable: 'snapshot missing' };
}

const entities: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  laquo: '«',
  raquo: '»',
  bdquo: '„',
  rdquo: '”',
  ldquo: '“',
  ndash: '–',
  mdash: '—',
};

/** One line per block, whitespace collapsed within lines, empty lines dropped. */
const tidy = (text: string) =>
  text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');

export function htmlText(html: string) {
  return tidy(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|table|button|title)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) =>
        name[0] === '#'
          ? String.fromCodePoint(
              name[1] === 'x' || name[1] === 'X'
                ? parseInt(name.slice(2), 16)
                : parseInt(name.slice(1), 10),
            )
          : (entities[name.toLowerCase()] ?? match),
      ),
  );
}

const texts = new Map<string, string | { unavailable: string }>();

/** A snapshot's plain text, by its media type. PDFs need poppler's `pdftotext`. */
export function snapshotText(file: string, mediaType: string): string | { unavailable: string } {
  const cached = texts.get(file);
  if (cached) return cached;
  let text: string | { unavailable: string };
  if (mediaType === 'text/html') text = htmlText(readFileSync(file, 'utf8'));
  else if (mediaType.startsWith('text/') || mediaType === 'application/xml')
    text = tidy(readFileSync(file, 'utf8'));
  else if (mediaType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    // A workbook's text: its shared strings, one per line, in the workbook's order.
    const result = spawnSync('unzip', ['-p', file, 'xl/sharedStrings.xml'], {
      maxBuffer: 256 * 1024 * 1024,
    });
    text =
      result.error || result.status !== 0
        ? {
            unavailable: result.error
              ? 'no unzip to read the workbook'
              : `unzip failed (${result.status})`,
          }
        : tidy(
            [...result.stdout.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)]
              .map((item) => htmlText(item[1]!.replace(/<[^>]+>/g, '')))
              .join('\n'),
          );
  } else if (mediaType === 'application/pdf') {
    const result = spawnSync('pdftotext', ['-enc', 'UTF-8', file, '-'], {
      maxBuffer: 256 * 1024 * 1024,
    });
    text =
      result.error || result.status !== 0
        ? {
            unavailable: result.error
              ? 'no PDF text extractor (install poppler for pdftotext)'
              : `pdftotext failed (${result.status})`,
          }
        : tidy(result.stdout.toString('utf8'));
  } else text = { unavailable: `no text extraction for ${mediaType}` };
  texts.set(file, text);
  return text;
}

/** The excerpt between the anchors, with the text's line breaks; or why there is none. */
export function excerptOf(
  text: string,
  anchors: readonly Anchor[],
): { text: string } | { unavailable: string } {
  const flat = text.replaceAll('\n', ' ');
  const pieces: string[] = [];
  for (const anchor of anchors) {
    const start = flat.indexOf(anchor.from);
    if (start < 0) return { unavailable: `anchor not found: «${anchor.from.slice(0, 60)}»` };
    if (flat.indexOf(anchor.from, start + 1) >= 0)
      return { unavailable: `anchor not unique: «${anchor.from.slice(0, 60)}»` };
    const end = flat.indexOf(anchor.to, start);
    if (end < 0) return { unavailable: `end anchor not found: «${anchor.to.slice(0, 60)}»` };
    if (end + anchor.to.length - start > 20_000)
      return { unavailable: `anchor range too long: «${anchor.from.slice(0, 60)}»` };
    pieces.push(text.slice(start, end + anchor.to.length));
  }
  return { text: pieces.join('\n[…]\n') };
}

export interface Excerpt {
  clause: string;
  shown: boolean;
  /** The excerpt, or why it is unavailable. */
  text: string;
  /** SHA-256 of the excerpt text; null when none. */
  sha256: string | null;
  /** SHA-256 of the snapshot file read; null when none was. */
  snapshotSha256: string | null;
}

/** The excerpt of every source of the items, from the local snapshots. */
export function excerptsFor(
  items: readonly PacketItem[],
  mediaTypeOf: (sourceId: string, sha: string) => string | undefined,
  root = sourcesDirectory,
): Excerpt[] {
  const seen = new Set<string>();
  const result: Excerpt[] = [];
  for (const item of items)
    for (const source of item.sources) {
      if (seen.has(source.clause)) continue;
      seen.add(source.clause);
      const unavailable = (reason: string, snapshotSha256: string | null = null): Excerpt => ({
        clause: source.clause,
        shown: false,
        text: `excerpt unavailable: ${reason}`,
        sha256: null,
        snapshotSha256,
      });
      if (source.status === 'pending' || !source.snapshots.length) {
        result.push(unavailable('the clause is pending: its source has no registered snapshot'));
        continue;
      }
      if (!source.anchors) {
        result.push(unavailable('no anchor recorded for this clause (src/ro/reviews/anchors.ts)'));
        continue;
      }
      let outcome: Excerpt | undefined;
      let reason = 'snapshot missing';
      for (const snapshot of source.snapshots) {
        const located = locateSnapshot(source.source, snapshot, root);
        if ('unavailable' in located) {
          reason = located.unavailable;
          continue;
        }
        const text = snapshotText(
          located.path,
          mediaTypeOf(source.source, snapshot.sha256) ?? 'application/octet-stream',
        );
        if (typeof text !== 'string') {
          outcome = unavailable(text.unavailable, located.sha256);
          continue;
        }
        const excerpt = excerptOf(text, source.anchors);
        const found: Excerpt =
          'text' in excerpt
            ? {
                clause: source.clause,
                shown: true,
                text: excerpt.text,
                sha256: sha256(excerpt.text),
                snapshotSha256: located.sha256,
              }
            : unavailable(excerpt.unavailable, located.sha256);
        outcome = found;
        if (found.shown) break;
      }
      result.push(outcome ?? unavailable(reason));
    }
  return result;
}
