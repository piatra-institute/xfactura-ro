import { describe, expect, test } from 'bun:test';
import { DomainError } from '../src/errors';
import { sourceXml, type SourceXmlOptions } from '../src/xml/source-xml';

const bytes = (xml: string) => new TextEncoder().encode(xml);
const attributes = (count: number) =>
  Array.from({ length: count }, (_, index) => `a${index}="${index}"`).join(' ');

function errorCode(input: Uint8Array, options?: SourceXmlOptions): string {
  try {
    sourceXml(input, options);
    throw new Error('Expected an XML error.');
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return error.code;
  }
}

describe('sourceXml options', () => {
  test('defaults retain the same tree shape and discard namespaced attributes', () => {
    const input = bytes(
      '<r xmlns="urn:test" xmlns:x="urn:extra" a="01" x:a="02"><c x:b="03"> 004 </c></r>',
    );
    const expected = {
      local: 'r',
      uri: 'urn:test',
      attributes: { a: '01' },
      text: '',
      children: [{ local: 'c', uri: 'urn:test', attributes: {}, text: ' 004 ', children: [] }],
    };
    expect(sourceXml(input)).toEqual(expected);
    expect(sourceXml(input, {})).toEqual(expected);
    expect(sourceXml(input, { namespacedAttributes: false })).toEqual(expected);
    expect(Object.hasOwn(sourceXml(input), 'namespacedAttributes')).toBe(false);
  });

  test('the default still accepts 100 attributes and rejects 101', () => {
    expect(Object.keys(sourceXml(bytes(`<r ${attributes(100)}/>`)).attributes)).toHaveLength(100);
    expect(errorCode(bytes(`<r ${attributes(101)}/>`))).toBe('XML_COMPLEXITY');
    expect(errorCode(bytes(`<r ${attributes(101)}/>`), {})).toBe('XML_COMPLEXITY');
  });

  test('maxAttributes changes only the per-element attribute bound', () => {
    const input = bytes(`<r ${attributes(101)}><c ${attributes(101)}/></r>`);
    const root = sourceXml(input, { maxAttributes: 101 });
    expect(Object.keys(root.attributes)).toHaveLength(101);
    expect(Object.keys(root.children[0]!.attributes)).toHaveLength(101);
    expect(Object.hasOwn(root, 'namespacedAttributes')).toBe(false);
    expect(errorCode(bytes('<r a="1" b="2"/>'), { maxAttributes: 1 })).toBe('XML_COMPLEXITY');
    expect(errorCode(bytes('<r xmlns="urn:test" a="1"/>'), { maxAttributes: 1 })).toBe(
      'XML_COMPLEXITY',
    );
  });

  test('maxAttributes must be a positive finite integer', () => {
    for (const maxAttributes of [Infinity, -Infinity, NaN, 0, -1, 1.5, null, '101', false]) {
      expect(() => sourceXml(bytes('<r/>'), { maxAttributes: maxAttributes as number })).toThrow(
        TypeError,
      );
    }
    expect(sourceXml(bytes('<r a="01"/>'), { maxAttributes: 1 }).attributes).toEqual({ a: '01' });
    expect(sourceXml(bytes('<r/>'), { maxAttributes: undefined }).attributes).toEqual({});
  });

  test('namespacedAttributes preserves expanded names and order on every element', () => {
    const root = sourceXml(
      bytes(
        '<r xmlns="urn:test" xmlns:x="urn:x" xmlns:y="urn:y" a="00" x:a="01" y:a="02" xml:lang="ro"><c x:b=" &amp; "/><empty/></r>',
      ),
      { namespacedAttributes: true },
    );
    expect(root.attributes).toEqual({ a: '00' });
    expect(root.namespacedAttributes).toEqual([
      { uri: 'urn:x', local: 'a', value: '01' },
      { uri: 'urn:y', local: 'a', value: '02' },
      { uri: 'http://www.w3.org/XML/1998/namespace', local: 'lang', value: 'ro' },
    ]);
    expect(root.children[0]!.attributes).toEqual({});
    expect(root.children[0]!.namespacedAttributes).toEqual([
      { uri: 'urn:x', local: 'b', value: ' & ' },
    ]);
    expect(root.children[1]!.namespacedAttributes).toEqual([]);
  });

  test('retaining namespaced attributes does not change the default attribute limit', () => {
    expect(
      errorCode(bytes(`<r xmlns:x="urn:x" ${attributes(100)}/>`), {
        namespacedAttributes: true,
      }),
    ).toBe('XML_COMPLEXITY');
    expect(
      sourceXml(bytes(`<r xmlns:x="urn:x" x:a="01" ${attributes(100)}/>`), {
        maxAttributes: 102,
        namespacedAttributes: true,
      }).namespacedAttributes,
    ).toEqual([{ uri: 'urn:x', local: 'a', value: '01' }]);
  });
});

describe('sourceXml limits with declaration options', () => {
  const options = { maxAttributes: 2048, namespacedAttributes: true };

  test('size, depth, node count and text length are still bounded', () => {
    expect(errorCode(new Uint8Array(0), options)).toBe('XML_SIZE');
    expect(errorCode(new Uint8Array(10 * 1024 * 1024 + 1), options)).toBe('XML_SIZE');
    expect(errorCode(bytes('<r>'.repeat(65) + '</r>'.repeat(65)), options)).toBe('XML_COMPLEXITY');
    expect(errorCode(bytes(`<r>${'<c/>'.repeat(100000)}</r>`), options)).toBe('XML_COMPLEXITY');
    expect(errorCode(bytes(`<r>${'x'.repeat(65537)}</r>`), options)).toBe('XML_TEXT');
  });

  test('DTDs, other encodings and malformed XML still have their existing errors', () => {
    expect(errorCode(bytes('<!DOCTYPE r [<!ENTITY x "value">]><r>&x;</r>'), options)).toBe(
      'XML_DTD',
    );
    expect(errorCode(bytes('<?xml version="1.0" encoding="ISO-8859-1"?><r/>'), options)).toBe(
      'XML_ENCODING',
    );
    expect(errorCode(new Uint8Array([0x3c, 0x72, 0x3e, 0xff]), options)).toBe('XML_ENCODING');
    expect(errorCode(bytes('<r><c></r>'), options)).toBe('XML_INVALID');
  });
});
