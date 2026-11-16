import { d300Rows } from 'xfactura-core/ro/declarations/d300';
import {
  s1005F10Rows,
  s1005F20Rows,
  s1005F30Rows,
  s1005F40Rows,
} from 'xfactura-core/ro/annual/s1005';
import type { FiledDeclaration } from 'xfactura-core/ro/declarations/read';

export type FieldSelector = string | RegExp;
export type Normalization = 'case' | 'diacritics' | 'trim' | 'legal-form';
export type KeyAttribute = {
  attribute: string;
  optional?: boolean;
  sensitive?: boolean;
  sensitiveWhen?: { attribute: string; value: string };
  /** Key identity can allow less normalization than the comparable display field. */
  normalize?: readonly Normalization[];
};
export type RepeatedElement = {
  /** Root-relative element path, without positions or keys. */
  path: string;
  keys: readonly KeyAttribute[];
  variants?: readonly {
    when: { attribute: string; absent?: boolean; startsWith?: string };
    keys: readonly KeyAttribute[];
  }[];
};
export type ReturnCatalogue = {
  id: string;
  form: string;
  version: number;
  root: string;
  /** Needed when a namespace is reused for distinct structures (D112 and S1005). */
  period?: { from: string; through: string };
  repeated: readonly RepeatedElement[];
  ignored: readonly { path: FieldSelector; reason: string; when?: 'whitespace-only' }[];
  numeric: readonly { path: FieldSelector; tolerance: string }[];
  cosmetic: readonly { path: FieldSelector; normalize: readonly Normalization[] }[];
};

const keys = (...attributes: string[]): KeyAttribute[] =>
  attributes.map((attribute) => ({ attribute }));
const optional = (attribute: string): KeyAttribute => ({ attribute, optional: true });
const sensitive = (attribute: string): KeyAttribute => ({ attribute, sensitive: true });
const exact = (...paths: FieldSelector[]) => paths.map((path) => ({ path, tolerance: '0' }));
const attributes = (element: string, names: string) =>
  names.split(/\s+/).map((name) => `${element ? `${element}/` : ''}@${name}`);
const text = ['trim', 'case', 'diacritics'] as const;
const names = [...text, 'legal-form'] as const;
const nameKey = (attribute: string): KeyAttribute => ({ ...sensitive(attribute), normalize: text });
const noText = (...elements: string[]) =>
  elements.map((element) => ({
    path: `${element ? `${element}/` : ''}#text`,
    when: 'whitespace-only' as const,
    reason:
      'This element has only attribute/element content; whitespace-only text is XML indentation.',
  }));
const cosmetic = (paths: readonly string[], normalize: readonly Normalization[] = text) =>
  paths.map((path) => ({ path, normalize }));
const headerText = cosmetic(attributes('', 'nume_declar prenume_declar functie_declar adresa'));
const headerNames = cosmetic(['@den'], names);
const schemaLocation = {
  path: '@{http://www.w3.org/2001/XMLSchema-instance}schemaLocation',
  reason:
    'Schema file location is a producer hint; form and namespace version are checked separately.',
};

// These compare already serialized amounts. N(15) whole-lei fields do not justify a +/-1
// allowance. D112 D_19's deterministic two-decimal rounding (d112.ts, certificateElement,
// structura_D112_0126_300326 pp. 52–56 / structura_D112_0726_070926 pp. 56–62) likewise does
// not authorize two different filed values. All production tolerances are therefore zero.
// Validator formula slack is not a rounding rule for differences between two returns.
const d300 = (version: 11 | 12): ReturnCatalogue => ({
  id: version === 11 ? 'D300-2025-08' : 'D300-2026-01',
  form: 'D300',
  version,
  root: 'declaratie300',
  repeated: [], // writeD300 stores every row on the root, including the informative section.
  ignored: [schemaLocation, ...noText('')],
  numeric: exact(
    '@an',
    '@luna',
    '@pro_rata',
    '@totalPlata_A',
    ...d300Rows.filter((row) => version === 11 || !row.until).map((row) => `@${row.element}`),
  ),
  cosmetic: [...headerText, ...headerNames, ...cosmetic(['@banca'])],
});

