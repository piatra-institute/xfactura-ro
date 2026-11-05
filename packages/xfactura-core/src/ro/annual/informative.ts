import type { Cells, F30RowSpec } from './form';
import { s1003F30Rows, s1003F30SameAs } from './s1003-rows';

/**
 * The informative data (F30, "Date informative", OMF nr. 2.036/2025 anexa nr. 4 pct. 6 and 7)
 * from the registers, chapter by chapter. A row comes from:
 * - the books: closing balances (by partner on the accounts kept on open items, so "în sume
 *   brute" is the gross balance on the row's side), the year's turnover, the open items past
 *   their due date, the employment contracts, the dividends booked;
 * - the form: totals and chapter I, which the writer computes from the other rows;
 * - a person: what the books do not hold (royalties, R&D, the holders of the capital, …), asked
 *   per chapter (`annual.informative`), answered with the rows or with "nothing to report", and
 *   kept as evidence.
 * A row the books hold only in part ("din ct.", residence, affiliation, currency) is computed when
 * the books settle it (every balance of its accounts is held per partner, or the accounts have no
 * balance, so the part is 0) and asked otherwise. Nothing is defaulted to zero.
 *
 * Columns: chapter II [total, current activity, investment activity] at the year's end; III and
 * VIII–XI, XIII–XVIII [previous year, current year]; IV and V [current year]; XII [previous
 * amount, %, current amount, %].
 */

/** A closing balance: one account, one partner when kept on open items, in bani, debit
 * positive. */
export type AnnualBalance = {
  account: string;
  bani: bigint;
  partner?: { country: string; kind: string } | null;
};

/** An open item at the year's end with its remaining balance (positive on its normal side). */
export type AnnualOpenItem = {
  account: string;
  bani: bigint;
  /** null: the item has no due date in the books. */
  dueDate: string | null;
  partner: { country: string; kind: string };
};

/** What the books hold of one financial year. */
export type AnnualYearBooks = {
  year: number;
  /** The closing balances at 31 December (after classes 6 and 7 were closed). */
  closing: readonly AnnualBalance[];
  /** The year's turnover by account, without the closing journal: debit and credit in bani. */
  turnover: readonly { account: string; debit: bigint; credit: bigint }[];
  /** Open items still open at 31 December (suppliers, customers, advances). */
  openItems: readonly AnnualOpenItem[];
  /** Employees under contract in each month (12 entries). */
  headcount: readonly number[];
  /** Employees under contract on 31 December. */
  employeesAtEnd: number;
  /** Dividends booked in the year: from retained earnings (Dr 117 / Cr 457) and interim (Dr 463
   * / Cr 457), in bani. */
  dividends: { retained: bigint; interim: bigint };
};

export type InformativeBooks = {
  /** The company's legal form (`entity.form`): an SRL's capital is all social parts. */
  form: string | null;
  current: AnnualYearBooks;
  /** The previous year when the engine keeps it; `opening` when only its closing balances are
   * known (the opening entries); null for a first year. */
  previous: AnnualYearBooks | { opening: readonly AnnualBalance[] } | null;
};

/** Where a row comes from. */
export type RowSource =
  /** The form computes it (a total, chapter I). */
  | { kind: 'form' }
  /** A person gives it. */
  | { kind: 'ask' }
  /** The balances of accounts on a side (debit: the debit balances, credit: the credit ones). */
  | { kind: 'balance'; side: 'debit' | 'credit'; accounts: readonly string[] }
  /** Part of such balances, by partner: non-residents, individuals or legal persons. Computed only
   * when every balance of the accounts is held per partner. */
  | {
      kind: 'partners';
      side: 'debit' | 'credit';
      accounts: readonly string[];
      partners: 'nonResident' | 'individual' | 'legalPerson';
      /** The books tell only that there is none (affiliation is not kept): 0 when the part is
       * 0, asked otherwise. */
      zeroOnly?: true;
    }
  /** A part the books cannot tell ("din ct."): 0 when the accounts have no balance, else asked. */
  | { kind: 'zeroIf'; accounts: readonly string[] }
  /** An SRL's paid-in capital (1012) is all social parts; asked for other forms. */
  | { kind: 'socialParts'; share: 'parts' | 'none' }
  /** The year's debit turnover of accounts (621). */
  | { kind: 'turnover'; accounts: readonly string[] }
  | { kind: 'dividends'; which: 'retained' | 'interim' }
  | { kind: 'employees'; which: 'average' | 'end' }
  /** Supplier debts past their due date at the year's end, by days overdue; columns 2 (current
   * activity: 401, 403, 408) and 3 (investment: 404, 405). */
  | { kind: 'overdueSuppliers'; bucket: 'over30' | 'over90' | 'over365' }
  /** Receivables not collected by their due date (customers and advances). */
  | { kind: 'overdueReceivables'; accounts: readonly string[] }
  /** A breakdown of an earlier row the books cannot tell: 0 when that row is 0, else asked. */
  | { kind: 'partOf'; row: string };

