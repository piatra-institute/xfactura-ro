import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import { Commands, type Actor } from './commands';
import type { Transaction } from './db';
import { accountCodeSchema, dateSchema, idSchema, requireCondition } from './domain';
import {
  accountingYears,
  accountingPolicies,
  ledgerAccounts,
  regimeEvents,
  evidence,
} from './schema';
import chart from './data/ro-chart.json';
import { accountingRules, obligationCatalogue } from './accounting-catalogue';

export const yearInput = z
  .object({
    kind: z.enum(['financial', 'fiscal']),
    label: z.string().trim().min(1).max(100),
    from: dateSchema,
    to: dateSchema,
  })
  .strict()
  .refine((value) => value.from <= value.to, 'Interval invalid.');
export const accountInput = z
  .object({
    code: accountCodeSchema,
    parentCode: accountCodeSchema,
    name: z.string().trim().min(2).max(300),
    validFrom: dateSchema,
  })
  .strict();
export const accountQuery = z
  .object({
    prefix: z
      .string()
      .regex(/^[1-9]\d{0,3}(?:\.[A-Z0-9_-]*)?$/)
      .optional(),
    limit: z.number().int().min(1).max(1000).default(100),
    cursor: accountCodeSchema.optional(),
  })
  .strict();
const regimeSource = { effectiveFrom: dateSchema, evidenceId: idSchema };
export const regimeInput = z.discriminatedUnion('axis', [
  z
    .object({ ...regimeSource, axis: z.literal('vat'), value: z.enum(['non_vat', 'normal_vat']) })
    .strict(),
  z
    .object({ ...regimeSource, axis: z.literal('income_tax'), value: z.enum(['profit', 'micro']) })
    .strict(),
  z
    .object({ ...regimeSource, axis: z.literal('eu_vat'), value: z.enum(['none', 'special']) })
    .strict(),
  z
    .object({ ...regimeSource, axis: z.literal('vat_collection'), value: z.enum(['no', 'yes']) })
    .strict(),
]);
export const policyInput = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_.-]{1,99}$/),
    expectedVersion: z.number().int().min(0),
    effectiveFrom: dateSchema,
    title: z.string().trim().min(3).max(300),
    body: z.record(z.string(), z.json()),
    evidenceId: idSchema,
  })
  .strict();
export const policyQuery = z.object({ key: policyInput.shape.key, date: dateSchema }).strict();

export async function initializeCompany(
  tx: Transaction,
  company: { id: string; year: number; createdBy: string },
) {
  await tx
    .insert(accountingYears)
    .values(
      ['financial', 'fiscal'].map((kind) => ({
        id: randomUUID(),
        companyId: company.id,
        kind: kind as 'financial' | 'fiscal',
        label: String(company.year),
        from: `${company.year}-01-01`,
        to: `${company.year}-12-31`,
        createdBy: company.createdBy,
      })),
    )
    .onConflictDoNothing();
  const existing = new Set(
    (
      await tx
        .select({ code: ledgerAccounts.code })
        .from(ledgerAccounts)
        .where(eq(ledgerAccounts.companyId, company.id))
    ).map((row) => row.code),
  );
  const rows = chart.accounts
    .filter((row) => !existing.has(row.code))
    .map((row) => ({
      ...row,
      companyId: company.id,
      chartVersion: chart.id,
      validFrom: '2015-01-01',
      createdBy: company.createdBy,
      balance: row.balance as 'debit' | 'credit' | 'both',
      book: row.book as 'general' | 'off_balance' | 'management',
    }));
  for (let i = 0; i < rows.length; i += 50)
    await tx
      .insert(ledgerAccounts)
      .values(rows.slice(i, i + 50))
      .onConflictDoNothing();
}

export async function financialYearForDate(tx: Transaction, companyId: string, date: string) {
  const rows = await tx
    .select()
    .from(accountingYears)
    .where(
      and(
        eq(accountingYears.companyId, companyId),
        eq(accountingYears.kind, 'financial'),
        lte(accountingYears.from, date),
        gte(accountingYears.to, date),
      ),
    );
  requireCondition(
    rows.length === 1,
    'FINANCIAL_YEAR',
    'Data trebuie să aparțină unui exercițiu financiar configurat.',
  );
  return rows[0];
}

export async function regimesAt(tx: Transaction, companyId: string, date: string) {
  const rows = await tx
    .select()
    .from(regimeEvents)
    .where(and(eq(regimeEvents.companyId, companyId), lte(regimeEvents.effectiveFrom, date)))
    .orderBy(desc(regimeEvents.effectiveFrom));
  return Object.fromEntries(
    ['vat', 'income_tax', 'eu_vat', 'vat_collection'].map((axis) => [
      axis,
      rows.find((row) => row.axis === axis) ?? null,
    ]),
  );
}

