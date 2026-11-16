/**
 * Dumps a SAGA C Firebird 3.0 database (.zip archive containing CONT_BAZA.FDB, or a .FDB file)
 * into plain UTF-8 files under `.private/saga/<alias>/`: `schema.json`, `<TABLE>.jsonl`, and
 * `manifest.json`, then verifies row counts, UTF-8 decoding (no U+FFFD or undeclared Windows-1250
 * mojibake in WIN1252 databases), and exact per-year `REGISTRU.SUMA` totals against SQL.
 *
 * No test in the repository can run this without Docker and a database, so none is added;
 * the built-in self-check after each dump (whose per-year totals are recorded in `manifest.json`)
 * is the proof.
 *
 * Dependency justification (`node-firebird`, pinned as a root devDependency):
 *   Firebird's `isql` CLI formats query results as fixed-width human-readable text tables and
 *   prints BLOBs separately/hex-truncated, requiring fragile text parsing and extra serialization
 *   machinery. `node-firebird` talks directly over the Firebird wire protocol and streams typed
 *   rows without needing custom client tooling inside the container.
 *
 * `node-firebird` (2.21.0) driver quirks worked around here:
 *   1. `numericMode: NUMERIC_MODE_STRING` only covers 64-bit/128-bit integers (`SQLVarInt64` and
 *      `SQLVarInt128`); 16-bit `SQLVarShort` and 32-bit `SQLVarInt` ignore it and decode via
 *      IEEE-754 `Number` and floating-point division. All `SMALLINT`/`INTEGER` columns (scaled and
 *      unscaled) are promoted server-side to `NUMERIC(18, s)` or `BIGINT` so every exact numeric
 *      arrives as `SQL_INT64` and is formatted via `BigInt` strings without touching floats.
 *   2. `SQLVarText` (`CHAR`) truncates decoded strings to `charLength` UTF-16 code units via
 *      `String.prototype.substring`, splitting astral UTF-8 characters into lone surrogates.
 *      Non-`OCTETS` `CHAR(n)` columns are selected as `CAST(col AS VARCHAR(n))` (which routes
 *      through `SQLVarString` without truncation) and right-trimmed of spaces in JS.
 *   3. Default `DATE`/`TIME`/`TIMESTAMP` decoding converts values to JS `Date` objects using the
 *      host timezone/DST rules. Those columns are cast to `VARCHAR` server-side and emitted as
 *      ISO-8601 strings directly.
 *   4. Opening a non-UTF8 database with `encoding: 'UTF8'` causes Firebird to transliterate bytes
 *      using the declared column charset (corrupting SAGA's Windows-1250 bytes stored in `WIN1252`
 *      columns). Attaching with `encoding: 'NONE'` preserves raw wire bytes (`latin1` 1:1) so JS
 *      can decode each column with its declared charset or explicit `--text-encoding` override.
 *   5. `blobAsText: false` delivers BLOB columns (including `RDB$INDICES.RDB$EXPRESSION_SOURCE`)
 *      as `Buffer`s or async reader callbacks; calling a reader without a transaction opens a
 *      new `READ_UNCOMMITTED` transaction (which fails with `Invalid BLOB ID` on system-table
 *      BLOBs), so readers must be invoked with the active transaction `tx`.
 *
 * Usage:
 *   bun scripts/differential/saga-dump.ts <archive.zip or CONT_BAZA.FDB> <alias> [--text-encoding <encoding>] [--force]
 */

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import Firebird from 'node-firebird';

const FIREBIRD_IMAGE =
  'firebirdsql/firebird:3.0.14@sha256:13208a06d768e957e029f3a544c658bfb1c1031cdf322f4e5fa9bb9368ce6015';
const FIREBIRD_PLATFORM = 'linux/amd64';
const CONTAINER_DB_DIR = '/db';
const CONTAINER_DB_NAME = 'CONT_BAZA.FDB';
const CONTAINER_DB_PATH = `${CONTAINER_DB_DIR}/${CONTAINER_DB_NAME}`;

const USAGE =
  'Usage: bun scripts/differential/saga-dump.ts <archive.zip or CONT_BAZA.FDB> <alias> [--text-encoding <encoding>] [--force]';

// Romanian Windows-1250 diacritics (ĂăŞşŢţ) misdecoded under Windows-1252 produce ÃãªºÞþ.
const TELLTALE_WIN1250_AS_WIN1252_RE = /[\u00C3\u00E3\u00AA\u00BA\u00DE\u00FE]/;

interface CliArgs {
  sourcePath: string;
  alias: string;
  force: boolean;
  textEncodingOption: string | null;
}

interface ColumnSchema {
  name: string;
  type: string;
  length: number | null;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  characterSet: string | null;
}

interface InternalColumnInfo extends ColumnSchema {
  fieldType: number;
  subType: number;
  rawScale: number;
}

interface PrimaryKeySchema {
  constraintName: string;
  indexName: string;
  columns: string[];
}

interface IndexSchema {
  name: string;
  unique: boolean;
  descending: boolean;
  inactive: boolean;
  constraintType: string | null;
  columns: string[];
  expressionSource: string | null;
}

interface TableSchema {
  name: string;
  rowCount: number;
  columns: ColumnSchema[];
  primaryKey: PrimaryKeySchema | null;
  indexes: IndexSchema[];
}

interface DatabaseSchema {
  database: {
    characterSet: string;
    firebirdVersion: string;
    odsMajor: number;
    odsMinor: number;
    pageSize: number;
  };
  tables: TableSchema[];
}

interface TableManifestEntry {
  sqlRowCount: number;
  writtenRowCount: number;
  bytes: number;
}

interface RegistruAnnualSumCheck {
  year: number | null;
  sqlSum: string | null;
  jsonlSum: string | null;
}

interface DumpManifest {
  alias: string;
  sourceFile: string;
  sourceSha256: string;
  sourceSize: number;
  firebirdVersion: string;
  databaseCharacterSet: string;
  textEncodingOption: string | null;
  textDecoding: string;
  image: string;
  dumpedAt: string;
  durationMs: number;
  totalBytesWritten: number;
  tableCount: number;
  tables: Record<string, TableManifestEntry>;
  verification: {
    rowCountsMatched: boolean;
    noReplacementChar: boolean;
    registruAnnualSumsMatched: boolean;
    registruYears: Array<number | null>;
    registruAnnualSums: RegistruAnnualSumCheck[];
  };
}

interface RawColumnRow {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  RF_NULL_FLAG: number | null;
  F_NULL_FLAG: number | null;
  FIELD_TYPE: number;
  FIELD_SUB_TYPE: number | null;
  BYTE_LENGTH: number;
  CHAR_LENGTH: number | null;
  FIELD_PRECISION: number | null;
  FIELD_SCALE: number | null;
  CHARSET_NAME: string | null;
}

interface RawPrimaryKeyRow {
  TABLE_NAME: string;
  CONSTRAINT_NAME: string;
  INDEX_NAME: string;
  COLUMN_NAME: string;
}

