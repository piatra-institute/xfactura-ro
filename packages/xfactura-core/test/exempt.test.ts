import { describe, expect, test } from 'bun:test';
import type { LocalDate } from '../src/time';
import {
  agent,
  definitiveProrata,
  exemptionBases,
  exemptionBasisIds,
  exemptVersions,
  initialShare,
  prorataAdjustments,
  prorataCapitalGoodAdjustment,
  prorataFact,
  prorataShare,
  provisionalProrata,
  reasonAgrees,
  remainingAdjustment,
  shareOf,
  stockVat,
  transitionalOf,
  unusedServiceVat,
  useAdjustment,
  yearAdjustment,
  type CapitalGoodBasis,
} from '../src/ro/exempt';
import { questionKindIds } from '../src/questions/kinds';
import { d406ExemptCodes, d406VatTaxCode } from '../src/ro/saft/tax-codes';
import { vatTaxCodes } from '../src/ro/saft/data/tax';
import { citationProblems } from '../src/ro/sources';

// Amounts from the examples of the methodological norms (title VII pct. 79 alin. (15)–(16)) and
// synthetic ones computed by hand.
const rule = { movable: 5, immovable: 20, row: 'R31_2' as const, expense: '635', income: '7588' };
const building = (vat: string, deducted: string, acquiredOn: string): CapitalGoodBasis => ({
  assetId: 'a',
  number: 'MF-1',
  name: 'Clădire',
  immovable: true,
  acquiredOn: acquiredOn as LocalDate,
  vatBani: BigInt(vat) * 100n,
  deductedBani: BigInt(deducted) * 100n,
});

describe('the definitive pro-rata (art. 300 alin. (6)–(8))', () => {
  test('rounds the ratio up to the next whole percent, keeping a whole one', () => {
    const at = (withDeduction: bigint, withoutDeduction: bigint) =>
      definitiveProrata({ withDeduction, withoutDeduction, subsidies: 0n, excluded: 0n });
    expect(at(60_000_000n, 40_000_000n)).toMatchObject({ percent: 60, exact: '60.0000' });
    // 60,1%: 61%.
    expect(at(60_100_000n, 39_900_000n)).toMatchObject({ percent: 61, exact: '60.1000' });
    // 0,01% is still rounded up to 1%.
    expect(at(1n, 9_999n)?.percent).toBe(1);
    expect(at(0n, 1_000n)?.percent).toBe(0);
    expect(at(0n, 0n)).toBeNull();
    // Budget sums of alin. (6) lit. b) are in the denominator only.
    expect(
      definitiveProrata({
        withDeduction: 50_000n,
        withoutDeduction: 25_000n,
        subsidies: 25_000n,
        excluded: 0n,
      })?.percent,
    ).toBe(50);
  });

  test("adjusts the year's VAT of mixed purchases to it, per code", () => {
    // 10.500 lei of VAT, 50% deducted provisionally: 60% definitive deducts 6.300, 1.050 more.
    expect(
      prorataAdjustments([{ code: 'S-21', vatBani: 1_050_000n, deductedBani: 525_000n }], 60),
    ).toMatchObject([{ code: 'S-21', definitiveBani: 630_000n, bani: 105_000n }]);
    expect(prorataShare(1_001n, 50)).toBe(501n);
  });

  test('a capital good deducted under it, in the later years (alin. (15); pct. 79 alin. (16))', () => {
    // 40.000 lei VAT, 30% definitive in its first year (12.000 deducted); 2017 at 50%: 1.600 more.
    const good = {
      assetId: 'u',
      number: 'U-1',
      vatBani: 4_000_000n,
      deductedBani: 1_200_000n,
      years: 5,
    };
    expect(prorataCapitalGoodAdjustment(good, 50).bani).toBe(160_000n);
    // 2018 at 20%: 800 lei less.
    expect(prorataCapitalGoodAdjustment(good, 20).bani).toBe(-80_000n);
  });

  test('the provisional pro-rata is the year’s fact; an earlier year’s does not carry', () => {
    const facts = [{ axis: 'vat.prorata', value: '62', effectiveFrom: '2025-01-01' as LocalDate }];
    expect(provisionalProrata(facts, '2025-06-30' as LocalDate)).toMatchObject({
      found: true,
      fact: { kind: 'percent', percent: 62 },
    });
    expect(provisionalProrata(facts, '2026-06-30' as LocalDate)).toMatchObject({
      found: false,
      reason: 'earlier_year',
    });
    expect(prorataFact('special')).toEqual({ kind: 'special' });
    expect(prorataFact('101')).toBeNull();
  });
});

