// The committed review records: JSON files in packages/xfactura-core/src/ro/reviews/records.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { reviewRecordSchema, type ReviewRecord } from '../../packages/xfactura-core/src/ro/reviews';
import { repositoryRoot } from './snapshots';

export const recordsDirectory = path.join(
  repositoryRoot,
  'packages/xfactura-core/src/ro/reviews/records',
);

/** Every record in the directory, validated; a malformed file throws with its name. */
export function readRecords(directory = recordsDirectory): ReviewRecord[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const result = reviewRecordSchema.safeParse(
        JSON.parse(readFileSync(path.join(directory, name), 'utf8')),
      );
      if (!result.success) throw new Error(`${name}: ${result.error.message}`);
      return result.data;
    });
}
