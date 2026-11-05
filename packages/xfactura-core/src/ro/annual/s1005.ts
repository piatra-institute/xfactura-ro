import { DomainError } from '../../errors';
import {
  annualAddressText,
  annualCounties,
  annualOwnerships,
  annualPreparerQualities,
  balanceSheetRules,
  fixedAssetRules,
  ruleBuilder,
  Statement,
  structureOnly,
  total,
  type AnnualAddress,
  type AnnualEntity,
  type AnnualHeader,
  type AnnualPreparerQuality,
  type Cells,
  type FormRows,
  type StatementCheck,
} from './form';
import {
  s1005F10Rows,
  s1005F20Rows,
  s1005F30Rows,
  s1005F40Rows,
  type S1005F10Row,
  type S1005F20Row,
  type S1005F30Row,
  type S1005F40Row,
} from './s1005-rows';

export {
  s1005CaenClasses,
  s1005F10Rows,
  s1005F20Rows,
  s1005F30Rows,
  s1005F40Rows,
  type S1005F10Row,
  type S1005F20Row,
  type S1005F30Row,
  type S1005F40Row,
  type S1005RowSpec,
} from './s1005-rows';

/**
 * The annual financial statements of microentities (S1005, "Situații financiare anuale ...
 * microentități", tipBIL UU) for the financial year 2025: F10 "Bilanț prescurtat", F20 "Contul
 * prescurtat de profit și pierdere", F30 "Date informative" and F40 "Situația activelor
 * imobilizate", under OMF nr. 2036/23.12.2025 (M.Of. nr. 41/20.I.2026) and the formats of OMFP
 * nr. 1.802/2014 (pct. 599 and 601).
 *
 * The XML follows ANAF's structure of 27.01.2026 (structura_SC_1225_270126, "S1005 (UU)") and
 * the schema s1005_20260715.xsd. ANAF's validator for 2025 (DUKIntegrator, S1005Validator J14.0.3
 * of 17.03.2026, package S1005_20260317) maps the period 2025 to its rule set v13, which requires
 * the namespace `mfp:anaf:dgti:s1005:declaratie:v15`; the later schema of 15.07.2026 declares the
 * same namespace and the same F10, F20, F30 and F40, and ANAF's PDF form for 2025
 * (bilant_SC_1225_XML_270326) writes v15 too ("an 2025 :v15"; 2024 was v14). Only 2025 is
 * supported: another year is refused, never guessed. (J14.0.3 also accepts an="2026" under its
 * 2025 rules, but ANAF has published no format for 2026.) The schema leaves out the null rows the
 * validator still knows (F20_3051/3052, F30_3421/3422); they are never written.
 *
 * F10, F20 and F30 are required by OMF nr. 2036/2025 anexa nr. 1 pct. 2.1, F40 accompanies them;
 * the four are always written, and the validator ties F30 to F20 (F20_F30_1–10) and F40 to F10
 * (F10_F40_1–6) whether or not they are present. Every F10 and F20 field is written, an absent one
 * as 0; F30 and F40 fields only when present or computed. The rows the form computes (totals,
 * profit or loss, chapter I of F30 from F20) are filled by completeS1005 when absent and checked
 * when given. totalPlata_A is F10 rd. 29 col. 2, as the structure says; J14.0.3 does not check it.
 *
 * Amounts are whole lei, N(15), and may be negative where the schema allows; the percentages of
 * F30 chapter XII have at most two decimals.
 */

/** The S1005 format for a financial year. */
export type S1005Format = {
  year: number;
  /** xmlns of Bilant1005. */
  namespace: string;
  /** The ANAF validator version known to accept it. */
  validator: string;
  /** ANAF's XML structure and schema it follows. */
  structure: string;
  schema: string;
};

const formats: Readonly<Record<number, S1005Format>> = {
  2025: {
    year: 2025,
    namespace: 'mfp:anaf:dgti:s1005:declaratie:v15',
    validator: 'S1005Validator J14.0.3 (17.03.2026)',
    structure: 'structura_SC_1225_270126 (27.01.2026)',
    schema: 's1005_20260715.xsd (15.07.2026)',
  },
};

