import { and, asc, eq, gte, inArray, like, lte, notLike, sql } from 'drizzle-orm';
import { z } from 'zod';
import { profileAt, vatPeriodOf } from 'xfactura-core/kernel';
import { formatMoney, parseMoney } from 'xfactura-core/money';
import { questionKinds } from 'xfactura-core/questions/kinds';
import {
  adjustmentCodes,
  definitiveProrata,
  exemptCodes,
  initialShare,
  percentOf,
  periodOf,
  prorataAdjustments,
  provisionalProrata,
  shareOf,
} from 'xfactura-core/ro/exempt';
import { immovableAsset, tangibleAsset, type CapitalGoodsRule } from 'xfactura-core/ro/nonpayers';
import { standingTaxEntries } from 'xfactura-core/ro/treatments/ledger';
import { prorataYear, yearPeriods } from 'xfactura-core/ro/treatments/prorata';
import { regimeCodes } from 'xfactura-core/ro/treatments/vat-registration';
import { RuleGapError, type RuleContext } from 'xfactura-core/rules';
import { bucharestDate, type LocalDate } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import { assets, entries, questions, taxEntries } from '../db/schema';
import type { Actor, Commands } from '../kernel/commands';
import { entryStands } from '../kernel/ledger';
import { loadState } from '../kernel/state';
import type { VatAdjustmentWorkItem, WorkStep } from '../kernel/work';
import { causeFromFact, idLabel, periodLabel, textLabel } from '../kernel/work-names';
import { standing } from './questions';

/*
 * The pro-rata and the capital goods' register, computed on read (docs/ACCOUNTING_ENGINE.md,
 * "Exempt supplies, the pro-rata and capital goods"): the provisional pro-rata of a year and the
 * definitive one its books give, with the year-end adjustment `vat.proRata` books; each capital
 * good's VAT, deduction, adjustment period, current use and adjustments, as norme pct. 79 alin.
 * (2) asks the register to hold; and what the worklist waits on.
 */

const money = (bani: bigint) => formatMoney(bani, 'RON');
const amount = z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/);
const step = (operation: string, by: 'agent' | 'human', inputHint: WorkStep['inputHint'] = {}) =>
  ({ operation, by, inputHint }) satisfies WorkStep;

export const prorataComputeInput = z
  .object({
    year: z.number().int().min(2016).max(2100),
    /** The year's exempt supplies left out as accessory (art. 300 alin. (7) lit. c)). */
    accessory: z.array(z.uuid()).max(500).default([]),
    /** Budget sums financing exempt or out-of-scope operations, in lei (alin. (6) lit. b)). */
    subsidies: amount.default('0'),
  })
  .strict();

export const prorataComputeView = z.object({
  year: z.number(),
  /** Whether the year's books hold supplies exempt without the right of deduction. */
  mixed: z.boolean(),
  provisional: z.object({
    state: z.enum(['recorded', 'missing', 'earlier_year', 'special', 'opted_out', 'invalid']),
    percent: z.number().nullable(),
    from: z.string().nullable(),
  }),
  supplies: z.object({
    withDeduction: z.string(),
    withoutDeduction: z.string(),
    excluded: z.string(),
    abroad: z.string(),
    subsidies: z.string(),
  }),
  definitive: z.object({ percent: z.number(), exact: z.string() }).nullable(),
  purchases: z.array(
    z.object({
      code: z.string(),
      vat: z.string(),
      deducted: z.string(),
      definitive: z.string(),
      adjustment: z.string(),
    }),
  ),
  adjustment: z.string().nullable(),
  /** The adjustment booked for the year, if one stands. */
  posted: z.object({ definitive: z.string(), adjustment: z.string() }).nullable(),
  /** The last VAT period of the year, where the adjustment goes. */
  period: z.string(),
  lines: z.array(z.string()),
});

