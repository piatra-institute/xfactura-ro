import {
  s1005F10Rows,
  s1005F20Rows,
  s1005F30Rows,
  type S1005F10Row,
  type S1005F20Row,
  type S1005F30Row,
} from './s1005-rows';

/**
 * From the chart of accounts (OMFP nr. 1.802/2014) to the rows of S1005 for 2025: F10 "Bilanț
 * prescurtat" from the closing balances, F20 "Contul prescurtat de profit și pierdere" and F30
 * chapter XIX "Situația veniturilor și cheltuielilor" from the year's turnover of classes 6 and 7.
 * F30 chapter XIX is the profit and loss account in full, and ANAF's validator ties it to F20
 * (F20_F30_1–10), so both come from the same turnover.
 *
 * The formulas are the row labels, transcribed as data:
 * - F10 and F20 from ANAF's form for 2025, bilant_SC_1225_XML_270326.pdf (27.03.2026), subforms
 *   F10S and F20S, which give each row's number in the order ("Nr. rd. OMF nr. 2036/2025"); the
 *   older XML structure structura_SC_1225_270126.pdf (F10_BS p. 18–22, F20_micro p. 29–30) is
 *   cited beside them where it differs.
 * - F30 chapter XIX from the order itself, OMF nr. 2036/2025 anexa nr. 4 pct. 6 (M.Of. nr.
 *   41/20.I.2026, pp. 47–50), rows 180–266, which ANAF's form numbers 167–236; where the form's
 *   label differs from the order, the order is followed and the row says so.
 *
 * A term reads one account: every ledger account whose code starts with the prefix, so a synthetic
 * account covers its analytics. Which amount it reads:
 * - `debit`: debit minus credit, signed (an asset's balance, an expense's turnover, a "+/-" account);
 * - `credit`: credit minus debit, signed (a liability's or equity's balance, a revenue's turnover);
 * - `debitBalances` (the forms' "**", "solduri debitoare"): only the entries with a debit balance;
 * - `creditBalances` ("***", "solduri creditoare"): only the entries with a credit balance.
 * The sign is the formula's. `part` marks "din ct." and the "*" notes ("conturi de repartizat după
 * natura elementelor respective"): the row takes only part of the account.
 *
 * Every amount is in bani; a row is the sum, rounded to whole lei (see s1005FromLedger).
 */

export type S1005Amount = 'debit' | 'credit' | 'debitBalances' | 'creditBalances';

export type S1005Term = {
  /** The account code or synthetic prefix. */
  account: string;
  sign: 1 | -1;
  amount: S1005Amount;
  /** "din ct." or "*": only part of the account belongs to the row. */
  part?: true;
};

export type S1005Formula = {
  form: 'F10' | 'F20' | 'F30';
  row: string;
  /** F10 reads the closing balances, F20 and F30 the year's turnover. */
  reads: 'closing' | 'turnover';
  terms: readonly S1005Term[];
  /** SOLD C / SOLD D rows: the row shows the sum only when positive, the complement row the
   * opposite side. */
  complement?: string;
  /** A breakdown ("din care") of this row: its accounts count there too. */
  of?: string;
  /** Where the formula comes from: document, page and row. */
  source: string;
  /** Where the documents disagree or the label leaves the formula open. */
  ambiguity?: string;
};

type Kind = 'asset' | 'liability' | 'expense' | 'revenue';

/**
 * Parses a label's formula: `+` reads the row's natural side (debit for assets and expenses,
 * credit for liabilities, equity and revenues), `-` the opposite one, `+/-` the signed debit
 * balance; `**` and `***` select debit or credit balances, `*` and `din` mark part of an account.
 */
function terms(kind: Kind, formula: string): S1005Term[] {
  const natural: S1005Amount = kind === 'asset' || kind === 'expense' ? 'debit' : 'credit';
  const opposite: S1005Amount = natural === 'debit' ? 'credit' : 'debit';
  const pattern = /(\+\/-|[+-])?\s*(din\s+)?(\d+)(\*{0,3})/g;
  const result: S1005Term[] = [];
  for (const match of formula.matchAll(pattern)) {
    const [, sign = '+', din, account, stars] = match;
    const amount: S1005Amount =
      stars === '**'
        ? 'debitBalances'
        : stars === '***'
          ? 'creditBalances'
          : sign === '-'
            ? opposite
            : natural;
    result.push({
      account: account!,
      sign: sign === '-' ? -1 : 1,
      amount,
      ...(din || stars === '*' ? { part: true as const } : {}),
    });
  }
  return result;
}

