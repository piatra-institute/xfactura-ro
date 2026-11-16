import { describe, expect, test } from 'bun:test';
import {
  d406AmbiguousTaxCodes,
  d406CodeReadingSources,
  d406CodeReadings,
} from 'xfactura-core/ro/saft/tax-code-readings';
import { vatTaxCodes } from '../src/ro/saft/data/tax';
import * as forward from '../src/ro/saft/tax-codes';

function isRowTable(value: unknown): value is readonly forward.D406VatCodeRow[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (row: unknown) =>
        typeof row === 'object' &&
        row !== null &&
        'taxCode' in row &&
        typeof row.taxCode === 'string',
    )
  );
}

function isCodeMap(value: unknown): value is Readonly<Record<string, string>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((code) => typeof code === 'string')
  );
}

const forwardExports = Object.entries(forward);
const rowTables = forwardExports.flatMap(([name, value]) =>
  isRowTable(value) ? [[name, value] as const] : [],
);
const codeMaps = forwardExports.flatMap(([name, value]) =>
  isCodeMap(value) ? [[name, value] as const] : [],
);

// Count distinct forward entries without consulting the reverse module or its source registry.
const forwardEntriesByTaxCode = new Map<string, Set<string>>();
function addForwardEntry(taxCode: string, identity: readonly unknown[]): void {
  const entries = forwardEntriesByTaxCode.get(taxCode) ?? new Set<string>();
  entries.add(JSON.stringify(identity));
  forwardEntriesByTaxCode.set(taxCode, entries);
}

for (const [name, rows] of rowTables) {
  for (const row of rows) {
    addForwardEntry(row.taxCode, [
      name,
      row.direction,
      row.code,
      row.rate,
      row.deduction,
      row.cashVat,
      row.distance,
      row.special,
      row.description,
      row.d300,
    ]);
  }
}
for (const [name, codes] of codeMaps) {
  for (const [code, taxCode] of Object.entries(codes)) addForwardEntry(taxCode, [name, code]);
}
addForwardEntry(forward.d406NonPayerSaleCode, ['non-payer-sale', 'output', 'O']);
const mappedTaxCodes = new Set(forwardEntriesByTaxCode.keys());

