import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { canonical, hashOf } from 'xfactura-core/hash';
import { invoiceKinds } from 'xfactura-core/ro/treatments/invoices';
import { parseInvoiceXml, type InvoiceDocument } from 'xfactura-core/ubl/invoice-document';
import type { Transaction } from '../db/database';
import { companies, documents, evidence, parties } from '../db/schema';
import type { ObjectStore } from '../adapters/object-store';
import type { Actor, Commands } from '../kernel/commands';

export const importInput = z.object({ evidenceId: z.uuid() }).strict();
export const documentView = z.object({
  id: z.string(),
  kind: z.string(),
  number: z.string().nullable(),
  date: z.string(),
  partyId: z.string().nullable(),
  currency: z.string().nullable(),
  totals: z.object({ net: z.string(), tax: z.string(), gross: z.string() }).nullable(),
  evidenceId: z.string().nullable(),
});

const normalizedTaxId = (value: string) => value.replace(/^RO/i, '').replace(/\s+/g, '');

/** Finds the partner by country and tax identifier, or records it from the document. */
async function partyFor(tx: Transaction, actor: Actor, party: InvoiceDocument['supplier']) {
  const taxId = party.country === 'RO' ? normalizedTaxId(party.taxId) : party.taxId;
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
  const id = randomUUID();
  await tx.insert(parties).values({
    id,
    companyId: actor.companyId,
    kind: party.country === 'RO' ? 'ro_legal_entity' : 'eu_taxable',
    country: party.country,
    taxId,
    name: party.name,
    createdBy: actor.actorId,
  });
  return id;
}

function view(row: typeof documents.$inferSelect) {
  const body = JSON.parse(row.body) as Partial<InvoiceDocument>;
  return {
    id: row.id,
    kind: row.kind,
    number: row.number,
    date: row.docDate,
    partyId: row.partyId,
    currency: row.currency,
    totals: body.totals
      ? { net: body.totals.net, tax: body.totals.tax, gross: body.totals.gross }
      : null,
    evidenceId: row.evidenceId,
  };
}

/** Imports e-Factura invoices and credit notes from retained XML evidence. */
export class Invoices {
  constructor(
    private readonly commands: Commands,
    private readonly objects: ObjectStore,
  ) {}

  async import(actor: Actor, key: string, input: z.infer<typeof importInput>) {
    return this.commands.run(actor, key, 'invoices.import', input, 'write', async (tx) => {
      const [source] = await tx
        .select()
        .from(evidence)
        .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, input.evidenceId)));
      requireCondition(source, 'EVIDENCE', 'Documentul justificativ nu este disponibil.', 404);
      const body = parseInvoiceXml(await this.objects.get(actor.companyId, source.hash));
      const [company] = await tx.select().from(companies).where(eq(companies.id, actor.companyId));
      const own = (party: InvoiceDocument['supplier']) =>
        party.country === 'RO' && normalizedTaxId(party.taxId) === company!.cui;
      const sale = own(body.supplier);
      requireCondition(
        sale !== own(body.customer),
        'COUNTERPARTY',
        'Compania trebuie să fie fie furnizorul, fie clientul documentului.',
      );
      const credit = body.documentType === 'credit_note';
      const kind = sale
        ? credit
          ? invoiceKinds.saleCredit
          : invoiceKinds.sale
        : credit
          ? invoiceKinds.purchaseCredit
          : invoiceKinds.purchase;
      // One document per supplier, number and date; the same invoice from another file is the
      // same document only if its content is identical.
      const sourceKey = `invoice:${hashOf([normalizedTaxId(body.supplier.taxId), body.number, body.issueDate, body.documentType])}`;
      const content = canonical(body);
      const [existing] = await tx
        .select()
        .from(documents)
        .where(and(eq(documents.companyId, actor.companyId), eq(documents.sourceKey, sourceKey)));
      if (existing) {
        requireCondition(
          existing.body === content,
          'DOCUMENT_CONFLICT',
          'Există deja un document cu același furnizor, număr și dată, dar cu alt conținut.',
          409,
          { documentId: existing.id },
        );
        return view(existing);
      }
      const partyId = await partyFor(tx, actor, sale ? body.customer : body.supplier);
      const [row] = await tx
        .insert(documents)
        .values({
          id: randomUUID(),
          companyId: actor.companyId,
          kind,
          schema: body.parserVersion,
          body: content,
          bodyHash: hashOf(body),
          sourceKey,
          evidenceId: source.id,
          origin: 'upload',
          docDate: body.issueDate,
          partyId,
          currency: body.currency,
          number: body.number,
          createdBy: actor.actorId,
        })
        .returning();
      return view(row!);
    });
  }

  list(actor: Actor, input: { kinds?: string[] }) {
    return this.commands.read(actor, 'documents.list', async (tx) =>
      (
        await tx
          .select()
          .from(documents)
          .where(
            and(
              eq(documents.companyId, actor.companyId),
              input.kinds?.length ? inArray(documents.kind, input.kinds) : undefined,
            ),
          )
          .orderBy(asc(documents.docDate), asc(documents.id))
      ).map(view),
    );
  }
}
