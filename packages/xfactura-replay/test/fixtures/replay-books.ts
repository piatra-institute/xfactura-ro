import { createHash } from 'node:crypto';
import { chartAmendments, referenceChart } from 'xfactura-core/ro/chart';
import { d406PartyId, writeD406, type D406, type D406Line } from 'xfactura-core/ro/saft/d406';
import { readD406 } from 'xfactura-core/ro/saft/read';
import type { CompanyFiling } from '../../src/mapping/corpus';
import { proposeMapping } from '../../src/mapping/propose';

// Invented identities, already used by core's synthetic D406 tests, and invented amounts.
export const companyCui = '18547290';
export const customer = d406PartyId({ kind: 'ro', cui: '14399840' });
const supplier = d406PartyId({ kind: 'ro', cui: '31552803' });
export const euSupplier = d406PartyId({ kind: 'eu', country: 'DE', vat: '123456789' });

export const line = (
  id: string,
  account: string,
  side: D406Line['side'],
  amount: string,
  extra: Partial<D406Line> = {},
): D406Line => ({ id, account, side, amount, description: `Linia ${id}`, ...extra });
export const vat = (code: string, base: string, amount: string) => ({
  type: '300',
  code,
  base,
  amount,
});
export const marker = (code: string) => ({ type: '300', code, amount: '0' });
export const service = (account: string, amount: string, tax: ReturnType<typeof vat>[]) => ({
  account,
  product: 'SRV',
  description: 'Servicii',
  quantity: '1',
  unitPrice: amount,
  amount,
  tax,
});

/** A synthetic month of the company's books, as the D406 writer takes it. */
export const replayModel = (
  month: number,
  opening: Record<string, string>,
  partners: { customer: string; supplier: string },
  rest: Pick<D406, 'journals' | 'salesInvoices' | 'purchaseInvoices' | 'payments'>,
): D406 => ({
  type: 'L',
  period: { year: 2026, month },
  created: `2026-0${month + 1}-10`,
  software: { company: 'Sintetic', name: 'Sintetic', version: '1' },
  company: {
    cui: companyCui,
    name: 'Reluare Sintetică SRL',
    address: {
      street: 'Str. Inventată',
      number: '1',
      city: 'Galați',
      county: 'RO-GL',
      country: 'RO',
    },
    contact: { firstName: 'Ana', lastName: 'Sintetic', phone: '0200000000' },
    ibans: ['RO49AAAA1B31007593840000'],
    vatRegime: '100010',
  },
  accounts: Object.entries({
    '1012': 'Capital subscris vărsat',
    '401.01': 'Furnizori',
    '401.02': 'Furnizori UE',
    '4111.01': 'Clienți',
    '4423': 'TVA de plată',
    '4426': 'TVA deductibilă',
    '4427': 'TVA colectată',
    '5121': 'Conturi la bănci',
    '628': 'Alte servicii',
    '704': 'Venituri din servicii',
  }).map(([code, description]) => ({ code, description, opening: opening[code] ?? '0' })),
  customers: [
    {
      id: customer,
      name: 'Client Sintetic SRL',
      address: { city: 'București', county: 'RO-B', country: 'RO' },
      account: '4111.01',
      opening: partners.customer,
    },
  ],
  suppliers: [
    {
      id: supplier,
      name: 'Furnizor Sintetic SRL',
      address: { city: 'Brăila', county: 'RO-BR', country: 'RO' },
      account: '401.01',
      opening: partners.supplier,
    },
    {
      id: euSupplier,
      name: 'Synthetic Supplier GmbH',
      address: { city: 'Berlin', country: 'DE' },
      account: '401.02',
      opening: '0',
    },
  ],
  products: [{ code: 'SRV', description: 'Servicii', kind: 'services', unit: 'E48' }],
  ...rest,
});

const january = replayModel(
  1,
  { '1012': '-1000.00', '5121': '1500.00', '401.01': '-800.00', '4111.01': '300.00' },
  { customer: '300.00', supplier: '-800.00' },
  {
    journals: [
      {
        id: 'J',
        description: 'Registru jurnal',
        type: 'J',
        transactions: [
          {
            id: 'T1',
            date: '2026-01-05',
            description: 'Factura V-1',
            lines: [
              line('1', '4111.01', 'debit', '1210.00', { customer }),
              line('2', '704', 'credit', '1000.00', { tax: [vat('310344', '1000.00', '210.00')] }),
              line('3', '4427', 'credit', '210.00'),
            ],
          },
          {
            id: 'T2',
            date: '2026-01-08',
            description: 'Factura F-1',
            lines: [
              line('4', '628', 'debit', '500.00', { tax: [vat('301104', '500.00', '105.00')] }),
              line('5', '4426', 'debit', '105.00'),
              line('6', '401.01', 'credit', '605.00', { supplier }),
            ],
          },
          {
            id: 'T3',
            date: '2026-01-15',
            description: 'Plata F-1',
            lines: [
              line('7', '401.01', 'debit', '605.00', { supplier }),
              line('8', '5121', 'credit', '605.00'),
            ],
          },
          {
            id: 'T4',
            date: '2026-01-16',
            description: 'Încasare sold inițial',
            lines: [
              line('9', '5121', 'debit', '300.00'),
              line('10', '4111.01', 'credit', '300.00', { customer }),
            ],
          },
          {
            id: 'T5',
            date: '2026-01-31',
            description: 'Închiderea TVA',
            lines: [
              line('11', '4427', 'debit', '210.00'),
              line('12', '4426', 'credit', '105.00'),
              line('13', '4423', 'credit', '105.00'),
            ],
          },
        ],
      },
    ],
    salesInvoices: [
      {
        number: 'V-1',
        party: customer,
        date: '2026-01-05',
        type: '380',
        transaction: 'T1',
        lines: [service('704', '1000.00', [vat('310344', '1000.00', '210.00')])],
      },
    ],
    purchaseInvoices: [
      {
        number: 'F-1',
        party: supplier,
        date: '2026-01-08',
        type: '380',
        transaction: 'T2',
        lines: [service('628', '500.00', [vat('301104', '500.00', '105.00')])],
      },
    ],
    payments: [
      {
        reference: 'OP-1',
        date: '2026-01-15',
        mechanism: '42',
        description: 'Plata F-1',
        direction: 'payment',
        transaction: 'T3',
        lines: [{ account: '401.01', supplier, document: 'F-1', amount: '605.00' }],
      },
    ],
  },
);

