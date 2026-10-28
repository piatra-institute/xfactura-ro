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
import { LocalObjectStore, sha256 } from '../../source/accounting/object-store';
import { canonical, generalBodySchema } from '../../source/accounting/domain';
import { generalBody } from '../../source/accounting/general-ledger';
import { postJournal } from '../../source/accounting/ledger';
import {
  approvals,
  commands,
  deferralPostings,
  deferralReleases,
  evidence,
  facts,
  invoiceDocuments,
  invoicePostings,
  journalLines,
  journals,
  proposals,
} from '../../source/accounting/schema';
import { invoiceXml } from './fixtures/invoice';

test.each([{ baseline: 21 }, { baseline: 29 }, { baseline: 30 }])(
  'populated 00$baseline subscription books and a pending exact approval survive later migrations',
  async ({ baseline }) => {
    const directory = await mkdtemp(join(tmpdir(), 'xfactura-deferral-upgrade-')),
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
      const secret = 'synthetic-deferral-upgrade-secret-at-least-32-characters',
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
          name: 'Existing subscription SRL',
          cui: '12345678',
          year: 2026,
        }),
        actor = { actorId: owner.user.id, companyId: company.id },
        year = (await service.foundation.years(actor)).find((row) => row.kind === 'financial')!;
      async function retain(filename: string, contents: string) {
        return service.documents.record(actor, key(), {
          filename,
          mediaType: filename.endsWith('.xml') ? 'application/xml' : 'text/plain',
          bytes: Buffer.from(contents),
        });
      }
      async function post(
        proposal: { id: string; version: number; hash: string },
        commandKey = key(),
      ) {
        await service.books.approve(actor, key(), proposal.id, {
          version: proposal.version,
          hash: proposal.hash,
        });
        return service.ledger.post(actor, commandKey, {
          id: proposal.id,
          version: proposal.version,
          hash: proposal.hash,
        });
      }
      const proof = await retain(
        'contract.txt',
        'Uniform January to March subscription agreed before the schema upgrade',
      );
      for (const input of [
        { axis: 'vat', value: 'normal_vat' },
        { axis: 'vat_collection', value: 'no' },
      ])
        await service.foundation.recordRegime(actor, key(), {
          ...input,
          effectiveFrom: '2026-01-01',
          evidenceId: proof.id,
        });
      await post(
        await service.ledger.propose(actor, key(), {
          financialYearId: year.id,
          evidenceId: proof.id,
          date: year.from,
          purpose: 'opening',
          description: 'Opening before upgrade',
          sourceReference: 'opening',
          lines: [
            { account: '5121', debit: '1000.00', credit: '0.00' },
            { account: '1012', debit: '0.00', credit: '1000.00' },
          ],
        }),
      );
      const xml = await retain(
          'invoice.xml',
          invoiceXml({ date: '2026-01-01', number: 'PRE-UPGRADE' }),
        ),
        invoice = await service.invoices.import(actor, key(), { evidenceId: xml.id }),
        root = await service.deferrals.proposeInvoice(actor, key(), {
          financialYearId: year.id,
          invoiceId: invoice.id,
          recognitionDate: '2026-01-01',
          evidenceId: proof.id,
          taxPointBasis: 'early_invoice',
          account: '628',
          deduction: 'full',
          counterpartyVatCollection: 'no',
          basis: 'uniform_subscription',
          method: 'equal_calendar_months',
          serviceFrom: '2026-01-01',
          serviceTo: '2026-03-31',
          evidenceDate: '2026-01-01',
          reason: 'Uniform monthly subscription documented before introducing cancellation',
        }),
        rootEntry = await post(root),
        interpretation = generalBodySchema.parse(root.body).invoice!;
      // Serialize the old contract against the old schema; the new cancellation table does not exist yet.
      async function oldRelease(month: string, date: string, shouldPost: boolean) {
        const body = generalBody({
          financialYearId: year.id,
          evidenceId: proof.id,
          date,
          purpose: 'general',
          description: `Cheltuială aferentă perioadei · PRE-UPGRADE · ${month.slice(0, 7)}`,
          sourceReference: `deferral-release:${root.id}:${month}`,
          lines: [
            { account: '628', debit: '33.33', credit: '0.00' },
            { account: '471', debit: '0.00', credit: '33.33' },
          ],
          deferralRelease: {
            schemaVersion: 1,
            deferralId: root.id,
            month,
            date,
            amount: '33.33',
            sourceInvoiceId: invoice.id,
            sourceJournalId: rootEntry.id,
            sourceFinancialYearId: year.id,
            sourceProposalHash: root.hash,
            evidenceHash: proof.hash,
            direction: 'purchase',
            account: '628',
            controlAccount: '471',
            ruleId: interpretation.ruleId,
            ruleHash: interpretation.ruleHash,
            registrationIds: interpretation.registrationIds,
          },
        });
        const proposal = await db.write(async (tx) => {
          const factId = key(),
            hash = sha256(canonical({ kind: 'general', version: 1, body, factId }));
          await tx.insert(facts).values({
            id: factId,
            companyId: company.id,
            kind: 'general',
            evidenceId: proof.id,
            body,
            createdBy: actor.actorId,
          });
          const [row] = await tx
            .insert(proposals)
            .values({
              id: key(),
              companyId: company.id,
              factId,
              kind: 'general',
              version: 1,
              hash,
              body,
              sourceKey: key(),
              createdBy: actor.actorId,
            })
            .returning();
          return row;
        });
        const approval = await service.books.approve(actor, key(), proposal.id, {
          version: proposal.version,
          hash: proposal.hash,
        });
        if (shouldPost)
          await db.write((tx) =>
            postJournal(tx, actor, {
              date,
              kind: 'general',
              sourceId: proposal.id,
              approvalId: approval.id,
              evidenceId: proof.id,
              description: body.description,
              lines: body.lines,
            }),
          );
        return proposal;
      }
      await oldRelease('2026-01-01', '2026-01-31', true);
      const pending = await oldRelease('2026-02-01', '2026-02-28', false),
        tables = {
          commands,
          evidence,
          facts,
          proposals,
          approvals,
          journals,
          journalLines,
          invoiceDocuments,
          invoicePostings,
          deferralPostings,
          deferralReleases,
        },
        preserved = new Map<string, unknown>();
      for (const [name, table] of Object.entries(tables))
        preserved.set(name, await db.orm.select().from(table));
      await migrate(db);
      await migrate(db);
      for (const [name, table] of Object.entries(tables))
        expect(preserved.get(name)).toEqual(await db.orm.select().from(table));
      const commandKey = key(),
        input = { id: pending.id, version: pending.version, hash: pending.hash },
        entry = await service.ledger.post(actor, commandKey, input);
      expect(await service.ledger.post(actor, commandKey, input)).toEqual(entry);
      expect(await service.deferrals.get(actor, { id: root.id, date: '2026-02-28' })).toMatchObject(
        {
          allocated: '66.66',
          cancelled: '0.00',
          remaining: '33.34',
        },
      );
      const agreement = await retain(
          'cancellation.txt',
          'New agreement cancels only the unprovided March services',
        ),
        creditXml = await retain(
          'credit.xml',
          invoiceXml({
            credit: true,
            originalNumber: 'PRE-UPGRADE',
            number: 'POST-UPGRADE-CREDIT',
            date: '2026-03-01',
            net: '33.34',
            tax: '7.00',
            gross: '40.34',
          }),
        ),
        credit = await service.invoices.import(actor, key(), { evidenceId: creditXml.id });
      await post(
        await service.deferrals.proposeCreditNote(actor, key(), {
          financialYearId: year.id,
          invoiceId: credit.id,
          originalInvoiceId: invoice.id,
          recognitionDate: '2026-03-01',
          decisionDate: '2026-03-01',
          treatmentEvidenceId: agreement.id,
          kind: 'cancellation',
          periodBasis: 'current_period_event',
          reason: 'New cancellation applies only to the unprovided March subscription',
          cancelFrom: '2026-03-01',
        }),
      );
      expect(await service.deferrals.get(actor, { id: root.id, date: '2026-03-31' })).toMatchObject(
        {
          allocated: '66.66',
          cancelled: '33.34',
          remaining: '0.00',
        },
      );
      expect(
        await service.deferrals.reconcile(actor, { financialYearId: year.id, date: '2026-03-31' }),
      ).toMatchObject({ status: 'reconciled' });
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
