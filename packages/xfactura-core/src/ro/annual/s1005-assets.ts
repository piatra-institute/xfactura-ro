import type { S1005Cells, S1005F40Row } from './s1005';
import type { S1005LedgerEntry, S1005MappingIssue } from './s1005-accounts';

/**
 * The statement of fixed assets (F40) of a microentity from the ledger. OMF nr. 2036/2025 defines
 * its columns by the accounts' movements: increases are the debits of the fixed-asset accounts
 * and reductions their credits (notes 1 and 2 of cod 40); depreciation and impairment of the year
 * are the credits of 28x and 29x, and their reductions the debits.
 *
 * The microentity form lists categories without accounts. Each row takes the accounts the order's
 * balance sheet with account formulas (cod 10 of the entities in anexa nr. 1 pct. 2.2) gives the
 * same category, on the chart the microentities' F10 uses (217 and 4093, before the plants and the
 * leasing rights of the larger entities): 213 + 223 are technical installations and machines,
 * 214 + 224 the other installations and furniture, 205 + 208 the concessions and other intangibles.
 * Receivables kept as financial assets (267) are split by the balance sheet between rows by their
 * nature, so they are not placed here; neither are 264 and 266, which the microentities' F10 does
 * not list. The reading is for the expert's review.
 */
type Group = 'gross' | 'depreciation' | 'impairment';
const rows: readonly { row: S1005F40Row; group: Group; accounts: readonly string[] }[] = [
  { row: '01', group: 'gross', accounts: ['201'] },
  { row: '02', group: 'gross', accounts: ['203'] },
  { row: '03', group: 'gross', accounts: ['205', '208'] },
  { row: '04', group: 'gross', accounts: ['2071'] },
  { row: '05', group: 'gross', accounts: ['206'] },
  { row: '06', group: 'gross', accounts: ['4094'] },
  { row: '08', group: 'gross', accounts: ['211'] },
  { row: '09', group: 'gross', accounts: ['212'] },
  { row: '10', group: 'gross', accounts: ['213', '223'] },
  { row: '11', group: 'gross', accounts: ['214', '224'] },
  { row: '12', group: 'gross', accounts: ['215'] },
  { row: '13', group: 'gross', accounts: ['231'] },
  { row: '14', group: 'gross', accounts: ['235'] },
  { row: '15', group: 'gross', accounts: ['216'] },
  { row: '16', group: 'gross', accounts: ['217', '227'] },
  { row: '17', group: 'gross', accounts: ['4093'] },
  { row: '19', group: 'gross', accounts: ['261', '262', '263', '265'] },
  { row: '21', group: 'depreciation', accounts: ['2801'] },
  { row: '22', group: 'depreciation', accounts: ['2803'] },
  { row: '23', group: 'depreciation', accounts: ['2805', '2808'] },
  { row: '24', group: 'depreciation', accounts: ['2807'] },
  { row: '25', group: 'depreciation', accounts: ['2806'] },
  { row: '27', group: 'depreciation', accounts: ['2811'] },
  { row: '28', group: 'depreciation', accounts: ['2812'] },
  { row: '29', group: 'depreciation', accounts: ['2813'] },
  { row: '30', group: 'depreciation', accounts: ['2814'] },
  { row: '31', group: 'depreciation', accounts: ['2815'] },
  { row: '32', group: 'depreciation', accounts: ['2816'] },
  { row: '33', group: 'depreciation', accounts: ['2817'] },
  { row: '36', group: 'impairment', accounts: ['2903'] },
  { row: '37', group: 'impairment', accounts: ['2905', '2908'] },
  { row: '38', group: 'impairment', accounts: ['2906'] },
  { row: '39', group: 'impairment', accounts: ['4904'] },
  { row: '41', group: 'impairment', accounts: ['2911'] },
  { row: '42', group: 'impairment', accounts: ['2912'] },
  { row: '43', group: 'impairment', accounts: ['2913'] },
  { row: '44', group: 'impairment', accounts: ['2914'] },
  { row: '45', group: 'impairment', accounts: ['2915'] },
  { row: '46', group: 'impairment', accounts: ['2931'] },
  { row: '47', group: 'impairment', accounts: ['2935'] },
  { row: '48', group: 'impairment', accounts: ['2916'] },
  { row: '49', group: 'impairment', accounts: ['2917'] },
  { row: '50', group: 'impairment', accounts: ['4903'] },
  { row: '52', group: 'impairment', accounts: ['296'] },
];
/** Gross rows with the "of which dismantled and scrapped" column (col. 4). */
const scrappable = new Set<S1005F40Row>([
  '08',
  '09',
  '10',
  '11',
  '12',
  '13',
  '14',
  '15',
  '16',
  '17',
]);

/** Whether an account belongs to F40's scope: fixed assets, their depreciation and impairment,
 * and the advances for them. */
const inScope = (account: string) => /^(2[0-9]|409[34]|490[34])/.test(account);
const rowOf = (account: string) => {
  let found: (typeof rows)[number] | undefined;
  let length = 0;
  for (const row of rows)
    for (const prefix of row.accounts)
      if (account.startsWith(prefix) && prefix.length > length)
        [found, length] = [row, prefix.length];
  return found;
};

