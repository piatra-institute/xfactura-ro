import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { evidence } from '../db/schema';
import { idSchema, type Actor, type Commands } from '../kernel/commands';
import { sha256, type ObjectStore } from '../adapters/object-store';

export const evidenceInput = z
  .object({
    filename: z
      .string()
      .min(1)
      .max(240)
      .refine((name) => !/[\x00-\x1f]/.test(name), 'Numele documentului nu este valid.'),
    mediaType: z.string().min(1).max(150),
    base64: z.base64().max(Math.ceil((64 * 1024 * 1024 * 4) / 3)),
  })
  .strict();
export const evidenceView = z.object({
  id: z.string(),
  hash: z.string(),
  filename: z.string(),
  mediaType: z.string(),
  size: z.number(),
});

/** Original source files: immutable, content-addressed and company-scoped. */
export class Evidence {
  constructor(
    private readonly commands: Commands,
    private readonly objects: ObjectStore,
  ) {}

  async record(actor: Actor, key: string, input: z.infer<typeof evidenceInput>) {
    const bytes = Buffer.from(input.base64, 'base64');
    const hash = sha256(bytes);
    return this.commands.run(
      actor,
      key,
      'evidence.record',
      { hash, filename: input.filename, mediaType: input.mediaType },
      'write',
      async (tx) => {
        const [existing] = await tx
          .select()
          .from(evidence)
          .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.hash, hash)));
        if (existing)
          return {
            id: existing.id,
            hash,
            filename: existing.filename,
            mediaType: existing.mediaType,
            size: existing.size,
          };
        await this.objects.put(actor.companyId, bytes, 64 * 1024 * 1024);
        const id = randomUUID();
        await tx.insert(evidence).values({
          id,
          companyId: actor.companyId,
          hash,
          filename: input.filename,
          mediaType: input.mediaType,
          size: bytes.length,
          createdBy: actor.actorId,
        });
        return {
          id,
          hash,
          filename: input.filename,
          mediaType: input.mediaType,
          size: bytes.length,
        };
      },
    );
  }

  list(actor: Actor) {
    return this.commands.read(actor, 'evidence.list', (tx) =>
      tx
        .select({
          id: evidence.id,
          hash: evidence.hash,
          filename: evidence.filename,
          mediaType: evidence.mediaType,
          size: evidence.size,
        })
        .from(evidence)
        .where(eq(evidence.companyId, actor.companyId))
        .orderBy(asc(evidence.createdAt), asc(evidence.id)),
    );
  }

  async read(actor: Actor, id: string) {
    idSchema.parse(id);
    return this.commands.read(actor, 'evidence.download', async (tx) => {
      const [record] = await tx
        .select()
        .from(evidence)
        .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, id)));
      requireCondition(record, 'NOT_FOUND', 'Documentul nu este disponibil.', 404);
      return { record, bytes: await this.objects.get(actor.companyId, record.hash) };
    });
  }
}
