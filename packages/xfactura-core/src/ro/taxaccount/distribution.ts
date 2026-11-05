import { z } from 'zod';
import { allocate, formatMoney, LEDGER_CURRENCY } from '../../money';
import type { LocalDate } from '../../time';
import {
  budgetLabels,
  budgets,
  taxTypeLabels,
  taxTypes,
  type Budget,
  type Category,
  type Obligation,
} from './obligations';

/*
 * How a payment to the single account is distributed among what the taxpayer owes (Codul de
 * procedură fiscală art. 163 alin. (3)–(5) and art. 165 alin. (1)–(3)): between the budgets and
 * funds in proportion to what each is owed; within a budget that the payment does not cover,
 * first the taxes and contributions withheld at source, then the other principal obligations,
 * then the accessories; within a category the payment does not cover, in proportion to what is
 * owed. Pure: the treatments give it the obligations the books hold and the rules in force on
 * the payment's date.
 */

/** `ro.taxaccount.distribution`: the order of art. 163 alin. (3)–(5). */
export const distributionOrder = z
  .object({
    /** Alin. (3): between budgets and funds, in proportion to the obligations owed to each. */
    budgets: z.literal('proportional'),
    /** Alin. (4): the categories within a budget the payment does not cover, in order. */
    categories: z.tuple([z.literal('withheld'), z.literal('principal'), z.literal('accessory')]),
    /**
     * Alin. (5) with art. 165 alin. (1) lit. a) and alin. (3): within a category the payment does
     * not cover, `by_type`: in proportion to what each obligation type is owed, each type's
     * obligations by age (the oldest first); `by_obligation`: in proportion to every obligation
     * owed, whatever its age.
     */
    withinCategory: z.enum(['by_type', 'by_obligation']),
  })
  .strict();
export type DistributionOrder = z.infer<typeof distributionOrder>;

/**
 * `ro.taxaccount.advance`: what a payment does beyond the obligations due on its date.
 * `at_due_date`: it stays in the single account and settles the obligations the books hold as
 * each falls due, in the same order, each due date in turn; `undistributed`: it stays as a
 * payment not yet distributed until a distribution on a later date.
 */
export const advanceRule = z
  .object({ beyondDue: z.enum(['at_due_date', 'undistributed']) })
  .strict();
export type AdvanceRule = z.infer<typeof advanceRule>;

export interface Allocation {
  obligation: Obligation;
  bani: bigint;
  /** `designated`: chosen by the payer where the law allows; `due`: due on the payment's date;
   * `later`: falling due later, distributed on its due date (`on`). */
  stage: 'designated' | 'due' | 'later';
  on: LocalDate;
}

export interface Distribution {
  allocations: Allocation[];
  /** What no obligation the books hold takes: a payment not yet distributed. */
  undistributed: bigint;
  /** The steps, in Romanian, for the explanation. */
  trace: string[];
}

const lei = (bani: bigint) => `${formatMoney(bani, LEDGER_CURRENCY)} lei`;
const label = (obligation: Obligation) =>
  `${obligation.type === 'fine' ? 'amendă' : obligation.type === 'other' ? obligation.account : taxTypeLabels[obligation.type]}${obligation.period ? ` ${obligation.period}` : ''}${obligation.category === 'accessory' ? ' (accesorii)' : ''}`;

/** Oldest first; obligations of the same age by period, then by id. */
const byAge = (a: Obligation, b: Obligation) =>
  (a.age ?? '9999').localeCompare(b.age ?? '9999') ||
  (a.period ?? '').localeCompare(b.period ?? '') ||
  a.id.localeCompare(b.id);
const typeRank = (obligation: Obligation) => {
  const index = (taxTypes as readonly string[]).indexOf(obligation.type);
  return index < 0 ? taxTypes.length : index;
};

/** Splits `amount` over `owed` (each > 0) in proportion; never more than an obligation owes. */
function proportional(amount: bigint, items: readonly { owed: bigint }[]): bigint[] {
  return allocate(
    amount,
    items.map((item) => item.owed),
  );
}

