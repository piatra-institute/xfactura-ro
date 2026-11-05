import { z } from 'zod';
import type {
  AnswerRecord,
  Effect,
  Issue,
  Loaded,
  OpenItemState,
  PartyRecord,
  Treatment,
} from '../../kernel';
import { divRound, formatMoney, LEDGER_CURRENCY, parseMoney, parseScaled } from '../../money';
import {
  questionIssue,
  questionKinds,
  type NonresidentCertificateAnswer,
  type NonresidentPayeeAnswer,
} from '../../questions/kinds';
import { RuleGapError, type RuleContext } from '../../rules';
import { addDays, isLocalDate, type LocalDate } from '../../time';
import { interestAccountCodes } from '../financing';
import { whtCode, type Withheld } from '../withholding/codes';
import type { NonresidentBeneficiary, NonresidentIncome } from '../withholding/parameters';

/*
 * Tax withheld at source from what a company pays individuals and non-residents (O1).
 *
 * - `payees.recognize` books what a contract makes owed to a resident individual for a period:
 *   the rent of a good the company uses (612, Codul fiscal art. 84^1) or the remuneration of an
 *   intellectual property right (art. 72), on the expense account given, against the person's
 *   payable on 462 (creditori diverși), the account OMFP nr. 1.802/2014 keeps for creditors other
 *   than suppliers. No invoice: the contract is the evidence.
 * - `payees.withhold` withholds, at each payment, 10% of the net income the payer sets (the gross
 *   less 20% for rent, art. 84^1 alin. (3)–(5); less 40% for intellectual property, art. 72 alin.
 *   (2), (4)), a final tax paid by the 25th of the next month: Dr 462 / Cr 446. Rent is declared in
 *   D100 (628) and D205 (tip 29); intellectual property in D112, the declaration art. 132 alin.
 *   (2) names for its payers, which the engine's D112 does not write for it yet.
 * - `nonresidents.withhold` withholds the tax on a non-resident's income from Romania (art.
 *   223–224) when it is paid: what the income is and who receives it is a per-supplier
 *   determination a person answers (`nonresident.payee`), the treaty's rate needs the residence
 *   certificate and the treaty's article (`nonresident.certificate`); without the certificate
 *   the domestic rate applies, and the certificate is asked for. Declared in D100 (631–636) and
 *   D207.
 */

const block = (code: string, message: string, path?: string): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
});
const ack = (code: string, message: string): Issue => ({ code, severity: 'ack', message });
const info = (code: string, message: string): Issue => ({ code, severity: 'info', message });
const localDate = z
  .string()
  .refine((value): boolean => isLocalDate(value))
  .transform((value) => value as LocalDate);
const amount = z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/);
const CODE = 'ANAF/Cod-fiscal-consolidat';

/** The clauses each kind of payment reads. */
export const withholdingClauses = {
  rent: [`${CODE}:art.84^1(3)-(6)`, `${CODE}:art.84^1(8)-(9)`, 'ANAF/D100:nomenclator.withholding'],
  royalties: [`${CODE}:art.72(2)-(6)`, `${CODE}:art.151(5)-(8)`, `${CODE}:art.132(2)-exceptii`],
  nonresident: [
    `${CODE}:art.223(1)`,
    `${CODE}:art.224(5)`,
    `${CODE}:art.230(1)-(2)`,
    'ANAF/D100:nomenclator.withholding',
    'ANAF/D207:structura',
  ],
} as const;

/** Whole lei, half up, of `bani × rate%`: the tax of one payment (`ro.declaration.rounding`). */
const taxOf = (bani: bigint, rate: string) =>
  divRound(bani * parseScaled(rate, 4), 100_000_000n, 'halfAwayFromZero') * 100n;
/** `bani × rate%` rounded half up to the ban. */
const shareOf = (bani: bigint, rate: string) =>
  divRound(bani * parseScaled(rate, 4), 1_000_000n, 'halfAwayFromZero');

const param = <T>(
  rules: RuleContext,
  key: string,
  date: LocalDate,
  scope?: Record<string, string>,
) => rules.param<T>(key, 'payment_date', date, scope);

// ─── Rent and intellectual property owed to resident individuals ───────────────────────────

export const payeeKinds = ['rent', 'royalties'] as const;
export type PayeeKind = (typeof payeeKinds)[number];
/** The tag of a payee's payable line: what it is owed for. */
export const payeeTag = (kind: PayeeKind) => `payee:${kind}`;
/** The tag of the 446 line of a tax withheld at source: its D100 obligation (611 for
 * intellectual property, declared in D112), by which the tax account types the item
 * (`ro.taxaccount.obligations`). */
