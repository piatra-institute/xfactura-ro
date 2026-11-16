import { createHmac } from 'node:crypto';

/** Shared across source readers; neither the identifier nor the secret enters a model. */
export function personKey(code: string | null, key: Uint8Array): string {
  if (key.byteLength < 32) throw new Error('PAYROLL_KEY_SIZE');
  const normalized = code?.trim();
  if (!normalized || !/^\d{13}$/.test(normalized)) throw new Error('PAYROLL_PERSON_CODE');
  return createHmac('sha256', key).update(`xfactura-replay:person:v1\0${normalized}`).digest('hex');
}

/** Allowance labels can be employer free text; retain equality without retaining that text. */
export function allowanceTypeKey(label: string, key: Uint8Array): string {
  if (key.byteLength < 32) throw new Error('PAYROLL_KEY_SIZE');
  return createHmac('sha256', key).update(`xfactura-replay:allowance:v1\0${label}`).digest('hex');
}

export interface PathCount {
  path: string;
  count: number;
}

export function pathCounts(counts: Map<string, number>): PathCount[] {
  return [...counts]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, count]) => ({ path, count }));
}
