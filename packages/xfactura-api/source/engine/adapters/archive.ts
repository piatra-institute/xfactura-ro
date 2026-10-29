// Reads e-Factura archives as ANAF delivers them (the invoice XML and the Ministry's XMLDSig
// signature; for rejected uploads, an error report), with bounds on size, expansion and paths.
import { fromBufferPromise } from 'yauzl';
import { crc32 } from 'node:zlib';
import { extname, posix } from 'node:path';
import { DomainError, requireCondition } from 'xfactura-core/errors';
import { sourceXml } from 'xfactura-core/xml';

export const archiveLimits = Object.freeze({
  compressedBytes: 10 * 1024 * 1024,
  members: 100,
  memberBytes: 10 * 1024 * 1024,
  expandedBytes: 40 * 1024 * 1024,
  expansionRatio: 200,
});
/** What a member of an e-Factura archive is: the invoice XML, the Ministry's signature over it,
 * other XML (an error report), or a PDF. */
export type ArchiveMemberKind = 'invoice' | 'signature' | 'supporting_xml' | 'attachment';
export type ParsedArchiveMember = {
  path: string;
  filename: string;
  mediaType: string;
  bytes: Buffer;
  compressedSize: number;
  compressionMethod: 0 | 8;
  crc32: number;
  kind: ArchiveMemberKind;
  /** The root element of an XML member, e.g. Invoice or header (an error report). */
  root?: string;
};

const zipMagic = (bytes: Uint8Array) =>
  bytes.length >= 4 &&
  bytes[0] === 0x50 &&
  bytes[1] === 0x4b &&
  ((bytes[2] === 3 && bytes[3] === 4) ||
    (bytes[2] === 5 && bytes[3] === 6) ||
    (bytes[2] === 7 && bytes[3] === 8));

function memberPath(path: string, directory: boolean) {
  const segments = (directory ? path.slice(0, -1) : path).split('/');
  requireCondition(
    path.length <= 512 &&
      path === path.normalize('NFC') &&
      !/[\\:\p{Cc}\p{Cf}\ufffd]/u.test(path) &&
      !path.startsWith('/') &&
      segments.length <= 12 &&
      segments.every(
        (part) =>
          part !== '' &&
          part !== '.' &&
          part !== '..' &&
          part === part.trim() &&
          !part.endsWith('.'),
      ) &&
      posix.basename(path).length <= 240,
    'ARCHIVE_PATH',
    'Arhiva conține o cale invalidă sau ambiguă.',
  );
  return segments.join('/').toLowerCase();
}

function classify(
  member: Omit<ParsedArchiveMember, 'kind' | 'root' | 'mediaType'>,
): ParsedArchiveMember {
  requireCondition(
    !zipMagic(member.bytes) && !/\.(zip|gz|tar|7z|rar)$/i.test(member.path),
    'ARCHIVE_NESTED',
    'Arhivele imbricate nu sunt acceptate.',
  );
  const extension = extname(member.path).toLowerCase();
  if (extension === '.xml') {
    const root = sourceXml(member.bytes);
    if (root.local === 'Invoice' || root.local === 'CreditNote')
      return { ...member, mediaType: 'application/xml', kind: 'invoice', root: root.local };
    return {
      ...member,
      mediaType: 'application/xml',
      root: root.local,
      kind:
        root.local === 'Signature' && root.uri === 'http://www.w3.org/2000/09/xmldsig#'
          ? 'signature'
          : 'supporting_xml',
    };
  }
  if (extension === '.p7s' || extension === '.p7m')
    return {
      ...member,
      mediaType: extension === '.p7s' ? 'application/pkcs7-signature' : 'application/pkcs7-mime',
      kind: 'signature',
    };
  requireCondition(
    extension === '.pdf' && member.bytes.subarray(0, 5).toString('ascii') === '%PDF-',
    'ARCHIVE_MEMBER_TYPE',
    'Sunt acceptate numai XML, PDF și semnături P7S/P7M.',
  );
  return { ...member, mediaType: 'application/pdf', kind: 'attachment' };
}

