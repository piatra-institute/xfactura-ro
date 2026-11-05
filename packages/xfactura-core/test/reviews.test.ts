import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildPacket,
  keyAnnotations,
  packetHash,
  packetJson,
  RECORD_FORMAT,
  reviewContext,
  reviewProblems,
  reviewQueue,
  reviewRecordSchema,
  reviewSpecs,
  type ReviewPacket,
  type ReviewRecord,
  type ReviewTier,
} from '../src/ro/reviews';
import { roRegister } from '../src/ro/register';
import { clause } from '../src/ro/sources';
import { sha256Hex } from '../src/hash';
import type { ParameterVersion, ReviewStatus } from '../src/rules';
import type { LocalDate } from '../src/time';

const recordsDirectory = path.join(import.meta.dir, '../src/ro/reviews/records');

/** The committed records, as the binding check reads them. */
function committedRecords(): ReviewRecord[] {
  if (!existsSync(recordsDirectory)) return [];
  return readdirSync(recordsDirectory)
    .filter((name) => name.endsWith('.json'))
    .map((name) =>
      reviewRecordSchema.parse(JSON.parse(readFileSync(path.join(recordsDirectory, name), 'utf8'))),
    );
}

const base = reviewContext();

/** The default register with some versions changed (status, value, clauses…). */
function changed(edits: Record<string, Partial<ParameterVersion>>) {
  const register = base.register.withVersions(
    base.register.versions.map((version) =>
      edits[version.id] ? { ...version, ...edits[version.id] } : version,
    ),
  );
  return reviewContext({ register });
}

function recordOf(
  packet: ReviewPacket,
  tier: ReviewTier,
  choices: ('A' | 'B' | 'C')[] = [],
  date = '2026-11-05',
): ReviewRecord {
  return reviewRecordSchema.parse({
    format: RECORD_FORMAT,
    packetId: packet.id,
    packetSha256: packetHash(packet),
    tier,
    reviewer: { role: 'expert contabil', name: null, ceccar: null, identityPublished: false },
    date,
    decisions: packet.items.map((item, index) => ({
      key: item.key,
      field: `q${index + 1}`,
      choice: choices[index] ?? 'A',
      ...(choices[index] === 'C' ? { text: 'altă lectură' } : {}),
    })),
    file: {
      sha256: '0'.repeat(64),
      signature: tier === 'signed' ? 'present_not_verified' : 'absent',
      coversWholeFile: tier === 'signed' ? true : null,
    },
    excerpts: [],
    packet,
  });
}

const STANDARD = 'ro.vat.rate/S/2025-08-01';
const signedStandard = (extra: Partial<ParameterVersion> = {}) =>
  changed({ [STANDARD]: { status: 'signed' as ReviewStatus, ...extra } });