const xfa = 'ANAF bilant_SC_1225_XML_270326.pdf';
const structure = 'structura_SC_1225_270126.pdf';
const omfOf = (form: 'F10' | 'F20' | 'F30', row: string) =>
  ({ F10: s1005F10Rows, F20: s1005F20Rows, F30: s1005F30Rows })[form].find(
    (spec) => spec.row === row,
  )!.omf;

const f10Page = (row: string) => {
  const n = Number.parseInt(row, 10);
  if (n <= 6 && row !== '06b' && row !== '06') return '18';
  if (n <= 15 || row === '06b' || row === '06') return '19';
  if (n === 16) return '19–20';
  if (n <= 30) return '20';
  if (n <= 45) return '21';
  return '22';
};
const xixPage = (omf: number) => (omf <= 200 ? '47' : omf <= 227 ? '48' : omf <= 260 ? '49' : '50');

type Extra = Partial<Pick<S1005Formula, 'complement' | 'of' | 'ambiguity'>>;

function f10(row: S1005F10Row, kind: Kind, formula: string, extra: Extra = {}): S1005Formula {
  return {
    form: 'F10',
    row,
    reads: 'closing',
    terms: terms(kind, formula),
    ...extra,
    source: `${xfa}, F10S rd. ${row} (OMF rd. ${omfOf('F10', row)}); ${structure} p. ${f10Page(row)}`,
  };
}
function f20(row: S1005F20Row, kind: Kind, formula: string, extra: Extra = {}): S1005Formula {
  return {
    form: 'F20',
    row,
    reads: 'turnover',
    terms: terms(kind, formula),
    ...extra,
    source: `${xfa}, F20S rd. ${row} (OMF rd. ${omfOf('F20', row)}); ${structure} p. 29`,
  };
}
function xix(row: S1005F30Row, kind: Kind, formula: string, extra: Extra = {}): S1005Formula {
  const omf = omfOf('F30', row);
  return {
    form: 'F30',
    row,
    reads: 'turnover',
    terms: terms(kind, formula),
    ...extra,
    source: `OMF nr. 2036/2025 anexa nr. 4 pct. 6, cap. XIX, rd. ${omf} (M.Of. nr. 41/20.I.2026, p. ${xixPage(Number(omf))}); ${xfa}, F30 rd. ${row}`,
  };
}

const liabilities =
  '161 + 162 + 166 + 167 + 168 - 169 + 269 + 401 + 403 + 404 + 405 + 408 + 419 + 421 + 423 + 424 + 426 + 427 + 4281 + 431*** + 436*** + 437*** + 4381 + 441*** + 4423 + 4428*** + 444*** + 446*** + 447*** + 4481 + 451*** + 453*** + 455 + 456***';
const versions =
  'The structure of 27.01.2026 lacks the accounts the form of 27.03.2026 adds here (490x, 436, 467); the form is followed.';

