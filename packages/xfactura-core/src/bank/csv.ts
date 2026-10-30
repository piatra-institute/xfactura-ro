import { z } from 'zod';
import { DomainError, requireCondition } from '../errors';
import { isLocalDate } from '../time';
import { Amount } from '../values';
import { bankFileLimits, type StatementRow } from './statement-document';

/*
 * Bank statements exported as CSV. Banks lay their exports out differently, so a mapping says
 * how to read one: the agent proposes it from the file's first lines, the engine parses every
 * row with it deterministically, and the mapping is kept per account for the next export. Pure:
 * the bytes and the mapping decide the rows.
 */

// TextDecoder is a Web-platform global (browsers, Bun, Node), outside the ES library core
// compiles against.
const Decoder = (
  globalThis as unknown as {
    TextDecoder: new (
      label: string,
      options: { fatal: boolean },
    ) => { decode(bytes: Uint8Array): string };
  }
).TextDecoder;

/** A column, by its number from 1 or by its title in the last header row. */
export const csvColumnSchema = z.union([
  z.number().int().min(1).max(200),
  z.string().trim().min(1).max(200),
]);
export type CsvColumn = z.infer<typeof csvColumnSchema>;
/** A cell outside the movements: its row (from 1, or from the end when negative) and column. */
const csvCellSchema = z
  .object({
    row: z
      .number()
      .int()
      .min(-1000)
      .max(100_000)
      .refine((row) => row !== 0, 'Rândul se numără de la 1, sau de la sfârșit cu -1.'),
    column: z.number().int().min(1).max(200),
  })
  .strict();

export const csvDateFormats = [
  'DD.MM.YYYY',
  'DD/MM/YYYY',
  'DD-MM-YYYY',
  'YYYY-MM-DD',
  'MM/DD/YYYY',
  'DD.MM.YY',
  'YYYYMMDD',
] as const;
export const csvEncodings = ['utf-8', 'windows-1250', 'iso-8859-2', 'utf-16le'] as const;

export const csvMappingSchema = z
  .object({
    separator: z.enum([',', ';', '\t', '|']),
    encoding: z.enum(csvEncodings),
    /** How dates are written; a time after the date is ignored. */
    dateFormat: z.enum(csvDateFormats),
    /** The decimal mark of amounts; thousands may be grouped by the other mark, a space or an
     * apostrophe. */
    decimal: z.enum(['.', ',']),
    /** Rows before the movements (titles, account details, column titles last). */
    headerRows: z.number().int().min(0).max(50),
    /** Rows after the movements (totals, closing balance). */
    footerRows: z.number().int().min(0).max(50).default(0),
    /** The order of the movements in the file. */
    order: z.enum(['oldest_first', 'newest_first']).default('oldest_first'),
    columns: z
      .object({
        date: csvColumnSchema,
        valueDate: csvColumnSchema.optional(),
        /** A signed amount: money in positive, money out negative. */
        amount: csvColumnSchema.optional(),
        /** Or two columns: money out (debit) and money in (credit), whatever their sign. */
        debit: csvColumnSchema.optional(),
        credit: csvColumnSchema.optional(),
        /** The columns whose text describes the movement, joined with spaces. */
        description: z.array(csvColumnSchema).min(1).max(5).optional(),
        /** The bank's own reference of the movement, unique per movement. */
        reference: csvColumnSchema.optional(),
        counterparty: csvColumnSchema.optional(),
        /** The counterparty's account. */
        iban: csvColumnSchema.optional(),
        /** The running balance after each movement. */
        balance: csvColumnSchema.optional(),
      })
      .strict(),
    /** Where the opening and closing balances come from: the running balance column, two cells
     * of the file, or the call (`given`, each with its citation). */
    balances: z.discriminatedUnion('from', [
      z.object({ from: z.literal('column') }).strict(),
      z
        .object({ from: z.literal('cells'), opening: csvCellSchema, closing: csvCellSchema })
        .strict(),
      z.object({ from: z.literal('given') }).strict(),
    ]),
  })
  .strict()
  .superRefine((mapping, context) => {
    const { columns } = mapping;
    if (
      (columns.amount === undefined) ===
      (columns.debit === undefined || columns.credit === undefined)
    )
      context.addIssue({
        code: 'custom',
        path: ['columns'],
        message: 'Indicați fie coloana sumei, fie coloanele debit și credit.',
      });
    if (
      columns.amount !== undefined &&
      (columns.debit !== undefined || columns.credit !== undefined)
    )
      context.addIssue({
        code: 'custom',
        path: ['columns'],
        message: 'Suma se citește dintr-o coloană sau din debit și credit, nu din amândouă.',
      });
    if (mapping.balances.from === 'column' && columns.balance === undefined)
      context.addIssue({
        code: 'custom',
        path: ['balances'],
        message: 'Soldurile din coloană cer coloana soldului.',
      });
    const named = [
      columns.date,
      columns.valueDate,
      columns.amount,
      columns.debit,
      columns.credit,
      ...(columns.description ?? []),
      columns.reference,
      columns.counterparty,
      columns.iban,
      columns.balance,
    ].some((column) => typeof column === 'string');
    if (named && mapping.headerRows === 0)
      context.addIssue({
        code: 'custom',
        path: ['headerRows'],
        message: 'Coloanele numite după titlu cer un rând de titluri.',
      });
  });
