import { createHmac } from 'node:crypto';
import { and, asc, eq, gt, gte, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DomainError, requireCondition } from 'xfactura-core/errors';
import { canonical, hashOf } from 'xfactura-core/hash';
import { accountCodePattern, factInEffect } from 'xfactura-core/kernel';
import { chartAmendments, controlKindOf, referenceChart } from 'xfactura-core/ro/chart';
import { impairmentPolicies } from 'xfactura-core/ro/yearend';
import { stockPolicyAxes } from 'xfactura-core/ro/stock';
import { productionPolicyAxes } from 'xfactura-core/ro/production';
import {
  booksSystemOf,
  booksSystems,
  entityFormOf,
  entityForms,
  individualForms,
  type EntityForm,
} from 'xfactura-core/ro/entity';
import { prorataValues } from 'xfactura-core/ro/exempt';
import { taxpayerCategories } from 'xfactura-core/ro/saft/applicability';
import { isValidCnp } from 'xfactura-core/ro/identifiers';
import { addDays, bucharestDate, type LocalDate } from 'xfactura-core/time';
import type { Transaction } from '../db/database';
import type { PartyIdentities } from '../db/identity';
import { answerMediaType } from '../db/invariants';
import type { ObjectStore } from '../adapters/object-store';
import {
  commands,
  companies,
  entries,
  evidence,
  fiscalYears,
  invitations,
  ledgerAccounts,
  memberships,
  parties,
  profileFacts,
  proposals,
  user,
  warehouses,
} from '../db/schema';
import { appendAudit, commandKey, type Actor, type Commands, type Ids } from '../kernel/commands';
import { entryStands } from '../kernel/ledger';
import { cnpMask } from '../kernel/personal';
import { loadState, profileRows } from '../kernel/state';
import {
  axisName,
  axisValueName,
  profileAxisGroups,
  profileGroupNames,
  profileGroups,
  yearlyProfileAxes,
  type ProfileGroup,
} from '../kernel/work-names';
import { sha256 } from '../adapters/object-store';

const day = z.iso.date();

export const companyInput = z
  .object({
    name: z.string().trim().min(2).max(200),
    cui: z.string().regex(/^\d{2,10}$/),
    /** The first financial and fiscal year (calendar year). */
    year: z.number().int().min(2020).max(2100),
  })
  .strict();
export const companyView = z.object({ id: z.string(), name: z.string(), cui: z.string() });

export const inviteInput = z
  .object({ email: z.email(), role: z.enum(['reviewer', 'viewer']) })
  .strict();
export const yearInput = z
  .object({
    kind: z.enum(['financial', 'fiscal']),
    label: z.string().trim().min(1).max(100),
    from: day,
    to: day,
  })
  .strict()
  .refine((value) => value.from <= value.to, 'Interval invalid.');
export const accountInput = z
  .object({
    code: z.string().regex(accountCodePattern).includes('.'),
    name: z.string().trim().min(2).max(300),
    validFrom: day,
  })
  .strict();
export const accountQuery = z
  .object({
    prefix: z
      .string()
      .regex(/^[1-9][\dA-Z_.-]{0,40}$/)
      .optional(),
    after: z.string().max(80).optional(),
    limit: z.number().int().min(1).max(1000).default(200),
  })
  .strict();

