import { z } from 'zod';
import { Amount, dateSchema, moneySchema, signedMoneySchema } from '../../values';

/*
 * The annual inventory's lists (OMF nr. 2.861/2009, the norms' pct. 18, 28–35), as an agent
 * transcribes them from the signed lists with `documents.record` (kind `inventory.list`), each
 * amount citing the line it was read from. One list may cover any of the sections; a section left
 * null is not covered by it, so the year's lists together must cover what the books hold:
 * - fixed assets by inventory number, found or missing, with the value the commission sets when
 *   it is below the books' (pct. 34 alin. (2), 37–38) and the value of an asset found in surplus;
 * - cash counted per cash desk and currency on the last working day (pct. 29 alin. (3));
 * - bank balances on the statements of the financial year's last day (pct. 29 alin. (2));
 * - receivables and payables as each partner confirmed them on its statement of account, or
 *   disputed, or without a reply (pct. 28);
 * - stock by quantity, each item by its catalogue code in its warehouse, with the commission's
 *   value where it sets one (a surplus, an intermittent inventory's count): the stock register's
 *   (G1) differences are `inventory.stock`'s.
 * The commission's appointing decision (pct. 6) is cited; its proces-verbal and the
 * administrator's decision on it (pct. 42–43) are the evidence of the booking of the differences.
 */

export const inventorySchemaVersion = 'extracted-inventory-list-1';
export const inventoryDocumentKind = 'inventory.list';
export const isInventoryKind = (kind: string) => kind === inventoryDocumentKind;

const name = z.string().trim().min(1).max(500);
const label = z.string().trim().min(1).max(500);
const taxId = z.string().trim().min(1).max(30);
const currency = z.string().regex(/^[A-Z]{3}$/);
const note = z.string().trim().min(1).max(1000).nullable();
const quantity = z.string().regex(/^(0|[1-9]\d{0,12})(\.\d{1,4})?$/);

const assetRow = z
  .object({
    /** The inventory number (the register's card). */
    number: z.string().trim().min(1).max(100),
    name: label,
    /** Whether the commission found it. */
    found: z.boolean(),
    /** The value the commission sets: an asset found below the books' value (impaired), or one
     * found in surplus; null when the books' value stands, or the asset is missing. */
    value: moneySchema.nullable(),
    /** The cause the commission records (an impairment, a shortage, a surplus). */
    note,
  })
  .strict();
const cashRow = z
  .object({
    /** The cash desk's ledger account (5311, 5314 or an analytic). */
    account: z.string().regex(/^531\d(\.[\dA-Z_-]{1,20})?$/),
    currency,
    counted: moneySchema,
  })
  .strict();
const bankRow = z
  .object({
    account: z.string().regex(/^512\d(\.[\dA-Z_-]{1,20})?$/),
    currency,
    iban: z.string().trim().min(15).max(42).nullable(),
    /** The balance the bank's statement shows on the date, positive in the company's favour. */
    balance: signedMoneySchema,
  })
  .strict();
const partnerRow = z
  .object({
    name,
    taxId: taxId.nullable(),
    /** The ledger account the balance is held on (4111, 401, 404, 461, 462, …). */
    account: z.string().regex(/^4\d{2,3}(\.[\dA-Z_-]{1,20})?$/),
    currency,
    /** What the partner confirmed, signed as the books hold it: positive what it owes the
     * company, negative what the company owes it; null without a reply. */
    confirmed: signedMoneySchema.nullable(),
    status: z.enum(['confirmed', 'disputed', 'no_reply']),
    note,
  })
  .strict();
const stockRow = z
  .object({
    account: z.string().regex(/^3\d{2,3}(\.[\dA-Z_-]{1,20})?$/),
    code: z.string().trim().min(1).max(100),
    name: label,
    unit: z.string().trim().min(1).max(20),
    quantity,
    /** The warehouse's (gestiunea's) code, as the stock register keeps it (G1). */
    warehouse: z.string().trim().min(1).max(20).optional(),
    /** The commission's value: a surplus's (OMFP 1802/2014 pct. 75 alin. (1)), or the value an
     * intermittent inventory's count sets the stock at (pct. 291). */
    value: moneySchema.optional(),
  })
  .strict();

export const inventoryListSchema = z
  .object({
    parserVersion: z.literal(inventorySchemaVersion),
    /** The list's title as printed (its gestiune and category). */
    title: label,
    company: z.object({ name, taxId }).strict(),
    /** The day the list states the elements at: the financial year's last day for the annual
     * inventory (pct. 4). */
    date: dateSchema,
    /** The decision appointing the commission (pct. 6 alin. (1)), and its members; one person
     * or the administrators where the norms allow it (alin. (2), (7)). */
    commission: z
      .object({
        decision: z.string().trim().min(1).max(100),
        decisionDate: dateSchema,
        members: z.array(name).min(1).max(20),
      })
      .strict(),
    assets: z.array(assetRow).max(5000).nullable(),
    cash: z.array(cashRow).max(50).nullable(),
    bank: z.array(bankRow).max(100).nullable(),
    partners: z.array(partnerRow).max(5000).nullable(),
    stock: z.array(stockRow).max(10000).nullable(),
  })
  .strict();
