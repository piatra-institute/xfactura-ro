import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { readD406, type D406Filed } from 'xfactura-core/ro/saft/read';
import { pdfAttachments } from '../../../xfactura-api/source/engine/adapters/pdf-attachments';
import { ComparisonError, fail, order } from './differences';
import { amount } from './decimal';
import { filedPeriod, sourceAccounts } from './filed';
import { fiscalIdentity, manifestD406Files } from './source-chain-manifest';
import { checkSourceChain } from './source-chain';

/** Read-only corpus check. Only counts leave this function; no real identifiers, paths,
 * amounts, parser messages or findings are written or printed. */
export async function sourceChainCounts(input: string, fiscalCode?: string) {
  const root = resolve(input);
  if (!root.split(sep).includes('.private'))
    fail('SOURCE_CHAIN_PRIVATE', 'Verificarea corpusului necesită un director din .private.');
  const declarations: D406Filed[] = [];
  const periods = new Map<string, string>();
  const hashes = new Set<string>();
  let duplicates = 0;
  let filesRead = 0;
  const read = (bytes: Uint8Array) => {
    if (!new TextDecoder().decode(bytes).includes('mfp:anaf:dgti:d406:declaratie:v1')) {
      if (fiscalCode !== undefined)
        fail('SOURCE_CHAIN_FORMAT', 'Fișierul selectat nu este o declarație D406.');
      return;
    }
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hashes.has(hash)) {
      duplicates++;
      return;
    }
    hashes.add(hash);
    let filed: D406Filed;
    try {
      filed = readD406(bytes);
    } catch {
      fail('SOURCE_CHAIN_READ', 'O declarație D406 nu a putut fi citită.');
    }
    if (fiscalCode !== undefined) {
      const code =
        filed.header.company.taxRegistrations[0]?.registrationNumber ??
        filed.header.company.registrationNumber;
      if (code === undefined || fiscalIdentity(code) !== fiscalIdentity(fiscalCode))
        fail(
          'SOURCE_CHAIN_COMPANY',
          'Identitatea declarației nu corespunde selecției din manifest.',
        );
    }
    const period = filedPeriod(filed).period;
    // A re-filing is equivalent for the chain only when every raw account and balance side
    // is unchanged. Preserve missing and dual-side declarations; never net them for identity.
    const facts = [...sourceAccounts(filed)]
      .sort(([a], [b]) => order(a, b))
      .map(([id, account]) => [
        id,
        ...(['openingDebit', 'openingCredit', 'closingDebit', 'closingCredit'] as const).map(
          (field) =>
            account[field] === undefined
              ? null
              : (amount(account[field]) ?? ['invalid', account[field]]),
        ),
      ]);
    const signature = JSON.stringify([
      filed.header.company.registrationNumber ?? null,
      filed.header.totalSegments ?? null,
      filed.header.segmentIndex ?? null,
      facts,
    ]);
    const previous = periods.get(period);
    if (previous !== undefined) {
      if (previous !== signature)
        fail(
          'SOURCE_CHAIN_PERIOD_CONFLICT',
          'Declarațiile pentru același interval conțin solduri sau conturi diferite.',
        );
      duplicates++;
      return;
    }
    periods.set(period, signature);
    // The check needs only account balances and reporting identity; discard the other private data.
    declarations.push({
      ...filed,
      header: {
        ...filed.header,
        company: {
          registrationNumber: filed.header.company.registrationNumber,
          taxRegistrations: [],
          ibans: [],
        },
      },
      masterFiles: {
        accounts: filed.masterFiles.accounts,
        customers: [],
        suppliers: [],
        taxTable: [],
        units: [],
        products: [],
      },
      generalLedgerEntries: { journals: [] },
      sourceDocuments: {},
      unread: [],
    });
  };
  const walk = async (path: string) => {
    const info = await lstat(path);
    if (info.isSymbolicLink())
      fail('SOURCE_CHAIN_SYMLINK', 'Corpusul nu poate conține legături simbolice.');
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort(order)) await walk(join(path, name));
    } else if (info.isFile() && ['.xml', '.pdf'].includes(extname(path).toLowerCase())) {
      filesRead++;
      const bytes = await readFile(path);
      if (extname(path).toLowerCase() === '.xml') read(bytes);
      else {
        let attachments: ReturnType<typeof pdfAttachments>;
        try {
          attachments = pdfAttachments(bytes);
        } catch {
          fail('SOURCE_CHAIN_PDF', 'Anexele unui fișier PDF nu au putut fi citite.');
        }
        for (const attachment of attachments) read(attachment.bytes);
      }
    }
  };
  if (fiscalCode === undefined) await walk(root);
  else {
    for (const file of await manifestD406Files(root, fiscalCode)) {
      const bytes = await readFile(file.path);
      filesRead++;
      if (createHash('sha256').update(bytes).digest('hex') !== file.sha256)
        fail('SOURCE_CHAIN_MANIFEST_HASH', 'Conținutul fișierului diferă de manifest.');
      if (extname(file.path).toLowerCase() === '.xml') {
        if (!file.attachments.has(null))
          fail('SOURCE_CHAIN_MANIFEST', 'Manifestul atribuie o anexă unui fișier XML.');
        read(bytes);
      } else if (extname(file.path).toLowerCase() === '.pdf') {
        let attachments: ReturnType<typeof pdfAttachments>;
        try {
          attachments = pdfAttachments(bytes);
        } catch {
          fail('SOURCE_CHAIN_PDF', 'Anexele unui fișier PDF nu au putut fi citite.');
        }
        for (const name of file.attachments) {
          const matching = attachments.filter((attachment) => attachment.name === name);
          if (matching.length !== 1)
            fail(
              'SOURCE_CHAIN_MANIFEST_ATTACHMENT',
              'Anexa selectată lipsește sau nu are identitate unică.',
            );
          read(matching[0]!.bytes);
        }
      } else fail('SOURCE_CHAIN_FORMAT', 'Manifestul nu indică un fișier XML sau PDF.');
    }
  }
  if (!declarations.length) fail('SOURCE_CHAIN_EMPTY', 'Nu există declarații D406 în director.');
  return {
    filesRead,
    declarations: declarations.length,
    duplicates,
    ...checkSourceChain(declarations).counts,
  };
}

if (import.meta.main) {
  try {
    const arguments_ = process.argv.slice(2);
    const results = [];
    if (arguments_[0] === '--manifest') {
      const [, manifest, ...codes] = arguments_;
      if (!manifest || !codes.length)
        fail('SOURCE_CHAIN_ARGUMENTS', 'Indicați manifestul și codurile fiscale ale companiilor.');
      for (const code of codes) results.push(await sourceChainCounts(manifest, code));
    } else {
      if (!arguments_.length)
        fail(
          'SOURCE_CHAIN_ARGUMENTS',
          'Indicați directoarele private ale corpusului sau manifestul și codurile fiscale.',
        );
      for (const directory of arguments_) results.push(await sourceChainCounts(directory));
    }
    console.log(JSON.stringify(results, null, 2));
  } catch (error) {
    console.error(error instanceof ComparisonError ? error.code : 'SOURCE_CHAIN_IO');
    process.exitCode = 1;
  }
}
