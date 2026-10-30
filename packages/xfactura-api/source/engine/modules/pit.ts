import { randomUUID } from 'node:crypto';
import { and, asc, eq, gte, inArray, isNotNull, lte } from 'drizzle-orm';
import { z } from 'zod';
import { DomainError, requireCondition } from 'xfactura-core/errors';
import { profileAt, type Issue } from 'xfactura-core/kernel';
import { divRound, formatMoney, LEDGER_CURRENCY, parseMoney } from 'xfactura-core/money';
import { booksSystemOf, entityFormOf, individualForms } from 'xfactura-core/ro/entity';
import {
  adjustedNorm,
  casDue,
  cassDue,
  chargeJournals,
  classify,
  deductibleContributions,
  euroToBani,
  incomeTax,
  isTreasury,
  journalRows,
  natureOf,
  offsetLosses,
  realSourceIncome,
  toLeu,
  type CasRule,
  type CassRule,
  type CasStatus,
  type LossRule,
  type LossVintage,
  type NatureCatalogue,
  type NatureCode,
  type NormaRule,
  type PitLimits,
  type RealSource,
  type Rounding,
} from 'xfactura-core/ro/pit';
import { RuleGapError, type RuleContext } from 'xfactura-core/rules';
import { monthEnd, type LocalDate, type Month } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import {
  assetEvents,
  assets,
  entries,
  evidence,
  fiscalYears,
  incomeSources,
  lines,
  openItems,
} from '../db/schema';
import { appendAudit, type Actor, type Commands } from '../kernel/commands';
import type { CloseCheck } from '../kernel/periods';
import { cashJournalOf, itemsOf, loadTreasuryLedger } from '../kernel/reports';
import { loadState } from '../kernel/state';

const day = z.iso.date();
const money = z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/);
const percent = z.string().regex(/^(0|[1-9]\d?)(\.\d{1,2})?$/);
const lei = (bani: bigint) => formatMoney(bani, LEDGER_CURRENCY);
const block = (code: string, message: string): Issue => ({ code, severity: 'block', message });
const info = (code: string, message: string): Issue => ({ code, severity: 'info', message });
const year = (date: string) => Number(date.slice(0, 4));

export const incomeSourceInput = z
  .object({
    /** A new version of this source; omitted for a new source. */
    sourceId: z.uuid().optional(),
    /** The date this version applies from: the start of activity for the first. */
    effectiveFrom: day,
    name: z.string().trim().min(2).max(200),
    caen: z.string().regex(/^\d{4}$/),
    place: z.string().trim().min(2).max(300),
    county: z.string().regex(/^[A-Z]{1,2}$/),
    authorization: z
      .object({ number: z.string().trim().min(1).max(60), date: day })
      .strict()
      .optional(),
    startedOn: day,
    suspension: z.object({ from: day, to: day.optional() }).strict().optional(),
    endedOn: day.optional(),
    /** A liberal profession (Codul fiscal art. 67 alin. (2)). */
    liberal: z.boolean(),
    method: z.enum(['sistem_real', 'norma']),
    /** For the real system: required by law, or opted for (art. 69^1). */
    realBasis: z.enum(['required', 'option']).optional(),
    /** The registration certificate, the authorization or the declaration of the option. */
    evidenceId: z.uuid(),
  })
  .strict()
  .refine((input) => (input.method === 'norma') === (input.realBasis === undefined), {
    message: 'Sistemul real se aplică prin lege (required) sau prin opțiune (option); norma nu.',
    path: ['realBasis'],
  })
  .refine((input) => !(input.liberal && input.method === 'norma'), {
    message:
      'Venitul net din profesii liberale nu se stabilește pe bază de normă (art. 69 alin. (1)).',
    path: ['method'],
  })
  .refine(
    (input) =>
      input.startedOn <= input.effectiveFrom &&
      (!input.endedOn || input.startedOn <= input.endedOn) &&
      (!input.suspension?.to || input.suspension.from <= input.suspension.to),
    { message: 'Datele activității nu sunt în ordine.', path: ['effectiveFrom'] },
  );

export type IncomeSourceRow = typeof incomeSources.$inferSelect;

/** Each source's versions, oldest first. */
async function sourceVersions(tx: Transaction, companyId: string) {
  const rows = await tx
    .select()
    .from(incomeSources)
    .where(eq(incomeSources.companyId, companyId))
    .orderBy(asc(incomeSources.sourceId), asc(incomeSources.seq));
  return Map.groupBy(rows, (row) => row.sourceId);
}

/** A source's version in force on a date, if it had started. */
const versionAt = (versions: readonly IncomeSourceRow[], date: string) =>
  versions.filter((row) => row.effectiveFrom <= date).at(-1);

