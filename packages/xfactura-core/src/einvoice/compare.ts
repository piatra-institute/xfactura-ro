import type { Invoice } from './model';

export type InvoiceDifference = { path: string; expected?: string; actual?: string };

/** Field-by-field differences between two invoices, by path ("lines.0.price"). Values are the
 * model's canonical text, so "60" and "60.00" written by different generators compare equal. */
export function compareInvoices(expected: Invoice, actual: Invoice): InvoiceDifference[] {
  const left = flatten(expected);
  const right = flatten(actual);
  const differences: InvoiceDifference[] = [];
  for (const path of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const before = left.get(path);
    const after = right.get(path);
    if (before !== after)
      differences.push({
        path,
        ...(before === undefined ? {} : { expected: before }),
        ...(after === undefined ? {} : { actual: after }),
      });
  }
  return differences;
}

function flatten(value: unknown, prefix = '', into = new Map<string, string>()) {
  if (value === undefined) return into;
  if (value === null || typeof value !== 'object') {
    into.set(prefix, String(value));
    return into;
  }
  for (const [key, item] of Object.entries(value))
    flatten(item, prefix ? `${prefix}.${key}` : key, into);
  return into;
}
