import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ParameterRegister } from 'xfactura-core/rules';
import type { DeclarationValidator } from '../../../xfactura-api/source/engine/adapters/declaration-validator';
import { Database } from '../../../xfactura-api/source/engine/db/database';
import { user } from '../../../xfactura-api/source/engine/db/schema';
import { LocalObjectStore } from '../../../xfactura-api/source/engine/adapters/object-store';
import { Engine } from '../../../xfactura-api/source/engine/engine';
import { migrationJournal } from '../treatments/journal';

/** Version 4 UUIDs derived from a seed and a counter: the same seed gives the same sequence,
 * so a run gives the same records the same identifiers. */
export function seededIds(seed: string): () => string {
  let n = 0;
  return () => {
    n += 1;
    const hex = createHash('sha256').update(`${seed}/${n}`).digest('hex');
    const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
}

export type ReplayEngine = {
  engine: Engine;
  db: Database;
  /** The engine's files: the evidence recorded and the returns it writes, by hash. */
  objects: LocalObjectStore;
  /** The person who owns the replayed books, proposes, approves and posts. */
  person: string;
  ids: () => string;
  close(): Promise<void>;
};

/**
 * A private engine on a new database in `directory`, with `migration.journal` injected. Its rule
 * register is empty unless one is given: the journal replay reads no legal parameter, while the
 * return replay runs with the register the engine uses in production. ANAF's validator, when
 * given, checks every return the engine prepares. Its clock is fixed and its identifiers seeded,
 * so the same inputs give the same records; audit `created_at` columns keep the database's wall
 * time.
 */
export async function openReplayEngine(
  directory: string,
  options: {
    secret: string;
    seed: string;
    clock: number;
    register?: ParameterRegister;
    declarationValidator?: DeclarationValidator;
  },
): Promise<ReplayEngine> {
  const db = new Database(`file:${join(directory, 'books.db')}`);
  await db.migrate();
  const ids = seededIds(options.seed);
  const objects = new LocalObjectStore(join(directory, 'objects'));
  const engine = new Engine(db, objects, options.secret, {
    treatments: [migrationJournal],
    register: options.register ?? new ParameterRegister([], []),
    ...(options.declarationValidator ? { declarationValidator: options.declarationValidator } : {}),
    clock: () => options.clock,
    ids,
  });
  const person = ids();
  const now = new Date(options.clock);
  await db.write((tx) =>
    tx.insert(user).values({
      id: person,
      name: 'Proprietar',
      email: 'proprietar@replay.invalid',
      createdAt: now,
      updatedAt: now,
    }),
  );
  return { engine, db, objects, person, ids, close: () => db.close() };
}
