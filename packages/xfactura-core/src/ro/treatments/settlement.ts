import { z } from 'zod';
import {
  accountCodePattern,
  vatPeriodOf,
  type Effect,
  type FxRate,
  type Issue,
  type LineSpec,
  type Loaded,
  type OpenItemState,
  type ReadPlan,
  type TaxEntrySpec,
  type Treatment,
} from '../../kernel';
import { convertMinor, divRound, formatMoney, LEDGER_CURRENCY, parseMoney } from '../../money';
import type { LocalDate } from '../../time';
import { bookRelease, cashVatClauses, deferredInvoice } from '../cash-vat';
import { selectRate } from '../fx';
import { controlKindOf } from '../chart';

const amount = z
  .string()
  .regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/, 'Folosiți o sumă pozitivă cu cel mult două zecimale.');
const block = (code: string, message: string, path?: string): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
});

export const settlementInput = z
  .object({
    movementId: z.uuid(),
    /** Parts of the movement that settle open items (invoices, advances, …). */
    allocations: z
      .array(z.object({ openItem: z.uuid(), amount }).strict())
      .max(200)
      .default([]),
    /** Parts booked directly to accounts without partners: bank fees, interest, own transfers. */
    lines: z
      .array(
        z
          .object({
            account: z.string().regex(accountCodePattern),
            amount,
            memo: z.string().trim().min(1).max(500).optional(),
          })
          .strict(),
      )
      .max(50)
      .default([]),
    /** A new open item of a person, in lei: an advance paid on 542, other debtors (461), an
     * associate's money received on 4551, other creditors (462). */
    opens: z
      .array(
        z
          .object({
            account: z.enum(['542', '461', '4551', '462']),
            partyId: z.uuid(),
            amount,
          })
          .strict(),
      )
      .max(5)
      .default([]),
    description: z.string().trim().min(3).max(500).optional(),
  })
  .strict()
  .refine(
    (input) => input.allocations.length + input.lines.length + input.opens.length > 0,
    'Explicați mișcarea bancară.',
  );
export type SettlementInput = z.infer<typeof settlementInput>;

const invoiceItem = (item: OpenItemState) =>
  item.documentId !== null && (item.kind === 'receivable' || item.kind === 'payable');

/** The read of the invoices an allocation settles: their history, for the VAT they defer, and the
 * profile, for the tax period a release falls in. */
export function settledInvoices(loaded: Loaded, ids: readonly string[]): ReadPlan | null {
  const entries = ids.flatMap((id) => {
    const item = loaded.openItems.get(id);
    return item && invoiceItem(item) ? (item.history ?? []) : [];
  });
  return entries.length ? { entries: [...new Set(entries)], profile: true } : null;
}

/**
 * Releases the VAT that invoices under VAT on collection defer, for what an explanation settles
 * of them on `date` (art. 282 alin. (3) and (8), art. 297 alin. (2) and (3)): a collection makes
 * a sale's VAT chargeable, a payment a purchase's VAT deductible, each in the period of the date.
 * Allocations to the same invoice add up. Lines are appended to `lines`.
 */
export function releaseSettled(
  loaded: Loaded,
  settled: { openItem: string; bani: bigint; path: string }[],
  date: LocalDate,
  lines: LineSpec[],
): { taxEntries: TaxEntrySpec[]; issues: Issue[]; released: Record<string, string>[] } {
  const issues: Issue[] = [];
  const taxEntries: TaxEntrySpec[] = [];
  const released: Record<string, string>[] = [];
  const totals = new Map<string, { bani: bigint; path: string }>();
  for (const part of settled) {
    const total = totals.get(part.openItem) ?? { bani: 0n, path: part.path };
    total.bani += part.bani;
    totals.set(part.openItem, total);
  }
  for (const [id, { bani, path }] of totals) {
    const item = loaded.openItems.get(id);
    if (!item || !invoiceItem(item)) continue;
    const invoice = deferredInvoice(item, loaded);
    if (!invoice) continue;
    if ('code' in invoice) {
      issues.push({ ...invoice, path });
      continue;
    }
    if (bani <= 0n) {
      issues.push({
        code: 'CASH_VAT_DIRECTION',
        severity: 'block',
        message:
          'Factura are TVA la încasare: o sumă care îi mărește soldul (o restituire) nu este încă tratată.',
        path,
      });
      continue;
    }
    const entries = bookRelease(invoice, bani, date, vatPeriodOf(loaded, date), lines);
    taxEntries.push(...entries);
    const sale = invoice.direction === 'output';
    const chargeable = entries.filter((entry) => entry.exigibility !== null);
    released.push({
      invoice: invoice.origin.description,
      settled: formatMoney(bani, LEDGER_CURRENCY),
      vat: formatMoney(
        chargeable.reduce((sum, entry) => sum + (sale ? entry.taxBani : entry.deductibleBani), 0n),
        LEDGER_CURRENCY,
      ),
      clause: sale ? cashVatClauses.chargeability : cashVatClauses.own,
    });
  }
  return { taxEntries, issues, released };
}