interface RawIndexRow {
  TABLE_NAME: string;
  INDEX_NAME: string;
  UNIQUE_FLAG: number | null;
  INDEX_TYPE: number | null;
  INDEX_INACTIVE: number | null;
  EXPRESSION_SOURCE: Buffer | string | null;
  COLUMN_NAME: string | null;
  CONSTRAINT_TYPE: string | null;
}

function normalizeTextEncodingOption(raw: string): string {
  if (raw.trim().length === 0) {
    throw new Error('Option --text-encoding requires a non-empty encoding name');
  }
  const lower = raw.trim().toLowerCase();
  if (lower === 'ascii' || lower === 'us-ascii') {
    return 'ascii';
  }
  try {
    return new TextDecoder(raw.trim(), { fatal: true }).encoding;
  } catch {
    throw new Error(`Invalid --text-encoding value: "${raw}"`);
  }
}

function parseArgs(argv: string[]): CliArgs {
  let force = false;
  let textEncodingOption: string | null = null;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--force') {
      force = true;
    } else if (arg === '--text-encoding') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new Error(`Option --text-encoding requires an encoding argument\n${USAGE}`);
      }
      textEncodingOption = normalizeTextEncodingOption(next);
      i++;
    } else if (arg.startsWith('--text-encoding=')) {
      textEncodingOption = normalizeTextEncodingOption(arg.slice('--text-encoding='.length));
    } else if (arg === '-h' || arg === '--help') {
      throw new Error(USAGE);
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 2) {
    throw new Error(USAGE);
  }

  const [sourcePath, alias] = positional;
  if (!/^[A-Za-z0-9_-]+$/.test(alias) || alias.startsWith('_')) {
    throw new Error(
      `Invalid alias "${alias}". Use only ASCII letters, digits, underscores, and hyphens (not starting with "_").`,
    );
  }

  return { sourcePath: path.resolve(sourcePath), alias, force, textEncodingOption };
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function redactSecrets(text: string, secrets: string[]): string {
  let out = text.replace(/(FIREBIRD_ROOT_PASSWORD=)[^\s]+/g, '$1[REDACTED]');
  for (const secret of secrets) {
    if (secret.length > 0) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  return out;
}

async function computeFileDigestAndSize(
  filePath: string,
): Promise<{ sha256: string; size: number }> {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw new Error(`Source path is not a regular file: ${filePath}`);
  }
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve());
  });
  return { sha256: hash.digest('hex'), size: fileStat.size };
}

async function runCommand(
  cmd: string[],
  options?: {
    allowFailure?: boolean;
    env?: Record<string, string | undefined>;
    secrets?: string[];
  },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    stdout: 'pipe',
    stderr: 'pipe',
    env: options?.env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0 && !options?.allowFailure) {
    const secrets = options?.secrets ?? [];
    const safeCmd = redactSecrets(cmd.join(' '), secrets);
    const safeStdout = redactSecrets(stdout.trim(), secrets);
    const safeStderr = redactSecrets(stderr.trim(), secrets);
    throw new Error(
      `Command failed (exit ${exitCode}): ${safeCmd}\nstdout: ${safeStdout}\nstderr: ${safeStderr}`,
    );
  }
  return { exitCode, stdout, stderr };
}

async function verifyZipSingleRegularFdb(sourcePath: string): Promise<void> {
  const namesRes = await runCommand(['unzip', '-Z', '-1', sourcePath]);
  const memberNames = namesRes.stdout.split(/\r?\n/).filter((line) => line.length > 0);
  if (memberNames.length !== 1 || memberNames[0] !== CONTAINER_DB_NAME) {
    throw new Error(
      `Expected archive ${path.basename(sourcePath)} to contain exactly one member named ${CONTAINER_DB_NAME}, found ${memberNames.length}`,
    );
  }

  const infoRes = await runCommand(['unzip', '-Z', sourcePath]);
  const infoLines = infoRes.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const countLine = infoLines.find((line) => /number of entries:\s*1\b/.test(line));
  if (!countLine) {
    throw new Error(`Expected single-entry zip archive for ${path.basename(sourcePath)}`);
  }

  const entryLines = infoLines.filter(
    (line) =>
      !line.startsWith('Archive:') &&
      !line.startsWith('Zip file size:') &&
      !/^\d+\s+files?,/.test(line),
  );
  if (entryLines.length !== 1) {
    throw new Error(
      `Expected exactly 1 entry line in archive metadata for ${path.basename(sourcePath)}, found ${entryLines.length}`,
    );
  }

  const entryLine = entryLines[0];
  // Reject symlinks ('l'), directories ('d'), and special files; require regular file ('-') named CONT_BAZA.FDB.
  if (!entryLine.startsWith('-') || !entryLine.endsWith(` ${CONTAINER_DB_NAME}`)) {
    throw new Error(
      `Archive ${path.basename(sourcePath)} member ${CONTAINER_DB_NAME} is not a regular file`,
    );
  }
}

