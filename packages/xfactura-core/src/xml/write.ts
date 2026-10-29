/** An element to serialize. Absent children (undefined, null, false, '') are skipped, so optional
 * structure reads as plain conditionals. */
export type XmlNode = {
  name: string;
  attributes: readonly (readonly [string, string])[];
  text?: string;
  children: XmlNode[];
};
export type XmlChild = XmlNode | undefined | null | false | '' | readonly XmlChild[];

export function element(
  name: string,
  attributes: Record<string, string | undefined> | null,
  ...children: XmlChild[]
): XmlNode {
  return {
    name,
    attributes: Object.entries(attributes ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
    children: flatten(children),
  };
}

/** A text-only element, or nothing when the value is absent. */
export function leaf(
  name: string,
  value: string | undefined,
  attributes?: Record<string, string | undefined>,
): XmlNode | undefined {
  if (value === undefined) return undefined;
  return { ...element(name, attributes ?? null), text: value };
}

function flatten(children: readonly XmlChild[]): XmlNode[] {
  return children.flatMap((child) =>
    Array.isArray(child) ? flatten(child) : child ? [child as XmlNode] : [],
  );
}

/** UTF-8 XML with two-space indentation; the same tree always gives the same text. */
export function serializeXml(root: XmlNode): string {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>'];
  const write = (node: XmlNode, depth: number) => {
    const indent = '  '.repeat(depth);
    const attributes = node.attributes
      .map(([key, value]) => ` ${key}="${escape(value, true)}"`)
      .join('');
    if (node.children.length === 0) {
      lines.push(
        node.text === undefined
          ? `${indent}<${node.name}${attributes}/>`
          : `${indent}<${node.name}${attributes}>${escape(node.text, false)}</${node.name}>`,
      );
      return;
    }
    lines.push(`${indent}<${node.name}${attributes}>`);
    for (const child of node.children) write(child, depth + 1);
    lines.push(`${indent}</${node.name}>`);
  };
  write(root, 0);
  return `${lines.join('\n')}\n`;
}

function escape(text: string, attribute: boolean): string {
  // Control characters other than tab and line breaks are not representable in XML 1.0.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(text))
    throw new RangeError('Text contains characters XML cannot represent.');
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return attribute
    ? escaped
        .replace(/"/g, '&quot;')
        .replace(/\n/g, '&#10;')
        .replace(/\r/g, '&#13;')
        .replace(/\t/g, '&#9;')
    : escaped.replace(/\r/g, '&#13;');
}
