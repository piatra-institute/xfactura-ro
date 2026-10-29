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
    if (
      !entry ||
      !item ||
      item.controlAccount !== '457' ||
      !entry.lines.some((line) => line.account === '457' && line.openItem === item.id)
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
        block('NON_RESIDENT', 'Dividendele plătite nerezidenților nu sunt încă suportate.'),
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
        { account: '457', side: 'D', bani: tax, openItem: item.id, partyId: item.partyId },
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
        },
      ],
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: `Dividend brut ${formatMoney(gross, 'RON')} lei, impozit ${rate}% ${formatMoney(tax, 'RON')} lei, net de plată ${formatMoney(gross - tax, 'RON')} lei.`,
        details: { beneficiary: beneficiary!, rate, distribution: entry.date },
      },
    };
    return { effect, issues: issuesAfter };
  },
};
