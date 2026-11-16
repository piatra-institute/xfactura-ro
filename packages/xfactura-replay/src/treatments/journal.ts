import { z } from 'zod';
import {
  accountCodePattern,
  type Effect,
  type Issue,
  type OpenItemKind,
  type OpenItemSpec,
  type Treatment,
} from 'xfactura-core/kernel';
import { isSupportedCurrency, LEDGER_CURRENCY, parseMoney } from 'xfactura-core/money';
import { controlKindOf } from 'xfactura-core/ro/chart';
import { isLocalDate, type LocalDate } from 'xfactura-core/time';

const date = z
  .string()
  .refine(isLocalDate, 'Dată calendaristică invalidă.')
  .transform((value) => value as LocalDate);
const amount = z
  .string()
  .regex(/^-?(0|[1-9]\d{0,15})(\.\d{1,2})?$/, 'Folosiți cel mult două zecimale.');
const minor = z
  .string()
  .regex(/^-?(0|[1-9]\d{0,18})$/, 'Folosiți o sumă întreagă în unități minore.');
const text = z.string().min(1).max(100);
const itemRef = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const currencyAmount = z
  .object({
    code: z.string().refine(isSupportedCurrency, 'Monedă necunoscută.'),
    amount,
    rate: z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,8})?$/),
    rateId: text,
  })
  .strict()
  .superRefine((value, context) => {
    if (!isSupportedCurrency(value.code)) return;
    try {
      parseMoney(value.amount, value.code);
    } catch {
      context.addIssue({
        code: 'custom',
        path: ['amount'],
        message: 'Suma are prea multe zecimale pentru această monedă.',
      });
    }
  });

export const migrationJournalInput = z
  .object({
    // A colon-free source keeps the subject's source/reference boundary unambiguous.
    source: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
    reference: text,
    evidenceId: z.uuid(),
    date,
    journalCode: text,
    description: z.string().min(1).max(1000),
    lines: z
      .array(
        z
          .object({
            account: z.string().regex(accountCodePattern),
            side: z.enum(['D', 'C']),
            amount,
            partyId: z.uuid().optional(),
            openItem: z.uuid().optional(),
            newItem: itemRef.optional(),
            currency: currencyAmount.optional(),
            analytics: z
              .object({
                costCenter: text.optional(),
                project: text.optional(),
                item: text.optional(),
              })
              .strict()
              .optional(),
            memo: z.string().min(1).max(500).optional(),
            taxSettlement: z.object({ tax: text, period: text }).strict().optional(),
          })
          .strict()
          .refine(
            (line) => !(line.openItem && line.newItem),
            'O linie are o singură poziție deschisă.',
          ),
      )
      .min(2)
      .max(2000),
    newItems: z
      .array(
        z
          .object({
            ref: itemRef,
            partyId: z.uuid(),
            dueDate: date.optional(),
            documentId: z.uuid().optional(),
            mayReverse: z.boolean().optional(),
          })
          .strict(),
      )
      .max(2000)
      .refine(
        (items) => new Set(items.map((item) => item.ref)).size === items.length,
        'Referințele pozițiilor noi trebuie să fie distincte.',
      )
      .default([]),
    taxEntries: z
      .array(
        z
          .object({
            key: text,
            tax: text,
            code: text,
            direction: z.enum(['input', 'output']),
            base: amount,
            amount,
            deductible: amount,
            taxPoint: date,
            exigibility: date.nullable(),
            taxPeriod: text.nullable(),
            line: z.number().int().nonnegative().optional(),
            booked: amount,
            partyId: z.uuid().optional(),
            documentId: z.uuid().optional(),
            originTaxEntry: z.string().min(1).max(250).optional(),
            currency: z
              .object({
                code: currencyAmount.shape.code,
                baseMinor: minor,
                taxMinor: minor,
                rate: currencyAmount.shape.rate,
                rateId: text,
              })
              .strict()
              .optional(),
            attributes: z.record(z.string(), z.string()),
          })
          .strict(),
      )
      .max(4000)
      .default([]),
  })
  .strict();

export type MigrationJournalInput = z.infer<typeof migrationJournalInput>;

const debitKinds = new Set<OpenItemKind>([
  'receivable',
  'advance.paid',
  'accrual.receivable',
  'deferral.expense',
  'tax.receivable',
  'unapplied.payment',
]);

const block = (code: string, message: string, path: string): Issue => ({
  code,
  severity: 'block',
  message,
  path,
});

