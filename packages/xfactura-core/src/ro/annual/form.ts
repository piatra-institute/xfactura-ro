import { DomainError } from '../../errors';
import { element, serializeXml } from '../../xml/write';
import { isValidCnp, isValidCui } from '../identifiers';
import { s1005CaenClasses, type S1005RowSpec } from './s1005-rows';

/**
 * What ANAF's annual statements of companies share (S1005 for microentities, S1003 for small
 * entities, structura_SC_1225_270126): the identification attributes, the forms F10, F20, F30
 * and F40 as rows of cells, the arithmetic controls the structure states and the validator
 * applies, the rows the form computes, and the XML. Each statement supplies its rows and rules
 * (`StatementSpec`); the code here is the same for all of them.
 */

export type FormId = 'F10' | 'F20' | 'F30' | 'F40';
export const formIds: readonly FormId[] = ['F10', 'F20', 'F30', 'F40'];

/** The cells of a row, by column: index 0 is column 1. */
export type Cells = readonly (number | undefined)[];

/** A form's rows with values; absent rows and cells are empty. */
export type FormRows<Row extends string> = Partial<Record<Row, Cells>>;

export type Severity = 'error' | 'warning';

export type StatementCheck = {
  /** ANAF's rule code where the structure or the validator names one (F10_59, F20_F30_1…),
   * otherwise the statement's own (S1005_…, S1003_…). */
  code: string;
  /** error: ANAF's validator rejects it; warning: the structure states it but the validator does
   * not apply it, or the value is doubtful. */
  severity: Severity;
  path: string;
  message: string;
};

// ---------------------------------------------------------------------------------------------
// Identification
// ---------------------------------------------------------------------------------------------

