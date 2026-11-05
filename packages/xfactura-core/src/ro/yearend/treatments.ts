import { registerExplainsStock } from '../stock/inventory';
import { nextDay, registerAt } from '../stock/count';
import { z } from 'zod';
import {
  financialYearOf,
  itemLinesKey,
  profileAt,
  turnoverKey,
  type AssetState,
  type Effect,
  type Issue,
  type JsonValue,
  type LineSpec,
  type Loaded,
  type OpenItemSpec,
  type OpenItemState,
  type ReadPlan,
  type Treatment,
  type TurnoverQuery,
} from '../../kernel';
import { divRound, formatMoney, LEDGER_CURRENCY, parseMoney } from '../../money';
import { questionIssue } from '../../questions/kinds';
import { daysBetween, isLocalDate, type LocalDate } from '../../time';
import { straightLine } from '../treatments/assets';
import { inventoryDocumentKind, inventoryListSchema, type InventoryList } from './documents';
import { compareInventory, type BookCash } from './inventory';
import {
  provisionKinds,
  type ImpairmentAccounts,
  type InventoryAccounts,
  type ProvisionAccounts,
  type ProvisionKind,
} from './parameters';
import {
  collectibilityAnswer,
  provisionReviewAnswer,
  untakenLeaveAnswer,
  type CollectibilityAnswer,
} from './questions';

/*
 * The year-end's bookings (Y1, docs/ACCOUNTING_ENGINE.md "Year-end in full"): the differences the
 * annual inventory found (OMF nr. 2.861/2009 pct. 39–40, 45; OMFP nr. 1.802/2014 pct. 82–95),
 * the impairment of receivables (491) and of fixed assets (29x), and provisions (151x). Each is a
 * proposal a person approves; what the books cannot know (a customer's insolvency, the untaken
 * leave, a lawsuit) is a question, never a default. Each posting records in its explanation what
 * the profit tax's bridge reads of it (art. 26: the deductible part, the reversal of a part not
 * deducted), as `details.profit`.
 */

const always = '1900-01-01' as LocalDate;
const localDate = z
  .string()
  .refine((value): boolean => isLocalDate(value), 'Dată calendaristică invalidă.')
  .transform((value) => value as LocalDate);
const amount = z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/);
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
const info = (code: string, message: string, details?: JsonValue): Issue => ({
  code,
  severity: 'info',
  message,
  ...(details === undefined ? {} : { details }),
});
const lei = (bani: bigint) => formatMoney(bani, 'RON');
const abs = (value: bigint) => (value < 0n ? -value : value);

/** What a posting tells the profit tax (docs/ACCOUNTING_ENGINE.md, `tax.profit`'s
 * `determinations`): an amount on an expense or revenue account, its rule and letter of the law. */
export interface ProfitNote {
  account: string;
  rule: 'provision_deductible' | 'receivables' | 'nontaxable';
  amount: string;
  clause: string;
  /** The item it is about: a receivable, an asset, a provision. */
  item: string;
}

/** The analytics tag of a receivable's impairment, an asset's impairment, a provision. */
export const impairmentTag = (openItemId: string) => `impairment:${openItemId}`;
export const assetImpairmentTag = (assetId: string) => `impairment:${assetId}`;
export const provisionTag = (kind: ProvisionKind, reference: string) =>
  `provision:${kind}:${reference}`;

/** The balance tagged `item` on accounts under `prefix`, credit less debit. */
function tagged(loaded: Loaded, prefixes: string[], item: string, account?: string) {
  return (loaded.itemLines.get(itemLinesKey({ prefixes })) ?? [])
    .filter((row) => row.item === item && (account === undefined || row.account === account))
    .reduce((sum, row) => sum + row.credit - row.debit, 0n);
}

/** The financial year that ends on `date`, or the issue saying it does not. */
function yearEnding(loaded: Loaded, date: LocalDate) {
  const year = financialYearOf(loaded, date);
  return year && year.to === date ? year : null;
}
const yearEndIssue = () =>
  block('YEAR_END', 'Data nu este ultima zi a unui exercițiu financiar.', 'yearEnd');

// ---------------------------------------------------------------------------------------------
// The annual inventory's differences

export const inventoryInput = z
  .object({
    /** The inventory's date, the day the differences are booked on (pct. 95 alin. (2)): the
     * financial year's last day for the annual inventory. */
    date: localDate,
    /** The lists of that date (`documents.record`, kind `inventory.list`). */
    documentIds: z.array(z.uuid()).min(1).max(50),
    /** The administrator's decision on the commission's proces-verbal (pct. 42–43). */
    evidenceId: z.uuid(),
    /** A shortage the administrator imputes to the person found guilty, at the replacement value
     * (pct. 40 alin. (2)): a missing fixed asset by its inventory number, or a cash desk's
     * shortage by its account. */
    imputations: z
      .array(
        z
          .object({
            kind: z.enum(['asset', 'cash']),
            /** The asset's inventory number, or the cash desk's account. */
            ref: z.string().trim().min(1).max(100),
            partyId: z.uuid(),
            /** An employee (4282) or another person (461). */
            employee: z.boolean(),
            amount,
          })
          .strict(),
      )
      .max(500)
      .default([]),
    /** A fixed asset found in surplus, registered on its card (`assets.register`) at the value
     * the commission set. */
    surplus: z
      .array(z.object({ number: z.string().trim().min(1).max(100), assetId: z.uuid() }).strict())
      .max(500)
      .default([]),
  })
  .strict();
export type InventoryInput = z.infer<typeof inventoryInput>;

const inventoryQueries = (date: LocalDate) => ({
  cash: { prefixes: ['531'], from: always, to: date } satisfies TurnoverQuery,
  stock: { prefixes: ['3'], from: always, to: date } satisfies TurnoverQuery,
});