/** The year's pro-rata as its books and facts give it. */
export async function prorataOf(
  tx: Transaction,
  companyId: string,
  input: z.infer<typeof prorataComputeInput>,
  rules: RuleContext,
): Promise<z.infer<typeof prorataComputeView>> {
  const { loaded } = await loadState(tx, companyId, {
    profile: true,
    taxPeriods: yearPeriods(input.year).map((period) => ({ tax: 'VAT', period })),
  });
  const entries = yearPeriods(input.year).flatMap(
    (period) => loaded.taxLedger.get(`VAT|${period}`)?.entries ?? [],
  );
  const year = prorataYear(entries, input.year, new Set(input.accessory));
  const subsidies = parseMoney(input.subsidies, 'RON');
  const definitive = definitiveProrata({ ...year.supplies, subsidies });
  const end = `${input.year}-12-31` as LocalDate;
  const provisional = provisionalProrata(loaded.profile, end);
  const lines: string[] = [];
  const state = provisional.found
    ? provisional.fact.kind === 'percent'
      ? 'recorded'
      : provisional.fact.kind
    : provisional.reason === 'none'
      ? 'missing'
      : provisional.reason;
  const percent =
    provisional.found && provisional.fact.kind === 'percent' ? provisional.fact.percent : null;
  lines.push(
    percent !== null
      ? `Pro rata provizorie ${input.year}: ${percent}%, de la ${provisional.found ? provisional.from : ''} (art. 300 alin. (9)–(10)).`
      : `Pro rata provizorie ${input.year} nu este înregistrată ca procent (vat.prorata: ${state}).`,
  );
  if (definitive) lines.push(...definitive.lines);
  else
    lines.push(
      `Anul ${input.year} nu are livrări sau prestări: pro rata definitivă nu se poate calcula.`,
    );
  const adjustments = definitive ? prorataAdjustments(year.purchases, definitive.percent) : [];
  lines.push(...adjustments.map((item) => item.line));
  const total = adjustments.reduce((sum, item) => sum + item.bani, 0n);
  // The adjustment that stands: neither a storno nor stornoed in the year.
  const booked = standingTaxEntries(entries).filter(
    (entry) =>
      entry.code === adjustmentCodes.prorata && entry.attributes.year === String(input.year),
  );
  let rule: unknown = null;
  try {
    rule = rules.param('ro.vat.prorata', 'vat_chargeability_date', end);
  } catch (error) {
    if (!(error instanceof RuleGapError)) throw error;
    lines.push(`ro.vat.prorata: ${error.message}`);
  }
  if (rule && definitive)
    lines.push(
      `Ajustarea anului: ${money(total)} lei, în decontul ${vatPeriodOf(loaded, end)} (rd. 34), cu vat.proRata; pro rata definitivă devine pro rata provizorie a anului ${input.year + 1}, dacă ponderea operațiunilor nu se schimbă (art. 300 alin. (9)).`,
    );
  return {
    year: input.year,
    mixed: year.supplies.withoutDeduction + year.supplies.excluded !== 0n,
    provisional: { state, percent, from: provisional.from },
    supplies: {
      withDeduction: money(year.supplies.withDeduction),
      withoutDeduction: money(year.supplies.withoutDeduction),
      excluded: money(year.supplies.excluded),
      abroad: money(year.supplies.abroad),
      subsidies: money(subsidies),
    },
    definitive: definitive ? { percent: definitive.percent, exact: definitive.exact } : null,
    purchases: adjustments.map((item) => ({
      code: item.code,
      vat: money(year.purchases.find((group) => group.code === item.code)!.vatBani),
      deducted: money(item.deductedBani),
      definitive: money(item.definitiveBani),
      adjustment: money(item.bani),
    })),
    adjustment: definitive ? money(total) : null,
    posted: booked.length
      ? {
          definitive: booked[0]!.attributes.definitive ?? '',
          adjustment: money(booked.reduce((sum, entry) => sum + entry.deductibleBani, 0n)),
        }
      : null,
    period: vatPeriodOf(loaded, end),
    lines,
  };
}

