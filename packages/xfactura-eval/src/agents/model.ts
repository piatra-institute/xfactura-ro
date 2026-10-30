import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashOf } from 'xfactura-core/hash';

/*
 * Model requests and their recordings. A request is the Anthropic Messages API body; it is
 * recorded under the SHA-256 of its normalized canonical JSON, so CI replays a conversation
 * without a key or a network, and re-recording is a manual command.
 *
 * Normalization. Two runs of the same world see the same items in the same order (the engine's
 * identifiers are seeded, ../ids.ts), but values that come from the wall clock (timestamps the
 * database writes) differ, and a change to how many identifiers the engine makes shifts every
 * later one.
 * Each identifier, 64-hex hash and ISO timestamp is therefore replaced, in the order it first
 * appears, by a placeholder ⟦n⟧; the recorded response is stored with the same placeholders and
 * filled in with the values of the run that replays it. What the model sees is never changed:
 * normalization only decides which recording answers a request.
 */

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'tool_result';
      tool_use_id: string;
      is_error?: boolean;
      content: ContentBlock[];
    }
  | { type: string; [key: string]: unknown };
export type Message = { role: 'user' | 'assistant'; content: string | ContentBlock[] };
export type MessagesRequest = {
  model: string;
  max_tokens: number;
  system: string;
  tools: { name: string; description?: string; input_schema: Record<string, unknown> }[];
  messages: Message[];
  output_config?: { effort: string };
  cache_control?: { type: 'ephemeral' };
};
export type MessagesResponse = {
  id?: string;
  model?: string;
  content: ContentBlock[];
  stop_reason: string | null;
  usage?: Record<string, unknown>;
};

export interface ModelClient {
  send(request: MessagesRequest): Promise<MessagesResponse>;
}

/** The Messages API over plain fetch. */
export class AnthropicClient implements ModelClient {
  constructor(
    private readonly key: string,
    private readonly baseUrl = 'https://api.anthropic.com',
  ) {}

  async send(request: MessagesRequest): Promise<MessagesResponse> {
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.key,
          'anthropic-version': '2026-10-21',
        },
        body: JSON.stringify(request),
      });
      if (response.ok) return (await response.json()) as MessagesResponse;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= 4)
        throw new Error(
          `Anthropic API ${response.status}: ${(await response.text()).slice(0, 500)}`,
        );
      const after = Number(response.headers.get('retry-after'));
      await Bun.sleep((Number.isFinite(after) && after > 0 ? after : 2 ** attempt) * 1000);
    }
  }
}

/** A request no recording answers: the conversation left the recorded one. */
export class RecordingMissing extends Error {
  constructor(
    readonly hash: string,
    readonly turn: number,
  ) {
    super(`No recording ${hash} for model request ${turn}`);
  }
}

const volatile =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const placeholder = /⟦(\d+)⟧/g;

/**
 * The request with its volatile values replaced, and the values in placeholder order. Objects
 * are walked in key order, and text that is JSON (tool results) is walked as JSON, so the order
 * of first appearance does not depend on how a client serializes.
 */
export function normalize(value: unknown): { value: unknown; values: string[] } {
  const values: string[] = [];
  const index = new Map<string, number>();
  const text = (input: string): string =>
    input.replace(volatile, (match) => {
      if (!index.has(match)) {
        values.push(match);
        index.set(match, values.length);
      }
      return `⟦${index.get(match)}⟧`;
    });
  const walk = (input: unknown): unknown => {
    if (typeof input === 'string') {
      const trimmed = input.trimStart();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          return { json: walk(JSON.parse(input)) };
        } catch {
          // Not JSON after all: plain text.
        }
      }
      return text(input);
    }
    if (Array.isArray(input)) return input.map(walk);
    if (input && typeof input === 'object') {
      const object = input as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(object)
          .sort()
          .map((key) => [key, walk(object[key])]),
      );
    }
    return input;
  };
  return { value: walk(value), values };
}

/** Replaces the known values in a response by their placeholders (others stay as they are). */
export function encode(value: unknown, values: string[]): unknown {
  const index = new Map(values.map((item, at) => [item, at + 1]));
  const walk = (input: unknown): unknown =>
    typeof input === 'string'
      ? input.replace(volatile, (match) => (index.has(match) ? `⟦${index.get(match)}⟧` : match))
      : Array.isArray(input)
        ? input.map(walk)
        : input && typeof input === 'object'
          ? Object.fromEntries(Object.entries(input).map(([key, item]) => [key, walk(item)]))
          : input;
  return walk(value);
}

/** Fills a recorded response's placeholders with this run's values. */
export function decode(value: unknown, values: string[]): unknown {
  const walk = (input: unknown): unknown =>
    typeof input === 'string'
      ? input.replace(placeholder, (match, n: string) => values[Number(n) - 1] ?? match)
      : Array.isArray(input)
        ? input.map(walk)
        : input && typeof input === 'object'
          ? Object.fromEntries(Object.entries(input).map(([key, item]) => [key, walk(item)]))
          : input;
  return walk(value);
}

/** The key a request is recorded under. */
export function requestHash(request: MessagesRequest) {
  return hashOf(normalize(request).value);
}

export type Recording = {
  hash: string;
  model: string;
  /** How many messages the request had: where in the conversation it was. */
  messages: number;
  response: unknown;
};

/** Whether a directory holds any recording. */
export function hasRecordings(directory: string) {
  return existsSync(directory) && readdirSync(directory).some((name) => name.endsWith('.json'));
}

/**
 * Answers requests from recordings. In `replay` a request without a recording fails with
 * RecordingMissing; in `record` it goes to the live client and its response is kept.
 */
export class RecordedClient implements ModelClient {
  readonly stats = { replayed: 0, recorded: 0 };
  private turn = 0;
  private readonly used = new Set<string>();

  constructor(
    private readonly directory: string,
    private readonly mode: 'replay' | 'record',
    private readonly live?: ModelClient,
  ) {}

  async send(request: MessagesRequest): Promise<MessagesResponse> {
    this.turn += 1;
    const { value, values } = normalize(request);
    const hash = hashOf(value);
    const file = join(this.directory, `${hash}.json`);
    this.used.add(`${hash}.json`);
    if (existsSync(file)) {
      const recording = JSON.parse(readFileSync(file, 'utf8')) as Recording;
      this.stats.replayed += 1;
      return decode(recording.response, values) as MessagesResponse;
    }
    if (this.mode === 'replay' || !this.live) throw new RecordingMissing(hash, this.turn);
    const response = await this.live.send(request);
    mkdirSync(this.directory, { recursive: true });
    const recording: Recording = {
      hash,
      model: request.model,
      messages: request.messages.length,
      response: encode(response, values),
    };
    writeFileSync(file, `${JSON.stringify(recording, null, 2)}\n`);
    this.stats.recorded += 1;
    return response;
  }

  /** After a complete recording: drops the recordings this run no longer asked for, so a world
   * or engine change leaves no stale responses behind. Replays keep everything. */
  prune() {
    if (this.mode !== 'record' || !existsSync(this.directory)) return;
    for (const name of readdirSync(this.directory))
      if (name.endsWith('.json') && !this.used.has(name)) rmSync(join(this.directory, name));
  }
}
