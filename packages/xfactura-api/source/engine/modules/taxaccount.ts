import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requireCondition } from 'xfactura-core/errors';
import { hashOf } from 'xfactura-core/hash';
import type { JsonValue, OpenItemState, ReadSetEntry } from 'xfactura-core/kernel';
import { formatMoney } from 'xfactura-core/money';
import type { RuleContext } from 'xfactura-core/rules';
import { RuleGapError } from 'xfactura-core/rules';
import {
  obligationOf,
  reconcileStatement,
  taxDocumentKinds,
  taxTypes,
  undistributedTag,
  type BookPosition,
  type ObligationCatalogue,
  type StatementObligation,
  type TaxAccounts,
  type TaxStatementDocument,
} from 'xfactura-core/ro/taxaccount';
import { isLocalDate, type LocalDate } from 'xfactura-core/time';
import {
  amountLabel,
  causeFromQuestion,
  dateLabel,
  idLabel,
  periodLabel,
  textLabel,
  treatmentName,
} from '../kernel/work-names';
import type { Transaction } from '../db/database';
import {
  artifactEvents,
  artifacts,
  documentLinks,
  documents,
  entries,
  lines,
  openItems,
  parties,
  proposals,
} from '../db/schema';
import type { Actor, Commands } from '../kernel/commands';
import type { CloseCheck } from '../kernel/periods';
import type { TaxAccountWorkItem, WorkStep } from '../kernel/work';
import { standing } from './questions';

/*
 * The tax account (T2, core ro/taxaccount): what the books owe the state and are owed by it, per
 * obligation and period, on any day; ANAF's statement of the taxpayer's account compared with
 * them; and what the worklist and the month close show of it.
 */

const day = z.string().refine((value): boolean => isLocalDate(value), 'Dată invalidă.');
export const reconcileInput = z
  .object({
    /** The statement (`tax.statement`); the latest recorded one when not given. */
    documentId: z.uuid().optional(),
    /** The tax authority; every public institution holding tax items when not given. */
    authorityId: z.uuid().optional(),
  })
  .strict();
export const positionInput = z
  .object({
    authorityId: z.uuid().optional(),
    /** The day the position is at; today when not given. */
    date: day.optional(),
  })
  .strict();

const lei = (bani: bigint) => formatMoney(bani, 'RON');

interface HeldItem extends OpenItemState {
  /** The posted lines on or before the day asked. */
  asOf: bigint;
}

/** Every tax item of the authorities (public institutions), with its balance on a day and
 * what opened it. */
