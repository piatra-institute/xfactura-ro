import { z } from 'zod';
import {
  formatQuantity,
  parseQuantity,
  profileAt,
  vatPeriodOf,
  type Effect,
  type Issue,
  type JsonValue,
  type LineSpec,
  type Loaded,
  type OpenItemSpec,
  type TaxEntrySpec,
  type Treatment,
} from '../../kernel';
import { formatMoney, parseMoney } from '../../money';
import type { RuleContext } from '../../rules';
import { isLocalDate, type LocalDate } from '../../time';
import { adjustmentCodes } from '../exempt/codes';
import { inventoryDocumentKind, inventoryListSchema } from '../yearend/documents';
import type { InventoryAccounts } from '../yearend/parameters';
import { compareStock, nextDay, registerAt, type StockDifference } from './count';
import { expenseFor, productionStockAccounts } from './parameters';
import { stockAccountsAt } from './treatments';
import { retailMethodAt, StockBook, stockPolicyAt } from './valuation';

/*
 * The stock differences of a count (OMF nr. 2.861/2009 pct. 39–41; OMFP nr. 1.802/2014 pct. 95
 * alin. (2) and the functions of 371, 30x, 381 and 60x): each item in each warehouse whose
 * counted quantity differs from the register's, booked on the count's date. A shortage leaves the
 * register at the policy's value onto the stock account's expense; its deducted VAT is adjusted
 * (Codul fiscal art. 304; norme pct. 7 alin. (5), pct. 78 alin. (6)) unless the goods were
 * destroyed, lost or stolen and that is shown, or the loss is a perishable's or a technological
 * one within the limits set by law (pct. 78 alin. (10)); a shortage the administrator imputes is
 * charged to the person at the replacement value (pct. 40 alin. (2)), no VAT collected on it. A
 * surplus enters at the value the commission sets (pct. 75 alin. (1)) against the same expense.
 * Compensating shortages with surpluses (pct. 40 alin. (3)–(5)) is not built.
 */

const localDate = z
  .string()
  .refine((value): boolean => isLocalDate(value), 'Dată invalidă.')
  .transform((value) => value as LocalDate);
const amount = z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/);
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

/** Why goods are missing, as the administrator's decision on the proces-verbal states it. */
export const shortageCauses = [
  /** Imputed to the person found guilty, at the replacement value. */
  'imputed',
  /** Nobody answers for it, and it is none of the cases below: its VAT is adjusted. */
  'unimputable',
  /** Perishables within the limits set by law (pct. 78 alin. (10) lit. f)). */
  'perishable',
  /** Technological losses within the limits set by law or the company's norm (lit. e)). */
  'technological',
  /** A natural calamity or force majeure, shown (lit. a)). */
  'calamity',
  /** A theft shown by the judicial authorities' documents (lit. b)). */
  'theft',
  /** Degraded goods that cannot be sold, their destruction shown (lit. d)). */
  'degraded',
] as const;
export type ShortageCause = (typeof shortageCauses)[number];
/** The causes whose deducted VAT is not adjusted (pct. 78 alin. (10)); each needs its proof. */
const unadjusted: readonly ShortageCause[] = [
  'perishable',
  'technological',
  'calamity',
  'theft',
  'degraded',
];

export const stockCountInput = z
  .object({
    /** The count's date, the day the differences are booked on (OMFP 1802/2014 pct. 95
     * alin. (2)). */
    date: localDate,
    /** The inventory lists of that date with a stock section. */
    documentIds: z.array(z.uuid()).min(1).max(50),
    /** The administrator's decision on the commission's proces-verbal (pct. 42–43). */
    evidenceId: z.uuid(),
    /** Each shortage's cause, by item and warehouse. */
    causes: z
      .array(
        z
          .object({
            itemId: z.uuid(),
            warehouseId: z.uuid(),
            cause: z.enum(shortageCauses),
            /** The proof of a cause whose VAT is not adjusted: the calamity's report, the police's
             * documents, the destruction's record, the norm of perishables. */
            evidenceId: z.uuid().optional(),
            /** An imputed shortage: to whom, an employee (4282) or another person (461), and the
             * replacement value (pct. 40 alin. (2): the cost of a similar good, VAT included). */
            partyId: z.uuid().optional(),
            employee: z.boolean().optional(),
            amount: amount.optional(),
          })
          .strict(),
      )
      .max(5000)
      .default([]),
  })
  .strict();
