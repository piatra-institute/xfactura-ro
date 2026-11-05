import { z } from 'zod';
import type { QuestionKind } from '../../questions/kinds';
import { isLocalDate } from '../../time';

/*
 * What the year-end asks people (agent-ready, `yearend/agent.ts`): how collectible a customer's
 * receivables are at the year's end, the staff's untaken leave, and the obligations a provision
 * may be needed for. None is guessed: the treatments block until a person answers, and cite the
 * answer as their basis. Every answer is kept as evidence.
 */

const year = z.number().int().min(2000).max(2100);
const day = z.string().refine((value): boolean => isLocalDate(value), 'Dată invalidă.');
const amount = z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/);
const percent = z.string().regex(/^(0|[1-9]\d?|100)(\.\d{1,2})?$/);
const text = (max: number) => z.string().trim().min(3).max(max);
const evidenceIds = z.array(z.uuid()).max(20);

export const collectibilityStatuses = [
  /** Nothing suggests it will not be collected in full. */
  'collectible',
  /** Late or disputed by the customer, without proceedings. */
  'doubtful',
  /** In court (a claim, an order for payment). */
  'litigation',
  /** Insolvency proceedings opened against the customer (Legea nr. 85/2014). */
  'insolvency',
  /** Bankruptcy declared against the customer by a court decision (Codul fiscal art. 26 alin. (1)
   * lit. j)). */
  'bankruptcy',
] as const;

export const collectibilityAnswer = z
  .object({
    status: z.enum(collectibilityStatuses),
    /** The share of the receivables the person expects to collect, in percent: what OMFP nr.
     * 1.802/2014 pct. 332 alin. (2) impairs is the rest. */
    recoverable: percent,
    /** Whether another person guarantees the receivables (a guarantee, a surety, insurance). */
    guaranteed: z.boolean(),
    /** Whether the customer is affiliated with the company (Codul fiscal art. 7 pct. 26). */
    affiliated: z.boolean(),
    /** The court decision, the claim, the correspondence, the insolvency notice. */
    evidenceIds,
    note: text(1000).optional(),
  })
  .strict()
  .refine((value) => Number(value.recoverable) <= 100, {
    message: 'Partea recuperabilă este cel mult 100%.',
    path: ['recoverable'],
  })
  .refine((value) => value.status === 'collectible' || value.evidenceIds.length > 0, {
    message: 'Starea creanței se dovedește cu un document (hotărârea, cererea, corespondența).',
    path: ['evidenceIds'],
  })
  .refine((value) => value.status !== 'collectible' || value.recoverable === '100', {
    message: 'O creanță încasabilă se recuperează integral.',
    path: ['recoverable'],
  });
export type CollectibilityAnswer = z.infer<typeof collectibilityAnswer>;

/** How collectible a customer's receivables are at a year's end (OMFP nr. 1.802/2014 pct. 89,
 * 332, 353): the status with its document, the share expected, and the facts art. 26 reads. */
export const receivableCollectibility: QuestionKind<{ yearEnd: string }, CollectibilityAnswer> = {
  id: 'receivable.collectibility',
  summary:
    "How collectible a customer's receivables are at the financial year's end: collectible, doubtful, in litigation, in insolvency or in bankruptcy declared by a court, with the document, the share expected to be collected, and whether they are guaranteed or owed by an affiliated person (Codul fiscal art. 26 alin. (1) lit. c), j)); it decides the impairment on 491.",
  holds: 'perPeriod',
  subjects: ['party'],
  params: z.object({ yearEnd: day }).strict(),
  answer: () => collectibilityAnswer,
  prompt: (subject, params) =>
    `Cât de încasabile sunt creanțele clientului ${subject.id} la ${params.yearEnd}? Indicați starea (încasabile, incerte, în litigiu, client în insolvență, faliment declarat prin hotărâre judecătorească) cu documentul care o arată, procentul pe care vă așteptați să îl încasați, dacă sunt garantate de altă persoană și dacă clientul vă este persoană afiliată. Partea care nu se mai poate recupera se înregistrează ca ajustare pentru depreciere (OMFP nr. 1.802/2014 pct. 332).`,
  evidence: (value) => value.evidenceIds,
  period: (params) => params.yearEnd,
};