export type InformativeSpec = {
  rows: readonly F30RowSpec[];
  sources: Readonly<Record<string, RowSource>>;
  /** The cells the form computes from others (`row.column`): never asked. */
  computed: ReadonlySet<string>;
};

/** One chapter's rows a person gives, as the question asks them. */
export type InformativeAsk = {
  chapter: string;
  rows: { row: string; label: string; columns: number[] }[];
};

/** A person's answer for a chapter: nothing to report, or the rows' cells. */
export type InformativeAnswer = { none: true } | { rows: Record<string, (number | null)[]> };

export type InformativeIssue = { code: string; row: string; message: string };

const yearEndOf = (year: number) => `${year}-12-31`;
const matches = (account: string, prefixes: readonly string[]) =>
  prefixes.some((prefix) => account.startsWith(prefix));
const lei = (bani: bigint) => Number(bani < 0n ? -((-bani + 50n) / 100n) : (bani + 50n) / 100n);
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** The columns of a chapter's row that hold the previous year, the current one, or neither. */
function yearColumns(chapter: string, columns: readonly number[]) {
  if (chapter === 'II' || chapter === 'IV' || chapter === 'V')
    return { previous: [] as number[], current: [...columns] };
  if (chapter === 'XII')
    return { previous: columns.filter((c) => c <= 2), current: columns.filter((c) => c >= 3) };
  return { previous: columns.filter((c) => c === 1), current: columns.filter((c) => c === 2) };
}

type Value = { value: number } | { ask: string };

/** The balances of the accounts on one side, in bani. */
function sideSum(balances: readonly AnnualBalance[], accounts: readonly string[], side: string) {
  return balances
    .filter((item) => matches(item.account, accounts))
    .reduce(
      (sum, item) =>
        side === 'debit'
          ? sum + (item.bani > 0n ? item.bani : 0n)
          : sum + (item.bani < 0n ? -item.bani : 0n),
      0n,
    );
}

const partnerOf = {
  nonResident: (partner: { country: string }) => partner.country !== 'RO',
  individual: (partner: { kind: string }) => partner.kind === 'ro_individual',
  legalPerson: (partner: { kind: string }) => partner.kind !== 'ro_individual',
} as const;

/** One cell of a balance-like source from one year's closing balances. */
function balanceCell(
  source: RowSource,
  balances: readonly AnnualBalance[],
  form: string | null,
): Value {
  switch (source.kind) {
    case 'balance':
      return { value: lei(sideSum(balances, source.accounts, source.side)) };
    case 'partners': {
      const held = balances.filter(
        (item) => matches(item.account, source.accounts) && item.bani !== 0n,
      );
      if (held.some((item) => !item.partner))
        return {
          ask: `Soldurile conturilor ${source.accounts.join(', ')} nu sunt toate pe parteneri: partea lor nu se poate citi din registre.`,
        };
      const filter = partnerOf[source.partners];
      const value = lei(
        sideSum(
          held.filter((item) => filter(item.partner!)),
          source.accounts,
          source.side,
        ),
      );
      if (source.zeroOnly && value !== 0)
        return { ask: 'Registrele nu țin afilierea partenerilor nerezidenți.' };
      return { value };
    }
    case 'zeroIf': {
      const nonzero = balances.some(
        (item) => matches(item.account, source.accounts) && item.bani !== 0n,
      );
      return nonzero
        ? {
            ask: `Registrele nu arată ce parte din ${source.accounts.join(', ')} se raportează aici.`,
          }
        : { value: 0 };
    }
    case 'socialParts': {
      if (form !== 'srl')
        return {
          ask: 'Structura capitalului pe acțiuni și părți sociale nu se citește din registre.',
        };
      return {
        value:
          source.share === 'parts'
            ? lei(-sideSum(balances, ['1012'], 'debit') + sideSum(balances, ['1012'], 'credit'))
            : 0,
      };
    }
    default:
      return { ask: 'Rândul nu se citește din soldurile registrelor.' };
  }
}

