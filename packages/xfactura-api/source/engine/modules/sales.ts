import { and, asc, desc, eq, inArray, max } from 'drizzle-orm';
import { z } from 'zod';
import { DomainError, requireCondition } from 'xfactura-core/errors';
import { canonical, hashOf } from 'xfactura-core/hash';
import {
  calculateInvoice,
  checkInvoice,
  invoiceFieldsSchema,
  partySchema,
  typeCodes,
  writeInvoice,
  type Invoice,
  type Party,
} from 'xfactura-core/einvoice';
import { documentIdentity, normalizedTaxId } from 'xfactura-core/documents/schemas';
import { accountCodePattern, profileAt } from 'xfactura-core/kernel';
import { cashVatMention, mentionsCashVat } from 'xfactura-core/ro/cash-vat';
import { invoiceKinds, taxPointOf } from 'xfactura-core/ro/treatments/invoices';
import { exemptionBases, exemptionBasisIds, isExemptCategory } from 'xfactura-core/ro/exempt';
import { marginIssue, marginIssueProblems, marginRecognition } from './schemes';
import {
  cerealCodes,
  reverseChargeApplies,
  reverseChargeCategoryIds,
  type ReverseChargeRule,
} from 'xfactura-core/ro/receipts';
import { b2cInvoice, zReportKind, type B2cRule } from 'xfactura-core/ro/retail';
import { RuleGapError } from 'xfactura-core/rules';
import type { LocalDate } from 'xfactura-core/time';
import { parseInvoiceXml } from 'xfactura-core/ubl/invoice-document';
import type { Transaction } from '../db/database';
import {
  companies,
  documentLinks,
  documents,
  evidence,
  issuedNumbers,
  parties,
  partyCnps,
  partyVersions,
  series,
  stockItems,
  warehouses,
} from '../db/schema';
import { sha256, type ObjectStore } from '../adapters/object-store';
import type { Actor, Commands } from '../kernel/commands';
import { maskCnps } from '../kernel/personal';
import type { Proposals } from '../kernel/proposals';
import { joinIdentityGroup } from '../kernel/sources';
import { loadState } from '../kernel/state';
import { maskedTaxId } from './company';
import type { Sealer } from './payroll';

export const sellerInput = z.object({ details: partySchema }).strict();
export const partyDetailsInput = z.object({ partyId: z.uuid(), details: partySchema }).strict();
export const seriesInput = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{1,20}$/),
    prefix: z
      .string()
      .regex(/^[A-Za-z0-9/-]{0,20}$/)
      .default(''),
    width: z.number().int().min(1).max(12).default(4),
    firstNumber: z.number().int().min(1).default(1),
    typeCodes: z.array(z.enum(typeCodes)).min(1).max(2).default(['380', '381']),
    revenueAccount: z.string().regex(accountCodePattern),
  })
  .strict();
export const issueInput = invoiceFieldsSchema
  .pick({
    issueDate: true,
    dueDate: true,
    taxPointDate: true,
    taxPointCode: true,
    vatAccountingTotal: true,
    notes: true,
    buyerReference: true,
    contractReference: true,
    orderReference: true,
    invoicingPeriod: true,
    deliveryDate: true,
    payment: true,
    adjustments: true,
    lines: true,
    prepaid: true,
  })
  .extend({
    seriesId: z.uuid(),
    buyerId: z.uuid(),
    typeCode: z.enum(typeCodes).default('380'),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .default('RON'),
    /** The invoices a credit note or storno corrects (BG-3). */
    precedingDocumentIds: z.array(z.uuid()).max(50).default([]),
    /** The revenue account to recognize on, instead of the series default. */
    revenueAccount: z.string().regex(accountCodePattern).optional(),
    /** Why lines at the reduced rate qualify for it: the supply of Codul fiscal art. 291 alin. (2)
     * they are, kept with the issue. */
    reducedRateBasis: z.string().trim().min(10).max(300).optional(),
    /** The buyer is affiliated with the company (Codul fiscal art. 7 pct. 26): a company applying
     * VAT on collection invoices it under the general rules (art. 282 alin. (6) lit. d)). */
    affiliated: z.boolean().optional(),
    /** The legal basis of the lines invoiced as exempt (E, K, G): art. 292 without the right of
     * deduction, art. 294–296 or 297 alin. (4) lit. d) with it. Each exempt category states its
     * reason on the invoice (BT-120, or the VATEX code BT-121); the recognition books by it. */
    exemption: z.enum(exemptionBasisIds).optional(),
    /** A supply under the domestic reverse charge (art. 331), its lines in category AE without
     * VAT: the category of art. 331 alin. (2) it is (the NC code for cereals). It is recognized
     * with `invoices.reverseCharge`. */
    reverseCharge: z
      .object({
        category: z.enum(reverseChargeCategoryIds),
        nc: z.enum(cerealCodes).optional(),
      })
      .strict()
      .optional(),
    /** A sale under a margin scheme (art. 311, 312), its lines in category E without VAT and with
     * the scheme's mention: recognized with `margin.sale` (V4). */
    margin: marginIssue.optional(),
    /** An invoice to an individual (B2C, G2; OUG nr. 120/2021 art. 10^1 alin. (3)): how the person
     * identified to the company, by the CNP recorded for them (parties.recordCnp, sealed) or by no
     * code at all, written as 13 zeros (`ro.efactura.b2c`). */
    b2c: z
      .object({ identification: z.enum(['cnp', 'none']) })
      .strict()
      .optional(),
    /** An invoice issued at the buyer's request for fiscal receipts (Codul fiscal art. 319 alin.
     * (10) lit. a)): the Z report whose day holds them and their numbers. The invoice says
     * «conform bon fiscal» (norme pct. 97 alin. (1)) and is recognized with
     * `retail.receiptInvoice`: one sale with its Z report, which booked its revenue and VAT. */
    receipt: z
      .object({
        zReportId: z.uuid(),
        receipts: z.array(z.string().trim().min(1).max(40)).min(1).max(50),
      })
      .strict()
      .optional(),
    /** Goods the invoice sells out of a warehouse (the stock register, G1): each line, by its
     * position from 0, with the catalogue's item, whose unit the line uses. Its recognition
     * discharges them at the policy's value (607). */
    stock: z
      .object({
        warehouseId: z.uuid(),
        lines: z
          .array(z.object({ index: z.number().int().min(0).max(999), itemId: z.uuid() }).strict())
          .min(1)
          .max(1000),
      })
      .strict()
      .optional(),
  })
  .strict();