export type CsvMapping = z.infer<typeof csvMappingSchema>;

/** A movement read from a CSV export, with the file's row it comes from. */
export type CsvRow = StatementRow & { row: number };
export interface ParsedCsv {
  /** The movements, oldest first. */
  rows: CsvRow[];
  /** The balances the file states (`column` or `cells`); null when they are given. */
  opening: string | null;
  closing: string | null;
}

const refuse = (code: string, message: string, details?: Record<string, string | number>) =>
  new DomainError(code, message, 422, details);

/** The file's text in the mapping's encoding; a byte that encoding does not define refuses it. */
function decode(bytes: Uint8Array, encoding: CsvMapping['encoding']) {
  let body = bytes;
  if (encoding === 'utf-8' && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    body = bytes.subarray(3);
  if (encoding === 'utf-16le' && bytes[0] === 0xff && bytes[1] === 0xfe) body = bytes.subarray(2);
  let text: string;
  try {
    text = new Decoder(encoding, { fatal: true }).decode(body);
  } catch {
    throw refuse('BANK_CSV_ENCODING', `Fișierul nu este text în codificarea ${encoding}.`);
  }
  // Single-byte decoders map their undefined bytes to C1 controls.
  requireCondition(
    !/[\u0000\u0080-\u009f]/.test(text),
    'BANK_CSV_ENCODING',
    `Fișierul nu este text în codificarea ${encoding}.`,
  );
  return text;
}

/** RFC 4180 records: fields separated by `separator`, quoted with double quotes (doubled inside),
 * records ended by CRLF, CR or LF, line breaks allowed inside quotes. */
export function csvRecords(text: string, separator: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (quoted) {
      if (character !== '"') field += character;
      else if (text[index + 1] === '"') {
        field += '"';
        index++;
      } else quoted = false;
      continue;
    }
    if (character === '"' && !wasQuoted && field.trim() === '') {
      quoted = wasQuoted = true;
      field = '';
    } else if (character === separator) {
      record.push(field);
      field = '';
      wasQuoted = false;
    } else if (character === '\r' || character === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      wasQuoted = false;
      if (character === '\r' && text[index + 1] === '\n') index++;
    } else field += character;
  }
  requireCondition(!quoted, 'BANK_CSV_QUOTE', 'Un câmp între ghilimele nu se încheie.');
  if (field !== '' || record.length) {
    record.push(field);
    records.push(record);
  }
  return records;
}

/** Text as titles are compared: without diacritics, case or repeated whitespace. */
const folded = (text: string) =>
  text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** An amount as the mapping writes it, as a 2-decimal string; null for an empty cell. */
export function csvAmount(cell: string, decimal: '.' | ','): string | null {
  let text = cell.trim().replace(/[  ]/g, ' ');
  if (!text) return null;
  // A currency next to the number (RON, EUR, lei) says nothing the account does not.
  text = text.replace(/^[A-Za-z]{3}\s*|\s*(?:[A-Za-z]{3}|lei)$/i, '').trim();
  let negative = false;
  if (/^\(.*\)$/.test(text)) [negative, text] = [true, text.slice(1, -1).trim()];
  if (/^[-+−]/.test(text))
    [negative, text] = [negative || !text.startsWith('+'), text.slice(1).trim()];
  if (/-$/.test(text)) [negative, text] = [true, text.slice(0, -1).trim()];
  const group = decimal === ',' ? '.' : ',';
  const escaped = (mark: string) => `\\${mark}`;
  const read = new RegExp(
    `^(\\d{1,3}(?:[${escaped(group)}' ]\\d{3})+|\\d+)(?:${escaped(decimal)}(\\d{1,2}))?$`,
  ).exec(text);
  if (!read)
    throw refuse(
      'BANK_CSV_AMOUNT',
      `Suma „${cell.trim()}” nu se citește cu separatorul zecimal „${decimal}”.`,
    );
  const value = new Amount(read[1]!.replace(/\D/g, '') + (read[2] ? `.${read[2]}` : ''));
  return (negative && !value.isZero() ? value.negated() : value).toFixed(2);
}

