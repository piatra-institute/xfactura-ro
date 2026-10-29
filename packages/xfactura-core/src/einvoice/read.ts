import { requireCondition } from '../errors';
import { sourceXml, type XmlElement } from '../xml/source-xml';
import { calculateInvoice, defined } from './calculate';
import {
  amountSchema,
  canonicalDecimal,
  typeCodes,
  vatCategories,
  type Adjustment,
  type Invoice,
  type Line,
  type Party,
  type Vat,
  type VatBreakdown,
} from './model';
import { ublNamespaces } from './write';

const { cac, cbc } = ublNamespaces;

/**
 * Reads a UBL 2.1 Invoice or CreditNote into the semantic model, keeping every amount as
 * written. It does not check the arithmetic; `verifyInvoice` compares a read invoice with its
 * recalculation.
 */
export function readInvoice(bytes: Uint8Array): Invoice {
  const root = sourceXml(bytes);
  const credit = root.local === 'CreditNote';
  requireCondition(
    (root.local === 'Invoice' || credit) &&
      root.uri === (credit ? ublNamespaces.creditNote : ublNamespaces.invoice),
    'EINVOICE_ROOT',
    'Este necesar un document UBL Invoice sau CreditNote.',
  );
  const currency = text(root, 'DocumentCurrencyCode')!;
  const vatCurrency = text(root, 'TaxCurrencyCode');
  const money = (node: XmlElement, local: string, unit = currency) => {
    const found = one(node, local, cbc);
    if (!found) return undefined;
    requireCondition(
      found.attributes.currencyID === unit,
      'EINVOICE_CURRENCY',
      `Moneda sumei ${local} diferă de ${unit}.`,
    );
    return amountSchema.parse(found.text.trim());
  };
  const typeCode = text(root, credit ? 'CreditNoteTypeCode' : 'InvoiceTypeCode');
  requireCondition(
    typeCodes.includes(typeCode as never),
    'EINVOICE_TYPE',
    `Tipul de document ${typeCode} nu este acceptat.`,
  );

  const taxTotals = all(root, 'TaxTotal');
  const documentTax = taxTotals.find(
    (node) => one(node, 'TaxAmount', cbc)?.attributes.currencyID === currency,
  );
  const accountingTax = taxTotals.find(
    (node) =>
      vatCurrency &&
      vatCurrency !== currency &&
      one(node, 'TaxAmount', cbc)?.attributes.currencyID === vatCurrency,
  );
  requireCondition(documentTax, 'EINVOICE_TAX_TOTAL', 'Lipsește totalul TVA în moneda facturii.');
  const period = one(root, 'InvoicePeriod');
  const monetary = one(root, 'LegalMonetaryTotal')!;
  const means = all(root, 'PaymentMeans');
  const firstMeans = means[0];
  const payment = firstMeans
    ? defined({
        meansCode: text(firstMeans, 'PaymentMeansCode')!,
        reference: text(firstMeans, 'PaymentID'),
        accounts: means.flatMap((node) => {
          const account = one(node, 'PayeeFinancialAccount');
          if (!account) return [];
          const branch = one(account, 'FinancialInstitutionBranch');
          return [
            defined({
              id: text(account, 'ID')!,
              name: text(account, 'Name'),
              bank: branch && text(branch, 'ID'),
            }),
          ];
        }),
        terms: optionalPath(root, ['PaymentTerms'], 'Note'),
      })
    : undefined;
  const zero = '0.00';

  return defined({
    typeCode: typeCode as Invoice['typeCode'],
    customization: text(root, 'CustomizationID')!,
    number: text(root, 'ID')!,
    issueDate: date(text(root, 'IssueDate')!),
    dueDate: credit
      ? firstMeans && optionalDate(text(firstMeans, 'PaymentDueDate'))
      : optionalDate(text(root, 'DueDate')),
    taxPointDate: optionalDate(text(root, 'TaxPointDate')),
    taxPointCode: period && (text(period, 'DescriptionCode') as Invoice['taxPointCode']),
    currency,
    vatCurrency: vatCurrency as Invoice['vatCurrency'],
    vatAccountingTotal: accountingTax && money(accountingTax, 'TaxAmount', vatCurrency),
    notes: all(root, 'Note', cbc).map((node) => node.text.trim()),
    buyerReference: text(root, 'BuyerReference'),
    contractReference: optionalPath(root, ['ContractDocumentReference'], 'ID'),
    orderReference: optionalPath(root, ['OrderReference'], 'ID'),
    precedingInvoices: all(root, 'BillingReference').map((node) => {
      const reference = one(node, 'InvoiceDocumentReference')!;
      return defined({
        number: text(reference, 'ID')!,
        issueDate: optionalDate(text(reference, 'IssueDate')),
      });
    }),
    invoicingPeriod: period && periodOf(period),
    seller: party(one(one(root, 'AccountingSupplierParty')!, 'Party')!),
    buyer: party(one(one(root, 'AccountingCustomerParty')!, 'Party')!),
    deliveryDate: optionalDate(optionalPath(root, ['Delivery'], 'ActualDeliveryDate')),
    payment,
    adjustments: all(root, 'AllowanceCharge').map((node) => ({
      ...adjustment(node, money),
      vat: vat(one(node, 'TaxCategory')!),
    })),
    lines: all(root, credit ? 'CreditNoteLine' : 'InvoiceLine').map((node): Line => {
      const quantity = one(node, credit ? 'CreditedQuantity' : 'InvoicedQuantity', cbc)!;
      const item = one(node, 'Item')!;
      const price = one(node, 'Price')!;
      const classification = one(item, 'CommodityClassification');
      const code = classification && one(classification, 'ItemClassificationCode', cbc);
      const linePeriod = one(node, 'InvoicePeriod');
      return defined({
        id: text(node, 'ID')!,
        name: text(item, 'Name')!,
        description: text(item, 'Description'),
        note: text(node, 'Note'),
        quantity: canonicalDecimal(quantity.text.trim()),
        unitCode: quantity.attributes.unitCode!,
        price: canonicalDecimal(one(price, 'PriceAmount', cbc)!.text.trim()),
        baseQuantity: optionalDecimal(text(price, 'BaseQuantity')),
        vat: vat(one(item, 'ClassifiedTaxCategory')!),
        adjustments: all(node, 'AllowanceCharge').map((entry) => adjustment(entry, money)),
        period: linePeriod && periodOf(linePeriod),
        classification: code && { code: code.text.trim(), scheme: code.attributes.listID ?? '' },
        netAmount: money(node, 'LineExtensionAmount')!,
      });
    }),
    vatBreakdown: all(documentTax, 'TaxSubtotal').map((node): VatBreakdown => ({
      ...vat(one(node, 'TaxCategory')!),
      taxable: money(node, 'TaxableAmount')!,
      tax: money(node, 'TaxAmount')!,
    })),
    totals: {
      lines: money(monetary, 'LineExtensionAmount')!,
      allowances: money(monetary, 'AllowanceTotalAmount') ?? zero,
      charges: money(monetary, 'ChargeTotalAmount') ?? zero,
      taxExclusive: money(monetary, 'TaxExclusiveAmount')!,
      tax: money(documentTax, 'TaxAmount')!,
      taxInclusive: money(monetary, 'TaxInclusiveAmount')!,
      prepaid: money(monetary, 'PrepaidAmount') ?? zero,
      rounding: money(monetary, 'PayableRoundingAmount') ?? zero,
      payable: money(monetary, 'PayableAmount')!,
    },
  });
}