/** Nomenclator județe (codTT), structura_SC_1225_270126 p. 80; 41 (DGAMC) is codJJ only. */
export const annualCounties = [
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
export const annualOwnerships = [
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
export const annualPreparerQualities = [
  [11, 'Director economic'],
  [12, 'Contabil șef'],
  [13, 'Altă persoană împuternicită, potrivit legii'],
  [21, 'Persoane fizice autorizate, membre CECCAR'],
  [22, 'Persoane juridice autorizate, membre CECCAR'],
] as const;
export type AnnualPreparerQuality = (typeof annualPreparerQualities)[number][0];

/** adresa, written as the structure gives it for the PDF's XML import: 'Sector:x,Localitate:xxx,
 * Strada:xxx,Nr.:xxx,Bloc:xxx,Scara:xxx,Ap.:xxx,', absent parts left out. The county is codTT. */
export type AnnualAddress = {
  /** Bucharest's sector, 1–6. */
  sector?: number;
  locality: string;
  street?: string;
  number?: string;
  block?: string;
  staircase?: string;
  apartment?: string;
};

export type AnnualEntity = {
  /** cui: digits only, without the RO prefix. */
  cui: string;
  /** den, C(50). */
  name: string;
  address: AnnualAddress;
  /** telefon, C(15). */
  phone?: string;
  /** regCom, "Număr de înregistrare din registrul comerțului", C(18). */
  tradeRegister: string;
  /** codTT: the county of the registered office (annualCounties). */
  county: number;
  /** codPP: the form of ownership (annualOwnerships). */
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

/** The identification of a company's annual statements, the same in S1005 and S1003. */
export type AnnualHeader = {
  /** an: the financial year; luna is 12. */
  year: number;
  entity: AnnualEntity;
  /** nume_admin: the legal representative (administrator or person in charge of management). */
  administrator: string;
  /** The person who prepared the statements. */
  preparer: {
    /** nume_intocmit, C(75). */
    name: string;
    /** calit_intocmit. */
    quality: AnnualPreparerQuality;
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
};

/** A statement's model: the header and its four forms. */
export type StatementModel = AnnualHeader & {
  F10: Partial<Record<string, Cells>>;
  F20: Partial<Record<string, Cells>>;
  F30: Partial<Record<string, Cells>>;
  F40: Partial<Record<string, Cells>>;
};

// ---------------------------------------------------------------------------------------------
// The arithmetic controls, as the structure states them (Cod formula) and as the validator
// applies them.
// ---------------------------------------------------------------------------------------------

export type Term = { sign: 1n | -1n; field: string };
type Op = '=' | '>=' | '<=';
export type Rule =
  | {
      kind: 'compare';
      id: string;
      text: string;
      left: Term[];
      op: Op;
      right: Term[];
      /** A total the form computes: the writer fills it when absent. */
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
      /** The validator's case suffix (S1005 F30_125–128, F30_147–150): .1 when the row takes the
       * sum, .2 when it must be 0; with `loss>=0` the loss takes it from 0 included. */
      cases?: 'loss>=0' | 'loss>0';
    }
  | { kind: 'nonNegative'; id: string; field: string }
  | { kind: 'exclusive'; id: string; fields: [string, string] }
  | { kind: 'percent'; id: string; field: string };

export type RuleOptions = { defines?: boolean; severity?: Severity };
export const total = { defines: true } as const;
export const structureOnly = { severity: 'warning' } as const;

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
      if (!/^F[1-4]0_\d{4}$/.test(token)) throw new Error(`Annual statement rule term ${token}`);
      terms.push({ sign, field: token });
      sign = 1n;
    }
  }
  return terms;
}

/** A rule set under construction, with the structure's shorthands. */
export function ruleBuilder() {
  const rules: Rule[] = [];
  function compare(id: string, text: string, options: RuleOptions = {}) {
    const match = /^(.*?)\s*(>=|<=|=)\s*(.*)$/.exec(text);
    if (!match) throw new Error(`Annual statement rule ${id}`);
    const left = parseSide(match[1]!);
    if (options.defines && (left.length !== 1 || left[0]!.sign !== 1n))
      throw new Error(`Annual statement rule ${id} defines no single field`);
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
  function columns(ids: readonly string[], template: string, options: RuleOptions = {}) {
    ids.forEach((id, index) => compare(id, template.replace(/#/g, String(index + 1)), options));
  }
  function split(
    ids: [string, string],
    profit: string,
    loss: string,
    terms: string,
    cases?: 'loss>=0' | 'loss>0',
  ) {
    rules.push({
      kind: 'split',
      ids,
      text: `${profit} - ${loss} = ${terms}`,
      profit,
      loss,
      terms: parseSide(terms),
      ...(cases ? { cases } : {}),
    });
  }
  return { rules, compare, columns, split };
}
export type RuleBuilder = ReturnType<typeof ruleBuilder>;

/** F10_BS, the abridged balance sheet S1005 and S1003 share (structura p. 18–22, and the
 * "Formule de calcul suplimentare" of each, p. 78). */
export function balanceSheetRules({ rules, columns }: RuleBuilder) {
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
}

/**
 * F40, "Situația activelor imobilizate", which S1005 and S1003 share (structura p. 66–77): each
 * row's closing column ("suma pe rand"), then the totals by column ("suma pe coloana"), under the
 * structure's codes F40_1–F40_90 (the validator prints the same, e.g. F40_14, F40_27). The row
 * sum of rd. 35 has no code in the structure: it is F40_0354.
 */
export function fixedAssetRules({ compare }: RuleBuilder) {
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
  const f40Totals: readonly [number, readonly number[], readonly (readonly [number, number])[]][] =
    [
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

  // F10 = F40 (structura p. 79, the same for S1003 and S1005).
  compare('F10_F40_1', 'F10_0011 = F40_0071 - F40_0261 - F40_0401');
  compare('F10_F40_2', 'F10_0012 = F40_0075 - F40_0264 - F40_0404');
  compare('F10_F40_3', 'F10_0021 = F40_0181 - F40_0341 - F40_0511');
  compare('F10_F40_4', 'F10_0022 = F40_0185 - F40_0344 - F40_0514');
  compare('F10_F40_5', 'F10_0031 = F40_0191 - F40_0521');
  compare('F10_F40_6', 'F10_0032 = F40_0195 - F40_0524');
}

/** Every arithmetic control of a rule set, by code: the structure's or the validator's. */
export function controlsOf(
  rules: readonly Rule[],
): { code: string; text: string; severity: Severity }[] {
  return rules.flatMap((rule) => {
    switch (rule.kind) {
      case 'compare':
        return [{ code: rule.id, text: rule.text, severity: rule.severity }];
      case 'split':
        return rule.ids.flatMap((code) =>
          (rule.cases ? [`${code}.1`, `${code}.2`] : [code]).map((suffixed) => ({
            code: suffixed,
            text: rule.text,
            severity: 'error' as const,
          })),
        );
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
}

// ---------------------------------------------------------------------------------------------
// A statement
// ---------------------------------------------------------------------------------------------

export type F30RowSpec = S1005RowSpec & { chapter: string };

export interface StatementSpec {
  /** The statement's code, which prefixes its own problem codes: S1005, S1003. */
  prefix: string;
  /** The XML root (Bilant1005) and tipBIL (UU, BS). */
  root: string;
  tipBIL: string;
  forms: {
    F10: readonly S1005RowSpec[];
    F20: readonly S1005RowSpec[];
    F30: readonly F30RowSpec[];
    F40: readonly S1005RowSpec[];
  };
  rules: readonly Rule[];
  /** F20 col. 2's net profit and loss, which chapter I of F30 follows (F10_F30_1–3). */
  result: { profit: string; loss: string };
}

const maxAmount = 999_999_999_999_999;

/** A statement's places and percentages, computed once. */
export class Statement {
  private readonly places = new Map<string, { form: FormId; row: string; column: number }>();
  /** F30 chapter XII percentages: N(3.2), 0–100. */
  readonly percentFields: ReadonlySet<string>;
  readonly controls: readonly { code: string; text: string; severity: Severity }[];

  constructor(readonly spec: StatementSpec) {
    for (const form of formIds)
      for (const row of spec.forms[form])
        for (const column of row.columns)
          this.places.set(`${form}_${row.code}${column}`, { form, row: row.row, column });
    this.percentFields = new Set(
      spec.forms.F30.filter((row) => row.chapter === 'XII').flatMap((row) =>
        row.columns.filter((column) => column % 2 === 0).map((c) => `F30_${row.code}${c}`),
      ),
    );
    this.controls = controlsOf(spec.rules);
  }

  /** The XML attribute of a row's column, e.g. F10_3011 for F10 rd. 06a col. 1. */
  field(form: FormId, row: string, column: number): string {
    const spec = this.spec.forms[form].find((item) => item.row === row);
    if (!spec || !spec.columns.includes(column))
      throw new DomainError(
        `${this.spec.prefix}_FIELD`,
        `${form} nu are rândul ${row} coloana ${column}.`,
      );
    return `${form}_${spec.code}${column}`;
  }

  /** The cells of a form the statement computes from others (totals, profit or loss, chapter
   * I of F30), as `row.column`. */
  computedCells(form: FormId): Set<string> {
    const fields = [
      ...this.spec.rules.flatMap((rule) =>
        rule.kind === 'compare' && rule.defines
          ? [rule.left[0]!.field]
          : rule.kind === 'split'
            ? [rule.profit, rule.loss]
            : [],
      ),
      ...(form === 'F30' ? unitFields : []),
    ];
    return new Set(
      fields.flatMap((field) => {
        const place = this.places.get(field);
        return place && place.form === form ? [`${place.row}.${place.column}`] : [];
      }),
    );
  }

  /** Every field of the forms, by XML attribute. */
  fields(): string[] {
    return [...this.places.keys()];
  }

  pathOf(field: string) {
    const place = this.places.get(field);
    return place ? `${place.form}.${place.row}.${place.column}` : field;
  }

  /** Rows, columns and values calculations cannot use. */
  inputProblems(model: StatementModel): { code: string; path: string; message: string }[] {
    const prefix = this.spec.prefix;
    const problems: { code: string; path: string; message: string }[] = [];
    for (const form of formIds) {
      const values = (model[form] ?? {}) as Record<string, Cells | undefined>;
      for (const [row, cells] of Object.entries(values)) {
        if (cells === undefined) continue;
        const spec = this.spec.forms[form].find((item) => item.row === row);
        if (!spec) {
          problems.push({
            code: `${prefix}_ROW`,
            path: `${form}.${row}`,
            message: `${form} nu are rândul ${row}.`,
          });
          continue;
        }
        if (!Array.isArray(cells)) {
          problems.push({
            code: `${prefix}_ROW`,
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
              code: `${prefix}_COLUMN`,
              path,
              message: `${form} rd. ${row} nu are coloana ${column} (${field} nu se completează).`,
            });
          else if (this.percentFields.has(field)) {
            if (!isPercent(value))
              problems.push({
                code: `${prefix}_PERCENT`,
                path,
                message: `${field}: un procent, N(3.2): cel mult trei cifre și două zecimale.`,
              });
          } else if (!isAmount(value))
            problems.push({
              code: `${prefix}_AMOUNT`,
              path,
              message: `${field}: o sumă în lei, fără zecimale, de cel mult 15 cifre.`,
            });
          else if (field === 'F10_0011' && value < 0)
            problems.push({
              code: `${prefix}_AMOUNT`,
              path,
              message: 'F10_0011: schema nu admite o valoare negativă.',
            });
        });
      }
    }
    return problems;
  }

  /** The fields the model gives, by XML attribute. */
  fieldsOf(model: StatementModel): Map<string, number> {
    const fields = new Map<string, number>();
    for (const form of formIds) {
      const values = (model[form] ?? {}) as Record<string, Cells | undefined>;
      for (const spec of this.spec.forms[form]) {
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

  modelWith<M extends StatementModel>(model: M, fields: ReadonlyMap<string, number>): M {
    const next = { ...model };
    for (const form of formIds) {
      const rows: Record<string, (number | undefined)[]> = {};
      for (const spec of this.spec.forms[form]) {
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

  /** F30 chapter I from F20 col. 2 (F10_F30_1–3): one unit with profit, loss, or neither. */
  resultUnits(fields: ReadonlyMap<string, number>): Record<string, number> {
    const profit = big(fields.get(this.spec.result.profit));
    const loss = big(fields.get(this.spec.result.loss));
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

  /**
   * Every computed row the form defines, filled where absent: F10 and F20 totals (absent details
   * counting as 0), F30 chapter I from F20, and the F30 and F40 totals whose terms are given.
   * Given values are kept, and `ruleChecks` compares them.
   */
  complete(given: ReadonlyMap<string, number>): Map<string, number> {
    const fields = new Map(given);
    type Definition = { targets: string[]; terms: Term[]; compute: (sum: bigint) => bigint[] };
    const definitions: Definition[] = [];
    for (const rule of this.spec.rules) {
      if (rule.kind === 'compare' && rule.defines)
        definitions.push({
          targets: [rule.left[0]!.field],
          terms: rule.right,
          compute: (s) => [s],
        });
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
    const { profit, loss } = this.spec.result;
    let progress = true;
    while (progress) {
      progress = false;
      for (const definition of definitions) {
        if (!definition.targets.every((target) => pending.has(target))) continue;
        if (definition.terms.some((term) => pending.has(term.field))) continue;
        const known = definition.terms.some((term) => fields.has(term.field));
        const always = definition.targets.every((t) => ['F10', 'F20'].includes(t.slice(0, 3)));
        if (known || always) {
          const values = definition.compute(sumTerms(fields, definition.terms));
          definition.targets.forEach((target, i) => fields.set(target, Number(values[i])));
        }
        definition.targets.forEach((target) => pending.delete(target));
        progress = true;
      }
      if (chapterOne && unitFields.every((field) => pending.has(field))) {
        if (!pending.has(profit) && !pending.has(loss)) {
          for (const [field, value] of Object.entries(this.resultUnits(fields)))
            fields.set(field, value);
          unitFields.forEach((field) => pending.delete(field));
          progress = true;
        }
      }
    }
    return fields;
  }

  /** The arithmetic controls over the completed fields. */
  ruleChecks(fields: ReadonlyMap<string, number>, add: (check: StatementCheck) => void) {
    const value = (field: string) => big(fields.get(field));
    const pathOf = (field: string) => this.pathOf(field);
    for (const rule of this.spec.rules) {
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
          const takes = [sum > 0n, rule.cases === 'loss>=0' ? sum <= 0n : sum < 0n];
          [rule.profit, rule.loss].forEach((field, i) => {
            if (value(field) !== expected[i])
              add({
                code: rule.cases ? `${rule.ids[i]}.${takes[i] ? 1 : 2}` : rule.ids[i]!,
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
    const expected = this.resultUnits(fields);
    const ids = ['F10_F30_1', 'F10_F30_2', 'F10_F30_3'];
    const id = expected.F30_0011 ? ids[0]! : expected.F30_0021 ? ids[1]! : ids[2]!;
    const wrong = unitFields.filter((field) => fields.get(field) !== expected[field]);
    const { profit, loss } = this.spec.result;
    if (wrong.length)
      add({
        code: id,
        severity: 'error',
        path: pathOf(wrong[0]!),
        message: `Capitolul I din F30 urmează rezultatul din F20 (${profit} ${shown(fields, profit)}, ${loss} ${shown(fields, loss)}): ${unitFields
          .map((field) => `${field} = ${expected[field]}`)
          .join(', ')}.`,
      });
    for (const [field, amount] of fields) {
      if (this.percentFields.has(field) || Math.abs(amount) <= maxAmount) continue;
      add({
        code: `${this.spec.prefix}_AMOUNT`,
        severity: 'error',
        path: pathOf(field),
        message: `${field} depășește 15 cifre.`,
      });
    }
  }

  /** The identification checks, under the statement's codes. */
  headerChecks(model: AnnualHeader, add: (check: StatementCheck) => void) {
    headerChecks(this.spec.prefix, model, add);
  }

  /**
   * Writes the statements as one element: the identification attributes in the schema's order,
   * then F10 and F20 with every field, F30 and F40 with the fields given or computed.
   */
  xml(
    model: StatementModel,
    format: { namespace: string; schemaFile: string },
    fields: ReadonlyMap<string, number>,
  ): string {
    const { entity, preparer, audit } = model;
    // F30's informative rows with nothing to report are left empty, as ANAF's form leaves them:
    // the forms are read by a parser that refuses an element with more than 200 attributes
    // (jdk.xml.elementAttributeLimit), so only chapter I and the profit and loss account of
    // chapter XIX are written with their zeros.
    const zeros = new Set(
      this.spec.forms.F30.filter((row) => row.chapter === 'I' || row.chapter === 'XIX').map(
        (row) => row.code,
      ),
    );
    const attributes = (form: FormId, all: boolean) => {
      const result: Record<string, string> = {};
      for (const spec of this.spec.forms[form])
        for (const column of spec.columns) {
          const field = `${form}_${spec.code}${column}`;
          const value = fields.get(field);
          if (form === 'F30' && value === 0 && !zeros.has(spec.code)) continue;
          if (value !== undefined || all) result[field] = String(value ?? 0);
        }
      return result;
    };
    return serializeXml(
      element(
        this.spec.root,
        {
          xmlns: format.namespace,
          'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
          'xsi:schemaLocation': `${format.namespace} ${format.schemaFile}`,
          luna: '12',
          an: String(model.year),
          cui: entity.cui,
          den: entity.name.trim(),
          adresa: annualAddressText(entity.address),
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
          tipBIL: this.spec.tipBIL,
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
}

const unitFields = ['F30_0011', 'F30_0012', 'F30_0021', 'F30_0022', 'F30_0031', 'F30_0032'];
const flag = (value: boolean) => (value ? '1' : '0');
const auditCodes = { statutory: '1', voluntary: '2', censors: '3' } as const;
const big = (value: number | undefined) => BigInt(value ?? 0);
const sumTerms = (fields: ReadonlyMap<string, number>, terms: readonly Term[]) =>
  terms.reduce((sum, term) => sum + term.sign * big(fields.get(term.field)), 0n);
const shown = (fields: ReadonlyMap<string, number>, field: string) =>
  fields.has(field) ? String(fields.get(field)) : 'lipsă';
const isAmount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= maxAmount;
const isPercent = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value < 1000 &&
  Math.abs(Math.round(value * 100) - value * 100) < 1e-9;

const isCui = (code: string) => /^[1-9]\d{1,9}$/.test(code) && isValidCui(code);
const isCif = (code: string) => isCui(code) || (/^[1-9]\d{12}$/.test(code) && isValidCnp(code));
const counties = new Set<number>(annualCounties.map(([code]) => code));
const ownerships = new Set<number>(annualOwnerships.map(([code]) => code));
const qualities = new Set<number>(annualPreparerQualities.map(([code]) => code));

/** adresa as the structure formats it. */
export function annualAddressText(address: AnnualAddress): string {
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

function headerChecks(prefix: string, model: AnnualHeader, add: (check: StatementCheck) => void) {
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
      if (required) error(`${prefix}_TEXT`, path, `Completați ${label}.`);
    } else if (trimmed.length > max)
      error(`${prefix}_TEXT`, path, `Câmpul ${label} are cel mult ${max} caractere.`);
  };
  const { entity, preparer, audit } = model;
  if (!isCui(entity.cui))
    error(
      `${prefix}_CUI`,
      'entity.cui',
      'Codul unic de înregistrare nu este valid; se scrie fără prefixul RO.',
    );
  text('entity.name', entity.name, 'denumirea entității', 50, true);
  const address = annualAddressText(entity.address);
  if (!entity.address.locality?.trim())
    error(`${prefix}_TEXT`, 'entity.address.locality', 'Completați localitatea sediului.');
  else if (address.length > 200)
    error(`${prefix}_TEXT`, 'entity.address', 'Adresa are cel mult 200 de caractere.');
  if (entity.address.sector !== undefined && ![1, 2, 3, 4, 5, 6].includes(entity.address.sector))
    error(`${prefix}_ADDRESS`, 'entity.address.sector', 'Sectorul este un număr de la 1 la 6.');
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
      `${prefix}_COUNTY`,
      'entity.county',
      'Județul sediului nu este în nomenclatorul ANAF (codTT).',
    );
  if (!ownerships.has(entity.ownership))
    error(
      `${prefix}_OWNERSHIP`,
      'entity.ownership',
      'Forma de proprietate nu este în nomenclatorul ANAF (codPP).',
    );
  for (const [path, value, label] of [
    ['entity.caen', entity.caen, 'activității preponderente'],
    ['entity.caenActual', entity.caenActual, 'activității preponderente efectiv desfășurate'],
  ] as const)
    if (!s1005CaenClasses.has(value))
      error(
        `${prefix}_CAEN`,
        path,
        `Codul CAEN al ${label} (${value}) nu este în lista ANAF (CAEN 2024 și 2025).`,
      );
  if (entity.caenVersion !== 2024 && entity.caenVersion !== 2025)
    error(`${prefix}_CAEN`, 'entity.caenVersion', 'Anul CAEN (AN_CAEN) este 2024 sau 2025.');
  if (entity.lei !== undefined && entity.lei.length !== 20)
    error(`${prefix}_LEI`, 'entity.lei', 'Codul LEI are 20 de caractere.');
  text('administrator', model.administrator, 'numele administratorului', 75, true);
  text('preparer.name', preparer.name, 'numele celui care a întocmit situațiile', 75, true);
  if (!qualities.has(preparer.quality))
    error(
      `${prefix}_QUALITY`,
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
    error(
      `${prefix}_CIF`,
      'preparer.cif',
      'CIF-ul celui care a întocmit situațiile nu este valid.',
    );
  if (audit) {
    if (!['statutory', 'voluntary', 'censors'].includes(audit.kind))
      error(
        `${prefix}_AUDIT`,
        'audit.kind',
        'Auditul este statutar, opțional sau verificarea de către cenzori.',
      );
    if (audit.kind !== 'censors' && !audit.auditor?.name?.trim())
      error(
        `${prefix}_AUDIT`,
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
        error(`${prefix}_CIF`, 'audit.auditor.cif', 'Codul fiscal al auditorului nu este valid.');
    }
  }
  if (model.internalAudit && audit?.kind !== 'statutory')
    add({
      code: `${prefix}_AUDIT`,
      severity: 'warning',
      path: 'internalAudit',
      message:
        'Structura prevede d_audit_intern = 1 pentru entitățile cu obligația legală de audit (d_audit = 1).',
    });
  if (model.approved !== true)
    error(
      `${prefix}_APPROVED`,
      'approved',
      'Situațiile financiare anuale se depun după aprobare (bifa_aprob = 1).',
    );
}
