import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import { inventorySummary } from '../../../scripts/differential/inventory';
import { pdfAttachments } from '../../xfactura-api/source/engine/adapters/pdf-attachments';
import { comparePaths } from '../src/corpus/files';
import { copyCorpus } from '../src/corpus/copy';
import { inventoryCorpus, type CorpusRecord } from '../src/corpus/inventory';
import { readReturnXml, xmlChunks, type ReturnXml } from '../src/corpus/xml';

const bytes = (value: string) => new TextEncoder().encode(value);
const d300 = bytes(
  '<declaratie300 xmlns="mfp:anaf:dgti:d300:declaratie:v12" cui="90000001" an="2026" luna="02"/>',
);
const d390 = bytes(
  '<declaratie390 xmlns="mfp:anaf:dgti:d390:declaratie:v3" cui="90000002" an="2025" luna="12" d_rec="1"/>',
);
const saftHeader = `<?xml version="1.0" encoding="UTF-8"?>
<s:AuditFile xmlns:s="mfp:anaf:dgti:d406:declaratie:v1">
<s:Header><s:Company><s:RegistrationNumber>RO90000001</s:RegistrationNumber>
<s:TaxRegistration><s:TaxRegistrationNumber>90000001</s:TaxRegistrationNumber></s:TaxRegistration>
</s:Company><s:SelectionCriteria><s:SelectionStartDate>2026-01-01</s:SelectionStartDate>
<s:SelectionEndDate>2026-03-31</s:SelectionEndDate></s:SelectionCriteria>
<s:HeaderComment>T</s:HeaderComment></s:Header>`;

function expectedXml(overrides: Partial<ReturnXml> = {}): ReturnXml {
  return {
    rootElement: 'declaratie300',
    namespace: 'mfp:anaf:dgti:d300:declaratie:v12',
    form: 'D300',
    version: '12',
    fiscalCode: '90000001',
    period: { year: '2026', month: '02', startDate: null, endDate: null },
    rectifying: null,
    declarationType: null,
    attachment: null,
    ...overrides,
  };
}

const expected390 = expectedXml({
  rootElement: 'declaratie390',
  namespace: 'mfp:anaf:dgti:d390:declaratie:v3',
  form: 'D390',
  version: '3',
  fiscalCode: '90000002',
  period: { year: '2025', month: '12', startDate: null, endDate: null },
  rectifying: true,
});
const expected406 = expectedXml({
  rootElement: 'AuditFile',
  namespace: 'mfp:anaf:dgti:d406:declaratie:v1',
  form: 'D406',
  version: '1',
  period: { year: null, month: null, startDate: '2026-01-01', endDate: '2026-03-31' },
  declarationType: 'T',
});

/** Real PDF structures and compressed attachments, with a synthetic signature dictionary
 * appended as in the engine's signed-declaration fixtures. No certificate is asserted. */
async function pdf(
  title: string,
  attachment?: Uint8Array,
  signed = false,
  options: { subject?: string; objectStreams?: boolean; attachmentName?: string } = {},
) {
  const document = await PDFDocument.create();
  document.addPage([200, 200]);
  document.setTitle(title);
  if (options.subject) document.setSubject(options.subject);
  if (attachment) await document.attach(attachment, options.attachmentName ?? 'return.xml');
  const content = await document.save({ useObjectStreams: options.objectStreams ?? false });
  return signed
    ? new Uint8Array(
        Buffer.concat([
          content,
          Buffer.from('\n99 0 obj\n<< /Type /Sig /ByteRange [0 1 2 3] >>\nendobj\n%%EOF\n'),
        ]),
      )
    : content;
}

let temporary: string;
let source: string;
let output: string;
beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'xfactura-replay-'));
  source = join(temporary, 'source');
  output = join(temporary, 'output');
  await mkdir(source);
});
afterEach(async () => {
  await rm(temporary, { recursive: true, force: true });
});

