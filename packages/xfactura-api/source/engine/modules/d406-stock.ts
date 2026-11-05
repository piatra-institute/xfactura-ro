import { and, asc, eq, lte, sql } from 'drizzle-orm';
import type { Party } from 'xfactura-core/einvoice';
import { profileAt, type ReadSetEntry } from 'xfactura-core/kernel';
import { isValidCui } from 'xfactura-core/ro/identifiers';
import { prorate } from 'xfactura-core/ro/stock';
import { d406PartyId, type D406Address } from 'xfactura-core/ro/saft/d406';
import {
  checkD406Stock,
  writeD406Stock,
  type D406PhysicalStock,
  type D406Stock,
  type D406StockMovement,
} from 'xfactura-core/ro/saft/stock';
import type { LocalDate } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import {
  companies,
  documents,
  entries,
  ledgerAccounts,
  lines,
  parties,
  proposals,
  stockItems,
  stockLayers,
  stockMoves,
  treasuryAccounts,
  warehouses,
} from '../db/schema';
import { loadState } from '../kernel/state';
import { sellerDetails } from './d300';
import type { DeclarationProblem } from './declarations';
import { stockAccounts } from './stock';

/*
 * D406's on-demand stock file (C) for the month or quarter ANAF asks for (OPANAF nr. 1.783/2021
 * anexa nr. 4 pct. 9–10), from the stock register: each position's lot or pool with its opening
 * and closing quantity and value, and every move of the period on its entry, as a movement of the
 * nomenclator's type. The register must explain the stock accounts (STOCK_LEDGER_DIFFERS
 * otherwise), or the file would report another stock than the books.
 */

/** A request's period as the D406 kind names it: the month or quarter with `-C`. */
export const stockPeriod = (period: string) => /^\d{4}-(0[1-9]|1[0-2]|Q[1-4])-C$/.test(period);

function rangeOf(period: string) {
  const base = period.slice(0, -2);
  const year = Number(base.slice(0, 4));
  const [first, last] = base.includes('Q')
    ? [(Number(base.slice(6)) - 1) * 3 + 1, (Number(base.slice(6)) - 1) * 3 + 3]
    : [Number(base.slice(5, 7)), Number(base.slice(5, 7))];
  const start = `${year}-${String(first).padStart(2, '0')}-01`;
  const end = new Date(Date.UTC(year, last, 0)).toISOString().slice(0, 10);
  return { start, end };
}

/** What the file is computed from: every move of the register up to the period's end, with the
 * entry that posted it, the catalogue, the warehouses and the company. */
export async function stockInputs(tx: Transaction, companyId: string, period: string) {
  const { end } = rangeOf(period);
  const [mark] = await tx
    .select({
      count: sql<number>`count(*)`.mapWith(Number),
      last: sql<number>`coalesce(max(${entries.seq}), 0)`.mapWith(Number),
    })
    .from(stockMoves)
    .innerJoin(
      entries,
      and(eq(entries.companyId, stockMoves.companyId), eq(entries.id, stockMoves.entryId)),
    )
    .where(and(eq(stockMoves.companyId, companyId), lte(entries.date, end)));
  const [catalogue] = await tx
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(stockItems)
    .where(eq(stockItems.companyId, companyId));
  const seller = await sellerDetails(tx, companyId);
  const { readSet } = await loadState(tx, companyId, { profile: true });
  const inputs: ReadSetEntry[] = [
    {
      kind: 'stock',
      id: `register|${end}`,
      version: `${mark!.count}/${mark!.last}/${catalogue!.count}`,
    },
    ...(seller ? [{ kind: 'party' as const, id: seller.partyId, version: seller.hash }] : []),
    ...readSet,
  ];
  return inputs;
}

const productType = (account: string) =>
  account.startsWith('371')
    ? 'Marfuri'
    : account.startsWith('381')
      ? 'Ambalaje'
      : account.startsWith('301')
        ? 'Materii prime'
        : account.startsWith('303')
          ? 'Obiecte inventar'
          : 'Materiale';

