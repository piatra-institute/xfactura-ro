import { z } from 'zod';
import { requireCondition } from '../errors';
import { canonical, sha256Hex as sha256 } from '../hash';
import { isSupportedCurrency } from '../money';
import { addDays, parseLocalDate } from '../time';
import { Amount, dateSchema, signedMoneySchema } from '../values';

export const bankFileLimits = Object.freeze({
  bytes: 2_000_000,
  statements: 100,
  entries: 2000,
  detailsPerEntry: 200,
});
/** Where a statement comes from: the bank's MT940 or camt.053 file, a CSV export parsed with a
 * column mapping (`bank.importCsv`), or a statement an agent transcribed from a PDF or a photo,
 * citing each row (`bank.recordStatement`). */
export const bankFileFormat = z.enum(['mt940', 'camt.053', 'csv', 'transcribed']);
export const bankFileParserVersion = 'bank-statement-1' as const;
const optionalText = z.string().max(500).nullable();
export const bankEntrySchema = z
  .object({
    ordinal: z
      .number()
      .int()
      .min(0)
      .max(bankFileLimits.entries - 1),
    date: dateSchema,
    valueDate: dateSchema.nullable(),
    bookingDateTime: optionalText,
    valueDateTime: optionalText,
    amount: signedMoneySchema,
    reference: z.string().max(8000),
    bankReference: optionalText,
    entryReference: optionalText,
    customerReference: optionalText,
    transactionCode: z.string().max(1000),
    reversal: z.boolean(),
    raw: z.string().max(16000).nullable(),
    charges: z
      .array(
        z
          .object({
            amount: signedMoneySchema,
            scope: z.enum(['entry', 'transaction']),
            kind: z.string().min(1).max(100),
          })
          .strict(),
      )
      .max(400),
    details: z
      .array(
        z
          .object({
            references: z.record(z.string().max(100), z.string().max(500)),
            amount: signedMoneySchema.nullable(),
            remittance: z.array(z.string().max(1000)).max(100),
            debtor: optionalText,
            creditor: optionalText,
            debtorAccount: optionalText,
            creditorAccount: optionalText,
          })
          .strict(),
      )
      .max(bankFileLimits.detailsPerEntry),
  })
  .strict();
export const bankStatementDocumentSchema = z
  .object({
    ordinal: z
      .number()
      .int()
      .min(0)
      .max(bankFileLimits.statements - 1),
    format: bankFileFormat,
    sourceId: z.string().min(1).max(200),
    messageId: z.string().max(200).nullable(),
    sequence: z.string().max(100).nullable(),
    bankAccount: z.string().min(15).max(34),
    currency: z.string().refine((code): boolean => isSupportedCurrency(code)),
    from: dateSchema,
    to: dateSchema,
    openingDate: dateSchema,
    closingDate: dateSchema,
    opening: signedMoneySchema,
    closing: signedMoneySchema,
    reportedFrom: optionalText,
    reportedTo: optionalText,
    entries: z.array(bankEntrySchema).max(bankFileLimits.entries),
  })
  .strict();
export type BankEntryDocument = z.infer<typeof bankEntrySchema>;
export type BankStatementDocument = z.infer<typeof bankStatementDocumentSchema>;
/** A statement `checkedStatements` accepted: the only kind the engine records. */
export type CheckedStatement = BankStatementDocument & { readonly __checked: unique symbol };
const uuid = z.uuid();
export const storedBankEntrySchema = bankEntrySchema
  .extend({
    id: uuid,
    movementId: uuid,
    sourceId: z.string().min(1).max(100),
    identityBasis: z.enum(['bank_reference', 'statement_entry']),
  })
  .strict();
export const storedBankStatementSchema = bankStatementDocumentSchema
  .omit({ bankAccount: true, entries: true })
  .extend({
    id: uuid,
    statementId: uuid,
    bankAccount: z.string().min(4).max(50),
    sourceAccount: z.string().min(15).max(34),
    financialHash: z.string().regex(/^[a-f0-9]{64}$/),
    entries: z.array(storedBankEntrySchema).max(bankFileLimits.entries),
  })
  .strict();
export type StoredBankStatement = z.infer<typeof storedBankStatementSchema>;
export type StoredBankEntry = z.infer<typeof storedBankEntrySchema>;

