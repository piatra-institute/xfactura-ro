// Writes invoicer documents (an export or an array) as e-Factura XML with the core writer:
//   bun scripts/einvoice/write-invoicer.ts <invoices.json> <out-dir>
// Documents that cannot be converted are listed with the reason and skipped.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  calculateInvoice,
  fromInvoicer,
  writeInvoice,
  type InvoicerInvoice,
} from '../../packages/xfactura-core/src/einvoice';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('usage: write-invoicer.ts <invoices.json> <out-dir>');
const source = await Bun.file(input).json();
const invoices: InvoicerInvoice[] = Array.isArray(source) ? source : Object.values(source.invoices);
await mkdir(output, { recursive: true });
let written = 0;
for (const invoice of invoices) {
  try {
    const xml = writeInvoice(calculateInvoice(fromInvoicer(invoice).draft));
    await writeFile(path.join(output, `${invoice.id}.xml`), xml);
    written += 1;
  } catch (error) {
    console.error(`${invoice.id}: ${(error as Error).message}`);
  }
}
console.log(`${written} written, ${invoices.length - written} skipped`);
