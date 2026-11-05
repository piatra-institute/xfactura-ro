import { and, asc, desc, eq, gt, like, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { formatQuantity, parseQuantity } from 'xfactura-core/kernel';
import { formatMoney, parseMoney } from 'xfactura-core/money';
import { orderTag } from 'xfactura-core/ro/production';
import type { Transaction } from '../db/database';
import {
  bomLines,
  boms,
  entries,
  evidence,
  lines,
  proposals,
  proposalVersions,
  stockItems,
  stockMoves,
  workOrderEvents,
  workOrders,
} from '../db/schema';
import { appendAudit, type Actor, type Commands } from '../kernel/commands';
import { entryStands } from '../kernel/ledger';
import type { CloseCheck, Finding } from '../kernel/periods';

/*
 * Production (G4): the bills of materials, versioned and dated, and the work orders with their
 * closing, kept as recorded (append-only, guarded by the database); each order's cost sheet read
 * from the lines its postings tagged; and the month close's checks: the work in progress taken
 * back at the month's start, the month's costing, the price differences spread over the exits.
 * What reaches the books is the treatments' (core ro/production).
 */

const day = z.iso.date();
const lei = (bani: bigint) => formatMoney(bani, 'RON');
/** The reversal proposal of an entry, and the line of the entry it reverses. */
const reversal = alias(proposals, 'production_reversal');
const reversedLine = alias(lines, 'production_reversed_line');
const quantity = z
  .string()
  .regex(/^(0|[1-9]\d{0,14})(\.\d{1,3})?$/)
  .refine((value) => (parseQuantity(value) ?? 0n) > 0n, 'Cantitatea este pozitivă.');
const hours = z.string().regex(/^(0|[1-9]\d{0,6})(\.\d{1,3})?$/);
const amount = z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/);

/** The product accounts a BOM may make (residual products have none) and the materials it takes. */
const productAccounts = ['341', '345'];
const materialAccounts = ['301', '302', '303', '381'];
const under = (account: string, prefixes: readonly string[]) =>
  prefixes.some((prefix) => account.startsWith(prefix));

export const bomInput = z
  .object({
    /** The product: an item of the catalogue on 341 or 345. */
    itemId: z.uuid(),
    validFrom: day,
    /** The quantity of product the norms are for, in its unit. */
    outputQuantity: quantity,
    /** The standard cost of the output quantity, in lei (pct. 286 alin. (2)). */
    standardCost: amount.optional(),
    labourHours: hours.optional(),
    machineHours: hours.optional(),
    /** The technical sheet, or the standard cost's calculation. */
    evidenceId: z.uuid(),
    lines: z
      .array(z.object({ itemId: z.uuid(), quantity }).strict())
      .min(1)
      .max(200),
  })
  .strict();
export const bomView = z.object({
  id: z.string(),
  itemId: z.string(),
  version: z.number(),
  validFrom: z.string(),
  outputQuantity: z.string(),
  standardCost: z.string().nullable(),
  labourHours: z.string().nullable(),
  machineHours: z.string().nullable(),
  evidenceId: z.string(),
  lines: z.array(z.object({ lineNo: z.number(), itemId: z.string(), quantity: z.string() })),
});

export const orderInput = z
  .object({
    number: z.string().trim().min(1).max(40),
    /** The product, which must have a BOM version valid on the opening day. */
    itemId: z.uuid(),
    quantity,
    openedOn: day,
    /** The work order (fișa de lansare). */
    evidenceId: z.uuid(),
  })
  .strict();
export const orderView = z.object({
  id: z.string(),
  number: z.string(),
  itemId: z.string(),
  bomId: z.string(),
  bomVersion: z.number(),
  quantity: z.string(),
  openedOn: z.string(),
  closedOn: z.string().nullable(),
});
export const closeOrderInput = z
  .object({
    orderId: z.uuid(),
    /** The last day of its production: no consumption or hand-over after it. */
    date: day,
    evidenceId: z.uuid(),
  })
  .strict();
export const costSheetInput = z.object({ orderId: z.uuid() }).strict();
export const costSheetView = z.object({
  order: orderView,
  months: z.array(
    z.object({
      month: z.string(),
      materials: z.string(),
      labour: z.string().nullable(),
      overheads: z.string().nullable(),
      outputs: z.string(),
      outputQuantity: z.string(),
      residual: z.string(),
      wip: z.string(),
      differences: z.string(),
    }),
  ),
});

