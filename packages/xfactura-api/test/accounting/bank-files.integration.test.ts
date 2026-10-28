import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
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
import { LocalObjectStore, sha256, type ObjectStore } from '../../source/accounting/object-store';
import {
  bankFileOutput,
  bankStatementEntriesOutput,
} from '../../source/accounting/bank-statement-files';
import { parseMt940 } from '../../source/accounting/bank-mt940';
import { parseCamt } from '../../source/accounting/bank-camt';
import { checkedStatements } from '../../source/accounting/bank-statement-document';
import {
  bankStatementFiles,
  bankStatementSources,
  bankStatementEntries,
  movements,
  statements,
  journals,
  commands,
  statementMovements,
} from '../../source/accounting/schema';
import { backup, restore } from '../../source/accounting/backup';
import { runOneExport } from '../../source/accounting/worker';
import { iban, mt940, mtEmpty, camt, camtEntry, batchDetails } from './fixtures/bank';
import { invoiceXml } from './fixtures/invoice';

const key = () => randomUUID(),
  secret = 'synthetic-bank-file-secret-at-least-32-characters';
const year = { from: '2026-01-01', to: '2026-12-31' };
let directory: string,
  db: Database,
  objects: LocalObjectStore,
  service: Accounting,
  ownerId: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xfactura-bank-files-'));
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
        name: 'Bank reviewer',
        email: 'bank@example.test',
        password: 'synthetic-bank-password',
      },
    })
  ).user.id;
});
afterAll(async () => {
  if (db) await db.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function source(actor: Actor, text: string | Uint8Array, filename = 'statement.txt') {
  return service.documents.record(actor, key(), {
    filename,
    mediaType: filename.endsWith('.xml') ? 'application/xml' : 'text/plain',
    bytes: typeof text === 'string' ? Buffer.from(text) : text,
  });
}
async function fixture(mapped = true) {
  const company = await service.companies.create(ownerId, key(), {
      name: 'Bank SRL',
      cui: '12345678',
      year: 2026,
    }),
    actor = { actorId: ownerId, companyId: company.id },
    financialYear = (await service.foundation.years(actor)).find(
      (row) => row.kind === 'financial',
    )!,
    proof = await source(actor, 'Independent synthetic source and configuration evidence');
  if (mapped)
    await service.treasury.createAccount(actor, key(), {
      identifier: iban,
      kind: 'bank',
      currency: 'RON',
      ledgerAccount: '5121',
      openedOn: '2026-01-01',
      evidenceId: proof.id,
    });
  return { actor, company, financialYear, proof };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function imported(f: Fixture, text = mt940, format: 'mt940' | 'camt.053' = 'mt940') {
  const root = await source(f.actor, text, format === 'mt940' ? 'statement.sta' : 'statement.xml'),
    input = { evidenceId: root.id, financialYearId: f.financialYear.id, format };
  return { root, input, result: await service.bankFiles.import(f.actor, key(), input) };
}
async function snapshot(f: Fixture) {
  const result: Record<string, unknown> = {};
  for (const [name, table] of Object.entries({
    bankStatementFiles,
    bankStatementSources,
    bankStatementEntries,
    movements,
    statements,
    journals,
    commands,
  }))
    result[name] = await db.orm.select().from(table).where(eq(table.companyId, f.company.id));
  return result;
}
async function post(f: Fixture, proposal: { id: string; version: number; hash: string }) {
  await service.books.approve(f.actor, key(), proposal.id, {
    version: proposal.version,
    hash: proposal.hash,
  });
  return service.ledger.post(f.actor, key(), {
    id: proposal.id,
    version: proposal.version,
    hash: proposal.hash,
  });
}
async function opening(f: Fixture) {
  await post(
    f,
    await service.ledger.propose(f.actor, key(), {
      financialYearId: f.financialYear.id,
      evidenceId: f.proof.id,
      date: '2026-01-01',
      purpose: 'opening',
      description: 'Approved opening',
      sourceReference: 'opening',
      lines: [
        { account: '5121', debit: '1000.00', credit: '0.00' },
        { account: '1012', debit: '0.00', credit: '1000.00' },
      ],
    }),
  );
}

describe('bank statement source formats', () => {
  test('MT940 retains booked/value dates, multiline references, amounts and booked rather than available balance', async () => {
    const f = await fixture(),
      { root, result } = await imported(f);
    expect(result).toMatchObject({
      sourceHash: sha256(mt940),
      statementCount: 1,
      entryCount: 3,
      format: 'mt940',
    });
    expect(result.statements[0]).toMatchObject({
      sourceId: 'OCTOBER2026/001/001',
      bankAccount: iban,
      opening: '1000.00',
      closing: '947.97',
    });
    const page = await service.bankFiles.entries(f.actor, {
      sourceId: result.statements[0].id,
      limit: 2,
    });
    expect(
      page.items.map((row) => [row.date, row.valueDate, row.amount, row.bankReference]),
    ).toEqual([
      ['2026-10-05', '2026-10-06', '-100.00', 'BANK-PAY-01'],
      ['2026-10-05', '2026-10-05', '-2.03', 'BANK-FEE-01'],
    ]);
    expect(page.items[0].reference).toBe('Factura INV-1\nDetalii continuate');
    expect(
      (
        await service.bankFiles.entries(f.actor, {
          sourceId: result.statements[0].id,
          cursor: page.nextCursor!,
        })
      ).items[0],
    ).toMatchObject({ amount: '50.00', valueDate: '2026-09-30' });
    expect((await service.documents.read(f.actor, root.id)).bytes).toEqual(Buffer.from(mt940));
    expect((await service.overview(f.actor)).journals).toHaveLength(0);
  });

  test('retries, concurrent commands and cross-format imports retain one movement identity and each original description', async () => {
    const f = await fixture(),
      root = await source(f.actor, mt940),
      input = { evidenceId: root.id, financialYearId: f.financialYear.id, format: 'mt940' },
      commandKey = key();
    const [a, b] = await Promise.all([
      service.bankFiles.import(f.actor, commandKey, input),
      service.bankFiles.import(f.actor, commandKey, input),
    ]);
    expect(a).toEqual(b);
    expect(await service.bankFiles.import(f.actor, key(), input)).toEqual(a);
    const xml = await imported(f, camt(), 'camt.053'),
      first = await service.bankFiles.entries(f.actor, { sourceId: a.statements[0].id }),
      second = await service.bankFiles.entries(f.actor, { sourceId: xml.result.statements[0].id });
    expect(first.items.map((row) => row.movementId)).toEqual(
      second.items.map((row) => row.movementId),
    );
    expect(second.items[0].reference).toBe('Factura INV-1 alt text');
    expect(first.items[0].reference).toBe('Factura INV-1\nDetalii continuate');
    expect((await service.overview(f.actor)).movements).toHaveLength(3);
    expect((await service.overview(f.actor)).statements).toHaveLength(2);
    expect(
      await new Accounting(db, objects, secret).bankFiles.get(f.actor, { evidenceId: root.id }),
    ).toEqual(a);
  });

  test('MT940 accepts complete SWIFT/CRLF, separate daily statements, debit balances and reversed directions exactly', () => {
    const wrapped = `{1:F01BANKROBUAXXX0000000000}{2:I940BANKROBUXXXXN}{4:\r\n${mt940.replaceAll('\n', '\r\n')}\r\n-}{5:{CHK:SYNTHETIC}}`;
    expect(checkedStatements(parseMt940(wrapped, year), year)[0].closing).toBe('947.97');
    const reversed = mtEmpty('261005', '261005', '0,00').replace(
      ':62F:C261005RON0,00',
      ':61:2610051005RD1,01NTRFNONREF//REVERSE-DEBIT\n:61:2610051005RC2,02NTRFNONREF//REVERSE-CREDIT\n:62F:D261005RON1,01',
    );
    expect(
      checkedStatements(parseMt940(reversed, year), year)[0].entries.map((row) => [
        row.amount,
        row.reversal,
      ]),
    ).toEqual([
      ['1.01', true],
      ['-2.02', true],
    ]);
    expect(
      checkedStatements(
        parseMt940(
          `${mtEmpty('261001', '261015', '1000,00', 'FIRST')}\n${mtEmpty('261016', '261031', '1000,00', 'SECOND')}`,
          year,
        ),
        year,
      ),
    ).toHaveLength(2);
    const rollover = mt940
      .replace('C261001RON1000,00', 'C251231RON1000,00')
      .replace('C261031RON947,97', 'C260131RON947,97')
      .replaceAll('2610061005', '2601020101')
      .replaceAll('2610051005', '2601010101')
      .replaceAll('2609301010', '2512310110');
    expect(checkedStatements(parseMt940(rollover, year), year)[0].entries[0]).toMatchObject({
      date: '2026-01-01',
      valueDate: '2026-01-02',
    });
  });

  test('camt .02/.08 preserve source calendar dates, reversal flags, remittance and signed amounts without double inversion', () => {
    for (const version of ['02', '08'] as const) {
      const entry = camtEntry({
        amount: '1.01',
        bankRef: 'REVERSED',
        direction: 'CRDT',
        reversal: true,
        date: '2026-10-01',
        dateTime: '2026-10-01T00:05:00+03:00',
      }).replace(
        '<Sts>BOOK</Sts>',
        version === '08' ? '<Sts><Cd>BOOK</Cd></Sts>' : '<Sts>BOOK</Sts>',
      );
      const parsed = checkedStatements(
        parseCamt(
          Buffer.from(
            camt({
              version,
              entries: entry,
              closing: '1001.01',
              range:
                '<FrToDt><FrDtTm>2026-10-01T00:00:00+03:00</FrDtTm><ToDtTm>2026-11-01T00:00:00+03:00</ToDtTm></FrToDt>',
            }),
          ),
        ),
        year,
      )[0];
      expect(parsed.entries[0]).toMatchObject({
        date: '2026-10-01',
        bookingDateTime: '2026-10-01T00:05:00+03:00',
        amount: '1.01',
        reversal: true,
      });
      expect(parsed.to).toBe('2026-10-31');
    }
  });

  test('a batch is one booked movement; exact invoice allocations and a fee require human approval', async () => {
    const f = await fixture();
    await opening(f);
    await service.foundation.recordRegime(f.actor, key(), {
      axis: 'vat',
      value: 'non_vat',
      effectiveFrom: '2026-01-01',
      evidenceId: f.proof.id,
    });
    const invoices = [];
    for (const [number, net] of [
      ['A', '100.00'],
      ['B', '200.00'],
    ]) {
      const file = await source(
        f.actor,
        invoiceXml({ number, net, gross: net, tax: '0.00', category: 'O' }),
        'invoice.xml',
      );
      const doc = await service.invoices.import(f.actor, key(), { evidenceId: file.id });
      const proposal = await service.invoices.propose(f.actor, key(), {
        invoiceId: doc.id,
        financialYearId: f.financialYear.id,
        recognitionDate: '2026-10-01',
        serviceDate: '2026-10-01',
        taxPointDate: '2026-10-01',
        treatmentEvidenceId: f.proof.id,
        account: '628',
        deduction: 'none',
        counterpartyVatCollection: 'no',
      });
      await post(f, proposal);
      invoices.push(doc);
    }
    const { result } = await imported(
      f,
      camt({
        entries: camtEntry({
          amount: '302.00',
          bankRef: 'BATCH-01',
          details: batchDetails,
          extra: '<Chrgs><TtlChrgsAndTaxAmt Ccy="RON">2.00</TtlChrgsAndTaxAmt></Chrgs>',
        }),
        closing: '698.00',
      }),
      'camt.053',
    );
    const entry = (await service.bankFiles.entries(f.actor, { sourceId: result.statements[0].id }))
      .items[0];
    expect(result.entryCount).toBe(1);
    expect(entry.details).toHaveLength(2);
    expect(entry.charges).toEqual([{ amount: '2.00', scope: 'entry', kind: 'TtlChrgsAndTaxAmt' }]);
    const proposal = await service.settlements.propose(f.actor, key(), {
      financialYearId: f.financialYear.id,
      movementId: entry.movementId,
      allocations: [
        { invoiceId: invoices[0].id, amount: '100.00' },
        { invoiceId: invoices[1].id, amount: '200.00' },
      ],
      fee: { amount: '2.00', account: '627', evidenceId: f.proof.id },
    });
    await expect(
      service.ledger.post(f.actor, key(), {
        id: proposal.id,
        version: proposal.version,
        hash: proposal.hash,
      }),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    await post(f, proposal);
    expect(
      Object.fromEntries(
        (await service.overview(f.actor)).balances.map((row) => [row.account, row.balance]),
      ),
    ).toMatchObject({ '5121': '698.00', '401': '0.00', '628': '300.00', '627': '2.00' });
    await service.periods.close(f.actor, key(), '2026-10-01');
  });

  test('continuous daily statements allow month close; gaps and contradictory balances block it', async () => {
    const f = await fixture();
    await opening(f);
    await imported(f, mtEmpty('261001', '261015', '1000,00', 'FIRST'));
    await imported(f, mtEmpty('261017', '261031', '1000,00', 'LAST'));
    await expect(service.periods.close(f.actor, key(), '2026-10-01')).rejects.toMatchObject({
      code: 'STATEMENT_REQUIRED',
    });
    await imported(f, mtEmpty('261016', '261016', '1000,00', 'BRIDGE'));
    await service.periods.close(f.actor, key(), '2026-10-01');
    const other = await fixture();
    await opening(other);
    await imported(other, mtEmpty('261001', '261015', '999,99', 'WRONG'));
    await imported(other, mtEmpty('261016', '261031', '1000,00', 'LAST'));
    await expect(service.periods.close(other.actor, key(), '2026-10-01')).rejects.toMatchObject({
      code: 'BANK_DIFFERENCE',
    });
  });

  test('closed periods accept another proven source version but reject new booked entries', async () => {
    const f = await fixture();
    await opening(f);
    await imported(f, mtEmpty());
    await service.periods.close(f.actor, key(), '2026-10-01');
    await imported(f, camt({ entries: '', closing: '1000.00' }), 'camt.053');
    await expect(imported(f)).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
  });

  test('missing mappings, wrong year/company and foreign currency cannot write partial bank imports', async () => {
    const f = await fixture(false),
      root = await source(f.actor, mt940),
      input = { evidenceId: root.id, financialYearId: f.financialYear.id, format: 'mt940' },
      before = await snapshot(f);
    await expect(service.bankFiles.import(f.actor, key(), input)).rejects.toMatchObject({
      code: 'BANK_ACCOUNT_REQUIRED',
    });
    expect(await snapshot(f)).toEqual(before);
    const other = await fixture();
    await expect(service.bankFiles.import(other.actor, key(), input)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const mapped = await fixture();
    for (const text of [
      mt940.replaceAll('RON', 'EUR'),
      mt940.replaceAll('261031', '271031'),
      `${mtEmpty()}\n${mt940.replace('947,97', '947,96')}`,
    ]) {
      const root = await source(mapped.actor, text),
        before = await snapshot(mapped);
      await expect(
        service.bankFiles.import(mapped.actor, key(), {
          evidenceId: root.id,
          financialYearId: mapped.financialYear.id,
          format: 'mt940',
        }),
      ).rejects.toThrow();
      expect(await snapshot(mapped)).toEqual(before);
    }
  });

  test('ambiguous overlaps stop; independently identified same-date same-amount payments remain distinct', async () => {
    const f = await fixture(),
      single = camt({ entries: camtEntry({ amount: '10.00' }), closing: '990.00' });
    await imported(f, single, 'camt.053');
    await expect(
      imported(f, single.replace('OCTOBER-2026', 'OTHER-STMT'), 'camt.053'),
    ).rejects.toMatchObject({ code: 'AMBIGUOUS_BANK_DUPLICATE' });
    const known = await fixture();
    await imported(
      known,
      camt({ entries: camtEntry({ amount: '10.00', bankRef: 'DISTINCT-A' }), closing: '990.00' }),
      'camt.053',
    );
    await imported(
      known,
      camt({
        id: 'SECOND',
        entries: camtEntry({ amount: '10.00', bankRef: 'DISTINCT-B' }),
        opening: '990.00',
        closing: '980.00',
      }),
      'camt.053',
    );
    expect((await service.overview(known.actor)).movements).toHaveLength(2);
  });

  test('bank references from legacy CSV are reusable and financial/value-date conflicts stop atomically', async () => {
    const f = await fixture(),
      csv = await source(
        f.actor,
        'movement_id,booking_date,amount,currency,reference\nBANK-PAY-01,2026-10-05,-100.00,RON,Legacy description\n',
      );
    await service.bank.importStatement(f.actor, key(), {
      evidenceId: csv.id,
      bankAccount: iban,
      statementId: 'CSV-01',
      from: '2026-10-01',
      to: '2026-10-31',
      opening: '1000.00',
      closing: '900.00',
    });
    const doc = camt({
      entries: camtEntry({ amount: '100.00', bankRef: 'BANK-PAY-01', value: '2026-10-06' }),
      closing: '900.00',
    });
    await imported(f, doc, 'camt.053');
    expect((await service.overview(f.actor)).movements).toHaveLength(1);
    await expect(
      imported(f, doc.replace('<Dt>2026-10-06</Dt>', '<Dt>2026-10-07</Dt>'), 'camt.053'),
    ).rejects.toMatchObject({ code: 'BANK_VALUE_DATE_CONFLICT' });
    await expect(
      imported(f, doc.replaceAll('100.00', '99.00').replace('900.00', '901.00'), 'camt.053'),
    ).rejects.toMatchObject({ code: 'BANK_STATEMENT_CONFLICT' });
  });

  test('bounded parsers reject fragments, provisional entries, XML attacks, excessive precision and contradictory details', () => {
    for (const invalid of [
      mt940.replace(':60F:', ':60M:'),
      mt940.replace('100,00NTRF', '100,001NTRF'),
      mt940.replace('2610061005', '261006'),
      `{1:F01BANK}{2:I942BANK}{4:\n${mt940}\n-}`,
      mt940.replace(iban, iban.slice(0, -1) + '1'),
    ])
      expect(() => checkedStatements(parseMt940(invalid, year), year)).toThrow();
    const valid = camt();
    for (const invalid of [
      valid.replaceAll('<Sts>BOOK</Sts>', '<Sts>PDNG</Sts>'),
      valid.replace(
        '<MsgId>',
        '<MsgPgntn><PgNb>1</PgNb><LastPgInd>false</LastPgInd></MsgPgntn><MsgId>',
      ),
      valid.replace('camt.053.001.02', 'camt.052.001.02'),
      valid.replace('947.97', '947.98'),
      valid.replaceAll('Ccy="RON"', 'Ccy="EUR"'),
      valid.replace(
        '<Document',
        '<!DOCTYPE Document [<!ENTITY x SYSTEM "file:///etc/passwd">]><Document',
      ),
      camt({
        entries: camtEntry({ amount: '302.00', bankRef: 'BATCH', details: batchDetails }),
        closing: '698.00',
      }),
      camt({
        entries: camtEntry({ amount: '1.00', dateTime: '2026-10-01T24:00:00+03:00' }),
        closing: '999.00',
      }),
      camt({
        summary:
          '<TxsSummry><TtlNtries><NbOfNtries>9</NbOfNtries><Sum>152.03</Sum></TtlNtries></TxsSummry>',
      }),
    ])
      expect(() => checkedStatements(parseCamt(Buffer.from(invalid)), year)).toThrow();
    expect(() =>
      checkedStatements(
        parseMt940(
          Array.from({ length: 101 }, (_, i) =>
            mtEmpty('261001', '261031', '1000,00', String(i)),
          ).join('\n'),
          year,
        ),
        year,
      ),
    ).toThrow();
  });

  test('company/grant isolation and revocation during source decoding apply before both commits and cached retries', async () => {
    const f = await fixture(),
      root = await source(f.actor, mt940),
      input = { evidenceId: root.id, financialYearId: f.financialYear.id, format: 'mt940' },
      grant = await service.agents.issue(f.actor, key(), {
        name: 'Bank importer',
        scopes: ['bank.importFile', 'bank.file', 'bank.statementEntries'],
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
      actor = { ...f.actor, agentId: grant.id };
    const blocking: ObjectStore = {
      put: (...args) => objects.put(...args),
      get: async (company, hash) => {
        await service.agents.revoke(f.actor, key(), grant.id);
        return objects.get(company, hash);
      },
    };
    await expect(
      new Accounting(db, blocking, secret).bankFiles.import(actor, key(), input),
    ).rejects.toMatchObject({ code: 'AGENT_REVOKED' });
    expect((await service.overview(f.actor)).movements).toHaveLength(0);
    const result = await service.bankFiles.import(f.actor, key(), input),
      other = await fixture();
    await expect(service.bankFiles.get(other.actor, { evidenceId: root.id })).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
    await expect(
      service.bankFiles.entries(other.actor, { sourceId: result.statements[0].id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.bankFiles.import(actor, key(), input)).rejects.toMatchObject({
      code: 'AGENT_REVOKED',
    });
    const wrong = await service.agents.issue(f.actor, key(), {
      name: 'Read only',
      scopes: ['bank.file'],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    await expect(
      service.bankFiles.import({ ...f.actor, agentId: wrong.id }, key(), input),
    ).rejects.toMatchObject({ code: 'AGENT_SCOPE' });
  });

  test('frozen exports, backup/restore and immutable projections preserve original bytes and source details', async () => {
    const f = await fixture(),
      { root, result, input } = await imported(f),
      commandKey = key();
    await service.bankFiles.import(f.actor, commandKey, input);
    const job = await service.exports.request(f.actor, key());
    await runOneExport(db, objects);
    const exported = JSON.parse(
      Buffer.from((await service.exports.download(f.actor, job.id)).bytes).toString(),
    ).data;
    expect(exported.bankStatementFiles).toHaveLength(1);
    expect(exported.bankStatementEntries).toHaveLength(3);
    await backup(db, objects, join(directory, 'backup'));
    const restored = await restore(join(directory, 'backup'), join(directory, 'restored')),
      copyDb = new Database(restored.databaseUrl);
    try {
      await migrate(copyDb);
      const copy = new Accounting(copyDb, new LocalObjectStore(restored.objectDir), secret);
      expect(await copy.bankFiles.import(f.actor, commandKey, input)).toEqual(result);
      expect((await copy.documents.read(f.actor, root.id)).bytes).toEqual(Buffer.from(mt940));
      expect(await copy.bankFiles.entries(f.actor, { sourceId: result.statements[0].id })).toEqual(
        await service.bankFiles.entries(f.actor, { sourceId: result.statements[0].id }),
      );
      for (const table of [bankStatementFiles, bankStatementSources, bankStatementEntries])
        await expect(
          copyDb.orm.delete(table).where(eq(table.companyId, f.company.id)).execute(),
        ).rejects.toThrow();
      await expect(
        copyDb.orm
          .update(bankStatementFiles)
          .set({ entryCount: 0 })
          .where(eq(bankStatementFiles.companyId, f.company.id))
          .execute(),
      ).rejects.toThrow();
      await expect(
        copyDb.orm
          .update(bankStatementSources)
          .set({ sourceId: 'replacement' })
          .where(eq(bankStatementSources.companyId, f.company.id))
          .execute(),
      ).rejects.toThrow();
      await expect(
        copyDb.orm
          .update(bankStatementEntries)
          .set({ ordinal: 99 })
          .where(eq(bankStatementEntries.companyId, f.company.id))
          .execute(),
      ).rejects.toThrow();
      const [entry] = await copyDb.orm
        .select()
        .from(bankStatementEntries)
        .where(eq(bankStatementEntries.companyId, f.company.id));
      await expect(
        copyDb.orm
          .insert(bankStatementEntries)
          .values({ ...entry, id: key(), ordinal: 99 })
          .execute(),
      ).rejects.toThrow();
    } finally {
      await copyDb.close();
    }
  });

  test('file bounds, explicit Windows-1250 decoding and original import options survive retries', async () => {
    const f = await fixture(),
      text = mt940.replace('Detalii continuate', 'Detalii \u00fe'),
      root = await source(f.actor, Buffer.from(text, 'latin1')),
      input = { evidenceId: root.id, financialYearId: f.financialYear.id, format: 'mt940' };
    await expect(service.bankFiles.import(f.actor, key(), input)).rejects.toMatchObject({
      code: 'BANK_ENCODING',
    });
    const result = await service.bankFiles.import(f.actor, key(), {
      ...input,
      encoding: 'windows-1250',
    });
    expect(
      (await service.bankFiles.entries(f.actor, { sourceId: result.statements[0].id })).items[0]
        .reference,
    ).toBe('Factura INV-1\nDetalii ţ');
    await expect(service.bankFiles.import(f.actor, key(), input)).rejects.toMatchObject({
      code: 'BANK_FILE_CONFLICT',
    });
    const large = await source(f.actor, new Uint8Array(2_000_001));
    await expect(
      service.bankFiles.import(f.actor, key(), { ...input, evidenceId: large.id }),
    ).rejects.toMatchObject({ code: 'IMPORT_LIMIT' });
    const rows = Array.from(
      { length: 2001 },
      (_, i) => `:61:2610051005C0,01NTRFNONREF//${String(i).padStart(16, '0')}`,
    ).join('\n');
    const excessive = mtEmpty().replace(
        ':62F:C261031RON1000,00',
        `${rows}\n:62F:C261031RON1020,01`,
      ),
      extra = await source(f.actor, excessive);
    await expect(
      service.bankFiles.import(f.actor, key(), { ...input, evidenceId: extra.id }),
    ).rejects.toThrow();
  });

  test('the 2000-entry boundary imports exactly and a second source reuses every movement', async () => {
    const f = await fixture(),
      rows = Array.from(
        { length: 2000 },
        (_, i) => `:61:2610051005C0,01NTRFNONREF//${String(i).padStart(16, '0')}`,
      ).join('\n'),
      text = mtEmpty().replace(':62F:C261031RON1000,00', `${rows}\n:62F:C261031RON1020,00`);
    const { result } = await imported(f, text);
    expect(result.entryCount).toBe(2000);
    const last = await service.bankFiles.entries(f.actor, {
      sourceId: result.statements[0].id,
      cursor: 1998,
    });
    expect(last.items).toHaveLength(1);
    expect(last.items[0].ordinal).toBe(1999);
    expect(last.nextCursor).toBeNull();
    expect((await imported(f, text.replace(':20:EMPTY', ':20:ANOTHER'))).result.entryCount).toBe(
      2000,
    );
    expect((await service.queries.movements(f.actor, { limit: 100 })).items).toHaveLength(100);
    expect(
      await db.orm
        .select({ id: movements.id })
        .from(movements)
        .where(eq(movements.companyId, f.company.id)),
    ).toHaveLength(2000);
  });

  test('one file preserves separate statement sources while a late mapping failure rolls every statement back', async () => {
    const f = await fixture(),
      two = `${mtEmpty('261001', '261015', '1000,00', 'FIRST')}\n${mtEmpty('261016', '261031', '1000,00', 'LAST')}`;
    expect((await imported(f, two)).result.statementCount).toBe(2);
    const other = await fixture(),
      root = await source(
        other.actor,
        `${mtEmpty('261001', '261015', '1000,00', 'FIRST')}\n${mtEmpty('261016', '261031', '1000,00', 'LAST').replace(iban, 'RO09BCYP0000001234567890')}`,
      ),
      before = await snapshot(other);
    await expect(
      service.bankFiles.import(other.actor, key(), {
        evidenceId: root.id,
        financialYearId: other.financialYear.id,
        format: 'mt940',
      }),
    ).rejects.toMatchObject({ code: 'BANK_ACCOUNT_REQUIRED' });
    expect(await snapshot(other)).toEqual(before);
  });

  test('database manifests cannot substitute native dates/amounts, detach source links or forge projected details', async () => {
    const f = await fixture(),
      { root } = await imported(f),
      [original] = await db.orm
        .select()
        .from(bankStatementFiles)
        .where(eq(bankStatementFiles.evidenceId, root.id)),
      [native] = await db.orm
        .select()
        .from(statements)
        .where(eq(statements.companyId, f.company.id)),
      second = await source(f.actor, 'Distinct synthetic source version'),
      links = await db.orm
        .select()
        .from(statementMovements)
        .where(eq(statementMovements.companyId, f.company.id));
    const variants = [
      (m: typeof original.manifest) => {
        m[0].entries[0].amount = '-99.99';
      },
      (m: typeof original.manifest) => {
        m[0].entries[0].date = '2026-10-06';
      },
      (m: typeof original.manifest) => {
        m[0].entries[0].movementId = key();
      },
      (m: typeof original.manifest) => {
        m[0].closing = '948.00';
      },
      (m: typeof original.manifest) => {
        m[0].entries.pop();
      },
    ];
    for (const alter of variants)
      await expect(
        db.write(async (tx) => {
          const id = key(),
            manifest = structuredClone(original.manifest);
          manifest[0].id = key();
          manifest[0].statementId = id;
          await tx
            .insert(statements)
            .values({ ...native, id, sourceId: key(), evidenceId: second.id });
          await tx
            .insert(statementMovements)
            .values(links.map((link) => ({ ...link, statementId: id })));
          alter(manifest);
          await tx
            .insert(bankStatementFiles)
            .values({ ...original, evidenceId: second.id, manifest });
        }),
      ).rejects.toThrow();
    const [entry] = await db.orm
      .select()
      .from(bankStatementEntries)
      .where(eq(bankStatementEntries.companyId, f.company.id));
    await expect(
      db.orm
        .insert(bankStatementEntries)
        .values({ ...entry, id: key(), body: { ...entry.body, amount: '-99.99' } })
        .execute(),
    ).rejects.toThrow();
    expect((await service.overview(f.actor)).statements).toHaveLength(1);
  });

  test('official SDK exposes scoped import/details without approval or payment authority', async () => {
    const f = await fixture(),
      root = await source(f.actor, mt940),
      grant = await service.agents.issue(f.actor, key(), {
        name: 'Bank MCP',
        scopes: ['bank.importFile', 'bank.file', 'bank.statementEntries'],
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      }),
      publicUrl = 'http://localhost:3000',
      app = createApp(service, { publicUrl, authSecret: secret }).app,
      client = new Client(
        { name: 'bank-file-contract', version: '1' },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } },
      );
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`${publicUrl}/api/accounting/v1/companies/${f.company.id}/mcp`),
        {
          authProvider: { token: async () => grant.token },
          fetch: async (url, init) => {
            const req = new Request(url, init);
            req.headers.set('host', new URL(req.url).host);
            return app.fetch(req);
          },
        },
      ),
    );
    try {
      const names = (await client.listTools()).tools.map((row) => row.name);
      expect(names).toContain('bank.importFile');
      expect(names).not.toContain('books.approve');
      expect(names).not.toContain('treasury.createAccount');
      const args = {
          input: { evidenceId: root.id, financialYearId: f.financialYear.id, format: 'mt940' },
          idempotencyKey: key(),
        },
        result = bankFileOutput.parse(
          (await client.callTool({ name: 'bank.importFile', arguments: args })).structuredContent,
        );
      expect(
        (await client.callTool({ name: 'bank.importFile', arguments: args })).structuredContent,
      ).toEqual(result);
      const page = bankStatementEntriesOutput.parse(
        (
          await client.callTool({
            name: 'bank.statementEntries',
            arguments: { input: { sourceId: result.statements[0].id } },
          })
        ).structuredContent,
      );
      expect(page.items).toHaveLength(3);
      await service.agents.revoke(f.actor, key(), grant.id);
      await expect(client.callTool({ name: 'bank.importFile', arguments: args })).rejects.toThrow(
        'Unauthorized',
      );
    } finally {
      await client.close();
    }
  });
});
