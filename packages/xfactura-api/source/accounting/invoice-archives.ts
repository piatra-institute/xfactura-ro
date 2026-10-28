import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import { Commands, authorize, commandKey, type Actor } from './commands';
import type { Transaction } from './db';
import { canonical, DomainError, idSchema, requireCondition } from './domain';
import { evidence, invoiceArchives, invoiceArchiveEntries, invoiceDocuments } from './schema';
import { sha256, type ObjectStore } from './object-store';
import { retainEvidence } from './documents';
import { inspectInvoice, retainInvoice } from './invoices';
import {
  archiveFormatVersion,
  archiveLimits,
  archiveMemberSchema,
  parseInvoiceArchive,
  type ArchiveMember,
} from './invoice-archive';
import { pageInput } from './capability-contracts';

export const archiveInput = z.object({ evidenceId: idSchema }).strict();
export const invoiceSourcesInput = pageInput.extend({ invoiceId: idSchema }).strict();
export const archiveOutput = z.object({
  evidenceId: idSchema,
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  formatVersion: z.literal(archiveFormatVersion),
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  fileCount: z.number().int().positive().max(archiveLimits.members),
  invoiceCount: z.number().int().nonnegative().max(archiveLimits.members),
  expandedBytes: z.number().int().positive().max(archiveLimits.expandedBytes),
  signatureVerification: z.literal('not_performed'),
  outcome: z.enum(['invoices_imported', 'no_invoice']),
  entries: z.array(archiveMemberSchema).min(1).max(archiveLimits.members),
  createdBy: z.string(),
  createdAt: z.string(),
});
export const invoiceSourceOutput = z.object({
  id: idSchema,
  archiveEvidenceId: idSchema,
  archiveFilename: z.string(),
  archiveHash: z.string(),
  manifestHash: z.string(),
  path: z.string(),
  evidenceId: idSchema,
  hash: z.string(),
  size: z.number().int(),
  signatureVerification: z.literal('not_performed'),
});
const manifestHash = (hash: string, entries: ArchiveMember[]) =>
  sha256(canonical({ archiveHash: hash, formatVersion: archiveFormatVersion, entries }));

async function readArchive(tx: Transaction, companyId: string, evidenceId: string) {
  const [row] = await tx
    .select({ archive: invoiceArchives, hash: evidence.hash })
    .from(invoiceArchives)
    .innerJoin(
      evidence,
      and(
        eq(evidence.companyId, invoiceArchives.companyId),
        eq(evidence.id, invoiceArchives.evidenceId),
      ),
    )
    .where(
      and(eq(invoiceArchives.companyId, companyId), eq(invoiceArchives.evidenceId, evidenceId)),
    );
  if (!row) return null;
  requireCondition(
    row.archive.manifestHash === manifestHash(row.hash, row.archive.manifest),
    'ARCHIVE_MANIFEST_INTEGRITY',
    'Integritatea manifestului arhivei nu poate fi confirmată.',
    500,
  );
  const { manifest, companyId: _, ...record } = row.archive;
  return archiveOutput.parse({
    ...record,
    hash: row.hash,
    entries: manifest,
    signatureVerification: 'not_performed',
    outcome: record.invoiceCount ? 'invoices_imported' : 'no_invoice',
  });
}

/** Archive parsing happens outside the write transaction; all retained references commit together. */
export class InvoiceArchives {
  constructor(
    private readonly runner: Commands,
    private readonly objects: ObjectStore,
  ) {}