/**
 * The income sources of a PFA, II or IF: activity, place, dates and how the net income is set,
 * versioned. The law's sequence is checked here first and by the database again: a change to a
 * norm or to the real system by option from 1 January only, and an option kept for its 2-year
 * periods (art. 69^1).
 */
export class IncomeSources {
  constructor(private readonly commands: Commands) {}

  record(actor: Actor, key: string, input: z.infer<typeof incomeSourceInput>) {
    return this.commands.run(actor, key, 'pfa.sources.record', input, 'review', async (tx) => {
      const { loaded } = await loadState(tx, actor.companyId, { profile: true });
      requireCondition(
        individualForms.includes(entityFormOf(loaded.profile, input.effectiveFrom as LocalDate)),
        'INCOME_SOURCE_FORM',
        'Sursele de venit se înregistrează pentru o PFA, II sau IF (entity.form).',
      );
      const [file] = await tx
        .select({ id: evidence.id })
        .from(evidence)
        .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, input.evidenceId)));
      requireCondition(file, 'EVIDENCE', 'Documentul justificativ nu este disponibil.', 404);
      const sourceId = input.sourceId ?? randomUUID();
      const previous = input.sourceId
        ? ((await sourceVersions(tx, actor.companyId)).get(input.sourceId) ?? [])
        : [];
      requireCondition(
        !input.sourceId || previous.length,
        'NOT_FOUND',
        'Sursa de venit nu există.',
        404,
      );
      const last = previous.at(-1);
      requireCondition(
        last ? input.effectiveFrom >= last.effectiveFrom : input.effectiveFrom === input.startedOn,
        'INCOME_SOURCE_DATE',
        last
          ? 'O versiune nouă se aplică cel mai devreme de la data celei anterioare.'
          : 'Prima versiune a sursei se aplică de la începerea activității.',
      );
      const changed =
        last && (last.method !== input.method || last.realBasis !== (input.realBasis ?? null));
      requireCondition(
        !changed || input.realBasis === 'required' || input.effectiveFrom.endsWith('-01-01'),
        'INCOME_SOURCE_METHOD_DATE',
        'Trecerea la normă sau, prin opțiune, la sistemul real se face de la 1 ianuarie (art. 69^1 din Codul fiscal).',
      );
      if (changed && input.method === 'norma' && last.realBasis === 'option') {
        const run = previous.slice(
          previous.findLastIndex(
            (row) => !(row.method === 'sistem_real' && row.realBasis === 'option'),
          ) + 1,
        );
        const opted = year(run[0]!.effectiveFrom);
        const elapsed = year(input.effectiveFrom) - opted;
        requireCondition(
          elapsed >= 2 && elapsed % 2 === 0,
          'INCOME_SOURCE_OPTION_LOCK',
          `Opțiunea pentru sistemul real din ${opted} este obligatorie 2 ani fiscali și se reînnoiește tacit (art. 69^1 alin. (2)): revenirea la normă este posibilă de la 1 ianuarie ${opted + (elapsed < 2 ? 2 : elapsed + 1)}.`,
        );
      }
      const seq = (last?.seq ?? 0) + 1;
      await tx.insert(incomeSources).values({
        companyId: actor.companyId,
        sourceId,
        seq,
        effectiveFrom: input.effectiveFrom,
        name: input.name,
        caen: input.caen,
        place: input.place,
        county: input.county,
        authorizationNumber: input.authorization?.number ?? null,
        authorizationDate: input.authorization?.date ?? null,
        startedOn: input.startedOn,
        suspendedFrom: input.suspension?.from ?? null,
        suspendedTo: input.suspension?.to ?? null,
        endedOn: input.endedOn ?? null,
        liberal: input.liberal,
        method: input.method,
        realBasis: input.realBasis ?? null,
        evidenceId: input.evidenceId,
        createdBy: actor.actorId,
      });
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.actorId,
        action: 'pfa.sources.recorded',
        body: { sourceId, seq },
      });
      return { sourceId, seq };
    });
  }

  list(actor: Actor) {
    return this.commands.read(actor, 'pfa.sources.list', async (tx) =>
      [...(await sourceVersions(tx, actor.companyId))].map(([sourceId, versions]) => ({
        sourceId,
        versions: versions.map((row) => ({
          seq: row.seq,
          effectiveFrom: row.effectiveFrom,
          name: row.name,
          caen: row.caen,
          place: row.place,
          county: row.county,
          authorization: row.authorizationNumber
            ? { number: row.authorizationNumber, date: row.authorizationDate }
            : null,
          startedOn: row.startedOn,
          suspension: row.suspendedFrom ? { from: row.suspendedFrom, to: row.suspendedTo } : null,
          endedOn: row.endedOn,
          liberal: row.liberal,
          method: row.method,
          realBasis: row.realBasis,
          evidenceId: row.evidenceId,
        })),
      })),
    );
  }
}

