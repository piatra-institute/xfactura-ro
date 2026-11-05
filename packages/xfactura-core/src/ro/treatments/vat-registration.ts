import { z } from 'zod';
import { hashOf } from '../../hash';
import {
  profileAt,
  turnoverKey,
  vatPeriodOf,
  type AnswerRecord,
  type AssetState,
  type Effect,
  type Issue,
  type LineSpec,
  type Loaded,
  type TaxEntrySpec,
  type TaxLedgerEntry,
  type Treatment,
  type TurnoverQuery,
} from '../../kernel';
import { formatMoney, parseMoney } from '../../money';
import { questionIssue, questionKinds, type CapitalGoodUseAnswer } from '../../questions/kinds';
import { RuleGapError, type RuleContext } from '../../rules';
import { addDays, isLocalDate, parseLocalDate, type LocalDate } from '../../time';
import { invoiceDocumentSchema } from '../../ubl/invoice-document';
import {
  adjustmentCodes,
  advanceVat,
  FULL_SHARE,
  initialShare,
  percentOf,
  remainingAdjustment,
  shareOf,
  stockVat,
  transitionalOf,
  unusedServiceVat,
  useAdjustment,
  type Share,
  type StockAdjustmentRule,
} from '../exempt';
import type { CapitalGoodsRule, LateRegistration } from '../nonpayers/parameters';
import {
  capitalGoodAdjustment,
  immovableAsset,
  lateRegistrationExposure,
  tangibleAsset,
  type CapitalGood,
} from '../nonpayers/regime';
import { invoiceKinds, taxPointOf } from './invoices';

/*
 * A change of VAT regime, booked (Codul fiscal art. 305, 310, 316): the VAT owed for registering
 * late, self-assessed in the first return after registration (art. 310 alin. (6^2)–(6^3)), and
 * the capital goods' once-for-all adjustment when the company enters or leaves the normal regime
 * (art. 305 alin. (5) lit. a) and c)). The VAT ANAF establishes by decision (alin. (6^1)) is the
 * tax account's to book from the decision (`tax.decision`, an assessment expensed on 635).
 */

const block = (code: string, message: string, path?: string): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
});
const info = (code: string, message: string): Issue => ({ code, severity: 'info', message });
const warn = (code: string, message: string): Issue => ({ code, severity: 'ack', message });
const lei = (bani: bigint) => formatMoney(bani, 'RON');
const day = z
  .string()
  .refine((value): boolean => isLocalDate(value))
  .transform((value) => parseLocalDate(value));

/** The tax codes of the regime change, which the D300 puts on its regularization rows. */
export const regimeCodes = {
  /** The VAT of a late registration (art. 310 alin. (6^2)–(6^3)): rd. 16 collected, rd. 33
   * deducted. */
  late: 'REG-310',
  /** The capital goods' adjustment (art. 305): rd. 34. */
  capitalGoods: 'ADJ-305',
} as const;

/** Every month from one date's to another's (YYYY-MM). */
function monthsOf(from: LocalDate, to: LocalDate): string[] {
  const months: string[] = [];
  for (let [y, m] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))]; ;) {
    const label = `${y}-${String(m).padStart(2, '0')}`;
    if (label > to.slice(0, 7)) break;
    months.push(label);
    if (++m === 13) [y, m] = [y + 1, 1];
  }
  return months;
}
/** The VAT periods a range's entries may be in: each month and its quarter, as the period a
 * booking took depended on the `vat.period` fact at the time. */
const periodsOf = (from: LocalDate, to: LocalDate) => [
  ...new Set(
    monthsOf(from, to).flatMap((month) => [
      month,
      `${month.slice(0, 4)}-Q${Math.ceil(Number(month.slice(5, 7)) / 3)}`,
    ]),
  ),
];
const ledgerOf = (loaded: Loaded, periods: readonly string[]) =>
  periods.flatMap((period) => loaded.taxLedger.get(`VAT|${period}`)?.entries ?? []);

/** The regime change the facts record on a date: the status on the day and the day before. */
function changeOn(loaded: Loaded, date: LocalDate) {
  return {
    before: profileAt(loaded, 'vat.status', addDays(date, -1)),
    after: profileAt(loaded, 'vat.status', date),
  };
}

function param<T>(
  rules: RuleContext,
  key: string,
  axis: Parameters<RuleContext['param']>[1],
  date: LocalDate,
  issues: Issue[],
  scope?: Record<string, string>,
): T | undefined {
  try {
    return rules.param<T>(key, axis, date, scope);
  } catch (error) {
    if (!(error instanceof RuleGapError)) throw error;
    issues.push(block('RULE_GAP', error.message));
    return undefined;
  }
}

/** The balances, at the end of a day, of the accounts under some prefixes. */
const balanceQuery = (prefixes: string[], to: LocalDate): TurnoverQuery => ({
  prefixes,
  from: '2000-01-01' as LocalDate,
  to,
});
const balancesOf = (loaded: Loaded, query: TurnoverQuery) =>
  (loaded.turnover.get(turnoverKey(query)) ?? [])
    .map((row) => ({ account: row.account, bani: row.debit - row.credit }))
    .filter((row) => row.bani !== 0n);

// ---------------------------------------------------------------------------------------------
// The VAT owed for registering late

export const lateRegistrationInput = z
  .object({
    /** The day the threshold was exceeded, from which the registration is valid (art. 316 alin.
     * (1^1) lit. b) and f)): the `vat.status` fact records `normal_vat` from it. */
    from: day,
    /** The last day the books kept the company outside VAT (its last sale without VAT). */
    until: day,
    /** The posting date: on or after `until`, in the VAT period of the return that declares it. */
    date: day,
    /** The registration certificate. */
    evidenceId: z.uuid(),
    /** Self-assessed: whether the price is taken to include the VAT (norme pct. 36 lit. b) pct.
     * 4: the customers do not pay it), with the company's statement that it cannot recover it. */
    consideration: z.enum(['inclusive', 'added']).optional(),
    considerationEvidenceId: z.uuid().optional(),
    /** The sales of the first day booked before the one that exceeded the threshold, which the
     * company leaves under the exemption (art. 310 alin. (6), last sentence). */
    excluded: z.array(z.uuid()).max(100).default([]),
    /** Each purchase with VAT of the range, booked without deduction, and what may be deducted of
     * it now (art. 297–298). Every one is listed. */
    purchases: z
      .array(
        z.object({ documentId: z.uuid(), deduction: z.enum(['full', 'limited', 'none']) }).strict(),
      )
      .max(1000)
      .default([]),
  })
  .strict();
export type LateRegistrationInput = z.infer<typeof lateRegistrationInput>;

/** What a late registration reads of the books over its range. */
export function lateRegistrationRange(input: Pick<LateRegistrationInput, 'from' | 'until'>) {
  return {
    periods: periodsOf(input.from, input.until),
    revenue: { prefixes: ['70'], from: input.from, to: input.until } satisfies TurnoverQuery,
    stock: balanceQuery(['3', '231'], addDays(input.from, -1)),
  };
}