async function heldItems(
  tx: Transaction,
  companyId: string,
  asOf: LocalDate,
  authorityId?: string,
): Promise<HeldItem[]> {
  const rows = await tx
    .select({
      item: openItems,
      treatmentId: proposals.treatmentId,
      subject: proposals.subjectKey,
      openedOn: entries.date,
      tag: sql<string | null>`(select l.item from ${lines} l
        where l.company_id = ${openItems.companyId} and l.entry_id = ${openItems.originEntryId}
          and l.open_item_id = ${openItems.id} order by l.line_no limit 1)`,
      balance: sql<bigint>`coalesce((select sum(case b.side when 'D' then 1 else -1 end * b.bani)
        from ${lines} b join ${entries} be on be.company_id = b.company_id and be.id = b.entry_id
        where b.company_id = ${openItems.companyId} and b.open_item_id = ${openItems.id}
          and be.date <= ${asOf}), 0)`.mapWith(BigInt),
      current: sql<bigint>`coalesce((select sum(case c.side when 'D' then 1 else -1 end * c.bani)
        from ${lines} c where c.company_id = ${openItems.companyId}
          and c.open_item_id = ${openItems.id}), 0)`.mapWith(BigInt),
      movements:
        sql<number>`(select count(*) from ${lines} m where m.company_id = ${openItems.companyId}
        and m.open_item_id = ${openItems.id})`.mapWith(Number),
    })
    .from(openItems)
    .innerJoin(
      parties,
      and(eq(parties.companyId, openItems.companyId), eq(parties.id, openItems.partyId)),
    )
    .innerJoin(
      entries,
      and(eq(entries.companyId, openItems.companyId), eq(entries.id, openItems.originEntryId)),
    )
    .innerJoin(
      proposals,
      and(eq(proposals.companyId, entries.companyId), eq(proposals.id, entries.proposalId)),
    )
    .where(
      and(
        eq(openItems.companyId, companyId),
        eq(parties.kind, 'ro_public_institution'),
        inArray(openItems.kind, ['tax.payable', 'tax.receivable']),
        sql`${entries.date} <= ${asOf}`,
        ...(authorityId ? [eq(openItems.partyId, authorityId)] : []),
      ),
    )
    .orderBy(asc(openItems.id));
  return rows.map((row) => ({
    id: row.item.id,
    kind: row.item.kind as OpenItemState['kind'],
    controlAccount: row.item.controlAccount,
    partyId: row.item.partyId,
    currency: row.item.currency,
    normalSide: row.item.normalSide,
    mayReverse: row.item.mayReverse,
    // Classified on the balance of the day asked.
    balanceBani: row.balance,
    balanceMinor: row.balance,
    documentId: row.item.documentId,
    dueDate: row.item.dueDate as LocalDate | null,
    originEntryId: row.item.originEntryId,
    movements: row.movements,
    origin: {
      treatmentId: row.treatmentId,
      subject: row.subject,
      date: row.openedOn as LocalDate,
      tag: row.tag,
    },
    asOf: row.balance,
  }));
}

function taxRules(rules: RuleContext, date: LocalDate) {
  return {
    catalogue: rules.param<ObligationCatalogue>('ro.taxaccount.obligations', 'payment_date', date),
    accounts: rules.param<TaxAccounts>(
      'ro.taxaccount.accounts',
      'accounting_transaction_date',
      date,
    ),
  };
}

/** What the books hold for each obligation, kind and period on a day: positive owed by the
 * company, negative owed to it. */
export function positionsOf(
  items: readonly HeldItem[],
  rules: RuleContext,
  date: LocalDate,
): BookPosition[] {
  const { catalogue, accounts } = taxRules(rules, date);
  const positions = new Map<string, BookPosition>();
  for (const item of items) {
    if (item.asOf === 0n) continue;
    const account = item.controlAccount.split('.')[0]!;
    let obligation: StatementObligation;
    let kind: 'principal' | 'accessory' = 'principal';
    let period: string | null;
    if (item.kind === 'tax.receivable') {
      obligation = accounts.refundable.includes(account) ? 'vat_refund' : 'undistributed';
      period =
        obligation === 'vat_refund' && item.origin?.treatmentId === 'vat.settle'
          ? (item.origin.subject.split(':')[1] ?? null)
          : null;
    } else {
      const known = obligationOf(item, catalogue, accounts, rules);
      obligation =
        known.type === 'fine'
          ? 'fine'
          : (taxTypes as readonly string[]).includes(known.type)
            ? (known.type as StatementObligation)
            : 'other';
      kind = known.category === 'accessory' ? 'accessory' : 'principal';
      period = known.period;
    }
    const key = `${obligation}|${kind}|${period ?? ''}`;
    const position = positions.get(key) ?? { obligation, kind, period, items: [] };
    // A payable's balance is credit: owed by the company.
    position.items.push({ openItem: item.id, account, period, balance: -item.asOf });
    positions.set(key, position);
  }
  return [...positions.values()];
}

/** The latest statement of the account recorded, not superseded. */
async function latestStatement(tx: Transaction, companyId: string, documentId?: string) {
  const rows = await tx
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.companyId, companyId),
        eq(documents.kind, taxDocumentKinds.statement),
        ...(documentId ? [eq(documents.id, documentId)] : []),
        sql`not exists (select 1 from ${documentLinks} s where s.company_id = ${documents.companyId}
          and s.to_id = ${documents.id} and s.kind = 'supersedes')`,
      ),
    )
    .orderBy(desc(documents.docDate), desc(documents.createdAt))
    .limit(1);
  return rows[0];
}

