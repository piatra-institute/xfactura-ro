import { and, desc, eq, gt, lt, lte, max, notExists, sql } from 'drizzle-orm';
import { z } from 'zod';
import { canonical, hashOf, sha256Hex } from 'xfactura-core/hash';
import type { JsonValue } from 'xfactura-core/kernel';
import { formatMoney } from 'xfactura-core/money';
import type { Transaction } from '../db/database';
import {
  entries,
  lines,
  periodBalances,
  periodEvents,
  proposalVersions,
  withdrawals,
} from '../db/schema';
import type { ActionHandler } from './actions';
import type { Actor } from './commands';

export type Finding = {
  code: string;
  severity: 'block' | 'warn';
  message: string;
  count?: number;
  items?: string[];
};

/** A check a month must pass before it closes. Modules register their own (bank coverage, …). */
export interface CloseCheck {
  id: string;
  run(tx: Transaction, companyId: string, month: string): Promise<Finding[]>;
}

export const monthInput = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).strict();
const sign = sql`case ${lines.side} when 'D' then 1 else -1 end`;

async function latestEvent(tx: Transaction, companyId: string, month: string) {
  const [event] = await tx
    .select()
    .from(periodEvents)
    .where(and(eq(periodEvents.companyId, companyId), eq(periodEvents.month, month)))
    .orderBy(desc(periodEvents.seq))
    .limit(1);
  return event;
}

/** Months with entries before `month` whose latest event is not a close. */
async function openMonths(
  tx: Transaction,
  companyId: string,
  where: 'before' | 'after',
  month: string,
) {
  const months = await tx
    .selectDistinct({ period: entries.period })
    .from(entries)
    .where(
      and(
        eq(entries.companyId, companyId),
        where === 'before' ? lt(entries.period, month) : gt(entries.period, month),
      ),
    );
  const result: { month: string; closed: boolean }[] = [];
  for (const { period } of months.sort((a, b) => (a.period < b.period ? -1 : 1)))
    result.push({
      month: period,
      closed: (await latestEvent(tx, companyId, period))?.kind === 'close',
    });
  return result;
}

const kernelChecks: CloseCheck[] = [
  {
    id: 'kernel.order',
    async run(tx, companyId, month) {
      const findings: Finding[] = [];
      if ((await latestEvent(tx, companyId, month))?.kind === 'close')
        findings.push({
          code: 'PERIOD_CLOSED',
          severity: 'block',
          message: 'Luna este deja închisă.',
        });
      const open = (await openMonths(tx, companyId, 'before', month)).filter(
        (item) => !item.closed,
      );
      if (open.length)
        findings.push({
          code: 'EARLIER_OPEN',
          severity: 'block',
          message: 'Închideți mai întâi lunile anterioare cu înregistrări.',
          count: open.length,
          items: open.map((item) => item.month),
        });
      return findings;
    },
  },
  {
    id: 'kernel.unposted',
    async run(tx, companyId, month) {
      // Latest versions dated in the month that are neither posted nor withdrawn.
      const latest = tx
        .select({
          proposalId: proposalVersions.proposalId,
          latest: max(proposalVersions.version).as('latest_version'),
        })
        .from(proposalVersions)
        .where(eq(proposalVersions.companyId, companyId))
        .groupBy(proposalVersions.proposalId)
        .as('latest');
      const rows = await tx
        .select({ proposalId: proposalVersions.proposalId })
        .from(proposalVersions)
        .innerJoin(
          latest,
          and(
            eq(latest.proposalId, proposalVersions.proposalId),
            eq(latest.latest, proposalVersions.version),
          ),
        )
        .where(
          and(
            eq(proposalVersions.companyId, companyId),
            sql`substr(${proposalVersions.entryDate}, 1, 7) = ${month}`,
            notExists(
              tx
                .select({ id: entries.id })
                .from(entries)
                .where(
                  and(
                    eq(entries.companyId, companyId),
                    eq(entries.proposalId, proposalVersions.proposalId),
                  ),
                ),
            ),
            notExists(
              tx
                .select({ id: withdrawals.proposalId })
                .from(withdrawals)
                .where(
                  and(
                    eq(withdrawals.companyId, companyId),
                    eq(withdrawals.proposalId, proposalVersions.proposalId),
                  ),
                ),
            ),
          ),
        )
        .orderBy(proposalVersions.proposalId);
      return rows.length
        ? [
            {
              code: 'UNPOSTED',
              severity: 'block',
              message: 'Există propuneri din această lună necontabilizate sau neretrase.',
              count: rows.length,
              items: rows.slice(0, 20).map((row) => row.proposalId),
            },
          ]
        : [];
    },
  },
];

