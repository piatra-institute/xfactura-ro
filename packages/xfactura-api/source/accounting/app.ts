import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { idSchema, requireCondition } from './domain';
import { createAuth } from './auth';
import { Accounting } from './application';
import type { Actor } from './commands';
import { openApi } from './openapi';
import { hostHeaderValidation } from '@modelcontextprotocol/hono';
import { accountingMcp } from './mcp';
import { accountingError } from './errors';

export function createApp(
  service: Accounting,
  options: { publicUrl: string; authSecret: string; mcpProxyHosts?: string[] },
) {
  const auth = createAuth(service.db, options);
  type Variables = { actor: string; agentId?: string };
  const app = new Hono<{ Variables: Variables }>();
  const prefix = '/api/accounting/v1';
  app.use('*', secureHeaders());
  app.use(
    '*',
    bodyLimit({
      maxSize: 15 * 1024 * 1024,
      onError: (c) =>
        c.json({ error: { code: 'BODY_LIMIT', message: 'Cererea depășește 15 MB.' } }, 413),
    }),
  );
  app.get('/health', (c) => c.json({ status: 'ok', service: 'accounting' }));
  app.all('/api/accounting/auth/*', (c) => auth.handler(c.req.raw));
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
      requireCondition(
        company && /^Bearer xfa_[a-f0-9]{64}$/.test(authorization),
        'UNAUTHENTICATED',
        'Credențială invalidă.',
        401,
      );
      if (c.req.header('origin'))
        requireCondition(
          c.req.header('origin') === new URL(options.publicUrl).origin,
          'ORIGIN',
          'Originea cererii nu este autorizată.',
          403,
        );
      const identity = await service.agents.authenticate(authorization.slice(7), company);
      c.set('actor', identity.actorId);
      c.set('agentId', identity.agentId);
      await next();
      return;
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method))
      requireCondition(
        c.req.header('origin') === new URL(options.publicUrl).origin,
        'ORIGIN',
        'Originea cererii nu este autorizată.',
        403,
      );
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    requireCondition(session, 'UNAUTHENTICATED', 'Autentificați-vă pentru a continua.', 401);
    c.set('actor', session.user.id);
    await next();
  });
  app.get(`${prefix}/session`, async (c) =>
    c.json((await auth.api.getSession({ headers: c.req.raw.headers }))?.user),
  );
  app.get(`${prefix}/companies`, async (c) => c.json(await service.companies.list(c.get('actor'))));
  app.post(`${prefix}/companies`, async (c) =>
    c.json(
      await service.companies.create(
        c.get('actor'),
        c.req.header('Idempotency-Key') ?? '',
        await c.req.json(),
      ),
    ),
  );
  app.post(`${prefix}/invitations/accept`, async (c) => {
    const { token } = await c.req.json();
    return c.json(await service.companies.accept(c.get('actor'), token));
  });
  const base = `${prefix}/companies/:companyId`;
  const actor = (c: Context<{ Variables: Variables }>): Actor => ({
    actorId: c.get('actor'),
    companyId: idSchema.parse(c.req.param('companyId')),
    ...(c.get('agentId') ? { agentId: c.get('agentId') } : {}),
  });
  const key = (c: Context) => c.req.header('Idempotency-Key') ?? '';
  app.all(`${base}/mcp`, async (c) => accountingMcp(service, actor(c), c.req.raw));
  app.get(`${base}/capabilities`, async (c) => c.json(await service.capabilities.list(actor(c))));
  app.post(`${base}/capabilities/:capability`, async (c) =>
    c.json(
      await service.capabilities.invoke(
        actor(c),
        c.req.param('capability'),
        key(c),
        await c.req.json(),
      ),
    ),
  );
  app.get(base, async (c) =>
    c.json(await service.overview(actor(c), c.req.query('financialYearId'))),
  );
  app.post(`${base}/evidence`, async (c) => {
    const body = await c.req.parseBody();
    requireCondition(body.file instanceof File, 'FILE', 'Selectați un document.');
    return c.json(
      await service.capabilities.invoke(actor(c), 'evidence.record', key(c), {
        filename: body.file.name,
        mediaType: body.file.type,
        base64: Buffer.from(await body.file.arrayBuffer()).toString('base64'),
      }),
    );
  });
  app.get(`${base}/evidence/:evidenceId`, async (c) => {
    const { record, bytes } = await service.documents.read(actor(c), c.req.param('evidenceId'));
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(record.filename)}`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
  app.post(`${base}/opening-proposals`, async (c) =>
    c.json(
      await service.capabilities.invoke(
        actor(c),
        'books.proposeOpening',
        key(c),
        await c.req.json(),
      ),
    ),
  );
  app.post(`${base}/purchase-proposals`, async (c) =>
    c.json(
      await service.capabilities.invoke(
        actor(c),
        'books.proposePurchase',
        key(c),
        await c.req.json(),
      ),
    ),
  );
  app.put(`${base}/purchase-proposals/:id`, async (c) => {
    const { version, ...body } = await c.req.json();
    requireCondition(Number.isInteger(version) && version > 0, 'VERSION', 'Versiune invalidă.');
    return c.json(
      await service.capabilities.invoke(actor(c), 'books.revisePurchase', key(c), {
        ...body,
        id: c.req.param('id'),
        version,
      }),
    );
  });
  app.post(`${base}/proposals/:id/approve`, async (c) =>
    c.json(
      await service.capabilities.invoke(actor(c), 'books.approve', key(c), {
        ...(await c.req.json()),
        id: c.req.param('id'),
      }),
    ),
  );
  app.post(`${base}/correction-proposals`, async (c) =>
    c.json(
      await service.capabilities.invoke(
        actor(c),
        'corrections.propose',
        key(c),
        await c.req.json(),
      ),
    ),
  );
  app.put(`${base}/correction-proposals/:id`, async (c) => {
    const { version, ...body } = await c.req.json();
    requireCondition(Number.isInteger(version) && version > 0, 'VERSION', 'Versiune invalidă.');
    return c.json(
      await service.capabilities.invoke(actor(c), 'corrections.revise', key(c), {
        ...body,
        id: c.req.param('id'),
        version,
      }),
    );
  });
  app.post(`${base}/correction-proposals/:id/post`, async (c) =>
    c.json(
      await service.capabilities.invoke(actor(c), 'corrections.post', key(c), {
        ...(await c.req.json()),
        id: c.req.param('id'),
      }),
    ),
  );
  app.post(`${base}/correction-proposals/:id/withdraw`, async (c) =>
    c.json(
      await service.capabilities.invoke(actor(c), 'corrections.withdraw', key(c), {
        ...(await c.req.json()),
        id: c.req.param('id'),
      }),
    ),
  );
  app.post(`${base}/proposals/:id/post`, async (c) =>
    c.json(
      await service.capabilities.invoke(actor(c), 'books.post', key(c), {
        ...(await c.req.json()),
        id: c.req.param('id'),
      }),
    ),
  );
  app.post(`${base}/statements`, async (c) =>
    c.json(
      await service.capabilities.invoke(
        actor(c),
        'bank.importStatement',
        key(c),
        await c.req.json(),
      ),
    ),
  );
  app.post(`${base}/matches`, async (c) =>
    c.json(await service.capabilities.invoke(actor(c), 'bank.match', key(c), await c.req.json())),
  );
  app.post(`${base}/periods/:month/close`, async (c) =>
    c.json(
      await service.capabilities.invoke(actor(c), 'periods.close', key(c), {
        month: c.req.param('month'),
      }),
    ),
  );
  app.post(`${base}/invitations`, async (c) =>
    c.json(
      await service.capabilities.invoke(actor(c), 'company.invite', key(c), await c.req.json()),
    ),
  );
  app.post(`${base}/members/:id/revoke`, async (c) =>
    c.json(
      await service.capabilities.invoke(actor(c), 'company.revoke', key(c), {
        id: c.req.param('id'),
      }),
    ),
  );
  app.post(`${base}/exports`, async (c) =>
    c.json(await service.capabilities.invoke(actor(c), 'exports.request', key(c), {})),
  );
  app.get(`${base}/exports/:id`, async (c) => {
    const { bytes, hash } = await service.exports.download(actor(c), c.req.param('id'));
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
    const failure = accountingError(error);
    if (failure.status === 401 && c.req.path.endsWith('/mcp'))
      c.header('WWW-Authenticate', 'Bearer realm="xfactura-accounting"');
    if (failure.status === 503) c.header('Retry-After', '1');
    return c.json({ error: failure.error }, failure.status as 400);
  });
  app.get('/api/accounting/openapi.json', (c) =>
    c.json(openApi(app.routes, options.publicUrl, service.capabilities)),
  );
  return { app, auth };
}