/** The statement against the books on its day. */
export async function reconciliation(
  tx: Transaction,
  companyId: string,
  rules: RuleContext,
  input: z.infer<typeof reconcileInput> = {},
) {
  const document = await latestStatement(tx, companyId, input.documentId);
  if (!document) return null;
  const statement = JSON.parse(document.body) as TaxStatementDocument;
  const asOf = statement.asOf as LocalDate;
  const items = await heldItems(tx, companyId, asOf, input.authorityId);
  const rows = reconcileStatement(
    statement,
    positionsOf(items, rules, asOf),
    taxRules(rules, asOf).catalogue,
  );
  return { document, statement, asOf, rows };
}

/** The tax account's reads: the statement against the books, and the position on a day. */
export class TaxAccount {
  constructor(
    private readonly commands: Commands,
    private readonly ruleContext: (tx: Transaction, companyId: string) => Promise<RuleContext>,
    private readonly clock: () => number = Date.now,
  ) {}

  reconcile(actor: Actor, input: z.infer<typeof reconcileInput>) {
    return this.commands.read(actor, 'taxaccount.reconcile', async (tx) => {
      const result = await reconciliation(
        tx,
        actor.companyId,
        await this.ruleContext(tx, actor.companyId),
        input,
      );
      requireCondition(
        result,
        'NOT_FOUND',
        'Nu este înregistrată nicio fișă pe plătitor (documents.record, tipul tax.statement).',
        404,
      );
      const differing = result.rows.filter((row) => !row.matched);
      return {
        documentId: result.document.id,
        asOf: result.asOf,
        source: result.statement.source,
        matched: differing.length === 0,
        differences: differing.length,
        items: result.rows,
        next: null,
      };
    });
  }

  position(actor: Actor, input: z.infer<typeof positionInput>) {
    return this.commands.read(actor, 'taxaccount.position', async (tx) => {
      const date = (input.date ?? new Date(this.clock()).toISOString().slice(0, 10)) as LocalDate;
      const rules = await this.ruleContext(tx, actor.companyId);
      const rows = await taxPosition(tx, actor.companyId, date, rules, input.authorityId);
      return {
        date,
        items: rows.map(({ bani, ...row }) => ({ ...row, balance: lei(bani) })),
        next: null,
        clauses: positionClauses,
      };
    });
  }
}

/** The clauses `taxaccount.position` reads the obligations by. */
export const positionClauses = [
  'L207/2015:art.163(2)-(5)',
  'OPANAF551/2021:anexa',
  'L207/2015:art.165(1),(3)',
];

/**
 * What the company owes the state and is owed by it on a day, per open item: an obligation's
 * type, period, budget, category and due date by the rules (`obligationOf`), or a claim (a
 * refund, a payment not yet distributed); `bani` positive owed by the company to the state on an
 * obligation, by the state on a claim. Refused with the rule gap when a rule it reads is missing.
 */
export async function taxPosition(
  tx: Transaction,
  companyId: string,
  date: LocalDate,
  rules: RuleContext,
  authorityId?: string,
) {
  const items = await heldItems(tx, companyId, date, authorityId);
  const { catalogue, accounts } = taxRules(rules, date);
  return items
    .filter((item) => item.asOf !== 0n)
    .map((item) => {
      if (item.kind === 'tax.receivable')
        return {
          openItem: item.id,
          authorityId: item.partyId,
          account: item.controlAccount,
          claim: true,
          type: item.origin?.tag === undistributedTag ? 'undistributed' : 'refundable',
          period: null,
          budget: null,
          category: null,
          due: null,
          singleAccount: false,
          designatable: false,
          bani: item.asOf,
        };
      const obligation = obligationOf(item, catalogue, accounts, rules);
      return {
        openItem: item.id,
        authorityId: item.partyId,
        account: item.controlAccount,
        claim: false,
        type: obligation.type,
        period: obligation.period,
        budget: obligation.budget,
        category: obligation.category,
        due: obligation.due,
        singleAccount: !obligation.separate,
        designatable: obligation.designatable,
        bani: -item.asOf,
      };
    });
}

