import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Party } from 'xfactura-core/einvoice';
import type { ReadSetEntry } from 'xfactura-core/kernel';
import {
  checkD112,
  d112Namespace,
  writeD112,
  type D112,
  type D112HealthFund,
  type D112Insured,
} from 'xfactura-core/ro/declarations/d112';
import { counties } from 'xfactura-core/ro/geo';
import type { MinimumExemption } from 'xfactura-core/ro/payroll';
import type { Transaction } from '../db/database';
import { companies, employees, employmentTerms, payrollLines } from '../db/schema';
import { loadState } from '../kernel/state';
import { sellerDetails } from './d300';
import type { DeclarationKind, DeclarationProblem } from './declarations';
import { postedRun, Sealer } from './payroll';

export const d112Options = z
  .object({
    declarant: z
      .object({
        lastName: z.string().trim().min(1).max(75),
        firstName: z.string().trim().min(1).max(75),
        role: z.string().trim().min(1).max(50),
      })
      .strict(),
    caen: z.string().regex(/^\d{4}$/),
    phone: z.string().trim().min(1).max(15).optional(),
    email: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

type Step = { code: string; amount: string };
type PayLineInput = {
  baseSalary: string;
  dailyHours: number;
  mainJob: boolean;
  activeDays: number;
  items: { kind: string; amount: string }[];
  dependents: number;
  unionDues: string;
  minimumExemption: MinimumExemption | null;
  sick?: unknown[];
};

async function inputsOf(tx: Transaction, companyId: string, month: string) {
  const runId = await postedRun(tx, companyId, month);
  const { loaded, readSet } = await loadState(tx, companyId, {
    payrollRuns: runId ? [runId] : [],
  });
  const seller = await sellerDetails(tx, companyId);
  const inputs: ReadSetEntry[] = [
    ...readSet,
    ...(seller ? [{ kind: 'party' as const, id: seller.partyId, version: seller.hash }] : []),
  ];
  return { run: runId ? loaded.payrollRuns.get(runId) : undefined, runId, seller, inputs };
}

/**
 * The monthly declaration of social contributions, wage tax and the insured (D112) from the
 * month's posted payroll run: each employee's contract, days, bases, contributions, deductions
 * and tax as the run computed them, their CNP opened from its seal for the declaration only.
 */
export function d112Declaration(secret: string): DeclarationKind {
  const sealer = new Sealer(secret);
  return {
    kind: 'D112',
    description:
      'Declarația privind obligațiile de plată a contribuțiilor sociale, impozitului pe venit și evidența nominală a persoanelor asigurate (D112)',
    tax: null,
    period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    format(month) {
      try {
        return `D112 ${d112Namespace({ year: Number(month.slice(0, 4)), month: Number(month.slice(5, 7)) })}`;
      } catch {
        return null;
      }
    },
    options: d112Options,
    inputs: async (tx, companyId, month) => (await inputsOf(tx, companyId, month)).inputs,
    async prepare(tx, companyId, month, raw) {
      const options = d112Options.parse(raw);
      const problems: DeclarationProblem[] = [];
      const { run, runId, seller, inputs } = await inputsOf(tx, companyId, month);
      if (!run || !runId)
        problems.push({
          code: 'D112_RUN',
          message: `Statul de plată pentru ${month} nu este înregistrat în contabilitate.`,
        });
      if (!seller)
        problems.push({
          code: 'SELLER_DETAILS',
          message: 'Înregistrați datele de identificare ale companiei.',
        });
      if (problems.length || !run || !seller) return { xml: '', inputs, problems, summary: null };

      const whole = (bani: bigint, what: string) => {
        if (bani % 100n !== 0n)
          problems.push({
            code: 'D112_BANI',
            message: `${what} are subdiviziuni de leu; D112 se completează în lei întregi.`,
          });
        return Number(bani / 100n);
      };
      const rows = await tx
        .select({ line: payrollLines, terms: employmentTerms, employee: employees })
        .from(payrollLines)
        .innerJoin(
          employmentTerms,
          and(
            eq(employmentTerms.companyId, payrollLines.companyId),
            eq(employmentTerms.contractId, payrollLines.contractId),
            eq(employmentTerms.seq, payrollLines.termsSeq),
          ),
        )
        .innerJoin(
          employees,
          and(
            eq(employees.companyId, payrollLines.companyId),
            eq(employees.id, payrollLines.employeeId),
          ),
        )
        .where(and(eq(payrollLines.companyId, companyId), eq(payrollLines.runId, runId!)));
      const monthEnd = `${month}-31`;
      const insured: D112Insured[] = rows.map(({ line, terms, employee }) => {
        const pay = JSON.parse(line.input) as PayLineInput;
        const result = JSON.parse(line.result) as {
          steps: Step[];
          deduction: { basic: string; young: string; children: string };
        };
        const step = (code: string) =>
          BigInt(result.steps.find((item) => item.code === code)?.amount ?? '0');
        const name = `${employee.lastName ?? '?'} ${employee.firstName ?? '?'}`;
        if (!employee.lastName || !employee.firstName || !employee.healthFund)
          problems.push({
            code: 'D112_EMPLOYEE',
            message: `Salariatul ${name}: completați numele, prenumele și casa de asigurări de sănătate.`,
          });
        // Medical leave is declared per certificate (the insured's section E), not written yet:
        // a declaration without it would understate the month.
        if (pay.sick?.length || pay.items.some((item) => item.kind.startsWith('sick_')))
          problems.push({
            code: 'D112_SICK_LEAVE',
            message: `Salariatul ${name} are concediu medical în lună: certificatele nu sunt încă declarate în D112.`,
          });
        const items = (kind: string) =>
          pay.items
            .filter((item) => item.kind === kind)
            .reduce((sum, item) => sum + BigInt(item.amount), 0n);
        const pensioner = pay.minimumExemption === 'pensioner';
        const relief = step('relief');
        const borne = line.casEmployer + line.cassEmployer;
        return {
          cnp: sealer.open(companyId, employee.cnpSealed),
          lastName: employee.lastName ?? '',
          firstName: employee.firstName ?? '',
          from: terms.startDate,
          ...(terms.endDate && terms.endDate <= monthEnd ? { until: terms.endDate } : {}),
          healthFund: (employee.healthFund ?? 'RO-B') as D112HealthFund,
          sickLeaveInsured: true,
          unemploymentInsured: !pensioner,
          ...(borne
            ? {
                minimum: {
                  kind: 'due' as const,
                  base: whole(step('minimum.base'), `${name}: suma limită`),
                },
              }
            : pay.minimumExemption
              ? { minimum: { kind: 'exempt' as const, reason: pay.minimumExemption } }
              : {}),
          employment: {
            type: relief > 0n ? '51' : '1',
            pensioner,
            contract:
              pay.dailyHours === 8
                ? 'N'
                : (`P${pay.dailyHours}` as D112Insured['employment']['contract']),
            normHours: 8,
            baseSalary: whole(BigInt(pay.baseSalary), `${name}: salariul de bază`),
            hoursWorked: pay.activeDays * pay.dailyHours,
            hoursSuspended: 0,
            daysWorked: pay.activeDays,
            unemploymentBase: whole(line.cash, `${name}: salariul`),
            camBase: whole(step('cam.base'), `${name}: baza CAM`),
            cassBase: whole(step('cass.base'), `${name}: baza CASS`),
            cass: whole(line.cass, `${name}: CASS`),
            casBase: whole(step('cas.base'), `${name}: baza CAS`),
            cas: whole(line.cas, `${name}: CAS`),
            relief: whole(relief, `${name}: suma neimpozabilă`),
          },
          income: {
            mainJob: pay.mainJob,
            cash: whole(line.cash, `${name}: salariul`),
            mealVouchers: whole(items('meal_vouchers'), `${name}: tichetele de masă`),
            holidayVouchers: whole(items('holiday_vouchers'), `${name}: voucherele de vacanță`),
            dependents: pay.mainJob ? pay.dependents : 0,
            deduction: {
              basic: whole(BigInt(result.deduction?.basic ?? '0'), `${name}: deducerea`),
              young: whole(BigInt(result.deduction?.young ?? '0'), `${name}: deducerea`),
              children: whole(BigInt(result.deduction?.children ?? '0'), `${name}: deducerea`),
            },
            otherDeductions: pay.mainJob
              ? whole(BigInt(pay.unionDues), `${name}: cotizația sindicală`)
              : 0,
            taxBase: whole(step('tax.base'), `${name}: baza impozitului`),
            tax: whole(line.tax, `${name}: impozitul`),
            paid: whole(line.net, `${name}: suma plătită`),
          },
        };
      });
      const details = JSON.parse(seller.details) as Party;
      const [company] = await tx.select().from(companies).where(eq(companies.id, companyId));
      const address = details.address;
      const model: D112 = {
        period: { year: Number(month.slice(0, 4)), month: Number(month.slice(5, 7)) },
        correction: false,
        declarant: options.declarant,
        employer: {
          cui: company!.cui,
          caen: options.caen,
          name: details.name,
          registeredOffice: {
            address: [
              ...address.lines,
              address.city,
              address.subdivision ? counties[address.subdivision] : undefined,
            ]
              .filter(Boolean)
              .join(', '),
            ...(options.phone ? { phone: options.phone } : {}),
            ...(options.email ? { email: options.email } : {}),
          },
          healthFund: (address.subdivision ?? 'RO-B') as D112HealthFund,
        },
        insured,
      };
      problems.push(
        ...checkD112(model)
          .filter((check) => check.severity === 'error')
          .map(({ code, message }) => ({ code, message })),
      );
      return {
        xml: problems.length ? '' : writeD112(model),
        inputs,
        problems,
        summary: { month, insured: insured.length, runId: runId! },
      };
    },
  };
}
