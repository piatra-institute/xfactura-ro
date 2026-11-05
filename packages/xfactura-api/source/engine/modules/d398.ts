import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Party } from 'xfactura-core/einvoice';
import type { ReadSetEntry } from 'xfactura-core/kernel';
import { divRound, parseScaled } from 'xfactura-core/money';
import {
  checkD398,
  writeD398,
  type D398,
  type D398Correction,
  type D398Supply,
} from 'xfactura-core/ro/declarations/d398';
import { obligationDue } from 'xfactura-core/ro/obligations';
import { ossCode, quarterRange, type OssReturnRule } from 'xfactura-core/ro/oss';
import { RuleGapError, type RuleContext } from 'xfactura-core/rules';
import type { LocalDate } from 'xfactura-core/time';
import type { ObjectStore } from '../adapters/object-store';
import type { Transaction } from '../db/database';
import {
  artifactEvents,
  artifacts,
  companies,
  entries,
  evidence,
  fiscalYears,
  profileFacts,
  questionAnswers,
  questions,
  taxEntries,
} from '../db/schema';
import { sellerDetails } from './d300';
import type { DeclarationKind, DeclarationProblem } from './declarations';

/*
 * The Union scheme's special VAT return (form 398, Codul fiscal art. 315 alin. (6)–(13)) of a
 * quarter, from the books: the sales declared in the scheme (`EXP-OSS` tax entries of
 * `invoices.euConsumer`) whose supply is in the quarter, per Member State of consumption, supply
 * type, rate type and rate, in euro (a sale in another currency at the ECB's rate of the
 * quarter's last day, or the next publication, alin. (12)); and the corrections of earlier
 * quarters (alin. (11)): what the books now hold for a quarter whose return the engine
 * authorized, against what it and the later returns declared for it, per state. A credit note
 * counts in the quarter of its sale, so a refund after the quarter's return is a correction of
 * it. ANAF's structure admits no rectifying return. Authorizing it locks no tax ledger: a sale
 * booked late is a correction in the next return.
 */

export const d398Options = z
  .object({
    /** The ECB's reference rates (eurofxref XML, `evidence.record`) for the quarters whose sales
     * are not invoiced in euro. */
    ecbEvidenceIds: z.array(z.uuid()).max(10).optional(),
  })
  .strict();

const quarterPattern = /^(\d{4})-Q([1-4])$/;
const monthOfQuarter = (quarter: string) => Number(quarterPattern.exec(quarter)![2]) * 3;
const yearOfQuarter = (quarter: string) => Number(quarter.slice(0, 4));

type OssEntry = {
  entryId: string;
  seq: number;
  documentId: string | null;
  taxPoint: string;
  /** Its own quarter, and the sale's quarter it counts in (a credit note's original). */
  quarter: string;
  attributed: string;
  state: string;
  type: 'goods' | 'services';
  rateType: 'standard' | 'reduced';
  rate: string;
  currency: string;
  baseMinor: bigint;
  taxMinor: bigint;
};

async function ossEntries(tx: Transaction, companyId: string, end: string) {
  const rows = await tx
    .select({ tax: taxEntries, seq: entries.seq })
    .from(taxEntries)
    .innerJoin(
      entries,
      and(eq(entries.companyId, taxEntries.companyId), eq(entries.id, taxEntries.entryId)),
    )
    .where(
      and(
        eq(taxEntries.companyId, companyId),
        eq(taxEntries.tax, 'VAT'),
        eq(taxEntries.direction, 'output'),
        eq(taxEntries.code, ossCode),
        lte(taxEntries.taxPoint, end),
      ),
    )
    .orderBy(asc(entries.seq), asc(taxEntries.taxNo));
  const list: OssEntry[] = rows.map(({ tax, seq }) => {
    const attributes = JSON.parse(tax.attributes) as Record<string, string>;
    return {
      entryId: tax.entryId,
      seq: Number(seq),
      documentId: tax.documentId,
      taxPoint: tax.taxPoint,
      quarter: attributes.quarter!,
      attributed: attributes.corrects ?? attributes.quarter!,
      state: attributes.country!,
      type: attributes.supplyType === 'goods' ? 'goods' : 'services',
      rateType: attributes.rateType === 'reduced' ? 'reduced' : 'standard',
      rate: attributes.rate!,
      currency: attributes.currency ?? 'RON',
      // Signed as the entry is: a credit note's and a storno's negative (`signedAttributes`).
      baseMinor: BigInt(attributes.baseMinor ?? '0'),
      taxMinor: BigInt(attributes.taxMinor ?? '0'),
    };
  });
  return {
    list,
    read: {
      kind: 'taxPeriod' as const,
      id: `VAT|oss|${end}`,
      version: `${rows.length}/${Math.max(0, ...rows.map((row) => Number(row.seq)))}`,
    },
  };
}

