import { DomainError } from '../../errors';
import {
  balanceSheetRules,
  fixedAssetRules,
  ruleBuilder,
  Statement,
  total,
  type AnnualHeader,
  type FormRows,
  type StatementCheck,
} from './form';
import { s1005F10Rows, s1005F40Rows, type S1005F10Row, type S1005F40Row } from './s1005-rows';
import { s1003F20Rows, s1003F30Rows, type S1003F20Row, type S1003F30Row } from './s1003-rows';

export {
  s1003F20FromS1005Xix,
  s1003F20Rows,
  s1003F30Rows,
  s1003F30SameAs,
  type S1003F20Row,
  type S1003F30Chapter,
  type S1003F30Row,
} from './s1003-rows';

/**
 * The annual financial statements of small entities (S1003, "Situații financiare anuale ...
 * entități mici", tipBIL BS) for the financial year 2025: F10 "Bilanț prescurtat" (the same form
 * as the microentities', F10_BS), F20 "Contul de profit și pierdere" (OMFP nr. 1.802/2014 pct.
 * 600, rows 1–70), F30 "Date informative" (OMF nr. 2.036/2025 anexa nr. 4 pct. 7, chapters
 * I–XIX of F30_capital_MM, F30_dividende_MM_an and F30_creante_MM_an) and F40 "Situația activelor
 * imobilizate" (anexa nr. 4 pct. 8, the microentities' form), as OMF nr. 2.036/2025 anexa nr. 1
 * pct. 2.2 requires of the entities that are not microentities and do not exceed two of 25.000.000
 * lei total assets, 50.000.000 lei net turnover and 50 employees.
 *
 * The XML follows ANAF's structure of 27.01.2026 (structura_SC_1225_270126, "S1003 (BS)") and the
 * schema s1003_20260210.xsd (namespace `mfp:anaf:dgti:s1003:declaratie:v15`); ANAF's validator for
 * 2025 is S1003Validator J14.0.0 of 10.02.2026 (package S1003_20260210). Only 2025 is supported:
 * ANAF has published no package for 2026, and another year is refused, never guessed. The
 * identification is the microentities' (`AnnualHeader`); F10 and F20 are written with every field,
 * F30 and F40 with the fields given or computed. The null rows of the structure (F20 rd. 01b, 05,
 * 38, 67; F30 rd. 170e, 170f and rd. 165b col. 1) are never written.
 */

export type S1003Format = {
  year: number;
  namespace: string;
  validator: string;
  structure: string;
  schema: string;
};

const formats: Readonly<Record<number, S1003Format>> = {
  2025: {
    year: 2025,
    namespace: 'mfp:anaf:dgti:s1003:declaratie:v15',
    validator: 'S1003Validator J14.0.0 (10.02.2026)',
    structure: 'structura_SC_1225_270126 (27.01.2026)',
    schema: 's1003_20260210.xsd (10.02.2026)',
  },
};

const yearMessage = (year: number) =>
  `S1003 se scrie aici doar pentru exercițiul financiar 2025; ANAF nu a publicat formatul pentru ${year}.`;

/** The format of a financial year; throws for a year without a known format. */
export function s1003Format(year: number): S1003Format {
  const format = formats[year];
  if (!format) throw new DomainError('S1003_YEAR', yearMessage(year));
  return format;
}

export type S1003 = AnnualHeader & {
  /** F10, columns [01.01.2025, 31.12.2025]. */
  F10: FormRows<S1005F10Row>;
  /** F20, columns [2024, 2025]. */
  F20: FormRows<S1003F20Row>;
  /** F30, columns as s1003F30Rows gives them per chapter. */
  F30: FormRows<S1003F30Row>;
  /** F40, columns as s1005F40Rows gives them. */
  F40: FormRows<S1005F40Row>;
};

// ---------------------------------------------------------------------------------------------
// The form's arithmetic controls, as structura_SC_1225_270126 states them for S1003 (BS); the
// line numbers in the comments are those of its text (pdftotext -layout).
// ---------------------------------------------------------------------------------------------

