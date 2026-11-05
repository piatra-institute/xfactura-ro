import { z } from 'zod';
import {
  profileAt,
  type Effect,
  type Issue,
  type JsonValue,
  type LineSpec,
  type Loaded,
  type OpenItemSpec,
  type OpenItemState,
  type Treatment,
} from '../../kernel';
import { divRound, formatMoney, LEDGER_CURRENCY, parseMoney } from '../../money';
import { questionIssue } from '../../questions/kinds';
import { RuleGapError, type RuleContext } from '../../rules';
import { parseLocalDate, type LocalDate } from '../../time';
import { Amount } from '../../values';
import {
  distribute,
  distributeSeparate,
  type AdvanceRule,
  type Distribution,
  type DistributionOrder,
} from './distribution';
import { taxDocumentKinds, type TaxDecisionDocument } from './documents';
import {
  accountOfType,
  fineTag,
  obligationOf,
  obligationTag,
  obligationTypeOf,
  taxTypeLabels,
  taxTypes,
  undistributedTag,
  type Obligation,
  type ObligationCatalogue,
  type TaxAccounts,
} from './obligations';
import type { AccessoryRates, DecisionDue } from './parameters';

/*
 * The tax account's treatments (T2): a payment to the state distributed as the law distributes
 * it (`tax.pay`), a payment not yet distributed distributed once obligations fall due
 * (`tax.distribute`), and ANAF's decisions booked from the document (`tax.decision`): interest
 * and penalties, assessed differences and fines, refunds and offsets.
 */

const amount = z
  .string()
  .regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/, 'Folosiți o sumă pozitivă cu cel mult două zecimale.');
const localDate = z
  .string()
  .refine((value): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value))
  .transform((value) => parseLocalDate(value));
const block = (code: string, message: string, path?: string, details?: JsonValue): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
  ...(details === undefined ? {} : { details }),
});
const ack = (code: string, message: string, details?: JsonValue): Issue => ({
  code,
  severity: 'ack',
  message,
  ...(details === undefined ? {} : { details }),
});
const info = (code: string, message: string, details?: JsonValue): Issue => ({
  code,
  severity: 'info',
  message,
  ...(details === undefined ? {} : { details }),
});
const lei = (bani: bigint) => formatMoney(bani, LEDGER_CURRENCY);

/** What the treatments read of the register on a date, or the gap that stops them. */
interface TaxRules {
  catalogue: ObligationCatalogue;
  accounts: TaxAccounts;
  order: DistributionOrder;
  advance: AdvanceRule;
}
function taxRules(rules: RuleContext, date: LocalDate): TaxRules | Issue {
  try {
    return {
      catalogue: rules.param<ObligationCatalogue>(
        'ro.taxaccount.obligations',
        'payment_date',
        date,
      ),
      accounts: rules.param<TaxAccounts>(
        'ro.taxaccount.accounts',
        'accounting_transaction_date',
        date,
      ),
      order: rules.param<DistributionOrder>('ro.taxaccount.distribution', 'payment_date', date),
      advance: rules.param<AdvanceRule>('ro.taxaccount.advance', 'payment_date', date),
    };
  } catch (error) {
    if (error instanceof RuleGapError) return block('RULE_GAP', error.message);
    throw error;
  }
}

/** The facts the distribution depends on: a legal person's single account (55.03), without
 * payment facilities or insolvency, whose order the engine does not apply (art. 163 alin. (10),
 * art. 165 alin. (4)–(6), OPANAF nr. 1.613/2018 cap. II–III). */
function scopeIssues(loaded: Loaded, date: LocalDate): Issue[] {
  const form = profileAt(loaded, 'entity.form', date);
  if (form === 'pfa' || form === 'ii' || form === 'if')
    return [
      block(
        'TAX_ACCOUNT_INDIVIDUAL',
        'Plățile persoanelor fizice în contul unic 55.04 se distribuie după metodologia lor (OPANAF nr. 2.937/2018), pe care aplicația nu o acoperă.',
      ),
    ];
  const facilities = profileAt(loaded, 'tax.facilities', date);
  if (facilities === null)
    return [
      questionIssue(
        'TAX_FACILITIES',
        'Nu se știe dacă societatea beneficiază de înlesniri la plată (eșalonare, amânare) sau este în insolvență ori în proceduri de prevenire a insolvenței: distribuirea plăților urmează atunci altă ordine (art. 163 alin. (10)). Întrebați (profile.fact tax.facilities).',
        {
          kind: 'profile.fact',
          subject: { kind: 'profile', id: 'tax.facilities' },
          params: { axis: 'tax.facilities', from: date },
        },
      ),
    ];
  if (facilities !== 'none')
    return [
      block(
        'TAX_FACILITIES_UNSUPPORTED',
        'Cu înlesniri la plată sau în insolvență, plățile se sting în ordinea art. 165 alin. (4)–(6) și a OPANAF nr. 1.613/2018 cap. II–III, pe care aplicația nu o acoperă.',
      ),
    ];
  return [];
}

