import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import * as payrollAgent from 'xfactura-core/ro/payroll/agent';
import type { ProposalView } from '../../source/engine/kernel/views';
import { DukIntegrator } from '../../source/engine/adapters/declaration-validator';
import { scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});
const dist = path.join(import.meta.dir, '../../../..', '.validators/anaf/dist');
const official = DukIntegrator.available(dist) && Bun.which('java') ? test : test.skip;
const cui = '18547290';

/** A synthetic CNP with a valid control digit. */
function cnp(body: string) {
  const weights = [2, 7, 9, 1, 4, 6, 3, 5, 8, 2, 7, 9];
  const control =
    weights.reduce((sum, weight, index) => sum + weight * Number(body[index]), 0) % 11;
  return `${body}${control === 10 ? 1 : control}`;
}

type Artifact = { state: string; steps: { state: string; detail: string | null }[] };
type Obligation = { kind: string; period: string; due: string | null; status: string };

/**
 * A micro-enterprise with two employees in 2026 and fewer than 3 on average in 2025: it pays and
 * files D112 quarterly (Codul fiscal art. 80 alin. (2) lit. c), art. 147 alin. (4)), recorded as
 * the year's determination. Each month of the third quarter is computed and declared on its own.
 */
async function employer(period: 'quarterly' | 'monthly', validator?: DukIntegrator) {
  const s = await scenario({ cui, ...(validator ? { declarationValidator: validator } : {}) });
  open.push(s);
  for (const [axis, value] of [
    ['entity.form', 'srl'],
    ['vat.status', 'non_vat'],
    ['vat.eu', 'none'],
    ['income_tax', 'micro'],
    ['employer', 'yes'],
    ['payroll.period', period],
    ['policy.payroll.employer_share', '635'],
  ])
    await s.invoke(s.owner, 'profile.record', {
      axis,
      value,
      effectiveFrom: '2026-01-01',
      evidenceId: (await s.evidence(`${axis}.pdf`)).id,
    });
  await s.invoke(s.owner, 'sales.seller.record', {
    details: {
      name: 'Exemplu Servicii SRL',
      vatId: `RO${cui}`,
      address: { lines: ['Str. Lungă 10'], city: 'Galați', subdivision: 'RO-GL', country: 'RO' },
    },
  });
  const anaf = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
    kind: 'ro_public_institution',
    country: 'RO',
    name: 'ANAF',
  });
  const hire = async (name: [string, string], code: string, baseSalary: string) => {
    const employee = await s.invoke<{ id: string }>(s.owner, 'payroll.employees.record', {
      lastName: name[0],
      firstName: name[1],
      cnp: code,
      healthFund: 'RO-GL',
    });
    return s.invoke<{ contractId: string }>(s.owner, 'payroll.contracts.record', {
      employeeId: employee.id,
      number: `CIM-${name[0]}`,
      startDate: '2025-02-15',
      effectiveFrom: '2025-02-15',
      dailyHours: 8,
      mainJob: true,
      occupation: '251201',
      baseSalary,
    });
  };
  const payroll = async (month: string, entries: unknown[] = []) => {
    const run = await s.invoke<{ id: string }>(s.owner, 'payroll.runs.prepare', {
      month,
      entries,
    });
    return s.book('payroll.recognize', { runId: run.id, month, round: 1, authorityId: anaf.id });
  };
  const prepare = (month: string) =>
    s.invoke<Artifact>(s.owner, 'declarations.prepare', {
      kind: 'D112',
      period: month,
      options: {
        declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' },
        caen: '6201',
        phone: '0236000000',
      },
    });
  const calendar = async () =>
    (
      await s.list<Obligation>(s.owner, 'obligations.calendar', {
        from: '2026-07',
        to: '2026-09',
        today: '2026-08-01',
      })
    )
      .filter((item) => item.kind === 'D112')
      .map((item) => `${item.period} ${item.due ?? '-'}`);
  const ana = await hire(['Popescu', 'Ana'], cnp('290050117002'), '5000');
  await hire(['Georgescu', 'Elena'], cnp('285072217002'), '4325');
  return { s, payroll, prepare, calendar, ana };
}

/** The due dates the posting gave the tax and contributions owed (4315, 4316, 444, 436). */
const taxDue = (proposal: ProposalView) => [
  ...new Set(
    proposal
      .effect!.openItems.filter((item) => item.kind === 'tax.payable')
      .map((item) => item.dueDate ?? null),
  ),
];

