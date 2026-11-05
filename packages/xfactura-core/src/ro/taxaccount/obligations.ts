import { z } from 'zod';
import type { OpenItemState } from '../../kernel';
import { RuleGapError, type RuleContext } from '../../rules';
import { monthEnd, monthStart, type LocalDate, type Month } from '../../time';
import { obligationDue, obligationKinds, type ObligationKind } from '../obligations';

/*
 * The obligations to the state the tax account holds (Codul de procedură fiscală art. 163): each
 * open item of the tax authority is one obligation of a type (VAT, profit tax, CAS, …) and a
 * period, owed to a budget or fund, in a category of the distribution order (withheld at source,
 * other principal, accessory), with its due date (scadența, art. 154) and its age (vechimea,
 * art. 165 alin. (3)). What the books record is read here, never asked again.
 */

/** The budgets and funds a payment to the single account is distributed between (art. 163
 * alin. (3)): the state budget, the state social insurance budget (CAS) and the national health
 * insurance fund (CASS), as Codul fiscal art. 2 alin. (2) assigns the contributions. */
export const budgets = ['state', 'social_insurance', 'health_insurance'] as const;
export type Budget = (typeof budgets)[number];
export const budgetLabels: Record<Budget, string> = {
  state: 'bugetul de stat',
  social_insurance: 'bugetul asigurărilor sociale de stat',
  health_insurance: 'Fondul național unic de asigurări sociale de sănătate',
};

/** The categories of art. 163 alin. (4), in their order. */
export const categories = ['withheld', 'principal', 'accessory'] as const;
export type Category = (typeof categories)[number];

/** The obligation types the engine books, by the account and the treatment that books them. */
export const taxTypes = [
  'vat',
  'profit',
  'micro',
  'salary_tax',
  'dividend_tax',
  'interest_tax',
  'cas',
  'cass',
  'cam',
  'rent_tax',
  'ip_tax',
  'nonresident_dividend_tax',
  'nonresident_interest_tax',
  'nonresident_royalty_tax',
  'nonresident_commission_tax',
  'nonresident_services_tax',
] as const;
export type TaxType = (typeof taxTypes)[number];
export const taxTypeLabels: Record<TaxType, string> = {
  vat: 'Taxa pe valoarea adăugată',
  profit: 'Impozit pe profit',
  micro: 'Impozitul pe veniturile microîntreprinderilor',
  salary_tax: 'Impozit pe veniturile din salarii și asimilate salariilor',
  dividend_tax: 'Impozit pe dividende',
  interest_tax: 'Impozit pe veniturile din dobânzi',
  cas: 'Contribuția de asigurări sociale',
  cass: 'Contribuția de asigurări sociale de sănătate',
  cam: 'Contribuția asiguratorie pentru muncă',
  rent_tax: 'Impozit pe veniturile din cedarea folosinței bunurilor, reținut la sursă',
  ip_tax: 'Impozit pe veniturile din drepturi de proprietate intelectuală',
  nonresident_dividend_tax: 'Impozit pe dividendele obținute din România de nerezidenți',
  nonresident_interest_tax: 'Impozit pe dobânzile obținute din România de nerezidenți',
  nonresident_royalty_tax: 'Impozit pe redevențele obținute din România de nerezidenți',
  nonresident_commission_tax: 'Impozit pe comisioanele obținute din România de nerezidenți',
  nonresident_services_tax: 'Impozit pe veniturile din servicii prestate de nerezidenți',
};

const type = z.enum(taxTypes);
const budget = z.enum(budgets);
const account = z.string().regex(/^\d{3,4}$/);

const entrySchema = z
  .object({
    type,
    budget,
    category: z.enum(['withheld', 'principal']),
    /** Paid into the single account (OPANAF nr. 1.612/2018's nomenclator); otherwise into the
     * type's own budget account (art. 163 alin. (7)). */
    single: z.boolean(),
    /** Due on the day it was withheld, rather than by the return's deadline. */
    due: z.literal('withholding_date').optional(),
    /** Due by this return's deadline for the month it was withheld (the day the posting's
     * subject ends with), for a treatment `declared` does not date by its own return. */
    deadline: z.enum(obligationKinds).optional(),
  })
  .strict();

/**
 * `ro.taxaccount.obligations`: what each account holding obligations to the state stands for:
 * the obligation type, its budget, its category in the distribution, and whether it is paid into
 * the single account. `byTreatment` splits an account several types share (446: dividends,
 * interest, rent, intellectual property, non-residents' income) by the treatment that booked the
 * item, or by the treatment and the tag of the line that opened it (`<treatment>#<tag>`), where
 * one treatment books several types.
 */