const yearMessage = (year: number) =>
  `S1005 se scrie aici doar pentru exercițiul financiar 2025; formatul pentru ${year} nu este cunoscut.`;

/** The format of a financial year; throws for a year without a known format. */
export function s1005Format(year: number): S1005Format {
  const format = formats[year];
  if (!format) throw new DomainError('S1005_YEAR', yearMessage(year));
  return format;
}

/** The namespace of a financial year's S1005; throws for a year without a known format. */
export function s1005Namespace(year: number): string {
  return s1005Format(year).namespace;
}

/** Nomenclator județe (codTT), structura_SC_1225_270126 p. 80; 41 (DGAMC) is codJJ only. */
export const s1005Counties = annualCounties;
/** Nomenclator forme de proprietate (codPP), structura_SC_1225_270126 pp. 80–81. */
export const s1005Ownerships = annualOwnerships;
/** Nomenclator calitate - Întocmit (calit_intocmit), structura_SC_1225_270126 p. 80. */
export const s1005PreparerQualities = annualPreparerQualities;
export type S1005PreparerQuality = AnnualPreparerQuality;

/** The cells of a row, by column: index 0 is column 1. */
export type S1005Cells = Cells;

/** A form's rows with values; absent rows and cells are empty. */
export type S1005Rows<Row extends string> = FormRows<Row>;

/** adresa, written as the structure gives it for the PDF's XML import (annualAddressText). */
export type S1005Address = AnnualAddress;
export type S1005Entity = AnnualEntity;

export type S1005 = AnnualHeader & {
  /** F10, columns [01.01.2025, 31.12.2025]. */
  F10: S1005Rows<S1005F10Row>;
  /** F20, columns [2024, 2025]. */
  F20: S1005Rows<S1005F20Row>;
  /** F30, columns as s1005F30Rows gives them per chapter. */
  F30: S1005Rows<S1005F30Row>;
  /** F40, columns as s1005F40Rows gives them. */
  F40: S1005Rows<S1005F40Row>;
};

/** A check: ANAF's rule code where the structure or the validator names one (F10_59,
 * F20_F30_1…), otherwise S1005_…; an error is what ANAF's validator rejects, a warning what the
 * structure states but the validator J14.0.3 does not apply, or a doubtful value. */
export type S1005Check = StatementCheck;

// ---------------------------------------------------------------------------------------------
// The form's arithmetic controls, as the structure states them (Cod formula) and as the validator
// J14.0.3 applies them (rule set v13; its messages name the same fields).
// ---------------------------------------------------------------------------------------------

const builder = ruleBuilder();
const { rules, compare, columns, split } = builder;

// F10 (structura p. 18–22 and "Formule de calcul suplimentare" for S1005, p. 78).
balanceSheetRules(builder);

// F20_micro (structura p. 29–30).
split(
  ['F20_1', 'F20_3'],
  'F20_0081',
  'F20_0091',
  'F20_0011 + F20_0021 - F20_0031 - F20_0041 - F20_0051 - F20_0061 - F20_0071 + F20_3041',
);
split(
  ['F20_2', 'F20_4'],
  'F20_0082',
  'F20_0092',
  'F20_0012 + F20_0022 - F20_0032 - F20_0042 - F20_0052 - F20_0062 - F20_0072 + F20_3042',
);
columns(['F20a_cif', 'F20b_cif'], 'F20_301# <= F20_001#');

// F10 = F20 (structura p. 78).
compare('F10_F20_1', 'F10_0431 = F20_0081');
compare('F10_F20_2', 'F10_0441 = F20_0091');
compare('F10_F20_3', 'F10_0432 = F20_0082');
compare('F10_F20_4', 'F10_0442 = F20_0092');

