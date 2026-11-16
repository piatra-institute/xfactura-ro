import { SaxesParser } from 'saxes';
import { DomainError, requireCondition } from '../../errors';
import { sourceXml, type XmlElement } from '../../xml/source-xml';

type FieldPaths = readonly string[];

export type DeclarationFormDescriptor = {
  /** The form component of mfp:anaf:dgti:<form>:declaratie:v<version>. */
  namespaces: readonly string[];
  /** Paths relative to the root; alternatives describe layouts, never particular versions. */
  period: { year: FieldPaths; month?: FieldPaths; quarter?: FieldPaths };
  fiscalCode: FieldPaths;
  /** An empty list means that this descriptor has no rectification flag. */
  rectifying: FieldPaths;
};

const monthly = { year: ['@an'], month: ['@luna'] } as const;
const reporting = { year: ['@an_r'], month: ['@luna_r'] } as const;

/** Header locations for the engine's forms, and identity/period only for D700 and D710. */
export const declarationForms = {
  D300: { namespaces: ['d300'], period: monthly, fiscalCode: ['@cui'], rectifying: [] },
  D301: { namespaces: ['d301'], period: monthly, fiscalCode: ['@cif'], rectifying: ['@d_rec'] },
  D390: { namespaces: ['d390'], period: monthly, fiscalCode: ['@cui'], rectifying: ['@d_rec'] },
  D394: {
    namespaces: ['d394'],
    period: monthly,
    fiscalCode: ['@cui', 'identificare/@cui'],
    rectifying: [],
  },
  D100: { namespaces: ['d100'], period: monthly, fiscalCode: ['@cui'], rectifying: [] },
  D101: { namespaces: ['d101'], period: monthly, fiscalCode: ['@cif'], rectifying: ['@d_rec'] },
  D112: {
    namespaces: ['declaratie_unica', 'd112'],
    period: reporting,
    fiscalCode: ['angajator/@cif'],
    rectifying: ['@d_rec'],
  },
  D205: { namespaces: ['d205'], period: monthly, fiscalCode: ['@cui'], rectifying: ['@d_rec'] },
  D207: { namespaces: ['d207'], period: monthly, fiscalCode: ['@cui'], rectifying: ['@d_rec'] },
  D212: { namespaces: ['d212'], period: reporting, fiscalCode: ['@cif'], rectifying: ['@d_rec'] },
  D204: { namespaces: ['d204'], period: monthly, fiscalCode: ['@cif'], rectifying: ['@d_rec'] },
  D398: {
    namespaces: ['d398'],
    period: reporting,
    fiscalCode: ['@vat_id_no'],
    rectifying: ['@d_rec'],
  },
  S1005: { namespaces: ['s1005'], period: monthly, fiscalCode: ['@cui'], rectifying: [] },
  S1003: { namespaces: ['s1003'], period: monthly, fiscalCode: ['@cui'], rectifying: [] },
  S1046: { namespaces: ['s1046'], period: monthly, fiscalCode: ['@cui'], rectifying: [] },
  D700: { namespaces: ['d700'], period: monthly, fiscalCode: ['@cif'], rectifying: [] },
  D710: { namespaces: ['d710'], period: monthly, fiscalCode: ['@cui'], rectifying: [] },
} as const satisfies Record<string, DeclarationFormDescriptor>;

export type DeclarationField = { path: string; value: string };

export type FiledDeclaration = {
  form: string | null;
  version: number | null;
  /** Local name of the document element, including for an unrecognized namespace. */
  root: string;
  namespace: string;
  schemaLocation: string | null;
  /** Strings exactly as parsed; a quarter's last month is never converted into a quarter. */
  period: { year: string | null; month: string | null; quarter: string | null } | null;
  fiscalCode: string | null;
  /** Null when the XML does not state a recognized flag, or the descriptor has none. */
  rectifying: boolean | null;
  fields: DeclarationField[];
};

// Annual F10/F20/F30/F40 elements store hundreds of amounts as attributes on one element.
// Their flat layout needs a larger bound than sourceXml's general-purpose default of 100.
const MAX_DECLARATION_ATTRIBUTES = 2048;
const MAX_SAFT_PROBE_BYTES = 64 * 1024;
const xsi = 'http://www.w3.org/2001/XMLSchema-instance';
const namespacePattern = /^mfp:anaf:dgti:([A-Za-z][A-Za-z0-9_]*):declaratie:v(\d+)$/;

function identity(namespace: string): {
  form: string | null;
  version: number | null;
  descriptor?: DeclarationFormDescriptor;
} {
  const match = namespacePattern.exec(namespace);
  if (!match) return { form: null, version: null };
  const token = match[1]!.toLowerCase();
  const version = Number(match[2]);
  requireCondition(
    Number.isSafeInteger(version),
    'DECLARATION_VERSION',
    'Versiunea din namespace-ul declarației depășește limita.',
  );
  const entry = Object.entries(declarationForms).find(([, descriptor]) =>
    descriptor.namespaces.some((name) => name === token),
  );
  return { form: entry?.[0] ?? token.toUpperCase(), version, descriptor: entry?.[1] };
}

/** A missing or ambiguous header stays unknown, including conflicting alternative locations. */
function header(root: XmlElement, paths: FieldPaths = []): string | null {
  const values: string[] = [];
  for (const path of paths) {
    const steps = path.split('/');
    const attribute = steps.pop()!.slice(1);
    let nodes = [root];
    for (const step of steps)
      nodes = nodes.flatMap((node) => node.children.filter((child) => child.local === step));
    for (const node of nodes) {
      if (Object.hasOwn(node.attributes, attribute) && node.attributes[attribute] !== '')
        values.push(node.attributes[attribute]!);
    }
  }
  return values.length > 0 && values.every((value) => value === values[0]) ? values[0]! : null;
}

