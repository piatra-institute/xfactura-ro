import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { requireCondition } from 'xfactura-core/errors';

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

/**
 * ANAF's DUKIntegrator run as a command (`-v` validates, `-p` validates and writes the PDF),
 * with the declaration packages installed in its `lib` by `bun run validators:fetch`. Its
 * result file holds "ok" or one message per line ("E:" errors, "A:" warnings).
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

  private async invoke(mode: '-v' | '-p', kind: string, xml: Uint8Array) {
    const directory = await mkdtemp(path.join(tmpdir(), 'xfactura-duk-'));
    try {
      const input = path.join(directory, `${kind}.xml`);
      const result = path.join(directory, 'result.txt');
      const output = path.join(directory, `${kind}.pdf`);
      await writeFile(input, xml);
      // The PDF mode takes the attached ZIP as `0` when the declaration has none.
      const args = mode === '-v' ? [result] : [result, '0', '0', output];
      await run(
        'java',
        [
          '-Djava.awt.headless=true',
          '-jar',
          path.join(this.dist, 'DUKIntegrator.jar'),
          mode,
          kind,
          input,
          ...args,
        ],
        {
          timeout: 120_000,
        },
      ).catch(() => undefined);
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
