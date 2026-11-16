import { createHmac } from 'node:crypto';
import type { FiledDeclaration } from 'xfactura-core/ro/declarations/read';
import { catalogueApplies, matches, type Normalization, type ReturnCatalogue } from './catalogues';

export { catalogueFor, returnCatalogues } from './catalogues';
export type { ReturnCatalogue } from './catalogues';

export const differenceClasses = [
  'amount',
  'rounding',
  'text',
  'cosmetic',
  'structure',
  'zero-omission',
] as const;
export type DifferenceClass = (typeof differenceClasses)[number];
type DifferenceValue = string | Readonly<Record<string, string>> | null;
type DifferenceBase = {
  path: string;
  kind: 'different' | 'only-engine' | 'only-filed';
  engine: DifferenceValue;
  filed: DifferenceValue;
  /** The first child element, or $root for attributes/text on the document element. */
  section: string;
  /** Attribute names only; used to redact key components without retaining another value. */
  sensitiveKeys: readonly string[];
};
export type ReturnDifference = DifferenceBase &
  (
    | {
        class: 'amount' | 'rounding';
        /** Engine minus filed, never a floating point number. */ delta: string;
      }
    | { class: 'text' | 'cosmetic' | 'structure' | 'zero-omission'; delta?: never }
  );

export class ReturnComparisonError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'ReturnComparisonError';
  }
}
function fail(code: string, message: string): never {
  throw new ReturnComparisonError(code, message);
}