/** F10 rows with account formulas; the other rows are totals of these. */
export const s1005F10Formulas: readonly S1005Formula[] = [
  f10('01', 'asset', '201 + 203 + 205 + 206 + 2071 + 4094 + 208 - 280 - 290 - 4904', {
    ambiguity: versions,
  }),
  f10(
    '02',
    'asset',
    '211 + 212 + 213 + 214 + 215 + 216 + 217 + 223 + 224 + 227 + 231 + 235 + 4093 - 281 - 291 - 2931 - 2935 - 4903',
    { ambiguity: versions },
  ),
  f10('03', 'asset', '261 + 262 + 263 + 265 + 267* - 296*', {
    ambiguity: `${structure} p. 18 reads "ct. 261 + 262 + 263 + 265 + 266 + 267* - 296*"; the form of 27.03.2026 has no 266. The form is followed: a balance on 266 is reported as unmapped.`,
  }),
  f10(
    '05',
    'asset',
    '301 + 302 + 303 + 321 + 322 +/- 308 + 323 + 326 + 327 + 328 + 331 + 332 + 341 + 345 + 346 + 347 +/- 348 + 351 + 354 + 356 + 357 + 358 + 361 +/- 368 + 371 +/- 378 + 381 +/- 388 + 4091 - 391 - 392 - 393 - 394 - 395 - 396 - 397 - 398 - din 4428 - 4901',
    { ambiguity: versions },
  ),
  f10(
    '06a',
    'asset',
    '267* - 296* + 4092 + 411 + 413 + 418 + 425 + 4282 + 431** + 436** + 437** + 4382 + 441** + 4424 + din 4428** + 444** + 445 + 446** + 447** + 4482 + 451** + 453** + 456** + 4582 + 461 + 4662 + 473** - 491 - 495 - 496 - 4902 + 5187',
    { ambiguity: versions },
  ),
  f10('06b', 'asset', '463'),
  f10('07', 'asset', '501 + 505 + 506 + 507 + din 508* + 5113 + 5114 - 591 - 595 - 596 - 598'),
  f10('08', 'asset', 'din 508* + 5112 + 512 + 531 + 532 + 541 + 542'),
  f10('11', 'asset', '471*'),
  f10('12', 'asset', '471*'),
  f10(
    '13',
    'liability',
    `${liabilities} + 457 + 4581 + 462 + 4661 + 467 + 473*** + 509 + 5186 + 519`,
    {
      ambiguity: `${versions} Rows 13 and 16 list the same accounts but 457 and separate them by maturity: every liability entry names its row.`,
    },
  ),
  f10('16', 'liability', `${liabilities} + 4581 + 462 + 4661 + 467 + 473*** + 509 + 5186 + 519`, {
    ambiguity: versions,
  }),
  f10('17', 'liability', '151'),
  f10('20', 'liability', 'din 475*'),
  f10('21', 'liability', 'din 475*'),
  f10('23', 'liability', 'din 472*'),
  f10('24', 'liability', 'din 472*'),
  f10('26', 'liability', 'din 478*'),
  f10('27', 'liability', 'din 478*'),
  f10('28', 'liability', '2075'),
  f10('30', 'liability', '1012'),
  f10('31', 'liability', '1011'),
  f10('32', 'liability', '1015'),
  f10('33', 'liability', '1018'),
  f10('34', 'liability', '1031'),
  f10('35', 'liability', '104'),
  f10('36', 'liability', '105'),
  f10('37', 'liability', '106'),
  f10('38', 'asset', '109'),
  f10('39', 'liability', '141'),
  f10('40', 'asset', '149'),
  f10('41', 'liability', '117', { complement: '42' }),
  f10('42', 'asset', '117', { complement: '41' }),
  f10('43', 'liability', '121', { complement: '44' }),
  f10('44', 'asset', '121', { complement: '43' }),
  f10('45', 'asset', '129'),
  f10('47', 'liability', '1016'),
  f10('48', 'liability', '1017'),
];

/** F20 rows with account formulas; rd. 01a is not an account formula and rd. 08, 09 are the
 * result. */
