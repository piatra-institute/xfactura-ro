import { z } from 'zod';
import {
  formatQuantity,
  itemLinesKey,
  parseQuantity,
  turnoverKey,
  type Effect,
  type Issue,
  type JsonValue,
  type LineSpec,
  type Loaded,
  type OpenItemSpec,
  type StockItemRecord,
  type Treatment,
  type TurnoverQuery,
  type WarehouseRecord,
} from '../../kernel';
import { formatMoney, parseMoney } from '../../money';
import type { RuleContext } from '../../rules';
import { isLocalDate, type LocalDate } from '../../time';
import { allowanceFor, expenseFor, supportedItemAccount, type StockAccounts } from './parameters';
import { prorate, StockBook, stockPolicyAt, type StockPolicy } from './valuation';

/*
 * The stock register's own treatments (G1): goods received without their invoice (a NIR on the
 * delivery note, against 408), consumption (the bon de consum, 60x against 30x), transfers
 * between warehouses (the bon de predare-transfer, moves only), the takeover of a balance the
 * ledger already holds into the register, the month's costing under the periodic weighted
 * average, and the write-down of stock to its net realizable value (39x). Receipts and sales on
 * invoices are `invoices.recognize`'s (`stock`), returns `invoices.credit`'s; the annual count's
 * differences are `inventory.stock`'s.
 */

const localDate = z
  .string()
  .refine((value): boolean => isLocalDate(value), 'Dată invalidă.')
  .transform((value) => value as LocalDate);
/** A positive quantity in the item's unit, at most three decimals. */
export const quantityInput = z
  .string()
  .regex(/^(0|[1-9]\d{0,14})(\.\d{1,3})?$/)
  .refine((value) => (parseQuantity(value) ?? 0n) > 0n, 'Cantitatea este pozitivă.');
const amount = z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/);
const reference = z.string().trim().min(1).max(60);
const lei = (bani: bigint) => formatMoney(bani, 'RON');
const always = '1900-01-01' as LocalDate;

const block = (code: string, message: string, path?: string, details?: JsonValue): Issue => ({
  code,
  severity: 'block',
  message,
  ...(path === undefined ? {} : { path }),
  ...(details === undefined ? {} : { details }),
});

export const stockAccountsAt = (rules: RuleContext, date: LocalDate) =>
  rules.param<StockAccounts>('ro.stock.accounts', 'accounting_transaction_date', date);

/** The catalogue's item, or the issue saying it is not one the treatments cover. */
export function itemOf(loaded: Loaded, id: string, path: string): StockItemRecord | Issue {
  const item = loaded.stockItems.get(id);
  if (!item) return block('STOCK_ITEM_UNKNOWN', 'Articolul de stoc nu există.', path);
  const unsupported = supportedItemAccount(item.account);
  if (unsupported) return block('STOCK_KIND_UNSUPPORTED', unsupported, path);
  return item;
}

export function warehouseOf(loaded: Loaded, id: string, path: string): WarehouseRecord | Issue {
  return (
    loaded.warehouses.get(id) ?? block('STOCK_WAREHOUSE_UNKNOWN', 'Gestiunea nu există.', path)
  );
}

const isIssue = (value: unknown): value is Issue =>
  typeof value === 'object' && value !== null && 'severity' in value && 'code' in value;

/** The policy, or its issues pushed into `issues`. */
function policyOf(loaded: Loaded, date: LocalDate, issues: Issue[]): StockPolicy | null {
  const policy = stockPolicyAt(loaded, date);
  if (Array.isArray(policy)) {
    issues.push(...policy);
    return null;
  }
  return policy;
}

/** The read of the positions an input's lines name. */
const positionsOf = (warehouses: string[], items: string[]) => ({
  positions: warehouses.flatMap((warehouse) => items.map((item) => ({ item, warehouse }))),
  items,
  warehouses,
});

/** Lines on one account per expense account, debit-positive amounts summed. */
function expenseLines(totals: Map<string, bigint>, memo: string): LineSpec[] {
  return [...totals]
    .filter(([, bani]) => bani !== 0n)
    .map(([account, bani]) => ({
      account,
      side: bani > 0n ? ('D' as const) : ('C' as const),
      bani: bani > 0n ? bani : -bani,
      memo,
    }));
}