// F30 chapter II (structura p. 45–47).
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
(
  [
    ['F30_16', '010'],
    ['F30_17', '011'],
    ['F30_18', '012'],
    ['F30_19', '013'],
    ['F30_20', '014'],
    ['F30_21', '015'],
    ['F30_22', '016'],
    ['F30_23', '017'],
    ['F30_24', '018'],
  ] as const
).forEach(([id, code]) => compare(id, `F30_${code}1 = F30_${code}2 + F30_${code}3`, total));

// F30 chapters VI and VIII (structura p. 48–55).
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
columns(['F30_45', 'F30_46'], 'F30_069# >= F30_070# + F30_071# + F30_072#', structureOnly);
columns(
  ['F30_47', 'F30_48'],
  'F30_076# >= F30_077# + F30_078# + F30_079# + F30_080# + F30_320#',
  structureOnly,
);
columns(['F30_49', 'F30_50'], 'F30_082# = F30_083# + F30_084#', total);
columns(['F30_51', 'F30_52'], 'F30_085# = F30_086# + F30_088#', total);
columns(['F30_53', 'F30_54'], 'F30_090# = F30_091# + F30_092#', total);
columns(
  ['F30_55', 'F30_56'],
  'F30_093# = F30_094# + F30_097# + F30_100# + F30_101# + F30_104# + F30_106# + F30_108# + F30_109# + F30_114# + F30_115# + F30_118# + F30_124#',
  total,
);
columns(['F30_57', 'F30_58'], 'F30_094# = F30_095# + F30_096#', total);
columns(['F30_59', 'F30_60'], 'F30_097# = F30_098# + F30_099#', total);
columns(['F30_61', 'F30_62'], 'F30_101# = F30_102# + F30_103#', total);
columns(['F30_63', 'F30_64'], 'F30_109# = F30_110# + F30_111# + F30_112# + F30_113#', total);
columns(['F30_65', 'F30_66'], 'F30_118# >= F30_119# + F30_120# + F30_121# + F30_122# + F30_123#');
columns(
  ['F30_67', 'F30_68'],
  'F30_126# >= F30_127# + F30_128# + F30_129# + F30_130#',
  structureOnly,
);

// F30 chapter XII (structura p. 56–57).
compare(
  'F30_75',
  'F30_1371 = F30_1381 + F30_1411 + F30_1451 + F30_1461 + F30_1471 + F30_1481',
  total,
);
compare(
  'F30_76',
  'F30_1373 = F30_1383 + F30_1413 + F30_1453 + F30_1463 + F30_1473 + F30_1483',
  total,
);
compare('F30_77', 'F30_1381 = F30_1391 + F30_1401', total);
compare('F30_79', 'F30_1383 = F30_1393 + F30_1403', total);
(
  [
    ['F30_78', 'F30_1382'],
    ['F30_80', 'F30_1384'],
    ['F30_81', 'F30_1392'],
    ['F30_82', 'F30_1394'],
    ['F30_83', 'F30_1402'],
    ['F30_84', 'F30_1404'],
    ['F30_85', 'F30_1412'],
    ['F30_86', 'F30_1414'],
    ['F30_87', 'F30_1422'],
    ['F30_88', 'F30_1424'],
    ['F30_89', 'F30_1432'],
    ['F30_90', 'F30_1434'],
    ['F30_91', 'F30_1442'],
    ['F30_92', 'F30_1444'],
    ['F30_93', 'F30_1452'],
    ['F30_94', 'F30_1454'],
    ['F30_95', 'F30_1462'],
    ['F30_96', 'F30_1464'],
    ['F30_97', 'F30_1472'],
    ['F30_98', 'F30_1474'],
    ['F30_99', 'F30_1482'],
    ['F30_100', 'F30_1484'],
  ] as const
).forEach(([id, field]) => rules.push({ kind: 'percent', id, field }));

