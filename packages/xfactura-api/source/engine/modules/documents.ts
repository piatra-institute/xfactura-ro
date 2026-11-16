import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { canonical, hashOf } from 'xfactura-core/hash';
import {
  checkDocument,
  companyParty,
  type CitationResult,
  type DocumentCheck,
  type RatesAt,
} from 'xfactura-core/documents/checks';
import {
  citationsSchema,
  documentIdentity,
  documentKinds,
  documentTotals,
  extractedBody,
  extractedKinds,
  isInvoiceKind,
  isIssuedKind,
  normalizedTaxId,
  type ContractDocument,
  type ExtractedBody,
  type ExtractedKind,
  type ReceiptDocument,
  isTaxKind,
} from 'xfactura-core/documents/schemas';
import type { TaxDecisionDocument, TaxStatementDocument } from 'xfactura-core/ro/taxaccount';
import { isInventoryKind, type InventoryList } from 'xfactura-core/ro/yearend';
import { isZReportKind } from 'xfactura-core/ro/retail';
import {
  isCustomsKind,
  isViesKind,
  type CustomsDeclaration,
  type ViesCheck,
} from 'xfactura-core/ro/trade';
import { isValidCnp } from 'xfactura-core/ro/identifiers';
import { RuleGapError, type RuleContext } from 'xfactura-core/rules';
import { bucharestDate, daysBetween, type LocalDate } from 'xfactura-core/time';
import type { InvoiceDocument } from 'xfactura-core/ubl/invoice-document';
import type { Transaction } from '../db/database';
import type { PartyIdentities } from '../db/identity';
import { maskCnps } from '../kernel/personal';
import { companies, documentLinks, documents, evidence, parties, type Role } from '../db/schema';
import type { Actor, Commands, Ids } from '../kernel/commands';
import { documentBooked, documentBookingRows } from '../kernel/ledger';
import { joinIdentityGroup, placesOf, rootOf, type DocumentPlace } from '../kernel/sources';
import type { Evidence, TextLayer } from './evidence';

/*
 * Documents of any source. e-Factura invoices come from their XML (`invoices.import`, the SPV);
 * everything else an agent reads from a PDF or a photo and records here, as data: the fields it
 * read, each citing the line of the file it comes from. The engine checks the citations against
 * the file's text layer and the document's own arithmetic, keeps both with it, and a person
 * approves whatever booking reads it.
 */

const checkView = z.object({
  code: z.string(),
  status: z.enum(['passed', 'failed', 'unverified', 'skipped']),
  blocking: z.boolean(),
  message: z.string(),
  details: z.unknown().optional(),
});
const citationView = z.object({
  field: z.string(),
  page: z.number(),
  line: z.number(),
  text: z.string(),
  status: z.enum(['verified', 'failed', 'unverified']),
  reason: z.string().nullable(),
});

export const documentView = z.object({
  id: z.string(),
  kind: z.string(),
  number: z.string().nullable(),
  date: z.string(),
  partyId: z.string().nullable(),
  currency: z.string().nullable(),
  totals: z.object({ net: z.string(), tax: z.string(), gross: z.string() }).nullable(),
  evidenceId: z.string().nullable(),
  /** Where its content comes from: efactura, issued, ubl_upload, invoicer or extracted. */
  authority: z.string().nullable(),
  /** The root of the group of its copies (itself when it is the root); null outside any. */
  groupId: z.string().nullable(),
  /** The corrected extraction that replaced it, if any. */
  supersededBy: z.string().nullable(),
  /** An extracted document's checks; null for structured sources. */
  checks: z.array(checkView).nullable(),
});
export type DocumentView = z.infer<typeof documentView>;
export const documentDetail = documentView.extend({
  schema: z.string(),
  body: z.unknown(),
  /** An extracted document's citations, with the text layer's version they were checked on. */
  citations: z
    .object({ extractor: z.string().nullable(), items: z.array(citationView) })
    .nullable(),
  /** The documents of its group, the root first. */
  members: z.array(
    z.object({ id: z.string(), authority: z.string().nullable(), link: z.string() }),
  ),
  supersedes: z.string().nullable(),
});

