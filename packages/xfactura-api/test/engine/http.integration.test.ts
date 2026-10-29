import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Database } from '../../source/engine/db/database';
import { LocalObjectStore } from '../../source/engine/adapters/object-store';
import { Engine } from '../../source/engine/engine';
import { createApp } from '../../source/engine/http/app';
import { createAuth } from '../../source/engine/http/auth';
import type { ProposalView } from '../../source/engine/kernel/views';

const publicUrl = 'http://localhost:3000';
const secret = 'synthetic-http-secret-at-least-32-characters';
let directory: string;
let db: Database;
let engine: Engine;
let app: ReturnType<typeof createApp>['app'];
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
let company: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'xfactura-http-'));
  db = new Database(`file:${directory}/books.db`);
  await db.migrate();
  engine = new Engine(db, new LocalObjectStore(join(directory, 'objects')), secret);
  app = createApp(engine, { publicUrl, authSecret: secret }).app;
  const provisioning = createAuth(db, { publicUrl, authSecret: secret }, true);
  for (const name of ['owner', 'reviewer']) {
    const created = await provisioning.api.signUpEmail({
      body: { email: `${name}@http.test`, password: 'synthetic-http-password', name },
    });
    ids[name] = created.user.id;
    const response = await app.request(`${publicUrl}/api/accounting/auth/sign-in/email`, {
      method: 'POST',
      headers: { origin: publicUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ email: `${name}@http.test`, password: 'synthetic-http-password' }),
    });
    expect(response.status).toBe(200);
    cookies[name] = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
  }
  const created = await call('POST', '/companies', {
    name: 'HTTP SRL',
    cui: '23456789',
    year: 2026,
  });
  company = ((await created.json()) as { id: string }).id;
});
afterAll(async () => {
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

function call(
  method: string,
  path: string,
  body?: unknown,
  options: { cookie?: string | null; token?: string; origin?: string | null; key?: string } = {},
) {
  const headers: Record<string, string> = { 'idempotency-key': options.key ?? randomUUID() };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.cookie !== null && !options.token) headers.cookie = options.cookie ?? cookies.owner!;
  if (options.origin !== null && (options.origin || !options.token))
    headers.origin = options.origin ?? publicUrl;
  return app.request(`${publicUrl}/api/accounting/v1${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const capability = (name: string, body: unknown = {}, options: Parameters<typeof call>[3] = {}) =>
  call('POST', `/companies/${company}/capabilities/${name}`, body, options);
async function ok<T>(response: Response): Promise<T> {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body as T;
}
async function grant(scopes: string[]) {
  return ok<{ id: string; token: string }>(
    await capability('agents.issue', {
      name: 'Agent HTTP',
      scopes,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }),
  );
}
async function upload(text: string) {
  const form = new FormData();
  form.set('file', new File([text], 'nota.txt', { type: 'text/plain' }));
  const response = await app.request(
    `${publicUrl}/api/accounting/v1/companies/${company}/evidence`,
    {
      method: 'POST',
      headers: { cookie: cookies.owner!, origin: publicUrl, 'idempotency-key': randomUUID() },
      body: form,
    },
  );
  return ok<{ id: string; hash: string }>(response);
}

describe('authentication', () => {
  test('requires a session and refuses public registration', async () => {
    expect((await call('GET', '/companies', undefined, { cookie: null })).status).toBe(401);
    const signUp = await app.request(`${publicUrl}/api/accounting/auth/sign-up/email`, {
      method: 'POST',
      headers: { origin: publicUrl, 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'x@http.test',
        password: 'synthetic-http-password',
        name: 'x',
      }),
    });
    expect(signUp.status).not.toBe(200);
  });

  test('cookie mutations must come from the public origin', async () => {
    const missing = await capability(
      'parties.create',
      { kind: 'ro_legal_entity', country: 'RO', name: 'X' },
      { origin: null },
    );
    expect(missing.status).toBe(403);
    const hostile = await capability(
      'parties.create',
      { kind: 'ro_legal_entity', country: 'RO', name: 'X' },
      { origin: 'https://evil.example' },
    );
    expect(hostile.status).toBe(403);
    expect(
      (await capability('parties.create', { kind: 'ro_legal_entity', country: 'RO', name: 'X' }))
        .status,
    ).toBe(200);
  });

  test('a bearer credential is bound to its company and never falls back to the cookie', async () => {
    const agent = await grant(['parties.list']);
    expect((await capability('parties.list', {}, { token: agent.token })).status).toBe(200);
    expect((await capability('evidence.list', {}, { token: agent.token })).status).toBe(403);
    const other = await ok<{ id: string }>(
      await call('POST', '/companies', { name: 'Alta SRL', cui: '34567890', year: 2026 }),
    );
    expect(
      (
        await call(
          'POST',
          `/companies/${other.id}/capabilities/parties.list`,
          {},
          { token: agent.token },
        )
      ).status,
    ).toBe(401);
    const forged = await app.request(
      `${publicUrl}/api/accounting/v1/companies/${company}/capabilities/parties.list`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer xfa_${'0'.repeat(64)}`,
          cookie: cookies.owner!,
          'content-type': 'application/json',
        },
        body: '{}',
      },
    );
    expect(forged.status).toBe(401);
    expect(
      (await capability('parties.list', {}, { token: agent.token, origin: 'https://evil.example' }))
        .status,
    ).toBe(403);
  });
});

