import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function config() {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const databaseUrl =
    process.env.DATABASE_URL ?? `file:${resolve(root, '.accounting/xfactura.db')}`;
  const authSecret = process.env.ACCOUNTING_AUTH_SECRET;
  if (!authSecret || authSecret.length < 32 || authSecret.startsWith('replace-with-'))
    throw new Error(
      'ACCOUNTING_AUTH_SECRET must contain at least 32 random characters. Run bun run setup.',
    );
  const publicUrl = process.env.ACCOUNTING_PUBLIC_URL ?? 'http://localhost:3000';
  const url = new URL(publicUrl);
  if (
    process.env.NODE_ENV === 'production' &&
    url.protocol !== 'https:' &&
    url.hostname !== 'localhost'
  )
    throw new Error('Production authentication requires HTTPS.');
  return {
    databaseUrl,
    authSecret,
    publicUrl,
    mcpProxyHosts: (process.env.ACCOUNTING_MCP_PROXY_HOSTS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    authToken: process.env.DATABASE_AUTH_TOKEN,
    objectDir: resolve(process.env.ACCOUNTING_OBJECT_DIR ?? resolve(root, '.accounting/objects')),
    /** ANAF's DUKIntegrator with the declaration packages (`bun run validators:fetch`). */
    anafValidatorDir: resolve(
      process.env.ACCOUNTING_ANAF_VALIDATOR_DIR ?? resolve(root, '.validators/anaf/dist'),
    ),
  };
}
