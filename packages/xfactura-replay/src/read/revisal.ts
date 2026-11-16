import { DomainError } from 'xfactura-core/errors';
import { sourceXml, type XmlElement } from 'xfactura-core/xml';
import {
  archiveLimits,
  parseInvoiceArchive,
} from '../../../xfactura-api/source/engine/adapters/archive';
import { allowanceTypeKey, pathCounts, personKey, type PathCount } from './person-key';

export const revisalNamespace = 'http://schemas.datacontract.org/2004/07/Revisal.Entities';
const xsi = 'http://www.w3.org/2001/XMLSchema-instance';

export interface RevisalWorkingTime {
  type: string | null;
  duration: string | null;
  interval: string | null;
  norm: string | null;
  distribution: string | null;
}

export interface RevisalSalary {
  amount: string | null;
  currency: string | null;
}

export interface RevisalAllowance {
  type: string | null;
  /** HMAC of Tip/Nume, which can contain employer-defined free text. */
  typeKey: string | null;
  version: string | null;
  isPercent: boolean | null;
  value: string | null;
}

export type RevisalChange =
  | {
      kind: 'salary';
      date: string | null;
      /** A dated observation of terms, not evidence of a previous salary or its effective date. */
      basis: 'DataConsemnare';
      salary: RevisalSalary;
    }
  | {
      kind: 'working_time';
      date: string | null;
      basis: 'DataConsemnare';
      workingTime: RevisalWorkingTime;
    }
  | {
      kind: 'suspension';
      date: string | null;
      until: string | null;
      endedAt: string | null;
    }
  | { kind: 'suspension_end'; date: string }
  | { kind: 'termination'; date: string | null };

export interface RevisalContract {
  personKey: string;
  number: string | null;
  date: string | null;
  type: string | null;
  duration: string | null;
  startDate: string | null;
  endDate: string | null;
  occupationCode: string | null;
  recordedAt: string | null;
  workingTime: RevisalWorkingTime;
  baseSalary: RevisalSalary;
  allowances: RevisalAllowance[] | null;
  erased: boolean | null;
  state: {
    kind: 'active' | 'suspended' | 'ended' | 'unknown';
    sourceType: string | null;
    terminationDate: string | null;
    suspensionStart: string | null;
    suspensionEnd: string | null;
    suspensionEndedAt: string | null;
  };
  changes: RevisalChange[];
}

export interface RevisalExport {
  employerFiscalCode: string | null;
  /** Archive metadata, not an asserted XML reporting/effective date. */
  exportDate: string;
  exportDateSource: 'tar-member-mtime';
  contracts: RevisalContract[];
  unread: PathCount[];
}

function fail(code: string): never {
  throw new Error(code);
}

/** POSIX/GNU single-file tar. No archive path is ever extracted to disk. */
function tarMember(bytes: Uint8Array): { bytes: Uint8Array; date: string } {
  if (
    bytes.length < 1536 ||
    bytes.length % 512 !== 0 ||
    bytes.length > archiveLimits.compressedBytes + 10240
  )
    fail('REVISAL_TAR_SIZE');
  const archive = Buffer.from(bytes);
  const zero = (part: Uint8Array) => part.every((byte) => byte === 0);
  const string = (header: Buffer, start: number, length: number) => {
    const field = header.subarray(start, start + length);
    const end = field.indexOf(0);
    const value = end < 0 ? field : field.subarray(0, end);
    if (end >= 0 && !zero(field.subarray(end))) fail('REVISAL_TAR_HEADER');
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(value);
    } catch {
      return fail('REVISAL_TAR_HEADER');
    }
  };
  const octal = (header: Buffer, start: number, length: number) => {
    const field = header.subarray(start, start + length);
    if (field.some((byte) => byte > 127)) fail('REVISAL_TAR_HEADER');
    const raw = field.toString('ascii');
    if (!/^[\0 ]*[0-7]+[\0 ]*$/.test(raw)) fail('REVISAL_TAR_HEADER');
    const value = Number.parseInt(raw.replaceAll('\0', '').trim(), 8);
    if (!Number.isSafeInteger(value)) fail('REVISAL_TAR_HEADER');
    return value;
  };
  let result: { bytes: Uint8Array; date: string } | undefined;
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (zero(header)) {
      if (offset + 1024 > archive.length || !zero(archive.subarray(offset)))
        fail('REVISAL_TAR_TRAILER');
      if (!result) fail('REVISAL_TAR_EMPTY');
      return result;
    }
    const checksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    if (checksum !== octal(header, 148, 8)) fail('REVISAL_TAR_CHECKSUM');
    if (!['ustar\0', 'ustar '].includes(header.subarray(257, 263).toString('ascii')))
      fail('REVISAL_TAR_FORMAT');
    const prefix = string(header, 345, 155);
    const name = string(header, 0, 100);
    const path = prefix ? `${prefix}/${name}` : name;
    if (
      path.length > 512 ||
      /[\\:\p{Cc}\p{Cf}\ufffd]/u.test(path) ||
      path !== path.normalize('NFC') ||
      path.split('/').some((part) => !part || part === '.' || part === '..' || part !== part.trim())
    )
      fail('REVISAL_TAR_PATH');
    if (![0, 48].includes(header[156]!) || string(header, 157, 100) !== '')
      fail('REVISAL_TAR_MEMBER_TYPE');
    if (result || !/\.xml\.pcs$/i.test(path)) fail('REVISAL_TAR_MEMBERS');
    const size = octal(header, 124, 12);
    const end = offset + 512 + size;
    const paddedEnd = offset + 512 + Math.ceil(size / 512) * 512;
    if (size <= 0 || size > archiveLimits.compressedBytes) fail('REVISAL_TAR_MEMBER_SIZE');
    if (paddedEnd + 1024 > archive.length || !zero(archive.subarray(end, paddedEnd)))
      fail('REVISAL_TAR_TRUNCATED');
    const timestamp = octal(header, 136, 12) * 1000;
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) fail('REVISAL_TAR_DATE');
    result = { bytes: archive.subarray(offset + 512, end), date: date.toISOString() };
    offset = paddedEnd;
  }
  return fail('REVISAL_TAR_TRAILER');
}

