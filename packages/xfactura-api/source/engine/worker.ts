import { config } from './config';
import { Database } from './db/database';
import { LocalObjectStore } from './adapters/object-store';
import { Engine } from './engine';
import { Exports } from './modules/exports';

const options = config();
const db = new Database(options.databaseUrl, options.authToken);
const objects = new LocalObjectStore(options.objectDir);
await db.initialize();
const engine = new Engine(db, objects, options.authSecret);
let stop = false;
process.on('SIGINT', () => (stop = true));
process.on('SIGTERM', () => (stop = true));
console.log('Accounting export worker ready.');
while (!stop) {
  try {
    if (!(await Exports.runOne(db, engine.commands, objects))) await Bun.sleep(1000);
  } catch {
    console.error('Export queue unavailable; retrying.');
    await Bun.sleep(3000);
  }
}
await db.close();
