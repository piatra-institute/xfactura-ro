import { and, asc, eq, gte, inArray, isNotNull, lte } from 'drizzle-orm';
import { z } from 'zod';
import { DomainError, requireCondition } from 'xfactura-core/errors';
import { profileAt, type Issue } from 'xfactura-core/kernel';
import { divRound, formatMoney, LEDGER_CURRENCY, parseMoney } from 'xfactura-core/money';
import { booksSystemOf, entityFormOf, individualForms } from 'xfactura-core/ro/entity';
import {
  adjustedNorm,
  attributeSources,
  casDue,
  cassOtherDue,
  daysBetween,
  distributeByQuota,
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
  segmentsOf,
  toLeu,
  type Attribution,
  type CasRule,
  type CassOtherRule,
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
  type Segment,
  type SourcePart,
  type SourcesRule,
} from 'xfactura-core/ro/pit';
import { normCriteria, type NormCriterion } from 'xfactura-core/ro/declarations/d212';
import { RuleGapError, type RuleContext } from 'xfactura-core/rules';
import { addDays, monthEnd, type LocalDate, type Month } from 'xfactura-core/time';
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
  parties,
} from '../db/schema';
import { appendAudit, type Actor, type Commands } from '../kernel/commands';
import type { CloseCheck } from '../kernel/periods';
import { cashJournalOf, itemsOf, loadTreasuryLedger } from '../kernel/reports';
import { agreements, agreementsIn, quotaText } from './enterprise';
import { loadState } from '../kernel/state';

