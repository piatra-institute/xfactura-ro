import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { Database } from '../../source/engine/db/database';
import { entries } from '../../source/engine/db/schema';
import { backup, restore } from '../../source/engine/backup';
import { LocalObjectStore } from '../../source/engine/adapters/object-store';
import { companyRecords } from '../../source/engine/modules/exports';
import { guardedTables } from '../../source/engine/db/invariants';
import { journal, scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});
async function books() {
  const s = await scenario();
  open.push(s);
  const { id: evidenceId } = await s.evidence('nota.pdf', 'Notă contabilă originală');
  await s.book(
    'ledger.general',
    journal(evidenceId, [
      { account: '628', side: 'D', amount: '123456789012.34' },
      { account: '5121', side: 'C', amount: '123456789012.34' },
    ]),
  );
  return s;
}

describe('exports', () => {
  test('an export holds every guarded company table', async () => {
    const s = await books();
    const tables = await s.engine.db.read((tx) => companyRecords(tx, s.owner.companyId));
    // Command replays are bookkeeping and reference rates are not the company's.
    expect(
      guardedTables.filter(
        (table) => !(table in tables) && table !== 'acc_commands' && !table.startsWith('ref_'),
      ),
    ).toEqual([]);
  });

  test('a reviewer exports every record and original; viewers cannot', async () => {
    const s = await books();
    expect((await s.refused(s.invoke(s.viewer, 'exports.request')))?.code).toBe('FORBIDDEN');
    const job = await s.invoke<{ id: string; status: string }>(s.reviewer, 'exports.request');
    expect(job.status).toBe('pending');
    expect(await s.engine.jobs.runOne()).toBe(true);
    const { bytes, hash } = await s.engine.exports.download(s.reviewer, job.id);
    const file = JSON.parse(bytes.toString()) as {
      tables: Record<string, { bani?: string }[]>;
      originals: { base64: string }[];
      watermark: number;
    };
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(file.watermark).toBe(1);
    // Large amounts survive as exact integer bani.
    expect(file.tables.acc_lines?.map((line) => line.bani)).toEqual([
      '12345678901234',
      '12345678901234',
    ]);
    expect(Buffer.from(file.originals[0]!.base64, 'base64').toString()).toBe(
      'Notă contabilă originală',
    );
    expect((await s.refused(s.engine.exports.download(s.viewer, job.id)))?.code).toBe('FORBIDDEN');
  });

  test('a revoked agent’s queued export fails instead of completing', async () => {
    const s = await books();
    const grant = await s.invoke<{ id: string; token: string }>(s.reviewer, 'agents.issue', {
      name: 'Arhivar',
      scopes: ['exports.request', 'exports.get'],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const agent = await s.engine.agents.authenticate(grant.token, s.company.id);
    const job = await s.invoke<{ id: string }>(agent, 'exports.request');
    await s.invoke(s.reviewer, 'agents.revoke', { id: grant.id });
    await s.engine.jobs.runOne();
    expect(
      (await s.invoke<{ status: string }>(s.reviewer, 'exports.get', { id: job.id })).status,
    ).toBe('failed');
  });
});

describe('backup and restore', () => {
  test('restore reproduces the books and the original bytes in a new location', async () => {
    const s = await books();
    const target = join(s.directory, 'backup');
    const made = await backup(s.db, s.objects, target);
    expect(made.objects).toBe(1);
    const restored = await restore(target, join(s.directory, 'restored'));
    const db = new Database(restored.databaseUrl);
    try {
      await db.migrate();
      expect(await db.orm.select({ seq: entries.seq }).from(entries)).toEqual([{ seq: 1 }]);
      const objects = new LocalObjectStore(restored.objectDir);
      const [source] = await s.list<{ hash: string }>(s.owner, 'evidence.list');
      expect((await objects.get(s.company.id, source!.hash)).toString()).toBe(
        'Notă contabilă originală',
      );
    } finally {
      await db.close();
    }
    expect(backup(s.db, s.objects, target)).rejects.toThrow();
  });
});
