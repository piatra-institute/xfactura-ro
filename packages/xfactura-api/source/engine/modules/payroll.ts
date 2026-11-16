import { and, asc, desc, eq, like, lte } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { canonical, hashOf } from 'xfactura-core/hash';
import { formatMoney, parseMoney } from 'xfactura-core/money';
import { workingDays } from 'xfactura-core/ro/calendar';
import { isValidCnp } from 'xfactura-core/ro/identifiers';
import { profileAt } from 'xfactura-core/kernel';
import {
  benefitTotals,
  calculatePay,
  evaluateBenefits,
  garnish,
  garnishmentKinds,
  giftOccasions,
  minimumExemptions,
  payItemKinds,
  regesDeadline,
  voucherExcess,
  type BenefitInput,
  type BenefitResult,
  type GarnishmentOrder,
  type MinimumWageRelief,
  type PayInput,
  type PayIssue,
  type PayItemKind,
  type PayResult,
  type RegesField,
} from 'xfactura-core/ro/payroll';
import { d112PrescriptionPlaces } from 'xfactura-core/ro/declarations/d112';
import {
  cappedIncome,
  sickIndemnity,
  type SickBase,
  type SickCertificate,
  type SickCodeRule,
  type SickEpisode,
} from 'xfactura-core/ro/payroll/sick-leave';
import { RuleGapError, type RuleContext } from 'xfactura-core/rules';
import {
  addDays,
  addMonths,
  bucharestDate,
  monthEnd,
  monthStart,
  type LocalDate,
  type Month,
} from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import { PartyIdentities } from '../db/identity';
import {
  artifactEvents,
  artifacts,
  employees,
  employmentTerms,
  entries,
  evidence,
  fxRates,
  garnishmentReleases,
  garnishments,
  parties,
  partyCnps,
  payrollLines,
  payrollRunEvents,
  payrollRuns,
  proposals,
  proposalVersions,
  regesRecords,
  type Role,
} from '../db/schema';
import { Sealer } from '../db/seal';
import { appendAudit, type Actor, type Commands } from '../kernel/commands';
import {
  healthClasses,
  issuesWithoutHealth,
  openIssues,
  openRecords,
  sealIssues,
  sealRecords,
  type Sealed,
} from '../kernel/personal';
import { entryStands } from '../kernel/ledger';
import { loadState } from '../kernel/state';
import type { YearEndWorkItem } from '../kernel/work';
import {
  causeFromRule,
  cleanIdentifierText,
  countLabel,
  dateLabel,
  idLabel,
  periodLabel,
  textLabel,
} from '../kernel/work-names';

const money = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,2})?$/);
const localDate = z.iso.date();
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

export const employeeInput = z
  .object({
    lastName: z.string().trim().min(1).max(100),
    firstName: z.string().trim().min(1).max(100),
    cnp: z.string().regex(/^\d{13}$/),
    /** Needed only when the CNP does not give the century (codes 7, 8 and 9). */
    birthDate: localDate.optional(),
    /** The health insurance house the employee is insured with: a county (RO-GL, RO-B) or
     * OPSNAJ. */
    healthFund: z.string().regex(/^(RO-[A-Z]{1,2}|OPSNAJ)$/),
  })
  .strict();

export const partyCnpInput = z
  .object({ partyId: z.uuid(), cnp: z.string().regex(/^\d{13}$/) })
  .strict();

export const termsInput = z
  .object({
    /** Omitted for a new contract; given for a new version of its terms. */
    contractId: z.uuid().optional(),
    employeeId: z.uuid(),
    number: z.string().trim().min(1).max(40),
    startDate: localDate,
    endDate: localDate.optional(),
    effectiveFrom: localDate,
    /** Monthly base salary for the contract's working time, in lei. */
    baseSalary: money,
    dailyHours: z.number().int().min(1).max(8),
    mainJob: z.boolean(),
    /** COR occupation code. */
    occupation: z.string().regex(/^\d{6}$/),
    dependents: z.number().int().min(0).max(20).default(0),
    childrenInSchool: z.number().int().min(0).max(20).default(0),
    unionDues: money.default('0'),
    minimumExemption: z.enum(minimumExemptions).optional(),
    evidenceId: z.uuid().optional(),
    /** `mandate`: an administrator's administration or mandate contract, not an employment
     * contract (Codul fiscal art. 76 alin. (2) lit. o)); `mainJob` then says whether the person
     * declared the main job (funcția de bază) there. The same for every version. */
    kind: z.enum(['employment', 'mandate']).default('employment'),
  })
  .strict();

const label = z.string().trim().min(1).max(120);
/** A benefit in kind of the month, with the document its value comes from (norme pct. 14 alin.
 * (3): the computation is attached to the payroll). */
export const benefitEntry = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('car'),
      label,
      /** The vehicle's input value, or the month's rent paid to a third party. */
      inputValue: money.optional(),
      rent: money.optional(),
      /** Private and total kilometres of the month, for mixed use. */
      km: z
        .object({
          personal: z.number().int().min(0).max(100_000),
          total: z.number().int().min(1).max(100_000),
        })
        .strict()
        .optional(),
      passenger: z.boolean(),
      exclusiveBusiness: z.boolean(),
      evidenceId: z.uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('housing'),
      label,
      value: money,
      conditions: z.boolean(),
      evidenceId: z.uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('gift'),
      label,
      occasion: z.enum(giftOccasions),
      persons: z
        .array(z.object({ recipient: z.enum(['employee', 'child']), value: money }).strict())
        .min(1)
        .max(20),
      evidenceId: z.uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('insurance'),
      label,
      premium: money,
      health: z.boolean(),
      evidenceId: z.uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('other'),
      label,
      value: money,
      basis: z.string().trim().min(1).max(300),
      evidenceId: z.uuid(),
    })
    .strict(),
]);

export const garnishmentInput = z
  .object({
    contractId: z.uuid(),
    /** The creditor the withheld amounts are paid to. */
    partyId: z.uuid(),
    kind: z.enum(garnishmentKinds),
    reference: z.string().trim().min(1).max(100),
    receivedOn: localDate,
    total: money,
    /** What the order says to withhold each month: an amount, or a share of the net pay. */
    monthly: money.optional(),
    share: z.tuple([z.number().int().min(1).max(100), z.number().int().min(1).max(100)]).optional(),
    evidenceId: z.uuid(),
  })
  .strict();
export const garnishmentReleaseInput = z
  .object({ garnishmentId: z.uuid(), releasedOn: localDate, evidenceId: z.uuid() })
  .strict();
export const regesInput = z
  .object({
    contractId: z.uuid(),
    termsSeq: z.number().int().min(1),
    event: z.enum(['start', 'change', 'end']),
    transmittedOn: localDate,
    /** The receipt REGES-ONLINE gave. */
    evidenceId: z.uuid(),
  })
  .strict();

export const runInput = z
  .object({
    month,
    /** A month already posted is computed again only as a correction: an error found after
     * posting (or filing), or a retroactive change of a contract's terms, with the document that
     * shows it. Amounts owed for earlier months by law or a court's decision (art. 146 alin.
     * (9)–(9^1), D112 tip_rec 2) are not covered. */
    correction: z
      .object({ reason: z.enum(['error', 'retroactive', 'legal']), evidenceId: z.uuid() })
      .strict()
      .optional(),
    /** Working days in the month: weekdays less the public holidays of Codul muncii art. 139,
     * unless the company's calendar differs. */
    workingDays: z.number().int().min(1).max(23).optional(),
    /** What differs from the contract's terms; a contract without an entry worked the full
     * month at its base salary, which needs no entry only when its terms cover the month. */
    entries: z
      .array(
        z
          .object({
            contractId: z.uuid(),
            activeDays: z.number().int().min(0).max(23).optional(),
            items: z
              .array(
                z
                  .object({
                    kind: z.enum(payItemKinds),
                    amount: money,
                    label: z.string().trim().min(1).max(120),
                  })
                  .strict(),
              )
              .max(50)
              .optional(),
            /** Only in the month the employee turns 26: whether the young deduction applies. */
            under26: z.boolean().optional(),
            /** Working days of annual leave, within the active days: without `items`, the leave
             * pay is computed from the contract's previous three posted months. */
            leaveDays: z.number().int().min(1).max(23).optional(),
            /** The medical certificates of the month, in date order: the contract is suspended
             * on their working days, and the sick pay is computed. */
            sickLeave: z
              .array(
                z
                  .object({
                    series: z.string().trim().min(1).max(10),
                    number: z.string().trim().min(1).max(20),
                    code: z.string().regex(/^\d{2}$/),
                    issued: localDate,
                    from: localDate,
                    to: localDate,
                    /** The certificate it continues, of the same episode. */
                    continues: z
                      .object({
                        series: z.string().trim().min(1).max(10),
                        number: z.string().trim().min(1).max(20),
                      })
                      .strict()
                      .optional(),
                    hospitalized: z.boolean().default(false),
                    /** Who prescribed it (D112's Nomenclator 8): the family doctor, a hospital,
                     * an ambulatory specialist or the health insurance house. D112 needs it. */
                    place: z.enum(d112PrescriptionPlaces).optional(),
                    /** The diagnosis code written on the certificate, kept sealed: health data
                     * only D112 opens. */
                    diagnosis: z
                      .string()
                      .trim()
                      .regex(/^[0-9A-Za-z]{1,3}$/)
                      .optional(),
                    /** The child's CNP (codes 09, 91) or the patient's (17), kept sealed. */
                    careCnp: z
                      .string()
                      .regex(/^\d{13}$/)
                      .optional(),
                    /** The emergency's code (06, D_11) or the infectious disease's (05, 51, D_12). */
                    urgencyCode: z
                      .string()
                      .regex(/^\d{1,3}$/)
                      .optional(),
                    infectiousCode: z
                      .string()
                      .regex(/^\d{1,2}$/)
                      .optional(),
                    /** For a work accident or occupational disease (02–04): the territorial
                     * pension house confirmed it (Legea nr. 346/2002 art. 19 alin. (7)). */
                    accidentConfirmed: z.boolean().optional(),
                  })
                  .strict(),
              )
              .max(10)
              .optional(),
            /** The base of an episode starting this month when the payroll does not hold six of
             * the previous twelve months: from the employee's stage certificate (adeverința de
             * stagiu), the insured incomes, each month capped, and the insured working days. For a
             * work accident (02–04) without a posted month: the monthly average of the gross
             * salary income and the working days of the certificate's month (Legea nr. 346/2002
             * art. 19). */
            sickBase: z
              .object({ income: money, days: z.number().int().min(1).max(140) })
              .strict()
              .optional(),
            /** The month's benefits in kind, in the order the employer sets for the 33% cap of
             * art. 76 alin. (4^1) (alin. (4^2)). */
            benefits: z.array(benefitEntry).max(20).optional(),
          })
          .strict(),
      )
      .max(500)
      .default([]),
  })
  .strict();
