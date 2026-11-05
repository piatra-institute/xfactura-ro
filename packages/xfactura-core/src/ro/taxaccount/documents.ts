import { z } from 'zod';
import { Amount, dateSchema, moneySchema, signedMoneySchema } from '../../values';
import { budgets, taxTypes } from './obligations';

/*
 * What an agent transcribes from ANAF's documents about the tax account, each field citing the
 * line of the PDF it was read from (`documents.record`):
 * - a decision (`tax.decision`): the accessories of late payment (OPANAF nr. 967/2017 anexa nr. 3:
 *   interest and penalties per obligation, with the base, the days and the rate), the
 *   non-declaration penalty (anexa nr. 4), an assessment from an inspection (decizie de impunere:
 *   differences of principal obligations), a fine, a VAT refund (OPANAF nr. 352/2022 anexa nr. 2)
 *   or an offset (Decizia privind compensarea obligațiilor fiscale, OPANAF nr. 1.613/2018 pct. 12);
 * - the taxpayer's account statement (`tax.statement`): ANAF's fișa pe plătitor or situația
 *   sintetică from the SPV, which has no published model: one row per obligation as printed, with
 *   what was owed, paid and is left.
 */

export const taxDecisionSchemaVersion = 'extracted-tax-decision-1';
export const taxStatementSchemaVersion = 'extracted-tax-statement-1';

export const taxDocumentKinds = { decision: 'tax.decision', statement: 'tax.statement' } as const;

export const decisionKinds = ['accessories', 'assessment', 'fine', 'refund', 'offset'] as const;
export type DecisionKind = (typeof decisionKinds)[number];
export const decisionLineKinds = [
  'interest',
  'late_penalty',
  'nondeclaration_penalty',
  'principal',
  'fine',
  'refund',
  'offset',
] as const;
export type DecisionLineKind = (typeof decisionLineKinds)[number];

const period = z
  .string()
  .regex(/^\d{4}(-(0[1-9]|1[0-2]|Q[1-4]))?$/)
  .nullable();
const name = z.string().trim().min(1).max(500);
const taxId = z.string().trim().min(1).max(30);
const label = z.string().trim().min(1).max(500);

