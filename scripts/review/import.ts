// Imports an answered review packet as a ReviewRecord (packages/xfactura-core/src/ro/reviews/
// records). The expert's tier needs a signature that covers the whole file; the qualified
// certificate itself is not verified here, and the record says so. Importing raises no status:
// a person sets a version to `interpreted` or `signed`, and the core test (reviewProblems) then
// checks the record binds it.
//   bun scripts/review/import.ts <answered.pdf> --tier signed|interpreted
//       [--publish-identity] [--records dir] [--date YYYY-MM-DD]
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import * as prettier from 'prettier';
import {
  buildItem,
  itemChanges,
  RECORD_FORMAT,
  reviewContext,
  reviewRecordSchema,
  type ReviewContext,
  type ReviewRecord,
  type ReviewTier,
} from '../../packages/xfactura-core/src/ro/reviews';
import { isLocalDate, type LocalDate } from '../../packages/xfactura-core/src/time';
import { today } from './packet';
import { readRecords, recordsDirectory } from './records';
import {
  attachedPacket,
  formAnswers,
  ImportRefused,
  pdfHasSignature,
  signatureCoverage,
  signingDate,
} from './signed';
import { sha256 } from './snapshots';

export async function importAnswered(
  bytes: Uint8Array,
  options: {
    tier: ReviewTier;
    publishIdentity?: boolean;
    records?: string;
    date?: LocalDate;
    context?: ReviewContext;
  },
) {
  const { packet, packetSha256, context: packetContext } = attachedPacket(bytes);
  const signed = pdfHasSignature(bytes);
  const coverage = signed ? signatureCoverage(bytes) : null;
  if (options.tier === 'signed') {
    if (!signed) throw new ImportRefused('The expert tier needs a signed file: no signature.');
    if (!coverage?.coversWholeFile)
      throw new ImportRefused(
        'The last signature does not cover the whole file: something was added after signing.',
      );
  }
  const { answers, reviewer } = await formAnswers(bytes, packet);
  const unanswered = answers.filter((answer) => !answer.choice);
  if (unanswered.length)
    throw new ImportRefused(`Unanswered: ${unanswered.map((answer) => answer.key).join(', ')}.`);
  const textless = answers.filter((answer) => answer.choice === 'C' && !answer.text);
  if (textless.length)
    throw new ImportRefused(
      `Answer C without its text: ${textless.map((answer) => answer.key).join(', ')}.`,
    );
  if (!reviewer.role) throw new ImportRefused('The reviewer did not state their role.');
  if (options.publishIdentity && !reviewer.name)
    throw new ImportRefused('The reviewer did not state their name.');
  if (options.publishIdentity && options.tier === 'signed' && !reviewer.ceccar)
    throw new ImportRefused('The expert did not state their CECCAR membership number.');

  const record: ReviewRecord = reviewRecordSchema.parse({
    format: RECORD_FORMAT,
    packetId: packet.id,
    packetSha256,
    tier: options.tier,
    reviewer: {
      role: reviewer.role,
      name: options.publishIdentity ? reviewer.name : null,
      ceccar: options.publishIdentity && reviewer.ceccar ? reviewer.ceccar : null,
      identityPublished: options.publishIdentity === true,
    },
    date: (signed && signingDate(bytes)) || options.date || today(),
    decisions: answers.map((answer) => ({
      key: answer.key,
      field: answer.field,
      choice: answer.choice!,
      ...(answer.choice === 'C' ? { text: answer.text } : {}),
    })),
    file: {
      sha256: sha256(bytes),
      signature: signed ? 'present_not_verified' : 'absent',
      coversWholeFile: coverage ? coverage.coversWholeFile : null,
    },
    excerpts: (packetContext?.excerpts ?? []).map((excerpt) => ({
      clause: excerpt.clause,
      shown: excerpt.shown,
      sha256: excerpt.sha256,
    })),
    packet,
  });

  const directory = options.records ?? recordsDirectory;
  if (
    readRecords(directory).some(
      (existing) =>
        existing.packetSha256 === record.packetSha256 &&
        existing.file.sha256 === record.file.sha256,
    )
  )
    throw new ImportRefused('This file is already imported.');
  mkdirSync(directory, { recursive: true });
  let file = path.join(directory, `${record.date}-${record.packetId}-${record.tier}.json`);
  for (let n = 2; existsSync(file); n += 1)
    file = path.join(directory, `${record.date}-${record.packetId}-${record.tier}-${n}.json`);
  const json = await prettier.format(JSON.stringify(record), {
    ...(await prettier.resolveConfig(file)),
    parser: 'json',
  });
  writeFileSync(file, json);

  // Whether each answer would bind today's register: the item regenerated must be the same.
  const context = options.context ?? reviewContext();
  const binding = record.packet.items.map((item) => {
    let changes: string[];
    try {
      changes = itemChanges(
        item,
        buildItem(
          context,
          item.key,
          item.versions.map((version) => version.id),
        ),
      );
    } catch (error) {
      changes = [(error as Error).message];
    }
    const decision = record.decisions.find((entry) => entry.key === item.key)!;
    return { key: item.key, versions: item.versions.map((v) => v.id), decision, changes };
  });
  return { record, file, binding };
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      tier: { type: 'string' },
      'publish-identity': { type: 'boolean' },
      records: { type: 'string' },
      date: { type: 'string' },
    },
  });
  const [input] = positionals;
  if (!input || (values.tier !== 'signed' && values.tier !== 'interpreted')) {
    console.error(
      'Usage: import.ts <answered.pdf> --tier signed|interpreted [--publish-identity] [--records dir] [--date YYYY-MM-DD]',
    );
    process.exit(2);
  }
  if (values.date && !isLocalDate(values.date)) {
    console.error(`Not a date: ${values.date}`);
    process.exit(2);
  }
  try {
    const { record, file, binding } = await importAnswered(new Uint8Array(readFileSync(input)), {
      tier: values.tier,
      publishIdentity: values['publish-identity'] === true,
      ...(values.records ? { records: values.records } : {}),
      ...(values.date ? { date: values.date as LocalDate } : {}),
    });
    console.log(`${record.packetId} (${record.tier}) → ${file}`);
    console.log(`  packet sha256 ${record.packetSha256}`);
    console.log(
      `  file sha256 ${record.file.sha256}; signature ${record.file.signature === 'present_not_verified' ? 'present, not verified' : 'absent'}${record.file.coversWholeFile === null ? '' : record.file.coversWholeFile ? ', covers the whole file' : ', does NOT cover the whole file'}`,
    );
    console.log(
      `  reviewer: ${record.reviewer.role}${record.reviewer.identityPublished ? `, ${record.reviewer.name}${record.reviewer.ceccar ? `, CECCAR ${record.reviewer.ceccar}` : ''}` : ' (identity withheld from the repository)'}`,
    );
    const status = record.tier === 'signed' ? 'signed' : 'interpreted';
    for (const entry of binding) {
      const answer = `${entry.decision.choice}${entry.decision.text ? ` («${entry.decision.text}»)` : ''}`;
      if (entry.decision.choice === 'A' && !entry.changes.length)
        console.log(
          `  ${entry.key}: ${answer}; binds today: a person may set ${entry.versions.join(', ')} to '${status}'`,
        );
      else
        console.log(
          `  ${entry.key}: ${answer}; does not bind${entry.changes.length ? `: ${entry.changes.join('; ')}` : ' (not the engine reading)'}`,
        );
    }
  } catch (error) {
    if (!(error instanceof ImportRefused)) throw error;
    console.error(`Refused: ${error.message}`);
    process.exit(1);
  }
}
