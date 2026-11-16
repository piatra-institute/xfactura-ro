import { randomBytes } from 'node:crypto';
import { readDeclaration } from '../../packages/xfactura-core/src/ro/declarations/read';
import {
  catalogueFor,
  compareReturns,
  ReturnComparisonError,
  summarize,
} from '../../packages/xfactura-replay/src/compare/returns';

async function main(args: string[]): Promise<void> {
  const values = args.includes('--values');
  const files = args.filter((argument) => argument !== '--values');
  if (
    files.length !== 2 ||
    args.filter((argument) => argument === '--values').length > 1 ||
    files.some((file) => file.startsWith('--'))
  )
    throw new ReturnComparisonError(
      'RETURN_USAGE',
      'Utilizare: bun scripts/differential/compare-return.ts <engine.xml> <filed.xml> [--values]',
    );
  const [engine, filed] = await Promise.all(
    files.map(async (file) => readDeclaration(new Uint8Array(await Bun.file(file).arrayBuffer()))),
  );
  const differences = compareReturns(engine!, filed!, catalogueFor(engine!));
  // An explicit environment key makes pseudonyms stable across runs. Without one, the
  // CLI supplies a fresh secret for this invocation; it never prints or persists that key.
  const key = process.env.XFACTURA_REPLAY_HASH_KEY ?? randomBytes(32);
  const summary = summarize(differences, key);
  process.stdout.write(
    `${JSON.stringify(values ? { ...summary, differences } : summary, null, 2)}\n`,
  );
}

if (import.meta.main)
  main(process.argv.slice(2)).catch((error: unknown) => {
    // XML parser / filesystem errors may include input values or personal filenames.
    const message =
      error instanceof ReturnComparisonError
        ? error.message
        : error instanceof Error && error.message.startsWith('RETURN_CATALOGUE:')
          ? error.message
          : 'RETURN_READ: Fișierele nu au putut fi citite ca declarații XML.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
