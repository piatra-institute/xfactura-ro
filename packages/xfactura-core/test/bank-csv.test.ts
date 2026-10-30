import { describe, expect, test } from 'bun:test';
import {
  csvAmount,
  csvDate,
  csvMappingSchema,
  csvRecords,
  parseBankCsv,
  type CsvMapping,
} from '../src/bank/csv';
import { checkedStatements, statementOf } from '../src/bank/statement-document';
import { DomainError } from '../src/errors';

/** Windows-1250 for the letters the tests use; the rest is ASCII. */
const cp1250: Record<string, number> = { ă: 0xe3, â: 0xe2, î: 0xee, ș: 0xba, ț: 0xfe, Ș: 0xaa };
const windows1250 = (text: string) =>
  new Uint8Array([...text].map((character) => cp1250[character] ?? character.charCodeAt(0)));
const utf8 = (text: string) => new TextEncoder().encode(text);
const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return { code: error.code, message: error.message };
    throw error;
  }
  return undefined;
};

// A synthetic export in the layout of a Romanian bank: account details, column titles, debit
// and credit columns with decimal commas, a closing line.
const export1250 = [
  'Extras de cont;RO49AAAA1B31007593840000;;;',
  'Sold inițial;;;1.000,00;',
  'Data;Descriere;Debit;Credit;Beneficiar / Plătitor',
  '05.10.2026;"Plată factura INV-1; ref. 77";100,00;;Furnizor SRL',
  '05.10.2026;Comision bancar;2,03;;',
  '10.10.2026;"Încasare client',
].join('\r\n');
const exportTail = ['linia a doua";;1.250,00;Client SRL', 'Sold final;;;2.147,97;'].join('\r\n');
const bytes1250 = windows1250(`${export1250}\r\n${exportTail}\r\n`);
const mapping1250 = csvMappingSchema.parse({
  separator: ';',
  encoding: 'windows-1250',
  dateFormat: 'DD.MM.YYYY',
  decimal: ',',
  headerRows: 3,
  footerRows: 1,
  columns: {
    date: 'Data',
    description: ['Descriere'],
    debit: 'Debit',
    credit: 'Credit',
    counterparty: 'Beneficiar / Platitor',
  },
  balances: { from: 'cells', opening: { row: 2, column: 4 }, closing: { row: -1, column: 4 } },
});