/** Dated company facts the engine reads, with their allowed values. */
export const profileAxes = {
  // The legal form and its books (docs/PFA_II_IF.md §4.3): without a fact, an SRL keeping double
  // entry; a PFA, II or IF keeps single entry (OUG nr. 44/2008 art. 15).
  'entity.form': entityForms,
  'books.system': booksSystems,
  // The owner's contributions, per year (Codul fiscal art. 148 alin. (4), art. 150 alin. (1),
  // art. 174 alin. (7)–(8)): read as in force on 31 December of the income year.
  'cas.status': ['liable', 'pensioner', 'own_system'],
  'cas.option': ['no', 'yes'],
  'cass.exception': ['none', 'salary', 'other_income', 'pension', 'previous_year'],
  'vat.status': ['non_vat', 'normal_vat'],
  'vat.period': ['monthly', 'quarterly'],
  'vat.cash': ['no', 'yes'],
  'vat.eu': ['none', 'special'],
  // The provisional pro-rata of a taxable person with mixed operations (Codul fiscal art. 300
  // alin. (9)–(10)), in whole percent, from 1 January or from the day it starts being mixed, with
  // its notification to ANAF; `special` approved or imposed by the Ministry (alin. (16)–(17)),
  // `opted_out` not to deduct the VAT of purchases for both kinds of operations (alin. (20)).
  'vat.prorata': prorataValues,
  // Sales to consumers in other Member States (core ro/oss): where they take place (Codul fiscal
  // art. 278^1: in Romania below the threshold, at the destination above it or by the option of
  // alin. (3)), the Union scheme the destination's VAT is declared in (art. 315; `non_union` is
  // art. 314's, not a Romanian company's) and the import scheme (art. 315^2, not covered).
  'vat.distance': ['origin', 'destination', 'option'],
  'vat.oss': ['none', 'union', 'non_union'],
  'vat.ioss': ['none', 'registered', 'intermediary'],
  // Intrastat (core ro/trade): whether the company provides INS's statistical data for a flow,
  // from the month the year's determination gives, confirmed with INS's notice.
  'intrastat.arrivals': ['none', 'provider'],
  'intrastat.dispatches': ['none', 'provider'],
  income_tax: ['micro', 'profit'],
  // The system of declaring and paying the profit tax (Codul fiscal art. 41): quarterly
  // (alin. (1)), or annual with quarterly prepayments, an option for at least two years
  // (alin. (2)–(3)).
  'profit.system': ['quarterly', 'annual'],
  // Payment facilities or insolvency (Codul de procedură fiscală art. 163 alin. (10)): a payment
  // to the single account is then extinguished in another order, which the tax account does not
  // cover (core ro/taxaccount); without the fact, a payment is not distributed.
  'tax.facilities': [
    'none',
    'rescheduling',
    'deferral',
    'insolvency',
    'restructuring',
    'state_aid',
  ],
  employer: ['no', 'yes'],
  // Yearly determinations (core ro/determinations): each year's fact, confirmed from the
  // computation or stated with its document; and what decides the product's scope.
  'payroll.period': ['monthly', 'quarterly'],
  'size.category': ['micro', 'small', 'medium_large'],
  'vat.threshold': ['under', 'exceeded'],
  // Goods or stock (not covered until G1), or only individual items under the margin scheme of
  // art. 312, each its purchase document, without quantity stock (V4).
  'activity.goods': ['no', 'yes', 'margin_goods'],
  // A farmer in ANAF's register of farmers applying the special regime (Codul fiscal art. 315^1
  // alin. (5)), from its inscription, with the register's extract (V4).
  'vat.agriculture': ['none', 'special'],
  // No activity since the company was set up (Legea 82/1991 art. 36 alin. (2)): the inactivity
  // declaration (S1046) instead of the annual statements; a person states it with its evidence.
  'activity.none': ['no', 'yes'],
  'regime.excluded': ['none', 'excise', 'fiscal_group', 'ifrs'],
  // ANAF's taxpayer category (large, medium, small), dated from the classification: it decides
  // from when D406 is filed before 2025 (OPANAF nr. 1.783/2021 anexa nr. 5 pct. 1.1).
  'taxpayer.category': taxpayerCategories,
  'books.assurance': ['preview', 'shadow', 'live'],
  // Segregation of duties (kernel/controls.ts): without a fact, off, as a company of one person
  // needs; on, nobody approves their own work; strict, nor what their agents did.
  'controls.segregation': ['off', 'on', 'strict'],
  // Accounting policies (OMFP 1802/2014 requires them in writing): dated, with their evidence.
  'policy.storno': ['red', 'black'],
  // Where contributions borne in an employee's name (the part-time minimum) are expensed.
  'policy.payroll.employer_share': ['635', '6458'],
  // Whether an asset is depreciated for the month it is disposed of.
  'policy.assets.disposal_month': ['included', 'excluded'],
  // How receivables are tested for impairment at the year's end (OMFP 1802/2014 pct. 332, 353):
  // each individually, or every one overdue beyond a number of days (core ro/yearend).
  'policy.impairment.receivables': impairmentPolicies,
  // The stock register's policies (OMFP 1802/2014 pct. 96, 286, 289–291; core ro/stock): the
  // output method (FIFO, LIFO, the weighted average after each receipt or monthly), perpetual or
  // periodic inventory, whether a pool may go below zero, goods at cost or at the retail price.
  'policy.stock.valuation': stockPolicyAxes['policy.stock.valuation'],
  'policy.stock.inventory': stockPolicyAxes['policy.stock.inventory'],
  'policy.stock.negative': stockPolicyAxes['policy.stock.negative'],
  'policy.stock.retail': stockPolicyAxes['policy.stock.retail'],
  // The cost of the company's products (OMFP 1802/2014 pct. 8 pct. 7, 286; core ro/production):
  // the standard cost with its price differences, or the actual production cost.
  'policy.production.cost': productionPolicyAxes['policy.production.cost'],
} as const;
/** A warehouse's own method, at cost or at retail price, in place of the company's
 * `policy.stock.retail` for it (`policy.stock.retail.<warehouseId>`, core ro/stock
 * `retailMethodAt`; OMFP 1802/2014 pct. 286 alin. (8), 287 alin. (3)). */
const warehouseRetailAxis =
  /^policy\.stock\.retail\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The values an axis takes: a warehouse's own retail method takes the company's. */
export const axisValues = (axis: string): readonly string[] =>
  (profileAxes[axis as keyof typeof profileAxes] ??
    (warehouseRetailAxis.test(axis)
      ? profileAxes['policy.stock.retail']
      : [])) as readonly string[];
const factShape = {
  axis: z.union([
    z.enum(Object.keys(profileAxes) as [keyof typeof profileAxes, ...(keyof typeof profileAxes)[]]),
    z.string().regex(warehouseRetailAxis),
  ]),
  value: z.string(),
  effectiveFrom: day,
  supersedesId: z.uuid().optional(),
};
const allowedValue = {
  check: (fact: { axis: string; value: string }) => axisValues(fact.axis).includes(fact.value),
  message: { message: 'Valoare nepermisă pentru această axă.', path: ['value'] },
};
/** A dated company fact as `profile.record` takes it: with the document that proves it, or,
 * without one, the person's own statement, which the engine keeps as evidence. */
