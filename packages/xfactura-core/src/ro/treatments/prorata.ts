import { z } from 'zod';
import {
  profileAt,
  vatPeriodOf,
  type Effect,
  type Issue,
  type LineSpec,
  type Loaded,
  type TaxEntrySpec,
  type TaxLedgerEntry,
  type Treatment,
} from '../../kernel';
import { formatMoney, parseMoney } from '../../money';
import { questionIssue } from '../../questions/kinds';
import { RuleGapError, type RuleContext } from '../../rules';
import { addDays, isLocalDate, parseLocalDate, type LocalDate } from '../../time';
import {
  accessoryBases,
  adjustmentCodes,
  definitiveProrata,
  exemptCodes,
  exemptWithDeduction,
  prorataAdjustments,
  prorataCapitalGoodAdjustment,
  prorataShare,
  provisionalProrata,
  type ExemptionBasisId,
  type MixedPurchases,
  type ProrataRule,
} from '../exempt';
import type { CapitalGoodsRule } from '../nonpayers/parameters';
import { immovableAsset, tangibleAsset } from '../nonpayers/regime';
import { invoiceKinds } from './invoices';
import { standingTaxEntries } from './ledger';

/*
 * The year-end adjustment of a taxable person with mixed operations (Codul fiscal art. 300 alin.
 * (8), (12), (14)–(15)): the definitive pro-rata of the year from the supplies its books hold, the
 * VAT of the year's purchases for both kinds of operations deducted again at it, less what the
 * provisional pro-rata deducted, and the yearly adjustment of capital goods deducted under the
 * pro-rata of an earlier year; booked in the year's last return (D300 rd. 34).
 */

const block = (code: string, message: string, path?: string): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
});
const warn = (code: string, message: string): Issue => ({ code, severity: 'ack', message });
const lei = (bani: bigint) => formatMoney(bani, 'RON');
const day = z
  .string()
  .refine((value): boolean => isLocalDate(value))
  .transform((value) => parseLocalDate(value));
const amount = z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/);
const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/);

/** Every VAT period of a year, monthly and quarterly: a booking's period followed the
 * `vat.period` fact at the time. */
export const yearPeriods = (year: number) => [
  ...Array.from({ length: 12 }, (_, month) => `${year}-${String(month + 1).padStart(2, '0')}`),
  ...[1, 2, 3, 4].map((quarter) => `${year}-Q${quarter}`),
];
const ledgerOf = (loaded: Loaded, periods: readonly string[]) =>
  periods.flatMap((item) => loaded.taxLedger.get(`VAT|${item}`)?.entries ?? []);

function param<T>(
  rules: RuleContext,
  key: string,
  date: LocalDate,
  issues: Issue[],
): T | undefined {
  try {
    return rules.param<T>(key, 'vat_chargeability_date', date);
  } catch (error) {
    if (!(error instanceof RuleGapError)) throw error;
    issues.push(block('RULE_GAP', error.message));
    return undefined;
  }
}

export const prorataInput = z
  .object({
    year: z.number().int().min(2016).max(2100),
    /** The posting date: in the year's last VAT period, or in the last return before a
     * cancellation of the registration in the year (art. 300 alin. (14) lit. b)). */
    date: day,
    /** The document presenting the computation, attached to the return (alin. (8)). */
    evidenceId: z.uuid(),
    /** The year's exempt supplies of financial or real-estate operations left out of the
     * computation as accessory to the main activity (alin. (7) lit. c); norme pct. 70 alin.
     * (3)–(4)), with the analysis that shows the three conditions. */
    accessory: z.array(z.uuid()).max(500).default([]),
    accessoryEvidenceId: z.uuid().optional(),
    /** Sums from the state or local budgets financing exempt or out-of-scope operations, in lei
     * (alin. (6) lit. b), last sentence), with the decision granting them. */
    subsidies: amount.default('0'),
    subsidiesEvidenceId: z.uuid().optional(),
    /** Every capital good held at the year's end and acquired in an earlier year of its
     * adjustment period, with its acquisition invoice and the VAT period it was booked in: those
     * deducted under a pro-rata are adjusted to this year's (alin. (15)). */
    goods: z
      .array(z.object({ assetId: z.uuid(), documentId: z.uuid(), taxPeriod: period }).strict())
      .max(500)
      .default([]),
  })
  .strict()
  .refine((input) => input.accessory.length === 0 || input.accessoryEvidenceId !== undefined, {
    message: 'Atașați analiza care arată că operațiunile sunt accesorii (norme pct. 70 alin. (4)).',
    path: ['accessoryEvidenceId'],
  })
  .refine((input) => input.subsidies === '0' || input.subsidiesEvidenceId !== undefined, {
    message: 'Atașați decizia de acordare a sumelor de la buget.',
    path: ['subsidiesEvidenceId'],
  });