/** Closing balances after `month`: the previous snapshot plus the turnover since it. */
async function closingBalances(tx: Transaction, companyId: string, month: string) {
  const [previous] = await tx
    .select({ month: periodEvents.month, seq: periodEvents.seq })
    .from(periodEvents)
    .where(
      and(
        eq(periodEvents.companyId, companyId),
        lt(periodEvents.month, month),
        eq(periodEvents.kind, 'close'),
      ),
    )
    .orderBy(desc(periodEvents.month), desc(periodEvents.seq))
    .limit(1);
  const balances = new Map<
    string,
    {
      account: string;
      currency: string;
      debit: bigint;
      credit: bigint;
      bani: bigint;
      minor: bigint;
    }
  >();
  if (previous)
    for (const row of await tx
      .select()
      .from(periodBalances)
      .where(
        and(
          eq(periodBalances.companyId, companyId),
          eq(periodBalances.month, previous.month),
          eq(periodBalances.closeSeq, previous.seq),
        ),
      ))
      balances.set(`${row.account}/${row.currency}`, {
        account: row.account,
        currency: row.currency,
        debit: 0n,
        credit: 0n,
        bani: row.closingBani,
        minor: row.closingMinor,
      });
  const turnover = await tx
    .select({
      account: lines.account,
      currency: sql<string>`coalesce(${lines.currency}, 'RON')`,
      monthDebit:
        sql<bigint>`sum(case when ${entries.period} = ${month} and ${lines.side} = 'D' then ${lines.bani} else 0 end)`.mapWith(
          BigInt,
        ),
      monthCredit:
        sql<bigint>`sum(case when ${entries.period} = ${month} and ${lines.side} = 'C' then ${lines.bani} else 0 end)`.mapWith(
          BigInt,
        ),
      bani: sql<bigint>`sum(${sign} * ${lines.bani})`.mapWith(BigInt),
      minor: sql<bigint>`sum(${sign} * coalesce(${lines.currencyMinor}, ${lines.bani}))`.mapWith(
        BigInt,
      ),
    })
    .from(lines)
    .innerJoin(entries, and(eq(entries.companyId, lines.companyId), eq(entries.id, lines.entryId)))
    .where(
      and(
        eq(entries.companyId, companyId),
        lte(entries.period, month),
        previous ? gt(entries.period, previous.month) : undefined,
      ),
    )
    .groupBy(lines.account, sql`coalesce(${lines.currency}, 'RON')`);
  for (const row of turnover) {
    const id = `${row.account}/${row.currency}`;
    const balance = balances.get(id) ?? {
      account: row.account,
      currency: row.currency,
      debit: 0n,
      credit: 0n,
      bani: 0n,
      minor: 0n,
    };
    balance.debit = row.monthDebit;
    balance.credit = row.monthCredit;
    balance.bani += row.bani;
    balance.minor += row.minor;
    balances.set(id, balance);
  }
  return [...balances.values()].sort((a, b) =>
    a.account === b.account ? (a.currency < b.currency ? -1 : 1) : a.account < b.account ? -1 : 1,
  );
}

const ron = (bani: bigint) => formatMoney(bani, 'RON');

export function closeHandler(checks: CloseCheck[]): ActionHandler<z.infer<typeof monthInput>> {
  return {
    operation: 'periods.close',
    permission: 'write',
    input: monthInput,
    async preview(tx, companyId, { month }) {
      const findings = (
        await Promise.all(
          [...kernelChecks, ...checks].map((check) => check.run(tx, companyId, month)),
        )
      ).flat();
      const [watermark] = await tx
        .select({ seq: max(entries.seq) })
        .from(entries)
        .where(eq(entries.companyId, companyId));
      const balances = await closingBalances(tx, companyId, month);
      const preview = {
        month,
        watermark: watermark?.seq ?? 0,
        findings,
        balances: balances.map((row) => ({
          account: row.account,
          currency: row.currency,
          debit: ron(row.debit),
          credit: ron(row.credit),
          closing: ron(row.bani),
          ...(row.currency === 'RON'
            ? {}
            : { closingCurrency: formatMoney(row.minor, row.currency) }),
        })),
      };
      return { blocking: findings.some((finding) => finding.severity === 'block'), preview };
    },
    async execute(tx, actor, { month }, requestId, preview) {
      const balances = await closingBalances(tx, actor.companyId, month);
      const snapshotHash = hashOf(balances);
      const seq = ((await latestEvent(tx, actor.companyId, month))?.seq ?? 0) + 1;
      const watermarkSeq = (preview as { watermark: number }).watermark;
      const hash = await appendPeriodEvent(tx, actor, {
        month,
        seq,
        kind: 'close',
        requestId,
        watermarkSeq,
        snapshotHash,
      });
      if (balances.length)
        await tx.insert(periodBalances).values(
          balances.map((row) => ({
            companyId: actor.companyId,
            month,
            closeSeq: seq,
            account: row.account,
            currency: row.currency,
            debitTurnover: row.debit,
            creditTurnover: row.credit,
            closingBani: row.bani,
            closingMinor: row.minor,
          })),
        );
      return { month, seq, snapshotHash, hash };
    },
  };
}

