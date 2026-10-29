import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate as migrateDrizzle } from 'drizzle-orm/libsql/migrator';
import { Accounting } from '../../source/accounting/application';
import { Database } from '../../source/accounting/db';
import { createAuth } from '../../source/accounting/auth';
import { migrate } from '../../source/accounting/migrate';
import { LocalObjectStore } from '../../source/accounting/object-store';
import { generalBodySchema } from '../../source/accounting/domain';
import {
  approvals,
  commands,
  evidence,
  facts,
  proposals,
  journals,
  journalLines,
  invoiceDocuments,
  invoicePostings,
  advancePayments,
  advanceRefunds,
  movementPostings,
} from '../../source/accounting/schema';

import { invoiceXml } from './fixtures/invoice';
import { allowanceInvoiceXml } from './fixtures/invoice-allowance';
import { parseInvoiceXml } from '../../source/accounting/invoice-document';
import { retainInvoice } from '../../source/accounting/invoices';
import { invoiceZip } from './fixtures/archive';

for (const baseline of [49])
  test.each(['purchase', 'sale'] as const)(
    `populated 00${baseline} %s invoices and exact approvals survive the allowance parser and guard upgrade`,
    async (direction) => {
      const folder = await mkdtemp(join(tmpdir(), 'xfactura-allowance-upgrade-')),
        db = new Database(`file:${folder}/books.db`),
        key = () => randomUUID();
      try {
        const previous = join(folder, 'old'),
          source = new URL('../../source/accounting/migrations/', import.meta.url);
        await mkdir(join(previous, 'meta'), { recursive: true });
        const manifest = JSON.parse(await readFile(new URL('meta/_journal.json', source), 'utf8')),
          entries = manifest.entries.filter((e: { idx: number }) => e.idx <= baseline);
        await writeFile(
          join(previous, 'meta/_journal.json'),
          JSON.stringify({ ...manifest, entries }),
        );
        for (const e of entries)
          await copyFile(new URL(`${e.tag}.sql`, source), join(previous, `${e.tag}.sql`));
        await db.initialize();
        await migrateDrizzle(db.orm, { migrationsFolder: previous });
        const secret = 'synthetic-allowance-upgrade-secret-at-least-32-characters',
          owner = await createAuth(
            db,
            { publicUrl: 'http://localhost:3000', authSecret: secret },
            true,
          ).api.signUpEmail({
            body: {
              email: 'upgrade@example.test',
              name: 'Upgrade reviewer',
              password: 'synthetic-upgrade-password',
            },
          }),
          service = new Accounting(db, new LocalObjectStore(join(folder, 'objects')), secret),
          company = await service.companies.create(owner.user.id, key(), {
            name: 'Existing advances SRL',
            cui: '12345678',
            year: 2026,
          }),
          actor = { companyId: company.id, actorId: owner.user.id },
          year = (await service.foundation.years(actor)).find((row) => row.kind === 'financial')!;
        const proof = await service.documents.record(actor, key(), {
          filename: 'contract.txt',
          mediaType: 'text/plain',
          bytes: Buffer.from('Retained contract for three independent service advances'),
        });
        async function post(p: { id: string; version: number; hash: string }, commandKey = key()) {
          await service.books.approve(actor, key(), p.id, { version: p.version, hash: p.hash });
          return service.ledger.post(actor, commandKey, {
            id: p.id,
            version: p.version,
            hash: p.hash,
          });
        }
        for (const item of [
          { axis: 'vat', value: 'normal_vat' },
          { axis: 'vat_collection', value: 'no' },
        ])
          await service.foundation.recordRegime(actor, key(), {
            ...item,
            effectiveFrom: '2026-01-01',
            evidenceId: proof.id,
          });
        await post(
          await service.ledger.propose(actor, key(), {
            financialYearId: year.id,
            evidenceId: proof.id,
            date: '2026-01-01',
            purpose: 'opening',
            description: 'Retained opening',
            sourceReference: 'opening',
            lines: [
              { account: '5121', debit: '1000.00', credit: '0.00' },
              { account: '1012', debit: '0.00', credit: '1000.00' },
            ],
          }),
        );
        async function document(contents: string, filename = `${key()}.xml`) {
          return service.documents.record(actor, key(), {
            filename,
            mediaType: filename.endsWith('.zip') ? 'application/zip' : 'application/xml',
            bytes: Buffer.from(contents),
          });
        }
        function input(invoiceId: string) {
          return {
            financialYearId: year.id,
            invoiceId,
            recognitionDate: '2026-02-01',
            serviceDate: '2026-02-01',
            taxPointDate: '2026-02-01',
            treatmentEvidenceId: proof.id,
            account: direction === 'purchase' ? '628' : '704',
            deduction: direction === 'purchase' ? 'full' : 'none',
            counterpartyVatCollection: 'no',
          };
        }
        async function ordinary() {
          const file = await document(invoiceXml({ number: key(), date: '2026-02-01', direction })),
            invoice = await service.invoices.import(actor, key(), { evidenceId: file.id });
          return service.invoices.propose(actor, key(), input(invoice.id));
        }
        await post(await ordinary());
        const pending = await ordinary();
        await service.books.approve(actor, key(), pending.id, {
          version: pending.version,
          hash: pending.hash,
        });
        const legacyXml = allowanceInvoiceXml({ number: key(), date: '2026-02-01', direction }),
          legacySource = await document(legacyXml),
          { documentAdjustments: _details, ...oldShape } = parseInvoiceXml(Buffer.from(legacyXml)),
          legacy = await db.write((tx) =>
            retainInvoice(tx, actor, legacySource.id, {
              ...oldShape,
              parserVersion: 'ubl-invoice-1',
            }),
          );
        const legacyV2Source = await document(
            legacyXml
              .replace('InvoiceTypeCode>380<', 'InvoiceTypeCode>386<')
              .replace(oldShape.number, key()),
          ),
          { documentAdjustments: _v2details, ...v2Shape } = parseInvoiceXml(
            (await service.documents.read(actor, legacyV2Source.id)).bytes,
          ),
          legacyV2 = await db.write((tx) =>
            retainInvoice(tx, actor, legacyV2Source.id, {
              ...v2Shape,
              parserVersion: 'ubl-invoice-2',
            }),
          );
        const tables = {
            approvals,
            commands,
            evidence,
            facts,
            proposals,
            journals,
            journalLines,
            invoiceDocuments,
            invoicePostings,
          },
          before = new Map<string, unknown>();
        for (const [name, table] of Object.entries(tables))
          before.set(name, await db.orm.select().from(table));
        await migrate(db);
        await migrate(db);
        for (const [name, table] of Object.entries(tables))
          expect(before.get(name)).toEqual(await db.orm.select().from(table));
        const exact = { id: pending.id, version: pending.version, hash: pending.hash },
          commandKey = key(),
          posted = await service.ledger.post(actor, commandKey, exact);
        expect(await service.ledger.post(actor, commandKey, exact)).toEqual(posted);
        expect(
          await service.invoices.import(actor, key(), { evidenceId: legacySource.id }),
        ).toEqual(legacy);
        expect(
          await service.invoices.import(actor, key(), { evidenceId: legacyV2Source.id }),
        ).toEqual(legacyV2);
        const archive = await service.documents.record(actor, key(), {
            filename: 'old-source.zip',
            mediaType: 'application/zip',
            bytes: invoiceZip({ 'old.xml': legacyXml }),
          }),
          imported = await service.invoiceArchives.import(actor, key(), { evidenceId: archive.id });
        expect(imported.entries[0].invoiceId).toBe(legacy.id);
        const variant = await document(legacyXml.replaceAll('><', '>\n<'));
        await expect(
          service.invoices.import(actor, key(), { evidenceId: variant.id }),
        ).rejects.toMatchObject({ code: 'INVOICE_SOURCE_CONFLICT' });
        await expect(
          service.invoices.propose(actor, key(), {
            ...input(legacy.id),
            documentAllowance: 'commercial_price_reduction',
          }),
        ).rejects.toMatchObject({ code: 'INVOICE_ALLOWANCE_DETAILS' });
        expect(await service.invoices.get(actor, legacy.id)).toEqual(legacy);
        const current = await document(
            allowanceInvoiceXml({ number: key(), direction, date: '2026-02-01' }),
          ),
          invoice = await service.invoices.import(actor, key(), { evidenceId: current.id });
        const p = await service.invoices.propose(actor, key(), {
          ...input(invoice.id),
          documentAllowance: 'commercial_price_reduction',
        });
        await post(p);
        expect(generalBodySchema.parse(p.body).invoice!.documentAllowance).toMatchObject({
          lineNet: '100.00',
          total: '20.00',
          net: '80.00',
        });
        expect((await db.client.execute('PRAGMA foreign_key_check')).rows).toHaveLength(0);
        expect((await db.client.execute('PRAGMA integrity_check')).rows[0].integrity_check).toBe(
          'ok',
        );
      } finally {
        await db.close();
        await rm(folder, { recursive: true, force: true });
      }
    },
  );