export const profileInput = z
  .object({ ...factShape, evidenceId: z.uuid().optional() })
  .strict()
  .refine(allowedValue.check, allowedValue.message);
/** A fact as it is recorded: always citing its evidence. */
export const profileFactInput = z
  .object({ ...factShape, evidenceId: z.uuid() })
  .strict()
  .refine(allowedValue.check, allowedValue.message);
type ProfileFactInput = z.infer<typeof profileFactInput>;

export const profileCurrentInput = z
  .object({
    /** The day the values are read on; the engine's today in Bucharest by default. */
    date: day.optional(),
  })
  .strict();
const valueLabel = z.object({ value: z.string(), label: z.string() });
export const profileAxisView = z.object({
  axis: z.string(),
  name: z.string(),
  group: z.enum(profileGroups),
  /** Whether any of its values applies to the company on the day (`values[].applies`). */
  applies: z.boolean(),
  /** The fact is stated for each year: the law decides it yearly. */
  yearly: z.boolean(),
  /** Each value with its label and whether `profile.record` would take it on the day, as it
   * checks the legal form and the facts recorded (`formRefusal`): the owner's contributions and
   * single entry for a PFA, II or IF, the profit or micro tax for a company, a form of the same
   * kind of taxpayer as the one recorded. */
  values: z.array(valueLabel.extend({ applies: z.boolean() })),
  /** The fact in effect on the day, as treatments read it (`profileAt`): the last effective by
   * the day, superseded facts left out. */
  current: z
    .object({
      value: z.string(),
      label: z.string(),
      effectiveFrom: z.string(),
      factId: z.string(),
      evidenceId: z.string(),
      recordedBy: z.string(),
      /** On a yearly axis: the year the fact was stated for, and whether that is an earlier year
       * than the day's, whose own fact is still to be stated or confirmed. */
      confirmedFor: z.number().optional(),
      needsConfirmation: z.boolean().optional(),
    })
    .nullable(),
  /** The value the engine reads when nothing is recorded, where it reads one. */
  impliedDefault: valueLabel.nullable(),
  /** Every fact recorded on the axis in effect order, the superseded ones included. */
  history: z.array(
    z.object({
      value: z.string(),
      label: z.string(),
      effectiveFrom: z.string(),
      factId: z.string(),
      evidenceId: z.string(),
      supersedesId: z.string().nullable(),
      superseded: z.boolean(),
      recordedBy: z.string(),
      recordedAt: z.string(),
    }),
  ),
});
export const profileCurrentView = z.object({
  date: z.string(),
  items: z.array(profileAxisView),
  next: z.string().nullable(),
  /** The groups in the order shown, with their Romanian names. */
  groups: z.array(z.object({ group: z.enum(profileGroups), name: z.string() })),
});
/** A partner's identifier as a caller sees it: an individual's (the keyed hash of a CNP) is
 * masked for agents, to whom it is no use and who never read a CNP. */
export const maskedTaxId = (
  actor: Actor,
  party: { kind: string; taxId: string | null },
): string | null =>
  actor.agentId && party.kind === 'ro_individual' && party.taxId ? cnpMask : party.taxId;

export const partyInput = z
  .object({
    kind: z.enum([
      'ro_legal_entity',
      'ro_individual_enterprise',
      'ro_individual',
      'ro_public_institution',
      'eu_taxable',
      'non_eu',
    ]),
    country: z.string().regex(/^[A-Z]{2}$/),
    taxId: z.string().trim().min(1).max(40).optional(),
    name: z.string().trim().min(1).max(300),
  })
  .strict();

/** Loads the reference chart with the kernel's control kinds and the first year. */
async function initializeCompany(
  tx: Transaction,
  companyId: string,
  year: number,
  createdBy: string,
  ids: Ids,
) {
  await tx.insert(fiscalYears).values(
    (['financial', 'fiscal'] as const).map((kind) => ({
      id: ids(),
      companyId,
      kind,
      label: String(year),
      from: `${year}-01-01`,
      to: `${year}-12-31`,
      createdBy,
    })),
  );
  const rows = [
    { validFrom: '2015-01-01', chartVersion: referenceChart.id, accounts: referenceChart.accounts },
    ...chartAmendments.map((amendment) => ({
      validFrom: amendment.validFrom,
      chartVersion: amendment.clause,
      accounts: amendment.accounts,
    })),
  ].flatMap(({ validFrom, chartVersion, accounts }) =>
    accounts.map((account) => ({
      companyId,
      code: account.code,
      parentCode: account.parentCode,
      name: account.name,
      nature: account.balance,
      book: account.book,
      postable: account.postable,
      controlKind: account.postable ? controlKindOf(account.code) : null,
      validFrom,
      chartVersion,
      createdBy,
    })),
  );
  for (let index = 0; index < rows.length; index += 50)
    await tx.insert(ledgerAccounts).values(rows.slice(index, index + 50));
}

/** Records a dated company fact inside the caller's command, after the checks `profile.record`
 * makes; a person's answer to a `profile.fact` question records its fact through here. */
