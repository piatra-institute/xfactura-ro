import { randomUUID } from 'node:crypto';
import type { Transaction } from './db';
import { and, eq } from 'drizzle-orm';
import { idSchema, requireCondition } from './domain';
import { Commands, principal, type Actor } from './commands';
import { audit, evidence } from './schema';
import { sha256, type ObjectStore } from './object-store';

export class Documents {
  constructor(
    private readonly runner: Commands,
    private readonly objects: ObjectStore,
  ) {}

  async record(
    actor: Actor,
    key: string,
    input: { filename: string; mediaType: string; bytes: Uint8Array },
  ) {
    requireCondition(
      input.filename.length > 0 &&
        input.filename.length <= 240 &&
        !/[\x00-\x1f]/.test(input.filename),
      'FILENAME',
      'Numele documentului nu este valid.',
    );
    requireCondition(input.mediaType.length <= 150, 'MEDIA_TYPE', 'Tip de fișier invalid.');
    const hash = sha256(input.bytes);
    return this.runner.run(
      actor,
      key,
      'evidence.record',
      { hash, filename: input.filename, mediaType: input.mediaType },
      'write',
      async (tx) => {
        return retainEvidence(tx, actor, this.objects, input, hash);
      },
    );
  }

  async read(actor: Actor, evidenceId: string) {
    idSchema.parse(evidenceId);
    return this.runner.read(
      actor,
      async (tx) => {
        const [record] = await tx
          .select()
          .from(evidence)
          .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, evidenceId)));
        requireCondition(record, 'NOT_FOUND', 'Documentul nu este disponibil.', 404);
        return { record, bytes: await this.objects.get(actor.companyId, record.hash) };
      },
      'evidence.read',
    );
  }
}

/** Retain source bytes in the caller's transaction, including archive-member provenance. */
export async function retainEvidence(
  tx: Transaction,
  actor: Actor,
  objects: ObjectStore,
  input: { filename: string; mediaType: string; bytes: Uint8Array },
  hash = sha256(input.bytes),
  origin:
    string | { kind: 'archive_member'; archiveEvidenceId: string; path: string } = 'manual_upload',
) {
  await tx.insert(audit).values({
    ...actor,
    action: 'evidence.received',
    body: {
      hash,
      filename: input.filename,
      mediaType: input.mediaType,
      origin,
      principal: principal(actor),
    },
  });
  const [previous] = await tx
    .select()
    .from(evidence)
    .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.hash, hash)));
  if (previous) return previous;
  await objects.put(actor.companyId, input.bytes);
  const [result] = await tx
    .insert(evidence)
    .values({
      id: randomUUID(),
      companyId: actor.companyId,
      hash,
      filename: input.filename,
      mediaType: input.mediaType || 'application/octet-stream',
      size: input.bytes.length,
      createdBy: actor.actorId,
    })
    .returning();
  return result;
}
