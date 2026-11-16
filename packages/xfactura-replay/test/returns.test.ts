import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sourceXml, type XmlElement } from 'xfactura-core/xml';
import { readDeclaration } from 'xfactura-core/ro/declarations/read';
import {
  catalogueFor,
  compareReturns,
  inspectReturnKeys,
  returnCatalogues,
  summarize,
  type ReturnCatalogue,
} from '../src/compare/returns';
import { matches } from '../src/compare/catalogues';
import {
  beneficiariesReturn,
  domesticReturn,
  payrollReturn,
  returnFixtures,
  viesReturn,
} from './fixtures/returns';

const bytes = (xml: string) => new TextEncoder().encode(xml);
const read = (xml: string) => readDeclaration(bytes(xml));
const amountPaths = {
  'D300-2025-08': 'declaratie300/@R9_1',
  'D300-2026-01': 'declaratie300/@R9_1',
  'D394-2025-08': 'declaratie394/op1[tip_partener=1,tip=L,cuiP=14399840,cota=21]/@baza',
  'D390-v3': 'declaratie390/operatie[tip=S,tara=IE,codO=6388047V]/@baza',
  'D100-v2': 'declaratie100/obligatie[cod_oblig=604]/@suma_dat',
  'D112-2026-01': 'declaratieUnica/asigurat[cnpAsig=1781105170030]/asiguratA/@A_sal1',
  'D112-2026-07': 'declaratieUnica/asigurat[cnpAsig=1781105170030]/asiguratA/@A_sal1',
  'D205-v3': 'declaratie205/benef[tip_venit1=08,cifR=1781105170030]/@baza1',
  'S1005-2025': 'Bilant1005/F10/@F10_0012',
};
// Keep identity expectations independent of the catalogues so removing a component from
// a multi-attribute key changes matching and fails its mutation test.
const writerKeys: Record<string, Record<string, readonly string[]>> = {
  D394: {
    rezumat1: ['tip_partener', 'cota', 'document_N'],
    'rezumat1/detaliu': ['bun'],
    rezumat2: ['cota'],
    serieFacturi: ['tip', 'serieI', 'cui', 'nrI'],
    facturi: ['tip_factura', 'serie', 'nr'],
    op1: ['tip_partener', 'tip', 'cuiP', 'cota'],
    'op1/op11': ['codPR'],
    op2: ['tip_op2', 'luna'],
  },
  D390: { operatie: ['tip', 'tara', 'codO'] },
  D100: { obligatie: ['cod_oblig'] },
  D112: {
    'angajator/angajatorA': ['A_codOblig'],
    asigurat: ['cnpAsig'],
    'asigurat/asiguratD': ['D_1', 'D_2'],
  },
  D205: { sect_II: ['tip_venit'], benef: ['tip_venit1', 'cifR'] },
};
const parse = (xml: string) =>
  sourceXml(bytes(xml), { maxAttributes: 2048, namespacedAttributes: true });
const escape = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
function xml(node: XmlElement, root = true): string {
  const attributes = Object.entries(node.attributes)
    .map(([name, value]) => ` ${name}="${escape(value)}"`)
    .join('');
  const namespaced = (node.namespacedAttributes ?? [])
    .map(({ local, value }) => ` xsi:${local}="${escape(value)}"`)
    .join('');
  const namespace = root
    ? ` xmlns="${node.uri}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`
    : '';
  return `<${node.local}${namespace}${attributes}${namespaced}>${escape(node.text)}${node.children.map((child) => xml(child, false)).join('')}</${node.local}>`;
}
function nodes(root: XmlElement, path: string): XmlElement[] {
  return path
    ? path
        .split('/')
        .reduce(
          (parents, name) =>
            parents.flatMap((parent) => parent.children.filter((child) => child.local === name)),
          [root],
        )
    : [root];
}
function field(root: XmlElement, path: string): { node: XmlElement; attribute: string } {
  const at = path.lastIndexOf('@');
  return {
    node: nodes(root, path.slice(0, Math.max(0, at - 1)))[0]!,
    attribute: path.slice(at + 1),
  };
}
function setField(root: XmlElement, path: string, value: string) {
  const target = field(root, path);
  target.node.attributes[target.attribute] = value;
}
function ensureNode(root: XmlElement, path: string): XmlElement {
  let current = root;
  for (const local of path.split('/')) {
    let child = current.children.find((item) => item.local === local);
    if (!child) {
      child = { local, uri: root.uri, attributes: {}, children: [], text: '' };
      current.children.push(child);
    }
    current = child;
  }
  return current;
}
function compare(original: string, changed: XmlElement, catalogue = catalogueFor(read(original))) {
  return compareReturns(read(original), read(xml(changed)), catalogue);
}
function reorder(node: XmlElement) {
  node.children.reverse();
  node.attributes = Object.fromEntries(Object.entries(node.attributes).reverse());
  node.children.forEach(reorder);
  for (const name of ['asigurat', 'benef']) {
    node.children
      .filter((child) => child.local === name)
      .forEach((child, index) => {
        child.attributes[name === 'asigurat' ? 'idAsig' : 'id_inreg'] = String(index + 1);
      });
  }
}
function replaceOccurrence(
  root: XmlElement,
  path: string,
  attribute: string,
  occurrence = -1,
  value = 'ADDED',
) {
  const segments = path.split('/');
  const name = segments.pop()!;
  const parent = nodes(root, segments.join('/')).find(
    (candidate) => candidate.children.filter((child) => child.local === name).length >= 2,
  )!;
  expect(parent).toBeDefined();
  const removed = parent.children.filter((child) => child.local === name).at(occurrence)!;
  const added = structuredClone(removed);
  added.attributes[attribute] = value;
  parent.children = [...parent.children.filter((child) => child !== removed), added];
}