/**
 * The VAT a company owes for the period in which it should have applied the normal regime,
 * self-assessed (art. 310 alin. (6^2) lit. b)–c)): computed from the books (revenue on 70x,
 * supplies abroad, the purchases' deductions decided) and booked on the first return after
 * registration (Dr 635 / Cr 4427, rd. 16; Dr 4426 / Cr 7588, rd. 33, by
 * `ro.vat.late_registration`), which `vat.settle` then settles with the period.
 */
export const lateRegistration: Treatment<LateRegistrationInput> = {
  id: 'vat.lateRegistration',
  version: 1,
  description:
    'TVA datorată pentru înregistrarea întârziată în scopuri de TVA, calculată din registre pentru perioada în care trebuia aplicat regimul normal și înscrisă în primul decont după înregistrare (art. 310 alin. (6^2)–(6^3)).',
  input: lateRegistrationInput,
  agent: true,
  summary:
    'VAT owed for a late VAT registration, self-assessed from the books for the period the normal regime should have applied and declared in the first return after registration.',
  toolset: 'tax',
  dataClasses: ['books', 'tax'],
  subject: (input) => `vat.lateRegistration:${input.from}`,
  plan(input) {
    const range = lateRegistrationRange(input);
    return {
      evidence: [
        input.evidenceId,
        ...(input.considerationEvidenceId ? [input.considerationEvidenceId] : []),
      ],
      profile: true,
      documents: input.excluded,
      taxPeriods: range.periods.map((period) => ({ tax: 'VAT', period })),
      turnover: [range.revenue, range.stock],
    };
  },
  evaluate(input, loaded, rules) {
    const issues: Issue[] = [];
    for (const id of [input.evidenceId, input.considerationEvidenceId])
      if (id && !loaded.evidence.has(id))
        issues.push(block('EVIDENCE', 'Documentul justificativ nu este disponibil.', 'evidenceId'));
    const change = changeOn(loaded, input.from);
    if (change.after !== 'normal_vat' || change.before === 'normal_vat')
      issues.push(
        block(
          'REGISTRATION',
          `Înregistrarea în scopuri de TVA trebuie consemnată de la ${input.from}, data depășirii plafonului (vat.status normal_vat, cu certificatul sau decizia; art. 316 alin. (1^1) lit. b) și f)).`,
          'from',
        ),
      );
    if (input.until < input.from)
      issues.push(block('RANGE', 'Intervalul se încheie înaintea datei înregistrării.', 'until'));
    if (input.date < input.until)
      issues.push(block('DATE', 'Data înregistrării contabile este după interval.', 'date'));
    if (profileAt(loaded, 'vat.status', input.date) !== 'normal_vat')
      issues.push(
        block('DATE', 'La data înregistrării contabile firma trebuie să fie plătitor.', 'date'),
      );
    const rule = param<LateRegistration>(
      rules,
      'ro.vat.late_registration',
      'reporting_period_start',
      input.date,
      issues,
    );
    const standard = { category: 'S' };
    const rate = param<string>(
      rules,
      'ro.vat.rate',
      'vat_chargeability_date',
      input.from,
      issues,
      standard,
    );
    const rateUntil = param<string>(
      rules,
      'ro.vat.rate',
      'vat_chargeability_date',
      input.until,
      issues,
      standard,
    );
    const share = param<string>(
      rules,
      'ro.vat.deduction.limited',
      'vat_chargeability_date',
      input.from,
      issues,
    );
    if (rate && rateUntil && rate !== rateUntil)
      issues.push(
        block(
          'RATE_CHANGE',
          `Cota standard se schimbă în interval (${rate}% → ${rateUntil}%): împărțiți intervalul la data schimbării.`,
          'until',
        ),
      );
    if (!input.consideration)
      issues.push(
        block(
          'CONSIDERATION',
          'Indicați dacă prețul se consideră cu TVA inclusă (clienții nu o plătesc, norme pct. 36 lit. b) pct. 4) sau dacă TVA se adaugă prețului.',
          'consideration',
        ),
      );
    else if (input.consideration === 'added')
      issues.push(
        block(
          'CONSIDERATION_ADDED',
          'TVA recuperată de la clienți se facturează prin facturi de corecție (art. 330), care se înregistrează ca atare: cazul nu este încă acoperit.',
          'consideration',
        ),
      );
    else if (!input.considerationEvidenceId)
      issues.push(
        block(
          'CONSIDERATION_EVIDENCE',
          'Atașați dovada că taxa nu se poate recupera de la beneficiari (poate fi și declarația pe propria răspundere a furnizorului, norme pct. 36 lit. b) pct. 4).',
          'considerationEvidenceId',
        ),
      );
    const range = lateRegistrationRange(input);
    const stock = balancesOf(loaded, range.stock);
    if (stock.length)
      issues.push(
        block(
          'STOCK_ADJUSTMENT',
          `La ${input.from} registrele au stocuri sau imobilizări în curs (${stock.map((row) => row.account).join(', ')}): taxa deductibilă aferentă lor (norme pct. 84 alin. (3) lit. a), art. 304) cere inventarierea și nu este acoperită.`,
        ),
      );

    const entries = ledgerOf(loaded, range.periods).filter(
      (entry) => entry.taxPoint >= input.from && entry.taxPoint <= input.until,
    );
    const charged = entries.filter(
      (entry) => entry.direction === 'output' && entry.code.startsWith('S-'),
    );
    if (charged.length)
      issues.push(
        block(
          'RANGE_CHARGED',
          `Facturile ${[...new Set(charged.map((entry) => entry.attributes.number ?? entry.documentId))].join(', ')} din interval au TVA: intervalul se încheie înaintea primei facturi cu TVA.`,
          'until',
        ),
      );
    const abroad = entries
      .filter((entry) => entry.direction === 'output' && entry.code.startsWith('EXP-'))
      .reduce((sum, entry) => sum + entry.baseBani, 0n);
    let excluded = 0n;
    for (const id of input.excluded) {
      const record = loaded.documents.get(id);
      const parsed = invoiceDocumentSchema.safeParse(record?.body);
      if (!record || record.kind !== invoiceKinds.sale || !parsed.success) {
        issues.push(block('EXCLUDED', 'Documentul exceptat nu este o factură emisă.', 'excluded'));
        continue;
      }
      if ((parsed.data.taxPointDate ?? parsed.data.issueDate) !== input.from)
        issues.push(
          block(
            'EXCLUDED',
            `Factura ${parsed.data.number} nu este din ${input.from}: doar livrările din ziua depășirii, dinaintea tranzacției care depășește plafonul, pot rămâne scutite (art. 310 alin. (6)).`,
            'excluded',
          ),
        );
      else if (parsed.data.currency !== 'RON')
        issues.push(block('EXCLUDED', 'Factura exceptată este în valută.', 'excluded'));
      else excluded += parseMoney(parsed.data.totals.net, 'RON');
    }
    // The purchases booked without deduction that charged VAT: each decided by a person.
    const pending = new Map<string, TaxLedgerEntry[]>();
    for (const entry of entries)
      if (
        entry.direction === 'input' &&
        entry.code.startsWith('S-') &&
        entry.taxBani !== 0n &&
        entry.deductibleBani === 0n &&
        entry.documentId
      )
        pending.set(entry.documentId, [...(pending.get(entry.documentId) ?? []), entry]);
    const decisions = new Map(input.purchases.map((item) => [item.documentId, item.deduction]));
    for (const id of decisions.keys())
      if (!pending.has(id))
        issues.push(
          block(
            'PURCHASE',
            'Achiziția indicată nu este o achiziție cu TVA nededusă din interval.',
            'purchases',
          ),
        );
    const unlisted = [...pending.keys()].filter((id) => !decisions.has(id));
    if (unlisted.length)
      issues.push(
        block(
          'PURCHASE_UNDECIDED',
          `${unlisted.length} achiziții cu TVA din interval nu au deducerea hotărâtă (art. 297–298): indicați-le pe toate în purchases.`,
          'purchases',
        ),
      );
    if (issues.some((issue) => issue.severity === 'block') || !rule || !rate || !share)
      return { effect: null, issues };

    const revenueRows = loaded.turnover.get(turnoverKey(range.revenue)) ?? [];
    const revenue = revenueRows.reduce((sum, row) => sum + row.credit - row.debit, 0n);
    const exposure = lateRegistrationExposure({
      from: input.from,
      until: input.until,
      revenueBani: revenue,
      abroadBani: abroad,
      excludedBani: excluded,
      rate,
      limitedShare: share,
      purchases: [...pending].map(([documentId, items]) => ({
        documentId,
        number: items[0]!.attributes.number ?? documentId,
        taxPoint: items[0]!.taxPoint,
        baseBani: items.reduce((sum, item) => sum + item.baseBani, 0n),
        vatBani: items.reduce((sum, item) => sum + item.taxBani, 0n),
        deduction: decisions.get(documentId) ?? null,
      })),
    });
    const collected = exposure.collected.inclusive;
    if (collected.vatBani === 0n && exposure.deductibleBani === 0n)
      return {
        effect: null,
        issues: [
          ...issues,
          block(
            'NOTHING',
            'În interval nu este nicio livrare taxabilă și nicio deducere: nu se datorează nimic.',
          ),
        ],
      };
    const taxPeriod = vatPeriodOf(loaded, input.date);
    const attributes = { from: input.from, until: input.until, consideration: 'inclusive' };
    const lines: LineSpec[] = [];
    const taxEntries: TaxEntrySpec[] = [];
    const vatEntry = (fields: Partial<TaxEntrySpec>): TaxEntrySpec => ({
      key: 'vat',
      tax: 'VAT',
      code: regimeCodes.late,
      direction: 'output',
      baseBani: 0n,
      taxBani: 0n,
      deductibleBani: 0n,
      ledgerBani: 0n,
      taxPoint: input.date,
      exigibility: input.date,
      taxPeriod,
      attributes,
      ...fields,
    });
    if (collected.vatBani !== 0n) {
      lines.push({ account: rule.expense, side: 'D', bani: collected.vatBani });
      lines.push({ account: '4427', side: 'C', bani: collected.vatBani });
      taxEntries.push(
        vatEntry({
          key: 'vat.collected',
          baseBani: collected.baseBani,
          taxBani: collected.vatBani,
          ledgerBani: collected.vatBani,
          line: lines.length - 1,
        }),
      );
    }
    if (exposure.deductibleBani !== 0n) {
      lines.push({ account: '4426', side: 'D', bani: exposure.deductibleBani });
      lines.push({ account: rule.income, side: 'C', bani: exposure.deductibleBani });
      taxEntries.push(
        vatEntry({
          key: 'vat.deducted',
          direction: 'input',
          baseBani: exposure.deductibleBaseBani,
          taxBani: exposure.deductibleBani,
          deductibleBani: exposure.deductibleBani,
          ledgerBani: exposure.deductibleBani,
          line: lines.length - 2,
        }),
      );
    }
    issues.push(
      info(
        'CAPITAL_GOODS',
        'Ajustarea pozitivă a taxei pentru bunurile de capital deținute la data înregistrării (norme pct. 84 alin. (3) lit. b)) se înregistrează separat (vat.capitalGoods).',
      ),
    );
    const effect: Effect = {
      schema: 'effect@1',
      date: input.date,
      journalClass: 'general',
      journalCode: 'TVA',
      description: `TVA pentru înregistrarea întârziată, ${input.from}–${input.until}`,
      lines,
      openItems: [],
      taxEntries,
      schedules: [],
      explanation: {
        summary: `TVA colectată ${lei(collected.vatBani)} lei (rd. 16), dedusă ${lei(exposure.deductibleBani)} lei (rd. 33), în decontul ${taxPeriod} (art. 310 alin. (6^3)).`,
        details: {
          from: input.from,
          until: input.until,
          rate,
          consideration: lei(exposure.considerationBani),
          collected: { base: lei(collected.baseBani), vat: lei(collected.vatBani) },
          deductible: lei(exposure.deductibleBani),
          net: lei(collected.vatBani - exposure.deductibleBani),
          lines: exposure.lines,
        },
      },
    };
    return { effect, issues };
  },
};