const builder = ruleBuilder();
const { rules, compare, columns, split } = builder;

// F10_BS, shared with S1005.
balanceSheetRules(builder);

columns(['F20_1', 'F20_2'], 'F20_001# = F20_002# + F20_003# - F20_004# + F20_006#', total);
columns(['F20a_cif', 'F20b_cif'], 'F20_301# <= F20_001#');
// F20c_cif / F20d_cif: F20_318# <= F20_001#, but F20_3181 and F20_3182 are null (rd. 01b).
columns(
  ['F20_3', 'F20_4'],
  'F20_016# = F20_001# + F20_007# - F20_008# + F20_009# + F20_010# + F20_011# + F20_012# + F20_013#',
  total,
);
// F20_6 as the structure prints it reads "F20_0221 = F20_0231 + F20_0241" (the column-1 formula).
columns(['F20_5', 'F20_6'], 'F20_022# = F20_023# + F20_024#', total);
columns(['F20_7', 'F20_8'], 'F20_025# = F20_306# + F20_026# - F20_027#', total);
columns(['F20_9', 'F20_10'], 'F20_028# = F20_029# - F20_030#', total);
// F20_0381 / F20_0382 (rd. 38) are null: dropped from the sum.
columns(
  ['F20_11', 'F20_12'],
  'F20_031# = F20_032# + F20_033# + F20_034# + F20_035# + F20_036# + F20_037# + F20_310# + F20_312# + F20_314# + F20_316#',
  total,
);
columns(['F20_13', 'F20_14'], 'F20_039# = F20_040# - F20_041#', total);
columns(
  ['F20_15', 'F20_16'],
  'F20_042# = F20_017# + F20_018# + F20_019# + F20_020# - F20_021# + F20_022# + F20_025# + F20_028# + F20_031# + F20_039#',
  total,
);
split(['F20_17', 'F20_19'], 'F20_0431', 'F20_0441', 'F20_0161 - F20_0421');
split(['F20_18', 'F20_20'], 'F20_0432', 'F20_0442', 'F20_0162 - F20_0422');
columns(['F20_21', 'F20_22'], 'F20_052# = F20_045# + F20_047# + F20_049# + F20_050#', total);
columns(['F20_23', 'F20_24'], 'F20_053# = F20_054# - F20_055#', total);
columns(['F20_25', 'F20_26'], 'F20_059# = F20_053# + F20_056# + F20_058#', total);
split(['F20_27', 'F20_29'], 'F20_0601', 'F20_0611', 'F20_0521 - F20_0591');
split(['F20_28', 'F20_30'], 'F20_0602', 'F20_0612', 'F20_0522 - F20_0592');
columns(['F20_31', 'F20_32'], 'F20_062# = F20_016# + F20_052#', total);
columns(['F20_33', 'F20_34'], 'F20_063# = F20_042# + F20_059#', total);
split(['F20_35', 'F20_37'], 'F20_0641', 'F20_0651', 'F20_0621 - F20_0631');
split(['F20_36', 'F20_38'], 'F20_0642', 'F20_0652', 'F20_0622 - F20_0632');
// v1 = (F20_0641 + F20_3051) - (F20_0651 + F20_0661 + F20_0681 + F20_0671 + F20_3041 + F20_3171):
// F20_0671 / F20_0672 (rd. 67) are null and dropped.
split(
  ['F20_39', 'F20_41'],
  'F20_0691',
  'F20_0701',
  'F20_0641 + F20_3051 - F20_0651 - F20_0661 - F20_0681 - F20_3041 - F20_3171',
);
split(
  ['F20_40', 'F20_42'],
  'F20_0692',
  'F20_0702',
  'F20_0642 + F20_3052 - F20_0652 - F20_0662 - F20_0682 - F20_3042 - F20_3172',
);

// ---------------------------------------------------------------------------------------------
// F30_capital_MM chapter II (structura lines 1616–1715): "suma pe rand" (col. 1 = col. 2 + col. 3)
// and "suma pe coloana" (a total row = its rows). A total row's col. 1 is defined by its row sum,
// so its column-sum rule (F30_2, F30_6, F30_13) checks only.
// ---------------------------------------------------------------------------------------------