export const taxDecisionDocumentSchema = z
  .object({
    parserVersion: z.literal(taxDecisionSchemaVersion),
    decision: z.enum(decisionKinds),
    /** The title as printed. */
    title: label,
    issuer: z.object({ name, taxId: taxId.nullable() }).strict(),
    taxpayer: z.object({ name, taxId }).strict(),
    number: z.string().trim().min(1).max(100),
    issueDate: dateSchema,
    /** When it was communicated: what it establishes is due from it (CPF art. 156 alin. (1)),
     * and its age runs from it (art. 165 alin. (3) lit. b)). */
    communicatedOn: dateSchema,
    lines: z
      .array(
        z
          .object({
            kind: z.enum(decisionLineKinds),
            /** The obligation the amount is about: the principal an accessory follows, an
             * assessed type, the obligation an offset extinguishes; null for a fine. */
            obligation: z.enum(taxTypes).nullable(),
            period,
            /** As printed (the obligation's name, the account to pay into). */
            label,
            /** The principal an accessory is computed on, its days of delay and its first and
             * last day, as the decision's annex shows them. */
            base: moneySchema.nullable(),
            days: z.number().int().min(0).max(36_600).nullable(),
            from: dateSchema.nullable(),
            to: dateSchema.nullable(),
            amount: moneySchema,
            /** An offset's or a refund's source: VAT to recover of a period, or a sum paid in
             * excess (not yet distributed). */
            source: z
              .object({ kind: z.enum(['vat_refund', 'overpayment']), period })
              .strict()
              .nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(300),
    totals: z.object({ amount: moneySchema }).strict(),
  })
  .strict();
export type TaxDecisionDocument = z.infer<typeof taxDecisionDocumentSchema>;

const decisionLineInput = taxDecisionDocumentSchema.shape.lines.element.extend({
  obligation: z.enum(taxTypes).nullable().default(null),
  period: period.default(null),
  base: moneySchema.nullable().default(null),
  days: z.number().int().min(0).max(36_600).nullable().default(null),
  from: dateSchema.nullable().default(null),
  to: dateSchema.nullable().default(null),
  source: taxDecisionDocumentSchema.shape.lines.element.shape.source.default(null),
});
export const taxDecisionDocumentInput = taxDecisionDocumentSchema.extend({
  parserVersion: z.literal(taxDecisionSchemaVersion).default(taxDecisionSchemaVersion),
  issuer: z.object({ name, taxId: taxId.nullable().default(null) }).strict(),
  lines: z.array(decisionLineInput).min(1).max(300),
});

/** The rows a statement holds besides the taxes' own: a payment not yet distributed, VAT to
 * recover, an obligation the engine does not book. */
export const statementObligations = [
  ...taxTypes,
  'undistributed',
  'vat_refund',
  'fine',
  'other',
] as const;
export type StatementObligation = (typeof statementObligations)[number];

export const taxStatementDocumentSchema = z
  .object({
    parserVersion: z.literal(taxStatementSchemaVersion),
    /** Which SPV document it is (the request types of the SPV). */
    source: z.enum(['situatie_sintetica', 'fisa_rol', 'fisa_rol_simplificata', 'other']),
    title: label,
    taxpayer: z.object({ name, taxId }).strict(),
    /** The date its balances are at. */
    asOf: dateSchema,
    from: dateSchema.nullable(),
    rows: z
      .array(
        z
          .object({
            /** The obligation as printed, and its code in the nomenclator when shown. */
            label,
            code: z.string().trim().min(1).max(20).nullable(),
            obligation: z.enum(statementObligations),
            kind: z.enum(['principal', 'accessory']),
            budget: z.enum(budgets).nullable(),
            period,
            opening: signedMoneySchema.nullable(),
            debit: moneySchema.nullable(),
            credit: moneySchema.nullable(),
            /** What is left: positive owed by the taxpayer, negative owed to it (paid in excess,
             * to recover). */
            balance: signedMoneySchema,
          })
          .strict(),
      )
      .min(1)
      .max(500),
    totals: z.object({ balance: signedMoneySchema }).strict().nullable(),
  })
  .strict();
export type TaxStatementDocument = z.infer<typeof taxStatementDocumentSchema>;

const statementRowInput = taxStatementDocumentSchema.shape.rows.element.extend({
  code: z.string().trim().min(1).max(20).nullable().default(null),
  kind: z.enum(['principal', 'accessory']).default('principal'),
  budget: z.enum(budgets).nullable().default(null),
  period: period.default(null),
  opening: signedMoneySchema.nullable().default(null),
  debit: moneySchema.nullable().default(null),
  credit: moneySchema.nullable().default(null),
});
export const taxStatementDocumentInput = taxStatementDocumentSchema.extend({
  parserVersion: z.literal(taxStatementSchemaVersion).default(taxStatementSchemaVersion),
  source: taxStatementDocumentSchema.shape.source.default('situatie_sintetica'),
  from: dateSchema.nullable().default(null),
  rows: z.array(statementRowInput).min(1).max(500),
  totals: taxStatementDocumentSchema.shape.totals.default(null),
});

/** The arithmetic of a tax document, as `TOTALS` checks it; each problem in Romanian. */
export function taxDocumentProblems(kind: string, body: unknown): string[] {
  const problems: string[] = [];
  if (kind === taxDocumentKinds.decision) {
    const decision = body as TaxDecisionDocument;
    const refunds = decision.lines.filter((line) => line.kind === 'refund');
    const offsets = decision.lines.filter((line) => line.kind === 'offset');
    const sum = (lines: typeof decision.lines) =>
      lines.reduce((total, line) => total.plus(line.amount), new Amount(0));
    if (refunds.length) {
      if (!sum(refunds).eq(decision.totals.amount))
        problems.push(
          `Sumele aprobate la rambursare (${sum(refunds).toFixed(2)}) diferă de total (${decision.totals.amount}).`,
        );
      if (sum(offsets).gt(decision.totals.amount))
        problems.push('Compensările depășesc suma aprobată la rambursare.');
    } else if (!sum(decision.lines).eq(decision.totals.amount))
      problems.push(
        `Rândurile deciziei însumează ${sum(decision.lines).toFixed(2)}, nu totalul de ${decision.totals.amount}.`,
      );
    if (decision.communicatedOn < decision.issueDate)
      problems.push('Decizia nu poate fi comunicată înainte de emitere.');
    decision.lines.forEach((line, index) => {
      if ((line.kind === 'offset' || line.kind === 'refund') !== (line.source !== null))
        problems.push(`Rândul ${index + 1}: sursa se indică doar pentru compensări și rambursări.`);
      if (line.kind !== 'fine' && line.kind !== 'refund' && line.obligation === null)
        problems.push(`Rândul ${index + 1}: obligația nu este indicată.`);
    });
    if (
      decision.lines.some((line) =>
        decision.decision === 'refund' || decision.decision === 'offset'
          ? line.kind !== 'refund' && line.kind !== 'offset'
          : line.kind === 'refund' || line.kind === 'offset',
      )
    )
      problems.push('Rândurile nu corespund tipului deciziei.');
  } else {
    const statement = body as TaxStatementDocument;
    statement.rows.forEach((row, index) => {
      if (row.opening === null || row.debit === null || row.credit === null) return;
      const expected = new Amount(row.opening).plus(row.debit).minus(row.credit);
      if (!expected.eq(row.balance))
        problems.push(
          `Rândul ${index + 1} (${row.label}): soldul inițial + debite − credite = ${expected.toFixed(2)}, nu ${row.balance}.`,
        );
    });
    if (statement.totals) {
      const total = statement.rows.reduce((sum, row) => sum.plus(row.balance), new Amount(0));
      if (!total.eq(statement.totals.balance))
        problems.push(
          `Soldurile rândurilor însumează ${total.toFixed(2)}, nu totalul de ${statement.totals.balance}.`,
        );
    }
  }
  return problems;
}

/** The fields an extraction of a tax document must cite: what identifies it and every amount. */
export function taxDocumentCitations(kind: string, body: unknown): string[] {
  if (kind === taxDocumentKinds.decision) {
    const decision = body as TaxDecisionDocument;
    return [
      'number',
      'issueDate',
      'communicatedOn',
      'taxpayer.taxId',
      'totals.amount',
      ...decision.lines.map((_, index) => `lines.${index}.amount`),
    ];
  }
  const statement = body as TaxStatementDocument;
  return ['asOf', 'taxpayer.taxId', ...statement.rows.map((_, index) => `rows.${index}.balance`)];
}
