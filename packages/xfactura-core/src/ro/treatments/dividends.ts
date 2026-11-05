import { z } from 'zod';
import {
  turnoverKey,
  type Effect,
  type Issue,
  type LineSpec,
  type OpenItemSpec,
  type Treatment,
  type TurnoverQuery,
} from '../../kernel';
import { divRound, formatMoney, parseMoney, parseScaled } from '../../money';
import { RuleGapError } from '../../rules';
import { isLocalDate, type LocalDate } from '../../time';
import { whtCode, type Withheld } from '../withholding/codes';
import { taxDue } from './due';

const block = (code: string, message: string, path?: string): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
});
const amount = z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/);
const localDate = z.string().refine((value): boolean => isLocalDate(value));

export const distributionInput = z
  .object({
    /** The date of the shareholders' decision. */
    date: localDate,
    /** The shareholders' decision approving the distribution. */
    evidenceId: z.uuid(),
    shareholders: z
      .array(z.object({ partyId: z.uuid(), amount }).strict())
      .min(1)
      .max(50),
  })
  .strict();
export type DistributionInput = z.infer<typeof distributionInput>;

const undistributed = (date: LocalDate): TurnoverQuery => ({
  prefixes: ['1171'],
  from: '1900-01-01' as LocalDate,
  to: date,
});

/**
 * Dividends the shareholders decided to distribute from the retained profit (1171): each
 * shareholder's gross dividend becomes owed to them (457). The distribution may not exceed the
 * profit retained on the decision date. Interim dividends are not supported yet.
 */
export const dividendDistribution: Treatment<DistributionInput> = {
  id: 'dividends.distribute',
  version: 1,
  description: 'Repartizarea dividendelor din profitul reportat, prin hotărârea asociaților.',
  input: distributionInput,
  agent: true,
  summary: "Distribution of dividends from retained earnings under the shareholders' resolution.",
  subject: (input) => `dividends:${input.evidenceId}`,
  plan: (input) => ({
    evidence: [input.evidenceId],
    parties: input.shareholders.map((item) => item.partyId),
    turnover: [undistributed(input.date as LocalDate)],
  }),
  evaluate(input, loaded) {
    const issues: Issue[] = [];
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(block('EVIDENCE', 'Hotărârea asociaților nu este disponibilă.', 'evidenceId'));
    const seen = new Set<string>();
    input.shareholders.forEach((item, index) => {
      if (!loaded.parties.has(item.partyId))
        issues.push(block('PARTY', 'Asociatul nu există.', `shareholders.${index}.partyId`));
      if (seen.has(item.partyId))
        issues.push(
          block('PARTY', 'Asociatul apare de două ori.', `shareholders.${index}.partyId`),
        );
      if (parseMoney(item.amount, 'RON') === 0n)
        issues.push(block('AMOUNT', 'Dividendul este zero.', `shareholders.${index}.amount`));
      seen.add(item.partyId);
    });
    const total = input.shareholders.reduce(
      (sum, item) => sum + parseMoney(item.amount, 'RON'),
      0n,
    );
    const retained = (
      loaded.turnover.get(turnoverKey(undistributed(input.date as LocalDate))) ?? []
    ).reduce((sum, row) => sum + row.credit - row.debit, 0n);
    if (total > retained)
      issues.push(
        block(
          'DISTRIBUTABLE',
          `Dividendele (${formatMoney(total, 'RON')} lei) depășesc profitul reportat nerepartizat la ${input.date} (${formatMoney(retained, 'RON')} lei).`,
        ),
      );
    if (issues.length) return { effect: null, issues };

    const openItems: OpenItemSpec[] = [];
    const lines: LineSpec[] = [{ account: '1171', side: 'D', bani: total }];
    input.shareholders.forEach((item, index) => {
      const ref = `shareholder:${index}`;
      openItems.push({
        ref,
        kind: 'payable',
        controlAccount: '457',
        partyId: item.partyId,
        currency: 'RON',
        normalSide: 'C',
        mayReverse: false,
      });
      lines.push({
        account: '457',
        side: 'C',
        bani: parseMoney(item.amount, 'RON'),
        openItem: ref,
        partyId: item.partyId,
      });
    });
    const effect: Effect = {
      schema: 'effect@1',
      date: input.date as LocalDate,
      journalClass: 'general',
      journalCode: 'DIVIDENDE',
      description: `Dividende repartizate prin hotărârea din ${input.date}`,
      lines,
      openItems,
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: `${input.shareholders.length} asociați, dividende brute ${formatMoney(total, 'RON')} lei, din profitul reportat de ${formatMoney(retained, 'RON')} lei.`,
        details: { decision: input.date },
      },
    };
    return { effect, issues };
  },
};

