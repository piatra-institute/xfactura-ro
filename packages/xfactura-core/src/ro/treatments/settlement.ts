import { z } from 'zod';
import {
  accountCodePattern,
  type Effect,
  type Issue,
  type LineSpec,
  type Treatment,
} from '../../kernel';
import { formatMoney, LEDGER_CURRENCY, parseMoney } from '../../money';
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
  evaluate(input, loaded) {
    const movement = loaded.movements.get(input.movementId);
    if (!movement)
      return {
        effect: null,
        issues: [block('MOVEMENT', 'Mișcarea bancară nu este disponibilă.', 'movementId')],
      };
    const issues: Issue[] = [];
    if (movement.currency !== LEDGER_CURRENCY)
      issues.push(block('CURRENCY', 'Mișcările în valută cer tratamentul de curs valutar.'));
    const received = movement.amountMinor > 0n;
    const total = received ? movement.amountMinor : -movement.amountMinor;
    // Settlement lines sit opposite the bank line: credits for receipts, debits for payments.
    const side = received ? 'C' : 'D';
    const lines: LineSpec[] = [
      { account: movement.ledgerAccount, side: received ? 'D' : 'C', bani: total },
    ];
    let explained = 0n;
    input.allocations.forEach((allocation, index) => {
      const item = loaded.openItems.get(allocation.openItem);
      const bani = parseMoney(allocation.amount, LEDGER_CURRENCY);
      explained += bani;
      if (!item) {
        issues.push(
          block('OPEN_ITEM', 'Poziția deschisă nu este disponibilă.', `allocations.${index}`),
        );
        return;
      }
      lines.push({
        account: item.controlAccount,
        side,
        bani,
        openItem: item.id,
        partyId: item.partyId,
      });
    });
    input.lines.forEach((line, index) => {
      const bani = parseMoney(line.amount, LEDGER_CURRENCY);
      explained += bani;
      if (controlKindOf(line.account))
        issues.push(
          block(
            'CONTROL_ACCOUNT',
            `Contul ${line.account} se decontează prin poziții deschise.`,
            `lines.${index}`,
          ),
        );
      lines.push({ account: line.account, side, bani, ...(line.memo ? { memo: line.memo } : {}) });
    });
    if (explained !== total)
      issues.push(
        block(
          'UNEXPLAINED',
          `Sumele explicate (${formatMoney(explained, LEDGER_CURRENCY)}) diferă de mișcare (${formatMoney(total, LEDGER_CURRENCY)}).`,
        ),
      );
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };
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
        summary: `${received ? 'Încasare' : 'Plată'} de ${formatMoney(total, LEDGER_CURRENCY)} lei din ${movement.bookingDate}.`,
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
