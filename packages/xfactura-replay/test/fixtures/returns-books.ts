import { createHash } from 'node:crypto';
import { writeD300, type D300 } from 'xfactura-core/ro/declarations/d300';
import { writeD394, type D394 } from 'xfactura-core/ro/declarations/d394';
import type { D406 } from 'xfactura-core/ro/saft/d406';
import type { CompanyFiling, CompanyReturnPayload } from '../../src/mapping/corpus';
import {
  companyCui,
  customer,
  euSupplier,
  line,
  marker,
  replayFilings,
  replayModel,
  replayModels,
  service,
  vat,
} from './replay-books';

// Invented amounts, none of which occurs in the private corpus.
const base = '617.00';
const tax = '129.57';
export const unreadSale = { base: '737.00', tax: '154.77', gross: '891.77' };
/** A VAT TaxCode outside ANAF's nomenclature, so that no engine reading will ever give it one:
 * the journal replay refuses its transaction (TAX_CODE_UNREAD). The writer refuses it, so it
 * replaces the standard rate's code in the read model, as SAGA's closing code is added. */
export const unreadCode = '319999';

/**
 * March of the synthetic company: a service bought from a supplier in another Member State under
 * reverse charge, which D300 declares and D394 does not list, and February's EU invoice paid. Its
 * opening is February's closing. With `unread`, a sale under a VAT code the replay cannot read,
 * which the journal replay refuses.
 */
export function marchModel(unread = false): D406 {
  const model = replayModel(
    3,
    {
      '1012': '-1000.00',
      '5121': '2300.00',
      '401.01': '-921.00',
      '401.02': '-930.00',
      '4426': '195.30',
      '4427': '-195.30',
      '628': '1551.00',
      '704': '-1000.00',
    },
    { customer: '0', supplier: '-921.00' },
    {
      journals: [
        {
          id: 'J',
          description: 'Registru jurnal',
          type: 'J',
          transactions: [
            {
              id: 'T10',
              date: '2026-03-10',
              description: 'Factura F-4, taxare inversă',
              lines: [
                line('28', '628', 'debit', base, { tax: [vat('300704', base, tax)] }),
                line('29', '401.02', 'credit', base, { supplier: euSupplier }),
                line('30', '4426', 'debit', tax, { tax: [marker('300704')] }),
                line('31', '4427', 'credit', tax, { tax: [marker('300704')] }),
              ],
            },
            {
              id: 'T11',
              date: '2026-03-20',
              description: 'Plata F-3',
              lines: [
                line('32', '401.02', 'debit', '930.00', { supplier: euSupplier }),
                line('33', '5121', 'credit', '930.00'),
              ],
            },
            ...(unread
              ? [
                  {
                    id: 'T12',
                    date: '2026-03-25',
                    description: 'Factura V-2',
                    lines: [
                      line('34', '4111.01', 'debit', unreadSale.gross, { customer }),
                      line('35', '704', 'credit', unreadSale.base, {
                        tax: [vat('310344', unreadSale.base, unreadSale.tax)],
                      }),
                      line('36', '4427', 'credit', unreadSale.tax),
                    ],
                  },
                ]
              : []),
          ],
        },
      ],
      salesInvoices: [],
      purchaseInvoices: [
        {
          number: 'F-4',
          party: euSupplier,
          date: '2026-03-10',
          type: '380',
          transaction: 'T10',
          lines: [service('628', base, [vat('300704', base, tax)])],
        },
      ],
      payments: [
        {
          reference: 'OP-3',
          date: '2026-03-20',
          mechanism: '42',
          description: 'Plata F-3',
          direction: 'payment',
          transaction: 'T11',
          lines: [{ account: '401.02', supplier: euSupplier, document: 'F-3', amount: '930.00' }],
        },
      ],
    },
  );
  model.suppliers[1]!.opening = '-930.00';
  return model;
}

/** The three synthetic months as the corpus reader gives them, the regime of each header given. */
export function returnFilings(
  options: { vatRegime?: string; unread?: boolean } = {},
): CompanyFiling[] {
  const { vatRegime = '100010', unread = false } = options;
  const models = [...replayModels(), marchModel(unread)];
  for (const model of models) model.company.vatRegime = vatRegime;
  const filings = replayFilings(models);
  for (const transaction of filings[2]!.filed.generalLedgerEntries.journals[0]!.transactions)
    if (transaction.id === 'T12') transaction.lines[1]!.tax![0]!.code = unreadCode;
  return filings;
}

const header = {
  cui: companyCui,
  name: 'Reluare Sintetică SRL',
  address: 'Str. Inventată 1, Galați, Galați',
  phone: '0200000000',
};

/** A D300 for a month of 2026 as the company might have filed it, rows as given. */
export function filedD300(month: number, rows: D300['rows'] = {}): D300 {
  return {
    period: { year: 2026, month },
    type: 'L',
    company: {
      ...header,
      bank: 'Banca Sintetică',
      account: 'RO49AAAA1B31007593840000',
      caen: '6920',
    },
    declarant: { lastName: 'Sintetic', firstName: 'Ana', role: 'Administrator' },
    groupRepresentative: false,
    simplifiedDomestic: false,
    afterReserveCancellation: false,
    proRata: '100',
    reverseCharge: {
      cereals: false,
      mobilePhones: false,
      integratedCircuits: false,
      consoles: false,
    },
    refundRequested: false,
    rows,
  };
}

/** A D394 for a month of 2026 listing no operation. */
export function filedD394(month: number): D394 {
  return {
    period: { year: 2026, month },
    type: 'L',
    company: { ...header, caen: '6920' },
    representative: { name: 'Ana Sintetic', role: 'Administrator', address: 'Galați' },
    preparer: {
      kind: 'company',
      cui: '31552803',
      name: 'Contabil Sintetic SRL',
      capacity: 'Expert',
    },
    consultation: false,
    affiliates: false,
    operations: [],
    simplified: {},
    series: [],
    issuedInvoices: { own: 0, byBeneficiaries: 0, byThirdParties: 0 },
    invoices: [],
    cashVatDeductible: {},
  };
}

/** A return's XML as the corpus reader gives its payload. */
export function payload(form: string, xml: string): CompanyReturnPayload {
  const bytes = new TextEncoder().encode(xml);
  return { form, xml: bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export const d300Payload = (model: D300) => payload('D300', writeD300(model));
export const d394Payload = (model: D394) => payload('D394', writeD394(model));