/** Replays supplied journal and tax amounts; only a private engine registers this treatment. */
export const migrationJournal: Treatment<MigrationJournalInput> = {
  id: 'migration.journal',
  version: 1,
  description: 'Preluarea unei note contabile exact cum a fost înregistrată în sursă.',
  summary: 'Replays an accountant’s journal entry with its supplied tax entries and open items.',
  input: migrationJournalInput,
  agent: false,
  subject: (input) => `migration:${input.source}:${input.reference}`,
  plan: (input) => ({
    evidence: [input.evidenceId],
    openItems: [{ ids: [...new Set(input.lines.flatMap((line) => line.openItem ?? []))] }],
    parties: [
      ...new Set([
        ...input.lines.flatMap((line) => line.partyId ?? []),
        ...input.newItems.map((item) => item.partyId),
        ...input.taxEntries.flatMap((entry) => entry.partyId ?? []),
      ]),
    ],
    documents: [
      ...new Set([
        ...input.newItems.flatMap((item) => item.documentId ?? []),
        ...input.taxEntries.flatMap((entry) => entry.documentId ?? []),
      ]),
    ],
  }),
  evaluate(input, loaded) {
    const issues: Issue[] = [];
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(block('EVIDENCE', 'Fișierul sursă nu este disponibil.', 'evidenceId'));

    const checkParty = (id: string | undefined, path: string) => {
      if (id !== undefined && !loaded.parties.has(id))
        issues.push(block('PARTY', 'Partenerul nu este disponibil.', path));
    };
    const checkDocument = (id: string | undefined, path: string) => {
      if (id !== undefined && !loaded.documents.has(id))
        issues.push(block('DOCUMENT', 'Documentul nu este disponibil.', path));
    };
    input.newItems.forEach((item, index) => {
      checkParty(item.partyId, `newItems.${index}.partyId`);
      checkDocument(item.documentId, `newItems.${index}.documentId`);
      if (!input.lines.some((line) => line.newItem === item.ref))
        issues.push(
          block('NEW_ITEM_UNUSED', 'Poziția nouă nu are nicio linie.', `newItems.${index}`),
        );
    });

    const declared = new Map(input.newItems.map((item) => [item.ref, item]));
    const created = new Map<string, OpenItemSpec>();
    const lines: Effect['lines'] = input.lines.map((line, index) => {
      const path = `lines.${index}`;
      checkParty(line.partyId, `${path}.partyId`);
      if (line.openItem && !loaded.openItems.has(line.openItem))
        issues.push(
          block('OPEN_ITEM_UNKNOWN', 'Poziția deschisă nu este disponibilă.', `${path}.openItem`),
        );
      if (line.newItem) {
        const item = declared.get(line.newItem);
        const kind = controlKindOf(line.account);
        if (!item)
          issues.push(block('NEW_ITEM', 'Poziția nouă nu este declarată.', `${path}.newItem`));
        else if (!kind || kind === 'tax' || kind === 'retail')
          issues.push(
            block('NOT_CONTROL_ACCOUNT', `Contul ${line.account} nu are poziții deschise.`, path),
          );
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
            ...(item.documentId ? { documentId: item.documentId } : {}),
          });
      }
      const { amount: lineAmount, currency, newItem, ...rest } = line;
      const partyId = line.partyId ?? (newItem ? declared.get(newItem)?.partyId : undefined);
      return {
        ...rest,
        bani: parseMoney(lineAmount, LEDGER_CURRENCY),
        ...(currency
          ? {
              currency: {
                code: currency.code,
                minor: parseMoney(currency.amount, currency.code),
                rate: currency.rate,
                rateId: currency.rateId,
              },
            }
          : {}),
        ...(partyId ? { partyId } : {}),
        ...(newItem ? { openItem: newItem } : {}),
      };
    });
    const taxEntries: Effect['taxEntries'] = input.taxEntries.map((entry, index) => {
      const path = `taxEntries.${index}`;
      checkParty(entry.partyId, `${path}.partyId`);
      checkDocument(entry.documentId, `${path}.documentId`);
      if (
        entry.line !== undefined &&
        controlKindOf(input.lines[entry.line]?.account ?? '') !== 'tax'
      )
        issues.push(
          block('TAX_ENTRY_LINE', 'Intrarea fiscală nu indică o linie pe un cont de taxă.', path),
        );
      const { base, amount: taxAmount, deductible, booked, currency, ...rest } = entry;
      return {
        ...rest,
        baseBani: parseMoney(base, LEDGER_CURRENCY),
        taxBani: parseMoney(taxAmount, LEDGER_CURRENCY),
        deductibleBani: parseMoney(deductible, LEDGER_CURRENCY),
        ledgerBani: parseMoney(booked, LEDGER_CURRENCY),
        ...(currency
          ? {
              currency: {
                code: currency.code,
                baseMinor: BigInt(currency.baseMinor),
                taxMinor: BigInt(currency.taxMinor),
                rate: currency.rate,
                rateId: currency.rateId,
              },
            }
          : {}),
      };
    });
    return {
      effect: {
        schema: 'effect@1',
        date: input.date,
        journalClass: 'general',
        journalCode: input.journalCode,
        description: input.description,
        lines,
        openItems: [...created.values()],
        taxEntries,
        schedules: [],
        explanation: {
          summary: input.description,
          details: {
            source: input.source,
            reference: input.reference,
            evidenceId: input.evidenceId,
          },
        },
      },
      issues,
    };
  },
};