export const obligationCatalogue = z
  .object({
    principal: z.record(account, entrySchema),
    byTreatment: z.record(account, z.record(z.string().min(1), entrySchema)),
  })
  .strict();
export type ObligationCatalogue = z.infer<typeof obligationCatalogue>;

/**
 * `ro.taxaccount.accounts`: where the tax account books what is not a tax's own account: the
 * expense and the debt of interest, penalties and fines owed to the budget (6581, 4481), and a
 * payment not yet distributed, a claim on the budget (4482), as OMFP nr. 1.802/2014 describes
 * accounts 658 and 448.
 */
export const taxAccounts = z
  .object({
    accessoriesExpense: account,
    accessories: account,
    undistributed: account,
    /** Receivables from the state the books hold on their own account: VAT to recover. */
    refundable: z.array(account).min(1),
  })
  .strict();
export type TaxAccounts = z.infer<typeof taxAccounts>;

/** The tag a tax-account line carries (`analytics.item`): the obligation an accessory or an
 * assessed difference belongs to, `taxaccount:<type>:<period>:<kind>`, or `taxaccount:fine`. */
export const obligationTag = (type: TaxType, period: string, kind: string) =>
  `taxaccount:${type}:${period}:${kind}`;
export function parseTag(tag: string | null) {
  const match = /^taxaccount:([a-z_]+):([^:]*):([a-z_]+)$/.exec(tag ?? '');
  if (!match || !(taxTypes as readonly string[]).includes(match[1]!)) return null;
  return { type: match[1] as TaxType, period: match[2]!, kind: match[3]! };
}
export const fineTag = 'taxaccount:fine';
export const undistributedTag = 'taxaccount:undistributed';

/** An obligation the books hold, as the distribution reads it. */
export interface Obligation {
  id: string;
  account: string;
  type: TaxType | 'fine' | 'other';
  period: string | null;
  budget: Budget | null;
  category: Category | null;
  /** The due date (scadența): null when the engine cannot tell it. */
  due: LocalDate | null;
  /** Its age for the order of art. 165 alin. (3): the due date for principal obligations; the
   * communication date for differences and accessories established by decision. */
  age: LocalDate | null;
  /** What is outstanding, in bani, positive. */
  owed: bigint;
  /** Established by an inspection or a fine: the taxpayer chooses which is extinguished first
   * (art. 165 alin. (8)). */
  designatable: boolean;
  /** Paid outside the single account (art. 163 alin. (7)): an account the catalogue does not
   * name. */
  separate: boolean;
  /** Where its type and period were read from, for the explanation. */
  source: string;
}

const quarterMonths = (quarter: string) => {
  const year = quarter.slice(0, 4);
  const last = Number(quarter.slice(-1)) * 3;
  return {
    first: `${year}-${String(last - 2).padStart(2, '0')}` as Month,
    last: `${year}-${String(last).padStart(2, '0')}` as Month,
  };
};

/** The return a period's obligation is declared in, and the period's first and last months:
 * the catalogue's `deadline`, for the month of the day the subject ends with, or the return of
 * the treatment that booked it. */
function declared(
  treatmentId: string,
  subject: string,
  deadline?: ObligationKind,
): { kind: ObligationKind; period: string; first: Month; last: Month } | null {
  const parts = subject.split(':');
  if (deadline) {
    const day = parts.at(-1) ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    const month = day.slice(0, 7) as Month;
    return { kind: deadline, period: month, first: month, last: month };
  }
  if (treatmentId === 'vat.settle') {
    const period = parts[1] ?? '';
    if (/^\d{4}-Q[1-4]$/.test(period)) return { kind: 'D300', period, ...quarterMonths(period) };
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(period))
      return { kind: 'D300', period, first: period as Month, last: period as Month };
    return null;
  }
  if (treatmentId === 'tax.micro') {
    const period = parts[1] ?? '';
    return /^\d{4}-Q[1-4]$/.test(period)
      ? { kind: 'D100.micro', period, ...quarterMonths(period) }
      : null;
  }
  if (treatmentId === 'tax.profit') {
    const period = parts[1] ?? '';
    if (/^\d{4}-Q[1-3]$/.test(period))
      return { kind: 'D100.profit', period, ...quarterMonths(period) };
    if (/^\d{4}$/.test(period))
      return {
        kind: 'D101',
        period,
        first: `${period}-01` as Month,
        last: `${period}-12` as Month,
      };
    return null;
  }
  if (treatmentId === 'dividends.withhold' || treatmentId === 'loans.withhold') {
    const day = parts.at(-1) ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    const month = day.slice(0, 7) as Month;
    return { kind: 'D100.dividends', period: month, first: month, last: month };
  }
  if (treatmentId === 'payroll.recognize') {
    const month = parts[1] ?? '';
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(month)
      ? { kind: 'D112', period: month, first: month as Month, last: month as Month }
      : null;
  }
  return null;
}

