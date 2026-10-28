import { invoiceXml, type XmlInput } from './invoice';

// Independent synthetic XML: callers supply every amount, including VAT and residual totals.
export function finalInvoiceXml(
  input: XmlInput & {
    serviceNet: string;
    advances: Array<{ number: string; date?: string; lineId: string; net: string }>;
  },
) {
  const category = input.category ?? 'S',
    rate = input.rate ?? '21';
  const line = (id: string, net: string) =>
    `<cac:InvoiceLine><cbc:ID>${id}</cbc:ID><cbc:InvoicedQuantity unitCode="HUR">${net.startsWith('-') ? '-1' : '1'}</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="RON">${net}</cbc:LineExtensionAmount><cac:Item><cbc:Name>Servicii / regularizare documentată</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>${category}</cbc:ID>${category === 'O' ? '' : `<cbc:Percent>${rate}</cbc:Percent>`}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item><cac:Price><cbc:PriceAmount currencyID="RON">${net.replace('-', '')}</cbc:PriceAmount></cac:Price></cac:InvoiceLine>`;
  const references = input.advances
    .map(
      (row) =>
        `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${row.number}</cbc:ID>${row.date ? `<cbc:IssueDate>${row.date}</cbc:IssueDate>` : ''}</cac:InvoiceDocumentReference></cac:BillingReference>`,
    )
    .join('');
  return invoiceXml(input)
    .replace('<cac:LegalMonetaryTotal>', `${references}<cac:LegalMonetaryTotal>`)
    .replace(
      /<cac:InvoiceLine>[\s\S]*?<\/cac:InvoiceLine>/,
      line('SERVICE', input.serviceNet) +
        input.advances.map((row) => line(row.lineId, `-${row.net}`)).join(''),
    );
}