compare('F30_1', 'F30_0041 = F30_0042 + F30_0043', total);
compare('F30_2', 'F30_0041 = F30_0051 + F30_0091 + F30_0151 + F30_0161 + F30_0171 + F30_0181');
compare(
  'F30_3',
  'F30_0042 = F30_0052 + F30_0092 + F30_0152 + F30_0162 + F30_0172 + F30_0182',
  total,
);
compare(
  'F30_4',
  'F30_0043 = F30_0053 + F30_0093 + F30_0153 + F30_0163 + F30_0173 + F30_0183',
  total,
);
compare('F30_5', 'F30_0051 = F30_0052 + F30_0053', total);
compare('F30_6', 'F30_0051 = F30_0061 + F30_0071 + F30_0081');
compare('F30_7', 'F30_0052 = F30_0062 + F30_0072 + F30_0082', total);
compare('F30_8', 'F30_0053 = F30_0063 + F30_0073 + F30_0083', total);
compare('F30_9', 'F30_0061 = F30_0062 + F30_0063', total);
compare('F30_10', 'F30_0071 = F30_0072 + F30_0073', total);
compare('F30_11', 'F30_0081 = F30_0082 + F30_0083', total);
compare('F30_12', 'F30_0091 = F30_0092 + F30_0093', total);
compare('F30_13', 'F30_0091 = F30_0101 + F30_0111 + F30_0121 + F30_0131 + F30_0141');
compare('F30_14', 'F30_0092 = F30_0102 + F30_0112 + F30_0122 + F30_0132 + F30_0142', total);
compare('F30_15', 'F30_0093 = F30_0103 + F30_0113 + F30_0123 + F30_0133 + F30_0143', total);
compare('F30_16', 'F30_0101 = F30_0102 + F30_0103', total);
compare('F30_17', 'F30_0111 = F30_0112 + F30_0113', total);
compare('F30_18', 'F30_0121 = F30_0122 + F30_0123', total);
compare('F30_19', 'F30_0131 = F30_0132 + F30_0133', total);
compare('F30_20', 'F30_0141 = F30_0142 + F30_0143', total);
compare('F30_21', 'F30_0151 = F30_0152 + F30_0153', total);
compare('F30_22', 'F30_0161 = F30_0162 + F30_0163', total);
compare('F30_23', 'F30_0171 = F30_0172 + F30_0173', total);
// rd. 17a (F30_3011 = F30_3012 + F30_3013): computed by the form, no code in the structure.
compare('F30_24', 'F30_0181 = F30_0182 + F30_0183', total);

// ---------------------------------------------------------------------------------------------
// F30_capital_MM chapters VI and VIII (structura lines 1783–2119).
// ---------------------------------------------------------------------------------------------

columns(['F30_33', 'F30_34'], 'F30_039# = F30_040# + F30_041#', total);
columns(['F30_35', 'F30_36'], 'F30_042# = F30_043# + F30_044#', total);
columns(['F30_37', 'F30_38'], 'F30_048# = F30_049# + F30_054#', total);
columns(['F30_39', 'F30_40'], 'F30_049# = F30_050# + F30_051# + F30_052# + F30_053#', total);
columns(['F30_41', 'F30_42'], 'F30_054# = F30_055# + F30_056#', total);
columns(
  ['F30_43', 'F30_44'],
  'F30_061# = F30_062# + F30_063# + F30_064# + F30_065# + F30_066#',
  total,
);
columns(['F30_45', 'F30_46'], 'F30_071# >= F30_072# + F30_073# + F30_074#');
columns(['F30_47', 'F30_48'], 'F30_078# >= F30_079# + F30_080# + F30_081# + F30_082# + F30_320#');
columns(['F30_49', 'F30_50'], 'F30_084# = F30_085# + F30_086#', total);
columns(['F30_51', 'F30_52'], 'F30_087# = F30_088# + F30_090#', total);
columns(['F30_53', 'F30_54'], 'F30_092# = F30_093# + F30_094#', total);
columns(
  ['F30_55', 'F30_56'],
  'F30_095# = F30_096# + F30_099# + F30_102# + F30_103# + F30_106# + F30_108# + F30_110# + F30_111# + F30_116# + F30_119# + F30_122# + F30_128#',
  total,
);
columns(['F30_57', 'F30_58'], 'F30_096# = F30_097# + F30_098#', total);
columns(['F30_59', 'F30_60'], 'F30_099# = F30_100# + F30_101#', total);
columns(['F30_61', 'F30_62'], 'F30_103# = F30_104# + F30_105#', total);
columns(['F30_63', 'F30_64'], 'F30_111# = F30_112# + F30_113# + F30_114# + F30_115#', total);
columns(['F30_65', 'F30_66'], 'F30_122# >= F30_123# + F30_124# + F30_125# + F30_126# + F30_127#');