/** The authority's items: the obligations it is owed and what it owes back. */
function authorityItems(loaded: Loaded, authorityId: string) {
  const items = [...loaded.openItems.values()].filter(
    (item) => item.partyId === authorityId && item.balanceBani !== 0n,
  );
  return {
    payable: items.filter((item) => item.kind === 'tax.payable' && item.balanceBani < 0n),
    receivable: items.filter((item) => item.kind === 'tax.receivable' && item.balanceBani > 0n),
  };
}

const describe = (obligation: Obligation) =>
  `${obligation.type === 'fine' ? 'Amendă' : obligation.type === 'other' ? `Cont ${obligation.account}` : taxTypeLabels[obligation.type]}${obligation.period ? ` ${obligation.period}` : ''}${obligation.category === 'accessory' ? ' (accesorii)' : ''}`;

/** The distribution as an effect's details show it. */
function distributionDetails(distribution: Distribution): JsonValue {
  return distribution.allocations.map((allocation) => ({
    openItem: allocation.obligation.id,
    obligation: describe(allocation.obligation),
    type: allocation.obligation.type,
    period: allocation.obligation.period,
    budget: allocation.obligation.budget,
    category: allocation.obligation.category,
    due: allocation.obligation.due,
    stage: allocation.stage,
    on: allocation.on,
    amount: lei(allocation.bani),
  }));
}

/** Debit lines settling the allocations, one per obligation. */
function settlementLines(distribution: Distribution, authorityId: string): LineSpec[] {
  const totals = new Map<string, { item: Obligation; bani: bigint }>();
  for (const allocation of distribution.allocations) {
    const known = totals.get(allocation.obligation.id) ?? {
      item: allocation.obligation,
      bani: 0n,
    };
    known.bani += allocation.bani;
    totals.set(allocation.obligation.id, known);
  }
  return [...totals.values()].map(({ item, bani }) => ({
    account: item.account,
    side: 'D' as const,
    bani,
    openItem: item.id,
    partyId: authorityId,
  }));
}

const undistributedItem = (accounts: TaxAccounts, authorityId: string): OpenItemSpec => ({
  ref: 'undistributed',
  kind: 'tax.receivable',
  controlAccount: accounts.undistributed,
  partyId: authorityId,
  currency: LEDGER_CURRENCY,
  normalSide: 'D',
  mayReverse: false,
});

const clauses = {
  single: [
    'L207/2015:art.163(2)-(5)',
    'L207/2015:art.165(1),(3)',
    'OPANAF1613/2018:pct.4-7',
    'OPANAF551/2021:anexa',
  ],
  separate: ['L207/2015:art.163(7)', 'L207/2015:art.165(1),(3)'],
  advance: ['OPANAF1613/2018:pct.8-10', 'L207/2015:art.173(3)'],
  designation: ['L207/2015:art.165(8)', 'OMFP3832/2015:art.I'],
};

export const taxPaymentInput = z
  .object({
    movementId: z.uuid(),
    /** The tax authority (ANAF) as a partner: the obligations are its open items. */
    authorityId: z.uuid(),
    /**
     * Where the money went, as the payment order shows: `single`, the single account (55.03),
     * distributed by ANAF; or the obligation type whose own budget account it was paid into
     * (VAT, the work insurance contribution: art. 163 alin. (7)). For money received, the refund.
     */
    to: z.union([z.literal('single'), z.enum(taxTypes)]),
    /** Where the law lets the payer choose (art. 165 alin. (8)): obligations established by an
     * inspection, a decision's accessories and fines, named by the payment's record number
     * (NEP); for money received, the claims it refunds. */
    designations: z
      .array(
        z
          .object({
            openItem: z.uuid(),
            amount,
            nep: z
              .string()
              .regex(/^\d{23}$/)
              .optional(),
          })
          .strict(),
      )
      .max(50)
      .default([]),
    /** The due date of an obligation the books cannot tell (an opening balance), as its return
     * or decision states it. */
    dueDates: z
      .array(z.object({ openItem: z.uuid(), dueDate: localDate }).strict())
      .max(50)
      .default([]),
    description: z.string().trim().min(3).max(500).optional(),
  })
  .strict();
export type TaxPaymentInput = z.infer<typeof taxPaymentInput>;

