// Imports a real invoicer export into a fresh, private engine database through
// `invoices.importInvoicer`, and writes the per-record outcomes under .private/:
//   bun scripts/pilot/import.ts <export.json> .private/pilot/engine
// The company is the export's default seller. Nothing here is committed or sent anywhere.
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Database } from '../../packages/xfactura-api/source/engine/db/database';
import { user } from '../../packages/xfactura-api/source/engine/db/schema';
import { LocalObjectStore } from '../../packages/xfactura-api/source/engine/adapters/object-store';
import { Engine } from '../../packages/xfactura-api/source/engine/engine';

const [exportPath, directory] = process.argv.slice(2);
if (!exportPath || !directory) throw new Error('usage: import.ts <export.json> <directory>');
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });

const bytes = new Uint8Array(await Bun.file(exportPath).arrayBuffer());
const exported = JSON.parse(new TextDecoder().decode(bytes)) as { defaultSeller: string };
const db = new Database(`file:${path.join(directory, 'books.db')}`);
await db.migrate();
const engine = new Engine(
  db,
  new LocalObjectStore(path.join(directory, 'objects')),
  randomUUID().repeat(2),
);
const ownerId = randomUUID();
const now = new Date();
await db.write((tx) =>
  tx.insert(user).values({
    id: ownerId,
    name: 'pilot',
    email: 'pilot@example.test',
    createdAt: now,
    updatedAt: now,
  }),
);
const company = await engine.companies.create(ownerId, randomUUID(), {
  name: 'Pilot',
  cui: exported.defaultSeller.replace(/^RO/i, ''),
  year: 2026,
});
const owner = { actorId: ownerId, companyId: company.id };
const { id: evidenceId } = (await engine.invoke(owner, 'evidence.record', randomUUID(), {
  filename: path.basename(exportPath),
  mediaType: 'application/json',
  base64: Buffer.from(bytes).toString('base64'),
})) as { id: string };
const report = (await engine.invoke(owner, 'invoices.importInvoicer', randomUUID(), {
  evidenceId,
})) as {
  records: number;
  states: Record<string, number>;
  outcomes: { state: string; code?: string; notes: string[] }[];
};
await writeFile(path.join(directory, 'import-report.json'), JSON.stringify(report, null, 2) + '\n');
const codes: Record<string, number> = {};
for (const outcome of report.outcomes)
  if (outcome.code) codes[outcome.code] = (codes[outcome.code] ?? 0) + 1;
const parties = (await engine.invoke(owner, 'parties.list', randomUUID(), {})) as {
  kind: string;
}[];
console.log(
  JSON.stringify(
    {
      records: report.records,
      states: report.states,
      codes,
      parties: Object.fromEntries(
        Object.entries(Object.groupBy(parties, (item) => item.kind)).map(([kind, list]) => [
          kind,
          list!.length,
        ]),
      ),
    },
    null,
    2,
  ),
);
await db.close();