const balanceKinds = new Set(['balance', 'partners', 'zeroIf', 'socialParts']);

/** One year's cell of a flow source. */
function flowCell(source: RowSource, books: AnnualYearBooks): Value {
  switch (source.kind) {
    case 'turnover':
      return {
        value: lei(
          books.turnover
            .filter((item) => matches(item.account, source.accounts))
            .reduce((sum, item) => sum + item.debit - item.credit, 0n),
        ),
      };
    case 'dividends':
      return { value: lei(books.dividends[source.which]) };
    case 'employees': {
      if (source.which === 'end') return { value: books.employeesAtEnd };
      const total = books.headcount.reduce((sum, count) => sum + count, 0);
      // The mean of the twelve months, to whole employees, half up (a reading for the expert).
      return { value: Math.floor((total * 2 + 12) / 24) };
    }
    default:
      return { ask: 'Rândul nu se citește din rulajele registrelor.' };
  }
}

/**
 * The rows the books give, the chapters a person must answer, and what each answer adds. A
 * chapter is asked once, with every row of it the books do not give (and, when the previous year
 * is not kept, the previous year's column of its flow rows). `answers` are by chapter.
 */
export function informativeRows(
  specOf: InformativeSpec,
  books: InformativeBooks,
  answers: Readonly<Record<string, InformativeAnswer>>,
): {
  rows: Record<string, Cells>;
  asks: InformativeAsk[];
  /** Chapters asked and not answered yet. */
  missing: InformativeAsk[];
  issues: InformativeIssue[];
} {
  const rows: Record<string, (number | undefined)[]> = {};
  const asked = new Map<string, InformativeAsk>();
  const issues: InformativeIssue[] = [];
  const previousBooks = books.previous && 'closing' in books.previous ? books.previous : null;
  const previousBalances = !books.previous
    ? null
    : 'closing' in books.previous
      ? books.previous.closing
      : books.previous.opening;
  const ask = (spec: F30RowSpec, column: number) => {
    if (specOf.computed.has(`${spec.row}.${column}`)) return;
    const entry =
      asked.get(spec.chapter) ??
      asked.set(spec.chapter, { chapter: spec.chapter, rows: [] }).get(spec.chapter)!;
    let row = entry.rows.find((item) => item.row === spec.row);
    if (!row) entry.rows.push((row = { row: spec.row, label: spec.label, columns: [] }));
    if (!row.columns.includes(column)) row.columns.push(column);
  };
  const set = (spec: F30RowSpec, column: number, value: number) => {
    const cells = (rows[spec.row] ??= []);
    cells[column - 1] = value;
  };
  const yearEnd = yearEndOf(books.current.year);

  for (const row of specOf.rows) {
    const source = specOf.sources[row.row] ?? { kind: 'ask' as const };
    if (source.kind === 'form') continue;
    const { previous, current } = yearColumns(row.chapter, row.columns);
    if (source.kind === 'ask') {
      // A first year has no previous column to give.
      for (const column of [...(books.previous ? previous : []), ...current]) ask(row, column);
      continue;
    }
    if (source.kind === 'partOf') {
      const of = rows[source.row];
      for (const column of [...(books.previous ? previous : []), ...current]) {
        if (of?.[column - 1] === 0) set(row, column, 0);
        else ask(row, column);
      }
      continue;
    }
    if (source.kind === 'overdueSuppliers') {
      const limits = { over30: [30, 90], over90: [90, 365], over365: [365, Infinity] }[
        source.bucket
      ];
      const items = books.current.openItems.filter((item) =>
        matches(item.account, ['401', '403', '404', '405', '408']),
      );
      if (items.some((item) => item.dueDate === null && item.bani !== 0n)) {
        for (const column of row.columns) ask(row, column);
        continue;
      }
      const overdue = (investment: boolean) =>
        lei(
          items
            .filter((item) => matches(item.account, ['404', '405']) === investment)
            .filter((item) => {
              const days = daysBetween(item.dueDate!, yearEnd);
              return days > limits[0]! && days <= limits[1]!;
            })
            .reduce((sum, item) => sum + item.bani, 0n),
        );
      const [currentActivity, investment] = [overdue(false), overdue(true)];
      set(row, 1, currentActivity + investment);
      set(row, 2, currentActivity);
      set(row, 3, investment);
      continue;
    }
    if (source.kind === 'overdueReceivables') {
      const items = books.current.openItems.filter((item) =>
        matches(item.account, source.accounts),
      );
      if (items.some((item) => item.dueDate === null && item.bani !== 0n)) {
        for (const column of current) ask(row, column);
        for (const column of books.previous ? previous : []) ask(row, column);
        continue;
      }
      const value = lei(
        items.filter((item) => item.dueDate! < yearEnd).reduce((sum, item) => sum + item.bani, 0n),
      );
      for (const column of current) set(row, column, value);
      // The previous year's overdue receivables: from its own open items only when kept.
      for (const column of previous) {
        if (!previousBooks) {
          if (books.previous) ask(row, column);
          continue;
        }
        const end = yearEndOf(previousBooks.year);
        const items2 = previousBooks.openItems.filter((item) =>
          matches(item.account, source.accounts),
        );
        if (items2.some((item) => item.dueDate === null && item.bani !== 0n)) ask(row, column);
        else
          set(
            row,
            column,
            lei(items2.filter((item) => item.dueDate! < end).reduce((s, i) => s + i.bani, 0n)),
          );
      }
      continue;
    }
    if (balanceKinds.has(source.kind)) {
      const cells: [number[], readonly AnnualBalance[] | null][] = [
        [previous, previousBalances],
        [current, books.current.closing],
      ];
      for (const [columns, balances] of cells)
        for (const column of columns) {
          if (!balances) continue;
          const value = balanceCell(source, balances, books.form);
          if ('value' in value) set(row, column, value.value);
          else ask(row, column);
        }
      continue;
    }
    // Flows: the current year from its books, the previous one from its books when kept.
    for (const column of current) {
      const value = flowCell(source, books.current);
      if ('value' in value) set(row, column, value.value);
      else ask(row, column);
    }
    for (const column of previous) {
      if (!books.previous) continue;
      if (!previousBooks) {
        ask(row, column);
        continue;
      }
      const value = flowCell(source, previousBooks);
      if ('value' in value) set(row, column, value.value);
      else ask(row, column);
    }
  }

  const asks = [...asked.values()]
    .map((item) => ({
      ...item,
      rows: item.rows.map((row) => ({ ...row, columns: row.columns.sort() })),
    }))
    .sort((a, b) => chapterOrder(a.chapter) - chapterOrder(b.chapter));
  const missing: InformativeAsk[] = [];
  for (const item of asks) {
    const answer = answers[item.chapter];
    if (!answer) {
      missing.push(item);
      continue;
    }
    for (const row of item.rows) {
      const given = 'none' in answer ? undefined : answer.rows[row.row];
      for (const column of row.columns) {
        const value = 'none' in answer ? 0 : given?.[column - 1];
        if (value === null || value === undefined) {
          issues.push({
            code: 'F30_ANSWER',
            row: row.row,
            message: `F30 rd. ${row.row} col. ${column} (capitolul ${item.chapter}) lipsește din răspuns.`,
          });
          continue;
        }
        const cells = (rows[row.row] ??= []);
        cells[column - 1] = value;
      }
    }
    if (!('none' in answer))
      for (const key of Object.keys(answer.rows))
        if (!item.rows.some((row) => row.row === key))
          issues.push({
            code: 'F30_ANSWER',
            row: key,
            message: `F30 rd. ${key} nu se dă în capitolul ${item.chapter}: se citește din registre sau se calculează.`,
          });
  }
  return { rows, asks, missing, issues };
}