test('covers exactly the nine writer layouts, with eight D394 and three D112 repeated paths', () => {
  expect(returnCatalogues.map((catalogue) => catalogue.id)).toEqual(
    returnFixtures.map((fixture) => fixture.id),
  );
  expect(returnCatalogues.map((catalogue) => catalogue.repeated.length)).toEqual([
    0, 0, 8, 1, 1, 3, 3, 2, 0,
  ]);
  expect(
    returnCatalogues.every((catalogue) =>
      catalogue.ignored.every((rule) => rule.reason.length > 0),
    ),
  ).toBe(true);
  // A deterministic writer rounding rule does not authorize differences between filed values.
  expect(
    returnCatalogues.every((catalogue) =>
      catalogue.numeric.every((rule) => rule.tolerance === '0'),
    ),
  ).toBe(true);
});

for (const fixture of returnFixtures)
  describe(fixture.id, () => {
    test('reads actual writer output twice and is invariant under reordering and ordinal renumbering', () => {
      const original = fixture.write();
      const declaration = read(original);
      const catalogue = catalogueFor(declaration);
      expect(catalogue.id).toBe(fixture.id);
      expect(compareReturns(declaration, read(original), catalogue)).toEqual([]);
      const changed = parse(original);
      reorder(changed);
      expect(compare(original, changed)).toEqual([]);
      // Every catalogue key, including nested details/certificates, has multiple writer rows.
      expect(
        Object.values(inspectReturnKeys(declaration, catalogue)).every((count) => count >= 2),
      ).toBe(true);
    });

    test('reports exactly one amount, one text and, where the format repeats, one removal and one addition', () => {
      const original = fixture.write();
      const changed = parse(original);
      const catalogue = catalogueFor(read(original));
      const target = field(changed, fixture.amount);
      expect(target.node.attributes[target.attribute]).toBeDefined();
      target.node.attributes[target.attribute] = (
        BigInt(target.node.attributes[target.attribute]!) + 1n
      ).toString();
      setField(changed, fixture.text, 'Altă denumire de test');
      const repeated = catalogue.repeated[0];
      if (repeated)
        replaceOccurrence(changed, repeated.path, writerKeys[catalogue.form]![repeated.path]![0]!);
      const result = compare(original, changed);
      expect(result).toHaveLength(repeated ? 4 : 2);
      expect(result.filter((difference) => difference.class === 'amount')).toMatchObject([
        { path: amountPaths[fixture.id], kind: 'different', delta: '-1' },
      ]);
      const originalText = field(parse(original), fixture.text);
      expect(result.filter((difference) => difference.class === 'text')).toMatchObject([
        {
          path: `${catalogue.root}/${fixture.text}`,
          kind: 'different',
          class: 'text',
          engine: originalText.node.attributes[originalText.attribute],
          filed: 'Altă denumire de test',
        },
      ]);
      const structure = result.filter((difference) => difference.class === 'structure');
      expect(structure.map((difference) => difference.kind).sort()).toEqual(
        repeated ? ['only-engine', 'only-filed'] : [],
      );
      expect(result.every((difference) => !/\[\d+\]/.test(difference.path))).toBe(true);
      for (const difference of structure) {
        expect(difference.path).toContain('=');
        expect(difference.kind === 'only-engine' ? difference.filed : difference.engine).toBeNull();
        expect(
          typeof (difference.kind === 'only-engine' ? difference.engine : difference.filed),
        ).toBe('object');
      }
    });

    const catalogue = returnCatalogues.find((item) => item.id === fixture.id)!;
    for (const [path, attributes] of Object.entries(writerKeys[catalogue.form] ?? {}))
      for (const attribute of attributes)
        test(`matches ${path}/@${attribute} by key and collapses unmatched subtrees`, () => {
          const original = fixture.write();
          const changed = parse(original);
          replaceOccurrence(changed, path, attribute, 0);
          const differences = compare(original, changed);
          expect(differences).toHaveLength(2);
          expect(differences.every((difference) => difference.class === 'structure')).toBe(true);
          expect(differences.map((difference) => difference.kind).sort()).toEqual([
            'only-engine',
            'only-filed',
          ]);
          expect(differences.every((difference) => difference.path.endsWith(']'))).toBe(true);
          expect(differences.every((difference) => difference.path.includes(`${attribute}=`))).toBe(
            true,
          );
        });
  });

