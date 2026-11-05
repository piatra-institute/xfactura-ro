import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import * as payrollAgent from 'xfactura-core/ro/payroll/agent';
import { questionKindIds } from 'xfactura-core/questions/kinds';
import type { ParameterRegister } from 'xfactura-core/rules';
import { DukIntegrator } from '../../source/engine/adapters/declaration-validator';
import { workKinds } from '../../source/engine/kernel/work';
import type { ProposalView } from '../../source/engine/kernel/views';
import { scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});
const dist = path.join(import.meta.dir, '../../../..', '.validators/anaf/dist');
const validator =
  DukIntegrator.available(dist) && Bun.which('java') ? new DukIntegrator(dist) : null;
const cui = '18547290';

/** A synthetic CNP with a valid control digit. */
function cnp(body: string) {
  const weights = [2, 7, 9, 1, 4, 6, 3, 5, 8, 2, 7, 9];
  const control =
    weights.reduce((sum, weight, index) => sum + weight * Number(body[index]), 0) % 11;
  return `${body}${control === 10 ? 1 : control}`;
}

type Line = {
  contractId: string;
  cash: string;
  cas: string;
  cass: string;
  tax: string;
  net: string;
  inKind: string;
  garnished: { orderId: string; partyId: string; amount: string }[];
  issues: { code: string; message: string }[];
};
type Run = { id: string; round: number; corrects: string | null; issues: number; lines: Line[] };
type Artifact = { id: string; state: string; xmlHash: string; steps: { detail: string | null }[] };

