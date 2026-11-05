import type { DocumentRecord, TaxLedgerEntry } from 'xfactura-core/kernel';
import { isValidCui } from 'xfactura-core/ro/identifiers';
import {
  d394InvoiceLeads,
  d394Rates,
  type D394Operation,
  type D394Product,
  type D394Rate,
  type D394Simplified,
} from 'xfactura-core/ro/declarations/d394';
import { isReverseChargeCode, reverseChargeCodes } from 'xfactura-core/ro/receipts';
import { invoiceDocumentSchema } from 'xfactura-core/ubl/invoice-document';
import type { DeclarationProblem } from './declarations';

/*
 * Where the returns report receipts and the domestic reverse charge (V3), from the VAT ledger:
 * D394's rezumat2 for the receipts that are simplified invoices (bazaBFAI, TVABFAI), and its V and
 * C operations with their products (op11) for art. 331; D300's header flags for the
 * reverse-charged supplies of cereals, phones, circuits and consoles (bifa_*).
 */

/** The entries D394 reports in sections of their own, and the rest: the cash registers' Z
 * reports (G2, op2), with the receipts invoiced taken out of them, among them. */
export function receiptEntries(entries: readonly TaxLedgerEntry[]) {
  const receipts: TaxLedgerEntry[] = [];
  const reverse: TaxLedgerEntry[] = [];
  const registers: TaxLedgerEntry[] = [];
  const ordinary: TaxLedgerEntry[] = [];
  for (const entry of entries)
    if (entry.attributes.simplified === 'receipt') receipts.push(entry);
    else if (entry.attributes.documentType === 'zreport') registers.push(entry);
    else if (isReverseChargeCode(entry.code)) reverse.push(entry);
    else ordinary.push(entry);
  return { receipts, reverse, registers, ordinary };
}

const rateOf = (code: string) => {
  const rate = /^(?:S|TI-A)-(\d+)$/.exec(code)?.[1];
  return rate && (d394Rates as readonly string[]).includes(rate) ? (rate as D394Rate) : null;
};

/** rezumat2's receipts, by rate: base and VAT in whole lei. */
export function receiptSections(
  entries: readonly TaxLedgerEntry[],
  roundToLeu: (bani: bigint) => bigint,
  problems: DeclarationProblem[],
): Partial<Record<D394Rate, D394Simplified>> {
  const totals = new Map<D394Rate, { base: bigint; vat: bigint }>();
  for (const entry of entries) {
    const rate = rateOf(entry.code);
    if (!rate) {
      problems.push({
        code: 'D394_OPERATION',
        message: `Bonul fiscal cu codul ${entry.code} nu are o cotă declarată în D394.`,
      });
      continue;
    }
    const held = totals.get(rate) ?? { base: 0n, vat: 0n };
    held.base += entry.baseBani;
    held.vat += entry.taxBani;
    totals.set(rate, held);
  }
  return Object.fromEntries(
    [...totals].map(([rate, value]) => [
      rate,
      { receipts: { base: Number(roundToLeu(value.base)), vat: Number(roundToLeu(value.vat)) } },
    ]),
  );
}

/**
 * The domestic reverse charge as D394's op1: supplies (V, rate 0) and acquisitions (C, at the
 * self-assessed rate, read from the output entry: the input one repeats it) by partner, with
 * their products. A product's amounts are rounded to whole lei and the operation is their sum;
 * on an invoice with several products, the invoice counts for the one with the largest base (V)
 * or VAT (C), as the structure's nrFactPR says; an invoice with acquisitions at several rates
 * counts once, for the rate with the largest VAT (OPANAF nr. 3.769/2015 anexa nr. 2 secțiunea a
 * 2-a pct. 5), and 0 for the others.
 */