const agent = (operation: string, inputHint: WorkStep['inputHint'] = {}): WorkStep => ({
  operation,
  by: 'agent',
  inputHint,
});
const human = (operation: string, inputHint: WorkStep['inputHint'] = {}): WorkStep => ({
  operation,
  by: 'human',
  inputHint,
});

/**
 * What the tax account waits on: the latest statement of the account differing from the books
 * (one item, every differing obligation explained); payments to the single account not yet
 * distributed while obligations of the authority are due; a filed D100 whose inputs changed
 * since, a D710 to file outside the engine and record.
 */
export async function taxAccountWork(
  tx: Transaction,
  companyId: string,
  today: LocalDate,
  rules: RuleContext,
  d100Inputs: (tx: Transaction, companyId: string, period: string) => Promise<ReadSetEntry[]>,
): Promise<TaxAccountWorkItem[]> {
  const work: TaxAccountWorkItem[] = [];
  try {
    const result = await reconciliation(tx, companyId, rules);
    if (result) {
      const differing = result.rows.filter((row) => !row.matched);
      if (differing.length)
        work.push({
          kind: 'taxaccount.differs',
          subject: { kind: 'document', id: result.document.id },
          severity: 'warn',
          period: result.asOf.slice(0, 7),
          // Each obligation that differs, with both amounts, is in `details.differences`.
          message: `Fișa pe plătitor la ${result.asOf} diferă de registre la ${differing.length} ${differing.length === 1 ? 'obligație' : 'obligații'}.`,
          details: {
            asOf: result.asOf,
            differences: differing.map((row) => ({
              obligation: row.obligation,
              kind: row.kind,
              period: row.period,
              statement: row.statement,
              books: row.books,
              difference: row.difference,
              explanations: row.explanations.map((item) => item.code),
            })) as JsonValue,
          },
          labels: {
            asOf: dateLabel('Data situației'),
            differences: textLabel('Diferențe'),
          },
          next: [
            agent('taxaccount.reconcile', { documentId: result.document.id }),
            agent('documents.record', { kind: 'tax.decision' }),
            human('work.dispose'),
          ],
        });
    }
    // Payments not yet distributed while obligations are due.
    const items = await heldItems(tx, companyId, today);
    const { catalogue, accounts } = taxRules(rules, today);
    const byAuthority = new Map<string, HeldItem[]>();
    for (const item of items)
      byAuthority.set(item.partyId, [...(byAuthority.get(item.partyId) ?? []), item]);
    for (const [authorityId, held] of byAuthority) {
      const undistributed = held
        .filter((item) => item.kind === 'tax.receivable' && item.origin?.tag === undistributedTag)
        .reduce((sum, item) => sum + item.asOf, 0n);
      if (undistributed <= 0n) continue;
      const due = held
        .filter((item) => item.kind === 'tax.payable' && item.asOf < 0n)
        .map((item) => obligationOf(item, catalogue, accounts, rules))
        .filter((item) => !item.separate && item.due !== null && item.due <= today);
      if (!due.length) continue;
      work.push({
        kind: 'taxaccount.undistributed',
        subject: { kind: 'party', id: authorityId },
        severity: 'warn',
        period: today.slice(0, 7),
        message: `Plăți în contul unic de ${lei(undistributed)} lei sunt încă nedistribuite, iar ${due.length} ${due.length === 1 ? 'obligație este scadentă' : 'obligații sunt scadente'}: distribuiți-le în ordinea legală (${treatmentName('tax.distribute').toLowerCase()}).`,
        details: {
          authorityId,
          undistributed: lei(undistributed),
          due: due.map((item) => item.id),
        },
        labels: {
          authorityId: idLabel('Autoritate fiscală', 'party'),
          undistributed: amountLabel('Sumă nedistribuită', { currency: 'RON' }),
          due: textLabel('Obligații scadente'),
        },
        next: [
          agent('proposals.propose', {
            treatment: 'tax.distribute',
            input: { authorityId, date: today },
          }),
        ],
      });
    }
  } catch (error) {
    if (!(error instanceof RuleGapError)) throw error;
  }
  // A filed D100 whose books changed since: its obligations may need a D710.
  const filed = await tx
    .select({ id: artifacts.id, period: artifacts.period, inputHash: artifacts.inputHash })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.companyId, companyId),
        eq(artifacts.kind, 'D100'),
        sql`exists (select 1 from ${artifactEvents} e where e.company_id = ${artifacts.companyId}
          and e.artifact_id = ${artifacts.id} and e.state in ('submitted', 'accepted'))`,
        sql`not exists (select 1 from ${artifactEvents} e where e.company_id = ${artifacts.companyId}
          and e.artifact_id = ${artifacts.id} and e.state = 'superseded')`,
      ),
    );
  for (const row of filed) {
    if (hashOf(await d100Inputs(tx, companyId, row.period)) === row.inputHash) continue;
    const request = {
      kind: 'obligation.filed' as const,
      subject: { kind: 'obligation', id: `D710/${row.period}` },
      params: { kind: 'D710', period: row.period },
    };
    if ((await standing(tx, companyId, request)).answered) continue;
    const message = `Registrele s-au schimbat după depunerea declarației 100 pentru ${row.period}: dacă obligațiile declarate s-au schimbat, corectați-le prin declarația 710, depusă în afara aplicației, și înregistrați-o.`;
    work.push({
      kind: 'taxaccount.correction',
      subject: { kind: 'declaration', id: row.id },
      severity: 'warn',
      period: row.period,
      message,
      causes: [causeFromQuestion(request, message)],
      details: { period: row.period, artifactId: row.id },
      labels: {
        period: periodLabel('Perioadă'),
        artifactId: idLabel('Declarație', 'artifact'),
      },
      next: [agent('questions.ask', request), human('questions.answer')],
    });
  }
  return work;
}