export const s1005F20Formulas: readonly S1005Formula[] = [
  f20('01', 'revenue', '701 + 702 + 703 + 704 + 705 + 706 + 708 + 707 - 709 + 7411', {
    ambiguity: `The label reads "741**"; its note "**) Se înscriu veniturile din subvenții de exploatare aferente cifrei de afaceri" is read as ct. 7411, as F30 rd. 172 (OMF rd. 185) names it. ${structure} p. 29 also adds "766***" (interest of entities struck off the general register that still run leasing contracts); the form of 27.03.2026 dropped it and F30 rd. 171 is null, so 766 stays in rd. 02.`,
  }),
  f20(
    '02',
    'revenue',
    '711 + 712 + 721 + 722 + 725 + 7412 + 7413 + 7414 + 7415 + 7416 + 7417 + 7418 + 7419 + 751 + 755 + 758 + 761 + 762 + 764 + 765 + 766 + 767 + 768 + 7815',
    {
      ambiguity:
        'The label reads "741***"; its note "***) Se înscriu veniturile din subvenții de exploatare altele decât cele aferente cifrei de afaceri" is read as ct. 7412–7419, the analytics F30 rd. 178 and 215 (OMF rd. 191, 243) name. 711 and 712 are read signed, as F30 rd. 173 - 174.',
    },
  ),
  f20('03', 'expense', '601 + 602 - 609*'),
  f20('04', 'expense', '641 + 642 + 643 + 644 + 645 + 646', {
    ambiguity: `${structure} p. 29 lacks 646, which the form of 27.03.2026 and F30 rd. 190 (OMF rd. 205) have. OMF nr. 2036/2025 anexa nr. 1 pct. 2.9 alin. (1) puts in this row (OMF rd. 05) "toate cheltuielile reprezentând drepturi salariale", and the order's note 8) on F30 rd. 189 (OMF rd. 204) adds the collaborators' rights set under labour law, from 621 analytic "Colaboratori persoane fizice"; the label names no 621, so 621 stays in rd. 06.`,
  }),
  f20('05', 'expense', '654 + 681 + 686 - 754 - 7812 - 7813 - 7814 - 7818 - 786', {
    ambiguity: `${structure} p. 29 lacks 7818, which the form of 27.03.2026 and F30 rd. 193, 196 (OMF rd. 209, 212) have.`,
  }),
  f20(
    '06',
    'expense',
    '603 + 604 + 605 + 606 + 607 + 608 - 609* + 611 + 612 + 613 + 614 + 615 + 616 + 617 + 618 + 621 + 622 + 623 + 624 + 625 + 626 + 627 + 628 + 635 + 651 + 652 + 655 + 658 + 663 + 664 + 665 + 666 + 667 + 668',
    {
      ambiguity: `${structure} p. 29 lacks 616, 617 and 618, which the form of 27.03.2026 and F30 rd. 198e, 198g, 198i (OMF rd. 219, 221, 223) have.`,
    },
  ),
  f20('06a', 'expense', '6051', { of: '06' }),
  f20('06b', 'expense', '6053', { of: '06' }),
  f20('07', 'expense', '691 + 694 + 697 + 698'),
  f20('07a', 'revenue', '794'),
];

const formLabel = (label: string) =>
  `the form of 27.03.2026 reads "${label}"; the order (M.Of. nr. 41/20.I.2026) is followed.`;

/** F30 chapter XIX rows with account formulas; the other rows are its totals or breakdowns
 * without accounts (rd. 167a, 198f, 198h, 198j, 202a–c, 212, 214, 223). */