/** The obligations the authority's open items stand for, with any due date the input states. */
function obligationsFor(
  loaded: Loaded,
  authorityId: string,
  rules: RuleContext,
  taxes: TaxRules,
  dueDates: readonly { openItem: string; dueDate: LocalDate }[] = [],
): Obligation[] {
  const stated = new Map(dueDates.map((item) => [item.openItem, item.dueDate]));
  return authorityItems(loaded, authorityId).payable.map((item) => {
    const obligation = obligationOf(item, taxes.catalogue, taxes.accounts, rules);
    const due = obligation.due ?? stated.get(item.id) ?? null;
    return {
      ...obligation,
      due,
      age: obligation.age ?? due,
    };
  });
}

/**
 * A payment to the state (or money received from it), explained as the law distributes it:
 * into the single account, between budgets in proportion, within a budget by category (withheld
 * at source, other principal, accessories) and by age, what the payer designated where allowed
 * first; into a type's own account, that type's obligations by age. Under `at_due_date` it also
 * settles the obligations the books hold falling due later, each on its due date; what no
 * obligation takes is a payment not yet distributed, a claim on the budget (4482). Money received
 * from the state settles what it refunds: VAT to recover (4424) or a sum paid in excess.
 */
export const taxPayment: Treatment<TaxPaymentInput> = {
  id: 'tax.pay',
  version: 1,
  description:
    'Plata către stat (contul unic sau contul bugetar al unei obligații), distribuită pe obligații în ordinea legală; restituirile primite.',
  input: taxPaymentInput,
  agent: true,
  summary:
    "A payment to the state (the single account, or one tax's own account) distributed over the obligations in the legal order; refunds received.",
  toolset: 'bank',
  dataClasses: ['books', 'tax'],
  subject: (input) => `movement:${input.movementId}`,
  plan: (input) => ({
    movements: [input.movementId],
    parties: [input.authorityId],
    openItems: [{ partyId: input.authorityId, openOnly: true, origins: true }],
    profile: true,
  }),
  evaluate(input, loaded, rules) {
    const movement = loaded.movements.get(input.movementId);
    if (!movement)
      return {
        effect: null,
        issues: [block('MOVEMENT', 'Mișcarea bancară nu este disponibilă.', 'movementId')],
      };
    const issues: Issue[] = [];
    const authority = loaded.parties.get(input.authorityId);
    if (!authority || authority.kind !== 'ro_public_institution')
      issues.push(
        block('TAX_AUTHORITY', 'Partenerul nu este o instituție publică (ANAF).', 'authorityId'),
      );
    if (movement.currency !== LEDGER_CURRENCY)
      issues.push(block('CURRENCY', 'Plățile către stat se fac în lei.', 'movementId'));
    const date = movement.bookingDate;
    issues.push(...scopeIssues(loaded, date));
    const taxes = taxRules(rules, date);
    if ('code' in taxes) return { effect: null, issues: [...issues, taxes] };
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };
    const received = movement.amountMinor > 0n;
    const total = received ? movement.amountMinor : -movement.amountMinor;
    const lines: LineSpec[] = [];
    const openItems: OpenItemSpec[] = [];
    let details: { [key: string]: JsonValue } = {
      movementId: movement.id,
      reference: movement.reference,
      to: input.to,
    };

    if (received) {
      // A refund settles the claims it repays: those named, else the one claim it equals.
      const { receivable } = authorityItems(loaded, input.authorityId);
      const named = input.designations.map((item, index) => ({
        item: receivable.find((candidate) => candidate.id === item.openItem),
        bani: parseMoney(item.amount, LEDGER_CURRENCY),
        index,
      }));
      let parts: { item: OpenItemState; bani: bigint }[];
      if (named.length) {
        for (const part of named)
          if (!part.item || part.bani > part.item.balanceBani)
            issues.push(
              block(
                'TAX_REFUND_ITEM',
                'Restituirea se înregistrează pe o creanță asupra bugetului (TVA de recuperat, sume plătite în plus) a autorității, în limita soldului ei.',
                `designations.${part.index}`,
              ),
            );
        parts = named.flatMap((part) => (part.item ? [{ item: part.item, bani: part.bani }] : []));
      } else {
        const matching = receivable.filter((item) => item.balanceBani === total);
        if (matching.length !== 1)
          issues.push(
            block(
              'TAX_REFUND_ITEM',
              matching.length
                ? 'Mai multe creanțe asupra bugetului au exact această sumă: indicați-o pe cea restituită (designations), din decizia de restituire sau rambursare.'
                : 'Nicio creanță asupra bugetului nu are această sumă: indicați creanțele restituite (designations), din decizia de restituire sau rambursare.',
            ),
          );
        parts = matching.length === 1 ? [{ item: matching[0]!, bani: total }] : [];
      }
      const explained = parts.reduce((sum, part) => sum + part.bani, 0n);
      if (!issues.length && explained !== total)
        issues.push(
          block(
            'UNEXPLAINED',
            `Creanțele indicate (${lei(explained)} lei) diferă de suma primită (${lei(total)} lei).`,
          ),
        );
      if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };
      lines.push({ account: movement.ledgerAccount, side: 'D', bani: total });
      for (const part of parts)
        lines.push({
          account: part.item.controlAccount,
          side: 'C',
          bani: part.bani,
          openItem: part.item.id,
          partyId: input.authorityId,
        });
      details = {
        ...details,
        refunded: parts.map((part) => ({ openItem: part.item.id, amount: lei(part.bani) })),
        clauses: ['L207/2015:art.168(1),(8)-(10)', 'OMFP1802/2014:conturi.442'],
      };
    } else {
      const obligations = obligationsFor(loaded, input.authorityId, rules, taxes, input.dueDates);
      // Designations: only where the law lets the payer choose.
      const designations = new Map<string, bigint>();
      input.designations.forEach((item, index) => {
        const obligation = obligations.find((candidate) => candidate.id === item.openItem);
        const bani = parseMoney(item.amount, LEDGER_CURRENCY);
        if (!obligation || bani > obligation.owed)
          issues.push(
            block(
              'TAX_DESIGNATION',
              'Obligația indicată nu este datorată autorității, sau suma depășește soldul ei.',
              `designations.${index}`,
            ),
          );
        else if (!obligation.designatable)
          issues.push(
            block(
              'TAX_DESIGNATION',
              `${describe(obligation)} se stinge în ordinea legală, nu după alegerea plătitorului: plătitorul alege doar obligațiile stabilite de inspecție, accesoriile dintr-o decizie și amenzile (art. 165 alin. (8)), prin numărul de evidență a plății.`,
              `designations.${index}`,
            ),
          );
        else designations.set(obligation.id, (designations.get(obligation.id) ?? 0n) + bani);
      });
      input.dueDates.forEach((item, index) => {
        const obligation = obligations.find((candidate) => candidate.id === item.openItem);
        if (
          !obligation ||
          obligationOf(loaded.openItems.get(item.openItem)!, taxes.catalogue, taxes.accounts, rules)
            .due !== null
        )
          issues.push(
            block(
              'TAX_DUE_STATED',
              'Scadența se indică doar pentru o obligație a cărei scadență nu reiese din registre.',
              `dueDates.${index}`,
            ),
          );
      });
      if (input.dueDates.length)
        issues.push(
          ack(
            'TAX_DUE_STATED',
            'Scadențele indicate (din declarații sau decizii anterioare registrelor) se confirmă.',
          ),
        );
      let distribution: Distribution;
      if (input.to === 'single') {
        const unknown = obligations.filter(
          (item) => !item.separate && item.due === null && !designations.has(item.id),
        );
        if (unknown.length)
          issues.push(
            block(
              'TAX_DUE_UNKNOWN',
              `Scadența nu reiese din registre pentru ${unknown.map(describe).join(', ')}: indicați-o (dueDates), din declarația sau decizia care a stabilit-o.`,
              'dueDates',
              { openItems: unknown.map((item) => item.id) },
            ),
          );
        if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };
        distribution = distribute(
          total,
          date,
          obligations,
          { order: taxes.order, advance: taxes.advance },
          designations,
        );
      } else {
        const type = input.to;
        const entry = obligationTypeOf(type, taxes.catalogue);
        if (entry?.single)
          issues.push(
            block(
              'TAX_SINGLE_ACCOUNT',
              `${taxTypeLabels[type]} se plătește în contul unic (OPANAF nr. 1.612/2018, nomenclatorul): plata nu se face în contul ei.`,
              'to',
            ),
          );
        if (!entry)
          issues.push(block('TAX_TYPE', `${taxTypeLabels[type]} nu este în nomenclator.`, 'to'));
        if (designations.size)
          issues.push(
            block(
              'TAX_DESIGNATION',
              'O plată în contul bugetar al unei obligații o stinge pe aceasta, în ordinea vechimii.',
              'designations',
            ),
          );
        const own = obligations.filter((item) => item.type === type);
        const unknown = own.filter((item) => item.due === null);
        if (unknown.length)
          issues.push(
            block(
              'TAX_DUE_UNKNOWN',
              `Scadența nu reiese din registre pentru ${unknown.map(describe).join(', ')}: indicați-o (dueDates).`,
              'dueDates',
              { openItems: unknown.map((item) => item.id) },
            ),
          );
        if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };
        distribution = distributeSeparate(total, date, own, taxes.advance);
      }
      lines.push(...settlementLines(distribution, input.authorityId));
      if (distribution.undistributed > 0n) {
        openItems.push(undistributedItem(taxes.accounts, input.authorityId));
        lines.push({
          account: taxes.accounts.undistributed,
          side: 'D',
          bani: distribution.undistributed,
          openItem: 'undistributed',
          partyId: input.authorityId,
          analytics: { item: undistributedTag },
          memo:
            input.to === 'single'
              ? 'Plată în contul unic nedistribuită'
              : `Plată în plus: ${taxTypeLabels[input.to]}`,
        });
        issues.push(
          info(
            'TAX_UNDISTRIBUTED',
            `Rămân nedistribuiți ${lei(distribution.undistributed)} lei: nicio obligație din registre nu îi preia. Se distribuie (tax.distribute) când obligațiile devin scadente; pentru suma plătită înaintea declarării nu se datorează accesorii (art. 173 alin. (3)).`,
          ),
        );
      }
      if (distribution.allocations.some((allocation) => allocation.stage === 'later'))
        issues.push(
          info(
            'TAX_LATER',
            'O parte a plății stinge obligații cu scadența după data plății, la scadența fiecăreia.',
          ),
        );
      lines.push({ account: movement.ledgerAccount, side: 'C', bani: total });
      details = {
        ...details,
        distribution: distributionDetails(distribution),
        undistributed: lei(distribution.undistributed),
        trace: distribution.trace,
        clauses: [
          ...(input.to === 'single' ? clauses.single : clauses.separate),
          ...clauses.advance,
          ...(designations.size ? clauses.designation : []),
        ],
      };
    }
    const effect: Effect = {
      schema: 'effect@1',
      date,
      journalClass: 'general',
      journalCode: 'BANCA',
      description:
        input.description ??
        `${received ? 'Restituire de la buget' : input.to === 'single' ? 'Plată în contul unic' : `Plată ${taxTypeLabels[input.to]}`} ${movement.reference}`.slice(
          0,
          500,
        ),
      lines,
      openItems,
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: `${received ? 'Încasare de la buget' : 'Plată către buget'} de ${lei(total)} lei din ${date}.`,
        details,
      },
    };
    return { effect, issues };
  },
};