export function reverseChargeOperations(
  entries: readonly TaxLedgerEntry[],
  documents: ReadonlyMap<string, DocumentRecord>,
  roundToLeu: (bani: bigint) => bigint,
  problems: DeclarationProblem[],
): D394Operation[] {
  type Group = {
    type: 'V' | 'C';
    rate: D394Rate | '0';
    cui: string;
    name: string;
    byDocument: Map<string, Map<string, { base: bigint; vat: bigint }>>;
  };
  const groups = new Map<string, Group>();
  for (const entry of entries) {
    if (entry.direction === 'input') continue;
    const supply = entry.code === reverseChargeCodes.supply;
    const rate = supply ? '0' : rateOf(entry.code);
    const body = invoiceDocumentSchema.safeParse(
      entry.documentId ? documents.get(entry.documentId)?.body : undefined,
    );
    const taxId = (entry.attributes.counterpartyTaxId ?? '').toUpperCase().replace(/\s+/g, '');
    const product = entry.attributes.product;
    if (!rate || !body.success || !product || !/^RO\d+$/.test(taxId) || !isValidCui(taxId)) {
      problems.push({
        code: 'D394_OPERATION',
        message: `Operațiunea cu taxare inversă ${entry.code} nu are factură, partener înregistrat în scopuri de TVA sau produs.`,
      });
      continue;
    }
    const type = supply ? 'V' : 'C';
    const cui = taxId.slice(2);
    const key = `${type}|${rate}|${cui}`;
    const group = groups.get(key) ?? {
      type,
      rate,
      cui,
      name: (supply ? body.data.customer : body.data.supplier).name,
      byDocument: new Map(),
    };
    const products = group.byDocument.get(entry.documentId!) ?? new Map();
    const held = products.get(product) ?? { base: 0n, vat: 0n };
    held.base += entry.baseBani;
    held.vat += entry.taxBani;
    products.set(product, held);
    group.byDocument.set(entry.documentId!, products);
    groups.set(key, group);
  }
  // Which group each invoice counts in: one per invoice, across the rates of its acquisitions.
  const lead = d394InvoiceLeads(
    [...groups].map(([key, group]) => ({
      key,
      rate: group.rate,
      documents: new Map(
        [...group.byDocument].map(([document, products]) => [
          document,
          [...products.values()].reduce((sum, value) => sum + value.vat, 0n),
        ]),
      ),
    })),
  );
  return [...groups.entries()].map(([key, group]) => {
    const totals = new Map<string, { invoices: number; base: bigint; vat: bigint }>();
    for (const [document, products] of group.byDocument) {
      // The product the invoice counts for: the largest, the lowest code on a tie.
      let leading = '';
      let largest = -1n;
      for (const [code, value] of [...products].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const weight = group.type === 'V' ? value.base : value.vat;
        if (weight > largest) [leading, largest] = [code, weight];
      }
      const counted = lead.get(document) === key;
      for (const [code, value] of products) {
        const held = totals.get(code) ?? { invoices: 0, base: 0n, vat: 0n };
        held.invoices += counted && code === leading ? 1 : 0;
        held.base += value.base;
        held.vat += value.vat;
        totals.set(code, held);
      }
    }
    const products: D394Product[] = [...totals]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([code, value]) => ({
        code: code as D394Product['code'],
        invoices: value.invoices,
        base: Number(roundToLeu(value.base)),
        vat: group.type === 'V' ? 0 : Number(roundToLeu(value.vat)),
      }));
    return {
      type: group.type,
      rate: group.rate,
      partner: { kind: 'registered' as const, cui: group.cui, name: group.name },
      invoices: [...group.byDocument.keys()].filter((document) => lead.get(document) === key)
        .length,
      base: products.reduce((sum, product) => sum + product.base, 0),
      vat: products.reduce((sum, product) => sum + product.vat, 0),
      products,
    };
  });
}

/** D300's bifa_cereale, bifa_mob, bifa_disp, bifa_cons: reverse-charged supplies of these goods
 * whose VAT is chargeable in the period. */
export function reverseChargeFlags(entries: readonly TaxLedgerEntry[]) {
  const supplied = new Set(
    entries
      .filter((entry) => entry.code === reverseChargeCodes.supply && entry.exigibility !== null)
      .map((entry) => entry.attributes.category),
  );
  return {
    cereals: supplied.has('cereals'),
    mobilePhones: supplied.has('mobile_phones'),
    integratedCircuits: supplied.has('integrated_circuits'),
    consoles: supplied.has('consoles_tablets_laptops'),
  };
}