export const listInput = z
  .object({
    kinds: z.array(z.string()).max(20).optional(),
    authority: z
      .enum(['efactura', 'issued', 'ubl_upload', 'invoicer', 'amef', 'extracted'])
      .optional(),
  })
  .strict();
const part = z.number().int().min(1).max(1000);
export const recordInput = z
  .object({
    evidenceId: z.uuid(),
    /** Which document of the file this is, from 1: one PDF may hold several receipts. */
    part: part.default(1),
    kind: z.enum(extractedKinds),
    /** What was read: an invoice in the UBL parser's shape (defaults for what print rarely
     * states), a receipt or a contract (see `documents.get` for a recorded one). */
    body: z.record(z.string(), z.unknown()),
    /** Where each field was read: `{ "totals.gross": { page, line, text } }`. */
    citations: citationsSchema.default({}),
  })
  .strict();
export const supersedeInput = z
  .object({
    documentId: z.uuid(),
    /** The file the correction was read from, when another; the same file otherwise. */
    evidenceId: z.uuid().optional(),
    part: part.optional(),
    body: z.record(z.string(), z.unknown()),
    citations: citationsSchema.default({}),
  })
  .strict();
export const linkInput = z
  .object({
    /** The document that joins a group: one with no proposal, in no group. */
    documentId: z.uuid(),
    /** A document of the group it joins. */
    targetId: z.uuid(),
  })
  .strict();

type DocumentRow = typeof documents.$inferSelect;
type EvidenceRow = typeof evidence.$inferSelect;

/**
 * Finds the partner by country and tax identifier, or records it from the document. A Romanian
 * partner the document names by a CNP (an individual selling to the company, a B2C buyer of an
 * SPV copy) is the individual, known by the keyed hash of the CNP (`PartyIdentities`), never by
 * the CNP: the database refuses one (`inv:party_cnp`).
 */
export async function partyFor(
  tx: Transaction,
  actor: Actor,
  party: { name: string; taxId: string; country: string },
  ids: Ids,
  identities?: PartyIdentities,
) {
  const normalized = party.country === 'RO' ? normalizedTaxId(party.taxId) : party.taxId;
  const individual = party.country === 'RO' && isValidCnp(normalized);
  requireCondition(
    !individual || identities,
    'PARTY_IDENTITY',
    'O persoană fizică se înregistrează ca partener doar după CNP-ul cheiat al instalării.',
  );
  const taxId = individual ? identities!.ofCnp(actor.companyId, normalized) : normalized;
  const [existing] = await tx
    .select({ id: parties.id })
    .from(parties)
    .where(
      and(
        eq(parties.companyId, actor.companyId),
        eq(parties.country, party.country),
        eq(parties.taxId, taxId),
      ),
    );
  if (existing) return existing.id;
  const id = ids();
  await tx.insert(parties).values({
    id,
    companyId: actor.companyId,
    kind: individual ? 'ro_individual' : party.country === 'RO' ? 'ro_legal_entity' : 'eu_taxable',
    country: party.country,
    taxId,
    name: party.name,
    createdBy: actor.actorId,
  });
  return id;
}

/** The lines a citation may point to; null when the file has no text layer at all. */
const citablePages = (layer: TextLayer) => (layer.pages.length ? layer.pages : null);

function viewOf(row: DocumentRow, place: DocumentPlace | undefined): DocumentView {
  return {
    id: row.id,
    kind: row.kind,
    number: row.number,
    date: row.docDate,
    partyId: row.partyId,
    currency: row.currency,
    totals: documentTotals(JSON.parse(row.body)),
    evidenceId: row.evidenceId,
    authority: row.authority,
    groupId: place?.rootId ?? null,
    supersededBy: place?.supersededBy ?? null,
    checks: row.checks ? (JSON.parse(row.checks) as DocumentCheck[]) : null,
  };
}

/** A document's list view, with its group. */
export async function documentViewOf(tx: Transaction, row: DocumentRow) {
  return viewOf(row, (await placesOf(tx, row.companyId, [row.id])).get(row.id));
}

