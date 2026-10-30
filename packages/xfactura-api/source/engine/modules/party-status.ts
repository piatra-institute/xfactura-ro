import { and, asc, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { partyStatusKey } from 'xfactura-core/kernel';
import { invoiceKinds, taxPointOf } from 'xfactura-core/ro/treatments/invoices';
import {
  bucharestDate,
  monthEnd,
  monthStart,
  type LocalDate,
  type Month,
} from 'xfactura-core/time';
import type { InvoiceDocument } from 'xfactura-core/ubl/invoice-document';
import type { Transaction } from '../db/database';
import { documents, evidence, parties, partyStatuses } from '../db/schema';
import {
  TaxpayerLookupFailed,
  type TaxpayerAnswer,
  type TaxpayerRegistryPort,
  type TaxpayerStatus,
} from '../adapters/anaf-taxpayers';
import { sha256, type ObjectStore } from '../adapters/object-store';
import type { Actor, Commands } from '../kernel/commands';
import type { CloseCheck } from '../kernel/periods';

export const checkStatusInput = z
  .object({
    /** The parties to check, on `date`. */
    partyIds: z.array(z.uuid()).min(1).max(500).optional(),
    date: z.iso.date().optional(),
    /** Instead: the supplier of every purchase invoice dated in the month, on its tax point. */
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.month === undefined
        ? input.partyIds !== undefined && input.date !== undefined
        : input.partyIds === undefined && input.date === undefined,
    { message: 'Indicați fie partenerii și data, fie luna.' },
  );
const statusView = z.object({
  seq: z.number(),
  name: z.string(),
  vatPayer: z.boolean(),
  cashVat: z.boolean(),
  inactive: z.boolean(),
  inactiveSince: z.string().nullable(),
  reactivatedOn: z.string().nullable(),
  splitVat: z.boolean(),
  eInvoice: z.boolean(),
  struckOffOn: z.string().nullable(),
  evidenceId: z.string(),
});
export const checkStatusView = z.object({
  results: z.array(
    z.object({
      partyId: z.string(),
      date: z.string(),
      outcome: z.enum(['checked', 'not_found', 'not_applicable', 'error']),
      /** The standing snapshot for the date, the one a proposal reads. */
      status: statusView.nullable(),
      /** True when this call recorded `status`; false when it stands from an earlier check. */
      recorded: z.boolean(),
      detail: z.string().nullable(),
    }),
  ),
});
type Result = z.infer<typeof checkStatusView>['results'][number];

/** A party on a date; `cui` is null for a party ANAF's registers do not hold. */
type Target = { partyId: string; cui: string | null; date: LocalDate };
type Snapshot = typeof partyStatuses.$inferSelect;

/** What a snapshot says about the party: an answer saying the same changes nothing read. */
const statusFields = [
  'name',
  'vatPayer',
  'cashVat',
  'inactive',
  'inactiveSince',
  'reactivatedOn',
  'splitVat',
  'eInvoice',
  'struckOffOn',
] as const satisfies readonly (keyof TaxpayerStatus)[];
const sameStatus = (snapshot: Snapshot, cui: string, status: TaxpayerStatus) =>
  snapshot.cui === cui &&
  statusFields.every((field) => (snapshot[field] ?? null) === (status[field] ?? null));

/** The parties' (party, date) pairs that have a snapshot, as `partyStatusKey`s. */
async function checkedKeys(tx: Transaction, companyId: string, partyIds: string[]) {
  if (!partyIds.length) return new Set<string>();
  const rows = await tx
    .selectDistinct({ partyId: partyStatuses.partyId, asOf: partyStatuses.asOf })
    .from(partyStatuses)
    .where(
      and(
        eq(partyStatuses.companyId, companyId),
        inArray(partyStatuses.partyId, [...new Set(partyIds)]),
      ),
    );
  return new Set(rows.map((row) => partyStatusKey(row.partyId, row.asOf as LocalDate)));
}

/** The latest snapshot of a party for exactly a date: the one a proposal reads. */
async function standing(tx: Transaction, companyId: string, target: Target) {
  const [row] = await tx
    .select()
    .from(partyStatuses)
    .where(
      and(
        eq(partyStatuses.companyId, companyId),
        eq(partyStatuses.partyId, target.partyId),
        eq(partyStatuses.asOf, target.date),
      ),
    )
    .orderBy(desc(partyStatuses.seq))
    .limit(1);
  return row;
}

/** A snapshot as a result, recorded by this call or standing from an earlier one. */
const resultOf = (
  target: Target,
  snapshot: Snapshot,
  recorded: boolean,
  detail: string | null,
): Result => ({
  partyId: target.partyId,
  date: target.date,
  outcome: 'checked',
  status: {
    seq: snapshot.seq,
    name: snapshot.name,
    vatPayer: snapshot.vatPayer,
    cashVat: snapshot.cashVat,
    inactive: snapshot.inactive,
    inactiveSince: snapshot.inactiveSince,
    reactivatedOn: snapshot.reactivatedOn,
    splitVat: snapshot.splitVat,
    eInvoice: snapshot.eInvoice,
    struckOffOn: snapshot.struckOffOn,
    evidenceId: snapshot.evidenceId,
  },
  recorded,
  detail,
});

/** The CUI of a party established in Romania, as ANAF's registers know it; null otherwise. */
const cuiOf = (party: typeof parties.$inferSelect) =>
  party.country === 'RO' && party.taxId && /^[1-9]\d{1,9}$/.test(party.taxId) ? party.taxId : null;

/** The supplier of each purchase invoice dated in the month, on the invoice's tax point. */
async function monthSuppliers(tx: Transaction, companyId: string, month: string) {
  const rows = await tx
    .select({ id: documents.id, body: documents.body, party: parties })
    .from(documents)
    .innerJoin(
      parties,
      and(eq(parties.companyId, documents.companyId), eq(parties.id, documents.partyId)),
    )
    .where(
      and(
        eq(documents.companyId, companyId),
        eq(documents.kind, invoiceKinds.purchase),
        gte(documents.docDate, monthStart(month as Month)),
        lte(documents.docDate, monthEnd(month as Month)),
      ),
    )
    .orderBy(asc(documents.docDate), asc(documents.id));
  return rows.map((row) => ({
    documentId: row.id,
    partyId: row.party.id,
    cui: cuiOf(row.party),
    date: taxPointOf(JSON.parse(row.body) as InvoiceDocument),
  }));
}

/**
 * ANAF's status of the company's Romanian partners: the registers of taxpayers asked about a
 * party on a date, each answer kept as evidence and each status recorded as a dated snapshot of
 * the party. A purchase reads its supplier's snapshot for its tax point (`invoices.recognize`).
 */
export class PartyStatuses {
  constructor(
    private readonly commands: Commands,
    private readonly objects: ObjectStore,
    private readonly port?: TaxpayerRegistryPort,
    /** Today, for the dates ANAF can answer about. */
    private readonly clock: () => number = Date.now,
  ) {}

  private registry() {
    requireCondition(
      this.port,
      'TAXPAYERS_UNAVAILABLE',
      'Serviciul ANAF de verificare a contribuabililor nu este configurat.',
      503,
    );
    return this.port;
  }

  /**
   * Asks ANAF about each Romanian party on its date and records what it answered. Parties ANAF
   * does not hold (foreign, or without a CUI) are not applicable. When ANAF does not answer at
   * all nothing is recorded and the same key can be retried; when a later request fails, the
   * answers before it are recorded and the rest reported as errors.
   *
   * A snapshot is recorded only when ANAF's answer differs from the standing snapshot for that
   * party and date: a newer snapshot makes the proposals reading it stale, so an answer saying
   * the same leaves them current. ANAF's answer is kept as evidence only when a snapshot cites
   * it. With `month`, the pairs already checked are reported from their snapshot without asking
   * again; `partyIds` with `date` always asks.
   */
  async checkStatus(actor: Actor, key: string, input: z.infer<typeof checkStatusInput>) {
    const port = this.registry();
    const today = bucharestDate(this.clock());
    requireCondition(
      !input.date || input.date <= today,
      'STATUS_DATE',
      'Starea ANAF se verifică pentru o dată care a trecut.',
    );
    const [targets, checked]: [Target[], Set<string>] = await this.commands.db.read(async (tx) => {
      await this.commands.authorize(tx, actor, 'write', 'parties.checkStatus');
      if (input.month) {
        const suppliers = await monthSuppliers(tx, actor.companyId, input.month);
        const partyIds = suppliers.filter((item) => item.cui).map((item) => item.partyId);
        return [suppliers, await checkedKeys(tx, actor.companyId, partyIds)];
      }
      const rows = await tx
        .select()
        .from(parties)
        .where(and(eq(parties.companyId, actor.companyId), inArray(parties.id, input.partyIds!)));
      requireCondition(
        rows.length === new Set(input.partyIds).size,
        'NOT_FOUND',
        'Partenerul nu este disponibil.',
        404,
      );
      const named = input.partyIds!.map((partyId) => ({
        partyId,
        cui: cuiOf(rows.find((row) => row.id === partyId)!),
        date: input.date as LocalDate,
      }));
      return [named, new Set<string>()];
    });
    const unique = [
      ...new Map(
        targets.map((target) => [partyStatusKey(target.partyId, target.date), target]),
      ).values(),
    ];
    const asked = unique.filter(
      (target) =>
        target.cui &&
        target.date <= today &&
        !checked.has(partyStatusKey(target.partyId, target.date)),
    );
    let answers: readonly TaxpayerAnswer[] = [];
    let failure: string | null = null;
    if (asked.length)
      try {
        answers = await port.lookup(
          asked.map((target) => ({ cui: target.cui!, date: target.date })),
        );
      } catch (error) {
        if (!(error instanceof TaxpayerLookupFailed)) throw error;
        requireCondition(
          error.answered.length,
          'TAXPAYERS_UNAVAILABLE',
          `Serviciul ANAF nu a dat un răspuns utilizabil: ${error.message}`,
          503,
        );
        answers = error.answered;
        failure = error.message;
      }
    const stamp = new Date(this.clock()).toISOString().replace(/[-:]|\.\d+/g, '');
    return this.commands.run(actor, key, 'parties.checkStatus', input, 'write', async (tx) => {
      const answered = new Map<string, Result>();
      for (const [index, answer] of answers.entries()) {
        // Kept with the first snapshot recorded from it: an answer nothing cites is not kept.
        let evidenceId: string | null = null;
        for (const result of answer.results)
          for (const target of asked.filter(
            (item) => item.cui === result.cui && item.date === result.date,
          )) {
            const id = partyStatusKey(target.partyId, target.date);
            if (!result.status) {
              answered.set(id, {
                partyId: target.partyId,
                date: target.date,
                outcome: 'not_found',
                status: null,
                recorded: false,
                detail: `ANAF nu găsește CUI ${target.cui} în registrele sale.`,
              });
              continue;
            }
            const last = await standing(tx, actor.companyId, target);
            if (last && sameStatus(last, target.cui!, result.status)) {
              answered.set(
                id,
                resultOf(
                  target,
                  last,
                  false,
                  `ANAF răspunde la fel ca la verificarea înregistrată pentru ${target.date}: starea rămâne cea înregistrată, fără o stare nouă.`,
                ),
              );
              continue;
            }
            evidenceId ??= await this.keep(
              tx,
              actor,
              answer.raw,
              `anaf-registre-${stamp}-${index + 1}.json`,
            );
            answered.set(id, await this.record(tx, actor, target, result.status, evidenceId));
          }
      }
      const results: Result[] = [];
      for (const target of unique) {
        const id = partyStatusKey(target.partyId, target.date);
        const done = answered.get(id);
        if (done) {
          results.push(done);
          continue;
        }
        const last = target.cui && checked.has(id) && (await standing(tx, actor.companyId, target));
        if (last) {
          results.push(
            resultOf(
              target,
              last,
              false,
              `Starea la ${target.date} este deja verificată; ANAF nu a fost întrebat din nou (o verificare din nou: parties.checkStatus cu partyIds și date).`,
            ),
          );
          continue;
        }
        const [outcome, detail]: [Result['outcome'], string] = !target.cui
          ? [
              'not_applicable',
              'Registrele ANAF cuprind doar partenerii stabiliți în România, cu CUI.',
            ]
          : target.date > today
            ? ['error', `Starea la ${target.date} se verifică după această dată.`]
            : ['error', failure ?? 'ANAF nu a răspuns.'];
        results.push({
          partyId: target.partyId,
          date: target.date,
          outcome,
          status: null,
          recorded: false,
          detail,
        });
      }
      return { results };
    });
  }

  /** A status as the party's next snapshot. */
  private async record(
    tx: Transaction,
    actor: Actor,
    target: Target,
    status: TaxpayerStatus,
    evidenceId: string,
  ): Promise<Result> {
    const [last] = await tx
      .select({ seq: partyStatuses.seq })
      .from(partyStatuses)
      .where(
        and(
          eq(partyStatuses.companyId, actor.companyId),
          eq(partyStatuses.partyId, target.partyId),
        ),
      )
      .orderBy(desc(partyStatuses.seq))
      .limit(1);
    const seq = (last?.seq ?? 0) + 1;
    await tx.insert(partyStatuses).values({
      companyId: actor.companyId,
      partyId: target.partyId,
      seq,
      cui: target.cui!,
      asOf: target.date,
      ...status,
      evidenceId,
      createdBy: actor.actorId,
    });
    return {
      partyId: target.partyId,
      date: target.date,
      outcome: 'checked',
      status: { seq, ...status, evidenceId },
      recorded: true,
      detail: null,
    };
  }

  /** ANAF's answer as it was received, content-addressed like every original. */
  private async keep(tx: Transaction, actor: Actor, bytes: Uint8Array, filename: string) {
    const hash = sha256(bytes);
    const [stored] = await tx
      .select({ id: evidence.id })
      .from(evidence)
      .where(and(eq(evidence.companyId, actor.companyId), eq(evidence.hash, hash)));
    if (stored) return stored.id;
    await this.objects.put(actor.companyId, bytes, 64 * 1024 * 1024);
    const id = this.commands.ids();
    await tx.insert(evidence).values({
      id,
      companyId: actor.companyId,
      hash,
      filename,
      mediaType: 'application/json',
      size: bytes.length,
      createdBy: actor.actorId,
      engineAt: this.commands.clock(),
    });
    return id;
  }
}

/** Month-close warning: purchases whose Romanian supplier was not checked for their tax point. */
export const partyStatusChecks: CloseCheck[] = [
  {
    id: 'parties.status',
    async run(tx, companyId, month) {
      const purchases = (await monthSuppliers(tx, companyId, month)).filter((item) => item.cui);
      if (!purchases.length) return [];
      const checked = await checkedKeys(
        tx,
        companyId,
        purchases.map((item) => item.partyId),
      );
      const unchecked = purchases.filter(
        (item) => !checked.has(partyStatusKey(item.partyId, item.date)),
      );
      return unchecked.length
        ? [
            {
              code: 'SUPPLIER_STATUS_UNCHECKED',
              severity: 'warn' as const,
              message: `${unchecked.length} facturi de achiziție din ${month} au furnizori din România a căror stare la ANAF (inclusiv inactivitatea, art. 11 alin. (7) din Codul fiscal) nu a fost verificată la data facturii (parties.checkStatus).`,
              count: unchecked.length,
              items: unchecked.slice(0, 20).map((item) => item.documentId),
            },
          ]
        : [];
    },
  },
];
