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
import { chargeInvoiceXml } from './fixtures/invoice-charge';

for (const baseline of [50])
  test.each(['purchase', 'sale'] as const)(
    `populated 00${baseline} %s invoices and exact approvals survive the service-charge guard upgrade`,
    async (direction) => {
      const folder = await mkdtemp(join(tmpdir(), 'xfactura-charge-upgrade-')),
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
        const secret = 'synthetic-charge-upgrade-secret-at-least-32-characters',
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
            name: 'Existing invoice SRL',
            cui: '12345678',
            year: 2026,
          }),
          actor = { companyId: company.id, actorId: owner.user.id },
          year = (await service.foundation.years(actor)).find((row) => row.kind === 'financial')!;
        const proof = await service.documents.record(actor, key(), {
          filename: 'contract.txt',
          mediaType: 'text/plain',
          bytes: Buffer.from('Retained registration and performed-service evidence'),
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
        async function importSource(xml: string) {
          const source = await service.documents.record(actor, key(), {
            filename: `${key()}.xml`,
            mediaType: 'application/xml',
            bytes: Buffer.from(xml),
          });
          return service.invoices.import(actor, key(), { evidenceId: source.id });
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
        const pending: Array<{ id: string; version: number; hash: string }> = [];
        for (const withAllowance of [false, true]) {
          for (const posted of [true, false]) {
            const invoice = await importSource(
                (withAllowance ? allowanceInvoiceXml : invoiceXml)({
                  number: key(),
                  date: '2026-02-01',
                  direction,
                }),
              ),
              proposal = await service.invoices.propose(actor, key(), {
                ...input(invoice.id),
                ...(withAllowance ? { documentAllowance: 'commercial_price_reduction' } : {}),
              });
            expect(generalBodySchema.parse(proposal.body).invoice!.documentCharge).toBeUndefined();
            if (posted) await post(proposal);
            else {
              await service.books.approve(actor, key(), proposal.id, {
                version: proposal.version,
                hash: proposal.hash,
              });
              pending.push(proposal);
            }
          }
        }
        const sources: Array<{
          mixed: boolean;
          document: Awaited<ReturnType<typeof importSource>>;
        }> = [];
        for (const mixed of [false, true])
          sources.push({
            mixed,
            document: await importSource(
              chargeInvoiceXml({
                number: key(),
                date: '2026-02-01',
                direction,
                ...(mixed
                  ? { allowance: '20.00', net: '90.00', tax: '18.90', gross: '108.90' }
                  : {}),
              }),
            ),
          });
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
        for (const p of pending) {
          const executionKey = key(),
            exact = { id: p.id, version: p.version, hash: p.hash },
            result = await service.ledger.post(actor, executionKey, exact);
          expect(await service.ledger.post(actor, executionKey, exact)).toEqual(result);
        }
        for (const { mixed, document } of sources) {
          expect(await service.invoices.get(actor, document.id)).toEqual(document);
          const proposal = await service.invoices.propose(actor, key(), {
            ...input(document.id),
            documentCharge: 'service_price_component',
            ...(mixed ? { documentAllowance: 'commercial_price_reduction' } : {}),
          });
          await post(proposal);
          expect(generalBodySchema.parse(proposal.body).invoice!.documentCharge).toMatchObject({
            total: '10.00',
            allowances: mixed ? '20.00' : '0.00',
            net: mixed ? '90.00' : '110.00',
          });
        }
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
