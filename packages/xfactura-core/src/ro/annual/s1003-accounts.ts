import {
  annualFromLedger,
  s1005F10Formulas,
  s1005F30Formulas,
  type S1005Formula,
  type S1005LedgerRows,
  type S1005LedgerYear,
} from './s1005-accounts';
import { s1003F20FromS1005Xix, type S1003F20Row } from './s1003-rows';

/**
 * From the chart of accounts to the rows of S1003 for 2025. F10 is the microentities' form
 * (F10_BS), read with the same formulas. F20, the profit and loss account in full (OMFP nr.
 * 1.802/2014 pct. 600), is row for row the profit and loss account the microentities report in
 * F30 chapter XIX (OMF nr. 2.036/2025 anexa nr. 4 pct. 6, rows 180–266, which ANAF's form for the
 * small entities numbers F20 rd. 01–70): its account formulas are those, transcribed from the
 * order, under the F20 row. ANAF's form for 2025 (bilant_SC_1225_XML_270326, subform F20) prints
 * the same accounts, with the deletions ANAF struck through (6811 from rd. 26, 612 from rd. 32).
 * S1003's F30 has no account rows: its chapters come from the registers (informative.ts).
 */

const xixToF20 = new Map(
  Object.entries(s1003F20FromS1005Xix).map(([f20, xix]) => [xix as string, f20 as S1003F20Row]),
);

const f20Of = (xix: string | undefined) => (xix ? xixToF20.get(xix) : undefined);

/** F20 rows with account formulas, from chapter XIX's. */
export const s1003F20Formulas: readonly S1005Formula[] = s1005F30Formulas.map((formula) => {
  const row = f20Of(formula.row);
  if (!row) throw new Error(`S1003 F20 has no row for XIX rd. ${formula.row}`);
  const complement = f20Of(formula.complement);
  const of = f20Of(formula.of);
  return {
    ...formula,
    form: 'F20' as const,
    row,
    ...(formula.complement ? { complement: complement! } : {}),
    ...(formula.of ? { of: of! } : {}),
    source: `${formula.source}; ANAF bilant_SC_1225_XML_270326.pdf, F20 rd. ${row}`,
  };
});

/** Every S1003 account formula: F10 as the microentities', F20 from chapter XIX. */
export const s1003Formulas: readonly S1005Formula[] = [...s1005F10Formulas, ...s1003F20Formulas];

/** One column of S1003's F10 and F20 from a year of the ledger (s1005FromLedger's rules). */
export function s1003FromLedger(year: S1005LedgerYear): S1005LedgerRows {
  return annualFromLedger(year, {
    prefix: 'S1003',
    F10: s1005F10Formulas,
    F20: s1003F20Formulas,
    F30: [],
  });
}
