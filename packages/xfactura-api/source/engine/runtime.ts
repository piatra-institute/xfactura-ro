import { config } from './config';
import { Database } from './db/database';
import { LocalObjectStore } from './adapters/object-store';
import { Engine } from './engine';
import { AnafKits, DukIntegrator, saftKitId } from './adapters/declaration-validator';
import { AnafTaxpayers } from './adapters/anaf-taxpayers';

/**
 * The engine as configured for this installation: its database, object store, ANAF's validator
 * kits, the ANAF OAuth application and ANAF's public registers. The API and the worker both build
 * it here, so queued work runs with exactly the adapters requests have.
 */
export async function createEngine(options: ReturnType<typeof config> = config()) {
  const db = new Database(options.databaseUrl, options.authToken);
  await db.initialize();
  const objects = new LocalObjectStore(options.objectDir);
  // D406 runs on ANAF's SAF-T kit, every other declaration on the general one.
  const kits = {
    ...(DukIntegrator.available(options.anafValidatorDir)
      ? { general: new DukIntegrator(options.anafValidatorDir) }
      : {}),
    ...(DukIntegrator.available(options.anafSaftValidatorDir)
      ? { saft: new DukIntegrator(options.anafSaftValidatorDir, saftKitId) }
      : {}),
  };
  const engine = new Engine(db, objects, options.authSecret, {
    ...(kits.general || kits.saft ? { declarationValidator: new AnafKits(kits) } : {}),
    ...(options.anaf ? { anaf: options.anaf } : {}),
    // ANAF's public registers of taxpayers need no credentials.
    taxpayers: new AnafTaxpayers(),
  });
  return { db, objects, engine, options };
}
