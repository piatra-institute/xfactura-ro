import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, gte, lt, or } from 'drizzle-orm';
import { requireCondition } from './domain';
import { authorize } from './commands';
import { config } from './config';
import { Database } from './db';
import { jobs } from './schema';
import { LocalObjectStore, type ObjectStore } from './object-store';

async function claimExport(db: Database) {
  return db.write(async (tx) => {
    const now = Date.now();
    await tx
      .update(jobs)
      .set({ status: 'failed', error: 'Export interrupted repeatedly; request a new export.' })
      .where(and(eq(jobs.status, 'running'), lt(jobs.leaseUntil, now), gte(jobs.attempts, 3)));
    const [job] = await tx
      .select()
      .from(jobs)
      .where(
        and(
          lt(jobs.attempts, 3),
          or(eq(jobs.status, 'pending'), and(eq(jobs.status, 'running'), lt(jobs.leaseUntil, now))),
        ),
      )
      .orderBy(asc(jobs.createdAt))
      .limit(1);
    if (!job) return null;
    const leaseToken = randomUUID();
    await tx
      .update(jobs)
      .set({ status: 'running', attempts: job.attempts + 1, leaseToken, leaseUntil: now + 60000 })
      .where(and(eq(jobs.companyId, job.companyId), eq(jobs.id, job.id)));
    return { ...job, leaseToken };
  });
}
export async function runOneExport(db: Database, objects: ObjectStore) {
  const job = await claimExport(db);
  if (!job) return false;
  const actor = {
    actorId: job.actorId,
    companyId: job.companyId,
    agentId: job.agentId ?? undefined,
  };
  const ownedLease = () =>
    and(
      eq(jobs.companyId, job.companyId),
      eq(jobs.id, job.id),
      eq(jobs.leaseToken, job.leaseToken),
      eq(jobs.status, 'running'),
    );
  try {
    await db.read((tx) => authorize(tx, actor, 'read', 'exports.request'));
    const originals: { id: string; hash: string; filename: string; base64: string }[] = [];
    let totalBytes = 0;
    for (const source of job.payload.evidence) {
      totalBytes += source.size;
      requireCondition(
        totalBytes <= 64 * 1024 * 1024,
        'EXPORT_LIMIT',
        'Exportul depășește limita de 64 MB de documente. Contactați operatorul pentru exportul complet.',
      );
      const bytes = await objects.get(job.companyId, source.hash);
      requireCondition(
        bytes.length === source.size,
        'EVIDENCE_INTEGRITY',
        'Dimensiunea documentului diferă de manifest.',
      );
      originals.push({
        id: source.id,
        hash: source.hash,
        filename: source.filename,
        base64: bytes.toString('base64'),
      });
      const renewed = await db.orm
        .update(jobs)
        .set({ leaseUntil: Date.now() + 60000 })
        .where(and(ownedLease(), gt(jobs.leaseUntil, Date.now())))
        .returning({ id: jobs.id });
      requireCondition(renewed.length, 'LEASE_LOST', 'Exportul a fost preluat de alt proces.', 409);
    }
    const bytes = Buffer.from(JSON.stringify({ ...job.payload, originals }));
    const hash = await objects.put(job.companyId, bytes, 96 * 1024 * 1024);
    await db.write(async (tx) => {
      await authorize(tx, actor, 'read', 'exports.request');
      const saved = await tx
        .update(jobs)
        .set({ status: 'done', result: { hash, size: bytes.length }, leaseUntil: null })
        .where(and(ownedLease(), gt(jobs.leaseUntil, Date.now())))
        .returning({ id: jobs.id });
      requireCondition(saved.length, 'LEASE_LOST', 'Exportul a fost preluat de alt proces.', 409);
    });
  } catch (error) {
    await db.orm
      .update(jobs)
      .set({
        status: 'failed',
        error: error instanceof Error ? error.message.slice(0, 500) : 'Export failed',
        leaseUntil: null,
      })
      .where(ownedLease());
  }
  return true;
}
if (import.meta.main) {
  const options = config(),
    db = new Database(options.databaseUrl, options.authToken),
    objects = new LocalObjectStore(options.objectDir);
  await db.initialize();
  let stop = false;
  process.on('SIGINT', () => {
    stop = true;
  });
  process.on('SIGTERM', () => {
    stop = true;
  });
  console.log('Accounting export worker ready.');
  while (!stop) {
    try {
      if (!(await runOneExport(db, objects))) await Bun.sleep(1000);
    } catch {
      console.error('Export queue unavailable; retrying.');
      await Bun.sleep(3000);
    }
  }
  await db.close();
}