export const withholdingInput = z
  .object({
    /** The posted distribution, whose date selects the tax rate. */
    distributionEntryId: z.uuid(),
    /** The shareholder's dividend owed (457). */
    openItem: z.uuid(),
    /** The payment date; or the year's last day for dividends distributed and still unpaid. */
    date: localDate,
    /** The gross dividend paid now. */
    gross: amount,
    authorityId: z.uuid(),
    /** The tax on dividends distributed and still unpaid at the end of the distribution's year,
     * withheld on its last day (art. 43 alin. (3), art. 97 alin. (7)); nothing is paid. */
    unpaidAtYearEnd: z.boolean().default(false),
  })
  .strict();
export type WithholdingInput = z.infer<typeof withholdingInput>;

/**
 * The dividend tax withheld when a shareholder's dividend is paid (Codul fiscal art. 43 for
 * Romanian companies, art. 97 alin. (7) for individuals): Dr 457 / Cr 446, owed to the tax
 * authority. The net is then paid through the bank against the same 457 item. A company
 * exempt under art. 43 alin. (4) is paid gross, with nothing to withhold; non-residents are not
 * supported yet.
 */
export const dividendWithholding: Treatment<WithholdingInput> = {
  id: 'dividends.withhold',
  version: 1,
  description: 'Impozitul pe dividende reținut la plata dividendelor.',
  input: withholdingInput,
  agent: true,
  summary: 'Dividend tax withheld when dividends are paid.',
  toolset: 'tax',
  dataClasses: ['books', 'tax'],
  subject: (input) => `dividend-tax:${input.openItem}:${input.date}`,
  plan: (input) => ({
    entries: [input.distributionEntryId],
    openItems: [{ ids: [input.openItem] }],
    parties: [input.authorityId],
  }),
  followUp(input, loaded) {
    const item = loaded.openItems.get(input.openItem);
    return item ? { parties: [item.partyId] } : null;
  },
  evaluate(input, loaded, rules) {
    const issues: Issue[] = [];
    const entry = loaded.entries.get(input.distributionEntryId);
    const item = loaded.openItems.get(input.openItem);
    // A dividend distributed from the year's retained profit (457), or during the year from the
    // interim statements (456, `dividends.interim`).
    if (
      !entry ||
      !item ||
      (item.controlAccount !== '457' && item.controlAccount !== '456') ||
      !entry.lines.some((line) => line.account === item.controlAccount && line.openItem === item.id)
    )
      return {
        effect: null,
        issues: [
          block('DISTRIBUTION', 'Dividendul nu provine din repartizarea indicată.', 'openItem'),
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
    if (input.date < entry.date)
      issues.push(block('DATE', 'Dividendul se plătește după hotărârea de repartizare.', 'date'));
    if (input.unpaidAtYearEnd && input.date !== `${entry.date.slice(0, 4)}-12-31`)
      issues.push(
        block(
          'DATE',
          'Impozitul pe dividendele neplătite se reține în ultima zi a anului repartizării.',
          'date',
        ),
      );
    const gross = parseMoney(input.gross, 'RON');
    // A payable's balance is signed: credit, the dividend still owed, is negative.
    const owed = -item.balanceBani;
    if (gross === 0n || gross > owed)
      issues.push(
        block(
          'AMOUNT',
          `Dividendul plătit depășește suma rămasă (${formatMoney(owed, 'RON')} lei).`,
          'gross',
        ),
      );
    const shareholder = loaded.parties.get(item.partyId);
    const beneficiary =
      shareholder?.kind === 'ro_individual'
        ? 'individual'
        : shareholder?.kind === 'ro_legal_entity'
          ? 'company'
          : null;
    if (!beneficiary)
      issues.push(
        block(
          'NON_RESIDENT',
          shareholder?.kind === 'eu_taxable' || shareholder?.kind === 'non_eu'
            ? 'Impozitul pe dividendele plătite nerezidenților se reține cu nonresidents.withhold (art. 223–224 din Codul fiscal).'
            : 'Asociatul nu este o persoană fizică sau o persoană juridică română.',
        ),
      );
    if (issues.length) return { effect: null, issues };

    let rate: string;
    try {
      rate = rules.param<string>('ro.dividend.tax_rate', 'distribution_decision_date', entry.date, {
        beneficiary: beneficiary!,
      });
    } catch (error) {
      if (!(error instanceof RuleGapError)) throw error;
      return { effect: null, issues: [block('RULE_GAP', error.message)] };
    }
    // Whole lei, half up.
    const tax = divRound(gross * parseScaled(rate, 4), 100_000_000n, 'halfAwayFromZero') * 100n;
    const issuesAfter: Issue[] =
      beneficiary === 'company'
        ? [
            {
              code: 'DIVIDEND_EXEMPTION',
              severity: 'ack',
              message:
                'Confirmați că beneficiarul nu îndeplinește condițiile de scutire de la art. 43 alin. (4) (cel puțin 10% de cel puțin un an, ambele plătitoare de impozit pe profit).',
            },
          ]
        : [];
    const effect: Effect = {
      schema: 'effect@1',
      date: input.date as LocalDate,
      journalClass: 'general',
      journalCode: 'DIVIDENDE',
      description: `Impozit pe dividende reținut ${shareholder!.name}`,
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
          openItem: 'dividend-tax',
          partyId: input.authorityId,
        },
      ],
      openItems: [
        {
          ref: 'dividend-tax',
          kind: 'tax.payable',
          controlAccount: '446',
          partyId: input.authorityId,
          currency: 'RON',
          normalSide: 'C',
          mayReverse: false,
          // Due by the 25th of the month after it was withheld, with its D100 (art. 43 alin. (2),
          // art. 97 alin. (7)).
          ...taxDue('D100.dividends', input.date.slice(0, 7), input.date.slice(0, 7), rules),
        },
      ],
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: `Dividend brut ${formatMoney(gross, 'RON')} lei, impozit ${rate}% ${formatMoney(tax, 'RON')} lei, net de plată ${formatMoney(gross - tax, 'RON')} lei.`,
        details: {
          beneficiary: beneficiary!,
          rate,
          distribution: entry.date,
          ...(item.controlAccount === '456' ? { interim: true } : {}),
          withholding: withheldDividend(beneficiary!, rate, gross, tax) as unknown as Record<
            string,
            string
          >,
        },
      },
    };
    return { effect, issues: issuesAfter };
  },
};