/**
 * Explains one reported bank movement in full: money received settles receivables (and money
 * paid settles payables) item by item, partially or grouped, and any remainder goes to named
 * accounts without partners. Nothing is left unexplained and no item is settled past zero. An
 * invoice under VAT on collection also releases the VAT the movement settles of it, on the date
 * of the statement (norme pct. 26 alin. (10), pct. 67 alin. (11)).
 */
export const settlement: Treatment<SettlementInput> = {
  id: 'bank.settle',
  version: 1,
  description:
    'Explicarea completă a unei mișcări bancare: decontări de facturi, comisioane, dobânzi, transferuri.',
  input: settlementInput,
  agent: true,
  subject: (input) => `movement:${input.movementId}`,
  plan: (input) => ({
    movements: [input.movementId],
    openItems: [{ ids: input.allocations.map((allocation) => allocation.openItem), history: true }],
    ...(input.opens.length ? { parties: input.opens.map((open) => open.partyId) } : {}),
  }),
  followUp(input, loaded) {
    const movement = loaded.movements.get(input.movementId);
    const invoices = settledInvoices(
      loaded,
      input.allocations.map((allocation) => allocation.openItem),
    );
    // The accounting rate depends on the books system, which the profile holds.
    const fx =
      movement && movement.currency !== LEDGER_CURRENCY
        ? { fx: [{ currency: movement.currency, until: movement.bookingDate }], profile: true }
        : null;
    return fx || invoices ? { ...fx, ...invoices } : null;
  },
  evaluate(input, loaded, rules) {
    const movement = loaded.movements.get(input.movementId);
    if (!movement)
      return {
        effect: null,
        issues: [block('MOVEMENT', 'Mișcarea bancară nu este disponibilă.', 'movementId')],
      };
    const issues: Issue[] = [];
    const currency = movement.currency;
    const foreign = currency !== LEDGER_CURRENCY;
    let rate: FxRate | undefined;
    if (foreign) {
      const selected = selectRate(loaded, rules, currency, movement.bookingDate, 'accounting');
      if ('code' in selected) return { effect: null, issues: [selected] };
      rate = selected;
    }
    const toRon = (minor: bigint) =>
      rate
        ? convertMinor(minor, currency, { rate: rate.rate, multiplier: rate.multiplier })
        : minor;
    const withCurrency = (line: LineSpec, minor: bigint): LineSpec =>
      rate
        ? { ...line, currency: { code: currency, minor, rateId: rate.id, rate: rate.rate } }
        : line;
    const received = movement.amountMinor > 0n;
    const total = received ? movement.amountMinor : -movement.amountMinor;
    const bank = toRon(total);
    // Settlement lines sit opposite the bank line: credits for receipts, debits for payments.
    const side = received ? 'C' : 'D';
    const lines: LineSpec[] = [
      withCurrency(
        { account: movement.ledgerAccount, side: received ? 'D' : 'C', bani: bank },
        total,
      ),
    ];
    let explained = 0n;
    let settledBani = 0n;
    const settled: { openItem: string; bani: bigint; path: string }[] = [];
    input.allocations.forEach((allocation, index) => {
      const item = loaded.openItems.get(allocation.openItem);
      const minor = parseMoney(allocation.amount, currency);
      explained += minor;
      if (!item) {
        issues.push(
          block('OPEN_ITEM', 'Poziția deschisă nu este disponibilă.', `allocations.${index}`),
        );
        return;
      }
      if (item.currency !== currency) {
        issues.push(
          block(
            'CURRENCY_MISMATCH',
            'Poziția are altă monedă decât mișcarea bancară.',
            `allocations.${index}`,
          ),
        );
        return;
      }
      // A foreign item releases its RON carrying amount in proportion to the currency settled;
      // settling the whole balance releases all of it, so nothing is left in lei.
      const balanceMinor = item.balanceMinor < 0n ? -item.balanceMinor : item.balanceMinor;
      const balanceBani = item.balanceBani < 0n ? -item.balanceBani : item.balanceBani;
      const bani = !foreign
        ? minor
        : minor === balanceMinor
          ? balanceBani
          : balanceMinor === 0n
            ? toRon(minor)
            : divRound(balanceBani * minor, balanceMinor, 'halfAwayFromZero');
      settledBani += bani;
      // A receipt reduces a receivable, a payment a payable.
      settled.push({
        openItem: item.id,
        bani: side === item.normalSide ? -bani : bani,
        path: `allocations.${index}`,
      });
      lines.push(
        withCurrency(
          { account: item.controlAccount, side, bani, openItem: item.id, partyId: item.partyId },
          minor,
        ),
      );
    });
    input.lines.forEach((line, index) => {
      const minor = parseMoney(line.amount, currency);
      const bani = toRon(minor);
      explained += minor;
      settledBani += bani;
      if (controlKindOf(line.account))
        issues.push(
          block(
            'CONTROL_ACCOUNT',
            `Contul ${line.account} se decontează prin poziții deschise.`,
            `lines.${index}`,
          ),
        );
      lines.push(
        withCurrency(
          { account: line.account, side, bani, ...(line.memo ? { memo: line.memo } : {}) },
          minor,
        ),
      );
    });
    const openItems: Effect['openItems'] = [];
    input.opens.forEach((open, index) => {
      const path = `opens.${index}`;
      const minor = parseMoney(open.amount, currency);
      explained += minor;
      settledBani += minor;
      // A payment starts what the person owes back (542, 461); a receipt what the company owes.
      const debtor = open.account === '542' || open.account === '461';
      if (debtor === received)
        issues.push(
          block(
            'DIRECTION',
            `Contul ${open.account} se deschide printr-o ${debtor ? 'plată' : 'încasare'}.`,
            path,
          ),
        );
      if (foreign)
        issues.push(block('CURRENCY', 'Pozițiile noi se deschid din mișcări în lei.', path));
      if (!loaded.parties.has(open.partyId))
        issues.push(block('PARTY', 'Partenerul nu există.', path));
      const ref = `opened-${index}`;
      openItems.push({
        ref,
        kind: debtor ? 'receivable' : 'payable',
        controlAccount: open.account,
        partyId: open.partyId,
        currency: LEDGER_CURRENCY,
        normalSide: debtor ? 'D' : 'C',
        mayReverse: false,
      });
      lines.push({
        account: open.account,
        side,
        bani: minor,
        openItem: ref,
        partyId: open.partyId,
      });
    });
    if (explained !== total)
      issues.push(
        block(
          'UNEXPLAINED',
          `Sumele explicate (${formatMoney(explained, currency)}) diferă de mișcare (${formatMoney(total, currency)} ${currency}).`,
        ),
      );
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };
    // The realized exchange difference: what the bank booked in lei against the carrying amounts.
    const difference = bank - settledBani;
    if (difference !== 0n) {
      const gain = received ? difference > 0n : difference < 0n;
      lines.push({
        account: gain ? '7651' : '6651',
        side: gain ? 'C' : 'D',
        bani: difference < 0n ? -difference : difference,
        memo: 'Diferență de curs realizată',
      });
    }
    // The VAT the settled invoices defer under VAT on collection, released on the booking date.
    const booked = lines.filter((line) => line.bani !== 0n);
    const release = releaseSettled(loaded, settled, movement.bookingDate, booked);
    if (release.issues.length) return { effect: null, issues: [...issues, ...release.issues] };
    const effect: Effect = {
      schema: 'effect@1',
      date: movement.bookingDate,
      journalClass: 'general',
      journalCode: 'BANCA',
      description:
        input.description ??
        `${received ? 'Încasare' : 'Plată'} ${movement.reference}`.slice(0, 500),
      lines: booked,
      openItems,
      taxEntries: release.taxEntries,
      schedules: [],
      explanation: {
        summary: `${received ? 'Încasare' : 'Plată'} de ${formatMoney(total, currency)} ${currency} din ${movement.bookingDate}${rate ? ` la cursul ${rate.rate}` : ''}.`,
        details: {
          movementId: movement.id,
          reference: movement.reference,
          counterparty: movement.counterparty,
          ...(release.released.length ? { vatOnCollection: release.released } : {}),
        },
      },
    };
    return { effect, issues };
  },
};
