import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DomainError } from '../../packages/xfactura-core/src/errors';
import { readDeclaration } from '../../packages/xfactura-core/src/ro/declarations/read';
import {
  readD112Employees,
  type D112Employees,
} from '../../packages/xfactura-replay/src/read/d112';
import { pathCounts, type PathCount } from '../../packages/xfactura-replay/src/read/person-key';
import { readRevisal, type RevisalExport } from '../../packages/xfactura-replay/src/read/revisal';

async function statOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

const within = (parent: string, path: string) => {
  const part = relative(parent, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
};

/** A .private symlink may locate the private workspace; links below it cannot redirect writes. */
async function privateOutput(path: string): Promise<string> {
  const absolute = resolve(path);
  const parts = absolute.split(sep);
  const anchorIndex = parts.lastIndexOf('.private');
  if (anchorIndex < 0 || anchorIndex === parts.length - 1)
    throw new Error('PAYROLL_OUTPUT_PRIVATE');
  const anchor = await realpath(parts.slice(0, anchorIndex + 1).join(sep));
  if (basename(anchor) !== '.private') throw new Error('PAYROLL_OUTPUT_PRIVATE');
  let current = anchor;
  for (const part of parts.slice(anchorIndex + 1)) {
    current = join(current, part);
    const stat = await statOrNull(current);
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory()))
      throw new Error('PAYROLL_OUTPUT_PATH');
  }
  return current;
}

async function canonicalFuturePath(path: string): Promise<string> {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  if (parent === absolute) return realpath(absolute);
  if (await statOrNull(parent)) return join(await realpath(parent), basename(absolute));
  return join(await canonicalFuturePath(parent), basename(absolute));
}

async function safeLeaf(path: string): Promise<void> {
  const stat = await statOrNull(path);
  if (stat && (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1))
    throw new Error('PAYROLL_UNSAFE_FILE');
}

interface PayrollManifestRecord {
  path: string;
  size: number;
  sha256: string;
  kind: string;
  excluded: string[];
  returns: {
    form: string;
    version: string;
    period: { year: string | null; month: string | null };
    attachment: string | null;
  }[];
}

async function inputBytes(root: string, record: PayrollManifestRecord) {
  if (
    !record.path ||
    isAbsolute(record.path) ||
    /[\\:\p{Cc}\p{Cf}]/u.test(record.path) ||
    record.path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('PAYROLL_CORPUS_PATH');
  let current = root;
  const parts = record.path.split('/');
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    const stat = await lstat(current);
    if (
      stat.isSymbolicLink() ||
      (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())
    )
      throw new Error('PAYROLL_CORPUS_PATH');
  }
  const file = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (stat.size > 10 * 1024 * 1024 + 10240 || stat.size !== record.size)
      throw new Error('PAYROLL_CORPUS_SIZE');
    // One extra byte detects growth without allowing an unbounded read after the size check.
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await file.read(buffer, size, buffer.length - size, null);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    if (size !== record.size) throw new Error('PAYROLL_CORPUS_SIZE');
    const bytes = buffer.subarray(0, size);
    if (createHash('sha256').update(bytes).digest('hex') !== record.sha256)
      throw new Error('PAYROLL_CORPUS_HASH');
    return bytes;
  } finally {
    await file.close();
  }
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const nullableString = (value: unknown) => value === null || typeof value === 'string';

function manifestRecords(input: unknown): PayrollManifestRecord[] {
  if (!Array.isArray(input)) throw new Error('PAYROLL_MANIFEST');
  const items: unknown[] = input;
  for (const item of items) {
    if (
      !object(item) ||
      typeof item.path !== 'string' ||
      typeof item.kind !== 'string' ||
      typeof item.size !== 'number' ||
      !Number.isSafeInteger(item.size) ||
      item.size < 0 ||
      typeof item.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      !Array.isArray(item.excluded) ||
      !Array.isArray(item.returns) ||
      item.excluded.some(
        (reason: unknown) => reason !== 'duplicate' && reason !== 'validator-kit',
      ) ||
      item.returns.some((entry: unknown) => {
        return (
          !object(entry) ||
          typeof entry.form !== 'string' ||
          typeof entry.version !== 'string' ||
          !object(entry.period) ||
          !nullableString(entry.period.year) ||
          !nullableString(entry.period.month) ||
          !nullableString(entry.attachment)
        );
      })
    )
      throw new Error('PAYROLL_MANIFEST');
  }
  return items as PayrollManifestRecord[];
}

