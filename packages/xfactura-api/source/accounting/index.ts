import { getRequestListener } from '@hono/node-server';
import type { Express } from 'express';
import { config } from './config';
import { Database } from './db';
import { LocalObjectStore } from './object-store';
import { Accounting } from './application';
import { createApp } from './app';

export async function mountAccounting(server: Express) {
  const options = config(),
    db = new Database(options.databaseUrl, options.authToken);
  await db.initialize();
  const { app } = createApp(
    new Accounting(db, new LocalObjectStore(options.objectDir), options.authSecret),
    options,
  );
  const listener = getRequestListener(app.fetch);
  server.all('/api/accounting/*', (request, response) => listener(request, response));
  return db;
}