export function canonicalBankAccount(value: string) {
  return value.replace(/ /g, '').toUpperCase();
}
export function bankAccount(value: string) {
  const id = canonicalBankAccount(value);
  requireCondition(
    /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(id) && (!id.startsWith('RO') || id.length === 24),
    'BANK_ACCOUNT',
    'Extrasul trebuie să identifice un IBAN valid.',
  );
  let mod = 0;
  for (const char of id.slice(4) + id.slice(0, 4)) {
    const digits = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of digits) mod = (mod * 10 + Number(digit)) % 97;
  }
  requireCondition(mod === 1, 'BANK_ACCOUNT', 'Cifra de control a IBAN-ului nu corespunde.');
  return id;
}
export function bankNumber(value: string, separator: '.' | ',' = '.') {
  requireCondition(
    (separator === ',' ? /^\d{1,16},\d{0,2}$/ : /^\d{1,16}(?:\.\d{1,2})?$/).test(value),
    'BANK_AMOUNT',
    'Suma bancară trebuie exprimată exact în bani, fără rotunjire implicită.',
  );
  return new Amount(value.replace(',', '.')).toFixed(2);
}
export function signedBankAmount(amount: string, indicator: string) {
  requireCondition(
    indicator === 'CRDT' || indicator === 'DBIT',
    'BANK_DIRECTION',
    'Indicator debit/credit invalid.',
  );
  return new Amount(amount).mul(indicator === 'DBIT' ? -1 : 1).toFixed(2);
}
export function meaningfulReference(value: string | null) {
  return value && !/^(?:NONREF|NOREF|NOTPROVIDED|NOT PROVIDED|N\/A)$/i.test(value) ? value : null;
}
export function entrySourceId(statement: BankStatementDocument, entry: BankEntryDocument) {
  const ref = meaningfulReference(entry.bankReference);
  return ref
    ? `bank:${sha256(canonical([statement.bankAccount, ref, entry.reversal]))}`
    : `entry:${sha256(
        canonical([
          statement.bankAccount,
          statement.format,
          statement.sourceId,
          statement.to.slice(0, 4),
          meaningfulReference(entry.entryReference) ?? [
            entry.ordinal,
            entry.date,
            entry.amount,
            entry.reference,
          ],
        ]),
      )}`;
}
export function statementFinancialHash(statement: BankStatementDocument) {
  return sha256(
    canonical({
      account: statement.bankAccount,
      from: statement.from,
      to: statement.to,
      opening: statement.opening,
      closing: statement.closing,
      entries: statement.entries
        .map((entry) => ({
          sourceId: entrySourceId(statement, entry),
          date: entry.date,
          amount: entry.amount,
        }))
        .sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0)),
    }),
  );
}
/** A statement's movement as a CSV row or a transcription gives it. */
export interface StatementRow {
  date: string;
  valueDate: string | null;
  /** Signed: money in is positive. */
  amount: string;
  description: string;
  /** The bank's own reference of the movement, when the source has one. */
  reference: string | null;
  counterparty: string | null;
  counterpartyAccount: string | null;
}

/**
 * A statement of one account from rows a CSV export or a transcription gives, in the form the
 * MT940 and camt.053 parsers produce, so that the same checks (`checkedStatements`) and the same
 * recording (`recordStatements`) apply. It covers `from` to `to`; the opening balance is dated
 * `from`.
 */
export function statementOf(input: {
  format: 'csv' | 'transcribed';
  sourceId: string;
  bankAccount: string;
  currency: string;
  from: string;
  to: string;
  opening: string;
  closing: string;
  rows: StatementRow[];
}): BankStatementDocument {
  requireCondition(
    input.rows.length <= bankFileLimits.entries,
    'BANK_ENTRY_LIMIT',
    'Extrasul conține prea multe înregistrări bancare.',
  );
  return bankStatementDocumentSchema.parse({
    ordinal: 0,
    format: input.format,
    sourceId: input.sourceId,
    messageId: null,
    sequence: null,
    bankAccount: canonicalBankAccount(input.bankAccount),
    currency: input.currency,
    from: input.from,
    to: input.to,
    openingDate: input.from,
    closingDate: input.to,
    opening: input.opening,
    closing: input.closing,
    reportedFrom: null,
    reportedTo: null,
    entries: input.rows.map((row, ordinal) => {
      const incoming = !row.amount.startsWith('-');
      return {
        ordinal,
        date: row.date,
        valueDate: row.valueDate,
        bookingDateTime: null,
        valueDateTime: null,
        amount: row.amount,
        reference: row.description.slice(0, 8000),
        bankReference: row.reference?.slice(0, 500) ?? null,
        entryReference: null,
        customerReference: null,
        transactionCode: '',
        reversal: false,
        raw: null,
        charges: [],
        details: [
          {
            references: {},
            amount: null,
            remittance: row.description
              ? (row.description.match(/[\s\S]{1,1000}/g) ?? []).slice(0, 100)
              : [],
            debtor: incoming ? (row.counterparty?.slice(0, 500) ?? null) : null,
            creditor: incoming ? null : (row.counterparty?.slice(0, 500) ?? null),
            debtorAccount: incoming ? (row.counterpartyAccount?.slice(0, 500) ?? null) : null,
            creditorAccount: incoming ? null : (row.counterpartyAccount?.slice(0, 500) ?? null),
          },
        ],
      };
    }),
  });
}