export type IssueInput = z.infer<typeof issueInput>;

/** A line's quantity as the stock register writes it: without trailing zeros. */
const canonicalQuantity = (quantity: string) =>
  quantity.includes('.') ? quantity.replace(/0+$/, '').replace(/\.$/, '') : quantity;

/** The recognition's stock: each issued line (its id is its position from 1) with its item. */
const stockOf = (input: IssueInput) =>
  input.stock
    ? {
        stock: {
          warehouseId: input.stock.warehouseId,
          lines: input.stock.lines.map((row) => ({
            line: String(row.index + 1),
            itemId: row.itemId,
            quantity: canonicalQuantity(input.lines[row.index]!.quantity),
          })),
        },
      }
    : {};

export const seriesView = z.object({
  id: z.string(),
  code: z.string(),
  prefix: z.string(),
  width: z.number(),
  firstNumber: z.number(),
  typeCodes: z.array(z.string()),
  revenueAccount: z.string(),
  nextNumber: z.string(),
});
export const issueView = z.object({
  documentId: z.string(),
  number: z.string(),
  evidenceId: z.string(),
  totals: z.object({ taxExclusive: z.string(), tax: z.string(), payable: z.string() }),
  recognition: z.object({ proposalId: z.string().nullable(), error: z.string().nullable() }),
});
export const previewView = z.object({
  number: z.string(),
  invoice: z.unknown(),
  problems: z.array(z.object({ code: z.string(), message: z.string() })),
  xml: z.string().nullable(),
});

type Problem = { code: string; message: string };
const issuedKinds = [invoiceKinds.sale, invoiceKinds.saleCredit];
const formatNumber = (row: typeof series.$inferSelect, value: number) =>
  `${row.prefix}${String(value).padStart(row.width, '0')}`;
const normalizedId = (details: Party) =>
  (details.vatId ?? details.legalId ?? '').replace(/^RO/i, '').replace(/\s+/g, '');

async function latestDetails(tx: Transaction, companyId: string, partyId: string) {
  const [row] = await tx
    .select()
    .from(partyVersions)
    .where(and(eq(partyVersions.companyId, companyId), eq(partyVersions.partyId, partyId)))
    .orderBy(desc(partyVersions.version))
    .limit(1);
  return row && { version: row.version, details: JSON.parse(row.details) as Party };
}

async function selfParty(tx: Transaction, companyId: string) {
  const [row] = await tx
    .select()
    .from(parties)
    .where(and(eq(parties.companyId, companyId), eq(parties.kind, 'self')));
  return row;
}

export async function appendDetails(
  tx: Transaction,
  actor: Actor,
  partyId: string,
  details: Party,
) {
  const current = await latestDetails(tx, actor.companyId, partyId);
  if (current && canonical(current.details) === canonical(details)) return current.version;
  const version = (current?.version ?? 0) + 1;
  await tx.insert(partyVersions).values({
    companyId: actor.companyId,
    partyId,
    version,
    details: canonical(details),
    detailsHash: hashOf(details),
    createdBy: actor.actorId,
  });
  return version;
}

/**
 * Issues the company's own invoices: numbering at the moment of issue, without gaps, the
 * e-Factura XML kept as evidence, and the issued document recognized like any other.
 */
export class Sales {
  constructor(
    private readonly commands: Commands,
    private readonly objects: ObjectStore,
    private readonly proposals: Proposals,
    /** Opens a buyer's sealed CNP for the invoice it is written on (B2C, G2). */
    private readonly sealer?: Sealer,
  ) {}