/** The lists among the loaded documents, with their problems. */
function inventoryLists(loaded: Loaded, ids: readonly string[], date: LocalDate) {
  const lists: { id: string; body: InventoryList }[] = [];
  const issues: Issue[] = [];
  ids.forEach((id, index) => {
    const document = loaded.documents.get(id);
    const parsed = document ? inventoryListSchema.safeParse(document.body) : null;
    if (!document || document.kind !== inventoryDocumentKind || !parsed?.success)
      issues.push(
        block(
          'INVENTORY_LIST',
          'Documentul nu este o listă de inventariere.',
          `documentIds.${index}`,
        ),
      );
    else if (parsed.data.date !== date)
      issues.push(
        block(
          'INVENTORY_DATE',
          `Lista de inventariere este la ${parsed.data.date}, nu la ${date}.`,
          `documentIds.${index}`,
        ),
      );
    else lists.push({ id, body: parsed.data });
  });
  return { lists, issues };
}

/** The register's assets as of `date`, net of what the books hold for them then. */
export function assetsAt(loaded: Loaded, date: LocalDate) {
  return [...loaded.assets.values()].filter(
    (asset) => asset.commissionedOn <= date && !(asset.disposedOn && asset.disposedOn < date),
  );
}

/**
 * The differences of the annual inventory, booked on its date: a cash desk's shortage imputed to
 * the person found guilty (4282 or 461) or expensed, its surplus taken in; a missing fixed asset,
 * once taken out of the register (`assets.dispose`, `assets.derecognize`), imputed at the
 * replacement value against revenue (pct. 40 alin. (2)); a fixed asset found in surplus at the
 * commission's value against 4754. Impaired assets are `impairment.assets`'; the banks' and the
 * partners' differences are investigated, never booked from a list; stock is not covered (G1).
 */
