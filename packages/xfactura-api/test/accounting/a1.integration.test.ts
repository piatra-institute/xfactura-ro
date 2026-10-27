import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { journalLines, jobs, periods } from '../../source/accounting/schema';
import type { Overview } from '../../source/accounting/queries';
import { Database } from '../../source/accounting/db';
import { migrate } from '../../source/accounting/migrate';
import { LocalObjectStore, sha256 } from '../../source/accounting/object-store';
import { Accounting } from '../../source/accounting/application';
import { createApp } from '../../source/accounting/app';
import { createAuth } from '../../source/accounting/auth';
import { backup, restore } from '../../source/accounting/backup';
import { runOneExport } from '../../source/accounting/worker';

const publicUrl = 'http://localhost:3000',
  authSecret = 'synthetic-test-auth-secret-at-least-32-characters';
const origin = { origin: publicUrl };
let db: Database, worker: Database, objects: LocalObjectStore, service: Accounting;
let databaseUrl: string;
let application: ReturnType<typeof createApp>,
  ownerCookie: string,
  outsiderCookie: string,
  ownerId: string,
  outsiderId: string,
  directory: string;
let paymentCommandKey: string;
let company: string,
  openingEvidence: string,
  purchase: Record<string, any>,
  statement: Record<string, any>;
