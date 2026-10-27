import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { Accounting } from '../../source/accounting/application';
import { createApp } from '../../source/accounting/app';
import { createAuth } from '../../source/accounting/auth';
import { agentCapabilities } from '../../source/accounting/capability-policy';
import { capabilityDescriptor } from '../../source/accounting/capabilities';
import {
  evidenceOutput,
  grantOutput,
  movementOutput,
  pageOutput,
  postingOutput,
  proposalOutput,
  proposalView,
  reviewOutput,
} from '../../source/accounting/capability-contracts';
import { Database } from '../../source/accounting/db';
import { migrate } from '../../source/accounting/migrate';
import { LocalObjectStore } from '../../source/accounting/object-store';
import {
  actionReviews,
  agentGrants,
  audit,
  commands,
  jobs,
  memberships,
} from '../../source/accounting/schema';
import { runOneExport } from '../../source/accounting/worker';
import type { Actor } from '../../source/accounting/commands';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { backup, restore } from '../../source/accounting/backup';

const key = () => randomUUID();
const publicUrl = 'http://localhost:3000';
const secret = 'synthetic-agent-secret-at-least-32-characters';
let directory: string, db: Database, service: Accounting, app: ReturnType<typeof createApp>;
let ownerId: string, reviewerId: string, cookie: string, reviewerCookie: string;
let objects: LocalObjectStore;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xfactura-agents-'));
  db = new Database(`file:${directory}/books.db`);
  await migrate(db);
  objects = new LocalObjectStore(join(directory, 'objects'));
  service = new Accounting(db, objects, secret);
  app = createApp(service, { publicUrl, authSecret: secret });
  const provision = createAuth(db, { publicUrl, authSecret: secret }, true);
  for (const name of ['owner', 'reviewer']) {
    const user = await provision.api.signUpEmail({
      body: { name, email: `${name}@agents.test`, password: 'synthetic-agents-password' },
    });
    const response = await app.app.request(`${publicUrl}/api/accounting/auth/sign-in/email`, {
      method: 'POST',
      headers: { origin: publicUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ email: `${name}@agents.test`, password: 'synthetic-agents-password' }),
    });
    expect(response.status).toBe(200);
    const session = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    if (name === 'owner') {
      ownerId = user.user.id;
      cookie = session;
    } else {
      reviewerId = user.user.id;
      reviewerCookie = session;
    }
  }
});
afterAll(async () => {
  if (db) await db.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function http(
  company: string,
  capability: string,
  body: unknown = {},
  options: { token?: string; cookie?: string; key?: string; origin?: string | null } = {},
) {
  return app.app.request(
    `${publicUrl}/api/accounting/v1/companies/${company}/capabilities/${capability}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': options.key ?? key(),
        ...(options.token
          ? { authorization: `Bearer ${options.token}` }
          : { cookie: options.cookie ?? cookie }),
        ...(options.origin === null || (options.token && options.origin === undefined)
          ? {}
          : { origin: options.origin ?? publicUrl }),
      },
      body: JSON.stringify(body),
    },
  );
}
async function invoke<T extends z.ZodType>(
  schema: T,
  company: string,
  capability: string,
  body: unknown = {},
  token?: string,
  commandKey = key(),
): Promise<z.output<T>> {
  const response = await http(company, capability, body, { token, key: commandKey });
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(200);
  return schema.parse(result);
}
async function fixture(scopes = agentCapabilities) {
  const company = await service.companies.create(ownerId, key(), {
    name: 'Agent fixture SRL',
    cui: '12345678',
    year: 2026,
  });
  const actor: Actor = { actorId: ownerId, companyId: company.id };
  const input = {
    name: 'Accounting agent',
    scopes,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  };
  const issued = await invoke(
    grantOutput.extend({ token: z.string() }),
    company.id,
    'agents.issue',
    input,
  );
  return { company: company.id, actor, issued, input, agent: { ...actor, agentId: issued.id } };
}
async function source(company: string, token: string, text: string, filename = 'source.txt') {
  return invoke(
    evidenceOutput,
    company,
    'evidence.record',
    {
      filename,
      mediaType: filename.endsWith('.csv') ? 'text/csv' : 'text/plain',
      base64: Buffer.from(text).toString('base64'),
    },
    token,
  );
}
async function purchase(company: string, token: string, amount = '100.00', invoiceNumber = key()) {
  const evidence = await source(
    company,
    token,
    `Independent invoice amount RON ${amount}; ${invoiceNumber}`,
  );
  return invoke(
    proposalOutput,
    company,
    'books.proposePurchase',
    {
      evidenceId: evidence.id,
      supplier: 'Furnizor SRL',
      supplierCui: '87654321',
      invoiceNumber,
      date: '2026-10-01',
      serviceDate: '2026-10-01',
      amount,
      description: 'Servicii documentate',
      supplierCountry: 'RO',
      currency: 'RON',
      vatTreatment: 'NON_VAT',
    },
    token,
  );
}
async function approveAndPost(
  company: string,
  token: string,
  proposal: z.output<typeof proposalOutput>,
) {
  const body = { id: proposal.id, version: proposal.version, hash: proposal.hash };
  expect((await http(company, 'books.approve', body)).status).toBe(200);
  return invoke(postingOutput, company, 'books.post', body, token);
}
async function booksFixture() {
  const f = await fixture();
  const token = f.issued.token;
  const openingSource = await source(f.company, token, 'Approved opening: 1000 RON bank/capital');
  const opening = await invoke(
    proposalOutput,
    f.company,
    'books.proposeOpening',
    { date: '2026-01-01', amount: '1000.00', evidenceId: openingSource.id },
    token,
  );
  await approveAndPost(f.company, token, opening);
  const invoice = await purchase(f.company, token);
  await approveAndPost(f.company, token, invoice);
  const statement = await source(
    f.company,
    token,
    'movement_id,booking_date,amount,currency,reference\nPAY-1,2026-10-03,-100.00,RON,Invoice\n',
    'statement.csv',
  );
  await http(
    f.company,
    'bank.importStatement',
    {
      evidenceId: statement.id,
      bankAccount: 'RO00AGENTS',
      statementId: 'OCT-2026',
      from: '2026-10-01',
      to: '2026-10-31',
      opening: '1000.00',
      closing: '900.00',
    },
    { token },
  );
  const movements = await invoke(
    pageOutput(movementOutput),
    f.company,
    'bank.movements',
    { matched: false },
    token,
  );
  return {
    ...f,
    invoice,
    allocation: { movementId: movements.items[0].id, proposalId: invoice.id, amount: '100.00' },
  };
}

describe('shared accounting capabilities and delegated agents', () => {
  test('discovers only implemented, granted capabilities with input/output schemas', async () => {
    const f = await fixture(['books.summary', 'proposals.list']);
    const result = await invoke(
      z.object({ version: z.literal('1'), capabilities: z.array(capabilityDescriptor) }),
      f.company,
      'capabilities.list',
      {},
      f.issued.token,
    );
    expect(result.capabilities.map((item) => item.id).sort()).toEqual([
      'books.summary',
      'capabilities.list',
      'proposals.list',
    ]);
    expect(
      result.capabilities.every(
        (item) => item.inputSchema.type === 'object' && item.outputSchema.type === 'object',
      ),
    ).toBe(true);
    expect((await http(f.company, 'evidence.list', {}, { token: f.issued.token })).status).toBe(
      403,
    );
    expect((await http(f.company, 'tax.calculate', {}, { token: f.issued.token })).status).toBe(
      404,
    );
    for (const name of ['constructor', '__proto__'])
      expect((await http(f.company, name, {}, { token: f.issued.token })).status).toBe(404);
    expect(
      (
        await http(
          f.company,
          'books.summary',
          { rawSql: 'select * from user' },
          { token: f.issued.token },
        )
      ).status,
    ).toBe(422);
  });

  test('agent preparation pauses for human approval; stale proposal approval cannot authorize a revision', async () => {
    const f = await fixture();
    const proposal = await purchase(f.company, f.issued.token);
    const body = { id: proposal.id, version: proposal.version, hash: proposal.hash };
    expect((await http(f.company, 'books.approve', body, { token: f.issued.token })).status).toBe(
      403,
    );
    await expect(
      service.books.approve(f.agent, key(), proposal.id, {
        version: proposal.version,
        hash: proposal.hash,
      }),
    ).rejects.toMatchObject({ code: 'AGENT_SCOPE' });
    expect((await http(f.company, 'books.post', body, { token: f.issued.token })).status).toBe(409);
    expect((await http(f.company, 'books.approve', body)).status).toBe(200);
    const revised = await invoke(
      proposalOutput,
      f.company,
      'books.revisePurchase',
      {
        ...proposal.body,
        id: proposal.id,
        version: proposal.version,
        description: 'Servicii revizuite după document',
      },
      f.issued.token,
    );
    expect((await http(f.company, 'books.post', body, { token: f.issued.token })).status).toBe(409);
    const view = await invoke(
      proposalView,
      f.company,
      'proposals.get',
      { id: revised.id },
      f.issued.token,
    );
    expect(view.approved).toBe(false);
    expect(view.lines).toEqual([
      { account: '628', debit: '100.00', credit: '0.00' },
      { account: '401', debit: '0.00', credit: '100.00' },
    ]);
  });

  test('agent cannot call human-only legacy routes, grant itself authority, or switch company', async () => {
    const f = await fixture();
    for (const capability of [
      'agents.issue',
      'agents.revoke',
      'agents.list',
      'company.invite',
      'books.approve',
      'reviews.approve',
      'bank.match',
      'periods.close',
    ])
      expect(
        (await http(f.company, capability, {}, { token: f.issued.token })).status,
        capability,
      ).toBe(403);
    const other = await service.companies.create(ownerId, key(), {
      name: 'Another company SRL',
      cui: '11223344',
      year: 2026,
    });
    expect((await http(other.id, 'books.summary', {}, { token: f.issued.token })).status).toBe(401);
    const raw = await app.app.request(
      `${publicUrl}/api/accounting/v1/companies/${f.company}/proposals/${key()}/approve`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${f.issued.token}`,
          'content-type': 'application/json',
          'idempotency-key': key(),
        },
        body: JSON.stringify({ version: 1, hash: '0'.repeat(64) }),
      },
    );
    expect(raw.status).toBe(403);
    const invalidScope = await http(f.company, 'agents.issue', {
      ...f.input,
      scopes: ['books.approve'],
    });
    expect(invalidScope.status).toBe(422);
  });

  test('matching and closing execute only exact human-approved snapshots and retry without duplication', async () => {
    const f = await booksFixture(),
      token = f.issued.token;
    const review = await invoke(
      reviewOutput,
      f.company,
      'reviews.request',
      { operation: 'bank.match', input: f.allocation },
      token,
    );
    expect(review.effect).toMatchObject({
      kind: 'bank.match',
      lines: [
        { account: '401', debit: '100.00', credit: '0.00' },
        { account: '5121', debit: '0.00', credit: '100.00' },
      ],
    });
    const body = { id: review.id, hash: review.hash };
    expect((await http(f.company, 'reviews.execute', body, { token })).status).toBe(409);
    expect((await http(f.company, 'reviews.approve', body, { token })).status).toBe(403);
    expect((await http(f.company, 'reviews.approve', body)).status).toBe(200);
    const commandKey = key();
    const executed = await invoke(
      reviewOutput,
      f.company,
      'reviews.execute',
      body,
      token,
      commandKey,
    );
    expect(executed.executedAt).not.toBeNull();
    expect(
      await invoke(reviewOutput, f.company, 'reviews.execute', body, token, commandKey),
    ).toEqual(executed);
    const close = await invoke(
      reviewOutput,
      f.company,
      'reviews.request',
      { operation: 'periods.close', input: { month: '2026-10-01' } },
      token,
    );
    expect(close.effect).toMatchObject({
      kind: 'periods.close',
      month: '2026-10-01',
      bankBalance: '900.00',
      journalCount: 3,
    });
    expect(
      (await http(f.company, 'reviews.approve', { id: close.id, hash: close.hash })).status,
    ).toBe(200);
    await invoke(
      reviewOutput,
      f.company,
      'reviews.execute',
      { id: close.id, hash: close.hash },
      token,
    );
    const overview = await service.overview(f.actor);
    expect(overview.journals).toHaveLength(3);
    expect(overview.balances.find((row) => row.account === '5121')?.balance).toBe('900.00');
    expect(overview.closedPeriods[0].closedAt).not.toBeNull();
  });

  test('a correction after approval invalidates the payment snapshot', async () => {
    const f = await booksFixture(),
      token = f.issued.token;
    const review = await invoke(
      reviewOutput,
      f.company,
      'reviews.request',
      { operation: 'bank.match', input: f.allocation },
      token,
    );
    expect(
      (await http(f.company, 'reviews.approve', { id: review.id, hash: review.hash })).status,
    ).toBe(200);
    const journal = (await service.overview(f.actor)).journals.find(
      (row) => row.kind === 'purchase',
    )!;
    const evidence = await source(f.company, token, 'Corrected invoice has total RON 120.00');
    const correction = await invoke(
      proposalOutput,
      f.company,
      'corrections.propose',
      {
        journalId: journal.id,
        evidenceId: evidence.id,
        date: '2026-10-04',
        reason: 'Documentul stabilește suma corectă de 120 RON',
        action: 'replace',
        method: 'inverse_entry',
        amount: '120.00',
      },
      token,
    );
    expect(
      (
        await http(f.company, 'books.approve', {
          id: correction.id,
          version: correction.version,
          hash: correction.hash,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await http(
          f.company,
          'corrections.post',
          { id: correction.id, version: correction.version, hash: correction.hash },
          { token },
        )
      ).status,
    ).toBe(200);
    const stale = await http(
      f.company,
      'reviews.execute',
      { id: review.id, hash: review.hash },
      { token },
    );
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe('STALE_APPROVAL');
    expect((await service.overview(f.actor)).movements[0].matched).toBe(false);
  });

  test('new accounting work invalidates an approved close and unknown cross-company sources are rejected', async () => {
    const f = await booksFixture(),
      token = f.issued.token;
    expect((await http(f.company, 'bank.match', f.allocation)).status).toBe(200);
    const close = await invoke(
      reviewOutput,
      f.company,
      'reviews.request',
      { operation: 'periods.close', input: { month: '2026-10-01' } },
      token,
    );
    expect(
      (await http(f.company, 'reviews.approve', { id: close.id, hash: close.hash })).status,
    ).toBe(200);
    await purchase(f.company, token, '20.00');
    expect(
      (await http(f.company, 'reviews.execute', { id: close.id, hash: close.hash }, { token }))
        .status,
    ).toBe(422);
    expect((await service.overview(f.actor)).closedPeriods).toHaveLength(0);
    const other = await fixture();
    const evidence = await source(other.company, other.issued.token, 'Other company source');
    const invalid = await http(
      f.company,
      'books.proposeOpening',
      { date: '2026-01-01', amount: '1000.00', evidenceId: evidence.id },
      { token },
    );
    expect(invalid.status).toBe(409); // An existing opening is not overwritten, regardless of supplied evidence.
    const fresh = await fixture();
    expect(
      (
        await http(
          fresh.company,
          'books.proposeOpening',
          { date: '2026-01-01', amount: '1000.00', evidenceId: evidence.id },
          { token: fresh.issued.token },
        )
      ).status,
    ).toBe(404);
  });

  test('revocation blocks cached responses, issuance replay, downloads and queued work', async () => {
    const f = await fixture(),
      token = f.issued.token,
      requestKey = key();
    const uploaded = await source(f.company, token, 'Scoped source');
    const job = await invoke(
      z.object({ id: z.string(), status: z.string() }),
      f.company,
      'exports.request',
      {},
      token,
      requestKey,
    );
    expect((await http(f.company, 'agents.revoke', { id: f.issued.id })).status).toBe(200);
    expect((await http(f.company, 'exports.request', {}, { token, key: requestKey })).status).toBe(
      401,
    );
    await expect(service.exports.request(f.agent, requestKey)).rejects.toMatchObject({
      code: 'AGENT_REVOKED',
    });
    expect(
      (
        await app.app.request(
          `${publicUrl}/api/accounting/v1/companies/${f.company}/evidence/${uploaded.id}`,
          { headers: { authorization: `Bearer ${token}` } },
        )
      ).status,
    ).toBe(401);
    await runOneExport(db, objects);
    const [queued] = await db.orm
      .select()
      .from(jobs)
      .where(and(eq(jobs.companyId, f.company), eq(jobs.id, job.id)));
    expect(queued.status).toBe('failed');
    expect(queued.agentId).toBe(f.issued.id);
  });

  test('expiry and membership downgrade reduce authority immediately', async () => {
    const f = await fixture();
    await db.orm
      .update(agentGrants)
      .set({ expiresAt: Date.now() - 1 })
      .where(eq(agentGrants.id, f.issued.id));
    expect((await http(f.company, 'books.summary', {}, { token: f.issued.token })).status).toBe(
      401,
    );
    await db.orm
      .insert(memberships)
      .values({ companyId: f.company, userId: reviewerId, role: 'reviewer' });
    const response = await http(f.company, 'agents.issue', f.input, { cookie: reviewerCookie });
    expect(response.status).toBe(200);
    const grant = (await response.json()) as { token: string; id: string };
    await db.orm
      .update(memberships)
      .set({ role: 'viewer' })
      .where(and(eq(memberships.companyId, f.company), eq(memberships.userId, reviewerId)));
    expect((await http(f.company, 'books.proposeOpening', {}, { token: grant.token })).status).toBe(
      403,
    );
    expect((await http(f.company, 'books.summary', {}, { token: grant.token })).status).toBe(200);
    await db.orm
      .update(memberships)
      .set({ active: false })
      .where(and(eq(memberships.companyId, f.company), eq(memberships.userId, reviewerId)));
    expect((await http(f.company, 'books.summary', {}, { token: grant.token })).status).toBe(404);
  });

  test('bounded filtered queries retain exact numbers and deterministic pages', async () => {
    const f = await fixture(),
      token = f.issued.token;
    for (const amount of ['90071992547409.93', '20.00', '30.00'])
      await purchase(f.company, token, amount);
    const first = await invoke(
      pageOutput(proposalView),
      f.company,
      'proposals.list',
      { limit: 2, kind: 'purchase', status: 'pending', from: '2026-10-01', to: '2026-10-31' },
      token,
    );
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await invoke(
      pageOutput(proposalView),
      f.company,
      'proposals.list',
      { limit: 2, cursor: first.nextCursor },
      token,
    );
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((row) => row.id)).size).toBe(3);
    expect(
      [...first.items, ...second.items].some((row) => row.body.amount === '90071992547409.93'),
    ).toBe(true);
    expect((await http(f.company, 'proposals.list', { limit: 101 }, { token })).status).toBe(422);
    expect(
      (await http(f.company, 'proposals.list', { from: '2026-11-01', to: '2026-10-01' }, { token }))
        .status,
    ).toBe(422);
  });

  test('issuance is replayable without persisting secrets, and agent command keys are separate from human keys', async () => {
    const f = await fixture(),
      issueKey = key();
    const one = await invoke(
      grantOutput.extend({ token: z.string() }),
      f.company,
      'agents.issue',
      f.input,
      undefined,
      issueKey,
    );
    expect(
      await invoke(
        grantOutput.extend({ token: z.string() }),
        f.company,
        'agents.issue',
        f.input,
        undefined,
        issueKey,
      ),
    ).toEqual(one);
    const retained = JSON.stringify(
      await db.orm.select().from(commands).where(eq(commands.companyId, f.company)),
    );
    const events = JSON.stringify(
      await db.orm.select({ body: audit.body }).from(audit).where(eq(audit.companyId, f.company)),
    );
    expect(retained + events).not.toContain(one.token);
    const commonKey = key();
    const body = {
      filename: 'same.txt',
      mediaType: 'text/plain',
      base64: Buffer.from('Same source').toString('base64'),
    };
    const human = await invoke(
      evidenceOutput,
      f.company,
      'evidence.record',
      body,
      undefined,
      commonKey,
    );
    const agent = await invoke(
      evidenceOutput,
      f.company,
      'evidence.record',
      body,
      f.issued.token,
      commonKey,
    );
    expect(human.id).toBe(agent.id);
    const [event] = await db.orm
      .select()
      .from(audit)
      .where(and(eq(audit.companyId, f.company), eq(audit.action, 'evidence.record')))
      .orderBy(audit.id)
      .offset(1)
      .limit(1);
    expect(event.body).toMatchObject({
      principal: { kind: 'agent', id: f.issued.id, delegatedBy: ownerId },
    });
    await http(f.company, 'agents.revoke', { id: one.id });
    expect((await http(f.company, 'agents.issue', f.input, { key: issueKey })).status).toBe(401);
  });

  test('cookie CSRF protection stays intact; bearer credentials do not fall back to a browser session', async () => {
    const f = await fixture();
    expect((await http(f.company, 'books.summary', {}, { origin: null })).status).toBe(403);
    expect(
      (
        await http(
          f.company,
          'books.summary',
          {},
          { token: f.issued.token, origin: 'https://evil.test' },
        )
      ).status,
    ).toBe(403);
    const response = await app.app.request(
      `${publicUrl}/api/accounting/v1/companies/${f.company}/capabilities`,
      { headers: { cookie, authorization: 'Bearer invalid' } },
    );
    expect(response.status).toBe(401);
    expect(
      (
        await app.app.request(`${publicUrl}/api/accounting/v1/companies`, {
          headers: { authorization: `Bearer ${f.issued.token}` },
        })
      ).status,
    ).toBe(401);
    const spec = await app.app.request(`${publicUrl}/api/accounting/openapi.json`);
    const document = await spec.json();
    expect(
      document.paths['/api/accounting/v1/companies/{companyId}/capabilities/books.proposePurchase']
        .post.responses['200'].content['application/json'].schema.properties.hash,
    ).toBeDefined();
  });

  test('MCP advertises scoped tools from the same contracts and resumes an approved workflow after restart', async () => {
    const f = await fixture(),
      token = f.issued.token;
    let currentApp = app.app;
    async function connect() {
      const transport = new StreamableHTTPClientTransport(
        new URL(`${publicUrl}/api/accounting/v1/companies/${f.company}/mcp`),
        {
          authProvider: { token: async () => token },
          fetch: async (url, init) => {
            const request = new Request(url, init);
            request.headers.set('host', new URL(request.url).host);
            return currentApp.fetch(request);
          },
        },
      );
      const client = new Client(
        { name: 'xfactura-conformance-test', version: '1' },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } },
      );
      await client.connect(transport);
      return client;
    }
    const first = await connect();
    let restarted: Database | undefined;
    let second: Client | undefined;
    try {
      const tools = await first.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).toContain('books.proposePurchase');
      expect(names).not.toContain('books.approve');
      expect(names).not.toContain('bank.match');
      expect(names).not.toContain('agents.issue');
      expect(tools.tools.find((tool) => tool.name === 'books.post')?.outputSchema).toBeDefined();
      const doc = await source(f.company, token, 'MCP approved opening: 1000.00 RON');
      const prepared = await first.callTool({
        name: 'books.proposeOpening',
        arguments: {
          input: { date: '2026-01-01', amount: '1000.00', evidenceId: doc.id },
          idempotencyKey: key(),
        },
      });
      expect(prepared.isError).not.toBe(true);
      const proposal = proposalOutput.parse(prepared.structuredContent);
      const review = { id: proposal.id, version: proposal.version, hash: proposal.hash };
      const blocked = await first.callTool({
        name: 'books.post',
        arguments: { input: review, idempotencyKey: key() },
      });
      expect(blocked.isError).toBe(true);
      expect(JSON.stringify(blocked)).toContain('APPROVAL_REQUIRED');
      expect((await http(f.company, 'books.approve', review)).status).toBe(200);
      await first.close();
      restarted = new Database(db.url);
      await restarted.initialize();
      currentApp = createApp(new Accounting(restarted, objects, secret), {
        publicUrl,
        authSecret: secret,
      }).app;
      second = await connect();
      const commandKey = key();
      const posted = await second.callTool({
        name: 'books.post',
        arguments: { input: review, idempotencyKey: commandKey },
      });
      expect(posted.isError).not.toBe(true);
      const result = postingOutput.parse(posted.structuredContent);
      const retried = await second.callTool({
        name: 'books.post',
        arguments: { input: review, idempotencyKey: commandKey },
      });
      expect(postingOutput.parse(retried.structuredContent)).toEqual(result);
      expect((await service.overview(f.actor)).journals).toHaveLength(1);
      expect((await http(f.company, 'agents.revoke', { id: f.issued.id })).status).toBe(200);
      await expect(second.listTools()).rejects.toBeDefined();
    } finally {
      await first.close();
      await second?.close();
      await restarted?.close();
    }
  });

  test('MCP requires an agent credential and rejects hostile Host and Origin headers', async () => {
    const f = await fixture(['books.summary']);
    const url = `${publicUrl}/api/accounting/v1/companies/${f.company}/mcp`;
    const init = {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      }),
    };
    const cookieOnly = await app.app.request(url, {
      ...init,
      headers: {
        host: 'localhost:3000',
        cookie,
        origin: publicUrl,
        'content-type': 'application/json',
      },
    });
    expect(cookieOnly.status).toBe(401);
    expect(cookieOnly.headers.get('www-authenticate')).toContain('Bearer');
    const hostileHost = await app.app.request(url, {
      ...init,
      headers: {
        host: 'evil.test',
        authorization: `Bearer ${f.issued.token}`,
        'content-type': 'application/json',
      },
    });
    expect(hostileHost.status).toBe(403);
    const hostileOrigin = await app.app.request(url, {
      ...init,
      headers: {
        host: 'localhost:3000',
        origin: 'https://evil.test',
        authorization: `Bearer ${f.issued.token}`,
        'content-type': 'application/json',
      },
    });
    expect(hostileOrigin.status).toBe(403);
  });

  test('database guards retain review snapshots and prevent expanding or reviving credentials', async () => {
    const f = await booksFixture();
    const review = await invoke(
      reviewOutput,
      f.company,
      'reviews.request',
      { operation: 'bank.match', input: f.allocation },
      f.issued.token,
    );
    const scopedReview = and(
      eq(actionReviews.companyId, f.company),
      eq(actionReviews.id, review.id),
    );
    await expect(
      db.orm
        .update(actionReviews)
        .set({ hash: '0'.repeat(64) })
        .where(scopedReview)
        .execute(),
    ).rejects.toThrow();
    await expect(
      db.orm
        .update(actionReviews)
        .set({ effect: { kind: 'bank.match', lines: [] } })
        .where(scopedReview)
        .execute(),
    ).rejects.toThrow();
    await expect(db.orm.delete(actionReviews).where(scopedReview).execute()).rejects.toThrow();
    const grant = eq(agentGrants.id, f.issued.id);
    await expect(
      db.orm
        .update(agentGrants)
        .set({ scopes: ['books.approve'] })
        .where(grant)
        .execute(),
    ).rejects.toThrow();
    await expect(
      db.orm
        .update(agentGrants)
        .set({ expiresAt: f.issued.expiresAt + 1000 })
        .where(grant)
        .execute(),
    ).rejects.toThrow();
    expect((await http(f.company, 'agents.revoke', { id: f.issued.id })).status).toBe(200);
    await expect(
      db.orm.update(agentGrants).set({ revokedAt: null }).where(grant).execute(),
    ).rejects.toThrow();
  });

  test('fresh backup restore retains grants, approved action snapshots and replay results', async () => {
    const f = await booksFixture(),
      token = f.issued.token;
    const review = await invoke(
      reviewOutput,
      f.company,
      'reviews.request',
      { operation: 'bank.match', input: f.allocation },
      token,
    );
    const body = { id: review.id, hash: review.hash };
    expect((await http(f.company, 'reviews.approve', body)).status).toBe(200);
    const name = key();
    await backup(db, objects, join(directory, `backup-${name}`));
    const proof = await restore(
      join(directory, `backup-${name}`),
      join(directory, `restored-${name}`),
    );
    const recovered = new Database(proof.databaseUrl);
    try {
      await migrate(recovered);
      const restored = new Accounting(recovered, new LocalObjectStore(proof.objectDir), secret);
      const actor = await restored.agents.authenticate(token, f.company);
      const commandKey = key();
      const executed = reviewOutput.parse(
        await restored.capabilities.invoke(actor, 'reviews.execute', commandKey, body),
      );
      expect(executed.approvedBy).toBe(ownerId);
      expect(executed.executedAt).not.toBeNull();
      expect(
        await restored.capabilities.invoke(actor, 'reviews.execute', commandKey, body),
      ).toEqual(executed);
      expect(
        (await restored.overview(f.actor)).balances.find((row) => row.account === '5121')?.balance,
      ).toBe('900.00');
      expect((await service.overview(f.actor)).movements[0].matched).toBe(false);
    } finally {
      await recovered.close();
    }
  });

  test('2025 and 2026 MCP clients use identical scoped read contracts', async () => {
    const f = await fixture(['books.summary']);
    for (const mode of ['legacy', { pin: '2026-07-28' }] as const) {
      const client = new Client(
        { name: 'mcp-compatibility-test', version: '1' },
        { versionNegotiation: { mode } },
      );
      const transport = new StreamableHTTPClientTransport(
        new URL(`${publicUrl}/api/accounting/v1/companies/${f.company}/mcp`),
        {
          authProvider: { token: async () => f.issued.token },
          fetch: async (url, init) => {
            const request = new Request(url, init);
            request.headers.set('host', 'localhost:3000');
            return app.app.fetch(request);
          },
        },
      );
      try {
        await client.connect(transport);
        expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
          'books.summary',
          'capabilities.list',
        ]);
        const results = await Promise.all(
          Array.from({ length: 3 }, () =>
            client.callTool({ name: 'books.summary', arguments: { input: {} } }),
          ),
        );
        for (const result of results) {
          expect(result.isError).not.toBe(true);
          expect(result.structuredContent).toMatchObject({
            company: { id: f.company },
            balances: [],
          });
        }
      } finally {
        await client.close();
      }
    }
  });
});