export type StockCountInput = z.infer<typeof stockCountInput>;

/** The VAT rate a shortage's deduction was taken at: the acquisition's (pct. 78 alin. (13)), by
 * the item's category; null for an item whose purchase deducted none. */
function rateFor(
  rules: RuleContext,
  category: string | null,
  date: LocalDate,
): string | null | 'unknown' {
  if (category === 'exempt' || category === 'outside') return null;
  if (category === 'standard')
    return rules.param<string>('ro.vat.rate', 'vat_chargeability_date', date, { category: 'S' });
  if (category === 'reduced')
    return rules.param<string>('ro.vat.rate.reduced', 'vat_chargeability_date', date);
  return 'unknown';
}

/** `value × rate ÷ 100`, half up. */
const vatOf = (value: bigint, rate: string) => {
  const [whole, fraction = ''] = rate.split('.');
  const scaled = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
  return (value * scaled * 2n + 10000n) / 20000n;
};

/**
 * The stock differences of an inventory, booked on its date: shortages out of the register at
 * the policy's value, with their VAT adjusted or not as their cause decides and imputed when the
 * administrator decides so; surpluses in at the commission's value.
 */
export const stockCount: Treatment<StockCountInput> = {
  id: 'inventory.stock',
  version: 1,
  description:
    'Diferențele de stoc constatate la inventariere: lipsurile scoase din gestiune la valoarea metodei de evaluare, cu ajustarea TVA deduse după cauza lor și imputarea hotărâtă de administrator; plusurile intrate la valoarea stabilită de comisie.',
  input: stockCountInput,
  agent: true,
  summary:
    'Books the stock differences of a count: shortages out at the valuation method, their VAT adjusted as their cause decides, imputed where decided; surpluses in at the commission value.',
  toolset: 'close',
  subject: (input) => `inventory:stock:${input.date}`,
  plan: (input) => ({
    documents: input.documentIds,
    evidence: [
      input.evidenceId,
      ...input.causes.flatMap((cause) => (cause.evidenceId ? [cause.evidenceId] : [])),
    ],
    parties: [...new Set(input.causes.flatMap((cause) => (cause.partyId ? [cause.partyId] : [])))],
    profile: true,
    stock: {
      all: true,
      catalogue: true,
      flows: { from: nextDay(input.date), to: '9999-12-31' as LocalDate },
      // A shortage leaves at what its position held on the count's date.
      dated: true,
    },
  }),
  evaluate(input, loaded, rules) {
    const issues: Issue[] = [];
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(
        block(
          'EVIDENCE',
          'Decizia administratorului asupra procesului-verbal nu este disponibilă.',
          'evidenceId',
        ),
      );
    const rows: { row: z.infer<typeof inventoryListSchema>['stock'] }[] = [];
    input.documentIds.forEach((id, index) => {
      const document = loaded.documents.get(id);
      const parsed = document ? inventoryListSchema.safeParse(document.body) : null;
      if (!document || document.kind !== inventoryDocumentKind || !parsed?.success)
        return void issues.push(
          block(
            'INVENTORY_LIST',
            'Documentul nu este o listă de inventariere.',
            `documentIds.${index}`,
          ),
        );
      if (parsed.data.date !== input.date)
        return void issues.push(
          block(
            'INVENTORY_DATE',
            `Lista este la ${parsed.data.date}, nu la ${input.date}.`,
            `documentIds.${index}`,
          ),
        );
      rows.push({ row: parsed.data.stock });
    });
    const warehouses = new Map(
      [...loaded.warehouses.values()].map((store) => [store.code, store.id]),
    );
    // The warehouses the lists count by quantity are kept at cost (one at retail price is counted
    // by `retail.count`).
    const counted = rows.flatMap((list) =>
      (list.row ?? []).flatMap((row) => {
        const id = row.warehouse ? warehouses.get(row.warehouse) : undefined;
        return id ? [id] : [];
      }),
    );
    const policy = stockPolicyAt(loaded, input.date, counted);
    if (Array.isArray(policy)) issues.push(...policy);
    if (issues.length || Array.isArray(policy)) return { effect: null, issues };
    const accounts = stockAccountsAt(rules, input.date);
    const inventory = rules.param<InventoryAccounts>(
      'ro.inventory.accounts',
      'accounting_transaction_date',
      input.date,
    );
    const adjustment = rules.param<{ expense: string }>(
      'ro.vat.stock_adjustment',
      'vat_chargeability_date',
      input.date,
    );
    const items = new Map([...loaded.stockItems.values()].map((item) => [item.code, item]));
    const comparison = compareStock(
      rows.flatMap((list) => list.row ?? []),
      registerAt(loaded),
      { items, warehouses },
    );
    for (const problem of comparison.problems) issues.push(block('INVENTORY_STOCK_ROW', problem));
    for (const gap of comparison.gaps) issues.push(block('INVENTORY_UNLISTED', gap));
    if (issues.length) return { effect: null, issues };
    if (!comparison.differences.length)
      return {
        effect: null,
        issues: [
          block('NOTHING_TO_BOOK', `Listele de la ${input.date} nu arată diferențe de stoc.`),
        ],
      };

    const lines: LineSpec[] = [];
    const openItems: OpenItemSpec[] = [];
    const taxEntries: TaxEntrySpec[] = [];
    const book = new StockBook(loaded, lines, 'count', true);
    const payer = profileAt(loaded, 'vat.status', input.date) === 'normal_vat';
    const taxPeriod = vatPeriodOf(loaded, input.date);
    const used = new Set<number>();
    const notes: JsonValue[] = [];
    let unimputable = 0n;
    const causeOf = (difference: StockDifference) => {
      const index = input.causes.findIndex(
        (cause) => cause.itemId === difference.item && cause.warehouseId === difference.warehouse,
      );
      if (index >= 0) used.add(index);
      return index >= 0 ? { cause: input.causes[index]!, index } : null;
    };
    for (const difference of comparison.differences) {
      const item = loaded.stockItems.get(difference.item)!;
      const expense = expenseFor(accounts, item.account);
      if (!expense) {
        issues.push(block('STOCK_EXPENSE', `Contul ${item.account} nu are o cheltuială.`));
        continue;
      }
      const target = {
        item: item.id,
        warehouse: difference.warehouse,
        account: item.account,
        quantity: difference.book - difference.counted,
        date: input.date,
      };
      if (difference.counted > difference.book) {
        // A surplus, at the commission's value (pct. 75 alin. (1): the fair value).
        if (difference.value === null || difference.value === 0n) {
          issues.push(
            block(
              'STOCK_SURPLUS_VALUE',
              `Plusul de ${formatQuantity(difference.counted - difference.book)} ${difference.unit} la ${difference.code} (${difference.warehouseCode}) cere valoarea stabilită de comisie în listă.`,
            ),
          );
          continue;
        }
        lines.push({
          account: item.account,
          side: 'D',
          bani: difference.value,
          memo: `Plus la inventar ${item.code}`,
        });
        issues.push(
          ...book.receive(
            { ...target, quantity: difference.counted - difference.book },
            difference.value,
            lines.length - 1,
            policy,
            expense,
          ),
        );
        lines.push({
          account: accounts.count.surplus ?? expense,
          side: 'C',
          bani: difference.value,
          memo: `Plus la inventar ${item.code}`,
        });
        notes.push({
          item: item.code,
          warehouse: difference.warehouseCode,
          surplus: formatQuantity(difference.counted - difference.book),
          value: lei(difference.value),
        });
        continue;
      }
      // A shortage: out at the policy's value (pct. 95 alin. (2)).
      const found = causeOf(difference);
      if (!found) {
        issues.push(
          block(
            'STOCK_SHORTAGE_CAUSE',
            `Lipsa de ${formatQuantity(target.quantity)} ${difference.unit} la ${difference.code} (${difference.warehouseCode}) cere cauza hotărâtă de administrator: imputată, neimputabilă, perisabilități, pierderi tehnologice, calamitate, furt sau degradare dovedite.`,
            'causes',
          ),
        );
        continue;
      }
      const { cause, index } = found;
      const path = `causes.${index}`;
      const before = book.moves.length;
      const line = lines.length;
      lines.push({
        account: item.account,
        side: 'C',
        bani: 0n,
        memo: `Lipsă la inventar ${item.code}`,
      });
      const out = book.issue(target, line, policy);
      if ('issues' in out) {
        issues.push(...out.issues);
        continue;
      }
      lines[line] = { ...lines[line]!, bani: out.bani };
      lines.push({
        account: expense,
        side: 'D',
        bani: out.bani,
        memo: `Lipsă la inventar ${item.code}`,
      });
      if (unadjusted.includes(cause.cause)) {
        if (!cause.evidenceId || !loaded.evidence.has(cause.evidenceId))
          issues.push(
            block(
              'STOCK_CAUSE_PROOF',
              `Cauza lipsei la ${item.code} (${cause.cause}) se dovedește cu documentul ei (pct. 78 alin. (10), (12)).`,
              path,
            ),
          );
        if (cause.cause === 'perishable' || cause.cause === 'technological')
          issues.push(
            ack(
              'STOCK_LOSS_LIMITS',
              `Lipsa la ${item.code} este declarată ${cause.cause === 'perishable' ? 'perisabilitate' : 'pierdere tehnologică'} în limitele legale: aplicația nu cunoaște limitele (normele de perisabilitate nu sunt în registrul surselor); peste ele, TVA se ajustează și cheltuiala nu se deduce. Confirmați încadrarea.`,
            ),
          );
      } else if (payer) {
        // A product or work in progress (G4) was not bought: the VAT deducted on what it was
        // made of is adjusted on its production cost, at its sale category's rate.
        if (productionStockAccounts.some((account) => item.account.startsWith(account)))
          issues.push(
            ack(
              'PRODUCT_SHORTAGE_VAT',
              `Lipsa la ${item.code} este un produs al companiei: TVA dedusă pentru materialele și serviciile încorporate se ajustează pe costul lui de producție, la cota categoriei lui (${item.vatCategory ?? 'necunoscută'}); cotele intrărilor nu sunt urmărite. Confirmați.`,
            ),
          );
        // Its deducted VAT is adjusted at the acquisition's rate: the lot's date, or, for an
        // average pool whose acquisition cannot be told, the count's (pct. 78 alin. (13)).
        for (const move of book.moves.slice(before)) {
          const lot = [...(loaded.stock.get(`${move.item}|${move.warehouse}`)?.layers ?? [])].find(
            (layer) => layer.id === move.layer,
          );
          const at =
            lot && (lot.method === 'fifo' || lot.method === 'lifo') ? lot.date : input.date;
          const rate = rateFor(rules, item.vatCategory, at);
          if (rate === 'unknown') {
            issues.push(
              block(
                'STOCK_VAT_CATEGORY',
                `Articolul ${item.code} nu are regimul TVA (vatCategory): ajustarea taxei deduse nu se poate calcula.`,
                path,
              ),
            );
            break;
          }
          if (rate === null) continue;
          const vat = vatOf(-move.bani, rate);
          if (vat === 0n) continue;
          lines.push({
            account: adjustment.expense,
            side: 'D',
            bani: vat,
            memo: `TVA ajustată, lipsă ${item.code}`,
          });
          lines.push({
            account: '4426',
            side: 'C',
            bani: vat,
            memo: `TVA ajustată, lipsă ${item.code}`,
          });
          taxEntries.push({
            key: `vat:${item.code}:${difference.warehouseCode}:${taxEntries.length + 1}`,
            tax: 'VAT',
            code: adjustmentCodes.stock,
            direction: 'input',
            baseBani: 0n,
            taxBani: -vat,
            deductibleBani: -vat,
            ledgerBani: -vat,
            line: lines.length - 1,
            taxPoint: input.date,
            exigibility: input.date,
            taxPeriod,
            attributes: { cause: cause.cause, item: item.code, rate, event: 'shortage' },
          });
        }
      }
      if (cause.cause === 'imputed') {
        const value = cause.amount === undefined ? 0n : parseMoney(cause.amount, 'RON');
        if (
          !cause.partyId ||
          !loaded.parties.has(cause.partyId) ||
          cause.employee === undefined ||
          value === 0n
        ) {
          issues.push(
            block(
              'IMPUTATION',
              'O lipsă imputată numește persoana (partyId, employee) și valoarea de înlocuire (amount).',
              path,
            ),
          );
          continue;
        }
        if (cause.employee)
          lines.push({
            account: inventory.imputation.employee,
            side: 'D',
            bani: value,
            partyId: cause.partyId,
            analytics: { item: `inventory:${input.date}:stock:${item.code}` },
            memo: `Lipsă imputată ${item.code}`,
          });
        else {
          const ref = `imputation-${openItems.length + 1}`;
          openItems.push({
            ref,
            kind: 'receivable',
            controlAccount: inventory.imputation.third,
            partyId: cause.partyId,
            currency: 'RON',
            normalSide: 'D',
            mayReverse: false,
          });
          lines.push({
            account: inventory.imputation.third,
            side: 'D',
            bani: value,
            openItem: ref,
            partyId: cause.partyId,
            memo: `Lipsă imputată ${item.code}`,
          });
        }
        lines.push({
          account: inventory.imputation.revenue,
          side: 'C',
          bani: value,
          memo: `Lipsă imputată ${item.code}`,
        });
      } else if (cause.cause === 'unimputable') unimputable += out.bani;
      notes.push({
        item: item.code,
        warehouse: difference.warehouseCode,
        shortage: formatQuantity(target.quantity),
        value: lei(out.bani),
        cause: cause.cause,
      });
    }
    input.causes.forEach((_, index) => {
      if (!used.has(index))
        issues.push(
          block('CAUSE_UNMATCHED', 'Cauza nu privește o lipsă constatată.', `causes.${index}`),
        );
    });
    if (unimputable)
      issues.push(
        ack(
          'PROFIT_SHORTAGE',
          `Lipsurile neimputabile (${lei(unimputable)} lei) și TVA lor nu sunt deductibile la impozitul pe profit (art. 25 alin. (4) lit. c) din Codul fiscal): se adaugă la rezultatul fiscal.`,
        ),
      );
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };
    const part = book.effectPart();
    const effect: Effect = {
      date: input.date,
      journalClass: 'general',
      journalCode: 'DIVERSE',
      description: `Diferențe de stoc la inventarierea din ${input.date}`,
      lines,
      openItems,
      taxEntries,
      schedules: [],
      ...part,
      explanation: {
        summary: `Diferențele de stoc la ${input.date}: ${notes.length} articole.`,
        details: {
          rows: notes,
          evidenceId: input.evidenceId,
          ...(unimputable
            ? { profit: { kind: 'inventory.stock', nondeductible: lei(unimputable) } }
            : {}),
          clauses: [
            'OMF2861/2009-A:pct.40',
            'OMFP1802/2014:pct.95(2)-(3)',
            'OMFP1802/2014:conturi.371-378',
            'ANAF/Cod-fiscal-consolidat:norme.art.270.pct.7(5)',
            'ANAF/Cod-fiscal-consolidat:art.304(1)-(2)',
            'ANAF/Cod-fiscal-consolidat:norme.art.304.pct.78(10)-(13)',
          ],
        },
      },
    };
    return { effect, issues };
  },
};

