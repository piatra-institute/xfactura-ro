import { describe, expect, test } from 'bun:test';
import {
  d406AmbiguousTaxCodes,
  d406CodeReadingSources,
  d406CodeReadings,
  d406InverseOnlyCodes,
  d406UnreadTaxCode,
  d406UnreadTaxCodeGroups,
} from 'xfactura-core/ro/saft/tax-code-readings';
import { vatTaxCodes } from '../src/ro/saft/data/tax';
import * as forward from '../src/ro/saft/tax-codes';
import { vatVersions } from '../src/ro/vat';

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
// The inverse-only readings: a filed code's meaning whose engine code maps forward to no code.
for (const row of d406InverseOnlyCodes) {
  addForwardEntry(row.taxCode, [
    'inverse-only',
    row.direction,
    row.code,
    row.rate,
    row.deduction,
    row.cashVat,
    row.distance,
    row.special,
    row.description,
    row.d300,
    row.reason,
  ]);
}
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
          case 'inverse-only': {
            // The forward direction keeps refusing what the filed code means.
            const { source, ...row } = reading;
            expect(source).toBe('inverse-only');
            expect(d406InverseOnlyCodes).toContainEqual(row);
            expect(forward.d406VatTaxCode(reading)).toBeUndefined();
            break;
          }
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
    // "Ajustări de taxă" at 24%, 9%, 5% and 20% (307302, 307322–307324) are the stock's and the
    // capital goods' adjustment at those rates, as at 19%, 21% and 11%.
    expect(d406AmbiguousTaxCodes).toEqual([
      '307302',
      '307321',
      '307322',
      '307323',
      '307324',
      '307329',
      '307330',
      '308302',
      '310326',
    ]);
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
      '307302': ['ADJ-304', 'ADJ-305'],
      '307321': ['ADJ-304', 'ADJ-305'],
      '307322': ['ADJ-304', 'ADJ-305'],
      '307323': ['ADJ-304', 'ADJ-305'],
      '307324': ['ADJ-304', 'ADJ-305'],
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

  test('mark each inverse-only reading, with its reason, on a code no forward row reports', () => {
    for (const row of d406InverseOnlyCodes) {
      expect(vatTaxCodes[row.taxCode]?.description).toBe(row.description);
      expect(forward.d406VatTaxCode(row)).toBeUndefined();
      // The code's only reading: an inverse-only row never shadows or joins a forward row.
      expect(d406CodeReadings(row.taxCode)).toEqual([{ source: 'inverse-only', ...row }]);
    }
    // A sale at 9% has two active codes for one engine operation, with or without VAT on
    // collection; the register has no 9% version whose interval would date them.
    const ambiguous = d406InverseOnlyCodes.filter((row) => row.reason === 'ambiguous');
    const operations = new Map<string, string[]>();
    for (const row of ambiguous) {
      const key = JSON.stringify([row.direction, row.code, row.cashVat ?? false]);
      operations.set(key, [...(operations.get(key) ?? []), row.taxCode]);
    }
    expect([...operations.values()].map((codes) => codes.sort())).toEqual([
      ['310310', '310357'],
      ['310336', '310358'],
    ]);
    expect(
      vatVersions.filter(
        (version) =>
          version.key.startsWith('ro.vat.rate') && ['9', '5'].includes(`${version.value}`),
      ),
    ).toEqual([]);
    // A payer's reverse charge at a rate other than the register's standard rates.
    const standard = vatVersions
      .filter((version) => version.key === 'ro.vat.rate' && version.scope.category === 'S')
      .map((version) => version.value);
    for (const row of d406InverseOnlyCodes.filter((item) => item.reason !== 'ambiguous')) {
      expect(row.reason).toBe('reverse-charge-rate');
      expect(forward.d406ReverseCharges).toContain(row.code);
      expect(row.special).toBeUndefined();
      expect(standard).not.toContain(row.rate);
      expect(vatTaxCodes[row.taxCode]!.percentage).toBe(row.rate!);
    }
  });

  test('read back the codes the filed journal replay refused, and their siblings at 9% and 5%', () => {
    const read = (taxCode: string) =>
      d406CodeReadings(taxCode).map((reading) => ({
        source: reading.source,
        code: reading.code,
        ...('rate' in reading && reading.rate ? { rate: reading.rate } : {}),
        ...('deduction' in reading && reading.deduction ? { deduction: reading.deduction } : {}),
        ...('cashVat' in reading && reading.cashVat ? { cashVat: true } : {}),
      }));
    expect(read('301102')).toEqual([{ source: 'vat', code: 'S-9', deduction: 'full' }]);
    expect(read('351102')).toEqual([{ source: 'vat', code: 'S-9', deduction: 'none' }]);
    expect(read('300705')).toEqual([
      { source: 'inverse-only', code: 'RC-EU-SERV', rate: '11', deduction: 'full' },
    ]);
    expect(read('350705')).toEqual([
      { source: 'inverse-only', code: 'RC-EU-SERV', rate: '11', deduction: 'none' },
    ]);
    expect(read('301103')).toEqual([{ source: 'vat', code: 'S-5', deduction: 'full' }]);
    expect(read('351103')).toEqual([{ source: 'vat', code: 'S-5', deduction: 'none' }]);
    expect(read('361102')).toEqual([{ source: 'vat', code: 'S-9', deduction: 'prorata' }]);
    expect(read('301302')).toEqual([
      { source: 'vat', code: 'S-9', deduction: 'full', cashVat: true },
    ]);
    expect(read('310311')).toEqual([{ source: 'vat', code: 'S-5' }]);
    expect(read('310310')).toEqual([{ source: 'inverse-only', code: 'S-9' }]);
    expect(read('310357')).toEqual([{ source: 'inverse-only', code: 'S-9' }]);
    expect(read('300202')).toEqual([{ source: 'trade', code: 'AIC-9', deduction: 'full' }]);
    expect(read('351203')).toEqual([{ source: 'trade', code: 'IMP-5', deduction: 'none' }]);
    expect(read('300905')).toEqual([
      { source: 'domestic-reverse-charge', code: 'TI-A-24', deduction: 'full' },
    ]);
    expect(read('307312')).toEqual([
      { source: 'exempt', code: 'ADJ-300', rate: '9', deduction: 'full' },
    ]);
    // Each new forward row reports what it reads back.
    for (const entry of [
      { direction: 'input', code: 'S-9', deduction: 'full' },
      { direction: 'input', code: 'S-9', deduction: 'none' },
      { direction: 'input', code: 'S-5', deduction: 'prorata', cashVat: true },
      { direction: 'output', code: 'S-5' },
      { direction: 'input', code: 'IMP-DEF-9', deduction: 'none' },
      { direction: 'input', code: 'RC-NONEU-SERV', rate: '5', deduction: 'none', special: true },
    ] as const) {
      const taxCode = forward.d406VatTaxCode(entry);
      expect(typeof taxCode).toBe('string');
      expect(d406CodeReadings(taxCode!).map((reading) => reading.code)).toContain(entry.code);
    }
    // A half deduction at 9% or 5% has no active code (Achizitii ded 50%, "x - Inactiv").
    for (const code of ['S-9', 'S-5'])
      expect(forward.d406VatTaxCode({ direction: 'input', code, deduction: 'half' })).toBe(
        undefined,
      );
  });

  test('cover every VAT TaxCode of the nomenclature: read, or listed once with the reason it is not', () => {
    const listed = d406UnreadTaxCodeGroups.flatMap((group) => group.codes);
    expect(new Set(listed).size).toBe(listed.length);
    for (const taxCode of listed) {
      expect(vatTaxCodes[taxCode], `${taxCode} is not a TaxCode of data/tax`).toBeDefined();
      expect(d406CodeReadings(taxCode), `${taxCode} is listed but read`).toEqual([]);
    }
    for (const taxCode of Object.keys(vatTaxCodes)) {
      const read = d406CodeReadings(taxCode).length > 0;
      const unread = d406UnreadTaxCode(taxCode);
      expect(read !== (unread !== undefined), `${taxCode}: read or listed, not both`).toBe(true);
      if (unread) expect(unread.codes).toContain(taxCode);
    }
    for (const group of d406UnreadTaxCodeGroups) {
      expect(group.what.length).toBeGreaterThan(0);
      expect(group.codes.length).toBeGreaterThan(0);
    }
    const byReason: Record<string, number> = {};
    for (const group of d406UnreadTaxCodeGroups)
      byReason[group.reason] = (byReason[group.reason] ?? 0) + group.codes.length;
    expect(byReason).toEqual({
      inactive: 100,
      regularization: 67,
      'no-engine-operation': 168,
      informative: 2,
      'union-scheme': 2,
    });
    expect(Object.keys(vatTaxCodes).length - listed.length).toBe(168);
    expect(d406UnreadTaxCode('310340')?.reason).toBe('union-scheme');
    expect(d406UnreadTaxCode('301102')).toBeUndefined();
    expect(d406UnreadTaxCode('999999')).toBeUndefined();
  });
});