/** The VAT rates the register has in force on a date, as the company's assurance admits them. */
function ratesFrom(rules: RuleContext): RatesAt {
  return (date) => {
    try {
      const standard = rules.param<string>('ro.vat.rate', 'vat_chargeability_date', date, {
        category: 'S',
      });
      let reduced: string[] = [];
      try {
        reduced = [rules.param<string>('ro.vat.rate.reduced', 'vat_chargeability_date', date)];
      } catch (error) {
        if (!(error instanceof RuleGapError)) throw error;
      }
      return { standard, reduced };
    } catch (error) {
      if (error instanceof RuleGapError) return { gap: error.message };
      throw error;
    }
  };
}

/** The document's counterparty, as a party of the company; null for an individual, whose CNP is
 * never a party's identifier, or a party without one. */
async function counterpartyOf(
  tx: Transaction,
  actor: Actor,
  kind: string,
  body: ExtractedBody,
  companyTaxId: string,
  ids: Ids,
) {
  let party: { name: string; taxId: string; country: string } | undefined;
  // ANAF's documents are the authority's, whose party the booking names (`authorityId`); the
  // inventory's lists are the company's own; a customs declaration and a VIES answer are read by
  // the booking of their invoice, which names the partner (core ro/trade).
  if (
    isTaxKind(kind) ||
    isInventoryKind(kind) ||
    isCustomsKind(kind) ||
    isViesKind(kind) ||
    isZReportKind(kind)
  )
    return null;
  if (isInvoiceKind(kind)) {
    const invoice = body as InvoiceDocument;
    party = isIssuedKind(kind) ? invoice.customer : invoice.supplier;
  } else if (kind === documentKinds.receipt) party = (body as ReceiptDocument).seller;
  else {
    const other = (body as ContractDocument).parties.find(
      (item) => item.taxId && normalizedTaxId(item.taxId) !== companyTaxId,
    );
    if (other?.taxId) party = { name: other.name, taxId: other.taxId, country: other.country };
  }
  if (!party || (party.country === 'RO' && isValidCnp(normalizedTaxId(party.taxId)))) return null;
  return partyFor(tx, actor, party, ids);
}

const docDateOf = (kind: string, body: ExtractedBody) =>
  kind === documentKinds.contract
    ? (body as ContractDocument).date
    : kind === documentKinds.taxStatement
      ? (body as TaxStatementDocument).asOf
      : isInventoryKind(kind)
        ? (body as InventoryList).date
        : isCustomsKind(kind)
          ? (body as CustomsDeclaration).acceptedOn
          : isViesKind(kind)
            ? (body as ViesCheck).requestDate
            : (body as InvoiceDocument | ReceiptDocument | TaxDecisionDocument).issueDate;

/** Documents of every source, and the extractions agents record. */
export class Documents {
  constructor(
    private readonly commands: Commands,
    private readonly evidence: Evidence,
    /** The rules as the company's assurance admits them (the VAT rates in force). */
    private readonly ruleContext: (tx: Transaction, companyId: string) => Promise<RuleContext>,
    private readonly clock: () => number = Date.now,
  ) {}