async function prepareDatabaseCopy(sourcePath: string, workDirReal: string): Promise<string> {
  const lower = sourcePath.toLowerCase();
  const destPath = path.join(workDirReal, CONTAINER_DB_NAME);

  if (lower.endsWith('.zip')) {
    await verifyZipSingleRegularFdb(sourcePath);
    const proc = Bun.spawn(['unzip', '-p', sourcePath, CONTAINER_DB_NAME], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderrPromise = new Response(proc.stderr).text();
    const outStream = createWriteStream(destPath, { flags: 'wx', mode: 0o666 });

    await pipeline(proc.stdout, outStream);
    const [exitCode, stderr] = await Promise.all([proc.exited, stderrPromise]);
    if (exitCode !== 0) {
      throw new Error(
        `Failed to extract ${CONTAINER_DB_NAME} from ${path.basename(sourcePath)} (exit ${exitCode}): ${stderr.trim()}`,
      );
    }
  } else if (lower.endsWith('.fdb')) {
    await copyFile(sourcePath, destPath);
  } else {
    throw new Error(`Unsupported source extension (expected .zip or .fdb): ${sourcePath}`);
  }

  const destStat = await lstat(destPath);
  if (!destStat.isFile() || destStat.isSymbolicLink()) {
    throw new Error(`Staged database copy is not a regular file: ${destPath}`);
  }

  // Firebird writes header/lock state even for read-only queries and gfix -online modifies the header.
  await chmod(destPath, 0o666);
  return destPath;
}

function resolveSafeStagingFile(stagingDirReal: string, tableName: string): string {
  if (
    tableName.length === 0 ||
    tableName === '.' ||
    tableName === '..' ||
    tableName.includes('/') ||
    tableName.includes('\\') ||
    tableName.includes('\0')
  ) {
    throw new Error(`Unsafe table name cannot be mapped to output file: "${tableName}"`);
  }
  const fileName = `${tableName}.jsonl`;
  if (path.basename(fileName) !== fileName) {
    throw new Error(`Unsafe table filename derived from table "${tableName}"`);
  }
  const resolved = path.resolve(stagingDirReal, fileName);
  if (
    !resolved.startsWith(`${stagingDirReal}${path.sep}`) ||
    path.dirname(resolved) !== stagingDirReal
  ) {
    throw new Error(`Resolved table output path escapes staging directory for "${tableName}"`);
  }
  return resolved;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function mapColumnMetadata(raw: RawColumnRow): InternalColumnInfo {
  const fieldType = raw.FIELD_TYPE;
  const subType = raw.FIELD_SUB_TYPE ?? 0;
  const rawScale = raw.FIELD_SCALE ?? 0;
  const nullable = raw.RF_NULL_FLAG !== 1 && raw.F_NULL_FLAG !== 1;
  const charset = raw.CHARSET_NAME ? raw.CHARSET_NAME.trim() : null;

  let type: string;
  let length: number | null = raw.BYTE_LENGTH;
  let precision: number | null = raw.FIELD_PRECISION ?? null;
  let scale: number | null = rawScale !== 0 ? Math.abs(rawScale) : null;
  let characterSet: string | null = null;

  switch (fieldType) {
    case 7:
    case 8:
    case 16: {
      // Check subType === 2 before rawScale < 0 so scaled DECIMAL is not mislabeled NUMERIC.
      if (subType === 2) {
        type = 'DECIMAL';
        scale = Math.abs(rawScale);
      } else if (subType === 1 || rawScale < 0) {
        type = 'NUMERIC';
        scale = Math.abs(rawScale);
      } else {
        type = fieldType === 7 ? 'SMALLINT' : fieldType === 8 ? 'INTEGER' : 'BIGINT';
        precision = null;
        scale = 0;
      }
      break;
    }
    case 10:
      type = 'FLOAT';
      precision = null;
      scale = null;
      break;
    case 12:
      type = 'DATE';
      precision = null;
      scale = null;
      break;
    case 13:
      type = 'TIME';
      precision = null;
      scale = null;
      break;
    case 14:
      type = 'CHAR';
      length = raw.CHAR_LENGTH ?? raw.BYTE_LENGTH;
      precision = null;
      scale = null;
      characterSet = charset;
      break;
    case 23:
      type = 'BOOLEAN';
      precision = null;
      scale = null;
      break;
    case 27:
      type = 'DOUBLE PRECISION';
      precision = null;
      scale = null;
      break;
    case 35:
      type = 'TIMESTAMP';
      precision = null;
      scale = null;
      break;
    case 37:
      type = 'VARCHAR';
      length = raw.CHAR_LENGTH ?? raw.BYTE_LENGTH;
      precision = null;
      scale = null;
      characterSet = charset;
      break;
    case 261:
      type =
        subType === 1
          ? 'BLOB SUB_TYPE TEXT'
          : subType === 0
            ? 'BLOB SUB_TYPE BINARY'
            : `BLOB SUB_TYPE ${subType}`;
      length = null;
      precision = null;
      scale = null;
      characterSet = subType === 1 ? charset : null;
      break;
    default:
      throw new Error(
        `Unsupported Firebird field type ${fieldType} on ${raw.TABLE_NAME}.${raw.COLUMN_NAME}`,
      );
  }

  return {
    name: raw.COLUMN_NAME,
    type,
    length,
    precision,
    scale,
    nullable,
    characterSet,
    fieldType,
    subType,
    rawScale,
  };
}

function buildSelectExpression(col: InternalColumnInfo): string {
  const ident = quoteIdent(col.name);

  // Promote all 16/32-bit exact numerics (scaled and unscaled) to 64-bit SQL_INT64 so
  // node-firebird's NUMERIC_MODE_STRING decodes via BigInt and never passes through JS numbers.
  if (col.fieldType === 7 || col.fieldType === 8) {
    if (col.rawScale < 0 || col.subType === 1 || col.subType === 2) {
      const absScale = Math.abs(col.rawScale);
      return `CAST(${ident} AS NUMERIC(18, ${absScale})) AS ${ident}`;
    }
    return `CAST(${ident} AS BIGINT) AS ${ident}`;
  }

  // Format DATE/TIME/TIMESTAMP server-side as text to avoid JS Date local-timezone/DST shifts.
  if (col.fieldType === 12 || col.fieldType === 13) {
    return `CAST(${ident} AS VARCHAR(16)) AS ${ident}`;
  }
  if (col.fieldType === 35) {
    return `CAST(${ident} AS VARCHAR(32)) AS ${ident}`;
  }

  // Select text CHAR(n) as VARCHAR(n) to avoid node-firebird's UTF-16 length truncation bug,
  // preserving the column's declared character set so multi-byte columns are not truncated to connection charset.
  if (col.fieldType === 14 && col.characterSet !== 'OCTETS') {
    const charLen = Math.max(1, col.length ?? 1);
    const charsetClause = col.characterSet ? ` CHARACTER SET ${col.characterSet}` : '';
    return `CAST(${ident} AS VARCHAR(${charLen})${charsetClause}) AS ${ident}`;
  }

  return ident;
}

async function readBlobValue(raw: unknown, tx: Firebird.Transaction): Promise<Buffer | null> {
  if (raw === null || raw === undefined) return null;
  if (Buffer.isBuffer(raw)) return raw;
  if (typeof raw !== 'function') {
    throw new Error(`Expected Buffer or BLOB reader function, got ${typeof raw}`);
  }
  type BlobReader = (
    transaction: Firebird.Transaction,
    cb: (err: unknown, name: string, stream: NodeJS.EventEmitter | null) => void,
  ) => void;
  const reader = raw as BlobReader;
  return await new Promise<Buffer | null>((resolve, reject) => {
    reader(tx, (err, _name, stream) => {
      if (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (!stream) {
        resolve(null);
        return;
      }
      const chunks: Buffer[] = [];
      let totalLength = 0;
      stream.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        totalLength += chunk.length;
      });
      stream.on('end', () => resolve(Buffer.concat(chunks, totalLength)));
      stream.on('error', (streamErr: unknown) => {
        reject(streamErr instanceof Error ? streamErr : new Error(String(streamErr)));
      });
    });
  });
}

const textDecoderCache = new Map<string, TextDecoder>();

function getTextDecoder(label: string): TextDecoder {
  let decoder = textDecoderCache.get(label);
  if (!decoder) {
    decoder = new TextDecoder(label, { fatal: true });
    textDecoderCache.set(label, decoder);
  }
  return decoder;
}

function resolveTextDecoderLabel(
  columnCharset: string | null,
  databaseCharset: string,
  textEncodingOption: string | null,
  context: string,
): string {
  const effective = columnCharset ?? databaseCharset;
  if (effective === 'UTF8' || effective === 'UNICODE_FSS') {
    return 'utf-8';
  }
  if (effective === 'NONE') {
    if (!textEncodingOption) {
      throw new Error(`Character set NONE on ${context} requires --text-encoding <encoding>`);
    }
    return textEncodingOption;
  }
  if (textEncodingOption && effective === databaseCharset) {
    return textEncodingOption;
  }
  if (effective === 'WIN1251') {
    return 'windows-1251';
  }
  if (effective === 'WIN1250') {
    return 'windows-1250';
  }
  if (effective === 'WIN1252') {
    return 'windows-1252';
  }
  if (effective === 'ISO8859_1' || effective === 'LATIN1') {
    return 'iso-8859-1';
  }
  if (effective === 'ISO8859_2') {
    return 'iso-8859-2';
  }
  if (effective === 'ASCII') {
    return 'ascii';
  }
  throw new Error(`Unsupported Firebird text character set ${effective} on ${context}`);
}

function decodeBufferWithLabel(bytes: Buffer, label: string, context: string): string {
  if (label === 'ascii') {
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] >= 0x80) {
        throw new Error(
          `Non-ASCII byte in ASCII column ${context}; pass --text-encoding <encoding> to override`,
        );
      }
    }
    return bytes.toString('ascii');
  }
  return getTextDecoder(label).decode(bytes);
}

