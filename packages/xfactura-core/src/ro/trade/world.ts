import type { Loaded, ProfileFact } from '../../kernel';
import { invoiceDocumentSchema, type InvoiceDocument } from '../../ubl/invoice-document';
import { emptyLoaded } from '../reviews/specs/world';
import { invoiceKinds } from '../treatments/invoices';
import {
  customsDeclarationSchema,
  customsDocumentKind,
  viesCheckSchema,
  viesDocumentKind,
  type CustomsDeclaration,
} from './documents';

/*
 * Small, fixed worlds of goods across the border, for the review specs' cases and the core tests:
 * a Romanian VAT payer (CUI 18547290, monthly), an invoice with its partner, a VIES answer, a
 * customs declaration, the BNR's euro and dollar rates. Nothing here computes a tax.
 */

export const TRADE_IDS = {
  invoice: '00000000-0000-4000-8000-0000000000b1',
  vies: '00000000-0000-4000-8000-0000000000b2',
  declaration: '00000000-0000-4000-8000-0000000000b3',
  partner: '00000000-0000-4000-8000-0000000000b4',
  customs: '00000000-0000-4000-8000-0000000000b5',
  cmr: '00000000-0000-4000-8000-0000000000b6',
  carrier: '00000000-0000-4000-8000-0000000000b7',
  certificate: '00000000-0000-4000-8000-0000000000b8',
} as const;
export const COMPANY_CUI = '18547290';

const fact = (axis: string, value: string, from: string): ProfileFact =>
  ({ axis, value, effectiveFrom: from }) as ProfileFact;
export const payerFacts: ProfileFact[] = [
  fact('vat.status', 'normal_vat', '2020-01-01'),
  fact('vat.period', 'monthly', '2026-01-01'),
];

/** An invoice of goods across the border, one line per amount, without VAT. */
export function goodsInvoice(options: {
  direction: 'sale' | 'purchase';
  number: string;
  issueDate: string;
  deliveryDate?: string;
  currency: string;
  category: 'K' | 'G' | 'O';
  reason?: string;
  partner: { name: string; taxId: string; country: string };
  lines: string[];
}): InvoiceDocument {
  const net = options.lines.reduce((sum, line) => sum + Number(line), 0).toFixed(2);
  const company = { name: 'Exemplu Comerț SRL', taxId: `RO${COMPANY_CUI}`, country: 'RO' };
  return invoiceDocumentSchema.parse({
    parserVersion: 'ubl-invoice-4',
    documentType: 'invoice',
    number: options.number,
    issueDate: options.issueDate,
    taxPointDate: null,
    ...(options.deliveryDate ? { deliveryDate: options.deliveryDate } : {}),
    currency: options.currency,
    supplier: options.direction === 'sale' ? company : options.partner,
    customer: options.direction === 'sale' ? options.partner : company,
    originalInvoiceNumber: null,
    customizationId: 'urn:cen.eu:en16931:2017',
    lines: options.lines.map((line, index) => ({
      id: String(index + 1),
      description: `Marfă ${index + 1}`,
      net: line,
      vatCategory: options.category,
      vatRate: options.category === 'O' ? null : '0',
    })),
    taxes: [
      {
        base: net,
        tax: '0.00',
        category: options.category,
        rate: options.category === 'O' ? null : '0',
        exemptionReason: options.reason ?? null,
      },
    ],
    totals: {
      lineNet: net,
      net,
      tax: '0.00',
      gross: net,
      allowances: '0.00',
      charges: '0.00',
      prepaid: '0.00',
      rounding: '0.00',
      payable: net,
    },
  });
}