/** The nomenclator's movement type of a move, by the treatment that posted it. */
function movementType(treatment: string, direction: 'in' | 'out' | 'value', subject: string) {
  switch (treatment) {
    case 'invoices.recognize':
    case 'stock.receive':
      return direction === 'out' ? '30' : '10';
    case 'invoices.credit':
      return direction === 'in' ? '40' : direction === 'value' ? '60' : '50';
    case 'stock.consume':
      return '70';
    case 'stock.transfer':
      return '80';
    case 'inventory.stock':
      return direction === 'in' ? '110' : '120';
    case 'stock.periodCost':
      return direction === 'value' ? '101' : '180';
    default:
      void subject;
      return '180';
  }
}

export async function prepareStock(
  tx: Transaction,
  companyId: string,
  period: string,
  options: { contact?: { firstName: string; lastName: string; phone: string; email?: string } },
  created: string,
) {
  const { start, end } = rangeOf(period);
  const inputs = await stockInputs(tx, companyId, period);
  const problems: DeclarationProblem[] = [];
  const problem = (code: string, message: string) => {
    if (!problems.some((item) => item.code === code && item.message === message))
      problems.push({ code, message });
  };
  const { loaded } = await loadState(tx, companyId, { profile: true });
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
      'Regimul fiscal al companiei pentru fișierul D406 nu rezultă din registre (vat.status).',
    );
  const seller = await sellerDetails(tx, companyId);
  if (!seller) problem('SELLER_DETAILS', 'Înregistrați datele de identificare ale companiei.');
  if (!options.contact)
    problem(
      'D406_CONTACT',
      'Completați persoana de contact pentru ANAF: prenumele, numele și telefonul.',
    );
  const [company] = await tx.select().from(companies).where(eq(companies.id, companyId));
  const accounts = await stockAccounts(tx, companyId, end);
  for (const row of accounts)
    if (row.outside !== 0n)
      problem(
        'STOCK_LEDGER_DIFFERS',
        `Contul ${row.account} ține ${row.outside} bani în afara gestiunii la ${end}: fișierul stocurilor ar raporta alt stoc decât contabilitatea; preluați soldul în gestiune (stock.opening).`,
      );
  const items = new Map(
    (await tx.select().from(stockItems).where(eq(stockItems.companyId, companyId))).map((row) => [
      row.id,
      row,
    ]),
  );
  if (!items.size)
    problem(
      'D406S_EMPTY',
      'Compania nu ține gestiunea stocurilor: nu are articole în nomenclator.',
    );
  const stores = new Map(
    (await tx.select().from(warehouses).where(eq(warehouses.companyId, companyId))).map((row) => [
      row.id,
      row,
    ]),
  );
  const layers = new Map(
    (await tx.select().from(stockLayers).where(eq(stockLayers.companyId, companyId))).map((row) => [
      row.id,
      row,
    ]),
  );
  const moves = await tx
    .select({
      move: stockMoves,
      date: entries.date,
      number: entries.number,
      journal: entries.journalCode,
      treatment: proposals.treatmentId,
      subject: proposals.subjectKey,
      documentId: proposals.documentId,
    })
    .from(stockMoves)
    .innerJoin(
      entries,
      and(eq(entries.companyId, stockMoves.companyId), eq(entries.id, stockMoves.entryId)),
    )
    .innerJoin(
      proposals,
      and(eq(proposals.companyId, entries.companyId), eq(proposals.id, entries.proposalId)),
    )
    .where(and(eq(stockMoves.companyId, companyId), lte(entries.date, end)))
    .orderBy(asc(entries.date), asc(entries.seq), asc(stockMoves.moveNo));

  // The physical stock: each lot (FIFO, LIFO) or pool, opening before the period, closing at its end.
  const held = new Map<
    string,
    {
      layer: string;
      opening: { quantity: bigint; bani: bigint };
      closing: { quantity: bigint; bani: bigint };
      moved: boolean;
    }
  >();
  for (const { move, date } of moves) {
    const row = held.get(move.layerId) ?? {
      layer: move.layerId,
      opening: { quantity: 0n, bani: 0n },
      closing: { quantity: 0n, bani: 0n },
      moved: false,
    };
    if (date < start) {
      row.opening.quantity += move.quantity;
      row.opening.bani += move.bani;
    } else row.moved = true;
    row.closing.quantity += move.quantity;
    row.closing.bani += move.bani;
    held.set(move.layerId, row);
  }
  const ownerId = d406PartyId({ kind: 'ro', cui: company!.cui });
  const physical: D406PhysicalStock[] = [];
  for (const row of [...held.values()]) {
    if (!row.moved && row.opening.quantity === 0n && row.closing.quantity === 0n) continue;
    const layer = layers.get(row.layer)!;
    const item = items.get(layer.itemId)!;
    const lot = layer.method === 'fifo' || layer.method === 'lifo';
    const basis = row.closing.quantity !== 0n ? row.closing : row.opening;
    physical.push({
      warehouse: stores.get(layer.warehouseId)?.code ?? layer.warehouseId,
      product: item.code,
      ...(lot ? { lot: layer.id.slice(0, 18) } : {}),
      type: productType(item.account),
      commodityCode: item.nc8 ?? '0',
      owner: ownerId,
      unit: item.unit,
      unitPrice: basis.quantity === 0n ? 0n : prorate(basis.bani, 1000n, basis.quantity),
      opening: row.opening,
      closing: row.closing,
    });
  }
  physical.sort((a, b) =>
    `${a.warehouse}|${a.product}|${a.lot ?? ''}`.localeCompare(
      `${b.warehouse}|${b.product}|${b.lot ?? ''}`,
    ),
  );

  // The period's movements, one per entry, each move a line.
  const partyIds = new Map<string, string>();
  const partner = async (entryId: string) => {
    if (partyIds.has(entryId)) return partyIds.get(entryId)!;
    const [row] = await tx
      .select({ taxId: parties.taxId, country: parties.country })
      .from(lines)
      .innerJoin(
        parties,
        and(eq(parties.companyId, lines.companyId), eq(parties.id, lines.partyId)),
      )
      .where(and(eq(lines.companyId, companyId), eq(lines.entryId, entryId)))
      .limit(1);
    const cui = row?.taxId?.replace(/^RO/i, '').trim();
    const id =
      row && row.country === 'RO' && cui && isValidCui(cui) ? d406PartyId({ kind: 'ro', cui }) : '';
    partyIds.set(entryId, id);
    return id;
  };
  const byEntry = new Map<string, D406StockMovement>();
  const documentNumbers = new Map<string, string | null>();
  for (const { move, date, number, journal, treatment, subject, documentId } of moves) {
    if (date < start) continue;
    const direction = move.quantity > 0n ? 'in' : move.quantity < 0n ? 'out' : 'value';
    const type = movementType(treatment, direction, subject);
    let movement = byEntry.get(move.entryId);
    if (!movement) {
      if (documentId && !documentNumbers.has(documentId)) {
        const [document] = await tx
          .select({ number: documents.number })
          .from(documents)
          .where(and(eq(documents.companyId, companyId), eq(documents.id, documentId)));
        documentNumbers.set(documentId, document?.number ?? null);
      }
      const documentNumber = documentId ? documentNumbers.get(documentId) : null;
      movement = {
        reference: `${journal}-${number}`.slice(0, 35),
        date,
        type,
        ...(documentNumber
          ? {
              document: {
                type: treatment === 'invoices.credit' ? 'Nota credit' : 'Factura',
                number: documentNumber.slice(0, 35),
              },
            }
          : {}),
        lines: [],
      };
      byEntry.set(move.entryId, movement);
    }
    const item = items.get(move.itemId)!;
    const layer = layers.get(move.layerId)!;
    const external = ['10', '30', '40', '50', '60'].includes(type);
    const other = external ? await partner(move.entryId) : '';
    if (external && !other)
      problem(
        'D406S_PARTY',
        `Partenerul mișcării ${movement.reference} nu are un CUI românesc valid: codul lui în fișier (D406) nu este acoperit.`,
      );
    // The partner a sale or a customer's return names is the customer, a purchase's or a return
    // to the supplier the supplier, the other side 0; any other move names the company on both
    // (ANAF's answers on SD.MG.21–22).
    const toCustomer = type === '30' || type === '40';
    movement.lines.push({
      account: move.account,
      customer: external ? (toCustomer ? other : '0') : ownerId,
      supplier: external ? (toCustomer ? '0' : other) : ownerId,
      product: item.code,
      ...(layer.method === 'fifo' || layer.method === 'lifo' ? { lot: layer.id.slice(0, 18) } : {}),
      quantity: move.quantity,
      unit: item.unit,
      bookValue: move.bani,
      subType: type,
    });
  }
  const accountRows = await tx
    .select({ code: ledgerAccounts.code, name: ledgerAccounts.name })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.companyId, companyId));
  const names = new Map(accountRows.map((row) => [row.code, row.name]));
  const opening = await stockAccounts(
    tx,
    companyId,
    new Date(Date.parse(`${start}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10),
  );
  const stockAccountCodes = [...new Set(moves.map((row) => row.move.account))].sort();
  if (problems.length || !vatRegime || !seller || !options.contact)
    return { xml: '', inputs, problems, summary: null };
  const self = JSON.parse(seller.details) as Party;
  const treasury = await tx
    .select()
    .from(treasuryAccounts)
    .where(eq(treasuryAccounts.companyId, companyId));
  const address: D406Address = {
    street: self.address.lines[0],
    ...(self.address.lines.length > 1 ? { details: self.address.lines.slice(1).join(', ') } : {}),
    city: self.address.city,
    ...(self.address.postalCode ? { postalCode: self.address.postalCode } : {}),
    ...(self.address.country === 'RO' && self.address.subdivision
      ? { county: self.address.subdivision }
      : {}),
    country: self.address.country,
  };
  const model: D406Stock = {
    period: { start, end },
    created,
    software: { company: 'xFactura', name: 'xFactura', version: '0.0.1' },
    company: {
      cui: company!.cui,
      name: self.name,
      address,
      contact: options.contact,
      ibans: treasury
        .filter((row) => row.kind === 'bank' && row.iban && row.openedOn <= end)
        .map((row) => row.iban!),
      vatRegime,
    },
    owner: { id: ownerId, account: stockAccountCodes[0] ?? '371' },
    accounts: stockAccountCodes.map((code) => ({
      code,
      description: names.get(code) ?? code,
      opening: opening.find((row) => row.account === code)?.ledger ?? 0n,
      closing: accounts.find((row) => row.account === code)?.ledger ?? 0n,
    })),
    products: [...new Set(physical.map((row) => row.product))].map((code) => {
      const item = [...items.values()].find((candidate) => candidate.code === code)!;
      const method = [...layers.values()].find((layer) => layer.itemId === item.id)?.method;
      return {
        code,
        description: item.name,
        commodityCode: item.nc8 ?? '0',
        valuation:
          method === 'fifo'
            ? ('FIFO' as const)
            : method === 'lifo'
              ? ('LIFO' as const)
              : ('Cost mediu' as const),
        unit: item.unit,
      };
    }),
    stock: physical,
    movements: [...byEntry.values()],
  };
  for (const check of checkD406Stock(model)) problem(check.code, check.message);
  if (problems.length) return { xml: '', inputs, problems, summary: null };
  return {
    xml: writeD406Stock(model),
    inputs,
    problems,
    summary: {
      period,
      type: 'C',
      range: { start, end },
      products: model.products.length,
      positions: physical.length,
      movements: model.movements.length,
    },
  };
}