/** What a dividend withholding declares: 604 for an individual, 150 for a Romanian company. */
function withheldDividend(
  beneficiary: 'individual' | 'company',
  rate: string,
  gross: bigint,
  tax: bigint,
): Withheld {
  const type = beneficiary === 'individual' ? '604' : '150';
  return {
    type,
    taxCode: whtCode(type, 'domestic', rate),
    regime: 'domestic',
    rate,
    base: String(gross),
    gross: String(gross),
    tax: String(tax),
    annual: 'D205',
  };
}

// ─── Interim dividends (Legea nr. 82/1991 art. 19 alin. (3)–(3^2), OMFP nr. 3.067/2018) ──────

const quarterEnds = ['-03-31', '-06-30', '-09-30'];
const INTERIM = [
  'L82/1991:art.19(3)-(3^2)',
  'L163/2018:art.II.pct.1-2',
  'OMFP3067/2018:pct.423^1-423^2',
  'OMFP3067/2018:art.III-V',
];

export const interimInput = z
  .object({
    /** The date of the shareholders' decision approving the interim statements and the
     * distribution. */
    date: localDate,
    /** The shareholders' decision. */
    evidenceId: z.uuid(),
    /** The interim financial statements it approves (balance sheet and profit and loss account
     * from the year's start, OMFP nr. 1.802/2014 pct. 602). */
    statementsEvidenceId: z.uuid(),
    /** The last day of the quarter the interim statements end with (Q1–Q3). */
    quarterEnd: localDate,
    /** Reserves the law or the articles require, set aside from the profit (deducted). */
    reserves: amount,
    /** Available reserves (1068) withdrawn for the distribution (added). */
    fromReserves: amount,
    shareholders: z
      .array(z.object({ partyId: z.uuid(), amount }).strict())
      .min(1)
      .max(50),
  })
  .strict();