export const untakenLeaveAnswer = z
  .object({
    /** The working days of annual leave due and not taken at the year's end, all employees. */
    days: z.number().int().min(0).max(100_000),
    /** The leave pay for them, at each contract's daily average (Codul muncii art. 150). */
    amount,
    /** The employer's contributions on that pay (CAM). */
    contributions: amount,
    /** Whether the amount is measured on the payroll records (state de salarii): then it is a
     * debt to the staff, otherwise a provision (OMFP nr. 1.802/2014 pct. 338 alin. (2)). */
    measured: z.boolean(),
    /** The computation per employee, from the leave records and the payroll. */
    evidenceId: z.uuid(),
  })
  .strict()
  .refine((value) => value.days > 0 || (!Number(value.amount) && !Number(value.contributions)), {
    message: 'Fără zile neefectuate, suma este zero.',
    path: ['amount'],
  });
export type UntakenLeaveAnswer = z.infer<typeof untakenLeaveAnswer>;

/** The staff's untaken annual leave at a year's end, for its debt or provision. */
export const untakenLeave: QuestionKind<{ year: number }, UntakenLeaveAnswer> = {
  id: 'leave.untaken',
  summary:
    "The employees' annual leave due and not taken at the year's end: the days, the pay for them at each contract's daily average and the employer's contributions, with the computation; measured on the payroll records it is a debt to the staff (4281), otherwise a provision (1518) (OMFP nr. 1.802/2014 pct. 338 alin. (2)).",
  holds: 'perPeriod',
  subjects: ['company'],
  params: z.object({ year }).strict(),
  answer: () => untakenLeaveAnswer,
  prompt: (_subject, params) =>
    `Câte zile de concediu de odihnă cuvenite pentru ${params.year} nu au fost efectuate până la 31 decembrie? Indicați zilele, indemnizația lor la media zilnică a fiecărui contract, contribuția asiguratorie pentru muncă aferentă și dacă suma este calculată pe baza statelor de salarii, cu calculul pe salariați. Dacă toate concediile au fost efectuate, răspundeți cu zero zile.`,
  evidence: (value) => [value.evidenceId],
  period: (params) => String(params.year),
};

export const provisionReviewAnswer = z.union([
  z.object({ none: z.literal(true), evidenceIds: evidenceIds.default([]) }).strict(),
  z
    .object({
      obligations: z
        .array(
          z
            .object({
              kind: z.enum([
                'litigation',
                'warranty',
                'restructuring',
                'pension',
                'tax',
                'termination',
                'bonus',
                'other',
              ]),
              /** What identifies it: the case number, the contract, the decision. */
              reference: z.string().trim().min(1).max(100),
              /** The best estimate at the year's end of what settling it costs (pct. 387). */
              amount,
              evidenceId: z.uuid(),
              note: text(1000).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(200),
    })
    .strict(),
]);
export type ProvisionReviewAnswer = z.infer<typeof provisionReviewAnswer>;

/** The obligations at a year's end a provision is recognized for (OMFP nr. 1.802/2014 pct.
 * 369–377): lawsuits, warranties given, restructuring, bonuses from the profit, or none. */
export const provisionsReview: QuestionKind<{ year: number }, ProvisionReviewAnswer> = {
  id: 'provisions.review',
  summary:
    "The obligations at the financial year's end that a provision is recognized for (a current obligation from a past event, a probable outflow, a reliable estimate: lawsuits, warranties given to customers, restructuring, pensions, taxes, termination of contracts, bonuses from the profit, others), each with its best estimate and document; or none.",
  holds: 'perPeriod',
  subjects: ['company'],
  params: z.object({ year }).strict(),
  answer: () => provisionReviewAnswer,
  prompt: (_subject, params) =>
    `La 31 decembrie ${params.year}, are compania obligații curente, din evenimente trecute, cu o ieșire de resurse probabilă și o estimare credibilă (procese, garanții acordate clienților, restructurare, pensii, impozite, încetarea contractelor de muncă, prime din profit, altele)? Indicați fiecare obligație cu referința ei, cea mai bună estimare a costului și documentul (OMFP nr. 1.802/2014 pct. 369–388), sau că nu există niciuna.`,
  evidence: (value) =>
    'none' in value ? value.evidenceIds : value.obligations.map((item) => item.evidenceId),
  period: (params) => String(params.year),
};
