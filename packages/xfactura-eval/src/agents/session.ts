import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

/** What the harness knows of an operation, from the engine's registry. */
export type OperationInfo = { effect: string; approval: string; agent: boolean };

/** One tool call an agent made, as the harness saw it. */
export type ToolCall = {
  seq: number;
  tool: string;
  /** The operation it ran: the tool, or the `id` given to `capabilities.invoke`. */
  operation: string;
  input: unknown;
  ok: boolean;
  error: { code: string; message: string } | null;
  /** Neither granted to this agent nor a discovery operation every agent has. */
  outsideGrant: boolean;
  /** An operation only a person may perform (approve, decide, answer, submit, configure). */
  humanOnly: boolean;
  /** An approval or decision: `*.approve`, `actions.reject`, `policies.*`. */
  approval: boolean;
  /** Changes something (not a read). */
  mutating: boolean;
};

/** A tool as the MCP server lists it. */
export type ListedTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

/** A tool's result: content blocks, and the structured result when there is one. */
export type ToolResult = {
  isError?: boolean;
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
  structuredContent?: Record<string, unknown>;
};

const discovery = ['capabilities.list', 'capabilities.search', 'capabilities.describe'];
const approvals = /(^|\.)approve$|^actions\.reject$|^policies\.(create|revoke)$/;

/**
 * An agent's MCP connection to the engine, the only surface an agent works through. Every call
 * is logged with what the harness knows about it: whether the grant covers it, whether only a
 * person may perform it.
 */
export class Session {
  readonly calls: ToolCall[] = [];
  private constructor(
    private readonly client: Client,
    readonly tools: ListedTool[],
    readonly instructions: string,
    private readonly granted: ReadonlySet<string>,
    private readonly operations: ReadonlyMap<string, OperationInfo>,
    private readonly afterChange?: () => Promise<void>,
  ) {}

  static async connect(input: {
    url: string;
    token: string;
    fetch: (request: Request) => Promise<Response>;
    granted: ReadonlySet<string>;
    operations: ReadonlyMap<string, OperationInfo>;
    /** Runs after each call that changed something: the engine's worker, between calls. */
    afterChange?: () => Promise<void>;
  }) {
    const transport = new StreamableHTTPClientTransport(new URL(input.url), {
      authProvider: { token: async () => input.token },
      fetch: async (url, init) => {
        const request = new Request(url, init);
        request.headers.set('host', new URL(request.url).host);
        return input.fetch(request);
      },
    });
    const client = new Client({ name: 'xfactura-eval', version: '1' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    return new Session(
      client,
      tools as unknown as ListedTool[],
      client.getInstructions() ?? '',
      input.granted,
      input.operations,
      input.afterChange,
    );
  }

  /** Calls a tool by name with its arguments, as an MCP client does, and logs the call. */
  async call(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    const named = tool === 'capabilities.invoke' && typeof args.id === 'string' ? args.id : tool;
    // A model may call an operation by a tool name it made up (`proposals_approve`): it is
    // classified as the operation it names.
    const operation = this.operations.has(named) ? named : named.replace(/_/g, '.');
    const info = this.operations.get(operation);
    const record: ToolCall = {
      seq: this.calls.length + 1,
      tool,
      operation,
      input: tool === 'capabilities.invoke' ? args.input : (args.input ?? args),
      ok: false,
      error: null,
      outsideGrant: !this.granted.has(operation) && !discovery.includes(operation),
      humanOnly: info ? !info.agent || info.approval === 'human' : false,
      approval: approvals.test(operation),
      mutating: info ? info.effect !== 'read' : false,
    };
    this.calls.push(record);
    let result: ToolResult;
    try {
      result = (await this.client.callTool({ name: tool, arguments: args })) as ToolResult;
    } catch (error) {
      result = {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: { code: 'MCP_ERROR', message: (error as Error).message },
            }),
          },
        ],
      };
    }
    record.ok = !result.isError;
    if (result.isError) record.error = errorOf(result);
    else if (record.mutating) await this.afterChange?.();
    return result;
  }

  async close() {
    await this.client.close();
  }
}

/** The wire error in a failed tool result. */
export function errorOf(result: ToolResult): { code: string; message: string } {
  const text = result.content.find((block) => block.type === 'text');
  try {
    const parsed = JSON.parse(text && 'text' in text ? text.text : '{}') as {
      error?: { code?: string; message?: string };
    };
    return {
      code: parsed.error?.code ?? 'UNKNOWN',
      message: parsed.error?.message ?? (text && 'text' in text ? text.text : ''),
    };
  } catch {
    return { code: 'UNKNOWN', message: text && 'text' in text ? text.text : '' };
  }
}