export type InterimInput = z.infer<typeof interimInput>;

const yearStart = (date: string) => `${date.slice(0, 4)}-01-01` as LocalDate;
const interimQueries = (input: InterimInput) => ({
  // The year's result to the quarter's end: revenues less expenses, the profit tax included.
  result: {
    prefixes: ['6', '7'],
    from: yearStart(input.quarterEnd),
    to: input.quarterEnd as LocalDate,
  } satisfies TurnoverQuery,
  retained: undistributed(input.date as LocalDate),
  reserves: {
    prefixes: ['1068'],
    from: '1900-01-01' as LocalDate,
    to: input.date as LocalDate,
  } satisfies TurnoverQuery,
  // What the year's earlier interim decisions distributed (463's debits).
  earlier: {
    prefixes: ['463'],
    from: yearStart(input.date),
    to: input.date as LocalDate,
  } satisfies TurnoverQuery,
});

/**
 * Dividends the shareholders distribute during the year from the interim statements they approve
 * (Legea nr. 82/1991 art. 19 alin. (3^1), Legea nr. 31/1990 art. 67 alin. (2)): Dr 463 / Cr 456
 * per shareholder (OMFP nr. 3.067/2018, pct. 423^1), within the year's net profit to the quarter's
 * end, plus the retained profit (1171) and the available reserves withdrawn, less the reserves
 * the law or the articles require and what the year's earlier interim decisions distributed. The
 * tax is withheld when paid (`dividends.withhold` on the 456 item); they are regularized against
 * the annual dividends once the year's statements are approved (`dividends.regularize`).
 */
