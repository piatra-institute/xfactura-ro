import type { D406Filed } from 'xfactura-core/ro/saft/read';
import { add, amount, delta } from './decimal';
import { difference, fail, order, type AccountMapping, type Difference } from './differences';
import {
  filedBalance,
  sourceAccounts,
  sourcePeriods,
  reportingPeriod,
  type BalancePair,
  type Period,
} from './filed';
import { checkSourceChain } from './source-chain';

export type BalanceValues = {
  opening: BalancePair;
  debitTurnover: string | null;
  creditTurnover: string | null;
  closing: BalancePair;
};
export type EngineBalancePeriod = Period & { rows: { account: string; values: BalanceValues }[] };
export type BalanceRow = {
  period: string;
  account: string;
  source: BalanceValues | null;
  engine: BalanceValues | null;
};
const zero = (): BalanceValues => ({
  opening: { debit: '0', credit: '0' },
  debitTurnover: '0',
  creditTurnover: '0',
  closing: { debit: '0', credit: '0' },
});

const fields = [
  'opening.debit',
  'opening.credit',
  'debitTurnover',
  'creditTurnover',
  'closing.debit',
  'closing.credit',
] as const;
type Field = (typeof fields)[number];
function fieldValue(row: BalanceValues, field: Field): string | null {
  switch (field) {
    case 'opening.debit':
      return row.opening.debit;
    case 'opening.credit':
      return row.opening.credit;
    case 'closing.debit':
      return row.closing.debit;
    case 'closing.credit':
      return row.closing.credit;
    default:
      return row[field];
  }
}
function merge(target: BalanceValues, row: BalanceValues) {
  for (const side of ['debit', 'credit'] as const) {
    target.opening[side] = add(target.opening[side], row.opening[side]);
    target.closing[side] = add(target.closing[side], row.closing[side]);
  }
  target.debitTurnover = add(target.debitTurnover, row.debitTurnover);
  target.creditTurnover = add(target.creditTurnover, row.creditTurnover);
}

/** Several source analytics may map to one engine account, whose balance is a net side. */
function netBalance(pair: BalancePair): BalancePair {
  if (pair.debit === null || pair.credit === null) return { debit: null, credit: null };
  const net = delta(pair.debit, pair.credit);
  return net.startsWith('-') ? { debit: '0', credit: net.slice(1) } : { debit: net, credit: '0' };
}

export function compareBalances(
  source: readonly D406Filed[],
  engine: readonly EngineBalancePeriod[],
  mapping: AccountMapping,
) {
  const periods = sourcePeriods(source);
  const chain = checkSourceChain(source);
  const differences: Difference[] = [];
  const rows: BalanceRow[] = [];
  const right = new Map<string, EngineBalancePeriod>();
  for (const period of engine) {
    if (
      period.period !== reportingPeriod(period.from, period.to).period ||
      right.has(period.period)
    )
      fail(
        'COMPARISON_PERIOD_DUPLICATE',
        'Intervalele balanței motorului nu au identități unice și valide.',
      );
    right.set(period.period, period);
  }
  const left = new Map(periods.map((period) => [period.period, period]));
  for (const period of [...new Set([...left.keys(), ...right.keys()])].sort(order)) {
    const a = left.get(period);
    const b = right.get(period);
    if (!a || !b) {
      differences.push(
        difference({
          kind: a ? 'balance-period-only-source' : 'balance-period-only-engine',
          period,
          locator: {},
          source: a ? period : null,
          engine: b ? period : null,
        }),
      );
      continue;
    }
    const sourceRows = new Map<string, BalanceValues>();
    if (a.filed.header.defaultCurrency !== 'RON')
      fail('COMPARISON_CURRENCY', 'Balanța sursă necesită sume declarate în RON.');
    for (const [id, account] of sourceAccounts(a.filed))
      sourceRows.set(id, {
        ...zero(),
        opening: filedBalance(account, 'opening'),
        closing: filedBalance(account, 'closing'),
      });
    for (const journal of a.filed.generalLedgerEntries.journals) {
      for (const transaction of journal.transactions) {
        for (const line of transaction.lines) {
          if (!line.account) fail('COMPARISON_LINE_ACCOUNT', 'O linie sursă nu are cont.');
          let row = sourceRows.get(line.account);
          if (!row) {
            row = {
              ...zero(),
              opening: { debit: null, credit: null },
              closing: { debit: null, credit: null },
            };
            sourceRows.set(line.account, row);
          }
          if (!line.side) {
            row.debitTurnover = null;
            row.creditTurnover = null;
          } else {
            const field = line.side === 'debit' ? 'debitTurnover' : 'creditTurnover';
            row[field] = add(row[field], amount(line.amount?.amount));
          }
        }
      }
    }
    const mapped = new Map<string, BalanceValues>();
    for (const [sourceAccount, row] of sourceRows) {
      const account = mapping(sourceAccount);
      if (!account) {
        differences.push(
          difference({
            kind: 'mapping-account',
            period,
            locator: { sourceAccount },
            accounts: [sourceAccount],
            source: row,
            engine: null,
          }),
        );
        continue;
      }
      const target = mapped.get(account) ?? zero();
      merge(target, row);
      mapped.set(account, target);
    }
    for (const row of mapped.values()) {
      row.opening = netBalance(row.opening);
      row.closing = netBalance(row.closing);
    }
    const engineRows = new Map<string, BalanceValues>();
    for (const { account, values } of b.rows) {
      if (engineRows.has(account))
        fail('COMPARISON_ACCOUNT_DUPLICATE', 'Un cont din balanța motorului este duplicat.');
      engineRows.set(account, {
        opening: { debit: amount(values.opening.debit), credit: amount(values.opening.credit) },
        closing: { debit: amount(values.closing.debit), credit: amount(values.closing.credit) },
        debitTurnover: amount(values.debitTurnover),
        creditTurnover: amount(values.creditTurnover),
      });
    }
    for (const account of [...new Set([...mapped.keys(), ...engineRows.keys()])].sort(order)) {
      const s = mapped.get(account) ?? null;
      const e = engineRows.get(account) ?? null;
      rows.push({ period, account, source: s, engine: e });
      if (!s || !e) {
        differences.push(
          difference({
            kind: s ? 'balance-only-source' : 'balance-only-engine',
            period,
            locator: { account },
            accounts: [account],
            source: s,
            engine: e,
          }),
        );
        continue;
      }
      for (const field of fields) {
        const source = fieldValue(s, field);
        const engine = fieldValue(e, field);
        if (source !== null && engine !== null && source === engine) continue;
        differences.push(
          difference({
            kind: 'balance-field',
            period,
            locator: { account, field },
            accounts: [account],
            source,
            engine,
            ...(source !== null && engine !== null ? { delta: delta(engine, source) } : {}),
          }),
        );
      }
    }
  }
  return { rows, differences: [...differences, ...chain.findings], chain: chain.counts };
}