export const withheldTag = (type: string) => `wht:${type}`;

export const payeeInput = z
  .object({
    kind: z.enum(payeeKinds),
    /** The individual: the landlord or the author (holder of the right). */
    partyId: z.uuid(),
    /** The contract: the rental contract, the assignment or licence of the right. */
    evidenceId: z.uuid(),
    /** The day the amount becomes owed (the period's end, or the contract's due date). */
    date: localDate,
    /** The period it is for, `YYYY-MM`. */
    period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    /** The gross amount owed under the contract, in lei. */
    amount,
    /** The expense account: 612 for rent; for intellectual property, the account of what is used
     * (612 for a licence, 628 for a work commissioned, …), a class 6 account. */
    account: z.string().regex(/^6\d{2,3}(\.[A-Za-z0-9]{1,20})?$/),
  })
  .strict();
export type PayeeInput = z.infer<typeof payeeInput>;

const notResident = (party: PartyRecord | undefined) =>
  party?.kind === 'ro_legal_entity' || party?.kind === 'ro_public_institution'
    ? 'Beneficiarul este o persoană juridică: chiria sau drepturile i se plătesc pe factură, fără reținere la sursă.'
    : party?.kind === 'ro_individual_enterprise'
      ? 'Veniturile unei întreprinderi individuale sau ale unui PFA sunt venituri din activități independente, facturate: reținerea pentru chirii și drepturi de proprietate intelectuală nu se aplică aici.'
      : party?.kind === 'eu_taxable' || party?.kind === 'non_eu'
        ? 'Beneficiarul este nerezident: redevențele lui se rețin cu nonresidents.withhold; chiria unei persoane fizice nerezidente (art. 223 alin. (2) lit. g)) nu este încă suportată.'
        : 'Beneficiarul nu este o persoană fizică rezidentă.';

/**
 * What a contract makes owed to a resident individual for a period: the rent of a good the company
 * uses (Dr 612) or the remuneration of an intellectual property right (Dr the account given),
 * against the person's payable on 462. The tax is withheld when it is paid (`payees.withhold`).
 */
export const payeeRecognition: Treatment<PayeeInput> = {
  id: 'payees.recognize',
  version: 1,
  description:
    'Chiria sau drepturile de proprietate intelectuală datorate unei persoane fizice, din contract.',
  input: payeeInput,
  agent: true,
  summary:
    'Rent or intellectual property owed to a resident individual under a contract, for a period (no invoice).',
  dataClasses: ['books'],
  subject: (input) => `payee:${input.kind}:${input.evidenceId}:${input.partyId}:${input.period}`,
  plan: (input) => ({ evidence: [input.evidenceId], parties: [input.partyId] }),
  evaluate(input, loaded) {
    const issues: Issue[] = [];
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(block('EVIDENCE', 'Contractul nu este disponibil.', 'evidenceId'));
    const party = loaded.parties.get(input.partyId);
    if (party?.kind !== 'ro_individual')
      issues.push(block('BENEFICIARY', notResident(party), 'partyId'));
    if (input.kind === 'rent' && input.account.split('.')[0] !== '612')
      issues.push(
        block(
          'ACCOUNT',
          'Chiria se înregistrează în contul 612 „Cheltuieli cu redevențele, locațiile de gestiune și chiriile”.',
          'account',
        ),
      );
    const gross = parseMoney(input.amount, LEDGER_CURRENCY);
    if (gross === 0n) issues.push(block('AMOUNT', 'Suma datorată este zero.', 'amount'));
    if (issues.length) return { effect: null, issues };
    const what = input.kind === 'rent' ? 'Chirie' : 'Drepturi de proprietate intelectuală';
    const effect: Effect = {
      schema: 'effect@1',
      date: input.date,
      journalClass: 'general',
      journalCode: 'DIVERSE',
      description: `${what} ${input.period} ${party!.name}`.slice(0, 500),
      lines: [
        { account: input.account, side: 'D', bani: gross },
        {
          account: '462',
          side: 'C',
          bani: gross,
          openItem: 'payee',
          partyId: input.partyId,
          // What the payable is for, which its withholding reads from the item's origin.
          analytics: { item: payeeTag(input.kind) },
        },
      ],
      openItems: [
        {
          ref: 'payee',
          kind: 'payable',
          controlAccount: '462',
          partyId: input.partyId,
          currency: LEDGER_CURRENCY,
          normalSide: 'C',
          mayReverse: false,
        },
      ],
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: `${what} brută ${formatMoney(gross, LEDGER_CURRENCY)} lei pentru ${input.period}, datorată lui ${party!.name}; impozitul se reține la plată.`,
        details: {
          payee: input.kind,
          period: input.period,
          clauses: [...withholdingClauses[input.kind]],
        },
      },
    };
    return {
      effect,
      issues:
        input.kind === 'royalties'
          ? [
              info(
                'IP_ACCOUNT',
                `Drepturile de proprietate intelectuală se înregistrează în contul ales (${input.account}): reglementările contabile nu le dau un cont anume.`,
              ),
            ]
          : [],
    };
  },
};