/** Settles obligations of one type oldest first with `amount` (at most what they owe). */
function oldestFirst(amount: bigint, items: readonly Obligation[]) {
  const parts: [Obligation, bigint][] = [];
  let left = amount;
  for (const item of [...items].sort(byAge)) {
    if (left === 0n) break;
    const part = left < item.owed ? left : item.owed;
    parts.push([item, part]);
    left -= part;
  }
  return parts;
}

/**
 * Distributes `amount` over obligations all due by the same date, in the order of art. 163:
 * everything when it covers them all; otherwise between budgets in proportion, and within each
 * budget the categories in order.
 */
function distributeAt(
  amount: bigint,
  set: readonly Obligation[],
  order: DistributionOrder,
  trace: string[],
): [Obligation, bigint][] {
  const total = set.reduce((sum, item) => sum + item.owed, 0n);
  if (total === 0n || amount === 0n) return [];
  if (amount >= total) {
    trace.push(`Plata acoperă toate cele ${set.length} obligații (${lei(total)}).`);
    return set.map((item) => [item, item.owed]);
  }
  const present = budgets.filter((budget) => set.some((item) => item.budget === budget));
  const owedTo = (budget: Budget) =>
    set.filter((item) => item.budget === budget).reduce((sum, item) => sum + item.owed, 0n);
  const shares = allocate(amount, present.map(owedTo));
  trace.push(
    `Plata (${lei(amount)}) nu acoperă obligațiile datorate (${lei(total)}): se împarte proporțional între bugete (art. 163 alin. (3)): ${present
      .map(
        (budget, index) =>
          `${budgetLabels[budget]} ${lei(shares[index]!)} din ${lei(owedTo(budget))}`,
      )
      .join('; ')}.`,
  );
  const parts: [Obligation, bigint][] = [];
  present.forEach((budget, index) => {
    let left = shares[index]!;
    for (const category of order.categories as readonly Category[]) {
      if (left === 0n) break;
      const items = set.filter((item) => item.budget === budget && item.category === category);
      const owed = items.reduce((sum, item) => sum + item.owed, 0n);
      if (owed === 0n) continue;
      if (left >= owed) {
        parts.push(...items.map((item): [Obligation, bigint] => [item, item.owed]));
        left -= owed;
        continue;
      }
      trace.push(
        `În ${budgetLabels[budget]}, ${lei(left)} nu acoperă categoria „${categoryLabels[category]}” (${lei(owed)}): se distribuie proporțional (art. 163 alin. (5)).`,
      );
      if (order.withinCategory === 'by_obligation') {
        const split = proportional(left, items);
        items.forEach((item, at) => split[at]! > 0n && parts.push([item, split[at]!]));
      } else {
        const types = [...new Set(items.map((item) => item.type))].sort(
          (a, b) =>
            typeRank(items.find((item) => item.type === a)!) -
            typeRank(items.find((item) => item.type === b)!),
        );
        const ofType = types.map((type) => items.filter((item) => item.type === type));
        const split = proportional(
          left,
          ofType.map((group) => ({ owed: group.reduce((sum, item) => sum + item.owed, 0n) })),
        );
        ofType.forEach((group, at) => parts.push(...oldestFirst(split[at]!, group)));
      }
      left = 0n;
    }
  });
  return parts;
}

export const categoryLabels: Record<Category, string> = {
  withheld: 'impozite și contribuții cu reținere la sursă',
  principal: 'alte obligații fiscale principale',
  accessory: 'obligații fiscale accesorii',
};

/**
 * The distribution of `amount` paid on `date`: what the payer designated, where the law allows
 * it, first; then the obligations due by the date in the order of art. 163; then, under
 * `at_due_date`, those falling due later, each due date in turn; what is left is not yet
 * distributed. Obligations paid outside the single account, or without a due date, are left out
 * unless designated.
 */
