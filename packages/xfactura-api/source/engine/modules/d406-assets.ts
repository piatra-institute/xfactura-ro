import { and, asc, desc, eq, gte, inArray, like, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Party } from 'xfactura-core/einvoice';
import { hashOf } from 'xfactura-core/hash';
import { profileAt, type ReadSetEntry } from 'xfactura-core/kernel';
import { formatScaled } from 'xfactura-core/money';
import { euVatPrefixes } from 'xfactura-core/ro/geo';
import { isValidCui } from 'xfactura-core/ro/identifiers';
import { d406AmbiguousAccounts, syntheticOf } from 'xfactura-core/ro/saft/accounts';
import {
  checkD406Assets,
  writeD406Assets,
  type D406AssetCard,
  type D406AssetParty,
  type D406Assets,
  type D406AssetsPresentation,
  type D406AssetTransaction,
} from 'xfactura-core/ro/saft/assets';
import { d406PartyId, type D406Address } from 'xfactura-core/ro/saft/d406';
import { RuleGapError, type RuleContext } from 'xfactura-core/rules';
import type { LocalDate } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import {
  artifactEvents,
  artifacts,
  assetEvents,
  assets,
  companies,
  documents,
  entries,
  fiscalYears,
  ledgerAccounts,
  lines,
  parties,
  partyVersions,
  proposals,
  proposalVersions,
  treasuryAccounts,
} from '../db/schema';
import { loadState } from '../kernel/state';
import { sellerDetails } from './d300';
import type { DeclarationProblem } from './declarations';

/**
 * How each asset that left the register in the year left it: sold, with the sale's invoice
 * (its revenue on 7583 gives the gain or loss), scrapped, or otherwise (Nomenclator
 * imobilizari 20, 50 and 130), by inventory number. The register records the disposal and its
 * document, not which it was.
 */
export const disposalsOption = z
  .record(
    z.string().trim().min(1).max(40),
    z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('sale'), documentId: z.uuid() }).strict(),
      z.object({ kind: z.literal('scrap') }).strict(),
      z.object({ kind: z.literal('other') }).strict(),
    ]),
  )
  .optional();

/** The asset accounts (intangible 20x, tangible 21x) and their depreciation (280x, 281x). */
const assetAccount = /^2[01]/;
const depreciationAccount = /^28[01]/;
/** What the file cannot report yet: revaluation reserves (105), impairment of fixed assets
 * (290x, 291x) and investment subsidies (475x). */
const uncovered: readonly [RegExp, string, string][] = [
  [/^105/, 'D406A_REVALUATION', 'rezerve din reevaluare (105)'],
  [/^29[01]/, 'D406A_IMPAIRMENT', 'ajustări pentru deprecierea imobilizărilor (290x, 291x)'],
  [/^475/, 'D406A_SUBSIDY', 'subvenții pentru investiții (475x)'],
];

const lei = (bani: bigint) => formatScaled(bani, 2);
const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;

/** An e-Factura address as the file writes it (as the periodic file does). */
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

/** The financial year a period ('2026') stands for: the one ending in that year. */
async function financialYear(tx: Transaction, companyId: string, period: string) {
  const [year] = await tx
    .select()
    .from(fiscalYears)
    .where(
      and(
        eq(fiscalYears.companyId, companyId),
        eq(fiscalYears.kind, 'financial'),
        gte(fiscalYears.to, `${period}-01-01`),
        lte(fiscalYears.to, `${period}-12-31`),
      ),
    )
    .orderBy(asc(fiscalYears.to));
  return year;
}

/**
 * Everything the annual file is computed from: the register's cards and disposals, every line
 * on the asset and depreciation accounts up to the year's end with its entry and the treatment
 * that booked it, the suppliers' and the company's details.
 */
