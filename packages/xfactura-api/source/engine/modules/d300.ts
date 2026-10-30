import { and, asc, desc, eq, isNotNull, isNull, like, lte, notLike, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Party } from 'xfactura-core/einvoice';
import { profileAt, vatPeriodOf, type ReadSetEntry } from 'xfactura-core/kernel';
import { divRound } from 'xfactura-core/money';
import {
  calculateD300,
  checkD300,
  d300Namespace,
  writeD300,
  type D300,
  type D300InputElement,
} from 'xfactura-core/ro/declarations/d300';
import { counties } from 'xfactura-core/ro/geo';
import { vatPeriodEnd } from 'xfactura-core/ro/treatments/vat-settlement';
import { RuleGapError, type RuleContext } from 'xfactura-core/rules';
import type { LocalDate } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import {
  artifactEvents,
  artifacts,
  companies,
  entries,
  parties,
  partyVersions,
  taxEntries,
} from '../db/schema';
import { loadState } from '../kernel/state';
import type { DeclarationKind, DeclarationProblem } from './declarations';

const vatPeriod = z.string().regex(/^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/);
export const d300Options = z
  .object({
    declarant: z
      .object({
        lastName: z.string().trim().min(1).max(75),
        firstName: z.string().trim().min(1).max(75),
        role: z.string().trim().min(1).max(50),
      })
      .strict(),
    caen: z.string().regex(/^\d{4}$/),
    bank: z.string().trim().min(1).max(50),
    account: z.string().trim().min(1).max(50),
    phone: z.string().trim().min(1).max(15).optional(),
    email: z.string().trim().min(1).max(200).optional(),
    /** The printed form pre-fills 100; a company with mixed operations records its own. */
    proRata: z
      .string()
      .regex(/^(100|\d{1,2})(\.\d{1,2})?$/)
      .default('100'),
    refundRequested: z.boolean().default(false),
    /**
     * For the first period kept in the engine only: the previous return's VAT payable still
     * unpaid when this one is filed (rd. 38) and its negative balance carried forward (rd. 41).
     * Later periods take them from the previous return in the engine.
     */
    previous: z
      .object({
        unpaid: z.number().int().min(0).default(0),
        negative: z.number().int().min(0).default(0),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Where the books' tax entries go on the return, as the base and VAT elements of each row:
 * - collected VAT by rate on rows 9–10 (9.1 at 19% for 2025 periods);
 * - services bought from abroad with reverse charge on row 7, and also on its subset 7.1 when
 *   the supplier is in the EU; the return repeats them as deductible on rows 20 and 20.1;
 * - services supplied abroad under the general rule on row 3, and on 3.1 when the customer is
 *   in the EU (base only);
 * - purchases by rate on rows 24–25 (24.1 for 2025) with all their VAT.
 * Row 31 holds the VAT actually deducted. That purchases enter rows 24–25 with all their VAT
 * while row 31 holds only the deductible part is an interpretation for the expert's review.
 * `null` marks entries the return derives itself (the deductible side of reverse charge).
 * Under VAT on collection an invoice's entries have no exigibility and stay out of the rows: the
 * collection or payment that releases them is declared, at the invoice's code, in its period.
 */
const rowsByCode: Record<'output' | 'input', Record<string, [string, string | null][] | null>> = {
  output: {
    'S-21': [['R9_1', 'R9_2']],
    'S-11': [['R10_1', 'R10_2']],
    'S-19': [['R69_1', 'R69_2']],
    'RC-EU-SERV': [
      ['R7_1', 'R7_2'],
      ['R7_1_1', 'R7_1_2'],
    ],
    'RC-NONEU-SERV': [['R7_1', 'R7_2']],
    'EXP-EU-SERV': [
      ['R3_1', null],
      ['R3_1_1', null],
    ],
    'EXP-NONEU-SERV': [['R3_1', null]],
  },
  input: {
    'S-21': [['R22_1', 'R22_2']],
    'S-11': [['R23_1', 'R23_2']],
    'S-19': [['R74_1', 'R74_2']],
    'RC-EU-SERV': null,
    'RC-NONEU-SERV': null,
  },
};

function returnPeriod(period: string): D300['period'] {
  const quarter = /^(\d{4})-Q([1-4])$/.exec(period);
  if (quarter) return { year: Number(quarter[1]), month: Number(quarter[2]) * 3 };
  return { year: Number(period.slice(0, 4)), month: Number(period.slice(5, 7)) };
}

export function periodStart(period: string): LocalDate {
  const { year, month } = returnPeriod(period);
  const first = period.includes('Q') ? month - 2 : month;
  return `${year}-${String(first).padStart(2, '0')}-01` as LocalDate;
}

/** How bani round to the whole lei the return is in, from the rule register. */
export async function rounding(
  rules: (tx: Transaction, companyId: string) => Promise<RuleContext>,
  tx: Transaction,
  companyId: string,
  date: LocalDate,
  problems: DeclarationProblem[],
) {
  try {
    const rule = (await rules(tx, companyId)).param<string>(
      'ro.declaration.rounding',
      'reporting_period_start',
      date,
    );
    if (rule !== 'half_up_leu') throw new Error(`Unknown rounding ${rule}.`);
    return (bani: bigint) => divRound(bani, 100n, 'halfAwayFromZero');
  } catch (error) {
    if (!(error instanceof RuleGapError)) throw error;
    problems.push({ code: 'RULE_GAP', message: error.message });
    return null;
  }
}

/** The previous period's return in the engine: the latest one not superseded, once authorized. */
async function previousReturn(tx: Transaction, companyId: string, period: string) {
  const quarter = /^(\d{4})-Q([1-4])$/.exec(period);
  const year = Number(period.slice(0, 4));
  const before = quarter
    ? Number(quarter[2]) === 1
      ? `${year - 1}-Q4`
      : `${year}-Q${Number(quarter[2]) - 1}`
    : Number(period.slice(5, 7)) === 1
      ? `${year - 1}-12`
      : `${year}-${String(Number(period.slice(5, 7)) - 1).padStart(2, '0')}`;
  const rows = await tx
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.companyId, companyId),
        eq(artifacts.kind, 'D300'),
        eq(artifacts.period, before),
      ),
    )
    .orderBy(desc(artifacts.createdAt));
  for (const row of rows) {
    const steps = await tx
      .select()
      .from(artifactEvents)
      .where(and(eq(artifactEvents.companyId, companyId), eq(artifactEvents.artifactId, row.id)))
      .orderBy(asc(artifactEvents.seq));
    const states = steps.map((step) => step.state);
    if (states.includes('superseded') || !states.includes('authorized')) continue;
    const summary = JSON.parse(steps[0]!.detail ?? '{}') as {
      balances?: { R41_2?: number; R42_2?: number };
      refundRequested?: boolean;
    };
    return { period: before, artifactId: row.id, ...summary };
  }
  return undefined;
}

/**
 * The previous return's balances as this one carries them: the payable it showed, which the
 * company states as still unpaid only through `previous` (payments are not yet matched to
 * returns), and its negative balance unless a refund was requested.
 */
function carried(
  previous: Awaited<ReturnType<typeof previousReturn>>,
  given: { unpaid: number; negative: number } | undefined,
): Partial<Record<D300InputElement, number>> {
  const negative = previous
    ? previous.refundRequested
      ? 0
      : (previous.balances?.R42_2 ?? 0)
    : (given?.negative ?? 0);
  const unpaid = given?.unpaid ?? 0;
  return {
    ...(unpaid ? { R35_2: unpaid } : {}),
    ...(negative ? { R38_2: negative } : {}),
  };
}

export async function sellerDetails(tx: Transaction, companyId: string) {
  const [row] = await tx
    .select({
      partyId: partyVersions.partyId,
      version: partyVersions.version,
      details: partyVersions.details,
      hash: partyVersions.detailsHash,
    })
    .from(partyVersions)
    .innerJoin(
      parties,
      and(eq(parties.companyId, partyVersions.companyId), eq(parties.id, partyVersions.partyId)),
    )
    .where(and(eq(partyVersions.companyId, companyId), eq(parties.kind, 'self')))
    .orderBy(desc(partyVersions.version))
    .limit(1);
  return row;
}

/**
 * The VAT still deferred at the end of a period under VAT on collection: every tax entry without
 * exigibility in the period or an earlier one, monthly or quarterly. The whole set is one read:
 * an entry landing in any of those periods changes its count or its last sequence.
 */
export async function deferredVat(tx: Transaction, companyId: string, period: string) {
  const end = vatPeriodEnd(period);
  const year = Number(end.slice(0, 4));
  const quarter = Math.floor(Number(end.slice(5, 7)) / 3);
  const lastQuarter = quarter === 0 ? `${year - 1}-Q4` : `${year}-Q${quarter}`;
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
        isNull(taxEntries.exigibility),
        isNotNull(taxEntries.taxPeriod),
        or(
          and(notLike(taxEntries.taxPeriod, '%Q%'), lte(taxEntries.taxPeriod, end.slice(0, 7))),
          and(like(taxEntries.taxPeriod, '%Q%'), lte(taxEntries.taxPeriod, lastQuarter)),
        ),
      ),
    )
    .orderBy(asc(entries.seq), asc(taxEntries.taxNo));
  const last = Math.max(0, ...rows.map((row) => Number(row.seq)));
  return {
    entries: rows.map((row) => ({
      ...row.tax,
      attributes: JSON.parse(row.tax.attributes) as Record<string, string>,
    })),
    read: {
      kind: 'taxPeriod' as const,
      id: `VAT|deferred|${period}`,
      version: `${rows.length}/${last}`,
    },
  };
}