const bomOf = (row: typeof boms.$inferSelect, rows: (typeof bomLines.$inferSelect)[]) => ({
  id: row.id,
  itemId: row.itemId,
  version: row.version,
  validFrom: row.validFrom,
  outputQuantity: formatQuantity(row.outputQuantity),
  standardCost: row.standardCost === null ? null : lei(row.standardCost),
  labourHours: row.labourHours === null ? null : formatQuantity(row.labourHours),
  machineHours: row.machineHours === null ? null : formatQuantity(row.machineHours),
  evidenceId: row.evidenceId,
  lines: rows
    .filter((line) => line.bomId === row.id)
    .sort((a, b) => a.lineNo - b.lineNo)
    .map((line) => ({
      lineNo: line.lineNo,
      itemId: line.itemId,
      quantity: formatQuantity(line.quantity),
    })),
});

async function evidenceExists(tx: Transaction, companyId: string, id: string) {
  const [row] = await tx
    .select({ id: evidence.id })
    .from(evidence)
    .where(and(eq(evidence.companyId, companyId), eq(evidence.id, id)));
  return !!row;
}

async function orderViews(tx: Transaction, companyId: string, orderId?: string) {
  const rows = await tx
    .select({ order: workOrders, version: boms.version })
    .from(workOrders)
    .innerJoin(boms, and(eq(boms.companyId, workOrders.companyId), eq(boms.id, workOrders.bomId)))
    .where(
      and(eq(workOrders.companyId, companyId), ...(orderId ? [eq(workOrders.id, orderId)] : [])),
    )
    .orderBy(asc(workOrders.number));
  const closed = new Map(
    (
      await tx
        .select({ orderId: workOrderEvents.orderId, date: workOrderEvents.date })
        .from(workOrderEvents)
        .where(and(eq(workOrderEvents.companyId, companyId), eq(workOrderEvents.kind, 'closed')))
    ).map((row) => [row.orderId, row.date]),
  );
  return rows.map(({ order, version }) => ({
    id: order.id,
    number: order.number,
    itemId: order.itemId,
    bomId: order.bomId,
    bomVersion: version,
    quantity: formatQuantity(order.quantity),
    openedOn: order.openedOn,
    closedOn: closed.get(order.id) ?? null,
  }));
}

/** Whether a posting of `subject` stands in the company. */
async function stands(tx: Transaction, companyId: string, subject: string) {
  const [row] = await tx
    .select({ id: entries.id })
    .from(entries)
    .innerJoin(
      proposals,
      and(eq(proposals.companyId, entries.companyId), eq(proposals.id, entries.proposalId)),
    )
    .where(
      and(
        eq(entries.companyId, companyId),
        eq(proposals.subjectKey, subject),
        entryStands('"acc_entries"'),
      ),
    )
    .limit(1);
  return !!row;
}

const monthBounds = (month: string) => {
  const start = `${month}-01`;
  const end = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0))
    .toISOString()
    .slice(0, 10);
  const previous = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 0))
    .toISOString()
    .slice(0, 10);
  return { start, end, previous };
};

/**
 * The month close (G4): the work in progress the previous month's costing left must be taken back
 * on the month's first day (the function of 331); a month with production postings or work in
 * progress needs its costing (pct. 8 pct. 7, 288); at the standard cost, products that left the
 * warehouse take their share of the price differences (pct. 286 alin. (4)).
 */