/** Ill 10–14 August: a medical certificate of the second month. */
const sickAugust = (contractId: string) => [
  {
    contractId,
    sickLeave: [
      {
        series: 'CCMAM',
        number: '21',
        code: '01',
        issued: '2026-08-10',
        from: '2026-08-10',
        to: '2026-08-14',
        place: 'family_doctor',
        diagnosis: '101',
      },
    ],
    sickBase: { income: '24300', days: 121 },
  },
];

const summaryOf = (artifact: Artifact) =>
  JSON.parse(artifact.steps[0]!.detail!) as { filing: Record<string, unknown> | null };

describe('quarterly D112 (art. 80 alin. (2), art. 147 alin. (4)–(11))', () => {
  test('a quarter: three monthly computations, one return per month, all due after the quarter', async () => {
    const { s, payroll, prepare, calendar } = await employer('quarterly');
    const posted = [];
    for (const month of ['2026-07', '2026-08', '2026-09']) posted.push(await payroll(month));
    // 25 October 2026 is a Sunday: the tax and contributions of each month are paid by the 26th.
    expect(posted.map(taxDue)).toEqual([['2026-10-26'], ['2026-10-26'], ['2026-10-26']]);
    expect(await calendar()).toEqual([
      '2026-07 2026-10-26',
      '2026-08 2026-10-26',
      '2026-09 2026-10-26',
    ]);
    // The worklist raises each month's D112 (module.detectors).
    const work = await s.list<{ kind: string; subject: { id: string } }>(s.owner, 'work.list', {});
    expect(
      work.filter((item) => item.subject.id.startsWith('D112|2026-0')).map((item) => item.kind),
    ).toEqual(expect.arrayContaining(['obligation.due']));
    expect(payrollAgent.detectors.map((item) => `${item.kind} ${item.code}`)).toContain(
      'obligation.due D112',
    );
    for (const month of ['2026-07', '2026-08', '2026-09']) {
      const prepared = await prepare(month);
      expect(prepared.state).toBe('prepared');
      expect(summaryOf(prepared).filing).toEqual({
        period: 'quarterly',
        month,
        deadline: 'D112.quarterly',
        counted: '2026-Q3',
        basis: 'quarterly',
        event: null,
      });
    }
  });

  test('sick leave in August: July and August by 25 September, September after the quarter; payment stays quarterly', async () => {
    const { payroll, prepare, calendar, ana } = await employer('quarterly');
    await payroll('2026-07');
    const august = await payroll('2026-08', sickAugust(ana.contractId));
    await payroll('2026-09');
    expect(await calendar()).toEqual([
      '2026-07 2026-09-25',
      '2026-08 2026-09-25',
      '2026-09 2026-10-26',
    ]);
    // Art. 147 alin. (11) moves the declaration, not the payment (art. 80 alin. (2), art. 146
    // alin. (3), art. 168 alin. (3), art. 220^6 alin. (1)).
    expect(taxDue(august)).toEqual(['2026-10-26']);
    expect(summaryOf(await prepare('2026-07')).filing).toMatchObject({
      deadline: 'D112',
      counted: '2026-08',
      basis: 'event',
      event: '2026-08',
    });
    expect(summaryOf(await prepare('2026-09')).filing).toMatchObject({
      deadline: 'D112.quarterly',
      basis: 'quarterly',
    });
  });

  test('the option for monthly filing (art. 147 alin. (8)): each month by the 25th of the next', async () => {
    const { payroll, calendar } = await employer('monthly');
    expect(taxDue(await payroll('2026-07'))).toEqual(['2026-08-25']);
    expect(await calendar()).toEqual([
      '2026-07 2026-08-25',
      '2026-08 2026-09-25',
      '2026-09 2026-10-26',
    ]);
  });

  official(
    "each month of the quarter, the sick month included, passes ANAF's validator",
    async () => {
      const { payroll, prepare, ana } = await employer('quarterly', new DukIntegrator(dist));
      await payroll('2026-07');
      await payroll('2026-08', sickAugust(ana.contractId));
      await payroll('2026-09');
      for (const month of ['2026-07', '2026-08', '2026-09']) {
        const prepared = await prepare(month);
        expect([month, prepared.state, prepared.steps.at(-1)?.detail ?? null]).toEqual([
          month,
          'validated_official',
          null,
        ]);
      }
    },
    240_000,
  );
});
