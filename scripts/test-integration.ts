/**
 * Runs the engine's integration tests in several processes. One `bun test` over every file grows
 * past 2.5 GB, and Bun 1.4.2 segfaults now and then in long runs; separate processes keep each run
 * small, and a part that Bun itself crashes on (a signal, not a failing test) is run again, at most
 * twice. Any extra arguments (for example `-t pattern`) are passed to every part.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'packages/xfactura-api/test/engine';
const parts = Number(process.env.INTEGRATION_PARTS ?? 4);
const files = readdirSync(dir)
  .filter((name) => name.endsWith('.integration.test.ts'))
  .sort()
  .map((name) => join(dir, name));
const size = Math.ceil(files.length / parts);

let failed = false;
for (let start = 0; start < files.length; start += size) {
  const part = files.slice(start, start + size);
  for (let attempt = 1; ; attempt++) {
    const run = Bun.spawnSync(
      ['bun', 'test', '--timeout', '120000', ...process.argv.slice(2), ...part],
      { stdout: 'inherit', stderr: 'inherit' },
    );
    if (run.signalCode && attempt <= 2) {
      console.error(
        `Bun crashed (${run.signalCode}) on part ${start / size + 1}; running it again.`,
      );
      continue;
    }
    if (run.exitCode !== 0) failed = true;
    break;
  }
}
process.exit(failed ? 1 : 0);
