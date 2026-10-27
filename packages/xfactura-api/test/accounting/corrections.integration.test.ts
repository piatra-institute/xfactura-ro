import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { migrate as migrateDrizzle } from 'drizzle-orm/libsql/migrator';
import { Database } from '../../source/accounting/db';
import { migrate } from '../../source/accounting/migrate';
import { Accounting } from '../../source/accounting/application';
import { createApp } from '../../source/accounting/app';
import { createAuth } from '../../source/accounting/auth';
import { LocalObjectStore, sha256 } from '../../source/accounting/object-store';
import { backup, restore } from '../../source/accounting/backup';
import { runOneExport } from '../../source/accounting/worker';
import { postJournal } from '../../source/accounting/ledger';
import {
  approvals,
  companies,
  commands,
  evidence,
  facts,
  journals,
  proposals,
  correctionOutcomes,
  journalLines,
  memberships,
} from '../../source/accounting/schema';
import { Amount, canonical, type CorrectionInput } from '../../source/accounting/domain';

const secret = 'synthetic-correction-secret-at-least-32-characters';
const publicUrl = 'http://localhost:3000';
const key = () => randomUUID();
let directory: string, db: Database, service: Accounting, objects: LocalObjectStore;
let application: ReturnType<typeof createApp>,
  ownerId: string,
  viewerId: string,
  cookie: string,
  viewerCookie: string,
  outsiderCookie: string;
const review = (proposal: { version: number; hash: string }) => ({
  version: proposal.version,
  hash: proposal.hash,
});

afterAll(async () => {
  if (db) await db.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xfactura-corrections-'));
  db = new Database(`file:${directory}/books.db`);
  await migrate(db);
  objects = new LocalObjectStore(join(directory, 'objects'));
  service = new Accounting(db, objects, secret);
  application = createApp(service, { publicUrl, authSecret: secret });
  const auth = createAuth(db, { publicUrl, authSecret: secret }, true);
  for (const name of ['owner', 'viewer', 'outsider']) {
    const account = await auth.api.signUpEmail({
      body: { email: `${name}@example.test`, name, password: 'synthetic-correction-password' },
    });
    const login = await application.app.request(`${publicUrl}/api/accounting/auth/sign-in/email`, {
      method: 'POST',
      headers: { origin: publicUrl, 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `${name}@example.test`,
        password: 'synthetic-correction-password',
      }),
    });
    expect(login.status).toBe(200);
    const session = login.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    if (name === 'owner') {
      ownerId = account.user.id;
      cookie = session;
    } else if (name === 'viewer') {
      viewerId = account.user.id;
      viewerCookie = session;
    } else outsiderCookie = session;
  }
});

