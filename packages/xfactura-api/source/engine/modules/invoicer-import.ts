import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { DomainError, requireCondition } from 'xfactura-core/errors';
import {
  calculateInvoice,
  fromInvoicer,
  invoicerInvoiceSchema,
  writeInvoice,
  type InvoiceDraft,
} from 'xfactura-core/einvoice';
import { canonical, hashOf } from 'xfactura-core/hash';
import { isValidCnp } from 'xfactura-core/ro/identifiers';
import { invoiceKinds } from 'xfactura-core/ro/treatments/invoices';
import { parseInvoiceXml, type InvoiceDocument } from 'xfactura-core/ubl/invoice-document';
import type { Transaction } from '../db/database';
import { companies, documents, evidence, parties } from '../db/schema';
import { sha256, type ObjectStore } from '../adapters/object-store';
import type { Actor, Commands } from '../kernel/commands';
import { appendDetails } from './sales';

export const invoicerImportInput = z.object({ evidenceId: z.uuid() }).strict();

/**
 * What became of one exported record:
 * - `imported`: a sales document now exists, known only from the export (no SPV confirmation);
 * - `duplicate`: the same content as an imported record with the same number;
 * - `conflict`: records share a number but differ, so none of them is imported;
 * - `invalid`: the record cannot be an e-Factura (the code says why);
 * - `not_seller`: the company is not the seller;
 * - `existing`: an earlier import already holds this record.
 */
export type RecordOutcome = {
  id: string;
  number: string;
  state: 'imported' | 'duplicate' | 'conflict' | 'invalid' | 'not_seller' | 'existing';
  documentId?: string;
  code?: string;
  notes: string[];
};
export const invoicerImportView = z.object({
  adapter: z.literal('xfactura-web-export-1'),
  records: z.number(),
  states: z.record(z.string(), z.number()),
  outcomes: z.array(
    z.object({
      id: z.string(),
      number: z.string(),
      state: z.string(),
      documentId: z.string().optional(),
      code: z.string().optional(),
      notes: z.array(z.string()),
    }),
  ),
});

type Converted = {
  id: string;
  number: string;
  date: string;
  draft?: InvoiceDraft;
  body?: InvoiceDocument;
  notes: string[];
  code?: string;
};

function convert(record: unknown): Converted {
  const loose = record as { id?: unknown; metadata?: { number?: unknown } };
  const fallback = {
    id: String(loose?.id ?? ''),
    number: String(loose?.metadata?.number ?? ''),
    date: '',
    notes: [],
  };
  try {
    const parsed = invoicerInvoiceSchema.parse(record);
    const { draft, notes } = fromInvoicer(parsed);
    const body = parseInvoiceXml(new TextEncoder().encode(writeInvoice(calculateInvoice(draft))));
    return {
      id: parsed.id,
      number: draft.number,
      date: String(draft.issueDate),
      draft,
      body,
      notes: notes.map((note) => note.code),
    };
  } catch (error) {
    return { ...fallback, code: (error as { code?: string }).code ?? 'INVALID_RECORD' };
  }
}

/** The partner for a buyer: an individual is known by a hash of the CNP, never the CNP. */
async function buyerParty(tx: Transaction, actor: Actor, draft: InvoiceDraft) {
  const buyer = draft.buyer;
  const code = (buyer.vatId ?? buyer.legalId ?? '').replace(/^RO/i, '');
  const individual = buyer.address.country === 'RO' && isValidCnp(code);
  const taxId = individual ? `cnp:${sha256(code)}` : code;
  const [existing] = await tx
    .select()
    .from(parties)
    .where(
      and(
        eq(parties.companyId, actor.companyId),
        eq(parties.country, buyer.address.country),
        eq(parties.taxId, taxId),
      ),
    );
  const id = existing?.id ?? randomUUID();
  if (!existing)
    await tx.insert(parties).values({
      id,
      companyId: actor.companyId,
      kind: individual
        ? 'ro_individual'
        : buyer.address.country === 'RO'
          ? 'ro_legal_entity'
          : 'eu_taxable',
      country: buyer.address.country,
      taxId,
      name: buyer.name,
      createdBy: actor.actorId,
    });
  // Details carry the identifier; for individuals that is personal data, so none are kept.
  if (!individual) await appendDetails(tx, actor, id, buyer);
  return id;
}

