import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Accounting } from '../../source/accounting/application';
import type { Actor } from '../../source/accounting/commands';
import { Database } from '../../source/accounting/db';
import { migrate } from '../../source/accounting/migrate';
import { createAuth } from '../../source/accounting/auth';
import { createApp } from '../../source/accounting/app';
import { archiveOutput } from '../../source/accounting/invoice-archives';
import { parseInvoiceArchive } from '../../source/accounting/invoice-archive';
import { LocalObjectStore, sha256, type ObjectStore } from '../../source/accounting/object-store';
import {
  invoiceArchiveEntries,
  invoiceArchives,
  invoiceDocuments,
  evidence,
  journals,
  commands,
  audit,
} from '../../source/accounting/schema';
import { backup, restore } from '../../source/accounting/backup';
import { runOneExport } from '../../source/accounting/worker';
import { invoiceXml } from './fixtures/invoice';
import { invoiceZip, signatureXml, rejectionXml, corruptEntry } from './fixtures/archive';

const key = () => randomUUID(),
  secret = 'synthetic-archive-secret-at-least-32-characters';
let directory: string,
  db: Database,
  objects: LocalObjectStore,
  service: Accounting,
  ownerId: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xfactura-archives-'));
  db = new Database(`file:${directory}/books.db`);
  await migrate(db);
  objects = new LocalObjectStore(join(directory, 'objects'));
  service = new Accounting(db, objects, secret);
  ownerId = (
    await createAuth(
      db,
      { publicUrl: 'http://localhost:3000', authSecret: secret },
      true,
    ).api.signUpEmail({
      body: {
        name: 'Archive reviewer',
        email: 'archive@example.test',
        password: 'synthetic-archive-password',
      },
    })
  ).user.id;
});
afterAll(async () => {
  if (db) await db.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const company = await service.companies.create(ownerId, key(), {
    name: 'Archive SRL',
    cui: '12345678',
    year: 2026,
  });
  return { company, actor: { companyId: company.id, actorId: ownerId } };
}
async function source(actor: Actor, bytes: Uint8Array = invoiceZip(), filename = 'efactura.zip') {
  return service.documents.record(actor, key(), {
    filename,
    mediaType: filename.endsWith('.xml') ? 'application/xml' : 'application/zip',
    bytes,
  });
}
async function snapshot(actor: Actor) {
  const result: Record<string, unknown> = {};
  for (const [name, table] of Object.entries({
    invoiceArchives,
    invoiceArchiveEntries,
    invoiceDocuments,
    evidence,
    journals,
    commands,
    audit,
  }))
    result[name] = await db.orm.select().from(table).where(eq(table.companyId, actor.companyId));
  return result;
}
async function rejectImport(bytes: Uint8Array, code?: string) {
  const f = await fixture(),
    root = await source(f.actor, bytes),
    before = await snapshot(f.actor);
  if (code)
    await expect(
      service.invoiceArchives.import(f.actor, key(), { evidenceId: root.id }),
    ).rejects.toMatchObject({ code });
  else
    await expect(
      service.invoiceArchives.import(f.actor, key(), { evidenceId: root.id }),
    ).rejects.toThrow();
  expect(await snapshot(f.actor)).toEqual(before);
  expect((await service.documents.read(f.actor, root.id)).bytes).toEqual(Buffer.from(bytes));
}

describe('retained e-Factura ZIP imports', () => {
  test('imports incoming/outgoing invoices and credits with exact original bytes, signature separation and idempotent concurrent retries', async () => {
    const f = await fixture(),
      xml = invoiceXml({ number: 'PURCHASE' }),
      sale = invoiceXml({ number: 'SALE', direction: 'sale' }),
      credit = invoiceXml({ number: 'CREDIT', credit: true }),
      bytes = invoiceZip({
        'facturi/': new Uint8Array(),
        'facturi/purchase.xml': xml,
        'sale.xml': sale,
        'credit.xml': credit,
        'signature.xml': signatureXml,
        'rendered.pdf': '%PDF-1.7\nSynthetic rendition, not accounting authority',
        'detached.p7s': 'Opaque synthetic detached signature',
      }),
      root = await source(f.actor, bytes),
      commandKey = key();
    const [a, b] = await Promise.all([
      service.invoiceArchives.import(f.actor, commandKey, { evidenceId: root.id }),
      service.invoiceArchives.import(f.actor, commandKey, { evidenceId: root.id }),
    ]);
    expect(a).toEqual(b);
    expect(archiveOutput.parse(a)).toMatchObject({
      evidenceId: root.id,
      hash: sha256(bytes),
      fileCount: 6,
      invoiceCount: 3,
      outcome: 'invoices_imported',
      signatureVerification: 'not_performed',
    });
    expect(await service.invoiceArchives.import(f.actor, key(), { evidenceId: root.id })).toEqual(
      a,
    );
    expect(await service.invoiceArchives.get(f.actor, { evidenceId: root.id })).toEqual(a);
    expect((await service.invoices.list(f.actor, {})).items).toHaveLength(3);
    expect(
      await db.orm.select().from(journals).where(eq(journals.companyId, f.company.id)),
    ).toHaveLength(0);
    for (const [path, original] of [
      ['facturi/purchase.xml', xml],
      ['sale.xml', sale],
      ['credit.xml', credit],
      ['signature.xml', signatureXml],
    ]) {
      const member = a.entries.find((row) => row.path === path)!;
      expect((await service.documents.read(f.actor, member.evidenceId)).bytes).toEqual(
        Buffer.from(original),
      );
      if (member.invoiceId)
        expect(await service.invoices.get(f.actor, member.invoiceId)).toMatchObject({
          evidenceId: member.evidenceId,
        });
    }
    expect(
      a.entries.filter((row) => row.kind === 'signature').every((row) => row.invoiceId === null),
    ).toBe(true);
  });

  test('a rejected response archive remains evidence with no invoice or acceptance claim', async () => {
    const f = await fixture(),
      root = await source(
        f.actor,
        invoiceZip({ 'errors.xml': rejectionXml, 'signature.xml': signatureXml }),
      );
    expect(
      await service.invoiceArchives.import(f.actor, key(), { evidenceId: root.id }),
    ).toMatchObject({
      outcome: 'no_invoice',
      fileCount: 2,
      invoiceCount: 0,
      signatureVerification: 'not_performed',
    });
    expect((await service.invoices.list(f.actor, {})).items).toHaveLength(0);
  });

  test('plain XML identity survives archived formatting variants, duplicate members and paged provenance from several archives', async () => {
    const f = await fixture(),
      xml = invoiceXml(),
      plain = await source(f.actor, Buffer.from(xml), 'first.xml'),
      original = await service.invoices.import(f.actor, key(), { evidenceId: plain.id });
    const proof = await service.documents.record(f.actor, key(), {
      filename: 'service-proof.txt',
      mediaType: 'text/plain',
      bytes: Buffer.from('Independent registration and completed domestic service evidence'),
    });
    for (const regime of [
      { axis: 'vat', value: 'normal_vat' },
      { axis: 'vat_collection', value: 'no' },
    ])
      await service.foundation.recordRegime(f.actor, key(), {
        ...regime,
        effectiveFrom: '2026-01-01',
        evidenceId: proof.id,
      });
    const year = (await service.foundation.years(f.actor)).find((row) => row.kind === 'financial')!;
    await service.invoices.propose(f.actor, key(), {
      financialYearId: year.id,
      invoiceId: original.id,
      recognitionDate: '2026-10-01',
      serviceDate: '2026-10-01',
      taxPointDate: '2026-10-01',
      treatmentEvidenceId: proof.id,
      account: '628',
      deduction: 'full',
      counterpartyVatCollection: 'no',
    });
    const root = await source(
      f.actor,
      invoiceZip({
        'first.xml': xml.replace(/\n/g, '\r\n'),
        'second.xml': xml,
        'signature.xml': signatureXml,
      }),
    );
    const imported = await service.invoiceArchives.import(f.actor, key(), { evidenceId: root.id });
    expect(imported).toMatchObject({ fileCount: 3, invoiceCount: 1 });
    expect(
      imported.entries.filter((row) => row.kind === 'invoice').map((row) => row.invoiceId),
    ).toEqual([original.id, original.id]);
    expect(await service.invoices.get(f.actor, original.id)).toEqual(original);
    expect((await service.overview(f.actor)).invoiceArchiveCounts[original.id]).toBe(1);
    const another = await source(
      f.actor,
      invoiceZip({ 'renamed.xml': xml, 'signature.xml': signatureXml }),
    );
    await service.invoiceArchives.import(f.actor, key(), { evidenceId: another.id });
    expect((await service.overview(f.actor)).invoiceArchiveCounts[original.id]).toBe(2);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.invoiceArchives.sources(f.actor, {
        invoiceId: original.id,
        limit: 1,
        cursor,
      });
      seen.push(...page.items.map((row) => row.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
    expect((await service.invoices.list(f.actor, {})).items).toEqual([original]);
    expect(await service.invoices.import(f.actor, key(), { evidenceId: plain.id })).toEqual(
      original,
    );
  });

  test('an existing conflicting invoice and a conflict inside the same batch leave every imported record unchanged', async () => {
    const f = await fixture(),
      original = await source(f.actor, Buffer.from(invoiceXml()), 'first.xml');
    await service.invoices.import(f.actor, key(), { evidenceId: original.id });
    const root = await source(
        f.actor,
        invoiceZip({
          'first-new.xml': invoiceXml({ number: 'NEW' }),
          'last-conflict.xml': invoiceXml({ net: '200.00', tax: '42.00', gross: '242.00' }),
        }),
      ),
      before = await snapshot(f.actor);
    await expect(
      service.invoiceArchives.import(f.actor, key(), { evidenceId: root.id }),
    ).rejects.toMatchObject({ code: 'INVOICE_SOURCE_CONFLICT' });
    expect(await snapshot(f.actor)).toEqual(before);
    await rejectImport(
      invoiceZip({
        'a.xml': invoiceXml(),
        'b.xml': invoiceXml({ net: '200.00', tax: '42.00', gross: '242.00' }),
      }),
      'INVOICE_SOURCE_CONFLICT',
    );
  });

  test('a malformed last invoice, another company and unsafe supporting XML fail the whole batch', async () => {
    await rejectImport(invoiceZip({ 'a.xml': invoiceXml(), 'z.xml': '<Invoice>' }));
    await rejectImport(
      invoiceZip({
        'a.xml': invoiceXml(),
        'z.xml': invoiceXml({ number: 'OTHER' }).replaceAll('12345678', '11111111'),
      }),
      'INVOICE_COMPANY',
    );
    await rejectImport(
      invoiceZip({
        'a.xml': invoiceXml(),
        'signature.xml':
          '<!DOCTYPE Signature [<!ENTITY x SYSTEM "file:///etc/passwd">]><Signature>&x;</Signature>',
      }),
      'XML_DTD',
    );
    await rejectImport(
      invoiceZip({
        'a.xml': invoiceXml(),
        'wrong.xml': invoiceXml({ number: 'WRONG-NS' }).replace(
          'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
          'urn:wrong',
        ),
      }),
      'XML_INVOICE',
    );
  });

  test('unsafe, ambiguous and duplicate archive paths are rejected without filesystem extraction', async () => {
    for (const path of [
      '../invoice.xml',
      '/invoice.xml',
      'C:/invoice.xml',
      'a\\invoice.xml',
      './invoice.xml',
      'a//invoice.xml',
      'a/../invoice.xml',
      ' invoice.xml',
      'a./invoice.xml',
      'bad\u0000.xml',
      'bad\u202e.xml',
    ])
      await rejectImport(invoiceZip({ [path]: invoiceXml() }));
    await rejectImport(
      invoiceZip({ 'Invoice.xml': invoiceXml(), 'invoice.xml': invoiceXml() }),
      'ARCHIVE_DUPLICATE_PATH',
    );
    const exact = Buffer.from(invoiceZip({ 'a.xml': invoiceXml(), 'b.xml': invoiceXml() }, 0));
    for (let i = 0; i <= exact.length - 5; i++)
      if (exact.subarray(i, i + 5).toString() === 'b.xml') exact.write('a.xml', i);
    await rejectImport(exact, 'ARCHIVE_DUPLICATE_PATH');
  });

  test('CRC corruption, truncation, encrypted/special members and unsupported methods are rejected', async () => {
    const bytes = invoiceZip();
    await rejectImport(
      corruptEntry(bytes, (data, at) =>
        data.writeUInt32LE(data.readUInt32LE(at + 16) ^ 1, at + 16),
      ),
      'ARCHIVE_INTEGRITY',
    );
    await rejectImport(bytes.slice(0, -8), 'ARCHIVE_INVALID');
    await rejectImport(
      corruptEntry(bytes, (data, at) => data.writeUInt16LE(data.readUInt16LE(at + 8) | 1, at + 8)),
      'ARCHIVE_MEMBER',
    );
    await rejectImport(
      corruptEntry(bytes, (data, at) => data.writeUInt32LE((0o120777 * 65536) >>> 0, at + 38)),
      'ARCHIVE_MEMBER',
    );
    await rejectImport(
      corruptEntry(bytes, (data, at) => data.writeUInt16LE(12, at + 10)),
      'ARCHIVE_COMPRESSION',
    );
  });

  test('nested archives and unknown payloads cannot be hidden among valid invoices', async () => {
    await rejectImport(
      invoiceZip({ 'invoice.xml': invoiceXml(), 'nested.zip': invoiceZip() }),
      'ARCHIVE_NESTED',
    );
    await rejectImport(
      invoiceZip({ 'invoice.xml': invoiceXml(), 'disguised.pdf': invoiceZip() }),
      'ARCHIVE_NESTED',
    );
    await rejectImport(
      invoiceZip({ 'invoice.xml': invoiceXml(), 'program.exe': 'untrusted bytes' }),
      'ARCHIVE_MEMBER_TYPE',
    );
  });

  test('metadata, actual output, compression ratio, member count and compressed/expanded budgets are enforced', async () => {
    const bytes = invoiceZip();
    await rejectImport(
      corruptEntry(bytes, (data, at) => data.writeUInt32LE(10 * 1024 * 1024 + 1, at + 24)),
      'ARCHIVE_EXPANSION_LIMIT',
    );
    await rejectImport(corruptEntry(bytes, (data, at) => data.writeUInt32LE(10, at + 24)));
    await rejectImport(
      invoiceZip({ 'invoice.xml': invoiceXml(), 'bomb.pdf': '%PDF-' + '0'.repeat(1024 * 1024) }),
      'ARCHIVE_EXPANSION_LIMIT',
    );
    await rejectImport(
      invoiceZip(
        Object.fromEntries(
          Array.from({ length: 101 }, (_, i) => [`${i}.xml`, invoiceXml({ number: String(i) })]),
        ),
      ),
      'ARCHIVE_MEMBER_LIMIT',
    );
    await expect(parseInvoiceArchive(new Uint8Array(10 * 1024 * 1024 + 1))).rejects.toMatchObject({
      code: 'ARCHIVE_SIZE',
    });
    const block = randomBytes(16000),
      repeated = Buffer.concat([
        Buffer.from('%PDF-1.7\n'),
        ...Array.from({ length: 500 }, () => block),
      ]);
    // Independent repeated-block compression keeps each 8MB member below the ratio limit, while six exceed total output.
    await rejectImport(
      invoiceZip(Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`${i}.pdf`, repeated]))),
      'ARCHIVE_EXPANSION_LIMIT',
    );
  });

  test('an object-store failure rolls back all rows, and retry safely reuses any unreferenced content-addressed bytes', async () => {
    const f = await fixture(),
      root = await source(f.actor),
      before = await snapshot(f.actor);
    let writes = 0;
    const failing: ObjectStore = {
        get: (company, hash) => objects.get(company, hash),
        put: async (company, bytes, limit) => {
          if (++writes === 2) throw new Error('Synthetic object write failure');
          return objects.put(company, bytes, limit);
        },
      },
      instance = new Accounting(db, failing, secret),
      commandKey = key();
    await expect(
      instance.invoiceArchives.import(f.actor, commandKey, { evidenceId: root.id }),
    ).rejects.toThrow('Synthetic object write failure');
    expect(await snapshot(f.actor)).toEqual(before);
    expect(
      await service.invoiceArchives.import(f.actor, commandKey, { evidenceId: root.id }),
    ).toMatchObject({ invoiceCount: 1, fileCount: 2 });
  });

  test('company isolation and revoked/scoped grants are checked before parsing and before cached retries', async () => {
    const f = await fixture(),
      other = await fixture(),
      root = await source(f.actor);
    await expect(
      service.invoiceArchives.import(other.actor, key(), { evidenceId: root.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const grant = await service.agents.issue(f.actor, key(), {
      name: 'XML only',
      scopes: ['invoices.import'],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    await expect(
      service.invoiceArchives.import({ ...f.actor, agentId: grant.id }, key(), {
        evidenceId: root.id,
      }),
    ).rejects.toMatchObject({ code: 'AGENT_SCOPE' });
    const importer = await service.agents.issue(f.actor, key(), {
        name: 'Archive importer',
        scopes: ['invoices.importArchive', 'invoices.archive', 'invoices.sources'],
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
      actor = { ...f.actor, agentId: importer.id },
      commandKey = key(),
      result = await service.invoiceArchives.import(actor, commandKey, { evidenceId: root.id });
    await expect(
      service.invoiceArchives.get(other.actor, { evidenceId: root.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      service.invoiceArchives.sources(other.actor, {
        invoiceId: result.entries.find((row) => row.invoiceId)!.invoiceId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await service.agents.revoke(f.actor, key(), importer.id);
    await expect(
      service.invoiceArchives.import(actor, commandKey, { evidenceId: root.id }),
    ).rejects.toMatchObject({ code: 'AGENT_REVOKED' });
  });

  test('revocation during decompression prevents committing the prepared archive', async () => {
    const f = await fixture(),
      root = await source(f.actor),
      grant = await service.agents.issue(f.actor, key(), {
        name: 'Temporary importer',
        scopes: ['invoices.importArchive'],
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
    const blocking: ObjectStore = {
      put: (company, bytes, limit) => objects.put(company, bytes, limit),
      get: async (company, hash) => {
        await service.agents.revoke(f.actor, key(), grant.id);
        return objects.get(company, hash);
      },
    };
    await expect(
      new Accounting(db, blocking, secret).invoiceArchives.import(
        { ...f.actor, agentId: grant.id },
        key(),
        { evidenceId: root.id },
      ),
    ).rejects.toMatchObject({ code: 'AGENT_REVOKED' });
    expect((await service.invoices.list(f.actor, {})).items).toHaveLength(0);
  });

  test('archive manifests, projections, frozen exports and fresh restore preserve exact sources and replay behavior', async () => {
    const f = await fixture(),
      bytes = invoiceZip(),
      root = await source(f.actor, bytes),
      commandKey = key(),
      result = await service.invoiceArchives.import(f.actor, commandKey, { evidenceId: root.id });
    const job = await service.exports.request(f.actor, key());
    await runOneExport(db, objects);
    const data = JSON.parse(
      Buffer.from((await service.exports.download(f.actor, job.id)).bytes).toString(),
    ).data;
    expect(data.invoiceArchives).toHaveLength(1);
    expect(data.invoiceArchiveEntries).toHaveLength(2);
    await backup(db, objects, join(directory, 'archive-backup'));
    const restored = await restore(
        join(directory, 'archive-backup'),
        join(directory, 'archive-restored'),
      ),
      copyDb = new Database(restored.databaseUrl);
    try {
      await migrate(copyDb);
      const copy = new Accounting(copyDb, new LocalObjectStore(restored.objectDir), secret);
      expect(
        await copy.invoiceArchives.import(f.actor, commandKey, { evidenceId: root.id }),
      ).toEqual(result);
      expect(await copy.invoiceArchives.get(f.actor, { evidenceId: root.id })).toEqual(result);
      expect((await copy.documents.read(f.actor, root.id)).bytes).toEqual(Buffer.from(bytes));
      for (const member of result.entries)
        expect((await copy.documents.read(f.actor, member.evidenceId)).bytes).toEqual(
          (await service.documents.read(f.actor, member.evidenceId)).bytes,
        );
      for (const table of [invoiceArchives, invoiceArchiveEntries])
        await expect(
          copyDb.orm.delete(table).where(eq(table.companyId, f.company.id)).execute(),
        ).rejects.toThrow();
      await expect(
        copyDb.orm
          .update(invoiceArchives)
          .set({ invoiceCount: 0 })
          .where(eq(invoiceArchives.companyId, f.company.id))
          .execute(),
      ).rejects.toThrow();
      await expect(
        copyDb.orm
          .update(invoiceArchiveEntries)
          .set({ path: 'replacement.xml' })
          .where(eq(invoiceArchiveEntries.companyId, f.company.id))
          .execute(),
      ).rejects.toThrow();
      await expect(
        copyDb.orm
          .insert(invoiceArchiveEntries)
          .values({
            ...result.entries[0],
            companyId: f.company.id,
            id: key(),
            archiveEvidenceId: root.id,
            path: 'extra.xml',
          })
          .execute(),
      ).rejects.toThrow();
    } finally {
      await copyDb.close();
    }
  });

  test('database guards reject missing CRC fields, substituted bytes and inconsistent invoice counts', async () => {
    const f = await fixture(),
      root = await source(f.actor),
      result = await service.invoiceArchives.import(f.actor, key(), { evidenceId: root.id }),
      second = await source(
        f.actor,
        invoiceZip({ 'different.xml': invoiceXml({ number: 'DIFFERENT' }) }),
      );
    const [record] = await db.orm
      .select()
      .from(invoiceArchives)
      .where(eq(invoiceArchives.companyId, f.company.id));
    const base = {
      ...record,
      evidenceId: second.id,
      manifest: result.entries.map((row) => ({ ...row, id: key() })),
    };
    const withoutCrc = JSON.parse(JSON.stringify(base));
    delete withoutCrc.manifest[0].crc32;
    await expect(db.orm.insert(invoiceArchives).values(withoutCrc).execute()).rejects.toThrow();
    const substituted = {
      ...base,
      manifest: base.manifest.map((row, i) =>
        i === 0 ? { ...row, hash: sha256('not the retained member bytes') } : row,
      ),
    };
    await expect(db.orm.insert(invoiceArchives).values(substituted).execute()).rejects.toThrow();
    await expect(
      db.orm
        .insert(invoiceArchives)
        .values({ ...base, invoiceCount: 0 })
        .execute(),
    ).rejects.toThrow();
    expect(await service.invoiceArchives.get(f.actor, { evidenceId: root.id })).toEqual(result);
    expect(
      await db.orm
        .select()
        .from(invoiceArchives)
        .where(eq(invoiceArchives.companyId, f.company.id)),
    ).toHaveLength(1);
  });

  test('official SDK MCP imports and reads archive provenance without requiring invoice or evidence read scopes', async () => {
    const f = await fixture(),
      root = await source(f.actor),
      grant = await service.agents.issue(f.actor, key(), {
        name: 'MCP archive importer',
        scopes: ['invoices.importArchive', 'invoices.archive', 'invoices.sources'],
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
      publicUrl = 'http://localhost:3000',
      app = createApp(service, { publicUrl, authSecret: secret }).app,
      client = new Client(
        { name: 'archive-contract', version: '1' },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } },
      );
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`${publicUrl}/api/accounting/v1/companies/${f.company.id}/mcp`),
        {
          authProvider: { token: async () => grant.token },
          fetch: async (url, init) => {
            const request = new Request(url, init);
            request.headers.set('host', new URL(request.url).host);
            return app.fetch(request);
          },
        },
      ),
    );
    try {
      const names = (await client.listTools()).tools.map((row) => row.name);
      expect(names).toContain('invoices.importArchive');
      expect(names).not.toContain('books.approve');
      expect(names).not.toContain('evidence.read');
      const args = { input: { evidenceId: root.id }, idempotencyKey: key() },
        result = archiveOutput.parse(
          (await client.callTool({ name: 'invoices.importArchive', arguments: args }))
            .structuredContent,
        );
      expect(
        (await client.callTool({ name: 'invoices.importArchive', arguments: args }))
          .structuredContent,
      ).toEqual(result);
      expect(
        (
          await client.callTool({
            name: 'invoices.archive',
            arguments: { input: { evidenceId: root.id } },
          })
        ).structuredContent,
      ).toEqual(result);
      expect(
        (
          await client.callTool({
            name: 'invoices.sources',
            arguments: {
              input: {
                invoiceId: result.entries.find((row) => row.invoiceId)!.invoiceId,
                limit: 1,
              },
            },
          })
        ).isError,
      ).not.toBe(true);
      await service.agents.revoke(f.actor, key(), grant.id);
      await expect(
        client.callTool({ name: 'invoices.importArchive', arguments: args }),
      ).rejects.toThrow('Unauthorized');
    } finally {
      await client.close();
    }
  });
});
