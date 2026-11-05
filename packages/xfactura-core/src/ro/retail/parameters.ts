import { z } from 'zod';
import type { ParameterDefinition, ParameterVersion } from '../../rules';
import { parseLocalDate as date } from '../../time';

/*
 * The legal values of retail and B2C (G2): how a fiscal cash register's daily report is booked
 * by its means of payment, what the coefficient of the retail price method is computed over, how
 * an individual buyer is identified on an e-Factura invoice, and the deadline to transmit an
 * invoice to RO e-Factura. Every version is `extracted`, read on 5 November 2026 in the texts the
 * clauses cite; the readings the texts leave open are the expert's (src/ro/reviews/specs/retail.ts).
 */

const account = z.string().regex(/^[1-8]\d{2,3}$/);

const zReportRule = z
  .object({
    /** Card payments, in transit until the acquirer's settlement reaches the bank (5125). */
    card: account,
    /** Meal and value tickets received in payment, until their issuer reimburses them (532x). */
    tickets: account,
    /** The means of payment no treatment books: an advance in cash, a voucher sold earlier, a
     * sale on credit to an unnamed buyer, modern and other means. */
    unsupported: z.array(z.enum(['cashAdvance', 'voucher', 'credit', 'modern', 'other'])),
  })
  .strict();
export type ZReportRule = z.infer<typeof zReportRule>;

const coefficientRule = z
  .object({
    /** `year`: the year's opening balances and the entries cumulated from the financial year's
     * start to the month's end (pct. 286 alin. (4), as read); `month`: the month's own. */
    basis: z.enum(['year', 'month']),
  })
  .strict();
export type CoefficientRule = z.infer<typeof coefficientRule>;

const b2cRule = z
  .object({
    /** The code an individual without any tax code is written with, in place of one. */
    unidentified: z.string().regex(/^\d{13}$/),
    /** The invoice's field the code goes in (BT-47, the buyer's legal registration identifier). */
    field: z.literal('BT-47'),
    /** An invoice issued at an individual's request for a sale a fiscal receipt already
     * documents: transmitted like any B2C invoice (art. 10^1 alin. (2) excepts the receipts, not
     * the invoices), or left out with its receipt. */
    receiptInvoices: z.enum(['transmit', 'exempt']),
  })
  .strict();
export type B2cRule = z.infer<typeof b2cRule>;

export const retailDefinitions: ParameterDefinition[] = [
  {
    key: 'ro.retail.zreport',
    axis: 'accounting_transaction_date',
    continuity: 'block',
    scope: [],
    value: zReportRule,
    description:
      'Înregistrarea raportului fiscal de închidere zilnică pe mijloace de plată: încasările cu cardul în curs de decontare (5125), tichetele primite (5328) și mijloacele pe care niciun tratament nu le înregistrează (OUG nr. 28/1999 art. 4 alin. (7), OPANAF nr. 146/2018, OMFP nr. 1.802/2014 pct. 302 alin. (2)).',
  },
  {
    key: 'ro.stock.retail.coefficient',
    axis: 'accounting_transaction_date',
    continuity: 'block',
    scope: [],
    value: coefficientRule,
    description:
      'Coeficientul de repartizare a adaosului comercial asupra mărfurilor ieșite la metoda prețului cu amănuntul: soldurile și intrările de la începutul exercițiului, fără TVA neexigibilă (OMFP nr. 1.802/2014 pct. 286 alin. (4) și (8)).',
  },
  {
    key: 'ro.efactura.b2c',
    axis: 'invoice_issue_date',
    continuity: 'block',
    scope: [],
    value: b2cRule,
    description:
      'Identificarea cumpărătorului persoană fizică pe factura transmisă în RO e-Factura: codul de 13 cifre de zero în locul codului de identificare fiscală, când nu se identifică prin niciun cod (OUG nr. 120/2021 art. 10^1 alin. (3)).',
  },
  {
    key: 'ro.deadline.efactura',
    axis: 'invoice_issue_date',
    continuity: 'block',
    scope: [],
    value: z.object({ workingDays: z.number().int().min(1).max(30) }).strict(),
    description:
      'Termenul de transmitere a facturii în RO e-Factura: zile lucrătoare de la emitere (OUG nr. 120/2021 art. 10 alin. (7) și art. 10^1 alin. (2^1)).',
  },
];

const OUG = 'OUG28/1999';
const ORDER = 'OPANAF146/2018';
const OMFPA = 'OMFP1802/2014-A';
const EFACTURA = 'OUG120/2021-A';

export const retailVersions: ParameterVersion[] = [
  // OUG nr. 28/1999 is read only to 10 September 2018 (the owner's consolidation): later
  // amendments are not verified, so the version runs from 2026, reviewed through its end.
  {
    id: 'ro.retail.zreport/2026-01-01',
    key: 'ro.retail.zreport',
    scope: {},
    value: {
      card: '5125',
      tickets: '5328',
      unsupported: ['cashAdvance', 'voucher', 'credit', 'modern', 'other'],
    },
    from: date('2026-01-01'),
    to: null,
    reviewedThrough: date('2026-12-31'),
    knowledgeDate: null,
    status: 'extracted',
    clauses: [
      `${OUG}:art.4(5)-(9)`,
      `${ORDER}:anexa2.II.7`,
      'ANAF/A4203:structura',
      `${OMFPA}:pct.302(2)`,
      `${OMFPA}:conturi.532`,
    ],
  },
  {
    id: 'ro.stock.retail.coefficient/2026-01-01',
    key: 'ro.stock.retail.coefficient',
    scope: {},
    value: { basis: 'year' },
    from: date('2026-01-01'),
    to: null,
    reviewedThrough: date('2026-12-31'),
    knowledgeDate: null,
    status: 'extracted',
    clauses: [
      `${OMFPA}:pct.286(4)-(8)`,
      'OMFP1802/2014:conturi.371-378',
      'OMFP1802/2014:conturi.4428',
    ],
  },
  // Alin. (3) as Legea nr. 88/2026 rewrote it from 1 June 2026; the earlier wording is not in the
  // consolidation read, so earlier invoices are a rule gap.
  {
    id: 'ro.efactura.b2c/2026-06-01',
    key: 'ro.efactura.b2c',
    scope: {},
    value: { unidentified: '0000000000000', field: 'BT-47', receiptInvoices: 'transmit' },
    from: date('2026-06-01'),
    to: null,
    reviewedThrough: date('2026-12-31'),
    knowledgeDate: date('2026-05-29'),
    status: 'extracted',
    clauses: [
      `${EFACTURA}:art.10^1(3)-(4)`,
      `${EFACTURA}:art.10^1(2)`,
      'ANAF/ghid-coduri-facturi-2.9:BT-47',
    ],
  },
  // Art. 10 alin. (7) and art. 10^1 alin. (2^1) as OUG nr. 89/2025 set them from 1 January 2026.
  {
    id: 'ro.deadline.efactura/2026-01-01',
    key: 'ro.deadline.efactura',
    scope: {},
    value: { workingDays: 5 },
    from: date('2026-01-01'),
    to: null,
    reviewedThrough: date('2026-12-31'),
    knowledgeDate: date('2025-12-24'),
    status: 'extracted',
    clauses: [`${EFACTURA}:art.10(7)`, `${EFACTURA}:art.10^1(2)`],
  },
];
