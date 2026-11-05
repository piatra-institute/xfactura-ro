import { and, asc, eq, gte, lt, lte, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { recordedAt } from 'xfactura-core/ro/determinations';
import { formatMoney } from 'xfactura-core/money';
import {
  capitalGoodAdjustment,
  immovableAsset,
  lateRegistrationExposure,
  tangibleAsset,
  type CapitalGoodsRule,
  type Exposure,
} from 'xfactura-core/ro/nonpayers';
import { obligationDue } from 'xfactura-core/ro/obligations';
import { RuleGapError, type RuleContext } from 'xfactura-core/rules';
import { addDays, bucharestDate, monthEnd, type LocalDate, type Month } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import { assetEvents, assets, documents, entries, lines, taxEntries } from '../db/schema';
import type { Actor, Commands } from '../kernel/commands';
import { determinationsOf } from './determinations';

/*
 * The non-payers' view of a year (docs/ACCOUNTING_ENGINE.md, "Non-payers"): when the
 * small-enterprise threshold was exceeded and by which invoice, the registration it made due and
 * whether the books show it late, the VAT owed for the period the normal regime should have
 * applied (art. 310 alin. (6^1)–(6^2)) with what a person still decides, the first VAT period
 * after registration, and, for a cancellation, the last return and the capital goods'
 * adjustment. Computed on read: the bookings are `vat.lateRegistration` and `vat.capitalGoods`.
 */

export const registrationInput = z.object({ year: z.number().int().min(2016).max(2100) }).strict();

const money = (bani: bigint) => formatMoney(bani, 'RON');
const exposureView = (exposure: Exposure) => ({
  from: exposure.from,
  until: exposure.until,
  consideration: money(exposure.considerationBani),
  inclusive: {
    base: money(exposure.collected.inclusive.baseBani),
    vat: money(exposure.collected.inclusive.vatBani),
  },
  added: {
    base: money(exposure.collected.added.baseBani),
    vat: money(exposure.collected.added.vatBani),
  },
  deductible: money(exposure.deductibleBani),
  undecided: exposure.undecided,
  net: exposure.net
    ? { inclusive: money(exposure.net.inclusive), added: money(exposure.net.added) }
    : null,
  lines: exposure.lines,
});

const goodView = z.object({
  assetId: z.string(),
  number: z.string(),
  documentId: z.string().nullable(),
  taxPeriod: z.string().nullable(),
  adjustment: z.string().nullable(),
  line: z.string(),
});
export const registrationView = z.object({
  year: z.number(),
  status: z.string().nullable(),
  threshold: z.object({
    limit: z.string().nullable(),
    crossed: z.string().nullable(),
    transaction: z
      .object({ documentId: z.string(), number: z.string().nullable(), date: z.string() })
      .nullable(),
  }),
  registration: z.object({
    /** Due by the crossing day, valid from it (art. 310 alin. (6), art. 316 alin. (1^1)). */
    due: z.string().nullable(),
    recorded: z.string().nullable(),
    /** `not_required`, `due`, `overdue` (not recorded after the crossing day), `on_time` (no
     * sale without VAT after it), `late` (the books hold such sales: VAT owed). */
    state: z.enum(['not_required', 'due', 'overdue', 'on_time', 'late']),
    firstPeriod: z.string().nullable(),
    vatPeriod: z.string().nullable(),
  }),
  exposure: z.unknown().nullable(),
  sameDayBefore: z.array(z.object({ documentId: z.string(), number: z.string().nullable() })),
  purchases: z.array(
    z.object({ documentId: z.string(), number: z.string(), date: z.string(), vat: z.string() }),
  ),
  capitalGoods: z.array(goodView),
  deregistration: z
    .object({
      date: z.string(),
      eligible: z.boolean().nullable(),
      lastReturn: z.object({ period: z.string(), due: z.string().nullable() }),
      capitalGoods: z.array(goodView),
      total: z.string().nullable(),
    })
    .nullable(),
  unsupported: z.array(z.object({ code: z.string(), message: z.string() })),
  lines: z.array(z.string()),
});

const lineEntry = and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId));

