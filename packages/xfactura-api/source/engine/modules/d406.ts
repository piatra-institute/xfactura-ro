import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { readInvoice, type Invoice, type Party } from 'xfactura-core/einvoice';
import { hashOf } from 'xfactura-core/hash';
import { profileAt, vatPeriodOf, type ReadSetEntry } from 'xfactura-core/kernel';
import {
  allocate,
  divRound,
  formatMoney,
  formatScaled,
  parseDecimal,
  parseMoney,
  roundRatio,
} from 'xfactura-core/money';
import { euVatPrefixes } from 'xfactura-core/ro/geo';
import { isValidCnp, isValidCui } from 'xfactura-core/ro/identifiers';
import { d406AmbiguousAccounts, syntheticOf } from 'xfactura-core/ro/saft/accounts';
import {
  calculateD406,
  checkD406,
  d406ConvertedAmount,
  d406Namespace,
  d406PartyId,
  writeD406,
  type D406,
  type D406Address,
  type D406Currency,
  type D406Invoice,
  type D406Journal,
  type D406Line,
  type D406Party,
  type D406Payment,
  type D406Product,
  type D406Tax,
} from 'xfactura-core/ro/saft/d406';
import { supplierAppliesCashVat } from 'xfactura-core/ro/cash-vat';
import { isRetailTag } from 'xfactura-core/ro/retail';
import {
  d406BaseRateCode,
  d406CashVatReleaseCode,
  d406NonPayerSaleCode,
  d406ZReportCode,
  d406RatedAdjustments,
  d406ReverseCharges,
  d406VatTaxCode,
} from 'xfactura-core/ro/saft/tax-codes';
import { invoiceKinds } from 'xfactura-core/ro/treatments/invoices';
import { regimeCodes } from 'xfactura-core/ro/treatments/vat-registration';
import { vatPeriodEnd } from 'xfactura-core/ro/treatments/vat-settlement';
import { withheldOf, type Withheld } from 'xfactura-core/ro/withholding';
import { RuleGapError, type RuleContext } from 'xfactura-core/rules';
import { bucharestDate, type LocalDate } from 'xfactura-core/time';
import type { ObjectStore } from '../adapters/object-store';
import type { Transaction } from '../db/database';
import {
  bankMovements,
  bankStatements,
  companies,
  entries,
  fiscalYears,
  ledgerAccounts,
  lines,
  openItems,
  partyCnps,
  partyVersions,
  proposals,
  proposalVersions,
  stockMoves,
  taxEntries,
  treasuryAccounts,
} from '../db/schema';
import { justifyingDocuments } from '../kernel/reports';
import { loadState, mergeStates } from '../kernel/state';
import { assetsAuthorization, assetsInputs, disposalsOption, prepareAssets } from './d406-assets';
import { prepareStock, stockInputs, stockPeriod } from './d406-stock';
import { lateCoverage, periodStart, sellerDetails } from './d300';
import type { DeclarationKind, DeclarationProblem } from './declarations';
import { Sealer } from './payroll';

const text = (max: number) => z.string().trim().min(1).max(max);
export const d406Options = z
  .object({
    /** The person ANAF may contact about the file (Header/Company/Contact). */
    contact: z
      .object({
        firstName: text(35),
        lastName: text(70),
        phone: text(18),
        email: text(70).optional(),
      })
      .strict()
      .optional(),
    /** The standard account chosen for each synthetic ANAF subdivides (605, 612, 623, 635, 646),
     * by its synthetic: `{ "646": "6461" }`. */
    accounts: z.record(z.string().regex(/^\d{3,4}$/), z.string().regex(/^\d{3,4}$/)).default({}),
    /** The AccountID of an account whose code has no numeric form, as the company numbers it in
     * its chart: digits beginning with its synthetic, `{ "371.M2-21": "3712021" }` (a
     * warehouse's accounts at retail price, G2). */
    accountIds: z
      .record(z.string().regex(/^[1-7]\d{2,3}\.[\w.-]{1,40}$/), z.string().regex(/^[1-9]\d{2,69}$/))
      .default({}),
    /** What the customers' advances (419) are for: the advance invoices' lines are reported as
     * goods or services. */
    advances: z.enum(['goods', 'services']).optional(),
    /** The annual assets file: how each asset that left the register in the year left it. */
    disposals: disposalsOption,
  })
  .strict();

/** ANAF's validator parameters with the 21% and 11% codes apply from the 2025-07 periods;
 * earlier periods are not pinned. */
const firstPeriod = '2025-07';
/** The annual assets file is pinned from the financial year 2025: the kit's validator (J2.2.8)
 * takes it, and it is the first year small taxpayers report whole (OPANAF nr. 1.783/2021 anexa
 * nr. 5 pct. 1.1 lit. d), as OPANAF nr. 407/2025 restates it). */
const firstAssetsYear = 2025;
const annual = (period: string) => /^\d{4}$/.test(period);

/**
 * The trade partners' accounts (OMFP 1802/2014): customers on 4111, 418 (facturi de întocmit)
 * and 419 (clienți creditori); suppliers on 401, 404 (furnizori de imobilizări), 408 (facturi
 * nesosite) and 409x (furnizori debitori). Their lines name the partner. The other accounts kept
 * by partner (461, 462, 455x, 542) are reported without one, a choice left to the expert.
 */
const partnerAccounts: Readonly<Record<string, 'customer' | 'supplier'>> = {
  '4111': 'customer',
  '418': 'customer',
  '419': 'customer',
  '401': 'supplier',
  '404': 'supplier',
  '408': 'supplier',
  '4091': 'supplier',
  '4092': 'supplier',
};
const partnerOf = (account: string) => partnerAccounts[syntheticOf(account)];
/** The VAT category of a tax entry as invoice allocations name it: S-21, S-11, O. */
const categoryOf = (tax: { key: string; code: string }) =>
  tax.key.startsWith('vat:') ? tax.key.slice(4) : tax.code;
/** `total` in proportion to signed weights, half away from zero, the residue on the largest: a
 * deducted advance (a negative line) takes its negative share of the VAT. */
function prorate(total: bigint, weights: readonly bigint[]): bigint[] {
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (sum === 0n)
    return allocate(
      total,
      weights.map(() => 1n),
    );
  const parts = weights.map((weight) => divRound(total * weight, sum, 'halfAwayFromZero'));
  const residue = total - parts.reduce((a, b) => a + b, 0n);
  const size = (value: bigint) => (value < 0n ? -value : value);
  const largest = weights.reduce(
    (best, weight, index) => (size(weight) > size(weights[best]!) ? index : best),
    0,
  );
  parts[largest]! += residue;
  return parts;
}

/** A part of an invoice's allocation, as `invoices.recognize` and `invoices.credit` take it. */
type Part = {
  account: string;
  vat: string;
  amount: string;
  lease?: string;
  vatExpense?: string;
};
/** A finance lease's instalment part: its principal on 167, repaying the lease named. */
const isLeasePart = (part: Part) => syntheticOf(part.account) === '167' && part.lease !== undefined;
/** The exchange difference a lease's principal books with it (the functions of accounts 167,
 * 668/768 and 665/765; `invoices.recognize`). */
const leaseDifference = /^(668|768|6651|7651)$/;

/**
 * The base lines of an entry among its candidates (lines neither a partner's nor VAT), one per
 * part, in the parts' order. A finance lease's part books after its own line on 167 the VAT it
 * does not deduct (its `vatExpense`) and the exchange difference of its principal (668/768, or
 * 6651/7651): those carry no VAT, so they are no base line. Without a lease part every candidate
 * is a base line, as the parts were booked one line each. Undefined when the lines do not follow
 * the parts.
 */
function baseLinesOf(
  candidates: readonly { index: number; account: string }[],
  parts: readonly Part[] | undefined,
): { bases: number[]; releases: Set<number> } | undefined {
  if (!parts?.some(isLeasePart))
    return { bases: candidates.map((line) => line.index), releases: new Set() };
  const bases: number[] = [];
  const releases = new Set<number>();
  let next = 0;
  let lease: Part | undefined;
  for (const line of candidates) {
    const part = parts[next];
    if (part && line.account === part.account) {
      bases.push(line.index);
      lease = isLeasePart(part) ? part : undefined;
      if (lease) releases.add(line.index);
      next += 1;
    } else if (
      !lease ||
      (line.account !== lease.vatExpense && !leaseDifference.test(syntheticOf(line.account)))
    )
      return undefined;
  }
  return next === parts.length ? { bases, releases } : undefined;
}

/**
 * The parts a lease invoice's lines belong to, within each VAT category: the one way to group
 * the category's lines so that each part's lines add up to its amount. Undefined when there is
 * none, or more than one that would put a line on another account (the lines cannot be told
 * apart), or too many lines to try.
 */
function linesByAmount(
  lines: readonly { key: string; amount: bigint }[],
  parts: readonly { key: string; amount: bigint; account: string }[],
): number[] | undefined {
  const result: number[] = lines.map(() => -1);
  for (const key of new Set(lines.map((line) => line.key))) {
    const members = lines.flatMap((line, index) => (line.key === key ? [index] : []));
    const candidates = parts.flatMap((part, index) => (part.key === key ? [index] : []));
    if (!candidates.length || candidates.length ** members.length > 4096) return undefined;
    const found = new Map<string, number[]>();
    const choice: number[] = [];
    const visit = (position: number) => {
      if (found.size > 1) return;
      if (position === members.length) {
        const sums = candidates.map((part) =>
          members.reduce(
            (sum, line, index) => (choice[index] === part ? sum + lines[line]!.amount : sum),
            0n,
          ),
        );
        if (sums.every((sum, index) => sum === parts[candidates[index]!]!.amount))
          found.set(choice.map((part) => parts[part]!.account).join('|'), [...choice]);
        return;
      }
      for (const part of candidates) {
        choice[position] = part;
        visit(position + 1);
      }
    };
    visit(0);
    if (found.size !== 1) return undefined;
    const [assigned] = [...found.values()];
    members.forEach((line, index) => (result[line] = assigned![index]!));
  }
  return result;
}