async function employer(options: { register?: ParameterRegister; official?: boolean } = {}) {
  const s = await scenario({
    cui,
    ...(options.official && validator ? { declarationValidator: validator } : {}),
    ...(options.register ? { register: options.register } : {}),
  });
  open.push(s);
  for (const [axis, value] of [
    ['employer', 'yes'],
    ['policy.payroll.employer_share', '635'],
    ['income_tax', 'profit'],
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
    const employee = await s.invoke<{ id: string; partyId: string }>(
      s.owner,
      'payroll.employees.record',
      { lastName: name[0], firstName: name[1], cnp: code, healthFund: 'RO-GL' },
    );
    const contract = await s.invoke<{ contractId: string }>(s.owner, 'payroll.contracts.record', {
      employeeId: employee.id,
      number: `CIM-${name[0]}`,
      startDate: '2025-02-15',
      effectiveFrom: '2025-02-15',
      dailyHours: 8,
      mainJob: true,
      occupation: '251201',
      ...terms,
    });
    return { ...employee, contractId: contract.contractId };
  };
  const prepare = (input: Record<string, unknown> = {}) =>
    s.invoke<Run>(s.owner, 'payroll.runs.prepare', { month: '2026-10', workingDays: 22, ...input });
  const recognize = (run: Run, extra: Record<string, unknown> = {}) =>
    s.propose('payroll.recognize', {
      runId: run.id,
      month: '2026-10',
      round: run.round,
      authorityId: anaf.id,
      ...extra,
    });
  const declare = (options: Record<string, unknown> = {}) =>
    s.invoke<Artifact>(s.owner, 'declarations.prepare', {
      kind: 'D112',
      period: '2026-10',
      options: {
        declarant: { lastName: 'Popescu', firstName: 'Ana', role: 'Administrator' },
        caen: '6201',
        phone: '0236000000',
        ...options,
      },
    });
  const xml = async (artifact: Artifact) =>
    (await s.objects.get(s.company.id, artifact.xmlHash)).toString();
  return { s, anaf, hire, prepare, recognize, declare, xml };
}

const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`) ?? [];
/** ANAF's validator ran and passed, or is absent: then the declaration is only prepared, and the
 * report counts it as skipped, never as passed. */
const validated = (artifact: Artifact) =>
  expect(artifact.state).toBe(validator ? 'validated_official' : 'prepared');

describe('benefits in kind', () => {
  test("a company car used privately is income in every base, booked 641 = 421 = 7588, and in D112's E3_44", async () => {
    const { s, hire, prepare, recognize, declare, xml } = await employer({ official: true });
    const { contractId } = await hire(['Popescu', 'Ana'], cnp('290050117002'), {
      baseSalary: '8000',
    });
    const evidenceId = (await s.evidence('fisa-mijloc-fix.pdf')).id;
    const run = await prepare({
      entries: [
        {
          contractId,
          items: [{ kind: 'salary', amount: '8000', label: 'Salariu de bază' }],
          benefits: [
            {
              kind: 'car',
              label: 'Autoturism B-123-XFA',
              inputValue: '120000',
              passenger: true,
              exclusiveBusiness: true,
              evidenceId,
            },
          ],
        },
      ],
    });
    // 1.7% × 120,000 lei = 2,040 lei: CAS 2,510, CASS 1,004, the tax on 6,526 lei.
    expect(run.lines[0]).toMatchObject({
      cash: '8000.00',
      inKind: '2040.00',
      cas: '2510.00',
      cass: '1004.00',
      tax: '653.00',
      net: '3833.00',
      issues: [],
    });
    const posted = await s.post(await s.approve(await recognize(run)));
    expect(lines(posted)).toEqual(
      expect.arrayContaining([
        'D 641 10040.00',
        'C 421 10040.00',
        'D 421 4167.00',
        'D 421 2040.00',
        'C 7588 2040.00',
        'C 4315 2510.00',
        'C 4316 1004.00',
        'C 444 653.00',
        'D 646 226.00',
        'C 436 226.00',
      ]),
    );
    const declared = await declare();
    validated(declared);
    const text = await xml(declared);
    expect(text).toContain('E3_8="10040"');
    expect(text).toContain('E3_60="2040"');
    expect(text).toContain('E3_44="2040"');
    expect(text).toContain('A_13="10040"');
  }, 120_000);

  test('holiday vouchers above 6 minimum wages a year (Legea nr. 165/2018 art. 24 alin. (3)): the excess is a benefit in every base, in E3_44', async () => {
    const { s, hire, prepare, recognize, declare, xml } = await employer({ official: true });
    const { contractId } = await hire(['Popescu', 'Ana'], cnp('290050117002'), {
      baseSalary: '30000',
    });
    const run = await prepare({
      entries: [
        {
          contractId,
          items: [
            { kind: 'salary', amount: '30000', label: 'Salariu de bază' },
            { kind: 'holiday_vouchers', amount: '27000', label: 'Vouchere de vacanță' },
          ],
        },
      ],
    });
    // 6 × 4,325 = 25,950 lei stay vouchers (outside the CAS base); 1,050 lei are a benefit in
    // every base: CAS on 30,000 + 1,050 lei.
    expect(run.lines[0]).toMatchObject({ inKind: '1050.00', cas: '7763.00', issues: [] });
    await s.post(await s.approve(await recognize(run)));
    const declared = await declare();
    validated(declared);
    const text = await xml(declared);
    expect(text).toContain('E3_44="1050"');
  }, 120_000);

  test('meal vouchers above 45 lei a day from October 2026: the indexation order is not in the register, the line stops', async () => {
    const { hire, prepare } = await employer();
    const { contractId } = await hire(['Popescu', 'Ana'], cnp('290050117002'), {
      baseSalary: '8000',
    });
    const run = await prepare({
      entries: [
        {
          contractId,
          items: [
            { kind: 'salary', amount: '8000', label: 'Salariu de bază' },
            { kind: 'meal_vouchers', amount: '1100', label: 'Tichete de masă' },
          ],
        },
      ],
    });
    expect(run.lines[0]!.issues.map((issue) => issue.code)).toEqual(['VOUCHER_INDEXATION']);
    // Within 22 × 45 lei the line is computed.
    const within = await prepare({
      entries: [
        {
          contractId,
          items: [
            { kind: 'salary', amount: '8000', label: 'Salariu de bază' },
            { kind: 'meal_vouchers', amount: '990', label: 'Tichete de masă' },
          ],
        },
      ],
    });
    expect(within.lines[0]!.issues).toEqual([]);
  }, 120_000);
});

describe('the other medical-leave codes', () => {
  test('maternity (code 08) on the register as it stands: 85% (OUG nr. 158/2005 art. 25) borne by FNUASS from the first day, untaxed, its CAS declared in B3 and C2 rd. 3', async () => {
    const { s, hire, prepare, recognize, declare, xml } = await employer({ official: true });
    const { contractId } = await hire(['Ionescu', 'Maria'], cnp('290050117002'), {
      baseSalary: '6000',
    });
    const run = await prepare({
      entries: [
        {
          contractId,
          activeDays: 0,
          sickLeave: [
            {
              series: 'CCMAM',
              number: '501',
              code: '08',
              issued: '2026-10-01',
              from: '2026-10-01',
              to: '2026-10-31',
              place: 'ambulatory',
              diagnosis: '806',
            },
          ],
          sickBase: { income: '25950', days: 126 },
        },
      ],
    });
    // 25,950 / 126 = 205.95 lei a day × 85% × 22 days = 3,851 lei, all from FNUASS.
    expect(run.lines[0]).toMatchObject({
      cash: '3851.00',
      cas: '963.00',
      cass: '0.00',
      tax: '0.00',
      net: '2888.00',
      issues: [],
    });
    const posted = await s.post(await s.approve(await recognize(run)));
    expect(lines(posted)).toEqual(
      expect.arrayContaining(['D 4382 3851.00', 'C 421 3851.00', 'C 4315 963.00']),
    );
    expect(lines(posted).some((line) => line.includes(' 646 '))).toBe(false);
    const declared = await declare();
    validated(declared);
    const text = await xml(declared);
    expect(text).toMatch(/<asiguratD [^>]*D_9="08"[^>]*D_14a="0" D_14="0" D_15a="22" D_15="22"/);
    expect(text).toContain('D_20="0"');
    expect(text).toContain('D_21="3851"');
    expect(text).not.toContain('D_28=');
    expect(text).toContain('C2_31="1" C2_32="22" C2_34="22" C2_36="3851"');
    expect(text).toContain('C2_T6="3851"');
    expect(text).toContain('B3_7="3851"');
  }, 120_000);

  test('maternal risk (code 15) on the register as it stands: 75% from FNUASS, part of the month worked', async () => {
    const { s, hire, prepare, recognize, declare, xml } = await employer({ official: true });
    const { contractId } = await hire(['Ionescu', 'Maria'], cnp('290050117002'), {
      baseSalary: '6000',
    });
    const run = await prepare({
      entries: [
        {
          contractId,
          sickLeave: [
            {
              series: 'CCMAM',
              number: '502',
              code: '15',
              issued: '2026-10-19',
              from: '2026-10-19',
              to: '2026-10-30',
              place: 'family_doctor',
              diagnosis: 'O26',
            },
          ],
          sickBase: { income: '25950', days: 126 },
        },
      ],
    });
    // 12 working days at work (6,000 × 12 / 22 = 3,273 lei) and 10 of maternal risk: 205.95 lei
    // a day × 75% × 10 = 1,545 lei, untaxed and outside CASS.
    expect(run.lines[0]).toMatchObject({ cash: '4818.00', issues: [] });
    const posted = await s.post(await s.approve(await recognize(run)));
    expect(lines(posted)).toEqual(expect.arrayContaining(['D 4382 1545.00']));
    const declared = await declare();
    validated(declared);
    const text = await xml(declared);
    expect(text).toMatch(/<asiguratD [^>]*D_9="15"[^>]*D_15="10"/);
    expect(text).toContain('D_23="RM"');
    expect(text).toContain('C2_51="1" C2_52="10" C2_54="10" C2_56="1545"');
  }, 120_000);

  test('cancer (code 14): 100% (OUG nr. 158/2005 art. 17 alin. (2)), the employer’s days after the reduced one, taxed and outside CASS', async () => {
    const { s, hire, prepare, recognize, declare, xml } = await employer({ official: true });
    const { contractId } = await hire(['Ionescu', 'Maria'], cnp('290050117002'), {
      baseSalary: '6000',
    });
    const run = await prepare({
      entries: [
        {
          contractId,
          sickLeave: [
            {
              series: 'CCMAM',
              number: '503',
              code: '14',
              issued: '2026-10-05',
              from: '2026-10-05',
              to: '2026-10-09',
              place: 'ambulatory',
              diagnosis: 'C50',
            },
          ],
          sickBase: { income: '25950', days: 126 },
        },
      ],
    });
    // The first working day is not paid; 205.95 lei a day × 100% × 4 days = 824 lei, borne by
    // the employer.
    expect(run.lines[0]!.issues).toEqual([]);
    const posted = await s.post(await s.approve(await recognize(run)));
    expect(lines(posted).some((line) => line.includes(' 4382 '))).toBe(false);
    const declared = await declare();
    validated(declared);
    const text = await xml(declared);
    expect(text).toMatch(/<asiguratD [^>]*D_9="14"[^>]*D_14="4"/);
    expect(text).toContain('D_20="824"');
    expect(text).toContain('D_21="0"');
    expect(text).not.toContain('D_28=');
  }, 120_000);

  test('a work accident (code 03) the pension house confirmed: 80% (Legea nr. 346/2002), the employer’s 3 days and the state budget’s, in B3 and C3, not in section D', async () => {
    const { s, hire, prepare, recognize, declare, xml } = await employer({ official: true });
    const { contractId } = await hire(['Georgescu', 'Ion'], cnp('185072217002'), {
      baseSalary: '6000',
    });
    const certificate = {
      series: 'CCMAM',
      number: '601',
      code: '03',
      issued: '2026-10-05',
      from: '2026-10-05',
      to: '2026-10-16',
      place: 'hospital',
      diagnosis: 'S52',
    };
    // Not yet confirmed: how it is paid and declared until then is the expert's.
    const unconfirmed = await prepare({
      entries: [{ contractId, sickLeave: [certificate], sickBase: { income: '6000', days: 22 } }],
    });
    expect(unconfirmed.lines[0]!.issues.map((issue) => issue.code)).toEqual([
      'SICK_ACCIDENT_UNCONFIRMED',
    ]);
    const run = await prepare({
      entries: [
        {
          contractId,
          sickLeave: [{ ...certificate, accidentConfirmed: true }],
          // Art. 19: the monthly average of the gross salary income, the month's working days.
          sickBase: { income: '6000', days: 22 },
        },
      ],
    });
    // 272.72 lei a day × 80%: 655 lei for the employer's 3 days, 1,527 lei for the other 7; the
    // 12 days worked are 3,273 lei. CAS and CASS only on the salary.
    expect(run.lines[0]).toMatchObject({
      cash: '5455.00',
      cas: '818.00',
      cass: '327.00',
      issues: [],
    });
    const posted = await s.post(await s.approve(await recognize(run)));
    expect(lines(posted)).toEqual(expect.arrayContaining(['D 4382 1527.00']));
    const declared = await declare();
    validated(declared);
    const text = await xml(declared);
    expect(text).not.toContain('<asiguratD ');
    expect(text).toMatch(/<asiguratB3 [^>]*B3_1="10"[^>]*B3_4="7"[^>]*B3_6="0"/);
    expect(text).toMatch(/B3_8="10" B3_9="1527" B3_10="655" B3_11="2182"/);
    expect(text).toContain('C3_11="1" C3_12="10" C3_13="2182" C3_14="1527"');
    expect(text).toContain('C1_7="1527"');
  }, 120_000);
});

describe('payroll corrections', () => {
  test('an error found after posting: a second round books the difference and the D112 is rectifying', async () => {
    const { s, hire, prepare, recognize, declare, xml } = await employer({ official: true });
    const { contractId } = await hire(['Popescu', 'Ana'], cnp('290050117002'), {
      baseSalary: '5000',
    });
    const first = await prepare();
    await s.post(await s.approve(await recognize(first)));
    validated(await declare());
    // The month cannot be computed again without a correction's reason and document.
    expect((await s.refused(prepare()))?.code).toBe('RUN_POSTED');
    const document = (await s.evidence('nota-de-constatare.pdf')).id;
    expect(
      (await s.refused(prepare({ correction: { reason: 'legal', evidenceId: document } })))?.code,
    ).toBe('CORRECTION_LEGAL');
    const second = await prepare({
      correction: { reason: 'error', evidenceId: document },
      entries: [
        {
          contractId,
          items: [
            { kind: 'salary', amount: '5000', label: 'Salariu de bază' },
            { kind: 'bonus', amount: '500', label: 'Prima omisă' },
          ],
        },
      ],
    });
    expect([second.round, second.corrects]).toEqual([2, first.id]);
    const corrected = await s.post(
      await s.approve(await recognize(second, { date: '2026-10-31', corrects: first.id })),
    );
    // 500 lei more: CAS 125, CASS 50, the tax 54 lei more, CAM 11 lei more.
    expect(lines(corrected)).toEqual([
      'D 641 500.00',
      'C 421 500.00',
      'D 421 229.00',
      'C 4315 125.00',
      'C 4316 50.00',
      'C 444 54.00',
      'D 646 11.00',
      'C 436 11.00',
    ]);
    // The month's D112 is now the corrected run; it must be stated rectifying.
    expect(JSON.stringify(await s.refused(declare()))).toContain('D112_RECTIFYING');
    const rectifying = await declare({ rectifying: true });
    validated(rectifying);
    const text = await xml(rectifying);
    expect(text).toContain('d_rec="1"');
    expect(text).toContain('E3_8="5500"');
    expect(JSON.parse(rectifying.steps[0]!.detail!)).toMatchObject({
      rectifying: true,
      runId: second.id,
    });
  }, 180_000);
});

describe('garnishments', () => {
  test('a garnishment takes up to a third of the net, is owed to the creditor on 427, and stops when paid', async () => {
    const { s, hire, prepare, recognize } = await employer();
    const { contractId } = await hire(['Popescu', 'Ana'], cnp('290050117002'), {
      baseSalary: '8000',
    });
    const bailiff = await s.invoke<{ id: string }>(s.owner, 'parties.create', {
      kind: 'ro_individual',
      country: 'RO',
      name: 'Executor judecătoresc Ionescu',
    });
    const order = await s.invoke<{ id: string }>(s.owner, 'payroll.garnishments.record', {
      contractId,
      partyId: bailiff.id,
      kind: 'other',
      reference: 'Dosar 123/2026',
      receivedOn: '2026-09-20',
      total: '2000',
      share: [1, 3],
      evidenceId: (await s.evidence('adresa-poprire.pdf')).id,
    });
    const run = await prepare();
    // Net 4,680 lei: a third is 1,560 lei.
    expect(run.lines[0]).toMatchObject({
      net: '4680.00',
      garnished: [{ orderId: order.id, partyId: bailiff.id, amount: '1560.00' }],
    });
    const posted = await s.post(await s.approve(await recognize(run)));
    expect(lines(posted)).toEqual(expect.arrayContaining(['D 421 1560.00', 'C 427 1560.00']));
    const [listed] = await s.list<{ withheld: string; remaining: string }>(
      s.owner,
      'payroll.garnishments.list',
    );
    expect(listed).toMatchObject({ withheld: '1560.00', remaining: '440.00' });
    const november = await s.invoke<Run>(s.owner, 'payroll.runs.prepare', {
      month: '2026-11',
      workingDays: 20,
    });
    expect(november.lines[0]!.garnished).toEqual([
      { orderId: order.id, partyId: bailiff.id, amount: '440.00' },
    ]);
  });
});

describe("the administrator's mandate", () => {
  test('a mandate without an employment contract: CAS, CASS, CAM and tax, no minimum, D112 type 6', async () => {
    const { s, hire, prepare, recognize, declare, xml } = await employer({ official: true });
    await hire(['Marinescu', 'Dan'], cnp('180072217002'), {
      kind: 'mandate',
      number: 'Mandat-1',
      baseSalary: '3000',
      mainJob: false,
      occupation: '112014',
    });
    const run = await prepare();
    // 3,000 lei outside the main job: CAS 750, CASS 300, tax on 1,950 lei; no minimum.
    expect(run.lines[0]).toMatchObject({
      cash: '3000.00',
      cas: '750.00',
      cass: '300.00',
      tax: '195.00',
      net: '1755.00',
      issues: [],
    });
    await s.post(await s.approve(await recognize(run)));
    const declared = await declare();
    validated(declared);
    const text = await xml(declared);
    expect(text).toContain('A_1="6"');
    expect(text).toContain('asigSO="2"');
    expect(text).toContain('<asiguratE2 ');
    // The closure no longer reports payroll taxes without an employee.
    const closure = await s.invoke<{ unsupported: { trigger: string }[] }>(
      s.owner,
      'closure.evaluate',
      { from: '2026-10', to: '2026-10' },
    );
    expect(closure.unsupported.map((item) => item.trigger)).not.toContain(
      'PAYROLL_WITHOUT_EMPLOYEES',
    );
    // A mandate is not registered in REGES-ONLINE.
    expect(await s.list(s.owner, 'payroll.reges.list')).toEqual([]);
  }, 120_000);
});

describe('REGES-ONLINE, an external obligation', () => {
  test('a contract is due before its start, listed on the worklist until its receipt is recorded', async () => {
    const { s, hire } = await employer();
    const { contractId } = await hire(['Popescu', 'Ana'], cnp('290050117002'), {
      baseSalary: '5000',
      startDate: '2026-12-01',
      effectiveFrom: '2026-12-01',
    });
    expect(await s.list(s.owner, 'payroll.reges.list')).toEqual([
      expect.objectContaining({
        contractId,
        termsSeq: 1,
        event: 'start',
        deadline: '2026-11-30',
        transmittedOn: null,
      }),
    ]);
    const work = await s.invoke<{ items: { kind: string; next: { operation: string }[] }[] }>(
      s.owner,
      'work.list',
      { kinds: ['payroll.due'] },
    );
    expect(work.items.map((item) => [item.kind, item.next[0]!.operation])).toEqual([
      ['payroll.due', 'payroll.reges.record'],
    ]);
    await s.invoke(s.owner, 'payroll.reges.record', {
      contractId,
      termsSeq: 1,
      event: 'start',
      transmittedOn: '2026-11-20',
      evidenceId: (await s.evidence('recipisa-reges.pdf')).id,
    });
    expect(
      (await s.invoke<{ items: unknown[] }>(s.owner, 'work.list', { kinds: ['payroll.due'] }))
        .items,
    ).toEqual([]);
  });

  test('a raise is due within 20 working days, a shorter working time the day before, the end on its date (HG nr. 295/2025 art. 5)', async () => {
    const { s, hire } = await employer();
    const { id: employeeId, contractId } = await hire(['Popescu', 'Ana'], cnp('290050117002'), {
      baseSalary: '5000',
    });
    const terms = {
      contractId,
      employeeId,
      number: 'CIM-Popescu',
      startDate: '2025-02-15',
      dailyHours: 8,
      mainJob: true,
      occupation: '251201',
    };
    const record = (extra: Record<string, unknown>) =>
      s.invoke(s.owner, 'payroll.contracts.record', { ...terms, ...extra });
    await record({ effectiveFrom: '2026-11-01', baseSalary: '6000' });
    await record({ effectiveFrom: '2026-12-01', baseSalary: '4500', dailyHours: 6 });
    await record({
      effectiveFrom: '2026-12-15',
      baseSalary: '4500',
      dailyHours: 6,
      endDate: '2026-12-31',
    });
    expect(
      (
        await s.list<{ termsSeq: number; event: string; deadline: string; blocked: unknown }>(
          s.owner,
          'payroll.reges.list',
        )
      ).map(({ termsSeq, event, deadline, blocked }) => ({ termsSeq, event, deadline, blocked })),
    ).toEqual([
      // 20 working days after 1 November 2026.
      { termsSeq: 2, event: 'change', deadline: '2026-11-27', blocked: null },
      // The working time changes too: the day before it takes effect.
      { termsSeq: 3, event: 'change', deadline: '2026-11-30', blocked: null },
      // An end date given to an open-ended contract is its end, not a change of its duration.
      { termsSeq: 4, event: 'end', deadline: '2026-12-31', blocked: null },
    ]);
  });
});

describe('the payroll module for agents', () => {
  test('agent.ts names kinds the engine knows', () => {
    for (const detector of payrollAgent.detectors)
      expect(workKinds as readonly string[]).toContain(detector.kind);
    for (const question of payrollAgent.questions)
      expect(questionKindIds as readonly string[]).toContain(question.kind);
    expect(payrollAgent.templates).toEqual([]);
  });
});
