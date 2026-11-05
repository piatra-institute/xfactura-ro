import type { D101Row } from '../declarations/d101';

/*
 * The fiscal register (Registrul de evidență fiscală) of a profit taxpayer, in the form of OMF
 * nr. 808/2026 (in force from its publication on 7 July 2026, replacing OMF nr. 870/2005): rows
 * numbered in chronological order, each an explanation of what entered the fiscal result and the
 * tax, with the symbol of the accounts the amounts were booked on, and the value in lei (art. 2–3
 * and the annex). It is a projection of the books: every row comes from a posted computation of
 * the profit tax (`tax.profit`) or a prior-year correction, never typed in.
 */

/** The return's names of the rows the register explains (D101, OPANAF nr. 206/2025). */
export const rowLabels: Partial<Record<D101Row, string>> = {
  P1: 'Venituri din exploatare',
  P2: 'Cheltuieli de exploatare (cu impozitul pe profit)',
  P4: 'Venituri financiare',
  P5: 'Cheltuieli financiare',
  P7: 'Rezultat brut',
  P8: 'Elemente similare veniturilor',
  P9: 'Elemente similare cheltuielilor',
  P11: 'Amortizare fiscală',
  P111: 'Amortizare fiscală integrală: prevenirea accidentelor de muncă',
  P112: 'Amortizare fiscală integrală: cabinete medicale',
  P113: 'Amortizare fiscală integrală: sub limita valorii mijloacelor fixe',
  P13: 'Rezerva legală deductibilă',
  P16: 'Total deduceri',
  P17: 'Venituri neimpozabile din dividende',
  P171: 'Dividende de la persoane juridice române',
  P20: 'Alte venituri neimpozabile',
  P21: 'Total venituri neimpozabile',
  P22: 'Profit/pierdere înainte de cheltuielile nedeductibile',
  P23: 'Cheltuieli cu impozitul pe profit',
  P25: 'Dobânzi, majorări, amenzi și penalități datorate autorităților',
  P26: 'Cheltuieli de protocol peste limită',
  P27: 'Cheltuieli de sponsorizare',
  P28: 'Amortizare contabilă',
  P29: 'Provizioane și ajustări nedeductibile',
  P32: 'Cheltuieli aferente veniturilor neimpozabile',
  P33: 'Alte cheltuieli nedeductibile',
  P34: 'Total cheltuieli nedeductibile',
  P35: 'Profit impozabil/pierdere fiscală înainte de pierderile anilor precedenți',
  P39: 'Pierdere fiscală de recuperat din anii precedenți',
  P39a: 'Pierdere fiscală recuperată în perioadă',
  P40: 'Profit impozabil',
  P40a: 'Pierdere fiscală a perioadei',
  P41: 'Impozit pe profit (16%)',
  P43: 'Sponsorizare scăzută din impozit',
  P48: 'Impozit pe profit datorat',
  P50: 'Impozit declarat în trimestrele anterioare',
  P52: 'Diferență de plată',
  P53: 'Diferență de recuperat',
};

/** The rows every computation explains, in the return's order, after its bridge lines. */
const summaryRows: readonly D101Row[] = [
  'P1',
  'P2',
  'P4',
  'P5',
  'P7',
  'P16',
  'P21',
  'P34',
  'P35',
  'P39',
  'P39a',
  'P40',
  'P40a',
  'P41',
  'P43',
  'P48',
  'P50',
  'P52',
  'P53',
];

export interface RegisterInput {
  entryId: string;
  date: string;
  /** `2026-Q3`, `2026`, or a correction's year. */
  period: string;
  kind: 'quarter' | 'year' | 'rectification' | 'correction';
  rows: Record<string, string> | null;
  lines: { row: string; amount: string; accounts: string[]; clause: string; text: string }[];
  /** For a correction: its description and change. */
  correction?: { year: number; change: string; description: string };
}

export interface RegisterRow {
  /** Nr. crt. */
  number: number;
  date: string;
  period: string;
  entryId: string;
  /** Explicații, with the accounts' symbols. */
  explanation: string;
  accounts: string[];
  row: string | null;
  clause: string | null;
  /** Valoarea, lei. */
  value: string;
}

/** The register's rows from the posted computations, in posting order. */
export function fiscalRegister(postings: readonly RegisterInput[]): RegisterRow[] {
  const rows: RegisterRow[] = [];
  const push = (
    posting: RegisterInput,
    row: Omit<RegisterRow, 'number' | 'date' | 'period' | 'entryId'>,
  ) =>
    rows.push({
      number: rows.length + 1,
      date: posting.date,
      period: posting.period,
      entryId: posting.entryId,
      ...row,
    });
  for (const posting of postings) {
    if (posting.kind === 'correction' && posting.correction) {
      push(posting, {
        explanation: `Corectarea unei erori a anului ${posting.correction.year} pe seama rezultatului reportat: ${posting.correction.description} (cont 1174)`,
        accounts: ['1174'],
        row: null,
        clause: 'ANAF/Cod-fiscal-consolidat:art.19(3)',
        value: posting.correction.change,
      });
      continue;
    }
    const title =
      posting.kind === 'quarter'
        ? `Calculul impozitului pe profit, cumulat, pentru ${posting.period}`
        : posting.kind === 'year'
          ? `Calculul impozitului pe profit anual pentru ${posting.period}`
          : `Rectificarea impozitului pe profit pentru ${posting.period}`;
    for (const line of posting.lines)
      push(posting, {
        explanation: `${title}: rd. ${line.row}, ${line.text}${line.accounts.length ? ` (cont ${line.accounts.join(', ')})` : ''}`,
        accounts: line.accounts,
        row: line.row,
        clause: line.clause,
        value: line.amount,
      });
    for (const row of summaryRows) {
      const value = posting.rows?.[row];
      if (!value || value === '0') continue;
      push(posting, {
        explanation: `${title}: rd. ${row}, ${rowLabels[row]}`,
        accounts: [],
        row,
        clause: null,
        value,
      });
    }
  }
  return rows;
}