export const taxDistributionInput = z
  .object({
    authorityId: z.uuid(),
    /** The day of the distribution: obligations due by then take the money paid earlier. */
    date: localDate,
    round: z.number().int().min(1).max(99).default(1),
  })
  .strict();
export type TaxDistributionInput = z.infer<typeof taxDistributionInput>;

/**
 * Distributes payments to the single account not yet distributed (4482, oldest first) over the
 * obligations due by a date, in the order of a payment's distribution: what the books hold once
 * a return is filed after the payment (OPANAF nr. 1.613/2018 pct. 8–10: the sums kept
 * undistributed settle the obligations registered later, by the payments' age).
 */
export const taxDistribution: Treatment<TaxDistributionInput> = {
  id: 'tax.distribute',
  version: 1,
  description:
    'Distribuirea plăților în contul unic încă nedistribuite pe obligațiile scadente, în ordinea legală.',
  input: taxDistributionInput,
  agent: true,
  summary:
    'Distributes single-account payments not yet distributed over the obligations now due, in the legal order.',
  toolset: 'tax',
  dataClasses: ['books', 'tax'],
  subject: (input) => `tax.distribute:${input.authorityId}:${input.date}:${input.round}`,
  plan: (input) => ({
    parties: [input.authorityId],
    openItems: [{ partyId: input.authorityId, openOnly: true, origins: true }],
    profile: true,
  }),
  evaluate(input, loaded, rules) {
    const issues = scopeIssues(loaded, input.date);
    const taxes = taxRules(rules, input.date);
    if ('code' in taxes) return { effect: null, issues: [...issues, taxes] };
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };
    const sources = authorityItems(loaded, input.authorityId)
      .receivable.filter(
        (item) =>
          item.controlAccount.split('.')[0] === taxes.accounts.undistributed &&
          item.origin?.tag === undistributedTag &&
          (item.origin?.date ?? input.date) <= input.date,
      )
      .sort(
        (a, b) =>
          (a.origin?.date ?? '').localeCompare(b.origin?.date ?? '') || a.id.localeCompare(b.id),
      );
    const available = sources.reduce((sum, item) => sum + item.balanceBani, 0n);
    if (available === 0n)
      return {
        effect: null,
        issues: [
          block('NOTHING_TO_DISTRIBUTE', 'Autoritatea nu are plăți nedistribuite la această dată.'),
        ],
      };
    const obligations = obligationsFor(loaded, input.authorityId, rules, taxes).filter(
      (item) => !item.separate,
    );
    const distribution = distribute(available, input.date, obligations, {
      order: taxes.order,
      advance: { beyondDue: 'undistributed' },
    });
    const distributed = available - distribution.undistributed;
    if (distributed === 0n)
      return {
        effect: null,
        issues: [
          block(
            'NOTHING_DUE',
            'Nicio obligație plătită în contul unic nu este scadentă la această dată.',
          ),
        ],
      };
    const lines = settlementLines(distribution, input.authorityId);
    let left = distributed;
    for (const source of sources) {
      if (left === 0n) break;
      const part = left < source.balanceBani ? left : source.balanceBani;
      lines.push({
        account: source.controlAccount,
        side: 'C',
        bani: part,
        openItem: source.id,
        partyId: input.authorityId,
      });
      left -= part;
    }
    const effect: Effect = {
      schema: 'effect@1',
      date: input.date,
      journalClass: 'general',
      journalCode: 'IMPOZITE',
      description: `Distribuirea plăților în contul unic la ${input.date}`,
      lines,
      openItems: [],
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: `Plăți nedistribuite de ${lei(available)} lei: ${lei(distributed)} lei stinse la ${input.date}.`,
        details: {
          distribution: distributionDetails(distribution),
          left: lei(distribution.undistributed),
          trace: distribution.trace,
          clauses: [...clauses.single, ...clauses.advance],
        },
      },
    };
    return { effect, issues };
  },
};