describe('rule review binding', () => {
  test('the default register: every reviewed version is bound to a record of its tier', () => {
    // Today every version is `extracted`, so this passes without any record; it is the gate a
    // status change must pass.
    const records = committedRecords();
    expect(reviewProblems(reviewContext(), records)).toEqual([]);
    expect(roRegister().versions.filter((version) => version.status !== 'extracted')).toEqual([]);
  });

  test('a signed version needs a record, and a matching record binds it', () => {
    const context = signedStandard();
    expect(reviewProblems(context, [])).toEqual([
      `${STANDARD}: signed without a signed review record`,
    ]);
    const packet = buildPacket(base, ['ro.vat.rate']);
    expect(reviewProblems(context, [recordOf(packet, 'signed')])).toEqual([]);
  });

  test('changing the value after signing voids the record and names the change', () => {
    const record = recordOf(buildPacket(base, ['ro.vat.rate']), 'signed');
    const [problem] = reviewProblems(signedStandard({ value: '22' }), [record]);
    expect(problem).toStartWith(`${STANDARD}: signed, but no review binds it:`);
    expect(problem).toContain(`${STANDARD} value "21" → "22"`);
    // The worked cases are computed again with the new value: their outcomes change too.
    expect(problem).toContain(
      'case 3 («Prestare în iulie, factură în august fără BT-72, cu 21%») engine outcome',
    );
  });

  test('changing the dates, the clauses or the spec voids it too', () => {
    const record = recordOf(buildPacket(base, ['ro.vat.rate']), 'signed');
    expect(
      reviewProblems(signedStandard({ reviewedThrough: '2027-12-31' as LocalDate }), [record])[0],
    ).toContain(`${STANDARD} reviewedThrough "2026-12-31" → "2027-12-31"`);
    const fewer = signedStandard({ clauses: ['ANAF/Cod-fiscal-consolidat:art.291(1)'] });
    const clauses = reviewProblems(fewer, [record])[0]!;
    expect(clauses).toContain(`${STANDARD} clauses`);
    expect(clauses).toContain('clause ANAF/D300-12.0.0:rd.9 no longer cited');

    const spec = reviewSpecs.find((item) => item.key === 'ro.vat.rate')!;
    const rewritten = reviewContext({
      register: signedStandard().register,
      specs: new Map(
        reviewSpecs.map((item) =>
          item === spec
            ? [item.key, { ...spec, readings: { ...spec.readings, engine: 'Altă formulare.' } }]
            : [item.key, item],
        ),
      ),
    });
    expect(reviewProblems(rewritten, [record])[0]).toContain("engine's reading changed");
    const anchors = reviewContext({
      register: signedStandard().register,
      anchors: {
        ...base.anchors,
        'ANAF/Cod-fiscal-consolidat:art.291(1)': [{ from: 'x', to: 'y' }],
      },
    });
    expect(reviewProblems(anchors, [record])[0]).toContain(
      'clause ANAF/Cod-fiscal-consolidat:art.291(1) anchors changed',
    );
  });

  test('only the engine reading (A) binds; B and C do not', () => {
    const packet = buildPacket(base, ['ro.vat.rate']);
    expect(reviewProblems(signedStandard(), [recordOf(packet, 'signed', ['B'])])[0]).toContain(
      "the reviewer chose B, not the engine's reading",
    );
    expect(reviewProblems(signedStandard(), [recordOf(packet, 'signed', ['C'])])[0]).toContain(
      "the reviewer chose C («altă lectură»), not the engine's reading",
    );
  });

  test('a partner accountant raises a version to interpreted, not to signed', () => {
    const packet = buildPacket(base, ['ro.vat.rate']);
    const partner = recordOf(packet, 'interpreted');
    expect(reviewProblems(signedStandard(), [partner])).toEqual([
      `${STANDARD}: signed without a signed review record`,
    ]);
    for (const status of ['interpreted', 'cases_approved'] as const)
      expect(reviewProblems(changed({ [STANDARD]: { status } }), [partner])).toEqual([]);
    // The expert's record also covers the lower tier.
    expect(
      reviewProblems(changed({ [STANDARD]: { status: 'interpreted' } }), [
        recordOf(packet, 'signed'),
      ]),
    ).toEqual([]);
  });

  test('a record whose packet was edited is refused', () => {
    const packet = buildPacket(base, ['ro.vat.rate']);
    const record = recordOf(packet, 'signed');
    const edited = structuredClone(record);
    edited.packet.items[0]!.readings.engine = 'Altceva.';
    expect(reviewProblems(signedStandard(), [edited])).toEqual([
      `${packet.id}: the packet the record holds hashes to ${packetHash(edited.packet)}, not ${record.packetSha256}`,
      `${STANDARD}: signed without a signed review record`,
    ]);
  });

  test('in a batch, a change voids only the answer whose item changed', () => {
    const packet = buildPacket(base, ['ro.vat.rate.reduced', 'ro.micro.rate']);
    const record = recordOf(packet, 'signed');
    const reduced = 'ro.vat.rate.reduced/2025-08-01';
    const micro = 'ro.micro.rate/2026-01-01';
    const context = changed({
      [reduced]: { status: 'signed' },
      [micro]: { status: 'signed', value: '3' },
    });
    const problems = reviewProblems(context, [record]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toStartWith(`${micro}: signed, but no review binds it:`);
    expect(problems[0]).toContain(`${micro} value "1" → "3"`);
  });

  test('the latest binding record wins over an older, voided one', () => {
    const old = recordOf(buildPacket(base, ['ro.vat.rate']), 'signed', ['A'], '2026-11-01');
    const context = signedStandard({ value: '22' });
    const fresh = recordOf(buildPacket(context, ['ro.vat.rate']), 'signed', ['A'], '2026-12-01');
    expect(reviewProblems(context, [old, fresh])).toEqual([]);
  });
});

describe('review packets', () => {
  test('the packet hash is the SHA-256 of its canonical JSON, and depends on nothing else', () => {
    const first = buildPacket(base, ['ro.vat.rate', 'ro.micro.rate']);
    const again = buildPacket(reviewContext(), ['ro.vat.rate', 'ro.micro.rate']);
    expect(packetHash(again)).toBe(packetHash(first));
    expect(sha256Hex(packetJson(first))).toBe(packetHash(first));
    expect(first.id).toMatch(/^RP-[a-f0-9]{12}$/);
    // Status is not part of a packet: raising it after the review must not change the hash.
    const raised = buildPacket(signedStandard(), ['ro.vat.rate', 'ro.micro.rate']);
    expect(packetHash(raised)).toBe(packetHash(first));
  });

  test('a key without a spec is refused, never invented', () => {
    expect(() => buildPacket(base, ['ro.vat.cash.ceiling'])).toThrow(
      'No review spec for ro.vat.cash.ceiling',
    );
  });

  test('every spec: a defined key, three to five cases, readings and anchored located clauses', () => {
    for (const spec of reviewSpecs) {
      expect(base.register.keys()).toContain(spec.key);
      expect(spec.cases.length).toBeGreaterThanOrEqual(3);
      expect(spec.cases.length).toBeLessThanOrEqual(5);
      const [item] = buildPacket(base, [spec.key]).items;
      expect(item!.readings.engine).not.toBe(item!.readings.alternative);
      // At least one case where the readings give different outcomes: otherwise the question
      // has no consequence the reviewer can see.
      expect(
        item!.cases.some(
          (entry) => JSON.stringify(entry.engine) !== JSON.stringify(entry.alternative),
        ),
      ).toBe(true);
      const unanchored = item!.sources
        .filter((source) => clause(source.clause)?.status === 'located' && !source.anchors)
        .map((source) => source.clause);
      expect(unanchored).toEqual([]);
    }
  });

  test('worked cases come from the engine: the VAT rate cases', () => {
    const [item] = buildPacket(base, ['ro.vat.rate']).items;
    expect(item!.cases.map((entry) => [entry.engine.summary, entry.alternative.summary])).toEqual([
      // BT-72 gives the supply's date: July's rate and July's VAT period.
      [
        'Propus: TVA colectată 190,00 lei (S-19), perioada TVA 2025-07',
        'Propus: TVA colectată 190,00 lei (S-19), perioada TVA 2025-07',
      ],
      ['Blocat: VAT_RATE', 'Blocat: VAT_RATE'],
      [
        'Propus: TVA colectată 210,00 lei (S-21), perioada TVA 2025-08',
        'Propus: TVA colectată 210,00 lei (S-21), perioada TVA 2025-08',
      ],
      // Only the invoiced period (BG-14): the readings differ.
      ['Blocat: VAT_RATE', 'Propus: TVA colectată 190,00 lei (S-19), perioada TVA 2025-07'],
      [
        'Propus: TVA colectată 190,00 lei (S-19), perioada TVA 2025-07',
        'Propus: TVA colectată 190,00 lei (S-19), perioada TVA 2025-07',
      ],
    ]);
    const codes = (lines: string[]) =>
      lines.flatMap((line) => line.match(/^(?:Blocare|De confirmat) (\w+):/)?.[1] ?? []);
    expect(item!.cases.map((entry) => codes(entry.engine.lines))).toEqual([
      [],
      ['VAT_RATE', 'SUPPLY_DATE_ASSUMED'],
      ['SUPPLY_DATE_ASSUMED'],
      ['VAT_RATE', 'SUPPLY_DATE_ASSUMED'],
      ['RATE_REGULARIZATION'],
    ]);
  });

  test('worked cases come from the engine: the vehicle cases', () => {
    const [item] = buildPacket(base, ['ro.vat.deduction.limited']).items;
    expect(item!.cases.map((entry) => [entry.engine.summary, entry.alternative.summary])).toEqual([
      // Mixed use: half of 315,00 lei.
      [
        'Propus: TVA dedusă 157,50 lei din 315,00 lei (S-21)',
        'Propus: TVA dedusă 157,50 lei din 315,00 lei (S-21)',
      ],
      [
        'Propus: TVA dedusă 105,00 lei din 105,00 lei (S-21)',
        'Propus: TVA dedusă 105,00 lei din 105,00 lei (S-21)',
      ],
      // A fuel card for several cars, not split: the readings differ.
      [
        'Propus: TVA dedusă 126,00 lei din 252,00 lei (S-21)',
        'Propus: TVA dedusă 252,00 lei din 252,00 lei (S-21)',
      ],
      [
        'Propus: TVA dedusă 21.000,00 lei din 21.000,00 lei (S-21)',
        'Propus: TVA dedusă 21.000,00 lei din 21.000,00 lei (S-21)',
      ],
      [
        'Propus: TVA dedusă 168,00 lei din 168,00 lei (S-21)',
        'Propus: TVA dedusă 168,00 lei din 168,00 lei (S-21)',
      ],
    ]);
    const codes = (lines: string[]) =>
      lines.flatMap((line) => line.match(/^(?:Blocare|De confirmat) (\w+):/)?.[1] ?? []);
    expect(item!.cases.map((entry) => codes(entry.engine.lines))).toEqual([
      [],
      [],
      ['VEHICLE_UNNAMED'],
      [],
      [],
    ]);
    expect(item!.cases[0]!.engine.lines).toContain(
      'Parametru ro.vat.deduction.limited/2016-01-01 = "50"',
    );
  });

  test('worked cases come from the engine: the micro limit and rate cases', () => {
    const [limit, rate] = buildPacket(base, ['ro.micro.revenue_limit_eur', 'ro.micro.rate']).items;
    expect(limit!.cases[2]!.engine.summary).toBe(
      'Propus: impozit 2.000,00 lei pe baza de 200.000,00 lei (cota 1%)',
    );
    expect(limit!.cases[2]!.alternative.summary).toBe('Blocat: MICRO_LIMIT');
    expect(limit!.cases[4]!.engine.summary).toStartWith('Propus:');
    expect(limit!.cases[2]!.engine.lines[0]).toStartWith('De confirmat MICRO_LIMIT_READING:');
    expect(limit!.cases[1]!.engine.summary).toBe('Blocat: MICRO_LIMIT');
    expect(limit!.cases[3]!.engine.summary).toBe(limit!.cases[3]!.alternative.summary);
    // Only the tax is rounded to whole lei (OUG nr. 59/2005 art. 1 alin. (1)).
    expect(rate!.cases[1]!.engine.summary).toBe(
      'Propus: impozit 249,00 lei pe baza de 24.949,60 lei (cota 1%)',
    );
    expect(rate!.cases[1]!.alternative.summary).toBe(
      'Calculat: impozit 250,00 lei pe baza de 24.950,00 lei (cota 1%)',
    );
    expect(rate!.cases[1]!.engine.lines).toContain(
      'Parametru ro.declaration.rounding/2016-01-01 = "half_up_leu"',
    );
    expect(rate!.cases[3]!.engine.summary).toBe('Blocat: RULE_GAP');
  });
});

describe('review queue', () => {
  test('ranks the annotated parameters and batches mechanical rows by act', () => {
    const { packets, missing, rows } = reviewQueue(base, '2026-10-30' as LocalDate);
    expect(rows).toHaveLength(base.register.keys().length);
    expect(packets.map((packet) => [packet.kind, packet.keys])).toEqual([
      ['mechanical', ['ro.vat.rate.reduced', 'ro.micro.rate']],
      ['interpretation', ['ro.dividend.tax_rate']],
      ['interpretation', ['ro.taxaccount.distribution']],
      ['interpretation', ['ro.vat.simplified_invoice.limit_eur']],
      ['interpretation', ['ro.rent.tax_rate']],
      ['interpretation', ['ro.efactura.b2c']],
      ['interpretation', ['ro.nonresident.tax_rate']],
      ['interpretation', ['ro.payroll.mandate.deduction']],
      ['interpretation', ['ro.payroll.voucher.limits']],
      ['interpretation', ['ro.sick.codes']],
      ['interpretation', ['ro.vat.deduction.limited']],
      ['interpretation', ['ro.vat.exemption.threshold']],
      ['interpretation', ['ro.nonresident.certificate_days']],
      ['interpretation', ['ro.vat.rate']],
      ['interpretation', ['ro.ip.tax_rate']],
      ['interpretation', ['ro.stock.methods']],
      ['interpretation', ['ro.vat.capital_goods.minimum']],
      ['interpretation', ['ro.vat.distance.threshold']],
      ['interpretation', ['ro.vat.intra_eu.vies']],
      ['interpretation', ['ro.vat.prorata']],
      ['interpretation', ['ro.deadline.D112.quarterly']],
      ['interpretation', ['ro.profit.legal_reserve']],
      ['interpretation', ['ro.payroll.quarterly']],
      ['interpretation', ['ro.retail.zreport']],
      ['interpretation', ['ro.sick.accident']],
      ['interpretation', ['ro.stock.retail.coefficient']],
      ['interpretation', ['ro.taxaccount.advance']],
      ['interpretation', ['ro.vat.capital_goods']],
      ['interpretation', ['ro.vat.flat_rate.agriculture']],
      ['interpretation', ['ro.vat.intra_eu.transport']],
      ['interpretation', ['ro.vat.registration.annualized']],
      ['interpretation', ['ro.vat.reverse_charge.domestic']],
      ['interpretation', ['ro.vat.special.payable_account']],
      ['interpretation', ['ro.vat.stock_adjustment']],
      ['interpretation', ['ro.micro.revenue_limit_eur']],
      ['interpretation', ['ro.garnishment.limits']],
      ['interpretation', ['ro.payroll.correction.retroactive']],
      ['interpretation', ['ro.vat.late_registration']],
      ['interpretation', ['ro.vat.margin.goods']],
      ['interpretation', ['ro.vat.margin.travel']],
      ['interpretation', ['ro.d406.start']],
      ['interpretation', ['ro.deadline.S1003']],
      ['interpretation', ['ro.impairment.accounts']],
      ['interpretation', ['ro.profit.sponsorship']],
      ['interpretation', ['ro.vat.oss.return']],
      ['interpretation', ['ro.micro.linked']],
      ['interpretation', ['ro.profit.loss_carryforward']],
      ['interpretation', ['ro.provisions.accounts']],
      ['interpretation', ['ro.vat.oss.declarations']],
      ['interpretation', ['ro.vat.oss.payable_account']],
      ['interpretation', ['ro.deadline.D406.assets']],
      ['interpretation', ['ro.profit.social_limit']],
      ['interpretation', ['ro.size.thresholds']],
      ['interpretation', ['ro.stock.accounts']],
      ['interpretation', ['ro.taxaccount.accounts']],
      ['interpretation', ['ro.vat.import']],
      ['interpretation', ['ro.pit.norma']],
      ['interpretation', ['ro.pit.sources']],
      ['interpretation', ['ro.inventory.accounts']],
      ['interpretation', ['ro.d406.assets.presentation']],
    ]);
    const vat = rows.find((row) => row.key === 'ro.vat.rate')!;
    // reach 3 × risk 3 (tax amount) × urgency 3 (D394 due on 30.10.2026) ÷ 25 minutes.
    expect(vat.deadline).toMatchObject({ obligation: 'D394', due: '2026-10-30', days: 0 });
    expect(vat.score).toBeCloseTo((3 * 3 * 3) / 25);
    const micro = rows.find((row) => row.key === 'ro.micro.revenue_limit_eur')!;
    expect(micro.deadline).toMatchObject({ obligation: 'D100.micro', due: '2027-01-25' });
    expect(micro.urgency).toBe(2);
    // Every key with a spec is annotated, but the half-year report and REGES-ONLINE have no tax
    // return whose deadline ranks them (the engine does not prepare the report; the register is
    // the Labour Inspectorate's).
    expect(missing).toHaveLength(base.register.keys().length - reviewSpecs.length + 2);
    for (const key of ['ro.halfyear.report', 'ro.deadline.reges.change'])
      expect(missing.find((row) => row.key === key)!.missing).toEqual(['obligations (urgency)']);
    expect(missing.find((row) => row.key === 'ro.deadline.D300')!.missing).toEqual([
      'spec (readings, cases, minutes)',
      'reach',
      'risk',
      'obligations (urgency)',
    ]);
  });

  test('lists a missing annotation instead of guessing it', () => {
    const { reach: _reach, ...rest } = keyAnnotations['ro.vat.rate']!;
    const context = reviewContext({ annotations: { ...keyAnnotations, 'ro.vat.rate': rest } });
    const { rows, packets } = reviewQueue(context, '2026-10-30' as LocalDate);
    const vat = rows.find((row) => row.key === 'ro.vat.rate')!;
    expect(vat.score).toBeUndefined();
    expect(vat.missing).toEqual(['reach']);
    expect(packets.flatMap((packet) => packet.keys)).not.toContain('ro.vat.rate');
  });
});

describe('review records', () => {
  test('the expert tier needs a whole-file signature; C needs its text', () => {
    const packet = buildPacket(base, ['ro.vat.rate']);
    const record = recordOf(packet, 'signed');
    expect(
      reviewRecordSchema.safeParse({ ...record, file: { ...record.file, signature: 'absent' } })
        .success,
    ).toBe(false);
    expect(
      reviewRecordSchema.safeParse({ ...record, file: { ...record.file, coversWholeFile: false } })
        .success,
    ).toBe(false);
    expect(
      reviewRecordSchema.safeParse({
        ...record,
        decisions: [{ ...record.decisions[0]!, choice: 'C' }],
      }).success,
    ).toBe(false);
    expect(
      reviewRecordSchema.safeParse({
        ...record,
        reviewer: { role: 'expert contabil', name: 'Nume', ceccar: null, identityPublished: true },
      }).success,
    ).toBe(false);
  });
});