async function put(path: string, content: Uint8Array) {
  const target = join(source, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

function record(
  path: string,
  content: Uint8Array,
  kind: CorpusRecord['kind'],
  overrides: Partial<CorpusRecord> = {},
): CorpusRecord {
  return {
    path,
    size: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
    kind,
    returns: [],
    duplicateOf: null,
    excluded: [],
    problems: [],
    ...overrides,
  };
}

async function fixture() {
  const signed = await pdf('Synthetic filed return', d390, true);
  const annual = await pdf(
    'Synthetic statement',
    bytes(
      '<Bilant1003 xmlns="mfp:anaf:dgti:s1003:declaratie:v15" cui="90000001" an="2025" luna="12"/>',
    ),
  );
  const receipt = await pdf('Acknowledgement');
  const invoice = await pdf('Invoice rendering');
  const jar = bytes('PK\x03\x04synthetic validator');
  const inputs: [string, Uint8Array, CorpusRecord['kind'], Partial<CorpusRecord>?][] = [
    [
      'ANAF/100/signed.pdf',
      signed,
      'signed-return-pdf',
      { returns: [{ ...expected390, attachment: 'return.xml' }] },
    ],
    [
      'ANAF/112/payroll.xml',
      bytes(
        '<declaratieUnica xmlns="mfp:anaf:dgti:declaratie_unica:declaratie:v7" an_r="2026" luna_r="3" d_rec="0"><angajator cif="90000002"/></declaratieUnica>',
      ),
      'return-xml',
      {
        returns: [
          expectedXml({
            rootElement: 'declaratieUnica',
            namespace: 'mfp:anaf:dgti:declaratie_unica:declaratie:v7',
            form: 'D112',
            version: '7',
            fiscalCode: '90000002',
            period: { year: '2026', month: '3', startDate: null, endDate: null },
            rectifying: false,
          }),
        ],
      },
    ],
    ['ANAF/300/D300_90000999_2026_11.xml', d390, 'return-xml', { returns: [expected390] }],
    ['ANAF/300/failure.xml.err.txt', bytes('synthetic failed attempt'), 'failed-attempt'],
    ['ANAF/300/failure.xml.log', bytes('synthetic error log'), 'failed-attempt'],
    ['ANAF/300/return.xml', d300, 'return-xml', { returns: [expectedXml()] }],
    ['ANAF/300/unknown.xml', bytes('<unknown xmlns="urn:synthetic"/>'), 'other'],
    [
      'ANAF/406/saft.xml',
      bytes(`${saftHeader}<s:MasterFiles/></s:AuditFile>`),
      'd406',
      { returns: [expected406] },
    ],
    [
      'ANAF/BILANT/statement.pdf',
      annual,
      'annual-statement-pdf',
      {
        returns: [
          expectedXml({
            rootElement: 'Bilant1003',
            namespace: 'mfp:anaf:dgti:s1003:declaratie:v15',
            form: 'S1003',
            version: '15',
            period: { year: '2025', month: '12', startDate: null, endDate: null },
            attachment: 'return.xml',
          }),
        ],
      },
    ],
    ['ANAF/E-FACTURA 2025/invoice.pdf', invoice, 'efactura-pdf'],
    ['ANAF/JAVA/config.xml', bytes('<config/>'), 'validator-kit', { excluded: ['validator-kit'] }],
    ['ANAF/JAVA/tool.jar', jar, 'validator-kit', { excluded: ['validator-kit'] }],
    ['ANAF/recipisa/2026/receipt.pdf', receipt, 'receipt'],
    ['ANAF/unknown.bin', bytes('synthetic unknown data'), 'other'],
    [
      'ANAF/unreadable.pdf',
      bytes('%PDF-1.7\ninvalid structure'),
      'other',
      { problems: ['PDF_UNREADABLE'] },
    ],
    ['Baza de Date/Revisal/export.rvs', bytes('synthetic labour export'), 'revisal-export'],
    [
      'Baza de Date/Revisal/register.db',
      bytes('SQLite format 3\0synthetic register'),
      'revisal-export',
    ],
    [
      'Baza de Date/archive.zip',
      bytes('PK\x03\x04synthetic backup'),
      'accounting-database-archive',
    ],
    [
      'Baza de Date/older.rar',
      bytes('Rar!\x1a\x07synthetic backup'),
      'accounting-database-archive',
    ],
    [
      'Baza de Date/snapshot.bck',
      bytes('synthetic Firebird backup'),
      'accounting-database-archive',
    ],
    [
      'Z-copy/300/return.xml',
      d300,
      'return-xml',
      { returns: [expectedXml()], duplicateOf: 'ANAF/300/return.xml', excluded: ['duplicate'] },
    ],
    [
      'Z-copy/JAVA/tool.jar',
      jar,
      'validator-kit',
      { duplicateOf: 'ANAF/JAVA/tool.jar', excluded: ['validator-kit', 'duplicate'] },
    ],
  ];
  for (const [path, content] of inputs) await put(path, content);
  return inputs.map(([path, content, kind, overrides]) => record(path, content, kind, overrides));
}

async function tree(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(path.length + 1))
    .sort();
}

describe('corpus inventory and copy', () => {
  test('the full manifest records content, exclusions and unreadable PDFs; copy is idempotent', async () => {
    const expected = await fixture();
    const sourcePaths = await tree(source);
    const records = await inventoryCorpus(source);
    expect(records).toEqual(expected);
    const included = expected.filter((item) => item.excluded.length === 0);
    expect(await copyCorpus(source, output, [...records].reverse())).toEqual({
      copied: included.length,
      unchanged: 0,
      manifestChanged: true,
    });
    const manifestPath = join(output, 'manifest.json');
    const manifest = await readFile(manifestPath);
    const manifestStat = await lstat(manifestPath);
    expect(JSON.parse(manifest.toString('utf8'))).toEqual(expected);
    expect(await tree(output)).toEqual(
      [...included.map((item) => item.path), 'manifest.json'].sort(),
    );
    const copiedPath = join(output, 'ANAF/100/signed.pdf');
    const copiedStat = await lstat(copiedPath);
    const second = await inventoryCorpus(source);
    expect(second).toEqual(expected);
    expect(await copyCorpus(source, output, second)).toEqual({
      copied: 0,
      unchanged: included.length,
      manifestChanged: false,
    });
    expect(await readFile(manifestPath)).toEqual(manifest);
    expect((await lstat(manifestPath)).ino).toBe(manifestStat.ino);
    expect((await lstat(manifestPath)).mtimeMs).toBe(manifestStat.mtimeMs);
    expect((await lstat(copiedPath)).ino).toBe(copiedStat.ino);
    expect(await tree(source)).toEqual(sourcePaths);
    for (const item of included)
      expect(await readFile(join(output, item.path))).toEqual(
        await readFile(join(source, item.path)),
      );
    expect((await readdir(temporary)).sort()).toEqual(['output', 'source']);
    expect(await inventoryCorpus(source)).toEqual(expected);
  });

  test('dry CLI prints counts and writes nothing, including when the output is inside the source', async () => {
    const expected = await fixture();
    const dryOutput = join(source, 'must-not-exist');
    const child = Bun.spawn(
      [process.execPath, resolve('scripts/differential/inventory.ts'), source, dryOutput, '--dry'],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const stdout = await new Response(child.stdout).text();
    expect(await new Response(child.stderr).text()).toBe('');
    expect(await child.exited).toBe(0);
    const summary = JSON.parse(stdout);
    expect(summary.totalFiles).toBe(22);
    expect(summary.includedFiles).toBe(18);
    expect(summary.byKind).toEqual({
      'return-xml': 4,
      'signed-return-pdf': 1,
      receipt: 1,
      'annual-statement-pdf': 1,
      'efactura-pdf': 1,
      d406: 1,
      'revisal-export': 2,
      'accounting-database-archive': 3,
      'validator-kit': 3,
      'failed-attempt': 2,
      other: 3,
    });
    expect(summary.byFormAndVersion).toEqual({
      'D112 v7': 1,
      'D300 v12': 2,
      'D390 v3': 2,
      'D406 v1': 1,
      'S1003 v15': 1,
    });
    expect(summary.excludedFiles).toBe(4);
    expect(summary.excludedBytes).toBe(
      expected.filter((item) => item.excluded.length > 0).reduce((sum, item) => sum + item.size, 0),
    );
    expect(summary.excludedByReason).toEqual({ 'validator-kit': 3, duplicate: 2 });
    expect(summary.byCompanyCode).toEqual({ '90000001': 4, '90000002': 3 });
    expect(summary.problems).toEqual({ PDF_UNREADABLE: 1 });
    expect(await readdir(temporary)).toEqual(['source']);
    expect(await readdir(source)).not.toContain('must-not-exist');
  });

  test('CLI copies synthetic inputs when --dry is absent', async () => {
    await put('return.xml', d300);
    const child = Bun.spawn(
      [process.execPath, resolve('scripts/differential/inventory.ts'), source, output],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const result = JSON.parse(await new Response(child.stdout).text());
    expect(await new Response(child.stderr).text()).toBe('');
    expect(await child.exited).toBe(0);
    expect(result.copied).toBe(1);
    expect(JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))).toEqual(
      await inventoryCorpus(source),
    );
  });

  test('a different destination requires explicit repair and a changed source is refused', async () => {
    await put('return.xml', d300);
    const records = await inventoryCorpus(source);
    await copyCorpus(source, output, records);
    await writeFile(join(output, 'return.xml'), 'damaged output');
    await expect(copyCorpus(source, output, records)).rejects.toThrow(
      'OUTPUT_CONFLICT: return.xml',
    );
    expect(await readFile(join(output, 'return.xml'), 'utf8')).toBe('damaged output');
    expect((await copyCorpus(source, output, records, { repair: true })).copied).toBe(1);
    await writeFile(
      join(source, 'return.xml'),
      Buffer.from(d300).toString('utf8').replace('90000001', '90000009'),
    );
    await expect(copyCorpus(source, output, records)).rejects.toThrow('SOURCE_CHANGED');
    await expect(copyCorpus(source, output, records, { repair: true })).rejects.toThrow(
      'SOURCE_CHANGED',
    );
    expect(await readFile(join(output, 'return.xml'))).toEqual(Buffer.from(d300));
  });

  test('a same-size hash conflict is refused before copying any missing file', async () => {
    await put('a-new.xml', d390);
    await put('return.xml', d300);
    await mkdir(output);
    const different = Buffer.from(d300).toString('utf8').replace('90000001', '90000009');
    await writeFile(join(output, 'return.xml'), different);
    const records = await inventoryCorpus(source);
    await expect(copyCorpus(source, output, records)).rejects.toMatchObject({
      code: 'OUTPUT_CONFLICT',
      path: 'return.xml',
    });
    expect(await tree(output)).toEqual(['return.xml']);
    expect(await readFile(join(output, 'return.xml'), 'utf8')).toBe(different);
    expect((await copyCorpus(source, output, records, { repair: true })).copied).toBe(2);
    expect(await readFile(join(output, 'return.xml'))).toEqual(Buffer.from(d300));
  });

  test('a different manifest is refused before copying any missing file unless repair is explicit', async () => {
    await put('return.xml', d300);
    await copyCorpus(source, output, await inventoryCorpus(source));
    await put('a-new.xml', d390);
    const manifestPath = join(output, 'manifest.json');
    await writeFile(manifestPath, '[]\n');
    const previous = await lstat(manifestPath);
    const records = await inventoryCorpus(source);
    await expect(copyCorpus(source, output, records)).rejects.toThrow(
      'OUTPUT_CONFLICT: manifest.json',
    );
    expect(await tree(output)).toEqual(['manifest.json', 'return.xml']);
    expect(await readFile(manifestPath, 'utf8')).toBe('[]\n');
    expect((await lstat(manifestPath)).ino).toBe(previous.ino);
    expect(await copyCorpus(source, output, records, { repair: true })).toEqual({
      copied: 1,
      unchanged: 1,
      manifestChanged: true,
    });
    expect(JSON.parse(await readFile(manifestPath, 'utf8'))).toEqual(records);
  });

  test.each(['return.xml', 'manifest.json'])(
    'CLI refuses a different %s unless --repair is set',
    async (path) => {
      await put('return.xml', d300);
      await copyCorpus(source, output, await inventoryCorpus(source));
      await writeFile(join(output, path), 'different output');
      const args = [process.execPath, resolve('scripts/differential/inventory.ts'), source, output];
      const refused = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
      expect(await new Response(refused.stdout).text()).toBe('');
      expect(await new Response(refused.stderr).text()).toBe(`OUTPUT_CONFLICT: ${path}\n`);
      expect(await refused.exited).toBe(1);
      expect(await readFile(join(output, path), 'utf8')).toBe('different output');
      const repaired = Bun.spawn([...args, '--repair'], { stdout: 'pipe', stderr: 'pipe' });
      const result = JSON.parse(await new Response(repaired.stdout).text());
      expect(await new Response(repaired.stderr).text()).toBe('');
      expect(await repaired.exited).toBe(0);
      expect(result.copied).toBe(path === 'return.xml' ? 1 : 0);
      expect(await readFile(join(output, 'return.xml'))).toEqual(Buffer.from(d300));
      expect(JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))).toEqual(
        await inventoryCorpus(source),
      );
    },
  );

  test('a file larger than a stream chunk copies every byte and remains unchanged on a second run', async () => {
    const content = Uint8Array.from({ length: 256 * 1024 + 137 }, (_, index) => index % 251);
    await put('large.bin', content);
    const records = await inventoryCorpus(source);
    expect(await copyCorpus(source, output, records)).toEqual({
      copied: 1,
      unchanged: 0,
      manifestChanged: true,
    });
    const copied = await readFile(join(output, 'large.bin'));
    expect(copied).toEqual(Buffer.from(content));
    expect(records.find((item) => item.path === 'large.bin')?.sha256).toBe(
      createHash('sha256').update(copied).digest('hex'),
    );
    const previous = await lstat(join(output, 'large.bin'));
    expect(await copyCorpus(source, output, records)).toEqual({
      copied: 0,
      unchanged: 1,
      manifestChanged: false,
    });
    expect((await lstat(join(output, 'large.bin'))).ino).toBe(previous.ino);
    expect(await readFile(join(source, 'large.bin'))).toEqual(Buffer.from(content));
  });

  test('summary keys sort by the key alone, including when one is a prefix of another', () => {
    const summary = inventorySummary([
      record('a.xml', d300, 'return-xml', {
        returns: [expectedXml({ fiscalCode: 'RO90000001 extra' })],
      }),
      record('b.xml', d390, 'return-xml', { returns: [expectedXml({ fiscalCode: 'RO90000001' })] }),
    ]);
    expect(Object.keys(summary.byCompanyCode)).toEqual(['RO90000001', 'RO90000001 extra']);
  });
});

