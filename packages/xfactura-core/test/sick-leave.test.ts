import { describe, expect, test } from 'bun:test';
import { procedureDefinitions, procedureVersions } from '../src/ro/procedure';
import { calculatePay, payrollDefinitions, payrollVersions } from '../src/ro/payroll';
import {
  sickIndemnity,
  sickLeaveDefinitions,
  sickLeaveVersions,
  type SickCertificate,
} from '../src/ro/payroll/sick-leave';
import { ParameterRegister, RuleContext } from '../src/rules';
import type { LocalDate, Month } from '../src/time';

const rules = () =>
  new RuleContext(
    new ParameterRegister(
      [...payrollDefinitions, ...sickLeaveDefinitions, ...procedureDefinitions],
      [...payrollVersions, ...sickLeaveVersions, ...procedureVersions],
    ),
    'preview',
  );
const certificate = (from: string, to: string, extra: Partial<SickCertificate> = {}) => ({
  series: 'CCMAM',
  number: '1001',
  code: '01',
  issued: from as LocalDate,
  from: from as LocalDate,
  to: to as LocalDate,
  continuation: false,
  hospitalized: false,
  ...extra,
});
// Six months at 4,050 lei over the 121 working days of January to June 2026.
const base = { income: 6n * 405_000n, days: 121 };
const fresh = { reduced: false, employerDays: 0 };

describe('sick leave for ordinary illness', () => {
  test('the first working day is not paid; the employer pays the next five', () => {
    const { result, issues } = sickIndemnity(
      certificate('2026-09-07', '2026-09-11'),
      base,
      fresh,
      rules(),
    );
    expect(issues).toEqual([]);
    // 24,300 / 121 = 200.826…, truncated to 200.82; 55% for up to 7 days; 4 paid days.
    expect(result).toMatchObject({
      days: 5,
      unpaidDays: 1,
      employerDays: 4,
      fundDays: 0,
      dailyAverage: 20_082n,
      percent: '55',
      employer: 44_200n,
      fund: 0n,
    });
  });

  test('a longer certificate: 65%, the fund pays after the employer’s five days', () => {
    const { result } = sickIndemnity(certificate('2026-09-07', '2026-09-20'), base, fresh, rules());
    expect(result).toMatchObject({
      days: 10,
      unpaidDays: 1,
      employerDays: 5,
      fundDays: 4,
      percent: '65',
      employer: 65_300n,
      fund: 52_200n,
    });
  });

  test('a continuation is not reduced again and the employer’s days carry over', () => {
    const { result } = sickIndemnity(
      certificate('2026-09-14', '2026-09-18', { continuation: true }),
      base,
      { reduced: true, employerDays: 4 },
      rules(),
    );
    expect(result).toMatchObject({ unpaidDays: 0, employerDays: 1, fundDays: 4 });
  });

  test('a hospitalized patient loses no day', () => {
    const { result } = sickIndemnity(
      certificate('2026-09-07', '2026-09-11', { hospitalized: true }),
      base,
      fresh,
      rules(),
    );
    expect(result).toMatchObject({ unpaidDays: 0, employerDays: 5 });
  });

  test('what the texts leave open is an issue, never an amount', () => {
    const codes = (cert: SickCertificate) =>
      sickIndemnity(cert, base, fresh, rules()).issues.map((issue) => issue.code);
    expect(codes(certificate('2026-09-01', '2026-09-15'))).toEqual(['SICK_TIER']);
    expect(codes(certificate('2026-09-07', '2026-09-11', { code: '02' }))).toEqual(['SICK_CODE']);
    expect(codes(certificate('2026-09-28', '2026-10-02'))).toEqual(['SICK_DATES']);
    expect(codes(certificate('2026-01-12', '2026-01-16'))).toEqual(['RULE_GAP']);
    expect(
      sickIndemnity(
        certificate('2026-09-07', '2026-09-11'),
        { income: 0n, days: 0 },
        fresh,
        rules(),
      ).issues[0]?.code,
    ).toBe('SICK_BASE');
  });

  test('in the payroll: taxed, in the CAS and CASS bases, and the fund’s part out of CAM', () => {
    const sick = { employer: 65_300n, fund: 52_200n };
    // September 2026 has 22 working days; 10 were on sick leave.
    const { result, issues } = calculatePay(
      {
        month: '2026-09' as Month,
        baseSalary: 600_000n,
        dailyHours: 8,
        mainJob: true,
        workingDays: 22,
        activeDays: 12,
        items: [
          { kind: 'salary', amount: 327_273n, label: 'Salariu de bază' },
          { kind: 'sick_employer', amount: sick.employer, label: 'Concediu medical (angajator)' },
          { kind: 'sick_fund', amount: sick.fund, label: 'Concediu medical (FNUASS)' },
        ],
        dependents: 0,
        under26: false,
        childrenInSchool: 0,
        unionDues: 0n,
        minimumExemption: null,
      },
      rules(),
    );
    expect(issues).toEqual([]);
    const cash = 327_273n + sick.employer + sick.fund;
    expect(result).toMatchObject({
      cash,
      casBase: cash,
      cassBase: cash,
      camBase: cash - sick.fund,
      sickEmployer: sick.employer,
      sickFund: sick.fund,
      casEmployer: 0n,
    });
  });
});
