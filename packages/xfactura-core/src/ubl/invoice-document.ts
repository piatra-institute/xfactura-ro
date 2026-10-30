import { z } from 'zod';
import { requireCondition } from '../errors';
import { mentionsCashVat } from '../ro/cash-vat';
import { sourceXml, type XmlElement as Element } from '../xml/source-xml';
import { Amount, dateSchema, moneySchema, signedMoneySchema, toBani } from '../values';

export const invoiceParserVersion = 'ubl-invoice-1';
/** An invoice or credit note an agent read from a PDF or a photo (`documents.record`), in the
 * shape the UBL parser gives, so the invoice treatments read it unchanged. */
export const extractedInvoiceVersion = 'extracted-invoice-1';
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
const quantitySchema = z
  .string()
  .regex(/^-?(0|[1-9]\d{0,15})(\.\d{1,6})?$/)
  .transform((value) => new Amount(value).toFixed());
const priceSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,15})(\.\d{1,8})?$/)
  .transform((value) => new Amount(value).toFixed());
const negativeSourceSchema = z
  .object({
    typeCode: z.literal('380'),
    polarity: z.literal('negative'),
    lines: z
      .array(
        z
          .object({
            lineId: z.string().min(1).max(100),
            quantity: quantitySchema,
            unitCode: z.string().min(1).max(10),
            unitPrice: priceSchema,
            priceBaseQuantity: quantitySchema,
          })
          .strict(),
      )
      .min(1)
      .max(1000),
  })
  .strict();