/**
 * The informative rows A, A1, B and B1 of the return: what VAT on collection leaves deferred at
 * the period's end, per invoice, sales (A) and purchases (B), with the base still to collect or
 * pay and, for purchases, the VAT whose deduction waits. A1 and B1 hold the invoices whose tax
 * point falls in the last 6 months, or 2 quarters for a quarterly payer, including this period.
 */
function deferredRows(
  deferred: Awaited<ReturnType<typeof deferredVat>>['entries'],
  period: string,
  problems: DeclarationProblem[],
) {
  const groups = new Map<
    string,
    { direction: string; base: bigint; vat: bigint; taxPoint: string | null }
  >();
  for (const entry of deferred) {
    const invoice = entry.attributes.invoice;
    if (!invoice) {
      problems.push({
        code: 'D300_DEFERRED',
        message: `TVA neexigibilă din nota cu documentul ${entry.documentId ?? '–'} nu provine din sistemul TVA la încasare: rândurile informative A și B nu o pot cuprinde.`,
      });
      continue;
    }
    const group = groups.get(invoice) ?? {
      direction: entry.direction,
      base: 0n,
      vat: 0n,
      taxPoint: null,
    };
    group.base += entry.baseBani;
    group.vat += entry.direction === 'output' ? entry.taxBani : entry.deductibleBani;
    // The invoice's own entry gives the supply's date.
    if (entry.documentId === invoice && !entry.attributes.release)
      group.taxPoint =
        group.taxPoint === null || entry.taxPoint < group.taxPoint
          ? entry.taxPoint
          : group.taxPoint;
    groups.set(invoice, group);
  }
  const quarterly = period.includes('Q');
  const start = periodStart(period);
  const back = Number(start.slice(0, 4)) * 12 + Number(start.slice(5, 7)) - 1 - (quarterly ? 3 : 5);
  const since = `${Math.floor(back / 12)}-${String((back % 12) + 1).padStart(2, '0')}-01`;
  const totals: Partial<Record<D300InputElement, bigint>> = {};
  const add = (element: D300InputElement, bani: bigint) =>
    (totals[element] = (totals[element] ?? 0n) + bani);
  for (const group of groups.values()) {
    if (group.base === 0n && group.vat === 0n) continue;
    const row = group.direction === 'output' ? 'a' : 'b';
    add(`valoare_${row}`, group.base);
    add(`tva_${row}`, group.vat);
    if (group.taxPoint !== null && group.taxPoint >= since) {
      add(`valoare_${row}1`, group.base);
      add(`tva_${row}1`, group.vat);
    }
  }
  return totals;
}

