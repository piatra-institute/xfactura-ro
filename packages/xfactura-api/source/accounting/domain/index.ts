import { z } from 'zod';
import {
  Amount,
  accountCodeSchema,
  dateSchema,
  idSchema,
  moneySchema,
  signedMoneySchema,
  requireCondition,
} from './values';
export * from './values';
import { creditDetailsSchema, settlementBodySchema } from './settlements';
export * from './settlements';
import { accrualInvoiceMatchSchema, accrualTreatmentSchema } from './accruals';
export * from './accruals';

export const lineSchema = z
  .object({
    account: accountCodeSchema,
    debit: moneySchema,
    credit: moneySchema,
  })
  .strict();
export type PostingLine = z.infer<typeof lineSchema>;

export function assertBalanced(input: PostingLine[]) {
  const lines = z.array(lineSchema).min(2).max(2000).parse(input);
  for (const line of lines) {
    requireCondition(
      new Amount(line.debit).gt(0) !== new Amount(line.credit).gt(0),
      'INVALID_LINE',
      'Fiecare linie are o singură sumă, în debit sau credit.',
    );
  }
  requireCondition(
    lines.reduce((sum, line) => sum.plus(line.debit).minus(line.credit), new Amount(0)).isZero(),
    'UNBALANCED',
    'Totalul debit trebuie să fie egal cu totalul credit.',
  );
}

export function trialBalance(lines: PostingLine[]) {
  const accounts = new Map<
    string,
    { debit: InstanceType<typeof Amount>; credit: InstanceType<typeof Amount> }
  >();
  for (const line of lines) {
    const row = accounts.get(line.account) ?? { debit: new Amount(0), credit: new Amount(0) };
    row.debit = row.debit.plus(line.debit);
    row.credit = row.credit.plus(line.credit);
    accounts.set(line.account, row);
  }
  return [...accounts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([account, row]) => ({
      account,
      debit: row.debit.toFixed(2),
      credit: row.credit.toFixed(2),
      balance: row.debit.minus(row.credit).toFixed(2),
    }));
}

export const companySchema = z
  .object({
    name: z.string().trim().min(2).max(200),
    cui: z.string().regex(/^\d{2,10}$/),
    year: z.number().int().min(2020).max(2100),
  })
  .strict();
export const openingSchema = z
  .object({ date: dateSchema, amount: moneySchema, evidenceId: idSchema })
  .strict();
export const purchaseSchema = z
  .object({
    evidenceId: idSchema,
    supplier: z.string().trim().min(2).max(200),
    supplierCui: z.string().regex(/^\d{2,10}$/),
    invoiceNumber: z.string().trim().min(1).max(100),
    date: dateSchema,
    serviceDate: dateSchema,
    amount: moneySchema,
    description: z.string().trim().min(3).max(1000),
    supplierCountry: z.literal('RO'),
    currency: z.literal('RON'),
    vatTreatment: z.literal('NON_VAT'),
  })
  .strict();
const correctionFields = {
  journalId: idSchema,
  evidenceId: idSchema,
  date: dateSchema,
  reason: z.string().trim().min(10).max(1000),
  action: z.enum(['replace', 'reverse']),
  method: z.literal('inverse_entry'),
  amount: moneySchema,
};
const validCorrectionAmount = (body: { action: string; amount: string }) =>
  body.action === 'reverse' ? body.amount === '0.00' : new Amount(body.amount).gt(0);
export const correctionSchema = z
  .object(correctionFields)
  .strict()
  .refine(validCorrectionAmount, {
    message: 'Stornarea are sumă zero; corecția trebuie să aibă o sumă pozitivă.',
    path: ['amount'],
  });
export const correctionBodySchema = z
  .object({
    ...correctionFields,
    purchaseProposalId: idSchema,
    previousAmount: moneySchema,
  })
  .strict()
  .refine(validCorrectionAmount);
