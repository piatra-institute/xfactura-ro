import { and, asc, eq, gt, gte, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Transaction } from './db';
import { dateSchema, fromBani, generalBodySchema, idSchema, toBani } from './domain';
import { accountingRules } from './accounting-catalogue';
import { journals, proposals } from './schema';
export const advanceCashVatOutput = z.object({
  paymentId: idSchema,
  journalId: idSchema,
  kind: z.enum(['payment', 'refund']),
  date: dateSchema,
  originalTaxPointDate: dateSchema,
  evidenceId: idSchema,
  sourceEvidenceId: idSchema,
  direction: z.enum(['purchase', 'sale']),
  category: z.string(),
  rate: z.string(),
  base: z.string(),
  sourceTax: z.string(),
  gross: z.string(),
  cashGross: z.string(),
  inputTax: z.string(),
  outputTax: z.string(),
  ruleId: z.string(),
  ruleHash: z.string(),
});
export async function advanceCashVatEntries(
  tx: Transaction,
  companyId: string,
  range: { from: string; to: string },
  page?: { cursor?: string; limit: number },
) {
  const query = tx
    .select({ journal: journals, body: proposals.body })
    .from(journals)
    .innerJoin(
      proposals,
      and(eq(proposals.companyId, journals.companyId), eq(proposals.id, journals.sourceId)),
    )
    .where(
      and(
        eq(journals.companyId, companyId),
        gte(journals.date, range.from),
        lte(journals.date, range.to),
        page?.cursor ? gt(journals.id, page.cursor) : undefined,
        or(
          sql`json_type(${proposals.body},'$.advancePayment')='object'`,
          sql`json_type(${proposals.body},'$.advanceRefund')='object'`,
        ),
      ),
    )
    .orderBy(asc(journals.id))
    .$dynamic();
  const rows = await (page ? query.limit(page.limit + 1) : query);
  return rows.map(({ journal, body }) => {
    const parsed = generalBodySchema.parse(body),
      p = parsed.advancePayment ?? parsed.advanceRefund!,
      sign = parsed.advanceRefund ? -1n : 1n,
      signed = (value: string) => fromBani(toBani(value) * sign),
      vat = (value: string) => (p.direction === 'sale' ? signed(value) : '0.00');
    return {
      paymentId: parsed.advanceRefund?.paymentId ?? journal.sourceId,
      journalId: journal.id,
      kind: parsed.advanceRefund ? ('refund' as const) : ('payment' as const),
      date: journal.date,
      originalTaxPointDate:
        parsed.advanceRefund?.originalTaxPointDate ?? parsed.advancePayment!.taxPointDate,
      evidenceId: p.evidenceId,
      sourceEvidenceId: p.sourceEvidenceId,
      direction: p.direction,
      category: p.vatCategory,
      rate: accountingRules.find((row) => row.id === p.ruleId)!.rate,
      base: vat(p.net),
      sourceTax: vat(p.tax),
      gross: vat(p.gross),
      cashGross: signed(p.gross),
      inputTax: '0.00',
      outputTax: vat(p.tax),
      ruleId: p.ruleId,
      ruleHash: p.ruleHash,
    };
  });
}