/** The D398 returns the engine authorized, latest first per quarter, superseded ones aside. */
async function authorizedReturns(tx: Transaction, companyId: string) {
  const rows = await tx
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.companyId, companyId), eq(artifacts.kind, 'D398')))
    .orderBy(desc(artifacts.createdAt));
  const byPeriod = new Map<
    string,
    {
      artifactId: string;
      declared: Record<string, string>;
      corrections: { state: string; quarter: string; cents: string }[];
    }
  >();
  for (const row of rows) {
    if (byPeriod.has(row.period)) continue;
    const steps = await tx
      .select()
      .from(artifactEvents)
      .where(and(eq(artifactEvents.companyId, companyId), eq(artifactEvents.artifactId, row.id)))
      .orderBy(asc(artifactEvents.seq));
    const states = steps.map((step) => step.state);
    if (states.includes('superseded') || !states.includes('authorized')) continue;
    const summary = JSON.parse(steps[0]!.detail ?? '{}') as {
      declared?: Record<string, string>;
      corrections?: { state: string; quarter: string; cents: string }[];
    };
    byPeriod.set(row.period, {
      artifactId: row.id,
      declared: summary.declared ?? {},
      corrections: summary.corrections ?? [],
    });
  }
  return byPeriod;
}

/** The ECB's rate of a currency for a day, or the next day it publishes one (eurofxref XML). */
function ecbRate(
  files: readonly string[],
  currency: string,
  day: string,
): { rate: string; date: string } | null {
  let best: { rate: string; date: string } | null = null;
  for (const text of files)
    for (const cube of text.matchAll(/<Cube\s+time="(\d{4}-\d{2}-\d{2})"\s*>([\s\S]*?)<\/Cube>/g)) {
      const date = cube[1]!;
      if (date < day || (best && best.date <= date)) continue;
      const found = new RegExp(`<Cube\\s+currency="${currency}"\\s+rate="([0-9.]+)"\\s*/>`).exec(
        cube[2]!,
      );
      if (found) best = { rate: found[1]!, date };
    }
  return best;
}

async function inputsOf(tx: Transaction, companyId: string, period: string) {
  const { end } = quarterRange(period);
  const oss = await ossEntries(tx, companyId, end);
  const returns = await authorizedReturns(tx, companyId);
  const facts = await tx
    .select()
    .from(profileFacts)
    .where(and(eq(profileFacts.companyId, companyId), eq(profileFacts.axis, 'vat.oss')))
    .orderBy(asc(profileFacts.effectiveFrom));
  const seller = await sellerDetails(tx, companyId);
  const earlier = [...returns].filter(([quarter]) => quarter < period);
  const inputs: ReadSetEntry[] = [
    oss.read,
    {
      kind: 'profile',
      id: 'vat.oss',
      version: facts.map((fact) => `${fact.id}:${fact.supersedesId ?? ''}`).join(','),
    },
    ...earlier.map(([quarter, item]) => ({
      kind: 'artifact' as const,
      id: `D398|${quarter}`,
      version: item.artifactId,
    })),
    ...(seller ? [{ kind: 'party' as const, id: seller.partyId, version: seller.hash }] : []),
  ];
  const superseded = new Set(
    facts.flatMap((fact) => (fact.supersedesId ? [fact.supersedesId] : [])),
  );
  return {
    oss: oss.list,
    returns,
    facts: facts.filter((fact) => !superseded.has(fact.id)),
    seller,
    inputs,
  };
}