export function distribute(
  amount: bigint,
  date: LocalDate,
  obligations: readonly Obligation[],
  rules: { order: DistributionOrder; advance: AdvanceRule },
  designations: ReadonlyMap<string, bigint> = new Map(),
): Distribution {
  const trace: string[] = [];
  const allocations: Allocation[] = [];
  const owed = new Map(obligations.map((item) => [item.id, item.owed]));
  let left = amount;
  for (const [id, bani] of designations) {
    const item = obligations.find((candidate) => candidate.id === id);
    if (!item || bani <= 0n) continue;
    const part = [bani, left, owed.get(id) ?? 0n].reduce((a, b) => (a < b ? a : b));
    if (part <= 0n) continue;
    allocations.push({ obligation: item, bani: part, stage: 'designated', on: date });
    owed.set(id, owed.get(id)! - part);
    left -= part;
    trace.push(`Plătitorul a indicat ${label(item)}: ${lei(part)} (art. 165 alin. (8)).`);
  }
  const open = (item: Obligation) =>
    ({ ...item, owed: owed.get(item.id) ?? 0n }) satisfies Obligation;
  const eligible = obligations
    .map(open)
    .filter((item) => item.owed > 0n && !item.separate && item.due !== null && item.budget);
  const due = eligible.filter((item) => item.due! <= date);
  for (const [item, bani] of distributeAt(left, due, rules.order, trace)) {
    allocations.push({ obligation: item, bani, stage: 'due', on: date });
    left -= bani;
  }
  if (rules.advance.beyondDue === 'at_due_date') {
    const later = [...new Set(eligible.filter((item) => item.due! > date).map((item) => item.due!))]
      .sort()
      .map((on) => ({ on, set: eligible.filter((item) => item.due === on) }));
    for (const { on, set } of later) {
      if (left === 0n) break;
      trace.push(`La scadența din ${on}:`);
      for (const [item, bani] of distributeAt(left, set, rules.order, trace)) {
        allocations.push({ obligation: item, bani, stage: 'later', on });
        left -= bani;
      }
    }
  }
  if (left > 0n)
    trace.push(
      `Rămân nedistribuiți ${lei(left)}: nicio obligație din registre nu îi preia${rules.advance.beyondDue === 'undistributed' ? ' la data plății' : ''}.`,
    );
  return { allocations, undistributed: left, trace };
}

/**
 * A payment into one obligation type's own budget account (art. 163 alin. (7)): its principal
 * obligations by age, then its accessories by age (art. 165 alin. (1) lit. a)); under
 * `at_due_date`, those falling due later as each falls due; what is left is paid in excess.
 */
export function distributeSeparate(
  amount: bigint,
  date: LocalDate,
  obligations: readonly Obligation[],
  advance: AdvanceRule,
): Distribution {
  const trace: string[] = [];
  const allocations: Allocation[] = [];
  let left = amount;
  const settle = (set: readonly Obligation[], stage: Allocation['stage'], on: LocalDate) => {
    for (const category of [false, true]) {
      const items = set.filter((item) => (item.category === 'accessory') === category);
      for (const [item, bani] of oldestFirst(left, items)) {
        allocations.push({ obligation: item, bani, stage, on });
        left -= bani;
      }
    }
  };
  const known = obligations.filter((item) => item.owed > 0n && item.due !== null);
  settle(
    known.filter((item) => item.due! <= date),
    'due',
    date,
  );
  if (advance.beyondDue === 'at_due_date')
    for (const on of [
      ...new Set(known.filter((item) => item.due! > date).map((item) => item.due!)),
    ].sort()) {
      if (left === 0n) break;
      settle(
        known.filter((item) => item.due === on),
        'later',
        on,
      );
    }
  trace.push(
    `Plata în contul bugetar al obligației stinge întâi obligațiile principale, apoi accesoriile, în ordinea vechimii (art. 165 alin. (1) lit. a)).`,
  );
  if (left > 0n) trace.push(`Rămân plătiți în plus ${lei(left)}.`);
  return { allocations, undistributed: left, trace };
}
