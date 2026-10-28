import { z } from 'zod';
import { sourceXml, type XmlElement as Element } from './source-xml';
import { Amount, dateSchema, moneySchema, signedMoneySchema, requireCondition } from './domain';

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
    parserVersion: z.enum([invoiceParserVersion, 'ubl-invoice-2']),
    invoiceTypeCode: z.enum(['380', '386']).optional(),
    invoiceReferences: z
      .array(
        z.object({ number: z.string().min(1).max(100), issueDate: dateSchema.nullable() }).strict(),
      )
      .max(100)
      .optional(),
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
            net: signedMoneySchema,
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
function amount(node: Element, local: string, currency: string, optional = false, signed = false) {
  const child = one(node, local, cbc, optional);
  if (!child) return '0.00';
  requireCondition(
    child.children.length === 0 && child.attributes.currencyID === currency,
    'XML_CURRENCY',
    `Moneda lipsește sau diferă la ${local}.`,
  );
  return (signed ? signedMoneySchema : moneySchema).parse(child.text.trim());
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
  return invoiceDocumentFromXml(sourceXml(bytes));
}

export function invoiceDocumentFromXml(root: Element): InvoiceDocument {
  requireCondition(
    (root.local === 'Invoice' || root.local === 'CreditNote') &&
      root.uri === `urn:oasis:names:specification:ubl:schema:xsd:${root.local}-2`,
    'XML_INVOICE',
    'Este necesară o factură UBL Invoice sau CreditNote.',
  );
  const credit = root.local === 'CreditNote';
  const typeCode = value(root, credit ? 'CreditNoteTypeCode' : 'InvoiceTypeCode');
  requireCondition(
    credit ? typeCode === '381' : typeCode === '380' || typeCode === '386',
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
  const references = children(root, 'BillingReference').map((billing) => {
    const original = one(billing, 'InvoiceDocumentReference')!;
    return { number: value(original, 'ID')!, issueDate: value(original, 'IssueDate', true) };
  });
  requireCondition(
    references.length <= 100 && (!credit || references.length <= 1),
    'XML_REFERENCE',
    'Referințele facturilor sunt prea multe sau ambigue.',
  );
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
      net: amount(node, 'LineExtensionAmount', currency, false, true),
      vatCategory: value(category, 'ID')!,
      vatRate: value(category, 'Percent', true),
    };
  });
  const document = invoiceDocumentSchema.parse({
    parserVersion:
      typeCode === '386' ||
      references.length > 1 ||
      lines.some((line) => new Amount(line.net).lt(0))
        ? 'ubl-invoice-2'
        : invoiceParserVersion,
    ...(typeCode === '386' ||
    references.length > 1 ||
    lines.some((line) => new Amount(line.net).lt(0))
      ? { invoiceTypeCode: typeCode, invoiceReferences: references }
      : {}),
    documentType: credit ? 'credit_note' : 'invoice',
    number: value(root, 'ID'),
    issueDate: value(root, 'IssueDate'),
    taxPointDate: value(root, 'TaxPointDate', true),
    currency,
    supplier: party(root, 'AccountingSupplierParty'),
    customer: party(root, 'AccountingCustomerParty'),
    originalInvoiceNumber: references[0]?.number ?? null,
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
