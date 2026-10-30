import type { InvoiceDraft } from 'xfactura-core/einvoice';
import { camt, camtEntry, iban } from '../../../xfactura-api/test/engine/fixtures/bank';

/*
 * Builders for world files. Every party, number and amount in the worlds is synthetic; amounts
 * are worked by hand in each world's comments, never by the engine.
 */

export { iban };

type Address = { lines: string[]; city: string; subdivision?: string; country: string };
const addresses: Record<'B' | 'CJ', Address> = {
  B: { lines: ['Str. Exemplu nr. 1'], city: 'București', subdivision: 'RO-B', country: 'RO' },
  CJ: { lines: ['Str. Exemplu nr. 2'], city: 'Cluj-Napoca', subdivision: 'RO-CJ', country: 'RO' },
};

export type Trader = {
  name: string;
  /** A Romanian CUI (digits) or a foreign VAT id with its country prefix. */
  id: string;
  /** Registered for VAT: the id is printed with RO. */
  vat: boolean;
  country?: string;
  county?: keyof typeof addresses;
};

function party(trader: Trader) {
  const country = trader.country ?? 'RO';
  const address: Address =
    country === 'RO'
      ? addresses[trader.county ?? 'B']
      : { lines: ['1 Example Street'], city: 'Example City', country };
  if (country !== 'RO') return { name: trader.name, vatId: trader.id, address };
  return trader.vat
    ? { name: trader.name, vatId: `RO${trader.id}`, legalId: trader.id, address }
    : { name: trader.name, legalId: trader.id, address };
}

type VatLine = { category: 'S'; rate: string } | { category: 'O' | 'E' | 'AE'; reason: string };

/** An e-Factura invoice with one line per entry of `lines`. */
export function ubl(input: {
  number: string;
  date: string;
  seller: Trader;
  buyer: Trader;
  currency?: string;
  lines: { name: string; price: string; vat: VatLine }[];
  notes?: string[];
}): InvoiceDraft {
  return {
    typeCode: '380',
    number: input.number,
    issueDate: input.date,
    currency: input.currency ?? 'RON',
    notes: input.notes ?? [],
    seller: party(input.seller),
    buyer: party(input.buyer),
    lines: input.lines.map((line) => ({
      name: line.name,
      quantity: '1',
      unitCode: 'C62',
      price: line.price,
      vat:
        line.vat.category === 'S'
          ? { category: 'S', rate: line.vat.rate }
          : line.vat.category === 'O'
            ? { category: 'O', exemptionCode: 'VATEX-EU-O' }
            : line.vat.category === 'AE'
              ? { category: 'AE', rate: '0', exemptionCode: 'VATEX-EU-AE' }
              : { category: 'E', exemptionReason: line.vat.reason },
    })),
  };
}

/** A camt.053 statement of the fixture account, its entries as the bank reports them. */
export function camtStatement(input: {
  id: string;
  from: string;
  to: string;
  opening: string;
  closing: string;
  entries: { date: string; amount: string; credit?: boolean; text: string; ref: string }[];
}) {
  return camt({
    id: input.id,
    from: input.from,
    to: input.to,
    opening: input.opening,
    closing: input.closing,
    entries: input.entries
      .map((entry) =>
        camtEntry({
          amount: entry.amount,
          date: entry.date,
          value: entry.date,
          direction: entry.credit ? 'CRDT' : 'DBIT',
          text: entry.text,
          bankRef: entry.ref,
        }),
      )
      .join(''),
  });
}

/** BNR's reference rates file for the given days. */
export function bnrXml(rates: { date: string; currency: string; rate: string }[]) {
  const days = [...new Set(rates.map((rate) => rate.date))].sort();
  return `<?xml version="1.0" encoding="utf-8"?>
<DataSet xmlns="http://www.bnr.ro/xsd"><Header><Publisher>National Bank of Romania</Publisher><PublishingDate>${days.at(-1)}</PublishingDate><MessageType>DR</MessageType></Header>
<Body><Subject>Reference rates</Subject><OrigCurrency>RON</OrigCurrency>
${days
  .map(
    (day) =>
      `<Cube date="${day}">${rates
        .filter((rate) => rate.date === day)
        .map((rate) => `<Rate currency="${rate.currency}">${rate.rate}</Rate>`)
        .join('')}</Cube>`,
  )
  .join('\n')}
</Body></DataSet>`;
}
