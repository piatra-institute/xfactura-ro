import { randomUUID } from 'node:crypto';
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
      status: statusView.nullable(),
      detail: z.string().nullable(),
    }),
  ),
});
type Result = z.infer<typeof checkStatusView>['results'][number];

/** A party on a date; `cui` is null for a party ANAF's registers do not hold. */
type Target = { partyId: string; cui: string | null; date: LocalDate };

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
   */
  async checkStatus(actor: Actor, key: string, input: z.infer<typeof checkStatusInput>) {
    const port = this.registry();
    const today = bucharestDate(this.clock());
    requireCondition(
      !input.date || input.date <= today,
      'STATUS_DATE',
      'Starea ANAF se verifică pentru o dată care a trecut.',
    );
    const targets: Target[] = await this.commands.db.read(async (tx) => {
      await this.commands.authorize(tx, actor, 'write', 'parties.checkStatus');
      if (input.month) return monthSuppliers(tx, actor.companyId, input.month);
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
      return input.partyIds!.map((partyId) => ({
        partyId,
        cui: cuiOf(rows.find((row) => row.id === partyId)!),
        date: input.date as LocalDate,
      }));
    });
    const unique = [
      ...new Map(
        targets.map((target) => [partyStatusKey(target.partyId, target.date), target]),
      ).values(),
    ];
    const asked = unique.filter((target) => target.cui && target.date <= today);
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
      const recorded = new Map<string, Result>();
      for (const [index, answer] of answers.entries()) {
        const evidenceId = await this.keep(
          tx,
          actor,
          answer.raw,
          `anaf-registre-${stamp}-${index + 1}.json`,
        );
        for (const result of answer.results)
          for (const target of asked.filter(
            (item) => item.cui === result.cui && item.date === result.date,
          ))
            recorded.set(
              partyStatusKey(target.partyId, target.date),
              result.status
                ? await this.record(tx, actor, target, result.status, evidenceId)
                : {
                    partyId: target.partyId,
                    date: target.date,
                    outcome: 'not_found',
                    status: null,
                    detail: `ANAF nu găsește CUI ${target.cui} în registrele sale.`,
                  },
            );
      }
      const results = unique.map((target): Result => {
        const done = recorded.get(partyStatusKey(target.partyId, target.date));
        if (done) return done;
        const [outcome, detail]: [Result['outcome'], string] = !target.cui
          ? [
              'not_applicable',
              'Registrele ANAF cuprind doar partenerii stabiliți în România, cu CUI.',
            ]
          : target.date > today
            ? ['error', `Starea la ${target.date} se verifică după această dată.`]
            : ['error', failure ?? 'ANAF nu a răspuns.'];
        return { partyId: target.partyId, date: target.date, outcome, status: null, detail };
      });
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
    const id = randomUUID();
    await tx.insert(evidence).values({
      id,
      companyId: actor.companyId,
      hash,
      filename,
      mediaType: 'application/json',
      size: bytes.length,
      createdBy: actor.actorId,
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
      const checked = new Set(
        (
          await tx
            .selectDistinct({ partyId: partyStatuses.partyId, asOf: partyStatuses.asOf })
            .from(partyStatuses)
            .where(
              and(
                eq(partyStatuses.companyId, companyId),
                inArray(partyStatuses.partyId, [...new Set(purchases.map((item) => item.partyId))]),
              ),
            )
        ).map((row) => partyStatusKey(row.partyId, row.asOf as LocalDate)),
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
