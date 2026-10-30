import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { canonical, hashOf } from 'xfactura-core/hash';
import { formatMoney, parseMoney } from 'xfactura-core/money';
import { workingDays } from 'xfactura-core/ro/calendar';
import { isValidCnp } from 'xfactura-core/ro/identifiers';
import {
  calculatePay,
  minimumExemptions,
  payItemKinds,
  type MinimumWageRelief,
  type PayInput,
  type PayIssue,
  type PayResult,
} from 'xfactura-core/ro/payroll';
import { d112PrescriptionPlaces } from 'xfactura-core/ro/declarations/d112';
import {
  cappedIncome,
  sickIndemnity,
  type SickBase,
  type SickCertificate,
  type SickEpisode,
} from 'xfactura-core/ro/payroll/sick-leave';
import { RuleGapError, type RuleContext } from 'xfactura-core/rules';
import { addDays, monthEnd, monthStart, type LocalDate, type Month } from 'xfactura-core/time';
import { sha256 } from '../adapters/object-store';
import type { Transaction } from '../db/database';
import {
  employees,
  employmentTerms,
  entries,
  evidence,
  parties,
  partyCnps,
  payrollLines,
  payrollRunEvents,
  payrollRuns,
  proposals,
  proposalVersions,
} from '../db/schema';
import { appendAudit, type Actor, type Commands } from '../kernel/commands';
import { entryStands } from '../kernel/ledger';

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
  })
  .strict();

export const runInput = z
  .object({
    month,
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
                  })
                  .strict(),
              )
              .max(10)
              .optional(),
            /** The base of an episode starting this month when the payroll does not hold six of
             * the previous twelve months: from the employee's stage certificate (adeverința de
             * stagiu), the insured incomes, each month capped, and the insured working days. */
            sickBase: z
              .object({ income: money, days: z.number().int().min(1).max(140) })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(500)
      .default([]),
  })
  .strict();
export const runIdInput = z.object({ runId: z.uuid() }).strict();

/**
 * Personal data at rest: AES-256-GCM under a key derived from the server's secret, bound to
 * the company. Only a declaration that must carry the CNP opens it.
 */
export class Sealer {
  private readonly key: Buffer;

  constructor(secret: string, purpose = 'payroll personal data v1') {
    this.key = Buffer.from(hkdfSync('sha256', secret, 'xfactura', purpose, 32));
  }

  seal(companyId: string, text: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv).setAAD(Buffer.from(companyId));
    const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return ['v1', iv, body, cipher.getAuthTag()]
      .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
      .join('.');
  }

  open(companyId: string, sealed: string) {
    const [version, iv, body, tag] = sealed.split('.');
    requireCondition(version === 'v1' && iv && body && tag, 'SEALED', 'Date sigilate necunoscute.');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'))
      .setAAD(Buffer.from(companyId))
      .setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(body, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}

/** The month's posted payroll run: the one its posting read. */
export async function postedRun(tx: Transaction, companyId: string, month: string) {
  const [row] = await tx
    .select({ input: proposalVersions.input })
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
        eq(proposals.subjectKey, `payroll:${month}:1`),
        entryStands('"acc_entries"'),
      ),
    );
  return row ? (JSON.parse(row.input) as { runId: string }).runId : undefined;
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

export class Payroll {
  private readonly sealer: Sealer;

  constructor(
    private readonly commands: Commands,
    secret: string,
    private readonly rules: (tx: Transaction, companyId: string) => Promise<RuleContext>,
  ) {
    this.sealer = new Sealer(secret);
  }