const variantKeys = [
  {
    id: 'D390-v3',
    name: 'uncoded operation',
    path: 'operatie',
    attributes: ['tip', 'tara', 'denO'],
    prepare: (root: XmlElement) => {
      delete nodes(root, 'operatie')[0]!.attributes.codO;
    },
  },
  {
    id: 'D394-2025-08',
    name: 'uncoded partner',
    path: 'op1',
    attributes: [
      'tip_partener',
      'tip',
      'cota',
      'denP',
      'taraP',
      'judP',
      'locP',
      'strP',
      'nrP',
      'blP',
      'apP',
      'detP',
    ],
    prepare: (root: XmlElement) => {
      const partner = nodes(root, 'op1')[0]!;
      delete partner.attributes.cuiP;
      partner.attributes.tip_partener = '2';
    },
  },
  {
    id: 'D394-2025-08',
    name: 'coded type 2 partner',
    path: 'op1',
    attributes: ['tip_partener', 'tip', 'cuiP', 'cota'],
    prepare: (root: XmlElement) => {
      nodes(root, 'op1')[0]!.attributes.tip_partener = '2';
    },
  },
  {
    id: 'D100-v2',
    name: 'excise obligation',
    path: 'obligatie',
    attributes: ['cod_oblig', 'scadenta'],
    prepare: (root: XmlElement) => {
      for (const obligation of nodes(root, 'obligatie')) obligation.attributes.cod_oblig = '201';
      nodes(root, 'obligatie')[1]!.attributes.scadenta = '26.07.2026';
    },
  },
];
for (const variant of variantKeys)
  for (const attribute of variant.attributes)
    test(`${variant.name}: mutating ${attribute} changes row identity`, () => {
      const root = parse(returnFixtures.find((fixture) => fixture.id === variant.id)!.write());
      variant.prepare(root);
      const original = xml(root);
      replaceOccurrence(
        root,
        variant.path,
        attribute,
        0,
        attribute === 'cod_oblig' ? '202' : 'ADDED',
      );
      const differences = compare(original, root);
      expect(differences).toHaveLength(2);
      expect(differences.map((difference) => difference.kind).sort()).toEqual([
        'only-engine',
        'only-filed',
      ]);
      expect(
        differences.every(
          (difference) =>
            difference.class === 'structure' && difference.path.includes(`${attribute}=`),
        ),
      ).toBe(true);
    });

const reviewedNumericFields: Record<string, readonly string[]> = {
  D100: ['obligatie/@suma_AMEF', 'obligatie/@suma_bonif', 'obligatie/@suma_spons'],
  D394: [
    'informatii/@nrFacturiLS_PF',
    'informatii/@nrFacturiL_PF',
    'informatii/@val_LS_PF',
    'rezumat2/@bazaL_PF',
    'rezumat2/@tvaL_PF',
  ],
  D112: [
    'angajator/angajatorD/@D2',
    'angajator/angajatorD/@D3',
    'angajator/angajatorE1/@E1_baza',
    'angajator/angajatorE1/@E1_venit',
    'angajator/angajatorE2/@E2_10',
    'angajator/angajatorE2/@E2_140',
    'angajator/angajatorE2/@E2_66',
    'angajator/angajatorE3/@E3_suma',
    'angajator/angajatorE3/@E3_total',
    'angajator/angajatorF1/@F1_deplata',
    'angajator/angajatorF1/@F1_suma',
    'angajator/angajatorF1/@F1_suma_ded',
    'angajator/angajatorF1/@F1_suma_scut',
    'asigurat/@Tcota_E4',
    'asigurat/@Tsuma_E4',
    ...['52', '54', '59', '61', '62', '64', '67'].map(
      (suffix) => `asigurat/asiguratE3/@E3_${suffix}`,
    ),
  ],
};
for (const fixture of returnFixtures) {
  const catalogue = returnCatalogues.find((item) => item.id === fixture.id)!;
  for (const path of reviewedNumericFields[catalogue.form] ?? [])
    test(`${fixture.id}: compares reviewed numeric ${path} exactly and preserves zero omissions`, () => {
      const root = parse(fixture.write());
      const at = path.indexOf('/@');
      const element = ensureNode(root, path.slice(0, at));
      const attribute = path.slice(at + 2);
      element.attributes[attribute] = '5.01';
      const original = xml(root);
      element.attributes[attribute] = '6.01';
      const amount = compare(original, root);
      expect(amount).toHaveLength(1);
      expect(amount[0]).toMatchObject({
        kind: 'different',
        class: 'amount',
        engine: '5.01',
        filed: '6.01',
        delta: '-1',
      });
      expect(amount[0]!.path.endsWith(`/@${attribute}`)).toBe(true);
      const canonicalPath = amount[0]!.path;
      delete element.attributes[attribute];
      const absent = read(xml(root));
      expect(compareReturns(read(original), absent, catalogue)).toMatchObject([
        {
          path: canonicalPath,
          kind: 'only-engine',
          class: 'text',
          engine: '5.01',
          filed: null,
        },
      ]);
      element.attributes[attribute] = '0.00';
      const omissions = compareReturns(read(xml(root)), absent, catalogue);
      expect(omissions).toMatchObject([
        {
          path: canonicalPath,
          kind: 'only-engine',
          class: 'zero-omission',
          engine: '0.00',
          filed: null,
        },
      ]);
      expect(summarize(omissions, 'key').byClass['zero-omission']).toBe(1);
    });
}