/** The special VAT return of the Union scheme (D398) of a quarter. */
export function d398Declaration(
  objects: ObjectStore,
  rules: (tx: Transaction, companyId: string) => Promise<RuleContext>,
): DeclarationKind {
  return {
    kind: 'D398',
    description: 'Declarație specială de TVA a regimului Uniune (OSS, formularul 398)',
    // Corrections go into a later return (art. 315 alin. (11)): nothing is locked.
    tax: null,
    period: z.string().regex(quarterPattern),
    format: (period) => (period >= '2026-Q1' ? 'D398 A1.0.10' : null),
    options: d398Options,
    inputs: async (tx, companyId, period) => (await inputsOf(tx, companyId, period)).inputs,
    async prepare(tx, companyId, period, raw) {
      const options = d398Options.parse(raw);
      const problems: DeclarationProblem[] = [];
      const { oss, returns, facts, seller, inputs } = await inputsOf(tx, companyId, period);
      const { start, end } = quarterRange(period);
      let rule: OssReturnRule | null = null;
      const context = await rules(tx, companyId);
      try {
        rule = context.param<OssReturnRule>('ro.vat.oss.return', 'reporting_period_start', start);
      } catch (error) {
        if (!(error instanceof RuleGapError)) throw error;
        problems.push({ code: 'RULE_GAP', message: error.message });
      }
      // The filing deadline: the last calendar day of the month after the quarter, not moved
      // (art. 315 alin. (6^1), `ro.deadline.D398`).
      let due: LocalDate | null = null;
      try {
        due = obligationDue(
          'D398',
          { start: start as LocalDate, end: end as LocalDate },
          context,
        ).due;
      } catch (error) {
        if (!(error instanceof RuleGapError)) throw error;
        problems.push({ code: 'RULE_GAP', message: error.message });
      }
      // Registered in the Union scheme on some day of the quarter (art. 315 alin. (3), (6)).
      const value = (day: string) =>
        facts.filter((fact) => fact.effectiveFrom <= day).at(-1)?.value;
      const registered =
        value(start) === 'union' ||
        facts.some(
          (fact) =>
            fact.value === 'union' && fact.effectiveFrom >= start && fact.effectiveFrom <= end,
        );
      if (!registered)
        problems.push({
          code: 'D398_NOT_REGISTERED',
          message: `Firma nu aplică regimul special Uniune în ${period} (vat.oss): declarația 398 nu i se cuvine.`,
        });
      if (!seller)
        problems.push({
          code: 'SELLER_DETAILS',
          message: 'Înregistrați datele de identificare ale companiei.',
        });

      // The ECB's rates, for the sales not in euro.
      const files: string[] = [];
      for (const id of options.ecbEvidenceIds ?? []) {
        const [row] = await tx
          .select()
          .from(evidence)
          .where(and(eq(evidence.companyId, companyId), eq(evidence.id, id)));
        if (!row) {
          problems.push({ code: 'ECB_EVIDENCE', message: `Fișierul BCE ${id} nu este în dovezi.` });
          continue;
        }
        files.push(new TextDecoder().decode(await objects.get(companyId, row.hash)));
        inputs.push({ kind: 'evidence', id, version: row.hash });
      }
      const rates = new Map<string, { rate: string; date: string } | null>();
      /** Minor units of a currency in euro cents at the ECB's rate of a quarter's last day. */
      const toEuro = (minor: bigint, currency: string, quarter: string): bigint | null => {
        if (currency === 'EUR') return minor;
        const day = quarterRange(quarter).end;
        const key = `${currency}|${day}`;
        if (!rates.has(key)) rates.set(key, ecbRate(files, currency, day));
        const found = rates.get(key);
        if (!found) {
          if (!problems.some((item) => item.code === 'ECB_RATE' && item.message.includes(key)))
            problems.push({
              code: 'ECB_RATE',
              message: `Lipsește cursul BCE pentru ${currency} la ${day} sau următoarea publicare (${key}): înregistrați fișierul eurofxref al BCE și indicați-l (ecbEvidenceIds), art. 315 alin. (12).`,
            });
          return null;
        }
        // The ECB quotes units of the currency per euro; minor units of a 2-decimal currency.
        return divRound(minor * 10_000n, parseScaled(found.rate, 4), 'halfAwayFromZero');
      };

      // Every entry declared up to this quarter: its own quarter is this one or earlier.
      const considered = oss.filter((entry) => entry.quarter <= period);
      const group = (items: OssEntry[], quarter: string) => {
        const groups = new Map<string, OssEntry[]>();
        for (const item of items) {
          const key = `${item.state}|${item.type}|${item.rateType}|${Number(item.rate)}|${item.currency}`;
          groups.set(key, [...(groups.get(key) ?? []), item]);
        }
        const supplies = new Map<string, D398Supply>();
        for (const items of groups.values()) {
          const first = items[0]!;
          const base = toEuro(
            items.reduce((sum, item) => sum + item.baseMinor, 0n),
            first.currency,
            quarter,
          );
          const tax = toEuro(
            items.reduce((sum, item) => sum + item.taxMinor, 0n),
            first.currency,
            quarter,
          );
          if (base === null || tax === null) continue;
          const key = `${first.state}|${first.type}|${first.rateType}|${Number(first.rate)}`;
          const found = supplies.get(key);
          supplies.set(key, {
            state: first.state,
            type: first.type,
            rateType: first.rateType,
            rate: String(Number(first.rate)),
            taxableCents: (found?.taxableCents ?? 0n) + base,
            vatCents: (found?.vatCents ?? 0n) + tax,
          });
        }
        return [...supplies.values()];
      };
      const own = group(
        considered.filter((entry) => entry.attributed === period),
        period,
      ).filter((item) => item.taxableCents !== 0n || item.vatCents !== 0n);
      for (const item of own)
        if (item.taxableCents < 0n || item.vatCents < 0n)
          problems.push({
            code: 'D398_SUPPLY_NEGATIVE',
            message: `Operațiunile din ${item.state} la ${item.rate}% sunt negative în ${period}: notele de credit depășesc vânzările trimestrului.`,
          });
      const supplies = own
        .filter((item) => item.taxableCents > 0n && item.vatCents > 0n)
        .sort(
          (a, b) =>
            a.state.localeCompare(b.state) ||
            a.type.localeCompare(b.type) ||
            Number(a.rateType !== 'standard') - Number(b.rateType !== 'standard') ||
            Number(b.rate) - Number(a.rate),
        );

      // Corrections of earlier quarters: the books now, against what was declared for them.
      const corrections: D398Correction[] = [];
      const quarters = [
        ...new Set(
          considered.map((entry) => entry.attributed).filter((quarter) => quarter < period),
        ),
      ].sort();
      for (const quarter of quarters) {
        const filed = returns.get(quarter);
        if (!filed) {
          problems.push({
            code: 'D398_PREVIOUS',
            message: `Vânzările din ${quarter} se declară în declarația 398 a acelui trimestru, pe care aplicația nu o are autorizată: pregătiți-o întâi.`,
          });
          continue;
        }
        // Within three years of the corrected return's deadline (alin. (11)).
        const months =
          (yearOfQuarter(period) - yearOfQuarter(quarter)) * 12 +
          monthOfQuarter(period) -
          monthOfQuarter(quarter);
        if (rule && months > rule.correctionYears * 12 + 1)
          problems.push({
            code: 'D398_CORRECTION_LATE',
            message: `Corecția trimestrului ${quarter} depășește termenul de ${rule.correctionYears} ani (art. 315 alin. (11)).`,
          });
        const books = new Map<string, bigint>();
        for (const item of group(
          considered.filter((entry) => entry.attributed === quarter),
          quarter,
        ))
          books.set(item.state, (books.get(item.state) ?? 0n) + item.vatCents);
        const declared = new Map<string, bigint>(
          Object.entries(filed.declared).map(([state, cents]) => [state, BigInt(cents)]),
        );
        for (const [later, item] of returns)
          if (later > quarter && later < period)
            for (const correction of item.corrections)
              if (correction.quarter === quarter)
                declared.set(
                  correction.state,
                  (declared.get(correction.state) ?? 0n) + BigInt(correction.cents),
                );
        for (const state of new Set([...books.keys(), ...declared.keys()])) {
          const difference = (books.get(state) ?? 0n) - (declared.get(state) ?? 0n);
          if (difference !== 0n)
            corrections.push({
              state,
              year: yearOfQuarter(quarter),
              month: monthOfQuarter(quarter),
              vatCents: difference,
            });
        }
      }

      if (problems.length || !seller) return { xml: '', inputs, problems, summary: null };
      const details = JSON.parse(seller.details) as Party;
      const [company] = await tx.select().from(companies).where(eq(companies.id, companyId));
      const model: D398 = {
        period: { year: yearOfQuarter(period), month: monthOfQuarter(period) },
        vatId: company!.cui,
        name: details.name.slice(0, 100),
        supplies,
        corrections,
      };
      for (const check of checkD398(model))
        problems.push({ code: check.code, message: check.message });
      const declared: Record<string, string> = {};
      for (const item of supplies)
        declared[item.state] = String(BigInt(declared[item.state] ?? '0') + item.vatCents);
      const euro = (cents: bigint) =>
        `${cents < 0n ? '-' : ''}${(cents < 0n ? -cents : cents) / 100n}.${String((cents < 0n ? -cents : cents) % 100n).padStart(2, '0')}`;
      return {
        xml: problems.length ? '' : writeD398(model),
        inputs,
        problems,
        summary: {
          period,
          nil: !supplies.length && !corrections.length,
          supplies: supplies.map((item) => ({
            state: item.state,
            type: item.type,
            rateType: item.rateType,
            rate: item.rate,
            taxable: euro(item.taxableCents),
            vat: euro(item.vatCents),
          })),
          // What later returns compare their books with: this quarter's VAT per state, and the
          // corrections of earlier quarters it declares.
          declared,
          corrections: corrections.map((item) => ({
            state: item.state,
            quarter: `${item.year}-Q${item.month / 3}`,
            cents: String(item.vatCents),
          })),
          rates: [...rates]
            .filter(([, found]) => found)
            .map(([key, found]) => ({ key, rate: found!.rate, date: found!.date })),
          due,
        },
      };
    },
  };
}