const day = z.iso.date();
const money = z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/);
const percent = z.string().regex(/^(0|[1-9]\d?)(\.\d{1,2})?$/);
const sharePercent = z.string().regex(/^(100|[1-9]?\d)(\.\d{1,2})?$/);
const accountMatch = z.string().regex(/^[1-9]\d{0,3}(\.[A-Z0-9_-]{1,24})*$/);
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
      const sourceId = input.sourceId ?? this.commands.ids();
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
            /** The criterion the coefficient comes from (norme pct. 8 alin. (7)), as the D212 web
             * form codes them: 01 vadul comercial … 13 alte criterii. */
            increaseCriterion: z.enum(normCriteria).optional(),
            reductionPercent: percent.optional(),
            reductionCriterion: z.enum(normCriteria).optional(),
            /** The day the DGRFP set the norm (its decision), for the years whose floor counts the
             * minimum wage in force then (art. 69 alin. (3) before the income of 2026). */
            setOn: day.optional(),
            evidenceId: z.uuid(),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    /** BNR's average EUR rate of the previous year: a source on a norm whose gross income that
     * year exceeded 25.000 euro is in the real system from this year (art. 69 alin. (9)). */
    previousEurAnnualRate: z
      .object({ rate: z.string().regex(/^\d{1,3}\.\d{1,4}$/), evidenceId: z.uuid() })
      .strict()
      .optional(),
    /** The previous year's gross income of a source on a norm, when these books do not hold that
     * year: from the fiscal register's income part or the declaration filed. */
    previousGross: z
      .array(z.object({ sourceId: z.uuid(), amount: money, evidenceId: z.uuid() }).strict())
      .max(20)
      .default([]),
    /** With several sources in the year, the register is kept per source (OMFP nr. 3.254/2017
     * art. 3 alin. (3)–(4), art. 4 alin. (1), art. 5 alin. (1)): the source of each account the
     * receipts, payments, fixed assets and expense reports are booked on (with its analytics, the
     * longest match winning), and, for accounts whose expenses serve several sources, the key the
     * person states for them (by gross income or by fixed shares), each with its document. */
    attribution: z
      .object({
        accounts: z
          .array(z.object({ match: accountMatch, sourceId: z.uuid() }).strict())
          .max(200)
          .default([]),
        shared: z
          .array(
            z
              .object({
                match: accountMatch,
                key: z.discriminatedUnion('kind', [
                  z.object({ kind: z.literal('gross') }).strict(),
                  z
                    .object({
                      kind: z.literal('fixed'),
                      shares: z
                        .array(z.object({ sourceId: z.uuid(), percent: sharePercent }).strict())
                        .min(2)
                        .max(20),
                    })
                    .strict(),
                ]),
                evidenceId: z.uuid(),
              })
              .strict(),
          )
          .max(50)
          .default([]),
        evidenceId: z.uuid(),
      })
      .strict()
      .optional(),
    /** Income the person declares from outside these books, as declared: rent, investments
     * (interest, gains) and dividends. It counts for the CASS of art. 170 alin. (2)–(3) and for
     * the exception of art. 174 alin. (7) lit. b), never for CAS or the business's income tax. */
    declaredIncome: z
      .array(
        z
          .object({
            kind: z.enum(['rent', 'investment', 'dividends']),
            /** The income the CASS counts (art. 170 alin. (4); OPANAF nr. 2.736/2025 instr. pct.
             * 51: rent's net income, dividends and interest paid less the tax withheld). */
            amount: money,
            /** The CASS a payer withheld on it (D212 sec. 3.2.2 rd. 6), "0" when none. */
            cassWithheld: money,
            /** Its income tax is final, withheld at source: the declaration has no subsection of
             * its own for that tax. */
            taxSettled: z.boolean(),
            description: z.string().trim().min(3).max(300),
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
  /** Read only for a source taxed by norm: a year without its rule blocks only such sources. */
  norma: NormaRule | { gap: string };
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
      norma: (() => {
        try {
          return param<NormaRule>('ro.pit.norma');
        } catch (error) {
          if (!(error instanceof RuleGapError)) throw error;
          return { gap: error.message };
        }
      })(),
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
  const items: SourcePart[] = [];
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
        account: card.account,
        flow: -(through - before),
        date: null,
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
  const items: SourcePart[] = [];
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
          account: line.account,
          flow,
          date: header.date as LocalDate,
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

/** A source in a year: its versions, the one at the year's end, and its methods over the year. */
type ActiveSource = {
  versions: IncomeSourceRow[];
  current: IncomeSourceRow;
  segments: Segment[];
};

/** The sources active at some point of a year. */
function activeIn(all: Map<string, IncomeSourceRow[]>, income: number): ActiveSource[] {
  const start = `${income}-01-01`;
  const end = `${income}-12-31`;
  return (
    [...all.values()]
      .map((versions) => ({ versions, current: versionAt(versions, end) ?? versions[0]! }))
      .filter(
        ({ current }) => current.startedOn <= end && (!current.endedOn || current.endedOn >= start),
      )
      .map((item) => ({ ...item, segments: segmentsOf(item.versions, income) }))
      // In a stable order, for the register and the D212's subsections: by start, then name.
      .sort(
        (a, b) =>
          a.current.startedOn.localeCompare(b.current.startedOn) ||
          a.current.name.localeCompare(b.current.name, 'ro') ||
          a.current.sourceId.localeCompare(b.current.sourceId),
      )
  );
}

const hasReal = (source: ActiveSource) =>
  source.segments.some((segment) => segment.method === 'sistem_real');
const normSegment = (source: ActiveSource) =>
  source.segments.find((segment) => segment.method === 'norma');

type Attributed = {
  result: RealSource;
  parts: SourcePart[];
  normGross: bigint;
  shared: { account: string; bani: bigint }[];
};

/**
 * A year's registers, per source: the Registrul-jurnal's natures with their dates, fiscal
 * depreciation and expense reports, and the non-cash items given (`extra`), split among the
 * sources (`attributeSources`); each source in the real system then gets its net income (art. 68).
 */
async function yearRegisters(
  tx: Transaction,
  companyId: string,
  rules: RuleContext,
  income: number,
  params: YearParams,
  sources: readonly ActiveSource[],
  extra: SourcePart[],
  eurRate: string | null,
  attribution: Attribution | null,
) {
  const { rows } = await cashJournalOf(tx, companyId, income, params.catalogue);
  const depreciation = await fiscalDepreciation(tx, companyId, income);
  const reports = await nonCashEntries(tx, companyId, income, params.catalogue);
  const parts: SourcePart[] = [
    ...rows.flatMap((row) =>
      row.parts.map((part) => ({
        nature: part.nature,
        account: part.account,
        flow: part.flow,
        date: row.date,
      })),
    ),
    ...depreciation.items,
    ...reports.items,
    ...extra,
  ];
  let rule: SourcesRule | null = null;
  if (sources.length > 1 && attribution?.shared.length)
    try {
      rule = rules.param<SourcesRule>(
        'ro.pit.sources',
        'fiscal_year_start',
        `${income}-01-01` as LocalDate,
      );
    } catch (error) {
      if (!(error instanceof RuleGapError)) throw error;
      requireCondition(false, 'RULE_GAP', error.message, 422, { ...error.gap });
    }
  const attributed = attributeSources({
    parts,
    sources: sources.map((source) => ({
      sourceId: source.current.sourceId,
      name: source.current.name,
      segments: source.segments,
    })),
    attribution,
    rule,
  });
  const issues: Issue[] = [...depreciation.issues, ...reports.issues, ...attributed.issues];
  const registers = new Map<string, Attributed>();
  for (const own of attributed.sources) {
    const source = sources.find((item) => item.current.sourceId === own.sourceId)!;
    if (!hasReal(source)) continue;
    const result = realSourceIncome(
      { parts: own.parts.map((part) => ({ nature: part.nature, flow: part.flow })), nonCash: [] },
      { limits: params.limits, rounding: params.rounding, eurRate, persons: 1 },
    );
    for (const issue of result.issues)
      if (!issues.some((item) => item.code === issue.code && item.message === issue.message))
        issues.push(issue);
    registers.set(own.sourceId, {
      result,
      parts: own.parts,
      normGross: own.normGross,
      shared: own.shared,
    });
  }
  const normGross = new Map(attributed.sources.map((own) => [own.sourceId, own.normGross]));
  return { registers, normGross, excluded: attributed.excluded, issues, rows };
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

/** The losses a source's owner declared from before these books, as vintages. */
const openingVintages = (input: FiscalRegisterInput, sourceId: string): LossVintage[] =>
  input.openingLosses
    .filter((item) => item.sourceId === sourceId && item.year < input.year)
    .map((item) => ({ year: item.year, bani: parseMoney(item.amount, LEDGER_CURRENCY) }));

/** What blocks a year's registers per source: an amount no rule places, a key not admitted. */
const attributionCodes = new Set([
  'PIT_SOURCE_UNATTRIBUTED',
  'PIT_SHARED_KEY',
  'PIT_LIMIT_SOURCES',
]);

/** Each earlier year of a real-system source in these books, with its net income or loss, or
 * why a year could not be computed. With several sources in an earlier year, the attribution
 * given for this year applies to it too. */
async function earlierResults(
  tx: Transaction,
  companyId: string,
  rules: RuleContext,
  source: IncomeSourceRow,
  income: number,
  eurRate: string | null,
  attribution: Attribution | null = null,
) {
  const from = Math.max(
    (await firstBooksYear(tx, companyId)) ?? income,
    Number(source.startedOn.slice(0, 4)),
  );
  const all = await sourceVersions(tx, companyId);
  const years: YearResult[] = [];
  const issues: Issue[] = [];
  for (let earlier = from; earlier < income; earlier++) {
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
    const active = activeIn(all, earlier);
    const own = active.find((item) => item.current.sourceId === source.sourceId);
    if (!own || !hasReal(own)) continue;
    const year = await yearRegisters(
      tx,
      companyId,
      rules,
      earlier,
      before,
      active,
      [],
      eurRate,
      attribution,
    );
    const blocking = year.issues.filter((issue) => attributionCodes.has(issue.code));
    if (blocking.length) {
      issues.push(
        block(
          'PIT_PRIOR_YEAR',
          `Venitul net sau pierderea sursei ${source.name} din ${earlier} nu se pot stabili pe surse (${blocking.map((issue) => issue.code).join(', ')}): pierderile reportate din acel an lipsesc din calcul.`,
        ),
      );
      continue;
    }
    const result = year.registers.get(source.sourceId)!.result;
    years.push({ year: earlier, params: before, net: result.totals.net, loss: result.totals.loss });
  }
  return { years, issues };
}

type YearResult = { year: number; params: YearParams; net: bigint; loss: bigint };

/**
 * The losses carried into a year (art. 118 alin. (4)–(5)): those declared before the books, then
 * each earlier year's, offset in turn against the next years' net income. `share` is the person's
 * part of each year's result: all of it for a PFA or an II, a member's distributed share for an
 * IF (null when the person had none that year).
 */
function carriedLosses(
  opening: LossVintage[],
  years: readonly YearResult[],
  share: (item: YearResult) => { net: bigint; loss: bigint } | null = (item) => item,
) {
  let vintages = opening;
  for (const item of years) {
    const part = share(item);
    if (!part) continue;
    vintages = part.loss
      ? [...vintages, { year: item.year, bani: part.loss }]
      : offsetLosses(item.year, part.net, vintages, item.params.loss, item.params.rounding)
          .remaining;
  }
  return vintages;
}

/** The first year these books hold: the first financial year's. */
async function firstBooksYear(tx: Transaction, companyId: string) {
  const [first] = await tx
    .select({ from: fiscalYears.from })
    .from(fiscalYears)
    .where(and(eq(fiscalYears.companyId, companyId), eq(fiscalYears.kind, 'financial')))
    .orderBy(asc(fiscalYears.from))
    .limit(1);
  return first ? year(first.from) : null;
}

/** A source's gross income of a year, in bani: the income natures placed on it, under a norm or
 * in the real system. */
async function sourceGross(
  tx: Transaction,
  companyId: string,
  income: number,
  catalogue: NatureCatalogue,
  sourceId: string,
  attribution: Attribution | null,
) {
  const { rows } = await cashJournalOf(tx, companyId, income, catalogue);
  const active = activeIn(await sourceVersions(tx, companyId), income);
  const incomeParts = rows.flatMap((row) =>
    row.parts
      .filter((part) => natureOf(part.nature)?.kind === 'income')
      .map((part) => ({
        nature: part.nature,
        account: part.account,
        flow: part.flow,
        date: row.date,
      })),
  );
  if (active.length <= 1) return { gross: incomeParts.reduce((sum, part) => sum + part.flow, 0n) };
  const attributed = attributeSources({
    parts: incomeParts,
    sources: active.map((source) => ({
      sourceId: source.current.sourceId,
      name: source.current.name,
      segments: source.segments,
    })),
    attribution,
    rule: null,
  });
  if (attributed.issues.some((issue) => issue.code === 'PIT_SOURCE_UNATTRIBUTED')) return null;
  const own = attributed.sources.find((item) => item.sourceId === sourceId);
  return {
    gross: (own?.normGross ?? 0n) + (own?.parts ?? []).reduce((sum, part) => sum + part.flow, 0n),
  };
}

/** Days of activity within a period of the year (the year itself when not given), when less than
 * all of it (art. 69 alin. (5); norme pct. 8 alin. (8)–(10)), or null for the whole year. */
function activeDays(source: IncomeSourceRow, income: number, period?: Segment) {
  const start = `${income}-01-01`;
  const end = `${income}-12-31`;
  const first = period && period.from > start ? period.from : start;
  const last = period && period.to < end ? period.to : end;
  const from = source.startedOn > first ? source.startedOn : first;
  const to = source.endedOn && source.endedOn < last ? source.endedOn : last;
  let active = Math.max(0, daysBetween(from, to));
  if (source.suspendedFrom) {
    const sFrom = source.suspendedFrom > from ? source.suspendedFrom : from;
    const sTo = source.suspendedTo && source.suspendedTo < to ? source.suspendedTo : to;
    if (sFrom <= sTo) active -= daysBetween(sFrom, sTo);
  }
  return from === start && to === end && active === daysBetween(start, end) ? null : active;
}

/** Days of the period the activity was suspended, or null when it was not. */
function interruptedDays(source: IncomeSourceRow, income: number, period?: Segment) {
  const whole = activeDays({ ...source, suspendedFrom: null, suspendedTo: null }, income, period);
  const active = activeDays(source, income, period);
  const days =
    (whole ?? (income % 4 === 0 && (income % 100 !== 0 || income % 400 === 0) ? 366 : 365)) -
    (active ?? 0);
  return active === null || days <= 0 ? null : days;
}

/**
 * The Registrul de evidență fiscală of a year (OMFP nr. 3.254/2017) and the year's income tax and
 * contributions (Codul fiscal art. 68, 69, 118, 148, 170, 174) of a PFA, II or IF: from the
 * Registrul-jurnal's natures, fiscal depreciation, expense reports and the non-cash items given;
 * losses carried from the books' earlier years and those declared before them, per source. With
 * several sources, each amount is placed on its source by the attribution given, and an expense
 * common to them split by the key the person states; a source that moved from a norm to the real
 * system during the year has its norm for the days before and its books after (norme pct. 8 alin.
 * (13)). Income the person declares from outside the books (rent, investments, dividends) counts
 * for the CASS of art. 170 alin. (2)–(3), marked as declared. Blocking issues mean the figures are
 * not final.
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
  const form = entityFormOf(loaded.profile, end);
  requireCondition(
    !individualForms.includes(form) || booksSystemOf(loaded.profile, end) === 'single',
    'PFA_DOUBLE_ENTRY',
    'Opțiunea pentru partida dublă a unei PFA, II sau IF nu este acoperită: OUG nr. 44/2008 art. 15 prevede partida simplă, iar OMFP nr. 170/2015 art. 3 o admite „cu excepția cazurilor în care … alte acte normative prevăd expres” partida simplă; se decide de expertul contabil.',
  );
  requireCondition(
    individualForms.includes(form) && booksSystemOf(loaded.profile, end) === 'single',
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
    input.previousEurAnnualRate?.evidenceId,
    ...input.previousGross.map((item) => item.evidenceId),
    input.attribution?.evidenceId,
    ...(input.attribution?.shared ?? []).map((item) => item.evidenceId),
    ...input.declaredIncome.map((item) => item.evidenceId),
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

  const all = await sourceVersions(tx, companyId);
  const active = activeIn(all, input.year);
  requireCondition(
    active.length,
    'INCOME_SOURCE',
    `Nu există o sursă de venit activă în ${input.year} (pfa.sources.record).`,
  );
  if (form === 'if' && active.length > 1)
    issues.push(
      block(
        'PIT_IF_SOURCES',
        'O întreprindere familială cu mai multe surse de venit în același an: distribuirea pe surse și D204 nu sunt încă disponibile.',
      ),
    );
  // Art. 69 alin. (7): a nomenclator activity alongside another independent activity is in the
  // real system; the norm's days may not overlap another source's real-system days.
  const mixed = active.some((source) => {
    const norm = normSegment(source);
    return (
      norm &&
      active.some(
        (other) =>
          other !== source &&
          other.segments.some(
            (segment) =>
              segment.method === 'sistem_real' &&
              segment.from <= norm.to &&
              segment.to >= norm.from &&
              other.current.startedOn <= norm.to &&
              (!other.current.endedOn || other.current.endedOn >= norm.from),
          ),
      )
    );
  });
  if (mixed)
    issues.push(
      block(
        'PIT_NORMA_MIXED',
        'O activitate din nomenclator desfășurată alături de o altă activitate independentă se impune în sistem real (art. 69 alin. (7)): înregistrați sursa pe normă în sistem real (realBasis required) de la data celeilalte activități (norme pct. 8 alin. (13)).',
      ),
    );
  if (active.length > 1 && !input.attribution)
    issues.push(
      block(
        'PIT_SOURCE_UNATTRIBUTED',
        `Mai multe surse de venit în ${input.year}: indicați, cu documentul ei, sursa fiecărui cont de venituri și cheltuieli (attribution), ca registrul să se țină pe fiecare sursă (OMFP nr. 3.254/2017 art. 3–5).`,
      ),
    );
  const eurRate = input.eurAnnualRate?.rate ?? null;
  const attribution = input.attribution ?? null;

  // The real-system sources: this year's registers, and the losses each source's earlier years
  // carry (art. 118 alin. (4): per source).
  const extra: SourcePart[] = input.adjustments.map((item) => {
    const kind = adjustmentNatures[item.kind];
    return {
      nature: kind.nature,
      account: '',
      flow: kind.sign * parseMoney(item.amount, LEDGER_CURRENCY),
      date: null,
      label: `${kind.label}: ${item.description}`,
      sourceId: item.sourceId,
    };
  });
  const year = await yearRegisters(
    tx,
    companyId,
    rules,
    input.year,
    params,
    active,
    extra,
    eurRate,
    attribution,
  );
  issues.push(...year.issues);
  const sources = [];
  let realNet = 0n;
  let recalculated = 0n;
  let norms = 0n;
  for (const source of active) {
    const { current } = source;
    const norm = normSegment(source);
    const own = year.registers.get(current.sourceId);
    let real: Record<string, unknown> | null = null;
    if (own) {
      // Losses: those declared before the books, then each earlier year of the books in turn. An
      // IF's losses are its members', each by quota: carried in each member's D212.
      let vintages: LossVintage[] = [];
      if (form !== 'if') {
        const earlier = await earlierResults(
          tx,
          companyId,
          rules,
          current,
          input.year,
          eurRate,
          attribution,
        );
        issues.push(...earlier.issues);
        vintages = carriedLosses(openingVintages(input, current.sourceId), earlier.years);
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
      real = {
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
        nonCash: own.parts
          .filter((part) => part.label)
          .map((part) => ({ nature: part.nature, label: part.label!, amount: lei(part.flow) })),
        shared: own.shared.map((item) => ({ account: item.account, amount: lei(item.bani) })),
        base: lei(own.result.base),
        totals: {
          gross: lei(own.result.totals.gross),
          deductible: lei(own.result.totals.deductible),
          net: lei(own.result.totals.net),
          loss: lei(own.result.totals.loss),
        },
        losses:
          form === 'if'
            ? null
            : {
                available: lei(losses.available),
                offset: lei(losses.offset),
                recalculated: lei(losses.recalculated),
                carried: carried.map((item) => ({ year: item.year, amount: lei(item.bani) })),
                expired: losses.expired.map((item) => ({
                  year: item.year,
                  amount: lei(item.bani),
                })),
              },
      };
    }

    // The norm (its days on a norm): the income part of the register, and the adjusted norm.
    let normView: Record<string, unknown> | null = null;
    let normRows: { nr: string; element: string; value: string }[] | null = null;
    if (norm) {
      const given = input.norms.find((item) => item.sourceId === current.sourceId);
      const gross = year.normGross.get(current.sourceId) ?? 0n;
      const normaRule = params.norma;
      if ('gap' in normaRule) requireCondition(false, 'RULE_GAP', normaRule.gap, 422);
      // Art. 69 alin. (9): gross income above 25.000 euro in the previous year (at that year's
      // BNR average rate) puts the source in the real system from this year.
      if (current.startedOn < start && norm.from === start) {
        const previous = input.year - 1;
        const declared = input.previousGross.find((item) => item.sourceId === current.sourceId);
        let before: bigint | null = null;
        if (((await firstBooksYear(tx, companyId)) ?? input.year) <= previous) {
          let catalogue: NatureCatalogue;
          try {
            catalogue = rules.param<NatureCatalogue>(
              'ro.pit.natures',
              'fiscal_year_start',
              `${previous}-01-01` as LocalDate,
            );
          } catch (error) {
            if (!(error instanceof RuleGapError)) throw error;
            requireCondition(false, 'RULE_GAP', error.message, 422, { ...error.gap });
          }
          before =
            (await sourceGross(tx, companyId, previous, catalogue, current.sourceId, attribution))
              ?.gross ?? null;
        } else if (declared) before = parseMoney(declared.amount, LEDGER_CURRENCY);
        const rate = input.previousEurAnnualRate?.rate;
        if (before === null)
          issues.push(
            block(
              'PIT_NORMA_PREVIOUS_GROSS',
              `${current.name}: registrele nu cuprind anul ${previous}, sau nu îl împart pe surse; indicați venitul brut al sursei din ${previous} (previousGross), pentru pragul de ${normaRule.realAboveEur} euro (art. 69 alin. (9)).`,
            ),
          );
        else if (!rate)
          issues.push(
            block(
              'PIT_EUR_RATE',
              `${current.name}: pragul de ${normaRule.realAboveEur} euro pentru venitul brut din ${previous} (art. 69 alin. (9)) se verifică la cursul mediu BNR al anului ${previous}: indicați-l (previousEurAnnualRate).`,
            ),
          );
        else {
          const threshold = euroToBani(normaRule.realAboveEur, rate);
          if (before > threshold)
            issues.push(
              block(
                'PIT_NORMA_REAL_REQUIRED',
                `${current.name}: venitul brut din ${previous} (${lei(before)} lei) a depășit ${normaRule.realAboveEur} euro (${lei(threshold)} lei): din ${input.year} venitul net se stabilește în sistem real (art. 69 alin. (9)). Înregistrați o versiune a sursei în sistem real (realBasis required) de la 1 ianuarie ${input.year}.`,
              ),
            );
        }
      }
      if (!given)
        issues.push(
          block(
            'PIT_NORM_MISSING',
            `${current.name}: indicați norma de venit publicată de DGRFP pentru activitate și loc, cu documentul ei.`,
          ),
        );
      else {
        // The floor (art. 69 alin. (3)): 12 minimum wages of 1 January of the income year, or,
        // before the income of 2026, of the day the DGRFP set the norm.
        let floor: bigint | null = null;
        if (normaRule.floorWage === 'january_1')
          floor = params.minimumWage * BigInt(normaRule.floorWages);
        else if (!given.setOn)
          issues.push(
            block(
              'PIT_NORM_SET_DATE',
              `${current.name}: pentru ${input.year}, norma este de cel puțin 12 salarii minime în vigoare la data stabilirii ei (art. 69 alin. (3) în forma de dinainte de Legea nr. 239/2025): indicați data deciziei DGRFP (setOn).`,
            ),
          );
        else
          try {
            floor =
              parseMoney(
                rules.param<string>(
                  'ro.payroll.minimum_wage',
                  'payroll_month_start',
                  `${given.setOn.slice(0, 7)}-01` as LocalDate,
                ),
                LEDGER_CURRENCY,
              ) * BigInt(normaRule.floorWages);
          } catch (error) {
            if (!(error instanceof RuleGapError)) throw error;
            issues.push(
              block(
                'RULE_GAP',
                `${current.name}: salariul minim în vigoare la ${given.setOn}, data stabilirii normei, nu este în registru (${error.message}).`,
              ),
            );
          }
        const days = activeDays(current, input.year, norm);
        const adjusted = adjustedNorm(
          {
            norm: parseMoney(given.norm, LEDGER_CURRENCY),
            increasePercent: given.increasePercent ?? null,
            reductionPercent: given.reductionPercent ?? null,
            activeDays: days,
            floor,
          },
          params.rounding,
        );
        issues.push(...adjusted.issues);
        if (eurRate) {
          const threshold = euroToBani(normaRule.realAboveEur, eurRate);
          const yearGross = gross + (own ? own.result.gross : 0n);
          if (!own && yearGross > threshold)
            issues.push(
              info(
                'PIT_NORMA_THRESHOLD',
                `${current.name}: venitul brut de ${lei(yearGross)} lei depășește ${normaRule.realAboveEur} euro (${lei(threshold)} lei): din ${input.year + 1} venitul net se stabilește în sistem real (art. 69 alin. (9)).`,
              ),
            );
        } else if (!own)
          issues.push(
            info(
              'PIT_EUR_RATE',
              `Pragul de ${normaRule.realAboveEur} euro al normei (art. 69 alin. (9)) se verifică la cursul mediu BNR al anului: indicați-l.`,
            ),
          );
        norms += adjusted.adjusted;
        normRows = [{ nr: '1', element: 'Venit brut', value: lei(toLeu(gross, params.rounding)) }];
        normView = {
          norm: lei(parseMoney(given.norm, LEDGER_CURRENCY)),
          increasePercent: given.increasePercent ?? null,
          increaseCriterion: given.increaseCriterion ?? null,
          reductionPercent: given.reductionPercent ?? null,
          reductionCriterion: given.reductionCriterion ?? null,
          increase: lei(adjusted.increase),
          reduction: lei(adjusted.reduction),
          yearly: lei(adjusted.yearly),
          from: norm.from,
          to: norm.to,
          activeDays: days,
          interruptedDays: interruptedDays(current, input.year, norm),
          adjusted: lei(adjusted.adjusted),
          tax: lei(incomeTax(adjusted.adjusted, params.rate, params.rounding)),
        };
      }
      if (own && norm)
        issues.push(
          info(
            'PIT_METHOD_CHANGE',
            `${current.name}: venitul net al anului este fracțiunea din normă pentru ${norm.from}–${norm.to} plus venitul net din evidența contabilă de la ${addDays(norm.to, 1)} (norme pct. 8 alin. (13)).`,
          ),
        );
    }
    if (!real && !normRows) continue;
    sources.push({
      sourceId: current.sourceId,
      name: current.name,
      caen: current.caen,
      place: current.place,
      county: current.county,
      method: current.method,
      realBasis: current.realBasis,
      segments: source.segments,
      ...(real ?? {
        register: {
          year: input.year,
          rectification: false,
          source: `${current.name} (CAEN ${current.caen}) – venituri din activități independente, normă de venit`,
          rows: normRows,
        },
      }),
      ...(normView ? { norm: normView } : {}),
      ...(real && normRows ? { normRegister: normRows } : {}),
    } as SourceView);
  }

  // An IF: the agreement in force all year, and the net income or loss distributed to the
  // members by quota (art. 125 alin. (5)). Their contributions and tax are each member's, in their
  // own declaration (art. 122 alin. (4)); on a norm nothing is distributed (art. 125 alin. (1)
  // lit. c), (10)).
  if (form === 'if') {
    // Members are needed from the day the activity starts in the year.
    const activityFrom = active
      .map(({ current }) => (current.startedOn > start ? current.startedOn : start))
      .sort()[0]!;
    const enterprise = await enterpriseYear(tx, companyId, activityFrom, end, issues);
    const [source] = sources;
    const onNorm = active.some((item) => normSegment(item));
    const distribution =
      enterprise && active.length === 1 && source?.totals && !onNorm
        ? distribute(enterprise.members, source.totals)
        : null;
    if (onNorm)
      issues.push(
        info(
          'PIT_IF_NORMA',
          'Membrii unei întreprinderi familiale impuse pe bază de normă nu primesc venit distribuit și nu depun D204: norma se stabilește pentru fiecare membru (art. 69 alin. (3), art. 125 alin. (1) lit. c) și alin. (10)).',
        ),
      );
    return {
      year: input.year,
      final: !issues.some((issue) => issue.severity === 'block'),
      sources,
      excluded: view(year.excluded.map(excludedLine)),
      enterprise: enterprise && {
        version: enterprise.version,
        effectiveFrom: enterprise.effectiveFrom,
        evidenceId: enterprise.evidenceId,
        members: enterprise.members.map((member, index) => ({
          partyId: member.partyId,
          name: member.name,
          quota: quotaText(member.quotaBp),
          representative: member.representative,
          net: distribution ? lei(distribution.net[index]!) : null,
          loss: distribution ? lei(distribution.loss[index]!) : null,
        })),
      },
      declared: [],
      contributions: null,
      tax: null,
      issues,
      parameters: [...rules.used.keys()].sort(),
    };
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
  // Income declared from outside the books: CASS of art. 170 alin. (2)–(3) on their total.
  let other: CassOtherRule | null = null;
  if (input.declaredIncome.length)
    try {
      other = rules.param<CassOtherRule>('ro.cass.other', 'fiscal_year_start', start);
    } catch (error) {
      if (!(error instanceof RuleGapError)) throw error;
      requireCondition(false, 'RULE_GAP', error.message, 422, { ...error.gap });
    }
  const person = personTax(params, {
    realNet,
    recalculated,
    norms,
    other: input.otherIncome ? parseMoney(input.otherIncome.amount, LEDGER_CURRENCY) : 0n,
    status: status ?? 'liable',
    option: profileAt(loaded, 'cas.option', end) === 'yes',
    chosen: input.casIncome ? parseMoney(input.casIncome, LEDGER_CURRENCY) : null,
    exception: Boolean(exception && exception !== 'none'),
    declared: other
      ? {
          rule: other,
          amount: input.declaredIncome.reduce(
            (sum, item) => sum + parseMoney(item.amount, LEDGER_CURRENCY),
            0n,
          ),
          withheld: input.declaredIncome.reduce(
            (sum, item) => sum + parseMoney(item.cassWithheld, LEDGER_CURRENCY),
            0n,
          ),
        }
      : null,
  });
  issues.push(...person.issues);
  return {
    year: input.year,
    final: !issues.some((issue) => issue.severity === 'block'),
    sources,
    excluded: view(year.excluded.map(excludedLine)),
    enterprise: null,
    declared: input.declaredIncome.map((item) => ({
      declared: true as const,
      kind: item.kind,
      amount: lei(parseMoney(item.amount, LEDGER_CURRENCY)),
      cassWithheld: lei(parseMoney(item.cassWithheld, LEDGER_CURRENCY)),
      taxSettled: item.taxSettled,
      description: item.description,
      evidenceId: item.evidenceId,
    })),
    contributions: person.contributions,
    tax: person.tax,
    issues,
    parameters: [...rules.used.keys()].sort(),
  };
}

/** A source of the register's result: its real-system part, its norm, or both. */
type SourceView = {
  sourceId: string;
  name: string;
  caen: string;
  place: string;
  county: string;
  method: 'sistem_real' | 'norma';
  realBasis: 'required' | 'option' | null;
  segments: Segment[];
  register: { year: number; rectification: boolean; source: string; rows: unknown[] };
  totals?: { gross: string; deductible: string; net: string; loss: string };
  losses?: {
    available: string;
    offset: string;
    recalculated: string;
    carried: { year: number; amount: string }[];
    expired: { year: number; amount: string }[];
  } | null;
  norm?: {
    norm: string;
    increasePercent: string | null;
    increaseCriterion: NormCriterion | null;
    reductionPercent: string | null;
    reductionCriterion: NormCriterion | null;
    increase: string;
    reduction: string;
    yearly: string;
    from: string;
    to: string;
    activeDays: number | null;
    interruptedDays: number | null;
    adjusted: string;
    tax: string;
  };
  normRegister?: { nr: string; element: string; value: string }[];
  [key: string]: unknown;
};

/** An amount no source takes, listed apart (assets, non-deductible items of shared accounts). */
const excludedLine = (part: SourcePart) => ({
  nature: part.nature,
  label: natureOf(part.nature)?.label ?? part.nature,
  bani: part.flow < 0n ? -part.flow : part.flow,
});

/**
 * A person's contributions and income tax for the year (art. 118, 148, 170, 174, 69^2): CAS and
 * CASS on the cumulated net incomes and norms, the share of each deducted from the real system's
 * recalculated net income, 10% on the taxable income and on the norms; and the CASS of the income
 * the person declares from outside the books (art. 170 alin. (2)–(3)), which also lifts the CASS
 * minimum of the independent income when due on at least 6 minimum wages (art. 174 alin. (7) lit.
 * b)).
 */
function personTax(
  params: YearParams,
  input: {
    realNet: bigint;
    recalculated: bigint;
    norms: bigint;
    other: bigint;
    status: CasStatus;
    option: boolean;
    chosen: bigint | null;
    exception: boolean;
    declared?: { rule: CassOtherRule; amount: bigint; withheld: bigint } | null;
  },
) {
  const cumulated = input.realNet + input.norms + input.other;
  const cas = casDue(
    { cumulated, status: input.status, option: input.option, chosen: input.chosen },
    {
      minimumWage: params.minimumWage,
      rate: params.casRate,
      rule: params.cas,
      rounding: params.rounding,
    },
  );
  const declared = input.declared
    ? cassOtherDue(
        { cumulated: input.declared.amount, withheld: input.declared.withheld },
        {
          minimumWage: params.minimumWage,
          rate: params.cassRate,
          rule: input.declared.rule,
          rounding: params.rounding,
        },
      )
    : null;
  const lifted = Boolean(
    declared && declared.base >= params.minimumWage * BigInt(params.cass.minimumWages),
  );
  const issues = [...cas.issues];
  if (lifted && !input.exception)
    issues.push(
      info(
        'CASS_EXCEPTION_DECLARED',
        'Veniturile declarate din afara registrelor datorează CASS la cel puțin 6 salarii minime: diferența până la CASS minimă pentru venitul din activități independente nu se datorează (art. 174 alin. (7) lit. b)).',
      ),
    );
  const cass = cassDue(
    { cumulated, exception: input.exception || lifted },
    {
      minimumWage: params.minimumWage,
      rate: params.cassRate,
      rule: params.cass,
      rounding: params.rounding,
    },
  );
  const deducted = deductibleContributions(
    {
      realNet: input.realNet,
      recalculated: input.recalculated,
      cas: { due: cas.due, cumulated },
      cass: { due: cass.due, minimumDifference: cass.minimumDifference, cumulated },
    },
    params.rounding,
  );
  const taxable = input.recalculated - deducted.cas - deducted.cass;
  const realTax = incomeTax(taxable, params.rate, params.rounding);
  const normaTax = input.norms > 0n ? incomeTax(input.norms, params.rate, params.rounding) : 0n;
  return {
    issues,
    contributions: {
      minimumWage: lei(params.minimumWage),
      cumulated: lei(cumulated),
      cas: {
        status: input.status,
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
      cassOther: declared && {
        declared: true as const,
        cumulated: lei(input.declared!.amount),
        band: declared.band,
        base: lei(declared.base),
        due: lei(declared.due),
        withheld: lei(input.declared!.withheld),
        plus: lei(declared.plus),
        minus: lei(declared.minus),
      },
    },
    tax: {
      recalculated: lei(input.recalculated),
      taxable: lei(taxable > 0n ? taxable : 0n),
      real: lei(realTax),
      norma: lei(normaTax),
      total: lei(realTax + normaTax),
    },
  };
}

/**
 * The family enterprise's members for an income year: the one agreement in force from the day the
 * activity starts in the year (`start`) to its end, complete (at least 2 members, quotas adding to
 * 100%, one representative). A change in the year or an incomplete agreement is a blocking issue,
 * and so null.
 */
async function enterpriseYear(
  tx: Transaction,
  companyId: string,
  start: string,
  end: string,
  issues: Issue[],
) {
  const inYear = agreementsIn(await agreements(tx, companyId), start, end);
  if (!inYear.length) {
    issues.push(
      block(
        'PIT_IF_MEMBERS',
        'Înregistrați membrii întreprinderii familiale, cu cotele și reprezentantul din acordul de constituire (if.members.record).',
      ),
    );
    return null;
  }
  if (inYear.length > 1 || inYear[0]!.effectiveFrom > start) {
    issues.push(
      block(
        'PIT_IF_MEMBERS_CHANGE',
        inYear.length > 1
          ? 'Acordul întreprinderii familiale s-a schimbat în cursul anului: distribuirea venitului pe perioade nu este încă disponibilă.'
          : `Activitatea începe la ${start}, iar acordul de constituire se aplică din ${inYear[0]!.effectiveFrom}: membrii nu sunt cunoscuți pentru tot anul.`,
      ),
    );
    if (inYear.length > 1) return null;
  }
  const [agreement] = inYear;
  const total = agreement!.members.reduce((sum, member) => sum + member.quotaBp, 0);
  if (
    agreement!.members.length < 2 ||
    total !== 10_000 ||
    agreement!.members.filter((member) => member.representative).length !== 1
  ) {
    issues.push(
      block(
        'PIT_IF_MEMBERS_INCOMPLETE',
        `Acordul în vigoare are ${agreement!.members.length} membri și cote de ${quotaText(total)}%: sunt necesari cel puțin 2 membri, cote de 100% și un reprezentant.`,
      ),
    );
    return null;
  }
  const names = new Map(
    (
      await tx
        .select({ id: parties.id, name: parties.name })
        .from(parties)
        .where(
          and(
            eq(parties.companyId, companyId),
            inArray(
              parties.id,
              agreement!.members.map((member) => member.partyId),
            ),
          ),
        )
    ).map((row) => [row.id, row.name]),
  );
  return {
    ...agreement!,
    members: agreement!.members.map((member) => ({
      ...member,
      name: names.get(member.partyId) ?? '',
    })),
  };
}

/** The net income or the loss in whole lei, distributed by the members' quotas. */
function distribute(
  members: readonly { quotaBp: number }[],
  totals: { net: string; loss: string },
) {
  const quotas = members.map((member) => member.quotaBp);
  return {
    net: distributeByQuota(parseMoney(totals.net, LEDGER_CURRENCY), quotas),
    loss: distributeByQuota(parseMoney(totals.loss, LEDGER_CURRENCY), quotas),
  };
}

export const memberStatusInput = z
  .object({
    /** The member's situation for CAS at the year's end (art. 148, 150). */
    casStatus: z.enum(['liable', 'pensioner', 'own_system']),
    /** The member opted to pay CAS below the threshold (art. 148 alin. (4)). */
    casOption: z.boolean().default(false),
    /** The member's exception from the CASS minimum (art. 174 alin. (7)–(8)). */
    cassException: z.enum(['none', 'salary', 'other_income', 'pension', 'previous_year']),
    /** The income the member chooses as the CAS base (art. 148 alin. (2)). */
    casIncome: money.optional(),
  })
  .strict();

/**
 * A family enterprise member's year: the net income or loss distributed to them by quota from
 * the enterprise's register (art. 125 alin. (5)), their own losses carried (those declared before
 * the books, then their shares of the books' earlier years: art. 118 alin. (5), losses are
 * personal), and their contributions and tax on it, from the member's own situation. Only the
 * enterprise's income counts: a member's other income is declared with it and refused here.
 */
export async function memberYear(
  tx: Transaction,
  companyId: string,
  input: FiscalRegisterInput,
  rules: RuleContext,
  partyId: string,
  member: z.infer<typeof memberStatusInput>,
) {
  const register = await fiscalRegister(tx, companyId, input, rules);
  const issues: Issue[] = [...register.issues];
  const members = register.enterprise?.members ?? [];
  const index = members.findIndex((item) => item.partyId === partyId);
  const share = members[index];
  const [source] = register.sources;
  if (register.enterprise && index < 0)
    issues.push(
      block(
        'PIT_IF_MEMBER',
        'Persoana nu este membru al întreprinderii familiale în acordul în vigoare în anul declarat.',
      ),
    );
  if (!share?.net || !share.loss || !source?.totals) return { register, share: null, issues };

  const params = yearParams(rules, input.year);
  const net = parseMoney(share.net, LEDGER_CURRENCY);
  const loss = parseMoney(share.loss, LEDGER_CURRENCY);
  // The member's losses: declared before the books, then their shares of the earlier years.
  const versions = (await sourceVersions(tx, companyId)).get(source.sourceId)!;
  const earlier = await earlierResults(
    tx,
    companyId,
    rules,
    versionAt(versions, `${input.year}-12-31`) ?? versions[0]!,
    input.year,
    input.eurAnnualRate?.rate ?? null,
  );
  issues.push(...earlier.issues);
  const all = await agreements(tx, companyId);
  const vintages = carriedLosses(openingVintages(input, source.sourceId), earlier.years, (item) => {
    const inYear = agreementsIn(all, `${item.year}-01-01`, `${item.year}-12-31`);
    const holder = inYear[0]?.members.findIndex((row) => row.partyId === partyId) ?? -1;
    if (inYear.length !== 1) {
      issues.push(
        block(
          'PIT_PRIOR_YEAR',
          `${inYear.length ? `Acordul întreprinderii familiale s-a schimbat în ${item.year}` : `Membrii întreprinderii familiale din ${item.year} nu sunt înregistrați`}: partea membrului din pierderea sau venitul net al acelui an nu se poate stabili.`,
        ),
      );
      return null;
    }
    if (holder < 0) return null;
    const quotas = inYear[0]!.members.map((row) => row.quotaBp);
    return {
      net: distributeByQuota(item.net, quotas)[holder]!,
      loss: distributeByQuota(item.loss, quotas)[holder]!,
    };
  });
  const losses = offsetLosses(input.year, net, vintages, params.loss, params.rounding);
  const person = personTax(params, {
    realNet: net,
    recalculated: losses.recalculated,
    norms: 0n,
    other: 0n,
    status: member.casStatus,
    option: member.casOption,
    chosen: member.casIncome ? parseMoney(member.casIncome, LEDGER_CURRENCY) : null,
    exception: member.cassException !== 'none',
  });
  issues.push(...person.issues);
  return {
    register,
    share: {
      partyId,
      quota: share.quota,
      net,
      loss,
      losses: {
        available: lei(losses.available),
        offset: lei(losses.offset),
        recalculated: lei(losses.recalculated),
        carried: [...losses.remaining, ...(loss ? [{ year: input.year, bani: loss }] : [])].map(
          (item) => ({ year: item.year, amount: lei(item.bani) }),
        ),
        expired: losses.expired.map((item) => ({ year: item.year, amount: lei(item.bani) })),
      },
      contributions: person.contributions,
      tax: person.tax,
    },
    issues,
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
