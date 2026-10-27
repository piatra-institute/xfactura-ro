import { betterAuth } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { authSchema } from './schema';
import type { Database } from './db';

export function createAuth(
  db: Database,
  options: { publicUrl: string; authSecret: string },
  provisioning = false,
) {
  return betterAuth({
    database: drizzleAdapter(db.authOrm, { provider: 'sqlite', schema: authSchema }),
    baseURL: options.publicUrl,
    basePath: '/api/accounting/auth',
    secret: options.authSecret,
    trustedOrigins: [new URL(options.publicUrl).origin],
    emailAndPassword: { enabled: true, disableSignUp: !provisioning, minPasswordLength: 12 },
    advanced: { cookiePrefix: 'xfactura_accounting' },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: { '/sign-in/email': { window: 60, max: 10 } },
    },
  });
}