export function checkedStatements(
  input: BankStatementDocument[],
  year: { from: string; to: string },
): CheckedStatement[] {
  requireCondition(
    input.length > 0 && input.length <= bankFileLimits.statements,
    'BANK_STATEMENT_LIMIT',
    'Număr de extrase neacceptat.',
  );
  let count = 0;
  const ids = new Set<string>();
  return input.map((value) => {
    const statement = bankStatementDocumentSchema.parse(value);
    requireCondition(
      statement.from <= statement.to &&
        statement.openingDate <= statement.from &&
        statement.closingDate === statement.to &&
        statement.to >= year.from &&
        statement.to <= year.to &&
        statement.entries.every(
          (entry) =>
            entry.date >= statement.from &&
            entry.date <= statement.to &&
            entry.date >= year.from &&
            entry.date <= year.to &&
            !new Amount(entry.amount).isZero(),
        ),
      'BANK_STATEMENT_DATE',
      'Extrasul și datele de înregistrare nu corespund exercițiului sau intervalului raportat.',
    );
    requireCondition(
      (count += statement.entries.length) <= bankFileLimits.entries,
      'BANK_ENTRY_LIMIT',
      'Fișierul conține prea multe înregistrări bancare.',
    );
    const sourceIds = statement.entries.map((entry) => entrySourceId(statement, entry));
    requireCondition(
      new Set(sourceIds).size === sourceIds.length,
      'DUPLICATE_BANK_ENTRY',
      'Identificator bancar duplicat în același extras.',
    );
    const id = canonical([statement.bankAccount, statement.sourceId]);
    requireCondition(
      !ids.has(id),
      'DUPLICATE_BANK_STATEMENT',
      'Același extras apare de mai multe ori în fișier.',
    );
    ids.add(id);
    requireCondition(
      statement.entries
        .reduce((sum, entry) => sum.plus(entry.amount), new Amount(statement.opening))
        .eq(statement.closing),
      'STATEMENT_BALANCE',
      'Soldul inițial plus înregistrările diferă de soldul contabil final.',
    );
    return statement as CheckedStatement;
  });
}

/*
 * Statements of one account in sequence.
 *
 * A statement covers the days from its opening-balance date (`from`) to its closing date (`to`).
 * Banks date the opening balance two ways: with the first day reported (a daily MT940 opening and
 * closing on the same date, a monthly camt.053 opening on the 1st), or, as SWIFT describes field
 * 60F, with the previous statement's closing date. In the second, consecutive statements share
 * that date: the later one hands over from the earlier, reporting nothing on it.
 */

/** A statement's days, as the overlap and continuity rules read them. */
export type StatementSpan = {
  from: string;
  to: string;
  /** Whether it reports a movement booked on `from`. */
  movesOnFrom: boolean;
};

/**
 * Whether `later` takes over on the day `earlier` closes: it opens on that date, reports nothing
 * on it and covers at least one more day. Its opening balance is then `earlier`'s closing.
 */
export function handsOver(earlier: StatementSpan, later: StatementSpan) {
  return earlier.to === later.from && later.from < later.to && !later.movesOnFrom;
}

/** Whether two statements of one account report a day twice. */
export function statementsOverlap(a: StatementSpan, b: StatementSpan) {
  return a.from <= b.to && b.from <= a.to && !handsOver(a, b) && !handsOver(b, a);
}

/**
 * Whether `later` follows `earlier` with no day between them, so its opening balance must be
 * `earlier`'s closing. Otherwise days are missing between them, and so may be the movements that
 * explain a difference.
 */
export function statementsAdjoin(earlier: StatementSpan, later: StatementSpan) {
  return handsOver(earlier, later) || addDays(parseLocalDate(earlier.to), 1) === later.from;
}
