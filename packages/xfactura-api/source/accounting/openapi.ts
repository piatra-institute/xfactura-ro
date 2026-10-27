import { z } from 'zod';
import type { Capabilities } from './capabilities';
import { capabilityPolicy } from './capability-policy';
import {
  companySchema,
  correctionSchema,
  inviteSchema,
  matchSchema,
  openingSchema,
  purchaseSchema,
  reviewSchema,
  statementSchema,
} from './domain';

const inputs = [
  ['POST', '/companies', companySchema],
  ['POST', '/opening-proposals', openingSchema],
  ['POST', '/purchase-proposals', purchaseSchema],
  ['POST', '/correction-proposals', correctionSchema],
  [
    'PUT',
    '/correction-proposals/:id',
    correctionSchema.safeExtend({ version: z.number().int().positive() }),
  ],
  [
    'PUT',
    '/purchase-proposals/:id',
    purchaseSchema.extend({ version: z.number().int().positive() }),
  ],
  ['POST', '/approve', reviewSchema],
  ['POST', '/post', reviewSchema],
  ['POST', '/withdraw', reviewSchema],
  ['POST', '/statements', statementSchema],
  ['POST', '/matches', matchSchema],
  ['POST', '/invitations', inviteSchema],
  ['POST', '/invitations/accept', z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).strict()],
] as const;