export const inventoryDifferences: Treatment<InventoryInput> = {
  id: 'inventory.differences',
  version: 1,
  description:
    'Înregistrarea diferențelor constatate la inventarierea anuală (OMF nr. 2.861/2009): lipsuri și plusuri de casă, imobilizări lipsă imputate, imobilizări constatate plus.',
  input: inventoryInput,
  agent: true,
  summary:
    "Books the annual inventory's differences (OMF 2861/2009): cash shortages and surpluses, missing fixed assets imputed at replacement value, fixed assets found in surplus.",
  toolset: 'close',
  subject: (input) => `inventory:${input.date}`,
  plan: (input) => {
    const queries = inventoryQueries(input.date);
    return {
      documents: input.documentIds,
      evidence: [input.evidenceId],
      assets: true,
      itemLines: { prefixes: ['29'] },
      turnover: [queries.cash, queries.stock],
      foreignBalances: { at: input.date },
      // The stock register on the date: when it explains the stock accounts, the count's stock
      // differences are `inventory.stock`'s.
      stock: {
        all: true,
        catalogue: true,
        flows: { from: nextDay(input.date), to: '9999-12-31' as LocalDate },
      },
      parties: [...new Set(input.imputations.map((item) => item.partyId))],
      profile: true,
    };
  },
  evaluate(input, loaded, rules) {
    const accounts = rules.param<InventoryAccounts>(
      'ro.inventory.accounts',
      'accounting_transaction_date',
      input.date,
    );
    const issues: Issue[] = [];
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(
        block(
          'EVIDENCE',
          'Decizia administratorului asupra procesului-verbal nu este disponibilă.',
          'evidenceId',
        ),
      );
    const { lists, issues: listIssues } = inventoryLists(loaded, input.documentIds, input.date);
    issues.push(...listIssues);
    if (issues.length) return { effect: null, issues };

    const queries = inventoryQueries(input.date);
    // Cash desks in lei by their turnover; those in a currency in it (pct. 29 alin. (3)).
    const foreign = loaded.balances.filter((row) => row.account.startsWith('531'));
    const cash: BookCash[] = [
      ...(loaded.turnover.get(turnoverKey(queries.cash)) ?? [])
        .filter((row) => !foreign.some((balance) => balance.account === row.account))
        .map((row) => ({
          account: row.account,
          currency: LEDGER_CURRENCY,
          bani: row.debit - row.credit,
          minor: row.debit - row.credit,
        })),
      ...foreign.map((row) => ({ ...row })),
    ];
    const stockBalances = (loaded.turnover.get(turnoverKey(queries.stock)) ?? [])
      .filter((row) => row.debit !== row.credit)
      .map((row) => ({ account: row.account, bani: row.debit - row.credit }));
    const comparison = compareInventory(
      lists.map((list) => list.body),
      {
        date: input.date,
        assets: assetsAt(loaded, input.date).map((asset) => bookAsset(loaded, asset, input.date)),
        cash,
        stock: stockBalances,
        ...(registerExplainsStock(loaded, stockBalances)
          ? {
              register: {
                positions: registerAt(loaded),
                items: new Map([...loaded.stockItems.values()].map((item) => [item.code, item])),
                warehouses: new Map(
                  [...loaded.warehouses.values()].map((store) => [store.code, store.id]),
                ),
              },
            }
          : {}),
      },
    );
    for (const problem of comparison.unsupported)
      issues.push(block(problem.code, problem.message, undefined, problem.details ?? null));
    // The stock's own gaps are `inventory.stock`'s.
    for (const gap of comparison.gaps)
      if (gap.code !== 'INVENTORY_STOCK_UNLISTED') issues.push(block(gap.code, gap.message));

    const lines: LineSpec[] = [];
    const openItems: OpenItemSpec[] = [];
    const notes: string[] = [];
    const used = new Set<number>();
    const imputation = (kind: 'asset' | 'cash', ref: string) => {
      const index = input.imputations.findIndex((item) => item.kind === kind && item.ref === ref);
      if (index >= 0) used.add(index);
      return index >= 0 ? { item: input.imputations[index]!, index } : null;
    };
    const debtor = (
      item: InventoryInput['imputations'][number],
      bani: bigint,
      path: string,
      memo: string,
    ): LineSpec | null => {
      if (!loaded.parties.has(item.partyId)) {
        issues.push(block('PARTY', 'Persoana căreia i se impută lipsa nu este disponibilă.', path));
        return null;
      }
      if (item.employee)
        return {
          account: accounts.imputation.employee,
          side: 'D',
          bani,
          partyId: item.partyId,
          analytics: { item: `inventory:${input.date}:${item.kind}:${item.ref}` },
          memo,
        };
      const ref = `imputation-${openItems.length + 1}`;
      openItems.push({
        ref,
        kind: 'receivable',
        controlAccount: accounts.imputation.third,
        partyId: item.partyId,
        currency: LEDGER_CURRENCY,
        normalSide: 'D',
        mayReverse: false,
      });
      return {
        account: accounts.imputation.third,
        side: 'D',
        bani,
        partyId: item.partyId,
        openItem: ref,
        memo,
      };
    };

    for (const difference of comparison.differences) {
      if (difference.kind === 'cash') {
        const diff = difference.counted - difference.book;
        if (difference.currency !== LEDGER_CURRENCY) {
          issues.push(
            block(
              'INVENTORY_CASH_CURRENCY',
              `Diferența la casieria ${difference.account} în ${difference.currency} nu este încă acoperită: se înregistrează după cursul zilei, în afara aplicației.`,
            ),
          );
          continue;
        }
        if (diff > 0n) {
          lines.push(
            { account: difference.account, side: 'D', bani: diff, memo: 'Plus de casă' },
            { account: accounts.cash.surplus, side: 'C', bani: diff, memo: 'Plus de casă' },
          );
          notes.push(`Plus de casă ${lei(diff)} lei la ${difference.account}.`);
          continue;
        }
        const shortage = -diff;
        const found = imputation('cash', difference.account);
        if (found) {
          const imputed = parseMoney(found.item.amount, 'RON');
          if (imputed !== shortage) {
            issues.push(
              block(
                'IMPUTATION_AMOUNT',
                `Lipsa de casă la ${difference.account} este ${lei(shortage)} lei; se impută exact suma lipsă, nu ${lei(imputed)} lei.`,
                `imputations.${found.index}.amount`,
              ),
            );
            continue;
          }
          const line = debtor(
            found.item,
            shortage,
            `imputations.${found.index}`,
            `Lipsă de casă imputată, ${difference.account}`,
          );
          if (line) lines.push(line);
        } else
          lines.push({
            account: accounts.cash.shortage,
            side: 'D',
            bani: shortage,
            memo: 'Lipsă de casă neimputabilă',
          });
        lines.push({
          account: difference.account,
          side: 'C',
          bani: shortage,
          memo: 'Lipsă de casă',
        });
        notes.push(
          `Lipsă de casă ${lei(shortage)} lei la ${difference.account}${found ? ', imputată' : ', neimputabilă'}.`,
        );
        continue;
      }
      if (difference.kind === 'asset.missing') {
        const asset = loaded.assets.get(difference.assetId)!;
        if (!asset.disposedOn || asset.disposedOn > input.date) {
          issues.push(
            block(
              'INVENTORY_ASSET_DISPOSAL',
              `Imobilizarea ${asset.number} lipsește: înregistrați întâi scoaterea ei din funcțiune la data constatării (assets.dispose) și scoaterea din evidență (assets.derecognize), apoi imputarea.`,
              undefined,
              { assetId: asset.id, number: asset.number },
            ),
          );
          continue;
        }
        const found = imputation('asset', asset.number);
        if (found) {
          const imputed = parseMoney(found.item.amount, 'RON');
          if (imputed <= 0n) {
            issues.push(
              block(
                'IMPUTATION_AMOUNT',
                'Valoarea de înlocuire imputată lipsește.',
                `imputations.${found.index}.amount`,
              ),
            );
            continue;
          }
          const line = debtor(
            found.item,
            imputed,
            `imputations.${found.index}`,
            `Imputare ${asset.number} ${asset.name}`,
          );
          if (line)
            lines.push(line, {
              account: accounts.imputation.revenue,
              side: 'C',
              bani: imputed,
              memo: `Imputare ${asset.number} ${asset.name}, la valoarea de înlocuire`,
            });
          notes.push(`${asset.number} lipsă, imputat la ${lei(imputed)} lei.`);
        } else {
          notes.push(`${asset.number} lipsă, neimputabil.`);
          if (profileAt(loaded, 'income_tax', input.date) === 'profit')
            issues.push(
              ack(
                'PROFIT_SHORTAGE',
                `${asset.number} lipsește și nu este imputat: cheltuiala unui mijloc fix lipsă neimputabil nu este deductibilă, cu excepțiile art. 25 alin. (4) lit. c) din Codul fiscal; impozitul pe profit deduce valoarea fiscală rămasă la scoaterea din gestiune, care trebuie stabilită (determinations, nondeductible) pentru anul ${input.date.slice(0, 4)}.`,
                { assetId: asset.id },
              ),
            );
        }
        if (profileAt(loaded, 'vat.status', input.date) === 'normal_vat')
          issues.push(
            ack(
              'CAPITAL_GOODS_CESSATION',
              `${asset.number} și-a încetat existența printr-o lipsă: dacă este bun de capital în perioada de ajustare și lipsa nu e o pierdere, distrugere sau un furt dovedite, ajustați taxa dedusă (vat.capitalGoods, event cessation, cause shortage; Codul fiscal art. 305 alin. (4) lit. d), normele pct. 79 alin. (10)). Suma imputată nu este în sfera TVA.`,
              { assetId: asset.id },
            ),
          );
        continue;
      }
      if (difference.kind === 'asset.surplus') {
        const mapping = input.surplus.find((item) => item.number === difference.number);
        const asset = mapping ? loaded.assets.get(mapping.assetId) : undefined;
        if (!mapping || !asset) {
          issues.push(
            block(
              'INVENTORY_SURPLUS',
              `${difference.number} a fost găsit în plus: înregistrați-i fișa (assets.register) la valoarea stabilită de comisie, punerea în funcțiune la ${input.date}, și indicați-o în surplus.`,
              'surplus',
              { number: difference.number },
            ),
          );
          continue;
        }
        if (asset.value !== difference.value || asset.number !== difference.number) {
          issues.push(
            block(
              'INVENTORY_SURPLUS',
              `Fișa ${asset.number} are valoarea ${lei(asset.value)} lei; lista de inventariere o evaluează la ${lei(difference.value)} lei.`,
              'surplus',
            ),
          );
          continue;
        }
        if (tagged(loaded, ['29'], `surplus:${asset.id}`) !== 0n) continue;
        lines.push(
          {
            account: asset.account,
            side: 'D',
            bani: asset.value,
            analytics: { item: `surplus:${asset.id}` },
            memo: `${asset.number} ${asset.name}, plus de inventar`,
          },
          {
            account: accounts.assetSurplus,
            side: 'C',
            bani: asset.value,
            analytics: { item: `surplus:${asset.id}` },
            memo: `${asset.number} ${asset.name}, plus de inventar`,
          },
        );
        notes.push(`${asset.number} găsit în plus, ${lei(asset.value)} lei.`);
        issues.push(
          ack(
            'SURPLUS_RELEASE',
            `Contul ${accounts.assetSurplus} se reia la venituri pe măsura amortizării lui ${asset.number} (funcțiunea contului 475): reluarea lunară nu este încă automată și se înregistrează prin ledger.general.`,
          ),
        );
        continue;
      }
      if (difference.kind === 'asset.impaired')
        issues.push(
          info(
            'INVENTORY_IMPAIRED',
            `${difference.number}: valoarea de inventar ${lei(difference.value)} lei este sub cea contabilă de ${lei(difference.net)} lei; ajustarea se înregistrează cu impairment.assets.`,
            { assetId: difference.assetId },
          ),
        );
    }
    input.imputations.forEach((_, index) => {
      if (!used.has(index))
        issues.push(
          block(
            'IMPUTATION_UNMATCHED',
            'Imputarea nu corespunde unei lipse constatate la inventariere.',
            `imputations.${index}`,
          ),
        );
    });
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };
    if (!lines.length)
      return {
        effect: null,
        issues: [
          ...issues,
          block(
            'NOTHING_TO_BOOK',
            'Inventarierea nu a constatat diferențe de înregistrat în contabilitate.',
          ),
        ],
      };
    issues.push(
      ack(
        'INVENTORY_DECISION',
        'Confirmați că administratorul a decis asupra propunerilor din procesul-verbal al comisiei de inventariere (OMF nr. 2.861/2009 pct. 43), document atașat.',
      ),
    );
    const effect: Effect = {
      schema: 'effect@1',
      date: input.date,
      journalClass: 'general',
      journalCode: 'DIVERSE',
      description: `Diferențe constatate la inventarierea din ${input.date}`,
      lines,
      openItems,
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: notes.join(' '),
        details: {
          documents: [...input.documentIds],
          decision: input.evidenceId,
          clauses: ['OMF2861/2009:pct.39-40', 'OMF2861/2009:pct.44-45', 'OMFP1802/2014:pct.95'],
        },
      },
    };
    return { effect, issues };
  },
};