export async function writeProfileFact(
  tx: Transaction,
  actor: Actor,
  input: ProfileFactInput,
  ids: Ids,
) {
  const [source] = await tx
    .select({ id: evidence.id })
    .from(evidence)
    .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.id, input.evidenceId)));
  requireCondition(source, 'EVIDENCE', 'Documentul justificativ nu este disponibil.', 404);
  await checkFact(tx, actor, input);
  return insertFact(tx, actor, input, ids);
}

/** The checks a fact passes before it is recorded: its warehouse, the legal form, what it
 * supersedes. */
async function checkFact(
  tx: Transaction,
  actor: Actor,
  input: Omit<ProfileFactInput, 'evidenceId'>,
) {
  if (warehouseRetailAxis.test(input.axis)) {
    const [store] = await tx
      .select({ id: warehouses.id })
      .from(warehouses)
      .where(
        and(
          eq(warehouses.companyId, actor.companyId),
          eq(warehouses.id, input.axis.slice(input.axis.lastIndexOf('.') + 1)),
        ),
      );
    requireCondition(store, 'WAREHOUSE', 'Gestiunea nu există.', 404);
  }
  await checkForm(tx, actor.companyId, input);
  if (input.supersedesId) {
    const [superseded] = await tx
      .select()
      .from(profileFacts)
      .where(
        and(eq(profileFacts.companyId, actor.companyId), eq(profileFacts.id, input.supersedesId)),
      );
    requireCondition(
      superseded?.axis === input.axis,
      'SUPERSEDES',
      'Faptul înlocuit aparține altei axe.',
    );
  }
}

async function insertFact(tx: Transaction, actor: Actor, input: ProfileFactInput, ids: Ids) {
  const id = ids();
  await tx
    .insert(profileFacts)
    .values({ id, companyId: actor.companyId, ...input, createdBy: actor.actorId });
  return { id, ...input };
}

/**
 * What a person stated, kept as evidence: the canonical JSON of it, of the kind an answer to a
 * question is kept as (`application/vnd.xfactura.answer+json`), which proposals and profile facts
 * cite. The body names its own evidence id, so two statements alike stay two files.
 */
export async function keepStatement(
  tx: Transaction,
  objects: ObjectStore,
  commands: Commands,
  actor: Actor,
  filename: string,
  body: (evidenceId: string) => Record<string, unknown>,
) {
  const id = commands.ids();
  const bytes = new TextEncoder().encode(canonical(body(id)));
  const hash = await objects.put(actor.companyId, bytes);
  await tx.insert(evidence).values({
    id,
    companyId: actor.companyId,
    hash,
    filename,
    mediaType: answerMediaType,
    size: bytes.length,
    createdBy: actor.actorId,
    engineAt: commands.clock(),
  });
  return id;
}

/**
 * The legal form decides which axes and values apply. An SRL and a PFA, II or IF are different
 * taxpayers: the form does not move between them. Single-entry books are a PFA's, II's or IF's;
 * whether they may opt for double entry is open (OUG nr. 44/2008 art. 15 against OMFP nr.
 * 170/2015 art. 3), so the option is recorded as the person states it, with its document; the
 * obligation closure reports it UNSUPPORTED (PFA_DOUBLE_ENTRY) and the single-entry registers
 * refuse it. The owner's contributions concern a PFA, II or IF; the profit or micro tax regime an
 * SRL.
 */
async function checkForm(
  tx: Transaction,
  companyId: string,
  input: Pick<ProfileFactInput, 'axis' | 'value' | 'effectiveFrom'>,
) {
  const { loaded } = await loadState(tx, companyId, { profile: true });
  const facts = loaded.profile;
  const refused = formRefusal(
    input.axis,
    input.value,
    facts,
    entityFormOf(facts, input.effectiveFrom as LocalDate),
  );
  if (refused) throw new DomainError(refused.code, refused.message, 422);
}

/**
 * Why a value may not be recorded on an axis given the facts recorded and the legal form on its
 * day, or null when it may (`checkForm`, and `profile.current`'s `applies`).
 */
export function formRefusal(
  axis: string,
  value: string,
  facts: readonly { axis: string; value: string }[],
  form: EntityForm,
): { code: string; message: string } | null {
  const individual = (of: string) => individualForms.includes(of as EntityForm);
  if (axis === 'entity.form') {
    if (
      !facts.every(
        (fact) => fact.axis !== 'entity.form' || individual(fact.value) === individual(value),
      )
    )
      return {
        code: 'ENTITY_FORM_CHANGE',
        message:
          'O societate și o PFA, II sau IF sunt contribuabili diferiți: forma juridică nu trece de la una la alta.',
      };
    if (
      individual(value) &&
      facts.some(
        (fact) =>
          fact.axis === 'income_tax' || (fact.axis === 'books.system' && fact.value === 'double'),
      )
    )
      return {
        code: 'ENTITY_FORM_CHANGE',
        message:
          'Compania are deja un regim de impozit pe profit sau micro ori partida dublă, ale unei societăți.',
      };
    return null;
  }
  if (axis === 'books.system')
    return value === 'double' || individual(form)
      ? null
      : {
          code: 'BOOKS_SYSTEM_FORM',
          message: 'Contabilitatea în partidă simplă se ține de PFA, II și IF (entity.form).',
        };
  if ((axis.startsWith('cas.') || axis.startsWith('cass.')) && !individual(form))
    return {
      code: 'PROFILE_FORM',
      message: 'Contribuțiile titularului se înregistrează pentru o PFA, II sau IF (entity.form).',
    };
  if (axis === 'income_tax' && individual(form))
    return {
      code: 'PROFILE_FORM',
      message:
        'Impozitul pe profit sau pe veniturile microîntreprinderilor nu se aplică unei PFA, II sau IF.',
    };
  return null;
}