export const taxDecisionInput = z
  .object({
    /** The decision, recorded with `documents.record` (kind `tax.decision`). */
    documentId: z.uuid(),
    authorityId: z.uuid(),
    /** For an assessment: the account each principal difference is expensed on, by line. */
    accounts: z
      .array(
        z
          .object({
            line: z.number().int().min(0).max(299),
            account: z.string().regex(/^6\d{2,5}$/),
          })
          .strict(),
      )
      .max(300)
      .default([]),
  })
  .strict();
export type TaxDecisionInput = z.infer<typeof taxDecisionInput>;

/** The due date of what a decision communicated on `date` establishes (art. 156 alin. (1)). */
export function decisionDueDate(date: LocalDate, rule: DecisionDue): LocalDate {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  const day = Number(date.slice(8, 10)) <= rule.split ? rule.first : rule.second;
  return `${next.year}-${String(next.month).padStart(2, '0')}-${String(day).padStart(2, '0')}` as LocalDate;
}

/** An accessory recomputed from the decision's base and days at the daily rate, in whole lei
 * (OPANAF nr. 727/2019 anexa nr. 1 pct. 11 rounds to the leu). */
export function accessoryOf(base: string, days: number, ratePercent: string): bigint {
  const bani = new Amount(base).mul(100).mul(ratePercent).mul(days).div(100);
  return divRound(BigInt(bani.toFixed(0)), 100n, 'halfAwayFromZero') * 100n;
}

