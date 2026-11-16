import { join, resolve } from 'node:path';
import {
  AnafKits,
  DukIntegrator,
  saftKitId,
} from '../../packages/xfactura-api/source/engine/adapters/declaration-validator';
import { defaultRegister } from '../../packages/xfactura-api/source/engine/engine';
import { loadCauses } from '../../packages/xfactura-replay/src/compare/causes';
import { ComparisonError } from '../../packages/xfactura-replay/src/compare/differences';
import { DifferenceStore } from '../../packages/xfactura-replay/src/compare/store';
import { MappingError, readMappingFile } from '../../packages/xfactura-replay/src/mapping';
import {
  readCompanyFilingDocuments,
  readCompanyReturnPayloads,
} from '../../packages/xfactura-replay/src/mapping/corpus';
import { AssumptionError } from '../../packages/xfactura-replay/src/run/assumptions';
import { ReplayError } from '../../packages/xfactura-replay/src/run/driver';
import { openReplayEngine } from '../../packages/xfactura-replay/src/run/engine';
import {
  FiledReturnError,
  readFiledReturns,
  returnForms,
  type ReturnForm,
} from '../../packages/xfactura-replay/src/run/filed-returns';
import {
  emptyDirectory,
  engineSecret,
  privateDirectory,
  readAssumptionsFile,
  writePrivate,
} from '../../packages/xfactura-replay/src/run/private-files';
import { replayReturns } from '../../packages/xfactura-replay/src/run/returns';

type Arguments = {
  alias: string;
  forms?: ReturnForm[];
  from?: string;
  to?: string;
  assumptions?: string;
};

export function parseReturnsArguments(args: string[]): Arguments {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      const next = args[++i];
      if (
        !['--forms', '--from', '--to', '--lab-assumptions'].includes(arg) ||
        !next ||
        next.startsWith('--') ||
        flags.has(arg)
      )
        throw new ReplayError('RETURNS_USAGE');
      flags.set(arg, next);
    } else positional.push(arg);
  }
  const [alias, ...rest] = positional;
  const month = /^\d{4}-(0[1-9]|1[0-2])$/;
  const from = flags.get('--from');
  const to = flags.get('--to');
  const forms = flags.get('--forms')?.split(',');
  if (
    !alias ||
    rest.length ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(alias) ||
    (from !== undefined && !month.test(from)) ||
    (to !== undefined && !month.test(to)) ||
    (from && to && from > to) ||
    (forms &&
      (!forms.length ||
        new Set(forms).size !== forms.length ||
        forms.some((form) => !returnForms.includes(form as ReturnForm))))
  )
    throw new ReplayError('RETURNS_USAGE');
  return {
    alias,
    ...(forms ? { forms: forms as ReturnForm[] } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(flags.has('--lab-assumptions') ? { assumptions: flags.get('--lab-assumptions')! } : {}),
  };
}

export async function runReturnsCli(args: string[]): Promise<number> {
  const options = parseReturnsArguments(args);
  const privateRoot = resolve('.private');
  const mapping = await readMappingFile(`.private/mapping/${options.alias}.json`);
  if (!mapping) throw new ReplayError('MAPPING_MISSING');
  const assumptions = options.assumptions
    ? await readAssumptionsFile(options.assumptions, privateRoot)
    : undefined;
  const filings = await readCompanyFilingDocuments(mapping.company);
  const company = mapping.company.replace(/^RO/i, '');
  const returns = readFiledReturns(
    await readCompanyReturnPayloads(company, ['D300', 'D394', 'S1005']),
    company,
  );
  const directory = await privateDirectory(privateRoot, ['replay', options.alias]);
  const output = await privateDirectory(directory, ['returns']);
  // Each run starts from an empty database; the engine secret is the journal replay's.
  const engine = await emptyDirectory(output, 'engine');
  const secret = await engineSecret(directory);
  const kits = {
    general: resolve('.validators/anaf/dist'),
    saft: resolve('.validators/anaf-saft/duk_SAFT_an_luna/dist'),
  };
  const installed = {
    general: DukIntegrator.available(kits.general) && Bun.which('java') !== null,
    saft: DukIntegrator.available(kits.saft) && Bun.which('java') !== null,
  };
  const validator =
    installed.general || installed.saft
      ? new AnafKits({
          ...(installed.general ? { general: new DukIntegrator(kits.general) } : {}),
          ...(installed.saft ? { saft: new DukIntegrator(kits.saft, saftKitId) } : {}),
        })
      : undefined;
  const result = await replayReturns({
    alias: options.alias,
    filings,
    mapping,
    returns,
    ...(options.forms ? { forms: options.forms } : {}),
    ...(assumptions ? { assumptions } : {}),
    ...(options.from ? { from: options.from } : {}),
    ...(options.to ? { to: options.to } : {}),
    validators: installed,
    open: (clock) =>
      openReplayEngine(engine, {
        secret,
        seed: `replay:${options.alias}`,
        clock,
        register: defaultRegister(),
        ...(validator ? { declarationValidator: validator } : {}),
      }),
    store: new DifferenceStore(privateRoot, options.alias, 'replay'),
    causes: await loadCauses(),
  });
  const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  await writePrivate(join(output, 'summary.json'), text(result.summary));
  await writePrivate(join(output, 'manifest.json'), text(result.manifest));
  // The engine's returns, kept beside the run for a person to inspect.
  const prepared = await emptyDirectory(output, 'prepared');
  for (const item of result.prepared)
    await writePrivate(join(prepared, `${item.form}-${item.period}.xml`), item.xml);
  process.stdout.write(text(result.summary));
  return result.status === 'blocked' ? 2 : 0;
}

if (import.meta.main)
  runReturnsCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      // Engine, parser and validator messages can quote source values: print codes only.
      const known =
        error instanceof ReplayError ||
        error instanceof AssumptionError ||
        error instanceof MappingError ||
        error instanceof ComparisonError ||
        error instanceof FiledReturnError;
      const path = error instanceof AssumptionError && error.path ? ` (${error.path})` : '';
      process.stderr.write(
        `${known ? `${(error as { code: string }).code}${path}` : 'RETURNS_FAILED'}\n`,
      );
      if (process.env.XFACTURA_REPLAY_DEBUG === '1' && error instanceof Error)
        process.stderr.write(`${error.stack}\n`);
      process.exitCode = 1;
    });