export class Companies {
  constructor(
    private readonly commands: Commands,
    private readonly secret: string,
  ) {}

  list(actorId: string) {
    return this.commands.db.read((tx) =>
      tx
        .select({ id: companies.id, name: companies.name, cui: companies.cui })
        .from(companies)
        .innerJoin(memberships, eq(memberships.companyId, companies.id))
        .where(and(eq(memberships.userId, actorId), eq(memberships.active, true)))
        .orderBy(asc(companies.name)),
    );
  }

  /** Creates a company owned by the actor. Idempotent per actor and key, before any membership. */
  async create(actorId: string, key: string, input: z.infer<typeof companyInput>) {
    commandKey(key);
    const hash = hashOf({ operation: 'company.create', input });
    return this.commands.db.write(async (tx) => {
      const [previous] = await tx
        .select()
        .from(commands)
        .where(
          and(
            eq(commands.actorId, actorId),
            eq(commands.key, key),
            eq(commands.operation, 'company.create'),
          ),
        );
      if (previous) {
        requireCondition(
          previous.hash === hash,
          'IDEMPOTENCY_CONFLICT',
          'Cheia a fost deja folosită pentru alte date.',
          409,
        );
        await this.commands.authorize(
          tx,
          { actorId, companyId: previous.companyId },
          'read',
          'company.get',
        );
        return previous.result as z.infer<typeof companyView>;
      }
      const id = this.commands.ids();
      await tx
        .insert(companies)
        .values({ id, name: input.name, cui: input.cui, createdBy: actorId });
      await tx.insert(memberships).values({ companyId: id, userId: actorId, role: 'owner' });
      await initializeCompany(tx, id, input.year, actorId, this.commands.ids);
      const result = { id, name: input.name, cui: input.cui };
      await tx
        .insert(commands)
        .values({ companyId: id, actorId, key, operation: 'company.create', hash, result });
      await appendAudit(tx, {
        companyId: id,
        actorId,
        action: 'company.create',
        body: { commandHash: hash, resultHash: hashOf(result) },
      });
      return result;
    });
  }

  async invite(actor: Actor, key: string, input: z.infer<typeof inviteInput>) {
    // Derived from the command, so a retried request recovers the same token without storing it.
    const token = createHmac('sha256', this.secret)
      .update(
        canonical({ purpose: 'invite', actorId: actor.actorId, companyId: actor.companyId, key }),
      )
      .digest('hex');
    const result = await this.commands.run(
      actor,
      key,
      'company.invite',
      input,
      'manage',
      async (tx) => {
        const id = this.commands.ids();
        await tx.insert(invitations).values({
          id,
          companyId: actor.companyId,
          email: input.email.toLowerCase(),
          role: input.role,
          tokenHash: sha256(token),
          expiresAt: this.commands.clock() + 48 * 3_600_000,
          createdBy: actor.actorId,
        });
        return { id, expiresInHours: 48 };
      },
    );
    return { ...result, token };
  }

  /** Accepts an invitation for the signed-in person. A returning member starts a new epoch. */
  async accept(actorId: string, token: string) {
    requireCondition(/^[a-f0-9]{64}$/.test(token), 'INVITATION', 'Invitație invalidă.');
    return this.commands.db.write(async (tx) => {
      const [person] = await tx
        .select({ email: user.email })
        .from(user)
        .where(eq(user.id, actorId));
      const [invitation] = await tx
        .select()
        .from(invitations)
        .where(eq(invitations.tokenHash, sha256(token)));
      requireCondition(
        person && invitation && person.email.toLowerCase() === invitation.email,
        'INVITATION',
        'Invitația nu este disponibilă pentru acest cont.',
        404,
      );
      if (invitation.acceptedAt) {
        await this.commands.authorize(
          tx,
          { actorId, companyId: invitation.companyId },
          'read',
          'company.get',
        );
        return { id: invitation.companyId };
      }
      requireCondition(
        invitation.expiresAt > this.commands.clock(),
        'INVITATION',
        'Invitația a expirat.',
        404,
      );
      await this.commands.authorize(
        tx,
        { actorId: invitation.createdBy, companyId: invitation.companyId },
        'manage',
        'company.invite',
      );
      const member = and(
        eq(memberships.companyId, invitation.companyId),
        eq(memberships.userId, actorId),
      );
      const [existing] = await tx.select().from(memberships).where(member);
      if (!existing)
        await tx
          .insert(memberships)
          .values({ companyId: invitation.companyId, userId: actorId, role: invitation.role });
      else if (!existing.active || existing.role !== invitation.role)
        await tx
          .update(memberships)
          .set({ role: invitation.role, active: true, epoch: sql`${memberships.epoch} + 1` })
          .where(member);
      await tx
        .update(invitations)
        .set({ acceptedAt: this.commands.clock() })
        .where(eq(invitations.id, invitation.id));
      await appendAudit(tx, {
        companyId: invitation.companyId,
        actorId,
        action: 'company.acceptInvitation',
        body: { invitationId: invitation.id, role: invitation.role },
      });
      return { id: invitation.companyId };
    });
  }

