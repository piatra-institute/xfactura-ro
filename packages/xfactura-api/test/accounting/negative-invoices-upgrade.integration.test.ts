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
} from '../../source/accounting/schema';
import { invoiceXml } from './fixtures/invoice';
import { chargeInvoiceXml } from './fixtures/invoice-charge';
import { negativeInvoiceXml } from './fixtures/negative-invoice';

test.each(['purchase', 'sale'] as const)(
  'populated 0051 %s books and pending 381 approvals survive negative-invoice support',
  async (direction) => {
    const directory = await mkdtemp(join(tmpdir(), 'xfactura-negative-upgrade-')),
      db = new Database(`file:${directory}/books.db`),
      key = () => randomUUID();
    try {
      const previous = join(directory, 'old'),
        source = new URL('../../source/accounting/migrations/', import.meta.url);
      await mkdir(join(previous, 'meta'), { recursive: true });
      const manifest = JSON.parse(await readFile(new URL('meta/_journal.json', source), 'utf8')),
        entries = manifest.entries.filter((e: { idx: number }) => e.idx <= 51);
      await writeFile(
        join(previous, 'meta/_journal.json'),
        JSON.stringify({ ...manifest, entries }),
      );
      for (const e of entries)
        await copyFile(new URL(`${e.tag}.sql`, source), join(previous, `${e.tag}.sql`));
      await db.initialize();
      await migrateDrizzle(db.orm, { migrationsFolder: previous });
      const secret = 'synthetic-negative-upgrade-secret-at-least-32-characters',
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
        service = new Accounting(db, new LocalObjectStore(join(directory, 'objects')), secret),
        company = await service.companies.create(owner.user.id, key(), {
          name: 'Existing source SRL',
          cui: '12345678',
          year: 2026,
        }),
        actor = { companyId: company.id, actorId: owner.user.id },
        year = (await service.foundation.years(actor)).find((r) => r.kind === 'financial')!,
        proof = await service.documents.record(actor, key(), {
          filename: 'contract.txt',
          mediaType: 'text/plain',
          bytes: Buffer.from('Retained registration, service and cancellation evidence'),
        });
      async function imported(xml: string) {
        const source = await service.documents.record(actor, key(), {
          filename: `${key()}.xml`,
          mediaType: 'application/xml',
          bytes: Buffer.from(xml),
        });
        return service.invoices.import(actor, key(), { evidenceId: source.id });
      }
      async function post(p: { id: string; version: number; hash: string }) {
        await service.books.approve(actor, key(), p.id, { version: p.version, hash: p.hash });
        return service.ledger.post(actor, key(), { id: p.id, version: p.version, hash: p.hash });
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
      const originals = [];
      for (const charged of [false, true]) {
        const original = await imported(
          (charged ? chargeInvoiceXml : invoiceXml)({
            number: key(),
            date: '2026-02-01',
            direction,
          }),
        );
        await post(
          await service.invoices.propose(actor, key(), {
            invoiceId: original.id,
            financialYearId: year.id,
            recognitionDate: '2026-02-01',
            serviceDate: '2026-02-01',
            taxPointDate: '2026-02-01',
            treatmentEvidenceId: proof.id,
            account: direction === 'purchase' ? '628' : '704',
            deduction: direction === 'purchase' ? 'full' : 'none',
            counterpartyVatCollection: 'no',
            ...(charged ? { documentCharge: 'service_price_component' } : {}),
          }),
        );
        originals.push(original);
      }
      const advance = await imported(
        invoiceXml({ number: key(), direction }).replace('TypeCode>380<', 'TypeCode>386<'),
      );
      expect(advance.body.parserVersion).toBe('ubl-invoice-2');
      const original = originals[0],
        credits = [];
      function request(invoiceId: string, date: string) {
        return {
          financialYearId: year.id,
          invoiceId,
          originalInvoiceId: original.id,
          recognitionDate: date,
          decisionDate: date,
          treatmentEvidenceId: proof.id,
          kind: 'cancellation',
          periodBasis: 'current_period_event',
          reason: 'Retained current event cancels part of the original service',
        };
      }
      for (const posted of [true, false]) {
        const xml = invoiceXml({
            credit: true,
            number: key(),
            originalNumber: original.body.number,
            date: '2026-03-01',
            direction,
            net: '10.00',
            tax: '2.10',
            gross: '12.10',
          }),
          invoice = await imported(xml),
          proposal = await service.invoices.proposeCreditNote(
            actor,
            key(),
            request(invoice.id, '2026-03-01'),
          );
        if (posted) await post(proposal);
        else
          await service.books.approve(actor, key(), proposal.id, {
            version: proposal.version,
            hash: proposal.hash,
          });
        credits.push({ xml, invoice, proposal, posted });
      }
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
      for (const c of credits) {
        expect(await imported(c.xml)).toEqual(c.invoice);
        if (!c.posted) {
          const executionKey = key(),
            input = { id: c.proposal.id, version: c.proposal.version, hash: c.proposal.hash },
            result = await service.ledger.post(actor, executionKey, input);
          expect(await service.ledger.post(actor, executionKey, input)).toEqual(result);
        }
      }
      const negative = await imported(
          negativeInvoiceXml({
            number: key(),
            originalNumber: original.body.number,
            originalDate: original.body.issueDate,
            direction,
            date: '2026-04-01',
            net: '10.00',
            tax: '2.10',
            gross: '12.10',
          }),
        ),
        prepared = await service.invoices.proposeCreditNote(
          actor,
          key(),
          request(negative.id, '2026-04-01'),
        );
      expect(generalBodySchema.parse(prepared.body).invoice!.sourceCredit!.gross).toBe('-12.10');
      await post(prepared);
      await expect(
        imported(
          negativeInvoiceXml({
            number: credits[0].invoice.body.number,
            direction,
            date: '2026-03-01',
          }),
        ),
      ).rejects.toMatchObject({ code: 'INVOICE_SOURCE_CONFLICT' });
      expect(
        await service.positions.read(actor, { invoiceId: original.id, date: '2026-04-30' }),
      ).toMatchObject({ balance: '84.70' });
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
