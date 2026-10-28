import { SaxesParser } from 'saxes';
import { requireCondition } from './domain';

export type XmlElement = {
  local: string;
  uri: string;
  text: string;
  attributes: Record<string, string>;
  children: XmlElement[];
};

// Bounded, namespace-aware parsing. No external entities, DTDs, network or filesystem access.
export function sourceXml(bytes: Uint8Array): XmlElement {
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
      ++nodes <= 100000 && stack.length < 64 && Object.keys(tag.attributes).length <= 100,
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
    xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    requireCondition(false, 'XML_ENCODING', 'Folosiți un document XML UTF-8.');
  }
  parser.write(xml).close();
  requireCondition(root && stack.length === 0, 'XML_ROOT', 'Document XML incomplet.');
  return root;
}
