import { SaxesParser, type SaxesTagNS } from 'saxes';
import { sourceXml, type XmlElement } from 'xfactura-core/xml';

export interface ReturnXml {
  rootElement: string;
  namespace: string;
  form: string;
  version: string;
  fiscalCode: string | null;
  period: {
    year: string | null;
    month: string | null;
    startDate: string | null;
    endDate: string | null;
  };
  rectifying: boolean | null;
  declarationType: string | null;
  attachment: string | null;
}

const identityAttributes = new Set(['cui', 'cif', 'an', 'luna', 'an_r', 'luna_r', 'd_rec']);
const maxHeaderBytes = 1024 * 1024;
const complete = Symbol('classification header complete');
const escape = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

function formOf(local: string, uri: string) {
  const match = /^mfp:anaf:dgti:([ds]\d+|declaratie_unica):declaratie:v(\d+)$/i.exec(uri);
  if (!match) return null;
  const form = match[1]!.toLowerCase();
  if (form === 'declaratie_unica' && local !== 'declaratieUnica') return null;
  return { form: form === 'declaratie_unica' ? 'D112' : form.toUpperCase(), version: match[2]! };
}

/** Project only identity attributes: older D300 roots have more attributes than sourceXml's
 * node limit permits. No amounts, employee records or return rows enter the projection. */
function identityTag(tag: SaxesTagNS): string {
  const attributes = Object.values(tag.attributes)
    .filter((attribute) => !attribute.uri && identityAttributes.has(attribute.local))
    .map((attribute) => ` ${attribute.local}="${escape(attribute.value)}"`)
    .join('');
  return `<${tag.local} xmlns="${escape(tag.uri)}"${attributes}/>`;
}

const child = (node: XmlElement | undefined, local: string) =>
  node?.children.find((item) => item.local === local && item.uri === node.uri);
const text = (node: XmlElement | undefined) => node?.text.trim() || null;

function metadata(root: XmlElement): ReturnXml | null {
  const form = formOf(root.local, root.uri);
  if (!form) return null;
  const attributes = root.attributes;
  const company = child(root, form.form === 'D112' ? 'angajator' : 'identificare');
  const header = child(root, 'Header');
  const saftCompany = child(header, 'Company');
  const selection = child(header, 'SelectionCriteria');
  const correction = attributes.d_rec;
  return {
    rootElement: root.local,
    namespace: root.uri,
    ...form,
    fiscalCode:
      attributes.cui ??
      attributes.cif ??
      company?.attributes.cui ??
      company?.attributes.cif ??
      text(child(child(saftCompany, 'TaxRegistration'), 'TaxRegistrationNumber')) ??
      text(child(saftCompany, 'RegistrationNumber')),
    period: {
      year: attributes.an ?? attributes.an_r ?? null,
      month: attributes.luna ?? attributes.luna_r ?? null,
      startDate: text(child(selection, 'SelectionStartDate')),
      endDate: text(child(selection, 'SelectionEndDate')),
    },
    rectifying: correction === '1' ? true : correction === '0' ? false : null,
    declarationType: text(child(header, 'HeaderComment')),
    attachment: null,
  };
}

/** Stops as soon as the classification fields are available. The bounded fragment is read
 * by sourceXml; D406 keeps its actual Header, never its MasterFiles or transactions. This
 * identifies documents, without claiming to validate the rest of a filed return. */
export async function readReturnXml(chunks: AsyncIterable<Uint8Array>): Promise<ReturnXml | null> {
  const parser = new SaxesParser({ xmlns: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let root: SaxesTagNS | undefined;
  let form: ReturnType<typeof formOf> = null;
  let prefix = '';
  let projection = '';
  let depth = 0;
  let bytesRead = 0;
  let headerEnd: number | undefined;
  parser.on('doctype', () => {
    throw new Error('XML_DTD');
  });
  parser.on('xmldecl', (declaration) => {
    if (declaration.encoding && declaration.encoding.toUpperCase() !== 'UTF-8')
      throw new Error('XML_ENCODING');
  });
  parser.on('opentag', (tag) => {
    depth++;
    if (!root) {
      root = tag;
      form = formOf(tag.local, tag.uri);
      if (!form) throw complete;
      if (form.form === 'D406') return;
      projection = identityTag(tag);
      if (!['D112', 'D394'].includes(form.form)) throw complete;
      if (Object.values(tag.attributes).some((attr) => ['cui', 'cif'].includes(attr.name)))
        throw complete;
    } else if (
      form?.form !== 'D406' &&
      depth === 2 &&
      tag.uri === root.uri &&
      tag.local === (form?.form === 'D112' ? 'angajator' : 'identificare')
    ) {
      projection = projection.slice(0, -2) + `>${identityTag(tag)}</${root.local}>`;
      throw complete;
    }
  });
  parser.on('closetag', (tag) => {
    if (form?.form === 'D406' && depth === 2 && tag.local === 'Header' && tag.uri === root?.uri) {
      headerEnd = parser.position;
      throw complete;
    }
    depth--;
    if (depth === 0) throw complete;
  });
  try {
    for await (const chunk of chunks) {
      bytesRead += chunk.length;
      if (bytesRead > maxHeaderBytes) throw new Error('XML_HEADER_SIZE');
      const decoded = decoder.decode(chunk, { stream: true });
      prefix += decoded;
      parser.write(decoded);
    }
    parser.write(decoder.decode()).close();
  } catch (error) {
    if (error !== complete) throw error;
  }
  if (!root) throw new Error('XML_ROOT');
  const identified = formOf(root.local, root.uri);
  if (!identified) return null;
  if (identified.form === 'D406') {
    if (headerEnd === undefined) throw new Error('D406_HEADER');
    projection = prefix.slice(0, headerEnd) + `</${root.name}>`;
  }
  return metadata(sourceXml(new TextEncoder().encode(projection)));
}

export async function* xmlChunks(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  for (let start = 0; start < bytes.length; start += 8192)
    yield bytes.subarray(start, start + 8192);
}