// ---------------------------------------------------------------------------------------------
// The capital goods' adjustment: on entering or leaving the normal regime, and in the general case

const good = z
  .object({
    assetId: z.uuid(),
    /** Its acquisition invoice and the VAT period its entries are in. */
    documentId: z.uuid(),
    taxPeriod: z.string().regex(/^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/),
  })
  .strict();

/** The events of a capital good's adjustment: the change of regime (art. 305 alin. (5) lit. a)
 * and c), last sentences), a change of its use (alin. (4) lit. a), c)), the year's adjustment
 * while a changed use holds (norme pct. 79 alin. (1)), its supply (alin. (5) lit. a), c)) and its
 * end (alin. (4) lit. d)). */
const regimeEvents = ['registration', 'deregistration'] as const;
const capitalEvents = [...regimeEvents, 'use', 'year', 'supply', 'cessation'] as const;

export const capitalGoodsInput = z
  .object({
    /** `registration`: from the small-enterprise exemption to the normal regime (art. 305 alin.
     * (5) lit. c)); `deregistration`: the other way (lit. a)); `use`: the share of a good's use
     * for operations with the right of deduction changes (alin. (4) lit. a), c), the share from
     * the `capitalGood.use` answer); `year`: the year's adjustment of goods whose changed use
     * holds, in its last return; `supply`: the good is supplied (exempt, or taxable after a
     * limited deduction); `cessation`: it ceases to exist (alin. (4) lit. d)). */
    event: z.enum(capitalEvents),
    /** The day of the event: the registration's validity, the cancellation's, the change of use,
     * the year's last day, the supply, the cessation. */
    date: day,
    /** The posting date. */
    postingDate: day,
    /** Every capital good the event concerns: at a change of regime every tangible fixed asset
     * held. */
    goods: z.array(good).max(500),
    /** The inventory at a change of regime (norme pct. 83 alin. (7) lit. a), (11) lit. a)). */
    inventoryEvidenceId: z.uuid().optional(),
    /** The registration certificate or the cancellation decision; the lease or decision of a
     * change of use; the year's statement of the goods; the sale invoice; the record of the
     * cessation. */
    evidenceId: z.uuid(),
    /** At a change of regime, the inventory's stock and assets in progress (3x, 231) at their
     * value and their acquisition's VAT rate (art. 304; norme pct. 78 alin. (13)). */
    stock: z
      .array(
        z
          .object({
            account: z.string().regex(/^(3[0-7]\d{0,4}|231\d{0,3})(\.[\dA-Z_-]{1,20})?$/),
            value: z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/),
            rate: z.string().regex(/^(0|[1-9]\d?)(\.\d{1,2})?$/),
          })
          .strict(),
      )
      .max(1000)
      .default([]),
    /** At a change of regime, the intangible assets not wholly depreciated (20x): the services
     * not used (norme pct. 78 alin. (2)). */
    services: z.array(good).max(500).default([]),
    /** At a cancellation, the advances paid still open (4091, 4092) whose supply comes after it
     * (norme pct. 83 alin. (7) lit. d)), with the advance invoice. */
    advances: z
      .array(
        z
          .object({
            openItemId: z.uuid(),
            documentId: z.uuid(),
            taxPeriod: z.string().regex(/^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/),
          })
          .strict(),
      )
      .max(500)
      .default([]),
    /** The sale invoice of a supplied good. */
    saleDocumentId: z.uuid().optional(),
    /** How a good ceased to exist: a shortage not proven a loss (adjusted, norme pct. 79 alin.
     * (10)); scrapped, destroyed or stolen with its proof (not adjusted, alin. (11), (17)). */
    cause: z.enum(['shortage', 'scrapped', 'destroyed', 'stolen']).optional(),
  })
  .strict()
  .refine(
    (input) =>
      (regimeEvents as readonly string[]).includes(input.event) ===
      (input.inventoryEvidenceId !== undefined),
    {
      message: 'Inventarierea se indică la schimbarea regimului de TVA (înregistrare sau anulare).',
      path: ['inventoryEvidenceId'],
    },
  )
  .refine(
    (input) =>
      (regimeEvents as readonly string[]).includes(input.event) ||
      (!input.stock.length && !input.services.length && !input.advances.length),
    {
      message:
        'Stocurile, serviciile neutilizate și avansurile se ajustează la schimbarea regimului de TVA.',
      path: ['stock'],
    },
  )
  .refine((input) => input.event !== 'registration' || !input.advances.length, {
    message: 'Avansurile se ajustează la anularea înregistrării.',
    path: ['advances'],
  })
  .refine((input) => (input.event === 'supply') === (input.saleDocumentId !== undefined), {
    message: 'Factura de vânzare se indică la livrarea bunului de capital.',
    path: ['saleDocumentId'],
  })
  .refine((input) => (input.event === 'cessation') === (input.cause !== undefined), {
    message: 'Cauza încetării existenței se indică pentru o încetare.',
    path: ['cause'],
  })
  .refine((input) => input.event !== 'year' || input.date.slice(5) === '12-31', {
    message: 'Ajustarea anului se înregistrează cu data ultimei zile a anului.',
    path: ['date'],
  });
