import { afterAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { employees, parties } from '../../source/engine/db/schema';
import type { ProposalView } from '../../source/engine/kernel/views';
import { iban } from './fixtures/bank';
import { journal, scenario, type Scenario } from './scenario';

const open: Scenario[] = [];
afterAll(async () => {
  await Promise.all(open.map((s) => s.dispose()));
});

/** A synthetic CNP with a valid control digit. */
function cnp(body: string) {
  const weights = [2, 7, 9, 1, 4, 6, 3, 5, 8, 2, 7, 9];
  const control =
    weights.reduce((sum, weight, index) => sum + weight * Number(body[index]), 0) % 11;
  return `${body}${control === 10 ? 1 : control}`;
}

type Run = {
  id: string;
  state: string;
  issues: number;
  lines: {
    contractId: string;
    name: string;
    cash: string;
    cas: string;
    cass: string;
    casEmployer: string;
    cassEmployer: string;
    tax: string;
    net: string;
    cam: string;
    issues: { code: string }[];
  }[];
};

/** An employer with ANAF as a partner and one employee on the minimum wage. */
async function employer(options: { policy?: '635' | '6458' } = {}) {
  const s = await scenario();
  open.push(s);
  const record = async (axis: string, value: string) =>
    s.invoke(s.owner, 'profile.record', {
      axis,
      value,
      effectiveFrom: '2026-01-01',
      evidenceId: (await s.evidence(`${axis}.pdf`)).id,
    });
  await record('employer', 'yes');
  if (options.policy) await record('policy.payroll.employer_share', options.policy);
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
      startDate: '2026-01-05',
      effectiveFrom: '2026-01-05',
      dailyHours: 8,
      mainJob: true,
      occupation: '251201',
      ...terms,
    });
    return { ...employee, contractId: contract.contractId };
  };
  const prepare = (input: Record<string, unknown> = {}) =>
    s.invoke<Run>(s.owner, 'payroll.runs.prepare', { month: '2026-10', workingDays: 22, ...input });
  const recognize = (run: Run) =>
    s.propose('payroll.recognize', {
      runId: run.id,
      month: '2026-10',
      round: 1,
      authorityId: anaf.id,
    });
  return { s, anaf, hire, prepare, recognize };
}

const lines = (proposal: ProposalView) =>
  proposal.effect?.lines.map((line) => `${line.side} ${line.account} ${line.amount}`);
const balance = async (s: Scenario, account: string) =>
  (await s.trialBalance()).rows.find((row) => row.account === account)?.closing;