export const payeeWithholdingInput = z
  .object({
    /** The person's payable on 462 that `payees.recognize` opened. */
    openItem: z.uuid(),
    /** The day it is paid. */
    date: localDate,
    /** The gross amount paid now, in lei. */
    gross: amount,
    authorityId: z.uuid(),
    /** For intellectual property: the facts of the contract the withholding depends on. */
    royalties: z
      .object({
        /** The contract makes the payer withhold the person's CAS and CASS (art. 151 alin.
         * (6)–(7), art. 174^1 alin. (3)–(4)), declared in D112. */
        contributionsByContract: z.boolean(),
        /** The author opted to set the net income in the real system (art. 73). */
        realSystem: z.boolean(),
        /** Heirs, the resale right or the private-copy remuneration (art. 72 alin. (3)): no flat
         * deduction, the collective management's share instead. */
        collectiveShare: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PayeeWithholdingInput = z.infer<typeof payeeWithholdingInput>;

/**
 * The tax withheld from rent or intellectual property paid to a resident individual: the net
 * income the payer sets at the payment (the gross less 20% for rent, art. 84^1 alin. (3); less 40%
 * for intellectual property, art. 72 alin. (2)), taxed at 10% (art. 84^1 alin. (5), art. 72 alin.
 * (4)) in whole lei, a final tax: Dr 462 / Cr 446, owed to the authority. The net is then paid
 * through the bank against the same 462 item. The person's CASS on rent is theirs to declare.
 */
export const payeeWithholding: Treatment<PayeeWithholdingInput> = {
  id: 'payees.withhold',
  version: 1,
  description:
    'Impozitul reținut la plata chiriei sau a drepturilor de proprietate intelectuală către o persoană fizică.',
  input: payeeWithholdingInput,
  agent: true,
  summary:
    'Tax withheld when rent or intellectual property is paid to a resident individual (10% of the net income: gross less 20% for rent, less 40% for intellectual property).',
  toolset: 'tax',
  dataClasses: ['books', 'tax'],
  subject: (input) => `payee-tax:${input.openItem}:${input.date}`,
  plan: (input) => ({
    openItems: [{ ids: [input.openItem], origins: true }],
    parties: [input.authorityId],
  }),
  followUp(input, loaded) {
    const item = loaded.openItems.get(input.openItem);
    return item ? { parties: [item.partyId] } : null;
  },
  evaluate(input, loaded, rules) {
    const issues: Issue[] = [];
    const item = loaded.openItems.get(input.openItem);
    const origin = item?.origin;
    const kind = payeeKinds.find((candidate) => origin?.tag === payeeTag(candidate));
    if (
      !item ||
      !origin ||
      item.controlAccount.split('.')[0] !== '462' ||
      origin.treatmentId !== 'payees.recognize' ||
      !kind
    )
      return {
        effect: null,
        issues: [
          block(
            'PAYEE',
            'Poziția nu este o chirie sau un drept de proprietate intelectuală înregistrat cu payees.recognize.',
            'openItem',
          ),
        ],
      };
    if (loaded.parties.get(input.authorityId)?.kind !== 'ro_public_institution')
      issues.push(
        block(
          'AUTHORITY',
          'Partenerul trebuie să fie autoritatea fiscală (instituție publică).',
          'authorityId',
        ),
      );
    const person = loaded.parties.get(item.partyId);
    if (person?.kind !== 'ro_individual')
      issues.push(block('BENEFICIARY', notResident(person), 'openItem'));
    if (input.date < origin.date)
      issues.push(block('DATE', 'Plata nu poate preceda suma datorată.', 'date'));
    const gross = parseMoney(input.gross, LEDGER_CURRENCY);
    // A payable's balance is signed: credit, what is still owed, is negative.
    const owed = -item.balanceBani;
    if (gross === 0n || gross > owed)
      issues.push(
        block(
          'AMOUNT',
          `Suma plătită depășește suma rămasă (${formatMoney(owed, LEDGER_CURRENCY)} lei).`,
          'gross',
        ),
      );
    if (kind === 'royalties') {
      const facts = input.royalties;
      if (!facts)
        issues.push(
          block(
            'IP_FACTS',
            'Pentru drepturile de proprietate intelectuală indicați din contract: dacă plătitorul reține CAS și CASS (contributionsByContract), dacă autorul a optat pentru sistemul real (realSystem) și dacă venitul e al moștenitorilor, din dreptul de suită sau copia privată (collectiveShare).',
            'royalties',
          ),
        );
      else {
        if (facts.contributionsByContract)
          issues.push(
            block(
              'IP_CONTRIBUTIONS',
              'Contractul obligă plătitorul să rețină CAS și CASS (art. 151 alin. (6)–(7), art. 174^1 alin. (3)–(4) din Codul fiscal), declarate în D112: nu este încă suportat.',
              'royalties.contributionsByContract',
            ),
          );
        if (facts.realSystem)
          issues.push(
            block(
              'IP_REAL_SYSTEM',
              'Autorul a optat pentru sistemul real (art. 73 din Codul fiscal): dacă plătitorul mai reține impozitul este o întrebare pentru expert; nu este suportat.',
              'royalties.realSystem',
            ),
          );
        if (facts.collectiveShare)
          issues.push(
            block(
              'IP_COLLECTIVE',
              'Venitul moștenitorilor, dreptul de suită și copia privată (art. 72 alin. (3)) nu sunt încă suportate.',
              'royalties.collectiveShare',
            ),
          );
      }
    } else if (input.royalties)
      issues.push(
        block('IP_FACTS', 'Faptele contractului se dau doar pentru drepturi.', 'royalties'),
      );
    if (issues.length) return { effect: null, issues };

    let rate: string;
    let expense: string;
    try {
      rate = param<string>(rules, `ro.${kind === 'rent' ? 'rent' : 'ip'}.tax_rate`, input.date);
      expense = param<string>(
        rules,
        `ro.${kind === 'rent' ? 'rent' : 'ip'}.expense_rate`,
        input.date,
      );
    } catch (error) {
      if (!(error instanceof RuleGapError)) throw error;
      return { effect: null, issues: [block('RULE_GAP', error.message)] };
    }
    // The net income of this payment, to the ban; its tax in whole lei, half up.
    const net = gross - shareOf(gross, expense);
    const tax = taxOf(net, rate);
    const withheld: Withheld = {
      type: kind === 'rent' ? '628' : '611',
      // Intellectual property is declared in D112, not D100: D406 reports it under 000.
      taxCode: kind === 'rent' ? whtCode('628', 'domestic', rate) : null,
      regime: 'domestic',
      rate,
      base: String(net),
      gross: String(gross),
      tax: String(tax),
      annual: kind === 'rent' ? 'D205' : 'D112',
    };
    const what = kind === 'rent' ? 'chirie' : 'drepturi de proprietate intelectuală';
    const effect: Effect = {
      schema: 'effect@1',
      date: input.date,
      journalClass: 'general',
      journalCode: 'DIVERSE',
      description: `Impozit reținut pe ${what} ${person!.name}`.slice(0, 500),
      lines: [
        {
          account: item.controlAccount,
          side: 'D',
          bani: tax,
          openItem: item.id,
          partyId: item.partyId,
        },
        {
          account: '446',
          side: 'C',
          bani: tax,
          openItem: 'tax',
          partyId: input.authorityId,
          analytics: { item: withheldTag(withheld.type) },
        },
      ],
      openItems: [
        {
          ref: 'tax',
          kind: 'tax.payable',
          controlAccount: '446',
          partyId: input.authorityId,
          currency: LEDGER_CURRENCY,
          normalSide: 'C',
          mayReverse: false,
        },
      ],
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: `${kind === 'rent' ? 'Chirie' : 'Drepturi'} brute ${formatMoney(gross, LEDGER_CURRENCY)} lei, venit net ${formatMoney(net, LEDGER_CURRENCY)} lei (minus ${expense}%), impozit ${rate}% ${formatMoney(tax, LEDGER_CURRENCY)} lei, net de plată ${formatMoney(gross - tax, LEDGER_CURRENCY)} lei.`,
        details: {
          payee: kind,
          rate,
          expenseRate: expense,
          withholding: withheld as unknown as Record<string, string>,
          clauses: [...withholdingClauses[kind]],
        },
      },
    };
    return {
      effect,
      issues: [
        kind === 'rent'
          ? info(
              'RENT_CASS',
              'Contribuția de asigurări sociale de sănătate pe veniturile din chirii este a proprietarului, prin declarația unică; compania nu o reține.',
            )
          : info(
              'IP_D112',
              'Impozitul reținut pe drepturile de proprietate intelectuală se declară în D112 (art. 132 alin. (2) din Codul fiscal), nu în D100 sau D205; D112 pentru aceste venituri nu este încă scris de aplicație.',
            ),
      ],
    };
  },
};

// ─── Non-residents ─────────────────────────────────────────────────────────────────────────

/** The D100 obligation (and D406 TaxType) of each income of a non-resident. */
export const nonresidentTypes: Record<NonresidentIncome, string> = {
  dividends: '631',
  interest: '632',
  royalties: '633',
  commissions: '634',
  services: '636',
};

/** D207's tip_venit: under the Codul fiscal, under a treaty's rate, exempt by a treaty. */
const d207Types: Record<
  NonresidentIncome,
  { domestic: string; treaty: string | null; exempt: string | null }
> = {
  dividends: { domestic: '01', treaty: '22', exempt: '20' },
  interest: { domestic: '02', treaty: '23', exempt: '19' },
  royalties: { domestic: '03', treaty: '24', exempt: '21' },
  commissions: { domestic: '04', treaty: '25', exempt: '25' },
  services: { domestic: '07', treaty: null, exempt: null },
};

/** The answer of a kind about a party the basis cites: the latest, read by its kind's schema. */
function answerAbout<T>(
  loaded: Loaded,
  kindId: 'nonresident.payee' | 'nonresident.certificate',
  partyId: string,
): { record: AnswerRecord; value: T } | null {
  const kind = questionKinds[kindId];
  let found: { record: AnswerRecord; value: T } | null = null;
  for (const record of loaded.answers.values()) {
    if (record.kind !== kindId || record.subject.kind !== 'party' || record.subject.id !== partyId)
      continue;
    const parsed = (kind.answer as (params: unknown) => z.ZodType<T>)({}).safeParse(record.value);
    if (!parsed.success) continue;
    if (
      !found ||
      found.record.answeredAt < record.answeredAt ||
      (found.record.answeredAt === record.answeredAt && found.record.answerId < record.answerId)
    )
      found = { record, value: parsed.data };
  }
  return found;
}

/**
 * Whether a residence certificate speaks for a payment: presented by then, attesting the year of
 * the payment, or presented in the year before and the payment within its first days (art. 230
 * alin. (2): valid in the year presented and the first 60 days of the next).
 */
export function certificateCovers(
  certificate: Pick<NonresidentCertificateAnswer, 'presentedOn' | 'year'>,
  date: LocalDate,
  graceDays: number,
): boolean {
  if (certificate.presentedOn > date) return false;
  const presented = Number(certificate.presentedOn.slice(0, 4));
  const paid = Number(date.slice(0, 4));
  if (paid === presented) return certificate.year === paid;
  if (paid !== presented + 1 || certificate.year !== presented) return false;
  return date < addDays(`${paid}-01-01` as LocalDate, graceDays);
}

/** The accounts a non-resident's income is owed on, by income. */
const owedOn = (income: NonresidentIncome, account: string) =>
  income === 'dividends'
    ? account === '457' || account === '456'
    : income === 'interest'
      ? interestAccountCodes.includes(account)
      : ['401', '404', '462'].includes(account);

export const nonresidentWithholdingInput = z
  .object({
    /** What is owed to the non-resident: the supplier's invoice (401, 404, 462) for royalties,
     * commissions and services, the interest owed (1685–1687, 4558, 1682, 5198), the dividend
     * (457, 456 for interim dividends). */
    openItem: z.uuid(),
    /** For dividends: the posted distribution, whose date selects the domestic rate. */
    distributionEntryId: z.uuid().optional(),
    /** The day it is paid. */
    date: localDate,
    /** The gross income paid now, in lei. */
    gross: amount,
    authorityId: z.uuid(),
    /** Paid into an account in a state with which Romania has no instrument for the exchange of
     * information (art. 224 alin. (4) lit. c)). */
    noExchangeOfInformation: z.boolean(),
    /** Who bears the tax: withheld from the payment, or borne by the payer on top of it (the
     * gross-up, art. 231 alin. (1^1)). */
    borneBy: z.enum(['beneficiary', 'payer']),
  })
  .strict();
export type NonresidentWithholdingInput = z.infer<typeof nonresidentWithholdingInput>;

/**
 * The tax on a non-resident's income from Romania, withheld when it is paid (Codul fiscal art.
 * 224 alin. (1), (5)): on the gross, at the domestic rate (16%, 10% for an individual resident in
 * an EU or a treaty state), or the treaty's when lower (art. 230 alin. (1)) and the residence
 * certificate, presented at payment and still valid, speaks for it (alin. (2)). The income and
 * the beneficiary are a person's determination about the party (`nonresident.payee`), the
 * certificate and the treaty's article another (`nonresident.certificate`): neither is guessed.
 * Dr the amount owed / Cr 446, in whole lei; a treaty's exemption books nothing and is declared
 * in D207 as exempt. Not covered: the tax borne by the payer, the 50% rate, an EU directive's
 * exemption, currency items, services under a treaty's rate.
 */
export const nonresidentWithholding: Treatment<NonresidentWithholdingInput> = {
  id: 'nonresidents.withhold',
  version: 1,
  description:
    'Impozitul reținut la sursă la plata veniturilor obținute din România de nerezidenți.',
  input: nonresidentWithholdingInput,
  agent: true,
  summary:
    "Tax withheld when a non-resident is paid dividends, interest, royalties (a software licence may be one), commissions or services taxed in Romania: the domestic rate, or a treaty's with a valid certificate.",
  toolset: 'tax',
  dataClasses: ['books', 'tax'],
  subject: (input) => `nonresident-tax:${input.openItem}:${input.date}`,
  plan: (input) => ({
    openItems: [{ ids: [input.openItem] }],
    parties: [input.authorityId],
    ...(input.distributionEntryId ? { entries: [input.distributionEntryId] } : {}),
  }),
  followUp(input, loaded) {
    const item = loaded.openItems.get(input.openItem);
    return item ? { parties: [item.partyId] } : null;
  },
  evaluate(input, loaded, rules) {
    const issues: Issue[] = [];
    const item = loaded.openItems.get(input.openItem) as OpenItemState | undefined;
    if (!item || item.normalSide !== 'C')
      return {
        effect: null,
        issues: [block('OPEN_ITEM', 'Poziția nu este o sumă datorată unui partener.', 'openItem')],
      };
    const party = loaded.parties.get(item.partyId);
    if (party?.kind !== 'eu_taxable' && party?.kind !== 'non_eu')
      return {
        effect: null,
        issues: [
          block(
            'RESIDENT',
            'Beneficiarul este rezident în România: impozitul pe dividende, dobânzi, chirii sau drepturi se reține cu dividends.withhold, loans.withhold sau payees.withhold.',
            'openItem',
          ),
        ],
      };
    if (loaded.parties.get(input.authorityId)?.kind !== 'ro_public_institution')
      issues.push(
        block(
          'AUTHORITY',
          'Partenerul trebuie să fie autoritatea fiscală (instituție publică).',
          'authorityId',
        ),
      );
    // What is paid and to whom: the person's determination about this party.
    const payee = answerAbout<NonresidentPayeeAnswer>(loaded, 'nonresident.payee', party.id);
    if (!payee)
      return {
        effect: null,
        issues: [
          ...issues,
          questionIssue(
            'NONRESIDENT_PAYEE',
            `Ce plătește compania lui ${party.name} (dividende, dobânzi, redevențe, comisioane, servicii impozabile în România sau venit neimpozabil în România) și cine este beneficiarul nu rezultă din registre: o licență de software este redevență doar când dă mai mult decât dreptul de a folosi programul (art. 7 pct. 36 din Codul fiscal). Întrebați (nonresident.payee), cu contractul, și revizuiți propunerea citând răspunsul.`,
            {
              kind: 'nonresident.payee',
              subject: { kind: 'party', id: party.id },
              params: item.documentId ? { documentId: item.documentId } : {},
            },
          ),
        ],
      };
    const { income: answered, beneficiary: form } = payee.value;
    if (answered === 'not_taxable')
      return {
        effect: null,
        issues: [
          block(
            'NOT_TAXABLE',
            `După răspunsul despre ${party.name}, venitul nu este impozabil în România (art. 223 alin. (1)): nu se reține impozit și nu se declară în D100 sau D207.`,
          ),
        ],
      };
    const income: NonresidentIncome = answered;
    const account = item.controlAccount.split('.')[0]!;
    if (!owedOn(income, account))
      issues.push(
        block(
          'INCOME_ACCOUNT',
          `Poziția de pe contul ${account} nu corespunde venitului stabilit pentru ${party.name} (${income}).`,
          'openItem',
        ),
      );
    if (item.currency !== LEDGER_CURRENCY)
      issues.push(
        block(
          'WHT_CURRENCY',
          'Reținerea la sursă pe o sumă datorată în valută (impozitul în lei, la cursul BNR din ziua plății, art. 224 alin. (5)) nu este încă suportată.',
          'openItem',
        ),
      );
    if (input.borneBy === 'payer')
      issues.push(
        block(
          'WHT_BORNE_BY_PAYER',
          'Impozitul suportat de plătitor (metoda sutei mărite, nedeductibil după art. 25 alin. (4) lit. a)) nu este încă suportat.',
          'borneBy',
        ),
      );
    if (input.noExchangeOfInformation)
      issues.push(
        block(
          'WHT_50',
          'Cota de 50% pentru plățile într-un stat fără instrument de schimb de informații, după tranzacții artificiale (art. 224 alin. (4) lit. c)), nu este suportată.',
          'noExchangeOfInformation',
        ),
      );
    let distributed: LocalDate | null = null;
    if (income === 'dividends') {
      const entry = input.distributionEntryId
        ? loaded.entries.get(input.distributionEntryId)
        : undefined;
      if (!entry || !entry.lines.some((line) => line.openItem === item.id))
        issues.push(
          block(
            'DISTRIBUTION',
            'Dividendul nu provine din repartizarea indicată (distributionEntryId).',
            'distributionEntryId',
          ),
        );
      else {
        distributed = entry.date;
        if (input.date < entry.date)
          issues.push(
            block('DATE', 'Dividendul se plătește după hotărârea de repartizare.', 'date'),
          );
      }
    } else if (input.distributionEntryId)
      issues.push(
        block(
          'DISTRIBUTION',
          'Repartizarea se indică doar pentru dividende.',
          'distributionEntryId',
        ),
      );
    const gross = parseMoney(input.gross, LEDGER_CURRENCY);
    const owed = -item.balanceBani;
    if (gross === 0n || gross > owed)
      issues.push(
        block(
          'AMOUNT',
          `Suma plătită depășește suma rămasă (${formatMoney(owed, LEDGER_CURRENCY)} lei).`,
          'gross',
        ),
      );
    if (issues.length) return { effect: null, issues };

    // The certificate and the treaty's rate, when presented and valid for this payment.
    let graceDays: number;
    try {
      graceDays = param<number>(rules, 'ro.nonresident.certificate_days', input.date);
    } catch (error) {
      if (!(error instanceof RuleGapError)) throw error;
      return { effect: null, issues: [block('RULE_GAP', error.message)] };
    }
    const after: Issue[] = [];
    const found = answerAbout<NonresidentCertificateAnswer>(
      loaded,
      'nonresident.certificate',
      party.id,
    );
    const certificate =
      found &&
      found.value.income === income &&
      certificateCovers(found.value, input.date, graceDays)
        ? found
        : null;
    if (certificate && certificate.value.state !== party.country)
      return {
        effect: null,
        issues: [
          block(
            'WHT_CERTIFICATE_STATE',
            `Certificatul de rezidență atestă ${certificate.value.state}, iar partenerul ${party.name} este din ${party.country}.`,
          ),
        ],
      };
    const beneficiary: NonresidentBeneficiary =
      form === 'company' ? 'company' : certificate ? 'individual_treaty' : 'individual_other';
    let domestic: string;
    try {
      domestic =
        income === 'dividends'
          ? rules.param<string>(
              'ro.dividend.tax_rate',
              'distribution_decision_date',
              distributed!,
              {
                beneficiary: 'nonresident',
              },
            )
          : param<string>(rules, 'ro.nonresident.tax_rate', input.date, { income, beneficiary });
    } catch (error) {
      if (!(error instanceof RuleGapError)) throw error;
      return { effect: null, issues: [block('RULE_GAP', error.message)] };
    }
    const treaty = certificate?.value.rate;
    const byTreaty = treaty !== undefined && parseScaled(treaty, 4) < parseScaled(domestic, 4);
    if (!certificate)
      after.push(
        questionIssue(
          'WHT_CERTIFICATE',
          found
            ? `Certificatul de rezidență al lui ${party.name} (prezentat la ${found.value.presentedOn}, pentru ${found.value.year}, venitul ${found.value.income}) nu acoperă plata din ${input.date} (art. 230 alin. (2) din Codul fiscal): se aplică cota din Codul fiscal, ${domestic}%. Cereți certificatul valabil.`
            : `${party.name} nu a prezentat certificatul de rezidență fiscală: se aplică cota din Codul fiscal, ${domestic}% (art. 230 alin. (2)); cu certificatul și articolul convenției, cota convenției, dacă e mai mică. Cereți certificatul (nonresident.certificate).`,
          {
            kind: 'nonresident.certificate',
            subject: { kind: 'party', id: party.id },
            params: { income, date: input.date },
          },
          'ack',
        ),
      );
    else if (!byTreaty)
      after.push(
        info(
          'WHT_TREATY_HIGHER',
          `Cota convenției (${treaty}%) nu este mai mică decât cea din Codul fiscal (${domestic}%): se aplică cea din Codul fiscal (art. 230 alin. (1)).`,
        ),
      );
    if (byTreaty && income === 'services')
      return {
        effect: null,
        issues: [
          block(
            'WHT_TREATY_SERVICES',
            'Serviciile impozitate după cota unei convenții (sau scutite de ea) nu au un cod în D207: nu este încă suportat.',
          ),
        ],
      };
    // An EU company may be exempt under the directives, which the engine does not check.
    if (form === 'company' && party.kind === 'eu_taxable' && income !== 'commissions')
      after.push(
        ack(
          income === 'dividends' ? 'WHT_DIRECTIVE_DIVIDENDS' : 'WHT_DIRECTIVE_INTEREST',
          income === 'dividends'
            ? 'Confirmați că beneficiarul nu îndeplinește condițiile scutirii din art. 229 alin. (1) lit. c) (Directiva 2011/96/UE: cel puțin 10% de cel puțin un an), pe care aplicația nu o aplică.'
            : 'Confirmați că plata nu intră sub scutirea dobânzilor și redevențelor între societăți asociate din UE (art. 229 alin. (1) lit. g), cap. V), pe care aplicația nu o aplică.',
        ),
      );
    const rate = byTreaty ? treaty! : domestic;
    const tax = taxOf(gross, rate);
    const regime = byTreaty ? 'treaty' : 'domestic';
    const type = nonresidentTypes[income];
    const individual = form === 'individual';
    const codes = d207Types[income];
    const taxCode = whtCode(type, regime, rate, individual && regime === 'domestic');
    const withheld: Withheld & { d207: Record<string, string> } = {
      type,
      taxCode,
      regime,
      rate,
      base: String(gross),
      gross: String(gross),
      tax: String(tax),
      annual: 'D207',
      d207: {
        incomeType:
          regime === 'domestic' ? codes.domestic : tax === 0n ? codes.exempt! : codes.treaty!,
        act: regime === 'domestic' ? '1' : '2',
        state: certificate?.value.state ?? party.country,
        ...(party.taxId ? { foreignId: party.taxId } : {}),
      },
    };
    const base = {
      schema: 'effect@1' as const,
      date: input.date,
      journalCode: 'DIVERSE',
      description: `Impozit pe veniturile nerezidenților reținut ${party.name}`.slice(0, 500),
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: `Venit brut ${formatMoney(gross, LEDGER_CURRENCY)} lei (${income}), impozit ${rate}% ${formatMoney(tax, LEDGER_CURRENCY)} lei${byTreaty ? `, după convenție (${certificate!.value.article})` : ', după Codul fiscal'}, net de plată ${formatMoney(gross - tax, LEDGER_CURRENCY)} lei.`,
        details: {
          income,
          beneficiary,
          rate,
          domestic,
          ...(byTreaty ? { treaty: { rate: treaty!, article: certificate!.value.article } } : {}),
          withholding: withheld as unknown as Record<string, string>,
          answers: [
            { questionId: payee.record.questionId, answerId: payee.record.answerId },
            ...(certificate
              ? [
                  {
                    questionId: certificate.record.questionId,
                    answerId: certificate.record.answerId,
                  },
                ]
              : []),
          ],
          clauses: [...withholdingClauses.nonresident],
        },
      },
    };
    // A treaty's exemption withholds nothing: the posting records the payment for D207.
    const effect: Effect =
      tax === 0n
        ? { ...base, journalClass: 'memo', lines: [], openItems: [] }
        : {
            ...base,
            journalClass: 'general',
            lines: [
              {
                account: item.controlAccount,
                side: 'D',
                bani: tax,
                openItem: item.id,
                partyId: item.partyId,
              },
              {
                account: '446',
                side: 'C',
                bani: tax,
                openItem: 'tax',
                partyId: input.authorityId,
                analytics: { item: withheldTag(type) },
              },
            ],
            openItems: [
              {
                ref: 'tax',
                kind: 'tax.payable',
                controlAccount: '446',
                partyId: input.authorityId,
                currency: LEDGER_CURRENCY,
                normalSide: 'C',
                mayReverse: false,
              },
            ],
          };
    if (taxCode === null && tax > 0n)
      after.push(
        ack(
          'WHT_CODE',
          `Nomenclatorul WHT al ANAF nu are un cod pentru ${type} la ${rate}%: D406 nu poate raporta reținerea până nu are unul.`,
        ),
      );
    return { effect, issues: after };
  },
};