/** The sales of art. 278^1 alin. (1) lit. b) of a year, as the determinations cumulate them:
 * every entry of `invoices.euConsumer` (attribute `distance`), by tax point. */
export async function distanceSalesOf(tx: Transaction, companyId: string, year: number) {
  const rows = await tx
    .select({
      date: taxEntries.taxPoint,
      documentId: taxEntries.documentId,
      base: taxEntries.baseBani,
      attributes: taxEntries.attributes,
    })
    .from(taxEntries)
    .where(
      and(
        eq(taxEntries.companyId, companyId),
        eq(taxEntries.tax, 'VAT'),
        eq(taxEntries.direction, 'output'),
        sql`json_extract(${taxEntries.attributes}, '$.distance') is not null`,
        sql`${taxEntries.taxPoint} >= ${`${year}-01-01`} and ${taxEntries.taxPoint} <= ${`${year}-12-31`}`,
      ),
    )
    .orderBy(asc(taxEntries.taxPoint), asc(taxEntries.entryId), asc(taxEntries.taxNo));
  return rows.map((row) => {
    const attributes = JSON.parse(row.attributes) as Record<string, string>;
    return {
      date: row.date as LocalDate,
      documentId: row.documentId ?? '',
      number: attributes.number ?? row.documentId ?? '',
      base: row.base,
      regime: attributes.distance === 'oss' ? ('oss' as const) : ('origin' as const),
      country: attributes.country ?? '',
    };
  });
}

