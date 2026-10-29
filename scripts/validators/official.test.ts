// Runs the official validation artifacts over the writer's synthetic corpus, and over mutations
// that must be rejected. Without the artifacts (`bun run validators:fetch`), Java or xmllint the
// tests are skipped, never passed.
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { $ } from 'bun';
import {
  calculateInvoice,
  fromInvoicer,
  writeInvoice,
  type InvoiceDraft,
  type InvoicerInvoice,
} from '../../packages/xfactura-core/src/einvoice';

const root = path.join(import.meta.dir, '../..');
const ready =
  existsSync(path.join(root, '.validators/en16931-ubl/xslt/EN16931-UBL-validation.xslt')) &&
  existsSync(path.join(root, '.validators/ubl-2.1/xsd')) &&
  existsSync(path.join(root, '.validators/saxon/Saxon-HE-12.7.jar')) &&
  Bun.which('java') !== null &&
  Bun.which('xmllint') !== null;
const official = ready ? test : test.skip;

const seller = {
  name: 'Exemplu Servicii SRL',
  vatId: 'RO18547290',
  address: { lines: ['Str. Lungă 10'], city: 'Galați', subdivision: 'RO-GL', country: 'RO' },
};
const buyer = {
  name: 'Client Test SRL',
  vatId: 'RO14399840',
  address: { lines: ['Bd. Unirii 5'], city: 'SECTOR3', subdivision: 'RO-B', country: 'RO' },
};
const service = (
  price: string,
  vat: InvoiceDraft['lines'][number]['vat'] = { category: 'S', rate: '21' },
) => ({
  name: 'Servicii',
  quantity: '1',
  unitCode: 'C62',
  price,
  vat,
});
const base: InvoiceDraft = {
  typeCode: '380',
  number: 'XF-1',
  issueDate: '2026-03-10',
  dueDate: '2026-04-09',
  currency: 'RON',
  seller,
  buyer,
  payment: { meansCode: '30', accounts: [{ id: 'RO49AAAA1B31007593840000' }] },
  lines: [service('100')],
};

const drafts: Record<string, InvoiceDraft> = {
  'credit-note': {
    ...base,
    typeCode: '381',
    precedingInvoices: [{ number: 'XF-0', issueDate: '2026-02-10' }],
  },
  euro: {
    ...base,
    currency: 'EUR',
    vatCurrency: 'RON',
    vatAccountingTotal: '104.30',
    notes: ['Curs BNR 4,9670 lei/euro'],
  },
  exempt: { ...base, lines: [service('100', { category: 'E', exemptionCode: 'VATEX-EU-132' })] },
  'reverse-charge': {
    ...base,
    buyer: {
      ...buyer,
      vatId: 'DE123456789',
      address: { lines: ['Hauptstraße 1'], city: 'Berlin', country: 'DE' },
    },
    lines: [service('1000', { category: 'AE', exemptionCode: 'VATEX-EU-AE' })],
  },
  adjustments: {
    ...base,
    adjustments: [
      { charge: false, reason: 'Reducere', percent: '5', vat: { category: 'S', rate: '21' } },
      { charge: true, reason: 'Transport', amount: '25', vat: { category: 'S', rate: '21' } },
    ],
    prepaid: '50',
    lines: [
      { ...service('200'), period: { start: '2026-03-01', end: '2026-03-31' } },
      {
        ...service('99.99'),
        adjustments: [{ charge: false, reason: 'Fidelitate', amount: '9.99' }],
      },
    ],
  },
  storno: {
    ...base,
    precedingInvoices: [{ number: 'XF-0' }],
    lines: [{ ...service('100'), quantity: '-1' }],
  },
};

async function validate(documents: Record<string, string>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'xfactura-official-'));
  try {
    for (const [name, xml] of Object.entries(documents))
      await writeFile(path.join(directory, `${name}.xml`), xml);
    const report = path.join(directory, 'report.json');
    await $`bun ${path.join(import.meta.dir, 'validate.ts')} --json ${report} ${directory}`
      .nothrow()
      .quiet();
    const { results } = JSON.parse(readFileSync(report, 'utf8')) as {
      results: {
        file: string;
        xsd: string[];
        rules: Record<string, { rule: string; flag: string }[]>;
      }[];
    };
    return Object.fromEntries(
      results.map((result) => [
        path.basename(result.file, '.xml'),
        [
          ...result.xsd.map(() => 'XSD'),
          ...Object.values(result.rules)
            .flat()
            .filter((finding) => finding.flag === 'fatal')
            .map((finding) => finding.rule),
        ],
      ]),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('official EN 16931 validation', () => {
  official(
    'the synthetic corpus passes the UBL 2.1 schema and every fatal EN 16931 rule',
    async () => {
      const invoicer = JSON.parse(
        readFileSync(
          path.join(root, 'packages/xfactura-core/test/fixtures/einvoice/invoicer.json'),
          'utf8',
        ),
      ) as InvoicerInvoice[];
      const documents: Record<string, string> = {};
      for (const source of invoicer)
        documents[`invoicer-${source.id}`] = writeInvoice(
          calculateInvoice(fromInvoicer(source).draft),
        );
      for (const [name, draft] of Object.entries(drafts))
        documents[name] = writeInvoice(calculateInvoice(draft));
      const findings = await validate(documents);
      expect(Object.keys(findings).length).toBe(Object.keys(documents).length);
      expect(Object.entries(findings).filter(([, rules]) => rules.length)).toEqual([]);
    },
    120_000,
  );

  official(
    'mutations of a valid invoice are rejected',
    async () => {
      const xml = writeInvoice(calculateInvoice(base));
      const mutate = (from: string, to: string) => {
        expect(xml).toContain(from);
        return xml.replace(from, to);
      };
      const findings = await validate({
        payable: mutate(
          '<cbc:PayableAmount currencyID="RON">121.00',
          '<cbc:PayableAmount currencyID="RON">121.01',
        ),
        'line-total': mutate(
          '<cbc:LineExtensionAmount currencyID="RON">100.00</cbc:LineExtensionAmount>\n    <cbc:TaxExclusiveAmount',
          '<cbc:LineExtensionAmount currencyID="RON">100.01</cbc:LineExtensionAmount>\n    <cbc:TaxExclusiveAmount',
        ),
        'tax-point-twice': mutate(
          '<cbc:DocumentCurrencyCode>',
          '<cbc:TaxPointDate>2026-03-10</cbc:TaxPointDate>\n  <cac:InvoicePeriod><cbc:DescriptionCode>3</cbc:DescriptionCode></cac:InvoicePeriod>\n  <cbc:DocumentCurrencyCode>',
        ),
        'no-seller-vat-id': mutate(
          '<cbc:CompanyID>RO18547290</cbc:CompanyID>',
          '<cbc:CompanyID></cbc:CompanyID>',
        ),
        'element-order': mutate('<cbc:DueDate>2026-04-09</cbc:DueDate>\n', '').replace(
          '<cbc:DocumentCurrencyCode>',
          '<cbc:DueDate>2026-04-09</cbc:DueDate>\n  <cbc:DocumentCurrencyCode>',
        ),
      });
      expect(findings.payable).toContain('BR-CO-16');
      expect(findings['line-total']).toContain('BR-CO-10');
      expect(findings['tax-point-twice']!.length).toBeGreaterThan(0);
      expect(findings['no-seller-vat-id']!.length).toBeGreaterThan(0);
      expect(findings['element-order']).toContain('XSD');
    },
    120_000,
  );
});