async function registerOf(tx: Transaction, companyId: string, period: string) {
  const year = await financialYear(tx, companyId, period);
  const start = year?.from ?? `${period}-01-01`;
  const end = year?.to ?? `${period}-12-31`;
  const cards = await tx
    .select()
    .from(assets)
    .where(eq(assets.companyId, companyId))
    .orderBy(asc(assets.number));
  const disposals = new Map(
    (
      await tx
        .select({ assetId: assetEvents.assetId, date: assetEvents.date })
        .from(assetEvents)
        .where(and(eq(assetEvents.companyId, companyId), eq(assetEvents.kind, 'disposed')))
    ).map((row) => [row.assetId, row.date]),
  );
  const posted = and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId));
  const ledger = await tx
    .select({
      entryId: entries.id,
      number: entries.number,
      seq: entries.seq,
      date: entries.date,
      journal: entries.journalCode,
      account: lines.account,
      side: lines.side,
      bani: lines.bani,
      item: lines.item,
      treatment: proposals.treatmentId,
      subject: proposals.subjectKey,
      document: proposals.documentId,
      input: proposalVersions.input,
    })
    .from(lines)
    .innerJoin(entries, posted)
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
    .where(
      and(
        eq(lines.companyId, companyId),
        lte(entries.date, end),
        or(
          like(lines.account, '2%'),
          like(lines.account, '105%'),
          like(lines.account, '475%'),
          like(lines.account, '7583%'),
        ),
      ),
    )
    .orderBy(asc(entries.seq), asc(lines.lineNo));
  // The ledger up to the year's end: a posting changes the count or the last sequence.
  const [mark] = await tx
    .select({
      count: sql<number>`count(*)`.mapWith(Number),
      last: sql<number>`coalesce(max(${entries.seq}), 0)`.mapWith(Number),
    })
    .from(lines)
    .innerJoin(entries, posted)
    .where(and(eq(lines.companyId, companyId), lte(entries.date, end)));
  const names = new Map(
    (
      await tx
        .select({ code: ledgerAccounts.code, name: ledgerAccounts.name })
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.companyId, companyId), like(ledgerAccounts.code, '2%')))
    ).map((row) => [row.code, row.name]),
  );
  // The purchase documents' partners and the lessors.
  const documentIds = cards.flatMap((card) => card.documentId ?? []);
  const documentRows = documentIds.length
    ? await tx
        .select({ id: documents.id, partyId: documents.partyId, date: documents.docDate })
        .from(documents)
        .where(and(eq(documents.companyId, companyId), inArray(documents.id, documentIds)))
    : [];
  const lessors = new Map(
    ledger.flatMap((row) =>
      row.treatment === 'leases.commence'
        ? [
            [
              row.subject.slice('lease:'.length),
              (JSON.parse(row.input) as { lessorId: string }).lessorId,
            ] as const,
          ]
        : [],
    ),
  );
  const partyIds = [
    ...new Set([...documentRows.flatMap((row) => row.partyId ?? []), ...lessors.values()]),
  ].sort();
  const partyRows = partyIds.length
    ? await tx
        .select()
        .from(parties)
        .where(and(eq(parties.companyId, companyId), inArray(parties.id, partyIds)))
    : [];
  const details = new Map<string, typeof partyVersions.$inferSelect>();
  if (partyIds.length)
    for (const row of await tx
      .select()
      .from(partyVersions)
      .where(and(eq(partyVersions.companyId, companyId), inArray(partyVersions.partyId, partyIds)))
      .orderBy(asc(partyVersions.partyId), desc(partyVersions.version)))
      if (!details.has(row.partyId)) details.set(row.partyId, row);
  const treasury = await tx
    .select()
    .from(treasuryAccounts)
    .where(eq(treasuryAccounts.companyId, companyId))
    .orderBy(asc(treasuryAccounts.openedOn), asc(treasuryAccounts.id));
  const seller = await sellerDetails(tx, companyId);
  const [company] = await tx.select().from(companies).where(eq(companies.id, companyId));
  const state = await loadState(tx, companyId, { profile: true, assets: true });
  const inputs: ReadSetEntry[] = [
    ...state.readSet,
    { kind: 'turnover', id: `ledger|${start}|${end}`, version: `${mark!.count}/${mark!.last}` },
    ...[...details.values()].map((row) => ({
      kind: 'party' as const,
      id: `details:${row.partyId}`,
      version: row.detailsHash,
    })),
    ...(seller ? [{ kind: 'party' as const, id: seller.partyId, version: seller.hash }] : []),
    {
      kind: 'profile',
      id: 'treasury',
      version: hashOf(treasury.map((row) => [row.id, row.kind, row.iban, row.openedOn])),
    },
  ];
  return {
    year,
    start,
    end,
    cards,
    disposals,
    ledger,
    names,
    documents: new Map(documentRows.map((row) => [row.id, row])),
    lessors,
    parties: new Map(partyRows.map((row) => [row.id, row])),
    details,
    treasury,
    seller,
    company,
    loaded: state.loaded,
    inputs,
  };
}