/** The bases of rd. 17 and 18 of a year's returns (origin-taxed sales), to a day. */
export async function originTotal(tx: Transaction, companyId: string, from: string, to: string) {
  const [row] = await tx
    .select({
      base: sql<bigint>`coalesce(sum(${taxEntries.baseBani}), 0)`.mapWith(BigInt),
      count: sql<number>`count(*)`,
    })
    .from(taxEntries)
    .where(
      and(
        eq(taxEntries.companyId, companyId),
        eq(taxEntries.tax, 'VAT'),
        eq(taxEntries.direction, 'output'),
        inArray(sql`json_extract(${taxEntries.attributes}, '$.distance')`, ['origin']),
        sql`${taxEntries.taxPoint} >= ${from} and ${taxEntries.taxPoint} <= ${to}`,
      ),
    );
  return { base: row?.base ?? 0n, count: Number(row?.count ?? 0) };
}

/**
 * D300's information on the operations of art. 278^1 alin. (1) lit. b) (OPANAF nr. 174/2026,
 * the section after rd. B1): the bases declared on rd. 17 and 18 cumulated for the previous year
 * and for the current one to the period's end. The previous year comes from the books when the
 * engine keeps it, else from a person's answer to `year.figures` (`distanceTurnover`). Null when
 * neither year has such sales; read as one input, so a sale landing in either year makes the
 * return stale.
 */