describe('classification boundaries', () => {
  test('metadata projection accepts historical roots with many amount attributes and preserves unknowns', async () => {
    const attributes = Array.from({ length: 160 }, (_, index) => ` row${index}="123"`).join('');
    const result = await readReturnXml(
      xmlChunks(
        bytes(
          `<declaratie300 xmlns="mfp:anaf:dgti:d300:declaratie:v4"${attributes} d_rec="unexpected"/>`,
        ),
      ),
    );
    expect(result).toEqual(
      expectedXml({
        namespace: 'mfp:anaf:dgti:d300:declaratie:v4',
        version: '4',
        fiscalCode: null,
        period: { year: null, month: null, startDate: null, endDate: null },
      }),
    );
  });

  test('older D394 uses the identification child; a misleading R in a name supplies no flag', async () => {
    const content = bytes(
      '<declaratie394 xmlns="mfp:anaf:dgti:d394:declaratie:v2" an="2025" luna="04"><identificare cui="90000002"/></declaratie394>',
    );
    await put('D300_R_90000001_2026_12.xml', content);
    const [item] = await inventoryCorpus(source);
    expect(item?.returns).toEqual([
      expectedXml({
        rootElement: 'declaratie394',
        namespace: 'mfp:anaf:dgti:d394:declaratie:v2',
        form: 'D394',
        version: '2',
        fiscalCode: '90000002',
        period: { year: '2025', month: '04', startDate: null, endDate: null },
      }),
    ]);
  });

  test('D406 reads only the header even when the body is larger than the core XML limit', async () => {
    await put(
      'unreliable-name.bin',
      bytes(`${saftHeader}<invalid>${'x'.repeat(11 * 1024 * 1024)}`),
    );
    const [item] = await inventoryCorpus(source);
    expect(item?.kind).toBe('d406');
    expect(item?.returns).toEqual([expected406]);
    expect(item?.problems).toEqual([]);
    let bodyRequested = false;
    async function* chunks() {
      yield bytes(saftHeader);
      bodyRequested = true;
      throw new Error('Body must not be read by classification');
    }
    expect(await readReturnXml(chunks())).toEqual(expected406);
    expect(bodyRequested).toBe(false);
  });

  test('D406 attachments use the same header-only classification', async () => {
    await put(
      'signed.pdf',
      await pdf('Synthetic D406', bytes(`${saftHeader}</s:AuditFile>`), true),
    );
    const [item] = await inventoryCorpus(source);
    expect(item?.kind).toBe('d406');
    expect(item?.returns).toEqual([{ ...expected406, attachment: 'return.xml' }]);
  });

  test('content precedes validator, receipt, extension and failure path hints', async () => {
    await put('JAVA/return.jar', d300);
    await put('recipisa/return.pdf', await pdf('Synthetic return', d390, true));
    await put(
      'return.xml.err.txt',
      bytes('<declaratie100 xmlns="mfp:anaf:dgti:d100:declaratie:v2"/>'),
    );
    const records = await inventoryCorpus(source);
    expect(records.map((item) => item.kind)).toEqual([
      'return-xml',
      'signed-return-pdf',
      'return-xml',
    ]);
    expect(records.every((item) => item.excluded.length === 0)).toBe(true);
  });

  test.each([
    { field: 'title', value: 'Recipisa', kind: 'receipt' },
    { field: 'subject', value: 'Recipisa', kind: 'receipt' },
    { field: 'title', value: 'e-Factura', kind: 'efactura-pdf' },
    { field: 'subject', value: 'e-Factura', kind: 'efactura-pdf' },
  ])(
    'PDF $field classifies $kind without filename or folder hints',
    async ({ field, value, kind }) => {
      await put(
        'neutral/document.bin',
        await pdf(
          field === 'title' ? value : 'Synthetic document',
          undefined,
          false,
          field === 'subject' ? { subject: value } : {},
        ),
      );
      const records = await inventoryCorpus(source);
      const item = records.find((item) => item.path === 'neutral/document.bin');
      expect(item?.kind).toBe(kind);
      expect(item?.problems).toEqual([]);
    },
  );

  test('archive and SQLite signatures precede PDF extensions and validator directory hints', async () => {
    const cases: [string, Uint8Array, CorpusRecord['kind']][] = [
      [
        'Baza de Date/Revisal-backup/export.db',
        bytes('SQLite format 3\0synthetic labour register'),
        'revisal-export',
      ],
      [
        'Baza de Date/REVISAL-2026/export.pdf',
        bytes('SQLite format 3\0synthetic SQLite named PDF'),
        'revisal-export',
      ],
      [
        'Baza de Date/backup.pdf',
        bytes('PK\x03\x04synthetic archive named PDF'),
        'accounting-database-archive',
      ],
      [
        'Baza de Date/dist/export.zip',
        bytes('PK\x03\x04synthetic dist backup'),
        'accounting-database-archive',
      ],
      [
        'Baza de Date/java/export.rar',
        bytes('Rar!\x1a\x07synthetic java backup'),
        'accounting-database-archive',
      ],
      [
        'Baza de Date/duk-update/export.pdf',
        bytes('PK\x03\x04synthetic duk backup'),
        'accounting-database-archive',
      ],
    ];
    for (const [path, content] of cases) await put(path, content);
    const records = await inventoryCorpus(source);
    for (const [path, , kind] of cases) {
      const item = records.find((item) => item.path === path);
      expect(item?.kind).toBe(kind);
      expect(item?.problems).toEqual([]);
      expect(item?.excluded).toEqual([]);
    }
  });

  test('internal XFA EmbeddedFile streams do not imply attachments', async () => {
    const document = await PDFDocument.create();
    document.addPage();
    const internal = document.context.register(
      document.context.flateStream(bytes('<xfa/>'), { Type: 'EmbeddedFile' }),
    );
    document.catalog.set(PDFName.of('AcroForm'), document.context.obj({ XFA: internal }));
    const content = await document.save({ useObjectStreams: true });
    expect(Buffer.from(content).toString('latin1')).toContain('/EmbeddedFile');
    await put('internal-xfa.pdf', content);
    const records = await inventoryCorpus(source);
    expect(records.find((item) => item.path === 'internal-xfa.pdf')?.problems).toEqual([]);
  });

  test('an attached PDF whose file specification is in an object stream is readable', async () => {
    const attachment = await pdf('Synthetic attachment');
    const envelope = await pdf('Synthetic envelope', attachment, false, {
      objectStreams: true,
      attachmentName: 'enclosed.pdf',
    });
    expect(await pdfAttachments(envelope)).toEqual({
      ok: true,
      attachments: [{ name: 'enclosed.pdf', bytes: attachment, location: { kind: 'document' } }],
    });
    await put('envelope.pdf', envelope);
    const records = await inventoryCorpus(source);
    const item = records.find((item) => item.path === 'envelope.pdf');
    expect(item?.kind).toBe('other');
    expect(item?.returns).toEqual([]);
    expect(item?.problems).toEqual([]);
    expect(inventorySummary(records).problems).toEqual({});
  });

  test('a signed return whose file specification is in an object stream is inventoried', async () => {
    await put('signed.pdf', await pdf('Synthetic return', d300, true, { objectStreams: true }));
    const [item] = await inventoryCorpus(source);
    expect(item?.kind).toBe('signed-return-pdf');
    expect(item?.returns).toEqual([{ ...expectedXml(), attachment: 'return.xml' }]);
    expect(item?.problems).toEqual([]);
  });

  test('unsigned attached returns and statement PDFs without XML remain other', async () => {
    await put('unsigned.pdf', await pdf('Synthetic return', d300));
    await put('BILANT/no-xml.pdf', await pdf('Synthetic annual document'));
    const records = await inventoryCorpus(source);
    expect(records.map((item) => item.kind)).toEqual(['other', 'other']);
    expect(records.find((item) => item.path === 'unsigned.pdf')?.returns).toEqual([
      { ...expectedXml(), attachment: 'return.xml' },
    ]);
  });

  test('malformed XML, DTDs and broken embedded streams record problems and keep scanning', async () => {
    await put('malformed.xml', bytes('<declaratie300 xmlns="unterminated>'));
    await put('entity.xml', bytes('<!DOCTYPE x SYSTEM "file:///synthetic-secret"><x/>'));
    await put(
      'broken.pdf',
      bytes(
        '%PDF-1.4\n1 0 obj\n<< /Type /EmbeddedFile /Filter /FlateDecode /Length 3 >>\nstream\nBAD\nendstream\nendobj\n2 0 obj\n<< /Type /Filespec /F (return.xml) /EF << /F 1 0 R >> >>\nendobj\n%%EOF',
      ),
    );
    await put('ok.xml', d300);
    const records = await inventoryCorpus(source);
    expect(records.find((item) => item.path === 'malformed.xml')?.problems).toEqual([
      'XML_UNREADABLE',
    ]);
    expect(records.find((item) => item.path === 'entity.xml')?.problems).toEqual([
      'XML_UNREADABLE',
    ]);
    expect(records.find((item) => item.path === 'broken.pdf')?.problems).toContain(
      'PDF_ATTACHMENTS_UNREADABLE',
    );
    expect(records.find((item) => item.path === 'ok.xml')?.returns).toEqual([expectedXml()]);
  });

  test('ambiguous PDFs and attachment reader timeouts or crashes record problems instead of no attachments', async () => {
    const ambigDoc = await PDFDocument.create();
    ambigDoc.addPage();
    const s1 = ambigDoc.context.register(
      ambigDoc.context.flateStream(d300, { Type: 'EmbeddedFile' }),
    );
    const s2 = ambigDoc.context.register(
      ambigDoc.context.flateStream(bytes('<other/>'), { Type: 'EmbeddedFile' }),
    );
    const fs1 = ambigDoc.context.register(
      ambigDoc.context.obj({ Type: 'Filespec', F: PDFString.of('return.xml'), EF: { F: s1 } }),
    );
    const fs2 = ambigDoc.context.register(
      ambigDoc.context.obj({ Type: 'Filespec', F: PDFString.of('return.xml'), EF: { F: s2 } }),
    );
    ambigDoc.catalog.set(
      PDFName.of('Names'),
      ambigDoc.context.obj({
        EmbeddedFiles: {
          Names: [PDFString.of('return.xml'), fs1, PDFHexString.fromText('return.xml'), fs2],
        },
      }),
    );
    await put('ambiguous.pdf', await ambigDoc.save({ useObjectStreams: true }));
    const ambigRecords = await inventoryCorpus(source);
    expect(ambigRecords.find((item) => item.path === 'ambiguous.pdf')?.problems).toEqual([
      'PDF_ATTACHMENTS_AMBIGUOUS',
    ]);

    await put('plain.pdf', await pdf('Plain receipt'));
    let calls = 0;
    const timeoutOnce = await inventoryCorpus(source, {
      readAttachments: async (input) => {
        calls++;
        if (calls === 1) return { ok: false, reason: 'timeout' };
        return pdfAttachments(input);
      },
    });
    expect(timeoutOnce.find((item) => item.path === 'plain.pdf')?.problems).toEqual([]);

    const alwaysTimedOut = await inventoryCorpus(source, {
      readAttachments: async () => ({ ok: false, reason: 'timeout' }),
    });
    expect(alwaysTimedOut.find((item) => item.path === 'plain.pdf')?.problems).toEqual([
      'PDF_ATTACHMENTS_READER_FAILED',
    ]);

    const crashed = await inventoryCorpus(source, {
      readAttachments: async () => ({ ok: false, reason: 'failed' }),
    });
    expect(crashed.find((item) => item.path === 'plain.pdf')?.problems).toEqual([
      'PDF_ATTACHMENTS_READER_FAILED',
    ]);
  });
});