/** Read the archive's snapshot. Unknown/free-text content contributes paths, never values. */
export async function readRevisal(bytes: Uint8Array, key: Uint8Array): Promise<RevisalExport> {
  if (key.byteLength < 32) fail('PAYROLL_KEY_SIZE');
  const member = tarMember(bytes);
  let xml: Uint8Array;
  try {
    const members = await parseInvoiceArchive(member.bytes);
    if (members.length !== 1 || members[0]!.root !== 'XmlReport') fail('REVISAL_ZIP_MEMBERS');
    xml = members[0]!.bytes;
  } catch (error) {
    // The shared adapter can include a member filename in its message. Do not propagate it.
    if (error instanceof DomainError) fail(`REVISAL_${error.code}`);
    if (error instanceof Error && error.message === 'REVISAL_ZIP_MEMBERS') throw error;
    return fail('REVISAL_ZIP_INVALID');
  }
  const root = sourceXml(xml, { namespacedAttributes: true });
  if (root.local !== 'XmlReport' || root.uri !== revisalNamespace) fail('REVISAL_NAMESPACE');
  const consumed = new Set<XmlElement>();
  const attributes = new Map<XmlElement, Set<string>>();
  const nil = (node: XmlElement) =>
    node.namespacedAttributes?.some(
      (attr) => attr.uri === xsi && attr.local === 'nil' && ['true', '1'].includes(attr.value),
    ) ?? false;
  const children = (node: XmlElement | undefined, local: string) =>
    node?.children.filter((child) => child.local === local) ?? [];
  const child = (node: XmlElement | undefined, local: string) => {
    const found = children(node, local);
    if (found.length > 1) fail('REVISAL_AMBIGUOUS_FIELD');
    return found[0];
  };
  const value = (node: XmlElement | undefined): string | null => {
    if (!node) return null;
    if (node.children.length) return null;
    consumed.add(node);
    return nil(node) || node.text === '' ? null : node.text;
  };
  const get = (node: XmlElement | undefined, local: string) => value(child(node, local));
  const date = (node: XmlElement | undefined, local: string) => {
    const text = get(node, local);
    if (
      text !== null &&
      !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(text)
    )
      fail('REVISAL_DATE');
    return text;
  };
  const decimal = (text: string | null) => {
    if (text !== null && !/^\d+(?:\.\d+)?$/.test(text)) fail('REVISAL_DECIMAL');
    return text;
  };
  const boolean = (node: XmlElement | undefined, local: string) => {
    const text = get(node, local);
    if (text !== null && !['true', 'false', '1', '0'].includes(text)) fail('REVISAL_BOOLEAN');
    return text === null ? null : text === 'true' || text === '1';
  };
  const type = (node: XmlElement | undefined) => {
    if (!node) return null;
    const attr = node.namespacedAttributes?.find(
      (attr) => attr.uri === xsi && attr.local === 'type',
    );
    if (!attr) return null;
    attributes.set(node, new Set([`${xsi}type`]));
    return attr.value.split(':').at(-1)!;
  };
  const validateNamespace = (node: XmlElement) => {
    if (node.uri !== revisalNamespace) fail('REVISAL_NAMESPACE');
    for (const item of node.children) validateNamespace(item);
  };
  validateNamespace(root);
  const contracts: RevisalContract[] = [];
  for (const person of children(child(root, 'Salariati'), 'Salariat')) {
    const identity = personKey(get(person, 'Cnp'), key);
    for (const contract of children(child(person, 'Contracte'), 'Contract')) {
      const time = child(contract, 'TimpMunca');
      const workingTime: RevisalWorkingTime = {
        type: get(contract, 'TipNorma'),
        duration: decimal(get(time, 'Durata')),
        interval: get(time, 'IntervalTimp'),
        norm: get(time, 'Norma'),
        distribution: get(time, 'Repartizare'),
      };
      const salary = child(contract, 'Salariu');
      const baseSalary = {
        amount: decimal(value(salary)),
        currency: get(contract, 'Moneda'),
      };
      const allowanceContainer = child(contract, 'SporuriSalariu');
      let allowances: RevisalAllowance[] | null = null;
      if (allowanceContainer) {
        consumed.add(allowanceContainer);
        if (!nil(allowanceContainer))
          allowances = children(allowanceContainer, 'Spor').map((allowance) => {
            const allowanceType = child(allowance, 'Tip');
            const label = get(allowanceType, 'Nume');
            return {
              type: type(allowanceType),
              typeKey: label === null ? null : allowanceTypeKey(label, key),
              version: get(allowanceType, 'Versiune'),
              isPercent: boolean(allowance, 'IsProcent'),
              value: decimal(get(allowance, 'Valoare')),
            };
          });
      }
      const recordedAt = date(contract, 'DataConsemnare');
      const current = child(contract, 'StareCurenta');
      const sourceType = type(current);
      const kinds = {
        ContractStareActiv: 'active',
        ContractStareSuspendare: 'suspended',
        ContractStareIncetare: 'ended',
      } as const;
      const kind =
        sourceType && Object.hasOwn(kinds, sourceType)
          ? kinds[sourceType as keyof typeof kinds]
          : 'unknown';
      const changes: RevisalChange[] = [];
      if (baseSalary.amount !== null)
        changes.push({
          kind: 'salary',
          date: recordedAt,
          basis: 'DataConsemnare',
          salary: baseSalary,
        });
      if (time && !nil(time))
        changes.push({
          kind: 'working_time',
          date: recordedAt,
          basis: 'DataConsemnare',
          workingTime,
        });
      const readState = (state: XmlElement | undefined) => {
        if (!state || nil(state)) {
          if (state) consumed.add(state);
          return;
        }
        const stateType = type(state);
        // Some exports retain the preceding state as a nested state, others only its code.
        const previous = child(state, 'StarePrecedenta');
        if (previous && (nil(previous) || previous.children.length > 0)) readState(previous);
        if (stateType === 'ContractStareSuspendare')
          changes.push({
            kind: 'suspension',
            date: date(state, 'DataInceput'),
            until: date(state, 'DataSfarsit'),
            endedAt: date(state, 'DataIncetare'),
          });
        if (stateType === 'ContractStareIncetare')
          changes.push({ kind: 'termination', date: date(state, 'DataIncetare') });
        const ended = date(state, 'DataIncetareSuspendare');
        if (ended) changes.push({ kind: 'suspension_end', date: ended });
      };
      readState(current);
      contracts.push({
        personKey: identity,
        number: get(contract, 'NumarContract'),
        date: date(contract, 'DataContract'),
        type: get(contract, 'TipContract'),
        duration: get(contract, 'TipDurata'),
        startDate: date(contract, 'DataInceputContract'),
        endDate: date(contract, 'DataSfarsitContract'),
        occupationCode: get(child(contract, 'Cor'), 'Cod'),
        recordedAt,
        workingTime,
        baseSalary,
        allowances,
        erased: boolean(contract, 'Radiat'),
        state: {
          kind,
          sourceType,
          terminationDate: kind === 'ended' ? date(current, 'DataIncetare') : null,
          suspensionStart: kind === 'suspended' ? date(current, 'DataInceput') : null,
          suspensionEnd: kind === 'suspended' ? date(current, 'DataSfarsit') : null,
          suspensionEndedAt: date(current, 'DataIncetareSuspendare'),
        },
        // ISO dates sort chronologically; unknown dates stay at the end, never invented.
        changes: changes.sort((a, b) => {
          if (a.date === b.date) return 0;
          if (a.date === null) return 1;
          if (b.date === null) return -1;
          return a.date < b.date ? -1 : 1;
        }),
      });
    }
  }
  const employerFiscalCode = get(
    child(child(child(root, 'Header'), 'Angajator'), 'Detalii'),
    'Cui',
  );
  const unread = new Map<string, number>();
  const add = (path: string) => unread.set(path, (unread.get(path) ?? 0) + 1);
  const walk = (node: XmlElement, path: string) => {
    if (!consumed.has(node) && (node.children.length === 0 || node.text.trim() !== '')) add(path);
    for (const name of Object.keys(node.attributes)) add(`${path}/@${name}`);
    for (const attr of node.namespacedAttributes ?? []) {
      if (attr.uri === xsi && attr.local === 'nil') continue;
      if (!attributes.get(node)?.has(`${attr.uri}${attr.local}`))
        add(`${path}/@{${attr.uri}}${attr.local}`);
    }
    for (const item of node.children) walk(item, `${path}/${item.local}`);
  };
  walk(root, '/XmlReport');
  return {
    employerFiscalCode,
    exportDate: member.date,
    exportDateSource: 'tar-member-mtime',
    contracts,
    unread: pathCounts(unread),
  };
}
