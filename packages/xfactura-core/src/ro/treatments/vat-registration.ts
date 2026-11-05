import { z } from 'zod';
import {
  profileAt,
  turnoverKey,
  vatPeriodOf,
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
import { RuleGapError, type RuleContext } from '../../rules';
import { addDays, isLocalDate, parseLocalDate, type LocalDate } from '../../time';
import { invoiceDocumentSchema } from '../../ubl/invoice-document';
import type { CapitalGoodsRule, LateRegistration } from '../nonpayers/parameters';
import {
  capitalGoodAdjustment,
  immovableAsset,
  lateRegistrationExposure,
  tangibleAsset,
  type CapitalGood,
} from '../nonpayers/regime';
import { invoiceKinds } from './invoices';

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
// The capital goods' adjustment on entering or leaving the normal regime

export const capitalGoodsInput = z
  .object({
    /** `registration`: from the small-enterprise exemption to the normal regime (art. 305 alin.
     * (5) lit. c)); `deregistration`: the other way (lit. a)). */
    event: z.enum(['registration', 'deregistration']),
    /** The day of the change: the registration's validity, or the cancellation's. */
    date: day,
    /** The posting date. */
    postingDate: day,
    /** Every tangible fixed asset held at the change, with its acquisition invoice and the VAT
     * period its entries are in. */
    goods: z
      .array(
        z
          .object({
            assetId: z.uuid(),
            documentId: z.uuid(),
            taxPeriod: z.string().regex(/^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/),
          })
          .strict(),
      )
      .max(500),
    /** The inventory at the change (norme pct. 83 alin. (7) lit. a), (11) lit. a)). */
    inventoryEvidenceId: z.uuid(),
    /** The registration certificate or the cancellation decision. */
    evidenceId: z.uuid(),
  })
  .strict();
export type CapitalGoodsInput = z.infer<typeof capitalGoodsInput>;

/** What the deregistration's adjustment of art. 304 would need: stock, assets in progress,
 * advances and deferred services, which the engine does not adjust yet. */
const otherAdjustable = (date: LocalDate) =>
  balanceQuery(['3', '231', '4091', '4092', '471'], addDays(date, -1));

/**
 * The once-for-all adjustment of the capital goods' VAT when the company enters or leaves the
 * normal regime (art. 305 alin. (5) lit. a) and c)): a fifth (a twentieth for buildings) of the
 * VAT deducted, or not deducted, for each year left of the period, the change's year included.
 * Leaving, Dr 635 / Cr 4426 in the last return; entering, Dr 4426 / Cr 7588 in the first (rd. 34).
 */
export const capitalGoodsAdjustment: Treatment<CapitalGoodsInput> = {
  id: 'vat.capitalGoods',
  version: 1,
  description:
    'Ajustarea taxei deductibile pentru bunurile de capital la trecerea între regimul special de scutire și regimul normal de taxare (art. 305 alin. (5) lit. a) și c)).',
  input: capitalGoodsInput,
  agent: true,
  summary:
    "Adjusts the capital goods' deductible VAT once, for the remaining adjustment period, when the company enters or leaves the normal VAT regime.",
  toolset: 'tax',
  dataClasses: ['books', 'tax'],
  subject: (input) => `vat.capitalGoods:${input.event}:${input.date}`,
  plan: (input) => ({
    evidence: [input.evidenceId, input.inventoryEvidenceId],
    profile: true,
    assets: true,
    taxPeriods: [...new Set(input.goods.map((good) => good.taxPeriod))].map((period) => ({
      tax: 'VAT',
      period,
    })),
    ...(input.event === 'deregistration' ? { turnover: [otherAdjustable(input.date)] } : {}),
  }),
  evaluate(input, loaded, rules) {
    const issues: Issue[] = [];
    for (const id of [input.evidenceId, input.inventoryEvidenceId])
      if (!loaded.evidence.has(id))
        issues.push(block('EVIDENCE', 'Documentul justificativ nu este disponibil.', 'evidenceId'));
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
    // The last day of the normal regime (leaving) or its first (entering): its return holds it.
    const taxPoint = input.event === 'deregistration' ? addDays(input.date, -1) : input.postingDate;
    if (input.event === 'registration' && input.postingDate < input.date)
      issues.push(block('DATE', 'Ajustarea se înregistrează după înregistrare.', 'postingDate'));
    const rule = param<CapitalGoodsRule>(
      rules,
      'ro.vat.capital_goods',
      'vat_chargeability_date',
      input.date,
      issues,
    );
    if (input.event === 'deregistration') {
      const others = balancesOf(loaded, otherAdjustable(input.date));
      if (others.length)
        issues.push(
          block(
            'OTHER_ADJUSTMENTS',
            `La ${input.date} registrele au solduri pe ${others.map((row) => row.account).join(', ')}: ajustarea taxei pentru stocuri, active în curs, servicii neutilizate și avansuri (art. 304, norme pct. 83 alin. (7) lit. a) și d)) nu este încă acoperită.`,
          ),
        );
    }
    const listed = new Map(input.goods.map((good) => [good.assetId, good]));
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
    const goods: CapitalGood[] = [];
    for (const good of input.goods) {
      const asset = loaded.assets.get(good.assetId);
      if (!asset || !tangibleAsset(asset.account)) {
        issues.push(
          block('ASSET', 'Mijlocul fix nu este un activ corporal din registru.', 'goods'),
        );
        continue;
      }
      const entries = (loaded.taxLedger.get(`VAT|${good.taxPeriod}`)?.entries ?? []).filter(
        (entry) =>
          entry.direction === 'input' &&
          entry.documentId === good.documentId &&
          entry.code.startsWith('S-'),
      );
      if (!entries.length) {
        issues.push(
          block(
            'ASSET_VAT',
            `Factura de achiziție a mijlocului fix ${asset.number} nu are TVA în perioada ${good.taxPeriod}.`,
            'goods',
          ),
        );
        continue;
      }
      const acquiredOn = entries.map((entry) => entry.taxPoint).sort()[0]!;
      if (acquiredOn < '2016-01-01')
        issues.push(
          block(
            'ART306',
            `Mijlocul fix ${asset.number} a fost achiziționat înainte de 2016: ajustarea art. 306 nu este acoperită.`,
            'goods',
          ),
        );
      goods.push({
        assetId: asset.id,
        number: asset.number,
        name: asset.name,
        immovable: immovableAsset(asset),
        acquiredOn,
        vatBani: entries.reduce((sum, entry) => sum + entry.taxBani, 0n),
        deductedBani: entries.reduce((sum, entry) => sum + entry.deductibleBani, 0n),
      });
    }
    if (issues.some((issue) => issue.severity === 'block') || !rule)
      return { effect: null, issues };
    const adjustments = goods.map((good) =>
      capitalGoodAdjustment(good, input.event, input.date, rule),
    );
    const total = adjustments.reduce((sum, item) => sum + item.bani, 0n);
    if (total === 0n)
      return {
        effect: null,
        issues: [
          ...issues,
          block(
            'NOTHING',
            'Niciun bun de capital nu are taxă de ajustat pentru perioada rămasă: nu se înregistrează nimic.',
          ),
        ],
      };
    const taxPeriod = vatPeriodOf(loaded, taxPoint);
    const lines: LineSpec[] =
      total < 0n
        ? [
            { account: rule.expense, side: 'D', bani: -total },
            { account: '4426', side: 'C', bani: -total },
          ]
        : [
            { account: '4426', side: 'D', bani: total },
            { account: rule.income, side: 'C', bani: total },
          ];
    const taxEntries: TaxEntrySpec[] = [
      {
        key: 'vat',
        tax: 'VAT',
        code: regimeCodes.capitalGoods,
        direction: 'input',
        baseBani: 0n,
        taxBani: total,
        deductibleBani: total,
        ledgerBani: total,
        line: total < 0n ? 1 : 0,
        taxPoint,
        exigibility: taxPoint,
        taxPeriod,
        attributes: { event: input.event, change: input.date, goods: String(goods.length) },
      },
    ];
    const effect: Effect = {
      schema: 'effect@1',
      date: input.postingDate,
      journalClass: 'general',
      journalCode: 'TVA',
      description: `Ajustarea TVA pentru bunurile de capital la ${input.event === 'registration' ? 'înregistrarea' : 'anularea înregistrării'} în scopuri de TVA (${input.date})`,
      lines,
      openItems: [],
      taxEntries,
      schedules: [],
      explanation: {
        summary: `Ajustare ${lei(total < 0n ? -total : total)} lei ${total < 0n ? 'în favoarea bugetului, în ultimul decont' : 'în favoarea firmei, în primul decont după înregistrare'} (${taxPeriod}, rd. 34; art. 305 alin. (5) lit. ${input.event === 'deregistration' ? 'a' : 'c'})).`,
        details: { event: input.event, date: input.date, lines: adjustments.map((a) => a.line) },
      },
    };
    return { effect, issues };
  },
};