describe('matching and refusals', () => {
  test('keys remain the same when two rows become one unindexed row', () => {
    const original = viesReturn();
    const changed = parse(original);
    changed.children = changed.children.filter((child) => child.attributes.codO !== '123456788');
    expect(compare(original, changed)).toMatchObject([
      {
        path: 'declaratie390/operatie[tip=P,tara=DE,codO=123456788]',
        kind: 'only-engine',
        class: 'structure',
        filed: null,
      },
    ]);
  });

  test('refuses different forms, versions, periods, incomplete periods and a mismatched catalogue', () => {
    const original = read(viesReturn());
    const catalogue = catalogueFor(original);
    expect(() => compareReturns(original, { ...original, form: 'D394' }, catalogue)).toThrow(
      'RETURN_FORM',
    );
    expect(() => compareReturns(original, { ...original, version: 4 }, catalogue)).toThrow(
      'RETURN_VERSION',
    );
    expect(() =>
      compareReturns(
        original,
        { ...original, period: { ...original.period!, month: '11' } },
        catalogue,
      ),
    ).toThrow('RETURN_PERIOD');
    expect(() =>
      compareReturns({ ...original, period: null }, { ...original, period: null }, catalogue),
    ).toThrow('RETURN_PERIOD_UNKNOWN');
    expect(() => compareReturns(original, original, returnCatalogues[0]!)).toThrow(
      'RETURN_CATALOGUE',
    );
    expect(() => catalogueFor({ ...original, version: 99 })).toThrow('RETURN_CATALOGUE');
    const january = read(payrollReturn(1));
    expect(() =>
      compareReturns(
        january,
        january,
        returnCatalogues.find((item) => item.id === 'D112-2026-07')!,
      ),
    ).toThrow('RETURN_CATALOGUE');
  });

  test('month spelling and property order do not change a period', () => {
    const original = read(viesReturn());
    const other = { ...original, period: { quarter: null, month: '010', year: '2026' } };
    expect(compareReturns(original, other, catalogueFor(original))).toEqual([]);
  });

  test('refuses missing/duplicate identities and unkeyed repeated elements without printing identities', () => {
    const original = payrollReturn(2);
    const missing = parse(original);
    delete nodes(missing, 'asigurat')[0]!.attributes.cnpAsig;
    expect(() => compare(original, missing)).toThrow('RETURN_KEY_MISSING');
    const duplicate = parse(original);
    nodes(duplicate, 'asigurat')[1]!.attributes.cnpAsig = '1781105170030';
    try {
      compare(original, duplicate);
      throw new Error('expected failure');
    } catch (error) {
      expect(String(error)).toContain('RETURN_KEY_DUPLICATE');
      expect(String(error)).not.toContain('1781105170030');
    }
    const unknown = parse(viesReturn());
    const extra = { ...structuredClone(unknown.children[0]!), local: 'unknown' };
    unknown.children.push(extra, structuredClone(extra));
    expect(() => compare(viesReturn(), unknown)).toThrow('RETURN_UNKEYED_REPEAT');
  });

  test('scopes nested keys to parents and refuses duplicate certificates within one person', () => {
    const original = payrollReturn(2);
    const changed = parse(original);
    const sick = nodes(changed, 'asigurat')[1]!;
    const another = structuredClone(sick);
    another.attributes.cnpAsig = '2850722170021';
    changed.children.push(another);
    expect(compare(original, changed)).toMatchObject([{ class: 'structure', kind: 'only-filed' }]);
    sick.children.push(
      structuredClone(sick.children.find((child) => child.local === 'asiguratD')!),
    );
    expect(() => compare(original, changed)).toThrow('RETURN_KEY_DUPLICATE');
  });

  test('D100 due date is a comparable field except for excise obligations', () => {
    const fixture = returnFixtures.find((item) => item.id === 'D100-v2')!;
    const original = fixture.write();
    const changed = parse(original);
    setField(changed, 'obligatie/@scadenta', '25.08.2026');
    expect(compare(original, changed)).toMatchObject([
      {
        class: 'text',
        kind: 'different',
        path: 'declaratie100/obligatie[cod_oblig=604]/@scadenta',
        engine: '25.07.2026',
        filed: '25.08.2026',
      },
    ]);
    const excise = parse(original);
    for (const child of nodes(excise, 'obligatie')) child.attributes.cod_oblig = '201';
    nodes(excise, 'obligatie')[1]!.attributes.scadenta = '26.07.2026';
    const declaration = read(xml(excise));
    expect(compareReturns(declaration, declaration, catalogueFor(declaration))).toEqual([]);
  });

  test('D394 summary document types and series range starts distinguish otherwise equal keys', () => {
    const original = parse(domesticReturn());
    const summary = nodes(original, 'rezumat1')[0]!;
    const another = structuredClone(summary);
    summary.attributes.document_N = '1';
    another.attributes.document_N = '2';
    original.children.push(another);
    const range = nodes(original, 'serieFacturi')[0]!;
    const secondRange = structuredClone(range);
    secondRange.attributes.nrI = '100000';
    original.children.push(secondRange);
    const declaration = read(xml(original));
    expect(compareReturns(declaration, declaration, catalogueFor(declaration))).toEqual([]);
  });

  test('escapes key delimiters and retains text leaves and namespaced attributes', () => {
    const original = parse(viesReturn());
    const operation = nodes(original, 'operatie')[0]!;
    operation.attributes.codO = 'A/B,[x]=%~';
    const first = xml(original);
    operation.attributes.baza = '499';
    expect(compare(first, original)).toMatchObject([
      {
        path: 'declaratie390/operatie[tip=S,tara=IE,codO=A%2FB%2C%5Bx%5D%3D%25%7E]/@baza',
        delta: '-1',
      },
    ]);
    const simple =
      '<declaratie390 xmlns="mfp:anaf:dgti:d390:declaratie:v3" an="2026" luna="10" xmlns:t="https://example.test/a/b" t:code="one"><note>Alpha</note></declaratie390>';
    const changes = compareReturns(
      read(simple),
      read(simple.replace('one', 'two').replace('Alpha', 'Beta')),
      catalogueFor(read(simple)),
    );
    expect(changes).toMatchObject([
      {
        path: 'declaratie390/@{https://example.test/a/b}code',
        kind: 'different',
        class: 'text',
        engine: 'one',
        filed: 'two',
      },
      {
        path: 'declaratie390/note/#text',
        kind: 'different',
        class: 'text',
        engine: 'Alpha',
        filed: 'Beta',
      },
    ]);
  });

  test('does not silently ignore unknown fields or convert missing amounts to zero', () => {
    const original = viesReturn();
    const changed = parse(original);
    delete nodes(changed, 'operatie')[0]!.attributes.baza;
    changed.attributes.unrecognized = '0';
    const differences = compare(original, changed);
    expect(differences).toMatchObject([
      {
        path: 'declaratie390/@unrecognized',
        kind: 'only-filed',
        engine: null,
        filed: '0',
        class: 'text',
      },
      {
        path: 'declaratie390/operatie[tip=S,tara=IE,codO=6388047V]/@baza',
        kind: 'only-engine',
        engine: '498',
        filed: null,
        class: 'text',
      },
    ]);
  });
});

