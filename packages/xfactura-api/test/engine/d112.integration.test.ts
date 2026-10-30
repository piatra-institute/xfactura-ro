import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { payrollLines } from '../../source/engine/db/schema';
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
  /** Ill 5–9 October and 19–28 October, on a base from the stage certificate. */
  const sickMonth = async (validator?: DukIntegrator) => {
    const scene = await employer(validator);
    // Above the minimum wage: a partial month on it leaves the relief to the expert.
    const { contractId } = await scene.hire(['Popescu', 'Ana'], cnp('290050117002'), {
      baseSalary: '5000',
    });
    const certificate = (number: string, from: string, to: string) => ({
      series: 'CCMAM',
      number,
      code: '01',
      issued: from,
      from,
      to,
      place: 'family_doctor',
      diagnosis: '101',
    });
    await scene.payroll([
      {
        contractId,
        sickLeave: [
          certificate('9', '2026-10-05', '2026-10-09'),
          certificate('10', '2026-10-19', '2026-10-28'),
        ],
        sickBase: { income: '24300', days: 121 },
      },
    ]);
    return { ...scene, prepared: await scene.prepare() };
  };

  test('declares the certificates the payroll paid, in sections B and D', async () => {
    const { s, prepared } = await sickMonth();
    expect(prepared.state).toBe('prepared');
    const xml = (
      await s.objects.get(s.company.id, (prepared as unknown as { xmlHash: string }).xmlHash)
    ).toString();
    // 24,300 / 121 = 200.826 lei a day: the payroll pays on 200.82, D112 states 200.83. 5–9
    // October: the first day unpaid, 4 by the employer at 55% (442 lei). 19–28 October: 8 working
    // days, the first unpaid, 5 by the employer (653) and 2 by FNUASS (261) at 65%.
    expect(xml.match(/<asiguratD [^>]*\/>/g)).toEqual([
      '<asiguratD D_1="CCMAM" D_2="9" D_5="05.10.2026" D_6="05.10.2026" D_7="09.10.2026"' +
        ' D_9="01" D_9b="1" D_10="1" D_14a="5" D_14="4" D_15a="0" D_15="0" D_16a="5" D_16="4"' +
        ' D_17="24300" D_18="121" D_19="200.83" D_20="442" D_21="0" D_23="101" D_28="55"/>',
      '<asiguratD D_1="CCMAM" D_2="10" D_5="19.10.2026" D_6="19.10.2026" D_7="28.10.2026"' +
        ' D_9="01" D_9b="1" D_10="1" D_14a="6" D_14="5" D_15a="2" D_15="2" D_16a="8" D_16="7"' +
        ' D_17="24300" D_18="121" D_19="200.83" D_20="653" D_21="261" D_23="101" D_28="65"/>',
    ]);
    expect(xml).toContain('<asiguratB3 B3_1="11"');
    expect(xml).toContain('B1_6="72" B1_7="104"');
    expect(xml).toContain('C2_T6="261" C2_10="261" C2_140="261"');
    expect(xml).not.toContain('<asiguratA ');
    // The payroll keeps the diagnosis sealed; only the declaration opens it.
    const inputs = await s.engine.db.read((tx) =>
      tx
        .select({ input: payrollLines.input })
        .from(payrollLines)
        .where(eq(payrollLines.companyId, s.company.id)),
    );
    expect(inputs.map((row) => row.input).join()).toContain('"diagnosisSealed":"v1.');
    expect(inputs.map((row) => row.input).join()).not.toContain('"diagnosis"');
  });

  test('refuses sick pay without certificates, and certificates D112 cannot describe', async () => {
    const manual = await employer();
    const { contractId } = await manual.hire(['Popescu', 'Ana'], cnp('290050117002'), {
      baseSalary: '5000',
    });
    await manual.payroll([
      {
        contractId,
        items: [
          { kind: 'salary', amount: '5000', label: 'Salariu de bază' },
          { kind: 'sick_employer', amount: '100', label: 'Concediu medical' },
        ],
      },
    ]);
    expect(JSON.stringify(await manual.s.refused(manual.prepare()))).toContain('D112_SICK_ITEMS');

    const unplaced = await employer();
    const ana = await unplaced.hire(['Popescu', 'Ana'], cnp('290050117002'), {
      baseSalary: '5000',
    });
    await unplaced.payroll([
      {
        contractId: ana.contractId,
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
    expect(JSON.stringify(await unplaced.s.refused(unplaced.prepare()))).toContain(
      'D112_SICK_CERTIFICATE',
    );
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

  official(
    "declares a month with medical leave and passes ANAF's validator",
    async () => {
      const { prepared } = await sickMonth(new DukIntegrator(dist));
      expect([prepared.state, prepared.steps.at(-1)?.detail ?? null]).toEqual([
        'validated_official',
        null,
      ]);
    },
    120_000,
  );
});