/** The engine's journals, as the file describes and groups them (Type, up to nine characters). */
const journals: Readonly<Record<string, { description: string; type: string }>> = {
  VANZARI: { description: 'Jurnal de vânzări', type: 'VANZARI' },
  CUMPARARI: { description: 'Jurnal de cumpărări', type: 'CUMPARARI' },
  BANCA: { description: 'Registru de bancă', type: 'BANCA' },
  CASA: { description: 'Registru de casă', type: 'CASA' },
  DIVERSE: { description: 'Note contabile diverse', type: 'DIVERSE' },
  SALARII: { description: 'Jurnal de salarii', type: 'SALARII' },
  AMORTIZARE: { description: 'Note de calcul al amortizării', type: 'AMORTIZ' },
  IMOBILIZARI: { description: 'Jurnal de imobilizări', type: 'IMOBILIZ' },
  TVA: { description: 'Note de regularizare a TVA', type: 'TVA' },
  IMPOZITE: { description: 'Note de calcul al impozitelor', type: 'IMPOZITE' },
  DIVIDENDE: { description: 'Jurnal de dividende', type: 'DIVIDENDE' },
  INCHIDERE: { description: 'Note de închidere', type: 'INCHIDERE' },
  DESCHIDERE: { description: 'Note de deschidere', type: 'DESCHIDER' },
};

/**
 * GoodsServicesID of an invoice line by the account it was booked on (OMFP 1802/2014): services
 * on 704–706 and on the third-party services of 61x–62x; goods on 701–703 and 707, on the
 * materials and merchandise of 60x and on tangible fixed assets (21x). A line booked elsewhere is
 * a problem. The classification awaits the expert's review.
 */
const productKinds: readonly [RegExp, 'goods' | 'services'][] = [
  // Advances paid for services (4092) and for stocks (4091).
  [/^4092/, 'services'],
  [/^4091/, 'goods'],
  [/^70[4-6]/, 'services'],
  [/^6[12]/, 'services'],
  [/^70[1-37]/, 'goods'],
  [/^60/, 'goods'],
  [/^21/, 'goods'],
  // Goods received into the stock register (G1): raw materials, goods, packaging.
  [/^3[0-8]/, 'goods'],
];

const lei = (bani: bigint) => formatScaled(bani, 2);
const negated = (quantity: string) =>
  quantity.startsWith('-')
    ? quantity.slice(1)
    : /^0(\.0*)?$/.test(quantity)
      ? quantity
      : `-${quantity}`;
const clip = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value);

/** A period's D406 type and last month. */
function filePeriod(period: string): Pick<D406, 'type' | 'period'> {
  const quarter = /^(\d{4})-Q([1-4])$/.exec(period);
  if (quarter)
    return { type: 'T', period: { year: Number(quarter[1]), month: Number(quarter[2]) * 3 } };
  return {
    type: 'L',
    period: { year: Number(period.slice(0, 4)), month: Number(period.slice(5, 7)) },
  };
}

/** An e-Factura address as the file writes it: the first line as the street, the others as
 * details, the county for Romanian addresses. */
function addressOf(address: Party['address']): D406Address {
  return {
    street: address.lines[0],
    ...(address.lines.length > 1 ? { details: address.lines.slice(1).join(', ') } : {}),
    city: address.city,
    ...(address.postalCode ? { postalCode: address.postalCode } : {}),
    ...(address.country === 'RO' && address.subdivision ? { county: address.subdivision } : {}),
    country: address.country,
  };
}

/**
 * Everything the file is computed from, as of the period's end: every account's balance at the
 * period's start, partners' balances from their open items, the period's entries with their lines,
 * tax entries and justifying documents, the invoices and bank movements they recognized, and the
 * partners' and the company's details. Opening entries dated on the financial year's first day are
 * its initial balance, as in the trial balance.
 */