  /** The evidence a command reads, before its transaction: its text layer may take seconds. Its
   * citations are checked against the file, so the caller must be one who may read it. */
  private async source(actor: Actor, operation: string, evidenceId: string) {
    return this.commands.read(actor, operation, async (tx, access) => {
      const [row] = await tx
        .select()
        .from(evidence)
        .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, evidenceId)));
      requireCondition(row, 'EVIDENCE', 'Documentul justificativ nu este disponibil.', 404);
      await this.evidence.requireReadable(tx, actor, access.role, row.id);
      return row;
    });
  }

  /** `documents.record`: a document an agent read from a PDF or a photo, with its citations. */
  async record(actor: Actor, key: string, input: z.infer<typeof recordInput>) {
    const source = await this.source(actor, 'documents.record', input.evidenceId);
    const layer = await this.evidence.textLayer(actor.companyId, source);
    return this.commands.run(
      actor,
      key,
      'documents.record',
      input,
      'write',
      async (tx) => {
        const recorded = await this.extracted(tx, actor, {
          kind: input.kind,
          body: input.body,
          citations: input.citations,
          source,
          part: input.part,
          layer,
        });
        return this.detail(tx, recorded.row);
      },
      (tx, access, detail) => this.shown(tx, actor, access.role, detail),
    );
  }

  /**
   * A document the engine itself read from a file it keeps (VIES's answer to `parties.checkVies`,
   * core ro/trade): recorded and checked like an extraction, inside the caller's command.
   */
  async recordDerived(
    tx: Transaction,
    actor: Actor,
    input: { kind: ExtractedKind; body: unknown; source: EvidenceRow },
  ) {
    const layer = await this.evidence.textLayer(actor.companyId, input.source);
    const recorded = await this.extracted(tx, actor, {
      kind: input.kind,
      body: input.body,
      citations: {},
      source: input.source,
      part: 1,
      layer,
    });
    return this.detail(tx, recorded.row);
  }

  /**
   * `documents.supersede`: a corrected extraction of a document nothing posted recognizes yet.
   * The correction is a new document that `supersedes` the old one, which proposals can no longer
   * read. After posting, a correction is a reversal (`ledger.reverse`) and a new proposal.
   */
  async supersede(actor: Actor, key: string, input: z.infer<typeof supersedeInput>) {
    const old = await this.commands.read(actor, 'documents.supersede', async (tx) => {
      const [row] = await tx
        .select()
        .from(documents)
        .where(and(eq(documents.companyId, actor.companyId), eq(documents.id, input.documentId)));
      requireCondition(row, 'NOT_FOUND', 'Documentul nu este disponibil.', 404);
      return row;
    });
    requireCondition(
      old.authority === 'extracted',
      'DOCUMENT_AUTHORITY',
      'Se înlocuiesc doar documentele extrase dintr-un PDF sau o fotografie; un document e-Factura, emis sau încărcat ca XML este chiar sursa.',
      409,
    );
    const source = await this.source(
      actor,
      'documents.supersede',
      input.evidenceId ?? old.evidenceId!,
    );
    const layer = await this.evidence.textLayer(actor.companyId, source);
    return this.commands.run(
      actor,
      key,
      'documents.supersede',
      input,
      'write',
      async (tx) => {
        const [successor] = await tx
          .select({ id: documentLinks.fromId })
          .from(documentLinks)
          .where(
            and(
              eq(documentLinks.companyId, actor.companyId),
              eq(documentLinks.toId, old.id),
              eq(documentLinks.kind, 'supersedes'),
            ),
          );
        requireCondition(
          !successor,
          'DOCUMENT_SUPERSEDED',
          'Documentul a fost deja înlocuit: corectați ultima extragere.',
          409,
          { supersededBy: successor?.id },
        );
        const [posted] = await tx
          .select({ posted: sql<number>`1` })
          .from(documents)
          .where(
            and(
              eq(documents.companyId, actor.companyId),
              eq(documents.id, old.id),
              documentBooked(actor.companyId, old.id, {
                postedOnly: true,
                includeReferences: true,
              }),
            ),
          );
        requireCondition(
          !posted,
          'DOCUMENT_POSTED',
          'Documentul este contabilizat: stornați întâi înregistrarea (ledger.reverse), apoi corectați extragerea și propuneți-l din nou.',
          409,
        );
        const recorded = await this.extracted(tx, actor, {
          kind: old.kind as ExtractedKind,
          body: input.body,
          citations: input.citations,
          source,
          part: input.part ?? Number(old.sourceKey.split(':')[2]),
          layer,
          correcting: true,
        });
        await tx.insert(documentLinks).values({
          companyId: actor.companyId,
          fromId: recorded.row.id,
          toId: old.id,
          kind: 'supersedes',
          createdBy: actor.actorId,
        });
        return this.detail(tx, recorded.row);
      },
      (tx, access, detail) => this.shown(tx, actor, access.role, detail),
    );
  }

  /**
   * Records an extracted document: checks it, refuses one the company is not exactly one party
   * of, and joins it to the group of its identity. The same extraction of the same part again is
   * that document; another one is a conflict, unless it corrects (`documents.supersede`).
   */
  private async extracted(
    tx: Transaction,
    actor: Actor,
    input: {
      kind: ExtractedKind;
      body: unknown;
      citations: z.infer<typeof citationsSchema>;
      source: EvidenceRow;
      part: number;
      layer: TextLayer;
      correcting?: boolean;
    },
  ) {
    const [company] = await tx.select().from(companies).where(eq(companies.id, actor.companyId));
    const body = extractedBody(input.kind, input.body);
    const party = companyParty(input.kind, body, company!.cui);
    requireCondition(party.ok, 'COUNTERPARTY', party.ok ? '' : party.message);
    const { checks, citations } = checkDocument({
      kind: input.kind,
      body,
      companyTaxId: company!.cui,
      today: bucharestDate(this.clock()),
      rates: ratesFrom(await this.ruleContext(tx, actor.companyId)),
      pages: citablePages(input.layer),
      citations: input.citations,
    });
    const content = canonical(body);
    const cited = canonical({ extractor: input.layer.extractor, items: citations });
    const base = `extract:${input.source.hash}:${input.part}`;
    const taken = await tx
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.companyId, actor.companyId),
          or(eq(documents.sourceKey, base), sql`${documents.sourceKey} GLOB ${`${base}:*`}`),
        ),
      )
      .orderBy(asc(documents.createdAt));
    if (!input.correcting && taken.length) {
      const [first] = taken;
      if (first!.body === content && first!.citations === cited)
        return { row: first!, created: false };
      requireCondition(
        false,
        'DOCUMENT_CONFLICT',
        'Această parte a fișierului a fost deja înregistrată cu alt conținut: corectați-o cu documents.supersede.',
        409,
        { documentId: first!.id },
      );
    }
    const keys = new Set(taken.map((row) => row.sourceKey));
    let sourceKey = base;
    for (let version = 2; keys.has(sourceKey); version++) sourceKey = `${base}:${version}`;
    const [row] = await tx
      .insert(documents)
      .values({
        id: this.commands.ids(),
        companyId: actor.companyId,
        kind: input.kind,
        schema: body.parserVersion,
        body: content,
        bodyHash: hashOf(body),
        sourceKey,
        evidenceId: input.source.id,
        origin: 'extracted',
        docDate: docDateOf(input.kind, body),
        partyId: await counterpartyOf(tx, actor, input.kind, body, company!.cui, this.commands.ids),
        currency: 'currency' in body ? body.currency : 'RON',
        number:
          'number' in body
            ? body.number
            : 'mrn' in body
              ? body.mrn
              : 'vatNumber' in body
                ? `${body.countryCode}${body.vatNumber}`
                : null,
        identityKey: documentIdentity(input.kind, body, company!.cui),
        authority: 'extracted',
        checks: canonical(checks),
        citations: cited,
        createdBy: actor.actorId,
      })
      .returning();
    await joinIdentityGroup(tx, actor, row!);
    return { row: row!, created: true };
  }

  /**
   * `documents.link`, for people: two near copies of one document (the same partner and gross
   * amount, dated at most 3 days apart) that their identities did not join, typically a number or
   * a date an extraction read differently. The document joins the other's group, so that only one
   * of them is ever recognized.
   */
  link(actor: Actor, key: string, input: z.infer<typeof linkInput>) {
    requireCondition(
      !actor.agentId,
      'AGENT_SCOPE',
      'Legarea documentelor aparține unei persoane.',
      403,
    );
    return this.commands.run(actor, key, 'documents.link', input, 'review', async (tx) => {
      const rows = await tx
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.companyId, actor.companyId),
            inArray(documents.id, [input.documentId, input.targetId]),
          ),
        );
      const joining = rows.find((row) => row.id === input.documentId);
      const target = rows.find((row) => row.id === input.targetId);
      requireCondition(
        joining && target && joining.id !== target.id,
        'NOT_FOUND',
        'Documentele nu sunt disponibile.',
        404,
      );
      requireCondition(
        joining.kind === target.kind,
        'DOCUMENT_KIND',
        'Se leagă doar documente de același tip.',
      );
      const gross = (row: DocumentRow) => documentTotals(JSON.parse(row.body))?.gross ?? null;
      const days = Math.abs(daysBetween(joining.docDate as LocalDate, target.docDate as LocalDate));
      requireCondition(
        joining.partyId !== null &&
          joining.partyId === target.partyId &&
          gross(joining) !== null &&
          gross(joining) === gross(target) &&
          days <= 3,
        'DOCUMENT_MATCH',
        'Se leagă doar copii ale aceluiași document: același partener, aceeași valoare totală, date la cel mult 3 zile distanță.',
        422,
        {
          partner: joining.partyId === target.partyId,
          gross: gross(joining) === gross(target),
          days,
        },
      );
      const place = (await placesOf(tx, actor.companyId, [joining.id])).get(joining.id)!;
      requireCondition(
        place.rootId === null,
        'DOCUMENT_GROUP',
        'Documentul face deja parte dintr-un grup de copii: legați celălalt document de grupul lui.',
        409,
        { groupId: place.rootId },
      );
      const [open] = await tx.all<{ proposalId: string }>(
        sql`${documentBookingRows(actor.companyId, joining.id, { includeReferences: true })} limit 1`,
      );
      requireCondition(
        !open,
        'DOCUMENT_BOOKED',
        'Documentul are o propunere: retrageți-o (sau stornați înregistrarea) înainte de a-l lega de celălalt.',
        409,
        { proposalId: open?.proposalId },
      );
      const rootId = await rootOf(tx, actor.companyId, target.id);
      await tx.insert(documentLinks).values({
        companyId: actor.companyId,
        fromId: joining.id,
        toId: rootId,
        kind: 'same_as_confirmed',
        createdBy: actor.actorId,
      });
      return { documentId: joining.id, rootId, kind: 'same_as_confirmed' as const };
    });
  }

  list(actor: Actor, input: z.infer<typeof listInput>) {
    return this.commands.read(actor, 'documents.list', async (tx) => {
      const rows = await tx
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.companyId, actor.companyId),
            input.kinds?.length ? inArray(documents.kind, input.kinds) : undefined,
            input.authority ? eq(documents.authority, input.authority) : undefined,
          ),
        )
        .orderBy(asc(documents.docDate), asc(documents.id));
      const places = await placesOf(
        tx,
        actor.companyId,
        rows.map((row) => row.id),
      );
      return rows.map((row) => viewOf(row, places.get(row.id)));
    });
  }

  /** A document with its body and citations; an individual's CNP (a B2C buyer's, BT-47; a
   * supplier's) is masked for a caller who may not read personal data. */
  get(actor: Actor, id: string) {
    return this.commands.read(actor, 'documents.get', async (tx, access) => {
      const [row] = await tx
        .select()
        .from(documents)
        .where(and(eq(documents.companyId, actor.companyId), eq(documents.id, id)));
      requireCondition(row, 'NOT_FOUND', 'Documentul nu este disponibil.', 404);
      return this.shown(tx, actor, access.role, await this.detail(tx, row));
    });
  }

  /** A document as this caller reads it, wherever it leaves the engine (`documents.get`, and
   * what `.record` and `.supersede` return, stored or new): a CNP the body or a citation holds
   * is masked for a caller who may not read personal data. */
  private async shown<Detail extends { body: unknown; citations: unknown }>(
    tx: Transaction,
    actor: Actor,
    role: Role,
    detail: Detail,
  ): Promise<Detail> {
    return (await this.commands.disclosable(tx, actor, role))(['personal'])
      ? detail
      : { ...detail, body: maskCnps(detail.body), citations: maskCnps(detail.citations) };
  }

  private async detail(tx: Transaction, row: DocumentRow) {
    const place = (await placesOf(tx, row.companyId, [row.id])).get(row.id)!;
    return {
      ...viewOf(row, place),
      schema: row.schema,
      body: JSON.parse(row.body) as unknown,
      citations: row.citations
        ? (JSON.parse(row.citations) as { extractor: string | null; items: CitationResult[] })
        : null,
      members: place.members,
      supersedes: place.supersedes,
    };
  }
}
