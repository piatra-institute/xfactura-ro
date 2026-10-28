import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Database } from '../packages/xfactura-api/source/accounting/db';
import { migrate } from '../packages/xfactura-api/source/accounting/migrate';
import { createAuth } from '../packages/xfactura-api/source/accounting/auth';

const directory = await mkdtemp(join(tmpdir(), 'xfactura-browser-'));
const databaseUrl = `file:${join(directory, 'books.db')}`;
const authSecret = randomBytes(32).toString('hex');
const publicUrl = 'http://localhost:3100';
const db = new Database(databaseUrl);
try {
  await migrate(db);
  const auth = createAuth(db, { publicUrl, authSecret }, true);
  for (const name of [
    'desktop',
    'mobile',
    'corrections-desktop',
    'corrections-mobile',
    'agents-desktop',
    'agents-mobile',
    'ledger-desktop',
    'ledger-mobile',
    'settlements-desktop',
    'settlements-mobile',
    'accruals-desktop',
    'accruals-mobile',
    'unbilled-sales-desktop',
    'unbilled-sales-mobile',
    'accrual-adjustments-desktop',
    'accrual-adjustments-mobile',
    'deferrals-desktop',
    'deferrals-mobile',
  ]) {
    await auth.api.signUpEmail({
      body: { email: `${name}@example.test`, name, password: 'synthetic-browser-password' },
    });
  }
} finally {
  await db.close();
}

const tsconfig = join(directory, 'tsconfig.json');
await writeFile(
  tsconfig,
  JSON.stringify({
    extends: resolve('packages/xfactura-web/tsconfig.json'),
    include: [resolve('packages/xfactura-web/**/*.ts'), resolve('packages/xfactura-web/**/*.tsx')],
  }),
);
const shared = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  DATABASE_AUTH_TOKEN: '',
  STRIPE_SECRET_KEY: '',
  ACCOUNTING_AUTH_SECRET: authSecret,
  ACCOUNTING_PUBLIC_URL: publicUrl,
  ACCOUNTING_OBJECT_DIR: join(directory, 'objects'),
  NEXT_PUBLIC_GOOGLE_LOGIN: '',
  NEXT_PUBLIC_STRIPE_KEY: '',
  NEXT_PUBLIC_API_DOMAIN: '',
  NEXT_PUBLIC_AI_DOMAIN: '',
  NEXT_PUBLIC_X_DOMAIN: '',
};
const children = [
  Bun.spawn(['bun', 'packages/xfactura-api/source/index.ts'], {
    env: { ...shared, PORT: '8189' },
    stdout: 'inherit',
    stderr: 'inherit',
  }),
  Bun.spawn(['bun', 'packages/xfactura-api/source/accounting/worker.ts'], {
    env: shared,
    stdout: 'inherit',
    stderr: 'inherit',
  }),
  Bun.spawn(['bun', 'run', '--cwd', 'packages/xfactura-web', 'dev', '--port', '3100'], {
    env: {
      ...shared,
      PORT: '3100',
      ACCOUNTING_API_URL: 'http://127.0.0.1:8189',
      NEXT_DIST_DIR: '.next-e2e',
      NEXT_TSCONFIG_PATH: tsconfig,
    },
    stdout: 'inherit',
    stderr: 'inherit',
  }),
];
const stop = () => children.forEach((child) => child.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  await Promise.race(children.map((child) => child.exited));
} finally {
  stop();
  await Promise.all(children.map((child) => child.exited));
  await rm(directory, { recursive: true, force: true });
}