async function booksOf(tx: Transaction, companyId: string, period: string) {
  const start = periodStart(period);
  const end = vatPeriodEnd(period);
  const [year] = await tx
    .select()
    .from(fiscalYears)
    .where(
      and(
        eq(fiscalYears.companyId, companyId),
        eq(fiscalYears.kind, 'financial'),
        lte(fiscalYears.from, start),
        gte(fiscalYears.to, start),
      ),
    );
  const opening = year
    ? sql`(${entries.journalCode} = 'DESCHIDERE' and ${entries.date} = ${year.from})`
    : sql`0`;
  const before = sql`(${entries.date} < ${start} or ${opening})`;
  const signed = sql`case ${lines.side} when 'D' then ${lines.bani} else -${lines.bani} end`;
  const posted = and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId));
  const until = and(eq(lines.companyId, companyId), lte(entries.date, end));
  // Every account with a line until the period's end, as the trial balance lists them.
  const accounts = await tx
    .select({
      code: lines.account,
      name: ledgerAccounts.name,
      opening: sql<bigint>`coalesce(sum(case when ${before} then ${signed} else 0 end), 0)`.mapWith(
        BigInt,
      ),
    })
    .from(lines)
    .innerJoin(entries, posted)
    .innerJoin(
      ledgerAccounts,
      and(eq(ledgerAccounts.companyId, lines.companyId), eq(ledgerAccounts.code, lines.account)),
    )
    .where(until)
    .groupBy(lines.account)
    .orderBy(asc(lines.account));
  const partnerOpenings = (
    await tx
      .select({
        partyId: openItems.partyId,
        account: lines.account,
        opening: sql<bigint>`coalesce(sum(${signed}), 0)`.mapWith(BigInt),
      })
      .from(lines)
      .innerJoin(entries, posted)
      .innerJoin(
        openItems,
        and(eq(openItems.companyId, lines.companyId), eq(openItems.id, lines.openItemId)),
      )
      .where(and(until, before))
      .groupBy(openItems.partyId, lines.account)
  ).filter((row) => partnerOf(row.account) && row.opening !== 0n);
  const inPeriod = and(
    eq(entries.companyId, companyId),
    gte(entries.date, start),
    lte(entries.date, end),
    eq(entries.journalClass, 'general'),
    sql`not ${opening}`,
  );
  const headers = await tx.select().from(entries).where(inPeriod).orderBy(asc(entries.seq));
  const periodLines = (
    await tx
      .select({ line: lines })
      .from(lines)
      .innerJoin(entries, posted)
      .where(inPeriod)
      .orderBy(asc(entries.seq), asc(lines.lineNo))
  ).map((row) => row.line);
  const periodTaxes = (
    await tx
      .select({ tax: taxEntries })
      .from(taxEntries)
      .innerJoin(
        entries,
        and(eq(entries.companyId, taxEntries.companyId), eq(entries.id, taxEntries.entryId)),
      )
      .where(inPeriod)
      .orderBy(asc(entries.seq), asc(taxEntries.taxNo))
  ).map((row) => row.tax);
  const treatments = await tx
    .select({
      entryId: entries.id,
      treatmentId: proposals.treatmentId,
      documentId: proposals.documentId,
      input: proposalVersions.input,
      effect: proposalVersions.effect,
    })
    .from(entries)
    .innerJoin(
      proposals,
      and(eq(proposals.companyId, entries.companyId), eq(proposals.id, entries.proposalId)),
    )
    .innerJoin(
      proposalVersions,
      and(
        eq(proposalVersions.companyId, entries.companyId),
        eq(proposalVersions.proposalId, entries.proposalId),
        eq(proposalVersions.version, entries.version),
      ),
    )
    .where(inPeriod);
  // Consumers in other Member States: the customers of the sales `invoices.euConsumer` booked
  // (their tax entries carry `distance`), individuals without a code of their state.
  const consumers = new Set(
    (
      await tx
        .selectDistinct({ partyId: taxEntries.partyId })
        .from(taxEntries)
        .where(
          and(
            eq(taxEntries.companyId, companyId),
            lte(taxEntries.taxPoint, end),
            sql`json_extract(${taxEntries.attributes}, '$.distance') is not null`,
          ),
        )
    ).flatMap((row) => (row.partyId ? [row.partyId] : [])),
  );
  const itemIds = [...new Set(periodLines.flatMap((line) => line.openItemId ?? []))];
  const items = new Map(
    (itemIds.length
      ? await tx
          .select()
          .from(openItems)
          .where(and(eq(openItems.companyId, companyId), inArray(openItems.id, itemIds)))
      : []
    ).map((item) => [item.id, item]),
  );
  // The ledger as of the period's end: an entry posted on or before it changes the count of
  // lines or the last sequence. Posted entries and account names never change.
  const [mark] = await tx
    .select({
      count: sql<number>`count(*)`.mapWith(Number),
      last: sql<number>`coalesce(max(${entries.seq}), 0)`.mapWith(Number),
    })
    .from(lines)
    .innerJoin(entries, posted)
    .where(until);

  const input = new Map(
    treatments.map((row) => [row.entryId, JSON.parse(row.input) as Record<string, unknown>]),
  );
  const recognized = new Map(
    treatments.flatMap((row) => {
      // The posted version's input first: a revision may name another document than the first.
      const id = (input.get(row.entryId)!.documentId as string | undefined) ?? row.documentId;
      return id ? [[row.entryId, id] as const] : [];
    }),
  );
  // Invoices split over accounts: each part's account, VAT category and amount, in the lines'
  // order, and for a finance lease's part its lease and the account of the VAT it does not deduct.
  const allocations = new Map(
    treatments.flatMap((row) => {
      const parts = input.get(row.entryId)!.allocations as Part[] | undefined;
      return (row.treatmentId === 'invoices.recognize' || row.treatmentId === 'invoices.credit') &&
        parts
        ? [[row.entryId, parts] as const]
        : [];
    }),
  );
  // Goods an invoice received or returned (G1): each of its lines' stock account, from the item
  // its input names for the line and the account the entry's moves booked that item on.
  const stocked = treatments.flatMap((row) => {
    const stock = input.get(row.entryId)!.stock as
      { lines?: { line: string; itemId: string }[] } | undefined;
    return (row.treatmentId === 'invoices.recognize' || row.treatmentId === 'invoices.credit') &&
      stock?.lines?.length
      ? [[row.entryId, stock.lines] as const]
      : [];
  });
  const moved = stocked.length
    ? await tx
        .select({
          entryId: stockMoves.entryId,
          itemId: stockMoves.itemId,
          account: stockMoves.account,
        })
        .from(stockMoves)
        .where(
          and(
            eq(stockMoves.companyId, companyId),
            inArray(
              stockMoves.entryId,
              stocked.map(([entryId]) => entryId),
            ),
          ),
        )
    : [];
  const stockAccounts = new Map(
    stocked.map(([entryId, rows]) => {
      const accounts = Map.groupBy(
        moved.filter((move) => move.entryId === entryId),
        (move) => move.itemId,
      );
      return [
        entryId,
        new Map(
          rows.flatMap((row) => {
            const found = new Set((accounts.get(row.itemId) ?? []).map((move) => move.account));
            return found.size === 1 ? [[row.line, [...found][0]!] as const] : [];
          }),
        ),
      ] as const;
    }),
  );
  // Tax withheld at source: ANAF wants it under its WHT codes, on the line it is withheld from.
  const withholdings = new Map(
    treatments.flatMap((row) => {
      const details = (
        JSON.parse(row.effect ?? '{}') as { explanation?: { details?: Record<string, unknown> } }
      ).explanation?.details;
      const given = input.get(row.entryId)!;
      const taxLine = periodLines.find(
        (line) => line.entryId === row.entryId && line.account === '446' && line.side === 'C',
      );
      const gross =
        typeof given.gross === 'string' ? BigInt(Math.round(Number(given.gross) * 100)) : 0n;
      const found = withheldOf(row.treatmentId, details, gross, taxLine?.bani ?? 0n);
      return found ? [[row.entryId, found] as const] : [];
    }),
  ) as Map<string, Withheld>;
  const movementOf = new Map(
    treatments.flatMap((row) =>
      row.treatmentId === 'bank.settle'
        ? [[row.entryId, input.get(row.entryId)!.movementId as string] as const]
        : [],
    ),
  );
  const creditEntries = new Set(
    treatments.flatMap((row) =>
      row.treatmentId === 'invoices.credit' || row.treatmentId === 'invoices.euConsumer'
        ? [row.entryId]
        : [],
    ),
  );
  const partyIds = [
    ...new Set([
      ...partnerOpenings.map((row) => row.partyId),
      ...[...items.values()]
        // A refund a credit note of the period opened (461, 462) is its partner's too.
        .filter(
          (item) =>
            partnerOf(item.controlAccount) ||
            (/^46[12]/.test(item.controlAccount) && creditEntries.has(item.originEntryId)),
        )
        .map((item) => item.partyId),
    ]),
  ].sort();
  const read = await loadState(tx, companyId, {
    profile: true,
    documents: [
      ...new Set([
        ...recognized.values(),
        ...[...items.values()].flatMap((item) => item.documentId ?? []),
      ]),
    ],
    parties: partyIds,
    movements: [...new Set(movementOf.values())],
  });
  const state = mergeStates(
    read,
    await loadState(tx, companyId, {
      evidence: [
        ...new Set(
          [...read.loaded.documents.values()].flatMap((document) => document.evidenceId ?? []),
        ),
      ],
    }),
  );
  // A bank entry's document: the bank's reference of its movement, or else its statement.
  const movementIds = [...new Set(movementOf.values())];
  const bankReferences = new Map(
    (movementIds.length
      ? await tx
          .select({
            id: bankMovements.id,
            details: bankMovements.details,
            statement: bankStatements.sourceId,
          })
          .from(bankMovements)
          .innerJoin(
            bankStatements,
            and(
              eq(bankStatements.companyId, bankMovements.companyId),
              eq(bankStatements.id, bankMovements.statementId),
            ),
          )
          .where(
            and(eq(bankMovements.companyId, companyId), inArray(bankMovements.id, movementIds)),
          )
      : []
    ).map((row) => [
      row.id,
      (JSON.parse(row.details) as { bankReference?: string | null }).bankReference ?? row.statement,
    ]),
  );
  const treasury = await tx
    .select()
    .from(treasuryAccounts)
    .where(eq(treasuryAccounts.companyId, companyId))
    .orderBy(asc(treasuryAccounts.openedOn), asc(treasuryAccounts.id));
  const details = new Map<string, typeof partyVersions.$inferSelect>();
  if (partyIds.length)
    for (const row of await tx
      .select()
      .from(partyVersions)
      .where(and(eq(partyVersions.companyId, companyId), inArray(partyVersions.partyId, partyIds)))
      .orderBy(asc(partyVersions.partyId), desc(partyVersions.version)))
      if (!details.has(row.partyId)) details.set(row.partyId, row);
  const cnps = partyIds.length
    ? await tx
        .select()
        .from(partyCnps)
        .where(and(eq(partyCnps.companyId, companyId), inArray(partyCnps.partyId, partyIds)))
        .orderBy(asc(partyCnps.partyId))
    : [];
  const seller = await sellerDetails(tx, companyId);
  const [company] = await tx.select().from(companies).where(eq(companies.id, companyId));
  const justifying = await justifyingDocuments(tx, companyId, headers);
  // The days a posted late registration declares (art. 310 alin. (6^2)–(6^3)): their sales were
  // invoiced without VAT, which its regularization (REG-310) collects.
  const late = await lateCoverage(tx, companyId);

  const inputs: ReadSetEntry[] = [
    ...state.readSet,
    late.read,
    {
      kind: 'turnover',
      id: `ledger|${year?.from ?? ''}|${end}`,
      version: `${mark!.count}/${mark!.last}`,
    },
    ...[...details.values()].map((row) => ({
      kind: 'party' as const,
      id: `details:${row.partyId}`,
      version: row.detailsHash,
    })),
    ...cnps.map((row) => ({
      kind: 'party' as const,
      id: `cnp:${row.partyId}`,
      version: hashOf(row.cnpSealed),
    })),
    ...(seller ? [{ kind: 'party' as const, id: seller.partyId, version: seller.hash }] : []),
    {
      kind: 'profile',
      id: 'treasury',
      version: hashOf(treasury.map((row) => [row.id, row.kind, row.iban, row.openedOn])),
    },
  ];
  return {
    start,
    end,
    year,
    accounts,
    partnerOpenings,
    headers,
    periodLines,
    periodTaxes,
    recognized,
    allocations,
    stockAccounts,
    consumers,
    lateRanges: late.ranges,
    withholdings,
    movementOf,
    items,
    loaded: state.loaded,
    bankReferences,
    treasury,
    details,
    cnps,
    seller,
    company,
    justifying,
    inputs,
  };
}

/**
 * The standard audit file for tax (D406, SAF-T) of a month or quarter, from the books: the
 * accounts with their balances at the period's start, the customers and suppliers with theirs
 * (per account, from their open items), every entry of the period as a transaction of its
 * journal with the justifying document of each line and the VAT on its base, the invoices
 * recognized in the period with their UBL lines, and the bank movements settling partners.
 * Informative: it locks no tax period.
 */