export type ProrataInput = z.infer<typeof prorataInput>;

/** The day a cancellation of the registration recorded in the year takes effect, if any. */
function cancellationIn(loaded: Loaded, year: number): LocalDate | null {
  const found = loaded.profile.find(
    (fact) =>
      fact.axis === 'vat.status' &&
      fact.value === 'non_vat' &&
      fact.effectiveFrom.startsWith(String(year)) &&
      profileAt(loaded, 'vat.status', addDays(fact.effectiveFrom, -1)) === 'normal_vat',
  );
  return found?.effectiveFrom ?? null;
}

/** What the year's supplies and purchases hold, from its tax ledger. */
export interface ProrataYear {
  supplies: { withDeduction: bigint; withoutDeduction: bigint; excluded: bigint; abroad: bigint };
  purchases: MixedPurchases[];
  /** The exempt supplies without the right of deduction of each document, for the accessory. */
  exemptDocuments: Map<string, { bani: bigint; basis: string | undefined; number: string }>;
}

/**
 * The year's supplies by their right of deduction (alin. (6)) and its purchases for both kinds of
 * operations, from the tax entries whose tax point is in the year: taxable (S-…, and TI-L under
 * the domestic reverse charge), exempt with the
 * right of deduction (EX-294, EX-EXPORT, EX-IC) and abroad (EXP-…) in the numerator; exempt
 * without it (EX-292) in the denominator only, the accessory ones left out (alin. (7) lit. c)). A
 * release of VAT on collection is no operation; the invoice counts at its general-rule tax point
 * (alin. (19)).
 */
