import { z } from 'zod';
import {
  accountCodePattern,
  financialYearOf,
  type Effect,
  type Issue,
  type LineSpec,
  type OpenItemKind,
  type OpenItemSpec,
  type Side,
  type TaxEntrySpec,
  type Treatment,
} from '../../kernel';
import { isSupportedCurrency, LEDGER_CURRENCY, parseMoney } from '../../money';
import { isLocalDate, type LocalDate } from '../../time';
import { controlKindOf } from '../chart';

const date = z
  .string()
  .refine(isLocalDate, 'Dată calendaristică invalidă.')
  .transform((value) => value as LocalDate);
const signedAmount = z
  .string()
  .regex(/^-?(0|[1-9]\d{0,15})(\.\d{1,2})?$/, 'Folosiți o sumă cu cel mult două zecimale.');
const decimal = z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,8})?$/);
const reference = z.string().trim().min(1).max(100);
const itemRef = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);

const block = (code: string, message: string, path?: string): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
});

/** Kinds whose balance normally sits on the debit side. */
const debitKinds = new Set<OpenItemKind>([
  'receivable',
  'advance.paid',
  'accrual.receivable',
  'deferral.expense',
  'tax.receivable',
  'unapplied.payment',
]);

const lineInput = z
  .object({
    account: z.string().regex(accountCodePattern),
    side: z.enum(['D', 'C']),
    amount: signedAmount,
    partyId: z.uuid().optional(),
    /** An existing open item this line settles or adjusts. */
    openItem: z.uuid().optional(),
    /** A new open item, declared in `newItems`, this line creates. */
    newItem: itemRef.optional(),
    currency: z
      .object({
        code: z.string().regex(/^[A-Z]{3}$/),
        amount: signedAmount,
        rate: decimal,
        rateId: z.string().min(1).max(100),
      })
      .strict()
      .optional(),
    costCenter: z.string().trim().min(1).max(50).optional(),
    project: z.string().trim().min(1).max(50).optional(),
    memo: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .refine((line) => !(line.openItem && line.newItem), 'O linie are o singură poziție deschisă.');

export const generalJournalInput = z
  .object({
    date,
    purpose: z.enum(['opening', 'general', 'adjustment']),
    reference,
    description: z.string().trim().min(3).max(1000),
    evidenceId: z.uuid(),
    lines: z.array(lineInput).min(2).max(2000),
    newItems: z
      .array(
        z
          .object({
            ref: itemRef,
            partyId: z.uuid(),
            dueDate: date.optional(),
            mayReverse: z.boolean().optional(),
          })
          .strict(),
      )
      .max(2000)
      .default([]),
  })
  .strict();
export type GeneralJournalInput = z.infer<typeof generalJournalInput>;

/**
 * An explicit journal entry: an opening position at the start of a financial year, a general
 * entry, or an adjustment. Lines on control accounts name the open item they create or settle,
 * so receivables, payables and other subledgers stay itemized by partner. It records no tax
 * entries: VAT and other taxes go through their own treatments.
 */
export const generalJournal: Treatment<GeneralJournalInput> = {
  id: 'ledger.general',
  version: 1,
  description:
    'Notă contabilă explicită: poziție de deschidere, înregistrare generală sau ajustare, cu documentul justificativ.',
  input: generalJournalInput,
  agent: true,
  subject: (input) =>
    input.purpose === 'opening' ? `opening:${input.date}` : `${input.purpose}:${input.reference}`,
  plan: (input) => ({
    evidence: [input.evidenceId],
    openItems: [{ ids: input.lines.flatMap((line) => (line.openItem ? [line.openItem] : [])) }],
    parties: [...new Set(input.newItems.map((item) => item.partyId))],
  }),
  evaluate(input, loaded) {
    const issues: Issue[] = [];
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(block('EVIDENCE', 'Documentul justificativ nu este disponibil.', 'evidenceId'));
    if (input.purpose === 'opening' && financialYearOf(loaded, input.date)?.from !== input.date)
      issues.push(
        block(
          'OPENING_DATE',
          'Poziția de deschidere se înregistrează la începutul exercițiului.',
          'date',
        ),
      );

    const declared = new Map(input.newItems.map((item) => [item.ref, item]));
    const created = new Map<string, OpenItemSpec>();
    const lines: LineSpec[] = input.lines.map((line, index) => {
      const path = `lines.${index}`;
      if (
        line.currency &&
        (!isSupportedCurrency(line.currency.code) || line.currency.code === LEDGER_CURRENCY)
      )
        issues.push(block('CURRENCY', 'Moneda liniei nu este acceptată.', `${path}.currency`));
      if (line.newItem) {
        const item = declared.get(line.newItem);
        const kind = controlKindOf(line.account);
        if (!item)
          issues.push(block('NEW_ITEM', 'Poziția nouă nu este declarată.', `${path}.newItem`));
        else if (!kind || kind === 'tax')
          issues.push(
            block('NOT_CONTROL_ACCOUNT', `Contul ${line.account} nu are poziții deschise.`, path),
          );
        else if (!loaded.parties.has(item.partyId))
          issues.push(block('PARTY', 'Partenerul nu este disponibil.', `${path}.newItem`));
        else if (!created.has(item.ref))
          created.set(item.ref, {
            ref: item.ref,
            kind,
            controlAccount: line.account,
            partyId: item.partyId,
            currency: line.currency?.code ?? LEDGER_CURRENCY,
            normalSide: debitKinds.has(kind) ? 'D' : 'C',
            mayReverse: item.mayReverse ?? false,
            ...(item.dueDate ? { dueDate: item.dueDate } : {}),
          });
      }
      const partyId =
        line.partyId ?? (line.newItem ? declared.get(line.newItem)?.partyId : undefined);
      const analytics = {
        ...(line.costCenter ? { costCenter: line.costCenter } : {}),
        ...(line.project ? { project: line.project } : {}),
      };
      return {
        account: line.account,
        side: line.side,
        bani: parseMoney(line.amount, LEDGER_CURRENCY),
        ...(line.currency && isSupportedCurrency(line.currency.code)
          ? {
              currency: {
                code: line.currency.code,
                minor: parseMoney(line.currency.amount, line.currency.code),
                rate: line.currency.rate,
                rateId: line.currency.rateId,
              },
            }
          : {}),
        ...(partyId ? { partyId } : {}),
        ...(line.openItem
          ? { openItem: line.openItem }
          : line.newItem
            ? { openItem: line.newItem }
            : {}),
        ...(Object.keys(analytics).length ? { analytics } : {}),
        ...(line.memo ? { memo: line.memo } : {}),
      };
    });
    const effect: Effect = {
      schema: 'effect@1',
      date: input.date,
      journalClass: 'general',
      journalCode: input.purpose === 'opening' ? 'DESCHIDERE' : 'DIVERSE',
      description: input.description,
      lines,
      openItems: [...created.values()],
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: input.description,
        details: {
          purpose: input.purpose,
          reference: input.reference,
          evidenceId: input.evidenceId,
        },
      },
    };
    return { effect, issues };
  },
};

export const reversalInput = z
  .object({
    entryId: z.uuid(),
    date,
    reason: z.string().trim().min(10).max(1000),
    evidenceId: z.uuid(),
    /** Red storno repeats the lines with negative amounts; black storno swaps their sides. */
    method: z.enum(['red', 'black']),
  })
  .strict();
export type ReversalInput = z.infer<typeof reversalInput>;

const opposite = (side: Side): Side => (side === 'D' ? 'C' : 'D');

/**
 * Reverses a posted entry in full by storno. The original stays untouched; each line and tax
 * entry is mirrored, linked to its origin and reported in the period of the reversal. A
 * reversal that would push an already-settled open item past zero is refused.
 */
export const reversal: Treatment<ReversalInput> = {
  id: 'ledger.reverse',
  version: 1,
  description:
    'Stornarea integrală a unei înregistrări contabilizate, cu motivul și documentul justificativ.',
  input: reversalInput,
  agent: true,
  subject: (input) => `reverse:${input.entryId}`,
  plan: (input) => ({
    evidence: [input.evidenceId],
    entries: [input.entryId],
    openItems: [{ touchedBy: input.entryId }],
  }),
  evaluate(input, loaded) {
    const issues: Issue[] = [];
    const entry = loaded.entries.get(input.entryId);
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(block('EVIDENCE', 'Documentul justificativ nu este disponibil.', 'evidenceId'));
    if (!entry)
      return {
        effect: null,
        issues: [...issues, block('ENTRY', 'Înregistrarea nu este disponibilă.', 'entryId')],
      };
    if (input.date < entry.date)
      issues.push(
        block('REVERSAL_DATE', 'Stornarea nu poate precede înregistrarea inițială.', 'date'),
      );
    const red = input.method === 'red';
    const lines: LineSpec[] = entry.lines.map((line) => ({
      ...line,
      side: red ? line.side : opposite(line.side),
      bani: red ? -line.bani : line.bani,
      ...(line.currency
        ? {
            currency: { ...line.currency, minor: red ? -line.currency.minor : line.currency.minor },
          }
        : {}),
    }));
    const taxPeriod = input.date.slice(0, 7);
    const taxEntries: TaxEntrySpec[] = entry.taxEntries.map((tax) => ({
      ...tax,
      key: `reversal:${tax.key}`,
      baseBani: -tax.baseBani,
      taxBani: -tax.taxBani,
      deductibleBani: -tax.deductibleBani,
      ledgerBani: -tax.ledgerBani,
      taxPoint: input.date,
      exigibility: tax.exigibility === null ? null : input.date,
      taxPeriod: tax.taxPeriod === null ? null : taxPeriod,
      originTaxEntry: `${entry.id}:${tax.key}`,
      ...(tax.currency
        ? {
            currency: {
              ...tax.currency,
              baseMinor: -tax.currency.baseMinor,
              taxMinor: -tax.currency.taxMinor,
            },
          }
        : {}),
    }));
    const effect: Effect = {
      schema: 'effect@1',
      date: input.date,
      journalClass: 'general',
      journalCode: entry.journalCode,
      description: `Stornare nota ${entry.number}: ${input.reason}`,
      lines,
      openItems: [],
      taxEntries,
      schedules: [],
      explanation: {
        summary: `Stornarea integrală a notei ${entry.number} din ${entry.date}.`,
        details: {
          entryId: entry.id,
          method: input.method,
          reason: input.reason,
          evidenceId: input.evidenceId,
        },
      },
    };
    return { effect, issues };
  },
};