/** The register as `inventory.differences` reads it: whether every stock account's balance is
 * the register's on the date, so that the count's stock is `inventory.stock`'s. */
export function registerExplainsStock(
  loaded: Loaded,
  ledger: readonly { account: string; bani: bigint }[],
): boolean {
  if (!loaded.stock.size) return false;
  const held = new Map<string, bigint>();
  for (const position of registerAt(loaded))
    held.set(position.account, (held.get(position.account) ?? 0n) + position.bani);
  const accounts = new Set([...held.keys(), ...ledger.map((row) => row.account)]);
  return [...accounts].every(
    (account) =>
      (held.get(account) ?? 0n) === (ledger.find((row) => row.account === account)?.bani ?? 0n),
  );
}

// ---------------------------------------------------------------------------------------------
// The periodic inventory (inventarul intermitent, OMFP 1802/2014 pct. 289–291)

export const intermittentInput = z
  .object({
    /** The period's end, when the stock is counted (pct. 291 alin. (2): no later than the end of
     * the period the taxes are determined for). */
    date: localDate,
    /** The inventory lists of that date, each row valued at cost by the commission. */
    documentIds: z.array(z.uuid()).min(1).max(50),
    /** The administrator's approval of the count. */
    evidenceId: z.uuid(),
  })
  .strict();