type Route = { path: string; method: string };
const aliases = [
  ['GET', '/capabilities', 'capabilities.list'],
  ['POST', '/evidence', 'evidence.record'],
  ['GET', '/evidence/:evidenceId', 'evidence.read'],
  ['POST', '/opening-proposals', 'books.proposeOpening'],
  ['POST', '/purchase-proposals', 'books.proposePurchase'],
  ['PUT', '/purchase-proposals/:id', 'books.revisePurchase'],
  ['POST', '/proposals/:id/approve', 'books.approve'],
  ['POST', '/proposals/:id/post', 'books.post'],
  ['POST', '/correction-proposals', 'corrections.propose'],
  ['PUT', '/correction-proposals/:id', 'corrections.revise'],
  ['POST', '/correction-proposals/:id/post', 'corrections.post'],
  ['POST', '/correction-proposals/:id/withdraw', 'corrections.withdraw'],
  ['POST', '/statements', 'bank.importStatement'],
  ['POST', '/matches', 'bank.match'],
  ['POST', '/periods/:month/close', 'periods.close'],
  ['POST', '/invitations', 'company.invite'],
  ['POST', '/members/:id/revoke', 'company.revoke'],
  ['POST', '/exports', 'exports.request'],
  ['GET', '/exports/:id', 'exports.download'],
] as const;
export function openApi(routes: Route[], publicUrl: string, capabilities: Capabilities) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    if (!route.path.startsWith('/api/accounting/v1/') || route.method === 'ALL') continue;
    const path = route.path.replace(/:(\w+)/g, '{$1}');
    const mutation = !['GET', 'HEAD'].includes(route.method);
    const alias = aliases.find(
      ([method, suffix]) => method === route.method && route.path.endsWith(suffix),
    );
    const definition = alias ? capabilities.definitions[alias[2]] : undefined;
    const agentAllowed =
      route.path.includes('/:capability') || !!(alias && capabilityPolicy[alias[2]].agent);
    const parameters: unknown[] = [...route.path.matchAll(/:(\w+)/g)].map(([, name]) => ({
      name,
      in: 'path',
      required: true,
      schema:
        name === 'capability'
          ? { type: 'string', enum: Object.keys(capabilities.definitions) }
          : name === 'month'
            ? { type: 'string', pattern: '^\\d{4}-\\d{2}-01$' }
            : { type: 'string', format: 'uuid' },
    }));
    if (mutation) {
      parameters.push({
        name: 'Origin',
        in: 'header',
        required: !agentAllowed,
        description:
          'Required for session-cookie mutations. Any supplied Origin must match the public origin.',
        schema: { type: 'string', const: new URL(publicUrl).origin },
      });
      if (!route.path.endsWith('/invitations/accept'))
        parameters.push({
          name: 'Idempotency-Key',
          in: 'header',
          required: true,
          schema: { type: 'string', pattern: '^[\\w.:-]{8,128}$' },
        });
    }
    const input = inputs.find(
      ([method, suffix]) => route.method === method && route.path.endsWith(suffix),
    );
    const upload = route.path.endsWith('/evidence') && route.method === 'POST';
    paths[path] ??= {};
    paths[path][route.method.toLowerCase()] = {
      operationId: `${route.method.toLowerCase()}_${route.path.replace(/[^\w]/g, '_')}`,
      security: agentAllowed ? [{ session: [] }, { agent: [] }] : [{ session: [] }],
      parameters,
      ...(input
        ? {
            requestBody: {
              required: true,
              content: {
                'application/json': { schema: z.toJSONSchema(input[2], { io: 'input' }) },
              },
            },
          }
        : {}),
      ...(upload
        ? {
            requestBody: {
              required: true,
              content: {
                'multipart/form-data': {
                  schema: {
                    type: 'object',
                    required: ['file'],
                    properties: {
                      file: {
                        type: 'string',
                        format: 'binary',
                        description: 'Original source bytes, at most 10 MiB.',
                      },
                    },
                  },
                },
              },
            },
          }
        : {}),
      responses: {
        '200': {
          description: 'Result of the company-scoped operation.',
          ...(definition && route.method !== 'GET'
            ? {
                content: {
                  'application/json': {
                    schema: z.toJSONSchema(definition.output, { io: 'input' }),
                  },
                },
              }
            : {}),
        },
        '401': { description: 'Authentication required.' },
        '403': { description: 'Origin or action permission rejected.' },
        '404': { description: 'Record unavailable to this actor.' },
        '409': {
          description: 'Conflicting command, stale approval or protected accounting state.',
        },
        '422': { description: 'Invalid input or unsupported treatment.' },
      },
    };
  }
  for (const [id, definition] of Object.entries(capabilities.definitions)) {
    paths[`/api/accounting/v1/companies/{companyId}/capabilities/${id}`] = {
      post: {
        operationId: id.replaceAll('.', '_'),
        description: definition.description,
        security: capabilityPolicy[id as keyof typeof capabilityPolicy].agent
          ? [{ session: [] }, { agent: [] }]
          : [{ session: [] }],
        parameters: [
          {
            name: 'companyId',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: false,
            description: 'Required for mutations; reuse it when retrying the same command.',
            schema: { type: 'string', pattern: '^[\\w.:-]{8,128}$' },
          },
          {
            name: 'Origin',
            in: 'header',
            required: false,
            description:
              'Required for session-cookie authentication. If present with a bearer credential, must match this origin.',
            schema: { type: 'string', const: new URL(publicUrl).origin },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: z.toJSONSchema(definition.input, { io: 'input' }) },
          },
        },
        responses: {
          '200': {
            description: 'Validated capability result.',
            content: {
              'application/json': { schema: z.toJSONSchema(definition.output, { io: 'input' }) },
            },
          },
          '401': { description: 'Authentication required.' },
          '403': { description: 'Permission or agent scope rejected.' },
          '409': { description: 'Stale approval or conflicting command.' },
          '422': { description: 'Invalid input or unsupported treatment.' },
        },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'xFactura accounting API',
      version: '0.2.0',
      description:
        'Humans authenticate through /api/accounting/auth/sign-in/email. Scoped agents use separate expiring bearer credentials. Discover available commands at the company capabilities endpoint. Amounts use decimal strings. Membership and agent authority are rechecked before retries and queued execution.',
    },
    servers: [{ url: publicUrl }],
    paths,
    components: {
      securitySchemes: {
        agent: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'xfa_',
          description:
            'Company-scoped accounting agent credential, distinct from AI-provider keys. Cannot approve actions or manage membership.',
        },
        session: {
          type: 'apiKey',
          in: 'cookie',
          name: `${new URL(publicUrl).protocol === 'https:' ? '__Secure-' : ''}xfactura_accounting.session_token`,
        },
      },
    },
  };
}