// ---------------------------------------------------------------------------------------------
// Goods received without their invoice: the NIR on the delivery note (pct. 284 alin. (2) lit. b))

export const receiveInput = z
  .object({
    date: localDate,
    warehouseId: z.uuid(),
    supplierId: z.uuid(),
    /** The delivery note's (aviz de însoțire a mărfii) series and number. */
    reference,
    /** The delivery note and the reception note (NIR) the commission signed. */
    evidenceId: z.uuid(),
    /** Each item received: the quantity found and its value at the delivery note's prices, in
     * lei, without VAT. */
    lines: z
      .array(z.object({ itemId: z.uuid(), quantity: quantityInput, value: amount }).strict())
      .min(1)
      .max(500),
  })
  .strict();
export type ReceiveInput = z.infer<typeof receiveInput>;

/**
 * Goods received before their invoice (OMFP nr. 1.802/2014 pct. 284 alin. (2) lit. b)): entered
 * in the warehouse and the books on the reception and the delivery note, at its prices, against
 * the supplier's uninvoiced debt (408, its function: "bunurile sosite fără factură"). The invoice
 * settles 408 (`accruals.settle`).
 */
export const stockReceipt: Treatment<ReceiveInput> = {
  id: 'stock.receive',
  version: 1,
  description:
    'Recepția bunurilor sosite fără factură (NIR pe avizul de însoțire): intrarea în gestiune la prețurile avizului, pe seama furnizorilor - facturi nesosite (408).',
  input: receiveInput,
  agent: true,
  summary:
    'Goods received before their invoice (a NIR on the delivery note): into the warehouse at the note prices, against the supplier on 408.',
  toolset: 'books',
  subject: (input) => `stock:receive:${input.supplierId}:${input.reference}`,
  plan: (input) => ({
    evidence: [input.evidenceId],
    parties: [input.supplierId],
    profile: true,
    stock: positionsOf([input.warehouseId], [...new Set(input.lines.map((line) => line.itemId))]),
  }),
  evaluate(input, loaded, rules) {
    const issues: Issue[] = [];
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(
        block('EVIDENCE', 'Avizul și nota de recepție nu sunt disponibile.', 'evidenceId'),
      );
    if (!loaded.parties.has(input.supplierId))
      issues.push(block('PARTY', 'Furnizorul nu este disponibil.', 'supplierId'));
    const warehouse = warehouseOf(loaded, input.warehouseId, 'warehouseId');
    if (isIssue(warehouse)) issues.push(warehouse);
    const policy = policyOf(loaded, input.date, issues);
    const accounts = stockAccountsAt(rules, input.date);
    if (issues.length || !policy) return { effect: null, issues };
    const lines: LineSpec[] = [];
    const book = new StockBook(loaded, lines, 'receipt');
    let total = 0n;
    input.lines.forEach((row, index) => {
      const path = `lines.${index}`;
      const item = itemOf(loaded, row.itemId, `${path}.itemId`);
      if (isIssue(item)) return void issues.push(item);
      const value = parseMoney(row.value, 'RON');
      if (value === 0n)
        return void issues.push(
          block('STOCK_VALUE', 'Bunurile recepționate au o valoare.', `${path}.value`),
        );
      lines.push({
        account: item.account,
        side: 'D',
        bani: value,
        memo: `${item.code} ${item.name}`,
      });
      issues.push(
        ...book.receive(
          {
            item: item.id,
            warehouse: input.warehouseId,
            account: item.account,
            quantity: parseQuantity(row.quantity)!,
            date: input.date,
          },
          value,
          lines.length - 1,
          policy,
        ),
      );
      total += value;
    });
    if (issues.length) return { effect: null, issues };
    const accrual: OpenItemSpec = {
      ref: 'uninvoiced',
      kind: 'accrual.payable',
      controlAccount: accounts.receipt.uninvoiced,
      partyId: input.supplierId,
      currency: 'RON',
      normalSide: 'C',
      mayReverse: false,
    };
    lines.push({
      account: accounts.receipt.uninvoiced,
      side: 'C',
      bani: total,
      openItem: accrual.ref,
      partyId: input.supplierId,
    });
    const effect: Effect = {
      date: input.date,
      journalClass: 'general',
      journalCode: 'CUMPARARI',
      description: `NIR pe avizul ${input.reference}`,
      lines,
      openItems: [accrual],
      taxEntries: [],
      schedules: [],
      ...book.effectPart(),
      explanation: {
        summary: `Recepția bunurilor de pe avizul ${input.reference} în gestiunea ${(warehouse as WarehouseRecord).code}: ${lei(total)} lei, factura urmând să sosească (408).`,
        details: {
          warehouseId: input.warehouseId,
          reference: input.reference,
          evidenceId: input.evidenceId,
          method: policy.method,
          clauses: ['OMFP1802/2014:pct.283-284', 'OMFP1802/2014:conturi.408'],
        },
      },
    };
    return { effect, issues };
  },
};