  /** The company's own invoicing details; its identifier must be the company's CUI. */
  recordSeller(actor: Actor, key: string, input: z.infer<typeof sellerInput>) {
    return this.commands.run(actor, key, 'sales.seller.record', input, 'manage', async (tx) => {
      const [company] = await tx.select().from(companies).where(eq(companies.id, actor.companyId));
      const details = input.details;
      requireCondition(
        details.address.country === 'RO' && normalizedId(details) === company!.cui,
        'SELLER_IDENTITY',
        `Codul de identificare al vânzătorului trebuie să fie CUI-ul companiei (${company!.cui}).`,
      );
      let party = await selfParty(tx, actor.companyId);
      if (!party) {
        [party] = await tx
          .insert(parties)
          .values({
            id: this.commands.ids(),
            companyId: actor.companyId,
            kind: 'self',
            country: 'RO',
            taxId: company!.cui,
            name: details.name,
            createdBy: actor.actorId,
          })
          .returning();
      }
      const version = await appendDetails(tx, actor, party!.id, details);
      return { partyId: party!.id, version };
    });
  }

  /** A partner's invoicing details; the identifier must be the one the partner was created with. */
  recordPartyDetails(actor: Actor, key: string, input: z.infer<typeof partyDetailsInput>) {
    return this.commands.run(actor, key, 'parties.recordDetails', input, 'write', async (tx) => {
      const [party] = await tx
        .select()
        .from(parties)
        .where(and(eq(parties.companyId, actor.companyId), eq(parties.id, input.partyId)));
      requireCondition(party && party.kind !== 'self', 'NOT_FOUND', 'Partenerul nu există.', 404);
      requireCondition(
        party.country === input.details.address.country &&
          (!party.taxId || normalizedId(input.details) === party.taxId),
        'PARTY_IDENTITY',
        'Țara și codul de identificare trebuie să fie cele ale partenerului.',
      );
      const version = await appendDetails(tx, actor, party.id, input.details);
      return { partyId: party.id, version };
    });
  }

  /** A partner with its current details; for agents, an individual's identifier and any CNP in
   * the details are masked (`maskedTaxId`, `maskCnps`). */
  partyDetails(actor: Actor, input: { partyId: string }) {
    return this.commands.read(actor, 'parties.get', async (tx) => {
      const [party] = await tx
        .select()
        .from(parties)
        .where(and(eq(parties.companyId, actor.companyId), eq(parties.id, input.partyId)));
      requireCondition(party, 'NOT_FOUND', 'Partenerul nu există.', 404);
      const details = await latestDetails(tx, actor.companyId, party.id);
      const shown = details?.details ?? null;
      return {
        id: party.id,
        kind: party.kind,
        country: party.country,
        taxId: maskedTaxId(actor, party),
        name: party.name,
        version: details?.version ?? null,
        details: actor.agentId ? maskCnps(shown) : shown,
      };
    });
  }

  createSeries(actor: Actor, key: string, input: z.infer<typeof seriesInput>) {
    return this.commands.run(actor, key, 'sales.series.create', input, 'manage', async (tx) => {
      const [existing] = await tx
        .select()
        .from(series)
        .where(and(eq(series.companyId, actor.companyId), eq(series.code, input.code)));
      requireCondition(!existing, 'SERIES_EXISTS', 'Există deja o serie cu acest cod.', 409);
      const [row] = await tx
        .insert(series)
        .values({
          id: this.commands.ids(),
          companyId: actor.companyId,
          ...input,
          typeCodes: canonical(input.typeCodes),
          createdBy: actor.actorId,
        })
        .returning();
      return this.seriesView(tx, row!);
    });
  }

  listSeries(actor: Actor) {
    return this.commands.read(actor, 'sales.series.list', async (tx) => {
      const rows = await tx
        .select()
        .from(series)
        .where(eq(series.companyId, actor.companyId))
        .orderBy(asc(series.code));
      return Promise.all(rows.map((row) => this.seriesView(tx, row)));
    });
  }

  /** What issuing would produce now: the next number, the invoice, the XML, every problem. */
  preview(actor: Actor, input: IssueInput) {
    return this.commands.read(actor, 'sales.preview', async (tx) => {
      const prepared = await this.prepare(tx, actor.companyId, input);
      // A buyer's CNP is shown only on the invoice issued: the preview masks it.
      const invoice =
        prepared.invoice && prepared.cnpSealed
          ? {
              ...prepared.invoice,
              buyer: { ...prepared.invoice.buyer, legalId: '*************' },
            }
          : prepared.invoice;
      return {
        number: prepared.number,
        invoice,
        problems: prepared.problems,
        xml: prepared.problems.length || !invoice ? null : writeInvoice(invoice),
      };
    });
  }