/** An asset as the inventory compares it: its net value at the date. */
function bookAsset(loaded: Loaded, asset: AssetState, date: LocalDate) {
  return {
    id: asset.id,
    number: asset.number,
    name: asset.name,
    net:
      asset.value -
      depreciationAt(asset, date) -
      tagged(loaded, ['29'], assetImpairmentTag(asset.id)),
  };
}

const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
/** Straight-line depreciation due by the end of `date`'s month (OMFP nr. 1.802/2014 pct. 238):
 * from the month after commissioning. */
export function depreciationAt(
  asset: Pick<AssetState, 'value' | 'lifeMonths' | 'commissionedOn'>,
  date: LocalDate,
) {
  return straightLine(asset, monthIndex(date) - monthIndex(asset.commissionedOn));
}

// ---------------------------------------------------------------------------------------------
// The impairment of receivables (491)

export const receivableImpairmentInput = z
  .object({
    /** The financial year's last day. */
    yearEnd: localDate,
    /** The commission's proposals or the administrator's decision (OMF nr. 2.861/2009 pct. 38,
     * 43). */
    evidenceId: z.uuid(),
    /** A later round, after new facts changed what an earlier posting of the date computed. */
    round: z.number().int().min(1).max(99).default(1),
  })
  .strict();
export type ReceivableImpairmentInput = z.infer<typeof receivableImpairmentInput>;

/** The company's policy for testing receivables (`policy.impairment.receivables`): each one
 * individually, or every one overdue more than a number of days, besides those of a customer
 * whose answer says otherwise. */
export const impairmentPolicies = [
  'individual',
  'overdue_90',
  'overdue_180',
  'overdue_270',
  'overdue_365',
] as const;
/** The days past due beyond which a receivable is tested: every overdue one when individual. */
export const policyDays = (policy: (typeof impairmentPolicies)[number]) =>
  policy === 'individual' ? 0 : Number(policy.slice('overdue_'.length));

/** The answer the basis cites about a party, latest by the engine's time. */
function answerAbout<T>(
  loaded: Loaded,
  kind: string,
  subject: { kind: string; id: string },
  schema: z.ZodType<T>,
  period?: string,
) {
  let found: { value: T; answeredAt: string; answerId: string; questionId: string } | null = null;
  for (const record of loaded.answers.values()) {
    if (record.kind !== kind || record.subject.kind !== subject.kind) continue;
    if (record.subject.id !== subject.id) continue;
    if (period !== undefined) {
      const params = record.params as Record<string, JsonValue> | null;
      const asked = params?.yearEnd ?? params?.year;
      if (String(asked) !== period) continue;
    }
    const parsed = schema.safeParse(record.value);
    if (!parsed.success) continue;
    if (
      !found ||
      found.answeredAt < record.answeredAt ||
      (found.answeredAt === record.answeredAt && found.answerId < record.answerId)
    )
      found = {
        value: parsed.data,
        answeredAt: record.answeredAt,
        answerId: record.answerId,
        questionId: record.questionId,
      };
  }
  return found;
}

/** A receivable's balance at the year's end: today's less what lines dated after moved. */
function balanceAt(loaded: Loaded, item: OpenItemState, date: LocalDate) {
  let after = 0n;
  for (const entryId of item.history ?? []) {
    const entry = loaded.entries.get(entryId);
    if (!entry || entry.date <= date) continue;
    for (const line of entry.lines)
      if (line.openItem === item.id) after += line.side === 'D' ? line.bani : -line.bani;
  }
  return item.balanceBani - after;
}