// ---------------------------------------------------------------------------------------------
// Consumption: the bon de consum

export const consumeInput = z
  .object({
    date: localDate,
    warehouseId: z.uuid(),
    /** The consumption slip's (bon de consum) number. */
    reference,
    evidenceId: z.uuid(),
    lines: z
      .array(
        z
          .object({
            itemId: z.uuid(),
            quantity: quantityInput,
            /** The expense it goes to, when not the stock account's own (60x): another 6xx. */
            account: z
              .string()
              .regex(/^6\d{2,3}(\.[A-Z0-9_-]{1,24})*$/)
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
export type ConsumeInput = z.infer<typeof consumeInput>;

/**
 * Materials given into consumption (the bon de consum): out of the warehouse at the policy's
 * value (OMFP nr. 1.802/2014 pct. 95 alin. (1), 96), onto each stock account's expense (601,
 * 602x, 603, 608; the functions of group 60), or the expense the slip names.
 */
export const stockConsumption: Treatment<ConsumeInput> = {
  id: 'stock.consume',
  version: 1,
  description:
    'Darea în consum (bon de consum): ieșirea din gestiune la valoarea metodei de evaluare, pe cheltuiala contului de stoc (601, 602x, 603, 608).',
  input: consumeInput,
  agent: true,
  summary:
    'Materials given into consumption (a consumption slip): out of the warehouse at the valuation method, onto the expense of their stock account.',
  toolset: 'books',
  subject: (input) => `stock:consume:${input.warehouseId}:${input.reference}`,
  plan: (input) => ({
    evidence: [input.evidenceId],
    profile: true,
    stock: positionsOf([input.warehouseId], [...new Set(input.lines.map((line) => line.itemId))]),
  }),
  evaluate(input, loaded, rules) {
    const issues: Issue[] = [];
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(block('EVIDENCE', 'Bonul de consum nu este disponibil.', 'evidenceId'));
    const warehouse = warehouseOf(loaded, input.warehouseId, 'warehouseId');
    if (isIssue(warehouse)) issues.push(warehouse);
    const policy = policyOf(loaded, input.date, issues);
    const accounts = stockAccountsAt(rules, input.date);
    if (issues.length || !policy) return { effect: null, issues };
    const lines: LineSpec[] = [];
    const book = new StockBook(loaded, lines, 'consume');
    const expenses = new Map<string, bigint>();
    input.lines.forEach((row, index) => {
      const path = `lines.${index}`;
      const item = itemOf(loaded, row.itemId, `${path}.itemId`);
      if (isIssue(item)) return void issues.push(item);
      if (item.account.startsWith('371'))
        return void issues.push(
          block(
            'STOCK_CONSUME_GOODS',
            'Mărfurile (371) ies din gestiune prin vânzare, nu prin bon de consum; pentru consumul propriu, transferați-le întâi ca materiale.',
            `${path}.itemId`,
          ),
        );
      const expense = row.account ?? expenseFor(accounts, item.account);
      if (!expense)
        return void issues.push(
          block('STOCK_EXPENSE', `Contul ${item.account} nu are o cheltuială de consum.`, path),
        );
      const line = lines.length;
      lines.push({ account: item.account, side: 'C', bani: 0n, memo: `${item.code} ${item.name}` });
      const out = book.issue(
        {
          item: item.id,
          warehouse: input.warehouseId,
          account: item.account,
          quantity: parseQuantity(row.quantity)!,
          date: input.date,
        },
        line,
        policy,
      );
      if ('issues' in out) return void issues.push(...out.issues);
      lines[line] = { ...lines[line]!, bani: out.bani };
      expenses.set(expense, (expenses.get(expense) ?? 0n) + out.bani);
    });
    if (issues.length) return { effect: null, issues };
    const credits = lines.filter((line) => line.bani !== 0n);
    if (credits.length !== lines.length)
      return {
        effect: null,
        issues: [block('STOCK_VALUE', 'Bunurile date în consum nu au valoare în gestiune.')],
      };
    lines.unshift(...expenseLines(expenses, `Bon de consum ${input.reference}`));
    // The expense lines come first: the moves' line indices shift by their number.
    const shift = lines.length - credits.length;
    const part = book.effectPart();
    const effect: Effect = {
      date: input.date,
      journalClass: 'general',
      journalCode: 'DIVERSE',
      description: `Bon de consum ${input.reference}`,
      lines,
      openItems: [],
      taxEntries: [],
      schedules: [],
      ...('stockMoves' in part
        ? {
            ...part,
            stockMoves: part.stockMoves.map((move) =>
              move.line === undefined ? move : { ...move, line: move.line + shift },
            ),
          }
        : part),
      explanation: {
        summary: `Darea în consum din gestiunea ${(warehouse as WarehouseRecord).code}, bonul ${input.reference}: ${lei(credits.reduce((sum, line) => sum + line.bani, 0n))} lei (${policy.method}).`,
        details: {
          warehouseId: input.warehouseId,
          reference: input.reference,
          evidenceId: input.evidenceId,
          method: policy.method,
          clauses: ['OMFP1802/2014-A:pct.95-96', 'OMFP1802/2014:conturi.60'],
        },
      },
    };
    return { effect, issues };
  },
};

// ---------------------------------------------------------------------------------------------
// Transfers between warehouses: the bon de predare-transfer-restituire

export const transferInput = z
  .object({
    date: localDate,
    from: z.uuid(),
    to: z.uuid(),
    reference,
    evidenceId: z.uuid(),
    lines: z
      .array(z.object({ itemId: z.uuid(), quantity: quantityInput }).strict())
      .min(1)
      .max(500),
  })
  .strict()
  .refine((input) => input.from !== input.to, {
    message: 'Gestiunile transferului diferă.',
    path: ['to'],
  });
export type TransferInput = z.infer<typeof transferInput>;

/**
 * Goods moved from one warehouse to another: they leave at the policy's value and enter at the
 * same value, a FIFO or LIFO lot keeping its receipt date. The stock account does not change, so
 * the entry has no journal lines: the register's moves only (a memo entry).
 */
export const stockTransfer: Treatment<TransferInput> = {
  id: 'stock.transfer',
  version: 1,
  description:
    'Transferul între gestiuni (bon de predare-transfer): ieșirea dintr-o gestiune și intrarea în alta la aceeași valoare, fără înregistrări în conturi.',
  input: transferInput,
  agent: true,
  summary:
    'Goods moved between warehouses (a transfer slip): out of one and into the other at the same value; register moves only, no journal lines.',
  toolset: 'books',
  subject: (input) => `stock:transfer:${input.from}:${input.reference}`,
  plan: (input) => ({
    evidence: [input.evidenceId],
    profile: true,
    stock: positionsOf(
      [input.from, input.to],
      [...new Set(input.lines.map((line) => line.itemId))],
    ),
  }),
  evaluate(input, loaded) {
    const issues: Issue[] = [];
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(block('EVIDENCE', 'Bonul de transfer nu este disponibil.', 'evidenceId'));
    for (const [field, id] of [
      ['from', input.from],
      ['to', input.to],
    ] as const) {
      const warehouse = warehouseOf(loaded, id, field);
      if (isIssue(warehouse)) issues.push(warehouse);
    }
    const policy = policyOf(loaded, input.date, issues);
    if (issues.length || !policy) return { effect: null, issues };
    const book = new StockBook(loaded, [], 'transfer');
    let total = 0n;
    input.lines.forEach((row, index) => {
      const item = itemOf(loaded, row.itemId, `lines.${index}.itemId`);
      if (isIssue(item)) return void issues.push(item);
      const moved = book.transfer(
        {
          item: item.id,
          warehouse: input.from,
          account: item.account,
          quantity: parseQuantity(row.quantity)!,
          date: input.date,
        },
        input.to,
        policy,
      );
      if ('issues' in moved) issues.push(...moved.issues);
      else total += moved.bani;
    });
    if (issues.length) return { effect: null, issues };
    const effect: Effect = {
      date: input.date,
      journalClass: 'memo',
      journalCode: 'DIVERSE',
      description: `Transfer între gestiuni ${input.reference}`,
      lines: [],
      openItems: [],
      taxEntries: [],
      schedules: [],
      ...book.effectPart(),
      explanation: {
        summary: `Transferul ${input.reference} din gestiunea ${loaded.warehouses.get(input.from)!.code} în ${loaded.warehouses.get(input.to)!.code}: ${lei(total)} lei.`,
        details: {
          from: input.from,
          to: input.to,
          reference: input.reference,
          evidenceId: input.evidenceId,
          method: policy.method,
        },
      },
    };
    return { effect, issues };
  },
};

// ---------------------------------------------------------------------------------------------
// The takeover of a balance the ledger holds into the register

export const openingInput = z
  .object({
    date: localDate,
    warehouseId: z.uuid(),
    /** The inventory list (or the stock records kept so far) the positions are taken from. */
    evidenceId: z.uuid(),
    reference,
    lines: z
      .array(z.object({ itemId: z.uuid(), quantity: quantityInput, value: amount }).strict())
      .min(1)
      .max(5000),
  })
  .strict();
export type OpeningInput = z.infer<typeof openingInput>;

/**
 * The stock the ledger already holds on a stock account (an opening balance, purchases booked
 * before the register) taken into the register, item by item, at the values of the inventory or
 * of the records kept so far: each account is debited with the items' moves and credited with
 * the same amount outside the register, so its balance is unchanged and the register now
 * explains it. It cannot take in more than the account holds outside the register at the date.
 */
export const stockOpening: Treatment<OpeningInput> = {
  id: 'stock.opening',
  version: 1,
  description:
    'Preluarea în gestiune a stocului pe care contabilitatea îl ține deja (sold inițial, intrări înregistrate înaintea gestiunii), pe articole, la valorile inventarului.',
  input: openingInput,
  agent: true,
  summary:
    'Takes stock the ledger already holds (an opening balance, earlier purchases) into the register, item by item, at the inventory values; the account balance is unchanged.',
  toolset: 'books',
  subject: (input) => `stock:opening:${input.warehouseId}:${input.reference}`,
  plan: (input) => ({
    evidence: [input.evidenceId],
    profile: true,
    stock: {
      all: true,
      items: [...new Set(input.lines.map((line) => line.itemId))],
      warehouses: [input.warehouseId],
    },
    turnover: [{ prefixes: ['3'], from: always, to: input.date }],
  }),
  evaluate(input, loaded) {
    const issues: Issue[] = [];
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(block('EVIDENCE', 'Lista de inventariere nu este disponibilă.', 'evidenceId'));
    const warehouse = warehouseOf(loaded, input.warehouseId, 'warehouseId');
    if (isIssue(warehouse)) issues.push(warehouse);
    const policy = policyOf(loaded, input.date, issues);
    if (issues.length || !policy) return { effect: null, issues };
    const query: TurnoverQuery = { prefixes: ['3'], from: always, to: input.date };
    const ledger = new Map(
      (loaded.turnover.get(turnoverKey(query)) ?? []).map((row) => [
        row.account,
        row.debit - row.credit,
      ]),
    );
    const register = new Map<string, bigint>();
    for (const position of loaded.stock.values())
      for (const layer of position.layers)
        register.set(layer.account, (register.get(layer.account) ?? 0n) + layer.bani);
    const lines: LineSpec[] = [];
    const book = new StockBook(loaded, lines, 'opening', true);
    const taken = new Map<string, bigint>();
    input.lines.forEach((row, index) => {
      const path = `lines.${index}`;
      const item = itemOf(loaded, row.itemId, `${path}.itemId`);
      if (isIssue(item)) return void issues.push(item);
      const value = parseMoney(row.value, 'RON');
      if (value === 0n)
        return void issues.push(
          block('STOCK_VALUE', 'Stocul preluat are o valoare.', `${path}.value`),
        );
      lines.push({
        account: item.account,
        side: 'D',
        bani: value,
        memo: `${item.code} ${item.name}`,
      });
      issues.push(
        ...book.receive(
          {
            item: item.id,
            warehouse: input.warehouseId,
            account: item.account,
            quantity: parseQuantity(row.quantity)!,
            date: input.date,
          },
          value,
          lines.length - 1,
          policy,
        ),
      );
      taken.set(item.account, (taken.get(item.account) ?? 0n) + value);
    });
    for (const [account, value] of taken) {
      const outside = (ledger.get(account) ?? 0n) - (register.get(account) ?? 0n);
      if (value > outside)
        issues.push(
          block(
            'STOCK_OPENING_EXCEEDS',
            `Contul ${account} ține în afara gestiunii ${lei(outside)} lei la ${input.date}; preluarea cere ${lei(value)} lei.`,
            'lines',
            { account, outside: lei(outside), taken: lei(value) },
          ),
        );
      lines.push({ account, side: 'C', bani: value, memo: 'Sold preluat în gestiune' });
    }
    if (issues.length) return { effect: null, issues };
    const effect: Effect = {
      date: input.date,
      journalClass: 'general',
      journalCode: 'DIVERSE',
      description: `Preluarea stocului în gestiune ${input.reference}`,
      lines,
      openItems: [],
      taxEntries: [],
      schedules: [],
      ...book.effectPart(),
      explanation: {
        summary: `Stocul gestiunii ${(warehouse as WarehouseRecord).code} preluat în evidența pe articole: ${[...taken].map(([account, value]) => `${account} ${lei(value)} lei`).join(', ')}.`,
        details: {
          warehouseId: input.warehouseId,
          reference: input.reference,
          evidenceId: input.evidenceId,
          method: policy.method,
        },
      },
    };
    return { effect, issues };
  },
};

// ---------------------------------------------------------------------------------------------
// The periodic weighted average: the month's costing

export const periodCostInput = z
  .object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) })
  .strict();
export type PeriodCostInput = z.infer<typeof periodCostInput>;

const monthEnd = (month: string) =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0))
    .toISOString()
    .slice(0, 10) as LocalDate;

