import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rmdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';
import { applyCauses, type Cause } from './causes';
import {
  classes,
  differenceId,
  fail,
  observationSchema,
  order,
  type Difference,
  type DifferenceClass,
  type Observation,
} from './differences';

const scope = z.string().min(1).max(100);
const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('observed'), scope, observation: observationSchema }).strict(),
  z
    .object({
      type: z.literal('classified'),
      id: z.string(),
      class: z.enum(classes),
      by: z.discriminatedUnion('type', [
        z
          .object({ type: z.literal('person'), id: z.string().min(1), reason: z.string().min(1) })
          .strict(),
        z.object({ type: z.literal('rule'), causeId: z.string().min(1) }).strict(),
        z.object({ type: z.literal('replay'), reason: z.string().min(1).max(100) }).strict(),
      ]),
    })
    .strict(),
  z.object({ type: z.literal('resolved'), scope, id: z.string() }).strict(),
]);
type Event = z.infer<typeof eventSchema>;
export type StoredDifference = Difference & { scope: string };
const errorCode = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error ? error.code : undefined;

function observation(input: Observation): Observation {
  const parsed = observationSchema.safeParse(input);
  if (!parsed.success) fail('STORE_OBSERVATION', 'Structura diferenței nu este validă.');
  const result = parsed.data;
  if (result.id !== differenceId(result.kind, result.period, result.locator))
    fail('STORE_ID', 'Identificatorul diferenței nu corespunde coordonatelor sale.');
  return result;
}

function fold(events: readonly Event[]): Map<string, StoredDifference> {
  const state = new Map<string, StoredDifference>();
  for (const event of events) {
    if (event.type === 'observed') {
      const current = observation(event.observation);
      const previous = state.get(current.id);
      if (previous && previous.scope !== event.scope)
        fail('STORE_SCOPE', 'O diferență aparține deja altei comparații.');
      state.set(current.id, {
        ...current,
        scope: event.scope,
        class: previous?.class ?? 'unclassified',
        status: 'open',
        ...(previous?.causeId ? { causeId: previous.causeId } : {}),
      });
      continue;
    }
    const current = state.get(event.id);
    if (!current) fail('STORE_REFERENCE', 'Evenimentul se referă la o diferență necunoscută.');
    if (event.type === 'resolved') {
      if (current.scope !== event.scope)
        fail('STORE_SCOPE', 'Rezolvarea aparține altei comparații.');
      state.set(event.id, { ...current, status: 'resolved' });
    } else {
      const { causeId: _causeId, ...rest } = current;
      state.set(event.id, {
        ...rest,
        class: event.class,
        ...(event.by.type === 'rule' ? { causeId: event.by.causeId } : {}),
      });
    }
  }
  return state;
}

/** A single-company append-only log. Each complete reconcile call owns one scope: use a
 * distinct scope for balances, journals or a deliberately partial period range. An optional
 * `area` places the company's log one level down, as `.private/<area>/<company>`. */
export class DifferenceStore {
  readonly directory: string;
  readonly path: string;
  private readonly area: string | undefined;
  constructor(privateRoot: string, company: string, area?: string) {
    if (
      basename(resolve(privateRoot)) !== '.private' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(company) ||
      (area !== undefined && !/^[a-z][a-z0-9-]{0,39}$/.test(area))
    )
      fail('STORE_PRIVATE_PATH', 'Diferențele se păstrează numai în .private/<companie>.');
    this.area = area === undefined ? undefined : join(resolve(privateRoot), area);
    this.directory = join(this.area ?? resolve(privateRoot), company);
    this.path = join(this.directory, 'differences.jsonl');
  }