// ---------------------------------------------------------------------------------------------
// F30_capital_MM chapter XII (structura lines 2189–2250): amounts (col. 1, 3) and percentages
// (col. 2, 4; N(3.2), <= 100).
// ---------------------------------------------------------------------------------------------

compare(
  'F30_75',
  'F30_1411 = F30_1421 + F30_1451 + F30_1491 + F30_1501 + F30_1511 + F30_1521',
  total,
);
compare(
  'F30_76',
  'F30_1413 = F30_1423 + F30_1453 + F30_1493 + F30_1503 + F30_1513 + F30_1523',
  total,
);
compare('F30_77', 'F30_1421 = F30_1431 + F30_1441', total);
rules.push({ kind: 'percent', id: 'F30_78', field: 'F30_1422' });
compare('F30_79', 'F30_1423 = F30_1433 + F30_1443', total);
rules.push({ kind: 'percent', id: 'F30_80', field: 'F30_1424' });
rules.push({ kind: 'percent', id: 'F30_81', field: 'F30_1432' });
rules.push({ kind: 'percent', id: 'F30_82', field: 'F30_1434' });
rules.push({ kind: 'percent', id: 'F30_83', field: 'F30_1442' });
rules.push({ kind: 'percent', id: 'F30_84', field: 'F30_1444' });
rules.push({ kind: 'percent', id: 'F30_85', field: 'F30_1452' });
rules.push({ kind: 'percent', id: 'F30_86', field: 'F30_1454' });
rules.push({ kind: 'percent', id: 'F30_87', field: 'F30_1462' });
rules.push({ kind: 'percent', id: 'F30_88', field: 'F30_1464' });
rules.push({ kind: 'percent', id: 'F30_89', field: 'F30_1472' });
rules.push({ kind: 'percent', id: 'F30_90', field: 'F30_1474' });
rules.push({ kind: 'percent', id: 'F30_91', field: 'F30_1482' });
rules.push({ kind: 'percent', id: 'F30_92', field: 'F30_1484' });
rules.push({ kind: 'percent', id: 'F30_93', field: 'F30_1492' });
rules.push({ kind: 'percent', id: 'F30_94', field: 'F30_1494' });
rules.push({ kind: 'percent', id: 'F30_95', field: 'F30_1502' });
rules.push({ kind: 'percent', id: 'F30_96', field: 'F30_1504' });
rules.push({ kind: 'percent', id: 'F30_97', field: 'F30_1512' });
rules.push({ kind: 'percent', id: 'F30_98', field: 'F30_1514' });
rules.push({ kind: 'percent', id: 'F30_99', field: 'F30_1522' });
rules.push({ kind: 'percent', id: 'F30_100', field: 'F30_1524' });

// F30_dividende_MM_an (chapters XIII–XVI, structura lines 2254–2314) and F30_creante_MM_an
// (chapters XVII–XIX, lines 2315–2356) state no arithmetic control (F30_3151 = null).

