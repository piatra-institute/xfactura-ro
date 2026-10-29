import { z } from 'zod';
import { vatPeriodOf, type Effect, type Issue, type LineSpec, type Treatment } from '../../kernel';
import { formatMoney } from '../../money';
import { monthEnd, parseLocalDate, type LocalDate, type Month } from '../../time';

const block = (code: string, message: string, path?: string): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
});

export const vatSettlementInput = z
  .object({
    /** The VAT period: a month (2026-10) or, for quarterly payers, a quarter (2026-Q4). */
    period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/),
    date: z
      .string()
      .refine((value): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value))
      .transform((value) => parseLocalDate(value)),
    /** The tax authority (ANAF) as a partner: the payable or refundable balance is owed to or by it. */
    authorityId: z.uuid(),
    /** The VAT return or worksheet the settlement follows. */
    evidenceId: z.uuid(),
    /** A later round settles entries that reached the period after an earlier settlement. */
    round: z.number().int().min(1).max(99).default(1),
  })
  .strict();
export type VatSettlementInput = z.infer<typeof vatSettlementInput>;

/** The last day of a VAT period. */
export function vatPeriodEnd(period: string): LocalDate {
  const quarter = /^(\d{4})-Q([1-4])$/.exec(period);
  if (quarter)
    return monthEnd(`${quarter[1]}-${String(Number(quarter[2]) * 3).padStart(2, '0')}` as Month);
  return monthEnd(period as Month);
}

/**
 * Settles a VAT period: clears what its tax entries booked on 4427 (output) and 4426 (deductible
 * input), net of earlier settlement rounds, into 4423 (payable) when output exceeds input, or
 * 4424 (refundable) otherwise, as an open item of the tax authority. Input VAT not yet exigible
 * (4428) is not part of it. Whether a refundable balance is refunded or carried forward is the
 * return's choice and a separate entry.
 */
export const vatSettlement: Treatment<VatSettlementInput> = {
  id: 'vat.settle',
  version: 1,
  description:
    'Regularizarea TVA a unei perioade: TVA colectată și deductibilă închise în TVA de plată (4423) sau de recuperat (4424).',
  input: vatSettlementInput,
  agent: true,
  subject: (input) => `vat.settle:${input.period}:${input.round}`,
  plan: (input) => ({
    evidence: [input.evidenceId],
    parties: [input.authorityId],
    taxPeriods: [{ tax: 'VAT', period: input.period }],
    profile: true,
  }),
  evaluate(input, loaded) {
    const issues: Issue[] = [];
    const end = vatPeriodEnd(input.period);
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(block('EVIDENCE', 'Documentul justificativ nu este disponibil.', 'evidenceId'));
    const authority = loaded.parties.get(input.authorityId);
    if (authority?.kind !== 'ro_public_institution')
      issues.push(
        block(
          'AUTHORITY',
          'Partenerul trebuie să fie autoritatea fiscală (instituție publică).',
          'authorityId',
        ),
      );
    if (vatPeriodOf(loaded, end) !== input.period)
      issues.push(
        block(
          'VAT_PERIOD',
          `Perioada fiscală a companiei pentru ${end} este ${vatPeriodOf(loaded, end)}, nu ${input.period}.`,
          'period',
        ),
      );
    if (input.date < end)
      issues.push(
        block(
          'SETTLEMENT_DATE',
          `Regularizarea se face după încheierea perioadei (${end}).`,
          'date',
        ),
      );

    const ledger = loaded.taxLedger.get(`VAT|${input.period}`);
    const sum = (direction: 'output' | 'input') =>
      (ledger?.entries ?? [])
        .filter((entry) => entry.direction === direction)
        .reduce((total, entry) => total + entry.ledgerBani, 0n);
    // Earlier rounds: debits of 4427 and credits of 4426 already cleared part of the period.
    const settled = (account: string, side: 'D' | 'C') =>
      (ledger?.settlements ?? [])
        .filter((line) => line.account === account)
        .reduce((total, line) => total + (line.side === side ? line.bani : -line.bani), 0n);
    const output = sum('output') - settled('4427', 'D');
    const input_ = sum('input') - settled('4426', 'C');
    if (output === 0n && input_ === 0n)
      issues.push(
        block('NOTHING_TO_SETTLE', `Perioada ${input.period} nu are TVA de regularizat.`),
      );
    if (issues.length) return { effect: null, issues };

    const taxSettlement = { tax: 'VAT', period: input.period };
    const lines: LineSpec[] = [];
    if (output !== 0n) lines.push({ account: '4427', side: 'D', bani: output, taxSettlement });
    if (input_ !== 0n) lines.push({ account: '4426', side: 'C', bani: input_, taxSettlement });
    const balance = output - input_;
    const payable = balance > 0n;
    const item = {
      ref: 'vat',
      kind: payable ? ('tax.payable' as const) : ('tax.receivable' as const),
      controlAccount: payable ? '4423' : '4424',
      partyId: input.authorityId,
      currency: 'RON',
      normalSide: payable ? ('C' as const) : ('D' as const),
      mayReverse: false,
    };
    if (balance !== 0n)
      lines.push({
        account: item.controlAccount,
        side: payable ? 'C' : 'D',
        bani: payable ? balance : -balance,
        openItem: item.ref,
        partyId: input.authorityId,
      });
    const effect: Effect = {
      schema: 'effect@1',
      date: input.date,
      journalClass: 'general',
      journalCode: 'TVA',
      description: `Regularizare TVA ${input.period}${input.round > 1 ? ` (runda ${input.round})` : ''}`,
      lines,
      openItems: balance === 0n ? [] : [item],
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: `TVA colectată ${formatMoney(output, 'RON')}, deductibilă ${formatMoney(input_, 'RON')}: ${
          balance === 0n
            ? 'sold zero'
            : `${payable ? 'de plată' : 'de recuperat'} ${formatMoney(payable ? balance : -balance, 'RON')}`
        } lei.`,
        details: { period: input.period, round: input.round, entries: ledger?.entries.length ?? 0 },
      },
    };
    return { effect, issues };
  },
};