export const s1005F30Formulas: readonly S1005Formula[] = [
  xix('168', 'revenue', '701 + 702 + 703 + 704 + 705 + 706 + 708'),
  xix('169', 'revenue', '707'),
  xix('170', 'expense', '709'),
  xix('172', 'revenue', '7411'),
  xix('173', 'revenue', '711 + 712', { complement: '174' }),
  xix('174', 'expense', '711 + 712', { complement: '173' }),
  xix('175', 'revenue', '721 + 722'),
  xix('176', 'revenue', '755'),
  xix('177', 'revenue', '725'),
  xix('178', 'revenue', '7412 + 7413 + 7414 + 7415 + 7416 + 7417 + 7419'),
  xix('179', 'revenue', '751 + 758 + 7815'),
  xix('180', 'revenue', '7584', { of: '179' }),
  xix('181', 'revenue', '7815', { of: '179' }),
  xix('183', 'expense', '601 + 602'),
  xix('184', 'expense', '603 + 604 + 606 + 608'),
  xix('185', 'expense', '605'),
  xix('185a', 'expense', '6051', { of: '185' }),
  xix('185b', 'expense', '6053', { of: '185' }),
  xix('186', 'expense', '607'),
  xix('187', 'revenue', '609'),
  xix('189', 'expense', '641 + 642 + 643 + 644', {
    ambiguity:
      'The order\'s note 8) adds "drepturile colaboratorilor, stabilite potrivit legislației muncii, care se preiau din rulajul debitor al contului 621, analitic Colaboratori persoane fizice"; the formula names no 621, so 621 stays in rd. 198 (and F20 rd. 06).',
  }),
  xix('190', 'expense', '645 + 646'),
  xix('191a', 'expense', '6811'),
  xix('192', 'expense', '6813 + 6817 + din 6818', {
    ambiguity: formLabel('a.2) Alte cheltuieli (ct. 6811 + 6813 + 6817 + din ct. 6818)'),
  }),
  xix('193', 'revenue', '7813 + din 7818'),
  xix('195', 'expense', '654 + 6814 + din 6818'),
  xix('196', 'revenue', '754 + 7814 + din 7818'),
  xix('198', 'expense', '611 + 613 + 614 + 615 + 621 + 622 + 623 + 624 + 625 + 626 + 627 + 628', {
    ambiguity: formLabel(
      '11.1. Cheltuieli privind prestațiile externe (ct. 611 + 612 + 613 + ... + 628)',
    ),
  }),
  xix('198a', 'expense', '612'),
  xix('198b', 'expense', '6121', { of: '198a' }),
  xix('198c', 'expense', '6122', { of: '198a' }),
  xix('198d', 'expense', '6123', { of: '198a' }),
  xix('198e', 'expense', '616'),
  xix('198g', 'expense', '617'),
  xix('198i', 'expense', '618'),
  xix('199', 'expense', '635 + 6586'),
  xix('200', 'expense', '652'),
  xix('201', 'expense', '655'),
  xix('202', 'expense', '6587'),
  xix('203', 'expense', '651 + 6581 + 6582 + 6583 + 6584 + 6588'),
  xix('206', 'expense', '6812'),
  xix('207', 'revenue', '7812'),
  xix('211', 'revenue', '7611 + 7612 + 7613'),
  xix('213', 'revenue', '766'),
  xix('215', 'revenue', '7418'),
  xix('216', 'revenue', '7615 + 762 + 764 + 765 + 767 + 768'),
  xix('217', 'revenue', '7615', { of: '216' }),
  xix('220', 'expense', '686'),
  xix('221', 'revenue', '786'),
  xix('222', 'expense', '666'),
  xix('224', 'expense', '663 + 664 + 665 + 667 + 668'),
  xix('232', 'expense', '691'),
  xix('232a', 'expense', '694'),
  xix('232b', 'revenue', '794'),
  xix('233a', 'expense', '697'),
  xix('234', 'expense', '698'),
];

/** Every account formula, by ANAF's row numbers (the order's are in the row catalogs). */
export const s1005Formulas: readonly S1005Formula[] = [
  ...s1005F10Formulas,
  ...s1005F20Formulas,
  ...s1005F30Formulas,
];

// ---------------------------------------------------------------------------------------------

/** One ledger account's amounts, in bani (RON minor units). */
export type S1005LedgerEntry = {
  account: string;
  debit: bigint;
  credit: bigint;
  /** For an account the form spreads over several rows ("din ct.", "*", rows 13 and 16 by
   * maturity, 609 between F20 rd. 03 and 06, 6818 and 7818 in F30 chapter XIX): the row this
   * entry belongs to. Give one entry per row. */
  rows?: { F10?: S1005F10Row; F20?: S1005F20Row; F30?: S1005F30Row };
};

/** A year of the ledger, for one column of the statements. */
export type S1005LedgerYear = {
  /** Closing balances at the year's end, after classes 6 and 7 were closed into 121: one entry
   * per account the ledger keeps, the debit or credit balance on its side. A bifunctional
   * account's debit and credit analytics are given apart, not netted. */
  closing: readonly S1005LedgerEntry[];
  /** The year's debit and credit turnover of classes 6 and 7, without the closing into 121. */
  turnover: readonly S1005LedgerEntry[];
};

export type S1005MappingIssue = {
  code: string;
  severity: 'error' | 'warning';
  /** closing.<index> or turnover.<index>. */
  path: string;
  message: string;
};