// F30 chapter XIX (structura p. 59–66; the order's anexa nr. 4 pct. 6, rd. 180–266).
columns(['F30_101', 'F30_102'], 'F30_167# = F30_168# + F30_169# - F30_170# + F30_172#', total);
rules.push({ kind: 'nonNegative', id: 'F30_103', field: 'F30_1731' });
rules.push({ kind: 'exclusive', id: 'F30_104', fields: ['F30_1731', 'F30_1741'] });
rules.push({ kind: 'nonNegative', id: 'F30_105', field: 'F30_1732' });
rules.push({ kind: 'exclusive', id: 'F30_106', fields: ['F30_1732', 'F30_1742'] });
rules.push({ kind: 'nonNegative', id: 'F30_107', field: 'F30_1741' });
rules.push({ kind: 'nonNegative', id: 'F30_109', field: 'F30_1742' });
columns(
  ['F30_111', 'F30_112'],
  'F30_182# = F30_167# + F30_173# - F30_174# + F30_175# + F30_176# + F30_177# + F30_178# + F30_179#',
  total,
);
columns(['F30_113', 'F30_114'], 'F30_188# = F30_189# + F30_190#', total);
columns(['F30_115', 'F30_116'], 'F30_191# = F30_330# + F30_192# - F30_193#', total);
columns(['F30_117', 'F30_118'], 'F30_194# = F30_195# - F30_196#', total);
columns(
  ['F30_119', 'F30_120'],
  'F30_197# = F30_198# + F30_199# + F30_200# + F30_201# + F30_202# + F30_203# + F30_331# + F30_335# + F30_337# + F30_339#',
  total,
);
columns(['F30_121', 'F30_122'], 'F30_205# = F30_206# - F30_207#', total);
columns(
  ['F30_123', 'F30_124'],
  'F30_208# = F30_183# + F30_184# + F30_185# + F30_186# - F30_187# + F30_188# + F30_191# + F30_194# + F30_197# + F30_205#',
  total,
);
split(['F30_125', 'F30_127'], 'F30_2091', 'F30_2101', 'F30_1821 - F30_2081', 'loss>=0');
split(['F30_126', 'F30_128'], 'F30_2092', 'F30_2102', 'F30_1822 - F30_2082', 'loss>=0');
columns(['F30_129', 'F30_130'], 'F30_218# = F30_211# + F30_213# + F30_215# + F30_216#', total);
columns(['F30_131', 'F30_132'], 'F30_219# = F30_220# - F30_221#', total);
columns(['F30_133', 'F30_134'], 'F30_225# = F30_219# + F30_222# + F30_224#', total);
split(['F30_135', 'F30_137'], 'F30_2261', 'F30_2271', 'F30_2181 - F30_2251');
split(['F30_136', 'F30_138'], 'F30_2262', 'F30_2272', 'F30_2182 - F30_2252');
columns(['F30_139', 'F30_140'], 'F30_228# = F30_182# + F30_218#', total);
columns(['F30_141', 'F30_142'], 'F30_229# = F30_208# + F30_225#', total);
split(['F30_143', 'F30_145'], 'F30_2301', 'F30_2311', 'F30_2281 - F30_2291');
split(['F30_144', 'F30_146'], 'F30_2302', 'F30_2312', 'F30_2282 - F30_2292');
split(
  ['F30_147', 'F30_149'],
  'F30_2351',
  'F30_2361',
  'F30_2301 - F30_2311 - F30_2321 - F30_3411 - F30_2341 - F30_3281 + F30_3291',
  'loss>0',
);
split(
  ['F30_148', 'F30_150'],
  'F30_2352',
  'F30_2362',
  'F30_2302 - F30_2312 - F30_2322 - F30_3412 - F30_2342 - F30_3282 + F30_3292',
  'loss>0',
);
columns(['F30a_cif', 'F30b_cif'], 'F30_325# <= F20_001#');