export const invoiceDocumentSchema = z
  .object({
    parserVersion: z.enum([
      invoiceParserVersion,
      'ubl-invoice-2',
      'ubl-invoice-3',
      'ubl-invoice-4',
      extractedInvoiceVersion,
    ]),
    sourceInvoice: negativeSourceSchema.optional(),
    documentAdjustments: z
      .array(
        z
          .object({
            charge: z.boolean(),
            amount: moneySchema,
            base: moneySchema.nullable(),
            percentage: rateSchema.nullable(),
            reason: z.string().min(1).max(1000).nullable(),
            reasonCode: z.string().min(1).max(20).nullable(),
            vatCategory: z.string().min(1).max(10),
            vatRate: rateSchema.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(100)
      .optional(),
    invoiceTypeCode: z.enum(['380', '386']).optional(),
    invoiceReferences: z
      .array(
        z.object({ number: z.string().min(1).max(100), issueDate: dateSchema.nullable() }).strict(),
      )
      .max(100)
      .optional(),
    documentType: z.enum(['invoice', 'credit_note']),
    /** A note (BT-22) carries the mention «TVA la încasare» (Codul fiscal art. 319 alin. (20)
     * lit. p); RO_CIUS places it there). Absent otherwise. */
    vatOnCollection: z.literal(true).optional(),
    number: z.string().min(1).max(100),
    issueDate: dateSchema,
    taxPointDate: dateSchema.nullable(),
    /** BT-72: the date the supply was made or completed, when the document states it. */
    deliveryDate: dateSchema.optional(),
    /** BG-14 (BT-73, BT-74): the period the document invoices, when it states one. */
    invoicePeriod: z
      .object({ start: dateSchema.nullable(), end: dateSchema.nullable() })
      .strict()
      .optional(),
    /** BT-9, as an extracted document states it; the UBL parser does not read it yet. */
    dueDate: dateSchema.optional(),
    /** The payee's accounts (BT-84), as an extracted document states them. */
    payeeIbans: z.array(z.string().min(15).max(42)).min(1).max(5).optional(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    /** BT-6 and BT-111: the VAT accounting currency and the VAT total in it, when it differs
     * from the document currency. */
    vatCurrency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    vatAccountingTotal: moneySchema.optional(),
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

// Fixed input scales permit exact rational half-up rounding, even at maximum precision.
function negativeLineBani(quantity: string, unitPrice: string, baseQuantity: string) {
  const scaled = (value: string, places: number) => {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole + fraction.padEnd(places, '0'));
  };
  const numerator = -scaled(quantity, 6) * scaled(unitPrice, 8),
    denominator = scaled(baseQuantity, 6) * 1_000_000n;
  return -((2n * numerator + denominator) / (2n * denominator));
}

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
  const vatCurrency = value(root, 'TaxCurrencyCode', true);
  const accountingTotal =
    vatCurrency && vatCurrency !== currency
      ? children(root, 'TaxTotal').filter(
          (node) => one(node, 'TaxAmount', cbc, true)?.attributes.currencyID === vatCurrency,
        )
      : [];
  requireCondition(
    !vatCurrency || vatCurrency === currency || accountingTotal.length === 1,
    'XML_TAX',
    'Totalul TVA în moneda de contabilizare a TVA lipsește sau este ambiguu.',
  );
  const totals = one(root, 'LegalMonetaryTotal')!;
  const negative =
    !credit &&
    typeCode === '380' &&
    new Amount(amount(totals, 'TaxExclusiveAmount', currency, false, true)).lt(0);
  const sourceLines: z.infer<typeof negativeSourceSchema>['lines'] = [];
  function monetary(node: Element, local: string, optional = false) {
    const raw = amount(node, local, currency, optional, negative);
    requireCondition(
      !negative || new Amount(raw).lte(0),
      'NEGATIVE_INVOICE_SIGN',
      'Factura storno necesită sume negative sau zero consecvente.',
    );
    return negative ? new Amount(raw).negated().toFixed(2) : raw;
  }
  if (negative)
    requireCondition(
      children(root, 'AllowanceCharge').length === 0 &&
        ['AllowanceTotalAmount', 'ChargeTotalAmount', 'PrepaidAmount'].every(
          (field) => amount(totals, field, currency, true, true) === '0.00',
        ) &&
        rounding(totals, currency) === '0.00',
      'UNSUPPORTED_NEGATIVE_INVOICE',
      'Stornările cu ajustări globale, avansuri sau rotunjiri necesită un tratament separat.',
    );
  const adjustmentNodes = children(root, 'AllowanceCharge');
  requireCondition(
    adjustmentNodes.length <= 100,
    'XML_ALLOWANCE_LIMIT',
    'Prea multe reduceri sau majorări la nivelul facturii.',
  );
  const adjustments = adjustmentNodes.map((node) => {
    const indicator = value(node, 'ChargeIndicator'),
      category = one(node, 'TaxCategory')!,
      baseNode = one(node, 'BaseAmount', cbc, true),
      percentage = value(node, 'MultiplierFactorNumeric', true),
      reason = value(node, 'AllowanceChargeReason', true),
      reasonCode = value(node, 'AllowanceChargeReasonCode', true);
    requireCondition(
      indicator === 'true' || indicator === 'false' || indicator === '1' || indicator === '0',
      'XML_ALLOWANCE',
      'Indicatorul reducerii sau majorării este invalid.',
    );
    requireCondition(
      !!reason || !!reasonCode,
      'XML_ALLOWANCE_REASON',
      'Documentați motivul reducerii sau majorării.',
    );
    requireCondition(
      value(one(category, 'TaxScheme')!, 'ID') === 'VAT',
      'XML_TAX',
      'Schema de taxare nu este TVA.',
    );
    requireCondition(
      !!baseNode === (percentage !== null),
      'XML_ALLOWANCE_PERCENTAGE',
      'Baza și procentul reducerii sau majorării se furnizează împreună.',
    );
    const row = {
      charge: indicator === 'true' || indicator === '1',
      amount: amount(node, 'Amount', currency),
      base: baseNode ? amount(node, 'BaseAmount', currency) : null,
      percentage: percentage === null ? null : rateSchema.parse(percentage),
      reason,
      reasonCode,
      vatCategory: value(category, 'ID')!,
      vatRate: value(category, 'Percent', true),
    };
    requireCondition(
      row.base === null ||
        new Amount(row.base)
          .mul(row.percentage!)
          .div(100)
          .toDecimalPlaces(2, Amount.ROUND_HALF_UP)
          .eq(row.amount),
      'XML_ALLOWANCE_PERCENTAGE',
      'Suma reducerii sau majorării nu corespunde bazei și procentului.',
    );
    return row;
  });
  // BT-72 and BG-14, read only when the document states each once (UBL admits several).
  const deliveryDates = [
    ...new Set(
      children(root, 'Delivery').flatMap((node) => value(node, 'ActualDeliveryDate', true) ?? []),
    ),
  ];
  const periods = children(root, 'InvoicePeriod').map((node) => ({
    start: value(node, 'StartDate', true),
    end: value(node, 'EndDate', true),
  }));
  const invoicePeriod =
    periods.length === 1 && (periods[0]!.start || periods[0]!.end) ? periods[0] : undefined;
  const references = children(root, 'BillingReference').map((billing) => {
    const original = one(billing, 'InvoiceDocumentReference')!;
    return { number: value(original, 'ID')!, issueDate: value(original, 'IssueDate', true) };
  });
  requireCondition(
    references.length <= 100 && (!credit || references.length <= 1),
    'XML_REFERENCE',
    'Referințele facturilor sunt prea multe sau ambigue.',
  );
  requireCondition(
    !negative || (references.length === 1 && references[0].issueDate !== null),
    'NEGATIVE_INVOICE_REFERENCE',
    'Factura storno trebuie să identifice numărul și data unei singure facturi originale.',
  );
  const lines = children(root, credit ? 'CreditNoteLine' : 'InvoiceLine').map((node) => {
    const item = one(node, 'Item')!;
    const category = one(item, 'ClassifiedTaxCategory')!;
    requireCondition(
      value(one(category, 'TaxScheme')!, 'ID') === 'VAT',
      'XML_TAX',
      'Schema de taxare nu este TVA.',
    );
    const net = amount(node, 'LineExtensionAmount', currency, false, true);
    if (negative) {
      const quantityNode = one(node, 'InvoicedQuantity', cbc)!,
        price = one(node, 'Price')!,
        quantity = quantitySchema.parse(value(node, 'InvoicedQuantity')),
        unitCode = quantityNode.attributes.unitCode,
        base = one(price, 'BaseQuantity', cbc, true),
        priceBaseQuantity = base ? quantitySchema.parse(value(price, 'BaseQuantity')) : '1',
        priceNode = one(price, 'PriceAmount', cbc)!,
        unitPrice = priceSchema.parse(value(price, 'PriceAmount'));
      requireCondition(
        children(node, 'AllowanceCharge').length === 0 &&
          children(price, 'AllowanceCharge').length === 0 &&
          priceNode.attributes.currencyID === currency &&
          !!unitCode &&
          (!base?.attributes.unitCode || base.attributes.unitCode === unitCode) &&
          new Amount(quantity).lt(0) &&
          new Amount(unitPrice).gt(0) &&
          new Amount(priceBaseQuantity).gt(0) &&
          new Amount(net).lt(0) &&
          negativeLineBani(quantity, unitPrice, priceBaseQuantity) === toBani(net),
        'NEGATIVE_INVOICE_LINE',
        'Stornarea necesită cantități negative, prețuri pozitive și valori de linie reconciliate, fără ajustări de linie.',
      );
      sourceLines.push({
        lineId: value(node, 'ID')!,
        quantity,
        unitCode,
        unitPrice,
        priceBaseQuantity,
      });
    }
    return {
      id: value(node, 'ID')!,
      description: value(item, 'Name')!,
      net: negative ? new Amount(net).negated().toFixed(2) : net,
      vatCategory: value(category, 'ID')!,
      vatRate: value(category, 'Percent', true),
    };
  });
  const document = invoiceDocumentSchema.parse({
    parserVersion: negative
      ? 'ubl-invoice-4'
      : adjustments.length
        ? 'ubl-invoice-3'
        : typeCode === '386' ||
            references.length > 1 ||
            lines.some((line) => new Amount(line.net).lt(0))
          ? 'ubl-invoice-2'
          : invoiceParserVersion,
    ...(adjustments.length ? { documentAdjustments: adjustments } : {}),
    ...(negative
      ? { sourceInvoice: { typeCode: '380', polarity: 'negative', lines: sourceLines } }
      : {}),
    ...(negative ||
    typeCode === '386' ||
    references.length > 1 ||
    lines.some((line) => new Amount(line.net).lt(0))
      ? { invoiceTypeCode: typeCode, invoiceReferences: references }
      : {}),
    documentType: credit || negative ? 'credit_note' : 'invoice',
    ...(children(root, 'Note', cbc).some((node) => mentionsCashVat(node.text))
      ? { vatOnCollection: true as const }
      : {}),
    number: value(root, 'ID'),
    issueDate: value(root, 'IssueDate'),
    taxPointDate: value(root, 'TaxPointDate', true),
    ...(deliveryDates.length === 1 ? { deliveryDate: deliveryDates[0] } : {}),
    ...(invoicePeriod ? { invoicePeriod } : {}),
    currency,
    ...(accountingTotal[0]
      ? {
          vatCurrency: vatCurrency!,
          // Normalized like every other amount: a negative invoice states its totals as positive.
          vatAccountingTotal: new Amount(
            amount(accountingTotal[0], 'TaxAmount', vatCurrency!, false, negative),
          )
            .abs()
            .toFixed(2),
        }
      : {}),
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
        base: monetary(node, 'TaxableAmount'),
        tax: monetary(node, 'TaxAmount'),
        category: value(category, 'ID'),
        rate: value(category, 'Percent', true),
        exemptionReason:
          value(category, 'TaxExemptionReasonCode', true) ??
          value(category, 'TaxExemptionReason', true),
      };
    }),
    totals: {
      lineNet: monetary(totals, 'LineExtensionAmount'),
      net: monetary(totals, 'TaxExclusiveAmount'),
      tax: monetary(taxTotal[0], 'TaxAmount'),
      gross: monetary(totals, 'TaxInclusiveAmount'),
      allowances: amount(totals, 'AllowanceTotalAmount', currency, true),
      charges: amount(totals, 'ChargeTotalAmount', currency, true),
      prepaid: amount(totals, 'PrepaidAmount', currency, true),
      rounding: rounding(totals, currency),
      payable: monetary(totals, 'PayableAmount'),
    },
  });
  const t = document.totals;
  requireCondition(
    !adjustments.length ||
      (sum(adjustments.filter((row) => !row.charge).map((row) => row.amount)).eq(t.allowances) &&
        sum(adjustments.filter((row) => row.charge).map((row) => row.amount)).eq(t.charges)),
    'INVOICE_ALLOWANCE_TOTALS',
    'Reducerile și majorările nu se reconciliază cu totalurile XML.',
  );
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
