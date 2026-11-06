import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
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
  type D112PrescriptionPlace,
  type D112SickCertificate,
  type D112SickPercent,
} from 'xfactura-core/ro/declarations/d112';
import { counties } from 'xfactura-core/ro/geo';
import { d112Filing, quarterMonths, type MinimumExemption } from 'xfactura-core/ro/payroll';
import { RuleGapError, type RuleContext } from 'xfactura-core/rules';
import { addDays, monthStart, type LocalDate, type Month } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import {
  artifactEvents,
  artifacts,
  companies,
  employees,
  employmentTerms,
  payrollLines,
  payrollRunEvents,
  payrollRuns,
} from '../db/schema';
import { loadState } from '../kernel/state';
import { sellerDetails } from './d300';
import type { DeclarationKind, DeclarationProblem } from './declarations';
import {
  openSick,
  postedRun,
  postedRuns,
  Sealer,
  type StoredBenefit,
  type StoredSick,
} from './payroll';

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
    /** A rectifying declaration (d_rec 1, OPANAF nr. 605/2026 anexa nr. 6 cap. II pct. 2): the
     * month's D112 was filed, through the engine or outside it. Required for a month corrected
     * after posting, and refused false when the engine recorded the filing. */
    rectifying: z.boolean().optional(),
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
  mandate?: boolean;
  sick?: StoredSick[];
  benefits?: StoredBenefit[];
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
 * When the month's D112 is due, by the year's own `payroll.period` fact (art. 147 alin. (1),
 * (4)–(5)) and the quarter's sick leave and contracts ended (alin. (11)); null when the year's
 * period is not recorded. The XML is the same either way: a quarterly filer files one return per
 * month (alin. (5); OPANAF nr. 605/2026 anexa nr. 6 cap. I).
 */
export async function d112FilingOf(tx: Transaction, companyId: string, month: string) {
  const year = month.slice(0, 4);
  const { loaded } = await loadState(tx, companyId, { profile: true });
  let period: 'monthly' | 'quarterly' | null = null;
  for (const fact of loaded.profile)
    if (
      fact.axis === 'payroll.period' &&
      fact.effectiveFrom >= `${year}-01-01` &&
      fact.effectiveFrom <= `${month}-31`
    )
      period = fact.value as 'monthly' | 'quarterly';
  if (!period) return null;
  const months = quarterMonths(month);
  const sick = await tx
    .selectDistinct({ month: payrollRuns.month })
    .from(payrollLines)
    .innerJoin(
      payrollRuns,
      and(
        eq(payrollRuns.companyId, payrollLines.companyId),
        eq(payrollRuns.id, payrollLines.runId),
      ),
    )
    .where(
      and(
        eq(payrollLines.companyId, companyId),
        gte(payrollRuns.month, months[0]!),
        lte(payrollRuns.month, months[2]!),
        sql`${payrollLines.input} LIKE '%"sick":%'`,
        sql`not exists (select 1 from ${payrollRunEvents} e where e.company_id = ${payrollRuns.companyId}
          and e.run_id = ${payrollRuns.id} and e.state = 'superseded')`,
      ),
    );
  const ends = (
    await tx
      .select({ end: employmentTerms.endDate })
      .from(employmentTerms)
      .where(eq(employmentTerms.companyId, companyId))
  ).flatMap((row) =>
    row.end && months.includes(row.end.slice(0, 7)) ? [row.end.slice(0, 7)] : [],
  );
  const filing = d112Filing(month, period, [...sick.map((row) => row.month), ...ends]);
  return { period, ...filing };
}

/** The month's minimum wage and its relief from the rule register, whole lei, for the structure's
 * check; the rule gap's message when either is not sourced. */
