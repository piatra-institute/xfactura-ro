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
import {
  approvals,
  bankAccounts,
  commands,
  evidence,
  facts,
  invoiceDocuments,
  invoicePostings,
  journalLines,
  journals,
  proposals,
  treasuryAccounts,
  statements,
} from '../../source/accounting/schema';
import { invoiceXml } from './fixtures/invoice';

test('0011 books upgrade to native invoice positions without altering facts, approvals, postings or command results', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xfactura-treasury-upgrade-'));
  const db = new Database(`file:${directory}/books.db`);
  const key = () => randomUUID();
  try {
    const folder = join(directory, 'previous-migrations'),
      source = new URL('../../source/accounting/migrations/', import.meta.url);
    await mkdir(join(folder, 'meta'), { recursive: true });
    const journal = JSON.parse(await readFile(new URL('meta/_journal.json', source), 'utf8'));
    const entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 11);
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
    for (const entry of entries)
      await copyFile(new URL(`${entry.tag}.sql`, source), join(folder, `${entry.tag}.sql`));
    await db.initialize();
    await migrateDrizzle(db.orm, { migrationsFolder: folder });
    const secret = 'synthetic-treasury-upgrade-secret-at-least-32-characters';
    const owner = await createAuth(
      db,
      { publicUrl: 'http://localhost:3000', authSecret: secret },
      true,
    ).api.signUpEmail({
      body: {
        email: 'upgrade@example.test',
        name: 'Migration proof',
        password: 'synthetic-upgrade-password',
      },
    });
    const service = new Accounting(db, new LocalObjectStore(join(directory, 'objects')), secret);
    const company = await service.companies.create(owner.user.id, key(), {
      name: 'Existing native invoice SRL',
      cui: '12345678',
      year: 2026,
    });
    const actor = { actorId: owner.user.id, companyId: company.id },
      financialYear = (await service.foundation.years(actor)).find(
        (year) => year.kind === 'financial',
      )!;
    const proof = await service.documents.record(actor, key(), {
      filename: 'proof.txt',
      mediaType: 'text/plain',
      bytes: Buffer.from('Retained service and registration evidence before migration'),
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
    const xml = await service.documents.record(actor, key(), {
      filename: 'old-invoice.xml',
      mediaType: 'application/xml',
      bytes: Buffer.from(invoiceXml()),
    });
    const invoice = await service.invoices.import(actor, key(), { evidenceId: xml.id });
    const proposal = await service.invoices.propose(actor, key(), {
      invoiceId: invoice.id,
      financialYearId: financialYear.id,
      recognitionDate: '2026-10-01',
      serviceDate: '2026-10-01',
      taxPointDate: '2026-10-01',
      treatmentEvidenceId: proof.id,
      account: '628',
      deduction: 'full',
      counterpartyVatCollection: 'no',
    });
    const review = { version: proposal.version, hash: proposal.hash };
    await service.books.approve(actor, key(), proposal.id, review);
    const commandKey = key(),
      entry = await service.ledger.post(actor, commandKey, { id: proposal.id, ...review });
    await db.orm.insert(bankAccounts).values({ companyId: company.id, identifier: 'RO00OLD' });
    await service.foundation.createYear(actor, key(), {
      kind: 'financial',
      label: '2025',
      from: '2025-01-01',
      to: '2025-12-31',
    });
    const csvBytes = Buffer.from('movement_id,booking_date,amount,currency,reference\n');
    const statementSource = await service.documents.record(actor, key(), {
      filename: 'old-2025.csv',
      mediaType: 'text/csv',
      bytes: csvBytes,
    });
    await db.orm
      .insert(statements)
      .values({
        id: key(),
        companyId: company.id,
        evidenceId: statementSource.id,
        bankAccount: 'RO00OLD',
        sourceId: 'DEC-2025',
        periodFrom: '2025-12-01',
        periodTo: '2025-12-31',
        openingBani: 0n,
        closingBani: 0n,
        hash: sha256(csvBytes),
      });
    const tables = {
      commands,
      evidence,
      facts,
      invoiceDocuments,
      journals,
      proposals,
      approvals,
      journalLines,
      statements,
    };
    const preserved = new Map<string, unknown>();
    for (const [name, table] of Object.entries(tables))
      preserved.set(name, await db.orm.select().from(table));
    await migrate(db);
    await migrate(db);
    for (const [name, table] of Object.entries(tables))
      expect(preserved.get(name)).toEqual(await db.orm.select().from(table));
    expect(await db.orm.select().from(invoicePostings)).toHaveLength(1);
    expect((await db.orm.select().from(treasuryAccounts))[0]).toMatchObject({
      identifier: 'RO00OLD',
      ledgerAccount: '5121',
      evidenceId: null,
      openedOn: '2025-01-01',
    });
    expect(
      await service.positions.read(actor, { invoiceId: invoice.id, date: '2026-10-31' }),
    ).toMatchObject({ balance: '121.00', originalJournalId: entry.id });
    expect(await service.ledger.post(actor, commandKey, { id: proposal.id, ...review })).toEqual(
      entry,
    );
    await expect(db.orm.delete(invoicePostings).execute()).rejects.toThrow();
    await expect(db.orm.update(journalLines).set({ debitBani: 0n }).execute()).rejects.toThrow();
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