// F10, F20 = F30 (structura p. 78–79).
compare('F10_F30_4', 'F10_0132 + F10_0162 >= F30_0041');
columns(['F20_F30_1', 'F20_F30_2'], 'F20_001# = F30_167#');
columns(['F20_F30_3', 'F20_F30_4'], 'F20_004# = F30_188#');
columns(['F20_F30_5', 'F20_F30_6'], 'F20_007# = F30_232# + F30_234# + F30_328# + F30_341#');
columns(['F20_F30_5a', 'F20_F30_6a'], 'F20_304# = F30_329#', structureOnly);
columns(['F20_F30_7', 'F20_F30_8'], 'F20_008# = F30_235#');
columns(['F20_F30_9', 'F20_F30_10'], 'F20_009# = F30_236#');

// F40 (structura p. 66–77) and F10 = F40 (p. 79).
fixedAssetRules(builder);

const statement = new Statement({
  prefix: 'S1005',
  root: 'Bilant1005',
  tipBIL: 'UU',
  forms: { F10: s1005F10Rows, F20: s1005F20Rows, F30: s1005F30Rows, F40: s1005F40Rows },
  rules,
  result: { profit: 'F20_0082', loss: 'F20_0092' },
});

/** The XML attribute of a row's column, e.g. F10_3011 for F10 rd. 06a col. 1. */
export function s1005Field(form: 'F10' | 'F20' | 'F30' | 'F40', row: string, column: number) {
  return statement.field(form, row, column);
}

/** Every arithmetic control implemented, by code: the structure's or the validator's. */
export const s1005Controls = statement.controls;

/** The cells of a form S1005 computes from others (`row.column`). */
export const s1005ComputedCells = (form: 'F10' | 'F20' | 'F30' | 'F40') =>
  statement.computedCells(form);

/** adresa as the structure formats it. */
export const s1005AddressText = annualAddressText;

/**
 * The model with every computed row the form defines filled where absent: F10 and F20 totals
 * (absent details counting as 0), F30 chapter I from F20, and the F30 and F40 totals whose terms
 * are given. Given values are kept, and checkS1005 compares them. Throws when the year or a value
 * cannot be used.
 */
export function completeS1005(model: S1005): S1005 {
  s1005Format(model.year);
  const [problem] = statement.inputProblems(model);
  if (problem) throw new DomainError(problem.code, problem.message);
  return statement.modelWith(model, statement.complete(statement.fieldsOf(model)));
}

/**
 * Fast feedback on the form: identification data, the values, and the arithmetic controls the
 * structure and ANAF's validator apply, in Romanian. Computed rows absent from the model are
 * filled first (completeS1005), so only given values can disagree. DUKIntegrator remains the
 * oracle.
 */
export function checkS1005(model: S1005): S1005Check[] {
  const checks: S1005Check[] = [];
  const add = (check: S1005Check) => checks.push(check);
  const known = formats[model.year] !== undefined;
  if (!known)
    add({ code: 'S1005_YEAR', severity: 'error', path: 'year', message: yearMessage(model.year) });
  statement.headerChecks(model, add);
  const problems = statement.inputProblems(model);
  for (const problem of problems) add({ ...problem, severity: 'error' });
  if (!known || problems.length) return checks;
  statement.ruleChecks(statement.complete(statement.fieldsOf(model)), add);
  return checks;
}

/**
 * Writes the statements as one Bilant1005 element: the identification attributes in the schema's
 * order, then F10 and F20 with every field, F30 and F40 with the fields given or computed.
 * Computed rows absent from the model are filled (completeS1005). Throws when the year is not
 * supported or checkS1005 finds an error, so ANAF's validator is not handed a statement it rejects.
 */
export function writeS1005(model: S1005): string {
  const format = s1005Format(model.year);
  const errors = checkS1005(model).filter((check) => check.severity === 'error');
  if (errors.length) throw new DomainError(errors[0]!.code, errors[0]!.message, 422, errors);
  return statement.xml(
    model,
    { namespace: format.namespace, schemaFile: 's1005.xsd' },
    statement.complete(statement.fieldsOf(model)),
  );
}
