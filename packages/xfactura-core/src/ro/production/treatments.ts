import { z } from 'zod';
import {
  financialYearOf,
  formatQuantity,
  parseQuantity,
  profileAt,
  turnoverKey,
  type AnswerRecord,
  type BomRecord,
  type Effect,
  type Issue,
  type JsonValue,
  type LineSpec,
  type Loaded,
  type ProductionLine,
  type ProductionState,
  type StockItemRecord,
  type Treatment,
  type TurnoverQuery,
  type WorkOrderRecord,
} from '../../kernel';
import { formatMoney, parseMoney } from '../../money';
import { questionIssue } from '../../questions/kinds';
import { RuleGapError, type RuleContext } from '../../rules';
import { addDays, isLocalDate, monthEnd, monthStart, type LocalDate, type Month } from '../../time';
import {
  expenseFor,
  itemOf,
  StockBook,
  stockAccountsAt,
  stockPolicyAt,
  warehouseOf,
} from '../stock';
import {
  allocateOverhead,
  differencesOnExits,
  labourByHours,
  labourByShares,
  share,
  split,
  type ContractLabour,
  type OverheadPool,
} from './costing';
import type { ProductionAccounts, ProductionCoefficient, ProductionCosting } from './parameters';
import { excessAnswer, productionExcess, type ExcessAnswer } from './questions';

/*
 * Production (G4, OMFP nr. 1.802/2014 as consolidated): materials given to a work order (the bon
 * de consum, 60x against 30x through the stock register, tagged with the order), products handed
 * over to the warehouse (the bon de predare: 345 or 341 at the registration price against 711,
 * residual products at their net realizable value), the month's costing (calculația: each order's
 * materials, its share of the month's direct labour and production overheads, fixed ones at normal
 * capacity; the work in progress of the orders still open, by the count, on 331 against 711; the
 * price differences of the orders closed, on 348 against 711, or their products at the actual
 * cost), the work in progress taken back at the next month's start (Dr 711 / Cr 331), and the
 * price differences spread over the exits by the coefficient of pct. 286 alin. (4). The cost
 * accounting is kept outside the ledger (class 9 is optional, pct. 593 alin. (4)): the order's
 * cost sheet is computed from the lines its postings tag, `production:order:<id>`.
 */

const localDate = z
  .string()
  .refine((value): boolean => isLocalDate(value), 'Dată invalidă.')
  .transform((value) => value as LocalDate);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const positive = z
  .string()
  .regex(/^(0|[1-9]\d{0,14})(\.\d{1,3})?$/)
  .refine((value) => (parseQuantity(value) ?? 0n) > 0n, 'Cantitatea este pozitivă.');
/** Hours, zero or more, to the thousandth. */
const hours = z.string().regex(/^(0|[1-9]\d{0,6})(\.\d{1,3})?$/);
const percent = z
  .string()
  .regex(/^(0|[1-9]\d?|100)(\.\d{1,2})?$/)
  .refine((value) => Number(value) <= 100, 'Procentul este cel mult 100.');
const amount = z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/);
const reference = z.string().trim().min(1).max(60);
const expenseAccount = z.string().regex(/^6\d{2,3}(\.[A-Z0-9_-]{1,24})*$/);
const lei = (bani: bigint) => formatMoney(bani, 'RON');

const block = (code: string, message: string, path?: string, details?: JsonValue): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
  ...(details === undefined ? {} : { details }),
});
const ack = (code: string, message: string, details?: JsonValue): Issue => ({
  code,
  severity: 'ack',
  message,
  ...(details === undefined ? {} : { details }),
});

/** The tag a work order's postings carry on every line (`LineSpec.analytics.item`). */
export const orderTag = (orderId: string) => `production:order:${orderId}`;
/** The tag of the work in progress taken back at a month's start. */
export const wipTag = 'production:wip';
/** The tag of the price differences spread over a product account's exits. */
export const differencesTag = (account: string) => `production:differences:${account}`;
const orderOf = (tag: string) =>
  tag.startsWith('production:order:') ? tag.slice('production:order:'.length) : null;
const synthetic = (account: string) => account.split('.')[0]!.slice(0, 3);
const under = (account: string, prefixes: readonly string[]) =>
  prefixes.some((prefix) => account.split('.')[0]!.startsWith(prefix));

export const productionAccountsAt = (rules: RuleContext, date: LocalDate) =>
  rules.param<ProductionAccounts>('ro.production.accounts', 'accounting_transaction_date', date);

/** The company's written cost method for its products (`policy.production.cost`), or the issue
 * asking for it; never assumed. */
export function productionPolicyAt(loaded: Loaded, date: LocalDate): 'standard' | 'actual' | Issue {
  const value = profileAt(loaded, 'policy.production.cost', date);
  if (value === 'standard' || value === 'actual') return value;
  return questionIssue(
    'POLICY_MISSING',
    'Înregistrați metoda de calcul al costului produselor din politicile contabile: costul standard (cu diferențele de preț în 348) sau costul de producție efectiv (OMFP nr. 1.802/2014 pct. 8 pct. 7, 286).',
    {
      kind: 'profile.fact',
      subject: { kind: 'profile', id: 'policy.production.cost' },
      params: { axis: 'policy.production.cost', from: date },
    },
  );
}

const isIssue = (value: unknown): value is Issue =>
  typeof value === 'object' && value !== null && 'severity' in value && 'code' in value;

/** The policies every production treatment reads, or their issues pushed into `issues`; the
 * warehouses it moves goods in are kept at cost. */
function policies(
  loaded: Loaded,
  date: LocalDate,
  issues: Issue[],
  warehouses: readonly string[] = [],
) {
  const stock = stockPolicyAt(loaded, date, warehouses);
  if (Array.isArray(stock)) issues.push(...stock);
  const method = productionPolicyAt(loaded, date);
  if (isIssue(method)) issues.push(method);
  return Array.isArray(stock) || isIssue(method) ? null : { stock, method };
}

function productionOf(loaded: Loaded, issues: Issue[]): ProductionState | null {
  if (!loaded.production)
    issues.push(block('PRODUCTION_UNREAD', 'Comenzile de producție nu au fost citite.'));
  return loaded.production ?? null;
}

/** The order, open on `date` (from its opening to its closing day). */
function openOrder(
  production: ProductionState,
  orderId: string,
  date: LocalDate,
  issues: Issue[],
  path = 'orderId',
): WorkOrderRecord | null {
  const order = production.orders.get(orderId);
  if (!order) {
    issues.push(block('PRODUCTION_ORDER_UNKNOWN', 'Comanda de producție nu există.', path));
    return null;
  }
  if (date < order.openedOn || (order.closedOn !== null && date > order.closedOn)) {
    issues.push(
      block(
        'PRODUCTION_ORDER_CLOSED',
        `Comanda ${order.number} nu este deschisă la ${date} (deschisă la ${order.openedOn}${order.closedOn ? `, închisă la ${order.closedOn}` : ''}).`,
        path,
      ),
    );
    return null;
  }
  return order;
}

function param<T>(rules: RuleContext, key: string, date: LocalDate, issues: Issue[]): T | null {
  try {
    return rules.param<T>(key, 'accounting_transaction_date', date);
  } catch (error) {
    if (!(error instanceof RuleGapError)) throw error;
    issues.push(block('RULE_GAP', error.message));
    return null;
  }
}

/** The positions a treatment moves; `dated` for an exit, which reads what they held on its date. */
const positionsOf = (pairs: readonly { item: string; warehouse: string }[], dated = false) => ({
  positions: [...new Map(pairs.map((pair) => [`${pair.item}|${pair.warehouse}`, pair])).values()],
  items: [...new Set(pairs.map((pair) => pair.item))],
  warehouses: [...new Set(pairs.map((pair) => pair.warehouse))],
  ...(dated ? { dated } : {}),
});

// ---------------------------------------------------------------------------------------------
// Materials given to a work order: the bon de consum

export const consumeInput = z
  .object({
    orderId: z.uuid(),
    date: localDate,
    warehouseId: z.uuid(),
    /** The consumption slip's (bon de consum) number. */
    reference,
    evidenceId: z.uuid(),
    lines: z
      .array(z.object({ itemId: z.uuid(), quantity: positive }).strict())
      .min(1)
      .max(500),
  })
  .strict();
export type ConsumeInput = z.infer<typeof consumeInput>;

/**
 * Materials given to a work order (OMFP nr. 1.802/2014 pct. 8 pct. 7: the direct materials of
 * the production cost): out of the warehouse at the stock policy's value onto each stock
 * account's expense (601, 602x, 603, 608), every line tagged with the order, so that its cost
 * sheet gathers them. A material its bill of materials does not name is acknowledged.
 */
