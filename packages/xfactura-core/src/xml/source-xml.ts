import { SaxesParser } from 'saxes';
import { requireCondition } from '../errors';

// TextDecoder is a Web-platform global (browsers, Bun, Node), outside the ES library core
// compiles against.
const Utf8Decoder = (
  globalThis as unknown as {
    TextDecoder: new (
      label: 'utf-8',
      options: { fatal: boolean },
    ) => { decode(bytes: Uint8Array): string };
  }
).TextDecoder;

export type XmlElement = {
  local: string;
  uri: string;
  text: string;
  attributes: Record<string, string>;
  namespacedAttributes?: { uri: string; local: string; value: string }[];
  children: XmlElement[];
};

export type SourceXmlOptions = {
  /** A positive finite integer; maximum attributes per element, including namespace declarations. */
  maxAttributes?: number;
  /** A positive finite integer; maximum elements in the document. */
  maxNodes?: number;
  /** Retain namespaced content attributes separately from un-namespaced attributes. */
  namespacedAttributes?: boolean;
};

// Bounded, namespace-aware parsing. No external entities, DTDs, network or filesystem access.
export function sourceXml(bytes: Uint8Array, options: SourceXmlOptions = {}): XmlElement {
  const maxAttributes = options.maxAttributes === undefined ? 100 : options.maxAttributes;
  if (!Number.isInteger(maxAttributes) || maxAttributes <= 0)
    throw new TypeError('Limita atributelor XML trebuie să fie un număr întreg pozitiv și finit.');
  const maxNodes = options.maxNodes === undefined ? 100000 : options.maxNodes;
  if (!Number.isInteger(maxNodes) || maxNodes <= 0)
    throw new TypeError('Limita elementelor XML trebuie să fie un număr întreg pozitiv și finit.');
  requireCondition(
    bytes.length > 0 && bytes.length <= 10 * 1024 * 1024,
    'XML_SIZE',
    'Fișierul XML depășește limita.',
  );
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined,
    nodes = 0;
  const parser = new SaxesParser({ xmlns: true });
  parser.on('xmldecl', (declaration) => {
    requireCondition(
      !declaration.encoding || declaration.encoding.toUpperCase() === 'UTF-8',
      'XML_ENCODING',
      'Folosiți un document XML UTF-8.',
    );
  });
  parser.on('doctype', () => {
    requireCondition(false, 'XML_DTD', 'Declarațiile DTD nu sunt acceptate.');
  });
  parser.on('opentag', (tag) => {
    requireCondition(
      ++nodes <= maxNodes &&
        stack.length < 64 &&
        Object.keys(tag.attributes).length <= maxAttributes,
      'XML_COMPLEXITY',
      'Structura XML depășește limita.',
    );
    const node: XmlElement = {
      local: tag.local,
      uri: tag.uri,
      text: '',
      attributes: Object.fromEntries(
        Object.values(tag.attributes)
          .filter((attr) => !attr.uri)
          .map((attr) => [attr.local, attr.value]),
      ),
      ...(options.namespacedAttributes && {
        namespacedAttributes: Object.values(tag.attributes)
          .filter((attr) => attr.uri && attr.uri !== 'http://www.w3.org/2000/xmlns/')
          .map(({ uri, local, value }) => ({ uri, local, value })),
      }),
      children: [],
    };
    if (stack.length) stack.at(-1)!.children.push(node);
    else {
      requireCondition(!root, 'XML_ROOT', 'Documentul XML trebuie să aibă o singură rădăcină.');
      root = node;
    }
    stack.push(node);
  });
  const text = (value: string) => {
    const node = stack.at(-1);
    if (node) {
      requireCondition(
        node.text.length + value.length <= 65536,
        'XML_TEXT',
        'Câmpul XML depășește limita.',
      );
      node.text += value;
    }
  };
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('closetag', () => {
    stack.pop();
  });
  parser.on('error', () => {
    requireCondition(false, 'XML_INVALID', 'Documentul XML nu este valid.');
  });
  let xml: string;
  try {
    xml = new Utf8Decoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    requireCondition(false, 'XML_ENCODING', 'Folosiți un document XML UTF-8.');
  }
  parser.write(xml).close();
  requireCondition(root && stack.length === 0, 'XML_ROOT', 'Document XML incomplet.');
  return root;
}
