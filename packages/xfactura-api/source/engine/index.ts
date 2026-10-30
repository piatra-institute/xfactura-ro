import { getRequestListener } from '@hono/node-server';
import type { Express } from 'express';
import { config } from './config';
import { Database } from './db/database';
import { LocalObjectStore } from './adapters/object-store';
import { Engine } from './engine';
import { AnafKits, DukIntegrator, saftKitId } from './adapters/declaration-validator';
import { AnafTaxpayers } from './adapters/anaf-taxpayers';
import { createApp } from './http/app';

/** Mounts the accounting engine's HTTP interface in the existing Express server. */
export async function mountAccounting(server: Express) {
  const options = config();
  const db = new Database(options.databaseUrl, options.authToken);
  await db.initialize();
  // D406 runs on ANAF's SAF-T kit, every other declaration on the general one.
  const kits = {
    ...(DukIntegrator.available(options.anafValidatorDir)
      ? { general: new DukIntegrator(options.anafValidatorDir) }
      : {}),
    ...(DukIntegrator.available(options.anafSaftValidatorDir)
      ? { saft: new DukIntegrator(options.anafSaftValidatorDir, saftKitId) }
      : {}),
  };
  const { app } = createApp(
    new Engine(db, new LocalObjectStore(options.objectDir), options.authSecret, {
      ...(kits.general || kits.saft ? { declarationValidator: new AnafKits(kits) } : {}),
      ...(options.anaf ? { anaf: options.anaf } : {}),
      // ANAF's public registers of taxpayers need no credentials.
      taxpayers: new AnafTaxpayers(),
    }),
    options,
  );
  const listener = getRequestListener(app.fetch);
  server.all('/api/accounting/*', (request, response) => listener(request, response));
  return db;
}