export const runIdInput = z.object({ runId: z.uuid() }).strict();

/** Personal data at rest (`db/seal.ts`), kept here for the modules that seal with it. */
export { Sealer };

/** The month's posted payroll runs, by round: each posting's run, while its entry stands. */
export async function postedRuns(tx: Transaction, companyId: string, month: string) {
  const rows = await tx
    .select({ input: proposalVersions.input, subject: proposals.subjectKey })
    .from(entries)
    .innerJoin(
      proposals,
      and(eq(proposals.companyId, entries.companyId), eq(proposals.id, entries.proposalId)),
    )
    .innerJoin(
      proposalVersions,
      and(
        eq(proposalVersions.companyId, entries.companyId),
        eq(proposalVersions.proposalId, entries.proposalId),
        eq(proposalVersions.version, entries.version),
      ),
    )
    .where(
      and(
        eq(entries.companyId, companyId),
        like(proposals.subjectKey, `payroll:${month}:%`),
        entryStands('"acc_entries"'),
      ),
    );
  return rows
    .map((row) => ({
      round: Number(row.subject.split(':')[2]),
      runId: (JSON.parse(row.input) as { runId: string }).runId,
    }))
    .sort((a, b) => a.round - b.round);
}

/** The month's posted payroll run: the latest round standing, which a correction makes the
 * month's. */
export async function postedRun(tx: Transaction, companyId: string, month: string) {
  return (await postedRuns(tx, companyId, month)).at(-1)?.runId;
}

const previousMonth = (month: string, back: number) => {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 - back;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
};

/** `numerator / denominator` bani in whole lei, half up. */
const wholeLei = (numerator: bigint, denominator: bigint) => {
  const whole = numerator / (denominator * 100n);
  const rest = numerator - whole * denominator * 100n;
  return (2n * rest >= denominator * 100n ? whole + 1n : whole) * 100n;
};

/** The birth date a CNP encodes, or null when its first digit does not give the century. */
export function birthDateOf(cnp: string): string | null {
  const century = { '1': '19', '2': '19', '3': '18', '4': '18', '5': '20', '6': '20' }[cnp[0]!];
  return century ? `${century}${cnp.slice(1, 3)}-${cnp.slice(3, 5)}-${cnp.slice(5, 7)}` : null;
}

type Terms = typeof employmentTerms.$inferSelect;
/** A certificate as the run keeps it in the line's input: what was given, what was paid (bani as
 * strings), and its episode for the next month's continuation. */
export type StoredSick = {
  series: string;
  number: string;
  code: string;
  issued: string;
  from: string;
  to: string;
  continues?: { series: string; number: string };
  hospitalized: boolean;
  place?: (typeof d112PrescriptionPlaces)[number];
  /** The diagnosis code, sealed for the company. */
  diagnosisSealed?: string;
  /** The child's or patient's CNP, sealed for the company. */
  careCnpSealed?: string;
  urgencyCode?: string;
  infectiousCode?: string;
  /** A work accident or occupational disease the pension house confirmed. */
  accidentConfirmed?: boolean;
  /** Working days of the certificate, all suspended. */
  days: number;
  unpaidDays: number;
  employerDays: number;
  fundDays: number;
  dailyAverage: string;
  percent: string;
  employer: string;
  fund: string;
  /** The episode up to this certificate: `days` calendar days ending on `to`. */
  episode: SickEpisode & {
    base: { income: string; days: number };
    days: number;
    percent: string;
    to: string;
  };
};
/**
 * A line's medical certificates as the run paid them, opened from their seals (`sealRecords`):
 * for the next month's computation, which continues their episodes, and for D112, which declares
 * them. A run computed before 6 November 2026 kept them in clear until its data step sealed them.
 */
export function openSick(
  sealer: Sealer,
  companyId: string,
  sick: readonly (StoredSick | Sealed)[] | undefined,
): StoredSick[] {
  return openRecords<StoredSick>(sealer, companyId, sick);
}

const lei = (bani: bigint) => formatMoney(bani, 'RON');
const zero = {
  cash: 0n,
  vouchers: 0n,
  cas: 0n,
  cass: 0n,
  casEmployer: 0n,
  cassEmployer: 0n,
  tax: 0n,
  unionDues: 0n,
  net: 0n,
  cam: 0n,
};

/** The codes of work accidents and occupational diseases (Legea nr. 346/2002). */
const accidentCodes = ['02', '03', '04'];

/** The pay items of a certificate's two parts, by how its code is taxed (`ro.sick.codes`). */
function sickKinds(rule: SickCodeRule) {
  if (rule.payer === 'employer_then_pension_house')
    return { employer: 'accident_employer' as const, fund: 'accident_fund' as const };
  return {
    employer: rule.cass ? ('sick_employer' as const) : ('sick_employer_nocass' as const),
    fund: !rule.taxable
      ? ('sick_fund_exempt' as const)
      : rule.cass
        ? ('sick_fund' as const)
        : ('sick_fund_nocass' as const),
  };
}

/** Benefits as the line keeps them: amounts as strings. */
function benefitRecord(results: readonly BenefitResult[]) {
  return results.map((result) => ({
    kind: result.kind,
    label: result.label,
    taxable: result.taxable.map((part) => ({ field: part.field, amount: String(part.amount) })),
    exempt: result.exempt.map((part) => ({ field: part.field, amount: String(part.amount) })),
    exemptCents: String(result.exemptCents),
    steps: result.steps.map((item) => ({ ...item, amount: String(item.amount) })),
  }));
}
export type StoredBenefit = ReturnType<typeof benefitRecord>[number];

export class Payroll {
  private readonly sealer: Sealer;
  /** Individuals' party identifiers: a keyed hash of the CNP, never the CNP. */
  private readonly identities: PartyIdentities;

  constructor(
    private readonly commands: Commands,
    secret: string,
    private readonly rules: (tx: Transaction, companyId: string) => Promise<RuleContext>,
  ) {
    this.sealer = new Sealer(secret);
    this.identities = new PartyIdentities(secret);
  }

  /** An employee, as a party (the same identity as a buyer who is this person: the keyed hash of
   * the CNP) with the CNP sealed. */
  recordEmployee(actor: Actor, key: string, input: z.infer<typeof employeeInput>) {
    return this.commands.run(actor, key, 'payroll.employees.record', input, 'write', async (tx) => {
      requireCondition(isValidCnp(input.cnp), 'CNP', 'CNP-ul nu este valid.');
      const birthDate = birthDateOf(input.cnp) ?? input.birthDate;
      requireCondition(
        birthDate,
        'BIRTH_DATE',
        'Pentru acest CNP, data nașterii se completează explicit.',
      );
      const taxId = this.identities.ofCnp(actor.companyId, input.cnp);
      const name = `${input.lastName} ${input.firstName}`;
      const [existing] = await tx
        .select()
        .from(parties)
        .where(
          and(
            eq(parties.companyId, actor.companyId),
            eq(parties.country, 'RO'),
            eq(parties.taxId, taxId),
          ),
        );
      if (existing) {
        const [employee] = await tx
          .select({ id: employees.id })
          .from(employees)
          .where(and(eq(employees.companyId, actor.companyId), eq(employees.partyId, existing.id)));
        requireCondition(!employee, 'EMPLOYEE_EXISTS', 'Salariatul este deja înregistrat.', 409);
      }
      const partyId = existing?.id ?? this.commands.ids();
      if (!existing)
        await tx.insert(parties).values({
          id: partyId,
          companyId: actor.companyId,
          kind: 'ro_individual',
          country: 'RO',
          taxId,
          name,
          createdBy: actor.actorId,
        });
      const id = this.commands.ids();
      await tx.insert(employees).values({
        id,
        companyId: actor.companyId,
        partyId,
        cnpSealed: this.sealer.seal(actor.companyId, input.cnp),
        birthDate,
        lastName: input.lastName,
        firstName: input.firstName,
        healthFund: input.healthFund,
        createdBy: actor.actorId,
      });
      return { id, partyId, name: existing?.name ?? name };
    });
  }

  /** An individual partner's CNP (a shareholder's, for D205), sealed. */
  recordPartyCnp(actor: Actor, key: string, input: z.infer<typeof partyCnpInput>) {
    return this.commands.run(
      actor,
      key,
      'parties.recordCnp',
      { partyId: input.partyId },
      'write',
      async (tx) => {
        requireCondition(isValidCnp(input.cnp), 'CNP', 'CNP-ul nu este valid.');
        const [party] = await tx
          .select()
          .from(parties)
          .where(and(eq(parties.companyId, actor.companyId), eq(parties.id, input.partyId)));
        requireCondition(
          party?.kind === 'ro_individual',
          'PARTY',
          'Partenerul trebuie să fie o persoană fizică.',
        );
        requireCondition(
          !party.taxId || party.taxId === this.identities.ofCnp(actor.companyId, input.cnp),
          'CNP_MISMATCH',
          'CNP-ul nu corespunde partenerului.',
        );
        const [existing] = await tx
          .select({ partyId: partyCnps.partyId })
          .from(partyCnps)
          .where(
            and(eq(partyCnps.companyId, actor.companyId), eq(partyCnps.partyId, input.partyId)),
          );
        requireCondition(
          !existing,
          'CNP_RECORDED',
          'CNP-ul partenerului este deja înregistrat.',
          409,
        );
        await tx.insert(partyCnps).values({
          companyId: actor.companyId,
          partyId: input.partyId,
          cnpSealed: this.sealer.seal(actor.companyId, input.cnp),
          createdBy: actor.actorId,
        });
        return { partyId: input.partyId };
      },
    );
  }

