import { invoiceXml, type XmlInput } from './invoice';

// All amounts are independent fixture inputs, never calculated by production code.
export function chargeInvoiceXml(
  input: XmlInput & {
    lineNet?: string;
    allowance?: string;
    charge?: string;
    adjustments?: string;
  } = {},
) {
  const currency = input.currency ?? 'RON',
    category = input.category ?? 'S',
    rate = input.rate ?? '21',
    lineNet = input.lineNet ?? '100.00',
    allowance = input.allowance ?? '0.00',
    charge = input.charge ?? '10.00',
    net = input.net ?? '110.00';
  const entry = (isCharge: boolean, amount: string, reason: string, reasonCode: string) =>
    `<cac:AllowanceCharge><cbc:ChargeIndicator>${isCharge}</cbc:ChargeIndicator><cbc:AllowanceChargeReasonCode>${reasonCode}</cbc:AllowanceChargeReasonCode><cbc:AllowanceChargeReason>${reason}</cbc:AllowanceChargeReason><cbc:Amount currencyID="${currency}">${amount}</cbc:Amount><cac:TaxCategory><cbc:ID>${category}</cbc:ID>${category === 'O' ? '' : `<cbc:Percent>${rate}</cbc:Percent>`}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:AllowanceCharge>`;
  const adjustments =
    input.adjustments ??
    (allowance === '0.00'
      ? ''
      : entry(false, allowance, 'Reducere comercială la facturare', '95')) +
      entry(true, charge, 'Configurare suplimentară a serviciului', 'AAH');
  return invoiceXml({ net, tax: '23.10', gross: '133.10', ...input })
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
      `<cac:LegalMonetaryTotal><cbc:AllowanceTotalAmount currencyID="${currency}">${allowance}</cbc:AllowanceTotalAmount><cbc:ChargeTotalAmount currencyID="${currency}">${charge}</cbc:ChargeTotalAmount>`,
    );
}
