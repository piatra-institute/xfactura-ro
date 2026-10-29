import { DomainError } from '../errors';
import { element, leaf, serializeXml, type XmlChild } from '../xml/write';
import type { Adjustment, Invoice, Line, Party, Vat } from './model';

export const ublNamespaces = {
  invoice: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  creditNote: 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2',
  cac: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
  cbc: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
} as const;

/**
 * Writes a calculated invoice as UBL 2.1 in the element order of the OASIS schemas. The output
 * is canonical: the same invoice always gives the same bytes. Amounts carry two decimals;
 * quantities, prices and rates are written as the model holds them.
 */
export function writeInvoice(invoice: Invoice): string {
  const credit = invoice.typeCode === '381';
  if (credit && invoice.dueDate && !invoice.payment)
    throw new DomainError(
      'EINVOICE_DUE_DATE',
      'Pe o notă de credit, scadența se transmite cu instrucțiunile de plată.',
    );
  const amount = (name: string, value: string | undefined, currency = invoice.currency) =>
    leaf(`cbc:${name}`, value, { currencyID: currency });
  const nonzero = (name: string, value: string, present: boolean) =>
    present ? amount(name, value) : undefined;
  const adjustments = invoice.adjustments.map((item) => adjustment(item, amount));
  const hasAllowances = invoice.adjustments.some((item) => !item.charge);
  const hasCharges = invoice.adjustments.some((item) => item.charge);
  const { totals, payment } = invoice;
  const foreignVat = invoice.vatCurrency && invoice.vatCurrency !== invoice.currency;

  const root = element(
    credit ? 'CreditNote' : 'Invoice',
    {
      xmlns: credit ? ublNamespaces.creditNote : ublNamespaces.invoice,
      'xmlns:cac': ublNamespaces.cac,
      'xmlns:cbc': ublNamespaces.cbc,
    },
    leaf('cbc:CustomizationID', invoice.customization),
    leaf('cbc:ID', invoice.number),
    leaf('cbc:IssueDate', invoice.issueDate),
    !credit && leaf('cbc:DueDate', invoice.dueDate),
    credit && leaf('cbc:TaxPointDate', invoice.taxPointDate),
    leaf(credit ? 'cbc:CreditNoteTypeCode' : 'cbc:InvoiceTypeCode', invoice.typeCode),
    invoice.notes.map((note) => leaf('cbc:Note', note)),
    !credit && leaf('cbc:TaxPointDate', invoice.taxPointDate),
    leaf('cbc:DocumentCurrencyCode', invoice.currency),
    leaf('cbc:TaxCurrencyCode', invoice.vatCurrency),
    leaf('cbc:BuyerReference', invoice.buyerReference),
    (invoice.invoicingPeriod || invoice.taxPointCode) &&
      element(
        'cac:InvoicePeriod',
        null,
        leaf('cbc:StartDate', invoice.invoicingPeriod?.start),
        leaf('cbc:EndDate', invoice.invoicingPeriod?.end),
        leaf('cbc:DescriptionCode', invoice.taxPointCode),
      ),
    invoice.orderReference &&
      element('cac:OrderReference', null, leaf('cbc:ID', invoice.orderReference)),
    invoice.precedingInvoices.map((preceding) =>
      element(
        'cac:BillingReference',
        null,
        element(
          'cac:InvoiceDocumentReference',
          null,
          leaf('cbc:ID', preceding.number),
          leaf('cbc:IssueDate', preceding.issueDate),
        ),
      ),
    ),
    invoice.contractReference &&
      element('cac:ContractDocumentReference', null, leaf('cbc:ID', invoice.contractReference)),
    element('cac:AccountingSupplierParty', null, party(invoice.seller, true)),
    element('cac:AccountingCustomerParty', null, party(invoice.buyer, false)),
    invoice.deliveryDate &&
      element('cac:Delivery', null, leaf('cbc:ActualDeliveryDate', invoice.deliveryDate)),
    payment &&
      (payment.accounts.length ? payment.accounts : [undefined]).map((account) =>
        element(
          'cac:PaymentMeans',
          null,
          leaf('cbc:PaymentMeansCode', payment.meansCode),
          credit && leaf('cbc:PaymentDueDate', invoice.dueDate),
          leaf('cbc:PaymentID', payment.reference),
          account &&
            element(
              'cac:PayeeFinancialAccount',
              null,
              leaf('cbc:ID', account.id),
              leaf('cbc:Name', account.name),
              account.bank &&
                element('cac:FinancialInstitutionBranch', null, leaf('cbc:ID', account.bank)),
            ),
        ),
      ),
    payment?.terms && element('cac:PaymentTerms', null, leaf('cbc:Note', payment.terms)),
    adjustments,
    element(
      'cac:TaxTotal',
      null,
      amount('TaxAmount', totals.tax),
      invoice.vatBreakdown.map((item) =>
        element(
          'cac:TaxSubtotal',
          null,
          amount('TaxableAmount', item.taxable),
          amount('TaxAmount', item.tax),
          category('cac:TaxCategory', item),
        ),
      ),
    ),
    foreignVat &&
      element(
        'cac:TaxTotal',
        null,
        amount('TaxAmount', invoice.vatAccountingTotal, invoice.vatCurrency),
      ),
    element(
      'cac:LegalMonetaryTotal',
      null,
      amount('LineExtensionAmount', totals.lines),
      amount('TaxExclusiveAmount', totals.taxExclusive),
      amount('TaxInclusiveAmount', totals.taxInclusive),
      nonzero('AllowanceTotalAmount', totals.allowances, hasAllowances),
      nonzero('ChargeTotalAmount', totals.charges, hasCharges),
      nonzero('PrepaidAmount', totals.prepaid, totals.prepaid !== '0.00'),
      nonzero('PayableRoundingAmount', totals.rounding, totals.rounding !== '0.00'),
      amount('PayableAmount', totals.payable),
    ),
    invoice.lines.map((item) => line(item, credit, amount)),
  );
  return serializeXml(root);
}