const d394: ReturnCatalogue = {
  id: 'D394-2025-08',
  form: 'D394',
  version: 5,
  root: 'declaratie394',
  // writeD394: the nested details are scoped to their parent, not to the whole document.
  repeated: [
    { path: 'rezumat1', keys: [...keys('tip_partener', 'cota'), optional('document_N')] },
    { path: 'rezumat1/detaliu', keys: keys('bun') },
    { path: 'rezumat2', keys: keys('cota') },
    {
      path: 'serieFacturi',
      keys: [
        ...keys('tip'),
        optional('serieI'),
        optional('cui'),
        // A series can have several allocated/issued ranges. The starting number identifies
        // the range; its ending number remains a comparable field.
        ...keys('nrI'),
      ],
    },
    { path: 'facturi', keys: [...keys('tip_factura'), optional('serie'), ...keys('nr')] },
    {
      path: 'op1',
      // d394.ts R218/R218.4: document type is a field, not part of a coded partner's key.
      keys: [
        ...keys('tip_partener', 'tip'),
        // Type 2 includes individuals and unregistered entities. Treat its code as
        // sensitive regardless of spelling; it can be a CNP/NIF rather than a CUI.
        { attribute: 'cuiP', sensitiveWhen: { attribute: 'tip_partener', value: '2' } },
        ...keys('cota'),
      ],
      variants: [
        {
          when: { attribute: 'cuiP', absent: true },
          // The writer allows type 2 partners without a code. Do not invent one: use the
          // supplied name/address, refuse collisions, and pseudonymize these key parts.
          keys: [
            ...keys('tip_partener', 'tip', 'cota'),
            nameKey('denP'),
            ...'taraP judP locP strP nrP blP apP detP'
              .split(' ')
              .map((attribute) => ({ ...optional(attribute), sensitive: true })),
          ],
        },
      ],
    },
    { path: 'op1/op11', keys: keys('codPR') },
    { path: 'op2', keys: keys('tip_op2', 'luna') },
  ],
  ignored: [
    schemaLocation,
    ...noText(
      '',
      'informatii',
      'rezumat1',
      'rezumat1/detaliu',
      'rezumat2',
      'serieFacturi',
      'facturi',
      'op1',
      'op1/op11',
      'op2',
    ),
  ],
  numeric: exact(
    '@an',
    '@luna',
    '@totalPlata_A',
    /^informatii\/@(?:nrCui[1-4]|nr_BF_i1|incasari_i[12]|nrFacturi(?:_terti|_benef|LS_PF|L_PF)?|val_LS_PF|tva(?:DedAI|Ded|Col)(?:24|20|19|9|5|21|11)|incasari_ag|costuri_ag|marja_ag|tva_ag|pret_vanzare|pret_cumparare|marja_antic|tva_antic)$/,
    /^rezumat1\/@(?:cota|(?:facturi|baza|tva)(?:L|A|AI|C|LS|AS|V|N))$/,
    /^rezumat1\/detaliu\/@(?:nrN|valN|nrLivV|bazaLivV|nrAchizC|bazaAchizC|tvaAchizC)$/,
    /^rezumat2\/@(?:cota|(?:baza|TVA)(?:FSLcod|FSL|FSA|FSAI|BFAI)|(?:nrFacturi|baza|tva)(?:L|A|AI)|(?:baza|tva)L_PF|(?:baza|tva)_incasari_i[12])$/,
    /^facturi\/@(?:baza|tva)(?:24|20|19|9|5|21|11)$/,
    ...attributes('op1', 'cota nrFact baza tva'),
    ...attributes('op1/op11', 'nrFactPR bazaPR tvaPR'),
    /^op2\/@(?:luna|nrAMEF|nrBF|total|(?:baza|TVA)(?:20|9|5|19|21|11))$/,
  ),
  cosmetic: [
    ...cosmetic(attributes('', 'adresa adresaR functie_reprez functie_intocmit calitate_intocmit')),
    ...cosmetic(['@den', '@denR', '@den_intocmit', 'op1/@denP', 'serieFacturi/@den'], names),
    ...cosmetic(attributes('op1', 'locP strP detP')),
  ],
};

const d390: ReturnCatalogue = {
  id: 'D390-v3',
  form: 'D390',
  version: 3,
  root: 'declaratie390',
  repeated: [
    {
      path: 'operatie',
      keys: keys('tip', 'tara', 'codO'),
      variants: [
        {
          // writeD390 permits missing codO for acquisitions A/S.
          when: { attribute: 'codO', absent: true },
          keys: [...keys('tip', 'tara'), nameKey('denO')],
        },
      ],
    },
  ],
  ignored: [
    schemaLocation,
    ...noText('', 'rezumat', 'operatie'),
    {
      path: 'rezumat/@nr_pag',
      reason: 'Printed page count; writeD390 emits 0 independently of data.',
    },
  ],
  numeric: exact(
    '@an',
    '@luna',
    '@totalPlata_A',
    ...attributes('rezumat', 'nrOPI bazaL bazaT bazaA bazaP bazaS bazaR total_baza'),
    'operatie/@baza',
  ),
  cosmetic: [...headerText, ...headerNames, ...cosmetic(['operatie/@denO'], names)],
};

