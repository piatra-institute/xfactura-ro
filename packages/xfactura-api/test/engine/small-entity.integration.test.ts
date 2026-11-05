import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import * as annual from 'xfactura-core/ro/annual/agent';
import { s1003Field } from 'xfactura-core/ro/annual/s1003';
import { DukIntegrator } from '../../source/engine/adapters/declaration-validator';
import type { ActionView } from '../../source/engine/kernel/actions';
import type { WorkItem } from '../../source/engine/kernel/work';
import { annualQuestions, answerAnnual, supplyDocuments } from './fixtures/annual';
import { journal, scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

const dist = path.join(import.meta.dir, '../../../..', '.validators/anaf/dist');
const official = DukIntegrator.available(dist) && Bun.which('java') ? test : test.skip;
const cui = '14399840';
const options = {
  entity: {
    tradeRegister: 'J17/456/2015',
    ownership: 35,
    caen: '7022',
    caenActual: '7022',
    caenVersion: 2025,
    largeTaxpayer: false,
    branch: false,
    economicInterestGroup: false,
    netAssetsBelowHalfCapital: false,
  },
  administrator: 'Popescu Ana',
  preparer: { name: 'Contexpert SRL', quality: 22, membership: '12345', cif: '18547290' },
  approved: true,
  informative: { F20: { '01a': [4_800_000, 5_200_000] } },
};
type Artifact = {
  id: string;
  state: string;
  xmlHash: string;
  steps: { state: string; detail: string | null }[];
};

/**
 * Exemplu Consultanță SRL, kept in the engine from 2024: 200.000 lei of capital, consulting sold
 * for 4.800.000 lei in 2024 and 5.200.000 lei in 2025, paid into the bank, against services
 * bought; a microentity by its filed statements of 2024, beyond two of the microentities' limits
 * (2.250.000 lei of assets, 4.500.000 lei of turnover) in 2024 and 2025, so a small entity in
 * 2025. The engine's date is 10 March 2026, in the filing season.
 */
async function company(validator?: DukIntegrator) {
  const now = Date.parse('2026-03-10T10:00:00Z');
  const s = await scenario({
    year: 2024,
    cui,
    clock: () => now,
    ...(validator ? { declarationValidator: validator } : {}),
  });
  open.push(s);
  const record = async (axis: string, value: string, effectiveFrom: string) =>
    s.invoke(s.owner, 'profile.record', {
      axis,
      value,
      effectiveFrom,
      evidenceId: (await s.evidence(`${axis}.pdf`)).id,
    });
  await record('entity.form', 'srl', '2015-01-01');
  await record('vat.status', 'non_vat', '2015-01-01');
  // The category of 2024, as its filed statements show it (S1005).
  await record('size.category', 'micro', '2024-01-01');
  await s.invoke(s.owner, 'sales.seller.record', {
    details: {
      name: 'Exemplu Consultanță SRL',
      vatId: `RO${cui}`,
      address: { lines: ['Str. Lungă 10'], city: 'Galați', subdivision: 'RO-GL', country: 'RO' },
    },
  });
  const book = async (
    date: string,
    lines: { account: string; side: 'D' | 'C'; amount: string }[],
  ) =>
    s.book('ledger.general', journal((await s.evidence(`nota-${date}.pdf`)).id, lines, { date }));
  await book('2024-01-10', [
    { account: '5121', side: 'D', amount: '200000.00' },
    { account: '1012', side: 'C', amount: '200000.00' },
  ]);
  await book('2024-06-30', [
    { account: '5121', side: 'D', amount: '4800000.00' },
    { account: '704', side: 'C', amount: '4800000.00' },
  ]);
  await book('2024-09-30', [
    { account: '628', side: 'D', amount: '1500000.00' },
    { account: '5121', side: 'C', amount: '1500000.00' },
  ]);
  const note = async () => (await s.evidence('nota-inchidere.pdf')).id;
  await s.post(
    await s.approve(
      await s.propose('year.closeResult', { yearEnd: '2024-12-31', evidenceId: await note() }),
    ),
  );
  for (const kind of ['financial', 'fiscal'])
    await s.invoke(s.owner, 'years.create', {
      kind,
      label: '2025',
      from: '2025-01-01',
      to: '2025-12-31',
    });
  await s.post(
    await s.approve(
      await s.propose('year.transferResult', {
        yearEnd: '2024-12-31',
        date: '2025-04-15',
        evidenceId: (await s.evidence('hotarare-aga-2024.pdf')).id,
      }),
    ),
  );
  await book('2025-06-30', [
    { account: '5121', side: 'D', amount: '5200000.00' },
    { account: '704', side: 'C', amount: '5200000.00' },
  ]);
  await book('2025-09-30', [
    { account: '628', side: 'D', amount: '1600000.00' },
    { account: '5121', side: 'C', amount: '1600000.00' },
  ]);
  await s.post(
    await s.approve(
      await s.propose('year.closeResult', { yearEnd: '2025-12-31', evidenceId: await note() }),
    ),
  );
  const prepare = (extra: Record<string, unknown> = {}, period = '2025') =>
    s.invoke<Artifact>(s.owner, 'declarations.prepare', {
      kind: 'S1003',
      period,
      options: { ...options, ...extra },
    });
  return { s, record, prepare };
}

/** The size category of 2025, computed and confirmed by a person (determination.confirm). */
async function confirmSmall(s: Scenario) {
  const proposed = await s.invoke<{
    determinations: { axis: string; value: string | null; lines: string[] }[];
    asked: { kind: string; subject: { id: string }; questionId: string }[];
  }>(s.owner, 'determinations.propose', { year: 2025 });
  const size = proposed.determinations.find((item) => item.axis === 'size.category')!;
  const question = proposed.asked.find((item) => item.subject.id === 'size.category/2025')!;
  await s.invoke(s.reviewer, 'questions.answer', {
    questionId: question.questionId,
    value: { confirm: true },
  });
  return size;
}

const cell = (xml: string, form: 'F10' | 'F20' | 'F30', row: string, column: number) =>
  new RegExp(`\\b${s1003Field(form, row, column)}="(-?\\d+)"`).exec(xml)?.[1];

describe('S1003, the small entities’ statements, from the books', () => {
  test('two years beyond the microentities’ limits: small in 2025, S1003 due with the deadline conflict', async () => {
    const { s } = await company();
    const size = await confirmSmall(s);
    expect(size.value).toBe('small');
    const closure = await s.invoke<{
      obligations: { kind: string; period: string; state: string; rule: string }[];
      unsupported: { trigger: string }[];
    }>(s.owner, 'closure.evaluate', { from: '2025-01', to: '2025-12' });
    expect(closure.obligations.find((item) => item.kind === 'S1003')).toMatchObject({
      period: '2025',
      state: 'applies',
      rule: 'obligation.statements@2025',
    });
    expect(closure.unsupported.map((item) => item.trigger)).not.toContain(
      'SMALL_ENTITY_STATEMENTS',
    );
    // The calendar: 150 days (Legea 82/1991) against 31 May (OMF nr. 2.036/2025), both moved off
    // the weekend and 1 June; the earlier is the one to file by.
    const rows = await s.list<{
      kind: string;
      period: string;
      due: string | null;
      conflict: { nominal: string; due: string; clauses: string[] }[] | null;
    }>(s.owner, 'obligations.calendar', { from: '2025-12', to: '2025-12' });
    const row = rows.find((item) => item.kind === 'S1003' && item.period === '2025')!;
    expect(row.due).toBe('2026-06-02');
    expect(row.conflict?.map((reading) => [reading.nominal, reading.due, reading.clauses])).toEqual(
      [
        ['2026-05-30', '2026-06-02', ['L82/1991:art.36(1)(a)']],
        ['2026-05-31', '2026-06-02', ['OMF2036/2025:anexa1.pct.3.1(1)(a)']],
      ],
    );
  });

  test('F30 from the registers; what they do not hold is asked by chapter, never defaulted', async () => {
    const { s, prepare } = await company();
    await confirmSmall(s);
    const refused = await s.refused(prepare());
    const codes = (refused?.details as { problems: { code: string; message: string }[] }).problems;
    expect(refused?.code).toBe('F30_CHAPTER');
    expect(new Set(codes.map((problem) => problem.code))).toEqual(new Set(['F30_CHAPTER']));
    // The agent's worklist names the statement and what it waits on.
    const work = (await s.invoke<{ items: WorkItem[] }>(s.owner, 'work.list', { limit: 200 }))
      .items;
    expect(work.find((item) => item.kind === 'annual.input')).toMatchObject({
      subject: { kind: 'annual', id: 'S1003|2025' },
      next: [
        { operation: 'annual.ask', by: 'agent', inputHint: { kind: 'S1003', year: 2025 } },
        { operation: 'questions.answer', by: 'human' },
      ],
    });
    expect(annual.detectors.map((item) => item.kind)).toEqual(['annual.input']);
    // Chapter VIII asks only what the books cannot tell; the bank balance is read.
    const asked = await annualQuestions(s, 'S1003', 2025);
    const viii = asked.find((question) => question.subject.id === 'S1003/2025/VIII');
    expect(viii?.params.rows?.map((row) => row.row) ?? []).not.toContain('88');
    const answered = await answerAnnual(s, 'S1003', 2025, 200_000);
    expect(answered).toContain('annual.disclosures S1003/2025');
    const artifact = await prepare();
    expect(artifact.state).toBe('prepared');
    const xml = Buffer.from(await s.objects.get(s.company.id, artifact.xmlHash)).toString('utf8');
    expect(xml).toContain('tipBIL="BS"');
    // The full profit and loss account, both years from the books.
    expect(cell(xml, 'F20', '01', 1)).toBe('4800000');
    expect(cell(xml, 'F20', '01', 2)).toBe('5200000');
    expect(cell(xml, 'F20', '69', 2)).toBe('3600000');
    // Bank: 200.000 + 4.800.000 − 1.500.000 + 5.200.000 − 1.600.000.
    expect(cell(xml, 'F10', '08', 2)).toBe('7100000');
    expect(cell(xml, 'F30', '88', 2)).toBe('7100000');
    expect(cell(xml, 'F30', '88', 1)).toBe('3500000');
    // Chapter I: one unit with profit; XII: the capital held by individuals.
    expect(cell(xml, 'F30', '01', 2)).toBe('3600000');
    expect(cell(xml, 'F30', '151', 3)).toBe('200000');
    // The signatures and the draft facts travel with the prepared return.
    const summary = JSON.parse(artifact.steps[0]!.detail!) as {
      signatures: { role: string; quality?: number }[];
    };
    expect(summary.signatures.map((item) => [item.role, item.quality ?? null])).toEqual([
      ['administrator', null],
      ['accountant', 22],
    ]);
    // 2026 has no package yet.
    expect((await s.refused(prepare({}, '2026')))?.code).toBe('FORMAT_GAP');
  });

  test('authorization checks the signature roles and the accompanying documents', async () => {
    const { s, prepare } = await company();
    await confirmSmall(s);
    await answerAnnual(s, 'S1003', 2025, 200_000);
    const findings = async (artifactId: string) =>
      (
        (await s.invoke<ActionView>(s.owner, 'declarations.authorize.request', { artifactId }))
          .preview as { findings: { code: string }[] }
      ).findings.map((item) => item.code);
    // A chief accountant (12) must be employed: the books have no employment contract.
    const chief = await prepare({ preparer: { name: 'Ionescu Maria', quality: 12 } });
    expect(await findings(chief.id)).toEqual([
      'NOT_VALIDATED',
      'SIGNATURE_NOT_EMPLOYED',
      'DOCUMENT_MISSING',
      'DOCUMENT_MISSING',
      'DOCUMENT_MISSING',
      'DOCUMENT_MISSING',
    ]);
    // Signed by a CECCAR member, with the four documents supplied from the engine's drafts.
    const artifact = await prepare({}, '2025');
    expect((await supplyDocuments(s, 'S1003', 2025)).sort()).toEqual([
      'administrators.report',
      'declaration',
      'notes',
      'profit.distribution',
    ]);
    expect(await findings(artifact.id)).toEqual(['NOT_VALIDATED']);
  });

  official(
    'ANAF’s validator accepts the statements prepared from the books',
    async () => {
      const { s, prepare } = await company(new DukIntegrator(dist));
      await confirmSmall(s);
      await answerAnnual(s, 'S1003', 2025, 200_000);
      const artifact = await prepare();
      expect(artifact.steps.map((step) => step.state)).toEqual(['prepared', 'validated_official']);
    },
    120_000,
  );
});

describe('S1046, the inactivity declaration', () => {
  /** A company set up in 2025 with its capital paid in and nothing else. */
  async function dormant(validator?: DukIntegrator) {
    const now = Date.parse('2026-01-20T10:00:00Z');
    const s = await scenario({
      year: 2025,
      cui,
      clock: () => now,
      ...(validator ? { declarationValidator: validator } : {}),
    });
    open.push(s);
    await s.invoke(s.owner, 'sales.seller.record', {
      details: {
        name: 'Exemplu Inactiv SRL',
        vatId: `RO${cui}`,
        address: { lines: ['Str. Lungă 10'], city: 'Galați', subdivision: 'RO-GL', country: 'RO' },
      },
    });
    await s.book(
      'ledger.general',
      journal(
        (await s.evidence('capital.pdf')).id,
        [
          { account: '5121', side: 'D', amount: '200.00' },
          { account: '1012', side: 'C', amount: '200.00' },
        ],
        { date: '2025-02-10' },
      ),
    );
    const prepare = (kind: string, options: Record<string, unknown>) =>
      s.invoke<Artifact>(s.owner, 'declarations.prepare', { kind, period: '2025', options });
    return { s, prepare };
  }
  const declaration = {
    tradeRegister: 'J17/123/2025',
    declarant: 'Popescu Ana',
    largeTaxpayer: false,
  };

  test('books without activity ask the fact; stated, the closure lists S1046 instead of the statements', async () => {
    const { s, prepare } = await dormant();
    const problems = async (operation: Promise<unknown>) =>
      ((await s.refused(operation))?.details as { problems: { code: string }[] }).problems.map(
        (problem) => problem.code,
      );
    expect(await problems(prepare('S1005', options))).toContain('ACTIVITY_UNKNOWN');
    expect(await problems(prepare('S1046', declaration))).toEqual(['ACTIVITY_NOT_STATED']);
    await s.invoke(s.owner, 'profile.record', {
      axis: 'activity.none',
      value: 'yes',
      effectiveFrom: '2025-01-01',
      evidenceId: (await s.evidence('declaratie-administrator.pdf')).id,
    });
    const closure = await s.invoke<{
      obligations: { kind: string; period: string; state: string }[];
    }>(s.owner, 'closure.evaluate', { from: '2025-01', to: '2025-12' });
    expect(
      closure.obligations.filter((item) => item.period === '2025').map((item) => item.kind),
    ).toContain('S1046');
    expect(closure.obligations.map((item) => item.kind)).not.toContain('S1005');
    expect(await problems(prepare('S1005', options))).toEqual(['INACTIVE']);
    const artifact = await prepare('S1046', declaration);
    expect(artifact.state).toBe('prepared');
    const xml = Buffer.from(await s.objects.get(s.company.id, artifact.xmlHash)).toString('utf8');
    expect(xml).toContain('tipBIL="DI"');
    expect(xml).toContain('capital="200"');
    const rows = await s.list<{ kind: string; period: string; due: string | null }>(
      s.owner,
      'obligations.calendar',
      { from: '2025-12', to: '2025-12' },
    );
    expect(rows.find((item) => item.kind === 'S1046')).toMatchObject({
      period: '2025',
      due: '2026-03-02',
    });
  });

  official(
    'ANAF’s validator accepts the declaration prepared from the books',
    async () => {
      const { s, prepare } = await dormant(new DukIntegrator(dist));
      await s.invoke(s.owner, 'profile.record', {
        axis: 'activity.none',
        value: 'yes',
        effectiveFrom: '2025-01-01',
        evidenceId: (await s.evidence('declaratie-administrator.pdf')).id,
      });
      const artifact = await prepare('S1046', declaration);
      expect(artifact.steps.map((step) => step.state)).toEqual(['prepared', 'validated_official']);
    },
    120_000,
  );
});
