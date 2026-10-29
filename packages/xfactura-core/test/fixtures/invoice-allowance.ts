import { invoiceXml, type XmlInput } from './invoice';

// Independent synthetic amounts: no production parsing, tax or discount calculator is used.
export function allowanceInvoiceXml(
  input: XmlInput & {
    lineNet?: string;
    allowance?: string;
    adjustments?: string;
  } = {},
) {
  const currency = input.currency ?? 'RON',
    category = input.category ?? 'S',
    rate = input.rate ?? '21',
    lineNet = input.lineNet ?? '100.00',
    allowance = input.allowance ?? '20.00',
    net = input.net ?? '80.00',
    adjustments =
      input.adjustments ??
      `<cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:AllowanceChargeReasonCode>95</cbc:AllowanceChargeReasonCode><cbc:AllowanceChargeReason>Reducere comercială la facturare</cbc:AllowanceChargeReason><cbc:MultiplierFactorNumeric>20</cbc:MultiplierFactorNumeric><cbc:Amount currencyID="${currency}">${allowance}</cbc:Amount><cbc:BaseAmount currencyID="${currency}">${lineNet}</cbc:BaseAmount><cac:TaxCategory><cbc:ID>${category}</cbc:ID>${category === 'O' ? '' : `<cbc:Percent>${rate}</cbc:Percent>`}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:AllowanceCharge>`;
  return invoiceXml({ net, tax: '16.80', gross: '96.80', ...input })
    .replaceAll(
      `<cbc:LineExtensionAmount currencyID="${currency}">${net}</cbc:LineExtensionAmount>`,
      `<cbc:LineExtensionAmount currencyID="${currency}">${lineNet}</cbc:LineExtensionAmount>`,
    )
    .replace(
      `<cbc:PriceAmount currencyID="${currency}">${net}</cbc:PriceAmount>`,
      `<cbc:PriceAmount currencyID="${currency}">${lineNet}</cbc:PriceAmount>`,
    )
    .replace('<cac:TaxTotal>', `${adjustments}<cac:TaxTotal>`)
    .replace(
      '<cac:LegalMonetaryTotal>',
      `<cac:LegalMonetaryTotal><cbc:AllowanceTotalAmount currencyID="${currency}">${allowance}</cbc:AllowanceTotalAmount>`,
    );
}