const d100: ReturnCatalogue = {
  id: 'D100-v2',
  form: 'D100',
  version: 2,
  root: 'declaratie100',
  repeated: [
    {
      path: 'obligatie',
      keys: keys('cod_oblig'),
      variants: [
        {
          // d100.ts checkD100, R15/R15.2: only excise duties repeat by due date.
          when: { attribute: 'cod_oblig', startsWith: '2' },
          keys: keys('cod_oblig', 'scadenta'),
        },
      ],
    },
  ],
  ignored: [schemaLocation, ...noText('', 'obligatie')],
  numeric: exact(
    '@an',
    '@luna',
    '@totalPlata_A',
    ...attributes(
      'obligatie',
      'suma_dat suma_ded suma_plata suma_rest suma_redu cota suma_AMEF suma_bonif suma_spons',
    ),
  ),
  cosmetic: [...headerText, ...headerNames, ...cosmetic(['@denR'], names), ...cosmetic(['@adrR'])],
};

const d112 = (half: 1 | 2): ReturnCatalogue => ({
  id: half === 1 ? 'D112-2026-01' : 'D112-2026-07',
  form: 'D112',
  version: 7,
  root: 'declaratieUnica',
  period: { from: half === 1 ? '2026-01' : '2026-07', through: half === 1 ? '2026-06' : '2026-12' },
  repeated: [
    { path: 'angajator/angajatorA', keys: keys('A_codOblig') },
    { path: 'asigurat', keys: [sensitive('cnpAsig')] },
    { path: 'asigurat/asiguratD', keys: [sensitive('D_1'), sensitive('D_2')] },
  ],
  ignored: [
    schemaLocation,
    ...noText(
      '',
      'angajator',
      'angajator/angajatorA',
      'angajator/angajatorB',
      'angajator/angajatorC1',
      'angajator/angajatorC2',
      'angajator/angajatorC3',
      'angajator/angajatorC4',
      'angajator/angajatorD',
      'angajator/angajatorE1',
      'angajator/angajatorE2',
      'angajator/angajatorE3',
      'angajator/angajatorF1',
      'asigurat',
      'asigurat/asiguratA',
      'asigurat/asiguratB1',
      'asigurat/asiguratB2',
      'asigurat/asiguratB3',
      'asigurat/asiguratB4',
      'asigurat/asiguratD',
      'asigurat/asiguratE1',
      'asigurat/asiguratE2',
      'asigurat/asiguratE3',
    ),
    { path: 'asigurat/@idAsig', reason: 'Writer-assigned ordinal; cnpAsig identifies the person.' },
  ],
  numeric: exact(
    '@an_r',
    '@luna_r',
    'angajator/@totalPlata_A',
    ...attributes('angajator/angajatorA', 'A_datorat A_deductibil A_scutit A_plata'),
    ...attributes('angajator/angajatorB', 'B_cnp B_sanatate B_pensie B_sal B_brutSalarii'),
    /^angajator\/angajatorC1\/@C1_(?:11|12|13|21|22|23|31|32|33|T1|T2|T|T3|5|7)$/,
    /^angajator\/angajatorC2\/@C2_(?:1[1-6]|11[1-6]|12[1-6]|13[1-6]|14[1-6]|2[1-6]|21[1-6]|[345][1246]|4[1246]a|T6|10|140)$/,
    ...(half === 2 ? [/^angajator\/angajatorC2\/@C2_15[56]$/] : []),
    /^angajator\/angajatorC3\/@C3_(?:[1-4][1-4]|total|suma)$/,
    ...attributes('angajator/angajatorC4', 'C4_baza C4_ct'),
    ...attributes('angajator/angajatorD', 'D2 D3'),
    ...attributes('angajator/angajatorE1', 'E1_baza E1_venit'),
    ...attributes('angajator/angajatorE2', 'E2_10 E2_140 E2_66'),
    ...attributes('angajator/angajatorE3', 'E3_suma E3_total'),
    ...attributes('angajator/angajatorF1', 'F1_deplata F1_suma F1_suma_ded F1_suma_scut'),
    'asigurat/@Timp_E3',
    ...attributes('asigurat', 'Tcota_E4 Tsuma_E4'),
    /^asigurat\/asiguratA\/@A_(?:sal[12]|[4-9]|1[1-4]|1[1-4]P|1[24]D|13[SC])$/,
    /^asigurat\/asiguratB1\/@B1_(?:sal[12]|[4-9]|10|1[5-7])$/,
    /^asigurat\/asiguratB2\/@B2_(?:[2-7]|[5-7][PSC])$/,
    /^asigurat\/asiguratB3\/@B3_(?:[1-9]|1[0-3]|7[SC])$/,
    ...(half === 2 ? ['asigurat/asiguratB3/@B3_7D'] : []),
    /^asigurat\/asiguratB4\/@B4_(?:[1-9]|14|18|20|[5-8]P|[68]D|7[SC])$/,
    /^asigurat\/asiguratD\/@D_(?:1[4-9]|20|21|28)$/,
    ...(half === 2 ? [/^asigurat\/asiguratD\/@D_(?:14a|15a|16a|20a|21a)$/] : []),
    /^asigurat\/asiguratE1\/@E1_(?:[1-7]|41|42|421|422)$/,
    /^asigurat\/asiguratE2\/@E2_[1-4]$/,
    /^asigurat\/asiguratE3\/@E3_(?:[89]|10|60|75|58|44|69|86|90|71|78|19|11|12|121|122|1221|1222|13|14|15|16|52|54|59|61|62|64|67)$/,
  ),
  cosmetic: [
    ...headerText,
    ...cosmetic(['angajator/@den'], names),
    ...cosmetic([
      'angajator/@adrSoc',
      'angajator/@adrFisc',
      'asigurat/@numeAsig',
      'asigurat/@prenAsig',
    ]),
  ],
});

