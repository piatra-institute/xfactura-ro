import type { ZodType } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import type { Actor, Permission } from './commands';

/** What invoking an operation does, as advertised to agents and in OpenAPI. */
export type OperationEffect = 'read' | 'prepare' | 'execute' | 'authorize' | 'manage';

export interface OperationDefinition<Input, Output> {
  id: string;
  description: string;
  permission: Permission;
  /** Whether an agent grant may name this operation. Approvals and configuration never can. */
  agent: boolean;
  effect: OperationEffect;
  approval: 'none' | 'human' | 'exact-version';
  input: ZodType<Input>;
  output: ZodType<Output>;
  run(actor: Actor, key: string, input: Input): Promise<Output>;
}

/** An operation with its input type erased; `invoke` validates the raw input itself. */
export interface Operation {
  id: string;
  description: string;
  permission: Permission;
  agent: boolean;
  effect: OperationEffect;
  approval: 'none' | 'human' | 'exact-version';
  input: ZodType;
  output: ZodType;
  invoke(actor: Actor, key: string, input: unknown): Promise<unknown>;
}

export function define<Input, Output>(definition: OperationDefinition<Input, Output>): Operation {
  return {
    ...definition,
    invoke: (actor, key, input) => definition.run(actor, key, definition.input.parse(input ?? {})),
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
    const operation = this.operations.get(id);
    requireCondition(operation, 'CAPABILITY_NOT_FOUND', 'Capabilitatea nu este disponibilă.', 404);
    return operation;
  }

  all() {
    return [...this.operations.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  policy = (id: string) => {
    const operation = this.operations.get(id);
    return operation && { agent: operation.agent, permission: operation.permission };
  };
}