export async function distanceInformation(
  tx: Transaction,
  companyId: string,
  periodEnd: string,
): Promise<{
  read: ReadSetEntry;
  values: { previous: bigint; current: bigint } | null;
  problem: DeclarationProblem | null;
}> {
  const year = Number(periodEnd.slice(0, 4));
  const current = await originTotal(tx, companyId, `${year}-01-01`, periodEnd);
  const previous = await originTotal(tx, companyId, `${year - 1}-01-01`, `${year - 1}-12-31`);
  const [kept] = await tx
    .select({ id: fiscalYears.id })
    .from(fiscalYears)
    .where(
      and(
        eq(fiscalYears.companyId, companyId),
        eq(fiscalYears.kind, 'financial'),
        lte(fiscalYears.from, `${year - 1}-01-01`),
        gte(fiscalYears.to, `${year - 1}-12-31`),
      ),
    );
  const read: ReadSetEntry = {
    kind: 'taxPeriod',
    id: `VAT|distance|${periodEnd}`,
    version: `${current.count}/${current.base}/${previous.count}/${previous.base}`,
  };
  if (!current.count && !previous.count) return { read, values: null, problem: null };
  let earlier: bigint | null = kept ? previous.base : null;
  if (earlier === null) {
    const answers = await tx
      .select({ value: questionAnswers.value })
      .from(questionAnswers)
      .innerJoin(
        questions,
        and(
          eq(questions.companyId, questionAnswers.companyId),
          eq(questions.id, questionAnswers.questionId),
        ),
      )
      .where(
        and(
          eq(questions.companyId, companyId),
          eq(questions.kind, 'year.figures'),
          eq(questions.subjectId, String(year - 1)),
        ),
      )
      .orderBy(asc(questionAnswers.engineAt), asc(questionAnswers.seq));
    for (const row of answers) {
      const value = (JSON.parse(row.value) as { values?: Record<string, string> }).values
        ?.distanceTurnover;
      if (value !== undefined) earlier = BigInt(Math.round(Number(value) * 100));
    }
  }
  if (earlier === null)
    return {
      read,
      values: null,
      problem: {
        code: 'D300_DISTANCE_PREVIOUS',
        message: `Informațiile despre operațiunile art. 278^1 cer totalul anului ${year - 1}, pe care registrele nu îl țin: răspundeți la year.figures (distanceTurnover) pentru ${year - 1}, din ultimul decont depus.`,
      },
    };
  return { read, values: { previous: earlier, current: current.base }, problem: null };
}