/** Differences between an invoice's stated amounts and its recalculation from quantities,
 * prices and adjustments: empty when every BT-106–BT-131 amount agrees. */
export function verifyInvoice(invoice: Invoice): string[] {
  const {
    customization: _customization,
    vatBreakdown,
    totals,
    lines,
    adjustments,
    ...header
  } = invoice;
  const recalculated = calculateInvoice({
    ...header,
    prepaid: totals.prepaid,
    rounding: totals.rounding,
    adjustments: adjustments.map(({ amount, percent, base: _base, ...item }) =>
      defined({ ...item, ...(percent === undefined ? { amount } : { percent }) }),
    ),
    lines: lines.map(({ id: _id, netAmount: _net, adjustments: items, vat: lineVat, ...line }) => ({
      ...line,
      vat: { ...lineVat, ...exemptionOf(vatBreakdown, lineVat) },
      adjustments: items.map(({ amount, percent, base: _base, ...item }) =>
        defined({ ...item, ...(percent === undefined ? { amount } : { percent }) }),
      ),
    })),
  });
  const differences: string[] = [];
  const compare = (label: string, stated: string | undefined, computed: string | undefined) => {
    if (stated !== computed) differences.push(`${label}: ${stated ?? '—'} ≠ ${computed ?? '—'}`);
  };
  lines.forEach((line, index) =>
    compare(`linia ${line.id}`, line.netAmount, recalculated.lines[index]?.netAmount),
  );
  for (const key of Object.keys(totals) as (keyof Invoice['totals'])[])
    compare(`total ${key}`, totals[key], recalculated.totals[key]);
  const breakdown = (items: VatBreakdown[]) =>
    new Map(items.map((item) => [`${item.category}|${item.rate ?? ''}`, item]));
  const computedBreakdown = breakdown(recalculated.vatBreakdown);
  for (const [key, item] of breakdown(vatBreakdown)) {
    compare(`TVA ${key} bază`, item.taxable, computedBreakdown.get(key)?.taxable);
    compare(`TVA ${key}`, item.tax, computedBreakdown.get(key)?.tax);
  }
  return differences;
}