  async import(actor: Actor, key: string, input: unknown) {
    commandKey(key);
    const body = archiveInput.parse(input);
    const context = await this.runner.read(
      actor,
      async (tx) => {
        await authorize(tx, actor, 'write', 'invoices.importArchive');
        const [source] = await tx
          .select()
          .from(evidence)
          .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, body.evidenceId)));
        requireCondition(source, 'NOT_FOUND', 'Arhiva originală nu este disponibilă.', 404);
        return { source, existing: await readArchive(tx, actor.companyId, body.evidenceId) };
      },
      'invoices.importArchive',
    );
    const parsed = context.existing
      ? null
      : await parseInvoiceArchive(await this.objects.get(actor.companyId, context.source.hash));
    return this.runner.run(actor, key, 'invoices.importArchive', body, 'write', async (tx) => {
      const existing = await readArchive(tx, actor.companyId, body.evidenceId);
      if (existing) return existing;
      requireCondition(parsed, 'ARCHIVE_STATE', 'Reîncercați importul arhivei.', 409);
      // Reject every company/identity conflict before writing any extracted object.
      const identities = new Map<string, string>();
      for (const member of parsed) {
        if (!member.invoice) continue;
        try {
          const plan = await inspectInvoice(tx, actor, member.invoice),
            prior = identities.get(plan.sourceKey);
          requireCondition(
            !prior || prior === plan.hash,
            'INVOICE_SOURCE_CONFLICT',
            'Arhiva conține versiuni diferite ale aceleiași facturi.',
            409,
          );
          identities.set(plan.sourceKey, plan.hash);
        } catch (error) {
          if (error instanceof DomainError)
            throw new DomainError(error.code, `${member.path}: ${error.message}`, error.status);
          throw error;
        }
      }
      const entries: ArchiveMember[] = [];
      for (const member of parsed) {
        const hash = sha256(member.bytes),
          child = await retainEvidence(tx, actor, this.objects, member, hash, {
            kind: 'archive_member',
            archiveEvidenceId: body.evidenceId,
            path: member.path,
          });
        const invoice = member.invoice
          ? await retainInvoice(tx, actor, child.id, member.invoice)
          : null;
        entries.push(
          archiveMemberSchema.parse({
            id: randomUUID(),
            path: member.path,
            evidenceId: child.id,
            hash,
            size: member.bytes.length,
            compressedSize: member.compressedSize,
            compressionMethod: member.compressionMethod,
            crc32: member.crc32,
            kind: member.kind,
            invoiceId: invoice?.id ?? null,
          }),
        );
      }
      await tx.insert(invoiceArchives).values({
        companyId: actor.companyId,
        evidenceId: body.evidenceId,
        formatVersion: archiveFormatVersion,
        manifestHash: manifestHash(context.source.hash, entries),
        manifest: entries,
        fileCount: entries.length,
        invoiceCount: new Set(entries.flatMap((row) => (row.invoiceId ? [row.invoiceId] : [])))
          .size,
        expandedBytes: entries.reduce((sum, row) => sum + row.size, 0),
        createdBy: actor.actorId,
      });
      return (await readArchive(tx, actor.companyId, body.evidenceId))!;
    });
  }

  get(actor: Actor, input: unknown) {
    const body = archiveInput.parse(input);
    return this.runner.read(
      actor,
      async (tx) => {
        const record = await readArchive(tx, actor.companyId, body.evidenceId);
        requireCondition(record, 'NOT_FOUND', 'Arhiva importată nu este disponibilă.', 404);
        return record;
      },
      'invoices.archive',
    );
  }

  sources(actor: Actor, input: unknown) {
    const body = invoiceSourcesInput.parse(input);
    return this.runner.read(
      actor,
      async (tx) => {
        const [invoice] = await tx
          .select({ id: invoiceDocuments.id })
          .from(invoiceDocuments)
          .where(
            and(
              eq(invoiceDocuments.companyId, actor.companyId),
              eq(invoiceDocuments.id, body.invoiceId),
            ),
          );
        requireCondition(invoice, 'NOT_FOUND', 'Factura nu este disponibilă.', 404);
        const archiveEvidence = alias(evidence, 'archive_evidence'),
          memberEvidence = alias(evidence, 'member_evidence');
        const rows = await tx
          .select({
            id: invoiceArchiveEntries.id,
            archiveEvidenceId: invoiceArchiveEntries.archiveEvidenceId,
            archiveFilename: archiveEvidence.filename,
            archiveHash: archiveEvidence.hash,
            manifestHash: invoiceArchives.manifestHash,
            path: invoiceArchiveEntries.path,
            evidenceId: invoiceArchiveEntries.evidenceId,
            hash: memberEvidence.hash,
            size: memberEvidence.size,
          })
          .from(invoiceArchiveEntries)
          .innerJoin(
            invoiceArchives,
            and(
              eq(invoiceArchives.companyId, invoiceArchiveEntries.companyId),
              eq(invoiceArchives.evidenceId, invoiceArchiveEntries.archiveEvidenceId),
            ),
          )
          .innerJoin(
            archiveEvidence,
            and(
              eq(archiveEvidence.companyId, invoiceArchiveEntries.companyId),
              eq(archiveEvidence.id, invoiceArchiveEntries.archiveEvidenceId),
            ),
          )
          .innerJoin(
            memberEvidence,
            and(
              eq(memberEvidence.companyId, invoiceArchiveEntries.companyId),
              eq(memberEvidence.id, invoiceArchiveEntries.evidenceId),
            ),
          )
          .where(
            and(
              eq(invoiceArchiveEntries.companyId, actor.companyId),
              eq(invoiceArchiveEntries.invoiceId, body.invoiceId),
              body.cursor ? gt(invoiceArchiveEntries.id, body.cursor) : undefined,
            ),
          )
          .orderBy(asc(invoiceArchiveEntries.id))
          .limit(body.limit + 1);
        return {
          items: rows
            .slice(0, body.limit)
            .map((row) => ({ ...row, signatureVerification: 'not_performed' as const })),
          nextCursor: rows.length > body.limit ? rows[body.limit - 1].id : null,
        };
      },
      'invoices.sources',
    );
  }
}
