export type XmlInput = {
  /** The company's CUI (default 12345678); the counterparty is 87654321. */
  company?: string;
  direction?: 'purchase' | 'sale';
  date?: string;
  taxPointDate?: string;
  /** BT-72, the date of the supply. */
  deliveryDate?: string;
  category?: string;
  rate?: string;
  tax?: string;
  gross?: string;
  net?: string;
  originalNumber?: string;
  number?: string;
  currency?: string;
  credit?: boolean;
  /** The counterparty's country (default RO) and fiscal code (default 87654321). */
  country?: string;
  counterparty?: string;
  /** Several standard-rated categories, one line each, instead of `rate` (the totals are still
   * `net`, `tax` and `gross`). */
  taxes?: { rate: string; net: string; tax: string }[];
  /** The lines, when they are not one per category (a final invoice's negative advance line). */
  lines?: { rate: string; net: string; name?: string }[];
  /** An invoice note (BT-22), e.g. the mention «TVA la încasare». */
  note?: string;
};
// Synthetic document bytes and all amounts are independent of the production calculator.
export function invoiceXml(input: XmlInput = {}) {
  const date = input.date ?? '2026-10-01',
    category = input.category ?? 'S',
    rate = input.rate ?? '21',
    tax = input.tax ?? '21.00',
    gross = input.gross ?? '121.00',
    net = input.net ?? '100.00',
    currency = input.currency ?? 'RON';
  const company = input.company ?? '12345678';
  const counterparty = input.counterparty ?? '87654321';
  const sale = input.direction === 'sale';
  const categories = input.taxes ?? [{ rate, net, tax }];
  const supplierId = sale ? company : counterparty;
  const customerId = sale ? counterparty : company;
  const party = (role: string, id: string, country = 'RO') =>
    `<cac:${role}><cac:Party><cac:PartyName><cbc:Name>Companie ${id}</cbc:Name></cac:PartyName><cac:PostalAddress><cac:Country><cbc:IdentificationCode>${country}</cbc:IdentificationCode></cac:Country></cac:PostalAddress><cac:PartyLegalEntity><cbc:RegistrationName>Companie ${id}</cbc:RegistrationName><cbc:CompanyID>${id}</cbc:CompanyID></cac:PartyLegalEntity></cac:Party></cac:${role}>`;
  const root = input.credit ? 'CreditNote' : 'Invoice';
  const line = input.credit ? 'CreditNoteLine' : 'InvoiceLine';
  return `<?xml version="1.0" encoding="UTF-8"?>
<${root} xmlns="urn:oasis:names:specification:ubl:schema:xsd:${root}-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
<cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:efactura.mfinante.ro:CIUS-RO:1.0.1</cbc:CustomizationID>
<cbc:ID>${input.number ?? 'INV-1'}</cbc:ID><cbc:IssueDate>${date}</cbc:IssueDate><cbc:${input.credit ? 'CreditNoteTypeCode' : 'InvoiceTypeCode'}>${input.credit ? '381' : '380'}</cbc:${input.credit ? 'CreditNoteTypeCode' : 'InvoiceTypeCode'}>${input.note ? `<cbc:Note>${input.note}</cbc:Note>` : ''}<cbc:DocumentCurrencyCode>${currency}</cbc:DocumentCurrencyCode>
${input.taxPointDate ? `<cbc:TaxPointDate>${input.taxPointDate}</cbc:TaxPointDate>` : ''}
${input.credit ? `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${input.originalNumber ?? 'INV-ORIGINAL'}</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>` : ''}
${party('AccountingSupplierParty', supplierId, sale ? 'RO' : input.country)}${party('AccountingCustomerParty', customerId, sale ? input.country : 'RO')}
${input.deliveryDate ? `<cac:Delivery><cbc:ActualDeliveryDate>${input.deliveryDate}</cbc:ActualDeliveryDate></cac:Delivery>` : ''}
<cac:TaxTotal><cbc:TaxAmount currencyID="${currency}">${tax}</cbc:TaxAmount>${categories.map((item) => `<cac:TaxSubtotal><cbc:TaxableAmount currencyID="${currency}">${item.net}</cbc:TaxableAmount><cbc:TaxAmount currencyID="${currency}">${item.tax}</cbc:TaxAmount><cac:TaxCategory><cbc:ID>${category}</cbc:ID>${category === 'O' ? '<cbc:TaxExemptionReasonCode>VATEX-EU-O</cbc:TaxExemptionReasonCode>' : `<cbc:Percent>${item.rate}</cbc:Percent>`}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>`).join('')}</cac:TaxTotal>
<cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="${currency}">${net}</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="${currency}">${net}</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="${currency}">${gross}</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="${currency}">${gross}</cbc:PayableAmount></cac:LegalMonetaryTotal>
${(input.lines ?? categories).map((item, index) => `<cac:${line}><cbc:ID>${index + 1}</cbc:ID><cbc:${input.credit ? 'CreditedQuantity' : 'InvoicedQuantity'} unitCode="HUR">${item.net.startsWith('-') ? '-1' : '1'}</cbc:${input.credit ? 'CreditedQuantity' : 'InvoicedQuantity'}><cbc:LineExtensionAmount currencyID="${currency}">${item.net}</cbc:LineExtensionAmount><cac:Item><cbc:Name>${'name' in item && item.name ? item.name : 'Servicii documentate'}</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>${category}</cbc:ID>${category === 'O' ? '' : `<cbc:Percent>${item.rate}</cbc:Percent>`}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item><cac:Price><cbc:PriceAmount currencyID="${currency}">${item.net.replace(/^-/, '')}</cbc:PriceAmount></cac:Price></cac:${line}>`).join('')}
</${root}>`;
}