  private async locked<T>(work: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (
      (this.area !== undefined && !(await lstat(this.area)).isDirectory()) ||
      !(await lstat(this.directory)).isDirectory()
    )
      fail('STORE_PRIVATE_PATH', 'Directorul companiei nu poate fi o legătură simbolică.');
    const lock = join(this.directory, '.differences.lock');
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) === 'EEXIST')
        fail('STORE_BUSY', 'Alt proces folosește registrul de diferențe.');
      throw error;
    }
    try {
      return await work();
    } finally {
      await rmdir(lock);
    }
  }

  private async events(): Promise<Event[]> {
    let text: string;
    try {
      if (!(await lstat(this.path)).isFile())
        fail('STORE_FILE', 'Registrul trebuie să fie un fișier obișnuit.');
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    }
    if (text && !text.endsWith('\n'))
      fail('STORE_TRUNCATED', 'Ultimul eveniment este incomplet; registrul necesită verificare.');
    return text
      .split('\n')
      .slice(0, -1)
      .map((line) => {
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          fail('STORE_JSON', 'Un eveniment nu este JSON valid.');
        }
        const parsed = eventSchema.safeParse(value);
        if (!parsed.success) fail('STORE_EVENT', 'Un eveniment nu respectă schema registrului.');
        return parsed.data;
      });
  }

  private async append(events: readonly Event[]) {
    if (!events.length) return;
    const file = await open(
      this.path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(events.map((event) => JSON.stringify(event)).join('\n') + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
  }

  async read(): Promise<StoredDifference[]> {
    return this.locked(async () =>
      [...fold(await this.events()).values()].sort((a, b) => order(a.id, b.id)),
    );
  }

  async classify(
    id: string,
    classification: DifferenceClass,
    person: { id: string; reason: string },
  ): Promise<void> {
    await this.locked(async () => {
      const events = await this.events();
      const parsed = eventSchema.safeParse({
        type: 'classified',
        id,
        class: classification,
        by: { type: 'person', ...person },
      });
      if (!parsed.success)
        fail('STORE_CLASSIFICATION', 'Clasificarea necesită o persoană și o explicație.');
      fold([...events, parsed.data]);
      await this.append([parsed.data]);
    });
  }

  async reconcile(
    comparisonScope: string,
    differences: readonly Difference[],
    causes: readonly Cause[] = [],
  ): Promise<StoredDifference[]> {
    return this.locked(async () => {
      if (!scope.safeParse(comparisonScope).success)
        fail('STORE_SCOPE', 'Comparația necesită un nume.');
      const history = await this.events();
      const state = fold(history);
      const next: Event[] = [];
      const seen = new Set<string>();
      for (const item of differences) {
        const { class: _class, status: _status, causeId: _causeId, ...raw } = item;
        const current = observation(raw);
        if (seen.has(current.id))
          fail('STORE_DUPLICATE', 'Comparația conține aceeași diferență de două ori.');
        seen.add(current.id);
        next.push({ type: 'observed', scope: comparisonScope, observation: current });
      }
      for (const item of state.values())
        if (item.scope === comparisonScope && item.status === 'open' && !seen.has(item.id))
          next.push({ type: 'resolved', scope: comparisonScope, id: item.id });
      const observed = fold([...history, ...next]);
      for (const item of applyCauses(
        [...observed.values()].filter((item) => item.scope === comparisonScope),
        causes,
      )) {
        if (item.causeId && observed.get(item.id)!.class === 'unclassified')
          next.push({
            type: 'classified',
            id: item.id,
            class: item.class,
            by: { type: 'rule', causeId: item.causeId },
          });
        // A cause the replay driver observed classifies only what neither a person nor a
        // repository cause has classified.
        else if (
          !item.causeId &&
          item.status === 'open' &&
          observed.get(item.id)!.class === 'unclassified' &&
          item.context?.cause &&
          seen.has(item.id)
        )
          next.push({
            type: 'classified',
            id: item.id,
            class: item.context.cause.class,
            by: { type: 'replay', reason: item.context.cause.reason },
          });
      }
      const result = fold([...history, ...next]);
      await this.append(next);
      return [...result.values()].sort((a, b) => order(a.id, b.id));
    });
  }
}
