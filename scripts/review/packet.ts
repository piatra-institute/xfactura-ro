// Generates a rule review packet: a PDF for a partner accountant or the expert contabil to answer
// and sign, with the canonical packet attached (packet.json; its SHA-256 is the packet hash), and
// the same content as Markdown. Readings, cases and questions come from the review specs
// (packages/xfactura-core/src/ro/reviews/specs); a key without a spec is refused, never invented.
//   bun scripts/review/packet.ts --keys ro.vat.rate[,ro.micro.rate…] [--out dir] [--date YYYY-MM-DD]
//   bun scripts/review/packet.ts --act ANAF/Cod-fiscal-consolidat    (its mechanical rows, ~20 a packet)
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  buildPacket,
  MECHANICAL_BATCH,
  nextDeadline,
  packetJson,
  reviewContext,
  type ReviewContext,
} from '../../packages/xfactura-core/src/ro/reviews';
import { legalSources } from '../../packages/xfactura-core/src/ro/sources';
import { isLocalDate, type LocalDate } from '../../packages/xfactura-core/src/time';
import { CONTEXT_FORMAT, renderMarkdown, renderPdf, type PacketContext } from './render';
import { excerptsFor, repositoryRoot, sha256, sourcesDirectory } from './snapshots';

export const defaultOutput = path.join(repositoryRoot, '.reviews/packets');

const mediaTypeOf = (sourceId: string, hash: string) =>
  legalSources
    .find((source) => source.id === sourceId)
    ?.snapshots.find((snapshot) => snapshot.sha256 === hash)?.mediaType;

export const today = () => new Date().toISOString().slice(0, 10) as LocalDate;

export async function generatePacket(
  keys: readonly string[],
  options: { out?: string; date?: LocalDate; context?: ReviewContext; sources?: string } = {},
) {
  const context = options.context ?? reviewContext();
  const date = options.date ?? today();
  const packet = buildPacket(context, keys);
  const json = packetJson(packet);
  const packetSha256 = sha256(json);
  const packetContext: PacketContext = {
    format: CONTEXT_FORMAT,
    packetId: packet.id,
    packetSha256,
    generatedOn: date,
    excerpts: excerptsFor(packet.items, mediaTypeOf, options.sources ?? sourcesDirectory),
    deadlines: packet.items.map((item) => ({
      key: item.key,
      deadline:
        nextDeadline(context, context.annotations[item.key]?.obligations ?? [], date) ?? null,
    })),
    minutes: keys.reduce((sum, key) => sum + context.specs.get(key)!.minutes, 0),
  };
  const pdf = await renderPdf(packet, packetSha256, packetContext, json);
  const out = options.out ?? defaultOutput;
  mkdirSync(out, { recursive: true });
  const files = {
    pdf: path.join(out, `${packet.id}.pdf`),
    markdown: path.join(out, `${packet.id}.md`),
    json: path.join(out, `${packet.id}.packet.json`),
  };
  writeFileSync(files.pdf, pdf.bytes);
  writeFileSync(files.markdown, renderMarkdown(packet, packetSha256, packetContext));
  writeFileSync(files.json, json);
  return { packet, packetSha256, context: packetContext, files, missingGlyphs: pdf.missingGlyphs };
}

/** The mechanical rows of an act, in batches; its interpretations are listed to run alone. */
export function actBatches(context: ReviewContext, act: string) {
  const specs = [...context.specs.values()].filter((spec) => spec.act === act);
  const mechanical = specs.filter((spec) => spec.kind === 'mechanical').map((spec) => spec.key);
  const batches: string[][] = [];
  for (let start = 0; start < mechanical.length; start += MECHANICAL_BATCH)
    batches.push(mechanical.slice(start, start + MECHANICAL_BATCH));
  return {
    batches,
    interpretations: specs.filter((spec) => spec.kind === 'interpretation').map((spec) => spec.key),
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      keys: { type: 'string' },
      act: { type: 'string' },
      out: { type: 'string' },
      date: { type: 'string' },
    },
  });
  if (!values.keys === !values.act) {
    console.error(
      'Usage: packet.ts --keys a,b,c | --act <sourceId> [--out dir] [--date YYYY-MM-DD]',
    );
    process.exit(2);
  }
  if (values.date && !isLocalDate(values.date)) {
    console.error(`Not a date: ${values.date}`);
    process.exit(2);
  }
  const context = reviewContext();
  let packets: string[][];
  if (values.keys)
    packets = [
      values.keys
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean),
    ];
  else {
    const { batches, interpretations } = actBatches(context, values.act!);
    if (interpretations.length)
      console.log(
        `Interpretations of ${values.act} get their own packets: ${interpretations.map((key) => `--keys ${key}`).join(', ')}`,
      );
    if (!batches.length) {
      console.error(`No mechanical row of ${values.act} has a review spec.`);
      process.exit(1);
    }
    packets = batches;
  }
  for (const keys of packets) {
    const result = await generatePacket(keys, {
      ...(values.out ? { out: values.out } : {}),
      ...(values.date ? { date: values.date as LocalDate } : {}),
      context,
    });
    const shown = result.context.excerpts.filter((item) => item.shown).length;
    console.log(`${result.packet.id} (${keys.join(', ')})`);
    console.log(`  packet sha256 ${result.packetSha256}`);
    console.log(`  excerpts shown ${shown} of ${result.context.excerpts.length}`);
    for (const item of result.context.excerpts.filter((entry) => !entry.shown))
      console.log(`    ${item.clause}: ${item.text}`);
    if (result.missingGlyphs.length)
      console.log(`  characters the font lacks, printed as '?': ${result.missingGlyphs.join(' ')}`);
    console.log(`  ${result.files.pdf}\n  ${result.files.markdown}`);
  }
}
