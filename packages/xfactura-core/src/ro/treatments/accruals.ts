import { z } from 'zod';
import type { Effect, Issue, LineSpec, Treatment } from '../../kernel';
import { formatMoney, LEDGER_CURRENCY, parseMoney } from '../../money';
import { isLocalDate, type LocalDate } from '../../time';

const block = (code: string, message: string, path?: string): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
});
const localDate = z.string().refine((value): boolean => isLocalDate(value));

export const accrualInput = z
  .object({
    /** The day the expense or revenue belongs to, usually the month's last. */
    date: localDate,
    /** The expense (6xx) or revenue (70x) account. */
    account: z.string().regex(/^(6\d{2,5}|70\d{1,4})$/),
    /** The amount without VAT, in lei. */
    amount: z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/),
    /** The supplier whose invoice has not arrived, or the customer not yet invoiced. */
    partyId: z.uuid(),
    /** What shows the service received or rendered: a contract, a timesheet, a report. */
    evidenceId: z.uuid(),
  })
  .strict();
export type AccrualInput = z.infer<typeof accrualInput>;

/**
 * A service received whose invoice has not arrived (408, furnizori - facturi nesosite) or
 * rendered and not yet invoiced (418, clienți - facturi de întocmit) is booked in its month
 * without VAT: the invoice brings the VAT when it is recognized, at its own tax point. The
 * accrual is an open item of the partner, and keeps the account it goes back to as a one-row
 * schedule, which `accruals.settle` reverses when the invoice is booked. Whether VAT not yet
 * chargeable belongs on 4428 at the accrual is the company's policy, not taken here.
 */
export const accrual: Treatment<AccrualInput> = {
  id: 'accruals.record',
  version: 1,
  description:
    'Furnizori - facturi nesosite (408) sau clienți - facturi de întocmit (418), fără TVA.',
  input: accrualInput,
  agent: true,
  subject: (input) => `accrual:${input.evidenceId}:${input.account}:${input.date}`,
  plan: (input) => ({ evidence: [input.evidenceId], parties: [input.partyId] }),
  evaluate(input, loaded) {
    const issues: Issue[] = [];
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(block('EVIDENCE', 'Documentul justificativ nu este disponibil.', 'evidenceId'));
    if (!loaded.parties.has(input.partyId))
      issues.push(block('PARTY', 'Partenerul nu există.', 'partyId'));
    const amount = parseMoney(input.amount, LEDGER_CURRENCY);
    if (amount <= 0n) issues.push(block('AMOUNT', 'Suma este zero.', 'amount'));
    if (issues.length) return { effect: null, issues };

    const revenue = input.account.startsWith('7');
    const control = revenue ? '418' : '408';
    const accrued = { openItem: 'accrual', partyId: input.partyId };
    const lines: LineSpec[] = revenue
      ? [
          { account: control, side: 'D', bani: amount, ...accrued },
          { account: input.account, side: 'C', bani: amount },
        ]
      : [
          { account: input.account, side: 'D', bani: amount },
          { account: control, side: 'C', bani: amount, ...accrued },
        ];
    const effect: Effect = {
      schema: 'effect@1',
      date: input.date as LocalDate,
      journalClass: 'general',
      journalCode: 'DIVERSE',
      description: revenue ? 'Clienți - facturi de întocmit' : 'Furnizori - facturi nesosite',
      lines,
      openItems: [
        {
          ref: 'accrual',
          kind: revenue ? 'accrual.receivable' : 'accrual.payable',
          controlAccount: control,
          partyId: input.partyId,
          currency: LEDGER_CURRENCY,
          normalSide: revenue ? 'D' : 'C',
          mayReverse: false,
        },
      ],
      taxEntries: [],
      schedules: [
        {
          ref: 'reversal',
          openItem: 'accrual',
          version: 1,
          method: 'reversal_on_invoice',
          rows: [
            {
              key: 'invoice',
              due: input.date as LocalDate,
              bani: amount,
              counterAccount: input.account,
            },
          ],
          basis: { account: input.account },
        },
      ],
      explanation: {
        summary: `${formatMoney(amount, LEDGER_CURRENCY)} lei în ${input.account}, pe ${control} până la factură.`,
        details: { account: input.account },
      },
    };
    return { effect, issues };
  },
};

export const accrualSettlementInput = z
  .object({
    /** The accrual (its open item on 408 or 418). */
    accrualId: z.uuid(),
    /** The invoice that arrived or was issued for it. */
    documentId: z.uuid(),
    /** The day the accrual is reversed: the invoice's, in its own month. */
    date: localDate,
  })
  .strict();
export type AccrualSettlementInput = z.infer<typeof accrualSettlementInput>;

/**
 * The invoice for an accrued service has been booked: the accrual is reversed on the invoice's
 * day (Dr 408 / Cr expense, or Dr revenue / Cr 418), so the period keeps the expense or revenue
 * once, from the accrual, and the difference between the invoice and the estimate falls in the
 * invoice's month.
 */
export const accrualSettlement: Treatment<AccrualSettlementInput> = {
  id: 'accruals.settle',
  version: 1,
  description: 'Stornarea unei facturi nesosite sau de întocmit, la sosirea facturii.',
  input: accrualSettlementInput,
  agent: true,
  subject: (input) => `accrual-settlement:${input.accrualId}`,
  plan: (input) => ({
    documents: [input.documentId],
    openItems: [{ ids: [input.accrualId], schedules: true }],
  }),
  evaluate(input, loaded) {
    const issues: Issue[] = [];
    const item = loaded.openItems.get(input.accrualId);
    const document = loaded.documents.get(input.documentId);
    if (!item || (item.kind !== 'accrual.payable' && item.kind !== 'accrual.receivable'))
      return {
        effect: null,
        issues: [
          block('ACCRUAL', 'Poziția nu este o factură nesosită sau de întocmit.', 'accrualId'),
        ],
      };
    if (!document) issues.push(block('DOCUMENT', 'Factura nu este disponibilă.', 'documentId'));
    else if (document.partyId !== item.partyId)
      issues.push(block('PARTY', 'Factura este a altui partener.', 'documentId'));
    const open = item.normalSide === 'C' ? -item.balanceBani : item.balanceBani;
    if (open <= 0n) issues.push(block('SETTLED', 'Poziția este deja stornată.', 'accrualId'));
    const account = item.schedule?.rows[0]?.counterAccount;
    if (!account)
      issues.push(
        block('ACCRUAL', 'Poziția nu indică contul în care s-a înregistrat.', 'accrualId'),
      );
    if (issues.length) return { effect: null, issues };

    const revenue = item.kind === 'accrual.receivable';
    const accrued = { openItem: item.id, partyId: item.partyId };
    const lines: LineSpec[] = revenue
      ? [
          { account: account!, side: 'D', bani: open },
          { account: item.controlAccount, side: 'C', bani: open, ...accrued },
        ]
      : [
          { account: item.controlAccount, side: 'D', bani: open, ...accrued },
          { account: account!, side: 'C', bani: open },
        ];
    const effect: Effect = {
      schema: 'effect@1',
      date: input.date as LocalDate,
      journalClass: 'general',
      journalCode: 'DIVERSE',
      description: `Stornare ${revenue ? 'factură de întocmit' : 'factură nesosită'} la ${document!.number ?? 'factura'}`,
      lines,
      openItems: [],
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: `${formatMoney(open, LEDGER_CURRENCY)} lei stornați din ${item.controlAccount} în ${account}.`,
        details: { documentId: input.documentId },
      },
    };
    return { effect, issues };
  },
};
