import { fileURLToPath } from 'node:url';
import { migrate as migrateDrizzle } from 'drizzle-orm/libsql/migrator';
import type { Database } from './db';
import { companies } from './schema';
import { initializeCompany } from './foundation';
import { initializeTreasury } from './treasury';

export async function migrate(db: Database) {
  await db.initialize();
  await migrateDrizzle(db.orm, {
    migrationsFolder: fileURLToPath(new URL('./migrations', import.meta.url)),
  });
  for (const company of await db.orm.select().from(companies))
    await db.write(async (tx) => {
      await initializeCompany(tx, company);
      await initializeTreasury(tx, company);
    });
  const violations = await db.client.execute('PRAGMA foreign_key_check');
  if (violations.rows.length) throw new Error('Foreign-key violations after migration.');
}
if (import.meta.main) {
  const { config } = await import('./config');
  const { Database } = await import('./db');
  const options = config(),
    db = new Database(options.databaseUrl, options.authToken);
  try {
    await migrate(db);
    console.log('Drizzle accounting migrations applied.');
  } finally {
    await db.close();
  }
}