const receivableQuery = (accounts: readonly string[]) => ({
  kind: 'receivable' as const,
  accounts: [...accounts],
  openOnly: true,
  history: true,
  origins: true,
});

/**
 * The year-end impairment of receivables (OMFP nr. 1.802/2014 pct. 89, 332, 353): each customer's
 * receivables still open, originated by the year's end and tested under the company's policy
 * (overdue beyond its days, or a customer whose answer says they are doubtful, in litigation, in
 * insolvency or in bankruptcy), are impaired on 491 for the part the person does not expect to
 * collect; an impairment no longer needed (the receivable collected, the customer recovered) is
 * reversed to 7814. The deductible part follows art. 26 alin. (1) lit. c) (30% of what is unpaid
 * over 270 days, not guaranteed, not affiliated) and lit. j) (100% in a bankruptcy declared).
 */
export const receivableImpairment: Treatment<ReceivableImpairmentInput> = {
  id: 'impairment.receivables',
  version: 1,
  description:
    'Ajustările pentru deprecierea creanțelor clienți la sfârșitul exercițiului (491), după politica firmei și faptele constatate, cu reluarea celor care nu mai sunt necesare.',
  input: receivableImpairmentInput,
  agent: true,
  summary:
    "Year-end impairment of customers' receivables on 491 by the company's policy and the facts a person states (insolvency, litigation, the share recoverable), with reversal of what is no longer needed.",
  toolset: 'close',
  subject: (input) => `impairment.receivables:${input.yearEnd}:${input.round}`,
  plan: (input): ReadPlan => ({
    evidence: [input.evidenceId],
    profile: true,
    // The tested accounts are the parameter's; 4111 is the only one today, and every item on it
    // is read so that a parameter change is a rules change, not a missed read.
    openItems: [receivableQuery(['411'])],
    itemLines: { prefixes: ['491'] },
  }),
  followUp: (_input, loaded) => {
    const entries = [
      ...new Set([...loaded.openItems.values()].flatMap((item) => item.history ?? [])),
    ];
    const parties = [...new Set([...loaded.openItems.values()].map((item) => item.partyId))];
    return entries.length || parties.length ? { entries, parties } : null;
  },
  evaluate(input, loaded, rules) {
    const accounts = rules.param<ImpairmentAccounts>(
      'ro.impairment.accounts',
      'accounting_transaction_date',
      input.yearEnd,
    ).receivables;
    const issues: Issue[] = [];
    if (!yearEnding(loaded, input.yearEnd)) return { effect: null, issues: [yearEndIssue()] };
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(block('EVIDENCE', 'Documentul justificativ nu este disponibil.', 'evidenceId'));
    const policy = profileAt(loaded, 'policy.impairment.receivables', input.yearEnd) as
      (typeof impairmentPolicies)[number] | null;
    if (!policy || !(impairmentPolicies as readonly string[]).includes(policy))
      return {
        effect: null,
        issues: [
          ...issues,
          block(
            'POLICY_MISSING',
            'Înregistrați politica contabilă de testare a creanțelor pentru depreciere (policy.impairment.receivables): individual sau peste un număr de zile de întârziere.',
          ),
        ],
      };
    const threshold = policyDays(policy);
    const allowance = accounts.allowance;
    const items = [...loaded.openItems.values()].filter(
      (item) =>
        accounts.accounts.some((prefix) => item.controlAccount.startsWith(prefix)) &&
        (item.origin?.date ?? '9999-12-31') <= input.yearEnd,
    );
    type Row = {
      item: string;
      partyId: string;
      party: string;
      balance: bigint;
      overdue: number;
      target: bigint;
      existing: bigint;
      answer: CollectibilityAnswer | null;
    };
    const rows: Row[] = [];
    const asked = new Set<string>();
    for (const item of items) {
      const balance = balanceAt(loaded, item, input.yearEnd);
      if (balance <= 0n) continue;
      const due = (item.dueDate ?? item.origin?.date ?? input.yearEnd) as LocalDate;
      const overdue = Math.max(0, daysBetween(due, input.yearEnd));
      const answer = answerAbout(
        loaded,
        'receivable.collectibility',
        { kind: 'party', id: item.partyId },
        collectibilityAnswer,
        input.yearEnd,
      );
      const tested = overdue > threshold || answer !== null;
      const existing = tagged(loaded, [allowance], impairmentTag(item.id), allowance);
      if (!tested && existing === 0n) continue;
      if (tested && !answer) {
        if (!asked.has(item.partyId)) {
          asked.add(item.partyId);
          issues.push(
            questionIssue(
              'RECEIVABLE_COLLECTIBILITY',
              `${loaded.parties.get(item.partyId)?.name ?? item.partyId}: creanța de ${lei(balance)} lei are ${overdue} de zile de întârziere la ${input.yearEnd}, peste pragul politicii (${threshold} de zile). Întrebați cât de încasabile sunt creanțele clientului (receivable.collectibility) și revizuiți propunerea citând răspunsul.`,
              {
                kind: 'receivable.collectibility',
                subject: { kind: 'party', id: item.partyId },
                params: { yearEnd: input.yearEnd },
              },
            ),
          );
        }
        continue;
      }
      const recoverable = answer ? answer.value.recoverable : '100';
      const [whole, fraction = ''] = recoverable.split('.');
      const hundredths = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
      const target = answer
        ? divRound(balance * (10_000n - hundredths), 10_000n, 'halfAwayFromZero')
        : 0n;
      rows.push({
        item: item.id,
        partyId: item.partyId,
        party: loaded.parties.get(item.partyId)?.name ?? item.partyId,
        balance,
        overdue,
        target,
        existing,
        answer: answer?.value ?? null,
      });
    }
    // Impairments of receivables no longer open, or no longer tested: reversed.
    const open = new Set(rows.map((row) => row.item));
    const others = (loaded.itemLines.get(itemLinesKey({ prefixes: [allowance] })) ?? []).filter(
      (row) => row.account === allowance && row.item.startsWith('impairment:'),
    );
    const leftover = new Map<string, bigint>();
    for (const row of others) {
      const item = row.item.slice('impairment:'.length);
      if (open.has(item)) continue;
      leftover.set(item, (leftover.get(item) ?? 0n) + row.credit - row.debit);
    }
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };

    const lines: LineSpec[] = [];
    const profit: ProfitNote[] = [];
    let increase = 0n;
    let decrease = 0n;
    const details: JsonValue[] = [];
    for (const row of rows) {
      const delta = row.target - row.existing;
      details.push({
        item: row.item,
        party: row.party,
        balance: lei(row.balance),
        overdue: row.overdue,
        status: row.answer?.status ?? 'collectible',
        recoverable: row.answer?.recoverable ?? '100',
        existing: lei(row.existing),
        target: lei(row.target),
      });
      if (delta === 0n) continue;
      lines.push({
        account: allowance,
        side: delta > 0n ? 'C' : 'D',
        bani: abs(delta),
        partyId: row.partyId,
        analytics: { item: impairmentTag(row.item) },
        memo: `${row.party}: ${row.answer?.status ?? 'collectible'}, ${row.overdue} zile`,
      });
      if (delta > 0n) {
        increase += delta;
        const answer = row.answer!;
        const eligible = !answer.guaranteed && !answer.affiliated;
        if (eligible && answer.status === 'bankruptcy')
          profit.push({
            account: accounts.expense,
            rule: 'provision_deductible',
            amount: lei(delta),
            clause: 'art.26(1)(j)',
            item: row.item,
          });
        else if (eligible && row.overdue > 270)
          profit.push({
            account: accounts.expense,
            rule: 'receivables',
            amount: lei(delta),
            clause: 'art.26(1)(c)',
            item: row.item,
          });
      } else decrease += -delta;
    }
    for (const [item, existing] of [...leftover].sort(([a], [b]) => a.localeCompare(b))) {
      if (existing === 0n) continue;
      lines.push({
        account: allowance,
        side: existing > 0n ? 'D' : 'C',
        bani: abs(existing),
        analytics: { item: impairmentTag(item) },
        memo: 'Ajustare reluată: creanța nu mai este deschisă sau testată',
      });
      if (existing > 0n) decrease += existing;
      else increase += -existing;
      details.push({ item, existing: lei(existing), target: '0.00' });
    }
    if (increase) lines.push({ account: accounts.expense, side: 'D', bani: increase });
    if (decrease) lines.push({ account: accounts.revenue, side: 'C', bani: decrease });
    if (!lines.length)
      return {
        effect: null,
        issues: [
          ...issues,
          block('NOTHING_TO_BOOK', 'Ajustările pentru creanțe sunt deja la nivelul necesar.'),
        ],
      };
    const effect: Effect = {
      schema: 'effect@1',
      date: input.yearEnd,
      journalClass: 'general',
      journalCode: 'DIVERSE',
      description: `Ajustări pentru deprecierea creanțelor la ${input.yearEnd}`,
      lines,
      openItems: [],
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: `Ajustări constituite ${lei(increase)} lei, reluate ${lei(decrease)} lei; politica ${policy}.`,
        details: {
          policy,
          items: details,
          profit: profit as unknown as JsonValue,
          clauses: ['OMFP1802/2014:pct.332', 'OMFP1802/2014:pct.353'],
        },
      },
    };
    return { effect, issues };
  },
};