describe('duplicate owner', () => {
  const nested = 'Alfa X/Alfa/406';
  const canonical = 'Alfa/406';
  const d300Other = bytes(
    '<declaratie300 xmlns="mfp:anaf:dgti:d300:declaratie:v12" cui="90000001" an="2026" luna="03"/>',
  );

  /** The previous rule: the first path in code-unit order owns the group. */
  function oldRuleRecords(records: readonly CorpusRecord[]): CorpusRecord[] {
    const owner = new Map<string, string>();
    for (const item of records) if (!owner.has(item.sha256)) owner.set(item.sha256, item.path);
    return records.map((item) => {
      const first = owner.get(item.sha256)!;
      const excluded: CorpusRecord['excluded'] = item.excluded.filter(
        (reason) => reason !== 'duplicate',
      );
      if (first !== item.path) excluded.push('duplicate');
      return { ...item, duplicateOf: first === item.path ? null : first, excluded };
    });
  }

  async function nestedTree() {
    await put(`${nested}/f.xml`, d300);
    await put(`${canonical}/f.xml`, d300);
    await put(`${nested}/only-nested.xml`, d390);
  }

  test('the old order would pick the nested copy, the shallow path owns the group', async () => {
    await nestedTree();
    expect(comparePaths(`${nested}/f.xml`, `${canonical}/f.xml`)).toBeLessThan(0);
    const records = await inventoryCorpus(source);
    const byPath = new Map(records.map((item) => [item.path, item]));
    expect(byPath.get(`${canonical}/f.xml`)).toMatchObject({ duplicateOf: null, excluded: [] });
    expect(byPath.get(`${nested}/f.xml`)).toMatchObject({
      duplicateOf: `${canonical}/f.xml`,
      excluded: ['duplicate'],
    });
  });

  test('equal depths fall back to code-unit order, whatever the folder names', async () => {
    await put('B/406/f.xml', d300);
    await put('A/406/f.xml', d300);
    await put('A b/406/f.xml', d300);
    await put('A/406/deeper/f.xml', d300);
    const records = await inventoryCorpus(source);
    const owners = records.filter((item) => item.duplicateOf === null);
    expect(owners.map((item) => item.path)).toEqual(['A b/406/f.xml']);
    for (const item of records.filter((entry) => entry.duplicateOf !== null))
      expect(item.duplicateOf).toBe('A b/406/f.xml');
  });

  test('a file only in the nested copy is kept and duplicateOf chains end at the owner', async () => {
    await nestedTree();
    await put('Alfa X/Alfa/406/third.xml', d300Other);
    await put('Alfa/406/third.xml', d300Other);
    await put('Beta/406/third.xml', d300Other);
    const records = await inventoryCorpus(source);
    const byPath = new Map(records.map((item) => [item.path, item]));
    expect(byPath.get(`${nested}/only-nested.xml`)).toMatchObject({
      duplicateOf: null,
      excluded: [],
    });
    for (const item of records) {
      let current = item;
      for (let hops = 0; current.duplicateOf !== null; hops++) {
        expect(hops).toBeLessThan(2);
        current = byPath.get(current.duplicateOf)!;
      }
      expect(current.excluded).not.toContain('duplicate');
      expect(current.sha256).toBe(item.sha256);
    }
    expect(byPath.get(`${nested}/third.xml`)?.duplicateOf).toBe(`${canonical}/third.xml`);
    expect(byPath.get('Beta/406/third.xml')?.duplicateOf).toBe(`${canonical}/third.xml`);
    const included = records.filter((item) => item.excluded.length === 0).map((item) => item.path);
    expect(included).toEqual([
      `${nested}/only-nested.xml`,
      `${canonical}/f.xml`,
      `${canonical}/third.xml`,
    ]);
    await copyCorpus(source, output, records);
    expect((await tree(output)).filter((path) => path !== 'manifest.json')).toEqual(included);
  });

  test('an output whose owners were chosen by the old rule must be rebuilt, even with repair', async () => {
    await nestedTree();
    const records = await inventoryCorpus(source);
    const old = oldRuleRecords(records);
    expect(old.find((item) => item.path === `${nested}/f.xml`)?.duplicateOf).toBeNull();
    await copyCorpus(source, output, old);
    const before = await tree(output);
    expect(before).toContain(`${nested}/f.xml`);
    const manifest = await readFile(join(output, 'manifest.json'));
    for (const options of [{}, { repair: true }]) {
      await expect(copyCorpus(source, output, records, options)).rejects.toMatchObject({
        code: 'OWNER_RULE_CHANGED',
        message: expect.stringContaining('different duplicate owner rule and must be rebuilt'),
      });
      expect(await tree(output)).toEqual(before);
      expect(await readFile(join(output, 'manifest.json'))).toEqual(manifest);
    }
    await rm(output, { recursive: true });
    expect((await copyCorpus(source, output, records)).copied).toBe(2);
    expect(await tree(output)).toEqual([
      `${nested}/only-nested.xml`,
      `${canonical}/f.xml`,
      'manifest.json',
    ]);
    expect(await copyCorpus(source, output, records)).toMatchObject({
      copied: 0,
      manifestChanged: false,
    });
  });

  test('the CLI reports the owner rule change and writes nothing', async () => {
    await nestedTree();
    await copyCorpus(source, output, oldRuleRecords(await inventoryCorpus(source)));
    const before = await tree(output);
    const args = [process.execPath, resolve('scripts/differential/inventory.ts'), source, output];
    for (const extra of [[], ['--repair']]) {
      const child = Bun.spawn([...args, ...extra], { stdout: 'pipe', stderr: 'pipe' });
      expect(await new Response(child.stdout).text()).toBe('');
      expect(await new Response(child.stderr).text()).toContain('OWNER_RULE_CHANGED');
      expect(await child.exited).toBe(1);
      expect(await tree(output)).toEqual(before);
    }
  });

  test('a manifest whose owners follow the current rule is not an owner rule change', async () => {
    await put('A/f.xml', d300);
    await put('B/f.xml', d300);
    await copyCorpus(source, output, await inventoryCorpus(source));
    await put('A/new.xml', d390);
    await expect(copyCorpus(source, output, await inventoryCorpus(source))).rejects.toThrow(
      'OUTPUT_CONFLICT: manifest.json',
    );
  });

  test.each([
    ['a doubled separator', 'A//f.xml'],
    ['a trailing separator', 'A/f.xml/'],
  ])('%s adds no segment when a manifest on disk is read', async (_name, odd) => {
    await put('A/f.xml', d300);
    await put('B/f.xml', d300);
    const records = await inventoryCorpus(source);
    const sha256 = records[0]!.sha256;
    await mkdir(output);
    const manifest = join(output, 'manifest.json');
    const entry = (path: string, duplicateOf: string | null) => ({ path, sha256, duplicateOf });
    // Both paths have two segments, so the code-unit order picks the odd one as owner.
    await writeFile(manifest, JSON.stringify([entry(odd, null), entry('B/f.xml', odd)]));
    await expect(copyCorpus(source, output, records)).rejects.toThrow('OUTPUT_CONFLICT');
    // An owner that is not the first of the two is another rule, and is refused even with repair.
    await writeFile(manifest, JSON.stringify([entry(odd, 'B/f.xml'), entry('B/f.xml', null)]));
    for (const options of [{}, { repair: true }])
      await expect(copyCorpus(source, output, records, options)).rejects.toMatchObject({
        code: 'OWNER_RULE_CHANGED',
      });
  });
});

