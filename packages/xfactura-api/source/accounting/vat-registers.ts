import { and, asc, eq, gt, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import { Commands, type Actor } from './commands';
import type { Transaction } from './db';
import {
  canonical,
  dateSchema,
  fromBani,
  generalBodySchema,
  idSchema,
  requireCondition,
  toBani,
} from './domain';
import { decimalString, hashSchema, yearOutput } from './capability-contracts';
import { financialYearForDate } from './foundation';
import { sha256 } from './object-store';
import {
  accountingYears,
  evidence,
  invoiceDocuments,
  invoicePostings,
  journalLines,
  journals,
  proposals,
} from './schema';

export const vatPeriodInput = z
  .object({ financialYearId: idSchema, from: dateSchema.optional(), to: dateSchema.optional() })
  .strict();
export const vatEntriesInput = vatPeriodInput
  .extend({
    direction: z.enum(['purchase', 'sale']).optional(),
    limit: z.number().int().min(1).max(100).default(25),
    cursor: idSchema.optional(),
  })
  .strict();
export const vatEntryOutput = z.object({
  invoiceId: idSchema,
  journalId: idSchema,
  proposalHash: hashSchema,
  evidenceId: idSchema,
  sourceHash: hashSchema,
  invoiceHash: hashSchema,
  number: z.string(),
  direction: z.enum(['purchase', 'sale']),
  documentType: z.enum(['invoice', 'credit_note']),
  issueDate: dateSchema,
  recognitionDate: dateSchema,
  originalTaxPointDate: dateSchema,
  originalInvoiceId: idSchema.nullable(),
  category: z.string(),
  rate: z.string(),
  base: decimalString,
  sourceTax: decimalString,
  gross: decimalString,
  inputTax: decimalString,
  outputTax: decimalString,
  deduction: z.enum(['full', 'none']),
  ruleId: z.string(),
  ruleHash: hashSchema,
  registrationIds: z.array(idSchema),
});
const totalsOutput = z.object({
  base: decimalString,
  sourceTax: decimalString,
  gross: decimalString,
  inputTax: decimalString,
  outputTax: decimalString,
});
const vatIssueOutput = z.object({
  code: z.enum([
    'UNPOSTED_INVOICE',
    'UNCLASSIFIED_JOURNAL',
    'INPUT_VAT_DIFFERENCE',
    'OUTPUT_VAT_DIFFERENCE',
  ]),
  invoiceId: idSchema.nullable(),
  journalId: idSchema.nullable(),
});
export const vatSummaryOutput = z.object({
  scope: z.literal('posted_domestic_service_treatments'),
  officialDeclaration: z.literal(false),
  financialYear: yearOutput,
  from: dateSchema,
  to: dateSchema,
  entryCount: z.number().int(),
  totals: totalsOutput,
  groups: z.array(
    totalsOutput.extend({
      direction: z.enum(['purchase', 'sale']),
      category: z.string(),
      rate: z.string(),
      entryCount: z.number().int(),
    }),
  ),
  reconciliation: z.object({
    ledgerInputTax: decimalString,
    ledgerOutputTax: decimalString,
    inputDifference: decimalString,
    outputDifference: decimalString,
  }),
  status: z.enum(['reconciled', 'needs_review']),
  issues: z.array(vatIssueOutput),
  hash: hashSchema,
});
type Period = z.infer<typeof vatPeriodInput>;
type Entry = z.infer<typeof vatEntryOutput>;

async function period(tx: Transaction, companyId: string, input: Period) {
  const [year] = await tx
    .select()
    .from(accountingYears)
    .where(
      and(
        eq(accountingYears.companyId, companyId),
        eq(accountingYears.id, input.financialYearId),
        eq(accountingYears.kind, 'financial'),
      ),
    );
  requireCondition(year, 'NOT_FOUND', 'Exercițiul financiar nu este disponibil.', 404);
  const from = input.from ?? year.from,
    to = input.to ?? year.to;
  requireCondition(
    from <= to && from >= year.from && to <= year.to,
    'PERIOD_SCOPE',
    'Intervalul trebuie să aparțină exercițiului financiar selectat.',
  );
  // Use the same company/date boundary as posting and the general ledger.
  requireCondition(
    (await financialYearForDate(tx, companyId, from)).id === year.id,
    'FINANCIAL_YEAR',
    'Exercițiul financiar nu corespunde intervalului.',
  );
  return { financialYear: year, from, to };
}

async function entries(
  tx: Transaction,
  companyId: string,
  range: { from: string; to: string },
  page?: z.infer<typeof vatEntriesInput>,
) {
  const query = tx
    .select({
      invoice: invoiceDocuments,
      journal: journals,
      proposal: proposals,
      sourceHash: evidence.hash,
    })
    .from(invoicePostings)
    .innerJoin(
      invoiceDocuments,
      and(
        eq(invoiceDocuments.companyId, invoicePostings.companyId),
        eq(invoiceDocuments.id, invoicePostings.invoiceId),
      ),
    )
    .innerJoin(
      evidence,
      and(
        eq(evidence.companyId, invoiceDocuments.companyId),
        eq(evidence.id, invoiceDocuments.evidenceId),
      ),
    )
    .innerJoin(
      journals,
      and(
        eq(journals.companyId, invoicePostings.companyId),
        eq(journals.id, invoicePostings.journalId),
      ),
    )
    .innerJoin(
      proposals,
      and(
        eq(proposals.companyId, invoicePostings.companyId),
        eq(proposals.id, invoicePostings.proposalId),
      ),
    )
    .where(
      and(
        eq(invoicePostings.companyId, companyId),
        gte(journals.date, range.from),
        lte(journals.date, range.to),
        page?.direction ? eq(invoiceDocuments.direction, page.direction) : undefined,
        page?.cursor ? gt(invoicePostings.invoiceId, page.cursor) : undefined,
      ),
    )
    .orderBy(asc(invoicePostings.invoiceId))
    .$dynamic();
  const rows = await (page ? query.limit(page.limit + 1) : query);
  return rows.map(({ invoice, journal, proposal, sourceHash }): Entry => {
    const treatment = generalBodySchema.parse(proposal.body).invoice;
    requireCondition(
      treatment,
      'REGISTER_SOURCE',
      'Înregistrarea facturii nu are un tratament identificat.',
      500,
    );
    const sign = treatment.credit ? -1n : 1n;
    const signed = (value: string) => fromBani(toBani(value) * sign);
    return {
      invoiceId: invoice.id,
      journalId: journal.id,
      proposalHash: proposal.hash,
      evidenceId: invoice.evidenceId,
      sourceHash,
      invoiceHash: invoice.hash,
      number: invoice.body.number,
      direction: invoice.direction,
      documentType: invoice.body.documentType,
      issueDate: invoice.body.issueDate,
      recognitionDate: journal.date,
      originalTaxPointDate: treatment.taxPointDate,
      originalInvoiceId: treatment.credit?.originalInvoiceId ?? null,
      category: invoice.body.taxes[0].category,
      rate: invoice.body.taxes[0].rate ?? '0',
      base: signed(treatment.net),
      sourceTax: signed(treatment.tax),
      gross: signed(treatment.gross),
      inputTax: invoice.direction === 'purchase' ? signed(treatment.deductibleTax) : '0.00',
      outputTax: invoice.direction === 'sale' ? signed(treatment.tax) : '0.00',
      deduction: treatment.deduction,
      ruleId: treatment.ruleId,
      ruleHash: treatment.ruleHash,
      registrationIds: treatment.registrationIds,
    };
  });
}

function totals(rows: Entry[]) {
  const sum = (field: 'base' | 'sourceTax' | 'gross' | 'inputTax' | 'outputTax') =>
    fromBani(rows.reduce((value, row) => value + toBani(row[field]), 0n));
  return {
    base: sum('base'),
    sourceTax: sum('sourceTax'),
    gross: sum('gross'),
    inputTax: sum('inputTax'),
    outputTax: sum('outputTax'),
  };
}

/** Source-linked working registers. Reconciliation is not a statutory declaration/conformance claim. */
export class VatRegisters {
  constructor(private readonly runner: Commands) {}
  entries(actor: Actor, input: unknown) {
    const body = vatEntriesInput.parse(input);
    return this.runner.read(
      actor,
      async (tx) => {
        const range = await period(tx, actor.companyId, body);
        const rows = await entries(tx, actor.companyId, range, body);
        return {
          items: rows.slice(0, body.limit),
          nextCursor: rows.length > body.limit ? rows[body.limit - 1].invoiceId : null,
        };
      },
      'vat.entries',
    );
  }
  summary(actor: Actor, input: unknown) {
    const body = vatPeriodInput.parse(input);
    return this.runner.read(
      actor,
      async (tx) => {
        const range = await period(tx, actor.companyId, body);
        const rows = await entries(tx, actor.companyId, range);
        const posted = await tx
          .select({ journal: journals, proposal: proposals })
          .from(journals)
          .leftJoin(
            proposals,
            and(eq(proposals.companyId, journals.companyId), eq(proposals.id, journals.sourceId)),
          )
          .where(
            and(
              eq(journals.companyId, actor.companyId),
              gte(journals.date, range.from),
              lte(journals.date, range.to),
            ),
          )
          .orderBy(asc(journals.id));
        const lines = await tx
          .select({
            journalId: journalLines.journalId,
            account: journalLines.account,
            debit: journalLines.debitBani,
            credit: journalLines.creditBani,
          })
          .from(journalLines)
          .innerJoin(
            journals,
            and(
              eq(journals.companyId, journalLines.companyId),
              eq(journals.id, journalLines.journalId),
            ),
          )
          .where(
            and(
              eq(journalLines.companyId, actor.companyId),
              gte(journals.date, range.from),
              lte(journals.date, range.to),
            ),
          )
          .orderBy(asc(journalLines.journalId), asc(journalLines.line));
        const imported = await tx
          .select({ invoice: invoiceDocuments, postedId: invoicePostings.invoiceId })
          .from(invoiceDocuments)
          .leftJoin(
            invoicePostings,
            and(
              eq(invoicePostings.companyId, invoiceDocuments.companyId),
              eq(invoicePostings.invoiceId, invoiceDocuments.id),
            ),
          )
          .where(eq(invoiceDocuments.companyId, actor.companyId));
        const issues: z.infer<typeof vatIssueOutput>[] = imported
          .filter(
            ({ invoice, postedId }) =>
              !postedId &&
              invoice.body.issueDate >= range.from &&
              invoice.body.issueDate <= range.to,
          )
          .map(({ invoice }) => ({
            code: 'UNPOSTED_INVOICE',
            invoiceId: invoice.id,
            journalId: null,
          }));
        const invoiceJournals = new Set(rows.map((row) => row.journalId));
        const linesByJournal = new Map<string, typeof lines>();
        for (const line of lines) {
          const group = linesByJournal.get(line.journalId) ?? [];
          group.push(line);
          linesByJournal.set(line.journalId, group);
        }
        let ledgerInput = 0n,
          ledgerOutput = 0n;
        for (const { journal, proposal } of posted) {
          const body =
            journal.kind === 'general' && proposal ? generalBodySchema.parse(proposal.body) : null;
          if (journal.kind === 'opening' || body?.purpose === 'opening') continue;
          const ownLines = linesByJournal.get(journal.id) ?? [];
          ledgerInput += ownLines
            .filter((line) => /^4426(?:\.|$)/.test(line.account))
            .reduce((sum, line) => sum + line.debit - line.credit, 0n);
          ledgerOutput += ownLines
            .filter((line) => /^4427(?:\.|$)/.test(line.account))
            .reduce((sum, line) => sum + line.credit - line.debit, 0n);
          if (
            !invoiceJournals.has(journal.id) &&
            !body?.settlement &&
            !body?.accrual &&
            journal.kind !== 'payment' &&
            ownLines.some((line) =>
              /^(401|4111|4426|4427|6\d{2}|7\d{2})(?:\.|$)/.test(line.account),
            )
          ) {
            issues.push({ code: 'UNCLASSIFIED_JOURNAL', invoiceId: null, journalId: journal.id });
          }
        }
        const total = totals(rows);
        const inputDifference = ledgerInput - toBani(total.inputTax),
          outputDifference = ledgerOutput - toBani(total.outputTax);
        if (inputDifference !== 0n)
          issues.push({ code: 'INPUT_VAT_DIFFERENCE', invoiceId: null, journalId: null });
        if (outputDifference !== 0n)
          issues.push({ code: 'OUTPUT_VAT_DIFFERENCE', invoiceId: null, journalId: null });
        const grouped = new Map<string, Entry[]>();
        for (const row of rows) {
          const key = `${row.direction}:${row.category}:${row.rate}`;
          const group = grouped.get(key) ?? [];
          group.push(row);
          grouped.set(key, group);
        }
        const groups = [...grouped]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, items]) => ({
            direction: items[0].direction,
            category: items[0].category,
            rate: items[0].rate,
            entryCount: items.length,
            ...totals(items),
          }));
        issues.sort((a, b) => canonical(a).localeCompare(canonical(b)));
        const result = {
          scope: 'posted_domestic_service_treatments' as const,
          officialDeclaration: false as const,
          ...range,
          entryCount: rows.length,
          totals: total,
          groups,
          reconciliation: {
            ledgerInputTax: fromBani(ledgerInput),
            ledgerOutputTax: fromBani(ledgerOutput),
            inputDifference: fromBani(inputDifference),
            outputDifference: fromBani(outputDifference),
          },
          status: issues.length ? ('needs_review' as const) : ('reconciled' as const),
          issues,
        };
        return {
          ...result,
          hash: sha256(
            canonical({
              result,
              rows,
              posted,
              lines: lines.map((line) => ({
                ...line,
                debit: line.debit.toString(),
                credit: line.credit.toString(),
              })),
            }),
          ),
        };
      },
      'vat.summary',
    );
  }
}