// ---------------------------------------------------------------------------------------------
// Between forms, S1003 (structura lines 4015–4069). Its F10_63, F10_64, F10_66 and F10_67 are the
// balance sheet's (S1005's F10 rules, not repeated).
// ---------------------------------------------------------------------------------------------

compare('F10_F20_1', 'F10_0431 = F20_0691');
compare('F10_F20_2', 'F10_0441 = F20_0701');
compare('F10_F20_3', 'F10_0432 = F20_0692');
compare('F10_F20_4', 'F10_0442 = F20_0702');
// F10_F30_1–F10_F30_3: F30 chapter I follows the current year's net result in F20 (column 2 only):
// - F10_F30_1, if F20_0692 > 0 (profit): F30_0011 = 1, F30_0012 = F20_0692, F30_0021 = 0,
//   F30_0022 = 0, F30_0031 = 0, F30_0032 = 0;
// - F10_F30_2, if F20_0702 > 0 (loss): F30_0021 = 1, F30_0022 = F20_0702, F30_0011 = 0,
//   F30_0012 = 0, F30_0031 = 0, F30_0032 = 0;
// - F10_F30_3, if F20_0692 = F20_0702 = 0: F30_0011 = 0, F30_0012 = 0, F30_0021 = 0,
//   F30_0022 = 0, F30_0031 = 1, F30_0032 = 0.
compare('F10_F30_4', 'F10_0132 + F10_0162 >= F30_0041');

// F40, shared with S1005, and F10 = F40 (F10_F40_1–6 of the S1003 section).
fixedAssetRules(builder);

const statement = new Statement({
  prefix: 'S1003',
  root: 'Bilant1003',
  tipBIL: 'BS',
  forms: { F10: s1005F10Rows, F20: s1003F20Rows, F30: s1003F30Rows, F40: s1005F40Rows },
  rules,
  // F10_F30_1–3: chapter I follows F20's net result, rd. 69 and 70 col. 2.
  result: { profit: 'F20_0692', loss: 'F20_0702' },
});

/** The XML attribute of a row's column, e.g. F20_3012 for F20 rd. 01a col. 2. */
export function s1003Field(form: 'F10' | 'F20' | 'F30' | 'F40', row: string, column: number) {
  return statement.field(form, row, column);
}

/** Every arithmetic control implemented, by code. */
export const s1003Controls = statement.controls;

/** The cells of a form S1003 computes from others (`row.column`). */
export const s1003ComputedCells = (form: 'F10' | 'F20' | 'F30' | 'F40') =>
  statement.computedCells(form);

/** The model with every computed row filled where absent (totals, results, chapter I). */
export function completeS1003(model: S1003): S1003 {
  s1003Format(model.year);
  const [problem] = statement.inputProblems(model);
  if (problem) throw new DomainError(problem.code, problem.message);
  return statement.modelWith(model, statement.complete(statement.fieldsOf(model)));
}

/** Fast feedback on the form, in Romanian; DUKIntegrator remains the oracle. */
export function checkS1003(model: S1003): StatementCheck[] {
  const checks: StatementCheck[] = [];
  const add = (check: StatementCheck) => checks.push(check);
  const known = formats[model.year] !== undefined;
  if (!known)
    add({ code: 'S1003_YEAR', severity: 'error', path: 'year', message: yearMessage(model.year) });
  statement.headerChecks(model, add);
  const problems = statement.inputProblems(model);
  for (const problem of problems) add({ ...problem, severity: 'error' });
  if (!known || problems.length) return checks;
  statement.ruleChecks(statement.complete(statement.fieldsOf(model)), add);
  return checks;
}

/** Writes the statements as one Bilant1003 element; throws when checkS1003 finds an error. */
export function writeS1003(model: S1003): string {
  const format = s1003Format(model.year);
  const errors = checkS1003(model).filter((check) => check.severity === 'error');
  if (errors.length) throw new DomainError(errors[0]!.code, errors[0]!.message, 422, errors);
  return statement.xml(
    model,
    { namespace: format.namespace, schemaFile: 's1003.xsd' },
    statement.complete(statement.fieldsOf(model)),
  );
}
