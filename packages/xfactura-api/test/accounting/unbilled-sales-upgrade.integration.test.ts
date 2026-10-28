import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate as migrateDrizzle } from 'drizzle-orm/libsql/migrator';
import { Accounting } from '../../source/accounting/application';
import { createAuth } from '../../source/accounting/auth';
import { Database } from '../../source/accounting/db';
import { migrate } from '../../source/accounting/migrate';
import { LocalObjectStore } from '../../source/accounting/object-store';
import {
  accrualMatches,
  accrualAdjustments,
  accrualPostings,
  approvals,
  commands,
  evidence,
  facts,
  invoiceDocuments,
  invoicePostings,
  journalLines,
  journals,
  proposals,
  unbilledSaleMatches,
  unbilledSalePostings,
} from '../../source/accounting/schema';
import { invoiceXml } from './fixtures/invoice';

test.each([
  { baseline: 15 },
  { baseline: 17 },
  { baseline: 19 },
  { baseline: 23 },
  { baseline: 25 },
])(
  'populated 00$baseline books upgrade without rewriting evidence, approved treatments, matches or cached commands',
  async ({ baseline }) => {
    const directory = await mkdtemp(join(tmpdir(), 'xfactura-unbilled-upgrade-')),
      db = new Database(`file:${directory}/books.db`),
      key = () => randomUUID();
    try {
      const folder = join(directory, 'previous-migrations'),
        source = new URL('../../source/accounting/migrations/', import.meta.url);
      await mkdir(join(folder, 'meta'), { recursive: true });
      const journal = JSON.parse(await readFile(new URL('meta/_journal.json', source), 'utf8')),
        entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= baseline);
      await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
      for (const entry of entries)
        await copyFile(new URL(`${entry.tag}.sql`, source), join(folder, `${entry.tag}.sql`));
      await db.initialize();
      await migrateDrizzle(db.orm, { migrationsFolder: folder });
      const secret = 'synthetic-unbilled-upgrade-secret-at-least-32-characters',
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
        });
      const service = new Accounting(db, new LocalObjectStore(join(directory, 'objects')), secret),
        company = await service.companies.create(owner.user.id, key(), {
          name: 'Existing accrual SRL',
          cui: '12345678',
          year: 2026,
        }),
        actor = { actorId: owner.user.id, companyId: company.id },
        financialYear = (await service.foundation.years(actor)).find(
          (row) => row.kind === 'financial',
        )!;
      const proof = await service.documents.record(actor, key(), {
        filename: 'services.txt',
        mediaType: 'text/plain',
        bytes: Buffer.from('Retained service and registration evidence predating the upgrade'),
      });
      for (const input of [
        { axis: 'vat', value: 'normal_vat' },
        { axis: 'vat_collection', value: 'no' },
      ])
        await service.foundation.recordRegime(actor, key(), {
          ...input,
          effectiveFrom: '2026-01-01',
          evidenceId: proof.id,
        });
      async function post(
        proposal: { id: string; version: number; hash: string },
        commandKey = key(),
      ) {
        const input = { id: proposal.id, version: proposal.version, hash: proposal.hash };
        await service.books.approve(actor, key(), proposal.id, {
          version: proposal.version,
          hash: proposal.hash,
        });
        return service.ledger.post(actor, commandKey, input);
      }
      await post(
        await service.ledger.propose(actor, key(), {
          financialYearId: financialYear.id,
          evidenceId: proof.id,
          date: '2026-01-01',
          purpose: 'opening',
          description: 'Opening before upgrade',
          sourceReference: 'opening',
          lines: [
            { account: '5121', debit: '1000.00', credit: '0.00' },
            { account: '1012', debit: '0.00', credit: '1000.00' },
          ],
        }),
      );
      const original = await service.accruals.propose(actor, key(), {
        financialYearId: financialYear.id,
        evidenceId: proof.id,
        evidenceDate: '2026-01-31',
        reference: 'PRE-UPGRADE',
        date: '2026-01-31',
        serviceFrom: '2026-01-01',
        serviceTo: '2026-01-31',
        supplier: { name: 'Supplier SRL', taxId: '87654321', country: 'RO' },
        currency: 'RON',
        account: '628',
        net: '100.00',
        vatCategory: 'S',
        taxPointDate: '2026-01-31',
        deduction: 'full',
        counterpartyVatCollection: 'no',
        reason: 'Service acceptance retained before the invoice and schema upgrade',
      });
      await post(original);
      if (baseline >= 19) {
        const changed = await service.documents.record(actor, key(), {
          filename: 'new-estimate.txt',
          mediaType: 'text/plain',
          bytes: Buffer.from('Separately retained new price information before upgrade'),
        });
        await post(
          await service.accruals.proposeAdjustment(actor, key(), {
            financialYearId: financialYear.id,
            accrualId: original.id,
            reference: 'PRE-UPGRADE-ESTIMATE',
            evidenceId: changed.id,
            evidenceDate: '2026-02-01',
            newInformationDate: '2026-02-01',
            date: '2026-02-01',
            periodBasis: 'current_year_estimate_change',
            action: 'reestimate',
            remainingNet: '120.00',
            reason:
              'New documented price information retained before adding subscription allocations',
          }),
        );
      }
      const xml = await service.documents.record(actor, key(), {
          filename: 'invoice.xml',
          mediaType: 'application/xml',
          bytes: Buffer.from(invoiceXml({ date: '2026-02-10', taxPointDate: '2026-01-31' })),
        }),
        invoice = await service.invoices.import(actor, key(), { evidenceId: xml.id });
      const matched = await service.accruals.matchInvoice(actor, key(), {
          financialYearId: financialYear.id,
          invoiceId: invoice.id,
          recognitionDate: '2026-02-10',
          receivedDate: '2026-02-10',
          receiptEvidenceId: proof.id,
          allocations: [{ accrualId: original.id, net: '100.00', tax: '21.00' }],
        }),
        commandKey = key(),
        entry = await post(matched, commandKey);
      if (baseline >= 17) {
        await post(
          await service.unbilledSales.propose(actor, key(), {
            financialYearId: financialYear.id,
            evidenceId: proof.id,
            evidenceDate: '2026-02-28',
            reference: 'PRE-UPGRADE-SALE',
            date: '2026-02-28',
            serviceFrom: '2026-02-01',
            serviceTo: '2026-02-28',
            customer: { name: 'Customer SRL', taxId: '87654321', country: 'RO' },
            currency: 'RON',
            account: '704',
            net: '100.00',
            vatCategory: 'S',
            taxPointDate: '2026-02-28',
            taxPointBasis: 'completed_service',
            reason: 'Completed services retained before adding accrual adjustments',
          }),
        );
      }
      const tables = {
          commands,
          evidence,
          facts,
          proposals,
          approvals,
          journals,
          journalLines,
          invoiceDocuments,
          invoicePostings,
          accrualPostings,
          accrualMatches,
          ...(baseline >= 17 ? { unbilledSalePostings, unbilledSaleMatches } : {}),
          ...(baseline >= 19 ? { accrualAdjustments } : {}),
        },
        preserved = new Map<string, unknown>();
      for (const [name, table] of Object.entries(tables))
        preserved.set(name, await db.orm.select().from(table));
      const before = await service.accruals.get(actor, { id: original.id, date: '2026-02-28' });
      await migrate(db);
      await migrate(db);
      for (const [name, table] of Object.entries(tables))
        expect(preserved.get(name)).toEqual(await db.orm.select().from(table));
      expect(await service.invoices.import(actor, key(), { evidenceId: xml.id })).toEqual(invoice);
      expect(await db.orm.select().from(unbilledSalePostings)).toHaveLength(baseline >= 17 ? 1 : 0);
      expect(await db.orm.select().from(unbilledSaleMatches)).toHaveLength(0);
      expect(await service.accruals.get(actor, { id: original.id, date: '2026-02-28' })).toEqual(
        before,
      );
      expect(
        await service.ledger.post(actor, commandKey, {
          id: matched.id,
          version: matched.version,
          hash: matched.hash,
        }),
      ).toEqual(entry);
      expect(await service.vat.summary(actor, { financialYearId: financialYear.id })).toMatchObject(
        {
          status: 'reconciled',
          totals: { inputTax: '21.00', outputTax: baseline >= 17 ? '21.00' : '0.00' },
          unbilledSaleEntryCount: baseline >= 17 ? 1 : 0,
        },
      );
      await expect(db.orm.delete(accrualMatches).execute()).rejects.toThrow();
      await expect(db.orm.update(journalLines).set({ debitBani: 0n }).execute()).rejects.toThrow();
      const sale = await service.unbilledSales.propose(actor, key(), {
        financialYearId: financialYear.id,
        evidenceId: proof.id,
        evidenceDate: '2026-02-28',
        reference: 'POST-UPGRADE',
        date: '2026-02-28',
        serviceFrom: '2026-02-01',
        serviceTo: '2026-02-28',
        customer: { name: 'Customer SRL', taxId: '87654321', country: 'RO' },
        currency: 'RON',
        account: '704',
        net: '200.00',
        vatCategory: 'S',
        taxPointDate: '2026-02-28',
        taxPointBasis: 'completed_service',
        reason: 'Completed and accepted services following the schema upgrade',
      });
      await post(sale);
      expect(
        await service.unbilledSales.get(actor, { id: sale.id, date: '2026-02-28' }),
      ).toMatchObject({ gross: '242.00', remainingGross: '242.00' });
      expect((await db.client.execute('PRAGMA foreign_key_check')).rows).toHaveLength(0);
      expect((await db.client.execute('PRAGMA integrity_check')).rows[0].integrity_check).toBe(
        'ok',
      );
    } finally {
      await db.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
