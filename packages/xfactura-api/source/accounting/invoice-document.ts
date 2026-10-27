import { SaxesParser } from 'saxes';
import { z } from 'zod';
import { Amount, dateSchema, moneySchema, requireCondition } from './domain';

export const invoiceParserVersion = 'ubl-invoice-1';
const partySchema = z
  .object({
    name: z.string().min(1).max(500),
    taxId: z.string().min(1).max(100),
    country: z.string().regex(/^[A-Z]{2}$/),
  })
  .strict();
const rateSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,2})(\.\d{1,4})?$/)
  .transform((value) => new Amount(value).toString());
export const invoiceDocumentSchema = z
  .object({
    parserVersion: z.literal(invoiceParserVersion),
    documentType: z.enum(['invoice', 'credit_note']),
    number: z.string().min(1).max(100),
    issueDate: dateSchema,
    taxPointDate: dateSchema.nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    supplier: partySchema,
    customer: partySchema,
    originalInvoiceNumber: z.string().max(100).nullable(),
    customizationId: z.string().max(1000),
    lines: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            description: z.string().max(1000),
            net: moneySchema,
            vatCategory: z.string().min(1).max(10),
            vatRate: rateSchema.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
    taxes: z
      .array(
        z
          .object({
            base: moneySchema,
            tax: moneySchema,
            category: z.string().min(1).max(10),
            rate: rateSchema.nullable(),
            exemptionReason: z.string().max(1000).nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    totals: z
      .object({
        lineNet: moneySchema,
        net: moneySchema,
        tax: moneySchema,
        gross: moneySchema,
        allowances: moneySchema,
        charges: moneySchema,
        prepaid: moneySchema,
        rounding: z.string().regex(/^-?\d+\.\d{2}$/),
        payable: moneySchema,
      })
      .strict(),
  })
  .strict();
export type InvoiceDocument = z.infer<typeof invoiceDocumentSchema>;

const cbc = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
const cac = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';
type Element = {
  local: string;
  uri: string;
  text: string;
  attributes: Record<string, string>;
  children: Element[];
};

// Bounded, namespace-aware parsing. No external entities, DTDs, network or filesystem access.
function tree(bytes: Uint8Array): Element {
  requireCondition(
    bytes.length > 0 && bytes.length <= 10 * 1024 * 1024,
    'XML_SIZE',
    'Fișierul XML depășește limita.',
  );
  const stack: Element[] = [];
  let root: Element | undefined,
    nodes = 0;
  const parser = new SaxesParser({ xmlns: true });
  parser.on('xmldecl', (declaration) => {
    requireCondition(
      !declaration.encoding || declaration.encoding.toUpperCase() === 'UTF-8',
      'XML_ENCODING',
      'Folosiți un document XML UTF-8.',
    );
  });
  parser.on('doctype', () => {
    requireCondition(false, 'XML_DTD', 'Declarațiile DTD nu sunt acceptate.');
  });
  parser.on('opentag', (tag) => {
    requireCondition(
      ++nodes <= 100000 && stack.length < 64 && Object.keys(tag.attributes).length <= 100,
      'XML_COMPLEXITY',
      'Structura XML depășește limita.',
    );
    const node: Element = {
      local: tag.local,
      uri: tag.uri,
      text: '',
      attributes: Object.fromEntries(
        Object.values(tag.attributes)
          .filter((attr) => !attr.uri)
          .map((attr) => [attr.local, attr.value]),
      ),
      children: [],
    };
    if (stack.length) stack.at(-1)!.children.push(node);
    else {
      requireCondition(!root, 'XML_ROOT', 'Documentul XML trebuie să aibă o singură rădăcină.');
      root = node;
    }
    stack.push(node);
  });
  const text = (value: string) => {
    const node = stack.at(-1);
    if (node) {
      requireCondition(
        node.text.length + value.length <= 65536,
        'XML_TEXT',
        'Câmpul XML depășește limita.',
      );
      node.text += value;
    }
  };
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('closetag', () => {
    stack.pop();
  });
  parser.on('error', () => {
    requireCondition(false, 'XML_INVALID', 'Documentul XML nu este valid.');
  });
  let xml: string;
  try {
    xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    requireCondition(false, 'XML_ENCODING', 'Folosiți un document XML UTF-8.');
  }
  parser.write(xml).close();
  requireCondition(root && stack.length === 0, 'XML_ROOT', 'Document XML incomplet.');
  return root;
}
function children(node: Element, local: string, uri = cac) {
  return node.children.filter((child) => child.local === local && child.uri === uri);
}
function one(node: Element, local: string, uri = cac, optional = false): Element | undefined {
  const matches = children(node, local, uri);
  requireCondition(
    matches.length <= 1 && (optional || matches.length === 1),
    'XML_FIELD',
    `Câmp lipsă sau repetat: ${local}.`,
  );
  return matches[0];
}
function value(node: Element, local: string, optional = false) {
  const child = one(node, local, cbc, optional);
  if (!child) return null;
  requireCondition(child.children.length === 0, 'XML_FIELD', `Câmp compus neacceptat: ${local}.`);
  return child.text.trim();
}
function amount(node: Element, local: string, currency: string, optional = false) {
  const child = one(node, local, cbc, optional);
  if (!child) return '0.00';
  requireCondition(
    child.children.length === 0 && child.attributes.currencyID === currency,
    'XML_CURRENCY',
    `Moneda lipsește sau diferă la ${local}.`,
  );
  return moneySchema.parse(child.text.trim());
}
function rounding(node: Element, currency: string) {
  const child = one(node, 'PayableRoundingAmount', cbc, true);
  if (!child) return '0.00';
  requireCondition(
    child.children.length === 0 && child.attributes.currencyID === currency,
    'XML_CURRENCY',
    'Moneda rotunjirii diferă.',
  );
  requireCondition(
    /^-?(0|[1-9]\d{0,15})(\.\d{1,2})?$/.test(child.text.trim()),
    'XML_AMOUNT',
    'Rotunjire invalidă.',
  );
  return new Amount(child.text.trim()).toFixed(2);
}
function party(root: Element, role: string) {
  const node = one(one(root, role)!, 'Party')!;
  const legal = one(node, 'PartyLegalEntity', cac, true);
  const tax = one(node, 'PartyTaxScheme', cac, true);
  const nameNode = one(node, 'PartyName', cac, true);
  const address = one(node, 'PostalAddress')!;
  const country = one(address, 'Country')!;
  return {
    name: legal
      ? (value(legal, 'RegistrationName', true) ?? (nameNode ? value(nameNode, 'Name') : ''))
      : nameNode
        ? value(nameNode, 'Name')
        : '',
    taxId: tax ? value(tax, 'CompanyID')! : legal ? value(legal, 'CompanyID')! : '',
    country: value(country, 'IdentificationCode')!,
  };
}
const sum = (values: string[]) => values.reduce((total, value) => total.plus(value), new Amount(0));

export function parseInvoiceXml(bytes: Uint8Array): InvoiceDocument {
  const root = tree(bytes);
  requireCondition(
    (root.local === 'Invoice' || root.local === 'CreditNote') &&
      root.uri === `urn:oasis:names:specification:ubl:schema:xsd:${root.local}-2`,
    'XML_INVOICE',
    'Este necesară o factură UBL Invoice sau CreditNote.',
  );
  const credit = root.local === 'CreditNote';
  requireCondition(
    value(root, credit ? 'CreditNoteTypeCode' : 'InvoiceTypeCode') === (credit ? '381' : '380'),
    'INVOICE_TYPE',
    'Tipul facturii necesită un tratament separat.',
  );
  const currency = value(root, 'DocumentCurrencyCode')!;
  const taxTotal = children(root, 'TaxTotal').filter(
    (node) => one(node, 'TaxAmount', cbc, true)?.attributes.currencyID === currency,
  );
  requireCondition(
    taxTotal.length === 1,
    'XML_TAX',
    'Totalul TVA în moneda facturii lipsește sau este ambiguu.',
  );
  const totals = one(root, 'LegalMonetaryTotal')!;
  const billing = one(root, 'BillingReference', cac, true);
  const original = billing ? one(billing, 'InvoiceDocumentReference') : undefined;
  const lines = children(root, credit ? 'CreditNoteLine' : 'InvoiceLine').map((node) => {
    const item = one(node, 'Item')!;
    const category = one(item, 'ClassifiedTaxCategory')!;
    requireCondition(
      value(one(category, 'TaxScheme')!, 'ID') === 'VAT',
      'XML_TAX',
      'Schema de taxare nu este TVA.',
    );
    return {
      id: value(node, 'ID')!,
      description: value(item, 'Name')!,
      net: amount(node, 'LineExtensionAmount', currency),
      vatCategory: value(category, 'ID')!,
      vatRate: value(category, 'Percent', true),
    };
  });
  const document = invoiceDocumentSchema.parse({
    parserVersion: invoiceParserVersion,
    documentType: credit ? 'credit_note' : 'invoice',
    number: value(root, 'ID'),
    issueDate: value(root, 'IssueDate'),
    taxPointDate: value(root, 'TaxPointDate', true),
    currency,
    supplier: party(root, 'AccountingSupplierParty'),
    customer: party(root, 'AccountingCustomerParty'),
    originalInvoiceNumber: original ? value(original, 'ID') : null,
    customizationId: value(root, 'CustomizationID')!,
    lines,
    taxes: children(taxTotal[0], 'TaxSubtotal').map((node) => {
      const category = one(node, 'TaxCategory')!;
      requireCondition(
        value(one(category, 'TaxScheme')!, 'ID') === 'VAT',
        'XML_TAX',
        'Schema de taxare nu este TVA.',
      );
      return {
        base: amount(node, 'TaxableAmount', currency),
        tax: amount(node, 'TaxAmount', currency),
        category: value(category, 'ID'),
        rate: value(category, 'Percent', true),
        exemptionReason:
          value(category, 'TaxExemptionReasonCode', true) ??
          value(category, 'TaxExemptionReason', true),
      };
    }),
    totals: {
      lineNet: amount(totals, 'LineExtensionAmount', currency),
      net: amount(totals, 'TaxExclusiveAmount', currency),
      tax: amount(taxTotal[0], 'TaxAmount', currency),
      gross: amount(totals, 'TaxInclusiveAmount', currency),
      allowances: amount(totals, 'AllowanceTotalAmount', currency, true),
      charges: amount(totals, 'ChargeTotalAmount', currency, true),
      prepaid: amount(totals, 'PrepaidAmount', currency, true),
      rounding: rounding(totals, currency),
      payable: amount(totals, 'PayableAmount', currency),
    },
  });
  const t = document.totals;
  requireCondition(
    new Set(lines.map((line) => line.id)).size === lines.length,
    'XML_LINE_ID',
    'Identificator de linie repetat.',
  );
  requireCondition(
    sum(document.lines.map((line) => line.net)).eq(t.lineNet) &&
      new Amount(t.lineNet).minus(t.allowances).plus(t.charges).eq(t.net) &&
      new Amount(t.net).plus(t.tax).eq(t.gross) &&
      new Amount(t.gross).minus(t.prepaid).plus(t.rounding).eq(t.payable) &&
      sum(document.taxes.map((tax) => tax.base)).eq(t.net) &&
      sum(document.taxes.map((tax) => tax.tax)).eq(t.tax),
    'INVOICE_TOTALS',
    'Totalurile XML nu se reconciliază.',
  );
  return document;
}