describe('CSV bank exports', () => {
  test('a Windows-1250 export with debit and credit columns reads row by row', () => {
    const parsed = parseBankCsv(bytes1250, mapping1250);
    expect(parsed.opening).toBe('1000.00');
    expect(parsed.closing).toBe('2147.97');
    expect(parsed.rows).toEqual([
      {
        row: 4,
        date: '2026-10-05',
        valueDate: null,
        amount: '-100.00',
        description: 'Plată factura INV-1; ref. 77',
        reference: null,
        counterparty: 'Furnizor SRL',
        counterpartyAccount: null,
      },
      {
        row: 5,
        date: '2026-10-05',
        valueDate: null,
        amount: '-2.03',
        description: 'Comision bancar',
        reference: null,
        counterparty: null,
        counterpartyAccount: null,
      },
      {
        row: 6,
        date: '2026-10-10',
        valueDate: null,
        amount: '1250.00',
        description: 'Încasare client\r\nlinia a doua',
        reference: null,
        counterparty: 'Client SRL',
        counterpartyAccount: null,
      },
    ]);
    // The statement it becomes passes the same checks as an MT940 or camt.053 one.
    const statement = statementOf({
      format: 'csv',
      sourceId: 'csv:2026-10-01:2026-10-31',
      bankAccount: 'RO49 AAAA 1B31 0075 9384 0000',
      currency: 'RON',
      from: '2026-10-01',
      to: '2026-10-31',
      opening: parsed.opening!,
      closing: parsed.closing!,
      rows: parsed.rows,
    });
    expect(
      checkedStatements([statement], { from: '2026-01-01', to: '2026-12-31' })[0]!.entries,
    ).toHaveLength(3);
    expect(
      refusal(() =>
        checkedStatements([{ ...statement, closing: '2147.98' }], {
          from: '2026-01-01',
          to: '2026-12-31',
        }),
      )?.code,
    ).toBe('STATEMENT_BALANCE');
  });

  test('the same bytes read as UTF-8 are refused, not guessed', () => {
    expect(
      refusal(() => parseBankCsv(bytes1250, { ...mapping1250, encoding: 'utf-8' }))?.code,
    ).toBe('BANK_CSV_ENCODING');
  });

  test('a running balance column gives the balances and is checked row by row, newest first', () => {
    const mapping = csvMappingSchema.parse({
      separator: ',',
      encoding: 'utf-8',
      dateFormat: 'YYYY-MM-DD',
      decimal: '.',
      headerRows: 1,
      order: 'newest_first',
      columns: { date: 1, amount: 3, description: [2], reference: 4, balance: 5 },
      balances: { from: 'column' },
    });
    const csv = (balance: string) =>
      utf8(
        [
          'Date,Details,Amount,Reference,Balance',
          `2026-10-10 09:15:00,Card payment,-20.50,TX-3,${balance}`,
          '2026-10-06,Transfer in,"1,000.00",TX-2,1079.50',
          '2026-10-05,Fee,-0.50,TX-1,79.50',
        ].join('\n'),
      );
    const parsed = parseBankCsv(csv('1059.00'), mapping);
    expect(parsed.rows.map((row) => [row.date, row.amount, row.reference])).toEqual([
      ['2026-10-05', '-0.50', 'TX-1'],
      ['2026-10-06', '1000.00', 'TX-2'],
      ['2026-10-10', '-20.50', 'TX-3'],
    ]);
    expect([parsed.opening, parsed.closing]).toEqual(['80.00', '1059.00']);
    expect(refusal(() => parseBankCsv(csv('1060.00'), mapping))).toEqual({
      code: 'BANK_CSV_BALANCE',
      message: 'Rândul 2: soldul 1060.00 nu este soldul anterior 1079.50 plus suma -20.50.',
    });
  });

  test('amounts, dates and quoted fields read strictly', () => {
    expect(csvAmount('(1.234,56)', ',')).toBe('-1234.56');
    expect(csvAmount('12,00-', ',')).toBe('-12.00');
    expect(csvAmount('1 234,5 RON', ',')).toBe('1234.50');
    expect(csvAmount('', ',')).toBeNull();
    expect(refusal(() => csvAmount('12,345', ','))?.code).toBe('BANK_CSV_AMOUNT');
    expect(refusal(() => csvAmount('1.234,56', '.'))?.code).toBe('BANK_CSV_AMOUNT');
    expect(csvDate('5.3.26', 'DD.MM.YY')).toBe('2026-03-05');
    expect(csvDate('03/05/2026', 'MM/DD/YYYY')).toBe('2026-03-05');
    expect(refusal(() => csvDate('31.02.2026', 'DD.MM.YYYY'))?.code).toBe('BANK_CSV_DATE');
    expect(refusal(() => csvDate('2026-03-05 extra', 'YYYY-MM-DD'))?.code).toBe('BANK_CSV_DATE');
    expect(csvRecords('a;"b;""c""";d\r\ne', ';')).toEqual([['a', 'b;"c"', 'd'], ['e']]);
    expect(refusal(() => csvRecords('a;"b', ';'))?.code).toBe('BANK_CSV_QUOTE');
  });

  test('a mapping names its columns once and its rows refuse with their number', () => {
    expect(
      csvMappingSchema.safeParse({
        ...mapping1250,
        columns: { date: 1, amount: 2, debit: 3, credit: 4 },
      }).success,
    ).toBe(false);
    expect(csvMappingSchema.safeParse({ ...mapping1250, headerRows: 0 }).success).toBe(false);
    const unknown: CsvMapping = {
      ...mapping1250,
      columns: { ...mapping1250.columns, date: 'Data valutei' },
    };
    expect(refusal(() => parseBankCsv(bytes1250, unknown))?.code).toBe('BANK_CSV_COLUMN');
    const both = windows1250(
      export1250.replace('100,00;;Furnizor', '100,00;5,00;Furnizor') + `\r\n${exportTail}`,
    );
    expect(refusal(() => parseBankCsv(both, mapping1250))).toEqual({
      code: 'BANK_CSV_AMOUNT',
      message: 'Rândul 4: Rândul are sumă și pe debit, și pe credit.',
    });
  });
});