export type CapitalGoodsInput = z.infer<typeof capitalGoodsInput>;

/** What a change of regime adjusts beside the capital goods (art. 304, norme pct. 83 alin. (7),
 * (11)): stock, assets in progress, advances, and deferred expenses, which are services used
 * when bought (norme pct. 78 alin. (2)). */
const otherAdjustable = (date: LocalDate) =>
  balanceQuery(['3', '231', '4091', '4092', '471'], addDays(date, -1));
/** Stock accounts that hold differences, not goods at their cost: their adjustment is not
 * covered (price differences, the trade margin, impairment). */
const stockDifferences = /^(308|348|368|378|388|39)/;

const eventYear = (input: Pick<CapitalGoodsInput, 'event' | 'date'>) =>
  Number(input.date.slice(0, 4));
/** The periods of a year, where a good's earlier adjustments of that year are. */
const yearPeriods = (year: number) =>
  periodsOf(`${year}-01-01` as LocalDate, `${year}-12-31` as LocalDate);

/** The capital good's use the basis cites, latest first by the engine's time. */
function capitalUse(loaded: Loaded, assetId: string, date: LocalDate) {
  const kind = questionKinds['capitalGood.use'];
  let found: { record: AnswerRecord; value: CapitalGoodUseAnswer } | null = null;
  for (const record of loaded.answers.values()) {
    if (record.kind !== kind.id || record.subject.kind !== 'asset' || record.subject.id !== assetId)
      continue;
    const parsed = kind.answer({}).safeParse(record.value);
    if (!parsed.success || parsed.data.from > date) continue;
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
 * The adjustment of capital goods' deductible VAT (art. 305; norme pct. 79, pct. 83):
 * - on entering the normal regime from the exemption, or leaving it, once for the whole period
 *   left, the change's year included (alin. (5) lit. a) and c)), with the stock, the assets in
 *   progress, the services not used and the advances (art. 304; norme pct. 78, pct. 83 alin.
 *   (7), (11));
 * - on a change of a good's use for operations with the right of deduction, the year's fifth (a
 *   twentieth for buildings) of its VAT at the new share, less a fifth of what was deducted, in
 *   the event's period, and in each later year's last period while the use holds (alin. (4) lit.
 *   a), c), (5) lit. a), c), (7); norme pct. 79 alin. (1));
 * - on its exempt supply, on a taxable supply after a limited deduction (at most the VAT
 *   collected) and on its cessation, once for the period left (alin. (4) lit. c)–d), (5)).
 * Rd. 34 (`R31_2`), tax entries ADJ-305 (capital goods) and ADJ-304 (stock and services).
 */
