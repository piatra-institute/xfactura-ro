import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { requireCondition } from 'xfactura-core/errors';
import { sha256Hex } from 'xfactura-core/hash';

const run = promisify(execFile);

export type ValidationResult = { ok: boolean; messages: string[] };

/** ANAF's validation of a declaration's XML, and the PDF that is signed and filed. */
export interface DeclarationValidator {
  /** Which validator ran, recorded with each result. */
  readonly id: string;
  validate(kind: string, xml: Uint8Array): Promise<ValidationResult>;
  pdf(kind: string, xml: Uint8Array): Promise<ValidationResult & { pdf?: Uint8Array }>;
  /** The validator that runs a kind, for one that routes kinds to several; undefined when none
   * is installed for it. Without it, this validator runs every kind. */
  for?(kind: string): DeclarationValidator | undefined;
}

/** The declarations only ANAF's SAF-T kit validates: its DUKIntegrator and `dec` library alone
 * load the D406 validators and D212's (J13.0.1 needs `dec.DECTagCtx`, absent from the general
 * kit). */
export const saftKinds: readonly string[] = ['D406', 'D406T', 'D212'];
/** The SAF-T kit pinned as `anaf-saft` in scripts/validators/sources.json. */
export const saftKitId = 'DUKIntegrator 1.4.18.3.3 SAF-T';

/**
 * ANAF's two kits: the SAF-T kit for D406, D406T and D212, the general DUKIntegrator for every
 * other declaration. Each kind runs on its own kit, whose id is recorded with the result.
 */
export class AnafKits implements DeclarationValidator {
  readonly id: string;

  constructor(
    private readonly kits: { general?: DeclarationValidator; saft?: DeclarationValidator },
  ) {
    this.id = [kits.general?.id, kits.saft?.id].filter(Boolean).join(', ');
  }

  for(kind: string) {
    return saftKinds.includes(kind) ? this.kits.saft : this.kits.general;
  }

  validate(kind: string, xml: Uint8Array) {
    return this.kit(kind).validate(kind, xml);
  }

  pdf(kind: string, xml: Uint8Array) {
    return this.kit(kind).pdf(kind, xml);
  }

  private kit(kind: string) {
    const kit = this.for(kind);
    requireCondition(
      kit,
      'VALIDATOR_UNAVAILABLE',
      `Validatorul ANAF pentru ${kind} nu este instalat.`,
      503,
    );
    return kit;
  }
}

/** The config folder of each kit, by the kit's directory. */
const configFolders = new Map<string, Promise<string>>();

/**
 * The config folder DUKIntegrator runs with (`-c`): the kit's own config.properties followed by
 * `maxWaitBeforeExitMillis=0`. DUKIntegrator ends by calling System.exit and halting the JVM
 * `maxWaitBeforeExitMillis` later, 1000 ms when the property is absent (as in both kits), so each
 * call waited about a second after writing its result; with 0 it halts at once. The folder is in
 * the temporary directory, named by its content and its user, so the installation's processes
 * share it; DUKIntegrator writes its logs (emergency.log, emergency.trc) there instead of in the
 * kit, which stays as pinned and may be read-only. It is made on a kit's first call, and again
 * when its file is gone (a cleaning of the temporary directory).
 */
export async function dukConfigFolder(dist: string): Promise<string> {
  const known = configFolders.get(dist);
  const folder = await known?.catch(() => undefined);
  if (folder && existsSync(path.join(folder, 'config.properties'))) return folder;
  if (configFolders.get(dist) === known) {
    const made = makeConfigFolder(dist);
    configFolders.set(dist, made);
    // A failure is not kept: the next call tries again.
    made.catch(() => configFolders.get(dist) === made && configFolders.delete(dist));
  }
  return configFolders.get(dist)!;
}

async function makeConfigFolder(dist: string) {
  const own = path.join(dist, 'config', 'config.properties');
  const kit = existsSync(own) ? await readFile(own, 'utf8') : '';
  const properties = `${kit}\nmaxWaitBeforeExitMillis=0\n`;
  const user = process.getuid?.();
  const name = sha256Hex(`${user ?? ''}\n${properties}`).slice(0, 16);
  let folder = path.join(tmpdir(), `xfactura-duk-config-${name}`);
  await mkdir(folder, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  // A folder of another user, a link, or one others may write to is not used: a private one is.
  const info = await lstat(folder);
  if (!info.isDirectory() || (user !== undefined && info.uid !== user) || info.mode & 0o077)
    folder = await mkdtemp(path.join(tmpdir(), 'xfactura-duk-config-'));
  // Written whole and renamed, so a JVM starting meanwhile reads one file or the other.
  const file = path.join(folder, 'config.properties');
  const written = `${file}.${randomUUID()}`;
  await writeFile(written, properties, { mode: 0o600 });
  await rename(written, file);
  return folder;
}

/**
 * ANAF's DUKIntegrator run as a command (`-v` validates, `-p` validates and writes the PDF),
 * with the declaration packages installed in its `lib` by `bun run validators:fetch` and the
 * config folder of `dukConfigFolder`. Its result file holds "ok" or one message per line ("E:"
 * errors, "A:" warnings).
 */
export class DukIntegrator implements DeclarationValidator {
  constructor(
    private readonly dist: string,
    readonly id = 'DUKIntegrator 1.4.17.3.3',
  ) {}

  static available(dist: string) {
    return existsSync(path.join(dist, 'DUKIntegrator.jar'));
  }

  validate(kind: string, xml: Uint8Array) {
    return this.invoke('-v', kind, xml);
  }

  pdf(kind: string, xml: Uint8Array) {
    return this.invoke('-p', kind, xml);
  }

  /** The java arguments of a call. DUKIntegrator reads `-c` only as its first argument. */
  static command(
    dist: string,
    config: string,
    mode: '-v' | '-p',
    kind: string,
    files: { input: string; result: string; output: string },
  ) {
    // The PDF mode takes the attached ZIP as `0` when the declaration has none.
    const rest = mode === '-v' ? [files.result] : [files.result, '0', '0', files.output];
    return [
      '-Djava.awt.headless=true',
      '-jar',
      path.join(dist, 'DUKIntegrator.jar'),
      '-c',
      config,
      mode,
      kind,
      files.input,
      ...rest,
    ];
  }

  private async invoke(mode: '-v' | '-p', kind: string, xml: Uint8Array) {
    const config = await dukConfigFolder(this.dist);
    const directory = await mkdtemp(path.join(tmpdir(), 'xfactura-duk-'));
    try {
      const input = path.join(directory, `${kind}.xml`);
      const result = path.join(directory, 'result.txt');
      const output = path.join(directory, `${kind}.pdf`);
      await writeFile(input, xml);
      const args = DukIntegrator.command(this.dist, config, mode, kind, { input, result, output });
      await run('java', args, { timeout: 120_000 }).catch(() => undefined);
      const text = existsSync(result) ? await readFile(result, 'utf8') : '';
      const messages = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const ok = messages.length > 0 && messages.every((line) => line.toLowerCase() === 'ok');
      return {
        ok,
        messages: ok
          ? []
          : messages.length
            ? messages
            : ['Validatorul ANAF nu a produs un rezultat.'],
        ...(mode === '-p' && ok && existsSync(output)
          ? { pdf: new Uint8Array(await readFile(output)) }
          : {}),
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