export type IntermittentInput = z.infer<typeof intermittentInput>;

/**
 * The period's end under the periodic inventory (pct. 291): purchases went to the expense
 * accounts (601–603, 607, 608; the function of 401), and the count sets the stock. The stock the
 * register held since the last count leaves it onto those expenses, and the stock counted enters
 * at the values the lists give (Dr 30x, 371, 381 / Cr 60x), so the period's exits are the opening
 * stock plus the purchases less the closing stock (alin. (4)). Not with the retail price method's
 * global value (alin. (5)).
 */
export const stockIntermittent: Treatment<IntermittentInput> = {
  id: 'stock.intermittent',
  version: 1,
  description:
    'Stocul de la sfârșitul perioadei la inventarul intermitent: stocul anterior trece pe cheltuieli, iar stocul inventariat intră în gestiune la valorile listelor.',
  input: intermittentInput,
  agent: true,
  summary:
    "The period's end under the periodic inventory: the previous count's stock goes to the expenses and the counted stock enters at the lists' values.",
  toolset: 'close',
  subject: (input) => `stock:intermittent:${input.date}`,
  plan: (input) => ({
    documents: input.documentIds,
    evidence: [input.evidenceId],
    profile: true,
    stock: { all: true, catalogue: true },
  }),
  evaluate(input, loaded, rules) {
    const issues: Issue[] = [];
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(block('EVIDENCE', 'Aprobarea inventarierii nu este disponibilă.', 'evidenceId'));
    if (profileAt(loaded, 'policy.stock.inventory', input.date) !== 'intermittent')
      issues.push(
        block(
          'STOCK_NOT_INTERMITTENT',
          `Politica contabilă la ${input.date} nu este inventarul intermitent (policy.stock.inventory).`,
        ),
      );
    if (
      profileAt(loaded, 'policy.stock.retail', input.date) === 'retail' ||
      [...loaded.warehouses.keys()].some(
        (id) => retailMethodAt(loaded, id, input.date) === 'retail',
      )
    )
      issues.push(
        block(
          'STOCK_INTERMITTENT_RETAIL',
          'Inventarul intermitent nu se folosește în comerțul cu amănuntul la metoda global-valorică (OMFP 1802/2014 pct. 291 alin. (5)).',
        ),
      );
    const method = profileAt(loaded, 'policy.stock.valuation', input.date);
    if (method !== 'fifo' && method !== 'lifo' && method !== 'average' && method !== 'periodic')
      issues.push(
        block(
          'POLICY_MISSING',
          'Înregistrați metoda de evaluare a stocurilor (policy.stock.valuation).',
        ),
      );
    const rows: NonNullable<z.infer<typeof inventoryListSchema>['stock']> = [];
    input.documentIds.forEach((id, index) => {
      const document = loaded.documents.get(id);
      const parsed = document ? inventoryListSchema.safeParse(document.body) : null;
      if (!document || document.kind !== inventoryDocumentKind || !parsed?.success)
        return void issues.push(
          block(
            'INVENTORY_LIST',
            'Documentul nu este o listă de inventariere.',
            `documentIds.${index}`,
          ),
        );
      if (parsed.data.date !== input.date)
        return void issues.push(
          block(
            'INVENTORY_DATE',
            `Lista este la ${parsed.data.date}, nu la ${input.date}.`,
            `documentIds.${index}`,
          ),
        );
      rows.push(...(parsed.data.stock ?? []));
    });
    if (issues.length) return { effect: null, issues };
    const policy = { method: method as 'fifo', negative: false };
    const accounts = stockAccountsAt(rules, input.date);
    const items = new Map([...loaded.stockItems.values()].map((item) => [item.code, item]));
    const warehouses = new Map(
      [...loaded.warehouses.values()].map((store) => [store.code, store.id]),
    );
    const lines: LineSpec[] = [];
    const book = new StockBook(loaded, lines, 'count', true);
    const expenses = new Map<string, bigint>();
    // The previous count's stock leaves the register, whole.
    for (const position of [...loaded.stock.values()].sort((a, b) => (a.item < b.item ? -1 : 1))) {
      const item = loaded.stockItems.get(position.item)!;
      const held = book.held(position.item, position.warehouse)!;
      if (held.quantity === 0n) continue;
      const line = lines.length;
      lines.push({ account: item.account, side: 'C', bani: 0n, memo: `Stoc inițial ${item.code}` });
      const out = book.issue(
        {
          item: item.id,
          warehouse: position.warehouse,
          account: item.account,
          quantity: held.quantity,
          date: input.date,
        },
        line,
        policy,
      );
      if ('issues' in out) {
        issues.push(...out.issues);
        continue;
      }
      lines[line] = { ...lines[line]!, bani: out.bani };
      const expense = expenseFor(accounts, item.account)!;
      expenses.set(expense, (expenses.get(expense) ?? 0n) + out.bani);
    }
    // The counted stock enters at the lists' values.
    const seen = new Set<string>();
    rows.forEach((row, index) => {
      const item = items.get(row.code);
      const warehouse = row.warehouse ? warehouses.get(row.warehouse) : undefined;
      const quantity = parseQuantity(row.quantity);
      if (!item || !warehouse || quantity === null)
        return void issues.push(
          block(
            'INVENTORY_STOCK_ROW',
            `Rândul de stoc ${index + 1} (${row.code}) nu are un articol, o gestiune sau o cantitate valide.`,
          ),
        );
      const key = `${item.id}|${warehouse}`;
      if (seen.has(key))
        return void issues.push(
          block('INVENTORY_STOCK_ROW', `Articolul ${row.code} apare de două ori în gestiune.`),
        );
      seen.add(key);
      if (quantity === 0n) return;
      if (row.value === undefined)
        return void issues.push(
          block(
            'STOCK_COUNT_VALUE',
            `Rândul ${row.code} nu are valoarea stabilită de comisie: la inventarul intermitent stocul intră la valorile listei.`,
          ),
        );
      const value = parseMoney(row.value, 'RON');
      lines.push({
        account: item.account,
        side: 'D',
        bani: value,
        memo: `Stoc final ${item.code}`,
      });
      issues.push(
        ...book.receive(
          { item: item.id, warehouse, account: item.account, quantity, date: input.date },
          value,
          lines.length - 1,
          policy,
        ),
      );
      const expense = expenseFor(accounts, item.account)!;
      expenses.set(expense, (expenses.get(expense) ?? 0n) - value);
    });
    if (issues.length) return { effect: null, issues };
    for (const [account, bani] of expenses)
      if (bani !== 0n)
        lines.push({
          account,
          side: bani > 0n ? 'D' : 'C',
          bani: bani > 0n ? bani : -bani,
          memo: 'Variația stocului',
        });
    if (!book.moves.length)
      return { effect: null, issues: [block('NOTHING_TO_BOOK', 'Nu există stoc de înregistrat.')] };
    issues.push(
      ack(
        'STOCK_COUNT_VALUES',
        `Stocul inventariat intră la valorile listelor: la inventarul intermitent aplicația nu urmărește costul pe articole, iar valorile se stabilesc de comisie după metoda de evaluare (${method}). Confirmați.`,
      ),
    );
    const effect: Effect = {
      date: input.date,
      journalClass: 'general',
      journalCode: 'DIVERSE',
      description: `Stocul la ${input.date} (inventar intermitent)`,
      lines,
      openItems: [],
      taxEntries: [],
      schedules: [],
      ...book.effectPart(),
      explanation: {
        summary: `Stocul la ${input.date} după inventarierea faptică: ${seen.size} articole.`,
        details: {
          evidenceId: input.evidenceId,
          clauses: [
            'OMFP1802/2014:pct.289-292',
            'OMFP1802/2014:conturi.401(intermitent)',
            'OMFP1802/2014:conturi.30',
          ],
        },
      },
    };
    return { effect, issues };
  },
};
