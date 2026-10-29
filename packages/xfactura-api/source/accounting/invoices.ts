import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import { Commands, type Actor } from './commands';
import type { Transaction } from './db';
import { canonical, creditNoteInput, idSchema, requireCondition } from './domain';
import { companies, evidence, invoiceDocuments } from './schema';
import type { ObjectStore } from './object-store';
import { sha256 } from './object-store';
import { parseInvoiceXml, type InvoiceDocument } from './invoice-document';
import { generalBody, retainGeneralProposal } from './general-ledger';
import { interpretInvoice, invoicePostingInput } from './invoice-postings';
import { pageInput } from './capability-contracts';
import { interpretCreditNote } from './invoice-credits';

export const invoiceImportInput = z.object({ evidenceId: idSchema }).strict();
export const invoicePage = pageInput
  .extend({ direction: z.enum(['purchase', 'sale']).optional() })
  .strict();
const cui = (value: string) => value.trim().replace(/^RO/i, '');

/** The XML and archive paths share invoice identity, conflict detection and persistence. */
export async function inspectInvoice(
  tx: Transaction,
  actor: Actor,
  parsed: InvoiceDocument,
  sourceHash?: string,
) {
  const [company] = await tx.select().from(companies).where(eq(companies.id, actor.companyId));
  const sale = parsed.supplier.country === 'RO' && cui(parsed.supplier.taxId) === company.cui;
  const purchase = parsed.customer.country === 'RO' && cui(parsed.customer.taxId) === company.cui;
  requireCondition(
    sale !== purchase,
    'INVOICE_COMPANY',
    'Factura trebuie să identifice compania ca emitent sau beneficiar.',
  );
  const direction = sale ? ('sale' as const) : ('purchase' as const);
  const sourceKey = sha256(
    canonical([
      direction,
      parsed.documentType,
      parsed.supplier.country,
      cui(parsed.supplier.taxId),
      parsed.number,
      parsed.issueDate.slice(0, 4),
    ]),
  );
  const hash = sha256(canonical(parsed));
  const [duplicate] = await tx
    .select()
    .from(invoiceDocuments)
    .where(
      and(
        eq(invoiceDocuments.companyId, actor.companyId),
        eq(invoiceDocuments.sourceKey, sourceKey),
      ),
    );
  let sameLegacySource = false;
  if (
    duplicate &&
    duplicate.hash !== hash &&
    parsed.parserVersion === 'ubl-invoice-3' &&
    duplicate.body.parserVersion !== 'ubl-invoice-3' &&
    sourceHash
  ) {
    const { documentAdjustments: _adjustments, ...previousShape } = parsed;
    const [source] = await tx
      .select({ hash: evidence.hash })
      .from(evidence)
      .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, duplicate.evidenceId)));
    sameLegacySource =
      source?.hash === sourceHash &&
      sha256(canonical({ ...previousShape, parserVersion: duplicate.body.parserVersion })) ===
        duplicate.hash;
  }
  requireCondition(
    !duplicate || duplicate.hash === hash || sameLegacySource,
    'INVOICE_SOURCE_CONFLICT',
    'Aceeași factură are conținut diferit. Verificați ambele surse.',
    409,
  );
  return { direction, sourceKey, hash, duplicate };
}
export async function retainInvoice(
  tx: Transaction,
  actor: Actor,
  evidenceId: string,
  parsed: InvoiceDocument,
) {
  const [source] = await tx
    .select({ hash: evidence.hash })
    .from(evidence)
    .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, evidenceId)));
  requireCondition(source, 'NOT_FOUND', 'Documentul original nu este disponibil.', 404);
  const { direction, sourceKey, hash, duplicate } = await inspectInvoice(
    tx,
    actor,
    parsed,
    source.hash,
  );
  if (duplicate) return duplicate;
  const [invoice] = await tx
    .insert(invoiceDocuments)
    .values({
      id: randomUUID(),
      companyId: actor.companyId,
      evidenceId,
      direction,
      sourceKey,
      hash,
      body: parsed,
      createdBy: actor.actorId,
    })
    .returning();
  return invoice;
}