export const reopenInput = monthInput
  .extend({ reason: z.string().trim().min(10).max(1000) })
  .strict();

export const reopenHandler: ActionHandler<z.infer<typeof reopenInput>> = {
  operation: 'periods.reopen',
  permission: 'review',
  input: reopenInput,
  async preview(tx, companyId, { month, reason }) {
    const findings: Finding[] = [];
    if ((await latestEvent(tx, companyId, month))?.kind !== 'close')
      findings.push({ code: 'PERIOD_OPEN', severity: 'block', message: 'Luna nu este închisă.' });
    // A month of a financial year a reviewed year close locked reopens only with its year
    // (`years.reopen`; the database refuses it too, `inv:closed_year_month`).
    const [locked] = await tx.all<{ id: string }>(sql`select y.id from acc_fiscal_years y
      where y.company_id = ${companyId} and y.kind = 'financial'
        and ${`${month}-01`} between y.date_from and y.date_to
        and (select r.operation from acc_action_requests r
          join acc_action_executions x on x.company_id = r.company_id and x.request_id = r.id
          where r.company_id = y.company_id and r.operation in ('years.close', 'years.reopen')
            and json_extract(r.input_json, '$.financialYearId') = y.id
          order by x.rowid desc limit 1) = 'years.close'`);
    if (locked)
      findings.push({
        code: 'YEAR_CLOSED',
        severity: 'block',
        message: 'Exercițiul lunii este închis: redeschideți întâi exercițiul (years.reopen).',
      });
    const later = (await openMonths(tx, companyId, 'after', month)).filter((item) => item.closed);
    if (later.length)
      findings.push({
        code: 'LATER_CLOSED',
        severity: 'block',
        message: 'Redeschideți mai întâi lunile ulterioare închise.',
        count: later.length,
        items: later.map((item) => item.month),
      });
    const [watermark] = await tx
      .select({ seq: max(entries.seq) })
      .from(entries)
      .where(eq(entries.companyId, companyId));
    return {
      blocking: findings.length > 0,
      preview: { month, reason, watermark: watermark?.seq ?? 0, findings },
    };
  },
  async execute(tx, actor, { month }, requestId, preview) {
    const seq = ((await latestEvent(tx, actor.companyId, month))?.seq ?? 0) + 1;
    const watermarkSeq = (preview as { watermark: number }).watermark;
    const hash = await appendPeriodEvent(tx, actor, {
      month,
      seq,
      kind: 'reopen',
      requestId,
      watermarkSeq,
      snapshotHash: '',
    });
    return { month, seq, hash };
  },
};

async function appendPeriodEvent(
  tx: Transaction,
  actor: Actor,
  event: {
    month: string;
    seq: number;
    kind: 'close' | 'reopen';
    requestId: string;
    watermarkSeq: number;
    snapshotHash: string;
  },
) {
  const [previous] = await tx
    .select({ hash: periodEvents.hash })
    .from(periodEvents)
    .where(eq(periodEvents.companyId, actor.companyId))
    .orderBy(sql`rowid desc`)
    .limit(1);
  const prevHash = previous?.hash ?? '';
  const record: JsonValue = {
    month: event.month,
    seq: event.seq,
    kind: event.kind,
    watermark: event.watermarkSeq,
    snapshot: event.snapshotHash,
  };
  const hash = sha256Hex(`${prevHash}\n${canonical(record)}`);
  await tx.insert(periodEvents).values({
    companyId: actor.companyId,
    month: event.month,
    seq: event.seq,
    kind: event.kind,
    actionId: event.requestId,
    watermarkSeq: event.watermarkSeq,
    snapshotHash: event.snapshotHash,
    prevHash,
    hash,
    createdBy: actor.actorId,
  });
  return hash;
}

/** The latest state of each month that has events. */
export async function periodStates(tx: Transaction, companyId: string) {
  const rows = await tx
    .select({ month: periodEvents.month, kind: periodEvents.kind, seq: periodEvents.seq })
    .from(periodEvents)
    .where(eq(periodEvents.companyId, companyId))
    .orderBy(periodEvents.month, periodEvents.seq);
  const states = new Map<string, 'closed' | 'open'>();
  for (const row of rows) states.set(row.month, row.kind === 'close' ? 'closed' : 'open');
  return [...states].map(([month, state]) => ({ month, state }));
}