export type S1005LedgerRows = {
  F10: Partial<Record<S1005F10Row, number>>;
  F20: Partial<Record<S1005F20Row, number>>;
  /** Chapter XIX's account rows. */
  F30: Partial<Record<S1005F30Row, number>>;
  issues: S1005MappingIssue[];
};

const halfAway = (bani: bigint) => (bani < 0n ? -((-bani + 50n) / 100n) : (bani + 50n) / 100n);

/**
 * Rounds amounts in bani to lei so that they add up to `target` lei: each half away from zero,
 * then the residue, at most one leu per amount, goes to the amounts whose rounding moved them most
 * the other way (earlier ones first on ties).
 */
function roundTo(amounts: readonly bigint[], target: bigint): bigint[] {
  const rounded = amounts.map(halfAway);
  let residue = target - rounded.reduce((sum, value) => sum + value, 0n);
  const step = residue > 0n ? 1n : -1n;
  const order = amounts
    .map((bani, index) => ({ index, gap: bani - rounded[index]! * 100n }))
    .sort((a, b) => {
      const difference = step > 0n ? b.gap - a.gap : a.gap - b.gap;
      return difference > 0n ? 1 : difference < 0n ? -1 : a.index - b.index;
    });
  for (const { index } of order) {
    if (residue === 0n) break;
    rounded[index]! += step;
    residue -= step;
  }
  return rounded;
}

type Candidate = { formula: S1005Formula; term: S1005Term };

const longest = (formula: S1005Formula, account: string): S1005Term | undefined =>
  formula.terms
    .filter((term) => account.startsWith(term.account))
    .sort((a, b) => b.account.length - a.account.length)[0];

const admits = (term: S1005Term, lei: bigint) =>
  term.amount === 'debitBalances' ? lei > 0n : term.amount === 'creditBalances' ? lei < 0n : true;

const contribution = (term: S1005Term, lei: bigint) => {
  const value =
    term.amount === 'debit'
      ? lei
      : term.amount === 'credit'
        ? -lei
        : term.amount === 'debitBalances'
          ? lei > 0n
            ? lei
            : 0n
          : lei < 0n
            ? -lei
            : 0n;
  return BigInt(term.sign) * value;
};

/** Assigns entries (with their amounts in lei, debit minus credit) to a form's rows. */
function assign(
  form: 'F10' | 'F20' | 'F30',
  formulas: readonly S1005Formula[],
  entries: readonly { entry: S1005LedgerEntry; lei: bigint; path: string }[],
  issues: S1005MappingIssue[],
): Map<string, bigint> {
  const sums = new Map<string, bigint>(formulas.map((formula) => [formula.row, 0n]));
  const add = (row: string, value: bigint) => sums.set(row, sums.get(row)! + value);
  const main = formulas.filter((formula) => formula.of === undefined);
  const breakdowns = formulas.filter((formula) => formula.of !== undefined);
  for (const { entry, lei, path } of entries) {
    if (lei === 0n) continue;
    const candidates: Candidate[] = [];
    for (const formula of main) {
      const term = longest(formula, entry.account);
      if (term && admits(term, lei)) candidates.push({ formula, term });
    }
    // A SOLD C / SOLD D pair is one place: the side shows at the end.
    const places = candidates.filter(
      (candidate) =>
        !candidate.formula.complement ||
        !candidates.some(
          (other) =>
            other.formula.row === candidate.formula.complement &&
            other.formula.row < candidate.formula.row,
        ),
    );
    const wanted = entry.rows?.[form];
    let chosen: Candidate | undefined;
    if (wanted !== undefined) {
      chosen = places.find(
        (place) => place.formula.row === wanted || place.formula.complement === wanted,
      );
      if (!chosen) {
        issues.push({
          code: 'S1005_ROW',
          severity: 'error',
          path,
          message: `Contul ${entry.account} nu se raportează în ${form} rd. ${wanted}${places.length ? ` (rândurile lui: ${places.map((p) => p.formula.row).join(', ')})` : ''}.`,
        });
        continue;
      }
    } else if (places.length === 1) chosen = places[0];
    else if (places.length === 0) {
      issues.push({
        code: 'S1005_UNMAPPED',
        severity: 'error',
        path,
        message: `Contul ${entry.account} (${lei} lei) nu apare în niciun rând al ${form} cu soldul sau rulajul lui.`,
      });
      continue;
    } else {
      issues.push({
        code: 'S1005_SPLIT',
        severity: 'error',
        path,
        message: `Contul ${entry.account} se repartizează între rândurile ${places.map((p) => p.formula.row).join(', ')} din ${form}: indicați rândul (rows.${form}).`,
      });
      continue;
    }
    const rows = [chosen!.formula];
    const complement = chosen!.formula.complement;
    if (complement) rows.push(formulas.find((formula) => formula.row === complement)!);
    for (const formula of rows)
      add(formula.row, contribution(longest(formula, entry.account)!, lei));
    for (const breakdown of breakdowns) {
      if (!rows.some((formula) => formula.row === breakdown.of)) continue;
      const term = longest(breakdown, entry.account);
      if (term && admits(term, lei)) add(breakdown.row, contribution(term, lei));
    }
  }
  for (const formula of formulas)
    if (formula.complement)
      sums.set(formula.row, sums.get(formula.row)! > 0n ? sums.get(formula.row)! : 0n);
  return sums;
}

