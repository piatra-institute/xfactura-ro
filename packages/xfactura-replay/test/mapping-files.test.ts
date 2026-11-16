import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { proposeMapping, readMappingFile, readSagaDump, writeMappingFile } from '../src/mapping';
import { inventoryCorpus } from '../src/corpus/inventory';
import { parseMappingArguments } from '../../../scripts/differential/mapping';
import { mappingChart, mappingFiled, mappingXml, sourceAccount } from './fixtures/mapping';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xfactura-mapping-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const mapping = () => proposeMapping([mappingFiled()], mappingChart, []);
const output = '.private/mapping/invented.json';

async function cli(args: string[]) {
  const script = new URL('../../../scripts/differential/mapping.ts', import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, script, ...args], {
    cwd: directory,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe('private mapping persistence', () => {
  test('versioned decisions round-trip, unchanged reruns do not rewrite, hardlinks are replaced', async () => {
    expect(await readMappingFile(output, directory)).toBeUndefined();
    const proposal = mapping();
    proposal.accounts[0]!.decidedBy = 'person';
    proposal.accounts[0]!.confirmedByPerson = true;
    await writeMappingFile(output, proposal, directory);
    expect(await readMappingFile(output, directory)).toEqual(proposal);
    const filename = join(directory, output);
    const before = await stat(filename);
    await writeMappingFile(output, proposal, directory);
    expect((await stat(filename)).mtimeMs).toBe(before.mtimeMs);
    const sentinel = join(directory, 'sentinel');
    await writeFile(sentinel, 'unchanged');
    await rm(filename);
    await link(sentinel, filename);
    await writeMappingFile(output, proposal, directory);
    expect(await readFile(sentinel, 'utf8')).toBe('unchanged');
    expect((await stat(filename)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(directory, '.private/mapping'))).toEqual(['invented.json']);
  });

  test('outside paths and traversal are refused before creating files or directories', async () => {
    for (const path of [
      'outside.json',
      '.private/../outside.json',
      '.private-other/out.json',
      directory,
      '.private',
    ])
      await expect(writeMappingFile(path, mapping(), directory)).rejects.toThrow(
        'MAPPING_OUTPUT_OUTSIDE_PRIVATE',
      );
    expect(await readdir(directory)).toEqual([]);
  });

  test('the shared .private root may be a symlink, but nested and file symlinks are refused', async () => {
    const shared = join(directory, 'shared');
    await mkdir(shared);
    await symlink(shared, join(directory, '.private'));
    await writeMappingFile(output, mapping(), directory);
    expect(await readMappingFile(output, directory)).toEqual(mapping());
    const outside = join(directory, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'sentinel'), 'unchanged');
    await symlink(outside, join(shared, 'escape'));
    await expect(
      writeMappingFile('.private/escape/out.json', mapping(), directory),
    ).rejects.toThrow('MAPPING_OUTPUT_UNSAFE');
    await symlink(join(outside, 'sentinel'), join(shared, 'file.json'));
    await expect(readMappingFile('.private/file.json', directory)).rejects.toThrow(
      'MAPPING_OUTPUT_UNSAFE',
    );
    await expect(writeMappingFile('.private/file.json', mapping(), directory)).rejects.toThrow(
      'MAPPING_OUTPUT_UNSAFE',
    );
    expect(await readdir(outside)).toEqual(['sentinel']);
    expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('unchanged');
  });

  test('a malformed prior file is refused without quoting or overwriting its contents', async () => {
    await mkdir(join(directory, '.private'));
    await writeFile(join(directory, '.private/broken.json'), '{"name":"Secret invented person"}');
    await expect(readMappingFile('.private/broken.json', directory)).rejects.toThrow(
      'MAPPING_PREVIOUS_READ',
    );
    expect(await readFile(join(directory, '.private/broken.json'), 'utf8')).toContain(
      'Secret invented person',
    );
  });
});

describe('SAGA adapter', () => {
  async function dump() {
    const rows = {
      CONTURI: [{ CONT: '401.00002   ', DENUMIRE: 'Furnizor inventat' }],
      CLIENTI: [],
      FURNIZORI: [
        {
          COD: 'SUP2 ',
          DENUMIRE: 'Furnizor inventat',
          ANALITIC: '401.00002 ',
          C_SAFT: '0090000002 ',
          COD_FISCAL: 'RO90000002 ',
          TARA: 'RO ',
        },
      ],
    };
    const columns = {
      CONTURI: ['CONT', 'DENUMIRE'],
      CLIENTI: ['COD', 'DENUMIRE', 'ANALITIC', 'C_SAFT', 'COD_FISCAL', 'TARA'],
      FURNIZORI: ['COD', 'DENUMIRE', 'ANALITIC', 'C_SAFT', 'COD_FISCAL', 'TARA'],
    };
    const tables = (Object.keys(rows) as (keyof typeof rows)[]).map((name) => ({
      name,
      rowCount: rows[name].length,
      columns: columns[name].map((name) => ({ name })),
    }));
    await writeFile(join(directory, 'schema.json'), JSON.stringify({ tables }));
    for (const name of Object.keys(rows) as (keyof typeof rows)[])
      await writeFile(
        join(directory, `${name}.jsonl`),
        rows[name].map((row) => JSON.stringify(row)).join('\n'),
      );
    return tables;
  }

  test('declared tables trim padding and use the original partner code and SAF-T link', async () => {
    await dump();
    expect(await readSagaDump(directory)).toEqual({
      accounts: [{ code: '401.00002', name: 'Furnizor inventat' }],
      partners: [
        {
          source: { origin: 'saga', role: 'supplier', id: 'SUP2' },
          account: '401.00002',
          saftId: '0090000002',
          name: 'Furnizor inventat',
          country: 'RO',
          taxId: 'RO90000002',
        },
      ],
    });
  });

  test('incomplete dumps and unknown layouts fail with value-free errors', async () => {
    const tables = await dump();
    await writeFile(join(directory, 'FURNIZORI.jsonl'), '');
    await expect(readSagaDump(directory)).rejects.toThrow('MAPPING_SAGA_ROW_COUNT');
    await writeFile(join(directory, 'schema.json'), JSON.stringify({ tables: tables.slice(0, 1) }));
    await expect(readSagaDump(directory)).rejects.toThrow('MAPPING_SAGA_SCHEMA');
  });
});

describe('mapping CLI', () => {
  test('corpus inputs require a manifest and manifest paths, hashes and symlinks cannot bypass containment', async () => {
    const corpus = join(directory, '.private/corpus');
    const seed = join(corpus, 'seed');
    await mkdir(seed, { recursive: true });
    await writeFile(join(seed, 'filing.xml'), mappingXml());
    const missing = await cli(['invented', seed]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('MAPPING_CORPUS_MANIFEST_REQUIRED');
    const manifest = await inventoryCorpus(corpus);
    const original = structuredClone(manifest[0]!);
    manifest[0]!.path = '../invented-private-name.xml';
    await writeFile(join(corpus, 'manifest.json'), JSON.stringify(manifest));
    const traversal = await cli(['invented', seed]);
    expect(traversal.exitCode).toBe(1);
    expect(traversal.stderr).toContain('MAPPING_CORPUS_PATH');
    expect(traversal.stderr).not.toContain('invented-private-name');
    manifest[0] = { ...original, sha256: '0'.repeat(64) };
    await writeFile(join(corpus, 'manifest.json'), JSON.stringify(manifest));
    const changed = await cli(['invented', seed]);
    expect(changed.exitCode).toBe(1);
    expect(changed.stderr).toContain('MAPPING_CORPUS_CHANGED');
    manifest[0] = original;
    manifest.push({ ...original, path: 'linked.xml' });
    await symlink(join(seed, 'filing.xml'), join(corpus, 'linked.xml'));
    await writeFile(join(corpus, 'manifest.json'), JSON.stringify(manifest));
    const linked = await cli(['invented', seed]);
    expect(linked.exitCode).toBe(1);
    expect(linked.stderr).toContain('MAPPING_INPUT_SYMLINK');
    for (const result of [missing, traversal, changed, linked]) expect(result.stdout).toBe('');
  });

  test('manifest selection follows duplicate owners across folders, includes every period and collapses identical XML attachments', async () => {
    const corpus = join(directory, '.private/corpus');
    const seed = join(corpus, 'seed');
    const misplaced = join(corpus, 'another-folder');
    await mkdir(seed, { recursive: true });
    await mkdir(misplaced);
    const january = mappingXml({
      accounts: sourceAccount('JAN', '628.JAN'),
      period: { start: '2026-01-01', end: '2026-01-31' },
    });
    await writeFile(join(seed, 'seed.xml'), january);
    await writeFile(join(misplaced, 'canonical.xml'), january);
    await writeFile(
      join(misplaced, 'february.xml'),
      mappingXml({
        accounts: sourceAccount('FEB', '628.FEB'),
        period: { start: '2026-02-01', end: '2026-02-28' },
      }),
    );
    await writeFile(
      join(misplaced, 'different-refiling.xml'),
      mappingXml({
        accounts: sourceAccount('REFILING', '628.REFILING'),
        period: { start: '2026-01-01', end: '2026-01-31' },
      }),
    );
    await writeFile(
      join(misplaced, 'other-company.xml'),
      mappingXml({ company: '90000009', accounts: sourceAccount('OTHER', '9999') }),
    );
    await writeFile(
      join(misplaced, 'other-form.xml'),
      '<declaratie300 xmlns="mfp:anaf:dgti:d300:declaratie:v10" cui="90000001" an="2026" luna="03"/>',
    );
    const pdf = await PDFDocument.create();
    pdf.addPage();
    await pdf.attach(new TextEncoder().encode(january), 'filing.xml');
    await writeFile(join(misplaced, 'filing.pdf'), await pdf.save({ useObjectStreams: false }));
    const manifest = await inventoryCorpus(corpus);
    const seedRecord = manifest.find((r) => r.path === 'seed/seed.xml')!;
    expect(seedRecord.duplicateOf).toBe('another-folder/canonical.xml');
    manifest.push({ ...seedRecord, path: 'missing/alias.xml', duplicateOf: seedRecord.path });
    await writeFile(join(corpus, 'manifest.json'), JSON.stringify(manifest));
    const result = await cli(['invented', seed]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      periodsCovered: 2,
      filedDocuments: 3,
      sourceAccounts: 3,
      sourcePartners: 0,
    });
    const saved = await readMappingFile(output, directory);
    expect(saved!.accounts.map((a) => a.sourceId).sort()).toEqual(['FEB', 'JAN', 'REFILING']);
    for (const value of ['90000001', '90000009', 'canonical.xml', 'filing.xml', 'REFILING'])
      expect(result.stdout + result.stderr).not.toContain(value);
    seedRecord.duplicateOf = seedRecord.path;
    await writeFile(join(corpus, 'manifest.json'), JSON.stringify(manifest));
    const cycle = await cli(['invented', seed]);
    expect(cycle.exitCode).toBe(1);
    expect(cycle.stderr).toContain('MAPPING_CORPUS_DUPLICATE');
    expect(cycle.stderr).not.toContain(seedRecord.path);
  });

  test('argument parsing supports several files and rejects incomplete or repeated options', () => {
    expect(
      parseMappingArguments(['invented', 'one.xml', 'two.xml', '--saga', 'dump', '--out', output]),
    ).toEqual({ alias: 'invented', inputs: ['one.xml', 'two.xml'], saga: 'dump', out: output });
    for (const args of [
      [],
      ['invented'],
      ['../escape', 'one.xml'],
      ['invented', 'one.xml', '--out'],
      ['invented', 'one.xml', '--unknown', 'value'],
      ['invented', 'one.xml', '--out', output, '--out', output],
    ])
      expect(() => parseMappingArguments(args)).toThrow('MAPPING_USAGE');
  });

  test('writes proposals despite blockers, prints only counts and paths, and reruns retain confirmations', async () => {
    const source = join(directory, '.private/input');
    await mkdir(source, { recursive: true });
    const xml = mappingXml({
      accounts: sourceAccount('SECRET-PERSONAL-ID', '421.SECRET', 'Invented private name'),
    });
    await writeFile(join(source, 'month.XML'), xml);
    await writeFile(join(source, 'ignored.pdf'), 'not an XML');
    const result = await cli(['invented', source]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe('');
    const summary = JSON.parse(result.stdout);
    expect(summary).toMatchObject({
      sourceAccounts: 1,
      sourcePartners: 0,
      placeholderParties: 1,
      placeholderPartiesPerAccount: [{ path: 'accounts.0', count: 1 }],
      blockingByReason: { PLACEHOLDER_UNCONFIRMED: 1 },
    });
    for (const value of [
      'SECRET-PERSONAL-ID',
      '421.SECRET',
      'Invented private name',
      '17.00',
      '90000001',
    ])
      expect(result.stdout + result.stderr).not.toContain(value);
    const target = '.private/mapping/invented.json';
    const proposed = (await readMappingFile(target, directory))!;
    proposed.placeholders[0]!.confirmedByPerson = true;
    await writeMappingFile(target, proposed, directory);
    const bytes = await readFile(join(directory, target), 'utf8');
    const rerun = await cli(['invented', source]);
    expect(rerun.exitCode).toBe(0);
    expect(await readFile(join(directory, target), 'utf8')).toBe(bytes);
  });

  test('outside outputs and parser failures cannot leak input values', async () => {
    const source = join(directory, 'source.xml');
    await writeFile(source, '<private-name>Invented private name</private-name>');
    const outside = await cli(['invented', source, '--out', 'outside.json']);
    expect(outside.exitCode).toBe(1);
    expect(outside.stderr).toContain('MAPPING_OUTPUT_OUTSIDE_PRIVATE');
    expect(outside.stdout).toBe('');
    expect(await readdir(directory)).toEqual(['source.xml']);
    const invalid = await cli(['invented', source]);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr).not.toContain('Invented private name');
    expect(invalid.stdout).toBe('');
  });
});
