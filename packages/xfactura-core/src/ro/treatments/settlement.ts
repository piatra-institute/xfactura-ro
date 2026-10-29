import { z } from 'zod';
import {
  accountCodePattern,
  type Effect,
  type FxRate,
  type Issue,
  type LineSpec,
  type Treatment,
} from '../../kernel';
import { convertMinor, divRound, formatMoney, LEDGER_CURRENCY, parseMoney } from '../../money';
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
    description: z.string().trim().min(3).max(500).optional(),
  })
  .strict()
  .refine(
    (input) => input.allocations.length + input.lines.length > 0,
    'Explicați mișcarea bancară.',
  );
export type SettlementInput = z.infer<typeof settlementInput>;

/**
 * Explains one reported bank movement in full: money received settles receivables (and money
 * paid settles payables) item by item, partially or grouped, and any remainder goes to named
 * accounts without partners. Nothing is left unexplained and no item is settled past zero.
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
    openItems: [{ ids: input.allocations.map((allocation) => allocation.openItem) }],
  }),
  followUp(input, loaded) {
    const movement = loaded.movements.get(input.movementId);
    return movement && movement.currency !== LEDGER_CURRENCY
      ? { fx: [{ currency: movement.currency, until: movement.bookingDate }] }
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
    const side = received ? 'C' : 'D';
    const lines: LineSpec[] = [
      withCurrency(
        { account: movement.ledgerAccount, side: received ? 'D' : 'C', bani: bank },
        total,
      ),
    ];
    let explained = 0n;
    let settledBani = 0n;
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
    const effect: Effect = {
      schema: 'effect@1',
      date: movement.bookingDate,
      journalClass: 'general',
      journalCode: 'BANCA',
      description:
        input.description ??
        `${received ? 'Încasare' : 'Plată'} ${movement.reference}`.slice(0, 500),
      lines: lines.filter((line) => line.bani !== 0n),
      openItems: [],
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: `${received ? 'Încasare' : 'Plată'} de ${formatMoney(total, currency)} ${currency} din ${movement.bookingDate}${rate ? ` la cursul ${rate.rate}` : ''}.`,
        details: {
          movementId: movement.id,
          reference: movement.reference,
          counterparty: movement.counterparty,
        },
      },
    };
    return { effect, issues };
  },
};