describe('capital goods in the general case (art. 305; norme pct. 79)', () => {
  test('a change of use adjusts the year’s twentieth at the new share (exemplele 4–5)', () => {
    // 6.000.000 lei deducted in full; 40% leased exempt: 120.000 lei in favour of the state.
    const deducted = building('6000000', '6000000', '2009-03-10');
    expect(yearAdjustment(deducted, 20, shareOf('60')!)).toBe(-12_000_000n);
    // 3.000.000 lei not deducted; 40% moved to taxable use: 60.000 lei in favour of the company.
    const exempt = building('3000000', '0', '2010-03-10');
    expect(useAdjustment(exempt, 2017, shareOf('40')!, 0n, rule).bani).toBe(6_000_000n);
    // An adjustment already made in the year counts: the year is adjusted once.
    expect(useAdjustment(exempt, 2017, shareOf('40')!, 6_000_000n, rule).bani).toBe(0n);
    expect(useAdjustment(exempt, 2031, shareOf('40')!, 0n, rule).years).toBe(0);
  });

  test('an exempt supply adjusts the period left at once (exemplul 1)', () => {
    // 5.000.000 lei deducted, bought in 2010, supplied exempt in 2016: 14 twentieths.
    const good = building('5000000', '5000000', '2010-08-10');
    expect(remainingAdjustment(good, 2016, 0, 0n, rule)).toMatchObject({
      years: 14,
      bani: -350_000_000n,
    });
    // A taxable supply after no deduction: at most the VAT collected.
    const limited = building('100000', '0', '2024-02-01');
    expect(remainingAdjustment(limited, 2026, 10_000, 0n, rule, 1_000_000n).bani).toBe(1_000_000n);
  });

  test('the initial share, the assets bought before 2016 (art. 306)', () => {
    expect(initialShare({ vatBani: 1_000n, deductedBani: 500n })).toBe(5_000);
    const movable = { ...building('1000', '1000', '2014-05-01'), immovable: false };
    expect(
      transitionalOf(movable, { value: 100n, depreciated: 100n, fiscalLifeMonths: 36 }, 2026, rule),
    ).toEqual({ kind: 'expired' });
    expect(
      transitionalOf(movable, { value: 100n, depreciated: 40n, fiscalLifeMonths: 36 }, 2026, rule),
    ).toEqual({ kind: 'ART306' });
    expect(
      transitionalOf(movable, { value: 100n, depreciated: 40n, fiscalLifeMonths: 96 }, 2026, rule),
    ).toEqual({ kind: 'expired' });
    expect(
      transitionalOf(
        building('1', '1', '2005-01-01'),
        { value: 1n, depreciated: 0n, fiscalLifeMonths: 600 },
        2026,
        rule,
      ),
    ).toEqual({ kind: 'ART332' });
    expect(
      transitionalOf(
        building('1', '1', '2010-01-01'),
        { value: 1n, depreciated: 0n, fiscalLifeMonths: 600 },
        2026,
        rule,
      ),
    ).toEqual({ kind: 'art305' });
  });

  test('stock at its acquisition rate, a service not used by its value left (art. 304)', () => {
    expect(stockVat({ account: '371', valueBani: 1_000_000n, rate: '21' })).toBe(210_000n);
    expect(stockVat({ account: '371', valueBani: 1_000_000n, rate: '0' })).toBe(0n);
    expect(unusedServiceVat(210_000n, { value: 1_000_000n, depreciated: 250_000n })).toBe(157_500n);
  });
});

describe('exemptions', () => {
  test('a sale names its basis; the VATEX code must agree', () => {
    expect(reasonAgrees('art.292(2)(e)', 'VATEX-EU-135-1')).toBe('agrees');
    expect(reasonAgrees('art.292(1)', 'VATEX-EU-132-1B')).toBe('agrees');
    expect(reasonAgrees('art.292(1)', 'VATEX-EU-135-1')).toBe('contradicts');
    expect(reasonAgrees('art.294(2)(a)', 'VATEX-EU-IC')).toBe('agrees');
    expect(reasonAgrees('art.292(2)(b)', 'VATEX-EU-O')).toBe('other');
    expect(reasonAgrees('art.292(2)(b)', 'Scutit conform art. 292 alin. (2) lit. b)')).toBe('text');
    expect(reasonAgrees('art.292(2)(b)', null)).toBe('missing');
    for (const id of exemptionBasisIds) {
      const basis = exemptionBases[id];
      expect(basis.deduction).toBe(basis.code !== 'EX-292');
    }
  });

  test('every exempt code has its SAF-T code, from the pinned nomenclature', () => {
    for (const row of d406ExemptCodes) {
      const code = vatTaxCodes[row.taxCode]!;
      expect(code.description).toBe(row.description);
      expect(code.kind).toBe(row.direction === 'output' ? 'sales' : 'purchases');
      expect(code.percentage).toBe(row.rate ?? '0');
    }
    expect(d406VatTaxCode({ direction: 'output', code: 'EX-292' })).toBe('310326');
    expect(d406VatTaxCode({ direction: 'input', code: 'EX-IN', deduction: 'full' })).toBe('308302');
    expect(
      d406VatTaxCode({ direction: 'input', code: 'ADJ-300', rate: '21', deduction: 'full' }),
    ).toBe('307327');
    expect(
      d406VatTaxCode({ direction: 'input', code: 'ADJ-305', rate: '21', deduction: 'full' }),
    ).toBe('307329');
  });

  test('the module is agent-ready and cites registered clauses', () => {
    expect(citationProblems(exemptVersions)).toEqual([]);
    for (const question of agent.questions)
      expect(questionKindIds as readonly string[]).toContain(question.kind);
    expect(agent.detectors.map((item) => item.kind)).toEqual(['vat.prorata', 'vat.capitalGoods']);
    expect(agent.templates).toEqual(['invoices.recognize.deduction']);
  });
});
