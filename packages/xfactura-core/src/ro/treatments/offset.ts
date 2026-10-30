import { z } from 'zod';
import type { Effect, Issue, LineSpec, Treatment } from '../../kernel';
import { formatMoney, LEDGER_CURRENCY, parseMoney } from '../../money';
import { isLocalDate, type LocalDate } from '../../time';
import { releaseSettled, settledInvoices } from './settlement';

const block = (code: string, message: string, path?: string): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
});
const part = z
  .object({
    openItem: z.uuid(),
    amount: z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/),
  })
  .strict();

export const offsetInput = z
  .object({
    /** The day the offset takes effect: the date of the offset document. */
    date: z.string().refine((value): boolean => isLocalDate(value)),
    /** The offset document (proces-verbal or notificare de compensare). */
    evidenceId: z.uuid(),
    /** What the partner owes the company (debit items: receivables, advances paid, debtors). */
    receivables: z.array(part).min(1).max(50),
    /** What the company owes the partner (credit items: payables, advances received, creditors). */
    payables: z.array(part).min(1).max(50),
    description: z.string().trim().min(3).max(500).optional(),
  })
  .strict();
export type OffsetInput = z.infer<typeof offsetInput>;

/**
 * A bilateral offset (compensare): what a partner owes the company and what the company owes it
 * cancel each other for the same amount, on the date of the offset document, without money. An
 * invoice under VAT on collection is then collected or paid for the amount offset, and releases
 * its VAT (norme pct. 26 alin. (10): compensarea is a collection). Offsets between more than two
 * parties and foreign-currency items are not covered.
 */
export const offset: Treatment<OffsetInput> = {
  id: 'items.offset',
  version: 1,
  description: 'Compensarea creanțelor și datoriilor față de același partener.',
  input: offsetInput,
  agent: true,
  summary: 'Offset of receivables and payables with the same partner.',
  subject: (input) => `offset:${input.evidenceId}`,
  plan: (input) => ({
    evidence: [input.evidenceId],
    openItems: [
      {
        ids: [...input.receivables, ...input.payables].map((item) => item.openItem),
        history: true,
      },
    ],
  }),
  followUp(input, loaded) {
    return settledInvoices(
      loaded,
      [...input.receivables, ...input.payables].map((item) => item.openItem),
    );
  },
  evaluate(input, loaded) {
    const issues: Issue[] = [];
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(block('EVIDENCE', 'Documentul de compensare nu este disponibil.', 'evidenceId'));
    const lines: LineSpec[] = [];
    const settled: { openItem: string; bani: bigint; path: string }[] = [];
    const parties = new Set<string>();
    const side = (
      parts: OffsetInput['receivables'],
      name: 'receivables' | 'payables',
      normal: 'D' | 'C',
    ) => {
      let total = 0n;
      parts.forEach((entry, index) => {
        const path = `${name}.${index}`;
        const item = loaded.openItems.get(entry.openItem);
        const bani = parseMoney(entry.amount, LEDGER_CURRENCY);
        total += bani;
        if (!item) {
          issues.push(block('OPEN_ITEM', 'Poziția deschisă nu este disponibilă.', path));
          return;
        }
        if (item.normalSide !== normal)
          issues.push(
            block(
              'OFFSET_SIDE',
              normal === 'D'
                ? 'Poziția nu este o sumă datorată de partener.'
                : 'Poziția nu este o sumă datorată partenerului.',
              path,
            ),
          );
        if (item.currency !== LEDGER_CURRENCY)
          issues.push(block('CURRENCY', 'Compensarea în valută nu este încă tratată.', path));
        if (bani <= 0n) issues.push(block('AMOUNT', 'Suma este zero.', path));
        parties.add(item.partyId);
        // The receivable is credited and the payable debited, each against its open item.
        lines.push({
          account: item.controlAccount,
          side: normal === 'D' ? 'C' : 'D',
          bani,
          openItem: item.id,
          partyId: item.partyId,
        });
        settled.push({ openItem: item.id, bani, path });
      });
      return total;
    };
    const owed = side(input.receivables, 'receivables', 'D');
    const owing = side(input.payables, 'payables', 'C');
    if (owed !== owing)
      issues.push(
        block(
          'OFFSET_UNBALANCED',
          `Se compensează ${formatMoney(owed, LEDGER_CURRENCY)} lei datorați de partener cu ${formatMoney(owing, LEDGER_CURRENCY)} lei datorați lui: sumele trebuie să fie egale.`,
        ),
      );
    if (parties.size > 1)
      issues.push(
        block(
          'OFFSET_PARTIES',
          'Compensarea leagă poziții ale unui singur partener; compensările între mai mulți parteneri nu sunt încă tratate.',
        ),
      );
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };

    // An offset collects or pays the invoices under VAT on collection it settles.
    const release = releaseSettled(loaded, settled, input.date as LocalDate, lines);
    issues.push(...release.issues);
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };
    const effect: Effect = {
      schema: 'effect@1',
      date: input.date as LocalDate,
      journalClass: 'general',
      journalCode: 'DIVERSE',
      description: input.description ?? 'Compensare creanțe și datorii',
      lines,
      openItems: [],
      taxEntries: release.taxEntries,
      schedules: [],
      explanation: {
        summary: `${formatMoney(owed, LEDGER_CURRENCY)} lei compensați.`,
        details: {
          amount: formatMoney(owed, LEDGER_CURRENCY),
          ...(release.released.length ? { released: release.released } : {}),
        },
      },
    };
    return { effect, issues };
  },
};