describe('exact decimals and field-specific cosmetics', () => {
  test.each([
    ['100000000000000000000000.10', '100000000000000000000000.11', '-0.01'],
    ['-10.0001', '0.0009', '-10.001'],
    ['10.00', '0', '10'],
    ['-0.001', '-1.001', '1'],
    ['.10', '+.11', '-0.01'],
    ['-10.', '-.50', '-9.5'],
  ])('subtracts %s minus %s exactly', (engine, filed, delta) => {
    const original = parse(viesReturn());
    setField(original, 'operatie/@baza', engine);
    const first = xml(original);
    setField(original, 'operatie/@baza', filed);
    expect(compare(first, original)).toMatchObject([{ class: 'amount', delta }]);
  });

  test('numeric spellings compare equally, while codes remain text', () => {
    const original = parse(viesReturn());
    setField(original, 'operatie/@baza', '+00498.000');
    expect(compare(viesReturn(), original)).toEqual([]);
    original.attributes.cui = '018547290';
    expect(compare(viesReturn(), original)).toMatchObject([
      {
        path: 'declaratie390/@cui',
        kind: 'different',
        class: 'text',
        engine: '18547290',
        filed: '018547290',
      },
    ]);
    setField(original, 'operatie/@baza', 'not-a-number');
    expect(compare(viesReturn(), original)).toMatchObject([
      {
        path: 'declaratie390/@cui',
        kind: 'different',
        class: 'text',
        engine: '18547290',
        filed: '018547290',
      },
      {
        path: 'declaratie390/operatie[tip=S,tara=IE,codO=6388047V]/@baza',
        kind: 'different',
        class: 'text',
        engine: '498',
        filed: 'not-a-number',
      },
    ]);
  });

  test('uses inclusive exact tolerance only on the specified field', () => {
    const original = viesReturn();
    // Synthetic comparison policy only, not an assertion of an ANAF rounding allowance.
    const catalogue: ReturnCatalogue = {
      ...catalogueFor(read(original)),
      numeric: [{ path: 'operatie/@baza', tolerance: '0.01' }],
    };
    for (const [value, expected] of [
      ['498.01', 'rounding'],
      ['497.99', 'rounding'],
      ['498.0100000000000001', 'amount'],
    ] as const) {
      const changed = parse(original);
      setField(changed, 'operatie/@baza', value);
      expect(compare(original, changed, catalogue)[0]!.class).toBe(expected);
    }
    const changed = parse(original);
    setField(changed, '@totalPlata_A', '650.001');
    expect(compare(original, changed, catalogue)).toMatchObject([
      {
        path: 'declaratie390/@totalPlata_A',
        kind: 'different',
        class: 'text',
        engine: '650',
        filed: '650.001',
      },
    ]);
    expect(() =>
      compare(original, changed, {
        ...catalogue,
        numeric: [{ path: 'operatie/@baza', tolerance: '-1' }],
      }),
    ).toThrow('RETURN_TOLERANCE');
  });

  test('all four permitted cosmetic transformations are reported, not discarded', () => {
    const original = viesReturn();
    const changed = parse(original);
    changed.attributes.den = '  EXEMPLU SERVICII S.R.L.  ';
    changed.attributes.adresa = '  str. lungă nr. 10 galați ';
    const differences = compare(original, changed);
    expect(differences).toHaveLength(2);
    expect(differences.every((difference) => difference.class === 'cosmetic')).toBe(true);
    changed.attributes.den = 'Exemplu  Servicii SRL';
    expect(
      compare(original, changed).filter((difference) => difference.class === 'text'),
    ).toMatchObject([
      {
        path: 'declaratie390/@den',
        kind: 'different',
        class: 'text',
        engine: 'Exemplu Servicii SRL',
        filed: 'Exemplu  Servicii SRL',
      },
    ]);
  });

  test('normalization is restricted to configured fields and applies to uncoded name keys', () => {
    const original = parse(viesReturn());
    delete nodes(original, 'operatie')[0]!.attributes.codO;
    const first = xml(original);
    nodes(original, 'operatie')[0]!.attributes.denO = ' SUPPLIER LIMITED ';
    expect(compare(first, original)).toMatchObject([
      {
        path: 'declaratie390/operatie[tip=S,tara=IE,denO=supplier%20limited]/@denO',
        kind: 'different',
        class: 'cosmetic',
        engine: 'Supplier Limited',
        filed: ' SUPPLIER LIMITED ',
      },
    ]);
    nodes(original, 'operatie')[1]!.attributes.codO = ' 123456788 ';
    expect(
      compare(first, original).filter((difference) => difference.class === 'structure'),
    ).toHaveLength(2);
  });

  test('ignore selectors do not mask a same-named field elsewhere', () => {
    const original = parse(viesReturn());
    original.children[0]!.attributes.nr_pag = '100';
    original.attributes.nr_pag = '100';
    expect(compare(viesReturn(), original)).toMatchObject([
      {
        path: 'declaratie390/@nr_pag',
        kind: 'only-filed',
        class: 'text',
        engine: null,
        filed: '100',
      },
    ]);
    expect(matches(/^operatie\/@baza$/g, 'operatie/@baza')).toBe(true);
    expect(matches(/^operatie\/@baza$/g, 'operatie/@baza')).toBe(true);
  });
});