export const capitalRegisterInput = z
  .object({
    /** The register as on a date; today's by default. */
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .strict();

const registerGood = z.object({
  assetId: z.string(),
  number: z.string(),
  name: z.string(),
  account: z.string(),
  /** The acquisition invoice and the VAT period its entries are in. */
  documentId: z.string().nullable(),
  taxPeriod: z.string().nullable(),
  /** Norme pct. 79 alin. (2) lit. a)–e). */
  acquiredOn: z.string().nullable(),
  base: z.string().nullable(),
  vat: z.string().nullable(),
  deducted: z.string().nullable(),
  /** The adjustment period's years and calendar span. */
  years: z.number().nullable(),
  period: z.string().nullable(),
  /** Deducted under a pro-rata (adjusted by vat.proRata). */
  prorata: z.boolean(),
  /** The share of use with the right of deduction: the initial deduction's, and the latest
   * answer's (capitalGood.use) with its date. */
  initialShare: z.string().nullable(),
  use: z.object({ share: z.string(), from: z.string(), questionId: z.string() }).nullable(),
  adjustments: z.array(
    z.object({ year: z.string(), event: z.string(), date: z.string(), amount: z.string() }),
  ),
  state: z.enum(['adjusting', 'unchanged', 'expired', 'no_vat', 'disposed']),
});
export const capitalRegisterView = z.object({
  date: z.string(),
  goods: z.array(registerGood),
});

/**
 * The register of capital goods (norme pct. 79 alin. (2)): each tangible fixed asset (21x) with
 * its acquisition's date, base, VAT and deduction from the invoice's tax entries, its adjustment
 * period (5 or 20 years, art. 305 alin. (2)–(3)), the use a person stated (capitalGood.use) and
 * the adjustments posted (ADJ-305 entries naming it).
 */
export async function capitalRegisterOf(
  tx: Transaction,
  companyId: string,
  date: LocalDate,
  rules: RuleContext,
): Promise<z.infer<typeof capitalRegisterView>> {
  const { loaded } = await loadState(tx, companyId, { assets: true });
  let rule: CapitalGoodsRule | null = null;
  try {
    rule = rules.param<CapitalGoodsRule>('ro.vat.capital_goods', 'vat_chargeability_date', date);
  } catch (error) {
    if (!(error instanceof RuleGapError)) throw error;
  }
  const cards = await tx
    .select({ id: assets.id, documentId: assets.documentId })
    .from(assets)
    .where(eq(assets.companyId, companyId));
  const documentOf = new Map(cards.map((card) => [card.id, card.documentId]));
  const goods: z.infer<typeof registerGood>[] = [];
  for (const asset of [...loaded.assets.values()].sort((a, b) =>
    a.number.localeCompare(b.number),
  )) {
    if (!tangibleAsset(asset.account)) continue;
    const documentId = documentOf.get(asset.id) ?? null;
    const vat = documentId
      ? await tx
          .select()
          .from(taxEntries)
          .where(
            and(
              eq(taxEntries.companyId, companyId),
              eq(taxEntries.documentId, documentId),
              eq(taxEntries.direction, 'input'),
              like(taxEntries.code, 'S-%'),
            ),
          )
      : [];
    const adjustments = (
      await tx
        .select()
        .from(taxEntries)
        .where(
          and(eq(taxEntries.companyId, companyId), eq(taxEntries.code, regimeCodes.capitalGoods)),
        )
        .orderBy(asc(taxEntries.taxPoint))
    )
      .map((row) => ({ row, attributes: JSON.parse(row.attributes) as Record<string, string> }))
      .filter((item) => item.attributes.assetId === asset.id);
    const found = await standing(tx, companyId, {
      kind: 'capitalGood.use',
      subject: { kind: 'asset', id: asset.id },
      params: {},
    });
    const raw = found.answered?.answer?.value;
    const parsed = questionKinds['capitalGood.use']
      .answer({})
      .safeParse(typeof raw === 'string' ? JSON.parse(raw) : raw);
    const use =
      found.answered && parsed.success
        ? { share: parsed.data.share, from: parsed.data.from, questionId: found.answered.row.id }
        : null;
    const vatBani = vat.reduce((sum, row) => sum + row.taxBani, 0n);
    const deducted = vat.reduce((sum, row) => sum + row.deductibleBani, 0n);
    const acquiredOn = vat.map((row) => row.taxPoint).sort()[0] ?? null;
    const basis = acquiredOn
      ? {
          assetId: asset.id,
          number: asset.number,
          name: asset.name,
          immovable: immovableAsset(asset),
          acquiredOn: acquiredOn as LocalDate,
          vatBani,
          deductedBani: deducted,
        }
      : null;
    const period = basis && rule ? periodOf(basis, rule) : null;
    const initial = basis ? initialShare(basis) : null;
    const prorata = vat.some(
      (row) => (JSON.parse(row.attributes) as Record<string, string>).prorata !== undefined,
    );
    const year = Number(date.slice(0, 4));
    goods.push({
      assetId: asset.id,
      number: asset.number,
      name: asset.name,
      account: asset.account,
      documentId,
      taxPeriod: vat[0]?.taxPeriod ?? null,
      acquiredOn,
      base: vat.length ? money(vat.reduce((sum, row) => sum + row.baseBani, 0n)) : null,
      vat: vat.length ? money(vatBani) : null,
      deducted: vat.length ? money(deducted) : null,
      years: period?.years ?? null,
      period: period ? `${period.first}–${period.last}` : null,
      prorata,
      initialShare: initial === null ? null : percentOf(initial),
      use,
      adjustments: adjustments.map((item) => ({
        year: item.attributes.year ?? item.row.taxPoint.slice(0, 4),
        event: item.attributes.event ?? '',
        date: item.attributes.change ?? item.row.taxPoint,
        amount: money(item.row.deductibleBani),
      })),
      state:
        asset.disposedOn !== null && asset.disposedOn <= date
          ? 'disposed'
          : !vat.length
            ? 'no_vat'
            : period && year > period.last
              ? 'expired'
              : use && initial !== null && shareOf(use.share) !== initial
                ? 'adjusting'
                : 'unchanged',
    });
  }
  return { date, goods };
}

/**
 * What the worklist waits on, for the current year and the previous one:
 * - `vat.prorata`: supplies exempt without the right of deduction in a year without its
 *   provisional pro-rata (blocking), and a mixed year whose last month has come without the
 *   year-end adjustment (art. 300 alin. (14)), blocking once the year ended;
 * - `vat.capitalGoods`: a capital good whose stated use differs from its initial deduction, in a
 *   year of its period whose last month has come without the year's adjustment.
 */
export async function vatAdjustmentWork(
  tx: Transaction,
  companyId: string,
  today: LocalDate,
  rules: RuleContext,
): Promise<VatAdjustmentWorkItem[]> {
  const items: VatAdjustmentWorkItem[] = [];
  const current = Number(today.slice(0, 4));
  const { loaded } = await loadState(tx, companyId, { profile: true });
  for (const year of [current - 1, current]) {
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    if (profileAt(loaded, 'vat.status', to as LocalDate) !== 'normal_vat') continue;
    // Three indexed probes of the year's VAT periods, one row each.
    const inYear = and(
      eq(taxEntries.companyId, companyId),
      eq(taxEntries.tax, 'VAT'),
      inArray(taxEntries.taxPeriod, yearPeriods(year)),
      gte(taxEntries.taxPoint, from),
      lte(taxEntries.taxPoint, to),
    );
    const probe = async (condition: ReturnType<typeof and>) =>
      (await tx.select({ code: taxEntries.code }).from(taxEntries).where(condition).limit(1))
        .length > 0;
    const exempt = await probe(and(inYear, eq(taxEntries.code, exemptCodes.noDeduction)));
    const mixedPurchases = await probe(
      and(
        inYear,
        eq(taxEntries.direction, 'input'),
        sql`json_extract(${taxEntries.attributes}, '$.prorata') is not null`,
      ),
    );
    // The year's adjustment that stands: neither a storno nor stornoed.
    const adjusted =
      (
        await tx
          .select({ code: taxEntries.code })
          .from(taxEntries)
          .innerJoin(
            entries,
            and(eq(entries.companyId, taxEntries.companyId), eq(entries.id, taxEntries.entryId)),
          )
          .where(
            and(
              eq(taxEntries.companyId, companyId),
              eq(taxEntries.code, adjustmentCodes.prorata),
              inArray(taxEntries.taxPeriod, yearPeriods(year)),
              sql`json_extract(${taxEntries.attributes}, '$.year') = ${String(year)}`,
              notLike(taxEntries.key, 'reversal:%'),
              entryStands('"acc_entries"'),
            ),
          )
          .limit(1)
      ).length > 0;
    const provisional = provisionalProrata(loaded.profile, (today < to ? today : to) as LocalDate);
    if (exempt && !provisional.found) {
      const message = `În ${year} registrele au operațiuni scutite fără drept de deducere: compania are regim mixt și comunică pro rata provizorie (art. 300 alin. (9)–(10) din Codul fiscal); fără ea, achizițiile destinate ambelor feluri de operațiuni nu deduc TVA.`;
      items.push({
        kind: 'vat.prorata',
        subject: { kind: 'prorata', id: String(year) },
        severity: 'block',
        period: String(year),
        message,
        causes: [causeFromFact(`vat.prorata/${year}`, message)],
        details: { year, rule: 'ro.vat.prorata' },
        labels: { year: periodLabel('An'), rule: textLabel('Regulă') },
        next: [
          step('questions.ask', 'agent', {
            kind: 'profile.fact',
            subject: { kind: 'profile', id: `vat.prorata/${year}` },
            params: { axis: 'vat.prorata', from: `${year}-01-01` },
          }),
          step('vat.proRata.compute', 'agent', { year: year - 1 }),
          step('questions.answer', 'human'),
          // A person who knows the provisional pro-rata records it, from the year's start.
          step('profile.record', 'human', { axis: 'vat.prorata', effectiveFrom: `${year}-01-01` }),
        ],
      });
    }
    if ((exempt || mixedPurchases) && !adjusted && today >= `${year}-12-01`)
      items.push({
        kind: 'vat.prorata',
        subject: { kind: 'prorata', id: `${year}/definitive` },
        severity: today > to ? 'block' : 'warn',
        period: String(year),
        message: `Pro rata definitivă a anului ${year} și ajustarea taxei deduse cu pro rata provizorie se înscriu în decontul ultimei perioade fiscale a anului (art. 300 alin. (8), (14) din Codul fiscal).`,
        details: { year, rule: 'ro.vat.prorata' },
        labels: { year: periodLabel('An'), rule: textLabel('Regulă') },
        next: [
          step('vat.proRata.compute', 'agent', { year }),
          step('vat.proRata.propose', 'agent', { year, date: to }),
        ],
      });
  }

  // Capital goods whose stated use differs from the initial deduction.
  const asked = await tx
    .select({ subjectId: questions.subjectId })
    .from(questions)
    .where(
      and(
        eq(questions.companyId, companyId),
        eq(questions.kind, 'capitalGood.use'),
        eq(questions.subjectKind, 'asset'),
      ),
    );
  if (!asked.length) return items;
  const register = await capitalRegisterOf(tx, companyId, today, rules);
  for (const good of register.goods) {
    if (good.state !== 'adjusting' || !good.use || !good.period) continue;
    const [first, last] = good.period.split('–').map(Number) as [number, number];
    for (const year of [current - 1, current]) {
      if (year < first || year > last || today < `${year}-12-01`) continue;
      if (Number(good.use.from.slice(0, 4)) > year) continue;
      if (good.adjustments.some((item) => item.year === String(year))) continue;
      items.push({
        kind: 'vat.capitalGoods',
        subject: { kind: 'asset', id: `${good.assetId}/${year}` },
        severity: today > `${year}-12-31` ? 'block' : 'warn',
        period: String(year),
        message: `${good.number} ${good.name} este folosit ${good.use.share}% pentru operațiuni cu drept de deducere (de la ${good.use.from}), față de deducerea inițială (${good.initialShare}): ajustarea anului ${year} se înscrie în decontul ultimei perioade fiscale a anului (art. 305 alin. (5), norme pct. 79 alin. (1)).`,
        details: { assetId: good.assetId, year, rule: 'ro.vat.capital_goods' },
        labels: {
          assetId: idLabel('Mijloc fix', 'asset'),
          year: periodLabel('An'),
          rule: textLabel('Regulă'),
        },
        next: [
          step('vat.capitalGoods.register', 'agent'),
          step('vat.capitalGoods.propose', 'agent', {
            event: 'year',
            date: `${year}-12-31`,
            goods: [
              { assetId: good.assetId, documentId: good.documentId, taxPeriod: good.taxPeriod },
            ],
          }),
        ],
      });
    }
  }
  return items;
}

/** The pro-rata and the capital goods' register, read by people and agents. */
export class VatAdjustments {
  constructor(
    private readonly commands: Commands,
    private readonly rules: (tx: Transaction, companyId: string) => Promise<RuleContext>,
    private readonly clock: () => number = Date.now,
  ) {}

  prorata(actor: Actor, input: z.infer<typeof prorataComputeInput>) {
    return this.commands.read(actor, 'vat.proRata.compute', async (tx) =>
      prorataOf(tx, actor.companyId, input, await this.rules(tx, actor.companyId)),
    );
  }

  register(actor: Actor, input: z.infer<typeof capitalRegisterInput>) {
    return this.commands.read(actor, 'vat.capitalGoods.register', async (tx) =>
      capitalRegisterOf(
        tx,
        actor.companyId,
        (input.date ?? bucharestDate(this.clock())) as LocalDate,
        await this.rules(tx, actor.companyId),
      ),
    );
  }
}