const february = replayModel(
  2,
  {
    '1012': '-1000.00',
    '5121': '1195.00',
    '401.01': '-800.00',
    '4111.01': '1210.00',
    '4423': '-105.00',
    '628': '500.00',
    '704': '-1000.00',
  },
  { customer: '1210.00', supplier: '-800.00' },
  {
    journals: [
      {
        id: 'J',
        description: 'Registru jurnal',
        type: 'J',
        transactions: [
          {
            id: 'T6',
            date: '2026-02-10',
            description: 'Plata TVA',
            lines: [line('14', '4423', 'debit', '105.00'), line('15', '5121', 'credit', '105.00')],
          },
          {
            id: 'T7',
            date: '2026-02-12',
            description: 'Factura F-2, TVA nedeductibilă',
            lines: [
              line('16', '628', 'debit', '100.00', { tax: [vat('301104', '100.00', '21.00')] }),
              line('17', '401.01', 'credit', '100.00', { supplier }),
              line('18', '4426', 'debit', '21.00'),
              line('19', '401.01', 'credit', '21.00', { supplier }),
              line('20', '628', 'debit', '21.00'),
              line('21', '4426', 'credit', '21.00', { tax: [marker('351104')] }),
            ],
          },
          {
            id: 'T8',
            date: '2026-02-14',
            description: 'Factura F-3, taxare inversă',
            lines: [
              line('22', '628', 'debit', '930.00', { tax: [vat('300704', '930.00', '195.30')] }),
              line('23', '401.02', 'credit', '930.00', { supplier: euSupplier }),
              line('24', '4426', 'debit', '195.30', { tax: [marker('300704')] }),
              line('25', '4427', 'credit', '195.30', { tax: [marker('300704')] }),
            ],
          },
          {
            id: 'T9',
            date: '2026-02-20',
            description: 'Încasare V-1',
            lines: [
              line('26', '5121', 'debit', '1210.00'),
              line('27', '4111.01', 'credit', '1210.00', { customer }),
            ],
          },
        ],
      },
    ],
    salesInvoices: [],
    purchaseInvoices: [
      {
        number: 'F-2',
        party: supplier,
        date: '2026-02-12',
        type: '380',
        transaction: 'T7',
        lines: [
          service('628', '100.00', [
            vat('301104', '100.00', '21.00'),
            vat('351104', '100.00', '21.00'),
          ]),
        ],
      },
      {
        number: 'F-3',
        party: euSupplier,
        date: '2026-02-14',
        type: '380',
        transaction: 'T8',
        lines: [service('628', '930.00', [vat('300704', '930.00', '195.30')])],
      },
    ],
    payments: [
      {
        reference: 'OP-2',
        date: '2026-02-20',
        mechanism: '42',
        description: 'Încasare V-1',
        direction: 'collection',
        transaction: 'T9',
        lines: [{ account: '4111.01', customer, document: 'V-1', amount: '1210.00' }],
      },
    ],
  },
);

/** The two synthetic months' models, each call a fresh copy. */
export const replayModels = (): D406[] => structuredClone([january, february]);

/** Synthetic months as the corpus reader gives them: model, payload and hash. The writer
 * refuses SAGA's closing-note code 380200, so it is added to the read model of the January
 * closing as SAGA writes it, on its 4427 and 4426 lines. */
export function replayFilings(models: readonly D406[] = [january, february]): CompanyFiling[] {
  return models.map((value) => {
    const xml = new TextEncoder().encode(writeD406(value));
    const filed = readD406(xml);
    for (const transaction of filed.generalLedgerEntries.journals[0]!.transactions)
      if (transaction.id === 'T5')
        for (const item of transaction.lines.slice(0, 2)) item.tax = [marker('380200')];
    return { filed, xml, sha256: createHash('sha256').update(xml).digest('hex') };
  });
}

/** The mapping the proposer gives the two months, confirmed by a person unless asked. */
export function replayBooksMapping(filings: CompanyFiling[], confirmed = true) {
  const chart = [...referenceChart.accounts, ...chartAmendments.flatMap((a) => a.accounts)];
  const mapping = proposeMapping(
    filings.map((item) => item.filed),
    chart,
    [],
  );
  for (const placeholder of mapping.placeholders) placeholder.confirmedByPerson = confirmed;
  return mapping;
}