function decodeRawText(
  raw: string,
  col: InternalColumnInfo,
  databaseCharset: string,
  textEncodingOption: string | null,
  alreadyUtf8: boolean,
  context: string,
): string {
  if (alreadyUtf8) {
    return raw;
  }
  const label = resolveTextDecoderLabel(
    col.characterSet,
    databaseCharset,
    textEncodingOption,
    context,
  );
  const bytes = Buffer.from(raw, 'latin1');
  return decodeBufferWithLabel(bytes, label, context);
}

async function normalizeCellValue(
  raw: unknown,
  col: InternalColumnInfo,
  tableName: string,
  tx: Firebird.Transaction,
  databaseCharset: string,
  textEncodingOption: string | null,
  alreadyUtf8: boolean,
): Promise<string | number | boolean | null> {
  if (raw === null || raw === undefined) {
    return null;
  }

  const context = `${tableName}.${col.name}`;

  switch (col.fieldType) {
    case 14:
    case 37: {
      if (col.characterSet === 'OCTETS') {
        if (!Buffer.isBuffer(raw)) {
          throw new Error(`Expected Buffer for OCTETS column ${context}, got ${typeof raw}`);
        }
        return raw.toString('base64');
      }
      if (typeof raw !== 'string') {
        throw new Error(
          `Expected string for ${col.fieldType === 14 ? 'CHAR' : 'VARCHAR'} column ${context}, got ${typeof raw}`,
        );
      }
      const decoded = decodeRawText(
        raw,
        col,
        databaseCharset,
        textEncodingOption,
        alreadyUtf8,
        context,
      );
      const value = col.fieldType === 14 ? decoded.replace(/ +$/, '') : decoded;
      if (value.includes('\uFFFD')) {
        throw new Error(`Decoded U+FFFD replacement character in ${context}`);
      }
      return value;
    }
    case 7:
    case 8:
    case 16: {
      if (typeof raw !== 'string') {
        throw new Error(`Expected exact numeric string for ${context}, got ${typeof raw}`);
      }
      return raw;
    }
    case 10:
    case 27: {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        throw new Error(`Expected finite floating-point number for ${context}, got ${typeof raw}`);
      }
      return raw;
    }
    case 12:
    case 13: {
      if (typeof raw !== 'string') {
        throw new Error(`Expected ISO date/time string for ${context}, got ${typeof raw}`);
      }
      return raw.trim();
    }
    case 35: {
      if (typeof raw !== 'string') {
        throw new Error(`Expected ISO timestamp string for ${context}, got ${typeof raw}`);
      }
      const trimmed = raw.trim();
      // Firebird formats TIMESTAMP as 'YYYY-MM-DD HH:MM:SS.ffff'.
      return trimmed.length > 10 && trimmed[10] === ' '
        ? `${trimmed.slice(0, 10)}T${trimmed.slice(11)}`
        : trimmed;
    }
    case 23: {
      if (typeof raw !== 'boolean') {
        throw new Error(`Expected boolean for ${context}, got ${typeof raw}`);
      }
      return raw;
    }
    case 261: {
      const buf = await readBlobValue(raw, tx);
      if (buf === null) {
        return null;
      }
      if (col.subType === 1) {
        const label = resolveTextDecoderLabel(
          col.characterSet,
          databaseCharset,
          textEncodingOption,
          context,
        );
        const text = decodeBufferWithLabel(buf, label, context);
        if (text.includes('\uFFFD')) {
          throw new Error(`Decoded U+FFFD replacement character in ${context}`);
        }
        return text;
      }
      return buf.toString('base64');
    }
    default:
      throw new Error(`Unhandled fieldType ${col.fieldType} on ${context}`);
  }
}

