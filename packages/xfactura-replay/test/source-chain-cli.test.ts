import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceChainCounts } from '../src/compare/source-chain-cli';
import { monthEnd, monthOf, parseLocalDate } from 'xfactura-core/time';
import type { CorpusRecord } from '../src/corpus/inventory';
import { PDFDocument } from 'pdf-lib';

const manifestXml = (month: string, closing = '12.34', created = '2026-01-01') =>
  `<AuditFile xmlns="mfp:anaf:dgti:d406:declaratie:v1"><Header><AuditFileDateCreated>${created}</AuditFileDateCreated><Company><RegistrationNumber>90000003</RegistrationNumber></Company><SelectionCriteria><SelectionStartDate>${month}-01</SelectionStartDate><SelectionEndDate>${monthEnd(monthOf(parseLocalDate(`${month}-01`)))}</SelectionEndDate></SelectionCriteria></Header><MasterFiles><GeneralLedgerAccounts><Account><AccountID>private-synthetic-account</AccountID><OpeningDebitBalance>12.34</OpeningDebitBalance><ClosingDebitBalance>${closing}</ClosingDebitBalance></Account></GeneralLedgerAccounts></MasterFiles></AuditFile>`;

function record(path: string, xml: string, duplicateOf: string | null = null): CorpusRecord {
  return {
    path,
    size: Buffer.byteLength(xml),
    sha256: createHash('sha256').update(xml).digest('hex'),
    kind: 'd406',
    duplicateOf,
    excluded: duplicateOf ? ['duplicate'] : [],
    problems: [],
    returns: [
      {
        rootElement: 'AuditFile',
        namespace: 'mfp:anaf:dgti:d406:declaratie:v1',
        form: 'D406',
        version: '1',
        fiscalCode: '90000003',
        period: { year: null, month: null, startDate: null, endDate: null },
        rectifying: null,
        declarationType: null,
        attachment: null,
      },
    ],
  };
}

