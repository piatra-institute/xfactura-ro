import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// The SDK protocol suite runs in the API package. This proof exercises the actual
// web rewrite, Express mount and Hono endpoint over HTTP, with no browser data entry.
test('accounting REST and MCP work through the public web proxy', async ({ request }, info) => {
  const origin = 'http://localhost:3100';
  const login = await request.post('/api/accounting/auth/sign-in/email', {
    headers: { origin },
    data: {
      email: `agents-${info.project.name}@example.test`,
      password: 'synthetic-browser-password',
    },
  });
  expect(login.status()).toBe(200);
  const created = await request.post('/api/accounting/v1/companies', {
    headers: { origin, 'idempotency-key': randomUUID() },
    data: { name: 'Agent HTTP fixture SRL', cui: '12345678', year: 2026 },
  });
  expect(created.status()).toBe(200);
  const company = (await created.json()).id;
  const base = `/api/accounting/v1/companies/${company}`;
  const issue = await request.post(`${base}/capabilities/agents.issue`, {
    headers: { origin, 'idempotency-key': randomUUID() },
    data: {
      name: 'External accounting agent',
      scopes: ['books.summary'],
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    },
  });
  expect(issue.status(), await issue.text()).toBe(200);
  const grant = await issue.json();
  const headers = {
    authorization: `Bearer ${grant.token}`,
    accept: 'application/json, text/event-stream',
  };
  const list = await request.post(`${base}/mcp`, {
    headers,
    data: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
  });
  expect(list.status(), await list.text()).toBe(200);
  const text = await list.text();
  const body =
    text.startsWith('data:') || text.includes('\ndata:')
      ? JSON.parse(
          text
            .split('\n')
            .find((line) => line.startsWith('data:'))!
            .slice(5),
        )
      : JSON.parse(text);
  expect(body.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
    'books.summary',
    'capabilities.list',
  ]);
  const summary = await request.post(`${base}/capabilities/books.summary`, { headers, data: {} });
  expect(summary.status()).toBe(200);
  expect((await summary.json()).company.id).toBe(company);
  const revoke = await request.post(`${base}/capabilities/agents.revoke`, {
    headers: { origin, 'idempotency-key': randomUUID() },
    data: { id: grant.id },
  });
  expect(revoke.status()).toBe(200);
  expect(
    (
      await request.post(`${base}/mcp`, {
        headers,
        data: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      })
    ).status(),
  ).toBe(401);
});