describe('payroll', () => {
  test('a month on the minimum wage: computed, posted, and owed to the employee and to ANAF', async () => {
    const { s, hire, prepare, recognize } = await employer();
    await hire(['Popescu', 'Ana'], cnp('290050112345'), { baseSalary: '4325' });
    const run = await prepare();
    expect(run.lines).toMatchObject([
      {
        name: 'Popescu Ana',
        cash: '4325.00',
        cas: '1031.00',
        cass: '413.00',
        casEmployer: '0.00',
        cassEmployer: '0.00',
        tax: '182.00',
        net: '2699.00',
        cam: '93.00',
        issues: [],
      },
    ]);
    const proposal = await recognize(run);
    expect(lines(proposal)).toEqual([
      'D 641 4325.00',
      'C 421 4325.00',
      'D 421 1626.00',
      'C 4315 1031.00',
      'C 4316 413.00',
      'C 444 182.00',
      'D 646 93.00',
      'C 436 93.00',
    ]);
    const posted = await s.post(await s.approve(proposal));
    expect(await balance(s, '421')).toEqual({ debit: '0.00', credit: '2699.00' });
    expect(await balance(s, '436')).toEqual({ debit: '0.00', credit: '93.00' });
    expect((await s.refused(prepare()))?.code).toBe('RUN_POSTED');

    // November's statement pays the net salary and, in one transfer, what is owed to ANAF.
    await s.invoke(s.owner, 'treasury.createAccount', {
      kind: 'bank',
      name: 'Cont curent',
      iban,
      currency: 'RON',
      ledgerAccount: '5121',
      openedOn: '2026-01-01',
    });
    const { id: opening } = await s.evidence('balanta-deschidere.pdf');
    await s.book(
      'ledger.general',
      journal(
        opening,
        [
          { account: '5121', side: 'D', amount: '10000.00' },
          { account: '1012', side: 'C', amount: '10000.00' },
        ],
        { date: '2026-01-01', purpose: 'opening' },
      ),
    );
    const statement = [
      ':20:NOVEMBER2026',
      `:25:${iban}`,
      ':28C:001/001',
      ':60F:C261101RON10000,00',
      ':61:2611101110D2699,00NTRFSAL-10//BANK-SAL-01',
      ':86:Salariu octombrie',
      ':61:2611201120D1719,00NTRFCONTUL-UNIC//BANK-ANAF-01',
      ':86:Contributii si impozit octombrie',
      ':62F:C261130RON5582,00',
      ':64:C261130RON5582,00',
    ].join('\n');
    const { id: file } = await s.invoke<{ id: string }>(s.owner, 'evidence.record', {
      filename: 'extras-noiembrie.sta',
      mediaType: 'text/plain',
      base64: Buffer.from(statement).toString('base64'),
    });
    await s.invoke(s.owner, 'bank.import', { evidenceId: file, financialYearId: s.year.id });
    const movements = await s.invoke<{ id: string; amount: string }[]>(
      s.owner,
      'bank.movements',
      {},
    );
    const item = (account: string) =>
      posted.effect!.openItems.find((open) => open.controlAccount === account)!.id;
    const movement = (amount: string) => movements.find((row) => row.amount === amount)!.id;
    await s.book('bank.settle', {
      movementId: movement('-2699.00'),
      allocations: [{ openItem: item('421'), amount: '2699.00' }],
    });
    await s.book('bank.settle', {
      movementId: movement('-1719.00'),
      allocations: [
        { openItem: item('4315'), amount: '1031.00' },
        { openItem: item('4316'), amount: '413.00' },
        { openItem: item('444'), amount: '182.00' },
        { openItem: item('436'), amount: '93.00' },
      ],
    });
    for (const account of ['421', '4315', '4316', '444', '436'])
      expect(await balance(s, account)).toEqual({ debit: '0.00', credit: '0.00' });
  });

  test('the CNP is kept sealed, and the employee is the same party as a buyer who is this person', async () => {
    const { s, hire } = await employer();
    const code = cnp('180010112345');
    const employee = await hire(['Ionescu', 'Dan'], code, { baseSalary: '6000' });
    const [row] = await s.engine.db.read((tx) =>
      tx.select().from(employees).where(eq(employees.id, employee.id)),
    );
    expect(row!.cnpSealed).not.toContain(code);
    expect(row!.birthDate).toBe('1980-01-01');
    const [party] = await s.engine.db.read((tx) =>
      tx.select().from(parties).where(eq(parties.id, employee.partyId)),
    );
    expect(party!.taxId).toMatch(/^cnp:[0-9a-f]{64}$/);
    expect(JSON.stringify(await s.invoke(s.owner, 'payroll.employees.list'))).not.toContain(code);
    expect(
      (
        await s.refused(
          s.invoke(s.owner, 'payroll.employees.record', {
            lastName: 'Ionescu',
            firstName: 'Dan',
            cnp: code,
            healthFund: 'RO-GL',
          }),
        )
      )?.code,
    ).toBe('EMPLOYEE_EXISTS');
    expect(
      (
        await s.refused(
          s.invoke(s.owner, 'payroll.employees.record', {
            lastName: 'X',
            firstName: 'Y',
            cnp: '1800101123456',
            healthFund: 'RO-GL',
          }),
        )
      )?.code,
    ).toBe('CNP');
  });

  test("a part-time contract: contributions borne in the employee's name need the company's policy", async () => {
    const without = await employer();
    await without.hire(['Marin', 'Ioana'], cnp('295030412345'), {
      baseSalary: '2500',
      dailyHours: 4,
    });
    const run = await without.prepare();
    expect(run.lines[0]).toMatchObject({ casEmployer: '406.00', cassEmployer: '163.00' });
    expect((await without.recognize(run)).issues.map((issue) => issue.code)).toContain(
      'POLICY_MISSING',
    );

    const { s, hire, prepare, recognize } = await employer({ policy: '635' });
    await hire(['Marin', 'Ioana'], cnp('295030412345'), { baseSalary: '2500', dailyHours: 4 });
    const proposal = await recognize(await prepare());
    expect(lines(proposal)).toEqual([
      'D 641 2500.00',
      'C 421 2500.00',
      'D 421 951.00',
      'D 635 569.00',
      'C 4315 1031.00',
      'C 4316 413.00',
      'C 444 76.00',
      'D 646 56.00',
      'C 436 56.00',
    ]);
    await s.post(await s.approve(proposal));
  });

  test("CAM is owed on the employer's total base, rounded once", async () => {
    const { s, hire, prepare, recognize } = await employer({ policy: '635' });
    await hire(['Marin', 'Ioana'], cnp('295030412345'), { baseSalary: '2500', dailyHours: 4 });
    await hire(['Vasile', 'Ion'], cnp('188020312345'), { baseSalary: '2500', dailyHours: 4 });
    const run = await prepare();
    // Each line's CAM rounds 56.25 to 56; the total base of 5,000 owes 112.50, so 113.
    expect(run.lines.map((line) => line.cam)).toEqual(['56.00', '56.00']);
    const proposal = await recognize(run);
    expect(lines(proposal)).toContain('C 436 113.00');
    await s.post(await s.approve(proposal));
  });

  test('what the contract does not settle stops the run, and a new computation supersedes it', async () => {
    const { s, anaf, hire, prepare, recognize } = await employer();
    const late = await hire(['Stan', 'Mihai'], cnp('190071512345'), {
      baseSalary: '7000',
      startDate: '2026-10-13',
      effectiveFrom: '2026-10-13',
    });
    const first = await prepare();
    expect(first.issues).toBe(1);
    expect(first.lines[0]!.issues.map((issue) => issue.code)).toEqual([
      'PARTIAL_MONTH',
      'SALARY_ITEMS',
    ]);
    const blocked = await recognize(first);
    expect(blocked.issues.map((issue) => issue.code)).toContain('RUN_BLOCKED');

    const second = await prepare({
      entries: [
        {
          contractId: late.contractId,
          activeDays: 14,
          items: [{ kind: 'salary', amount: '4454.55', label: 'Salariu 14 din 22 de zile' }],
        },
      ],
    });
    expect(second.issues).toBe(0);
    const runs = await s.invoke<Run[]>(s.owner, 'payroll.runs.list');
    expect(runs.find((run) => run.id === first.id)?.state).toBe('superseded');

    // A proposal made from a run that is then recomputed goes stale.
    const proposal = await s.revise('payroll.recognize', blocked, {
      runId: second.id,
      month: '2026-10',
      round: 1,
      authorityId: anaf.id,
    });
    expect(proposal.issues).toEqual([]);
    const approved = await s.approve(proposal);
    await prepare({
      entries: [
        {
          contractId: late.contractId,
          activeDays: 14,
          items: [{ kind: 'salary', amount: '4454.55', label: 'Salariu 14 din 22 de zile' }],
        },
      ],
    });
    expect((await s.refused(s.post(approved)))?.code).toBe('STALE');
  });

  test('a base salary lowered since the ordinance loses the minimum-wage relief', async () => {
    const { s, hire, prepare } = await employer();
    const employee = await hire(['Popa', 'Ion'], cnp('187030412345'), { baseSalary: '4500' });
    await s.invoke(s.owner, 'payroll.contracts.record', {
      contractId: employee.contractId,
      employeeId: employee.id,
      number: 'CIM-Popa',
      startDate: '2026-01-05',
      effectiveFrom: '2026-03-01',
      baseSalary: '4325',
      dailyHours: 8,
      mainJob: true,
      occupation: '251201',
    });
    const [line] = (await prepare()).lines;
    expect(line).toMatchObject({ cas: '1081.00', cass: '433.00' });
  });

  test("annual leave is paid at the three months' average, at least the base salary", async () => {
    const { s, anaf, hire } = await employer();
    const steady = await hire(['Ene', 'Ana'], cnp('290050112345'), {
      baseSalary: '6000',
      startDate: '2026-07-01',
      effectiveFrom: '2026-07-01',
    });
    const lowered = await hire(['Toma', 'Ion'], cnp('188020312345'), {
      baseSalary: '6600',
      startDate: '2026-07-01',
      effectiveFrom: '2026-07-01',
    });
    const post = async (month: string, workingDays: number, entries: unknown[] = []) => {
      const run = await s.invoke<Run>(s.owner, 'payroll.runs.prepare', {
        month,
        workingDays,
        entries,
      });
      await s.book('payroll.recognize', { runId: run.id, month, round: 1, authorityId: anaf.id });
    };
    await post('2026-07', 23);
    await post('2026-08', 21);
    // A bonus is paid but not averaged into the leave pay.
    await post('2026-09', 22, [
      {
        contractId: steady.contractId,
        items: [
          { kind: 'salary', amount: '6000', label: 'Salariu de bază' },
          { kind: 'bonus', amount: '1000', label: 'Primă' },
        ],
      },
    ]);
    await s.invoke(s.owner, 'payroll.contracts.record', {
      contractId: lowered.contractId,
      employeeId: lowered.id,
      number: 'CIM-Toma',
      startDate: '2026-07-01',
      effectiveFrom: '2026-10-01',
      baseSalary: '6000',
      dailyHours: 8,
      mainJob: true,
      occupation: '251201',
    });
    const october = await s.invoke<Run>(s.owner, 'payroll.runs.prepare', {
      month: '2026-10',
      workingDays: 22,
      entries: [
        { contractId: steady.contractId, leaveDays: 5 },
        { contractId: lowered.contractId, leaveDays: 5 },
      ],
    });
    // Ene: 6,000 × 17 / 22 = 4,636 worked; leave at the base, 6,000 × 5 / 22 = 1,364.
    // Toma: 4,636 worked; leave at the average, 19,800 × 5 / 66 = 1,500.
    expect(october.lines.map((line) => [line.name, line.cash])).toEqual([
      ['Ene Ana', '6000.00'],
      ['Toma Ion', '6136.00'],
    ]);
  });

  test('sick leave: the base from six posted months, the first day unpaid, the fund’s part a claim on FNUASS', async () => {
    const { s, anaf, hire } = await employer({ policy: '635' });
    const short = await hire(['Ene', 'Ana'], cnp('290050112345'), { baseSalary: '6000' });
    const long = await hire(['Toma', 'Ion'], cnp('188020312345'), { baseSalary: '6000' });
    // April to September 2026: 20 + 20 + 21 + 23 + 21 + 22 = 127 working days at 6,000 a month.
    for (const month of ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']) {
      const run = await s.invoke<Run>(s.owner, 'payroll.runs.prepare', { month });
      await s.book('payroll.recognize', { runId: run.id, month, round: 1, authorityId: anaf.id });
    }
    const certificate = (number: string, from: string, to: string) => ({
      series: 'CCMAM',
      number,
      code: '01',
      issued: from,
      from,
      to,
    });
    const october = await s.invoke<Run>(s.owner, 'payroll.runs.prepare', {
      month: '2026-10',
      entries: [
        {
          contractId: short.contractId,
          sickLeave: [certificate('1001', '2026-10-05', '2026-10-09')],
        },
        {
          contractId: long.contractId,
          sickLeave: [certificate('1002', '2026-10-19', '2026-10-31')],
        },
      ],
    });
    expect(october.issues).toBe(0);
    // The daily average: 36,000 / 127 = 283.46. Ene: 5 days at 55%, the first unpaid, 4 by the
    // employer (624); worked 6,000 × 17 / 22 = 4,636. Toma: 13 days at 65%, 10 working, the
    // first unpaid, 5 by the employer (921) and 4 by the fund (737); worked 6,000 × 12 / 22 = 3,273.
    expect(october.lines.map((line) => [line.name, line.cash])).toEqual([
      ['Ene Ana', '5260.00'],
      ['Toma Ion', '4931.00'],
    ]);
    const recognized = await s.propose('payroll.recognize', {
      runId: october.id,
      month: '2026-10',
      round: 1,
      authorityId: anaf.id,
    });
    expect(lines(recognized)?.slice(0, 2)).toEqual(['D 641 9454.00', 'D 4382 737.00']);
    expect(recognized.issues).toEqual([]);

    // A continuation into November keeps the base and the employer's days, and loses no day.
    await s.post(await s.approve(recognized));
    const november = await s.invoke<Run>(s.owner, 'payroll.runs.prepare', {
      month: '2026-11',
      entries: [
        {
          contractId: long.contractId,
          sickLeave: [
            {
              ...certificate('1003', '2026-11-01', '2026-11-06'),
              continues: { series: 'CCMAM', number: '1002' },
            },
          ],
        },
      ],
    });
    // 13 + 6 days crosses to the over-15 percentage: the recalculation is left to the expert.
    expect(
      november.lines.find((line) => line.name === 'Toma Ion')?.issues.map((i) => i.code),
    ).toEqual(['SICK_RECALCULATION']);
  });

  test('sick leave the payroll cannot compute stops the run', async () => {
    const { s, hire } = await employer();
    const newcomer = await hire(['Ene', 'Ana'], cnp('290050112345'), { baseSalary: '6000' });
    const run = (extra: Record<string, unknown>) =>
      s.invoke<Run>(s.owner, 'payroll.runs.prepare', {
        month: '2026-10',
        entries: [
          {
            contractId: newcomer.contractId,
            sickLeave: [
              {
                series: 'CCMAM',
                number: '7',
                code: '01',
                issued: '2026-10-05',
                from: '2026-10-05',
                to: '2026-10-09',
              },
            ],
            ...extra,
          },
        ],
      });
    const codes = async (extra: Record<string, unknown>) =>
      (await run(extra)).lines[0]!.issues.map((issue) => issue.code);
    // No posted months: the base comes from the stage certificate.
    expect(await codes({})).toEqual(['SICK_BASE']);
    expect(await codes({ sickBase: { income: '24300', days: 121 } })).toEqual([]);
    expect(
      await codes({
        sickBase: { income: '24300', days: 121 },
        items: [{ kind: 'sick_employer', amount: '100', label: 'Manual' }],
      }),
    ).toContain('SICK_ITEMS');
  });

  test("a month's working days come from the public holidays unless given", async () => {
    const { s, hire } = await employer();
    await hire(['Ene', 'Ana'], cnp('290050112345'), { baseSalary: '6000' });
    // November 2026: 21 weekdays, less 30 November.
    const run = await s.invoke<Run & { workingDays: number }>(s.owner, 'payroll.runs.prepare', {
      month: '2026-11',
    });
    expect(run.workingDays).toBe(20);
  });

  test('the month an employee turns 26 asks whether the young deduction applies', async () => {
    const { hire, prepare } = await employer();
    const young = await hire(['Dinu', 'Elena'], cnp('600101512345'), { baseSalary: '5000' });
    const asked = await prepare();
    expect(asked.lines[0]!.issues.map((issue) => issue.code)).toEqual(['YOUNG_TO_DECIDE']);
    const decided = await prepare({ entries: [{ contractId: young.contractId, under26: true }] });
    expect(decided.issues).toBe(0);
  });
});