export const productionChecks: CloseCheck[] = [
  {
    id: 'production.register',
    async run(tx, companyId, month) {
      const [order] = await tx
        .select({ id: workOrders.id })
        .from(workOrders)
        .where(eq(workOrders.companyId, companyId))
        .limit(1);
      if (!order) return [];
      const { start, end, previous } = monthBounds(month);
      const findings: Finding[] = [];
      // Work in progress (331) held on the month's first day, from before it.
      const [held] = await tx
        .select({ quantity: sql<bigint>`coalesce(sum(${stockMoves.quantity}), 0)`.mapWith(BigInt) })
        .from(stockMoves)
        .innerJoin(
          entries,
          and(eq(entries.companyId, stockMoves.companyId), eq(entries.id, stockMoves.entryId)),
        )
        .where(
          and(
            eq(stockMoves.companyId, companyId),
            like(stockMoves.account, '331%'),
            lte(entries.date, start),
          ),
        );
      const [carried] = await tx
        .select({ count: sql<number>`count(*)`.mapWith(Number) })
        .from(lines)
        .innerJoin(
          entries,
          and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId)),
        )
        .where(
          and(
            eq(lines.companyId, companyId),
            like(lines.account, '331%'),
            like(lines.item, 'production:order:%'),
            eq(entries.date, previous),
          ),
        );
      if ((held?.quantity ?? 0n) > 0n && carried!.count > 0)
        findings.push({
          code: 'PRODUCTION_WIP_REVERSAL_MISSING',
          severity: 'block',
          message: `Producția în curs de la sfârșitul lunii precedente nu este scăzută din gestiune la ${start} (funcțiunea contului 331): production.wipReverse.`,
          items: [month],
        });
      // Production postings of the month, or work in progress carried into it, need the costing.
      const [active] = await tx
        .select({ count: sql<number>`count(*)`.mapWith(Number) })
        .from(lines)
        .innerJoin(
          entries,
          and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId)),
        )
        .where(
          and(
            eq(lines.companyId, companyId),
            like(lines.item, 'production:order:%'),
            sql`(${entries.date} between ${start} and ${end} or (${entries.date} = ${previous} and ${lines.account} like '331%'))`,
          ),
        );
      if (active!.count > 0 && !(await stands(tx, companyId, `production:cost:${month}`)))
        findings.push({
          code: 'PRODUCTION_COST_MISSING',
          severity: 'block',
          message: `Luna ${month} are consumuri, predări sau producție în curs pe comenzi fără calculația costurilor (production.cost): manopera și regia de producție nu sunt repartizate, producția în curs nu este evaluată.`,
          count: active!.count,
          items: [month],
        });
      // At the standard cost: products left the warehouse while 348 holds differences.
      const [differences] = await tx
        .select({ count: sql<number>`count(*)`.mapWith(Number) })
        .from(lines)
        .innerJoin(
          entries,
          and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId)),
        )
        .where(
          and(eq(lines.companyId, companyId), like(lines.account, '348%'), lte(entries.date, end)),
        );
      if (differences!.count > 0) {
        // The month's exits: the credits of 341 and 345, a reversal on the side of what it
        // reverses (a hand-over reversed in black is not an exit; a sale and its storno net out),
        // as `production.differences` reads them.
        const side = sql`coalesce(${reversedLine.side}, ${lines.side})`;
        const [exits] = await tx
          .select({
            count: sql<number>`coalesce(sum(CASE WHEN ${side} = 'C' THEN 1 ELSE 0 END), 0)`.mapWith(
              Number,
            ),
            bani: sql<bigint>`coalesce(sum(CASE WHEN ${side} = 'C'
              THEN CASE WHEN ${lines.side} = 'C' THEN ${lines.bani} ELSE -${lines.bani} END
              ELSE 0 END), 0)`.mapWith(BigInt),
          })
          .from(lines)
          .innerJoin(
            entries,
            and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId)),
          )
          .leftJoin(
            reversal,
            and(
              eq(reversal.companyId, entries.companyId),
              eq(reversal.id, entries.proposalId),
              sql`substr(${reversal.subjectKey}, 1, 8) = 'reverse:'`,
            ),
          )
          .leftJoin(
            reversedLine,
            and(
              eq(reversedLine.companyId, lines.companyId),
              sql`${reversedLine.entryId} = substr(${reversal.subjectKey}, 9)`,
              eq(reversedLine.lineNo, lines.lineNo),
            ),
          )
          .where(
            and(
              eq(lines.companyId, companyId),
              sql`(${lines.account} like '341%' or ${lines.account} like '345%')`,
              sql`${entries.date} between ${start} and ${end}`,
            ),
          );
        if (exits!.bani !== 0n && !(await stands(tx, companyId, `production:differences:${month}`)))
          findings.push({
            code: 'PRODUCTION_DIFFERENCES_MISSING',
            severity: 'block',
            message: `Produse ieșite din gestiune în ${month} fără diferențele de preț repartizate (pct. 286 alin. (4)): production.differences.`,
            count: exits!.count,
            items: [month],
          });
      }
      return findings;
    },
  },
];

