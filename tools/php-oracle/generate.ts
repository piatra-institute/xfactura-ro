// Generates e-Factura XML with the previous PHP pipeline (josemmo/einvoicing 0.2 through
// php-wasm), preparing input exactly as the invoicer did. The output is the regression oracle
// for the TypeScript writer in xfactura-core:
//   cd tools/php-oracle && bun install && bun generate.ts <invoices.json> <out-dir>
// where the input is an invoicer export or an array of invoices.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NodePHP } from '@php-wasm/node';
import {
  getDateFormat,
  normalizeUserCity,
  normalizeUserCountry,
  normalizeUserCounty,
  normalizeVatNumber,
} from './legacy';

type Company = {
  vatNumber: string;
  vatPayer?: boolean;
  country: string;
  county: string;
  city: string;
  [key: string]: unknown;
};
type Invoice = {
  id: string;
  seller: Company;
  buyer: Company;
  metadata: { issueDate: number; dueDate: number; [key: string]: unknown };
  products: { price: number; vatRate: number; vatIncluded?: boolean; [key: string]: unknown }[];
};

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('usage: generate.ts <invoices.json> <out-dir>');

const source = await Bun.file(input).json();
const invoices: Invoice[] = Array.isArray(source) ? source : Object.values(source.invoices);

const party = (company: Company) => ({
  ...company,
  vatNumber: normalizeVatNumber(company.vatNumber, company.vatPayer),
  country: normalizeUserCountry(company.country),
  subdivision: normalizeUserCounty(company.county, company.country),
  city: normalizeUserCity(company.city, company.county),
});

const php = await NodePHP.load('8.0', {
  requestHandler: { documentRoot: '/srv', absoluteUrl: 'http://localhost:3001' },
});
php.mkdir('/srv');
php.chdir('/srv');
php.mount(path.join(import.meta.dir, 'node-php'), '/srv');
await mkdir(output, { recursive: true });

let failed = 0;
let warned = 0;
for (const invoice of invoices) {
  const body = {
    metadata: {
      ...invoice.metadata,
      issueDate: getDateFormat(invoice.metadata.issueDate),
      dueDate: getDateFormat(invoice.metadata.dueDate),
    },
    seller: party(invoice.seller),
    buyer: party(invoice.buyer),
    lines: invoice.products.map((product) => ({
      ...product,
      price: product.vatIncluded ? product.price / (1 + product.vatRate / 100) : product.price,
    })),
  };
  const response = await php.request({
    method: 'POST',
    url: '/run.php',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
  // PHP prints notices (for example an absent vatPayer read as false) before the document.
  const start = response.text.indexOf('<?xml');
  if (response.httpStatusCode >= 400 || start < 0) {
    failed += 1;
    console.error(`${invoice.id}: ${response.text.slice(0, 300)}`);
    continue;
  }
  if (start > 0) warned += 1;
  await writeFile(path.join(output, `${invoice.id}.xml`), response.text.slice(start));
}
console.log(`${invoices.length - failed} generated (${warned} with PHP notices), ${failed} failed`);
process.exit(failed ? 1 : 0);
