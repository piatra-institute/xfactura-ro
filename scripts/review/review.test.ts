// The review tooling end to end: a packet's PDF answered, signed (with a fake signature
// dictionary: no cryptography), imported into a temporary records directory, and bound by the
// core check until the value changes. Excerpts are checked against the local snapshots when
// .sources/ is present; without it those tests are skipped, never passed.
//   bun test scripts/review
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultRegister } from '../../packages/xfactura-api/source/engine/engine';
import { roRegister } from '../../packages/xfactura-core/src/ro/register';
import {
  buildPacket,
  reviewContext,
  reviewProblems,
  reviewSpecs,
} from '../../packages/xfactura-core/src/ro/reviews';
import { legalSources } from '../../packages/xfactura-core/src/ro/sources';
import type { LocalDate } from '../../packages/xfactura-core/src/time';
import { appendFakeSignature, fillAnswers } from './fixtures';
import { importAnswered } from './import';
import { generatePacket } from './packet';
import { readRecords } from './records';
import { ImportRefused } from './signed';
import { excerptsFor, sourcesDirectory } from './snapshots';

const scratch = mkdtempSync(path.join(tmpdir(), 'xfactura-review-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const expert = { name: 'Expert Test', ceccar: '12345', role: 'expert contabil' };
const date = '2026-10-30' as LocalDate;

test("the core register is the engine's default register", () => {
  expect(roRegister().hash).toBe(defaultRegister().hash);
  expect(roRegister().keys()).toEqual(defaultRegister().keys());
});

const snapshots = existsSync(sourcesDirectory) ? test : test.skip;
snapshots(
  'every located clause of the seed specs shows its excerpt from the snapshots',
  () => {
    const mediaType = (id: string, sha: string) =>
      legalSources.find((source) => source.id === id)?.snapshots.find((s) => s.sha256 === sha)
        ?.mediaType;
    const items = buildPacket(
      reviewContext(),
      reviewSpecs.map((spec) => spec.key),
    ).items;
    const excerpts = excerptsFor(items, mediaType);
    const located = items
      .flatMap((item) => item.sources)
      .filter((source) => source.status === 'located');
    const unavailable = excerpts.filter(
      (excerpt) => !excerpt.shown && located.some((source) => source.clause === excerpt.clause),
    );
    expect(unavailable).toEqual([]);
    // Pending clauses say why, without failing the packet.
    expect(excerpts.find((excerpt) => excerpt.clause === 'L141/2025:rates')?.text).toBe(
      'excerpt unavailable: the clause is pending: its source has no registered snapshot',
    );
    // Every spec's excerpts are extracted from the stored PDFs, which takes longer than Bun's
    // default five seconds.
  },
  120_000,
);

test('a missing snapshot gives "excerpt unavailable", and the packet is still generated', async () => {
  const result = await generatePacket(['ro.micro.rate'], {
    out: path.join(scratch, 'nosources'),
    date,
    sources: path.join(scratch, 'no-such-directory'),
  });
  expect(result.context.excerpts.every((excerpt) => !excerpt.shown)).toBe(true);
  expect(result.context.excerpts[0]!.text).toStartWith('excerpt unavailable: snapshot missing');
  expect(readFileSync(result.files.markdown, 'utf8')).toContain(
    'Extras indisponibil: snapshot lipsă',
  );
});

describe('round trip', () => {
  test('answer, sign, import: the record binds a signed version until its value changes', async () => {
    const generated = await generatePacket(['ro.vat.rate'], { out: scratch, date });
    expect(generated.missingGlyphs).toEqual([]);
    const answered = await fillAnswers(
      new Uint8Array(readFileSync(generated.files.pdf)),
      ['A'],
      expert,
    );
    const signed = appendFakeSignature(answered, '2026-11-05');
    const records = path.join(scratch, 'records');

    const imported = await importAnswered(signed, {
      tier: 'signed',
      records,
      publishIdentity: true,
    });
    expect(imported.record).toMatchObject({
      packetId: generated.packet.id,
      packetSha256: generated.packetSha256,
      tier: 'signed',
      date: '2026-11-05',
      reviewer: { name: 'Expert Test', ceccar: '12345', identityPublished: true },
      decisions: [{ key: 'ro.vat.rate', field: 'q1', choice: 'A' }],
      file: { signature: 'present_not_verified', coversWholeFile: true },
    });
    expect(imported.binding[0]!.changes).toEqual([]);
    expect(readRecords(records)).toHaveLength(1);

    const base = reviewContext();
    const withStatus = (value: string) =>
      reviewContext({
        register: base.register.withVersions(
          base.register.versions.map((version) =>
            version.id === 'ro.vat.rate/S/2025-08-01'
              ? { ...version, status: 'signed' as const, value }
              : version,
          ),
        ),
      });
    expect(reviewProblems(withStatus('21'), readRecords(records))).toEqual([]);
    const [problem] = reviewProblems(withStatus('22'), readRecords(records));
    expect(problem).toContain('ro.vat.rate/S/2025-08-01 value "21" → "22"');

    await expect(importAnswered(signed, { tier: 'signed', records })).rejects.toThrow(
      'already imported',
    );
  });

  test('the expert tier refuses an unsigned file, or one changed after signing', async () => {
    const generated = await generatePacket(['ro.micro.rate'], { out: scratch, date });
    const answered = await fillAnswers(
      new Uint8Array(readFileSync(generated.files.pdf)),
      ['B'],
      expert,
    );
    const records = path.join(scratch, 'refused');
    await expect(importAnswered(answered, { tier: 'signed', records })).rejects.toThrow(
      ImportRefused,
    );
    const signed = appendFakeSignature(answered, '2026-11-05');
    const appended = new Uint8Array([...signed, ...new TextEncoder().encode('% later\n')]);
    await expect(importAnswered(appended, { tier: 'signed', records })).rejects.toThrow(
      'does not cover the whole file',
    );
    // A partner accountant's answers need no signature; B is recorded and binds nothing.
    const partner = await importAnswered(answered, { tier: 'interpreted', records });
    expect(partner.record.file).toEqual({
      sha256: partner.record.file.sha256,
      signature: 'absent',
      coversWholeFile: null,
    });
    expect(partner.record.reviewer).toEqual({
      role: 'expert contabil',
      name: null,
      ceccar: null,
      identityPublished: false,
    });
    expect(partner.record.decisions[0]!.choice).toBe('B');
  });

  test('an unanswered question or a C without its text is refused', async () => {
    const generated = await generatePacket(['ro.vat.rate.reduced'], { out: scratch, date });
    const bytes = new Uint8Array(readFileSync(generated.files.pdf));
    await expect(importAnswered(bytes, { tier: 'interpreted' })).rejects.toThrow('Unanswered');
    const textless = await fillAnswers(bytes, ['C'], expert);
    await expect(importAnswered(textless, { tier: 'interpreted' })).rejects.toThrow(
      'Answer C without its text',
    );
    const written = await fillAnswers(bytes, ['C'], expert, { 0: 'Cota de 9% e un caz separat.' });
    const imported = await importAnswered(written, {
      tier: 'interpreted',
      records: path.join(scratch, 'free-text'),
    });
    expect(imported.record.decisions[0]).toEqual({
      key: 'ro.vat.rate.reduced',
      field: 'q1',
      choice: 'C',
      text: 'Cota de 9% e un caz separat.',
    });
  });
});
