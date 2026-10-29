// Compares the TypeScript e-Factura writer with the previous PHP generator over a real invoicer
// export. Inputs and the report stay under .private/ (gitignored):
//   bun scripts/pilot/compare-writer.ts <export.json> .private/pilot/php .private/pilot/writer-report.json
// The PHP corpus comes from `bun packages/xfactura-web/scripts/php-oracle.ts <export.json> <dir>`.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  calculateInvoice,
  compareInvoices,
  fromInvoicer,
  readInvoice,
  verifyInvoice,
  writeInvoice,
  type InvoicerInvoice,
} from '../../packages/xfactura-core/src/einvoice';

const [exportPath, phpDir, reportPath] = process.argv.slice(2);
if (!exportPath || !phpDir || !reportPath)
  throw new Error('usage: compare-writer.ts <export.json> <php-dir> <report.json>');

const source = JSON.parse(readFileSync(exportPath, 'utf8'));
const invoices = Object.values(source.invoices) as InvoicerInvoice[];
// Paths are reported by shape ("lines.*.price"), so counts aggregate across documents.
const shape = (field: string) => field.replace(/\.\d+(?=\.|$)/g, '.*');
const differences = new Map<string, number>();
const notes = new Map<string, number>();
const errors: { id: string; number: string; code: string; message: string }[] = [];
const inconsistent: { id: string; number: string; findings: string[] }[] = [];
const byNumber = new Map<string, string[]>();
let identical = 0;

for (const invoice of invoices) {
  const number = String(invoice.metadata.number);
  byNumber.set(number, [...(byNumber.get(number) ?? []), invoice.id]);
  const expected = readInvoice(readFileSync(path.join(phpDir, `${invoice.id}.xml`)));
  const legacyFindings = verifyInvoice(expected);
  if (legacyFindings.length)
    inconsistent.push({ id: invoice.id, number, findings: legacyFindings });
  try {
    const converted = fromInvoicer(invoice);
    for (const note of converted.notes) notes.set(note.code, (notes.get(note.code) ?? 0) + 1);
    const actual = calculateInvoice(converted.draft);
    const reread = readInvoice(new TextEncoder().encode(writeInvoice(actual)));
    if (verifyInvoice(reread).length) throw new Error('writer output does not recalculate');
    const found = compareInvoices(expected, actual);
    if (found.length === 0) identical += 1;
    for (const key of new Set(found.map((item) => shape(item.path))))
      differences.set(key, (differences.get(key) ?? 0) + 1);
  } catch (error) {
    const { code = 'ERROR', message } = error as { code?: string; message: string };
    errors.push({ id: invoice.id, number, code, message });
  }
}

const report = {
  invoices: invoices.length,
  identicalToPhp: identical,
  conversionErrors: errors,
  differencesByField: Object.fromEntries([...differences].sort((a, b) => b[1] - a[1])),
  conversionNotes: Object.fromEntries(notes),
  phpOutputNotSelfConsistent: inconsistent,
  numbersUsedMoreThanOnce: [...byNumber].filter(([, ids]) => ids.length > 1).length,
};
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify(
    {
      ...report,
      conversionErrors: Object.fromEntries(
        Object.entries(Object.groupBy(errors, (item) => item.code)).map(([code, list]) => [
          code,
          list!.length,
        ]),
      ),
      phpOutputNotSelfConsistent: inconsistent.length,
    },
    null,
    2,
  ),
);