// ---------------------------------------------------------------------------------------------
// The impairment of fixed assets (29x)

export const assetImpairmentInput = z
  .object({
    date: localDate,
    /** Each asset tested, with the value the commission or an authorized evaluator set at the
     * date (pct. 85): its impairment is the net value above it, reversed when it rose. */
    assets: z
      .array(
        z
          .object({
            assetId: z.uuid(),
            value: amount,
            /** The list or the evaluator's report that sets it. */
            evidenceId: z.uuid(),
            /** An irreversible impairment is additional depreciation (pct. 85 alin. (2)). */
            irreversible: z.boolean().default(false),
            /** Destroyed by a calamity, or insured: deductible (Codul fiscal art. 26 alin. (1)
             * lit. n)). */
            deductible: z.enum(['calamity', 'insured']).nullable().default(null),
          })
          .strict(),
      )
      .min(1)
      .max(500),
    /** The administrator's decision on the commission's proposals (pct. 38, 43). */
    evidenceId: z.uuid(),
    round: z.number().int().min(1).max(99).default(1),
  })
  .strict();
export type AssetImpairmentInput = z.infer<typeof assetImpairmentInput>;

/**
 * The impairment of a fixed asset on an evidenced test (OMFP nr. 1.802/2014 pct. 84–86): the net
 * value at the date (value less the straight-line depreciation due and the impairment held)
 * above the value the commission or the evaluator set is impaired on its 29x account; a value that
 * rose back reverses it (7813), and an asset taken out of use loses it (pct. 95 alin. (3)). The
 * asset stays at its entry value and is depreciated on it.
 */
