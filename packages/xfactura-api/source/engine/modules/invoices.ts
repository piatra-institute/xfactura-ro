import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { canonical, hashOf } from 'xfactura-core/hash';
import { documentIdentity, normalizedTaxId } from 'xfactura-core/documents/schemas';
import { invoiceKinds } from 'xfactura-core/ro/treatments/invoices';
import { parseInvoiceXml, type InvoiceDocument } from 'xfactura-core/ubl/invoice-document';
import type { Transaction } from '../db/database';
import { companies, documents, evidence } from '../db/schema';
import type { ObjectStore } from '../adapters/object-store';
import type { Actor, Commands, Ids } from '../kernel/commands';
import { joinIdentityGroup } from '../kernel/sources';
import { documentViewOf, partyFor } from './documents';

export const importInput = z.object({ evidenceId: z.uuid() }).strict();

/**
 * Records an e-Factura invoice or credit note from its XML, from ANAF's SPV (`spv`) or uploaded
 * (`upload`). The company must be its supplier or its customer. One document per supplier,
 * number, date and type: the same invoice from another file is the same document if its content
 * is identical, and a conflict otherwise. A copy read earlier from a PDF stays a document of its
 * own, in the same group (`joinIdentityGroup`).
 */
export async function recordInvoice(
  tx: Transaction,
  actor: Actor,
  evidenceId: string,
  bytes: Uint8Array,
  origin: 'spv' | 'upload',
  ids: Ids,
) {
  const body = parseInvoiceXml(bytes);
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
    return { row: existing, body, created: false };
  }
  const partyId = await partyFor(tx, actor, sale ? body.customer : body.supplier, ids);
  const [row] = await tx
    .insert(documents)
    .values({
      id: ids(),
      companyId: actor.companyId,
      kind,
      schema: body.parserVersion,
      body: content,
      bodyHash: hashOf(body),
      sourceKey,
      evidenceId,
      origin,
      docDate: body.issueDate,
      partyId,
      currency: body.currency,
      number: body.number,
      identityKey: documentIdentity(kind, body, company!.cui),
      authority: origin === 'spv' ? 'efactura' : 'ubl_upload',
      createdBy: actor.actorId,
    })
    .returning();
  await joinIdentityGroup(tx, actor, row!);
  return { row: row!, body, created: true };
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
      const recorded = await recordInvoice(
        tx,
        actor,
        source.id,
        await this.objects.get(actor.companyId, source.hash),
        'upload',
        this.commands.ids,
      );
      return documentViewOf(tx, recorded.row);
    });
  }
}