/**
 * Books an ANAF decision from the document: interest, late-payment and non-declaration
 * penalties and fines owed to the budget (Dr 6581 / Cr 4481), assessed differences of principal
 * obligations (Dr the expense account given / Cr the tax's account), each an obligation of the
 * authority due by art. 156 alin. (1) and tagged with the obligation it follows; a refund or an
 * offset extinguishes the obligations it names with the claims it names (VAT to recover, sums
 * paid in excess), the refund itself arriving through the bank. The engine recomputes interest
 * and penalties from the base and days the decision shows; a difference is the reviewer's to
 * acknowledge, the decision being ANAF's act.
 */
export const taxDecision: Treatment<TaxDecisionInput> = {
  id: 'tax.decision',
  version: 1,
  description:
    'Decizia ANAF înregistrată din document: dobânzi, penalități, diferențe stabilite, amenzi, rambursări și compensări.',
  input: taxDecisionInput,
  agent: true,
  summary:
    'An ANAF decision booked from the document: interest, penalties, assessed differences, fines, refunds and offsets.',
  toolset: 'tax',
  dataClasses: ['books', 'tax'],
  subject: (input) => `document:${input.documentId}`,
  plan: (input) => ({
    documents: [input.documentId],
    parties: [input.authorityId],
    openItems: [{ partyId: input.authorityId, openOnly: true, origins: true }],
    profile: true,
  }),
  evaluate(input, loaded, rules) {
    const document = loaded.documents.get(input.documentId);
    if (!document || document.kind !== taxDocumentKinds.decision)
      return {
        effect: null,
        issues: [
          block('DOCUMENT_KIND', 'Documentul nu este o decizie ANAF (tax.decision).', 'documentId'),
        ],
      };
    const decision = document.body as unknown as TaxDecisionDocument;
    const issues: Issue[] = [];
    const authority = loaded.parties.get(input.authorityId);
    if (!authority || authority.kind !== 'ro_public_institution')
      issues.push(
        block('TAX_AUTHORITY', 'Partenerul nu este o instituție publică (ANAF).', 'authorityId'),
      );
    const date = decision.communicatedOn as LocalDate;
    const taxes = taxRules(rules, date);
    if ('code' in taxes) return { effect: null, issues: [...issues, taxes] };
    let rates: AccessoryRates;
    let due: LocalDate;
    try {
      rates = rules.param<AccessoryRates>('ro.taxaccount.interest', 'payment_date', date);
      due = decisionDueDate(
        date,
        rules.param<DecisionDue>('ro.taxaccount.decision_due', 'accounting_transaction_date', date),
      );
    } catch (error) {
      if (error instanceof RuleGapError)
        return { effect: null, issues: [...issues, block('RULE_GAP', error.message)] };
      throw error;
    }
    const lines: LineSpec[] = [];
    const openItems: OpenItemSpec[] = [];
    const checked: JsonValue[] = [];
    const debt = (index: number, account: string, tag: string, bani: bigint) => {
      const ref = `line:${index}`;
      openItems.push({
        ref,
        kind: 'tax.payable',
        controlAccount: account,
        partyId: input.authorityId,
        currency: LEDGER_CURRENCY,
        normalSide: 'C',
        mayReverse: false,
        dueDate: due,
        documentId: input.documentId,
      });
      lines.push({
        account,
        side: 'C',
        bani,
        openItem: ref,
        partyId: input.authorityId,
        analytics: { item: tag },
      });
    };
    const { payable, receivable } = authorityItems(loaded, input.authorityId);
    const obligations = payable.map((item) =>
      obligationOf(item, taxes.catalogue, taxes.accounts, rules),
    );
    const sourceUse = new Map<string, bigint>();
    decision.lines.forEach((line, index) => {
      const bani = parseMoney(line.amount, LEDGER_CURRENCY);
      const path = `lines.${index}`;
      const period = line.period ?? '';
      if (
        line.kind === 'interest' ||
        line.kind === 'late_penalty' ||
        line.kind === 'nondeclaration_penalty'
      ) {
        lines.push({
          account: taxes.accounts.accessoriesExpense,
          side: 'D',
          bani,
          memo: `${line.label} (decizia ${decision.number})`.slice(0, 500),
        });
        debt(
          index,
          taxes.accounts.accessories,
          obligationTag(line.obligation!, period, line.kind),
          bani,
        );
        const rate =
          line.kind === 'interest'
            ? rates.interest
            : line.kind === 'late_penalty'
              ? rates.latePenalty
              : rates.nondeclaration;
        if (line.base !== null && line.days !== null && line.kind !== 'nondeclaration_penalty') {
          const computed = accessoryOf(line.base, line.days, rate);
          const differs = computed - bani >= 100n || bani - computed >= 100n;
          checked.push({
            line: index,
            base: line.base,
            days: line.days,
            rate,
            computed: lei(computed),
            stated: lei(bani),
            differs,
          });
          if (differs)
            issues.push(
              ack(
                'TAX_DECISION_AMOUNT',
                `Rândul ${index + 1}: ${line.base} lei × ${rate}% × ${line.days} zile = ${lei(computed)} lei, iar decizia stabilește ${lei(bani)} lei. Se înregistrează suma deciziei (actul ANAF); verificați calculul sau contestați decizia.`,
                { line: index, computed: lei(computed), stated: lei(bani) },
              ),
            );
        }
        if (line.kind === 'nondeclaration_penalty')
          issues.push(
            info(
              'TAX_NONDECLARATION',
              `Rândul ${index + 1}: penalitatea de nedeclarare (art. 181) se reduce cu 75% dacă diferența este stinsă până la termenul art. 156 alin. (1); reducerea se înregistrează din decizia care o stabilește.`,
            ),
          );
        return;
      }
      if (line.kind === 'fine') {
        lines.push({
          account: taxes.accounts.accessoriesExpense,
          side: 'D',
          bani,
          memo: `${line.label} (${decision.number})`.slice(0, 500),
        });
        debt(index, taxes.accounts.accessories, fineTag, bani);
        return;
      }
      if (line.kind === 'principal') {
        const account = accountOfType(line.obligation!, taxes.catalogue);
        const expense = input.accounts.find((item) => item.line === index)?.account;
        if (!account) {
          issues.push(block('TAX_TYPE', 'Tipul obligației nu este în nomenclator.', path));
          return;
        }
        if (!expense) {
          issues.push(
            block(
              'TAX_ASSESSMENT_ACCOUNT',
              `Rândul ${index + 1}: indicați contul de cheltuieli al diferenței stabilite (accounts); o diferență a unui exercițiu anterior se corectează pe 1174 (correction.priorYear), pe care decizia nu o înregistrează.`,
              'accounts',
            ),
          );
          return;
        }
        lines.push({ account: expense, side: 'D', bani, memo: line.label.slice(0, 500) });
        debt(index, account, obligationTag(line.obligation!, period, 'assessment'), bani);
        return;
      }
      if (line.kind === 'refund') {
        const source = line.source!;
        const claims = receivable.filter(
          (item) =>
            taxes.accounts.refundable.includes(item.controlAccount.split('.')[0]!) &&
            item.origin?.treatmentId === 'vat.settle' &&
            item.origin.subject.split(':')[1] === source.period,
        );
        if (!claims.length)
          issues.push(
            block(
              'TAX_REFUND_ITEM',
              `Rândul ${index + 1}: nu există TVA de recuperat pentru perioada ${source.period ?? '?'} în registre.`,
              path,
            ),
          );
        else if (claims.reduce((sum, item) => sum + item.balanceBani, 0n) !== bani)
          issues.push(
            ack(
              'TAX_REFUND_PARTIAL',
              `Rândul ${index + 1}: suma aprobată la rambursare (${line.amount} lei) diferă de TVA de recuperat din registre pentru ${source.period}: diferența respinsă se stabilește prin decizia de impunere.`,
            ),
          );
        return;
      }
      // An offset: the obligation it extinguishes, with the claim it uses.
      const targets = obligations.filter(
        (item) =>
          item.type === line.obligation && (item.period ?? '') === period && item.owed >= bani,
      );
      const source = line.source!;
      const claims = receivable
        .filter((item) =>
          source.kind === 'vat_refund'
            ? taxes.accounts.refundable.includes(item.controlAccount.split('.')[0]!) &&
              item.origin?.treatmentId === 'vat.settle' &&
              item.origin.subject.split(':')[1] === source.period
            : item.controlAccount.split('.')[0] === taxes.accounts.undistributed,
        )
        .sort((a, b) => (a.origin?.date ?? '').localeCompare(b.origin?.date ?? ''));
      if (targets.length !== 1) {
        issues.push(
          block(
            'TAX_OFFSET_ITEM',
            `Rândul ${index + 1}: ${targets.length ? 'mai multe obligații' : 'nicio obligație'} ${line.obligation ? taxTypeLabels[line.obligation] : ''} ${period} în registre ${targets.length ? 'corespund' : 'nu acoperă suma compensată'}.`,
            path,
          ),
        );
        return;
      }
      let left = bani;
      const parts: LineSpec[] = [];
      for (const claim of claims) {
        const free = claim.balanceBani - (sourceUse.get(claim.id) ?? 0n);
        if (free <= 0n || left === 0n) continue;
        const part = left < free ? left : free;
        sourceUse.set(claim.id, (sourceUse.get(claim.id) ?? 0n) + part);
        parts.push({
          account: claim.controlAccount,
          side: 'C',
          bani: part,
          openItem: claim.id,
          partyId: input.authorityId,
        });
        left -= part;
      }
      if (left > 0n) {
        issues.push(
          block(
            'TAX_OFFSET_SOURCE',
            `Rândul ${index + 1}: creanța compensată (${source.kind === 'vat_refund' ? `TVA de recuperat ${source.period ?? ''}` : 'sume plătite în plus'}) nu acoperă ${line.amount} lei în registre.`,
            path,
          ),
        );
        return;
      }
      lines.push(
        {
          account: targets[0]!.account,
          side: 'D',
          bani,
          openItem: targets[0]!.id,
          partyId: input.authorityId,
        },
        ...parts,
      );
    });
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };
    const memo = lines.length === 0;
    const effect: Effect = {
      schema: 'effect@1',
      date: (memo ? decision.issueDate : date) as LocalDate,
      journalClass: memo ? 'memo' : 'general',
      journalCode: 'IMPOZITE',
      description: `${decision.title} nr. ${decision.number} din ${decision.issueDate}`.slice(
        0,
        500,
      ),
      lines,
      openItems,
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: memo
          ? `Decizia aprobă ${decision.totals.amount} lei; încasarea se înregistrează din extrasul de cont (tax.pay).`
          : `Decizia ${decision.number}, comunicată la ${date}: ${decision.totals.amount} lei${openItems.length ? `, de plată până la ${due}` : ''}.`,
        details: {
          decision: decision.decision,
          number: decision.number,
          communicatedOn: date,
          due: openItems.length ? due : null,
          checked,
          clauses: [
            'L207/2015:art.156(1)',
            'L207/2015:art.173(1),(4)-(5)',
            'L207/2015:art.174(1),(5)',
            'L207/2015:art.176(1)-(2)',
            'L207/2015:art.167(1)-(2)',
            'OMFP1802/2014:conturi.448',
            'OMFP1802/2014:conturi.658',
          ],
        },
      },
    };
    return { effect, issues };
  },
};
