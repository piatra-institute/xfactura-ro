import { getRequestListener } from '@hono/node-server';
import type { Express } from 'express';
import { createEngine } from './runtime';
import { createApp } from './http/app';

/** Mounts the accounting engine's HTTP interface in the existing Express server. */
export async function mountAccounting(server: Express) {
  const { db, engine, options } = await createEngine();
  const { app } = createApp(engine, options);
  const listener = getRequestListener(app.fetch);
  server.all('/api/accounting/*', (request, response) => listener(request, response));
  return db;
}
