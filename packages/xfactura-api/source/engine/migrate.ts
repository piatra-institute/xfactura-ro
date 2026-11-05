import { config } from './config';
import { Database } from './db/database';

const options = config();
const db = new Database(options.databaseUrl, options.authToken);
try {
  await db.migrate({ secret: options.authSecret });
  console.log('Accounting migrations and database invariants applied.');
} finally {
  await db.close();
}