test('the private corpus runner deduplicates bytes, compares every period and returns counts only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'replay-chain-'));
  try {
    const directory = join(root, '.private/corpus/synthetic');
    await mkdir(directory, { recursive: true });
    const xml = (month: string, opening: string, closing: string) =>
      `<AuditFile xmlns="mfp:anaf:dgti:d406:declaratie:v1"><Header><SelectionCriteria><SelectionStartDate>2026-${month}-01</SelectionStartDate><SelectionEndDate>2026-${month}-${month === '02' ? '28' : '31'}</SelectionEndDate></SelectionCriteria></Header><MasterFiles><GeneralLedgerAccounts><Account><AccountID>private-synthetic-account</AccountID><OpeningDebitBalance>${opening}</OpeningDebitBalance><ClosingDebitBalance>${closing}</ClosingDebitBalance></Account></GeneralLedgerAccounts></MasterFiles></AuditFile>`;
    await writeFile(join(directory, 'first.xml'), xml('01', '0', '12.34'));
    await writeFile(join(directory, 'duplicate.xml'), xml('01', '0', '12.34'));
    await writeFile(join(directory, 'second.xml'), xml('02', '12.35', '56.78'));
    await writeFile(join(directory, 'receipt.xml'), '<receipt/>');
    const counts = await sourceChainCounts(directory);
    expect(counts).toEqual({
      filesRead: 4,
      declarations: 2,
      duplicates: 1,
      transitionsChecked: 1,
      accountsCompared: 1,
      byKind: { 'source-chain-balance': 1 },
    });
    const text = JSON.stringify(counts);
    for (const value of ['12.34', '12.35', '56.78', 'private-synthetic-account', root])
      expect(text).not.toContain(value);
    await writeFile(join(directory, 'revision.xml'), xml('02', '12.36', '56.78'));
    await expect(sourceChainCounts(directory)).rejects.toThrow('SOURCE_CHAIN_PERIOD_CONFLICT');
    await expect(sourceChainCounts(root)).rejects.toThrow('SOURCE_CHAIN_PRIVATE');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('manifest lookup follows duplicate owners across folder trees and covers all 21 periods', async () => {
  const root = await mkdtemp(join(tmpdir(), 'replay-chain-manifest-'));
  try {
    const directory = join(root, '.private/corpus');
    await mkdir(join(directory, 'stale-copy/ANAF/406'), { recursive: true });
    const records: CorpusRecord[] = [];
    for (let index = 0; index < 21; index++) {
      const month = `${2025 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
      const xml = manifestXml(month);
      const owner = `stale-copy/ANAF/406/period-${index}.xml`;
      await writeFile(join(directory, owner), xml);
      records.push(record(owner, xml), record(`preferred/406/period-${index}.xml`, xml, owner));
    }
    // The intermediate and preferred duplicate paths were excluded by the copy and do not exist.
    records[1]!.duplicateOf = 'intermediate/first.xml';
    records.push(record('intermediate/first.xml', manifestXml('2025-01'), records[0]!.path));
    const irrelevant = record('not-copied/other-company.xml', 'unread');
    irrelevant.returns[0]!.fiscalCode = '90000004';
    records.push(irrelevant);
    const otherForm = record('not-copied/other-form.xml', 'unread');
    otherForm.returns[0]!.form = 'D300';
    records.push(otherForm);
    const manifest = join(directory, 'manifest.json');
    await writeFile(manifest, JSON.stringify(records));
    const result = await sourceChainCounts(manifest, '90000003');
    expect(result).toMatchObject({
      filesRead: 21,
      declarations: 21,
      transitionsChecked: 20,
      accountsCompared: 20,
      byKind: {},
    });
    const cli = Bun.spawnSync([
      process.execPath,
      'packages/xfactura-replay/src/compare/source-chain-cli.ts',
      '--manifest',
      manifest,
      '90000003',
    ]);
    expect(cli.exitCode).toBe(0);
    expect(JSON.parse(cli.stdout.toString())).toEqual([result]);
    expect(cli.stderr.toString()).toBe('');
    for (const privateValue of [
      '90000003',
      '12.34',
      'private-synthetic-account',
      'stale-copy',
      root,
    ])
      expect(JSON.stringify(result)).not.toContain(privateValue);

    // A new filing changes generation metadata and decimal spelling, not the chain facts.
    const refile = manifestXml('2025-01', '12.340', '2026-02-01');
    await writeFile(join(directory, 'refiled.xml'), refile);
    records.push(record('refiled.xml', refile));
    await writeFile(manifest, JSON.stringify(records.reverse()));
    expect(await sourceChainCounts(manifest, 'RO90000003')).toMatchObject({
      declarations: 21,
      transitionsChecked: 20,
      accountsCompared: 20,
      byKind: {},
    });
    const conflict = manifestXml('2025-01', '12.35', '2026-03-01');
    await writeFile(join(directory, 'conflict.xml'), conflict);
    records.push(record('conflict.xml', conflict));
    await writeFile(manifest, JSON.stringify(records));
    await expect(sourceChainCounts(manifest, '90000003')).rejects.toThrow(
      'SOURCE_CHAIN_PERIOD_CONFLICT',
    );
    const refused = Bun.spawnSync([
      process.execPath,
      'packages/xfactura-replay/src/compare/source-chain-cli.ts',
      '--manifest',
      manifest,
      '90000003',
    ]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout.toString()).toBe('');
    expect(refused.stderr.toString().trim()).toBe('SOURCE_CHAIN_PERIOD_CONFLICT');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('manifest reads selected PDF attachments and rejects corrupt, misidentified or unsafe owners', async () => {
  const root = await mkdtemp(join(tmpdir(), 'replay-chain-manifest-'));
  try {
    const directory = join(root, '.private/corpus');
    await mkdir(directory, { recursive: true });
    const pdf = await PDFDocument.create();
    await pdf.attach(new TextEncoder().encode(manifestXml('2026-01')), 'filed.xml');
    await pdf.attach(new TextEncoder().encode(manifestXml('2026-01', '13')), 'not-selected.xml');
    const bytes = await pdf.save({ useObjectStreams: false });
    await writeFile(join(directory, 'filed.pdf'), bytes);
    const row = record('filed.pdf', 'unused');
    row.sha256 = createHash('sha256').update(bytes).digest('hex');
    row.returns[0]!.attachment = 'filed.xml';
    const manifest = join(directory, 'manifest.json');
    const save = (rows: CorpusRecord[]) => writeFile(manifest, JSON.stringify(rows));
    await save([row]);
    expect(await sourceChainCounts(manifest, '90000003')).toMatchObject({
      declarations: 1,
      transitionsChecked: 0,
      byKind: {},
    });
    row.returns[0]!.attachment = 'missing.xml';
    await save([row]);
    await expect(sourceChainCounts(manifest, '90000003')).rejects.toThrow(
      'SOURCE_CHAIN_MANIFEST_ATTACHMENT',
    );
    row.returns[0]!.attachment = 'filed.xml';
    row.returns[0]!.fiscalCode = '90000004';
    await save([row]);
    await expect(sourceChainCounts(manifest, '90000004')).rejects.toThrow('SOURCE_CHAIN_COMPANY');
    row.returns[0]!.fiscalCode = '90000003';
    row.sha256 = '0'.repeat(64);
    await save([row]);
    await expect(sourceChainCounts(manifest, '90000003')).rejects.toThrow(
      'SOURCE_CHAIN_MANIFEST_HASH',
    );
    row.sha256 = createHash('sha256').update(bytes).digest('hex');
    row.duplicateOf = row.path;
    await save([row]);
    await expect(sourceChainCounts(manifest, '90000003')).rejects.toThrow(
      'SOURCE_CHAIN_MANIFEST_DUPLICATE',
    );
    row.duplicateOf = 'absent.pdf';
    await save([row]);
    await expect(sourceChainCounts(manifest, '90000003')).rejects.toThrow(
      'SOURCE_CHAIN_MANIFEST_DUPLICATE',
    );
    row.duplicateOf = '../outside.pdf';
    await save([row]);
    await expect(sourceChainCounts(manifest, '90000003')).rejects.toThrow(
      'SOURCE_CHAIN_MANIFEST_PATH',
    );
    row.duplicateOf = null;
    row.path = 'linked.pdf';
    await symlink(join(directory, 'filed.pdf'), join(directory, 'linked.pdf'));
    await save([row]);
    await expect(sourceChainCounts(manifest, '90000003')).rejects.toThrow(
      'SOURCE_CHAIN_MANIFEST_PATH',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