describe('review regressions', () => {
  test.each([
    ['1', ' 1900101400012 '],
    ['2', ' 1900101400012 '],
    ['2', ' PRIVATE-INDIVIDUAL-CODE '],
  ])('pseudonymizes D394 type %s partner keys including surrounding spaces', (type, code) => {
    const root = parse(domesticReturn());
    const partner = nodes(root, 'op1')[0]!;
    partner.attributes.tip_partener = type;
    partner.attributes.cuiP = code;
    const original = xml(root);
    partner.attributes.baza = '1001';
    const differences = compare(original, root);
    expect(differences).toHaveLength(1);
    if (type === '2') expect(differences[0]!.sensitiveKeys).toContain('cuiP');
    const summary = JSON.stringify(summarize(differences, 'privacy-regression-key'));
    expect(summary).toContain('cuiP=hmac-sha256:');
    expect(summary).not.toContain(code.trim());
    expect(summary).not.toContain(encodeURIComponent(code));
  });

  test('summarizes D390 uncoded partner keys without exposing the name', () => {
    const root = parse(viesReturn());
    const operation = nodes(root, 'operatie')[0]!;
    delete operation.attributes.codO;
    operation.attributes.denO = 'Nume Privat SA';
    const original = xml(root);
    operation.attributes.baza = '499';
    const summary = summarize(compare(original, root), 'privacy-regression-key');
    expect(summary.total).toBe(1);
    expect(summary.byClass.amount).toBe(1);
    const serialized = JSON.stringify(summary).toLowerCase();
    expect(serialized).toContain('deno=hmac-sha256:');
    for (const value of ['nume', 'privat', '"499"', '"498"', '"engine"', '"filed"', '"delta"'])
      expect(serialized).not.toContain(value);
  });

  test('ignores only whitespace text on catalogued elements without text content', () => {
    const original = domesticReturn();
    const root = parse(original);
    const summary = nodes(root, 'rezumat1').find((item) => item.children.length === 0)!;
    summary.text = '\n    \t\n';
    expect(read(xml(root)).fields.some((entry) => entry.path.endsWith('/#text'))).toBe(true);
    expect(compare(original, root)).toEqual([]);
    summary.text = '\nunexpected content\n';
    expect(compare(original, root)).toMatchObject([
      {
        path: 'declaratie394/rezumat1[tip_partener=1,cota=11,document_N=~]/#text',
        kind: 'only-filed',
        class: 'text',
        engine: null,
        filed: '\nunexpected content\n',
      },
    ]);
    summary.text = '';
    root.children.push({
      local: 'unknown',
      uri: root.uri,
      attributes: {},
      children: [],
      text: '\n  ',
    });
    expect(compare(original, root)).toMatchObject([
      {
        path: 'declaratie394/unknown/#text',
        kind: 'only-filed',
        class: 'text',
        engine: null,
        filed: '\n  ',
      },
    ]);
  });

  test.each(['D390', 'D394'])(
    '%s keeps legal forms distinct in uncoded name identities',
    (form) => {
      const root = parse(form === 'D390' ? viesReturn() : domesticReturn());
      const partner = nodes(root, form === 'D390' ? 'operatie' : 'op1')[0]!;
      const name = form === 'D390' ? 'denO' : 'denP';
      delete partner.attributes[form === 'D390' ? 'codO' : 'cuiP'];
      if (form === 'D394') partner.attributes.tip_partener = '2';
      partner.attributes[name] = 'Ștefan SRL';
      const original = xml(root);
      partner.attributes[name] = '  STEFAN SRL  ';
      expect(compare(original, root)).toMatchObject([
        {
          kind: 'different',
          class: 'cosmetic',
          engine: 'Ștefan SRL',
          filed: '  STEFAN SRL  ',
        },
      ]);
      partner.attributes[name] = 'Ștefan SA';
      const differences = compare(original, root);
      expect(differences).toHaveLength(2);
      expect(differences.map((difference) => difference.class)).toEqual(['structure', 'structure']);
      expect(differences.map((difference) => difference.kind).sort()).toEqual([
        'only-engine',
        'only-filed',
      ]);
      expect(differences.some((difference) => difference.path.includes('stefan%20srl'))).toBe(true);
      expect(differences.some((difference) => difference.path.includes('stefan%20sa'))).toBe(true);
      // Distinct legal forms also coexist in the same return without a duplicate-key error.
      const another = structuredClone(partner);
      another.attributes[name] = 'Ștefan SRL';
      root.children.push(another);
      const declaration = read(xml(root));
      expect(compareReturns(declaration, declaration, catalogueFor(declaration))).toEqual([]);
    },
  );

  test.each(['0', '-0.00', '+000.000', '.0', ' 0.000 '])(
    'keeps a numeric %s omission as its own difference in both directions',
    (zero) => {
      const root = parse(viesReturn());
      const operation = nodes(root, 'operatie')[0]!;
      operation.attributes.baza = zero;
      const original = xml(root);
      delete operation.attributes.baza;
      const catalogue = catalogueFor(read(original));
      const difference = {
        path: 'declaratie390/operatie[tip=S,tara=IE,codO=6388047V]/@baza',
        kind: 'only-engine',
        class: 'zero-omission',
        engine: zero,
        filed: null,
      };
      const forward = compare(original, root);
      expect(forward).toMatchObject([difference]);
      expect(compareReturns(read(xml(root)), read(original), catalogue)).toMatchObject([
        {
          ...difference,
          kind: 'only-filed',
          engine: null,
          filed: zero,
        },
      ]);
      expect(summarize(forward, 'key').byClass).toHaveProperty('zero-omission', 1);
      expect(forward[0]).not.toHaveProperty('delta');
      const absent = read(xml(root));
      operation.attributes.baza = '0.0001';
      expect(compareReturns(read(xml(root)), absent, catalogue)).toMatchObject([
        {
          path: difference.path,
          kind: 'only-engine',
          class: 'text',
          engine: '0.0001',
          filed: null,
        },
      ]);
    },
  );
});