  async revokeMember(actor: Actor, key: string, input: { userId: string }) {
    return this.commands.run(actor, key, 'company.revoke', input, 'manage', async (tx) => {
      const member = and(
        eq(memberships.companyId, actor.companyId),
        eq(memberships.userId, input.userId),
      );
      const [existing] = await tx.select().from(memberships).where(member);
      requireCondition(existing, 'NOT_FOUND', 'Membrul nu este disponibil.', 404);
      requireCondition(
        existing.role !== 'owner',
        'OWNER_REQUIRED',
        'Proprietarul nu poate fi revocat prin această acțiune.',
      );
      if (existing.active)
        await tx
          .update(memberships)
          .set({ active: false, epoch: sql`${memberships.epoch} + 1` })
          .where(member);
      return { userId: input.userId, revoked: true as const };
    });
  }

  members(actor: Actor) {
    return this.commands.read(actor, 'company.members', (tx) =>
      tx
        .select({
          userId: memberships.userId,
          name: user.name,
          email: user.email,
          role: memberships.role,
          active: memberships.active,
        })
        .from(memberships)
        .innerJoin(user, eq(user.id, memberships.userId))
        .where(eq(memberships.companyId, actor.companyId))
        .orderBy(asc(user.email)),
    );
  }
}

export class Configuration {
  constructor(
    private readonly commands: Commands,
    /** Individuals' party identifiers (`parties.create`). */
    private readonly identities: PartyIdentities,
    /** Where a person's statement of a fact is kept (`profile.record` without a document). */
    private readonly objects: ObjectStore,
  ) {}

  years(actor: Actor) {
    return this.commands.read(actor, 'years.list', (tx) =>
      tx
        .select({
          id: fiscalYears.id,
          kind: fiscalYears.kind,
          label: fiscalYears.label,
          from: fiscalYears.from,
          to: fiscalYears.to,
        })
        .from(fiscalYears)
        .where(eq(fiscalYears.companyId, actor.companyId))
        .orderBy(asc(fiscalYears.from), asc(fiscalYears.kind)),
    );
  }

  /**
   * Adds a financial or fiscal year. The years of a kind follow one another, without an overlap
   * (a date in two financial years is in none: `financialYearOf`) and without a gap, and no
   * financial year is added before an opening entry that stands: the books open with their first
   * year, and the ledger carries every later one's balances. The database refuses each too
   * (`inv:year_overlap`, `inv:year_contiguous`, `inv:year_before_opening`), and the table is
   * append-only.
   */
  createYear(actor: Actor, key: string, input: z.infer<typeof yearInput>) {
    return this.commands.run(actor, key, 'years.create', input, 'manage', async (tx) => {
      const years = await tx
        .select({ from: fiscalYears.from, to: fiscalYears.to })
        .from(fiscalYears)
        .where(and(eq(fiscalYears.companyId, actor.companyId), eq(fiscalYears.kind, input.kind)))
        .orderBy(asc(fiscalYears.from));
      const overlap = years.find((year) => year.from <= input.to && input.from <= year.to);
      requireCondition(
        !overlap,
        'YEAR_OVERLAP',
        `Exercițiul se suprapune cu exercițiul ${overlap?.from} – ${overlap?.to}.`,
        409,
      );
      const first = years[0];
      const last = years.at(-1);
      if (first && last)
        requireCondition(
          years.some(
            (year) =>
              year.to === addDays(input.from as LocalDate, -1) ||
              year.from === addDays(input.to as LocalDate, 1),
          ),
          'YEAR_GAP',
          `Exercițiile se succed fără întrerupere: noul exercițiu începe la ${addDays(last.to as LocalDate, 1)} sau se încheie la ${addDays(first.from as LocalDate, -1)}.`,
          409,
        );
      if (input.kind === 'financial') {
        const [opening] = await tx
          .select({ date: entries.date })
          .from(entries)
          .innerJoin(
            proposals,
            and(eq(proposals.companyId, entries.companyId), eq(proposals.id, entries.proposalId)),
          )
          .where(
            and(
              eq(entries.companyId, actor.companyId),
              eq(entries.journalCode, 'DESCHIDERE'),
              gt(entries.date, input.to),
              entryStands('"acc_entries"'),
              sql`${proposals.subjectKey} not like 'reverse:%'`,
            ),
          )
          .limit(1);
        requireCondition(
          !opening,
          'YEAR_BEFORE_OPENING',
          `Registrele se deschid cu nota de deschidere din ${opening?.date}: un exercițiu anterior i-ar număra soldurile de două ori. Stornați nota de deschidere înainte de a adăuga exercițiul.`,
          409,
        );
      }
      const id = this.commands.ids();
      await tx
        .insert(fiscalYears)
        .values({ id, companyId: actor.companyId, ...input, createdBy: actor.actorId });
      return { id, ...input };
    });
  }

