import { z, type ZodType } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import type { DataClass, Toolset } from 'xfactura-core/kernel';
import { discoveryOperations, type Actor, type Permission } from './commands';

export { dataClasses, toolsets, type DataClass, type Toolset } from 'xfactura-core/kernel';

/** What invoking an operation does, as advertised to agents and in OpenAPI. */
export type OperationEffect = 'read' | 'prepare' | 'execute' | 'authorize' | 'manage';

export const risks = ['low', 'medium', 'high', 'critical'] as const;
export type Risk = (typeof risks)[number];

/** What an operation tells agents about itself, beside its permission and approval. */
export interface OperationMetadata {
  /** One line of English for agents; `description` stays the Romanian text for people. */
  summary: string;
  toolset: Toolset;
  /** The company data it reads or writes; empty for public reference data. */
  dataClasses: readonly DataClass[];
  /**
   * True when its effect only adds records that bind nothing final, or can be withdrawn,
   * revised, superseded or revoked. False when it commits something final: a posting, an
   * executed action, an issued number, a transmission to ANAF, a recorded filing or outcome, a
   * decision, a revocation, a disposal. Reads are reversible.
   */
  reversible: boolean;
  /** True when it reaches ANAF or another system outside the engine. */
  externalEffect: boolean;
}

/** Data whose disclosure harms a person or opens access, beyond the books themselves. */
const sensitive: readonly DataClass[] = ['personal', 'payroll', 'credentials'];

/**
 * An operation's risk, derived from what it declares, never set by hand:
 * - `low`: nothing final happens and nothing sensitive is read: reads of the books, reference
 *   data and evidence, and drafts inside the engine (proposals, imports, requests);
 * - `medium`: sensitive data (personal, payroll, credentials) is read or written, or a
 *   reversible request reaches ANAF;
 * - `high`: something final is committed, a person's decision or the company's configuration
 *   is recorded, or credentials are written;
 * - `critical`: something final reaches outside the engine.
 */
export function riskOf(
  operation: Pick<OperationMetadata, 'dataClasses' | 'reversible' | 'externalEffect'> & {
    effect: OperationEffect;
  },
): Risk {
  const touchesSensitive = operation.dataClasses.some((kind) => sensitive.includes(kind));
  if (operation.effect === 'read') return touchesSensitive ? 'medium' : 'low';
  if (!operation.reversible && operation.externalEffect) return 'critical';
  if (
    !operation.reversible ||
    operation.effect !== 'prepare' ||
    operation.dataClasses.includes('credentials')
  )
    return 'high';
  if (operation.externalEffect || touchesSensitive) return 'medium';
  return 'low';
}

/** Every output is a JSON object, as MCP requires; a list is `{ items, next }`. */
type ObjectOutput = Record<string, unknown>;

export interface OperationDefinition<Input, Output extends ObjectOutput> extends OperationMetadata {
  id: string;
  description: string;
  permission: Permission;
  /** Whether an agent grant may name this operation. Approvals and configuration never can. */
  agent: boolean;
  effect: OperationEffect;
  approval: 'none' | 'human' | 'exact-version';
  /** The operation this one is a variant of (a treatment's `.revise` of its `.propose`). */
  variantOf?: string;
  input: ZodType<Input>;
  output: ZodType<Output>;
  run(actor: Actor, key: string, input: Input): Promise<Output>;
}

/** An operation with its input type erased; `invoke` validates the raw input itself. */
export interface Operation extends OperationMetadata {
  id: string;
  description: string;
  permission: Permission;
  agent: boolean;
  effect: OperationEffect;
  approval: 'none' | 'human' | 'exact-version';
  variantOf?: string;
  risk: Risk;
  input: ZodType;
  output: ZodType;
  invoke(actor: Actor, key: string, input: unknown): Promise<unknown>;
}

export function define<Input, Output extends ObjectOutput>(
  definition: OperationDefinition<Input, Output>,
): Operation {
  return {
    ...definition,
    risk: riskOf(definition),
    invoke: (actor, key, input) => definition.run(actor, key, definition.input.parse(input ?? {})),
  };
}