function mergeCounts(groups: PathCount[][]): PathCount[] {
  const counts = new Map<string, number>();
  for (const group of groups)
    for (const { path, count } of group) counts.set(path, (counts.get(path) ?? 0) + count);
  return pathCounts(counts);
}

export function payrollSummary(registers: RevisalExport[], returns: D112Employees[]) {
  const contracts = registers.flatMap((register) => register.contracts);
  const registerPeople = new Set(contracts.map((contract) => contract.personKey));
  const returnPeople = new Set(
    returns.flatMap((item) => item.employees.map((person) => person.personKey)),
  );
  const matchCounts = (people: Set<string>) => ({
    withContract: [...people].filter((person) => registerPeople.has(person)).length,
    withoutContract: [...people].filter((person) => !registerPeople.has(person)).length,
  });
  return {
    exportsRead: registers.length,
    exports: registers.map((register) => ({
      date: register.exportDate,
      dateSource: register.exportDateSource,
      contracts: register.contracts.length,
      active: register.contracts.filter((contract) => contract.state.kind === 'active').length,
      ended: register.contracts.filter((contract) => contract.state.kind === 'ended').length,
    })),
    // Counts are observations across exports, not deduplicated employment histories.
    contracts: {
      total: contracts.length,
      active: contracts.filter((contract) => contract.state.kind === 'active').length,
      ended: contracts.filter((contract) => contract.state.kind === 'ended').length,
      suspended: contracts.filter((contract) => contract.state.kind === 'suspended').length,
      unknown: contracts.filter((contract) => contract.state.kind === 'unknown').length,
    },
    d112ReturnsRead: returns.length,
    d112: returns
      .map((item) => {
        if (!item.period?.month) throw new Error('D112_MONTH_REQUIRED');
        if (item.period.year !== '2026' || !/^(?:0?[1-9]|1[0-2])$/.test(item.period.month))
          throw new Error('PAYROLL_D112_PERIOD');
        return {
          month: `${item.period.year}-${item.period.month.padStart(2, '0')}`,
          insuredPersons: item.employees.length,
          ...matchCounts(new Set(item.employees.map((person) => person.personKey))),
        };
      })
      .sort((a, b) => a.month.localeCompare(b.month)),
    distinctReturnPersons: { total: returnPeople.size, ...matchCounts(returnPeople) },
    unread: mergeCounts(registers.map((register) => register.unread)),
    unmappedD112Fields: mergeCounts(returns.map((item) => item.unmappedFields)),
    d112FieldsOutsideMappingTable: mergeCounts(
      returns.map((item) => item.fieldsOutsideMappingTable),
    ),
    d112NumericFieldsWithoutNeutralName: mergeCounts(
      returns.map((item) => item.numericFieldsWithoutNeutralName),
    ),
    unplacedD112Sections: mergeCounts(returns.map((item) => item.unplacedSections)),
  };
}

