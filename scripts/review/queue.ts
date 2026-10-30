// The rule review queue: parameters below `signed`, ranked by reach × risk × urgency ÷ minutes,
// and the packets to prepare next (each interpretation alone; mechanical rows by act, about
// twenty a packet). Reach and risk come from the catalogue's annotations and minutes from the
// specs (packages/xfactura-core/src/ro/reviews); urgency from the next deadline of the returns
// that use the key, by the obligations calendar. What is missing is listed, never guessed.
//   bun scripts/review/queue.ts [--date YYYY-MM-DD] [--limit 10]
import { parseArgs } from 'node:util';
import {
  reviewContext,
  reviewQueue,
  type NextDeadline,
} from '../../packages/xfactura-core/src/ro/reviews';
import { isLocalDate, type LocalDate } from '../../packages/xfactura-core/src/time';
import { today } from './packet';

const due = (deadline?: NextDeadline) =>
  deadline
    ? `${deadline.obligation} ${deadline.period.start}..${deadline.period.end} due ${deadline.due} (${deadline.days} days)`
    : 'no deadline';

if (import.meta.main) {
  const { values } = parseArgs({
    options: { date: { type: 'string' }, limit: { type: 'string' } },
  });
  if (values.date && !isLocalDate(values.date)) {
    console.error(`Not a date: ${values.date}`);
    process.exit(2);
  }
  const date = (values.date ?? today()) as LocalDate;
  const limit = Number(values.limit ?? 10);
  const context = reviewContext();
  const { rows, packets, specsToWrite, missing } = reviewQueue(context, date);
  const versions = context.register.versions.filter((version) => !version.withdrawn);
  const byStatus = Object.entries(
    versions.reduce<Record<string, number>>(
      (counts, version) => ({ ...counts, [version.status]: (counts[version.status] ?? 0) + 1 }),
      {},
    ),
  )
    .map(([status, count]) => `${count} ${status}`)
    .join(', ');
  console.log(
    `Review queue on ${date}: ${rows.length} parameters below signed (${versions.length} versions: ${byStatus}).`,
  );

  console.log(`\nNext packets to prepare (${packets.length}):`);
  packets.slice(0, limit).forEach((packet, index) => {
    console.log(
      `${index + 1}. ${packet.kind} (${packet.act}): ${packet.keys.join(', ')}; score ${packet.score.toFixed(3)}; ${packet.minutes} min; next ${due(packet.deadline)}`,
    );
    for (const key of packet.keys) {
      const row = rows.find((item) => item.key === key)!;
      console.log(
        `     ${key}: reach ${row.reach} × risk ${row.risk} × urgency ${row.urgency} ÷ ${row.minutes} min = ${row.score!.toFixed(3)}`,
      );
    }
    console.log(`     bun scripts/review/packet.ts --keys ${packet.keys.join(',')}`);
  });

  if (specsToWrite.length) {
    console.log(`\nAnnotated, but no review spec yet (${specsToWrite.length}):`);
    for (const row of specsToWrite)
      console.log(
        `  ${row.key}: reach ${row.reach} × risk ${row.risk} × urgency ${row.urgency} = ${row.weight}; ${due(row.deadline)}`,
      );
  }

  const unannotated = missing.filter(
    (row) => !(row.missing.length === 1 && row.missing[0]!.startsWith('spec')),
  );
  console.log(`\nMissing annotations, not scored (${unannotated.length}):`);
  for (const row of unannotated) console.log(`  ${row.key}: ${row.missing.join(', ')}`);
}