const chapters = [
  'I',
  'II',
  'III',
  'IV',
  'V',
  'VI',
  'VII',
  'VIII',
  'IX',
  'X',
  'XI',
  'XII',
  'XIII',
  'XIV',
  'XV',
  'XVI',
  'XVII',
  'XVIII',
  'XIX',
] as const;
const chapterOrder = (chapter: string) => chapters.indexOf(chapter as (typeof chapters)[number]);

// ---------------------------------------------------------------------------------------------
// The microentities' F30 (S1005)
// ---------------------------------------------------------------------------------------------

const form = { kind: 'form' } as const;
const askRow = { kind: 'ask' } as const;
const debit = (...accounts: string[]) => ({ kind: 'balance', side: 'debit', accounts }) as const;
const credit = (...accounts: string[]) => ({ kind: 'balance', side: 'credit', accounts }) as const;
const zeroIf = (...accounts: string[]) => ({ kind: 'zeroIf', accounts }) as const;
const nonResident = (side: 'debit' | 'credit', ...accounts: string[]) =>
  ({ kind: 'partners', side, accounts, partners: 'nonResident' }) as const;

/**
 * The sources of S1005's F30 rows outside chapter XIX (whose rows are the profit and loss account
 * from the accounts, s1005-accounts.ts). Each account list is the row's formula in ANAF's form;
 * the rows marked `zeroIf` are the form's "din ct." parts the books cannot tell.
 */