async function fixture(paid?: string) {
  const company = await service.companies.create(ownerId, key(), {
    name: 'Correction fixture SRL',
    cui: '12345678',
    year: 2026,
  });
  const actor = { actorId: ownerId, companyId: company.id };
  async function source(filename: string, text: string) {
    return service.documents.record(actor, key(), {
      filename,
      mediaType: filename.endsWith('.csv') ? 'text/csv' : 'text/plain',
      bytes: new TextEncoder().encode(text),
    });
  }
  const openingSource = await source('opening.txt', 'Approved opening RON 1000.00');
  const opening = await service.books.proposeOpening(actor, key(), {
    evidenceId: openingSource.id,
    date: '2026-01-01',
    amount: '1000.00',
  });
  await service.books.approve(actor, key(), opening.id, review(opening));
  await service.books.post(actor, key(), opening.id, review(opening));
  const invoice = await source('invoice.txt', 'Original retained supplier invoice RON 100.00');
  const purchase = await service.books.proposePurchase(actor, key(), {
    evidenceId: invoice.id,
    date: '2026-10-01',
    serviceDate: '2026-10-01',
    amount: '100.00',
    supplier: 'Furnizor SRL',
    supplierCui: '87654321',
    invoiceNumber: 'P-1',
    description: 'Servicii documentate',
    supplierCountry: 'RO',
    currency: 'RON',
    vatTreatment: 'NON_VAT',
  });
  await service.books.approve(actor, key(), purchase.id, review(purchase));
  const original = await service.books.post(actor, key(), purchase.id, review(purchase));
  const memo = await source(
    'correction.txt',
    'Verified recording error; correct the amount under the approved inverse-entry policy',
  );
  const input: CorrectionInput = {
    journalId: original.id,
    evidenceId: memo.id,
    date: '2026-11-01',
    reason: 'Suma a fost introdusă greșit în înregistrarea inițială',
    action: 'replace',
    method: 'inverse_entry',
    amount: '80.00',
  };
  const context = { actor, company, purchase, original, input, source };
  if (paid) await pay(context, paid, '2026-10-05', true);
  return context;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function pay(
  context: Pick<Fixture, 'actor' | 'purchase' | 'source'>,
  amount: string,
  date: string,
  wholeMonth = false,
) {
  const movementId = key();
  const source = await context.source(
    'bank.csv',
    `movement_id,booking_date,amount,currency,reference\n${movementId},${date},-${amount},RON,P-1\n`,
  );
  await service.bank.importStatement(context.actor, key(), {
    evidenceId: source.id,
    bankAccount: 'RO00FIXTURE',
    statementId: movementId,
    from: wholeMonth ? '2026-10-01' : date,
    to: wholeMonth ? '2026-10-31' : date,
    opening: '1000.00',
    closing: new Amount('1000').minus(amount).toFixed(2),
  });
  const state = await service.overview(context.actor);
  const movement = state.movements.find((item) => item.sourceId === movementId)!;
  return service.bank.match(context.actor, key(), {
    movementId: movement.id,
    proposalId: context.purchase.id,
    amount,
  });
}
function request(
  context: Fixture,
  path: string,
  body: unknown,
  options: { method?: string; cookie?: string; key?: string } = {},
) {
  return application.app.request(
    `${publicUrl}/api/accounting/v1/companies/${context.company.id}${path}`,
    {
      method: options.method ?? 'POST',
      headers: {
        origin: publicUrl,
        cookie: options.cookie ?? cookie,
        'content-type': 'application/json',
        'Idempotency-Key': options.key ?? key(),
      },
      body: JSON.stringify(body),
    },
  );
}
async function propose(context: Fixture, input: CorrectionInput = context.input) {
  return service.corrections.propose(context.actor, key(), input);
}
async function post(
  context: Fixture,
  proposal: Awaited<ReturnType<typeof propose>>,
  commandKey = key(),
) {
  await service.books.approve(context.actor, key(), proposal.id, review(proposal));
  return service.corrections.post(context.actor, commandKey, proposal.id, review(proposal));
}
function amounts(state: Awaited<ReturnType<Accounting['overview']>>) {
  return Object.fromEntries(state.balances.map((row) => [row.account, row.balance]));
}

describe('linked purchase corrections', () => {
  test('upgrades populated A1 books without changing posted data or losing posting guards', async () => {
    const folder = join(directory, 'old-migrations');
    const migrationSource = new URL('../../source/accounting/migrations/', import.meta.url);
    await mkdir(join(folder, 'meta'), { recursive: true });
    const journal = JSON.parse(
      await readFile(new URL('meta/_journal.json', migrationSource), 'utf8'),
    );
    await writeFile(
      join(folder, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, 2) }),
    );
    for (const name of ['0000_accounting.sql', '0001_posting_guards.sql'])
      await copyFile(new URL(name, migrationSource), join(folder, name));
    const old = new Database(`file:${directory}/upgrade.db`);
    try {
      await old.initialize();
      await migrateDrizzle(old.orm, { migrationsFolder: folder });
      const auth = createAuth(old, { publicUrl, authSecret: secret }, true);
      const owner = await auth.api.signUpEmail({
        body: {
          email: 'upgrade@example.test',
          name: 'Upgrade fixture',
          password: 'synthetic-upgrade-password',
        },
      });
      const previous = new Accounting(
        old,
        new LocalObjectStore(join(directory, 'upgrade-objects')),
        secret,
      );
      const [company] = await old.orm
        .insert(companies)
        .values({
          id: key(),
          createdBy: owner.user.id,
          name: 'Existing A1 SRL',
          cui: '11223344',
          year: 2026,
        })
        .returning();
      await old.orm
        .insert(memberships)
        .values({ companyId: company.id, userId: owner.user.id, role: 'owner' });
      const actor = { actorId: owner.user.id, companyId: company.id };
      const source = await previous.documents.record(actor, key(), {
        filename: 'old-opening.txt',
        mediaType: 'text/plain',
        bytes: new TextEncoder().encode('Opening retained before upgrade: 1000.00 RON'),
      });
      const proposal = await previous.books.proposeOpening(actor, key(), {
        date: '2026-01-01',
        evidenceId: source.id,
        amount: '1000.00',
      });
      const approvalId = key();
      await old.orm.insert(approvals).values({
        id: approvalId,
        companyId: company.id,
        proposalId: proposal.id,
        ...review(proposal),
        createdBy: owner.user.id,
      });
      await old.orm.transaction((tx) =>
        postJournal(tx, actor, {
          date: '2026-01-01',
          kind: 'opening',
          sourceId: proposal.id,
          evidenceId: source.id,
          approvalId,
          description: 'Original opening before upgrade',
          lines: [
            { account: '5121', debit: '1000.00', credit: '0.00' },
            { account: '1012', debit: '0.00', credit: '1000.00' },
          ],
        }),
      );
      const before = await old.orm.select().from(journalLines);
      const preservedTables = { commands, evidence, facts, journals, proposals, approvals };
      const preserved: Record<string, string> = {};
      for (const [name, table] of Object.entries(preservedTables))
        preserved[name] = canonical(await old.orm.select().from(table));
      const preUpgrade = await backup(
        old,
        new LocalObjectStore(join(directory, 'upgrade-objects')),
        join(directory, 'pre-agent-upgrade-backup'),
      );
      expect(preUpgrade.objects).toBe(1);
      await migrate(old);
      const state = await previous.overview(actor);
      expect(state.journals).toHaveLength(1);
      expect(amounts(state)['5121']).toBe('1000.00');
      expect(await old.orm.select().from(journalLines)).toEqual(before);
      for (const [name, table] of Object.entries(preservedTables))
        expect(canonical(await old.orm.select().from(table))).toBe(preserved[name]);
      await expect(old.orm.update(journalLines).set({ debitBani: 0n }).execute()).rejects.toThrow();
      expect(state.corrections).toHaveLength(0);
    } finally {
      await old.close();
    }
  });
  test('posts an exact approved correction after close without rewriting the original period', async () => {
    const f = await fixture('40.00');
    await service.periods.close(f.actor, key(), '2026-10-01');
    const before = await service.overview(f.actor);
    const original = before.journals.find((item) => item.id === f.original.id)!;
    const proposal = await propose(f);
    const denied = await request(f, `/correction-proposals/${proposal.id}/post`, review(proposal));
    expect(denied.status).toBe(409);
    const commandKey = key();
    const entry = await post(f, proposal, commandKey);
    const replay = await service.corrections.post(
      f.actor,
      commandKey,
      proposal.id,
      review(proposal),
    );
    expect(replay.id).toBe(entry.id);
    const after = await service.overview(f.actor);
    expect(amounts(after)).toEqual({
      '1012': '-1000.00',
      '401': '-40.00',
      '5121': '960.00',
      '628': '80.00',
    });
    expect(after.journals.find((item) => item.id === original.id)?.lines).toEqual(original.lines);
    expect(after.journals.filter((item) => item.date.startsWith('2026-10'))).toHaveLength(2);
    const corrected = after.journals.find((item) => item.id === entry.id)!;
    expect(corrected.date).toBe('2026-11-01');
    expect(corrected.correctsJournalId).toBe(original.id);
    expect(corrected.lines).toEqual([
      { account: '628', debit: '0.00', credit: '100.00' },
      { account: '401', debit: '100.00', credit: '0.00' },
      { account: '628', debit: '80.00', credit: '0.00' },
      { account: '401', debit: '0.00', credit: '80.00' },
    ]);
    expect(after.proposals.find((item) => item.id === f.purchase.id)?.body).toEqual(
      f.purchase.body,
    );
    expect(after.proposals.find((item) => item.id === f.purchase.id)?.currentAmount).toBe('80.00');
    expect(after.closedPeriods).toEqual(before.closedPeriods);
    expect(after.fiscalInterpretations).toHaveLength(before.fiscalInterpretations.length + 1);
    expect(
      (await request(f, '/correction-proposals', { ...f.input, date: '2026-10-31' })).status,
    ).toBe(409);
  });

  test('rejects unsupported targets, forged facts, numeric money and dates outside the exercise', async () => {
    const f = await fixture();
    const state = await service.overview(f.actor);
    for (const body of [
      { ...f.input, amount: 80 },
      { ...f.input, reason: 'x' },
      { ...f.input, amount: '80.001' },
      { ...f.input, action: 'reverse' },
      { ...f.input, date: '2027-01-01' },
      { ...f.input, date: '2026-09-30' },
      { ...f.input, previousAmount: '200.00' },
      { ...f.input, journalId: state.journals[0].id },
    ])
      expect((await request(f, '/correction-proposals', body)).status).toBe(422);
    expect(
      (await request(f, '/correction-proposals', f.input, { cookie: outsiderCookie })).status,
    ).toBe(404);
    await db.orm
      .insert(memberships)
      .values({ companyId: f.company.id, userId: viewerId, role: 'viewer' });
    expect(
      (await request(f, '/correction-proposals', f.input, { cookie: viewerCookie })).status,
    ).toBe(403);
    const other = await fixture();
    expect((await request(other, '/correction-proposals', f.input)).status).toBe(404);
    expect(
      (
        await request(f, '/correction-proposals', {
          ...f.input,
          evidenceId: other.input.evidenceId,
        })
      ).status,
    ).toBe(404);
    const pending = await propose(f);
    expect(
      (
        await request(f, `/proposals/${pending.id}/approve`, review(pending), {
          cookie: viewerCookie,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(f, `/correction-proposals/${pending.id}/post`, review(pending), {
          cookie: viewerCookie,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(f, `/correction-proposals/${pending.id}/withdraw`, review(pending), {
          cookie: viewerCookie,
        })
      ).status,
    ).toBe(403);
    expect((await request(f, `/proposals/${pending.id}/post`, review(pending))).status).toBe(409);
    expect((await service.overview(f.actor)).journals).toHaveLength(2);
  });

  test('revision invalidates the old approval, and withdrawn drafts cannot be revived', async () => {
    const f = await fixture();
    const initial = await propose(f);
    await service.books.approve(f.actor, key(), initial.id, review(initial));
    const changed = await service.corrections.propose(
      f.actor,
      key(),
      { ...f.input, amount: '90.00' },
      { id: initial.id, version: initial.version },
    );
    expect(
      (await request(f, `/correction-proposals/${initial.id}/post`, review(initial))).status,
    ).toBe(409);
    expect(changed.version).toBe(2);
    expect(changed.hash).not.toBe(initial.hash);
    await service.books.approve(f.actor, key(), changed.id, review(changed));
    await service.corrections.withdraw(f.actor, key(), changed.id, review(changed));
    expect(
      (await request(f, `/correction-proposals/${changed.id}/post`, review(changed))).status,
    ).toBe(409);
    expect((await request(f, `/proposals/${changed.id}/approve`, review(changed))).status).toBe(
      409,
    );
    expect(
      (
        await request(
          f,
          `/correction-proposals/${changed.id}`,
          { ...f.input, version: changed.version },
          { method: 'PUT' },
        )
      ).status,
    ).toBe(409);
    expect(
      (await service.overview(f.actor)).proposals.find((item) => item.id === changed.id)?.withdrawn,
    ).toBe(true);
    expect(
      await db.orm
        .select()
        .from(approvals)
        .where(and(eq(approvals.companyId, f.company.id), eq(approvals.proposalId, changed.id))),
    ).toHaveLength(2);
    const valid = await propose(f);
    await post(f, valid);
    expect(amounts(await service.overview(f.actor))['628']).toBe('80.00');
  });

  test('a competing correction loses its stale target and posting stays idempotent', async () => {
    const f = await fixture();
    const first = await propose(f),
      second = await propose(f, { ...f.input, amount: '90.00' });
    await service.books.approve(f.actor, key(), first.id, review(first));
    await service.books.approve(f.actor, key(), second.id, review(second));
    const responses = await Promise.all([
      request(f, `/correction-proposals/${first.id}/post`, review(first)),
      request(f, `/correction-proposals/${second.id}/post`, review(second)),
    ]);
    expect(responses.map((item) => item.status).sort()).toEqual([200, 409]);
    const state = await service.overview(f.actor);
    expect(state.journals).toHaveLength(3);
    expect(state.corrections).toHaveLength(1);
    const winner = responses[0].ok ? first : second;
    const commandKey = key();
    const attempts = await Promise.all([
      request(f, `/correction-proposals/${winner.id}/post`, review(winner), { key: commandKey }),
      request(f, `/correction-proposals/${winner.id}/post`, review(winner), { key: commandKey }),
    ]);
    expect(attempts.every((item) => item.ok)).toBe(true);
    expect(
      (
        await request(
          f,
          `/correction-proposals/${winner.id}/post`,
          { ...review(winner), hash: '0'.repeat(64) },
          { key: commandKey },
        )
      ).status,
    ).toBe(409);
    expect((await service.overview(f.actor)).journals).toHaveLength(3);
  });

  test('chains amount changes, full reversal and restoration while retaining every link', async () => {
    const f = await fixture();
    let head = f.original.id;
    for (const amount of ['120.00', '80.00', '0.00', '90.00']) {
      const proposal = await propose(f, {
        ...f.input,
        journalId: head,
        amount,
        action: amount === '0.00' ? 'reverse' : 'replace',
      });
      head = (await post(f, proposal)).id;
    }
    const state = await service.overview(f.actor);
    expect(state.journals).toHaveLength(6);
    expect(state.corrections).toHaveLength(4);
    expect(amounts(state)).toEqual({
      '1012': '-1000.00',
      '401': '-90.00',
      '5121': '1000.00',
      '628': '90.00',
    });
    expect(state.proposals.find((item) => item.id === f.purchase.id)?.currentJournalId).toBe(head);
    expect((await request(f, '/correction-proposals', f.input)).status).toBe(409);
  });

  test('rechecks allocated payments after approval and enforces the corrected payable', async () => {
    const f = await fixture('40.00');
    expect(
      (await request(f, '/correction-proposals', { ...f.input, amount: '39.00' })).status,
    ).toBe(409);
    expect(
      (await request(f, '/correction-proposals', { ...f.input, action: 'reverse', amount: '0.00' }))
        .status,
    ).toBe(409);
    const proposal = await propose(f);
    await service.books.approve(f.actor, key(), proposal.id, review(proposal));
    await pay(f, '50.00', '2026-10-06');
    expect(
      (await request(f, `/correction-proposals/${proposal.id}/post`, review(proposal))).status,
    ).toBe(409);
    expect((await service.overview(f.actor)).corrections).toHaveLength(0);
    const g = await fixture('40.00');
    await post(g, await propose(g, { ...g.input, amount: '60.00' }));
    await expect(pay(g, '30.00', '2026-11-02')).rejects.toThrow('Plata depășește soldul facturii.');
    await pay(g, '20.00', '2026-11-03');
    expect(amounts(await service.overview(g.actor))['401']).toBe('0.00');
    const h = await fixture();
    await post(h, await propose(h, { ...h.input, amount: '120.00' }));
    await expect(pay(h, '110.00', '2026-10-06')).rejects.toThrow(
      'Plata depășește soldul facturii.',
    );
  });

  test('withdrawal clears the close blocker without removing facts or affecting balances', async () => {
    const f = await fixture('40.00');
    const proposal = await propose(f, { ...f.input, date: '2026-10-20' });
    await expect(service.periods.close(f.actor, key(), '2026-10-01')).rejects.toThrow(
      'Există propuneri necontabilizate',
    );
    await service.corrections.withdraw(f.actor, key(), proposal.id, review(proposal));
    await service.periods.close(f.actor, key(), '2026-10-01');
    const state = await service.overview(f.actor);
    expect(state.journals).toHaveLength(3);
    expect(state.proposals.find((item) => item.id === proposal.id)?.withdrawn).toBe(true);
    expect(amounts(state)['628']).toBe('100.00');
  });

  test('database guards reject a balanced posting different from approval and preserve immutable links', async () => {
    const f = await fixture();
    const proposal = await propose(f);
    const approval = await service.books.approve(f.actor, key(), proposal.id, review(proposal));
    await expect(
      db.orm.transaction((tx) =>
        postJournal(tx, f.actor, {
          kind: 'correction',
          sourceId: proposal.id,
          date: f.input.date,
          evidenceId: f.input.evidenceId,
          approvalId: approval.id,
          description: 'Deliberately incorrect balanced mutation',
          lines: [
            { account: '628', debit: '0.00', credit: '20.00' },
            { account: '401', debit: '20.00', credit: '0.00' },
          ],
        }),
      ),
    ).rejects.toThrow();
    expect((await service.overview(f.actor)).journals).toHaveLength(2);
    await service.corrections.post(f.actor, key(), proposal.id, review(proposal));
    await expect(
      db.orm
        .delete(correctionOutcomes)
        .where(eq(correctionOutcomes.companyId, f.company.id))
        .execute(),
    ).rejects.toThrow();
    await expect(
      db.orm
        .update(journalLines)
        .set({ debitBani: 0n })
        .where(eq(journalLines.companyId, f.company.id))
        .execute(),
    ).rejects.toThrow();
  });

  test('exports and fresh restore preserve the correction chain, originals and retry result', async () => {
    const f = await fixture('40.00');
    await service.periods.close(f.actor, key(), '2026-10-01');
    const proposal = await propose(f);
    const commandKey = key();
    const entry = await post(f, proposal, commandKey);
    const job = await service.exports.request(f.actor, key());
    while (await runOneExport(db, objects)) {}
    const exported = JSON.parse((await service.exports.download(f.actor, job.id)).bytes.toString());
    expect(exported.data.correctionOutcomes).toHaveLength(1);
    expect(exported.data.correctionOutcomes[0].journalId).toBe(entry.id);
    for (const source of exported.originals)
      expect(sha256(Buffer.from(source.base64, 'base64'))).toBe(source.hash);
    const suffix = key();
    const target = join(directory, `backup-${suffix}`);
    await backup(db, objects, target);
    const restored = await restore(target, join(directory, `restored-${suffix}`));
    const fresh = new Database(restored.databaseUrl);
    try {
      await migrate(fresh);
      const recovered = new Accounting(fresh, new LocalObjectStore(restored.objectDir), secret);
      expect(amounts(await recovered.overview(f.actor))['628']).toBe('80.00');
      expect(
        (await recovered.corrections.post(f.actor, commandKey, proposal.id, review(proposal))).id,
      ).toBe(entry.id);
      expect((await recovered.overview(f.actor)).journals).toHaveLength(4);
    } finally {
      await fresh.close();
    }
  });
});