describe('copy containment', () => {
  test('unsafe paths and manifest collisions are rejected before creating the output', async () => {
    await put('return.xml', d300);
    const [original] = await inventoryCorpus(source);
    for (const path of [
      '../escaped.xml',
      '/absolute.xml',
      'nested/../../escaped.xml',
      'nested\\escaped.xml',
      'C:/escaped.xml',
      'nested//file',
      'manifest.json',
      'Manifest.JSON',
      'manifest.json/file',
    ]) {
      await expect(copyCorpus(source, output, [{ ...original!, path }])).rejects.toThrow(
        'UNSAFE_CORPUS_PATH',
      );
    }
    expect(await readdir(temporary)).toEqual(['source']);
  });

  test('source and output overlap is rejected without modifying the source', async () => {
    await put('return.xml', d300);
    const records = await inventoryCorpus(source);
    for (const target of [source, join(source, 'nested'), temporary])
      await expect(copyCorpus(source, target, records)).rejects.toThrow('SOURCE_OUTPUT_OVERLAP');
    expect(await tree(source)).toEqual(['return.xml']);
    expect(await readdir(temporary)).toEqual(['source']);
  });

  test('output directory and file symlinks cannot redirect writes or the manifest', async () => {
    await put('nested/return.xml', d300);
    const records = await inventoryCorpus(source);
    const outside = join(temporary, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'sentinel'), 'unchanged');
    await symlink(outside, output);
    await expect(copyCorpus(source, output, records)).rejects.toThrow('UNSAFE_OUTPUT_FOLDER');
    await rm(output);
    await mkdir(output);
    await symlink(outside, join(output, 'nested'));
    await expect(copyCorpus(source, output, records)).rejects.toThrow('UNSAFE_OUTPUT_PATH');
    await rm(join(output, 'nested'));
    await mkdir(join(output, 'nested'));
    await symlink(join(outside, 'sentinel'), join(output, 'nested/return.xml'));
    await expect(copyCorpus(source, output, records)).rejects.toThrow('UNSAFE_OUTPUT_PATH');
    await rm(join(output, 'nested/return.xml'));
    await symlink(join(outside, 'sentinel'), join(output, 'manifest.json'));
    await expect(copyCorpus(source, output, records)).rejects.toThrow('UNSAFE_OUTPUT_PATH');
    expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('unchanged');
    expect(await tree(outside)).toEqual(['sentinel']);
    expect(await inventoryCorpus(source)).toEqual(records);
  });

  test('replacement does not modify a pre-existing hardlink outside the output', async () => {
    await put('return.xml', d300);
    const sentinel = join(temporary, 'sentinel');
    await writeFile(sentinel, 'unchanged');
    await mkdir(output);
    await link(sentinel, join(output, 'return.xml'));
    const records = await inventoryCorpus(source);
    await expect(copyCorpus(source, output, records)).rejects.toThrow(
      'OUTPUT_CONFLICT: return.xml',
    );
    await copyCorpus(source, output, records, { repair: true });
    expect(await readFile(sentinel, 'utf8')).toBe('unchanged');
    expect(await readFile(join(output, 'return.xml'))).toEqual(Buffer.from(d300));
  });

  test('source symlinks are never traversed by inventory or copy', async () => {
    const outside = join(temporary, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'return.xml'), d300);
    await symlink(outside, join(source, 'linked'));
    await expect(inventoryCorpus(source)).rejects.toThrow('SOURCE_SYMLINK');
    await expect(
      copyCorpus(source, output, [record('linked/return.xml', d300, 'return-xml')]),
    ).rejects.toThrow('UNSAFE_SOURCE_PATH');
    expect(await readdir(temporary)).not.toContain('output');
  });
});
