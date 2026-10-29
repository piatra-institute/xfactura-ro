import { getRequestListener } from '@hono/node-server';
import type { Express } from 'express';
import { config } from './config';
import { Database } from './db/database';
import { LocalObjectStore } from './adapters/object-store';
import { Engine } from './engine';
import { DukIntegrator } from './adapters/declaration-validator';
import { createApp } from './http/app';

/** Mounts the accounting engine's HTTP interface in the existing Express server. */
export async function mountAccounting(server: Express) {
  const options = config();
  const db = new Database(options.databaseUrl, options.authToken);
  await db.initialize();
  const { app } = createApp(
    new Engine(db, new LocalObjectStore(options.objectDir), options.authSecret, {
      ...(DukIntegrator.available(options.anafValidatorDir)
        ? { declarationValidator: new DukIntegrator(options.anafValidatorDir) }
        : {}),
      ...(options.anaf ? { anaf: options.anaf } : {}),
    }),
    options,
  );
  const listener = getRequestListener(app.fetch);
  server.all('/api/accounting/*', (request, response) => listener(request, response));
  return db;
}