export const reviewSchema = z
  .object({ version: z.number().int().positive(), hash: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const invoiceTreatmentSchema = z
  .object({
    invoiceId: idSchema,
    invoiceHash: z.string().regex(/^[a-f0-9]{64}$/),
    treatmentEvidenceId: idSchema,
    direction: z.enum(['purchase', 'sale']),
    serviceDate: dateSchema,
    taxPointDate: dateSchema,
    deduction: z.enum(['full', 'none']),
    counterpartyVatCollection: z.literal('no'),
    account: accountCodeSchema,
    registrationIds: z.array(idSchema).min(1).max(4),
    ruleId: z.string(),
    ruleHash: z.string().regex(/^[a-f0-9]{64}$/),
    net: moneySchema,
    tax: moneySchema,
    gross: moneySchema,
    deductibleTax: moneySchema,
    credit: creditDetailsSchema.optional(),
    accrualMatch: accrualInvoiceMatchSchema.optional(),
  })
  .strict();
export const generalJournalSchema = z
  .object({
    financialYearId: idSchema,
    evidenceId: idSchema,
    date: dateSchema,
    purpose: z.enum(['opening', 'general', 'purchase', 'sale', 'adjustment']),
    description: z.string().trim().min(3).max(1000),
    sourceReference: z.string().trim().min(1).max(200),
    lines: z.array(lineSchema).min(2).max(2000),
    correctsJournalId: idSchema.optional(),
    invoice: invoiceTreatmentSchema.optional(),
    settlement: settlementBodySchema.optional(),
    accrual: accrualTreatmentSchema.optional(),
  })
  .strict();
export const generalBodySchema = generalJournalSchema
  .extend({
    schemaVersion: z.literal(2),
    amount: moneySchema,
    ruleVersion: z.literal('ro-general-ledger-2'),
  })
  .strict();
export type GeneralBody = z.infer<typeof generalBodySchema>;
export const statementSchema = z
  .object({
    evidenceId: idSchema,
    bankAccount: z.string().trim().min(4).max(50),
    statementId: z.string().trim().min(1).max(100),
    from: dateSchema,
    to: dateSchema,
    opening: moneySchema,
    closing: moneySchema,
  })
  .strict()
  .refine((value) => value.from <= value.to, 'Interval invalid.');
export const matchSchema = z
  .object({ movementId: idSchema, proposalId: idSchema, amount: moneySchema })
  .strict();
export type OpeningInput = z.infer<typeof openingSchema>;
export type PurchaseInput = z.infer<typeof purchaseSchema>;
export type CorrectionInput = z.infer<typeof correctionSchema>;
export type CorrectionBody = z.infer<typeof correctionBodySchema>;
export type ProposalBody = OpeningInput | PurchaseInput | CorrectionBody | GeneralBody;
export type StoredLine = { account: PostingLine['account']; debitBani: string; creditBani: string };
export function postingLines(kind: 'opening' | 'purchase', amount: string): PostingLine[] {
  return [
    { account: kind === 'opening' ? '5121' : '628', debit: amount, credit: '0.00' },
    { account: kind === 'opening' ? '1012' : '401', debit: '0.00', credit: amount },
  ];
}
export function correctionLines(previousAmount: string, amount: string): PostingLine[] {
  return [
    ...(new Amount(previousAmount).gt(0)
      ? postingLines('purchase', previousAmount).map((line) => ({
          account: line.account,
          debit: line.credit,
          credit: line.debit,
        }))
      : []),
    ...(new Amount(amount).gt(0) ? postingLines('purchase', amount) : []),
  ];
}
export function proposalLines(kind: string, body: ProposalBody): PostingLine[] {
  if (kind === 'general') return generalBodySchema.parse(body).lines;
  if (kind === 'correction') {
    const correction = correctionBodySchema.parse(body);
    return correctionLines(correction.previousAmount, correction.amount);
  }
  requireCondition(
    kind === 'opening' || kind === 'purchase',
    'PROPOSAL_KIND',
    'Tip de propunere necunoscut.',
  );
  return postingLines(kind, body.amount);
}
export const inviteSchema = z
  .object({ email: z.email(), role: z.enum(['reviewer', 'viewer']) })
  .strict();
export const permission = {
  owner: ['read', 'write', 'review', 'manage'],
  reviewer: ['read', 'write', 'review'],
  viewer: ['read'],
} as const;
export type Role = keyof typeof permission;

/** Stable representation for approval and command hashes; values are validated before hashing. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export const BANK_CSV_HEADER = 'movement_id,booking_date,amount,currency,reference';
export type BankRow = { sourceId: string; date: string; amount: string; reference: string };
/** A1's deliberately small CSV dialect: UTF-8, quoted fields, no multiline cells. */
export function parseBankCsv(text: string): BankRow[] {
  requireCondition(text.length <= 2_000_000, 'IMPORT_LIMIT', 'Extrasul depășește limita de 2 MB.');
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim());
  requireCondition(
    lines.shift() === BANK_CSV_HEADER,
    'CSV_HEADER',
    `Antetul trebuie să fie: ${BANK_CSV_HEADER}`,
  );
  requireCondition(lines.length <= 5000, 'CSV_ROWS', 'Importați cel mult 5.000 de mișcări.');
  const seen = new Set<string>();
  return lines.map((line) => {
    const cells: string[] = [];
    let cell = '',
      quoted = false,
      closedQuote = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      requireCondition(!closedQuote || char === ',', 'CSV_QUOTE', 'Ghilimele CSV invalide.');
      if (char === '"') {
        if (quoted && line[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          requireCondition(quoted || cell === '', 'CSV_QUOTE', 'Ghilimele CSV invalide.');
          if (quoted) closedQuote = true;
          quoted = !quoted;
        }
      } else if (char === ',' && !quoted) {
        cells.push(cell);
        cell = '';
        closedQuote = false;
      } else cell += char;
    }
    cells.push(cell);
    requireCondition(!quoted && cells.length === 5, 'CSV_ROW', 'Rând CSV invalid.');
    const [sourceId, date, rawAmount, currency, reference] = cells;
    requireCondition(
      sourceId.length > 0 && sourceId.length <= 100 && !seen.has(sourceId),
      'DUPLICATE_MOVEMENT',
      'Identificator de mișcare lipsă sau duplicat.',
    );
    seen.add(sourceId);
    requireCondition(
      currency === 'RON',
      'UNSUPPORTED_CURRENCY',
      'Sunt acceptate numai mișcări în RON. Păstrați documentul pentru revizuire.',
    );
    const amount = signedMoneySchema.parse(rawAmount);
    requireCondition(
      !new Amount(amount).isZero() && reference.length <= 500,
      'CSV_ROW',
      'Mișcare nulă sau referință prea lungă.',
    );
    return { sourceId, date: dateSchema.parse(date), amount, reference };
  });
}
