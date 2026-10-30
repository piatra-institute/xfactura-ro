import { join, relative } from 'node:path';
import type { World } from '../world/schema';
import type { Agent, AgentFactory, Mode, Outcome, Turn } from './agent';
import {
  AnthropicClient,
  hasRecordings,
  RecordedClient,
  RecordingMissing,
  type ContentBlock,
  type Message,
  type MessagesRequest,
  type ModelClient,
} from './model';
import type { Session, ToolResult } from './session';

/*
 * The LLM agent: a model drives the engine through the MCP tools, as an external MCP client
 * would. The harness passes the server's tools and instructions through unchanged and adds only
 * the task; the model decides every call.
 */

export type LlmOptions = {
  model: string;
  effort: string;
  /** Model requests per round before the harness stops the agent. */
  maxTurns: number;
  /** Characters of a tool's text result passed to the model. */
  maxResultCharacters: number;
};

/** Tool names the Messages API accepts (`[a-zA-Z0-9_-]{1,64}`), and back. */
export function toolNames(tools: { name: string }[]) {
  const forward = new Map<string, string>();
  const back = new Map<string, string>();
  for (const tool of tools) {
    const name = tool.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    if (back.has(name)) throw new Error(`Two tools map to ${name}`);
    forward.set(tool.name, name);
    back.set(name, tool.name);
  }
  return { forward, back };
}

const harness = [
  '',
  'Harness',
  '- You are being evaluated on a synthetic company; every file and party is fictional.',
  '- People answer questions and approve proposals between your turns. When everything you can do now is done, or waits on a person, end your turn with a short summary of what waits on whom. Do not ask the user anything in text: questions to people go through questions.ask.',
].join('\n');

/** A JSON Schema without its nested `$schema` dialect markers, which tool schemas do not need. */
function withoutDialect(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withoutDialect);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => key !== '$schema')
      .map(([key, value]) => [key, withoutDialect(value)]),
  );
}

function resultBlocks(result: ToolResult, limit: number): ContentBlock[] {
  return result.content.map((block) => {
    if (block.type === 'image')
      return {
        type: 'image',
        source: { type: 'base64', media_type: block.mimeType, data: block.data },
      };
    const text =
      block.text.length > limit
        ? `${block.text.slice(0, limit)}\n[truncated: ${block.text.length - limit} more characters; ask for less, e.g. a page or a filter]`
        : block.text;
    return { type: 'text', text };
  });
}

export class LlmAgent implements Agent {
  private messages: Message[] = [];

  constructor(
    private readonly client: ModelClient,
    private readonly options: LlmOptions,
  ) {}

  async finish() {
    if (this.client instanceof RecordedClient) this.client.prune();
  }

  async run(session: Session, turn: Turn): Promise<Outcome> {
    if (turn.fresh) this.messages = [];
    this.messages.push({ role: 'user', content: turn.message });
    const names = toolNames(session.tools);
    const tools = session.tools.map((tool) => ({
      name: names.forward.get(tool.name)!,
      description: tool.description ?? tool.name,
      input_schema: withoutDialect(tool.inputSchema) as Record<string, unknown>,
    }));
    for (let request = 0; request < this.options.maxTurns; request++) {
      const body: MessagesRequest = {
        model: this.options.model,
        max_tokens: 16000,
        system: `${session.instructions}\n${harness}`,
        tools,
        messages: [...this.messages],
        output_config: { effort: this.options.effort },
        // The tools, instructions and earlier turns repeat on every request: cache them.
        cache_control: { type: 'ephemeral' },
      };
      let response;
      try {
        response = await this.client.send(body);
      } catch (error) {
        if (error instanceof RecordingMissing)
          return {
            status: 'skipped',
            reason: `no recording for model request ${error.turn} (${error.hash.slice(0, 12)}): the conversation left the recorded one (engine, world, tools or prompt changed); re-record with bun run eval:record`,
          };
        throw error;
      }
      this.messages.push({ role: 'assistant', content: response.content });
      if (response.stop_reason !== 'tool_use')
        return {
          status: 'done',
          ...(response.stop_reason === 'end_turn' ? {} : { note: `stop: ${response.stop_reason}` }),
        };
      const results: ContentBlock[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        const use = block as { id: string; name: string; input: Record<string, unknown> };
        const result = await session.call(names.back.get(use.name) ?? use.name, use.input ?? {});
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          ...(result.isError ? { is_error: true } : {}),
          content: resultBlocks(result, this.options.maxResultCharacters),
        });
      }
      this.messages.push({ role: 'user', content: results });
    }
    return { status: 'done', note: `stopped after ${this.options.maxTurns} model requests` };
  }
}

export type LlmMode = 'replay' | 'record' | 'off';

/** The recordings of one world and mode. */
export const recordingsOf = (root: string, world: World, mode: Mode) => join(root, world.id, mode);

/**
 * The LLM agent's factory. `replay` (CI) answers only from recordings; `record` calls the live
 * API with `EVAL_ANTHROPIC_API_KEY` and keeps each response. A run without recordings, or
 * recording without a key, is skipped, never passed.
 */
export function llm(input: {
  mode: LlmMode;
  recordings: string;
  options: LlmOptions;
  key?: string;
  baseUrl?: string;
  /** A client to use instead of the live API (tests). */
  live?: ModelClient;
}): AgentFactory {
  return {
    name: 'llm',
    async prepare(world, mode) {
      if (input.mode === 'off') return { skipped: 'the llm agent is off (EVAL_LLM=off)' };
      const directory = recordingsOf(input.recordings, world, mode);
      if (input.mode === 'replay') {
        if (!hasRecordings(directory))
          return {
            skipped: `no recordings in ${relative(process.cwd(), directory)}${input.key ? '' : ' and no EVAL_ANTHROPIC_API_KEY'}; record with bun run eval:record`,
          };
        return { agent: new LlmAgent(new RecordedClient(directory, 'replay'), input.options) };
      }
      const live = input.live ?? (input.key ? new AnthropicClient(input.key, input.baseUrl) : null);
      if (!live) return { skipped: 'recording needs EVAL_ANTHROPIC_API_KEY' };
      return {
        agent: new LlmAgent(new RecordedClient(directory, 'record', live), input.options),
      };
    },
  };
}