export const capitalGoodsAdjustment: Treatment<CapitalGoodsInput> = {
  id: 'vat.capitalGoods',
  version: 1,
  description:
    'Ajustarea taxei deductibile pentru bunurile de capital (art. 305 din Codul fiscal): la trecerea între regimul special de scutire și regimul normal, cu stocurile, serviciile neutilizate și avansurile (art. 304), la schimbarea folosirii unui bun, în fiecare an în care noua folosire se menține, la livrarea și la încetarea existenței lui.',
  input: capitalGoodsInput,
  agent: true,
  summary:
    "Adjusts capital goods' deductible VAT on a change of VAT regime (with stock and advances), on a change of a good's use and each year it holds, and when a good is supplied or ceases to exist.",
  toolset: 'tax',
  dataClasses: ['books', 'tax'],
  subject: (input) =>
    (regimeEvents as readonly string[]).includes(input.event)
      ? `vat.capitalGoods:${input.event}:${input.date}`
      : `vat.capitalGoods:${input.event}:${input.date}:${hashOf(
          input.goods.map((item) => item.assetId).sort(),
        ).slice(0, 16)}`,
  plan: (input) => {
    const regime = (regimeEvents as readonly string[]).includes(input.event);
    return {
      evidence: [
        input.evidenceId,
        ...(input.inventoryEvidenceId ? [input.inventoryEvidenceId] : []),
      ],
      profile: true,
      assets: true,
      documents: input.saleDocumentId ? [input.saleDocumentId] : [],
      taxPeriods: [
        ...new Set([
          ...[...input.goods, ...input.services, ...input.advances].map((item) => item.taxPeriod),
          // A good's earlier adjustments of the event's year.
          ...(regime ? [] : yearPeriods(eventYear(input))),
        ]),
      ].map((period) => ({ tax: 'VAT', period })),
      ...(regime ? { turnover: [otherAdjustable(input.date)] } : {}),
      ...(input.advances.length
        ? { openItems: [{ ids: input.advances.map((item) => item.openItemId) }] }
        : {}),
    };
  },
  evaluate(input, loaded, rules) {
    const issues: Issue[] = [];
    for (const id of [input.evidenceId, input.inventoryEvidenceId])
      if (id && !loaded.evidence.has(id))
        issues.push(block('EVIDENCE', 'Documentul justificativ nu este disponibil.', 'evidenceId'));
    const regime = (regimeEvents as readonly string[]).includes(input.event);
    const rule = param<CapitalGoodsRule>(
      rules,
      'ro.vat.capital_goods',
      'vat_chargeability_date',
      input.date,
      issues,
    );
    const minimum = param<string>(
      rules,
      'ro.vat.capital_goods.minimum',
      'vat_chargeability_date',
      input.date,
      issues,
    );
    const stockRule =
      regime && (input.stock.length || input.services.length || input.advances.length)
        ? param<StockAdjustmentRule>(
            rules,
            'ro.vat.stock_adjustment',
            'vat_chargeability_date',
            input.date,
            issues,
          )
        : undefined;
    // The event's tax point: the day before a cancellation (its last return holds it), the
    // registration's posting, or the event's day.
    let taxPoint: LocalDate =
      input.event === 'deregistration'
        ? addDays(input.date, -1)
        : input.event === 'registration'
          ? input.postingDate
          : input.date;
    if (input.postingDate < input.date && input.event !== 'deregistration')
      issues.push(block('DATE', 'Ajustarea se înregistrează după eveniment.', 'postingDate'));

    if (regime) {
      const change = changeOn(loaded, input.date);
      const [before, after] =
        input.event === 'registration' ? ['non_vat', 'normal_vat'] : ['normal_vat', 'non_vat'];
      if (change.before !== before || change.after !== after)
        issues.push(
          block(
            'REGIME_CHANGE',
            `Faptele companiei nu consemnează ${input.event === 'registration' ? 'înregistrarea' : 'anularea înregistrării'} în scopuri de TVA la ${input.date} (vat.status ${after}).`,
            'date',
          ),
        );
      const listed = new Map(input.goods.map((item) => [item.assetId, item]));
      for (const asset of loaded.assets.values()) {
        if (!tangibleAsset(asset.account)) continue;
        const held =
          asset.commissionedOn < input.date &&
          (asset.disposedOn === null || asset.disposedOn >= input.date);
        if (held && !listed.has(asset.id))
          issues.push(
            block(
              'CAPITAL_GOOD_UNLISTED',
              `Mijlocul fix ${asset.number} ${asset.name} este bun de capital la ${input.date}: indicați-l cu factura de achiziție.`,
              'goods',
            ),
          );
      }
    } else if (profileAt(loaded, 'vat.status', input.date) !== 'normal_vat')
      issues.push(
        block(
          'NOT_VAT_PAYER',
          `La ${input.date} compania nu este înregistrată în scopuri de TVA: ajustarea o face persoana înregistrată (art. 305 din Codul fiscal).`,
          'date',
        ),
      );

    // Each good's acquisition: its VAT and what was deducted of it.
    const goods: { basis: CapitalGood; asset: AssetState; prorata: boolean; rate: string }[] = [];
    for (const item of input.goods) {
      const asset = loaded.assets.get(item.assetId);
      if (!asset || !tangibleAsset(asset.account)) {
        issues.push(
          block('ASSET', 'Mijlocul fix nu este un activ corporal din registru.', 'goods'),
        );
        continue;
      }
      const entries = (loaded.taxLedger.get(`VAT|${item.taxPeriod}`)?.entries ?? []).filter(
        (entry) =>
          entry.direction === 'input' &&
          entry.documentId === item.documentId &&
          entry.code.startsWith('S-'),
      );
      if (!entries.length) {
        issues.push(
          block(
            'ASSET_VAT',
            `Factura de achiziție a mijlocului fix ${asset.number} nu are TVA în perioada ${item.taxPeriod}.`,
            'goods',
          ),
        );
        continue;
      }
      goods.push({
        asset,
        prorata: entries.some((entry) => entry.attributes.prorata !== undefined),
        // The rate of the VAT adjusted (norme pct. 78 alin. (13)), for the SAF-T code.
        rate: entries[0]!.code.replace(/^S-/, ''),
        basis: {
          assetId: asset.id,
          number: asset.number,
          name: asset.name,
          immovable: immovableAsset(asset),
          acquiredOn: entries.map((entry) => entry.taxPoint).sort()[0]!,
          vatBani: entries.reduce((sum, entry) => sum + entry.taxBani, 0n),
          deductedBani: entries.reduce((sum, entry) => sum + entry.deductibleBani, 0n),
        },
      });
    }
    if (new Set(input.goods.map((item) => item.assetId)).size !== input.goods.length)
      issues.push(block('GOODS', 'Un bun de capital se indică o singură dată.', 'goods'));
    if (!regime && !input.goods.length)
      issues.push(block('GOODS', 'Indicați bunurile de capital ajustate.', 'goods'));

    // The goods' adjustments, by the event.
    const year = input.event === 'deregistration' ? Number(taxPoint.slice(0, 4)) : eventYear(input);
    const already = (assetId: string) =>
      ledgerOf(loaded, yearPeriods(year))
        .filter(
          (entry) =>
            entry.code === regimeCodes.capitalGoods &&
            entry.attributes.assetId === assetId &&
            entry.attributes.year === String(year),
        )
        .reduce((sum, entry) => sum + entry.deductibleBani, 0n);
    const adjustments: {
      assetId: string;
      number: string;
      bani: bigint;
      share: Share | null;
      line: string;
    }[] = [];
    const rateOf = new Map(goods.map((item) => [item.basis.assetId, item.rate]));
    const rates = [...new Set(goods.map((item) => item.rate))];
    let sale: { exempt: boolean; collected: bigint } | null = null;
    if (input.event === 'supply') {
      const record = loaded.documents.get(input.saleDocumentId!);
      const parsed = invoiceDocumentSchema.safeParse(record?.body);
      if (!record || record.kind !== invoiceKinds.sale || !parsed.success)
        issues.push(
          block(
            'SALE',
            'Factura de vânzare nu este o factură emisă de companie.',
            'saleDocumentId',
          ),
        );
      else {
        const exempt = parsed.data.taxes.some((tax) => tax.category === 'E');
        const taxed = parsed.data.taxes.some((tax) => tax.category === 'S');
        if (exempt === taxed)
          issues.push(
            block(
              'SALE',
              'Factura de vânzare a bunului de capital este fie scutită (E, art. 292), fie taxabilă (S).',
              'saleDocumentId',
            ),
          );
        if (input.goods.length > 1)
          issues.push(
            block(
              'GOODS',
              'La livrare, fiecare bun de capital se ajustează cu factura lui: taxa suplimentară de dedus se limitează la TVA colectată pentru livrarea bunului respectiv (art. 305 alin. (4) lit. c)).',
              'goods',
            ),
          );
        sale = { exempt, collected: parseMoney(parsed.data.totals.tax, 'RON') };
        taxPoint = taxPointOf(parsed.data);
        if (taxPoint.slice(0, 4) !== String(year))
          issues.push(
            block('DATE', `Livrarea are data exigibilității ${taxPoint}, nu în ${year}.`, 'date'),
          );
      }
    }
    if (rule)
      for (const { basis, asset, prorata } of goods) {
        const transitional = transitionalOf(
          basis,
          {
            value: asset.value,
            depreciated: asset.depreciated,
            fiscalLifeMonths: asset.fiscal?.lifeMonths ?? null,
          },
          year,
          rule,
        );
        if (transitional.kind === 'ART306' || transitional.kind === 'ART332') {
          issues.push(
            block(
              transitional.kind,
              transitional.kind === 'ART306'
                ? `Mijlocul fix ${asset.number} a fost achiziționat înainte de 2016 și nu este amortizat complet: ajustarea proporțională cu valoarea rămasă neamortizată (art. 306 din Codul fiscal, norme pct. 80) nu este acoperită.`
                : `Bunul imobil ${asset.number} a fost achiziționat înainte de aderare: ajustarea urmează dispozițiile tranzitorii ale art. 332 din Codul fiscal, neacoperite.`,
              'goods',
            ),
          );
          continue;
        }
        if (transitional.kind === 'expired') {
          adjustments.push({
            assetId: asset.id,
            number: asset.number,
            bani: 0n,
            share: null,
            line: `${asset.number} ${asset.name}: achiziționat la ${basis.acquiredOn}; perioada de ajustare s-a încheiat sau activul este amortizat complet (art. 305 alin. (2)–(3), art. 306): nu se ajustează.`,
          });
          continue;
        }
        if (regime) {
          const result = capitalGoodAdjustment(
            basis,
            input.event as 'registration' | 'deregistration',
            input.date,
            rule,
          );
          adjustments.push({
            assetId: asset.id,
            number: asset.number,
            bani: result.bani,
            share: null,
            line: result.line,
          });
          continue;
        }
        if (prorata) {
          issues.push(
            block(
              'CAPITAL_GOOD_PRORATA',
              `Mijlocul fix ${asset.number} s-a dedus pe bază de pro rata: se ajustează anual cu pro rata definitivă (art. 305 alin. (4) lit. b), art. 300 alin. (15)), prin vat.proRata.`,
              'goods',
            ),
          );
          continue;
        }
        const done = already(asset.id);
        if (input.event === 'use' || input.event === 'year') {
          const found = capitalUse(loaded, asset.id, input.date);
          if (!found) {
            issues.push(
              questionIssue(
                'CAPITAL_GOOD_USE',
                `Folosirea bunului de capital ${asset.number} ${asset.name} pentru operațiuni cu drept de deducere la ${input.date} nu este cunoscută: întrebați proprietarul (capitalGood.use) și revizuiți propunerea citând răspunsul.`,
                {
                  kind: 'capitalGood.use',
                  subject: { kind: 'asset', id: asset.id },
                  params: { date: input.date },
                },
                'block',
                'goods',
              ),
            );
            continue;
          }
          if (input.event === 'use' && found.value.from !== input.date)
            issues.push(
              block(
                'USE_DATE',
                `Răspunsul despre ${asset.number} arată folosirea de la ${found.value.from}: ajustarea pentru schimbarea folosirii are data evenimentului (date: ${found.value.from}).`,
                'date',
              ),
            );
          const share = shareOf(found.value.share)!;
          if (input.event === 'year' && share === initialShare(basis)) {
            adjustments.push({
              assetId: asset.id,
              number: asset.number,
              bani: 0n,
              share,
              line: `${asset.number} ${asset.name}: folosit în ${year} ca la deducerea inițială (${percentOf(share)}): nu se ajustează.`,
            });
            continue;
          }
          const result = useAdjustment(basis, year, share, done, rule);
          adjustments.push({
            assetId: asset.id,
            number: asset.number,
            bani: result.bani,
            share,
            line: result.line,
          });
          continue;
        }
        if (input.event === 'supply' && sale) {
          // Taxable after a full deduction: nothing changes (alin. (4) lit. d) pct. 1).
          const share = sale.exempt ? 0 : FULL_SHARE;
          const result = remainingAdjustment(
            basis,
            year,
            share,
            done,
            rule,
            sale.exempt ? undefined : sale.collected,
          );
          adjustments.push({
            assetId: asset.id,
            number: asset.number,
            bani: !sale.exempt && basis.deductedBani >= basis.vatBani ? 0n : result.bani,
            share,
            line: result.line,
          });
          continue;
        }
        if (input.event === 'cessation') {
          if (input.cause !== 'shortage') {
            adjustments.push({
              assetId: asset.id,
              number: asset.number,
              bani: 0n,
              share: null,
              line: `${asset.number} ${asset.name}: ${input.cause === 'scrapped' ? 'casat' : input.cause === 'destroyed' ? 'distrus, dovedit' : 'furat, dovedit prin actele organelor judiciare'}: taxa dedusă nu se ajustează (art. 305 alin. (4) lit. d) pct. 2 și 4, norme pct. 79 alin. (11), (17)).`,
            });
            continue;
          }
          const result = remainingAdjustment(basis, year, 0, done, rule);
          adjustments.push({
            assetId: asset.id,
            number: asset.number,
            bani: result.bani,
            share: 0,
            line: result.line,
          });
        }
      }
    if (input.event === 'cessation' && input.cause !== 'shortage')
      issues.push(
        warn(
          'CESSATION_PROOF',
          'Bunurile casate, distruse sau furate nu se ajustează doar cu dovada lor: procesul-verbal de casare, documentele care confirmă distrugerea, actele organelor judiciare (norme pct. 79 alin. (11)–(12)). Confirmați.',
        ),
      );
    // The smallest adjustment made, if any is set (art. 305 alin. (9), repealed).
    const floor = minimum ? BigInt(minimum) * 100n : 0n;
    for (const item of adjustments)
      if (item.bani !== 0n && (item.bani < 0n ? -item.bani : item.bani) < floor) {
        item.line = `${item.line} Sub pragul de ${minimum} lei: nu se ajustează.`;
        item.bani = 0n;
      }

    // Stock, services not used and advances on a change of regime (art. 304).
    const other: { key: string; rate: string; bani: bigint; line: string }[] = [];
    if (regime) {
      const sign = input.event === 'deregistration' ? -1n : 1n;
      const balances = balancesOf(loaded, otherAdjustable(input.date));
      const stocked = new Map<string, bigint>();
      for (const line of input.stock) {
        const synthetic = line.account.split('.')[0]!;
        if (stockDifferences.test(synthetic))
          issues.push(
            block('STOCK_ACCOUNT', `Contul ${line.account} nu ține bunuri la cost.`, 'stock'),
          );
        stocked.set(
          line.account,
          (stocked.get(line.account) ?? 0n) + parseMoney(line.value, 'RON'),
        );
      }
      for (const row of balances) {
        if (row.account.startsWith('471')) continue; // services used when bought (pct. 78 (2))
        if (row.account.startsWith('409')) continue; // the advances, below
        if (stockDifferences.test(row.account))
          issues.push(
            block(
              'STOCK_DIFFERENCES',
              `La ${input.date} contul ${row.account} are sold (${lei(row.bani)} lei): ajustarea stocurilor ținute la preț de vânzare, cu diferențe de preț sau ajustări pentru depreciere nu este încă acoperită.`,
            ),
          );
        else if ((stocked.get(row.account) ?? 0n) !== row.bani)
          issues.push(
            block(
              'STOCK_UNLISTED',
              `La ${input.date} contul ${row.account} are soldul ${lei(row.bani)} lei, iar inventarul indicat ${lei(stocked.get(row.account) ?? 0n)} lei: indicați stocul inventariat pe conturi (stock), cu cota TVA de la achiziție.`,
              'stock',
            ),
          );
      }
      for (const account of stocked.keys())
        if (!balances.some((row) => row.account === account))
          issues.push(
            block('STOCK_UNLISTED', `Contul ${account} nu are sold la ${input.date}.`, 'stock'),
          );
      if (input.stock.some((line) => line.rate !== '0'))
        issues.push(
          warn(
            'STOCK_RATE',
            'Taxa stocurilor se ajustează la cota în vigoare la data achiziției lor (norme pct. 78 alin. (13)): confirmați cotele inventarului.',
          ),
        );
      const byRate = new Map<string, bigint>();
      for (const line of input.stock) {
        const vat = stockVat({
          account: line.account,
          valueBani: parseMoney(line.value, 'RON'),
          rate: line.rate,
        });
        if (vat !== 0n) byRate.set(line.rate, (byRate.get(line.rate) ?? 0n) + vat);
      }
      for (const [rate, vat] of byRate)
        other.push({
          key: `stock:${rate}`,
          rate,
          bani: sign * vat,
          line: `Stocuri și active în curs la cota de ${rate}%: TVA ${lei(vat)} lei ${sign < 0n ? 'dedusă, anulată' : 'nededusă, dedusă acum'} (art. 304, norme pct. 83 alin. (7) lit. a), (11) lit. a)).`,
        });
      // Intangible assets not wholly depreciated (norme pct. 78 alin. (2)).
      const services = new Map(input.services.map((item) => [item.assetId, item]));
      for (const asset of loaded.assets.values()) {
        if (!asset.account.startsWith('20')) continue;
        const held =
          asset.commissionedOn < input.date &&
          (asset.disposedOn === null || asset.disposedOn >= input.date);
        if (held && asset.depreciated < asset.value && !services.has(asset.id))
          issues.push(
            block(
              'SERVICE_UNLISTED',
              `Imobilizarea necorporală ${asset.number} ${asset.name} nu este amortizată complet: este un serviciu neutilizat (norme pct. 78 alin. (2)), indicați-o cu factura de achiziție (services).`,
              'services',
            ),
          );
      }
      for (const item of input.services) {
        const asset = loaded.assets.get(item.assetId);
        if (!asset || !asset.account.startsWith('20')) {
          issues.push(
            block('ASSET', 'Imobilizarea nu este una necorporală din registru.', 'services'),
          );
          continue;
        }
        const entries = (loaded.taxLedger.get(`VAT|${item.taxPeriod}`)?.entries ?? []).filter(
          (entry) =>
            entry.direction === 'input' &&
            entry.documentId === item.documentId &&
            entry.code.startsWith('S-'),
        );
        if (!entries.length) {
          issues.push(
            block(
              'ASSET_VAT',
              `Factura imobilizării ${asset.number} nu are TVA în ${item.taxPeriod}.`,
              'services',
            ),
          );
          continue;
        }
        const vat = entries.reduce(
          (sum, entry) =>
            sum + (sign < 0n ? entry.deductibleBani : entry.taxBani - entry.deductibleBani),
          0n,
        );
        const left = unusedServiceVat(vat, asset);
        if (left === 0n) continue;
        const rate = entries[0]!.code.replace(/^S-/, '');
        other.push({
          key: `service:${asset.number}`,
          rate,
          bani: sign * left,
          line: `${asset.number} ${asset.name}: TVA ${lei(vat)} lei, pentru valoarea rămasă neamortizată ${lei(asset.value - asset.depreciated)} din ${lei(asset.value)} lei: ${lei(left)} lei (norme pct. 78 alin. (2)).`,
        });
      }
      // Advances still open at a cancellation (norme pct. 83 alin. (7) lit. d)).
      const advanceBalance = balances
        .filter((row) => row.account.startsWith('4091') || row.account.startsWith('4092'))
        .reduce((sum, row) => sum + row.bani, 0n);
      let listedAdvances = 0n;
      for (const item of input.advances) {
        const open = loaded.openItems.get(item.openItemId);
        if (!open || open.kind !== 'advance.paid') {
          issues.push(block('ADVANCE', 'Poziția indicată nu este un avans plătit.', 'advances'));
          continue;
        }
        const entries = (loaded.taxLedger.get(`VAT|${item.taxPeriod}`)?.entries ?? []).filter(
          (entry) =>
            entry.direction === 'input' &&
            entry.documentId === item.documentId &&
            entry.code.startsWith('S-'),
        );
        if (!entries.length || open.documentId !== item.documentId) {
          issues.push(
            block('ADVANCE', 'Factura de avans nu are TVA în perioada indicată.', 'advances'),
          );
          continue;
        }
        const openBani = open.balanceBani < 0n ? -open.balanceBani : open.balanceBani;
        listedAdvances += openBani;
        const gross = entries.reduce((sum, entry) => sum + entry.baseBani + entry.taxBani, 0n);
        const deducted = entries.reduce((sum, entry) => sum + entry.deductibleBani, 0n);
        const vat = advanceVat(deducted, gross, openBani);
        if (vat === 0n) continue;
        other.push({
          key: `advance:${item.openItemId}`,
          rate: entries[0]!.code.replace(/^S-/, ''),
          bani: -vat,
          line: `Avansul ${entries[0]!.attributes.number ?? item.documentId}: ${lei(openBani)} lei nedecontat din ${lei(gross)} lei, TVA dedusă ${lei(vat)} lei, anulată (norme pct. 83 alin. (7) lit. d)).`,
        });
      }
      if (input.event === 'deregistration' && listedAdvances !== advanceBalance)
        issues.push(
          block(
            'ADVANCE_UNLISTED',
            `La ${input.date} avansurile plătite (4091, 4092) însumează ${lei(advanceBalance)} lei, iar cele indicate ${lei(listedAdvances)} lei: indicați fiecare avans nedecontat (advances).`,
            'advances',
          ),
        );
      if (input.event === 'registration' && advanceBalance !== 0n)
        issues.push(
          block(
            'ADVANCE_UNLISTED',
            `La ${input.date} există avansuri plătite (${lei(advanceBalance)} lei): ajustarea lor la înregistrare nu este încă acoperită.`,
            'advances',
          ),
        );
      const deferred = balances.find((row) => row.account.startsWith('471'));
      if (deferred)
        issues.push(
          info(
            'DEFERRED_SERVICES',
            `Cheltuielile în avans (471, ${lei(deferred.bani)} lei) sunt servicii utilizate la achiziție (norme pct. 78 alin. (2)): nu se ajustează.`,
          ),
        );
    }
    if (issues.some((issue) => issue.severity === 'block') || !rule)
      return { effect: null, issues };
    const total = adjustments.reduce((sum, item) => sum + item.bani, 0n);
    const totalOther = other.reduce((sum, item) => sum + item.bani, 0n);
    if (adjustments.every((item) => item.bani === 0n) && other.every((item) => item.bani === 0n))
      return {
        effect: null,
        issues: [
          ...issues,
          block(
            'NOTHING',
            `Nu este nimic de ajustat: ${[...adjustments.map((item) => item.line)].join(' ') || 'niciun bun de capital nu are taxă de ajustat pentru perioada rămasă.'}`,
          ),
        ],
      };
    const taxPeriod = vatPeriodOf(loaded, taxPoint);
    const lines: LineSpec[] = [];
    const taxEntries: TaxEntrySpec[] = [];
    // One 4426 line per sign and code, its entries pointing to it.
    const post = (
      code: string,
      items: { key: string; bani: bigint; attributes: Record<string, string> }[],
      accounts: { expense: string; income: string },
    ) => {
      for (const sign of [1n, -1n]) {
        const members = items.filter((item) => (sign > 0n ? item.bani > 0n : item.bani < 0n));
        if (!members.length) continue;
        const sum = members.reduce((acc, item) => acc + item.bani, 0n);
        if (sum > 0n) {
          lines.push({ account: '4426', side: 'D', bani: sum });
          lines.push({ account: accounts.income, side: 'C', bani: sum });
        } else {
          lines.push({ account: accounts.expense, side: 'D', bani: -sum });
          lines.push({ account: '4426', side: 'C', bani: -sum });
        }
        const line = sum > 0n ? lines.length - 2 : lines.length - 1;
        for (const item of members)
          taxEntries.push({
            key: item.key,
            tax: 'VAT',
            code,
            direction: 'input',
            baseBani: 0n,
            taxBani: item.bani,
            deductibleBani: item.bani,
            ledgerBani: item.bani,
            line,
            taxPoint,
            exigibility: taxPoint,
            taxPeriod,
            attributes: item.attributes,
          });
      }
    };
    if (regime)
      // On a change of regime, one entry for the capital goods (V1).
      post(
        regimeCodes.capitalGoods,
        total === 0n
          ? []
          : [
              {
                key: 'vat',
                bani: total,
                attributes: {
                  event: input.event,
                  change: input.date,
                  goods: String(goods.length),
                  ...(rates.length === 1 ? { rate: rates[0]! } : {}),
                },
              },
            ],
        rule,
      );
    else
      post(
        regimeCodes.capitalGoods,
        adjustments
          .filter((item) => item.bani !== 0n)
          .map((item) => ({
            key: `vat:${item.number}`,
            bani: item.bani,
            attributes: {
              event: input.event,
              change: input.date,
              assetId: item.assetId,
              year: String(year),
              ...(item.share !== null ? { share: String(item.share) } : {}),
              ...(rateOf.get(item.assetId) ? { rate: rateOf.get(item.assetId)! } : {}),
            },
          })),
        rule,
      );
    if (stockRule)
      post(
        adjustmentCodes.stock,
        other
          .filter((item) => item.bani !== 0n)
          .map((item) => ({
            key: `vat:${item.key}`,
            bani: item.bani,
            attributes: { event: input.event, change: input.date, rate: item.rate },
          })),
        stockRule,
      );
    const grand = total + totalOther;
    const labels: Record<CapitalGoodsInput['event'], string> = {
      registration: 'la înregistrarea în scopuri de TVA',
      deregistration: 'la anularea înregistrării în scopuri de TVA',
      use: 'la schimbarea folosirii',
      year: `pentru anul ${year}`,
      supply: 'la livrarea bunului de capital',
      cessation: 'la încetarea existenței bunului de capital',
    };
    const effect: Effect = {
      schema: 'effect@1',
      date: input.postingDate,
      journalClass: 'general',
      journalCode: 'TVA',
      description: `Ajustarea TVA pentru bunurile de capital ${labels[input.event]} (${input.date})`,
      lines,
      openItems: [],
      taxEntries,
      schedules: [],
      explanation: {
        summary: `Ajustare ${lei(grand < 0n ? -grand : grand)} lei ${grand < 0n ? 'în favoarea bugetului' : 'în favoarea firmei'} în decontul ${taxPeriod}, rd. 34 (art. 305${other.length ? ' și art. 304' : ''} din Codul fiscal).`,
        details: {
          event: input.event,
          date: input.date,
          lines: [...adjustments.map((item) => item.line), ...other.map((item) => item.line)],
        },
      },
    };
    return { effect, issues };
  },
};
