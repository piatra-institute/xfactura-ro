import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Transaction } from './db';
import { Commands, type Actor } from './commands';
import {
  canonical,
  dateSchema,
  fromBani,
  generalBodySchema,
  idSchema,
  requireCondition,
  toBani,
} from './domain';
import {
  invoiceCredits,
  invoiceDocuments,
  invoicePostings,
  invoiceSettlements,
  journals,
  movements,
  proposals,
} from './schema';
import { sha256 } from './object-store';

export const positionQuery = z
  .object({
    date: dateSchema,
    direction: z.enum(['purchase', 'sale']).optional(),
    onlyOpen: z.boolean().default(true),
    limit: z.number().int().min(1).max(100).default(25),
    cursor: idSchema.optional(),
  })
  .strict();
export const positionRead = z.object({ invoiceId: idSchema, date: dateSchema }).strict();

export async function loadInvoicePositions(tx: Transaction, companyId: string, ids: string[]) {
  if (ids.length === 0) return [];
  const roots = await tx
    .select({ invoice: invoiceDocuments, proposal: proposals, journal: journals })
    .from(invoicePostings)
    .innerJoin(
      invoiceDocuments,
      and(
        eq(invoiceDocuments.companyId, invoicePostings.companyId),
        eq(invoiceDocuments.id, invoicePostings.invoiceId),
      ),
    )
    .innerJoin(
      journals,
      and(
        eq(journals.companyId, invoicePostings.companyId),
        eq(journals.id, invoicePostings.journalId),
      ),
    )
    .innerJoin(
      proposals,
      and(
        eq(proposals.companyId, invoicePostings.companyId),
        eq(proposals.id, invoicePostings.proposalId),
      ),
    )
    .where(and(eq(invoicePostings.companyId, companyId), inArray(invoicePostings.invoiceId, ids)));
  const credits = await tx
    .select({ record: invoiceCredits, date: journals.date })
    .from(invoiceCredits)
    .innerJoin(
      journals,
      and(
        eq(journals.companyId, invoiceCredits.companyId),
        eq(journals.id, invoiceCredits.journalId),
      ),
    )
    .where(
      and(eq(invoiceCredits.companyId, companyId), inArray(invoiceCredits.originalInvoiceId, ids)),
    )
    .orderBy(asc(journals.date), asc(invoiceCredits.creditInvoiceId));
  const payments = await tx
    .select({ record: invoiceSettlements, date: movements.date })
    .from(invoiceSettlements)
    .innerJoin(
      movements,
      and(
        eq(movements.companyId, invoiceSettlements.companyId),
        eq(movements.id, invoiceSettlements.movementId),
      ),
    )
    .where(
      and(eq(invoiceSettlements.companyId, companyId), inArray(invoiceSettlements.invoiceId, ids)),
    )
    .orderBy(asc(movements.date), asc(invoiceSettlements.movementId));
  return roots.map((root) => {
    const treatment = generalBodySchema.parse(root.proposal.body).invoice;
    requireCondition(
      root.invoice.body.documentType === 'invoice' && treatment && !treatment.credit,
      'INVOICE_POSITION',
      'Poziția trebuie să provină dintr-o factură contabilizată.',
    );
    const ownCredits = credits.filter((row) => row.record.originalInvoiceId === root.invoice.id);
    const ownPayments = payments.filter((row) => row.record.invoiceId === root.invoice.id);
    const events = [
      ...ownCredits.map(({ record, date }) => ({
        id: record.creditInvoiceId,
        kind: 'credit' as const,
        date,
        amount: record.grossBani,
      })),
      ...ownPayments.map(({ record, date }) => ({
        id: record.movementId,
        kind: 'settlement' as const,
        date,
        amount: record.clearedBani,
      })),
    ].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    const hash = sha256(
      canonical({
        invoiceHash: root.invoice.hash,
        proposalHash: root.proposal.hash,
        journalId: root.journal.id,
        events: events.map((event) => ({ ...event, amount: event.amount.toString() })),
      }),
    );
    return { ...root, treatment, credits: ownCredits, payments: ownPayments, events, hash };
  });
}
export type InvoicePositionState = Awaited<ReturnType<typeof loadInvoicePositions>>[number];

export async function invoicePosition(tx: Transaction, companyId: string, invoiceId: string) {
  const [state] = await loadInvoicePositions(tx, companyId, [invoiceId]);
  requireCondition(
    state,
    'POSTING_REQUIRED',
    'Factura trebuie să fie contabilizată înainte de alocare sau corecție.',
  );
  return state;
}
export function positionView(state: InvoicePositionState, date: string) {
  const credited = state.credits
    .filter((row) => row.date <= date)
    .reduce((sum, row) => sum + row.record.grossBani, 0n);
  const settled = state.payments
    .filter((row) => row.date <= date)
    .reduce((sum, row) => sum + row.record.clearedBani, 0n);
  const balance = toBani(state.treatment.gross) - credited - settled;
  return {
    invoiceId: state.invoice.id,
    number: state.invoice.body.number,
    direction: state.invoice.direction,
    date,
    issueDate: state.invoice.body.issueDate,
    recognitionDate: state.journal.date,
    currency: state.invoice.body.currency,
    counterparty:
      state.invoice.direction === 'sale'
        ? state.invoice.body.customer
        : state.invoice.body.supplier,
    originalJournalId: state.journal.id,
    gross: state.treatment.gross,
    credited: fromBani(credited),
    settled: fromBani(settled),
    balance: fromBani(balance),
    status:
      balance > 0n
        ? ('open' as const)
        : balance < 0n
          ? ('refund_due' as const)
          : ('settled' as const),
    hash: state.hash,
  };
}