describe('evidence', () => {
  test('uploads keep the exact bytes and download with their hash', async () => {
    const stored = await upload('Contract de servicii nr. 7');
    const response = await call('GET', `/companies/${company}/evidence/${stored.id}`);
    expect(response.headers.get('x-content-sha256')).toBe(stored.hash);
    expect(await response.text()).toBe('Contract de servicii nr. 7');
  });
});

describe('MCP', () => {
  async function connect(token: string, host?: string) {
    const transport = new StreamableHTTPClientTransport(
      new URL(`${publicUrl}/api/accounting/v1/companies/${company}/mcp`),
      {
        authProvider: { token: async () => token },
        fetch: async (url, init) => {
          const request = new Request(url, init);
          request.headers.set('host', host ?? new URL(request.url).host);
          return app.fetch(request);
        },
      },
    );
    const client = new Client({ name: 'xfactura-engine-test', version: '1' });
    await client.connect(transport);
    return client;
  }

  test('advertises only granted tools and pauses for human approval', async () => {
    const agent = await grant(['ledger.general.propose', 'ledger.post', 'proposals.get']);
    const client = await connect(agent.token);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
      expect(names).toEqual([
        'capabilities.list',
        'ledger.general.propose',
        'ledger.post',
        'proposals.get',
      ]);
      const { id: evidenceId } = await upload('Factură comision bancar');
      const prepared = await client.callTool({
        name: 'ledger.general.propose',
        arguments: {
          input: {
            date: '2026-03-10',
            purpose: 'general',
            reference: 'COMISION-03',
            description: 'Comision bancar martie',
            evidenceId,
            lines: [
              { account: '627', side: 'D', amount: '15.00' },
              { account: '5121', side: 'C', amount: '15.00' },
            ],
          },
          idempotencyKey: randomUUID(),
        },
      });
      expect(prepared.isError).not.toBe(true);
      const proposal = prepared.structuredContent as unknown as ProposalView;
      const review = {
        proposalId: proposal.id,
        version: proposal.version,
        effectHash: proposal.effectHash,
      };
      const early = await client.callTool({
        name: 'ledger.post',
        arguments: { input: review, idempotencyKey: randomUUID() },
      });
      expect(early.isError).toBe(true);
      expect(JSON.stringify(early)).toContain('APPROVAL_REQUIRED');
      await ok(
        await capability(
          'proposals.approve',
          { ...review, acknowledge: [] },
          { cookie: cookies.owner! },
        ),
      );
      const posted = await client.callTool({
        name: 'ledger.post',
        arguments: { input: review, idempotencyKey: randomUUID() },
      });
      expect((posted.structuredContent as unknown as ProposalView).status).toBe('posted');
    } finally {
      await client.close();
    }
  });

  test('requires an agent credential and an allowed Host', async () => {
    const response = await app.request(`${publicUrl}/api/accounting/v1/companies/${company}/mcp`, {
      method: 'POST',
      headers: {
        host: 'localhost:3000',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
    const agent = await grant(['proposals.get']);
    expect(connect(agent.token, 'attacker.example')).rejects.toBeDefined();
  });
});

describe('OpenAPI', () => {
  test('documents every operation from the same registry', async () => {
    const document = (await (
      await app.request(`${publicUrl}/api/accounting/openapi.json`)
    ).json()) as {
      paths: Record<string, unknown>;
    };
    const documented = Object.keys(document.paths)
      .filter((path) => path.includes('/capabilities/'))
      .map((path) => path.split('/capabilities/')[1]);
    expect(documented.sort()).toEqual(
      engine.operations
        .all()
        .map((operation) => operation.id)
        .sort(),
    );
  });
});
