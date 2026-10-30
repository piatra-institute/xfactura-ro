// ANAF's DUKIntegrator, shared by the official declaration tests.
import { test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { $ } from 'bun';

export const duk = path.join(import.meta.dir, '../..', '.validators/anaf/dist');
/** ANAF's SAF-T kit, whose DUKIntegrator alone loads the D406 validators. */
export const saftDuk = path.join(
  import.meta.dir,
  '../..',
  '.validators/anaf-saft/duk_SAFT_an_luna/dist',
);
const installed = (dist: string) =>
  existsSync(path.join(dist, 'DUKIntegrator.jar')) && Bun.which('java') !== null;
/** Runs when DUKIntegrator and Java are installed, and is skipped (never passed) otherwise. */
export const anaf = installed(duk) ? test : test.skip;
export const anafSaft = installed(saftDuk) ? test : test.skip;

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
        const result = path.join(directory, `${name}.txt`);
        await writeFile(file, xml);
        await $`java -Djava.awt.headless=true -jar DUKIntegrator.jar -v ${declaration} ${file} ${result}`
          .cwd(dist)
          .nothrow()
          .quiet();
        return [name, existsSync(result) ? readFileSync(result, 'utf8').trim() : ''] as const;
      }),
    );
    return Object.fromEntries(results);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
