import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { canonical, hashOf } from 'xfactura-core/hash';
import { formatMoney, parseMoney } from 'xfactura-core/money';
import { isValidCnp } from 'xfactura-core/ro/identifiers';
import {
  calculatePay,
  minimumExemptions,
  payItemKinds,
  type PayInput,
  type PayIssue,
  type PayResult,
} from 'xfactura-core/ro/payroll';
import type { RuleContext } from 'xfactura-core/rules';
import { monthEnd, monthStart, type Month } from 'xfactura-core/time';
import { sha256 } from '../adapters/object-store';
import type { Transaction } from '../db/database';
import {
  employees,
  employmentTerms,
  entries,
  evidence,
  parties,
  payrollLines,
  payrollRunEvents,
  payrollRuns,
  proposals,
} from '../db/schema';
import { appendAudit, type Actor, type Commands } from '../kernel/commands';

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
    /** Working days in the month by the company's calendar: weekdays less public holidays. */
    workingDays: z.number().int().min(1).max(23),
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

  constructor(secret: string) {
    this.key = Buffer.from(hkdfSync('sha256', secret, 'xfactura', 'payroll personal data v1', 32));
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

/** The birth date a CNP encodes, or null when its first digit does not give the century. */
export function birthDateOf(cnp: string): string | null {
  const century = { '1': '19', '2': '19', '3': '18', '4': '18', '5': '20', '6': '20' }[cnp[0]!];
  return century ? `${century}${cnp.slice(1, 3)}-${cnp.slice(3, 5)}-${cnp.slice(5, 7)}` : null;
}

type Terms = typeof employmentTerms.$inferSelect;
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
      const partyId = existing?.id ?? randomUUID();
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
      const id = randomUUID();
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
      const contractId = input.contractId ?? randomUUID();
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
        const activeDays = entry?.activeDays ?? (full ? input.workingDays : undefined);
        if (activeDays === undefined)
          issues.push({
            code: 'PARTIAL_MONTH',
            message: 'Contractul începe sau se încheie în lună: completați zilele active.',
          });
        else if (activeDays > input.workingDays)
          issues.push({ code: 'DAYS', message: 'Zilele active depășesc zilele lucrătoare.' });
        const items =
          entry?.items?.map((item) => ({
            kind: item.kind,
            amount: parseMoney(item.amount, 'RON'),
            label: item.label,
          })) ??
          (full && !changed && activeDays === input.workingDays
            ? [{ kind: 'salary' as const, amount: terms.baseSalaryBani, label: 'Salariu de bază' }]
            : undefined);
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
            workingDays: input.workingDays,
            activeDays: activeDays!,
            items: items!,
            dependents: terms.dependents,
            under26: under26!,
            childrenInSchool: terms.childrenInSchool,
            unionDues: terms.unionDuesBani,
            minimumExemption: (terms.minimumExemption as PayInput['minimumExemption']) ?? null,
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
          input: canonical(payInput ?? { activeDays: activeDays ?? null, items: items ?? null }),
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

      const id = randomUUID();
      const resultHash = hashOf(lines.map(({ companyId: _company, runId: _run, ...line }) => line));
      const issueCount = lines.filter((line) => line.issues).length;
      await tx.insert(payrollRuns).values({
        id,
        companyId: actor.companyId,
        month: input.month,
        round,
        workingDays: input.workingDays,
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