/** A list output: one page of items and the cursor of the next page, null on the last. */
export const page = <T extends ZodType>(item: T) =>
  z.object({ items: z.array(item), next: z.string().nullable() });
/** A whole list as one page. */
export const whole = async <T>(items: Promise<T[]>) => ({ items: await items, next: null });

/** Removes `additionalProperties: false`: an output lists what it guarantees, not all it has. */
function open(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(open);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key, value]) => !(key === 'additionalProperties' && value === false))
      .map(([key, value]) => [key, open(value)]),
  );
}

/**
 * The string formats JSON Schema defines that the common validators check (Ajv's formats, which
 * the MCP SDKs use, among them). Zod adds its own (`base64` for `z.base64()`, `cuid`, `emoji`, …),
 * which those validators warn about or refuse.
 */
const knownFormats = new Set([
  'date-time',
  'date',
  'time',
  'duration',
  'email',
  'hostname',
  'ipv4',
  'ipv6',
  'uri',
  'uri-reference',
  'uri-template',
  'uuid',
  'regex',
  'json-pointer',
  'relative-json-pointer',
]);
/** Keywords whose value is data, never a schema. */
const literals = new Set(['default', 'const', 'enum', 'examples']);
/** Keywords whose value maps names to schemas: every name is a schema's, keywords' or not. */
const schemaMaps = new Set(['properties', 'patternProperties', '$defs', 'definitions']);

/** Removes the formats standard validators do not know; Zod states the same constraint in the
 * `pattern` and, for base64, the `contentEncoding` it emits beside them. */
function standard(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(standard);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(
        ([key, value]) =>
          !(key === 'format' && typeof value === 'string' && !knownFormats.has(value)),
      )
      .map(([key, value]) => [
        key,
        literals.has(key)
          ? value
          : schemaMaps.has(key) && value && typeof value === 'object'
            ? Object.fromEntries(
                Object.entries(value).map(([name, item]) => [name, standard(item)]),
              )
            : standard(value),
      ]),
  );
}

export const inputSchema = (operation: Operation) =>
  standard(z.toJSONSchema(operation.input, { io: 'input', unrepresentable: 'any' })) as Record<
    string,
    unknown
  >;
export const outputSchema = (operation: Operation) =>
  open(
    standard(z.toJSONSchema(operation.output, { io: 'output', unrepresentable: 'any' })),
  ) as Record<string, unknown>;

/** An operation's contract as advertised to callers: metadata and JSON schemas. */
export function describe(operation: Operation) {
  return {
    id: operation.id,
    summary: operation.summary,
    description: operation.description,
    toolset: operation.toolset,
    dataClasses: [...operation.dataClasses],
    permission: operation.permission,
    agent: operation.agent,
    effect: operation.effect,
    approval: operation.approval,
    reversible: operation.reversible,
    externalEffect: operation.externalEffect,
    risk: operation.risk,
    inputSchema: inputSchema(operation),
    outputSchema: outputSchema(operation),
  };
}

/** The single catalogue REST, MCP and OpenAPI are generated from. */
export class OperationRegistry {
  private readonly operations = new Map<string, Operation>();

  add(...operations: Operation[]) {
    for (const operation of operations) {
      if (this.operations.has(operation.id))
        throw new Error(`Duplicate operation ${operation.id}.`);
      this.operations.set(operation.id, operation);
    }
  }

  get(id: string) {
    const operation = this.find(id);
    requireCondition(operation, 'CAPABILITY_NOT_FOUND', 'Capabilitatea nu este disponibilă.', 404);
    return operation;
  }

  find(id: string): Operation | undefined {
    return this.operations.get(id);
  }

  all() {
    return [...this.operations.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** The operations a grant may name: agent-eligible, except discovery, which every grant has. */
  grantable() {
    return this.all().filter(
      (operation) => operation.agent && !discoveryOperations.includes(operation.id),
    );
  }

  policy = (id: string) => {
    const operation = this.operations.get(id);
    return (
      operation && {
        agent: operation.agent,
        permission: operation.permission,
        effect: operation.effect,
        dataClasses: operation.dataClasses,
      }
    );
  };
}
