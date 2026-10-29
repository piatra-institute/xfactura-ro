import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * Deterministic JSON used for every approval and command hash, identical in browsers and on the
 * server. Object keys are ordered by UTF-16 code units (never by locale), undefined properties
 * are omitted, bigint values become decimal strings (their stored form), and values JSON cannot
 * represent exactly are rejected rather than silently coerced.
 */
export function canonical(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return JSON.stringify(value.toString());
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonical: non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (value === null) return 'null';
      if (Array.isArray(value))
        return `[${value
          .map((item) => {
            if (item === undefined) throw new TypeError('canonical: undefined array item');
            return canonical(item);
          })
          .join(',')}]`;
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null)
        throw new TypeError('canonical: only plain objects are supported');
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
        .join(',')}}`;
    }
    default:
      throw new TypeError(`canonical: unsupported ${typeof value}`);
  }
}

export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

/** sha256 of the canonical form; the identity of proposals, effects and documents. */
export function hashOf(value: unknown): string {
  return sha256Hex(canonical(value));
}

/** A UUID-shaped identifier (RFC 9562 version 8) derived from its parts, so the same proposal
 * always names the records it creates identically. */
export function derivedId(...parts: string[]): string {
  const hex = sha256Hex(canonical(parts));
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
