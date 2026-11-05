/*
 * The tax codes of goods across the border (G3), as the books' tax entries carry them; the
 * returns derive their rows from them. Each code holds its rate, so a D300 row, a D390 type and a
 * SAF-T code follow from the code alone:
 * - `AIC-<rate>`: an intra-community acquisition of goods, its VAT self-assessed (art. 307 alin.
 *   (1) read with art. 326 alin. (2)): output on D300 rd. 5 (and 5.1 from a supplier registered in
 *   the Member State of dispatch), input on rd. 20 (20.1), D390 type A;
 * - `IMP-<rate>`: the VAT of an import paid at customs (art. 326 alin. (3)): input, rd. 24 or 25;
 * - `IMP-DEF-<rate>`: the VAT of an import not paid at customs (art. 326 alin. (4)–(5)): output on
 *   rd. 7 and input on rd. 22.
 * Supplies keep V2's codes: EX-IC (rd. 1, D390 L) and EX-EXPORT (rd. 14).
 */

export const tradeCodes = {
  acquisition: (rate: string) => `AIC-${Number(rate)}`,
  importPaid: (rate: string) => `IMP-${Number(rate)}`,
  importDeferred: (rate: string) => `IMP-DEF-${Number(rate)}`,
} as const;

/** An intra-community acquisition of goods (AIC-<rate>). */
export const isAcquisitionCode = (code: string) => /^AIC-\d+$/.test(code);
/** An import's VAT paid at customs (IMP-<rate>). */
export const isImportPaidCode = (code: string) => /^IMP-\d+$/.test(code);
/** An import's VAT not paid at customs, self-assessed in the return (IMP-DEF-<rate>). */
export const isImportDeferredCode = (code: string) => /^IMP-DEF-\d+$/.test(code);
/** The rate a G3 code carries. */
export const rateOfTradeCode = (code: string) => /-(\d+)$/.exec(code)?.[1] ?? null;
/** The codes whose collected side is declared with their deduction (D300 rd. 20, 22; SAF-T). */
export const isSelfAssessedTradeCode = (code: string) =>
  isAcquisitionCode(code) || isImportDeferredCode(code);

/** How a sale of goods across the border is arranged. Only the standard case is covered: a
 * triangular operation (art. 276 alin. (5), art. 307 alin. (4); D390 type T) and the call-off
 * stock (art. 270^1) are not. */
export const tradeArrangements = [
  'standard',
  'triangular_intermediary',
  'triangular_final',
  'call_off_stock',
] as const;
export type TradeArrangement = (typeof tradeArrangements)[number];