const halfAway = (bani: bigint) => (bani < 0n ? -((-bani + 50n) / 100n) : (bani + 50n) / 100n);

export type S1005F40Input = {
  /** Each balance at the year's start in whole lei as F10 col. 1 adds it, debit positive (the
   * `closing` of the previous year's s1005FromLedger); empty in a first year. */
  opening: readonly { account: string; lei: number }[];
  /** The same at the year's end (F10 col. 2). */
  closing: readonly { account: string; lei: number }[];
  /** The year's debits and credits in bani, without the opening entries. */
  movements: readonly S1005LedgerEntry[];
  /** Col. 4: the part of a row's reductions that is dismantling and scrapping, in lei. */
  scrapped?: Partial<Record<S1005F40Row, number>>;
};

/**
 * F40's rows in whole lei. The balances are F10's, so the totals tie to F10 (F10_F40_1–6); the
 * year's movements are rounded half away from zero, and what rounding leaves between them and the
 * balances goes to the larger movement of the row, so that col. 5 = 1 + 2 - 3 (col. 4 = 1 + 2 - 3
 * for depreciation and impairment). Accounts in scope without a row and reductions without their
 * scrapped part are issues.
 */
export function s1005F40FromLedger(input: S1005F40Input): {
  F40: Partial<Record<S1005F40Row, S1005Cells>>;
  issues: S1005MappingIssue[];
} {
  const issues: S1005MappingIssue[] = [];
  const sums = new Map<
    S1005F40Row,
    { opening: number; closing: number; debit: bigint; credit: bigint }
  >();
  const at = (row: S1005F40Row) => {
    if (!sums.has(row)) sums.set(row, { opening: 0, closing: 0, debit: 0n, credit: 0n });
    return sums.get(row)!;
  };
  const unmapped = new Set<string>();
  const place = (account: string) => {
    if (!inScope(account)) return undefined;
    const row = rowOf(account);
    if (!row) unmapped.add(account);
    return row;
  };
  for (const { account, lei } of input.opening) {
    const row = place(account);
    if (row) at(row.row).opening += lei;
  }
  for (const { account, lei } of input.closing) {
    const row = place(account);
    if (row) at(row.row).closing += lei;
  }
  for (const entry of input.movements) {
    const row = place(entry.account);
    if (!row) continue;
    at(row.row).debit += entry.debit;
    at(row.row).credit += entry.credit;
  }
  for (const account of unmapped)
    issues.push({
      code: 'S1005_F40_ACCOUNT',
      severity: 'error',
      path: `F40.${account}`,
      message: `Contul ${account} nu are un rând în situația activelor imobilizate.`,
    });

  const F40: Partial<Record<S1005F40Row, S1005Cells>> = {};
  for (const { row, group } of rows) {
    const sum = sums.get(row);
    if (!sum) continue;
    // Gross values are debit balances; depreciation and impairment credit balances (`|| 0`
    // keeps a zero from becoming -0).
    const side = (lei: number) => (group === 'gross' ? lei : -lei) || 0;
    const opening = side(sum.opening);
    const closing = side(sum.closing);
    let increase = Number(halfAway(group === 'gross' ? sum.debit : sum.credit));
    let reduction = Number(halfAway(group === 'gross' ? sum.credit : sum.debit));
    const residue = opening + increase - reduction - closing;
    if (increase >= reduction) increase -= residue;
    else reduction += residue;
    if (!opening && !increase && !reduction && !closing) continue;
    if (group !== 'gross') {
      F40[row] = [opening, increase, reduction, closing];
      continue;
    }
    if (!scrappable.has(row)) {
      F40[row] = [opening, increase, reduction, undefined, closing];
      continue;
    }
    const scrapped = input.scrapped?.[row];
    if (reduction && scrapped === undefined)
      issues.push({
        code: 'S1005_F40_SCRAPPED',
        severity: 'error',
        path: `F40.${row}`,
        message: `F40 rd. ${row}: reducerile de ${reduction} lei nu arată cât sunt dezmembrări și casări (scrapped).`,
      });
    if (scrapped !== undefined && (scrapped < 0 || scrapped > reduction))
      issues.push({
        code: 'S1005_F40_SCRAPPED',
        severity: 'error',
        path: `F40.${row}`,
        message: `F40 rd. ${row}: dezmembrările și casările (${scrapped} lei) depășesc reducerile (${reduction} lei).`,
      });
    F40[row] = [opening, increase, reduction, scrapped ?? 0, closing];
  }
  for (const row of Object.keys(input.scrapped ?? {}) as S1005F40Row[])
    if (!scrappable.has(row) || !F40[row])
      issues.push({
        code: 'S1005_F40_SCRAPPED',
        severity: 'error',
        path: `F40.${row}`,
        message: `F40 rd. ${row} nu are reduceri din dezmembrări și casări de raportat.`,
      });
  return { F40, issues };
}