  async issue(actor: Actor, key: string, input: IssueInput) {
    const issued = await this.commands.run(
      actor,
      key,
      'sales.issue',
      input,
      'write',
      async (tx) => {
        const prepared = await this.prepare(tx, actor.companyId, input);
        const [problem] = prepared.problems;
        if (problem || !prepared.invoice)
          throw new DomainError(
            problem?.code ?? 'EINVOICE',
            problem?.message ?? 'Factura nu poate fi emisă.',
            422,
            {
              problems: prepared.problems,
            },
          );
        const { invoice, number, value, seriesRow, sellerVersion, buyerVersion } = prepared;
        const bytes = Buffer.from(writeInvoice(invoice), 'utf8');
        const hash = sha256(bytes);
        const [stored] = await tx
          .select()
          .from(evidence)
          .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.hash, hash)));
        const evidenceId = stored?.id ?? this.commands.ids();
        if (!stored) {
          await this.objects.put(actor.companyId, bytes, 64 * 1024 * 1024);
          await tx.insert(evidence).values({
            id: evidenceId,
            companyId: actor.companyId,
            hash,
            filename: `${number}.xml`,
            mediaType: 'application/xml',
            size: bytes.length,
            createdBy: actor.actorId,
            engineAt: this.commands.clock(),
          });
        }
        const body = parseInvoiceXml(bytes);
        const documentId = this.commands.ids();
        const kind = input.typeCode === '381' ? invoiceKinds.saleCredit : invoiceKinds.sale;
        const identityKey = documentIdentity(kind, body, normalizedTaxId(body.supplier.taxId));
        await tx.insert(documents).values({
          id: documentId,
          companyId: actor.companyId,
          kind,
          schema: body.parserVersion,
          body: canonical(body),
          bodyHash: hashOf(body),
          sourceKey: `series:${seriesRow.id}:${value}`,
          evidenceId,
          origin: 'issued',
          docDate: input.issueDate,
          partyId: input.buyerId,
          currency: invoice.currency,
          number,
          identityKey,
          authority: 'issued',
          createdBy: actor.actorId,
        });
        await joinIdentityGroup(tx, actor, { id: documentId, identityKey });
        for (const toId of input.precedingDocumentIds)
          await tx.insert(documentLinks).values({
            companyId: actor.companyId,
            fromId: documentId,
            toId,
            kind: 'corrects',
            createdBy: actor.actorId,
          });
        await tx.insert(issuedNumbers).values({
          companyId: actor.companyId,
          seriesId: seriesRow.id,
          number: value,
          typeCode: input.typeCode,
          issueDate: input.issueDate,
          documentId,
          sellerVersion,
          buyerVersion,
          createdBy: actor.actorId,
        });
        return {
          documentId,
          number,
          evidenceId,
          totals: {
            taxExclusive: invoice.totals.taxExclusive,
            tax: invoice.totals.tax,
            payable: invoice.totals.payable,
          },
          account: input.revenueAccount ?? seriesRow.revenueAccount,
        };
      },
    );
    return { ...issued, recognition: await this.recognize(actor, key, input, issued) };
  }

  /** Each stock line names a line of the invoice once, an item of the catalogue on 371 whose unit
   * the line is in, and the warehouse exists. */
  private async stockProblems(tx: Transaction, companyId: string, input: IssueInput) {
    if (!input.stock) return [];
    const problems: Problem[] = [];
    const stock = input.stock;
    if (input.margin || input.reverseCharge)
      problems.push({
        code: 'STOCK_SALE',
        message:
          'Descărcarea gestiunii se face la facturile de vânzare în regimul general; vânzările în regimul marjei sau cu taxare inversă nu sunt acoperite.',
      });
    const [store] = await tx
      .select({ id: warehouses.id })
      .from(warehouses)
      .where(and(eq(warehouses.companyId, companyId), eq(warehouses.id, stock.warehouseId)));
    if (!store) problems.push({ code: 'STOCK_WAREHOUSE', message: 'Gestiunea nu există.' });
    const items = new Map(
      (
        await tx
          .select()
          .from(stockItems)
          .where(
            and(
              eq(stockItems.companyId, companyId),
              inArray(
                stockItems.id,
                stock.lines.map((line) => line.itemId),
              ),
            ),
          )
      ).map((row) => [row.id, row]),
    );
    const seen = new Set<number>();
    for (const row of stock.lines) {
      const line = input.lines[row.index];
      const item = items.get(row.itemId);
      if (!line || seen.has(row.index))
        problems.push({
          code: 'STOCK_LINE',
          message: `Linia ${row.index + 1} nu există sau apare de două ori în descărcare.`,
        });
      else if (!item) problems.push({ code: 'STOCK_ITEM', message: 'Articolul nu există.' });
      else if (!/^\d+(\.\d{1,3})?$/.test(canonicalQuantity(line.quantity)))
        problems.push({
          code: 'STOCK_QUANTITY',
          message: `Cantitatea liniei ${row.index + 1} are mai mult de trei zecimale: gestiunea ține cantitățile la miime.`,
        });
      else if (item.unit !== line.unitCode)
        problems.push({
          code: 'STOCK_UNIT',
          message: `Linia ${row.index + 1} este în ${line.unitCode}, iar articolul ${item.code} se ține în ${item.unit}.`,
        });
      seen.add(row.index);
    }
    return problems;
  }

  /** Proposes the issued document's recognition; a posting policy may post it at once. A refusal
   * leaves the issued invoice in place and is reported, since the number is already used. */
  private async recognize(
    actor: Actor,
    key: string,
    input: IssueInput,
    issued: { documentId: string; account: string; totals: { taxExclusive: string } },
  ) {
    const credit = input.typeCode === '381';
    try {
      // A derived key keeps the retry of an issue a retry of its recognition too.
      const proposal = await this.proposals.propose(
        actor,
        `recognize:${hashOf(key).slice(0, 40)}`,
        credit
          ? 'invoices.credit'
          : input.receipt
            ? 'retail.receiptInvoice'
            : input.margin
              ? 'margin.sale'
              : input.reverseCharge
                ? 'invoices.reverseCharge'
                : 'invoices.recognize',
        input.receipt && !credit
          ? {
              documentId: issued.documentId,
              zReportId: input.receipt.zReportId,
              receipts: input.receipt.receipts,
            }
          : input.margin && !credit
            ? marginRecognition(input.margin, issued.documentId, issued.account)
            : input.reverseCharge && !credit
              ? {
                  documentId: issued.documentId,
                  parts: [
                    {
                      ...input.reverseCharge,
                      account: issued.account,
                      amount: issued.totals.taxExclusive,
                    },
                  ],
                }
              : credit
                ? {
                    documentId: issued.documentId,
                    originalDocumentId: input.precedingDocumentIds[0],
                    account: issued.account,
                    ...stockOf(input),
                  }
                : {
                    documentId: issued.documentId,
                    account: issued.account,
                    ...(input.affiliated ? { affiliated: true } : {}),
                    ...(input.exemption ? { exemption: input.exemption } : {}),
                    ...stockOf(input),
                  },
      );
      return { proposalId: proposal.id, error: null };
    } catch (error) {
      return { proposalId: null, error: (error as Error).message };
    }
  }

  private async seriesView(tx: Transaction, row: typeof series.$inferSelect) {
    const [last] = await tx
      .select({ number: max(issuedNumbers.number) })
      .from(issuedNumbers)
      .where(and(eq(issuedNumbers.companyId, row.companyId), eq(issuedNumbers.seriesId, row.id)));
    return {
      id: row.id,
      code: row.code,
      prefix: row.prefix,
      width: row.width,
      firstNumber: row.firstNumber,
      typeCodes: JSON.parse(row.typeCodes) as string[],
      revenueAccount: row.revenueAccount,
      nextNumber: formatNumber(
        row,
        last?.number == null ? row.firstNumber : Number(last.number) + 1,
      ),
    };
  }

  private async prepare(tx: Transaction, companyId: string, input: IssueInput) {
    const problems: Problem[] = [];
    const problem = (code: string, message: string) => problems.push({ code, message });

    const [seriesRow] = await tx
      .select()
      .from(series)
      .where(and(eq(series.companyId, companyId), eq(series.id, input.seriesId)));
    requireCondition(seriesRow, 'NOT_FOUND', 'Seria nu există.', 404);
    if (!(JSON.parse(seriesRow.typeCodes) as string[]).includes(input.typeCode))
      problem(
        'SERIES_TYPE',
        `Seria ${seriesRow.code} nu emite documente de tipul ${input.typeCode}.`,
      );
    const [last] = await tx
      .select({ number: max(issuedNumbers.number), date: max(issuedNumbers.issueDate) })
      .from(issuedNumbers)
      .where(and(eq(issuedNumbers.companyId, companyId), eq(issuedNumbers.seriesId, seriesRow.id)));
    const value = last?.number == null ? seriesRow.firstNumber : Number(last.number) + 1;
    const number = formatNumber(seriesRow, value);
    if (last?.date && input.issueDate < last.date)
      problem(
        'SERIES_DATE',
        `Ultima factură din serie are data ${last.date}; numerele nu pot reveni în timp.`,
      );
    const [reused] = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.companyId, companyId),
          eq(documents.number, number),
          inArray(documents.kind, issuedKinds),
        ),
      );
    if (reused) problem('NUMBER_USED', `Numărul ${number} apare deja pe un document de vânzare.`);

    const self = await selfParty(tx, companyId);
    const seller = self && (await latestDetails(tx, companyId, self.id));
    const [buyerParty] = await tx
      .select()
      .from(parties)
      .where(and(eq(parties.companyId, companyId), eq(parties.id, input.buyerId)));
    requireCondition(
      buyerParty && buyerParty.kind !== 'self',
      'NOT_FOUND',
      'Cumpărătorul nu există.',
      404,
    );
    const buyer = await latestDetails(tx, companyId, buyerParty.id);
    if (!seller) problem('SELLER_DETAILS', 'Înregistrați datele de facturare ale companiei.');
    if (!buyer) problem('BUYER_DETAILS', 'Înregistrați datele de facturare ale cumpărătorului.');
    // An individual (B2C, OUG nr. 120/2021 art. 10^1 alin. (3)): the CNP they gave, opened from
    // its seal for the invoice only, or 13 zeros in place of a code (`ro.efactura.b2c`).
    let buyerDetails = buyer?.details;
    let cnpSealed = false;
    if (buyerParty.kind === 'ro_individual') {
      if (!input.b2c)
        problem(
          'B2C_IDENTIFICATION',
          'Indicați cum s-a identificat cumpărătorul persoană fizică (b2c.identification): prin CNP-ul înregistrat sau prin niciun cod.',
        );
      else if (buyer) {
        if (buyer.details.vatId)
          problem('B2C_VAT_ID', 'O persoană fizică în relația B2C nu are cod de TVA pe factură.');
        if (buyer.details.address.country !== 'RO')
          problem(
            'B2C_COUNTRY',
            'Consumatorii din alte state membre se facturează în afara acestei relații (invoices.euConsumer).',
          );
        try {
          const rules = await this.proposals.ruleContext(tx, companyId);
          const rule = rules.param<B2cRule>(
            'ro.efactura.b2c',
            'invoice_issue_date',
            input.issueDate,
          );
          let cnp: string | null = null;
          if (input.b2c.identification === 'cnp') {
            const [row] = await tx
              .select({ sealed: partyCnps.cnpSealed })
              .from(partyCnps)
              .where(and(eq(partyCnps.companyId, companyId), eq(partyCnps.partyId, buyerParty.id)));
            cnp = row && this.sealer ? this.sealer.open(companyId, row.sealed) : null;
            cnpSealed = cnp !== null;
          }
          const outcome = b2cInvoice(rule, {
            identification: input.b2c.identification,
            cnp,
            receiptInvoice: input.receipt !== undefined,
          });
          if (!outcome.ok) problem(outcome.code, outcome.message);
          else {
            const { vatId: _vat, ...rest } = buyer.details;
            buyerDetails = { ...rest, legalId: outcome.legalId };
          }
        } catch (error) {
          if (!(error instanceof RuleGapError)) throw error;
          problem('RULE_GAP', error.message);
        }
      }
    } else if (input.b2c)
      problem('B2C_PARTY', 'Doar o persoană fizică se facturează în relația B2C (b2c).');
    // An invoice for fiscal receipts (art. 319 alin. (10) lit. a)): the Z report holds them.
    let receiptNote: string | null = null;
    if (input.receipt) {
      const [report] = await tx
        .select()
        .from(documents)
        .where(and(eq(documents.companyId, companyId), eq(documents.id, input.receipt.zReportId)));
      if (!report || report.kind !== zReportKind)
        problem('RECEIPT_ZREPORT', 'Raportul Z al bonurilor nu există.');
      else
        receiptNote = `Conform bon fiscal nr. ${input.receipt.receipts.join(', ')} din ${report.docDate}`;
      if (input.typeCode !== '380' || input.margin || input.reverseCharge || input.stock)
        problem(
          'RECEIPT_INVOICE',
          'O factură pentru bonuri fiscale este o factură obișnuită (380), fără regim special și fără descărcarea gestiunii, făcută deja de raportul Z.',
        );
    }

    // The rate's date, as `invoices.recognize` will read the issued XML: the supply's date (BT-72)
    // unless the invoice or the stated tax point comes first (Codul fiscal art. 282, 291 alin. (4)).
    const taxPoint = taxPointOf({
      issueDate: input.issueDate,
      taxPointDate: input.taxPointDate ?? null,
      ...(input.deliveryDate ? { deliveryDate: input.deliveryDate } : {}),
    });
    const { loaded } = await loadState(tx, companyId, { profile: true });
    const status = profileAt(loaded, 'vat.status', taxPoint);
    if (!status)
      problem(
        'DETERMINATION_MISSING',
        'Înregistrați regimul TVA al companiei pentru această dată.',
      );
    if (seller && status === 'normal_vat' && !seller.details.vatId)
      problem(
        'SELLER_VAT_STATUS',
        'Compania este plătitoare de TVA, dar datele ei de facturare nu au cod de TVA.',
      );
    if (seller && status === 'non_vat' && seller.details.vatId)
      problem(
        'SELLER_VAT_STATUS',
        'Compania nu este plătitoare de TVA, dar datele ei de facturare au cod de TVA.',
      );
    problems.push(...(await this.rates(tx, companyId, input, taxPoint, status)));
    // A company applying VAT on collection writes the mention on its invoices (Codul fiscal art.
    // 319 alin. (20) lit. p)), in BT-22 as RO_CIUS asks, except to an affiliated buyer.
    const cashVat =
      status === 'normal_vat' &&
      profileAt(loaded, 'vat.cash', [input.issueDate, taxPoint].sort()[0]! as LocalDate) === 'yes';
    const mentioned = input.notes.some(mentionsCashVat);
    if (input.affiliated && !cashVat)
      problem(
        'AFFILIATED',
        'Compania nu aplică TVA la încasare: beneficiarul afiliat nu schimbă facturarea.',
      );
    if (input.affiliated && mentioned)
      problem(
        'CASH_VAT_MENTION',
        'Factura către un beneficiar afiliat urmează regulile generale de exigibilitate (art. 282 alin. (6) lit. d) din Codul fiscal) și nu are mențiunea „TVA la încasare”.',
      );
    const notes = [
      ...(cashVat && !input.affiliated && !mentioned
        ? [...input.notes, cashVatMention]
        : input.notes),
      ...(receiptNote && !input.notes.some((note) => /conform bon fiscal/i.test(note))
        ? [receiptNote]
        : []),
    ];

    const preceding = input.precedingDocumentIds.length
      ? await tx
          .select()
          .from(documents)
          .where(
            and(
              eq(documents.companyId, companyId),
              inArray(documents.id, input.precedingDocumentIds),
              inArray(documents.kind, issuedKinds),
            ),
          )
      : [];
    if (preceding.length !== input.precedingDocumentIds.length)
      problem(
        'PRECEDING',
        'Facturile corectate trebuie să fie documente de vânzare ale companiei.',
      );
    // A credit note without its invoice is reported by checkInvoice (CREDIT_REFERENCE).
    if (input.typeCode === '381' && input.precedingDocumentIds.length > 1)
      problem('PRECEDING', 'O notă de credit corectează exact o factură.');

    let invoice: Invoice | null = null;
    if (seller && buyer)
      try {
        const {
          seriesId: _s,
          buyerId: _b,
          precedingDocumentIds,
          revenueAccount: _r,
          reducedRateBasis: _basis,
          affiliated: _affiliated,
          exemption: _exemption,
          reverseCharge: _reverse,
          margin: _margin,
          stock: _stock,
          b2c: _b2c,
          receipt: _receipt,
          ...fields
        } = input;
        invoice = calculateInvoice({
          ...fields,
          notes,
          number,
          seller: seller.details,
          buyer: buyerDetails ?? buyer.details,
          ...(input.currency !== 'RON' ? { vatCurrency: 'RON' as const } : {}),
          precedingInvoices: precedingDocumentIds.flatMap((id) =>
            preceding
              .filter((row) => row.id === id)
              .map((row) => ({ number: row.number ?? '', issueDate: row.docDate as LocalDate })),
          ),
        });
        problems.push(...checkInvoice(invoice).map(({ code, message }) => ({ code, message })));
        problems.push(
          ...(await this.reverseCharge(tx, companyId, input, invoice, taxPoint, status, buyer)),
        );
        problems.push(...marginIssueProblems(input, invoice, status));
        problems.push(...(await this.stockProblems(tx, companyId, input)));
      } catch (error) {
        const { code = 'EINVOICE', message } = error as { code?: string; message: string };
        problem(code, message);
      }
    return {
      problems,
      invoice,
      number,
      value,
      seriesRow,
      sellerVersion: seller?.version ?? 0,
      buyerVersion: buyer?.version ?? 0,
      cnpSealed,
    };
  }

  /**
   * A supply under the domestic reverse charge (art. 331): every line in category AE, without
   * VAT, between persons registered for VAT, of a category in force on the tax point, and for
   * phones, circuits and laptops at least the threshold on the invoice (alin. (7)). Lines in AE
   * name the category, which the recognition needs.
   */
  private async reverseCharge(
    tx: Transaction,
    companyId: string,
    input: IssueInput,
    invoice: Invoice,
    taxPoint: LocalDate,
    status: string | null,
    buyer: { details: Party } | null | undefined,
  ): Promise<Problem[]> {
    const vats = [
      ...input.lines.map((line) => line.vat),
      ...input.adjustments.map((item) => item.vat),
    ];
    const reverse = vats.some((vat) => vat.category === 'AE');
    if (!reverse && !input.reverseCharge) return [];
    if (!input.reverseCharge)
      return [
        {
          code: 'REVERSE_CHARGE_CATEGORY',
          message:
            'Liniile cu taxare inversă (AE) se emit cu categoria art. 331 alin. (2) a operațiunii (reverseCharge.category).',
        },
      ];
    const problems: Problem[] = [];
    if (vats.some((vat) => vat.category !== 'AE') || input.typeCode !== '380')
      problems.push({
        code: 'REVERSE_CHARGE_LINES',
        message:
          'O factură cu taxare inversă are toate liniile în categoria AE, fără TVA; facturile mixte și notele de credit nu sunt încă acoperite.',
      });
    // The supplier writes «taxare inversă» on the invoice (norme pct. 109 alin. (1)).
    const mention = (text: string | undefined) =>
      !!text &&
      text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().includes('taxare inversa');
    if (
      !vats.some((vat) => mention(vat.exemptionReason)) &&
      !input.notes.some((note) => mention(note))
    )
      problems.push({
        code: 'REVERSE_CHARGE_MENTION',
        message:
          'Înscrieți pe factură mențiunea „taxare inversă” (motivul scutirii al categoriei AE, BT-120, sau o notă).',
      });
    if (input.currency !== 'RON')
      problems.push({
        code: 'REVERSE_CHARGE_CURRENCY',
        message: 'Facturile cu taxare inversă în valută nu sunt încă acoperite.',
      });
    if (status !== 'normal_vat' || !/^RO\d+$/i.test(buyer?.details.vatId ?? ''))
      problems.push({
        code: 'REVERSE_CHARGE_PARTIES',
        message:
          'Taxarea inversă se aplică doar între persoane înregistrate în scopuri de TVA (art. 331 alin. (1)): compania și cumpărătorul, cu codul lui de TVA (RO…).',
      });
    const rules = await this.proposals.ruleContext(tx, companyId);
    try {
      const rule = rules.param<ReverseChargeRule>(
        'ro.vat.reverse_charge.domestic',
        'vat_chargeability_date',
        taxPoint,
      );
      const applies = reverseChargeApplies(
        [
          {
            category: input.reverseCharge.category,
            bani: BigInt(invoice.totals.taxExclusive.replace('.', '')),
          },
        ],
        rule,
      );
      if (!applies.applies)
        problems.push({
          code:
            applies.reason === 'category' ? 'REVERSE_CHARGE_CATEGORY' : 'REVERSE_CHARGE_THRESHOLD',
          message:
            applies.reason === 'category'
              ? `Categoria ${applies.detail} nu este cu taxare inversă la ${taxPoint}: se facturează cu TVA.`
              : `Bunurile însumează ${applies.detail} lei, sub ${rule.threshold.lei} lei: se facturează cu TVA (art. 331 alin. (7)).`,
        });
    } catch (error) {
      if (!(error instanceof RuleGapError)) throw error;
      problems.push({ code: 'RULE_GAP', message: error.message });
    }
    return problems;
  }

  /** Standard-rated lines carry the standard rate in force at the tax point, or the reduced
   * rate with the supply of art. 291 alin. (2) that justifies it; a company outside VAT invoices
   * only operations not subject to it. */
  private async rates(
    tx: Transaction,
    companyId: string,
    input: IssueInput,
    taxPoint: LocalDate,
    status: string | null,
  ): Promise<Problem[]> {
    const vats = [
      ...input.lines.map((line) => line.vat),
      ...input.adjustments.map((item) => item.vat),
    ];
    // An exempt line names its legal basis (art. 292, 294–296, 297 alin. (4) lit. d)).
    // A margin scheme's lines are in E without an exemption basis (V4, marginIssueProblems).
    if (
      status === 'normal_vat' &&
      !input.margin &&
      vats.some((vat) => isExemptCategory(vat.category))
    ) {
      if (!input.exemption)
        return [
          {
            code: 'EXEMPTION_BASIS',
            message:
              'Liniile scutite (E, K, G) cer temeiul scutirii (exemption): de el depind dreptul de deducere și rândul decontului (art. 292, 294–296, 297 alin. (4) din Codul fiscal).',
          },
        ];
      const allowed = exemptionBases[input.exemption].categories as readonly string[];
      const wrong = vats.filter(
        (vat) => isExemptCategory(vat.category) && !allowed.includes(vat.category),
      );
      if (wrong.length)
        return [
          {
            code: 'EXEMPTION_CATEGORY',
            message: `Temeiul ${input.exemption} se facturează cu categoria ${allowed.join(' sau ')}.`,
          },
        ];
    }
    if (status === 'non_vat')
      return vats.some((vat) => vat.category !== 'O')
        ? [
            {
              code: 'TAX_CATEGORY',
              message: 'Un neplătitor de TVA facturează doar operațiuni neimpozabile (O).',
            },
          ]
        : [];
    if (!vats.some((vat) => vat.category === 'S')) return [];
    const rules = await this.proposals.ruleContext(tx, companyId);
    try {
      const rate = rules.param<string>('ro.vat.rate', 'vat_chargeability_date', taxPoint, {
        category: 'S',
      });
      let reduced: string | null = null;
      try {
        reduced = rules.param<string>('ro.vat.rate.reduced', 'vat_chargeability_date', taxPoint);
      } catch (error) {
        if (!(error instanceof RuleGapError)) throw error;
      }
      const other = [
        ...new Set(
          vats.filter((vat) => vat.category === 'S' && vat.rate !== rate).map((vat) => vat.rate),
        ),
      ];
      return other.flatMap((value): Problem[] =>
        value === reduced
          ? input.reducedRateBasis
            ? []
            : [
                {
                  code: 'REDUCED_RATE_BASIS',
                  message: `Cota redusă de ${value}% se aplică doar livrărilor și prestărilor de la art. 291 alin. (2) din Codul fiscal: precizați temeiul.`,
                },
              ]
          : [
              {
                code: 'VAT_RATE',
                message: `Cota ${value}% nu este în vigoare la ${taxPoint}: cota standard este ${rate}%${reduced ? `, cota redusă ${reduced}%` : ''}.`,
              },
            ],
      );
    } catch (error) {
      if (!(error instanceof RuleGapError)) throw error;
      return [
        {
          code: 'RULE_GAP',
          message: `Cota TVA pentru ${taxPoint} nu este disponibilă: ${error.message}`,
        },
      ];
    }
  }
}