const d205: ReturnCatalogue = {
  id: 'D205-v3',
  form: 'D205',
  version: 3,
  root: 'declaratie205',
  repeated: [
    { path: 'sect_II', keys: keys('tip_venit') },
    // d205.ts: the validator's identity is income type + CNP/NIF, not id_inreg.
    { path: 'benef', keys: [...keys('tip_venit1'), sensitive('cifR')] },
  ],
  ignored: [
    schemaLocation,
    ...noText('', 'sect_II', 'benef'),
    {
      path: 'benef/@id_inreg',
      reason: 'Writer-assigned ordinal; income type and cifR identify the row.',
    },
  ],
  numeric: exact(
    '@an',
    '@luna',
    '@totalPlata_A',
    ...attributes('sect_II', 'nrben Tcastig Tpierd Tbaza Timp T_VB T_GAR'),
    ...attributes('benef', 'baza1 imp1 divid_D divid_P VB GAR'),
  ),
  cosmetic: [...headerText, ...headerNames, ...cosmetic(['benef/@den1'])],
};

const s1005: ReturnCatalogue = {
  id: 'S1005-2025',
  form: 'S1005',
  version: 15,
  root: 'Bilant1005',
  period: { from: '2025-12', through: '2025-12' },
  repeated: [], // form.ts Statement.xml writes one F10/F20/F30/F40, with cells as attributes.
  ignored: [schemaLocation, ...noText('', 'F10', 'F20', 'F30', 'F40')],
  numeric: exact(
    '@an',
    '@luna',
    '@totalPlata_A',
    ...Object.entries({
      F10: s1005F10Rows,
      F20: s1005F20Rows,
      F30: s1005F30Rows,
      F40: s1005F40Rows,
    }).flatMap(([form, rows]) =>
      rows.flatMap((row) => row.columns.map((column) => `${form}/@${form}_${row.code}${column}`)),
    ),
  ),
  cosmetic: [
    ...headerNames,
    ...cosmetic(['@adresa', '@nume_admin', '@nume_intocmit']),
    ...cosmetic(['@den_audi'], names),
  ],
};

export const returnCatalogues: readonly ReturnCatalogue[] = [
  d300(11),
  d300(12),
  d394,
  d390,
  d100,
  d112(1),
  d112(2),
  d205,
  s1005,
];

export function matches(selector: FieldSelector, path: string): boolean {
  if (typeof selector === 'string') return selector === path;
  // Ignore stateful flags so a caller's /g or /y selector cannot depend on iteration order.
  return new RegExp(selector.source, selector.flags.replace(/[gy]/g, '')).test(path);
}

export function catalogueApplies(
  catalogue: ReturnCatalogue,
  declaration: FiledDeclaration,
): boolean {
  if (catalogue.form !== declaration.form || catalogue.version !== declaration.version)
    return false;
  if (!catalogue.period) return true;
  const { year, month } = declaration.period ?? {};
  if (!year || !month || !/^\d{4}$/.test(year) || !/^0?[1-9]$|^1[0-2]$/.test(month)) return false;
  const period = `${year}-${month.padStart(2, '0')}`;
  return period >= catalogue.period.from && period <= catalogue.period.through;
}

export function catalogueFor(declaration: FiledDeclaration): ReturnCatalogue {
  const candidates = returnCatalogues.filter((catalogue) =>
    catalogueApplies(catalogue, declaration),
  );
  if (candidates.length !== 1)
    throw new Error(
      'RETURN_CATALOGUE: Nu există un catalog unic pentru forma, versiunea și perioada declarației.',
    );
  return candidates[0]!;
}