function exemptionOf(breakdown: VatBreakdown[], vat: Vat) {
  const match = breakdown.find((item) => item.category === vat.category && item.rate === vat.rate);
  return defined({ exemptionReason: match?.exemptionReason, exemptionCode: match?.exemptionCode });
}

function all(node: XmlElement, local: string, uri: string = cac) {
  return node.children.filter((child) => child.local === local && child.uri === uri);
}

function one(node: XmlElement, local: string, uri: string = cac): XmlElement | undefined {
  const matches = all(node, local, uri);
  requireCondition(matches.length <= 1, 'EINVOICE_REPEATED', `Câmp repetat: ${local}.`);
  return matches[0];
}

function text(node: XmlElement, local: string): string | undefined {
  const found = one(node, local, cbc);
  if (!found) return undefined;
  requireCondition(
    found.children.length === 0,
    'EINVOICE_FIELD',
    `Câmp compus neașteptat: ${local}.`,
  );
  return found.text.trim();
}

function optionalPath(node: XmlElement, path: string[], local: string) {
  let current: XmlElement | undefined = node;
  for (const step of path) current = current && one(current, step);
  return current && text(current, local);
}

function date(value: string) {
  return value as Invoice['issueDate'];
}
function optionalDate(value: string | undefined) {
  return value === undefined ? undefined : date(value);
}
function optionalDecimal(value: string | undefined) {
  return value === undefined ? undefined : canonicalDecimal(value);
}

function periodOf(node: XmlElement) {
  const start = optionalDate(text(node, 'StartDate'));
  const end = optionalDate(text(node, 'EndDate'));
  return start || end ? defined({ start, end }) : undefined;
}

function vat(node: XmlElement): Vat {
  const category = text(node, 'ID');
  requireCondition(
    vatCategories.includes(category as never),
    'EINVOICE_VAT_CATEGORY',
    `Categoria de TVA ${category} nu este recunoscută.`,
  );
  return defined({
    category: category as Vat['category'],
    rate: optionalDecimal(text(node, 'Percent')),
    exemptionCode: text(node, 'TaxExemptionReasonCode'),
    exemptionReason: text(node, 'TaxExemptionReason'),
  });
}

function adjustment(
  node: XmlElement,
  money: (node: XmlElement, local: string) => string | undefined,
): Adjustment {
  return defined({
    charge: text(node, 'ChargeIndicator') === 'true',
    reasonCode: text(node, 'AllowanceChargeReasonCode'),
    reason: text(node, 'AllowanceChargeReason'),
    percent: optionalDecimal(text(node, 'MultiplierFactorNumeric')),
    amount: money(node, 'Amount')!,
    base: money(node, 'BaseAmount'),
  });
}

function party(node: XmlElement): Party {
  const address = one(node, 'PostalAddress')!;
  const schemes = all(node, 'PartyTaxScheme');
  const vatScheme = schemes.find((scheme) => optionalPath(scheme, ['TaxScheme'], 'ID') === 'VAT');
  const otherScheme = schemes.find((scheme) => scheme !== vatScheme);
  const legal = one(node, 'PartyLegalEntity');
  const contact = one(node, 'Contact');
  const extra = optionalPath(address, ['AddressLine'], 'Line');
  return defined({
    name: legal ? text(legal, 'RegistrationName')! : optionalPath(node, ['PartyName'], 'Name')!,
    tradingName: legal ? optionalPath(node, ['PartyName'], 'Name') : undefined,
    identifier: optionalPath(node, ['PartyIdentification'], 'ID'),
    legalId: legal && text(legal, 'CompanyID'),
    vatId: vatScheme && text(vatScheme, 'CompanyID'),
    taxRegistrationId: otherScheme && text(otherScheme, 'CompanyID'),
    legalForm: legal && text(legal, 'CompanyLegalForm'),
    address: defined({
      lines: [text(address, 'StreetName'), text(address, 'AdditionalStreetName'), extra].filter(
        (value): value is string => value !== undefined,
      ),
      city: text(address, 'CityName')!,
      postalCode: text(address, 'PostalZone'),
      subdivision: text(address, 'CountrySubentity'),
      country: optionalPath(address, ['Country'], 'IdentificationCode')!,
    }),
    contact:
      contact &&
      defined({
        name: text(contact, 'Name'),
        phone: text(contact, 'Telephone'),
        email: text(contact, 'ElectronicMail'),
      }),
  });
}
