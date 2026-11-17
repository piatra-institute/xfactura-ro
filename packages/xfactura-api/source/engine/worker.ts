import { createEngine } from './runtime';

/*
 * The accounting worker: one loop that queues due schedules, runs one job of a known kind
 * (`export`, …) and gives each consumer of the audit log (`project`: the proposals' staleness)
 * the companies it is behind on. Any number of workers may run: leases, slot-derived job ids
 * and forward-only cursors keep them from doing the same work twice.
 */
const { db, engine } = await createEngine();
let stop = false;
process.on('SIGINT', () => (stop = true));
process.on('SIGTERM', () => (stop = true));
console.log('Accounting worker ready.');
while (!stop) {
  try {
    await engine.jobs.enqueueDue();
    const ran = await engine.jobs.runOne();
    const projected = await engine.consumers.runOnce();
    if (!ran && !projected) await Bun.sleep(1000);
  } catch (error) {
    console.error(
      `Accounting worker: ${error instanceof Error ? error.message : 'unavailable'}; retrying.`,
    );
    await Bun.sleep(3000);
  }
}
await db.close();
// Under `bun --watch` a finished script keeps the process waiting for file changes.
process.exit(0);