export const interimDistribution: Treatment<InterimInput> = {
  id: 'dividends.interim',
  version: 1,
  description:
    'Repartizarea de dividende în cursul exercițiului, pe baza situațiilor financiare interimare.',
  input: interimInput,
  agent: true,
  summary:
    'Interim dividends distributed during the year from the approved interim financial statements (463 = 456 per shareholder).',
  subject: (input) => `dividends-interim:${input.evidenceId}`,
  plan: (input) => {
    const queries = interimQueries(input);
    return {
      evidence: [input.evidenceId, input.statementsEvidenceId],
      parties: input.shareholders.map((item) => item.partyId),
      turnover: [queries.result, queries.retained, queries.reserves, queries.earlier],
    };
  },
  evaluate(input, loaded) {
    const issues: Issue[] = [];
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(block('EVIDENCE', 'Hotărârea asociaților nu este disponibilă.', 'evidenceId'));
    if (!loaded.evidence.has(input.statementsEvidenceId))
      issues.push(
        block(
          'EVIDENCE',
          'Situațiile financiare interimare nu sunt disponibile.',
          'statementsEvidenceId',
        ),
      );
    const year = input.quarterEnd.slice(0, 4);
    if (!quarterEnds.some((end) => input.quarterEnd === `${year}${end}`))
      issues.push(
        block(
          'QUARTER',
          'Situațiile interimare se încheie la sfârșitul trimestrului I, II sau III; al IV-lea este al situațiilor anuale.',
          'quarterEnd',
        ),
      );
    if (input.date <= input.quarterEnd || input.date.slice(0, 4) !== year)
      issues.push(
        block(
          'DATE',
          'Hotărârea se ia după sfârșitul trimestrului, în cursul aceluiași exercițiu financiar.',
          'date',
        ),
      );
    if (
      loaded.years.some(
        (item) =>
          item.kind === 'financial' &&
          item.from <= input.quarterEnd &&
          input.quarterEnd <= item.to &&
          item.from !== `${year}-01-01`,
      )
    )
      issues.push(
        block(
          'FINANCIAL_YEAR',
          'Un exercițiu financiar care nu începe la 1 ianuarie nu este încă suportat pentru dividendele interimare.',
        ),
      );
    const seen = new Set<string>();
    input.shareholders.forEach((item, index) => {
      if (!loaded.parties.has(item.partyId))
        issues.push(block('PARTY', 'Asociatul nu există.', `shareholders.${index}.partyId`));
      if (seen.has(item.partyId))
        issues.push(
          block('PARTY', 'Asociatul apare de două ori.', `shareholders.${index}.partyId`),
        );
      if (parseMoney(item.amount, 'RON') === 0n)
        issues.push(block('AMOUNT', 'Dividendul este zero.', `shareholders.${index}.amount`));
      seen.add(item.partyId);
    });
    const queries = interimQueries(input);
    const rows = (query: TurnoverQuery) => loaded.turnover.get(turnoverKey(query)) ?? [];
    // Revenues (credit) less expenses (debit) to the quarter's end.
    const profit = rows(queries.result).reduce((sum, row) => sum + row.credit - row.debit, 0n);
    const retained = rows(queries.retained).reduce((sum, row) => sum + row.credit - row.debit, 0n);
    const available = rows(queries.reserves).reduce((sum, row) => sum + row.credit - row.debit, 0n);
    const earlier = rows(queries.earlier).reduce((sum, row) => sum + row.debit, 0n);
    const withdrawn = parseMoney(input.fromReserves, 'RON');
    const reserves = parseMoney(input.reserves, 'RON');
    if (withdrawn > available)
      issues.push(
        block(
          'RESERVES',
          `Rezervele retrase (${formatMoney(withdrawn, 'RON')} lei) depășesc rezervele disponibile în 1068 (${formatMoney(available, 'RON')} lei).`,
          'fromReserves',
        ),
      );
    const limit = profit + retained + withdrawn - reserves - earlier;
    const total = input.shareholders.reduce(
      (sum, item) => sum + parseMoney(item.amount, 'RON'),
      0n,
    );
    if (total > limit)
      issues.push(
        block(
          'DISTRIBUTABLE',
          `Dividendele interimare (${formatMoney(total, 'RON')} lei) depășesc suma distribuibilă (${formatMoney(limit, 'RON')} lei): profitul net la ${input.quarterEnd} ${formatMoney(profit, 'RON')}, profitul reportat ${formatMoney(retained, 'RON')}, rezervele retrase ${formatMoney(withdrawn, 'RON')}, minus rezervele constituite ${formatMoney(reserves, 'RON')} și dividendele interimare anterioare ale anului ${formatMoney(earlier, 'RON')} (Legea nr. 82/1991 art. 19 alin. (3^1)).`,
        ),
      );
    if (issues.length) return { effect: null, issues };

    const openItems: OpenItemSpec[] = [];
    const lines: LineSpec[] = [];
    input.shareholders.forEach((item, index) => {
      const bani = parseMoney(item.amount, 'RON');
      openItems.push(
        {
          ref: `claim:${index}`,
          kind: 'receivable',
          controlAccount: '463',
          partyId: item.partyId,
          currency: 'RON',
          normalSide: 'D',
          mayReverse: false,
        },
        {
          ref: `owed:${index}`,
          kind: 'payable',
          controlAccount: '456',
          partyId: item.partyId,
          currency: 'RON',
          normalSide: 'C',
          mayReverse: false,
        },
      );
      lines.push(
        { account: '463', side: 'D', bani, openItem: `claim:${index}`, partyId: item.partyId },
        { account: '456', side: 'C', bani, openItem: `owed:${index}`, partyId: item.partyId },
      );
    });
    const effect: Effect = {
      schema: 'effect@1',
      date: input.date as LocalDate,
      journalClass: 'general',
      journalCode: 'DIVIDENDE',
      description: `Dividende interimare repartizate prin hotărârea din ${input.date}`,
      lines,
      openItems,
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: `${input.shareholders.length} asociați, dividende interimare ${formatMoney(total, 'RON')} lei din suma distribuibilă de ${formatMoney(limit, 'RON')} lei la ${input.quarterEnd}.`,
        details: {
          decision: input.date,
          quarterEnd: input.quarterEnd,
          profit: formatMoney(profit, 'RON'),
          retained: formatMoney(retained, 'RON'),
          limit: formatMoney(limit, 'RON'),
          clauses: INTERIM,
        },
      },
    };
    return {
      effect,
      issues: [
        {
          code: 'INTERIM_STATEMENTS',
          severity: 'ack',
          message:
            'Situațiile financiare interimare se depun la Ministerul Finanțelor în 30 de zile de la aprobare (OMFP nr. 3.067/2018 art. V) și se auditează când cele anuale se auditează (Legea nr. 82/1991 art. 34^1): aplicația nu le întocmește și nu le urmărește în calendar. Confirmați că sunt întocmite și aprobate.',
        },
      ],
    };
  },
};