/** Each revenue entry on 70x of a day, in posting order, with the document it booked. */
async function dayRevenue(tx: Transaction, companyId: string, date: string) {
  return tx
    .select({
      seq: entries.seq,
      subject: sql<string | null>`(select p.subject_key from acc_proposals p
        where p.company_id = ${entries.companyId} and p.id = ${entries.proposalId})`,
      bani: sql<bigint>`sum(CASE WHEN ${lines.side} = 'C' THEN ${lines.bani} ELSE -${lines.bani} END)`.mapWith(
        BigInt,
      ),
    })
    .from(lines)
    .innerJoin(entries, lineEntry)
    .where(
      and(
        eq(lines.companyId, companyId),
        eq(entries.date, date),
        sql`substr(${lines.account}, 1, 2) = '70'`,
        ne(entries.journalCode, 'INCHIDERE'),
      ),
    )
    .groupBy(entries.seq, entries.proposalId)
    .orderBy(asc(entries.seq));
}

/** The sales without VAT from a day on: documents booked with no S-… or EXP-… output entry. */
async function nonPayerSales(tx: Transaction, companyId: string, from: string) {
  return tx
    .select({ id: documents.id, number: documents.number, date: documents.docDate })
    .from(documents)
    .where(
      and(
        eq(documents.companyId, companyId),
        eq(documents.kind, 'invoice.issued'),
        gte(documents.docDate, from),
        sql`exists (select 1 from acc_proposals p join acc_entries e on e.company_id = p.company_id
          and e.proposal_id = p.id where p.company_id = ${documents.companyId}
          and p.subject_key = 'document:' || ${documents.id})`,
        sql`not exists (select 1 from ${taxEntries} t where t.company_id = ${documents.companyId}
          and t.document_id = ${documents.id} and t.direction = 'output'
          and (t.code like 'S-%' or t.code like 'EXP-%'))`,
      ),
    )
    .orderBy(asc(documents.docDate));
}

const sumOf = <T>(rows: readonly T[], value: (row: T) => bigint) =>
  rows.reduce((total, row) => total + value(row), 0n);

/** The tangible fixed assets held on a day, with their acquisition invoice's VAT. */
async function capitalGoodsOn(tx: Transaction, companyId: string, date: string) {
  const held = await tx
    .select()
    .from(assets)
    .where(and(eq(assets.companyId, companyId), lt(assets.commissionedOn, date)));
  const disposed = await tx
    .select({ assetId: assetEvents.assetId, date: assetEvents.date })
    .from(assetEvents)
    .where(and(eq(assetEvents.companyId, companyId), eq(assetEvents.kind, 'disposed')));
  const goods = [];
  for (const asset of held.filter(
    (row) =>
      tangibleAsset(row.account) &&
      !disposed.some((event) => event.assetId === row.id && event.date < date),
  )) {
    const vat = asset.documentId
      ? await tx
          .select()
          .from(taxEntries)
          .where(
            and(
              eq(taxEntries.companyId, companyId),
              eq(taxEntries.documentId, asset.documentId),
              eq(taxEntries.direction, 'input'),
              sql`${taxEntries.code} like 'S-%'`,
            ),
          )
      : [];
    goods.push({ asset, vat });
  }
  return goods;
}