export const productionConsumption: Treatment<ConsumeInput> = {
  id: 'production.consume',
  version: 1,
  description:
    'Darea în consum pe o comandă de producție (bon de consum): materialele ies din gestiune la valoarea metodei de evaluare, pe cheltuiala contului lor de stoc, atribuite comenzii.',
  input: consumeInput,
  agent: true,
  summary:
    "Materials given to a work order (a consumption slip): out of the warehouse at the valuation method onto their stock account's expense, tagged with the order for its cost sheet.",
  toolset: 'books',
  subject: (input) => `production:consume:${input.orderId}:${input.reference}`,
  plan: (input) => ({
    evidence: [input.evidenceId],
    profile: true,
    production: {},
    stock: positionsOf(
      input.lines.map((line) => ({ item: line.itemId, warehouse: input.warehouseId })),
      true,
    ),
  }),
  evaluate(input, loaded, rules) {
    const issues: Issue[] = [];
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(block('EVIDENCE', 'Bonul de consum nu este disponibil.', 'evidenceId'));
    const warehouse = warehouseOf(loaded, input.warehouseId, 'warehouseId');
    if (isIssue(warehouse)) issues.push(warehouse);
    const policy = policies(loaded, input.date, issues, [input.warehouseId]);
    const production = productionOf(loaded, issues);
    const order = production ? openOrder(production, input.orderId, input.date, issues) : null;
    const accounts = param<ProductionAccounts>(rules, 'ro.production.accounts', input.date, issues);
    if (issues.length || !policy || !order || !accounts) return { effect: null, issues };
    const stockAccounts = stockAccountsAt(rules, input.date);
    const bom = production!.boms.get(order.bomId);
    const lines: LineSpec[] = [];
    const book = new StockBook(loaded, lines, 'order');
    const tag = { item: orderTag(order.id) };
    const expenses = new Map<string, bigint>();
    const offBom: string[] = [];
    input.lines.forEach((row, index) => {
      const path = `lines.${index}`;
      const item = itemOf(loaded, row.itemId, `${path}.itemId`);
      if (isIssue(item)) return void issues.push(item);
      if (!under(item.account, accounts.materials))
        return void issues.push(
          block(
            'PRODUCTION_MATERIAL_ACCOUNT',
            `${item.code} este în ${item.account}: pe o comandă se dau materii prime, materiale și ambalaje (${accounts.materials.join(', ')}); mărfurile se vând, iar semifabricatele consumate în unitate trec întâi în 301, 302 (funcțiunea contului 341), ceea ce nu este construit.`,
            `${path}.itemId`,
          ),
        );
      const expense = expenseFor(stockAccounts, item.account);
      if (!expense)
        return void issues.push(
          block('STOCK_EXPENSE', `Contul ${item.account} nu are o cheltuială de consum.`, path),
        );
      if (bom && !bom.lines.some((line) => line.itemId === item.id)) offBom.push(item.code);
      const line = lines.length;
      lines.push({
        account: item.account,
        side: 'C',
        bani: 0n,
        analytics: tag,
        memo: `${item.code} ${item.name}`,
      });
      const out = book.issue(
        {
          item: item.id,
          warehouse: input.warehouseId,
          account: item.account,
          quantity: parseQuantity(row.quantity)!,
          date: input.date,
        },
        line,
        policy.stock,
      );
      if ('issues' in out) return void issues.push(...out.issues);
      if (out.bani === 0n)
        return void issues.push(
          block('STOCK_VALUE', `${item.code} nu are valoare în gestiune.`, path),
        );
      lines[line] = { ...lines[line]!, bani: out.bani };
      expenses.set(expense, (expenses.get(expense) ?? 0n) + out.bani);
    });
    if (issues.length) return { effect: null, issues };
    if (offBom.length)
      issues.push(
        ack(
          'PRODUCTION_OFF_BOM',
          `Fișa tehnică a comenzii ${order.number} nu prevede ${offBom.join(', ')}: consumul intră în costul comenzii, iar la închidere se întreabă dacă este o pierdere peste limitele normale (pct. 79).`,
          { items: offBom },
        ),
      );
    let total = 0n;
    for (const [account, bani] of expenses) {
      lines.push({
        account,
        side: 'D',
        bani,
        analytics: tag,
        memo: `Comanda ${order.number}, bon de consum ${input.reference}`,
      });
      total += bani;
    }
    const effect: Effect = {
      date: input.date,
      journalClass: 'general',
      journalCode: 'DIVERSE',
      description: `Bon de consum ${input.reference}, comanda ${order.number}`,
      lines,
      openItems: [],
      taxEntries: [],
      schedules: [],
      ...book.effectPart(),
      explanation: {
        summary: `Materiale date în consum pe comanda ${order.number} din gestiunea ${(warehouse as { code: string }).code}, bonul ${input.reference}: ${lei(total)} lei (${policy.stock.method}).`,
        details: {
          orderId: order.id,
          warehouseId: input.warehouseId,
          reference: input.reference,
          evidenceId: input.evidenceId,
          method: policy.stock.method,
          clauses: ['OMFP1802/2014-A:pct.8(7)', 'OMFP1802/2014-A:pct.95-96'],
        },
      },
    };
    return { effect, issues };
  },
};

// ---------------------------------------------------------------------------------------------
// Products handed over to the warehouse: the bon de predare

