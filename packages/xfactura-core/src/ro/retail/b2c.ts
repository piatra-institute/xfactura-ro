import type { B2cRule } from './parameters';

/*
 * How an invoice to an individual goes to RO e-Factura (OUG nr. 120/2021 art. 10^1 alin. (2)–(4),
 * consolidated to 1 June 2026): a person who gives no tax code, or chooses to give the CNP, is in
 * the B2C relation, and the invoice carries the CNP or, without any code, 13 zeros in its place
 * (`ro.efactura.b2c`, the buyer's legal identifier BT-47, where the engine writes a CNP). A buyer
 * in the optional RO e-Factura register is not covered. An invoice issued for a fiscal receipt
 * follows the parameter's reading.
 */

export interface B2cBuyer {
  /** How the person identified to the company: by their CNP (recorded, sealed), or by none. */
  identification: 'cnp' | 'none';
  /** The CNP, opened from its seal for the invoice only; null without one. */
  cnp: string | null;
  /** The invoice is issued at the person's request for a fiscal receipt. */
  receiptInvoice: boolean;
}

export type B2cOutcome =
  { ok: true; legalId: string; transmit: boolean } | { ok: false; code: string; message: string };

/** The buyer's identifier on the invoice and whether it is transmitted to RO e-Factura. */
export function b2cInvoice(rule: B2cRule, buyer: B2cBuyer): B2cOutcome {
  if (buyer.identification === 'cnp' && !buyer.cnp)
    return {
      ok: false,
      code: 'B2C_CNP',
      message:
        'Cumpărătorul s-a identificat prin CNP, care nu este înregistrat: înregistrați-l (parties.recordCnp).',
    };
  return {
    ok: true,
    legalId: buyer.identification === 'cnp' ? buyer.cnp! : rule.unidentified,
    transmit: !buyer.receiptInvoice || rule.receiptInvoices === 'transmit',
  };
}