/** Also considers future recorded activity, so backdating cannot allocate an invoice twice. */
export function settlementCapacity(state: InvoicePositionState, date: string) {
  let balance = toBani(positionView(state, date).balance);
  const positive = balance > 0n;
  let capacity = positive ? balance : -balance;
  const dates = [
    ...new Set(state.events.filter((event) => event.date > date).map((event) => event.date)),
  ];
  for (const nextDate of dates) {
    balance -= state.events
      .filter((event) => event.date === nextDate)
      .reduce((sum, event) => sum + event.amount, 0n);
    const available = positive ? balance : -balance;
    if (available < capacity) capacity = available;
  }
  return capacity > 0n ? (positive ? capacity : -capacity) : 0n;
}
export function creditSnapshot(state: InvoicePositionState) {
  return sha256(
    canonical(
      state.credits.map(({ record }) => ({
        id: record.creditInvoiceId,
        journalId: record.journalId,
        net: record.netBani.toString(),
        tax: record.taxBani.toString(),
        gross: record.grossBani.toString(),
      })),
    ),
  );
}

export class InvoicePositions {
  constructor(private readonly runner: Commands) {}
  read(actor: Actor, input: unknown) {
    const body = positionRead.parse(input);
    return this.runner.read(
      actor,
      async (tx) => {
        const state = await invoicePosition(tx, actor.companyId, body.invoiceId);
        requireCondition(
          state.journal.date <= body.date,
          'POSITION_DATE',
          'Data precedă înregistrarea facturii.',
        );
        return positionView(state, body.date);
      },
      'positions.get',
    );
  }
  list(actor: Actor, input: unknown) {
    const body = positionQuery.parse(input);
    return this.runner.read(
      actor,
      async (tx) => {
        const credited = tx
          .select({ amount: sql`coalesce(sum(${invoiceCredits.grossBani}),0)` })
          .from(invoiceCredits)
          .innerJoin(
            journals,
            and(
              eq(journals.companyId, invoiceCredits.companyId),
              eq(journals.id, invoiceCredits.journalId),
            ),
          )
          .where(
            and(
              eq(invoiceCredits.companyId, invoiceDocuments.companyId),
              eq(invoiceCredits.originalInvoiceId, invoiceDocuments.id),
              lte(journals.date, body.date),
            ),
          );
        const settled = tx
          .select({ amount: sql`coalesce(sum(${invoiceSettlements.clearedBani}),0)` })
          .from(invoiceSettlements)
          .innerJoin(
            movements,
            and(
              eq(movements.companyId, invoiceSettlements.companyId),
              eq(movements.id, invoiceSettlements.movementId),
            ),
          )
          .where(
            and(
              eq(invoiceSettlements.companyId, invoiceDocuments.companyId),
              eq(invoiceSettlements.invoiceId, invoiceDocuments.id),
              lte(movements.date, body.date),
            ),
          );
        const outstanding = sql`cast(replace(json_extract(${proposals.body}, '$.invoice.gross'), '.', '') as integer) - (${credited}) - (${settled})`;
        const rows = await tx
          .select({ id: invoiceDocuments.id })
          .from(invoiceDocuments)
          .innerJoin(
            invoicePostings,
            and(
              eq(invoicePostings.companyId, invoiceDocuments.companyId),
              eq(invoicePostings.invoiceId, invoiceDocuments.id),
            ),
          )
          .innerJoin(
            proposals,
            and(
              eq(proposals.companyId, invoicePostings.companyId),
              eq(proposals.id, invoicePostings.proposalId),
            ),
          )
          .innerJoin(
            journals,
            and(
              eq(journals.companyId, invoicePostings.companyId),
              eq(journals.id, invoicePostings.journalId),
            ),
          )
          .where(
            and(
              eq(invoiceDocuments.companyId, actor.companyId),
              sql`json_extract(${invoiceDocuments.body}, '$.documentType')='invoice'`,
              lte(journals.date, body.date),
              body.cursor ? gt(invoiceDocuments.id, body.cursor) : undefined,
              body.direction ? eq(invoiceDocuments.direction, body.direction) : undefined,
              body.onlyOpen ? sql`${outstanding}<>0` : undefined,
            ),
          )
          .orderBy(asc(invoiceDocuments.id))
          .limit(body.limit + 1);
        const states = await loadInvoicePositions(
          tx,
          actor.companyId,
          rows.slice(0, body.limit).map((row) => row.id),
        );
        const byId = new Map(states.map((state) => [state.invoice.id, state]));
        return {
          items: rows.slice(0, body.limit).map((row) => positionView(byId.get(row.id)!, body.date)),
          nextCursor: rows.length > body.limit ? rows[body.limit - 1].id : null,
        };
      },
      'positions.list',
    );
  }
}