/**
 * The month's exits under the periodic weighted average (OMFP nr. 1.802/2014 pct. 96 alin. (2):
 * the average of the stock at the period's start and of what entered in it): each exit was
 * valued at the running average when booked, and this brings the month's exits of each pool to
 * the month's average, the difference against the stock account's expense, on its last day.
 */
export const stockPeriodCost: Treatment<PeriodCostInput> = {
  id: 'stock.periodCost',
  version: 1,
  description:
    'Costul mediu ponderat al lunii: ieșirile lunii, evaluate provizoriu la costul mediu curent, aduse la media ponderată a stocului de la începutul lunii și a intrărilor ei.',
  input: periodCostInput,
  agent: true,
  summary:
    "The month's costing under the periodic weighted average: the month's exits, valued provisionally at the running average, brought to the month's weighted average.",
  toolset: 'close',
  subject: (input) => `stock:periodCost:${input.month}`,
  plan: (input) => ({
    profile: true,
    stock: {
      all: true,
      flows: { from: `${input.month}-01` as LocalDate, to: monthEnd(input.month) },
    },
  }),
  evaluate(input, loaded, rules) {
    const date = monthEnd(input.month);
    const issues: Issue[] = [];
    const policy = policyOf(loaded, date, issues);
    if (issues.length || !policy) return { effect: null, issues };
    if (policy.method !== 'periodic')
      return {
        effect: null,
        issues: [
          block(
            'STOCK_NOT_PERIODIC',
            `Politica contabilă la ${date} nu este costul mediu ponderat calculat lunar (${policy.method}).`,
          ),
        ],
      };
    const accounts = stockAccountsAt(rules, date);
    const methods = rules.param<{ periodMonths: number }>(
      'ro.stock.methods',
      'accounting_transaction_date',
      date,
    );
    if (methods.periodMonths !== 1)
      return {
        effect: null,
        issues: [
          block(
            'STOCK_PERIOD_UNSUPPORTED',
            `Costul mediu ponderat se calculează aici pe lună; o perioadă de ${methods.periodMonths} luni nu este acoperită.`,
          ),
        ],
      };
    const lines: LineSpec[] = [];
    const book = new StockBook(loaded, lines, 'period', true);
    const rows: string[] = [];
    for (const position of loaded.stock.values())
      for (const layer of position.layers) {
        if (layer.method !== 'periodic' || !layer.flows) continue;
        const { opening, entered, left } = layer.flows;
        if (left.quantity === 0n) continue;
        const quantity = opening.quantity + entered.quantity;
        if (quantity <= 0n) {
          issues.push(
            block(
              'STOCK_PERIOD_EMPTY',
              'Stocul de la începutul lunii și intrările ei nu acoperă ieșirile: costul mediu nu se poate calcula.',
              undefined,
              { item: layer.item, warehouse: layer.warehouse },
            ),
          );
          continue;
        }
        const cost = prorate(opening.bani + entered.bani, -left.quantity, quantity);
        const difference = cost - -left.bani;
        if (difference === 0n) continue;
        const expense = expenseFor(accounts, layer.account);
        if (!expense) {
          issues.push(block('STOCK_EXPENSE', `Contul ${layer.account} nu are o cheltuială.`));
          continue;
        }
        const item = loaded.stockItems.get(layer.item);
        // More cost than the exits took: the stock gives it up, the expense takes it.
        lines.push(
          { account: expense, side: 'D', bani: difference, memo: item?.code ?? layer.item },
          { account: layer.account, side: 'C', bani: difference, memo: item?.code ?? layer.item },
        );
        issues.push(
          ...book.revalue(
            {
              item: layer.item,
              warehouse: layer.warehouse,
              account: layer.account,
              quantity: 0n,
              date,
            },
            -difference,
            lines.length - 1,
          ),
        );
        rows.push(
          `${item?.code ?? layer.item}: ${formatQuantity(-left.quantity)} la ${lei(cost)} lei (provizoriu ${lei(-left.bani)})`,
        );
      }
    if (issues.length) return { effect: null, issues };
    if (!lines.length)
      return {
        effect: null,
        issues: [
          block(
            'NOTHING_TO_BOOK',
            `Ieșirile lunii ${input.month} sunt deja la costul mediu ponderat al lunii.`,
          ),
        ],
      };
    const effect: Effect = {
      date,
      journalClass: 'general',
      journalCode: 'DIVERSE',
      description: `Costul mediu ponderat al lunii ${input.month}`,
      lines,
      openItems: [],
      taxEntries: [],
      schedules: [],
      ...book.effectPart(),
      explanation: {
        summary: `Ieșirile lunii ${input.month} aduse la costul mediu ponderat al lunii: ${rows.length} articole.`,
        details: { month: input.month, rows, clauses: ['OMFP1802/2014-A:pct.95-96'] },
      },
    };
    return { effect, issues };
  },
};