export const assetImpairment: Treatment<AssetImpairmentInput> = {
  id: 'impairment.assets',
  version: 1,
  description:
    'Ajustările pentru deprecierea imobilizărilor (29x), pe baza valorii de inventar stabilite de comisie sau de evaluator, și reluarea lor.',
  input: assetImpairmentInput,
  agent: true,
  summary:
    'Impairment of fixed assets on 29x from the value the inventory commission or an evaluator set, and its reversal.',
  toolset: 'close',
  subject: (input) => `impairment.assets:${input.date}:${input.round}`,
  plan: (input) => ({
    evidence: [input.evidenceId, ...input.assets.map((item) => item.evidenceId)],
    assets: true,
    itemLines: { prefixes: ['29'] },
    profile: true,
  }),
  evaluate(input, loaded, rules) {
    const accounts = rules.param<ImpairmentAccounts>(
      'ro.impairment.accounts',
      'accounting_transaction_date',
      input.date,
    ).assets;
    const issues: Issue[] = [];
    for (const id of [input.evidenceId, ...input.assets.map((item) => item.evidenceId)])
      if (!loaded.evidence.has(id)) {
        issues.push(block('EVIDENCE', 'Documentul justificativ nu este disponibil.'));
        break;
      }
    const lines: LineSpec[] = [];
    const profit: ProfitNote[] = [];
    const details: JsonValue[] = [];
    let increase = 0n;
    let decrease = 0n;
    const seen = new Set<string>();
    input.assets.forEach((tested, index) => {
      const path = `assets.${index}`;
      const asset = loaded.assets.get(tested.assetId);
      if (!asset || seen.has(tested.assetId)) {
        issues.push(block('ASSET', 'Mijlocul fix nu există sau apare de două ori.', path));
        return;
      }
      seen.add(asset.id);
      if (tested.irreversible) {
        issues.push(
          block(
            'IMPAIRMENT_IRREVERSIBLE',
            `${asset.number}: o depreciere ireversibilă se înregistrează ca amortizare suplimentară (OMFP nr. 1.802/2014 pct. 85 alin. (2)), care nu este încă acoperită.`,
            path,
          ),
        );
        return;
      }
      const allowance = accounts.allowances.find((row) => asset.account.startsWith(row.prefix));
      if (!allowance) {
        issues.push(
          block(
            'IMPAIRMENT_ACCOUNT',
            `${asset.number}: contul ${asset.account} nu are un cont de ajustări pentru depreciere.`,
            path,
          ),
        );
        return;
      }
      const existing = tagged(loaded, ['29'], assetImpairmentTag(asset.id), allowance.account);
      const disposed = asset.disposedOn !== null && asset.disposedOn <= input.date;
      const gross = asset.value - depreciationAt(asset, input.date);
      const value = parseMoney(tested.value, 'RON');
      const target = disposed ? 0n : gross > value ? gross - value : 0n;
      const delta = target - existing;
      details.push({
        asset: asset.number,
        net: lei(gross - existing),
        value: lei(value),
        existing: lei(existing),
        target: lei(target),
      });
      if (delta === 0n) return;
      lines.push({
        account: allowance.account,
        side: delta > 0n ? 'C' : 'D',
        bani: abs(delta),
        analytics: { item: assetImpairmentTag(asset.id) },
        memo: `${asset.number} ${asset.name}`,
      });
      if (delta > 0n) {
        increase += delta;
        if (tested.deductible)
          profit.push({
            account: accounts.expense,
            rule: 'provision_deductible',
            amount: lei(delta),
            clause: 'art.26(1)(n)',
            item: asset.id,
          });
      } else decrease += -delta;
    });
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };
    if (increase) lines.push({ account: accounts.expense, side: 'D', bani: increase });
    if (decrease) lines.push({ account: accounts.revenue, side: 'C', bani: decrease });
    if (!lines.length)
      return {
        effect: null,
        issues: [
          ...issues,
          block('NOTHING_TO_BOOK', 'Ajustările imobilizărilor sunt deja la nivelul necesar.'),
        ],
      };
    const effect: Effect = {
      schema: 'effect@1',
      date: input.date,
      journalClass: 'general',
      journalCode: 'DIVERSE',
      description: `Ajustări pentru deprecierea imobilizărilor la ${input.date}`,
      lines,
      openItems: [],
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: `Ajustări constituite ${lei(increase)} lei, reluate ${lei(decrease)} lei.`,
        details: {
          assets: details,
          profit: profit as unknown as JsonValue,
          clauses: ['OMFP1802/2014:pct.85-86', 'OMFP1802/2014:pct.95'],
        },
      },
    };
    return { effect, issues };
  },
};

// ---------------------------------------------------------------------------------------------
// Provisions (151x), and the debts for untaken leave and bonuses measured on the payroll

export const provisionInput = z
  .object({
    date: localDate,
    kind: z.enum(provisionKinds),
    /** What identifies the obligation: the case, the contract, `concedii-2026`. */
    reference: z.string().regex(/^[\w.-]{1,60}$/),
    /** The best estimate at the date of what settling it costs (pct. 387): the provision's new
     * balance; 0 cancels it. */
    amount,
    /** The lawyer's estimate, the warranty contract, the computation, the decision. */
    evidenceId: z.uuid(),
    /** A warranty provision within the rates of the contracts for the year's supplies (Codul
     * fiscal art. 26 alin. (1) lit. b)): the part deductible. */
    deductible: amount.optional(),
  })
  .strict();
export type ProvisionInput = z.infer<typeof provisionInput>;

/**
 * A provision brought to the best estimate of its obligation at the date (OMFP nr. 1.802/2014 pct.
 * 369–388): increased on 6812, reduced or cancelled on 7812, kept per kind and obligation. Untaken
 * leave and bonuses measured on the payroll records are a debt to the staff instead (4281 against
 * 641, pct. 338 alin. (2)). Untaken leave reads the person's answer (`leave.untaken`), and the
 * other kinds the year's review (`provisions.review`), which the amount must match at a year's
 * end. A provision is not deductible unless art. 26 says so; its reversal is then not taxable.
 */