export function d406Declaration(
  objects: ObjectStore,
  rules: (tx: Transaction, companyId: string) => Promise<RuleContext>,
  secret: string,
  /** The engine's time: the file's creation date. */
  clock: () => number = Date.now,
): DeclarationKind {
  const sealer = new Sealer(secret);
  return {
    kind: 'D406',
    description:
      'Fișierul standard de control fiscal (D406, SAF-T): lunar sau trimestrial, și anual pentru active',
    tax: null,
    // A month or a quarter (L, T), the financial year of the assets file (A), or the month or
    // quarter ANAF asks the stock file for (C, `2026-03-C`).
    period: z.string().regex(/^\d{4}(-(0[1-9]|1[0-2]|Q[1-4]))?(?:-C)?$/),
    format(period) {
      if (stockPeriod(period))
        return periodStart(period.slice(0, -2)).slice(0, 7) >= firstPeriod
          ? `D406 C ${d406Namespace}`
          : null;
      if (annual(period))
        return Number(period) >= firstAssetsYear ? `D406 A ${d406Namespace}` : null;
      return periodStart(period).slice(0, 7) >= firstPeriod ? `D406 ${d406Namespace}` : null;
    },
    options: d406Options,
    inputs: async (tx, companyId, period) =>
      stockPeriod(period)
        ? stockInputs(tx, companyId, period)
        : annual(period)
          ? assetsInputs(tx, companyId, period)
          : (await booksOf(tx, companyId, period)).inputs,
    authorization: (tx, companyId, artifact) =>
      annual(artifact.period)
        ? assetsAuthorization(tx, companyId, artifact.period)
        : Promise.resolve([]),
    async prepare(tx, companyId, period, raw) {
      const options = d406Options.parse(raw);
      if (stockPeriod(period))
        return prepareStock(tx, companyId, period, options, bucharestDate(clock()));
      if (annual(period))
        return prepareAssets(
          tx,
          companyId,
          period,
          options,
          await rules(tx, companyId),
          bucharestDate(clock()),
        );
      const books = await booksOf(tx, companyId, period);
      const { loaded, end, inputs } = books;
      const problems: DeclarationProblem[] = [];
      const problem = (code: string, message: string) => {
        if (!problems.some((item) => item.code === code && item.message === message))
          problems.push({ code, message });
      };

      // The file follows the company's VAT period: monthly (L) or quarterly (T); outside VAT,
      // quarterly (OPANAF nr. 1.783/2021 anexa nr. 4 pct. 3: "Contribuabilii care nu sunt
      // înregistrați în scopuri de TVA, transmit Declarația informativă D406 trimestrial").
      const status = profileAt(loaded, 'vat.status', end);
      const nonPayer = status === 'non_vat';
      const quarter = `${end.slice(0, 4)}-Q${Math.ceil(Number(end.slice(5, 7)) / 3)}`;
      const vatPeriod = nonPayer ? quarter : vatPeriodOf(loaded, end);
      if (!nonPayer && !profileAt(loaded, 'vat.period', end))
        problem(
          'VAT_PERIOD',
          'Înregistrați perioada fiscală de TVA a companiei (lunară sau trimestrială): fișierul D406 se depune pentru aceeași perioadă.',
        );
      else if (vatPeriod !== period)
        problem(
          'VAT_PERIOD',
          nonPayer
            ? `Compania nu este înregistrată în scopuri de TVA la ${end}: fișierul D406 se depune trimestrial (${quarter}), nu pentru ${period} (OPANAF nr. 1.783/2021 anexa nr. 4 pct. 3).`
            : `Perioada fiscală a companiei pentru ${end} este ${vatPeriod}, nu ${period}.`,
        );
      // Nomenclator_Regim_fiscal: 100010 registered, 100040 under VAT on collection, 100020 the
      // small enterprises' special exemption scheme (art. 310), which a company outside VAT is.
      const vatRegime =
        status === 'normal_vat'
          ? profileAt(loaded, 'vat.cash', end) === 'yes'
            ? '100040'
            : '100010'
          : nonPayer
            ? '100020'
            : undefined;
      if (!vatRegime)
        problem('D406_VAT_REGIME', 'Înregistrați regimul de TVA al companiei (vat.status).');
      if (!books.year || books.year.to < end)
        problem(
          'D406_YEAR',
          `Perioada ${period} nu se află într-un singur exercițiu financiar înregistrat.`,
        );
      if (!books.seller)
        problem('SELLER_DETAILS', 'Înregistrați datele de identificare ale companiei.');
      if (!options.contact)
        problem(
          'D406_CONTACT',
          'Completați persoana de contact pentru ANAF: prenumele, numele și telefonul.',
        );
      if (options.disposals)
        problem(
          'D406_OPTION',
          'Ieșirile mijloacelor fixe (disposals) se indică doar pentru fișierul anual al activelor.',
        );

      // Accounts of classes 1–7, with the standard account chosen where ANAF subdivides one.
      for (const [synthetic, choice] of Object.entries(options.accounts)) {
        const choices = d406AmbiguousAccounts[synthetic];
        if (!choices)
          problem(
            'D406_ACCOUNT_CHOICE',
            `Contul ${synthetic} are un singur cont standard ANAF; nu se alege.`,
          );
        else if (!choices.includes(choice))
          problem(
            'D406_ACCOUNT_CHOICE',
            `Contul ${synthetic} corespunde conturilor standard ${choices.join(', ')}, nu ${choice}.`,
          );
      }
      const accountNames = new Map(books.accounts.map((row) => [row.code, row.name]));
      const accounts = books.accounts
        .filter((row) => /^[1-7]/.test(row.code))
        .map((row) => {
          const synthetic = syntheticOf(row.code);
          const choices = d406AmbiguousAccounts[synthetic];
          const standard = options.accounts[synthetic];
          if (choices && !standard)
            problem(
              'D406_ACCOUNT_CHOICE',
              `Contul ${synthetic} corespunde mai multor conturi standard ANAF (${choices.join(', ')}): alegeți unul.`,
            );
          const id = options.accountIds[row.code];
          return {
            code: row.code,
            ...(id ? { id } : {}),
            description: clip(row.name, 256),
            ...(choices && standard && choices.includes(standard) ? { standard } : {}),
            opening: lei(row.opening),
          };
        });

      // Partners: their identification, name and address.
      const parties = loaded.parties;
      const cnps = new Map(books.cnps.map((row) => [row.partyId, row.cnpSealed]));
      const personal = new Map<string, string>();
      const ids = new Map<string, string>();
      // A non-EU partner's VAT code in its state, as its recorded details give it (G3).
      const foreignVatId = (partyId: string, country: string) => {
        const row = books.details.get(partyId);
        const vatId = row
          ? ((JSON.parse(row.details) as Party).vatId ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
          : '';
        const code = vatId.startsWith(country) ? vatId.slice(country.length) : vatId;
        return code.length > 1 ? code : null;
      };
      for (const party of [...parties.values()]) {
        const taxId = (party.taxId ?? '').toUpperCase().replace(/\s+/g, '');
        const prefix = euVatPrefixes[party.country];
        if (party.kind === 'ro_individual') {
          const sealed = cnps.get(party.id);
          const cnp = sealed ? sealer.open(companyId, sealed) : '';
          if (!isValidCnp(cnp)) {
            problem(
              'D406_PARTY_CODE',
              `Înregistrați CNP-ul partenerului ${party.name} (parties.recordCnp): persoanele fizice se identifică prin CNP.`,
            );
            continue;
          }
          const id = d406PartyId({ kind: 'person', cnp });
          ids.set(party.id, id);
          personal.set(id, party.name);
        } else if (party.country === 'RO') {
          if (isValidCui(taxId)) ids.set(party.id, d406PartyId({ kind: 'ro', cui: taxId }));
          else problem('D406_PARTY_CODE', `Partenerul ${party.name} nu are un CUI valid.`);
        } else if (prefix && taxId.startsWith(prefix) && taxId.length > prefix.length)
          ids.set(
            party.id,
            d406PartyId({ kind: 'eu', country: prefix, vat: taxId.slice(prefix.length) }),
          );
        else if (!prefix && foreignVatId(party.id, party.country))
          // A partner outside the Union registered for VAT in its state, its code recorded with
          // its details (`parties.recordDetails`, vatId): 02, the country and that code (the
          // structure's S.C.1); one not registered (06, a code the company assigns) is not built.
          ids.set(
            party.id,
            d406PartyId({
              kind: 'foreign',
              country: party.country,
              code: foreignVatId(party.id, party.country)!,
            }),
          );
        else
          // A partner abroad without a VAT code of its state: a consumer of another state (its
          // sales booked by invoices.euConsumer) is an individual who declares no code, 04 with
          // a code the company assigns it uniquely ("pentru pers. fizice care nu își declară
          // CNP-ul pe tranzacții (exemplu: comerț online)"; ANAF's answers v1.2, MF.C.3, 6: one
          // per person, never a shared one); another, an economic operator not registered for
          // VAT, 05 (the Union) or 06 (outside it) with its country and that code (S.C.1). The
          // code is the partner's own id in the books, the same in every file.
          ids.set(
            party.id,
            d406PartyId({
              kind: 'internal',
              code: party.id.replace(/-/g, '').slice(0, 24).toUpperCase(),
              ...(books.consumers.has(party.id) ? {} : { country: party.country, eu: !!prefix }),
            }),
          );
      }
      // Invoices give the address of partners without recorded details.
      // A document's UBL, read from its retained file; the reason when there is none.
      const ubl = new Map<string, Invoice | string>();
      const invoiceOf = async (documentId: string) => {
        if (ubl.has(documentId)) return ubl.get(documentId)!;
        const document = loaded.documents.get(documentId);
        const proof = document?.evidenceId ? loaded.evidence.get(document.evidenceId) : undefined;
        let invoice: Invoice | string = 'nu are în registre fișierul UBL';
        if (proof)
          try {
            invoice = readInvoice(await objects.get(companyId, proof.hash));
          } catch (error) {
            invoice = `nu se poate citi ca factură UBL (${error instanceof Error ? error.message : 'format necunoscut'})`;
          }
        ubl.set(documentId, invoice);
        return invoice;
      };
      const addresses = new Map<string, D406Address>();
      for (const [partyId, row] of books.details)
        addresses.set(partyId, addressOf((JSON.parse(row.details) as Party).address));
      for (const documentId of books.recognized.values()) {
        const document = loaded.documents.get(documentId);
        if (!document?.partyId || addresses.has(document.partyId) || !parties.has(document.partyId))
          continue;
        const invoice = await invoiceOf(documentId);
        const sale =
          document.kind === invoiceKinds.sale || document.kind === invoiceKinds.saleCredit;
        const party =
          typeof invoice === 'string' ? undefined : sale ? invoice.buyer : invoice.seller;
        if (party?.address.city) addresses.set(document.partyId, addressOf(party.address));
      }

      // A refund a credit note of the period opened beyond its original's balance (462 owed to a
      // customer, 461 owed by a supplier: `invoices.credit`, `invoices.euConsumer`) is the
      // partner's line, as the receivable or payable it continues.
      const refundRole = (line: { openItemId: string | null }) => {
        const item = line.openItemId ? books.items.get(line.openItemId) : undefined;
        const documentId = item ? books.recognized.get(item.originEntryId) : undefined;
        const kind = documentId ? loaded.documents.get(documentId)?.kind : undefined;
        const account = item ? syntheticOf(item.controlAccount) : undefined;
        if (account === '462' && kind === invoiceKinds.saleCredit) return 'customer' as const;
        if (account === '461' && kind === invoiceKinds.purchaseCredit) return 'supplier' as const;
        return undefined;
      };
      const roleOf = (line: { account: string; openItemId: string | null }) =>
        partnerOf(line.account) ?? refundRole(line);
      const partnerKey = (partyId: string, account: string) => `${partyId}|${account}`;
      const partners = new Map<
        string,
        { partyId: string; account: string; opening: bigint; role: 'customer' | 'supplier' }
      >();
      for (const row of books.partnerOpenings)
        partners.set(partnerKey(row.partyId, row.account), {
          ...row,
          role: partnerOf(row.account)!,
        });
      for (const line of books.periodLines) {
        const item = line.openItemId ? books.items.get(line.openItemId) : undefined;
        const role = roleOf(line);
        if (item && role && !partners.has(partnerKey(item.partyId, line.account)))
          partners.set(partnerKey(item.partyId, line.account), {
            partyId: item.partyId,
            account: line.account,
            opening: 0n,
            role,
          });
      }
      const customers: D406Party[] = [];
      const suppliers: D406Party[] = [];
      for (const { partyId, account, opening, role } of partners.values()) {
        const party = parties.get(partyId)!;
        const id = ids.get(partyId);
        const address = addresses.get(partyId);
        if (!address)
          problem(
            'D406_PARTY_ADDRESS',
            `Înregistrați adresa partenerului ${party.name} (parties.recordDetails).`,
          );
        if (!id || !address) continue;
        (role === 'customer' ? customers : suppliers).push({
          id,
          name: clip(party.name, 256),
          address,
          account,
          opening: lei(opening),
        });
      }
      const partner = (line: { account: string; openItemId: string | null }) => {
        const item = line.openItemId ? books.items.get(line.openItemId) : undefined;
        const role = roleOf(line);
        const id = item ? ids.get(item.partyId) : undefined;
        if (!role || !item || !id) return {};
        return role === 'customer' ? { customer: id } : { supplier: id };
      };

      // The standard rate of a reverse charge, as its treatment computed it.
      let context: RuleContext | undefined;
      const standardRate = async (taxPoint: string) => {
        context ??= await rules(tx, companyId);
        try {
          return context.param<string>(
            'ro.vat.rate',
            'vat_chargeability_date',
            taxPoint as LocalDate,
            {
              category: 'S',
            },
          );
        } catch (error) {
          if (!(error instanceof RuleGapError)) throw error;
          problem('RULE_GAP', error.message);
          return undefined;
        }
      };
      /** An entry's VAT as TaxInformation, with the tax entry it came from. */
      const taxesOf = Map.groupBy(
        books.periodTaxes.filter((tax) => tax.tax === 'VAT'),
        (tax) => tax.entryId,
      );
      // The pro-rata of each pro-rata code's purchases: its BaseRate in the TaxTable.
      const baseRates = new Map<string, Set<number>>();
      const vatOf = async (entryId: string, number: number) => {
        const taxes = taxesOf.get(entryId) ?? [];
        const found: { tax: (typeof taxes)[number]; code: string }[] = [];
        // A sale outside VAT (art. 310) books no VAT: it is reported with the special scheme's
        // code on its revenue (`d406NonPayerSaleCode`), its base the revenue, no VAT. So is a
        // sale invoiced so on a day a late registration declares: its VAT is the
        // regularization's (REG-310), reported where it is booked.
        const documentId = books.recognized.get(entryId);
        const kind = documentId ? loaded.documents.get(documentId)?.kind : undefined;
        const header = books.headers.find((item) => item.id === entryId)!;
        const exempted =
          nonPayer ||
          books.lateRanges.some((range) => range.from <= header.date && header.date <= range.until);
        if (
          exempted &&
          !taxes.some((tax) => tax.tax === 'VAT') &&
          (kind === invoiceKinds.sale || kind === invoiceKinds.saleCredit)
        ) {
          const revenue = (linesOf.get(entryId) ?? [])
            .filter((line) => /^7/.test(line.account))
            .reduce((sum, line) => sum + (line.side === 'C' ? line.bani : -line.bani), 0n);
          found.push({
            tax: {
              companyId,
              entryId,
              taxNo: 0,
              key: 'vat',
              lineNo: null,
              tax: 'VAT',
              code: 'O',
              direction: 'output',
              baseBani: revenue,
              taxBani: 0n,
              deductibleBani: 0n,
              ledgerBani: 0n,
              taxPoint: header.date,
              exigibility: header.date,
              taxPeriod: null,
              partyId: null,
              documentId: documentId ?? null,
              originTaxEntry: null,
              currency: null,
              baseMinor: null,
              taxMinor: null,
              fxRateId: null,
              fxRate: null,
              attributes: '{}',
            },
            code: d406NonPayerSaleCode,
          });
          return found;
        }
        for (const tax of taxes) {
          const attributes = JSON.parse(tax.attributes) as Record<string, string>;
          // A cash register's day (G2): its sales need no invoice (art. 319 alin. (10)), 3803xx
          // by rate. An invoice issued for receipts (its two entries cancel out) has no lines.
          if (attributes.documentType === 'zreport' || attributes.fiscalReceipt) {
            if (attributes.invoiced || attributes.fiscalReceipt) continue;
            const code = d406ZReportCode(tax.code);
            if (code) found.push({ tax, code });
            else
              problem(
                'D406_TAX_CODE',
                `Raportul Z cu codul ${tax.code} din nota ${number} nu are un cod de taxă SAF-T stabilit.`,
              );
            continue;
          }
          // VAT on collection released by a collection or payment (4428 to 4427, or 4426 to
          // 4428): one note without a source document, reported once, by its chargeable side.
          if (attributes.release) {
            if (tax.exigibility === null) continue;
            const code = d406CashVatReleaseCode(tax.code);
            if (code) found.push({ tax, code });
            else
              problem(
                'D406_TAX_CODE',
                `TVA la încasare cu codul ${tax.code} din nota ${number} nu are un cod de taxă SAF-T stabilit.`,
              );
            continue;
          }
          // A purchase deducted under a pro-rata (art. 300 alin. (5)) is reported as one when the
          // whole entry is; one partly deducted otherwise has no single code.
          const deduction =
            tax.direction === 'output'
              ? undefined
              : attributes.prorata !== undefined
                ? BigInt(attributes.prorataTax ?? '0') === tax.taxBani
                  ? 'prorata'
                  : 'partial'
                : tax.deductibleBani === tax.taxBani
                  ? 'full'
                  : tax.deductibleBani === 0n
                    ? 'none'
                    : // Half of it deducted (art. 298), within a ban of rounding.
                      2n * tax.deductibleBani - tax.taxBani <= 1n &&
                        tax.taxBani - 2n * tax.deductibleBani <= 1n
                      ? 'half'
                      : 'partial';
          // A reverse charge at the standard rate of its tax point; an adjustment of rd. 34 at
          // the rate of the VAT it adjusts, as its entry records it.
          const rate = d406ReverseCharges.includes(tax.code)
            ? await standardRate(tax.taxPoint)
            : d406RatedAdjustments.includes(tax.code)
              ? attributes.rate
              : undefined;
          const code = d406VatTaxCode({
            direction: tax.direction,
            code: tax.code,
            ...(rate ? { rate } : {}),
            ...(deduction ? { deduction } : {}),
            // VAT a company outside VAT owes through the special return (art. 307 alin. (2)).
            ...(attributes.regime === 'special' ? { special: true } : {}),
            // A sale of the company under VAT on collection, or a purchase from a supplier in it.
            cashVat:
              tax.direction === 'output'
                ? attributes.cashVat !== undefined
                : supplierAppliesCashVat(attributes.cashVat),
            // A sale to a consumer in another Member State with the place in Romania (core ro/oss).
            ...(attributes.distance === 'origin' ? { distance: true } : {}),
          });
          if (code === null) {
            // The collected side of a reverse charge: its acquisition carries the code.
            if (!taxes.some((other) => other.direction === 'input' && other.code === tax.code))
              problem(
                'D406_TAX_CODE',
                `Taxarea inversă ${tax.code} din nota ${number} nu are partea deductibilă care o raportează.`,
              );
            continue;
          }
          if (code === undefined) {
            problem(
              'D406_TAX_CODE',
              `Operațiunile ${tax.direction === 'output' ? 'cu TVA colectată' : 'cu TVA deductibilă'} cu codul ${tax.code}${rate ? ` (${rate}%)` : ''}${deduction === 'partial' ? ', deduse parțial,' : deduction === 'none' ? ', fără drept de deducere,' : ''} nu au un cod de taxă SAF-T stabilit (nota ${number}).`,
            );
            continue;
          }
          if (d406BaseRateCode(code)) {
            const rates = baseRates.get(code) ?? new Set<number>();
            rates.add(Number(attributes.prorata));
            baseRates.set(code, rates);
          }
          found.push({ tax, code });
        }
        return found;
      };

      // The partner's receivable or payable of an entry, and its other lines that are not VAT: an
      // invoice's revenue, expense or advance (419, 409x) lines carry its VAT.
      const isCounterparty = (line: (typeof books.periodLines)[number]) => {
        const item = line.openItemId ? books.items.get(line.openItemId) : undefined;
        return item?.kind === 'receivable' || item?.kind === 'payable';
      };
      const isBase = (line: (typeof books.periodLines)[number]) =>
        !/^442/.test(line.account) && !isCounterparty(line);

      // Journals: one per journal code, each entry a transaction, its VAT on its base's line.
      const linesOf = Map.groupBy(books.periodLines, (line) => line.entryId);
      const journalMap = new Map<string, D406Journal>();
      const transactionIds = new Map<string, string>();
      const documentNumber = (entryId: string, number: number) => {
        const movement = books.movementOf.get(entryId);
        return (
          (movement ? books.bankReferences.get(movement) : undefined) ??
          books.justifying.get(entryId)?.number ??
          String(number)
        );
      };
      const entryVat = new Map<string, Awaited<ReturnType<typeof vatOf>>>();
      const entryBases = new Map<string, (typeof books.periodLines)[number][]>();
      for (const header of books.headers) {
        const journal = journals[header.journalCode];
        if (!journal) {
          problem(
            'D406_JOURNAL',
            `Jurnalul ${header.journalCode} nu are încă o descriere în fișierul D406.`,
          );
          continue;
        }
        const own = (linesOf.get(header.id) ?? []).filter((line) => /^[1-7]/.test(line.account));
        if (!own.length) continue;
        const document = documentNumber(header.id, header.number);
        const vat = await vatOf(header.id, header.number);
        entryVat.set(header.id, vat);
        // A tax withheld at source: its D100 TaxType and WHT TaxCode on the line it is withheld
        // from (the debit of the beneficiary's item), as ANAF's guide and answers say; one
        // declared in D112 (intellectual property) keeps the generic 000.
        const withheld = books.withholdings.get(header.id);
        if (withheld && withheld.taxCode === null && withheld.annual !== 'D112')
          problem(
            'D406_WHT',
            `Nota ${header.number} reține impozit la sursă (${withheld.type}, ${withheld.rate}%) fără un cod în nomenclatorul WHT al ANAF.`,
          );
        const whtLine =
          withheld?.taxCode && BigInt(withheld.tax) > 0n
            ? own.findIndex((line) => line.side === 'D' && line.account !== '446')
            : -1;
        // An invoice split over accounts or rates has a base line per part, in the parts' order:
        // each VAT goes to the lines of its category, shared by their amounts. Otherwise the base
        // of an entry's VAT is its first line that is neither a partner's nor VAT.
        const parts = books.allocations.get(header.id);
        // A Z report's VAT goes on its revenue lines, not on the cash, card or stock lines (G2).
        const zReport =
          vat.length > 0 &&
          vat.every(({ tax }) => JSON.parse(tax.attributes).documentType === 'zreport');
        // A sale's goods out of the stock register (G1: the stock account against 60x; G4: the
        // products against 711) carry no VAT: its base lines are its revenue's (G3).
        const sold =
          vat.length > 0 &&
          vat.every(({ tax }) => tax.direction === 'output') &&
          own.some((line) => /^7/.test(line.account));
        // VAT a company outside VAT owes through the special return (art. 307 alin. (2)): its
        // authority's item (4423) and the VAT expensed beside the base (the line before it) are
        // no base lines; the purchase's expense is.
        const special =
          vat.length > 0 && vat.every(({ tax }) => JSON.parse(tax.attributes).regime === 'special');
        const specialLines = new Set<number>();
        if (special)
          own.forEach((line, index) => {
            const item = line.openItemId ? books.items.get(line.openItemId) : undefined;
            if (item?.kind !== 'tax.payable') return;
            specialLines.add(index);
            const expensed = own[index - 1];
            if (expensed && expensed.side !== line.side && expensed.bani === line.bani)
              specialLines.add(index - 1);
          });
        // A count's shortage (G1, G2, G4: the stock account against 60x or 711) with its deducted
        // VAT adjusted (art. 304, Dr 635 / Cr 4426): the goods' lines carry no VAT, the
        // adjustment's expense is its base.
        const adjusted =
          vat.length > 0 &&
          vat.every(({ tax }) => tax.code.startsWith('ADJ-')) &&
          own.some((line) => /^3/.test(line.account));
        // A reception at sale price (G2): the VAT its price includes (Dr 371 / Cr 4428) and the
        // markup (Dr 371 / Cr 378), each written after the cost as the goods' line and its
        // credit, both on the warehouse's tag, carry no VAT: the cost's line is the base.
        const retailAdded = new Set<number>();
        if (vat.length)
          own.forEach((line, index) => {
            const goods = own[index - 1];
            if (
              isRetailTag(line.item ?? undefined) &&
              /^(378|4428)/.test(line.account) &&
              goods &&
              /^371/.test(goods.account) &&
              goods.item === line.item &&
              goods.bani === line.bani
            )
              retailAdded.add(index).add(index - 1);
          });
        const found = baseLinesOf(
          own.flatMap((line, index) =>
            isBase(line) &&
            (!zReport || /^70/.test(line.account)) &&
            !(sold && /^(3|60|711)/.test(line.account)) &&
            !(adjusted && /^(3|60|711)/.test(line.account)) &&
            !retailAdded.has(index) &&
            !specialLines.has(index) &&
            // The customs debt of an import (446, G3) is the authority's, not a base; nor is
            // another tax owed to it (the Union scheme's VAT on 4423, V4), nor the exchange
            // difference a credit note realizes on the receivable it reduces.
            !(vat.length > 0 && /^446/.test(line.account)) &&
            !(vat.length > 0 && /^(665|765)/.test(line.account)) &&
            !(
              vat.length > 0 &&
              /^tax\./.test(
                (line.openItemId ? books.items.get(line.openItemId)?.kind : undefined) ?? '',
              )
            )
              ? [{ index, account: line.account }]
              : [],
          ),
          parts,
        );
        if (!found)
          problem(
            'D406_SPLIT',
            `Nota ${header.number}: liniile ei nu urmează părțile facturii, iar TVA nu se poate atribui.`,
          );
        const { bases, releases } = found ?? { bases: [], releases: new Set<number>() };
        entryBases.set(
          header.id,
          bases.map((index) => own[index]!),
        );
        const base = bases[0] ?? -1;
        if (found && vat.length && base < 0)
          problem(
            'D406_TAX_LINE',
            `Nota ${header.number} are TVA, dar nicio linie pe care să se raporteze baza.`,
          );
        // A lease's principal leaves 167 at its carrying amount, not at the invoice's rate: its
        // line is written in lei, as the invoice's lines are.
        const currencyOf = (line: (typeof own)[number], index: number) =>
          line.currency && line.currencyMinor && !releases.has(index)
            ? {
                code: line.currency,
                amount: formatMoney(line.currencyMinor, line.currency),
                rate: line.fxRate ?? '',
              }
            : undefined;
        const taxFor = new Map<number, D406Tax[]>();
        // A late registration's regularization (REG-310): the VAT collected on its expense (Dr
        // 635 / Cr 4427), the VAT deducted on its income (Dr 4426 / Cr 7588), each on the line
        // its VAT line is booked against.
        const regularized =
          vat.length > 0 &&
          bases.length === vat.length &&
          vat.every(({ tax }) => tax.code === regimeCodes.late);
        if (regularized) {
          for (const { tax, code } of vat) {
            const index = bases.find((at) =>
              tax.direction === 'output' ? own[at]!.side === 'D' : own[at]!.side === 'C',
            );
            if (index === undefined) {
              problem(
                'D406_SPLIT',
                `Nota ${header.number}: regularizarea ${tax.code} nu are linia de bază.`,
              );
              continue;
            }
            taxFor.set(index, [
              ...(taxFor.get(index) ?? []),
              { type: '300', code, base: lei(tax.baseBani), amount: lei(tax.taxBani) },
            ]);
          }
        } else if (vat.length && bases.length > 1) {
          const keys = parts?.map((part) => part.vat) ?? vat.map(({ tax }) => categoryOf(tax));
          if (keys.length !== bases.length)
            problem(
              'D406_SPLIT',
              `Nota ${header.number} are ${bases.length} linii de bază pentru ${keys.length} părți: TVA nu se poate atribui.`,
            );
          else
            for (const { tax, code } of vat) {
              const members = bases.flatMap((index, j) =>
                keys[j] === categoryOf(tax) ? [{ index, j }] : [],
              );
              if (!members.length) {
                problem(
                  'D406_SPLIT',
                  `Nota ${header.number}: TVA ${categoryOf(tax)} nu are o linie de bază.`,
                );
                continue;
              }
              const weights = members.map(({ index, j }) => {
                const amount = parts ? parseMoney(parts[j]!.amount, 'RON') : own[index]!.bani;
                return amount;
              });
              const shares = prorate(tax.baseBani, weights);
              const amounts = prorate(tax.taxBani, weights);
              // A line kept in its currency gives its VAT in that currency too, shared the same way.
              const minors =
                tax.currency && tax.taxMinor !== null ? prorate(tax.taxMinor, weights) : undefined;
              members.forEach(({ index }, k) =>
                taxFor.set(index, [
                  ...(taxFor.get(index) ?? []),
                  {
                    type: '300',
                    code,
                    base: lei(shares[k]!),
                    amount: lei(amounts[k]!),
                    ...(minors && currencyOf(own[index]!, index)
                      ? { currencyAmount: formatMoney(minors[k]!, tax.currency!) }
                      : {}),
                  },
                ]),
              );
            }
        }
        const transactionLines = own.map((line, index): D406Line => {
          const currency = currencyOf(line, index);
          const named = partner(line);
          const item = line.openItemId ? books.items.get(line.openItemId) : undefined;
          // Lines without VAT, payroll's among them, carry TaxType 000 and TaxCode 000000: for
          // taxes other than VAT and those withheld at source (WHT) ANAF recommends the generic
          // code (Întrebări și răspunsuri SAF-T v1.2, MF.TT.2, opțiunea 2).
          const tax: D406Tax[] =
            index === whtLine
              ? [
                  {
                    type: withheld!.type,
                    code: withheld!.taxCode!,
                    base: lei(BigInt(withheld!.base)),
                    amount: lei(BigInt(withheld!.tax)),
                  },
                ]
              : bases.length > 1
                ? (taxFor.get(index) ?? [])
                : index === base
                  ? vat.map(({ tax, code }) => ({
                      type: '300',
                      code,
                      base: lei(tax.baseBani),
                      amount: lei(tax.taxBani),
                      ...(currency && tax.currency
                        ? { currencyAmount: formatMoney(tax.taxMinor ?? 0n, tax.currency) }
                        : {}),
                    }))
                  : [];
          return {
            id: `${header.number}.${line.lineNo}`,
            account: line.account,
            side: line.side === 'D' ? 'debit' : 'credit',
            amount: lei(line.bani),
            ...(currency ? { currency } : {}),
            ...named,
            document,
            description: clip(
              line.memo ??
                (item && (named.customer || named.supplier)
                  ? parties.get(item.partyId)?.name
                  : undefined) ??
                accountNames.get(line.account) ??
                line.account,
              256,
            ),
            ...(tax.length ? { tax } : {}),
          };
        });
        const id = String(header.number);
        transactionIds.set(header.id, id);
        const target = journalMap.get(header.journalCode) ?? {
          id: header.journalCode,
          ...journal,
          transactions: [],
        };
        target.transactions.push({
          id,
          date: books.justifying.get(header.id)?.date ?? header.date,
          posted: header.date,
          // The engine's time of posting; the database's for entries posted before it was kept.
          entered: bucharestDate(header.engineAt ?? Date.parse(header.postedAt)),
          description: clip(header.description, 256),
          lines: transactionLines,
        });
        journalMap.set(header.journalCode, target);
      }

      // Invoices recognized in the period, with their UBL lines and the accounts booked.
      const products = new Map<string, D406Product>();
      const salesInvoices: D406Invoice[] = [];
      const purchaseInvoices: D406Invoice[] = [];
      for (const header of books.headers) {
        const documentId = books.recognized.get(header.id);
        const document = documentId ? loaded.documents.get(documentId) : undefined;
        if (!document || !(Object.values(invoiceKinds) as string[]).includes(document.kind))
          continue;
        const sale =
          document.kind === invoiceKinds.sale || document.kind === invoiceKinds.saleCredit;
        const number = document.number ?? String(header.number);
        const invoice = await invoiceOf(document.id);
        if (typeof invoice === 'string') {
          problem(
            'D406_INVOICE_SOURCE',
            `Factura ${number} ${invoice}: liniile ei nu se pot raporta.`,
          );
          continue;
        }
        if (invoice.adjustments.length) {
          problem(
            'D406_INVOICE',
            `Factura ${number} are reduceri sau majorări la nivelul documentului: liniile ei nu se raportează încă.`,
          );
          continue;
        }
        const own = linesOf.get(header.id) ?? [];
        const partnerLine = own.find((line) => isCounterparty(line) && roleOf(line));
        // The base lines the ledger's VAT went on, one per part.
        const bases = entryBases.get(header.id) ?? [];
        const baseLine = bases[0];
        const item = partnerLine ? books.items.get(partnerLine.openItemId!) : undefined;
        const party = item ? ids.get(item.partyId) : undefined;
        // An invoice issued for fiscal receipts (G2) has no entry of its own: ANAF's answers report
        // it among the sales invoices as type 751 with code 310327, which is not written yet.
        if (
          !own.length &&
          books.periodTaxes.some(
            (tax) => tax.entryId === header.id && JSON.parse(tax.attributes).fiscalReceipt,
          )
        ) {
          problem(
            'D406_RECEIPT_INVOICE',
            `Factura ${number}, emisă pentru bonuri fiscale, se raportează ca factură în scopuri contabile (tip 751, cod 310327), ceea ce nu este încă scris.`,
          );
          continue;
        }
        if (!partnerLine || !baseLine || !party) continue;
        const vat = entryVat.get(header.id) ?? [];
        if (!vat.length) {
          problem(
            'D406_TAX_CODE',
            `Factura ${number} nu are TVA înregistrată (categoria ${invoice.vatBreakdown[0]?.category ?? '?'}): codul ei de taxă SAF-T nu este stabilit.`,
          );
          continue;
        }
        // Each UBL line goes to the account its VAT category was booked on: the category's only
        // part, or, for a split invoice, the part of its category and sign (a negative line is an
        // advance deducted) when they all share one account. A lease's instalment books one rate
        // on 167 and 666: each line goes to the part its amount makes up.
        const norm = (key: string) =>
          key.replace(/^S-(.+)$/, (_, rate: string) => `S-${Number(rate)}`);
        const parts = books.allocations.get(header.id);
        const lease = parts?.some(isLeasePart) ?? false;
        const keys = (parts?.map((part) => part.vat) ?? vat.map(({ tax }) => categoryOf(tax))).map(
          norm,
        );
        const lineKey = (line: (typeof invoice.lines)[number]) =>
          norm(line.vat.category === 'S' ? `S-${line.vat.rate}` : line.vat.category);
        // The one way to group a rate's lines so that each part's lines add up to its amount: a
        // lease's instalment (167 and 666 at one rate), or several accounts at one rate whose
        // lines nothing else tells apart.
        const grouped = () => {
          if (!parts || keys.length !== bases.length) return undefined;
          try {
            return linesByAmount(
              invoice.lines.map((line) => ({
                key: lineKey(line),
                amount: parseMoney(line.netAmount, invoice.currency),
              })),
              parts.map((part, j) => ({
                key: keys[j]!,
                amount: parseMoney(part.amount, invoice.currency),
                account: bases[j]!.account,
              })),
            );
          } catch {
            return undefined;
          }
        };
        let byAmount = lease ? grouped() : undefined;
        // Goods received or returned: each line's stock account, as its item was booked (G1).
        const stockOf = books.stockAccounts.get(header.id);
        const attributed = (line: (typeof invoice.lines)[number]) => {
          if (bases.length === 1) return baseLine.account;
          if (keys.length !== bases.length) return undefined;
          let members = bases.flatMap((base, j) => (keys[j] === lineKey(line) ? [j] : []));
          const stockAccount = stockOf?.get(line.id);
          if (stockAccount && members.some((j) => bases[j]!.account === stockAccount))
            return stockAccount;
          const negative = line.netAmount.startsWith('-') !== (invoice.typeCode === '381');
          const signed = parts
            ? members.filter((j) => parts[j]!.amount.startsWith('-') === negative)
            : members;
          if (signed.length) members = signed;
          const accounts = [...new Set(members.map((j) => bases[j]!.account))];
          return accounts.length === 1 ? accounts[0] : undefined;
        };
        let lineAccounts = invoice.lines.map((line, index) =>
          byAmount ? bases[byAmount[index]!]!.account : attributed(line),
        );
        // A rate's lines booked on several accounts, told apart by their amounts alone.
        if (!byAmount && lineAccounts.some((account) => account === undefined)) {
          byAmount = grouped();
          if (byAmount)
            lineAccounts = invoice.lines.map(
              (line, index) => attributed(line) ?? bases[byAmount![index]!]!.account,
            );
        }
        if (lineAccounts.some((account) => account === undefined)) {
          problem(
            'D406_SPLIT',
            `Factura ${number}: liniile unei cote TVA sunt înregistrate în mai multe conturi și nu se pot atribui.`,
          );
          continue;
        }
        // A finance lease's instalments are services (Codul fiscal art. 271 alin. (3) lit. a)).
        const kinds = lineAccounts.map((account) =>
          /^419/.test(account!)
            ? options.advances
            : lease && /^(167|666)/.test(account!)
              ? 'services'
              : productKinds.find(([pattern]) => pattern.test(account!))?.[1],
        );
        const unknown = lineAccounts.find((_, index) => !kinds[index]);
        if (unknown) {
          problem(
            'D406_PRODUCT_KIND',
            /^419/.test(unknown)
              ? 'Indicați dacă avansurile clienților (419) sunt pentru bunuri sau servicii (advances).'
              : `Liniile facturilor înregistrate în contul ${unknown} nu se pot încadra ca bunuri sau servicii.`,
          );
          continue;
        }
        // A credit note's lines are positive in the UBL and negative in the books (red storno).
        const sign = invoice.typeCode === '381' ? -1n : 1n;
        const foreign = invoice.currency !== 'RON';
        // A lease's principal line keeps the lease's rate, not the invoice's: the partner's line
        // gives it.
        const rateLine = lease ? partnerLine : baseLine;
        const rate = (rateLine.currency ? rateLine.fxRate : partnerLine.fxRate) ?? '';
        const withCurrency = Boolean(rateLine.currency);
        if (foreign && !/^\d+(\.\d+)?$/.test(rate)) {
          problem(
            'D406_INVOICE',
            `Factura ${number} în ${invoice.currency} nu are în registre cursul la care s-a înregistrat.`,
          );
          continue;
        }
        const converted = (minor: bigint) =>
          foreign
            ? d406ConvertedAmount({
                code: invoice.currency,
                amount: formatMoney(minor, invoice.currency),
                rate,
              })
            : minor;
        let amounts: bigint[];
        try {
          amounts = invoice.lines.map(
            (line) => sign * parseMoney(line.netAmount, invoice.currency),
          );
        } catch {
          problem(
            'D406_INVOICE',
            `Factura ${number} are valori de linie în ${invoice.currency} pe care fișierul nu le poate prelua.`,
          );
          continue;
        }
        const lineLei = amounts.map(converted);
        // Each VAT is shared among the lines of its category in proportion to their amounts.
        const shares = vat.map(({ tax, code }) => {
          const members = invoice.lines.flatMap((line, index) =>
            bases.length === 1 || lineKey(line) === norm(categoryOf(tax)) ? [index] : [],
          );
          const spread = (total: bigint, values: bigint[]) => {
            const parts = prorate(
              total,
              members.map((index) => values[index]!),
            );
            return invoice.lines.map((_, index) =>
              members.includes(index) ? parts[members.indexOf(index)]! : 0n,
            );
          };
          if (withCurrency && foreign) {
            const minor = spread(tax.taxMinor ?? 0n, amounts);
            return { code, tax, members, minor, bani: minor.map(converted) };
          }
          return { code, tax, members, minor: undefined, bani: spread(tax.taxBani, lineLei) };
        });
        const target = sale ? salesInvoices : purchaseInvoices;
        target.push({
          number: invoice.number,
          party,
          account: partnerLine.account,
          date: invoice.issueDate,
          type: invoice.typeCode,
          transaction: transactionIds.get(header.id)!,
          lines: invoice.lines.map((line, index) => {
            const code =
              line.name.length <= 70
                ? line.name
                : `${line.name.slice(0, 61)}-${hashOf(line.name).slice(0, 8)}`;
            const known = products.get(code);
            const kind = kinds[index]!;
            if (known && known.kind !== kind)
              problem(
                'D406_PRODUCT_KIND',
                `Articolul ${line.name} apare pe facturi și ca bun, și ca serviciu.`,
              );
            if (!known)
              products.set(code, {
                code,
                description: clip(line.name, 256),
                kind,
                unit: line.unitCode,
                ...(line.classification?.scheme === 'TSP' &&
                /^\d{8}$/.test(line.classification.code)
                  ? { commodityCode: line.classification.code }
                  : {}),
              });
            const price = parseDecimal(line.price);
            const per = parseDecimal(line.baseQuantity ?? '1');
            const exchange = parseDecimal(foreign ? rate : '1');
            const currency: D406Currency | undefined =
              withCurrency && foreign
                ? {
                    code: invoice.currency,
                    amount: formatMoney(amounts[index]!, invoice.currency),
                    rate,
                  }
                : undefined;
            return {
              account: lineAccounts[index]!,
              product: code,
              description: clip(line.name, 256),
              quantity: sign < 0n ? negated(line.quantity) : line.quantity,
              unit: line.unitCode,
              unitPrice: lei(
                roundRatio(
                  {
                    numerator: price.numerator * per.denominator * exchange.numerator,
                    denominator: price.denominator * per.numerator * exchange.denominator,
                  },
                  2,
                  'halfAwayFromZero',
                ),
              ),
              amount: lei(lineLei[index]!),
              ...(currency ? { currency } : {}),
              taxPointDate: shares[0]!.tax.taxPoint,
              tax: shares
                .filter((share) => share.members.includes(index))
                .map((share) => ({
                  type: '300',
                  code: share.code,
                  base: lei(lineLei[index]!),
                  amount: lei(share.bani[index]!),
                  ...(share.minor
                    ? { currencyAmount: formatMoney(share.minor[index]!, invoice.currency) }
                    : {}),
                })),
            };
          }),
        });
      }

      // Payments: the bank movements settling customers and suppliers.
      const kinds = new Map(books.treasury.map((row) => [row.ledgerAccount, row.kind]));
      const payments: D406Payment[] = [];
      for (const header of books.headers) {
        const movementId = books.movementOf.get(header.id);
        const movement = movementId ? loaded.movements.get(movementId) : undefined;
        const settled = (linesOf.get(header.id) ?? []).filter(
          (line) => line.openItemId && roleOf(line),
        );
        if (!movement || !settled.length || !transactionIds.has(header.id)) continue;
        payments.push({
          reference: documentNumber(header.id, header.number),
          date: movement.bookingDate,
          mechanism: kinds.get(movement.ledgerAccount) === 'cash' ? '10' : '42',
          description: clip(header.description, 256),
          direction: movement.amountMinor > 0n ? 'collection' : 'payment',
          transaction: transactionIds.get(header.id)!,
          lines: settled.map((line) => {
            const item = books.items.get(line.openItemId!)!;
            const settledDocument = item.documentId
              ? loaded.documents.get(item.documentId)
              : undefined;
            return {
              account: line.account,
              ...partner(line),
              ...(settledDocument?.number ? { document: settledDocument.number } : {}),
              description: clip(parties.get(item.partyId)?.name ?? line.account, 256),
              amount: lei(line.bani),
              ...(line.currency && line.currencyMinor
                ? {
                    currency: {
                      code: line.currency,
                      amount: formatMoney(line.currencyMinor, line.currency),
                      rate: line.fxRate ?? '',
                    },
                  }
                : {}),
            };
          }),
        });
      }

      const byId = (a: D406Party, b: D406Party) =>
        a.id === b.id ? (a.account < b.account ? -1 : 1) : a.id < b.id ? -1 : 1;
      customers.sort(byId);
      suppliers.sort(byId);

      const seller = books.seller;
      if (problems.length || !seller || !vatRegime || !options.contact)
        return { xml: '', inputs, problems, summary: null };
      const details = JSON.parse(seller.details) as Party;
      const model: D406 = {
        ...filePeriod(period),
        created: bucharestDate(clock()),
        software: { company: 'xFactura', name: 'xFactura', version: '0.0.1' },
        company: {
          cui: books.company!.cui,
          name: details.name,
          address: addressOf(details.address),
          contact: options.contact,
          ibans: books.treasury
            .filter((row) => row.kind === 'bank' && row.iban && row.openedOn <= end)
            .map((row) => row.iban!),
          vatRegime,
        },
        accounts,
        customers,
        suppliers,
        products: [...products.values()].sort((a, b) => (a.code < b.code ? -1 : 1)),
        journals: Object.keys(journals).flatMap((code) => journalMap.get(code) ?? []),
        salesInvoices,
        purchaseInvoices,
        payments,
        ...(baseRates.size
          ? {
              baseRates: Object.fromEntries(
                [...baseRates].map(([code, rates]) => [code, [...rates].sort((a, b) => a - b)]),
              ),
            }
          : {}),
      };
      // The writer's checks, each with where it applies; a CNP is never shown.
      const where = (path: string) => {
        const [section, first, , second] = path.split('.');
        const index = Number(first);
        if (section === 'journals' && second !== undefined)
          return `nota ${model.journals[index]!.transactions[Number(second)]!.id}`;
        if ((section === 'salesInvoices' || section === 'purchaseInvoices') && first !== undefined)
          return `factura ${model[section][index]!.number}`;
        if ((section === 'customers' || section === 'suppliers') && first !== undefined)
          return `${model[section][index]!.name}, contul ${model[section][index]!.account}`;
        if (section === 'accounts' && first !== undefined)
          return `contul ${model.accounts[index]!.code}`;
        if (section === 'payments' && first !== undefined)
          return `plata ${model.payments[index]!.reference}`;
        if (section === 'products' && first !== undefined)
          return `articolul ${model.products[index]!.description}`;
        return undefined;
      };
      const redact = (message: string) =>
        [...personal].reduce(
          (text, [id, name]) => text.replaceAll(id, `03… (${name})`).replaceAll(id.slice(2), '…'),
          message,
        );
      for (const check of checkD406(model))
        if (check.severity === 'error') {
          const place = where(check.path);
          problem(
            check.code,
            redact(place ? `${check.message.replace(/\.$/, '')} (${place}).` : check.message),
          );
        }
      if (problems.length) return { xml: '', inputs, problems, summary: null };
      return {
        xml: writeD406(model),
        inputs,
        problems,
        summary: {
          period,
          type: model.type,
          accounts: model.accounts.length,
          customers: model.customers.length,
          suppliers: model.suppliers.length,
          transactions: model.journals.reduce((sum, item) => sum + item.transactions.length, 0),
          salesInvoices: model.salesInvoices.length,
          purchaseInvoices: model.purchaseInvoices.length,
          payments: model.payments.length,
          products: model.products.length,
          vatCodes: calculateD406(model).vatCodes,
        },
      };
    },
  };
}