type Decimal = { units: bigint; scale: number };
function decimal(value: string): Decimal | null {
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/.exec(value.trim());
  if (!match) return null;
  const fraction = match[3] ?? match[4] ?? '';
  return {
    units: BigInt(`${match[1] === '-' ? '-' : ''}${match[2] ?? '0'}${fraction}`),
    scale: fraction.length,
  };
}
function decimalText({ units, scale }: Decimal): string {
  if (units === 0n) return '0';
  const sign = units < 0n ? '-' : '';
  const digits = (units < 0n ? -units : units).toString().padStart(scale + 1, '0');
  if (scale === 0) return sign + digits;
  return `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, '');
}
function subtract(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale);
  return {
    units:
      left.units * 10n ** BigInt(scale - left.scale) -
      right.units * 10n ** BigInt(scale - right.scale),
    scale,
  };
}

function normalize(value: string, policy: readonly Normalization[]): string {
  let result = value;
  if (policy.includes('trim')) result = result.trim();
  if (policy.includes('case')) result = result.toLowerCase();
  if (policy.includes('diacritics')) result = result.normalize('NFD').replace(/\p{M}/gu, '');
  if (policy.includes('legal-form'))
    result = result.replace(
      /[\s,]+(?:s\.?\s*r\.?\s*l\.?|s\.?\s*a\.?|s\.?\s*n\.?\s*c\.?|s\.?\s*c\.?\s*[as]\.?|ltd\.?|limited|gmbh|ag)$/iu,
      '',
    );
  return result;
}

// Every delimiter in a key value is escaped, including the missing-component marker ~.
// This makes paths unambiguous even for identifiers containing slashes, quotes or brackets.
const encodeKey = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*~]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
type Node = {
  name: string;
  indexed: boolean;
  children: Map<string, Node>;
  fields: Map<string, string>;
};
const node = (name: string, indexed = false): Node => ({
  name,
  indexed,
  children: new Map(),
  fields: new Map(),
});

function tree(declaration: FiledDeclaration): Node {
  const root = node(declaration.root);
  for (const field of declaration.fields) {
    // Namespaced attributes contain URI slashes; split before /@, not on every slash.
    const boundary = field.path.includes('/@')
      ? field.path.indexOf('/@')
      : field.path.lastIndexOf('/#text');
    if (boundary < 0) fail('RETURN_PATH', 'Calea unui câmp nu este o cale de atribut sau text.');
    const segments = field.path.slice(0, boundary).split('/');
    const leaf = field.path.slice(boundary + 1);
    if (segments.shift() !== root.name)
      fail('RETURN_ROOT', 'Calea câmpului nu aparține rădăcinii declarației.');
    let current = root;
    for (const segment of segments) {
      const parsed = /^([^\[\]]+)(?:\[([1-9]\d*)\])?$/.exec(segment);
      if (!parsed) fail('RETURN_PATH', 'Calea unui element nu este validă.');
      let child = current.children.get(segment);
      if (!child) {
        child = node(parsed[1]!, parsed[2] !== undefined);
        current.children.set(segment, child);
      }
      current = child;
    }
    if (current.fields.has(leaf))
      fail('RETURN_FIELD_DUPLICATE', 'Declarația conține o cale de câmp duplicată.');
    current.fields.set(leaf, field.value);
  }
  return root;
}

type IndexedField = {
  value: string;
  plain: string;
  section: string;
  sensitiveKeys: readonly string[];
};
type IndexedElement = { plain: string; section: string; sensitiveKeys: readonly string[] };
type ReturnIndex = { fields: Map<string, IndexedField>; repeated: Map<string, IndexedElement> };

function indexReturn(declaration: FiledDeclaration, catalogue: ReturnCatalogue): ReturnIndex {
  if (!catalogueApplies(catalogue, declaration))
    fail(
      'RETURN_CATALOGUE',
      'Catalogul nu corespunde formei, versiunii sau perioadei declarației.',
    );
  if (declaration.root !== catalogue.root)
    fail('RETURN_ROOT', 'Rădăcina declarației nu corespunde catalogului.');
  const rules = new Map(catalogue.repeated.map((rule) => [rule.path, rule]));
  if (rules.size !== catalogue.repeated.length)
    fail('RETURN_CATALOGUE', 'Catalogul conține reguli de identitate duplicate.');
  for (const rule of catalogue.numeric) {
    const tolerance = decimal(rule.tolerance);
    if (!tolerance || tolerance.units < 0n)
      fail('RETURN_TOLERANCE', 'Toleranța trebuie să fie un număr zecimal exact, nenegativ.');
  }
  const result: ReturnIndex = { fields: new Map(), repeated: new Map() };
  const walk = (current: Node, plain: string, path: string, inherited: readonly string[]) => {
    let sensitiveKeys = inherited;
    const rule = rules.get(plain);
    if (rule) {
      const variant = rule.variants?.find(({ when }) => {
        const value = current.fields.get(`@${when.attribute}`);
        return when.absent
          ? value === undefined || value === ''
          : value?.startsWith(when.startsWith ?? '') === true;
      });
      const key = variant?.keys ?? rule.keys;
      if (!key.length)
        fail('RETURN_CATALOGUE', 'Un element repetat nu are atribute de identitate.');
      sensitiveKeys = [
        ...new Set([
          ...inherited,
          ...key
            .filter(
              (part) =>
                part.sensitive ||
                (part.sensitiveWhen &&
                  current.fields.get(`@${part.sensitiveWhen.attribute}`)?.trim() ===
                    part.sensitiveWhen.value),
            )
            .map((part) => part.attribute),
        ]),
      ];
      path += `[${key
        .map((part) => {
          const value = current.fields.get(`@${part.attribute}`);
          if ((value === undefined || value === '') && !part.optional)
            fail(
              'RETURN_KEY_MISSING',
              `Lipsește un atribut de identitate pentru ${plain}/@${part.attribute}.`,
            );
          if (value === undefined) return `${part.attribute}=~`;
          const fieldPath = `${plain}/@${part.attribute}`;
          const cosmeticRule = catalogue.cosmetic.find((item) => matches(item.path, fieldPath));
          const numeric = catalogue.numeric.some((item) => matches(item.path, fieldPath))
            ? decimal(value)
            : null;
          const policy = part.normalize ?? cosmeticRule?.normalize;
          const normalized = numeric
            ? decimalText(numeric)
            : policy
              ? normalize(value, policy)
              : value;
          return `${part.attribute}=${encodeKey(normalized)}`;
        })
        .join(',')}]`;
      if (result.repeated.has(path))
        // Neither a CNP nor the colliding key is included in an error that a CLI may print.
        fail(
          'RETURN_KEY_DUPLICATE',
          `Cheia elementului ${plain} nu este unică în același părinte.`,
        );
      result.repeated.set(path, { plain, section: plain.split('/')[0]!, sensitiveKeys });
    }
    const section = plain ? plain.split('/')[0]! : '$root';
    for (const [name, value] of current.fields) {
      const fieldPath = plain ? `${plain}/${name}` : name;
      if (
        catalogue.ignored.some(
          (item) =>
            matches(item.path, fieldPath) &&
            (item.when === undefined || (name === '#text' && value.trim() === '')),
        )
      )
        continue;
      const canonical = `${path}/${name}`;
      if (result.fields.has(canonical))
        fail('RETURN_FIELD_DUPLICATE', 'Două câmpuri au aceeași cale după identificare.');
      result.fields.set(canonical, { value, plain: fieldPath, section, sensitiveKeys });
    }
    const counts = new Map<string, number>();
    for (const child of current.children.values())
      counts.set(child.name, (counts.get(child.name) ?? 0) + 1);
    for (const child of current.children.values()) {
      const childPlain = plain ? `${plain}/${child.name}` : child.name;
      if ((child.indexed || counts.get(child.name)! > 1) && !rules.has(childPlain))
        fail(
          'RETURN_UNKEYED_REPEAT',
          `Catalogul nu definește cheia elementului repetat ${childPlain}.`,
        );
      walk(child, childPlain, `${path}/${child.name}`, sensitiveKeys);
    }
  };
  walk(tree(declaration), '', declaration.root, []);
  return result;
}

/** Also validates key uniqueness, including for a single occurrence without a [1] suffix. */
export function inspectReturnKeys(
  declaration: FiledDeclaration,
  catalogue: ReturnCatalogue,
): Record<string, number> {
  const counts = new Map(catalogue.repeated.map((rule) => [rule.path, 0]));
  for (const element of indexReturn(declaration, catalogue).repeated.values())
    counts.set(element.plain, counts.get(element.plain)! + 1);
  return Object.fromEntries(counts);
}

function periodIdentity(declaration: FiledDeclaration): string {
  const period = declaration.period;
  if (!period?.year || (!period.month && !period.quarter))
    fail('RETURN_PERIOD_UNKNOWN', 'Perioada declarației lipsește sau este incompletă.');
  const number = (value: string | null) =>
    value === null ? null : /^\d+$/.test(value) ? BigInt(value).toString() : value;
  return JSON.stringify([number(period.year), number(period.month), number(period.quarter)]);
}

/** Unknown fields are compared, never ignored or treated as zero. Whole missing repeated
 * subtrees produce one structure difference, with their nonignored fields as the value. */
export function compareReturns(
  engine: FiledDeclaration,
  filed: FiledDeclaration,
  catalogue: ReturnCatalogue,
): ReturnDifference[] {
  if (!engine.form || engine.form !== filed.form)
    fail('RETURN_FORM', 'Nu se pot compara declarații cu forme diferite sau necunoscute.');
  if (engine.version === null || engine.version !== filed.version)
    fail('RETURN_VERSION', 'Nu se pot compara declarații cu versiuni diferite sau necunoscute.');
  if (periodIdentity(engine) !== periodIdentity(filed))
    fail('RETURN_PERIOD', 'Nu se pot compara declarații cu perioade diferite.');
  const left = indexReturn(engine, catalogue);
  const right = indexReturn(filed, catalogue);
  const differences: ReturnDifference[] = [];
  const absent: string[] = [];
  const allElements = [...new Set([...left.repeated.keys(), ...right.repeated.keys()])].sort(order);
  const insideAbsent = (path: string) => absent.some((parent) => path.startsWith(`${parent}/`));
  const subtree = (index: ReturnIndex, path: string) =>
    Object.fromEntries(
      [...index.fields]
        .filter(([field]) => field.startsWith(`${path}/`))
        .sort(([a], [b]) => order(a, b))
        .map(([field, entry]) => [field.slice(path.length + 1), entry.value]),
    );
  for (const path of allElements) {
    if (insideAbsent(path) || (left.repeated.has(path) && right.repeated.has(path))) continue;
    const inEngine = left.repeated.has(path);
    const entry = left.repeated.get(path) ?? right.repeated.get(path)!;
    absent.push(path);
    differences.push({
      path,
      kind: inEngine ? 'only-engine' : 'only-filed',
      class: 'structure',
      engine: inEngine ? subtree(left, path) : null,
      filed: inEngine ? null : subtree(right, path),
      section: entry.section,
      sensitiveKeys: entry.sensitiveKeys,
    });
  }
  const allFields = [...new Set([...left.fields.keys(), ...right.fields.keys()])].sort(order);
  for (const path of allFields) {
    if (insideAbsent(path)) continue;
    const a = left.fields.get(path);
    const b = right.fields.get(path);
    if (a?.value === b?.value) continue;
    const entry = a ?? b!;
    const difference: DifferenceBase = {
      path,
      kind: a === undefined ? 'only-filed' : b === undefined ? 'only-engine' : 'different',
      engine: a?.value ?? null,
      filed: b?.value ?? null,
      section: entry.section,
      sensitiveKeys: [...new Set([...(a?.sensitiveKeys ?? []), ...(b?.sensitiveKeys ?? [])])],
    };
    const numeric = catalogue.numeric.find((rule) => matches(rule.path, entry.plain));
    const first = a && numeric ? decimal(a.value) : null;
    const second = b && numeric ? decimal(b.value) : null;
    if ((!a || !b) && (first ?? second)?.units === 0n) {
      differences.push({ ...difference, class: 'zero-omission' });
    } else if (first && second) {
      const delta = subtract(first, second);
      if (delta.units === 0n) continue;
      const absolute = { ...delta, units: delta.units < 0n ? -delta.units : delta.units };
      const rounding = subtract(absolute, decimal(numeric!.tolerance)!).units <= 0n;
      differences.push({
        ...difference,
        class: rounding ? 'rounding' : 'amount',
        delta: decimalText(delta),
      });
    } else {
      const rule = catalogue.cosmetic.find((item) => matches(item.path, entry.plain));
      const cosmetic =
        a && b && rule && normalize(a.value, rule.normalize) === normalize(b.value, rule.normalize);
      differences.push({ ...difference, class: cosmetic ? 'cosmetic' : 'text' });
    }
  }
  return differences.sort((a, b) => order(a.path, b.path));
}

export type ReturnSummary = {
  total: number;
  byClass: Record<DifferenceClass, number>;
  bySection: Record<string, number>;
  paths: string[];
};

/** Caller-owned key: reuse it for stable pseudonyms, keep it outside shared reports. No
 * values, deltas or raw personal identifiers are copied into the summary. */
export function summarize(
  differences: readonly ReturnDifference[],
  key: string | Uint8Array,
): ReturnSummary {
  if (key.length === 0) fail('RETURN_HASH_KEY', 'Cheia de pseudonimizare nu poate fi goală.');
  const byClass = Object.fromEntries(differenceClasses.map((name) => [name, 0])) as Record<
    DifferenceClass,
    number
  >;
  const bySection = new Map<string, number>();
  const paths: string[] = [];
  for (const difference of differences) {
    byClass[difference.class]++;
    bySection.set(difference.section, (bySection.get(difference.section) ?? 0) + 1);
    paths.push(
      difference.path.replace(
        /\[([^\]]*)\]/g,
        (_match, contents: string) =>
          `[${contents
            .split(',')
            .map((part) => {
              const at = part.indexOf('=');
              const attribute = part.slice(0, at);
              const encoded = part.slice(at + 1);
              if (encoded === '~') return part;
              const value = decodeURIComponent(encoded);
              // A D394 partner code may also be a CNP/NIF. Hash any 13-digit key defensively,
              // as well as the explicitly sensitive names, addresses and certificate identifiers.
              if (!difference.sensitiveKeys.includes(attribute) && !/^\d{13}$/.test(value.trim()))
                return part;
              const hash = createHmac('sha256', key)
                .update('xfactura-replay:return-key:v1\0')
                .update(value)
                .digest('hex');
              return `${attribute}=hmac-sha256:${hash}`;
            })
            .join(',')}]`,
      ),
    );
  }
  return {
    total: differences.length,
    byClass,
    bySection: Object.fromEntries([...bySection].sort(([a], [b]) => order(a, b))),
    paths: paths.sort(order),
  };
}