const datePatterns: Record<
  CsvMapping['dateFormat'],
  { pattern: RegExp; order: [number, number, number] }
> = {
  // order: the groups holding year, month and day
  'DD.MM.YYYY': { pattern: /^(\d{1,2})\.(\d{1,2})\.(\d{4})/, order: [3, 2, 1] },
  'DD/MM/YYYY': { pattern: /^(\d{1,2})\/(\d{1,2})\/(\d{4})/, order: [3, 2, 1] },
  'DD-MM-YYYY': { pattern: /^(\d{1,2})-(\d{1,2})-(\d{4})/, order: [3, 2, 1] },
  'YYYY-MM-DD': { pattern: /^(\d{4})-(\d{1,2})-(\d{1,2})/, order: [1, 2, 3] },
  'MM/DD/YYYY': { pattern: /^(\d{1,2})\/(\d{1,2})\/(\d{4})/, order: [3, 1, 2] },
  'DD.MM.YY': { pattern: /^(\d{1,2})\.(\d{1,2})\.(\d{2})(?!\d)/, order: [3, 2, 1] },
  YYYYMMDD: { pattern: /^(\d{4})(\d{2})(\d{2})/, order: [1, 2, 3] },
};

/** A date as the mapping writes it, as YYYY-MM-DD; a time after it is ignored. */
export function csvDate(cell: string, format: CsvMapping['dateFormat']): string {
  const text = cell.trim();
  const { pattern, order } = datePatterns[format];
  const read = pattern.exec(text);
  const rest = read ? text.slice(read[0].length) : '';
  const [year, month, day] = order.map((group) => read?.[group] ?? '');
  const date = `${year!.length === 2 ? `20${year}` : year}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}`;
  if (!read || !isLocalDate(date) || !/^(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/.test(rest))
    throw refuse('BANK_CSV_DATE', `Data „${text}” nu are forma ${format}.`);
  return date;
}

/**
 * The movements of a CSV export, oldest first, with the balances the file states. Refused,
 * naming the row, when a row does not read with the mapping, and when a running balance does not
 * follow from the previous one and the movement.
 */
export function parseBankCsv(bytes: Uint8Array, mapping: CsvMapping): ParsedCsv {
  requireCondition(
    bytes.length <= bankFileLimits.bytes,
    'BANK_FILE_LIMIT',
    'Fișierul bancar este prea mare.',
  );
  const records = csvRecords(decode(bytes, mapping.encoding), mapping.separator);
  const titles = mapping.headerRows ? (records[mapping.headerRows - 1] ?? []) : [];
  const index = (column: CsvColumn): number => {
    if (typeof column === 'number') return column - 1;
    const matches = titles.flatMap((title, at) => (folded(title) === folded(column) ? [at] : []));
    requireCondition(
      matches.length === 1,
      'BANK_CSV_COLUMN',
      matches.length
        ? `Mai multe coloane se numesc „${column}”: indicați coloana prin numărul ei.`
        : `Nicio coloană nu se numește „${column}” în rândul de titluri ${mapping.headerRows}.`,
      422,
      { column },
    );
    return matches[0]!;
  };
  const columns = mapping.columns;
  const at = {
    date: index(columns.date),
    valueDate: columns.valueDate === undefined ? null : index(columns.valueDate),
    amount: columns.amount === undefined ? null : index(columns.amount),
    debit: columns.debit === undefined ? null : index(columns.debit),
    credit: columns.credit === undefined ? null : index(columns.credit),
    description: (columns.description ?? []).map(index),
    reference: columns.reference === undefined ? null : index(columns.reference),
    counterparty: columns.counterparty === undefined ? null : index(columns.counterparty),
    iban: columns.iban === undefined ? null : index(columns.iban),
    balance: columns.balance === undefined ? null : index(columns.balance),
  };
  const last = records.length - mapping.footerRows;
  const rows: (CsvRow & { balance: string | null })[] = [];
  for (let position = mapping.headerRows; position < last; position++) {
    const record = records[position]!;
    if (record.every((cell) => !cell.trim())) continue;
    const row = position + 1;
    const cell = (column: number | null) => (column === null ? '' : (record[column] ?? '').trim());
    const text = (column: number | null) => cell(column) || null;
    try {
      let amount: string;
      if (at.amount !== null) {
        const value = csvAmount(cell(at.amount), mapping.decimal);
        if (value === null) throw refuse('BANK_CSV_AMOUNT', 'Rândul nu are sumă.');
        amount = value;
      } else {
        const debit = csvAmount(cell(at.debit), mapping.decimal);
        const credit = csvAmount(cell(at.credit), mapping.decimal);
        const out = debit !== null && !new Amount(debit).isZero();
        const into = credit !== null && !new Amount(credit).isZero();
        if (out === into)
          throw refuse(
            'BANK_CSV_AMOUNT',
            out
              ? 'Rândul are sumă și pe debit, și pe credit.'
              : 'Rândul nu are sumă pe debit sau credit.',
          );
        amount = out
          ? new Amount(debit!).abs().negated().toFixed(2)
          : new Amount(credit!).abs().toFixed(2);
      }
      if (new Amount(amount).isZero()) throw refuse('BANK_CSV_AMOUNT', 'Suma rândului este zero.');
      rows.push({
        row,
        date: csvDate(cell(at.date), mapping.dateFormat),
        valueDate:
          at.valueDate === null || !cell(at.valueDate)
            ? null
            : csvDate(cell(at.valueDate), mapping.dateFormat),
        amount,
        description: at.description.map(cell).filter(Boolean).join(' '),
        reference: text(at.reference),
        counterparty: text(at.counterparty),
        counterpartyAccount: text(at.iban)?.replace(/\s+/g, '') ?? null,
        balance: at.balance === null ? null : csvAmount(cell(at.balance), mapping.decimal),
      });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      throw refuse(error.code, `Rândul ${row}: ${error.message}`, { row });
    }
    requireCondition(
      rows.length <= bankFileLimits.entries,
      'BANK_ENTRY_LIMIT',
      'Fișierul conține prea multe înregistrări bancare.',
    );
  }
  if (mapping.order === 'newest_first') rows.reverse();

  // A running balance follows from the previous one and the movement.
  if (at.balance !== null)
    for (const [position, row] of rows.entries()) {
      requireCondition(
        row.balance !== null,
        'BANK_CSV_BALANCE',
        `Rândul ${row.row} nu are sold.`,
        422,
        { row: row.row },
      );
      const previous = rows[position - 1];
      if (previous)
        requireCondition(
          new Amount(previous.balance!).plus(row.amount).eq(row.balance!),
          'BANK_CSV_BALANCE',
          `Rândul ${row.row}: soldul ${row.balance} nu este soldul anterior ${previous.balance} plus suma ${row.amount}.`,
          422,
          { row: row.row },
        );
    }

  let opening: string | null = null;
  let closing: string | null = null;
  if (mapping.balances.from === 'column') {
    requireCondition(
      rows.length > 0,
      'BANK_CSV_EMPTY',
      'Fișierul nu are mișcări din care să se citească soldurile.',
    );
    opening = new Amount(rows[0]!.balance!).minus(rows[0]!.amount).toFixed(2);
    closing = rows.at(-1)!.balance;
  } else if (mapping.balances.from === 'cells') {
    const read = (cell: { row: number; column: number }, what: string) => {
      const record = records[cell.row > 0 ? cell.row - 1 : records.length + cell.row];
      const value = record ? csvAmount(record[cell.column - 1] ?? '', mapping.decimal) : null;
      requireCondition(
        value !== null,
        'BANK_CSV_BALANCE',
        `Celula soldului ${what} (rândul ${cell.row}, coloana ${cell.column}) este goală.`,
      );
      return value;
    };
    opening = read(mapping.balances.opening, 'inițial');
    closing = read(mapping.balances.closing, 'final');
  }
  return {
    rows: rows.map(({ balance: _balance, ...row }) => row),
    opening,
    closing,
  };
}