export class Foundation {
  constructor(private readonly runner: Commands) {}
  years(actor: Actor) {
    return this.runner.read(
      actor,
      (tx) =>
        tx
          .select()
          .from(accountingYears)
          .where(eq(accountingYears.companyId, actor.companyId))
          .orderBy(asc(accountingYears.from), asc(accountingYears.kind)),
      'years.list',
    );
  }
  createYear(actor: Actor, key: string, input: unknown) {
    const body = yearInput.parse(input);
    return this.runner.run(actor, key, 'years.create', body, 'manage', async (tx) => {
      const [row] = await tx
        .insert(accountingYears)
        .values({ id: randomUUID(), companyId: actor.companyId, ...body, createdBy: actor.actorId })
        .returning();
      return row;
    });
  }
  accounts(actor: Actor, input: unknown) {
    const body = accountQuery.parse(input);
    return this.runner.read(
      actor,
      async (tx) => {
        const rows = await tx
          .select()
          .from(ledgerAccounts)
          .where(
            and(
              eq(ledgerAccounts.companyId, actor.companyId),
              body.cursor ? gt(ledgerAccounts.code, body.cursor) : undefined,
              body.prefix
                ? and(
                    gte(ledgerAccounts.code, body.prefix),
                    lte(ledgerAccounts.code, `${body.prefix}\uffff`),
                  )
                : undefined,
            ),
          )
          .orderBy(asc(ledgerAccounts.code))
          .limit(body.limit + 1);
        return {
          chart: {
            id: chart.id,
            source: chart.source,
            sourceSha256: chart.sourceSha256,
            status: chart.status,
          },
          items: rows.slice(0, body.limit),
          nextCursor: rows.length > body.limit ? rows[body.limit - 1].code : null,
        };
      },
      'accounts.list',
    );
  }
  createAccount(actor: Actor, key: string, input: unknown) {
    const body = accountInput.parse(input);
    requireCondition(
      body.code.startsWith(`${body.parentCode}.`),
      'ANALYTICAL_CODE',
      'Codul analitic trebuie să înceapă cu codul părinte urmat de punct.',
    );
    return this.runner.run(actor, key, 'accounts.create', body, 'manage', async (tx) => {
      const [parent] = await tx
        .select()
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.companyId, actor.companyId),
            eq(ledgerAccounts.code, body.parentCode),
          ),
        );
      requireCondition(
        parent && parent.postable,
        'ACCOUNT_PARENT',
        'Contul părinte nu este disponibil pentru dezvoltare analitică.',
      );
      requireCondition(
        body.validFrom >= parent.validFrom,
        'ACCOUNT_DATE',
        'Data contului precedă contul părinte.',
      );
      const [row] = await tx
        .insert(ledgerAccounts)
        .values({
          ...body,
          companyId: actor.companyId,
          balance: parent.balance,
          book: parent.book,
          postable: true,
          chartVersion: parent.chartVersion,
          createdBy: actor.actorId,
        })
        .returning();
      return row;
    });
  }
  recordRegime(actor: Actor, key: string, input: unknown) {
    const body = regimeInput.parse(input);
    return this.runner.run(actor, key, 'regimes.record', body, 'review', async (tx) => {
      const [source] = await tx
        .select({ id: evidence.id })
        .from(evidence)
        .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, body.evidenceId)));
      requireCondition(source, 'NOT_FOUND', 'Documentul nu este disponibil.', 404);
      const [row] = await tx
        .insert(regimeEvents)
        .values({ id: randomUUID(), companyId: actor.companyId, ...body, createdBy: actor.actorId })
        .returning();
      return row;
    });
  }
  regimes(actor: Actor, date: string) {
    dateSchema.parse(date);
    return this.runner.read(
      actor,
      async (tx) => ({ date, regimes: await regimesAt(tx, actor.companyId, date) }),
      'regimes.read',
    );
  }
  recordPolicy(actor: Actor, key: string, input: unknown) {
    const body = policyInput.parse(input);
    return this.runner.run(actor, key, 'policies.record', body, 'review', async (tx) => {
      const [source] = await tx
        .select({ id: evidence.id })
        .from(evidence)
        .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, body.evidenceId)));
      requireCondition(source, 'NOT_FOUND', 'Documentul nu este disponibil.', 404);
      const [previous] = await tx
        .select()
        .from(accountingPolicies)
        .where(
          and(
            eq(accountingPolicies.companyId, actor.companyId),
            eq(accountingPolicies.key, body.key),
          ),
        )
        .orderBy(desc(accountingPolicies.version))
        .limit(1);
      requireCondition(
        (previous?.version ?? 0) === body.expectedVersion,
        'STALE_VERSION',
        'Politica s-a schimbat.',
        409,
      );
      const { expectedVersion, ...record } = body;
      const [row] = await tx
        .insert(accountingPolicies)
        .values({
          ...record,
          id: randomUUID(),
          companyId: actor.companyId,
          version: expectedVersion + 1,
          createdBy: actor.actorId,
        })
        .returning();
      return row;
    });
  }
  policies(actor: Actor, input: unknown) {
    const body = policyQuery.parse(input);
    return this.runner.read(
      actor,
      async (tx) => {
        const [row] = await tx
          .select()
          .from(accountingPolicies)
          .where(
            and(
              eq(accountingPolicies.companyId, actor.companyId),
              eq(accountingPolicies.key, body.key),
              lte(accountingPolicies.effectiveFrom, body.date),
            ),
          )
          .orderBy(desc(accountingPolicies.effectiveFrom), desc(accountingPolicies.version))
          .limit(1);
        return row ?? null;
      },
      'policies.read',
    );
  }
  rules(actor: Actor) {
    return this.runner.read(actor, async () => accountingRules, 'rules.list');
  }
  obligationCatalogue(actor: Actor) {
    return this.runner.read(actor, async () => obligationCatalogue, 'obligations.catalogue');
  }
}