type AmountLeaf = (name: string, value: string | undefined) => XmlChild;

function party(value: Party, seller: boolean) {
  const [street, additional, extra] = value.address.lines;
  return element(
    'cac:Party',
    null,
    value.identifier && element('cac:PartyIdentification', null, leaf('cbc:ID', value.identifier)),
    value.tradingName && element('cac:PartyName', null, leaf('cbc:Name', value.tradingName)),
    element(
      'cac:PostalAddress',
      null,
      leaf('cbc:StreetName', street),
      leaf('cbc:AdditionalStreetName', additional),
      leaf('cbc:CityName', value.address.city),
      leaf('cbc:PostalZone', value.address.postalCode),
      leaf('cbc:CountrySubentity', value.address.subdivision),
      extra && element('cac:AddressLine', null, leaf('cbc:Line', extra)),
      element('cac:Country', null, leaf('cbc:IdentificationCode', value.address.country)),
    ),
    value.vatId &&
      element(
        'cac:PartyTaxScheme',
        null,
        leaf('cbc:CompanyID', value.vatId),
        element('cac:TaxScheme', null, leaf('cbc:ID', 'VAT')),
      ),
    seller &&
      value.taxRegistrationId &&
      element(
        'cac:PartyTaxScheme',
        null,
        leaf('cbc:CompanyID', value.taxRegistrationId),
        element('cac:TaxScheme', null),
      ),
    element(
      'cac:PartyLegalEntity',
      null,
      leaf('cbc:RegistrationName', value.name),
      leaf('cbc:CompanyID', value.legalId),
      seller && leaf('cbc:CompanyLegalForm', value.legalForm),
    ),
    value.contact &&
      element(
        'cac:Contact',
        null,
        leaf('cbc:Name', value.contact.name),
        leaf('cbc:Telephone', value.contact.phone),
        leaf('cbc:ElectronicMail', value.contact.email),
      ),
  );
}

function category(
  name: string,
  vat: Pick<Vat, 'category' | 'rate' | 'exemptionCode' | 'exemptionReason'>,
) {
  return element(
    name,
    null,
    leaf('cbc:ID', vat.category),
    leaf('cbc:Percent', vat.rate),
    leaf('cbc:TaxExemptionReasonCode', vat.exemptionCode),
    leaf('cbc:TaxExemptionReason', vat.exemptionReason),
    element('cac:TaxScheme', null, leaf('cbc:ID', 'VAT')),
  );
}

function adjustment(item: Adjustment & { vat?: Vat }, amount: AmountLeaf) {
  return element(
    'cac:AllowanceCharge',
    null,
    leaf('cbc:ChargeIndicator', String(item.charge)),
    leaf('cbc:AllowanceChargeReasonCode', item.reasonCode),
    leaf('cbc:AllowanceChargeReason', item.reason),
    leaf('cbc:MultiplierFactorNumeric', item.percent),
    amount('Amount', item.amount),
    amount('BaseAmount', item.base),
    item.vat && category('cac:TaxCategory', { category: item.vat.category, rate: item.vat.rate }),
  );
}

function line(item: Line, credit: boolean, amount: AmountLeaf) {
  return element(
    credit ? 'cac:CreditNoteLine' : 'cac:InvoiceLine',
    null,
    leaf('cbc:ID', item.id),
    leaf('cbc:Note', item.note),
    leaf(credit ? 'cbc:CreditedQuantity' : 'cbc:InvoicedQuantity', item.quantity, {
      unitCode: item.unitCode,
    }),
    amount('LineExtensionAmount', item.netAmount),
    item.period &&
      element(
        'cac:InvoicePeriod',
        null,
        leaf('cbc:StartDate', item.period.start),
        leaf('cbc:EndDate', item.period.end),
      ),
    item.adjustments.map((entry) => adjustment(entry, amount)),
    element(
      'cac:Item',
      null,
      leaf('cbc:Description', item.description),
      leaf('cbc:Name', item.name),
      item.classification &&
        element(
          'cac:CommodityClassification',
          null,
          leaf('cbc:ItemClassificationCode', item.classification.code, {
            listID: item.classification.scheme,
          }),
        ),
      category('cac:ClassifiedTaxCategory', { category: item.vat.category, rate: item.vat.rate }),
    ),
    element(
      'cac:Price',
      null,
      amount('PriceAmount', item.price),
      leaf('cbc:BaseQuantity', item.baseQuantity, { unitCode: item.unitCode }),
    ),
  );
}