  /** A contract's terms: a new contract, or a new version of an existing one. */
  recordTerms(actor: Actor, key: string, input: z.infer<typeof termsInput>) {
    return this.commands.run(actor, key, 'payroll.contracts.record', input, 'write', async (tx) => {
      const [employee] = await tx
        .select()
        .from(employees)
        .where(and(eq(employees.companyId, actor.companyId), eq(employees.id, input.employeeId)));
      requireCondition(employee, 'EMPLOYEE', 'Salariatul nu există.', 404);
      requireCondition(
        (!input.endDate || input.endDate >= input.startDate) &&
          input.effectiveFrom >= input.startDate,
        'TERMS_DATES',
        'Contractul se termină după ce începe, iar modificările se aplică de la începerea lui.',
      );
      if (input.evidenceId) {
        const [file] = await tx
          .select({ id: evidence.id })
          .from(evidence)
          .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, input.evidenceId)));
        requireCondition(file, 'EVIDENCE', 'Documentul justificativ nu este disponibil.', 404);
      }
      const contractId = input.contractId ?? this.commands.ids();
      const [last] = input.contractId
        ? await tx
            .select()
            .from(employmentTerms)
            .where(
              and(
                eq(employmentTerms.companyId, actor.companyId),
                eq(employmentTerms.contractId, contractId),
              ),
            )
            .orderBy(desc(employmentTerms.seq))
            .limit(1)
        : [];
      requireCondition(
        input.kind === 'employment' || !input.minimumExemption,
        'MANDATE_TERMS',
        'Contribuția minimă (art. 146 alin. (5^6)) este a contractelor de muncă: un mandat nu are excepție de la ea.',
      );
      if (input.contractId) {
        requireCondition(last, 'CONTRACT', 'Contractul nu există.', 404);
        requireCondition(
          last.kind === input.kind,
          'TERMS_KIND',
          'O versiune nouă a contractului păstrează felul lui (contract de muncă sau mandat).',
        );
        requireCondition(
          last.employeeId === input.employeeId && input.effectiveFrom >= last.effectiveFrom,
          'TERMS_ORDER',
          'O versiune nouă a contractului este a aceluiași salariat și se aplică după cea anterioară.',
        );
      }
      const seq = (last?.seq ?? 0) + 1;
      await tx.insert(employmentTerms).values({
        companyId: actor.companyId,
        contractId,
        seq,
        employeeId: input.employeeId,
        number: input.number,
        startDate: input.startDate,
        endDate: input.endDate ?? null,
        effectiveFrom: input.effectiveFrom,
        baseSalaryBani: parseMoney(input.baseSalary, 'RON'),
        dailyHours: input.dailyHours,
        mainJob: input.mainJob,
        occupation: input.occupation,
        dependents: input.dependents,
        childrenInSchool: input.childrenInSchool,
        unionDuesBani: parseMoney(input.unionDues, 'RON'),
        minimumExemption: input.minimumExemption ?? null,
        evidenceId: input.evidenceId ?? null,
        kind: input.kind,
        createdBy: actor.actorId,
      });
      return { contractId, seq };
    });
  }

  listEmployees(actor: Actor) {
    return this.commands.db.read(async (tx) => {
      const rows = await tx
        .select({ id: employees.id, partyId: employees.partyId, name: parties.name })
        .from(employees)
        .innerJoin(
          parties,
          and(eq(parties.companyId, employees.companyId), eq(parties.id, employees.partyId)),
        )
        .where(eq(employees.companyId, actor.companyId))
        .orderBy(asc(parties.name));
      return rows;
    });
  }

  listContracts(actor: Actor) {
    return this.commands.db.read(async (tx) => {
      const rows = await tx
        .select()
        .from(employmentTerms)
        .where(eq(employmentTerms.companyId, actor.companyId))
        .orderBy(asc(employmentTerms.contractId), asc(employmentTerms.seq));
      const contracts = new Map<string, ReturnType<typeof termsView>[]>();
      for (const row of rows)
        contracts.set(row.contractId, [...(contracts.get(row.contractId) ?? []), termsView(row)]);
      return [...contracts].map(([contractId, versions]) => ({
        contractId,
        employeeId: versions[0]!.employeeId,
        versions,
      }));
    });
  }

  /**
   * Computes a month's payroll from the contracts' terms and what differs this month. The run is
   * kept as computed, with the issues that stop it; computing the month again supersedes it.
   */
  prepareRun(actor: Actor, key: string, input: z.infer<typeof runInput>) {
    return this.commands.run(
      actor,
      key,
      'payroll.runs.prepare',
      input,
      'write',
      (tx) => this.computeRun(tx, actor, input),
      (tx, access, run) => this.shown(tx, actor, access.role, run),
    );
  }

  /** A month's run computed and stored (`payroll.runs.prepare`). */
  private async computeRun(tx: Transaction, actor: Actor, input: z.infer<typeof runInput>) {
    const monthDays = input.workingDays ?? workingDays(input.month as Month);
    // A posted month is computed again only as a correction, a later round that books the
    // difference (`payroll.recognize`) and makes the month's D112 rectifying.
    const posted = (await postedRuns(tx, actor.companyId, input.month)).at(-1);
    requireCondition(
      !posted || input.correction,
      'RUN_POSTED',
      `Statul de plată pentru ${input.month} este înregistrat: o corecție se calculează cu motivul și documentul ei (correction).`,
    );
    requireCondition(
      posted || !input.correction,
      'CORRECTION_NOTHING',
      `Luna ${input.month} nu are un stat de plată înregistrat de corectat.`,
    );
    requireCondition(
      input.correction?.reason !== 'legal',
      'CORRECTION_LEGAL',
      'Salariile sau diferențele stabilite prin lege ori prin hotărâre judecătorească pentru perioade anterioare (Codul fiscal art. 78 alin. (3)–(4), art. 146 alin. (9)–(9^1), D112 cu tip_rec 2) nu sunt acoperite de aplicație.',
    );
    if (input.correction) {
      const [file] = await tx
        .select({ id: evidence.id })
        .from(evidence)
        .where(
          and(
            eq(evidence.companyId, actor.companyId),
            eq(evidence.id, input.correction.evidenceId),
          ),
        );
      requireCondition(file, 'EVIDENCE', 'Documentul corecției nu este disponibil.', 404);
    }
    const round = posted ? posted.round + 1 : 1;
    const start = monthStart(input.month as Month);
    const end = monthEnd(input.month as Month);
    const rules = await this.rules(tx, actor.companyId);
    if (input.correction?.reason === 'retroactive') {
      let reading: string | null = null;
      try {
        reading = rules.param<string>(
          'ro.payroll.correction.retroactive',
          'payroll_month_start',
          start,
        );
      } catch (error) {
        if (!(error instanceof RuleGapError)) throw error;
      }
      requireCondition(
        reading === 'recompute_month',
        'RULE_GAP',
        'Regula corecției retroactive (ro.payroll.correction.retroactive) nu acoperă luna.',
      );
    }
    const { loaded: profile } = await loadState(tx, actor.companyId, { profile: true });
    const regime = profileAt(profile, 'income_tax', end);
    const minimumNet = this.minimumNet(input.month, monthDays, rules);
    // Since when a lowered base salary loses the minimum-wage relief, if the month has one.
    let frozenSince: string | null = null;
    try {
      frozenSince = rules.param<MinimumWageRelief>(
        'ro.payroll.minimum_wage_relief',
        'payroll_month_start',
        start,
      ).baseFrozenSince;
    } catch (error) {
      if (!(error instanceof RuleGapError)) throw error;
    }
    const allTerms = await tx
      .select()
      .from(employmentTerms)
      .where(eq(employmentTerms.companyId, actor.companyId))
      .orderBy(asc(employmentTerms.contractId), asc(employmentTerms.seq));
    const byContract = new Map<string, Terms[]>();
    for (const row of allTerms)
      byContract.set(row.contractId, [...(byContract.get(row.contractId) ?? []), row]);
    const entryOf = new Map(input.entries.map((entry) => [entry.contractId, entry]));
    for (const contractId of entryOf.keys())
      requireCondition(
        byContract.has(contractId),
        'ENTRY_CONTRACT',
        'O linie a statului se referă la un contract necunoscut.',
      );
    const birthDates = new Map(
      (
        await tx
          .select({
            id: employees.id,
            birthDate: employees.birthDate,
            partyId: employees.partyId,
          })
          .from(employees)
          .where(eq(employees.companyId, actor.companyId))
      ).map((row) => [row.id, row]),
    );

    const lines: (typeof payrollLines.$inferInsert)[] = [];
    for (const [contractId, versions] of byContract) {
      const inForce = versions.filter((version) => version.effectiveFrom <= end);
      const terms = inForce.at(-1);
      const entry = entryOf.get(contractId);
      const active = terms && terms.startDate <= end && (!terms.endDate || terms.endDate >= start);
      if (!active) {
        requireCondition(
          !entry,
          'ENTRY_INACTIVE',
          'O linie a statului se referă la un contract care nu este activ în lună.',
        );
        continue;
      }
      const issues: (PayIssue & { health?: true })[] = [];
      const mandate = terms.kind === 'mandate';
      if (mandate && (entry?.leaveDays || entry?.sickLeave?.length))
        issues.push({
          ...(entry?.sickLeave?.length ? { health: true as const } : {}),
          code: 'MANDATE_LEAVE',
          message:
            'Pentru un contract de mandat, concediul de odihnă și concediul medical nu sunt calculate de aplicație (Codul muncii nu se aplică mandatului; asigurarea pentru concedii medicale a administratorului este de stabilit cu expertul contabil).',
        });
      const full = terms.startDate <= start && (!terms.endDate || terms.endDate >= end);
      const changed = versions.some(
        (version) => version.effectiveFrom > start && version.effectiveFrom <= end,
      );
      // Sick leave suspends the contract on the certificates' working days.
      const sick = entry?.sickLeave?.length
        ? await this.sickPay(tx, actor.companyId, contractId, input.month, entry, rules)
        : null;
      // A certificate's issues name it and its code: health data, redacted for a reader who
      // may not read it (`issuesWithoutHealth`).
      if (sick) issues.push(...sick.issues.map((issue) => ({ ...issue, health: true as const })));
      const suspended = sick?.suspendedDays ?? 0;
      const activeDays = entry?.activeDays ?? (full ? monthDays - suspended : undefined);
      if (activeDays === undefined)
        issues.push({
          code: 'PARTIAL_MONTH',
          message: 'Contractul începe sau se încheie în lună: completați zilele active.',
        });
      else if (activeDays + suspended > monthDays)
        issues.push({
          code: 'DAYS',
          message: 'Zilele active și cele de concediu medical depășesc zilele lucrătoare.',
        });
      let leave: Record<string, string | number> | null = null;
      let leaveItems: PayInput['items'] | undefined;
      if (entry?.leaveDays && activeDays !== undefined) {
        if (entry.leaveDays > activeDays)
          issues.push({
            code: 'LEAVE_DAYS',
            message: 'Zilele de concediu depășesc zilele active.',
          });
        else if (!entry.items) {
          // Codul muncii art. 150: the daily average of the previous three months' pay, at
          // least the base salary for the leave days; bonuses are not averaged.
          const history = await this.leaveHistory(tx, actor.companyId, contractId, input.month);
          const base = terms.baseSalaryBani;
          const days = BigInt(monthDays);
          const leaveDays = BigInt(entry.leaveDays);
          const averaged = history.days > 0 && history.amount * days > base * BigInt(history.days);
          const pay = averaged
            ? wholeLei(history.amount * leaveDays, BigInt(history.days))
            : wholeLei(base * leaveDays, days);
          const worked = wholeLei(base * BigInt(activeDays - entry.leaveDays), days);
          leaveItems = [
            ...(worked
              ? [{ kind: 'salary' as const, amount: worked, label: 'Salariu de bază' }]
              : []),
            {
              kind: 'leave' as const,
              amount: pay,
              label: `Concediu de odihnă, ${entry.leaveDays} zile`,
            },
          ];
          leave = {
            days: entry.leaveDays,
            basis: averaged ? 'average' : 'base',
            historyAmount: String(history.amount),
            historyDays: history.days,
            months: history.months,
            clause: 'L53/2003-A:art.150',
          };
        }
      }
      if (sick && entry?.items?.some((item) => item.kind.startsWith('sick_')))
        issues.push({
          code: 'SICK_ITEMS',
          message:
            'Indemnizațiile de concediu medical se calculează din certificate: nu le completați și în sumele lunii.',
        });
      const worked =
        sick && !leaveItems && !entry?.items && full && !changed && activeDays !== undefined
          ? wholeLei(terms.baseSalaryBani * BigInt(activeDays), BigInt(monthDays))
          : null;
      const ownItems =
        leaveItems ??
        entry?.items?.map((item) => ({
          kind: item.kind,
          amount: parseMoney(item.amount, 'RON'),
          label: item.label,
        })) ??
        (worked !== null
          ? worked
            ? [{ kind: 'salary' as const, amount: worked, label: 'Salariu de bază' }]
            : []
          : full && !changed && activeDays === monthDays
            ? [
                {
                  kind: 'salary' as const,
                  amount: terms.baseSalaryBani,
                  label: 'Salariu de bază',
                },
              ]
            : undefined);
      // Benefits in kind: valued with their documents, the taxable part an item of the month.
      let benefitResults: BenefitResult[] = [];
      if (entry?.benefits?.length) {
        const valued = await this.benefits(
          tx,
          actor.companyId,
          contractId,
          input.month,
          entry.benefits,
          { baseSalary: terms.baseSalaryBani, micro: regime ? regime === 'micro' : null },
          rules,
        );
        issues.push(...valued.issues);
        benefitResults = valued.results;
      }
      // Vouchers within Legea nr. 165/2018 (`ro.payroll.voucher.limits`): an excess is a benefit
      // in every base, declared with the others.
      let voucherItems = ownItems;
      const voucherKinds: PayItemKind[] = ['meal_vouchers', 'holiday_vouchers'];
      const statedOf = (kind: PayItemKind) =>
        (ownItems ?? [])
          .filter((item) => item.kind === kind)
          .reduce((total, item) => total + item.amount, 0n);
      const meal = statedOf('meal_vouchers');
      const holiday = statedOf('holiday_vouchers');
      if (ownItems && (meal || holiday) && activeDays !== undefined)
        try {
          const split = voucherExcess(
            input.month as Month,
            { meal, holiday },
            {
              daysWorked: activeDays - (entry?.leaveDays ?? 0),
              holidayEarlier: holiday
                ? await this.holidayVouchersEarlier(tx, actor.companyId, contractId, input.month)
                : 0n,
              minimumWage:
                BigInt(
                  rules.param<string>('ro.payroll.minimum_wage', 'payroll_month_start', start),
                ) * 100n,
            },
            rules,
          );
          issues.push(...split.issues);
          if (split.excess.length) {
            benefitResults = [...benefitResults, ...split.excess];
            const labelOf = (kind: PayItemKind) =>
              ownItems.find((item) => item.kind === kind)!.label;
            voucherItems = [
              ...ownItems.filter((item) => !voucherKinds.includes(item.kind)),
              ...(split.meal
                ? [
                    {
                      kind: 'meal_vouchers' as const,
                      amount: split.meal,
                      label: labelOf('meal_vouchers'),
                    },
                  ]
                : []),
              ...(split.holiday
                ? [
                    {
                      kind: 'holiday_vouchers' as const,
                      amount: split.holiday,
                      label: labelOf('holiday_vouchers'),
                    },
                  ]
                : []),
            ];
          }
        } catch (error) {
          if (!(error instanceof RuleGapError)) throw error;
          issues.push({ code: 'RULE_GAP', message: error.message });
        }
      const benefitItems = benefitResults.flatMap((result) => {
        const taxable = benefitTotals([result]).taxable;
        return taxable ? [{ kind: 'benefit' as const, amount: taxable, label: result.label }] : [];
      });
      const items = voucherItems
        ? [...voucherItems, ...(sick?.items ?? []), ...benefitItems]
        : voucherItems;
      if (!items)
        issues.push({
          code: 'SALARY_ITEMS',
          message:
            'Pentru o lună incompletă sau cu termenii contractului modificați, completați sumele lunii.',
        });
      const person = birthDates.get(terms.employeeId)!;
      const turns26 = `${Number(person.birthDate.slice(0, 4)) + 26}${person.birthDate.slice(4)}`;
      const under26 = turns26 > end ? true : turns26 <= start ? false : entry?.under26;
      if (under26 === undefined)
        issues.push({
          code: 'YOUNG_TO_DECIDE',
          message:
            'Salariatul împlinește 26 de ani în această lună: precizați dacă se acordă deducerea suplimentară.',
        });
      let computed: { result: PayResult | null; issues: PayIssue[] } = { result: null, issues };
      let payInput: PayInput | null = null;
      if (!issues.length) {
        payInput = {
          month: input.month as Month,
          baseSalary: terms.baseSalaryBani,
          dailyHours: terms.dailyHours,
          mainJob: terms.mainJob,
          workingDays: monthDays,
          activeDays: activeDays!,
          items: items!,
          dependents: terms.dependents,
          under26: under26!,
          childrenInSchool: terms.childrenInSchool,
          unionDues: terms.unionDuesBani,
          minimumExemption: (terms.minimumExemption as PayInput['minimumExemption']) ?? null,
          ...(mandate ? { mandate: true } : {}),
          baseReduced: frozenSince
            ? versions.some(
                (version, index) =>
                  index > 0 &&
                  version.effectiveFrom >= frozenSince &&
                  version.effectiveFrom <= end &&
                  version.baseSalaryBani < versions[index - 1]!.baseSalaryBani,
              )
            : false,
        };
        computed = calculatePay(payInput, rules);
      }
      // Garnishments take from the net pay, in the Labour Code's order and within the limits.
      let garnished: { orderId: string; partyId: string; amount: bigint }[] = [];
      if (computed.result) {
        const orders = await this.ordersOf(tx, actor.companyId, contractId, end);
        if (orders.length) {
          const taken = garnish(
            input.month as Month,
            computed.result.net,
            orders.map((order) => order.order),
            {
              minimumNet,
              protectedIndemnities: (sick?.items.length ?? 0) > 0,
            },
            rules,
          );
          if (taken.issues.length)
            computed = { result: null, issues: [...computed.issues, ...taken.issues] };
          else {
            computed.result.steps.push(...taken.steps);
            garnished = taken.withheld.map((item) => ({
              ...item,
              partyId: orders.find((order) => order.order.id === item.orderId)!.partyId,
            }));
          }
        }
      }
      const amounts = computed.result ?? zero;
      lines.push({
        companyId: actor.companyId,
        runId: '',
        contractId,
        termsSeq: terms.seq,
        employeeId: terms.employeeId,
        partyId: person.partyId,
        input: canonical({
          ...(payInput ?? { activeDays: activeDays ?? null, items: items ?? null }),
          ...(leave ? { leave } : {}),
          // Each certificate sealed whole (`sealRecords`): opened only to continue its episode
          // next month and to write D112 (`openSick`).
          ...(sick ? { sick: sealRecords(this.sealer, actor.companyId, sick.record) } : {}),
          ...(benefitResults.length ? { benefits: benefitRecord(benefitResults) } : {}),
          // The documents the benefits' values come from: payroll and personal files
          // (`evidenceClasses`).
          ...(entry?.benefits?.length
            ? {
                benefitEvidence: [
                  ...new Set(entry.benefits.map((benefit) => benefit.evidenceId)),
                ].sort(),
              }
            : {}),
        }),
        result: canonical(
          computed.result
            ? {
                steps: computed.result.steps,
                deduction: computed.result.deduction,
                ...(garnished.length
                  ? {
                      garnishments: garnished.map((item) => ({
                        ...item,
                        amount: String(item.amount),
                      })),
                    }
                  : {}),
              }
            : { issues: sealIssues(this.sealer, actor.companyId, computed.issues) },
        ),
        cash: amounts.cash,
        vouchers: amounts.vouchers,
        cas: amounts.cas,
        cass: amounts.cass,
        casEmployer: amounts.casEmployer,
        cassEmployer: amounts.cassEmployer,
        tax: amounts.tax,
        unionDues: amounts.unionDues,
        net: amounts.net,
        cam: amounts.cam,
        issues: computed.issues.length,
      });
    }
    requireCondition(
      lines.length,
      'NO_CONTRACTS',
      `Niciun contract nu este activ în ${input.month}.`,
    );

    const id = this.commands.ids();
    const resultHash = hashOf(lines.map(({ companyId: _company, runId: _run, ...line }) => line));
    const issueCount = lines.filter((line) => line.issues).length;
    await tx.insert(payrollRuns).values({
      id,
      companyId: actor.companyId,
      month: input.month,
      round,
      workingDays: monthDays,
      resultHash,
      issues: issueCount,
      ...(posted
        ? {
            corrects: posted.runId,
            correctionReason: input.correction!.reason as 'error' | 'retroactive',
            correctionEvidenceId: input.correction!.evidenceId,
          }
        : {}),
      createdBy: actor.actorId,
    });
    await tx.insert(payrollRunEvents).values({
      companyId: actor.companyId,
      runId: id,
      seq: 1,
      state: 'prepared',
      createdBy: actor.actorId,
    });
    await tx.insert(payrollLines).values(lines.map((line) => ({ ...line, runId: id })));
    for (const previous of await this.runsOf(tx, actor.companyId, input.month))
      if (previous.id !== id && previous.state === 'prepared' && previous.round === round)
        await tx.insert(payrollRunEvents).values({
          companyId: actor.companyId,
          runId: previous.id,
          seq: previous.seq + 1,
          state: 'superseded',
          detail: `Înlocuit de ${id}.`,
          createdBy: actor.actorId,
        });
    await appendAudit(tx, {
      companyId: actor.companyId,
      actorId: actor.actorId,
      ...(actor.agentId ? { agentId: actor.agentId } : {}),
      action: 'payroll.runs.prepared',
      body: { runId: id, month: input.month, lines: lines.length, issues: issueCount },
    });
    return this.view(tx, actor.companyId, id);
  }

  /**
   * The sick pay of a month's certificates (OUG 158/2005, code 01): each episode's base from the
   * six most recent of the twelve months before it, from the posted runs (or from the stage
   * certificate when the payroll does not hold six), carried with the employer's days and the
   * reduced day to the certificates that continue it, in this month or the next.
   */
  private async sickPay(
    tx: Transaction,
    companyId: string,
    contractId: string,
    month: string,
    entry: NonNullable<z.infer<typeof runInput>['entries']>[number],
    rules: RuleContext,
  ) {
    const issues: PayIssue[] = [];
    const items: PayInput['items'][number][] = [];
    const record: StoredSick[] = [];
    let suspendedDays = 0;
    type Episode = SickEpisode & { base: SickBase; days: number; percent: string; to: string };
    const episodes = new Map<string, Episode>();
    const key = (series: string, number: string) => `${series}/${number}`;
    // Certificates of the previous month that this month's may continue.
    const previousRun = await postedRun(tx, companyId, previousMonth(month, 1));
    if (previousRun) {
      const [line] = await tx
        .select({ input: payrollLines.input })
        .from(payrollLines)
        .where(
          and(
            eq(payrollLines.companyId, companyId),
            eq(payrollLines.runId, previousRun),
            eq(payrollLines.contractId, contractId),
          ),
        );
      const stored = line ? (JSON.parse(line.input) as { sick?: StoredSick[] }) : {};
      for (const item of openSick(this.sealer, companyId, stored.sick))
        episodes.set(key(item.series, item.number), {
          ...item.episode,
          base: { income: BigInt(item.episode.base.income), days: item.episode.base.days },
        });
    }
    for (const given of entry.sickLeave ?? []) {
      const certificate: SickCertificate = {
        series: given.series,
        number: given.number,
        code: given.code,
        issued: given.issued as LocalDate,
        from: given.from as LocalDate,
        to: given.to as LocalDate,
        continuation: Boolean(given.continues),
        hospitalized: given.hospitalized,
        ...(accidentCodes.includes(given.code) && given.urgencyCode ? { emergency: true } : {}),
      };
      if (!given.from.startsWith(month)) {
        issues.push({
          code: 'SICK_DATES',
          message: `Certificatul ${given.series} ${given.number} nu este din ${month}.`,
        });
        continue;
      }
      const earlier = given.continues
        ? episodes.get(key(given.continues.series, given.continues.number))
        : undefined;
      if (given.continues && !earlier) {
        issues.push({
          code: 'SICK_CONTINUES',
          message: `Certificatul ${given.series} ${given.number} continuă un certificat care nu este în statul acestei luni sau al lunii trecute.`,
        });
        continue;
      }
      if (earlier && addDays(earlier.to as LocalDate, 1) !== given.from) {
        issues.push({
          code: 'SICK_CONTINUES',
          message: `Certificatul ${given.series} ${given.number} nu începe a doua zi după certificatul pe care îl continuă.`,
        });
        continue;
      }
      // A work accident is paid under Legea nr. 346/2002 once the pension house confirmed it; how
      // an unconfirmed one is paid and declared in the meantime (section D's codes 02–04, art. 33
      // alin. (4)–(5)) the texts leave to the expert.
      const accident = accidentCodes.includes(given.code);
      if (accident && !given.accidentConfirmed) {
        issues.push({
          code: 'SICK_ACCIDENT_UNCONFIRMED',
          message: `Certificatul ${given.series} ${given.number} (cod ${given.code}) este pentru un accident de muncă sau o boală profesională neconfirmată de casa teritorială de pensii: plata și declararea până la confirmare (Legea nr. 346/2002 art. 19 alin. (7), art. 33 alin. (4)–(5); D112 secțiunea D) se stabilesc cu expertul contabil.`,
        });
        continue;
      }
      // A work accident's episode keeps its monthly average (the months before the risk, art. 33
      // alin. (1)) over the working days of each month it is paid in (art. 19 alin. (4)).
      let base =
        earlier?.base && accident
          ? { income: earlier.base.income, days: workingDays(month as Month) }
          : earlier?.base;
      if (!base && accident) {
        const history = await this.accidentHistory(tx, companyId, contractId, month);
        base = entry.sickBase
          ? { income: parseMoney(entry.sickBase.income, 'RON'), days: entry.sickBase.days }
          : history.months
            ? { income: history.income / BigInt(history.months), days: workingDays(month as Month) }
            : undefined;
        if (!base) {
          issues.push({
            code: 'SICK_BASE',
            message:
              'Statul nu are luni postate pentru baza accidentului de muncă (Legea nr. 346/2002 art. 19): completați în sickBase media lunară a veniturilor brute și zilele lucrătoare ale lunii.',
          });
          continue;
        }
      }
      if (!base) {
        const history = await this.sickHistory(tx, companyId, contractId, month, rules);
        base = entry.sickBase
          ? { income: parseMoney(entry.sickBase.income, 'RON'), days: entry.sickBase.days }
          : history.months.length === 6
            ? history
            : undefined;
        if (!base) {
          issues.push({
            code: 'SICK_BASE',
            message: `Statul are ${history.months.length} din cele 6 luni ale bazei de calcul: completați baza din adeverința de stagiu (sickBase).`,
          });
          continue;
        }
      }
      const { result, issues: found } = sickIndemnity(
        certificate,
        base,
        earlier ?? { reduced: false, employerDays: 0 },
        rules,
      );
      issues.push(...found);
      if (!result) continue;
      const length =
        Math.round(
          (Date.parse(`${given.to}T00:00:00Z`) - Date.parse(`${given.from}T00:00:00Z`)) /
            86_400_000,
        ) + 1;
      const days = (earlier?.days ?? 0) + length;
      // A continuation whose episode reaches another percentage than its own certificate: art.
      // 17 alin. (1^2) recalculates the earlier month from July 2026, which is not built yet.
      const tier = (value: number) => (value <= 7 ? 1 : value <= 14 ? 2 : 3);
      if (given.code === '01' && earlier && tier(days) !== tier(length)) {
        issues.push({
          code: 'SICK_RECALCULATION',
          message: `Episodul certificatului ${given.series} ${given.number} ajunge la ${days} zile: procentul și recalcularea lunii anterioare (art. 17 alin. (1^2)) se stabilesc cu expertul contabil.`,
        });
        continue;
      }
      suspendedDays += result.days;
      // The item names no certificate and no code: those are kept sealed with the certificate.
      const label = 'Concediu medical';
      // The code decides the bases: CASS only for 01 and 07 here, no tax on what art. 62 lit. c)
      // leaves out (`ro.sick.codes`).
      const kinds = sickKinds(result.rule);
      if (result.employer)
        items.push({
          kind: kinds.employer,
          amount: result.employer,
          label: `${label} (angajator)`,
        });
      if (result.fund)
        items.push({
          kind: kinds.fund,
          amount: result.fund,
          label: `${label} (${accident ? 'bugetul asigurărilor sociale de stat' : 'FNUASS'})`,
        });
      const episode: Episode = {
        reduced: (earlier?.reduced ?? false) || result.unpaidDays > 0 || given.hospitalized,
        employerDays: (earlier?.employerDays ?? 0) + result.employerDays,
        base,
        days,
        percent: result.percent,
        to: given.to,
      };
      episodes.set(key(given.series, given.number), episode);
      record.push({
        series: given.series,
        number: given.number,
        code: given.code,
        issued: given.issued,
        from: given.from,
        to: given.to,
        ...(given.continues ? { continues: given.continues } : {}),
        hospitalized: given.hospitalized,
        ...(given.place ? { place: given.place } : {}),
        ...(given.diagnosis
          ? { diagnosisSealed: this.sealer.seal(companyId, given.diagnosis) }
          : {}),
        ...(given.careCnp ? { careCnpSealed: this.sealer.seal(companyId, given.careCnp) } : {}),
        ...(given.urgencyCode ? { urgencyCode: given.urgencyCode } : {}),
        ...(given.infectiousCode ? { infectiousCode: given.infectiousCode } : {}),
        ...(accident ? { accidentConfirmed: true } : {}),
        days: result.days,
        unpaidDays: result.unpaidDays,
        employerDays: result.employerDays,
        fundDays: result.fundDays,
        dailyAverage: String(result.dailyAverage),
        percent: result.percent,
        employer: String(result.employer),
        fund: String(result.fund),
        episode: { ...episode, base: { income: String(base.income), days: base.days } },
      });
    }
    return { issues, items, record, suspendedDays };
  }

  /** The base of a work accident's episode starting in `month` (Legea nr. 346/2002 art. 19 alin.
   * (1)–(2)): the gross salary income at this employer in the posted runs of the six months
   * before, uncapped, and how many of them there are. */
  private async accidentHistory(
    tx: Transaction,
    companyId: string,
    contractId: string,
    month: string,
  ) {
    let income = 0n;
    let months = 0;
    for (let back = 1; back <= 6; back += 1) {
      const runId = await postedRun(tx, companyId, previousMonth(month, back));
      if (!runId) continue;
      const [line] = await tx
        .select({ result: payrollLines.result })
        .from(payrollLines)
        .where(
          and(
            eq(payrollLines.companyId, companyId),
            eq(payrollLines.runId, runId),
            eq(payrollLines.contractId, contractId),
          ),
        );
      if (!line) continue;
      const steps =
        (JSON.parse(line.result) as { steps?: { code: string; amount: string }[] }).steps ?? [];
      const gross = steps.find((step) => step.code === 'gross');
      if (!gross) continue;
      income += BigInt(gross.amount);
      months += 1;
    }
    return { income, months };
  }

  /** The base of an episode starting in `month`: the six most recent of the twelve previous
   * months in the posted runs, each month's CAM base capped at 12 minimum wages, and its active
   * days. */
  private async sickHistory(
    tx: Transaction,
    companyId: string,
    contractId: string,
    month: string,
    rules: RuleContext,
  ) {
    let income = 0n;
    let days = 0;
    const months: string[] = [];
    for (let back = 1; back <= 12 && months.length < 6; back += 1) {
      const previous = previousMonth(month, back);
      const runId = await postedRun(tx, companyId, previous);
      if (!runId) continue;
      const [line] = await tx
        .select({ input: payrollLines.input, result: payrollLines.result })
        .from(payrollLines)
        .where(
          and(
            eq(payrollLines.companyId, companyId),
            eq(payrollLines.runId, runId),
            eq(payrollLines.contractId, contractId),
          ),
        );
      if (!line) continue;
      const stored = JSON.parse(line.input) as { activeDays: number; month: string };
      const steps =
        (JSON.parse(line.result) as { steps?: { code: string; amount: string }[] }).steps ?? [];
      const camBase = BigInt(steps.find((step) => step.code === 'cam.base')?.amount ?? '0');
      const cap = rules.param<string>(
        'ro.sick.base_cap',
        'medical_certificate_issue_date',
        `${month}-01` as LocalDate,
      );
      const minimumWage =
        BigInt(
          rules.param<string>(
            'ro.payroll.minimum_wage',
            'payroll_month_start',
            monthStart(previous as Month),
          ),
        ) * 100n;
      income += cappedIncome(camBase, minimumWage, cap);
      days += stored.activeDays;
      months.push(previous);
    }
    return { income, days, months };
  }

  /** A contract's pay in money (salary and leave, without bonuses) and active days over the
   * three months before `month`, from their posted runs. */
  private async leaveHistory(
    tx: Transaction,
    companyId: string,
    contractId: string,
    month: string,
  ) {
    let amount = 0n;
    let days = 0;
    const months: string[] = [];
    for (const back of [1, 2, 3]) {
      const previous = previousMonth(month, back);
      const runId = await postedRun(tx, companyId, previous);
      if (!runId) continue;
      const [line] = await tx
        .select({ input: payrollLines.input, issues: payrollLines.issues })
        .from(payrollLines)
        .where(
          and(
            eq(payrollLines.companyId, companyId),
            eq(payrollLines.runId, runId),
            eq(payrollLines.contractId, contractId),
          ),
        );
      if (!line || line.issues) continue;
      const stored = JSON.parse(line.input) as {
        activeDays: number;
        items: { kind: string; amount: string }[];
      };
      amount += stored.items
        .filter((item) => item.kind === 'salary' || item.kind === 'leave')
        .reduce((total, item) => total + BigInt(item.amount), 0n);
      days += stored.activeDays;
      months.push(previous);
    }
    return { amount, days, months: months.join(',') };
  }

  /** A month's benefits valued (Codul fiscal art. 76): each with its document, the health
   * insurance against the year's 400 euro at the BNR rate of the month's last day. */
  /** The holiday vouchers a contract received earlier in the fiscal year, within the ceiling of
   * Legea nr. 165/2018 art. 24 alin. (3), from the posted runs. */
  private async holidayVouchersEarlier(
    tx: Transaction,
    companyId: string,
    contractId: string,
    month: string,
  ) {
    let total = 0n;
    for (let m = 1; m < Number(month.slice(5, 7)); m += 1) {
      const runId = await postedRun(
        tx,
        companyId,
        `${month.slice(0, 4)}-${String(m).padStart(2, '0')}`,
      );
      if (!runId) continue;
      const [line] = await tx
        .select({ input: payrollLines.input })
        .from(payrollLines)
        .where(
          and(
            eq(payrollLines.companyId, companyId),
            eq(payrollLines.runId, runId),
            eq(payrollLines.contractId, contractId),
          ),
        );
      const stored = line
        ? (JSON.parse(line.input) as { items?: { kind: string; amount: string }[] | null })
        : {};
      for (const item of stored.items ?? [])
        if (item.kind === 'holiday_vouchers') total += BigInt(item.amount);
    }
    return total;
  }

  private async benefits(
    tx: Transaction,
    companyId: string,
    contractId: string,
    month: string,
    given: readonly z.infer<typeof benefitEntry>[],
    context: { baseSalary: bigint; micro: boolean | null },
    rules: RuleContext,
  ) {
    for (const benefit of given) {
      const [file] = await tx
        .select({ id: evidence.id })
        .from(evidence)
        .where(and(eq(evidence.companyId, companyId), eq(evidence.id, benefit.evidenceId)));
      requireCondition(
        file,
        'EVIDENCE',
        `Documentul avantajului „${benefit.label}” nu este disponibil.`,
        404,
      );
    }
    const end = monthEnd(month as Month);
    let eurRate: string | null = null;
    if (given.some((benefit) => benefit.kind === 'insurance' && benefit.health)) {
      const [rate] = await tx
        .select({ rate: fxRates.rate, date: fxRates.rateDate, multiplier: fxRates.multiplier })
        .from(fxRates)
        .where(
          and(eq(fxRates.source, 'BNR'), eq(fxRates.currency, 'EUR'), lte(fxRates.rateDate, end)),
        )
        .orderBy(desc(fxRates.rateDate), desc(fxRates.revision))
        .limit(1);
      // A rate more than 7 days old counts as missing, as everywhere in the engine.
      if (rate && rate.multiplier === 1 && addDays(rate.date as LocalDate, 7) >= end)
        eurRate = rate.rate;
    }
    // The health insurance left out of income earlier this year, from the posted runs.
    let yearToDate = 0n;
    for (let m = 1; m < Number(month.slice(5, 7)); m += 1) {
      const runId = await postedRun(
        tx,
        companyId,
        `${month.slice(0, 4)}-${String(m).padStart(2, '0')}`,
      );
      if (!runId) continue;
      const [line] = await tx
        .select({ input: payrollLines.input })
        .from(payrollLines)
        .where(
          and(
            eq(payrollLines.companyId, companyId),
            eq(payrollLines.runId, runId),
            eq(payrollLines.contractId, contractId),
          ),
        );
      const stored = line ? (JSON.parse(line.input) as { benefits?: StoredBenefit[] }) : {};
      for (const item of stored.benefits ?? []) yearToDate += BigInt(item.exemptCents);
    }
    const minimumWage =
      BigInt(
        rules.param<string>(
          'ro.payroll.minimum_wage',
          'payroll_month_start',
          monthStart(month as Month),
        ),
      ) * 100n;
    const inputs: BenefitInput[] = given.map((benefit) => {
      const lei = (value: string) => parseMoney(value, 'RON');
      switch (benefit.kind) {
        case 'car':
          return {
            kind: 'car',
            label: benefit.label,
            inputValue: benefit.inputValue === undefined ? null : lei(benefit.inputValue),
            rent: benefit.rent === undefined ? null : lei(benefit.rent),
            km: benefit.km ?? null,
            passenger: benefit.passenger,
            exclusiveBusiness: benefit.exclusiveBusiness,
          };
        case 'housing':
          return { ...benefit, value: lei(benefit.value) };
        case 'gift':
          return {
            ...benefit,
            persons: benefit.persons.map((person) => ({ ...person, value: lei(person.value) })),
          };
        case 'insurance':
          return {
            kind: 'insurance',
            label: benefit.label,
            premium: lei(benefit.premium),
            health: benefit.health,
            eurRate,
            yearToDateCents: yearToDate,
          };
        default:
          return { ...benefit, value: lei(benefit.value) };
      }
    });
    try {
      return evaluateBenefits(
        month as Month,
        inputs,
        { baseSalary: context.baseSalary, minimumWage, micro: context.micro },
        rules,
      );
    } catch (error) {
      if (!(error instanceof RuleGapError)) throw error;
      return { results: [], issues: [{ code: 'RULE_GAP', message: error.message }] };
    }
  }

  /** The net pay of a full-time contract at the minimum wage, at the main job, without dependents:
   * the net minimum wage below which the Codul de procedură civilă (art. 729 alin. (3)) protects
   * a salary from garnishment (a reading of `ro.garnishment.limits`). */
  private minimumNet(month: string, monthDays: number, rules: RuleContext) {
    try {
      const minimumWage =
        BigInt(
          rules.param<string>(
            'ro.payroll.minimum_wage',
            'payroll_month_start',
            monthStart(month as Month),
          ),
        ) * 100n;
      const { result } = calculatePay(
        {
          month: month as Month,
          baseSalary: minimumWage,
          dailyHours: 8,
          mainJob: true,
          workingDays: monthDays,
          activeDays: monthDays,
          items: [{ kind: 'salary', amount: minimumWage, label: 'Salariu minim' }],
          dependents: 0,
          under26: false,
          childrenInSchool: 0,
          unionDues: 0n,
          minimumExemption: null,
        },
        rules,
      );
      return result?.net ?? null;
    } catch (error) {
      if (!(error instanceof RuleGapError)) throw error;
      return null;
    }
  }

  /** A contract's garnishment orders in force at `end`, with the debt still owed after what the
   * posted runs withheld. */
  private async ordersOf(tx: Transaction, companyId: string, contractId: string, end: string) {
    const rows = await tx
      .select({ order: garnishments, released: garnishmentReleases.releasedOn })
      .from(garnishments)
      .leftJoin(
        garnishmentReleases,
        and(
          eq(garnishmentReleases.companyId, garnishments.companyId),
          eq(garnishmentReleases.garnishmentId, garnishments.id),
        ),
      )
      .where(and(eq(garnishments.companyId, companyId), eq(garnishments.contractId, contractId)));
    const inForce = rows.filter(
      (row) => row.order.receivedOn <= end && (!row.released || row.released > end),
    );
    if (!inForce.length) return [];
    const withheld = await this.garnished(tx, companyId, contractId);
    return inForce.map(({ order }) => ({
      partyId: order.partyId,
      order: {
        id: order.id,
        kind: order.kind,
        receivedOn: order.receivedOn,
        monthly:
          order.monthlyBani !== null
            ? { amount: order.monthlyBani }
            : { share: [order.shareNumerator!, order.shareDenominator!] as [number, number] },
        remaining: order.totalBani - (withheld.get(order.id) ?? 0n),
      } satisfies GarnishmentOrder,
    }));
  }

  /** What the posted runs withheld for each order of a contract. */
  private async garnished(tx: Transaction, companyId: string, contractId: string) {
    const rows = await tx
      .select({ result: payrollLines.result, month: payrollRuns.month, id: payrollRuns.id })
      .from(payrollLines)
      .innerJoin(
        payrollRuns,
        and(
          eq(payrollRuns.companyId, payrollLines.companyId),
          eq(payrollRuns.id, payrollLines.runId),
        ),
      )
      .where(and(eq(payrollLines.companyId, companyId), eq(payrollLines.contractId, contractId)));
    const months = new Map<string, string | undefined>();
    const totals = new Map<string, bigint>();
    for (const row of rows) {
      if (!months.has(row.month)) months.set(row.month, await postedRun(tx, companyId, row.month));
      if (months.get(row.month) !== row.id) continue;
      const result = JSON.parse(row.result) as {
        garnishments?: { orderId: string; amount: string }[];
      };
      for (const item of result.garnishments ?? [])
        totals.set(item.orderId, (totals.get(item.orderId) ?? 0n) + BigInt(item.amount));
    }
    return totals;
  }

  /** A garnishment order the employer received, with its document. */
  recordGarnishment(actor: Actor, key: string, input: z.infer<typeof garnishmentInput>) {
    return this.commands.run(
      actor,
      key,
      'payroll.garnishments.record',
      input,
      'write',
      async (tx) => {
        const [terms] = await tx
          .select({ contractId: employmentTerms.contractId })
          .from(employmentTerms)
          .where(
            and(
              eq(employmentTerms.companyId, actor.companyId),
              eq(employmentTerms.contractId, input.contractId),
            ),
          )
          .limit(1);
        requireCondition(terms, 'CONTRACT', 'Contractul nu există.', 404);
        const [party] = await tx
          .select({ id: parties.id })
          .from(parties)
          .where(and(eq(parties.companyId, actor.companyId), eq(parties.id, input.partyId)));
        requireCondition(party, 'PARTY', 'Creditorul nu este un partener al companiei.', 404);
        const [file] = await tx
          .select({ id: evidence.id })
          .from(evidence)
          .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, input.evidenceId)));
        requireCondition(
          file,
          'EVIDENCE',
          'Adresa de înființare a popririi nu este disponibilă.',
          404,
        );
        requireCondition(
          (input.monthly === undefined) !== (input.share === undefined) &&
            (!input.share || input.share[0] <= input.share[1]),
          'GARNISHMENT_MONTHLY',
          'Adresa popririi spune fie suma de reținut lunar, fie partea din venitul net.',
        );
        const id = this.commands.ids();
        await tx.insert(garnishments).values({
          id,
          companyId: actor.companyId,
          contractId: input.contractId,
          partyId: input.partyId,
          kind: input.kind,
          reference: input.reference,
          receivedOn: input.receivedOn,
          totalBani: parseMoney(input.total, 'RON'),
          monthlyBani: input.monthly === undefined ? null : parseMoney(input.monthly, 'RON'),
          shareNumerator: input.share?.[0] ?? null,
          shareDenominator: input.share?.[1] ?? null,
          evidenceId: input.evidenceId,
          createdBy: actor.actorId,
        });
        return { id };
      },
    );
  }

  /** A garnishment lifted from a date (ridicarea popririi). */
  releaseGarnishment(actor: Actor, key: string, input: z.infer<typeof garnishmentReleaseInput>) {
    return this.commands.run(
      actor,
      key,
      'payroll.garnishments.release',
      input,
      'write',
      async (tx) => {
        const [order] = await tx
          .select({ id: garnishments.id })
          .from(garnishments)
          .where(
            and(
              eq(garnishments.companyId, actor.companyId),
              eq(garnishments.id, input.garnishmentId),
            ),
          );
        requireCondition(order, 'NOT_FOUND', 'Poprirea nu există.', 404);
        await tx.insert(garnishmentReleases).values({
          companyId: actor.companyId,
          garnishmentId: input.garnishmentId,
          releasedOn: input.releasedOn,
          evidenceId: input.evidenceId,
          createdBy: actor.actorId,
        });
        return { garnishmentId: input.garnishmentId };
      },
    );
  }

  listGarnishments(actor: Actor) {
    return this.commands.db.read(async (tx) => {
      const rows = await tx
        .select({ order: garnishments, released: garnishmentReleases.releasedOn })
        .from(garnishments)
        .leftJoin(
          garnishmentReleases,
          and(
            eq(garnishmentReleases.companyId, garnishments.companyId),
            eq(garnishmentReleases.garnishmentId, garnishments.id),
          ),
        )
        .where(eq(garnishments.companyId, actor.companyId))
        .orderBy(asc(garnishments.receivedOn), asc(garnishments.id));
      const withheld = new Map<string, Map<string, bigint>>();
      const items = [];
      for (const { order, released } of rows) {
        if (!withheld.has(order.contractId))
          withheld.set(
            order.contractId,
            await this.garnished(tx, actor.companyId, order.contractId),
          );
        const taken = withheld.get(order.contractId)!.get(order.id) ?? 0n;
        items.push({
          id: order.id,
          contractId: order.contractId,
          partyId: order.partyId,
          kind: order.kind,
          reference: order.reference,
          receivedOn: order.receivedOn,
          total: lei(order.totalBani),
          monthly: order.monthlyBani === null ? null : lei(order.monthlyBani),
          share:
            order.shareNumerator === null ? null : [order.shareNumerator, order.shareDenominator],
          withheld: lei(taken),
          remaining: lei(order.totalBani - taken),
          releasedOn: released ?? null,
        });
      }
      return items;
    });
  }

  /** A transmission to REGES-ONLINE a person made, with its receipt. */
  recordReges(actor: Actor, key: string, input: z.infer<typeof regesInput>) {
    return this.commands.run(actor, key, 'payroll.reges.record', input, 'write', async (tx) => {
      const [terms] = await tx
        .select()
        .from(employmentTerms)
        .where(
          and(
            eq(employmentTerms.companyId, actor.companyId),
            eq(employmentTerms.contractId, input.contractId),
            eq(employmentTerms.seq, input.termsSeq),
          ),
        );
      requireCondition(terms, 'CONTRACT', 'Versiunea contractului nu există.', 404);
      requireCondition(
        terms.kind === 'employment',
        'REGES_MANDATE',
        'În REGES-ONLINE se înregistrează contractele individuale de muncă, nu contractele de mandat.',
      );
      const [file] = await tx
        .select({ id: evidence.id })
        .from(evidence)
        .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, input.evidenceId)));
      requireCondition(file, 'EVIDENCE', 'Recipisa REGES-ONLINE nu este disponibilă.', 404);
      await tx.insert(regesRecords).values({
        companyId: actor.companyId,
        contractId: input.contractId,
        termsSeq: input.termsSeq,
        event: input.event,
        transmittedOn: input.transmittedOn,
        evidenceId: input.evidenceId,
        createdBy: actor.actorId,
      });
      return { contractId: input.contractId, termsSeq: input.termsSeq, event: input.event };
    });
  }

  /**
   * What REGES-ONLINE needs from the employer, contract by contract (an external obligation: the
   * engine records the transmissions, never submits them): the contract by the day before its
   * start (Codul muncii art. 16 alin. (2), HG nr. 295/2025 art. 5 alin. (1) lit. a)); each change
   * of its terms by the day before it takes effect, or within 20 working days for the salary
   * (art. 5 alin. (3)–(4)); its end at the latest on its date (art. 5 alin. (1) lit. f)); a
   * corrected start date has no deadline and blocks (`regesDeadline`). Mandates are not
   * registered.
   */
  listReges(actor: Actor) {
    return this.commands.db.read(async (tx) =>
      this.regesDue(tx, actor.companyId, bucharestDate(this.commands.clock())),
    );
  }

  /** The REGES-ONLINE events of the contracts, those since the register replaced Revisal (the
   * `since` of `ro.deadline.reges.start` on `today`; earlier events were Revisal's). Past the
   * rules' review horizon (a new year before its rollover), `since` is read in the latest month
   * the register reviews: the day the register started is past, and a contract begun before it
   * stays Revisal's whatever the new year's rules say. */
  async regesDue(tx: Transaction, companyId: string, today: LocalDate) {
    const rules = await this.rules(tx, companyId);
    let since: string | null = null;
    for (let back = 0; back <= 24 && since === null; back++)
      try {
        since = rules.param<{ since: string }>(
          'ro.deadline.reges.start',
          'payroll_month_start',
          monthStart(addMonths(today.slice(0, 7) as Month, -back)),
        ).since;
      } catch (error) {
        if (!(error instanceof RuleGapError)) throw error;
        if (error.gap.reason !== 'BEYOND_HORIZON') break;
      }
    const rows = await tx
      .select()
      .from(employmentTerms)
      .where(and(eq(employmentTerms.companyId, companyId), eq(employmentTerms.kind, 'employment')))
      .orderBy(asc(employmentTerms.contractId), asc(employmentTerms.seq));
    const recorded = await tx
      .select()
      .from(regesRecords)
      .where(eq(regesRecords.companyId, companyId));
    const done = (contractId: string, seq: number, event: string) =>
      recorded.find(
        (row) => row.contractId === contractId && row.termsSeq === seq && row.event === event,
      ) ?? null;
    const items = [];
    for (const row of rows) {
      const previous = rows.find(
        (other) => other.contractId === row.contractId && other.seq === row.seq - 1,
      );
      const events: ('start' | 'change' | 'end')[] = [];
      const changed: RegesField[] = [];
      if (previous) {
        if (previous.baseSalaryBani !== row.baseSalaryBani) changed.push('salary');
        if (previous.dailyHours !== row.dailyHours) changed.push('hours');
        if (previous.occupation !== row.occupation) changed.push('occupation');
        // An end date given to an open-ended contract is its end, not a change of its duration.
        if (previous.endDate !== row.endDate && previous.endDate !== null) changed.push('end_date');
        if (previous.startDate !== row.startDate) changed.push('start_date');
      }
      if (row.seq === 1) events.push('start');
      else if (changed.length) events.push('change');
      if (row.endDate && (!previous || previous.endDate !== row.endDate)) events.push('end');
      for (const event of events) {
        const effective =
          event === 'end' ? row.endDate! : event === 'start' ? row.startDate : row.effectiveFrom;
        if (since && effective < since) continue;
        let deadline: string | null = null;
        let blocked: string | null = null;
        let rule = `ro.deadline.reges.${event}`;
        try {
          ({ deadline, blocked, rule } = regesDeadline(
            event,
            effective as LocalDate,
            changed,
            rules,
          ));
        } catch (error) {
          if (!(error instanceof RuleGapError)) throw error;
          blocked = error.message;
        }
        const record = done(row.contractId, row.seq, event);
        items.push({
          contractId: row.contractId,
          termsSeq: row.seq,
          event,
          effective,
          deadline,
          blocked,
          rule,
          transmittedOn: record?.transmittedOn ?? null,
          evidenceId: record?.evidenceId ?? null,
          late: Boolean(record && deadline && record.transmittedOn > deadline),
        });
      }
    }
    return items;
  }

  /**
   * The worklist's payroll items (`payroll.due`): each REGES-ONLINE transmission not recorded,
   * blocking once its deadline passed or when the deadline is not sourced; and each month
   * corrected after its D112 was filed, whose rectifying D112 is still to prepare.
   */
  async work(tx: Transaction, companyId: string, today: LocalDate): Promise<YearEndWorkItem[]> {
    const items: YearEndWorkItem[] = [];
    const events = { start: 'începerea', change: 'modificarea', end: 'încetarea' } as const;
    for (const due of await this.regesDue(tx, companyId, today)) {
      if (due.transmittedOn) continue;
      const late = due.deadline !== null && today > due.deadline;
      const blockedText = due.blocked ? cleanIdentifierText(due.blocked) : null;
      items.push({
        subject: { kind: 'contract', id: `${due.contractId}:${due.termsSeq}:${due.event}` },
        severity: late || due.blocked ? 'block' : 'warn',
        period: due.effective.slice(0, 7),
        message: due.deadline
          ? `REGES-ONLINE: ${events[due.event]} contractului din ${due.effective} se transmite până la ${due.deadline}${late ? ' (termen depășit)' : ''}; înregistrați recipisa.`
          : `REGES-ONLINE: ${events[due.event]} contractului din ${due.effective} se transmite în registru; ${blockedText}`,
        ...(blockedText ? { causes: [causeFromRule(due.rule, 'RULE_GAP', blockedText)] } : {}),
        details: {
          contractId: due.contractId,
          termsSeq: due.termsSeq,
          event: due.event,
          deadline: due.deadline,
          rules: [due.rule],
        },
        labels: {
          contractId: idLabel('Contract', 'contract'),
          termsSeq: countLabel('Versiune contract'),
          event: textLabel('Eveniment'),
          deadline: dateLabel('Termen'),
          rules: textLabel('Reguli'),
        },
        next: [
          {
            operation: 'payroll.reges.record',
            by: 'human',
            inputHint: { contractId: due.contractId, termsSeq: due.termsSeq, event: due.event },
          },
        ],
      });
    }
    // A month corrected after its D112 was filed: the filed return declares an earlier run.
    const rows = await tx
      .select({
        id: artifacts.id,
        period: artifacts.period,
        state: artifactEvents.state,
        detail: artifactEvents.detail,
      })
      .from(artifacts)
      .innerJoin(
        artifactEvents,
        and(
          eq(artifactEvents.companyId, artifacts.companyId),
          eq(artifactEvents.artifactId, artifacts.id),
        ),
      )
      .where(and(eq(artifacts.companyId, companyId), eq(artifacts.kind, 'D112')))
      .orderBy(asc(artifactEvents.seq));
    const returns = new Map<string, { period: string; runId: string | null; filed: boolean }>();
    for (const row of rows) {
      const item = returns.get(row.id) ?? { period: row.period, runId: null, filed: false };
      if (row.state === 'prepared' && row.detail)
        item.runId = (JSON.parse(row.detail) as { runId?: string }).runId ?? null;
      if (row.state === 'submitted' || row.state === 'accepted') item.filed = true;
      returns.set(row.id, item);
    }
    const months = [
      ...new Set([...returns.values()].filter((item) => item.filed).map((item) => item.period)),
    ];
    for (const month of months.sort()) {
      const current = await postedRun(tx, companyId, month);
      const declared = [...returns.values()].filter((item) => item.period === month);
      if (!current || declared.some((item) => item.runId === current)) continue;
      items.push({
        subject: { kind: 'declaration', id: `D112:${month}` },
        severity: 'block',
        period: month,
        message: `Statul de plată pentru ${month} a fost corectat după depunerea D112: depuneți D112 rectificativă pentru lună (OPANAF nr. 605/2026 anexa nr. 6 cap. II pct. 2).`,
        details: { month, runId: current, rules: ['ro.payroll.correction.retroactive'] },
        labels: {
          month: periodLabel('Lună'),
          runId: idLabel('Stat de plată', 'payrollRun'),
          rules: textLabel('Reguli'),
        },
        next: [
          {
            operation: 'declarations.prepare',
            by: 'agent',
            inputHint: { kind: 'D112', period: month, options: { rectifying: true } },
          },
        ],
      });
    }
    return items;
  }

  getRun(actor: Actor, runId: string) {
    return this.commands.read(actor, 'payroll.runs.get', async (tx, access) =>
      this.shown(tx, actor, access.role, await this.view(tx, actor.companyId, runId)),
    );
  }

  listRuns(actor: Actor) {
    return this.commands.read(actor, 'payroll.runs.list', async (tx, access) => {
      const rows = await tx
        .select({ id: payrollRuns.id })
        .from(payrollRuns)
        .where(eq(payrollRuns.companyId, actor.companyId))
        .orderBy(desc(payrollRuns.month), desc(payrollRuns.createdAt));
      return Promise.all(
        rows.map(async (row) =>
          this.shown(tx, actor, access.role, await this.view(tx, actor.companyId, row.id)),
        ),
      );
    });
  }

  /** A run as this caller reads it: its medical certificates' issues, kept sealed, opened for a
   * reader of health data; another (a viewer) sees each as `healthIssue`, without the
   * certificate and its code. */
  private async shown(
    tx: Transaction,
    actor: Actor,
    role: Role,
    run: Awaited<ReturnType<Payroll['view']>>,
  ) {
    if ((await this.commands.disclosable(tx, actor, role))(healthClasses))
      return {
        ...run,
        lines: run.lines.map((line) => ({
          ...line,
          issues: openIssues(this.sealer, actor.companyId, line.issues),
        })),
      };
    return {
      ...run,
      lines: run.lines.map((line) => ({
        ...line,
        issues: issuesWithoutHealth(line.issues as PayIssue[]),
      })),
    };
  }

  private async runsOf(tx: Transaction, companyId: string, runMonth: string) {
    const runs = await tx
      .select({ id: payrollRuns.id, round: payrollRuns.round })
      .from(payrollRuns)
      .where(and(eq(payrollRuns.companyId, companyId), eq(payrollRuns.month, runMonth)));
    return Promise.all(
      runs.map(async (run) => {
        const [last] = await tx
          .select()
          .from(payrollRunEvents)
          .where(and(eq(payrollRunEvents.companyId, companyId), eq(payrollRunEvents.runId, run.id)))
          .orderBy(desc(payrollRunEvents.seq))
          .limit(1);
        return { id: run.id, round: run.round, state: last!.state, seq: last!.seq };
      }),
    );
  }

  private async view(tx: Transaction, companyId: string, runId: string) {
    const [run] = await tx
      .select()
      .from(payrollRuns)
      .where(and(eq(payrollRuns.companyId, companyId), eq(payrollRuns.id, runId)));
    requireCondition(run, 'NOT_FOUND', 'Statul de plată nu există.', 404);
    const [last] = await tx
      .select()
      .from(payrollRunEvents)
      .where(and(eq(payrollRunEvents.companyId, companyId), eq(payrollRunEvents.runId, runId)))
      .orderBy(desc(payrollRunEvents.seq))
      .limit(1);
    const rows = await tx
      .select({ line: payrollLines, name: parties.name })
      .from(payrollLines)
      .innerJoin(
        parties,
        and(eq(parties.companyId, payrollLines.companyId), eq(parties.id, payrollLines.partyId)),
      )
      .where(and(eq(payrollLines.companyId, companyId), eq(payrollLines.runId, runId)))
      .orderBy(asc(parties.name), asc(payrollLines.contractId));
    return {
      id: run.id,
      month: run.month,
      round: run.round,
      corrects: run.corrects ?? null,
      correctionReason: run.correctionReason ?? null,
      workingDays: run.workingDays,
      state: last!.state,
      issues: run.issues,
      lines: rows.map(({ line, name }) => {
        const result = JSON.parse(line.result) as {
          issues?: ((PayIssue & { health?: true }) | Sealed<{ health: true }>)[];
          steps?: { code: string; amount: string }[];
          garnishments?: { orderId: string; partyId: string; amount: string }[];
        };
        return {
          contractId: line.contractId,
          employeeId: line.employeeId,
          partyId: line.partyId,
          name,
          cash: lei(line.cash),
          vouchers: lei(line.vouchers),
          cas: lei(line.cas),
          cass: lei(line.cass),
          casEmployer: lei(line.casEmployer),
          cassEmployer: lei(line.cassEmployer),
          tax: lei(line.tax),
          unionDues: lei(line.unionDues),
          net: lei(line.net),
          cam: lei(line.cam),
          inKind: lei(
            BigInt(result.steps?.find((step) => step.code === 'benefits')?.amount ?? '0'),
          ),
          garnished: (result.garnishments ?? []).map((item) => ({
            orderId: item.orderId,
            partyId: item.partyId,
            amount: lei(BigInt(item.amount)),
          })),
          issues: result.issues ?? [],
        };
      }),
    };
  }
}

function termsView(row: Terms) {
  return {
    seq: row.seq,
    employeeId: row.employeeId,
    number: row.number,
    startDate: row.startDate,
    endDate: row.endDate,
    effectiveFrom: row.effectiveFrom,
    baseSalary: lei(row.baseSalaryBani),
    dailyHours: row.dailyHours,
    mainJob: row.mainJob,
    occupation: row.occupation,
    dependents: row.dependents,
    childrenInSchool: row.childrenInSchool,
    unionDues: lei(row.unionDuesBani),
    minimumExemption: row.minimumExemption,
  };
}