  accounts(actor: Actor, input: z.infer<typeof accountQuery>) {
    return this.commands.read(actor, 'accounts.list', async (tx) => {
      const rows = await tx
        .select({
          code: ledgerAccounts.code,
          parentCode: ledgerAccounts.parentCode,
          name: ledgerAccounts.name,
          nature: ledgerAccounts.nature,
          postable: ledgerAccounts.postable,
          controlKind: ledgerAccounts.controlKind,
          validFrom: ledgerAccounts.validFrom,
          validTo: ledgerAccounts.validTo,
        })
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.companyId, actor.companyId),
            input.prefix
              ? and(
                  gte(ledgerAccounts.code, input.prefix),
                  lte(ledgerAccounts.code, `${input.prefix}￿`),
                )
              : undefined,
            input.after ? gt(ledgerAccounts.code, input.after) : undefined,
          ),
        )
        .orderBy(asc(ledgerAccounts.code))
        .limit(input.limit + 1);
      return {
        items: rows.slice(0, input.limit),
        next: rows.length > input.limit ? rows[input.limit - 1]!.code : null,
      };
    });
  }

  /** Adds an analytical account under a postable synthetic, inheriting its control. */
  createAccount(actor: Actor, key: string, input: z.infer<typeof accountInput>) {
    return this.commands.run(actor, key, 'accounts.create', input, 'manage', async (tx) => {
      const parentCode = input.code.slice(0, input.code.lastIndexOf('.'));
      const [parent] = await tx
        .select()
        .from(ledgerAccounts)
        .where(
          and(eq(ledgerAccounts.companyId, actor.companyId), eq(ledgerAccounts.code, parentCode)),
        );
      requireCondition(
        parent?.postable && parent.book === 'general',
        'ACCOUNT_PARENT',
        'Contul analitic se creează sub un cont sintetic utilizabil.',
      );
      await tx.insert(ledgerAccounts).values({
        companyId: actor.companyId,
        code: input.code,
        parentCode,
        name: input.name,
        nature: parent.nature,
        book: parent.book,
        postable: true,
        controlKind: parent.controlKind,
        validFrom: input.validFrom,
        chartVersion: 'company',
        createdBy: actor.actorId,
      });
      return { code: input.code, parentCode, name: input.name, controlKind: parent.controlKind };
    });
  }

  profile(actor: Actor) {
    return this.commands.read(actor, 'profile.read', (tx) =>
      tx
        .select({
          id: profileFacts.id,
          axis: profileFacts.axis,
          value: profileFacts.value,
          effectiveFrom: profileFacts.effectiveFrom,
          evidenceId: profileFacts.evidenceId,
          supersedesId: profileFacts.supersedesId,
          createdBy: profileFacts.createdBy,
          createdAt: profileFacts.createdAt,
        })
        .from(profileFacts)
        .where(eq(profileFacts.companyId, actor.companyId))
        .orderBy(
          asc(profileFacts.axis),
          asc(profileFacts.effectiveFrom),
          asc(profileFacts.createdAt),
        ),
    );
  }

  /**
   * Records a dated fact. With a document, the fact cites it; without one, the person's statement
   * (who, when, the axis, the value and its date) is kept as evidence first and the fact cites
   * that, as an answer to a `profile.fact` question does. The checks are the same either way.
   */
  recordProfile(actor: Actor, key: string, input: z.infer<typeof profileInput>) {
    return this.commands.run(actor, key, 'profile.record', input, 'review', async (tx) => {
      const { evidenceId, ...fact } = input;
      if (evidenceId)
        return writeProfileFact(tx, actor, { ...fact, evidenceId }, this.commands.ids);
      await checkFact(tx, actor, fact);
      const statement = await keepStatement(
        tx,
        this.objects,
        this.commands,
        actor,
        `declaratie-${fact.axis}-${fact.effectiveFrom}.json`,
        (id) => ({
          schema: 'xfactura.statement@1',
          statementId: id,
          kind: 'profile.fact',
          axis: fact.axis,
          value: fact.value,
          effectiveFrom: fact.effectiveFrom,
          supersedesId: fact.supersedesId ?? null,
          statedBy: actor.actorId,
          statedAt: new Date(this.commands.clock()).toISOString(),
        }),
      );
      return insertFact(tx, actor, { ...fact, evidenceId: statement }, this.commands.ids);
    });
  }

  /**
   * Every profile axis on a day, grouped for people: its Romanian name, its values with their
   * labels, whether it applies to the company's legal form, the fact in effect (`factInEffect` on
   * the facts the state loader reads, a yearly axis's only within its year), the value the engine
   * reads when none is recorded, and every fact recorded on it. A warehouse's own retail method
   * follows the company's.
   */
  profileCurrent(actor: Actor, input: z.infer<typeof profileCurrentInput>) {
    return this.commands.read(actor, 'profile.current', async (tx) => {
      const date = input.date ?? bucharestDate(this.commands.clock());
      const recorded = await tx
        .select()
        .from(profileFacts)
        .where(eq(profileFacts.companyId, actor.companyId))
        .orderBy(
          asc(profileFacts.effectiveFrom),
          asc(profileFacts.createdAt),
          asc(profileFacts.id),
        );
      const standing = await profileRows(tx, actor.companyId);
      const kept = new Set(standing.map((row) => row.id));
      const facts = standing.map((row) => ({
        axis: row.axis,
        value: row.value,
        effectiveFrom: row.effectiveFrom as LocalDate,
      }));
      const form = entityFormOf(facts, date as LocalDate);
      const stores = await tx
        .select({ id: warehouses.id, code: warehouses.code, name: warehouses.name })
        .from(warehouses)
        .where(eq(warehouses.companyId, actor.companyId))
        .orderBy(asc(warehouses.code), asc(warehouses.id));
      const axes: { axis: string; name: string; group: ProfileGroup }[] = [
        ...profileAxisGroups.flatMap(([axis, group]) => [
          { axis, name: axisName(axis), group },
          ...(axis === 'policy.stock.retail'
            ? stores.map((store) => ({
                axis: `policy.stock.retail.${store.id}`,
                name: `${axisName(`policy.stock.retail.${store.id}`)} ${store.code} ${store.name}`,
                group,
              }))
            : []),
        ]),
      ];
      const labelled = (axis: string, value: string) => ({
        value,
        label: axisValueName(axis, value) ?? value,
      });
      // What the engine reads when nothing is recorded: an SRL (`entityFormOf`), the form's own
      // books (`booksSystemOf`), preview rules (`Proposals.mode`), segregation off
      // (`segregationOn`).
      const implied: Record<string, string> = {
        'entity.form': 'srl',
        'books.system': booksSystemOf(
          facts.filter((fact) => fact.axis !== 'books.system'),
          date as LocalDate,
        ),
        'books.assurance': 'preview',
        'controls.segregation': 'off',
      };
      const items = axes.map(({ axis, name, group }) => {
        const yearly = yearlyProfileAxes.has(axis);
        const current = factInEffect(standing, axis, date);
        const values = axisValues(axis).map((value) => ({
          ...labelled(axis, value),
          applies: formRefusal(axis, value, facts, form) === null,
        }));
        const statedFor = current ? Number(current.effectiveFrom.slice(0, 4)) : null;
        return {
          axis,
          name,
          group,
          applies: values.some((value) => value.applies),
          yearly,
          values,
          current: current && {
            ...labelled(axis, current.value),
            effectiveFrom: current.effectiveFrom,
            factId: current.id,
            evidenceId: current.evidenceId,
            recordedBy: current.createdBy,
            ...(yearly
              ? {
                  confirmedFor: statedFor!,
                  needsConfirmation: statedFor! < Number(date.slice(0, 4)),
                }
              : {}),
          },
          impliedDefault: implied[axis] ? labelled(axis, implied[axis]) : null,
          history: recorded
            .filter((row) => row.axis === axis)
            .map((row) => ({
              ...labelled(axis, row.value),
              effectiveFrom: row.effectiveFrom,
              factId: row.id,
              evidenceId: row.evidenceId,
              supersedesId: row.supersedesId ?? null,
              superseded: !kept.has(row.id),
              recordedBy: row.createdBy,
              recordedAt: row.createdAt,
            })),
        };
      });
      return {
        date,
        items,
        next: null,
        groups: profileGroups.map((group) => ({ group, name: profileGroupNames[group] })),
      };
    });
  }

  /** The company's partners; an individual's identifier (the keyed hash of a CNP) is masked
   * for agents (`maskedTaxId`). */
  parties(actor: Actor) {
    return this.commands.read(actor, 'parties.list', async (tx) =>
      (
        await tx
          .select({
            id: parties.id,
            kind: parties.kind,
            country: parties.country,
            taxId: parties.taxId,
            name: parties.name,
          })
          .from(parties)
          .where(eq(parties.companyId, actor.companyId))
          .orderBy(asc(parties.name), asc(parties.id))
      ).map((row) => ({ ...row, taxId: maskedTaxId(actor, row) })),
    );
  }

  /**
   * A partner. An individual's identifier, when given, is a CNP, kept only as its keyed hash
   * (`PartyIdentities`), the identity an employee who is this person has; the CNP itself is
   * recorded sealed with `parties.recordCnp`. A partner of the same country and identifier as one
   * already recorded is refused (`PARTY_EXISTS`, naming it).
   */
  createParty(actor: Actor, key: string, input: z.infer<typeof partyInput>) {
    return this.commands.run(actor, key, 'parties.create', input, 'write', async (tx) => {
      const code = input.taxId?.replace(/^RO/i, '').replace(/\s+/g, '') ?? null;
      const individual = input.kind === 'ro_individual';
      requireCondition(
        !individual || code === null || isValidCnp(code),
        'CNP',
        'Codul unei persoane fizice este CNP-ul ei, iar acesta nu este valid.',
      );
      const taxId = individual && code ? this.identities.ofCnp(actor.companyId, code) : code;
      if (taxId) {
        const [existing] = await tx
          .select({ id: parties.id })
          .from(parties)
          .where(
            and(
              eq(parties.companyId, actor.companyId),
              eq(parties.country, input.country),
              eq(parties.taxId, taxId),
            ),
          );
        requireCondition(
          !existing,
          'PARTY_EXISTS',
          'Există deja un partener cu această țară și acest cod de identificare.',
          409,
          { partyId: existing?.id },
        );
      }
      const id = this.commands.ids();
      await tx
        .insert(parties)
        .values({ id, companyId: actor.companyId, ...input, taxId, createdBy: actor.actorId });
      return {
        id,
        kind: input.kind,
        country: input.country,
        taxId: maskedTaxId(actor, { kind: input.kind, taxId }),
        name: input.name,
      };
    });
  }
}
