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
  return { s, anaf, hire, payroll, prepare };
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
    // The payroll keeps each certificate sealed whole, its diagnosis sealed within; only the
    // declaration opens them.
    const inputs = await s.engine.db.read((tx) =>
      tx
        .select({ input: payrollLines.input })
        .from(payrollLines)
        .where(eq(payrollLines.companyId, s.company.id)),
    );
    const kept = inputs.map((row) => row.input).join();
    expect(kept).toContain('"sick":[{"sealed":"v1.');
    expect(kept).not.toContain('"diagnosis');
    expect(kept).not.toContain('CCMAM');
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

describe('D112 for January 2026, in the structure of 01–06/2026', () => {
  const firstHalf = path.join(import.meta.dir, '../../../..', '.validators/anaf-d112-0126/dist');
  const both =
    DukIntegrator.available(dist) && DukIntegrator.available(firstHalf) && Bun.which('java')
      ? test
      : test.skip;

  /** Ill 12–23 January (code 01), on maternity leave all month (08), and after a work accident
   * the pension house confirmed 19–30 January (03), each on a base from a stage certificate. */
  const january = async (validator?: DukIntegrator) => {
    const scene = await employer(validator);
    const sick = await scene.hire(['Popescu', 'Ana'], cnp('290050117002'), { baseSalary: '6000' });
    const mother = await scene.hire(['Ionescu', 'Maria'], cnp('291030117002'), {
      baseSalary: '6000',
    });
    const injured = await scene.hire(['Georgescu', 'Ion'], cnp('185072217002'), {
      baseSalary: '6000',
    });
    const certificate = (number: string, code: string, from: string, to: string) => ({
      series: 'CCMAM',
      number,
      code,
      issued: from,
      from,
      to,
      place: 'ambulatory',
      diagnosis: '101',
    });
    const run = await scene.s.invoke<{
      id: string;
      issues: number;
      lines: { name: string; cash: string; cas: string; cass: string; tax: string }[];
    }>(scene.s.owner, 'payroll.runs.prepare', {
      month: '2026-01',
      entries: [
        {
          contractId: sick.contractId,
          sickLeave: [certificate('2001', '01', '2026-01-12', '2026-01-23')],
          sickBase: { income: '36000', days: 127 },
        },
        {
          contractId: mother.contractId,
          activeDays: 0,
          sickLeave: [
            { ...certificate('2002', '08', '2026-01-01', '2026-01-31'), diagnosis: '806' },
          ],
          sickBase: { income: '24300', days: 123 },
        },
        {
          contractId: injured.contractId,
          sickLeave: [
            {
              ...certificate('2003', '03', '2026-01-19', '2026-01-30'),
              place: 'hospital',
              diagnosis: 'S52',
              accidentConfirmed: true,
            },
          ],
          sickBase: { income: '6000', days: 18 },
        },
      ],
    });
    const recognized = await scene.s.propose('payroll.recognize', {
      runId: run.id,
      month: '2026-01',
      round: 1,
      authorityId: scene.anaf.id,
    });
    await scene.s.post(await scene.s.approve(recognized));
    const prepared = await scene.s.invoke<Artifact & { xmlHash: string }>(
      scene.s.owner,
      'declarations.prepare',
      {
        kind: 'D112',
        period: '2026-01',
        options: {
          declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' },
          caen: '6201',
          phone: '0236000000',
        },
      },
    );
    const xml = prepared.xmlHash
      ? (await scene.s.objects.get(scene.s.company.id, prepared.xmlHash)).toString()
      : '';
    return { ...scene, run, recognized, prepared, xml };
  };

  test('computes the month from the register of January 2026 and declares it without the fields 07/2026 added', async () => {
    const { run, recognized, prepared, xml } = await january();
    expect(run.issues).toBe(0);
    // Popescu: 283.46 lei a day × 65% (12 days), none lost (issued before 1 February): 5 days by
    // the employer (921 lei) and 5 by FNUASS (921 lei); 8 of the 18 days worked, 6,000 × 8 / 18.
    // Ionescu: 197.56 lei a day × 85% × 18 days = 3,023 lei, all from FNUASS, untaxed.
    // Georgescu: 333.33 lei a day × 80%: 3 days by the employer (800 lei), 7 by the state social
    // insurance budget (1,867 lei).
    expect(run.lines.map((line) => [line.name, line.cash])).toEqual([
      ['Georgescu Ion', '5334.00'],
      ['Ionescu Maria', '3023.00'],
      ['Popescu Ana', '4509.00'],
    ]);
    expect(
      recognized.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`),
    ).toEqual(expect.arrayContaining(['D 4382 5811.00']));
    expect(prepared.state).toBe('prepared');
    expect(xml.match(/<asiguratD [^>]*\/>/g)?.sort()).toEqual([
      '<asiguratD D_1="CCMAM" D_2="2001" D_5="12.01.2026" D_6="12.01.2026" D_7="23.01.2026"' +
        ' D_9="01" D_10="3" D_14="5" D_15="5" D_16="10" D_17="36000" D_18="127" D_19="283.46"' +
        ' D_20="921" D_21="921" D_23="101" D_28="65"/>',
      '<asiguratD D_1="CCMAM" D_2="2002" D_5="01.01.2026" D_6="01.01.2026" D_7="31.01.2026"' +
        ' D_9="08" D_10="3" D_14="0" D_15="18" D_16="18" D_17="24300" D_18="123" D_19="197.56"' +
        ' D_20="0" D_21="3023" D_23="806"/>',
    ]);
    for (const field of ['D_9b', 'D_14a', 'D_15a', 'D_16a', 'B3_7D', 'C2_155', 'C2_156'])
      expect([field, xml.includes(` ${field}=`)]).toEqual([field, false]);
    expect(xml).toContain('C2_31="1" C2_32="18" C2_34="18" C2_36="3023"');
    expect(xml).toContain('C2_T6="3944"');
    expect(xml).toMatch(/B3_8="10" B3_9="1867" B3_10="800" B3_11="2667"/);
    expect(xml).toContain('C3_11="1" C3_12="10" C3_13="2667" C3_14="1867"');
    expect(xml).toContain('C1_7="1867"');
  }, 120_000);

  both(
    "passes ANAF's J26.0.3, published for 01–06/2026, and the general kit's J27.0.8",
    async () => {
      const { prepared, xml } = await january(new DukIntegrator(dist));
      expect([prepared.state, prepared.steps.at(-1)?.detail ?? null]).toEqual([
        'validated_official',
        null,
      ]);
      expect(
        await new DukIntegrator(firstHalf).validate('D112', new TextEncoder().encode(xml)),
      ).toEqual({ ok: true, messages: [] });
    },
    120_000,
  );
});
