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
    /** ANAF's SAF-T kit, the only one that validates D406 (`anaf-saft` in the validator sources). */
    anafSaftValidatorDir: resolve(
      process.env.ACCOUNTING_ANAF_SAFT_VALIDATOR_DIR ??
        resolve(root, '.validators/anaf-saft/duk_SAFT_an_luna/dist'),
    ),
    /** The application registered on ANAF's portal for OAuth; without it the SPV stays offline.
     * ANAF's test environment unless ACCOUNTING_ANAF_ENVIRONMENT is `prod`. */
    anaf:
      process.env.ACCOUNTING_ANAF_CLIENT_ID &&
      process.env.ACCOUNTING_ANAF_CLIENT_SECRET &&
      process.env.ACCOUNTING_ANAF_REDIRECT_URI
        ? {
            client: {
              clientId: process.env.ACCOUNTING_ANAF_CLIENT_ID,
              clientSecret: process.env.ACCOUNTING_ANAF_CLIENT_SECRET,
              redirectUri: process.env.ACCOUNTING_ANAF_REDIRECT_URI,
            },
            environment: (process.env.ACCOUNTING_ANAF_ENVIRONMENT === 'prod' ? 'prod' : 'test') as
              'prod' | 'test',
          }
        : null,
  };
}
