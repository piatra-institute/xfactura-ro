import { z } from 'zod';
import type { ParameterDefinition, ParameterVersion } from '../rules';
import { parseLocalDate as date } from '../time';
import { d300Rows, type D300Row } from './declarations/d300';

export const etvaDefinitions: ParameterDefinition[] = [
  {
    key: 'ro.etva.significance',
    axis: 'reporting_period_start',
    continuity: 'block',
    scope: [],
    value: z
      .object({ percent: z.string().regex(/^\d{1,3}$/), lei: z.string().regex(/^\d+$/) })
      .strict(),
    description:
      'Pragul diferențelor semnificative dintre decont și decontul precompletat RO e-TVA: procent și sumă, cumulativ.',
  },
];

export const etvaVersions: ParameterVersion[] = [
  {
    id: 'ro.etva.significance/2024-07-01',
    key: 'ro.etva.significance',
    scope: {},
    value: { percent: '20', lei: '1000' },
    from: date('2024-07-01'),
    to: null,
    reviewedThrough: date('2026-12-31'),
    knowledgeDate: date('2024-06-21'),
    status: 'extracted',
    clauses: ['OUG70/2024:art.5', 'OUG89/2025:art.XII-XIII'],
  },
];

export type EtvaRow = {
  /** The D300 row as printed, and the element compared: its VAT, or its value without VAT. */
  row: string | undefined;
  element: string;
  declared: number;
  prefilled: number;
  difference: number;
  significant: boolean;
};

/** Rows compared: the VAT column of each output and input row, or its value where it has no
 * VAT; regularization rows are left out (OUG nr. 70/2024 art. 5 alin. (2)–(3)). */
const compared = (() => {
  const rows = d300Rows as readonly D300Row[];
  const vat = new Set(
    rows.filter((row) => row.column === 2).map((row) => row.element.replace(/_2$/, '')),
  );
  return rows.filter(
    (row) =>
      (row.section === 'output' || row.section === 'input') &&
      !/^Regulariz/i.test(row.label) &&
      (row.column === 2 || (row.column === 1 && !vat.has(row.element.replace(/_1$/, '')))),
  );
})();

/**
 * Compares a VAT return's rows with the pre-filled return RO e-TVA (whole lei): a row differs
 * significantly when the difference reaches both the percentage, of the pre-filled amount, and
 * the amount in lei. Which amount the percentage is taken of the ordinance does not say; the
 * pre-filled one is this engine's reading, for the expert's review.
 */
export function etvaDifferences(
  declared: Readonly<Record<string, number>>,
  prefilled: Readonly<Record<string, number>>,
  threshold: { percent: string; lei: string },
  period: { year: number; month: number },
): EtvaRow[] {
  const percent = BigInt(threshold.percent);
  const lei = BigInt(threshold.lei);
  return compared
    .filter((row) => (declared[row.element] ?? 0) !== 0 || (prefilled[row.element] ?? 0) !== 0)
    .map((row) => {
      const ours = declared[row.element] ?? 0;
      const theirs = prefilled[row.element] ?? 0;
      const difference = ours - theirs;
      const magnitude = BigInt(Math.abs(difference));
      const significant =
        magnitude >= lei && magnitude * 100n >= percent * BigInt(Math.abs(theirs));
      return {
        row: period.year === 2025 && row.row2025 ? row.row2025 : row.row,
        element: row.element,
        declared: ours,
        prefilled: theirs,
        difference,
        significant,
      };
    });
}