// ---------------------------------------------------------------------------------------------
// Write-downs to the net realizable value (pct. 292)

export const stockImpairmentInput = z
  .object({
    date: localDate,
    /** The commission's (or an evaluator's) findings on the items' net realizable value. */
    evidenceId: z.uuid(),
    /** Each item's net realizable value, over every warehouse holding it. */
    items: z.array(z.object({ itemId: z.uuid(), value: amount }).strict()).max(5000),
  })
  .strict();
export type StockImpairmentInput = z.infer<typeof stockImpairmentInput>;

/** The analytics item an item's write-down is tagged with on its allowance account. */
export const stockImpairmentTag = (itemId: string) => `impairment:stock:${itemId}`;

/**
 * Stock written down to its net realizable value (OMFP nr. 1.802/2014 pct. 292: "valoarea
 * stocurilor se diminuează până la valoarea realizabilă netă, prin reflectarea unei ajustări
 * pentru depreciere"): each item's allowance on its group-39 account, tagged by item, brought to
 * its cost less that value (Dr 6814 / Cr 39x), and released when the value rose or the goods left
 * the register (Dr 39x / Cr 7814, pct. 95 alin. (3)). The goods stay at their cost.
 */
export const stockImpairment: Treatment<StockImpairmentInput> = {
  id: 'impairment.stock',
  version: 1,
  description:
    'Ajustările pentru deprecierea stocurilor la valoarea realizabilă netă (39x): constituite, majorate sau reluate pe fiecare articol.',
  input: stockImpairmentInput,
  agent: true,
  summary:
    "Writes stock down to its net realizable value: each item's allowance on 39x brought to its cost less that value, released when it rose or the goods left.",
  toolset: 'close',
  subject: (input) => `impairment:stock:${input.date}`,
  plan: (input) => ({
    evidence: [input.evidenceId],
    profile: true,
    stock: { all: true, items: input.items.map((row) => row.itemId) },
    itemLines: { prefixes: ['39'] },
  }),
  evaluate(input, loaded, rules) {
    const issues: Issue[] = [];
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(
        block(
          'EVIDENCE',
          'Constatările privind valoarea realizabilă nu sunt disponibile.',
          'evidenceId',
        ),
      );
    const accounts = stockAccountsAt(rules, input.date);
    const cost = new Map<string, bigint>();
    for (const position of loaded.stock.values())
      for (const layer of position.layers)
        cost.set(layer.item, (cost.get(layer.item) ?? 0n) + layer.bani);
    const held = new Map<string, { account: string; bani: bigint }>();
    for (const row of loaded.itemLines.get(itemLinesKey({ prefixes: ['39'] })) ?? [])
      if (row.item.startsWith('impairment:stock:'))
        held.set(row.item.slice('impairment:stock:'.length), {
          account: row.account,
          bani: row.credit - row.debit,
        });
    const values = new Map(input.items.map((row) => [row.itemId, parseMoney(row.value, 'RON')]));
    if (values.size !== input.items.length)
      issues.push(block('DUPLICATE', 'Un articol apare de mai multe ori.', 'items'));
    const lines: LineSpec[] = [];
    const rows: JsonValue[] = [];
    const ids = [...new Set([...values.keys(), ...held.keys()])].sort();
    for (const itemId of ids) {
      const item = loaded.stockItems.get(itemId);
      if (!item) {
        issues.push(block('STOCK_ITEM_UNKNOWN', 'Articolul de stoc nu există.', 'items'));
        continue;
      }
      const allowance = allowanceFor(accounts, item.account);
      if (!allowance) {
        issues.push(block('STOCK_ALLOWANCE', `Contul ${item.account} nu are cont de ajustări.`));
        continue;
      }
      const carrying = cost.get(itemId) ?? 0n;
      const value = values.get(itemId);
      // Not listed: the allowance stays, unless the goods left the register (pct. 95 alin. (3)).
      const needed =
        value === undefined
          ? carrying === 0n
            ? 0n
            : (held.get(itemId)?.bani ?? 0n)
          : carrying > value
            ? carrying - value
            : 0n;
      const delta = needed - (held.get(itemId)?.bani ?? 0n);
      if (delta === 0n) continue;
      const tag = { item: stockImpairmentTag(itemId) };
      if (delta > 0n)
        lines.push(
          { account: accounts.impairment.expense, side: 'D', bani: delta, analytics: tag },
          { account: allowance, side: 'C', bani: delta, analytics: tag },
        );
      else
        lines.push(
          { account: allowance, side: 'D', bani: -delta, analytics: tag },
          { account: accounts.impairment.revenue, side: 'C', bani: -delta, analytics: tag },
        );
      rows.push({
        item: item.code,
        cost: lei(carrying),
        value: value === undefined ? null : lei(value),
        allowance: lei(needed),
        change: lei(delta),
      });
    }
    if (issues.length) return { effect: null, issues };
    if (!lines.length)
      return {
        effect: null,
        issues: [block('NOTHING_TO_BOOK', 'Ajustările stocurilor sunt la nivelul constatat.')],
      };
    const effect: Effect = {
      schema: 'effect@1',
      date: input.date,
      journalClass: 'general',
      journalCode: 'DIVERSE',
      description: `Ajustări pentru deprecierea stocurilor la ${input.date}`,
      lines,
      openItems: [],
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: `Stocurile la valoarea realizabilă netă la ${input.date}: ${rows.length} articole.`,
        details: {
          rows,
          evidenceId: input.evidenceId,
          // The profit tax adds a stock write-down back (art. 26 lists no stock), and does not
          // tax the release of one never deducted.
          profit: { kind: 'impairment.stock', deductible: false },
          clauses: ['OMFP1802/2014:pct.289-292', 'OMFP1802/2014:conturi.39'],
        },
      },
    };
    return { effect, issues };
  },
};

export const stockTreatments = [
  stockReceipt,
  stockConsumption,
  stockTransfer,
  stockOpening,
  stockPeriodCost,
  stockImpairment,
] as const;

/** The policy axes the treatments read, with their values (`profile.record`). */
export const stockPolicyAxes = {
  'policy.stock.valuation': ['fifo', 'lifo', 'average', 'periodic'],
  'policy.stock.inventory': ['permanent', 'intermittent'],
  'policy.stock.negative': ['refuse', 'allow'],
  'policy.stock.retail': ['cost', 'retail'],
} as const;
