import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
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

async function employer(validator?: DukIntegrator) {
  const s = await scenario({ cui, ...(validator ? { declarationValidator: validator } : {}) });
  open.push(s);
  for (const [axis, value] of [
    ['employer', 'yes'],
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
  const hire = async (name: [string, string], code: string, terms: Record<string, unknown>) => {
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
      ...terms,
    });
  };
  const payroll = async (entries: unknown[] = []) => {
    const run = await s.invoke<{ id: string }>(s.owner, 'payroll.runs.prepare', {
      month: '2026-10',
      workingDays: 22,
      entries,
    });
    await s.book('payroll.recognize', {
      runId: run.id,
      month: '2026-10',
      round: 1,
      authorityId: anaf.id,
    });
  };
  const prepare = () =>
    s.invoke<Artifact>(s.owner, 'declarations.prepare', {
      kind: 'D112',
      period: '2026-10',
      options: {
        declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' },
        caen: '6201',
        phone: '0236000000',
      },
    });
  return { s, hire, payroll, prepare };
}

describe('D112 from the books', () => {
  test('refuses a month with sick leave until the certificates are declared', async () => {
    const { s, hire, payroll, prepare } = await employer();
    // Above the minimum wage: a partial month on it leaves the relief to the expert.
    const { contractId } = await hire(['Popescu', 'Ana'], cnp('290050117002'), {
      baseSalary: '5000',
    });
    await payroll([
      {
        contractId,
        sickLeave: [
          {
            series: 'CCMAM',
            number: '9',
            code: '01',
            issued: '2026-10-05',
            from: '2026-10-05',
            to: '2026-10-09',
          },
        ],
        sickBase: { income: '24300', days: 121 },
      },
    ]);
    expect(JSON.stringify(await s.refused(prepare()))).toContain('D112_SICK_LEAVE');
  });

  test('needs the month posted', async () => {
    const { s, hire, prepare } = await employer();
    await hire(['Popescu', 'Ana'], cnp('290050117002'), { baseSalary: '4325' });
    expect(JSON.stringify(await s.refused(prepare()))).toContain('D112_RUN');
  });

  official(
    "declares the month's posted payroll and passes ANAF's validator",
    async () => {
      const { hire, payroll, prepare } = await employer(new DukIntegrator(dist));
      await hire(['Popescu', 'Ana'], cnp('290050117002'), { baseSalary: '4325' });
      await hire(['Georgescu', 'Elena'], cnp('285072217002'), {
        baseSalary: '2500',
        dailyHours: 4,
      });
      await payroll();
      const prepared = await prepare();
      expect([prepared.state, prepared.steps.at(-1)?.detail ?? null]).toEqual([
        'validated_official',
        null,
      ]);
      expect(JSON.parse(prepared.steps[0]!.detail!)).toMatchObject({ insured: 2 });
    },
    120_000,
  );
});