export type InventoryList = z.infer<typeof inventoryListSchema>;

/** What an agent records: the sections it read, the notes and values it did not default to null. */
export const inventoryListInput = inventoryListSchema.extend({
  parserVersion: z.literal(inventorySchemaVersion).default(inventorySchemaVersion),
  assets: z
    .array(assetRow.extend({ value: assetRow.shape.value.default(null), note: note.default(null) }))
    .max(5000)
    .nullable()
    .default(null),
  cash: inventoryListSchema.shape.cash.default(null),
  bank: z
    .array(bankRow.extend({ iban: bankRow.shape.iban.default(null) }))
    .max(100)
    .nullable()
    .default(null),
  partners: z
    .array(
      partnerRow.extend({
        taxId: partnerRow.shape.taxId.default(null),
        confirmed: partnerRow.shape.confirmed.default(null),
        note: note.default(null),
      }),
    )
    .max(5000)
    .nullable()
    .default(null),
  stock: inventoryListSchema.shape.stock.default(null),
});

const duplicates = <T>(rows: readonly T[], key: (row: T) => string) => {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const row of rows) {
    const id = key(row);
    if (seen.has(id)) repeated.add(id);
    seen.add(id);
  }
  return [...repeated];
};

/** The list's own consistency, as `TOTALS` checks it; each problem in Romanian. */
export function inventoryProblems(list: InventoryList): string[] {
  const problems: string[] = [];
  const sections = [list.assets, list.cash, list.bank, list.partners, list.stock];
  if (sections.every((section) => section === null))
    problems.push('Lista nu cuprinde nicio secțiune de inventariere.');
  for (const number of duplicates(list.assets ?? [], (row) => row.number))
    problems.push(`Numărul de inventar ${number} apare de mai multe ori.`);
  (list.assets ?? []).forEach((row, index) => {
    if (!row.found && row.value !== null)
      problems.push(
        `Rândul ${index + 1} (${row.number}): un activ lipsă nu are valoare de inventar.`,
      );
  });
  for (const id of duplicates(list.cash ?? [], (row) => `${row.account}/${row.currency}`))
    problems.push(`Casieria ${id} apare de mai multe ori.`);
  for (const id of duplicates(list.bank ?? [], (row) => `${row.account}/${row.currency}`))
    problems.push(`Contul bancar ${id} apare de mai multe ori.`);
  (list.partners ?? []).forEach((row, index) => {
    if ((row.status === 'no_reply') !== (row.confirmed === null))
      problems.push(
        `Rândul ${index + 1} (${row.name}): soldul confirmat se indică exact când partenerul a răspuns.`,
      );
  });
  for (const id of duplicates(
    list.partners ?? [],
    (row) => `${row.taxId ?? row.name}/${row.account}/${row.currency}`,
  ))
    problems.push(`Partenerul ${id} apare de mai multe ori.`);
  for (const id of duplicates(
    list.stock ?? [],
    (row) => `${row.account}/${row.code}/${row.warehouse ?? ''}`,
  ))
    problems.push(`Articolul de stoc ${id} apare de mai multe ori.`);
  if (list.commission.decisionDate > list.date)
    problems.push('Comisia este numită după data inventarierii.');
  return problems;
}

/** The fields an extraction must cite: the date, the commission's decision and every amount or
 * quantity read. */
export function inventoryCitations(list: InventoryList): string[] {
  return [
    'date',
    'commission.decision',
    ...(list.assets ?? []).map((_, index) => `assets.${index}.number`),
    ...(list.assets ?? []).flatMap((row, index) =>
      row.value === null ? [] : [`assets.${index}.value`],
    ),
    ...(list.cash ?? []).map((_, index) => `cash.${index}.counted`),
    ...(list.bank ?? []).map((_, index) => `bank.${index}.balance`),
    ...(list.partners ?? []).flatMap((row, index) =>
      row.confirmed === null ? [] : [`partners.${index}.confirmed`],
    ),
    ...(list.stock ?? []).map((_, index) => `stock.${index}.quantity`),
    ...(list.stock ?? []).flatMap((row, index) =>
      row.value === undefined ? [] : [`stock.${index}.value`],
    ),
  ];
}

/** A list's totals as document lists show them: the cash counted and the bank balances. */
export function inventoryTotals(list: InventoryList) {
  const sum = (values: string[]) =>
    values.reduce((total, value) => total.plus(value), new Amount(0)).toFixed(2);
  return {
    cash: sum((list.cash ?? []).map((row) => row.counted)),
    bank: sum((list.bank ?? []).map((row) => row.balance)),
  };
}
