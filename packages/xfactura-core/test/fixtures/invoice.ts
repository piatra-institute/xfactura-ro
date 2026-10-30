export type XmlInput = {
  direction?: 'purchase' | 'sale';
  date?: string;
  taxPointDate?: string;
  /** BT-72 and BG-14. */
  deliveryDate?: string;
  period?: { start: string; end: string };
  category?: string;
  rate?: string;
  tax?: string;
  gross?: string;
  net?: string;
  originalNumber?: string;
  number?: string;
  currency?: string;
  credit?: boolean;
  country?: string;
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
  const supplierId = input.direction === 'sale' ? '12345678' : '87654321';
  const customerId = input.direction === 'sale' ? '87654321' : '12345678';
  const party = (role: string, id: string, country = 'RO') =>
    `<cac:${role}><cac:Party><cac:PartyName><cbc:Name>Companie ${id}</cbc:Name></cac:PartyName><cac:PostalAddress><cac:Country><cbc:IdentificationCode>${country}</cbc:IdentificationCode></cac:Country></cac:PostalAddress><cac:PartyLegalEntity><cbc:RegistrationName>Companie ${id}</cbc:RegistrationName><cbc:CompanyID>${id}</cbc:CompanyID></cac:PartyLegalEntity></cac:Party></cac:${role}>`;
  const root = input.credit ? 'CreditNote' : 'Invoice';
  const line = input.credit ? 'CreditNoteLine' : 'InvoiceLine';
  return `<?xml version="1.0" encoding="UTF-8"?>
<${root} xmlns="urn:oasis:names:specification:ubl:schema:xsd:${root}-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
<cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:efactura.mfinante.ro:CIUS-RO:1.0.1</cbc:CustomizationID>
<cbc:ID>${input.number ?? 'INV-1'}</cbc:ID><cbc:IssueDate>${date}</cbc:IssueDate><cbc:${input.credit ? 'CreditNoteTypeCode' : 'InvoiceTypeCode'}>${input.credit ? '381' : '380'}</cbc:${input.credit ? 'CreditNoteTypeCode' : 'InvoiceTypeCode'}><cbc:DocumentCurrencyCode>${currency}</cbc:DocumentCurrencyCode>
${input.taxPointDate ? `<cbc:TaxPointDate>${input.taxPointDate}</cbc:TaxPointDate>` : ''}
${input.period ? `<cac:InvoicePeriod><cbc:StartDate>${input.period.start}</cbc:StartDate><cbc:EndDate>${input.period.end}</cbc:EndDate></cac:InvoicePeriod>` : ''}
${input.credit ? `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${input.originalNumber ?? 'INV-ORIGINAL'}</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>` : ''}
${party('AccountingSupplierParty', supplierId, input.country)}${party('AccountingCustomerParty', customerId)}
${input.deliveryDate ? `<cac:Delivery><cbc:ActualDeliveryDate>${input.deliveryDate}</cbc:ActualDeliveryDate></cac:Delivery>` : ''}
<cac:TaxTotal><cbc:TaxAmount currencyID="${currency}">${tax}</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxableAmount currencyID="${currency}">${net}</cbc:TaxableAmount><cbc:TaxAmount currencyID="${currency}">${tax}</cbc:TaxAmount><cac:TaxCategory><cbc:ID>${category}</cbc:ID>${category === 'O' ? '<cbc:TaxExemptionReasonCode>VATEX-EU-O</cbc:TaxExemptionReasonCode>' : `<cbc:Percent>${rate}</cbc:Percent>`}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>
<cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="${currency}">${net}</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="${currency}">${net}</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="${currency}">${gross}</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="${currency}">${gross}</cbc:PayableAmount></cac:LegalMonetaryTotal>
<cac:${line}><cbc:ID>1</cbc:ID><cbc:${input.credit ? 'CreditedQuantity' : 'InvoicedQuantity'} unitCode="HUR">1</cbc:${input.credit ? 'CreditedQuantity' : 'InvoicedQuantity'}><cbc:LineExtensionAmount currencyID="${currency}">${net}</cbc:LineExtensionAmount><cac:Item><cbc:Name>Servicii documentate</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>${category}</cbc:ID>${category === 'O' ? '' : `<cbc:Percent>${rate}</cbc:Percent>`}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item><cac:Price><cbc:PriceAmount currencyID="${currency}">${net}</cbc:PriceAmount></cac:Price></cac:${line}>
</${root}>`;
}