function parseDecimalToScaledBigInt(value: string, scale: number, context: string): bigint {
  const trimmed = value.trim();
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid decimal string in ${context}`);
  }
  const negative = match[1] === '-';
  const intPart = match[2];
  const fracPart = match[3] ?? '';
  if (fracPart.length > scale) {
    throw new Error(
      `Decimal value in ${context} has ${fracPart.length} fractional digits, exceeding scale ${scale}`,
    );
  }
  const raw = BigInt(`${intPart}${fracPart.padEnd(scale, '0')}`);
  return negative ? -raw : raw;
}

function formatScaledBigInt(value: bigint, scale: number): string {
  if (scale === 0) return value.toString();
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

async function attachWithRetry(
  options: Firebird.Options,
  containerName: string,
  password: string,
  timeoutMs = 45_000,
): Promise<Firebird.Database> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  let onlineApplied = false;

  while (Date.now() < deadline) {
    if (!onlineApplied) {
      const gfixRes = await runCommand(
        ['docker', 'exec', containerName, '/opt/firebird/bin/gfix', '-online', CONTAINER_DB_PATH],
        { allowFailure: true },
      );
      if (gfixRes.exitCode === 0) {
        onlineApplied = true;
      }
    }

    try {
      return await Firebird.attachAsync(options);
    } catch (err) {
      lastError = err;
      await Bun.sleep(400);
    }
  }

  const rawMsg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `Timed out connecting to Firebird container ${containerName}: ${redactSecrets(rawMsg, [password])}`,
  );
}

async function dumpTableJsonl(
  tx: Firebird.Transaction,
  table: TableSchema,
  internalColumns: InternalColumnInfo[],
  outputPath: string,
  databaseCharset: string,
  textEncodingOption: string | null,
  alreadyUtf8: boolean,
): Promise<{ rowsWritten: number; bytesWritten: number }> {
  const selectExprs = internalColumns.map(buildSelectExpression).join(', ');
  const sql = `SELECT ${selectExprs} FROM ${quoteIdent(table.name)}`;

  let rowsWritten = 0;

  await pipeline(
    tx.queryStream(sql, undefined, { fetchSize: 5000 }),
    async function* (source: AsyncIterable<Record<string, unknown>>) {
      for await (const rawRow of source) {
        const outRow: Record<string, string | number | boolean | null> = {};
        for (const col of internalColumns) {
          outRow[col.name] = await normalizeCellValue(
            rawRow[col.name],
            col,
            table.name,
            tx,
            databaseCharset,
            textEncodingOption,
            alreadyUtf8,
          );
        }
        rowsWritten++;
        yield `${JSON.stringify(outRow)}\n`;
      }
    },
    createWriteStream(outputPath, { encoding: 'utf8' }),
  );

  const outStat = await stat(outputPath);
  return { rowsWritten, bytesWritten: outStat.size };
}

function checkDecodedTextValue(
  value: unknown,
  context: string,
  checkWin1252Mojibake: boolean,
): void {
  if (typeof value !== 'string') return;
  if (value.includes('\uFFFD')) {
    throw new Error(`Verification failed: U+FFFD found in ${context}`);
  }
  if (checkWin1252Mojibake && TELLTALE_WIN1250_AS_WIN1252_RE.test(value)) {
    throw new Error(
      `Verification failed: found tell-tale Windows-1250 bytes misdecoded as WIN1252 in ${context}; rerun with --text-encoding windows-1250`,
    );
  }
}

async function verifyDump(
  tx: Firebird.Transaction,
  schema: DatabaseSchema,
  stagingDirReal: string,
  textEncodingOption: string | null,
): Promise<{
  writtenCounts: Record<string, number>;
  registruYears: Array<number | null>;
  registruAnnualSums: RegistruAnnualSumCheck[];
}> {
  const writtenCounts: Record<string, number> = {};
  let registruSchema: TableSchema | undefined;
  const checkDeclaredWin1252 = textEncodingOption === null;

  for (const table of schema.tables) {
    const filePath = resolveSafeStagingFile(stagingDirReal, table.name);
    const win1252CheckByCol = new Map<string, boolean>();
    for (const col of table.columns) {
      const effective = col.characterSet ?? schema.database.characterSet;
      const isTextCol =
        col.type === 'CHAR' || col.type === 'VARCHAR' || col.type === 'BLOB SUB_TYPE TEXT';
      win1252CheckByCol.set(col.name, checkDeclaredWin1252 && isTextCol && effective === 'WIN1252');
    }

    let lineCount = 0;
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (line.length === 0) {
        throw new Error(
          `Verification failed: empty line in ${table.name}.jsonl at line ${lineCount + 1}`,
        );
      }
      const parsed = JSON.parse(line) as Record<string, unknown>;
      for (const [colName, val] of Object.entries(parsed)) {
        checkDecodedTextValue(
          val,
          `${table.name}.jsonl:${lineCount + 1}.${colName}`,
          win1252CheckByCol.get(colName) ?? false,
        );
      }
      lineCount++;
    }

    if (lineCount !== table.rowCount) {
      throw new Error(
        `Verification failed for ${table.name}: SQL COUNT(*) = ${table.rowCount}, JSONL lines = ${lineCount}`,
      );
    }
    writtenCounts[table.name] = lineCount;

    if (table.name === 'REGISTRU') {
      registruSchema = table;
    }
  }

  if (!registruSchema) {
    throw new Error('Verification failed: table REGISTRU not found in database schema');
  }

  const sumaCol = registruSchema.columns.find((c) => c.name === 'SUMA');
  if (!sumaCol) {
    throw new Error('Verification failed: column REGISTRU.SUMA not found');
  }
  const sumaScale = sumaCol.scale ?? 2;

  // Compute SQL per-year sums of REGISTRU.SUMA as exact NUMERIC(18, scale).
  const sqlYearRows = await tx.queryAsync<{ YR: number | null; TOTAL: string | null }>(
    `SELECT EXTRACT(YEAR FROM "DATA") AS "YR", ` +
      `CAST(SUM("SUMA") AS NUMERIC(18, ${sumaScale})) AS "TOTAL" ` +
      `FROM "REGISTRU" GROUP BY EXTRACT(YEAR FROM "DATA") ORDER BY EXTRACT(YEAR FROM "DATA")`,
  );

  const sqlSums = new Map<
    string,
    { year: number | null; raw: string | null; scaled: bigint | null }
  >();
  const registruYears: Array<number | null> = [];
  for (const row of sqlYearRows) {
    const key = row.YR === null ? 'null' : String(row.YR);
    registruYears.push(row.YR);
    sqlSums.set(key, {
      year: row.YR,
      raw: row.TOTAL,
      scaled:
        row.TOTAL === null
          ? null
          : parseDecimalToScaledBigInt(row.TOTAL, sumaScale, `REGISTRU.SUMA SQL year ${key}`),
    });
  }

  // Recompute per-year sums from REGISTRU.jsonl using exact BigInt arithmetic.
  const jsonlSums = new Map<string, bigint | null>();
  const registruFile = resolveSafeStagingFile(stagingDirReal, 'REGISTRU');
  const rl = createInterface({
    input: createReadStream(registruFile, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let registruLine = 0;
  for await (const line of rl) {
    registruLine++;
    const row = JSON.parse(line) as { DATA: string | null; SUMA: string | null };
    let yearKey = 'null';
    if (row.DATA !== null) {
      const yearMatch = /^(\d{4})-/.exec(row.DATA);
      if (!yearMatch) {
        throw new Error(
          `Verification failed: invalid date format in REGISTRU.DATA at line ${registruLine}`,
        );
      }
      yearKey = String(Number(yearMatch[1]));
    }

    const prev = jsonlSums.get(yearKey);
    if (row.SUMA === null) {
      if (!jsonlSums.has(yearKey)) {
        jsonlSums.set(yearKey, null);
      }
    } else {
      const amount = parseDecimalToScaledBigInt(
        row.SUMA,
        sumaScale,
        `REGISTRU.jsonl:${registruLine}.SUMA`,
      );
      jsonlSums.set(yearKey, (prev ?? 0n) + amount);
    }
  }

  if (sqlSums.size !== jsonlSums.size) {
    throw new Error(
      `Verification failed for REGISTRU annual sums: SQL returned ${sqlSums.size} year groups, JSONL has ${jsonlSums.size}`,
    );
  }

  const registruAnnualSums: RegistruAnnualSumCheck[] = [];
  for (const [yearKey, sqlEntry] of sqlSums) {
    if (!jsonlSums.has(yearKey)) {
      throw new Error(`Verification failed: year ${yearKey} missing in REGISTRU.jsonl`);
    }
    const jsonlTotal = jsonlSums.get(yearKey) ?? null;
    if (sqlEntry.scaled !== jsonlTotal) {
      throw new Error(
        `Verification failed for REGISTRU.SUMA annual sum in year ${yearKey}: SQL total does not match JSONL total`,
      );
    }
    registruAnnualSums.push({
      year: sqlEntry.year,
      sqlSum: sqlEntry.raw,
      jsonlSum: jsonlTotal === null ? null : formatScaledBigInt(jsonlTotal, sumaScale),
    });
  }

  return { writtenCounts, registruYears, registruAnnualSums };
}

function finalizeManifestJson(manifest: DumpManifest, baseBytes: number): string {
  for (let i = 0; i < 4; i++) {
    const json = `${JSON.stringify(manifest, null, 2)}\n`;
    const byteLen = Buffer.byteLength(json, 'utf8');
    if (manifest.totalBytesWritten === baseBytes + byteLen) {
      return json;
    }
    manifest.totalBytesWritten = baseBytes + byteLen;
  }
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function acquireAliasLock(lockPath: string): Promise<void> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  try {
    const handle = await open(lockPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${process.pid}\n`, 'utf8');
    } finally {
      await handle.close();
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      throw new Error(
        `Another dump for this alias appears to be in progress (lock exists at ${lockPath})`,
      );
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const { sourcePath, alias, force, textEncodingOption } = parseArgs(process.argv.slice(2));

  if (!(await exists(sourcePath))) {
    throw new Error(`Source file does not exist: ${sourcePath}`);
  }

  const sagaRoot = path.resolve('.private/saga');
  const outDir = path.join(sagaRoot, alias);
  if ((await exists(outDir)) && !force) {
    throw new Error(
      `Output directory already exists for alias "${alias}": ${outDir}. Pass --force to overwrite.`,
    );
  }

  const runToken = `${alias}-${process.pid}-${Date.now()}`;
  const lockPath = path.join(sagaRoot, '_locks', `${alias}.lock`);
  const workDir = path.join(sagaRoot, '_work', runToken);
  const stagingDir = path.join(sagaRoot, `_staging-${runToken}`);
  const oldOutDir = path.join(sagaRoot, `_old-${runToken}`);
  const containerName = `saga-dump-${runToken}`;
  const password = randomBytes(16).toString('hex');

  let lockAcquired = false;
  let containerCreated = false;
  let dockerRunSucceeded = false;
  let db: Firebird.Database | undefined;
  let cleanupPromise: Promise<string[]> | null = null;

  const cleanup = (): Promise<string[]> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      const errors: string[] = [];

      if (db) {
        try {
          await db.detachAsync(true);
        } catch {
          // Best-effort detach before container removal.
        }
        db = undefined;
      }

      if (containerCreated) {
        const rmRes = await runCommand(['docker', 'rm', '-f', containerName], {
          allowFailure: true,
        });
        containerCreated = false;
        if (rmRes.exitCode !== 0) {
          const isMissingBeforeStart =
            !dockerRunSucceeded && rmRes.stderr.includes('No such container');
          if (!isMissingBeforeStart) {
            errors.push(
              `docker rm -f ${containerName} exited with ${rmRes.exitCode}: ${rmRes.stderr.trim()}`,
            );
          }
        }
      }

      for (const dir of [workDir, stagingDir, oldOutDir]) {
        try {
          await rm(dir, { recursive: true, force: true });
        } catch (err) {
          errors.push(
            `failed to remove ${dir}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (lockAcquired) {
        try {
          await rm(lockPath, { force: true });
          lockAcquired = false;
        } catch (err) {
          errors.push(
            `failed to remove lock ${lockPath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      return errors;
    })();
    return cleanupPromise;
  };

  const onSignal = (signal: NodeJS.Signals) => {
    void cleanup().then((cleanupErrors) => {
      if (cleanupErrors.length > 0) {
        console.error(`Cleanup failed after ${signal}: ${cleanupErrors.join('; ')}`);
      }
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let primaryError: unknown;
  try {
    await acquireAliasLock(lockPath);
    lockAcquired = true;

    if ((await exists(outDir)) && !force) {
      throw new Error(
        `Output directory already exists for alias "${alias}": ${outDir}. Pass --force to overwrite.`,
      );
    }

    const { sha256: sourceSha256, size: sourceSize } = await computeFileDigestAndSize(sourcePath);

    await mkdir(workDir, { recursive: true });
    await mkdir(stagingDir, { recursive: true });
    const workDirReal = await realpath(workDir);
    const stagingDirReal = await realpath(stagingDir);

    await prepareDatabaseCopy(sourcePath, workDirReal);

    containerCreated = true;
    await runCommand(
      [
        'docker',
        'run',
        '-d',
        '--name',
        containerName,
        '--platform',
        FIREBIRD_PLATFORM,
        '-e',
        'FIREBIRD_ROOT_PASSWORD',
        '-p',
        '127.0.0.1:0:3050',
        '-v',
        `${workDirReal}:${CONTAINER_DB_DIR}`,
        FIREBIRD_IMAGE,
      ],
      {
        env: { ...process.env, FIREBIRD_ROOT_PASSWORD: password },
        secrets: [password],
      },
    );
    dockerRunSucceeded = true;

    const portResult = await runCommand(['docker', 'port', containerName, '3050/tcp']);
    const portMatch = /127\.0\.0\.1:(\d+)/.exec(portResult.stdout);
    if (!portMatch) {
      throw new Error(`Unexpected docker port output: ${portResult.stdout}`);
    }
    const hostPort = Number(portMatch[1]);

    db = await attachWithRetry(
      {
        host: '127.0.0.1',
        port: hostPort,
        database: CONTAINER_DB_PATH,
        user: 'SYSDBA',
        password,
        encoding: 'UTF8',
        numericMode: Firebird.NUMERIC_MODE_STRING,
        blobAsText: false,
        lowercase_keys: false,
      },
      containerName,
      password,
    );

    const tx = await db.transactionAsync({
      isolation: Firebird.ISOLATION_REPEATABLE_READ,
      readOnly: true,
    });

    let schema: DatabaseSchema;
    let columnsByTable: Map<string, InternalColumnInfo[]>;
    let totalBytesWritten: number;

    try {
      const dbInfoRows = await tx.queryAsync<{
        CHARSET: string;
        ENGINE_VERSION: string;
      }>(
        `SELECT TRIM(RDB$CHARACTER_SET_NAME) AS "CHARSET", ` +
          `RDB$GET_CONTEXT('SYSTEM', 'ENGINE_VERSION') AS "ENGINE_VERSION" ` +
          `FROM RDB$DATABASE`,
      );
      const monRows = await tx.queryAsync<{
        ODS_MAJOR: number;
        ODS_MINOR: number;
        PAGE_SIZE: number;
      }>(
        `SELECT MON$ODS_MAJOR AS "ODS_MAJOR", MON$ODS_MINOR AS "ODS_MINOR", MON$PAGE_SIZE AS "PAGE_SIZE" FROM MON$DATABASE`,
      );

      if (dbInfoRows.length !== 1 || monRows.length !== 1) {
        throw new Error('Failed to read database header metadata');
      }

      const databaseCharset = dbInfoRows[0].CHARSET;
      const firebirdVersion = dbInfoRows[0].ENGINE_VERSION;

      const tableRows = await tx.queryAsync<{ NAME: string }>(
        `SELECT TRIM(RDB$RELATION_NAME) AS "NAME" ` +
          `FROM RDB$RELATIONS ` +
          `WHERE RDB$SYSTEM_FLAG = 0 AND RDB$VIEW_BLR IS NULL ` +
          `ORDER BY RDB$RELATION_NAME`,
      );

      for (const { NAME: tableName } of tableRows) {
        resolveSafeStagingFile(stagingDirReal, tableName);
      }

      const rawColumns = await tx.queryAsync<RawColumnRow>(
        `SELECT ` +
          `TRIM(rf.RDB$RELATION_NAME) AS "TABLE_NAME", ` +
          `TRIM(rf.RDB$FIELD_NAME) AS "COLUMN_NAME", ` +
          `rf.RDB$NULL_FLAG AS "RF_NULL_FLAG", ` +
          `f.RDB$NULL_FLAG AS "F_NULL_FLAG", ` +
          `f.RDB$FIELD_TYPE AS "FIELD_TYPE", ` +
          `f.RDB$FIELD_SUB_TYPE AS "FIELD_SUB_TYPE", ` +
          `f.RDB$FIELD_LENGTH AS "BYTE_LENGTH", ` +
          `f.RDB$CHARACTER_LENGTH AS "CHAR_LENGTH", ` +
          `f.RDB$FIELD_PRECISION AS "FIELD_PRECISION", ` +
          `f.RDB$FIELD_SCALE AS "FIELD_SCALE", ` +
          `TRIM(cs.RDB$CHARACTER_SET_NAME) AS "CHARSET_NAME" ` +
          `FROM RDB$RELATION_FIELDS rf ` +
          `JOIN RDB$RELATIONS r ON r.RDB$RELATION_NAME = rf.RDB$RELATION_NAME ` +
          `JOIN RDB$FIELDS f ON f.RDB$FIELD_NAME = rf.RDB$FIELD_SOURCE ` +
          `LEFT JOIN RDB$CHARACTER_SETS cs ON cs.RDB$CHARACTER_SET_ID = f.RDB$CHARACTER_SET_ID ` +
          `WHERE r.RDB$SYSTEM_FLAG = 0 AND r.RDB$VIEW_BLR IS NULL ` +
          `ORDER BY rf.RDB$RELATION_NAME, rf.RDB$FIELD_POSITION`,
      );

      const rawPks = await tx.queryAsync<RawPrimaryKeyRow>(
        `SELECT ` +
          `TRIM(rc.RDB$RELATION_NAME) AS "TABLE_NAME", ` +
          `TRIM(rc.RDB$CONSTRAINT_NAME) AS "CONSTRAINT_NAME", ` +
          `TRIM(rc.RDB$INDEX_NAME) AS "INDEX_NAME", ` +
          `TRIM(iseg.RDB$FIELD_NAME) AS "COLUMN_NAME" ` +
          `FROM RDB$RELATION_CONSTRAINTS rc ` +
          `JOIN RDB$INDEX_SEGMENTS iseg ON iseg.RDB$INDEX_NAME = rc.RDB$INDEX_NAME ` +
          `WHERE rc.RDB$CONSTRAINT_TYPE = 'PRIMARY KEY' ` +
          `ORDER BY rc.RDB$RELATION_NAME, iseg.RDB$FIELD_POSITION`,
      );

      const rawIndexes = await tx.queryAsync<RawIndexRow>(
        `SELECT ` +
          `TRIM(idx.RDB$RELATION_NAME) AS "TABLE_NAME", ` +
          `TRIM(idx.RDB$INDEX_NAME) AS "INDEX_NAME", ` +
          `idx.RDB$UNIQUE_FLAG AS "UNIQUE_FLAG", ` +
          `idx.RDB$INDEX_TYPE AS "INDEX_TYPE", ` +
          `idx.RDB$INDEX_INACTIVE AS "INDEX_INACTIVE", ` +
          `idx.RDB$EXPRESSION_SOURCE AS "EXPRESSION_SOURCE", ` +
          `TRIM(iseg.RDB$FIELD_NAME) AS "COLUMN_NAME", ` +
          `TRIM(rc.RDB$CONSTRAINT_TYPE) AS "CONSTRAINT_TYPE" ` +
          `FROM RDB$INDICES idx ` +
          `JOIN RDB$RELATIONS r ON r.RDB$RELATION_NAME = idx.RDB$RELATION_NAME ` +
          `LEFT JOIN RDB$INDEX_SEGMENTS iseg ON iseg.RDB$INDEX_NAME = idx.RDB$INDEX_NAME ` +
          `LEFT JOIN RDB$RELATION_CONSTRAINTS rc ON rc.RDB$INDEX_NAME = idx.RDB$INDEX_NAME ` +
          `WHERE r.RDB$SYSTEM_FLAG = 0 AND r.RDB$VIEW_BLR IS NULL ` +
          `ORDER BY idx.RDB$RELATION_NAME, idx.RDB$INDEX_NAME, iseg.RDB$FIELD_POSITION`,
      );

      columnsByTable = new Map<string, InternalColumnInfo[]>();
      for (const rawCol of rawColumns) {
        const list = columnsByTable.get(rawCol.TABLE_NAME) ?? [];
        const mapped = mapColumnMetadata(rawCol);
        // Validate every text column's character set up front (including requiring --text-encoding for NONE).
        if (
          mapped.type === 'CHAR' ||
          mapped.type === 'VARCHAR' ||
          mapped.type === 'BLOB SUB_TYPE TEXT'
        ) {
          if (mapped.characterSet !== 'OCTETS') {
            resolveTextDecoderLabel(
              mapped.characterSet,
              databaseCharset,
              textEncodingOption,
              `${rawCol.TABLE_NAME}.${rawCol.COLUMN_NAME}`,
            );
          }
        }
        list.push(mapped);
        columnsByTable.set(rawCol.TABLE_NAME, list);
      }

      const pkByTable = new Map<string, PrimaryKeySchema>();
      for (const rawPk of rawPks) {
        const existingPk = pkByTable.get(rawPk.TABLE_NAME);
        if (existingPk) {
          existingPk.columns.push(rawPk.COLUMN_NAME);
        } else {
          pkByTable.set(rawPk.TABLE_NAME, {
            constraintName: rawPk.CONSTRAINT_NAME,
            indexName: rawPk.INDEX_NAME,
            columns: [rawPk.COLUMN_NAME],
          });
        }
      }

      const indexesByTable = new Map<string, Map<string, IndexSchema>>();
      for (const rawIdx of rawIndexes) {
        let tableIdxMap = indexesByTable.get(rawIdx.TABLE_NAME);
        if (!tableIdxMap) {
          tableIdxMap = new Map<string, IndexSchema>();
          indexesByTable.set(rawIdx.TABLE_NAME, tableIdxMap);
        }
        let idx = tableIdxMap.get(rawIdx.INDEX_NAME);
        if (!idx) {
          let expr: string | null = null;
          if (rawIdx.EXPRESSION_SOURCE !== null) {
            const exprBuf = await readBlobValue(rawIdx.EXPRESSION_SOURCE, tx);
            if (exprBuf !== null) {
              expr = getTextDecoder('utf-8').decode(exprBuf);
            }
          }
          idx = {
            name: rawIdx.INDEX_NAME,
            unique: rawIdx.UNIQUE_FLAG === 1,
            descending: rawIdx.INDEX_TYPE === 1,
            inactive: rawIdx.INDEX_INACTIVE === 1,
            constraintType: rawIdx.CONSTRAINT_TYPE ?? null,
            columns: [],
            expressionSource: expr,
          };
          tableIdxMap.set(rawIdx.INDEX_NAME, idx);
        }
        if (rawIdx.COLUMN_NAME !== null) {
          idx.columns.push(rawIdx.COLUMN_NAME);
        }
      }

      const tables: TableSchema[] = [];
      for (const { NAME: tableName } of tableRows) {
        const internalCols = columnsByTable.get(tableName) ?? [];
        if (internalCols.length === 0) {
          throw new Error(`Table ${tableName} has no columns`);
        }

        const countRows = await tx.queryAsync<{ CNT: number }>(
          `SELECT CAST(COUNT(*) AS INTEGER) AS "CNT" FROM ${quoteIdent(tableName)}`,
        );
        const rowCount = countRows[0]?.CNT;
        if (typeof rowCount !== 'number') {
          throw new Error(`Failed to read SQL row count for ${tableName}`);
        }

        const tableIndexes = Array.from(indexesByTable.get(tableName)?.values() ?? []);
        tables.push({
          name: tableName,
          rowCount,
          columns: internalCols.map((c) => ({
            name: c.name,
            type: c.type,
            length: c.length,
            precision: c.precision,
            scale: c.scale,
            nullable: c.nullable,
            characterSet: c.characterSet,
          })),
          primaryKey: pkByTable.get(tableName) ?? null,
          indexes: tableIndexes,
        });
      }

      schema = {
        database: {
          characterSet: databaseCharset,
          firebirdVersion,
          odsMajor: monRows[0].ODS_MAJOR,
          odsMinor: monRows[0].ODS_MINOR,
          pageSize: monRows[0].PAGE_SIZE,
        },
        tables,
      };

      const schemaPath = path.join(stagingDirReal, 'schema.json');
      await writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
      totalBytesWritten = (await stat(schemaPath)).size;

      await tx.commitAsync();
    } catch (err) {
      try {
        await tx.rollbackAsync();
      } catch {
        // Ignore rollback failure on error path (tx may already be committed).
      }
      throw err;
    }

    const databaseCharset = schema.database.characterSet;
    const firebirdVersion = schema.database.firebirdVersion;
    const alreadyUtf8 =
      (databaseCharset === 'UTF8' || databaseCharset === 'UNICODE_FSS') &&
      textEncodingOption === null;

    if (!alreadyUtf8) {
      await db.detachAsync(true);
      db = undefined;
      db = await Firebird.attachAsync({
        host: '127.0.0.1',
        port: hostPort,
        database: CONTAINER_DB_PATH,
        user: 'SYSDBA',
        password,
        encoding: 'NONE',
        numericMode: Firebird.NUMERIC_MODE_STRING,
        blobAsText: false,
        lowercase_keys: false,
      });
    }

    const dataTx = await db.transactionAsync({
      isolation: Firebird.ISOLATION_REPEATABLE_READ,
      readOnly: true,
    });

    try {
      const manifestTables: Record<string, TableManifestEntry> = {};

      for (const table of schema.tables) {
        const internalCols = columnsByTable.get(table.name)!;
        const jsonlPath = resolveSafeStagingFile(stagingDirReal, table.name);
        const { rowsWritten, bytesWritten } = await dumpTableJsonl(
          dataTx,
          table,
          internalCols,
          jsonlPath,
          databaseCharset,
          textEncodingOption,
          alreadyUtf8,
        );
        totalBytesWritten += bytesWritten;
        manifestTables[table.name] = {
          sqlRowCount: table.rowCount,
          writtenRowCount: rowsWritten,
          bytes: bytesWritten,
        };
      }

      const { writtenCounts, registruYears, registruAnnualSums } = await verifyDump(
        dataTx,
        schema,
        stagingDirReal,
        textEncodingOption,
      );
      for (const [tableName, count] of Object.entries(writtenCounts)) {
        manifestTables[tableName].writtenRowCount = count;
      }

      const durationMs = Date.now() - startedAt;
      const textDecoding = resolveTextDecoderLabel(
        null,
        databaseCharset,
        textEncodingOption,
        'database',
      );
      const manifestPath = path.join(stagingDirReal, 'manifest.json');
      const manifest: DumpManifest = {
        alias,
        sourceFile: path.basename(sourcePath),
        sourceSha256,
        sourceSize,
        firebirdVersion,
        databaseCharacterSet: databaseCharset,
        textEncodingOption,
        textDecoding,
        image: FIREBIRD_IMAGE,
        dumpedAt: new Date().toISOString(),
        durationMs,
        totalBytesWritten: 0,
        tableCount: schema.tables.length,
        tables: manifestTables,
        verification: {
          rowCountsMatched: true,
          noReplacementChar: true,
          registruAnnualSumsMatched: true,
          registruYears,
          registruAnnualSums,
        },
      };
      const manifestJson = finalizeManifestJson(manifest, totalBytesWritten);
      await writeFile(manifestPath, manifestJson, 'utf8');

      await dataTx.commitAsync();
    } catch (dataErr) {
      try {
        await dataTx.rollbackAsync();
      } catch {
        // Ignore rollback failure on error path.
      }
      throw dataErr;
    }

    // Re-check --force at publication under the alias lock to prevent concurrent overwrites.
    const outExists = await exists(outDir);
    if (outExists) {
      if (!force) {
        throw new Error(
          `Output directory already exists for alias "${alias}": ${outDir}. Pass --force to overwrite.`,
        );
      }
      await rename(outDir, oldOutDir);
      try {
        await rename(stagingDirReal, outDir);
      } catch (renameErr) {
        try {
          await rename(oldOutDir, outDir);
        } catch {
          // Best-effort restore if publication rename fails.
        }
        throw renameErr;
      }
      await rm(oldOutDir, { recursive: true, force: true });
    } else {
      await rename(stagingDirReal, outDir);
    }

    // Print only non-sensitive summary metadata.
    const manifestRaw = await readFile(path.join(outDir, 'manifest.json'), 'utf8');
    const finalManifest = JSON.parse(manifestRaw) as DumpManifest;
    console.log(
      `Dumped "${alias}": ${finalManifest.tableCount} tables, ${finalManifest.totalBytesWritten} bytes in ${finalManifest.durationMs}ms (Firebird ${finalManifest.firebirdVersion}, declared ${finalManifest.databaseCharacterSet}, decoded ${finalManifest.textDecoding}).`,
    );
  } catch (err) {
    primaryError = err;
    throw err;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    const cleanupErrors = await cleanup();
    if (cleanupErrors.length > 0) {
      const msg = `Cleanup failed: ${cleanupErrors.join('; ')}`;
      if (primaryError === undefined) {
        throw new Error(msg);
      }
      console.error(msg);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