const classOf = (account: string) => account[0];
const sum = (values: readonly bigint[]) => values.reduce((total, value) => total + value, 0n);

/**
 * One column of F10, F20 and F30 chapter XIX from a year of the ledger: the rows with account
 * formulas, in whole lei; the totals are the form's (completeS1005). The issues name what the
 * formulas cannot place: accounts in no row, accounts the form spreads over several rows without
 * the entry's row, classes 6 or 7 still open, a trial balance that does not balance, and a result
 * in 121 other than the profit and loss account's.
 *
 * Rounding: each entry's balance or turnover is rounded to lei once, half away from zero, and
 * every row adds the rounded amounts, so F20 and F30 chapter XIX agree exactly. Within the
 * turnover, within 121 and within the other balances, the rounded amounts are made to add up to
 * their rounded total (the residue goes, one leu at a time, to the amounts rounded furthest the
 * other way): the balance sheet then balances (F10_63, F10_64) and 121 equals the profit or loss
 * of F20 (F10_F20_1–4) whenever the ledger does.
 */
export function s1005FromLedger(year: S1005LedgerYear): S1005LedgerRows {
  const issues: S1005MappingIssue[] = [];
  const valid = (entry: S1005LedgerEntry, path: string) => {
    if (!/^[1-9]\d{2}[0-9.]*$/.test(entry.account)) {
      issues.push({
        code: 'S1005_ACCOUNT',
        severity: 'error',
        path,
        message: `Contul ${entry.account} nu este un cont din planul de conturi.`,
      });
      return false;
    }
    if (
      typeof entry.debit !== 'bigint' ||
      typeof entry.credit !== 'bigint' ||
      entry.debit < 0n ||
      entry.credit < 0n
    ) {
      issues.push({
        code: 'S1005_AMOUNT',
        severity: 'error',
        path,
        message: `Contul ${entry.account}: debitul și creditul sunt sume în bani, nenegative.`,
      });
      return false;
    }
    return true;
  };

  const turnover = year.turnover
    .map((entry, index) => ({ entry, path: `turnover.${index}` }))
    .filter(({ entry, path }) => {
      if (!valid(entry, path)) return false;
      if (classOf(entry.account) === '6' || classOf(entry.account) === '7') return true;
      issues.push({
        code: 'S1005_TURNOVER',
        severity: 'warning',
        path,
        message: `Rulajul contului ${entry.account} nu intră în contul de profit și pierdere (clasele 6 și 7); a fost ignorat.`,
      });
      return false;
    });
  const closing = year.closing
    .map((entry, index) => ({ entry, path: `closing.${index}` }))
    .filter(({ entry, path }) => {
      if (!valid(entry, path)) return false;
      const accountClass = classOf(entry.account)!;
      if ('12345'.includes(accountClass)) return true;
      if ((accountClass === '6' || accountClass === '7') && entry.debit !== entry.credit)
        issues.push({
          code: 'S1005_NOT_CLOSED',
          severity: 'error',
          path,
          message: `Contul ${entry.account} are sold la închiderea exercițiului; conturile de venituri și cheltuieli se închid în 121.`,
        });
      // Classes 8 and 9 (off-balance sheet, management accounting) are not in the balance sheet.
      return false;
    });

  const flow = turnover.map(({ entry }) => entry.debit - entry.credit);
  const flowLei = roundTo(flow, halfAway(sum(flow)));

  const balances = closing.map(({ entry }) => entry.debit - entry.credit);
  const isResult = closing.map(({ entry }) => entry.account.startsWith('121'));
  const result = balances.filter((_, i) => isResult[i]);
  const rest = balances.filter((_, i) => !isResult[i]);
  const resultLei = roundTo(result, halfAway(sum(result)));
  const restLei = roundTo(rest, halfAway(sum(balances)) - halfAway(sum(result)));
  const balanceLei: bigint[] = [];
  for (let i = 0, r = 0, o = 0; i < balances.length; i++)
    balanceLei.push(isResult[i] ? resultLei[r++]! : restLei[o++]!);

  if (sum(balances) !== 0n)
    issues.push({
      code: 'S1005_UNBALANCED',
      severity: 'error',
      path: 'closing',
      message: `Soldurile claselor 1–5 nu se echilibrează: debitoare minus creditoare = ${sum(balances)} bani.`,
    });
  if (turnover.length && closing.length && sum(result) !== sum(flow))
    issues.push({
      code: 'S1005_RESULT',
      severity: 'error',
      path: 'closing',
      message: `Soldul contului 121 (${-sum(result)} bani) nu este rezultatul din rulajele claselor 6 și 7 (${-sum(flow)} bani).`,
    });

  const closingEntries = closing.map(({ entry, path }, i) => ({
    entry,
    path,
    lei: balanceLei[i]!,
  }));
  const turnoverEntries = turnover.map(({ entry, path }, i) => ({ entry, path, lei: flowLei[i]! }));
  const toNumbers = <Row extends string>(sums: Map<string, bigint>) =>
    Object.fromEntries([...sums].map(([row, value]) => [row, Number(value)])) as Partial<
      Record<Row, number>
    >;
  return {
    F10: toNumbers<S1005F10Row>(assign('F10', s1005F10Formulas, closingEntries, issues)),
    F20: toNumbers<S1005F20Row>(assign('F20', s1005F20Formulas, turnoverEntries, issues)),
    F30: toNumbers<S1005F30Row>(assign('F30', s1005F30Formulas, turnoverEntries, issues)),
    issues,
  };
}