export const outputInput = z
  .object({
    orderId: z.uuid(),
    date: localDate,
    warehouseId: z.uuid(),
    /** The hand-over slip's (bon de predare) number. */
    reference,
    evidenceId: z.uuid(),
    lines: z
      .array(
        z
          .object({
            itemId: z.uuid(),
            quantity: positive,
            /** A residual product's net realizable value, as the commission set it. */
            value: amount.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
export type OutputInput = z.infer<typeof outputInput>;

/** The standard cost of `quantity` of an order's product, by its BOM version. */
export function standardValue(bom: BomRecord, quantity: bigint): bigint | null {
  if (bom.standardCost === null) return null;
  return share(bom.standardCost, quantity, bom.outputQuantity);
}

/**
 * Products a work order hands over to the warehouse (the bon de predare; the functions of 341,
 * 345, 346 and 711): the order's product at its registration price, the standard cost of its
 * bill of materials (pct. 286 alin. (1)–(2)), its difference from the production cost following
 * at the month's costing (348); a residual product (346) at its net realizable value, which the
 * costing deducts from the order's cost (pct. 8 pct. 7). Under the actual cost the order's
 * products are entered by the costing of the month it closes, at their cost.
 */
export const productionOutput: Treatment<OutputInput> = {
  id: 'production.output',
  version: 1,
  description:
    'Predarea produselor unei comenzi în gestiune (bon de predare): produsul comenzii la preț de înregistrare (costul standard), produsele reziduale la valoarea realizabilă netă, pe seama contului 711.',
  input: outputInput,
  agent: true,
  summary:
    'Products a work order hands over (a hand-over slip): its product at the standard cost and residual products at their net realizable value, into the warehouse against 711.',
  toolset: 'books',
  subject: (input) => `production:output:${input.orderId}:${input.reference}`,
  plan: (input) => ({
    evidence: [input.evidenceId],
    profile: true,
    production: {},
    stock: positionsOf(
      input.lines.map((line) => ({ item: line.itemId, warehouse: input.warehouseId })),
    ),
  }),
  evaluate(input, loaded, rules) {
    const issues: Issue[] = [];
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(block('EVIDENCE', 'Bonul de predare nu este disponibil.', 'evidenceId'));
    const warehouse = warehouseOf(loaded, input.warehouseId, 'warehouseId');
    if (isIssue(warehouse)) issues.push(warehouse);
    const policy = policies(loaded, input.date, issues, [input.warehouseId]);
    const production = productionOf(loaded, issues);
    const order = production ? openOrder(production, input.orderId, input.date, issues) : null;
    const accounts = param<ProductionAccounts>(rules, 'ro.production.accounts', input.date, issues);
    if (issues.length || !policy || !order || !accounts) return { effect: null, issues };
    const bom = production!.boms.get(order.bomId)!;
    const lines: LineSpec[] = [];
    const book = new StockBook(loaded, lines, 'output');
    const tag = { item: orderTag(order.id) };
    const rows: JsonValue[] = [];
    input.lines.forEach((row, index) => {
      const path = `lines.${index}`;
      const item = loaded.stockItems.get(row.itemId);
      if (!item)
        return void issues.push(
          block('STOCK_ITEM_UNKNOWN', 'Articolul de stoc nu există.', `${path}.itemId`),
        );
      const quantity = parseQuantity(row.quantity)!;
      let value: bigint;
      if (item.id === order.itemId) {
        if (policy.method === 'actual')
          return void issues.push(
            block(
              'PRODUCTION_OUTPUT_ACTUAL',
              'Cu costul de producție efectiv, produsele comenzii intră în gestiune la costul lor, cu calculația lunii în care comanda se închide (production.cost, outputs).',
              path,
            ),
          );
        if (row.value !== undefined)
          return void issues.push(
            block(
              'PRODUCTION_OUTPUT_VALUE',
              'Produsul comenzii intră la costul standard al fișei tehnice, nu la o valoare dată.',
              `${path}.value`,
            ),
          );
        const standard = standardValue(bom, quantity);
        if (standard === null || standard === 0n)
          return void issues.push(
            block(
              'PRODUCTION_STANDARD_MISSING',
              `Fișa tehnică ${bom.version} a produsului nu are costul standard (pct. 286 alin. (2)): înregistrați o versiune cu el.`,
              path,
            ),
          );
        value = standard;
      } else if (synthetic(item.account) === synthetic(accounts.residual)) {
        if (row.value === undefined || parseMoney(row.value, 'RON') === 0n)
          return void issues.push(
            block(
              'PRODUCTION_RESIDUAL_VALUE',
              `${item.code} este un produs rezidual: intră la valoarea realizabilă netă stabilită de comisie, care se scade din costul comenzii (pct. 8 pct. 7).`,
              `${path}.value`,
            ),
          );
        value = parseMoney(row.value, 'RON');
      } else
        return void issues.push(
          block(
            'PRODUCTION_JOINT_PRODUCT',
            `${item.code} nu este produsul comenzii ${order.number} și nici un produs rezidual: produsele cuplate, cu costul repartizat după valoarea de vânzare relativă (pct. 8 pct. 7), nu sunt construite.`,
            `${path}.itemId`,
          ),
        );
      lines.push({
        account: item.account,
        side: 'D',
        bani: value,
        analytics: tag,
        memo: `${item.code} ${item.name}`,
      });
      issues.push(
        ...book.receive(
          {
            item: item.id,
            warehouse: input.warehouseId,
            account: item.account,
            quantity,
            date: input.date,
          },
          value,
          lines.length - 1,
          policy.stock,
          // Products sold before they were handed over (a pool below zero): their estimate
          // corrected against 711, which carries their cost.
          accounts.variation,
        ),
      );
      rows.push({ item: item.code, quantity: row.quantity, value: lei(value) });
    });
    if (issues.length) return { effect: null, issues };
    const total = lines.reduce(
      (sum, line) => sum + (line.side === 'D' ? line.bani : -line.bani),
      0n,
    );
    lines.push({
      account: accounts.variation,
      side: 'C',
      bani: total,
      analytics: tag,
      memo: `Comanda ${order.number}, bon de predare ${input.reference}`,
    });
    const effect: Effect = {
      date: input.date,
      journalClass: 'general',
      journalCode: 'DIVERSE',
      description: `Bon de predare ${input.reference}, comanda ${order.number}`,
      lines,
      openItems: [],
      taxEntries: [],
      schedules: [],
      ...book.effectPart(),
      explanation: {
        summary: `Produse predate de comanda ${order.number} în gestiunea ${(warehouse as { code: string }).code}, bonul ${input.reference}: ${lei(total)} lei la preț de înregistrare.`,
        details: {
          orderId: order.id,
          bomVersion: bom.version,
          reference: input.reference,
          evidenceId: input.evidenceId,
          rows,
          clauses: [
            'OMFP1802/2014-A:pct.286(1)-(3)',
            'OMFP1802/2014-A:conturi.341-346',
            'OMFP1802/2014-A:conturi.711-712',
          ],
        },
      },
    };
    return { effect, issues };
  },
};

// ---------------------------------------------------------------------------------------------
// The month's costing: the cost sheets, the work in progress, the differences

const overheadKeys = ['machine_hours', 'labour_hours', 'labour_cost', 'materials'] as const;

export const costInput = z
  .object({
    month,
    /** The month's direct labour: by the hours each contract worked on each order (the
     * timesheet) at its cost in the month's payroll run, by a key a person states, or none. */
    labour: z.discriminatedUnion('method', [
      z
        .object({
          method: z.literal('hours'),
          runId: z.uuid(),
          evidenceId: z.uuid(),
          contracts: z
            .array(
              z
                .object({
                  contractId: z.uuid(),
                  /** Every hour the contract worked in the month, on orders or not. */
                  hours,
                  orders: z.array(z.object({ orderId: z.uuid(), hours }).strict()).max(200),
                })
                .strict(),
            )
            .min(1)
            .max(500),
        })
        .strict(),
      z
        .object({
          method: z.literal('stated'),
          evidenceId: z.uuid(),
          orders: z
            .array(z.object({ orderId: z.uuid(), percent }).strict())
            .min(1)
            .max(200),
        })
        .strict(),
      z.object({ method: z.literal('none') }).strict(),
    ]),
    /** The month's production overheads: each pool the accounts it gathers, fixed or variable,
     * the key it is allocated on and, for fixed ones, the normal capacity in the key's units. */
    overheads: z
      .array(
        z
          .object({
            accounts: z.array(expenseAccount).min(1).max(20),
            behaviour: z.enum(['fixed', 'variable']),
            key: z.enum(overheadKeys),
            capacity: z
              .object({
                /** The normal capacity of a month, in hours. */
                normal: hours.optional(),
                /** The actual level approximates the normal one (pct. 8 pct. 7). */
                approximates: z.literal(true).optional(),
                evidenceId: z.uuid(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(20),
    /** The machine hours of each order, from the machines' log. */
    machineHours: z
      .object({
        evidenceId: z.uuid(),
        orders: z
          .array(z.object({ orderId: z.uuid(), hours }).strict())
          .min(1)
          .max(200),
      })
      .strict()
      .optional(),
    /** The count of the work in progress at the month's end (pct. 288): each open order's units
     * in progress, on a work-in-progress item (331) of a warehouse, with their completion. */
    wip: z
      .object({
        evidenceId: z.uuid(),
        orders: z
          .array(
            z
              .object({
                orderId: z.uuid(),
                itemId: z.uuid(),
                warehouseId: z.uuid(),
                quantity: positive,
                completion: percent.optional(),
              })
              .strict(),
          )
          .max(200),
      })
      .strict()
      .optional(),
    /** Under the actual cost: the products of the orders closed in the month (bon de predare). */
    outputs: z
      .array(
        z
          .object({
            orderId: z.uuid(),
            warehouseId: z.uuid(),
            quantity: positive,
            reference,
            evidenceId: z.uuid(),
          })
          .strict(),
      )
      .max(200)
      .default([]),
    /** The orders closed in the month without products, abandoned (a person's statement): their
     * costs stay expenses of the periods. */
    abandoned: z.array(z.uuid()).max(200).default([]),
  })
  .strict();
export type CostInput = z.infer<typeof costInput>;

const labourQuery = (input: { month: string }): TurnoverQuery => ({
  prefixes: ['64'],
  from: monthStart(input.month as Month),
  to: monthEnd(input.month as Month),
});
const overheadQuery = (input: CostInput): TurnoverQuery | null => {
  const prefixes = [...new Set(input.overheads.flatMap((pool) => pool.accounts))].sort();
  return prefixes.length
    ? { prefixes, from: monthStart(input.month as Month), to: monthEnd(input.month as Month) }
    : null;
};

/** What the plan reads of the evidence a costing cites. */
function costEvidence(input: CostInput) {
  return [
    ...(input.labour.method === 'none' ? [] : [input.labour.evidenceId]),
    ...input.overheads.flatMap((pool) => (pool.capacity ? [pool.capacity.evidenceId] : [])),
    ...(input.machineHours ? [input.machineHours.evidenceId] : []),
    ...(input.wip ? [input.wip.evidenceId] : []),
    ...input.outputs.map((row) => row.evidenceId),
  ];
}

/** One order's cost sheet of a month. */
export interface CostSheet {
  order: WorkOrderRecord;
  opening: bigint;
  materials: bigint;
  labour: bigint;
  fixed: bigint;
  variable: bigint;
  /** The products handed over in the month at their registration price, and their quantity. */
  outputs: bigint;
  outputQuantity: bigint;
  residual: bigint;
  abnormal: bigint;
  closed: boolean;
}

/** The order's lines of the production read, by kind. */
function sheetOf(
  production: ProductionState,
  order: WorkOrderRecord,
  accounts: ProductionAccounts,
  start: LocalDate,
  end: LocalDate,
): CostSheet {
  const tag = orderTag(order.id);
  const previous = addDays(start, -1);
  const own = production.lines.filter((line) => line.tag === tag);
  const net = (line: ProductionLine) => line.debit - line.credit;
  const inMonth = (line: ProductionLine) => line.date >= start && line.date <= end;
  const products = accounts.products.filter((account) => account !== accounts.residual);
  const sum = (lines: ProductionLine[], pick: (line: ProductionLine) => bigint) =>
    lines.reduce((total, line) => total + pick(line), 0n);
  const outputs = own.filter((line) => inMonth(line) && under(line.account, products));
  return {
    order,
    // What the previous month's costing left in progress (and any correction of it since).
    opening: sum(
      own.filter(
        (line) => under(line.account, [accounts.wip]) && (line.date === previous || inMonth(line)),
      ),
      net,
    ),
    materials: sum(
      own.filter((line) => inMonth(line) && line.account.startsWith('6')),
      net,
    ),
    labour: 0n,
    fixed: 0n,
    variable: 0n,
    outputs: sum(outputs, net),
    outputQuantity: sum(outputs, (line) => line.quantity),
    residual: sum(
      own.filter((line) => inMonth(line) && under(line.account, [accounts.residual])),
      net,
    ),
    abnormal: 0n,
    closed: order.closedOn !== null && order.closedOn >= start && order.closedOn <= end,
  };
}

/** The latest answer about an order's excess of a material in the proposal's basis. */
function excessAnswerOf(
  loaded: Loaded,
  orderId: string,
  itemId: string,
): { record: AnswerRecord; value: ExcessAnswer } | null {
  let found: { record: AnswerRecord; value: ExcessAnswer } | null = null;
  for (const record of loaded.answers.values()) {
    if (
      record.kind !== productionExcess.id ||
      record.subject.kind !== 'workOrder' ||
      record.subject.id !== orderId
    )
      continue;
    const params = record.params as { itemId?: unknown };
    if (params?.itemId !== itemId) continue;
    const parsed = excessAnswer.safeParse(record.value);
    if (!parsed.success) continue;
    if (
      !found ||
      found.record.answeredAt < record.answeredAt ||
      (found.record.answeredAt === record.answeredAt && found.record.answerId < record.answerId)
    )
      found = { record, value: parsed.data };
  }
  return found;
}

/**
 * The materials a closed order consumed above its bill of materials' norm for the products it
 * delivered over its life: each excess and its value at the order's own average for the material.
 */
function excessesOf(
  production: ProductionState,
  order: WorkOrderRecord,
  accounts: ProductionAccounts,
  delivered: bigint,
  end: LocalDate,
) {
  const bom = production.boms.get(order.bomId)!;
  const consumed = new Map<string, { quantity: bigint; bani: bigint }>();
  for (const line of production.lines) {
    if (line.tag !== orderTag(order.id) || line.date > end || !line.item) continue;
    if (!under(line.account, accounts.materials)) continue;
    const held = consumed.get(line.item) ?? { quantity: 0n, bani: 0n };
    held.quantity -= line.quantity;
    held.bani += line.credit - line.debit;
    consumed.set(line.item, held);
  }
  const rows: { itemId: string; quantity: bigint; bani: bigint }[] = [];
  for (const [itemId, used] of [...consumed].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (used.quantity <= 0n) continue;
    const norm = bom.lines.find((line) => line.itemId === itemId);
    const allowed = norm ? share(norm.quantity, delivered, bom.outputQuantity) : 0n;
    const excess = used.quantity - allowed;
    if (excess <= 0n) continue;
    rows.push({ itemId, quantity: excess, bani: share(used.bani, excess, used.quantity) });
  }
  return rows;
}

const hoursOf = (text: string) => parseQuantity(text)!;
const basisOf = (text: string) => {
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
};

/**
 * The month's costing (calculația costurilor lunii, on its last day): each work order active in
 * the month gathers the materials its postings tagged, its share of the month's direct labour (by
 * the hours each contract worked on it, at the contract's cost in the payroll, or by a stated key)
 * and of the production overheads, variable ones in full and fixed ones at the rate of the normal
 * capacity (pct. 8 pct. 7: what is not absorbed stays an expense of the period); the materials a
 * closed order consumed above its norm are left out once a person states they were an abnormal
 * loss (pct. 79), and residual products at their net realizable value are deducted. An order still
 * open leaves its cost less its products in progress (pct. 288, by the count): Dr 331 / Cr 711.
 * A closed order's cost against its products at the standard cost is the price difference
 * (Dr 348 / Cr 711, or Dr 711 / Cr 348 when favourable); under the actual cost its products enter
 * at that cost (Dr 345 / Cr 711). The labour and overheads themselves stay on their expense
 * accounts: the variation of stocks (711) carries the production's cost.
 */
export const productionCost: Treatment<CostInput> = {
  id: 'production.cost',
  version: 1,
  description:
    'Calculația costurilor lunii pe comenzi: materialele, manopera directă și regia de producție (cea fixă la capacitatea normală), producția în curs a comenzilor deschise (331 = 711) și diferențele de preț ale comenzilor închise (348) sau produsele lor la costul efectiv.',
  input: costInput,
  agent: true,
  summary:
    "The month's costing per work order: materials, direct labour and overheads (fixed at normal capacity); open orders' work in progress (331 = 711), closed orders' price differences (348) or actual cost.",
  toolset: 'close',
  subject: (input) => `production:cost:${input.month}`,
  plan: (input) => {
    const overheads = overheadQuery(input);
    return {
      evidence: costEvidence(input),
      profile: true,
      production: { lines: { to: monthEnd(input.month as Month) } },
      ...(input.labour.method === 'hours' ? { payrollRuns: [input.labour.runId] } : {}),
      turnover: [labourQuery(input), ...(overheads ? [overheads] : [])],
      stock: {
        ...positionsOf(
          (input.wip?.orders ?? []).map((row) => ({
            item: row.itemId,
            warehouse: row.warehouseId,
          })),
        ),
        catalogue: true,
      },
    };
  },
  followUp(input, loaded) {
    if (!input.outputs.length || !loaded.production) return null;
    const pairs = input.outputs.flatMap((row) => {
      const order = loaded.production!.orders.get(row.orderId);
      return order ? [{ item: order.itemId, warehouse: row.warehouseId }] : [];
    });
    return pairs.length ? { stock: positionsOf(pairs) } : null;
  },
  evaluate(input, loaded, rules) {
    const start = monthStart(input.month as Month);
    const end = monthEnd(input.month as Month);
    const issues: Issue[] = [];
    for (const id of costEvidence(input))
      if (!loaded.evidence.has(id))
        issues.push(block('EVIDENCE', 'Un document citat nu este disponibil.', undefined, { id }));
    const policy = policies(loaded, end, issues, [
      ...(input.wip?.orders ?? []).map((row) => row.warehouseId),
      ...input.outputs.map((row) => row.warehouseId),
    ]);
    const production = productionOf(loaded, issues);
    const accounts = param<ProductionAccounts>(rules, 'ro.production.accounts', end, issues);
    const costing = param<ProductionCosting>(rules, 'ro.production.costing', end, issues);
    if (issues.length || !policy || !production || !accounts || !costing)
      return { effect: null, issues };
    if (!costing.methods.includes(policy.method))
      return {
        effect: null,
        issues: [block('PRODUCTION_METHOD', `Metoda ${policy.method} nu este admisă.`)],
      };

    // The orders active in the month: opened by its end, not closed before its start.
    const active = [...production.orders.values()].filter(
      (order) => order.openedOn <= end && (order.closedOn === null || order.closedOn >= start),
    );
    const activeIds = new Set(active.map((order) => order.id));
    const known = (orderId: string, path: string) => {
      if (activeIds.has(orderId)) return true;
      issues.push(
        block('PRODUCTION_ORDER_INACTIVE', 'Comanda nu este deschisă în cursul lunii.', path, {
          orderId,
        }),
      );
      return false;
    };
    const sheets = new Map(
      active.map((order) => [order.id, sheetOf(production, order, accounts, start, end)]),
    );

    // The work in progress the previous month left must be taken back at this month's start.
    const opening = [...sheets.values()].reduce((sum, sheet) => sum + sheet.opening, 0n);
    const reversed = production.lines
      .filter(
        (line) =>
          line.tag === wipTag &&
          under(line.account, [accounts.wip]) &&
          line.date >= start &&
          line.date <= end,
      )
      .reduce((sum, line) => sum + line.credit - line.debit, 0n);
    if (opening > 0n && reversed < opening)
      issues.push(
        block(
          'PRODUCTION_WIP_REVERSAL',
          `Producția în curs de la sfârșitul lunii precedente (${lei(opening)} lei) nu este scăzută din gestiune la începutul lunii (funcțiunea contului 331): production.wipReverse.`,
        ),
      );

    // Direct labour.
    const labourTurnover = loaded.turnover.get(turnoverKey(labourQuery(input))) ?? [];
    const turnoverOf = (rows: typeof labourTurnover, codes: readonly string[]) =>
      rows
        .filter((row) => codes.some((code) => row.account.startsWith(code)))
        .reduce((sum, row) => sum + row.debit - row.credit, 0n);
    const labourAccounts = [accounts.labour.salary, ...accounts.labour.contributions];
    let labourHours: Map<string, bigint> | null = null;
    let labourUnallocated = 0n;
    const labourDetails: JsonValue[] = [];
    if (input.labour.method === 'hours') {
      const run = loaded.payrollRuns.get(input.labour.runId);
      if (!run || run.month !== input.month || run.state !== 'prepared' || run.issues > 0)
        issues.push(
          block(
            'PRODUCTION_PAYROLL_RUN',
            `Statul de plată citat nu este calculul valabil al lunii ${input.month}.`,
            'labour.runId',
          ),
        );
      else {
        const salaries = run.lines.reduce(
          (sum, line) => sum + line.cash - line.sickFund + line.inKind,
          0n,
        );
        if (turnoverOf(labourTurnover, [accounts.labour.salary]) < salaries)
          issues.push(
            block(
              'PRODUCTION_PAYROLL_UNPOSTED',
              `Salariile lunii ${input.month} nu sunt înregistrate în ${accounts.labour.salary}: înregistrați statul de plată înaintea calculației.`,
              'labour.runId',
            ),
          );
        const contracts: ContractLabour[] = [];
        input.labour.contracts.forEach((row, index) => {
          const path = `labour.contracts.${index}`;
          const line = run.lines.find((item) => item.contractId === row.contractId);
          if (!line)
            return void issues.push(
              block('PRODUCTION_LABOUR_CONTRACT', 'Contractul nu este în statul de plată.', path),
            );
          const total = hoursOf(row.hours);
          const onOrders = row.orders.reduce((sum, item) => sum + hoursOf(item.hours), 0n);
          if (total === 0n || onOrders > total)
            return void issues.push(
              block(
                'PRODUCTION_LABOUR_HOURS',
                'Orele lucrate pe comenzi depășesc orele lucrate în lună, sau acestea lipsesc.',
                path,
              ),
            );
          row.orders.forEach((item, at) => void known(item.orderId, `${path}.orders.${at}`));
          // The contract's cost of the month: its salary on 641 and, in the reading, the
          // employer's contributions on it (CAM and those borne in the employee's name).
          const salary = line.cash - line.sickFund + line.inKind;
          const contributions = accounts.labour.contributions.length
            ? line.cam + line.casEmployer + line.cassEmployer
            : 0n;
          contracts.push({
            contractId: row.contractId,
            cost: salary + contributions,
            hours: total,
            orders: row.orders.map((item) => ({
              orderId: item.orderId,
              hours: hoursOf(item.hours),
            })),
          });
          labourDetails.push({
            contractId: row.contractId,
            cost: lei(salary + contributions),
            hours: formatQuantity(total),
          });
        });
        if (!issues.length) {
          const result = labourByHours(contracts);
          for (const [orderId, part] of result.byOrder) sheets.get(orderId)!.labour += part;
          labourHours = result.hours;
          labourUnallocated = result.unallocated;
        }
      }
    } else if (input.labour.method === 'stated') {
      const pool = turnoverOf(labourTurnover, labourAccounts);
      const shares = input.labour.orders.map((row, index) => {
        known(row.orderId, `labour.orders.${index}`);
        return { orderId: row.orderId, basis: basisOf(row.percent) };
      });
      if (shares.reduce((sum, row) => sum + row.basis, 0n) > 10_000n)
        issues.push(block('PRODUCTION_LABOUR_SHARES', 'Cheia depășește 100%.', 'labour.orders'));
      else if (!issues.length) {
        const result = labourByShares(pool > 0n ? pool : 0n, shares);
        for (const [orderId, part] of result.byOrder) sheets.get(orderId)!.labour += part;
        labourUnallocated = result.unallocated;
        labourDetails.push({ pool: lei(pool), accounts: labourAccounts });
      }
    } else if (turnoverOf(labourTurnover, [accounts.labour.salary]) > 0n && active.length)
      issues.push(
        ack(
          'PRODUCTION_LABOUR_NONE',
          `Salariile lunii (${accounts.labour.salary}) nu se repartizează pe comenzi: nicio manoperă directă nu intră în costul produselor. Confirmați.`,
        ),
      );

    // Production overheads.
    const overheadRows = (() => {
      const query = overheadQuery(input);
      return query ? (loaded.turnover.get(turnoverKey(query)) ?? []) : [];
    })();
    const taggedAccounts = new Set(
      production.lines
        .filter((line) => orderOf(line.tag) && line.date >= start && line.date <= end)
        .map((line) => line.account),
    );
    const machine = new Map<string, bigint>();
    input.machineHours?.orders.forEach((row, index) => {
      if (known(row.orderId, `machineHours.orders.${index}`))
        machine.set(row.orderId, (machine.get(row.orderId) ?? 0n) + hoursOf(row.hours));
    });
    const listed: string[] = [];
    const poolDetails: JsonValue[] = [];
    let overheadUnallocated = 0n;
    input.overheads.forEach((pool, index) => {
      const path = `overheads.${index}`;
      for (const code of pool.accounts) {
        const base = code.split('.')[0]!;
        if (
          !accounts.overheads.allowed.some((prefix) => base.startsWith(prefix)) ||
          accounts.overheads.excluded.some((prefix) => base.startsWith(prefix)) ||
          labourAccounts.some((labour) => base.startsWith(labour))
        )
          issues.push(
            block(
              'PRODUCTION_OVERHEAD_ACCOUNT',
              `${code} nu poate fi regie de producție: cheltuielile de exploatare ${accounts.overheads.allowed.join(', ')}, fără ${[...accounts.overheads.excluded, ...labourAccounts].join(', ')} (manopera se repartizează separat; regia generală de administrație și costurile de desfacere nu intră în cost, pct. 8 pct. 7, 79).`,
              path,
            ),
          );
        if (listed.some((other) => other.startsWith(code) || code.startsWith(other)))
          issues.push(
            block('PRODUCTION_OVERHEAD_OVERLAP', `${code} este în două grupe de regie.`, path),
          );
        listed.push(code);
        if ([...taggedAccounts].some((account) => account.startsWith(code)))
          issues.push(
            block(
              'PRODUCTION_OVERHEAD_DIRECT',
              `${code} ține în lună consumuri date direct pe comenzi: o grupă de regie nu le poate cuprinde și pe ele.`,
              path,
            ),
          );
      }
      if (pool.behaviour === 'fixed') {
        if (pool.key !== 'machine_hours' && pool.key !== 'labour_hours')
          issues.push(
            block(
              'PRODUCTION_CAPACITY_KEY',
              'Regia fixă se alocă pe baza capacității normale (pct. 8 pct. 7), măsurată aici în ore-mașină sau ore de manoperă.',
              `${path}.key`,
            ),
          );
        if (!pool.capacity || (!pool.capacity.normal && !pool.capacity.approximates))
          issues.push(
            block(
              'PRODUCTION_CAPACITY',
              'Regia fixă cere capacitatea normală a lunii (pct. 79 alin. (2)), cu documentul ei, sau declarația că nivelul real o aproximează.',
              `${path}.capacity`,
            ),
          );
        else if (pool.capacity.normal && hoursOf(pool.capacity.normal) === 0n)
          issues.push(block('PRODUCTION_CAPACITY', 'Capacitatea normală este pozitivă.', path));
      }
      if (pool.key === 'machine_hours' && !input.machineHours)
        issues.push(
          block('PRODUCTION_KEY_MISSING', 'Cheia cere orele-mașină pe comenzi.', `${path}.key`),
        );
      if (pool.key === 'labour_hours' && input.labour.method !== 'hours')
        issues.push(
          block(
            'PRODUCTION_KEY_MISSING',
            'Cheia cere orele de manoperă pe comenzi, din pontaj (labour.method hours).',
            `${path}.key`,
          ),
        );
    });
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };
    input.overheads.forEach((pool, index) => {
      const amount = overheadRows
        .filter((row) => pool.accounts.some((code) => row.account.startsWith(code)))
        .reduce((sum, row) => sum + row.debit - row.credit, 0n);
      const weights = active.map((order) => ({
        id: order.id,
        weight:
          pool.key === 'machine_hours'
            ? (machine.get(order.id) ?? 0n)
            : pool.key === 'labour_hours'
              ? (labourHours?.get(order.id) ?? 0n)
              : pool.key === 'labour_cost'
                ? sheets.get(order.id)!.labour
                : sheets.get(order.id)!.materials > 0n
                  ? sheets.get(order.id)!.materials
                  : 0n,
      }));
      const capacity: OverheadPool['capacity'] =
        pool.behaviour === 'fixed'
          ? pool.capacity!.approximates
            ? { approximates: true }
            : { normal: hoursOf(pool.capacity!.normal!) }
          : undefined;
      const result = allocateOverhead(
        {
          amount: amount > 0n ? amount : 0n,
          behaviour: pool.behaviour,
          ...(capacity ? { capacity } : {}),
        },
        weights.filter((row) => row.weight > 0n),
      );
      for (const [orderId, part] of result.parts)
        if (pool.behaviour === 'fixed') sheets.get(orderId)!.fixed += part;
        else sheets.get(orderId)!.variable += part;
      overheadUnallocated += amount - result.absorbed;
      poolDetails.push({
        pool: index,
        accounts: pool.accounts,
        behaviour: pool.behaviour,
        key: pool.key,
        amount: lei(amount),
        activity: formatQuantity(result.activity),
        ...(capacity && 'normal' in capacity ? { normal: formatQuantity(capacity.normal) } : {}),
        absorbed: lei(result.absorbed),
        unallocated: lei(amount - result.absorbed),
      });
    });

    // The products of the month under the actual cost: only the orders closing in it.
    if (input.outputs.length && policy.method === 'standard')
      issues.push(
        block(
          'PRODUCTION_OUTPUT_STANDARD',
          'Cu costul standard, produsele intră în gestiune pe bonurile de predare (production.output), nu prin calculație.',
          'outputs',
        ),
      );
    const outputsOf = new Map<string, CostInput['outputs']>();
    input.outputs.forEach((row, index) => {
      const sheet = sheets.get(row.orderId);
      if (!sheet || !sheet.closed)
        return void issues.push(
          block(
            'PRODUCTION_OUTPUT_OPEN',
            'Cu costul efectiv, produsele unei comenzi intră la închiderea ei: predările parțiale ale unei comenzi deschise nu sunt construite.',
            `outputs.${index}`,
          ),
        );
      outputsOf.set(row.orderId, [...(outputsOf.get(row.orderId) ?? []), row]);
    });

    input.abandoned.forEach((orderId, index) => {
      if (!sheets.get(orderId)?.closed)
        issues.push(
          block(
            'PRODUCTION_ABANDONED_OPEN',
            'Se declară abandonată doar o comandă închisă în cursul lunii.',
            `abandoned.${index}`,
          ),
        );
    });

    // The excesses of the orders closing in the month (pct. 79).
    const excessRows: JsonValue[] = [];
    for (const sheet of sheets.values()) {
      if (!sheet.closed) continue;
      const delivered =
        policy.method === 'actual'
          ? (outputsOf.get(sheet.order.id) ?? []).reduce(
              (sum, row) => sum + parseQuantity(row.quantity)!,
              0n,
            )
          : production.lines
              .filter(
                (line) =>
                  line.tag === orderTag(sheet.order.id) &&
                  line.date <= end &&
                  line.item === sheet.order.itemId,
              )
              .reduce((sum, line) => sum + line.quantity, 0n);
      if (delivered <= 0n) continue;
      for (const excess of excessesOf(production, sheet.order, accounts, delivered, end)) {
        const found = excessAnswerOf(loaded, sheet.order.id, excess.itemId);
        const item = loaded.stockItems.get(excess.itemId);
        if (!found) {
          issues.push(
            questionIssue(
              'PRODUCTION_EXCESS',
              `Comanda ${sheet.order.number} a consumat peste normă ${formatQuantity(excess.quantity)} din ${item?.code ?? excess.itemId} (${lei(excess.bani)} lei): o pierdere peste limitele normale rămâne cheltuială a perioadei (pct. 79), un consum normal intră în cost; răspunsul unei persoane decide.`,
              {
                kind: 'production.excess',
                subject: { kind: 'workOrder', id: sheet.order.id },
                params: { itemId: excess.itemId, quantity: formatQuantity(excess.quantity) },
              },
            ),
          );
          continue;
        }
        if (found.value.treatment === 'abnormal') sheet.abnormal += excess.bani;
        excessRows.push({
          order: sheet.order.number,
          item: item?.code ?? excess.itemId,
          quantity: formatQuantity(excess.quantity),
          value: lei(excess.bani),
          treatment: found.value.treatment,
          evidenceId: found.value.evidenceId,
        });
      }
    }

    // The count of the work in progress.
    const wipRows = new Map<string, NonNullable<CostInput['wip']>['orders'][number]>();
    input.wip?.orders.forEach((row, index) => {
      const path = `wip.orders.${index}`;
      const sheet = sheets.get(row.orderId);
      if (!sheet || sheet.closed)
        return void issues.push(
          block(
            'PRODUCTION_WIP_ORDER',
            'Producția în curs se inventariază doar pentru comenzile deschise la sfârșitul lunii.',
            path,
          ),
        );
      const item = loaded.stockItems.get(row.itemId);
      if (!item || !under(item.account, [accounts.wip]))
        return void issues.push(
          block(
            'PRODUCTION_WIP_ITEM',
            `Producția în curs se ține pe un articol al contului ${accounts.wip}.`,
            `${path}.itemId`,
          ),
        );
      const store = warehouseOf(loaded, row.warehouseId, `${path}.warehouseId`);
      if (isIssue(store)) return void issues.push(store);
      if (wipRows.has(row.orderId))
        return void issues.push(block('DUPLICATE', 'Comanda apare de două ori.', path));
      wipRows.set(row.orderId, row);
    });
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };

    // The entries: the work in progress of the open orders, the closed ones' differences or
    // products at their cost.
    const lines: LineSpec[] = [];
    const book = new StockBook(loaded, lines, 'costing');
    const rows: JsonValue[] = [];
    let wipTotal = 0n;
    for (const sheet of [...sheets.values()].sort((a, b) =>
      a.order.number < b.order.number ? -1 : 1,
    )) {
      const order = sheet.order;
      const tag = { item: orderTag(order.id) };
      const cost =
        sheet.opening +
        sheet.materials +
        sheet.labour +
        sheet.fixed +
        sheet.variable -
        sheet.residual -
        sheet.abnormal;
      const row: Record<string, JsonValue> = {
        order: order.number,
        opening: lei(sheet.opening),
        materials: lei(sheet.materials),
        labour: lei(sheet.labour),
        fixed: lei(sheet.fixed),
        variable: lei(sheet.variable),
        residual: lei(sheet.residual),
        abnormal: lei(sheet.abnormal),
        cost: lei(cost),
        outputs: lei(sheet.outputs),
        closed: sheet.closed,
      };
      if (!sheet.closed) {
        const counted = wipRows.get(order.id);
        const accumulated = cost - sheet.outputs;
        let value = accumulated;
        if (accumulated > 0n && !counted) {
          issues.push(
            block(
              'PRODUCTION_WIP_UNLISTED',
              `Comanda ${order.number} rămâne deschisă cu ${lei(accumulated)} lei costuri: inventarul producției în curs (pct. 288) trebuie să o cuprindă (wip.orders), cu articolul de producție în curs și gestiunea.`,
              'wip',
            ),
          );
          continue;
        }
        if (costing.wip === 'completion') {
          const bom = production.boms.get(order.bomId)!;
          const completion = counted?.completion;
          const standard = counted ? standardValue(bom, parseQuantity(counted.quantity)!) : null;
          if (counted && (completion === undefined || standard === null)) {
            issues.push(
              block(
                'PRODUCTION_WIP_COMPLETION',
                `Producția în curs a comenzii ${order.number} se evaluează după gradul de finalizare, care cere procentul din inventar și costul standard al fișei tehnice.`,
              ),
            );
            continue;
          }
          value = counted ? share(standard!, basisOf(completion!), 10_000n) : 0n;
        }
        if (value < 0n) {
          issues.push(
            block(
              'PRODUCTION_WIP_NEGATIVE',
              `Produsele predate de comanda ${order.number} la preț de înregistrare (${lei(sheet.outputs)} lei) depășesc costurile ei (${lei(cost)} lei): închideți comanda sau revizuiți costul standard.`,
            ),
          );
          continue;
        }
        if (value === 0n) {
          if (counted)
            issues.push(
              block(
                'PRODUCTION_WIP_EMPTY',
                `Comanda ${order.number} nu are costuri în curs, dar inventarul o listează.`,
              ),
            );
          rows.push({ ...row, wip: lei(0n) });
          continue;
        }
        const item = loaded.stockItems.get(counted!.itemId)!;
        lines.push({
          account: item.account,
          side: 'D',
          bani: value,
          analytics: tag,
          memo: `Producție în curs, comanda ${order.number}`,
        });
        issues.push(
          ...book.receive(
            {
              item: item.id,
              warehouse: counted!.warehouseId,
              account: item.account,
              quantity: parseQuantity(counted!.quantity)!,
              date: end,
            },
            value,
            lines.length - 1,
            policy.stock,
            accounts.variation,
          ),
        );
        lines.push({
          account: accounts.variation,
          side: 'C',
          bani: value,
          analytics: tag,
          memo: `Producție în curs, comanda ${order.number}`,
        });
        wipTotal += value;
        rows.push({ ...row, wip: lei(value) });
        continue;
      }
      // A closed order without products: abandoned, its costs stay expenses of the periods.
      const everDelivered =
        policy.method === 'actual'
          ? (outputsOf.get(order.id) ?? []).length > 0
          : production.lines.some(
              (line) =>
                line.tag === orderTag(order.id) &&
                line.date <= end &&
                line.item === order.itemId &&
                line.quantity !== 0n,
            );
      const abandoned = input.abandoned.includes(order.id);
      if (abandoned && everDelivered) {
        issues.push(
          block(
            'PRODUCTION_ABANDONED_DELIVERED',
            `Comanda ${order.number} a predat produse: nu este abandonată.`,
            'abandoned',
          ),
        );
        continue;
      }
      if (!everDelivered) {
        // Under the actual cost, a closed order's products are the costing's own input: without
        // them, only a person's statement that the order was abandoned leaves its costs out.
        if (!abandoned && policy.method === 'actual' && cost > 0n) {
          issues.push(
            block(
              'PRODUCTION_OUTPUTS_MISSING',
              `Comanda ${order.number} s-a închis în lună: cu costul efectiv, produsele ei intră cu calculația (outputs), sau se declară abandonată (abandoned).`,
              'outputs',
            ),
          );
          continue;
        }
        issues.push(
          ack(
            'PRODUCTION_ABANDONED',
            `Comanda ${order.number} s-a închis fără produse: costurile ei (${lei(cost)} lei) rămân cheltuieli ale perioadelor (pct. 79).`,
          ),
        );
        rows.push({ ...row, abandoned: true });
        continue;
      }
      if (policy.method === 'standard') {
        const variance = cost - sheet.outputs;
        if (variance !== 0n) {
          const unfavourable = variance > 0n;
          const bani = unfavourable ? variance : -variance;
          lines.push(
            {
              account: unfavourable ? accounts.differences : accounts.variation,
              side: 'D',
              bani,
              analytics: tag,
              memo: `Diferențe de preț, comanda ${order.number}`,
            },
            {
              account: unfavourable ? accounts.variation : accounts.differences,
              side: 'C',
              bani,
              analytics: tag,
              memo: `Diferențe de preț, comanda ${order.number}`,
            },
          );
        }
        rows.push({ ...row, variance: lei(variance) });
        continue;
      }
      // The actual cost: the products of the order at its cost, split by their quantities.
      const deliveries = outputsOf.get(order.id)!;
      if (cost <= 0n) {
        issues.push(
          block(
            'PRODUCTION_COST_EMPTY',
            `Comanda ${order.number} nu are un cost pozitiv pentru produsele ei.`,
          ),
        );
        continue;
      }
      const product = loaded.stockItems.get(order.itemId) as StockItemRecord | undefined;
      if (!product) {
        issues.push(block('STOCK_ITEM_UNKNOWN', 'Produsul comenzii nu a fost citit.'));
        continue;
      }
      const values = split(
        cost,
        deliveries.map((delivery, index) => ({
          id: String(index),
          weight: parseQuantity(delivery.quantity)!,
        })),
      ).parts;
      deliveries.forEach((delivery, index) => {
        const value = values.get(String(index)) ?? 0n;
        lines.push({
          account: product.account,
          side: 'D',
          bani: value,
          analytics: tag,
          memo: `${product.code}, bon de predare ${delivery.reference}`,
        });
        issues.push(
          ...book.receive(
            {
              item: product.id,
              warehouse: delivery.warehouseId,
              account: product.account,
              quantity: parseQuantity(delivery.quantity)!,
              date: end,
            },
            value,
            lines.length - 1,
            policy.stock,
            accounts.variation,
          ),
        );
      });
      lines.push({
        account: accounts.variation,
        side: 'C',
        bani: cost,
        analytics: tag,
        memo: `Produse la costul efectiv, comanda ${order.number}`,
      });
      rows.push({ ...row, actual: lei(cost) });
    }
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };
    if (!rows.length)
      return {
        effect: null,
        issues: [
          block('NOTHING_TO_BOOK', `Luna ${input.month} nu are comenzi de producție active.`),
        ],
      };
    const part = book.effectPart();
    const effect: Effect = {
      ...(lines.length ? part : { schema: 'effect@1' as const }),
      date: end,
      journalClass: lines.length ? 'general' : 'memo',
      journalCode: 'DIVERSE',
      description: `Calculația costurilor de producție ${input.month}`,
      lines,
      openItems: [],
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: `Calculația lunii ${input.month}: ${rows.length} comenzi, producția în curs ${lei(wipTotal)} lei; manopera nerepartizată ${lei(labourUnallocated)} lei și regia nealocată ${lei(overheadUnallocated)} lei rămân cheltuieli.`,
        details: {
          month: input.month,
          method: policy.method,
          wipReading: costing.wip,
          orders: rows,
          labour: {
            method: input.labour.method,
            unallocated: lei(labourUnallocated),
            rows: labourDetails,
          },
          overheads: poolDetails,
          excess: excessRows,
          clauses: [
            'OMFP1802/2014-A:pct.8(7)',
            'OMFP1802/2014-A:pct.79',
            'OMFP1802/2014-A:pct.286(1)-(3)',
            'OMFP1802/2014-A:pct.288',
            'OMFP1802/2014-A:conturi.331-332',
            'OMFP1802/2014-A:conturi.348',
            'OMFP1802/2014-A:conturi.711-712',
          ],
        },
      },
    };
    return { effect, issues };
  },
};

// ---------------------------------------------------------------------------------------------
// The work in progress taken back at the month's start

export const wipReverseInput = z.object({ month }).strict();
export type WipReverseInput = z.infer<typeof wipReverseInput>;

/**
 * The work in progress the previous month's costing left, taken out of the register on the
 * month's first day (the function of 331: "scăderea din gestiune a valorii produselor în curs de
 * execuție la începutul perioadei următoare (711)"): Dr 711 / Cr 331, so that the month's costing
 * counts its own.
 */
export const productionWipReverse: Treatment<WipReverseInput> = {
  id: 'production.wipReverse',
  version: 1,
  description:
    'Scăderea din gestiune, la începutul lunii, a producției în curs de execuție de la sfârșitul lunii precedente (711 = 331).',
  input: wipReverseInput,
  agent: true,
  summary:
    "Takes the previous month's work in progress out of the register on the month's first day (711 = 331), as the function of 331 requires.",
  toolset: 'close',
  subject: (input) => `production:wip:${input.month}`,
  plan: () => ({ profile: true, stock: { all: true } }),
  evaluate(input, loaded, rules) {
    const date = monthStart(input.month as Month);
    const issues: Issue[] = [];
    const policy = policies(loaded, date, issues);
    const accounts = param<ProductionAccounts>(rules, 'ro.production.accounts', date, issues);
    if (issues.length || !policy || !accounts) return { effect: null, issues };
    const lines: LineSpec[] = [];
    const book = new StockBook(loaded, lines, 'wip', true);
    const rows: JsonValue[] = [];
    for (const position of [...loaded.stock.values()].sort((a, b) =>
      `${a.item}|${a.warehouse}` < `${b.item}|${b.warehouse}` ? -1 : 1,
    )) {
      const held = position.layers.filter(
        (layer) => under(layer.account, [accounts.wip]) && layer.date < date && layer.quantity > 0n,
      );
      const quantity = held.reduce((sum, layer) => sum + layer.quantity, 0n);
      if (quantity <= 0n) continue;
      const item = loaded.stockItems.get(position.item);
      const line = lines.length;
      lines.push({
        account: held[0]!.account,
        side: 'C',
        bani: 0n,
        analytics: { item: wipTag },
        memo: item ? `${item.code} ${item.name}` : position.item,
      });
      const out = book.issue(
        {
          item: position.item,
          warehouse: position.warehouse,
          account: held[0]!.account,
          quantity,
          date,
        },
        line,
        policy.stock,
      );
      if ('issues' in out) {
        issues.push(...out.issues);
        continue;
      }
      lines[line] = { ...lines[line]!, bani: out.bani };
      rows.push({
        item: item?.code ?? position.item,
        quantity: formatQuantity(quantity),
        value: lei(out.bani),
      });
    }
    if (issues.length) return { effect: null, issues };
    if (!lines.length)
      return {
        effect: null,
        issues: [
          block(
            'NOTHING_TO_BOOK',
            `Gestiunea nu ține producție în curs de dinaintea lunii ${input.month}.`,
          ),
        ],
      };
    const total = lines.reduce((sum, line) => sum + line.bani, 0n);
    lines.push({
      account: accounts.variation,
      side: 'D',
      bani: total,
      analytics: { item: wipTag },
      memo: 'Reluarea producției în curs de execuție',
    });
    const effect: Effect = {
      date,
      journalClass: 'general',
      journalCode: 'DIVERSE',
      description: `Reluarea producției în curs la începutul lunii ${input.month}`,
      lines,
      openItems: [],
      taxEntries: [],
      schedules: [],
      ...book.effectPart(),
      explanation: {
        summary: `Producția în curs de la sfârșitul lunii precedente, ${lei(total)} lei, scăzută din gestiune la ${date}.`,
        details: { month: input.month, rows, clauses: ['OMFP1802/2014-A:conturi.331-332'] },
      },
    };
    return { effect, issues };
  },
};

// ---------------------------------------------------------------------------------------------
// The price differences spread over the exits (pct. 286 alin. (4)–(7))

export const differencesInput = z.object({ month }).strict();
export type DifferencesInput = z.infer<typeof differencesInput>;

/** The queries the differences read: the products' turnover before the year and the month, and
 * in the year and the month to its end. */
function differenceQueries(loaded: Loaded, input: DifferencesInput) {
  const start = monthStart(input.month as Month);
  const end = monthEnd(input.month as Month);
  const year = financialYearOf(loaded, end);
  if (!year) return null;
  const always = '1900-01-01' as LocalDate;
  // The entries are the debits and the exits the credits of the product accounts, a reversal on
  // the side of what it reverses (a product handed over and reversed in black is not an exit).
  const sides = 'original' as const;
  return {
    year,
    beforeYear: { prefixes: ['34'], from: always, to: addDays(year.from, -1), sides },
    inYear: { prefixes: ['34'], from: year.from, to: end, sides },
    beforeMonth: { prefixes: ['34'], from: always, to: addDays(start, -1), sides },
    inMonth: { prefixes: ['34'], from: start, to: end, sides },
  };
}

/**
 * The products' price differences (348) spread over their exits at the month's end (pct. 286
 * alin. (4), (7); the function of 348): for each product account at the standard cost, the
 * coefficient of the differences over the stock at registration price, applied to the exits
 * (sold, found missing); unfavourable ones Dr 711 / Cr 348, favourable ones Dr 348 / Cr 711.
 * What stays on 348 belongs to the stock held (alin. (6)).
 */
export const productionDifferences: Treatment<DifferencesInput> = {
  id: 'production.differences',
  version: 1,
  description:
    'Repartizarea diferențelor de preț la produse (348) asupra produselor ieșite din gestiune, cu coeficientul de repartizare (OMFP nr. 1.802/2014 pct. 286 alin. (4)).',
  input: differencesInput,
  agent: true,
  summary:
    "Spreads the products' price differences (348) over the month's exits by the coefficient of pct. 286: unfavourable ones 711 = 348, favourable ones 348 = 711.",
  toolset: 'close',
  subject: (input) => `production:differences:${input.month}`,
  plan: (input) => ({
    profile: true,
    production: { lines: { to: monthEnd(input.month as Month) } },
    stock: { catalogue: true },
  }),
  followUp(input, loaded) {
    const queries = differenceQueries(loaded, input);
    return queries
      ? { turnover: [queries.beforeYear, queries.inYear, queries.beforeMonth, queries.inMonth] }
      : null;
  },
  evaluate(input, loaded, rules) {
    const start = monthStart(input.month as Month);
    const end = monthEnd(input.month as Month);
    const issues: Issue[] = [];
    const policy = policies(loaded, end, issues);
    const production = productionOf(loaded, issues);
    const accounts = param<ProductionAccounts>(rules, 'ro.production.accounts', end, issues);
    const rule = param<ProductionCoefficient>(rules, 'ro.production.coefficient', end, issues);
    if (issues.length || !policy || !production || !accounts || !rule)
      return { effect: null, issues };
    if (policy.method !== 'standard')
      return {
        effect: null,
        issues: [
          block(
            'PRODUCTION_NOT_STANDARD',
            'Produsele sunt la costul de producție efectiv: nu au diferențe de preț de repartizat.',
          ),
        ],
      };
    const queries = differenceQueries(loaded, input);
    if (!queries)
      return {
        effect: null,
        issues: [
          block('FINANCIAL_YEAR', `Luna ${input.month} nu este într-un exercițiu financiar.`),
        ],
      };
    const turnover = (query: TurnoverQuery, account: string) =>
      (loaded.turnover.get(turnoverKey(query)) ?? []).filter((row) =>
        row.account.split('.')[0]!.startsWith(account),
      );
    const debitOf = (rows: { debit: bigint }[]) => rows.reduce((sum, row) => sum + row.debit, 0n);
    const creditOf = (rows: { credit: bigint }[]) =>
      rows.reduce((sum, row) => sum + row.credit, 0n);
    const balanceOf = (rows: { debit: bigint; credit: bigint }[]) => debitOf(rows) - creditOf(rows);
    // Which product account each order's differences belong to.
    const productAccount = (tag: string) => {
      const orderId = orderOf(tag);
      if (orderId) {
        const order = production.orders.get(orderId);
        const item = order ? loaded.stockItems.get(order.itemId) : undefined;
        return item ? synthetic(item.account) : null;
      }
      return tag.startsWith('production:differences:')
        ? tag.slice('production:differences:'.length)
        : null;
    };
    const differenceLines = production.lines.filter((line) =>
      under(line.account, [accounts.differences]),
    );
    const unknownItems = differenceLines.some(
      (line) => orderOf(line.tag) && productAccount(line.tag) === null,
    );
    if (unknownItems)
      return {
        effect: null,
        issues: [block('PRODUCTION_UNREAD', 'Produsele comenzilor nu au fost citite.')],
      };
    const lines: LineSpec[] = [];
    const rows: JsonValue[] = [];
    const yearStart = queries.year.from;
    for (const account of accounts.products.filter((item) => item !== accounts.residual)) {
      const own = differenceLines.filter((line) => productAccount(line.tag) === account);
      if (!own.length) continue;
      const isVariance = (line: ProductionLine) => orderOf(line.tag) !== null;
      const net = (line: ProductionLine) => line.debit - line.credit;
      const sum = (pick: (line: ProductionLine) => boolean) =>
        own.filter(pick).reduce((total, line) => total + net(line), 0n);
      const figures =
        rule.basis === 'year'
          ? {
              differences: {
                opening: sum((line) => line.date < yearStart),
                entered: sum((line) => isVariance(line) && line.date >= yearStart),
              },
              stock: {
                opening: balanceOf(turnover(queries.beforeYear, account)),
                entered: debitOf(turnover(queries.inYear, account)),
              },
              exits: creditOf(turnover(queries.inYear, account)),
              // What the year's earlier months took off 348 (their distributions, credit-positive).
              taken: -sum(
                (line) => !isVariance(line) && line.date >= yearStart && line.date < start,
              ),
            }
          : {
              differences: {
                opening: sum((line) => line.date < start),
                entered: sum((line) => isVariance(line) && line.date >= start),
              },
              stock: {
                opening: balanceOf(turnover(queries.beforeMonth, account)),
                entered: debitOf(turnover(queries.inMonth, account)),
              },
              exits: creditOf(turnover(queries.inMonth, account)),
              taken: 0n,
            };
      const result = differencesOnExits(figures);
      if (!result) {
        issues.push(
          block(
            'PRODUCTION_COEFFICIENT',
            `Contul ${account} nu are stoc la preț de înregistrare: coeficientul nu se poate calcula.`,
          ),
        );
        continue;
      }
      rows.push({
        account,
        basis: rule.basis,
        differences: lei(result.numerator),
        stock: lei(result.denominator),
        exits: lei(figures.exits),
        share: lei(result.share),
      });
      if (result.share === 0n) continue;
      const tag = { item: differencesTag(account) };
      const unfavourable = result.share > 0n;
      const bani = unfavourable ? result.share : -result.share;
      lines.push(
        {
          account: unfavourable ? accounts.variation : accounts.differences,
          side: 'D',
          bani,
          analytics: tag,
          memo: `Diferențe de preț repartizate, ${account}`,
        },
        {
          account: unfavourable ? accounts.differences : accounts.variation,
          side: 'C',
          bani,
          analytics: tag,
          memo: `Diferențe de preț repartizate, ${account}`,
        },
      );
    }
    if (issues.length) return { effect: null, issues };
    if (!lines.length)
      return {
        effect: null,
        issues: [
          block(
            'NOTHING_TO_BOOK',
            `Luna ${input.month} nu are diferențe de preț de repartizat asupra ieșirilor.`,
          ),
        ],
      };
    const effect: Effect = {
      schema: 'effect@1',
      date: end,
      journalClass: 'general',
      journalCode: 'DIVERSE',
      description: `Diferențe de preț la produse repartizate ${input.month}`,
      lines,
      openItems: [],
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: `Diferențele de preț ale lunii ${input.month} repartizate asupra produselor ieșite: ${rows.length} conturi (${rule.basis === 'year' ? 'cumulat de la începutul exercițiului' : 'pe lună'}).`,
        details: {
          month: input.month,
          rows,
          clauses: ['OMFP1802/2014-A:pct.286(4)-(8)', 'OMFP1802/2014-A:conturi.348'],
        },
      },
    };
    return { effect, issues };
  },
};

export const productionTreatments = [
  productionConsumption,
  productionOutput,
  productionCost,
  productionWipReverse,
  productionDifferences,
] as const;