/**
 * Imports the browser invoicer's export (adapter `xfactura-web-export-1`) as the company's
 * past sales. The export file is the evidence; the documents are what it states, converted
 * exactly as the invoicer would now write them. SPV archives, when imported, are the authority.
 */
export class InvoicerImport {
  constructor(
    private readonly commands: Commands,
    private readonly objects: ObjectStore,
  ) {}

  run(actor: Actor, key: string, input: z.infer<typeof invoicerImportInput>) {
    return this.commands.run(actor, key, 'invoices.importInvoicer', input, 'write', async (tx) => {
      const [source] = await tx
        .select()
        .from(evidence)
        .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, input.evidenceId)));
      requireCondition(source, 'EVIDENCE', 'Documentul justificativ nu este disponibil.', 404);
      let raw: unknown;
      try {
        raw = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(
            await this.objects.get(actor.companyId, source.hash),
          ),
        );
      } catch {
        throw new DomainError(
          'INVOICER_EXPORT',
          'Fișierul nu este un export JSON al facturierului.',
        );
      }
      const records = Array.isArray(raw)
        ? raw
        : Object.values((raw as { invoices?: Record<string, unknown> })?.invoices ?? {});
      requireCondition(
        records.length > 0 && records.length <= 20000,
        'INVOICER_EXPORT',
        'Exportul nu conține facturi sau depășește 20 000 de facturi.',
      );
      const [company] = await tx.select().from(companies).where(eq(companies.id, actor.companyId));

      // Oldest first, so a buyer's details are versioned in the order they were used.
      const converted = records
        .map(convert)
        .sort((a, b) => (a.date === b.date ? (a.id < b.id ? -1 : 1) : a.date < b.date ? -1 : 1));
      const outcomes: RecordOutcome[] = [];
      const groups = Map.groupBy(
        converted.filter((item) => item.body),
        (item) => item.number,
      );
      for (const item of converted) {
        const base = { id: item.id, number: item.number, notes: item.notes };
        if (!item.body || !item.draft) {
          outcomes.push({ ...base, state: 'invalid', code: item.code! });
          continue;
        }
        const seller = (item.draft.seller.vatId ?? item.draft.seller.legalId ?? '').replace(
          /^RO/i,
          '',
        );
        if (seller !== company!.cui) {
          outcomes.push({ ...base, state: 'not_seller' });
          continue;
        }
        const group = groups.get(item.number)!;
        const contents = new Set(group.map((other) => canonical(other.body)));
        if (contents.size > 1) {
          outcomes.push({ ...base, state: 'conflict', code: 'NUMBER_CONFLICT' });
          continue;
        }
        if (group[0] !== item) {
          outcomes.push({ ...base, state: 'duplicate' });
          continue;
        }
        const sourceKey = `invoicer:${hashOf([company!.cui, item.number, item.date])}`;
        const content = canonical(item.body);
        const [existing] = await tx
          .select()
          .from(documents)
          .where(and(eq(documents.companyId, actor.companyId), eq(documents.sourceKey, sourceKey)));
        if (existing) {
          outcomes.push(
            existing.body === content
              ? { ...base, state: 'existing', documentId: existing.id }
              : { ...base, state: 'conflict', code: 'DOCUMENT_CONFLICT', documentId: existing.id },
          );
          continue;
        }
        const documentId = randomUUID();
        await tx.insert(documents).values({
          id: documentId,
          companyId: actor.companyId,
          kind: invoiceKinds.sale,
          schema: item.body.parserVersion,
          body: content,
          bodyHash: hashOf(item.body),
          sourceKey,
          evidenceId: source.id,
          origin: 'invoicer-export',
          docDate: item.date,
          partyId: await buyerParty(tx, actor, item.draft),
          currency: item.body.currency,
          number: item.number,
          createdBy: actor.actorId,
        });
        outcomes.push({ ...base, state: 'imported', documentId });
      }
      const states: Record<string, number> = {};
      for (const outcome of outcomes) states[outcome.state] = (states[outcome.state] ?? 0) + 1;
      return {
        adapter: 'xfactura-web-export-1' as const,
        records: records.length,
        states,
        outcomes,
      };
    });
  }
}