describe('D406 VAT TaxCode readings', () => {
  test('index every exported forward row table and string-to-string code map', () => {
    expect(
      forwardExports
        .filter(([, value]) => d406CodeReadingSources.rows.some(([, rows]) => rows === value))
        .map(([name]) => name)
        .sort(),
    ).toEqual(rowTables.map(([name]) => name).sort());
    expect(
      forwardExports
        .filter(([, value]) => d406CodeReadingSources.maps.some(([, codes]) => codes === value))
        .map(([name]) => name)
        .sort(),
    ).toEqual(codeMaps.map(([name]) => name).sort());
  });

  for (const [name, rows] of rowTables) {
    test(`include every ${name} row with all of its keys and quoted metadata`, () => {
      const indexedTable = d406CodeReadingSources.rows.find(([, indexed]) => indexed === rows);
      if (!indexedTable) throw new Error(`${name} is not indexed by d406CodeReadingSources`);
      for (const row of rows) {
        expect(
          forward.d406VatTaxCode(row),
          `${name}: ${row.direction} ${row.code} has a shadowed or unsupported row for ${row.taxCode}`,
        ).toBe(row.taxCode);
        expect(d406CodeReadings(row.taxCode)).toContainEqual({
          source: indexedTable[0],
          ...row,
        });
      }
    });
  }

  test('include every cash-VAT release map entry without inventing its direction or D300 rows', () => {
    for (const [code, taxCode] of Object.entries(forward.releaseCodes)) {
      expect(forward.d406CashVatReleaseCode(code)).toBe(taxCode);
      expect(d406CodeReadings(taxCode)).toContainEqual({
        source: 'cash-vat-release',
        code,
        taxCode,
        cashVat: true,
        description: vatTaxCodes[taxCode]!.description,
      });
    }
  });

  test('include every Z-report map entry as a sale separate from the invoice tables', () => {
    for (const [code, taxCode] of Object.entries(forward.zReportCodes)) {
      expect(forward.d406ZReportCode(code)).toBe(taxCode);
      expect(d406CodeReadings(taxCode)).toContainEqual({
        source: 'z-report',
        direction: 'output',
        code,
        taxCode,
        description: vatTaxCodes[taxCode]!.description,
      });
    }
  });

  test('include the non-payer sale constant as O, separate from the exempt sale row', () => {
    expect(d406CodeReadings(forward.d406NonPayerSaleCode)).toContainEqual({
      source: 'non-payer-sale',
      direction: 'output',
      code: 'O',
      taxCode: forward.d406NonPayerSaleCode,
      description: vatTaxCodes[forward.d406NonPayerSaleCode]!.description,
    });
    expect(forward.d406VatTaxCode({ direction: 'output', code: 'O' })).toBeUndefined();
  });

  test('every returned reading maps forward through its own reporting path to the queried TaxCode', () => {
    let count = 0;
    for (const taxCode of new Set([...Object.keys(vatTaxCodes), ...mappedTaxCodes])) {
      for (const reading of d406CodeReadings(taxCode)) {
        count++;
        expect(reading.taxCode).toBe(taxCode);
        switch (reading.source) {
          case 'cash-vat-release':
            expect(forward.d406CashVatReleaseCode(reading.code)).toBe(taxCode);
            break;
          case 'z-report':
            expect(forward.d406ZReportCode(reading.code)).toBe(taxCode);
            break;
          case 'non-payer-sale':
            expect(reading.direction).toBe('output');
            expect(reading.code).toBe('O');
            expect(forward.d406NonPayerSaleCode).toBe(taxCode);
            break;
          default:
            expect(forward.d406VatTaxCode(reading)).toBe(taxCode);
        }
      }
    }
    expect(count).toBe(
      [...forwardEntriesByTaxCode.values()].reduce((total, entries) => total + entries.size, 0),
    );
  });

  test('pin every ambiguity and all of its engine codes without resolving any of them', () => {
    expect(d406AmbiguousTaxCodes).toEqual(['307321', '307329', '307330', '308302', '310326']);
    expect(
      Object.fromEntries(
        d406AmbiguousTaxCodes.map((taxCode) => [
          taxCode,
          d406CodeReadings(taxCode)
            .map((reading) => reading.code)
            .sort(),
        ]),
      ),
    ).toEqual({
      '307321': ['ADJ-304', 'ADJ-305'],
      '307329': ['ADJ-304', 'ADJ-305'],
      '307330': ['ADJ-304', 'ADJ-305'],
      '308302': ['EX-IN', 'O'],
      '310326': ['EX-292', 'O'],
    });
  });

  test('derive the expected ambiguities independently from distinct forward entries', () => {
    const expected = [...forwardEntriesByTaxCode]
      .filter(([, entries]) => entries.size > 1)
      .map(([taxCode]) => taxCode)
      .sort();
    expect(d406AmbiguousTaxCodes).toEqual(expected);
  });

  test('do not infer readings from ANAF descriptions when no forward row or map entry exists', () => {
    for (const taxCode of Object.keys(vatTaxCodes)) {
      if (!mappedTaxCodes.has(taxCode)) expect(d406CodeReadings(taxCode)).toEqual([]);
    }
    for (const taxCode of [
      '',
      '000000',
      '999999',
      '361304',
      '310344 ',
      ' 310344',
      '0310344',
      '__proto__',
      'toString',
    ]) {
      expect(d406CodeReadings(taxCode)).toEqual([]);
    }
  });

  test('leave the computed Union-scheme path unindexed rather than fabricate a forward row', () => {
    for (const code of ['310340', '310325'] as const) {
      for (const country of ['consumer', 'RO'] as const) {
        const tax = forward.d406UnionSchemeTax({ code, country }, { state: 'EL', rate: '24' });
        expect(tax.taxCode).toBe(code);
        expect(d406CodeReadings(tax.taxCode)).toEqual([]);
        expect(forward.d406VatTaxCode({ direction: 'output', code: 'EXP-OSS' })).toBeUndefined();
      }
    }
    for (const taxCode of forward.d406MemberStateRateCodes) {
      expect(d406CodeReadings(taxCode)).toEqual([]);
    }
  });
});