const key = () => randomUUID();
async function request(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    cookie?: string;
    commandKey?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const headers = { ...origin, cookie: options.cookie ?? ownerCookie, ...options.headers };
  const init: RequestInit = { method: options.method ?? 'GET', headers };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
    Object.assign(headers, {
      'content-type': 'application/json',
      'Idempotency-Key': options.commandKey ?? key(),
    });
  }
  return application.app.request(`${publicUrl}/api/accounting/v1${path}`, init);
}
async function command(path: string, body: unknown, commandKey = key(), cookie = ownerCookie) {
  const response = await request(`/companies/${company}${path}`, {
    method: 'POST',
    body,
    commandKey,
    cookie,
  });
  const result = (await response.json()) as Record<string, any>;
  expect(response.status, JSON.stringify(result)).toBe(200);
  return result;
}
async function upload(filename: string, text: string, commandKey = key()) {
  const data = new FormData();
  data.set(
    'file',
    new File([text], filename, { type: filename.endsWith('.csv') ? 'text/csv' : 'text/plain' }),
  );
  const response = await application.app.request(
    `${publicUrl}/api/accounting/v1/companies/${company}/evidence`,
    {
      method: 'POST',
      headers: { ...origin, cookie: ownerCookie, 'Idempotency-Key': commandKey },
      body: data,
    },
  );
  expect(response.status).toBe(200);
  return response.json() as Promise<Record<string, any>>;
}
async function snapshot() {
  const response = await request(`/companies/${company}`);
  expect(response.status).toBe(200);
  return response.json() as Promise<Overview>;
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xfactura-a1-'));
  databaseUrl = `file:${directory}/test.db`;
  db = new Database(databaseUrl);
  await migrate(db);
  worker = new Database(databaseUrl);
  await worker.initialize();
  objects = new LocalObjectStore(join(directory, 'objects'));
  service = new Accounting(db, objects, authSecret);
  application = createApp(service, { publicUrl, authSecret });
  const provision = createAuth(db, { publicUrl, authSecret }, true);
  for (const [index, email] of ['owner@example.test', 'outsider@example.test'].entries()) {
    const result = await provision.api.signUpEmail({
      body: {
        email,
        name: index === 0 ? 'Owner' : 'Other company',
        password: 'synthetic-password-123',
      },
    });
    const response = await application.app.request(
      `${publicUrl}/api/accounting/auth/sign-in/email`,
      {
        method: 'POST',
        headers: { ...origin, 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'synthetic-password-123' }),
      },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    if (index === 0) {
      ownerCookie = cookie;
      ownerId = result.user.id;
    } else {
      outsiderCookie = cookie;
      outsiderId = result.user.id;
    }
  }
}, 30000);
afterAll(async () => {
  if (db) await db.close();
  if (worker) await worker.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('A1 through the authenticated API and SQLite/Drizzle', () => {
  test('requires login and refuses public registration', async () => {
    const response = await application.app.request(`${publicUrl}/api/accounting/v1/companies`);
    expect(response.status).toBe(401);
    const signup = await application.app.request(`${publicUrl}/api/accounting/auth/sign-up/email`, {
      method: 'POST',
      headers: { ...origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'blocked@example.test',
        name: 'Blocked',
        password: 'synthetic-password-123',
      }),
    });
    expect(signup.status).not.toBe(200);
  });
  test('creates an isolated company idempotently and retains opening evidence', async () => {
    const commandKey = key(),
      body = { name: 'A1 Servicii SRL', cui: '12345678', year: 2026 };
    const first = await request('/companies', { method: 'POST', body, commandKey });
    expect(first.status).toBe(200);
    company = (await first.json()).id;
    const replay = await request('/companies', { method: 'POST', body, commandKey });
    expect((await replay.json()).id).toBe(company);
    expect(
      (
        await request('/companies', {
          method: 'POST',
          body: { ...body, name: 'Changed' },
          commandKey,
        })
      ).status,
    ).toBe(409);
    const doc = await upload(
      'opening.txt',
      'Synthetic approved opening: Dr 5121 / Cr 1012 = RON 1000.00',
    );
    openingEvidence = doc.id;
    expect(doc.hash).toBe(sha256('Synthetic approved opening: Dr 5121 / Cr 1012 = RON 1000.00'));
    const duplicate = await upload(
      'opening-copy.txt',
      'Synthetic approved opening: Dr 5121 / Cr 1012 = RON 1000.00',
    );
    expect(duplicate.id).toBe(doc.id);
  });
  test('posts the opening only after exact approval and rejects non-decimal input', async () => {
    const invalid = await request(`/companies/${company}/opening-proposals`, {
      method: 'POST',
      body: { date: '2026-01-01', amount: 1000, evidenceId: openingEvidence },
    });
    expect(invalid.status).toBe(422);
    const proposal = await command('/opening-proposals', {
      date: '2026-01-01',
      amount: '1000.00',
      evidenceId: openingEvidence,
    });
    const review = { version: proposal.version, hash: proposal.hash };
    expect(
      (
        await request(`/companies/${company}/proposals/${proposal.id}/post`, {
          method: 'POST',
          body: review,
        })
      ).status,
    ).toBe(409);
    await command(`/proposals/${proposal.id}/approve`, review);
    await command(`/proposals/${proposal.id}/post`, review);
  });
  test('revising a purchase preserves facts and invalidates its old approval', async () => {
    const source = await upload(
      'supplier.txt',
      'Synthetic RO supplier invoice P-1: service RON 100.00, no VAT',
    );
    const body = {
      evidenceId: source.id,
      supplier: 'Furnizor SRL',
      supplierCui: '87654321',
      invoiceNumber: 'P-1',
      date: '2026-10-01',
      serviceDate: '2026-10-01',
      amount: '100.00',
      description: 'Servicii de test',
      supplierCountry: 'RO',
      currency: 'RON',
      vatTreatment: 'NON_VAT',
    };
    purchase = await command('/purchase-proposals', body);
    const oldReview = { version: purchase.version, hash: purchase.hash };
    await command(`/proposals/${purchase.id}/approve`, oldReview);
    const response = await request(`/companies/${company}/purchase-proposals/${purchase.id}`, {
      method: 'PUT',
      body: { ...body, description: 'Servicii verificate în document', version: purchase.version },
    });
    expect(response.status).toBe(200);
    purchase = await response.json();
    expect(
      (
        await request(`/companies/${company}/proposals/${purchase.id}/post`, {
          method: 'POST',
          body: oldReview,
        })
      ).status,
    ).toBe(409);
    const review = { version: purchase.version, hash: purchase.hash };
    await command(`/proposals/${purchase.id}/approve`, review);
    const commandKey = key();
    const results = await Promise.all([
      command(`/proposals/${purchase.id}/post`, review, commandKey),
      command(`/proposals/${purchase.id}/post`, review, commandKey),
      command(`/proposals/${purchase.id}/post`, review),
    ]);
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    const state = await snapshot();
    expect(state.journals).toHaveLength(2);
    expect(state.fiscalInterpretations).toHaveLength(3);
    expect(state.taxPositions[0].status).toBe('PENDING_REVIEW');
  });
  test('imports, deduplicates and reconciles the real statement movement', async () => {
    const csv =
      'movement_id,booking_date,amount,currency,reference\nPAY-1,2026-10-03,-100.00,RON,P-1\n';
    const source = await upload('statement.csv', csv);
    const body = {
      evidenceId: source.id,
      bankAccount: 'RO00TESTACCOUNT',
      statementId: 'OCT-2026',
      from: '2026-10-01',
      to: '2026-10-31',
      opening: '1000.00',
      closing: '900.00',
    };
    expect(
      (
        await request(`/companies/${company}/statements`, {
          method: 'POST',
          body: { ...body, closing: '899.00' },
        })
      ).status,
    ).toBe(422);
    statement = await command('/statements', body);
    expect((await command('/statements', body)).id).toBe(statement.id);
    const state = await snapshot();
    expect(state.movements).toHaveLength(1);
    const allocation = {
      movementId: state.movements[0].id,
      proposalId: purchase.id,
      amount: '100.00',
    };
    const commandKey = key();
    paymentCommandKey = commandKey;
    const results = await Promise.all([
      command('/matches', allocation, commandKey),
      command('/matches', allocation, commandKey),
      command('/matches', allocation),
    ]);
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    const after = await snapshot();
    expect(after.journals).toHaveLength(3);
    expect(after.balances).toEqual([
      { account: '1012', debit: '0.00', credit: '1000.00', balance: '-1000.00' },
      { account: '401', debit: '100.00', credit: '100.00', balance: '0.00' },
      { account: '5121', debit: '1000.00', credit: '100.00', balance: '900.00' },
      { account: '628', debit: '100.00', credit: '0.00', balance: '100.00' },
    ]);
  });
  test('company isolation applies to API, evidence references, exports and membership', async () => {
    expect((await request(`/companies/${company}`, { cookie: outsiderCookie })).status).toBe(404);
    expect(
      (
        await request(`/companies/${company}/evidence/${openingEvidence}`, {
          cookie: outsiderCookie,
        })
      ).status,
    ).toBe(404);
    const other = await request('/companies', {
      method: 'POST',
      cookie: outsiderCookie,
      body: { name: 'Altă companie SRL', cui: '11223344', year: 2026 },
    });
    expect(other.status).toBe(200);
    const otherId = ((await other.json()) as { id: string }).id;
    const crossReference = await request(`/companies/${otherId}/purchase-proposals`, {
      method: 'POST',
      cookie: outsiderCookie,
      body: { ...purchase.body, evidenceId: openingEvidence },
    });
    expect(crossReference.status).toBe(404);
    const otherBooks = await request(`/companies/${otherId}`, { cookie: outsiderCookie });
    expect(((await otherBooks.json()) as Overview).journals).toHaveLength(0);
    expect(
      (
        await request(`/companies/${company}/exports`, {
          method: 'POST',
          body: {},
          cookie: outsiderCookie,
        })
      ).status,
    ).toBe(404);
  });
  test('closed periods and posted records cannot mutate', async () => {
    await command('/periods/2026-10-01/close', {});
    await expect(
      db.orm
        .update(journalLines)
        .set({ debitBani: 0n })
        .where(eq(journalLines.companyId, company))
        .execute(),
    ).rejects.toThrow();
    const source = await upload('late.txt', 'Synthetic late invoice');
    const proposal = await command('/purchase-proposals', {
      ...purchase.body,
      invoiceNumber: 'LATE-1',
      evidenceId: source.id,
    });
    const review = { version: proposal.version, hash: proposal.hash };
    await command(`/proposals/${proposal.id}/approve`, review);
    expect(
      (
        await request(`/companies/${company}/proposals/${proposal.id}/post`, {
          method: 'POST',
          body: review,
        })
      ).status,
    ).toBe(409);
    expect((await snapshot()).journals).toHaveLength(3);
  });
  test('durable exports include original bytes and survive worker recreation', async () => {
    const job = await command('/exports', {});
    const restarted = new Database(databaseUrl);
    try {
      expect(await runOneExport(restarted, objects)).toBe(true);
    } finally {
      await restarted.close();
    }
    const response = await request(`/companies/${company}/exports/${job.id}`);
    expect(response.status).toBe(200);
    const bytes = await response.text();
    expect(response.headers.get('X-Content-SHA256')).toBe(sha256(bytes));
    const result = JSON.parse(bytes);
    expect(result.data.journals).toHaveLength(3);
    expect(result.originals.length).toBeGreaterThan(2);
    for (const source of result.originals)
      expect(sha256(Buffer.from(String(source.base64), 'base64'))).toBe(source.hash);
    expect(bytes).not.toContain('synthetic-password');
    expect(bytes).not.toContain('session_token');
    const recreated = new Database(databaseUrl);
    try {
      const reloaded = await new Accounting(recreated, objects, authSecret).overview({
        actorId: ownerId,
        companyId: company,
      });
      expect(reloaded.balances.find((row) => row.account === '5121')?.balance).toBe('900.00');
    } finally {
      await recreated.close();
    }
  });
  test('a coherent backup restores books, source bytes and idempotency in a fresh environment', async () => {
    const target = join(directory, 'backup');
    const proof = await backup(db, objects, target);
    expect(proof.objects).toBeGreaterThan(2);
    const restored = await restore(target, join(directory, 'restored'));
    const recovered = new Database(restored.databaseUrl);
    try {
      await recovered.initialize();
      const app = new Accounting(recovered, new LocalObjectStore(restored.objectDir), authSecret);
      const books = await app.overview({ actorId: ownerId, companyId: company });
      expect(books.journals).toHaveLength(3);
      expect(books.balances.find((row) => row.account === '5121')?.balance).toBe('900.00');
      for (const source of books.evidence) {
        const original = await app.documents.read(
          { actorId: ownerId, companyId: company },
          source.id,
        );
        expect(sha256(original.bytes)).toBe(source.hash);
      }
      const movement = books.movements.find((item) => item.matched)!;
      await app.bank.match({ actorId: ownerId, companyId: company }, paymentCommandKey, {
        movementId: movement.id,
        proposalId: purchase.id,
        amount: '100.00',
      });
      expect((await app.overview({ actorId: ownerId, companyId: company })).journals).toHaveLength(
        3,
      );
      await expect(restore(target, restored.directory)).rejects.toThrow('already exists');
    } finally {
      await recovered.close();
    }
  });

  test('revocation blocks cached results and queued work, and old invitations cannot restore access', async () => {
    const invite = await command('/invitations', {
      email: 'outsider@example.test',
      role: 'viewer',
    });
    const accept = () =>
      request('/invitations/accept', {
        method: 'POST',
        body: { token: invite.token },
        cookie: outsiderCookie,
      });
    expect((await accept()).status).toBe(200);
    expect((await accept()).status).toBe(200);
    expect((await request(`/companies/${company}`, { cookie: outsiderCookie })).status).toBe(200);
    const denied = await request(`/companies/${company}/purchase-proposals`, {
      method: 'POST',
      body: purchase.body,
      cookie: outsiderCookie,
    });
    expect(denied.status).toBe(403);
    const commandKey = key();
    const queued = await command('/exports', {}, commandKey, outsiderCookie);
    await command(`/members/${outsiderId}/revoke`, {});
    expect(
      (
        await request(`/companies/${company}/exports`, {
          method: 'POST',
          body: {},
          commandKey,
          cookie: outsiderCookie,
        })
      ).status,
    ).toBe(404);
    expect((await accept()).status).toBe(404);
    await runOneExport(worker, objects);
    const after = await snapshot();
    expect(after.jobs.find((item) => item.id === queued.id)?.status).toBe('failed');
  });

  test('a crashed worker lease is reclaimed without losing the frozen export snapshot', async () => {
    const job = await command('/exports', {});
    await db.orm
      .update(jobs)
      .set({ status: 'running', attempts: 1, leaseToken: key(), leaseUntil: Date.now() - 1000 })
      .where(and(eq(jobs.companyId, company), eq(jobs.id, job.id)));
    const added = await upload('after-snapshot.txt', 'Evidence received after the export request');
    expect(await runOneExport(worker, objects)).toBe(true);
    const response = await request(`/companies/${company}/exports/${job.id}`);
    expect(response.status).toBe(200);
    const exported = (await response.json()) as { originals: { id: string }[] };
    expect(exported.originals.some((source) => source.id === added.id)).toBe(false);
    const [stored] = await db.orm
      .select()
      .from(jobs)
      .where(and(eq(jobs.companyId, company), eq(jobs.id, job.id)));
    expect(stored.attempts).toBe(2);
  });

  test('OpenAPI describes every mounted versioned route using the input schemas', async () => {
    const response = await application.app.request(`${publicUrl}/api/accounting/openapi.json`);
    expect(response.status).toBe(200);
    const spec = (await response.json()) as {
      openapi: string;
      paths: Record<string, Record<string, unknown>>;
    };
    expect(spec.openapi).toBe('3.1.0');
    for (const route of application.app.routes.filter(
      (item) => item.path.startsWith('/api/accounting/v1/') && item.method !== 'ALL',
    )) {
      expect(
        spec.paths[route.path.replace(/:(\w+)/g, '{$1}')][route.method.toLowerCase()],
      ).toBeDefined();
    }
  });

  test('large integer amounts survive migration replay and multi-month statements cannot hide a close difference', async () => {
    await migrate(db);
    const precise = await service.companies.create(ownerId, key(), {
      name: 'Precise balances SRL',
      cui: '33445566',
      year: 2026,
    });
    const actor = { actorId: ownerId, companyId: precise.id };
    const source = await service.documents.record(actor, key(), {
      filename: 'opening.txt',
      mediaType: 'text/plain',
      bytes: new TextEncoder().encode(
        'Opening balance independently specified as 90071992547409.93 RON',
      ),
    });
    const opening = await service.books.proposeOpening(actor, key(), {
      date: '2026-01-01',
      amount: '90071992547409.93',
      evidenceId: source.id,
    });
    const review = { version: opening.version, hash: opening.hash };
    await service.books.approve(actor, key(), opening.id, review);
    await service.books.post(actor, key(), opening.id, review);
    expect(
      (await service.overview(actor)).balances.find((row) => row.account === '5121')?.balance,
    ).toBe('90071992547409.93');
    const csv =
      'movement_id,booking_date,amount,currency,reference\nLATER,2026-11-03,-0.01,RON,Later movement\n';
    const bankSource = await service.documents.record(actor, key(), {
      filename: 'two-months.csv',
      mediaType: 'text/csv',
      bytes: new TextEncoder().encode(csv),
    });
    await service.bank.importStatement(actor, key(), {
      evidenceId: bankSource.id,
      bankAccount: 'RO00PRECISE',
      statementId: 'OCT-NOV',
      from: '2026-10-01',
      to: '2026-11-30',
      opening: '90071992547409.94',
      closing: '90071992547409.93',
    });
    await expect(service.periods.close(actor, key(), '2026-10-01')).rejects.toThrow(
      'Soldul contabil diferă de extrasul bancar.',
    );
    expect(
      await db.orm.select().from(periods).where(eq(periods.companyId, precise.id)),
    ).toHaveLength(0);
  });
});