function fieldsOf(root: XmlElement): DeclarationField[] {
  const fields: DeclarationField[] = [];
  const walk = (node: XmlElement, path: string) => {
    for (const [name, value] of Object.entries(node.attributes))
      fields.push({ path: `${path}/@${name}`, value });
    for (const { uri, local, value } of node.namespacedAttributes ?? [])
      fields.push({ path: `${path}/@{${uri}}${local}`, value });
    if (node.children.length === 0 && node.text.length > 0)
      fields.push({ path: `${path}/#text`, value: node.text });
    const counts = new Map<string, number>();
    for (const child of node.children) counts.set(child.local, (counts.get(child.local) ?? 0) + 1);
    const indices = new Map<string, number>();
    for (const child of node.children) {
      const index = (indices.get(child.local) ?? 0) + 1;
      indices.set(child.local, index);
      const suffix = counts.get(child.local)! > 1 ? `[${index}]` : '';
      walk(child, `${path}/${child.local}${suffix}`);
    }
  };
  walk(root, root.local);
  return fields;
}

function rejectSaft(): never {
  throw new DomainError(
    'DECLARATION_SAFT_UNSUPPORTED',
    'Declarația D406 (SAF-T) necesită un cititor dedicat.',
  );
}

// Probe only a bounded prefix; undecided and invalid prefixes go through sourceXml.
function refuseSaft(bytes: Uint8Array): void {
  const stop = {};
  const parser = new SaxesParser({ xmlns: true });
  let attributes = 0;
  parser.on('xmldecl', (declaration) => {
    if (declaration.encoding && declaration.encoding.toUpperCase() !== 'UTF-8') throw stop;
  });
  parser.on('attribute', () => {
    if (++attributes > MAX_DECLARATION_ATTRIBUTES) throw stop;
  });
  parser.on('opentag', (tag) => {
    if (namespacePattern.exec(tag.uri)?.[1]?.toLowerCase() === 'd406') rejectSaft();
    throw stop;
  });
  parser.on('error', () => {
    throw stop;
  });
  parser.on('doctype', () => {
    throw stop;
  });
  // TextDecoder is a runtime global, outside the ES library core compiles against.
  const Decoder = (
    globalThis as unknown as {
      TextDecoder: new (
        label: 'utf-8',
        options: { fatal: boolean },
      ) => { decode(bytes: Uint8Array, options: { stream: boolean }): string };
    }
  ).TextDecoder;
  try {
    const decoder = new Decoder('utf-8', { fatal: true });
    const prefix = bytes.subarray(0, MAX_SAFT_PROBE_BYTES);
    for (let offset = 0; offset < prefix.length; offset += 512)
      parser.write(decoder.decode(prefix.subarray(offset, offset + 512), { stream: true }));
  } catch (error) {
    if (error instanceof DomainError) throw error;
    // Invalid input is diagnosed by sourceXml, with its existing error codes and limits.
  }
}

/**
 * Read any ANAF namespace version without applying tax rules or normalizing values. XML
 * entities are decoded by sourceXml; numeric strings and whitespace are preserved. Attributes
 * precede text/children in document order, with namespaced attributes after un-namespaced ones.
 * Namespaced attribute paths use @{uri}local so prefix aliases cannot collide; element paths
 * use local names, indexing all repeated siblings from 1. Namespace declarations are excluded.
 * Empty elements have no text field; only elements without child elements contribute #text.
 * The size check precedes a 64 KiB UTF-8 root probe. A complete D406 start tag within that
 * prefix is refused before reading entries, provided its prolog and attribute count pass the
 * probe. The probe does not validate the body; DTDs, non-UTF-8 declarations and undecided
 * prefixes defer to sourceXml. A root beyond the prefix (including a long start tag) requires
 * full bounded parsing; a valid D406 is then refused, or sourceXml reports its XML error first.
 */
export function readDeclaration(bytes: Uint8Array): FiledDeclaration {
  // Match sourceXml's size limit and error before the probe decodes or buffers any input.
  requireCondition(
    bytes.length > 0 && bytes.length <= 10 * 1024 * 1024,
    'XML_SIZE',
    'Fișierul XML depășește limita.',
  );
  refuseSaft(bytes);
  const root = sourceXml(bytes, {
    maxAttributes: MAX_DECLARATION_ATTRIBUTES,
    namespacedAttributes: true,
  });
  const { form, version, descriptor } = identity(root.uri);
  if (form === 'D406') rejectSaft();
  const year = descriptor ? header(root, descriptor.period.year) : null;
  const month = descriptor ? header(root, descriptor.period.month) : null;
  const quarter = descriptor ? header(root, descriptor.period.quarter) : null;
  const flag = descriptor ? header(root, descriptor.rectifying) : null;
  return {
    form,
    version,
    root: root.local,
    namespace: root.uri,
    schemaLocation:
      root.namespacedAttributes?.find((attr) => attr.uri === xsi && attr.local === 'schemaLocation')
        ?.value ?? null,
    period: year === null && month === null && quarter === null ? null : { year, month, quarter },
    fiscalCode: descriptor ? header(root, descriptor.fiscalCode) : null,
    rectifying: flag === '1' ? true : flag === '0' ? false : null,
    fields: fieldsOf(root),
  };
}

/** Index the fields without silently replacing an earlier value with the same path. */
export function fieldMap(declaration: FiledDeclaration): Map<string, string> {
  const result = new Map<string, string>();
  for (const { path, value } of declaration.fields) {
    requireCondition(
      !result.has(path),
      'DECLARATION_FIELD_DUPLICATE',
      'Declarația conține mai multe câmpuri cu aceeași cale.',
    );
    result.set(path, value);
  }
  return result;
}