describe('private values and shareable summaries', () => {
  test.each([payrollReturn(1), payrollReturn(2), beneficiariesReturn()])(
    'removes personal keys, values and deltas from summary',
    (original) => {
      const changed = parse(original);
      const catalogue = catalogueFor(read(original));
      const person = nodes(changed, catalogue.form === 'D112' ? 'asigurat' : 'benef')[0]!;
      const nameAttribute = catalogue.form === 'D112' ? 'numeAsig' : 'den1';
      const originalName = person.attributes[nameAttribute]!;
      person.attributes[catalogue.form === 'D112' ? 'numeAsig' : 'den1'] = 'PRIVATE-SENTINEL';
      person.attributes.secretAmount = '987654321.12345';
      const differences = compare(original, changed);
      const personPath =
        catalogue.form === 'D112'
          ? 'declaratieUnica/asigurat[cnpAsig=1781105170030]'
          : 'declaratie205/benef[tip_venit1=08,cifR=1781105170030]';
      expect(differences).toMatchObject([
        {
          path: `${personPath}/@${nameAttribute}`,
          kind: 'different',
          class: 'text',
          engine: originalName,
          filed: 'PRIVATE-SENTINEL',
        },
        {
          path: `${personPath}/@secretAmount`,
          kind: 'only-filed',
          class: 'text',
          engine: null,
          filed: '987654321.12345',
        },
      ]);
      const summary = summarize(differences, 'caller-secret-one');
      const serialized = JSON.stringify(summary);
      for (const secret of [
        '1781105170030',
        'PRIVATE-SENTINEL',
        '987654321.12345',
        'Dumitrescu',
        'caller-secret-one',
        '"engine"',
        '"filed"',
        '"delta"',
      ])
        expect(serialized).not.toContain(secret);
      expect(serialized).toContain('hmac-sha256:');
      expect(summary.byClass.text).toBe(2);
      expect(summary.bySection[catalogue.form === 'D112' ? 'asigurat' : 'benef']).toBe(2);
      expect(summarize(differences, 'caller-secret-one')).toEqual(summary);
      expect(summarize(differences, 'caller-secret-two').paths).not.toEqual(summary.paths);
      expect(() => summarize(differences, '')).toThrow('RETURN_HASH_KEY');
    },
  );

  test('hashes nested certificate identities, uncoded partner details and D394 personal codes', () => {
    const payroll = payrollReturn(2);
    const changed = parse(payroll);
    setField(changed, 'asigurat/asiguratD/@D_19', '283.47');
    const summary = JSON.stringify(summarize(compare(payroll, changed), 'key'));
    for (const secret of ['2931204170043', 'CCMAM', '283.47', 'D_2=1001'])
      expect(summary).not.toContain(secret);
    const domestic = domesticReturn();
    const partners = parse(domestic);
    nodes(partners, 'op1').at(-1)!.attributes.baza = '301';
    const names = JSON.stringify(summarize(compare(domestic, partners), 'key'));
    for (const secret of ['georgescu', 'elena', 'galati', 'brailei'])
      expect(names.toLowerCase()).not.toContain(secret);
    nodes(partners, 'op1')[0]!.attributes.cuiP = '1900101400012';
    expect(JSON.stringify(summarize(compare(domestic, partners), 'key'))).not.toContain(
      '1900101400012',
    );
  });

  test('summary serialization never copies subtree values', () => {
    const original = beneficiariesReturn();
    const changed = parse(original);
    const first = nodes(changed, 'benef')[0]!;
    changed.children = changed.children.filter((child) => child !== first);
    const differences = compare(original, changed);
    const summary = summarize(differences, new Uint8Array([1, 2, 3]));
    expect(summary.total).toBe(1);
    expect(summary.byClass.structure).toBe(1);
    const serialized = JSON.stringify(summary);
    for (const secret of ['1781105170030', 'Dumitrescu', '30000', '4800'])
      expect(serialized).not.toContain(secret);
  });
});