export const fiscalRegisterInput = z
  .object({
    year: z.number().int().min(2000).max(2100),
    /** BNR's average EUR rate of the year, from its publication: for the euro limits of art. 68
     * alin. (5) (norme pct. 7 alin. (6)) and the 25.000 euro threshold of art. 69 alin. (9). */
    eurAnnualRate: z
      .object({ rate: z.string().regex(/^\d{1,3}\.\d{1,4}$/), evidenceId: z.uuid() })
      .strict()
      .optional(),
    /** The income chosen as the CAS base (art. 148 alin. (2)); the least the law allows when
     * omitted. */
    casIncome: money.optional(),
    /** The owner's other income counted for CAS and CASS, outside these books: net incomes and
     * norms of other independent activities, intellectual property (art. 148 alin. (3), art. 170
     * alin. (1)). */
    otherIncome: z.object({ amount: money, evidenceId: z.uuid() }).strict().optional(),
    /** Losses of a source from years before these books, as last declared. */
    openingLosses: z
      .array(
        z
          .object({
            sourceId: z.uuid(),
            year: z.number().int().min(2000).max(2100),
            amount: money,
            evidenceId: z.uuid(),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    /** Non-cash items the books do not hold: income in kind, business assets taken into the
     * owner's patrimony at market value, debts forgiven (art. 68 alin. (2); norme pct. 7 alin.
     * (2)), and the undepreciated value of assets sold, within their price (pct. 7 alin. (5) lit.
     * o)). */
    adjustments: z
      .array(
        z
          .object({
            sourceId: z.uuid(),
            kind: z.enum(['in_kind', 'withdrawn_assets', 'forgiven_debts', 'undepreciated_sold']),
            amount: money,
            description: z.string().trim().min(3).max(300),
            evidenceId: z.uuid(),
          })
          .strict(),
      )
      .max(50)
      .default([]),
    /** The norm the DGRFP published for each source on a norm, with the highest increasing and
     * reducing coefficients that apply (norme pct. 8 alin. (6)–(7)). */
    norms: z
      .array(
        z
          .object({
            sourceId: z.uuid(),
            norm: money,
            increasePercent: percent.optional(),
            reductionPercent: percent.optional(),
            evidenceId: z.uuid(),
          })
          .strict(),
      )
      .max(20)
      .default([]),
  })
  .strict();
type FiscalRegisterInput = z.infer<typeof fiscalRegisterInput>;

const adjustmentNatures: Record<
  FiscalRegisterInput['adjustments'][number]['kind'],
  { nature: NatureCode; sign: 1n | -1n; label: string }
> = {
  in_kind: { nature: 'income.activity', sign: 1n, label: 'Venituri în natură' },
  withdrawn_assets: {
    nature: 'income.asset_sale',
    sign: 1n,
    label: 'Bunuri ale afacerii trecute în patrimoniul personal (prețul pieței)',
  },
  forgiven_debts: { nature: 'income.activity', sign: 1n, label: 'Datorii anulate sau scutite' },
  undepreciated_sold: {
    nature: 'expense.full',
    sign: -1n,
    label: 'Valoarea rămasă neamortizată a bunurilor înstrăinate',
  },
};

interface YearParams {
  rate: string;
  rounding: Rounding;
  loss: LossRule;
  limits: PitLimits;
  norma: NormaRule;
  catalogue: NatureCatalogue;
  minimumWage: bigint;
  casRate: string;
  cas: CasRule;
  cassRate: string;
  cass: CassRule;
}

/** Every parameter of an income year, or the gap that prevents the year's computation. */
function yearParams(rules: RuleContext, income: number): YearParams {
  const at = `${income}-01-01` as LocalDate;
  const param = <T>(key: string) => rules.param<T>(key, 'fiscal_year_start', at);
  try {
    return {
      rate: param('ro.pit.rate'),
      rounding: param('ro.pit.rounding'),
      loss: param('ro.pit.loss'),
      limits: param('ro.pit.limits'),
      norma: param('ro.pit.norma'),
      catalogue: param('ro.pit.natures'),
      minimumWage: parseMoney(param<string>('ro.min_wage.contributions'), LEDGER_CURRENCY),
      casRate: param('ro.cas.rate'),
      cas: param('ro.cas.independent'),
      cassRate: param('ro.cass.rate'),
      cass: param('ro.cass.independent'),
    };
  } catch (error) {
    if (!(error instanceof RuleGapError)) throw error;
    requireCondition(false, 'RULE_GAP', error.message, 422, { ...error.gap });
  }
}

/**
 * Fiscal depreciation of the year (art. 28; art. 68 alin. (4) lit. d)): straight line over each
 * asset's fiscal life, from the month after commissioning to the month before its disposal. An
 * asset disposed of in the year leaves its undepreciated value, deductible within the sale price
 * (norme pct. 7 alin. (5) lit. o)): reported for an adjustment.
 */
async function fiscalDepreciation(tx: Transaction, companyId: string, income: number) {
  const disposals = new Map(
    (
      await tx
        .select({ assetId: assetEvents.assetId, date: assetEvents.date })
        .from(assetEvents)
        .where(eq(assetEvents.companyId, companyId))
    ).map((row) => [row.assetId, row.date]),
  );
  const month = (date: string) => year(date) * 12 + Number(date.slice(5, 7)) - 1;
  const items: { nature: NatureCode; flow: bigint; label: string }[] = [];
  const issues: Issue[] = [];
  for (const card of await tx
    .select()
    .from(assets)
    .where(and(eq(assets.companyId, companyId), lte(assets.commissionedOn, `${income}-12-31`)))
    .orderBy(asc(assets.number))) {
    const disposed = disposals.get(card.id);
    // Months of use through the end of a month index, at most the fiscal life.
    const used = (through: number) =>
      BigInt(Math.max(0, Math.min(card.fiscalLifeMonths, through - month(card.commissionedOn))));
    const last = Math.min(income * 12 + 11, disposed ? month(disposed) - 1 : Infinity);
    const share = (months: bigint) =>
      divRound(card.valueBani * months, BigInt(card.fiscalLifeMonths), 'halfAwayFromZero');
    const before = share(used(income * 12 - 1));
    const through = share(used(last));
    if (through > before)
      items.push({
        nature: 'expense.depreciation',
        flow: -(through - before),
        label: `Amortizare fiscală ${card.number} ${card.name}`,
      });
    if (disposed && year(disposed) === income && through < card.valueBani)
      issues.push(
        info(
          'PIT_ASSET_DISPOSED',
          `${card.number} ${card.name} a ieșit din patrimoniu la ${disposed}: valoarea rămasă neamortizată de ${lei(card.valueBani - through)} lei se deduce în limita prețului de vânzare (norme pct. 7 alin. (5) lit. o)); introduceți-o ca ajustare (undepreciated_sold).`,
        ),
      );
  }
  return { items, issues };
}

/**
 * What the books hold for a year besides receipts and payments: expense reports against an
 * advance (542) paid earlier in cash, deductible at the report; and invoices settled without
 * money (a compensation, a write-off), which the cash basis would miss.
 */
async function nonCashEntries(
  tx: Transaction,
  companyId: string,
  income: number,
  catalogue: NatureCatalogue,
) {
  const touched = await tx
    .selectDistinct({ entryId: lines.entryId, itemId: openItems.id })
    .from(lines)
    .innerJoin(entries, and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId)))
    .innerJoin(
      openItems,
      and(eq(openItems.companyId, lines.companyId), eq(openItems.id, lines.openItemId)),
    )
    .where(
      and(
        eq(lines.companyId, companyId),
        isNotNull(lines.openItemId),
        gte(entries.date, `${income}-01-01`),
        lte(entries.date, `${income}-12-31`),
      ),
    );
  const candidates = [...new Set(touched.map((row) => row.entryId))];
  const items: { nature: NatureCode; flow: bigint; label: string }[] = [];
  const issues: Issue[] = [];
  if (!candidates.length) return { items, issues };
  const headers = new Map(
    (
      await tx
        .select()
        .from(entries)
        .where(and(eq(entries.companyId, companyId), inArray(entries.id, candidates)))
    ).map((row) => [row.id, row]),
  );
  const all = await tx
    .select()
    .from(lines)
    .where(and(eq(lines.companyId, companyId), inArray(lines.entryId, candidates)));
  const byEntry = Map.groupBy(all, (row) => row.entryId);
  const { items: openItemsById } = await itemsOf(tx, companyId, [
    ...new Set(touched.map((row) => row.itemId)),
  ]);
  for (const entryId of candidates) {
    const header = headers.get(entryId)!;
    const entryLines = byEntry.get(entryId) ?? [];
    if (entryLines.some((line) => isTreasury(line.account))) continue;
    if ((chargeJournals as readonly string[]).includes(header.journalCode)) continue;
    if (header.journalCode === 'DESCHIDERE') continue;
    const onItems = entryLines.filter((line) => line.openItemId);
    const advance = onItems.some((line) =>
      openItemsById.get(line.openItemId!)?.controlAccount.startsWith('542'),
    );
    const document = onItems.some((line) => openItemsById.get(line.openItemId!)?.documentId);
    if (advance)
      for (const line of entryLines.filter((item) => !item.openItemId)) {
        const flow = line.side === 'C' ? line.bani : -line.bani;
        items.push({
          nature: classify(catalogue, line.account, flow),
          flow,
          label: `Decont de cheltuieli: ${header.description}`,
        });
      }
    else if (document)
      issues.push(
        block(
          'PIT_NONCASH_SETTLEMENT',
          `${header.description} (${header.date}) stinge o factură fără încasare sau plată (compensare, anulare): venitul sau cheltuiala corespunzătoare nu apar în Registrul-jurnal; introduceți-le ca ajustări.`,
        ),
      );
  }
  return { items, issues };
}

const view = (lines: { nature: NatureCode; label: string; bani: bigint }[]) =>
  lines.map((line) => ({ nature: line.nature, label: line.label, amount: lei(line.bani) }));

/** A real-system source's register for a year: its cash-basis natures and non-cash items. */
async function realSourceYear(
  tx: Transaction,
  companyId: string,
  income: number,
  params: YearParams,
  extra: { nature: NatureCode; flow: bigint; label: string }[],
  eurRate: string | null,
) {
  const { rows } = await cashJournalOf(tx, companyId, income, params.catalogue);
  const depreciation = await fiscalDepreciation(tx, companyId, income);
  const reports = await nonCashEntries(tx, companyId, income, params.catalogue);
  const nonCash = [...depreciation.items, ...reports.items, ...extra];
  const result = realSourceIncome(
    { parts: rows.flatMap((row) => row.parts), nonCash },
    { limits: params.limits, rounding: params.rounding, eurRate, persons: 1 },
  );
  return {
    result,
    nonCash,
    issues: [...depreciation.issues, ...reports.issues, ...result.issues],
    rows,
  };
}

/** The register's rows (OMFP nr. 3.254/2017 anexa nr. 1): the elements of the computation. */
function registerRows(result: RealSource) {
  const rows: { nr: string; element: string; value: string }[] = [];
  rows.push({ nr: '1', element: 'Venit brut', value: lei(result.totals.gross) });
  result.income.forEach((line, index) =>
    rows.push({ nr: `1.${index + 1}`, element: line.label, value: lei(line.bani) }),
  );
  rows.push({ nr: '2', element: 'Cheltuieli deductibile', value: lei(result.totals.deductible) });
  result.expenses.forEach((line, index) =>
    rows.push({
      nr: `2.${index + 1}`,
      element:
        line.limit && line.deductible !== line.bani
          ? `${line.label} (efectuate ${lei(line.bani)} lei, deductibile în limita legii)`
          : line.label,
      value: lei(line.deductible),
    }),
  );
  rows.push(
    result.totals.loss > 0n
      ? { nr: '3', element: 'Pierdere netă anuală', value: lei(result.totals.loss) }
      : { nr: '3', element: 'Venit net anual', value: lei(result.totals.net) },
  );
  return rows;
}

/** Days of activity in the year when less than all of it (art. 69 alin. (5); norme pct. 8 alin.
 * (8)–(10)), or null for the whole year. */
function activeDays(source: IncomeSourceRow, income: number) {
  const start = `${income}-01-01`;
  const end = `${income}-12-31`;
  const from = source.startedOn > start ? source.startedOn : start;
  const to = source.endedOn && source.endedOn < end ? source.endedOn : end;
  const days = (a: string, b: string) =>
    Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;
  let active = Math.max(0, days(from, to));
  if (source.suspendedFrom) {
    const sFrom = source.suspendedFrom > from ? source.suspendedFrom : from;
    const sTo = source.suspendedTo && source.suspendedTo < to ? source.suspendedTo : to;
    if (sFrom <= sTo) active -= days(sFrom, sTo);
  }
  return from === start && to === end && active === days(start, end) ? null : active;
}

/**
 * The Registrul de evidență fiscală of a year (OMFP nr. 3.254/2017) and the year's income tax and
 * contributions (Codul fiscal art. 68, 69, 118, 148, 170, 174) of a PFA, II or IF with one
 * income source: from the Registrul-jurnal's natures, fiscal depreciation, expense reports and the
 * non-cash items given; losses carried from the books' earlier years and those declared before
 * them. Blocking issues mean the figures are not final.
 */
export async function fiscalRegister(
  tx: Transaction,
  companyId: string,
  input: FiscalRegisterInput,
  rules: RuleContext,
) {
  const start = `${input.year}-01-01` as LocalDate;
  const end = `${input.year}-12-31` as LocalDate;
  const { loaded } = await loadState(tx, companyId, { profile: true });
  requireCondition(
    individualForms.includes(entityFormOf(loaded.profile, end)) &&
      booksSystemOf(loaded.profile, end) === 'single',
    'SINGLE_ENTRY_ONLY',
    'Registrul de evidență fiscală se întocmește pentru o PFA, II sau IF în partidă simplă.',
  );
  const params = yearParams(rules, input.year);
  const issues: Issue[] = [];
  const named = [
    input.eurAnnualRate?.evidenceId,
    input.otherIncome?.evidenceId,
    ...input.openingLosses.map((item) => item.evidenceId),
    ...input.adjustments.map((item) => item.evidenceId),
    ...input.norms.map((item) => item.evidenceId),
  ].filter((id): id is string => Boolean(id));
  if (named.length) {
    const found = await tx
      .select({ id: evidence.id })
      .from(evidence)
      .where(and(eq(evidence.companyId, companyId), inArray(evidence.id, named)));
    requireCondition(
      new Set(found.map((row) => row.id)).size === new Set(named).size,
      'EVIDENCE',
      'Un document justificativ indicat nu este disponibil.',
      404,
    );
  }

  const active = [...(await sourceVersions(tx, companyId)).values()]
    .map((versions) => ({
      versions,
      current: versionAt(versions, end) ?? versions[0]!,
    }))
    .filter(
      ({ current }) => current.startedOn <= end && (!current.endedOn || current.endedOn >= start),
    );
  requireCondition(
    active.length,
    'INCOME_SOURCE',
    `Nu există o sursă de venit activă în ${input.year} (pfa.sources.record).`,
  );
  for (const { versions, current } of active) {
    const methods = new Set(
      versions
        .filter(
          (row) =>
            row.effectiveFrom <= end &&
            (row.effectiveFrom > start || row === versionAt(versions, start)),
        )
        .map((row) => row.method),
    );
    if (methods.size > 1)
      issues.push(
        block(
          'PIT_METHOD_CHANGE',
          `${current.name}: metoda de stabilire a venitului net s-a schimbat în cursul anului (norme pct. 8 alin. (13)); calculul pe perioade nu este încă disponibil.`,
        ),
      );
  }
  const real = active.filter(({ current }) => current.method === 'sistem_real');
  const norma = active.filter(({ current }) => current.method === 'norma');
  if (active.length > 1)
    issues.push(
      block(
        'PIT_SOURCES_MULTIPLE',
        'Mai multe surse de venit în același an: încasările și plățile nu sunt încă atribuite pe surse.',
      ),
    );
  if (real.length && norma.length)
    issues.push(
      block(
        'PIT_NORMA_MIXED',
        'O activitate din nomenclator desfășurată alături de o altă activitate independentă se impune în sistem real (art. 69 alin. (7)).',
      ),
    );
  const eurRate = input.eurAnnualRate?.rate ?? null;

  // The real source: this year's register, and the losses its earlier years carry.
  const sources = [];
  let realNet = 0n;
  let recalculated = 0n;
  for (const { current } of real) {
    const extra = input.adjustments
      .filter((item) => item.sourceId === current.sourceId)
      .map((item) => {
        const kind = adjustmentNatures[item.kind];
        return {
          nature: kind.nature,
          flow: kind.sign * parseMoney(item.amount, LEDGER_CURRENCY),
          label: `${kind.label}: ${item.description}`,
        };
      });
    const own = await realSourceYear(tx, companyId, input.year, params, extra, eurRate);
    issues.push(...own.issues);
    // Losses: those declared before the books, then each earlier year of the books in turn.
    let vintages: LossVintage[] = input.openingLosses
      .filter((item) => item.sourceId === current.sourceId && item.year < input.year)
      .map((item) => ({ year: item.year, bani: parseMoney(item.amount, LEDGER_CURRENCY) }));
    const first = await tx
      .select({ from: fiscalYears.from })
      .from(fiscalYears)
      .where(and(eq(fiscalYears.companyId, companyId), eq(fiscalYears.kind, 'financial')))
      .orderBy(asc(fiscalYears.from))
      .limit(1);
    const booksFrom = Math.max(
      first[0] ? year(first[0].from) : input.year,
      Number(current.startedOn.slice(0, 4)),
    );
    for (let earlier = booksFrom; earlier < input.year; earlier++) {
      let before: YearParams;
      try {
        before = yearParams(rules, earlier);
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        issues.push(
          block(
            'PIT_PRIOR_YEAR',
            `Pierderea sau venitul net din ${earlier} nu se pot stabili (${error.message}): pierderile reportate din acel an lipsesc din calcul.`,
          ),
        );
        continue;
      }
      const { result } = await realSourceYear(tx, companyId, earlier, before, [], eurRate);
      vintages = result.totals.loss
        ? [...vintages, { year: earlier, bani: result.totals.loss }]
        : offsetLosses(earlier, result.totals.net, vintages, before.loss, before.rounding)
            .remaining;
    }
    const losses = offsetLosses(
      input.year,
      own.result.totals.net,
      vintages,
      params.loss,
      params.rounding,
    );
    const carried = [
      ...losses.remaining,
      ...(own.result.totals.loss ? [{ year: input.year, bani: own.result.totals.loss }] : []),
    ];
    realNet += own.result.totals.net;
    recalculated += losses.recalculated;
    sources.push({
      sourceId: current.sourceId,
      name: current.name,
      caen: current.caen,
      place: current.place,
      county: current.county,
      method: current.method,
      realBasis: current.realBasis,
      register: {
        year: input.year,
        rectification: false,
        source: `${current.name} (CAEN ${current.caen}) – venituri din activități independente`,
        rows: registerRows(own.result),
      },
      income: view(own.result.income),
      expenses: own.result.expenses.map((line) => ({
        nature: line.nature,
        label: line.label,
        amount: lei(line.bani),
        deductible: lei(line.deductible),
        limit: line.limit,
      })),
      excluded: view(own.result.excluded),
      nonCash: own.nonCash.map((item) => ({
        nature: item.nature,
        label: item.label,
        amount: lei(item.flow),
      })),
      base: lei(own.result.base),
      totals: {
        gross: lei(own.result.totals.gross),
        deductible: lei(own.result.totals.deductible),
        net: lei(own.result.totals.net),
        loss: lei(own.result.totals.loss),
      },
      losses: {
        available: lei(losses.available),
        offset: lei(losses.offset),
        recalculated: lei(losses.recalculated),
        carried: carried.map((item) => ({ year: item.year, amount: lei(item.bani) })),
        expired: losses.expired.map((item) => ({ year: item.year, amount: lei(item.bani) })),
      },
    });
  }

  // Sources on a norm: the income part of the register, and the adjusted norm.
  let norms = 0n;
  const journal = norma.length
    ? await cashJournalOf(tx, companyId, input.year, params.catalogue)
    : null;
  for (const { current } of norma) {
    const given = input.norms.find((item) => item.sourceId === current.sourceId);
    const gross = journal!.rows
      .flatMap((row) => row.parts)
      .filter((part) => natureOf(part.nature)?.kind === 'income')
      .reduce((sum, part) => sum + part.flow, 0n);
    if (!given) {
      issues.push(
        block(
          'PIT_NORM_MISSING',
          `${current.name}: indicați norma de venit publicată de DGRFP pentru activitate și loc, cu documentul ei.`,
        ),
      );
      continue;
    }
    const adjusted = adjustedNorm(
      {
        norm: parseMoney(given.norm, LEDGER_CURRENCY),
        increasePercent: given.increasePercent ?? null,
        reductionPercent: given.reductionPercent ?? null,
        activeDays: activeDays(current, input.year),
        floor: params.minimumWage * BigInt(params.norma.floorWages),
      },
      params.rounding,
    );
    issues.push(...adjusted.issues);
    if (eurRate) {
      const threshold = euroToBani(params.norma.realAboveEur, eurRate);
      if (gross > threshold)
        issues.push(
          info(
            'PIT_NORMA_THRESHOLD',
            `${current.name}: venitul brut de ${lei(gross)} lei depășește ${params.norma.realAboveEur} euro (${lei(threshold)} lei): din ${input.year + 1} venitul net se stabilește în sistem real (art. 69 alin. (9)).`,
          ),
        );
    } else
      issues.push(
        info(
          'PIT_EUR_RATE',
          `Pragul de ${params.norma.realAboveEur} euro al normei (art. 69 alin. (9)) se verifică la cursul mediu BNR al anului: indicați-l.`,
        ),
      );
    norms += adjusted.adjusted;
    sources.push({
      sourceId: current.sourceId,
      name: current.name,
      caen: current.caen,
      place: current.place,
      county: current.county,
      method: current.method,
      realBasis: current.realBasis,
      register: {
        year: input.year,
        rectification: false,
        source: `${current.name} (CAEN ${current.caen}) – venituri din activități independente, normă de venit`,
        rows: [{ nr: '1', element: 'Venit brut', value: lei(toLeu(gross, params.rounding)) }],
      },
      norm: {
        norm: lei(parseMoney(given.norm, LEDGER_CURRENCY)),
        increase: lei(adjusted.increase),
        reduction: lei(adjusted.reduction),
        activeDays: activeDays(current, input.year),
        adjusted: lei(adjusted.adjusted),
        tax: lei(incomeTax(adjusted.adjusted, params.rate, params.rounding)),
      },
    });
  }

  // The owner's contributions and the tax.
  const status = (profileAt(loaded, 'cas.status', end) ?? null) as CasStatus | null;
  const exception = profileAt(loaded, 'cass.exception', end);
  if (!status)
    issues.push(
      info(
        'CAS_STATUS_UNSTATED',
        'Nu este înregistrată situația titularului față de CAS (cas.status): calculat ca asigurat în sistemul public (fără excepțiile de la art. 150).',
      ),
    );
  if (!exception)
    issues.push(
      info(
        'CASS_EXCEPTION_UNSTATED',
        'Nu este înregistrată situația titularului față de CASS minimă (cass.exception): calculat fără excepțiile de la art. 174 alin. (7)–(8).',
      ),
    );
  const other = input.otherIncome ? parseMoney(input.otherIncome.amount, LEDGER_CURRENCY) : 0n;
  const cumulated = realNet + norms + other;
  const cas = casDue(
    {
      cumulated,
      status: status ?? 'liable',
      option: profileAt(loaded, 'cas.option', end) === 'yes',
      chosen: input.casIncome ? parseMoney(input.casIncome, LEDGER_CURRENCY) : null,
    },
    {
      minimumWage: params.minimumWage,
      rate: params.casRate,
      rule: params.cas,
      rounding: params.rounding,
    },
  );
  const cass = cassDue(
    { cumulated, exception: Boolean(exception && exception !== 'none') },
    {
      minimumWage: params.minimumWage,
      rate: params.cassRate,
      rule: params.cass,
      rounding: params.rounding,
    },
  );
  issues.push(...cas.issues);
  const deducted = deductibleContributions(
    {
      realNet,
      recalculated,
      cas: { due: cas.due, cumulated },
      cass: { due: cass.due, minimumDifference: cass.minimumDifference, cumulated },
    },
    params.rounding,
  );
  const taxable = recalculated - deducted.cas - deducted.cass;
  const realTax = incomeTax(taxable, params.rate, params.rounding);
  const normaTax = norma.length ? incomeTax(norms, params.rate, params.rounding) : 0n;
  return {
    year: input.year,
    final: !issues.some((issue) => issue.severity === 'block'),
    sources,
    contributions: {
      minimumWage: lei(params.minimumWage),
      cumulated: lei(cumulated),
      cas: {
        status: status ?? 'liable',
        threshold: lei(cas.threshold),
        base: lei(cas.base),
        due: lei(cas.due),
        exempt: cas.exempt,
        deductible: lei(deducted.cas),
      },
      cass: {
        base: lei(cass.base),
        cap: lei(cass.cap),
        due: lei(cass.due),
        minimumDifference: lei(cass.minimumDifference),
        deductible: lei(deducted.cass),
      },
    },
    tax: {
      recalculated: lei(recalculated),
      taxable: lei(taxable > 0n ? taxable : 0n),
      real: lei(realTax),
      norma: lei(normaTax),
      total: lei(realTax + normaTax),
    },
    issues,
    parameters: [...rules.used.keys()].sort(),
  };
}

/** On single-entry books a month closes once every receipt and payment has a nature. */
export const pitChecks = (
  rules: (tx: Transaction, companyId: string) => Promise<RuleContext>,
): CloseCheck[] => [
  {
    id: 'pfa.natures',
    async run(tx, companyId, month) {
      const end = monthEnd(month as Month);
      const { loaded } = await loadState(tx, companyId, { profile: true });
      if (booksSystemOf(loaded.profile, end) !== 'single') return [];
      let catalogue: NatureCatalogue;
      try {
        catalogue = (await rules(tx, companyId)).param<NatureCatalogue>(
          'ro.pit.natures',
          'fiscal_year_start',
          `${month.slice(0, 4)}-01-01` as LocalDate,
        );
      } catch (error) {
        if (!(error instanceof RuleGapError)) throw error;
        return [{ code: 'RULE_GAP', severity: 'block', message: error.message }];
      }
      const ledger = await loadTreasuryLedger(tx, companyId, `${month}-01`, end);
      const missing = journalRows({ ...ledger, catalogue }).filter((row) =>
        row.parts.some((part) => !natureOf(part.nature)),
      );
      return missing.length
        ? [
            {
              code: 'PFA_NATURE_MISSING',
              severity: 'block' as const,
              message: `${missing.length} încasări sau plăți din ${month} nu au o natură în Registrul-jurnal de încasări și plăți: clasificați conturile sau facturile lor.`,
              count: missing.length,
              items: [...new Set(missing.map((row) => row.entryId))].slice(0, 20),
            },
          ]
        : [];
    },
  },
];
