import { DomainError } from '../../errors';
import { element, serializeXml } from '../../xml/write';
import { isValidCnp, isValidCui } from '../identifiers';
import {
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

export {
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
 * supported: another year is refused, never guessed.
 *
 * F10, F20 and F30 are required by OMF nr. 2036/2025 anexa nr. 1 pct. 2.1, F40 accompanies them;
 * the four are always written. Every F10 and F20 field is written, an absent one as 0; F30 and F40
 * fields only when present or computed. The rows the form computes (totals, profit or loss,
 * chapter I of F30 from F20) are filled by completeS1005 when absent and checked when given.
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
export const s1005Counties = [
  [1, 'Alba'],
  [2, 'Arad'],
  [3, 'Argeș'],
  [4, 'Bacău'],
  [5, 'Bihor'],
  [6, 'Bistrița-Năsăud'],
  [7, 'Botoșani'],
  [8, 'Brașov'],
  [9, 'Brăila'],
  [10, 'Buzău'],
  [11, 'Caraș-Severin'],
  [51, 'Călărași'],
  [12, 'Cluj'],
  [13, 'Constanța'],
  [14, 'Covasna'],
  [15, 'Dâmbovița'],
  [16, 'Dolj'],
  [17, 'Galați'],
  [52, 'Giurgiu'],
  [18, 'Gorj'],
  [19, 'Harghita'],
  [20, 'Hunedoara'],
  [21, 'Ialomița'],
  [22, 'Iași'],
  [23, 'Ilfov'],
  [24, 'Maramureș'],
  [25, 'Mehedinți'],
  [26, 'Mureș'],
  [27, 'Neamț'],
  [28, 'Olt'],
  [29, 'Prahova'],
  [30, 'Satu Mare'],
  [31, 'Sălaj'],
  [32, 'Sibiu'],
  [33, 'Suceava'],
  [34, 'Teleorman'],
  [35, 'Timiș'],
  [36, 'Tulcea'],
  [37, 'Vaslui'],
  [38, 'Vâlcea'],
  [39, 'Vrancea'],
  [40, 'Municipiul București'],
] as const;

/** Nomenclator forme de proprietate (codPP), structura_SC_1225_270126 pp. 80–81. */
export const s1005Ownerships = [
  [11, 'Regii autonome'],
  [12, 'Societăți cu capital integral de stat'],
  [13, 'Institute naționale de cercetare-dezvoltare'],
  [14, 'Companii și societăți naționale'],
  [
    15,
    'Societăți reprezentând filiale ale unor societăți cu capital integral de stat și societăți la care una sau mai multe societăți cu capital integral de stat dețin capitalul social',
  ],
  [16, 'Alte unități economice de stat netransformate în societăți sau regii autonome'],
  [21, 'Societăți cu capital de stat autohton și de stat străin (capital de stat sub 50%)'],
  [22, 'Societăți cu capital de stat și privat autohton și străin (capital de stat sub 50%)'],
  [23, 'Societăți cu capital de stat și privat autohton (capital de stat sub 50%)'],
  [24, 'Societăți cu capital de stat și privat străin (capital de stat sub 50%)'],
  [25, 'Societăți cu capital de stat autohton și de stat străin (capital de stat >= 50%)'],
  [26, 'Societăți cu capital de stat și privat autohton și străin (capital de stat >= 50%)'],
  [27, 'Societăți cu capital de stat și privat autohton (capital de stat >= 50%)'],
  [28, 'Societăți cu capital de stat și privat străin (capital de stat >= 50%)'],
  [
    29,
    'Societăți reprezentând filiale ale unor societăți cu capital de stat de peste 50%, inclusiv, și societăți la care una sau mai multe societăți cu capital de stat de peste 50%, inclusiv, dețin între 50% și 100% din capitalul social al acestora',
  ],
  [31, 'Societăți în nume colectiv'],
  [32, 'Societăți în comandită simplă'],
  [33, 'Societăți în comandită pe acțiuni'],
  [34, 'Societăți pe acțiuni'],
  [35, 'Societăți cu răspundere limitată'],
  [36, 'Societăți agricole'],
  [37, 'Societăți cu capital de stat, privatizate în cursul anului de raportare'],
  [41, 'Cooperative de consum'],
  [42, 'Cooperative meșteșugărești'],
  [43, 'Cooperative și asociații agricole netransformate'],
  [44, 'Cooperative de credit'],
  [50, 'Societăți aparținând organizațiilor și instituțiilor politice și obștești'],
] as const;

/** Nomenclator calitate - Întocmit (calit_intocmit), structura_SC_1225_270126 p. 80. */
export const s1005PreparerQualities = [
  [11, 'Director economic'],
  [12, 'Contabil șef'],
  [13, 'Altă persoană împuternicită, potrivit legii'],
  [21, 'Persoane fizice autorizate, membre CECCAR'],
  [22, 'Persoane juridice autorizate, membre CECCAR'],
] as const;
export type S1005PreparerQuality = (typeof s1005PreparerQualities)[number][0];

/** The cells of a row, by column: index 0 is column 1. */
export type S1005Cells = readonly (number | undefined)[];

/** A form's rows with values; absent rows and cells are empty. */
export type S1005Rows<Row extends string> = Partial<Record<Row, S1005Cells>>;

/** adresa, written as the structure gives it for the PDF's XML import: 'Sector:x,Localitate:xxx,
 * Strada:xxx,Nr.:xxx,Bloc:xxx,Scara:xxx,Ap.:xxx,', absent parts left out. The county is codTT. */
export type S1005Address = {
  /** Bucharest's sector, 1–6. */
  sector?: number;
  locality: string;
  street?: string;
  number?: string;
  block?: string;
  staircase?: string;
  apartment?: string;
};

export type S1005Entity = {
  /** cui: digits only, without the RO prefix. */
  cui: string;
  /** den, C(50). */
  name: string;
  address: S1005Address;
  /** telefon, C(15). */
  phone?: string;
  /** regCom, "Număr de înregistrare din registrul comerțului", C(18). */
  tradeRegister: string;
  /** codTT: the county of the registered office (s1005Counties). */
  county: number;
  /** codPP: the form of ownership (s1005Ownerships). */
  ownership: number;
  /** caen: the CAEN class of the main activity, four digits. */
  caen: string;
  /** caenE: the CAEN class of the main activity actually carried out. */
  caenActual: string;
  /** AN_CAEN: the CAEN revision the classes belong to, 2024 or 2025. */
  caenVersion: 2024 | 2025;
  /** codLEI: the Legal Entity Identifier (ISO 17442), 20 characters. */
  lei?: string;
  /** bifaMC: a large taxpayer filing in Bucharest; codJJ becomes 41. */
  largeTaxpayer: boolean;
  /** bifaDD: a branch (sucursală). */
  branch: boolean;
  /** bifaGG: an economic interest group (GIE). */
  economicInterestGroup: boolean;
  /** bifaAA: net assets below half of the subscribed capital. */
  netAssetsBelowHalfCapital: boolean;
};

export type S1005 = {
  /** an: the financial year; luna is 12. */
  year: number;
  entity: S1005Entity;
  /** nume_admin: the legal representative (administrator or person in charge of management). */
  administrator: string;
  /** The person who prepared the statements. */
  preparer: {
    /** nume_intocmit, C(75). */
    name: string;
    /** calit_intocmit. */
    quality: S1005PreparerQuality;
    /** nri_intocmit: the registration number in the professional body, C(15). */
    membership?: string;
    /** cif_intocmit: the CECCAR member's CNP or CUI, required for qualities 21 and 22 only. */
    cif?: string;
  };
  /** d_audit: the statements are audited by law (1), by option (2) or verified by censors (3). */
  audit?: {
    kind: 'statutory' | 'voluntary' | 'censors';
    /** den_audi, nr_audi (Registrul CAFR), cif_audi. */
    auditor?: { name: string; registration?: string; cif?: string };
  };
  /** d_audit_intern: the entity has an internal audit function organised under the law. */
  internalAudit?: boolean;
  /** bifa_aprob: the statements were approved under the law; the structure accepts only 1. */
  approved: boolean;
  /** F10, columns [01.01.2025, 31.12.2025]. */
  F10: S1005Rows<S1005F10Row>;
  /** F20, columns [2024, 2025]. */
  F20: S1005Rows<S1005F20Row>;
  /** F30, columns as s1005F30Rows gives them per chapter. */
  F30: S1005Rows<S1005F30Row>;
  /** F40, columns as s1005F40Rows gives them. */
  F40: S1005Rows<S1005F40Row>;
};

export type S1005Check = {
  /** ANAF's rule code where the structure or the validator names one (F10_59, F20_F30_1…),
   * otherwise S1005_…. */
  code: string;
  /** error: ANAF's validator rejects it; warning: the structure states it but the validator J14.0.3
   * does not apply it, or the value is doubtful. */
  severity: 'error' | 'warning';
  path: string;
  message: string;
};

type FormId = 'F10' | 'F20' | 'F30' | 'F40';
const forms: Readonly<Record<FormId, readonly S1005RowSpec[]>> = {
  F10: s1005F10Rows,
  F20: s1005F20Rows,
  F30: s1005F30Rows,
  F40: s1005F40Rows,
};
const formIds: readonly FormId[] = ['F10', 'F20', 'F30', 'F40'];

/** The XML attribute of a row's column, e.g. F10_3011 for F10 rd. 06a col. 1. */
export function s1005Field(form: FormId, row: string, column: number): string {
  const spec = forms[form].find((item) => item.row === row);
  if (!spec || !spec.columns.includes(column))
    throw new DomainError('S1005_FIELD', `${form} nu are rândul ${row} coloana ${column}.`);
  return `${form}_${spec.code}${column}`;
}

type Place = { form: FormId; row: string; column: number };
const places = new Map<string, Place>();
for (const form of formIds)
  for (const spec of forms[form])
    for (const column of spec.columns)
      places.set(`${form}_${spec.code}${column}`, { form, row: spec.row, column });

const pathOf = (field: string) => {
  const place = places.get(field);
  return place ? `${place.form}.${place.row}.${place.column}` : field;
};

/** F30 chapter XII percentages: N(3.2), 0–100. */
const percentFields = new Set(
  s1005F30Rows
    .filter((spec) => spec.chapter === 'XII')
    .flatMap((spec) =>
      spec.columns.filter((column) => column % 2 === 0).map((c) => `F30_${spec.code}${c}`),
    ),
);
const maxAmount = 999_999_999_999_999;

// ---------------------------------------------------------------------------------------------
// The form's arithmetic controls, as the structure states them (Cod formula) and as the validator
// J14.0.3 applies them (rule set v13; its messages name the same fields).
// ---------------------------------------------------------------------------------------------

type Term = { sign: 1n | -1n; field: string };
type Op = '=' | '>=' | '<=';
type Severity = S1005Check['severity'];
type Rule =
  | {
      kind: 'compare';
      id: string;
      text: string;
      left: Term[];
      op: Op;
      right: Term[];
      /** A total the form computes: completeS1005 fills it when absent. */
      defines: boolean;
      severity: Severity;
    }
  | {
      /** Rows that exclude each other: profit = Σ when positive, loss = -Σ when positive. */
      kind: 'split';
      ids: [string, string];
      text: string;
      profit: string;
      loss: string;
      terms: Term[];
    }
  | { kind: 'nonNegative'; id: string; field: string }
  | { kind: 'exclusive'; id: string; fields: [string, string] }
  | { kind: 'percent'; id: string; field: string };

function parseSide(text: string): Term[] {
  const tokens = text
    .replace(/([+-])/g, ' $1 ')
    .trim()
    .split(/\s+/);
  if (tokens.length === 1 && tokens[0] === '0') return [];
  const terms: Term[] = [];
  let sign: 1n | -1n = 1n;
  for (const token of tokens) {
    if (token === '+') sign = 1n;
    else if (token === '-') sign = -1n;
    else {
      if (!/^F[1-4]0_\d{4}$/.test(token)) throw new Error(`S1005 rule term ${token}`);
      terms.push({ sign, field: token });
      sign = 1n;
    }
  }
  return terms;
}

const rules: Rule[] = [];
type Options = { defines?: boolean; severity?: Severity };

function compare(id: string, text: string, options: Options = {}) {
  const match = /^(.*?)\s*(>=|<=|=)\s*(.*)$/.exec(text);
  if (!match) throw new Error(`S1005 rule ${id}`);
  const left = parseSide(match[1]!);
  if (options.defines && (left.length !== 1 || left[0]!.sign !== 1n))
    throw new Error(`S1005 rule ${id} defines no single field`);
  rules.push({
    kind: 'compare',
    id,
    text,
    left,
    op: match[2] as Op,
    right: parseSide(match[3]!),
    defines: options.defines ?? false,
    severity: options.severity ?? 'error',
  });
}
/** One rule per column: `#` stands for the column. */
function columns(ids: readonly string[], template: string, options: Options = {}) {
  ids.forEach((id, index) => compare(id, template.replace(/#/g, String(index + 1)), options));
}
function split(ids: [string, string], profit: string, loss: string, terms: string) {
  rules.push({
    kind: 'split',
    ids,
    text: `${profit} - ${loss} = ${terms}`,
    profit,
    loss,
    terms: parseSide(terms),
  });
}
const total = { defines: true } as const;
const structureOnly = { severity: 'warning' } as const;

// F10 (structura p. 18–22 and "Formule de calcul suplimentare" for S1005, p. 78).
columns(['F10_1', 'F10_2'], 'F10_004# = F10_001# + F10_002# + F10_003#', total);
columns(['F10_68', 'F10_69'], 'F10_006# = F10_301# + F10_302#', total);
columns(['F10_3', 'F10_4'], 'F10_009# = F10_005# + F10_006# + F10_007# + F10_008#', total);
columns(['F10_5', 'F10_6'], 'F10_010# = F10_011# + F10_012#', total);
columns(
  ['F10_7', 'F10_8'],
  'F10_014# = F10_009# + F10_011# - F10_013# - F10_020# - F10_023# - F10_026#',
  total,
);
columns(['F10_9', 'F10_10'], 'F10_015# = F10_004# + F10_012# + F10_014#', total);
columns(['F10_11', 'F10_12'], 'F10_018# = F10_019# + F10_022# + F10_025# + F10_028#', total);
columns(['F10_13', 'F10_14'], 'F10_019# = F10_020# + F10_021#', total);
columns(['F10_15', 'F10_16'], 'F10_022# = F10_023# + F10_024#', total);
columns(['F10_17', 'F10_18'], 'F10_025# = F10_026# + F10_027#', total);
columns(
  ['F10_19', 'F10_20'],
  'F10_029# = F10_030# + F10_031# + F10_032# + F10_033# + F10_034#',
  total,
);
(
  [
    ['F10_21', 'F10_0301'],
    ['F10_22', 'F10_0302'],
    ['F10_23', 'F10_0311'],
    ['F10_24', 'F10_0312'],
    ['F10_25', 'F10_0321'],
    ['F10_26', 'F10_0322'],
    ['F10_27', 'F10_0331'],
    ['F10_28', 'F10_0332'],
    ['F10_28_1', 'F10_0341'],
    ['F10_29', 'F10_0342'],
    ['F10_30', 'F10_0351'],
    ['F10_31', 'F10_0352'],
    ['F10_32', 'F10_0361'],
    ['F10_33', 'F10_0362'],
    ['F10_34', 'F10_0371'],
    ['F10_35', 'F10_0372'],
    ['F10_36', 'F10_0381'],
    ['F10_37', 'F10_0382'],
    ['F10_38', 'F10_0391'],
    ['F10_38_1', 'F10_0392'],
    ['F10_39', 'F10_0401'],
    ['F10_40', 'F10_0402'],
    ['F10_41', 'F10_0411'],
    ['F10_43', 'F10_0412'],
    ['F10_45', 'F10_0421'],
    ['F10_47', 'F10_0422'],
    ['F10_49', 'F10_0431'],
    ['F10_51', 'F10_0432'],
    ['F10_53', 'F10_0441'],
    ['F10_55', 'F10_0442'],
    ['F10_57', 'F10_0451'],
    ['F10_58', 'F10_0452'],
  ] as const
).forEach(([id, field]) => rules.push({ kind: 'nonNegative', id, field }));
rules.push({ kind: 'exclusive', id: 'F10_42', fields: ['F10_0411', 'F10_0421'] });
rules.push({ kind: 'exclusive', id: 'F10_44', fields: ['F10_0412', 'F10_0422'] });
rules.push({ kind: 'exclusive', id: 'F10_50', fields: ['F10_0431', 'F10_0441'] });
rules.push({ kind: 'exclusive', id: 'F10_52', fields: ['F10_0432', 'F10_0442'] });
columns(
  ['F10_59', 'F10_60'],
  'F10_046# = F10_029# + F10_035# + F10_036# + F10_037# - F10_038# + F10_039# - F10_040# + F10_041# - F10_042# + F10_043# - F10_044# - F10_045#',
  total,
);
columns(['F10_61', 'F10_62'], 'F10_049# = F10_046# + F10_047# + F10_048#', total);
columns(
  ['F10_63', 'F10_64'],
  'F10_049# = F10_004# + F10_009# + F10_010# - F10_013# - F10_016# - F10_017# - F10_018#',
);
columns(['F10_66', 'F10_67'], 'F10_029# + F10_037# >= 0');

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
split(['F30_125', 'F30_127'], 'F30_2091', 'F30_2101', 'F30_1821 - F30_2081');
split(['F30_126', 'F30_128'], 'F30_2092', 'F30_2102', 'F30_1822 - F30_2082');
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
);
split(
  ['F30_148', 'F30_150'],
  'F30_2352',
  'F30_2362',
  'F30_2302 - F30_2312 - F30_2322 - F30_3412 - F30_2342 - F30_3282 + F30_3292',
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

// F40 (structura p. 66–77): each row's closing column ("suma pe rand"), then the totals by column
// ("suma pe coloana"), under the structure's codes F40_1–F40_90 (the validator prints the same,
// e.g. F40_14, F40_27). The row sum of rd. 35 has no code in the structure: it is F40_0354.
const f40 = (row: number, column: number) => `F40_0${String(row).padStart(2, '0')}${column}`;
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);
const sumOf = (rows: readonly number[], column: number) =>
  rows.map((row) => f40(row, column)).join(' + ');
const code = (n: number) => `F40_${n}`;
const f40RowCodes: Readonly<Record<number, string>> = {
  ...Object.fromEntries(range(1, 6).map((row) => [row, code(row)])),
  7: code(10),
  ...Object.fromEntries(range(8, 17).map((row) => [row, code(row + 4)])),
  18: code(26),
  19: code(28),
  20: code(33),
  ...Object.fromEntries(range(21, 24).map((row) => [row, code(row + 14)])),
  25: 'F40_38_1',
  26: code(42),
  ...Object.fromEntries(range(27, 33).map((row) => [row, code(row + 17)])),
  34: code(54),
  35: 'F40_0354',
  ...Object.fromEntries(range(36, 39).map((row) => [row, code(row + 25)])),
  40: code(68),
  ...Object.fromEntries(range(41, 50).map((row) => [row, code(row + 29)])),
  51: code(83),
  52: code(85),
  53: code(89),
};
const f40Totals: readonly [number, readonly number[], readonly (readonly [number, number])[]][] = [
  // [total row, rows added, [column, code] per column the sum defines]
  [
    7,
    range(1, 6),
    [
      [1, 7],
      [2, 8],
      [3, 9],
      [5, 11],
    ],
  ],
  [
    18,
    range(8, 17),
    [
      [1, 22],
      [2, 23],
      [3, 24],
      [5, 27],
    ],
  ],
  [
    26,
    range(21, 25),
    [
      [1, 39],
      [2, 40],
      [3, 41],
      [4, 43],
    ],
  ],
  [
    34,
    range(27, 33),
    [
      [1, 51],
      [2, 52],
      [3, 53],
      [4, 55],
    ],
  ],
  [
    35,
    [26, 34],
    [
      [1, 56],
      [2, 57],
      [3, 58],
      [4, 59],
    ],
  ],
  [
    40,
    range(36, 39),
    [
      [1, 65],
      [2, 66],
      [3, 67],
      [4, 69],
    ],
  ],
  [
    51,
    range(41, 50),
    [
      [1, 80],
      [2, 81],
      [3, 82],
      [4, 84],
    ],
  ],
  [
    53,
    [40, 51, 52],
    [
      [1, 86],
      [2, 87],
      [3, 88],
      [4, 90],
    ],
  ],
  [
    20,
    [7, 18, 19],
    [
      [1, 29],
      [2, 30],
      [3, 31],
      [5, 34],
    ],
  ],
];
const f40TotalRows = new Set(f40Totals.map(([row]) => row));
for (const row of range(1, 53)) {
  const last = row <= 20 ? 5 : 4;
  compare(
    f40RowCodes[row]!,
    `${f40(row, last)} = ${f40(row, 1)} + ${f40(row, 2)} - ${f40(row, 3)}`,
    f40TotalRows.has(row) ? {} : total,
  );
}
for (const [row, added, sums] of f40Totals)
  for (const [column, n] of sums)
    compare(code(n), `${f40(row, column)} = ${sumOf(added, column)}`, total);
compare(code(25), `F40_0184 = ${sumOf(range(9, 17), 4)}`, total);
// The validator's F40_32 compares F40_0184 with itself; the structure means rd. 20 col. 4.
compare(code(32), 'F40_0204 = F40_0184', { defines: true, severity: 'warning' });

// F10 = F40 (structura p. 79).
compare('F10_F40_1', 'F10_0011 = F40_0071 - F40_0261 - F40_0401');
compare('F10_F40_2', 'F10_0012 = F40_0075 - F40_0264 - F40_0404');
compare('F10_F40_3', 'F10_0021 = F40_0181 - F40_0341 - F40_0511');
compare('F10_F40_4', 'F10_0022 = F40_0185 - F40_0344 - F40_0514');
compare('F10_F40_5', 'F10_0031 = F40_0191 - F40_0521');
compare('F10_F40_6', 'F10_0032 = F40_0195 - F40_0524');

/** Every arithmetic control implemented, by code: the structure's or the validator's. */
export const s1005Controls: readonly { code: string; text: string; severity: Severity }[] =
  rules.flatMap((rule) => {
    switch (rule.kind) {
      case 'compare':
        return [{ code: rule.id, text: rule.text, severity: rule.severity }];
      case 'split':
        return rule.ids.map((code) => ({ code, text: rule.text, severity: 'error' as const }));
      case 'nonNegative':
        return [{ code: rule.id, text: `${rule.field} >= 0`, severity: 'error' as const }];
      case 'exclusive':
        return [
          {
            code: rule.id,
            text: `${rule.fields[0]} și ${rule.fields[1]} nu pot fi ambele > 0`,
            severity: 'error' as const,
          },
        ];
      case 'percent':
        return [{ code: rule.id, text: `${rule.field} <= 100`, severity: 'error' as const }];
    }
  });

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

type Problem = { code: string; path: string; message: string };

const isAmount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= maxAmount;
const isPercent = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 100 &&
  Math.abs(Math.round(value * 100) - value * 100) < 1e-9;

/** Rows, columns and values calculations cannot use. */
function inputProblems(model: S1005): Problem[] {
  const problems: Problem[] = [];
  for (const form of formIds) {
    const values = (model[form] ?? {}) as Record<string, S1005Cells | undefined>;
    for (const [row, cells] of Object.entries(values)) {
      if (cells === undefined) continue;
      const spec = forms[form].find((item) => item.row === row);
      if (!spec) {
        problems.push({
          code: 'S1005_ROW',
          path: `${form}.${row}`,
          message: `${form} nu are rândul ${row}.`,
        });
        continue;
      }
      if (!Array.isArray(cells)) {
        problems.push({
          code: 'S1005_ROW',
          path: `${form}.${row}`,
          message: `${form} rd. ${row}: valorile se dau pe coloane.`,
        });
        continue;
      }
      cells.forEach((value, index) => {
        if (value === undefined) return;
        const column = index + 1;
        const path = `${form}.${row}.${column}`;
        const field = `${form}_${spec.code}${column}`;
        if (!spec.columns.includes(column))
          problems.push({
            code: 'S1005_COLUMN',
            path,
            message: `${form} rd. ${row} nu are coloana ${column} (${field} nu se completează).`,
          });
        else if (percentFields.has(field)) {
          if (!isPercent(value))
            problems.push({
              code: 'S1005_PERCENT',
              path,
              message: `${field}: un procent între 0 și 100, cu cel mult două zecimale.`,
            });
        } else if (!isAmount(value))
          problems.push({
            code: 'S1005_AMOUNT',
            path,
            message: `${field}: o sumă în lei, fără zecimale, de cel mult 15 cifre.`,
          });
        else if (field === 'F10_0011' && value < 0)
          problems.push({
            code: 'S1005_AMOUNT',
            path,
            message: 'F10_0011: schema nu admite o valoare negativă.',
          });
      });
    }
  }
  return problems;
}

/** The fields the model gives, by XML attribute. */
function fieldsOf(model: S1005): Map<string, number> {
  const fields = new Map<string, number>();
  for (const form of formIds) {
    const values = (model[form] ?? {}) as Record<string, S1005Cells | undefined>;
    for (const spec of forms[form]) {
      const cells = values[spec.row];
      if (!cells) continue;
      for (const column of spec.columns) {
        const value = cells[column - 1];
        if (value !== undefined) fields.set(`${form}_${spec.code}${column}`, value);
      }
    }
  }
  return fields;
}

function modelWith(model: S1005, fields: ReadonlyMap<string, number>): S1005 {
  const next = { ...model } as S1005;
  for (const form of formIds) {
    const rows: Record<string, (number | undefined)[]> = {};
    for (const spec of forms[form]) {
      const cells = spec.columns.map((column) => fields.get(`${form}_${spec.code}${column}`));
      if (cells.some((value) => value !== undefined)) {
        const width = Math.max(...spec.columns);
        rows[spec.row] = Array.from({ length: width }, (_, i) =>
          fields.get(`${form}_${spec.code}${i + 1}`),
        );
      }
    }
    (next as Record<FormId, unknown>)[form] = rows;
  }
  return next;
}

const big = (value: number | undefined) => BigInt(value ?? 0);
const sumTerms = (fields: ReadonlyMap<string, number>, terms: readonly Term[]) =>
  terms.reduce((sum, term) => sum + term.sign * big(fields.get(term.field)), 0n);
const fieldForm = (field: string) => field.slice(0, 3) as FormId;

/** F30 chapter I from F20 col. 2 (F10_F30_1–3): one unit with profit, loss, or neither. */
function resultUnits(fields: ReadonlyMap<string, number>): Record<string, number> {
  const profit = big(fields.get('F20_0082'));
  const loss = big(fields.get('F20_0092'));
  if (profit > 0n)
    return {
      F30_0011: 1,
      F30_0012: Number(profit),
      F30_0021: 0,
      F30_0022: 0,
      F30_0031: 0,
      F30_0032: 0,
    };
  if (loss > 0n)
    return {
      F30_0011: 0,
      F30_0012: 0,
      F30_0021: 1,
      F30_0022: Number(loss),
      F30_0031: 0,
      F30_0032: 0,
    };
  return { F30_0011: 0, F30_0012: 0, F30_0021: 0, F30_0022: 0, F30_0031: 1, F30_0032: 0 };
}
const unitFields = ['F30_0011', 'F30_0012', 'F30_0021', 'F30_0022', 'F30_0031', 'F30_0032'];

/**
 * The model with every computed row the form defines filled where absent: F10 and F20 totals
 * (absent details counting as 0), F30 chapter I from F20, and the F30 and F40 totals whose terms
 * are given. Given values are kept, and checkS1005 compares them. Throws when the year or a value
 * cannot be used.
 */
export function completeS1005(model: S1005): S1005 {
  s1005Format(model.year);
  const [problem] = inputProblems(model);
  if (problem) throw new DomainError(problem.code, problem.message);
  return modelWith(model, complete(fieldsOf(model)));
}

function complete(given: ReadonlyMap<string, number>): Map<string, number> {
  const fields = new Map(given);
  type Definition = { targets: string[]; terms: Term[]; compute: (sum: bigint) => bigint[] };
  const definitions: Definition[] = [];
  for (const rule of rules) {
    if (rule.kind === 'compare' && rule.defines)
      definitions.push({ targets: [rule.left[0]!.field], terms: rule.right, compute: (s) => [s] });
    if (rule.kind === 'split')
      definitions.push({
        targets: [rule.profit, rule.loss],
        terms: rule.terms,
        compute: (s) => [s > 0n ? s : 0n, s < 0n ? -s : 0n],
      });
  }
  const pending = new Set(
    definitions.flatMap((definition) =>
      definition.targets.every((target) => !fields.has(target)) ? definition.targets : [],
    ),
  );
  const chapterOne = unitFields.every((field) => !fields.has(field));
  if (chapterOne) unitFields.forEach((field) => pending.add(field));
  let progress = true;
  while (progress) {
    progress = false;
    for (const definition of definitions) {
      if (!definition.targets.every((target) => pending.has(target))) continue;
      if (definition.terms.some((term) => pending.has(term.field))) continue;
      const known = definition.terms.some((term) => fields.has(term.field));
      const always = definition.targets.every((t) => ['F10', 'F20'].includes(fieldForm(t)));
      if (known || always) {
        const values = definition.compute(sumTerms(fields, definition.terms));
        definition.targets.forEach((target, i) => fields.set(target, Number(values[i])));
      }
      definition.targets.forEach((target) => pending.delete(target));
      progress = true;
    }
    if (chapterOne && unitFields.every((field) => pending.has(field))) {
      if (!pending.has('F20_0082') && !pending.has('F20_0092')) {
        for (const [field, value] of Object.entries(resultUnits(fields))) fields.set(field, value);
        unitFields.forEach((field) => pending.delete(field));
        progress = true;
      }
    }
  }
  return fields;
}

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

const isCui = (code: string) => /^[1-9]\d{1,9}$/.test(code) && isValidCui(code);
const isCif = (code: string) => isCui(code) || (/^[1-9]\d{12}$/.test(code) && isValidCnp(code));
const counties = new Set<number>(s1005Counties.map(([code]) => code));
const ownerships = new Set<number>(s1005Ownerships.map(([code]) => code));
const qualities = new Set<number>(s1005PreparerQualities.map(([code]) => code));

/** adresa as the structure formats it. */
export function s1005AddressText(address: S1005Address): string {
  const parts: [string, string | number | undefined][] = [
    ['Sector', address.sector],
    ['Localitate', address.locality],
    ['Strada', address.street],
    ['Nr.', address.number],
    ['Bloc', address.block],
    ['Scara', address.staircase],
    ['Ap.', address.apartment],
  ];
  return parts
    .filter(([, value]) => value !== undefined && String(value).trim() !== '')
    .map(([label, value]) => `${label}:${String(value).trim()},`)
    .join('');
}

function headerChecks(model: S1005, add: (check: S1005Check) => void) {
  const error = (code: string, path: string, message: string) =>
    add({ code, severity: 'error', path, message });
  const text = (
    path: string,
    value: string | undefined,
    label: string,
    max: number,
    required: boolean,
  ) => {
    const trimmed = value?.trim();
    if (!trimmed) {
      if (required) error('S1005_TEXT', path, `Completați ${label}.`);
    } else if (trimmed.length > max)
      error('S1005_TEXT', path, `Câmpul ${label} are cel mult ${max} caractere.`);
  };
  const { entity, preparer, audit } = model;
  if (!isCui(entity.cui))
    error(
      'S1005_CUI',
      'entity.cui',
      'Codul unic de înregistrare nu este valid; se scrie fără prefixul RO.',
    );
  text('entity.name', entity.name, 'denumirea entității', 50, true);
  const address = s1005AddressText(entity.address);
  if (!entity.address.locality?.trim())
    error('S1005_TEXT', 'entity.address.locality', 'Completați localitatea sediului.');
  else if (address.length > 200)
    error('S1005_TEXT', 'entity.address', 'Adresa are cel mult 200 de caractere.');
  if (entity.address.sector !== undefined && ![1, 2, 3, 4, 5, 6].includes(entity.address.sector))
    error('S1005_ADDRESS', 'entity.address.sector', 'Sectorul este un număr de la 1 la 6.');
  text('entity.phone', entity.phone, 'telefonul', 15, false);
  text(
    'entity.tradeRegister',
    entity.tradeRegister,
    'numărul de înregistrare în registrul comerțului',
    18,
    true,
  );
  if (!counties.has(entity.county))
    error(
      'S1005_COUNTY',
      'entity.county',
      'Județul sediului nu este în nomenclatorul ANAF (codTT).',
    );
  if (!ownerships.has(entity.ownership))
    error(
      'S1005_OWNERSHIP',
      'entity.ownership',
      'Forma de proprietate nu este în nomenclatorul ANAF (codPP).',
    );
  if (!/^\d{4}$/.test(entity.caen))
    error('S1005_CAEN', 'entity.caen', 'Codul CAEN al activității preponderente are patru cifre.');
  if (!/^\d{4}$/.test(entity.caenActual))
    error(
      'S1005_CAEN',
      'entity.caenActual',
      'Codul CAEN al activității efectiv desfășurate are patru cifre.',
    );
  if (entity.caenVersion !== 2024 && entity.caenVersion !== 2025)
    error('S1005_CAEN', 'entity.caenVersion', 'Anul CAEN (AN_CAEN) este 2024 sau 2025.');
  if (entity.lei !== undefined && entity.lei.length !== 20)
    error('S1005_LEI', 'entity.lei', 'Codul LEI are 20 de caractere.');
  text('administrator', model.administrator, 'numele administratorului', 75, true);
  text('preparer.name', preparer.name, 'numele celui care a întocmit situațiile', 75, true);
  if (!qualities.has(preparer.quality))
    error(
      'S1005_QUALITY',
      'preparer.quality',
      'Calitatea celui care a întocmit situațiile nu este în nomenclator.',
    );
  text(
    'preparer.membership',
    preparer.membership,
    'numărul de înregistrare în organismul profesional',
    15,
    false,
  );
  const ceccar = preparer.quality === 21 || preparer.quality === 22;
  if (ceccar !== (preparer.cif !== undefined))
    error(
      'R22a',
      'preparer.cif',
      'Dacă calit_intocmit = (21, 22), atunci cif_intocmit trebuie completat, altfel cif_intocmit nu trebuie completat.',
    );
  else if (preparer.cif !== undefined && !isCif(preparer.cif))
    error('S1005_CIF', 'preparer.cif', 'CIF-ul celui care a întocmit situațiile nu este valid.');
  if (audit) {
    if (!['statutory', 'voluntary', 'censors'].includes(audit.kind))
      error(
        'S1005_AUDIT',
        'audit.kind',
        'Auditul este statutar, opțional sau verificarea de către cenzori.',
      );
    if (audit.kind !== 'censors' && !audit.auditor?.name?.trim())
      error(
        'S1005_AUDIT',
        'audit.auditor.name',
        'Completați auditorul (den_audi) situațiilor auditate.',
      );
    if (audit.auditor) {
      text('audit.auditor.name', audit.auditor.name, 'auditorul', 75, false);
      text(
        'audit.auditor.registration',
        audit.auditor.registration,
        'numărul din Registrul CAFR',
        50,
        false,
      );
      if (audit.auditor.cif !== undefined && !isCui(audit.auditor.cif))
        error('S1005_CIF', 'audit.auditor.cif', 'Codul fiscal al auditorului nu este valid.');
    }
  }
  if (model.internalAudit && audit?.kind !== 'statutory')
    add({
      code: 'S1005_AUDIT',
      severity: 'warning',
      path: 'internalAudit',
      message:
        'Structura prevede d_audit_intern = 1 pentru entitățile cu obligația legală de audit (d_audit = 1).',
    });
  if (model.approved !== true)
    error(
      'S1005_APPROVED',
      'approved',
      'Situațiile financiare anuale se depun după aprobare (bifa_aprob = 1).',
    );
}

const shown = (fields: ReadonlyMap<string, number>, field: string) =>
  fields.has(field) ? String(fields.get(field)) : 'lipsă';

function ruleChecks(fields: ReadonlyMap<string, number>, add: (check: S1005Check) => void) {
  const value = (field: string) => big(fields.get(field));
  for (const rule of rules) {
    switch (rule.kind) {
      case 'compare': {
        const left = sumTerms(fields, rule.left);
        const right = sumTerms(fields, rule.right);
        const holds =
          rule.op === '=' ? left === right : rule.op === '>=' ? left >= right : left <= right;
        if (!holds)
          add({
            code: rule.id,
            severity: rule.severity,
            path: pathOf(rule.left[0]?.field ?? rule.right[0]!.field),
            message: `${rule.text}: ${left} ${rule.op === '=' ? '≠' : 'nu este ' + rule.op} ${right}.`,
          });
        break;
      }
      case 'split': {
        const sum = sumTerms(fields, rule.terms);
        const expected = [sum > 0n ? sum : 0n, sum < 0n ? -sum : 0n];
        [rule.profit, rule.loss].forEach((field, i) => {
          if (value(field) !== expected[i])
            add({
              code: rule.ids[i]!,
              severity: 'error',
              path: pathOf(field),
              message: `${field} (${shown(fields, field)}) trebuie să fie ${expected[i]}: ${rule.terms
                .map((t) => `${t.sign < 0n ? '- ' : '+ '}${t.field}`)
                .join(' ')
                .replace(/^\+ /, '')} = ${sum}.`,
            });
        });
        break;
      }
      case 'nonNegative':
        if (value(rule.field) < 0n)
          add({
            code: rule.id,
            severity: 'error',
            path: pathOf(rule.field),
            message: `${rule.field} (${value(rule.field)}) >= 0.`,
          });
        break;
      case 'exclusive':
        if (value(rule.fields[0]) > 0n && value(rule.fields[1]) > 0n)
          add({
            code: rule.id,
            severity: 'error',
            path: pathOf(rule.fields[0]),
            message: `${rule.fields[0]} (${value(rule.fields[0])}) și ${rule.fields[1]} (${value(rule.fields[1])}) nu pot fi ambele > 0.`,
          });
        break;
      case 'percent':
        if ((fields.get(rule.field) ?? 0) > 100)
          add({
            code: rule.id,
            severity: 'error',
            path: pathOf(rule.field),
            message: `${rule.field} (${fields.get(rule.field)}) <= 100.`,
          });
        break;
    }
  }
  const expected = resultUnits(fields);
  const ids = ['F10_F30_1', 'F10_F30_2', 'F10_F30_3'];
  const id = expected.F30_0011 ? ids[0]! : expected.F30_0021 ? ids[1]! : ids[2]!;
  const wrong = unitFields.filter((field) => fields.get(field) !== expected[field]);
  if (wrong.length)
    add({
      code: id,
      severity: 'error',
      path: pathOf(wrong[0]!),
      message: `Capitolul I din F30 urmează rezultatul din F20 (F20_0082 ${shown(fields, 'F20_0082')}, F20_0092 ${shown(fields, 'F20_0092')}): ${unitFields
        .map((field) => `${field} = ${expected[field]}`)
        .join(', ')}.`,
    });
  for (const [field, amount] of fields) {
    if (percentFields.has(field) || Math.abs(amount) <= maxAmount) continue;
    add({
      code: 'S1005_AMOUNT',
      severity: 'error',
      path: pathOf(field),
      message: `${field} depășește 15 cifre.`,
    });
  }
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
  headerChecks(model, add);
  const problems = inputProblems(model);
  for (const problem of problems) add({ ...problem, severity: 'error' });
  if (!known || problems.length) return checks;
  ruleChecks(complete(fieldsOf(model)), add);
  return checks;
}

// ---------------------------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------------------------

const flag = (value: boolean) => (value ? '1' : '0');
const auditCodes = { statutory: '1', voluntary: '2', censors: '3' } as const;

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
  const fields = complete(fieldsOf(model));
  const { entity, preparer, audit } = model;
  const attributes = (form: FormId, all: boolean) => {
    const result: Record<string, string> = {};
    for (const spec of forms[form])
      for (const column of spec.columns) {
        const field = `${form}_${spec.code}${column}`;
        const value = fields.get(field);
        if (value !== undefined || all) result[field] = String(value ?? 0);
      }
    return result;
  };
  return serializeXml(
    element(
      'Bilant1005',
      {
        xmlns: format.namespace,
        'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
        'xsi:schemaLocation': `${format.namespace} s1005.xsd`,
        luna: '12',
        an: String(model.year),
        cui: entity.cui,
        den: entity.name.trim(),
        adresa: s1005AddressText(entity.address),
        telefon: entity.phone?.trim() || undefined,
        regCom: entity.tradeRegister.trim(),
        caen: entity.caen,
        caenE: entity.caenActual,
        bifa_aprob: '1',
        AN_CAEN: String(entity.caenVersion),
        bifaMC: flag(entity.largeTaxpayer),
        bifaDD: flag(entity.branch),
        bifaGG: flag(entity.economicInterestGroup),
        bifaAA: flag(entity.netAssetsBelowHalfCapital),
        bifa_art27: '0',
        tipBIL: 'UU',
        interes_public: '0',
        codTT: String(entity.county),
        codJJ: entity.largeTaxpayer ? '41' : String(entity.county),
        codPP: String(entity.ownership),
        codLEI: entity.lei,
        nume_admin: model.administrator.trim(),
        nume_intocmit: preparer.name.trim(),
        calit_intocmit: String(preparer.quality),
        nri_intocmit: preparer.membership?.trim() || undefined,
        cif_intocmit: preparer.cif,
        d_audit: audit ? auditCodes[audit.kind] : undefined,
        d_audit_intern: model.internalAudit ? '1' : undefined,
        den_audi: audit?.auditor?.name.trim(),
        nr_audi: audit?.auditor?.registration?.trim() || undefined,
        cif_audi: audit?.auditor?.cif,
        // "Suma de control formular": F10 rd. 29 col. 2, the capital.
        totalPlata_A: String(fields.get('F10_0292') ?? 0),
      },
      element('F10', attributes('F10', true)),
      element('F20', attributes('F20', true)),
      element('F30', attributes('F30', false)),
      element('F40', attributes('F40', false)),
    ),
  );
}