/**
 * The obligation an open item of the tax authority stands for: its type from the account (and,
 * for a shared account, from the treatment that booked it), the period from the posting that
 * opened it, the due date the item carries or the deadline of the return that declares it (or
 * the day it was withheld, where the catalogue says so), and its age. An item whose type the
 * catalogue does not name is paid outside the single account.
 */
export function obligationOf(
  item: OpenItemState,
  catalogue: ObligationCatalogue,
  accounts: TaxAccounts,
  rules: RuleContext,
): Obligation {
  const owed = item.normalSide === 'C' ? -item.balanceBani : item.balanceBani;
  const base = {
    id: item.id,
    account: item.controlAccount.split('.')[0]!,
    owed,
  };
  const origin = item.origin;
  const tag = parseTag(origin?.tag ?? null);
  // Accessories and fines carry their obligation on the line that opened them.
  if (base.account === accounts.accessories) {
    const of = tag ? obligationTypeOf(tag.type, catalogue) : null;
    const fine = origin?.tag === fineTag;
    // Accessories follow their principal into the single account, except the non-declaration
    // penalty, a revenue of its own (art. 181 alin. (5)); a fine is paid where it says.
    const single = !fine && !!of?.single && tag?.kind !== 'nondeclaration_penalty';
    return {
      ...base,
      type: fine ? 'fine' : (tag?.type ?? 'other'),
      period: tag?.period || null,
      budget: of?.budget ?? (fine ? 'state' : null),
      category: fine ? 'principal' : 'accessory',
      due: item.dueDate,
      age: origin?.date ?? null,
      // Chosen by the payment's record number: a decision's accessories, an inspection, a fine.
      designatable: true,
      separate: !single,
      source: origin ? `${origin.treatmentId} ${origin.subject}` : 'necunoscut',
    };
  }
  const shared = catalogue.byTreatment[base.account];
  const entry =
    (shared && origin
      ? ((origin.tag ? shared[`${origin.treatmentId}#${origin.tag}`] : undefined) ??
        shared[origin.treatmentId])
      : undefined) ?? catalogue.principal[base.account];
  if (!entry)
    return {
      ...base,
      type: 'other',
      period: null,
      budget: null,
      category: null,
      due: item.dueDate,
      age: item.dueDate,
      designatable: true,
      separate: true,
      source: origin ? `${origin.treatmentId} ${origin.subject}` : 'necunoscut',
    };
  // A difference established by decision: aged by its communication (art. 165 alin. (3) lit. b)).
  if (tag && tag.kind === 'assessment')
    return {
      ...base,
      type: entry.type,
      budget: entry.budget,
      category: entry.category,
      period: tag.period || null,
      due: item.dueDate,
      age: origin?.date ?? null,
      designatable: true,
      separate: !entry.single,
      source: `${origin!.treatmentId} ${origin!.subject}`,
    };
  const known = origin ? declared(origin.treatmentId, origin.subject, entry.deadline) : null;
  let due = item.dueDate;
  const { due: rule, single, deadline: _deadline, ...kind } = entry;
  if (!due && rule === 'withholding_date' && origin)
    due = (origin.subject.split(':').at(-1) ?? null) as LocalDate | null;
  if (!due && known)
    try {
      due = obligationDue(
        known.kind,
        { start: monthStart(known.first), end: monthEnd(known.last) },
        rules,
      ).due;
    } catch (error) {
      if (!(error instanceof RuleGapError)) throw error;
      due = null;
    }
  return {
    ...base,
    ...kind,
    period: known?.period ?? null,
    due,
    age: due,
    designatable: false,
    separate: !single,
    source: origin ? `${origin.treatmentId} ${origin.subject}` : 'necunoscut',
  };
}

/** The budget and category of a principal type, from the catalogue's accounts. */
export function obligationTypeOf(type: TaxType, catalogue: ObligationCatalogue) {
  for (const entry of Object.values(catalogue.principal)) if (entry.type === type) return entry;
  for (const split of Object.values(catalogue.byTreatment))
    for (const entry of Object.values(split)) if (entry.type === type) return entry;
  return null;
}

/** The account a principal type is booked on. */
export function accountOfType(type: TaxType, catalogue: ObligationCatalogue): string | null {
  for (const [code, entry] of Object.entries(catalogue.principal))
    if (entry.type === type) return code;
  for (const [code, split] of Object.entries(catalogue.byTreatment))
    if (Object.values(split).some((entry) => entry.type === type)) return code;
  return null;
}