export class Invoices {
  constructor(
    private readonly runner: Commands,
    private readonly objects: ObjectStore,
  ) {}

  async import(actor: Actor, key: string, input: unknown) {
    const body = invoiceImportInput.parse(input);
    const parsed = await this.runner.read(
      actor,
      async (tx) => {
        const [source] = await tx
          .select()
          .from(evidence)
          .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, body.evidenceId)));
        requireCondition(source, 'NOT_FOUND', 'Documentul nu este disponibil.', 404);
        return parseInvoiceXml(await this.objects.get(actor.companyId, source.hash));
      },
      'invoices.import',
    );
    return this.runner.run(actor, key, 'invoices.import', body, 'write', async (tx) => {
      return retainInvoice(tx, actor, body.evidenceId, parsed);
    });
  }
  list(actor: Actor, input: unknown) {
    const body = invoicePage.parse(input);
    if (body.cursor) idSchema.parse(body.cursor);
    return this.runner.read(
      actor,
      async (tx) => {
        const rows = await tx
          .select()
          .from(invoiceDocuments)
          .where(
            and(
              eq(invoiceDocuments.companyId, actor.companyId),
              body.direction ? eq(invoiceDocuments.direction, body.direction) : undefined,
              body.cursor ? gt(invoiceDocuments.id, body.cursor) : undefined,
            ),
          )
          .orderBy(asc(invoiceDocuments.id))
          .limit(body.limit + 1);
        return {
          items: rows.slice(0, body.limit),
          nextCursor: rows.length > body.limit ? rows[body.limit - 1].id : null,
        };
      },
      'invoices.list',
    );
  }
  get(actor: Actor, id: string) {
    idSchema.parse(id);
    return this.runner.read(
      actor,
      async (tx) => {
        const [row] = await tx
          .select()
          .from(invoiceDocuments)
          .where(and(eq(invoiceDocuments.companyId, actor.companyId), eq(invoiceDocuments.id, id)));
        requireCondition(row, 'NOT_FOUND', 'Factura nu este disponibilă.', 404);
        return row;
      },
      'invoices.get',
    );
  }
  async propose(actor: Actor, key: string, input: unknown) {
    const body = invoicePostingInput.parse(input);
    return this.runner.run(actor, key, 'invoices.propose', body, 'write', async (tx) => {
      const result = await interpretInvoice(tx, actor, body);
      return retainGeneralProposal(
        tx,
        actor,
        generalBody({
          financialYearId: body.financialYearId,
          evidenceId: result.invoice.evidenceId,
          date: body.recognitionDate,
          purpose: result.invoice.direction,
          description: `${result.invoice.body.number} · ${result.invoice.direction === 'sale' ? result.invoice.body.customer.name : result.invoice.body.supplier.name}`,
          sourceReference: `invoice:${result.invoice.id}`,
          lines: result.lines,
          invoice: result.treatment,
        }),
      );
    });
  }
  async proposeCreditNote(
    actor: Actor,
    key: string,
    input: unknown,
    revision?: { id: string; version: number },
  ) {
    const body = creditNoteInput.parse(input);
    return this.runner.run(
      actor,
      key,
      revision ? 'invoices.reviseCreditNote' : 'invoices.proposeCreditNote',
      { body, revision: revision ?? null },
      'write',
      async (tx) => {
        const result = await interpretCreditNote(tx, actor, body);
        return retainGeneralProposal(
          tx,
          actor,
          generalBody({
            financialYearId: body.financialYearId,
            evidenceId: result.invoice.evidenceId,
            date: body.recognitionDate,
            purpose: result.invoice.direction,
            description: `${body.kind === 'commercial_discount' ? 'Reducere comercială' : 'Stornare'} · ${result.invoice.body.number} · ${result.original.invoice.body.number}`,
            sourceReference: `invoice:${result.invoice.id}`,
            lines: result.lines,
            invoice: result.treatment,
          }),
          revision,
        );
      },
    );
  }
}