export const s1005InformativeSources: Readonly<Record<string, RowSource>> = {
  '01': form,
  '02': form,
  '03': form,
  '04': form,
  '05': form,
  '06': { kind: 'overdueSuppliers', bucket: 'over30' },
  '07': { kind: 'overdueSuppliers', bucket: 'over90' },
  '08': { kind: 'overdueSuppliers', bucket: 'over365' },
  '09': form,
  '19': { kind: 'employees', which: 'average' },
  '20': { kind: 'employees', which: 'end' },
  '34': { kind: 'overdueReceivables', accounts: ['4091', '4092', '411', '413'] },
  '35': { kind: 'partOf', row: '34' },
  '36': { kind: 'partOf', row: '34' },
  '39': form,
  '42': form,
  '46': debit('4094'),
  '47': debit('4093'),
  '48': form,
  '49': form,
  '50': zeroIf('261', '262', '263', '265'),
  '51': zeroIf('261', '262', '263', '265'),
  '52': zeroIf('261', '262', '263', '265'),
  '52a': zeroIf('261', '262', '263', '265'),
  '53': zeroIf('261', '262', '263', '265'),
  '54': form,
  '55': zeroIf('267'),
  '56': zeroIf('267'),
  '57': debit('4091', '4092', '411', '413', '418'),
  '58': nonResident('debit', '4091', '4092', '411', '413', '418'),
  '59': { kind: 'overdueReceivables', accounts: ['4091', '4092', '411', '413'] },
  '60': debit('425', '4282'),
  '61': form,
  '62': debit('431', '437', '4382'),
  '63': debit('436', '441', '4424', '4428', '444', '446'),
  '64': debit('445'),
  '65': debit('447'),
  '66': debit('4482'),
  '67': debit('451'),
  '69': debit('453', '456', '4582', '461', '4662', '471', '473'),
  '70': debit('453', '456', '4582'),
  '71': zeroIf('461', '471', '473', '4662'),
  '72': zeroIf('461'),
  '73': debit('5187'),
  '74': zeroIf('5187'),
  '74a': zeroIf('4518', '4538'),
  '76': debit('501', '505', '506', '507', '508'),
  '77': zeroIf('501', '505', '506', '507', '508'),
  '78': zeroIf('501', '505', '506', '507', '508'),
  '79': zeroIf('501', '505', '506', '507', '508'),
  '80': zeroIf('501', '505', '506', '507', '508'),
  '80a': zeroIf('501', '505', '506', '507', '508'),
  '81': debit('5113', '5114'),
  '82': form,
  '83': debit('5311'),
  '84': debit('5314'),
  '85': form,
  '86': debit('5121'),
  '87': zeroIf('5121'),
  '88': debit('5124'),
  '89': zeroIf('5124'),
  '90': form,
  '91': zeroIf('5112', '5125', '5411'),
  '92': zeroIf('5125', '5414'),
  '93': form,
  '94': form,
  '95': zeroIf('5193', '5194', '5195'),
  '96': zeroIf('5193', '5194', '5195'),
  '97': form,
  '98': zeroIf('1623', '1624', '1625'),
  '99': zeroIf('1623', '1624', '1625'),
  '100': zeroIf('1626', '1682'),
  '101': form,
  '102': zeroIf('166', '1685', '1686', '1687'),
  '103': zeroIf('166', '1685', '1686', '1687'),
  '104': credit('167'),
  '105': zeroIf('167'),
  '105a': zeroIf('167'),
  '106': credit('401', '403', '404', '405', '408', '419'),
  '107': nonResident('credit', '401', '403', '404', '405', '408', '419'),
  '108': credit('421', '423', '424', '426', '427', '4281'),
  '109': form,
  '110': credit('431', '437', '4381'),
  '111': credit('436', '441', '4423', '4428', '444', '446'),
  '112': credit('447'),
  '113': credit('4481'),
  '114': credit('451'),
  '115': credit('455'),
  '116': { kind: 'partners', side: 'credit', accounts: ['455'], partners: 'individual' },
  '117': { kind: 'partners', side: 'credit', accounts: ['455'], partners: 'legalPerson' },
  '118': credit(
    '269',
    '453',
    '456',
    '457',
    '4581',
    '462',
    '4661',
    '467',
    '472',
    '473',
    '478',
    '509',
  ),
  '119': credit('453', '456', '457', '4581', '467'),
  '120': zeroIf('462', '4661', '472', '473'),
  '121': zeroIf('472'),
  '122': credit('269', '509'),
  '123': credit('478'),
  '124': credit('5186'),
  '124a': zeroIf('4518', '4538'),
  '126': credit('1012'),
  '127': { kind: 'socialParts', share: 'none' },
  '128': { kind: 'socialParts', share: 'none' },
  '129': { kind: 'socialParts', share: 'parts' },
  '130': zeroIf('1012'),
  '131': zeroIf('205'),
  '132': { kind: 'turnover', accounts: ['621'] },
  '137': form,
  '138': form,
  '161a': { kind: 'dividends', which: 'retained' },
  '161b': { kind: 'dividends', which: 'interim' },
};

