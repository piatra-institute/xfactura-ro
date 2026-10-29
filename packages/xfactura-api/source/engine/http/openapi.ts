import { z } from 'zod';
import type { Operation } from '../kernel/operations';

const errors = {
  '401': { description: 'Authentication required.' },
  '403': { description: 'Permission, origin or agent scope rejected.' },
  '404': { description: 'Record unavailable to this principal.' },
  '409': { description: 'Conflicting command, stale proposal or protected accounting state.' },
  '422': { description: 'Invalid input, or a treatment the engine does not support.' },
};

/** OpenAPI 3.1, generated from the same operation registry as REST and MCP. */
export function openApi(operations: Operation[], publicUrl: string) {
  const origin = new URL(publicUrl).origin;
  const companyId = {
    name: 'companyId',
    in: 'path',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  };
  const paths: Record<string, unknown> = {
    '/api/accounting/v1/companies/{companyId}/capabilities': {
      get: {
        operationId: 'capabilities',
        description: 'Operations available to the current principal, with their contracts.',
        security: [{ session: [] }, { agent: [] }],
        parameters: [companyId],
        responses: { '200': { description: 'Available capabilities.' }, ...errors },
      },
    },
  };
  for (const operation of operations)
    paths[`/api/accounting/v1/companies/{companyId}/capabilities/${operation.id}`] = {
      post: {
        operationId: operation.id.replaceAll('.', '_'),
        description: operation.description,
        'x-xfactura': {
          permission: operation.permission,
          effect: operation.effect,
          approval: operation.approval,
        },
        security: operation.agent ? [{ session: [] }, { agent: [] }] : [{ session: [] }],
        parameters: [
          companyId,
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: operation.effect !== 'read',
            description: 'Reuse the same key, with the same input, to retry a command safely.',
            schema: { type: 'string', pattern: '^[\\w.:-]{8,128}$' },
          },
          {
            name: 'Origin',
            in: 'header',
            required: false,
            description:
              'Required with a session cookie; if present with a bearer credential it must match.',
            schema: { type: 'string', const: origin },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: z.toJSONSchema(operation.input, { io: 'input', unrepresentable: 'any' }),
            },
          },
        },
        responses: {
          '200': {
            description: 'Validated result.',
            content: {
              'application/json': {
                schema: z.toJSONSchema(operation.output, { io: 'output', unrepresentable: 'any' }),
              },
            },
          },
          ...errors,
        },
      },
    };
  return {
    openapi: '3.1.0',
    info: {
      title: 'xFactura accounting API',
      version: '2.0.0',
      description:
        'One command interface for people and agents. Amounts are decimal strings. A proposal is approved by a person for its exact effect hash and re-evaluated against the books when posted.',
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
            'A company-scoped, expiring agent grant. It cannot approve, configure or manage access.',
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