async function inputsOf(tx: Transaction, companyId: string, period: string) {
  const { loaded, readSet } = await loadState(tx, companyId, {
    taxPeriods: [{ tax: 'VAT', period }],
    profile: true,
  });
  const seller = await sellerDetails(tx, companyId);
  const previous = await previousReturn(tx, companyId, period);
  const deferred = await deferredVat(tx, companyId, period);
  const inputs: ReadSetEntry[] = [
    ...readSet,
    deferred.read,
    ...(seller ? [{ kind: 'party' as const, id: seller.partyId, version: seller.hash }] : []),
    // The return whose balances this one carries: replacing it makes this one stale.
    ...(previous
      ? [{ kind: 'artifact' as const, id: previous.period, version: previous.artifactId }]
      : []),
  ];
  return { loaded, seller, inputs, deferred: deferred.entries };
}

/** The VAT return (D300) from the VAT ledger of a tax period. */
export function d300Declaration(
  rules: (tx: Transaction, companyId: string) => Promise<RuleContext>,
): DeclarationKind {
  return {
    kind: 'D300',
    description: 'Decont de taxă pe valoarea adăugată (D300)',
    tax: 'VAT',
    period: vatPeriod,
    format(period) {
      try {
        return `D300 ${d300Namespace(returnPeriod(period))}`;
      } catch {
        return null;
      }
    },
    options: d300Options,
    inputs: async (tx, companyId, period) => (await inputsOf(tx, companyId, period)).inputs,
    async prepare(tx, companyId, period, raw) {
      const options = d300Options.parse(raw);
      const problems: DeclarationProblem[] = [];
      const { loaded, seller, inputs, deferred } = await inputsOf(tx, companyId, period);
      const previous = await previousReturn(tx, companyId, period);
      if (previous && options.previous)
        problems.push({
          code: 'PREVIOUS_KNOWN',
          message: `Decontul perioadei ${previous.period} este în registre; soldurile lui nu se introduc manual.`,
        });
      const end = vatPeriodEnd(period);
      if (vatPeriodOf(loaded, end) !== period)
        problems.push({
          code: 'VAT_PERIOD',
          message: `Perioada fiscală a companiei pentru ${end} este ${vatPeriodOf(loaded, end)}, nu ${period}.`,
        });
      if (profileAt(loaded, 'vat.status', end) !== 'normal_vat')
        problems.push({
          code: 'NOT_VAT_PAYER',
          message: 'Decontul D300 îl depun plătitorii de TVA.',
        });
      if (!seller)
        problems.push({
          code: 'SELLER_DETAILS',
          message: 'Înregistrați datele de identificare ale companiei.',
        });

      const roundToLeu = await rounding(rules, tx, companyId, periodStart(period), problems);
      const totals = new Map<string, bigint>();
      const add = (element: string, bani: bigint) =>
        totals.set(element, (totals.get(element) ?? 0n) + bani);
      let deducted = 0n;
      for (const entry of loaded.taxLedger.get(`VAT|${period}`)?.entries ?? []) {
        // VAT on collection: the invoice's VAT is declared when collected or paid.
        if (entry.exigibility === null) continue;
        const rows = rowsByCode[entry.direction][entry.code];
        if (rows === undefined) {
          problems.push({
            code: 'D300_CODE',
            message: `Operațiunile ${entry.direction === 'output' ? 'colectate' : 'deductibile'} cu codul ${entry.code} nu au încă un rând în decont.`,
          });
          continue;
        }
        for (const [base, vat] of rows ?? []) {
          add(base, entry.baseBani);
          if (vat) add(vat, entry.taxBani);
        }
        if (entry.direction === 'input') deducted += entry.deductibleBani;
      }
      if (deducted !== 0n) add('R28_2', deducted);
      for (const [element, bani] of Object.entries(deferredRows(deferred, period, problems)))
        add(element, bani);
      if (problems.length || !seller || !roundToLeu)
        return { xml: '', inputs, problems, summary: null };

      const details = JSON.parse(seller.details) as Party;
      const [company] = await tx.select().from(companies).where(eq(companies.id, companyId));
      const address = details.address;
      const model: D300 = {
        period: returnPeriod(period),
        type: period.includes('Q') ? 'T' : 'L',
        company: {
          cui: company!.cui,
          name: details.name,
          address: [
            ...address.lines,
            address.city,
            address.subdivision
              ? (counties[address.subdivision] ?? address.subdivision)
              : undefined,
          ]
            .filter(Boolean)
            .join(', '),
          ...(options.phone ? { phone: options.phone } : {}),
          ...(options.email ? { email: options.email } : {}),
          bank: options.bank,
          account: options.account,
          caen: options.caen,
        },
        declarant: options.declarant,
        groupRepresentative: false,
        simplifiedDomestic: false,
        afterReserveCancellation: false,
        proRata: options.proRata,
        reverseCharge: {
          cereals: false,
          mobilePhones: false,
          integratedCircuits: false,
          consoles: false,
        },
        refundRequested: options.refundRequested,
        rows: {
          ...(Object.fromEntries(
            [...totals].map(([element, bani]) => [element, Number(roundToLeu(bani))]),
          ) as Partial<Record<D300InputElement, number>>),
          ...carried(previous, options.previous),
        },
      };
      for (const check of checkD300(model))
        if (check.severity === 'error') problems.push({ code: check.code, message: check.message });
      return {
        xml: problems.length ? '' : writeD300(model),
        inputs,
        problems,
        summary: {
          period,
          type: model.type,
          rows: model.rows,
          // What the next return carries: the payable or negative balance, and the refund choice.
          balances: Object.fromEntries(
            (['R41_2', 'R42_2'] as const).map((element) => [
              element,
              Number(calculateD300(model).amounts[element] ?? 0n),
            ]),
          ),
          refundRequested: model.refundRequested,
        },
      };
    },
  };
}