/**
 * The F10, F20 and F30 rows of a model from two columns: the previous year's ledger (F10 col. 1
 * at 01.01, F20 and F30 col. 1) and the current year's (col. 2). An absent previous year leaves
 * column 1 empty.
 */
export function s1005Columns(columns: {
  previous?: Pick<S1005LedgerRows, 'F10' | 'F20' | 'F30'>;
  current: Pick<S1005LedgerRows, 'F10' | 'F20' | 'F30'>;
}): {
  F10: Partial<Record<S1005F10Row, [number | undefined, number | undefined]>>;
  F20: Partial<Record<S1005F20Row, [number | undefined, number | undefined]>>;
  F30: Partial<Record<S1005F30Row, [number | undefined, number | undefined]>>;
} {
  const merge = <Row extends string>(
    previous: Partial<Record<Row, number>> | undefined,
    current: Partial<Record<Row, number>>,
  ) => {
    const rows = new Set([...Object.keys(previous ?? {}), ...Object.keys(current)]) as Set<Row>;
    return Object.fromEntries(
      [...rows].map((row) => [row, [previous?.[row], current[row]]]),
    ) as Partial<Record<Row, [number | undefined, number | undefined]>>;
  };
  return {
    F10: merge(columns.previous?.F10, columns.current.F10),
    F20: merge(columns.previous?.F20, columns.current.F20),
    F30: merge(columns.previous?.F30, columns.current.F30),
  };
}