function structureParameters(rules: RuleContext, month: string) {
  const at = monthStart(month as Month);
  try {
    const wage = rules.param<string>('ro.payroll.minimum_wage', 'payroll_month_start', at);
    const relief = rules.param<{ amount: string }>(
      'ro.payroll.minimum_wage_relief',
      'payroll_month_start',
      at,
    );
    return { parameters: { minimumWage: Number(wage), relief: Number(relief.amount) } };
  } catch (error) {
    if (!(error instanceof RuleGapError)) throw error;
    return { gap: error.message };
  }
}

/**
 * The monthly declaration of social contributions, wage tax and the insured (D112) from the
 * month's posted payroll run: each employee's contract, days, bases, contributions, deductions
 * and tax as the run computed them, their CNP opened from its seal for the declaration only. The
 * medical certificates the run paid are declared as they were paid, their diagnosis code opened
 * from its seal the same way; sick pay entered by hand, without certificates, is refused. The
 * month's minimum wage and relief are the register's (4050 and 300 lei in January–June 2026,
 * 4325 and 200 lei from July), which must be those of ANAF's structure for the month.
 */
export function d112Declaration(
  secret: string,
  rulesOf: (tx: Transaction, companyId: string) => Promise<RuleContext>,
): DeclarationKind {
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
      const structure = structureParameters(await rulesOf(tx, companyId), month);
      if ('gap' in structure) problems.push({ code: 'RULE_GAP', message: structure.gap! });
      if (problems.length || !run || !seller || !structure.parameters)
        return { xml: '', inputs, problems, summary: null };

      /** Whole lei; `health` when what it names is a certificate or a work accident. */
      const whole = (bani: bigint, what: string, health = false) => {
        if (bani % 100n !== 0n)
          problems.push({
            code: 'D112_BANI',
            message: `${what} are subdiviziuni de leu; D112 se completează în lei întregi.`,
            ...(health ? { health: true as const } : {}),
          });
        return Number(bani / 100n);
      };
      /** A certificate as the run paid it: the episode's first day for a continuation, the
       * base and the amounts in whole lei, the diagnosis opened from its seal. */
      const certificateOf = (
        stored: StoredSick,
        place: D112PrescriptionPlace,
        diagnosis: string,
        what: string,
      ): D112SickCertificate => ({
        series: stored.series,
        number: stored.number,
        ...(stored.continues
          ? {
              continues: {
                ...stored.continues,
                initialFrom: addDays(stored.to as LocalDate, 1 - stored.episode.days),
              },
            }
          : {}),
        issued: stored.issued,
        from: stored.from,
        to: stored.to,
        code: stored.code,
        place,
        diagnosis: sealer.open(companyId, diagnosis),
        unpaidDays: stored.unpaidDays,
        employerDays: stored.employerDays,
        fundDays: stored.fundDays,
        base: {
          income: whole(BigInt(stored.episode.base.income), `${what}: baza de calcul`, true),
          days: stored.episode.base.days,
        },
        percent: stored.code === '01' ? (stored.percent as D112SickPercent) : null,
        ...(stored.careCnpSealed ? { careCnp: sealer.open(companyId, stored.careCnpSealed) } : {}),
        ...(stored.urgencyCode ? { urgencyCode: stored.urgencyCode } : {}),
        ...(stored.infectiousCode ? { infectiousCode: stored.infectiousCode } : {}),
        employer: whole(BigInt(stored.employer), `${what}: indemnizația angajatorului`, true),
        fund: whole(BigInt(stored.fund), `${what}: indemnizația din FNUASS`, true),
      });
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
        const kept = JSON.parse(line.input) as PayLineInput;
        // The certificates are kept sealed; D112 declares them.
        const pay = { ...kept, sick: openSick(sealer, companyId, kept.sick) };
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
        const items = (kind: string) =>
          pay.items
            .filter((item) => item.kind === kind)
            .reduce((sum, item) => sum + BigInt(item.amount), 0n);
        // A work accident the pension house confirmed is declared in B3 and C3, not in section D
        // (the D112 structure's note on D_9).
        const accidentRecords = (pay.sick ?? []).filter((stored) => stored.accidentConfirmed);
        const certificateRecords = (pay.sick ?? []).filter((stored) => !stored.accidentConfirmed);
        const sickLeave = certificateRecords.flatMap((stored) => {
          const what = `Salariatul ${name}, certificatul ${stored.series} ${stored.number}`;
          if (!stored.place || !stored.diagnosisSealed) {
            problems.push({
              code: 'D112_SICK_CERTIFICATE',
              message: `${what}: completați în statul de plată locul de prescriere și codul de diagnostic, pe care D112 le cere.`,
              health: true,
            });
            return [];
          }
          // D112 knows a hospitalization, which keeps the first day paid, by where it was
          // prescribed (D_10 = 2).
          if (stored.hospitalized && stored.place !== 'hospital')
            problems.push({
              code: 'D112_SICK_CERTIFICATE',
              message: `${what} acoperă o spitalizare: locul de prescriere este spitalul.`,
              health: true,
            });
          return [certificateOf(stored, stored.place, stored.diagnosisSealed, what)];
        });
        // Sick pay is declared per certificate: amounts entered by hand have none.
        const paid = (key: 'employer' | 'fund', records = certificateRecords) =>
          records.reduce((sum, stored) => sum + BigInt(stored[key]), 0n);
        const exemptSick = items('sick_fund_exempt');
        if (
          items('sick_employer') + items('sick_employer_nocass') !== paid('employer') ||
          items('sick_fund') + items('sick_fund_nocass') + exemptSick !== paid('fund') ||
          items('accident_employer') !== paid('employer', accidentRecords) ||
          items('accident_fund') !== paid('fund', accidentRecords)
        )
          problems.push({
            code: 'D112_SICK_ITEMS',
            message: `Salariatul ${name} are indemnizații de concediu medical fără certificatele din care statul de plată le-a calculat: D112 declară concediul medical doar pe certificate.`,
            health: true,
          });
        const suspended = (pay.sick ?? []).reduce((days, stored) => days + stored.days, 0);
        const pensioner = pay.minimumExemption === 'pensioner';
        const relief = step('relief');
        const borne = line.casEmployer + line.cassEmployer;
        // An administrator under a mandate (Nomenclator 5 type 6): insured for medical leave, CAM
        // being owed on the remuneration (art. 220^4 alin. (1) lit. d)), not for unemployment;
        // no working time (a reading awaiting review, `ro.payroll.mandate.deduction`).
        const mandate = pay.mandate === true;
        // Benefits in kind by the E3 field D112 declares them in, whole lei.
        const fields: Record<string, bigint> = {};
        for (const benefit of pay.benefits ?? [])
          for (const part of [...benefit.taxable, ...benefit.exempt])
            fields[part.field] = (fields[part.field] ?? 0n) + BigInt(part.amount);
        const benefits = Object.fromEntries(
          Object.entries(fields).map(([key, value]) => [
            key,
            whole(value, `${name}: avantajele în natură`),
          ]),
        );
        return {
          cnp: sealer.open(companyId, employee.cnpSealed),
          lastName: employee.lastName ?? '',
          firstName: employee.firstName ?? '',
          from: terms.startDate,
          ...(terms.endDate && terms.endDate <= monthEnd ? { until: terms.endDate } : {}),
          healthFund: (employee.healthFund ?? 'RO-B') as D112HealthFund,
          sickLeaveInsured: true,
          unemploymentInsured: !pensioner && !mandate,
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
            type: mandate ? '6' : relief > 0n ? '51' : '1',
            pensioner,
            contract:
              pay.dailyHours === 8
                ? 'N'
                : (`P${pay.dailyHours}` as D112Insured['employment']['contract']),
            normHours: 8,
            baseSalary: whole(BigInt(pay.baseSalary), `${name}: salariul de bază`),
            hoursWorked: mandate ? 0 : pay.activeDays * pay.dailyHours,
            // The contract is suspended on every working day of the certificates.
            hoursSuspended: suspended * pay.dailyHours,
            daysWorked: pay.activeDays,
            unemploymentBase: mandate ? 0 : whole(line.cash - exemptSick, `${name}: salariul`),
            camBase: whole(step('cam.base'), `${name}: baza CAM`),
            cassBase: whole(step('cass.base'), `${name}: baza CASS`),
            cass: whole(line.cass, `${name}: CASS`),
            casBase: whole(step('cas.base'), `${name}: baza CAS`),
            cas: whole(line.cas, `${name}: CAS`),
            relief: whole(relief, `${name}: suma neimpozabilă`),
          },
          income: {
            mainJob: pay.mainJob,
            // The gross income without the indemnities art. 62 lit. c) leaves out of income.
            cash: whole(line.cash - exemptSick, `${name}: salariul`),
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
            ...(Object.keys(benefits).length ? { benefits } : {}),
          },
          ...(sickLeave.length ? { sickLeave } : {}),
          ...(accidentRecords.length
            ? {
                accidents: {
                  cases: accidentRecords.length,
                  days: accidentRecords.reduce((days, stored) => days + stored.days, 0),
                  fundDays: accidentRecords.reduce((days, stored) => days + stored.fundDays, 0),
                  employer: whole(
                    paid('employer', accidentRecords),
                    `${name}: accidentul de muncă`,
                    true,
                  ),
                  fund: whole(paid('fund', accidentRecords), `${name}: accidentul de muncă`, true),
                },
              }
            : {}),
        };
      });
      const details = JSON.parse(seller.details) as Party;
      const [company] = await tx.select().from(companies).where(eq(companies.id, companyId));
      const address = details.address;
      // A rectifying declaration: stated, required for a month corrected after posting, and
      // refused as initial when the engine recorded the month's D112 as filed.
      const filed = await tx
        .select({ id: artifacts.id })
        .from(artifacts)
        .innerJoin(
          artifactEvents,
          and(
            eq(artifactEvents.companyId, artifacts.companyId),
            eq(artifactEvents.artifactId, artifacts.id),
          ),
        )
        .where(
          and(
            eq(artifacts.companyId, companyId),
            eq(artifacts.kind, 'D112'),
            eq(artifacts.period, month),
            inArray(artifactEvents.state, ['submitted', 'accepted']),
          ),
        )
        .limit(1);
      const corrected = (await postedRuns(tx, companyId, month)).length > 1;
      if (options.rectifying === undefined && corrected)
        problems.push({
          code: 'D112_RECTIFYING',
          message: `Statul de plată pentru ${month} a fost corectat după înregistrare: precizați dacă D112 al lunii a fost depus (rectifying), caz în care aceasta este o declarație rectificativă.`,
        });
      if (options.rectifying === false && filed.length)
        problems.push({
          code: 'D112_RECTIFYING',
          message: `D112 pentru ${month} este depusă: o nouă declarație pentru lună este rectificativă (OPANAF nr. 605/2026 anexa nr. 6 cap. II pct. 2).`,
        });
      const model: D112 = {
        period: { year: Number(month.slice(0, 4)), month: Number(month.slice(5, 7)) },
        correction:
          options.rectifying === true || (options.rectifying === undefined && filed.length > 0),
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
        parameters: structure.parameters,
      };
      problems.push(
        ...checkD112(model)
          .filter((check) => check.severity === 'error')
          .map(({ code, message, health }) => ({ code, message, ...(health ? { health } : {}) })),
      );
      return {
        xml: problems.length ? '' : writeD112(model),
        inputs,
        problems,
        summary: {
          month,
          insured: insured.length,
          runId: runId!,
          rectifying: model.correction,
          filing: await d112FilingOf(tx, companyId, month),
        },
      };
    },
  };
}