test('CLI prints only the summary by default, opts into values, and sanitizes read errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xfactura-compare-'));
  const engine = join(directory, 'engine.xml');
  const filed = join(directory, 'filed.xml');
  const original = beneficiariesReturn();
  const changed = parse(original);
  setField(changed, 'benef/@den1', 'PRIVATE-CLI-SENTINEL');
  await Promise.all([writeFile(engine, original), writeFile(filed, xml(changed))]);
  const run = async (...args: string[]) => {
    const process = Bun.spawn(
      [Bun.which('bun')!, 'scripts/differential/compare-return.ts', ...args],
      {
        cwd: resolve(import.meta.dir, '../../..'),
        env: { ...Bun.env, XFACTURA_REPLAY_HASH_KEY: 'cli-test-key' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    return { stdout, stderr, code };
  };
  try {
    const normal = await run(engine, filed);
    expect(normal.code).toBe(0);
    expect(normal.stderr).toBe('');
    expect(JSON.parse(normal.stdout).total).toBe(1);
    expect(normal.stdout).not.toContain('PRIVATE-CLI-SENTINEL');
    expect(normal.stdout).not.toContain('1781105170030');
    const values = await run(engine, filed, '--values');
    expect(values.code).toBe(0);
    expect(values.stdout).toContain('PRIVATE-CLI-SENTINEL');
    const usage = await run(engine, filed, '--unknown');
    expect(usage.code).toBe(1);
    expect(usage.stderr).toContain('RETURN_USAGE');
    await writeFile(filed, '<broken PRIVATE-CLI-SENTINEL');
    const failed = await run(engine, filed);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('RETURN_READ');
    expect(failed.stderr).not.toContain('PRIVATE-CLI-SENTINEL');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