/**
 * The month close: the statement of the account of the month (the latest one dated in it)
 * differing from the books, beyond rounding; and payments not yet distributed at the month's end
 * while obligations were due. Both are warnings a person may dispose of.
 */
export function taxAccountChecks(
  rules: (tx: Transaction, companyId: string) => Promise<RuleContext>,
): CloseCheck[] {
  return [
    {
      id: 'taxaccount.statement',
      async run(tx, companyId, month) {
        const [document] = await tx
          .select({ id: documents.id })
          .from(documents)
          .where(
            and(
              eq(documents.companyId, companyId),
              eq(documents.kind, taxDocumentKinds.statement),
              sql`substr(${documents.docDate}, 1, 7) = ${month}`,
              sql`not exists (select 1 from ${documentLinks} s where s.company_id = ${documents.companyId}
                and s.to_id = ${documents.id} and s.kind = 'supersedes')`,
            ),
          )
          .orderBy(desc(documents.docDate), desc(documents.createdAt))
          .limit(1);
        if (!document) return [];
        let result;
        try {
          result = await reconciliation(tx, companyId, await rules(tx, companyId), {
            documentId: document.id,
          });
        } catch (error) {
          if (error instanceof RuleGapError) return [];
          throw error;
        }
        const differing = result?.rows.filter((row) => !row.matched) ?? [];
        return differing.length
          ? [
              {
                code: 'TAX_STATEMENT_DIFFERS',
                severity: 'warn' as const,
                message: `Fișa pe plătitor la ${result!.asOf} diferă de registre la ${differing.length} obligații (taxaccount.reconcile).`,
                count: differing.length,
                items: [document.id],
              },
            ]
          : [];
      },
    },
  ];
}