// ---------------------------------------------------------------------------------------------
// The small entities' F30 (S1003)
// ---------------------------------------------------------------------------------------------

const nonResidentNone = (side: 'debit' | 'credit', ...accounts: string[]) =>
  ({ kind: 'partners', side, accounts, partners: 'nonResident', zeroOnly: true }) as const;

/** The S1003 rows that have no S1005 equivalent, or whose formula differs from it. */
const s1003Own: Readonly<Record<string, RowSource>> = {
  '46a': zeroIf('4094'),
  '46b': zeroIf('4094'),
  '47a': zeroIf('4093'),
  '47b': zeroIf('4093'),
  '58': nonResidentNone('debit', '4091', '4092', '411', '413', '418'),
  '58a': nonResidentNone('debit', '4091', '4092', '411', '413', '418'),
  '68': zeroIf('451'),
  '69': zeroIf('451'),
  '95': form,
  '96': form,
  '97': zeroIf('519'),
  '98': zeroIf('519'),
  '99': form,
  '100': zeroIf('162'),
  '101': zeroIf('162'),
  '109': nonResidentNone('credit', '401', '403', '404', '405', '408', '419'),
  '109a': nonResidentNone('credit', '401', '403', '404', '405', '408', '419'),
  '117': zeroIf('451'),
  '118': zeroIf('451'),
  '118a': zeroIf('451'),
  '128a': zeroIf('5186'),
  '170a': { kind: 'turnover', accounts: ['6587'] },
  '170b': { kind: 'partOf', row: '170a' },
  '170c': { kind: 'partOf', row: '170a' },
  '170d': { kind: 'partOf', row: '170a' },
};

/**
 * The sources of S1003's F30 rows: the S1005 row's source where the row is the same
 * (`s1003F30SameAs`), its own otherwise. A row S1005 computes as a total but S1003 does not is
 * asked; `computed` (the cells S1003's rules compute) is the statement's.
 */
export function s1003InformativeSpec(computed: ReadonlySet<string>): InformativeSpec {
  const sources: Record<string, RowSource> = {};
  for (const row of s1003F30Rows) {
    const own = s1003Own[row.row];
    const same = (s1003F30SameAs as Record<string, string | undefined>)[row.row];
    const source = own ?? (same ? s1005InformativeSources[same] : undefined) ?? askRow;
    const formComputed = row.columns.every((column) => computed.has(`${row.row}.${column}`));
    sources[row.row] = source.kind === 'form' && !formComputed ? askRow : source;
  }
  return { rows: s1003F30Rows, sources, computed };
}

/** S1005's informative spec, with the cells its rules compute. */
export function s1005InformativeSpec(
  rows: readonly F30RowSpec[],
  computed: ReadonlySet<string>,
): InformativeSpec {
  const sources: Record<string, RowSource> = {};
  for (const row of rows) {
    if (row.chapter === 'XIX') continue;
    const source = s1005InformativeSources[row.row] ?? askRow;
    const formComputed = row.columns.every((column) => computed.has(`${row.row}.${column}`));
    sources[row.row] = source.kind === 'form' && !formComputed ? askRow : source;
  }
  return { rows: rows.filter((row) => row.chapter !== 'XIX'), sources, computed };
}