/** Read central-directory metadata and bounded streams; never extract a path to disk. */
export async function parseInvoiceArchive(bytes: Uint8Array): Promise<ParsedArchiveMember[]> {
  requireCondition(
    bytes.length > 0 && bytes.length <= archiveLimits.compressedBytes,
    'ARCHIVE_SIZE',
    'Arhiva depășește limita de 10 MB.',
  );
  requireCondition(zipMagic(bytes), 'ARCHIVE_FORMAT', 'Documentul nu este o arhivă ZIP acceptată.');
  let zip: Awaited<ReturnType<typeof fromBufferPromise>> | undefined;
  try {
    zip = await fromBufferPromise(Buffer.from(bytes), {
      strictFileNames: true,
      validateEntrySizes: true,
    });
    requireCondition(
      zip.entryCount > 0 && zip.entryCount <= archiveLimits.members,
      'ARCHIVE_MEMBER_LIMIT',
      'Arhiva trebuie să conțină între 1 și 100 de elemente.',
    );
    const seen = new Set<string>(),
      members: ParsedArchiveMember[] = [];
    let expanded = 0,
      count = 0;
    for await (const entry of zip.eachEntry()) {
      requireCondition(
        ++count <= archiveLimits.members,
        'ARCHIVE_MEMBER_LIMIT',
        'Arhiva conține prea multe elemente.',
      );
      const directory = entry.fileName.endsWith('/'),
        pathKey = memberPath(entry.fileName, directory),
        type = (entry.externalFileAttributes >>> 16) & 0xf000;
      requireCondition(
        !seen.has(pathKey),
        'ARCHIVE_DUPLICATE_PATH',
        'Arhiva conține căi duplicate sau ambigue.',
      );
      seen.add(pathKey);
      requireCondition(
        (type === 0 || (type === 0x8000 && !directory) || (type === 0x4000 && directory)) &&
          !entry.isEncrypted(),
        'ARCHIVE_MEMBER',
        'Legăturile, fișierele speciale și criptarea nu sunt acceptate.',
      );
      requireCondition(
        entry.compressionMethod === 0 || entry.compressionMethod === 8,
        'ARCHIVE_COMPRESSION',
        'Metoda de compresie nu este acceptată.',
      );
      if (directory) {
        requireCondition(
          entry.uncompressedSize === 0 && entry.compressedSize <= 2 && entry.crc32 === 0,
          'ARCHIVE_DIRECTORY',
          'Un director din arhivă conține date.',
        );
        const stream = await zip.openReadStreamPromise(entry);
        try {
          for await (const chunk of stream)
            requireCondition(
              chunk.length === 0,
              'ARCHIVE_DIRECTORY',
              'Un director din arhivă conține date.',
            );
        } finally {
          stream.destroy();
        }
        continue;
      }
      requireCondition(
        entry.uncompressedSize > 0 &&
          entry.uncompressedSize <= archiveLimits.memberBytes &&
          expanded + entry.uncompressedSize <= archiveLimits.expandedBytes &&
          entry.uncompressedSize <=
            Math.max(1, entry.compressedSize) * archiveLimits.expansionRatio,
        'ARCHIVE_EXPANSION_LIMIT',
        'Dimensiunea decomprimată sau raportul de compresie depășește limita.',
      );
      const stream = await zip.openReadStreamPromise(entry),
        chunks: Buffer[] = [];
      let size = 0,
        crc = 0;
      try {
        for await (const raw of stream) {
          const chunk = Buffer.from(raw as Uint8Array);
          size += chunk.length;
          requireCondition(
            size <= entry.uncompressedSize &&
              size <= archiveLimits.memberBytes &&
              expanded + size <= archiveLimits.expandedBytes,
            'ARCHIVE_EXPANSION_LIMIT',
            'Conținutul decomprimat depășește limita declarată.',
          );
          crc = crc32(chunk, crc);
          chunks.push(chunk);
        }
      } finally {
        stream.destroy();
      }
      requireCondition(
        size === entry.uncompressedSize && crc === entry.crc32,
        'ARCHIVE_INTEGRITY',
        'Dimensiunea sau suma CRC a unui fișier nu corespunde arhivei.',
      );
      expanded += size;
      try {
        members.push(
          classify({
            path: entry.fileName,
            filename: posix.basename(entry.fileName),
            bytes: Buffer.concat(chunks, size),
            compressedSize: entry.compressedSize,
            compressionMethod: entry.compressionMethod,
            crc32: crc,
          }),
        );
      } catch (error) {
        if (error instanceof DomainError)
          throw new DomainError(error.code, `${entry.fileName}: ${error.message}`, error.status);
        throw new DomainError(
          'ARCHIVE_XML',
          `${entry.fileName}: structura documentului XML nu este acceptată.`,
        );
      }
    }
    requireCondition(
      count === zip.entryCount && members.length > 0,
      'ARCHIVE_EMPTY',
      'Arhiva nu conține fișiere utilizabile.',
    );
    return members.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('ARCHIVE_INVALID', 'Arhiva ZIP este invalidă, trunchiată sau coruptă.');
  } finally {
    zip?.close();
  }
}