export function prorataYear(
  entries: readonly TaxLedgerEntry[],
  year: number,
  accessory: ReadonlySet<string>,
): ProrataYear {
  const supplies = { withDeduction: 0n, withoutDeduction: 0n, excluded: 0n, abroad: 0n };
  const purchases = new Map<string, MixedPurchases>();
  const exemptDocuments = new Map<
    string,
    { bani: bigint; basis: string | undefined; number: string }
  >();
  const seen = new Set<string>();
  for (const entry of entries) {
    // A month and its quarter may both be read: each entry once.
    const id = `${entry.entryId}|${entry.taxNo}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (!entry.taxPoint.startsWith(String(year)) || entry.attributes.release) continue;
    // A storno of another year's supply or purchase (`correctsTaxPeriod`, ledger.reverse) is that
    // year's: it neither counts in this year's supplies nor takes this year's definitive pro-rata
    // (as a credit note across years would not, PRORATA_CREDIT_YEAR).
    const corrects = entry.attributes.correctsTaxPeriod;
    if (corrects && !corrects.startsWith(String(year))) continue;
    if (entry.direction === 'output') {
      // Taxable supplies, the domestic reverse charge's supplies (TI-L, art. 331) among them.
      if (
        entry.code.startsWith('S-') ||
        entry.code === 'TI-L' ||
        exemptWithDeduction.includes(entry.code)
      )
        supplies.withDeduction += entry.baseBani;
      else if (entry.code.startsWith('EXP-')) {
        supplies.withDeduction += entry.baseBani;
        supplies.abroad += entry.baseBani;
      } else if (entry.code === exemptCodes.noDeduction) {
        if (entry.documentId) {
          const found = exemptDocuments.get(entry.documentId) ?? {
            bani: 0n,
            basis: entry.attributes.exemption,
            number: entry.attributes.number ?? entry.documentId,
          };
          found.bani += entry.baseBani;
          exemptDocuments.set(entry.documentId, found);
        }
        if (entry.documentId && accessory.has(entry.documentId))
          supplies.excluded += entry.baseBani;
        else supplies.withoutDeduction += entry.baseBani;
      }
      continue;
    }
    if (entry.attributes.prorata === undefined) continue;
    const group = purchases.get(entry.code) ?? { code: entry.code, vatBani: 0n, deductedBani: 0n };
    group.vatBani += BigInt(entry.attributes.prorataTax ?? '0');
    group.deductedBani += BigInt(entry.attributes.prorataDeducted ?? '0');
    purchases.set(entry.code, group);
  }
  return {
    supplies,
    purchases: [...purchases.values()].sort((a, b) => a.code.localeCompare(b.code)),
    exemptDocuments,
  };
}

/**
 * The year-end adjustment to the definitive pro-rata (`vat.proRata`): booked in the year's last
 * VAT period, Dr 4426 / Cr 7588 when the definitive deducts more, Dr 635 / Cr 4426 when less
 * (`ro.vat.prorata`), tax entries ADJ-300 by VAT code, D300 rd. 34.
 */
export const prorataAdjustment: Treatment<ProrataInput> = {
  id: 'vat.proRata',
  version: 1,
  description:
    'Ajustarea de la sfârșitul anului a taxei deduse pe bază de pro rata provizorie, la pro rata definitivă a anului (art. 300 alin. (8), (14)–(15) din Codul fiscal), înscrisă în decontul ultimei perioade fiscale a anului.',
  input: prorataInput,
  agent: true,
  summary:
    "Adjusts at year end the VAT a company with mixed operations deducted under its provisional pro-rata to the year's definitive pro-rata, in the year's last VAT return.",
  toolset: 'tax',
  dataClasses: ['books', 'tax'],
  subject: (input) => `vat.proRata:${input.year}`,
  plan: (input) => ({
    evidence: [
      input.evidenceId,
      ...(input.accessoryEvidenceId ? [input.accessoryEvidenceId] : []),
      ...(input.subsidiesEvidenceId ? [input.subsidiesEvidenceId] : []),
    ],
    profile: true,
    documents: input.accessory,
    ...(input.goods.length ? { assets: true } : {}),
    taxPeriods: [
      ...new Set([
        ...yearPeriods(input.year),
        // Each good's acquisition period and its year's last periods, where the definitive
        // pro-rata of that year was booked.
        ...input.goods.flatMap((good) => [
          good.taxPeriod,
          `${good.taxPeriod.slice(0, 4)}-12`,
          `${good.taxPeriod.slice(0, 4)}-Q4`,
        ]),
      ]),
    ].map((item) => ({ tax: 'VAT', period: item })),
  }),
  evaluate(input, loaded, rules) {
    const issues: Issue[] = [];
    for (const id of [input.evidenceId, input.accessoryEvidenceId, input.subsidiesEvidenceId])
      if (id && !loaded.evidence.has(id))
        issues.push(block('EVIDENCE', 'Documentul justificativ nu este disponibil.', 'evidenceId'));
    const yearEnd = `${input.year}-12-31` as LocalDate;
    const cancelled = cancellationIn(loaded, input.year);
    const lastDay = cancelled ? addDays(cancelled, -1) : yearEnd;
    if (!input.date.startsWith(String(input.year)))
      issues.push(block('DATE', `Ajustarea se înregistrează în anul ${input.year}.`, 'date'));
    else if (vatPeriodOf(loaded, input.date) !== vatPeriodOf(loaded, lastDay))
      issues.push(
        block(
          'DATE',
          `Ajustarea se înscrie în decontul ultimei perioade fiscale a anului (${vatPeriodOf(loaded, lastDay)}${cancelled ? `, ultima înainte de anularea înregistrării din ${cancelled}` : ''}), art. 300 alin. (14) lit. b) din Codul fiscal.`,
          'date',
        ),
      );
    if (
      profileAt(loaded, 'vat.status', input.date > lastDay ? lastDay : input.date) !== 'normal_vat'
    )
      issues.push(
        block(
          'NOT_VAT_PAYER',
          'Pro rata o aplică persoanele înregistrate în scopuri de TVA.',
          'date',
        ),
      );
    const rule = param<ProrataRule>(rules, 'ro.vat.prorata', input.date, issues);
    const provisional = provisionalProrata(loaded.profile, lastDay);
    if (!provisional.found)
      issues.push(
        questionIssue(
          'PRORATA_MISSING',
          `Pro rata provizorie a anului ${input.year} nu este înregistrată (vat.prorata): ea se comunică organului fiscal până la 25 ianuarie (art. 300 alin. (9) din Codul fiscal).`,
          {
            kind: 'profile.fact',
            subject: { kind: 'profile', id: `vat.prorata/${input.year}` },
            params: { axis: 'vat.prorata', from: `${input.year}-01-01` },
          },
        ),
      );
    else if (provisional.fact.kind === 'special')
      issues.push(
        block(
          'PRORATA_SPECIAL',
          'Pro rata specială aprobată sau impusă de Ministerul Finanțelor (art. 300 alin. (16)–(18)) se calculează pe sectoare sau pe operațiunile deciziei: nu este încă acoperită.',
        ),
      );
    else if (provisional.fact.kind === 'opted_out')
      issues.push(
        block(
          'PRORATA_OPTED_OUT',
          'Compania a optat să nu deducă TVA aferentă achizițiilor destinate ambelor feluri de operațiuni (art. 300 alin. (20)): nu se ajustează nimic.',
        ),
      );
    const accessory = new Set(input.accessory);
    const year = prorataYear(ledgerOf(loaded, yearPeriods(input.year)), input.year, accessory);
    for (const id of input.accessory) {
      const record = loaded.documents.get(id);
      const found = year.exemptDocuments.get(id);
      if (!record || record.kind !== invoiceKinds.sale || !found)
        issues.push(
          block(
            'ACCESSORY',
            'Documentul indicat nu este o vânzare scutită fără drept de deducere din anul ajustării.',
            'accessory',
          ),
        );
      else if (!(accessoryBases as readonly string[]).includes(found.basis ?? ''))
        issues.push(
          block(
            'ACCESSORY',
            `Factura ${found.number} (${found.basis ?? 'fără temei'}) nu este o operațiune financiar-bancară sau imobiliară: doar acestea se exclud din calcul când sunt accesorii (art. 300 alin. (7) lit. c) din Codul fiscal).`,
            'accessory',
          ),
        );
    }
    if (input.accessory.length)
      issues.push(
        warn(
          'PRORATA_ACCESSORY',
          `Operațiunile excluse ca accesorii (${lei(year.supplies.excluded)} lei) îndeplinesc cumulativ condițiile normelor pct. 70 alin. (4): resurse tehnice și personal limitate, nelegate direct de activitatea principală, achiziții și TVA aferente nesemnificative. Confirmați.`,
        ),
      );
    if (year.supplies.abroad !== 0n)
      issues.push(
        warn(
          'PRORATA_ABROAD',
          `Operațiunile cu locul în străinătate (${lei(year.supplies.abroad)} lei) sunt la numărător: dau drept de deducere dacă ar fi taxabile în România (art. 297 alin. (4) lit. b) din Codul fiscal). Confirmați că nu sunt operațiuni care ar fi scutite.`,
        ),
      );
    const subsidies = parseMoney(input.subsidies, 'RON');
    const definitive = definitiveProrata({
      withDeduction: year.supplies.withDeduction,
      withoutDeduction: year.supplies.withoutDeduction,
      subsidies,
      excluded: year.supplies.excluded,
    });
    if (!definitive)
      issues.push(
        block(
          'PRORATA_NO_SUPPLIES',
          `Anul ${input.year} nu are livrări sau prestări: pro rata estimată se regularizează la sfârșitul primului an cu livrări (art. 300 alin. (10) lit. d) și alin. (13)), ceea ce nu este încă acoperit.`,
        ),
      );

    // Capital goods of earlier years deducted under a pro-rata (alin. (15)).
    const capital = param<CapitalGoodsRule>(rules, 'ro.vat.capital_goods', input.date, issues);
    const listed = new Map(input.goods.map((good) => [good.assetId, good]));
    if (input.goods.length)
      for (const asset of loaded.assets.values()) {
        if (!tangibleAsset(asset.account)) continue;
        const held =
          asset.commissionedOn < `${input.year}-01-01` &&
          (asset.disposedOn === null || asset.disposedOn > yearEnd);
        if (held && !listed.has(asset.id) && capital) {
          const years = immovableAsset(asset) ? capital.immovable : capital.movable;
          if (Number(asset.commissionedOn.slice(0, 4)) + years > input.year)
            issues.push(
              block(
                'CAPITAL_GOOD_UNLISTED',
                `Mijlocul fix ${asset.number} ${asset.name} este în perioada de ajustare: indicați-l cu factura de achiziție (goods), ca să se vadă dacă s-a dedus pe bază de pro rata.`,
                'goods',
              ),
            );
        }
      }
    const goodAdjustments: { code: string; bani: bigint; line: string; assetId: string }[] = [];
    for (const good of input.goods) {
      const asset = loaded.assets.get(good.assetId);
      if (!asset || !tangibleAsset(asset.account)) {
        issues.push(
          block('ASSET', 'Mijlocul fix nu este un activ corporal din registru.', 'goods'),
        );
        continue;
      }
      const acquisition = (loaded.taxLedger.get(`VAT|${good.taxPeriod}`)?.entries ?? []).filter(
        (entry) =>
          entry.direction === 'input' &&
          entry.documentId === good.documentId &&
          entry.code.startsWith('S-'),
      );
      if (!acquisition.length) {
        issues.push(
          block(
            'ASSET_VAT',
            `Factura de achiziție a mijlocului fix ${asset.number} nu are TVA în perioada ${good.taxPeriod}.`,
            'goods',
          ),
        );
        continue;
      }
      const acquiredYear = Number(acquisition[0]!.taxPoint.slice(0, 4));
      if (acquiredYear >= input.year) {
        issues.push(
          block(
            'ASSET_YEAR',
            `Mijlocul fix ${asset.number} este achiziționat în ${acquiredYear}: ajustarea anului o cuprinde (art. 300 alin. (14)); goods ține doar bunurile din anii anteriori.`,
            'goods',
          ),
        );
        continue;
      }
      const mixed = acquisition.filter((entry) => entry.attributes.prorata !== undefined);
      if (!mixed.length) continue; // allocated directly: art. 305 alin. (4) lit. a)'s, not here
      const vat = mixed.reduce(
        (sum, entry) => sum + BigInt(entry.attributes.prorataTax ?? '0'),
        0n,
      );
      // The deduction at the definitive pro-rata of the acquisition's year, as its adjustment
      // that stands recorded it.
      const booked = [`${acquiredYear}-12`, `${acquiredYear}-Q4`]
        .flatMap((item) => standingTaxEntries(loaded.taxLedger.get(`VAT|${item}`)?.entries ?? []))
        .filter(
          (entry) =>
            entry.code === adjustmentCodes.prorata &&
            entry.attributes.year === String(acquiredYear),
        )
        .at(-1);
      if (!booked?.attributes.definitive) {
        issues.push(
          block(
            'PRORATA_GOOD_HISTORY',
            `Pro rata definitivă a anului ${acquiredYear}, în care s-a achiziționat ${asset.number}, nu este înregistrată în registre (vat.proRata ${acquiredYear}).`,
            'goods',
          ),
        );
        continue;
      }
      const years = immovableAsset(asset) ? capital?.immovable : capital?.movable;
      if (!years || acquiredYear + years <= input.year) continue;
      if (!definitive) continue;
      const adjustment = prorataCapitalGoodAdjustment(
        {
          assetId: asset.id,
          number: asset.number,
          vatBani: vat,
          deductedBani: prorataShare(vat, Number(booked.attributes.definitive)),
          years,
        },
        definitive.percent,
      );
      goodAdjustments.push({ code: mixed[0]!.code, ...adjustment });
    }
    if (
      issues.some((issue) => issue.severity === 'block') ||
      !rule ||
      !definitive ||
      !provisional.found ||
      provisional.fact.kind !== 'percent'
    )
      return { effect: null, issues };

    const adjustments = prorataAdjustments(year.purchases, definitive.percent);
    const byCode = new Map<string, bigint>();
    for (const item of [...adjustments, ...goodAdjustments])
      byCode.set(item.code, (byCode.get(item.code) ?? 0n) + item.bani);
    const total = [...byCode.values()].reduce((sum, value) => sum + value, 0n);
    if ([...byCode.values()].every((value) => value === 0n))
      return {
        effect: null,
        issues: [
          ...issues,
          block(
            'NOTHING',
            `Pro rata definitivă a anului ${input.year} este ${definitive.percent}% (provizorie ${provisional.fact.percent}%): nu este nimic de ajustat.`,
          ),
        ],
      };
    const taxPeriod = vatPeriodOf(loaded, input.date);
    const lines: LineSpec[] = [];
    const taxEntries: TaxEntrySpec[] = [];
    for (const [code, bani] of [...byCode].sort(([a], [b]) => a.localeCompare(b))) {
      if (bani === 0n) continue;
      if (bani > 0n) {
        lines.push({ account: '4426', side: 'D', bani });
        lines.push({ account: rule.income, side: 'C', bani });
      } else {
        lines.push({ account: rule.expense, side: 'D', bani: -bani });
        lines.push({ account: '4426', side: 'C', bani: -bani });
      }
      taxEntries.push({
        key: `vat:${code}`,
        tax: 'VAT',
        code: adjustmentCodes.prorata,
        direction: 'input',
        baseBani: 0n,
        taxBani: bani,
        deductibleBani: bani,
        ledgerBani: bani,
        line: bani > 0n ? lines.length - 2 : lines.length - 1,
        taxPoint: input.date,
        exigibility: input.date,
        taxPeriod,
        attributes: {
          year: String(input.year),
          provisional: String(provisional.fact.percent),
          definitive: String(definitive.percent),
          rate: code.replace(/^S-/, ''),
        },
      });
    }
    const effect: Effect = {
      schema: 'effect@1',
      date: input.date,
      journalClass: 'general',
      journalCode: 'TVA',
      description: `Ajustarea TVA deduse la pro rata definitivă a anului ${input.year} (${definitive.percent}%)`,
      lines,
      openItems: [],
      taxEntries,
      schedules: [],
      explanation: {
        summary: `Pro rata definitivă ${definitive.percent}% (provizorie ${provisional.fact.percent}%): ajustare ${lei(total < 0n ? -total : total)} lei ${total < 0n ? 'în favoarea bugetului' : 'în favoarea firmei'}, decontul ${taxPeriod}, rd. 34 (art. 300 alin. (14) din Codul fiscal).`,
        details: {
          year: input.year,
          provisional: provisional.fact.percent,
          definitive: {
            percent: definitive.percent,
            exact: definitive.exact,
            numerator: lei(definitive.numerator),
            denominator: lei(definitive.denominator),
          },
          lines: [
            ...definitive.lines,
            ...adjustments.map((item) => item.line),
            ...goodAdjustments.map((item) => item.line),
          ],
          accessory: input.accessory,
        },
      },
    };
    return { effect, issues };
  },
};

/** The bases an accessory supply may have (art. 300 alin. (7) lit. c)). */
export const prorataAccessoryBases: readonly ExemptionBasisId[] = accessoryBases;
