import { randomUUID } from 'node:crypto';
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
import { accountCodePattern, profileAt } from 'xfactura-core/kernel';
import { invoiceKinds } from 'xfactura-core/ro/treatments/invoices';
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
  partyVersions,
  series,
} from '../db/schema';
import { sha256, type ObjectStore } from '../adapters/object-store';
import type { Actor, Commands } from '../kernel/commands';
import type { Proposals } from '../kernel/proposals';
import { loadState } from '../kernel/state';

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
  })
  .strict();
export type IssueInput = z.infer<typeof issueInput>;

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
            id: randomUUID(),
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

  partyDetails(actor: Actor, input: { partyId: string }) {
    return this.commands.read(actor, 'parties.get', async (tx) => {
      const [party] = await tx
        .select()
        .from(parties)
        .where(and(eq(parties.companyId, actor.companyId), eq(parties.id, input.partyId)));
      requireCondition(party, 'NOT_FOUND', 'Partenerul nu există.', 404);
      const details = await latestDetails(tx, actor.companyId, party.id);
      return {
        id: party.id,
        kind: party.kind,
        country: party.country,
        taxId: party.taxId,
        name: party.name,
        version: details?.version ?? null,
        details: details?.details ?? null,
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
          id: randomUUID(),
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
      return {
        number: prepared.number,
        invoice: prepared.invoice,
        problems: prepared.problems,
        xml: prepared.problems.length || !prepared.invoice ? null : writeInvoice(prepared.invoice),
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
        const evidenceId = stored?.id ?? randomUUID();
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
          });
        }
        const body = parseInvoiceXml(bytes);
        const documentId = randomUUID();
        await tx.insert(documents).values({
          id: documentId,
          companyId: actor.companyId,
          kind: input.typeCode === '381' ? invoiceKinds.saleCredit : invoiceKinds.sale,
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
          createdBy: actor.actorId,
        });
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

  /** Proposes the issued document's recognition; a posting policy may post it at once. A refusal
   * leaves the issued invoice in place and is reported, since the number is already used. */
  private async recognize(
    actor: Actor,
    key: string,
    input: IssueInput,
    issued: { documentId: string; account: string },
  ) {
    const credit = input.typeCode === '381';
    try {
      // A derived key keeps the retry of an issue a retry of its recognition too.
      const proposal = await this.proposals.propose(
        actor,
        `recognize:${hashOf(key).slice(0, 40)}`,
        credit ? 'invoices.credit' : 'invoices.recognize',
        credit
          ? {
              documentId: issued.documentId,
              originalDocumentId: input.precedingDocumentIds[0],
              account: issued.account,
            }
          : { documentId: issued.documentId, account: issued.account },
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
    // TO-SOURCE: how e-Factura identifies individuals (CNP or the substitute code, and when).
    if (buyerParty.kind === 'ro_individual')
      problem(
        'B2C_PENDING',
        'Facturile către persoane fizice așteaptă regulile de identificare B2C.',
      );

    const taxPoint = input.taxPointDate ?? input.issueDate;
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
          ...fields
        } = input;
        invoice = calculateInvoice({
          ...fields,
          number,
          seller: seller.details,
          buyer: buyer.details,
          ...(input.currency !== 'RON' ? { vatCurrency: 'RON' as const } : {}),
          precedingInvoices: precedingDocumentIds.flatMap((id) =>
            preceding
              .filter((row) => row.id === id)
              .map((row) => ({ number: row.number ?? '', issueDate: row.docDate as LocalDate })),
          ),
        });
        problems.push(...checkInvoice(invoice).map(({ code, message }) => ({ code, message })));
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
    };
  }

  /** Standard-rated lines carry the rate in force at the tax point; a company outside VAT
   * invoices only operations not subject to it. Reduced rates are not in the register yet. */
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
      const wrong = [
        ...new Set(
          vats.filter((vat) => vat.category === 'S' && vat.rate !== rate).map((vat) => vat.rate),
        ),
      ];
      return wrong.map((value) => ({
        code: 'VAT_RATE',
        message: `Cota ${value}% nu este cota standard în vigoare la ${taxPoint} (${rate}%); cotele reduse nu sunt încă în registrul de reguli.`,
      }));
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