/** A year's registration, exposure and cancellation, from the books and the determinations. */
export async function registrationOf(
  tx: Transaction,
  companyId: string,
  year: number,
  rules: RuleContext,
  today: LocalDate,
) {
  const { context, determinations } = await determinationsOf(tx, companyId, year, rules, today);
  const facts = context.facts;
  const first = (context.activity.start ?? `${year}-01-01`) as LocalDate;
  const unsupported: { code: string; message: string }[] = [];
  const out: string[] = [];
  const param = <T>(
    key: string,
    axis: Parameters<RuleContext['param']>[1],
    date: string,
    scope?: Record<string, string>,
  ) => {
    try {
      return rules.param<T>(key, axis, date as LocalDate, scope);
    } catch (error) {
      if (!(error instanceof RuleGapError)) throw error;
      unsupported.push({ code: 'RULE_GAP', message: error.message });
      return null;
    }
  };
  const threshold = determinations.find((item) => item.axis === 'vat.threshold');
  const crossed =
    (threshold?.changes.find((change) => change.value === 'exceeded')?.effectiveFrom as
      LocalDate | undefined) ?? null;
  const limit = param<string>(
    'ro.vat.exemption.threshold',
    'reporting_period_start',
    `${year}-01-01`,
  );
  const period = determinations.find((item) => item.axis === 'vat.period');
  const recorded =
    facts
      .filter(
        (fact) =>
          fact.axis === 'vat.status' &&
          fact.value === 'normal_vat' &&
          fact.effectiveFrom >= first &&
          fact.effectiveFrom <= `${year}-12-31` &&
          recordedAt(facts, 'vat.status', addDays(fact.effectiveFrom, -1)) !== 'normal_vat',
      )
      .map((fact) => fact.effectiveFrom)
      .sort()[0] ?? null;

  let transaction: { documentId: string; number: string | null; date: string } | null = null;
  const sameDayBefore: { documentId: string; number: string | null }[] = [];
  let exposure: Exposure | null = null;
  let purchases: { documentId: string; number: string; date: string; vat: string }[] = [];
  let state: z.infer<typeof registrationView>['registration']['state'] = 'not_required';
  const capitalGoods: z.infer<typeof goodView>[] = [];
  if (crossed && limit) {
    // The transaction that exceeds the threshold, within its day (art. 310 alin. (6)): the
    // supplies before it that day may stay exempt.
    const before = context.activity.days
      .filter((day) => day.date >= first && day.date < crossed)
      .reduce((sum, day) => sum + day.exemption, 0n);
    let running = before;
    const ids = (subject: string | null) => subject?.replace(/^document:/, '') ?? '';
    for (const row of await dayRevenue(tx, companyId, crossed)) {
      running += row.bani;
      const [document] = await tx
        .select({ number: documents.number })
        .from(documents)
        .where(and(eq(documents.companyId, companyId), eq(documents.id, ids(row.subject))));
      if (running > BigInt(limit) * 100n) {
        transaction = {
          documentId: ids(row.subject),
          number: document?.number ?? null,
          date: crossed,
        };
        break;
      }
      sameDayBefore.push({ documentId: ids(row.subject), number: document?.number ?? null });
    }
    const sales = await nonPayerSales(tx, companyId, crossed);
    const until = (sales.at(-1)?.date as LocalDate | undefined) ?? null;
    state = !recorded ? (today > crossed ? 'overdue' : 'due') : until ? 'late' : 'on_time';
    out.push(
      `Plafonul de ${limit} lei este depășit la ${crossed}${transaction ? ` prin factura ${transaction.number ?? transaction.documentId}` : ''}: înregistrarea se solicită cel târziu atunci și este valabilă de la această dată (art. 310 alin. (6), art. 316 alin. (1) lit. b), alin. (1^1) lit. b)).`,
    );
    if (recorded && recorded !== crossed)
      out.push(
        `Înregistrarea consemnată este valabilă de la ${recorded}, nu de la data depășirii: o decizie cu altă dată se confirmă cu documentul (determinarea vat.status).`,
      );
    if (until) {
      // The period the normal regime should have applied: revenue on 70x, supplies abroad and
      // the purchases with VAT booked without deduction.
      const [revenue] = await tx
        .select({
          bani: sql<bigint>`coalesce(sum(CASE WHEN ${lines.side} = 'C' THEN ${lines.bani} ELSE -${lines.bani} END), 0)`.mapWith(
            BigInt,
          ),
        })
        .from(lines)
        .innerJoin(entries, lineEntry)
        .where(
          and(
            eq(lines.companyId, companyId),
            gte(entries.date, crossed),
            lte(entries.date, until),
            sql`substr(${lines.account}, 1, 2) = '70'`,
            ne(entries.journalCode, 'INCHIDERE'),
          ),
        );
      const range = await tx
        .select()
        .from(taxEntries)
        .where(
          and(
            eq(taxEntries.companyId, companyId),
            eq(taxEntries.tax, 'VAT'),
            gte(taxEntries.taxPoint, crossed),
            lte(taxEntries.taxPoint, until),
          ),
        );
      const abroad = sumOf(
        range.filter((row) => row.direction === 'output' && row.code.startsWith('EXP-')),
        (row) => row.baseBani,
      );
      const bought = new Map<string, typeof range>();
      for (const row of range)
        if (
          row.direction === 'input' &&
          row.code.startsWith('S-') &&
          row.taxBani !== 0n &&
          row.deductibleBani === 0n &&
          row.documentId
        )
          bought.set(row.documentId, [...(bought.get(row.documentId) ?? []), row]);
      // The supplies of the crossing day booked before the transaction that exceeds the
      // threshold stay exempt unless the company taxes them too (art. 310 alin. (6)).
      const excludedBani = (await dayRevenue(tx, companyId, crossed))
        .filter((row) =>
          sameDayBefore.some((item) => `document:${item.documentId}` === row.subject),
        )
        .reduce((sum, row) => sum + row.bani, 0n);
      const rate = param<string>('ro.vat.rate', 'vat_chargeability_date', crossed, {
        category: 'S',
      });
      const share = param<string>('ro.vat.deduction.limited', 'vat_chargeability_date', crossed);
      if (rate && share)
        exposure = lateRegistrationExposure({
          from: crossed,
          until,
          revenueBani: revenue?.bani ?? 0n,
          abroadBani: abroad,
          excludedBani,
          rate,
          limitedShare: share,
          purchases: [...bought].map(([documentId, rows]) => {
            const attributes = JSON.parse(rows[0]!.attributes) as Record<string, string>;
            return {
              documentId,
              number: attributes.number ?? documentId,
              taxPoint: rows[0]!.taxPoint as LocalDate,
              baseBani: sumOf(rows, (row) => row.baseBani),
              vatBani: sumOf(rows, (row) => row.taxBani),
              deduction: null,
            };
          }),
        });
      purchases = [...bought].map(([documentId, rows]) => ({
        documentId,
        number: (JSON.parse(rows[0]!.attributes) as Record<string, string>).number ?? documentId,
        date: rows[0]!.taxPoint,
        vat: money(sumOf(rows, (row) => row.taxBani)),
      }));
      out.push(
        `Registrele țin firma în afara TVA până la ${until} (${sales.length} facturi fără TVA după ${crossed}): TVA datorată pentru înregistrarea întârziată (art. 310 alin. (6^1)–(6^2)) se înregistrează cu vat.lateRegistration.`,
      );
    }
    // Stock and assets in progress at the change: their deduction (art. 304) is not covered.
    const [stock] = await tx
      .select({
        bani: sql<bigint>`coalesce(sum(CASE WHEN ${lines.side} = 'D' THEN ${lines.bani} ELSE -${lines.bani} END), 0)`.mapWith(
          BigInt,
        ),
      })
      .from(lines)
      .innerJoin(entries, lineEntry)
      .where(
        and(
          eq(lines.companyId, companyId),
          lt(entries.date, crossed),
          sql`(substr(${lines.account}, 1, 1) = '3' or substr(${lines.account}, 1, 3) = '231')`,
        ),
      );
    if ((stock?.bani ?? 0n) !== 0n)
      unsupported.push({
        code: 'STOCK_ADJUSTMENT',
        message: `La ${crossed} registrele au stocuri sau imobilizări în curs: dreptul de deducere pentru ele (art. 304, norme pct. 83 alin. (11) lit. a)) nu este acoperit.`,
      });
    const rule = param<CapitalGoodsRule>('ro.vat.capital_goods', 'vat_chargeability_date', crossed);
    for (const { asset, vat } of await capitalGoodsOn(tx, companyId, crossed)) {
      const preview =
        rule && vat.length
          ? capitalGoodAdjustment(
              {
                assetId: asset.id,
                number: asset.number,
                name: asset.name,
                immovable: immovableAsset(asset),
                acquiredOn: vat.map((row) => row.taxPoint).sort()[0] as LocalDate,
                vatBani: sumOf(vat, (row) => row.taxBani),
                deductedBani: sumOf(vat, (row) => row.deductibleBani),
              },
              'registration',
              crossed,
              rule,
            )
          : null;
      capitalGoods.push({
        assetId: asset.id,
        number: asset.number,
        documentId: asset.documentId,
        taxPeriod: vat[0]?.taxPeriod ?? null,
        adjustment: preview ? money(preview.bani) : null,
        line:
          preview?.line ??
          `${asset.number} ${asset.name}: fără factură de achiziție cu TVA în registre; ajustarea nu se poate calcula.`,
      });
    }
  }

  // Leaving VAT during the year (art. 310 alin. (7), art. 316 alin. (11) lit. g), (13)).
  const status = determinations.find((item) => item.axis === 'vat.status');
  const cancelled = facts.find(
    (fact) =>
      fact.axis === 'vat.status' &&
      fact.value === 'non_vat' &&
      fact.effectiveFrom > first &&
      fact.effectiveFrom <= `${year}-12-31` &&
      recordedAt(facts, 'vat.status', addDays(fact.effectiveFrom, -1)) === 'normal_vat',
  );
  let deregistration: z.infer<typeof registrationView>['deregistration'] = null;
  if (cancelled) {
    const date = cancelled.effectiveFrom as LocalDate;
    const last = addDays(date, -1);
    const quarterly = recordedAt(facts, 'vat.period', last) === 'quarterly';
    const label = quarterly
      ? `${last.slice(0, 4)}-Q${Math.ceil(Number(last.slice(5, 7)) / 3)}`
      : last.slice(0, 7);
    let due: string | null = null;
    try {
      const month = date.slice(0, 7) as Month;
      due = obligationDue(
        'D300',
        { start: `${month}-01` as LocalDate, end: monthEnd(month) },
        rules,
      ).due;
    } catch (error) {
      if (!(error instanceof RuleGapError)) throw error;
    }
    const eligible =
      status?.status === 'proposed'
        ? status.changes.some(
            (change) => change.value === 'non_vat' && change.effectiveFrom === date,
          )
        : null;
    const rule = param<CapitalGoodsRule>('ro.vat.capital_goods', 'vat_chargeability_date', date);
    const goods: z.infer<typeof goodView>[] = [];
    let total = 0n;
    for (const { asset, vat } of await capitalGoodsOn(tx, companyId, date)) {
      const preview =
        rule && vat.length
          ? capitalGoodAdjustment(
              {
                assetId: asset.id,
                number: asset.number,
                name: asset.name,
                immovable: immovableAsset(asset),
                acquiredOn: vat.map((row) => row.taxPoint).sort()[0] as LocalDate,
                vatBani: sumOf(vat, (row) => row.taxBani),
                deductedBani: sumOf(vat, (row) => row.deductibleBani),
              },
              'deregistration',
              date,
              rule,
            )
          : null;
      total += preview?.bani ?? 0n;
      goods.push({
        assetId: asset.id,
        number: asset.number,
        documentId: asset.documentId,
        taxPeriod: vat[0]?.taxPeriod ?? null,
        adjustment: preview ? money(preview.bani) : null,
        line:
          preview?.line ??
          `${asset.number} ${asset.name}: fără factură de achiziție cu TVA în registre; ajustarea nu se poate calcula.`,
      });
    }
    const [others] = await tx
      .select({ accounts: sql<string | null>`group_concat(distinct ${lines.account})` })
      .from(lines)
      .innerJoin(entries, lineEntry)
      .where(
        and(
          eq(lines.companyId, companyId),
          lt(entries.date, date),
          sql`(substr(${lines.account}, 1, 1) = '3' or substr(${lines.account}, 1, 3) in ('231', '471')
            or substr(${lines.account}, 1, 4) in ('4091', '4092'))`,
        ),
      );
    if (others?.accounts)
      unsupported.push({
        code: 'OTHER_ADJUSTMENTS',
        message: `Registrele au avut mișcări pe ${others.accounts}: ajustarea taxei pentru stocuri, active în curs, servicii neutilizate și avansuri la anularea înregistrării (art. 304, norme pct. 83 alin. (7) lit. a) și d)) nu este acoperită; vat.capitalGoods o refuză cât timp soldurile nu sunt zero.`,
      });
    out.push(
      `Anularea înregistrării de la ${date}: ultimul decont (${label}) se depune până la ${due ?? '—'} și cuprinde ajustările (art. 310 alin. (7), art. 316 alin. (13)); bunurile de capital: ${money(total)} lei (art. 305 alin. (5) lit. a)), cu vat.capitalGoods.`,
    );
    deregistration = {
      date,
      eligible,
      lastReturn: { period: label, due },
      capitalGoods: goods,
      total: rule ? money(total) : null,
    };
  }

  return {
    year,
    status: recordedAt(facts, 'vat.status', first),
    threshold: { limit, crossed, transaction },
    registration: {
      due: crossed,
      recorded,
      state,
      firstPeriod: recorded ?? null,
      vatPeriod:
        period?.status === 'proposed' && recorded && period.effectiveFrom === recorded
          ? period.value
          : null,
    },
    exposure: exposure ? exposureView(exposure) : null,
    sameDayBefore,
    purchases,
    capitalGoods,
    deregistration,
    unsupported,
    lines: out,
  };
}

export class Registrations {
  constructor(
    private readonly commands: Commands,
    private readonly rules: (tx: Transaction, companyId: string) => Promise<RuleContext>,
    private readonly clock: () => number = Date.now,
  ) {}

  view(actor: Actor, input: z.infer<typeof registrationInput>) {
    return this.commands.read(actor, 'vat.registration', async (tx) =>
      registrationOf(
        tx,
        actor.companyId,
        input.year,
        await this.rules(tx, actor.companyId),
        bucharestDate(this.clock()),
      ),
    );
  }
}
