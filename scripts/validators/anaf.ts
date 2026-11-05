// ANAF's DUKIntegrator, shared by the official declaration tests.
import { test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { $, type Subprocess } from 'bun';

export const duk = path.join(import.meta.dir, '../..', '.validators/anaf/dist');
/** ANAF's SAF-T kit, whose DUKIntegrator alone loads the D406 validators. */
export const saftDuk = path.join(
  import.meta.dir,
  '../..',
  '.validators/anaf-saft/duk_SAFT_an_luna/dist',
);
/** The kit of the D112 validator ANAF published for reporting months 01–06/2026 (J26.0.3). */
export const d112FirstHalfDuk = path.join(
  import.meta.dir,
  '../..',
  '.validators/anaf-d112-0126/dist',
);
const installed = (dist: string) =>
  existsSync(path.join(dist, 'DUKIntegrator.jar')) && Bun.which('java') !== null;
/** Runs when DUKIntegrator and Java are installed, and is skipped (never passed) otherwise. */
export const anaf = installed(duk) ? test : test.skip;
export const anafSaft = installed(saftDuk) ? test : test.skip;
export const anafD112FirstHalf = installed(d112FirstHalfDuk) && installed(duk) ? test : test.skip;

/**
 * The declarations validated in one long-lived JVM per kit (DukServer.java): with it, every
 * official test's documents, sent in order, reversed, shuffled and each three times, got the
 * verdicts of a fresh DUKIntegrator per file. Any other declaration runs a fresh JVM per file,
 * as the CLI does, until `ANAF_DUK=compare bun run test:official` shows the same for it.
 */
const reusable = new Set([
  'D100',
  'D101',
  'D112',
  'D204',
  'D205',
  'D212',
  'D300',
  'D301',
  'D394',
  'D406',
  'S1003',
  'S1005',
  'S1046',
]);
/** `fresh` runs every file in its own JVM; `compare` runs each both ways and fails on a difference. */
const mode = process.env.ANAF_DUK ?? '';

/** DUKIntegrator's verdict per document: "ok", or its errors (E:) and warnings (A:). */
export async function validateAnaf(
  declaration: string,
  documents: Record<string, string>,
  dist = duk,
) {
  const directory = await mkdtemp(path.join(tmpdir(), `xfactura-${declaration.toLowerCase()}-`));
  try {
    const results = await Promise.all(
      Object.entries(documents).map(async ([name, xml]) => {
        const file = path.join(directory, `${name}.xml`);
        await writeFile(file, xml);
        const verdict = (way: 'fresh' | 'server') => {
          const result = path.join(directory, `${name}.${way}.txt`);
          return run(way, dist, ['-v', declaration, file, result]).then(() =>
            existsSync(result) ? readFileSync(result, 'utf8').trim() : '',
          );
        };
        if (mode === 'compare') {
          const [server, fresh] = [await verdict('server'), await verdict('fresh')];
          if (server !== fresh)
            throw new Error(
              `${declaration} ${name}: DUKIntegrator in one JVM gave ${JSON.stringify(server)}, in a fresh one ${JSON.stringify(fresh)}`,
            );
          return [name, fresh] as const;
        }
        return [
          name,
          await verdict(mode !== 'fresh' && reusable.has(declaration) ? 'server' : 'fresh'),
        ] as const;
      }),
    );
    return Object.fromEntries(results);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const servers = new Map<string, DukServer>();

/** Runs one DUKIntegrator command line, in the kit's server or in a JVM of its own. */
async function run(way: 'fresh' | 'server', dist: string, args: string[]) {
  if (way === 'server') {
    const server = servers.get(dist) ?? new DukServer(dist);
    servers.set(dist, server);
    if (await server.run(args)) return;
  }
  await $`java -Djava.awt.headless=true -jar DUKIntegrator.jar ${args}`.cwd(dist).nothrow().quiet();
}

const source = path.join(import.meta.dir, 'DukServer.java');
/** A command not answered in this time is run again in a JVM of its own. */
const timeout = 120_000;
const decoder = new TextDecoder();

/** A JVM running DukServer.java, and what it has written that is not read yet. */
type Jvm = {
  process: Subprocess<'pipe', 'pipe', 'ignore'>;
  output: ReadableStreamDefaultReader<Uint8Array>;
  text: string;
};

/**
 * A kit's long-lived DUKIntegrator, sent one command at a time. A command it does not answer
 * with `done` (the JVM failed, ran out of memory or did not answer in time) is reported as not
 * run, for the caller to run it in a fresh JVM, and the next command starts another JVM.
 */
class DukServer {
  private jvm?: Jvm;
  private answered = false;
  private broken = false;
  private queue = Promise.resolve(true);

  constructor(private readonly dist: string) {}

  /** Whether the command ran as the CLI runs it. */
  run(args: string[]) {
    const done = this.queue.then(() => this.send(args));
    this.queue = done;
    return done;
  }

  private async send(args: string[]) {
    if (this.broken) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = await Promise.race([
      this.ask(args).catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeout);
      }),
    ]);
    clearTimeout(timer);
    if (answer === 'done') return (this.answered = true);
    this.stop();
    // A server that never answered (without a JDK to compile it, say) is not started again.
    if (!this.answered) this.broken = true;
    return false;
  }

  private async ask(args: string[]) {
    const jvm = (this.jvm ??= this.start());
    // Referenced only while it works on a command: idle, it does not keep the tests running.
    jvm.process.ref();
    try {
      jvm.process.stdin.write(`${args.join('\t')}\n`);
      await jvm.process.stdin.flush();
      for (;;) {
        const end = jvm.text.indexOf('\n');
        if (end >= 0) {
          const line = jvm.text.slice(0, end);
          jvm.text = jvm.text.slice(end + 1);
          return line;
        }
        const chunk = await jvm.output.read();
        if (chunk.done) return undefined;
        jvm.text += decoder.decode(chunk.value);
      }
    } finally {
      jvm.process.unref();
    }
  }

  private stop() {
    this.jvm?.process.kill('SIGKILL');
    this.jvm = undefined;
  }

  /** Starts the JVM; it halts when its stdin closes, as this process exits (`bun test` runs no
   * exit handlers). */
  private start(): Jvm {
    const child = Bun.spawn(
      ['java', '-Djava.awt.headless=true', '-cp', 'DUKIntegrator.jar', source],
      { cwd: this.dist, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' },
    );
    return { process: child, output: child.stdout.getReader(), text: '' };
  }
}