/** Preflight and parse the whole selection before creating even a key or an output directory. */
export async function exportPayrollSources(corpus: string, output: string, keyFile: string) {
  const source = await realpath(corpus);
  const target = await privateOutput(output);
  if (within(source, target) || within(target, source)) throw new Error('PAYROLL_OUTPUT_OVERLAP');
  const secretPath = await canonicalFuturePath(keyFile);
  if (within(source, secretPath)) throw new Error('PAYROLL_KEY_IN_CORPUS');
  if (within(target, secretPath) || within(secretPath, target))
    throw new Error('PAYROLL_KEY_OUTPUT_COLLISION');
  await safeLeaf(secretPath);
  let key: Buffer;
  const existingKey = await statOrNull(secretPath);
  if (existingKey) {
    const file = await open(secretPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size !== 32 ||
        (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw new Error('PAYROLL_KEY_PERMISSIONS_OR_SIZE');
      key = await file.readFile();
    } finally {
      await file.close();
    }
  } else key = randomBytes(32);
  const manifestPath = join(source, 'manifest.json');
  await safeLeaf(manifestPath);
  const records = manifestRecords(JSON.parse(await readFile(manifestPath, 'utf8')));
  const selected = records.filter(
    (record) =>
      record.excluded.length === 0 &&
      ((record.kind === 'revisal-export' && /\.rvs$/i.test(record.path)) ||
        (record.kind === 'return-xml' &&
          record.returns.some(
            (item) =>
              item.form === 'D112' && item.period.year === '2026' && item.attachment === null,
          ))),
  );
  const registers: RevisalExport[] = [];
  const returns: D112Employees[] = [];
  const files = new Map<string, string>();
  for (const record of selected) {
    const bytes = await inputBytes(source, record);
    let model: RevisalExport | D112Employees;
    let filename: string;
    if (record.kind === 'revisal-export') {
      model = await readRevisal(bytes, key);
      registers.push(model);
      filename = `revisal-${record.sha256}.json`;
    } else {
      const declaration = readDeclaration(bytes);
      const metadata = record.returns.find((item) => item.form === 'D112');
      if (
        !metadata ||
        declaration.form !== 'D112' ||
        declaration.period?.year !== '2026' ||
        declaration.period.month !== metadata?.period.month ||
        String(declaration.version) !== metadata.version
      )
        throw new Error('PAYROLL_MANIFEST_MISMATCH');
      model = readD112Employees(declaration, key);
      returns.push(model);
      filename = `d112-${record.sha256}.json`;
    }
    if (files.has(filename)) throw new Error('PAYROLL_MANIFEST_DUPLICATE');
    files.set(filename, `${JSON.stringify(model, null, 2)}\n`);
  }
  const summary = payrollSummary(registers, returns);
  files.set('summary.json', `${JSON.stringify(summary, null, 2)}\n`);
  files.set(
    'coverage.json',
    `${JSON.stringify(
      {
        fieldsOutsideMappingTable: summary.d112FieldsOutsideMappingTable,
        numericFieldsWithoutNeutralName: summary.d112NumericFieldsWithoutNeutralName,
        unplacedSections: summary.unplacedD112Sections,
      },
      null,
      2,
    )}\n`,
  );
  for (const filename of files.keys()) {
    const destination = join(target, filename);
    if (within(destination, secretPath) || within(secretPath, destination))
      throw new Error('PAYROLL_KEY_OUTPUT_COLLISION');
    await safeLeaf(destination);
  }
  // All invalid-source failures above leave the filesystem unchanged.
  if (!existingKey) {
    await mkdir(dirname(secretPath), { recursive: true, mode: 0o700 });
    await writeFile(secretPath, key, { flag: 'wx', mode: 0o600 });
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
  await chmod(target, 0o700);
  const staging = await mkdtemp(join(target, '.payroll-'));
  try {
    for (const [filename, serialized] of files)
      await writeFile(join(staging, filename), serialized, { flag: 'wx', mode: 0o600 });
    for (const filename of files.keys())
      await rename(join(staging, filename), join(target, filename));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return summary;
}

async function main(args: string[]) {
  if (args.length !== 4 || args[2] !== '--key-file' || args.some((arg) => arg === ''))
    throw new Error('PAYROLL_USAGE');
  const summary = await exportPayrollSources(args[0]!, args[1]!, args[3]!);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (import.meta.main)
  main(process.argv.slice(2)).catch((error: unknown) => {
    // Never print exception text containing a corpus path, an XML value or an archive filename.
    const code =
      error instanceof DomainError
        ? error.code
        : error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
          ? error.message
          : 'PAYROLL_SOURCES_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
