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
import {
  d406CashVatReleaseCode,
  d406ReverseCharges,
  d406VatTaxCode,
} from 'xfactura-core/ro/saft/tax-codes';
import { invoiceKinds } from 'xfactura-core/ro/treatments/invoices';
import { vatPeriodEnd } from 'xfactura-core/ro/treatments/vat-settlement';
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
  taxEntries,
  treasuryAccounts,
} from '../db/schema';
import { justifyingDocuments } from '../kernel/reports';
import { loadState, mergeStates } from '../kernel/state';
import { periodStart, sellerDetails } from './d300';
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
    /** What the customers' advances (419) are for: the advance invoices' lines are reported as
     * goods or services. */
    advances: z.enum(['goods', 'services']).optional(),
  })
  .strict();

/** ANAF's validator parameters with the 21% and 11% codes apply from the 2025-07 periods;
 * earlier periods are not pinned. */
const firstPeriod = '2025-07';

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
      const id = row.documentId ?? (input.get(row.entryId)!.documentId as string | undefined);
      return id ? [[row.entryId, id] as const] : [];
    }),
  );
  // Invoices split over accounts: each part's VAT category and amount, in the lines' order.
  const allocations = new Map(
    treatments.flatMap((row) => {
      const parts = input.get(row.entryId)!.allocations as
        { vat: string; amount: string }[] | undefined;
      return (row.treatmentId === 'invoices.recognize' || row.treatmentId === 'invoices.credit') &&
        parts
        ? [[row.entryId, parts] as const]
        : [];
    }),
  );
  const movementOf = new Map(
    treatments.flatMap((row) =>
      row.treatmentId === 'bank.settle'
        ? [[row.entryId, input.get(row.entryId)!.movementId as string] as const]
        : [],
    ),
  );
  const partyIds = [
    ...new Set([
      ...partnerOpenings.map((row) => row.partyId),
      ...[...items.values()]
        .filter((item) => partnerOf(item.controlAccount))
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

  const inputs: ReadSetEntry[] = [
    ...state.readSet,
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
): DeclarationKind {
  const sealer = new Sealer(secret);
  return {
    kind: 'D406',
    description: 'Fișierul standard de control fiscal (D406, SAF-T), lunar sau trimestrial',
    tax: null,
    period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/),
    format(period) {
      return periodStart(period).slice(0, 7) >= firstPeriod ? `D406 ${d406Namespace}` : null;
    },
    options: d406Options,
    inputs: async (tx, companyId, period) => (await booksOf(tx, companyId, period)).inputs,
    async prepare(tx, companyId, period, raw) {
      const options = d406Options.parse(raw);
      const books = await booksOf(tx, companyId, period);
      const { loaded, end, inputs } = books;
      const problems: DeclarationProblem[] = [];
      const problem = (code: string, message: string) => {
        if (!problems.some((item) => item.code === code && item.message === message))
          problems.push({ code, message });
      };

      // The file follows the company's VAT period: monthly (L) or quarterly (T).
      const vatPeriod = vatPeriodOf(loaded, end);
      if (!profileAt(loaded, 'vat.period', end))
        problem(
          'VAT_PERIOD',
          'Înregistrați perioada fiscală de TVA a companiei (lunară sau trimestrială): fișierul D406 se depune pentru aceeași perioadă.',
        );
      else if (vatPeriod !== period)
        problem(
          'VAT_PERIOD',
          `Perioada fiscală a companiei pentru ${end} este ${vatPeriod}, nu ${period}.`,
        );
      const status = profileAt(loaded, 'vat.status', end);
      const vatRegime =
        status === 'normal_vat'
          ? profileAt(loaded, 'vat.cash', end) === 'yes'
            ? '100040'
            : '100010'
          : undefined;
      if (!vatRegime)
        problem(
          'D406_VAT_REGIME',
          status === 'non_vat'
            ? 'Regimul fiscal al unei companii neînregistrate în scopuri de TVA (100020, regimul special de scutire, sau 100050, persoană neimpozabilă) nu rezultă din registre.'
            : 'Înregistrați regimul de TVA al companiei (vat.status).',
        );
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
          return {
            code: row.code,
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
        else
          problem(
            'D406_PARTY_CODE',
            prefix
              ? `Partenerul ${party.name} din ${party.country} nu are cod de TVA (${prefix}…): codul lui în fișier (01 sau 05) nu rezultă din registre.`
              : `Partenerul ${party.name} din ${party.country}: codul lui în fișier (02 cu codul fiscal sau 06 cu un cod intern) nu rezultă din registre.`,
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

      const partnerKey = (partyId: string, account: string) => `${partyId}|${account}`;
      const partners = new Map<string, { partyId: string; account: string; opening: bigint }>();
      for (const row of books.partnerOpenings)
        partners.set(partnerKey(row.partyId, row.account), { ...row });
      for (const line of books.periodLines) {
        const item = line.openItemId ? books.items.get(line.openItemId) : undefined;
        if (
          item &&
          partnerOf(line.account) &&
          !partners.has(partnerKey(item.partyId, line.account))
        )
          partners.set(partnerKey(item.partyId, line.account), {
            partyId: item.partyId,
            account: line.account,
            opening: 0n,
          });
      }
      const customers: D406Party[] = [];
      const suppliers: D406Party[] = [];
      for (const { partyId, account, opening } of partners.values()) {
        const party = parties.get(partyId)!;
        const id = ids.get(partyId);
        const address = addresses.get(partyId);
        if (!address)
          problem(
            'D406_PARTY_ADDRESS',
            `Înregistrați adresa partenerului ${party.name} (parties.recordDetails).`,
          );
        if (!id || !address) continue;
        (partnerOf(account) === 'customer' ? customers : suppliers).push({
          id,
          name: clip(party.name, 256),
          address,
          account,
          opening: lei(opening),
        });
      }
      const partner = (line: { account: string; openItemId: string | null }) => {
        const item = line.openItemId ? books.items.get(line.openItemId) : undefined;
        const role = partnerOf(line.account);
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
      const vatOf = async (entryId: string, number: number) => {
        const taxes = taxesOf.get(entryId) ?? [];
        const found: { tax: (typeof taxes)[number]; code: string }[] = [];
        for (const tax of taxes) {
          const attributes = JSON.parse(tax.attributes) as Record<string, string>;
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
          const deduction =
            tax.direction === 'output'
              ? undefined
              : tax.deductibleBani === tax.taxBani
                ? 'full'
                : tax.deductibleBani === 0n
                  ? 'none'
                  : // Half of it deducted (art. 298), within a ban of rounding.
                    2n * tax.deductibleBani - tax.taxBani <= 1n &&
                      tax.taxBani - 2n * tax.deductibleBani <= 1n
                    ? 'half'
                    : 'partial';
          const rate = d406ReverseCharges.includes(tax.code)
            ? await standardRate(tax.taxPoint)
            : undefined;
          const code = d406VatTaxCode({
            direction: tax.direction,
            code: tax.code,
            ...(rate ? { rate } : {}),
            ...(deduction ? { deduction } : {}),
            // A sale of the company under VAT on collection, or a purchase from a supplier in it.
            cashVat:
              tax.direction === 'output'
                ? attributes.cashVat !== undefined
                : supplierAppliesCashVat(attributes.cashVat),
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
        // The base of an entry's VAT is its first line that is neither a partner's nor VAT.
        const base = own.findIndex(isBase);
        if (vat.length && base < 0)
          problem(
            'D406_TAX_LINE',
            `Nota ${header.number} are TVA, dar nicio linie pe care să se raporteze baza.`,
          );
        // An invoice split over accounts or rates has a base line per part, in the parts' order:
        // each VAT goes to the lines of its category, shared by their amounts.
        const bases = own.flatMap((line, index) => (isBase(line) ? [index] : []));
        const taxFor = new Map<number, D406Tax[]>();
        if (vat.length && bases.length > 1) {
          const parts = books.allocations.get(header.id);
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
              members.forEach(({ index }, k) =>
                taxFor.set(index, [
                  ...(taxFor.get(index) ?? []),
                  { type: '300', code, base: lei(shares[k]!), amount: lei(amounts[k]!) },
                ]),
              );
            }
        }
        const transactionLines = own.map((line, index): D406Line => {
          const currency =
            line.currency && line.currencyMinor
              ? {
                  code: line.currency,
                  amount: formatMoney(line.currencyMinor, line.currency),
                  rate: line.fxRate ?? '',
                }
              : undefined;
          const named = partner(line);
          const item = line.openItemId ? books.items.get(line.openItemId) : undefined;
          const tax: D406Tax[] =
            bases.length > 1
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
          entered: bucharestDate(Date.parse(header.postedAt)),
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
        const partnerLine = own.find((line) => isCounterparty(line) && partnerOf(line.account));
        const baseLine = own.find(isBase);
        const item = partnerLine ? books.items.get(partnerLine.openItemId!) : undefined;
        const party = item ? ids.get(item.partyId) : undefined;
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
        // advance deducted) when they all share one account.
        const norm = (key: string) =>
          key.replace(/^S-(.+)$/, (_, rate: string) => `S-${Number(rate)}`);
        const bases = own.filter(isBase);
        const parts = books.allocations.get(header.id);
        const keys = (parts?.map((part) => part.vat) ?? vat.map(({ tax }) => categoryOf(tax))).map(
          norm,
        );
        const lineKey = (line: (typeof invoice.lines)[number]) =>
          norm(line.vat.category === 'S' ? `S-${line.vat.rate}` : line.vat.category);
        const lineAccounts = invoice.lines.map((line) => {
          if (bases.length === 1) return baseLine.account;
          if (keys.length !== bases.length) return undefined;
          let members = bases.flatMap((base, j) => (keys[j] === lineKey(line) ? [j] : []));
          const negative = line.netAmount.startsWith('-') !== (invoice.typeCode === '381');
          const signed = parts
            ? members.filter((j) => parts[j]!.amount.startsWith('-') === negative)
            : members;
          if (signed.length) members = signed;
          const accounts = [...new Set(members.map((j) => bases[j]!.account))];
          return accounts.length === 1 ? accounts[0] : undefined;
        });
        if (lineAccounts.some((account) => account === undefined)) {
          problem(
            'D406_SPLIT',
            `Factura ${number}: liniile unei cote TVA sunt înregistrate în mai multe conturi și nu se pot atribui.`,
          );
          continue;
        }
        const kinds = lineAccounts.map((account) =>
          /^419/.test(account!)
            ? options.advances
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
        const rate = (baseLine.currency ? baseLine.fxRate : partnerLine.fxRate) ?? '';
        const withCurrency = Boolean(baseLine.currency);
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
          (line) => line.openItemId && partnerOf(line.account),
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
        created: bucharestDate(Date.now()),
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
