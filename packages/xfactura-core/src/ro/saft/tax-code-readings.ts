import { vatTaxCodes } from './data/tax';
import {
  d406CashVatReleaseCode,
  d406DistanceCodes,
  d406DomesticReverseChargeCodes,
  d406ExemptCodes,
  d406FlatRateCodes,
  d406NonPayerSaleCode,
  d406RegimeCodes,
  d406SpecialCodes,
  d406TradeCodes,
  d406VatCodes,
  d406ZReportCode,
  releaseCodes,
  zReportCodes,
  type D406VatCodeRow,
} from './tax-codes';

/** The forward row tables and code maps this module indexes, with their original references. */
export const d406CodeReadingSources = {
  rows: [
    ['vat', d406VatCodes],
    ['domestic-reverse-charge', d406DomesticReverseChargeCodes],
    ['exempt', d406ExemptCodes],
    ['flat-rate', d406FlatRateCodes],
    ['distance', d406DistanceCodes],
    ['trade', d406TradeCodes],
    ['regime', d406RegimeCodes],
    ['special', d406SpecialCodes],
  ],
  maps: [
    ['cash-vat-release', releaseCodes, d406CashVatReleaseCode],
    ['z-report', zReportCodes, d406ZReportCode],
  ],
} as const;

type CodeMetadata = Readonly<Pick<D406VatCodeRow, 'code' | 'taxCode' | 'description'>>;

/**
 * One data-backed engine meaning of a TaxType 300 TaxCode. `source` distinguishes the forward
 * row table, a cash-VAT release, a Z report and a non-payer's sale. Row readings preserve every
 * key and the quoted D300 rows, including an explicitly empty D300 string. The maps and the
 * non-payer constant quote no D300 row, so those readings have no `d300` field. A cash-VAT
 * release has no direction: its forward function serves both collections and payments.
 */
export type D406CodeReading =
  | (Readonly<D406VatCodeRow> & {
      readonly source: (typeof d406CodeReadingSources.rows)[number][0];
    })
  | (CodeMetadata & { readonly source: 'cash-vat-release'; readonly cashVat: true })
  | (CodeMetadata & { readonly source: 'z-report'; readonly direction: 'output' })
  | (CodeMetadata & {
      readonly source: 'non-payer-sale';
      readonly direction: 'output';
      readonly code: 'O';
    });

const emptyReadings: readonly D406CodeReading[] = Object.freeze([]);
const readingsByTaxCode = new Map<string, readonly D406CodeReading[]>();

// Compare the whole reading independently of the property order of its forward row.
const identity = (reading: D406CodeReading) =>
  JSON.stringify(Object.entries(reading).sort(([left], [right]) => left.localeCompare(right)));

function addReading(reading: D406CodeReading): void {
  const existing = readingsByTaxCode.get(reading.taxCode) ?? emptyReadings;
  if (existing.some((item) => identity(item) === identity(reading))) return;
  readingsByTaxCode.set(reading.taxCode, Object.freeze([...existing, Object.freeze(reading)]));
}

for (const [source, rows] of d406CodeReadingSources.rows) {
  for (const row of rows) addReading({ source, ...row });
}

// Enumerate the maps' keys; the forward functions decide whether their TaxCodes are active.
for (const [source, codes, taxCodeOf] of d406CodeReadingSources.maps) {
  for (const code of Object.keys(codes)) {
    const taxCode = taxCodeOf(code);
    if (taxCode) {
      const metadata = { code, taxCode, description: vatTaxCodes[taxCode]!.description };
      addReading(
        source === 'cash-vat-release'
          ? { ...metadata, source, cashVat: true }
          : { ...metadata, source, direction: 'output' },
      );
    }
  }
}

addReading({
  source: 'non-payer-sale',
  direction: 'output',
  code: 'O',
  taxCode: d406NonPayerSaleCode,
  description: vatTaxCodes[d406NonPayerSaleCode]!.description,
});

/**
 * Every distinct data-backed reading of a SAF-T VAT TaxCode, without choosing between them.
 * An unknown or unmapped code returns an empty array, even if ANAF's nomenclature describes
 * it. The computed `d406UnionSchemeTax` path has no enumerable forward rows and is not indexed;
 * a TaxCode alone cannot recover its consumer state, rate or reporting policy.
 */
export function d406CodeReadings(taxCode: string): readonly D406CodeReading[] {
  return readingsByTaxCode.get(taxCode) ?? emptyReadings;
}

/** TaxCodes with more than one distinct data-backed engine reading, sorted by TaxCode. */
export const d406AmbiguousTaxCodes: readonly string[] = Object.freeze(
  [...readingsByTaxCode.keys()].filter((taxCode) => d406CodeReadings(taxCode).length > 1).sort(),
);
