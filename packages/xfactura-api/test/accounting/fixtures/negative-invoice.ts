import { invoiceXml, type XmlInput } from './invoice';

// Independent signed XML inputs; no production parser or calculation is used.
export function negativeInvoiceXml(input: XmlInput & { originalDate?: string } = {}) {
  return invoiceXml({
    date: '2026-11-01',
    net: '20.00',
    tax: '4.20',
    gross: '24.20',
    ...input,
    credit: true,
  })
    .replaceAll('CreditNote', 'Invoice')
    .replace('InvoiceTypeCode>381<', 'InvoiceTypeCode>380<')
    .replaceAll('CreditedQuantity', 'InvoicedQuantity')
    .replace('InvoicedQuantity unitCode="HUR">1<', 'InvoicedQuantity unitCode="HUR">-1<')
    .replace(
      '</cbc:ID></cac:InvoiceDocumentReference>',
      `</cbc:ID><cbc:IssueDate>${input.originalDate ?? '2026-10-01'}</cbc:IssueDate></cac:InvoiceDocumentReference>`,
    )
    .replace(
      /(<cbc:(?:LineExtensionAmount|TaxExclusiveAmount|TaxInclusiveAmount|TaxableAmount|TaxAmount|PayableAmount)\b[^>]*>)([0-9.]+)(<\/cbc:[^>]+>)/g,
      (_match, open, value, close) =>
        `${open}${/^0(?:\.0+)?$/.test(value) ? '0.00' : `-${value}`}${close}`,
    );
}