export const assetsInputs = async (tx: Transaction, companyId: string, period: string) =>
  (await registerOf(tx, companyId, period)).inputs;

/**
 * The annual assets file (D406 Active) of the financial year ending in `period`, from the
 * fixed-asset register and the ledger: each asset held in the year with its value at the start
 * and the end, the year's purchase, depreciation and disposal, each a movement with the entry
 * that booked it. The register must agree with every asset and depreciation account.
 */
export async function prepareAssets(
  tx: Transaction,
  companyId: string,
  period: string,
  options: {
    contact?: { firstName: string; lastName: string; phone: string; email?: string };
    disposals?: z.infer<typeof disposalsOption>;
  },
  rules: RuleContext,
  created: string,
) {
  const books = await registerOf(tx, companyId, period);
  const { start, end, loaded, inputs } = books;
  const problems: DeclarationProblem[] = [];
  const problem = (code: string, message: string) => {
    if (!problems.some((item) => item.code === code && item.message === message))
      problems.push({ code, message });
  };
  if (!books.year)
    problem('D406_YEAR', `Exercițiul financiar care se încheie în ${period} nu este înregistrat.`);
  else if (monthIndex(end) - monthIndex(start) !== 11)
    problem(
      'D406A_YEAR',
      `Exercițiul financiar ${start} – ${end} nu are 12 luni: validatorul ANAF primește declarația D406 pentru active doar pentru 12 luni, iar raportarea unui exercițiu mai scurt nu este stabilită.`,
    );
  const status = profileAt(loaded, 'vat.status', end as LocalDate);
  const vatRegime =
    status === 'normal_vat'
      ? profileAt(loaded, 'vat.cash', end as LocalDate) === 'yes'
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
  if (!books.seller)
    problem('SELLER_DETAILS', 'Înregistrați datele de identificare ale companiei.');
  if (!options.contact)
    problem(
      'D406_CONTACT',
      'Completați persoana de contact pentru ANAF: prenumele, numele și telefonul.',
    );
  let presentation: D406AssetsPresentation | undefined;
  try {
    presentation = rules.param<D406AssetsPresentation>(
      'ro.d406.assets.presentation',
      'reporting_period_start',
      start as LocalDate,
    );
  } catch (error) {
    if (!(error instanceof RuleGapError)) throw error;
    problem('RULE_GAP', error.message);
  }

  // The ledger: what the year opens with (before it, or the opening entry of its first day),
  // what it closes with, and what the file cannot report.
  const opening = (row: (typeof books.ledger)[number]) =>
    row.date < start || (row.journal === 'DESCHIDERE' && row.date === start);
  const signed = (row: (typeof books.ledger)[number]) => (row.side === 'D' ? row.bani : -row.bani);
  const balances = new Map<string, { opening: bigint; closing: bigint; moved: boolean }>();
  for (const row of books.ledger) {
    const total = balances.get(row.account) ?? { opening: 0n, closing: 0n, moved: false };
    if (opening(row)) total.opening += signed(row);
    else total.moved = true;
    total.closing += signed(row);
    balances.set(row.account, total);
  }
  for (const [code, total] of balances)
    for (const [pattern, issue, label] of uncovered)
      if (pattern.test(code) && (total.opening !== 0n || total.closing !== 0n || total.moved))
        problem(
          issue,
          `Contul ${code} are ${label} în exercițiu: fișierul D406 pentru active nu le raportează încă.`,
        );

  // The company, as the movements other than purchases name it.
  const self = books.seller ? (JSON.parse(books.seller.details) as Party) : undefined;
  const own: D406AssetParty | undefined =
    self && books.company
      ? {
          id: d406PartyId({ kind: 'ro', cui: books.company.cui }),
          name: self.name.slice(0, 70),
          address: addressOf(self.address),
        }
      : undefined;
  /** A supplier by its CUI or EU VAT code and recorded address; undefined when either is
   * missing (AssetSupplier is optional). */
  const supplierOf = (partyId: string | null | undefined): D406AssetParty | undefined => {
    const party = partyId ? books.parties.get(partyId) : undefined;
    const row = partyId ? books.details.get(partyId) : undefined;
    if (!party || !row) return undefined;
    const taxId = (party.taxId ?? '').toUpperCase().replace(/\s+/g, '').replace(/^RO/, '');
    const prefix = euVatPrefixes[party.country];
    const id =
      party.country === 'RO' && party.kind !== 'ro_individual' && isValidCui(taxId)
        ? d406PartyId({ kind: 'ro', cui: taxId })
        : prefix && party.country !== 'RO' && (party.taxId ?? '').toUpperCase().startsWith(prefix)
          ? d406PartyId({
              kind: 'eu',
              country: prefix,
              vat: (party.taxId ?? '').toUpperCase().slice(prefix.length),
            })
          : undefined;
    if (!id) return undefined;
    return {
      id,
      name: party.name.slice(0, 70),
      address: addressOf((JSON.parse(row.details) as Party).address),
    };
  };

  // Each card's lines: what entered it (a purchase's invoice, a lease's start), its
  // depreciation, and the entry that took it off the books.
  const purchases = new Map<string, (typeof books.ledger)[number]>();
  for (const row of books.ledger) {
    const input = JSON.parse(row.input) as { documentId?: string };
    if (
      (row.treatment === 'invoices.recognize' || row.treatment === 'invoices.crossBorder') &&
      input.documentId &&
      !purchases.has(input.documentId) &&
      assetAccount.test(row.account) &&
      row.side === 'D'
    )
      purchases.set(input.documentId, row);
  }
  const cards: D406AssetCard[] = [];
  const movements: D406AssetTransaction[] = [];
  const held = new Set<string>();
  const saleDocuments = new Map<string, string>();
  for (const card of books.cards) {
    const lease = books.ledger.find(
      (row) => row.treatment === 'leases.commence' && row.subject === `lease:${card.id}`,
    );
    const purchase = card.documentId ? purchases.get(card.documentId) : undefined;
    const entered = lease ?? purchase;
    const acquired = entered?.date ?? card.commissionedOn;
    const removal = books.ledger.find(
      (row) =>
        row.treatment === 'assets.derecognize' && row.subject === `asset-disposal:${card.id}`,
    );
    if (acquired > end || (removal && removal.date < start)) continue;
    held.add(card.account);
    held.add(card.depreciationAccount);
    const disposedOn = books.disposals.get(card.id);
    if (disposedOn && disposedOn <= end && !removal)
      problem(
        'D406A_DISPOSAL',
        `Mijlocul fix ${card.number} a fost scos din funcțiune la ${disposedOn}, dar nu și din evidență (assets.derecognize).`,
      );
    if (!entered && acquired >= start)
      problem(
        'D406A_ACQUISITION',
        `Mijlocul fix ${card.number} intră în exercițiu fără nota contabilă a achiziției (factura din registru sau începutul leasingului).`,
      );
    // The depreciation booked on the card's account, as the item it carries.
    const depreciation = books.ledger.filter(
      (row) =>
        row.item === card.id &&
        row.account === card.depreciationAccount &&
        row.entryId !== removal?.entryId,
    );
    const before = depreciation
      .filter(opening)
      .reduce((sum, row) => sum + (row.side === 'C' ? row.bani : -row.bani), 0n);
    const byEntry = new Map<string, { row: (typeof depreciation)[number]; bani: bigint }>();
    for (const row of depreciation.filter((item) => !opening(item))) {
      const total = byEntry.get(row.entryId) ?? { row, bani: 0n };
      total.bani += row.side === 'C' ? row.bani : -row.bani;
      byEntry.set(row.entryId, total);
    }
    const removed = removal
      ? books.ledger
          .filter(
            (row) =>
              row.entryId === removal.entryId &&
              row.item === card.id &&
              row.account === card.depreciationAccount,
          )
          .reduce((sum, row) => sum + (row.side === 'D' ? row.bani : -row.bani), 0n)
      : 0n;
    const inYear = acquired >= start;
    const year = [...byEntry.values()].reduce((sum, item) => sum + item.bani, 0n);
    cards.push({
      id: card.number,
      account: card.account,
      depreciationAccount: card.depreciationAccount,
      description: card.name.slice(0, 256),
      ...(() => {
        const supplier = supplierOf(
          lease ? books.lessors.get(card.id) : books.documents.get(card.documentId ?? '')?.partyId,
        );
        return supplier ? { supplier } : {};
      })(),
      acquired,
      commissioned: card.commissionedOn,
      catalogCode: card.catalogCode,
      lifeMonths: card.lifeMonths,
      costBegin: lei(inYear ? 0n : card.valueBani),
      depreciationBegin: lei(before),
      addition: lei(inYear ? card.valueBani : 0n),
      disposal: lei(removal ? card.valueBani : 0n),
      depreciation: lei(year),
      depreciationRemoved: lei(removed),
    });
    if (inYear && entered) {
      const supplier = supplierOf(
        lease ? books.lessors.get(card.id) : books.documents.get(card.documentId ?? '')?.partyId,
      );
      movements.push({
        id: `10-${card.number}-${entered.number}`,
        asset: card.number,
        type: '10',
        description: lease ? 'Intrare prin leasing financiar' : 'Achiziție',
        date: entered.date,
        ...(supplier ? { supplier } : {}),
        transaction: String(entered.number),
        cost: lei(card.valueBani),
        bookValue: lei(card.valueBani),
        amount: lei(card.valueBani),
      });
    }
    for (const { row, bani } of byEntry.values())
      movements.push({
        id: `30-${card.number}-${row.number}`,
        asset: card.number,
        type: '30',
        description: 'Amortizare',
        date: row.date,
        ...(own ? { supplier: own } : {}),
        transaction: String(row.number),
        cost: '0.00',
        bookValue: lei(-bani),
        amount: lei(-bani),
      });
    if (removal) {
      const net = card.valueBani - removed;
      const how = options.disposals?.[card.number];
      if (!how) {
        problem(
          'D406A_DISPOSAL_KIND',
          `Indicați cum a ieșit mijlocul fix ${card.number} la ${removal.date}: vândut, cu factura de vânzare, casat sau altfel (disposals).`,
        );
        continue;
      }
      let amount = -net;
      if (how.kind === 'sale') {
        if (saleDocuments.has(how.documentId))
          problem(
            'D406A_SALE',
            `Factura de vânzare a mijlocului fix ${card.number} vinde și ${saleDocuments.get(how.documentId)}: câștigul fiecăruia nu se poate stabili.`,
          );
        saleDocuments.set(how.documentId, card.number);
        // The revenue on 7583 of the entries that booked the sale's invoice.
        const sold = books.ledger.filter(
          (row) =>
            ((JSON.parse(row.input) as { documentId?: string }).documentId ?? row.document) ===
              how.documentId && /^7583/.test(row.account),
        );
        if (!sold.length) {
          problem(
            'D406A_SALE',
            `Factura de vânzare indicată pentru ${card.number} nu are venituri din vânzarea activelor (7583) în registre.`,
          );
          continue;
        }
        amount =
          sold.reduce((sum, row) => sum + (row.side === 'C' ? row.bani : -row.bani), 0n) - net;
      }
      movements.push({
        id: `${how.kind === 'sale' ? '20' : how.kind === 'scrap' ? '50' : '130'}-${card.number}-${removal.number}`,
        asset: card.number,
        type: how.kind === 'sale' ? '20' : how.kind === 'scrap' ? '50' : '130',
        description:
          how.kind === 'sale'
            ? 'Vânzare'
            : how.kind === 'scrap'
              ? 'Casare'
              : 'Scoatere din evidență',
        date: removal.date,
        ...(own ? { supplier: own } : {}),
        transaction: String(removal.number),
        cost: '0.00',
        bookValue: lei(-net),
        amount: lei(amount),
      });
    }
  }
  for (const number of Object.keys(options.disposals ?? {}))
    if (!books.cards.some((card) => card.number === number))
      problem('D406A_DISPOSAL_KIND', `Mijlocul fix ${number} nu este în registru.`);

  // The accounts: the cards' and every asset or depreciation account the ledger moves, so that
  // an asset missing from the register shows on its account.
  const codes = [
    ...new Set([
      ...held,
      ...[...balances]
        .filter(
          ([code, total]) =>
            (assetAccount.test(code) || depreciationAccount.test(code)) &&
            (total.opening !== 0n || total.closing !== 0n || total.moved),
        )
        .map(([code]) => code),
    ]),
  ].sort();
  for (const code of codes)
    if (d406AmbiguousAccounts[syntheticOf(code)])
      problem('D406_ACCOUNT_CHOICE', `Contul ${code} corespunde mai multor conturi standard ANAF.`);
  const accounts = codes.map((code) => ({
    code,
    description: (books.names.get(code) ?? code).slice(0, 256),
    opening: lei(balances.get(code)?.opening ?? 0n),
    closing: lei(balances.get(code)?.closing ?? 0n),
  }));
  if (!cards.length)
    problem(
      'D406A_EMPTY',
      `Registrul nu are mijloace fixe deținute în exercițiul ${period}: declarația D406 pentru active nu se depune.`,
    );

  if (problems.length || !presentation || !vatRegime || !options.contact || !books.seller)
    return { xml: '', inputs, problems, summary: null };
  const model: D406Assets = {
    year: { start, end },
    created,
    software: { company: 'xFactura', name: 'xFactura', version: '0.0.1' },
    company: {
      cui: books.company!.cui,
      name: self!.name,
      address: addressOf(self!.address),
      contact: options.contact,
      ibans: books.treasury
        .filter((row) => row.kind === 'bank' && row.iban && row.openedOn <= end)
        .map((row) => row.iban!),
      vatRegime,
    },
    presentation,
    accounts,
    assets: cards,
    transactions: movements.sort(
      (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
    ),
  };
  for (const check of checkD406Assets(model))
    if (check.severity === 'error') problem(check.code, check.message);
  if (problems.length) return { xml: '', inputs, problems, summary: null };
  return {
    xml: writeD406Assets(model),
    inputs,
    problems,
    summary: {
      period,
      type: 'A',
      year: { start, end },
      assets: cards.length,
      transactions: movements.length,
      accounts: accounts.length,
    },
  };
}

/**
 * ANAF takes the annual file after every periodic D406 of the financial year (Clarificare D406
 * Active, 14.11.2022): a periodic return the engine prepared for the year and not yet filed
 * blocks authorizing it. Returns filed outside the engine are not seen.
 */
export async function assetsAuthorization(
  tx: Transaction,
  companyId: string,
  period: string,
): Promise<DeclarationProblem[]> {
  const rows = await tx
    .select({ id: artifacts.id, period: artifacts.period })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.companyId, companyId),
        eq(artifacts.kind, 'D406'),
        like(artifacts.period, `${period}-%`),
      ),
    )
    .orderBy(asc(artifacts.createdAt));
  const waiting = new Set<string>();
  const filed = new Set<string>();
  for (const row of rows) {
    const states = (
      await tx
        .select({ state: artifactEvents.state })
        .from(artifactEvents)
        .where(and(eq(artifactEvents.companyId, companyId), eq(artifactEvents.artifactId, row.id)))
        .orderBy(asc(artifactEvents.seq))
    ).map((step) => step.state);
    if (states.includes('superseded')) continue;
    if (['submitted', 'accepted'].includes(states.at(-1) ?? '')) filed.add(row.period);
    else waiting.add(row.period);
  }
  const pending = [...waiting].filter((item) => !filed.has(item)).sort();
  return pending.length
    ? [
        {
          code: 'D406A_PERIODIC',
          message: `Depuneți întâi D406 pentru ${pending.join(', ')}: declarația pentru active se depune după toate declarațiile lunare sau trimestriale ale exercițiului.`,
        },
      ]
    : [];
}
