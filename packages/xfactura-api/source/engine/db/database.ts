import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { LibSQLSession, LibSQLTransaction } from 'drizzle-orm/libsql/session';
import { migrate as migrateDrizzle } from 'drizzle-orm/libsql/migrator';
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema';
import { ensureInvariants } from './invariants';

export class Database {
  readonly client;
  readonly authClient;
  readonly orm;
  readonly authOrm;
  private writer: Promise<void> = Promise.resolve();

  constructor(
    readonly url: string,
    authToken?: string,
  ) {
    if (url.startsWith('file:')) mkdirSync(dirname(url.slice(5)), { recursive: true, mode: 0o700 });
    this.client = createClient({ url, authToken, intMode: 'bigint' });
    this.authClient = createClient({ url, authToken, intMode: 'number' });
    this.orm = drizzle(this.client, { schema });
    this.authOrm = drizzle(this.authClient, { schema: schema.authSchema });
  }

  async initialize() {
    for (const client of [this.client, this.authClient]) {
      await client.execute('PRAGMA foreign_keys=ON');
      if (this.url.startsWith('file:')) {
        await client.execute('PRAGMA journal_mode=WAL');
        await client.execute('PRAGMA synchronous=FULL');
        await client.execute('PRAGMA busy_timeout=5000');
      }
    }
  }

  /** Applies generated migrations, then installs the invariants (ADR 0010). */
  async migrate() {
    await this.initialize();
    // The previous engine's books used another schema and cannot be upgraded (ADR 0012).
    const previous = await this.client.execute(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'acc_journals'",
    );
    if (previous.rows.length)
      throw new Error(
        'This database holds the previous accounting engine. Move it aside and run the migration on a new database.',
      );
    await migrateDrizzle(this.orm, {
      migrationsFolder: fileURLToPath(new URL('./migrations', import.meta.url)),
    });
    await ensureInvariants(this.client);
    const violations = await this.client.execute('PRAGMA foreign_key_check');
    if (violations.rows.length) throw new Error('Foreign-key violations after migration.');
  }

  async read<T>(read: (tx: Transaction) => Promise<T>) {
    // Drizzle's libSQL transaction() opens a write transaction. Bind its typed query builders to
    // an explicit libSQL read transaction so concurrent reads share a coherent snapshot.
    const transaction = await this.client.transaction('read');
    const dialect = new SQLiteAsyncDialect();
    const session = new LibSQLSession<typeof schema, ExtractTablesWithRelations<typeof schema>>(
      this.client,
      dialect,
      undefined,
      {},
      transaction,
    );
    const tx = new LibSQLTransaction('async', dialect, session, undefined);
    try {
      const result = await read(tx);
      await transaction.commit();
      return result;
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      transaction.close();
    }
  }

  write<T>(execute: (tx: Transaction) => Promise<T>): Promise<T> {
    // libSQL's local adapter opens another connection for each transaction. Queue this
    // process's writes so a second BEGIN cannot block the event loop while the first waits.
    const result = this.writer.then(() => this.orm.transaction(execute));
    this.writer = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async close() {
    this.client.close();
    this.authClient.close();
  }
}
export type Transaction = Parameters<Parameters<Database['orm']['transaction']>[0]>[0];