export const provisionRecord: Treatment<ProvisionInput> = {
  id: 'provisions.record',
  version: 1,
  description:
    'Constituirea, majorarea, diminuarea sau anularea unui provizion (151x) la cea mai bună estimare, sau a datoriei pentru concediile și bonusurile comensurate pe statele de salarii (4281).',
  input: provisionInput,
  agent: true,
  summary:
    'A provision (151x) brought to the best estimate of its obligation, increased, reduced or cancelled; untaken leave and bonuses measured on the payroll are a debt on 4281.',
  toolset: 'close',
  subject: (input) => `provision:${input.kind}:${input.reference}:${input.date}`,
  plan: (input) => ({
    evidence: [input.evidenceId],
    itemLines: { prefixes: ['151', '428'] },
    profile: true,
  }),
  evaluate(input, loaded, rules) {
    const accounts = rules.param<ProvisionAccounts>(
      'ro.provisions.accounts',
      'accounting_transaction_date',
      input.date,
    );
    const issues: Issue[] = [];
    if (!loaded.evidence.has(input.evidenceId))
      issues.push(block('EVIDENCE', 'Documentul justificativ nu este disponibil.', 'evidenceId'));
    const year = Number(input.date.slice(0, 4));
    const yearEnd = yearEnding(loaded, input.date) !== null;
    let measured = false;
    const target = parseMoney(input.amount, 'RON');
    if (input.kind === 'leave') {
      const answer = answerAbout(
        loaded,
        'leave.untaken',
        { kind: 'company', id: 'company' },
        untakenLeaveAnswer,
        String(year),
      );
      if (!answer)
        return {
          effect: null,
          issues: [
            ...issues,
            questionIssue(
              'LEAVE_UNTAKEN',
              `Concediile de odihnă neefectuate la ${input.date} se stabilesc din evidența concediilor și din statele de salarii: întrebați (leave.untaken) și revizuiți propunerea citând răspunsul.`,
              {
                kind: 'leave.untaken',
                subject: { kind: 'company', id: 'company' },
                params: { year },
              },
            ),
          ],
        };
      measured = answer.value.measured;
      const stated =
        parseMoney(answer.value.amount, 'RON') + parseMoney(answer.value.contributions, 'RON');
      if (stated !== target)
        issues.push(
          block(
            'LEAVE_AMOUNT',
            `Răspunsul despre concediile neefectuate dă ${lei(stated)} lei (indemnizația și contribuția), nu ${lei(target)} lei.`,
            'amount',
          ),
        );
    } else if (yearEnd) {
      const review = answerAbout(
        loaded,
        'provisions.review',
        { kind: 'company', id: 'company' },
        provisionReviewAnswer,
        String(year),
      );
      const listed =
        review && 'obligations' in review.value
          ? review.value.obligations.find(
              (item) => item.kind === input.kind && item.reference === input.reference,
            )
          : undefined;
      if (review && listed && parseMoney(listed.amount, 'RON') !== target)
        issues.push(
          block(
            'PROVISION_AMOUNT',
            `Analiza obligațiilor de la ${input.date} estimează ${input.reference} la ${listed.amount} lei, nu ${lei(target)} lei.`,
            'amount',
          ),
        );
      if (review && !listed && target > 0n)
        issues.push(
          block(
            'PROVISION_UNLISTED',
            `Obligația ${input.kind} ${input.reference} nu apare în analiza obligațiilor de la ${input.date} (provisions.review): revizuiți răspunsul.`,
          ),
        );
    }
    const onPayroll = measured && accounts.measured.kinds.includes(input.kind as 'leave');
    const account = onPayroll ? accounts.measured.account : accounts.kinds[input.kind];
    const expense = onPayroll ? accounts.measured.expense : accounts.expense;
    const revenue = onPayroll ? accounts.measured.expense : accounts.revenue;
    const tag = provisionTag(input.kind, input.reference);
    const prefixes = ['151', '428'];
    const existing = tagged(loaded, prefixes, tag);
    // A provision kept so far on the other account (a provision that became a measured debt, or
    // the reverse) is moved in full: first cancelled, then recognized on its new account.
    const elsewhere = (loaded.itemLines.get(itemLinesKey({ prefixes })) ?? []).filter(
      (row) => row.item === tag && row.account !== account,
    );
    if (elsewhere.some((row) => row.credit !== row.debit))
      issues.push(
        block(
          'PROVISION_ACCOUNT',
          `${input.reference} este ținut pe alt cont (${elsewhere.map((row) => row.account).join(', ')}): anulați-l acolo înainte.`,
        ),
      );
    const delta = target - existing;
    if (input.deductible !== undefined) {
      if (input.kind !== 'warranty')
        issues.push(
          block(
            'PROVISION_DEDUCTIBLE',
            'Doar provizioanele pentru garanții de bună execuție sunt deductibile după art. 26 alin. (1) lit. b).',
            'deductible',
          ),
        );
      else if (parseMoney(input.deductible, 'RON') > (delta > 0n ? delta : 0n))
        issues.push(
          block(
            'PROVISION_DEDUCTIBLE',
            'Partea deductibilă depășește majorarea provizionului.',
            'deductible',
          ),
        );
    }
    if (issues.some((issue) => issue.severity === 'block')) return { effect: null, issues };
    if (delta === 0n)
      return {
        effect: null,
        issues: [
          ...issues,
          block('NOTHING_TO_BOOK', `${input.reference} este deja la ${lei(existing)} lei.`),
        ],
      };
    const memo = `${input.kind} ${input.reference}`;
    const lines: LineSpec[] =
      delta > 0n
        ? [
            { account: expense, side: 'D', bani: delta, memo },
            { account, side: 'C', bani: delta, analytics: { item: tag }, memo },
          ]
        : [
            { account, side: 'D', bani: -delta, analytics: { item: tag }, memo },
            { account: revenue, side: 'C', bani: -delta, memo },
          ];
    const profit: ProfitNote[] = [];
    if (!onPayroll && delta > 0n && input.deductible && parseMoney(input.deductible, 'RON') > 0n)
      profit.push({
        account: accounts.expense,
        rule: 'provision_deductible',
        amount: input.deductible,
        clause: 'art.26(1)(b)',
        item: tag,
      });
    const effect: Effect = {
      schema: 'effect@1',
      date: input.date,
      journalClass: 'general',
      journalCode: 'DIVERSE',
      description: `${onPayroll ? 'Datorie față de personal' : 'Provizion'} ${memo} la ${input.date}`,
      lines,
      openItems: [],
      taxEntries: [],
      schedules: [],
      explanation: {
        summary: `${input.reference}: de la ${lei(existing)} la ${lei(target)} lei (${delta > 0n ? 'majorare' : 'diminuare'} ${lei(abs(delta))} lei) pe ${account}.`,
        details: {
          kind: input.kind,
          reference: input.reference,
          account,
          measured: onPayroll,
          existing: lei(existing),
          target: lei(target),
          profit: profit as unknown as JsonValue,
          clauses: onPayroll
            ? ['OMFP1802/2014:pct.335,338']
            : ['OMFP1802/2014:pct.369-377', 'OMFP1802/2014:pct.387-388'],
        },
      },
    };
    return { effect, issues };
  },
};

export const yearEndTreatments = [
  inventoryDifferences,
  receivableImpairment,
  assetImpairment,
  provisionRecord,
] as const;