export const regularizationInput = z
  .object({
    /** The posted annual distribution (`dividends.distribute`) of the year's profit. */
    distributionEntryId: z.uuid(),
    /** The interim distributions (`dividends.interim`) of the financial year it closes. */
    interimEntryIds: z.array(z.uuid()).min(1).max(3),
    /** The day of the regularization: on or after the annual distribution. */
    date: localDate,
  })
  .strict();
export type RegularizationInput = z.infer<typeof regularizationInput>;

/**
 * The interim dividends regularized against the annual dividends once the year's statements are
 * approved (Legea nr. 82/1991 art. 19 alin. (3^2), OMFP nr. 3.067/2018 pct. 423^2): per
 * shareholder, Dr 457 / Cr 463 for the interim dividends of the year, within the annual dividend
 * (its 457 item). The annual dividend left over is paid with its tax as usual. Interim dividends
 * above the annual dividend, which the shareholder returns within 60 days, are not covered: their
 * restitution and the tax withheld on them are refused.
 */
export const interimRegularization: Treatment<RegularizationInput> = {
  id: 'dividends.regularize',
  version: 1,
  description:
    'Regularizarea dividendelor interimare pe seama dividendelor anuale, după aprobarea situațiilor financiare anuale.',
  input: regularizationInput,
  agent: true,
  summary:
    'Interim dividends regularized against the annual dividends after the annual statements are approved (457 = 463 per shareholder).',
  subject: (input) => `dividends-regularize:${input.distributionEntryId}`,
  plan: (input) => ({ entries: [input.distributionEntryId, ...input.interimEntryIds] }),
  followUp(input, loaded) {
    const ids = [input.distributionEntryId, ...input.interimEntryIds].flatMap(
      (id) =>
        loaded.entries
          .get(id)
          ?.lines.flatMap((line) =>
            (line.account === '457' || line.account === '463') && line.openItem
              ? [line.openItem]
              : [],
          ) ?? [],
    );
    return ids.length ? { openItems: [{ ids: [...new Set(ids)] }] } : null;
  },
  evaluate(input, loaded) {
    const annual = loaded.entries.get(input.distributionEntryId);
    const interims = input.interimEntryIds.map((id) => loaded.entries.get(id));
    if (!annual || !annual.lines.some((line) => line.account === '1171' && line.side === 'D'))
      return {
        effect: null,
        issues: [
          block(
            'DISTRIBUTION',
            'Repartizarea anuală indicată nu este o repartizare de dividende din profitul reportat.',
            'distributionEntryId',
          ),
        ],
      };
    const issues: Issue[] = [];
    if (new Set(input.interimEntryIds).size !== input.interimEntryIds.length)
      issues.push(
        block('INTERIM', 'O repartizare interimară apare de două ori.', 'interimEntryIds'),
      );
    interims.forEach((entry, index) => {
      if (!entry || !entry.lines.some((line) => line.account === '463'))
        issues.push(
          block(
            'INTERIM',
            'Repartizarea indicată nu este una de dividende interimare.',
            `interimEntryIds.${index}`,
          ),
        );
      else if (Number(entry.date.slice(0, 4)) !== Number(annual.date.slice(0, 4)) - 1)
        issues.push(
          block(
            'INTERIM',
            'Dividendele interimare se regularizează pe seama dividendelor anuale ale aceluiași exercițiu, aprobate în anul următor.',
            `interimEntryIds.${index}`,
          ),
        );
    });
    if (input.date < annual.date)
      issues.push(
        block('DATE', 'Regularizarea urmează repartizării anuale a dividendelor.', 'date'),
      );
    if (issues.length) return { effect: null, issues };

    // Per shareholder: the interim dividends still on 463, and the annual dividend owed on 457.
    const claims = new Map<string, { id: string; balance: bigint }[]>();
    for (const entry of interims)
      for (const line of entry!.lines)
        if (line.account === '463' && line.openItem) {
          const item = loaded.openItems.get(line.openItem);
          if (item && item.balanceBani !== 0n)
            claims.set(item.partyId, [
              ...(claims.get(item.partyId) ?? []),
              { id: item.id, balance: item.balanceBani },
            ]);
        }
    const owed = new Map<string, { id: string; owed: bigint }>();
    for (const line of annual.lines)
      if (line.account === '457' && line.openItem) {
        const item = loaded.openItems.get(line.openItem);
        if (item) owed.set(item.partyId, { id: item.id, owed: -item.balanceBani });
      }
    if (!claims.size)
      return {
        effect: null,
        issues: [block('NOTHING', 'Dividendele interimare sunt deja regularizate.')],
      };
    const lines: LineSpec[] = [];
    for (const [partyId, items] of claims) {
      const interim = items.reduce((sum, item) => sum + item.balance, 0n);
      const annualItem = owed.get(partyId);
      const name = loaded.parties.get(partyId)?.name ?? partyId;
      if (!annualItem || annualItem.owed < interim) {
        issues.push(
          block(
            'INTERIM_EXCESS',
            `Dividendele interimare ale lui ${name} (${formatMoney(interim, 'RON')} lei) depășesc dividendul anual rămas de plată (${formatMoney(annualItem?.owed ?? 0n, 'RON')} lei): restituirea în 60 de zile (Legea nr. 82/1991 art. 19 alin. (3^2)) și impozitul reținut pe ea nu sunt încă suportate.`,
          ),
        );
        continue;
      }
      lines.push({ account: '457', side: 'D', bani: interim, openItem: annualItem.id, partyId });
      for (const item of items)
        lines.push({ account: '463', side: 'C', bani: item.balance, openItem: item.id, partyId });
    }
    if (issues.length) return { effect: null, issues };
    const total = lines
      .filter((line) => line.side === 'D')
      .reduce((sum, line) => sum + line.bani, 0n);
    const effect: Effect = {
      schema: 'effect@1',
      date: input.date as LocalDate,
      journalClass: 'general',
      journalCode: 'DIVIDENDE',
      description: `Regularizarea dividendelor interimare pe seama dividendelor din ${annual.date}`,
      lines,
      openItems: [],
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: `${claims.size} asociați, dividende interimare regularizate ${formatMoney(total, 'RON')} lei pe seama dividendelor anuale.`,
        details: { annual: annual.date, clauses: INTERIM },
      },
    };
    return { effect, issues: [] };
  },
};
