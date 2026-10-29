import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { hostHeaderValidation } from '@modelcontextprotocol/hono';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import type { Engine } from '../engine';
import { idSchema, type Actor } from '../kernel/commands';
import { wireError } from '../kernel/errors';
import { companyInput } from '../modules/company';
import { createAuth } from './auth';
import { engineMcp } from './mcp';
import { openApi } from './openapi';

type Variables = { actor: string; agentId?: string };
const prefix = '/api/accounting/v1';
const bearer = /^Bearer (xfa_[a-f0-9]{64})$/;

export function createApp(
  engine: Engine,
  options: { publicUrl: string; authSecret: string; mcpProxyHosts?: string[] },
) {
  const auth = createAuth(engine.db, options);
  const origin = new URL(options.publicUrl).origin;
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', secureHeaders());
  app.use(
    '*',
    bodyLimit({
      maxSize: 70 * 1024 * 1024,
      onError: (c) =>
        c.json(
          { error: { code: 'BODY_LIMIT', message: 'Cererea depășește limita permisă.' } },
          413,
        ),
    }),
  );
  app.get('/health', (c) => c.json({ status: 'ok', service: 'accounting' }));
  app.all('/api/accounting/auth/*', (c) => auth.handler(c.req.raw));
  app.get('/api/accounting/openapi.json', (c) =>
    c.json(openApi(engine.operations.all(), options.publicUrl)),
  );

  const publicHost = new URL(options.publicUrl).hostname;
  const localHosts = ['localhost', '127.0.0.1', '[::1]'];
  app.use(
    `${prefix}/companies/:companyId/mcp`,
    hostHeaderValidation([
      publicHost,
      ...(localHosts.includes(publicHost) ? localHosts : []),
      ...(options.mcpProxyHosts ?? []),
    ]),
  );

  // A bearer credential authenticates an agent for one company and never falls back to a
  // session cookie. A session-cookie mutation must come from the public origin.
  app.use(`${prefix}/*`, async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const authorization = c.req.header('authorization');
    if (c.req.path.endsWith('/mcp') && !authorization) {
      c.header('WWW-Authenticate', 'Bearer realm="xfactura-accounting"');
      requireCondition(
        false,
        'UNAUTHENTICATED',
        'Folosiți o credențială de agent pentru MCP.',
        401,
      );
    }
    if (authorization) {
      const company = c.req.path.match(/^\/api\/accounting\/v1\/companies\/([^/]+)(?:\/|$)/)?.[1];
      const token = bearer.exec(authorization)?.[1];
      requireCondition(company && token, 'UNAUTHENTICATED', 'Credențială invalidă.', 401);
      if (c.req.header('origin'))
        requireCondition(
          c.req.header('origin') === origin,
          'ORIGIN',
          'Originea cererii nu este autorizată.',
          403,
        );
      const identity = await engine.agents.authenticate(token, company);
      c.set('actor', identity.actorId);
      c.set('agentId', identity.agentId);
      return next();
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method))
      requireCondition(
        c.req.header('origin') === origin,
        'ORIGIN',
        'Originea cererii nu este autorizată.',
        403,
      );
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    requireCondition(session, 'UNAUTHENTICATED', 'Autentificați-vă pentru a continua.', 401);
    c.set('actor', session.user.id);
    return next();
  });

  const actor = (c: Context<{ Variables: Variables }>): Actor => ({
    actorId: c.get('actor'),
    companyId: idSchema.parse(c.req.param('companyId')),
    ...(c.get('agentId') ? { agentId: c.get('agentId') } : {}),
  });
  const key = (c: Context) => c.req.header('Idempotency-Key') ?? '';
  const humanOnly = (c: Context<{ Variables: Variables }>) =>
    requireCondition(!c.get('agentId'), 'AGENT_SCOPE', 'Operațiunea aparține unei persoane.', 403);

  app.get(`${prefix}/session`, async (c) => {
    humanOnly(c);
    return c.json((await auth.api.getSession({ headers: c.req.raw.headers }))?.user ?? null);
  });
  app.get(`${prefix}/companies`, async (c) => {
    humanOnly(c);
    return c.json(await engine.companies.list(c.get('actor')));
  });
  app.post(`${prefix}/companies`, async (c) => {
    humanOnly(c);
    return c.json(
      await engine.companies.create(c.get('actor'), key(c), companyInput.parse(await c.req.json())),
    );
  });
  app.post(`${prefix}/invitations/accept`, async (c) => {
    humanOnly(c);
    const { token } = z
      .object({ token: z.string() })
      .strict()
      .parse(await c.req.json());
    return c.json(await engine.companies.accept(c.get('actor'), token));
  });

  const base = `${prefix}/companies/:companyId`;
  app.all(`${base}/mcp`, (c) => engineMcp(engine, actor(c), c.req.raw));
  app.get(`${base}/capabilities`, async (c) => c.json(await engine.capabilities(actor(c))));
  app.post(`${base}/capabilities/:capability`, async (c) =>
    c.json(await engine.invoke(actor(c), c.req.param('capability'), key(c), await c.req.json())),
  );
  app.post(`${base}/evidence`, async (c) => {
    const body = await c.req.parseBody();
    requireCondition(body.file instanceof File, 'FILE', 'Selectați un document.');
    return c.json(
      await engine.invoke(actor(c), 'evidence.record', key(c), {
        filename: body.file.name,
        mediaType: body.file.type || 'application/octet-stream',
        base64: Buffer.from(await body.file.arrayBuffer()).toString('base64'),
      }),
    );
  });
  app.get(`${base}/evidence/:evidenceId`, async (c) => {
    const { record, bytes } = await engine.evidence.read(actor(c), c.req.param('evidenceId'));
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(record.filename)}`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Content-SHA256': record.hash,
      },
    });
  });

  app.get(`${base}/exports/:exportId`, async (c) => {
    const { bytes, hash } = await engine.exports.download(
      actor(c),
      idSchema.parse(c.req.param('exportId')),
    );
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="xfactura-${c.req.param('companyId')}.json"`,
        'Cache-Control': 'no-store',
        'X-Content-SHA256': hash,
      },
    });
  });

  app.onError((error, c) => {
    const failure = wireError(error);
    if (failure.status === 401 && c.req.path.endsWith('/mcp'))
      c.header('WWW-Authenticate', 'Bearer realm="xfactura-accounting"');
    if (failure.status === 503) c.header('Retry-After', '1');
    return c.json({ error: failure.error }, failure.status as 400);
  });
  return { app, auth };
}
