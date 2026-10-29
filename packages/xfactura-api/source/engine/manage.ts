import { config } from './config';
import { Database } from './db/database';
import { createAuth } from './http/auth';

const options = config(),
  db = new Database(options.databaseUrl, options.authToken);
try {
  await db.initialize();
  if (process.argv[2] !== 'create-user')
    throw new Error(
      'Usage: bun run account:create (ACCOUNT_EMAIL, ACCOUNT_NAME, ACCOUNT_PASSWORD supplied through environment)',
    );
  const email = process.env.ACCOUNT_EMAIL,
    name = process.env.ACCOUNT_NAME,
    password = process.env.ACCOUNT_PASSWORD;
  if (!email || !name || !password || password.length < 12)
    throw new Error(
      'Provide ACCOUNT_EMAIL, ACCOUNT_NAME and ACCOUNT_PASSWORD (12+ characters). No public signup is enabled.',
    );
  const auth = createAuth(db, options, true);
  await auth.api.signUpEmail({ body: { email, name, password } });
  console.log('Standalone account created. Use /contabilitate to sign in.');
} finally {
  await db.close();
}
