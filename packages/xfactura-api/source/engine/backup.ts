import { mkdir, readFile, writeFile, copyFile, chmod, stat, rename, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { Database } from './db/database';
import { evidence, jobs } from './db/schema';
import { LocalObjectStore, sha256 } from './adapters/object-store';
import { requireCondition } from 'xfactura-core/errors';

const manifestSchema = z.object({
  format: z.literal('xfactura-backup-v1'),
  databaseHash: z.string().regex(/^[a-f0-9]{64}$/),
  objects: z.array(z.object({ companyId: z.uuid(), hash: z.string().regex(/^[a-f0-9]{64}$/) })),
});

async function requireNewDirectory(path: string) {
  try {
    await stat(path);
    throw new Error('Destination already exists; backup and restore never overwrite it.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function backup(db: Database, objects: LocalObjectStore, destination: string) {
  requireCondition(
    db.url.startsWith('file:'),
    'LOCAL_BACKUP_ONLY',
    'This command backs up local SQLite. Turso requires its provider backup/export procedure.',
  );
  const directory = resolve(destination);
  await requireNewDirectory(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const databaseFile = join(directory, 'xfactura.db');

  // VACUUM INTO is SQLite's consistent online snapshot operation, not business-query SQL.
  await db.client.execute({ sql: 'VACUUM INTO ?', args: [databaseFile] });
  await chmod(databaseFile, 0o600);
  const snapshot = new Database(`file:${databaseFile}`);
  const target = new LocalObjectStore(join(directory, 'objects'));
  const entries = new Map<string, { companyId: string; hash: string }>();
  try {
    const sources = await snapshot.orm.select().from(evidence);
    for (const source of sources)
      entries.set(`${source.companyId}/${source.hash}`, {
        companyId: source.companyId,
        hash: source.hash,
      });
    // A pre-upgrade backup must not require columns introduced by a later schema.
    const exports = await snapshot.orm
      .select({ companyId: jobs.companyId, result: jobs.result })
      .from(jobs)
      .where(eq(jobs.status, 'done'));
    for (const job of exports) {
      const result = job.result as { hash?: string } | null;
      if (result?.hash)
        entries.set(`${job.companyId}/${result.hash}`, {
          companyId: job.companyId,
          hash: result.hash,
        });
    }
    for (const entry of entries.values())
      await target.put(
        entry.companyId,
        await objects.get(entry.companyId, entry.hash),
        96 * 1024 * 1024,
      );
  } finally {
    await snapshot.close();
  }
  const manifest = {
    format: 'xfactura-backup-v1',
    databaseHash: sha256(await readFile(databaseFile)),
    objects: [...entries.values()],
  };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), {
    mode: 0o600,
  });
  return { directory, objects: entries.size, databaseHash: manifest.databaseHash };
}

export async function restore(source: string, destination: string) {
  const directory = resolve(destination),
    origin = resolve(source);
  await requireNewDirectory(directory);
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(origin, 'manifest.json'), 'utf8')),
  );
  requireCondition(
    sha256(await readFile(join(origin, 'xfactura.db'))) === manifest.databaseHash,
    'BACKUP_INTEGRITY',
    'Backup database checksum does not match.',
  );
  const staging = `${directory}.restore-${randomUUID()}`;
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    await copyFile(join(origin, 'xfactura.db'), join(staging, 'xfactura.db'));
    await chmod(join(staging, 'xfactura.db'), 0o600);
    const originals = new LocalObjectStore(join(origin, 'objects')),
      target = new LocalObjectStore(join(staging, 'objects'));
    for (const entry of manifest.objects)
      await target.put(
        entry.companyId,
        await originals.get(entry.companyId, entry.hash),
        96 * 1024 * 1024,
      );
    const db = new Database(`file:${join(staging, 'xfactura.db')}`);
    try {
      const integrity = await db.client.execute('PRAGMA integrity_check');
      const foreignKeys = await db.client.execute('PRAGMA foreign_key_check');
      requireCondition(
        integrity.rows[0]?.integrity_check === 'ok' && foreignKeys.rows.length === 0,
        'BACKUP_INTEGRITY',
        'The restored database failed its integrity checks.',
      );
    } finally {
      await db.close();
    }
    await rename(staging, directory);
    return {
      directory,
      databaseUrl: `file:${join(directory, 'xfactura.db')}`,
      objectDir: join(directory, 'objects'),
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  const [operation, first, second] = process.argv.slice(2);
  if (operation === 'restore' && first && second) console.log(await restore(first, second));
  else if (operation === 'backup' && first) {
    const { config } = await import('./config');
    const options = config(),
      db = new Database(options.databaseUrl, options.authToken);
    try {
      console.log(await backup(db, new LocalObjectStore(options.objectDir), first));
    } finally {
      await db.close();
    }
  } else
    throw new Error(
      'Usage: bun run backup <new-directory> or bun run restore <backup-directory> <new-directory>',
    );
}