  /** An employee, as a party (the same identity as a buyer who is this person) with the CNP
   * sealed. */
  recordEmployee(actor: Actor, key: string, input: z.infer<typeof employeeInput>) {
    return this.commands.run(actor, key, 'payroll.employees.record', input, 'write', async (tx) => {
      requireCondition(isValidCnp(input.cnp), 'CNP', 'CNP-ul nu este valid.');
      const birthDate = birthDateOf(input.cnp) ?? input.birthDate;
      requireCondition(
        birthDate,
        'BIRTH_DATE',
        'Pentru acest CNP, data nașterii se completează explicit.',
      );
      const taxId = `cnp:${sha256(new TextEncoder().encode(input.cnp))}`;
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
          !party.taxId || party.taxId === `cnp:${sha256(new TextEncoder().encode(input.cnp))}`,
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
      if (input.contractId) {
        requireCondition(last, 'CONTRACT', 'Contractul nu există.', 404);
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
    return this.commands.run(actor, key, 'payroll.runs.prepare', input, 'write', async (tx) => {
      const round = 1;
      const monthDays = input.workingDays ?? workingDays(input.month as Month);
      const [posted] = await tx
        .select({ id: entries.id })
        .from(entries)
        .innerJoin(
          proposals,
          and(eq(proposals.companyId, entries.companyId), eq(proposals.id, entries.proposalId)),
        )
        .where(
          and(
            eq(entries.companyId, actor.companyId),
            eq(proposals.subjectKey, `payroll:${input.month}:${round}`),
            entryStands('"acc_entries"'),
          ),
        );
      requireCondition(
        !posted,
        'RUN_POSTED',
        `Statul de plată pentru ${input.month} este înregistrat; corecțiile nu sunt încă suportate.`,
      );
      const start = monthStart(input.month as Month);
      const end = monthEnd(input.month as Month);
      const rules = await this.rules(tx, actor.companyId);
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
        const active =
          terms && terms.startDate <= end && (!terms.endDate || terms.endDate >= start);
        if (!active) {
          requireCondition(
            !entry,
            'ENTRY_INACTIVE',
            'O linie a statului se referă la un contract care nu este activ în lună.',
          );
          continue;
        }
        const issues: PayIssue[] = [];
        const full = terms.startDate <= start && (!terms.endDate || terms.endDate >= end);
        const changed = versions.some(
          (version) => version.effectiveFrom > start && version.effectiveFrom <= end,
        );
        // Sick leave suspends the contract on the certificates' working days.
        const sick = entry?.sickLeave?.length
          ? await this.sickPay(tx, actor.companyId, contractId, input.month, entry, rules)
          : null;
        if (sick) issues.push(...sick.issues);
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
            const averaged =
              history.days > 0 && history.amount * days > base * BigInt(history.days);
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
              clause: 'L53/2003:art.150',
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
        const items = ownItems && sick ? [...ownItems, ...sick.items] : ownItems;
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
            ...(sick ? { sick: sick.record } : {}),
          }),
          result: canonical(
            computed.result
              ? { steps: computed.result.steps, deduction: computed.result.deduction }
              : { issues: computed.issues },
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
        if (previous.id !== id && previous.state === 'prepared')
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
    });
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
      for (const item of stored.sick ?? [])
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
      let base = earlier?.base;
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
      if (earlier && tier(days) !== tier(length)) {
        issues.push({
          code: 'SICK_RECALCULATION',
          message: `Episodul certificatului ${given.series} ${given.number} ajunge la ${days} zile: procentul și recalcularea lunii anterioare (art. 17 alin. (1^2)) se stabilesc cu expertul contabil.`,
        });
        continue;
      }
      suspendedDays += result.days;
      const label = `Concediu medical ${given.series} ${given.number}, cod ${given.code}`;
      if (result.employer)
        items.push({
          kind: 'sick_employer',
          amount: result.employer,
          label: `${label} (angajator)`,
        });
      if (result.fund)
        items.push({ kind: 'sick_fund', amount: result.fund, label: `${label} (FNUASS)` });
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

  getRun(actor: Actor, runId: string) {
    return this.commands.db.read((tx) => this.view(tx, actor.companyId, runId));
  }

  listRuns(actor: Actor) {
    return this.commands.db.read(async (tx) => {
      const rows = await tx
        .select({ id: payrollRuns.id })
        .from(payrollRuns)
        .where(eq(payrollRuns.companyId, actor.companyId))
        .orderBy(desc(payrollRuns.month), desc(payrollRuns.createdAt));
      return Promise.all(rows.map((row) => this.view(tx, actor.companyId, row.id)));
    });
  }

  private async runsOf(tx: Transaction, companyId: string, runMonth: string) {
    const runs = await tx
      .select({ id: payrollRuns.id })
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
        return { id: run.id, state: last!.state, seq: last!.seq };
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
      workingDays: run.workingDays,
      state: last!.state,
      issues: run.issues,
      lines: rows.map(({ line, name }) => {
        const result = JSON.parse(line.result) as { issues?: PayIssue[] };
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