/** The bills of materials, the work orders and their cost sheets. */
export class Production {
  constructor(private readonly commands: Commands) {}

  recordBom(actor: Actor, key: string, input: z.infer<typeof bomInput>) {
    return this.commands.run(actor, key, 'production.boms.record', input, 'write', async (tx) => {
      requireCondition(
        await evidenceExists(tx, actor.companyId, input.evidenceId),
        'EVIDENCE',
        'Fișa tehnică nu este disponibilă.',
        404,
      );
      const ids = [input.itemId, ...input.lines.map((line) => line.itemId)];
      const items = new Map(
        (await tx.select().from(stockItems).where(eq(stockItems.companyId, actor.companyId)))
          .filter((row) => ids.includes(row.id))
          .map((row) => [row.id, row]),
      );
      const product = items.get(input.itemId);
      requireCondition(product, 'NOT_FOUND', 'Produsul nu există în nomenclator.', 404);
      requireCondition(
        under(product.account, productAccounts),
        'BOM_PRODUCT',
        `${product.code} este în ${product.account}: o fișă tehnică descrie un semifabricat (341) sau un produs finit (345).`,
        422,
      );
      input.lines.forEach((line, index) => {
        const item = items.get(line.itemId);
        requireCondition(item, 'NOT_FOUND', `Materialul de pe linia ${index + 1} nu există.`, 404);
        requireCondition(
          under(item.account, materialAccounts),
          'BOM_MATERIAL',
          `${item.code} este în ${item.account}: o fișă tehnică cuprinde materii prime, materiale și ambalaje (301, 302, 303, 381).`,
          422,
        );
      });
      requireCondition(
        new Set(input.lines.map((line) => line.itemId)).size === input.lines.length,
        'BOM_DUPLICATE',
        'Un material apare de mai multe ori.',
        422,
      );
      const [latest] = await tx
        .select()
        .from(boms)
        .where(and(eq(boms.companyId, actor.companyId), eq(boms.itemId, input.itemId)))
        .orderBy(desc(boms.version))
        .limit(1);
      requireCondition(
        !latest || latest.validFrom < input.validFrom,
        'BOM_DATE',
        `Versiunea ${latest?.version} a fișei este valabilă din ${latest?.validFrom}: o revizie începe după ea.`,
        409,
      );
      const id = this.commands.ids();
      const row = {
        id,
        companyId: actor.companyId,
        itemId: input.itemId,
        version: (latest?.version ?? 0) + 1,
        validFrom: input.validFrom,
        outputQuantity: parseQuantity(input.outputQuantity)!,
        standardCost:
          input.standardCost === undefined ? null : parseMoney(input.standardCost, 'RON'),
        labourHours: input.labourHours === undefined ? null : parseQuantity(input.labourHours)!,
        machineHours: input.machineHours === undefined ? null : parseQuantity(input.machineHours)!,
        evidenceId: input.evidenceId,
        createdBy: actor.actorId,
      };
      await tx.insert(boms).values(row);
      const lineRows = input.lines.map((line, index) => ({
        companyId: actor.companyId,
        bomId: id,
        lineNo: index + 1,
        itemId: line.itemId,
        quantity: parseQuantity(line.quantity)!,
      }));
      await tx.insert(bomLines).values(lineRows);
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.actorId,
        ...(actor.agentId ? { agentId: actor.agentId } : {}),
        action: 'production.boms.record',
        body: { id, itemId: input.itemId, version: row.version },
      });
      return bomOf({ ...row, createdAt: '' }, lineRows);
    });
  }

  listBoms(actor: Actor) {
    return this.commands.read(actor, 'production.boms.list', async (tx) => {
      const rows = await tx
        .select()
        .from(boms)
        .where(eq(boms.companyId, actor.companyId))
        .orderBy(asc(boms.itemId), asc(boms.version));
      const lineRows = await tx
        .select()
        .from(bomLines)
        .where(eq(bomLines.companyId, actor.companyId));
      return { items: rows.map((row) => bomOf(row, lineRows)), next: null };
    });
  }

  openOrder(actor: Actor, key: string, input: z.infer<typeof orderInput>) {
    return this.commands.run(actor, key, 'production.orders.open', input, 'write', async (tx) => {
      requireCondition(
        await evidenceExists(tx, actor.companyId, input.evidenceId),
        'EVIDENCE',
        'Comanda de producție nu este disponibilă.',
        404,
      );
      const [bom] = await tx
        .select()
        .from(boms)
        .where(
          and(
            eq(boms.companyId, actor.companyId),
            eq(boms.itemId, input.itemId),
            lte(boms.validFrom, input.openedOn),
          ),
        )
        .orderBy(desc(boms.version))
        .limit(1);
      requireCondition(
        bom,
        'BOM_MISSING',
        `Produsul nu are o fișă tehnică valabilă la ${input.openedOn}: înregistrați-o întâi (production.boms.record).`,
        422,
      );
      const [existing] = await tx
        .select({ id: workOrders.id })
        .from(workOrders)
        .where(and(eq(workOrders.companyId, actor.companyId), eq(workOrders.number, input.number)));
      requireCondition(!existing, 'ORDER_EXISTS', `Comanda ${input.number} există deja.`, 409, {
        orderId: existing?.id ?? null,
      });
      const id = this.commands.ids();
      await tx.insert(workOrders).values({
        id,
        companyId: actor.companyId,
        number: input.number,
        itemId: input.itemId,
        bomId: bom.id,
        quantity: parseQuantity(input.quantity)!,
        openedOn: input.openedOn,
        evidenceId: input.evidenceId,
        createdBy: actor.actorId,
      });
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.actorId,
        ...(actor.agentId ? { agentId: actor.agentId } : {}),
        action: 'production.orders.open',
        body: { id, number: input.number, bomId: bom.id },
      });
      return (await orderViews(tx, actor.companyId, id))[0]!;
    });
  }

  closeOrder(actor: Actor, key: string, input: z.infer<typeof closeOrderInput>) {
    return this.commands.run(actor, key, 'production.orders.close', input, 'write', async (tx) => {
      requireCondition(
        await evidenceExists(tx, actor.companyId, input.evidenceId),
        'EVIDENCE',
        'Documentul închiderii comenzii nu este disponibil.',
        404,
      );
      const [view] = await orderViews(tx, actor.companyId, input.orderId);
      requireCondition(view, 'NOT_FOUND', 'Comanda de producție nu există.', 404);
      requireCondition(
        view.closedOn === null,
        'ORDER_CLOSED',
        `Comanda ${view.number} s-a închis la ${view.closedOn}.`,
        409,
      );
      requireCondition(
        input.date >= view.openedOn,
        'ORDER_DATE',
        `Comanda ${view.number} s-a deschis la ${view.openedOn}.`,
        422,
      );
      // Nothing of the order may be dated after its close.
      const [later] = await tx
        .select({ date: entries.date })
        .from(lines)
        .innerJoin(
          entries,
          and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId)),
        )
        .innerJoin(
          proposals,
          and(eq(proposals.companyId, entries.companyId), eq(proposals.id, entries.proposalId)),
        )
        .where(
          and(
            eq(lines.companyId, actor.companyId),
            eq(lines.item, orderTag(view.id)),
            gt(entries.date, input.date),
            sql`${proposals.treatmentId} in ('production.consume', 'production.output')`,
          ),
        )
        .limit(1);
      requireCondition(
        !later,
        'ORDER_LATER',
        `Comanda ${view.number} are consumuri sau predări după ${input.date} (${later?.date}).`,
        409,
      );
      const [last] = await tx
        .select({ seq: sql<number>`coalesce(max(${workOrderEvents.seq}), 0)`.mapWith(Number) })
        .from(workOrderEvents)
        .where(
          and(eq(workOrderEvents.companyId, actor.companyId), eq(workOrderEvents.orderId, view.id)),
        );
      await tx.insert(workOrderEvents).values({
        companyId: actor.companyId,
        orderId: view.id,
        seq: (last?.seq ?? 0) + 1,
        kind: 'closed',
        date: input.date,
        evidenceId: input.evidenceId,
        createdBy: actor.actorId,
      });
      await appendAudit(tx, {
        companyId: actor.companyId,
        actorId: actor.actorId,
        ...(actor.agentId ? { agentId: actor.agentId } : {}),
        action: 'production.orders.close',
        body: { orderId: view.id, date: input.date },
      });
      return { ...view, closedOn: input.date };
    });
  }

  listOrders(actor: Actor) {
    return this.commands.read(actor, 'production.orders.list', async (tx) => ({
      items: await orderViews(tx, actor.companyId),
      next: null,
    }));
  }

  /** An order's cost sheet month by month: what its postings tagged, and the labour and overheads
   * each month's costing allocated to it. */
  costSheet(actor: Actor, input: z.infer<typeof costSheetInput>) {
    return this.commands.read(actor, 'production.costSheet', async (tx) => {
      const [view] = await orderViews(tx, actor.companyId, input.orderId);
      requireCondition(view, 'NOT_FOUND', 'Comanda de producție nu există.', 404);
      const tagged = await tx
        .select({
          month: sql<string>`substr(${entries.date}, 1, 7)`,
          date: entries.date,
          account: lines.account,
          side: lines.side,
          bani: lines.bani,
          entryId: lines.entryId,
          lineNo: lines.lineNo,
        })
        .from(lines)
        .innerJoin(
          entries,
          and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId)),
        )
        .where(and(eq(lines.companyId, actor.companyId), eq(lines.item, orderTag(view.id))))
        .orderBy(asc(entries.date), asc(entries.seq));
      const moved = new Map(
        (
          await tx
            .select({
              entryId: stockMoves.entryId,
              lineNo: stockMoves.lineNo,
              quantity: sql<bigint>`sum(${stockMoves.quantity})`.mapWith(BigInt),
            })
            .from(stockMoves)
            .where(eq(stockMoves.companyId, actor.companyId))
            .groupBy(stockMoves.entryId, stockMoves.lineNo)
        ).map((row) => [`${row.entryId}|${row.lineNo}`, row.quantity]),
      );
      // The labour and overheads each standing costing allocated to the order.
      const costings = await tx
        .select({ subject: proposals.subjectKey, effect: proposalVersions.effect })
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
            eq(entries.companyId, actor.companyId),
            eq(proposals.treatmentId, 'production.cost'),
            entryStands('"acc_entries"'),
          ),
        );
      const allocated = new Map<string, { labour: string; overheads: string }>();
      for (const row of costings) {
        const effect = JSON.parse(row.effect ?? '{}') as {
          explanation?: {
            details?: {
              orders?: { order?: string; labour?: string; fixed?: string; variable?: string }[];
            };
          };
        };
        const found = effect.explanation?.details?.orders?.find(
          (item) => item.order === view.number,
        );
        if (!found) continue;
        const overheads =
          parseMoney(found.fixed ?? '0', 'RON') + parseMoney(found.variable ?? '0', 'RON');
        allocated.set(row.subject.slice('production:cost:'.length), {
          labour: found.labour ?? '0.00',
          overheads: lei(overheads),
        });
      }
      const months = new Map<
        string,
        {
          materials: bigint;
          outputs: bigint;
          outputQuantity: bigint;
          residual: bigint;
          wip: bigint;
          differences: bigint;
        }
      >();
      for (const row of tagged) {
        const held = months.get(row.month) ?? {
          materials: 0n,
          outputs: 0n,
          outputQuantity: 0n,
          residual: 0n,
          wip: 0n,
          differences: 0n,
        };
        const signed = row.side === 'D' ? row.bani : -row.bani;
        if (row.account.startsWith('6')) held.materials += signed;
        else if (row.account.startsWith('346')) held.residual += signed;
        else if (row.account.startsWith('341') || row.account.startsWith('345')) {
          held.outputs += signed;
          held.outputQuantity += moved.get(`${row.entryId}|${row.lineNo}`) ?? 0n;
        } else if (row.account.startsWith('331')) held.wip += signed;
        else if (row.account.startsWith('348')) held.differences += signed;
        months.set(row.month, held);
      }
      return {
        order: view,
        months: [...months]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([month, held]) => ({
            month,
            materials: lei(held.materials),
            labour: allocated.get(month)?.labour ?? null,
            overheads: allocated.get(month)?.overheads ?? null,
            outputs: lei(held.outputs),
            outputQuantity: formatQuantity(held.outputQuantity),
            residual: lei(held.residual),
            wip: lei(held.wip),
            differences: lei(held.differences),
          })),
      };
    });
  }
}
