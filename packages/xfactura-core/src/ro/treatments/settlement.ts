import { z } from 'zod';
import {
  accountCodePattern,
  itemLinesKey,
  vatPeriodOf,
  type Effect,
  type FxRate,
  type Issue,
  type LineSpec,
  type Loaded,
  type OpenItemSpec,
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
    /** Card sales the acquirer settles net of its fee (G2): each Z report's card takings in
     * transit on 5125 (`retail.zReport` tags them by report) the movement settles, and the fee
     * kept, on 627. Only on a receipt in lei. */
    cards: z
      .object({
        account: z.string().regex(/^5125(\.[A-Z0-9_-]{1,24})?$/),
        settles: z
          .array(z.object({ documentId: z.uuid(), amount }).strict())
          .min(1)
          .max(200),
        fee: amount,
        feeAccount: z.string().regex(/^627(\.[A-Z0-9_-]{1,24})?$/),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.allocations.length + input.lines.length + input.opens.length > 0 ||
      input.cards !== undefined,
    'Explicați mișcarea bancară.',
  );
export type SettlementInput = z.infer<typeof settlementInput>;

const invoiceItem = (item: OpenItemState) =>
  item.documentId !== null && (item.kind === 'receivable' || item.kind === 'payable');

/**
 * The rate an item in a currency is carried at (OMFP 1802/2014 pct. 323, 326): the rate of the
 * latest line that measured it, a month-end revaluation's (a line in lei only, its currency
 * amount 0, bringing the whole balance to that rate) or its own (the invoice's, at the accounting
 * rate of its date) when its lei are its currency amount at that rate. An invoice whose lei mix
 * rates (its VAT in lei at the VAT rate, BT-111) is carried at none. Its history's entries must
 * be loaded; null without them.
 */
export function carryingRate(
  item: OpenItemState,
  loaded: Loaded,
  multiplier = 1,
): { rate: string; rateId: string } | null {
  let found: { rate: string; rateId: string } | null = null;
  const size = (value: bigint) => (value < 0n ? -value : value);
  for (const entryId of item.history ?? []) {
    const entry = loaded.entries.get(entryId);
    for (const line of entry?.lines ?? []) {
      if (line.openItem !== item.id || line.currency?.code !== item.currency) continue;
      if (line.currency.minor === 0n)
        found = { rate: line.currency.rate, rateId: line.currency.rateId };
      else if (entryId === item.originEntryId)
        found =
          convertMinor(size(line.currency.minor), item.currency, {
            rate: line.currency.rate,
            multiplier,
          }) === size(line.bani)
            ? { rate: line.currency.rate, rateId: line.currency.rateId }
            : null;
    }
  }
  return found;
}

/**
 * The lines releasing `minor` of an item in a currency at its carrying amount, on `side`: at the
 * rate it is carried at, the whole balance's lei left over going on a line of the item in lei
 * only (the rounding of earlier partial releases), so that the line's lei are its currency amount
 * at its rate, as the ledger and the SAF-T line state it. Without a carrying rate (its history
 * not loaded), in proportion to the balance at the given rate. The difference from the lei the
 * counterpart books is the realized exchange difference (7651, 6651), the caller's.
 */
export function releaseAtCarrying(
  item: OpenItemState,
  loaded: Loaded,
  minor: bigint,
  side: 'D' | 'C',
  fallback: FxRate,
): { lines: LineSpec[]; bani: bigint } {
  const balanceMinor = item.balanceMinor < 0n ? -item.balanceMinor : item.balanceMinor;
  const balanceBani = item.balanceBani < 0n ? -item.balanceBani : item.balanceBani;
  const target = { account: item.controlAccount, side, openItem: item.id, partyId: item.partyId };
  const carried = carryingRate(item, loaded, fallback.multiplier);
  const whole = minor === balanceMinor;
  if (!carried) {
    const bani = whole
      ? balanceBani
      : balanceMinor === 0n
        ? convertMinor(minor, item.currency, fallback)
        : divRound(balanceBani * minor, balanceMinor, 'halfAwayFromZero');
    return {
      lines: [
        {
          ...target,
          bani,
          currency: { code: item.currency, minor, rateId: fallback.id, rate: fallback.rate },
        },
      ],
      bani,
    };
  }
  const atRate = convertMinor(minor, item.currency, {
    rate: carried.rate,
    multiplier: fallback.multiplier,
  });
  const lines: LineSpec[] = [
    { ...target, bani: atRate, currency: { code: item.currency, minor, ...carried } },
  ];
  const residue = whole ? balanceBani - atRate : 0n;
  if (residue !== 0n)
    lines.push({
      ...target,
      side: residue > 0n ? side : side === 'D' ? 'C' : 'D',
      bani: residue > 0n ? residue : -residue,
      currency: { code: item.currency, minor: 0n, ...carried },
      memo: 'Rotunjirea valorii contabile în lei',
    });
  return { lines, bani: whole ? balanceBani : atRate };
}

/** The read of the invoices an allocation settles: their history, for the VAT they defer, and the
 * profile, for the tax period a release falls in. */
export function settledInvoices(loaded: Loaded, ids: readonly string[]): ReadPlan | null {
  const entries = ids.flatMap((id) => {
    const item = loaded.openItems.get(id);
    return item && invoiceItem(item) ? (item.history ?? []) : [];
  });
  return entries.length ? { entries: [...new Set(entries)], profile: true } : null;
}

/** Where a credit note puts what its original no longer owes: a refund owed to the customer
 * (462, "sumele încasate și necuvenite", a creditor kept per customer) or owed by the supplier
 * (461, "alte creanțe"), OMFP 1802/2014's functions of 462 and 461. 419 and 409 hold advances
 * (their functions, pct. 311 alin. (1)) and are not revalued (pct. 316 alin. (2)); a refund owed
 * in a currency is a monetary item (pct. 315), revalued each month (pct. 325). */
export const creditRefundAccounts = { sale: '462', purchase: '461' } as const;

/**
 * What a credit note books on its partner's side, by red storno like its other lines: the
 * original's receivable or payable reduced by what it still holds, at its carrying amount (in a
 * currency, at the rate it is carried at: `releaseAtCarrying`), never past zero; what the credit
 * note credits beyond it (the invoice already collected or paid) a refund owed to the customer
 * or by the supplier, a new item of the partner in the document's currency at the credit note's
 * rate (`creditRefundAccounts`), to refund, collect or offset. `bani` is the credit note's total
 * in lei as its other lines book it (its revenue or expense and its VAT, each at its own rate),
 * `minor` the same total in the currency (lei when the item is in lei), both positive. `excess`
 * is the lei the partner's lines release beyond `bani`: the exchange difference between the
 * carrying amount, the refund's rate and the rates of the credit note's other lines (positive, a
 * loss on a sale and a gain on a purchase), for the caller to book on 6651 or 7651.
 */
export function creditPartner(input: {
  item: OpenItemState;
  loaded: Loaded;
  purchase: boolean;
  bani: bigint;
  minor: bigint;
  /** The credit note's rate, for an item in a currency. */
  rate?: FxRate;
  partyId: string;
}): {
  lines: LineSpec[];
  openItems: OpenItemSpec[];
  excess: bigint;
  refund: { account: string; bani: bigint; minor: bigint } | null;
} {
  const { item, loaded, purchase, bani, minor, rate, partyId } = input;
  const foreign = item.currency !== LEDGER_CURRENCY;
  const open = item.balanceMinor < 0n ? -item.balanceMinor : item.balanceMinor;
  const reduced = minor < open ? minor : open;
  // The original's lines: a sale's 4111 debited, a purchase's 401 credited, in red.
  const side: 'D' | 'C' = purchase ? 'C' : 'D';
  const red = (line: LineSpec): LineSpec => ({
    ...line,
    side,
    bani: line.side === side ? line.bani : -line.bani,
    ...(line.currency
      ? {
          currency: {
            ...line.currency,
            minor: line.side === side ? line.currency.minor : -line.currency.minor,
          },
        }
      : {}),
  });
  const release =
    reduced === 0n
      ? { lines: [], bani: 0n }
      : foreign
        ? releaseAtCarrying(item, loaded, reduced, purchase ? 'D' : 'C', rate!)
        : {
            lines: [
              {
                account: item.controlAccount,
                side: purchase ? ('D' as const) : ('C' as const),
                bani: reduced,
                openItem: item.id,
                partyId: item.partyId,
              },
            ],
            bani: reduced,
          };
  const lines = release.lines.map((line) => red(line));
  const openItems: OpenItemSpec[] = [];
  const rest = minor - reduced;
  // The refund opens at the credit note's rate, its lei exactly its currency at that rate (as the
  // ledger and the SAF-T line state it): a new monetary item recorded on the day of its
  // transaction (OMFP 1802/2014 pct. 319). In lei it is what the original does not take.
  const refundBani =
    rest === 0n ? 0n : foreign ? convertMinor(rest, item.currency, rate!) : bani - reduced;
  let refund: { account: string; bani: bigint; minor: bigint } | null = null;
  if (rest > 0n) {
    const account = purchase ? creditRefundAccounts.purchase : creditRefundAccounts.sale;
    openItems.push({
      ref: 'refund',
      kind: purchase ? 'receivable' : 'payable',
      controlAccount: account,
      partyId,
      currency: item.currency,
      normalSide: purchase ? 'D' : 'C',
      mayReverse: false,
    });
    lines.push({
      account,
      side: purchase ? 'D' : 'C',
      bani: refundBani,
      openItem: 'refund',
      partyId,
      ...(foreign
        ? { currency: { code: item.currency, minor: rest, rateId: rate!.id, rate: rate!.rate } }
        : {}),
    });
    refund = { account, bani: refundBani, minor: rest };
  }
  return { lines, openItems, excess: release.bani + refundBani - bani, refund };
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
  summary:
    'Full explanation of a bank movement: invoice settlements, fees, interest and transfers.',
  toolset: 'bank',
  subject: (input) => `movement:${input.movementId}`,
  plan: (input) => ({
    movements: [input.movementId],
    openItems: [{ ids: input.allocations.map((allocation) => allocation.openItem), history: true }],
    ...(input.opens.length ? { parties: input.opens.map((open) => open.partyId) } : {}),
    // The card takings still in transit, by Z report (`cards`).
    ...(input.cards ? { itemLines: { prefixes: [input.cards.account] } } : {}),
  }),
  followUp(input, loaded) {
    const movement = loaded.movements.get(input.movementId);
    const invoices = settledInvoices(
      loaded,
      input.allocations.map((allocation) => allocation.openItem),
    );
    // The accounting rate depends on the books system, which the profile holds; an item in a
    // currency is released at the rate it is carried at, which its history's lines give.
    const carried = input.allocations.flatMap((allocation) => {
      const item = loaded.openItems.get(allocation.openItem);
      return item && item.currency !== LEDGER_CURRENCY ? (item.history ?? []) : [];
    });
    const fx =
      movement && movement.currency !== LEDGER_CURRENCY
        ? { fx: [{ currency: movement.currency, until: movement.bookingDate }], profile: true }
        : null;
    const entries = [...new Set([...(invoices?.entries ?? []), ...carried])];
    return fx || invoices || entries.length
      ? { ...fx, ...invoices, ...(entries.length ? { entries } : {}) }
      : null;
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
    const side: 'D' | 'C' = received ? 'C' : 'D';
    const lines: LineSpec[] = [
      withCurrency(
        { account: movement.ledgerAccount, side: received ? 'D' : 'C', bani: bank },
        total,
      ),
    ];
    let explained = 0n;
    let settledBani = 0n;
    const settled: { openItem: string; bani: bigint; path: string }[] = [];
    // What earlier allocations of this movement took off each foreign item, in its currency and
    // in lei: the next one releases from what they left, so the allocations that settle an item
    // between them release its whole carrying amount, as one allocation would.
    const taken = new Map<string, { minor: bigint; bani: bigint }>();
    const left = (balance: bigint, used: bigint) =>
      balance < 0n ? balance + used : balance - used;
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
      // An amount for later months (471, 472) is not money owed: its schedule releases it, so a
      // payment allocated to it would be expensed twice and leave the invoice unpaid.
      if (item.kind === 'deferral.expense' || item.kind === 'deferral.revenue') {
        issues.push(
          block(
            'OPEN_ITEM_KIND',
            'O sumă în avans (471, 472) se reia prin deferrals.release, nu se decontează prin bancă: alocați plata facturii (401, 4111).',
            `allocations.${index}`,
          ),
        );
        return;
      }
      // A foreign item is released at its carrying amount: the currency settled at the rate it
      // is carried at (its invoice's, or the last month-end revaluation's); settling the whole
      // balance releases all of it, so nothing is left in lei.
      const reduces = side !== item.normalSide;
      const used = reduces ? taken.get(item.id) : undefined;
      const remaining = used
        ? {
            ...item,
            balanceMinor: left(item.balanceMinor, used.minor),
            balanceBani: left(item.balanceBani, used.bani),
          }
        : item;
      const release: { lines: LineSpec[]; bani: bigint } = foreign
        ? releaseAtCarrying(remaining, loaded, minor, side, rate!)
        : {
            lines: [
              {
                account: item.controlAccount,
                side,
                bani: minor,
                openItem: item.id,
                partyId: item.partyId,
              },
            ],
            bani: minor,
          };
      settledBani += release.bani;
      if (foreign && reduces)
        taken.set(item.id, {
          minor: (used?.minor ?? 0n) + minor,
          bani: (used?.bani ?? 0n) + release.bani,
        });
      // A receipt reduces a receivable, a payment a payable.
      settled.push({
        openItem: item.id,
        bani: side === item.normalSide ? -release.bani : release.bani,
        path: `allocations.${index}`,
      });
      lines.push(...release.lines);
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
    // Card takings settled by the acquirer, net of its fee: each Z report's card sales leave
    // 5125 (as much as is still in transit of them), the fee goes to 627 (OMFP 1802/2014 pct. 302
    // alin. (2); the function of 627).
    if (input.cards) {
      const cards = input.cards;
      if (!received || foreign)
        issues.push(block('CARDS', 'Decontarea cardurilor este o încasare în lei.', 'cards'));
      const transit = new Map(
        (loaded.itemLines.get(itemLinesKey({ prefixes: [cards.account] })) ?? [])
          .filter((row) => row.account === cards.account)
          .map((row) => [row.item, row.debit - row.credit]),
      );
      cards.settles.forEach((settle, index) => {
        const minor = parseMoney(settle.amount, currency);
        const tag = `zreport:${settle.documentId}`;
        const held = transit.get(tag) ?? 0n;
        if (minor > held)
          issues.push(
            block(
              'CARDS_EXCESS',
              `Raportul Z are ${formatMoney(held, currency)} lei încasați cu cardul în curs de decontare, mai puțin decât ${settle.amount}.`,
              `cards.settles.${index}`,
            ),
          );
        transit.set(tag, held - minor);
        explained += minor;
        settledBani += minor;
        lines.push({
          account: cards.account,
          side: 'C',
          bani: minor,
          analytics: { item: tag },
          memo: 'Decontare carduri',
        });
      });
      const fee = parseMoney(cards.fee, currency);
      if (fee > 0n) {
        explained -= fee;
        settledBani -= fee;
        lines.push({
          account: cards.feeAccount,
          side: 'D',
          bani: fee,
          memo: 'Comision acceptare carduri',
        });
      }
    }
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