/** A world holding the invoice, the company's facts, the BNR's rates and the authority. */
export function tradeLoaded(
  invoice: InvoiceDocument,
  direction: 'sale' | 'purchase',
  extra: { facts?: ProfileFact[]; rates?: { currency: string; date: string; rate: string }[] } = {},
): Loaded {
  const loaded = emptyLoaded([...payerFacts, ...(extra.facts ?? [])]);
  (loaded.documents as Map<string, unknown>).set(TRADE_IDS.invoice, {
    id: TRADE_IDS.invoice,
    kind: direction === 'sale' ? invoiceKinds.sale : invoiceKinds.purchase,
    schema: 'invoice',
    body: invoice,
    bodyHash: 'example',
    docDate: invoice.issueDate,
    partyId: TRADE_IDS.partner,
    currency: invoice.currency,
    number: invoice.number,
    evidenceId: null,
  });
  (loaded.parties as Map<string, unknown>).set(TRADE_IDS.customs, {
    id: TRADE_IDS.customs,
    kind: 'ro_public_institution',
    country: 'RO',
    taxId: '4267117',
    name: 'Autoritatea vamală',
  });
  for (const id of [TRADE_IDS.cmr, TRADE_IDS.carrier, TRADE_IDS.certificate])
    (loaded.evidence as Map<string, unknown>).set(id, {
      id,
      hash: id,
      filename: `${id}.pdf`,
      mediaType: 'application/pdf',
    });
  const rates = new Map<string, unknown[]>();
  for (const rate of extra.rates ?? []) {
    const list = rates.get(rate.currency) ?? [];
    list.push({
      id: `bnr-${rate.currency}-${rate.date}`,
      source: 'BNR',
      currency: rate.currency,
      date: rate.date,
      rate: rate.rate,
      multiplier: 1,
    });
    rates.set(rate.currency, list);
  }
  for (const [currency, list] of rates)
    (loaded.fxRates as Map<string, unknown>).set(
      currency,
      (list as { date: string }[]).sort((a, b) => b.date.localeCompare(a.date)),
    );
  return loaded;
}

/** Adds a VIES answer about `code` on `requestDate`. */
export function withVies(loaded: Loaded, code: string, requestDate: string, valid = true) {
  (loaded.documents as Map<string, unknown>).set(TRADE_IDS.vies, {
    id: TRADE_IDS.vies,
    kind: viesDocumentKind,
    schema: 'vies-check-1',
    body: viesCheckSchema.parse({
      parserVersion: 'vies-check-1',
      countryCode: code.slice(0, 2),
      vatNumber: code.slice(2),
      requestDate,
      valid,
      name: 'Partner GmbH',
      address: 'Berlin',
      requestIdentifier: 'WAPIAAAAX1',
      source: 'vies_api',
    }),
    bodyHash: 'vies',
    docDate: requestDate,
    partyId: null,
    currency: null,
    number: code,
    evidenceId: null,
  });
  return loaded;
}

/** Adds a customs declaration. */
export function withDeclaration(
  loaded: Loaded,
  declaration: Omit<CustomsDeclaration, 'parserVersion'>,
) {
  (loaded.documents as Map<string, unknown>).set(TRADE_IDS.declaration, {
    id: TRADE_IDS.declaration,
    kind: customsDocumentKind,
    schema: 'customs-declaration-1',
    body: customsDeclarationSchema.parse({
      parserVersion: 'customs-declaration-1',
      ...declaration,
    }),
    bodyHash: 'dvi',
    docDate: declaration.acceptedOn,
    partyId: null,
    currency: null,
    number: declaration.mrn,
    evidenceId: null,
  });
  return loaded;
}

/** Two documents of the transport from independent issuers: a CMR and the carrier's invoice. */
export const presumedTransport = (destination: string, date: string) => ({
  by: 'seller' as const,
  documents: [
    {
      kind: 'cmr' as const,
      evidenceId: TRADE_IDS.cmr,
      issuer: 'Transport Rapid SRL',
      independent: true,
      destination,
      date,
    },
    {
      kind: 'insurance' as const,
      evidenceId: TRADE_IDS.carrier,
      issuer: 'Asigurări Generale SA',
      independent: true,
      destination,
      date,
    },
  ],
});
